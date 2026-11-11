'use strict'

const { AUDIT_RETENTION_DAYS } = require('./constants')
const { randomId } = require('./crypto')
const { maskSensitiveText, maskIdentity, maskPhone } = require('./validate')

const DROP_KEYS = /(cipher|password|passwd|secret|token|otp|sig|phonebidx|key)/i

/** 深度脱敏：手机号 / 证件号打码，敏感字段直接丢弃 */
function maskDeep(value, depth) {
  const level = typeof depth === 'number' ? depth : 0
  if (level > 6) return '[deep]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return maskSensitiveText(value).slice(0, 500)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => maskDeep(item, level + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (DROP_KEYS.test(key)) {
        out[key] = '[redacted]'
        continue
      }
      out[key] = maskDeep(value[key], level + 1)
    }
    return out
  }
  return '[unknown]'
}

/** 审计记录对外投影（再次脱敏，双保险） */
function projectAudit(entry) {
  return {
    id: entry.id,
    actorType: entry.actorType,
    actorId: maskIdentity(entry.actorId),
    action: entry.action,
    target: entry.target ? String(entry.target).slice(0, 80) : '',
    reason: entry.reason ? maskSensitiveText(entry.reason).slice(0, 200) : '',
    ip: entry.ip ? String(entry.ip).replace(/(\d+)$/, '***') : '',
    result: entry.result,
    at: entry.at
  }
}

function retentionCutoff(now) {
  return (typeof now === 'number' ? now : Date.now()) - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000
}

function isExpired(entry, now) {
  return !entry || Number(entry.at) < retentionCutoff(now)
}

/**
 * 追加式审计：只有 append，没有 update / delete。
 * 写入前统一脱敏（手机号打码、敏感字段丢弃）。
 * 任何审计写入失败都不影响主流程。
 */
async function appendAudit(repo, entry) {
  const at = typeof entry.at === 'number' ? entry.at : Date.now()
  const doc = {
    id: entry.id || randomId('A'),
    actorType: entry.actorType || 'system',
    actorId: String(entry.actorId || 'system'),
    action: String(entry.action || 'unknown'),
    target: maskDeep(entry.target === undefined ? '' : entry.target),
    reason: maskDeep(entry.reason === undefined ? '' : entry.reason),
    ip: maskDeep(entry.ip === undefined ? '' : entry.ip),
    result: String(entry.result || 'allow'),
    at,
    retentionDays: AUDIT_RETENTION_DAYS
  }
  // 双保险：即使调用方误传明文，也不会以明文落库
  if (typeof doc.target === 'string') doc.target = maskPhoneText(doc.target)
  if (typeof doc.reason === 'string') doc.reason = maskPhoneText(doc.reason)
  try {
    await repo.insert('audit', doc)
  } catch (err) {
    // 审计不可阻塞业务，也不能把内部错误抛给调用方
  }
  return doc
}

function maskPhoneText(text) {
  return String(text).replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2')
}

module.exports = { appendAudit, projectAudit, maskDeep, isExpired, retentionCutoff, maskPhone }
