/**
 * 手机号标准化与校验。
 *
 * 必须与云函数 cloudbase/shared/validate.js 的 normalizePhone 同口径：
 * 全角转半角后只保留数字，再剥离 +86 / 0086 / 13 位 86 前缀，最后按 ^1[3-9]\d{9}$ 判定。
 * 用户粘贴进来的号码常带空格、连字符、括号、+86 前缀，甚至夹着「手机」字样或零宽字符，
 * 只按空白 / 连字符清理仍会把合法号码误判成不合法，所以这里统一只认数字。
 */

/** 全角字符转半角（中文输入法下可能打出全角数字） */
function toHalfWidth(input) {
  return String(input == null ? '' : input)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 标准化：返回纯数字串（含去掉的 +86 / 0086 / 86 前缀），交由 isValidPhone 判定 */
function normalizePhone(input) {
  const digits = toHalfWidth(input).replace(/\D/g, '')
  if (digits.length === 15 && digits.slice(0, 4) === '0086') return digits.slice(4)
  if (digits.length === 13 && digits.slice(0, 2) === '86') return digits.slice(2)
  return digits
}

/** 是否为合法大陆手机号（内部先标准化） */
function isValidPhone(input) {
  return /^1[3-9]\d{9}$/.test(normalizePhone(input))
}

/**
 * 校验失败时给具体原因：只写「请填写 11 位手机号」用户无法自查，
 * 这里直接说明当前位数，或点明填成了带 * 的脱敏号码。
 */
function phoneError(input) {
  const raw = toHalfWidth(input).trim()
  if (raw.indexOf('*') > -1) return '请填写完整手机号，不要填带 * 的脱敏号码'
  const digits = normalizePhone(raw)
  if (!digits) return '请填写 11 位手机号'
  return '手机号需 11 位数字，当前 ' + digits.length + ' 位，请检查'
}

/**
 * 联系电话（手机 / 座机 / 400）宽松校验。
 * 代采 / 代售的联系人可能留座机或分机，不再强制 11 位大陆手机号：
 * 只要求 6–20 位数字，仍拦截带 * 的脱敏号码与空值。
 */
function isValidContactPhone(input) {
  const raw = toHalfWidth(input).trim()
  if (raw.indexOf('*') > -1) return false
  const digits = normalizePhone(raw)
  return digits.length >= 6 && digits.length <= 20
}

function contactPhoneError(input) {
  const raw = toHalfWidth(input).trim()
  if (raw.indexOf('*') > -1) return '请填写完整联系电话，不要填带 * 的脱敏号码'
  const digits = normalizePhone(raw)
  if (!digits) return '请填写联系电话'
  return '联系电话需 6–20 位数字，当前 ' + digits.length + ' 位，请检查'
}

module.exports = { normalizePhone, isValidPhone, phoneError, isValidContactPhone, contactPhoneError }
