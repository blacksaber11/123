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
const {
  CONSULT_STAGE,
  CONSULT_STAGE_LABELS,
  CONSULT_STAGE_ORDER,
  CONSULT_TRANSITIONS
} = require('./constants')

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
      stageLabel: label
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

module.exports = {
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
