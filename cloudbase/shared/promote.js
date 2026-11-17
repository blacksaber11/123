'use strict'

/**
 * 推广分佣域（v5.1 人工分账交付版）。
 *
 * 口径（2026-11 人工分账版）：
 * 1. 佣金比例由平台统一设置（一级 / 二级均默认 15%，区间 5%–30%），推广者只读，不再自选。
 *    一级：被邀请人首次付款 → 直接推广人计佣。普通推广人只拿一级佣金；
 *    二级：仅当上家为「客服绑定账号」时，其下级的首次付款再给该账号计一份二级佣金。
 * 2. 开通推广后才生成 refCode；绑定关系一人一条，先到先得，不支持改绑。
 * 3. 支付成功实时计佣：C = round2(P × channelRate)、base = P − C、
 *    G = round2(base × commissionRate)、F = round2(G × feeRate)、N = G − F。
 *    落库带 transactionId / channel / rate / feeRate / channelRate 快照；
 *    绑定时间晚于支付、或支付早于推广者开通，均不计佣；paymentId 唯一幂等。
 * 4. 冻结至支付月份次月 15 日 00:00（Asia/Shanghai）；结算任务用条件更新
 *    把「待结算 → 可提现」，同时自动抵扣欠款并记 offsetToDebt。
 * 5. 提现必须人工审核。审核通过只生成「待打款」单与逐佣金出款明细，
 *    绝不调用任何微信分账 / 转账接口；财务领取后在商户平台手工操作并回填。
 * 6. 回填五项校验：明细合计 = 净额、每笔 ≤ 佣金可用净额、单据号全局唯一、
 *    payoutRequestId 幂等、大额双人复核。
 * 7. 退款冲正按 3.9：已出款若走分账路径，必须财务先手动回退并回填成功，
 *    才能把佣金置「已冲正」；未回填记欠款（按净额）。
 *
 * 所有金额统一用 round2（2 位小数）或整数分计算，禁止浮点直接比较相等。
 */

const { AppError, CODES } = require('./errors')
const { str, normalizePaging } = require('./validate')
const { randomId, sha256Hex } = require('./crypto')
const { appendAudit } = require('./audit')

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const CN_OFFSET = 8 * HOUR_MS

/** 协议版本：协议条款变更时必须同步改这里，旧版本签约用户会被要求重新确认 */
const AGREEMENT_VERSION = '2026-11-16'
const AGREEMENT_TITLE = '《算力商机平台推广服务协议》'

/** 平台统一佣金比例：推广者只读；上限受微信分账默认 30% 约束 */
const PROMOTE_RATE_MIN = 0.05
const PROMOTE_RATE_MAX = 0.3
const PROMOTE_RATE_DEFAULT = 0.15
/** 二级佣金比例：默认与一级一致 15%，可单独调整 */
const PROMOTE_L2_RATE_DEFAULT = 0.15
/** 二级佣金落库单号后缀：同一笔支付产生两级佣金，避免 paymentId 唯一索引冲突 */
const PROMOTE_L2_SUFFIX = '#L2'

/** 提现规则 */
const WITHDRAW_FEE_RATE = 0.05
const WITHDRAW_MIN = 100
const WITHDRAW_MAX = 20000
/** 单用户单日累计上限（按实际出款净额，路径 A / B 合并） */
const WITHDRAW_DAILY_MAX = 20000
/** 每人每日最多申请次数 */
const WITHDRAW_DAILY_COUNT = 3
/** 商户单日手动商家转账上限（超过顺延次日） */
const MERCHANT_DAILY_TRANSFER_MAX = 100000
/** 个税起征口径（taxEnabled=false 时不启用） */
const WITHDRAW_TAX_FREE = 800

/** 佣金状态 */
const COMMISSION_STATUS = Object.freeze({
  PENDING: '待结算',
  AVAILABLE: '可提现',
  WITHDRAWN: '已提现',
  REVERSED: '已冲正'
})

/** 提现状态（与文档 4.4 状态机一致） */
const WITHDRAW_STATUS = Object.freeze({
  PENDING: '待审核',
  APPROVED: '待打款',
  PAYING: '打款中',
  PAID: '已到账',
  FAILED: '打款失败',
  REJECTED: '已驳回',
  CANCELLED: '已撤销'
})

/** 出款明细状态 */
const PAYOUT_ITEM_STATUS = Object.freeze({
  TODO: 'todo',
  DOING: 'doing',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded'
})

/** 占用余额的提现状态：待审核 / 待打款 / 打款中（新人申请拦截口径） */
const WITHDRAW_ACTIVE = Object.freeze([
  WITHDRAW_STATUS.PENDING,
  WITHDRAW_STATUS.APPROVED,
  WITHDRAW_STATUS.PAYING
])

/** 统计「提现中」的口径：打款失败仍保持占用（I3） */
const WITHDRAW_OCCUPYING = Object.freeze([
  WITHDRAW_STATUS.PENDING,
  WITHDRAW_STATUS.APPROVED,
  WITHDRAW_STATUS.PAYING,
  WITHDRAW_STATUS.FAILED
])

/** 终态：不再占用余额，activeKey 改写唯一退休键（不能置 null，见 retiredKeyOf） */
const WITHDRAW_TERMINAL = Object.freeze([
  WITHDRAW_STATUS.PAID,
  WITHDRAW_STATUS.REJECTED,
  WITHDRAW_STATUS.CANCELLED
])

const DEFAULT_SETTINGS = Object.freeze({
  id: 'promote',
  /* 平台统一比例（只读给推广者）：一级 / 二级分别设置 */
  commissionRate: PROMOTE_RATE_DEFAULT,
  level2Rate: PROMOTE_L2_RATE_DEFAULT,
  rateMin: PROMOTE_RATE_MIN,
  rateMax: PROMOTE_RATE_MAX,
  feeRate: WITHDRAW_FEE_RATE,
  minWithdraw: WITHDRAW_MIN,
  maxWithdraw: WITHDRAW_MAX,
  dailyMaxWithdraw: WITHDRAW_DAILY_MAX,
  dailyMaxCount: WITHDRAW_DAILY_COUNT,
  freezeDay: 15,
  /* Apple 渠道结算到账晚于次月 15 日且可能事后退款：佣金到账确认前不解冻（文档 3.5） */
  appleArrivalHold: true,
  /* 必须人工审核 */
  autoApprove: false,
  /* 本期只有人工分账；auto 保留但不实现 */
  payoutMode: 'manual',
  manualDualCheckThreshold: 5000,
  payoutTimeoutHours: 24,
  taxEnabled: false,
  debtBlock: 500,
  /* 默认不开分账：分账会把整单资金冻结最长 180 天，与「只留佣金、其余随时可取」冲突。
     关闭后订单资金 T+1 正常结算到基本户，佣金只在台账上预留，出款统一走商家转账（路径 B） */
  splitEnabled: false,
  maxSplitRatio: 0.3,
  splitWarnDays: 150,
  splitExpireDays: 180,
  agreementVersion: AGREEMENT_VERSION,
  updatedAt: 0
})

const AGREEMENT_TEXT = [
  '一、推广者须为平台实名注册用户，开通前须阅读并同意本协议。',
  '二、佣金比例由平台统一设置并在推广中心只读展示；一级推广按平台设置的一级比例计佣，仅客服绑定账号另按其下级的首次付款计二级佣金，比例调整仅对调整后新支付的订单生效。',
  '三、开通推广后，分享任意页面（链接、二维码、朋友圈）都携带推广标识，好友打开并登录即自动绑定；开通前的历史分享不绑定任何用户，也不追溯计佣。',
  '四、被邀请用户首次登录时自动绑定推广关系，先到先得，不支持改绑。',
  '五、只有被邀请用户的首次会员支付成功才计入佣金，第二次及以后的付款（含续费）不再产生佣金；佣金冻结至首次支付月份次月 15 日 00:00 后可申请提现。',
  '六、佣金按毛额扣除 5% 手续费后出款；提现须经平台人工审核，由财务在商户平台人工分账或商家转账。',
  '七、发生退款、拒付或违规套利的，平台有权冲正佣金、暂停结算并追回已打款金额。',
  '八、推广者不得自推自买、虚假宣传、诱导用户退款或使用外挂批量注册，违者封禁推广资格。'
].join('\n')

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function centsOf(value) {
  return Math.round((Number(value) || 0) * 100)
}

function fromCents(value) {
  return Math.round(Number(value) || 0) / 100
}

/** 金额计算统一比较（按分） */
function moneyEq(a, b) {
  return centsOf(a) === centsOf(b)
}

function rateText(rate) {
  const n = Math.round((Number(rate) || 0) * 10000) / 100
  return String(n).replace(/\.0+$/, '') + '%'
}

function clampRate(rate, settings) {
  const n = Number(rate)
  const value = Number.isFinite(n) ? n : Number(settings.commissionRate) || PROMOTE_RATE_DEFAULT
  return Math.min(Math.max(value, settings.rateMin), settings.rateMax)
}

/** 北京时间月份键：2026-11 */
function monthKey(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 北京时间日期：2026-11-16 */
function dateText(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 北京时间日期时间：2026-11-16 10:00 */
function dateTimeText(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + CN_OFFSET)
  const p = (n) => String(n).padStart(2, '0')
  return `${dateText(ms)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 北京时间当天起止 [start, end) */
function dayRange(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - CN_OFFSET
  return { start, end: start + DAY_MS }
}

/** 冻结口径：支付时间所属月份的次月 15 日 00:00（北京时间） */
function eligibleAtOf(paidAt, freezeDay) {
  const day = Number(freezeDay) > 0 ? Number(freezeDay) : 15
  const d = new Date(Number(paidAt) + CN_OFFSET)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  return Date.UTC(y, m + 1, Math.min(day, 28), 0, 0, 0) - CN_OFFSET
}

/** 推广码：由 uid 派生，稳定且不暴露 uid 明文 */
function refCodeOf(uid) {
  return 'R' + sha256Hex('promote|' + String(uid || '')).slice(0, 7).toUpperCase()
}

/**
 * 终态占用键（I9）：微信云开发的唯一索引把 null / 缺字段视为同一个值，
 * 若终态仍写 null，同集合第二笔终态记录就会撞唯一约束。
 * 因此终态改写为唯一的退休键，既不再占用佣金位，也不会互相冲突。
 * 在途明细：activeCommissionKey = commissionId；在途提现单：activeKey = uid。
 */
function retiredKeyOf(id) {
  return 'R#' + String(id || '')
}

/** 通道费率：iOS 由 Apple 抽成 12%，其余按微信支付 1% 估算 */
function channelFeeRate(channel) {
  const c = String(channel || '').toLowerCase()
  return c === 'apple' || c === 'ios' ? 0.12 : 0.01
}

function normalizeChannel(channel) {
  const c = String(channel || '').toLowerCase()
  if (c === 'apple' || c === 'ios') return 'apple'
  if (c === 'xpay' || c === 'virtual') return 'xpay'
  return 'wxpay'
}

/**
 * 劳务报酬预扣个税（同一项目连续性收入按月合并）。
 * taxBase 为本月已计税收入，taxPaid 为本月已预扣税额。
 */
function taxOf(amount, taxBase, taxPaid) {
  const calc = (gross) => {
    if (gross <= 0) return 0
    const income = gross <= 4000 ? Math.max(0, gross - WITHDRAW_TAX_FREE) : gross * 0.8
    if (income <= 20000) return round2(income * 0.2)
    if (income <= 50000) return round2(income * 0.3 - 2000)
    return round2(income * 0.4 - 7000)
  }
  const base = Math.max(0, Number(taxBase) || 0)
  const paid = Math.max(0, Number(taxPaid) || 0)
  return Math.max(0, round2(calc(base + amount) - paid))
}

function isActiveWithdrawal(status) {
  return WITHDRAW_ACTIVE.indexOf(status) > -1
}

function isOccupyingWithdrawal(status) {
  return WITHDRAW_OCCUPYING.indexOf(status) > -1
}

/**
 * 佣金剩余可出款额度。
 * grossRemain：毛额口径剩余（amount − withdrawnAmount − offsetToDebt）
 * netRemain：净额口径剩余，出款明细金额不得超此值
 */
function commissionRemain(doc) {
  if (!doc || doc.status === COMMISSION_STATUS.REVERSED) {
    return { grossRemain: 0, netRemain: 0 }
  }
  const amount = round2(doc.amount)
  const grossRemain = Math.max(0, round2(amount - round2(doc.withdrawnAmount) - round2(doc.offsetToDebt)))
  const feeRate = Number(doc.feeRate)
  const netAmount = doc.netAmount === undefined ? round2(amount * (1 - (Number.isFinite(feeRate) ? feeRate : WITHDRAW_FEE_RATE))) : round2(doc.netAmount)
  const paid = round2(doc.payoutAmount)
  const netRemain = Math.max(0, round2(Math.min(netAmount - paid, grossRemain * (1 - (Number.isFinite(feeRate) ? feeRate : WITHDRAW_FEE_RATE)))))
  return { grossRemain, netRemain }
}

/** 是否具备分账条件（路径 A） */
function canSplit(doc, settings) {
  if (!doc || !doc.transactionId) return false
  if (doc.splitBlocked || doc.splitExpired) return false
  if (settings && settings.splitEnabled === false) return false
  return true
}

/** CSV 单元格转义 */
function csvCell(value) {
  const s = String(value === undefined || value === null ? '' : value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/**
 * 按毛额比例把 net 分配到各佣金，尾差用最大余数法补齐。
 * parts: [{ grossC }]；capsC：每笔净额上限（分）。
 * 返回 { amounts: number[]（分）, allocatedC, uncoveredC }
 */
function allocateNetCents(parts, net, capsC) {
  const totalGrossC = parts.reduce((sum, p) => sum + Math.max(0, Math.round(p.grossC)), 0)
  const netC = Math.max(0, Math.round((Number(net) || 0) * 100))
  if (!parts.length || totalGrossC <= 0 || netC <= 0) {
    return { amounts: parts.map(() => 0), allocatedC: 0, uncoveredC: netC }
  }
  /* 净额少到无法给每条明细 1 分时，只保留前 netC 条（每条至少 1 分） */
  if (netC < parts.length) {
    const keep = netC
    const trimmed = parts.slice(0, keep)
    return {
      amounts: trimmed.map(() => 1),
      allocatedC: keep,
      uncoveredC: 0,
      droppedParts: parts.slice(keep).length
    }
  }
  const raw = parts.map((p) => (netC * Math.max(0, Math.round(p.grossC))) / totalGrossC)
  const amounts = raw.map((v) => Math.floor(v))
  let used = amounts.reduce((s, v) => s + v, 0)
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v), grossC: parts[i].grossC }))
    .sort((a, b) => (b.frac - a.frac) || (b.grossC - a.grossC) || (a.i - b.i))
  let left = netC - used
  for (let k = 0; k < order.length && left > 0; k += 1) {
    amounts[order[k].i] += 1
    left -= 1
  }
  /* 上限修正：超出单笔佣金净额的部分，转给还有余量的明细 */
  if (Array.isArray(capsC)) {
    let overflow = 0
    for (let i = 0; i < amounts.length; i += 1) {
      const cap = Math.max(0, Math.round(capsC[i] || 0))
      if (amounts[i] > cap) {
        overflow += amounts[i] - cap
        amounts[i] = cap
      }
    }
    while (overflow > 0) {
      let target = -1
      let room = 0
      for (let i = 0; i < amounts.length; i += 1) {
        const r = Math.max(0, Math.round(capsC[i] || 0)) - amounts[i]
        if (r > room) {
          room = r
          target = i
        }
      }
      if (target === -1) break
      const add = Math.min(room, overflow)
      amounts[target] += add
      overflow -= add
    }
  }
  /* 最少 1 分：从金额最大的明细挪 1 分补齐 */
  for (let i = 0; i < amounts.length; i += 1) {
    if (amounts[i] >= 1) continue
    let donor = -1
    let max = 1
    for (let j = 0; j < amounts.length; j += 1) {
      if (amounts[j] > max) {
        max = amounts[j]
        donor = j
      }
    }
    if (donor === -1) break
    amounts[donor] -= 1
    amounts[i] = 1
  }
  const allocatedC = amounts.reduce((s, v) => s + v, 0)
  return { amounts, allocatedC, uncoveredC: Math.max(0, netC - allocatedC) }
}

function createPromoteEngine(deps) {
  const repo = deps.repo
  /* 人工分账：保留入参以兼容调用方，但本期不发起任何微信出款请求 */
  const payoutClient = deps.payoutClient || null
  const now = deps.now || (() => Date.now())

  function at() {
    return Number(now())
  }

  async function findOne(collection, query) {
    const rows = await repo.find(collection, query, { limit: 1 })
    return rows[0] || null
  }

  /** 客服绑定关系：绑定账号即使未走线上开通，也按推广人计两级佣金 */
  async function csBoundOf(uid) {
    if (!uid) return null
    return findOne('csBindings', { uid })
  }

  void payoutClient

  async function readSettings() {
    let stored = null
    try {
      stored = await repo.get('promoteSettings', 'promote')
    } catch (err) {
      stored = null
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, stored || {})
    /* 老配置里若残留自动审核 / 自动出款，一律按人工分账口径纠正 */
    merged.id = 'promote'
    merged.autoApprove = false
    merged.payoutMode = 'manual'
    const rate = Number(merged.commissionRate)
    merged.commissionRate = Number.isFinite(rate) ? Math.min(Math.max(rate, merged.rateMin), merged.rateMax) : PROMOTE_RATE_DEFAULT
    const l2Rate = Number(merged.level2Rate)
    merged.level2Rate = Number.isFinite(l2Rate) ? Math.min(Math.max(l2Rate, merged.rateMin), merged.rateMax) : PROMOTE_L2_RATE_DEFAULT
    return merged
  }

  async function notifyUser(uid, title, body, targetType, targetId) {
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
        reason: '',
        targetType: targetType || 'promote',
        targetId: targetId || ''
      },
      status: 'pending',
      createdAt: at()
    })
  }

  async function mustUser(uid) {
    const user = await repo.get('users', uid)
    if (!user) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
    if (user.status === '停用') throw new AppError(CODES.FORBIDDEN, '账号已停用，请联系平台客服')
    return user
  }

  function risky(user) {
    if (!user || !user.riskFlag) return false
    const since = Number(user.riskSince) || 0
    return !since || at() - since <= 90 * DAY_MS
  }

  /** 生成并落库推广码；已有则直接返回 */
  async function ensureRefCode(uid) {
    const user = await repo.get('users', uid)
    if (!user) return ''
    if (user.refCode) return String(user.refCode)
    let code = refCodeOf(uid)
    for (let i = 0; i < 6; i += 1) {
      const clash = await repo.find('users', { refCode: code }, { limit: 1 })
      if (!clash.length || clash[0].id === uid) break
      code = code.slice(0, 7) + String(i + 2)
    }
    await repo.updateWhere('users', { id: uid }, { refCode: code })
    return code
  }

  /**
   * 登录时绑定推广关系。
   * - 只有「已开通推广」的推广码才有效；
   * - 一人只能绑定一次，先到先得；
   * - 不带 ref 的历史分享永远不会触发绑定。
   */
  async function bindOnLogin(uid, refCode, scene) {
    const code = str(refCode, { field: '推广码', max: 16 }).toUpperCase()
    if (!code) return { bound: false, reason: 'no-ref' }
    const user = await mustUser(uid)
    const existed = await repo.get('referralBindings', uid)
    if (existed) return { bound: false, reason: 'already', refUid: existed.refUid }
    const rows = await repo.find('users', { refCode: code }, { limit: 1 })
    const refUser = rows[0]
    if (!refUser || refUser.id === uid) return { bound: false, reason: 'invalid-ref' }
    if (refUser.promoterStatus !== 'active') return { bound: false, reason: 'not-active' }
    if (risky(refUser)) return { bound: false, reason: 'risk' }
    const boundAt = at()
    const sceneText = str(scene, { field: '场景', max: 24 }) || 'login'
    try {
      await repo.insert('referralBindings', {
        id: uid,
        uid,
        refUid: refUser.id,
        refCode: code,
        scene: sceneText,
        boundAt,
        /* 绑定只奖励支付，不奖励注册：首单时间由计佣时回写 */
        firstOrderAt: 0
      })
    } catch (err) {
      if (!err || err.code !== CODES.CONFLICT) throw err
      return { bound: false, reason: 'already' }
    }
    await repo.updateWhere('users', { id: uid }, {
      referredBy: refUser.id,
      refBoundAt: boundAt,
      refScene: sceneText
    })
    void user
    await appendAudit(repo, {
      actorType: 'system',
      actorId: 'promote',
      action: 'promote.bind',
      target: uid,
      reason: `绑定推广人 ${refUser.id} · ${code}`,
      at: boundAt
    })
    return { bound: true, refUid: refUser.id, refCode: code }
  }

  async function openPromoter(uid, data) {
    const d = data || {}
    const user = await mustUser(uid)
    if (risky(user)) throw new AppError(CODES.FORBIDDEN, '该账号近期退款次数较多，暂不支持开通推广')
    if (d.agreed !== true) throw new AppError(CODES.VALIDATION, `请先阅读并同意${AGREEMENT_TITLE}`)
    const settings = await readSettings()
    const version = str(d.agreementVersion, { field: '协议版本', max: 24 }) || settings.agreementVersion
    if (version !== settings.agreementVersion) {
      throw new AppError(CODES.VALIDATION, '协议已更新，请重新阅读并确认最新版本')
    }
    const openedAt = at()
    const refCode = await ensureRefCode(uid)
    await repo.updateWhere('users', { id: uid }, {
      promoterStatus: 'active',
      promoterSince: user.promoterSince || openedAt,
      promoterOpenedAt: openedAt,
      agreementVersion: version,
      agreementAt: openedAt,
      refCode,
      promoterDebt: round2(user.promoterDebt || 0)
    })
    await repo.insert('promoteAgreements', {
      id: randomId('PA'),
      uid,
      version,
      rate: settings.commissionRate,
      agreedAt: openedAt,
      title: AGREEMENT_TITLE,
      text: AGREEMENT_TEXT
    })
    await appendAudit(repo, {
      actorType: 'user',
      actorId: uid,
      action: 'promote.open',
      target: uid,
      reason: `开通推广 · 平台比例 ${rateText(settings.commissionRate)} · 协议 ${version}`,
      at: openedAt
    })
    await notifyUser(
      uid,
      '推广已开通',
      `平台统一佣金比例为 ${rateText(settings.commissionRate)}（只读）。现在分享任意页面给好友，好友打开并登录即自动绑定；只有好友第一次付款成功才产生佣金，第二次及以后付款（含续费）不再产生佣金。`,
      'promote'
    )
    return summary(uid)
  }

  async function agreementInfo() {
    const settings = await readSettings()
    const rate = clampRate(settings.commissionRate, settings)
    const feeRate = Number(settings.feeRate)
    return {
      version: AGREEMENT_VERSION,
      title: AGREEMENT_TITLE,
      text: AGREEMENT_TEXT,
      commissionRate: rate,
      rateMin: settings.rateMin,
      rateMax: settings.rateMax,
      rateText: rateText(rate),
      feeRate,
      feeText: rateText(feeRate),
      minWithdraw: Number(settings.minWithdraw) || WITHDRAW_MIN,
      maxWithdraw: Number(settings.maxWithdraw) || WITHDRAW_MAX,
      freezeDay: Number(settings.freezeDay) || 15,
      payoutMode: 'manual'
    }
  }

  /**
   * 带比较并交换的用户余额更新：避免并发下丢失更新或重复扣款。
   * mutate 必须返回要写入的字段；promoterAvailable / promoterWithdrawing 会参与 CAS 条件。
   */
  async function applyUserPatch(uid, mutate) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const user = await repo.get('users', uid)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const patch = mutate(user)
      if (!patch) return null
      const query = { id: uid }
      if (user.promoterAvailable !== undefined) query.promoterAvailable = round2(user.promoterAvailable)
      if (user.promoterWithdrawing !== undefined) query.promoterWithdrawing = round2(user.promoterWithdrawing)
      const res = await repo.updateWhere('users', query, Object.assign({ updatedAt: at() }, patch))
      if (res.count > 0) return patch
    }
    throw new AppError(CODES.CONFLICT, '账户余额更新冲突，请稍后重试')
  }

  /**
   * 实时计佣。
   * input: { uid, paymentId, amount, channel, transactionId, orderId, at/paidAt }
   * 幂等：paymentId 唯一；重复调用直接返回既有记录。
   */
  async function createCommission(input) {
    const d = input || {}
    const sourcePaymentId = str(d.paymentId, { field: '支付单号', max: 80 })
    if (!sourcePaymentId) throw new AppError(CODES.VALIDATION, '缺少支付单号')
    /* 同一笔支付最多产生两级佣金：一级沿用原单号，二级加后缀落库，保持 paymentId 唯一幂等 */
    const level = Number(d.level) === 2 ? 2 : 1
    const paymentId = level === 2 ? `${sourcePaymentId}${PROMOTE_L2_SUFFIX}` : sourcePaymentId
    const existed = await findOne('commissions', { paymentId })
    if (existed) return existed

    const uid = str(d.uid, { field: '推广人', max: 80 })
    if (!uid) throw new AppError(CODES.VALIDATION, '缺少推广人')
    const paidAmount = round2(d.amount)
    if (centsOf(paidAmount) <= 0) return null

    const settings = await readSettings()
    const promoter = await repo.get('users', uid)
    if (!promoter) return null
    /* 客服绑定账号视同推广人：即便没走线上开通，也按两级佣金计入其推广收入 */
    const csBound = await csBoundOf(uid)
    if (promoter.promoterStatus !== 'active' && !csBound) return null
    if (risky(promoter)) return null

    const paidAt = Number(d.at || d.paidAt) || at()
    /* relationUid 是「与推广人直接绑定」的那个人：一级=买家本人，二级=买家的直接推广人 */
    const relationUid = str(d.relationUid, { field: '推广关系', max: 80 }) || str(d.buyerUid, { field: '买家', max: 80 })
    if (!relationUid) return null
    const binding = await repo.get('referralBindings', relationUid)
    if (!binding) return null
    if (binding.refUid !== uid) return null
    const boundAt = Number(binding.boundAt) || 0
    /* 绑定时间必须早于支付时间，否则不计佣 */
    if (boundAt && boundAt > paidAt) return null
    const openedAt = Number(promoter.promoterOpenedAt || promoter.promoterSince) || 0
    /* 支付时间早于推广者开通时间，不计佣（不追溯历史订单）；客服绑定账号无开通时间时按绑定时间起算 */
    if (openedAt && paidAt < openedAt) return null
    if (!openedAt && csBound && boundAt && paidAt < boundAt) return null

    /* 只对好友的首次会员付款计佣：存在更早的已确认会员收款即视为续费，第二次及以后付款不再产生佣金 */
    const buyerUid = str(d.buyerUid, { field: '买家', max: 80 })
    if (buyerUid) {
      const earlier = await repo.find('payments', {
        uid: buyerUid,
        bizType: '会员续费',
        status: '已确认',
        paymentId: { $ne: sourcePaymentId }
      }, { limit: 1 })
      if (earlier.length) return null
    }

    const channel = normalizeChannel(d.channel)
    const channelRate = channelFeeRate(channel)
    const channelCost = round2(paidAmount * channelRate)
    const base = round2(paidAmount - channelCost)
    const rate = clampRate(level === 2 ? settings.level2Rate : settings.commissionRate, settings)
    const amount = round2(base * rate)
    const feeRate = Number(settings.feeRate) >= 0 ? Number(settings.feeRate) : WITHDRAW_FEE_RATE
    const feeAmount = round2(amount * feeRate)
    const netAmount = round2(amount - feeAmount)
    if (centsOf(amount) <= 0) return null

    const doc = {
      id: randomId('C'),
      uid,
      buyerUid: str(d.buyerUid, { field: '买家', max: 80 }),
      paymentId,
      /* 原始支付单号：一级 / 二级佣金都能按它一次性冲正 */
      sourcePaymentId,
      level,
      orderId: str(d.orderId, { field: '订单号', max: 80 }),
      transactionId: str(d.transactionId, { field: '交易单号', max: 80 }),
      channel,
      channelRate,
      paidAmount,
      channelCost,
      base,
      rate,
      feeRate,
      amount,
      feeAmount,
      netAmount,
      /* 冻结至支付月份次月 15 日 00:00 */
      eligibleAt: eligibleAtOf(paidAt, settings.freezeDay),
      /* Apple 渠道：不看日历解冻，等财务按月确认结算到账（promote.appleSettle） */
      arrivalHold: settings.appleArrivalHold !== false && channel === 'apple',
      status: COMMISSION_STATUS.PENDING,
      withdrawnAmount: 0,
      payoutAmount: 0,
      offsetToDebt: 0,
      splitBlocked: false,
      splitExpired: false,
      debtRecorded: false,
      debtAmount: 0,
      reversedAt: 0,
      reverseReason: '',
      createdAt: paidAt,
      updatedAt: at()
    }
    try {
      await repo.insert('commissions', doc)
    } catch (err) {
      if (!err || err.code !== CODES.CONFLICT) throw err
      const again = await findOne('commissions', { paymentId })
      if (again) return again
      throw err
    }

    await applyUserPatch(uid, (user) => ({
      promoterEarning: round2((user.promoterEarning || 0) + amount),
      promoterPending: round2((user.promoterPending || 0) + amount),
      promoterCommissionRate: rate
    }))
    if (!Number(binding.firstOrderAt)) {
      await repo.updateWhere('referralBindings', { id: binding.id }, { firstOrderAt: paidAt })
    }

    const rule = doc.arrivalHold
      ? 'Apple 渠道款项由平台确认到账后可提现'
      : `预计 ${dateText(doc.eligibleAt)} 后可提现`
    await notifyUser(
      uid,
      level === 2 ? '二级推广佣金已入账' : '推广佣金已入账',
      `${level === 2 ? '二级好友' : '好友'}支付 ¥${paidAmount.toFixed(2)}，平台按 ${rateText(rate)} 计佣 ¥${amount.toFixed(2)}（扣 5% 手续费后 ¥${netAmount.toFixed(2)}），${rule}。`,
      'commission',
      doc.id
    )
    await appendAudit(repo, {
      actorType: 'system',
      actorId: 'promote',
      action: 'promote.commission.create',
      target: doc.id,
      reason: `payment=${sourcePaymentId} level=${level} gross=${amount} net=${netAmount} rate=${rate} feeRate=${feeRate} channelRate=${channelRate}`,
      at: at()
    })
    return doc
  }

  /**
   * 支付成功的一次性两级计佣入口。
   * 一级：买家 → 直接推广人。
   * 二级：仅当买家的直接推广人之上家是「客服绑定账号」时才计佣，普通推广人没有二级收入。
   * 两级互相独立：一级不合格（封禁 / 风险）不影响二级按规则计佣。
   */
  async function createPaymentCommissions(input) {
    const d = input || {}
    const buyerUid = str(d.buyerUid, { field: '买家', max: 80 })
    const binding = buyerUid ? await repo.get('referralBindings', buyerUid) : null
    const l1Uid = str(d.uid, { field: '推广人', max: 80 }) || (binding && binding.refUid) || ''
    const first = l1Uid
      ? await createCommission(Object.assign({}, d, { uid: l1Uid, relationUid: buyerUid, level: 1 }))
      : null
    let second = null
    if (l1Uid && l1Uid !== buyerUid) {
      const up = await repo.get('referralBindings', l1Uid)
      const l2Uid = up && up.refUid
      /* 二级佣金只发给客服绑定账号：普通推广人只拿一级佣金 */
      if (l2Uid && l2Uid !== buyerUid && l2Uid !== l1Uid && (await csBoundOf(l2Uid))) {
        second = await createCommission(Object.assign({}, d, { uid: l2Uid, relationUid: l1Uid, level: 2 }))
      }
    }
    return { first: first || null, second: second || null }
  }

  /**
   * 退款冲正（文档 3.9）。
   * input: { paymentId, reason, at, splitRefundDone, splitRefundNo, actorType, actorId }
   * 已出款且走分账路径：必须先由财务在商户平台手动回退并回填成功，
   * 否则只记欠款（按净额），佣金保持原状态，绝不假装已冲正。
   */
  async function reverseCommissionOne(input) {
    const d = input || {}
    const paymentId = str(d.paymentId, { field: '支付单号', max: 80 })
    if (!paymentId) return { reversed: false, reason: 'missing-payment' }
    const doc = await findOne('commissions', { paymentId })
    if (!doc) return { reversed: false, reason: 'not-found' }
    if (doc.status === COMMISSION_STATUS.REVERSED) {
      /* 已冲正后补录分账 / 转账回退单号：只补凭证、清欠款，不重复改余额 */
      const refundNo = str(d.splitRefundNo, { field: '回退单号', max: 80 })
      const refunded = d.splitRefundDone === true || !!refundNo
      if (refunded && (!doc.refundNo || !Number(doc.refundAt))) {
        const when0 = Number(d.at) || at()
        const clearDebt0 = doc.debtRecorded ? round2(doc.debtAmount) : 0
        const patch0 = { refundNo, refundAt: when0, updatedAt: when0 }
        if (clearDebt0 > 0) {
          patch0.debtRecorded = false
          patch0.debtAmount = 0
          patch0.debtClearedAt = when0
        }
        await repo.updateWhere('commissions', { id: doc.id, status: COMMISSION_STATUS.REVERSED }, patch0)
        if (clearDebt0 > 0) {
          await applyUserPatch(doc.uid, (user) => ({
            promoterDebt: Math.max(0, round2((user.promoterDebt || 0) - clearDebt0))
          }))
        }
        await appendAudit(repo, {
          actorType: d.actorType || 'system',
          actorId: d.actorId || 'market',
          action: 'promote.commission.backfill',
          target: doc.id,
          reason: `补录回退单号 ${refundNo} · 清欠款 ${clearDebt0}`,
          at: when0
        })
        return { reversed: true, reason: 'backfill-recorded', commissionId: doc.id, debt: 0 }
      }
      return { reversed: true, reason: 'already-reversed', commissionId: doc.id }
    }

    const reason = str(d.reason, { field: '冲正原因', max: 200 }) || '订单退款'
    const when = Number(d.at) || at()
    const paidNet = round2(doc.payoutAmount)
    const status = doc.status
    const remainingGross = Math.max(0, round2(doc.amount - round2(doc.withdrawnAmount) - round2(doc.offsetToDebt)))
    const refunded = d.splitRefundDone === true || !!str(d.splitRefundNo, { field: '回退单号', max: 80 })

    /* 出款明细一次取出：既算在途占用，也判定是否真的走过路径 A 分账出款。
       按明细判定而不是看当前开关——出款后再改 splitEnabled 也不会误判退款口径 */
    let items = []
    try {
      items = await repo.find('promotePayoutItems', { commissionId: doc.id }, { limit: 200 })
    } catch (err) {
      items = []
    }
    const splitPath = items.length
      ? items.some((it) => it.path === 'A' && it.status === PAYOUT_ITEM_STATUS.DONE)
      /* 历史数据没有出款明细时，回落到「订单 + 开关」推断 */
      : (centsOf(paidNet) > 0 && canSplit(doc, await readSettings()))

    /* 在途出款明细（待打款 / 打款中 / 失败重试）的毛额在申请提现时已从可提现余额划入「提现中」，
       冲正时不能再扣一次，否则会吃掉同一用户其他佣金的可提现余额（资金安全） */
    let reservedGross = 0
    try {
      const inFlight = items.filter((it) => [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING, PAYOUT_ITEM_STATUS.FAILED].indexOf(it.status) >= 0)
      reservedGross = round2(inFlight.reduce((sum, it) => round2(sum + round2(it.grossPart)), 0))
    } catch (err) {
      reservedGross = 0
    }
    const deductibleGross = Math.max(0, round2(remainingGross - reservedGross))

    /* 待审核提现单在申请时已占用毛额、尚未生成明细；按 3.9 先撤销提现（毛额退回余额），再冲正 */
    if (status === COMMISSION_STATUS.AVAILABLE && centsOf(reservedGross) === 0) {
      const pendingW = await findOne('promoterWithdrawals', { uid: doc.uid, status: WITHDRAW_STATUS.PENDING })
      if (pendingW) {
        const cancelRes = await repo.updateWhere('promoterWithdrawals', { id: pendingW.id, status: WITHDRAW_STATUS.PENDING }, {
          status: WITHDRAW_STATUS.CANCELLED,
          activeKey: retiredKeyOf(pendingW.id),
          cancelReason: `退款冲正自动撤销：${reason}`,
          cancelledAt: when,
          updatedAt: when
        })
        if (cancelRes.count > 0) {
          await releaseWithdrawal(doc.uid, pendingW)
          await notifyUser(doc.uid, '提现已撤销',
            `因订单退款冲正，待审核提现单 ¥${round2(pendingW.amount).toFixed(2)} 已退回可提现余额，可重新申请。`,
            'withdraw', pendingW.id)
        }
      }
    }

    /* 已出款净额需要财务回退；未回填先记欠款并保持原状态 */
    let debtAdd = 0
    let canReverse = true
    if (centsOf(paidNet) > 0) {
      if (!refunded) {
        debtAdd = paidNet
        if (splitPath) canReverse = false
      }
    }
    /* 之前因未回填记过欠款，本次回填成功后要把欠款冲掉 */
    const clearDebt = refunded && doc.debtRecorded ? round2(doc.debtAmount) : 0

    const patch = {
      updatedAt: when,
      reverseReason: reason,
      refundNo: str(d.splitRefundNo, { field: '回退单号', max: 80 }),
      refundAt: refunded ? when : 0
    }
    if (canReverse) {
      patch.status = COMMISSION_STATUS.REVERSED
      patch.reversedAt = when
    }
    if (debtAdd > 0 && !doc.debtRecorded) {
      patch.debtRecorded = true
      patch.debtAmount = debtAdd
    }
    if (clearDebt > 0) {
      patch.debtRecorded = false
      patch.debtAmount = 0
      patch.debtClearedAt = when
    }
    const res = await repo.updateWhere('commissions', { id: doc.id, status }, patch)
    if (res.count === 0) {
      const latest = await repo.get('commissions', doc.id)
      if (latest && latest.status === COMMISSION_STATUS.REVERSED) {
        return { reversed: true, reason: 'already-reversed', commissionId: doc.id }
      }
      throw new AppError(CODES.CONFLICT, '佣金状态已变更，请刷新后重试')
    }

    await applyUserPatch(doc.uid, (user) => {
      const next = {}
      if (status === COMMISSION_STATUS.PENDING && canReverse) {
        next.promoterPending = Math.max(0, round2((user.promoterPending || 0) - round2(doc.amount)))
      }
      /* 已出款且回退未完成时首次冲正已扣过可提现余额并记欠款；
         后续回填回退成功只做状态与欠款处理，不能重复扣减 available；
         已被在途明细占用的毛额不再二次扣减 */
      if (status === COMMISSION_STATUS.AVAILABLE && centsOf(deductibleGross) > 0 && !doc.debtRecorded) {
        next.promoterAvailable = Math.max(0, round2((user.promoterAvailable || 0) - deductibleGross))
      }
      if (canReverse) {
        next.promoterEarning = Math.max(0, round2((user.promoterEarning || 0) - round2(doc.amount)))
      }
      if (debtAdd > 0 && !doc.debtRecorded) {
        next.promoterDebt = round2((user.promoterDebt || 0) + debtAdd)
      }
      if (clearDebt > 0) {
        next.promoterDebt = Math.max(0, round2((user.promoterDebt || 0) - clearDebt))
      }
      return next
    })

    const targetType = d.actorType === 'staff' ? 'staff' : 'system'
    const body = canReverse
      ? `订单退款，佣金 ¥${round2(doc.amount).toFixed(2)} 已冲正。`
      : `订单退款，已出款 ¥${paidNet.toFixed(2)} 正在商户平台回退；回退成功前该笔佣金不会标记冲正。`
    await notifyUser(doc.uid, canReverse ? '佣金已冲正' : '退款处理中', body, 'commission', doc.id)
    await appendAudit(repo, {
      actorType: d.actorType || 'system',
      actorId: d.actorId || 'market',
      action: 'promote.commission.reverse',
      target: doc.id,
      reason: `${reason} · reversed=${canReverse} · debt=+${debtAdd} · splitPath=${splitPath} · refunded=${refunded}`,
      at: when
    })
    if (!canReverse) {
      return {
        reversed: false,
        pendingSplitRefund: true,
        debt: debtAdd,
        commissionId: doc.id,
        message: '已出款佣金需财务在商户平台手动回退并回填成功后才能冲正'
      }
    }
    return { reversed: true, debt: debtAdd, commissionId: doc.id, targetType }
  }

  /**
   * 退款冲正：同一笔支付可能同时有一级、二级两笔佣金，必须一起冲正。
   * 返回一级结果并带上二级结果汇总，调用方按 reversed / debt 判断即可。
   */
  async function reverseCommission(input) {
    const d = input || {}
    const sourcePaymentId = str(d.paymentId, { field: '支付单号', max: 80 })
    if (!sourcePaymentId) return { reversed: false, reason: 'missing-payment' }
    const first = await reverseCommissionOne(Object.assign({}, d, { paymentId: sourcePaymentId }))
    const second = await reverseCommissionOne(Object.assign({}, d, { paymentId: `${sourcePaymentId}${PROMOTE_L2_SUFFIX}` }))
    const hasSecond = second.reason !== 'not-found'
    if (!hasSecond) return first
    const debt = round2((Number(first.debt) || 0) + (Number(second.debt) || 0))
    const reversed = !!first.reversed || !!second.reversed
    return Object.assign({}, first, {
      reversed,
      debt,
      reason: first.reversed ? first.reason : second.reason,
      second: {
        reversed: !!second.reversed,
        debt: Number(second.debt) || 0,
        commissionId: second.commissionId || '',
        pendingSplitRefund: !!second.pendingSplitRefund
      }
    })
  }

  /**
   * 结算：待结算 → 可提现（条件更新 CAS），成功后自动抵扣欠款并记 offsetToDebt。
   */
  async function settlePending(input) {
    const current = Number(input && input.at) || at()
    let count = 0
    let amountTotal = 0
    let offsetTotal = 0
    const notices = Object.create(null)

    /* 分批处理：每批 500 条，避免单日超过 500 笔时后面的佣金一直排不上结算 */
    for (let batch = 0; batch < 20; batch += 1) {
      /* 到账冻结（Apple 渠道）的佣金不走日历解冻，等财务按月确认（appleSettle） */
      const rows = await repo.find('commissions', {
        status: COMMISSION_STATUS.PENDING,
        arrivalHold: { $ne: true }
      }, {
        sort: { createdAt: 1 },
        limit: 500
      })
      if (!rows.length) break
      let processed = 0
      for (const doc of rows) {
        const eligibleAt = Number(doc.eligibleAt || doc.releaseAt) || 0
        if (eligibleAt > current) break
        const res = await repo.updateWhere('commissions', {
          id: doc.id,
          status: COMMISSION_STATUS.PENDING
        }, {
          status: COMMISSION_STATUS.AVAILABLE,
          settledAt: current,
          updatedAt: current
        })
        processed += 1
        if (res.count === 0) continue
        count += 1
        amountTotal = round2(amountTotal + round2(doc.amount))

        let offset = 0
        await applyUserPatch(doc.uid, (user) => {
          offset = Math.min(round2(user.promoterDebt), round2(doc.amount))
          return {
            promoterPending: Math.max(0, round2((user.promoterPending || 0) - round2(doc.amount))),
            promoterAvailable: round2((user.promoterAvailable || 0) + round2(doc.amount) - offset),
            promoterDebt: Math.max(0, round2((user.promoterDebt || 0) - offset)),
            promoterAppliedToDebt: round2((user.promoterAppliedToDebt || 0) + offset)
          }
        })
        if (offset > 0) {
          await repo.updateWhere('commissions', { id: doc.id }, { offsetToDebt: offset, updatedAt: current })
          offsetTotal = round2(offsetTotal + offset)
        }
        const slot = notices[doc.uid] || (notices[doc.uid] = { amount: 0, offset: 0 })
        slot.amount = round2(slot.amount + round2(doc.amount))
        slot.offset = round2(slot.offset + offset)
      }
      /* 未处理满一批说明已无可结算数据 */
      if (processed < rows.length || rows.length < 500) break
    }

    for (const uid of Object.keys(notices)) {
      const n = notices[uid]
      const tail = n.offset > 0 ? `，其中 ¥${n.offset.toFixed(2)} 自动抵扣欠款` : ''
      await notifyUser(
        uid,
        '佣金已可提现',
        `本期结算 ¥${n.amount.toFixed(2)}${tail}，可在推广中心申请提现（满 ${WITHDRAW_MIN} 元，需人工审核）。`,
        'promote'
      )
    }
    return { count, amount: amountTotal, offset: offsetTotal }
  }

  /**
   * Apple 渠道到账确认（文档 3.5）：Apple 结算款到账后，财务按「支付月份」确认，
   * 把该月到账冻结的待结算佣金解冻为可提现（同口径自动抵扣欠款）。
   * input: { month: 'YYYY-MM', actor, at }
   */
  async function appleSettle(input) {
    const d = input || {}
    const month = str(d.month, { field: '到账月份', max: 7 })
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError(CODES.VALIDATION, '月份格式应为 YYYY-MM')
    }
    const parts = month.split('-')
    /* 佣金 createdAt 即支付时间：按支付月份圈定 Apple 的结算批次 */
    const start = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1) - CN_OFFSET
    const end = Date.UTC(Number(parts[0]), Number(parts[1]), 1) - CN_OFFSET
    const current = Number(d.at) || at()
    const filter = {
      status: COMMISSION_STATUS.PENDING,
      arrivalHold: true,
      createdAt: { $gte: start, $lt: end }
    }
    let count = 0
    let amountTotal = 0
    let offsetTotal = 0
    const notices = Object.create(null)
    for (let batch = 0; batch < 20; batch += 1) {
      const rows = await repo.find('commissions', filter, { sort: { createdAt: 1 }, limit: 500 })
      if (!rows.length) break
      let processed = 0
      for (const doc of rows) {
        /* CAS：仅当仍是「待结算且到账冻结」时解冻，重复确认不会二次入账 */
        const res = await repo.updateWhere('commissions', {
          id: doc.id,
          status: COMMISSION_STATUS.PENDING,
          arrivalHold: true
        }, {
          status: COMMISSION_STATUS.AVAILABLE,
          arrivalHold: false,
          arrivedAt: current,
          settledAt: current,
          eligibleAt: current,
          updatedAt: current
        })
        processed += 1
        if (res.count === 0) continue
        count += 1
        amountTotal = round2(amountTotal + round2(doc.amount))
        let offset = 0
        await applyUserPatch(doc.uid, (user) => {
          offset = Math.min(round2(user.promoterDebt), round2(doc.amount))
          return {
            promoterPending: Math.max(0, round2((user.promoterPending || 0) - round2(doc.amount))),
            promoterAvailable: round2((user.promoterAvailable || 0) + round2(doc.amount) - offset),
            promoterDebt: Math.max(0, round2((user.promoterDebt || 0) - offset)),
            promoterAppliedToDebt: round2((user.promoterAppliedToDebt || 0) + offset)
          }
        })
        if (offset > 0) {
          await repo.updateWhere('commissions', { id: doc.id }, { offsetToDebt: offset, updatedAt: current })
          offsetTotal = round2(offsetTotal + offset)
        }
        const slot = notices[doc.uid] || (notices[doc.uid] = { amount: 0, offset: 0 })
        slot.amount = round2(slot.amount + round2(doc.amount))
        slot.offset = round2(slot.offset + offset)
      }
      /* 未处理满一批说明已无可解冻数据 */
      if (processed < rows.length || rows.length < 500) break
    }
    for (const uid of Object.keys(notices)) {
      const n = notices[uid]
      const tail = n.offset > 0 ? `，其中 ¥${n.offset.toFixed(2)} 自动抵扣欠款` : ''
      await notifyUser(
        uid,
        'Apple 佣金已可提现',
        `${month} Apple 渠道款项已确认到账，本期解冻 ¥${n.amount.toFixed(2)}${tail}，可在推广中心申请提现（满 ${WITHDRAW_MIN} 元，需人工审核）。`,
        'promote'
      )
    }
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: str(d.actor, { field: '操作人', max: 80 }) || 'finance',
      action: 'promote.appleSettle',
      target: month,
      reason: `month=${month} released=${count} amount=${amountTotal} offset=${offsetTotal}`,
      at: current
    })
    return { month, count, amount: amountTotal, offset: offsetTotal }
  }

  async function commissionLedger(uid) {
    const rows = await repo.find('commissions', { uid }, { limit: 5000 })
    /* 在途出款明细（待打款 / 打款中 / 失败重试）占用的毛额已从可提现余额划入「提现中」，
       台账必须同步扣掉，否则用户会看到一笔其实已经在申请中的「可提现」余额 */
    const reserved = Object.create(null)
    try {
      const items = await repo.find('promotePayoutItems', {
        uid,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING, PAYOUT_ITEM_STATUS.FAILED] }
      }, { limit: 5000 })
      for (const it of items) {
        reserved[it.commissionId] = round2((reserved[it.commissionId] || 0) + round2(it.grossPart))
      }
    } catch (err) {
      /* 明细集合不可用时退回按佣金剩余展示 */
    }
    let earning = 0
    let pending = 0
    let available = 0
    let reversed = 0
    let level1Earning = 0
    let level2Earning = 0
    let level1Count = 0
    let level2Count = 0
    let pendingCount = 0
    let availableCount = 0
    let nextEligibleAt = 0
    const buyers = new Set()
    for (const doc of rows) {
      if (doc.buyerUid) buyers.add(doc.buyerUid)
      if (doc.status === COMMISSION_STATUS.REVERSED) {
        reversed = round2(reversed + round2(doc.amount))
        continue
      }
      earning = round2(earning + round2(doc.amount))
      /* 老数据没有 level 字段，一律视为一级佣金 */
      if (Number(doc.level) === 2) {
        level2Earning = round2(level2Earning + round2(doc.amount))
        level2Count += 1
      } else {
        level1Earning = round2(level1Earning + round2(doc.amount))
        level1Count += 1
      }
      if (doc.status === COMMISSION_STATUS.PENDING) {
        pending = round2(pending + round2(doc.amount))
        pendingCount += 1
        const t = Number(doc.eligibleAt || doc.releaseAt) || 0
        if (t && (!nextEligibleAt || t < nextEligibleAt)) nextEligibleAt = t
      } else if (doc.status === COMMISSION_STATUS.AVAILABLE) {
        /* 已出款待回退（debtRecorded）的佣金，其未出款毛额在冲正时已从可提现扣掉，台账不再计入 */
        const freeGross = doc.debtRecorded
          ? 0
          : Math.max(0, round2(commissionRemain(doc).grossRemain - round2(reserved[doc.id])))
        available = round2(available + freeGross)
        if (centsOf(freeGross) > 0) availableCount += 1
      }
    }
    return {
      earning,
      pending,
      available,
      reversed,
      level1Earning,
      level2Earning,
      level1Count,
      level2Count,
      pendingCount,
      availableCount,
      nextEligibleAt,
      buyers: buyers.size
    }
  }

  async function summary(uid) {
    const user = await mustUser(uid)
    const settings = await readSettings()
    const ledger = await commissionLedger(uid)
    const withdrawals = await repo.find('promoterWithdrawals', { uid }, { limit: 5000 })
    let withdrawing = 0
    let withdrawn = 0
    let pendingPayout = 0
    let activeWithdraw = null
    const counts = { total: withdrawals.length, pending: 0, approved: 0, paying: 0, paid: 0, rejected: 0, failed: 0, cancelled: 0 }
    for (const w of withdrawals) {
      if (w.status === WITHDRAW_STATUS.PAID) {
        withdrawn = round2(withdrawn + round2(w.amount))
        counts.paid += 1
      }
      if (isOccupyingWithdrawal(w.status)) {
        withdrawing = round2(withdrawing + round2(w.amount))
      }
      if (w.status === WITHDRAW_STATUS.PENDING) counts.pending += 1
      if (w.status === WITHDRAW_STATUS.APPROVED) counts.approved += 1
      if (w.status === WITHDRAW_STATUS.PAYING) {
        counts.paying += 1
        pendingPayout = round2(pendingPayout + round2(w.net))
      }
      if (w.status === WITHDRAW_STATUS.REJECTED) counts.rejected += 1
      if (w.status === WITHDRAW_STATUS.FAILED) counts.failed += 1
      if (w.status === WITHDRAW_STATUS.CANCELLED) counts.cancelled += 1
      if (isActiveWithdrawal(w.status)) {
        if (!activeWithdraw || Number(w.applyAt) > Number(activeWithdraw.applyAt)) activeWithdraw = w
      }
    }
    const rate = clampRate(settings.commissionRate, settings)
    const level2Rate = clampRate(settings.level2Rate, settings)
    const debt = round2(user.promoterDebt)
    /* 绑定人数：一级 / 二级分开统计（用于推广中心与推广管理展示） */
    const bindings = await repo.find('referralBindings', { refUid: uid }, { limit: 5000 })
    const level1Uids = bindings.map((b) => b.uid).filter(Boolean)
    let level2Count = 0
    if (level1Uids.length) {
      const l2 = await repo.find('referralBindings', { refUid: { $in: level1Uids } }, { limit: 5000 })
      level2Count = l2.length
    }
    return {
      active: user.promoterStatus === 'active',
      status: user.promoterStatus || 'none',
      refCode: user.refCode || '',
      refCodeLocked: !!user.refCode,
      shareRef: user.refCode || '',
      rate,
      rateText: rateText(rate),
      level2Rate,
      level2RateText: rateText(level2Rate),
      rateMin: settings.rateMin,
      rateMax: settings.rateMax,
      commissionRate: rate,
      feeRate: Number(settings.feeRate),
      agreementVersion: user.agreementVersion || '',
      agreementAt: Number(user.agreementAt) || 0,
      agreementCurrent: user.agreementVersion === settings.agreementVersion,
      openedAt: Number(user.promoterOpenedAt || user.promoterSince) || 0,
      referred: !!user.referredBy,
      /* 兼容旧字段：推广者不再自选比例 */
      rateEditable: false,
      totals: {
        earning: ledger.earning,
        pending: ledger.pending,
        /* 以用户余额字段为准：待审核提现占用的毛额已不在可提现里，避免展示虚高 */
        available: Math.min(ledger.available, round2(user.promoterAvailable)),
        withdrawing,
        withdrawn,
        reversed: ledger.reversed,
        level1Earning: ledger.level1Earning,
        level2Earning: ledger.level2Earning,
        debt,
        pendingPayout,
        appliedToDebt: round2(user.promoterAppliedToDebt)
      },
      counts: Object.assign({ commissions: ledger.pendingCount + ledger.availableCount, referrals: bindings.length, level1: bindings.length, level2: level2Count, buyers: ledger.buyers }, counts),
      nextEligibleAt: ledger.nextEligibleAt,
      nextEligibleText: ledger.nextEligibleAt ? dateText(ledger.nextEligibleAt) : '',
      activeWithdraw: activeWithdraw
        ? {
          id: activeWithdraw.id,
          amount: round2(activeWithdraw.amount),
          net: round2(activeWithdraw.net),
          status: activeWithdraw.status,
          applyAt: Number(activeWithdraw.applyAt),
          payoutDeadlineAt: Number(activeWithdraw.payoutDeadlineAt) || 0
        }
        : null,
      rules: {
        minWithdraw: settings.minWithdraw,
        maxWithdraw: settings.maxWithdraw,
        dailyMaxWithdraw: settings.dailyMaxWithdraw,
        dailyMaxCount: settings.dailyMaxCount,
        feeRate: Number(settings.feeRate),
        feeText: rateText(settings.feeRate),
        freezeDay: Number(settings.freezeDay),
        payoutMode: 'manual',
        autoApprove: false,
        reviewNote: '提交后需平台人工审核，审核通过后由财务人工分账 / 商家转账',
        taxEnabled: !!settings.taxEnabled,
        debtBlock: round2(settings.debtBlock),
        canWithdraw: user.promoterStatus === 'active' && ledger.available >= settings.minWithdraw,
        blockedByDebt: debt > round2(settings.debtBlock),
        rateText: rateText(rate),
        level2RateText: rateText(level2Rate),
        level2Note: `一级下级首次付款按 ${rateText(rate)} 计佣；普通推广人只有一级收入，仅客服绑定账号另按其下级的首次付款计 ${rateText(level2Rate)} 二级佣金`
      }
    }
  }

  async function listCommissions(uid, query) {
    await mustUser(uid)
    const q = query || {}
    const paging = normalizePaging(q)
    const filter = { uid }
    const status = str(q.status, { field: '状态', max: 12 })
    if (status) filter.status = status
    const total = await repo.count('commissions', filter)
    const rows = await repo.find('commissions', filter, {
      sort: { createdAt: -1 },
      skip: paging.skip,
      limit: paging.limit
    })
    return {
      page: paging.page,
      limit: paging.limit,
      total,
      capped: paging.capped,
      items: rows.map((doc) => ({
        id: doc.id,
        paymentId: doc.paymentId,
        sourcePaymentId: doc.sourcePaymentId || doc.paymentId,
        level: Number(doc.level) === 2 ? 2 : 1,
        levelText: Number(doc.level) === 2 ? '二级佣金' : '一级佣金',
        orderId: doc.orderId || '',
        transactionId: doc.transactionId || '',
        transactionTail: doc.transactionId ? String(doc.transactionId).slice(-6) : '',
        channel: doc.channel || 'wxpay',
        channelText: doc.channel === 'apple' ? 'Apple 内购' : doc.channel === 'xpay' ? '虚拟支付' : '微信支付',
        channelRate: Number(doc.channelRate) || 0,
        channelRateText: rateText(doc.channelRate),
        channelCost: round2(doc.channelCost),
        base: round2(doc.base),
        paidAmount: round2(doc.paidAmount),
        rate: Number(doc.rate) || 0,
        rateText: rateText(doc.rate),
        feeRate: Number(doc.feeRate) || 0,
        amount: round2(doc.amount),
        feeAmount: round2(doc.feeAmount),
        netAmount: round2(doc.netAmount),
        status: doc.status,
        arrivalHold: doc.arrivalHold === true,
        eligibleAt: Number(doc.eligibleAt) || 0,
        eligibleText: doc.arrivalHold ? '待平台确认到账' : dateText(doc.eligibleAt),
        createdAt: Number(doc.createdAt),
        createdText: dateText(doc.createdAt),
        reversedAt: Number(doc.reversedAt) || 0,
        reverseReason: doc.reverseReason || ''
      }))
    }
  }

  async function listWithdrawals(uid, query) {
    await mustUser(uid)
    const q = query || {}
    const paging = normalizePaging(q)
    const filter = { uid }
    const status = str(q.status, { field: '状态', max: 12 })
    if (status) filter.status = status
    const total = await repo.count('promoterWithdrawals', filter)
    const rows = await repo.find('promoterWithdrawals', filter, {
      sort: { applyAt: -1 },
      skip: paging.skip,
      limit: paging.limit
    })
    return {
      page: paging.page,
      limit: paging.limit,
      total,
      capped: paging.capped,
      items: rows.map((doc) => ({
        id: doc.id,
        amount: round2(doc.amount),
        fee: round2(doc.fee),
        tax: round2(doc.tax),
        deductToDebt: round2(doc.deductToDebt),
        net: round2(doc.net),
        status: doc.status,
        method: doc.method || 'manual',
        methodText: doc.method === 'manualSplit' ? '人工分账' : doc.method === 'manualTransfer' ? '商家转账' : doc.method === 'mixed' ? '混合出款' : '人工出款',
        payoutNo: doc.payoutNo || '',
        applyAt: Number(doc.applyAt),
        applyText: dateText(doc.applyAt),
        reviewedAt: Number(doc.reviewedAt) || 0,
        paidAt: Number(doc.paidAt) || 0,
        paidText: dateTimeText(doc.paidAt),
        payoutDeadlineAt: Number(doc.payoutDeadlineAt) || 0,
        failReason: doc.failReason || '',
        reviewNote: doc.reviewNote || '',
        canCancel: doc.status === WITHDRAW_STATUS.PENDING
      }))
    }
  }

  /**
   * 提现申请。
   * - requestId 幂等；
   * - 同一时刻只允许一笔未完结（待审核 / 待打款 / 打款中）；
   * - 每日最多 3 次，单日累计净额上限 20000；
   * - 欠款超过 500 元禁止申请；
   * - 先按毛额占用余额（available ↓ / withdrawing ↑ 同源同额），再写提现单。
   */
  async function withdrawApply(uid, data) {
    const d = data || {}
    const user = await mustUser(uid)
    if (user.promoterStatus !== 'active') throw new AppError(CODES.FORBIDDEN, '请先开通推广')
    if (risky(user)) throw new AppError(CODES.FORBIDDEN, '该账号近期退款次数较多，暂不支持提现')

    const requestId = str(d.requestId, { field: '请求号', max: 80 }) || randomId('WQ')
    const existed = await findOne('promoterWithdrawals', { uid, requestId })
    if (existed) return { idempotent: true, withdrawal: withdrawalView(existed) }

    const settings = await readSettings()
    const amount = round2(d.amount)
    if (centsOf(amount) <= 0) throw new AppError(CODES.VALIDATION, '请填写提现金额')
    if (amount < settings.minWithdraw) throw new AppError(CODES.VALIDATION, `单笔提现不能低于 ¥${settings.minWithdraw}`)
    if (amount > settings.maxWithdraw) throw new AppError(CODES.VALIDATION, `单笔提现不能超过 ¥${settings.maxWithdraw}`)

    const current = at()
    const active = await repo.find('promoterWithdrawals', { uid }, { limit: 5000 })
    for (const w of active) {
      /* 打款失败仍占用余额且需财务处理（重新打款 / 退回余额），同样不允许再申请 */
      if (isOccupyingWithdrawal(w.status)) {
        throw new AppError(CODES.CONFLICT, `已有${w.status}的提现单，请等待处理完成后再申请`)
      }
    }
    const range = dayRange(current)
    const today = active.filter((w) => Number(w.applyAt) >= range.start && Number(w.applyAt) < range.end)
    if (today.length >= settings.dailyMaxCount) {
      throw new AppError(CODES.VALIDATION, `每人每日最多申请 ${settings.dailyMaxCount} 次，请明天再试`)
    }
    let todayNet = 0
    for (const w of today) {
      if (w.status === WITHDRAW_STATUS.REJECTED || w.status === WITHDRAW_STATUS.CANCELLED) continue
      todayNet = round2(todayNet + round2(w.net))
    }

    const ledger = await commissionLedger(uid)
    if (ledger.available < amount) {
      throw new AppError(CODES.VALIDATION, `可提现余额不足，当前 ¥${ledger.available.toFixed(2)}`)
    }
    const debt = round2(user.promoterDebt)
    if (debt > round2(settings.debtBlock)) {
      throw new AppError(CODES.FORBIDDEN, `欠款 ¥${debt.toFixed(2)} 超过 ¥${round2(settings.debtBlock)}，请先联系客服处理`)
    }

    const fee = round2(amount * (Number(settings.feeRate) || 0))
    const taxableBase = user.promoterTaxMonth === monthKey(current) ? round2(user.promoterTaxBase) : 0
    const taxablePaid = user.promoterTaxMonth === monthKey(current) ? round2(user.promoterTaxPaid) : 0
    const tax = settings.taxEnabled ? taxOf(amount, taxableBase, taxablePaid) : 0
    const afterTax = round2(amount - fee - tax)
    const deductToDebt = Math.max(0, Math.min(debt, afterTax))
    const net = round2(afterTax - deductToDebt)
    if (centsOf(net) <= 0) throw new AppError(CODES.VALIDATION, '扣除手续费 / 税费 / 欠款后无可提现金额')
    if (round2(todayNet + net) > settings.dailyMaxWithdraw) {
      throw new AppError(CODES.VALIDATION, `单日累计出款净额不能超过 ¥${settings.dailyMaxWithdraw}（今日已申请 ¥${todayNet.toFixed(2)}）`)
    }

    /* 先占用余额：available ↓ / withdrawing ↑ 同源同额 */
    let reserved = false
    await applyUserPatch(uid, (u) => {
      const curAvailable = round2(u.promoterAvailable)
      const baseAvailable = Math.min(curAvailable, ledger.available)
      if (baseAvailable < amount) throw new AppError(CODES.VALIDATION, `可提现余额不足，当前 ¥${round2(baseAvailable).toFixed(2)}`)
      reserved = true
      const next = {
        promoterAvailable: round2(baseAvailable - amount),
        promoterWithdrawing: round2((u.promoterWithdrawing || 0) + amount)
      }
      if (deductToDebt > 0) {
        next.promoterDebt = Math.max(0, round2(debt - deductToDebt))
        next.promoterAppliedToDebt = round2((u.promoterAppliedToDebt || 0) + deductToDebt)
      }
      if (tax > 0) {
        next.promoterTaxMonth = monthKey(current)
        next.promoterTaxBase = round2(taxableBase + amount)
        next.promoterTaxPaid = round2(taxablePaid + tax)
      }
      return next
    })
    if (!reserved) throw new AppError(CODES.CONFLICT, '余额占用失败，请稍后重试')

    const doc = {
      id: randomId('W'),
      uid,
      requestId,
      /* 活动单唯一键：同一 uid 只能一笔未完结；终态改写唯一退休键、不再占用 */
      activeKey: uid,
      amount,
      fee,
      tax,
      deductToDebt,
      net,
      status: WITHDRAW_STATUS.PENDING,
      method: '',
      payoutMode: 'manual',
      applyAt: current,
      appliedAt: current,
      reviewedAt: 0,
      reviewedBy: '',
      reviewNote: '',
      payoutDeadlineAt: 0,
      claimedBy: '',
      claimedAt: 0,
      payoutNo: '',
      payoutRequestId: '',
      payoutAmount: 0,
      paidAt: 0,
      voucherUrl: '',
      failReason: '',
      uncoveredAmount: 0,
      cancelledAt: 0,
      cancelReason: '',
      createdAt: current,
      updatedAt: current
    }
    try {
      await repo.insert('promoterWithdrawals', doc)
    } catch (err) {
      /* 写单失败必须把刚占用的余额原路退回 */
      await applyUserPatch(uid, (u) => ({
        promoterAvailable: round2((u.promoterAvailable || 0) + amount),
        promoterWithdrawing: Math.max(0, round2((u.promoterWithdrawing || 0) - amount)),
        promoterDebt: deductToDebt > 0 ? round2((u.promoterDebt || 0) + deductToDebt) : round2(u.promoterDebt || 0),
        promoterAppliedToDebt: deductToDebt > 0
          ? Math.max(0, round2((u.promoterAppliedToDebt || 0) - deductToDebt))
          : round2(u.promoterAppliedToDebt || 0),
        promoterTaxBase: tax > 0 ? Math.max(0, round2(taxableBase)) : round2(u.promoterTaxBase || 0),
        promoterTaxPaid: tax > 0 ? Math.max(0, round2(taxablePaid)) : round2(u.promoterTaxPaid || 0)
      }))
      if (err && err.code === CODES.CONFLICT) {
        const same = await findOne('promoterWithdrawals', { uid, requestId })
        if (same) return { idempotent: true, withdrawal: withdrawalView(same) }
        throw new AppError(CODES.CONFLICT, '已有未完结的提现单，请等待处理完成后再申请')
      }
      throw err
    }

    await appendAudit(repo, {
      actorType: 'user',
      actorId: uid,
      action: 'promote.withdraw.apply',
      target: doc.id,
      reason: `gross=${amount} fee=${fee} tax=${tax} deductToDebt=${deductToDebt} net=${net}`,
      at: current
    })
    await notifyUser(
      uid,
      '提现申请已提交',
      `¥${amount.toFixed(2)} 已提交人工审核（手续费 ¥${fee.toFixed(2)}，抵扣欠款 ¥${deductToDebt.toFixed(2)}，预计到账 ¥${net.toFixed(2)}）。`,
      'withdraw',
      doc.id
    )
    return { idempotent: false, withdrawal: withdrawalView(doc) }
  }

  function withdrawalView(doc) {
    if (!doc) return null
    return {
      id: doc.id,
      amount: round2(doc.amount),
      fee: round2(doc.fee),
      tax: round2(doc.tax),
      deductToDebt: round2(doc.deductToDebt),
      net: round2(doc.net),
      status: doc.status,
      method: doc.method || '',
      methodText: doc.method === 'manualSplit' ? '人工分账' : doc.method === 'manualTransfer' ? '商家转账' : doc.method === 'mixed' ? '混合出款' : '待财务选择',
      applyAt: Number(doc.applyAt),
      applyText: dateTimeText(doc.applyAt),
      reviewedAt: Number(doc.reviewedAt) || 0,
      payoutDeadlineAt: Number(doc.payoutDeadlineAt) || 0,
      payoutNo: doc.payoutNo || '',
      paidAt: Number(doc.paidAt) || 0,
      paidText: dateTimeText(doc.paidAt),
      failReason: doc.failReason || '',
      reviewNote: doc.reviewNote || '',
      canCancel: doc.status === WITHDRAW_STATUS.PENDING
    }
  }

  /**
   * 释放提现占用：毛额回 available，withdrawing 同额回退，欠款抵扣反向恢复。
   * opts.lapsedGross：本单内已被退款冲正的佣金毛额，已随冲正一并消失，
   * 释放时不能再回到 available（否则会凭空多出一笔可提现余额）。
   */
  async function releaseWithdrawal(uid, doc, opts) {
    const lapsedGross = Math.max(0, round2(opts && opts.lapsedGross))
    const releaseGross = Math.max(0, round2(round2(doc.amount) - lapsedGross))
    await applyUserPatch(uid, (u) => {
      const next = {
        promoterAvailable: round2((u.promoterAvailable || 0) + releaseGross),
        promoterWithdrawing: Math.max(0, round2((u.promoterWithdrawing || 0) - round2(doc.amount)))
      }
      if (round2(doc.deductToDebt) > 0) {
        next.promoterDebt = round2((u.promoterDebt || 0) + round2(doc.deductToDebt))
        next.promoterAppliedToDebt = Math.max(0, round2((u.promoterAppliedToDebt || 0) - round2(doc.deductToDebt)))
      }
      if (round2(doc.tax) > 0) {
        next.promoterTaxBase = Math.max(0, round2((u.promoterTaxBase || 0) - round2(doc.amount)))
        next.promoterTaxPaid = Math.max(0, round2((u.promoterTaxPaid || 0) - round2(doc.tax)))
      }
      return next
    })
  }

  async function withdrawCancel(uid, data) {
    const id = str(data && data.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    await mustUser(uid)
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc || doc.uid !== uid) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    const current = at()
    const res = await repo.updateWhere('promoterWithdrawals', {
      id,
      uid,
      status: WITHDRAW_STATUS.PENDING
    }, {
      status: WITHDRAW_STATUS.CANCELLED,
      activeKey: retiredKeyOf(id),
      cancelledAt: current,
      cancelReason: '用户撤销',
      updatedAt: current
    })
    if (res.count === 0) throw new AppError(CODES.CONFLICT, '仅待审核的提现单可以撤销')
    await releaseWithdrawal(uid, doc)
    await appendAudit(repo, {
      actorType: 'user',
      actorId: uid,
      action: 'promote.withdraw.cancel',
      target: id,
      reason: `用户撤销，释放毛额 ${doc.amount}`,
      at: current
    })
    return { id, status: WITHDRAW_STATUS.CANCELLED }
  }

  /**
   * 生成人工出款明细。
   * 按佣金 createdAt FIFO 选未核销佣金直到覆盖毛额；按毛额比例分配净额，
   * 最大余数法补齐尾差，Σ明细 = net；每笔 ≥0.01 且 ≤ 该佣金可用净额。
   * 相同 commissionId 只能存在一条 todo/doing 明细。
   */
  async function createPayoutPlan(doc) {
    const existed = await repo.find('promotePayoutItems', { withdrawalId: doc.id }, { limit: 2000 })
    const living = existed.filter((it) => it.status === PAYOUT_ITEM_STATUS.TODO || it.status === PAYOUT_ITEM_STATUS.DOING)
    if (living.length) return { items: living, uncoveredAmount: round2(doc.uncoveredAmount), reused: true }

    const occupied = await repo.find('promotePayoutItems', {
      uid: doc.uid,
      status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING] }
    }, { limit: 5000 })
    const occupiedSet = new Set(occupied.map((it) => it.commissionId))

    const rows = await repo.find('commissions', { uid: doc.uid, status: COMMISSION_STATUS.AVAILABLE }, {
      sort: { createdAt: 1 },
      limit: 5000
    })
    const selected = []
    let covered = 0
    for (const c of rows) {
      if (occupiedSet.has(c.id)) continue
      const remain = commissionRemain(c)
      if (centsOf(remain.grossRemain) <= 0) continue
      /* 净额已为 0 的佣金不能再出款（欠款抵扣 / 手续费尾差），跳过避免明细超上限 */
      if (centsOf(remain.netRemain) <= 0) continue
      if (centsOf(covered) >= centsOf(doc.amount)) break
      const need = round2(doc.amount - covered)
      const part = Math.min(remain.grossRemain, need)
      if (centsOf(part) <= 0) continue
      selected.push({ commission: c, grossPart: part, grossC: centsOf(part), capC: centsOf(remain.netRemain) })
      covered = round2(covered + part)
    }

    const uncoveredGross = Math.max(0, round2(doc.amount - covered))
    if (!selected.length) {
      return { items: [], uncoveredAmount: round2(doc.net), uncoveredGross }
    }

    const alloc = allocateNetCents(selected, doc.net, selected.map((s) => s.capC))
    const settings = await readSettings()
    const user = await repo.get('users', doc.uid)
    const receiverName = (user && (user.realNameMasked || user.nickName || user.nickname)) || ''
    const items = []
    let seq = 0
    for (let i = 0; i < selected.length; i += 1) {
      const cents = alloc.amounts[i] || 0
      if (cents <= 0) continue
      const c = selected[i].commission
      const type = canSplit(c, settings) ? 'manualSplit' : 'manualTransfer'
      seq += 1
      const item = {
        id: randomId('PI'),
        withdrawalId: doc.id,
        uid: doc.uid,
        seq,
        commissionId: c.id,
        /* 有效占用键：todo / doing / failed 时等于 commissionId，终态置 null 释放唯一约束 */
        activeCommissionKey: c.id,
        paymentId: c.paymentId,
        transactionId: c.transactionId || '',
        receiverOpenid: doc.uid,
        receiverName,
        /* 路径 A：人工分账；路径 B：商家转账 */
        path: type === 'manualSplit' ? 'A' : 'B',
        type,
        grossPart: selected[i].grossPart,
        amount: fromCents(cents),
        status: PAYOUT_ITEM_STATUS.TODO,
        claimedBy: '',
        proofNo: '',
        paidAmount: 0,
        paidAt: 0,
        proofUrl: '',
        failReason: '',
        payoutNo: '',
        requestId: doc.requestId || '',
        createdAt: at(),
        updatedAt: at()
      }
      try {
        await repo.insert('promotePayoutItems', item)
        items.push(item)
      } catch (err) {
        if (!err || err.code !== CODES.CONFLICT) throw err
        /* 并发下该佣金已被其他待打款单占用，跳过 */
      }
    }

    const allocated = round2(items.reduce((s, it) => round2(s + round2(it.amount)), 0))
    const uncovered = fromCents(Math.max(0, centsOf(doc.net) - centsOf(allocated)))
    const types = new Set(items.map((it) => it.type))
    const method = types.size === 0 ? '' : types.size > 1 ? 'mixed' : items[0].type
    await repo.updateWhere('promoterWithdrawals', { id: doc.id }, {
      method,
      uncoveredAmount: uncovered,
      updatedAt: at()
    })
    return { items, uncoveredAmount: uncovered, uncoveredGross }
  }

  /** 审核通过：只把提现单置「待打款」并生成明细，绝不调用微信接口 */
  async function withdrawApprove(data, actor) {
    const d = data || {}
    /* 批量审核（文档 3.7 / 7.3）：单次最多 200 笔，逐笔独立事务，失败项不影响已通过项 */
    if (!d.id && Array.isArray(d.ids) && d.ids.length) {
      const ids = d.ids.map((one) => String(one || '').trim()).filter(Boolean)
      if (!ids.length) throw new AppError(CODES.VALIDATION, '请选择要审核的提现单')
      if (ids.length > 200) throw new AppError(CODES.VALIDATION, '单次批量审核不能超过 200 笔')
      let approved = 0
      let itemCount = 0
      const failed = []
      for (const oneId of ids) {
        try {
          const r = await withdrawApprove({ id: oneId, note: d.note }, actor)
          approved += 1
          itemCount += (r.items || []).length
        } catch (err) {
          failed.push({ id: oneId, message: (err && err.message) || '审核失败' })
        }
      }
      if (!approved) {
        throw new AppError(CODES.CONFLICT, failed[0] ? failed[0].message : '批量审核失败')
      }
      return {
        ids,
        status: WITHDRAW_STATUS.APPROVED,
        approved,
        items: itemCount,
        failed,
        idempotent: false
      }
    }
    const id = str(d.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    if (doc.status === WITHDRAW_STATUS.APPROVED || doc.status === WITHDRAW_STATUS.PAYING) {
      const plan = await createPayoutPlan(doc)
      return { id, status: doc.status, items: plan.items, uncoveredAmount: plan.uncoveredAmount, idempotent: true }
    }
    if (doc.status !== WITHDRAW_STATUS.PENDING) throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，不能审核`)
    const settings = await readSettings()
    const current = at()
    const reviewer = str(actor, { field: '审核人', max: 80 }) || 'system'
    const deadline = current + Number(settings.payoutTimeoutHours) * HOUR_MS
    const res = await repo.updateWhere('promoterWithdrawals', {
      id,
      status: WITHDRAW_STATUS.PENDING
    }, {
      status: WITHDRAW_STATUS.APPROVED,
      reviewedAt: current,
      reviewedBy: reviewer,
      reviewNote: str(d.note, { field: '审核备注', max: 200 }),
      payoutDeadlineAt: deadline,
      updatedAt: current
    })
    if (res.count === 0) {
      const latest = await repo.get('promoterWithdrawals', id)
      if (latest && (latest.status === WITHDRAW_STATUS.APPROVED || latest.status === WITHDRAW_STATUS.PAYING)) {
        const plan = await createPayoutPlan(latest)
        return { id, status: latest.status, items: plan.items, uncoveredAmount: plan.uncoveredAmount, idempotent: true }
      }
      throw new AppError(CODES.CONFLICT, '提现单状态已变更，请刷新后重试')
    }
    const next = Object.assign({}, doc, {
      status: WITHDRAW_STATUS.APPROVED,
      reviewedAt: current,
      reviewedBy: reviewer,
      payoutDeadlineAt: deadline
    })
    const plan = await createPayoutPlan(next)
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: reviewer,
      action: 'promote.withdraw.approve',
      target: id,
      reason: `审核通过 · net=${doc.net} · 明细 ${plan.items.length} 笔 · 未覆盖 ${plan.uncoveredAmount}`,
      at: current
    })
    await notifyUser(
      doc.uid,
      '提现审核通过',
      `¥${round2(doc.net).toFixed(2)} 已进入人工打款队列，财务将在 ${settings.payoutTimeoutHours} 小时内完成出款。`,
      'withdraw',
      id
    )
    return {
      id,
      status: WITHDRAW_STATUS.APPROVED,
      items: plan.items,
      uncoveredAmount: plan.uncoveredAmount,
      payoutDeadlineAt: deadline,
      idempotent: false
    }
  }

  /** 驳回：毛额释回 available，必须填写原因 */
  async function withdrawReject(data, actor) {
    const d = data || {}
    const id = str(d.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    const reason = str(d.reason, { field: '驳回原因', max: 200 })
    if (!reason) throw new AppError(CODES.VALIDATION, '请填写驳回原因')
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    if (doc.status === WITHDRAW_STATUS.REJECTED) return { id, status: doc.status, idempotent: true }
    if (doc.status !== WITHDRAW_STATUS.PENDING) throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，不能驳回`)
    const current = at()
    const reviewer = str(actor, { field: '审核人', max: 80 }) || 'system'
    const res = await repo.updateWhere('promoterWithdrawals', {
      id,
      status: WITHDRAW_STATUS.PENDING
    }, {
      status: WITHDRAW_STATUS.REJECTED,
      activeKey: retiredKeyOf(id),
      reviewedAt: current,
      reviewedBy: reviewer,
      reviewNote: reason,
      updatedAt: current
    })
    if (res.count === 0) throw new AppError(CODES.CONFLICT, '提现单状态已变更，请刷新后重试')
    await releaseWithdrawal(doc.uid, doc)
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: reviewer,
      action: 'promote.withdraw.reject',
      target: id,
      reason,
      at: current
    })
    await notifyUser(doc.uid, '提现申请被驳回', `原因：${reason}。提现金额已退回可提现余额。`, 'withdraw', id)
    return { id, status: WITHDRAW_STATUS.REJECTED }
  }

  /** 财务领取：待打款 → 打款中（条件更新，影响行数为 0 即失败） */
  async function payoutClaim(data, actor) {
    const d = data || {}
    const id = str(d.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    const operator = str(actor, { field: '操作人', max: 80 }) || 'finance'
    if (doc.status === WITHDRAW_STATUS.PAYING) {
      if (doc.claimedBy && doc.claimedBy !== operator) {
        throw new AppError(CODES.CONFLICT, `该笔已被 ${doc.claimedBy} 领取`)
      }
      return { id, status: doc.status, claimedBy: doc.claimedBy, idempotent: true }
    }
    if (doc.status !== WITHDRAW_STATUS.APPROVED && doc.status !== WITHDRAW_STATUS.FAILED) {
      throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，不能领取`)
    }
    const current = at()
    const res = await repo.updateWhere('promoterWithdrawals', {
      id,
      status: doc.status
    }, {
      status: WITHDRAW_STATUS.PAYING,
      claimedBy: operator,
      claimedAt: current,
      updatedAt: current
    })
    if (res.count === 0) throw new AppError(CODES.CONFLICT, '领取失败，该笔已被他人领取')
    await repo.updateWhere('promotePayoutItems', {
      withdrawalId: id,
      status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.FAILED] }
    }, {
      status: PAYOUT_ITEM_STATUS.DOING,
      claimedBy: operator,
      updatedAt: current
    })
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: operator,
      action: 'promote.payout.claim',
      target: id,
      reason: `领取出款 · net=${doc.net}`,
      at: current
    })
    return { id, status: WITHDRAW_STATUS.PAYING, claimedBy: operator }
  }

  /** 导出人工出款 CSV：提现单号、收款人、openid、路径、订单号、交易单号、金额 */
  async function payoutExport(data) {
    const q = data || {}
    let rows = []
    if (q.id) {
      const one = await repo.get('promoterWithdrawals', str(q.id, { field: '提现单号', max: 80 }))
      if (!one) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
      rows = [one]
    } else if (Array.isArray(q.ids) && q.ids.length) {
      for (const id of q.ids.slice(0, 200)) {
        const one = await repo.get('promoterWithdrawals', str(id, { field: '提现单号', max: 80 }))
        if (one) rows.push(one)
      }
    } else {
      rows = await repo.find('promoterWithdrawals', {
        status: { $in: [WITHDRAW_STATUS.APPROVED, WITHDRAW_STATUS.PAYING] }
      }, { sort: { reviewedAt: 1 }, limit: 500 })
    }

    const lines = ['提现单号,收款人,openid,路径,订单号,交易单号,金额']
    let total = 0
    let count = 0
    for (const w of rows) {
      if (!w) continue
      const items = await repo.find('promotePayoutItems', { withdrawalId: w.id }, { sort: { seq: 1 }, limit: 500 })
      if (!items.length) {
        const path = w.method === 'manualTransfer' ? 'B' : w.method === 'manualSplit' ? 'A' : ''
        lines.push([
          csvCell(w.id),
          csvCell(''),
          csvCell(w.uid),
          csvCell(path),
          csvCell(''),
          csvCell(''),
          csvCell(round2(w.net).toFixed(2))
        ].join(','))
        total = round2(total + round2(w.net))
        count += 1
        continue
      }
      for (const it of items) {
        if (it.status === PAYOUT_ITEM_STATUS.CANCELLED) continue
        const receiver = it.receiverName || ''
        lines.push([
          csvCell(w.id),
          csvCell(receiver),
          csvCell(it.receiverOpenid || w.uid),
          csvCell(it.path || (it.type === 'manualSplit' ? 'A' : 'B')),
          csvCell(it.paymentId),
          csvCell(it.transactionId || ''),
          csvCell(round2(it.amount).toFixed(2))
        ].join(','))
        total = round2(total + round2(it.amount))
        count += 1
      }
    }
    return {
      filename: `payout-${dateText(at())}.csv`,
      content: lines.join('\n'),
      rows: count,
      total
    }
  }

  /**
   * 回填出款结果。
   * 五项校验通过后才核销佣金；失败分支保持余额占用不释放。
   */
  async function payoutMark(data, actor) {
    const d = data || {}
    const id = str(d.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    const current = at()
    const operator = str(actor, { field: '执行人', max: 80 }) || str(d.claimedBy, { field: '执行人', max: 80 }) || 'finance'
    const payoutRequestId = str(d.payoutRequestId, { field: '回填请求号', max: 80 }) || doc.payoutRequestId || randomId('PM')

    /* 幂等：已到账直接返回首次结果 */
    if (doc.status === WITHDRAW_STATUS.PAID) {
      return {
        id,
        status: doc.status,
        payoutNo: doc.payoutNo,
        paidAt: doc.paidAt,
        payoutAmount: round2(doc.payoutAmount),
        idempotent: true
      }
    }

    if (d.result === 'failed' || d.failed === true) {
      if (doc.status !== WITHDRAW_STATUS.PAYING) {
        throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，不能登记打款失败`)
      }
      const reason = str(d.failReason || d.reason, { field: '失败原因', max: 200 })
      if (!reason) throw new AppError(CODES.VALIDATION, '请填写打款失败原因')
      const res = await repo.updateWhere('promoterWithdrawals', {
        id,
        status: WITHDRAW_STATUS.PAYING
      }, {
        status: WITHDRAW_STATUS.FAILED,
        failReason: reason,
        payoutRequestId,
        updatedAt: current
      })
      if (res.count === 0) throw new AppError(CODES.CONFLICT, '提现单状态已变更，请刷新后重试')
      await repo.updateWhere('promotePayoutItems', {
        withdrawalId: id,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING] }
      }, {
        status: PAYOUT_ITEM_STATUS.FAILED,
        failReason: reason,
        updatedAt: current
      })
      await appendAudit(repo, {
        actorType: 'staff',
        actorId: operator,
        action: 'promote.payout.fail',
        target: id,
        reason,
        at: current
      })
      await notifyUser(
        doc.uid,
        '提现打款失败',
        `失败原因：${reason}。金额仍为你保留，财务会重新处理，无需重复申请。`,
        'withdraw',
        id
      )
      return { id, status: WITHDRAW_STATUS.FAILED, failReason: reason }
    }

    if (doc.status !== WITHDRAW_STATUS.PAYING) {
      throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，请先领取再回填`)
    }
    if (doc.payoutRequestId && doc.payoutRequestId !== payoutRequestId && doc.payoutNo) {
      throw new AppError(CODES.CONFLICT, '该提现单已有回填记录，请勿重复回填')
    }

    const payoutNo = str(d.payoutNo || d.proofNo, { field: '出款单据号', max: 80 })
    if (!payoutNo) throw new AppError(CODES.VALIDATION, '请填写出款单据号')
    const settings = await readSettings()
    const executor = doc.claimedBy || operator
    const reviewer = doc.reviewedBy || ''

    /* 校验 4：payoutRequestId 幂等（同号重复回填直接返回首次结果） */
    if (doc.payoutRequestId && doc.payoutRequestId === payoutRequestId && doc.payoutNo) {
      return { id, status: doc.status, payoutNo: doc.payoutNo, idempotent: true }
    }
    /* 校验 3：单据号全局唯一 */
    const dup = await repo.find('promoterWithdrawals', { payoutNo }, { limit: 5 })
    for (const other of dup) {
      if (other.id !== id) throw new AppError(CODES.CONFLICT, `出款单据号 ${payoutNo} 已被其他提现单使用`)
    }
    /* 校验 5：金额 ≥ 阈值时，复核人 ≠ 审核人 ≠ 执行人 */
    if (round2(doc.net) >= round2(settings.manualDualCheckThreshold)) {
      const checker = str(d.checkedBy || d.reviewer, { field: '复核人', max: 80 })
      if (!checker) throw new AppError(CODES.VALIDATION, `出款金额 ≥ ¥${round2(settings.manualDualCheckThreshold)}，必须填写复核人`)
      if (checker === reviewer) throw new AppError(CODES.VALIDATION, '复核人不能与审核人相同')
      if (checker === executor || checker === operator) throw new AppError(CODES.VALIDATION, '复核人不能与执行人相同')
    }
    if (reviewer && (executor === reviewer || operator === reviewer)) {
      throw new AppError(CODES.FORBIDDEN, '审核人不得回填 / 执行同一笔出款，请由其他财务操作')
    }

    const items = await repo.find('promotePayoutItems', { withdrawalId: id }, { sort: { seq: 1 }, limit: 500 })
    const payable = items.filter((it) => it.status !== PAYOUT_ITEM_STATUS.CANCELLED)
    if (!payable.length) throw new AppError(CODES.VALIDATION, '该提现单没有可核销的出款明细，请重新生成')
    /* 分类：可核销明细 / 已冲正或缺失的明细（按文档 3.9，跳过并记 uncovered，不阻塞终态） */
    const usable = []
    const dead = []
    for (const it of payable) {
      const c = await repo.get('commissions', it.commissionId)
      if (!c) {
        dead.push({ item: it, reason: '佣金记录不存在' })
        continue
      }
      if (c.status === COMMISSION_STATUS.REVERSED) {
        dead.push({ item: it, reason: '佣金已冲正' })
        continue
      }
      const remain = commissionRemain(c)
      if (centsOf(it.amount) > centsOf(remain.netRemain)) {
        throw new AppError(CODES.VALIDATION, `明细金额 ¥${round2(it.amount).toFixed(2)} 超过佣金可用净额 ¥${remain.netRemain.toFixed(2)}`)
      }
      usable.push({ item: it, commission: c })
    }
    if (!usable.length) throw new AppError(CODES.CONFLICT, '所有明细对应佣金均已冲正，请退回余额后重新申请')
    const deadTotal = round2(dead.reduce((s, x) => round2(s + round2(x.item.amount)), 0))
    const expectedPayout = round2(usable.reduce((s, x) => round2(s + round2(x.item.amount)), 0))
    /* 校验 1（金额闭合）：正常场景明细合计必须等于净额；
       存在已冲正明细或计划生成时已记 uncovered 时，以剩余可核销合计为准 */
    if (!dead.length && !centsOf(doc.uncoveredAmount) && !moneyEq(expectedPayout, doc.net)) {
      throw new AppError(CODES.VALIDATION, `明细合计 ¥${expectedPayout.toFixed(2)} 与提现净额 ¥${round2(doc.net).toFixed(2)} 不一致，请重新生成`)
    }
    const payoutAmount = round2(
      d.payoutAmount !== undefined ? d.payoutAmount
        : (d.amount !== undefined ? d.amount : expectedPayout)
    )
    if (!moneyEq(payoutAmount, expectedPayout)) {
      throw new AppError(CODES.VALIDATION, `回填金额 ¥${payoutAmount.toFixed(2)} 与可核销明细合计 ¥${expectedPayout.toFixed(2)} 不一致`)
    }
    /* 凭证截图必填：商户平台操作结果截图，便于事后对账与争议处理 */
    const voucherUrl = str(d.voucherUrl || d.proofUrl || d.voucher, { field: '凭证', max: 500 })
    if (!voucherUrl) throw new AppError(CODES.VALIDATION, '请上传出款凭证截图')
    /* 出款时间以商户平台显示的成功时间为准，未传则取当前时间 */
    const paidAt = Number(d.payoutAt || d.paidAt) || current

    /* 条件更新：仅打款中可回填已到账 */
    const cashRes = await repo.updateWhere('promoterWithdrawals', {
      id,
      status: WITHDRAW_STATUS.PAYING
    }, {
      status: WITHDRAW_STATUS.PAID,
      /* 终态改写成唯一退休键：不再占用在途位，也不会与其他终态单撞唯一索引 */
      activeKey: retiredKeyOf(id),
      payoutNo,
      proofNo: payoutNo,
      payoutRequestId,
      payoutAmount,
      method: str(d.path || d.method, { field: '出款路径', max: 20 }) || doc.method || '',
      paidAt,
      checkedBy: str(d.checkedBy || d.reviewer, { field: '复核人', max: 80 }),
      voucherUrl,
      failReason: '',
      updatedAt: current
    })
    if (cashRes.count === 0) {
      const latest = await repo.get('promoterWithdrawals', id)
      if (latest && latest.status === WITHDRAW_STATUS.PAID) {
        return { id, status: latest.status, payoutNo: latest.payoutNo, paidAt: latest.paidAt, idempotent: true }
      }
      throw new AppError(CODES.CONFLICT, '提现单状态已变更，请刷新后重试')
    }

    /* 已冲正 / 缺失佣金对应的明细先置取消，金额计入 uncovered，不阻塞本单终态 */
    for (const deadItem of dead) {
      await repo.updateWhere('promotePayoutItems', {
        id: deadItem.item.id,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING] }
      }, {
        status: PAYOUT_ITEM_STATUS.CANCELLED,
        activeCommissionKey: retiredKeyOf(deadItem.item.id),
        failReason: deadItem.reason,
        updatedAt: current
      })
    }
    let uncovered = deadTotal
    /* 真实出款的毛额：只有核销成功的明细才算「累计已提现」 */
    let paidGross = 0
    for (const { item: it, commission: c } of usable) {
      await repo.updateWhere('promotePayoutItems', {
        id: it.id,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING] }
      }, {
        status: PAYOUT_ITEM_STATUS.DONE,
        activeCommissionKey: retiredKeyOf(it.id),
        claimedBy: executor,
        proofNo: payoutNo,
        paidAmount: round2(it.amount),
        paidAt,
        proofUrl: voucherUrl,
        payoutNo,
        updatedAt: current
      })

      const newWithdrawn = round2(Math.min(round2(c.amount), round2(c.withdrawnAmount) + round2(it.grossPart)))
      const newPaid = round2(round2(c.payoutAmount) + round2(it.amount))
      const nextStatus = centsOf(newWithdrawn) >= centsOf(c.amount) ? COMMISSION_STATUS.WITHDRAWN : COMMISSION_STATUS.AVAILABLE
      const cRes = await repo.updateWhere('commissions', {
        id: c.id,
        status: c.status
      }, {
        withdrawnAmount: newWithdrawn,
        payoutAmount: newPaid,
        status: nextStatus,
        paidAt: current,
        updatedAt: current
      })
      if (cRes.count === 0) {
        /* 佣金在回填期间被冲正：明细回退为取消并计入 uncovered，避免出现已核销但佣金未记账 */
        uncovered = round2(uncovered + round2(it.amount))
        await repo.updateWhere('promotePayoutItems', {
          id: it.id,
          status: PAYOUT_ITEM_STATUS.DONE
        }, {
          status: PAYOUT_ITEM_STATUS.CANCELLED,
          activeCommissionKey: retiredKeyOf(it.id),
          failReason: '佣金状态已变更',
          updatedAt: current
        })
      } else {
        paidGross = round2(paidGross + round2(it.grossPart))
      }
    }

    await applyUserPatch(doc.uid, (u) => ({
      promoterWithdrawing: Math.max(0, round2((u.promoterWithdrawing || 0) - round2(doc.amount))),
      /* 「累计已提现」只统计真实出款的毛额：因佣金冲正而失效的明细（uncovered）从未出款，
         计入会虚增累计已提现，口径与 reconcile 保持一致 */
      promoterWithdrawn: round2((u.promoterWithdrawn || 0) + paidGross)
    }))

    if (uncovered > 0) {
      const latest = await repo.get('promoterWithdrawals', id)
      await repo.updateWhere('promoterWithdrawals', { id }, {
        uncoveredAmount: round2((latest ? latest.uncoveredAmount : 0) + uncovered),
        updatedAt: current
      })
      await appendAudit(repo, {
        actorType: 'staff',
        actorId: operator,
        action: 'promote.payout.uncovered',
        target: id,
        reason: `有 ¥${uncovered.toFixed(2)} 明细未能核销（佣金已冲正或被占用），请对账处理`,
        at: current
      })
    }

    await appendAudit(repo, {
      actorType: 'staff',
      actorId: operator,
      action: 'promote.payout.mark',
      target: id,
      reason: `已到账 · payoutNo=${payoutNo} · net=${payoutAmount} · items=${usable.length} · uncovered=${uncovered}`,
      at: current
    })
    await notifyUser(
      doc.uid,
      '提现已到账',
      `¥${payoutAmount.toFixed(2)} 已出款，单据号 ${payoutNo}${uncovered > 0 ? `；其中 ¥${uncovered.toFixed(2)} 因佣金冲正未出款` : ''}。如未收到请 24 小时内联系客服。`,
      'withdraw',
      id
    )
    return {
      id,
      status: WITHDRAW_STATUS.PAID,
      payoutNo,
      net: round2(doc.net),
      payoutAmount,
      items: usable.length,
      uncoveredAmount: uncovered,
      idempotent: false
    }
  }

  /** 退回余额：明细 cancelled、提现「已撤销」、佣金重新可提现 */
  async function payoutCancel(data, actor) {
    const d = data || {}
    const id = str(d.id, { field: '提现单号', max: 80 })
    if (!id) throw new AppError(CODES.VALIDATION, '缺少提现单号')
    const doc = await repo.get('promoterWithdrawals', id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '提现单不存在')
    if (doc.status === WITHDRAW_STATUS.CANCELLED) return { id, status: doc.status, idempotent: true }
    if ([WITHDRAW_STATUS.PENDING, WITHDRAW_STATUS.PAID, WITHDRAW_STATUS.REJECTED].indexOf(doc.status) > -1) {
      throw new AppError(CODES.CONFLICT, `提现单当前状态为${doc.status}，不能退回`)
    }
    const current = at()
    const operator = str(actor, { field: '操作人', max: 80 }) || 'finance'
    const reason = str(d.reason, { field: '退回原因', max: 200 }) || '人工退回'
    /* 本单明细对应的佣金若已退款冲正（或记录缺失），其毛额已随冲正消失，
       退回余额只能释放仍然有效的部分，否则会凭空多出可提现余额 */
    const openItems = await repo.find('promotePayoutItems', {
      withdrawalId: id,
      status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING, PAYOUT_ITEM_STATUS.FAILED] }
    }, { limit: 500 })
    let lapsedGross = 0
    for (const it of openItems) {
      const c = await repo.get('commissions', it.commissionId)
      /* 已冲正、或已出款待回退（debtRecorded，可提现已扣过）的佣金，
         其占用毛额都不再属于用户可提现余额，退回时不能释放 */
      if (!c || c.status === COMMISSION_STATUS.REVERSED || c.debtRecorded === true) {
        lapsedGross = round2(lapsedGross + round2(it.grossPart))
      }
    }
    const res = await repo.updateWhere('promoterWithdrawals', {
      id,
      status: doc.status
    }, {
      status: WITHDRAW_STATUS.CANCELLED,
      activeKey: retiredKeyOf(id),
      cancelledAt: current,
      cancelReason: reason,
      updatedAt: current
    })
    if (res.count === 0) throw new AppError(CODES.CONFLICT, '提现单状态已变更，请刷新后重试')
    /* 逐条置终态：退休键按明细 id 生成，批量更新无法保证每行唯一的键 */
    for (const it of openItems) {
      await repo.updateWhere('promotePayoutItems', {
        id: it.id,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING, PAYOUT_ITEM_STATUS.FAILED] }
      }, {
        status: PAYOUT_ITEM_STATUS.CANCELLED,
        activeCommissionKey: retiredKeyOf(it.id),
        failReason: reason,
        updatedAt: current
      })
    }
    await releaseWithdrawal(doc.uid, doc, { lapsedGross })
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: operator,
      action: 'promote.payout.cancel',
      target: id,
      reason: lapsedGross > 0 ? `${reason} · 已冲正毛额 ${lapsedGross} 不再释放` : reason,
      at: current
    })
    await notifyUser(
      doc.uid,
      '提现已退回',
      `金额 ¥${round2(round2(doc.amount) - lapsedGross).toFixed(2)} 已退回可提现余额。原因：${reason}。`,
      'withdraw',
      id
    )
    return { id, status: WITHDRAW_STATUS.CANCELLED, released: round2(round2(doc.amount) - lapsedGross) }
  }

  async function payoutList(data) {
    const q = data || {}
    const paging = normalizePaging(q)
    const filter = {}
    if (q.status) filter.status = str(q.status, { field: '状态', max: 12 })
    else filter.status = { $in: [WITHDRAW_STATUS.APPROVED, WITHDRAW_STATUS.PAYING, WITHDRAW_STATUS.FAILED] }
    if (q.claimedBy) filter.claimedBy = str(q.claimedBy, { field: '领取人', max: 80 })
    if (q.uid) filter.uid = str(q.uid, { field: '推广人', max: 80 })
    /* 金额筛选（文档 6.2：待打款清单支持超时、金额、执行人筛选） */
    const numOrNaN = (v) => (v === '' || v === undefined || v === null ? NaN : Number(v))
    const minAmount = numOrNaN(q.minAmount)
    const maxAmount = numOrNaN(q.maxAmount)
    if (Number.isFinite(minAmount) || Number.isFinite(maxAmount)) {
      filter.net = {}
      if (Number.isFinite(minAmount)) filter.net.$gte = minAmount
      if (Number.isFinite(maxAmount)) filter.net.$lt = maxAmount + 0.005
    }
    const current = at()
    if (q.overdue === true || q.overdue === 'true') {
      /* 超时筛选必须下推到查询，否则分页后再过滤会导致总数与页面不一致 */
      filter.status = WITHDRAW_STATUS.APPROVED
      filter.payoutDeadlineAt = { $lt: current }
    }
    const keyword = str(q.keyword || q.q, { field: '关键词', max: 60 })
    let rows
    let total
    if (keyword) {
      const all = await repo.find('promoterWithdrawals', filter, { sort: { reviewedAt: 1 }, limit: 500 })
      const hit = all.filter((w) => String(w.id).indexOf(keyword) > -1 || String(w.uid).indexOf(keyword) > -1 || String(w.payoutNo || '').indexOf(keyword) > -1)
      total = hit.length
      rows = hit.slice(paging.skip, paging.skip + paging.limit)
    } else {
      total = await repo.count('promoterWithdrawals', filter)
      rows = await repo.find('promoterWithdrawals', filter, {
        sort: { reviewedAt: 1 },
        skip: paging.skip,
        limit: paging.limit
      })
    }
    const items = []
    for (const w of rows) {
      items.push({
        id: w.id,
        uid: w.uid,
        amount: round2(w.amount),
        fee: round2(w.fee),
        tax: round2(w.tax),
        deductToDebt: round2(w.deductToDebt),
        net: round2(w.net),
        status: w.status,
        method: w.method || '',
        methodText: w.method === 'manualSplit' ? '人工分账' : w.method === 'manualTransfer' ? '商家转账' : w.method === 'mixed' ? '混合出款' : '待选择',
        applyAt: Number(w.applyAt),
        applyText: dateTimeText(w.applyAt),
        reviewedBy: w.reviewedBy || '',
        reviewedAt: Number(w.reviewedAt) || 0,
        claimedBy: w.claimedBy || '',
        claimedAt: Number(w.claimedAt) || 0,
        payoutDeadlineAt: Number(w.payoutDeadlineAt) || 0,
        overdue: !!(w.payoutDeadlineAt && Number(w.payoutDeadlineAt) < current && w.status === WITHDRAW_STATUS.APPROVED),
        payoutNo: w.payoutNo || '',
        payoutAmount: round2(w.payoutAmount),
        paidAt: Number(w.paidAt) || 0,
        voucherUrl: w.voucherUrl || '',
        checkedBy: w.checkedBy || '',
        note: w.note || '',
        failReason: w.failReason || '',
        uncoveredAmount: round2(w.uncoveredAmount)
      })
    }
    return { page: paging.page, limit: paging.limit, total, capped: paging.capped, items }
  }

  async function payoutItems(data) {
    const q = data || {}
    const paging = normalizePaging(q)
    const filter = {}
    if (q.withdrawalId) filter.withdrawalId = str(q.withdrawalId, { field: '提现单号', max: 80 })
    if (q.status) filter.status = str(q.status, { field: '状态', max: 12 })
    if (q.uid) filter.uid = str(q.uid, { field: '推广人', max: 80 })
    if (q.paymentId) filter.paymentId = str(q.paymentId, { field: '支付单号', max: 80 })
    if (q.transactionId) filter.transactionId = str(q.transactionId, { field: '交易单号', max: 80 })
    if (q.payoutNo) filter.payoutNo = str(q.payoutNo, { field: '出款单据号', max: 80 })
    if (q.type) filter.type = str(q.type, { field: '路径', max: 20 })
    /* 中台检索框按「单据号 / 交易单号 / 提现单号」模糊检索 */
    const keyword = str(q.q || q.keyword, { field: '关键词', max: 80 })
    if (keyword) {
      const all = await repo.find('promotePayoutItems', filter, { sort: { createdAt: -1 }, limit: 5000 })
      const hit = all.filter((it) => String(it.id).indexOf(keyword) > -1 ||
        String(it.payoutNo || '').indexOf(keyword) > -1 ||
        String(it.transactionId || '').indexOf(keyword) > -1 ||
        String(it.paymentId || '').indexOf(keyword) > -1 ||
        String(it.withdrawalId || '').indexOf(keyword) > -1)
      return {
        page: paging.page,
        limit: paging.limit,
        total: hit.length,
        capped: paging.capped,
        items: hit.slice(paging.skip, paging.skip + paging.limit).map(payoutItemView)
      }
    }
    const total = await repo.count('promotePayoutItems', filter)
    const rows = await repo.find('promotePayoutItems', filter, {
      sort: { createdAt: -1 },
      skip: paging.skip,
      limit: paging.limit
    })
    return {
      page: paging.page,
      limit: paging.limit,
      total,
      capped: paging.capped,
      items: rows.map(payoutItemView)
    }
  }

  /** 出款明细统一输出视图：分页与关键字检索共用 */
  function payoutItemView(it) {
    return {
      id: it.id,
      withdrawalId: it.withdrawalId,
      seq: Number(it.seq) || 0,
      uid: it.uid,
      commissionId: it.commissionId,
      paymentId: it.paymentId,
      transactionId: it.transactionId || '',
      receiverOpenid: it.receiverOpenid,
      receiverName: it.receiverName || '',
      path: it.path,
      pathText: it.path === 'A' ? 'A 人工分账' : it.path === 'B' ? 'B 商家转账' : '',
      type: it.type,
      grossPart: round2(it.grossPart),
      amount: round2(it.amount),
      status: it.status,
      claimedBy: it.claimedBy || '',
      proofNo: it.proofNo || '',
      paidAmount: round2(it.paidAmount),
      paidAt: Number(it.paidAt) || 0,
      paidText: dateTimeText(it.paidAt),
      proofUrl: it.proofUrl || '',
      failReason: it.failReason || '',
      payoutNo: it.payoutNo || '',
      requestId: it.requestId || ''
    }
  }

  /**
   * 账本对账（文档 4.8）：佣金台账 / 提现单 / 用户汇总三方比对。
   * 只返回差异列表，不改账；可由定时任务周期调用。
   */
  async function reconcile(input) {
    const d = input || {}
    const current = Number(d.at) || at()
    const tolerance = 0.01
    const issues = []
    const push = (issue) => {
      if (issues.length < 200) issues.push(issue)
    }

    const commissions = await repo.find('commissions', {}, { limit: 5000 })
    const withdrawals = await repo.find('promoterWithdrawals', {}, { limit: 5000 })
    let items = []
    try {
      items = await repo.find('promotePayoutItems', {}, { limit: 5000 })
    } catch (err) {
      push({ type: 'collection-missing', field: 'promotePayoutItems', message: '出款明细集合不可用，请检查 repo 白名单' })
    }
    /* 封禁推广者的余额仍需对账，否则会被误判为 user-missing */
    const users = await repo.find('users', { promoterStatus: { $in: ['active', 'blocked'] } }, { limit: 5000 })

    const ledger = Object.create(null)
    const ensure = (uid) => {
      if (!ledger[uid]) {
        ledger[uid] = { earning: 0, pending: 0, available: 0, withdrawing: 0, withdrawn: 0, reversed: 0 }
      }
      return ledger[uid]
    }
    for (const c of commissions) {
      const slot = ensure(c.uid)
      if (c.status === COMMISSION_STATUS.REVERSED) {
        slot.reversed = round2(slot.reversed + round2(c.amount))
        continue
      }
      slot.earning = round2(slot.earning + round2(c.amount))
      if (c.status === COMMISSION_STATUS.PENDING) slot.pending = round2(slot.pending + round2(c.amount))
      if (c.status === COMMISSION_STATUS.AVAILABLE) {
        slot.available = round2(slot.available + (c.debtRecorded ? 0 : commissionRemain(c).grossRemain))
      }
      /* I6：已出款净额不得超过佣金净额（毛额 × (1 − feeRate)） */
      const capNet = round2(round2(c.amount) * (1 - (Number(c.feeRate) || 0)))
      if (round2(c.payoutAmount) > round2(capNet + 0.01)) {
        push({ type: 'commission-overpaid', uid: c.uid, ref: c.id, field: 'payoutAmount', actual: round2(c.payoutAmount), limit: capNet })
      }
      if (round2(c.withdrawnAmount) > round2(round2(c.amount) + 0.01)) {
        push({ type: 'commission-over-withdrawn', uid: c.uid, ref: c.id, field: 'withdrawnAmount', actual: round2(c.withdrawnAmount), limit: round2(c.amount) })
      }
    }
    const itemsByWithdrawal = Object.create(null)
    for (const it of items) {
      const key = it.withdrawalId
      if (!itemsByWithdrawal[key]) itemsByWithdrawal[key] = []
      itemsByWithdrawal[key].push(it)
    }
    for (const w of withdrawals) {
      const slot = ensure(w.uid)
      if (isOccupyingWithdrawal(w.status)) slot.withdrawing = round2(slot.withdrawing + round2(w.amount))
      if (w.status === WITHDRAW_STATUS.PAID) {
        /* 「累计已提现」按真实出款的明细毛额统计（与 payoutMark 一致）；
           冲正后失效的明细（uncovered）从未出款，不计入。历史单无明细时回退整单毛额 */
        const doneRows = (itemsByWithdrawal[w.id] || []).filter((it) => it.status === PAYOUT_ITEM_STATUS.DONE)
        const paidGross = doneRows.length
          ? round2(doneRows.reduce((s, it) => round2(s + round2(it.grossPart)), 0))
          : round2(w.amount)
        slot.withdrawn = round2(slot.withdrawn + paidGross)
      }
    }

    for (const uid of Object.keys(ledger)) {
      const user = users.find((u) => u.id === uid)
      if (!user) {
        push({ type: 'user-missing', uid, message: '存在台账但用户不存在或非推广者' })
        continue
      }
      const expected = ledger[uid]
      /* 在途提现单的毛额已从可提现余额划入「提现中」，台账口径需先抵扣占用，否则每笔在途都会误报差异 */
      const availableExpected = Math.max(0, round2(expected.available - expected.withdrawing))
      const checks = [
        ['promoterEarning', expected.earning],
        ['promoterPending', expected.pending],
        ['promoterAvailable', availableExpected],
        ['promoterWithdrawing', expected.withdrawing],
        ['promoterWithdrawn', expected.withdrawn]
      ]
      for (const [field, value] of checks) {
        const actual = round2(user[field])
        if (Math.abs(actual - value) > tolerance) {
          push({ type: 'user-ledger-drift', uid, field, expected: value, actual, diff: round2(actual - value) })
        }
      }
    }

    /* 已到账单据：done 明细合计必须等于净额 */
    for (const w of withdrawals) {
      if (w.status !== WITHDRAW_STATUS.PAID) continue
      const rows = itemsByWithdrawal[w.id] || []
      const done = rows.filter((it) => it.status === PAYOUT_ITEM_STATUS.DONE)
      const total = round2(done.reduce((s, it) => round2(s + round2(it.amount)), 0))
      /* 3.9：已冲正佣金对应的明细会被取消并记入 uncoveredAmount，
         此时已核销合计 = net − uncoveredAmount 才是正确口径 */
      const expectedPay = round2(round2(w.net) - round2(w.uncoveredAmount))
      if (!moneyEq(total, expectedPay)) {
        push({ type: 'paid-items-mismatch', uid: w.uid, ref: w.id, expected: expectedPay, actual: total })
      }
      if (!w.payoutNo) push({ type: 'paid-without-payout-no', uid: w.uid, ref: w.id })
    }

    /* 出款单据号全局唯一 */
    const byPayoutNo = Object.create(null)
    for (const w of withdrawals) {
      if (!w.payoutNo) continue
      if (byPayoutNo[w.payoutNo] && byPayoutNo[w.payoutNo] !== w.id) {
        push({ type: 'duplicate-payout-no', ref: w.payoutNo, ids: [byPayoutNo[w.payoutNo], w.id] })
      }
      byPayoutNo[w.payoutNo] = w.id
    }

    /* 同一佣金只能有一条 todo/doing 明细 */
    const activeByCommission = Object.create(null)
    for (const it of items) {
      if (it.status !== PAYOUT_ITEM_STATUS.TODO && it.status !== PAYOUT_ITEM_STATUS.DOING) continue
      if (activeByCommission[it.commissionId]) {
        push({ type: 'duplicate-active-item', ref: it.commissionId, ids: [activeByCommission[it.commissionId], it.id] })
      }
      activeByCommission[it.commissionId] = it.id
    }

    const countByType = Object.create(null)
    for (const issue of issues) countByType[issue.type] = (countByType[issue.type] || 0) + 1
    return {
      checkedAt: current,
      users: Object.keys(ledger).length,
      commissionCount: commissions.length,
      withdrawalCount: withdrawals.length,
      itemCount: items.length,
      issues,
      countByType,
      drift: issues.length > 0
    }
  }

  /* ---------------- 管理端 ---------------- */

  async function adminOverview(data) {
    const p = normalizePaging(data)
    const settings = await readSettings()
    const d = data || {}
    /* 中台按 q 传关键字，历史调用方传 keyword，两者都兼容 */
    const keyword = str(d.keyword || d.q, { field: '关键词', max: 32 })
    const statusFilter = str(d.status, { field: '状态', max: 16 })
    let users = await repo.find('users', { promoterStatus: { $in: ['active', 'blocked'] } }, { limit: 5000 })
    /* 客服绑定账号同样视为推广人：即使没有线上开通，也要出现在推广名单并可查两级下级 */
    const csBindings = await repo.find('csBindings', {}, { limit: 5000 })
    const csMap = new Map(csBindings.map((b) => [b.uid, b]))
    const known = new Set(users.map((u) => u.id))
    for (const b of csBindings) {
      if (!b.uid || known.has(b.uid)) continue
      const bound = await repo.get('users', b.uid)
      if (!bound) continue
      users.push(bound)
      known.add(bound.id)
    }
    if (statusFilter) {
      const want = /封禁|blocked|banned/i.test(statusFilter) ? 'blocked'
        : /正常|active|normal/i.test(statusFilter) ? 'active' : statusFilter
      users = users.filter((u) => u.promoterStatus === want)
    }
    if (keyword) {
      const kw = keyword.toLowerCase()
      users = users.filter((u) => String(u.nick || u.nickName || '').toLowerCase().includes(kw) || String(u.id).includes(keyword) || String(u.refCode || '').toUpperCase() === keyword.toUpperCase())
    }
    users.sort((a, b) => (Number(b.promoterEarning) || 0) - (Number(a.promoterEarning) || 0))
    const total = users.length
    const items = users.slice(p.skip, p.skip + p.limit).map((u) => {
      const cs = csMap.get(u.id)
      return {
        uid: u.id,
        nick: u.nick || u.nickName || '',
        refCode: u.refCode || '',
        rateText: rateText(settings.commissionRate),
        level2RateText: rateText(settings.level2Rate),
        rateEditable: false,
        status: u.promoterStatus || 'none',
        statusText: u.promoterStatus === 'blocked' ? '已封禁' : u.promoterStatus === 'active' ? '正常' : cs ? '客服绑定（未开通）' : '未开通',
        csBound: !!cs,
        csName: (cs && (cs.csName || cs.csId)) || '',
        earning: round2(u.promoterEarning),
        level1Earning: 0,
        level2Earning: 0,
        pending: round2(u.promoterPending),
        available: round2(u.promoterAvailable),
        withdrawn: round2(u.promoterWithdrawn),
        withdrawing: round2(u.promoterWithdrawing),
        appliedToDebt: round2(u.promoterAppliedToDebt),
        debt: round2(u.promoterDebt),
        referrals: 0,
        level1Count: 0,
        level2Count: 0,
        openedAt: Number(u.promoterOpenedAt || u.promoterSince) || 0
      }
    })
    for (const item of items) {
      const level1 = await repo.find('referralBindings', { refUid: item.uid }, { limit: 5000 })
      item.level1Count = level1.length
      item.referrals = level1.length
      item.level2Count = level1.length
        ? await repo.count('referralBindings', { refUid: { $in: level1.map((b) => b.uid) } })
        : 0
      const rows = await repo.find('commissions', { uid: item.uid }, { limit: 5000 })
      for (const row of rows) {
        if (row.status === COMMISSION_STATUS.REVERSED) continue
        if (Number(row.level) === 2) item.level2Earning = round2(item.level2Earning + round2(row.amount))
        else item.level1Earning = round2(item.level1Earning + round2(row.amount))
      }
    }
    return {
      page: p.page,
      limit: p.limit,
      total,
      items,
      commissionRate: settings.commissionRate,
      level2Rate: settings.level2Rate,
      rateText: rateText(settings.commissionRate),
      level2RateText: rateText(settings.level2Rate),
      payoutMode: 'manual',
      autoApprove: false
    }
  }

  /**
   * 推广人详情：一级 / 二级下级名单、人数、开通情况。
   * 同一个人既可能在某人的一级名单里，也可能在另一人的二级名单里，这里按关系链分别列出。
   */
  async function adminPromoterDetail(data) {
    const d = data || {}
    const uid = str(d.uid, { field: '推广人', max: 80 })
    if (!uid) throw new AppError(CODES.VALIDATION, '缺少推广人')
    const settings = await readSettings()
    const user = await repo.get('users', uid)
    if (!user) throw new AppError(CODES.NOT_FOUND, '推广人不存在')
    const cs = await findOne('csBindings', { uid })

    /* 一级：直接绑定到本人；二级：一级下级的直接下级（同一人可同时出现在不同人的名单里） */
    const level1Bindings = await repo.find('referralBindings', { refUid: uid }, { sort: { field: 'boundAt', dir: 'desc' }, limit: 5000 })
    const level2Bindings = []
    for (const b of level1Bindings) {
      const rows = await repo.find('referralBindings', { refUid: b.uid }, { sort: { field: 'boundAt', dir: 'desc' }, limit: 5000 })
      for (const row of rows) level2Bindings.push(Object.assign({ parentUid: b.uid }, row))
    }

    /* 下级用户与会员开通情况：一次批量取回，避免逐条查询 */
    const uids = Array.from(new Set(
      level1Bindings.map((b) => b.uid).concat(level2Bindings.map((b) => b.uid)).filter(Boolean)
    ))
    const userMap = new Map()
    const accessMap = new Map()
    if (uids.length) {
      const list = await repo.find('users', { id: { $in: uids } }, { limit: 5000 })
      for (const u of list) userMap.set(u.id, u)
      const access = await repo.find('bizAccess', { id: { $in: uids } }, { limit: 5000 })
      for (const a of access) accessMap.set(a.id, a)
    }
    const current = at()
    const rowOf = (binding, level) => {
      const child = userMap.get(binding.uid) || {}
      const access = accessMap.get(binding.uid) || {}
      const expireAt = Number(access.expireAt) || 0
      const memberActive = expireAt > current
      const parent = level === 2 ? (userMap.get(binding.parentUid) || {}) : null
      return {
        uid: binding.uid,
        nick: child.nick || child.nickName || '',
        level,
        parentUid: level === 2 ? binding.parentUid : '',
        parentNick: parent ? (parent.nick || parent.nickName || '') : '',
        refCode: child.refCode || '',
        promoterStatus: child.promoterStatus || 'none',
        promoterStatusText: child.promoterStatus === 'active' ? '已开通推广' : child.promoterStatus === 'blocked' ? '推广已封禁' : '未开通推广',
        member: memberActive,
        memberText: memberActive ? `会员至 ${dateText(expireAt).slice(0, 10)}` : '未开通会员',
        memberExpireAt: expireAt,
        boundAt: Number(binding.boundAt) || 0,
        firstOrderAt: Number(binding.firstOrderAt) || 0
      }
    }
    const level1 = level1Bindings.map((b) => rowOf(b, 1))
    const level2 = level2Bindings.map((b) => rowOf(b, 2))
    /* 两级收入按佣金台账统计：与推广名单口径一致，避免依赖用户余额字段的聚合口径 */
    let level1Earning = 0
    let level2Earning = 0
    const ownCommissions = await repo.find('commissions', { uid }, { limit: 5000 })
    for (const row of ownCommissions) {
      if (row.status === COMMISSION_STATUS.REVERSED) continue
      if (Number(row.level) === 2) level2Earning = round2(level2Earning + round2(row.amount))
      else level1Earning = round2(level1Earning + round2(row.amount))
    }

    return {
      uid,
      nick: user.nick || user.nickName || '',
      refCode: user.refCode || '',
      status: user.promoterStatus || 'none',
      statusText: user.promoterStatus === 'blocked' ? '已封禁' : user.promoterStatus === 'active' ? '正常' : cs ? '客服绑定（未开通）' : '未开通',
      csBound: !!cs,
      csName: (cs && (cs.csName || cs.csId)) || '',
      openedAt: Number(user.promoterOpenedAt || user.promoterSince) || 0,
      earning: round2(user.promoterEarning),
      level1Earning,
      level2Earning,
      pending: round2(user.promoterPending),
      available: round2(user.promoterAvailable),
      withdrawn: round2(user.promoterWithdrawn),
      debt: round2(user.promoterDebt),
      rateText: rateText(settings.commissionRate),
      level2RateText: rateText(settings.level2Rate),
      counts: { level1: level1.length, level2: level2.length, total: level1.length + level2.length },
      /* 开通情况汇总：一级 / 二级分别有多少人已开通会员、已开通推广 */
      opened: {
        level1Member: level1.filter((r) => r.member).length,
        level2Member: level2.filter((r) => r.member).length,
        level1Promoter: level1.filter((r) => r.promoterStatus === 'active').length,
        level2Promoter: level2.filter((r) => r.promoterStatus === 'active').length
      },
      level1,
      level2
    }
  }

  async function adminCommissions(data) {
    const p = normalizePaging(data)
    const d = data || {}
    const query = {}
    if (d.status) query.status = str(d.status, { field: '状态', max: 16 })
    /* 推广者检索支持用户ID / 昵称 / 推广码，中台输入框即这三类口径 */
    const uidInput = str(d.uid || d.q, { field: '推广者', max: 64 })
    if (uidInput) {
      const all = await repo.find('users', { promoterStatus: { $in: ['active', 'blocked'] } }, { limit: 5000 })
      const kw = uidInput.toLowerCase()
      const uids = all.filter((u) => String(u.id) === uidInput ||
        String(u.nick || u.nickName || '').toLowerCase().includes(kw) ||
        String(u.refCode || '').toUpperCase() === uidInput.toUpperCase()).map((u) => u.id)
      query.uid = uids.length ? { $in: uids } : uidInput
    }
    if (d.from || d.to) {
      query.createdAt = {}
      const from = Number(d.from)
      const to = Number(d.to)
      if (Number.isFinite(from) && from > 0) query.createdAt.$gte = from
      if (Number.isFinite(to) && to > 0) query.createdAt.$lt = to
      if (!Object.keys(query.createdAt).length) delete query.createdAt
    }
    const rows = await repo.find('commissions', query, { sort: { createdAt: -1 }, skip: p.skip, limit: p.limit })
    const total = await repo.count('commissions', query)
    return {
      page: p.page,
      limit: p.limit,
      total,
      items: rows.map((row) => ({
        id: row.id,
        uid: row.uid,
        buyerUid: row.buyerUid,
        paymentId: row.paymentId,
        transactionId: row.transactionId || '',
        planLabel: row.planLabel || '',
        orderAmount: round2(row.paidAmount !== undefined ? row.paidAmount : row.orderAmount),
        paidAmount: round2(row.paidAmount !== undefined ? row.paidAmount : row.orderAmount),
        channel: row.channel,
        channelRate: Number(row.channelRate) || 0,
        channelRateText: rateText(row.channelRate),
        channelFee: round2(row.channelCost !== undefined ? row.channelCost : row.channelFee),
        base: round2(row.base),
        rate: Number(row.rate) || 0,
        rateText: rateText(row.rate),
        feeRate: Number(row.feeRate) || 0,
        amount: round2(row.amount),
        feeAmount: round2(row.feeAmount),
        netAmount: round2(row.netAmount),
        withdrawnAmount: round2(row.withdrawnAmount),
        payoutAmount: round2(row.payoutAmount),
        offsetToDebt: round2(row.offsetToDebt),
        status: row.status,
        arrivalHold: row.arrivalHold === true,
        eligibleText: row.arrivalHold ? '待到账确认' : dateText(row.eligibleAt || row.releaseAt),
        createdAt: Number(row.createdAt),
        reversedAt: Number(row.reversedAt) || 0,
        reverseReason: row.reverseReason || ''
      }))
    }
  }

  async function adminWithdrawals(data) {
    const p = normalizePaging(data)
    const current = at()
    const d = data || {}
    const query = {}
    if (d.status) query.status = str(d.status, { field: '状态', max: 16 })
    if (d.uid) query.uid = str(d.uid, { field: '推广者', max: 64 })
    /* 中台搜索框按「提现单号 / 昵称 / 用户ID」检索，命中用户ID时转换为 $in */
    const keyword = str(d.q || d.keyword, { field: '关键词', max: 60 })
    let rows
    let total
    if (keyword) {
      const kw = keyword.toLowerCase()
      const users = await repo.find('users', {}, { limit: 5000 })
      const uids = users.filter((u) => String(u.id) === keyword ||
        String(u.nick || u.nickName || '').toLowerCase().includes(kw)).map((u) => u.id)
      const all = await repo.find('promoterWithdrawals', query, { sort: { applyAt: -1 }, limit: 5000 })
      const hit = all.filter((w) => String(w.id).indexOf(keyword) > -1 ||
        String(w.uid).indexOf(keyword) > -1 || String(w.payoutNo || '').indexOf(keyword) > -1 ||
        uids.indexOf(w.uid) > -1)
      total = hit.length
      rows = hit.slice(p.skip, p.skip + p.limit)
    } else {
      rows = await repo.find('promoterWithdrawals', query, { sort: { applyAt: -1 }, skip: p.skip, limit: p.limit })
      total = await repo.count('promoterWithdrawals', query)
    }
    const items = []
    for (const row of rows) {
      const user = await repo.get('users', row.uid)
      items.push({
        id: row.id,
        uid: row.uid,
        nick: (user && (user.nick || user.nickName)) || '',
        amount: round2(row.amount),
        fee: round2(row.fee),
        tax: round2(row.tax),
        deductToDebt: round2(row.deductToDebt),
        net: round2(row.net),
        status: row.status,
        method: row.method || '',
        methodText: row.method === 'manualSplit' ? '人工分账' : row.method === 'manualTransfer' ? '商家转账' : row.method === 'mixed' ? '混合出款' : '待选择',
        payoutNo: row.payoutNo || '',
        claimedBy: row.claimedBy || '',
        payoutDeadlineAt: Number(row.payoutDeadlineAt) || 0,
        overdue: !!(row.status === WITHDRAW_STATUS.APPROVED && row.payoutDeadlineAt && Number(row.payoutDeadlineAt) < current),
        uncoveredAmount: round2(row.uncoveredAmount),
        failReason: row.failReason || '',
        applyAt: Number(row.applyAt),
        paidAt: Number(row.paidAt) || 0,
        voucherUrl: row.voucherUrl || '',
        checkedBy: row.checkedBy || '',
        note: row.note || '',
        reviewedBy: row.reviewedBy || '',
        reviewedAt: Number(row.reviewedAt) || 0
      })
    }
    return { page: p.page, limit: p.limit, total, items }
  }

  async function adminStats() {
    const settings = await readSettings()
    const commissions = await repo.find('commissions', {}, { limit: 5000 })
    const withdrawals = await repo.find('promoterWithdrawals', {}, { limit: 5000 })
    let pending = 0
    let available = 0
    let withdrawn = 0
    let reversed = 0
    let debtTotal = 0
    for (const row of commissions) {
      if (row.status === COMMISSION_STATUS.REVERSED) reversed = round2(reversed + round2(row.amount))
    }
    /* 台账口径统一取用户余额字段：与推广中心、对账使用同一套数据，避免在途提现被重复计入 */
    const promoters = await repo.find('users', { promoterStatus: { $in: ['active', 'blocked'] } }, { limit: 5000 })
    for (const u of promoters) {
      pending = round2(pending + round2(u.promoterPending))
      available = round2(available + round2(u.promoterAvailable))
      withdrawn = round2(withdrawn + round2(u.promoterWithdrawn))
      debtTotal = round2(debtTotal + round2(u.promoterDebt))
    }
    const activePromoters = promoters.filter((u) => u.promoterStatus === 'active').length
    let withdrawing = 0
    let paidCount = 0
    let pendingAudit = 0
    let pendingPayout = 0
    let payingCount = 0
    let failedCount = 0
    let payoutTimeout = 0
    let paidNet = 0
    for (const row of withdrawals) {
      if (isOccupyingWithdrawal(row.status)) withdrawing = round2(withdrawing + round2(row.amount))
      if (row.status === WITHDRAW_STATUS.PENDING) pendingAudit += 1
      if (row.status === WITHDRAW_STATUS.APPROVED) {
        pendingPayout += 1
        /* 工作台待办：领取 / 待打款超过超时时间仍未回填 */
        if (row.payoutDeadlineAt && Number(row.payoutDeadlineAt) < at()) payoutTimeout += 1
      }
      if (row.status === WITHDRAW_STATUS.PAYING) payingCount += 1
      if (row.status === WITHDRAW_STATUS.FAILED) failedCount += 1
      if (row.status === WITHDRAW_STATUS.PAID) {
        paidCount += 1
        paidNet = round2(paidNet + round2(row.net))
      }
    }
    let reconcileDiff = 0
    try {
      reconcileDiff = (await reconcile()).issues.length
    } catch (recErr) {
      console.error('[promote] 对账统计失败 ' + (recErr && recErr.message))
    }
    return {
      promoters: activePromoters,
      bindings: await repo.count('referralBindings', {}),
      pending,
      available,
      withdrawing,
      withdrawn,
      reversed,
      paidCount,
      paidNet,
      debtTotal,
      pendingAudit,
      pendingPayout,
      payingCount,
      failedCount,
      payoutTimeout,
      reconcileDiff,
      commissionRate: settings.commissionRate,
      rateText: rateText(settings.commissionRate),
      payoutMode: 'manual',
      profitSharingEnabled: false,
      payDay: 0,
      manualDualCheckThreshold: round2(settings.manualDualCheckThreshold),
      payoutTimeoutHours: Number(settings.payoutTimeoutHours)
    }
  }

  /** 平台设置：佣金比例统一设置（5%–30%），强制人工分账、人工审核 */
  async function saveSettings(data, actor) {
    const current = await readSettings()
    const d = data || {}
    if (d.autoApprove === true) throw new AppError(CODES.VALIDATION, '本期必须人工审核，不允许开启自动审核')
    if (d.payoutMode && d.payoutMode !== 'manual') throw new AppError(CODES.VALIDATION, '本期仅支持人工分账（manual）')
    const next = Object.assign({}, current, { id: 'promote', updatedAt: at() })
    const num = (key, min, max) => {
      if (d[key] === undefined) return
      const n = Number(d[key])
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new AppError(CODES.VALIDATION, `${key} 需在 ${min} - ${max} 之间`)
      }
      next[key] = n
    }
    num('commissionRate', PROMOTE_RATE_MIN, PROMOTE_RATE_MAX)
    num('level2Rate', PROMOTE_RATE_MIN, PROMOTE_RATE_MAX)
    num('rateMin', PROMOTE_RATE_MIN, PROMOTE_RATE_MAX)
    num('rateMax', PROMOTE_RATE_MIN, PROMOTE_RATE_MAX)
    num('feeRate', 0, 0.2)
    num('minWithdraw', 1, 20000)
    num('maxWithdraw', 1, 50000)
    num('dailyMaxWithdraw', 1, 100000)
    num('dailyMaxCount', 1, 10)
    num('freezeDay', 1, 28)
    num('manualDualCheckThreshold', 1, 100000)
    num('payoutTimeoutHours', 1, 168)
    num('debtBlock', 0, 100000)
    num('maxSplitRatio', 0.05, 0.5)
    num('splitWarnDays', 1, 365)
    num('splitExpireDays', 1, 365)
    if (next.rateMin > next.rateMax) throw new AppError(CODES.VALIDATION, '最低比例不能高于最高比例')
    if (next.commissionRate < next.rateMin || next.commissionRate > next.rateMax) {
      throw new AppError(CODES.VALIDATION, '平台统一比例必须在最低 / 最高比例区间内')
    }
    if (next.level2Rate < next.rateMin || next.level2Rate > next.rateMax) {
      throw new AppError(CODES.VALIDATION, '二级佣金比例必须在最低 / 最高比例区间内')
    }
    /* 分账比例 × 95% 不得超过微信限制（两级分别校验） */
    if (round2(next.commissionRate * (1 - Number(next.feeRate))) > next.maxSplitRatio + 1e-9) {
      throw new AppError(CODES.VALIDATION, '佣金比例 × 95% 不得超过微信分账比例上限')
    }
    if (round2(next.level2Rate * (1 - Number(next.feeRate))) > next.maxSplitRatio + 1e-9) {
      throw new AppError(CODES.VALIDATION, '二级佣金比例 × 95% 不得超过微信分账比例上限')
    }
    if (next.maxWithdraw < next.minWithdraw) throw new AppError(CODES.VALIDATION, '单笔上限不能低于单笔下限')
    if (d.taxEnabled !== undefined) next.taxEnabled = d.taxEnabled === true
    if (d.splitEnabled !== undefined) next.splitEnabled = d.splitEnabled !== false
    if (d.appleArrivalHold !== undefined) next.appleArrivalHold = d.appleArrivalHold !== false
    if (d.agreementVersion !== undefined) next.agreementVersion = str(d.agreementVersion, { field: '协议版本', max: 24 }) || AGREEMENT_VERSION
    next.autoApprove = false
    next.payoutMode = 'manual'
    /* 清理旧版自动打款残留字段 */
    for (const legacy of ['autoPay', 'payDay', 'settleDay', 'rateDefault', 'freezeDaysWxpay', 'freezeDaysApple', 'profitSharingEnabled']) {
      delete next[legacy]
    }
    /* readSettings 会补 id，不能用 current.id 判断是否已存在；按实际更新影响行数决定是否新建 */
    const saved = await repo.updateWhere('promoteSettings', { id: 'promote' }, next)
    if (!saved || saved.count === 0) await repo.insert('promoteSettings', next)
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: str(actor, { field: '操作人', max: 80 }) || 'system',
      action: 'promote.settings.save',
      target: 'promote',
      reason: `rate=${next.commissionRate} l2=${next.level2Rate} fee=${next.feeRate} min=${next.minWithdraw} max=${next.maxWithdraw} dual=${next.manualDualCheckThreshold}`,
      at: at()
    })
    return next
  }

  /** 封禁 / 解封推广者；封禁时待审核提现自动驳回并释放余额 */
  async function setPromoterStatus(data, actor) {
    const d = data || {}
    const uid = str(d.uid, { field: '推广者', max: 80 })
    if (!uid) throw new AppError(CODES.VALIDATION, '缺少推广者')
    const status = str(d.status, { field: '状态', max: 16 })
    if (status !== 'active' && status !== 'blocked') throw new AppError(CODES.VALIDATION, '状态仅支持 active / blocked')
    const user = await repo.get('users', uid)
    if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
    const reason = str(d.reason, { field: '原因', max: 200 }) || (status === 'blocked' ? '平台封禁' : '平台解封')
    const current = at()
    const patch = {
      promoterStatus: status,
      promoterStatusReason: reason,
      promoterStatusAt: current,
      updatedAt: current
    }
    if (status === 'active') {
      patch.promoterOpenedAt = Number(user.promoterOpenedAt || user.promoterSince) || current
      patch.promoterSince = Number(user.promoterSince) || current
      patch.refCode = user.refCode || await ensureRefCode(uid)
    }
    await repo.updateWhere('users', { id: uid }, patch)
    let rejected = 0
    if (status === 'blocked') {
      const rows = await repo.find('promoterWithdrawals', { uid, status: WITHDRAW_STATUS.PENDING }, { limit: 100 })
      for (const row of rows) {
        try {
          await withdrawReject({ id: row.id, reason: `推广者被封禁：${reason}` }, str(actor, { field: '操作人', max: 80 }) || 'system')
          rejected += 1
        } catch (err) {
          /* 并发下可能已被处理，跳过 */
        }
      }
    }
    await appendAudit(repo, {
      actorType: 'staff',
      actorId: str(actor, { field: '操作人', max: 80 }) || 'system',
      action: 'promote.status',
      target: uid,
      reason: `${status} · ${reason} · rejectedWithdrawals=${rejected}`,
      at: current
    })
    return { uid, status, rejected }
  }

  /**
   * 每日任务：结算 + 超期/超时提醒 + 日限额校验。
   * 本期无自动出款，paid 恒为 0；failed 返回待人工处理的失败单数。
   */
  async function runDaily(input) {
    const current = Number(input && input.at) || at()
    const settings = await readSettings()
    const settled = await settlePending({ at: current })

    const withdrawals = await repo.find('promoterWithdrawals', {}, { limit: 5000 })
    const range = dayRange(current)
    let overduePayout = 0
    let overdueAudit = 0
    let failed = 0
    const userDailyNet = Object.create(null)
    let merchantTransferToday = 0

    for (const w of withdrawals) {
      if (w.status === WITHDRAW_STATUS.APPROVED && Number(w.payoutDeadlineAt) && Number(w.payoutDeadlineAt) < current) {
        overduePayout += 1
      }
      if (w.status === WITHDRAW_STATUS.PENDING && Number(w.applyAt) < current - 24 * HOUR_MS) {
        overdueAudit += 1
      }
      if (w.status === WITHDRAW_STATUS.FAILED) failed += 1
      if (w.status === WITHDRAW_STATUS.PAID && Number(w.paidAt) >= range.start && Number(w.paidAt) < range.end) {
        userDailyNet[w.uid] = round2((userDailyNet[w.uid] || 0) + round2(w.net))
        if (w.method === 'manualTransfer') merchantTransferToday = round2(merchantTransferToday + round2(w.net))
      }
    }

    const limitWarnings = []
    for (const uid of Object.keys(userDailyNet)) {
      if (userDailyNet[uid] > settings.dailyMaxWithdraw) {
        limitWarnings.push({ type: 'user-daily-net', uid, actual: userDailyNet[uid], limit: settings.dailyMaxWithdraw })
        await notifyUser(uid, '提现日限额提醒', `今日累计出款 ¥${userDailyNet[uid].toFixed(2)} 已超过单日上限 ¥${settings.dailyMaxWithdraw}，请联系客服核实。`, 'withdraw')
      }
    }
    if (merchantTransferToday > MERCHANT_DAILY_TRANSFER_MAX) {
      limitWarnings.push({ type: 'merchant-daily-transfer', actual: merchantTransferToday, limit: MERCHANT_DAILY_TRANSFER_MAX })
    }

    /* 分账 180 天到期：置 splitExpired，后续只能走商家转账。
       默认不开分账时不存在订单资金冻结，这类扫描与提醒全部跳过 */
    const commissions = settings.splitEnabled === false
      ? []
      : await repo.find('commissions', { status: COMMISSION_STATUS.AVAILABLE }, { limit: 5000 })
    let splitExpired = 0
    let staleCommissions = 0
    for (const c of commissions) {
      if (!c.transactionId || c.splitExpired) continue
      const age = current - Number(c.createdAt || 0)
      if (age > Number(settings.splitExpireDays) * DAY_MS) {
        await repo.updateWhere('commissions', { id: c.id }, { splitExpired: true, updatedAt: current })
        splitExpired += 1
      } else if (age > Number(settings.splitWarnDays) * DAY_MS) {
        staleCommissions += 1
        if (!c.splitWarnedAt) {
          await repo.updateWhere('commissions', { id: c.id }, { splitWarnedAt: current })
          await notifyUser(c.uid, '佣金即将停止分账', `有 ¥${round2(c.amount).toFixed(2)} 佣金支付已超过 ${settings.splitWarnDays} 天，超过 ${settings.splitExpireDays} 天将只能走商家转账。`, 'commission', c.id)
        }
      }
    }

    return {
      settled: settled.count,
      settledAmount: settled.amount,
      offsetDebt: settled.offset,
      paid: 0,
      failed,
      overduePayout,
      overdueAudit,
      staleCommissions,
      splitExpired,
      limitWarnings
    }
  }

  /**
   * 超期预警（文档 7.4 · 09:00）：复用日终任务里的 150 / 170 天到期扫描与日限额校验。
   * runDaily 内的结算部分幂等（01:00 已结算过，这里不会再动任何佣金）。
   */
  async function warnExpiringCommissions(input) {
    return runDaily(input)
  }

  /**
   * 计佣补偿（文档 7.4 · 03:00）：支付成功时计佣失败不阻断开通，
   * 这里扫描近 N 天已确认的会员收款单，补写缺失的佣金。
   * 幂等：paymentId 唯一索引 + createCommission 内部按 paymentId 复用，重复执行不会重复计佣。
   */
  async function compensateCommissions(input) {
    const d = input || {}
    const current = Number(d.at) || at()
    const days = Math.max(1, Math.min(30, Number(d.days) || 7))
    const since = current - days * DAY_MS
    const payments = await repo.find('payments', {
      status: '已确认',
      confirmedAt: { $gte: since }
    }, { sort: { confirmedAt: 1 }, limit: 5000 })
    let scanned = 0
    let created = 0
    let skipped = 0
    const failed = []
    for (const p of payments) {
      /* 只补偿会员收款：服务费账单等没有 paymentId，不属于计佣范围 */
      if (!p.paymentId || p.agencyId) continue
      scanned += 1
      try {
        const binding = await repo.get('referralBindings', p.uid)
        if (!binding || !binding.refUid) {
          skipped += 1
          continue
        }
        /* 一次补齐两级：一级已存在时仍会尝试补二级，保证老数据升级后也有二级佣金 */
        const before = await repo.find('commissions', { sourcePaymentId: p.paymentId }, { limit: 2 })
        await createPaymentCommissions({
          uid: binding.refUid,
          buyerUid: p.uid,
          paymentId: p.paymentId,
          /* payments 未落微信交易号，补出的佣金只能走路径 B 商家转账 */
          transactionId: '',
          amount: round2(p.received !== undefined ? p.received : p.amount),
          channel: p.channel || '',
          orderId: p.orderId || '',
          at: Number(p.paidAt) || Number(p.confirmedAt) || current
        })
        const after = await repo.find('commissions', { sourcePaymentId: p.paymentId }, { limit: 2 })
        if (after.length > before.length) created += 1
        else skipped += 1
      } catch (err) {
        failed.push({ paymentId: p.paymentId, message: (err && err.message) || '计佣失败' })
      }
    }
    if (created > 0 || failed.length) {
      await appendAudit(repo, {
        actorType: 'system',
        actorId: 'promote',
        action: 'promote.commission.compensate',
        target: 'commissions',
        reason: `days=${days} scanned=${scanned} created=${created} failed=${failed.length}`,
        at: current
      })
    }
    return { days, scanned, created, skipped, failed }
  }

  /**
   * 分账完结清单（文档 7.4 · 04:00）：路径 A 出款完成、且该订单下佣金全部结清的单，
   * 剩余冻结资金可以由财务在商户平台「完结分账」释放。
   * 默认关闭分账时没有冻结资金，直接返回空清单。
   */
  async function buildSplitCompletionList(input) {
    const current = Number(input && input.at) || at()
    const settings = await readSettings()
    if (settings.splitEnabled === false) {
      return { enabled: false, count: 0, items: [] }
    }
    const doneItems = await repo.find('promotePayoutItems', {
      path: 'A',
      status: PAYOUT_ITEM_STATUS.DONE
    }, { sort: { paidAt: 1 }, limit: 5000 })
    const byTransaction = new Map()
    for (const it of doneItems) {
      if (!it.transactionId) continue
      const key = String(it.transactionId)
      if (!byTransaction.has(key)) byTransaction.set(key, [])
      byTransaction.get(key).push(it)
    }
    const items = []
    for (const [transactionId, rows] of byTransaction) {
      /* 同一订单还有在途 / 失败的出款明细时不能完结，否则剩余冻结资金会提前释放 */
      const pendingItems = await repo.find('promotePayoutItems', {
        transactionId,
        status: { $in: [PAYOUT_ITEM_STATUS.TODO, PAYOUT_ITEM_STATUS.DOING, PAYOUT_ITEM_STATUS.FAILED] }
      }, { limit: 1 })
      if (pendingItems.length) continue
      const commissions = await repo.find('commissions', { transactionId }, { limit: 200 })
      if (!commissions.length) continue
      /* 仍有毛额未出款（待结算 / 可提现 / 部分出款）的佣金，说明分账还没分完 */
      const unsettled = commissions.filter((c) => {
        if (c.status === COMMISSION_STATUS.REVERSED) return false
        return centsOf(commissionRemain(c).grossRemain) > 0
      })
      if (unsettled.length) continue
      items.push({
        transactionId,
        commissionIds: commissions.map((c) => c.id),
        commissionCount: commissions.length,
        orderIds: commissions.map((c) => c.orderId).filter(Boolean).filter((id, idx, arr) => arr.indexOf(id) === idx),
        itemCount: rows.length,
        withdrawalIds: rows.map((r) => r.withdrawalId).filter((id, idx, arr) => arr.indexOf(id) === idx),
        grossPaid: round2(rows.reduce((sum, r) => round2(sum + round2(r.grossPart)), 0)),
        netPaid: round2(rows.reduce((sum, r) => round2(sum + round2(r.amount)), 0)),
        lastPaidAt: rows.reduce((max, r) => Math.max(max, Number(r.paidAt) || 0), 0),
        readyAt: current
      })
    }
    items.sort((a, b) => b.lastPaidAt - a.lastPaidAt)
    return { enabled: true, count: items.length, items: items.slice(0, 200) }
  }

  /**
   * 待打款超时提醒（文档 7.4 · 09:00）：审核通过后超过 payoutTimeoutHours 仍未回填的单，
   * 中台工作台已有标红计数，这里补「审计留痕 + 给推广者一次进度提醒」。
   * 同一笔每天最多提醒一次，任务重跑不会刷屏。
   */
  async function remindPayoutTimeout(input) {
    const current = Number(input && input.at) || at()
    const settings = await readSettings()
    const rows = await repo.find('promoterWithdrawals', {
      status: { $in: [WITHDRAW_STATUS.APPROVED, WITHDRAW_STATUS.PAYING] },
      payoutDeadlineAt: { $lt: current }
    }, { sort: { payoutDeadlineAt: 1 }, limit: 500 })
    const { start } = dayRange(current)
    let reminded = 0
    let skipped = 0
    const items = []
    for (const w of rows) {
      if ((Number(w.payoutTimeoutRemindedAt) || 0) >= start) {
        skipped += 1
        continue
      }
      const hours = Math.round(((current - Number(w.payoutDeadlineAt)) / HOUR_MS) * 10) / 10
      await repo.updateWhere('promoterWithdrawals', { id: w.id }, {
        payoutTimeoutRemindedAt: current,
        payoutTimeoutCount: (Number(w.payoutTimeoutCount) || 0) + 1,
        updatedAt: current
      })
      await appendAudit(repo, {
        actorType: 'system',
        actorId: 'promote',
        action: 'promote.payout.timeout',
        target: w.id,
        reason: `超时未回填 · status=${w.status} · net=${round2(w.net)} · overdue=${hours}h`,
        at: current
      })
      await notifyUser(
        w.uid,
        '提现处理进度提醒',
        `你的 ¥${round2(w.net).toFixed(2)} 提现已超过承诺的 ${settings.payoutTimeoutHours} 小时处理时限，平台已加急核对，请耐心等待。`,
        'withdraw',
        w.id
      )
      reminded += 1
      items.push({
        id: w.id,
        uid: w.uid,
        net: round2(w.net),
        status: w.status,
        claimedBy: w.claimedBy || '',
        payoutDeadlineAt: Number(w.payoutDeadlineAt),
        overdueHours: hours
      })
    }
    return { timeoutHours: Number(settings.payoutTimeoutHours), scanned: rows.length, reminded, skipped, items }
  }

  return {
    /* 兼容 server/index.js 的既有调用 */
    createCommission,
    reverseCommission,
    settlePending,
    appleSettle,
    runDaily,
    /* 定时任务（server/index.js · PROMOTE_JOBS） */
    compensateCommissions,
    buildSplitCompletionList,
    remindPayoutTimeout,
    warnExpiringCommissions,
    readSettings,
    /* 用户端 */
    bindOnLogin,
    openPromoter,
    agreementInfo,
    summary,
    listCommissions,
    listWithdrawals,
    withdrawApply,
    withdrawCancel,
    /* 管理端：审核 */
    withdrawApprove,
    withdrawReject,
    /* 管理端：人工出款 */
    payoutList,
    payoutItems,
    payoutClaim,
    payoutExport,
    payoutMark,
    payoutCancel,
    createPayoutPlan,
    /* 管理端：账本 / 设置 */
    reconcile,
    createPaymentCommissions,
    adminOverview,
    adminPromoterDetail,
    adminCommissions,
    adminWithdrawals,
    adminStats,
    saveSettings,
    setPromoterStatus
  }
}

function createPromoteUserHandlers(deps) {
  const engine = createPromoteEngine(deps)
  return {
    'promote.summary': async (data, ctx) => engine.summary(ctx.openid),
    'promote.agreement': async () => engine.agreementInfo(),
    'promote.open': async (data, ctx) => engine.openPromoter(ctx.openid, data),
    'promote.bind': async (data, ctx) => engine.bindOnLogin(ctx.openid, data && data.ref, 'manual'),
    'promote.commissions': async (data, ctx) => engine.listCommissions(ctx.openid, data),
    'promote.withdrawals': async (data, ctx) => engine.listWithdrawals(ctx.openid, data),
    'promote.withdraw': async (data, ctx) => engine.withdrawApply(ctx.openid, data),
    'promote.withdrawCancel': async (data, ctx) => engine.withdrawCancel(ctx.openid, data)
  }
}

function createPromoteAdminHandlers(deps) {
  const engine = createPromoteEngine(deps)
  return {
    'promote.list': async (data) => engine.adminOverview(data),
    'promote.detail': async (data) => engine.adminPromoterDetail(data),
    'promote.commissions': async (data) => engine.adminCommissions(data),
    'promote.withdrawList': async (data) => engine.adminWithdrawals(data),
    'promote.stats': async () => engine.adminStats(),
    'promote.settings': async () => engine.readSettings(),
    'promote.saveSettings': async (data, ctx) => engine.saveSettings(data, ctx.accountId),
    'promote.setStatus': async (data, ctx) => engine.setPromoterStatus(data, ctx.accountId),
    'promote.withdrawApprove': async (data, ctx) => engine.withdrawApprove(data, ctx.accountId),
    'promote.withdrawReject': async (data, ctx) => engine.withdrawReject(data, ctx.accountId),
    'promote.payoutList': async (data) => engine.payoutList(data),
    'promote.payoutItems': async (data) => engine.payoutItems(data),
    'promote.payoutClaim': async (data, ctx) => engine.payoutClaim(data, ctx.accountId),
    'promote.payoutExport': async (data) => engine.payoutExport(data),
    'promote.payoutMark': async (data, ctx) => engine.payoutMark(data, ctx.accountId),
    'promote.payoutCancel': async (data, ctx) => engine.payoutCancel(data, ctx.accountId),
    'promote.reverseCommission': async (data, ctx) => engine.reverseCommission(Object.assign({}, data, {
      actorType: 'staff',
      actorId: ctx.accountId
    })),
    'promote.reconcile': async (data) => engine.reconcile(data),
    'promote.appleSettle': async (data, ctx) => engine.appleSettle(Object.assign({}, data, { actor: ctx.accountId })),
    'promote.runSettle': async () => engine.runDaily()
  }
}

module.exports = {
  AGREEMENT_VERSION,
  AGREEMENT_TITLE,
  AGREEMENT_TEXT,
  PROMOTE_RATE_MIN,
  PROMOTE_RATE_MAX,
  PROMOTE_RATE_DEFAULT,
  PROMOTE_L2_RATE_DEFAULT,
  WITHDRAW_FEE_RATE,
  WITHDRAW_MIN,
  WITHDRAW_MAX,
  WITHDRAW_DAILY_MAX,
  WITHDRAW_DAILY_COUNT,
  COMMISSION_STATUS,
  WITHDRAW_STATUS,
  PAYOUT_ITEM_STATUS,
  WITHDRAW_ACTIVE,
  WITHDRAW_OCCUPYING,
  DEFAULT_SETTINGS,
  createPromoteEngine,
  createPromoteUserHandlers,
  createPromoteAdminHandlers,
  refCodeOf,
  rateText,
  taxOf,
  channelFeeRate,
  eligibleAtOf,
  allocateNetCents
}
