/**
 * user 云函数入口（微信云开发）。
 *
 * openid 由微信云开发上下文提供，客户端无法伪造。
 * 敏感字段一律在 shared 层加密，本文件只做环境初始化与路由分发。
 */

const cloud = require('wx-server-sdk')

const { createRouter } = require('./_shared/router')
const { createCloudRepo } = require('./_shared/repo.cloud')
const { createCache } = require('./_shared/cache')
const { loadKeys } = require('./_shared/crypto')

/**
 * 初始化失败（密钥缺失 / 数据库不可用）不能让模块加载直接抛错，
 * 否则对外只表现为「函数调用失败」这种不可诊断的 500。
 * 这里降级为可读错误，前端能给出明确提示。
 *
 * 密钥从环境变量读，不要写死在代码里：
 *   AES_KEY_B64（32 字节 base64）、HMAC_KEY_B64（32 字节 base64）
 */
let router = null

/**
 * 订阅消息推送：模板 ID 从环境变量读（微信公众平台「功能 → 订阅消息」申请后配置）。
 * 未配置时直接跳过，站内消息与业务不受影响。
 * 模板字段需与所选模板一致，这里按「需求响应通知」模板配置 thing1 / thing2 / time3。
 * 正式环境用 formal，开发调试可用 developer / trial（MINIPROGRAM_STATE）。
 */
const SUBSCRIBE_TMPL_INQUIRY = process.env.SUBSCRIBE_TMPL_INQUIRY || ''
const SUBSCRIBE_TMPL_CHAT = process.env.SUBSCRIBE_TMPL_CHAT || ''
const SUBSCRIBE_TMPL_SYSTEM = process.env.SUBSCRIBE_TMPL_SYSTEM || ''
const SUBSCRIBE_TMPL_BIZ = process.env.SUBSCRIBE_TMPL_BIZ || ''
const MINIPROGRAM_STATE = process.env.MINIPROGRAM_STATE || 'formal'

/* 云函数运行在 UTC，推送时间按北京时间展示 */
function beijingTime(ms) {
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return (
    d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
  )
}

async function notifyInquiry(payload) {
  const openid = String((payload && payload.openid) || '')
  const templateId = String((payload && payload.templateId) || SUBSCRIBE_TMPL_INQUIRY || '')
  if (!templateId || !openid) return { ok: false, reason: 'unconfigured' }
  const title = String((payload && payload.title) || '').slice(0, 20)
  await cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId,
    page: 'pages/msg/msg',
    miniprogramState: MINIPROGRAM_STATE,
    lang: 'zh_CN',
    data: {
      thing1: { value: title || '你发布的内容' },
      thing2: { value: payload.targetType === 'demand' ? '收到新的需求响应' : '收到新的商品咨询' },
      time3: { value: beijingTime(payload.at || Date.now()) }
    }
  })
  return { ok: true }
}

/**
 * 会话新消息提醒：用户授权订阅后，对方发消息即可推一条微信服务通知，
 * 点开直达对应会话。模板字段按「会话提醒」模板配置：thing1 发送人 / thing2 内容 / time3 时间。
 */
async function notifyChat(payload) {
  const openid = String((payload && payload.openid) || '')
  const templateId = String((payload && payload.templateId) || SUBSCRIBE_TMPL_CHAT || '')
  if (!templateId || !openid) return { ok: false, reason: 'unconfigured' }
  await cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId,
    page: (payload && payload.page) || 'pages/msg/msg',
    miniprogramState: MINIPROGRAM_STATE,
    lang: 'zh_CN',
    data: {
      thing1: { value: String((payload && payload.sender) || '平台用户').slice(0, 20) },
      thing2: { value: String((payload && payload.preview) || '你有一条新消息').slice(0, 20) },
      time3: { value: beijingTime(payload && payload.at) }
    }
  })
  return { ok: true }
}

/** 系统消息 / 商机消息提醒：thing1 标题 / thing2 摘要 / time3 时间，字段与订阅模板一致 */
async function notifyNotice(payload, kind) {
  const openid = String((payload && payload.openid) || '')
  const templateId = String(
    (payload && payload.templateId) || (kind === 'biz' ? SUBSCRIBE_TMPL_BIZ : SUBSCRIBE_TMPL_SYSTEM) || ''
  )
  if (!templateId || !openid) return { ok: false, reason: 'unconfigured' }
  await cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId,
    page: (payload && payload.page) || 'pages/msg/msg',
    miniprogramState: MINIPROGRAM_STATE,
    lang: 'zh_CN',
    data: {
      thing1: { value: String((payload && payload.title) || (kind === 'biz' ? '商机提醒' : '平台通知')).slice(0, 20) },
      thing2: { value: String((payload && payload.body) || '你有一条新的消息').slice(0, 20) },
      time3: { value: beijingTime((payload && payload.at) || Date.now()) }
    }
  })
  return { ok: true }
}

/** 微信手机号快捷验证：code → 明文手机号，落库前由 shared 层加密 */
async function phoneByCode(code) {
  const res = await cloud.openapi.phonenumber.getPhoneNumber({ code })
  const info = (res && (res.phoneInfo || res.phone_info)) || {}
  return info.purePhoneNumber || info.pure_phone_number || info.phoneNumber || info.phone_number || ''
}

try {
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const keys = loadKeys({
    AES_KEY_B64: process.env.AES_KEY_B64,
    HMAC_KEY_B64: process.env.HMAC_KEY_B64
  })
  const repo = createCloudRepo(cloud)
  /* 多级缓存：未配置 REDIS_URL 时自动只用进程内 L1，不依赖 Redis */
  const cache = createCache({ env: process.env })
  router = createRouter({
    repo,
    keys,
    cache,
    scope: 'user',
    env: process.env,
    now: () => Date.now(),
    notify: {
      inquiry: notifyInquiry,
      chat: notifyChat,
      system: (payload) => notifyNotice(payload, 'system'),
      biz: (payload) => notifyNotice(payload, 'biz')
    },
    exchangePhone: phoneByCode
  })
} catch (err) {
  router = null
}

exports.main = async (event) => {
  if (!router) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: '服务未完成初始化（密钥或数据库配置缺失），请联系技术处理'
    }
  }
  const evt = event && typeof event === 'object' ? event : {}
  let wxContext = {}
  try {
    wxContext = cloud.getWXContext() || {}
  } catch (err) {
    /* 上下文读取异常按未登录处理，由前端引导重新登录 */
    wxContext = {}
  }
  const openid = wxContext.OPENID || ''
  if (!openid) {
    return { ok: false, code: 'UNAUTHENTICATED', message: '未获取到用户身份' }
  }
  const action = typeof evt.action === 'string' ? evt.action : ''
  /* 入参非法（null / 数组 / 字符串）时按空对象处理，handler 侧统一走参数校验 */
  const data = evt.data && typeof evt.data === 'object' && !Array.isArray(evt.data) ? evt.data : {}
  return router.dispatch(action, data, {
    openid,
    appid: wxContext.APPID || '',
    /* 只信任微信上下文注入的 CLIENTIP；evt.__trace__ 由客户端传入，可伪造，不用于审计 */
    ip: wxContext.CLIENTIP || ''
  })
}
