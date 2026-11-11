/**
 * 设备目录同步：把唯一真源 cloudbase/device-catalog.js
 * 注入到两个消费方，目录只有一份、不会再漂移：
 *   1) cloudbase/miniprogram/utils/mock.js   → const DEVICE_TREE = {...}
 *   2) prototype/assets/device-catalog.js    → window.DEVICE_CATALOG = {...}
 *
 * 背景：目录曾在小程序 mock.js 与原型 data.js 各写一份，两边已经漂移
 * （原型缺超聚变 GPU 服务器、戴尔没有 B300 等）。
 *
 * 为什么真源放在 cloudbase/ 而不是 miniprogram/utils/：
 * 微信开发者工具打开的是 cloudbase/miniprogram/ 目录，新增文件后模块缓存可能
 * 不识别新的 require 路径（报 "module 'utils/xxx.js' is not defined"）。
 * 真源留在包外、由脚本把内容直接注入 mock.js，小程序包里不新增任何文件。
 *
 * 运行：node cloudbase/scripts/sync-device-catalog.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

const SOURCE = path.join(root, 'cloudbase', 'device-catalog.js')
const MOCK = path.join(root, 'cloudbase', 'miniprogram', 'utils', 'mock.js')
const TARGET = path.join(root, 'prototype', 'assets', 'device-catalog.js')
const PROTOTYPE_DIR = path.join(root, 'prototype')

/** 读取真源里的 DEVICE_CATALOG 字面量文本（做括号配平扫描，跳过字符串里的括号） */
function readCatalogSource() {
  const src = fs.readFileSync(SOURCE, 'utf8')
  const start = src.indexOf('const DEVICE_CATALOG =')
  if (start < 0) throw new Error('device-catalog.js 里找不到 DEVICE_CATALOG')
  const objStart = src.indexOf('{', start)
  if (objStart < 0) throw new Error('device-catalog.js 里找不到 DEVICE_CATALOG 的起始大括号')
  let depth = 0
  let i = objStart
  let inStr = ''
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error('device-catalog.js 的 DEVICE_CATALOG 大括号不配对')
  return src.slice(objStart, i + 1)
}

const literal = readCatalogSource()

/* ---- 1. 注入小程序 mock.js ---- */
const MOCK_BEGIN = '/* 设备目录开始（由 scripts/sync-device-catalog.mjs 生成，请勿手改） */'
const MOCK_END = '/* 设备目录结束 */'

function injectMock(literalText) {
  let src = fs.readFileSync(MOCK, 'utf8')
  const block = `${MOCK_BEGIN}\nconst DEVICE_TREE = ${literalText}\n${MOCK_END}`
  const begin = src.indexOf(MOCK_BEGIN)
  if (begin >= 0) {
    const end = src.indexOf(MOCK_END, begin)
    if (end < 0) throw new Error('mock.js 里的设备目录结束标记缺失')
    src = src.slice(0, begin) + block + src.slice(end + MOCK_END.length)
  } else {
    /* 首次生成：替换掉原来那一行 require 引入 */
    const anchor = /const \{ DEVICE_CATALOG \} = require\('\.\/device-catalog'\)\nconst DEVICE_TREE = DEVICE_CATALOG\n/
    if (!anchor.test(src)) {
      throw new Error('mock.js 里找不到设备目录的锚点，无法自动注入')
    }
    src = src.replace(anchor, block + '\n')
  }
  fs.writeFileSync(MOCK, src, 'utf8')
}

/* ---- 2. 生成浏览器版 ---- */
const banner = `/* 由 cloudbase/scripts/sync-device-catalog.mjs 自动生成，请勿手改。
   真源：cloudbase/device-catalog.js
   改目录请改真源后重新运行同步脚本。 */\n`

function writeBrowser(literalText) {
  fs.writeFileSync(TARGET, `${banner}window.DEVICE_CATALOG = ${literalText}\n`, 'utf8')
}

/* ---- 3. 云函数 / 管理端共享副本：只复制设备目录，不动 shared 里的其它文件 ---- */
function syncSharedCopies() {
  const sharedDir = path.join(root, 'cloudbase', 'shared')
  const copies = []
  if (fs.existsSync(path.join(sharedDir, 'device-catalog.js'))) {
    fs.copyFileSync(SOURCE, path.join(sharedDir, 'device-catalog.js'))
    copies.push('cloudbase/shared/device-catalog.js')
  }
  const fnsDir = path.join(root, 'cloudbase', 'cloudfunctions')
  if (fs.existsSync(fnsDir)) {
    for (const fn of fs.readdirSync(fnsDir)) {
      const target = path.join(fnsDir, fn, '_shared', 'device-catalog.js')
      if (!fs.existsSync(target)) continue
      fs.copyFileSync(SOURCE, target)
      copies.push('cloudbase/cloudfunctions/' + fn + '/_shared/device-catalog.js')
    }
  }
  return copies
}

/* ---- 4. 保证加载 data.js 的页面先加载目录脚本 ---- */
function ensureScriptTags() {
  const dirs = fs.readdirSync(PROTOTYPE_DIR).filter((d) => {
    const p = path.join(PROTOTYPE_DIR, d)
    return fs.statSync(p).isDirectory()
  })
  let patched = 0
  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(PROTOTYPE_DIR, dir)).filter((f) => f.endsWith('.html'))
    for (const file of files) {
      const full = path.join(PROTOTYPE_DIR, dir, file)
      let html = fs.readFileSync(full, 'utf8')
      if (html.indexOf('assets/data.js') < 0) continue
      if (html.indexOf('assets/device-catalog.js') >= 0) continue
      /* 目录脚本必须在 data.js 之前：data.js 在加载时就要读到 DEVICE_CATALOG */
      html = html.replace(
        /(\s*)(<script src="\.\.\/assets\/data\.js"><\/script>)/,
        '$1<script src="../assets/device-catalog.js"></script>$1$2'
      )
      fs.writeFileSync(full, html, 'utf8')
      patched++
    }
  }
  return patched
}

injectMock(literal)
writeBrowser(literal)
const sharedCopies = syncSharedCopies()
const patched = ensureScriptTags()

console.log('设备目录同步完成：')
console.log('  ↳ cloudbase/miniprogram/utils/mock.js（注入 DEVICE_TREE）')
console.log('  ↳ prototype/assets/device-catalog.js（浏览器版）')
sharedCopies.forEach((p) => console.log('  ↳ ' + p))
console.log('  ↳ 补齐目录脚本引用的页面：' + patched + ' 个')
console.log('真源：cloudbase/device-catalog.js')
