'use strict'

/**
 * 型号归一与匹配：云函数与小程序共用同一份实现。
 *
 * 通过 scripts/sync-shared.mjs 同步到 cloudfunctions/_shared 与 miniprogram/utils，
 * 两端匹配口径必须一致，否则「平台说匹配、本地库存说不匹配」。
 * 注意：小程序 JS 引擎不支持正则后行断言，这里只用普通的字母/数字边界替换。
 */

/** 型号归一化：忽略大小写、空格与常见分隔符，避免「H100 80G」与「h100-80g」匹配不上 */
function normModel(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[\s\-_/·,，、+]+/g, '')
}

/** 拆词元：归一化后按字母 / 数字边界切分，如 a10080gpcie → a 100 80 g pcie */
function tokensOf(value) {
  return normModel(value)
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
}

/**
 * 型号命中：相等或互相包含（H100 80G ⊂ H100 80G SXM）即命中；
 * 否则看词元重合，至少 2 个（且不超过较短一方的词元数）。
 */
function modelHit(left, right) {
  const a = normModel(left)
  const b = normModel(right)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const ta = tokensOf(left)
  const tb = tokensOf(right)
  if (!ta.length || !tb.length) return false
  const hits = ta.filter((t) => tb.includes(t)).length
  return hits >= Math.min(2, Math.min(ta.length, tb.length))
}

/** 核心型号：字母 + 数字的芯片 / 平台标识，如 b300、gb300、h100、a100、910b、mi355x */
const CORE_LETTERS_FIRST = /^[a-z]{1,6}\d{1,5}[a-z]{0,3}$/
const CORE_DIGITS_FIRST = /^\d{3,4}[a-z]{1,2}$/

/** 容量词：80g / 80gb / 288g；带 T 的口径（4T、8T）在目录里语义不统一，不参与比对 */
const CAPACITY_TOKEN = /^\d+(?:\.\d+)?(?:gb|g)$/

/**
 * 提取核心型号（可能多个，如「PowerEdge XE9680L B300」同时含 xe9680l 与 b300）。
 * 只保留字母数字混合的标识：纯数字（数量、年份、卡数）与容量词都排除，
 * 这样「B300」不会命中「GB300」，「288G」也不会被当成型号。
 */
function modelCoreOf(value) {
  const raw = String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/)
  const out = []
  for (const token of raw) {
    if (!token) continue
    if (CAPACITY_TOKEN.test(token)) continue
    if (!CORE_LETTERS_FIRST.test(token) && !CORE_DIGITS_FIRST.test(token)) continue
    if (out.indexOf(token) < 0) out.push(token)
  }
  return out
}

/** 显存容量：统一成「数字 + g」，如 80G / 80GB / 288G；未写容量时返回空串 */
function capacityOf(value) {
  const text = String(value == null ? '' : value).toLowerCase()
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:gb|g)(?![a-z0-9])/)
  if (!m) return ''
  const num = Number(m[1])
  if (!(num > 0)) return ''
  return Math.round(num) + 'g'
}

/**
 * 分层匹配：先比核心型号，再比容量。
 * 1. 双方都写了容量且不同 → 不同规格，直接不命中（96G 不应命中 72G）；
 * 2. 双方都能识别核心型号 → 核心有交集即命中，品牌、系列、整机 / 加速卡描述都不参与；
 * 3. 任一方识别不出核心型号（如 RTX 5090 这类纯数字型号）→ 退回 modelHit 宽松匹配，
 *    兼容老数据与目录外的自由填写。
 */
function modelMatch(left, right) {
  const capA = capacityOf(left)
  const capB = capacityOf(right)
  if (capA && capB && capA !== capB) return false
  const coresA = modelCoreOf(left)
  const coresB = modelCoreOf(right)
  if (coresA.length && coresB.length) {
    return coresA.some((core) => coresB.indexOf(core) >= 0)
  }
  return modelHit(left, right)
}

/**
 * 检索归一：忽略大小写、空白与常见分隔符，H100 80G → h10080g。
 * 让「H10080G」与「H100 80G」互相命中，不必按目录里的书写方式带空格。
 */
function normSearch(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[\s\-_/·,，、+|]+/g, '')
}

/** 检索分词：按空白 / 分隔符切词后逐词归一，供乱序多词查询使用 */
function searchTokensOf(value) {
  return String(value == null ? '' : value)
    .split(/[\s\-_/·,，、+|]+/)
    .map(normSearch)
    .filter(Boolean)
}

/**
 * 模糊检索：一个入口覆盖多种输入方式。
 * 1. 整串包含：H10080G 命中「H100 80G SXM」；
 * 2. 多词乱序且不必相邻：h100 sxm / 80g h100 都命中；
 * 3. 连写乱序：5600ddr5 拆成 5600 + ddr5；
 * 4. 子序列兜底（关键词 ≥4 位）：h1080g 这类漏字的输入也能命中。
 */
function searchHit(text, keyword) {
  const kw = normSearch(keyword)
  if (!kw) return true
  const hay = normSearch(text)
  if (!hay) return false
  if (hay.indexOf(kw) >= 0) return true
  const tokens = searchTokensOf(keyword)
  if (tokens.length > 1 && tokens.every((t) => hay.indexOf(t) >= 0)) return true
  if (kw.length < 4) return false
  /* 连写又乱序：5600ddr5 → 5600 + ddr5，枚举一处切分，两段都出现即命中 */
  for (let i = 2; i <= kw.length - 2; i++) {
    if (hay.indexOf(kw.slice(0, i)) >= 0 && hay.indexOf(kw.slice(i)) >= 0) return true
  }
  /* 子序列兜底：h1080g 这类漏字输入也能命中 */
  let i = 0
  for (let j = 0; j < hay.length && i < kw.length; j++) {
    if (hay.charAt(j) === kw.charAt(i)) i++
  }
  return i === kw.length
}

module.exports = {
  normModel,
  tokensOf,
  modelHit,
  modelCoreOf,
  capacityOf,
  modelMatch,
  normSearch,
  searchTokensOf,
  searchHit
}
