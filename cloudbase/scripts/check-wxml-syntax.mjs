#!/usr/bin/env node
/**
 * WXML 语法预检：拦截小程序模板里的非法写法，避免开发者工具编译报错。
 *
 * 检查项：
 * 1. HTML 专属标签（br / b / i / span / label / div ...）——小程序只认内置组件
 * 2. 模板表达式里的箭头函数（notices.filter(x => ...)）——WXML 表达式不支持
 * 3. 标签闭合是否配对
 * 4. wx:for 的 wx:key 是否缺失
 */
import fs from 'node:fs'
import path from 'node:path'

/* 默认根目录按脚本位置推导，避免在仓库根目录执行时扫描不到任何文件却「假绿」 */
const DEFAULT_ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../miniprogram')
const ROOT = path.resolve(process.argv[2] || DEFAULT_ROOT)
const problems = []

/* 小程序内置组件白名单 */
const BUILTIN = new Set([
  'view', 'text', 'image', 'button', 'input', 'textarea', 'label', 'form',
  'scroll-view', 'swiper', 'swiper-item', 'navigator', 'icon', 'rich-text',
  'progress', 'slider', 'switch', 'picker', 'picker-view', 'picker-view-column',
  'checkbox', 'checkbox-group', 'radio', 'radio-group', 'label',
  'movable-area', 'movable-view', 'cover-view', 'cover-image', 'match-media',
  'page-meta', 'navigation-bar', 'open-data', 'official-account', 'ad',
  'camera', 'canvas', 'map', 'video', 'audio', 'live-player', 'live-pusher',
  'web-view', 'block', 'slot', 'template', 'import', 'include', 'wxs'
])

/* 明确禁止的 HTML 标签 */
const HTML_TAGS = [
  'br', 'b', 'i', 'u', 'em', 'strong', 'span', 'p', 'div', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'small', 'section', 'article',
  'header', 'footer', 'main', 'aside', 'nav', 'table', 'thead', 'tbody',
  'tr', 'td', 'th', 'hr', 'img', 'a', 'pre', 'code', 'font', 'center'
]

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.wxml')) out.push(p)
  }
  return out
}

const files = fs.existsSync(ROOT) ? walk(ROOT) : []

/* 扫描不到文件说明路径配错了：直接失败，不允许 0 文件通过 */
if (!files.length) {
  console.log(`WXML 语法检查失败：目录 ${ROOT} 下没有找到任何 .wxml 文件`)
  process.exit(1)
}

for (const file of files) {
  const rel = path.relative(ROOT, file)
  const src = fs.readFileSync(file, 'utf8')

  // 1. 禁止的 HTML 标签
  const htmlRe = new RegExp(`</?(?:${HTML_TAGS.join('|')})(?:\\s[^>]*)?/?>`, 'gi')
  let m
  while ((m = htmlRe.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    problems.push(`${rel}:${line} 非法 HTML 标签 <${m[0].replace(/[<>/]/g, '').split(/\s/)[0]}>，请改用 view / text`)
  }

  // 2. 模板表达式里的箭头函数 / function
  const exprRe = /\{\{([\s\S]*?)\}\}/g
  while ((m = exprRe.exec(src))) {
    const expr = m[1]
    const line = src.slice(0, m.index).split('\n').length
    if (/=>/.test(expr)) {
      problems.push(`${rel}:${line} 模板表达式不支持箭头函数：{{${expr.trim()}}}，请在 JS 里预先计算`)
    }
    if (/\bfunction\b/.test(expr)) {
      problems.push(`${rel}:${line} 模板表达式不支持 function 声明`)
    }
  }

  // 3. 标签闭合配对（只查自定义/未知标签的显式闭合）
  const stack = []
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
  const voidLike = new Set(['image', 'input', 'icon', 'progress', 'slider', 'switch', 'import', 'include', 'wxs'])
  while ((m = tagRe.exec(src))) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClose = m[4] === '/'
    if (tag === '!doctype') continue
    if (closing) {
      const top = stack.pop()
      if (top !== tag) {
        const line = src.slice(0, m.index).split('\n').length
        problems.push(`${rel}:${line} 标签闭合不匹配：</${tag}> 对应的开启标签是 <${top || '无'}>`)
      }
    } else if (!selfClose && !voidLike.has(tag)) {
      stack.push(tag)
    }
  }
  if (stack.length) {
    const line = src.split('\n').length
    problems.push(`${rel}:${line} 以下标签未闭合：${stack.join(' > ')}`)
  }

  // 4. wx:for 缺 wx:key
  const forRe = /wx:for="\{\{[^}]*\}\}"(?![^>]*wx:key)/g
  while ((m = forRe.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length
    problems.push(`${rel}:${line} wx:for 缺少 wx:key`)
  }

  // 5. 文本中的字面量 \n（不会被解析成换行，会原样显示出来）
  const masked = src.replace(/\{\{[\s\S]*?\}\}/g, (s) => ' '.repeat(s.length))
  const nlRe = /\\n/g
  while ((m = nlRe.exec(masked))) {
    const line = masked.slice(0, m.index).split('\n').length
    problems.push(`${rel}:${line} 文本中的 \\n 不会被解析为换行，请改用 <text class="br-line"> 分行`)
  }
}

if (problems.length) {
  console.log('WXML 语法问题：')
  problems.forEach((p) => console.log('  - ' + p))
  process.exit(1)
} else {
  console.log(`WXML 语法检查通过（${files.length} 个文件）`)
}
