'use strict'

/**
 * 微信订阅消息推送：系统消息（system）与商机消息（biz）。
 *
 * 模板 ID 由管理端「平台设置」下发，环境变量兜底；未配置时静默跳过，
 * 站内消息不受影响。商机消息尊重用户个人偏好 users.notifyBiz（默认开启）。
 */
const SITE_TTL = 60 * 1000
const PREF_TTL = 60 * 1000
const SITE_KEYS = { system: 'tmplSystem', biz: 'tmplBiz' }

const { createQuota, isExhausted } = require('./notify-quota')

function createSubscribe(deps) {
  const repo = deps.repo
  const notify = deps.notify
  const env = deps.env || {}
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const quota = createQuota({ repo })
  let siteCache = { at: 0, doc: null }
  const prefHits = new Map()

  async function siteOf() {
    if (siteCache.doc && Date.now() - siteCache.at < SITE_TTL) return siteCache.doc
    let doc = {}
    try {
      doc = (await repo.get('settings', 'site')) || {}
    } catch (err) {
      doc = {}
    }
    siteCache = { at: Date.now(), doc }
    return doc
  }

  /* 商机提醒偏好：用户可在「我的 - 设置」关闭，关闭后不再推送商机类消息 */
  async function bizAllowed(uid) {
    const hit = prefHits.get(uid)
    if (hit && Date.now() - hit.at < PREF_TTL) return hit.on
    let on = true
    try {
      const user = await repo.get('users', uid)
      on = !(user && user.notifyBiz === false)
    } catch (err) {
      on = true
    }
    if (prefHits.size > 5000) prefHits.clear()
    prefHits.set(uid, { at: Date.now(), on })
    return on
  }

  async function push(kind, uid, payload) {
    if (!uid || !notify || typeof notify[kind] !== 'function') return false
    try {
      const doc = await siteOf()
      const templateId = String(doc[SITE_KEYS[kind]] || env['SUBSCRIBE_TMPL_' + kind.toUpperCase()] || '')
      if (!templateId) return false
      if (kind === 'biz' && !(await bizAllowed(uid))) return false
      /* 一次性订阅：没有额度时不再调用微信接口，等用户续订后再推 */
      if (!(await quota.allow(uid, kind))) return false
      try {
        await notify[kind]({
          openid: uid,
          templateId,
          title: (payload && payload.title) || '',
          body: (payload && payload.body) || '',
          at: (payload && payload.at) || now(),
          page: (payload && payload.page) || 'pages/msg/msg'
        })
      } catch (err) {
        if (isExhausted(err)) await quota.exhaust(uid, kind)
        throw err
      }
      await quota.used(uid, kind)
      return true
    } catch (err) {
      /* 推送失败不影响站内消息 */
      return false
    }
  }

  return {
    system: (uid, payload) => push('system', uid, payload),
    biz: (uid, payload) => push('biz', uid, payload),
    bizAllowed
  }
}

module.exports = { createSubscribe }
