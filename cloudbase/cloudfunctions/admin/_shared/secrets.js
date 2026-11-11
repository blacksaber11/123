'use strict'

/**
 * 保密措施核心：敏感字段的加密落库与最小化回显。
 *
 * 规则（红线，来自《平台整体逻辑设计 v3.2》9.4 / 9.5）：
 * 1. 联系方式、证件号、主体全称等敏感字段一律 AES-256-GCM 字段级加密，业务表只存密文；
 * 2. 需要精确检索的字段（手机号）额外存 HMAC 盲索引，不做明文索引、不可反推；
 * 3. 对外投影只给脱敏值（138****6688、字*），明文只在「管理端 + 已对接 + 原因 + 审计」四重约束下释放；
 * 4. 任何响应体在返回前都扫描一遍，出现明文手机号 / 证件号即视为泄漏并拒绝出站。
 *
 * 密文格式：v1.<iv>.<tag>.<ct>（base64url），AAD 绑定「集合.字段.记录id」，
 * 防止把 A 记录的密文搬到 B 记录上解密（越权搬运）。
 */

const { AppError, CODES } = require('./errors')
const { encryptField, decryptField, blindIndex } = require('./crypto')
const { maskPhone, maskName, maskIdentity } = require('./validate')

/** 字段 → 脱敏函数。列表与详情都只走这里。 */
const MASK_BY_FIELD = Object.freeze({
  phone: maskPhone,
  realname: maskName,
  contact: maskName,
  subject: (v) => (v ? String(v).slice(0, 2) + '***' : ''),
  idCard: (v) => (v ? String(v).slice(0, 4) + '******************' : ''),
  bankAccount: (v) => (v ? String(v).slice(0, 4) + '********' : ''),
  address: (v) => (v ? String(v).slice(0, 6) + '***' : '')
})

/**
 * 为某个集合 / 记录生成敏感字段的加密载荷。
 * @param {object} opts.keys 服务密钥
 * @param {string} opts.collection 集合名
 * @param {string} opts.recordId 记录 id（AAD 的一部分）
 * @param {object} opts.fields 明文字段值，键为字段名
 * @returns {object} 可直接落库的补丁：{ phoneCipher, phoneBidx, realnameCipher, ... }
 */
function encryptFields({ keys, collection, recordId, fields }) {
  const out = {}
  const src = fields || {}
  for (const field of Object.keys(src)) {
    const value = src[field]
    if (value === undefined || value === null || String(value).trim() === '') continue
    const text = String(value)
    const aad = `${collection}.${field}.${recordId}`
    out[`${field}Cipher`] = encryptField({ keys, value: text, aad })
    // 只有需要精确检索的字段才建盲索引
    if (field === 'phone') {
      out[`${field}Bidx`] = blindIndex({ keys, value: text })
    }
  }
  return out
}

/**
 * 解密单个字段。解密失败一律视为 TAMPERED，不回传任何密文片段。
 */
function decryptFieldOf({ keys, collection, field, recordId, cipher }) {
  if (!cipher) return ''
  const aad = `${collection}.${field}.${recordId}`
  return decryptField({ keys, token: cipher, aad })
}

/**
 * 脱敏回显：给前端看的永远是脱敏值。
 */
function masked(field, value) {
  const fn = MASK_BY_FIELD[field]
  if (!fn) return value
  return fn(value)
}

/**
 * 主体摘要（六项资质口径）：只给状态与类型，不给原件与联系方式。
 * 这是需求详情、商品详情对外部署名的唯一出口。
 */
function subjectSummary(doc) {
  if (!doc) return { realname: '', subjectType: '', hasPhone: false }
  return {
    realname: '',
    subjectType: doc.subjectType || '',
    hasPhone: !!doc.phoneCipher
  }
}

/**
 * 审计用摘要：谁做了什么，但不落明文。
 */
function auditSubject(doc) {
  if (!doc) return { id: '', name: '' }
  return {
    id: doc.id || '',
    name: doc.nick ? maskIdentity(doc.nick) : ''
  }
}

/**
 * 安全断言：确认某集合的一条记录里不存在明文敏感字段。
 * 用于 publish 前自检，防止新增字段时把明文写进库。
 */
function assertNoPlaintextFields(collection, doc, plaintextFields) {
  const fields = plaintextFields || ['phone', 'realname', 'idCard', 'contact', 'subject']
  for (const field of fields) {
    const value = doc[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() !== '') {
      throw new AppError(CODES.INTERNAL, '服务暂时不可用', { leakAt: `${collection}.${field}` })
    }
  }
  return true
}

module.exports = {
  MASK_BY_FIELD,
  encryptFields,
  decryptFieldOf,
  masked,
  subjectSummary,
  auditSubject,
  assertNoPlaintextFields
}
