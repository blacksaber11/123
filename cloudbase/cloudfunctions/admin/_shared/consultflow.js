'use strict'

/**
 * 代采 / 代售咨询工单的阶段流转。
 *
 * 阶段（与小程序端「咨询进度」共用一份口径）：
 *   沟通中 → 条件已确认 → 合同待审核 → 合同已归档 → 服务费待支付 → 服务费已到账 → 已完成；
 *   任一步都可以终止。成交由平台（客服 / 管理员）在合同归档后直接确认，委托方只收通知，
 *   不再有「委托方确认成交」这一环。
 * 回退只有两条：合同被驳回（contract → terms）、历史成交被拒（deal_pending → terms）。
 * deal_pending 仅用于兼容升级前停在「待确认成交」的老工单。
 *
 * 所有推进统一走 CAS（updateWhere 带当前 serviceStage）：并发推进只有一方成功，
 * 失败方拿到 CONFLICT 并提示刷新，不会出现「两套合同 / 两次计提」。
 * 每次推进同时往 outbox 写一条 kf.chat 系统消息，用户在会话里直接看到进度。
 */

const { AppError, CODES } = require('./errors')
const { appendAudit } = require('./audit')
const { sha256Hex } = require('./crypto')
const { CS_STATUS } = require('./cs')
const {
  CONSULT_STAGE,
  CONSULT_STAGE_LABELS,
  CONSULT_STAGE_ORDER,
  CONSULT_TRANSITIONS,
  LEAD_STATUS
} = require('./constants')

/* 超时未回复自动结束的固定说明：工作台已结束列表与审计共用同一文案 */
const CONSULT_IDLE_CLOSE_NOTE = '客服超时未回复，系统自动结束本次咨询'

const CONTRACT_STATUS = Object.freeze({
  PENDING: '待审核',
  APPROVED: '已归档',
  REJECTED: '已驳回',
  VOID: '已作废'
})
const CONTRACT_STATUS_LIST = Object.freeze([
  CONTRACT_STATUS.PENDING,
  CONTRACT_STATUS.APPROVED,
  CONTRACT_STATUS.REJECTED,
  CONTRACT_STATUS.VOID
])

/**
 * 咨询单与工单的边界。
 *
 * 用户从代采 / 代售商机发起的咨询，提交即生成工单（ticketed），
 * 未领取时显示在工单中心「待领取」分栏；坐席领取后开始对话并推进分步流程。
 * intake / consulting 仅用于兼容升级前的历史数据：老咨询在领取时补成已生成工单。
 * 直接与平台对话的会话不产生咨询单，因此永远不会出现在这里。
 */
const TICKET_STATE = Object.freeze({
  INTAKE: 'intake',
  CONSULTING: 'consulting',
  TICKETED: 'ticketed',
  INVALID: 'invalid'
})
const TICKET_STATE_LABELS = Object.freeze({
  intake: '待领取咨询',
  consulting: '磋商中',
  ticketed: '已生成工单',
  invalid: '无效咨询'
})

/**
 * 咨询单状态：老数据没有 ticketState 时一律按「已生成工单」处理，
 * 保证升级前已在流转的工单不会从工单中心消失。
 */
function ticketStateOf(lead) {
  const doc = lead || {}
  const state = String(doc.ticketState || '')
  if (TICKET_STATE_LABELS[state]) return state
  if (doc.targetType === 'agency') return TICKET_STATE.TICKETED
  return ''
}

/**
 * 工单当前阶段：老数据没有 serviceStage 时按「沟通中」处理，
 * 保证升级前已领取的工单可以直接继续推进，不必人工回填。
 */
function stageOf(lead) {
  const doc = lead || {}
  if (doc.targetType && doc.targetType !== 'agency') return ''
  const stage = String(doc.serviceStage || '')
  return CONSULT_STAGE_LABELS[stage] ? stage : CONSULT_STAGE.COMMUNICATING
}

function stageLabel(stage) {
  return CONSULT_STAGE_LABELS[stage] || ''
}

function stageIndex(stage) {
  return CONSULT_STAGE_ORDER.indexOf(stage)
}

function canTransition(from, to) {
  return (CONSULT_TRANSITIONS[from] || []).indexOf(to) >= 0
}

/** 前置阶段校验：客服在错误阶段点按钮时给出可读提示，而不是写坏数据 */
function assertStage(lead, stage, hint) {
  const current = stageOf(lead)
  if (current !== stage) {
    throw new AppError(
      CODES.CONFLICT,
      `当前阶段为「${stageLabel(current) || '未开始'}」，${hint || '不能执行该操作'}`
    )
  }
}

/**
 * 老工单补写阶段：字段缺失时落一次「沟通中」。
 * 云函数仓储不支持 $exists，因此这里用 id 更新后重读，以库内值为准。
 */
async function ensureStage(repo, lead, at, by) {
  const doc = lead || {}
  if (doc.serviceStage) return doc
  if (!doc.id) throw new AppError(CODES.VALIDATION, '缺少咨询单')
  const stamp = Number(at) || Date.now()
  const operator = String(by || '')
  const patch = {
    serviceStage: CONSULT_STAGE.COMMUNICATING,
    stageAt: stamp,
    stageBy: operator,
    stageVersion: Number(doc.stageVersion) || 0,
    stageHistory: [{ stage: CONSULT_STAGE.COMMUNICATING, at: stamp, by: operator, note: '开始服务' }],
    updatedAt: stamp
  }
  await repo.updateWhere('leads', { id: doc.id }, patch)
  const fresh = await repo.get('leads', doc.id)
  return fresh || Object.assign({}, doc, patch)
}

/**
 * 阶段推进：校验白名单 → CAS 更新 → 系统消息 + 审计。
 * options.extra 会一并写入 leads（如 terms / contractId / dealAmount）。
 */
async function advance(repo, lead, to, options) {
  const opts = options || {}
  const at = Number(opts.at) || Date.now()
  const by = String(opts.by || '')
  if (!lead || !lead.id) throw new AppError(CODES.VALIDATION, '缺少咨询单')
  let doc = lead.serviceStage ? lead : await ensureStage(repo, lead, at, by)
  const from = stageOf(doc)
  if (!canTransition(from, to)) {
    throw new AppError(
      CODES.CONFLICT,
      `当前阶段为「${stageLabel(from) || '未开始'}」，不能推进到「${stageLabel(to) || to}」`
    )
  }
  const version = (Number(doc.stageVersion) || 0) + 1
  const history = (Array.isArray(doc.stageHistory) ? doc.stageHistory : []).slice()
  history.push({ stage: to, at, by, note: String(opts.note || '') })
  const patch = Object.assign({
    serviceStage: to,
    stageAt: at,
    stageBy: by,
    stageNote: String(opts.note || ''),
    stageVersion: version,
    stageHistory: history,
    updatedAt: at
  }, opts.extra || {})

  let res = await repo.updateWhere('leads', { id: doc.id, serviceStage: from }, patch)
  if (!res || !res.count) {
    /* 兼容升级前的老工单：补写阶段后重试一次，仍失败说明已被他人推进 */
    const fresh = await repo.get('leads', doc.id)
    if (fresh && !fresh.serviceStage) {
      doc = await ensureStage(repo, fresh, at, by)
      res = await repo.updateWhere('leads', { id: doc.id, serviceStage: doc.serviceStage }, patch)
    }
    if (!res || !res.count) throw new AppError(CODES.CONFLICT, '咨询单阶段已变化，请刷新后重试')
  }

  const next = Object.assign({}, doc, patch)
  await announceStage(repo, next, to, { at, version, note: opts.note })
  await appendAudit(repo, {
    actorType: String(opts.actorType || 'admin'),
    actorId: by || 'system',
    action: 'consult.stage',
    target: `${doc.id}:${from}->${to}`,
    reason: String(opts.note || stageLabel(to)),
    result: 'allow',
    at
  })
  return next
}

/**
 * 阶段变更站内信：用户端会话直接展示「咨询进度：xxx」。
 * 消息 id 由「工单 + 阶段 + 版本」派生，重复推进（重试）只落一条。
 */
async function announceStage(repo, lead, stage, opts) {
  const options = opts || {}
  const at = Number(options.at) || Date.now()
  const leadId = String(lead.id || '')
  if (!leadId) return
  const version = Number(options.version) || Number(lead.stageVersion) || 1
  const label = stageLabel(stage) || stage
  const doc = {
    id: 'M' + sha256Hex(`cs-stage:${leadId}:${stage}:${version}`).slice(0, 22),
    type: 'kf.chat',
    payload: {
      uid: lead.uid || '',
      channel: 'kf',
      from: 'system',
      staffName: lead.csName || lead.assignedTo || '',
      threadId: lead.threadId || leadId,
      targetType: 'agency',
      targetId: lead.agencyId || lead.targetId || '',
      title: lead.agencyTitle || '',
      body: `咨询进度：${label}`,
      serviceStage: stage,
      stageLabel: label,
      /* 平台客服咨询：进度提示留在「平台客服」会话里 */
      platformChat: String(lead.source || '') === 'kf_leave'
    },
    status: 'pending',
    createdAt: at
  }
  try {
    await repo.insert('outbox', doc)
  } catch (err) {
    /* 重复推进只留一条进度消息；其它错误照常抛出 */
    if (!err || err.code !== CODES.CONFLICT) throw err
  }
}

/**
 * 工单收尾：写服务结束状态、关闭线索，并给用户发一条「去评价」消息。
 * 客服手动结束服务、确认完成、终止，以及系统超时自动结束，全部走这一个出口，
 * 保证用户端会话锁定、客服工作台「已结束」累计、评价入口三处表现一致。
 */
async function endLead(repo, lead, options) {
  const opts = options || {}
  if (!lead || !lead.id) throw new AppError(CODES.VALIDATION, '缺少咨询单')
  const at = Number(opts.at) || Date.now()
  const accountId = String(opts.accountId || '')
  const staffName = String(opts.staffName || lead.csName || lead.assignedTo || '')
  const patch = {
    csStatus: CS_STATUS.ENDED,
    csEndedAt: at,
    csEndedBy: accountId || 'system',
    csEndedByName: staffName,
    status: LEAD_STATUS.CLOSED,
    updatedAt: at
  }
  if (opts.reason) patch.closeReason = String(opts.reason)
  if (opts.auto) patch.autoEnded = true
  /* 未生成工单就结束服务：按无效咨询收口，避免一直挂在「磋商中」却没有出口 */
  if (ticketStateOf(lead) !== TICKET_STATE.TICKETED) {
    patch.ticketState = TICKET_STATE.INVALID
    patch.closedAt = at
    if (!patch.closeReason) patch.closeReason = '磋商未达成，客服结束服务'
  }
  const res = await repo.updateWhere('leads', { id: lead.id }, patch)
  if (!res || !res.count) throw new AppError(CODES.CONFLICT, '咨询单状态已更新，请刷新后重试')
  try {
    await repo.insert('outbox', {
      id: 'M' + sha256Hex('cs-end:' + lead.id).slice(0, 22),
      type: 'kf.chat',
      payload: {
        uid: lead.uid,
        channel: 'kf',
        from: 'system',
        staffName,
        threadId: lead.threadId || lead.id,
        targetType: 'agency',
        targetId: lead.targetId || lead.agencyId || '',
        title: lead.agencyTitle || '',
        body: '本次咨询服务已结束，请对客服服务进行评价',
        csStatus: CS_STATUS.ENDED,
        askRating: true,
        /* 平台客服咨询：评价邀请留在「平台客服」会话里，不另起一条咨询 */
        platformChat: String(lead.source || '') === 'kf_leave'
      },
      status: 'pending',
      createdAt: at
    })
  } catch (dupErr) {
    /* 退款后二次完成：评价消息已发过同 id，不阻断工单闭合 */
    if (!dupErr || dupErr.code !== CODES.CONFLICT) throw dupErr
  }
  return patch
}

/**
 * 超时未回复自动结束：
 * 从「客服领取时间 / 客服最后一条回复时间」里取最晚的一个算起，
 * 超过设置时长仍没有任何客服回复的工单自动终止并邀请用户评价。
 * 只在沟通中、条件已确认两个阶段生效；已进入合同 / 收款的工单不自动终止。
 */
async function closeIdleLeads(repo, options) {
  const opts = options || {}
  const at = Number(opts.at) || Date.now()
  const minutes = Math.max(1, Number(opts.minutes) || 0)
  if (!minutes) return []
  const cutoff = at - minutes * 60000
  const rows = await repo.find('leads', { csStatus: CS_STATUS.SERVING }, { limit: 500 })
  const ended = []
  for (const row of rows) {
    if (!row || !row.id) continue
    if (row.targetType && row.targetType !== 'agency') continue
    const stage = stageOf(row)
    if (stage !== CONSULT_STAGE.COMMUNICATING && stage !== CONSULT_STAGE.TERMS) continue
    if (!row.assignedAccount) continue
    const base = Math.max(Number(row.csClaimedAt) || 0, Number(row.csLastReplyAt) || 0)
    if (!base || base > cutoff) continue
    try {
      await advance(repo, row, CONSULT_STAGE.ABORTED, {
        at,
        by: 'system',
        actorType: 'system',
        note: CONSULT_IDLE_CLOSE_NOTE
      })
    } catch (err) {
      /* 阶段已被客服推进或工单已被他人收尾：跳过，不阻断其它工单 */
      if (!err || err.code !== CODES.CONFLICT) console.error('[consult] 自动结束推进失败 ' + (err && err.message))
      continue
    }
    try {
      await endLead(repo, row, {
        at,
        accountId: 'system',
        staffName: '系统',
        reason: CONSULT_IDLE_CLOSE_NOTE,
        auto: true
      })
      ended.push(row.id)
    } catch (err) {
      console.error('[consult] 自动结束收尾失败 ' + (err && err.message))
    }
  }
  return ended
}

module.exports = {
  CONSULT_IDLE_CLOSE_NOTE,
  endLead,
  closeIdleLeads,
  CONTRACT_STATUS,
  CONTRACT_STATUS_LIST,
  TICKET_STATE,
  TICKET_STATE_LABELS,
  ticketStateOf,
  stageOf,
  stageLabel,
  stageIndex,
  canTransition,
  assertStage,
  ensureStage,
  advance,
  announceStage
}
