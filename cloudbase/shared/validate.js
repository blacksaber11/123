'use strict'

const { AppError, CODES } = require('./errors')
const { PAGING } = require('./constants')

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const IDCARD_RE = /(?<![\dXx])\d{17}[\dXx](?![\dXx])/

function isEmpty(v) {
  return v === undefined || v === null || String(v).trim() === ''
}

function str(value, opts) {
  const o = opts || {}
  const field = o.field || '参数'
  if (isEmpty(value)) {
    if (o.required) throw new AppError(CODES.VALIDATION, `请填写${field}`)
    return o.default === undefined ? '' : o.default
  }
  const s = String(value).trim()
  const min = typeof o.min === 'number' ? o.min : 0
  const max = typeof o.max === 'number' ? o.max : 500
  if (s.length < min) throw new AppError(CODES.VALIDATION, `${field}至少 ${min} 个字`)
  if (s.length > max) throw new AppError(CODES.VALIDATION, `${field}不能超过 ${max} 个字`)
  return s
}

function enumOf(value, allowed, field) {
  const s = String(value == null ? '' : value).trim()
  if (!allowed.includes(s)) throw new AppError(CODES.VALIDATION, `${field || '参数'}取值不合法`)
  return s
}

function arrayOfStrings(value, opts) {
  const o = opts || {}
  const field = o.field || '列表'
  if (value === undefined || value === null) return o.default ? o.default.slice() : []
  /* 单选字段（税费等）历史上以字符串提交：宽容为单元素数组，避免旧客户端一直被拦 */
  if (typeof value === 'string' || typeof value === 'number') {
    const one = str(value, { field: `${field}项`, max: typeof o.itemMax === 'number' ? o.itemMax : 60 })
    return one ? [one] : []
  }
  if (!Array.isArray(value)) throw new AppError(CODES.VALIDATION, `${field}格式不正确`)
  const max = typeof o.max === 'number' ? o.max : 20
  if (value.length > max) throw new AppError(CODES.VALIDATION, `${field}最多 ${max} 项`)
  const itemMax = typeof o.itemMax === 'number' ? o.itemMax : 60
  return value.map((item) => str(item, { field: `${field}项`, max: itemMax })).filter((item) => item !== '')
}

/**
 * 手机号标准化：全角转半角后只保留数字，再剥离 +86 / 0086 / 13 位 86 前缀，
 * 校验 11 位大陆手机号。与小程序 utils/validate.js 同口径：
 * 粘贴进来的「+86 138-0013-8000」「手机：13800138000」、零宽字符等杂质都能兼容。
 */
function normalizePhone(input) {
  const digits = String(input == null ? '' : input)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
  let raw = digits
  if (digits.length === 15 && digits.slice(0, 4) === '0086') raw = digits.slice(4)
  else if (digits.length === 13 && digits.slice(0, 2) === '86') raw = digits.slice(2)
  if (!/^1[3-9]\d{9}$/.test(raw)) {
    /* 具体到原因，避免用户只看到「手机号不对」却不知道哪里错 */
    if (String(input == null ? '' : input).indexOf('*') > -1) {
      throw new AppError(CODES.VALIDATION, '请填写完整手机号，不要填带 * 的脱敏号码')
    }
    if (!raw) throw new AppError(CODES.VALIDATION, '请填写 11 位手机号')
    if (raw.length !== 11) {
      throw new AppError(CODES.VALIDATION, `手机号需 11 位数字，当前 ${raw.length} 位，请检查`)
    }
    throw new AppError(CODES.VALIDATION, '手机号需以 1 开头且为 11 位，请检查')
  }
  return raw
}

/**
 * 联系电话（手机 / 座机 / 400）宽松标准化。
 * 代采 / 代售的联系人可能留座机或分机，不再强制 11 位大陆手机号；
 * 只要求 6–20 位数字，仍拦截带 * 的脱敏号码。
 */
function normalizeContactPhone(input) {
  const text = String(input == null ? '' : input)
  if (text.indexOf('*') > -1) {
    throw new AppError(CODES.VALIDATION, '请填写完整联系电话，不要填带 * 的脱敏号码')
  }
  const digits = text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
  let raw = digits
  if (digits.length === 15 && digits.slice(0, 4) === '0086') raw = digits.slice(4)
  else if (digits.length === 13 && digits.slice(0, 2) === '86') raw = digits.slice(2)
  if (!raw) throw new AppError(CODES.VALIDATION, '请填写联系电话')
  if (!/^\d{6,20}$/.test(raw)) {
    throw new AppError(CODES.VALIDATION, `联系电话需 6–20 位数字，当前 ${raw.length} 位，请检查`)
  }
  return raw
}

/** 脱敏：138****6688 */
function maskPhone(input) {
  const digits = String(input == null ? '' : input).replace(/\D/g, '')
  if (digits.length < 7) return ''
  return digits.slice(0, 3) + '****' + digits.slice(-4)
}

function maskName(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return ''
  if (s.length === 1) return s + '*'
  return s.slice(0, 1) + '*'.repeat(Math.max(1, s.length - 1))
}

/** 身份标识（openid / 账号）脱敏，仅保留尾号 */
function maskIdentity(id) {
  const s = String(id == null ? '' : id).trim()
  if (s.length <= 4) return '***'
  return '***' + s.slice(-4)
}

/** 文本内出现的手机号 / 证件号统一打码（审计与日志用） */
function maskSensitiveText(input) {
  let s = String(input == null ? '' : input)
  s = s.replace(new RegExp(PHONE_RE.source, 'g'), (m) => m.slice(0, 3) + '****' + m.slice(-4))
  s = s.replace(new RegExp(IDCARD_RE.source, 'g'), (m) => m.slice(0, 4) + '*'.repeat(10) + m.slice(-4))
  return s
}

function containsPhone(input) {
  return PHONE_RE.test(String(input == null ? '' : input))
}

function containsIdCard(input) {
  return IDCARD_RE.test(String(input == null ? '' : input))
}

/**
 * 材料文件引用：只接受上传接口返回的 https 直链或云存储 fileID。
 * 客户端本地路径、其他协议一律丢弃，不落库；超长字符串同样视为无效。
 */
function fileRef(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s || s.length > 512) return ''
  if (/^https:\/\/[^\s]+$/i.test(s)) return s
  if (/^cloud:\/\/[^\s]+$/i.test(s)) return s
  return ''
}

/** 强制分页：limit ≤ 50，page 超过 100 页截断 */
function normalizePaging(input) {
  const raw = input || {}
  let limit = Number(raw.limit)
  if (!Number.isFinite(limit) || limit <= 0) limit = PAGING.defaultLimit
  limit = Math.min(Math.floor(limit), PAGING.maxLimit)
  let page = Number(raw.page)
  if (!Number.isFinite(page) || page <= 0) page = 1
  page = Math.floor(page)
  const capped = page > PAGING.maxPage
  return {
    page: capped ? PAGING.maxPage : page,
    limit,
    skip: capped ? PAGING.maxPage * limit : (page - 1) * limit,
    capped
  }
}

module.exports = {
  isEmpty,
  str,
  enumOf,
  arrayOfStrings,
  normalizePhone,
  normalizeContactPhone,
  maskPhone,
  maskName,
  maskIdentity,
  maskSensitiveText,
  containsPhone,
  containsIdCard,
  fileRef,
  normalizePaging
}
