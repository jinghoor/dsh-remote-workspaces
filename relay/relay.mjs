/**
 * DSH relay — pairs an outbound agent (the machine running DSH) with an outbound
 * client (the machine viewing it), across a single TLS port.
 *
 * Nothing listens on either machine behind NAT: both ends dial out. The relay only
 * moves bytes, so DSH's own token/cookie auth keeps working end to end — the tunnel
 * is transparent, including WebSocket upgrades.
 */
import net from 'node:net'
import { AccountStore } from './accounts.mjs'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HELLO = 1
const OPEN = 2
const DATA = 3
const CLOSE = 4
const PING = 5
const PONG = 6
const TOKEN = 7
const COOKIE = 8
const AGENT_OFFLINE = 9
const AGENT_ONLINE = 10

const MAX_FRAME = 4 * 1024 * 1024

function parseArgs(argv) {
  const out = {
    port: 19090,
    host: '0.0.0.0',
    cert: '',
    key: '',
    secret: '',
    cli: '',
    dist: '/opt/dsh-relay/dist',
    users: '/opt/dsh-relay/users.json',
    state: '/opt/dsh-relay/token.key',
    // 公共服务配额：按账号限制，防止单个账号占满中转。
    maxDevices: 8,
    maxLinks: 16,
    registerPerHour: 5,
    noRegister: false,
    stats: '/opt/dsh-relay/stats.json',
  }
  const numeric = new Set(['port', 'maxDevices', 'maxLinks', 'registerPerHour'])
  const flags = new Set(['noRegister'])
  const toCamel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const key = toCamel(raw.slice(2))
    if (flags.has(key)) {
      out[key] = true
      continue
    }
    if (!(key in out)) continue
    const value = argv[i + 1]
    i += 1
    out[key] = numeric.has(key) ? Number(value) : value
  }
  return out
}

/** Length-prefixed frames: [type:1][streamId:4][len:4][payload]. */
function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(streamId >>> 0, 1)
  head.writeUInt32BE(payload.length, 5)
  return Buffer.concat([head, payload])
}

class FrameReader {
  constructor(socket, onFrame) {
    this.socket = socket
    this.onFrame = onFrame
    this.buffer = Buffer.alloc(0)
  }
  /** Attach after the first chunk is pushed, so sniffing never races the frame loop. */
  attach() {
    this.socket.on('data', (chunk) => this.push(chunk))
  }
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 9) return
      const type = this.buffer.readUInt8(0)
      const streamId = this.buffer.readUInt32BE(1)
      const length = this.buffer.readUInt32BE(5)
      if (length > MAX_FRAME) {
        this.socket.destroy(new Error('frame too large'))
        return
      }
      if (this.buffer.length < 9 + length) return
      const payload = this.buffer.subarray(9, 9 + length)
      this.buffer = this.buffer.subarray(9 + length)
      this.onFrame(type, streamId, payload)
    }
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.cert === '' || args.key === '') {
  console.error('relay: --cert and --key are required')
  process.exit(1)
}
if (args.secret === '') {
  console.error('relay: --secret is required (the agent handshake credential)')
  process.exit(1)
}

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

/**
 * Per-account traffic accounting.
 *
 * Only the operator can read it (admin secret); tenants never see another account's
 * numbers, and nothing about it is exposed through the tenant API. Totals are flushed
 * to disk so a restart does not reset the picture, and a daily bucket answers
 * "who is heavy today".
 */
const statsFile = args.stats === '' ? '' : args.stats
const traffic = new Map() // username → { toAgent, toClient, since }
let trafficDay = new Date().toISOString().slice(0, 10)

function accountOf(device) {
  const key = String(device ?? '')
  if (!key.startsWith('user:')) return undefined
  const rest = key.slice('user:'.length)
  const at = rest.indexOf('/')
  return at === -1 ? rest : rest.slice(0, at)
}

const HOUR_MS = 60 * 60 * 1000
/** 保留最近多少小时的分桶；更早的丢弃，避免 stats.json 无限增长。 */
const HOURLY_KEEP = 72

function hourKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 13) // YYYY-MM-DDTHH (UTC)
}

function pruneHourly(hourly, now = Date.now()) {
  const cutoff = hourKey(now - HOURLY_KEEP * HOUR_MS)
  for (const key of Object.keys(hourly)) if (key < cutoff) delete hourly[key]
}

/** @returns the per-hour series of one account, oldest first. */
function hourlySeries(hourly, hours) {
  const now = Date.now()
  const series = []
  for (let offset = hours - 1; offset >= 0; offset -= 1) {
    const key = hourKey(now - offset * HOUR_MS)
    const bucket = hourly[key] ?? { toAgent: 0, toClient: 0 }
    series.push({ hour: key, toAgent: bucket.toAgent, toClient: bucket.toClient, total: bucket.toAgent + bucket.toClient })
  }
  return series
}

function countTraffic(device, direction, bytes) {
  const username = accountOf(device)
  if (username === undefined || !Number.isFinite(bytes) || bytes <= 0) return
  const today = new Date().toISOString().slice(0, 10)
  if (today !== trafficDay) {
    trafficDay = today
    for (const entry of traffic.values()) entry.today = { toAgent: 0, toClient: 0 }
  }
  const entry = traffic.get(username) ?? { toAgent: 0, toClient: 0, today: { toAgent: 0, toClient: 0 }, hourly: {}, since: Date.now() }
  entry.today ??= { toAgent: 0, toClient: 0 }
  entry.hourly ??= {}
  const key = hourKey()
  const bucket = entry.hourly[key] ?? { toAgent: 0, toClient: 0 }
  if (direction === 'toAgent') {
    entry.toAgent += bytes
    entry.today.toAgent += bytes
    bucket.toAgent += bytes
  } else {
    entry.toClient += bytes
    entry.today.toClient += bytes
    bucket.toClient += bytes
  }
  entry.hourly[key] = bucket
  // 每小时最多清一次，够用且不会在热路径上反复遍历。
  if (entry.prunedHour !== key) {
    entry.prunedHour = key
    pruneHourly(entry.hourly)
  }
  traffic.set(username, entry)
}

function loadTraffic() {
  if (statsFile === '') return
  try {
    const parsed = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
    trafficDay = parsed.day ?? trafficDay
    for (const [username, entry] of Object.entries(parsed.accounts ?? {})) traffic.set(username, entry)
    log(`traffic stats loaded for ${traffic.size} account(s)`)
  } catch {
    // 第一次运行没有文件，正常。
  }
}

function saveTraffic() {
  if (statsFile === '') return
  try {
    fs.writeFileSync(
      statsFile,
      JSON.stringify({ day: trafficDay, updatedAt: new Date().toISOString(), accounts: Object.fromEntries(traffic) }, null, 2),
      { mode: 0o600 },
    )
  } catch (error) {
    log(`cannot write traffic stats: ${error.message}`)
  }
}
const agents = new Map() // namespaced device key → { socket, streams: Map<streamId, clientConn> }
const clients = new Set()
const accounts = new AccountStore(args.users, args.state)

/** A consumer this far behind is dropped instead of growing relay memory without bound. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024

function send(conn, type, streamId, payload = Buffer.alloc(0)) {
  if (conn.socket.destroyed) return
  // Data frames are coalesced per tick so each TLS record carries a full read.
  if (conn.socket.writableLength > MAX_PENDING_BYTES) {
    // A consumer that cannot keep up must not grow the relay's memory without bound.
    log('slow consumer: dropping connection with >8MB queued')
    conn.socket.destroy()
    return
  }
  if (type === DATA) {
    conn.pending ??= { chunks: [], bytes: 0, scheduled: false, streamId }
    const bucket = conn.pending
    if (bucket.streamId !== streamId || bucket.bytes + payload.length > 256 * 1024) {
      flushData(conn)
      bucket.streamId = streamId
    }
    bucket.chunks.push(payload)
    bucket.bytes += payload.length
    if (bucket.bytes >= 64 * 1024) flushData(conn)
    else if (!bucket.scheduled) {
      bucket.scheduled = true
      setImmediate(() => flushData(conn))
    }
    return
  }
  conn.socket.write(encodeFrame(type, streamId, payload))
}

function flushData(conn) {
  const bucket = conn.pending
  if (bucket === undefined || bucket.bytes === 0) {
    if (bucket !== undefined) bucket.scheduled = false
    return
  }
  const merged = bucket.chunks.length === 1 ? bucket.chunks[0] : Buffer.concat(bucket.chunks, bucket.bytes)
  const streamId = bucket.streamId
  bucket.chunks = []
  bucket.bytes = 0
  bucket.scheduled = false
  if (!conn.socket.destroyed) conn.socket.write(encodeFrame(DATA, streamId, merged))
}

/** Tell every viewer of one device that its agent came or went. */
function notifyClients(device, type) {
  for (const conn of clients) {
    if (conn.device === device) send(conn, type, 0)
  }
}

function dropAgent(device, reason) {
  const record = agents.get(device)
  if (record === undefined) return
  agents.delete(device)
  for (const [streamId, clientConn] of record.streams) {
    send(clientConn, CLOSE, streamId)
  }
  record.streams.clear()
  log(`agent ${device} gone (${reason})`)
  notifyClients(device, AGENT_OFFLINE)
}

function handleClientFrame(conn, type, streamId, payload) {
  if (type === PING) return send(conn, PONG, 0)
  if (type === PONG) return
  if (type === DATA) countTraffic(conn.device, 'toAgent', payload.length)
  const record = agents.get(conn.device)
  if (type === OPEN) {
    if (record === undefined) {
      // No agent yet: the local socket is closed immediately, which surfaces as a
      // connection error instead of a silent hang.
      send(conn, CLOSE, streamId)
      return
    }
    record.streams.set(streamId, conn)
    send(record, OPEN, streamId, payload)
    return
  }
  if (record === undefined) return
  if (type === DATA) {
    send(record, DATA, streamId, payload)
    return
  }
  if (type === CLOSE) {
    record.streams.delete(streamId)
    send(record, CLOSE, streamId)
  }
}

function handleAgentFrame(device, type, streamId, payload) {
  if (type === PING) return
  if (type === DATA) countTraffic(device, 'toClient', payload.length)
  const record = agents.get(device)
  if (record === undefined) return
  if (type === COOKIE) {
    record.cookie = payload.toString('utf8')
    log(`agent ${device} published a browser cookie`)
    for (const conn of clients) if (conn.device === device) send(conn, COOKIE, 0, payload)
    return
  }
  if (type === TOKEN) {
    // The agent republishes the Host's launch token after a restart; every viewer
    // for that device needs it so the tunnel survives without manual copying.
    record.token = payload.toString('utf8')
    log(`agent ${device} published a new token (${record.token.length} chars)`)
    for (const conn of clients) if (conn.device === device) send(conn, TOKEN, 0, payload)
    return
  }
  const clientConn = record.streams.get(streamId)
  if (clientConn === undefined) return
  if (type === DATA) {
    send(clientConn, DATA, streamId, payload)
  } else if (type === CLOSE) {
    record.streams.delete(streamId)
    send(clientConn, CLOSE, streamId)
  }
}

function httpReply(socket, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const type = typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'
  socket.end(
    `HTTP/1.1 ${status} OK\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\ncache-control: no-store\r\n\r\n${body}`,
  )
}

/** One account-scoped HTTP API, served on the same TLS port as the tunnel. */
/**
 * Failed-login throttle. Ten wrong passwords per five minutes per source address and
 * account is enough for a human and useless for a brute-force run.
 */
const loginFailures = new Map()
/** 公共服务的注册闸门：同一来源每小时最多注册几个账号。 */
const registerBuckets = new Map()
function registerAllowed(remoteAddress, limit) {
  const key = remoteAddress ?? '?'
  const now = Date.now()
  const bucket = registerBuckets.get(key)
  if (bucket === undefined || now - bucket.firstAt > 60 * 60 * 1000) {
    registerBuckets.set(key, { count: 1, firstAt: now })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}
function loginBlocked(key) {
  const entry = loginFailures.get(key)
  if (entry === undefined) return false
  if (Date.now() - entry.firstAt > 5 * 60 * 1000) {
    loginFailures.delete(key)
    return false
  }
  return entry.count >= 10
}
function noteLoginFailure(key) {
  const entry = loginFailures.get(key)
  if (entry === undefined || Date.now() - entry.firstAt > 5 * 60 * 1000) {
    loginFailures.set(key, { count: 1, firstAt: Date.now() })
    return
  }
  entry.count += 1
}

function serveApi(socket, method, rawPath, headers, body) {
  // Request lines carry the query string; every route below compares bare paths.
  const [pathname, queryText = ''] = String(rawPath).split('?')
  const query = new URLSearchParams(queryText)
  const json = () => {
    try {
      return body === '' ? {} : JSON.parse(body)
    } catch {
      return undefined
    }
  }
  const bearer = () => {
    const header = headers['authorization'] ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    return match?.[1]
  }

  if (pathname === '/v1/register' && method === 'POST') {
    const payload = json()
    if (payload === undefined) return httpReply(socket, 400, { ok: false, error: 'body must be JSON' })
    if (args.noRegister === true) return httpReply(socket, 403, { ok: false, error: 'registration is closed on this relay' })
    if (!registerAllowed(socket.remoteAddress, args.registerPerHour)) {
      log(`register throttled for ${socket.remoteAddress ?? '?'}`)
      return httpReply(socket, 429, { ok: false, error: '注册过于频繁，请一小时后再试' })
    }
    try {
      const issued = accounts.register(String(payload.username ?? ''), String(payload.password ?? ''))
      log(`account registered: ${issued.username} from ${socket.remoteAddress ?? '?'}`)
      return httpReply(socket, 200, { ok: true, ...issued })
    } catch (error) {
      return httpReply(socket, 400, { ok: false, error: String(error.message ?? error) })
    }
  }

  if (pathname === '/v1/login' && method === 'POST') {
    const payload = json()
    if (payload === undefined) return httpReply(socket, 400, { ok: false, error: 'body must be JSON' })
    const throttleKey = `${socket.remoteAddress ?? '?'}|${String(payload.username ?? '').toLowerCase()}`
    if (loginBlocked(throttleKey)) {
      log(`login throttled for ${String(payload.username ?? '')} from ${socket.remoteAddress ?? '?'}`)
      return httpReply(socket, 429, { ok: false, error: '尝试过于频繁，请 5 分钟后再试' })
    }
    try {
      const issued = accounts.login(String(payload.username ?? ''), String(payload.password ?? ''))
      loginFailures.delete(throttleKey)
      log(`account login: ${issued.username} from ${socket.remoteAddress ?? '?'}`)
      return httpReply(socket, 200, { ok: true, ...issued })
    } catch (error) {
      noteLoginFailure(throttleKey)
      return httpReply(socket, 401, { ok: false, error: String(error.message ?? error) })
    }
  }

  // Operator-only endpoint: device claims are permanent by design, so releasing one
  // needs the relay's own secret rather than any tenant token.
  if (pathname === '/v1/admin/release' && method === 'POST') {
    if ((headers['x-relay-secret'] ?? '') !== args.secret || args.secret === '') {
      return httpReply(socket, 403, { ok: false, error: 'admin secret required' })
    }
    const payload = json()
    const device = String(payload?.device ?? '')
    if (device === '') return httpReply(socket, 400, { ok: false, error: 'device required' })
    const released = accounts.releaseDevice(device, typeof payload?.username === 'string' ? payload.username : undefined)
    log(`device ${device} ${released ? 'released' : 'was not claimed'}`)
    return httpReply(socket, 200, { ok: true, released })
  }

  if (pathname === '/v1/admin/stats' && method === 'GET') {
    if ((headers['x-relay-secret'] ?? '') !== args.secret || args.secret === '') {
      return httpReply(socket, 403, { ok: false, error: 'admin secret required' })
    }
    const wantedHours = Math.min(Math.max(Number(query.get('hours') ?? '0') || 0, 0), HOURLY_KEEP)
    const onlyAccount = query.get('account') ?? ''
    const rows = [...traffic.entries()]
      .filter(([username]) => onlyAccount === '' || username === onlyAccount)
      .map(([username, entry]) => {
      const live = [...clients].filter((conn) => String(conn.device).startsWith(`user:${username}/`)).length
      const devices = accounts.devicesOf(username).length
      return {
        username,
        devices,
        liveLinks: live,
        toAgent: entry.toAgent,
        toClient: entry.toClient,
        total: entry.toAgent + entry.toClient,
        todayToAgent: entry.today?.toAgent ?? 0,
        todayToClient: entry.today?.toClient ?? 0,
        todayTotal: (entry.today?.toAgent ?? 0) + (entry.today?.toClient ?? 0),
        ...(wantedHours === 0 ? {} : { hourly: hourlySeries(entry.hourly ?? {}, wantedHours) }),
      }
    }).sort((left, right) => right.total - left.total)
    return httpReply(socket, 200, { ok: true, day: trafficDay, hours: wantedHours, accounts: rows })
  }

  if (pathname === '/v1/admin/revoke' && method === 'POST') {
    if ((headers['x-relay-secret'] ?? '') !== args.secret || args.secret === '') {
      return httpReply(socket, 403, { ok: false, error: 'admin secret required' })
    }
    const payload = json()
    const username = String(payload?.username ?? '')
    if (username === '') return httpReply(socket, 400, { ok: false, error: 'username required' })
    const version = accounts.revokeTokens(username)
    if (version === undefined) return httpReply(socket, 404, { ok: false, error: 'unknown account' })
    // A live tunnel outlives its handshake, so revocation must also cut it: otherwise a
    // stolen credential keeps working for as long as the socket stays open.
    const prefix = `user:${username}/`
    let dropped = 0
    for (const [key, record] of [...agents]) {
      if (!key.startsWith(prefix)) continue
      record.socket.destroy()
      dropped += 1
    }
    for (const conn of [...clients]) {
      if (!String(conn.device).startsWith(prefix)) continue
      conn.socket.destroy()
      dropped += 1
    }
    log(`account ${username} tokens revoked (version ${version}, dropped ${dropped} live link(s))`)
    return httpReply(socket, 200, { ok: true, tokenVersion: version, dropped })
  }

  if (pathname === '/v1/admin/user-remove' && method === 'POST') {
    if ((headers['x-relay-secret'] ?? '') !== args.secret || args.secret === '') {
      return httpReply(socket, 403, { ok: false, error: 'admin secret required' })
    }
    const payload = json()
    const username = String(payload?.username ?? '')
    if (username === '') return httpReply(socket, 400, { ok: false, error: 'username required' })
    const result = accounts.removeUser(username)
    log(`account ${username} ${result.removed ? `removed (released ${result.devices.length} device(s))` : 'not found'}`)
    return httpReply(socket, 200, { ok: true, ...result })
  }

  const username = accounts.verify(bearer())
  if (username === undefined) return httpReply(socket, 401, { ok: false, error: 'missing or invalid token' })
  if (pathname === '/v1/whoami') return httpReply(socket, 200, { ok: true, username })
  if (pathname === '/v1/devices') {
    // `online` tells the panel which of the account's machines can be connected right now.
    const devices = accounts.devicesOf(username).map((item) => ({
      ...item,
      online: agents.has(`user:${username}/${item.device}`),
    }))
    const liveClients = new Set([...clients].map((conn) => conn.clientId).filter((id) => typeof id === 'string'))
    const viewers = accounts.clientsOf(username).map((item) => ({ ...item, online: liveClients.has(item.clientId) }))
    return httpReply(socket, 200, { ok: true, username, devices, clients: viewers })
  }
  return httpReply(socket, 404, { ok: false, error: 'not found' })
}

function serveHttp(socket, method, pathname, headers, body) {
  if (pathname.startsWith('/v1/')) return serveApi(socket, method, pathname, headers, body)
  if (method !== 'GET') return httpReply(socket, 405, 'method not allowed')
  // Packaged releases (the plugin bundle) live next to the relay and are served here,
  // so a machine that can reach the tunnel can also fetch what it needs to install.
  if (pathname.startsWith('/dist/')) {
    const name = path.basename(pathname.slice('/dist/'.length))
    const file = path.join(args.dist, name)
    if (name === '' || name.includes('..') || !fs.existsSync(file)) return httpReply(socket, 404, 'not found')
    const payload = fs.readFileSync(file)
    const type = name.endsWith('.tar.gz') ? 'application/gzip' : 'application/octet-stream'
    // Headers and body must leave in one end() call: writing after end() drops the body.
    socket.end(
      Buffer.concat([
        Buffer.from(
          `HTTP/1.1 200 OK\r\ncontent-type: ${type}\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n`,
        ),
        payload,
      ]),
    )
    return
  }
  const name = pathname.split('/').pop() || 'dsh-relay.mjs'
  if (args.cli === '' || !fs.existsSync(args.cli) || name !== 'dsh-relay.mjs') return httpReply(socket, 404, 'not found')
  const payload = fs.readFileSync(args.cli)
  socket.end(
    `HTTP/1.1 200 OK\r\ncontent-type: text/javascript; charset=utf-8\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n` +
      payload.toString('utf8'),
  )
}

const server = tls.createServer({ cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) }, (socket) => {
  let greeted = false
  let reader
  let dispatch = () => {}

  const hello = (type, streamId, payload) => {
    if (greeted) return
    if (type !== HELLO) {
      socket.destroy(new Error('expected hello'))
      return
    }
    let parsed
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      socket.destroy(new Error('bad hello'))
      return
    }
    const device = String(parsed.device ?? '')
    if (device === '') return socket.destroy()

    // Two admission paths: an account token (multi-tenant) or the legacy shared
    // secret, which is pinned to its own namespace so it can never reach a tenant.
    let namespace
    let username
    if (typeof parsed.token === 'string' && parsed.token !== '') {
      username = accounts.verify(parsed.token)
      if (username === undefined) {
        log(`${parsed.role} ${device} rejected: invalid or expired token`)
        socket.end(encodeFrame(CLOSE, 0))
        return
      }
      namespace = `user:${username}`
    } else if (parsed.secret !== undefined) {
      if (parsed.secret !== args.secret) {
        log(`${parsed.role} ${device} rejected: bad secret`)
        socket.end(encodeFrame(CLOSE, 0))
        return
      }
      namespace = 'legacy'
    } else if (parsed.role === 'client') {
      // Older clients predate credentials. They may only reach an agent that itself
      // authenticated with the shared secret, which keeps them out of account devices.
      if (!agents.has(`legacy/${device}`)) {
        log(`client ${device} rejected: no credential`)
        socket.end(encodeFrame(CLOSE, 0))
        return
      }
      namespace = 'legacy'
    } else {
      log(`${parsed.role} ${device} rejected: no credential`)
      socket.end(encodeFrame(CLOSE, 0))
      return
    }

    const key = `${namespace}/${device}`

    if (parsed.role === 'agent') {
      // Names are scoped per account, so claiming can never collide with another tenant.
      if (username !== undefined && accounts.devicesOf(username).length >= args.maxDevices) {
        const known = accounts.devicesOf(username).some((item) => item.device === device)
        if (!known) {
          log(`agent ${device} rejected: account ${username} reached ${args.maxDevices} devices`)
          socket.end(encodeFrame(CLOSE, 0))
          return
        }
      }
      if (username !== undefined && accounts.claimDevice(username, device) !== true) {
        log(`agent ${device} rejected: invalid device name`)
        socket.end(encodeFrame(CLOSE, 0))
        return
      }
      if (agents.has(key)) dropAgent(key, 'replaced by a new connection')
      const record = { socket, streams: new Map(), pong: parsed.pong === true, token: typeof parsed.token === 'string' ? parsed.token : undefined, cookie: undefined }
      socket.dshKey = key
      agents.set(key, record)
      notifyClients(key, AGENT_ONLINE)
      greeted = true
      log(`agent online: ${username === undefined ? device : `${username}/${device}`} from ${socket.remoteAddress ?? '?'}`)
      dispatch = (frameType, frameStream, framePayload) => handleAgentFrame(key, frameType, frameStream, framePayload)
      return
    }

    if (parsed.role === 'client') {
      if (username !== undefined) {
        const live = [...clients].filter((item) => String(item.device).startsWith(`user:${username}/`)).length
        if (live >= args.maxLinks) {
          log(`client for ${device} rejected: account ${username} reached ${args.maxLinks} links`)
          socket.end(encodeFrame(CLOSE, 0))
          return
        }
      }
      if (username !== undefined && accounts.ownsDevice(username, device) !== true) {
        log(`client for ${device} rejected: ${username} never used that device`)
        socket.end(encodeFrame(CLOSE, 0))
        return
      }
      const conn = {
        socket,
        device: key,
        pong: parsed.pong === true,
        username: username,
        clientId: typeof parsed.clientId === 'string' ? parsed.clientId : undefined,
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      }
      clients.add(conn)
      greeted = true
      if (username !== undefined) accounts.noteClient(username, conn.clientId, conn.hostname, device)
      log(`client attached for ${username === undefined ? device : `${username}/${device}`}${agents.has(key) ? '' : ' (agent offline)'}${conn.hostname === undefined ? '' : ` from ${conn.hostname}`}`)
      const known = agents.get(key)
      if (known?.token !== undefined) send(conn, TOKEN, 0, Buffer.from(known.token, 'utf8'))
      if (known?.cookie !== undefined) send(conn, COOKIE, 0, Buffer.from(known.cookie, 'utf8'))
      send(conn, known === undefined ? AGENT_OFFLINE : AGENT_ONLINE, 0)
      dispatch = (frameType, frameStream, framePayload) => handleClientFrame(conn, frameType, frameStream, framePayload)
      socket.on('close', () => {
        clients.delete(conn)
        const record = agents.get(key)
        if (record === undefined) return
        for (const [streamId, owner] of [...record.streams]) {
          if (owner === conn) {
            record.streams.delete(streamId)
            send(record, CLOSE, streamId)
          }
        }
      })
      return
    }
    socket.destroy(new Error('unknown role'))
  }

  const startFrames = (first) => {
    // `socket.dshLastSeen` drives the idle sweep below.
    socket.dshLastSeen = Date.now()
    reader = new FrameReader(socket, (type, streamId, payload) => {
      socket.dshLastSeen = Date.now()
      // A malformed or hostile frame must cost one connection, never the process.
      try {
        if (!greeted) return hello(type, streamId, payload)
        dispatch(type, streamId, payload)
      } catch (error) {
        log(`frame handler error: ${error?.message ?? error}`)
        socket.destroy()
      }
    })
    reader.push(first)
    reader.attach()
  }

  socket.once('data', (first) => {
    const head = first.subarray(0, 4).toString('latin1')
    if (head.startsWith('GET') || head.startsWith('POST')) {
      let buffer = first
      const finish = () => {
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return false
        const headText = buffer.subarray(0, end).toString('latin1')
        const [requestLine, ...headerLines] = headText.split('\r\n')
        const [method, pathname] = requestLine.split(' ')
        const headers = {}
        for (const line of headerLines) {
          const at = line.indexOf(':')
          if (at === -1) continue
          headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
        }
        const length = Number(headers['content-length'] ?? '0')
        if (Number.isFinite(length) && length > 0 && buffer.length < end + 4 + length) return false
        const body = length > 0 ? buffer.subarray(end + 4, end + 4 + length).toString('utf8') : ''
        serveHttp(socket, method, pathname, headers, body)
        return true
      }
      if (finish()) return
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        finish()
      })
      return
    }
    startFrames(first)
  })

  socket.on('error', () => {})
  socket.on('close', () => {
    for (const [device, record] of agents) if (record.socket === socket) dropAgent(device, 'socket closed')
  })
})

process.on('uncaughtException', (error) => {
  log(`uncaught: ${error?.stack ?? error}`)
})
process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error?.stack ?? error}`)
})

loadTraffic()
setInterval(saveTraffic, 30_000).unref()
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    saveTraffic()
    process.exit(0)
  })
}

server.listen(args.port, args.host, () => {
  log(`relay listening on ${args.host}:${args.port}`)
  log(`agent handshake secret: ${args.secret.slice(0, 6)}… (${args.secret.length} chars)`)
})

setInterval(() => {
  const now = Date.now()
  for (const [, record] of agents) {
    const last = record.socket.dshLastSeen ?? 0
    // Only sweeps peers that promised to answer pings: an older engine is silent by
    // design and must be left to TCP keepalive instead of being killed every minute.
    if (record.pong === true && last !== 0 && now - last > 70000) {
      log(`agent ${record.socket.dshKey ?? '?'} idle 70s; dropping`)
      record.socket.destroy()
      continue
    }
    send(record, PING, 0)
  }
  for (const conn of clients) {
    const last = conn.socket.dshLastSeen ?? 0
    if (conn.pong === true && last !== 0 && now - last > 70000) {
      log('client idle 70s; dropping')
      conn.socket.destroy()
      continue
    }
    send(conn, PING, 0)
  }
  // Surviving keys from a crashed relay instance would otherwise pin memory.
  if (loginFailures.size > 512) {
    for (const [key, entry] of loginFailures) {
      if (now - entry.firstAt > 5 * 60 * 1000) loginFailures.delete(key)
    }
  }
}, 20000).unref()
