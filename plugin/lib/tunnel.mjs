/**
 * Tunnel supervisor for the settings page.
 *
 * One DSH instance can hold several tunnels at once: the "primary" one follows the role
 * chosen for this machine, and each extra tunnel is a client that exposes another remote
 * device on its own local port. That is what makes "watch three machines from one laptop"
 * possible without a second DSH install.
 *
 * The tunnel itself lives in `dsh-relay.mjs` (the same engine the CLI runs), so the GUI
 * and the CLI can never drift: this module only writes `~/.dsh-relay/config.json`,
 * spawns engines, and reports what they said.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RELAY, DEFAULT_FINGERPRINT } from './defaults.mjs'

const ENGINE = fileURLToPath(new URL('./dsh-relay.mjs', import.meta.url))
const CONFIG_FILE = path.join(os.homedir(), '.dsh-relay', 'config.json')
const PID_FILE = path.join(os.homedir(), '.dsh-relay', 'pids.json')
const LOG_LIMIT = 40

/** @returns the stored config with the public relay filled in, so a fresh install can
 * register and connect without the user typing an address. */
export function readRelayConfig() {
  let stored = {}
  try {
    // PowerShell / 记事本 写出的文件可能带 BOM。
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    stored = {}
  }
  return {
    relay: DEFAULT_RELAY,
    fingerprint: DEFAULT_FINGERPRINT,
    ...stored,
    ...(typeof stored.relay === 'string' && stored.relay !== '' ? {} : { relay: DEFAULT_RELAY }),
  }
}

export function writeRelayConfig(patch) {
  const next = { ...readRelayConfig(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

function normalizeFingerprint(value) {
  return String(value ?? '').replaceAll(':', '').toUpperCase()
}

/** One-shot HTTPS JSON call to the relay, tolerating its self-signed certificate. */
export function relayRequest(config, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const [host, portText] = String(config.relay ?? '').split(':')
    const port = Number(portText)
    if (host === undefined || host === '' || !Number.isFinite(port)) {
      return reject(new Error('还没有填写中转地址（形如 1.2.3.4:19090）'))
    }
    const servername = net.isIP(host) === 0 ? { servername: host } : {}
    const socket = tls.connect({ host, port, ...servername, rejectUnauthorized: false })
    const payload = body === undefined ? '' : JSON.stringify(body)
    let received = ''
    socket.setTimeout(15000, () => {
      socket.destroy()
      reject(new Error('中转没有响应（15s 超时）'))
    })
    socket.once('error', (error) => reject(error))
    socket.once('secureConnect', () => {
      const actual = socket.getPeerCertificate()?.fingerprint256 ?? ''
      const expected = String(config.fingerprint ?? '')
      if (expected !== '' && normalizeFingerprint(actual) !== normalizeFingerprint(expected)) {
        socket.destroy()
        reject(new Error(`证书指纹不匹配\n  期望 ${expected}\n  实际 ${actual}`))
        return
      }
      socket.write(
        [
          `${method} ${pathname} HTTP/1.1`,
          'host: relay',
          'connection: close',
          'content-type: application/json',
          `content-length: ${Buffer.byteLength(payload)}`,
          ...(typeof config.token === 'string' && config.token !== '' ? [`authorization: Bearer ${config.token}`] : []),
          ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
          '',
          payload,
        ].join('\r\n'),
      )
    })
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
    })
    socket.on('close', () => {
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) return reject(new Error('中转没有返回响应'))
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1] ?? 0)
      const text = received.slice(end + 4)
      try {
        resolve({ status, ...JSON.parse(text) })
      } catch {
        reject(new Error(`中转返回了非 JSON（HTTP ${status}）：${text.slice(0, 120)}`))
      }
    })
  })
}

/** @returns a locally free TCP port starting at `from`. */
export async function findFreePort(from = 52901) {
  for (let port = from; port < from + 200; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('找不到空闲端口')
}

/**
 * A previous DSH instance can leave its engine running on the tunnel port: the host dies,
 * the child does not, and the pid record is gone. Starting a new engine then fails with
 * EADDRINUSE while the panel still says "not running". Find that listener and reap it —
 * but only when its command line is our own engine.
 */
function findListenerPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        if (!line.includes(`:${port} `) || !line.includes('LISTENING')) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts.at(-1))
        if (Number.isFinite(pid) && pid > 0) return pid
      }
      return undefined
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    const pid = Number(out.trim().split('\n')[0])
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function commandOf(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'], { encoding: 'utf8' })
      return out
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

/** @returns whether a stale engine was reaped, so the caller can report it. */
function reapStaleEngine(port) {
  const pid = findListenerPid(port)
  if (pid === undefined || pid === process.pid) return false
  const command = commandOf(pid)
  if (!command.includes('dsh-relay.mjs')) return false
  killPid(pid)
  return true
}

function readPids() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writePids(map) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
    fs.writeFileSync(PID_FILE, JSON.stringify(map), { mode: 0o600 })
  } catch {
    // 记录失败不影响主流程
  }
}

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
  }, 3000).unref?.()
}

export class TunnelSupervisor {
  #tunnels = new Map() // id → { child, device, listen, log }
  #agentOnline = true
  #offlineSince

  /** Last lines of one tunnel (default: the primary one). */
  logOf(id = 'primary') {
    return [...(this.#tunnels.get(id)?.log ?? [])]
  }

  get log() {
    return this.logOf('primary')
  }

  get running() {
    const primary = this.#tunnels.get('primary')
    if (primary !== undefined && primary.child !== undefined && primary.child.exitCode === null) return true
    // A plugin reload leaves the previous engine running; the pidfile is the record.
    const pid = readPids().primary
    return alive(pid)
  }

  #push(id, text) {
    const tunnel = this.#tunnels.get(id)
    if (tunnel === undefined) return
    for (const raw of String(text).split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      tunnel.log.push(line)
      if (line.includes('上游 agent 上线')) {
        this.#agentOnline = true
        this.#offlineSince = undefined
      } else if (line.includes('上游 agent 掉线')) {
        this.#agentOnline = false
        this.#offlineSince = Date.now()
      }
    }
    if (tunnel.log.length > LOG_LIMIT) tunnel.log.splice(0, tunnel.log.length - LOG_LIMIT)
  }

  #spawn(id, device, listen, extraArgs, config) {
    if (!fs.existsSync(ENGINE)) throw new Error(`隧道引擎缺失：${ENGINE}`)
    const args = [ENGINE, 'start', ...extraArgs]
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    const tunnel = { child, device, listen, log: [], startedAt: Date.now() }
    this.#tunnels.set(id, tunnel)
    child.stdout.on('data', (chunk) => this.#push(id, chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => this.#push(id, chunk.toString('utf8')))
    child.on('exit', (code, signal) => {
      this.#push(id, `—— 隧道进程退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
      const pids = readPids()
      delete pids[id]
      writePids(pids)
      const current = this.#tunnels.get(id)
      if (current !== undefined && current.child === child) current.child = undefined
    })
    const pids = readPids()
    pids[id] = child.pid
    writePids(pids)
    return { ok: true, id, device, listen, pid: child.pid }
  }

  /** Start (or restart) the primary tunnel with the stored config. */
  async start({ config, engineArgs = [] } = {}) {
    const merged = config ?? readRelayConfig()
    if (merged.token === undefined && merged.secret === undefined) throw new Error('还没有登录，或没有配置共享密钥')
    if (merged.role !== 'agent' && merged.role !== 'client') throw new Error('还没有选择这台机器是远端端还是本地端')
    if (typeof merged.relay !== 'string' || merged.relay === '') throw new Error('还没有填写中转地址')

    const stale = readPids().primary
    if (alive(stale)) killPid(stale)
    const port = Number(String(merged.listen ?? '').split(':')[1])
    if (Number.isFinite(port) && reapStaleEngine(port)) {
      // 等端口释放，否则新进程还是 EADDRINUSE
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    const running = this.#tunnels.get('primary')
    if (running?.child !== undefined && running.child.exitCode === null) return { ok: true, already: true }

    return this.#spawn('primary', merged.role === 'agent' ? merged.device : merged.device, merged.listen, engineArgs, merged)
  }

  /**
   * Open one extra client tunnel for another device of the same account. Each extra
   * tunnel listens on its own port and writes its own host entry.
   */
  async startExtra({ device, listen, profileConfigPath }) {
    const config = readRelayConfig()
    if (config.role !== 'client') throw new Error('只有「本地端」才能同时查看多台设备')
    if (typeof config.token !== 'string' || config.token === '') throw new Error('还没有登录')
    const id = `device-${device}`
    const existing = this.#tunnels.get(id)
    if (existing?.child !== undefined && existing.child.exitCode === null) return { ok: true, already: true, id, listen: existing.listen }
    const port = listen ?? (await findFreePort())
    if (reapStaleEngine(port)) await new Promise((resolve) => setTimeout(resolve, 800))
    const extraArgs = [
      '--device', String(device),
      '--listen', `127.0.0.1:${port}`,
      ...(profileConfigPath === undefined ? [] : ['--config', profileConfigPath, '--host-id', String(device)]),
    ]
    return this.#spawn(id, device, `127.0.0.1:${port}`, extraArgs, config)
  }

  async stopExtra(id) {
    const tunnel = this.#tunnels.get(id)
    const pids = readPids()
    const pid = tunnel?.child?.pid ?? pids[id]
    if (alive(pid)) killPid(pid)
    delete pids[id]
    writePids(pids)
    this.#tunnels.delete(id)
    return { ok: true }
  }

  async stop() {
    const pids = readPids()
    const primaryPid = this.#tunnels.get('primary')?.child?.pid ?? pids.primary
    if (alive(primaryPid)) killPid(primaryPid)
    delete pids.primary
    writePids(pids)
    const primary = this.#tunnels.get('primary')
    if (primary !== undefined) primary.child = undefined
    return { ok: true }
  }

  async stopAll() {
    await this.stop()
    for (const id of [...this.#tunnels.keys()]) {
      if (id !== 'primary') await this.stopExtra(id)
    }
    return { ok: true }
  }

  /** Start the primary tunnel once per host process when the config asks for it. */
  startIfConfigured() {
    const config = readRelayConfig()
    if (config.autoStart !== true) return
    this.start({ config })
      .then(() => this.#push('primary', '—— 按配置自动启动'))
      .catch((error) => this.#push('primary', `—— 自动启动失败：${error.message}`))
  }

  status() {
    const config = readRelayConfig()
    const pids = readPids()
    const tunnels = [...this.#tunnels.entries()].map(([id, tunnel]) => ({
      id,
      device: tunnel.device,
      listen: tunnel.listen,
      running: (tunnel.child !== undefined && tunnel.child.exitCode === null) || alive(pids[id]),
    }))
    return {
      running: this.running,
      pid: this.#tunnels.get('primary')?.child?.pid ?? pids.primary,
      hostname: os.hostname(),
      clientId: config.clientId ?? os.hostname(),
      username: config.username ?? null,
      role: config.role ?? null,
      device: config.device ?? null,
      relay: config.relay ?? null,
      local: config.local ?? null,
      listen: config.listen ?? null,
      autoStart: config.autoStart === true,
      cookieDb: config.cookieDb ?? '',
      endpointFile: config.endpointFile ?? '',
      hasToken: typeof config.token === 'string' && config.token !== '',
      agentOnline: this.#agentOnline,
      agentOfflineForMs: this.#offlineSince === undefined ? 0 : Date.now() - this.#offlineSince,
      tunnels,
      log: this.log,
      configFile: CONFIG_FILE,
    }
  }
}
