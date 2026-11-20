'use strict'

/**
 * 交易服务域：代采 / 代售委托、现货盘、粘贴报价、资讯、商机权限。
 *
 * 口径（与小程序端 home / publish / biz 页面保持一致）：
 * 1. 代采 / 代售：用户提交委托（必填截止时间）→ 平台审核通过即上架 → 平台确认成交（委托方只收通知）
 *    → 生成后付费服务费账单（打款后 3 个工作日内到账）→ 财务确认到账 → 客服确认完成；到截止时间仍未成交则自动关闭。
 *    发布、审核、上架均不前置收费。
 * 2. 现货盘：平台在售商品与用户粘贴的报价按「品类 + 型号 + 城市」聚合，
 *    买价取最高预算、卖价取最低报价；用户粘贴的报价视为卖方报价，24 小时有效。
 * 3. 资讯：官方资讯与用户投稿都发布即展示，不审核；违规时由平台下架并告知原因。
 * 4. 商机：普通发布（visibility=public）的内容自动进入匹配池，私密发布不进池；
 *    所有用户默认参与匹配，非会员也能收到提醒并看到全部匹配条目的脱敏信息，
 *    会员（99 元 / 月）可解锁联系方式并领取商机。
 *    是否公开主体不再是进池 / 领取 / 提醒的门槛，只影响主体信息的脱敏展示与
 *    「只看公开主体」筛选（商机展示设置 onlyOpenSubject）。
 */

const { AppError, CODES } = require('./errors')
const { assertAllowed } = require('./restrictions')
const {
  str,
  arrayOfStrings,
  enumOf,
  normalizeContactPhone,
  maskPhone,
  maskName,
  maskIdentity,
  maskSensitiveText,
  fileRef,
  normalizePaging
} = require('./validate')
const { randomId, sha256Hex, decryptField, userNoOf } = require('./crypto')
const { encryptFields, decryptFieldOf } = require('./secrets')
const { assertNoPlaintextContactAllowingPhone } = require('./projection')
const { appendAudit } = require('./audit')
/* 浏览量口径与商品 / 求购一致：同一用户 30 分钟内只计一次 */
const { windowStartOf, VIEW_DEDUPE_MS } = require('./insights')
const { createPromoteEngine } = require('./promote')
/* 用户黑名单：内容可见性与发布提醒按拉黑关系过滤 */
const { isBlocked, blockedPeerIds } = require('./blocks')
const { CS_STATUS, createCsEngine } = require('./cs')
/* 咨询工单阶段机：成交 / 收款主链路据此推进客服标准流程 */
const {
  TICKET_STATE,
  CONTRACT_STATUS,
  ticketStateOf,
  stageOf: consultStageOf,
  stageLabel: consultStageLabel,
  stageIndex: consultStageIndex,
  advance: advanceConsultStage
} = require('./consultflow')
const {
  TRADE_MODES,
  RENT_TERMS,
  EXPOSURES,
  EXPOSURE_LABELS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  PUBLISH_CHANNELS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  LARGE_AMOUNT_THRESHOLD,
  MEDIA_MAX_BYTES,
  MEDIA_SIZE_TEXT,
  LEAD_STATUS,
  CONSULT_STAGE,
  TIERS,
  DEMAND_STATUS,
  /* 会员到期提醒：内容模板与提前天数 / 次数 / 间隔统一走设置 */
  memberRemindOf
} = require('./constants')

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 领取口径：不设名额上限，商机在架期间所有匹配到的会员都可以领取。
 * 只保留已领取人数用于展示与去重。
 */
function claimMetaOf(opts) {
  const used = Number(opts && opts.claimCount) || 0
  return {
    claimCount: used,
    claimLimit: 0,
    claimRemaining: 0,
    claimFull: false,
    claimText: used > 0 ? `已有 ${used} 家领取` : ''
  }
}

/**
 * 委托单对应的咨询工单：代采代售咨询按 agencyId 关联。
 * 合同审核通过前可能有多家同时对接，此时优先返回已锁定的唯一对接方工单；
 * 用户未走客服咨询（自助发布）时没有工单，返回 null。
 */
async function consultLeadOfAgency(repo, agencyId) {
  const id = String(agencyId || '')
  if (!id) return null
  const agency = await repo.get('agencies', id)
  const lockedLeadId = String((agency && agency.lockedLeadId) || '')
  if (lockedLeadId) {
    const locked = await repo.get('leads', lockedLeadId)
    if (locked) return locked
  }
  const claimUid = String((agency && agency.claimUid) || '')
  const rows = (await repo.find('leads', { targetType: 'agency', agencyId: id }, { limit: 200 }))
    /* 上架审核工单不是咨询工单，不能参与成交 / 收款 / 退款链路 */
    .filter((row) => row.ticketKind !== 'audit')
  if (claimUid) {
    const hit = rows.find((row) => row.uid === claimUid)
    if (hit) return hit
  }
  const open = rows.find((row) => row.ticketState !== TICKET_STATE.INVALID && row.status !== LEAD_STATUS.CLOSED)
  if (open) return open
  /* 工单已全部结束（例如退款冲正需要把 done / paid 回退）：
     取阶段最靠后的一条，保证收款 / 退款能作用在真正走到收款环节的工单上 */
  const sorted = rows
    .filter((row) => row.ticketState !== TICKET_STATE.INVALID)
    .sort((a, b) => consultStageIndex(b) - consultStageIndex(a))
  return sorted[0] || rows[0] || null
}

/**
 * 同一委托统一由一个客服跟进：新建 / 重新开启工单时，
 * 沿用同委托下已在跟进中的客服，避免同一商品被多个客服分别对接。
 * 没有客服在跟进时返回 null，工单仍进入「待领取」。
 */
async function inheritedAgencyCs(repo, agencyId, at) {
  const id = String(agencyId || '')
  if (!id) return null
  const rows = await repo.find('leads', { targetType: 'agency', agencyId: id }, { limit: 200 })
  const hit = rows.find((row) => row && row.ticketKind !== 'audit' && row.assignedAccount &&
    row.ticketState !== TICKET_STATE.INVALID && row.status !== LEAD_STATUS.CLOSED)
  if (!hit) return null
  return {
    assignedTo: hit.assignedTo || hit.csName || '',
    assignedAccount: hit.assignedAccount,
    assignedAt: Number(hit.assignedAt) || at,
    csId: hit.csId || hit.assignedAccount,
    csName: hit.csName || hit.assignedTo || '',
    csClaimedAt: Number(hit.csClaimedAt || hit.assignedAt) || at,
    csStatus: CS_STATUS.SERVING
  }
}

/**
 * 委托上架审核工单：委托提交 / 重新提交后立即在工作台生成一条审核工单，
 * 客服领取并核对委托内容，通过或驳回后工单自动收尾。
 * 一条委托只保留一条审核工单，重新提交时回到待领取，历史记录继续累积在 stageHistory。
 */
async function ensureAgencyAuditTicket(repo, agency, at, options) {
  const doc = agency || {}
  if (!doc.id) return null
  const opts = options || {}
  const id = 'au' + sha256Hex(`agency-audit:${doc.id}`).slice(0, 24)
  const summary = [doc.kind || '', doc.item || '', doc.city || ''].filter(Boolean).join(' · ')
  const step = { stage: 'audit', at, by: '系统', note: opts.note || '等待平台审核上架' }
  const existing = await repo.get('leads', id)
  if (existing) {
    const history = (Array.isArray(existing.stageHistory) ? existing.stageHistory : []).concat([step])
    await repo.updateWhere('leads', { id }, {
      status: LEAD_STATUS.PENDING,
      ticketState: TICKET_STATE.TICKETED,
      serviceStage: 'audit',
      stageAt: at,
      stageHistory: history.slice(-20),
      auditResult: '',
      auditNote: '',
      auditBy: '',
      auditAt: 0,
      /* 重新进入待领取，避免旧客服不在线时卡住审核 */
      assignedTo: '',
      assignedAccount: '',
      assignedAt: 0,
      csStatus: CS_STATUS.WAITING,
      csClaimedAt: 0,
      csId: '',
      csName: '',
      agencySide: doc.side || existing.agencySide || '',
      agencyTitle: doc.item || existing.agencyTitle || '',
      formSummary: summary || existing.formSummary || '',
      updatedAt: at
    })
    return id
  }
  await repo.insert('leads', {
    id,
    uid: doc.ownerId || '',
    source: opts.source || '委托审核',
    ticketKind: 'audit',
    targetType: 'agency',
    targetId: doc.id,
    agencyId: doc.id,
    agencySide: doc.side || '',
    agencyTitle: doc.item || '',
    formSummary: summary,
    productId: '',
    demandId: '',
    compare: [],
    matchPct: 100,
    status: LEAD_STATUS.PENDING,
    tier: TIERS.DEFAULT,
    tierName: '',
    assignedTo: '',
    assignedAccount: '',
    assignedAt: 0,
    contactReleased: false,
    csStatus: CS_STATUS.WAITING,
    csClaimedAt: 0,
    csId: '',
    csName: '',
    ticketState: TICKET_STATE.TICKETED,
    serviceStage: 'audit',
    stageAt: at,
    stageVersion: 0,
    stageHistory: [step],
    auditResult: '',
    auditNote: '',
    auditBy: '',
    auditAt: 0,
    createdAt: at,
    updatedAt: at
  })
  return id
}

/** 审核结论回写审核工单：通过 / 驳回后工单从工作台收尾，转为无效并留痕 */
async function closeAgencyAuditTicket(repo, agencyId, decision, note, staff, at) {
  const id = String(agencyId || '')
  if (!id) return 0
  const rows = await repo.find('leads', { targetType: 'agency', agencyId: id, ticketKind: 'audit' }, { limit: 20 })
  let closed = 0
  for (const row of rows) {
    if (!row || ticketStateOf(row) === TICKET_STATE.INVALID || row.status === LEAD_STATUS.CLOSED) continue
    const history = (Array.isArray(row.stageHistory) ? row.stageHistory : []).concat([{
      stage: 'audit',
      at,
      by: staff || '平台',
      note: decision === '通过' ? '审核通过，委托已上架' : '审核驳回' + (note ? '：' + note : '')
    }])
    const res = await repo.updateWhere('leads', { id: row.id, ticketState: row.ticketState || TICKET_STATE.TICKETED }, {
      status: LEAD_STATUS.CLOSED,
      ticketState: TICKET_STATE.INVALID,
      auditResult: decision || '',
      auditNote: note || '',
      auditBy: staff || '',
      auditAt: at,
      csStatus: CS_STATUS.ENDED,
      csEndedAt: at,
      stageHistory: history.slice(-20),
      updatedAt: at
    })
    if (res && res.count) closed += 1
  }
  return closed
}

/**
 * 主链路推进工单阶段：成交 / 收款 / 退款都会调用，工单缺失或阶段不在预期时只记日志，
 * 不能让流程外数据（自助发布、升级前老单）把成交与财务确认阻断。
 */
async function advanceConsultStageQuiet(repo, agencyId, from, to, options) {
  const lead = await consultLeadOfAgency(repo, agencyId)
  if (!lead) return null
  const current = consultStageOf(lead)
  if (current === to) return lead
  if (current !== from) {
    console.warn(`[consult] 工单 ${lead.id} 阶段为 ${current}，跳过 ${from} -> ${to}`)
    return null
  }
  try {
    return await advanceConsultStage(repo, lead, to, options)
  } catch (err) {
    console.error('[consult] 阶段推进失败 ' + (err && err.message))
    return null
  }
}

/* 工单主流程顺序：不包含 deal_pending（升级前历史态），逐级补齐时直接跨过 */
const CONSULT_MAIN_PATH = Object.freeze([
  CONSULT_STAGE.COMMUNICATING,
  CONSULT_STAGE.TERMS,
  CONSULT_STAGE.CONTRACT,
  CONSULT_STAGE.SIGNED,
  CONSULT_STAGE.FEE,
  CONSULT_STAGE.PAID,
  CONSULT_STAGE.DONE
])

/**
 * 把工单阶段逐级补齐到目标阶段。
 * 平台在「委托管理」直接确认成交时，工单可能还停在沟通中 / 条件已确认 / 合同待审核，
 * 一步跳到「服务费待支付」会被阶段白名单拒绝，工单就永久卡在旧阶段：
 * 客服看不到「上传服务费凭证」，财务确认不到账，工单永远闭合不到完成。
 * 这里沿主流程逐级推进，每一步仍走 advance 的白名单校验、阶段通知与审计。
 */
async function advanceConsultStageTo(repo, agencyId, target, options) {
  const limit = CONSULT_MAIN_PATH.indexOf(target)
  if (limit < 0) return null
  let lead = await consultLeadOfAgency(repo, agencyId)
  if (!lead) return null
  for (let step = 0; step < CONSULT_MAIN_PATH.length; step += 1) {
    const current = consultStageOf(lead)
    if (current === target) return lead
    const from = CONSULT_MAIN_PATH.indexOf(current)
    /* 已终止 / 已完成 / 未知阶段：不强行往回拉，保持原状 */
    if (from < 0 || from >= limit) return null
    try {
      lead = await advanceConsultStage(repo, lead, CONSULT_MAIN_PATH[from + 1], options)
    } catch (err) {
      console.error('[consult] 阶段补齐失败 ' + (err && err.message))
      return null
    }
  }
  return null
}

/**
 * 关闭同一委托下除 keepLeadId 之外的全部对接工单。
 * 委托锁定唯一对接方、或委托已成交后，其余对接方必须真正结束：
 * 之前只改 status / ticketState 不改 serviceStage，前端按阶段判断会话是否结束，
 * 已关闭的工单仍显示可以发消息；用户端也一直显示「服务中」。
 */
async function closeOtherAgencyLeads(repo, options) {
  const o = options || {}
  const agencyId = String(o.agencyId || '')
  const keepId = String(o.keepLeadId || '')
  if (!agencyId) return 0
  const at = Number(o.at) || Date.now()
  const by = String(o.by || '')
  const note = String(o.note || AGENCY_LOCKED_CLOSE_NOTE)
  const rows = await repo.find('leads', { targetType: 'agency', agencyId }, { limit: 500 })
  let closed = 0
  for (const row of rows) {
    if (!row || row.id === keepId) continue
    const stage = consultStageOf(row)
    if (stage === CONSULT_STAGE.DONE || stage === CONSULT_STAGE.ABORTED) continue
    /* 已经关闭过的工单只同步阶段，不再重复计入关闭数量 / 重复通知 */
    const alreadyClosed = row.status === LEAD_STATUS.CLOSED
    const history = Array.isArray(row.stageHistory) ? row.stageHistory.slice() : []
    history.push({ stage: CONSULT_STAGE.ABORTED, at, by, note })
    const res = await repo.updateWhere('leads', { id: row.id }, {
      status: LEAD_STATUS.CLOSED,
      csStatus: CS_STATUS.ENDED,
      ticketState: TICKET_STATE.INVALID,
      serviceStage: CONSULT_STAGE.ABORTED,
      stageAt: at,
      stageBy: by,
      stageNote: note,
      stageVersion: (Number(row.stageVersion) || 0) + 1,
      stageHistory: history,
      closeReason: note,
      csEndedAt: at,
      csEndedBy: by,
      closedBy: by,
      updatedAt: at
    })
    if (!res || !res.count) continue
    if (alreadyClosed) continue
    closed += 1
    /* 其余对接方尚未审核的居间合同一并作废，避免停在「待审核」的孤儿合同 */
    await repo.updateWhere('agencyContracts', { leadId: row.id, status: CONTRACT_STATUS.PENDING }, {
      status: CONTRACT_STATUS.VOID,
      reviewedBy: 'system',
      reviewedByName: '系统',
      reviewNote: note,
      reviewedAt: at,
      updatedAt: at
    })
    const claimId = 'bc' + sha256Hex(`${row.uid}:agency:${agencyId}`).slice(0, 24)
    await repo.removeWhere('bizClaims', { id: claimId }, 1)
    await notifyAgencySold(repo, row, at)
  }
  return closed
}

/**
 * 代采 / 代购（buy）：待审核 → 已上架 → 已成交 → 已完成；审核不通过驳回。
 * 代售（sell）：待审核 → 已上架 → 已成交 → 已完成；资料不合格驳回。
 * 发布、审核、上架均不前置收费；平台（客服 / 管理员）确认成交后按成交金额生成后付费服务费账单，
 * 委托方只收通知、无需确认；财务确认到账后由客服（有工单）或管理员（自助发布）确认完成，委托归档。
 * 到截止时间仍未成交的委托自动关闭。「待确认成交」仅用于兼容升级前的旧数据。
 */
const AGENCY_STATUS = Object.freeze({
  REVIEW: '待审核',
  PENDING: '待确认',
  APPROVED: '已通过',
  ACTIVE: '已上架',
  /* 居间合同审核通过：唯一对接方已锁定，委托立即退出商机池，不再接受新的领取 / 对接 */
  LOCKED: '已锁定',
  DEAL_PENDING: '待确认成交',
  DEALT: '已成交',
  DONE: '已完成',
  CLOSED: '已关闭',
  REJECTED: '已驳回'
})
const AGENCY_STATUS_LIST = Object.freeze([
  AGENCY_STATUS.REVIEW,
  AGENCY_STATUS.PENDING,
  AGENCY_STATUS.APPROVED,
  AGENCY_STATUS.ACTIVE,
  AGENCY_STATUS.LOCKED,
  AGENCY_STATUS.DEAL_PENDING,
  AGENCY_STATUS.DEALT,
  AGENCY_STATUS.DONE,
  AGENCY_STATUS.CLOSED,
  AGENCY_STATUS.REJECTED
])
/* 代采 / 代售同时进行的委托：待审核、待确认、已通过、已上架、已锁定都占用名额 */
const AGENCY_OPEN_STATUSES = Object.freeze([
  AGENCY_STATUS.REVIEW,
  AGENCY_STATUS.PENDING,
  AGENCY_STATUS.APPROVED,
  AGENCY_STATUS.ACTIVE,
  AGENCY_STATUS.LOCKED
])
/* 到期会自动关闭的状态：已成交 / 已完成不受截止时间影响 */
const AGENCY_EXPIRABLE_STATUSES = Object.freeze([
  AGENCY_STATUS.REVIEW,
  AGENCY_STATUS.PENDING,
  AGENCY_STATUS.APPROVED,
  AGENCY_STATUS.ACTIVE
])
const AGENCY_CLOSE_REASON_EXPIRED = '已到截止时间'
const AGENCY_TTL_MS = 30 * DAY_MS
const AGENCY_ACTIVE_LIMIT = 10

/**
 * 服务费口径：与小程序 publish 页完全一致，服务端重新计算，客户端传值一律忽略。
 * 代采 / 代售全部为后付费：发布、审核、上架不收费，成交后按下列口径收取。
 * - 代采 / 代售：≤3 万 299 元 / 单；3 万–100 万 1%，封顶 5000；100 万元以上 0.5%，上不封顶；
 * - 1000 万元及以上代采 / 代售费率不变（仍为 0.5%），仅需额外资料核验，代采仅平台可见；
 * - 租赁：按首月租金合计，服务费为一个月租金，买卖双方各承担 50%，委托方账单只收首月租金的 50%；
 *   租赁不因金额大小改按比例计费。
 */
function agencyFee(amount, rental, side) {
  const total = Number(amount) || 0
  if (total <= 0) return { fee: 0, upfront: 0, rule: '金额未填写', note: '' }

  /* 租赁：一个月租金由买卖双方各承担 50%，委托方账单为半个月租金 */
  if (rental) {
    return {
      fee: round2(total * 0.5),
      upfront: 0,
      deferredFee: true,
      rule: '按首月租金合计，买卖双方各承担 50%（成交后支付）',
      note: '本账单为委托方应承担的半个月租金，另一方 50% 由平台另行收取'
    }
  }

  /* 1000 万元及以上不再免单：代采、代售统一按 0.5% 成交后收取 */
  if (total >= LARGE_AMOUNT_THRESHOLD) {
    return {
      fee: round2(total * 0.005),
      upfront: 0,
      largeAmount: true,
      deferredFee: true,
      rule: '100 万元以上：0.5%，上不封顶（成交后支付）',
      note: side === 'buy'
        ? '提交采购意向函、验资证明、联系人身份证，委托授权书可选；平台核验后上架；订单只对平台可见；成交后支付 0.5% 服务费'
        : '提交营业执照、物权证明、联系人身份证，委托授权书可选；平台核验后上架；成交后支付 0.5% 服务费'
    }
  }

  if (total <= 30000) {
    return { fee: 299, upfront: 0, rule: '成交金额 3 万元以内，服务费 299 元（成交后支付）', note: '成交后支付' }
  }
  if (total <= 1000000) {
    return {
      fee: round2(Math.min(total * 0.01, 5000)),
      upfront: 0,
      rule: '3 万 - 100 万元，按 1% 收取（封顶 5000 元，成交后支付）',
      note: '成交后支付'
    }
  }
  return {
    fee: round2(total * 0.005),
    upfront: 0,
    rule: '100 万元以上，按 0.5% 收取，上不封顶（成交后支付）',
    note: '成交后支付'
  }
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

/** 金额展示：10000 以上用「万」，其余整数加千分位 */
function moneyText(value) {
  const n = Number(value) || 0
  if (n >= 10000) {
    const w = Math.round((n / 10000) * 10) / 10
    return `${w} 万`
  }
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function dateText(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 北京时间日期 + 时分：2026-11-11 14:30 */
function dateTimeText(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 北京时间当天 00:00 的绝对毫秒值（云函数运行在 UTC，统一按 +08:00 口径） */
function beijingDayStart(ms) {
  const t = Number(ms) || 0
  return Math.floor((t + 8 * 60 * 60 * 1000) / DAY_MS) * DAY_MS - 8 * 60 * 60 * 1000
}

/**
 * 委托截止时间：必填，须晚于今天且不超过 365 天。
 * 截止日当天 23:59:59.999（北京时间）为最后有效时刻，也是代采 / 代售合同期终点。
 */
function parseAgencyDeadline(value, at) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) throw new AppError(CODES.VALIDATION, '请选择委托截止时间')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(CODES.VALIDATION, '委托截止时间格式应为 YYYY-MM-DD')
  }
  const dayStart = Date.parse(raw + 'T00:00:00+08:00')
  if (!Number.isFinite(dayStart)) throw new AppError(CODES.VALIDATION, '委托截止时间格式应为 YYYY-MM-DD')
  const todayStart = beijingDayStart(at)
  if (dayStart <= todayStart) throw new AppError(CODES.VALIDATION, '委托截止时间需晚于今天')
  if (dayStart > todayStart + 365 * DAY_MS) throw new AppError(CODES.VALIDATION, '委托截止时间需在 365 天以内')
  return { deadline: raw, deadlineAt: beijingDayStart(dayStart) + DAY_MS - 1 }
}

/** 加 N 个工作日：跳过周六日（按北京时间，不处理法定节假日），返回到达当日 23:59:59.999 */
function addWorkdays(ms, days) {
  let day = beijingDayStart(ms)
  let left = Math.max(0, Number(days) || 0)
  while (left > 0) {
    day += DAY_MS
    const weekday = new Date(day + 8 * 60 * 60 * 1000).getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return day + DAY_MS - 1
}

/** 作者主页跳转键：与 handlers.user 的 ownerKeyOf 同口径，不暴露 openid */
function authorKeyOf(uid) {
  return 'o_' + sha256Hex('owner|' + String(uid || '')).slice(0, 18)
}

function relTime(at, now) {
  const ms = Number(at) || 0
  if (!ms) return ''
  const diff = Math.max(0, Number(now) - ms)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`
  return dateText(ms)
}

/** 主体名称脱敏：个人按姓名，企业保留前后各两个字 */
function maskSubject(subject, subjectType) {
  const s = String(subject == null ? '' : subject).trim()
  if (!s) return ''
  if (subjectType === 'person' || subjectType === '个人') return maskName(s)
  if (s.length <= 4) return maskName(s)
  return s.slice(0, 2) + '***' + s.slice(-2)
}

function maskCredit(code) {
  const s = String(code == null ? '' : code).trim()
  if (!s) return ''
  if (s.length <= 8) return maskName(s)
  return s.slice(0, 4) + '****' + s.slice(-4)
}

function maskIdCard(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s) return ''
  if (s.length <= 8) return maskName(s)
  return s.slice(0, 4) + '*'.repeat(Math.max(4, s.length - 8)) + s.slice(-4)
}

/** 机型归一化与匹配：与小程序端共用 shared/model.js，保证两端口径一致 */
const { normModel, modelHit, modelMatch, modelCoreOf, capacityOf } = require('./model')

/**
 * 「同型号」比较：归一化后相等，或一方包含另一方。
 * 允许「H200 141G SXM」命中「H200 141G SXM 整机（8 卡）」这种多带后缀的写法，
 * 也允许「2288H V7」命中「FusionServer 2288H V7」这种多带品牌前缀的写法；
 * 品牌归属本身不影响判断，调用方会同时忽略品牌维度。
 */
function modelSameHit(left, right) {
  const a = normModel(left)
  const b = normModel(right)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

function normPlace(value) {
  const text = String(value == null ? '' : value).trim()
  return text === '不限' ? '' : text
}

/** 成色「不限」的口径：这些值一律视为未填写，不参与匹配 */
const COND_ANY_VALUES = ['不限', '不限成色', '成色不限', '不限新旧', '新旧不限', '无要求', '任意']

/** 成色归并：全新 / 二手；拆机件、翻新、9 成新等一律按二手处理 */
function condFamily(value) {
  const s = normPlace(value)
  if (!s) return ''
  if (COND_ANY_VALUES.indexOf(s) >= 0) return ''
  if (s === '全新' || s === '新' || s === '未拆封') return 'new'
  return 'used'
}

/**
 * 成色集合：需求常写成「全新 / 9 成新」这类多选，拆开后归并成集合，
 * 双方有任一交集即视为成色相符（多选成色以前会被整体判成二手而漏匹配）
 */
function condFamilies(value) {
  const out = []
  String(value == null ? '' : value).split(/[\/、,，|]+/).forEach((part) => {
    const fam = condFamily(part)
    if (fam && out.indexOf(fam) < 0) out.push(fam)
  })
  return out
}

/** 起订量：未填按 1 处理，起订量永远不小于 1 */
function moqOf(stock) {
  const n = Math.floor(Number(stock && stock.minQty) || 0)
  return n > 0 ? n : 1
}

/**
 * 型号库反查系列：老数据只存了 cat / brand / model，没有 series 字段，
 * 用内置目录兜底，保证「B300 系列」的其它型号也能算同族。
 */
let catalogSeriesIndex = null
function catalogSeriesOf(cat, model) {
  const c = String(cat == null ? '' : cat).trim()
  const m = String(model == null ? '' : model).trim()
  if (!c || !m) return ''
  if (!catalogSeriesIndex) {
    const index = new Map()
    try {
      const { DEVICE_CATALOG } = require('./device-catalog')
      for (const catName of Object.keys(DEVICE_CATALOG || {})) {
        const brands = DEVICE_CATALOG[catName] || {}
        for (const brandName of Object.keys(brands)) {
          const seriesMap = brands[brandName] || {}
          for (const seriesName of Object.keys(seriesMap)) {
            for (const modelName of seriesMap[seriesName] || []) {
              const key = catName + '|' + modelName
              if (!index.has(key)) index.set(key, seriesName)
            }
          }
        }
      }
    } catch (err) {
      /* 目录缺失时不做系列兜底，匹配退回型号比对 */
    }
    catalogSeriesIndex = index
  }
  return catalogSeriesIndex.get(c + '|' + m) || ''
}

/**
 * 商机提示力度：把「品牌 / 型号 / 数量 / 容量 / 价格 / 城市 / 成色 / 税费 / 供给」做成可调档位，
 * 用户可以在商机页设置自己接单的口径，避免过松（一堆不相关）或过严（漏掉能做的单）。
 *
 * 预设三档（用户可在此基础上单独微调任一维度）：
 * - 宽松 loose   ：同系列即可，数量 / 容量 / 价格 / 城市 / 成色 / 税费 / 供给都不限
 * - 标准 standard：同核心型号、数量达到起订量、容量相同、成色一致（默认，价格与地区不限）
 * - 严格 strict  ：指定品牌、型号完全一致、库存量覆盖需求量、报价在预算内、
 *                  只接同城、成色一致、税费口径有交集、现货只配现货
 *
 * 维度取值：
 * - brand : any 不限品牌 / same 只接指定品牌
 * - model : series 同系列 / core 同核心型号 / same 同型号（不限品牌）/ exact 型号完全一致
 *           「同型号」先按核心型号 + 容量比对，再补一层归一化文本的包含判断，
 *           允许一方多带品牌前缀或「整机 / 8 卡」等后缀；同时忽略品牌维度，
 *           适合「只要这个型号，哪家整机都行」的场景
 * - qty   : any 数量不限 / meet 达到起订量 / exceed 库存量需覆盖需求量
 * - cap   : any 容量不限 / same 容量相同 / fit 容量不低于需求（可接受容量更大的货）
 * - price : any 不限价格 / fit 报价不高于对方预算 / near 报价可上浮 10% 以内
 * - city  : any 不限地区 / same 只接同城 / pick 只接所选城市（可多选，不局限在本城市）
 * - cond  : any 不限成色 / same 成色族一致（全新只配全新，二手可配二手 / 拆机 / 翻新）
 * - tax   : any 不限税费 / same 税费口径至少一项相同（含税 / 专票等）
 * - supply: any 不限现货期货 / same 现货只配现货、期货只配期货
 */
const BIZ_PREF_PRESETS = Object.freeze({
  loose: Object.freeze({
    level: 'loose', brand: 'any', model: 'series', qty: 'any', cap: 'any',
    price: 'any', city: 'any', cond: 'any', tax: 'any', supply: 'any'
  }),
  standard: Object.freeze({
    level: 'standard', brand: 'any', model: 'core', qty: 'meet', cap: 'same',
    price: 'any', city: 'any', cond: 'same', tax: 'any', supply: 'any'
  }),
  strict: Object.freeze({
    level: 'strict', brand: 'same', model: 'exact', qty: 'exceed', cap: 'same',
    price: 'fit', city: 'same', cond: 'same', tax: 'same', supply: 'same'
  })
})
const BIZ_PREF_DEFAULT = BIZ_PREF_PRESETS.standard
const BIZ_PREF_ENUMS = Object.freeze({
  brand: ['any', 'same'],
  model: ['series', 'core', 'same', 'exact'],
  qty: ['any', 'meet', 'exceed'],
  cap: ['any', 'same', 'fit'],
  price: ['any', 'fit', 'near'],
  city: ['any', 'same', 'pick'],
  cond: ['any', 'same'],
  tax: ['any', 'same'],
  supply: ['any', 'same']
})
const BIZ_PREF_KEYS = Object.freeze(Object.keys(BIZ_PREF_ENUMS))
/* 展示时间：只看最近几天发布的商机；手动设置支持 1-90 天 */
const BIZ_PREF_DAYS = Object.freeze([3, 7, 30])
const BIZ_PREF_DAYS_DEFAULT = 30
/* 排序方式：最新发布 / 匹配度（我的库存可出数量多的在前）/ 商机数量（对方需求数量大的在前） */
const BIZ_PREF_SORTS = Object.freeze(['latest', 'match', 'qty'])

/* 指定城市最多选多少个：够覆盖常用业务城市，又不至于把设置面板塞满 */
const BIZ_PREF_CITIES_MAX = 20

function bizPrefPick(value, options, fallback) {
  const v = String(value == null ? '' : value).trim()
  return options.indexOf(v) >= 0 ? v : fallback
}

function bizPrefSame(a, b) {
  return BIZ_PREF_KEYS.every((key) => a[key] === b[key])
}

/** 归一化提示力度：命中预设直接返回预设，否则按维度裁剪成自定义档（缺省回落到标准） */
function normalizeBizPrefs(input) {
  const src = input && typeof input === 'object' ? input : null
  const level = String((src && src.level) == null ? '' : src.level).trim()
  let out
  if (!src) out = Object.assign({}, BIZ_PREF_DEFAULT)
  else if (level && BIZ_PREF_PRESETS[level]) out = Object.assign({}, BIZ_PREF_PRESETS[level])
  else {
    out = { level: 'custom' }
    BIZ_PREF_KEYS.forEach((key) => {
      out[key] = bizPrefPick(src[key], BIZ_PREF_ENUMS[key], BIZ_PREF_DEFAULT[key])
    })
    for (const key of Object.keys(BIZ_PREF_PRESETS)) {
      const preset = BIZ_PREF_PRESETS[key]
      if (bizPrefSame(out, preset)) {
        out = Object.assign({}, preset)
        break
      }
    }
  }
  /* 指定城市：与档位解耦保存，切回「只接同城 / 不限地区」后已选城市仍保留，
     下次切回「指定城市」不用重新勾选；未选城市时按不限地区处理 */
  out.cities = bizCitiesOf(src && src.cities)
  /* 时间范围与排序独立于提示档位：切档位不会把用户选的时间 / 排序重置 */
  const days = Math.floor(Number(src && src.days))
  out.days = BIZ_PREF_DAYS.indexOf(days) >= 0 ? days : (days >= 1 && days <= 90 ? days : BIZ_PREF_DAYS_DEFAULT)
  out.sort = bizPrefPick(src && src.sort, BIZ_PREF_SORTS, 'latest')
  /* 只看公开主体：独立开关，与档位 / 城市 / 时间解耦，默认关闭 */
  out.onlyOpenSubject = !!(src && src.onlyOpenSubject)
  return out
}

/** 城市归一：忽略「市」与空格，深圳 / 深圳市 视为同城；任一方未填视为不限制 */
function cityCoreOf(value) {
  return String(value == null ? '' : value).trim().replace(/市$/, '').replace(/\s+/g, '')
}

/** 指定城市列表归一：兼容数组与逗号分隔文本，去「市」、去重、限量 */
function bizCitiesOf(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，、/|\s]+/) : [])
  const out = []
  raw.forEach((item) => {
    const city = cityCoreOf(item).slice(0, 20)
    if (city && out.indexOf(city) < 0 && out.length < BIZ_PREF_CITIES_MAX) out.push(city)
  })
  return out
}

/** 税费口径拆词：「含税 · 可开专票」→ ['含税', '可开专票'] */
function taxTokensOf(value) {
  return String(value == null ? '' : value).split(/[·、,，/|\s]+/).filter(Boolean)
}

/** 价格档位：any 不限 / fit 报价不高于预算 / near 报价可上浮 10%；任一方没写价格都放行 */
function bizPriceAllowed(level, needPrice, needPriceMax, stockPrice) {
  if (level === 'any') return true
  const base = Number(needPrice) || 0
  const top = Number(needPriceMax) || 0
  const mine = Number(stockPrice) || 0
  if (!(base > 0) || !(mine > 0)) return true
  const cap = top > base ? top : base
  return level === 'near' ? mine <= cap * 1.1 : mine <= cap
}

/** 容量数值（GB）：支持 80G / 4T，用于提示力度里的容量档位比较 */
function capacityGbOf(value) {
  const text = String(value == null ? '' : value).toLowerCase()
  const m = text.match(/(\d+(?:\.\d+)?)\s*(tb|t|gb|g)(?![a-z0-9])/)
  if (!m) return 0
  const num = Number(m[1])
  if (!(num > 0)) return 0
  return m[2] === 't' || m[2] === 'tb' ? Math.round(num * 1024) : Math.round(num)
}

/** 容量档位：any 不限 / fit 不低于需求量 / same 必须相同 */
function bizCapAllowed(level, needGb, stockGb) {
  if (level === 'any' || !needGb || !stockGb) return true
  if (level === 'fit') return stockGb >= needGb
  return stockGb === needGb
}

/**
 * 库存匹配：按「设备类型 + 核心型号 + 新二手 + 起订量」筛选，再按提示力度叠加
 * 价格 / 城市 / 成色 / 税费 / 现货期货等档位。
 *
 * 1. 设备类型是硬条件：需求写明了设备类型，就不跨类型匹配
 *    （B300 整机不会被 B300 内存条或其它品类命中）；
 * 2. 型号按核心型号比对：B300 只要核心是 B300，超微 / 戴尔 / 超聚变 / NVIDIA 都可以，
 *    客户不需要知道具体型号；双方都写了显存容量且不同才算不同规格；
 * 3. 型号文本对不上但系列相同时（如「B300 系列」下不同写法）视为同族，容量冲突时仍然排除；
 * 4. 新二手：需求填了成色才比对，全新只配全新，二手可配二手 / 拆机件 / 翻新；
 * 5. 起订量：库存可用量要达到起订量，且对方需求量不能小于起订量，否则这单做不成；
 * 6. 提示力度额外档位：价格（预算内 / 可上浮 10%）、城市（同城）、税费（口径有交集）、
 *    现货期货（一致）；任一方没写该字段时都按「不限制」放行，避免资料不全漏掉商机。
 * 没有对应库存、库存低于起订量、或需求量小于起订量时直接不命中，
 * 不会给商家推送自己无法满足的商机，也不会给买家看到自己起订量接不下的货源。
 *
 * brand       : 保留参数位，品牌默认不限（客户要 B300 时不限定厂商）
 * opts.qty    : 对方需要的数量（用于起订量校验与展示文案）
 * opts.price  : 对方预算单价（价格档位用，未填视为不限）
 * opts.priceMax: 对方预算上限（填了区间时取上限）
 * opts.cond   : 对方要求的成色（全新 / 二手，「不限」视为未填）
 * opts.city   : 对方所在城市（同城档用）
 * opts.tax    : 对方税费口径（含税 / 专票等，用于税费交集判断）
 * opts.supply : 对方供给类型（现货 / 期货）
 * opts.series : 对方选择的系列（可选，用于同族兜底）
 */
function stockMatch(stocks, cat, model, brand, opts) {
  const need = opts || {}
  const needQty = Number(need.qty) || 0
  const needConds = condFamilies(need.cond)
  const needSeries = String(need.series || '').trim() || catalogSeriesOf(cat, model)
  const needCap = model ? capacityOf(model) : ''
  const needCapGb = model ? capacityGbOf(model) : 0
  const needBrand = String(brand == null ? '' : brand).trim().toLowerCase()
  const needCity = cityCoreOf(need.city)
  const needSupply = String(need.supply == null ? '' : need.supply).trim()
  const needTaxTokens = taxTokensOf(need.tax)
  /* 提示力度：未设置时按「标准」档，保证与历史口径一致 */
  const pref = normalizeBizPrefs(need.pref)
  /* 指定城市：只接所选城市的商机。默认对方城市取 need.city；
     代售 / 反向商机等「对方城市存在库存行」的场景由调用方传 need.pickCity 指定 */
  const pickCities = pref.city === 'pick' ? pref.cities : []
  const otherCity = cityCoreOf(need.pickCity == null ? need.city : need.pickCity)
  const matched = []
  for (const stock of stocks || []) {
    /* 设备类型硬校验：有型号也不能跨品类命中 */
    if (cat && stock.cat && stock.cat !== cat) continue
    /* 品牌档位：只接指定品牌时，双方都写了品牌才比对；
       型号选「同型号（不限品牌）」时品牌不参与，避免被品牌维度误挡 */
    if (pref.model !== 'same' && pref.brand === 'same' && needBrand && stock.brand) {
      if (String(stock.brand).trim().toLowerCase() !== needBrand) continue
    }
    if (model) {
      const stockSeries = String(stock.series || '').trim() || catalogSeriesOf(stock.cat, stock.model)
      const seriesHit = !!(needSeries && stockSeries && needSeries === stockSeries)
      /* 系列兜底只在「一方型号文本无法识别核心型号」时生效：
         双方都能识别核心型号却对不上（如 XE9680 与 XE9680L），属于不同机型，不能被同系列放过 */
      const coreComparable = modelCoreOf(stock.model).length > 0 && modelCoreOf(model).length > 0
      /* 同族兜底不能绕过容量：96G 与 72G 即便同系列也仍是不同规格 */
      const stockCap = capacityOf(stock.model)
      const capOk = !(needCap && stockCap && needCap !== stockCap)
      const stockCapGb = capacityGbOf(stock.model)
      if (pref.model === 'exact') {
        /* 严格档：型号文本必须完全一致（忽略大小写与分隔符） */
        if (normModel(stock.model) !== normModel(model)) continue
      } else if (pref.model === 'same') {
        /* 同型号（不限品牌）：先按核心型号 + 容量比对，再补一层「文本一致 / 互相包含」，
           品牌已在上面跳过，所以「H200 141G SXM」能命中「超微 ... H200 8 卡整机」 */
        if (!modelMatch(stock.model, model) && !modelSameHit(stock.model, model)) continue
      } else if (pref.model === 'series') {
        /* 宽松档：同核心型号或同系列即可，但同系列也不能跨容量（96G ≠ 72G） */
        if (!modelMatch(stock.model, model) && !(seriesHit && capOk)) continue
      } else if (!modelMatch(stock.model, model) && !(seriesHit && capOk && !coreComparable)) {
        continue
      }
      /* 容量档位：同容量 / 不低于 / 不限（4T 需求接受 3T 时把容量调成「不限」） */
      if (!bizCapAllowed(pref.cap, needCapGb, stockCapGb)) continue
    } else if (!cat) {
      /* 设备类型与型号都没填，无法判断是否匹配，直接跳过 */
      continue
    }
    /* 成色档位：只接同成色时，双方都填了才比对；多选成色取交集 */
    if (pref.cond === 'same' && needConds.length && stock.cond) {
      const stockConds = condFamilies(stock.cond)
      if (stockConds.length && !needConds.some((c) => stockConds.indexOf(c) >= 0)) continue
    }
    /* 城市档位：只接同城时，深圳 / 深圳市 视为同城；指定城市时对方城市需在所选列表内；
       任一方没填都放行；选了「指定城市」但一个城市都没选时按不限地区处理 */
    if (pref.city === 'same' && needCity) {
      const stockCity = cityCoreOf(stock.city)
      if (stockCity && stockCity !== needCity) continue
    } else if (pickCities.length && otherCity && pickCities.indexOf(otherCity) < 0) {
      continue
    }
    /* 价格档位：我的报价 vs 对方预算，任一方没写价格都放行 */
    if (!bizPriceAllowed(pref.price, need.price, need.priceMax, stock.price)) continue
    /* 税费档位：双方税费口径至少有一项相同（含税 / 专票等） */
    if (pref.tax === 'same' && needTaxTokens.length) {
      const stockTaxTokens = taxTokensOf(stock.tax)
      if (stockTaxTokens.length && !needTaxTokens.some((t) => stockTaxTokens.indexOf(t) >= 0)) continue
    }
    /* 现货 / 期货档位：双方都写了类型才比对 */
    if (pref.supply === 'same' && needSupply && stock.supply) {
      if (String(stock.supply).trim() !== needSupply) continue
    }
    /* 可用量低于起订量＝这单发不出去，不算有货 */
    if ((Number(stock.qty) || 0) < moqOf(stock)) continue
    /* 对方需求量低于我的起订量＝这单我接不了，任何档位都不算匹配 */
    if (needQty > 0 && moqOf(stock) > needQty) continue
    if (pref.qty === 'exceed') {
      /* 严格档：库存可用量必须覆盖对方需求量 */
      if (needQty > 0 && (Number(stock.qty) || 0) < needQty) continue
    }
    matched.push(stock)
  }
  const qty = matched.reduce((n, stock) => n + (Number(stock.qty) || 0), 0)
  const first = matched[0]
  const text = first ? `${first.brand ? first.brand + ' ' : ''}${first.model || ''}`.trim() : ''
  let textOut = ''
  if (matched.length) {
    const moq = matched.reduce((n, stock) => Math.min(n, moqOf(stock)), moqOf(first))
    textOut = `${text || '库存命中'} · 现有 ${qty} 台` + (moq > 1 ? `，起订 ${moq} 台` : '')
    if (needQty > 0) textOut += `，需求 ${needQty} 台`
  }
  return {
    ok: matched.length > 0,
    hits: matched.length,
    qty,
    model: text,
    text: textOut
  }
}

/** 公开主体集合：仅用于「只看公开主体」筛选与主体展示口径，不再是提醒门槛 */
async function openSubjectSet(repo, ids) {
  const list = Array.from(new Set((ids || []).map((id) => String(id || '')).filter(Boolean)))
  const set = new Set()
  if (!list.length) return set
  const rows = await repo.find('profiles', { uid: { $in: list } }, { limit: list.length })
  for (const row of rows || []) {
    const uid = row.uid || row.id
    if (uid && row.exposure === EXPOSURES.OPEN) set.add(uid)
  }
  return set
}

/**
 * 发布即提醒：新需求 / 新货源进入商机池时，按对方「提示力度」找出匹配方，
 * 给发布者与匹配方各发一条站内信（同一条内容只发一次，重复保存不重复打扰）。
 *
 * 口径：
 * 1. 普通发布（visibility=public）自动进池并提醒，私密发布不进池、不提醒；是否公开主体不再是门槛；
 * 2. 所有匹配用户都收到提醒：会员文案「可在商机页查看」，非会员文案「开通商机会员即可查看」；
 * 3. 需求发布方只在「商机池里有对应商品」时才收到汇总提醒；对方仅有库存、没在商机池
 *    发布对应商品时，只提醒库存方本人，绝不把库存方告知需求方，也不拿库存当商机派给需求方；
 * 4. 接收方开启「只看公开主体」时，发布方主体未公开则不打扰该接收方；
 * 5. 商机被领取时不发提醒，只有对方主动发起对话才会产生聊天消息；
 * 6. 站内信 id 由「场景 + 内容 id + 收件人」确定，重复发布 / 领取不会重复打扰。
 */
async function notifyNewBizMatch(repo, subscribe, options) {
  const opts = options || {}
  const doc = opts.doc
  const kind = opts.kind === 'product' ? 'product' : 'demand'
  const at = Number(opts.at) || Date.now()
  const publisher = String((doc && doc.ownerId) || '')
  if (!repo || !doc || !doc.id || !publisher) return { matched: 0, notified: 0 }
  /* 私密发布不进匹配池，也不发任何提醒 */
  if (doc.visibility === VISIBILITIES.PRIVATE) return { matched: 0, notified: 0 }

  const openPublishers = await openSubjectSet(repo, [publisher])
  const publisherOpen = openPublishers.has(publisher)
  const publisherAccess = accessView(await repo.get('bizAccess', publisher), at)
  const publisherPref = normalizeBizPrefs(await repo.get('bizPrefs', publisher))

  const title = String(doc.title || doc.model || '商机')
  /* 新需求：匹配「商机池里的在售商品」+「本人库存」；新货源：匹配商机池里的求购需求。
     库存行打标 __bizSource=stock：只用于提醒库存方本人，不参与需求发布方的汇总。 */
  let rows = []
  if (kind === 'demand') {
    const products = await scanForMatch(repo, 'products', {
      status: '在售',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, max: 1000 })
    const stocks = await scanForMatch(repo, 'stocks', { status: '在售', deleted: { $ne: true } }, { max: 1000 })
    rows = products.map((row) => Object.assign({}, row, { __bizSource: 'product' }))
      .concat(stocks.map((row) => Object.assign({}, row, { __bizSource: 'stock' })))
  } else {
    rows = await scanForMatch(repo, 'demands', {
      status: '求购中',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, max: 1000 })
  }

  const candidates = (rows || []).filter((row) => row.ownerId && row.ownerId !== publisher)
  if (!candidates.length) return { matched: 0, notified: 0 }
  const openOwners = await openSubjectSet(repo, candidates.map((row) => row.ownerId))
  /* 停用账号不再接收任何商机提醒 */
  const ownerIds = Array.from(new Set(candidates.map((row) => row.ownerId)))
  const disabledOwners = new Set((await repo.find('users', {
    id: { $in: ownerIds },
    status: '停用'
  }, { limit: ownerIds.length })).map((row) => row.id))
  /* 拉黑：接收方拉黑过发布方时，不再推送对方的新发布（内容本身也已不可见） */
  const blockedRecipients = new Set((await repo.find('userBlocks', {
    peerUid: publisher
  }, { limit: 500 })).map((row) => row.uid))

  /* 按对方主体聚合：一个会员有多条库存 / 需求也只提醒一次 */
  const byOwner = new Map()
  for (const row of candidates) {
    if (!byOwner.has(row.ownerId)) byOwner.set(row.ownerId, [])
    byOwner.get(row.ownerId).push(row)
  }

  let matchedOwners = 0
  /* 仅统计「商机池商品」命中的会员：需求发布方的汇总提醒只认这一种来源 */
  let matchedProductOwners = 0
  /* 公开主体口径的计数：发布方开启「只看公开主体」时用于汇总 */
  let matchedOpenOwners = 0
  let matchedOpenProductOwners = 0
  let notified = 0
  for (const [ownerId, ownerRows] of byOwner) {
    if (disabledOwners.has(ownerId) || blockedRecipients.has(ownerId)) continue
    /* 会员 / 非会员都提醒：会员可直接查看，非会员文案引导开通 */
    const ownerAccess = accessView(await repo.get('bizAccess', ownerId), at)
    const prefRow = await repo.get('bizPrefs', ownerId)
    const pref = normalizeBizPrefs(prefRow)
    let hit = false
    let hitProduct = false
    if (kind === 'demand') {
      for (const row of ownerRows) {
        const rowHit = stockMatch([row], doc.cat, doc.model, doc.brand, {
          qty: doc.qty, price: doc.budget, priceMax: doc.budgetMax,
          cond: doc.cond, city: doc.city, tax: doc.tax, supply: doc.supply,
          series: doc.series, pref
        }).ok
        if (!rowHit) continue
        hit = true
        if (row.__bizSource === 'product') {
          hitProduct = true
          break
        }
      }
    } else {
      for (const demandRow of ownerRows) {
        const rowHit = stockMatch([doc], demandRow.cat, demandRow.model, demandRow.brand, {
          qty: demandRow.qty, price: demandRow.budget, priceMax: demandRow.budgetMax,
          cond: demandRow.cond, city: demandRow.city, tax: demandRow.tax, supply: demandRow.supply,
          series: demandRow.series, pref
        }).ok
        if (rowHit) { hit = true; break }
      }
    }
    if (!hit) continue
    matchedOwners += 1
    if (hitProduct) matchedProductOwners += 1
    const ownerIsOpen = openOwners.has(ownerId)
    if (ownerIsOpen) {
      matchedOpenOwners += 1
      if (hitProduct) matchedOpenProductOwners += 1
    }
    /* 提醒跟随接收方筛选：只看公开主体时，发布方未公开就不打扰 */
    if (pref.onlyOpenSubject && !publisherOpen) continue
    /* 命中来源决定文案：商机池商品写「发布的货源」，本人库存才写「库存」 */
    const sourceText = hitProduct ? '与你发布的货源匹配' : '与你的库存匹配'
    const body = kind === 'demand'
      ? `「${title}」${sourceText}，${ownerAccess.unlocked ? '可在商机页查看' : '开通商机会员即可查看'}`
      : `「${title}」与你的求购需求匹配，${ownerAccess.unlocked ? '可在商机页查看' : '开通商机会员即可查看'}`
    const sent = await pushBizPublishNotice(repo, subscribe, {
      uid: ownerId,
      key: `${kind}:${doc.id}`,
      title: ownerAccess.unlocked ? '有新的商机可查看' : '有新的商机匹配，开通会员查看',
      body,
      /* 订阅消息模板字段上限 20 字：单独给短文案，避免长正文被硬截成半句 */
      subscribeBody: kind === 'demand'
        ? (ownerAccess.unlocked ? '有货源与你匹配，可在商机页查看' : '有货源匹配，开通会员查看')
        : (ownerAccess.unlocked ? '有求购与你匹配，可在商机页查看' : '有求购匹配，开通会员查看'),
      targetId: doc.id,
      at
    })
    if (sent) notified += 1
  }

  /* 发布者汇总：按发布方自己的「只看公开主体」口径统计；
     非会员也发，文案引导开通；新需求只统计商机池商品匹配，库存不打扰需求方 */
  const publisherMatches = kind === 'demand'
    ? (publisherPref.onlyOpenSubject ? matchedOpenProductOwners : matchedProductOwners)
    : (publisherPref.onlyOpenSubject ? matchedOpenOwners : matchedOwners)
  if (publisherMatches > 0) {
    const verb = kind === 'demand' ? '家货源' : '位买家'
    const summary = publisherAccess.unlocked
      ? `已有 ${publisherMatches} ${verb}与「${title}」匹配，可在商机页查看`
      : `已有 ${publisherMatches} ${verb}与「${title}」匹配，开通商机会员即可查看`
    await pushBizPublishNotice(repo, subscribe, {
      uid: publisher,
      key: `publisher:${kind}:${doc.id}`,
      title: publisherAccess.unlocked ? '有新的商机匹配' : '有新的商机匹配，开通会员查看',
      body: summary,
      targetId: doc.id,
      at
    })
  }
  return { matched: matchedOwners, notified, productMatched: matchedProductOwners }
}

/**
 * 发布回执：统计刚落库的内容当前能匹配上多少条对方内容。
 * 口径与「发布即提醒」一致：私密发布不进池、不计；只算在售货源 / 求购中需求，且排除本人。
 * 用于发布成功后立刻告诉用户「已有 N 条求购与你匹配」，让「上传一次就够了」可被感知。
 */
async function countBizMatches(repo, options) {
  const opts = options || {}
  const doc = opts.doc
  const kind = opts.kind === 'product' ? 'product' : 'demand'
  if (!repo || !doc || !doc.id) return 0
  if (doc.visibility === VISIBILITIES.PRIVATE) return 0
  const publisher = String(doc.ownerId || '')
  const pref = normalizeBizPrefs(await repo.get('bizPrefs', publisher))
  let rows = []
  if (kind === 'product') {
    const demands = await scanForMatch(repo, 'demands', {
      status: '求购中',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, max: 1000 })
    rows = demands
  } else {
    const products = await scanForMatch(repo, 'products', {
      status: '在售',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, max: 1000 })
    const stocks = await scanForMatch(repo, 'stocks', { status: '在售', deleted: { $ne: true } }, { max: 1000 })
    rows = products.concat(stocks)
  }
  let count = 0
  for (const row of rows) {
    if (!row.ownerId || row.ownerId === publisher) continue
    /* 方向与「发布即提醒」一致：发布方永远是库存行（stock），对方内容才是需求行（need），
       否则起订量 / 数量会反过来算，回执会虚高 */
    const hit = kind === 'product'
      ? stockMatch([doc], row.cat, row.model, row.brand, {
        qty: row.qty,
        price: row.budget,
        priceMax: row.budgetMax,
        cond: row.cond,
        city: row.city,
        tax: row.tax,
        supply: row.supply,
        series: row.series,
        pref
      }).ok
      : stockMatch([row], doc.cat, doc.model, doc.brand, {
        qty: doc.qty,
        price: doc.budget,
        priceMax: doc.budgetMax,
        cond: doc.cond,
        city: doc.city,
        tax: doc.tax,
        supply: doc.supply,
        series: doc.series,
        pref
      }).ok
    if (hit) count += 1
  }
  return count
}

/**
 * 分页扫全量在架内容：发布提醒只取最新 200 条，会让更早发布的老货源 / 老需求
 * 永久匹配不到新商机；这里按页拉取，在上限内全部参与匹配。
 */
async function scanForMatch(repo, collection, query, opts) {
  const o = opts || {}
  const PAGE = 200
  const MAX = Math.min(2000, Math.max(PAGE, Number(o.max) || 1000))
  const out = []
  for (let skip = 0; skip < MAX; skip += PAGE) {
    const rows = await repo.find(collection, query, { sort: o.sort, limit: PAGE, skip })
    if (!rows || !rows.length) break
    for (const row of rows) out.push(row)
    if (rows.length < PAGE) break
  }
  return out.slice(0, MAX)
}

/** 商机提醒幂等写入：同一条内容对同一个人只发一次站内信 + 一次微信订阅提醒 */
async function pushBizPublishNotice(repo, subscribe, options) {
  const opts = options || {}
  const uid = String(opts.uid || '')
  if (!uid) return false
  const id = 'M' + sha256Hex(`biz-new|${opts.key || ''}|${uid}`).slice(0, 24)
  const existed = await repo.get('outbox', id)
  if (existed) return false
  try {
    await repo.insert('outbox', {
      id,
      type: 'system.notice',
      payload: {
        uid,
        channel: 'system',
        from: 'system',
        title: opts.title || '有新的商机可查看',
        body: opts.body || '',
        reason: '',
        targetType: 'biz',
        targetId: String(opts.targetId || '')
      },
      status: 'pending',
      createdAt: Number(opts.at) || Date.now()
    })
  } catch (err) {
    /* 并发下唯一 id 冲突视为已提醒过，不重复打扰 */
    if (err && err.code === CODES.CONFLICT) return false
    throw err
  }
  if (subscribe && typeof subscribe.biz === 'function') {
    try {
      await subscribe.biz(uid, {
        title: opts.title || '有新的商机可查看',
        body: opts.body || '',
        /* 带上内容 id：点订阅消息直接定位到这条商机，而不是只落到商机首页 */
        page: opts.targetId ? 'pages/biz/biz?id=' + encodeURIComponent(String(opts.targetId)) : 'pages/biz/biz',
        at: Number(opts.at) || Date.now()
      })
    } catch (err) {
      /* 订阅消息失败不影响站内信 */
    }
  }
  return true
}

/** 联系方式不再拦截：用户可直接在委托信息、资讯、材料名称里留电话 / 微信号 */
function assertNoContactInText() {}

/** 媒体只保留文件名与类型：原件通过企业微信核验，接口不接收客户端路径 */
function normalizeMedia(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new AppError(CODES.VALIDATION, '材料格式不正确')
  if (list.length > 5) throw new AppError(CODES.VALIDATION, '最多上传 5 份材料')
  return list.map((item) => {
    const src = item && typeof item === 'object' ? item : {}
    const name = str(src.name, { field: '材料名称', required: true, max: 60 })
    assertNoContactInText(name, '材料名称')
    const ref = fileRef(src.fileId)
    const out = {
      name: name.split(/[\\/]/).pop(),
      kind: enumOf(src.kind || 'other', ['license', 'proof', 'loi', 'authorization', 'idcard', 'other'], '材料类型')
    }
    /* 上传接口返回的地址，管理端据此直接展示原件；缺失时降级为仅文件名 */
    if (ref) out.fileId = ref
    return out
  })
}

/* ============================================================
   委托单：入参校验与投影
   ============================================================ */

function normalizeAgencyInput(data, profileExposure) {
  const side = enumOf(data.side, ['buy', 'sell'], '委托类型')
  const allowedModes = side === 'buy' ? [TRADE_MODES.BUY, TRADE_MODES.LEASE] : [TRADE_MODES.SELL, TRADE_MODES.RENT]
  const mode = enumOf(data.mode, allowedModes, '交易方式')
  const rental = mode === TRADE_MODES.RENT || mode === TRADE_MODES.LEASE
  const term = rental ? enumOf(data.term, RENT_TERMS, '租期') : ''

  const item = str(data.item, { field: '设备型号', required: true, min: 2, max: 100 })
  /* 品类由选填字段提供；缺省时留空，匹配与聚合按「未知品类」处理，
     不能用机型文本硬猜品类，否则现货盘会把同类委托拆成不同分组 */
  const cat = str(data.cat, { field: '设备品类', max: 20 })
  const city = str(data.city, { field: '所在城市', max: 20 })
  assertNoContactInText(cat, '设备品类')
  const qty = intOf(data.qty, '数量', 1, 100000)
  const price = intOf(data.price, '单价', 1, 999999999)
  const amount = round2(qty * price)
  const fee = agencyFee(amount, rental, side)
  const largeAmount = fee.largeAmount === true
  const deferredFee = fee.deferredFee === true
  /* 代采 / 代售直接对接到平台：不提供可见范围与发布渠道选择，统一按平台口径落库。
     1000 万元及以上代采强制保密（仅本人与平台可见）；其余公开给平台匹配，
     但主体信息、联系方式与证明材料始终不对任何公司展示。 */
  const forcedPrivate = side === 'buy' && largeAmount
  const visibility = forcedPrivate ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC
  const exposure = forcedPrivate
    ? EXPOSURES.HIDDEN
    : enumOf(profileExposure || EXPOSURES.HIDDEN, Object.values(EXPOSURES), '主体公开范围')
  /* 币种：默认人民币 */
  const currencyCodes = CURRENCIES.map((c) => c.code)
  const currency = enumOf(data.currency || DEFAULT_CURRENCY, currencyCodes, '币种')
  const cur = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0]

  const detail = str(data.detail, { field: '补充说明', max: 500 })
  assertNoContactInText(detail, '补充说明')

  /* 交易流程 / 必要条件 / 可协商条件：均非必填，用户发起委托时填，平台审核时参考 */
  const flow = arrayOfStrings(data.flow, { field: '交易流程', max: 10, itemMax: 120 })
  const must = arrayOfStrings(data.must, { field: '必要条件', max: 10, itemMax: 120 })
  const nego = arrayOfStrings(data.nego, { field: '可协商条件', max: 10, itemMax: 120 })
  flow.forEach((t) => assertNoContactInText(t, '交易流程'))
  must.forEach((t) => assertNoContactInText(t, '必要条件'))
  nego.forEach((t) => assertNoContactInText(t, '可协商条件'))

  const subjectType = enumOf(data.subjectType, ['company', 'person'], '主体类型')
  const subject = str(data.subject, { field: '企业名称 / 姓名', required: true, min: 2, max: 60 })
  assertNoContactInText(subject, '企业名称 / 姓名')

  const phone = normalizeContactPhone(data.phone)
  const legal = str(data.legal, { field: '联系人', max: 20 })
  const creditCode = str(data.creditCode, { field: '统一社会信用代码', max: 18 }).toUpperCase()
  const idCard = str(data.idCard, { field: '身份证号', max: 18 }).toUpperCase()

  if (subjectType === 'company') {
    if (!/^[0-9A-Z]{18}$/.test(creditCode)) throw new AppError(CODES.VALIDATION, '请填写 18 位统一社会信用代码')
    if (!legal) throw new AppError(CODES.VALIDATION, '请填写企业联系人')
    assertNoContactInText(legal, '企业联系人')
  } else {
    if (!/^\d{17}[\dX]$/.test(idCard)) throw new AppError(CODES.VALIDATION, '请填写 18 位身份证号')
  }

  const media = normalizeMedia(data.media)

  /* 验资（代采）/ 物权证明（代售）与联系人身份证一律必传；企业再加营业执照；
     委托授权书作为补充材料选填；1000 万元及以上代采补采购意向函 */
  const required = [
    { kind: 'proof', label: side === 'buy' ? '验资证明' : '物权证明' },
    { kind: 'idcard', label: '联系人身份证' }
  ].concat(subjectType === 'company' ? [{ kind: 'license', label: '营业执照' }] : [])
  if (largeAmount && side === 'buy') required.push({ kind: 'loi', label: '采购意向函' })
  const got = new Set(media.map((m) => m.kind))
  const missing = required.filter((m) => !got.has(m.kind)).map((m) => m.label)
  if (missing.length) {
    throw new AppError(CODES.VALIDATION, `请补齐必传材料：${missing.join('、')}`)
  }
  /* 委托授权书选填：授权书上的联系人信息由客服审核时核验，
     联系人手机号已在主体信息中填写，不再单独要求授权书电话 */
  const authPhoneRaw = str(data.authPhone, { field: '委托授权书上的联系人电话', max: 32 })
  const authPhone = authPhoneRaw ? normalizeContactPhone(authPhoneRaw) : ''
  const authPhoneMatched = !!authPhone && authPhone === phone

  /* 发布渠道同样不开放选择：公开委托由平台同时用于普通展示与商机匹配，
     保密委托只留在平台侧 */
  const channel = visibility === VISIBILITIES.PUBLIC ? PUBLISH_CHANNELS.BOTH : PUBLISH_CHANNELS.NORMAL

  return {
    side,
    kind: side === 'buy' ? '代采' : '代售',
    mode,
    rental,
    term,
    item,
    cat,
    city,
    qty,
    price,
    amount,
    serviceFee: fee.fee,
    upfront: fee.upfront,
    /* 前置款 = 提交时实付：后付费模式下恒为 0 */
    payNow: round2(fee.upfront),
    feeRule: fee.rule,
    feeNote: fee.note,
    largeAmount,
    deferredFee,
    exposure,
    visibility,
    /* 进入商机池：普通发布即进池，私密发布不进池；代采 / 代售由平台代为对接，不要求主体公开 */
    channel,
    bizPool: visibility !== VISIBILITIES.PRIVATE,
    currency,
    currencySymbol: cur.symbol,
    currencyLabel: cur.label,
    detail,
    /* 交易流程 / 必要条件 / 可协商条件：发起委托时可选填，平台审核时参考；均非必填 */
    flow,
    must,
    nego,
    subjectType: subjectType === 'company' ? '企业' : '个人',
    subject,
    phone,
    authPhone,
    authPhoneMatched,
    legal,
    creditCode,
    idCard,
    media
  }
}

function intOf(value, field, min, max) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(CODES.VALIDATION, `${field}需为 ${min} - ${max} 的整数`)
  }
  return n
}

/**
 * 委托进度时间线：提交 → 审核通过 → 已上架 → 平台确认成交 → 服务费到账 → 客服结案。
 * 驳回 / 关闭 / 到期后不再点亮后续步骤，避免用户误以为仍在推进。
 */
function agencyProgress(d) {
  const st = d || {}
  const stopped = st.status === AGENCY_STATUS.CLOSED || st.status === AGENCY_STATUS.REJECTED
  const steps = [
    { key: 'submit', label: '已提交', at: Number(st.createdAt) || 0 },
    { key: 'review', label: '审核通过', at: Number(st.approvedAt) || 0 },
    { key: 'online', label: '已上架', at: Number(st.confirmedAt) || 0 },
    { key: 'locked', label: '锁定对接方', at: Number(st.lockedAt) || 0 },
    { key: 'dealt', label: '平台确认成交', at: Number(st.dealConfirmedAt) || 0 },
    { key: 'paid', label: '服务费到账', at: Number(st.feePaidAt) || 0 },
    { key: 'done', label: '已完成', at: Number(st.completedAt) || Number(st.receiptConfirmedAt) || 0 }
  ]
  let active = false
  return steps.map(function (s) {
    const done = !!s.at
    const isActive = !stopped && !done && !active
    if (isActive) active = true
    return { key: s.key, label: s.label, done: done, active: isActive, atText: s.at ? dateTimeText(s.at) : '' }
  })
}

const AGENCY_STATUS_TEXT = Object.freeze({
  [AGENCY_STATUS.REVIEW]: '待审核',
  [AGENCY_STATUS.PENDING]: '待确认',
  [AGENCY_STATUS.APPROVED]: '已通过',
  [AGENCY_STATUS.ACTIVE]: '已上架',
  [AGENCY_STATUS.LOCKED]: '已锁定',
  [AGENCY_STATUS.DEAL_PENDING]: '待确认成交',
  [AGENCY_STATUS.DEALT]: '已成交',
  [AGENCY_STATUS.DONE]: '已完成',
  [AGENCY_STATUS.CLOSED]: '已关闭',
  [AGENCY_STATUS.REJECTED]: '已驳回'
})

/** 委托流程节点：按时间升序，只展示时间与处理人，不出现「平台发布任务」等内部动作文案 */
function agencyFlowNodes(d) {
  const st = d || {}
  const nodes = []
  const push = (label, at, staff) => {
    const ms = Number(at) || 0
    if (!ms) return
    nodes.push({ at: ms, label, atText: dateTimeText(ms), staffText: String(staff || '') })
  }
  push('已提交', st.createdAt, st.staff)
  push('审核通过', st.approvedAt, st.staff)
  push('已上架', st.confirmedAt, st.staff)
  push('锁定唯一对接方', st.lockedAt, st.lockedBy || st.staff)
  /* 旧数据可能停在「待确认成交」，保留节点仅用于展示历史 */
  if (st.status === AGENCY_STATUS.DEAL_PENDING) push('待确认成交', st.dealProposedAt, st.dealProposedBy)
  push('平台确认成交', st.dealConfirmedAt, st.dealConfirmedBy)
  push('服务费到账', st.feePaidAt, st.feePaidBy)
  push('已完成', st.completedAt || st.receiptConfirmedAt, st.completedBy)
  if (st.status === AGENCY_STATUS.REJECTED) push('已驳回', st.closedAt, st.staff)
  else if (st.status === AGENCY_STATUS.CLOSED) push('已关闭', st.closedAt, st.staff)
  return nodes
    .sort((a, b) => a.at - b.at)
    .map((n) => ({ label: n.label, atText: n.atText, staffText: n.staffText }))
}

/**
 * 旧数据兜底：历史「1000 万元及以上代采免服务费」的委托，serviceFee 记为 0。
 * 新口径下大额订单一律按金额 0.5% 收取，读取与出账时都按有效服务费计算。
 */
function effectiveServiceFee(d) {
  const doc = d || {}
  const stored = round2(Number(doc.serviceFee) || 0)
  if (stored > 0) return stored
  const amount = Number(doc.amount) || 0
  if (doc.freeLarge === true && amount >= LARGE_AMOUNT_THRESHOLD) return round2(amount * 0.005)
  return 0
}

/** 后付费服务费展示：待支付 / 已到账 / 逾期 / 成交后支付 */
function agencyFeeView(d, now) {
  const st = d || {}
  const fee = effectiveServiceFee(st)
  const feeStatus = st.feeStatus || 'unbilled'
  const dueAt = Number(st.feeDueAt) || 0
  const overdue = feeStatus === 'pending' && dueAt > 0 && dueAt < Number(now)
  let text = ''
  if (feeStatus === 'paid') text = '已到账'
  else if (fee <= 0) text = '服务费以成交账单为准'
  else if (overdue) text = `已逾期 · 应于 ${dateText(dueAt)} 前到账`
  else if (feeStatus === 'pending') text = `待支付 · ${dateText(dueAt)} 前到账`
  else text = '成交后支付'
  return {
    feeOverdue: overdue,
    feeStatusText: text,
    feeDueAtText: dueAt ? dateText(dueAt) : ''
  }
}

/** 截止时间 / 合同期文本：历史委托没有 deadline 时退回原 expiresAt */
function agencyDeadlineAt(d) {
  const st = d || {}
  return Number(st.deadlineAt) || Number(st.expiresAt) || 0
}

/** 惰性到期：过了截止时间仍未成交的委托置为已关闭（不影响到已成交 / 已完成） */
async function expireAgencyIfNeeded(repo, doc, at) {
  if (!doc) return doc
  if (AGENCY_EXPIRABLE_STATUSES.indexOf(doc.status) < 0) return doc
  const dueAt = agencyDeadlineAt(doc)
  if (!dueAt || dueAt >= at) return doc
  const patch = {
    status: AGENCY_STATUS.CLOSED,
    reason: AGENCY_CLOSE_REASON_EXPIRED,
    closeReason: AGENCY_CLOSE_REASON_EXPIRED,
    closedAt: at,
    updatedAt: at
  }
  const res = await repo.updateWhere('agencies', {
    id: doc.id,
    status: { $in: AGENCY_EXPIRABLE_STATUSES },
    deleted: { $ne: true }
  }, patch)
  if (res && res.count) {
    await appendAudit(repo, {
      actorType: 'system',
      actorId: 'system',
      action: 'agency.expire',
      target: doc.id,
      reason: AGENCY_CLOSE_REASON_EXPIRED,
      result: 'allow',
      at
    })
    return Object.assign({}, doc, patch)
  }
  return (await repo.get('agencies', doc.id)) || doc
}

/** 列表读前兜底：批量关闭已过截止时间的委托（有上限，避免单次读取放大） */
async function expireAgenciesLazy(repo, at) {
  const rows = await repo.find('agencies', {
    status: { $in: AGENCY_EXPIRABLE_STATUSES },
    expiresAt: { $lt: at },
    deleted: { $ne: true }
  }, { limit: 50 })
  for (const row of rows) {
    if (agencyDeadlineAt(row) && agencyDeadlineAt(row) < at) await expireAgencyIfNeeded(repo, row, at)
  }
}

/**
 * 后付费服务费账单：成交确认后（或用户上报已支付时）生成待确认收款单。
 * 应到账日 = 打款时间 + 3 个工作日（优先取 paidClaimAt，其次 dealConfirmedAt）。
 */
async function ensureAgencyFeeBill(repo, doc, at, paidAt) {
  let d = doc || {}
  if (d.feeStatus === 'paid') return d
  const fee = effectiveServiceFee(d)
  /* 旧数据回写：大额免单的历史委托按新口径补记 0.5% 服务费 */
  if (fee > 0 && round2(Number(d.serviceFee) || 0) !== fee) {
    const patch = {
      serviceFee: fee,
      freeLarge: false,
      deferredFee: true,
      feeRule: '1000 万元及以上：成交后按 0.5% 收取',
      updatedAt: at
    }
    await repo.updateWhere('agencies', { id: d.id }, patch)
    d = Object.assign({}, d, patch)
  }
  /* 已有账单：首次上报打款时间时，把应到账日顺延为「打款日 + 3 个工作日」 */
  if (d.feeStatus === 'pending' && d.feeBillId) {
    const claimAt = Number(paidAt) || 0
    if (!claimAt || Number(d.paidClaimCount) > 1) return d
    const dueAt = addWorkdays(claimAt, 3)
    if (!(dueAt > (Number(d.feeDueAt) || 0))) return d
    await repo.updateWhere('payments', { id: d.feeBillId }, {
      dueAt,
      note: `委托单 ${d.id} · 应于 ${dateText(dueAt)} 前到账`,
      updatedAt: at
    })
    await repo.updateWhere('agencies', { id: d.id }, { feeDueAt: dueAt, updatedAt: at })
    return Object.assign({}, d, { feeDueAt: dueAt })
  }
  if (fee <= 0) {
    if (d.feeStatus !== 'unbilled') {
      await repo.updateWhere('agencies', { id: d.id }, { feeStatus: 'unbilled', updatedAt: at })
    }
    return Object.assign({}, d, { feeStatus: 'unbilled' })
  }
  const payAt = Number(paidAt) || Number(d.paidClaimAt) || Number(d.dealConfirmedAt) || at
  const feeDueAt = addWorkdays(payAt, 3)
  /* 账单号由委托单固定派生：并发确认成交 / 重复点击时，唯一索引保证只生成一张账单；
     退款后重新收款时原账单保留为退款记录，按 _2 / _3 顺延重开，避免沿用已退款账单 */
  let billId = `PY_AG_${d.id}`
  const bizType = d.rental ? '租赁服务费' : (d.side === 'buy' ? '代采服务费' : '代售服务费')
  let bill = await repo.get('payments', billId)
  let billSeq = 1
  while (bill && bill.status === PAYMENT_STATUS.REFUNDED) {
    billSeq += 1
    billId = `PY_AG_${d.id}_${billSeq}`
    bill = await repo.get('payments', billId)
  }
  if (!bill) {
    try {
      await repo.insert('payments', {
        id: billId,
        uid: d.ownerId,
        nick: d.ownerNick || '',
        bizType,
        planKey: '',
        planLabel: '',
        days: 0,
        amount: fee,
        discount: 0,
        received: fee,
        method: '待支付',
        status: PAYMENT_STATUS.PENDING,
        paidAt: 0,
        confirmedAt: 0,
        confirmedBy: '',
        agencyId: d.id,
        dueAt: feeDueAt,
        note: `委托单 ${d.id} · 应于 ${dateText(feeDueAt)} 前到账`,
        createdAt: at,
        updatedAt: at
      })
    } catch (err) {
      bill = await repo.get('payments', billId)
      if (!bill) throw err
    }
  }
  /* 账单已被财务确认：直接把委托单回写为已到账，避免并发下又退回待支付 */
  if (bill && bill.status === PAYMENT_STATUS.CONFIRMED) {
    const paidPatch = {
      feeStatus: 'paid',
      feePaidAt: Number(bill.confirmedAt) || at,
      feePaidBy: bill.confirmedBy || '',
      feeBillId: billId,
      feeDueAt: Number(bill.dueAt) || feeDueAt,
      updatedAt: at
    }
    await repo.updateWhere('agencies', { id: d.id }, paidPatch)
    return Object.assign({}, d, paidPatch)
  }
  const patch = {
    feeStatus: 'pending',
    feeDueAt: Number(bill && bill.dueAt) || feeDueAt,
    feeBillId: billId,
    feeBilledAt: at,
    updatedAt: at
  }
  await repo.updateWhere('agencies', { id: d.id }, patch)
  return Object.assign({}, d, patch)
}

/**
 * 平台确认成交（代采 / 代售统一入口）。
 *
 * 由客服在工单「登记成交」或管理员在委托管理「确认成交」触发：平台直接确认，
 * 委托方只接收成交通知，不再需要在小程序里二次确认。确认后按成交金额重算服务费、
 * 生成后付费账单，并把工单推进到「服务费待支付」。
 */
async function confirmAgencyDeal(repo, options) {
  const o = options || {}
  const id = String(o.agencyId || '')
  if (!id) throw new AppError(CODES.VALIDATION, '缺少委托标识')
  const at = Number(o.at) || Date.now()
  const operator = String(o.staff || '平台')
  const doc = await repo.get('agencies', id)
  if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
  if (doc.status === AGENCY_STATUS.DONE) throw new AppError(CODES.CONFLICT, '委托已完成，不能重复确认成交')
  if (doc.status === AGENCY_STATUS.CLOSED) throw new AppError(CODES.CONFLICT, '委托已关闭，不能确认成交')
  const dealAmount = round2(Number(o.amount) || Number(doc.dealAmount) || 0)
  if (!(dealAmount > 0)) throw new AppError(CODES.VALIDATION, '请先填写成交金额')
  /* 成交只能由工单流程进入：委托必须已锁定唯一对接方（合同归档后）。
     待确认成交（DEAL_PENDING）仅用于兼容升级前停在旧阶段的历史数据。 */
  const allowed = [AGENCY_STATUS.LOCKED, AGENCY_STATUS.DEAL_PENDING, AGENCY_STATUS.DEALT]
  if (allowed.indexOf(doc.status) < 0) {
    throw new AppError(CODES.CONFLICT, `委托当前为「${AGENCY_STATUS_TEXT[doc.status] || doc.status}」，不能确认成交`)
  }
  /* 已成交时只允许修正成交金额，不重复写确认时间 */
  if (doc.status !== AGENCY_STATUS.DEALT) {
    const res = await repo.updateWhere('agencies', { id, status: doc.status }, {
      status: AGENCY_STATUS.DEALT,
      dealt: true,
      dealtAt: Number(doc.dealtAt) || at,
      dealAmount,
      dealProposedAt: at,
      dealProposedBy: operator,
      dealConfirmedAt: at,
      dealConfirmedBy: operator,
      dealCsId: String(o.staffId || doc.dealCsId || ''),
      reason: '',
      updatedAt: at
    })
    if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
  }
  await appendAudit(repo, {
    actorType: o.actorType || 'staff',
    actorId: String(o.staffId || ''),
    action: 'agency.dealConfirm',
    target: id,
    reason: `平台确认成交：¥${dealAmount}`,
    result: 'allow',
    at
  })
  let fresh = await repo.get('agencies', id)
  /* 服务费按「成交金额」计提：议价成交后重算，避免一直沿用挂牌金额算出的费用 */
  const feeInfo = agencyFee(dealAmount, !!fresh.rental, fresh.side)
  const nextFee = round2(feeInfo.fee)
  if (nextFee !== round2(Number(fresh.serviceFee) || 0) || Number(fresh.dealAmount) !== dealAmount) {
    const patch = {
      dealAmount,
      serviceFee: nextFee,
      feeRule: feeInfo.rule,
      deferredFee: true,
      freeLarge: false,
      updatedAt: at
    }
    await repo.updateWhere('agencies', { id }, patch)
    fresh = Object.assign({}, fresh, patch)
  }
  fresh = await ensureAgencyFeeBill(repo, fresh, at)
  if (Number(fresh.feeDueAt) > 0) {
    /* 模块级函数无法复用工厂内的 sendUserNotice，这里直接落站内信 */
    await repo.insert('outbox', {
      id: randomId('M'),
      type: 'system.notice',
      payload: {
        uid: fresh.ownerId,
        channel: 'system',
        from: 'system',
        reason: '',
        targetType: 'agency',
        targetId: fresh.id,
        title: `${fresh.kind || '委托'}已成交`,
        body: `平台已确认成交，成交金额 ¥${dealAmount}，服务费 ¥${Number(fresh.serviceFee || 0)} 应于 ${dateText(fresh.feeDueAt)} 前到账，可在「我的缴费」查看。`
      },
      status: 'pending',
      createdAt: at
    })
  }
  /* 工单同步进入「服务费待支付」：工单可能还停在沟通中 / 条件已确认 / 合同待审核，
     一次跳到 fee 会被阶段白名单拒绝并永久卡住，这里按主流程逐级补齐 */
  const dealLead = await consultLeadOfAgency(repo, id)
  const stepOpts = {
    at,
    by: operator,
    actorType: o.actorType || 'staff',
    note: `平台确认成交，成交金额 ¥${dealAmount}`,
    extra: { dealAmount }
  }
  await advanceConsultStageTo(repo, id, CONSULT_STAGE.FEE, stepOpts)
  /* 同一委托只保留成交这一家：其余对接工单、待审核合同与领取记录一并收口 */
  if (dealLead && dealLead.id) {
    await closeOtherAgencyLeads(repo, {
      agencyId: id,
      keepLeadId: dealLead.id,
      at,
      by: operator,
      note: '委托已成交，本次对接结束'
    })
  }
  if (round2(Number(fresh.serviceFee) || 0) <= 0) {
    await advanceConsultStageQuiet(repo, id, CONSULT_STAGE.FEE, CONSULT_STAGE.PAID, {
      at,
      by: operator,
      actorType: o.actorType || 'staff',
      note: '本单免收服务费，直接进入已到账',
      extra: { feePaidAt: at }
    })
  }
  return fresh
}

const AGENCY_LOCKED_CLOSE_NOTE = '委托已确定唯一对接方，本次对接结束'

/**
 * 通知其它对接方「商品已售出」：同一委托只保留一家后，其余用户的工单自动结束，
 * 会话里补一条系统消息，避免用户继续等待。消息 id 由工单号派生，重复锁定只落一条。
 */
async function notifyAgencySold(repo, row, at) {
  const leadId = String((row && row.id) || '')
  if (!leadId) return
  const title = String(row.agencyTitle || '该委托')
  const doc = {
    id: 'M' + sha256Hex(`cs-sold:${leadId}`).slice(0, 22),
    type: 'kf.chat',
    payload: {
      uid: row.uid || '',
      channel: 'kf',
      from: 'system',
      staffName: '',
      threadId: row.threadId || leadId,
      targetType: 'agency',
      targetId: row.agencyId || row.targetId || '',
      title,
      body: `您对接的「${title}」已售出，平台已确定唯一对接方，本次对接结束。`
    },
    status: 'pending',
    createdAt: at
  }
  try {
    await repo.insert('outbox', doc)
  } catch (err) {
    /* 重复锁定只保留一条通知 */
    if (!err || err.code !== CODES.CONFLICT) throw err
  }
}

/**
 * 手动确定唯一对接方（居间合同上传后、审核前执行）。
 *
 * 合同上传之前允许多家领取、多家对接；管理员确定唯一对接方后：
 * 1) 委托状态「已上架 → 已锁定」，立即退出商机池（领取 / 咨询同时被拦下）；
 * 2) 记录唯一对接方（claimUid / lockedLeadId），后续只有这一家工单能推进成交；
 * 3) 其余对接方的工单关闭并置为无效、待审核合同作废、领取记录清理，并给用户发「已售出」消息。
 * 已由其他工单锁定时抛 CONFLICT，避免同一委托出现两个唯一对接方。
 */
async function lockAgencyForContract(repo, options) {
  const o = options || {}
  const lead = o.lead || {}
  const at = Number(o.at) || Date.now()
  const agencyId = String(lead.agencyId || lead.targetId || '')
  const uid = String(lead.uid || '')
  if (!agencyId || !uid) return { locked: false, reason: 'missing' }
  const agency = await repo.get('agencies', agencyId)
  if (!agency || agency.deleted === true) return { locked: false, reason: 'missing' }

  if (agency.status === AGENCY_STATUS.LOCKED) {
    if (agency.lockedLeadId && agency.lockedLeadId !== String(lead.id || '')) {
      throw new AppError(CODES.CONFLICT, '该委托已确定其他对接方，不能再次锁定')
    }
    return { locked: false, reason: 'already', claimUid: agency.claimUid || uid, closedOthers: 0 }
  }
  /* 已成交 / 已完成 / 已关闭等终态：合同照常归档，不再改写委托状态 */
  if (agency.status !== AGENCY_STATUS.ACTIVE) return { locked: false, reason: 'inactive' }

  const res = await repo.updateWhere('agencies', { id: agencyId, status: AGENCY_STATUS.ACTIVE }, {
    status: AGENCY_STATUS.LOCKED,
    claimUid: uid,
    claimAt: at,
    lockedAt: at,
    lockedBy: String(o.by || ''),
    lockedLeadId: String(lead.id || ''),
    updatedAt: at
  })
  if (!res || !res.count) {
    const fresh = await repo.get('agencies', agencyId)
    if (fresh && fresh.status === AGENCY_STATUS.LOCKED && fresh.lockedLeadId === String(lead.id || '')) {
      return { locked: false, reason: 'already', claimUid: fresh.claimUid || uid, closedOthers: 0 }
    }
    throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
  }

  /* 其余对接方：工单关闭并置为无效，领取记录同步清理，并通知用户「商品已售出」 */
  const closedOthers = await closeOtherAgencyLeads(repo, {
    agencyId,
    keepLeadId: String(lead.id || ''),
    at,
    by: String(o.by || ''),
    note: AGENCY_LOCKED_CLOSE_NOTE
  })
  return { locked: true, claimUid: uid, closedOthers }
}

function agencyOwnerView(doc, now) {
  const d = doc || {}
  const feeView = agencyFeeView(d, now)
  return {
    id: d.id,
    kind: d.kind,
    side: d.side,
    mode: d.mode,
    rental: d.rental === true,
    term: d.term || '',
    item: d.item,
    cat: d.itemCat || d.cat || '',
    city: d.city || '',
    qty: Number(d.qty) || 0,
    price: Number(d.price) || 0,
    amount: Number(d.amount) || 0,
    serviceFee: effectiveServiceFee(d),
    upfront: Number(d.upfront) || 0,
    payNow: Number(d.payNow) || 0,
    /* 旧数据历史上写的是「免服务费」，展示时按新口径纠正 */
    feeRule: d.freeLarge === true ? '1000 万元及以上：成交后按 0.5% 收取' : (d.feeRule || ''),
    feeNote: d.feeNote || '',
    deferredFee: d.deferredFee === true,
    /* ≥1000 万元代采强制保密；其余代采与代售由委托方选择公开 / 保密 */
    visibility: d.visibility || VISIBILITIES.PUBLIC,
    visibilityLabel: VISIBILITY_LABELS[d.visibility || VISIBILITIES.PUBLIC],
    currency: d.currency || DEFAULT_CURRENCY,
    currencySymbol: d.currencySymbol || '¥',
    currencyLabel: d.currencyLabel || '人民币',
    exposure: d.exposure || EXPOSURES.HIDDEN,
    exposureLabel: EXPOSURE_LABELS[d.exposure] || EXPOSURE_LABELS.hidden,
    detail: d.detail || '',
    /* 委托方填写的交易流程 / 必要条件 / 可协商条件，平台审核时参考 */
    flow: Array.isArray(d.flow) ? d.flow.slice() : [],
    must: Array.isArray(d.must) ? d.must.slice() : [],
    nego: Array.isArray(d.nego) ? d.nego.slice() : [],
    subjectType: d.subjectType || '',
    subjectMasked: d.subjectMasked || '',
    /* 授权书联系人电话：委托方填写后回显脱敏值，管理端审核时可对照原件 */
    authPhoneMasked: d.authPhoneMasked || '',
    media: Array.isArray(d.media) ? d.media.slice() : [],
    status: d.status,
    statusText: AGENCY_STATUS_TEXT[d.status] || d.status,
    /* 截止时间即代采 / 代售合同期终点：到点仍未成交则自动关闭 */
    deadline: d.deadline || '',
    deadlineAt: agencyDeadlineAt(d),
    deadlineText: d.deadline || dateText(agencyDeadlineAt(d)),
    /* 已上报付款：用户自己点过「我已支付」，等待平台财务核对 */
    paidClaimAt: Number(d.paidClaimAt) || 0,
    paidClaimText: d.paidClaimAt ? dateText(d.paidClaimAt) + ' 已上报付款' : '',
    reason: d.reason || '',
    closeReason: d.closeReason || '',
    closedAt: Number(d.closedAt) || 0,
    expired: d.closeReason === AGENCY_CLOSE_REASON_EXPIRED,
    reviewNote: d.reviewNote || '',
    staff: d.staff || '',
    createdAt: Number(d.createdAt) || 0,
    createdText: dateText(d.createdAt),
    confirmedText: d.confirmedAt ? dateText(d.confirmedAt) : '',
    approvedText: d.approvedAt ? dateText(d.approvedAt) : '',
    expireText: agencyDeadlineAt(d) ? `${dateText(agencyDeadlineAt(d))} 到期` : '',
    /* 收尾标识：只有本人撤销的委托才带 closedBy，平台关闭 / 驳回需联系客服 */
    selfClosed: !!d.closedBy,
    /* 进度时间线：我的委托里直接展示到「已完成」，无需再联系客服收尾 */
    progress: agencyProgress(d),
    /* 流程节点：详情页展示处理节点、时间和处理人；列表页只取商品字段 */
    flowNodes: agencyFlowNodes(d),
    dealAmount: Number(d.dealAmount) || 0,
    dealAmountText: d.dealAmount
      ? (d.currencySymbol || '¥') + Number(d.dealAmount).toLocaleString('zh-CN')
      : '',
    /* 成交由平台确认，委托方只接收成交通知；以下字段用于回显确认时间与经办人 */
    dealProposedAt: Number(d.dealProposedAt) || 0,
    dealProposedAtText: d.dealProposedAt ? dateTimeText(d.dealProposedAt) : '',
    dealProposedBy: d.dealProposedBy || '',
    dealConfirmedAt: Number(d.dealConfirmedAt) || 0,
    dealConfirmedAtText: d.dealConfirmedAt ? dateTimeText(d.dealConfirmedAt) : '',
    dealConfirmedBy: d.dealConfirmedBy || '',
    completedText: d.completedAt ? dateText(d.completedAt) : '',
    canCancel: !d.editPending && (d.status === AGENCY_STATUS.PENDING || d.status === AGENCY_STATUS.REVIEW),
    /* 已上架委托的修改：提交后先下架，平台审核通过再自动更新并重新上架 */
    editPending: d.editPending === true,
    pendingItem: (d.pendingEdit && d.pendingEdit.item) || '',
    canEdit: d.status === AGENCY_STATUS.ACTIVE && d.editPending !== true,
    /* 被驳回的委托：可回到发布页修改内容、重传材料后重新提交；也可直接删除 */
    canResubmit: d.status === AGENCY_STATUS.REJECTED && d.editPending !== true,
    canDelete: d.status === AGENCY_STATUS.REJECTED && d.editPending !== true,
    /* 后付费服务费：成交后生成账单，3 个工作日内到账 */
    feeStatus: d.feeStatus || 'unbilled',
    feeDueAt: Number(d.feeDueAt) || 0,
    feePaidAt: Number(d.feePaidAt) || 0,
    feePaidAtText: d.feePaidAt ? dateText(d.feePaidAt) : '',
    feeBillId: d.feeBillId || '',
    feeOverdue: feeView.feeOverdue,
    feeStatusText: feeView.feeStatusText,
    feeDueAtText: feeView.feeDueAtText,
    payHint: '提交后进入平台审核，审核通过即上架；平台确认成交后按成交金额支付服务费'
  }
}

/** 管理端视图：联系方式一律脱敏，原件线下核验，接口不下发明文 */
function agencyStaffView(doc, now) {
  const base = agencyOwnerView(doc, now)
  return Object.assign(base, {
    ownerId: doc.ownerId,
    ownerNick: doc.ownerNick || '',
    phoneMasked: doc.phoneMasked || '',
    /* 用户点「我已支付」的时间与次数：财务仍需核对流水后手动确认到账 */
    paidClaimAt: Number(doc.paidClaimAt) || 0,
    paidClaimCount: Number(doc.paidClaimCount) || 0,
    paidClaimNote: doc.paidClaimNote || '',
    legalMasked: doc.legalMasked || '',
    creditMasked: doc.creditMasked || '',
    idCardMasked: doc.idCardMasked || '',
    /* 上传材料清单：管理端核对抽屉据此判断是否有原件，并调 media.fileUrls 取直链 */
    media: (Array.isArray(doc.media) ? doc.media : []).map((m) => ({
      name: (m && m.name) || '',
      kind: (m && m.kind) || 'other',
      fileId: (m && m.fileId) || ''
    })),
    authPhoneMatched: doc.authPhoneMatched === true,
    materialVerified: doc.materialVerified === true,
    updatedAt: Number(doc.updatedAt || doc.createdAt) || 0,
    confirmedAt: Number(doc.confirmedAt) || 0,
    approvedAt: Number(doc.approvedAt) || 0,
    /* 成交与完成：平台确认成交 → 服务费到账 → 平台确认完成（工单 / 委托同时归档） */
    completedAt: Number(doc.completedAt) || 0,
    completedBy: doc.completedBy || '',
    /* 旧字段：升级前由委托方确认收货，仅用于展示历史数据 */
    receiptConfirmedAt: Number(doc.receiptConfirmedAt) || 0,
    receiptPending: doc.status === AGENCY_STATUS.DEALT && !doc.receiptConfirmedAt,
    dealPending: doc.status === AGENCY_STATUS.DEAL_PENDING,
    dealProposedAt: Number(doc.dealProposedAt) || 0,
    dealProposedBy: doc.dealProposedBy || '',
    dealConfirmedAt: Number(doc.dealConfirmedAt) || 0,
    feePaidBy: doc.feePaidBy || '',
    /* 截止时间：历史委托没有 deadline 时退回原 expiresAt */
    expiresAt: agencyDeadlineAt(doc),
    daysLeft: agencyDeadlineAt(doc) ? Math.max(0, Math.ceil((agencyDeadlineAt(doc) - now) / DAY_MS)) : 0
  })
}

/* ============================================================
   现货盘聚合
   ============================================================ */

function listOf(value) {
  return Array.isArray(value) ? value : []
}

/* ============================================================
   价格水平模型
   1) 平台在售商品（货盘）作为市场基准锚点；
   2) 代采 / 代售来自真实意向与成交，参考权重高于报价；
   3) 用户粘贴报价作为市场补充，权重最低；
   4) 再按数量与时效做小幅修正，收敛为「最终价格水平」。
   ============================================================ */

const PRICE_SOURCE = Object.freeze({
  PRODUCT: 'product',
  AGENCY_BUY: 'agencyBuy',
  AGENCY_SELL: 'agencySell',
  DEMAND_BUY: 'demandBuy',
  QUOTE: 'quote'
})

/* 样本权重：代采（真实预算）> 代售（真实报价）> 平台商品 > 粘贴报价 */
const PRICE_WEIGHT = Object.freeze({
  product: 3,
  agencyBuy: 3.5,
  agencySell: 3,
  demandBuy: 3,
  quote: 1
})

/* 最终价格水平的三档权重：货盘基准 45% + 代采代售 40% + 其他报价 15% */
const PRICE_BLEND = Object.freeze({ anchor: 0.45, agency: 0.4, quote: 0.15 })

function weightedRow(samples) {
  return samples.filter((s) => s.price > 0)
}

function weightedMedian(samples) {
  const rows = weightedRow(samples).sort((a, b) => a.price - b.price)
  if (!rows.length) return 0
  const total = rows.reduce((sum, row) => sum + row.weight, 0)
  let acc = 0
  for (const row of rows) {
    acc += row.weight
    if (acc >= total / 2) return row.price
  }
  return rows[rows.length - 1].price
}

function weightedMean(samples) {
  const rows = weightedRow(samples)
  if (!rows.length) return 0
  const total = rows.reduce((sum, row) => sum + row.weight, 0)
  if (total <= 0) return 0
  return rows.reduce((sum, row) => sum + row.price * row.weight, 0) / total
}

/**
 * 极端报价过滤：偏离加权中位数 3 倍以上的样本不参与定价。
 * 用户的粘贴报价没有校验成本，单条错报（少填一位 / 把月租当售价）会把均值拉偏。
 */
function trimSamples(samples) {
  const rows = weightedRow(samples)
  if (rows.length < 3) return rows
  const median = weightedMedian(rows)
  if (!(median > 0)) return rows
  const kept = rows.filter((row) => row.price >= median / 3 && row.price <= median * 3)
  return kept.length ? kept : rows
}

/**
 * 由样本收敛出最终价格水平。
 * 返回 null 表示该组没有任何有效价格样本。
 */
function priceLevelOf(row, now) {
  const samples = trimSamples(row.samples)
  const products = samples.filter((s) => s.source === PRICE_SOURCE.PRODUCT)
  const agencySamples = samples.filter(
    (s) => s.source === PRICE_SOURCE.AGENCY_BUY || s.source === PRICE_SOURCE.AGENCY_SELL
  )
  /* 买方求购预算与代采预算同属真实预算，合并进「委托」一档 */
  const demandSamples = samples.filter((s) => s.source === PRICE_SOURCE.DEMAND_BUY)
  const quotes = samples.filter((s) => s.source === PRICE_SOURCE.QUOTE)

  const anchor = weightedMedian(products)
  const agency = weightedMean(agencySamples.concat(demandSamples))
  const quote = weightedMean(quotes)

  let wa = anchor > 0 ? PRICE_BLEND.anchor : 0
  let wg = agency > 0 ? PRICE_BLEND.agency : 0
  let wq = quote > 0 ? PRICE_BLEND.quote : 0
  const weightSum = wa + wg + wq
  if (weightSum <= 0) return null
  wa /= weightSum
  wg /= weightSum
  wq /= weightSum

  const raw = anchor * wa + agency * wg + quote * wq
  if (!(raw > 0)) return null

  /* 其他因素：批量折让 + 时效衰减（成色已体现在商品 / 委托报价里，不重复打折） */
  const qty = Number(row.buyCount) + Number(row.sellCount)
  const qtyFactor = qty >= 50 ? 0.98 : qty >= 20 ? 0.99 : 1
  const ageDays = row.updatedAt ? Math.max(0, (now - row.updatedAt) / DAY_MS) : 0
  const timeFactor = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.99 : 0.97
  const level = Math.max(1, Math.round(raw * qtyFactor * timeFactor))

  /* 区间：取样本离散度，收敛在 ±10% 内，避免极端报价把区间拉爆 */
  const values = samples.map((s) => s.price)
  if (!values.length) return null
  const min = Math.min.apply(null, values)
  const max = Math.max.apply(null, values)
  const spread = Math.min(0.1, level > 0 ? (max - min) / 2 / level : 0.05)
  const low = Math.max(1, Math.round(level * (1 - spread)))
  const high = Math.max(low, Math.round(level * (1 + spread)))

  const count = samples.length
  let confidence = count >= 10 ? 90 : count >= 5 ? 78 : count >= 3 ? 66 : count >= 2 ? 55 : 40
  if (values.length > 1 && (max - min) / level > 0.5) confidence = Math.max(30, confidence - 10)

  const parts = []
  if (products.length) parts.push(`货盘 ${products.length}`)
  if (agencySamples.length) parts.push(`代采代售 ${agencySamples.length}`)
  if (demandSamples.length) parts.push(`求购 ${demandSamples.length}`)
  if (quotes.length) parts.push(`报价 ${quotes.length}`)

  return {
    priceLevel: level,
    priceLevelText: `¥${moneyText(level)}`,
    priceLow: low,
    priceHigh: high,
    priceRangeText: `¥${moneyText(low)} - ¥${moneyText(high)}`,
    confidence,
    confidenceText: confidence >= 78 ? '高' : confidence >= 55 ? '中' : '低',
    sampleCount: count,
    sourceText: parts.join(' · '),
    anchorText: anchor > 0 ? `¥${moneyText(Math.round(anchor))}` : '—',
    agencyText: agency > 0 ? `¥${moneyText(Math.round(agency))}` : '—',
    quoteText: quote > 0 ? `¥${moneyText(Math.round(quote))}` : '—',
    basis: {
      anchor: Math.round(anchor),
      agency: Math.round(agency),
      quote: Math.round(quote),
      products: products.length,
      agencies: agencySamples.length,
      demands: demandSamples.length,
      quotes: quotes.length
    }
  }
}

function boardItems({ products, agencies, demands, quotes, now, limit }) {
  const groups = new Map()
  const groupOf = (cat, model, city) => {
    const key = [cat || '其他', model || '', city || '不限'].join('|')
    let row = groups.get(key)
    if (!row) {
      row = {
        id: 'bd' + sha256Hex(key).slice(0, 12),
        cat: cat || '其他',
        model: model || '',
        city: city || '',
        buyPrice: 0,
        sellPrice: 0,
        buyCount: 0,
        sellCount: 0,
        updatedAt: 0,
        samples: []
      }
      groups.set(key, row)
    }
    return row
  }
  const put = (cat, model, city, side, price, qty, at, source, weight) => {
    const row = groupOf(cat, model, city)
    const value = Number(price) || 0
    if (side === 'buy') {
      /* 买价取最高预算：同一品类 / 型号 / 城市可能有多条代采委托 */
      if (value > row.buyPrice) row.buyPrice = value
      row.buyCount += Number(qty) || 0
    } else {
      if (value > 0 && (row.sellPrice <= 0 || value < row.sellPrice)) row.sellPrice = value
      row.sellCount += Number(qty) || 0
    }
    row.updatedAt = Math.max(row.updatedAt, Number(at) || 0)
    if (value > 0) row.samples.push({ price: value, weight: weight || 1, source })
  }

  /* 平台在售商品：无论是否代采，价格都作为货盘参考（租赁按月计价，不能与买卖价混算） */
  for (const doc of listOf(products)) {
    if (doc.deleted || doc.status !== '在售') continue
    /* 私密发布不进入公开行情盘 */
    if (doc.visibility === VISIBILITIES.PRIVATE) continue
    if (doc.rental === true || doc.tradeMode === TRADE_MODES.RENT) continue
    /* 现场沟通没有金额可参考，但仍计入在售数量 */
    const price = doc.priceMode === 'nego' ? 0 : Number(doc.price) || 0
    if (price <= 0) {
      const row = groupOf(doc.cat || doc.category, doc.model || doc.title, doc.city)
      row.sellCount += Number(doc.qty) || 0
      row.updatedAt = Math.max(row.updatedAt, Number(doc.createdAt) || 0)
      continue
    }
    put(
      doc.cat || doc.category,
      doc.model || doc.title,
      doc.city,
      'sell',
      price,
      doc.qty,
      doc.createdAt,
      PRICE_SOURCE.PRODUCT,
      PRICE_WEIGHT.product
    )
  }

  for (const doc of listOf(agencies)) {
    if (doc.deleted) continue
    if (doc.status !== AGENCY_STATUS.ACTIVE) continue
    if (Number(doc.expiresAt) <= now) continue
    /* 租赁委托的价格是月租，与整机买卖价不同口径 */
    if (doc.rental === true || doc.mode === TRADE_MODES.RENT || doc.mode === TRADE_MODES.LEASE) continue
    const source = doc.side === 'buy' ? PRICE_SOURCE.AGENCY_BUY : PRICE_SOURCE.AGENCY_SELL
    put(
      doc.itemCat || '',
      doc.item,
      doc.city || '',
      doc.side,
      doc.price,
      doc.qty,
      doc.confirmedAt || doc.createdAt,
      source,
      doc.side === 'buy' ? PRICE_WEIGHT.agencyBuy : PRICE_WEIGHT.agencySell
    )
  }

  /* 买方求购需求：只做「品类 + 型号 + 城市」聚合，求购方身份、联系方式与需求明细一律不下发 */
  for (const doc of listOf(demands)) {
    if (doc.deleted) continue
    if (doc.status !== DEMAND_STATUS.OPEN) continue
    /* 私密发布不进入公开行情盘 */
    if (doc.visibility === VISIBILITIES.PRIVATE) continue
    /* 租赁需求的预算是月租，与整机买卖价不同口径 */
    if (doc.tradeMode === TRADE_MODES.LEASE || doc.tradeMode === TRADE_MODES.RENT) continue
    /* 仅商机池的需求不进入公开现货盘 */
    if (doc.channel === PUBLISH_CHANNELS.POOL) continue
    /* 区间预算按上限计入买方预算；面议需求只累加求购数量 */
    const budget = doc.budgetMode === 'range' && Number(doc.budgetMax) > Number(doc.budget)
      ? Number(doc.budgetMax)
      : Number(doc.budget) || 0
    put(
      doc.cat || '',
      doc.model || doc.title,
      doc.city || '',
      'buy',
      budget,
      doc.qty,
      doc.createdAt,
      PRICE_SOURCE.DEMAND_BUY,
      PRICE_WEIGHT.demandBuy
    )
  }
  for (const quote of listOf(quotes)) {
    if (quote.deleted) continue
    if (Number(quote.expiresAt) <= now) continue
    for (const item of listOf(quote.items)) {
      put(item.cat, item.model, item.city || '', 'sell', item.price, item.qty || 1, quote.createdAt, PRICE_SOURCE.QUOTE, PRICE_WEIGHT.quote)
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit || 50)
    .map((row) => {
      const price = priceLevelOf(row, now)
      return Object.assign({
        id: row.id,
        cat: row.cat,
        model: row.model,
        city: row.city,
        buyPrice: row.buyPrice,
        sellPrice: row.sellPrice,
        buyPriceText: row.buyPrice > 0 ? `¥${moneyText(row.buyPrice)}` : '—',
        sellPriceText: row.sellPrice > 0 ? `¥${moneyText(row.sellPrice)}` : '—',
        buyCount: row.buyCount,
        sellCount: row.sellCount,
        updated: relTime(row.updatedAt, now)
      }, price || {})
    })
}

/* ============================================================
   资讯
   ============================================================ */

const NEWS_STATUS = Object.freeze({
  PENDING: '待审核',
  SCHEDULED: '待发布',
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  OFFLINE: '已下架'
})
const NEWS_STATUS_LIST = Object.freeze([NEWS_STATUS.PENDING, NEWS_STATUS.SCHEDULED, NEWS_STATUS.PUBLISHED, NEWS_STATUS.REJECTED, NEWS_STATUS.OFFLINE])
const NEWS_OFFICIAL_CATS = Object.freeze(['平台公告', '行情解读', '行业资讯'])
const NEWS_USER_CAT = '用户发布'

/* 资讯定时发布：官方稿先存「待发布」，到点由服务端批量上线，不需要人工守点 */
const DEFAULT_NEWS_SLOTS = Object.freeze(['11:00', '15:00', '21:00'])
const NEWS_SLOT_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function normalizeSlots(raw) {
  const list = []
  ;(Array.isArray(raw) ? raw : []).forEach((v) => {
    const text = String(v || '').trim()
    if (NEWS_SLOT_RE.test(text) && list.indexOf(text) < 0) list.push(text)
  })
  list.sort()
  return list.slice(0, 6)
}

/** 读取自动发布配置：时间段 + 开关，未配置时用默认 11:00 / 15:00 / 21:00 */
async function newsScheduleOf(repo) {
  try {
    const row = await repo.get('settings', 'news_schedule')
    const slots = normalizeSlots(row && row.slots)
    return {
      slots: slots.length ? slots : DEFAULT_NEWS_SLOTS.slice(),
      enabled: !(row && row.enabled === false)
    }
  } catch (err) {
    return { slots: DEFAULT_NEWS_SLOTS.slice(), enabled: true }
  }
}

/** 把「待发布」的资讯批量上线；返回实际条数，供定时器打日志 */
async function publishScheduledNews(deps) {
  const repo = deps && deps.repo
  if (!repo) return { published: 0 }
  const at = typeof (deps && deps.now) === 'function' ? deps.now() : Date.now()
  const rows = await repo.find('news', { status: NEWS_STATUS.SCHEDULED, deleted: { $ne: true } }, { limit: 100 })
  let published = 0
  for (const row of rows) {
    const res = await repo.updateWhere('news', { id: row.id, status: NEWS_STATUS.SCHEDULED }, {
      status: NEWS_STATUS.PUBLISHED,
      publishedAt: at,
      updatedAt: at
    })
    if (res && res.count) published++
  }
  return { published }
}

/* 资讯不做人工审核：提交时自动过一遍违禁词筛查，命中直接驳回、不落库。
   词库覆盖暴力、色情、赌博、诈骗、违禁品等大类，用户改完内容可重新发布。 */
const NEWS_BANNED_WORDS = Object.freeze([
  /* 色情 */
  '色情', '黄网', '黄色网站', '裸聊', '裸条', '约炮', '一夜情', '卖淫', '嫖娼', '招嫖',
  '性服务', '成人视频', '成人网站', '淫秽', '情色', '三级片', '色情直播',
  /* 暴力 / 恐怖 */
  '杀人', '砍人', '血腥', '虐杀', '虐待', '暴恐', '恐怖袭击', '爆炸物', '炸药', '雷管',
  '枪支', '弹药', '管制刀具', '自残',
  /* 赌博 */
  '赌博', '博彩', '六合彩', '赌场', '网赌', '时时彩',
  /* 诈骗 / 违法 */
  '诈骗', '传销', '洗钱', '高利贷', '裸贷', '假币', '假证', '办证', '代开发票',
  '发票代开', '黑客', '木马病毒', '毒品', '冰毒', '海洛因', '迷药', '器官买卖',
  '人口买卖', '拐卖',
  /* 其他违禁 */
  '翻墙软件', '黄赌毒', '法轮功'
])

/* 筛查归一化：去掉空白和常见分隔符，避免「色 情」「赌-博」这类拆字绕过 */
function screenText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[\s\u3000\-_*·.,，。!！?？、;；:：/\\|~`'"“”‘’()（）\[\]【】<>《》+@#￥$%^&]/g, '')
}

/* 返回命中的违禁词，未命中返回空串 */
function findBannedWord(text) {
  const hay = screenText(text)
  if (!hay) return ''
  for (let i = 0; i < NEWS_BANNED_WORDS.length; i += 1) {
    const word = NEWS_BANNED_WORDS[i]
    if (hay.indexOf(screenText(word)) >= 0) return word
  }
  return ''
}

/* 资讯媒体（朋友圈式）：图片最多 9 张、视频最多 1 段，大小与服务端上传接口同口径 */
const NEWS_MEDIA_LIMIT = Object.freeze({ image: 9, video: 1 })
const NEWS_MEDIA_TYPES = Object.freeze({
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/x-m4v': 'video'
})

/** 资讯媒体元信息校验：只收名称 / 类型 / 大小 / 上传地址，二进制由 /api/upload 落盘 */
function normalizeNewsMedia(input) {
  if (input == null || input === '') return []
  if (!Array.isArray(input)) throw new AppError(CODES.VALIDATION, '媒体列表格式不合法')
  const groups = { image: 0, video: 0 }
  const out = []
  for (const item of input) {
    const type = String((item && item.type) || '').toLowerCase()
    const kind = NEWS_MEDIA_TYPES[type]
    if (!kind) throw new AppError(CODES.VALIDATION, '不支持的图片 / 视频格式')
    const ref = fileRef(item && item.fileId)
    if (!ref) throw new AppError(CODES.VALIDATION, '媒体文件未上传成功，请重新选择')
    if (groups[kind] >= NEWS_MEDIA_LIMIT[kind]) {
      throw new AppError(CODES.VALIDATION, kind === 'video' ? '最多上传 1 段视频' : '最多上传 9 张图片')
    }
    const size = Number(item && item.size)
    if (!Number.isFinite(size) || size <= 0) throw new AppError(CODES.VALIDATION, '文件大小不合法')
    if (size > MEDIA_MAX_BYTES[kind]) {
      throw new AppError(CODES.VALIDATION, MEDIA_SIZE_TEXT[kind] || '文件大小超出限制')
    }
    const name = String((item && item.name) || '').replace(/[\\/:*?"<>|\r\n]/g, '').slice(0, 30) ||
      (kind === 'video' ? '视频' : '图片')
    groups[kind]++
    out.push({ name, type, size: Math.floor(size), kind, fileId: ref })
  }
  return out
}

/** 媒体对外输出：过滤掉没有地址的脏数据，前端据此直接渲染九宫格 / 视频 */
function newsMediaView(input) {
  const list = Array.isArray(input) ? input : []
  return list.filter((m) => m && m.fileId).map((m) => ({
    name: m.name || '',
    type: m.type || '',
    size: Number(m.size) || 0,
    kind: m.kind === 'video' ? 'video' : 'image',
    fileId: m.fileId
  }))
}

function normalizeNewsInput(data, official) {
  const title = str(data.title, { field: '标题', required: true, min: 4, max: 60 })
  const content = str(data.content, { field: '正文', required: true, min: 10, max: 2000 })
  const city = str(data.city, { field: '城市', max: 20 })
  assertNoContactInText(title, '标题')
  assertNoContactInText(content, '正文')
  const cat = official
    ? enumOf(data.cat || NEWS_OFFICIAL_CATS[0], NEWS_OFFICIAL_CATS, '资讯分类')
    : NEWS_USER_CAT
  /* 可见范围：默认公开；私密资讯仍在资讯流展示，但对他人匿名 */
  const visibility = enumOf(data.visibility || VISIBILITIES.PUBLIC, [VISIBILITIES.PUBLIC, VISIBILITIES.PRIVATE], '可见范围')
  return {
    title,
    content,
    media: normalizeNewsMedia(data.media),
    city,
    cat,
    visibility,
    summary: content.replace(/\s+/g, ' ').slice(0, 120)
  }
}

function newsView(doc, at) {
  const d = doc || {}
  const isPrivate = d.visibility === VISIBILITIES.PRIVATE
  const media = newsMediaView(d.media)
  const base = {
    id: d.id,
    official: isPrivate ? false : d.official === true,
    cat: d.cat || '',
    title: d.title || '',
    summary: d.summary || '',
    city: d.city || '',
    media,
    mediaCount: media.length,
    /* 正文超过摘要长度时，信息流展示「全文」入口，与摘要一起构成朋友圈式预览 */
    hasFull: String(d.content || '').length > String(d.summary || '').length,
    published: relTime(d.publishedAt || d.createdAt, at || Date.now()),
    publishedAt: Number(d.publishedAt || d.createdAt) || 0,
    views: Number(d.views) || 0,
    private: isPrivate
  }
  /* 私密资讯：不返回任何可定位发布人的字段，展示名统一匿名 */
  if (isPrivate) return Object.assign(base, { author: '匿名用户' })
  return Object.assign(base, { author: d.author || '' })
}

/* ---------- 资讯互动：点赞 / 评论 ---------- */
const NEWS_COMMENT_MAX = 300

function newsLikeId(uid, newsId) {
  return 'nl_' + sha256Hex('newslike|' + uid + '|' + newsId).slice(0, 22)
}

function newsCommentView(row, uid, at) {
  return {
    id: row.id,
    author: row.author || '平台用户',
    content: row.content || '',
    createdAt: Number(row.createdAt) || 0,
    createdText: relTime(row.createdAt, at),
    replyToName: row.replyToName || '',
    parentId: row.parentId || '',
    mine: !!uid && row.uid === uid
  }
}

/** 我的评论收到的直接回复数（按已读时间过滤） */
async function unreadReplyCount(repo, uid, readAt) {
  const mine = await repo.find('newsComments', { uid, deleted: { $ne: true } }, { limit: 100 })
  const ids = mine.map((row) => row.id)
  if (!ids.length) return 0
  const replies = await repo.find('newsComments', {
    parentId: { $in: ids },
    uid: { $ne: uid },
    deleted: { $ne: true }
  }, { limit: 300 })
  return replies.filter((row) => (Number(row.createdAt) || 0) > readAt).length
}

function newsStaffView(doc, at) {
  const base = newsView(doc, at)
  /* 管理端不做匿名处理：如实展示官方标识、真实作者与正文 */
  return Object.assign(base, {
    official: doc.official === true,
    author: doc.author || '',
    uid: doc.uid || '',
    content: doc.content || '',
    status: doc.status || '',
    reason: doc.reason || '',
    createdAt: Number(doc.createdAt) || 0,
    createdText: dateText(doc.createdAt)
  })
}

/* ============================================================
   商机权限
   ============================================================ */

const BIZ_PLAN = Object.freeze({ price: 99, days: 30, label: '99 元 / 月（30 天）' })
/* 套餐：月度按原价，季度 / 半年 / 年度给阶梯优惠（金额为实收价，original 为按月度单价折算的原价） */
const BIZ_PLANS = Object.freeze([
  { key: 'month', label: '月度', days: 30, price: 99, original: 99, saving: 0 },
  { key: 'quarter', label: '季度', days: 90, price: 268, original: 297, saving: 29 },
  { key: 'half', label: '半年', days: 180, price: 499, original: 594, saving: 95 },
  { key: 'year', label: '年度', days: 365, price: 899, original: 1188, saving: 289 }
])
const BIZ_PLAN_MAP = Object.freeze(BIZ_PLANS.reduce((acc, item) => {
  acc[item.key] = item
  return acc
}, {}))
/* 套餐档位对应的自然月数：按月开通按自然月到期，不按 30 天折算 */
const BIZ_PLAN_MONTHS = Object.freeze({ month: 1, quarter: 3, half: 6, year: 12 })

/**
 * 会员按自然月计算到期时间：
 * 2 月 15 日 12:00 开通 → 3 月 15 日 11:59:59 到期；
 * 目标月份没有开通日（如 3 月 31 日开通、4 月只有 30 天）→ 到 4 月 30 日 23:59:59 到期。
 * baseMs 为本次时长起始时刻，months 为自然月数。
 */
function monthlyExpireAt(baseMs, months) {
  /* 统一按北京时间（UTC+8）取「日 / 时」，不受服务器时区影响 */
  const OFFSET = 8 * 60 * 60 * 1000
  const base = new Date(Number(baseMs) + OFFSET)
  const day = base.getUTCDate()
  const hour = base.getUTCHours()
  const minute = base.getUTCMinutes()
  const second = base.getUTCSeconds()
  const ms = base.getUTCMilliseconds()
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1, hour, minute, second, ms))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  /* 下个月没有同一天：按该月最后一天 23:59:59 结束 */
  if (day > lastDay) {
    return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), lastDay, 23, 59, 59, 999) - OFFSET
  }
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day, hour, minute, second, ms) - OFFSET - 1000
}

/** 套餐配置：管理端可在设置页改写价格 / 天数，未配置时用默认四档 */
function sanitizePlans(input) {
  if (!Array.isArray(input) || !input.length) return null
  const byKey = new Map(input.map((row) => [String((row && row.key) || ''), row || {}]))
  return BIZ_PLANS.map((def) => {
    const src = byKey.get(def.key) || {}
    const days = Math.round(Number(src.days) || def.days)
    const price = Number(src.price)
    const original = Number(src.original)
    return {
      key: def.key,
      label: String(src.label || def.label).slice(0, 12),
      days: Math.min(3650, Math.max(1, days)),
      price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : def.price,
      original: Number.isFinite(original) && original >= 0 ? Math.round(original * 100) / 100 : def.original,
      saving: 0
    }
  }).map((item) => Object.assign(item, { saving: Math.max(0, Math.round((item.original - item.price) * 100) / 100) }))
}

async function resolvePlans(repo) {
  try {
    const site = await repo.get('settings', 'site')
    return sanitizePlans(site && site.plans) || BIZ_PLANS.map((item) => Object.assign({}, item))
  } catch (err) {
    return BIZ_PLANS.map((item) => Object.assign({}, item))
  }
}
const BIZ_STATUS = Object.freeze({
  PENDING: '待确认',
  ACTIVE: '已开通',
  EXPIRED: '已到期',
  STOPPED: '已停用'
})
/* 新用户 7 天体验：每人限一次，权益与付费会员一致，到期不自动续费 */
const TRIAL_DAYS = 7
const TRIAL_PLAN_LABEL = '7 天体验'
/* 收款流水：企业微信 / 微信 / 对公等线下收款统一登记，确认后计入财务口径 */
const PAYMENT_STATUS = Object.freeze({
  PENDING: '待确认',
  CONFIRMED: '已确认',
  REFUNDED: '已退款'
})
const PAYMENT_STATUS_LIST = Object.freeze([PAYMENT_STATUS.PENDING, PAYMENT_STATUS.CONFIRMED, PAYMENT_STATUS.REFUNDED])
/* 退款申请：用户提交 → 财务审核，通过后走 payment.refund 同一套退款逻辑 */
const REFUND_STATUS = Object.freeze({
  PENDING: '待处理',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  CANCELLED: '已撤销'
})
const PAYMENT_BIZ_TYPES = Object.freeze(['会员续费', '代采服务费', '代售服务费', '租赁服务费', '其他'])
/* 需要财务人工确认到账的只有委托服务费账单；会员收款由微信支付自动入账 */
const PAYMENT_FEE_TYPES = Object.freeze(['代采服务费', '代售服务费', '租赁服务费'])
const PAYMENT_METHODS = Object.freeze(['微信支付', '企业微信', '微信转账', '对公转账', '支付宝', '现金', '其他'])

function accessView(access, now) {
  const a = access || null
  const expireAt = Number(a && a.expireAt) || 0
  const status = bizStatusOf(a, now)
  /* 7 天体验：每人限一次，未开通 / 已到期且从未用过时才可申请 */
  const trialUsed = !!(a && a.trialUsed)
  return {
    status,
    unlocked: status === BIZ_STATUS.ACTIVE,
    plan: BIZ_PLAN,
    expireAt,
    expireText: expireAt ? `${dateText(expireAt)} 到期` : '未开通',
    daysLeft: expireAt ? Math.max(0, Math.ceil((expireAt - now) / DAY_MS)) : 0,
    appliedAt: Number(a && a.appliedAt) || 0,
    appliedText: a && a.appliedAt ? dateText(a.appliedAt) : '',
    trialUsed,
    trialDays: TRIAL_DAYS,
    trialAvailable: !trialUsed && (status === '未开通' || status === BIZ_STATUS.EXPIRED)
  }
}

function bizStatusOf(access, now) {
  if (!access) return '未开通'
  if (access.status === BIZ_STATUS.STOPPED) return BIZ_STATUS.STOPPED
  if (access.status === BIZ_STATUS.PENDING) return BIZ_STATUS.PENDING
  if (Number(access.expireAt) > now) return BIZ_STATUS.ACTIVE
  return BIZ_STATUS.EXPIRED
}

function quoteView(quote, now) {
  const q = quote || {}
  return {
    id: q.id,
    items: listOf(q.items).map((item) => ({
      cat: item.cat || '其他',
      model: item.model || '',
      price: Number(item.price) || 0,
      priceText: Number(item.price) > 0 ? `¥${moneyText(item.price)}` : '面议',
      city: item.city || '',
      qty: Number(item.qty) || 0
    })),
    itemCount: Number(q.itemCount) || listOf(q.items).length,
    expireText: `${dateText(q.expiresAt)} 失效`,
    expired: Number(q.expiresAt) <= now,
    at: Number(q.createdAt) || 0,
    updated: relTime(q.createdAt, now)
  }
}

/* ============================================================
   用户端 handlers
   ============================================================ */

function createMarketUserHandlers(deps) {
  const { repo, keys } = deps
  /* 云存储临时链接：合同扫描件按需换链，ECS 部署时由 fileId 直链兜底 */
  const cloud = deps.cloud
  /* 微信订阅消息：新商机匹配时推送，用户可在设置里关闭商机提醒 */
  const subscribe = deps.subscribe
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const cacheLayer = deps.cache && typeof deps.cache.wrap === 'function' ? deps.cache : null

  /**
   * 商机池共享缓存：池子内容对所有会员一致（是否匹配在请求内按本人库存计算），
   * 因此 key 不含身份；发布 / 库存 / 委托变更都会 bump biz 分组，缓存立即失效。
   */
  async function sharedPool(name, ttlSec, loader) {
    if (!cacheLayer) return loader()
    try {
      const key = await cacheLayer.keyOf('user', 'biz', 'pool:' + name)
      return await cacheLayer.wrap(key, ttlSec, loader)
    } catch (err) {
      return loader()
    }
  }

  /** 商机池主体信息：按主体 id 集合读取，是否公开主体在调用侧按需筛选 / 脱敏 */
  async function sharedPoolProfiles(ownerIds) {
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    if (!ids.length) return new Map()
    /* 不使用跨请求缓存：主体公开范围变化后，商机列表 / 角标必须立即跟随 */
    const rows = Array.from((await poolProfiles(ids)).values())
    return new Map(rows.map((row) => [row.uid || row.id, row]))
  }

  async function mustUser(ctx) {
    const user = await repo.get('users', ctx.openid)
    if (!user) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
    /* 与管理端停用口径一致：停用后立即失去交易 / 发布能力 */
    if (user.status === '停用') throw new AppError(CODES.FORBIDDEN, '账号已停用，请联系平台客服')
    return user
  }

  /**
   * 社交功能总开关（评论 / 私信 / 对话）：管理端「媒体 → 社交功能」统一控制，默认关闭。
   * 关闭后评论列表 / 计数 / 我的评论 / 未读角标一律不再下发，发表接口直接拒绝。
   * 已落库的评论保留，重新开启后恢复展示。旧配置没有 socialEnabled 时按 chatEnabled 判断。
   */
  async function commentsEnabled() {
    const doc = (await repo.get('settings', 'site')) || {}
    if (doc.socialEnabled !== undefined) return doc.socialEnabled === true
    return doc.chatEnabled === true
  }

  /**
   * 发布 / 委托前置的必填口径：主体名称、主体类型、主体类别、联系人与手机号。
   * 与 handlers.user.js 的 assertProfileReady 保持一致；职位 position 选填，不参与拦截。
   */
  async function assertProfileReady(uid, knownUser) {
    const user = knownUser || await repo.get('users', uid)
    const profile = (await repo.find('profiles', { uid }, { limit: 1 }))[0] || {}
    const missing = []
    if (!profile.subjectCipher && !String(profile.subject || '').trim()) missing.push('主体名称')
    if (!String(profile.subjectType || '').trim()) missing.push('主体类型')
    if (!String(profile.subjectKind || '').trim()) missing.push('主体类别')
    if (!user || !(user.realnameCipher || user.realname)) missing.push('联系人')
    if (!user || !user.phoneCipher) missing.push('手机号')
    if (!missing.length) return
    throw new AppError(
      CODES.VALIDATION,
      `请先完善主体信息和联系方式（缺少：${missing.join('、')}）`,
      { missing }
    )
  }

  async function ownStocks(uid) {
    return repo.find('stocks', { ownerId: uid, status: '在售', deleted: { $ne: true } }, { limit: 200 })
  }

  async function ownAccess(uid) {
    return repo.get('bizAccess', uid)
  }

  async function ownClaims(uid) {
    const rows = await repo.find('bizClaims', { uid }, { limit: 200 })
    const set = new Set()
    for (const row of rows) set.add(`${row.targetType}:${row.targetId}`)
    return set
  }

  /**
   * 商机池主体信息：按主体 id 集合共享，避免每个会员各扫一遍 profiles。
   * 不再按「是否公开主体」过滤：匿名主体也进池，仅影响展示脱敏与 onlyOpenSubject 筛选。
   */
  async function poolProfiles(ownerIds) {
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    const map = new Map()
    if (!ids.length) return map
    const rows = await repo.find('profiles', { uid: { $in: ids } }, { limit: ids.length })
    for (const row of rows) {
      map.set(row.uid || row.id, row)
    }
    return map
  }

  /** 已领取时才解密对方联系方式；列表 / 未领取一律只给脱敏信息 */
  async function contactOfUser(uid) {
    const user = await repo.get('users', uid)
    if (!user) return { org: '', name: '', phone: '', phoneMasked: '' }
    const profiles = await repo.find('profiles', { uid }, { limit: 1 })
    const profile = profiles[0] || null
    let realname = ''
    try {
      realname = user.realnameCipher
        ? decryptFieldOf({ keys, collection: 'users', field: 'realname', recordId: user.id, cipher: user.realnameCipher })
        : user.realname || ''
    } catch (err) {
      realname = ''
    }
    let org = ''
    try {
      org = profile && profile.subjectCipher
        ? decryptFieldOf({ keys, collection: 'profiles', field: 'subject', recordId: profile.uid || profile.id, cipher: profile.subjectCipher })
        : (profile && profile.subject) || ''
    } catch (err) {
      org = ''
    }
    const exposure = (profile && profile.exposure) || EXPOSURES.HIDDEN
    let phone = ''
    /* 只有「公开主体 + 主动公开联系电话」才在领取后下发明文号码；
       未公开电话时会员也只拿到联系人，需走站内对话 */
    const phoneShared = exposure === EXPOSURES.OPEN && profile.phonePublic === true
    if (phoneShared) {
      try {
        phone = user.phoneCipher
          ? decryptField({ keys, token: user.phoneCipher, aad: `users.phoneCipher.${user.id}` })
          : ''
      } catch (err) {
        phone = ''
      }
    }
    return {
      /* hidden：一律脱敏，主体只给平台核验口径，避免暴露企业身份 */
      org: exposure === EXPOSURES.HIDDEN
        ? '平台核验主体（信息已隐藏）'
        : (org || user.nick || ''),
      name: exposure === EXPOSURES.HIDDEN
        ? '平台对接人'
        : (realname || user.nick || ''),
      phone,
      phoneMasked: maskPhone(phone),
      exposure
    }
  }

  /** 多选项（租期 / 租赁限制 / 验收方式）统一用顿号拼接 */
  function joinText(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('、')
    return String(value == null ? '' : value).trim()
  }

  /** 商机详情「发布者设定的全部信息」：发布时填写的字段整理为键值行，空值不展示 */
  function infoRows(rows) {
    const out = []
    for (const row of rows || []) {
      if (!row) continue
      const k = String(row.k || '').trim()
      const v = String(row.v == null ? '' : row.v).trim()
      if (!k || !v) continue
      out.push({ k, v })
    }
    return out
  }

  /** 可协商条件 / 交易流程：统一成字符串数组，兼容历史对象结构 */
  function textList(value) {
    if (!Array.isArray(value)) return []
    return value.map((item) => {
      if (item && typeof item === 'object') return String(item.n || item.t || item.name || '').trim()
      return String(item || '').trim()
    }).filter(Boolean).slice(0, 10)
  }

  function demandViewOf(demand, opts) {
    const o = opts || {}
    const rental = demand.tradeMode === TRADE_MODES.LEASE
    const budget = Number(demand.budget) || 0
    const claim = claimMetaOf(o)
    return {
      id: demand.id,
      type: 'demand',
      kind: rental ? '租赁' : '求购',
      cat: demand.cat || '',
      model: demand.model || '',
      title: demand.title || '',
      qty: Number(demand.qty) || 0,
      /* 浏览数与普通商品卡同一口径 */
      views: Number(demand.views) || 0,
      city: demand.city || '',
      price: budget,
      priceLabel: rental ? '租金预算' : '采购预算',
      priceText: budget > 0 ? `¥${moneyText(budget)} / 台${rental ? ' / 月' : ''}` : '面议',
      matched: o.matched === true,
      stockText: o.stockText || '',
      stockQty: Number(o.stockQty) || 0,
      /* 匹配说明：命中的型号 + 匹配依据（基于我的库存 / 我发布的需求） */
      matchModel: o.matchModel || '',
      matchVia: o.matchVia || '',
      matchText: o.matchText || '',
      claimed: o.claimed === true,
      /* 已领取但发布方已关闭 / 已下架：仍保留在「已领取」里供回看 */
      closed: o.closed === true,
      statusText: o.statusText || '',
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      org: o.org || '',
      /* 发布者主页跳转键：匿名主体也可打开主页，敏感字段由主页侧脱敏 */
      ownerKey: o.ownerKey || '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
      claimFull: claim.claimFull,
      claimText: claim.claimText,
      /* 用户标记「不满足」：仍留在列表里，但不计入可领取与角标提醒 */
      unsatisfied: o.unsatisfied === true,
      /* 领取后可逐项确认必须条件，再在平台内发起对话 */
      must: Array.isArray(demand.must) ? demand.must : [],
      /* 发布时上传的图片与视频：商机详情与普通发布详情一样正常展示 */
      media: Array.isArray(demand.media) ? demand.media.slice() : [],
      /* 发布者设定的全部信息：发布时填写的条件与要求逐项下发，详情页完整展示 */
      info: infoRows([
        { k: '品牌', v: demand.brand },
        { k: '成色要求', v: demand.cond },
        { k: '税费要求', v: joinText(demand.tax) },
        { k: '供给类型', v: demand.supply },
        { k: rental ? '期望租期' : '', v: rental ? joinText(demand.term) : '' },
        { k: rental ? '价格方式' : '', v: rental ? demand.closed : '' },
        { k: rental ? '押金接受度' : '', v: rental ? demand.deposit : '' },
        { k: rental ? '付款方式' : '', v: rental ? demand.pay : '' },
        { k: rental ? '租赁条款要求' : '', v: rental ? joinText(demand.rentLimits) : '' },
        { k: '验收要求', v: joinText(demand.accept) },
        { k: '其他说明', v: demand.note }
      ]),
      published: relTime(demand.createdAt, o.now || now()),
      /* 列表统一按发布时间倒序：越晚发布越靠前 */
      at: Number(demand.createdAt) || 0,
      /* 长期有效的商机不再展示「长期有效」字样，列表与详情都留空 */
      expireText: ''
    }
  }

  /**
   * 反向商机：别人在售的货源命中了我已发布的需求。
   * 与需求商机共用领取口径：不设名额，商机会员都可领取。
   */
  function supplyViewOf(product, opts) {
    const o = opts || {}
    const rental = product.tradeMode === TRADE_MODES.RENT
    const price = Number(product.price) || 0
    const claim = claimMetaOf(o)
    return {
      id: product.id,
      supplyId: product.id,
      type: 'supply',
      kind: rental ? '出租' : '出售',
      cat: product.cat || '',
      model: product.model || '',
      title: product.title || '',
      brand: product.brand || '',
      qty: Number(product.qty) || 0,
      /* 浏览数与普通商品卡同一口径 */
      views: Number(product.views) || 0,
      city: product.city || '',
      price,
      priceLabel: rental ? '月租金' : '出售单价',
      priceText: price > 0 ? `¥${moneyText(price)} / 台${rental ? ' / 月' : ''}` : '面议',
      matched: true,
      stockText: o.stockText || '',
      stockQty: Number(o.stockQty) || 0,
      demandText: o.demandText || '',
      /* 匹配说明：命中的型号 + 匹配依据（我发布的哪条需求 / 我的库存） */
      matchModel: o.matchModel || '',
      matchVia: o.matchVia || '',
      matchText: o.matchText || '',
      claimed: o.claimed === true,
      closed: o.closed === true,
      statusText: o.statusText || '',
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      org: o.org || '',
      /* 发布者主页跳转键：匿名主体也可打开主页，敏感字段由主页侧脱敏 */
      ownerKey: o.ownerKey || '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
      claimFull: claim.claimFull,
      claimText: claim.claimText,
      /* 用户标记「不满足」：仍留在列表里，但不计入可领取与角标提醒 */
      unsatisfied: o.unsatisfied === true,
      must: Array.isArray(product.must) ? product.must : [],
      /* 发布时上传的图片与视频：商机详情与普通发布详情一样正常展示 */
      media: Array.isArray(product.media) ? product.media.slice() : [],
      /* 可协商条件与交易流程：发布者选填，领取前即可看到 */
      nego: textList(product.nego),
      flow: textList(product.flow),
      /* 发布者设定的全部信息：发布时填写的条件与要求逐项下发，详情页完整展示 */
      info: infoRows([
        { k: '品牌', v: product.brand },
        { k: '成色', v: product.cond },
        { k: '税费', v: joinText(product.tax) },
        { k: '供给类型', v: product.supply },
        { k: rental ? '可起租时间' : '可交付时间', v: product.deliver },
        { k: '起订量', v: Number(product.minQty) > 0 ? `${Number(product.minQty)} 台` : '' },
        { k: rental ? '租期' : '', v: rental ? joinText(product.term) : '' },
        { k: rental ? '价格方式' : '', v: rental ? product.closed : '' },
        { k: rental ? '押金' : '', v: rental ? product.deposit : '' },
        { k: rental ? '租金支付' : '', v: rental ? product.pay : '' },
        { k: rental ? '租赁限制' : '', v: rental ? joinText(product.rentLimits) : '' },
        { k: '验收标准', v: joinText(product.accept) },
        { k: '接单要求', v: product.requirements },
        { k: '可承接数量', v: product.limit },
        { k: '交易说明', v: product.note }
      ]),
      published: relTime(product.createdAt, o.now || now()),
      /* 列表统一按发布时间倒序：越晚发布越靠前 */
      at: Number(product.createdAt) || 0,
      /* 长期有效的商机不再展示「长期有效」字样，列表与详情都留空 */
      expireText: ''
    }
  }

  /* 代采 / 代售的交易流程条件：发布者未单独设置时按默认三条逐项核对 */
  const AGENCY_MUST_DEFAULT = Object.freeze([
    '可按委托价格与数量成交',
    '可在截止时间前完成交付',
    '接受平台居中对接与订单核验'
  ])

  function agencyViewOf(doc, opts) {
    const o = opts || {}
    const claim = claimMetaOf(o)
    return {
      id: doc.id,
      agencyId: doc.id,
      type: 'agency',
      kind: doc.kind,
      /* 代采 / 代售与普通商品一致：型号、数量、金额直接展示，不做领取后可见 */
      side: doc.side === 'sell' ? 'sell' : 'buy',
      /* 浏览数与普通商品卡同一口径 */
      views: Number(doc.views) || 0,
      visibility: doc.visibility || (doc.side === 'buy' ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC),
      visibilityLabel: VISIBILITY_LABELS[doc.visibility || (doc.side === 'buy' ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC)],
      cat: doc.itemCat || '其他',
      model: doc.item || '',
      title: `${doc.kind} ${doc.item}`,
      qty: Number(doc.qty) || 0,
      city: doc.city || '',
      price: Number(doc.price) || 0,
      priceLabel: doc.side === 'buy' ? '代采预算' : '代售报价',
      priceText: `¥${moneyText(doc.price)} / 台${doc.rental ? ' / 月' : ''}`,
      feeText: doc.deferredFee
        ? `成交后收 0.5%（约 ¥${moneyText(effectiveServiceFee(doc))}）`
        : `服务费 ¥${moneyText(effectiveServiceFee(doc))}`,
      matched: o.matched === true,
      stockText: o.stockText || '',
      stockQty: Number(o.stockQty) || 0,
      /* 匹配说明：命中的型号 + 匹配依据（基于我的库存） */
      matchModel: o.matchModel || '',
      matchVia: o.matchVia || '',
      matchText: o.matchText || '',
      claimed: o.claimed === true,
      /* 用户标记「不满足」：仍留在列表里，但不计入可领取与角标提醒 */
      unsatisfied: o.unsatisfied === true,
      /* 交易流程条件：先逐项确认满足 / 不满足，再领取，领取后才可对接平台。
         条件本身属于通用流程约定（不含设备型号与金额），领取前保留，保证可以先确认再领取 */
      must: Array.isArray(doc.must) && doc.must.length ? doc.must : AGENCY_MUST_DEFAULT.slice(),
      /* 可协商条件与交易流程：发布者选填，领取前即可看到 */
      nego: textList(doc.nego),
      flow: textList(doc.flow),
      /* 发布者设定的全部信息：与普通商品详情一致，直接展示型号、数量与说明 */
      info: infoRows([
        { k: '设备品类', v: doc.itemCat },
        { k: '委托数量', v: Number(doc.qty) > 0 ? `${Number(doc.qty)} 台` : '' },
        { k: '租期', v: doc.rental ? joinText(doc.term) : '' },
        { k: '所在城市', v: doc.city },
        { k: '截止时间', v: doc.deadline },
        { k: '补充说明', v: doc.detail }
      ]),
      /* 营业执照 / 委托授权书 / 身份证等材料只供平台审核，商机池不下发，
         避免匹配会员通过材料反推出委托方企业信息 */
      media: [],
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      /* 代采 / 代售统一由平台对接：用户提交对接申请后生成客服工单 */
      canConsult: o.canConsult === true,
      consulted: o.consulted === true,
      consultText: o.consulted ? '已提交 · 待平台核实' : '联系平台',
      /* 代采 / 代售一律以平台身份对外，任何入口都不回传委托方主体信息 */
      org: o.org || '平台',
      /* 代采代售由平台对接，不提供委托方主页入口 */
      ownerKey: '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
      claimFull: claim.claimFull,
      claimText: claim.claimText,
      published: relTime(doc.confirmedAt || doc.createdAt, o.now || now()),
      /* 列表统一按发布时间倒序：越晚发布越靠前，代采代售以上架时间为发布口径 */
      at: Number(doc.confirmedAt || doc.createdAt) || 0,
      expireText: `剩余 ${Math.max(0, Math.ceil((Number(doc.expiresAt) - (o.now || now())) / DAY_MS))} 天`
    }
  }

  return {
    /** 代采 / 代售委托提交：服务费由服务端重算，客户端金额与二维码一律不信任 */
    'agency.submit': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      /* 代采 / 代售委托也属于对外发布：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid, user)
      const profile = (await repo.find('profiles', { uid }, { limit: 1 }))[0] || {}
      const exposure = profile.exposure || EXPOSURES.HIDDEN
      const at = now()
      /* 截止时间必填：到点仍未成交即自动终止，同时也是代采 / 代售合同期限 */
      const deadlineInfo = parseAgencyDeadline(data && data.deadline, at)
      const input = normalizeAgencyInput(data, exposure)

      /* 被驳回的委托：允许修改内容、重传材料后原地重新提交，重新进入审核队列 */
      let resubmit = null
      if (data && data.id) {
        const resubmitId = str(data.id, { field: '委托标识', required: true, max: 64 })
        const before = await repo.get('agencies', resubmitId)
        if (!before || before.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
        if (before.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能修改本人发布的委托')
        if (before.status !== AGENCY_STATUS.REJECTED) throw new AppError(CODES.CONFLICT, '仅被驳回的委托可重新提交')
        resubmit = before
      }

      const active = await repo.count('agencies', {
        ownerId: uid,
        status: { $in: AGENCY_OPEN_STATUSES },
        deleted: { $ne: true }
      })
      if (active >= AGENCY_ACTIVE_LIMIT) {
        throw new AppError(CODES.CONFLICT, `同时进行的委托最多 ${AGENCY_ACTIVE_LIMIT} 条，请先完成或关闭已有委托`)
      }

      const id = resubmit ? resubmit.id : randomId('AG')
      const ciphers = encryptFields({
        keys,
        collection: 'agencies',
        recordId: id,
        fields: {
          subject: input.subject,
          phone: input.phone,
          /* 授权书联系人电话也是联系方式，同样加密落库 */
          authPhone: input.authPhone,
          legal: input.legal,
          creditCode: input.creditCode,
          idCard: input.idCard
        }
      })
      const doc = Object.assign({
        id,
        ownerId: uid,
        side: input.side,
        kind: input.kind,
        mode: input.mode,
        rental: input.rental,
        term: input.term,
        item: input.item,
        itemCat: input.cat,
        qty: input.qty,
        price: input.price,
        amount: input.amount,
        /* 币种随委托落库：展示与账单按委托币种渲染，缺省时才回退人民币 */
        currency: input.currency,
        currencySymbol: input.currencySymbol,
        currencyLabel: input.currencyLabel,
        serviceFee: input.serviceFee,
        /* 后付费：发布 / 审核 / 上架均不收费，成交确认后生成服务费账单 */
        upfront: 0,
        payNow: 0,
        feeRule: input.feeRule,
        feeNote: '成交后支付',
        feeStatus: 'unbilled',
        feeDueAt: 0,
        feePaidAt: 0,
        feePaidBy: '',
        feeBillId: '',
        feeBilledAt: 0,
        paidClaimAt: 0,
        paidClaimCount: 0,
        paidClaimNote: '',
        /* 截止时间即合同期终点：到点仍未成交自动关闭 */
        deadline: deadlineInfo.deadline,
        deadlineAt: deadlineInfo.deadlineAt,
        dealProposedAt: 0,
        dealProposedBy: '',
        dealConfirmedAt: 0,
        deferredFee: input.deferredFee,
        largeAmount: input.largeAmount,
        visibility: input.visibility,
        exposure: input.exposure,
        channel: input.channel,
        bizPool: input.bizPool,
        authPhoneMatched: input.authPhoneMatched === true,
        materialVerified: false,
        detail: input.detail,
        flow: input.flow,
        must: input.must,
        nego: input.nego,
        city: input.city,
        subjectType: input.subjectType,
        subjectMasked: maskSubject(input.subject, input.subjectType),
        legalMasked: maskName(input.legal),
        creditMasked: maskCredit(input.creditCode),
        idCardMasked: maskIdCard(input.idCard),
        phoneMasked: maskPhone(input.phone),
        authPhoneMasked: maskPhone(input.authPhone),
        media: input.media,
        /* 代采 / 代售统一先过平台审核：审核通过即上架，不再要求缴费确认 */
        status: AGENCY_STATUS.REVIEW,
        reason: '',
        closeReason: '',
        reviewNote: '',
        staff: '',
        createdAt: at,
        updatedAt: at,
        approvedAt: 0,
        confirmedAt: 0,
        expiresAt: deadlineInfo.deadlineAt,
        closedAt: 0,
        deleted: false
      }, ciphers)
      if (resubmit) {
        const patch = Object.assign({}, doc)
        delete patch.id
        delete patch.ownerId
        delete patch.createdAt
        /* 发布页不维护城市与补充说明：本次未填时保留原值，避免重新提交把原信息清空 */
        patch.city = input.city || resubmit.city || ''
        patch.detail = input.detail || resubmit.detail || ''
        /* 重新提交：清掉上一轮修改痕迹，重新排队审核 */
        patch.editPending = false
        patch.pendingEdit = null
        patch.prevEdit = null
        patch.resubmittedAt = at
        const res = await repo.updateWhere('agencies', {
          id: resubmit.id,
          ownerId: uid,
          status: AGENCY_STATUS.REJECTED,
          deleted: { $ne: true }
        }, patch)
        if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
        const fresh = (await repo.get('agencies', resubmit.id)) || doc
        /* 重新提交同样生成审核工单，工作台继续跟进 */
        try {
          await ensureAgencyAuditTicket(repo, fresh, at, { note: '用户重新提交委托，等待审核' })
        } catch (err) {
          console.error('[agency] 审核工单生成失败：' + (err && err.message))
        }
        return Object.assign(agencyOwnerView(fresh, at), {
          payAmount: 0,
          deferredFee: input.deferredFee,
          needReview: true,
          resubmitted: true
        })
      }

      await repo.insert('agencies', doc)
      /* 并发兜底：多个请求同时通过前置计数时，插入后复核进行中数量，超出的这次回滚 */
      const activeAfter = await repo.count('agencies', {
        ownerId: uid,
        status: { $in: AGENCY_OPEN_STATUSES },
        deleted: { $ne: true }
      })
      if (activeAfter > AGENCY_ACTIVE_LIMIT) {
        await repo.removeWhere('agencies', { id, ownerId: uid, status: AGENCY_STATUS.REVIEW })
        throw new AppError(CODES.CONFLICT, `同时进行的委托最多 ${AGENCY_ACTIVE_LIMIT} 条，请先完成或关闭已有委托`)
      }
      /* 通过审核前的委托统一在工作台生成审核工单，由客服领取处理 */
      try {
        await ensureAgencyAuditTicket(repo, doc, at)
      } catch (err) {
        console.error('[agency] 审核工单生成失败：' + (err && err.message))
      }
      return Object.assign(agencyOwnerView(doc, at), {
        payAmount: 0,
        deferredFee: input.deferredFee,
        needReview: true,
        payHint: agencyOwnerView(doc, at).payHint
      })
    },

    /**
     * 已上架委托修改：委托方不能直接改已发布内容。
     * 提交后委托立即转为「待审核」（对外下架），平台审核通过才覆盖原内容并重新上架；
     * 驳回则恢复原上架内容，避免误操作导致长期不可见。
     */
    'agency.update': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const before = await repo.get('agencies', id)
      if (!before || before.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (before.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能修改本人发布的委托')
      if (before.status !== AGENCY_STATUS.ACTIVE || before.editPending === true) {
        throw new AppError(CODES.CONFLICT, '仅已上架的委托可提交修改，且同一时间只能有一笔修改待审核')
      }
      const item = str(data.item, { field: '设备名称', required: true, min: 2, max: 60 })
      const qty = Number(data.qty)
      if (!Number.isInteger(qty) || qty < 1 || qty > 9999) {
        throw new AppError(CODES.VALIDATION, '数量需为 1 - 9999 的整数')
      }
      const price = Number(data.price)
      if (!Number.isFinite(price) || price < 0 || price > 99999999) {
        throw new AppError(CODES.VALIDATION, '价格需为 0 - 99999999 之间的数字')
      }
      const city = str(data.city, { field: '所在地', max: 20 })
      const detail = str(data.detail, { field: '详细说明', max: 2000 })
      const flow = arrayOfStrings(data.flow, { field: '交易流程', max: 8, itemMax: 40 })
      const must = arrayOfStrings(data.must, { field: '必备条件', max: 8, itemMax: 40 })
      const nego = arrayOfStrings(data.nego, { field: '可协商项', max: 8, itemMax: 40 })
      const pendingEdit = { item, qty, price, city, detail, flow, must, nego }
      const prevEdit = {
        item: before.item || '',
        qty: Number(before.qty) || 0,
        price: Number(before.price) || 0,
        city: before.city || '',
        detail: before.detail || '',
        flow: before.flow || [],
        must: before.must || [],
        nego: before.nego || []
      }
      const at = now()
      const res = await repo.updateWhere('agencies', {
        id,
        ownerId: uid,
        status: AGENCY_STATUS.ACTIVE,
        deleted: { $ne: true }
      }, {
        status: AGENCY_STATUS.REVIEW,
        editPending: true,
        pendingEdit,
        prevEdit,
        reason: '',
        reviewNote: '',
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      const doc = await repo.get('agencies', id)
      /* 修改单同样需要审核，在工作台生成 / 重置审核工单 */
      try {
        await ensureAgencyAuditTicket(repo, doc, at, { note: '用户提交委托修改，等待审核' })
      } catch (err) {
        console.error('[agency] 审核工单生成失败：' + (err && err.message))
      }
      return agencyOwnerView(doc, at)
    },

    /** 我的委托单：列表只展示商品信息；流程节点与处理人由详情接口返回 */
    'agency.mine': async (data, ctx) => {
      const uid = ctx.openid
      const page = normalizePaging(data)
      const at = now()
      const rows = await repo.find('agencies', { ownerId: uid, deleted: { $ne: true } }, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const items = []
      for (const row of rows) {
        /* 读取前惰性到期：过截止时间仍未成交的委托直接关闭 */
        items.push(agencyOwnerView(await expireAgencyIfNeeded(repo, row, at), at))
      }
      return {
        items,
        page: page.page,
        limit: page.limit
      }
    },

    /** 本人委托详情：供「重新编辑上传」回填，含解密后的主体与联系人信息，仅本人可见 */
    'agency.detail': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const loaded = await repo.get('agencies', id)
      if (!loaded || loaded.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (loaded.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看自己的委托')
      const doc = await expireAgencyIfNeeded(repo, loaded, at)
      const plain = (field, cipher) => {
        try {
          return decryptFieldOf({ keys, collection: 'agencies', field, recordId: id, cipher })
        } catch (e) {
          return ''
        }
      }
      const subject = plain('subject', doc.subjectCipher)
      const phone = plain('phone', doc.phoneCipher)
      return Object.assign(agencyOwnerView(doc, at), {
        mode: doc.mode || '',
        rental: doc.rental === true,
        term: doc.term || '',
        item: doc.item || '',
        cat: doc.itemCat || doc.cat || '',
        qty: Number(doc.qty) || 0,
        price: Number(doc.price) || 0,
        currency: doc.currency || DEFAULT_CURRENCY,
        city: doc.city || '',
        detail: doc.detail || '',
        subjectType: doc.subjectType === '企业' ? 'company' : 'person',
        subject,
        phone,
        legal: plain('legal', doc.legalCipher),
        creditCode: plain('creditCode', doc.creditCodeCipher),
        idCard: plain('idCard', doc.idCardCipher),
        /* 授权书联系人电话：新数据加密落库后直接解密回填；历史数据仍按一致标记回填预留号 */
        authPhone: plain('authPhone', doc.authPhoneCipher) || (doc.authPhoneMatched === true ? phone : '')
      })
    },

    /** 我的缴费单：本人可见的收款登记与到账结果，财务确认后同步回显 */
    'payment.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const page = normalizePaging(data)
      const rows = await repo.find('payments', { uid }, {
        sort: { field: 'paidAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const total = await repo.count('payments', { uid })
      return {
        items: rows.map((row) => ({
          id: row.id,
          bizType: row.bizType || '其他',
          planKey: row.planKey || '',
          planLabel: row.planLabel || '',
          days: Number(row.days) || 0,
          amount: Number(row.amount) || 0,
          received: Number(row.received) || 0,
          method: row.method || '',
          status: row.status,
          paidAt: Number(row.paidAt) || 0,
          confirmedAt: Number(row.confirmedAt) || 0,
          orderId: row.orderId || '',
          note: row.note || '',
          createdAt: Number(row.createdAt) || 0
        })),
        total,
        page: page.page,
        limit: page.limit,
        statusList: PAYMENT_STATUS_LIST
      }
    },

    /**
     * 用户申请退款：只能对本人「已确认」的收款单发起，同一单同时只允许一条待处理申请。
     * 平台财务核对后通过 / 驳回，结论都会回写站内信。
     */
    'refund.apply': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const paymentId = str(data.paymentId, { field: '收款单', required: true, max: 64 })
      const reason = str(data.reason, { field: '退款原因', required: true, min: 5, max: 200 })
      const row = await repo.get('payments', paymentId)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      if (row.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能对本人缴费申请退款')
      if (row.status === PAYMENT_STATUS.REFUNDED) throw new AppError(CODES.CONFLICT, '该收款单已退款')
      if (row.status !== PAYMENT_STATUS.CONFIRMED) throw new AppError(CODES.CONFLICT, '只有已确认到账的缴费可以申请退款')
      const exists = await repo.find('refundRequests', { paymentId, uid }, { limit: 5 })
      if (exists.some((item) => item.status === REFUND_STATUS.PENDING)) {
        throw new AppError(CODES.CONFLICT, '该缴费已有退款申请在处理中，请勿重复提交')
      }
      const at = now()
      const doc = {
        id: randomId('RF'),
        paymentId,
        uid,
        bizType: row.bizType || '其他',
        amount: Number(row.received) || Number(row.amount) || 0,
        reason,
        status: REFUND_STATUS.PENDING,
        handlerNote: '',
        handledAt: 0,
        handledBy: '',
        createdAt: at,
        updatedAt: at
      }
      await repo.insert('refundRequests', doc)
      return { id: doc.id, status: doc.status, amount: doc.amount, createdAt: at }
    },

    /** 我的退款申请：展示进度与平台结论 */
    'refund.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const page = normalizePaging(data)
      const rows = await repo.find('refundRequests', { uid }, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const total = await repo.count('refundRequests', { uid })
      return {
        items: rows.map((row) => ({
          id: row.id,
          paymentId: row.paymentId,
          bizType: row.bizType,
          amount: Number(row.amount) || 0,
          reason: row.reason || '',
          status: row.status,
          handlerNote: row.handlerNote || '',
          createdAt: Number(row.createdAt) || 0,
          handledAt: Number(row.handledAt) || 0
        })),
        total,
        page: page.page,
        limit: page.limit,
        statusList: Object.values(REFUND_STATUS)
      }
    },

    /** 撤回本人待处理的退款申请 */
    'refund.cancel': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '退款申请', required: true, max: 64 })
      const doc = await repo.get('refundRequests', id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '退款申请不存在')
      if (doc.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能撤回本人的申请')
      if (doc.status !== REFUND_STATUS.PENDING) throw new AppError(CODES.CONFLICT, '该申请已处理，无法撤回')
      const at = now()
      await repo.updateWhere('refundRequests', { id }, { status: REFUND_STATUS.CANCELLED, updatedAt: at })
      return { id, status: REFUND_STATUS.CANCELLED }
    },

    /**
     * 用户点「我已支付」：只登记付款时间信号，不直接把账单改为已到账。
     * 到账仍以财务核对流水后确认收款单为准；成交后的服务费以本次上报时间计算
     * 3 个工作日应到账日（未上报时用成交确认时间）。
     */
    'agency.paid': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能操作自己的委托')
      const claimable = [
        AGENCY_STATUS.PENDING,
        AGENCY_STATUS.APPROVED,
        AGENCY_STATUS.ACTIVE,
        AGENCY_STATUS.DEAL_PENDING,
        AGENCY_STATUS.DEALT,
        AGENCY_STATUS.DONE
      ]
      if (claimable.indexOf(doc.status) < 0) {
        throw new AppError(CODES.CONFLICT, '当前状态无需上报付款，请刷新后查看')
      }
      const at = now()
      const count = Number(doc.paidClaimCount) || 0
      const note = str(data.note, { field: '付款备注', max: 100 }) || ''
      const patch = {
        paidClaimAt: at,
        paidClaimCount: count + 1,
        paidClaimNote: note,
        updatedAt: at
      }
      await repo.updateWhere('agencies', { id, ownerId: uid }, patch)
      /* 已成交的委托：上报付款时补生成服务费账单，并按本次时间计算应到账日 */
      let fresh = await repo.get('agencies', id)
      if (fresh && (fresh.status === AGENCY_STATUS.DEALT || fresh.status === AGENCY_STATUS.DONE) && fresh.feeStatus !== 'paid') {
        fresh = await ensureAgencyFeeBill(repo, fresh, at, at)
      }
      return {
        id,
        paidClaimAt: at,
        paidClaimCount: count + 1,
        paidClaimText: dateText(at) + ' 已上报付款',
        feeStatus: (fresh && fresh.feeStatus) || 'unbilled',
        feeDueAt: Number(fresh && fresh.feeDueAt) || 0,
        hint: fresh && fresh.feeDueAt
          ? `服务费应于 ${dateText(fresh.feeDueAt)} 前到账，财务核对后确认`
          : '平台财务核对到账后会确认收款，请留意通知'
      }
    },

    /** 用户撤销：仅「待确认（未缴费）」可自助撤销；已上架需联系客服关闭 */
    'agency.cancel': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能操作自己的委托')
      const reason = str(data.reason, { field: '撤销原因', max: 100 }) || '用户主动撤销'
      const res = await repo.updateWhere('agencies', {
        id,
        ownerId: uid,
        status: { $in: [AGENCY_STATUS.PENDING, AGENCY_STATUS.REVIEW] }
      }, {
        status: AGENCY_STATUS.CLOSED,
        reason,
        closedAt: at,
        closedBy: uid,
        updatedAt: at
      })
      if (!res || !res.count) {
        throw new AppError(CODES.CONFLICT, doc.status === AGENCY_STATUS.ACTIVE
          ? '委托已上架，如需停止请联系客服关闭'
          : (doc.status === AGENCY_STATUS.APPROVED
            ? '委托审核已通过并进入平台发布，如需停止请联系客服'
            : '该委托已结束，无需重复撤销'))
      }
      appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'agency.cancel',
        target: id,
        reason,
        result: 'allow',
        at
      })
      const fresh = await repo.get('agencies', id)
      return agencyOwnerView(fresh || doc, at)
    },

    /** 删除委托：仅被驳回的委托可由本人删除（软删除，保留审计痕迹） */
    'agency.delete': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己的委托')
      if (doc.status !== AGENCY_STATUS.REJECTED) throw new AppError(CODES.CONFLICT, '仅被驳回的委托可删除')
      const res = await repo.updateWhere('agencies', {
        id,
        ownerId: uid,
        status: AGENCY_STATUS.REJECTED,
        deleted: { $ne: true }
      }, {
        deleted: true,
        deletedAt: at,
        closedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'agency.delete',
        target: id,
        reason: '删除被驳回的委托',
        result: 'allow',
        at
      })
      return { id, deleted: true }
    },

    /**
     * 委托方上传服务费打款凭证：线下打款后自行上传，财务在收款单里核对确认。
     * 只登记凭证，不改变工单阶段（到账以财务确认为准）。
     */
    'agency.payProof': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能操作自己的委托')
      const billId = doc.feeBillId || `PY_AG_${doc.id}`
      const bill = await repo.get('payments', billId)
      if (!bill) throw new AppError(CODES.CONFLICT, '服务费账单尚未生成，请先确认成交')
      if (bill.status === PAYMENT_STATUS.REFUNDED) throw new AppError(CODES.CONFLICT, '该账单已退款，无需上传凭证')
      const incoming = (Array.isArray(data.files) ? data.files : []).map((item) => fileRef(item)).filter(Boolean)
      if (!incoming.length) throw new AppError(CODES.VALIDATION, '请上传打款凭证')
      const existing = Array.isArray(bill.proofFiles) ? bill.proofFiles.slice() : []
      const files = existing.concat(incoming.filter((item) => existing.indexOf(item) < 0))
      if (files.length > 5) throw new AppError(CODES.VALIDATION, '打款凭证最多上传 5 个')
      const res = await repo.updateWhere('payments', { id: billId, status: bill.status }, {
        proofFiles: files,
        proofNote: str(data.note, { field: '备注', max: 200 }),
        proofAt: at,
        proofBy: uid,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '账单状态已变化，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'agency.payProof',
        target: billId,
        reason: `上传打款凭证 ${incoming.length} 个`,
        result: 'allow',
        at
      })
      return { id, billId, files, proofAt: at }
    },

    /**
     * 咨询进度：委托方在小程序「我的委托」查看客服标准流程走到哪一步。
     * 只返回阶段、时间线与可执行动作，不暴露客服内部备注与双方联系方式。
     */
    'consult.progress': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id || data.agencyId, { field: '委托标识', required: true, max: 64 })
      const agency = await repo.get('agencies', id)
      if (!agency || agency.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (agency.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看自己的委托')
      const lead = await consultLeadOfAgency(repo, id)
      if (!lead) {
        return { agencyId: id, started: false, stage: '', stageLabel: '', timeline: [], actions: [] }
      }
      const ticketState = ticketStateOf(lead)
      /* 工单还没被客服领取：委托方只知道「客服即将接入」，不暴露尚未开始的流程 */
      if (!lead.assignedAccount || ticketState !== TICKET_STATE.TICKETED) {
        return {
          agencyId: id,
          leadId: lead.id,
          started: false,
          ticketState,
          pending: ticketState === TICKET_STATE.INTAKE || ticketState === TICKET_STATE.CONSULTING,
          pendingLabel: ticketState === TICKET_STATE.CONSULTING ? '客服正在与你确认委托条件' : '客服即将接入',
          stage: '',
          stageLabel: '',
          timeline: [],
          actions: []
        }
      }
      const stage = consultStageOf(lead)
      const rows = await repo.find('agencyContracts', { leadId: lead.id }, { limit: 1 })
      const contract = rows[0] || null
      const bill = await repo.get('payments', agency.feeBillId || `PY_AG_${agency.id}`)
      const actions = []
      /* 成交由平台确认，委托方只需要在服务费待支付时上传打款凭证 */
      if (stage === CONSULT_STAGE.FEE) actions.push('payProof')
      return {
        agencyId: id,
        leadId: lead.id,
        started: true,
        stage,
        stageLabel: consultStageLabel(stage),
        stageAt: Number(lead.stageAt) || 0,
        csName: lead.csName || lead.assignedTo || '',
        dealAmount: Number(lead.dealAmount) || 0,
        timeline: (Array.isArray(lead.stageHistory) ? lead.stageHistory : []).map((item) => ({
          stage: item.stage,
          stageLabel: consultStageLabel(item.stage),
          at: Number(item.at) || 0,
          note: String(item.note || '')
        })),
        contract: contract ? {
          id: contract.id,
          contractNo: contract.contractNo || '',
          status: contract.status,
          signedAt: Number(contract.signedAt) || 0,
          fileCount: Array.isArray(contract.files) && contract.files.length ? contract.files.length : (contract.fileId ? 1 : 0)
        } : null,
        fee: bill ? {
          billId: bill.id,
          amount: Number(bill.amount) || 0,
          received: Number(bill.received) || 0,
          status: bill.status,
          dueAt: Number(bill.dueAt) || 0,
          paidAt: Number(bill.confirmedAt) || 0,
          proofCount: Array.isArray(bill.proofFiles) ? bill.proofFiles.length : (bill.proofFileId ? 1 : 0)
        } : null,
        actions
      }
    },

    /**
     * 居间合同文件：合同归档后委托方可查看扫描件（临时链接，5 分钟）。
     * 只允许委托方本人，且每次取用留审计。
     */
    'consult.contractFile': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id || data.agencyId, { field: '委托标识', required: true, max: 64 })
      const agency = await repo.get('agencies', id)
      if (!agency || agency.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (agency.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看自己的委托')
      const lead = await consultLeadOfAgency(repo, id)
      if (!lead) throw new AppError(CODES.NOT_FOUND, '该委托没有居间合同')
      const rows = await repo.find('agencyContracts', { leadId: lead.id }, { limit: 1 })
      const contract = rows[0]
      const raw = (contract && Array.isArray(contract.files) && contract.files.length)
        ? contract.files
        : (contract && contract.fileId ? [{ fileId: contract.fileId, name: contract.fileName }] : [])
      const files = raw
        .map((item) => ({ fileId: fileRef(item && (item.fileId || item.id)), name: String((item && item.name) || '') }))
        .filter((item) => item.fileId)
      if (!files.length) throw new AppError(CODES.NOT_FOUND, '合同文件尚未上传')
      if (contract.status !== '已归档') throw new AppError(CODES.CONFLICT, '合同尚未归档，暂不可查看')
      await appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'consult.contractFile',
        target: `${lead.id}:${contract.id}`,
        reason: `查看居间合同 ${files.length} 个文件`,
        result: 'allow',
        at: now()
      })
      const urls = {}
      for (const file of files) {
        if (/^https:\/\//i.test(file.fileId)) { urls[file.fileId] = file.fileId; continue }
        if (!cloud || typeof cloud.getTempFileURL !== 'function') continue
        try {
          const res = await cloud.getTempFileURL({ fileList: [file.fileId] })
          const first = ((res && res.fileList) || [])[0]
          if (first && first.tempFileURL) urls[file.fileId] = first.tempFileURL
        } catch (err) { /* 换链失败：前端展示「稍后重试」占位 */ }
      }
      return {
        agencyId: id,
        contractId: contract.id,
        contractNo: contract.contractNo || '',
        signedAt: Number(contract.signedAt) || 0,
        status: contract.status,
        files,
        urls
      }
    },

    /** 现货盘：平台在售商品 + 有效求购需求 + 24h 内有效报价，脱敏聚合；代采 / 代售只在商机池展示 */
    'agency.board': async (data) => {
      const at = now()
      const limit = Math.min(50, Math.max(1, Number(data.limit) || 30))
      /* 私密发布＝匿名公开：商品照常计入货盘，脱敏聚合不暴露发布者 */
      const products = await repo.find('products', {
        status: '在售',
        channel: { $ne: PUBLISH_CHANNELS.POOL },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 300 })
      /* 买方盘口只取「求购中」的整机需求，不返回需求明细与求购方身份 */
      const demands = await repo.find('demands', {
        status: DEMAND_STATUS.OPEN,
        tradeMode: TRADE_MODES.BUY,
        channel: { $ne: PUBLISH_CHANNELS.POOL },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 300 })
      const quotes = await repo.find('quotes', {
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 })
      return { items: boardItems({ products, agencies: [], demands, quotes, now: at, limit }), updatedAt: at }
    },

    /** 粘贴报价：只落结构化条目，原始长文本不落库（避免夹带联系方式） */
    'quote.paste': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const items = Array.isArray(data.items) ? data.items : []
      if (!items.length) throw new AppError(CODES.VALIDATION, '未识别到可预览的报价行')
      if (items.length > 20) throw new AppError(CODES.VALIDATION, '一次最多提交 20 条报价')
      const parsed = items.map((item) => {
        const src = item || {}
        const model = str(src.model, { field: '型号', required: true, min: 2, max: 60 })
        assertNoContactInText(model, '型号')
        /* 品类 / 城市同样会公开展示在现货盘，必须过联系方式检测 */
        const cat = str(src.cat, { field: '品类', max: 20, default: '其他' })
        assertNoContactInText(cat, '品类')
        const city = str(src.city, { field: '城市', max: 20 })
        assertNoContactInText(city, '城市')
        const price = Number(src.price)
        /* 0 价会让货盘出现「0 元假盘口」，并直接影响买卖价差，必须要求明确报价 */
        if (!Number.isFinite(price) || price <= 0 || price > 999999999) {
          throw new AppError(CODES.VALIDATION, '未识别到报价，请补充价格（1 - 999999999 的数字）')
        }
        return {
          cat,
          model,
          price: Math.round(price),
          city,
          qty: Math.max(0, Math.min(100000, Math.floor(Number(src.qty) || 1)))
        }
      })
      const at = now()
      const doc = {
        id: randomId('QT'),
        ownerId: uid,
        items: parsed,
        itemCount: parsed.length,
        createdAt: at,
        expiresAt: at + DAY_MS,
        deleted: false
      }
      await repo.insert('quotes', doc)
      return {
        id: doc.id,
        itemCount: parsed.length,
        expireText: `${dateText(doc.expiresAt)} 失效`,
        items: parsed.map((item) => ({
          cat: item.cat,
          model: item.model,
          price: item.price,
          priceText: item.price > 0 ? `¥${moneyText(item.price)}` : '面议',
          city: item.city
        }))
      }
    },

    /** 资讯列表：官方 + 已通过的用户投稿；精选 = 官方 */
    'news.list': async (data, ctx) => {
      const at = now()
      /* 评论关闭时不查也不下发任何评论数据 */
      const commentOn = await commentsEnabled()
      const scope = enumOf(data.scope || 'all', ['all', 'city', 'pick'], '资讯范围')
      const query = { status: NEWS_STATUS.PUBLISHED, deleted: { $ne: true } }
      if (scope === 'pick') query.official = true
      if (scope === 'city') {
        const city = str(data.city, { field: '城市', max: 20 })
        if (!city) return { items: [], scope, city: '', commentEnabled: commentOn }
        query.city = city
      }
      const rows = await repo.find('news', query, {
        sort: { field: 'publishedAt', dir: 'desc' },
        limit: 50
      })
      /* 拉黑：拉黑者看不到被拉黑者发布的资讯（官方资讯 uid 为空，不受影响） */
      const uid = ctx && ctx.openid
      const blockedAuthors = await blockedPeerIds(repo, uid)
      const visibleRows = blockedAuthors.size
        ? rows.filter((row) => !blockedAuthors.has(String(row.uid || '')))
        : rows
      /* 朋友圈式信息流：列表直接带点赞 / 评论数与「我是否已赞」，卡片上不用再单独请求 */
      const ids = visibleRows.map((row) => row.id)
      let likeRows = []
      let commentRows = []
      let mineLikes = []
      if (ids.length) {
        const [likes, comments, mine] = await Promise.all([
          repo.find('newsLikes', { newsId: { $in: ids }, deleted: { $ne: true } }, { limit: 5000 }),
          commentOn
            ? repo.find('newsComments', { newsId: { $in: ids }, deleted: { $ne: true } }, { limit: 5000 })
            : Promise.resolve([]),
          uid
            ? repo.find('newsLikes', { uid, newsId: { $in: ids }, deleted: { $ne: true } }, { limit: 200 })
            : Promise.resolve([])
        ])
        likeRows = likes
        commentRows = comments
        mineLikes = mine
      }
      const likeCount = {}
      const commentCount = {}
      const likedMap = {}
      likeRows.forEach((row) => { likeCount[row.newsId] = (likeCount[row.newsId] || 0) + 1 })
      commentRows.forEach((row) => { commentCount[row.newsId] = (commentCount[row.newsId] || 0) + 1 })
      mineLikes.forEach((row) => { likedMap[row.newsId] = true })
      return {
        items: visibleRows.map((row) => Object.assign(newsView(row), {
          published: relTime(row.publishedAt || row.createdAt, at),
          likes: likeCount[row.id] || 0,
          liked: likedMap[row.id] === true,
          commentCount: commentOn ? (commentCount[row.id] || 0) : 0,
          /* 作者主页入口：与 news.detail / owner.home 同口径；私密与官方资讯不下发 */
          authorKey: row.visibility === VISIBILITIES.PRIVATE || row.official === true || !row.uid ? '' : authorKeyOf(row.uid)
        })),
        scope,
        commentEnabled: commentOn
      }
    },

    /** 用户投稿：不做人工审核，提交时自动筛查违禁词，通过即发布；正文不得夹带联系方式 */
    'news.submit': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      /* 资讯投稿受限期间直接拦截，阅读与其他功能不受影响 */
      assertAllowed(user, 'news')
      const input = normalizeNewsInput(data, false)
      /* 基础筛查：命中暴力 / 色情 / 赌博 / 诈骗等违禁词直接驳回，不落库、不进人工队列 */
      const hit = findBannedWord(`${input.title} ${input.content}`)
      if (hit) {
        throw new AppError(CODES.VALIDATION, `内容含违禁词「${hit}」，已自动驳回，请修改后重新发布`)
      }
      const at = now()
      const id = randomId('NW')
      const doc = {
        id,
        uid,
        official: false,
        cat: NEWS_USER_CAT,
        visibility: input.visibility,
        title: input.title,
        summary: input.summary,
        content: input.content,
        media: input.media,
        city: input.city,
        author: maskName(user.nick || '用户'),
        status: NEWS_STATUS.PUBLISHED,
        reason: '',
        views: 0,
        createdAt: at,
        updatedAt: at,
        publishedAt: at,
        reviewedBy: 'system',
        deleted: false
      }
      await repo.insert('news', doc)
      return { id, status: NEWS_STATUS.PUBLISHED, statusText: '发布成功，已在资讯圈展示' }
    },

    /** 我的投稿：投稿后随时能查到审核状态与意见，不会「投了就没有下文」 */
    'news.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const rows = await repo.find('news', { uid, deleted: { $ne: true } }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 50
      })
      return {
        items: rows.map((row) => ({
          id: row.id,
          title: row.title,
          summary: row.summary || '',
          city: row.city || '',
          status: row.status,
          reason: row.reason || '',
          /* 自己的投稿如实返回可见范围，便于区分公开 / 保密 */
          visibility: row.visibility === VISIBILITIES.PRIVATE ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC,
          visibilityLabel: VISIBILITY_LABELS[row.visibility === VISIBILITIES.PRIVATE ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC],
          private: row.visibility === VISIBILITIES.PRIVATE,
          views: Number(row.views) || 0,
          createdAt: Number(row.createdAt) || 0,
          createdText: dateText(row.createdAt),
          publishedText: row.publishedAt ? dateText(row.publishedAt) : ''
        }))
      }
    },

    /** 资讯详情：列表只给标题与开头，正文在这里返回；打开一次浏览量 +1 */
    'news.detail': async (data, ctx) => {
      const id = str(data.id || data.newsId, { field: '资讯', required: true, max: 64 })
      const row = await repo.get('news', id)
      if (!row || row.deleted === true || row.status !== NEWS_STATUS.PUBLISHED) {
        throw new AppError(CODES.NOT_FOUND, '资讯不存在或已下架')
      }
      const at = now()
      const uid = ctx && ctx.openid
      /* 拉黑：拉黑者打开被拉黑者的资讯按不存在处理 */
      if (uid && row.uid && await isBlocked(repo, uid, row.uid)) {
        throw new AppError(CODES.NOT_FOUND, '资讯不存在或已下架')
      }
      /* 真实浏览量：作者本人浏览不计数；同一用户 30 分钟内重复打开只计一次，
         保证列表与详情展示的是同一个计数（不会再出现每次打开都 +1 的假增长） */
      let views = Number(row.views) || 0
      if (row.uid !== uid) {
        try {
          const bucket = windowStartOf(at, VIEW_DEDUPE_MS)
          const hit = await repo.incrCounter(`view:news:${id}:${uid || 'anon'}:${bucket}`, bucket)
          if (hit === 1) {
            views += 1
            await repo.updateWhere('news', { id }, { views })
            /* 资讯列表缓存全站共享（30 秒），浏览量变化后立即失效，
               否则返回列表时仍会读到旧计数，与详情差 1 */
            if (cacheLayer && typeof cacheLayer.bump === 'function') {
              await cacheLayer.bump('news')
            }
          }
        } catch (viewErr) {
          /* 浏览量只用于展示，写入失败不影响阅读 */
        }
      }
      const like = uid ? await repo.get('newsLikes', newsLikeId(uid, id)) : null
      const liked = !!(like && like.deleted !== true)
      /* 评论关闭时计数固定为 0，客户端也不再显示任何评论入口 */
      const commentOn = await commentsEnabled()
      const [likes, commentCount] = await Promise.all([
        repo.count('newsLikes', { newsId: id, deleted: { $ne: true } }),
        commentOn ? repo.count('newsComments', { newsId: id, deleted: { $ne: true } }) : Promise.resolve(0)
      ])
      const isPrivate = row.visibility === VISIBILITIES.PRIVATE
      return Object.assign(newsView(Object.assign({}, row, { views }), at), {
        content: row.content || '',
        publishedText: dateText(row.publishedAt || row.createdAt),
        /* 官方资讯没有作者主页；私密资讯匿名；用户投稿返回与 owner.home 同口径的作者键 */
        authorKey: isPrivate || row.official === true || !row.uid ? '' : authorKeyOf(row.uid),
        likes,
        liked,
        commentCount,
        commentEnabled: commentOn
      })
    },

    /** 资讯点赞：幂等切换，返回最新点赞数 */
    'news.like': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const newsId = str(data.id || data.newsId, { field: '资讯', required: true, max: 64 })
      const row = await repo.get('news', newsId)
      if (!row || row.deleted === true || row.status !== NEWS_STATUS.PUBLISHED) {
        throw new AppError(CODES.NOT_FOUND, '资讯已失效')
      }
      const at = now()
      const id = newsLikeId(uid, newsId)
      const existing = await repo.get('newsLikes', id)
      const desired = typeof data.on === 'boolean' ? data.on : !(existing && existing.deleted !== true)
      if (existing) {
        if (existing.uid !== uid) throw new AppError(CODES.FORBIDDEN, '无权修改该点赞')
        await repo.updateWhere('newsLikes', { id, uid }, { deleted: !desired, updatedAt: at })
      } else if (desired) {
        await repo.insert('newsLikes', {
          id, newsId, uid, createdAt: at, updatedAt: at, deleted: false
        })
      }
      const likes = await repo.count('newsLikes', { newsId, deleted: { $ne: true } })
      return { id: newsId, liked: desired, likes }
    },

    /** 评论列表：一级评论 + 每个一级评论下的回复（只展开一层，回复按时间正序） */
    'news.comment.list': async (data, ctx) => {
      const newsId = str(data.id || data.newsId, { field: '资讯', required: true, max: 64 })
      /* 已下架 / 未发布的资讯不开放评论读取 */
      const news = await repo.get('news', newsId)
      if (!news || news.deleted === true || news.status !== NEWS_STATUS.PUBLISHED) {
        throw new AppError(CODES.NOT_FOUND, '资讯不存在或已下架')
      }
      const page = Math.max(1, Number(data.page) || 1)
      const limit = Math.min(50, Math.max(1, Number(data.limit) || 20))
      const at = now()
      const uid = ctx && ctx.openid
      /* 评论关闭：列表一律空返回，不暴露任何历史评论 */
      const commentOn = await commentsEnabled()
      if (!commentOn) return { items: [], total: 0, page, hasMore: false, enabled: false }
      const roots = await repo.find('newsComments', {
        newsId,
        parentId: '',
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, skip: (page - 1) * limit, limit })
      const ids = roots.map((row) => row.id)
      const replies = ids.length
        ? await repo.find('newsComments', {
          newsId,
          rootId: { $in: ids },
          parentId: { $ne: '' },
          deleted: { $ne: true }
        }, { sort: { field: 'createdAt', dir: 'asc' }, limit: 300 })
        : []
      const byRoot = {}
      replies.forEach((row) => {
        byRoot[row.rootId] = byRoot[row.rootId] || []
        byRoot[row.rootId].push(newsCommentView(row, uid, at))
      })
      const total = await repo.count('newsComments', { newsId, deleted: { $ne: true } })
      return {
        items: roots.map((row) => Object.assign(newsCommentView(row, uid, at), {
          replies: byRoot[row.id] || []
        })),
        total,
        page,
        hasMore: page * limit < total
      }
    },

    /** 发表评论 / 回复：内容过滤敏感联系方式后落库，回复只允许挂在同一篇资讯下 */
    'news.comment.add': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      /* 评论关闭：直接拒绝，客户端本就不展示入口 */
      if (!(await commentsEnabled())) throw new AppError(CODES.FORBIDDEN, '评论功能已关闭')
      const newsId = str(data.id || data.newsId, { field: '资讯', required: true, max: 64 })
      const content = maskSensitiveText(str(data.content, {
        field: '评论内容', required: true, min: 1, max: NEWS_COMMENT_MAX
      }))
      const news = await repo.get('news', newsId)
      if (!news || news.deleted === true || news.status !== NEWS_STATUS.PUBLISHED) {
        throw new AppError(CODES.NOT_FOUND, '资讯已失效，无法评论')
      }
      const parentId = str(data.parentId, { field: '回复对象', max: 64 })
      let parent = null
      if (parentId) {
        parent = await repo.get('newsComments', parentId)
        if (!parent || parent.deleted === true || parent.newsId !== newsId) {
          throw new AppError(CODES.NOT_FOUND, '回复的评论不存在或已删除')
        }
      }
      const at = now()
      const id = randomId('NC')
      const doc = {
        id,
        newsId,
        uid,
        author: maskName(user.nick || user.name || '平台用户'),
        content,
        parentId: parent ? parent.id : '',
        rootId: parent ? (parent.rootId || parent.id) : id,
        replyToUid: parent ? parent.uid : '',
        replyToName: parent ? (parent.author || '') : '',
        createdAt: at,
        updatedAt: at,
        deleted: false
      }
      await repo.insert('newsComments', doc)
      return newsCommentView(doc, uid, at)
    },

    /** 删除自己的评论：软删除，回复一并隐藏 */
    'news.comment.delete': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '评论', required: true, max: 64 })
      const row = await repo.get('newsComments', id)
      if (!row || row.deleted === true) throw new AppError(CODES.NOT_FOUND, '评论不存在或已删除')
      if (row.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己的评论')
      const at = now()
      await repo.updateWhere('newsComments', { id, uid }, { deleted: true, updatedAt: at })
      /* 级联软删其回复：根评论按 rootId 带走全部层级，回复按 parentId 带走直接下级，
         避免「根已删除、回复仍展示」造成评论数虚高 */
      await repo.updateWhere('newsComments', {
        newsId: row.newsId,
        rootId: id,
        deleted: { $ne: true }
      }, { deleted: true, updatedAt: at })
      await repo.updateWhere('newsComments', {
        newsId: row.newsId,
        parentId: id,
        deleted: { $ne: true }
      }, { deleted: true, updatedAt: at })
      return { id, deleted: true }
    },

    /** 我的评论：我发的评论 + 收到的回复，按最新互动排序 */
    'news.comment.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      /* 评论关闭：我的评论 / 收到的回复一律不下发 */
      if (!(await commentsEnabled())) return { items: [], unread: 0, readAt: 0, enabled: false }
      const at = now()
      const my = await repo.find('newsComments', { uid, deleted: { $ne: true } }, {
        sort: { field: 'createdAt', dir: 'desc' }, limit: 50
      })
      const read = await repo.get('commentReads', uid)
      const readAt = Number(read && read.readAt) || 0
      const replies = my.length
        ? await repo.find('newsComments', {
          parentId: { $in: my.map((row) => row.id) },
          uid: { $ne: uid },
          deleted: { $ne: true }
        }, { sort: { field: 'createdAt', dir: 'asc' }, limit: 300 })
        : []
      const byParent = {}
      replies.forEach((row) => {
        byParent[row.parentId] = byParent[row.parentId] || []
        byParent[row.parentId].push(Object.assign(newsCommentView(row, uid, at), {
          unread: (Number(row.createdAt) || 0) > readAt
        }))
      })
      const newsIds = Array.from(new Set(my.map((row) => row.newsId)))
      let newsMap = {}
      if (newsIds.length) {
        const found = await repo.find('news', { id: { $in: newsIds } }, { limit: 100 })
        found.forEach((row) => { newsMap[row.id] = row })
      }
      const items = my.map((row) => {
        const news = newsMap[row.newsId]
        const valid = !!news && news.deleted !== true && news.status === NEWS_STATUS.PUBLISHED
        const list = byParent[row.id] || []
        return {
          id: row.id,
          content: row.content || '',
          newsId: row.newsId,
          newsTitle: valid ? (news.title || '资讯') : '资讯已失效',
          newsValid: valid,
          createdAt: Number(row.createdAt) || 0,
          createdText: dateText(row.createdAt),
          replies: list,
          unread: list.filter((rep) => rep.unread).length,
          lastAt: Math.max(Number(row.createdAt) || 0, ...list.map((rep) => rep.createdAt || 0))
        }
      })
      items.sort((a, b) => b.lastAt - a.lastAt)
      return { items, unread: await unreadReplyCount(repo, uid, readAt), readAt }
    },

    /** 打开「我的评论」后清空回复角标 */
    'news.comment.read': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const existing = await repo.get('commentReads', uid)
      if (existing) {
        await repo.updateWhere('commentReads', { id: uid, uid }, { readAt: at, updatedAt: at })
      } else {
        await repo.insert('commentReads', { id: uid, uid, readAt: at, createdAt: at, updatedAt: at })
      }
      return { unread: 0, readAt: at }
    },

    /** 「我的发布」红点：未读回复数 */
    'news.badge': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      /* 评论关闭：不再下发未读回复角标 */
      if (!(await commentsEnabled())) return { replies: 0, enabled: false }
      const read = await repo.get('commentReads', uid)
      const readAt = Number(read && read.readAt) || 0
      return { replies: await unreadReplyCount(repo, uid, readAt), enabled: true }
    },

    /** 删除自己投稿的资讯：软删除，不再出现在资讯圈与我的投稿 */
    'news.delete': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id || data.newsId, { field: '资讯', required: true, max: 64 })
      const row = await repo.get('news', id)
      if (!row || row.deleted === true) throw new AppError(CODES.NOT_FOUND, '资讯不存在或已删除')
      if (row.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己投稿的资讯')
      const at = now()
      const res = await repo.updateWhere('news', { id, uid }, { deleted: true, deletedAt: at, updatedAt: at })
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '资讯状态已变化，请刷新后重试')
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'news.delete',
          target: id,
          reason: '投稿人删除',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 内容已删除：留痕失败不阻断用户 */
      }
      return { id, deleted: true }
    },

    /** 我的商机权限与开通申请 */
    'biz.status': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const access = await ownAccess(uid)
      return accessView(access, now())
    },

    /**
     * 7 天体验：每人限一次，未开通 / 已到期且从未用过时可直接开通。
     * 体验权益与付费会员一致，不生成订单、不参与佣金，到期不自动续费。
     */
    'biz.trial': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const existing = await ownAccess(uid)
      const current = accessView(existing, at)
      if (current.unlocked) throw new AppError(CODES.VALIDATION, '会员仍在有效期内，到期后可再使用 7 天体验')
      if (current.trialUsed) throw new AppError(CODES.VALIDATION, '7 天体验已使用过，请开通会员')
      if (current.status === BIZ_STATUS.STOPPED) throw new AppError(CODES.FORBIDDEN, '会员功能已停用，请联系平台客服')
      if (current.status === BIZ_STATUS.PENDING) throw new AppError(CODES.VALIDATION, '开通申请正在处理中，请稍后再试')
      const expireAt = at + TRIAL_DAYS * DAY_MS
      const patch = {
        status: BIZ_STATUS.ACTIVE,
        plan: 0,
        planKey: 'trial',
        planLabel: TRIAL_PLAN_LABEL,
        days: TRIAL_DAYS,
        expireAt,
        trialUsed: true,
        trialAt: at,
        staff: '用户自助',
        note: '7 天体验（每人限一次）',
        updatedAt: at
      }
      if (existing) {
        await repo.updateWhere('bizAccess', { id: uid }, patch)
      } else {
        await repo.insert('bizAccess', Object.assign({ id: uid, uid, appliedAt: at }, patch))
      }
      await appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'biz.trial',
        target: uid,
        reason: '开通 7 天体验',
        result: 'allow',
        at
      })
      const view = accessView(Object.assign({}, existing || {}, patch), at)
      view.planKey = 'trial'
      view.planLabel = TRIAL_PLAN_LABEL
      /* 回执：告知体验截止时间，避免到期后才发现权限失效 */
      try {
        await notifyUser(uid, {
          title: '7 天体验已开通',
          body: `7 天体验已生效，有效期至 ${view.expireText || '--'}。体验期内可领取商机并查看联系方式，到期后需开通会员才能继续使用。`,
          targetType: 'biz',
          targetId: uid
        })
      } catch (notifyErr) {
        /* 体验已生效：回执失败不回滚 */
      }
      return view
    },

    /** 会员四档套餐：价格 / 天数取管理端设置，未配置用默认值 */
    'biz.plans': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const access = await ownAccess(uid)
      return Object.assign(accessView(access, at), {
        plans: await resolvePlans(repo),
        method: '企业微信',
        hint: '扫码支付后提交开通申请，客服确认到账即自动加时长'
      })
    },


    /**
     * 商机列表：只展示与「我」相关的两条线，其余一律不出现。
     * 1. 我的库存能满足的需求 / 代采代售委托；
     * 2. 能满足我已发布需求的他人货源（反向商机）。
     * 联系方式按「已开通 + 已领取」脱敏下发。
     */
    'biz.list': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      /* 公开商机列表读取前兜底关闭已过截止时间的委托 */
      await expireAgenciesLazy(repo, at)
      const access = await ownAccess(uid)
      const view = accessView(access, at)
      const unlocked = view.unlocked
      const stocks = await ownStocks(uid)
      /* 提示力度：决定商机检索的严格程度，未设置时按标准档 */
      const prefRow = await repo.get('bizPrefs', uid)
      const prefs = normalizeBizPrefs(prefRow)
      /* 上次查看时间：本次进入时「此后新增」的商机只在这一次置顶，下次进入即并入正常排序 */
      const lastSeenAt = Number(prefRow && prefRow.seenAt) || 0
      /* 会员打开商机列表即视为「已读」：记录 seenAt，首页角标只统计此后新增的商机。
         未开通用户打开的是开通引导，不写 seenAt，角标继续提示，直到开通后查看才清零。 */
      if (unlocked && data && data.markSeen === true) {
        const patch = { seenAt: at, updatedAt: at }
        const hit = await repo.updateWhere('bizPrefs', { id: uid }, patch)
        if (!hit || !hit.count) {
          const doc = Object.assign({ id: uid, uid }, prefs, patch)
          try {
            await repo.insert('bizPrefs', doc)
          } catch (err) {
            if (!err || err.code !== CODES.CONFLICT) throw err
            await repo.updateWhere('bizPrefs', { id: uid }, patch)
          }
        }
      }
      const claims = await ownClaims(uid)
      /* 用户标记「不满足」的商机：保留在列表的「不满足」分类里，但不再计入可领取与角标 */
      const markRows = await repo.find('bizMarks', { uid, marked: true }, { limit: 500 })
      const markSet = new Set()
      markRows.forEach((row) => {
        if (row && row.targetId) markSet.add(`${row.targetType}:${row.targetId}`)
      })
      /* 我发布的求购需求：代售委托靠它匹配需求方，货源也用它做反向匹配 */
      const myDemands = await repo.find('demands', {
        ownerId: uid,
        status: '求购中',
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
      /* 本人已提交的对接申请：同一委托只生成一张客服工单，重复点击直接返回原工单 */
      const consultRows = await repo.find('leads', { uid, targetType: 'agency' }, { limit: 200 })
      const consultMap = {}
      consultRows.forEach((row) => {
        if (row.targetId && row.status !== LEAD_STATUS.CLOSED) consultMap[row.targetId] = row.status
      })

      /* 拉黑：商机池是共享缓存，只能取出后按浏览者过滤被拉黑者的求购 / 委托 / 货源 */
      const blockedOwners = await blockedPeerIds(repo, uid)
      const visibleToMe = (rows) => (blockedOwners.size
        ? rows.filter((row) => !blockedOwners.has(String(row.ownerId || '')))
        : rows)

      const demandRows = visibleToMe(await sharedPool('open-demands', 20, () => repo.find('demands', {
        status: '求购中',
        visibility: { $ne: VISIBILITIES.PRIVATE },
        /* 普通发布即进池：不再看 bizPool / channel，历史 public+bizPool=false 也纳入 */
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })))

      /* 代采 / 代售委托：公开的进入商机池，所有匹配会员都能看到完整委托内容，
         由平台统一对外（不透出委托方主体），不做「领取后才可见」 */
      const agencyRows = visibleToMe(await sharedPool('open-agencies', 20, () => repo.find('agencies', {
        status: AGENCY_STATUS.ACTIVE,
        visibility: { $ne: VISIBILITIES.PRIVATE },
        bizPool: { $ne: false },
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'confirmedAt', dir: 'desc' }, limit: 50 })))

      /* 反向商机货源：取普通发布的在售商品（私密除外），且不能是自己的 */
      const productRows = myDemands.length
        ? visibleToMe(await sharedPool('pool-products', 20, () => repo.find('products', {
          status: '在售',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          /* 普通发布即进池：历史 public+bizPool=false 也纳入 */
          deleted: { $ne: true }
        }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 })))
        : []
      const supplyProducts = productRows.filter((p) => p.ownerId !== uid)

      /* 一次查回这批商机的领取数，避免逐条 count 打库（池子共享，领取数也共享） */
      const claimCountMap = await sharedPool('claim-counts', 20, async () => {
        const claimIds = demandRows.map((d) => d.id)
          .concat(agencyRows.map((a) => a.id))
          .concat(supplyProducts.map((p) => p.id))
        const counts = {}
        if (!claimIds.length) return counts
        const claimRows = await repo.find('bizClaims', { targetId: { $in: claimIds } }, { limit: 2000 })
        claimRows.forEach((row) => {
          const key = `${row.targetType}:${row.targetId}`
          counts[key] = (counts[key] || 0) + 1
        })
        return counts
      })

      /* 商机池主体口径：所有普通发布者都进池，是否公开主体只影响展示脱敏与筛选。
         未开通时也查一次，保证角标 / 条数与会员看到的完全一致；
         解锁后才解密主体名称用于展示 */
      const ownerIds = Array.from(new Set(
        demandRows.filter((d) => d.ownerId !== uid).map((d) => d.ownerId)
          .concat(supplyProducts.map((p) => p.ownerId))
      ))
      const poolProfileMap = await sharedPoolProfiles(ownerIds)
      const profileByUid = {}
      for (const p of poolProfileMap.values()) {
        const profileUid = p.uid || p.id
        let subject = ''
        if (unlocked && (p.subjectCipher || p.subject)) {
          try {
            subject = p.subjectCipher
              ? decryptFieldOf({ keys, collection: 'profiles', field: 'subject', recordId: profileUid, cipher: p.subjectCipher })
              : p.subject
          } catch (err) {
            subject = ''
          }
        }
        profileByUid[profileUid] = { subject, subjectType: p.subjectType, exposure: p.exposure }
      }
      /* 是否公开主体：只用于 onlyOpenSubject 筛选与主体展示口径 */
      const isOpenOwner = (ownerId) => {
        const p = profileByUid[ownerId]
        return !!(p && p.exposure === EXPOSURES.OPEN)
      }
      /* 主体展示：会员 + 公开主体给完整主体；非会员公开主体给脱敏主体；
         未公开主体统一用昵称脱敏 / 匿名用户，绝不留空 */
      const orgOf = (ownerId, nickname) => {
        const p = profileByUid[ownerId]
        const subject = String((p && p.subject) || '').trim()
        if (p && p.exposure === EXPOSURES.OPEN && subject) {
          return unlocked ? subject : maskSubject(subject, p.subjectType)
        }
        return maskName(String(nickname || '')) || '匿名用户'
      }
      let hiddenCount = 0

      const demandItems = []
      const agencyItems = []
      const supplyItems = []
      for (const demand of demandRows) {
        if (demand.ownerId === uid) continue
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          price: demand.budget,
          priceMax: demand.budgetMax,
          city: demand.city,
          cond: demand.cond,
          tax: demand.tax,
          supply: demand.supply,
          series: demand.series,
          pref: prefs
        })
        /* 只展示我的库存能对上的需求，其余商机不出现 */
        if (!match.ok) continue
        /* 只看公开主体：未公开主体的匹配对象不展示，单独计数给前端提示 */
        if (prefs.onlyOpenSubject && !isOpenOwner(demand.ownerId)) {
          hiddenCount += 1
          continue
        }
        const claimed = claims.has(`demand:${demand.id}`)
        const unsatisfied = markSet.has(`demand:${demand.id}`)
        const claimCount = claimCountMap[`demand:${demand.id}`] || 0
        /* 联系方式只在「已开通 + 已领取 + 仍匹配」时下发；
           权限到期后已领取记录仍保留，但不继续给联系方式 */
        const readable = claimed && unlocked && match.ok
        const contact = readable ? await contactOfUser(demand.ownerId) : null
        const owner = contact ? null : await repo.get('users', demand.ownerId)
        /* 会员 + 公开主体给完整主体；其余按脱敏主体 / 昵称兜底，绝不留空 */
        const displayOrg = contact
          ? contact.org
          : orgOf(demand.ownerId, owner && owner.nick)
        demandItems.push(demandViewOf(demand, {
          now: at,
          matched: true,
          stockText: match.text,
          stockQty: match.qty,
          /* 匹配说明：什么型号对上了、依据是「我的库存」 */
          matchModel: match.model,
          matchVia: '我的库存',
          matchText: `基于我的库存 · 现有 ${match.qty} 台可出`,
          claimed,
          claimCount,
          /* 领取即解锁联系人区块：对方没留电话时由前端提示改用站内对话，
             不再因为 phone 为空把卡片底部渲染成「一个按钮都没有」的死卡片 */
          contactVisible: !!contact,
          canClaim: unlocked && !claimed && !unsatisfied,
          unsatisfied,
          org: displayOrg,
          ownerKey: authorKeyOf(demand.ownerId),
          contact: contact
            ? contact.name
            : claimed
              ? '商机权限已到期，续费后可查看'
              : '领取后可见',
          phone: contact ? contact.phone : ''
        }))
      }

      for (const agency of agencyRows) {
        if (agency.ownerId === uid) continue
        /* 代采（buy）＝平台代买，匹配货主方：用我的库存对上委托；
           代售（sell）＝平台代卖，匹配需求方：用我发布的求购需求对上委托 */
        let match = null
        let matchVia = ''
        let matchText = ''
        if (agency.side === 'sell') {
          const agencyStock = {
            id: agency.id,
            cat: agency.itemCat || '',
            model: agency.item || '',
            brand: '',
            qty: Number(agency.qty) || 0,
            price: Number(agency.price) || 0,
            city: agency.city || '',
            cond: '',
            tax: '',
            supply: ''
          }
          let hitDemand = null
          for (const demand of myDemands) {
            const hit = stockMatch([agencyStock], demand.cat, demand.model, demand.brand, {
              qty: demand.qty,
              price: demand.budget,
              priceMax: demand.budgetMax,
              city: demand.city,
              cond: demand.cond,
              tax: demand.tax,
              supply: demand.supply,
              series: demand.series,
              /* 代售委托是对方货盘：指定城市按委托所在城市过滤 */
              pickCity: agency.city,
              pref: prefs
            })
            if (hit.ok) {
              match = hit
              hitDemand = demand
              break
            }
          }
          if (!match) continue
          matchVia = '我的需求'
          matchText = `基于我发布的需求《${hitDemand.title || hitDemand.model || '我的求购'}》`
        } else {
          match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
            qty: agency.qty,
            /* 委托价格口径与供需不同（可能含服务费 / 整单），价格档位只作用于求购与货源 */
            city: agency.city,
            series: agency.series,
            pref: prefs
          })
          /* 商机池只展示库存能对上的委托，避免无关用户看到 */
          if (!match.ok) continue
          matchVia = '我的库存'
          matchText = `基于我的库存 · 现有 ${match.qty} 台可出`
        }
        const claimed = claims.has(`agency:${agency.id}`)
        const unsatisfied = markSet.has(`agency:${agency.id}`)
        const claimCount = claimCountMap[`agency:${agency.id}`] || 0
        /* 代采 / 代售与普通商机同口径：委托信息对所有匹配会员可见，
           不做「领取后才可见」；领取只用于标记意向并进入平台对接流程 */
        agencyItems.push(agencyViewOf(agency, {
          now: at,
          matched: true,
          stockText: match.text,
          stockQty: match.qty,
          matchModel: match.model,
          matchVia,
          matchText,
          claimed,
          claimCount,
          contactVisible: false,
          canClaim: unlocked && !claimed && !unsatisfied,
          canConsult: unlocked && claimed,
          unsatisfied,
          consulted: !!consultMap[agency.id],
          /* 代采代售全程以平台身份对外，不暴露任何委托方企业信息 */
          org: '平台',
          contact: '平台代为对接',
          phone: ''
        }))
      }

      /* 反向商机：别人的货源命中了我已发布的需求。
         同一个货源只生成一条商机，按我的需求数量 / 城市 / 成色判断是否满足 */
      for (const product of supplyProducts) {
        let hit = null
        for (const demand of myDemands) {
          const match = stockMatch([product], demand.cat, demand.model, demand.brand, {
            qty: demand.qty,
            price: demand.budget,
            priceMax: demand.budgetMax,
            city: demand.city,
            cond: demand.cond,
            tax: demand.tax,
            supply: demand.supply,
            series: demand.series,
            /* 反向商机的对方城市在货源上：指定城市按货源地过滤 */
            pickCity: product.city,
            pref: prefs
          })
          if (match.ok) {
            hit = { demand, match }
            break
          }
        }
        if (!hit) continue
        /* 只看公开主体：未公开主体的货主不展示，单独计数给前端提示 */
        if (prefs.onlyOpenSubject && !isOpenOwner(product.ownerId)) {
          hiddenCount += 1
          continue
        }
        const claimed = claims.has(`supply:${product.id}`)
        const unsatisfied = markSet.has(`supply:${product.id}`)
        const claimCount = claimCountMap[`supply:${product.id}`] || 0
        const contact = claimed && unlocked ? await contactOfUser(product.ownerId) : null
        const owner = contact ? null : await repo.get('users', product.ownerId)
        const displayOrg = contact
          ? contact.org
          : orgOf(product.ownerId, owner && owner.nick)
        const demandTitle = hit.demand.title || hit.demand.model || '我的求购'
        supplyItems.push(supplyViewOf(product, {
          now: at,
          stockText: hit.match.text,
          stockQty: hit.match.qty,
          matchModel: `${product.brand || ''} ${product.model || ''}`.trim() || hit.match.model,
          matchVia: '我发布的需求',
          matchText: `基于我发布的需求《${demandTitle}》`,
          demandText: `匹配我的需求：${demandTitle}`,
          claimed,
          claimCount,
          /* 领取即解锁联系人区块：对方没留电话时由前端提示改用站内对话，
             不再因为 phone 为空把卡片底部渲染成「一个按钮都没有」的死卡片 */
          contactVisible: !!contact,
          canClaim: unlocked && !claimed && !unsatisfied,
          unsatisfied,
          org: displayOrg,
          ownerKey: authorKeyOf(product.ownerId),
          contact: contact
            ? contact.name
            : claimed
              ? '商机权限已到期，续费后可查看'
              : '领取后可见',
          phone: contact ? contact.phone : ''
        }))
      }

      /* 已领取但已结束的商机：需求关闭 / 货源下架后领取记录不能跟着消失，
         否则用户过几天再回来就找不到这条商机与联系人。按领取记录补回并标记「已结束」。 */
      const endedItems = []
      if (unlocked && claims.size) {
        const shown = new Set(
          demandItems.map((item) => `demand:${item.id}`).concat(supplyItems.map((item) => `supply:${item.id}`))
        )
        const endedDemandIds = []
        const endedSupplyIds = []
        claims.forEach((key) => {
          const text = String(key || '')
          const cut = text.indexOf(':')
          if (cut < 0 || shown.has(text)) return
          const kind = text.slice(0, cut)
          const id = text.slice(cut + 1)
          if (!id) return
          if (kind === 'demand') endedDemandIds.push(id)
          else if (kind === 'supply') endedSupplyIds.push(id)
        })
        if (endedDemandIds.length) {
          const rows = await repo.find('demands', { id: { $in: endedDemandIds }, deleted: { $ne: true } }, { limit: endedDemandIds.length })
          for (const demand of rows) {
            if (!demand || demand.ownerId === uid) continue
            const contact = await contactOfUser(demand.ownerId)
            endedItems.push(demandViewOf(demand, {
              now: at,
              matched: true,
              claimed: true,
              closed: true,
              statusText: demand.status === '已成交' ? '已成交' : '已结束',
              contactVisible: !!contact,
              canClaim: false,
              org: contact ? contact.org : '',
              ownerKey: authorKeyOf(demand.ownerId),
              contact: contact ? contact.name : '已领取',
              phone: contact ? contact.phone : ''
            }))
          }
        }
        if (endedSupplyIds.length) {
          const rows = await repo.find('products', { id: { $in: endedSupplyIds }, deleted: { $ne: true } }, { limit: endedSupplyIds.length })
          for (const product of rows) {
            if (!product || product.ownerId === uid) continue
            const contact = await contactOfUser(product.ownerId)
            endedItems.push(supplyViewOf(product, {
              now: at,
              claimed: true,
              closed: true,
              statusText: '已下架',
              contactVisible: !!contact,
              canClaim: false,
              org: contact ? contact.org : '',
              ownerKey: authorKeyOf(product.ownerId),
              contact: contact ? contact.name : '已领取',
              phone: contact ? contact.phone : ''
            }))
          }
        }
      }

      /* 时间范围：只保留最近 N 天发布的商机；已领取但已结束的记录不受时间限制 */
      const since = at - (Number(prefs.days) || BIZ_PREF_DAYS_DEFAULT) * DAY_MS
      const inWindow = (item) => (Number(item.at) || 0) >= since
      const freshItems = agencyItems.concat(demandItems, supplyItems).filter(inWindow)
      const newestFirst = (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)
      const sorters = {
        /* 匹配度：我的库存可出数量多的在前 */
        match: (a, b) => (Number(b.stockQty) || 0) - (Number(a.stockQty) || 0) || newestFirst(a, b),
        /* 商机数量：对方需求 / 委托数量大的在前 */
        qty: (a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0) || newestFirst(a, b)
      }
      const visibleItems = freshItems
        .sort(sorters[prefs.sort] || newestFirst)
        .concat(endedItems)
      /* 型号筛选只允许在「本次匹配上的型号」里选，前端据此渲染下拉 */
      const matchModels = Array.from(new Set(
        freshItems.map((item) => String(item.matchModel || '').trim()).filter(Boolean)
      )).slice(0, 50)
      const plans = await resolvePlans(repo)
      /* 未开通商机会员：同样返回全部匹配条目的脱敏版本（org 已脱敏，联系方式 / 必须条件仍锁定） */
      const lockedItems = !unlocked
        ? visibleItems.map((item) => Object.assign({}, item, {
          org: item.org || '匿名用户',
          contact: item.type === 'agency' ? '平台代为对接' : '开通商机后可见',
          phone: '',
          claimText: '',
          must: [],
          contactVisible: false,
          canClaim: false,
          canConsult: false,
          claimed: false,
          claimCount: 0
        }))
        : null
      return Object.assign(view, {
        items: unlocked ? visibleItems : lockedItems,
        locked: !unlocked,
        matchedCount: freshItems.length,
        /* 被 onlyOpenSubject 筛掉的条数：前端展示「另有 N 条被筛选隐藏」 */
        hiddenCount,
        matchModels: unlocked ? matchModels : [],
        stockCount: stocks.length,
        demandCount: myDemands.length,
        plans,
        planKey: view.planKey || 'month',
        prefs,
        /* 上次查看时间：前端据此把本次新增的商机临时置顶并标「新」，退出后不再保留 */
        lastSeenAt: unlocked ? lastSeenAt : 0,
        prefPresets: ['loose', 'standard', 'strict'].map((key) => Object.assign({}, BIZ_PREF_PRESETS[key])),
        hint: unlocked ? '' : '开通商机后可查看联系方式并领取商机'
      })
    },

    /**
     * 商机提示力度：读取 / 保存当前用户的口径。
     * 只影响「什么算匹配」，不改库存本身；宽松档会多提醒，严格档只提醒高确定性商机。
     */
    'biz.prefs': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      if (data && data.save === true) {
        const next = normalizeBizPrefs(data)
        const existing = await repo.get('bizPrefs', uid)
        /* 只看公开主体是独立开关：切换档位 / 城市时未显式传值则保留原设置 */
        if (data.onlyOpenSubject === undefined) {
          next.onlyOpenSubject = !!(existing && existing.onlyOpenSubject)
        }
        /* 保存提示力度不能把「已读时间」清掉，否则改一次设置角标会重新亮起 */
        const doc = Object.assign({ id: uid, uid }, next, {
          seenAt: Number(existing && existing.seenAt) || 0,
          updatedAt: at
        })
        if (existing) {
          await repo.updateWhere('bizPrefs', { id: uid }, doc)
        } else {
          try {
            await repo.insert('bizPrefs', doc)
          } catch (err) {
            if (!err || err.code !== CODES.CONFLICT) throw err
            await repo.updateWhere('bizPrefs', { id: uid }, doc)
          }
        }
        return {
          prefs: next,
          at,
          prefPresets: ['loose', 'standard', 'strict'].map((key) => Object.assign({}, BIZ_PREF_PRESETS[key]))
        }
      }
      const row = await repo.get('bizPrefs', uid)
      return {
        prefs: normalizeBizPrefs(row),
        at: Number(row && row.updatedAt) || 0,
        prefPresets: ['loose', 'standard', 'strict'].map((key) => Object.assign({}, BIZ_PREF_PRESETS[key]))
      }
    },

    /**
     * 首页商机角标：算「与我库存匹配」+「满足我已发布需求」的商机数量，已领取的不再计入。
     * 未开通也照样计数：角标用于引导开通；发布方删除 / 关闭对应条目时也会减少。
     * 首页每次展示都会调用，因此不查联系方式、不组装卡片，避免重查询。
     */
    'biz.badge': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const access = accessView(await ownAccess(uid), at)
      const stocks = await ownStocks(uid)
      const prefRow = await repo.get('bizPrefs', uid)
      const prefs = normalizeBizPrefs(prefRow)
      /* 会员查看过商机后（seenAt）只统计之后新增的商机，实现「看过即清零」；
         未开通用户不按 seenAt 过滤，角标继续提示以便引导开通 */
      const seenAt = access.unlocked ? (Number(prefRow && prefRow.seenAt) || 0) : 0
      /* 与商机列表同一时间口径：只统计显示时间范围内的商机 */
      const since = at - (Number(prefs.days) || BIZ_PREF_DAYS_DEFAULT) * DAY_MS
      const inWindow = (item) => {
        const t = Number(item.at) || 0
        return t >= since && t > seenAt
      }
      const claims = await ownClaims(uid)
      /* 标记「不满足」的商机不再计入角标提醒，但仍在商机列表里可查看 */
      const markRows = await repo.find('bizMarks', { uid, marked: true }, { limit: 500 })
      const markSet = new Set()
      markRows.forEach((row) => {
        if (row && row.targetId) markSet.add(`${row.targetType}:${row.targetId}`)
      })
      let count = 0
      const demandRows = stocks.length
        ? await sharedPool('open-demands', 20, () => repo.find('demands', {
          status: '求购中',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          deleted: { $ne: true }
        }, { limit: 50 }))
        : []
      const demandOwners = await sharedPoolProfiles(demandRows.map((d) => d.ownerId))
      const isOpenOwner = (ownerId) => {
        const p = demandOwners.get(ownerId)
        return !!(p && p.exposure === EXPOSURES.OPEN)
      }
      demandRows.forEach((demand) => {
        if (demand.ownerId === uid) return
        /* 已领取 / 已标记不满足的商机不再计入角标 */
        if (claims.has(`demand:${demand.id}`)) return
        if (markSet.has(`demand:${demand.id}`)) return
        /* 只看公开主体：未公开主体的商机不计入角标，与列表筛选保持一致 */
        if (prefs.onlyOpenSubject && !isOpenOwner(demand.ownerId)) return
        /* 超出显示时间范围：不计入角标 */
        if (!inWindow({ at: demand.createdAt })) return
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          price: demand.budget,
          priceMax: demand.budgetMax,
          city: demand.city,
          cond: demand.cond,
          tax: demand.tax,
          supply: demand.supply,
          series: demand.series,
          pref: prefs
        })
        if (match.ok) count += 1
      })
      /* 我发布的需求：代售（平台代卖）用它匹配需求方，也用于反向商机计数 */
      const myDemandsAll = await repo.find('demands', {
        ownerId: uid,
        status: '求购中',
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
      const myDemands = myDemandsAll.filter((row) =>
        row && row.visibility !== VISIBILITIES.PRIVATE)
      if (stocks.length || myDemandsAll.length) {
        const agencyRows = await sharedPool('open-agencies', 20, () => repo.find('agencies', {
          status: AGENCY_STATUS.ACTIVE,
          visibility: { $ne: VISIBILITIES.PRIVATE },
          bizPool: { $ne: false },
          expiresAt: { $gte: at },
          deleted: { $ne: true }
        }, { limit: 50 }))
        agencyRows.forEach((agency) => {
          if (agency.ownerId === uid) return
          if (claims.has(`agency:${agency.id}`)) return
          if (markSet.has(`agency:${agency.id}`)) return
          if (!inWindow({ at: agency.confirmedAt || agency.createdAt })) return
          /* 与商机列表同一口径：代采（buy）＝平台代买，匹配我的库存；
             代售（sell）＝平台代卖，匹配我发布的需求 */
          let match = null
          if (agency.side === 'sell') {
            const agencyStock = {
              id: agency.id,
              cat: agency.itemCat || '',
              model: agency.item || '',
              brand: '',
              qty: Number(agency.qty) || 0,
              price: Number(agency.price) || 0,
              city: agency.city || '',
              cond: '',
              tax: '',
              supply: ''
            }
            for (const demand of myDemandsAll) {
              const hit = stockMatch([agencyStock], demand.cat, demand.model, demand.brand, {
                qty: demand.qty,
                price: demand.budget,
                priceMax: demand.budgetMax,
                city: demand.city,
                cond: demand.cond,
                tax: demand.tax,
                supply: demand.supply,
                series: demand.series,
                /* 代售委托是对方货盘：指定城市按委托所在城市过滤 */
                pickCity: agency.city,
                pref: prefs
              })
              if (hit.ok) { match = hit; break }
            }
          } else {
            match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
              qty: agency.qty,
              /* 委托价格口径与供需不同（可能含服务费 / 整单），价格档位只作用于求购与货源 */
              city: agency.city,
              series: agency.series,
              pref: prefs
            })
          }
          if (match && match.ok) count += 1
        })
      }

      /* 反向商机：别人在售的货源是否满足我已发布的需求（需求须公开且进商机池） */
      if (myDemands.length) {
        const productRows = await sharedPool('pool-products', 20, () => repo.find('products', {
          status: '在售',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          deleted: { $ne: true }
        }, { limit: 100 }))
        const productOwners = await sharedPoolProfiles(productRows.map((p) => p.ownerId))
        const isOpenProductOwner = (ownerId) => {
          const p = productOwners.get(ownerId)
          return !!(p && p.exposure === EXPOSURES.OPEN)
        }
        productRows.forEach((product) => {
          if (product.ownerId === uid) return
          if (claims.has(`supply:${product.id}`)) return
          if (markSet.has(`supply:${product.id}`)) return
          if (prefs.onlyOpenSubject && !isOpenProductOwner(product.ownerId)) return
          if (!inWindow({ at: product.createdAt })) return
          const hit = myDemands.some((demand) => stockMatch([product], demand.cat, demand.model, demand.brand, {
            qty: demand.qty,
            price: demand.budget,
            priceMax: demand.budgetMax,
            city: demand.city,
            cond: demand.cond,
            tax: demand.tax,
            supply: demand.supply,
            series: demand.series,
            /* 反向商机的对方城市在货源上：指定城市按货源地过滤 */
            pickCity: product.city,
            pref: prefs
          }).ok)
          if (hit) count += 1
        })
      }
      /* 新商机提醒统一由「发布即提醒」触发（需求 / 货源发布时给双方各发一次），
         角标这里只负责计数，不再重复推订阅消息，避免同一条商机打扰两次 */
      /* 已领取条数：以仍然存在的商机为准（已结束 / 已下架的领取记录仍保留在「我的商机」，删除的不计入） */
      let claimedCount = 0
      if (claims.size) {
        const demandIds = []
        const supplyIds = []
        const agencyIds = []
        claims.forEach((key) => {
          const text = String(key || '')
          const cut = text.indexOf(':')
          if (cut < 0) return
          const kind = text.slice(0, cut)
          const id = text.slice(cut + 1)
          if (!id) return
          if (kind === 'demand') demandIds.push(id)
          else if (kind === 'supply') supplyIds.push(id)
          else if (kind === 'agency') agencyIds.push(id)
        })
        if (demandIds.length) {
          const rows = await repo.find('demands', { id: { $in: demandIds }, deleted: { $ne: true } }, { limit: demandIds.length })
          claimedCount += rows.filter((row) => row && row.ownerId !== uid).length
        }
        if (supplyIds.length) {
          const rows = await repo.find('products', { id: { $in: supplyIds }, deleted: { $ne: true } }, { limit: supplyIds.length })
          claimedCount += rows.filter((row) => row && row.ownerId !== uid).length
        }
        /* 代采 / 代售领取记录同样计入「我的商机」，与列表保持一致 */
        if (agencyIds.length) {
          const rows = await repo.find('agencies', { id: { $in: agencyIds }, deleted: { $ne: true } }, { limit: agencyIds.length })
          claimedCount += rows.filter((row) => row && row.ownerId !== uid).length
        }
      }
      return { count, claimed: claimedCount, unlocked: access.unlocked, status: access.status }
    },

    /** 领取商机：必须已开通 + 库存匹配；重复领取幂等返回同一联系方式 */
    'biz.claim': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const at = now()
      /* 领取商机属于「商机对接」：受限期间不允许新领取，避免绕过直聊限制拿到联系方式 */
      assertAllowed(user, 'chat', at)
      const access = await ownAccess(uid)
      const view = accessView(access, at)
      if (!view.unlocked) throw new AppError(CODES.CONFLICT, '商机权限未开通或已到期，请先开通')

      const targetType = enumOf(
        data.targetType || (data.demandId ? 'demand' : (data.supplyId ? 'supply' : 'agency')),
        ['demand', 'agency', 'supply'],
        '商机类型'
      )
      const targetIdKey = targetType === 'demand' ? 'demandId' : (targetType === 'supply' ? 'supplyId' : 'agencyId')
      const targetId = str(data[targetIdKey], {
        field: '商机标识',
        required: true,
        max: 64
      })
      const claimId = 'bc' + sha256Hex(`${uid}:${targetType}:${targetId}`).slice(0, 24)
      /* 与直聊 / 咨询共用同一条确定性线索：命中「已拦截」说明该用户在这个标的上已被风控拦下，
         即使商机已开通、库存也匹配，也不能把发布方联系方式放出去 */
      const leadId = 'L' + sha256Hex(`chat:${uid}:${targetId}`).slice(0, 22)
      const blockedLead = await repo.get('leads', leadId)
      if (blockedLead && blockedLead.status === LEAD_STATUS.BLOCKED) {
        throw new AppError(CODES.FORBIDDEN, '该商机暂不可领取，请通过在线客服咨询')
      }
      const existing = await repo.get('bizClaims', claimId)
      const stocks = await ownStocks(uid)
      /* 提示力度：与商机列表保持同一口径，列表能看到的才能领取 */
      const prefs = normalizeBizPrefs(await repo.get('bizPrefs', uid))

      let contact = null
      let ownerId = ''
      let title = ''
      let agencySide = ''
      /* 不设领取名额：发布方不下架，匹配到的会员都可以领取 */
      /* 发布者设置的必须条件：领取时逐项确认，服务端复核 */
      let must = []
      if (targetType === 'demand') {
        const demand = await repo.get('demands', targetId)
        if (!demand || demand.deleted) throw new AppError(CODES.NOT_FOUND, '需求不存在或已关闭')
        /* 保密需求只隐藏主体与联系方式，内容仍可在需求详情页匿名浏览并发起对话；
           商机池卖的是联系方式，因此保密需求不进入领取 */
        if (demand.visibility === VISIBILITIES.PRIVATE) {
          throw new AppError(CODES.NOT_FOUND, '该需求为保密发布，不提供联系方式，请直接在需求详情页对话')
        }
        if (demand.status !== '求购中') throw new AppError(CODES.CONFLICT, '该需求已停止领取')
        if (demand.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能领取自己发布的需求')
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          price: demand.budget,
          priceMax: demand.budgetMax,
          city: demand.city,
          cond: demand.cond,
          tax: demand.tax,
          supply: demand.supply,
          series: demand.series,
          pref: prefs
        })
        if (!match.ok) throw new AppError(CODES.FORBIDDEN, '我的库存中没有匹配的型号，无法领取')
        must = Array.isArray(demand.must) ? demand.must : []
        contact = await contactOfUser(demand.ownerId)
        ownerId = demand.ownerId
        title = demand.title || demand.model
      } else if (targetType === 'supply') {
        /* 反向商机：领取的是别人在售的货源，需要与我的某条求购需求匹配 */
        const product = await repo.get('products', targetId)
        if (!product || product.deleted) throw new AppError(CODES.NOT_FOUND, '货源不存在或已下架')
        if (product.status !== '在售') throw new AppError(CODES.CONFLICT, '该货源已下架')
        if (product.visibility === VISIBILITIES.PRIVATE) {
          throw new AppError(CODES.NOT_FOUND, '该货源为保密发布，不提供联系方式')
        }
        if (product.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能领取自己发布的货源')
        const myDemands = await repo.find('demands', {
          ownerId: uid,
          status: '求购中',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          deleted: { $ne: true }
        }, { limit: 50 })
        const hit = myDemands.some((demand) => stockMatch([product], demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          price: demand.budget,
          priceMax: demand.budgetMax,
          city: demand.city,
          cond: demand.cond,
          tax: demand.tax,
          supply: demand.supply,
          series: demand.series,
          /* 反向商机的对方城市在货源上：指定城市按货源地过滤 */
          pickCity: product.city,
          pref: prefs
        }).ok)
        if (!hit) throw new AppError(CODES.FORBIDDEN, '该货源与我的需求不匹配，无法领取')
        must = Array.isArray(product.must) ? product.must : []
        contact = await contactOfUser(product.ownerId)
        ownerId = product.ownerId
        title = product.title || product.model
      } else {
        /* 代采 / 代售：先确认交易流程条件，再领取；领取后才由平台居中对接 */
        const agency = await repo.get('agencies', targetId)
        if (!agency || agency.deleted) throw new AppError(CODES.NOT_FOUND, '委托不存在或已关闭')
        if (agency.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能领取自己发布的委托')
        if (agency.status !== AGENCY_STATUS.ACTIVE) {
          throw new AppError(
            CODES.CONFLICT,
            agency.status === AGENCY_STATUS.LOCKED ? '该委托已锁定唯一对接方，暂不可领取' : '该委托已结束，暂不可领取'
          )
        }
        agencySide = agency.side || ''
        /* 与商机列表同一口径：代采（buy）＝平台代买，匹配我的库存；
           代售（sell）＝平台代卖，匹配我发布的需求 */
        let match = null
        if (agency.side === 'sell') {
          const myDemands = await repo.find('demands', {
            ownerId: uid,
            status: '求购中',
            deleted: { $ne: true }
          }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
          const agencyStock = {
            id: agency.id,
            cat: agency.itemCat || '',
            model: agency.item || '',
            brand: '',
            qty: Number(agency.qty) || 0,
            price: Number(agency.price) || 0,
            city: agency.city || '',
            cond: '',
            tax: '',
            supply: ''
          }
          for (const demand of myDemands) {
            const hit = stockMatch([agencyStock], demand.cat, demand.model, demand.brand, {
              qty: demand.qty,
              price: demand.budget,
              priceMax: demand.budgetMax,
              city: demand.city,
              cond: demand.cond,
              tax: demand.tax,
              supply: demand.supply,
              series: demand.series,
              /* 代售委托是对方货盘：指定城市按委托所在城市过滤 */
              pickCity: agency.city,
              pref: prefs
            })
            if (hit.ok) { match = hit; break }
          }
        } else {
          match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
            qty: agency.qty,
            city: agency.city,
            series: agency.series,
            pref: prefs
          })
        }
        if (!match || !match.ok) {
          throw new AppError(CODES.FORBIDDEN, agency.side === 'sell'
            ? '我发布的需求中没有匹配的型号，无法领取'
            : '我的库存中没有匹配的型号，无法领取')
        }
        /* 截止时间已过：即使状态还没被懒过期任务刷新，也不允许领取 */
        if (agency.expiresAt && Number(new Date(agency.expiresAt).getTime()) < Number(at)) {
          throw new AppError(CODES.CONFLICT, '该委托已到截止时间，暂不可领取')
        }
        must = Array.isArray(agency.must) && agency.must.length ? agency.must : AGENCY_MUST_DEFAULT.slice()
        /* 委托方主体信息不对外下发：领取后也统一显示为平台 */
        contact = { org: '平台', name: '平台代为对接', phone: '' }
        ownerId = agency.ownerId
        title = `${agency.kind} ${agency.item}`
      }

      /* 领取不再要求领取方公开主体：匿名主体同样可以领取，主体信息仅在展示时脱敏 */

      /* 发布者的必须条件：领取时逐项确认，服务端复核，避免绕过前端直接领到不满足条件的商机。
         放在写领取记录之前，确认失败不会留下脏数据 */
      if (!existing && must.length) {
        const conds = (Array.isArray(data.conds) ? data.conds : []).map((c) => String(c || '').trim())
        const missing = must.filter((t) => conds.indexOf(String(t).trim()) < 0)
        if (missing.length) {
          throw new AppError(CODES.CONFLICT, `还有 ${missing.length} 项必须条件未确认：${missing[0]}`)
        }
      }

      /* 合同审核通过前不做独家锁：多家都可以领取并各自生成工单；
         任一家居间合同归档后由 lockAgencyForContract 收敛为唯一对接方 */

      if (!existing) {
        try {
          await repo.insert('bizClaims', {
            id: claimId,
            uid,
            targetType,
            targetId,
            at
          })
          appendAudit(repo, {
            actorType: 'user',
            actorId: uid,
            action: 'biz.claim',
            target: `${targetType}:${targetId}`,
            reason: '领取商机',
            result: 'allow',
            at
          })
        } catch (err) {
          /* 并发重复领取：已有同一条领取记录时视为成功 */
          const again = await repo.get('bizClaims', claimId)
          if (!again) throw err
        }
      }

      /* 领取即建线索：管理端线索工作台要能看到并推进「已对接 / 已成交」，
         与直聊共用同一个确定性线索号（同一用户 + 同一标的只留一条），并发下以唯一 id 兜底。
         代采 / 代售领取与「申请平台对接」共用同一个工单号，保证商机与工单一一绑定 */
      const agencyLead = targetType === 'agency'
      const leadIdOfClaim = agencyLead
        ? 'ld' + sha256Hex(`agency:${uid}:${targetId}`).slice(0, 24)
        : leadId
      /* 同一委托由同一客服统一对接：同委托已有客服在跟进时，新工单直接落到该客服名下 */
      const agencyCs = agencyLead ? await inheritedAgencyCs(repo, targetId, at) : null
      try {
        const hasLead = await repo.get('leads', leadIdOfClaim)
        if (!hasLead) {
          await repo.insert('leads', agencyLead ? {
            id: leadIdOfClaim,
            source: '商机领取',
            targetType: 'agency',
            targetId,
            agencyId: targetId,
            agencySide,
            agencyTitle: title,
            productId: '',
            demandId: '',
            uid,
            buyerBidx: '',
            formSummary: `在商机池领取「${title}」，申请平台代为对接`,
            compare: [],
            matchPct: 100,
            media: [],
            status: LEAD_STATUS.PENDING,
            assignedTo: agencyCs ? agencyCs.assignedTo : '',
            assignedAccount: agencyCs ? agencyCs.assignedAccount : '',
            assignedAt: agencyCs ? agencyCs.assignedAt : 0,
            tier: TIERS.DEFAULT,
            tierName: '',
            ruleVersion: '',
            hits: [],
            csStatus: agencyCs ? agencyCs.csStatus : CS_STATUS.WAITING,
            csId: agencyCs ? agencyCs.csId : '',
            csName: agencyCs ? agencyCs.csName : '',
            csClaimedAt: agencyCs ? agencyCs.csClaimedAt : 0,
            ticketState: TICKET_STATE.TICKETED,
            serviceStage: CONSULT_STAGE.COMMUNICATING,
            stageAt: at,
            stageBy: '',
            stageVersion: 0,
            stageHistory: [{
              stage: CONSULT_STAGE.COMMUNICATING,
              at,
              by: '',
              note: agencyCs ? '商机领取自动建单，沿用同委托客服' : '商机领取自动建单'
            }],
            createdAt: at,
            updatedAt: at,
            threadId: leadIdOfClaim,
            contactReleased: false
          } : {
            id: leadIdOfClaim,
            source: '商机领取',
            productId: targetType === 'supply' ? targetId : '',
            demandId: targetType === 'demand' ? targetId : '',
            uid,
            buyerBidx: '',
            formSummary: `在商机池领取「${title}」的联系方式`,
            compare: [],
            matchPct: 100,
            media: [],
            status: LEAD_STATUS.PENDING,
            assignedTo: '',
            tier: TIERS.DEFAULT,
            tierName: '',
            ruleVersion: '',
            hits: [],
            createdAt: at,
            threadId: '',
            contactReleased: true
          })
        } else if (agencyLead) {
          /* 领取前已通过客服发起过咨询：只补缺失的绑定字段，不重置工单阶段 */
          const patch = {}
          if (!hasLead.targetType) patch.targetType = 'agency'
          if (!hasLead.targetId) patch.targetId = targetId
          if (!hasLead.agencyId) patch.agencyId = targetId
          if (!hasLead.agencySide) patch.agencySide = agencySide
          if (!hasLead.agencyTitle) patch.agencyTitle = title
          if (!hasLead.ticketState) patch.ticketState = TICKET_STATE.TICKETED
          if (!hasLead.csStatus) patch.csStatus = CS_STATUS.WAITING
          if (!hasLead.serviceStage) {
            patch.serviceStage = CONSULT_STAGE.COMMUNICATING
            patch.stageAt = at
            patch.stageVersion = 0
            patch.stageHistory = [{ stage: CONSULT_STAGE.COMMUNICATING, at, by: '', note: '商机领取补建工单' }]
          }
          if (!hasLead.threadId) patch.threadId = hasLead.id
          /* 老工单还没客服认领，而同一委托已有客服在跟进：直接归到该客服名下 */
          if (!hasLead.assignedAccount && agencyCs) {
            patch.assignedTo = agencyCs.assignedTo
            patch.assignedAccount = agencyCs.assignedAccount
            patch.assignedAt = agencyCs.assignedAt
            patch.csId = agencyCs.csId
            patch.csName = agencyCs.csName
            patch.csClaimedAt = agencyCs.csClaimedAt
            patch.csStatus = agencyCs.csStatus
          }
          if (Object.keys(patch).length) {
            patch.updatedAt = at
            await repo.updateWhere('leads', { id: hasLead.id }, patch)
          }
        }
      } catch (err) {
        /* 并发领取 / 同时直聊：另一路已建好同一条线索，忽略冲突 */
        if (!err || err.code !== CODES.CONFLICT) throw err
      }

      /* 领取时不再给双方发站内信：商机提醒统一在「发布新商机」时发给双方，
         领取后只有对方主动发起对话才会产生聊天消息，避免领取动作重复打扰 */

      /* 领取成功即视为已满足：清掉之前的「不满足」标记，避免继续不提醒 */
      try {
        const markId = 'bm' + sha256Hex(`${uid}:${targetType}:${targetId}`).slice(0, 24)
        const mark = await repo.get('bizMarks', markId)
        if (mark && mark.marked) {
          await repo.updateWhere('bizMarks', { id: markId }, { marked: false, at })
        }
      } catch (err) {
        /* 标记清理失败不影响领取结果 */
      }

      const claimCount = await repo.count('bizClaims', { targetType, targetId })
      const claimMeta = claimMetaOf({ claimCount })
      return {
        id: claimId,
        title,
        already: !!existing,
        claimCount: claimMeta.claimCount,
        claimLimit: claimMeta.claimLimit,
        claimRemaining: claimMeta.claimRemaining,
        claimText: claimMeta.claimText,
        contact: {
          org: contact.org,
          name: contact.name,
          phone: contact.phone
        },
        at: existing ? Number(existing.at) || at : at
      }
    },

    /**
     * 已领取商机的联系方式：只读接口，不消耗每日领取次数。
     * 没有领取记录时不下发联系方式，避免绕过领取直接拿号。
     */
    'biz.contact': async (data, ctx) => {
      const uid = ctx.openid
      const targetType = enumOf(
        data.targetType || (data.demandId ? 'demand' : (data.supplyId ? 'supply' : 'agency')),
        ['demand', 'agency', 'supply'],
        '商机类型'
      )
      const targetIdKey = targetType === 'demand' ? 'demandId' : (targetType === 'supply' ? 'supplyId' : 'agencyId')
      const targetId = str(data[targetIdKey], {
        field: '商机标识',
        required: true,
        max: 64
      })
      const claimId = 'bc' + sha256Hex(`${uid}:${targetType}:${targetId}`).slice(0, 24)
      const claim = await repo.get('bizClaims', claimId)
      if (!claim) return { claimed: false, contact: null }

      let contact = null
      if (targetType === 'demand') {
        const demand = await repo.get('demands', targetId)
        if (demand && !demand.deleted && demand.ownerId !== uid) contact = await contactOfUser(demand.ownerId)
      } else if (targetType === 'supply') {
        const product = await repo.get('products', targetId)
        if (product && !product.deleted && product.ownerId !== uid) contact = await contactOfUser(product.ownerId)
      } else {
        /* 委托方主体不对外下发：领取后统一显示为平台 */
        contact = { org: '平台', name: '平台代为对接', phone: '' }
      }
      return {
        claimed: true,
        contact: contact ? { org: contact.org, name: contact.name, phone: contact.phone } : null
      }
    },

    /**
     * 标记 / 取消「不满足」：商机仍保留在列表里，
     * 但不进「可领取」分组、不再计入首页角标提醒。
     */
    'biz.mark': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const targetType = enumOf(data.targetType, ['demand', 'supply', 'agency'], '商机类型')
      const targetId = str(data.targetId, { field: '商机标识', required: true, max: 64 })
      const marked = data.marked !== false
      const at = now()

      /* 只接受仍存在的商机：发布者删除后不再允许写入标记 */
      const sourceCollection = targetType === 'demand'
        ? 'demands'
        : (targetType === 'supply' ? 'products' : 'agencies')
      const source = await repo.get(sourceCollection, targetId)
      if (!source || source.deleted) {
        throw new AppError(CODES.NOT_FOUND, '商机不存在或已被发布者删除')
      }

      const id = 'bm' + sha256Hex(`${uid}:${targetType}:${targetId}`).slice(0, 24)
      const existing = await repo.get('bizMarks', id)
      if (existing) {
        if (existing.marked !== marked) {
          await repo.updateWhere('bizMarks', { id }, { marked, at })
        }
      } else {
        try {
          await repo.insert('bizMarks', { id, uid, targetType, targetId, marked, at })
        } catch (err) {
          /* 并发重复标记：同一标识只保留一条，按幂等处理 */
          const again = await repo.get('bizMarks', id)
          if (!again) throw err
          if (again.marked !== marked) await repo.updateWhere('bizMarks', { id }, { marked, at })
        }
      }
      return { marked, targetType, targetId }
    },

    /**
     * 删除我领取的商机：只移除本人的领取记录，商机回到池里可继续领取。
     */
    'biz.delete': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const targetType = enumOf(data.targetType, ['demand', 'supply', 'agency'], '商机类型')
      const targetId = str(data.targetId, { field: '商机标识', required: true, max: 64 })
      const at = now()
      const claimId = 'bc' + sha256Hex(`${uid}:${targetType}:${targetId}`).slice(0, 24)
      const claim = await repo.get('bizClaims', claimId)
      if (claim) await repo.removeWhere('bizClaims', { id: claimId }, 1)

      if (targetType === 'agency') {
        const lockId = 'AC' + sha256Hex(`agency-claim:${targetId}`).slice(0, 22)
        const lock = await repo.get('agencyClaims', lockId)
        if (lock && lock.uid === uid) {
          await repo.removeWhere('agencyClaims', { id: lockId }, 1)
          await repo.updateWhere('agencies', { id: targetId }, { claimUid: '', claimAt: 0, updatedAt: at })
        }
      }

      if (claim) {
        appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'biz.delete',
          target: `${targetType}:${targetId}`,
          reason: '删除我领取的商机',
          result: 'allow',
          at
        })
      }
      return { deleted: !!claim, targetType, targetId }
    },

    /** 收藏等场景按 id 批量取委托卡：内容本身已公开，不再额外收会员限制 */
    'biz.cards': async (data) => {
      const ids = arrayOfStrings(data && data.ids, { field: '委托标识', max: 50, itemMax: 64 })
      if (!ids.length) return { items: [] }
      const at = now()
      const rows = await repo.find('agencies', {
        id: { $in: ids },
        visibility: { $ne: VISIBILITIES.PRIVATE },
        deleted: { $ne: true }
      }, { limit: ids.length })
      return {
        items: rows.map((doc) => agencyViewOf(doc, {
          now: at,
          contact: '平台代为对接',
          phone: ''
        }))
      }
    },

    /**
     * 代采 / 代售：用户不能直接联系委托方，由平台代为对接。
     * 提交后生成客服工单，客服联系核实库存与交付条件后，再把采购方信息推给对方。
     */
    'biz.consult': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      /* 商机对接属于「发起对话」：受限期间不允许新发起 */
      assertAllowed(user, 'chat')
      const at = now()

      /* 兼容前端传 agencyId / id，避免两端口径不一致 */
      const agencyId = str(data.agencyId || data.id, { field: '委托标识', required: true, max: 64 })
      /* 用户从「填写完整需求」带过来的内容：坐席跟进前先看，未填写时用库存匹配摘要 */
      const summary = str(data.summary, { field: '需求说明', max: 500 })
      /* 咨询表单里上传的图片 / 视频：随需求一起作为会话消息发送，客服领取后即可看到 */
      const consultMedia = []
      const rawMedia = Array.isArray(data.media) ? data.media.slice(0, 12) : []
      for (const item of rawMedia) {
        const m = item || {}
        const kind = m.kind === 'video' ? 'video' : (m.kind === 'image' ? 'image' : '')
        const url = kind ? String(m.url || '') : ''
        if (!kind || !/^(https:\/\/|cloud:\/\/)/i.test(url)) continue
        consultMedia.push({ kind, url })
      }
      const agency = await expireAgencyIfNeeded(repo, await repo.get('agencies', agencyId), at)
      if (!agency || agency.deleted || agency.status === AGENCY_STATUS.CLOSED) {
        throw new AppError(CODES.NOT_FOUND, '委托不存在或已关闭')
      }
      if (agency.status !== AGENCY_STATUS.ACTIVE) {
        throw new AppError(
          CODES.CONFLICT,
          agency.status === AGENCY_STATUS.LOCKED ? '该委托已锁定唯一对接方，暂不能对接' : '委托尚未上架或已下架，暂不能对接'
        )
      }
      if (agencyDeadlineAt(agency) && agencyDeadlineAt(agency) < at) {
        throw new AppError(CODES.CONFLICT, '委托已过期，暂不能对接')
      }
      if (agency.visibility === VISIBILITIES.PRIVATE) {
        throw new AppError(CODES.FORBIDDEN, '该委托为保密发布，不进入商机池')
      }
      /* 自己发布的委托一律不能自己响应，先于权限校验，避免「自己的单也要先付费开通」 */
      if (agency.ownerId === uid) {
        throw new AppError(CODES.VALIDATION, '不能响应自己发布的委托')
      }

      const access = await ownAccess(uid)
      if (!accessView(access, at).unlocked) {
        throw new AppError(CODES.FORBIDDEN, '商机权限未开通或已到期，请先开通商机')
      }
      /* 咨询对接不再要求公开主体：会员校验通过即可，主体信息仅在展示时脱敏 */

      const stocks = await ownStocks(uid)
      const prefs = normalizeBizPrefs(await repo.get('bizPrefs', uid))
      /* 代采（平台代买）对应货主方：用我的库存匹配；代售（平台代卖）对应需求方：用我的求购需求匹配 */
      const isSell = agency.side === 'sell'
      let match = null
      if (isSell) {
        const myDemands = await repo.find('demands', {
          ownerId: uid,
          status: '求购中',
          deleted: { $ne: true }
        }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
        const agencyStock = {
          id: agency.id,
          cat: agency.itemCat || '',
          model: agency.item || '',
          brand: '',
          qty: Number(agency.qty) || 0,
          price: Number(agency.price) || 0,
          city: agency.city || '',
          cond: '',
          tax: '',
          supply: ''
        }
        for (const demand of myDemands) {
          const hit = stockMatch([agencyStock], demand.cat, demand.model, demand.brand, {
            qty: demand.qty,
            price: demand.budget,
            priceMax: demand.budgetMax,
            city: demand.city,
            cond: demand.cond,
            tax: demand.tax,
            supply: demand.supply,
            series: demand.series,
            /* 代售委托是对方货盘：指定城市按委托所在城市过滤 */
            pickCity: agency.city,
            pref: prefs
          })
          if (hit.ok) {
            match = hit
            break
          }
        }
      } else {
        match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
          qty: agency.qty,
          /* 委托价格口径与供需不同（可能含服务费 / 整单），价格档位只作用于求购与货源 */
          city: agency.city,
          series: agency.series,
          pref: prefs
        })
      }
      if (!match || !match.ok) {
        throw new AppError(
          CODES.FORBIDDEN,
          isSell
            ? '我发布的需求中没有匹配的型号，无法申请平台对接'
            : '我的库存中没有匹配的型号，无法申请平台对接'
        )
      }

      /* 先领取再对接：未领取委托时不允许直接申请平台对接 */
      const claimId = 'bc' + sha256Hex(`${uid}:agency:${agency.id}`).slice(0, 24)
      const claimed = await repo.get('bizClaims', claimId)
      if (!claimed) {
        throw new AppError(CODES.CONFLICT, '请先在商机里确认交易条件并领取该委托，再申请平台对接')
      }

      /* 不做独家锁：多个匹配会员都可以领取并申请平台对接，由平台择优推进 */
      const isBuy = agency.side === 'buy'
      const agencyTitle = `${agency.kind || (isBuy ? '代采' : '代售')} ${agency.item || ''}`.trim()
      /* 咨询内容直接写进客服会话：先打招呼，再带上表单里填写的完整需求 */
      const consultBody = summary
        ? `你好，我想咨询平台「${agencyTitle}」业务。我的完整需求：${summary}`
        : `你好，我想与你咨询一下「${agency.item || ''}」设备，看到后请及时回复。`
      const writeConsultMessage = async (body, createdAt) => {
        const msgId = 'M' + sha256Hex(`cs-consult:${leadId}:${body}`).slice(0, 22)
        /* 同一内容重复提交只保留一条：用户刷新 / 再次补充时不重复刷屏，也不撞唯一键 */
        if (await repo.get('outbox', msgId)) return
        await repo.insert('outbox', {
          id: msgId,
          type: 'kf.chat',
          payload: {
            uid,
            channel: 'kf',
            from: 'user',
            staffName: '',
            threadId: leadId,
            targetType: 'agency',
            targetId: agency.id,
            title: agencyTitle,
            body,
            csStatus: CS_STATUS.WAITING
          },
          status: 'pending',
          createdAt
        })
      }
      const leadId = 'ld' + sha256Hex(`agency:${uid}:${agency.id}`).slice(0, 24)
      /* 图片 / 视频逐条写成会话消息，排在需求说明之后、等待提示之前 */
      const writeMediaMessages = async (baseAt) => {
        for (let i = 0; i < consultMedia.length; i++) {
          const m = consultMedia[i]
          const mediaId = 'M' + sha256Hex(`cs-media:${leadId}:${m.url}`).slice(0, 22)
          if (await repo.get('outbox', mediaId)) continue
          await repo.insert('outbox', {
            id: mediaId,
            type: 'kf.chat',
            payload: {
              uid,
              channel: 'kf',
              from: 'user',
              staffName: '',
              threadId: leadId,
              targetType: 'agency',
              targetId: agency.id,
              title: agencyTitle,
              body: m.kind === 'image' ? '[图片]' : '[视频]',
              kind: m.kind,
              image: m.kind === 'image' ? m.url : '',
              video: m.kind === 'video' ? m.url : '',
              poster: '',
              csStatus: CS_STATUS.WAITING
            },
            status: 'pending',
            readByUser: true,
            readByStaff: false,
            createdAt: baseAt + i
          })
        }
      }
      const existing = await repo.get('leads', leadId)
      /* 同一委托统一由一个客服跟进：新单 / 重新咨询都沿用同委托下正在跟进的客服 */
      const agencyCs = await inheritedAgencyCs(repo, agency.id, at)
      if (existing) {
        /* 风控拦截是终态：不允许通过重复提交继续咨询 */
        if (existing.status === LEAD_STATUS.BLOCKED) {
          throw new AppError(CODES.FORBIDDEN, '该商机咨询已被风控拦截，请联系在线客服')
        }
        /* 已关闭 / 服务已结束：同一委托只保留一条工单，重新开启回到待领取，客服可再次接入 */
        let current = existing
        const ended = (existing.csStatus || CS_STATUS.WAITING) === CS_STATUS.ENDED
        if (existing.status === LEAD_STATUS.CLOSED || ended) {
          const reopen = {
            status: LEAD_STATUS.PENDING,
            csStatus: agencyCs ? agencyCs.csStatus : CS_STATUS.WAITING,
            /* 用户咨询直接生成工单：重新咨询即回到「待领取」工单（同一委托已有客服时直接归属该客服） */
            ticketState: TICKET_STATE.TICKETED,
            assignedAccount: agencyCs ? agencyCs.assignedAccount : '',
            assignedTo: agencyCs ? agencyCs.assignedTo : '',
            assignedAt: agencyCs ? agencyCs.assignedAt : 0,
            csClaimedAt: agencyCs ? agencyCs.csClaimedAt : 0,
            csId: agencyCs ? agencyCs.csId : '',
            csName: agencyCs ? agencyCs.csName : '',
            /* 上一轮可能停在「已完成 / 已终止」，重新咨询从沟通中重新开始 */
            serviceStage: CONSULT_STAGE.COMMUNICATING,
            stageAt: at,
            stageBy: '',
            stageNote: '用户重新咨询',
            stageVersion: (Number(existing.stageVersion) || 0) + 1,
            stageHistory: [{ stage: CONSULT_STAGE.COMMUNICATING, at, by: '', note: '用户重新咨询' }],
            intakeBody: consultBody,
            intakeMedia: consultMedia,
            intakeAt: at,
            /* 上一轮结束痕迹清空：否则用户端仍显示服务已结束 / 一直带着旧的结束时间 */
            csEndedAt: 0,
            csEndedBy: '',
            csEndedByName: '',
            closeReason: '',
            closedAt: 0,
            updatedAt: at
          }
          await repo.updateWhere('leads', { id: leadId }, reopen)
          current = Object.assign({}, existing, reopen)
          /* 重新开启要留痕：客服与审计可追溯「已关闭工单被用户再次咨询」 */
          appendAudit(repo, {
            actorType: 'user',
            actorId: uid,
            action: 'biz.consult',
            target: `agency:${agency.id}`,
            reason: `已关闭工单 ${leadId} 重新咨询，自动回到待领取`,
            result: 'allow',
            at
          })
        }
        const stateNow = ticketStateOf(current)
        /* 还没被领取的工单：只更新需求内容，不往会话里写消息（客服领取时统一接入）；
           已领取的工单：补充内容直接同步一条消息 */
        if (stateNow === TICKET_STATE.INTAKE || stateNow === TICKET_STATE.CONSULTING || !current.assignedAccount) {
          await repo.updateWhere('leads', { id: leadId }, {
            formSummary: summary || current.formSummary,
            intakeBody: consultBody,
            intakeMedia: consultMedia,
            intakeAt: at,
            updatedAt: at
          })
          if (stateNow === TICKET_STATE.CONSULTING && current.assignedAccount) {
            await writeConsultMessage(consultBody, at)
            await writeMediaMessages(at + 1)
          }
          return {
            leadId,
            threadId: leadId,
            already: true,
            status: current.status,
            csStatus: current.csStatus || CS_STATUS.WAITING,
            ticketState: stateNow,
            consulted: true,
            hint: current.assignedAccount
              ? '需求已补充，客服会在会话中查看'
              : '需求已提交，平台客服领取工单后会与你联系'
          }
        }
        /* 存量咨询 / 已生成工单：客服已在消息中心跟进，补充内容直接进会话 */
        if (summary && summary !== current.formSummary) {
          await repo.updateWhere('leads', { id: leadId }, { formSummary: summary, updatedAt: at })
          await writeConsultMessage(consultBody, at)
          await writeMediaMessages(at + 1)
        } else {
          await writeMediaMessages(at)
        }
        return {
          leadId,
          threadId: leadId,
          already: true,
          status: current.status,
          csStatus: current.csStatus || CS_STATUS.WAITING,
          ticketState: stateNow,
          consulted: true,
          hint: '需求已提交，正在等待平台客服处理'
        }
      }
      await repo.insert('leads', {
        id: leadId,
        uid,
        source: isBuy ? '代采对接' : '代售对接',
        targetType: 'agency',
        targetId: agency.id,
        agencyId: agency.id,
        agencySide: agency.side,
        agencyTitle: `${agency.kind || (isBuy ? '代采' : '代售')} ${agency.item || ''}`.trim(),
        productId: '',
        demandId: '',
        formSummary: summary || (isSell
          ? `我发布的需求可匹配「${agency.item || ''}」，申请平台代为对接`
          : `库存可匹配「${agency.item || ''}」${match.qty ? `，可供 ${match.qty} 台` : ''}，申请平台代为对接`),
        compare: [],
        matchPct: 100,
        status: LEAD_STATUS.PENDING,
        tier: TIERS.DEFAULT,
        tierName: '',
        assignedTo: agencyCs ? agencyCs.assignedTo : '',
        assignedAccount: agencyCs ? agencyCs.assignedAccount : '',
        assignedAt: agencyCs ? agencyCs.assignedAt : 0,
        contactReleased: false,
        /* 客服服务状态：同一委托已有客服在跟进时直接归属该客服，否则进入待领取 */
        csStatus: agencyCs ? agencyCs.csStatus : CS_STATUS.WAITING,
        csClaimedAt: agencyCs ? agencyCs.csClaimedAt : 0,
        csId: agencyCs ? agencyCs.csId : '',
        csName: agencyCs ? agencyCs.csName : '',
        /* 用户咨询直接生成工单：先进入「待领取」，客服领取后即可对话；
           领取前不写会话消息，避免客服未接单时用户与空会话对话 */
        ticketState: TICKET_STATE.TICKETED,
        intakeBody: consultBody,
        intakeMedia: consultMedia,
        intakeAt: at,
        threadId: leadId,
        createdAt: at,
        updatedAt: at
      })
      appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'biz.consult',
        target: `agency:${agency.id}`,
        reason: '申请平台代为对接代采 / 代售委托',
        result: 'allow',
        at
      })
      return {
        leadId,
        threadId: leadId,
        already: false,
        status: LEAD_STATUS.PENDING,
        csStatus: agencyCs ? agencyCs.csStatus : CS_STATUS.WAITING,
        ticketState: TICKET_STATE.TICKETED,
        consulted: true,
        hint: agencyCs
          ? `本委托由客服 ${agencyCs.csName} 统一对接，可直接在会话中沟通`
          : '需求已提交，平台客服领取工单后会与你联系'
      }
    }
  }
}

/* ============================================================
   管理端 handlers
   ============================================================ */

function createMarketAdminHandlers(deps) {
  const { repo, keys } = deps
  /* 微信订阅消息：站内信同步推送 */
  const subscribe = deps.subscribe
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  /* 推广分佣：支付成功实时计佣，退款自动冲正 */
  const promoteEngine = createPromoteEngine({ repo, keys, now })
  /* 客服业务：会员支付自动计提成、绑定关系、比例与档案 */
  const csEngine = createCsEngine({ repo, now })

  async function staffLabel(ctx) {
    const username = String((ctx && ctx.accountId) || '')
    if (!username) return ''
    const rows = await repo.find('accounts', { username }, { limit: 1 })
    return (rows[0] && (rows[0].name || rows[0].username)) || username
  }

  async function roleOf(ctx) {
    return String((ctx && ctx.session && ctx.session.role) || '')
  }

  async function audit(ctx, action, target, reason, result) {
    appendAudit(repo, {
      actorType: 'admin',
      actorId: (ctx && ctx.accountId) || 'admin',
      action,
      target: target || '',
      reason: reason || '',
      result: result || 'allow',
      at: now()
    })
  }

  /** 站内信：平台处置结果统一回执给当事人，用户端「消息」可见 */
  async function notifyUser(uid, { title, body, reason, targetType, targetId }) {
    if (!uid) return
    await repo.insert('outbox', {
      id: randomId('M'),
      type: 'system.notice',
      payload: {
        uid,
        channel: 'system',
        from: 'system',
        title,
        body,
        reason: reason || '',
        targetType: targetType || '',
        targetId: targetId || ''
      },
      status: 'pending',
      createdAt: now()
    })
    /* 站内信同步推微信订阅消息：商机类消息受用户「商机提醒」开关控制 */
    if (subscribe) {
      const push = targetType === 'biz' ? subscribe.biz : subscribe.system
      await push(uid, { title, body, at: now() }).catch(() => {})
    }
  }

  /* 退款风控窗口：90 天内累计 2 次退款即视为高风险，禁止再自助开通 */
  const REFUND_RISK_WINDOW_MS = 90 * DAY_MS
  /* iOS 退款问询的免争议窗口：7 天内且未领取商机才建议退款 */
  const REFUND_FREE_WINDOW_MS = 7 * DAY_MS

  /** 退款风控计数：同一用户 90 天内第 2 次退款起标记风险，推广资格与自助开通都看这个标记 */
  async function markRefundRisk(uid, at) {
    if (!uid) return null
    const user = await repo.get('users', uid)
    if (!user) return null
    const lastAt = Number(user.lastRefundAt) || 0
    const count = lastAt > 0 && at - lastAt <= REFUND_RISK_WINDOW_MS
      ? (Number(user.refundCount) || 0) + 1
      : 1
    const patch = { refundCount: count, lastRefundAt: at, updatedAt: at }
    if (count >= 2 && !user.riskFlag) {
      patch.riskFlag = true
      patch.riskSince = at
      patch.riskReason = '90 天内累计退款 ' + count + ' 次'
    }
    await repo.updateWhere('users', { id: uid }, patch)
    return { count, risky: !!(patch.riskFlag || user.riskFlag) }
  }

  /**
   * 服务费到账后统一收口：回写委托单 → 计提客服佣金 → 工单进入「服务费已到账」。
   * 三条成功路径（首次确认 / 并发幂等 / 已确认回放）都要走这里，
   * 佣金按 paymentId 幂等，重复确认不会重复计提。
   */
  async function settleAgencyFee(row, at, staff) {
    const agencyId = String((row && row.agencyId) || '')
    if (!agencyId) return
    const agency = await repo.get('agencies', agencyId)
    const lead = await consultLeadOfAgency(repo, agencyId)
    const contract = lead
      ? (await repo.find('agencyContracts', { leadId: lead.id }, { limit: 1 }))[0]
      : null
    /* 成交坐席快照优先：工单转派后仍按成交时的坐席计提佣金 */
    const csId = String((agency && agency.dealCsId) || (lead && lead.assignedAccount) || '')
    const csName = String((agency && agency.dealCsName) || (lead && lead.assignedTo) || '')
    const feeAmount = Number(row.received) || Number(row.amount) || 0
    if (csId && feeAmount > 0) {
      try {
        await csEngine.recordAgencyFeePaid({
          paymentId: row.paymentId || row.outTradeNo || row.id,
          csId,
          csName,
          agencyId,
          leadId: lead ? lead.id : '',
          contractId: contract ? contract.id : '',
          contractNo: contract ? (contract.contractNo || '') : '',
          side: (agency && agency.side) || (lead && lead.side) || 'buy',
          item: (agency && (agency.item || agency.itemCat)) || (lead && lead.agencyTitle) || '',
          feeAmount,
          paidAt: Number(row.confirmedAt) || at
        })
      } catch (err) {
        /* 计提失败不阻断到账确认：记审计后由财务在客服工资里手工补录 */
        console.error('[cs] 代采代售佣金计提失败 ' + (err && err.message))
        appendAudit(repo, {
          actorType: 'system',
          actorId: 'system',
          action: 'cs.agencyCommission',
          target: String(row.id || ''),
          reason: `佣金计提失败：${(err && err.message) || ''}`,
          result: 'deny',
          at
        })
      }
    }
    if (lead) {
      await advanceConsultStageQuiet(repo, agencyId, CONSULT_STAGE.FEE, CONSULT_STAGE.PAID, {
        at,
        by: staff || 'system',
        actorType: 'admin',
        note: `服务费已到账 ¥${feeAmount}`,
        extra: { feePaidAt: at, feeAmount }
      })
    }
  }

  /**
   * 会员退款回滚：管理端退款、用户退款审核、微信 / Apple 退款推送共用同一套口径。
   * 退款即停：收款单置已退款，会员权限同步停用且剩余天数不补；风控计数只对会员单生效。
   */
  async function rollbackPayment(row, opts) {
    const options = opts || {}
    const at = Number(options.at) || now()
    const reason = String(options.reason || '退款').slice(0, 100)
    const staff = String(options.staff || '')
    const source = String(options.source || '')
    if (!row) return { refunded: false }
    if (row.status === PAYMENT_STATUS.REFUNDED) {
      return { id: row.id, status: row.status, refunded: true, skipped: true }
    }
    /* 已出款佣金必须先由财务在商户平台完成「分账回退」并回填，才允许把退款置成功；
       未回填直接拒绝，避免退款成功但佣金无法追回。
       微信 / Apple 退款推送属于「退款已在支付渠道发生」，无法拦截，
       只能照常退款并把未回退的佣金记为欠款（见 3.9），因此传 force 跳过前置校验 */
    const paymentKey = row.paymentId || row.outTradeNo || row.id
    if (options.force !== true) {
      const commissions = await repo.find('commissions', { paymentId: paymentKey })
      const paidOut = commissions.filter((item) => Number(item.withdrawnAmount) > 0 || item.status === '已提现')
      for (const item of paidOut) {
        const backfilled = await repo.find('promotePayoutItems', {
          commissionId: item.id,
          type: 'splitRefund',
          status: 'done'
        }, { limit: 1 })
        /* v5.1 人工分账：财务在中台「佣金冲正」时回填了回退单号，佣金自身留有 refundNo / refundAt */
        const manualBackfill = !!String(item.refundNo || '') && Number(item.refundAt) > 0
        if (!backfilled.length && !manualBackfill) {
          throw new AppError(CODES.CONFLICT, '该笔支付对应的佣金已出款，请先在微信支付商户平台完成分账回退，并在中台「推广管理 · 佣金明细」冲正时回填回退单号后再处理退款')
        }
      }
    }
    await repo.updateWhere('payments', { id: row.id }, {
      status: PAYMENT_STATUS.REFUNDED,
      refundedAt: at,
      refundedBy: staff || source,
      refundSource: source,
      refundReason: reason,
      updatedAt: at
    })
    /* 推广佣金同步冲正：待结算直接冲、可提现扣回、已提现转欠款 */
    try {
      await promoteEngine.reverseCommission({
        paymentId: row.paymentId || row.outTradeNo || row.id,
        reason: `退款冲正：${reason}`,
        at
      })
    } catch (promoteErr) {
      /* 退款已生效：佣金冲正失败不回滚，由对账任务补偿 */
      console.error('[promote] 佣金冲正失败 ' + (promoteErr && promoteErr.message))
    }
    /* 客服代采代售佣金同步冲正：只按 paymentId 标记已冲正，工资按冲正当月扣回 */
    try {
      await csEngine.reverseAgencyCommission({
        paymentId: row.paymentId || row.outTradeNo || row.id,
        reason: `退款冲正：${reason}`,
        at
      })
    } catch (csErr) {
      console.error('[cs] 佣金冲正失败 ' + (csErr && csErr.message))
    }
    if (row.agencyId) {
      /* 委托单服务费回到待支付，工单从「已到账」退回「待支付」重新收款。
         清空账单引用：原账单保留为退款记录，由 ensureAgencyFeeBill 重开顺延账单，
         否则账单停在「已退款」状态，用户重新打款后财务永远无法确认 */
      await repo.updateWhere('agencies', { id: row.agencyId }, {
        feeStatus: 'pending',
        feePaidAt: 0,
        feeBillId: '',
        feeBilledAt: 0,
        updatedAt: at
      })
      /* 已完成后再退款：委托退回「已成交」、清空完成信息，等重新收款后再确认完成，
         避免出现「已完成 + 服务费待支付」这种无法收尾的状态 */
      const doneAgency = await repo.get('agencies', row.agencyId)
      if (doneAgency && doneAgency.status === AGENCY_STATUS.DONE) {
        await repo.updateWhere('agencies', { id: row.agencyId, status: AGENCY_STATUS.DONE }, {
          status: AGENCY_STATUS.DEALT,
          completedAt: 0,
          completedBy: '',
          updatedAt: at
        })
      }
      const agencyDoc = await repo.get('agencies', row.agencyId)
      if (agencyDoc) await ensureAgencyFeeBill(repo, agencyDoc, at)
      await advanceConsultStageQuiet(repo, row.agencyId, CONSULT_STAGE.PAID, CONSULT_STAGE.FEE, {
        at,
        by: staff || source || 'system',
        actorType: 'admin',
        note: `服务费退款，退回待支付：${reason}`
      })
      await advanceConsultStageQuiet(repo, row.agencyId, CONSULT_STAGE.DONE, CONSULT_STAGE.FEE, {
        at,
        by: staff || source || 'system',
        actorType: 'admin',
        note: `已完成后退款，重新收款：${reason}`
      })
    }
    let risk = null
    if (row.orderId && options.revoke !== false) {
      const access = await repo.get('bizAccess', row.uid)
      if (access) {
        await repo.updateWhere('bizAccess', { id: row.uid }, {
          status: BIZ_STATUS.STOPPED,
          expireAt: at,
          updatedAt: at,
          staff,
          note: `退款停用：${reason}`
        })
      }
      risk = await markRefundRisk(row.uid, at)
    }
    appendAudit(repo, {
      actorType: options.actorType || 'admin',
      actorId: staff || source || 'system',
      action: 'payment.refund',
      target: row.id,
      reason: [reason, source].filter(Boolean).join(' · '),
      result: 'allow',
      at
    })
    try {
      await notifyUser(row.uid, {
        title: '收款已退款',
        body: `你支付的 ${row.received} 元已退款：${reason}。如有疑问请联系平台客服。`,
        reason,
        targetType: 'payment',
        targetId: row.id
      })
    } catch (notifyErr) { /* 退款已生效：回执失败不回滚 */ }
    return { id: row.id, status: PAYMENT_STATUS.REFUNDED, refunded: true, risk }
  }

  /** 站内信回执：资讯审核 / 下架结果同步给投稿人（官方资讯没有投稿人，跳过） */
  async function notifyContributor(doc, title, body) {
    if (!doc || doc.official || !doc.uid) return
    await notifyUser(doc.uid, {
      title,
      body,
      reason: doc.reason || '',
      targetType: 'news',
      targetId: doc.id
    })
  }

  /**
   * 会员开通 / 续费核心逻辑（手工开通与收款确认共用）：
   * 未到期顺延、已到期从当日重算，每次写一条 bizOrders 流水。
   */
  async function grantMembership(data, ctx) {
    const uid = str(data.uid, { field: '用户标识', required: true, max: 64 })
    const plans = await resolvePlans(repo)
    const plan = data.plan ? plans.find((item) => item.key === String(data.plan)) : null
    if (data.plan && !plan) throw new AppError(CODES.VALIDATION, '套餐不存在')
    /* 收款单里落的天数优先：管理端改过套餐天数后仍按用户实际购买的时长开通 */
    const days = data.days
      ? intOf(data.days, '开通天数', 1, 3650)
      : (plan ? plan.days : intOf(BIZ_PLAN.days, '开通天数', 1, 3650))
    const user = await repo.get('users', uid)
    if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
    const externalPaymentId = str(data.paymentId, { field: '收款单', max: 64 }) || ''
    /* 同一收款单只开通一次：并发确认 / 重复点击时直接回放上次结果 */
    if (externalPaymentId) {
      const done = await repo.find('bizOrders', { paymentId: externalPaymentId }, { limit: 1 })
      if (done.length) {
        const access = await repo.get('bizAccess', uid)
        const view = accessView(access, now())
        view.orderId = done[0].id
        view.orderAmount = Number(done[0].amount) || 0
        view.planKey = done[0].planKey
        view.planLabel = done[0].planLabel
        return view
      }
    }
    const at = now()
    const staff = await staffLabel(ctx)
    const existing = await repo.get('bizAccess', uid)
    const activeUntil = existing && existing.status === BIZ_STATUS.ACTIVE && Number(existing.expireAt) > at
      ? Number(existing.expireAt)
      : 0
    const base = activeUntil || at
    /* 套餐购买按自然月到期：月度 = 下月同日 23:59:59 前结束，月末没有同日则到最后一天；
       管理端手工按天开通（无套餐档位）的仍按天计算 */
    const planMonths = plan && BIZ_PLAN_MONTHS[plan.key] ? BIZ_PLAN_MONTHS[plan.key] : 0
    const qty = planMonths && plan.days > 0 ? Math.max(1, Math.round(days / plan.days)) : 0
    const expireAt = planMonths
      ? monthlyExpireAt(activeUntil ? activeUntil + 1000 : at, planMonths * qty)
      : base + days * DAY_MS
    const original = plan ? plan.original : Math.round((BIZ_PLAN.price / BIZ_PLAN.days) * days * 100) / 100
    const amount = data.amount === undefined || data.amount === ''
      ? (plan ? plan.price : BIZ_PLAN.price)
      : Math.max(0, Math.round(Number(data.amount) * 100) / 100)
    if (!Number.isFinite(amount)) throw new AppError(CODES.VALIDATION, '实收金额不合法')
    const note = str(data.note, { field: '备注', max: 200 }) || ''
    const patch = {
      id: uid,
      uid,
      status: BIZ_STATUS.ACTIVE,
      plan: plan ? plan.price : BIZ_PLAN.price,
      planKey: plan ? plan.key : 'custom',
      planLabel: plan ? plan.label : `按天开通（${days} 天）`,
      days,
      expireAt,
      updatedAt: at,
      staff,
      note
    }
    if (existing) {
      await repo.updateWhere('bizAccess', { id: uid }, patch)
    } else {
      await repo.insert('bizAccess', Object.assign({ appliedAt: at }, patch))
    }
    /* 会员订单流水：开通 / 续费 / 人工调整都留痕，便于财务对账与用户会员记录 */
    const orderId = randomId('BO')
    /* 手动开通没有微信收款单号：生成 MANUAL-<订单号> 作为收款流水号，
       让营收、推广佣金、客服提成与在线支付共用同一套台账与幂等口径 */
    const paymentId = externalPaymentId || ('MANUAL-' + orderId)
    const order = {
      id: orderId,
      uid,
      nick: user.nick || '',
      planKey: patch.planKey,
      planLabel: patch.planLabel,
      days,
      original,
      discount: Math.max(0, Math.round((original - amount) * 100) / 100),
      amount,
      startAt: base,
      expireAt,
      method: str(data.method, { field: '收款方式', max: 30 }) || '企业微信收款',
      /* 支付渠道：wxpay / apple / manual（手动开通）；Apple 收入在财务中心单独出表 */
      channel: externalPaymentId
        ? (String(data.channel || '').toLowerCase() === 'apple' || String(data.channel || '').toLowerCase() === 'ios'
          ? 'apple'
          : 'wxpay')
        : 'manual',
      /* 订单只记真实微信收款单号；手动开通的流水号落在 payments，避免会员记录出现伪单号 */
      paymentId: externalPaymentId,
      operator: staff,
      accountId: (ctx && ctx.accountId) || '',
      note,
      createdAt: at
    }
    await repo.insert('bizOrders', order)
    /* 收款单：在线支付按 OutTradeNo 同步；手动开通也落一条收款流水，
       财务现金流、营收与用户退款申请统一认 payments */
    if (paymentId) {
      const paid = await repo.find('payments', { paymentId }, { limit: 1 })
      if (!paid.length) {
        await repo.insert('payments', {
          id: randomId('PY'),
          uid,
          nick: user.nick || '',
          bizType: '会员续费',
          planKey: patch.planKey,
          planLabel: patch.planLabel,
          days,
          amount: original,
          discount: Math.max(0, Math.round((original - amount) * 100) / 100),
          received: amount,
          method: str(data.method, { field: '收款方式', max: 30 }) || (externalPaymentId ? '微信支付' : '企业微信收款'),
          /* 支付渠道：wxpay / apple / manual（手动开通）；manual 不扣支付通道费 */
          channel: externalPaymentId ? (str(data.channel || '', { field: '支付渠道', max: 20 }) || '') : 'manual',
          status: PAYMENT_STATUS.CONFIRMED,
          paidAt: at,
          confirmedAt: at,
          confirmedBy: '系统自动',
          orderId: order.id,
          paymentId,
          outTradeNo: externalPaymentId,
          operator: staff,
          accountId: (ctx && ctx.accountId) || '',
          note,
          createdAt: at,
          updatedAt: at
        })
      }
      /* 推广佣金实时入账：支付成功即写「待结算」，推广者马上可见；
         同一 paymentId 幂等，重复回调不会重复计佣 */
      try {
        /* 同一笔支付一次性结算两级佣金：一级给买家直接推广人，二级给其上家；
           未绑定、已计佣、续费等情况由引擎内部判定并跳过 */
        await promoteEngine.createPaymentCommissions({
          buyerUid: uid,
          paymentId,
          /* 微信支付交易号：用于人工分账出款后按单检索 / 对账，手动 / 虚拟支付与 iOS 为空 */
          transactionId: externalPaymentId
            ? (str(data.transactionId || data.transaction_id || '', { field: '微信支付交易号', max: 64 }) || '')
            : '',
          amount,
          channel: externalPaymentId ? (str(data.channel || '', { field: '支付渠道', max: 20 }) || '') : 'manual',
          planLabel: patch.planLabel,
          at
        })
      } catch (promoteErr) {
        /* 会员已生效：计佣失败不阻断开通，由对账补偿 */
        console.error('[promote] 计佣失败 ' + (promoteErr && promoteErr.message))
      }
    }
    await audit(ctx, 'biz.grant', uid, `开通 / 续费 ${patch.planLabel} · ${days} 天 · 实收 ${amount} 元 · ${staff}`)
    const view = accessView(Object.assign({}, existing, patch), at)
    view.orderId = order.id
    view.orderAmount = amount
    view.planKey = patch.planKey
    view.planLabel = patch.planLabel
    /* 回执：开通结果写站内信，用户不必反复刷新商机页确认 */
    try {
      await notifyUser(uid, {
        title: '商机权限已开通',
        body: `商机权限已开通，有效期至 ${view.expireText || '--'}。现在可以在商机页领取匹配商机并查看联系方式。`,
        targetType: 'biz',
        targetId: uid
      })
    } catch (notifyErr) {
      /* 权限已生效：回执失败不回滚 */
    }
    return view
  }

  return {
    /**
     * 价格水平：以平台在售商品（货盘）为基准，代采 / 代售参考度更高，
     * 再叠加粘贴报价与数量 / 时效修正，收敛为最终价格水平，供管理端确认。
     */
    'price.levels': async (data) => {
      const at = now()
      const limit = Math.min(200, Math.max(1, Number(data.limit) || 100))
      const cat = str(data.cat, { field: '品类', max: 20 })
      const products = await repo.find('products', {
        status: '在售',
        channel: { $ne: PUBLISH_CHANNELS.POOL },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 500 })
      const agencies = await repo.find('agencies', {
        status: AGENCY_STATUS.ACTIVE,
        visibility: { $ne: VISIBILITIES.PRIVATE },
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'confirmedAt', dir: 'desc' }, limit: 300 })
      const quotes = await repo.find('quotes', {
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 300 })
      const items = boardItems({ products, agencies, quotes, now: at, limit: 500 })
        .filter((row) => !cat || row.cat === cat)
        .sort((a, b) => (b.sampleCount || 0) - (a.sampleCount || 0) || (b.priceLevel || 0) - (a.priceLevel || 0))
        .slice(0, limit)
      return {
        at,
        items,
        totals: {
          groups: items.length,
          products: products.length,
          agencies: agencies.length,
          quotes: quotes.length,
          withLevel: items.filter((row) => row.priceLevel > 0).length
        },
        generatedText: dateText(at)
      }
    },

    'agency.list': async (data) => {
      const at = now()
      /* 管理端列表也先兜底到期，避免已过截止时间的委托仍显示为已上架 */
      await expireAgenciesLazy(repo, at)
      const page = normalizePaging(data)
      const status = data.status ? enumOf(data.status, AGENCY_STATUS_LIST, '委托状态') : ''
      /* 支持多状态查询：工作台把「已通过（待缴费）」与历史「待确认」合并展示 */
      const statuses = Array.isArray(data.statuses)
        ? data.statuses.map((s) => enumOf(s, AGENCY_STATUS_LIST, '委托状态'))
        : []
      const side = data.side ? enumOf(data.side, ['buy', 'sell'], '委托类型') : ''
      const keyword = str(data.keyword, { field: '关键词', max: 40 }).toLowerCase()
      const query = { deleted: { $ne: true } }
      if (statuses.length) query.status = { $in: statuses }
      else if (status) query.status = status
      if (side) query.side = side
      const rows = await repo.find('agencies', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        /* 工单量增长后按 200 条采样会搜不到历史委托，这里改为全量后再过滤 / 分页 */
        limit: 100000
      })
      const filtered = keyword
        ? rows.filter((row) => {
          const hay = [row.item, row.subjectMasked, row.creditMasked, row.phoneMasked, row.city].join(' ').toLowerCase()
          return hay.includes(keyword)
        })
        : rows
      /* 工单状态筛选：完成 / 终止的委托不在工作台展示，统一回到本页按状态查看 */
      const consult = data.consult ? enumOf(data.consult, ['active', 'done', 'aborted', 'none'], '工单状态') : ''
      const sortKey = data.sort
        ? enumOf(data.sort, ['created_desc', 'created_asc', 'amount_desc', 'deadline_asc', 'updated_desc'], '排序')
        : 'created_desc'
      /* 一次取全量咨询单，工单状态筛选与排序都不受当前分页限制 */
      const consultLeads = (await repo.find('leads', { targetType: 'agency' }, { limit: 100000 }))
        /* 上架审核工单不是咨询工单，不参与「N 人咨询 / 工单状态」口径 */
        .filter((lead) => lead.ticketKind !== 'audit')
      /* 同一委托可能关联多条咨询单（历史重复提交 / 其他用户也咨询过）：
         优先取已推进阶段的真实工单，其次取仍未结束的，最后才按更新时间兜底，
         避免一条后建的「已关闭」干扰单把已完成的工单覆盖成终止 */
      const consultRankOf = (lead) => {
        if (!lead) return 0
        let score = 0
        if (lead.serviceStage) score += 2
        else if (ticketStateOf(lead) === TICKET_STATE.TICKETED) score += 1
        if (lead.status !== LEAD_STATUS.CLOSED) score += 2
        return score
      }
      const consultMap = {}
      for (const lead of consultLeads) {
        const key = lead.targetId || lead.agencyId
        if (!key) continue
        const prev = consultMap[key]
        if (!prev) {
          consultMap[key] = lead
          continue
        }
        const rank = consultRankOf(lead)
        const prevRank = consultRankOf(prev)
        if (rank > prevRank ||
          (rank === prevRank && Number(lead.updatedAt || 0) > Number(prev.updatedAt || 0))) {
          consultMap[key] = lead
        }
      }
      /* 同一委托的咨询人数：委托列表直接展示「N 人咨询 / M 人对接中」 */
      const consultStatsMap = {}
      for (const lead of consultLeads) {
        const key = lead.targetId || lead.agencyId
        if (!key) continue
        const stat = consultStatsMap[key] || { total: 0, active: 0 }
        stat.total += 1
        if (lead.status !== LEAD_STATUS.CLOSED && lead.status !== LEAD_STATUS.BLOCKED &&
          ticketStateOf(lead) !== TICKET_STATE.INVALID &&
          consultStageOf(lead) !== CONSULT_STAGE.DONE && consultStageOf(lead) !== CONSULT_STAGE.ABORTED) {
          stat.active += 1
        }
        consultStatsMap[key] = stat
      }
      const consultStateOf = (lead) => {
        if (!lead) return 'none'
        /* 先按工单阶段判定：已完成的工单即使随后结束服务被关闭，也仍算「已完成」 */
        if (lead.serviceStage) {
          const stage = consultStageOf(lead)
          if (stage === CONSULT_STAGE.DONE) return 'done'
          if (stage === CONSULT_STAGE.ABORTED) return 'aborted'
        }
        if (lead.status === LEAD_STATUS.CLOSED) return 'aborted'
        return 'active'
      }
      const visible = consult ? filtered.filter((row) => consultStateOf(consultMap[row.id]) === consult) : filtered
      /* 排序口径：提交时间 / 金额 / 截止时间 / 最近更新，默认最新提交在前 */
      const SORTS = {
        created_desc: (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0),
        created_asc: (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0),
        amount_desc: (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0),
        deadline_asc: (a, b) => (agencyDeadlineAt(a) || Number.MAX_SAFE_INTEGER) - (agencyDeadlineAt(b) || Number.MAX_SAFE_INTEGER),
        updated_desc: (a, b) => (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0)
      }
      visible.sort(SORTS[sortKey])
      const total = visible.length
      const start = (page.page - 1) * page.limit
      const pageRows = visible.slice(start, start + page.limit)
      /* 工单里直接展示用户昵称，避免客服拿着 openid 去用户管理里二次检索 */
      const uids = Array.from(new Set(pageRows.map((row) => row.ownerId).filter(Boolean)))
      const [users, profiles, accesses] = await Promise.all([
        uids.length ? repo.find('users', { id: { $in: uids } }, { limit: uids.length }) : [],
        uids.length ? repo.find('profiles', { uid: { $in: uids } }, { limit: uids.length }) : [],
        uids.length ? repo.find('bizAccess', { id: { $in: uids } }, { limit: uids.length }) : []
      ])
      const nickMap = {}
      for (const user of users) nickMap[user.id] = user.nick || user.nickname || ''
      const profileMap = {}
      for (const row of profiles) profileMap[row.uid || row.id] = row
      const accessMap = {}
      for (const row of accesses) accessMap[row.id] = row
      const items = pageRows.map((row) => {
        const view = agencyStaffView(row, at)
        const lead = consultMap[row.id]
        if (lead) {
          /* 管理端「去工单中心登记成交」直接跳到对应工单 */
          view.consultLeadId = lead.id
          view.consultStage = consultStageOf(lead)
          view.consultStageLabel = consultStageLabel(view.consultStage)
          view.consultState = consultStateOf(lead)
          view.consultCsName = lead.csName || lead.assignedTo || ''
          view.consultAt = Number(lead.stageAt || lead.updatedAt) || 0
        }
        const stat = consultStatsMap[row.id] || { total: 0, active: 0 }
        view.consultTotal = stat.total
        view.consultActive = stat.active
        const profile = profileMap[row.ownerId] || {}
        const access = accessMap[row.ownerId] || null
        view.ownerNick = nickMap[row.ownerId] || ''
        /* 对外可见用户ID：与用户端「我的」页同一串，便于客服按 ID 查人 / 开权限 */
        view.ownerUserNo = row.ownerId ? userNoOf(row.ownerId) : ''
        /* 工单抽屉的「发布用户」信息块：补主体 / 城市 / 注册时间 / 会员状态 */
        view.subjectMasked = row.subjectMasked || ''
        view.ownerSubjectType = profile.subjectType || ''
        view.ownerCity = profile.city || row.city || ''
        view.ownerJoined = profile.joined || ''
        view.exposureLabel = profile.exposure ? (EXPOSURE_LABELS[profile.exposure] || '') : ''
        view.ownerMemberStatus = !access ? ''
          : access.status === '已停用' ? '已停用'
            : access.status === '待确认' ? '待确认'
              : access.status === '已开通' && Number(access.expireAt) > at ? '已开通' : '已到期'
        return view
      })
      const counts = {}
      for (const name of AGENCY_STATUS_LIST) counts[name] = 0
      /* 工单状态角标：只随方向变化，不受委托状态 / 关键词影响，切分栏时数字保持稳定 */
      const consultCounts = { active: 0, done: 0, aborted: 0, none: 0 }
      /* 方向角标：全部 / 代采 / 代售三档总量不受当前方向筛选影响，切方向时数字保持稳定 */
      const sideCounts = { all: 0, buy: 0, sell: 0 }
      const all = await repo.find('agencies', { deleted: { $ne: true } }, { limit: 100000 })
      for (const row of all) {
        sideCounts.all += 1
        if (row.side === 'buy') sideCounts.buy += 1
        else if (row.side === 'sell') sideCounts.sell += 1
        if (side && row.side !== side) continue
        counts[row.status] = (counts[row.status] || 0) + 1
        consultCounts[consultStateOf(consultMap[row.id])] += 1
      }
      return { items, total, page: page.page, limit: page.limit, counts, sideCounts, consultCounts }
    },

    'agency.confirm': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const staff = await staffLabel(ctx)
      const before = await repo.get('agencies', id)
      if (!before || before.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      /* 幂等兼容：审核通过已自动上架，重复确认不再要求付款，直接返回详情 */
      if (before.status === AGENCY_STATUS.ACTIVE && before.confirmedAt) {
        return agencyStaffView(before, at)
      }
      const deadlineAt = agencyDeadlineAt(before)
      const res = await repo.updateWhere('agencies', {
        id,
        status: { $in: [AGENCY_STATUS.PENDING, AGENCY_STATUS.APPROVED] }
      }, {
        status: AGENCY_STATUS.ACTIVE,
        confirmedAt: at,
        /* 有截止时间时合同期就是截止时间；历史委托仍按确认上架 + 30 天 */
        expiresAt: deadlineAt || at + AGENCY_TTL_MS,
        materialVerified: true,
        staff,
        reason: '',
        updatedAt: at
      })
      if (!res || !res.count) {
        throw new AppError(CODES.CONFLICT, '委托状态已变化，仅「待确认 / 已通过」可上架')
      }
      await audit(ctx, 'agency.confirm', id, `确认上架 · ${staff}`)
      const doc = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托已上架`,
          body: `委托已上架${doc.visibility === VISIBILITIES.PRIVATE ? '（仅平台可见）' : ''}，截止 ${dateText(agencyDeadlineAt(doc))}；成交确认后再支付服务费。`,
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(doc, at)
    },

    /**
     * 代采 / 代购工单审核：仅「待审核」可操作。
     * 通过 → 直接上架（不再要求缴费确认）；驳回 → 已驳回，必须写原因。
     */
    'agency.review': async (data, ctx) => {
      const id = str(data.id, { field: '工单标识', required: true, max: 64 })
      const decision = enumOf(data.decision, ['通过', '驳回'], '审核结果')
      const note = str(data.note, { field: '审核意见', max: 100 })
      if (decision === '驳回' && !note) throw new AppError(CODES.VALIDATION, '请填写驳回原因')
      const at = now()
      const staff = await staffLabel(ctx)
      const before = await repo.get('agencies', id)
      if (!before || before.deleted === true) throw new AppError(CODES.NOT_FOUND, '工单不存在或已删除')
      /* 已上架委托的修改：通过→覆盖内容并重新上架；驳回→恢复原上架内容 */
      const isEdit = before.editPending === true && !!before.pendingEdit
      const deadlineAt = agencyDeadlineAt(before)
      let patch
      if (decision === '通过') {
        patch = isEdit
          ? Object.assign({}, before.pendingEdit, {
            status: AGENCY_STATUS.ACTIVE,
            /* 数量 / 单价可能变化，成交金额同步重算；服务费按原单收取不重复计费 */
            amount: round2((Number(before.pendingEdit.qty) || 0) * (Number(before.pendingEdit.price) || 0)),
            /* 合同期以截止时间为准，修改不重新计算有效期；历史委托仍按 30 天 */
            expiresAt: deadlineAt || at + AGENCY_TTL_MS,
            approvedAt: at,
            confirmedAt: Number(before.confirmedAt) || at,
            reviewNote: note,
            materialVerified: true,
            staff,
            reason: '',
            editPending: false,
            pendingEdit: null,
            prevEdit: null,
            updatedAt: at
          })
          : {
            /* 审核通过即上架：不再要求「确认付款并上架」 */
            status: AGENCY_STATUS.ACTIVE,
            approvedAt: at,
            confirmedAt: at,
            expiresAt: deadlineAt || at + AGENCY_TTL_MS,
            reviewNote: note,
            materialVerified: true,
            staff,
            reason: '',
            updatedAt: at
          }
      } else {
        patch = isEdit
          ? {
            status: AGENCY_STATUS.ACTIVE,
            reviewNote: note,
            editPending: false,
            pendingEdit: null,
            prevEdit: null,
            staff,
            reason: '',
            updatedAt: at
          }
          : {
            status: AGENCY_STATUS.REJECTED,
            reviewNote: note,
            reason: note,
            staff,
            closedAt: at,
            updatedAt: at
          }
      }
      /* 待确认（PENDING）是升级前的旧状态，展示上并入「待审核」，审核入口同样允许 */
      const res = await repo.updateWhere('agencies', {
        id,
        status: { $in: [AGENCY_STATUS.REVIEW, AGENCY_STATUS.PENDING] }
      }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '工单状态已变化，仅「待审核」可审核')
      await audit(ctx, 'agency.review', id, `${decision}${isEdit ? '（委托修改）' : ''}${note ? ' · ' + note : ''} · ${staff}`)
      const doc = await repo.get('agencies', id)
      try {
        if (isEdit) {
          await notifyUser(doc.ownerId, decision === '通过'
            ? {
              title: `${doc.kind || '代采'}委托修改已通过`,
              body: '平台已通过你的修改申请，委托已重新上架并自动更新展示内容。',
              targetType: 'agency',
              targetId: id
            }
            : {
              title: `${doc.kind || '代采'}委托修改未通过`,
              body: '修改未通过，已恢复原上架内容；可按意见再次提交修改。',
              reason: note,
              targetType: 'agency',
              targetId: id
            })
        } else {
          await notifyUser(doc.ownerId, decision === '通过'
            ? {
              title: `${doc.kind || '代采'}委托审核通过`,
              body: `平台已通过你的${doc.kind || '委托'}委托，委托已上架${doc.visibility === VISIBILITIES.PRIVATE ? '（仅平台可见）' : ''}，截止 ${dateText(agencyDeadlineAt(doc))}；成交确认后再支付服务费。`,
              targetType: 'agency',
              targetId: id
            }
            : {
              title: `${doc.kind || '代采'}委托未通过`,
              body: '委托未通过平台审核，可按意见修改后重新提交。',
              reason: note,
              targetType: 'agency',
              targetId: id
            })
        }
      } catch (err) { /* 回执失败不影响主流程 */ }
      /* 审核结论回写工作台的审核工单：通过 / 驳回后工单自动收尾 */
      try {
        await closeAgencyAuditTicket(repo, id, decision, note, staff, at)
      } catch (err) {
        console.error('[agency] 审核工单收尾失败：' + (err && err.message))
      }
      return agencyStaffView(doc, at)
    },

    /**
     * 工单联系方式查看：审核通过后由平台联系用户，必须留痕。
     * 明文只返回给本次调用，不落库、不进列表；其余接口仍是掩码。
     */
    'agency.reveal': async (data, ctx) => {
      const id = str(data.id, { field: '工单标识', required: true, max: 64 })
      const reason = str(data.reason, { field: '查看原因', required: true, min: 2, max: 100 })
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '工单不存在或已删除')
      if ([AGENCY_STATUS.REJECTED, AGENCY_STATUS.CLOSED].includes(doc.status)) {
        throw new AppError(CODES.VALIDATION, '已结束的工单不可查看联系方式')
      }
      const plain = (field) => {
        const cipher = doc[field + 'Cipher']
        if (!cipher) return ''
        try {
          return decryptFieldOf({ keys, collection: 'agencies', field, recordId: id, cipher })
        } catch (err) {
          return ''
        }
      }
      const result = {
        id,
        phone: plain('phone'),
        /* 授权书上的联系人电话：与预留手机号不一致时，审核需据此核对原件 */
        authPhone: plain('authPhone'),
        subject: plain('subject'),
        legal: plain('legal'),
        reviewedAt: now()
      }
      await audit(ctx, 'agency.reveal', id, reason)
      assertNoPlaintextContactAllowingPhone(result, 'phone')
      return result
    },

    'agency.reject': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const reason = str(data.reason, { field: '驳回原因', required: true, min: 2, max: 100 })
      const at = now()
      const staff = await staffLabel(ctx)
      const res = await repo.updateWhere('agencies', {
        id,
        status: { $in: [AGENCY_STATUS.REVIEW, AGENCY_STATUS.PENDING, AGENCY_STATUS.APPROVED] }
      }, {
        status: AGENCY_STATUS.REJECTED,
        reason,
        staff,
        closedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，仅「待确认」可驳回')
      await audit(ctx, 'agency.reject', id, reason)
      const doc = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托未通过`,
          body: '委托资料未通过审核，可按意见修改后重新提交。',
          reason,
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(doc, at)
    },

    /**
     * 平台收尾：关闭委托。
     * 成交不再从这里直接确认：代采 / 代售必须先在工单中心完成「确定唯一对接方 → 居间合同归档」，
     * 再由客服登记成交（consult.proposeDeal）。本接口只保留关闭，避免跳过合同与收款流程。
     */
    'agency.close': async (data, ctx) => {
      const role = await roleOf(ctx)
      /* 关闭委托属于代采代售日常运营：客服与管理员都可操作（RBAC 已限定动作白名单） */
      if (role !== 'admin' && role !== 'cs') throw new AppError(CODES.FORBIDDEN, '无权限关闭委托')
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const reason = str(data.reason, { field: '关闭原因', max: 100 })
      const at = now()
      const staff = await staffLabel(ctx)
      if (data.dealt === true) {
        throw new AppError(
          CODES.CONFLICT,
          '代采代售不能直接确认成交，请在工单中心完成「确定对接方 → 合同归档 → 登记成交」'
        )
      }
      const res = await repo.updateWhere('agencies', {
        id,
        status: { $in: [AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE, AGENCY_STATUS.DEAL_PENDING, AGENCY_STATUS.DEALT] }
      }, {
        status: AGENCY_STATUS.CLOSED,
        reason,
        closeReason: reason,
        staff,
        closedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '仅未结束的委托可关闭')
      await audit(ctx, 'agency.close', id, reason || '关闭委托')
      const doc = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托已关闭`,
          body: '委托已从商机池下架，不再继续代寻。',
          reason,
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(doc, at)
    },

    /**
     * 确认完成（自助委托收尾）：服务费已到账后由平台把委托置为「已完成」，交易结束。
     * 走咨询工单的委托由客服在工单点「确认完成」并同步归档；用户自助发布、没有工单的委托
     * 在这里由管理员收尾，两处写入同一组字段（completedAt / completedBy）。
     */
    'agency.complete': async (data, ctx) => {
      const role = await roleOf(ctx)
      /* 确认完成是委托收尾动作：服务费到账后由客服或管理员归档 */
      if (role !== 'admin' && role !== 'cs') throw new AppError(CODES.FORBIDDEN, '无权限确认完成')
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.status === AGENCY_STATUS.DONE) throw new AppError(CODES.CONFLICT, '该委托已完成，无需重复操作')
      if (doc.status !== AGENCY_STATUS.DEALT) throw new AppError(CODES.CONFLICT, '只有已成交的委托才能确认完成')
      /* 服务费未到账不能归档：否则账单悬空、后续既不能收款也不会有新的推进 */
      if (doc.feeStatus !== 'paid' && doc.feeStatus !== 'unbilled') {
        throw new AppError(CODES.CONFLICT, '服务费到账后才能确认完成')
      }
      const staff = await staffLabel(ctx)
      const res = await repo.updateWhere('agencies', { id, status: AGENCY_STATUS.DEALT }, {
        status: AGENCY_STATUS.DONE,
        completedAt: at,
        completedBy: staff,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      await audit(ctx, 'agency.complete', id, '服务费到账，确认完成')
      const fresh = await repo.get('agencies', id)
      try {
        await notifyUser(fresh.ownerId, {
          title: `${fresh.kind || '代采代售'}委托已完成`,
          body: '服务费已到账，本次委托已结束，感谢使用平台服务。',
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(fresh, at)
    },

    /**
     * 平台编辑代采代售委托：与小程序发布表单同口径，覆盖委托类型 / 交易方式 / 设备 / 数量 /
     * 币种 / 价格 / 截止时间 / 租期 / 城市 / 说明 / 流程与条件，委托方主体信息与证明材料不在编辑范围。
     * 若该委托正处于「修改待审核」（editPending），改动合并进待审内容，审核通过时一并生效。
     */
    'agency.update': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (![AGENCY_STATUS.PENDING, AGENCY_STATUS.REVIEW, AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE].includes(doc.status)) {
        throw new AppError(CODES.CONFLICT, '已结束的委托不可修改')
      }
      /* 委托类型 / 交易方式 / 金额决定服务费口径，账单一旦生成就不再允许调整 */
      const feeLocked = !!doc.feeStatus && doc.feeStatus !== 'unbilled'
      const side = enumOf(data.side || doc.side || 'buy', ['buy', 'sell'], '委托类型')
      const sideModes = side === 'buy'
        ? [TRADE_MODES.BUY, TRADE_MODES.LEASE]
        : [TRADE_MODES.SELL, TRADE_MODES.RENT]
      const fallbackMode = side === 'buy' ? TRADE_MODES.BUY : TRADE_MODES.SELL
      const mode = enumOf(data.mode || doc.mode || fallbackMode, sideModes, '交易方式')
      const rental = mode === TRADE_MODES.LEASE || mode === TRADE_MODES.RENT
      const term = rental ? enumOf(data.term || doc.term, RENT_TERMS, '租期') : ''
      const currency = enumOf(data.currency || doc.currency || DEFAULT_CURRENCY,
        CURRENCIES.map((c) => c.code), '币种')
      const cur = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0]
      const item = str(data.item, { field: '设备型号', required: true, min: 2, max: 100 })
      const cat = str(data.cat === undefined ? (doc.itemCat || '') : data.cat, { field: '设备品类', max: 20 })
      const city = str(data.city === undefined ? (doc.city || '') : data.city, { field: '所在城市', max: 20 })
      const qty = intOf(data.qty, '数量', 1, 100000)
      const price = intOf(data.price, '单价', 1, 999999999)
      const detail = str(data.detail === undefined ? (doc.detail || '') : data.detail, { field: '补充说明', max: 500 })
      /* 与小程序发布口径一致：流程步骤按「名称：说明」拼接，最多 10 条、单条 120 字 */
      const flow = arrayOfStrings(data.flow === undefined ? doc.flow : data.flow, { field: '交易流程', max: 10, itemMax: 120 })
      const must = arrayOfStrings(data.must === undefined ? doc.must : data.must, { field: '必要条件', max: 10, itemMax: 120 })
      const nego = arrayOfStrings(data.nego === undefined ? doc.nego : data.nego, { field: '可协商条件', max: 10, itemMax: 120 })
      const deadlineInfo = parseAgencyDeadline(data.deadline || doc.deadline, now())
      if (feeLocked && (side !== doc.side || mode !== doc.mode || (rental ? term : '') !== (doc.term || '') ||
        currency !== (doc.currency || DEFAULT_CURRENCY) || qty !== Number(doc.qty) ||
        price !== Number(doc.price) || deadlineInfo.deadline !== doc.deadline)) {
        throw new AppError(CODES.CONFLICT, '服务费账单已生成，委托类型、交易方式、价格与截止时间不可再修改')
      }
      const amount = round2(qty * price)
      const fee = agencyFee(amount, rental, side)
      const largeAmount = fee.largeAmount === true
      /* 大额代采强制保密：与发布口径一致，其余情况沿用原可见范围，避免平台编辑把私密委托公开 */
      const visibility = (side === 'buy' && largeAmount) ? VISIBILITIES.PRIVATE : (doc.visibility || VISIBILITIES.PUBLIC)
      const exposure = (side === 'buy' && largeAmount) ? EXPOSURES.HIDDEN : (doc.exposure || EXPOSURES.HIDDEN)
      const channel = visibility === VISIBILITIES.PUBLIC ? PUBLISH_CHANNELS.BOTH : PUBLISH_CHANNELS.NORMAL
      const fields = {
        side,
        kind: side === 'buy' ? '代采' : '代售',
        mode,
        rental,
        term,
        item,
        itemCat: cat,
        city,
        qty,
        price,
        amount,
        currency,
        currencySymbol: cur.symbol,
        currencyLabel: cur.label,
        serviceFee: fee.fee,
        feeRule: fee.rule,
        feeNote: '成交后支付',
        largeAmount,
        deferredFee: fee.deferredFee === true,
        visibility,
        exposure,
        channel,
        bizPool: visibility !== VISIBILITIES.PRIVATE,
        deadline: deadlineInfo.deadline,
        deadlineAt: deadlineInfo.deadlineAt,
        detail,
        flow,
        must,
        nego
      }
      const at = now()
      const staff = await staffLabel(ctx)
      const patch = Object.assign({}, fields, { staff, updatedAt: at })
      if (doc.editPending === true) patch.pendingEdit = Object.assign({}, doc.pendingEdit || {}, fields)
      const res = await repo.updateWhere('agencies', { id }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      await audit(ctx, 'agency.update', id, `平台修改：${fields.kind} · ${item}`)
      const next = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托已被平台修改`,
          body: '平台已更新该委托的展示内容，如有疑问请联系在线客服。',
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(next, at)
    },

    /** 平台下架：委托方会收到通知，委托不再出现在商机池 */
    'agency.offline': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const reason = str(data.reason, { field: '下架原因', required: true, min: 2, max: 100 })
      const at = now()
      const staff = await staffLabel(ctx)
      const res = await repo.updateWhere('agencies', {
        id,
        status: { $in: [AGENCY_STATUS.PENDING, AGENCY_STATUS.REVIEW, AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE] }
      }, {
        status: AGENCY_STATUS.CLOSED,
        reason,
        staff,
        closedAt: at,
        editPending: false,
        pendingEdit: null,
        prevEdit: null,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '仅未结束的委托可下架')
      await audit(ctx, 'agency.offline', id, reason)
      const doc = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托已被平台下架`,
          body: '该委托已从商机池下架，如有疑问请联系在线客服。',
          reason,
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(doc, at)
    },

    /**
     * 某个委托下的平台对话：用户围绕该委托发给平台的客服消息（payload.targetType=agency）。
     * 按用户分组，管理端可直接在委托详情里查看并回复。
     */
    'agency.chats': async (data) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const agency = await repo.get('agencies', id)
      if (!agency || agency.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      const rows = await repo.find('outbox', {
        type: 'kf.chat',
        'payload.targetType': 'agency',
        'payload.targetId': id
      }, { sort: { field: 'createdAt', dir: 'asc' }, limit: 1000 })
      const byUid = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        const uid = p.uid || ''
        if (!uid) continue
        if (!byUid.has(uid)) byUid.set(uid, [])
        byUid.get(uid).push(msg)
      }
      const uids = Array.from(byUid.keys())
      const users = uids.length ? await repo.find('users', { id: { $in: uids } }, { limit: 200 }) : []
      const userMap = new Map(users.map((u) => [u.id, u]))
      const threads = uids.map((uid) => {
        const user = userMap.get(uid) || {}
        const list = byUid.get(uid) || []
        const messages = list.map((msg) => {
          const p = msg.payload || {}
          const kind = p.kind || 'text'
          /* 文本统一打码手机号 / 证件号；媒体仅下发可直连的 https 地址 */
          const src = (value) => (/^https?:\/\//i.test(String(value || '')) ? String(value) : '')
          return {
            id: msg.id,
            from: p.from === 'user' ? 'user' : 'staff',
            kind,
            body: kind === 'text' ? maskSensitiveText(p.body || '') : (kind === 'image' ? '[图片]' : (kind === 'video' ? '[视频]' : '[文件]')),
            image: kind === 'image' ? src(p.image) : '',
            video: kind === 'video' ? src(p.video) : '',
            poster: kind === 'video' ? src(p.poster) : '',
            staffName: p.staffName || '',
            at: Number(msg.createdAt) || 0
          }
        })
        const last = messages[messages.length - 1] || {}
        return {
          uid,
          userName: maskSensitiveText(user.nick || '用户'),
          total: messages.length,
          lastBody: last.body || '',
          lastAt: last.at || 0,
          messages
        }
      }).sort((a, b) => b.lastAt - a.lastAt)
      return { id, item: maskSensitiveText(agency.item || ''), threads }
    },

    /**
     * 平台在委托详情里直接回复用户：走客服消息通道，用户在小程序「消息」里收到。
     * 没有历史会话也可直接发第一条；支持文本、图片、视频（媒体需先上传到云端）。
     */
    'agency.reply': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const uid = str(data.uid, { field: '用户', required: true, max: 64 })
      const kind = data.kind ? enumOf(data.kind, ['text', 'image', 'video'], '消息类型') : 'text'
      let image = ''
      let video = ''
      let poster = ''
      if (kind === 'image') {
        image = str(data.image, { field: '图片', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(image)) throw new AppError(CODES.VALIDATION, '图片需先上传到云端')
      } else if (kind === 'video') {
        video = str(data.video, { field: '视频', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(video)) throw new AppError(CODES.VALIDATION, '视频需先上传到云端')
        poster = str(data.poster || '', { field: '视频封面', max: 1024 })
        if (poster && !/^(https:\/\/|cloud:\/\/)/i.test(poster)) throw new AppError(CODES.VALIDATION, '视频封面需先上传到云端')
      }
      const body = kind === 'text'
        ? str(data.body, { field: '回复内容', required: true, min: 1, max: 1000 })
        : ''
      const agency = await repo.get('agencies', id)
      if (!agency || agency.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (String(agency.ownerId || '') !== uid) throw new AppError(CODES.FORBIDDEN, '该用户不是本委托的发布人')
      /* 咨询单已被他人领取时，其他人不能再给该用户发消息（管理员也需先转单接手） */
      const leads = await repo.find('leads', { uid, targetType: 'agency', targetId: id }, {
        sort: { field: 'updatedAt', dir: 'desc' },
        limit: 1
      })
      const lead = leads[0] || null
      const me = (ctx.session && ctx.session.accountId) || ''
      if (lead && lead.assignedAccount && lead.assignedAccount !== me) {
        throw new AppError(CODES.FORBIDDEN, '该咨询已由 ' + (lead.csName || lead.assignedTo || '其他客服') + ' 领取，领取或转单后才能回复')
      }
      const staff = await staffLabel(ctx)
      const at = now()
      const toUser = {
        id: randomId('M'),
        type: 'kf.chat',
        payload: {
          uid,
          channel: 'kf',
          from: 'staff',
          title: agency.item || '委托咨询',
          body,
          kind,
          image,
          video,
          poster,
          card: null,
          staffName: staff,
          targetType: 'agency',
          targetId: id,
          /* 有咨询单时归入该咨询的会话流，消息中心按同一会话展示 */
          threadId: lead ? lead.id : '',
          targetTitle: agency.item || ''
        },
        status: 'done',
        readByUser: false,
        readByStaff: true,
        createdAt: at
      }
      await repo.insert('outbox', toUser)
      await audit(ctx, 'agency.reply', id, `${uid} · ${kind}${body ? ' · ' + body.slice(0, 40) : ''}`)
      return { id: toUser.id, at, staffName: staff, kind, image, video, poster }
    },

    'news.list': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const status = data.status ? enumOf(data.status, NEWS_STATUS_LIST, '资讯状态') : ''
      const query = { deleted: { $ne: true } }
      if (status) query.status = status
      const rows = await repo.find('news', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const counts = {}
      await Promise.all(NEWS_STATUS_LIST.map(async (name) => {
        counts[name] = await repo.count('news', { deleted: { $ne: true }, status: name })
      }))
      const total = NEWS_STATUS_LIST.reduce((sum, name) => sum + (Number(counts[name]) || 0), 0)
      return {
        /* map 传参必须显式包一层，否则数组下标会被当成时间戳传进 newsStaffView */
        items: rows.map((row) => newsStaffView(row, at)),
        total,
        page: page.page,
        limit: page.limit,
        counts
      }
    },

    'news.create': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin' && role !== 'cs') throw new AppError(CODES.FORBIDDEN, '仅管理员或客服可发布资讯')
      const input = normalizeNewsInput(data, true)
      /* 官方资讯统一口径：正文 1000–1300 字，定时发布也按这个标准 */
      if (input.content.length < 1000 || input.content.length > 1300) {
        throw new AppError(CODES.VALIDATION, `正文请控制在 1000–1300 字（当前 ${input.content.length} 字）`)
      }
      /* scheduled = true：先存「待发布」，到点由服务端自动上线 */
      const scheduled = data.scheduled === true
      const at = now()
      const doc = {
        id: randomId('NW'),
        uid: (ctx && ctx.accountId) || 'admin',
        official: true,
        cat: input.cat,
        title: input.title,
        summary: input.summary,
        content: input.content,
        media: input.media,
        city: input.city,
        author: '平台运营',
        status: scheduled ? NEWS_STATUS.SCHEDULED : NEWS_STATUS.PUBLISHED,
        reason: '',
        views: 0,
        createdAt: at,
        updatedAt: at,
        publishedAt: scheduled ? 0 : at,
        reviewedBy: (ctx && ctx.accountId) || 'admin',
        deleted: false
      }
      await repo.insert('news', doc)
      await audit(ctx, 'news.create', doc.id, scheduled ? '发布官方资讯（待发布，到点自动上线）' : '发布官方资讯')
      return newsStaffView(doc, at)
    },

    'news.review': async (data, ctx) => {
      const id = str(data.id, { field: '资讯标识', required: true, max: 64 })
      const decision = enumOf(data.decision, ['通过', '驳回'], '审核结果')
      const reason = str(data.reason, { field: '审核意见', max: 100 })
      if (decision === '驳回' && reason.length < 2) throw new AppError(CODES.VALIDATION, '驳回时请填写审核意见')
      const at = now()
      const patch = {
        status: decision === '通过' ? NEWS_STATUS.PUBLISHED : NEWS_STATUS.REJECTED,
        reason,
        reviewedBy: (ctx && ctx.accountId) || '',
        updatedAt: at,
        publishedAt: decision === '通过' ? at : 0
      }
      const res = await repo.updateWhere('news', { id, status: NEWS_STATUS.PENDING }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '仅「待审核」的资讯可审核')
      const doc = await repo.get('news', id)
      await audit(ctx, 'news.review', id, `${decision}${reason ? '：' + reason : ''}`)
      /* 回执：审核结论写站内信，投稿人不必反复来「我的投稿」里猜结果 */
      try {
        await notifyContributor(
          doc,
          decision === '通过' ? '资讯已通过审核' : '资讯被驳回',
          decision === '通过'
            ? `你投稿的资讯「${doc.title}」已通过审核并发布。`
            : `你投稿的资讯「${doc.title}」未通过审核：${reason}。修改内容后可重新投稿。`
        )
      } catch (notifyErr) {
        /* 审核结果已落库：回执失败不回滚 */
      }
      return newsStaffView(doc, at)
    },

    'news.offline': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin' && role !== 'cs') throw new AppError(CODES.FORBIDDEN, '仅管理员或客服可下架资讯')
      const id = str(data.id, { field: '资讯标识', required: true, max: 64 })
      const reason = str(data.reason, { field: '下架原因', max: 100 })
      if (!reason) throw new AppError(CODES.VALIDATION, '下架必须填写原因，并会同步通知投稿人')
      const at = now()
      const res = await repo.updateWhere('news', { id, status: NEWS_STATUS.PUBLISHED }, {
        status: NEWS_STATUS.OFFLINE,
        reason,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '仅「已发布」的资讯可下架')
      const doc = await repo.get('news', id)
      await audit(ctx, 'news.offline', id, reason)
      /* 下架也要有收尾：告诉投稿人为什么下线 */
      try {
        await notifyContributor(
          doc,
          '资讯已下架',
          `你投稿的资讯「${doc.title}」已被平台下架${reason ? '：' + reason : ''}。`
        )
      } catch (notifyErr) {
        /* 下架已生效：回执失败不回滚 */
      }
      return newsStaffView(doc, at)
    },

    /* 待发布稿立即上线：不必等到下一个时间点 */
    'news.publish': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin' && role !== 'cs') throw new AppError(CODES.FORBIDDEN, '仅管理员或客服可发布资讯')
      const id = str(data.id, { field: '资讯标识', required: true, max: 64 })
      const at = now()
      const res = await repo.updateWhere('news', { id, status: NEWS_STATUS.SCHEDULED }, {
        status: NEWS_STATUS.PUBLISHED,
        publishedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '仅「待发布」的资讯可立即发布')
      const doc = await repo.get('news', id)
      await audit(ctx, 'news.publish', id, '待发布资讯立即上线')
      return newsStaffView(doc, at)
    },

    /* 自动发布设置：每天哪几个时间点把「待发布」批量上线 */
    'news.schedule.get': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可查看自动发布设置')
      const cfg = await newsScheduleOf(repo)
      const row = await repo.get('settings', 'news_schedule').catch(() => null)
      return {
        slots: cfg.slots,
        enabled: cfg.enabled,
        defaults: DEFAULT_NEWS_SLOTS.slice(),
        pending: await repo.count('news', { status: NEWS_STATUS.SCHEDULED, deleted: { $ne: true } }),
        updatedText: row && row.updatedAt ? dateTimeText(row.updatedAt) : ''
      }
    },

    'news.schedule.save': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可修改自动发布设置')
      const slots = normalizeSlots(data.slots)
      if (!slots.length) throw new AppError(CODES.VALIDATION, '请至少保留一个发布时间，格式如 09:00')
      const enabled = data.enabled !== false
      const at = now()
      const exists = await repo.get('settings', 'news_schedule')
      const patch = { slots, enabled, updatedAt: at }
      if (exists) await repo.updateWhere('settings', { id: 'news_schedule' }, patch)
      else await repo.insert('settings', Object.assign({ id: 'news_schedule', createdAt: at }, patch))
      await audit(ctx, 'news.schedule', 'news_schedule', `每天 ${slots.join('、')} ${enabled ? '自动发布' : '已关闭'}`)
      return { slots, enabled, updatedText: dateTimeText(at) }
    },

    'quote.list': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const mode = enumOf(data.mode || 'active', ['active', 'expired', 'all'], '报价范围')
      const rows = await repo.find('quotes', { deleted: { $ne: true } }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 200
      })
      const filtered = rows.filter((row) => {
        const expired = Number(row.expiresAt) <= at
        if (mode === 'active') return !expired
        if (mode === 'expired') return expired
        return true
      })
      const start = (page.page - 1) * page.limit
      return {
        items: filtered.slice(start, start + page.limit).map((row) => Object.assign(quoteView(row, at), {
          ownerMasked: maskIdentity(row.ownerId || '')
        })),
        total: filtered.length,
        page: page.page,
        limit: page.limit
      }
    },

    'quote.remove': async (data, ctx) => {
      const id = str(data.id, { field: '报价标识', required: true, max: 64 })
      const doc = await repo.get('quotes', id)
      if (!doc || doc.deleted) return { id, removed: false }
      await repo.updateWhere('quotes', { id }, {
        deleted: true,
        removedBy: (ctx && ctx.accountId) || '',
        removedAt: now()
      })
      await audit(ctx, 'quote.remove', id, '删除粘贴报价')
      /* 报价被清理要留回执，避免用户以为自己的报价还在等回复 */
      if (doc.uid) {
        try {
          await notifyUser(doc.uid, {
            title: '一条粘贴报价已下架',
            body: '你发布的报价因信息不合规或已过期被平台清理，可修改后通过「粘贴报价」重新发布。',
            targetType: 'quote',
            targetId: id
          })
        } catch (notifyErr) { /* 已删除：回执失败不回滚 */ }
      }
      return { id, removed: true }
    },

    /** 商机权限与领取记录 */
    'biz.list': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const status = data.status ? enumOf(data.status, ['待确认', '已开通', '已到期', '已停用'], '商机状态') : ''
      const q = str(data.q || '', { field: '关键词', max: 40 }).trim().toLowerCase()
      /* 会员记录同样要全量检索：原来只取 200 条，会员超过 200 后搜不到人 */
      const rows = await repo.find('bizAccess', {}, {
        sort: { field: 'updatedAt', dir: 'desc' },
        limit: 100000
      })
      /* 批量取用户，避免每条记录一次查询 */
      const uids = Array.from(new Set(rows.map((row) => row.uid).filter(Boolean)))
      const users = uids.length ? await repo.find('users', { id: { $in: uids } }, { limit: uids.length }) : []
      const userOf = new Map()
      users.forEach((user) => {
        if (user && user.id) userOf.set(user.id, user)
      })
      const counts = { 待确认: 0, 已开通: 0, 已到期: 0, 已停用: 0 }
      const all = []
      for (const row of rows) {
        const view = accessView(row, at)
        counts[view.status] = (counts[view.status] || 0) + 1
        const user = userOf.get(row.uid)
        let phone = ''
        try {
          phone = user && user.phoneCipher
            ? decryptField({ keys, token: user.phoneCipher, aad: `users.phoneCipher.${user.id}` })
            : ''
        } catch (err) {
          phone = ''
        }
        all.push({
          uid: row.uid,
          nick: maskName((user && user.nick) || '') || maskIdentity(row.uid || ''),
          phoneMasked: maskPhone(phone),
          status: view.status,
          unlocked: view.unlocked,
          expireAt: view.expireAt,
          expireText: view.expireText,
          daysLeft: view.daysLeft,
          appliedAt: view.appliedAt,
          appliedText: view.appliedText,
          staff: row.staff || '',
          updatedAt: Number(row.updatedAt) || 0,
          /* 仅服务端检索用：未脱敏昵称 / 完整手机号 / openid / 办理人 */
          _hay: [String((user && user.nick) || ''), row.uid || '', phone, row.staff || ''].join(' ').toLowerCase()
        })
      }
      const items = all.filter((item) => (!status || item.status === status) && (!q || item._hay.indexOf(q) >= 0))
      /* 工作台「7 天内到期会员」按全量统计：原来前端只拿前 100 条，会员超过 100 就会漏提醒 */
      const expiringAll = all
        .filter((item) => item.status === '已开通' && Number(item.daysLeft) <= 7 && Number(item.daysLeft) >= 0)
        .sort((a, b) => Number(a.daysLeft) - Number(b.daysLeft))
      const start = (page.page - 1) * page.limit
      const claims = await repo.find('bizClaims', {}, {
        sort: { field: 'at', dir: 'desc' },
        limit: 20
      })
      return {
        items: items.slice(start, start + page.limit).map((item) => {
          const out = Object.assign({}, item)
          delete out._hay
          return out
        }),
        total: items.length,
        counts,
        expiring: {
          total: expiringAll.length,
          items: expiringAll.slice(0, 10).map((item) => {
            const out = Object.assign({}, item)
            delete out._hay
            return out
          })
        },
        plan: BIZ_PLAN,
        claims: claims.map((row) => ({
          id: row.id,
          uid: row.uid,
          user: maskName(String(row.uid || '').slice(-4)) || maskIdentity(row.uid || ''),
          targetType: row.targetType,
          targetId: row.targetId,
          at: Number(row.at) || 0,
          atText: relTime(row.at, at)
        })),
        page: page.page,
        limit: page.limit
      }
    },

    /** 开通 / 续费：支持套餐（plan）与按天（days），每次操作写一条 bizOrders 流水 */
    'biz.grant': (data, ctx) => grantMembership(data, ctx),

    /** 会员订单流水：管理端按用户 / 时间查看，用于财务对账与用户详情 */
    'biz.orders': async (data) => {
      const at = now()
      const uid = str(data.uid, { field: '用户标识', max: 64 }) || ''
      const page = normalizePaging(data)
      const query = uid ? { uid } : {}
      const rows = await repo.find('bizOrders', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const total = await repo.count('bizOrders', query)
      const totalAmount = (await repo.find('bizOrders', query, { limit: 100000 }))
        .reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
      return {
        items: rows.map((row) => ({
          id: row.id,
          uid: row.uid,
          nick: maskName(row.nick || '') || maskIdentity(row.uid || ''),
          planKey: row.planKey || 'custom',
          planLabel: row.planLabel || '',
          days: Number(row.days) || 0,
          original: Number(row.original) || 0,
          discount: Number(row.discount) || 0,
          amount: Number(row.amount) || 0,
          startAt: Number(row.startAt) || 0,
          expireAt: Number(row.expireAt) || 0,
          expireText: row.expireAt ? `${dateText(row.expireAt)} 到期` : '',
          method: row.method || '',
          operator: row.operator || '',
          note: row.note || '',
          createdAt: Number(row.createdAt) || 0,
          createdText: dateText(row.createdAt)
        })),
        total,
        totalAmount: Math.round(totalAmount * 100) / 100,
        plans: await resolvePlans(repo),
        page: page.page,
        limit: page.limit,
        at
      }
    },

    /**
     * 会员到期提醒：对「已开通且剩余天数 ≤ days」的会员发站内信。
     * 同一用户每天最多一条（按 uid + 日期生成固定 ID 去重），工作台加载时自动触发，
     * 也可以由管理员手动再提醒一次；重复调用不会刷屏。
     */
    'biz.remindExpiring': async (data) => {
      const settings = (await repo.get('settings', 'site')) || {}
      /* 文案模板、提前天数、每日提醒时间、次数与间隔都取媒体页「提醒设置」 */
      const config = memberRemindOf(settings.memberRemind)
      const at = now()
      const force = data.force === true || String(data.force || '') === 'true'
      const hourNow = new Date(at + 8 * 60 * 60 * 1000).getUTCHours()
      /* 自动触发（工作台加载）受开关与提醒时间约束；手动点击不受时间限制 */
      if (!force && !config.enabled) return { days: config.days, reminded: 0, items: [], at, skipped: '已关闭自动提醒' }
      if (!force && hourNow < config.hour) return { days: config.days, reminded: 0, items: [], at, skipped: '未到提醒时间' }
      const days = config.days
      const dayKey = Math.floor(at / DAY_MS)
      const fill = (text, row, view) => String(text || '')
        .replace(/\{nick\}/g, (row && row.nick) || '你')
        .replace(/\{days\}/g, String(view.daysLeft))
        .replace(/\{expire\}/g, view.expireText)
      const rows = await repo.find('bizAccess', {}, { limit: 2000 })
      const reminded = []
      for (const row of rows) {
        const view = accessView(row, at)
        if (view.status !== '已开通' || Number(view.daysLeft) > days) continue
        /* 同一到期周期内统计已提醒次数：续费后 expireAt 变化，提醒次数自动重新计算 */
        const sent = await repo.find('outbox', { 'payload.remindKind': 'expiring', 'payload.uid': row.uid }, { limit: 200 })
        const inCycle = sent.filter((msg) => Number(msg.payload && msg.payload.expireAt) === view.expireAt)
        if (inCycle.length >= config.maxTimes) continue
        const lastAt = inCycle.reduce((max, msg) => Math.max(max, Number(msg.createdAt) || 0), 0)
        if (!force && lastAt && at - lastAt < config.intervalDays * DAY_MS) continue
        const id = 'M' + sha256Hex(`biz-remind:${row.uid}:${view.expireAt}:${dayKey}`).slice(0, 24)
        if (await repo.get('outbox', id)) continue
        const title = fill(config.title, row, view)
        const body = fill(config.body, row, view)
        await repo.insert('outbox', {
          id,
          type: 'system.notice',
          payload: {
            uid: row.uid,
            channel: 'system',
            from: 'system',
            title,
            body,
            reason: '',
            targetType: 'biz',
            targetId: row.uid,
            remindKind: 'expiring',
            expireAt: view.expireAt
          },
          status: 'pending',
          createdAt: at
        })
        if (subscribe) {
          await subscribe.biz(row.uid, {
            title,
            body: `还有 ${view.daysLeft} 天到期，续费后继续查看商机`,
            at
          }).catch(() => {})
        }
        reminded.push({ uid: row.uid, daysLeft: view.daysLeft, expireText: view.expireText })
      }
      return { days, reminded: reminded.length, items: reminded, at, config }
    },

    /** 收款流水：企微 / 微信 / 对公等线下收款登记与确认（财务中心数据源） */
    'payment.list': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const status = data.status ? enumOf(data.status, PAYMENT_STATUS_LIST, '收款状态') : ''
      const bizType = data.bizType ? enumOf(data.bizType, PAYMENT_BIZ_TYPES, '业务类型') : ''
      const uid = str(data.uid, { field: '用户标识', max: 64 }) || ''
      const keyword = str(data.keyword, { field: '关键词', max: 40 }).toLowerCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const query = {}
      if (uid) query.uid = uid
      if (status) query.status = status
      if (bizType) query.bizType = bizType
      let rows = await repo.find('payments', query, { sort: { field: 'paidAt', dir: 'desc' }, limit: 5000 })
      if (from) rows = rows.filter((row) => Number(row.paidAt) >= from)
      if (to) rows = rows.filter((row) => Number(row.paidAt) <= to)
      if (keyword) {
        rows = rows.filter((row) => String(row.uid || '').toLowerCase().includes(keyword)
          || String(row.nick || '').toLowerCase().includes(keyword)
          || String(row.note || '').toLowerCase().includes(keyword))
      }
      const totals = { all: 0, confirmed: 0, pending: 0, refunded: 0, count: rows.length }
      for (const row of rows) {
        const amount = Number(row.amount) || 0
        if (row.status === PAYMENT_STATUS.CONFIRMED) totals.confirmed += Number(row.received) || amount
        else if (row.status === PAYMENT_STATUS.PENDING) totals.pending += amount
        else if (row.status === PAYMENT_STATUS.REFUNDED) totals.refunded += amount
        if (row.status !== PAYMENT_STATUS.REFUNDED) totals.all += Number(row.received) || 0
      }
      const start = (page.page - 1) * page.limit
      const items = rows.slice(start, start + page.limit).map((row) => ({
        id: row.id,
        uid: row.uid,
        nick: maskName(row.nick || '') || maskIdentity(row.uid || ''),
        bizType: row.bizType || '其他',
        planKey: row.planKey || '',
        planLabel: row.planLabel || '',
        days: Number(row.days) || 0,
        amount: Number(row.amount) || 0,
        discount: Number(row.discount) || 0,
        received: Number(row.received) || 0,
        method: row.method || '',
        status: row.status,
        paidAt: Number(row.paidAt) || 0,
        paidText: dateText(row.paidAt),
        confirmedAt: Number(row.confirmedAt) || 0,
        confirmedText: row.confirmedAt ? dateText(row.confirmedAt) : '',
        operator: row.operator || '',
        confirmedBy: row.confirmedBy || '',
        orderId: row.orderId || '',
        agencyId: row.agencyId || '',
        note: row.note || '',
        voucher: row.voucher || '',
        manual: !!row.manual,
        createdAt: Number(row.createdAt) || 0
      }))
      return {
        items,
        total: rows.length,
        page: page.page,
        limit: page.limit,
        totals: {
          all: Math.round(totals.all * 100) / 100,
          confirmed: Math.round(totals.confirmed * 100) / 100,
          pending: Math.round(totals.pending * 100) / 100,
          refunded: Math.round(totals.refunded * 100) / 100,
          count: totals.count
        },
        statusList: PAYMENT_STATUS_LIST,
        bizTypes: PAYMENT_BIZ_TYPES,
        methods: PAYMENT_METHODS,
        at
      }
    },

    /** 财务修改入账备注 / 凭证：金额与状态不动，只补说明与回单，全部留痕 */
    'payment.updateNote': async (data, ctx) => {
      const id = str(data.id, { field: '收款单', required: true, max: 64 })
      const row = await repo.get('payments', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      const note = String(data.note == null ? '' : data.note).trim()
      if (note.length > 200) throw new AppError(CODES.VALIDATION, '备注最多 200 字')
      const voucher = String(data.voucher == null ? '' : data.voucher).trim()
      if (voucher && !/^(https?:\/\/|\/)/.test(voucher)) throw new AppError(CODES.VALIDATION, '凭证地址不合法')
      const at = now()
      const staff = await staffLabel(ctx)
      await repo.updateWhere('payments', { id }, {
        note,
        voucher,
        noteUpdatedAt: at,
        noteUpdatedBy: staff,
        updatedAt: at
      })
      await audit(ctx, 'payment.updateNote', id, `${row.bizType || '收款'} · ${staff}`)
      return { id, note, voucher, updatedAt: at }
    },

    /** 财务补录线下收入：固定「其他」类型、直接记已确认，补齐微信之外的收款口径 */
    'payment.manual': async (data, ctx) => {
      const uid = str(data.uid, { field: '用户标识', required: true, max: 64 })
      const user = await repo.get('users', uid)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0) throw new AppError(CODES.VALIDATION, '入账金额需大于 0')
      if (amount > 1000000) throw new AppError(CODES.VALIDATION, '单笔补录金额不能超过 100 万元')
      const method = data.method ? enumOf(data.method, PAYMENT_METHODS, '收款方式') : '对公转账'
      const note = str(data.note, { field: '入账说明', required: true, max: 200 })
      const voucher = String(data.voucher || '').trim()
      if (voucher && !/^(https?:\/\/|\/)/.test(voucher)) throw new AppError(CODES.VALIDATION, '凭证地址不合法')
      const at = now()
      const paidAt = Number(data.paidAt) || at
      const staff = await staffLabel(ctx)
      const id = randomId('PF')
      await repo.insert('payments', {
        id,
        paymentId: '',
        uid,
        nick: user.nick || '',
        bizType: '其他',
        planKey: '',
        planLabel: '',
        days: 0,
        amount: Math.round(amount * 100) / 100,
        discount: 0,
        received: Math.round(amount * 100) / 100,
        method,
        status: PAYMENT_STATUS.CONFIRMED,
        paidAt,
        confirmedAt: at,
        confirmedBy: staff,
        operator: staff,
        orderId: '',
        agencyId: '',
        note,
        voucher,
        manual: true,
        createdAt: at,
        updatedAt: at
      })
      await audit(ctx, 'payment.manual', id, `${uid} · ${amount} 元 · ${method} · ${staff}`)
      return {
        id,
        uid,
        amount: Math.round(amount * 100) / 100,
        method,
        note,
        voucher,
        status: PAYMENT_STATUS.CONFIRMED,
        manual: true,
        paidAt,
        paidText: dateText(paidAt)
      }
    },

    /** 财务确认委托服务费到账：仅委托服务费账单可人工确认，会员收款由微信支付自动入账 */
    'payment.feeConfirm': async (data, ctx) => {
      const id = str(data.id, { field: '收款单', required: true, max: 64 })
      const row = await repo.get('payments', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      if (!row.agencyId || PAYMENT_FEE_TYPES.indexOf(row.bizType) < 0) {
        throw new AppError(CODES.VALIDATION, '仅委托服务费账单可确认到账')
      }
      if (row.status === PAYMENT_STATUS.REFUNDED) throw new AppError(CODES.CONFLICT, '该收款单已退款')
      const at = now()
      const staff = await staffLabel(ctx)
      if (row.status === PAYMENT_STATUS.CONFIRMED) {
        /* 幂等回写：已确认的委托服务费账单仍补齐委托单到账状态与客服佣金 */
        await repo.updateWhere('agencies', { id: row.agencyId }, {
          feeStatus: 'paid',
          feePaidAt: Number(row.confirmedAt) || at,
          feePaidBy: row.confirmedBy || '',
          feeBillId: id,
          updatedAt: at
        })
        await settleAgencyFee(row, at, staff)
        return { id, status: row.status, confirmed: true }
      }
      const received = Number(row.received) || Number(row.amount) || 0
      /* CAS 抢占：并发确认只有一个请求能把「待确认」翻成「已确认」，其余走幂等返回 */
      const claimed = await repo.updateWhere('payments', { id, status: PAYMENT_STATUS.PENDING }, {
        status: PAYMENT_STATUS.CONFIRMED,
        received,
        confirmedAt: at,
        confirmedBy: staff,
        updatedAt: at
      })
      if (!claimed || claimed.count === 0) {
        const fresh = await repo.get('payments', id)
        if (fresh && fresh.status === PAYMENT_STATUS.CONFIRMED) {
          await settleAgencyFee(fresh, at, staff)
          return { id, status: fresh.status, confirmed: true }
        }
        throw new AppError(CODES.CONFLICT, '收款单状态已变化，请刷新后重试')
      }
      /* 委托服务费账单：确认到账后回写委托单，feeStatus=paid 并记录到账时间 */
      await repo.updateWhere('agencies', { id: row.agencyId }, {
        feeStatus: 'paid',
        feePaidAt: at,
        feePaidBy: staff,
        feeBillId: id,
        updatedAt: at
      })
      await audit(ctx, 'payment.feeConfirm', id, `${row.bizType} · ${received} 元 · ${staff}`)
      /* 客服佣金计提 + 工单推进到「服务费已到账」，按 paymentId 幂等 */
      await settleAgencyFee(Object.assign({}, row, { received }), at, staff)
      try {
        await notifyUser(row.uid, {
          title: '服务费已确认到账',
          body: `${row.bizType} · ${received} 元已确认到账，可在「我的缴费」查看。`,
          targetType: 'payment',
          targetId: id
        })
      } catch (notifyErr) { /* 服务费已确认到账：回执失败不回滚 */ }
      return { id, status: PAYMENT_STATUS.CONFIRMED, confirmed: true }
    },

    'payment.refund': async (data, ctx) => {
      const id = str(data.id, { field: '收款单', required: true, max: 64 })
      const row = await repo.get('payments', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      if (row.status === PAYMENT_STATUS.REFUNDED) return { id, status: row.status, refunded: true }
      const reason = str(data.reason, { field: '退款原因', required: true, max: 100 })
      const staff = await staffLabel(ctx)
      const result = await rollbackPayment(row, {
        at: now(),
        reason,
        staff,
        source: '管理端退款',
        revoke: data.revoke
      })
      return { id, status: result.status, refunded: true, risk: result.risk || null }
    },

    /**
     * 微信 / Apple 退款推送自动回滚（服务端调用，无人工介入）。
     * 按 OutTradeNo（或微信商户单号）定位收款单，复用管理端同一套回滚口径；
     * 找不到收款单说明未发货或非本平台订单，返回 found=false，避免微信无限重推。
     */
    'payment.systemRefund': async (data) => {
      const candidates = [data.outTradeNo, data.payOrderId, data.mchOrderId, data.wxOrderId, data.mchRefundId]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
      let row = null
      for (const no of candidates) {
        const byPay = await repo.find('payments', { paymentId: no }, { limit: 1 })
        if (byPay.length) { row = byPay[0]; break }
        const byOut = await repo.find('payments', { outTradeNo: no }, { limit: 1 })
        if (byOut.length) { row = byOut[0]; break }
      }
      if (!row) return { found: false, refunded: false }
      /* 退款失败的通知只记状态，不回滚会员，等微信重试或转人工 */
      if (data.success === false) {
        return { found: true, refunded: false, id: row.id, status: row.status }
      }
      const source = String(data.source || '').slice(0, 20) ||
        (row.channel === 'apple' ? 'Apple 退款' : '微信退款')
      const reason = String(data.reason || '').slice(0, 100) || source + '（自动回滚）'
      const result = await rollbackPayment(row, {
        at: now(),
        reason,
        source,
        staff: source,
        actorType: 'system',
        /* 渠道退款已经发生，无法拦截；佣金未回退的部分按 3.9 记欠款 */
        force: true
      })
      return {
        found: true,
        id: result.id,
        status: result.status,
        refunded: !!result.refunded,
        channel: row.channel || '',
        risk: result.risk || null
      }
    },

    /**
     * iOS 退款问询（xpay_subscribe_ios_refund_query_notify）：微信要求 3 秒内应答。
     * 未发货直接放过；已发货按「7 天内且未领取商机」放过，其余拒绝并附实际使用凭据。
     * resultCode：0 放过（建议退款）/ 1 拦截（拒绝退款）。
     */
    'biz.iosRefundQuery': async (data) => {
      const at = now()
      const no = String(data.outTradeNo || data.payOrderId || '').trim()
      let row = null
      for (const key of [no, String(data.mchOrderId || '').trim()].filter(Boolean)) {
        const byPay = await repo.find('payments', { paymentId: key }, { limit: 1 })
        row = byPay[0] || null
        if (!row) {
          const byOut = await repo.find('payments', { outTradeNo: key }, { limit: 1 })
          row = byOut[0] || null
        }
        if (row) break
      }
      const provideStatus = String(data.provideStatus == null ? '' : data.provideStatus)
      const orderTime = Number(data.orderTime) > 0 ? Number(data.orderTime) * 1000 : 0
      const paidAt = orderTime ||
        (row ? (Number(row.paidAt) || Number(row.confirmedAt) || Number(row.createdAt) || at) : at)
      const days = Math.max(0, Math.floor((at - paidAt) / DAY_MS))
      let resultCode = 0
      let resultInfo = '同意退款'
      let evidence = ''
      let claimed = 0
      if (!row) {
        evidence = '未查询到对应的开通记录，建议退款'
      } else if (row.status === PAYMENT_STATUS.REFUNDED) {
        evidence = '该订单已退款，无重复扣费风险，同意退款'
      } else if (provideStatus === '0') {
        evidence = '订单未发货，未产生实际服务，建议退款'
      } else {
        const claims = await repo.find('bizClaims', { uid: row.uid }, { limit: 500 })
        claimed = claims.filter((item) => Number(item.at) >= paidAt).length
        if (at - paidAt <= REFUND_FREE_WINDOW_MS && claimed === 0) {
          evidence = `购买后 ${days} 天，未领取任何商机，建议退款`
        } else {
          resultCode = 1
          resultInfo = '拒绝退款'
          evidence = claimed > 0
            ? `购买后 ${days} 天，已领取 ${claimed} 条商机，会员权益已实际使用，不同意退款`
            : `购买已超过 7 天（${days} 天），会员权益已实际提供，不同意退款`
        }
      }
      if (row) {
        await repo.updateWhere('payments', { id: row.id }, {
          iosRefundQueryAt: at,
          iosRefundQueryResult: resultCode,
          iosRefundQueryEvidence: evidence,
          updatedAt: at
        })
      }
      appendAudit(repo, {
        actorType: 'system',
        actorId: 'apple',
        action: 'payment.iosRefundQuery',
        target: row ? row.id : (no || ''),
        reason: evidence,
        result: resultCode === 0 ? 'allow' : 'deny',
        at
      })
      return {
        resultCode,
        resultInfo,
        evidence,
        days,
        claimed,
        uid: row ? row.uid : String(data.uid || ''),
        outTradeNo: no
      }
    },

    /** 退款申请队列：财务核对后通过 / 驳回，通过即执行退款并停用会员权限 */
    'refund.list': async (data) => {
      const page = normalizePaging(data)
      const status = str(data.status || REFUND_STATUS.PENDING, { field: '处理状态', max: 20 })
      const q = str(data.q || '', { field: '关键词', max: 40 })
      const rows = await repo.find('refundRequests', {}, { sort: { field: 'createdAt', dir: 'desc' }, limit: 1000 })
      let list = rows.filter((row) => !status || row.status === status)
      if (q) {
        const kw = q.toLowerCase()
        list = list.filter((row) => {
          return String(row.uid || '').toLowerCase().includes(kw) ||
            String(row.reason || '').toLowerCase().includes(kw) ||
            String(row.bizType || '').toLowerCase().includes(kw) ||
            String(row.paymentId || '').toLowerCase().includes(kw)
        })
      }
      const counts = { 待处理: 0, 已通过: 0, 已驳回: 0, 已撤销: 0 }
      rows.forEach((row) => { if (counts[row.status] !== undefined) counts[row.status] += 1 })
      const paged = list.slice((page.page - 1) * page.limit, page.page * page.limit)
      /* 用户昵称与收款单实收金额一并展示，避免财务来回切页核对 */
      const items = []
      for (const row of paged) {
        const user = row.uid ? await repo.get('users', row.uid) : null
        const payment = row.paymentId ? await repo.get('payments', row.paymentId) : null
        items.push({
          id: row.id,
          paymentId: row.paymentId,
          uid: row.uid,
          nick: (user && (user.nick || user.nickname)) || row.uid || '',
          bizType: row.bizType || '',
          amount: Number(row.amount) || 0,
          reason: row.reason || '',
          status: row.status,
          handlerNote: row.handlerNote || '',
          handledBy: row.handledBy || '',
          createdAt: Number(row.createdAt) || 0,
          handledAt: Number(row.handledAt) || 0,
          paymentStatus: payment ? payment.status : '',
          paymentReceived: payment ? Number(payment.received) || 0 : 0
        })
      }
      return {
        items,
        total: list.length,
        page: page.page,
        limit: page.limit,
        counts,
        statusList: Object.values(REFUND_STATUS)
      }
    },

    'refund.handle': async (data, ctx) => {
      const id = str(data.id, { field: '退款申请', required: true, max: 64 })
      const decision = enumOf(data.decision, [REFUND_STATUS.APPROVED, REFUND_STATUS.REJECTED], '处理结论')
      const note = str(data.note || '', { field: '处理说明', max: 200 })
      if (decision === REFUND_STATUS.REJECTED && !note) {
        throw new AppError(CODES.VALIDATION, '驳回退款需要填写原因，用户会收到这条说明')
      }
      const doc = await repo.get('refundRequests', id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '退款申请不存在')
      if (doc.status !== REFUND_STATUS.PENDING) throw new AppError(CODES.CONFLICT, '该申请已处理，请刷新后查看')
      const payment = await repo.get('payments', doc.paymentId)
      if (!payment) throw new AppError(CODES.NOT_FOUND, '关联的收款单不存在')
      const at = now()
      const staff = await staffLabel(ctx)
      if (decision === REFUND_STATUS.APPROVED) {
        if (payment.status !== PAYMENT_STATUS.REFUNDED) {
          const reason = note || doc.reason || '用户申请退款'
          await rollbackPayment(payment, { at, reason, staff, source: '用户退款申请' })
        }
      }
      const updated = await repo.updateWhere('refundRequests', { id }, {
        status: decision,
        handlerNote: note,
        handledAt: at,
        handledBy: staff,
        updatedAt: at
      })
      if (!updated || updated.count === 0) throw new AppError(CODES.CONFLICT, '该申请已被处理，请刷新后重试')
      await audit(ctx, 'refund.handle', `${id}:${decision}`, note || doc.reason || '')
      try {
        await notifyUser(doc.uid, {
          title: decision === REFUND_STATUS.APPROVED ? '退款申请已通过' : '退款申请未通过',
          body: decision === REFUND_STATUS.APPROVED
            ? `${doc.bizType || '缴费'} ${doc.amount} 元退款已处理${note ? '：' + note : ''}，到账时间以支付渠道为准。`
            : `你的退款申请未通过${note ? '：' + note : ''}。如有疑问可在「帮助与反馈」提交申诉。`,
          reason: note,
          targetType: 'payment',
          targetId: doc.paymentId
        })
      } catch (notifyErr) { /* 退款结论已落库：回执失败不回滚 */ }
      return { id, status: decision, paymentId: doc.paymentId, paymentStatus: decision === REFUND_STATUS.APPROVED ? PAYMENT_STATUS.REFUNDED : payment.status }
    },

    /** 佣金台账：客服委托佣金 / 推广者佣金两类，统一按月筛选查询 */
    'finance.commissions': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const month = str(data.month, { field: '月份', max: 7 }) || ''
      if (month && !/^\d{4}-\d{2}$/.test(month)) throw new AppError(CODES.VALIDATION, '月份格式应为 YYYY-MM')
      const type = data.type ? enumOf(data.type, ['客服委托', '推广佣金'], '佣金类型') : ''
      const keyword = str(data.keyword, { field: '关键词', max: 40 }).toLowerCase()
      const monthOf = (ms) => {
        const d = new Date(Number(ms) + 8 * 3600 * 1000)
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      }
      const [csAgency, promoter] = await Promise.all([
        repo.find('csAgencyCommissions', {}, { limit: 20000 }),
        repo.find('commissions', {}, { limit: 20000 })
      ])
      const rows = []
      for (const row of csAgency) {
        rows.push({
          id: row.id,
          type: '客服委托',
          staff: row.csId,
          staffName: row.csName || row.csId,
          uid: row.leadId || row.agencyId,
          userLabel: row.item || row.contractNo || row.agencyId,
          bizLabel: row.side === 'sell' ? '代售服务费' : '代采服务费',
          base: Number(row.feeAmount) || 0,
          rate: Number(row.rate) || 0,
          amount: Math.round(((Number(row.commission) || 0) - (Number(row.reversedCommission) || 0)) * 100) / 100,
          status: Number(row.reversedCommission) > 0 ? '部分冲正' : (row.status || '已计提'),
          rateSource: row.rateSource || '',
          paidAt: Number(row.paidAt) || 0,
          month: monthOf(row.paidAt),
          note: row.contractNo || ''
        })
      }
      for (const row of promoter) {
        rows.push({
          id: row.id,
          type: '推广佣金',
          staff: row.promoterUid,
          staffName: row.promoterUid,
          uid: row.payerUid,
          userLabel: row.payerUid,
          bizLabel: '会员续费',
          base: Number(row.base) || 0,
          rate: Number(row.rate) || 0,
          amount: row.status === '已冲正' ? 0 : (Number(row.netAmount) || 0),
          status: row.status || '',
          rateSource: row.level === 2 ? '二级' : '一级',
          paidAt: Number(row.paidAt) || 0,
          month: monthOf(row.paidAt),
          note: ''
        })
      }
      let list = rows
      if (month) list = list.filter((row) => row.month === month)
      if (type) list = list.filter((row) => row.type === type)
      if (keyword) {
        list = list.filter((row) => [row.staffName, row.staff, row.userLabel, row.uid, row.bizLabel, row.note]
          .some((v) => String(v || '').toLowerCase().includes(keyword)))
      }
      list.sort((a, b) => b.paidAt - a.paidAt)
      const totals = { all: 0, 客服委托: 0, 推广佣金: 0, count: list.length }
      for (const row of list) {
        totals[type || row.type] += row.amount
        totals.all += row.amount
      }
      const paged = list.slice((page.page - 1) * page.limit, page.page * page.limit).map((row) => Object.assign({}, row, {
        paidText: row.paidAt ? dateText(row.paidAt) : '',
        rateText: (Math.round(row.rate * 10000) / 100) + '%'
      }))
      return {
        items: paged,
        total: list.length,
        page: page.page,
        limit: page.limit,
        totals: {
          all: Math.round(totals.all * 100) / 100,
          csAgency: Math.round(totals['客服委托'] * 100) / 100,
          promoter: Math.round(totals['推广佣金'] * 100) / 100,
          count: totals.count
        },
        types: ['客服委托', '推广佣金'],
        at
      }
    },

    /** 财务汇总：营收、付费用户、续费率、套餐结构、近 6 个月趋势与现金流台账 */
    'finance.summary': async () => {
      const at = now()
      /* 营收口径：所有实收金额 > 0 的会员订单，含微信支付与手动开通 / 线下登记收款；
         payments 用于现金流台账与待确认统计，实收 0 的赠送单不计营收 */
      const payments = await repo.find('payments', {}, { sort: { field: 'paidAt', dir: 'desc' }, limit: 20000 })
      const orders = await repo.find('bizOrders', {}, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20000 })
      const accesses = await repo.find('bizAccess', {}, { limit: 20000 })
      const revenueOrders = orders.filter((o) => Number(o.amount) > 0)
      /* 委托服务费收入：财务确认到账的代采 / 代售 / 租赁服务费账单，与会员营收一并计入总营收；
         这类账单没有支付渠道字段，按人工确认 / 线下到账归入 manual */
      const feeRows = payments
        .filter((row) => row.status === PAYMENT_STATUS.CONFIRMED && PAYMENT_FEE_TYPES.indexOf(row.bizType) > -1)
        .map((row) => {
          const c = String(row.channel || '').toLowerCase()
          return {
            at: Number(row.confirmedAt) || Number(row.paidAt) || Number(row.createdAt) || 0,
            amount: Number(row.received) || Number(row.amount) || 0,
            uid: row.uid || '',
            bizType: row.bizType,
            planKey: '',
            channel: c === 'apple' || c === 'ios' ? 'apple' : (c === 'wxpay' ? 'wxpay' : 'manual')
          }
        })
      /* 渠道归一：历史订单没有 channel 字段，先回查同一收款单的渠道；
         仍取不到时按在线支付（微信）处理。Apple 内购单独出表，手动开通 / 线下登记归 manual */
      const channelByPayment = new Map()
      for (const row of payments) {
        if (row && row.paymentId) channelByPayment.set(String(row.paymentId), String(row.channel || '').toLowerCase())
      }
      const channelOf = (o) => {
        const c = String((o && o.channel) || channelByPayment.get(String((o && o.paymentId) || '')) || '').toLowerCase()
        if (c === 'apple' || c === 'ios') return 'apple'
        if (c === 'manual') return 'manual'
        return 'wxpay'
      }
      const wechatOrders = orders.filter((o) => channelOf(o) === 'wxpay')
      const revenueRows = revenueOrders.map((o) => ({
        at: Number(o.createdAt) || 0,
        amount: Number(o.amount) || 0,
        uid: o.uid,
        bizType: '会员续费',
        planKey: o.planKey || '',
        channel: channelOf(o)
      }))
      const memberRevenue = revenueRows.reduce((sum, row) => sum + row.amount, 0)
      const serviceFeeRevenue = feeRows.reduce((sum, row) => sum + row.amount, 0)
      const allRevenueRows = revenueRows.concat(feeRows)
      const revenue = memberRevenue + serviceFeeRevenue
      const payers = new Set(revenueRows.map((row) => row.uid).filter(Boolean))
      const orderCountByUid = {}
      for (const row of revenueRows) {
        if (!row.uid) continue
        orderCountByUid[row.uid] = (orderCountByUid[row.uid] || 0) + 1
      }
      const repeatPayers = Object.values(orderCountByUid).filter((n) => n >= 2).length
      const activeMembers = accesses.filter((row) => bizStatusOf(row, at) === BIZ_STATUS.ACTIVE).length
      const expiringSoon = accesses.filter((row) => {
        const status = bizStatusOf(row, at)
        const left = Number(row.expireAt) - at
        return status === BIZ_STATUS.ACTIVE && left > 0 && left <= 7 * DAY_MS
      }).length
      const byBizType = {}
      for (const row of allRevenueRows) {
        const key = row.bizType || '其他'
        if (!byBizType[key]) byBizType[key] = { count: 0, amount: 0 }
        byBizType[key].count += 1
        byBizType[key].amount += row.amount
      }
      const byPlan = {}
      for (const row of revenueRows) {
        if (row.bizType !== '会员续费') continue
        const key = row.planKey || 'custom'
        const label = (BIZ_PLAN_MAP[key] && BIZ_PLAN_MAP[key].label) || '人工按天'
        if (!byPlan[key]) byPlan[key] = { key, label, count: 0, amount: 0, days: 0 }
        byPlan[key].count += 1
        byPlan[key].amount += row.amount
      }
      for (const order of revenueOrders) {
        const key = order.planKey || 'custom'
        if (byPlan[key]) byPlan[key].days += Number(order.days) || 0
      }
      /* 渠道营收：Apple 内购单独成表，手动开通 / 线下登记单列，微信支付为默认渠道 */
      const CHANNEL_LABELS = { wxpay: '微信支付', apple: 'Apple 内购', manual: '手动开通 / 线下' }
      const byChannel = {}
      for (const row of allRevenueRows) {
        const key = row.channel || 'wxpay'
        if (!byChannel[key]) byChannel[key] = { key, label: CHANNEL_LABELS[key] || key, count: 0, amount: 0 }
        byChannel[key].count += 1
        byChannel[key].amount += row.amount
      }
      /* 近 6 个月营收趋势 */
      const months = []
      const d = new Date(at + 8 * 60 * 60 * 1000)
      for (let i = 5; i >= 0; i -= 1) {
        const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
        const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`
        months.push({ month: key, revenue: 0, fee: 0, orders: 0, apple: 0 })
      }
      const monthMap = {}
      for (const row of months) monthMap[row.month] = row
      for (const row of allRevenueRows) {
        const rd = new Date(row.at + 8 * 60 * 60 * 1000)
        const key = `${rd.getUTCFullYear()}-${String(rd.getUTCMonth() + 1).padStart(2, '0')}`
        if (monthMap[key]) {
          monthMap[key].revenue += row.amount
          monthMap[key].orders += 1
          if (PAYMENT_FEE_TYPES.indexOf(row.bizType) > -1) monthMap[key].fee += row.amount
          if (row.channel === 'apple') monthMap[key].apple += row.amount
        }
      }
      for (const row of months) {
        row.revenue = Math.round(row.revenue * 100) / 100
        row.fee = Math.round(row.fee * 100) / 100
        row.apple = Math.round(row.apple * 100) / 100
      }
      const startOfToday = at - ((at + 8 * 3600 * 1000) % DAY_MS)
      const revenueOf = (since) => allRevenueRows.filter((row) => row.at >= since).reduce((sum, row) => sum + row.amount, 0)
      /* 用户消费画像：累计消费 / 近 30 天消费 / 消费次数，供财务中心「单个用户」视图 */
      const allUsers = await repo.find('users', {}, { limit: 20000 })
      const userOf = new Map(allUsers.map((u) => [u.id, u]))
      const allLeads = await repo.find('leads', {}, { limit: 20000 })
      const matchedCount = allLeads.filter((row) => row.status === LEAD_STATUS.MATCHED || row.status === LEAD_STATUS.DEALT).length
      const spendByUid = {}
      for (const row of allRevenueRows) {
        if (!row.uid) continue
        const item = spendByUid[row.uid] || { uid: row.uid, total: 0, last30: 0, count: 0, lastAt: 0 }
        item.total += row.amount
        if (row.at >= at - 30 * DAY_MS) item.last30 += row.amount
        item.count += 1
        if (row.at > item.lastAt) item.lastAt = row.at
        spendByUid[row.uid] = item
      }
      const topSpenders = Object.values(spendByUid)
        .sort((a, b) => b.total - a.total)
        .slice(0, 12)
        .map((row) => {
          const user = userOf.get(row.uid)
          return {
            uid: row.uid,
            nick: maskName((user && user.nick) || '') || maskIdentity(row.uid),
            total: Math.round(row.total * 100) / 100,
            last30: Math.round(row.last30 * 100) / 100,
            count: row.count,
            lastText: dateText(row.lastAt)
          }
        })
      /* 每周对账：只核对微信支付渠道；Apple 内购走 Apple 账单、手动 / 线下无微信账单可核，不纳入对账范围 */
      const weekFrom = at - 7 * DAY_MS
      const weekOrders = wechatOrders.filter((row) => Number(row.createdAt) >= weekFrom)
      const sumBy = (rows, field) => Math.round(rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0) * 100) / 100
      const recon = {
        since: weekFrom,
        wechatCount: weekOrders.length,
        wechatAmount: sumBy(weekOrders, 'amount')
      }
      recon.total = recon.wechatAmount

      /* ============ 现金流 / 提现 / 佣金：财务中心三段台账 ============ */
      const money = (v) => Math.round((Number(v) || 0) * 100) / 100
      const monthOf = (ms) => {
        const d = new Date(Number(ms) + 8 * 3600 * 1000)
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      }
      const thisMonth = monthOf(at)
      /* 收款：以 payments 实际入账为准，退款单冲减，避免「只看微信订单」导致线下收入缺失 */
      const incomeRows = payments.filter((row) => row.status === PAYMENT_STATUS.CONFIRMED).map((row) => ({
        at: Number(row.paidAt) || Number(row.createdAt) || 0,
        amount: money(row.received),
        uid: row.uid || '',
        bizType: row.bizType || '其他',
        method: row.method || '',
        note: row.note || ''
      }))
      const refundRows = payments.filter((row) => row.status === PAYMENT_STATUS.REFUNDED).map((row) => ({
        at: Number(row.refundedAt) || Number(row.paidAt) || Number(row.createdAt) || 0,
        amount: money(row.received || row.amount),
        uid: row.uid || '',
        bizType: row.bizType || '其他',
        method: row.method || ''
      }))
      const incomeTotal = money(incomeRows.reduce((s, r) => s + r.amount, 0))
      const refundTotal = money(refundRows.reduce((s, r) => s + r.amount, 0))
      const incomeMonth = money(incomeRows.filter((r) => monthOf(r.at) === thisMonth).reduce((s, r) => s + r.amount, 0))
      const refundMonth = money(refundRows.filter((r) => monthOf(r.at) === thisMonth).reduce((s, r) => s + r.amount, 0))

      /* 提现：全量提现单按状态汇总，已到账才是真实现金流出 */
      const withdrawals = await repo.find('promoterWithdrawals', {}, {
        sort: { field: 'createdAt', dir: 'desc' }, limit: 20000
      })
      const pickW = (list) => withdrawals.filter((row) => list.indexOf(row.status) > -1)
      const paidW = pickW(['已到账'])
      const pendingW = pickW(['待审核', '待打款', '打款中'])
      const failedW = pickW(['打款失败'])
      const paidTotal = money(paidW.reduce((s, row) => s + (Number(row.payoutAmount) || Number(row.amount) || 0), 0))
      const paidMonth = money(paidW.filter((row) => monthOf(row.paidAt || row.updatedAt) === thisMonth)
        .reduce((s, row) => s + (Number(row.payoutAmount) || Number(row.amount) || 0), 0))
      const pendingTotal = money(pendingW.reduce((s, row) => s + (Number(row.amount) || 0), 0))
      const failedTotal = money(failedW.reduce((s, row) => s + (Number(row.amount) || 0), 0))

      /* 佣金：客服委托佣金 + 推广者佣金，统一进工资 / 佣金台账；客服不设会员提成 */
      const [csAgencyRows, promoterRows] = await Promise.all([
        repo.find('csAgencyCommissions', {}, { limit: 20000 }),
        repo.find('commissions', {}, { limit: 20000 })
      ])
      const csAgencyTotal = money(csAgencyRows.reduce((s, row) =>
        s + (Number(row.commission) || 0) - (Number(row.reversedCommission) || 0), 0))
      const csAgencyMonth = money(csAgencyRows.filter((row) => monthOf(row.paidAt) === thisMonth)
        .reduce((s, row) => s + (Number(row.commission) || 0), 0) -
        csAgencyRows.filter((row) => Number(row.reversedAt) > 0 && monthOf(row.reversedAt) === thisMonth)
          .reduce((s, row) => s + (Number(row.reversedCommission) || 0), 0))
      const promoterLive = promoterRows.filter((row) => row.status !== '已冲正')
      const promoterTotal = money(promoterLive.reduce((s, row) => s + (Number(row.netAmount) || 0), 0))
      const promoterMonth = money(promoterLive.filter((row) => monthOf(row.paidAt) === thisMonth)
        .reduce((s, row) => s + (Number(row.netAmount) || 0), 0))
      const staffSalaryTotal = csAgencyTotal
      const staffSalaryMonth = csAgencyMonth
      const commissionTotal = money(staffSalaryTotal + promoterTotal)

      const cash = {
        at,
        incomeTotal,
        refundTotal,
        netIncome: money(incomeTotal - refundTotal),
        incomeMonth,
        refundMonth,
        withdrawPaid: paidTotal,
        withdrawPaidMonth: paidMonth,
        withdrawPending: pendingTotal,
        withdrawPendingCount: pendingW.length,
        withdrawFailed: failedTotal,
        withdrawFailedCount: failedW.length,
        withdrawCount: withdrawals.length,
        balance: money(incomeTotal - refundTotal - paidTotal),
        balanceMonth: money(incomeMonth - refundMonth - paidMonth),
        commissionTotal,
        commissionMonth: money(staffSalaryMonth + promoterMonth),
        staffSalaryTotal,
        staffSalaryMonth,
        promoterCommissionTotal: promoterTotal,
        promoterCommissionMonth: promoterMonth,
        csAgencyTotal,
        csAgencyMonth
      }
      /* 近 6 个月趋势追加提现与佣金口径 */
      for (const row of months) {
        row.withdraw = 0
        row.commission = 0
      }
      for (const row of paidW) {
        const key = monthOf(row.paidAt || row.updatedAt)
        if (monthMap[key]) {
          monthMap[key].withdraw += Number(row.payoutAmount) || Number(row.amount) || 0
        }
      }
      for (const row of csAgencyRows) {
        const key = monthOf(row.paidAt)
        if (monthMap[key]) monthMap[key].commission += Number(row.commission) || 0
      }
      for (const row of promoterLive) {
        const key = monthOf(row.paidAt)
        if (monthMap[key]) monthMap[key].commission += Number(row.netAmount) || 0
      }
      for (const row of months) {
        row.withdraw = money(row.withdraw)
        row.commission = money(row.commission)
      }
      /* 统一最近流水：收款（入）与提现（出）按时间合并 */
      const recentCash = incomeRows.map((row) => ({
        kind: '收款',
        direction: 'in',
        at: row.at,
        uid: row.uid,
        nick: maskName((userOf.get(row.uid) || {}).nick || '') || maskIdentity(row.uid || ''),
        label: row.bizType,
        amount: row.amount,
        paidText: dateText(row.at),
        method: row.method
      })).concat(paidW.map((row) => ({
        kind: '提现',
        direction: 'out',
        at: Number(row.paidAt) || Number(row.updatedAt) || Number(row.createdAt) || 0,
        uid: row.uid,
        nick: maskName((userOf.get(row.uid) || {}).nick || '') || maskIdentity(row.uid || ''),
        label: '推广佣金提现',
        amount: money(Number(row.payoutAmount) || Number(row.amount) || 0),
        paidText: dateText(row.paidAt || row.updatedAt || row.createdAt),
        method: '银行卡'
      }))).sort((a, b) => b.at - a.at).slice(0, 12)

      const channelAmount = (key) => Math.round(((byChannel[key] && byChannel[key].amount) || 0) * 100) / 100
      return {
        at,
        totals: {
          /* 总营收 = 会员开通收入 + 委托服务费收入（代采 / 代售 / 租赁），两类都计入收入 */
          revenue: Math.round(revenue * 100) / 100,
          memberRevenue: Math.round(memberRevenue * 100) / 100,
          serviceFeeRevenue: Math.round(serviceFeeRevenue * 100) / 100,
          today: Math.round(revenueOf(startOfToday) * 100) / 100,
          last7: Math.round(revenueOf(at - 7 * DAY_MS) * 100) / 100,
          last30: Math.round(revenueOf(at - 30 * DAY_MS) * 100) / 100,
          /* 分渠道营收：Apple 内购单独出表 */
          wechatRevenue: channelAmount('wxpay'),
          appleRevenue: channelAmount('apple'),
          manualRevenue: channelAmount('manual'),
          orders: revenueRows.length,
          feeOrders: feeRows.length,
          payers: payers.size,
          repeatPayers,
          arpu: payers.size ? Math.round((memberRevenue / payers.size) * 100) / 100 : 0,
          renewalRate: payers.size ? Math.round((repeatPayers / payers.size) * 100) : 0,
          totalUsers: allUsers.length,
          /* 付费率：有成功收款记录的用户 / 全部用户 */
          conversionRate: allUsers.length ? Math.round((payers.size / allUsers.length) * 1000) / 10 : 0,
          matchedCount,
          activeMembers,
          expiringSoon,
          pendingCount: payments.filter((row) => row.status === PAYMENT_STATUS.PENDING).length,
          pendingAmount: Math.round(payments.filter((row) => row.status === PAYMENT_STATUS.PENDING)
            .reduce((sum, row) => sum + (Number(row.received) || 0), 0) * 100) / 100
        },
        byBizType: Object.keys(byBizType).map((key) => ({
          bizType: key,
          count: byBizType[key].count,
          amount: Math.round(byBizType[key].amount * 100) / 100
        })).sort((a, b) => b.amount - a.amount),
        /* 渠道表：固定顺序 微信支付 → Apple 内购 → 手动 / 线下 */
        byChannel: ['wxpay', 'apple', 'manual'].filter((key) => byChannel[key]).map((key) => ({
          key,
          label: byChannel[key].label,
          count: byChannel[key].count,
          amount: Math.round(byChannel[key].amount * 100) / 100
        })),
        recon,
        byPlan: Object.values(byPlan).map((row) => ({
          key: row.key,
          label: row.label,
          count: row.count,
          amount: Math.round(row.amount * 100) / 100,
          days: row.days
        })).sort((a, b) => b.amount - a.amount),
        months,
        cash,
        recentCash,
        topSpenders,
        recent: revenueOrders.slice(0, 10).map((row) => {
          const user = userOf.get(row.uid)
          return {
            id: row.id,
            uid: row.uid,
            nick: maskName((user && user.nick) || '') || maskIdentity(row.uid || ''),
            bizType: '会员续费',
            amount: Number(row.amount) || 0,
            status: '已支付',
            paidText: dateText(row.createdAt),
            method: row.method || '微信支付'
          }
        })
      }
    },

    'biz.revoke': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可停用商机权限')
      const uid = str(data.uid, { field: '用户标识', required: true, max: 64 })
      const existing = await repo.get('bizAccess', uid)
      if (!existing) throw new AppError(CODES.NOT_FOUND, '该用户未开通商机权限')
      const at = now()
      await repo.updateWhere('bizAccess', { id: uid }, {
        status: BIZ_STATUS.STOPPED,
        expireAt: at,
        updatedAt: at,
        staff: await staffLabel(ctx)
      })
      const reason = str(data.reason, { field: '停用原因', max: 100 }) || '停用商机权限'
      await audit(ctx, 'biz.revoke', uid, reason)
      /* 回执：停用必须告知原因，避免用户只看到「突然不能看了」 */
      try {
        await notifyUser(uid, {
          title: '商机权限已停用',
          body: `你的商机权限已被停用：${reason}。已领取的商机记录保留，续费后恢复联系方式可见。`,
          reason,
          targetType: 'biz',
          targetId: uid
        })
      } catch (notifyErr) {
        /* 状态已生效：回执失败不回滚 */
      }
      return accessView(Object.assign({}, existing, { status: BIZ_STATUS.STOPPED, expireAt: at }), at)
    },

    /* 手动修改到期时间：只调整到期日，已停用状态不因此恢复 */
    'biz.setExpire': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可修改商机权限到期时间')
      const uid = str(data.uid, { field: '用户标识', required: true, max: 64 })
      const existing = await repo.get('bizAccess', uid)
      if (!existing) throw new AppError(CODES.NOT_FOUND, '该用户未开通商机权限')
      const expireAt = Number(data.expireAt)
      /* 毫秒时间戳下限 2000-01-01：拦住误传的秒级时间戳 */
      if (!Number.isFinite(expireAt) || expireAt < 946684800000) {
        throw new AppError(CODES.VALIDATION, '到期时间格式不正确')
      }
      const at = now()
      /* 已停用的账号保持停用；其余按新到期日重新计算是否在有效期内 */
      const status = existing.status === BIZ_STATUS.STOPPED ? BIZ_STATUS.STOPPED : BIZ_STATUS.ACTIVE
      await repo.updateWhere('bizAccess', { id: uid }, {
        status,
        expireAt,
        updatedAt: at,
        staff: await staffLabel(ctx)
      })
      const reason = str(data.reason, { field: '修改说明', max: 100 }) || '手动修改到期时间'
      await audit(ctx, 'biz.setExpire', uid, `${reason} · 到期 ${dateText(expireAt)}`)
      try {
        await notifyUser(uid, {
          title: '商机权限到期时间已调整',
          body: `你的商机权限到期时间已调整为 ${dateText(expireAt)}${status === BIZ_STATUS.STOPPED ? '，当前仍为停用状态' : ''}。`,
          reason,
          targetType: 'biz',
          targetId: uid
        })
      } catch (notifyErr) {
        /* 状态已生效：回执失败不回滚 */
      }
      return accessView(Object.assign({}, existing, { status, expireAt }), at)
    }
  }
}

module.exports = {
  AGENCY_STATUS,
  AGENCY_STATUS_LIST,
  AGENCY_TTL_MS,
  NEWS_STATUS,
  NEWS_STATUS_LIST,
  NEWS_OFFICIAL_CATS,
  DEFAULT_NEWS_SLOTS,
  newsScheduleOf,
  publishScheduledNews,
  BIZ_PLAN,
  BIZ_PLANS,
  BIZ_STATUS,
  DAY_MS,
  agencyFee,
  moneyText,
  dateText,
  relTime,
  maskSubject,
  normModel,
  modelHit,
  stockMatch,
  normalizeBizPrefs,
  notifyNewBizMatch,
  countBizMatches,
  boardItems,
  agencyOwnerView,
  agencyStaffView,
  confirmAgencyDeal,
  lockAgencyForContract,
  accessView,
  createMarketUserHandlers,
  createMarketAdminHandlers
}
