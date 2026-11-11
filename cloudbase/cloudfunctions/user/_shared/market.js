'use strict'

/**
 * 交易服务域：代采 / 代售委托、现货盘、粘贴报价、资讯、商机权限。
 *
 * 口径（与小程序端 home / publish / biz 页面保持一致）：
 * 1. 代采 / 代售：用户提交委托（必填截止时间）→ 平台审核通过即上架 → 平台发起成交、委托方确认
 *    → 生成后付费服务费账单（打款后 3 个工作日内到账）；到截止时间仍未成交则自动关闭。
 *    发布、审核、上架均不前置收费。
 * 2. 现货盘：平台在售商品与用户粘贴的报价按「品类 + 型号 + 城市」聚合，
 *    买价取最高预算、卖价取最低报价；用户粘贴的报价视为卖方报价，24 小时有效。
 * 3. 资讯：官方资讯与用户投稿都发布即展示，不审核；违规时由平台下架并告知原因。
 * 4. 商机：已开通（99 元 / 月）且库存匹配的用户可领取需求 / 联系代采代售委托方。
 *    用户可以直接在标题、说明、备注、材料名称里填写手机号或微信号，平台不拦截、不删除；
 *    只有「公开主体」的发布内容会进入商机池。
 */

const { AppError, CODES } = require('./errors')
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
  LEAD_STATUS,
  TIERS
} = require('./constants')

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 领取口径：不设名额上限，商机会员都可以领取。
 * 仍保留「已领取人数」用于展示与去重，避免同一用户重复领取。
 */
function claimMetaOf(opts) {
  const used = Number(opts && opts.claimCount) || 0
  return {
    claimCount: used,
    claimLimit: 0,
    claimRemaining: 0,
    claimText: used > 0 ? `已有 ${used} 家领取` : ''
  }
}

/**
 * 代采 / 代购（buy）：待审核 → 已上架 → 待确认成交 → 已成交 → 已完成；审核不通过驳回。
 * 代售（sell）：待审核 → 已上架 → 待确认成交 → 已成交 → 已完成；资料不合格驳回。
 * 发布、审核、上架均不前置收费；成交由平台发起、委托方确认，确认后生成后付费服务费账单，
 * 「已完成」由委托方确认收货后结束。到截止时间仍未成交的委托自动关闭。
 */
const AGENCY_STATUS = Object.freeze({
  REVIEW: '待审核',
  PENDING: '待确认',
  APPROVED: '已通过',
  ACTIVE: '已上架',
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
  AGENCY_STATUS.DEAL_PENDING,
  AGENCY_STATUS.DEALT,
  AGENCY_STATUS.DONE,
  AGENCY_STATUS.CLOSED,
  AGENCY_STATUS.REJECTED
])
/* 代采 / 代售同时进行的委托：待审核、待确认、已通过、已上架都占用名额 */
const AGENCY_OPEN_STATUSES = Object.freeze([
  AGENCY_STATUS.REVIEW,
  AGENCY_STATUS.PENDING,
  AGENCY_STATUS.APPROVED,
  AGENCY_STATUS.ACTIVE
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
        ? '提交采购意向函、委托授权书、联系人身份证，平台核验后上架；订单只对平台可见；成交后支付 0.5% 服务费'
        : '提交营业执照、货源证明、委托授权书、联系人身份证，平台核验后上架；成交后支付 0.5% 服务费'
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
 * 商机提示力度：把「品牌 / 型号 / 数量 / 容量」四个维度做成可调档位，
 * 用户可以在商机页设置自己接单的口径，避免过松（一堆不相关）或过严（漏掉能做的单）。
 *
 * 预设三档（用户可在此基础上单独微调任一维度）：
 * - 宽松 loose   ：同系列即可、数量与容量都不限（「只要是 B300 都要，少一点也行」）
 * - 标准 standard：同核心型号、数量达到起订量、容量相同（默认，与历史口径一致）
 * - 严格 strict  ：指定品牌、型号完全一致、库存量要覆盖需求量、容量相同（「只要超微且量要比需求大」）
 *
 * 维度取值：
 * - brand: any 不限品牌 / same 只接指定品牌
 * - model: series 同系列 / core 同核心型号 / exact 型号完全一致
 * - qty  : any 数量不限 / meet 达到起订量 / exceed 库存量需覆盖需求量
 * - cap  : any 容量不限 / same 容量相同 / fit 容量不低于需求（可接受容量更大的货）
 */
const BIZ_PREF_PRESETS = Object.freeze({
  loose: Object.freeze({ level: 'loose', brand: 'any', model: 'series', qty: 'any', cap: 'any' }),
  standard: Object.freeze({ level: 'standard', brand: 'any', model: 'core', qty: 'meet', cap: 'same' }),
  strict: Object.freeze({ level: 'strict', brand: 'same', model: 'exact', qty: 'exceed', cap: 'same' })
})
const BIZ_PREF_DEFAULT = BIZ_PREF_PRESETS.standard
const BIZ_PREF_ENUMS = Object.freeze({
  brand: ['any', 'same'],
  model: ['series', 'core', 'exact'],
  qty: ['any', 'meet', 'exceed'],
  cap: ['any', 'same', 'fit']
})

function bizPrefPick(value, options, fallback) {
  const v = String(value == null ? '' : value).trim()
  return options.indexOf(v) >= 0 ? v : fallback
}

function bizPrefSame(a, b) {
  return a.brand === b.brand && a.model === b.model && a.qty === b.qty && a.cap === b.cap
}

/** 归一化提示力度：命中预设直接返回预设，否则按维度裁剪成自定义档（缺省回落到标准） */
function normalizeBizPrefs(input) {
  const src = input && typeof input === 'object' ? input : null
  if (!src) return Object.assign({}, BIZ_PREF_DEFAULT)
  const level = String(src.level == null ? '' : src.level).trim()
  if (level && BIZ_PREF_PRESETS[level]) return Object.assign({}, BIZ_PREF_PRESETS[level])
  const out = {
    level: 'custom',
    brand: bizPrefPick(src.brand, BIZ_PREF_ENUMS.brand, BIZ_PREF_DEFAULT.brand),
    model: bizPrefPick(src.model, BIZ_PREF_ENUMS.model, BIZ_PREF_DEFAULT.model),
    qty: bizPrefPick(src.qty, BIZ_PREF_ENUMS.qty, BIZ_PREF_DEFAULT.qty),
    cap: bizPrefPick(src.cap, BIZ_PREF_ENUMS.cap, BIZ_PREF_DEFAULT.cap)
  }
  for (const key of Object.keys(BIZ_PREF_PRESETS)) {
    const preset = BIZ_PREF_PRESETS[key]
    if (bizPrefSame(out, preset)) return Object.assign({}, preset)
  }
  return out
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
 * 库存匹配：按「设备类型 + 核心型号 + 新二手 + 起订量」筛选，品牌与城市不参与。
 *
 * 1. 设备类型是硬条件：需求写明了设备类型，就不跨类型匹配
 *    （B300 整机不会被 B300 内存条或其它品类命中）；
 * 2. 型号按核心型号比对：B300 只要核心是 B300，超微 / 戴尔 / 超聚变 / NVIDIA 都可以，
 *    客户不需要知道具体型号；双方都写了显存容量且不同才算不同规格；
 * 3. 型号文本对不上但系列相同时（如「B300 系列」下不同写法）视为同族，容量冲突时仍然排除；
 * 4. 新二手：需求填了成色才比对，全新只配全新，二手可配二手 / 拆机件 / 翻新；
 * 5. 起订量：库存可用量要达到起订量，且对方需求量不能小于起订量，否则这单做不成。
 * 没有对应库存、库存低于起订量、或需求量小于起订量时直接不命中，
 * 不会给商家推送自己无法满足的商机，也不会给买家看到自己起订量接不下的货源。
 *
 * brand     : 保留参数位，品牌默认不限（客户要 B300 时不限定厂商）
 * opts.qty  : 对方需要的数量（用于起订量校验与展示文案）
 * opts.cond : 对方要求的成色（全新 / 二手，「不限」视为未填）
 * opts.series: 对方选择的系列（可选，用于同族兜底）
 */
function stockMatch(stocks, cat, model, brand, opts) {
  const need = opts || {}
  const needQty = Number(need.qty) || 0
  const needCond = condFamily(need.cond)
  const needSeries = String(need.series || '').trim() || catalogSeriesOf(cat, model)
  const needCap = model ? capacityOf(model) : ''
  const needCapGb = model ? capacityGbOf(model) : 0
  const needBrand = String(brand == null ? '' : brand).trim().toLowerCase()
  /* 提示力度：未设置时按「标准」档，保证与历史口径一致 */
  const pref = normalizeBizPrefs(need.pref)
  const matched = []
  for (const stock of stocks || []) {
    /* 设备类型硬校验：有型号也不能跨品类命中 */
    if (cat && stock.cat && stock.cat !== cat) continue
    /* 品牌档位：只接指定品牌时，双方都写了品牌才比对 */
    if (pref.brand === 'same' && needBrand && stock.brand) {
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
      } else if (pref.model === 'series') {
        /* 宽松档：同核心型号或同系列即可，容量交给容量档位判断 */
        if (!modelMatch(stock.model, model) && !seriesHit) continue
      } else if (!modelMatch(stock.model, model) && !(seriesHit && capOk && !coreComparable)) {
        continue
      }
      /* 容量档位：同容量 / 不低于 / 不限（4T 需求接受 3T 时把容量调成「不限」） */
      if (!bizCapAllowed(pref.cap, needCapGb, stockCapGb)) continue
    } else if (!cat) {
      /* 设备类型与型号都没填，无法判断是否匹配，直接跳过 */
      continue
    }
    if (needCond && stock.cond && condFamily(stock.cond) !== needCond) continue
    /* 可用量低于起订量＝这单发不出去，不算有货 */
    if ((Number(stock.qty) || 0) < moqOf(stock)) continue
    if (pref.qty === 'exceed') {
      /* 严格档：库存可用量必须覆盖对方需求量 */
      if (needQty > 0 && (Number(stock.qty) || 0) < needQty) continue
    } else if (pref.qty === 'meet') {
      /* 标准档：对方需求量不小于起订量即可 */
      if (needQty > 0 && moqOf(stock) > needQty) continue
    }
    /* 宽松档（any）不校验需求量，少量也提醒 */
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
    text: textOut
  }
}

/** 公开主体集合：只有「公开主体」才会收到 / 发出商机提醒，保证商机里对接双方都公开 */
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
 * 1. 只有公开主体的发布内容才进入商机池，也只有公开主体的会员才会收到提醒；
 * 2. 每个匹配到的会员各收到一条（B/C/D 都有货就分别提醒 B/C/D）；
 * 3. 需求发布方只在「商机池里有对应商品」时才收到汇总提醒；对方仅有库存、没在商机池
 *    发布对应商品时，只提醒库存方本人，绝不把库存方告知需求方，也不拿库存当商机派给需求方；
 * 4. 商机被领取时不发提醒，只有对方主动发起对话才会产生聊天消息；
 * 5. 站内信 id 由「场景 + 内容 id + 收件人」确定，重复发布 / 领取不会重复打扰。
 */
async function notifyNewBizMatch(repo, subscribe, options) {
  const opts = options || {}
  const doc = opts.doc
  const kind = opts.kind === 'product' ? 'product' : 'demand'
  const at = Number(opts.at) || Date.now()
  const publisher = String((doc && doc.ownerId) || '')
  if (!repo || !doc || !doc.id || !publisher) return { matched: 0, notified: 0 }

  const openPublishers = await openSubjectSet(repo, [publisher])
  if (!openPublishers.has(publisher)) return { matched: 0, notified: 0 }
  /* 只有开通了商机会员的发布者才需要汇总提醒 */
  const publisherAccess = accessView(await repo.get('bizAccess', publisher), at)

  const title = String(doc.title || doc.model || '商机')
  /* 新需求：匹配「商机池里的在售商品」+「本人库存」；新货源：匹配商机池里的求购需求。
     库存行打标 __bizSource=stock：只用于提醒库存方本人，不参与需求发布方的汇总。 */
  let rows = []
  if (kind === 'demand') {
    const products = await repo.find('products', {
      status: '在售',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      bizPool: true,
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 200 })
    const stocks = await repo.find('stocks', { status: '在售', deleted: { $ne: true } }, { limit: 200 })
    rows = products.map((row) => Object.assign({}, row, { __bizSource: 'product' }))
      .concat(stocks.map((row) => Object.assign({}, row, { __bizSource: 'stock' })))
  } else {
    rows = await repo.find('demands', {
      status: '求购中',
      visibility: { $ne: VISIBILITIES.PRIVATE },
      bizPool: true,
      deleted: { $ne: true }
    }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 200 })
  }

  const candidates = (rows || []).filter((row) => row.ownerId && row.ownerId !== publisher)
  if (!candidates.length) return { matched: 0, notified: 0 }
  const openOwners = await openSubjectSet(repo, candidates.map((row) => row.ownerId))

  /* 按对方主体聚合：一个会员有多条库存 / 需求也只提醒一次 */
  const byOwner = new Map()
  for (const row of candidates) {
    if (!openOwners.has(row.ownerId)) continue
    if (!byOwner.has(row.ownerId)) byOwner.set(row.ownerId, [])
    byOwner.get(row.ownerId).push(row)
  }

  let matchedOwners = 0
  /* 仅统计「商机池商品」命中的会员：需求发布方的汇总提醒只认这一种来源 */
  let matchedProductOwners = 0
  let notified = 0
  for (const [ownerId, ownerRows] of byOwner) {
    /* 没开通商机会员的会员看不到商机详情，不做无效提醒 */
    const ownerAccess = accessView(await repo.get('bizAccess', ownerId), at)
    if (!ownerAccess.unlocked) continue
    const prefRow = await repo.get('bizPrefs', ownerId)
    const pref = normalizeBizPrefs(prefRow)
    let hit = false
    let hitProduct = false
    if (kind === 'demand') {
      for (const row of ownerRows) {
        const rowHit = stockMatch([row], doc.cat, doc.model, doc.brand, {
          qty: doc.qty, cond: doc.cond, series: doc.series, pref
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
          qty: demandRow.qty, cond: demandRow.cond, series: demandRow.series, pref
        }).ok
        if (rowHit) { hit = true; break }
      }
    }
    if (!hit) continue
    matchedOwners += 1
    if (hitProduct) matchedProductOwners += 1
    const body = kind === 'demand'
      ? `「${title}」与你的库存匹配，可在商机页查看`
      : `「${title}」与你的求购需求匹配，可在商机页查看`
    const sent = await pushBizPublishNotice(repo, subscribe, {
      uid: ownerId,
      key: `${kind}:${doc.id}`,
      title: '有新的商机可查看',
      body,
      targetId: doc.id,
      at
    })
    if (sent) notified += 1
  }

  /* 发布者汇总：新需求只统计「商机池商品」匹配，对方仅有库存时不打扰需求方；
     新货源统计求购需求匹配。未开通会员时文案引导开通，会员直接进商机页查看 */
  const publisherMatches = kind === 'demand' ? matchedProductOwners : matchedOwners
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
        page: 'pages/biz/biz',
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

  /* 委托授权书与被委托人身份证一律必传；企业再加营业执照；
     1000 万元及以上按委托方向补采购意向函 / 货源证明 */
  const required = [
    { kind: 'authorization', label: '委托授权书' },
    { kind: 'idcard', label: '被委托人身份证' }
  ].concat(subjectType === 'company' ? [{ kind: 'license', label: '营业执照' }] : [])
  if (largeAmount) {
    required.push(side === 'buy'
      ? { kind: 'loi', label: '采购意向函' }
      : { kind: 'proof', label: '货源证明' })
  }
  const got = new Set(media.map((m) => m.kind))
  const missing = required.filter((m) => !got.has(m.kind)).map((m) => m.label)
  if (missing.length) {
    throw new AppError(CODES.VALIDATION, `请补齐必传材料：${missing.join('、')}`)
  }
  /* 授权书联系人电话必填；与预留手机号是否一致只做标记，交给客服审核时核验，不拦截提交 */
  const authPhoneRaw = str(data.authPhone, { field: '委托授权书上的联系人电话', max: 32 })
  if (!authPhoneRaw) throw new AppError(CODES.VALIDATION, '请填写委托授权书上的联系人电话')
  const authPhone = normalizeContactPhone(authPhoneRaw)
  const authPhoneMatched = authPhone === phone

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
    /* 进入商机池：公开内容才进池，发布方可选择仅普通 / 仅商机 / 二者都发。
       代采 / 代售由平台代为对接、不下发主体联系方式，因此不要求主体必须公开 */
    channel,
    bizPool: visibility === VISIBILITIES.PUBLIC && channel !== PUBLISH_CHANNELS.NORMAL,
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
 * 委托进度时间线：提交 → 审核通过 → 已上架 → 已成交 → 已付款 → 已完成。
 * 驳回 / 关闭 / 到期后不再点亮后续步骤，避免用户误以为仍在推进。
 */
function agencyProgress(d) {
  const st = d || {}
  const stopped = st.status === AGENCY_STATUS.CLOSED || st.status === AGENCY_STATUS.REJECTED
  const steps = [
    { key: 'submit', label: '已提交', at: Number(st.createdAt) || 0 },
    { key: 'review', label: '审核通过', at: Number(st.approvedAt) || 0 },
    { key: 'online', label: '已上架', at: Number(st.confirmedAt) || 0 },
    { key: 'dealt', label: '已成交', at: Number(st.dealConfirmedAt) || 0 },
    { key: 'paid', label: '已付款', at: Number(st.feePaidAt) || 0 },
    { key: 'received', label: '已完成', at: Number(st.receiptConfirmedAt) || 0 }
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
  [AGENCY_STATUS.DEAL_PENDING]: '待确认成交',
  [AGENCY_STATUS.DEALT]: '已成交 · 待确认收货',
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
  push('待确认成交', st.dealProposedAt, st.dealProposedBy)
  push('已成交', st.dealConfirmedAt, '')
  push('已付款', st.feePaidAt, st.feePaidBy)
  push('已完成', st.receiptConfirmedAt, '')
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
  /* 账单号由委托单固定派生：并发确认成交 / 重复点击时，唯一索引保证只生成一张账单 */
  const billId = `PY_AG_${d.id}`
  const bizType = d.rental ? '租赁服务费' : (d.side === 'buy' ? '代采服务费' : '代售服务费')
  let bill = await repo.get('payments', billId)
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
    /* 进度时间线：我的委托里直接展示到「确认收货」，无需再联系客服收尾 */
    progress: agencyProgress(d),
    /* 流程节点：详情页展示处理节点、时间和处理人；列表页只取商品字段 */
    flowNodes: agencyFlowNodes(d),
    dealAmount: Number(d.dealAmount) || 0,
    dealAmountText: d.dealAmount
      ? (d.currencySymbol || '¥') + Number(d.dealAmount).toLocaleString('zh-CN')
      : '',
    /* 成交两步确认：平台发起成交 → 委托方确认后才算成交 */
    dealProposedAt: Number(d.dealProposedAt) || 0,
    dealProposedAtText: d.dealProposedAt ? dateTimeText(d.dealProposedAt) : '',
    dealProposedBy: d.dealProposedBy || '',
    dealConfirmedAt: Number(d.dealConfirmedAt) || 0,
    dealConfirmedAtText: d.dealConfirmedAt ? dateTimeText(d.dealConfirmedAt) : '',
    canConfirmDeal: d.status === AGENCY_STATUS.DEAL_PENDING,
    completedText: d.completedAt ? dateText(d.completedAt) : '',
    receiptText: d.receiptConfirmedAt ? dateText(d.receiptConfirmedAt) : '',
    /* 委托成交确认后由委托方确认收货，确认后结束（已完成） */
    canConfirmReceipt: d.status === AGENCY_STATUS.DEALT && !d.receiptConfirmedAt,
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
    payHint: '提交后进入平台审核，审核通过即上架；成交确认后再支付服务费'
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
    /* 成交与收货：平台发起成交 → 委托方确认成交 → 生成服务费账单 */
    completedAt: Number(doc.completedAt) || 0,
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
  QUOTE: 'quote'
})

/* 样本权重：代采（真实预算）> 代售（真实报价）> 平台商品 > 粘贴报价 */
const PRICE_WEIGHT = Object.freeze({
  product: 3,
  agencyBuy: 3.5,
  agencySell: 3,
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
  const quotes = samples.filter((s) => s.source === PRICE_SOURCE.QUOTE)

  const anchor = weightedMedian(products)
  const agency = weightedMean(agencySamples)
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
      quotes: quotes.length
    }
  }
}

function boardItems({ products, agencies, quotes, now, limit }) {
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
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  OFFLINE: '已下架'
})
const NEWS_STATUS_LIST = Object.freeze([NEWS_STATUS.PENDING, NEWS_STATUS.PUBLISHED, NEWS_STATUS.REJECTED, NEWS_STATUS.OFFLINE])
const NEWS_OFFICIAL_CATS = Object.freeze(['平台公告', '行情解读', '行业资讯'])
const NEWS_USER_CAT = '用户发布'

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
    city,
    cat,
    visibility,
    summary: content.replace(/\s+/g, ' ').slice(0, 120)
  }
}

function newsView(doc, at) {
  const d = doc || {}
  const isPrivate = d.visibility === VISIBILITIES.PRIVATE
  const base = {
    id: d.id,
    official: isPrivate ? false : d.official === true,
    cat: d.cat || '',
    title: d.title || '',
    summary: d.summary || '',
    city: d.city || '',
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
const PAYMENT_METHODS = Object.freeze(['企业微信', '微信转账', '对公转账', '支付宝', '现金', '其他'])

function accessView(access, now) {
  const a = access || null
  const expireAt = Number(a && a.expireAt) || 0
  const status = bizStatusOf(a, now)
  return {
    status,
    unlocked: status === BIZ_STATUS.ACTIVE,
    plan: BIZ_PLAN,
    expireAt,
    expireText: expireAt ? `${dateText(expireAt)} 到期` : '未开通',
    daysLeft: expireAt ? Math.max(0, Math.ceil((expireAt - now) / DAY_MS)) : 0,
    appliedAt: Number(a && a.appliedAt) || 0,
    appliedText: a && a.appliedAt ? dateText(a.appliedAt) : ''
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

  /** 商机池主体信息：按主体 id 集合共享，避免每个会员各扫一遍 profiles */
  async function sharedPoolProfiles(ownerIds) {
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    if (!ids.length) return new Map()
    const name = 'profiles:' + sha256Hex(ids.slice().sort().join(',')).slice(0, 16)
    const rows = await sharedPool(name, 30, async () => Array.from((await poolProfiles(ids)).values()))
    return new Map(rows.map((row) => [row.uid || row.id, row]))
  }

  async function mustUser(ctx) {
    const user = await repo.get('users', ctx.openid)
    if (!user) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
    /* 与管理端停用口径一致：停用后立即失去交易 / 发布能力 */
    if (user.status === '停用') throw new AppError(CODES.FORBIDDEN, '账号已停用，请联系平台客服')
    return user
  }

  /** 站内信：委托成交等节点回执给用户，小程序「消息」可见 */
  async function sendUserNotice(uid, payload, at) {
    if (!uid) return
    await repo.insert('outbox', {
      id: randomId('M'),
      type: 'system.notice',
      payload: Object.assign({
        uid,
        channel: 'system',
        from: 'system',
        reason: '',
        targetType: 'agency',
        targetId: ''
      }, payload),
      status: 'pending',
      createdAt: at
    })
    if (subscribe) {
      await subscribe.system(uid, { title: payload.title, body: payload.body, at }).catch(() => {})
    }
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
   * 商机池主体口径：只有「已公开主体信息」的发布者，其商品 / 需求才进入别人的商机池。
   * 个人信息为「不公开主体」或从未填写时，发布内容只走普通浏览，不参与商机匹配，
   * 避免匿名主体被推到同行面前造成骚扰。
   */
  async function poolProfiles(ownerIds) {
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    const map = new Map()
    if (!ids.length) return map
    const rows = await repo.find('profiles', { uid: { $in: ids } }, { limit: ids.length })
    for (const row of rows) {
      const exposure = String((row && row.exposure) || '').trim()
      /* 历史 matched 视同 hidden：只有明确「公开主体」才进商机池 */
      if (exposure !== EXPOSURES.OPEN) continue
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
      city: demand.city || '',
      price: budget,
      priceLabel: rental ? '租金预算' : '采购预算',
      priceText: budget > 0 ? `¥${moneyText(budget)} / 台${rental ? ' / 月' : ''}` : '面议',
      matched: o.matched === true,
      stockText: o.stockText || '',
      stockQty: Number(o.stockQty) || 0,
      claimed: o.claimed === true,
      /* 已领取但发布方已关闭 / 已下架：仍保留在「已领取」里供回看 */
      closed: o.closed === true,
      statusText: o.statusText || '',
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      org: o.org || '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
      claimText: claim.claimText,
      /* 用户标记「不满足」：仍留在列表里，但不计入可领取与角标提醒 */
      unsatisfied: o.unsatisfied === true,
      /* 领取后可逐项确认必须条件，再在平台内发起对话 */
      must: Array.isArray(demand.must) ? demand.must : [],
      published: relTime(demand.createdAt, o.now || now()),
      /* 列表统一按发布时间倒序：越晚发布越靠前 */
      at: Number(demand.createdAt) || 0,
      expireText: '长期有效'
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
      city: product.city || '',
      price,
      priceLabel: rental ? '月租金' : '出售单价',
      priceText: price > 0 ? `¥${moneyText(price)} / 台${rental ? ' / 月' : ''}` : '面议',
      matched: true,
      stockText: o.stockText || '',
      stockQty: Number(o.stockQty) || 0,
      demandText: o.demandText || '',
      claimed: o.claimed === true,
      closed: o.closed === true,
      statusText: o.statusText || '',
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      org: o.org || '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
      claimText: claim.claimText,
      /* 用户标记「不满足」：仍留在列表里，但不计入可领取与角标提醒 */
      unsatisfied: o.unsatisfied === true,
      must: Array.isArray(product.must) ? product.must : [],
      published: relTime(product.createdAt, o.now || now()),
      /* 列表统一按发布时间倒序：越晚发布越靠前 */
      at: Number(product.createdAt) || 0,
      expireText: '长期有效'
    }
  }

  function agencyViewOf(doc, opts) {
    const o = opts || {}
    const claim = claimMetaOf(o)
    return {
      id: doc.id,
      agencyId: doc.id,
      type: 'agency',
      kind: doc.kind,
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
      claimed: o.claimed === true,
      contactVisible: o.contactVisible === true,
      canClaim: o.canClaim === true,
      /* 代采 / 代售统一由平台对接：用户提交对接申请后生成客服工单 */
      canConsult: o.canConsult === true,
      consulted: o.consulted === true,
      consultText: o.consulted ? '已提交 · 待平台核实' : '联系平台',
      org: o.org || doc.subjectMasked || '',
      contact: o.contact || '',
      phone: o.phone || '',
      claimCount: claim.claimCount,
      claimLimit: claim.claimLimit,
      claimRemaining: claim.claimRemaining,
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
        /* 授权书联系人电话不落库，只保存与预留手机号是否一致：一致时回填预留号 */
        authPhone: doc.authPhoneMatched === true ? phone : ''
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
            ? '委托审核已通过，平台正在联系你，如需停止请联系客服'
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
     * 委托方确认成交：平台发起成交后由委托方确认，确认后才算成交并生成后付费服务费账单。
     * 重复调用保持幂等，已成交时直接返回当前详情。
     */
    'agency.dealConfirm': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能确认自己的委托')
      if (doc.status === AGENCY_STATUS.DEALT || doc.status === AGENCY_STATUS.DONE) {
        return agencyOwnerView(doc, at)
      }
      if (doc.status !== AGENCY_STATUS.DEAL_PENDING) {
        throw new AppError(CODES.CONFLICT, '该委托不在待确认成交状态，请刷新后查看')
      }
      const res = await repo.updateWhere('agencies', {
        id,
        ownerId: uid,
        status: AGENCY_STATUS.DEAL_PENDING
      }, {
        status: AGENCY_STATUS.DEALT,
        dealt: true,
        dealtAt: at,
        dealConfirmedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'agency.dealConfirm',
        target: id,
        reason: '委托方确认成交',
        result: 'allow',
        at
      })
      /* 成交确认后生成服务费账单：优先按委托方已上报的打款时间 + 3 个工作日 */
      let fresh = await repo.get('agencies', id)
      if (fresh) fresh = await ensureAgencyFeeBill(repo, fresh, at)
      if (fresh && Number(fresh.feeDueAt) > 0) {
        await sendUserNotice(fresh.ownerId, {
          title: `${fresh.kind || '委托'}服务费待支付`,
          body: `服务费 ¥${Number(fresh.serviceFee || 0)} 应于 ${dateText(fresh.feeDueAt)} 前到账，可在「我的缴费」查看。`,
          targetId: fresh.id
        }, at)
      }
      return agencyOwnerView(fresh || doc, at)
    },

    /** 用户确认收货：成交后由委托方确认，委托状态归档为「已完成」 */
    'agency.receipt': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const at = now()
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能确认自己的委托')
      if (doc.status === AGENCY_STATUS.DONE) throw new AppError(CODES.CONFLICT, '该委托已确认收货，无需重复操作')
      if (doc.status !== AGENCY_STATUS.DEALT) throw new AppError(CODES.CONFLICT, '委托成交后才能确认收货')
      const res = await repo.updateWhere('agencies', {
        id,
        ownerId: uid,
        status: AGENCY_STATUS.DEALT
      }, {
        status: AGENCY_STATUS.DONE,
        receiptConfirmedAt: at,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'user',
        actorId: uid,
        action: 'agency.receipt',
        target: id,
        reason: '委托方确认收货',
        result: 'allow',
        at
      })
      const fresh = await repo.get('agencies', id)
      return agencyOwnerView(fresh || doc, at)
    },

    /** 现货盘：平台在售商品 + 24h 内有效报价，脱敏聚合；代采 / 代售只在商机池展示 */
    'agency.board': async (data) => {
      const at = now()
      const limit = Math.min(50, Math.max(1, Number(data.limit) || 30))
      /* 私密发布＝匿名公开：商品照常计入货盘，脱敏聚合不暴露发布者 */
      const products = await repo.find('products', {
        status: '在售',
        channel: { $ne: PUBLISH_CHANNELS.POOL },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 300 })
      const quotes = await repo.find('quotes', {
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 })
      return { items: boardItems({ products, agencies: [], quotes, now: at, limit }) }
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
        if (!Number.isFinite(price) || price < 0 || price > 999999999) {
          throw new AppError(CODES.VALIDATION, '报价需为 0 - 999999999 的数字')
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
    'news.list': async (data) => {
      const at = now()
      const scope = enumOf(data.scope || 'all', ['all', 'city', 'pick'], '资讯范围')
      const query = { status: NEWS_STATUS.PUBLISHED, deleted: { $ne: true } }
      if (scope === 'pick') query.official = true
      if (scope === 'city') {
        const city = str(data.city, { field: '城市', max: 20 })
        if (!city) return { items: [], scope, city: '' }
        query.city = city
      }
      const rows = await repo.find('news', query, {
        sort: { field: 'publishedAt', dir: 'desc' },
        limit: 50
      })
      return {
        items: rows.map((row) => Object.assign(newsView(row), {
          published: relTime(row.publishedAt || row.createdAt, at),
          /* 作者主页入口：与 news.detail / owner.home 同口径；私密与官方资讯不下发 */
          authorKey: row.visibility === VISIBILITIES.PRIVATE || row.official === true || !row.uid ? '' : authorKeyOf(row.uid)
        })),
        scope
      }
    },

    /** 用户投稿：不做人工审核，提交时自动筛查违禁词，通过即发布；正文不得夹带联系方式 */
    'news.submit': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
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
      const views = (Number(row.views) || 0) + 1
      try {
        await repo.updateWhere('news', { id }, { views })
      } catch (viewErr) {
        /* 浏览量只用于展示，写入失败不影响阅读 */
      }
      const at = now()
      const uid = ctx && ctx.openid
      const like = uid ? await repo.get('newsLikes', newsLikeId(uid, id)) : null
      const liked = !!(like && like.deleted !== true)
      const [likes, commentCount] = await Promise.all([
        repo.count('newsLikes', { newsId: id, deleted: { $ne: true } }),
        repo.count('newsComments', { newsId: id, deleted: { $ne: true } })
      ])
      const isPrivate = row.visibility === VISIBILITIES.PRIVATE
      return Object.assign(newsView(Object.assign({}, row, { views }), at), {
        content: row.content || '',
        publishedText: dateText(row.publishedAt || row.createdAt),
        /* 官方资讯没有作者主页；私密资讯匿名；用户投稿返回与 owner.home 同口径的作者键 */
        authorKey: isPrivate || row.official === true || !row.uid ? '' : authorKeyOf(row.uid),
        likes,
        liked,
        commentCount
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
      const page = Math.max(1, Number(data.page) || 1)
      const limit = Math.min(50, Math.max(1, Number(data.limit) || 20))
      const at = now()
      const uid = ctx && ctx.openid
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
        hasMore: roots.length >= limit
      }
    },

    /** 发表评论 / 回复：内容过滤敏感联系方式后落库，回复只允许挂在同一篇资讯下 */
    'news.comment.add': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
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
      return { id, deleted: true }
    },

    /** 我的评论：我发的评论 + 收到的回复，按最新互动排序 */
    'news.comment.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
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
      const read = await repo.get('commentReads', uid)
      const readAt = Number(read && read.readAt) || 0
      return { replies: await unreadReplyCount(repo, uid, readAt) }
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

    'biz.apply': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const access = await ownAccess(uid)
      const view = accessView(access, at)
      if (view.unlocked) throw new AppError(CODES.CONFLICT, '商机权限已开通，无需重复申请')
      if (view.status === BIZ_STATUS.PENDING) {
        return Object.assign(view, { hint: '申请已提交，客服确认收款后开通' })
      }
      const doc = {
        id: uid,
        uid,
        status: BIZ_STATUS.PENDING,
        plan: BIZ_PLAN.price,
        days: BIZ_PLAN.days,
        appliedAt: at,
        updatedAt: at,
        expireAt: 0,
        staff: '',
        note: str(data.note, { field: '备注', max: 200 })
      }
      if (access) {
        await repo.updateWhere('bizAccess', { id: uid }, doc)
      } else {
        await repo.insert('bizAccess', doc)
      }
      return Object.assign(accessView(Object.assign({}, access, doc), at), {
        hint: '申请已提交，请添加企业微信客服支付 99 元 / 月后开通'
      })
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
     * 用户端购买 / 续费：生成「待确认」收款单，客服确认到账后自动累加时长。
     * 同一套餐存在待确认单时直接复用，避免重复支付。
     */
    'biz.purchase': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()
      const plans = await resolvePlans(repo)
      const key = enumOf(data.planKey || data.plan || 'month', plans.map((item) => item.key), '套餐')
      const plan = plans.find((item) => item.key === key)
      const user = await repo.get('users', uid)
      const access = await ownAccess(uid)
      const view = accessView(access, at)
      const pending = await repo.find('payments', {
        uid,
        bizType: '会员续费',
        status: PAYMENT_STATUS.PENDING
      }, { limit: 10 })
      const dup = pending.find((row) => row.planKey === key)
      if (dup) {
        return {
          paymentId: dup.id,
          amount: Number(dup.amount) || plan.price,
          plan,
          access: view,
          hint: '该套餐已提交支付申请，客服确认到账后自动加时长'
        }
      }
      const doc = {
        /* 同一用户同一套餐当天用确定性单号：并发重复点击只有一个请求能建单，
           其余请求命中唯一键后复用已建好的待确认单 */
        id: 'PY' + sha256Hex(`bizPurchase:${uid}:${key}:${Math.floor(at / DAY_MS)}`).slice(0, 22),
        uid,
        nick: user.nick || '',
        bizType: '会员续费',
        planKey: plan.key,
        planLabel: plan.label,
        days: plan.days,
        amount: plan.price,
        discount: plan.saving,
        /* 未支付前不记实收、不记收款时间：待确认单只代表「应收」，
           否则财务对账会把「用户点了一下申请」当成真实到账 */
        received: 0,
        method: '企业微信',
        status: PAYMENT_STATUS.PENDING,
        paidAt: 0,
        voucher: '',
        operator: '用户端',
        accountId: '',
        note: `用户端购买 ${plan.label}（${plan.days} 天）`,
        createdAt: at,
        updatedAt: at
      }
      try {
        await repo.insert('payments', doc)
      } catch (err) {
        if (!err || err.code !== CODES.CONFLICT) throw err
        const again = await repo.find('payments', {
          uid,
          bizType: '会员续费',
          status: PAYMENT_STATUS.PENDING
        }, { limit: 10 })
        const dupAgain = again.find((row) => row.planKey === key)
        if (dupAgain) {
          return {
            paymentId: dupAgain.id,
            amount: Number(dupAgain.amount) || plan.price,
            plan,
            access: view,
            hint: '该套餐已提交支付申请，客服确认到账后自动加时长'
          }
        }
        /* 当天已有确认过的同套餐单：换随机单号继续开新单 */
        doc.id = randomId('PY')
        await repo.insert('payments', doc)
      }
      /* 未开通 / 已到期的用户进入「待确认」，已开通的续费不打断当前权限；
         这里重新读一次权限，避免用旧快照把刚确认到账的会员又覆盖回待确认 */
      if (!accessView(await ownAccess(uid), at).unlocked) {
        const patch = {
          id: uid,
          uid,
          status: BIZ_STATUS.PENDING,
          plan: plan.price,
          planKey: plan.key,
          planLabel: plan.label,
          days: plan.days,
          expireAt: 0,
          appliedAt: (access && access.appliedAt) || at,
          updatedAt: at,
          staff: '',
          note: ''
        }
        if (access) await repo.updateWhere('bizAccess', { id: uid }, patch)
        else {
          try {
            await repo.insert('bizAccess', patch)
          } catch (err) {
            if (!err || err.code !== CODES.CONFLICT) throw err
            /* 并发下单时另一请求已写入待开通记录，覆盖为同一份即可 */
            await repo.updateWhere('bizAccess', { id: uid }, patch)
          }
        }
      }
      return {
        paymentId: doc.id,
        amount: doc.amount,
        plan,
        access: accessView(await ownAccess(uid), at),
        hint: '已提交，客服确认到账后自动加时长'
      }
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
      const claims = await ownClaims(uid)
      /* 用户标记「不满足」的商机：保留在列表的「不满足」分类里，但不再计入可领取与角标 */
      const markRows = await repo.find('bizMarks', { uid, marked: true }, { limit: 500 })
      const markSet = new Set()
      markRows.forEach((row) => {
        if (row && row.targetId) markSet.add(`${row.targetType}:${row.targetId}`)
      })
      /* 我发布的求购需求：只有公开且明确进入商机池的需求才参与反向匹配 */
      const myDemands = await repo.find('demands', {
        ownerId: uid,
        status: '求购中',
        visibility: { $ne: VISIBILITIES.PRIVATE },
        bizPool: true,
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
      /* 本人已提交的对接申请：同一委托只生成一张客服工单，重复点击直接返回原工单 */
      const consultRows = await repo.find('leads', { uid, targetType: 'agency' }, { limit: 200 })
      const consultMap = {}
      consultRows.forEach((row) => {
        if (row.targetId && row.status !== LEAD_STATUS.CLOSED) consultMap[row.targetId] = row.status
      })

      const demandRows = await sharedPool('open-demands', 20, () => repo.find('demands', {
        status: '求购中',
        visibility: { $ne: VISIBILITIES.PRIVATE },
        /* 只有明确选择「仅商机 / 二者都发」的需求进入匹配；普通发布与历史数据一律不入池 */
        bizPool: true,
        deleted: { $ne: true }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 }))

      /* 代采委托一律保密，不进入商机池；保密代售同样不对外展示 */
      const agencyRows = await sharedPool('open-agencies', 20, () => repo.find('agencies', {
        status: AGENCY_STATUS.ACTIVE,
        visibility: { $ne: VISIBILITIES.PRIVATE },
        bizPool: { $ne: false },
        expiresAt: { $gte: at },
        deleted: { $ne: true }
      }, { sort: { field: 'confirmedAt', dir: 'desc' }, limit: 50 }))

      /* 反向商机货源：只取进入商机池的在售商品，且不能是自己的 */
      const productRows = myDemands.length
        ? await sharedPool('pool-products', 20, () => repo.find('products', {
          status: '在售',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          /* 只有明确选择「仅商机 / 二者都发」的货源进入匹配 */
          bizPool: true,
          deleted: { $ne: true }
        }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 }))
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

      /* 商机池主体口径：发布者主体信息必须已公开（非「不公开主体」），内容才进入匹配。
         未开通时也查一次，保证角标 / 条数与会员看到的完全一致；
         解锁后才解密主体名称用于展示 */
      const ownerIds = Array.from(new Set(
        demandRows.filter((d) => d.ownerId !== uid).map((d) => d.ownerId)
          .concat(supplyProducts.map((p) => p.ownerId))
      ))
      const poolProfileMap = await sharedPoolProfiles(ownerIds)
      const profileByUid = {}
      if (unlocked) {
        for (const p of poolProfileMap.values()) {
          if (!p.subjectCipher && !p.subject) continue
          let subject = ''
          try {
            subject = p.subjectCipher
              ? decryptFieldOf({ keys, collection: 'profiles', field: 'subject', recordId: p.uid || p.id, cipher: p.subjectCipher })
              : p.subject
          } catch (err) {
            subject = ''
          }
          profileByUid[p.uid || p.id] = { subject, subjectType: p.subjectType, exposure: p.exposure }
        }
      }

      const demandItems = []
      const agencyItems = []
      const supplyItems = []
      for (const demand of demandRows) {
        if (demand.ownerId === uid) continue
        /* 发布者主体未公开：不进入别人的商机池 */
        if (!poolProfileMap.has(demand.ownerId)) continue
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          city: demand.city,
          cond: demand.cond,
          series: demand.series,
          pref: prefs
        })
        /* 只展示我的库存能对上的需求，其余商机不出现 */
        if (!match.ok) continue
        const claimed = claims.has(`demand:${demand.id}`)
        const unsatisfied = markSet.has(`demand:${demand.id}`)
        const claimCount = claimCountMap[`demand:${demand.id}`] || 0
        /* 联系方式只在「已开通 + 已领取 + 仍匹配」时下发；
           权限到期后已领取记录仍保留，但不继续给联系方式 */
        const readable = claimed && unlocked && match.ok
        const contact = readable ? await contactOfUser(demand.ownerId) : null
        const owner = contact ? null : await repo.get('users', demand.ownerId)
        const pubProfile = profileByUid[demand.ownerId]
        const publicOrg = pubProfile && pubProfile.exposure !== EXPOSURES.HIDDEN
          ? maskSubject(pubProfile.subject, pubProfile.subjectType)
          : ''
        demandItems.push(demandViewOf(demand, {
          now: at,
          matched: true,
          stockText: match.text,
          stockQty: match.qty,
          claimed,
          claimCount,
          /* 领取即解锁联系人区块：对方没留电话时由前端提示改用站内对话，
             不再因为 phone 为空把卡片底部渲染成「一个按钮都没有」的死卡片 */
          contactVisible: !!contact,
          canClaim: unlocked && !claimed && !unsatisfied,
          unsatisfied,
          org: contact ? contact.org : (publicOrg || maskName((owner && owner.nick) || '') || '匿名用户'),
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
        /* 代采 / 代售由平台居中对接，不按个人主体曝光口径过滤 */
        const match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
          qty: agency.qty,
          city: agency.city,
          series: agency.series,
          pref: prefs
        })
        /* 商机池只展示库存能对上的委托，避免无关用户看到 */
        if (!match.ok) continue
        const claimCount = claimCountMap[`agency:${agency.id}`] || 0
        /* 代采 / 代售均由平台代为对接并联系缴费，不开放自助领取，也不下发联系方式 */
        agencyItems.push(agencyViewOf(agency, {
          now: at,
          matched: true,
          stockText: match.text,
          stockQty: match.qty,
          claimed: false,
          claimCount,
          claimLimit: 0,
          contactVisible: false,
          canClaim: false,
          canConsult: unlocked,
          consulted: !!consultMap[agency.id],
          org: agency.subjectMasked,
          contact: '平台代为对接',
          phone: ''
        }))
      }

      /* 反向商机：别人的货源命中了我已发布的需求。
         同一个货源只生成一条商机，按我的需求数量 / 城市 / 成色判断是否满足 */
      for (const product of supplyProducts) {
        /* 货主主体未公开：不进入别人的商机池 */
        if (!poolProfileMap.has(product.ownerId)) continue
        let hit = null
        for (const demand of myDemands) {
          const match = stockMatch([product], demand.cat, demand.model, demand.brand, {
            qty: demand.qty,
            city: demand.city,
            cond: demand.cond,
            series: demand.series,
            pref: prefs
          })
          if (match.ok) {
            hit = { demand, match }
            break
          }
        }
        if (!hit) continue
        const claimed = claims.has(`supply:${product.id}`)
        const unsatisfied = markSet.has(`supply:${product.id}`)
        const claimCount = claimCountMap[`supply:${product.id}`] || 0
        const contact = claimed && unlocked ? await contactOfUser(product.ownerId) : null
        const owner = contact ? null : await repo.get('users', product.ownerId)
        const pubProfile = profileByUid[product.ownerId]
        const publicOrg = pubProfile && pubProfile.exposure !== EXPOSURES.HIDDEN
          ? maskSubject(pubProfile.subject, pubProfile.subjectType)
          : ''
        const demandTitle = hit.demand.title || hit.demand.model || '我的求购'
        supplyItems.push(supplyViewOf(product, {
          now: at,
          stockText: hit.match.text,
          stockQty: hit.match.qty,
          demandText: `匹配我的需求：${demandTitle}`,
          claimed,
          claimCount,
          /* 领取即解锁联系人区块：对方没留电话时由前端提示改用站内对话，
             不再因为 phone 为空把卡片底部渲染成「一个按钮都没有」的死卡片 */
          contactVisible: !!contact,
          canClaim: unlocked && !claimed && !unsatisfied,
          unsatisfied,
          org: contact ? contact.org : (publicOrg || maskName((owner && owner.nick) || '') || '匿名用户'),
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
              contact: contact ? contact.name : '已领取',
              phone: contact ? contact.phone : ''
            }))
          }
        }
      }

      /* 排序：全部按发布时间倒序（越晚发布越靠前），代采代售以上架时间为准，
         同类条目不再分组优先，避免新发的商机被旧委托压到后面 */
      const matchedDemands = demandItems
      const newestFirst = (a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)
      const visibleItems = agencyItems.concat(matchedDemands, supplyItems, endedItems).sort(newestFirst)
      const plans = await resolvePlans(repo)
      /* 未开通商机会员：看得到商机条数（角标与列表条数），但看不到型号 / 价格 / 主体 / 联系方式，
         也不下发必须条件，避免绕过会员门槛拿到商机内容 */
      const lockedItems = !unlocked
        ? visibleItems.map((item) => Object.assign({}, item, {
          title: '',
          model: '****',
          brand: '',
          city: '',
          qty: 0,
          unit: '',
          priceText: '¥ ****',
          org: '商机会员可见',
          contact: item.type === 'agency' ? '平台代为对接' : '开通商机后可见',
          phone: '',
          stockText: '',
          demandText: '',
          claimText: '',
          must: [],
          contactVisible: false,
          canClaim: false,
          canConsult: false,
          claimed: false,
          claimCount: 0,
          masked: true
        }))
        : null
      return Object.assign(view, {
        items: unlocked ? visibleItems : lockedItems,
        locked: !unlocked,
        matchedCount: agencyItems.length + matchedDemands.length + supplyItems.length,
        stockCount: stocks.length,
        demandCount: myDemands.length,
        plans,
        planKey: view.planKey || 'month',
        prefs,
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
        const doc = Object.assign({ id: uid, uid }, next, { updatedAt: at })
        const existing = await repo.get('bizPrefs', uid)
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
          bizPool: true,
          deleted: { $ne: true }
        }, { limit: 50 }))
        : []
      const demandOwners = await sharedPoolProfiles(demandRows.map((d) => d.ownerId))
      demandRows.forEach((demand) => {
        if (demand.ownerId === uid) return
        /* 已领取 / 已标记不满足的商机不再计入角标 */
        if (claims.has(`demand:${demand.id}`)) return
        if (markSet.has(`demand:${demand.id}`)) return
        /* 发布者主体未公开：不计入商机角标 */
        if (!demandOwners.has(demand.ownerId)) return
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          city: demand.city,
          cond: demand.cond,
          series: demand.series,
          pref: prefs
        })
        if (match.ok) count += 1
      })
      if (stocks.length) {
        const agencyRows = await sharedPool('open-agencies', 20, () => repo.find('agencies', {
          status: AGENCY_STATUS.ACTIVE,
          visibility: { $ne: VISIBILITIES.PRIVATE },
          bizPool: { $ne: false },
          expiresAt: { $gte: at },
          deleted: { $ne: true }
        }, { limit: 50 }))
        agencyRows.forEach((agency) => {
          if (agency.ownerId === uid) return
          const match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
            qty: agency.qty,
            city: agency.city,
            series: agency.series,
            pref: prefs
          })
          if (match.ok) count += 1
        })
      }

      /* 反向商机：别人在售的货源是否满足我已发布的需求（需求须公开且进商机池） */
      const myDemands = await repo.find('demands', {
        ownerId: uid,
        status: '求购中',
        visibility: { $ne: VISIBILITIES.PRIVATE },
        bizPool: true,
        deleted: { $ne: true }
      }, { limit: 50 })
      if (myDemands.length) {
        const productRows = await sharedPool('pool-products', 20, () => repo.find('products', {
          status: '在售',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          bizPool: true,
          deleted: { $ne: true }
        }, { limit: 100 }))
        const productOwners = await sharedPoolProfiles(productRows.map((p) => p.ownerId))
        productRows.forEach((product) => {
          if (product.ownerId === uid) return
          if (claims.has(`supply:${product.id}`)) return
          if (markSet.has(`supply:${product.id}`)) return
          if (!productOwners.has(product.ownerId)) return
          const hit = myDemands.some((demand) => stockMatch([product], demand.cat, demand.model, demand.brand, {
            qty: demand.qty,
            city: demand.city,
            cond: demand.cond,
            series: demand.series,
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
        claims.forEach((key) => {
          const text = String(key || '')
          const cut = text.indexOf(':')
          if (cut < 0) return
          const kind = text.slice(0, cut)
          const id = text.slice(cut + 1)
          if (!id) return
          if (kind === 'demand') demandIds.push(id)
          else if (kind === 'supply') supplyIds.push(id)
        })
        if (demandIds.length) {
          const rows = await repo.find('demands', { id: { $in: demandIds }, deleted: { $ne: true } }, { limit: demandIds.length })
          claimedCount += rows.filter((row) => row && row.ownerId !== uid).length
        }
        if (supplyIds.length) {
          const rows = await repo.find('products', { id: { $in: supplyIds }, deleted: { $ne: true } }, { limit: supplyIds.length })
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
      const existing = await repo.get('bizClaims', claimId)
      const stocks = await ownStocks(uid)
      /* 提示力度：与商机列表保持同一口径，列表能看到的才能领取 */
      const prefs = normalizeBizPrefs(await repo.get('bizPrefs', uid))

      let contact = null
      let ownerId = ''
      let title = ''
      if (targetType === 'demand') {
        const demand = await repo.get('demands', targetId)
        if (!demand || demand.deleted) throw new AppError(CODES.NOT_FOUND, '需求不存在或已关闭')
        /* 保密需求只隐藏主体与联系方式，内容仍可在需求详情页匿名浏览并发起对话；
           商机池卖的是联系方式，因此保密需求不进入领取 */
        if (demand.visibility === VISIBILITIES.PRIVATE) {
          throw new AppError(CODES.NOT_FOUND, '该需求为保密发布，不提供联系方式，请直接在需求详情页对话')
        }
        if (demand.status !== '求购中') throw new AppError(CODES.CONFLICT, '该需求已停止领取')
        if (demand.bizPool !== true) throw new AppError(CODES.NOT_FOUND, '该需求未进入商机池')
        if (demand.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能领取自己发布的需求')
        /* 发布者主体未公开：内容不进商机池，也不允许绕过列表直接领取 */
        if (!(await poolProfiles([demand.ownerId])).size) {
          throw new AppError(CODES.FORBIDDEN, '该商机发布者未公开主体信息，暂不可领取')
        }
        const match = stockMatch(stocks, demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          city: demand.city,
          cond: demand.cond,
          series: demand.series,
          pref: prefs
        })
        if (!match.ok) throw new AppError(CODES.FORBIDDEN, '我的库存中没有匹配的型号，无法领取')
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
        if (product.bizPool !== true) throw new AppError(CODES.NOT_FOUND, '该货源未进入商机池')
        if (product.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能领取自己发布的货源')
        /* 货主主体未公开：货源不进商机池 */
        if (!(await poolProfiles([product.ownerId])).size) {
          throw new AppError(CODES.FORBIDDEN, '该货源发布者未公开主体信息，暂不可领取')
        }
        const myDemands = await repo.find('demands', {
          ownerId: uid,
          status: '求购中',
          visibility: { $ne: VISIBILITIES.PRIVATE },
          bizPool: true,
          deleted: { $ne: true }
        }, { limit: 50 })
        const hit = myDemands.some((demand) => stockMatch([product], demand.cat, demand.model, demand.brand, {
          qty: demand.qty,
          city: demand.city,
          cond: demand.cond,
          series: demand.series,
          pref: prefs
        }).ok)
        if (!hit) throw new AppError(CODES.FORBIDDEN, '该货源与我的需求不匹配，无法领取')
        contact = await contactOfUser(product.ownerId)
        ownerId = product.ownerId
        title = product.title || product.model
      } else {
        /* 代采 / 代售委托均由平台代为对接并联系缴费，不开放自助领取 */
        const agency = await repo.get('agencies', targetId)
        if (!agency || agency.deleted) throw new AppError(CODES.NOT_FOUND, '委托不存在或已关闭')
        throw new AppError(CODES.NOT_FOUND, '该委托由平台代为对接，暂不开放自助领取')
      }

      /* 领取即对接：领取方也必须是公开主体，保证商机里对接双方都公开（委托分支已在上方拦截） */
      if (!(await poolProfiles([uid])).size) {
        throw new AppError(CODES.FORBIDDEN, '请先在「我的-资料」中公开主体信息，再领取商机')
      }

      if (!existing) {
        /* 不设领取名额：只要是商机会员且库存匹配都可以领取。
           同一用户重复领取按幂等处理，并发下以唯一 claimId 兜底。 */
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
         与直聊共用同一个确定性线索号（同一用户 + 同一标的只留一条），并发下以唯一 id 兜底 */
      const leadId = 'L' + sha256Hex(`chat:${uid}:${targetId}`).slice(0, 22)
      try {
        const hasLead = await repo.get('leads', leadId)
        if (!hasLead) {
          await repo.insert('leads', {
            id: leadId,
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
     * 标记 / 取消「不满足」：商机仍保留在列表里，
     * 但不进「可领取」分组、不再计入首页角标提醒。
     */
    'biz.mark': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const targetType = enumOf(data.targetType, ['demand', 'supply'], '商机类型')
      const targetId = str(data.targetId, { field: '商机标识', required: true, max: 64 })
      const marked = data.marked !== false
      const at = now()

      /* 只接受仍存在的商机：发布者删除后不再允许写入标记 */
      const source = await repo.get(targetType === 'demand' ? 'demands' : 'products', targetId)
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
     * 代采 / 代售：用户不能直接联系委托方，由平台代为对接。
     * 提交后生成客服工单，客服联系核实库存与交付条件后，再把采购方信息推给对方。
     */
    'biz.consult': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const at = now()

      /* 兼容前端传 agencyId / id，避免两端口径不一致 */
      const agencyId = str(data.agencyId || data.id, { field: '委托标识', required: true, max: 64 })
      const agency = await expireAgencyIfNeeded(repo, await repo.get('agencies', agencyId), at)
      if (!agency || agency.deleted || agency.status === AGENCY_STATUS.CLOSED) {
        throw new AppError(CODES.NOT_FOUND, '委托不存在或已关闭')
      }
      if (agency.status !== AGENCY_STATUS.ACTIVE) {
        throw new AppError(CODES.CONFLICT, '委托尚未上架或已下架，暂不能对接')
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
      /* 咨询对接同样要求公开主体：保证商机里对接双方都是公开主体 */
      if (!(await poolProfiles([uid])).size) {
        throw new AppError(CODES.FORBIDDEN, '请先在「我的-资料」中公开主体信息，再在商机里咨询接单')
      }

      const stocks = await ownStocks(uid)
      const prefs = normalizeBizPrefs(await repo.get('bizPrefs', uid))
      const match = stockMatch(stocks, agency.itemCat || '', agency.item, agency.brand, {
        qty: agency.qty,
        city: agency.city,
        series: agency.series,
        pref: prefs
      })
      if (!match.ok) {
        throw new AppError(CODES.FORBIDDEN, '我的库存中没有匹配的型号，无法申请平台对接')
      }

      const leadId = 'ld' + sha256Hex(`agency:${uid}:${agency.id}`).slice(0, 24)
      const existing = await repo.get('leads', leadId)
      if (existing) {
        return {
          leadId,
          already: true,
          status: existing.status,
          consulted: true,
          hint: '对接申请已提交，客服核实后会联系你'
        }
      }

      const isBuy = agency.side === 'buy'
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
        formSummary: `库存可匹配「${agency.item || ''}」${match.qty ? `，可供 ${match.qty} 台` : ''}，申请平台代为对接`,
        compare: [],
        matchPct: 100,
        status: LEAD_STATUS.PENDING,
        tier: TIERS.DEFAULT,
        tierName: '',
        assignedTo: '',
        contactReleased: false,
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
        already: false,
        status: LEAD_STATUS.PENDING,
        consulted: true,
        hint: '已提交对接申请，客服核实后推送采购方'
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
    const paymentId = str(data.paymentId, { field: '收款单', max: 64 }) || ''
    /* 同一收款单只开通一次：并发确认 / 重复点击时直接回放上次结果 */
    if (paymentId) {
      const done = await repo.find('bizOrders', { paymentId }, { limit: 1 })
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
    const order = {
      id: randomId('BO'),
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
      paymentId,
      operator: staff,
      accountId: (ctx && ctx.accountId) || '',
      note,
      createdAt: at
    }
    await repo.insert('bizOrders', order)
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
      const total = filtered.length
      const start = (page.page - 1) * page.limit
      const pageRows = filtered.slice(start, start + page.limit)
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
      const all = await repo.find('agencies', side ? { deleted: { $ne: true }, side } : { deleted: { $ne: true } }, { limit: 100000 })
      for (const row of all) counts[row.status] = (counts[row.status] || 0) + 1
      return { items, total, page: page.page, limit: page.limit, counts }
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
      const res = await repo.updateWhere('agencies', { id, status: AGENCY_STATUS.REVIEW }, patch)
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
     * 平台收尾：发起成交或关闭。
     * 「标记成交」不再直接置为已成交，而是进入「待确认成交」并通知委托方确认；
     * 委托方确认后（agency.dealConfirm）才真正成交并生成后付费服务费账单。
     */
    'agency.close': async (data, ctx) => {
      const role = await roleOf(ctx)
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可关闭 / 标记成交')
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const dealt = data.dealt === true
      const reason = str(data.reason, { field: '关闭原因', max: 100 })
      const dealAmount = dealt ? Math.max(0, Math.round((Number(data.dealAmount) || 0) * 100) / 100) : 0
      const at = now()
      const staff = await staffLabel(ctx)
      const res = await repo.updateWhere('agencies', {
        id,
        status: dealt
          ? { $in: [AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE] }
          : { $in: [AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE, AGENCY_STATUS.DEAL_PENDING, AGENCY_STATUS.DEALT] }
      }, dealt
        ? {
          /* 平台发起成交：等委托方确认后才算成交 */
          status: AGENCY_STATUS.DEAL_PENDING,
          dealAmount,
          dealProposedAt: at,
          dealProposedBy: staff,
          staff,
          reason: '',
          closeReason: '',
          closedAt: 0,
          updatedAt: at
        }
        : {
          status: AGENCY_STATUS.CLOSED,
          reason,
          closeReason: reason,
          staff,
          closedAt: at,
          updatedAt: at
        })
      if (!res || !res.count) {
        throw new AppError(CODES.CONFLICT, dealt
          ? '仅「已通过 / 已上架」的委托可发起成交'
          : '仅未结束的委托可关闭')
      }
      await audit(ctx, 'agency.close', id, reason || (dealt ? `发起成交确认 · ${dealAmount}` : '关闭委托'))
      const doc = await repo.get('agencies', id)
      try {
        await notifyUser(doc.ownerId, {
          title: `${doc.kind || '代采代售'}委托${dealt ? '待确认成交' : '已关闭'}`,
          body: dealt
            ? `委托单有新进展，请确认成交（成交金额 ${doc.currencySymbol || '¥'}${Number(doc.dealAmount || 0).toLocaleString('zh-CN')}）。确认后按约定支付服务费。`
            : '委托已从商机池下架，不再继续代寻。',
          reason,
          targetType: 'agency',
          targetId: id
        })
      } catch (err) { /* 回执失败不影响主流程 */ }
      return agencyStaffView(doc, at)
    },

    /**
     * 平台直接修改代采代售商品：平台拥有对已发布委托的编辑权，改完立即生效并通知委托方。
     * 若该委托正处于「修改待审核」（editPending），改动合并进待审内容，审核通过时一并生效。
     */
    'agency.update': async (data, ctx) => {
      const id = str(data.id, { field: '委托标识', required: true, max: 64 })
      const doc = await repo.get('agencies', id)
      if (!doc || doc.deleted === true) throw new AppError(CODES.NOT_FOUND, '委托不存在或已删除')
      if (![AGENCY_STATUS.PENDING, AGENCY_STATUS.REVIEW, AGENCY_STATUS.APPROVED, AGENCY_STATUS.ACTIVE].includes(doc.status)) {
        throw new AppError(CODES.CONFLICT, '已结束的委托不可修改')
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
      const fields = { item, qty, price, city, detail, flow, must, nego }
      const at = now()
      const staff = await staffLabel(ctx)
      const patch = Object.assign({}, fields, { amount: round2(qty * price), staff, updatedAt: at })
      if (doc.editPending === true) patch.pendingEdit = Object.assign({}, doc.pendingEdit || {}, fields)
      const res = await repo.updateWhere('agencies', { id }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
      await audit(ctx, 'agency.update', id, `平台修改：${item}`)
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
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可发布官方资讯')
      const input = normalizeNewsInput(data, true)
      const at = now()
      const doc = {
        id: randomId('NW'),
        uid: (ctx && ctx.accountId) || 'admin',
        official: true,
        cat: input.cat,
        title: input.title,
        summary: input.summary,
        content: input.content,
        city: input.city,
        author: '平台运营',
        status: NEWS_STATUS.PUBLISHED,
        reason: '',
        views: 0,
        createdAt: at,
        updatedAt: at,
        publishedAt: at,
        reviewedBy: (ctx && ctx.accountId) || 'admin',
        deleted: false
      }
      await repo.insert('news', doc)
      await audit(ctx, 'news.create', doc.id, '发布官方资讯')
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
      if (role !== 'admin') throw new AppError(CODES.FORBIDDEN, '仅管理员可下架资讯')
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
      const days = Math.min(30, Math.max(1, Math.floor(Number(data.days) || 7)))
      const at = now()
      const dayKey = Math.floor(at / DAY_MS)
      const rows = await repo.find('bizAccess', {}, { limit: 2000 })
      const reminded = []
      for (const row of rows) {
        const view = accessView(row, at)
        if (view.status !== '已开通' || Number(view.daysLeft) > days) continue
        const id = 'M' + sha256Hex(`biz-remind:${row.uid}:${dayKey}`).slice(0, 24)
        if (await repo.get('outbox', id)) continue
        await repo.insert('outbox', {
          id,
          type: 'system.notice',
          payload: {
            uid: row.uid,
            channel: 'system',
            from: 'system',
            title: '商机会员即将到期',
            body: `你的商机会员还有 ${view.daysLeft} 天到期（${view.expireText}）。到期后将无法查看与对接商机，续费后可继续使用。`,
            reason: '',
            targetType: 'biz',
            targetId: row.uid
          },
          status: 'pending',
          createdAt: at
        })
        if (subscribe) {
          await subscribe.biz(row.uid, {
            title: '商机会员即将到期',
            body: `还有 ${view.daysLeft} 天到期，续费后继续查看商机`,
            at
          }).catch(() => {})
        }
        reminded.push({ uid: row.uid, daysLeft: view.daysLeft, expireText: view.expireText })
      }
      return { days, reminded: reminded.length, items: reminded, at }
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
        note: row.note || '',
        voucher: row.voucher || '',
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

    'payment.create': async (data, ctx) => {
      const uid = str(data.uid, { field: '用户标识', required: true, max: 64 })
      const user = await repo.get('users', uid)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const bizType = enumOf(data.bizType || '其他', PAYMENT_BIZ_TYPES, '收款类型')
      const method = enumOf(data.method || '企业微信', PAYMENT_METHODS, '收款方式')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0) throw new AppError(CODES.VALIDATION, '收款金额需大于 0')
      const plans = await resolvePlans(repo)
      const plan = data.plan ? plans.find((item) => item.key === String(data.plan)) : null
      if (data.plan && !plan) throw new AppError(CODES.VALIDATION, '套餐不存在')
      const at = now()
      const staff = await staffLabel(ctx)
      const discount = Math.max(0, Number(data.discount) || (plan ? plan.saving : 0))
      const doc = {
        id: randomId('PY'),
        uid,
        nick: user.nick || '',
        bizType,
        planKey: plan ? plan.key : '',
        planLabel: plan ? plan.label : '',
        days: plan ? plan.days : (Number(data.days) || 0),
        amount: Math.round(amount * 100) / 100,
        discount: Math.round(discount * 100) / 100,
        received: Math.round(Math.max(0, amount - discount) * 100) / 100,
        method,
        /* 财务登记即视为到账，不再走人工确认；会员续费当场自动加时长 */
        status: PAYMENT_STATUS.CONFIRMED,
        paidAt: Number(data.paidAt) || at,
        confirmedAt: at,
        confirmedBy: staff,
        voucher: String(data.voucher || '').slice(0, 400000),
        operator: staff,
        accountId: (ctx && ctx.accountId) || '',
        note: str(data.note, { field: '备注', max: 200 }) || '',
        createdAt: at,
        updatedAt: at
      }
      await repo.insert('payments', doc)
      await audit(ctx, 'payment.create', doc.id, `${bizType} · ${doc.received} 元 · ${method} · 登记即入账`)
      let grant = null
      if (bizType === '会员续费' && (doc.planKey || Number(doc.days) > 0)) {
        try {
          grant = await grantMembership({
            uid,
            plan: doc.planKey || undefined,
            days: Number(doc.days) > 0 ? doc.days : undefined,
            amount: doc.received,
            method,
            note: doc.note,
            paymentId: doc.id
          }, ctx)
          await repo.updateWhere('payments', { id: doc.id }, { orderId: grant.orderId, updatedAt: now() })
          doc.orderId = grant.orderId
        } catch (err) {
          /* 开通失败退回待确认，可在收款流水补确认，避免「已入账但没加时长」 */
          await repo.updateWhere('payments', { id: doc.id }, {
            status: PAYMENT_STATUS.PENDING,
            confirmedAt: 0,
            confirmedBy: '',
            updatedAt: now()
          })
          throw err
        }
      }
      /* 会员类由 grantMembership 通知；其余收款单独回执，避免用户不知道钱已入账 */
      if (!grant) {
        try {
          await notifyUser(uid, {
            title: '收款已入账',
            body: `${bizType} · ${doc.received} 元已入账（${method}），可在「我的缴费」查看。`,
            targetType: 'payment',
            targetId: doc.id
          })
        } catch (notifyErr) { /* 收款单已落库：回执失败不回滚 */ }
      }
      return doc
    },

    /** 财务确认到账：会员类收款自动开通 / 续费，并回填订单号 */
    'payment.confirm': async (data, ctx) => {
      const id = str(data.id, { field: '收款单', required: true, max: 64 })
      const row = await repo.get('payments', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      if (row.status === PAYMENT_STATUS.REFUNDED) throw new AppError(CODES.CONFLICT, '该收款单已退款')
      const at = now()
      const staff = await staffLabel(ctx)
      if (row.status === PAYMENT_STATUS.CONFIRMED) {
        /* 幂等回写：已确认的委托服务费账单仍补齐委托单到账状态 */
        if (row.agencyId) {
          await repo.updateWhere('agencies', { id: row.agencyId }, {
            feeStatus: 'paid',
            feePaidAt: Number(row.confirmedAt) || now(),
            feePaidBy: row.confirmedBy || '',
            feeBillId: id,
            updatedAt: now()
          })
        }
        return { id, status: row.status, confirmed: true, orderId: row.orderId || '' }
      }
      /* 早期「提交申请」生成的待确认单没有记实收，确认时按应收金额补记 */
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
          return { id, status: fresh.status, confirmed: true, orderId: fresh.orderId || '', grant: null }
        }
        throw new AppError(CODES.CONFLICT, '收款单状态已变化，请刷新后重试')
      }
      let grant = null
      try {
        if (row.bizType === '会员续费' && (row.planKey || Number(row.days) > 0)) {
          grant = await grantMembership({
            uid: row.uid,
            plan: row.planKey || undefined,
            days: Number(row.days) > 0 ? row.days : undefined,
            amount: received,
            method: row.method,
            note: row.note,
            paymentId: id
          }, ctx)
          await repo.updateWhere('payments', { id }, { orderId: grant.orderId, updatedAt: now() })
        }
      } catch (err) {
        /* 开通失败回滚为待确认，允许处理后重试，避免「已确认但没开通」 */
        await repo.updateWhere('payments', { id }, {
          status: PAYMENT_STATUS.PENDING,
          confirmedAt: 0,
          confirmedBy: '',
          updatedAt: now()
        })
        throw err
      }
      await audit(ctx, 'payment.confirm', id, `${row.bizType} · ${received} 元 · ${staff}`)
      /* 委托服务费账单：确认到账后回写委托单，feeStatus=paid 并记录到账时间 */
      if (row.agencyId) {
        await repo.updateWhere('agencies', { id: row.agencyId }, {
          feeStatus: 'paid',
          feePaidAt: at,
          feePaidBy: staff,
          feeBillId: id,
          updatedAt: at
        })
      }
      /* 会员类由 grantMembership 通知；其余收款单独回执，避免用户不知道钱已确认 */
      if (!grant) {
        try {
          await notifyUser(row.uid, {
            title: '收款已确认到账',
            body: `${row.bizType} · ${received} 元已确认到账，可在「我的缴费」查看。`,
            targetType: 'payment',
            targetId: id
          })
        } catch (notifyErr) { /* 已确认到账：回执失败不回滚 */ }
      }
      return { id, status: PAYMENT_STATUS.CONFIRMED, confirmed: true, orderId: grant ? grant.orderId : '', grant }
    },

    'payment.refund': async (data, ctx) => {
      const id = str(data.id, { field: '收款单', required: true, max: 64 })
      const row = await repo.get('payments', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '收款单不存在')
      if (row.status === PAYMENT_STATUS.REFUNDED) return { id, status: row.status, refunded: true }
      const reason = str(data.reason, { field: '退款原因', required: true, max: 100 })
      const at = now()
      const staff = await staffLabel(ctx)
      await repo.updateWhere('payments', { id }, {
        status: PAYMENT_STATUS.REFUNDED,
        refundedAt: at,
        refundedBy: staff,
        refundReason: reason,
        updatedAt: at
      })
      /* 会员类退款：同步停用权限，避免退款后仍可查看联系方式 */
      if (row.orderId && data.revoke !== false) {
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
      }
      await audit(ctx, 'payment.refund', id, `${reason} · ${staff}`)
      try {
        await notifyUser(row.uid, {
          title: '收款已退款',
          body: `你支付的 ${row.received} 元已退款：${reason}。如有疑问请联系平台客服。`,
          reason,
          targetType: 'payment',
          targetId: id
        })
      } catch (notifyErr) { /* 退款已生效：回执失败不回滚 */ }
      return { id, status: PAYMENT_STATUS.REFUNDED, refunded: true }
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
          await repo.updateWhere('payments', { id: payment.id }, {
            status: PAYMENT_STATUS.REFUNDED,
            refundedAt: at,
            refundedBy: staff,
            refundReason: reason,
            updatedAt: at
          })
          /* 会员类退款同步停用权限，避免退款后仍可查看联系方式 */
          if (payment.orderId) {
            const access = await repo.get('bizAccess', payment.uid)
            if (access) {
              await repo.updateWhere('bizAccess', { id: payment.uid }, {
                status: BIZ_STATUS.STOPPED,
                expireAt: at,
                updatedAt: at,
                staff,
                note: `退款停用：${reason}`
              })
            }
          }
          await audit(ctx, 'payment.refund', payment.id, `${reason} · ${staff}`)
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

    /** 财务汇总：营收、付费用户、续费率、套餐结构、近 6 个月趋势 */
    'finance.summary': async () => {
      const at = now()
      /* payments 仅用于待确认统计；营收只统计微信端调起的支付，手动开通与线下登记不计营收 */
      const payments = await repo.find('payments', {}, { sort: { field: 'paidAt', dir: 'desc' }, limit: 20000 })
      const orders = await repo.find('bizOrders', {}, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20000 })
      const accesses = await repo.find('bizAccess', {}, { limit: 20000 })
      const paidOrders = orders.filter((o) => o.method === '微信支付')
      const revenueRows = paidOrders.map((o) => ({
        at: Number(o.createdAt) || 0,
        amount: Number(o.amount) || 0,
        uid: o.uid,
        bizType: '会员续费',
        planKey: o.planKey || ''
      }))
      const revenue = revenueRows.reduce((sum, row) => sum + row.amount, 0)
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
      for (const row of revenueRows) {
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
      for (const order of paidOrders) {
        const key = order.planKey || 'custom'
        if (byPlan[key]) byPlan[key].days += Number(order.days) || 0
      }
      /* 近 6 个月营收趋势 */
      const months = []
      const d = new Date(at + 8 * 60 * 60 * 1000)
      for (let i = 5; i >= 0; i -= 1) {
        const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
        const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`
        months.push({ month: key, revenue: 0, orders: 0 })
      }
      const monthMap = {}
      for (const row of months) monthMap[row.month] = row
      for (const row of revenueRows) {
        const rd = new Date(row.at + 8 * 60 * 60 * 1000)
        const key = `${rd.getUTCFullYear()}-${String(rd.getUTCMonth() + 1).padStart(2, '0')}`
        if (monthMap[key]) {
          monthMap[key].revenue += row.amount
          monthMap[key].orders += 1
        }
      }
      for (const row of months) row.revenue = Math.round(row.revenue * 100) / 100
      const startOfToday = at - ((at + 8 * 3600 * 1000) % DAY_MS)
      const revenueOf = (since) => revenueRows.filter((row) => row.at >= since).reduce((sum, row) => sum + row.amount, 0)
      /* 用户消费画像：累计消费 / 近 30 天消费 / 消费次数，供财务中心「单个用户」视图 */
      const allUsers = await repo.find('users', {}, { limit: 20000 })
      const userOf = new Map(allUsers.map((u) => [u.id, u]))
      const allLeads = await repo.find('leads', {}, { limit: 20000 })
      const matchedCount = allLeads.filter((row) => row.status === LEAD_STATUS.MATCHED || row.status === LEAD_STATUS.DEALT).length
      const spendByUid = {}
      for (const row of revenueRows) {
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
      /* 每周对账：只核对微信支付订单，线下登记 / 手动开通不计营收 */
      const weekFrom = at - 7 * DAY_MS
      const weekOrders = paidOrders.filter((row) => Number(row.createdAt) >= weekFrom)
      const sumBy = (rows, field) => Math.round(rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0) * 100) / 100
      const recon = {
        since: weekFrom,
        wechatCount: weekOrders.length,
        wechatAmount: sumBy(weekOrders, 'amount')
      }
      recon.total = recon.wechatAmount
      return {
        at,
        totals: {
          revenue: Math.round(revenue * 100) / 100,
          today: Math.round(revenueOf(startOfToday) * 100) / 100,
          last7: Math.round(revenueOf(at - 7 * DAY_MS) * 100) / 100,
          last30: Math.round(revenueOf(at - 30 * DAY_MS) * 100) / 100,
          orders: revenueRows.length,
          payers: payers.size,
          repeatPayers,
          arpu: payers.size ? Math.round((revenue / payers.size) * 100) / 100 : 0,
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
        recon,
        byPlan: Object.values(byPlan).map((row) => ({
          key: row.key,
          label: row.label,
          count: row.count,
          amount: Math.round(row.amount * 100) / 100,
          days: row.days
        })).sort((a, b) => b.amount - a.amount),
        months,
        topSpenders,
        recent: paidOrders.slice(0, 10).map((row) => {
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
  boardItems,
  agencyOwnerView,
  agencyStaffView,
  accessView,
  createMarketUserHandlers,
  createMarketAdminHandlers
}
