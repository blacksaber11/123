'use strict'

const path = require('node:path')
const { AppError, CODES } = require('./errors')
const { MATERIAL_TYPES, MATERIAL_ALLOWED_EXT, MATERIAL_BLOCKED_EXT, MAX_MATERIAL_NAME_LEN, MATERIAL_LINK_TTL_MS, MEDIA_SIZE_TEXT } = require('./constants')
const { hmacHex, constantTimeEqual } = require('./crypto')
const { maskPhone } = require('./validate')

const EXT_TO_TYPE = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v'
})

/** 文件名净化：去掉目录、控制字符、路径穿越片段，只保留安全字符 */
function sanitizeFileName(name) {
  let base = String(name == null ? '' : name).replace(/\\/g, '/')
  base = base.split('/').pop() || ''
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w.\-\u4e00-\u9fa5()（） ]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) base = 'file'
  if (base.length > MAX_MATERIAL_NAME_LEN) {
    const ext = path.extname(base).slice(0, 12)
    base = base.slice(0, MAX_MATERIAL_NAME_LEN - ext.length) + ext
  }
  return base
}

function extensionOf(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase()
}

/**
 * 材料类型 / 大小 / 文件名白名单校验。
 * svg / html / js / exe 等一律拒绝；大小上限按手机常规拍摄体量设定（图片 10MB / 文档 20MB / 视频 50MB）。
 */
function assertMaterialFile(input) {
  const rawName = String((input && input.name) || '')
  const name = sanitizeFileName(rawName)
  const ext = extensionOf(name)
  if (!ext || MATERIAL_BLOCKED_EXT.includes(ext) || !MATERIAL_ALLOWED_EXT.includes(ext)) {
    throw new AppError(CODES.VALIDATION, '不支持的材料类型')
  }
  const type = String((input && input.type) || EXT_TO_TYPE[ext] || '').toLowerCase()
  const spec = MATERIAL_TYPES[type]
  if (!spec || !spec.ext.includes(ext)) {
    throw new AppError(CODES.VALIDATION, '不支持的材料类型')
  }
  const size = Number(input && input.size)
  if (!Number.isFinite(size) || size <= 0) throw new AppError(CODES.VALIDATION, '材料大小不合法')
  if (size > spec.maxBytes) {
    throw new AppError(CODES.VALIDATION, MEDIA_SIZE_TEXT[spec.kind] || '材料大小超出限制')
  }
  return { name, type, size: Math.floor(size), kind: spec.kind, ext }
}

/** 存储路径：materials/<uid>/<时间戳>_<随机>_<净化文件名>，按 ownerUid 隔离 */
function buildStoragePath(uid, name, atMs) {
  const safeUid = String(uid || '').replace(/[^A-Za-z0-9_-]/g, '') || 'anon'
  const clean = sanitizeFileName(name)
  return `materials/${safeUid}/${atMs || Date.now()}_${Math.random().toString(36).slice(2, 8)}_${clean}`
}

/** 只允许访问自己目录下的云文件；cloud://<env>/materials/<uid>/... */
function assertOwnedStoragePath(fileId, uid) {
  const id = String(fileId || '')
  const m = /^cloud:\/\/[^/]+\/materials\/([A-Za-z0-9_-]+)\//.exec(id)
  if (!m) throw new AppError(CODES.VALIDATION, '文件路径不合法')
  if (m[1] !== String(uid)) throw new AppError(CODES.FORBIDDEN, '只能访问本人上传的材料')
  return id
}

function isPublicUrl(url) {
  const s = String(url || '')
  if (!/^https?:\/\//i.test(s)) return false
  return /(\.tcb\.qcloud\.la|\.myqcloud\.com|\.cos\.|cos\.ap-|storage\.)/i.test(s)
}

/** 禁止把材料原件做成公网直链 */
function assertNoPublicUrl(url) {
  if (isPublicUrl(url)) throw new AppError(CODES.FORBIDDEN, '禁止使用公网直链访问材料')
  return true
}

function signMaterialLink(opts) {
  const { keys, fileId, uid, leadId, exp, storagePath } = opts
  if (!keys || !keys.hmacKey) throw new AppError(CODES.INTERNAL, '服务密钥未配置')
  const payload = ['material-link:v1', fileId, uid, leadId, exp].join('\n')
  const sig = hmacHex(keys.hmacKey, payload)
  const q = [
    'fileId=' + encodeURIComponent(fileId),
    'uid=' + encodeURIComponent(uid),
    'leadId=' + encodeURIComponent(leadId),
    'exp=' + exp,
    'sig=' + sig
  ].join('&')
  const pathPart = String(storagePath || fileId).replace(/^cloud:\/\/[^/]+\//, '')
  return { url: `cloudfile://${pathPart}?${q}`, exp, sig }
}

/**
 * 校验临时链接：过期 / 换人 / 换线索 / 篡改全部拒绝。
 * 链接里的 uid 与 leadId 必须与当前查看人和线索完全一致。
 */
function verifyMaterialLink(opts) {
  const { keys, url, uid, leadId, now } = opts
  let parsed
  try {
    parsed = new URL(String(url))
  } catch (err) {
    throw new AppError(CODES.TAMPERED, '链接无效')
  }
  if (parsed.protocol !== 'cloudfile:') throw new AppError(CODES.TAMPERED, '链接无效')
  const q = parsed.searchParams
  const exp = Number(q.get('exp'))
  const sig = String(q.get('sig') || '')
  const fileId = String(q.get('fileId') || '')
  const linkUid = String(q.get('uid') || '')
  const linkLead = String(q.get('leadId') || '')
  if (!Number.isFinite(exp) || !sig || !fileId) throw new AppError(CODES.TAMPERED, '链接无效')

  const expected = hmacHex(keys.hmacKey, ['material-link:v1', fileId, linkUid, linkLead, exp].join('\n'))
  if (!constantTimeEqual(expected, sig)) throw new AppError(CODES.TAMPERED, '链接校验失败')
  if (linkUid !== String(uid)) throw new AppError(CODES.FORBIDDEN, '该链接不属于当前查看人')
  if (linkLead !== String(leadId)) throw new AppError(CODES.FORBIDDEN, '该链接与当前线索不匹配')
  const at = typeof now === 'number' ? now : Date.now()
  if (exp <= at) throw new AppError(CODES.EXPIRED, '链接已过期，请重新获取')
  return { fileId, uid: linkUid, leadId: linkLead, exp }
}

/**
 * 动态水印：查看人账号尾号（8 位）+ 线索号 + 时间 + 禁止转发。
 * 尾号取 8 位而不是 4 位，保证同一平台内可唯一定位到具体账号，泄漏后可定向追责。
 */
function watermarkText(uid, leadId, atMs) {
  const at = typeof atMs === 'number' ? atMs : Date.now()
  const iso = new Date(at).toISOString().replace('T', ' ').slice(0, 19)
  const tail = String(uid == null ? '' : uid).slice(-8) || '未知'
  return `账号 ${tail} · 线索 ${leadId} · ${iso} · 禁止转发/下载`
}

module.exports = {
  sanitizeFileName,
  assertMaterialFile,
  buildStoragePath,
  assertOwnedStoragePath,
  isPublicUrl,
  assertNoPublicUrl,
  signMaterialLink,
  verifyMaterialLink,
  watermarkText,
  maskPhone,
  MATERIAL_LINK_TTL_MS
}
