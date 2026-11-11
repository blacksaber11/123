'use strict'

/**
 * 用户行为事件：登录 / 发布 / 咨询 / 代采代售 / 领取商机 / 商品浏览等。
 * 落库后 90 天自动清理；写入失败不影响主流程。
 */

const { randomId } = require('./crypto')

const RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const EVENT_KINDS = Object.freeze({
  login: '登录',
  publish_product: '发布商品',
  publish_demand: '发布需求',
  agency_buy: '提交代采',
  agency_sell: '提交代售',
  consult: '发起咨询',
  claim: '领取商机',
  biz_open: '打开商机会员页',
  chat: '发起直聊',
  favorite: '收藏',
  follow: '关注',
  view_product: '浏览商品',
  view_demand: '浏览需求',
  view_owner: '查看货主主页'
})

const EVENT_KIND_LIST = Object.freeze(Object.keys(EVENT_KINDS))

function dayText(at) {
  return new Date(Number(at) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 记录一条行为事件；任何异常都吞掉，绝不影响业务请求 */
async function recordUserEvent(repo, opts) {
  const o = opts || {}
  if (!o.uid || !EVENT_KINDS[o.kind]) return null
  const at = Number(o.at) || Date.now()
  const doc = {
    id: randomId('UE'),
    uid: String(o.uid),
    kind: o.kind,
    label: EVENT_KINDS[o.kind],
    page: String(o.page || ''),
    refId: String(o.refId || ''),
    title: String(o.title || '').slice(0, 120),
    at,
    day: dayText(at)
  }
  try {
    await repo.insert('userEvents', doc)
    return doc
  } catch (err) {
    return null
  }
}

/** 90 天前的数据清理；force=false 时按概率触发，避免每次请求都扫表 */
async function cleanupUserEvents(repo, at, force) {
  const ts = Number(at) || Date.now()
  if (!force && Math.random() > 0.02) return { count: 0 }
  try {
    const res = await repo.removeWhere('userEvents', { at: { $lt: ts - RETENTION_DAYS * DAY_MS } }, 500)
    return res || { count: 0 }
  } catch (err) {
    return { count: 0 }
  }
}

module.exports = { EVENT_KINDS, EVENT_KIND_LIST, RETENTION_DAYS, recordUserEvent, cleanupUserEvents }
