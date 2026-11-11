/**
 * 直接对话：详情页点「联系货主 / 联系需求方」后的统一流程。
 *
 * 流程：
 * 1. 先在页面上逐项确认对方的必须条件（全部满足才能继续）；
 * 2. 调 chat.open，服务端校验并落线索、开出会话；
 * 3. 直接跳到与对方的会话，不再发起「给平台的咨询」让平台代为转达。
 *
 * 货主若勾选了「公开联系电话」，服务端会一并返回明文号码，
 * 这时在会话入口处直接给出「拨号」按钮。
 */
const { request, safePath } = require('./request')
const { readUser, hasPhone } = require('./auth')

/**
 * 聊天前必须登录并绑定手机号：未满足就跳登录页（带回跳地址），登录后回到本页继续。
 * 返回 true 表示已具备聊天条件。
 */
function ensureChatLogin() {
  const user = readUser()
  if (user && user.uid && hasPhone(user)) return true
  let from = '/pages/home/home'
  try {
    const pages = getCurrentPages() || []
    const cur = pages.length ? pages[pages.length - 1] : null
    if (cur && cur.route) from = safePath(cur.route, cur.options || {})
  } catch (err) { /* 取不到页面栈时回首页 */ }
  const url = '/pages/login/login?from=' + encodeURIComponent(from)
  wx.navigateTo({ url, fail: () => wx.redirectTo({ url, fail: () => {} }) })
  return false
}

/**
 * 打开与对方的会话。
 * @param {object} opts
 *   opts.targetType 'product' | 'demand'
 *   opts.targetId   标的 id
 *   opts.conds      [{ k, satisfied }] 必须条件确认结果
 *   opts.onPhone    (phone) => void  对方公开了联系电话时的回调
 *   opts.onNeedForm () => void      条件不满足、需要继续填表单时的回调
 * @returns {Promise<boolean>} 是否成功进入会话
 */
async function openChat(opts) {
  if (!ensureChatLogin()) return false
  const o = opts || {}
  const payload = {}
  payload[o.targetType === 'demand' ? 'demandId' : 'productId'] = o.targetId
  payload.conds = o.conds || []

  let res = null
  try {
    res = await request('user', 'chat.open', payload)
  } catch (err) {
    /* request 已按错误码提示（条件未满足 / 状态变更 / 限流），留在当前页 */
    return false
  }
  if (!res || !res.chatReady || !res.threadId) {
    wx.showToast({ title: '暂时无法直接对话，请稍后再试', icon: 'none' })
    return false
  }

  /* 货主公开了联系电话：先让页面展示拨号入口，再进会话 */
  if (res.phonePublic && res.phone && typeof o.onPhone === 'function') {
    o.onPhone(res.phone)
  }

  try {
    const app = getApp()
    app.globalData = app.globalData || {}
    app.globalData.openThread = res.threadId
  } catch (e) {
    /* globalData 写不进去时仍进消息页，只是不自动打开这条会话 */
  }
  /* 消息页是 tabBar 页，只能用 switchTab；navigateTo 到 tab 页会被微信直接拒绝 */
  wx.switchTab({ url: '/pages/msg/msg' })
  return true
}

/** 复制电话号码：货主自己公开的号码，复制后可直接拨号 */
function copyPhone(phone) {
  if (!phone) return false
  wx.setClipboardData({
    data: String(phone),
    success: () => wx.showToast({ title: '号码已复制', icon: 'none' }),
    fail: () => wx.showToast({ title: '复制失败，请手动输入', icon: 'none' })
  })
  return true
}

module.exports = { openChat, copyPhone }
