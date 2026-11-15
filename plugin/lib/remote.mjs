/**
 * One remote DSH Host as a client: token→cookie, unary `/api/<endpoint>` calls,
 * and mux streams over `/api/remote.mux`. Everything here speaks the same wire
 * protocol the browser client uses; the local Host re-serves the results.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { connectWebSocket } from './ws.mjs'

const TIMEOUT_MS = 20000

function withTimeout(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

export class RemoteHost {
  constructor(host, options = {}) {
    this.id = host.id
    this.label = host.label ?? host.id
    this.baseUrl = String(host.baseUrl ?? '').replace(/\/+$/, '')
    this.token = host.token ?? ''
    this.staticCookie = host.cookie ?? ''
    // A pasted/desktop cookie is bound to the remote's own authority, so the request
    // must carry that Host even though the tunnel listens on a different local port.
    this.authority = typeof host.authority === 'string' && host.authority !== '' ? host.authority : ''
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
    this.cookie = undefined
    this.cookieInflight = undefined
  }

  /** The browser-trust fence compares Origin against the request authority. */
  get origin() {
    return this.authority !== '' ? `http://${this.authority}` : this.baseUrl
  }

  get streamUrl() {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/remote.mux`
  }

  async #exchange() {
    if (this.token === '') throw new Error(`remote host ${this.id} has neither a token nor a cookie configured`)
    const { signal, done } = withTimeout(this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html' },
      })
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      const pair = list
        .map((value) => value.split(';')[0].trim())
        .filter((value) => value.startsWith('dsh-auth-') && value.includes('='))
        .join('; ')
      if (pair === '') throw new Error(`remote ${this.id}: token exchange HTTP ${res.status} without a session cookie`)
      return pair
    } finally {
      done()
    }
  }

  async #cookie() {
    // A pasted cookie wins: no token exchange, no /?token= round trip.
    if (this.staticCookie !== '') return this.staticCookie
    if (this.cookie !== undefined) return this.cookie
    if (this.cookieInflight !== undefined) return this.cookieInflight
    this.cookieInflight = this.#exchange()
      .then((value) => {
        this.cookie = value
        return value
      })
      .finally(() => {
        this.cookieInflight = undefined
      })
    return this.cookieInflight
  }

  /** One HTTP exchange; `fetch` cannot set Host, and a cookie-mode Host must match. */
  #request(pathname, payload, signal, headers = {}) {
    const url = new URL(pathname, this.baseUrl)
    const transport = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...(this.authority !== '' ? { host: this.authority } : {}),
            ...headers,
          },
          signal,
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  async call(endpoint, args, signal) {
    const run = async (retry) => {
      const cookie = await this.#cookie()
      const { signal: timeout, done } = withTimeout(this.timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      try {
        const wire = JSON.stringify({
          type: 'client-request',
          rpcId: `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          method: endpoint,
          payload: { args },
        })
        const res = await this.#request(`/api/${endpoint}`, wire, combined, {
          'content-type': 'application/json',
          cookie,
          origin: this.origin,
          'content-length': Buffer.byteLength(wire),
        })
        if (res.status === 401 || res.status === 403) {
          this.cookie = undefined
          if (retry) return run(false)
          throw new Error(`remote ${this.id} rejected the credential (HTTP ${res.status})`)
        }
        const text = res.text
        let body
        try {
          body = JSON.parse(text)
        } catch {
          throw new Error(`remote ${endpoint} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`)
        }
        const result = body?.result
        if (result?.ok !== true) {
          const error = result?.error ?? {}
          throw Object.assign(new Error(`${endpoint}: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()), {
            code: error.code,
            details: error.details,
          })
        }
        return result.value
      } finally {
        done()
      }
    }
    return run(true)
  }

  /**
   * Yields each `item` value of one stream endpoint until it ends, the caller
   * stops iterating (which cancels the stream), or the socket drops.
   */
  async *stream(endpoint, payload, signal) {
    const cookie = await this.#cookie()
    const socket = await connectWebSocket(this.streamUrl, {
      ...(this.authority !== '' ? { Host: this.authority } : {}),
      Cookie: cookie,
      Origin: this.origin,
    })
    const streamId = crypto.randomUUID()
    const queue = []
    let wake
    let ended = false
    let failure
    const wakeUp = () => {
      const fn = wake
      wake = undefined
      fn?.()
    }
    const offMessage = socket.onMessage((text) => {
      let frame
      try {
        frame = JSON.parse(text)
      } catch {
        return
      }
      if (frame.streamId !== streamId) return
      if (frame.type === 'item') queue.push({ item: frame.value })
      else if (frame.type === 'end') ended = true
      else if (frame.type === 'error') {
        failure = Object.assign(new Error(frame.error.message), { code: frame.error.code })
        ended = true
      }
      wakeUp()
    })
    const offClose = socket.onClose((error) => {
      if (!ended && failure === undefined) failure = error ?? new Error('remote stream closed')
      ended = true
      wakeUp()
    })
    try {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
      for (;;) {
        if (signal?.aborted) break
        if (queue.length === 0 && !ended) {
          // A frame may land between the check and the assignment; re-check inside
          // the promise so the loop cannot sleep through an already-arrived item.
          await new Promise((resolve) => {
            if (queue.length > 0 || ended) return resolve()
            wake = resolve
            signal?.addEventListener('abort', wakeUp, { once: true })
          })
        }
        while (queue.length > 0) yield queue.shift().item
        if (failure !== undefined) throw failure
        if (ended && queue.length === 0) return
      }
    } finally {
      try {
        socket.send(JSON.stringify({ type: 'cancel', streamId }))
      } catch {
        // Socket already gone; closing below is enough.
      }
      offMessage()
      offClose()
      socket.close()
    }
  }

  /**
   * Forward one raw upload to this Host, so the receipt the caller gets back is
   * owned by the machine that will actually run the conversation.
   */
  async uploadFileBinary({ sessionId, name, mediaType, data, signal }) {
    const cookie = await this.#cookie()
    const query = new URLSearchParams({ sessionId })
    if (name !== undefined) query.set('name', name)
    // Image uploads carry the media type so the Host normalises instead of storing raw.
    if (mediaType !== undefined) query.set('mediaType', mediaType)
    const url = new URL(`/api/session/uploadFileBinary?${query.toString()}`, this.baseUrl)
    const transport = url.protocol === 'https:' ? https : http

    let cancelled = false
    const res = await new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...(this.authority !== '' ? { host: this.authority } : {}),
            'content-type': 'application/octet-stream',
            cookie,
            origin: this.origin,
          },
          signal,
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            cancelled = true
            resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
          })
          response.on('error', reject)
        },
      )
      req.on('error', reject)
      // Explicit backpressure: `pipeline` rejects with ERR_INVALID_RETURN_VALUE on a
      // ClientRequest here, and a plain write/end loop stalls a slow consumer.
      void (async () => {
        try {
          for await (const chunk of data) {
            if (cancelled) return
            if (!req.write(chunk)) await new Promise((resolve) => req.once('drain', resolve))
          }
          req.end()
        } catch (error) {
          req.destroy(error instanceof Error ? error : new Error(String(error)))
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })

    const text = res.text
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`remote upload returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`)
    }
    if (body?.ok !== true) {
      const error = body?.error ?? {}
      throw Object.assign(new Error(`remote upload failed: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()), {
        code: error.code,
        details: error.details,
      })
    }
    return body.value
  }

  /** First `baseline` frame of `workspace/follow`, then cancel. */
  async workspaceBaseline(signal) {
    for await (const frame of this.stream('workspace/follow', { args: {} }, signal)) {
      if (frame?.type === 'baseline' || frame?.type === 'replace') return frame.value
    }
    throw new Error(`remote ${this.id} sent no workspace baseline`)
  }
}
