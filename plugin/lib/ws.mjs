/**
 * Minimal RFC 6455 client. Node's global WebSocket cannot send a Cookie header,
 * and the Host's mux route authenticates through the browser-session cookie, so
 * the handshake has to be written by hand. Text frames only; the mux is JSON.
 */
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(6)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(8)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(14)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x81
  const mask = crypto.randomBytes(4)
  mask.copy(header, header.length - 4)
  const body = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, body])
}

function controlFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(6)
  header[0] = 0x80 | opcode
  header[1] = 0x80 | payload.length
  const mask = crypto.randomBytes(4)
  mask.copy(header, 2)
  const body = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, body])
}

/**
 * @returns {Promise<{send(text:string):void, close(code?:number):void, closed:Promise<void>}>}
 */
export function connectWebSocket(rawUrl, headers = {}) {
  const url = new URL(rawUrl)
  const secure = url.protocol === 'wss:'
  const host = url.hostname
  const port = Number(url.port || (secure ? 443 : 80))
  const key = crypto.randomBytes(16).toString('base64')
  const pathPart = `${url.pathname}${url.search}`

  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port })
    socket.setNoDelay(true)
    let handshake = Buffer.alloc(0)
    let upgraded = false
    let buffer = Buffer.alloc(0)
    let fragments = []
    const listeners = new Set()
    const closers = new Set()
    let resolveClosed
    const closed = new Promise((done) => {
      resolveClosed = done
    })
    let isClosed = false

    const fail = (error) => {
      if (isClosed) return
      isClosed = true
      socket.destroy()
      for (const fn of closers) fn(error)
      resolveClosed()
      if (!upgraded) reject(error)
    }

    const emit = (text) => {
      for (const fn of listeners) {
        try {
          fn(text)
        } catch {
          // A throwing consumer must not poison the frame loop.
        }
      }
    }

    const handleFrame = (fin, opcode, payload) => {
      if (opcode === 0x9) {
        socket.write(controlFrame(0xa, payload))
        return
      }
      if (opcode === 0xa) return
      if (opcode === 0x8) {
        socket.write(controlFrame(0x8))
        fail(new Error('websocket closed by peer'))
        return
      }
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload)
        if (!fin) return
        const text = Buffer.concat(fragments).toString('utf8')
        fragments = []
        emit(text)
      }
    }

    const drain = () => {
      while (buffer.length >= 2) {
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        const maskOffset = offset
        if (masked) offset += 4
        if (buffer.length < offset + length) return
        let payload = buffer.subarray(offset, offset + length)
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4)
          const copy = Buffer.alloc(payload.length)
          for (let i = 0; i < payload.length; i++) copy[i] = payload[i] ^ mask[i & 3]
          payload = copy
        }
        buffer = buffer.subarray(offset + length)
        handleFrame(fin, opcode, payload)
        if (isClosed) return
      }
    }

    socket.on('data', (chunk) => {
      if (isClosed) return
      if (upgraded) {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        drain()
        return
      }
      handshake = Buffer.concat([handshake, chunk])
      const end = handshake.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = handshake.subarray(0, end).toString('latin1')
      const rest = handshake.subarray(end + 4)
      if (!/^HTTP\/1\.1 101/.test(head)) {
        fail(new Error(`websocket upgrade refused: ${head.split('\r\n')[0]}`))
        return
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64')
      if (accept !== expected) {
        fail(new Error('websocket upgrade returned a bad Sec-WebSocket-Accept'))
        return
      }
      upgraded = true
      buffer = rest
      resolve({
        send(text) {
          if (isClosed) throw new Error('websocket is closed')
          socket.write(encodeFrame(text))
        },
        close(code = 1000) {
          if (isClosed) return
          const payload = Buffer.alloc(2)
          payload.writeUInt16BE(code, 0)
          try {
            socket.write(controlFrame(0x8, payload))
          } catch {
            // Socket already gone; the close handler below still runs.
          }
          fail(new Error('websocket closed locally'))
        },
        onMessage(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        onClose(fn) {
          closers.add(fn)
          return () => closers.delete(fn)
        },
        closed,
      })
      drain()
    })

    socket.on('error', fail)
    socket.on('close', () => fail(new Error('websocket socket closed')))

    const hasHost = Object.keys(headers).some((name) => name.toLowerCase() === 'host')
    const keyHeader = [
      `GET ${pathPart} HTTP/1.1`,
      ...(hasHost ? [] : [`Host: ${url.host}`]),
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n')
    socket.write(keyHeader)
  })
}
