'use strict'

/**
 * 生产 HTTP 服务（阿里云 ECS · PM2 单实例）。
 *
 * 提供：
 *   POST /api/auth/login   小程序 wx.login(code) → openid → 登录，签发 HMAC 会话令牌
 *   POST /api/user         用户端业务接口（Bearer Token）
 *   POST /api/admin        运营中台接口（登录令牌，沿用 shared 层会话表）
 *   GET  /api/health       健康检查（不返回任何凭证）
 *   GET  /admin/           运营中台静态页
 *   GET  /user/            用户端原型静态页
 *
 * 业务逻辑全部复用 shared/ 目录，本文件只负责进程、HTTP、鉴权与静态资源。
 */

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

/* ---------- 0. 先加载 .env（PM2 env 里只放路径，密钥落盘 600 权限文件） ---------- */
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const idx = text.indexOf('=')
    if (idx <= 0) continue
    const key = text.slice(0, idx).trim()
    let value = text.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = value
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', '.env'))

const { createRouter } = require('../shared/router')
const { createCache } = require('../shared/cache')
const { loadKeys, hmacHex, constantTimeEqual, randomToken, sha256Hex } = require('../shared/crypto')
const { chatCutoff, mediaCutoff } = require('../shared/chatmedia')
const { ROLES } = require('../shared/constants')
const { createMysqlRepo } = require('./repo.mysql')
const { createMarketAdminHandlers } = require('../shared/market')

const PORT = Number(process.env.PORT || 3002)
const HOST = process.env.HOST || '127.0.0.1'
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'quals')
const CHAT_UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'chat')
const MAX_BODY = 2 * 1024 * 1024
/* 发布 / 资质上传：图片 10MB、PDF 20MB、视频 50MB，与 shared/constants 的 MEDIA_MAX_BYTES 保持一致 */
const UPLOAD_IMAGE_MAX = 10 * 1024 * 1024
const UPLOAD_DOC_MAX = 20 * 1024 * 1024
const UPLOAD_VIDEO_MAX = 50 * 1024 * 1024
const UPLOAD_MAX = UPLOAD_VIDEO_MAX
/* 聊天媒体：图片 10MB、视频 50MB，与 shared/constants 的 CHAT_MEDIA_MAX_BYTES 保持一致 */
const CHAT_IMAGE_MAX = 10 * 1024 * 1024
const CHAT_VIDEO_MAX = 50 * 1024 * 1024
const UPLOAD_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v'
}
const TOKEN_TTL_MS = Number(process.env.USER_TOKEN_TTL_MS || 30 * 24 * 3600 * 1000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function fail(message) {
  console.error('[boot] ' + message)
  process.exit(1)
}

/* ---------- 1. 密钥 / 仓储 / 路由 ---------- */
let keys
try {
  keys = loadKeys({
    AES_KEY_B64: process.env.AES_KEY_B64,
    HMAC_KEY_B64: process.env.HMAC_KEY_B64
  })
} catch (err) {
  fail('AES_KEY_B64 / HMAC_KEY_B64 未配置或格式错误，服务拒绝启动')
}

const MYSQL_URL = String(process.env.MYSQL_URL || '').trim()
if (!MYSQL_URL) fail('MYSQL_URL 未配置')

const repo = createMysqlRepo({ url: MYSQL_URL, connectionLimit: Number(process.env.DB_POOL || 10) })
const cache = createCache({ env: process.env })
const notify = {
  inquiry: (payload) => sendSubscribe({
    openid: payload.openid,
    templateId: payload.templateId,
    page: 'pages/msg/msg',
    title: payload.title || '你发布的内容',
    body: payload.targetType === 'demand' ? '收到新的需求响应' : '收到新的商品咨询',
    at: payload.at
  }),
  chat: (payload) => sendSubscribe({
    openid: payload.openid,
    templateId: payload.templateId,
    page: payload.page || 'pages/msg/msg',
    title: payload.sender || '平台用户',
    body: payload.preview || '你有一条新消息',
    at: payload.at
  }),
  /* 系统消息：审核结果、平台通知等站内信的微信提醒 */
  system: (payload) => sendSubscribe({
    openid: payload.openid,
    templateId: payload.templateId,
    page: payload.page || 'pages/msg/msg',
    title: payload.title || '平台通知',
    body: payload.body || '你有一条新的系统消息',
    at: payload.at
  }),
  /* 商机消息：新的匹配商机 / 会员到期提醒 */
  biz: (payload) => sendSubscribe({
    openid: payload.openid,
    templateId: payload.templateId,
    page: payload.page || 'pages/msg/msg',
    title: payload.title || '商机提醒',
    body: payload.body || '有新的匹配商机',
    at: payload.at
  })
}

const userRouter = createRouter({
  repo,
  keys,
  cache,
  scope: 'user',
  env: process.env,
  now: () => Date.now(),
  notify,
  exchangePhone: phoneByCode
})

const adminRouter = createRouter({
  repo,
  keys,
  cache,
  scope: 'admin',
  env: process.env,
  now: () => Date.now(),
  notify
})

/* ---------- 2. 小程序会话令牌（无状态 HMAC，不落库） ---------- */
function issueUserToken(openid) {
  const payload = Buffer.from(String(openid), 'utf8').toString('base64url')
  const exp = String(Date.now() + TOKEN_TTL_MS)
  const sig = hmacHex(keys.hmacKey, 'user-token:' + payload + ':' + exp)
  return 'u1.' + payload + '.' + exp + '.' + sig
}

function verifyUserToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 4 || parts[0] !== 'u1') return ''
  const exp = Number(parts[2])
  if (!Number.isFinite(exp) || exp < Date.now()) return ''
  const expect = hmacHex(keys.hmacKey, 'user-token:' + parts[1] + ':' + parts[2])
  if (!constantTimeEqual(expect, parts[3])) return ''
  try {
    return Buffer.from(parts[1], 'base64url').toString('utf8')
  } catch (err) {
    return ''
  }
}

function bearer(req) {
  const raw = String(req.headers.authorization || '')
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1].trim() : ''
}

/* ---------- 3. 微信 jscode2session ---------- */
function code2session(code) {
  return new Promise((resolve, reject) => {
    const appid = String(process.env.WX_APPID || '')
    const secret = String(process.env.WX_SECRET || '')
    if (!appid || !secret) return reject(new Error('WX_APPID / WX_SECRET 未配置'))
    const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(appid) +
      '&secret=' + encodeURIComponent(secret) +
      '&js_code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code'
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (raw.length < 16384) raw += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch (err) {
          reject(new Error('微信接口返回格式异常'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('微信接口超时')))
    req.on('error', reject)
  })
}

/* ---------- 3.1 微信手机号快捷验证 ---------- */
let wxTokenCache = { value: '', expireAt: 0 }

function httpsJson(url, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : ''
    const req = https.request(url, {
      method: method || 'GET',
      timeout: 8000,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {}
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (raw.length < 16384) raw += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch (err) {
          reject(new Error('微信接口返回格式异常'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('微信接口超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function wxAccessToken() {
  if (wxTokenCache.value && wxTokenCache.expireAt > Date.now() + 60000) return wxTokenCache.value
  const appid = String(process.env.WX_APPID || '')
  const secret = String(process.env.WX_SECRET || '')
  if (!appid || !secret) throw new Error('WX_APPID / WX_SECRET 未配置')
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential' +
    '&appid=' + encodeURIComponent(appid) + '&secret=' + encodeURIComponent(secret)
  const res = await httpsJson(url, 'GET')
  if (!res || !res.access_token) throw new Error((res && res.errmsg) || '获取微信 access_token 失败')
  wxTokenCache = {
    value: String(res.access_token),
    expireAt: Date.now() + (Number(res.expires_in) || 7200) * 1000
  }
  return wxTokenCache.value
}

/** 客户端 getPhoneNumber 的 code → 明文手机号（仅服务端内存中出现，落库前加密） */
async function phoneByCode(code) {
  const token = await wxAccessToken()
  const res = await httpsJson(
    'https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + encodeURIComponent(token),
    'POST',
    { code }
  )
  if (!res || res.errcode) {
    if (res && (res.errcode === 40001 || res.errcode === 42001)) wxTokenCache = { value: '', expireAt: 0 }
    throw new Error((res && res.errmsg) || '手机号授权失败')
  }
  const info = res.phone_info || {}
  return info.purePhoneNumber || info.phoneNumber || ''
}

/* ---------- 3.2 微信订阅消息 ---------- */
function beijingTime(ms) {
  const d = new Date(Number(ms || Date.now()) + 8 * 60 * 60 * 1000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
}

/* 订阅消息模板的字段编号由所选模板决定（thing7 / time2 等），
   启动后拉取一次模板列表并缓存 1 小时：按模板内容顺序映射「标题 / 内容 / 时间」三字段。 */
let tmplFieldCache = { at: 0, map: null }

async function templateFields(templateId) {
  if (tmplFieldCache.map && tmplFieldCache.at > Date.now() - 3600 * 1000 && tmplFieldCache.map[templateId]) {
    return tmplFieldCache.map[templateId]
  }
  try {
    const token = await wxAccessToken()
    const res = await httpsJson(
      'https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=' + encodeURIComponent(token),
      'GET'
    )
    if (res && res.errcode) throw new Error(res.errmsg || '模板读取失败')
    const map = {}
    ;((res && res.data) || []).forEach((tpl) => {
      const matched = String(tpl.content || '').match(/{{(thing\d+|time\d+|date\d+)\.DATA}}/g) || []
      const keys = matched.map((k) => k.replace(/[{}]/g, '').replace('.DATA', ''))
      const things = keys.filter((k) => k.indexOf('thing') === 0)
      const times = keys.filter((k) => k.indexOf('time') === 0 || k.indexOf('date') === 0)
      if (things.length) {
        map[tpl.priTmplId] = { title: things[0], body: things[1] || things[0], time: times[0] || 'time3' }
      }
    })
    tmplFieldCache = { at: Date.now(), map }
    if (map[templateId]) return map[templateId]
  } catch (err) { /* 拉取失败时按常见模板字段兜底，不影响站内消息 */ }
  return { title: 'thing1', body: 'thing2', time: 'time3' }
}

async function subscribeData(templateId, title, body, at) {
  const fields = await templateFields(templateId)
  const data = {}
  data[fields.title] = { value: String(title || '').slice(0, 20) }
  data[fields.body] = { value: String(body || '').slice(0, 20) }
  data[fields.time] = { value: beijingTime(at) }
  return data
}

/** 订阅消息发送：字段名按实际模板解析，调用方只提供标题 / 内容 / 时间 */
async function sendSubscribe(payload) {
  const openid = String((payload && payload.openid) || '')
  const templateId = String((payload && payload.templateId) || '')
  if (!templateId || !openid) return { ok: false, reason: 'unconfigured' }
  const token = await wxAccessToken()
  const data = payload.data || await subscribeData(templateId, payload.title, payload.body, payload.at)
  const res = await httpsJson(
    'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + encodeURIComponent(token),
    'POST',
    {
      touser: openid,
      template_id: templateId,
      page: payload.page || 'pages/msg/msg',
      miniprogram_state: process.env.MINIPROGRAM_STATE || 'formal',
      lang: 'zh_CN',
      data
    }
  )
  if (res && (res.errcode === 40001 || res.errcode === 42001)) wxTokenCache = { value: '', expireAt: 0 }
  if (!res || res.errcode) throw new Error((res && res.errmsg) || '订阅消息发送失败')
  return { ok: true }
}

/* ---------- 4. HTTP 工具 ---------- */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
}

/* ---------- 资质原件上传（替代云存储） ---------- */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('文件过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 从 multipart/form-data 中取出 name="file" 的部分（latin1 保证字节一一对应） */
function parseMultipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''))
  if (!m) throw new Error('上传格式不支持')
  const boundary = '--' + String(m[1] || m[2]).trim()
  const raw = buf.toString('latin1')
  for (const seg of raw.split(boundary)) {
    const headerEnd = seg.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const headers = seg.slice(0, headerEnd)
    if (!/name="file"/i.test(headers)) continue
    let body = seg.slice(headerEnd + 4)
    if (body.endsWith('\r\n')) body = body.slice(0, -2)
    const ct = /content-type:\s*([^\r\n;]+)/i.exec(headers)
    return { buffer: Buffer.from(body, 'latin1'), type: String(ct ? ct[1] : 'image/jpeg').toLowerCase().trim() }
  }
  return null
}

/* ---------- 4.2 上传：用户素材 / 聊天图片视频 ---------- */
/**
 * 上传鉴权：小程序用户令牌，或管理端会话令牌（聊天里平台也要能给用户发图片 / 视频）。
 * 管理端令牌只查 sessions 表，不信任客户端声明的角色。
 */
async function uploaderOf(req) {
  const token = bearer(req)
  if (!token) return null
  const openid = verifyUserToken(token)
  if (openid) return { kind: 'user', id: openid }
  try {
    const rows = await repo.find('sessions', { tokenHash: sha256Hex(token) }, { limit: 1 })
    const row = rows[0]
    /* 角色值统一取自 constants.ROLES（小写 admin / cs），与登录写入的会话保持一致 */
    if (row && Number(row.expiresAt) > Date.now() && [ROLES.ADMIN, ROLES.CS].includes(String(row.role || ''))) {
      return { kind: 'staff', id: 'staff:' + String(row.accountId || row.username || '') }
    }
  } catch (err) { /* 查询失败按未登录处理 */ }
  return null
}

/* 上传频率：单账号 10 分钟窗口，防止脚本刷满磁盘 */
const uploadHits = new Map()
/* 聊天媒体上传并发上限：50MB 视频整包读入内存，3 路并发峰值约 150MB，留足余量 */
const CHAT_UPLOAD_CONCURRENCY = 3
let uploadingChat = 0
/* 发布 / 资质媒体同理：视频最大 50MB，限制并发避免内存被打满 */
const MEDIA_UPLOAD_CONCURRENCY = 4
let uploadingMedia = 0
/* 登录频率：按来源 IP 限制，挡住撞库 / 暴力破解 */
const loginHits = new Map()
function rateOk(map, key, max, windowMs) {
  const nowMs = Date.now()
  const hit = map.get(key)
  if (!hit || hit.resetAt <= nowMs) {
    if (map.size > 5000) {
      for (const [k, v] of map) if (v.resetAt <= nowMs) map.delete(k)
    }
    map.set(key, { count: 1, resetAt: nowMs + windowMs })
    return true
  }
  hit.count += 1
  return hit.count <= max
}

/** 文件头识别：不信任客户端 Content-Type，只认真实字节 */
function sniffMedia(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.toString('latin1', 0, 4) === '%PDF') return 'application/pdf'
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    /* ISO BMFF 家族：按 brand 区分 MP4 / MOV / M4V，iPhone 默认拍 MOV */
    const brand = buf.toString('latin1', 8, 12)
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return 'video/x-m4v'
    return 'video/mp4'
  }
  return ''
}

function chatExt(type) {
  if (type === 'image/jpeg') return '.jpg'
  if (type === 'image/png') return '.png'
  if (type === 'image/webp') return '.webp'
  if (type === 'video/mp4') return '.mp4'
  if (type === 'video/quicktime') return '.mov'
  if (type === 'video/x-m4v') return '.m4v'
  return ''
}

/** 发布 / 资质媒体的单文件大小上限（按真实类型判断） */
function uploadLimitOf(type) {
  if (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/x-m4v') return UPLOAD_VIDEO_MAX
  if (type === 'application/pdf') return UPLOAD_DOC_MAX
  return UPLOAD_IMAGE_MAX
}

function uploadSizeText(type) {
  if (type === 'video/mp4' || type === 'video/quicktime' || type === 'video/x-m4v') return '视频不能超过 50MB'
  if (type === 'application/pdf') return 'PDF 不能超过 20MB'
  return '图片不能超过 10MB'
}

async function handleUpload(req, res, url) {
  const chat = String((url && url.searchParams.get('kind')) || '') === 'chat'
  if (!chat) {
    if (uploadingMedia >= MEDIA_UPLOAD_CONCURRENCY) {
      return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '上传人数较多，请稍后再试' })
    }
    uploadingMedia += 1
    try {
      return await handleUploadInner(req, res, false)
    } finally {
      uploadingMedia -= 1
    }
  }
  /* 视频单文件最大 50MB，解析时要整体读入内存：限制并发，避免几路同时上传把进程内存打满 */
  if (uploadingChat >= CHAT_UPLOAD_CONCURRENCY) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '上传人数较多，请稍后再试' })
  }
  uploadingChat += 1
  try {
    return await handleUploadInner(req, res, true)
  } finally {
    uploadingChat -= 1
  }
}

async function handleUploadInner(req, res, chat) {
  const who = await uploaderOf(req)
  if (!who) {
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '登录已过期，请重新登录' })
  }
  if (!rateOk(uploadHits, (chat ? 'c:' : 'q:') + who.id, chat ? 60 : 20, 10 * 60 * 1000)) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '上传过于频繁，请稍后再试' })
  }
  const maxBytes = chat ? CHAT_VIDEO_MAX : UPLOAD_MAX
  let raw
  try {
    raw = await readRawBody(req, maxBytes + 1024 * 1024)
  } catch (err) {
    return sendJson(res, 200, {
      ok: false,
      code: 'VALIDATION',
      message: err && err.message === '文件过大'
        ? (chat ? '视频不能超过 50MB，图片不能超过 10MB' : '图片不能超过 10MB，PDF 不能超过 20MB，视频不能超过 50MB')
        : '上传失败，请重试'
    })
  }
  let file
  try {
    file = parseMultipartFile(raw, req.headers['content-type'])
  } catch (err) {
    file = null
  }
  if (!file) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: chat ? '请选择要上传的图片或视频' : '请选择要上传的文件' })
  }
  /* 以文件头为准判断真实类型，避免改扩展名绕过 */
  const realType = sniffMedia(file.buffer)
  const ext = chat ? chatExt(realType) : UPLOAD_TYPES[realType]
  if (!ext) {
    return sendJson(res, 200, {
      ok: false,
      code: 'VALIDATION',
      message: chat
        ? '聊天仅支持 JPG / PNG / WEBP 图片与 MP4 / MOV / M4V 视频'
        : '仅支持 JPG / PNG / WEBP 图片、PDF 文件与 MP4 / MOV / M4V 视频'
    })
  }
  if (!file.buffer.length) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '文件内容为空' })
  }
  if (chat && realType.startsWith('video/') && file.buffer.length > CHAT_VIDEO_MAX) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '视频不能超过 50MB' })
  }
  if (chat && !realType.startsWith('video/') && file.buffer.length > CHAT_IMAGE_MAX) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '图片不能超过 10MB' })
  }
  if (!chat && file.buffer.length > uploadLimitOf(realType)) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: uploadSizeText(realType) })
  }
  /* 聊天文件名带时间戳前缀，清理任务按修改时间即可识别 7 天未读媒体 */
  const name = (chat ? Date.now().toString(36) + '_' : '') + randomToken(chat ? 16 : 12) + ext
  const dir = chat ? CHAT_UPLOAD_DIR : UPLOAD_DIR
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, name), file.buffer)
  } catch (err) {
    console.error('[upload] ' + (err && err.message ? err.message : 'write failed'))
    return sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '上传失败，请重试' })
  }
  const host = String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '')
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https'
  const folder = chat ? 'chat' : 'quals'
  sendJson(res, 200, {
    ok: true,
    code: 'OK',
    data: { fileId: proto + '://' + host + '/uploads/' + folder + '/' + name, type: realType, size: file.buffer.length }
  })
}

async function serveStatic(req, res, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
  if (rel === '/' || rel === '' || rel === '/admin' || rel === '/admin/') rel = '/admin/index.html'
  if (rel === '/user' || rel === '/user/') rel = '/user/home.html'
  if (rel.split('/').some((part) => part.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const target = path.resolve(PUBLIC_DIR, '.' + rel)
  if (!target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  const ext = path.extname(target).toLowerCase()
  if (!MIME[ext]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile()) throw new Error('not a file')
    const compressible = ['.html', '.js', '.css', '.json', '.svg'].includes(ext)
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    const isUpload = rel.startsWith('/uploads/')
    const headers = {
      'Content-Type': MIME[ext],
      /* 管理端 / 用户端页面与脚本必须每次回源校验，避免部署后浏览器继续用旧脚本 */
      'Cache-Control': isUpload ? 'private, max-age=86400'
        : (['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600'),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
      ETag: '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"'
    }
    /* 视频需要支持 Range（iOS / 微信内置播放器会分段请求） */
    const isVideo = ['.mp4', '.mov', '.m4v'].includes(ext)
    if (isVideo) headers['Accept-Ranges'] = 'bytes'
    if (isVideo && req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim())
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]))
        let end = m[1] ? (m[2] ? Number(m[2]) : stat.size - 1) : stat.size - 1
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= stat.size || end < start) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
          res.end()
          return
        }
        end = Math.min(end, stat.size - 1)
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size
        headers['Content-Length'] = end - start + 1
        res.writeHead(206, headers)
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        fs.createReadStream(target, { start, end }).pipe(res)
        return
      }
    }
    if (compressible && acceptsGzip) {
      const gz = gzipCached(target, stat)
      headers['Content-Encoding'] = 'gzip'
      headers['Content-Length'] = gz.length
      headers.Vary = 'Accept-Encoding'
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : gz)
      return
    }
    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(target).pipe(res)
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

/* 静态资源 gzip 缓存：大文件每次同步压缩会阻塞事件循环（压测中 console.pages.js 仅 3 rps），
   按 文件+mtime+size 缓存压缩结果，最多保留 40 份 */
const gzipCache = new Map()
const GZIP_CACHE_MAX = 40
function gzipCached(target, stat) {
  const key = target + '|' + stat.size + '|' + stat.mtimeMs
  const hit = gzipCache.get(key)
  if (hit) return hit
  const gz = zlib.gzipSync(fs.readFileSync(target), { level: 6 })
  if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value)
  gzipCache.set(key, gz)
  return gz
}

/* ---------- 5. 业务入口 ---------- */
async function handleUserLogin(req, res) {
  if (!rateOk(loginHits, 'u:' + clientIp(req), 30, 10 * 60 * 1000)) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '登录过于频繁，请稍后再试' })
  }
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
  }
  const devOpenid = process.env.ALLOW_DEV_OPENID === '1'
    ? String(body.devOpenid || '').trim()
    : ''
  let openid = devOpenid
  if (!openid) {
    const code = String(body.code || '').trim()
    if (!code) {
      return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '缺少微信登录凭证' })
    }
    try {
      const session = await code2session(code)
      if (!session || !session.openid) {
        const errcode = Number((session && session.errcode) || 0)
        const reason = String((session && session.errmsg) || '微信登录失败')
        /* 微信原始报文含服务器出口 IP / rid，只在服务端日志留证，不下发给小程序 */
        console.error('[wx] code2session errcode=' + errcode + ' errmsg=' + reason)
        const message = errcode === 40029 || errcode === 40163
          ? '登录凭证已失效，请重新登录'
          : '微信登录服务暂时不可用，请稍后重试或联系平台客服'
        return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message })
      }
      openid = String(session.openid)
    } catch (err) {
      return sendJson(res, 200, { ok: false, code: 'INTERNAL', message: '微信登录服务暂时不可用' })
    }
  }
  const result = await userRouter.dispatch('auth.login', {
    nick: body.nick,
    avatar: body.avatar
  }, { openid, ip: clientIp(req), appid: String(process.env.WX_APPID || '') })
  if (!result || !result.ok) {
    return sendJson(res, 200, result || { ok: false, code: 'INTERNAL', message: '登录失败' })
  }
  sendJson(res, 200, {
    ok: true,
    code: 'OK',
    data: { token: issueUserToken(openid), user: result.data }
  })
}

async function handleUser(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
  }
  const openid = verifyUserToken(bearer(req) || String(body.token || ''))
  if (!openid) {
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '登录已过期，请重新登录' })
  }
  const action = typeof body.action === 'string' ? body.action : ''
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
  const result = await userRouter.dispatch(action, data, {
    openid,
    ip: clientIp(req),
    appid: String(process.env.WX_APPID || '')
  })
  sendJson(res, 200, result)
}

async function handleAdmin(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
  }
  const action = typeof body.action === 'string' ? body.action : ''
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
  const token = String(body.token || bearer(req) || '')
  if (action === 'auth.login' && !rateOk(loginHits, 'a:' + clientIp(req), 20, 10 * 60 * 1000)) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '登录过于频繁，请稍后再试' })
  }
  const result = await adminRouter.dispatch(action, data, { token, ip: clientIp(req) })
  sendJson(res, 200, result)
}

/* ---------- 5.05 微信消息推送（小程序后台 → 开发管理 → 消息推送） ----------
 * 虚拟支付的「道具发货推送 xpay_goods_deliver_notify」也从这里进来。
 * 后台保存配置时会先 GET 校验 URL：签名通过必须原样返回 echostr。
 * 加密方式按明文模式接入，Token 与后台填写的值保持一致（WX_MSG_TOKEN）。
 */
const WX_MSG_TOKEN = String(process.env.WX_MSG_TOKEN || '').trim()

function wxMsgSignatureOk(params) {
  if (!WX_MSG_TOKEN) return false
  const signature = String(params.get('signature') || '')
  const timestamp = String(params.get('timestamp') || '')
  const nonce = String(params.get('nonce') || '')
  if (!signature || !timestamp || !nonce) return false
  const expect = crypto.createHash('sha1')
    .update([WX_MSG_TOKEN, timestamp, nonce].sort().join(''))
    .digest('hex')
  return constantTimeEqual(expect, signature)
}

/** 明文 XML 取单层字段；GoodsInfo 这类嵌套内容以其 CDATA 原文再取一次 */
function xmlField(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(String(xml || ''))
  if (!m) return ''
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim()
}

async function handleWxMsg(req, res, url) {
  if (req.method === 'GET') {
    if (!wxMsgSignatureOk(url.searchParams)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('invalid signature')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(url.searchParams.get('echostr') || ''))
    return
  }
  /* 明文模式：POST 同样带 signature；不校验等于允许任何人伪造「发货成功」白拿会员 */
  if (!wxMsgSignatureOk(url.searchParams)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('invalid signature')
    return
  }
  const raw = (await readRawBody(req, 256 * 1024)).toString('utf8')
  /* 加密模式接入时 XML 里只有 Encrypt，需要先解密才能处理，这里明确拒绝并留日志 */
  if (xmlField(raw, 'Encrypt')) {
    console.error('[wx-msg] 收到加密报文，请把消息推送改为明文模式')
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end('<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[need plaintext mode]]></ErrMsg></xml>')
    return
  }
  const event = xmlField(raw, 'Event')
  if (event === 'xpay_goods_deliver_notify') {
    const goods = xmlField(raw, 'GoodsInfo')
    const payload = {
      openid: xmlField(raw, 'OpenId'),
      outTradeNo: xmlField(raw, 'OutTradeNo'),
      env: xmlField(raw, 'Env'),
      productId: xmlField(goods, 'ProductId') || xmlField(raw, 'ProductId'),
      quantity: xmlField(goods, 'Quantity') || xmlField(raw, 'Quantity')
    }
    let delivered = false
    try {
      delivered = await deliverXpayGoods(payload)
    } catch (err) {
      console.error('[wx-msg] xpay deliver failed ' + JSON.stringify(payload) + ' ' + (err && err.message ? err.message : err))
    }
    /* 发货成功必须回 ErrCode 0，微信才停止重推；失败回非 0 会重试（开通按 OutTradeNo 幂等） */
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end(delivered
      ? '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[OK]]></ErrMsg></xml>'
      : '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[FAIL]]></ErrMsg></xml>')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('success')
}

/* ---------- 5.06 微信虚拟支付（直购道具） ----------
 * 商机会员四档套餐在虚拟支付后台配置成 product1..product4 四个道具，价格与这里一致。
 * 下单：小程序 wx.login 取 code → 本接口校验 openid 一致 → 返回支付签名；
 * 发货：支付成功后微信推送 xpay_goods_deliver_notify 到 /api/wx/msg，按 ProductId 自动加时长。
 */
const XPAY_PRODUCTS = Object.freeze({
  product1: { planKey: 'month', price: 99, days: 30, label: '月度' },
  product2: { planKey: 'quarter', price: 268, days: 90, label: '季度' },
  product3: { planKey: 'half', price: 499, days: 180, label: '半年' },
  product4: { planKey: 'year', price: 899, days: 365, label: '年度' }
})
/* 套餐 key → 道具：小程序只传 planKey，商品与价格一律由服务端定，客户端改价无效 */
const XPAY_BY_PLAN = Object.freeze(Object.keys(XPAY_PRODUCTS).reduce((acc, productId) => {
  const item = XPAY_PRODUCTS[productId]
  acc[item.planKey] = Object.assign({ productId }, item)
  return acc
}, {}))

const xpayHits = new Map()
let marketAdminHandlers = null

/** 管理端商机 handler 的单例：发货直接复用 biz.grant 的开通 / 续费与流水逻辑 */
function marketAdmin() {
  if (!marketAdminHandlers) {
    marketAdminHandlers = createMarketAdminHandlers({ repo, keys, now: () => Date.now() })
  }
  return marketAdminHandlers
}

function hmacHexOf(key, text) {
  return crypto.createHmac('sha256', String(key)).update(String(text), 'utf8').digest('hex')
}

/**
 * 道具发货：ProductId → 套餐 → 调用 biz.grant 加时长。
 * paymentId 用 OutTradeNo，微信重推 / 网络重试都只开通一次。
 */
async function deliverXpayGoods(payload) {
  const openid = String(payload.openid || '')
  const outTradeNo = String(payload.outTradeNo || '')
  const productId = String(payload.productId || '')
  const item = XPAY_PRODUCTS[productId]
  if (!item) {
    /* 不是本小程序的商品：回成功让微信停止重推，避免无限重试 */
    console.error('[xpay] 未知商品，忽略发货 ' + JSON.stringify(payload))
    return true
  }
  if (!openid || !outTradeNo) {
    console.error('[xpay] 发货报文缺字段 ' + JSON.stringify(payload))
    return false
  }
  const qty = Math.max(1, Math.min(10, Math.floor(Number(payload.quantity) || 1)))
  await marketAdmin()['biz.grant']({
    uid: openid,
    plan: item.planKey,
    days: item.days * qty,
    amount: Math.round(item.price * qty * 100) / 100,
    paymentId: outTradeNo,
    method: '微信支付',
    note: '微信虚拟支付 · ' + productId + ' × ' + qty
  }, { accountId: '', session: { role: 'admin' } })
  console.log('[xpay] 已发货 ' + JSON.stringify({ openid, outTradeNo, productId, qty, env: payload.env }))
  return true
}

/** 下单签名：返回可直接传给 wx.requestVirtualPayment 的参数 */
async function handleXpayOrder(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
  }
  if (!rateOk(xpayHits, 'x:' + clientIp(req), 30, 10 * 60 * 1000)) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '下单过于频繁，请稍后再试' })
  }
  const tokenOpenid = verifyUserToken(bearer(req) || String(body.token || ''))
  if (!tokenOpenid) {
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '登录已过期，请重新登录' })
  }
  const offerId = String(process.env.WX_XPAY_OFFER_ID || '').trim()
  const appKey = String(process.env.WX_XPAY_APP_KEY || '').trim()
  if (!offerId || !appKey) {
    console.error('[xpay] WX_XPAY_OFFER_ID / WX_XPAY_APP_KEY 未配置')
    return sendJson(res, 200, { ok: false, code: 'INTERNAL', message: '微信支付暂未开通，请联系平台客服' })
  }
  const item = XPAY_BY_PLAN[String(body.planKey || 'month')]
  if (!item) {
    return sendJson(res, 200, { ok: false, code: 'VALIDATION', message: '套餐不存在' })
  }
  const code = String(body.code || '').trim()
  if (!code) {
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '缺少微信登录凭证' })
  }
  let session
  try {
    session = await code2session(code)
  } catch (err) {
    return sendJson(res, 200, { ok: false, code: 'INTERNAL', message: '微信登录服务暂时不可用' })
  }
  if (!session || !session.openid || !session.session_key) {
    console.error('[xpay] code2session errcode=' + Number((session && session.errcode) || 0) +
      ' errmsg=' + String((session && session.errmsg) || ''))
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '登录凭证已失效，请重新登录' })
  }
  /* 令牌与本次支付必须是同一个微信号，避免「A 付款、B 开通」 */
  if (String(session.openid) !== tokenOpenid) {
    return sendJson(res, 200, { ok: false, code: 'UNAUTHENTICATED', message: '登录状态异常，请重新登录' })
  }
  /* env：0 正式环境，1 沙箱环境（沙箱目前仅支持安卓真机） */
  const env = String(process.env.WX_XPAY_ENV || '1') === '0' ? 0 : 1
  const outTradeNo = 'XP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase()
  const signData = JSON.stringify({
    offerId,
    buyQuantity: 1,
    env,
    currencyType: 'CNY',
    productId: item.productId,
    /* goodsPrice 单位：分 */
    goodsPrice: Math.round(item.price * 100),
    outTradeNo,
    attach: item.planKey
  })
  sendJson(res, 200, {
    ok: true,
    code: 'OK',
    data: {
      signData,
      /* paySig = HMAC-SHA256(AppKey, 'requestVirtualPayment&' + signData) */
      paySig: hmacHexOf(appKey, 'requestVirtualPayment&' + signData),
      /* signature = HMAC-SHA256(session_key, signData) */
      signature: hmacHexOf(session.session_key, signData),
      mode: 'short_series_goods',
      outTradeNo,
      planKey: item.planKey,
      price: item.price,
      days: item.days,
      env
    }
  })
}

/* ---------- 5.1 聊天数据生命周期清理 ----------
 * 口径见 shared/chatmedia.js：聊天记录保留 30 天；图片 / 视频未打开 7 天过期，
 * 打开后登记 chatMedia，文件延长到 30 天。每小时跑一次，避免长期占用磁盘。
 */
function chatFileNameOf(url) {
  const m = /\/uploads\/chat\/([A-Za-z0-9_.-]+)$/.exec(String(url || ''))
  return m ? m[1] : ''
}

async function removeChatFile(url) {
  const name = chatFileNameOf(url)
  if (!name) return
  try {
    await fsp.unlink(path.join(CHAT_UPLOAD_DIR, name))
  } catch (err) { /* 文件可能已被删除 */ }
}

let cleaning = false

async function cleanupChatData() {
  if (cleaning) return
  cleaning = true
  const now = Date.now()
  try {
    /* 1) 30 天前的聊天消息（客服会话 + 直聊双副本），分批删除避免长事务 */
    let removed = 0
    for (let i = 0; i < 20; i += 1) {
      const res = await repo.removeWhere('outbox', {
        createdAt: { $lt: chatCutoff(now) },
        type: { $in: ['kf.chat', 'direct.chat'] }
      }, 500)
      const count = Number((res && res.count) || 0)
      removed += count
      if (count < 500) break
    }

    /* 2) 已打开媒体到期：删文件 + 删登记 */
    const rows = await repo.find('chatMedia', {}, { limit: 5000 })
    const keep = new Set()
    let expiredFiles = 0
    for (const row of rows) {
      if (Number(row.expireAt) > now) {
        const name = chatFileNameOf(row.url)
        if (name) keep.add(name)
        continue
      }
      await removeChatFile(row.url)
      try { await repo.removeWhere('chatMedia', { id: row.id }, 1) } catch (err) { /* ignore */ }
      expiredFiles += 1
    }

    /* 3) 目录里未打开的媒体：mtime 超过 7 天且没有有效登记，直接删除 */
    let orphanFiles = 0
    let names = []
    try {
      names = await fsp.readdir(CHAT_UPLOAD_DIR)
    } catch (err) {
      names = []
    }
    for (const name of names) {
      if (keep.has(name)) continue
      const full = path.join(CHAT_UPLOAD_DIR, name)
      try {
        const stat = await fsp.stat(full)
        if (!stat.isFile() || stat.mtimeMs >= mediaCutoff(now)) continue
        await fsp.unlink(full)
        orphanFiles += 1
      } catch (err) { /* 并发删除忽略 */ }
    }
    if (removed || expiredFiles || orphanFiles) {
      console.log('[chat-cleanup] messages=' + removed + ' media=' + expiredFiles + ' orphan=' + orphanFiles)
    }
  } catch (err) {
    console.error('[chat-cleanup] ' + (err && err.message ? err.message : err))
  } finally {
    cleaning = false
  }
}

/* ---------- 6. 启动 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      let db = true
      try {
        await repo.ping()
      } catch (err) {
        db = false
      }
      sendJson(res, db ? 200 : 503, {
        ok: db,
        service: 'suanli-platform',
        db,
        cache: cache.stats(),
        now: Date.now()
      })
      return
    }
    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/wx-login')) {
      await handleUserLogin(req, res)
      return
    }
    if (req.method === 'POST' && pathname === '/api/user') {
      await handleUser(req, res)
      return
    }
    if (req.method === 'POST' && pathname === '/api/upload') {
      await handleUpload(req, res, url)
      return
    }
    if (req.method === 'POST' && pathname === '/api/admin') {
      await handleAdmin(req, res)
      return
    }
    if (req.method === 'POST' && pathname === '/api/xpay/order') {
      await handleXpayOrder(req, res)
      return
    }
    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/wx/msg') {
      await handleWxMsg(req, res, url)
      return
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname)
      return
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed')
  } catch (err) {
    console.error('[http] ' + (err && err.message ? err.message : 'unknown error'))
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '服务暂时不可用' })
    } else {
      res.end()
    }
  }
})

server.on('clientError', (err, socket) => {
  if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

async function main() {
  await repo.initSchema()
  server.listen(PORT, HOST, () => {
    console.log('[suanli-platform] listening on ' + HOST + ':' + PORT)
    console.log('[suanli-platform] admin  -> /admin/')
    console.log('[suanli-platform] health -> /api/health')
  })
  /* 聊天数据生命周期清理：启动 3 分钟后首跑，之后每小时一次（unref 不阻止进程退出） */
  setTimeout(() => { cleanupChatData() }, 3 * 60 * 1000).unref()
  setInterval(() => { cleanupChatData() }, 60 * 60 * 1000).unref()
}

function shutdown(signal) {
  console.log('[suanli-platform] ' + signal + ' received, shutting down')
  server.close(() => {
    repo.close().catch(() => {}).then(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 8000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

/* 兜底：未处理的 Promise 拒绝只记录（常见于外部接口偶发失败），不拖垮进程 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] ' + (reason && reason.stack ? reason.stack : String(reason)))
})
/* 未捕获同步异常说明进程状态已不可信：记录后交给 PM2 拉起干净实例 */
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] ' + (err && err.stack ? err.stack : String(err)))
  shutdown('uncaughtException')
})

main().catch((err) => {
  console.error('[boot] 启动失败：' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
