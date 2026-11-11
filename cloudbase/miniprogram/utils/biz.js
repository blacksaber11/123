/**
 * 商机：只展示「我的库存」能匹配上的平台核验后代采 / 代售委托与求购需求，
 * 匹配不上的条目不进入商机列表。
 *
 * 收费：99 元 / 月，用户在小程序内选择套餐开通，付款后自动加时长
 * （管理端「商机管理」里可开通 / 续费），开通状态本地留痕。
 *
 * 云端 biz.list / biz.unlock 就绪前回落本地演示数据，
 * 与首页货盘、资讯圈「云端优先、失败回落」同一模式。
 */
const M = require('./mock')
const stock = require('./stock')

const UNLOCK_KEY = 'suanli_biz_unlock_v1'
const CLAIM_KEY = 'suanli_biz_claims_v1'
const CONSULT_KEY = 'suanli_biz_consults_v1'
/* 标记「不满足」的商机：仍保留在列表里，但不进可领取分组、不再提醒 */
const MARK_KEY = 'suanli_biz_marks_v1'

const PLAN = { price: 99, days: 30, label: '99 元 / 月' }

/* 会员四档：与后端 BIZ_PLANS 同口径，云端不可用时引导页也能选套餐 */
const PLANS = [
  { key: 'month', label: '月度', days: 30, price: 99, original: 99, saving: 0 },
  { key: 'quarter', label: '季度', days: 90, price: 268, original: 297, saving: 29 },
  { key: 'half', label: '半年', days: 180, price: 499, original: 594, saving: 95 },
  { key: 'year', label: '年度', days: 365, price: 899, original: 1188, saving: 289 }
]

/* 平台核验后的代采 / 代售委托：委托方信息不对外展示，统一由平台居中联系 */
const AGENCY_DEMO = [
  {
    id: 'biz1', kind: '代采', cat: 'GPU 加速卡', model: 'H100 80G SXM',
    price: 215000, priceText: '¥ 215,000', priceLabel: '预算单价',
    qty: 6, unit: '张', city: '深圳', org: '华南某智算科技', contact: '陈经理',
    phone: '138 6688 0011', published: '今天 09:20', expireText: '剩 26 天', feeText: '成交后支付'
  },
  {
    id: 'biz2', kind: '代采', cat: 'GPU 加速卡', model: 'A100 80G PCIE',
    price: 96000, priceText: '¥ 96,000', priceLabel: '预算单价',
    qty: 20, unit: '张', city: '上海', org: '华东某 AI 创业公司', contact: '周先生',
    phone: '139 2211 0033', published: '今天 10:05', expireText: '剩 28 天', feeText: '成交后支付'
  },
  {
    id: 'biz3', kind: '代售', cat: 'GPU 加速卡', model: 'L40S 48G',
    price: 152000, priceText: '¥ 152,000', priceLabel: '报价单价',
    qty: 16, unit: '张', city: '杭州', org: '云栖某算力服务商', contact: '赵女士',
    phone: '137 5522 8899', published: '今天 08:40', expireText: '剩 21 天', feeText: '成交后支付'
  },
  {
    id: 'biz4', kind: '代售', cat: '内存条', model: 'DDR5 64G 6400',
    price: 1880, priceText: '¥ 1,880', priceLabel: '报价单价',
    qty: 200, unit: '根', city: '深圳', org: '华强北某存储贸易商', contact: '林先生',
    phone: '135 8899 2200', published: '昨天 17:30', expireText: '剩 18 天', feeText: '成交后支付'
  }
]

/* 演示联系方式：求购方完整联系方式在领取后展示 */
const DEMAND_CONTACTS = {
  d1: { org: '某央企智算中心', contact: '王先生', phone: '138 1122 3344' },
  d2: { org: '某 AI 创业公司', contact: '李女士', phone: '136 7788 9900' },
  d3: { org: '某视觉算法团队', contact: '孙先生', phone: '139 3344 5566' },
  d4: { org: '某省级智算平台', contact: '杨女士', phone: '137 2233 4455' },
  d5: { org: '西南某智算服务商', contact: '刘先生', phone: '135 6677 8899' }
}

function readUnlock() {
  try {
    const saved = wx.getStorageSync(UNLOCK_KEY)
    if (saved && typeof saved === 'object') return saved
  } catch (err) {
    /* 读取失败视为未开通 */
  }
  return { expireAt: 0, plan: PLAN.price }
}

function writeUnlock(state) {
  try {
    wx.setStorageSync(UNLOCK_KEY, state)
  } catch (err) {
    /* no-op */
  }
}

function isUnlocked() {
  return Number(readUnlock().expireAt) > Date.now()
}

function unlockInfo() {
  const state = readUnlock()
  const left = Math.max(0, Number(state.expireAt) - Date.now())
  return {
    unlocked: left > 0,
    expireAt: Number(state.expireAt) || 0,
    expireText: left > 0 ? dateText(Number(state.expireAt)) : '',
    daysLeft: Math.ceil(left / 86400000),
    plan: PLAN.label
  }
}

/** 客服在管理端收款后开通 / 续费：本地叠加一个月 */
function activate(days) {
  const add = (Number(days) || PLAN.days) * 86400000
  const base = Math.max(Date.now(), Number(readUnlock().expireAt) || 0)
  writeUnlock({ expireAt: base + add, plan: PLAN.price, at: Date.now() })
  return unlockInfo()
}

function dateText(ts) {
  const d = new Date(ts)
  const m = ('0' + (d.getMonth() + 1)).slice(-2)
  const day = ('0' + d.getDate()).slice(-2)
  return d.getFullYear() + '-' + m + '-' + day
}

function readClaims() {
  try {
    const saved = wx.getStorageSync(CLAIM_KEY)
    if (Array.isArray(saved)) return saved
  } catch (err) {
    /* no-op */
  }
  return []
}

function writeClaims(list) {
  try {
    wx.setStorageSync(CLAIM_KEY, list)
  } catch (err) {
    /* no-op */
  }
}

function isClaimed(id) {
  return readClaims().some((c) => c.id === id)
}

function claim(id) {
  const list = readClaims()
  if (!list.some((c) => c.id === id)) {
    list.unshift({ id: id, at: Date.now() })
    writeClaims(list)
  }
  return isClaimed(id)
}

function readConsults() {
  try {
    const saved = wx.getStorageSync(CONSULT_KEY)
    if (Array.isArray(saved)) return saved
  } catch (err) {
    /* no-op */
  }
  return []
}

function writeConsults(list) {
  try {
    wx.setStorageSync(CONSULT_KEY, list)
  } catch (err) {
    /* no-op */
  }
}

function isConsulted(id) {
  return readConsults().some((c) => c.id === id)
}

/** 平台对接申请：后端 biz.consult 未就绪时的本地演示留痕 */
function consult(id) {
  const list = readConsults()
  if (!list.some((c) => c.id === id)) {
    list.unshift({ id: id, at: Date.now() })
    writeConsults(list)
  }
  return isConsulted(id)
}

function readMarks() {
  try {
    const saved = wx.getStorageSync(MARK_KEY)
    if (Array.isArray(saved)) return saved
  } catch (err) {
    /* no-op */
  }
  return []
}

function writeMarks(list) {
  try {
    wx.setStorageSync(MARK_KEY, list)
  } catch (err) {
    /* no-op */
  }
}

function isUnsatisfied(id) {
  return readMarks().some((m) => m.id === id && m.marked !== false)
}

/** 标记 / 取消「不满足」：本地演示留痕，云端可用时走 biz.mark */
function markUnsatisfied(id, marked) {
  const on = marked !== false
  const list = readMarks().filter((m) => m.id !== id)
  if (on) list.unshift({ id: id, marked: true, at: Date.now() })
  writeMarks(list)
  return on
}

/** 广场求购需求 → 商机条目 */
function demandOpps() {
  return (M.DEMANDS || []).map((d) => {
    const c = DEMAND_CONTACTS[d.id] || {}
    return {
      id: d.id,
      kind: d.isRent ? '租赁' : '求购',
      cat: d.cat,
      brand: d.brand,
      model: d.model,
      price: d.budget,
      priceText: d.budgetText + ' 以内',
      priceLabel: d.isRent ? '预算租金' : '预算上限',
      qty: d.qty,
      unit: d.isRent ? '台 / 月' : '台',
      city: d.city,
      org: c.org || d.contact || '求购方',
      contact: c.contact || '求购方联系人',
      phone: c.phone || '',
      published: d.published,
      expireText: d.deliver ? d.deliver + '内交付' : '一个月内有效',
      feeText: d.isRent ? '求购需求' : '求购需求'
    }
  })
}

/** 未匹配时区分「型号对不上」与「型号对得上但数量不足」 */
function matchHint(o) {
  const d = o || {}
  if (d.matched) return ''
  const qty = Number(d.stockQty) || 0
  if (d.stockText) {
    return '我的库存：' + d.stockText + '（合计 ×' + qty + '），数量不足，需 ≥ '
      + (Number(d.qty) || 0) + (d.unit || '')
  }
  return '库存中没有匹配型号，先在「我的库存」补上该型号'
}

/**
 * 商机列表：代采 / 代售与求购需求都只在库存匹配成功时展示。
 * 本人发布的商机一律不出现在自己的列表里（不能响应自己）。
 */
function opportunities() {
  const list = AGENCY_DEMO.concat(demandOpps())
    .filter((o) => !(o && (o.isMine || o.mine)))
  return list.map((o) => {
    const hit = stock.matchStock(o)
    const isAgency = o.kind === '代采' || o.kind === '代售'
    const unsatisfied = isUnsatisfied(o.id)
    /* 代采 + 代售均由平台代为对接：不开放自助领取，也不展示联系方式 */
    const platformOnly = isAgency
    const merged = Object.assign({}, o, {
      isAgency: isAgency,
      platformOnly: platformOnly,
      /* 平台单不下发委托方联系人 / 电话，只保留平台对接入口 */
      contact: platformOnly ? '平台代为对接' : o.contact,
      phone: platformOnly ? '' : o.phone,
      matched: hit.ok,
      stockText: hit.text,
      stockQty: hit.qty,
      claimed: isClaimed(o.id),
      consulted: isConsulted(o.id),
      unsatisfied: unsatisfied,
      canClaim: !isAgency && hit.ok && !unsatisfied,
      /* 平台单一律不展示对方电话；求购 / 租赁需有匹配库存且领取后可见 */
      contactVisible: platformOnly ? false : (hit.ok && isClaimed(o.id))
    })
    merged.stockHint = matchHint(merged)
    return merged
  }).filter((o) => o.matched)
}

function stats() {
  const all = opportunities()
  const claims = readClaims().filter((c) => all.some((o) => o.id === c.id))
  return {
    matched: all.length,
    agency: all.filter((o) => o.kind === '代采' || o.kind === '代售').length,
    demands: all.filter((o) => o.kind === '求购' || o.kind === '租赁').length,
    claimed: claims.length,
    /* 已标记不满足且尚未领取：单独进「不满足」分类 */
    unsatisfied: all.filter((o) => !o.claimed && o.unsatisfied).length,
    stock: stock.stats()
  }
}

module.exports = {
  PLAN, PLANS, UNLOCK_KEY, CLAIM_KEY, CONSULT_KEY, MARK_KEY,
  isUnlocked, unlockInfo, activate,
  opportunities, stats, isClaimed, claim,
  isUnsatisfied, markUnsatisfied,
  isConsulted, consult, matchHint
}
