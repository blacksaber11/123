#!/usr/bin/env node
/**
 * 小程序静态检查：校验 WXML 的数据引用是否在 Page data 中声明，
 * 以及 bindtap / bindinput 等事件是否在对应 JS 中存在。
 * 仅用于本地开发期自检，不进入小程序包。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] || 'cloudbase/miniprogram')
const PAGES_DIR = path.join(ROOT, 'pages')

const problems = []

/** 收集 wxml 中 {{ }} 表达式里的顶层标识符 */
function collectRefs(wxml) {
  const refs = new Set()
  const re = /\{\{([\s\S]*?)\}\}/g
  let m
  while ((m = re.exec(wxml))) {
    const expr = m[1]
    // 去掉字符串字面量
    const cleaned = expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
    // 顶层标识符：不在 . 属性访问之前的词
    const idRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g
    let im
    while ((im = idRe.exec(cleaned))) {
      const name = im[2]
      // 排除 JS 关键字与内置
      if (['true', 'false', 'null', 'undefined', 'item', 'index', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON'].includes(name)) continue
      refs.add(name)
    }
  }
  return refs
}

/** 收集 wxml 中的事件绑定 */
function collectHandlers(wxml) {
  const hs = new Set()
  const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?[a-zA-Z-]*="([^"{}]+)"/g
  let m
  while ((m = re.exec(wxml))) hs.add(m[1].trim())
  return hs
}

/** 从 JS 源码里粗略抓 Page({...}) 内的标识符与函数名 */
function parsePage(js) {
  const dataKeys = new Set()
  const methods = new Set()
  const dataMatch = js.match(/data\s*:\s*\{/)
  if (dataMatch) {
    const start = dataMatch.index + dataMatch[0].length
    let depth = 1
    let i = start
    for (; i < js.length && depth > 0; i++) {
      const ch = js[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const body = js.slice(start, i - 1)
    const keyRe = /([A-Za-z_$][\w$]*)\s*:/g
    let m
    while ((m = keyRe.exec(body))) {
      // 排除对象字面量的嵌套 key（简单处理：只取第一层后仍需人工确认）
      dataKeys.add(m[1])
    }
  }
  const fnRe = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm
  let m
  while ((m = fnRe.exec(js))) methods.add(m[1])
  return { dataKeys, methods }
}

const pages = fs.existsSync(PAGES_DIR)
  ? fs.readdirSync(PAGES_DIR).filter((d) => fs.statSync(path.join(PAGES_DIR, d)).isDirectory())
  : []

for (const page of pages) {
  const wxmlPath = path.join(PAGES_DIR, page, `${page}.wxml`)
  const jsPath = path.join(PAGES_DIR, page, `${page}.js`)
  if (!fs.existsSync(wxmlPath)) continue
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  let js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : ''

  /* 页面实现可能拆到同目录 / 上级目录的 *-core.js（如 mine.js → mine-core.js）：跟着 require 读一次 */
  if (!/data\s*:\s*\{/.test(js)) {
    const req = js.match(/require\(['"](\.[^'"]+)['"]\)/)
    if (req) {
      const target = path.resolve(path.dirname(jsPath), req[1])
      const file = target.endsWith('.js') ? target : target + '.js'
      if (fs.existsSync(file)) js += '\n' + fs.readFileSync(file, 'utf8')
    }
  }

  // 1. 事件绑定必须有同名方法
  const { methods } = parsePage(js)
  for (const h of collectHandlers(wxml)) {
    if (!methods.has(h)) {
      problems.push(`${page}.wxml: 事件 ${h} 在 ${page}.js 中未定义`)
    }
  }

  // 2. 顶层数据引用必须在 data 中声明（允许集合/属性链首段）
  const { dataKeys } = parsePage(js)
  for (const ref of collectRefs(wxml)) {
    if (dataKeys.has(ref)) continue
    // 可能是 wx:for-item 的别名或模块级常量
    const aliasRe = new RegExp(`wx:for-item\\s*=\\s*"\\{?\\{?\\s*${ref}\\b`)
    if (aliasRe.test(wxml)) continue
    const constRe = new RegExp(`const\\s+${ref}\\s*=|let\\s+${ref}\\s*=|\\b${ref}\\s*:`)
    if (constRe.test(js)) continue
    problems.push(`${page}.wxml: 数据引用 {{${ref}}} 未在 ${page}.js 的 data 中声明`)
  }
}

if (problems.length) {
  console.log('发现问题：')
  problems.forEach((p) => console.log('  - ' + p))
  process.exit(1)
} else {
  console.log('检查通过：事件绑定与数据引用均已匹配')
}
