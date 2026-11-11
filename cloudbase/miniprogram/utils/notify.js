/* 微信订阅消息：咨询响应 / 会话新消息 / 系统消息 / 商机消息通过微信服务通知提醒用户。
 *
 * 微信订阅消息是「一次授权、一次推送」：用户每授权一次，服务端只能推送一条。
 * 模板 ID 由服务端下发（管理端「平台设置」或环境变量），避免把模板写死在代码里。
 *
 * 使用方式：
 *   notify.loadConfig()            进入页面时预取模板配置（不阻塞渲染）
 *   notify.enable()                消息页 / 设置页一键申请全部提醒授权
 *   notify.enable('chat')          只有会话场景时单独申请会话提醒授权
 */
const STATE_KEY = 'suanli_notify_v1'
const CONFIG_TTL = 5 * 60 * 1000
/* 一次授权只能推一条：超过 3 天未重新授权时再次提示，方便用户续上提醒 */
const ASK_TTL = 3 * 24 * 60 * 60 * 1000

/* 服务端下发的模板 ID：inquiry 咨询响应 / chat 会话 / system 系统消息 / biz 商机消息 */
const TEMPLATES = {
  inquiry: '',
  chat: '',
  system: '',
  biz: ''
}

let loadedAt = 0

function ids(kinds) {
  const list = kinds ? [].concat(kinds) : Object.keys(TEMPLATES)
  const out = []
  list.forEach((k) => {
    const id = TEMPLATES[k]
    if (id && out.indexOf(id) < 0) out.push(id)
  })
  /* 微信一次最多只能订阅 3 条模板，咨询与系统共用同一模板时去重后正好 3 条 */
  return out.slice(0, 3)
}

function supported() {
  return typeof wx !== 'undefined' && typeof wx.requestSubscribeMessage === 'function'
}

function configured(kinds) {
  return ids(kinds).length > 0
}

/* 预取模板配置：只请求一次，5 分钟内复用；失败不影响站内消息 */
async function loadConfig(force) {
  if (!force && loadedAt && Date.now() - loadedAt < CONFIG_TTL) return TEMPLATES
  try {
    const { request } = require('./request')
    const res = await request('user', 'notify.config', {}, { silent: true })
    if (res && typeof res === 'object') {
      TEMPLATES.inquiry = res.inquiry || ''
      TEMPLATES.chat = res.chat || ''
      TEMPLATES.system = res.system || ''
      TEMPLATES.biz = res.biz || ''
      loadedAt = Date.now()
    }
  } catch (err) {
    /* 云端暂未提供配置接口时保持未开通状态 */
  }
  return TEMPLATES
}

function read() {
  let raw = null
  try {
    raw = wx.getStorageSync(STATE_KEY)
  } catch (e) {}
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: s.enabled === true,
    askedAt: Number(s.askedAt) || 0
  }
}

function write(s) {
  try {
    wx.setStorageSync(STATE_KEY, s)
  } catch (e) {}
}

/* 本地是否已授权：仅用于界面展示，真实推送能力以服务端模板配置为准 */
function enabled() {
  const s = read()
  if (s.enabled !== true) return false
  /* 一次授权只对应一条推送，超过 3 天后重新提示，用户可再次一键开启 */
  return !s.askedAt || Date.now() - s.askedAt < ASK_TTL
}

/**
 * 申请订阅消息授权。必须由用户点击触发。
 * kinds：'inquiry' / 'chat' / 'system' / 'biz'，不传表示全部已配置模板。
 * 返回 { ok, reason }，reason：accept / reject / ban / dismiss / unconfigured / unsupported / fail / timeout
 */
function requestSubscribe(kinds) {
  const tmplIds = ids(kinds)
  if (!tmplIds.length) return Promise.resolve({ ok: false, reason: 'unconfigured' })
  if (!supported()) return Promise.resolve({ ok: false, reason: 'unsupported' })
  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    /* 用户直接关闭弹窗时部分机型不回调，加超时兜底避免调用方一直等待 */
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 10000)
    try {
      wx.requestSubscribeMessage({
        tmplIds,
        success: (res) => {
          const result = res || {}
          const accepted = tmplIds.some((id) => result[id] === 'accept')
          const banned = tmplIds.some((id) => result[id] === 'ban')
          const rejected = tmplIds.some((id) => result[id] === 'reject')
          const state = read()
          state.enabled = accepted
          state.askedAt = Date.now()
          write(state)
          if (accepted) finish({ ok: true, reason: 'accept' })
          else finish({ ok: false, reason: banned ? 'ban' : (rejected ? 'reject' : 'dismiss') })
        },
        fail: () => finish({ ok: false, reason: 'fail' })
      })
    } catch (err) {
      finish({ ok: false, reason: 'fail' })
    }
  })
}

/* 跳转小程序设置页重新授权（用户曾拒绝 / 被屏蔽时使用） */
function openSetting() {
  if (typeof wx === 'undefined' || typeof wx.openSetting !== 'function') return Promise.resolve(false)
  return new Promise((resolve) => {
    wx.openSetting({
      withSubscriptions: true,
      success: (res) => {
        const items = (res && res.subscriptionsSetting && res.subscriptionsSetting.itemSettings) || {}
        const on = Object.keys(items).some((k) => items[k] === 'accept')
        const state = read()
        state.enabled = on
        write(state)
        resolve(on)
      },
      fail: () => resolve(false)
    })
  })
}

/* 页面统一入口：申请授权 + 必要的引导文案，返回是否已开启 */
async function enable(kinds) {
  await loadConfig()
  const chatOnly = [].concat(kinds || []).length === 1 && [].concat(kinds)[0] === 'chat'
  const r = await requestSubscribe(kinds)
  if (r.ok) {
    wx.showToast({ title: chatOnly ? '已开启微信会话提醒' : '已开启微信消息提醒', icon: 'none' })
    return true
  }
  if (r.reason === 'reject' || r.reason === 'ban') {
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '微信消息提醒未开启',
        content: chatOnly
          ? '有人给你发消息时，微信会推送通知给你。可在「设置 → 订阅消息」中重新开启。'
          : '有人给你发消息、系统通知、新的匹配商机时，微信会推送通知给你。可在「设置 → 订阅消息」中重新开启。',
        confirmText: '去设置',
        cancelText: '暂不开启',
        success: resolve,
        fail: () => resolve({ confirm: false })
      })
    })
    if (!res.confirm) return false
    const on = await openSetting()
    wx.showToast({ title: on ? '已开启微信消息提醒' : '未开启微信消息提醒', icon: 'none' })
    return on
  }
  if (r.reason === 'unconfigured') {
    wx.showToast({ title: '微信提醒尚未配置模板，请联系平台管理员', icon: 'none' })
  } else if (r.reason === 'unsupported') {
    wx.showToast({ title: '当前微信版本不支持消息提醒', icon: 'none' })
  } else {
    wx.showToast({ title: '未开启微信消息提醒', icon: 'none' })
  }
  return false
}

module.exports = {
  TEMPLATES,
  loadConfig,
  supported,
  configured,
  enabled,
  requestSubscribe,
  openSetting,
  enable
}
