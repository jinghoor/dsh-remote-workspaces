/**
 * Tunnel supervisor for the settings page.
 *
 * The tunnel itself lives in `dsh-relay.mjs` (the same engine the CLI runs), so the GUI
 * and the CLI can never drift: this module only writes `~/.dsh-relay/config.json`,
 * spawns `node dsh-relay.mjs start`, and reports what the child said.
 *
 * Account calls go straight to the relay's HTTP API; the token they return is written
 * into the same config file the CLI reads.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENGINE = fileURLToPath(new URL('./dsh-relay.mjs', import.meta.url))
const CONFIG_FILE = path.join(os.homedir(), '.dsh-relay', 'config.json')
const LOG_LIMIT = 60
// A plugin reload leaves the previously spawned engine running but unreferenced; the
// pidfile is how the next instance finds (and replaces) it.
const PIDFILE = path.join(os.homedir(), '.dsh-relay', 'tunnel.pid')

/** @returns the parsed config, or an empty object when none exists yet. */
export function readRelayConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
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
export function relayRequest(config, method, pathname, body) {
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

export class TunnelSupervisor {
  #child
  #log = []
  #agentOnline = true
  #offlineSince = undefined
  #stopping = false
  #autoStarted = false

  /** Last lines the engine printed, oldest first. */
  get log() {
    return [...this.#log]
  }

  get running() {
    if (this.#child !== undefined && this.#child.exitCode === null && this.#child.killed === false) return true
    return this.#readPid() !== undefined
  }

  #readPid() {
    try {
      const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim())
      if (!Number.isFinite(pid) || pid <= 0) return undefined
      process.kill(pid, 0)
      return pid
    } catch {
      return undefined
    }
  }

  #writePid(pid) {
    fs.mkdirSync(path.dirname(PIDFILE), { recursive: true })
    fs.writeFileSync(PIDFILE, String(pid ?? ''), { mode: 0o600 })
  }

  async #killPid(pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }

  #trackAgent(line) {
    if (line.includes('上游 agent 上线')) {
      this.#agentOnline = true
      this.#offlineSince = undefined
    } else if (line.includes('上游 agent 掉线')) {
      this.#agentOnline = false
      this.#offlineSince = Date.now()
    }
  }

  /** @returns the agent state the relay last reported. */
  get agentStatus() {
    return {
      online: this.#agentOnline,
      offlineForMs: this.#offlineSince === undefined ? 0 : Date.now() - this.#offlineSince,
    }
  }

  #push(text) {
    for (const line of String(text).split('\n')) {
      if (line.trim() === '') continue
      this.#log.push(line.trim())
      this.#trackAgent(line)
    }
    if (this.#log.length > LOG_LIMIT) this.#log.splice(0, this.#log.length - LOG_LIMIT)
  }

  /**
   * Start the engine with the stored config. Refuses when the config cannot produce a
   * working tunnel, so the UI can show the reason instead of a silent failure.
   */
  async start({ config, onExit, engineArgs = [] } = {}) {
    const stray = this.#readPid()
    if (stray !== undefined) {
      // Replacing an orphan keeps the port free and the pidfile honest.
      await this.#killPid(stray)
      this.#writePid(undefined)
    }
    if (this.#child !== undefined && this.#child.exitCode === null) return { ok: true, already: true }
    const merged = config ?? readRelayConfig()
    if (merged.token === undefined && merged.secret === undefined) throw new Error('还没有登录，或没有配置共享密钥')
    if (merged.role !== 'agent' && merged.role !== 'client') throw new Error('还没有选择这台机器是远端端还是本地端')
    if (typeof merged.relay !== 'string' || merged.relay === '') throw new Error('还没有填写中转地址')
    if (!fs.existsSync(ENGINE)) throw new Error(`隧道引擎缺失：${ENGINE}`)

    this.#log = []
    this.#stopping = false
    const child = spawn(process.execPath, [ENGINE, 'start', ...engineArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    this.#child = child
    this.#writePid(child.pid)
    child.stdout.on('data', (chunk) => this.#push(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => this.#push(chunk.toString('utf8')))
    child.on('exit', (code, signal) => {
      this.#push(`—— 隧道进程退出（code=${code ?? '-'} signal=${signal ?? '-'}）`)
      this.#child = undefined
      this.#writePid(undefined)
      onExit?.({ code, signal, stopping: this.#stopping })
    })
    return { ok: true, pid: child.pid }
  }

  async stop() {
    const orphan = this.#readPid()
    const child = this.#child
    if (child === undefined) {
      if (orphan === undefined) return { ok: true, already: true }
      await this.#killPid(orphan)
      this.#writePid(undefined)
      return { ok: true, killed: orphan }
    }
    this.#stopping = true
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
    this.#child = undefined
    this.#writePid(undefined)
    return { ok: true }
  }

  /** Start once per host process when the config says a tunnel should be up. */
  startIfConfigured(options = {}) {
    if (this.#autoStarted) return
    this.#autoStarted = true
    const config = readRelayConfig()
    if (config.autoStart !== true) return
    try {
      this.start({ config, onExit: options.onExit })
      this.#push(`—— 按配置自动启动（${config.role}）`)
    } catch (error) {
      this.#push(`—— 自动启动失败：${error.message}`)
    }
  }

  status() {
    const config = readRelayConfig()
    return {
      running: this.running,
      pid: this.running ? this.#child?.pid : undefined,
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
      log: this.log,
      configFile: CONFIG_FILE,
    }
  }
}
