#!/usr/bin/env node
/**
 * 用 DSH 官方校验器验证 market/index.json（format 1）。
 * 依赖本机安装的 @deepseek-ai/dsh-plugin-market-index；没有就跳过并说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { fileURLToPath } from 'node:url'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(REPO, 'market/index.json')
const candidates = [
  path.join(REPO, 'node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'),
  '/Users/maxj/Documents/Python Project/Project-DSH/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
]
const validator = candidates.find((file) => fs.existsSync(file))
if (validator === undefined) {
  console.log('未找到官方校验器，跳过（结构仍按 format 1 手写）')
  process.exit(0)
}
const { parseMarketIndex } = await import(validator)
const text = fs.readFileSync(indexPath, 'utf8')
try {
  const parsed = parseMarketIndex(JSON.parse(text), 'https://example.com/market/index.json')
  console.log(`PASS  format=${parsed.format}  title=${JSON.stringify(parsed.title)}  plugins=${parsed.plugins.length}`)
  for (const plugin of parsed.plugins) {
    console.log(`      ${plugin.name} · versions=${plugin.versions.map((v) => v.version).join(',')} · category=${plugin.metadata.category}`)
  }
} catch (error) {
  console.error(`FAIL  ${error.message}`)
  process.exit(1)
}
