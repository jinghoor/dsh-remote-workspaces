/**
 * Durable settings for the remote-workspaces plugin.
 *
 * The profile's `remote-workspaces.json` is the source of truth once it exists;
 * a `hosts` array in the cordis patch still works as a first-run seed, so an old
 * install keeps running and the settings page can simply take over.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `.../profiles/<name>/plugins/<pkg>/lib/config.mjs` → `.../profiles/<name>` */
export function profileDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
}

export function configPath() {
  return path.join(profileDirectory(), 'remote-workspaces.json')
}

const EMPTY = { hosts: [], include: {}, order: {} }

function sanitizeHost(value) {
  if (value === null || typeof value !== 'object') return undefined
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  if (id === '' || baseUrl === '') return undefined
  return {
    id,
    label: typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : id,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token: typeof value.token === 'string' ? value.token : '',
    // Some Hosts (the desktop app) mint no token; their browser cookie can be
    // reused directly instead, provided the request authority matches.
    ...(typeof value.cookie === 'string' && value.cookie !== '' ? { cookie: value.cookie } : {}),
    // The Host header a cookie-mode request must carry; dropping it silently turns
    // every call into a 401 that looks like a bad credential.
    ...(typeof value.authority === 'string' && value.authority !== '' ? { authority: value.authority } : {}),
  }
}

/** Accepts anything the settings route or the patch may hand over. */
export function normalize(raw) {
  const value = raw ?? {}
  const hosts = Array.isArray(value.hosts) ? value.hosts.map(sanitizeHost).filter(Boolean) : []
  const include = {}
  for (const [hostId, list] of Object.entries(value.include ?? {})) {
    // An empty array means "hide every workspace", which is different from absent.
    if (!Array.isArray(list)) continue
    include[hostId] = list.filter((item) => typeof item === 'string')
  }
  const order = {}
  for (const [hostId, list] of Object.entries(value.order ?? {})) {
    if (!Array.isArray(list) || list.length === 0) continue
    order[hostId] = list.filter((item) => typeof item === 'string')
  }
  return { hosts, include, order }
}

export function read() {
  try {
    const text = fs.readFileSync(configPath(), 'utf8')
    return normalize(JSON.parse(text))
  } catch {
    return undefined
  }
}

export function write(config) {
  const target = configPath()
  const body = JSON.stringify(normalize(config), null, 2)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, body, { mode: 0o600 })
  fs.renameSync(temporary, target)
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // Best effort: a filesystem without POSIX modes still keeps the file private by directory.
  }
  return target
}

export { EMPTY }
