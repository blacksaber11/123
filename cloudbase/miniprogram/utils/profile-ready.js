/**
 * 发布前置的资料完整性校验（与后端 assertProfileReady 同口径）。
 *
 * 必填：主体名称 subject、主体类型 subjectType、主体类别 subjectKind、
 *      联系人 realname、手机号（hasPhone）。
 * 职位 position 选填，不参与拦截。
 *
 * 命中缺失时统一弹「资料未完善」引导去个人信息页补齐，
 * 确认后跳 /pages/profile/profile?focus=第一个缺失字段。
 */
const { request } = require('./request')

const REQUIRED_FIELDS = [
  { key: 'subject', label: '主体名称' },
  { key: 'subjectType', label: '主体类型' },
  { key: 'subjectKind', label: '主体类别' },
  { key: 'realname', label: '联系人' },
  { key: 'phone', label: '手机号' }
]

/** 返回缺失字段 [{key,label}]；profile 为 profile.get 的返回 */
function missingOf(profile) {
  const p = profile || {}
  return REQUIRED_FIELDS.filter((f) => {
    if (f.key === 'phone') return p.hasPhone !== true && !p.phoneMasked
    return !String(p[f.key] || '').trim()
  })
}

function labelsOf(missing) {
  return (missing || []).map((m) => m.label).join('、')
}

function profileUrl(focusKey) {
  return '/pages/profile/profile' + (focusKey ? '?focus=' + encodeURIComponent(focusKey) : '')
}

/**
 * 发布前调用：资料齐全返回 true；缺失则弹窗引导并返回 false。
 * 资料接口拉取失败时不阻断发布（后端仍有兜底断言）。
 */
async function ensureProfileReady() {
  let profile = null
  try {
    profile = await request('user', 'profile.get', {}, { silent: true })
  } catch (e) {
    return true
  }
  const missing = missingOf(profile)
  if (!missing.length) return true
  return new Promise((resolve) => {
    wx.showModal({
      title: '资料未完善',
      content: '请先补齐：' + labelsOf(missing),
      confirmText: '去完善',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: profileUrl(missing[0].key) })
        resolve(false)
      },
      fail: () => resolve(false)
    })
  })
}

/** 后端兜底拦截（message 含「完善」）：弹窗引导，而不是只 toast */
function handleProfileError(err) {
  const message = String((err && err.message) || '')
  if (message.indexOf('完善') < 0) return false
  wx.showModal({
    title: '资料未完善',
    content: message,
    confirmText: '去完善',
    success: (res) => {
      if (res.confirm) wx.navigateTo({ url: profileUrl('') })
    }
  })
  return true
}

module.exports = { REQUIRED_FIELDS, missingOf, labelsOf, ensureProfileReady, handleProfileError, profileUrl }
