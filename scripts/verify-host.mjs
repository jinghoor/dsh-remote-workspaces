#!/usr/bin/env node
/**
 * End-to-end check against the RUNNING desktop Host, i.e. the same HTTP surface the
 * app's renderer uses. This exercises the plugin's own proxy path (rather than the
 * remote Host directly), which is what a paste/send actually goes through.
 *
 *   node scripts/verify-host.mjs [--port 62004]
 *
 * Reads the app's browser cookie from the Electron cookie store (plaintext) so it can
 * authenticate against its own Host. Creates one throwaway Session and archives it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const cookieDb = flag('cookieDb', path.join(os.homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies'))
const hostPort = flag('port', '')

function cookieStoreRows() {
  const out = execFileSync('python3', ['-c', `
import sqlite3, json, base64, sys
db = sqlite3.connect(sys.argv[1])
rows = []
for _, name, value in db.execute("select host_key,name,value from cookies where name like 'dsh-auth%'"):
    b = value.split('.')[1]
    b += '=' * (-len(b) % 4)
    payload = json.loads(base64.urlsafe_b64decode(b))
    rows.append({"authority": payload["authority"], "issuedAt": payload.get("issuedAt", 0), "cookie": name + "=" + value})
print(json.dumps(rows))
`, cookieDb], { encoding: 'utf8' })
  return JSON.parse(out)
}

const rows = cookieStoreRows()
const authorities = [...new Set(rows.map((row) => row.authority))]
const port = hostPort !== '' ? hostPort : authorities.map((a) => a.split(':')[1]).sort((a, b) => Number(b) - Number(a))[0]
const authority = `127.0.0.1:${port}`
const fresh = rows.filter((row) => row.authority === authority).sort((a, b) => b.issuedAt - a.issuedAt)[0]
if (fresh === undefined) {
  console.error(`没有 ${authority} 的 cookie；请从 \`${cookieDb}\` 里确认端口`)
  process.exit(2)
}

const base = `http://${authority}`
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ← ${detail}`}`)
}

async function rpc(endpoint, argsValue) {
  const res = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie: fresh.cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args: argsValue } }),
  })
  const body = await res.json()
  if (body?.result?.ok !== true) {
    const error = body?.result?.error ?? {}
    throw Object.assign(new Error(`${endpoint}: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()), { code: error.code })
  }
  return body.result.value
}

console.log(`目标 Host: ${base}（桌面版真实 HTTP 面）\n`)

// 1. 列表与工作区：确认插件把远端并了进来
let list
try {
  list = await rpc('session/list', { _request: {} })
  const remote = list.items.filter((item) => /^[A-Z]:\\/.test(item.cwd ?? ''))
  check('session/list 含远端会话', remote.length > 0, `${remote.length} / ${list.items.length}`)
  const missing = remote.filter((item) => item.projections?.values?.imageLimits == null)
  check('每条远端会话都带 imageLimits', missing.length === 0, `缺 ${missing.length} 条`)
} catch (error) {
  check('session/list 含远端会话', false, error.message)
  process.exit(1)
}

// 2. 建一条远端会话（走插件的 session/create 路由）
const workspaceId = `remote:${flag('hostId', 'desk')}:${flag('workspaceId', '')}`
let session
try {
  const created = workspaceId.endsWith(':') ? undefined : await rpc('session/create', { request: { workspaceId } })
  if (created === undefined) throw new Error('需要 --workspaceId')
  session = created.sessionId
  check('session/create 落到远端', typeof session === 'string', session.slice(0, 20))
} catch (error) {
  check('session/create 落到远端', false, error.message)
}

if (session !== undefined) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  // 3. 内联图片 prompt（composer 对图片的真实发送方式）
  try {
    await rpc('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: session,
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'verify.png' }, { type: 'text', text: 'verify-host: 图片' }],
      },
    })
    check('内联图片 prompt', true)
  } catch (error) {
    check('内联图片 prompt', false, error.code ?? error.message)
  }

  // 4. 文件上传 + 引用
  try {
    const upload = await fetch(`${base}/api/session/uploadFileBinary?sessionId=${encodeURIComponent(session)}&name=verify.txt`, {
      method: 'POST',
      headers: { cookie: fresh.cookie, origin: base, 'content-type': 'application/octet-stream' },
      body: Buffer.from('verify-host-file'),
    }).then((res) => res.json())
    check('文件上传', upload?.ok === true && typeof upload.value?.receiptId === 'string', upload?.ok === true ? upload.value.file.attachmentId.slice(0, 25) : JSON.stringify(upload).slice(0, 120))
    if (upload?.ok === true) {
      await rpc('session/prompt', {
        request: { requestId: crypto.randomUUID(), sessionId: session, mode: 'queue', content: [{ type: 'file', receiptId: upload.value.receiptId }, { type: 'text', text: 'verify-host: 文件' }] },
      })
      check('文件 prompt', true)
    }
  } catch (error) {
    check('文件上传', false, error.code ?? error.message)
  }

  // 5. 图片回读（0.2.2 形状，即桌面版使用的形状）
  try {
    let attachment
    for (let attempt = 0; attempt < 10 && attachment === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const projections = await rpc('session/projections', { request: { sessionId: session } })
      const page = await rpc('session/events', {
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
      const value = await rpc('session/attachment', { request: { sessionId: session, attachment } })
      const bytes = Buffer.from(value?.data ?? '', 'base64').length
      check('图片回读', bytes === attachment.bytes, `${bytes} 字节 / 声明 ${attachment.bytes}`)
    }
  } catch (error) {
    check('图片回读', false, error.code ?? error.message)
  }

  // 6. 归档本次测试会话
  try {
    await rpc('workspace/archiveSession', { request: { sessionId: session, stopActivity: true } })
    console.log(`\n已归档测试会话 ${session.slice(0, 20)}`)
  } catch (error) {
    console.log(`\n归档失败：${error.message.slice(0, 80)}`)
  }
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
