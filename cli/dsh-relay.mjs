#!/usr/bin/env node
/**
 * dsh-relay CLI — one file, two roles.
 *
 *   agent  : runs on the machine that has DSH; dials the relay and serves its local Host
 *   client : runs on the machine that views it; listens on 127.0.0.1 and dials the relay
 *
 * Both ends dial out, so neither machine needs an open port. The relay only shuttles
 * bytes, which keeps DSH's own token/cookie auth intact (including WebSocket upgrades).
 *
 *   node dsh-relay.mjs agent  --relay <relay>:19090 --secret S --device desk \
 *                             --local 127.0.0.1:52893 --fingerprint AA:BB:...
 *   node dsh-relay.mjs client --relay <relay>:19090 --device desk \
 *                             --listen 127.0.0.1:52900 --fingerprint AA:BB:...
 */
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
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
/** No frame for this long means the peer is gone even if the socket looks alive. */
const IDLE_TIMEOUT_MS = 65000
const HEARTBEAT_MS = 20000

/**
 * Keep the link honest: answer pings, ping when quiet, and tear the socket down once
 * nothing has arrived for a full idle window so the reconnect loop can take over.
 */
function heartbeat(socket, state, onDead) {
  const timer = setInterval(() => {
    if (socket.destroyed) return
    if (Date.now() - state.lastSeen > IDLE_TIMEOUT_MS) {
      log(`link idle for ${Math.round((Date.now() - state.lastSeen) / 1000)}s; reconnecting`)
      socket.destroy()
      onDead?.()
      return
    }
    if (!socket.destroyed) socket.write(encodeFrame(PING, 0))
  }, HEARTBEAT_MS)
  timer.unref?.()
  socket.on('close', () => clearInterval(timer))
  return () => clearInterval(timer)
}

const CONFIG_FILE = (() => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return `${home}/.dsh-relay/config.json`
})()

/**
 * Local role configuration. One file per machine: it remembers which side of the
 * tunnel this computer is (agent = the machine running DSH, client = the viewer), so
 * `start` needs no arguments and `config` can change the choice later.
 */
function loadConfig() {
  try {
    // Windows editors (and PowerShell's Set-Content) prepend a BOM; JSON.parse rejects
    // it, which used to make the whole config silently read as empty.
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/u, '')
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  fs.mkdirSync(CONFIG_FILE.slice(0, CONFIG_FILE.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

/** Parse only `--key value` pairs (no positional role), for config/setup subcommands. */
function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (key === 'insecure') {
      out.insecure = true
      i -= 1
      continue
    }
    out[key] = argv[i + 1]
  }
  return out
}

/** Merge CLI flags over the stored config: flags win, config fills the gaps. */
function resolveOptions(argv) {
  const flags = parseArgs(argv)
  // argv[0] is the subcommand (`start`, `setup`, …), not a role.
  if (flags.role !== 'agent' && flags.role !== 'client') flags.role = ''
  const stored = loadConfig()
  const merged = { ...flags }
  for (const key of ['role', 'relay', 'device', 'local', 'listen', 'fingerprint', 'token', 'secret', 'hostId', 'cookieDb', 'endpointFile']) {
    if (merged[key] === undefined || merged[key] === '' || merged[key] === null) {
      if (stored[key] !== undefined) merged[key] = stored[key]
    }
  }
  if (stored.insecure === true && merged.insecure !== true) merged.insecure = true
  // Defaults apply last, so the config file can override them.
  if (merged.device === '') merged.device = 'default'
  if (merged.local === '') merged.local = 'auto'
  if (merged.listen === '') merged.listen = '127.0.0.1:52900'
  return merged
}

function parseArgs(argv) {
  const out = {
    role: argv[0],
    relay: '',
    secret: '',
    device: '',
    local: '',
    listen: '',
    fingerprint: '',
    insecure: false,
    tokenFile: '',
    config: '',
    hostId: '',
    cookieDb: '',
    endpointFile: '',
    token: '',
    user: '',
    password: '',
  }
  for (let i = 1; i < argv.length; i += 2) {
    // --token-file → tokenFile, --host-id → hostId
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const value = argv[i + 1]
    if (key === 'insecure') {
      out.insecure = true
      i -= 1
      continue
    }
    if (key in out) out[key] = value
  }
  return out
}

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(streamId >>> 0, 1)
  head.writeUInt32BE(payload.length, 5)
  return Buffer.concat([head, payload])
}

class FrameReader {
  constructor(socket, onFrame) {
    this.onFrame = onFrame
    this.buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this.push(chunk))
  }
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 9) return
      const type = this.buffer.readUInt8(0)
      const streamId = this.buffer.readUInt32BE(1)
      const length = this.buffer.readUInt32BE(5)
      if (length > MAX_FRAME) throw new Error('frame too large')
      if (this.buffer.length < 9 + length) return
      const payload = this.buffer.subarray(9, 9 + length)
      this.buffer = this.buffer.subarray(9 + length)
      this.onFrame(type, streamId, payload)
    }
  }
}

function normalizeFingerprint(value) {
  return value.replace(/:/g, '').toUpperCase()
}

function relayHttp(options, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const [host, portText] = options.relay.split(':')
    const port = Number(portText)
    if (!host || !Number.isFinite(port)) return reject(new Error('--relay 需要 host:port'))
    const servername = net.isIP(host) === 0 ? { servername: host } : {}
    const socket = tls.connect({ host, port, ...servername, rejectUnauthorized: false })
    const payload = body === undefined ? '' : JSON.stringify(body)
    let received = ''
    const fail = (error) => reject(error)
    socket.once('error', fail)
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate()
      const actual = peer?.fingerprint256 ?? ''
      if (!options.insecure && options.fingerprint !== '' && normalizeFingerprint(actual) !== normalizeFingerprint(options.fingerprint)) {
        socket.destroy()
        reject(new Error(`relay 证书指纹不匹配\n  expected ${options.fingerprint}\n  actual   ${actual}`))
        return
      }
      const headers = [
        `${method} ${pathname} HTTP/1.1`,
        'host: relay',
        'connection: close',
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(payload)}`,
        ...(options.token === '' ? [] : [`authorization: Bearer ${options.token}`]),
        ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
        '',
        payload,
      ].join('\r\n')
      socket.write(headers)
    })
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
    })
    socket.on('close', () => {
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) return reject(new Error('relay 没有返回响应'))
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1] ?? 0)
      const text = received.slice(end + 4)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return reject(new Error(`relay 返回了非 JSON 响应（HTTP ${status}）：${text.slice(0, 120)}`))
      }
      resolve({ status, ...parsed })
    })
  })
}

/** Read a password without echoing it; falls back to a pipe for scripts. */
function readPassword(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      let data = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        data += chunk
      })
      process.stdin.on('end', () => resolve(data.split('\n')[0] ?? ''))
      return
    }
    process.stdout.write(promptText)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const finish = (error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      error === undefined ? resolve(value) : reject(error)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u0003') return finish(new Error('已取消'))
        if (char === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

function dialRelay(options, hello) {
  return new Promise((resolve, reject) => {
    const [host, portText] = options.relay.split(':')
    const port = Number(portText)
    if (!host || !Number.isFinite(port)) return reject(new Error('--relay must be host:port'))
    // SNI must not carry an IP literal; the certificate is pinned by fingerprint anyway.
    const servername = net.isIP(host) === 0 ? { servername: host } : {}
    const socket = tls.connect({ host, port, ...servername, rejectUnauthorized: false })
    socket.setNoDelay(true)
    // A dead peer that never sends FIN leaves the tunnel half-open forever; keepalive
    // turns that into a socket error the reconnect loop can act on.
    socket.setKeepAlive(true, 15000)
    const fail = (error) => reject(error)
    socket.once('error', fail)
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate()
      const actual = peer?.fingerprint256 ?? ''
      if (!options.insecure && options.fingerprint !== '') {
        if (normalizeFingerprint(actual) !== normalizeFingerprint(options.fingerprint)) {
          socket.destroy()
          reject(new Error(`relay certificate mismatch\n  expected ${options.fingerprint}\n  actual   ${actual}`))
          return
        }
      }
      socket.off('error', fail)
      socket.on('error', () => {})
      socket.write(encodeFrame(HELLO, 0, Buffer.from(JSON.stringify(hello), 'utf8')))
      resolve(socket)
    })
  })
}

/** Default cookie store per platform. */
function defaultCookieDb() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? `${home}\\AppData\\Roaming`
    return `${appData}\\@deepseek-ai\\dsh-desktop\\Cookies`
  }
  if (process.platform === 'darwin') {
    return `${home}/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`
  }
  return `${home}/.config/@deepseek-ai/dsh-desktop/Cookies`
}

/**
 * Scan the Chromium cookie store for a signed session cookie of the given authority.
 * The SQLite rows keep the value in plaintext, so a byte scan plus payload decode is
 * enough — no SQLite driver on the machine is required.
 */
/**
 * Resolve the desktop app's current Host port from its cookie store.
 *
 * The Electron app picks a fresh port on every launch, so a hard-coded `--local`
 * breaks after each restart. The cookie payload names the authority it was minted for,
 * and the newest one is the port the app is listening on right now.
 */
function latestAuthorityFromCookieDb(dbPath) {
  let raw
  try {
    raw = fs.readFileSync(dbPath)
  } catch {
    return undefined
  }
  const text = raw.toString('latin1')
  let best
  for (const match of text.matchAll(/v[0-9]\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g)) {
    const parts = match[0].split('.')
    let payload
    try {
      const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
      payload = JSON.parse(Buffer.from(padded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    } catch {
      continue
    }
    if (typeof payload?.authority !== 'string' || !payload.authority.startsWith('127.0.0.1:')) continue
    if (typeof payload.expiresAt === 'number' && payload.expiresAt < Date.now()) continue
    if (best === undefined || (payload.issuedAt ?? 0) > best.issuedAt) {
      best = { authority: payload.authority, issuedAt: payload.issuedAt ?? 0 }
    }
  }
  return best?.authority
}

/** `auto` means: follow the desktop app's port. */
function resolveLocalTarget(options) {
  if (options.local !== 'auto' && options.local !== '') return options.local
  // A maintained endpoint file wins: on Windows the Electron cookie DB is held with an
  // exclusive handle, so the DB path is often unreadable even for the same user.
  if (options.endpointFile !== '') {
    try {
      const parsed = JSON.parse(fs.readFileSync(options.endpointFile, 'utf8'))
      if (typeof parsed?.authority === 'string' && parsed.authority !== '') return parsed.authority
    } catch {
      // fall through to the cookie store
    }
  }
  const dbPath = options.cookieDb !== '' ? options.cookieDb : defaultCookieDb()
  const discovered = latestAuthorityFromCookieDb(dbPath)
  if (discovered === undefined) {
    if (options.local !== '') warnOnce(`读不到 DSH 端口：${dbPath} 不可读，且没有可用的 --endpoint-file`)
    return undefined
  }
  return discovered
}

let warned = new Set()
function warnOnce(message) {
  if (warned.has(message)) return
  warned.add(message)
  log(message)
}

function findAuthorityCookie(dbPath, authority) {
  let raw
  try {
    raw = fs.readFileSync(dbPath)
  } catch {
    return undefined
  }
  const text = raw.toString('latin1')
  let best
  const pattern = /v[0-9]\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const parts = value.split('.')
    let payload
    try {
      const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
      payload = JSON.parse(Buffer.from(padded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    } catch {
      continue
    }
    if (payload?.authority !== authority) continue
    if (typeof payload.expiresAt === 'number' && payload.expiresAt < Date.now()) continue
    if (best === undefined || (payload.expiresAt ?? 0) > best.expiresAt) {
      best = { value, expiresAt: payload.expiresAt ?? 0 }
    }
  }
  if (best === undefined) return undefined
  const name = `dsh-auth-${crypto.createHash('sha256').update(authority).digest('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
  return `${name}=${best.value}`
}

function serveAgent(options) {
  let localHost = ''
  let localPort = 0
  const streams = new Map()
  let connecting = false

  // The desktop app changes port on every launch, so `auto` re-resolves before each
  // reconnect and streams always target the port the app is listening on now.
  const refreshLocal = () => {
    const target = resolveLocalTarget(options)
    if (target === undefined) return false
    if (target !== options.local) log(`DSH 端口: ${options.local} → ${target}`)
    options.local = target
    const [host, portText] = target.split(':')
    localHost = host
    localPort = Number(portText)
    return Number.isFinite(localPort) && localPort > 0
  }

  setInterval(() => {
    if (!refreshLocal()) return
  }, 10000)

  const connect = async () => {
    if (connecting) return
    connecting = true
    try {
      if (!refreshLocal()) {
        log('找不到 DSH 端口：桌面版没在跑，或 cookie 库里没有有效凭据')
        connecting = false
        setTimeout(connect, 5000)
        return
      }
      const socket = await dialRelay(options, {
        role: 'agent',
        device: options.device,
        pong: true,
        ...(options.token === '' ? { secret: options.secret } : { token: options.token }),
      })
      log(`agent connected to ${options.relay} as "${options.device}" → ${options.local}`)

      // The Host mints a fresh token per process. Republishing it means a remote
      // restart does not need a human to carry the new token across.
      let published = ''
      const publish = () => {
        if (options.tokenFile === '') return
        let text
        try {
          text = fs.readFileSync(options.tokenFile, 'utf8')
        } catch {
          return
        }
        const matches = [...text.matchAll(/token=([A-Za-z0-9_-]{20,})/g)]
        const token = matches.at(-1)?.[1]
        if (token === undefined || token === published) return
        published = token
        // Envelope carries the Host's own authority so the viewer can address it.
        const envelope = JSON.stringify({ token, authority: options.local })
        if (!socket.destroyed) socket.write(encodeFrame(TOKEN, 0, Buffer.from(envelope, 'utf8')))
        log(`published Host token (${token.slice(0, 8)}…, ${token.length} chars)`)
      }
      publish()
      // The desktop app mints no token, but it stores its browser cookie in a
      // plaintext SQLite file. Reading it here means the viewer never has to copy
      // a credential by hand.
      // Preferred: a file the remote keeps fresh (some OSes lock the cookie DB).
      // Payload contract: {"authority":"127.0.0.1:PORT","cookie":"dsh-auth-...=v1..."}
      const readEndpointFile = () => {
        if (options.endpointFile === '') return undefined
        let text
        try {
          text = fs.readFileSync(options.endpointFile, 'utf8')
        } catch {
          return undefined
        }
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed?.cookie === 'string' && typeof parsed?.authority === 'string') {
            return JSON.stringify({ authority: parsed.authority, cookie: parsed.cookie })
          }
        } catch {
          return undefined
        }
        return undefined
      }
      const cookieDb = options.endpointFile !== '' ? '' : (options.cookieDb !== '' ? options.cookieDb : defaultCookieDb())
      let publishedCookie = ''
      const publishCookie = () => {
        const fromFile = readEndpointFile()
        if (fromFile !== undefined) {
          if (fromFile === publishedCookie) return
          publishedCookie = fromFile
          if (!socket.destroyed) socket.write(encodeFrame(COOKIE, 0, Buffer.from(fromFile, 'utf8')))
          log(`published endpoint from file (${JSON.parse(fromFile).authority})`)
          return
        }
        if (cookieDb === '') return
        const found = findAuthorityCookie(cookieDb, options.local)
        if (found === undefined) return
        // Compare the envelope, not the raw value: mixing the two made this republish
        // identical payloads on every tick.
        const envelope = JSON.stringify({ authority: options.local, cookie: found })
        if (envelope === publishedCookie) return
        publishedCookie = envelope
        if (!socket.destroyed) socket.write(encodeFrame(COOKIE, 0, Buffer.from(envelope, 'utf8')))
        log(`published cookie for ${options.local} (${found.length} chars)`)
      }
      publishCookie()
      if (cookieDb !== '' || options.endpointFile !== '') {
        const timer = setInterval(publishCookie, 5000)
        socket.on('close', () => clearInterval(timer))
      }
      if (options.tokenFile !== '') {
        const timer = setInterval(publish, 5000)
        socket.on('close', () => clearInterval(timer))
      }
      const linkState = { lastSeen: Date.now() }
      heartbeat(socket, linkState)
      const reader = new FrameReader(socket, (type, streamId, payload) => {
        linkState.lastSeen = Date.now()
        if (type === PING) {
          if (!socket.destroyed) socket.write(encodeFrame(PONG, 0))
          return
        }
        if (type === PONG) return
        if (type === OPEN) {
          const upstream = net.connect({ host: localHost, port: localPort })
          upstream.setNoDelay(true)
          const entry = { upstream }
          streams.set(streamId, entry)
          upstream.on('connect', () => {
            if (payload.length > 0) upstream.write(payload)
          })
          // Coalesce reads into larger frames: one TLS record per 9-byte-framed read
          // otherwise costs ~3x throughput on the wire.
          let pending = []
          let pendingBytes = 0
          let flushScheduled = false
          const flush = () => {
            flushScheduled = false
            if (pendingBytes === 0) return
            const merged = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
            pending = []
            pendingBytes = 0
            if (socket.destroyed) return
            if (socket.write(encodeFrame(DATA, streamId, merged)) === false) {
              // Backpressure: stop reading the local Host until the relay drains.
              upstream.pause()
              socket.once('drain', () => upstream.resume())
            }
          }
          upstream.on('data', (chunk) => {
            pending.push(chunk)
            pendingBytes += chunk.length
            if (pendingBytes >= 64 * 1024) flush()
            else if (!flushScheduled) {
              flushScheduled = true
              setImmediate(flush)
            }
          })
          upstream.on('end', flush)
          upstream.on('close', () => {
            streams.delete(streamId)
            if (!socket.destroyed) socket.write(encodeFrame(CLOSE, streamId))
          })
          upstream.on('error', () => {
            if (!socket.destroyed) socket.write(encodeFrame(CLOSE, streamId))
          })
          return
        }
        const entry = streams.get(streamId)
        if (entry === undefined) return
        if (type === DATA) entry.upstream.write(payload)
        else if (type === CLOSE) {
          streams.delete(streamId)
          entry.upstream.end()
        }
      })
      socket.on('close', () => {
        for (const [, entry] of streams) entry.upstream.destroy()
        streams.clear()
        log('agent link dropped; reconnecting')
        setTimeout(connect, 3000)
      })
      void reader
    } catch (error) {
      log(`agent connect failed: ${error.message}`)
      setTimeout(connect, 5000)
    } finally {
      connecting = false
    }
  }

  void connect()
}

function applyToken(payload) {
  if (options.config === '') return
  try {
    let token = payload
    let authorityOverride
    if (payload.startsWith('{')) {
      const envelope = JSON.parse(payload)
      token = envelope.token
      authorityOverride = envelope.authority
    }
    const raw = fs.readFileSync(options.config, 'utf8')
    const parsed = JSON.parse(raw)
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : []
    const hostId = options.hostId === '' ? options.device : options.hostId
    let host = hosts.find((item) => item.id === hostId)
    if (host === undefined) {
      // A plugin-managed tunnel has no hand-written host entry yet; the one this tunnel
      // implies is enough to start reading the remote Host.
      host = { id: hostId, label: hostId, baseUrl: `http://${options.listen}` }
      hosts.push(host)
      log(`created host "${hostId}" → ${host.baseUrl}`)
    }
    if (typeof authorityOverride === 'string') host.authority = authorityOverride
    if (host.token === token) return
    host.token = token
    fs.writeFileSync(options.config, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    log(`updated token for "${hostId}" in ${options.config} (${token.length} chars)`)
  } catch (error) {
    log(`cannot update ${options.config}: ${error.message}`)
  }
}

function applyCookie(payload) {
  if (options.config === '') return
  try {
    let cookie = payload
    let authorityOverride
    if (payload.startsWith('{')) {
      const envelope = JSON.parse(payload)
      cookie = envelope.cookie
      authorityOverride = envelope.authority
    }
    const raw = fs.readFileSync(options.config, 'utf8')
    const parsed = JSON.parse(raw)
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : []
    const hostId = options.hostId === '' ? options.device : options.hostId
    let host = hosts.find((item) => item.id === hostId)
    if (host === undefined) {
      // A plugin-managed tunnel has no hand-written host entry: create the one this
      // tunnel implies, pointing at its own listener.
      host = { id: hostId, label: hostId, baseUrl: `http://${options.listen}` }
      hosts.push(host)
      log(`created host "${hostId}" → ${host.baseUrl}`)
    }
    if (host.cookie === cookie) return
    // The cookie is bound to the Host's own authority, which is not the tunnel port.
    const value = cookie.slice(cookie.indexOf('=') + 1)
    const parts = value.split('.')
    const padded = (parts[1] ?? '') + '='.repeat((4 - ((parts[1] ?? '').length % 4)) % 4)
    const decoded = JSON.parse(Buffer.from(padded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    host.cookie = cookie
    const authority = typeof authorityOverride === 'string' ? authorityOverride : decoded.authority
    if (typeof authority === 'string') host.authority = authority
    delete host.token
    fs.writeFileSync(options.config, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    log(`updated cookie for "${hostId}" (${cookie.length} chars)`)
  } catch (error) {
    log(`cannot update ${options.config}: ${error.message}`)
  }
}

function serveClient(options) {
  const streams = new Map()
  let control
  let nextId = 1

  const attach = async () => {
    try {
      const clientLink = { lastSeen: Date.now() }
      control = await dialRelay(options, {
        role: 'client',
        pong: true,
        device: options.device,
        ...(options.token === '' ? {} : { token: options.token }),
        ...(options.token === '' ? { secret: options.secret } : {}),
      })
      log(`client attached to ${options.relay} for "${options.device}"`)
      clientLink.lastSeen = Date.now()
      heartbeat(control, clientLink)
      new FrameReader(control, (type, streamId, payload) => {
        clientLink.lastSeen = Date.now()
        if (type === TOKEN) {
          applyToken(payload.toString('utf8'))
          return
        }
        if (type === COOKIE) {
          applyCookie(payload.toString('utf8'))
          return
        }
        if (type === AGENT_OFFLINE) {
          log(`${options.device}: 上游 agent 掉线（等待重连）`)
          return
        }
        if (type === AGENT_ONLINE) {
          log(`${options.device}: 上游 agent 上线`)
          return
        }
        if (type === PING || type === PONG) return
        const entry = streams.get(streamId)
        if (entry === undefined) return
        if (type === DATA) {
          if (entry.local.write(payload) === false) {
            socket.pause()
            entry.local.once('drain', () => socket.resume())
          }
        }
        else if (type === CLOSE) {
          streams.delete(streamId)
          entry.local.end()
        }
      })
      control.on('close', () => {
        log('client link dropped; reconnecting')
        for (const [, entry] of streams) entry.local.destroy()
        streams.clear()
        control = undefined
        setTimeout(attach, 3000)
      })
    } catch (error) {
      log(`client connect failed: ${error.message}`)
      setTimeout(attach, 5000)
    }
  }

  const [listenHost, listenPortText] = options.listen.split(':')
  net
    .createServer((local) => {
      local.setNoDelay(true)
      if (control === undefined || control.destroyed) {
        local.destroy()
        return
      }
      const streamId = nextId++
      streams.set(streamId, { local })
      control.write(encodeFrame(OPEN, streamId))
      local.on('data', (chunk) => {
        if (control.destroyed) return
        if (control.write(encodeFrame(DATA, streamId, chunk)) === false) {
          local.pause()
          control.once('drain', () => local.resume())
        }
      })
      local.on('close', () => {
        streams.delete(streamId)
        if (control !== undefined && !control.destroyed) control.write(encodeFrame(CLOSE, streamId))
      })
      local.on('error', () => {})
    })
    .listen(Number(listenPortText), listenHost, () => {
      log(`listening on ${options.listen} → relay ${options.relay} (device "${options.device}")`)
      void attach()
    })
}

function usage() {
  console.error(`dsh-relay — 远端 DSH 隧道

账号（个人账号，两端登录同一个账号即可互连）：
  dsh-relay register --relay HOST:PORT --user alice [--fingerprint FP]
  dsh-relay login    --relay HOST:PORT --user alice [--fingerprint FP]
  dsh-relay logout
  dsh-relay devices
  dsh-relay release --device NAME --secret <relay 密钥>   # 解绑被占用的设备名
  dsh-relay user remove --user NAME --secret <relay 密钥>  # 删除账号（连带释放其设备）
  dsh-relay revoke --user NAME --secret <relay 密钥>       # 吊销该账号全部 token

本机角色（登录后设置，之后可随时改）：
  dsh-relay setup                     交互选择「远端端」还是「本地端」
  dsh-relay setup --role agent --device desk --local 127.0.0.1:52893
  dsh-relay setup --role client --device desk --listen 127.0.0.1:52900
  dsh-relay config                    查看当前配置
  dsh-relay config --role client      只改角色
  dsh-relay start                     按配置启动（agent 或 client）

兼容旧用法（共享密钥，无账号）：
  dsh-relay agent --relay HOST:PORT --secret S --device NAME --local H:P
  dsh-relay client --relay HOST:PORT --secret S --device NAME --listen H:P`)
}

async function cmdRegister(options) {
  if (options.relay === '') return usage()
  const username = options.user ?? ''
  if (username === '') return console.error('register: 需要 --user')
  const password = options.password ?? (await readPassword(`为 ${username} 设置密码（至少 8 位）：`))
  if (options.password === undefined) {
    const repeated = await readPassword('再输一次：')
    if (repeated !== password) return console.error('两次输入不一致')
  }
  const answer = await relayHttp(options, 'POST', '/v1/register', { username, password })
  if (answer.ok !== true) return console.error(`注册失败：${answer.error ?? `HTTP ${answer.status}`}`)
  // Only touch the pinning when one was supplied: writing '' here silently dropped the
  // stored fingerprint on every login/register.
  saveConfig({
    relay: options.relay,
    ...(options.fingerprint === '' ? {} : { fingerprint: options.fingerprint }),
    token: answer.token,
    username: answer.username,
  })
  console.log(`已注册并登录：${answer.username}`)
  console.log(`凭据保存在 ${CONFIG_FILE}（0600）`)
  console.log('下一步：dsh-relay setup  选择这台机器是「远端端」还是「本地端」')
}

async function cmdLogin(options) {
  if (options.relay === '') return usage()
  const username = options.user ?? ''
  if (username === '') return console.error('login: 需要 --user')
  const password = options.password ?? (await readPassword(`请输入 ${username} 的密码：`))
  const answer = await relayHttp(options, 'POST', '/v1/login', { username, password })
  if (answer.ok !== true) return console.error(`登录失败：${answer.error ?? `HTTP ${answer.status}`}`)
  // Only touch the pinning when one was supplied: writing '' here silently dropped the
  // stored fingerprint on every login/register.
  saveConfig({
    relay: options.relay,
    ...(options.fingerprint === '' ? {} : { fingerprint: options.fingerprint }),
    token: answer.token,
    username: answer.username,
  })
  console.log(`已登录：${answer.username}`)
  console.log('下一步：dsh-relay setup  选择这台机器是「远端端」还是「本地端」')
}

function cmdLogout() {
  const config = loadConfig()
  delete config.token
  delete config.username
  saveConfig(config)
  console.log('已退出登录（配置里的角色与端口保留）')
}

async function cmdRelease(options) {
  if (options.device === '') return console.error('release: 需要 --device')
  if (options.secret === '') return console.error('release: 需要 --secret（relay 的共享密钥，见 relay/DEPLOYED.md）')
  const answer = await relayHttp(
    { ...options, token: '' },
    'POST',
    '/v1/admin/release',
    { device: options.device, ...(options.user === '' ? {} : { username: options.user }) },
    { 'x-relay-secret': options.secret },
  )
  if (answer.ok !== true) return console.error(`释放失败：${answer.error ?? `HTTP ${answer.status}`}`)
  console.log(answer.released === true ? `已解绑设备 ${options.device}` : `设备 ${options.device} 本来就没有绑定`)
}

async function cmdRevoke(options) {
  if (options.user === '') return console.error('revoke: 需要 --user')
  if (options.secret === '') return console.error('revoke: 需要 --secret（relay 的共享密钥）')
  const answer = await relayHttp(
    { ...options, token: '' },
    'POST',
    '/v1/admin/revoke',
    { username: options.user },
    { 'x-relay-secret': options.secret },
  )
  if (answer.ok !== true) return console.error(`吊销失败：${answer.error ?? `HTTP ${answer.status}`}`)
  console.log(`已吊销 ${options.user} 的所有 token（新版本 ${answer.tokenVersion}），该账号需要重新登录`)
}

async function cmdUserRemove(options) {
  if (options.user === '') return console.error('user remove: 需要 --user')
  if (options.secret === '') return console.error('user remove: 需要 --secret（relay 的共享密钥）')
  const answer = await relayHttp(
    { ...options, token: '' },
    'POST',
    '/v1/admin/user-remove',
    { username: options.user },
    { 'x-relay-secret': options.secret },
  )
  if (answer.ok !== true) return console.error(`删除失败：${answer.error ?? `HTTP ${answer.status}`}`)
  if (answer.removed !== true) return console.error(`账号 ${options.user} 不存在`)
  console.log(`已删除账号 ${options.user}` + (answer.devices.length === 0 ? '' : `，同时释放设备：${answer.devices.join(', ')}`))
}

async function cmdDevices(options) {
  const answer = await relayHttp(options, 'GET', '/v1/devices')
  if (answer.ok !== true) return console.error(`查询失败：${answer.error ?? `HTTP ${answer.status}`}`)
  console.log(`账号 ${answer.username} 的设备：`)
  if (answer.devices.length === 0) console.log('  （还没有设备连接过）')
  for (const item of answer.devices) console.log(`  ${item.device}   绑定于 ${item.claimedAt}`)
}

function cmdConfig(argv) {
  const flags = parseFlags(argv)
  const patch = {}
  for (const key of ['role', 'relay', 'device', 'local', 'listen', 'fingerprint', 'user', 'token']) {
    if (flags[key] !== undefined && flags[key] !== '') patch[key] = flags[key]
  }
  if (patch.role !== undefined && patch.role !== 'agent' && patch.role !== 'client') {
    return console.error('role 只能是 agent（远端端）或 client（本地端）')
  }
  if (Object.keys(patch).length === 0) {
    const config = loadConfig()
    const shown = { ...config }
    if (shown.token !== undefined) shown.token = `${shown.token.slice(0, 12)}…（已保存）`
    console.log(JSON.stringify(shown, null, 2))
    return
  }
  saveConfig(patch)
  console.log('已更新：', JSON.stringify(patch))
}

async function cmdSetup(argv) {
  const flags = parseFlags(argv)
  const current = loadConfig()
  const ask = async (question, fallback) => {
    if (!process.stdin.isTTY) return fallback
    const answer = await new Promise((resolve) => {
      process.stdout.write(question)
      process.stdin.setEncoding('utf8')
      process.stdin.once('data', (chunk) => resolve(String(chunk).trim()))
      process.stdin.resume()
    })
    return answer === '' ? fallback : answer
  }

  let role = flags.role !== undefined && flags.role !== '' ? flags.role : current.role
  if (role !== 'agent' && role !== 'client') {
    const answer = await ask('这台机器是？  1) 远端端（跑 DSH 的机器）  2) 本地端（看的那台） [1/2]：', '1')
    role = answer === '2' || answer.toLowerCase() === 'client' ? 'client' : 'agent'
  }

  const device = flags.device ?? (await ask(`设备名 [${current.device ?? 'default'}]：`, current.device ?? 'default'))
  const patch = { role, device }
  // These were dropped before, so `start` silently fell back to the locked cookie DB.
  if (flags.cookieDb !== undefined && flags.cookieDb !== '') patch.cookieDb = flags.cookieDb
  if (flags.endpointFile !== undefined && flags.endpointFile !== '') patch.endpointFile = flags.endpointFile
  if (role === 'agent') {
    patch.local = flags.local ?? (await ask(`远端 DSH 地址（auto = 自动跟随桌面版端口）[${current.local ?? 'auto'}]：`, current.local ?? 'auto'))
  } else {
    patch.listen = flags.listen ?? (await ask(`本机监听地址 [${current.listen ?? '127.0.0.1:52900'}]：`, current.listen ?? '127.0.0.1:52900'))
  }
  saveConfig(patch)
  console.log(`已设置：${role === 'agent' ? '远端端' : '本地端'}  device=${device}`)
  console.log(`配置：${CONFIG_FILE}`)
  if (role === 'agent' && loadConfig().cookieDb === undefined) {
    console.log('提示：远端跑桌面版时用 --cookie-db 指定 cookie 库，CLI 会自动读取并推给本地端')
  }
  console.log('启动：dsh-relay start')
}

async function cmdStart(options) {
  const config = loadConfig()
  if (config.token === undefined && config.secret === undefined) {
    return console.error('还没有登录：先 dsh-relay login 或 dsh-relay register')
  }
  if (options.role !== 'agent' && options.role !== 'client') {
    return console.error('还没有设置角色：先 dsh-relay setup')
  }
  if (options.relay === '') return console.error('还没有配置 relay 地址：dsh-relay config --relay HOST:PORT')
  console.log(`以${options.role === 'agent' ? '远端端' : '本地端'}启动（device=${options.device}）`)
  if (options.role === 'agent') serveAgent(options)
  else serveClient(options)
}

const argv = process.argv.slice(2)
const command = argv[0]
const options = resolveOptions(argv)

if (command === 'register') {
  await cmdRegister(options)
} else if (command === 'login') {
  await cmdLogin(options)
} else if (command === 'logout') {
  cmdLogout()
} else if (command === 'devices') {
  await cmdDevices(options)
} else if (command === 'release') {
  await cmdRelease(options)
} else if (command === 'revoke') {
  await cmdRevoke(options)
} else if (command === 'user') {
  // `user remove ...`: the subcommand word must not eat the first flag pair.
  if (argv[1] === 'remove') await cmdUserRemove(resolveOptions(['user', ...argv.slice(2)]))
  else console.error('用法: dsh-relay user remove --user NAME --secret <relay 密钥>')
} else if (command === 'config') {
  cmdConfig(argv.slice(1))
} else if (command === 'setup') {
  await cmdSetup(argv.slice(1))
} else if (command === 'start') {
  await cmdStart(options)
} else if (command === 'agent') {
  if (options.secret === '' && options.token === '') {
    console.error('agent: 需要 --secret（旧模式）或先 dsh-relay login（账号模式）')
    process.exit(1)
  }
  serveAgent(options)
} else if (command === 'client') {
  if (options.secret === '' && options.token === '') {
    console.error('client: 需要 --secret（旧模式）或先 dsh-relay login（账号模式）')
    process.exit(1)
  }
  serveClient(options)
} else {
  usage()
  process.exit(1)
}
