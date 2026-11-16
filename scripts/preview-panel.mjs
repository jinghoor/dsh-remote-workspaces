#!/usr/bin/env node
/**
 * 在浏览器里预览设置面板，不用启动 DSH。
 *
 *   cd /tmp && npm i react@18 react-dom@18
 *   NODE_PATH=/tmp/node_modules node scripts/preview-panel.mjs
 *   open /tmp/panel-preview.html
 *
 * 它把 plugin/lib/client.js 装进一个最小的模块壳里，用 SSR 渲染一次，
 * 并把状态预置成「两台远程 + 一个旁观者」，方便检查排版。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(process.env.NODE_PATH === undefined ? import.meta.url : path.join(process.env.NODE_PATH, 'noop.js'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const seeded = {
  0: {
    version: JSON.parse(fs.readFileSync(path.join(REPO, 'plugin/package.json'), 'utf8')).version,
    hostname: 'MacBook-Pro.local', role: 'client', device: 'desk', running: true,
    listen: '127.0.0.1:52900', agentOnline: true, tunnels: [], hasToken: true,
    username: 'preview-user', relay: '<relay>:19090', clientId: 'MacBook-Pro.local', log: [],
  },
  1: { hosts: [], include: {}, source: '<profile>/remote-workspaces.json' },
  5: 'preview-user',
  7: 'client',
  8: 'desk',
  18: [{ device: 'desk', online: true }, { device: 'laptop', online: true }, { device: 'old-pc', online: false }],
  19: [
    { clientId: 'MacBook-Pro.local', hostname: 'MacBook-Pro.local', watching: 'desk', online: true },
    { clientId: 'office', hostname: 'office-iMac', watching: 'laptop', online: false },
  ],
}
let callIndex = 0
const realUseState = React.useState
React.useState = (initial) => {
  const index = callIndex++
  const value = Object.prototype.hasOwnProperty.call(seeded, index) ? seeded[index] : initial
  return realUseState(value)
}
React.useEffect = () => {}

const source = fs.readFileSync(path.join(REPO, 'plugin/lib/client.js'), 'utf8')
let factory
const windowStub = { __ModuleLoader__: { load: ({ factory: fn }) => { factory = fn } } }
new Function('window', source)(windowStub)
const module = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

let Section
module.apply({
  slots: { inject: (_name, fn) => fn(), register: (_meta, component) => { Section = component } },
  inject: () => {},
  get: () => undefined,
  logger: { info: () => {} },
})
callIndex = 0
const html = renderToStaticMarkup(React.createElement(Section))
const out = path.join(process.env.TMPDIR ?? '/tmp', 'panel-preview.html')
fs.writeFileSync(out, `<!doctype html><meta charset=utf-8>
<style>
  html,body{margin:0}
  body{background:#1b1c1f;color:#e6e6e6;width:820px;padding:22px;
       font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif}
</style><div>${html}</div>`)
console.log(`已渲染 → ${out}`)
