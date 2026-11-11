/**
 * 登录与身份相关工具。
 *
 * 保密要点：
 * 1. openid / 手机号 绝不出现在日志、错误消息、本地缓存的明文里；
 * 2. 登录态只存一份匿名的 userInfo（脱敏昵称、脱敏手机号标记、有实名标记），
 *    不存 openid、不存手机号明文、不存 token；
 * 3. 云函数的 openid 由微信上下文自动注入，客户端不发送、不读取。
 */
const { call, CODE, safePath, clearSession } = require('./request')
const { hideShare } = require('./guard')
const { writeConsent } = require('./privacy')

const USER_KEY = 'suanli_user_auth_v1'
const PROFILE_KEY = 'suanli_user_profile_v1'
/* 用户选择「暂不授权，先随便逛逛」的标记：记住后冷启动不再强制弹授权页 */
const SKIP_KEY = 'suanli_skip_phone_v1'
const GATE_PAGES = [
  'pages/consult/consult',
  'pages/publish/publish',
  'pages/mine/mine',
  'pages/profile/profile',
  'pages/msg/msg'
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
  /* 所有页面都关掉右上角转发入口，材料与线索不允许转发 */
  hideShare()
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
 * 保证已登录；未登录则静默走一次 wx.login + auth.login。
 * 不弹任何授权框：昵称、头像由用户在「我的 - 个人信息」按需补充。
 * 返回 user（匿名视图：uid、nick、phoneMasked、realnameMasked 等）。
 */
async function ensureLogin(app) {
  const cached = readUser()
  if (cached && cached.uid) {
    if (app && app.globalData) app.globalData.user = cached
    return cached
  }
  const user = await wxLogin({})
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
  const user = await call('user', 'auth.login', payload)
  /* 同意留痕：协议版本 + 同意时间随本地账号档案保存，静默登录同样记录 */
  const consent = writeConsent()
  const stored = Object.assign({}, user, { consentVersion: consent.version, consentAt: consent.at })
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
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.user = null
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
  logout,
  isGate,
  hasPhone,
  markPhoneSkipped,
  skippedPhone,
  clearPhoneSkipped,
  USER_KEY,
  PROFILE_KEY
}
