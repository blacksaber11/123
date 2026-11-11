'use strict'

const nodeCrypto = require('node:crypto')
const { AppError, CODES } = require('./errors')

/** 密文格式版本，便于将来轮换算法 */
const CIPHER_VERSION = 'v1'
const AAD_SEP = '.'
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32, saltLen: 16 }
const TOTP_STEP_SEC = 30
const TOTP_DIGITS = 6

function decodeKey(raw, name) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError(CODES.INTERNAL, '服务密钥未配置')
  }
  const buf = Buffer.from(raw.trim(), 'base64')
  if (buf.length !== 32) {
    throw new AppError(CODES.INTERNAL, '服务密钥格式无效')
  }
  return buf
}

/**
 * 从环境变量加载密钥（fail closed）。
 * 缺失 / 长度不对直接抛错，云函数冷启动即失败，绝不降级为明文。
 */
function loadKeys(env) {
  const source = env || {}
  return {
    aesKey: decodeKey(source.AES_KEY_B64, 'AES_KEY_B64'),
    hmacKey: decodeKey(source.HMAC_KEY_B64, 'HMAC_KEY_B64')
  }
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

function fromB64u(str) {
  return Buffer.from(String(str), 'base64url')
}

/**
 * AES-256-GCM 字段级加密。随机 12 字节 IV，AAD 绑定「集合.字段.记录id」。
 * 输出：v1.<iv>.<tag>.<ct>（base64url）
 */
function encryptField({ keys, value, aad }) {
  if (!keys || !keys.aesKey) throw new AppError(CODES.INTERNAL, '服务密钥未配置')
  if (typeof value !== 'string') throw new AppError(CODES.VALIDATION, '加密内容必须是字符串')
  const iv = nodeCrypto.randomBytes(12)
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', keys.aesKey, iv)
  cipher.setAAD(Buffer.from(String(aad || ''), 'utf8'))
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [CIPHER_VERSION, b64u(iv), b64u(tag), b64u(ct)].join(AAD_SEP)
}

/**
 * 解密：任何失败（篡改 / AAD 不匹配 / 版本不对 / 密钥不对）统一抛 TAMPERED，
 * 不把 OpenSSL 细节或密文片段带出去。
 */
function decryptField({ keys, token, aad }) {
  try {
    if (!keys || !keys.aesKey) throw new Error('no key')
    const parts = String(token || '').split(AAD_SEP)
    if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) throw new Error('bad format')
    const iv = fromB64u(parts[1])
    const tag = fromB64u(parts[2])
    const ct = fromB64u(parts[3])
    if (iv.length !== 12 || tag.length !== 16) throw new Error('bad iv/tag')
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', keys.aesKey, iv)
    decipher.setAAD(Buffer.from(String(aad || ''), 'utf8'))
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ct), decipher.final()])
    return plain.toString('utf8')
  } catch (err) {
    throw new AppError(CODES.TAMPERED, '数据校验失败')
  }
}

/** 盲索引归一化：去首尾空白、小写、去空格/连字符/括号、去掉 +86 / 0086 前缀 */
function normalizeIndexValue(input) {
  let v = String(input == null ? '' : input).trim().toLowerCase()
  if (v.startsWith('+86')) v = v.slice(3)
  else if (v.startsWith('0086')) v = v.slice(4)
  return v.replace(/[\s\-()（）]/g, '')
}

function hmacHex(key, text) {
  return nodeCrypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex')
}

/** HMAC-SHA256 盲索引：精确查询只走这里，业务表不存明文 */
function blindIndex({ keys, value }) {
  if (!keys || !keys.hmacKey) throw new AppError(CODES.INTERNAL, '服务密钥未配置')
  return 'bi1.' + hmacHex(keys.hmacKey, 'bidx:' + normalizeIndexValue(value))
}

function sha256Hex(text) {
  return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 对外可见的用户 ID：由 openid 稳定派生，不落库、不泄露原始 openid。
 * 形如 U7K3M9QF，用户端与管理端展示同一串，便于「报 ID 查用户 / 开权限」。
 * 字符集去掉了 0/O/1/I 等易混字符，方便人工核对与口头转述。
 */
function userNoOf(uid) {
  const raw = sha256Hex('userNo|' + String(uid || ''))
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[parseInt(raw.slice(i * 2, i * 2 + 2), 16) % alphabet.length]
  }
  return 'U' + out
}

function randomToken(bytes) {
  return nodeCrypto.randomBytes(bytes || 32).toString('hex')
}

function randomId(prefix) {
  const tail = nodeCrypto.randomBytes(6).toString('hex')
  return String(prefix || '') + Date.now().toString(36) + tail
}

/** 口令哈希：scrypt$N$r$p$salt$hash */
function hashPassword(plain) {
  const salt = nodeCrypto.randomBytes(SCRYPT.saltLen)
  const hash = nodeCrypto.scryptSync(String(plain), salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024
  })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const N = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])
    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0) return false
    const actual = nodeCrypto.scryptSync(String(plain), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024
    })
    return constantTimeEqual(actual, expected)
  } catch (err) {
    return false
  }
}

/** 常量时间比较，长度不同也走一次比较避免明显的时间侧信道 */
function constantTimeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8')
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8')
  if (x.length !== y.length) {
    nodeCrypto.timingSafeEqual(x, x)
    return false
  }
  return nodeCrypto.timingSafeEqual(x, y)
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 解码（RFC4648，无填充），用于 TOTP secret */
function base32Decode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/[\s=]/g, '')
  if (!clean || /[^A-Z2-7]/.test(clean)) {
    throw new AppError(CODES.INTERNAL, 'TOTP 密钥格式无效')
  }
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

function totpAt(secret, counter) {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter % 0x100000000, 4)
  const digest = nodeCrypto.createHmac('sha1', key).update(buf).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

function generateTotp(secret, atMs) {
  const ms = typeof atMs === 'number' ? atMs : Date.now()
  return totpAt(secret, Math.floor(ms / 1000 / TOTP_STEP_SEC))
}

/** 校验 TOTP，允许 ±1 个时间步长（时钟漂移） */
function verifyTotp(secret, code, atMs, window) {
  const input = String(code == null ? '' : code).trim()
  if (!/^\d{6}$/.test(input)) return false
  const ms = typeof atMs === 'number' ? atMs : Date.now()
  const current = Math.floor(ms / 1000 / TOTP_STEP_SEC)
  const span = typeof window === 'number' ? Math.abs(window) : 1
  let matched = false
  for (let offset = -span; offset <= span; offset += 1) {
    let candidate
    try {
      candidate = totpAt(secret, current + offset)
    } catch (err) {
      return false
    }
    if (constantTimeEqual(candidate, input)) matched = true
  }
  return matched
}

module.exports = {
  CIPHER_VERSION,
  loadKeys,
  encryptField,
  decryptField,
  normalizeIndexValue,
  blindIndex,
  hmacHex,
  sha256Hex,
  userNoOf,
  randomToken,
  randomId,
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  base32Decode,
  generateTotp,
  verifyTotp
}
