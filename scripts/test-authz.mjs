#!/usr/bin/env node
/**
 * 授权边界测试（红队视角）：能不能伪造 token、越权连别人的设备、拿到别人的凭据、
 * 抢占别人的设备名、从旧 namespace 偷看账号设备。
 *
 *   node scripts/test-authz.mjs [--relay host:port] [--secret <relay密钥>]
 *
 * 只读/无害：除「设备名抢占」一项会占用一个随机名字外，不修改任何已有数据。
 */
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const RELAY = flag('relay', '<relay>:19090')
const SECRET = flag('secret', '')
const [RELAY_HOST, RELAY_PORT] = RELAY.split(':')

const HELLO = 1, OPEN = 2, DATA = 3, CLOSE = 4, TOKEN = 7, COOKIE = 8, AGENT_ONLINE = 10

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ← ${detail}`}`)
}

function encodeFrame(type, streamId, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(streamId >>> 0, 1)
  head.writeUInt32BE(payload.length, 5)
  return Buffer.concat([head, payload])
}

function frameReader(onFrame) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 9) return
      const type = buffer.readUInt8(0)
      const streamId = buffer.readUInt32BE(1)
      const length = buffer.readUInt32BE(5)
      if (buffer.length < 9 + length) return
      const payload = buffer.subarray(9, 9 + length)
      buffer = buffer.subarray(9 + length)
      onFrame(type, streamId, payload)
    }
  }
}

/** Dial the relay with one HELLO and collect what comes back for `ms`. */
function probe(hello, ms = 2500) {
  return new Promise((resolve) => {
    const frames = []
    let closed = false
    const socket = tls.connect({ host: RELAY_HOST, port: Number(RELAY_PORT), rejectUnauthorized: false })
    socket.setTimeout(ms + 500, () => socket.destroy())
    socket.once('secureConnect', () => {
      socket.write(encodeFrame(HELLO, 0, Buffer.from(JSON.stringify(hello), 'utf8')))
    })
    socket.on('data', frameReader((type, streamId, payload) => frames.push({ type, payload: payload.toString('utf8').slice(0, 120) })))
    socket.on('close', () => { closed = true })
    socket.on('error', () => {})
    setTimeout(() => {
      socket.destroy()
      resolve({ frames, closed })
    }, ms)
  })
}

function httpCall(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: RELAY_HOST, port: Number(RELAY_PORT), rejectUnauthorized: false })
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

function configOf(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.dsh-relay/config.json'), 'utf8')) } catch { return {} }
}

// ---------------------------------------------------------------- 准备
const localConfig = configOf(os.homedir())
const victimToken = localConfig.token ?? ''
const victimUser = victimToken === '' ? '' : JSON.parse(Buffer.from(victimToken.split('.')[1], 'base64url').toString('utf8')).u
const victimDevice = localConfig.device ?? 'desk'
console.log(`目标账号：${victimUser || '(未登录)'} ｜ 设备名：${victimDevice}\n`)
if (victimToken === '') { console.error('本机没有 token，先登录再跑'); process.exit(2) }

const suffix = crypto.randomBytes(3).toString('hex')
const attacker = { username: `atk${suffix}`, password: `atk-${suffix}-${crypto.randomBytes(4).toString('hex')}` }
const reg = await httpCall('POST', '/v1/register', attacker)
if (reg.json?.ok !== true) { console.error('攻击者账号注册失败：', JSON.stringify(reg.json)); process.exit(2) }
const attackerToken = reg.json.token
console.log(`攻击者账号：${attacker.username}（注册成功）\n`)

// ---------------------------------------------------------------- 1. 伪造 token
const [version, payloadB64, signature] = victimToken.split('.')
const decode = (b64) => JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

{
  const victimPayload = decode(payloadB64)
  const forgedPayload = encode({ ...victimPayload, u: attacker.username })
  const cases = [
    ['换个用户名但保留原签名', `${version}.${forgedPayload}.${signature}`],
    ['去掉签名段', `${version}.${payloadB64}.`],
    ['换成空签名（alg:none 风格）', `${version}.${payloadB64}`],
    ['把版本号改成 v2', `v2.${payloadB64}.${signature}`],
    ['把过期时间往后改', `${version}.${encode({ ...victimPayload, exp: Date.now() + 9e10 })}.${signature}`],
  ]
  for (const [label, token] of cases) {
    const { frames } = await probe({ role: 'client', device: victimDevice, token })
    const leaked = frames.some((frame) => frame.type === COOKIE || frame.type === TOKEN)
    record(`伪造 token：${label}`, leaked === false && frames.every((f) => f.type === CLOSE), leaked ? '拿到了凭据帧' : '被拒')
  }
}

// ---------------------------------------------------------------- 2. 用自己的 token 连别人的设备
{
  const { frames } = await probe({ role: 'client', device: victimDevice, token: attackerToken })
  const leaked = frames.filter((frame) => frame.type === COOKIE || frame.type === TOKEN)
  record('他人 token 连受害者设备', leaked.length === 0, leaked.length === 0 ? '未泄漏凭据' : `泄漏了 ${leaked.length} 帧`)
}

// ---------------------------------------------------------------- 3. 抢注受害者设备名
{
  const { frames } = await probe({ role: 'agent', device: victimDevice, token: attackerToken })
  record('他人 agent 抢注设备名', frames.every((frame) => frame.type === CLOSE), frames.some((f) => f.type === AGENT_ONLINE) ? '抢注成功（严重）' : '被拒')
}

// ---------------------------------------------------------------- 4. 受害者设备是否仍可用
{
  const { frames } = await probe({ role: 'client', device: victimDevice, token: victimToken })
  const ok = frames.some((frame) => frame.type === AGENT_ONLINE)
  record('合法客户端仍可连接（未被顶掉）', ok, ok ? '收到 AGENT_ONLINE' : '未收到')
}

// ---------------------------------------------------------------- 5. 管理端点鉴权
{
  const cases = [
    ['无鉴权头', {}, 403],
    ['错误密钥', { 'x-relay-secret': 'wrong-secret' }, 403],
    ['拿租户 token 冒充', { authorization: `Bearer ${attackerToken}` }, 403],
    ['空密钥', { 'x-relay-secret': '' }, 403],
  ]
  for (const [label, headers, expect] of cases) {
    const res = await httpCall('POST', '/v1/admin/release', { device: victimDevice }, headers)
    record(`admin/release 拒绝：${label}`, res.status === expect, `HTTP ${res.status}`)
  }
  const del = await httpCall('POST', '/v1/admin/user-remove', { username: victimUser }, { authorization: `Bearer ${attackerToken}` })
  record('admin/user-remove 拒绝租户 token', del.status === 403, `HTTP ${del.status}`)
  if (SECRET !== '') {
    const ok = await httpCall('POST', '/v1/admin/release', { device: `nobody-${suffix}` }, { 'x-relay-secret': SECRET })
    record('正确密钥可通过（对照）', ok.json?.ok === true, `HTTP ${ok.status}`)
  }
}

// ---------------------------------------------------------------- 6. 旧 namespace 越界
{
  // 无凭据客户端只允许连「用共享密钥认证的 legacy agent」
  const { frames } = await probe({ role: 'client', device: victimDevice })
  const leaked = frames.filter((frame) => frame.type === COOKIE || frame.type === TOKEN)
  record('无凭据客户端连账号设备', leaked.length === 0, leaked.length === 0 ? '未泄漏凭据' : `泄漏 ${leaked.length} 帧`)
}

// ---------------------------------------------------------------- 7. 暴力尝试
{
  // The relay allows 10 failures per 5 minutes; go past it to see the block.
  const attempts = 13
  const started = Date.now()
  let blocked = 0
  for (let i = 0; i < attempts; i++) {
    const res = await httpCall('POST', '/v1/login', { username: victimUser, password: `guess-${i}` })
    if (res.status === 429) blocked += 1
  }
  const ms = Date.now() - started
  record('登录暴力尝试被限速', blocked > 0, `${attempts} 次尝试 / ${ms}ms，429 响应 ${blocked} 次`)
}

// ---------------------------------------------------------------- 8. 同名设备抢占（对方命名空间内应完全无感）
{
  // An attacker may use the same device name, but it lands in their own namespace.
  await probe({ role: 'agent', device: victimDevice, token: attackerToken }, 1500)
  const { frames } = await probe({ role: 'client', device: victimDevice, token: victimToken })
  const paired = frames.some((frame) => frame.type === AGENT_ONLINE)
  record('同名设备抢注不影响受害者配对', paired, paired ? '仍与自己的 agent 配对' : '被对方的同名设备顶掉')
}

console.log()
const failed = results.filter((item) => !item.ok)
console.log(`${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('未通过的项：')
  for (const item of failed) console.log(`  - ${item.name}`)
}
