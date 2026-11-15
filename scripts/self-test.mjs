#!/usr/bin/env node
/**
 * 离线自检：不需要任何远端机器，自己起中转、假 DSH、agent 和 client 跑一遍。
 *
 *   node scripts/self-test.mjs [--keep]     # --keep 保留临时目录便于排查
 *
 * 覆盖：账号注册/登录、隧道配对、HTTP 与 WebSocket 穿透、跨账号隔离、token 吊销。
 * 依赖：node ≥ 18，openssl（生成自签证书）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selftest-'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ← ${detail}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function makeCert(dir) {
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' })
  return { key, cert }
}

// ---------------------------------------------------------------- 假 DSH Host
function mockHost(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/') {
      // The engine exchanges ?token= for a session cookie, then reuses the cookie.
      if (url.searchParams.get('token') !== undefined) {
        res.writeHead(200, { 'set-cookie': 'dsh-auth-mock=v1.mock.sig; Path=/', 'content-type': 'text/html' })
        return res.end('<!doctype html><title>mock dsh</title><p id=ok>MOCK</p>')
      }
      const cookie = String(req.headers.cookie ?? '')
      if (!cookie.includes('dsh-auth-mock=')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        return res.end('unauthorized')
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<!doctype html><title>mock dsh</title><p id=ok>MOCK</p>')
    }
    res.writeHead(404).end()
  })
  // WebSocket echo on /api/remote.mux: proves the upgrade path survives the tunnel.
  server.on('request', (req) => {
    if (process.env.SELFTEST_DEBUG === '1') console.log('  [mock] request', req.method, req.url)
  })
  server.on('upgrade', (req, socket) => {
    if (process.env.SELFTEST_DEBUG === '1') console.log('  [mock] upgrade', req.url)
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n\r\n`,
    )
    socket.on('data', (chunk) => {
      // Unmasked text frame echo: FIN|text, length, payload.
      const payload = Buffer.from('pong-through-tunnel')
      const head = Buffer.from([0x81, payload.length])
      socket.write(Buffer.concat([head, payload]))
      void chunk
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ---------------------------------------------------------------- HTTP 助手
function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function relayApi(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    const payload = body === undefined ? '' : JSON.stringify(body)
    let text = ''
    socket.once('secureConnect', () => {
      socket.write([
        `${method} ${pathname} HTTP/1.1`, 'host: relay', 'connection: close',
        'content-type: application/json', `content-length: ${Buffer.byteLength(payload)}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', payload,
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => { text += chunk.toString('utf8') })
    socket.on('close', () => {
      const at = text.indexOf('\r\n\r\n')
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)
      let json
      try { json = JSON.parse(text.slice(at + 4)) } catch { json = undefined }
      resolve({ status, json })
    })
    socket.on('error', reject)
  })
}

function runEngine(args, cwd, env) {
  const child = spawn(process.execPath, [path.join(REPO, 'cli/dsh-relay.mjs'), ...args], {
    cwd,
    env: { ...process.env, ...env, HOME: cwd, ENGINE_DEBUG: process.env.ENGINE_DEBUG ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', (chunk) => log.push(chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => log.push(chunk.toString('utf8')))
  return { child, log }
}

// ---------------------------------------------------------------- 主流程
const relayPort = await freePort()
const mockPort = await freePort()
const clientPort = await freePort()
const attackerPort = await freePort()
const { key, cert } = makeCert(WORK)
const secret = crypto.randomBytes(32).toString('base64')
const children = []

try {
  console.log(`工作目录 ${WORK}（--keep 可保留）`)

  const relay = spawn(process.execPath, [
    path.join(REPO, 'relay/relay.mjs'),
    '--port', String(relayPort), '--host', '127.0.0.1',
    '--cert', cert, '--key', key, '--secret', secret,
    '--users', path.join(WORK, 'users.json'), '--state', path.join(WORK, 'token.key'),
    '--cli', path.join(REPO, 'cli/dsh-relay.mjs'), '--dist', path.join(WORK, 'dist'),
    '--max-devices', '2', '--max-links', '4', '--register-per-hour', '3',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(relay)
  await sleep(600)

  const mock = await mockHost(mockPort)
  check('假 DSH 已启动', mock.listening === true, `:${mockPort}`)

  const relayHost = `127.0.0.1:${relayPort}`
  const homeA = path.join(WORK, 'a')
  const homeB = path.join(WORK, 'b')
  for (const home of [homeA, homeB]) fs.mkdirSync(home, { recursive: true })

  const register = async (username, password) => {
    const answer = await relayApi(relayPort, 'POST', '/v1/register', { username, password })
    if (answer.json?.ok !== true) throw new Error(`register ${username}: ${JSON.stringify(answer.json)}`)
    return answer.json.token
  }
  const tokenA = await register('alice', 'alice-password-1')
  const tokenB = await register('bob', 'bob-password-1')
  check('两个账号注册成功', tokenA !== tokenB)

  const writeConfig = (home, patch) => {
    const dir = path.join(home, '.dsh-relay')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.json')
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`)
  }

  writeConfig(homeA, { relay: relayHost, token: tokenA, role: 'agent', device: 'desk', local: `127.0.0.1:${mockPort}` })
  const agentA = runEngine(['start'], homeA)
  children.push(agentA.child)
  await sleep(1800)
  check('agent 上线', agentA.log.join('').includes('agent connected'))

  writeConfig(homeA, { role: 'client', device: 'desk', listen: `127.0.0.1:${clientPort}` })
  const clientA = runEngine(['start'], homeA)
  children.push(clientA.child)
  await sleep(1800)
  check('client 配对成功', clientA.log.join('').includes('client attached'))

  const ws = await new Promise((resolve) => {
    const socket = net.connect(clientPort, '127.0.0.1', () => {
      socket.write([
        'GET /api/remote.mux HTTP/1.1',
        `host: 127.0.0.1:${mockPort}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${crypto.randomBytes(16).toString('base64')}`,
        'sec-websocket-version: 13', '', '',
      ].join('\r\n'))
    })
    let text = ''
    const timer = setTimeout(() => { socket.destroy(); resolve({ status: 0 }) }, 4000)
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      // Resolve on the first status line: anything else is a hang, not a slow upgrade.
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)
      if (status === 0) return
      clearTimeout(timer)
      socket.destroy()
      resolve({ status, body: text })
    })
    socket.on('error', () => { clearTimeout(timer); resolve({ status: -1 }) })
  })
  check('WebSocket 穿透', ws.status === 101, `HTTP ${ws.status}`)

  const page = await request(clientPort, 'GET', '/', { headers: { host: `127.0.0.1:${mockPort}`, cookie: 'dsh-auth-mock=v1.mock.sig' } })
  check('HTTP 穿透', page.status === 200 && page.body.includes('MOCK'), `HTTP ${page.status}`)
  if (ws.status !== 101 && process.env.SELFTEST_DEBUG === '1') {
    console.log('  [client log]', clientA.log.join('').split('\n').slice(-6).join(' | '))
    console.log('  [agent log ]', agentA.log.join('').split('\n').slice(-6).join(' | '))
  }

  // 注册限速：本机中转限制每小时 3 个，第 4 个应被拒
  const thirdOk = await relayApi(relayPort, 'POST', '/v1/register', { username: 'carol', password: 'carol-password-1' })
  const fourth = await relayApi(relayPort, 'POST', '/v1/register', { username: 'dave', password: 'dave-password-1' })
  check('注册限速生效', thirdOk.json?.ok === true && fourth.status === 429, `第4个 HTTP ${fourth.status}`)

  // 设备配额：carol 上限 2 台
  writeConfig(homeB, { relay: relayHost, token: thirdOk.json.token, role: 'agent', device: 'c1', local: `127.0.0.1:${mockPort}` })
  const carol1 = runEngine(['start'], homeB)
  children.push(carol1.child)
  await sleep(1500)
  writeConfig(homeB, { device: 'c2' })
  const carol2 = runEngine(['start'], homeB)
  children.push(carol2.child)
  await sleep(1500)
  writeConfig(homeB, { device: 'c3' })
  const carol3 = runEngine(['start'], homeB)
  children.push(carol3.child)
  await sleep(2000)
  check('设备配额生效', carol3.log.join('').includes('link dropped') || !carol3.log.join('').includes('agent connected'),
    '第三台设备被拒')

  // 跨账号：bob 连 alice 的设备必须被拒
  writeConfig(homeB, { relay: relayHost, token: tokenB, role: 'client', device: 'desk', listen: `127.0.0.1:${attackerPort}` })
  const clientB = runEngine(['start'], homeB)
  children.push(clientB.child)
  await sleep(1800)
  const denied = await request(attackerPort, 'GET', '/', { headers: { host: `127.0.0.1:${mockPort}` } }).catch(() => ({ status: 0 }))
  check('跨账号连接受阻', denied.status === 0 || denied.status === 401, `HTTP ${denied.status}`)

  // 吊销：alice 的所有 token 立即失效，活动连接同时断开
  const revoked = await relayApi(relayPort, 'POST', '/v1/admin/revoke', { username: 'alice' }, { 'x-relay-secret': secret })
  check('吊销接口可用', revoked.json?.ok === true, `tokenVersion ${revoked.json?.tokenVersion} dropped ${revoked.json?.dropped}`)
  await sleep(2500)
  check('吊销断开活动连接', agentA.log.join('').includes('link dropped'), 'agent 日志出现 link dropped')
  const stale = await relayApi(relayPort, 'GET', '/v1/devices', undefined, { authorization: `Bearer ${tokenA}` })
  check('旧 token 失效', stale.status === 401, `HTTP ${stale.status}`)
} catch (error) {
  check('自检流程未抛异常', false, String(error && error.message))
} finally {
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过${KEEP ? `（临时目录保留在 ${WORK}）` : ''}`)
process.exit(failed.length === 0 ? 0 : 1)
