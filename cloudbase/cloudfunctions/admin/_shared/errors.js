'use strict'

/**
 * 统一错误码。
 * 对外只返回 { code, message }，绝不暴露堆栈、SQL、密钥、手机号等内部信息。
 */
const CODES = Object.freeze({
  OK: 'OK',
  VALIDATION: 'VALIDATION', // 入参校验失败
  UNAUTHENTICATED: 'UNAUTHENTICATED', // 未登录 / 登录已过期 / 账号口令错误
  FORBIDDEN: 'FORBIDDEN', // 越权
  NOT_FOUND: 'NOT_FOUND', // 资源不存在
  CONFLICT: 'CONFLICT', // 状态冲突 / 唯一约束冲突
  RATE_LIMITED: 'RATE_LIMITED', // 触发限流
  EXPIRED: 'EXPIRED', // 临时凭证过期
  TAMPERED: 'TAMPERED', // 签名 / 密文校验失败
  INTERNAL: 'INTERNAL' // 未预期异常，统一对外文案
})

const DEFAULT_MESSAGES = Object.freeze({
  OK: '成功',
  VALIDATION: '参数不合法',
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '无权限执行该操作',
  NOT_FOUND: '资源不存在',
  CONFLICT: '当前状态不允许该操作',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  EXPIRED: '链接已过期',
  TAMPERED: '数据校验失败',
  INTERNAL: '服务暂时不可用'
})

class AppError extends Error {
  constructor(code, message, meta) {
    super(message || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.INTERNAL)
    this.name = 'AppError'
    this.code = CODES[code] ? code : CODES.INTERNAL
    this.meta = meta || null
    this.expose = true
  }
}

function isAppError(err) {
  return !!(err && err.name === 'AppError' && typeof err.code === 'string')
}

/** 内部异常 → 对外安全结构。非 AppError 一律折叠为 INTERNAL。 */
function toPublic(err) {
  if (isAppError(err)) {
    return { code: err.code, message: err.message || DEFAULT_MESSAGES[err.code] || DEFAULT_MESSAGES.INTERNAL }
  }
  return { code: CODES.INTERNAL, message: DEFAULT_MESSAGES.INTERNAL }
}

module.exports = { CODES, DEFAULT_MESSAGES, AppError, isAppError, toPublic }
