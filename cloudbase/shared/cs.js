'use strict'

/**
 * 客服业务域：客服绑定用户、代采代售委托佣金、咨询单服务状态与评价。
 *
 * 业务口径（2026-11 确认）：
 * 1. 一个客服只能绑定一个用户账号，一个用户也只能归属一个客服；
 * 2. 客服佣金只有两项来源：推广佣金（二级，由 promote 域计提进推广佣金台账）
 *    与委托佣金（代采 / 代售服务费实收 × 比例，计入客服工资）；
 * 3. 不设「会员支付提成」：会员付款只产生推广佣金，不再向客服计提；
 * 4. 委托佣金比例优先取客服单独配置，未配置时用管理端全局默认；
 * 5. 同一 paymentId 只计提一次，重复到账回调幂等；
 * 6. 评价只允许咨询单所属用户在客服结束会话后提交一次，聚合进客服档案。
 */

const { AppError, CODES } = require('./errors')
const { sha256Hex } = require('./crypto')

const CS_STATUS = Object.freeze({
  WAITING: '待领取',
  SERVING: '服务中',
  ENDED: '已结束'
})

const CS_SETTINGS_ID = 'cs'
/* 代采代售佣金：基数为服务费实收金额 */
const AGENCY_RATE_DEFAULT = 0.2
const AGENCY_RATE_MIN = 0
const AGENCY_RATE_MAX = 0.5
/* 工单超时自动结束：客服领取后（或最后一条回复后）超过该时长未回复即结束并邀请评价 */
const CS_IDLE_DEFAULT = 30
const CS_IDLE_MIN = 5
const CS_IDLE_MAX = 240
const CN_OFFSET = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const RATING_TAGS = Object.freeze(['专业', '响应快', '态度好', '讲解清楚', '解决问题', '需要改进'])

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
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

function clampIdleMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new AppError(CODES.VALIDATION, '超时时长格式不正确')
  if (n < CS_IDLE_MIN || n > CS_IDLE_MAX) {
    throw new AppError(CODES.VALIDATION, `超时时长需在 ${CS_IDLE_MIN}–${CS_IDLE_MAX} 分钟之间`)
  }
  return Math.round(n)
}

/** 北京时间月份键：YYYY-MM，工资与佣金按月归档共用 */
function monthKeyOf(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 北京时间日期键：YYYY-MM-DD，每日工作量按它聚合 */
function dayKeyOf(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 北京时间自然日零点（毫秒） */
function dayStartOf(ms) {
  return Math.floor((Number(ms) + CN_OFFSET) / DAY_MS) * DAY_MS - CN_OFFSET
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
    const agencyRate =
      doc && Number.isFinite(Number(doc.agencyRate)) ? Number(doc.agencyRate) : AGENCY_RATE_DEFAULT
    const idleMinutes =
      doc && Number.isFinite(Number(doc.idleMinutes)) && Number(doc.idleMinutes) > 0
        ? Number(doc.idleMinutes)
        : CS_IDLE_DEFAULT
    return {
      id: CS_SETTINGS_ID,
      agencyRate,
      agencyRateMin: AGENCY_RATE_MIN,
      agencyRateMax: AGENCY_RATE_MAX,
      idleMinutes,
      idleMin: CS_IDLE_MIN,
      idleMax: CS_IDLE_MAX,
      updatedAt: (doc && doc.updatedAt) || 0,
      updatedBy: (doc && doc.updatedBy) || ''
    }
  }

  /** 支持只改委托佣金比例或工单超时时长，未传的字段保持原值 */
  async function saveSettings(data, operator) {
    const input = data || {}
    const patch = {}
    if (input.agencyRate !== undefined) patch.agencyRate = clampAgencyRate(input.agencyRate)
    if (input.idleMinutes !== undefined) patch.idleMinutes = clampIdleMinutes(input.idleMinutes)
    if (!Object.keys(patch).length) throw new AppError(CODES.VALIDATION, '请填写要保存的配置')
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

  /** 代采代售佣金比例：客服单独配置优先，未配置用全局默认 */
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

  /**
   * 绑定即锁定：绑定发生时把当时生效的委托佣金比例写进绑定记录。
   * 之后管理员再调整全局默认或客服单独比例，只影响新的绑定，历史绑定不追溯。
   */
  async function boundRatesOf(csId) {
    const agency = await agencyRateOf(csId)
    return {
      agencyRate: agency.rate,
      agencyRateSource: agency.source
    }
  }

  /** 读取绑定上的锁定比例；老绑定没有快照时返回 null，由调用方回落到当前比例 */
  function bindingRatesOf(binding) {
    const b = binding || {}
    const valid = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
    return {
      agencyRate: valid(b.agencyRate) ? Number(b.agencyRate) : null,
      agencyRateSource: b.agencyRateSource || ''
    }
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
    /* 绑定即锁定比例：之后调整比例不影响这条绑定产生的佣金 */
    Object.assign(doc, await boundRatesOf(csId))
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
    /* 委托佣金同样按绑定时刻锁定的比例计提；老绑定无快照时回落到当前比例 */
    const binding = await bindingOfCs(csId)
    const locked = bindingRatesOf(binding)
    const agency = locked.agencyRate === null
      ? await agencyRateOf(csId)
      : { rate: locked.agencyRate, source: 'binding' }
    const rate = agency.rate
    const source = agency.source
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
   * 客服工资：只含代采代售委托佣金，按北京时间自然月累计。
   * 冲正金额记在冲正发生的月份，所以历史月份不回溯变动。
   */
  async function salaryOf(csId, monthKey) {
    const mk = normalizeMonthKey(monthKey)
    const agencyRows = await repo.find('csAgencyCommissions', { csId }, { limit: 5000 })
    let agencyCommission = 0
    let agencyOrderCount = 0
    let totalAgency = 0
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
      agencyCommission,
      agencyOrderCount,
      monthSalary: agencyCommission,
      totalAgencyCommission: totalAgency,
      totalSalary: totalAgency,
      totalOrderCount: agencyRows.length
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
    const [binding, agencyRateInfo, agencyRows, ratings, salary] = await Promise.all([
      bindingOfCs(csId),
      agencyRateOf(csId),
      repo.find('csAgencyCommissions', { csId }, { limit: 5000 }),
      repo.find('csRatings', { csId }, { limit: 5000 }),
      salaryOf(csId, mk)
    ])
    const start = monthStart(now())
    const totals = agencyRows.reduce((acc, row) => {
      const feeAmount = round2(row.feeAmount)
      const commission = round2(row.commission - round2(row.reversedCommission))
      acc.feeAmount = round2(acc.feeAmount + feeAmount)
      acc.commission = round2(acc.commission + commission)
      acc.orders += 1
      if (Number(row.paidAt) >= start) {
        acc.monthFeeAmount = round2(acc.monthFeeAmount + feeAmount)
        acc.monthCommission = round2(acc.monthCommission + commission)
        acc.monthOrders += 1
      }
      return acc
    }, { feeAmount: 0, commission: 0, orders: 0, monthFeeAmount: 0, monthCommission: 0, monthOrders: 0 })

    const servedCount = await repo.count('leads', { assignedAccount: csId, targetType: 'agency' })
    const endedCount = await repo.count('leads', { assignedAccount: csId, targetType: 'agency', csStatus: CS_STATUS.ENDED })
    const locked = bindingRatesOf(binding)
    return {
      csId,
      binding,
      agencyRate: agencyRateInfo.rate,
      agencyRateSource: agencyRateInfo.source,
      /* 当前实际用于计提的委托佣金比例：已绑定取锁定值，未绑定取当前默认 */
      lockedAgencyRate: locked.agencyRate === null ? agencyRateInfo.rate : locked.agencyRate,
      rateLocked: locked.agencyRate !== null,
      /* 委托业绩：服务费实收合计；佣金：计提合计（已扣冲正） */
      agencyFeeTotal: totals.feeAmount,
      commissionTotal: totals.commission,
      orderCount: totals.orders,
      monthAgencyFee: totals.monthFeeAmount,
      monthCommission: totals.monthCommission,
      monthOrderCount: totals.monthOrders,
      /* 工资：只含代采代售委托佣金，按月累计 */
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

  /**
   * 每日工作量：按北京时间自然日聚合客服的咨询领取 / 结束、委托成交、服务费、佣金与评价。
   * 只做只读统计；数据范围（本人 / 全部）由管理端 handler 按角色收敛。
   */
  async function dailyOf(csId, opts) {
    const days = Math.min(30, Math.max(1, Number((opts && opts.days) || 7)))
    const [leads, agencyRows, ratings] = await Promise.all([
      repo.find('leads', { assignedAccount: csId, targetType: 'agency' }, { limit: 5000 }),
      repo.find('csAgencyCommissions', { csId }, { limit: 5000 }),
      repo.find('csRatings', { csId }, { limit: 5000 })
    ])
    const todayStart = dayStartOf(now())
    const buckets = new Map()
    const list = []
    for (let i = days - 1; i >= 0; i -= 1) {
      const row = {
        day: dayKeyOf(todayStart - i * DAY_MS),
        newLeads: 0,
        claimed: 0,
        ended: 0,
        orders: 0,
        feeAmount: 0,
        commission: 0,
        ratingCount: 0,
        ratingSum: 0
      }
      buckets.set(row.day, row)
      list.push(row)
    }
    const bucketOf = (ms) => {
      const value = Number(ms) || 0
      if (!value) return null
      return buckets.get(dayKeyOf(dayStartOf(value))) || null
    }
    for (const lead of leads) {
      const created = bucketOf(lead.createdAt)
      if (created) created.newLeads += 1
      const assigned = bucketOf(lead.assignedAt)
      if (assigned) assigned.claimed += 1
      const ended = bucketOf(lead.csEndedAt)
      if (ended) ended.ended += 1
    }
    for (const row of agencyRows) {
      const paid = bucketOf(row.paidAt)
      if (paid) {
        paid.orders += 1
        paid.feeAmount = round2(paid.feeAmount + round2(row.feeAmount))
        paid.commission = round2(paid.commission + round2(row.commission))
      }
      /* 佣金冲正按冲正日回冲，保证每日数据与工资台账一致 */
      if (Number(row.reversedCommission) > 0) {
        const reversed = bucketOf(row.reversedAt)
        if (reversed) reversed.commission = round2(reversed.commission - round2(row.reversedCommission))
      }
    }
    for (const row of ratings) {
      const created = bucketOf(row.createdAt)
      if (!created) continue
      created.ratingCount += 1
      created.ratingSum += Math.max(0, Math.min(5, Number(row.score) || 0))
    }
    const totals = {
      newLeads: 0,
      claimed: 0,
      ended: 0,
      orders: 0,
      feeAmount: 0,
      commission: 0,
      ratingCount: 0,
      ratingAvg: 0
    }
    let scoreSum = 0
    const items = list.map((row) => {
      totals.newLeads += row.newLeads
      totals.claimed += row.claimed
      totals.ended += row.ended
      totals.orders += row.orders
      totals.feeAmount = round2(totals.feeAmount + row.feeAmount)
      totals.commission = round2(totals.commission + row.commission)
      totals.ratingCount += row.ratingCount
      scoreSum += row.ratingSum
      return {
        day: row.day,
        newLeads: row.newLeads,
        claimed: row.claimed,
        ended: row.ended,
        orders: row.orders,
        feeAmount: row.feeAmount,
        commission: row.commission,
        ratingCount: row.ratingCount,
        ratingAvg: row.ratingCount ? round2(row.ratingSum / row.ratingCount) : 0
      }
    })
    totals.ratingAvg = totals.ratingCount ? round2(scoreSum / totals.ratingCount) : 0
    return { csId, days, from: items.length ? items[0].day : '', to: items.length ? items[items.length - 1].day : '', items, totals }
  }

  return {
    readSettings,
    saveSettings,
    agencyRateOf,
    saveAgencyRate,
    bindingOfCs,
    bindingOfUser,
    bindingRatesOf,
    listBindings,
    bind,
    unbind,
    recordAgencyFeePaid,
    reverseAgencyCommission,
    agencyCommissionsOf,
    salaryOf,
    ratingsOf,
    statsOf,
    dailyOf
  }
}

module.exports = {
  CS_STATUS,
  CS_SETTINGS_ID,
  AGENCY_RATE_DEFAULT,
  AGENCY_RATE_MIN,
  AGENCY_RATE_MAX,
  CS_IDLE_DEFAULT,
  CS_IDLE_MIN,
  CS_IDLE_MAX,
  RATING_TAGS,
  round2,
  csStatusOf,
  isCsConsult,
  monthKeyOf,
  normalizeMonthKey,
  createCsEngine
}
