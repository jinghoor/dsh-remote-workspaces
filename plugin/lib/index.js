/**
 * Remote DSH workspaces, natively.
 *
 * The local Host is the single seam: it merges a remote Host's sessions and
 * workspaces into its own list/stream responses and forwards session-scoped
 * RPCs back out. The shipped sidebar then renders remote workspaces as ordinary
 * groups — the only visual difference is the trailing marker in the title.
 */
import fs from 'node:fs'
import path from 'node:path'
import { RemoteHost } from './remote.mjs'
import { TunnelSupervisor, readRelayConfig, writeRelayConfig, relayRequest } from './tunnel.mjs'
import * as store from './config.mjs'

const name = 'remote-workspaces'
const inject = []

/** Workspace ids we synthesise carry the owning host, so routing never needs a lookup. */
// Single source of truth: the package manifest the loader actually installed.
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const REMOTE_PREFIX = 'remote:'
const MARKER = ' 🌐'

/**
 * Read intrinsic dimensions straight from the image header. A Host that does not
 * implement `uploadImageStream` answers with a plain file receipt, and the caller's
 * image draft rejects that shape — so the proxy fills the metadata it asked for.
 */
function imageSizeFromBytes(buffer) {
  if (buffer === undefined || buffer.length < 24) return undefined
  // PNG: IHDR carries width/height as two big-endian u32 after the signature.
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // GIF: logical screen descriptor, little-endian u16 pair.
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // WebP: VP8X/VP8L/VP8 chunk variants.
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('latin1')
    if (kind === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
    if (kind === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    return undefined
  }
  // JPEG: walk the segment chain until a Start-Of-Frame marker.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return undefined
}

/**
 * Remote failures that name a concrete cause the user can act on. Everything else is
 * surfaced verbatim, but these read as opaque codes in the UI otherwise.
 */
function explainRemoteError(error) {
  const message = String(error?.message ?? error)
  const preset = /Unknown agent preset:\s*(\S+)/.exec(message)
  if (preset !== null) {
    return Object.assign(
      new Error(`这条会话使用的 agent preset「${preset[1]}」在远端不存在，远端自己也打不开它；请新建一条会话`),
      { code: error?.code ?? 'session/preset-missing' },
    )
  }
  if (error?.code === 'session/writer-held' || /already owned by an active write handle/.test(message)) {
    return Object.assign(new Error('这条会话正在远端被占用（远端窗口里开着它），先在那边切走再试'), { code: error.code })
  }
  if (error?.code === 'session/agent-busy') {
    return Object.assign(new Error('远端这条会话正在跑，等它跑完再发'), { code: error.code })
  }
  return error
}
/** DSH caps uploads around 50MB; keep headroom and fail loudly past it. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
/** Used only when a Host will not report its own limits; matches shipped defaults. */
const DEFAULT_IMAGE_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 100 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}
const CACHE_MS = 15000

const SESSION_UNARY = ['page', 'events', 'projections', 'attachment', 'prompt', 'cancel', 'rename', 'fork', 'updateQueue', 'search']
const SESSION_STREAM = ['follow']
const HOST_STREAM = ['control']

function remoteWorkspaceId(hostId, workspaceId) {
  return `${REMOTE_PREFIX}${hostId}:${workspaceId}`
}

function parseRemoteWorkspaceId(value) {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_PREFIX)) return undefined
  const rest = value.slice(REMOTE_PREFIX.length)
  const at = rest.indexOf(':')
  if (at <= 0) return undefined
  return { hostId: rest.slice(0, at), workspaceId: rest.slice(at + 1) }
}

/** Session identity sits in a different wrapper for each endpoint family. */
function sessionIdOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const direct = value.sessionId ?? value.request?.sessionId ?? value.address?.sessionId ?? value.request?.address?.sessionId
  return typeof direct === 'string' ? direct : undefined
}

function authorized(req) {
  const cookie = req.headers.cookie ?? ''
  return /(?:^|;\s*)dsh-auth-[^=;]+=/.test(cookie)
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Route bodies run detached from the request callback, so an exception there becomes
 * an unhandled rejection — which takes the whole Host process down. Every async route
 * goes through this guard.
 */
function guard(res, label, run) {
  void (async () => {
    try {
      await run()
    } catch (error) {
      try {
        if (!res.headersSent) send(res, 500, { ok: false, error: `${label}: ${String(error?.message ?? error)}` })
        else res.end()
      } catch {
        // Response already gone; nothing left to report to.
      }
    }
  })()
}

async function readJson(req, limitBytes = 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Session events the browser feed understands; anything else is not re-emitted. */
const FORWARDED_EVENTS = new Set([
  'api-session/added',
  'api-session/removed',
  'api-session/status',
  'api-session/activity',
  'api-session/error',
])

/**
 * Collapse every layer this plugin installed before, regardless of which module
 * instance put it there: the wrappers record their own original, so re-applying
 * restores the real method first and never stacks (stacking multiplies per-frame
 * work and eventually starves the stream).
 */
/**
 * Reset a service method to its class implementation before wrapping. Old instances of
 * this plugin can leave own-property wrappers whose captured state is stale, and a chain
 * of them resolves ownership against an outdated map — which is how a remote upload ends
 * up served by the local store as `session/not-found`.
 */
function resetToPrototype(owner, method) {
  if (owner === undefined || owner === null) return undefined
  const fromPrototype = Object.getPrototypeOf(owner)?.[method]
  if (typeof fromPrototype === 'function') {
    owner[method] = fromPrototype
    return fromPrototype
  }
  return owner[method]
}

function unwrap(owner, method) {
  let current = owner?.[method]
  let depth = 0
  while (typeof current === 'function' && current.__remoteWorkspacesShim === true) {
    const original = current.__remoteWorkspacesShimOriginal
    // An older layer may carry the marker without recording its original; keep it as
    // the base instead of wiping the method (that would delete the Host's stream).
    if (typeof original !== 'function') break
    current = original
    depth += 1
  }
  if (depth > 0 && typeof current === 'function') {
    owner[method] = current
    ctxWarn(`unwrapped ${depth} stale layer(s) of ${method}`)
  }
  if (typeof owner?.[method] !== 'function') {
    // A previous reload may have wiped the own property. The real implementation is
    // still on the class prototype, so recover it rather than giving up on the method.
    const fromPrototype = Object.getPrototypeOf(owner ?? {})?.[method]
    if (typeof fromPrototype === 'function') {
      owner[method] = fromPrototype
      ctxWarn(`recovered ${method} from the prototype after a wiped own property`)
      return fromPrototype
    }
    ctxWarn(`${method} is missing before patching; leaving the Host as-is`)
    return undefined
  }
  return current
}

let ctxWarn = () => {}

/** A patched controller survives its plugin instance; a second load must retire the first. */
let previousDispose

function apply(ctx, rawConfig) {
  ctxWarn = (message) => ctx.logger?.info?.(`remote-workspaces: ${message}`)
  previousDispose?.()
  const seeded = store.normalize(rawConfig)
  const state = {
    controllers: {},
    restore: [],
    config: store.read() ?? seeded,
    hosts: [],
    sessionHost: new Map(),
    cache: new Map(),
    localWorkspaceIds: [],
    lastBaseline: undefined,
    order: [],
    subscribers: new Set(),
    imageLimits: new Map(),
    uploadStats: { ok: 0, failed: 0, local: 0 },
    clientProbe: [],
    titleRelays: [],
    tunnel: new TunnelSupervisor(),
    uploadLog: [],
    actionLog: [],
  }

  let suppressWatchUntil = 0

  const log = (message, error) =>
    ctx.logger?.warn?.(`remote-workspaces: ${message}${error === undefined ? '' : `: ${error?.message ?? error}`}`)

  const broadcast = (frame) => {
    for (const channel of state.subscribers) channel.push(frame, true)
  }

  function buildHosts() {
    state.hosts = state.config.hosts
      .filter((host) => typeof host.baseUrl === 'string' && host.baseUrl !== '')
      .map((host) => new RemoteHost(host, { timeoutMs: state.config.requestTimeoutMs }))
    state.cache.clear()
    state.sessionHost.clear()
  }

  const hostById = (id) => state.hosts.find((host) => host.id === id)

  const includeOf = (host) => {
    const list = state.config.include?.[host.id]
    // Absent → every workspace is visible; present but empty → none are.
    return Array.isArray(list) ? new Set(list) : undefined
  }

  /** Background refreshes are deduped so a burst of list calls pays one round trip. */
  const backgroundRefreshes = new Map()
  function refreshInBackground(host) {
    const running = backgroundRefreshes.get(host.id)
    if (running !== undefined) return running
    const task = refresh(host, true)
      .catch((error) => log(`background refresh for ${host.id} failed`, error))
      .finally(() => backgroundRefreshes.delete(host.id))
    backgroundRefreshes.set(host.id, task)
    return task
  }

  async function refresh(host, force = false) {
    const cached = state.cache.get(host.id)
    if (!force && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached
    const [list, baseline] = await Promise.all([host.call('session/list', { _request: {} }), host.workspaceBaseline()])
    const entry = {
      at: Date.now(),
      sessions: Array.isArray(list?.items) ? list.items : [],
      workspaces: Array.isArray(baseline?.items) ? baseline.items : [],
      // Archived Sessions still appear in `session/list`, but every turn inside one is
      // rejected as `blocked` — so they must never reach the sidebar.
      archived: new Set(Array.isArray(baseline?.archivedSessionIds) ? baseline.archivedSessionIds : []),
    }
    state.cache.set(host.id, entry)
    for (const row of entry.sessions) if (typeof row?.sessionId === 'string') state.sessionHost.set(row.sessionId, host.id)
    // A Session created on the other machine shows up in a workspace's sessionIds
    // before any list refresh, so ownership is learned here as well.
    for (const workspace of entry.workspaces) {
      for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
        if (typeof id === 'string') state.sessionHost.set(id, host.id)
      }
    }
    return entry
  }

  function remoteViews(host, entry) {
    const include = includeOf(host)
    return entry.workspaces
      .filter((workspace) => include === undefined || include.has(workspace.workspaceId))
      .map((workspace) => ({
        workspaceId: remoteWorkspaceId(host.id, workspace.workspaceId),
        path: workspace.path,
        title: `${workspace.title}${MARKER}`,
        sessionIds: Array.isArray(workspace.sessionIds)
          ? workspace.sessionIds.filter((id) => entry.archived.has(id) !== true)
          : workspace.sessionIds,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }))
  }

  async function allRemoteViews() {
    const views = []
    for (const host of state.hosts) {
      try {
        views.push(...remoteViews(host, await refresh(host)))
      } catch (error) {
        log(`workspace list from ${host.id} failed`, error)
      }
    }
    return views
  }

  /**
   * Ownership is learned from three event-driven places — list rows, workspace
   * baselines, and control projections — so a miss here is genuinely unknown.
   * The fallback refresh is single-flight and briefly negative-cached, because a
   * per-call list would stampede the tunnel for ids that will never appear.
   */
  let resolveInflight
  const missUntil = new Map()

  async function ownerOf(sessionId) {
    const known = state.sessionHost.get(sessionId ?? '')
    if (known !== undefined) return known
    const missed = missUntil.get(sessionId ?? '')
    if (missed !== undefined && Date.now() < missed) return undefined
    if (resolveInflight === undefined) {
      resolveInflight = (async () => {
        for (const host of state.hosts) {
          try {
            await refresh(host, true)
          } catch (error) {
            log(`session list from ${host.id} failed`, error)
          }
        }
      })().finally(() => {
        resolveInflight = undefined
      })
    }
    await resolveInflight
    const resolved = state.sessionHost.get(sessionId ?? '')
    if (resolved === undefined) missUntil.set(sessionId ?? '', Date.now() + 5000)
    return resolved
  }

  /**
   * Host-wide image limits. The composer reads them off the Session projection and
   * dereferences it, so a remote row that ships `null` here breaks pasting outright.
   */
  async function imageLimitsOf(host, entry) {
    const cached = state.imageLimits.get(host.id)
    if (cached !== undefined) return cached
    const sample = entry.sessions.find((row) => typeof row?.sessionId === 'string')
    if (sample === undefined) return undefined
    try {
      const projections = await host.call('session/projections', { request: { sessionId: sample.sessionId } })
      const limits = projections?.values?.imageLimits
      if (limits !== null && typeof limits === 'object') {
        state.imageLimits.set(host.id, limits)
        return limits
      }
    } catch (error) {
      state.lastError = { at: new Date().toISOString(), method: 'session/projections(imageLimits)', host: host.id, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) }
      log(`image limits from ${host.id} failed`, error)
    }
    return undefined
  }

  /**
   * Map one attachment request onto the other release's shape. Going up is trivial;
   * going down needs the logged image metadata, which the Session knows.
   */
  async function translateAttachment(host, request) {
    const sessionId = request?.sessionId
    if (typeof sessionId !== 'string') return undefined
    if (request?.attachment?.attachmentId !== undefined) {
      return { sessionId, attachmentId: request.attachment.attachmentId }
    }
    if (typeof request?.attachmentId !== 'string') return undefined
    try {
      const projections = await host.call('session/projections', { request: { sessionId } })
      const page = await host.call('session/events', {
        request: { address: { kind: 'session', sessionId }, throughSeq: projections?.asOfSeq ?? 0, maxMessages: 400 },
      })
      for (const record of page?.records ?? []) {
        for (const block of record?.event?.data?.content ?? []) {
          if (block?.type === 'image' && block.attachment?.attachmentId === request.attachmentId) {
            return { sessionId, attachment: block.attachment }
          }
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  async function remoteSessionRows() {
    const rows = []
    for (const host of state.hosts) {
      try {
        // Serve the cached page and refresh behind it: one tunnel round trip is ~0.7s
        // and the list sits on the path of every workspace switch.
        const cached = state.cache.get(host.id)
        const stale = cached === undefined || Date.now() - cached.at >= CACHE_MS
        if (stale) {
          if (cached === undefined) await refresh(host)
          else void refreshInBackground(host)
        }
        const entry = state.cache.get(host.id)
        if (entry === undefined) continue
        const limits = (await imageLimitsOf(host, entry)) ?? DEFAULT_IMAGE_LIMITS
        for (const row of entry.sessions) {
          if (entry.archived.has(row?.sessionId)) continue
          // Every remote row must expose imageLimits: the composer dereferences it at
          // paste time, and `null` (a cold row's shape) is not caught by its
          // `!== undefined` guard.
          if (row.projections === undefined || row.projections === null || typeof row.projections !== 'object') {
            row.projections = { kind: 'cached', values: {} }
          }
          if (row.projections.values === undefined || row.projections.values === null) row.projections.values = {}
          if (row.projections.values.imageLimits === null || row.projections.values.imageLimits === undefined) {
            row.projections.values.imageLimits = limits
          }
          rows.push(row)
        }
      } catch (error) {
        log(`session list from ${host.id} failed`, error)
      }
    }
    return rows
  }

  function sortByOrder(items) {
    if (state.order.length === 0) return items
    const rank = new Map(state.order.map((id, index) => [id, index]))
    return [...items].sort((left, right) => {
      const a = rank.get(left.workspaceId)
      const b = rank.get(right.workspaceId)
      if (a === undefined && b === undefined) return 0
      if (a === undefined) return 1
      if (b === undefined) return -1
      return a - b
    })
  }

  /** Rebuild the merged baseline and push it to every open settings stream. */
  async function republish() {
    if (state.lastBaseline === undefined) return
    const views = await allRemoteViews()
    broadcast({
      type: 'replace',
      value: { ...state.lastBaseline, items: sortByOrder([...state.lastBaseline.items, ...views]) },
    })
  }

  buildHosts()

  /**
   * Running state, activity timestamps, and session add/remove live on each Host's
   * forwarded-event stream, not on the projection feed. Re-emitting them into this
   * Host's context is what makes the browser's sidebar agree with the remote.
   */
  const eventPumps = new Map()
  const stopPumps = () => {
    for (const controller of eventPumps.values()) controller.abort()
    eventPumps.clear()
    stopTitleRelays()
  }
  /**
   * A title is generated on whichever Host runs the turn. The local sidebar keeps its own
   * row snapshot, and nothing in the list surface announces a rename — so relay the
   * remote's `title` projection change as `api-session/added`, which is the one event the
   * client applies by upserting the row's projection block.
   */
  const titleRelays = new Map()
  const stopTitleRelays = () => {
    for (const controller of titleRelays.values()) controller.abort()
    titleRelays.clear()
  }
  const startTitleRelays = () => {
    for (const host of state.hosts) {
      const controller = new AbortController()
      titleRelays.set(host.id, controller)
      const run = async () => {
        for (;;) {
          if (controller.signal.aborted) return
          try {
            for await (const frame of host.stream('session/control', { args: {} }, controller.signal)) {
              if (frame?.type !== 'projection' || typeof frame.sessionId !== 'string') continue
              const changed = Array.isArray(frame.changes) ? frame.changes : []
              if (!changed.some((change) => change?.key === 'title')) continue
              const sessionId = frame.sessionId
              const title = changed.find((change) => change?.key === 'title')?.val
              state.titleRelays.push({ at: new Date().toISOString(), sessionId, title: String(title ?? '').slice(0, 60) })
              if (state.titleRelays.length > 20) state.titleRelays.shift()
              // Patch the cached row in place: re-listing would cost a full round trip.
              const entry = state.cache.get(host.id)
              const row = entry?.sessions.find((item) => item?.sessionId === sessionId)
              if (row !== undefined) {
                if (row.projections === undefined || row.projections === null || typeof row.projections !== 'object') {
                  row.projections = { kind: 'cached', values: {} }
                }
                if (row.projections.values === undefined || row.projections.values === null) row.projections.values = {}
                row.projections.values.title = title ?? null
                ctx.emit('api-session/added', row)
              }
            }
          } catch {
            // Reconnect below unless the plugin is going away.
          }
          if (controller.signal.aborted) return
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
      void run()
    }
  }

  const startPumps = () => {
    startTitleRelays()
    for (const host of state.hosts) {
      const controller = new AbortController()
      eventPumps.set(host.id, controller)
      const run = async () => {
        for (;;) {
          if (controller.signal.aborted) return
          try {
            for await (const frame of host.stream('$events', { args: {} }, controller.signal)) {
              if (frame?.type !== 'emit') continue
              if (typeof frame.event !== 'string' || !FORWARDED_EVENTS.has(frame.event)) continue
              const args = Array.isArray(frame.args) ? frame.args : []
              // A remote-only Session id would be unknown locally; remember the owner.
              if (typeof args[0] === 'string') state.sessionHost.set(args[0], host.id)
              ctx.emit(frame.event, ...args)
            }
          } catch {
            // Reconnect below unless the plugin is going away.
          }
          if (controller.signal.aborted) return
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
      void run()
    }
  }

  // A token watchdog on the caller's side rewrites the config file when the remote
  // Host restarts; picking it up here avoids restarting DSH for a rotated token.
  startPumps()

  const configFile = store.configPath()
  let watcher
  try {
    watcher = fs.watch(path.dirname(configFile), (_event, filename) => {
      if (filename !== path.basename(configFile)) return
      if (Date.now() < suppressWatchUntil) return
      setTimeout(() => {
        if (Date.now() < suppressWatchUntil) return
        const next = store.read()
        if (next === undefined) return
        if (JSON.stringify(next) === JSON.stringify(state.config)) return
        state.config = next
        buildHosts()
        void republish()
        ctx.logger?.info?.(`remote-workspaces: reloaded settings (${next.hosts.length} host(s))`)
      }, 200)
    })
  } catch (error) {
    log('config watcher unavailable', error)
  }

  // ---------------- settings routes ----------------
  ctx.inject(['webServer'], (webCtx) => {
    const route = (path, handler) =>
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `remote-workspaces: ${path}`)

    route('/remote-workspaces/config', (req, res) => {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          value: {
            hosts: state.config.hosts.map(({ token, cookie, ...rest }) => ({
              ...rest,
              hasToken: typeof token === 'string' && token !== '',
              hasCookie: typeof cookie === 'string' && cookie !== '',
            })),
            include: state.config.include ?? {},
            source: store.configPath(),
          },
        })
      }
      guard(res, 'route', async () => {
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          return send(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const next = store.normalize(body)
        const previous = new Map(state.config.hosts.map((host) => [host.id, host]))
        // A settings form may omit the token to mean "keep the stored one".
        next.hosts = next.hosts.map((host) => {
          const before = previous.get(host.id)
          if (before === undefined) return host
          // A settings form only round-trips what it can edit; credentials it never
          // displays (token, pasted cookie, or the cookie's authority) must survive.
          const merged = { ...host }
          if (merged.token === undefined || merged.token === '') {
            if (before.token !== undefined) merged.token = before.token
            else delete merged.token
          }
          if (merged.cookie === undefined && before.cookie !== undefined) merged.cookie = before.cookie
          if (merged.authority === undefined && before.authority !== undefined) merged.authority = before.authority
          return merged
        })
        try {
          store.write(next)
        } catch (error) {
          return send(res, 500, { ok: false, error: `cannot save settings: ${String(error?.message ?? error)}` })
        }
        state.config = next
        suppressWatchUntil = Date.now() + 1500
        buildHosts()
        stopPumps()
        startPumps()
        await republish()
        send(res, 200, { ok: true, value: { hosts: next.hosts.map(({ token, ...rest }) => ({ ...rest, hasToken: token !== '' })) } })
      })
    })

    route('/remote-workspaces/workspaces', (req, res) => {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
      const hostId = new URL(req.url ?? '/', 'http://x').searchParams.get('host')
      guard(res, 'route', async () => {
        const host = hostById(hostId ?? '')
        if (host === undefined) return send(res, 404, { ok: false, error: `unknown host ${hostId}` })
        try {
          const baseline = await host.workspaceBaseline()
          const include = includeOf(host)
          const items = (baseline?.items ?? []).map((workspace) => ({
            workspaceId: workspace.workspaceId,
            title: workspace.title,
            path: workspace.path,
            sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
            visible: include === undefined || include.has(workspace.workspaceId),
          }))
          send(res, 200, { ok: true, value: { items } })
        } catch (error) {
          send(res, 502, { ok: false, error: String(error?.message ?? error) })
        }
      })
    })

    /**
     * Diagnostic: reads back what the patched services actually return, so a
     * mismatch between "plugin sees the remote" and "the UI shows it" is one
     * request away instead of a guessing game.
     */
    // Diagnostic: collect what the merged control stream actually emits.
    route('/remote-workspaces/control-tap', (req, res) => {
      guard(res, 'control-tap', async () => {
        const seconds = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('seconds') ?? '20')
        const abort = new AbortController()
        const seen = []
        const iterator = state.controllers.session?.control?.(abort.signal)?.[Symbol.asyncIterator]?.()
        const deadline = Date.now() + Math.min(Math.max(seconds, 1), 60) * 1000
        try {
          // Keep exactly one next() in flight: racing a fresh next() each tick abandons
          // promises and silently drops every slow frame.
          let pending = iterator?.next()
          for (;;) {
            if (pending === undefined) break
            if (Date.now() >= deadline || seen.length >= 200) break
            const outcome = await Promise.race([
              pending.then((value) => ({ value })),
              new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(deadline - Date.now(), 1))),
            ])
            if (outcome.timeout === true) break
            if (outcome.value?.done === true) break
            pending = iterator.next()
            seen.push(String(JSON.stringify(outcome.value.value)).slice(0, 240))
          }
        } finally {
          abort.abort()
          await iterator?.return?.().catch?.(() => {})
        }
        send(res, 200, { ok: true, value: { frames: seen } })
      })
    })

    route('/relay/status', (req, res) => {
      guard(res, 'relay-status', async () => send(res, 200, { ok: true, value: { version: VERSION, ...state.tunnel.status() } }))
    })

    // 账号下的设备清单：面板用它列出「还能连哪几台」。
    route('/relay/devices', (req, res) => {
      guard(res, 'relay-devices', async () => {
        const config = readRelayConfig()
        if (typeof config.token !== 'string' || config.token === '') {
          return send(res, 200, { ok: false, error: '还没有登录' })
        }
        const answer = await relayRequest(config, 'GET', '/v1/devices')
        if (answer.ok !== true) return send(res, 200, { ok: false, error: answer.error ?? `HTTP ${answer.status}` })
        send(res, 200, { ok: true, value: { devices: answer.devices ?? [] } })
      })
    })

    // 为账号下的另一台设备开一条额外隧道（本地端才能用）。
    route('/relay/tunnel/start', (req, res) => {
      guard(res, 'relay-tunnel-start', async () => {
        const body = await readJson(req, 64 * 1024)
        const device = typeof body?.device === 'string' ? body.device.trim() : ''
        if (device === '') return send(res, 400, { ok: false, error: '需要 device' })
        const started = await state.tunnel.startExtra({
          device,
          listen: typeof body?.listen === 'number' ? body.listen : undefined,
          profileConfigPath: store.configPath(),
        })
        send(res, 200, { ok: true, value: started })
      })
    })

    route('/relay/tunnel/stop', (req, res) => {
      guard(res, 'relay-tunnel-stop', async () => {
        const body = await readJson(req, 64 * 1024)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') return send(res, 400, { ok: false, error: '需要 id' })
        const stopped = await state.tunnel.stopExtra(id)
        send(res, 200, { ok: true, value: stopped })
      })
    })

    route('/relay/save', (req, res) => {
      guard(res, 'relay-save', async () => {
        const body = await readJson(req, 64 * 1024)
        const patch = {}
        for (const key of ['role', 'device', 'local', 'listen', 'relay', 'fingerprint', 'cookieDb', 'endpointFile']) {
          if (typeof body?.[key] === 'string') patch[key] = body[key]
        }
        if (patch.role !== undefined && patch.role !== 'agent' && patch.role !== 'client') {
          return send(res, 400, { ok: false, error: 'role 只能是 agent 或 client' })
        }
        if (typeof body?.autoStart === 'boolean') patch.autoStart = body.autoStart
        const next = writeRelayConfig(patch)
        send(res, 200, { ok: true, value: { saved: true, config: { ...next, token: next.token === undefined ? undefined : '已保存' } } })
      })
    })

    route('/relay/register', (req, res) => {
      guard(res, 'relay-register', async () => {
        const body = await readJson(req, 64 * 1024)
        const config = writeRelayConfig({
          ...(typeof body?.relay === 'string' && body.relay !== '' ? { relay: body.relay } : {}),
          ...(typeof body?.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
        })
        const answer = await relayRequest(config, 'POST', '/v1/register', {
          username: String(body?.username ?? ''),
          password: String(body?.password ?? ''),
        })
        if (answer.ok !== true) return send(res, 200, { ok: false, error: answer.error ?? `HTTP ${answer.status}` })
        writeRelayConfig({ token: answer.token, username: answer.username })
        send(res, 200, { ok: true, value: { username: answer.username } })
      })
    })

    route('/relay/login', (req, res) => {
      guard(res, 'relay-login', async () => {
        const body = await readJson(req, 64 * 1024)
        const config = writeRelayConfig({
          ...(typeof body?.relay === 'string' && body.relay !== '' ? { relay: body.relay } : {}),
          ...(typeof body?.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
        })
        const answer = await relayRequest(config, 'POST', '/v1/login', {
          username: String(body?.username ?? ''),
          password: String(body?.password ?? ''),
        })
        if (answer.ok !== true) return send(res, 200, { ok: false, error: answer.error ?? `HTTP ${answer.status}` })
        writeRelayConfig({ token: answer.token, username: answer.username })
        send(res, 200, { ok: true, value: { username: answer.username } })
      })
    })

    route('/relay/logout', (req, res) => {
      guard(res, 'relay-logout', async () => {
        const config = readRelayConfig()
        delete config.token
        delete config.username
        writeRelayConfig(config)
        send(res, 200, { ok: true, value: { loggedOut: true } })
      })
    })

    route('/relay/start', (req, res) => {
      guard(res, 'relay-start', async () => {
        // A client must be told where to publish the credentials it receives, otherwise
        // the sidebar never learns about the remote Host.
        const relayConfig = readRelayConfig()
        const engineArgs = []
        if (relayConfig.role === 'client') {
          engineArgs.push('--config', store.configPath(), '--host-id', String(relayConfig.device ?? 'default'))
        }
        const started = await state.tunnel.start({
          engineArgs,
          onExit: ({ code, signal, stopping }) => {
            // An intentional stop is not a failure; only record real exits.
            if (stopping === true) return
            state.lastError = {
              at: new Date().toISOString(),
              method: 'tunnel/exit',
              sessionId: null,
              code: String(code ?? signal ?? ''),
              message: '隧道进程意外退出',
            }
          },
        })
        send(res, 200, { ok: true, value: started })
      })
    })

    route('/relay/stop', (req, res) => {
      guard(res, 'relay-stop', async () => {
        const stopped = await state.tunnel.stopAll()
        send(res, 200, { ok: true, value: stopped })
      })
    })

    route('/remote-workspaces/client-probe', (req, res) => {
      guard(res, 'client-probe', async () => {
        const body = await readJson(req, 64 * 1024)
        state.clientProbe.push({ at: new Date().toISOString(), ...body })
        if (state.clientProbe.length > 20) state.clientProbe.shift()
        send(res, 200, { ok: true, value: { recorded: true } })
      })
    })

    route('/remote-workspaces/status', (req, res) => {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
      guard(res, 'status', async () => {
        const value = {
          hosts: state.hosts.length,
          patched: {
            sessionController: typeof state.controllers.session?.list === 'function',
            workspaceController: typeof state.controllers.workspace?.follow === 'function',
            followShim: state.controllers.workspace?.follow?.__remoteWorkspacesShim === true,
            listShim: state.controllers.session?.list?.__remoteWorkspacesShim === true,
          },
          sessions: null,
          workspaces: null,
          raw: null,
          lastError: state.lastError ?? null,
          imageLimitsHosts: [...state.imageLimits.keys()],
          uploads: state.uploadStats,
          uploadLog: state.uploadLog,
          actionLog: state.actionLog,
          clientProbe: state.clientProbe,
          titleRelays: state.titleRelays,
          debug: null,
          error: null,
        }
        try {
          const list = await state.controllers.session?.list({}, undefined)
          const items = list?.items ?? []
          value.sessions = { total: items.length, remote: items.filter((row) => state.sessionHost.has(row?.sessionId)).length }
        } catch (error) {
          value.error = String(error?.message ?? error)
        }
        try {
          const rawAbort = new AbortController()
          if (typeof state.originalFollow === 'function') {
            const rawIterator = state.originalFollow(rawAbort.signal)[Symbol.asyncIterator]()
            const rawFirst = await Promise.race([rawIterator.next(), new Promise((resolve) => setTimeout(() => resolve(undefined), 10000))])
            value.raw = { items: rawFirst?.value?.value?.items?.length ?? null, type: rawFirst?.value?.type ?? null }
            rawAbort.abort()
            await rawIterator.return?.()
          }
        } catch (error) {
          value.error = `raw: ${String(error?.message ?? error)}`
        }
        try {
          const abort = new AbortController()
          const iterator = state.controllers.workspace?.follow(abort.signal)?.[Symbol.asyncIterator]?.()
          if (iterator !== undefined) {
            const first = await Promise.race([iterator.next(), new Promise((resolve) => setTimeout(() => resolve(undefined), 8000))])
            const items = first?.value?.value?.items ?? []
            value.workspaces = { total: items.length, remote: items.filter((item) => String(item.workspaceId).startsWith(REMOTE_PREFIX)).length }
            abort.abort()
            await iterator.return?.()
          }
        } catch (error) {
          value.error = `${value.error ?? ''} ${String(error?.message ?? error)}`.trim()
        }
        try {
          const views = await allRemoteViews()
          value.debug = {
            viewCount: views.length,
            hosts: state.hosts.map((host) => {
              const cached = state.cache.get(host.id)
              return {
                id: host.id,
                cachedAgeMs: cached === undefined ? null : Date.now() - cached.at,
                cachedWorkspaces: cached?.workspaces?.length ?? null,
              }
            }),
          }
        } catch (error) {
          value.debug = { error: String(error?.message ?? error) }
        }
        send(res, 200, { ok: true, value })
      })
    })

    route('/remote-workspaces/test', (req, res) => {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
      guard(res, 'route', async () => {
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          return send(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const known = hostById(body?.host ?? '')
        const probe = new RemoteHost({
          id: known?.id ?? 'probe',
          baseUrl: body?.baseUrl ?? known?.baseUrl ?? '',
          token: body?.token ?? known?.token ?? '',
          cookie: body?.cookie ?? known?.staticCookie ?? '',
          authority: body?.authority ?? known?.authority ?? '',
        })
        try {
          const [list, baseline] = await Promise.all([probe.call('session/list', { _request: {} }), probe.workspaceBaseline()])
          send(res, 200, {
            ok: true,
            value: {
              sessions: Array.isArray(list?.items) ? list.items.length : 0,
              workspaces: Array.isArray(baseline?.items) ? baseline.items.length : 0,
            },
          })
        } catch (error) {
          send(res, 502, { ok: false, error: String(error?.message ?? error) })
        }
      })
    })
  })

  // ---------------- session surface ----------------
  ctx.inject(['sessionController'], (inner) => {
    const controller = inner.sessionController
    state.controllers.session = controller
    for (const method of ['list', 'create', ...SESSION_UNARY, ...SESSION_STREAM, ...HOST_STREAM]) resetToPrototype(controller, method)
    const originalList = controller.list.bind(controller)

    const listWrapper = async (request, signal) => {
      const local = await originalList(request, signal)
      const items = Array.isArray(local?.items) ? [...local.items] : []
      const byId = new Map(items.map((item, index) => [item?.sessionId, index]))
      for (const row of await remoteSessionRows()) {
        if (typeof row?.sessionId !== 'string') continue
        const at = byId.get(row.sessionId)
        if (at === undefined) {
          byId.set(row.sessionId, items.length)
          items.push(row)
          continue
        }
        // The local registry can hold a placeholder for a Session this plugin created
        // on the remote (null projections). The remote row is authoritative — overlay
        // it instead of keeping the placeholder.
        items[at] = { ...items[at], ...row }
      }
      return { ...local, items }
    }
    listWrapper.__remoteWorkspacesShim = true
    listWrapper.__remoteWorkspacesShimOriginal = originalList
    controller.list = listWrapper
    state.restore.push(() => {
      if (controller.list === listWrapper) controller.list = originalList
    })

    for (const method of SESSION_UNARY) {
      const original = controller[method]
      if (typeof original !== 'function') continue
      const bound = original.bind(controller)
      const wrapper = async (request, signal) => {
        // A Session created on the other machine is not in this map until a list
        // refresh; guessing "local" would silently serve the wrong Host.
        const startedAt = Date.now()
        const trace = ['prompt', 'cancel', 'updateQueue'].includes(method)
          ? { at: new Date().toISOString(), method, sessionId: sessionIdOf(request) ?? null, outcome: 'started' }
          : undefined
        if (trace !== undefined) {
          state.actionLog.push(trace)
          if (state.actionLog.length > 20) state.actionLog.shift()
        }
        const hostId = await ownerOf(sessionIdOf(request))
        const host = hostById(hostId)
        if (host === undefined) return bound(request, signal)
        // The method sees the unwrapped parameter; the wire wants it re-wrapped
        // under the descriptor's parameter name.
        try {
          const value = await host.call(`session/${method}`, { request }, signal)
          if (trace !== undefined) {
            trace.outcome = 'ok'
            trace.content = Array.isArray(request?.content) ? request.content.map((part) => part?.type).join(',') : undefined
            trace.mode = request?.mode
            trace.ms = Date.now() - startedAt
          }
          return value
        } catch (error) {
          if (trace !== undefined) {
            trace.outcome = 'failed'
            trace.code = error?.code ?? null
            trace.ms = Date.now() - startedAt
          }
          // `session/attachment` changed shape between releases: 0.2.1 sends
          // `{sessionId, attachmentId}`, 0.2.2 sends `{sessionId, attachment:{...}}`.
          // Translate across the gap so a mixed-version pair still renders images.
          if (error?.code === 'session/writer-held' || error?.code === 'session/agent-busy' || /Unknown agent preset/.test(String(error?.message ?? ''))) {
            throw explainRemoteError(error)
          }
          if (method === 'attachment' && (error?.code === 'gateway/input-invalid' || error?.code === 'gateway/arguments-invalid')) {
            const translated = await translateAttachment(host, request)
            if (translated !== undefined) {
              try {
                return await host.call('session/attachment', { request: translated }, signal)
              } catch (retryError) {
                error = retryError
              }
            }
          }
          state.lastError = {
            at: new Date().toISOString(),
            method,
            sessionId: sessionIdOf(request) ?? null,
            code: error?.code ?? null,
            message: String(error?.message ?? error).slice(0, 300),
          }
          // The remote Host serialises writes per Session: whoever has the
          // conversation open there holds the write handle.
          if (error?.code === 'session/writer-held') {
            throw Object.assign(
              new Error('这条会话正在远端被占用（远端 DSH 里打开着它），先在那边关掉这个会话再发送'),
              { code: error.code },
            )
          }
          if (error?.code === 'session/agent-busy') {
            throw Object.assign(new Error('远端这条会话正在跑，等它跑完再发'), { code: error.code })
          }
          throw error
        }
      }
      wrapper.__remoteWorkspacesShim = true
      wrapper.__remoteWorkspacesShimOriginal = original
      controller[method] = wrapper
      state.restore.push(() => {
        if (controller[method] === wrapper) controller[method] = original
      })
    }

    for (const method of SESSION_STREAM) {
      const original = controller[method]
      if (typeof original !== 'function') continue
      const bound = original.bind(controller)
      const wrapper = (request, signal) => {
        const sessionId = sessionIdOf(request)
        const immediate = hostById(state.sessionHost.get(sessionId ?? ''))
        if (immediate !== undefined) return immediate.stream(`session/${method}`, { args: { request } }, signal)
        // Unknown yet: resolve inside the iterable so the caller still gets a stream.
        return (async function* () {
          const host = hostById(await ownerOf(sessionId))
          const source = host === undefined
            ? bound(request, signal)
            : host.stream(`session/${method}`, { args: { request } }, signal)
          for await (const frame of source) yield frame
        })()
      }
      wrapper.__remoteWorkspacesShim = true
      wrapper.__remoteWorkspacesShimOriginal = original
      controller[method] = wrapper
      state.restore.push(() => {
        if (controller[method] === wrapper) controller[method] = original
      })
    }

    /**
     * `session/control` is the Host-wide projection feed: queued rows, running state,
     * usage. Every generation opens with ONE complete baseline, so the merged view has
     * to be a single union — forwarding two baselines would let the last one win.
     */
    for (const method of HOST_STREAM) {
      const original = controller[method]
      if (typeof original !== 'function') continue
      const bound = original.bind(controller)
      const wrapper = (signal) => {
        // Every source is a factory rather than a one-shot iterator: a dropped feed is
        // reopened instead of silently ending that host's live updates. The merged
        // stream keeps the client's single-baseline contract by publishing exactly one
        // union baseline and forwarding every later non-baseline frame.
        const sources = [
          { label: 'local', open: () => bound(signal)[Symbol.asyncIterator]() },
          ...state.hosts.map((host) => ({
            label: host.id,
            open: () => host.stream(`session/${method}`, { args: {} }, signal)[Symbol.asyncIterator](),
          })),
        ]
        const frames = []
        const openings = new Map()
        let wake
        let active = sources.length
        const notify = () => {
          const fn = wake
          wake = undefined
          fn?.()
        }
        const retire = () => {
          active -= 1
          notify()
        }

        for (const source of sources) {
          const run = async () => {
            let first = true
            for (;;) {
              if (signal.aborted) break
              const iterator = source.open()
              try {
                for (;;) {
                  const next = await iterator.next()
                  if (next.done === true) break
                  const frame = next.value
                  if (source.label !== 'local' && frame !== undefined) {
                    const owner = source.label
                    const absorb = (key, value) => {
                      if (key === 'imageLimits' && value !== null && typeof value === 'object') {
                        state.imageLimits.set(owner, value)
                      }
                    }
                    if (frame.type === 'baseline' && frame.value?.projections !== undefined) {
                      for (const [sessionId, projection] of Object.entries(frame.value.projections)) {
                        state.sessionHost.set(sessionId, owner)
                        absorb('imageLimits', projection?.values?.imageLimits)
                      }
                    } else {
                      if (typeof frame.sessionId === 'string') state.sessionHost.set(frame.sessionId, owner)
                      // 0.2.2 ships `changes: [{ key, val }]`; older shapes used key/value.
                      const changes = Array.isArray(frame.changes) ? frame.changes : []
                      for (const change of changes) absorb(change?.key, change?.val)
                      if (frame.key !== undefined) absorb(frame.key, frame.value)
                    }
                  }
                  if (first) {
                    openings.set(source.label, frame)
                    first = false
                  } else {
                    frames.push(frame)
                  }
                  notify()
                }
              } catch {
                // Dropped feed: reopen below unless the consumer went away.
              }
              try {
                await iterator.return?.()
              } catch {
                // ignore
              }
              if (signal.aborted) break
              await new Promise((resolve) => setTimeout(resolve, 3000))
            }
            retire()
          }
          void run()
        }

        return (async function* () {
          try {
            const deadline = Date.now() + 4000
            while (openings.size < sources.length && active > 0 && Date.now() < deadline) {
              await new Promise((resolve) => {
                if (openings.size >= sources.length || active === 0) return resolve()
                wake = resolve
                setTimeout(resolve, 250)
              })
            }
            const projections = {}
            for (const frame of openings.values()) {
              if (frame?.type === 'baseline' && frame.value?.projections !== undefined) {
                Object.assign(projections, frame.value.projections)
              }
            }
            yield { type: 'baseline', value: { projections } }
            for (;;) {
              if (frames.length === 0) {
                if (signal.aborted) return
                await new Promise((resolve) => {
                  if (frames.length > 0) return resolve()
                  wake = resolve
                  // Wake periodically so an aborted consumer is noticed.
                  setTimeout(resolve, 500)
                })
              }
              while (frames.length > 0) {
                const frame = frames.shift()
                // A reconnected source re-sends its baseline; forwarding it would reset
                // the client's union and drop other hosts' rows.
                if (frame?.type === 'baseline') continue
                yield frame
              }
            }
          } finally {
            // Pumps end on their own once the signal aborts.
          }
        })()
      }
      wrapper.__remoteWorkspacesShim = true
      wrapper.__remoteWorkspacesShimOriginal = original
      controller[method] = wrapper
      state.restore.push(() => {
        if (controller[method] === wrapper) controller[method] = original
      })
    }

    // A conversation created inside a remote workspace must live on that machine.
    const originalCreate = controller.create.bind(controller)
    const createWrapper = async (request, signal) => {
      const target = parseRemoteWorkspaceId(request?.workspaceId)
      if (target === undefined) return originalCreate(request, signal)
      const host = hostById(target.hostId)
      if (host === undefined) return originalCreate(request, signal)
      // The local UI sends its own agent preset; a remote Host that lacks it would
      // create a session nothing can resume. Let the remote pick its own default
      // unless the settings name one explicitly.
      const forwarded = { ...request, workspaceId: target.workspaceId }
      const preset = state.config.agentPreset?.[target.hostId]
      if (typeof preset === 'string' && preset !== '') forwarded.agentPreset = preset
      else delete forwarded.agentPreset
      const created = await host.call('session/create', { request: forwarded }, signal)
      if (typeof created?.sessionId === 'string') state.sessionHost.set(created.sessionId, host.id)
      state.cache.delete(host.id)
      return created
    }
    createWrapper.__remoteWorkspacesShim = true
    createWrapper.__remoteWorkspacesShimOriginal = originalCreate
    controller.create = createWrapper
    state.restore.push(() => {
      if (controller.create === createWrapper) controller.create = originalCreate
    })
  })

  // ---------------- file uploads ----------------
  // Uploads are an HTTP route, not an RPC method, and the receipt it returns is only
  // meaningful on the Host that stored the bytes. A remote Session therefore has to
  // receive the file first, then the prompt can reference it.
  ctx.inject(['fileUploads'], (inner) => {
    const service = inner.fileUploads
    const original = service.uploadStream?.bind(service)
    if (typeof original !== 'function') return
    /**
     * Small bodies skip the HTTP route: the browser calls `fileUploads/upload` with
     * base64 over RPC. That method is agent-scoped, and without this wrapper the
     * bytes land on THIS Host while the Session lives on the other one — the paste
     * then fails with a transport error the UI shows as "upload failed".
     */
    resetToPrototype(service, 'upload')
    resetToPrototype(service, 'uploadStream')
    const originalUpload = service.upload?.bind(service)
    const originalStreamBound = service.uploadStream?.bind(service)
    if (typeof originalUpload === 'function') {
      const uploadWrapper = async (agent, request, signal) => {
        const sessionId = agent?.sessionId ?? agent?.session?.sessionId ?? agent?.session?.id ?? agent?.id
        const hostId = await ownerOf(typeof sessionId === 'string' ? sessionId : undefined)
        const host = hostById(hostId)
        if (host === undefined || typeof sessionId !== 'string') {
          state.uploadStats.local += 1
          return originalUpload(agent, request, signal)
        }
        try {
          const value = await host.call('fileUploads/upload', { agentId: sessionId, request }, signal)
          state.uploadStats.ok += 1
          return value
        } catch (error) {
          state.uploadStats.failed += 1
          state.lastError = {
            at: new Date().toISOString(),
            method: 'fileUploads/upload',
            sessionId,
            code: explained?.code ?? null,
            message: String(explained?.message ?? error).slice(0, 300),
          }
          throw explained
        }
      }
      uploadWrapper.__remoteWorkspacesShim = true
      uploadWrapper.__remoteWorkspacesShimOriginal = originalUpload
      service.upload = uploadWrapper
    }

    const forwardUpload = (method) => async (request, delegate) => {
      const startedAt = Date.now()
      const logEntry = { at: new Date().toISOString(), sessionId: request?.sessionId ?? null, name: request?.name ?? null, bytes: 0, hostId: null, outcome: 'started', error: null }
      state.uploadLog.push(logEntry)
      if (state.uploadLog.length > 10) state.uploadLog.shift()
      // Drain the body immediately: the browser is streaming through an XHR, and any
      // await before consumption (ownership lookup, remote round-trip) risks a stall
      // the client reports as a failed upload.
      const chunks = []
      let total = 0
      try {
        for await (const chunk of request.data) {
          total += chunk.length
          if (total > MAX_UPLOAD_BYTES) throw Object.assign(new Error('upload exceeds the relay limit'), { code: 'file/too-large' })
          chunks.push(chunk)
        }
      } catch (error) {
        state.uploadStats.failed += 1
        state.lastError = {
          at: new Date().toISOString(),
          method: 'session/uploadFileBinary(body)',
          sessionId: request?.sessionId ?? null,
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 300),
        }
        throw error
      }
      const body = Buffer.concat(chunks)
      logEntry.bytes = body.length
      const replay = () => (async function* () { if (body.length > 0) yield body })()
      const hostId = await ownerOf(request?.sessionId)
      logEntry.hostId = hostId ?? null
      if (hostId === undefined) {
        state.uploadStats.local += 1
        logEntry.outcome = 'local'
        logEntry.ms = Date.now() - startedAt
        return (delegate ?? original)({ ...request, data: replay() })
      }
      const host = hostById(hostId)
      if (host === undefined) return original(request)
      try {
        const value = await host.uploadFileBinary({ ...request, data: replay() })
        state.uploadStats.ok += 1
        logEntry.outcome = `forwarded:${method}`
        logEntry.ms = Date.now() - startedAt
        if (method === 'uploadImageStream' && value?.image === undefined && value?.file !== undefined) {
          const size = imageSizeFromBytes(body)
          if (size !== undefined) {
            logEntry.outcome = 'forwarded:uploadImageStream(image synthesised)'
            // Match `imageUploadValue` exactly: a stray `file` key would fail its parse.
            return {
              receiptId: value.receiptId,
              image: {
                attachmentId: value.file.attachmentId,
                mediaType: value.file.mediaType ?? request?.mediaType,
                bytes: value.file.bytes,
                width: size.width,
                height: size.height,
                ...(value.file.name === undefined ? {} : { name: value.file.name }),
              },
            }
          }
        }
        return value
      } catch (error) {
        state.uploadStats.failed += 1
        state.lastError = {
          at: new Date().toISOString(),
          method: 'session/uploadFileBinary',
          sessionId: request?.sessionId ?? null,
          name: request?.name ?? null,
          code: error?.code ?? null,
          message: String(error?.message ?? error).slice(0, 300),
        }
        throw error
      }
    }
    const uploadStreamWrapper = forwardUpload('uploadStream')
    uploadStreamWrapper.__remoteWorkspacesShim = true
    uploadStreamWrapper.__remoteWorkspacesShimOriginal = original
    const uploadStreamForLocal = originalStreamBound
    service.uploadStream = (request) => uploadStreamWrapper(request, uploadStreamForLocal)

    // Image uploads take a separate seat: the route calls `uploadImageStream` whenever
    // the request carries `mediaType`, and that method was never proxied — which is why
    // pasting an image failed while a plain file upload worked.
    const originalImage = resetToPrototype(service, 'uploadImageStream')
    const originalImageBound = typeof originalImage === 'function' ? service.uploadImageStream.bind(service) : undefined
    if (typeof originalImage === 'function') {
      const uploadImageWrapper = forwardUpload('uploadImageStream')
      uploadImageWrapper.__remoteWorkspacesShim = true
      uploadImageWrapper.__remoteWorkspacesShimOriginal = originalImage
      // Local Sessions must go to the local image path: uploadStream would store the
      // bytes as a plain file and skip normalisation.
      service.uploadImageStream = (request) => uploadImageWrapper(request, originalImageBound)
    }
  })

  // ---------------- workspace surface ----------------
  ctx.inject(['workspaceController'], (inner) => {
    const controller = inner.workspaceController
    state.controllers.workspace = controller
    for (const method of ['follow', 'insertBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) resetToPrototype(controller, method)
    const originalFollow = controller.follow.bind(controller)

    const transform = (frame, views) => {
      if (frame?.type === 'baseline' || frame?.type === 'replace') {
        const items = Array.isArray(frame.value?.items) ? frame.value.items : []
        // Never merge a view twice: a re-loaded plugin may already have added it, and
        // a frame can pass through more than one patched layer.
        const seen = new Set(items.map((item) => item.workspaceId))
        const fresh = views.filter((view) => !seen.has(view.workspaceId))
        state.localWorkspaceIds = items.map((item) => item.workspaceId).filter((id) => !String(id).startsWith(REMOTE_PREFIX))
        state.lastBaseline = { ...frame.value, items }
        return { ...frame, value: { ...frame.value, items: sortByOrder([...items, ...fresh]) } }
      }
      if (frame?.type === 'order') {
        const ids = Array.isArray(frame.workspaceIds) ? frame.workspaceIds : []
        return { ...frame, workspaceIds: [...ids, ...sortByOrder(views).map((view) => view.workspaceId)] }
      }
      if (frame?.type === 'upsert' && String(frame.workspace?.workspaceId ?? '').startsWith(REMOTE_PREFIX)) return undefined
      if (frame?.type === 'remove' && String(frame.workspaceId ?? '').startsWith(REMOTE_PREFIX)) return undefined
      return frame
    }

    const followWrapper = (signal) => {
      // Marker the diagnostic reads to prove the shim, not the registry, is in play.
      const queue = []
      let wake
      let done = false
      let failure
      const channel = {
        push(frame, synthetic = false) {
          queue.push({ frame, synthetic })
          const fn = wake
          wake = undefined
          fn?.()
        },
        close() {
          done = true
          const fn = wake
          wake = undefined
          fn?.()
        },
      }
      ;(async () => {
        try {
          for await (const frame of originalFollow(signal)) channel.push(frame)
        } catch (error) {
          failure = error
        } finally {
          channel.close()
        }
      })()

      return (async function* () {
        state.subscribers.add(channel)
        try {
          for (;;) {
            if (queue.length === 0) {
              if (done) break
              // A frame can arrive between the check above and the assignment below;
              // re-check inside the promise or the consumer sleeps forever.
              await new Promise((resolve) => {
                if (queue.length > 0 || done || failure !== undefined) return resolve()
                wake = resolve
              })
            }
            while (queue.length > 0) {
              const { frame, synthetic } = queue.shift()
              // Ours already carry the merged set; transforming twice would duplicate views.
              if (synthetic) {
                yield frame
                continue
              }
              const merged = transform(frame, await allRemoteViews())
              if (merged !== undefined) yield merged
            }
            if (failure !== undefined) throw failure
            if (done && queue.length === 0) return
          }
        } finally {
          state.subscribers.delete(channel)
        }
      })()
    }
    followWrapper.__remoteWorkspacesShim = true
    state.originalFollow = originalFollow
    followWrapper.__remoteWorkspacesShimOriginal = originalFollow
    controller.follow = followWrapper
    state.restore.push(() => {
      if (controller.follow === followWrapper) controller.follow = originalFollow
    })

    // Workspace-level Session mutations have to reach the owning Host too, otherwise
    // the sidebar's archive action fails with session/not-found.
    for (const method of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
      const original = controller[method]
      if (typeof original !== 'function') continue
      const bound = original.bind(controller)
      const wrapper = async (request, signal) => {
        const hostId = await ownerOf(request?.sessionId)
        const host = hostById(hostId)
        if (host === undefined) return bound(request, signal)
        return host.call(`workspace/${method}`, { request }, signal)
      }
      wrapper.__remoteWorkspacesShim = true
      wrapper.__remoteWorkspacesShimOriginal = original
      controller[method] = wrapper
      state.restore.push(() => {
        if (controller[method] === wrapper) controller[method] = original
      })
    }

    const originalInsertBefore = controller.insertBefore?.bind(controller)
    if (typeof originalInsertBefore === 'function') {
      const insertWrapper = async (request, signal) => {
        const moved = request?.workspaceId
        const before = request?.beforeWorkspaceId
        const involvesRemote = String(moved).startsWith(REMOTE_PREFIX) || String(before ?? '').startsWith(REMOTE_PREFIX)
        if (!involvesRemote) {
          const result = await originalInsertBefore(request, signal)
          if (Array.isArray(result?.workspaceIds)) state.order = [...result.workspaceIds]
          return result
        }
        // The registry does not know synthetic ids, so the merged order lives here
        // and is republished to every open follower.
        const current = [...state.localWorkspaceIds, ...(await allRemoteViews()).map((view) => view.workspaceId)]
        const base = state.order.length > 0 ? state.order.filter((id) => current.includes(id)) : current
        const without = base.filter((id) => id !== moved)
        const at = before === undefined ? without.length : without.indexOf(before)
        without.splice(at === -1 ? without.length : at, 0, moved)
        state.order = without
        broadcast({ type: 'order', workspaceIds: without })
        return { workspaceIds: without }
      }
      insertWrapper.__remoteWorkspacesShimOriginal = originalInsertBefore
      controller.insertBefore = insertWrapper
      state.restore.push(() => {
        if (controller.insertBefore === insertWrapper) controller.insertBefore = originalInsertBefore
      })
    }
  })

  const dispose = () => {
    for (const restore of state.restore.splice(0)) {
      try {
        restore()
      } catch {
        // The controller may already be gone during shutdown.
      }
    }
    watcher?.close()
    state.cache.clear()
    state.sessionHost.clear()
    state.subscribers.clear()
    if (previousDispose === dispose) previousDispose = undefined
  }
  previousDispose = dispose
  ctx.on('dispose', dispose)
}

export { name, inject, apply }
