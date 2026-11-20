/**
 * 登录与身份相关工具。
 *
 * 保密要点：
 * 1. openid / 手机号 绝不出现在日志、错误消息、本地缓存的明文里；
 * 2. 登录态只存一份匿名的 userInfo（脱敏昵称、脱敏手机号标记、有实名标记），
 *    不存 openid、不存手机号明文、不存 token；
 * 3. 云函数的 openid 由微信上下文自动注入，客户端不发送、不读取。
 */
const { call, CODE, readToken, safePath, clearSession } = require('./request')
const { hideShare } = require('./guard')
const { writeConsent } = require('./privacy')

const USER_KEY = 'suanli_user_auth_v1'
const PROFILE_KEY = 'suanli_user_profile_v1'
/* 用户选择「暂不授权，先随便逛逛」的标记：记住后冷启动不再强制弹授权页 */
const SKIP_KEY = 'suanli_skip_phone_v1'
/* 只有真正需要身份的动作页才拦登录；「消息」「我的」是 tab 页，
   允许未登录浏览（页面内展示登录引导），不能一进 tab 就弹授权登录 */
const GATE_PAGES = [
  'pages/consult/consult',
  'pages/publish/publish',
  'pages/mine/sub/sub',
  'pages/profile/profile',
  'pages/chat/chat'
]

function isGate(route) {
  if (!route) return false
  return GATE_PAGES.some((prefix) => route.indexOf(prefix) === 0)
}

/* tabBar 页面：redirectTo 不能关闭 tab 页，只能用 navigateTo 入栈 */
const TAB_PAGES = ['pages/home/home', 'pages/msg/msg', 'pages/mine/mine']

function readUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null
  } catch (err) {
    return null
  }
}

function writeUser(user) {
  try {
    wx.setStorageSync(USER_KEY, user)
  } catch (err) {
    /* 本地缓存失败不影响登录流程 */
  }
}

function clearUser() {
  try {
    wx.removeStorageSync(USER_KEY)
    wx.removeStorageSync(PROFILE_KEY)
  } catch (err) {
    /* no-op */
  }
}

/**
 * 是否已授权手机号。
 * 登录视图里 hasPhone 由服务端给出；老账号只有 phoneMasked，一并视为已授权。
 */
function hasPhone(user) {
  const u = user || readUser() || {}
  return !!(u.hasPhone === true || u.phoneMasked)
}

/** 用户拒绝授权 / 主动选择先逛逛：记下来，后续冷启动不再强制弹授权页 */
function markPhoneSkipped() {
  try {
    wx.setStorageSync(SKIP_KEY, 1)
  } catch (err) {
    /* 缓存失败只影响下次是否再弹，不阻断浏览 */
  }
}

function skippedPhone() {
  try {
    return wx.getStorageSync(SKIP_KEY) === 1
  } catch (err) {
    return false
  }
}

/** 授权成功后清除「先逛逛」标记，恢复正常的登录口径 */
function clearPhoneSkipped() {
  try {
    wx.removeStorageSync(SKIP_KEY)
  } catch (err) {
    /* no-op */
  }
}

/**
 * 登录门禁：浏览公开内容不拦；发布、咨询、聊天、我的等需要身份的动作，
 * 未登录或未授权手机号时先跳登录页，登录成功后再回到原页面。
 * 回跳地址只保留定位同一份内容所需的 query（id / type / from / tab / sub），
 * 其它参数（含 openid、手机号、线索号）一律不带。
 */
function gate(pageRoute, pageOptions) {
  /* 分享按黑名单处理：默认开放，登录 / 发布 / 私密会话等页面关闭 */
  hideShare(pageRoute)
  if (!isGate(pageRoute)) return true
  const user = readUser()
  /* 已登录且拿到手机号才放行：发布 / 聊天必须能通过手机号联系到人 */
  if (user && user.uid && hasPhone(user)) return true
  const from = safePath(pageRoute || 'pages/home/home', pageOptions)
  const url = '/pages/login/login?from=' + encodeURIComponent(from)
  const home = () => {
    /* 页面栈异常（已在登录页 / 栈满）时回到首页 tab，不整栈重建 */
    wx.switchTab({
      url: '/pages/home/home',
      fail: () => {}
    })
  }
  /* tab 页无法 redirectTo，改用 navigateTo 入栈，登录后 switchTab 回原 tab */
  if (TAB_PAGES.indexOf(String(pageRoute || '').split('?')[0]) > -1) {
    wx.navigateTo({ url, fail: home })
    return false
  }
  wx.redirectTo({ url, fail: home })
  return false
}

/**
 * 当前待绑定推广码：由 app.js 从分享链接的 ?ref= / scene=ref%3D 里解析并写入 incomingRef。
 * 取不到时返回空串，登录参数里就不会出现 ref。
 * 注意：这里只读「别人分享给我的码」，不能读自己的推广码，否则分享会被记到自己名下。
 */
function currentRef() {
  try {
    const app = getApp()
    return String((app && app.globalData && app.globalData.incomingRef) || '').trim()
  } catch (err) {
    return ''
  }
}

/**
 * 推广码消费：绑定只认首次登录，服务端处理完就没有再带的必要。
 * 成功 / 已绑定 / 无效码 / 风控拦截都属终态，清掉并把码记为已消费；
 * retry（临时故障）与 not-active（上家还没开通成功）保留，等下次登录再试——
 * 上家开通后重新登录还能补绑，否则分享来的人会被永久丢掉。
 */
function consumeIncomingRef(ref, bind) {
  /* 没有回执（服务端老版本 / 回应被中间层截断）时一律保留：宁可下次再带一次，
     也不能在服务端没处理的情况下把码丢掉，否则分享来的人永远绑不上 */
  if (!bind || typeof bind !== 'object') return
  const reason = String(bind.reason || '')
  if (reason === 'retry' || reason === 'not-active') return
  try {
    const app = getApp()
    if (!app || !app.globalData) return
    if (app.globalData.incomingRef === ref) {
      app.globalData.consumedRef = ref
      app.globalData.incomingRef = ''
      writePendingRef('')
    }
  } catch (err) { /* 取不到 app 时忽略 */ }
}

/* 自己的推广码缓存键：开通推广大使后由登录态下发，冷启动尚未登录时分享也能带上 */
const MY_REF_KEY = 'suanli_my_ref_code'
/* 别人分享进来时待绑定的推广码：冷启动就落缓存，首次登录失败 / 小程序被杀也不会丢 */
const PENDING_REF_KEY = 'suanli_pending_ref'

/* 本次启动是否已向服务端同步过登录态：避免页面反复 ensureLogin 时重复请求 */
let promoterSynced = false

/* 读自己的推广码（同步，冷启动可用） */
function readMyRefCode() {
  try {
    return String(wx.getStorageSync(MY_REF_KEY) || '').trim()
  } catch (err) {
    return ''
  }
}

/* 写自己的推广码：同时落到本地缓存与 globalData，退出登录 / 取消大使资格时传空串清除 */
function writeMyRefCode(code) {
  const value = String(code || '').trim().slice(0, 32)
  try {
    if (value) wx.setStorageSync(MY_REF_KEY, value)
    else wx.removeStorageSync(MY_REF_KEY)
  } catch (err) { /* 缓存不可用时只更新内存 */ }
  try {
    const app = getApp()
    if (app && app.globalData) app.globalData.refCode = value
  } catch (err) { /* 取不到 app 时忽略 */ }
  return value
}

/* 读待绑定推广码：冷启动先恢复，登录前被杀 / 登录失败都不会丢 */
function readPendingRef() {
  try {
    return String(wx.getStorageSync(PENDING_REF_KEY) || '').trim().slice(0, 32)
  } catch (err) {
    return ''
  }
}

/* 写 / 清除待绑定推广码（空串即清除） */
function writePendingRef(code) {
  const value = String(code || '').trim().slice(0, 32)
  try {
    if (value) wx.setStorageSync(PENDING_REF_KEY, value)
    else wx.removeStorageSync(PENDING_REF_KEY)
  } catch (err) { /* 缓存不可用只影响容错，不影响本次绑定 */ }
  return value
}

/**
 * 保证已登录；本地没有令牌或没有用户缓存时静默走一次 wx.login + auth.login。
 * 不弹任何授权框：昵称、头像由用户在「我的 - 个人信息」按需补充。
 * 并发调用合并成同一次登录：首屏多个接口同时撞 401 时不会各登录一次。
 */
let loginTask = null

function ensureLogin(app) {
  if (loginTask) return loginTask
  const task = runEnsureLogin(app)
  loginTask = task
  return task.finally(() => {
    if (loginTask === task) loginTask = null
  })
}

async function runEnsureLogin(app) {
  const cached = readUser()
  const ref = currentRef()
  /* 有用户缓存但没有令牌（令牌过期已被清掉）时按未登录处理，必须重新登录 */
  if (cached && cached.uid && readToken()) {
    if (app && app.globalData) app.globalData.user = cached
    /* 每次冷启动静默刷新一次登录态：推广大使开通 / 被取消后，分享用的推广码能立刻同步 */
    if (ref || !promoterSynced) {
      promoterSynced = true
      try {
        return await wxLogin(ref ? { ref } : {})
      } catch (err) {
        return cached
      }
    }
    return cached
  }
  promoterSynced = true
  const user = await wxLogin(ref ? { ref } : {})
  if (app && app.globalData) app.globalData.user = user
  return user
}

/** 同步拿登录态（可能为 null） */
function getUser() {
  return readUser()
}

/**
 * 登录：统一走云函数 auth.login。
 * 真实 openid 由云函数从微信上下文注入，客户端不传、不存；
 * 本地只缓存脱敏后的匿名视图。
 */
async function wxLogin(profile) {
  const p = profile || {}
  const payload = {}
  const nick = String(p.nick || '').trim()
  if (nick) payload.nick = nick
  if (p.avatar) payload.avatar = p.avatar
  /* 分享进入时的推广码：登录即绑定，服务端按「首次绑定后不可改绑」处理。
     调用方没显式传时取本次启动从分享卡片 / 小程序码解析到的推广码，
     避免登录页主动登录把分享来源丢掉。 */
  const ref = String(p.ref || currentRef() || '').trim()
  if (ref) payload.ref = ref
  const user = await call('user', 'auth.login', payload)
  /* 推广码只用于首次绑定：服务端处理完就消费掉，避免后续登录重复携带、换号误绑 */
  if (ref) consumeIncomingRef(ref, user && user.promoterBind)
  /* 静默登录不采集任何个人信息，因此不写协议同意记录；
     只有用户主动勾选并授权手机号时才调用 markConsent 留痕 */
  const stored = Object.assign({}, user)
  /* 绑定回执只用于本次消费判断，不落登录缓存 */
  delete stored.promoterBind
  writeUser(stored)
  /* 推广大使：登录态里带自己的推广码时写入全局与缓存，之后任意页面分享 / 海报都带上 */
  const promoter = user && user.promoter
  if (promoter) writeMyRefCode(promoter.active ? promoter.refCode : '')
  try {
    const app = getApp()
    if (app && app.globalData) app.globalData.user = stored
  } catch (e) {}
  return stored
}

/**
 * 协议同意留痕：仅在用户主动勾选《用户协议》《隐私政策》并继续授权时调用，
 * 记录协议版本与时间，杜绝「登录即默认同意」。
 */
function markConsent(user) {
  const consent = writeConsent()
  const stored = Object.assign({}, user || {}, { consentVersion: consent.version, consentAt: consent.at })
  writeUser(stored)
  try {
    const app = getApp()
    if (app && app.globalData) app.globalData.user = stored
  } catch (e) {}
  return stored
}

/** 退出登录：清本地缓存与接口令牌 */
function logout() {
  clearSession()
  clearUser()
  /* 退出后清掉自己的推广码，避免换账号登录时把上一个人的码带进分享 */
  writeMyRefCode('')
  promoterSynced = false
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.user = null
      /* 待绑定推广码随会话清空；已消费记录保留，避免热启动参数把上家的码带进下一个账号 */
      app.globalData.incomingRef = ''
      writePendingRef('')
    }
  } catch (e) {}
}

module.exports = {
  ensureLogin,
  gate,
  readUser,
  writeUser,
  clearUser,
  getUser,
  wxLogin,
  markConsent,
  logout,
  isGate,
  hasPhone,
  markPhoneSkipped,
  skippedPhone,
  clearPhoneSkipped,
  readMyRefCode,
  writeMyRefCode,
  readPendingRef,
  writePendingRef,
  USER_KEY,
  PROFILE_KEY
}
