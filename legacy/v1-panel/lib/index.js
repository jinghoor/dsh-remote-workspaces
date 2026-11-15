const name = 'remote-sessions'
const inject = ['webServer']

/**
 * Cookies are bound to the remote authority, so they can never be reused across hosts.
 * Keyed by host id.
 */
const cookieCache = new Map()

function timeoutSignal(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

async function exchangeToken(host, timeoutMs) {
  if (host.token === '') throw new Error(`host ${host.id} has no token configured`)
  const { signal, done } = timeoutSignal(timeoutMs)
  try {
    const res = await fetch(`${host.baseUrl}/?token=${encodeURIComponent(host.token)}`, {
      redirect: 'manual',
      signal,
      headers: { accept: 'text/html' },
    })
    const headers = res.headers
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
    const pair = list
      .map((value) => value.split(';')[0].trim())
      .filter((value) => value.includes('='))
      .join('; ')
    if (pair === '') {
      throw new Error(`token exchange returned HTTP ${res.status} without a session cookie`)
    }
    return pair
  } finally {
    done()
  }
}

async function cookieFor(host, config) {
  const cached = cookieCache.get(host.id)
  if (cached !== undefined) return cached
  const cookie = await exchangeToken(host, config.requestTimeoutMs)
  cookieCache.set(host.id, cookie)
  return cookie
}

async function callRemote(host, config, endpoint, args) {
  const cookie = await cookieFor(host, config)
  const { signal, done } = timeoutSignal(config.requestTimeoutMs)
  try {
    const res = await fetch(`${host.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', cookie, origin: host.baseUrl },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        method: endpoint,
        payload: { args },
      }),
    })
    if (res.status === 401 || res.status === 403) {
      cookieCache.delete(host.id)
      throw new Error(`remote host rejected the stored credential (HTTP ${res.status})`)
    }
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`remote ${endpoint} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    const result = body?.result
    if (result?.ok !== true) {
      const error = result?.error ?? {}
      const failure = new Error(`${endpoint}: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim())
      failure.code = error.code
      failure.details = error.details
      throw failure
    }
    return result.value
  } finally {
    done()
  }
}

/**
 * The webserver's `resource` seat could not construct a Fetch Request for these
 * routes, so this plugin registers node-style handlers. A handler sees no Peer,
 * hence the check is the presence of this Host's signed browser-session cookie.
 * The shipped web app binds a loopback address by default; a Host exposed on
 * another interface must add its own Origin fence in front of `/remote-dsh`.
 */
function authorized(req) {
  const cookie = req.headers.cookie ?? ''
  return /(?:^|;\s*)dsh-auth-[^=;]+=/.test(cookie)
}

function send(req, res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function fail(req, res, error, status) {
  send(req, res, status ?? 502, {
    ok: false,
    error: String(error?.message ?? error),
    code: error?.code ?? null,
  })
}

async function readJson(req, limitBytes = 8 * 1024 * 1024) {
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

function apply(ctx, rawConfig) {
  const config = { hosts: [], requestTimeoutMs: 20000, ...(rawConfig ?? {}) }
  const hosts = new Map(config.hosts.map((host) => [host.id, host]))

  const resolveHost = (value) => {
    const host = hosts.get(value ?? '')
    if (host === undefined) {
      throw Object.assign(new Error(`unknown remote host ${JSON.stringify(value)}`), { notFound: true })
    }
    return host
  }

  const route = (path, methods, handler) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, methods, handler }),
      `remote-sessions: ${path}`,
    )

  route('/remote-dsh/hosts', ['GET'], (req, res) => {
    if (!authorized(req)) return send(req, res, 401, { ok: false, error: 'unauthorized' })
    send(req, res, 200, {
      ok: true,
      value: config.hosts.map(({ token, ...rest }) => ({ ...rest, hasToken: token !== '' })),
    })
  })

  const listSessions = async (req, res, hostId) => {
    try {
      const host = resolveHost(hostId)
      const value = await callRemote(host, config, 'session/list', { _request: {} })
      send(req, res, 200, { ok: true, value })
    } catch (error) {
      fail(req, res, error, error?.notFound === true ? 404 : 502)
    }
  }

  route('/remote-dsh/sessions', ['GET', 'HEAD'], (req, res) => {
    if (!authorized(req)) return send(req, res, 401, { ok: false, error: 'unauthorized' })
    const hostId = new URL(req.url ?? '/', 'http://x').searchParams.get('host')
    void listSessions(req, res, hostId)
  })

  /**
   * `session/events` is the current endpoint; 0.2.1 Hosts only expose the deprecated
   * `session/page`. Both return `{ records: [{ type: 'event', event }], hasMore }`, so the
   * caller gets one shape regardless of the remote version.
   */
  route('/remote-dsh/history', ['GET', 'HEAD'], (req, res) => {
    if (!authorized(req)) return send(req, res, 401, { ok: false, error: 'unauthorized' })
    const params = new URL(req.url ?? '/', 'http://x').searchParams
    void (async () => {
      try {
        const host = resolveHost(params.get('host'))
        const sessionId = params.get('sessionId') ?? ''
        if (sessionId === '') return send(req, res, 400, { ok: false, error: 'sessionId is required' })
        let throughSeq = Number(params.get('throughSeq') ?? '0')
        const maxMessages = Math.max(1, Math.min(400, Number(params.get('maxMessages') ?? '80')))
        if (!Number.isFinite(throughSeq) || throughSeq <= 0) {
          // A page needs the log cut; the list row's projection cursor is the only
          // cold-safe source for it, so read one before asking for history.
          const list = await callRemote(host, config, 'session/list', { _request: {} })
          const row = (list?.items ?? []).find((item) => item?.sessionId === sessionId)
          const asOf = row?.projections?.asOfSeq
          if (typeof asOf === 'number' && asOf > 0) throughSeq = asOf
        }
        const address = { kind: 'session', sessionId }
        let value
        try {
          value = await callRemote(host, config, 'session/events', {
            request: { address, throughSeq, maxMessages },
          })
        } catch {
          // 0.2.1 Hosts answer 404 for the unknown endpoint; retry with its predecessor.
          value = await callRemote(host, config, 'session/page', {
            request: { address, throughSeq, maxMessages },
          })
        }
        send(req, res, 200, { ok: true, value })
      } catch (error) {
        fail(req, res, error, error?.notFound === true ? 404 : 502)
      }
    })()
  })

  route('/remote-dsh/rpc', ['POST'], (req, res) => {
    if (!authorized(req)) return send(req, res, 401, { ok: false, error: 'unauthorized' })
    void (async () => {
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        return send(req, res, 400, { ok: false, error: `bad request body: ${String(error?.message ?? error)}` })
      }
      if (typeof body?.endpoint !== 'string' || body.endpoint === '') {
        return send(req, res, 400, { ok: false, error: 'endpoint is required' })
      }
      try {
        const host = resolveHost(body.host)
        const value = await callRemote(host, config, body.endpoint, body.args ?? {})
        send(req, res, 200, { ok: true, value })
      } catch (error) {
        fail(req, res, error, error?.notFound === true ? 404 : 502)
      }
    })()
  })

  ctx.on('dispose', () => cookieCache.clear())
}

export { name, inject, apply }
