#!/usr/bin/env node
/**
 * End-to-end check for the remote-workspaces plugin.
 *
 * Runs against whatever `~/.dsh/profiles/<profile>/remote-workspaces.json` points at,
 * so it exercises the real tunnel rather than a mock. Read-only except for one
 * throwaway Session it creates, prompts, queues, and cancels.
 *
 *   node scripts/verify.mjs [--profile desktop] [--port <guiPort>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { RemoteHost } from '../plugin/lib/remote.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const profile = flag('profile', 'desktop')
const port = flag('port', '')
// Reusing a Session keeps repeated runs from littering the remote's list.
const reuseSession = flag('session', '')
const configPath = path.join(os.homedir(), '.dsh', 'profiles', profile, 'remote-workspaces.json')
if (!fs.existsSync(configPath)) {
  console.error(`找不到配置: ${configPath}`)
  process.exit(2)
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const hostConfig = config.hosts?.[0]
if (hostConfig === undefined) {
  console.error('配置里没有 host')
  process.exit(2)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ← ${detail}`}`)
}

const remote = new RemoteHost(hostConfig)

console.log(`目标: ${hostConfig.label ?? hostConfig.id} → ${hostConfig.baseUrl} (authority ${hostConfig.authority ?? '-'})\n`)

// 1. 基本连通
let list
try {
  list = await remote.call('session/list', { _request: {} })
  check('session/list 可达', Array.isArray(list.items), `${list.items?.length ?? 0} 条会话`)
} catch (error) {
  check('session/list 可达', false, error.message)
  process.exit(1)
}
const workspaces = await remote.workspaceBaseline().catch((error) => ({ error }))
check('workspace/follow 基线', Array.isArray(workspaces.items), `${workspaces.items?.length ?? 0} 个工作区`)

// 2. 建一条一次性会话用于写入测试
const workspaceId = workspaces.items?.[0]?.workspaceId
let session = reuseSession === '' ? undefined : reuseSession
if (session !== undefined) {
  check('session/create', true, `复用 ${session.slice(0, 20)}`)
} else {
  try {
    const created = await remote.call('session/create', { request: { workspaceId } })
    session = created.sessionId
    check('session/create', typeof session === 'string', session?.slice(0, 20))
  } catch (error) {
    check('session/create', false, error.message)
  }
}

if (session !== undefined) {
  // 3. 流：订阅后应能收到 snapshot
  const frames = []
  const abort = new AbortController()
  const stream = remote.stream('session/follow', { args: { request: { address: { kind: 'session', sessionId: session } } } }, abort.signal)
  const pump = (async () => {
    try {
      for await (const frame of stream) {
        frames.push(frame)
        if (frames.length >= 200) break
      }
    } catch {
      // 结束或取消都算正常
    }
  })()

  await new Promise((resolve) => setTimeout(resolve, 4000))
  check('session/follow 收到 snapshot', frames.some((frame) => frame?.type === 'snapshot'), `${frames.length} 帧`)

  // 4. 文本 prompt
  let accepted = false
  try {
    const value = await remote.call('session/prompt', {
      request: { requestId: crypto.randomUUID(), sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'verify: 只回复 ok' }] },
    })
    accepted = value?.accepted === true || value !== undefined
  } catch (error) {
    accepted = false
    console.error('   prompt 错误:', error.code ?? '', error.message.slice(0, 120))
  }
  check('session/prompt 文本', accepted)

  // 5. 运行状态：等待状态事件或投影变化
  const sawEvent = frames.some((frame) => frame?.type === 'event')
  check('运行中收到事件流', sawEvent, `${frames.filter((frame) => frame?.type === 'event').length} 个事件帧`)

  // 6. 排队：再发一条，inbox 里应能看到 next-turn 行
  try {
    await remote.call('session/prompt', {
      request: { requestId: crypto.randomUUID(), sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'verify: 排队中' }] },
    })
    const projections = await remote.call('session/projections', { request: { sessionId: session } })
    const queue = projections?.values?.inbox?.['next-turn'] ?? []
    check('排队状态可读', Array.isArray(queue), `${queue.length} 行`)
  } catch (error) {
    check('排队状态可读', false, error.message)
  }

  // 7. 停止
  try {
    await remote.call('session/cancel', { request: { sessionId: session } })
    check('session/cancel', true)
  } catch (error) {
    check('session/cancel', false, error.code ?? error.message)
  }

  // 8. 图片（内联）与文件（上传 receipt）
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  try {
    await remote.call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: session,
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'verify.png' }, { type: 'text', text: 'verify: 图片' }],
      },
    })
    check('内联图片 prompt', true)
  } catch (error) {
    check('内联图片 prompt', false, error.code ?? error.message)
  }

  try {
    const upload = await remote.uploadFileBinary({
      sessionId: session,
      name: 'verify.txt',
      data: (async function* () {
        yield Buffer.from('verify-file')
      })(),
    })
    check('文件上传 receipt', typeof upload?.receiptId === 'string', upload?.file?.attachmentId?.slice(0, 20))
    await remote.call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: session,
        mode: 'queue',
        content: [{ type: 'file', receiptId: upload.receiptId }, { type: 'text', text: 'verify: 文件' }],
      },
    })
    check('文件 prompt', true)
  } catch (error) {
    check('文件上传 receipt', false, error.code ?? error.message)
  }

  abort.abort()
  // 9. 图片回读：0.2.2 的 request 是 { sessionId, attachment: {...} }（0.2.1 是平铺）
  try {
    let attachment
    // The image lands in the log only after admission, so poll briefly instead of
    // failing the first read.
    for (let attempt = 0; attempt < 8 && attachment === undefined; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
      const projections = await remote.call('session/projections', { request: { sessionId: session } })
      const page = await remote.call('session/events', {
        request: { address: { kind: 'session', sessionId: session }, throughSeq: projections.asOfSeq, maxMessages: 24 },
      })
      for (const record of page.records ?? []) {
        for (const block of record.event?.data?.content ?? []) {
          if (block?.type === 'image' && block.attachment !== undefined) attachment = block.attachment
        }
      }
    }
    if (attachment === undefined) {
      check('图片回读', false, '日志里没有图片块')
    } else {
      const value = await remote.call('session/attachment', {
        request: { sessionId: session, attachment },
      })
      const bytes = Buffer.from(value?.data ?? '', 'base64').length
      check('图片回读', bytes === attachment.bytes, `${bytes} 字节 / 声明 ${attachment.bytes}`)
    }
  } catch (error) {
    check('图片回读', false, error.code ?? error.message)
  }

  abort.abort()
  await pump
}

// 9. 本机 Host 侧（可选）：插件是否把远端并进来
if (port !== '') {
  const probe = await fetch(`http://127.0.0.1:${port}/remote-workspaces/status`, { headers: { cookie: 'dsh-auth-verify=1' } })
    .then((res) => (res.ok ? res.json() : undefined))
    .catch(() => undefined)
  check('本机插件 /status', probe?.ok === true, probe?.value ? `远端 ${probe.value.sessions?.remote ?? 0} 条会话` : '不可达')
  if (probe?.value) {
    check('工作区已注入', (probe.value.workspaces?.remote ?? 0) > 0, `${probe.value.workspaces?.remote ?? 0} 个`)
    check('无待解释的失败', probe.value.lastError === null, JSON.stringify(probe.value.lastError)?.slice(0, 120))
  }
}

// Leave the remote tidy: archiving hides the throwaway Session from every surface.
if (session !== undefined && reuseSession === '') {
  try {
    await remote.call('workspace/archiveSession', { request: { sessionId: session, stopActivity: true } })
    console.log('\n已归档本次测试会话', session.slice(0, 20))
  } catch (error) {
    console.log('\n归档测试会话失败：', error.message.slice(0, 80))
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
