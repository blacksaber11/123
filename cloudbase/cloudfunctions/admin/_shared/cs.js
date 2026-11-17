'use strict'

/**
 * 客服业务域：客服绑定用户、下级会员支付提成、咨询单服务状态与评价。
 *
 * 业务口径（2026-11 确认）：
 * 1. 一个客服只能绑定一个用户账号，一个用户也只能归属一个客服；
 * 2. 只有被绑定用户「直接下级」的会员支付才计入该客服业绩（不含绑定账号本人，也不做多级穿透）；
 * 3. 提成 = 实收金额 × 比例；比例优先取客服单独配置，未配置时用管理端全局默认；
 * 4. 同一 paymentId 只计提一次，重复回调幂等；
 * 5. 评价只允许咨询单所属用户在客服结束会话后提交一次，聚合进客服档案。
 */

const { AppError, CODES } = require('./errors')
const { randomId, sha256Hex } = require('./crypto')

const CS_STATUS = Object.freeze({
  WAITING: '待领取',
  SERVING: '服务中',
  ENDED: '已结束'
})

const CS_SETTINGS_ID = 'cs'
const DEFAULT_RATE = 0.05
const RATE_MIN = 0
const RATE_MAX = 0.3
/* 代采代售佣金：基数为服务费实收金额，与会员提成比例互不影响 */
const AGENCY_RATE_DEFAULT = 0.2
const AGENCY_RATE_MIN = 0
const AGENCY_RATE_MAX = 0.5
const CN_OFFSET = 8 * 60 * 60 * 1000

const RATING_TAGS = Object.freeze(['专业', '响应快', '态度好', '讲解清楚', '解决问题', '需要改进'])

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function clampRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new AppError(CODES.VALIDATION, '提成比例格式不正确')
  if (n < RATE_MIN || n > RATE_MAX) {
    throw new AppError(CODES.VALIDATION, `提成比例需在 ${RATE_MIN * 100}%–${RATE_MAX * 100}% 之间`)
  }
  return Math.round(n * 10000) / 10000
}

function clampAgencyRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new AppError(CODES.VALIDATION, '代采代售佣金比例格式不正确')
  if (n < AGENCY_RATE_MIN || n > AGENCY_RATE_MAX) {
    throw new AppError(
      CODES.VALIDATION,
      `代采代售佣金比例需在 ${AGENCY_RATE_MIN * 100}%–${AGENCY_RATE_MAX * 100}% 之间`
    )
  }
  return Math.round(n * 10000) / 10000
}

/** 北京时间月份键：YYYY-MM，工资与佣金按月归档共用 */
function monthKeyOf(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 传空按当月；格式不对时也回落当月，避免工资页报错 */
function normalizeMonthKey(value) {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}$/.test(text) ? text : monthKeyOf(Date.now())
}

/** 咨询单当前服务状态：兼容历史 leads 数据（没有 csStatus 时按分配情况推断） */
function csStatusOf(lead) {
  if (!lead) return ''
  if (lead.csStatus) return lead.csStatus
  if (lead.status === '已关闭') return CS_STATUS.ENDED
  if (lead.csClaimedAt || lead.assignedAccount || lead.assignedTo) return CS_STATUS.SERVING
  return CS_STATUS.WAITING
}

/** 咨询单是否属于代采代售咨询（只有这类单需要客服领取与评价） */
function isCsConsult(lead) {
  return !!lead && lead.targetType === 'agency'
}

/** 北京时间月份起点 */
function monthStart(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - CN_OFFSET
}

function ratingAvgOf(list) {
  if (!list.length) return 0
  const sum = list.reduce((acc, row) => acc + Math.max(0, Math.min(5, Number(row.score) || 0)), 0)
  return Math.round((sum / list.length) * 100) / 100
}

function createCsEngine(deps) {
  const repo = deps.repo
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  async function readSettings() {
    const doc = await repo.get('settings', CS_SETTINGS_ID)
    const rate = doc && Number.isFinite(Number(doc.rate)) ? Number(doc.rate) : DEFAULT_RATE
    const agencyRate =
      doc && Number.isFinite(Number(doc.agencyRate)) ? Number(doc.agencyRate) : AGENCY_RATE_DEFAULT
    return {
      id: CS_SETTINGS_ID,
      rate,
      rateMin: RATE_MIN,
      rateMax: RATE_MAX,
      agencyRate,
      agencyRateMin: AGENCY_RATE_MIN,
      agencyRateMax: AGENCY_RATE_MAX,
      updatedAt: (doc && doc.updatedAt) || 0,
      updatedBy: (doc && doc.updatedBy) || ''
    }
  }

  /** 支持只改会员提成比例、只改代采佣金比例，或两者一起改；未传的字段保持原值 */
  async function saveSettings(data, operator) {
    const input = data || {}
    const patch = {}
    if (input.rate !== undefined) patch.rate = clampRate(input.rate)
    if (input.agencyRate !== undefined) patch.agencyRate = clampAgencyRate(input.agencyRate)
    if (!Object.keys(patch).length) throw new AppError(CODES.VALIDATION, '请填写要保存的比例')
    const at = now()
    Object.assign(patch, { updatedAt: at, updatedBy: operator || '' })
    const exists = await repo.get('settings', CS_SETTINGS_ID)
    if (exists) await repo.updateWhere('settings', { id: CS_SETTINGS_ID }, patch)
    else await repo.insert('settings', Object.assign({ id: CS_SETTINGS_ID, createdAt: at }, patch))
    return readSettings()
  }

  async function rateProfile(csId) {
    return (await repo.get('csProfiles', csId)) || null
  }

  /** 某个客服实际生效的比例：单独配置优先，否则用全局默认 */
  async function rateOf(csId) {
    const profile = await rateProfile(csId)
    const own = profile ? profile.rate : null
    if (own !== null && own !== undefined && own !== '' && Number.isFinite(Number(own))) {
      return { rate: Number(own), source: 'staff' }
    }
    const settings = await readSettings()
    return { rate: settings.rate, source: 'global' }
  }

  async function saveRate(csId, rate, operator) {
    const value = rate === null || rate === undefined || rate === '' ? null : clampRate(rate)
    const at = now()
    const patch = { rate: value, updatedAt: at, updatedBy: operator || '' }
    const exists = await repo.get('csProfiles', csId)
    if (exists) await repo.updateWhere('csProfiles', { id: csId }, patch)
    else await repo.insert('csProfiles', Object.assign({ id: csId, createdAt: at }, patch))
    return rateOf(csId)
  }

  /** 代采代售佣金比例：客服单独配置优先，未配置用全局默认（与会员提成比例互相独立） */
  async function agencyRateOf(csId) {
    const profile = await rateProfile(csId)
    const own = profile ? profile.agencyRate : null
    if (own !== null && own !== undefined && own !== '' && Number.isFinite(Number(own))) {
      return { rate: Number(own), source: 'staff' }
    }
    const settings = await readSettings()
    return { rate: settings.agencyRate, source: 'global' }
  }

  async function saveAgencyRate(csId, rate, operator) {
    const value = rate === null || rate === undefined || rate === '' ? null : clampAgencyRate(rate)
    const at = now()
    const patch = { agencyRate: value, updatedAt: at, updatedBy: operator || '' }
    const exists = await repo.get('csProfiles', csId)
    if (exists) await repo.updateWhere('csProfiles', { id: csId }, patch)
    else await repo.insert('csProfiles', Object.assign({ id: csId, createdAt: at }, patch))
    return agencyRateOf(csId)
  }

  async function bindingOfCs(csId) {
    return (await repo.get('csBindings', csId)) || null
  }

  async function bindingOfUser(uid) {
    const rows = await repo.find('csBindings', { uid }, { limit: 1 })
    return rows[0] || null
  }

  async function listBindings() {
    return repo.find('csBindings', {}, { sort: { field: 'boundAt', dir: 'desc' }, limit: 500 })
  }

  async function bind(data, operator) {
    const csId = String(data.csId || '').trim()
    const uid = String(data.uid || '').trim()
    if (!csId) throw new AppError(CODES.VALIDATION, '请选择客服账号')
    if (!uid) throw new AppError(CODES.VALIDATION, '请填写要绑定的用户账号')
    const exists = await bindingOfCs(csId)
    if (exists) {
      throw new AppError(CODES.CONFLICT, `该客服已绑定用户「${exists.nick || exists.uid}」，请先解绑`)
    }
    const occupied = await bindingOfUser(uid)
    if (occupied) {
      throw new AppError(CODES.CONFLICT, `该用户已归属客服「${occupied.csName || occupied.csId}」`)
    }
    const user = await repo.get('users', uid)
    if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在，请核对用户标识')
    const at = now()
    const doc = {
      id: csId,
      csId,
      csName: String(data.csName || '').trim(),
      uid,
      nick: user.nick || '',
      boundBy: operator || '',
      boundAt: at,
      updatedAt: at
    }
    await repo.insert('csBindings', doc)
    return doc
  }

  async function unbind(csId) {
    const exists = await bindingOfCs(csId)
    if (!exists) throw new AppError(CODES.NOT_FOUND, '该客服还没有绑定用户')
    await repo.removeWhere('csBindings', { id: csId }, 1)
    return { csId, uid: exists.uid, unbound: true }
  }

  /**
   * 会员支付成功：若付款人是某客服绑定用户的直接下级，自动计提成。
   * 只认 referralBindings 中「付款人 → 绑定用户」这一层，不做多级穿透。
   */
  async function recordMemberPayment(data) {
    const payerUid = String(data.payerUid || '')
    const paymentId = String(data.paymentId || '')
    const amount = round2(data.amount)
    const paidAt = Number(data.paidAt || data.at) || now()
    if (!payerUid || !paymentId || amount <= 0) return null

    const payerBinding = await repo.get('referralBindings', payerUid)
    if (!payerBinding || !payerBinding.refUid) return null
    const csBinding = await bindingOfUser(payerBinding.refUid)
    if (!csBinding) return null
    if (Number(csBinding.boundAt || 0) && Number(csBinding.boundAt) > paidAt) return null

    const { rate, source } = await rateOf(csBinding.csId)
    const commission = round2(amount * rate)
    const at = now()
    const id = 'CSC' + sha256Hex(`cs-commission:${paymentId}`).slice(0, 20)
    const doc = {
      id,
      csId: csBinding.csId,
      csName: csBinding.csName || '',
      boundUid: csBinding.uid,
      payerUid,
      paymentId,
      orderId: data.orderId || '',
      planLabel: data.planLabel || '',
      amount,
      rate,
      rateSource: source,
      commission,
      status: '已计提',
      paidAt,
      createdAt: at
    }
    try {
      await repo.insert('csCommissions', doc)
      return doc
    } catch (err) {
      if (err && err.code === CODES.CONFLICT) return null
      throw err
    }
  }

  async function commissionsOf(csId, paging) {
    const page = Math.max(1, Number((paging && paging.page) || 1))
    const limit = Math.min(100, Math.max(1, Number((paging && paging.limit) || 20)))
    const query = { csId }
    const total = await repo.count('csCommissions', query)
    const items = await repo.find('csCommissions', query, {
      sort: { field: 'paidAt', dir: 'desc' },
      skip: (page - 1) * limit,
      limit
    })
    return { items, total, page, limit, hasMore: (page - 1) * limit + items.length < total }
  }

  /**
   * 服务费到账后代采代售佣金计提（幂等：同一 paymentId 只计一次）。
   * data: { paymentId, csId, csName, agencyId, leadId, contractId, contractNo, side, item, feeAmount, paidAt }
   * 没有归属客服（csId 为空）时不计提，由调用方记审计。
   */
  async function recordAgencyFeePaid(data) {
    const input = data || {}
    const paymentId = String(input.paymentId || '').trim()
    const csId = String(input.csId || '').trim()
    const feeAmount = round2(input.feeAmount)
    if (!paymentId || !csId) return null
    if (feeAmount <= 0) return null
    const { rate, source } = await agencyRateOf(csId)
    const commission = round2(feeAmount * rate)
    /* 比例为 0 时没有金额可发，不写流水，避免工资明细出现 0 元单 */
    if (commission <= 0) return null
    const paidAt = Number(input.paidAt) || now()
    const at = now()
    const id = 'CSA' + sha256Hex(`cs-agency-commission:${paymentId}`).slice(0, 20)
    const doc = {
      id,
      csId,
      csName: String(input.csName || ''),
      agencyId: String(input.agencyId || ''),
      leadId: String(input.leadId || ''),
      contractId: String(input.contractId || ''),
      contractNo: String(input.contractNo || ''),
      paymentId,
      side: input.side === 'sell' ? 'sell' : 'buy',
      item: String(input.item || ''),
      feeAmount,
      rate,
      rateSource: source,
      commission,
      monthKey: monthKeyOf(paidAt),
      status: '已计提',
      paidAt,
      reversedCommission: 0,
      reversedAt: 0,
      createdAt: at
    }
    try {
      await repo.insert('csAgencyCommissions', doc)
      return doc
    } catch (err) {
      if (err && err.code === CODES.CONFLICT) return null
      throw err
    }
  }

  /**
   * 服务费退款冲正：不改历史月份，只把冲正金额记到当月，工资自动扣回。
   * 幂等：reversedAt 已写则直接返回，重复退款不会重复扣。
   */
  async function reverseAgencyCommission(data) {
    const input = data || {}
    const paymentId = String(input.paymentId || '').trim()
    if (!paymentId) return null
    const rows = await repo.find('csAgencyCommissions', { paymentId }, { limit: 1 })
    const row = rows[0]
    if (!row) return null
    if (Number(row.reversedAt) > 0) return row
    const at = Number(input.at) || now()
    const patch = {
      reversedCommission: round2(row.commission),
      reversedAt: at,
      reverseReason: String(input.reason || ''),
      status: '已冲正',
      updatedAt: at
    }
    const res = await repo.updateWhere('csAgencyCommissions', { id: row.id, reversedAt: 0 }, patch)
    if (!res || !res.count) {
      const latest = await repo.get('csAgencyCommissions', row.id)
      return latest || row
    }
    return Object.assign({}, row, patch)
  }

  async function agencyCommissionsOf(csId, paging) {
    const page = Math.max(1, Number((paging && paging.page) || 1))
    const limit = Math.min(100, Math.max(1, Number((paging && paging.limit) || 20)))
    const query = { csId }
    const total = await repo.count('csAgencyCommissions', query)
    const items = await repo.find('csAgencyCommissions', query, {
      sort: { field: 'paidAt', dir: 'desc' },
      skip: (page - 1) * limit,
      limit
    })
    return { items, total, page, limit, hasMore: (page - 1) * limit + items.length < total }
  }

  /**
   * 客服工资：分享开通提成 + 代采代售佣金，按北京时间自然月累计。
   * 冲正金额记在冲正发生的月份，所以历史月份不回溯变动。
   */
  async function salaryOf(csId, monthKey) {
    const mk = normalizeMonthKey(monthKey)
    const [memberRows, agencyRows] = await Promise.all([
      repo.find('csCommissions', { csId }, { limit: 5000 }),
      repo.find('csAgencyCommissions', { csId }, { limit: 5000 })
    ])
    let memberCommission = 0
    let memberOrderCount = 0
    let agencyCommission = 0
    let agencyOrderCount = 0
    let totalMember = 0
    let totalAgency = 0
    for (const row of memberRows) {
      const amount = round2(row.commission)
      totalMember = round2(totalMember + amount)
      if (monthKeyOf(row.paidAt) === mk) {
        memberCommission = round2(memberCommission + amount)
        memberOrderCount += 1
      }
    }
    for (const row of agencyRows) {
      const amount = round2(row.commission)
      totalAgency = round2(totalAgency + amount)
      if (monthKeyOf(row.paidAt) === mk) {
        agencyCommission = round2(agencyCommission + amount)
        agencyOrderCount += 1
      }
      const reversed = round2(row.reversedCommission)
      if (reversed > 0) {
        totalAgency = round2(totalAgency - reversed)
        if (Number(row.reversedAt) > 0 && monthKeyOf(row.reversedAt) === mk) {
          agencyCommission = round2(agencyCommission - reversed)
        }
      }
    }
    return {
      csId,
      monthKey: mk,
      memberCommission,
      memberOrderCount,
      agencyCommission,
      agencyOrderCount,
      monthSalary: round2(memberCommission + agencyCommission),
      totalMemberCommission: totalMember,
      totalAgencyCommission: totalAgency,
      totalSalary: round2(totalMember + totalAgency),
      totalOrderCount: memberRows.length + agencyRows.length
    }
  }

  async function ratingsOf(csId, paging) {
    const page = Math.max(1, Number((paging && paging.page) || 1))
    const limit = Math.min(100, Math.max(1, Number((paging && paging.limit) || 20)))
    const query = { csId }
    const total = await repo.count('csRatings', query)
    const items = await repo.find('csRatings', query, {
      sort: { field: 'createdAt', dir: 'desc' },
      skip: (page - 1) * limit,
      limit
    })
    return { items, total, page, limit, hasMore: (page - 1) * limit + items.length < total }
  }

  async function statsOf(csId) {
    const mk = monthKeyOf(now())
    const [binding, rateInfo, agencyRateInfo, commissions, ratings, salary] = await Promise.all([
      bindingOfCs(csId),
      rateOf(csId),
      agencyRateOf(csId),
      repo.find('csCommissions', { csId }, { limit: 5000 }),
      repo.find('csRatings', { csId }, { limit: 5000 }),
      salaryOf(csId, mk)
    ])
    const start = monthStart(now())
    const totals = commissions.reduce((acc, row) => {
      const amount = round2(row.amount)
      const commission = round2(row.commission)
      acc.performance = round2(acc.performance + amount)
      acc.commission = round2(acc.commission + commission)
      acc.orders += 1
      if (Number(row.paidAt) >= start) {
        acc.monthPerformance = round2(acc.monthPerformance + amount)
        acc.monthCommission = round2(acc.monthCommission + commission)
        acc.monthOrders += 1
      }
      return acc
    }, { performance: 0, commission: 0, orders: 0, monthPerformance: 0, monthCommission: 0, monthOrders: 0 })

    const servedCount = await repo.count('leads', { assignedAccount: csId, targetType: 'agency' })
    const endedCount = await repo.count('leads', { assignedAccount: csId, targetType: 'agency', csStatus: CS_STATUS.ENDED })
    return {
      csId,
      binding,
      rate: rateInfo.rate,
      rateSource: rateInfo.source,
      agencyRate: agencyRateInfo.rate,
      agencyRateSource: agencyRateInfo.source,
      performanceTotal: totals.performance,
      commissionTotal: totals.commission,
      orderCount: totals.orders,
      monthPerformance: totals.monthPerformance,
      monthCommission: totals.monthCommission,
      monthOrderCount: totals.monthOrders,
      /* 工资：分享开通提成 + 代采代售佣金，按月累计 */
      monthSalary: salary.monthSalary,
      monthAgencyCommission: salary.agencyCommission,
      monthAgencyOrderCount: salary.agencyOrderCount,
      totalSalary: salary.totalSalary,
      ratingCount: ratings.length,
      ratingAvg: ratingAvgOf(ratings),
      servedCount,
      endedCount
    }
  }

  return {
    readSettings,
    saveSettings,
    rateOf,
    saveRate,
    agencyRateOf,
    saveAgencyRate,
    bindingOfCs,
    bindingOfUser,
    listBindings,
    bind,
    unbind,
    recordMemberPayment,
    recordAgencyFeePaid,
    reverseAgencyCommission,
    commissionsOf,
    agencyCommissionsOf,
    salaryOf,
    ratingsOf,
    statsOf
  }
}

module.exports = {
  CS_STATUS,
  CS_SETTINGS_ID,
  DEFAULT_RATE,
  RATE_MIN,
  RATE_MAX,
  AGENCY_RATE_DEFAULT,
  AGENCY_RATE_MIN,
  AGENCY_RATE_MAX,
  RATING_TAGS,
  round2,
  csStatusOf,
  isCsConsult,
  monthKeyOf,
  normalizeMonthKey,
  createCsEngine
}
