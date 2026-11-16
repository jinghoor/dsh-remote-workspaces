/**
 * Account store and bearer tokens for the relay.
 *
 * Two roles share one account: the machine running DSH (`agent`) and the machine
 * viewing it (`client`). A device name is owned by exactly one account, which is what
 * keeps tenants apart — a client may only attach to devices of its own account.
 *
 * Passwords are scrypt-hashed; tokens are HMAC-signed JSON, so the relay holds no
 * session table and a restart does not log anyone out before `exp`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TOKEN_VERSION = 'v1'
const SCRYPT_KEYLEN = 32
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/
// The device name becomes part of the namespace key, so it must not carry separators.
const DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64url(text) {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN)
  return { salt: salt.toString('hex'), hash: derived.toString('hex') }
}

function verifyPassword(password, record) {
  const salt = Buffer.from(record.salt, 'hex')
  const expected = Buffer.from(record.hash, 'hex')
  const actual = crypto.scryptSync(password, salt, expected.length)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export class AccountStore {
  #file
  #secret
  #data

  /**
   * @param file - JSON file holding users and the device registry.
   * @param secretFile - file holding the HMAC key for tokens, created on first use.
   */
  constructor(file, secretFile) {
    this.#file = file
    this.#secret = loadSecret(secretFile)
    this.#data = loadState(file)
  }

  #persist() {
    const temporary = `${this.#file}.tmp`
    fs.mkdirSync(path.dirname(this.#file), { recursive: true })
    fs.writeFileSync(temporary, `${JSON.stringify(this.#data, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.#file)
  }

  register(username, password) {
    if (!USERNAME_PATTERN.test(username)) throw new Error('用户名只能是 3-32 位字母、数字、点、下划线或短横线')
    if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少 8 位')
    if (this.#data.users[username] !== undefined) throw new Error('用户名已存在')
    const { salt, hash } = hashPassword(password)
    this.#data.users[username] = { salt, hash, tokenVersion: 1, createdAt: new Date().toISOString() }
    this.#persist()
    return this.issue(username)
  }

  login(username, password) {
    const user = this.#data.users[username]
    if (user === undefined) throw new Error('用户名或密码错误')
    if (!verifyPassword(password, user)) throw new Error('用户名或密码不正确')
    return this.issue(username)
  }

  issue(username) {
    const user = this.#data.users[username]
    // `tv` lets one account invalidate every issued token at once (lost laptop, leak).
    const payload = { u: username, tv: user?.tokenVersion ?? 1, exp: Date.now() + TOKEN_TTL_MS }
    const body = base64url(JSON.stringify(payload))
    const signature = base64url(crypto.createHmac('sha256', this.#secret).update(`${TOKEN_VERSION}.${body}`).digest())
    return { token: `${TOKEN_VERSION}.${body}.${signature}`, username, expiresAt: payload.exp }
  }

  /** @returns the username, or undefined when the token is malformed, forged, or expired. */
  verify(token) {
    if (typeof token !== 'string') return undefined
    const [version, body, signature] = token.split('.')
    if (version !== TOKEN_VERSION || body === undefined || signature === undefined) return undefined
    const expected = base64url(crypto.createHmac('sha256', this.#secret).update(`${TOKEN_VERSION}.${body}`).digest())
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return undefined
    let payload
    try {
      payload = JSON.parse(fromBase64url(body).toString('utf8'))
    } catch {
      return undefined
    }
    if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return undefined
    if (Date.now() > payload.exp) return undefined
    const user = this.#data.users[payload.u]
    if (user === undefined) return undefined
    // Tokens minted before versions existed carry no `tv` and count as version 1.
    if ((user.tokenVersion ?? 1) !== (payload.tv ?? 1)) return undefined
    return payload.u
  }

  /**
   * Claim a device name for an account. The first agent to use a name owns it; a
   * different account asking for the same name is refused rather than silently
   * sharing the tunnel.
   */
  claimDevice(username, device) {
    if (!DEVICE_PATTERN.test(device)) return false
    // Names live in the account's own namespace, so two tenants may both use `desk`
    // and nobody can squat a name to lock someone else out.
    const key = `${username}/${device}`
    if (this.#data.devices[key] === undefined) {
      this.#data.devices[key] = { username, device, claimedAt: new Date().toISOString() }
      this.#persist()
    }
    return true
  }

  /**
   * Remember one viewer machine. Clients pair through a device name, so they have no
   * device identity of their own — this is how "who is watching me" stays answerable.
   */
  noteClient(username, clientId, hostname, watching) {
    if (typeof clientId !== 'string' || clientId === '') return
    const user = this.#data.users[username]
    if (user === undefined) return
    user.clients ??= {}
    user.clients[clientId] = { hostname: String(hostname ?? ''), watching: String(watching ?? ''), lastSeen: new Date().toISOString() }
    const keys = Object.keys(user.clients)
    if (keys.length > 32) {
      for (const key of keys.slice(0, keys.length - 32)) delete user.clients[key]
    }
    this.#persist()
  }

  /** @returns the viewer machines recorded for one account. */
  clientsOf(username) {
    const user = this.#data.users[username]
    return Object.entries(user?.clients ?? {}).map(([clientId, info]) => ({ clientId, ...info }))
  }

  /** @returns whether this account has ever used the device name. */
  ownsDevice(username, device) {
    if (!DEVICE_PATTERN.test(device)) return false
    return this.#data.devices[`${username}/${device}`] !== undefined
  }

  /**
   * Delete an account and release every device it owns. Leaving the claims behind would
   * pin those names to a user that can no longer authenticate — unreachable forever.
   */
  removeUser(username) {
    if (this.#data.users[username] === undefined) return { removed: false, devices: [] }
    delete this.#data.users[username]
    const released = []
    for (const [key, owner] of Object.entries(this.#data.devices)) {
      if (owner.username !== username && !key.startsWith(`${username}/`)) continue
      delete this.#data.devices[key]
      released.push(owner.device ?? key.split('/').slice(1).join('/'))
    }
    this.#persist()
    return { removed: true, devices: released }
  }

  /**
   * Invalidate every token issued for one account. The account keeps working after a
   * fresh `login`; all previously handed-out tokens stop verifying immediately.
   */
  revokeTokens(username) {
    const user = this.#data.users[username]
    if (user === undefined) return undefined
    user.tokenVersion = (user.tokenVersion ?? 1) + 1
    this.#persist()
    return user.tokenVersion
  }

  /** Drop a device claim so another account can take the name. */
  releaseDevice(device, username) {
    const keys = username === undefined
      ? Object.keys(this.#data.devices).filter((key) => key.endsWith(`/${device}`))
      : Object.keys(this.#data.devices).filter((key) => key === `${username}/${device}`)
    if (keys.length === 0) return false
    for (const key of keys) delete this.#data.devices[key]
    this.#persist()
    return true
  }

  /** Devices of one account, for the client's `list` command. */
  devicesOf(username) {
    return Object.entries(this.#data.devices)
      .filter(([key, owner]) => owner.username === username || key.startsWith(`${username}/`))
      .map(([key, owner]) => ({ device: owner.device ?? key.split('/').slice(1).join('/'), claimedAt: owner.claimedAt }))
  }
}

function loadSecret(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text.length >= 32) return Buffer.from(text, 'hex')
  } catch {
    // fall through to creation
  }
  const secret = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 })
  return secret
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const devices = {}
    for (const [key, value] of Object.entries(parsed.devices ?? {})) {
      // Older files keyed devices globally as `device`; move them under `user/device`.
      if (key.includes('/')) { devices[key] = value; continue }
      if (typeof value?.username !== 'string') continue
      devices[`${value.username}/${key}`] = { ...value, device: key }
    }
    return { users: parsed.users ?? {}, devices }
  } catch {
    return { users: {}, devices: {} }
  }
}
