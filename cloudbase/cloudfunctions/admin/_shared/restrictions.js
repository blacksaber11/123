'use strict'

/**
 * 用户功能限制（管理端「调整账号」里设置）：
 *   publish 发布内容（商品 / 需求）
 *   news    发布资讯（资讯圈投稿）
 *   chat    发起对话（直聊 / 咨询 / 商机对接）
 *
 * 只落「截止时间戳」，到期自动恢复，不需要定时任务清理；
 * 服务端每次操作前校验，避免只靠前端按钮置灰被绕过。
 */

const { AppError, CODES } = require('./errors')

const DAY_MS = 24 * 3600 * 1000

const RESTRICT_KINDS = {
  publish: { label: '发布内容', hint: '商品与需求的发布、提交' },
  news: { label: '发布资讯', hint: '资讯圈投稿' },
  chat: { label: '发起对话', hint: '直聊、咨询与商机对接' }
}

const RESTRICT_FIELDS = {
  publish: 'publishUntil',
  news: 'newsUntil',
  chat: 'chatUntil'
}

/** 截止时间按北京时间展示，与站内其他时间口径一致 */
function formatUntil(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
}

function ruleOf(user) {
  const rule = user && user.restrictions
  return rule && typeof rule === 'object' ? rule : {}
}

/** 当前生效的限制；已过期视为无限制 */
function activeRestriction(user, kind, at) {
  const field = RESTRICT_FIELDS[kind]
  if (!field) return null
  const rule = ruleOf(user)
  const until = Number(rule[field]) || 0
  const nowMs = Number(at) || Date.now()
  if (!(until > nowMs)) return null
  return {
    until,
    untilText: formatUntil(until),
    daysLeft: Math.max(1, Math.ceil((until - nowMs) / DAY_MS)),
    reason: String(rule.reason || '')
  }
}

/** 拦截：告诉用户限制到什么时候、为什么，以及去哪里申诉 */
function assertAllowed(user, kind, at) {
  const hit = activeRestriction(user, kind, at)
  if (!hit) return
  const label = (RESTRICT_KINDS[kind] && RESTRICT_KINDS[kind].label) || '该功能'
  throw new AppError(
    CODES.FORBIDDEN,
    `你的「${label}」功能已被限制至 ${hit.untilText}` +
      (hit.reason ? `（原因：${hit.reason}）` : '') +
      '，如有疑问请在「我的」联系在线客服'
  )
}

/** 管理端展示：三类限制的当前状态 */
function stateOf(user, at) {
  const out = { reason: String(ruleOf(user).reason || '') }
  Object.keys(RESTRICT_FIELDS).forEach((kind) => {
    const hit = activeRestriction(user, kind, at)
    out[kind] = hit ? Object.assign({ label: RESTRICT_KINDS[kind].label }, hit) : null
  })
  return out
}

/**
 * 管理端提交：{ publish / news / chat: 天数, reason }
 *   天数为 0 → 解除该限制；不传 → 保持不动
 * 重复处罚从「当前截止时间」往后顺延，避免多次举报只算一次。
 */
function applyRestrictions(user, input, at, operator) {
  const src = input && typeof input === 'object' ? input : {}
  const prev = ruleOf(user)
  const next = Object.assign({}, prev)
  const nowMs = Number(at) || Date.now()
  Object.keys(RESTRICT_FIELDS).forEach((kind) => {
    const raw = src[kind]
    if (raw === undefined || raw === null || raw === '') return
    const days = Number(raw)
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      throw new AppError(CODES.VALIDATION, '限制天数需在 0 - 365 天之间')
    }
    const field = RESTRICT_FIELDS[kind]
    const base = Math.max(nowMs, Number(prev[field]) || 0)
    next[field] = days === 0 ? 0 : base + Math.round(days * DAY_MS)
  })
  const reason = src.reason === undefined ? String(prev.reason || '') : String(src.reason || '').trim().slice(0, 200)
  next.reason = reason
  next.updatedAt = nowMs
  next.updatedBy = operator || ''
  const changed = Object.keys(RESTRICT_FIELDS).some((kind) => {
    return (Number(next[RESTRICT_FIELDS[kind]]) || 0) !== (Number(prev[RESTRICT_FIELDS[kind]]) || 0)
  })
  return { restrictions: next, changed }
}

module.exports = {
  DAY_MS,
  RESTRICT_KINDS,
  RESTRICT_FIELDS,
  activeRestriction,
  assertAllowed,
  stateOf,
  applyRestrictions,
  formatUntil
}
