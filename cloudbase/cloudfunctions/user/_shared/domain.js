'use strict'

/**
 * 领域层：商品 / 求购需求 / 线索判档。
 *
 * 四种交易方式共用一张「货源 / 需求」表，用 tradeMode 区分：
 * - 出售 / 求购：一次性成交，计价「元 / 台」，要交易地与成色
 * - 出租 / 租赁：按租期用，计价「元 / 台 / 月」，设备留在出租方机房，无交易地、无成色
 *
 * 判档（咨询人筛选规则）必须幂等：同一线索按同一规则版本算出的档位不随时间变化，
 * 因此这里只依据「提交时的规则快照」计算并落库。
 */

const { AppError, CODES } = require('./errors')
const {
  TRADE_MODES,
  TRADE_SIDE,
  RENTAL_MODES,
  TRADE_MODE_OPTIONS,
  RENT_TERMS,
  CLOSED_PRICE,
  RENT_DEPOSIT,
  RENT_PAY,
  RENT_LIMITS,
  MUST_CONDITIONS,
  MUST_CONDITIONS_SELL,
  MUST_CONDITIONS_BUY,
  MUST_CONDITIONS_RENT,
  MUST_CONDITIONS_LEASE,
  TIERS,
  BLOCKED_REVIEW_WINDOW_MS,
  BLOCKED_CLEANUP_DAYS,
  MEDIA_LIMIT,
  MEDIA_MAX_BYTES,
  MEDIA_SIZE_TEXT,
  VISIBILITIES,
  PUBLISH_CHANNELS,
  CURRENCIES,
  DEFAULT_CURRENCY
} = require('./constants')
const { str, enumOf, arrayOfStrings, fileRef } = require('./validate')
const { sanitizeFileName } = require('./files')

const SUPPLY_TYPES = ['现货', '期货']
const CONDITIONS = ['全新', '二手', '拆机件', '翻新']
const TAX_OPTIONS = ['含税', '不含税', '可开专票', '可开普票']
const DELIVER_OPTIONS = ['当日可提', '3 天内', '7 天内', '30 天内', '45 天内']
const RENT_DELIVER_OPTIONS = ['当日可起租', '3 天内', '7 天内', '30 天内', '可议']

/* 发布媒体：图片（含 PDF 资质）最多 5 个、视频最多 3 段；大小上限与 shared/constants.js 同口径 */
const PUBLISH_MEDIA_LIMIT = MEDIA_LIMIT
const PUBLISH_MEDIA_MAX_BYTES = MEDIA_MAX_BYTES
const PUBLISH_MEDIA_TYPES = Object.freeze({
  'image/jpeg': { kind: 'image' },
  'image/png': { kind: 'image' },
  'image/webp': { kind: 'image' },
  'application/pdf': { kind: 'doc' },
  'video/mp4': { kind: 'video' },
  'video/quicktime': { kind: 'video' },
  'video/x-m4v': { kind: 'video' }
})
const MAX_MEDIA_NAME_LEN = 30

/**
 * 发布媒体元信息校验（全部选填）。
 * 只接收名称 / 类型 / 大小的元信息，二进制另行走 materials 私有存储；
 * 数量按「图片（含 PDF）5 个 / 视频 3 段」分组限制，单文件超限直接拒绝。
 */
function normalizeMedia(input) {
  if (input == null || input === '') return []
  if (!Array.isArray(input)) throw new AppError(CODES.VALIDATION, '媒体列表格式不合法')
  const groups = { image: 0, video: 0 }
  const out = []
  for (const item of input) {
    const type = String((item && item.type) || '').toLowerCase()
    const spec = PUBLISH_MEDIA_TYPES[type]
    if (!spec) throw new AppError(CODES.VALIDATION, '不支持的图片 / 视频格式')
    const group = spec.kind === 'video' ? 'video' : 'image'
    if (groups[group] >= PUBLISH_MEDIA_LIMIT[group]) {
      throw new AppError(CODES.VALIDATION, group === 'video' ? '最多上传 3 段视频' : '最多上传 5 张图片')
    }
    const size = Number(item && item.size)
    if (!Number.isFinite(size) || size <= 0) throw new AppError(CODES.VALIDATION, '文件大小不合法')
    if (size > PUBLISH_MEDIA_MAX_BYTES[spec.kind]) {
      throw new AppError(CODES.VALIDATION, MEDIA_SIZE_TEXT[spec.kind] || '文件大小超出限制')
    }
    const name = sanitizeFileName(item && item.name).slice(0, MAX_MEDIA_NAME_LEN) || '未命名材料'
    groups[group]++
    /* fileId 为上传接口返回的地址，管理端据此直接展示原件；缺失时降级为仅名称 */
    const ref = fileRef(item && item.fileId)
    out.push(Object.assign({ name, type, size: Math.floor(size), kind: spec.kind }, ref ? { fileId: ref } : {}))
  }
  return out
}

function isRental(mode) {
  return RENTAL_MODES.includes(mode)
}

function sideOf(mode) {
  const side = TRADE_SIDE[mode]
  if (!side) throw new AppError(CODES.VALIDATION, '交易方式不合法')
  return side
}

/** 金额解析：只接受纯数字（不含货币符号、千分位），返回「元」，与 priceUnit 口径一致 */
function parseAmount(value, field) {
  const raw = String(value == null ? '' : value).replace(/[,，\s]/g, '')
  if (!raw) throw new AppError(CODES.VALIDATION, `请填写${field}`)
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new AppError(CODES.VALIDATION, `${field}只能是数字`)
  }
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) throw new AppError(CODES.VALIDATION, `${field}必须大于 0`)
  if (num > 100000000) throw new AppError(CODES.VALIDATION, `${field}超出允许范围`)
  /* 元为单位保存，最多两位小数；不能再乘 100，否则前端按「元」展示会放大 100 倍 */
  return Math.round(num * 100) / 100
}

/**
 * 发布渠道归一化。
 * 兼容历史入参 bizPool（true/false）：
 * - 未传 channel 时，bizPool !== false 视作 both，bizPool === false 视作 normal；
 * - 保密发布只能是 normal（隐藏主体只能普通发布，避免匿名商机打扰）。
 */
function channelOf(data, visibility) {
  const fallback = data.bizPool === false ? PUBLISH_CHANNELS.NORMAL : PUBLISH_CHANNELS.BOTH
  const channel = enumOf(data.channel || fallback, Object.values(PUBLISH_CHANNELS), '发布渠道')
  return visibility === VISIBILITIES.PRIVATE ? PUBLISH_CHANNELS.NORMAL : channel
}

/**
 * 发布商品：出售 / 出租。
 * 出租场景不接收交易地与成色，服务端直接忽略这两个字段（不是信任客户端）。
 *
 * relaxed = true 时按「草稿」处理：字段可以不填全，只落已填内容；
 * 草稿不参与对外展示与咨询，用户补齐后再走完整校验（正式提交）。
 */
function buildProduct(data, ownerId, at, opts) {
  const relaxed = !!(opts && opts.relaxed)
  const mode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.supply, '交易方式')
  const rental = isRental(mode)

  const title = str(data.title, { field: '标题', required: true, min: relaxed ? 2 : 4, max: 60 })
  const cat = str(data.cat, { field: '设备类型', required: !relaxed, max: 30 })
  const brand = str(data.brand, { field: '品牌', required: !relaxed, max: 30 })
  const model = str(data.model, { field: '型号', required: !relaxed, max: 40 })
  /* 系列只用于商机撮合时判断同族，不单独展示，允许为空 */
  const series = str(data.series, { field: '系列', max: 40 })
  const qtyRaw = Number(data.qty)
  const qty = relaxed
    ? (Number.isInteger(qtyRaw) && qtyRaw > 0 ? qtyRaw : 0)
    : qtyRaw
  if (!relaxed && (!Number.isInteger(qty) || qty < 1 || qty > 100000)) {
    throw new AppError(CODES.VALIDATION, '数量必须是大于 0 的整数')
  }
  const minQtyRaw = data.minQty === undefined ? 1 : Number(data.minQty)
  const minQty = relaxed
    ? (qty > 0 && Number.isInteger(minQtyRaw) && minQtyRaw >= 1 && minQtyRaw <= qty ? minQtyRaw : (qty > 0 ? 1 : 0))
    : minQtyRaw
  if (!relaxed && (!Number.isInteger(minQty) || minQty < 1 || minQty > qty)) {
    throw new AppError(CODES.VALIDATION, '起订量 / 起租量不能大于数量')
  }

  /* 价格方式：固定单价 / 价格区间 / 现场沟通（面议） */
  const priceMode = enumOf(data.priceMode || 'fixed', ['fixed', 'range', 'nego'], '价格方式')

  const supply = enumOf(data.supply || '现货', SUPPLY_TYPES, '供给类型')
  const tax = arrayOfStrings(data.tax, { field: '税费', max: 4, itemMax: 20 })
  if (!tax.length && !relaxed) throw new AppError(CODES.VALIDATION, '请至少选择一项税费口径')
  /* 可见范围：默认公开；保密内容仅发布者与平台可见 */
  const visibility = enumOf(data.visibility || VISIBILITIES.PUBLIC, [VISIBILITIES.PUBLIC, VISIBILITIES.PRIVATE], '可见范围')
  const channel = channelOf(data, visibility)
  /* 币种：默认人民币 */
  const currencyCodes = CURRENCIES.map((c) => c.code)
  const currency = enumOf(data.currency || DEFAULT_CURRENCY, currencyCodes, '币种')
  const cur = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0]

  const doc = {
    id: str(data.id, { field: '商品号', max: 64 }) || '',
    visibility,
    /* 发布渠道：仅普通 / 仅商机 / 二者都发；保密发布强制仅普通 */
    channel,
    /* 是否进入商机池：由渠道推导，兼容旧字段与旧查询 */
    bizPool: visibility === VISIBILITIES.PUBLIC && channel !== PUBLISH_CHANNELS.NORMAL,
    currency,
    currencySymbol: cur.symbol,
    currencyLabel: cur.label,
    tradeMode: mode,
    side: 'supply',
    title,
    cat,
    brand,
    model,
    series,
    qty,
    minQty,
    supply,
    tax: tax.join(' · '),
    ownerId,
    status: '待审核',
    createdAt: at
  }

  if (rental) {
    /* 出租：月租金 + 租期 + 闭口价 + 押金 + 支付方式；无交易地、无成色 */
    doc.price = priceMode === 'nego'
      ? 0
      : (relaxed ? (Number(data.rent) > 0 ? parseAmount(data.rent, '月租金') : 0) : parseAmount(data.rent, '月租金'))
    doc.priceUnit = cur.symbol + ' / 台 / 月'
    doc.term = arrayOfStrings(data.term, { field: '租期', max: 6, itemMax: 12 })
    if (!doc.term.length && !relaxed) throw new AppError(CODES.VALIDATION, '请选择租期')
    if (!relaxed) {
      doc.term.forEach((t) => {
        if (!RENT_TERMS.includes(t)) throw new AppError(CODES.VALIDATION, '租期取值不合法')
      })
    }
    doc.closed = relaxed ? str(data.closed, { field: '是否闭口', max: 20 }) : enumOf(data.closed, Object.values(CLOSED_PRICE), '是否闭口')
    doc.deposit = relaxed ? str(data.deposit, { field: '押金', max: 20 }) : enumOf(data.deposit, RENT_DEPOSIT, '押金')
    doc.pay = relaxed ? str(data.pay, { field: '租金支付方式', max: 20 }) : enumOf(data.pay, RENT_PAY, '租金支付方式')
    doc.rentLimits = arrayOfStrings(data.rentLimits, { field: '租赁限制条款', max: RENT_LIMITS.length, itemMax: 60 })
    if (!relaxed) {
      doc.rentLimits.forEach((c) => {
        if (!RENT_LIMITS.includes(c)) throw new AppError(CODES.VALIDATION, '租赁限制条款取值不合法')
      })
    }
    doc.deliver = relaxed ? str(data.deliver, { field: '可起租时间', max: 20 }) : enumOf(data.deliver || '当日可起租', RENT_DELIVER_OPTIONS, '可起租时间')
    doc.cond = ''
    doc.condLevel = ''
    doc.city = ''
    doc.must = arrayOfStrings(data.must, { field: '必须条件', max: 20, itemMax: 60 })
    if (!relaxed) {
      doc.must.forEach((c) => {
        if (!MUST_CONDITIONS_RENT.includes(c)) throw new AppError(CODES.VALIDATION, '必须条件取值不合法')
      })
    }
    doc.nego = arrayOfStrings(data.nego, { field: '可沟通条件', max: 20, itemMax: 60 })
    doc.flow = arrayOfStrings(data.flow, { field: '交易流程', max: 12, itemMax: 40 })
  } else {
    /* 出售：整单价 + 交易地 + 成色；无押金字段 */
    doc.price = priceMode === 'nego'
      ? 0
      : (relaxed ? (Number(data.price) > 0 ? parseAmount(data.price, '出售单价') : 0) : parseAmount(data.price, '出售单价'))
    doc.priceUnit = cur.symbol + ' / 台'
    doc.cond = relaxed ? str(data.cond, { field: '成色', max: 30 }) : enumOf(data.cond, CONDITIONS, '成色')
    doc.condLevel = str(data.condLevel, { field: '几成新', max: 12 })
    doc.city = str(data.city, { field: '交易地', required: !relaxed, max: 20 })
    doc.deliver = relaxed ? str(data.deliver, { field: '可交付时间', max: 20 }) : enumOf(data.deliver || '3 天内', DELIVER_OPTIONS, '可交付时间')
    doc.deposit = ''
    doc.pay = ''
    doc.rentLimits = []
    doc.must = arrayOfStrings(data.must, { field: '必须条件', max: 20, itemMax: 60 })
    if (!relaxed) {
      doc.must.forEach((c) => {
        if (!MUST_CONDITIONS_SELL.includes(c)) throw new AppError(CODES.VALIDATION, '必须条件取值不合法')
      })
    }
    doc.nego = arrayOfStrings(data.nego, { field: '可沟通条件', max: 20, itemMax: 60 })
    doc.flow = arrayOfStrings(data.flow, { field: '交易流程', max: 12, itemMax: 40 })
  }

  /* 价格区间：最高价必须高于最低价；面议不落金额，避免被当成 0 元商品 */
  doc.priceMode = priceMode
  doc.priceMax = 0
  if (priceMode === 'range') {
    const max = relaxed
      ? (Number(data.priceMax) > 0 ? parseAmount(data.priceMax, '最高价') : 0)
      : parseAmount(data.priceMax, '最高价')
    if (!relaxed && max <= doc.price) throw new AppError(CODES.VALIDATION, '最高价需高于最低价')
    doc.priceMax = max
  }

  doc.note = str(data.note, { field: '交易说明', max: 500 })
  doc.accept = str(data.accept, { field: '验收标准', max: 500 })
  doc.requirements = str(data.requirements, { field: '接单要求', max: 300 })
  doc.limit = str(data.limit, { field: '可承接上限', max: 100 })
  /* 展示标签：由发布者自己填写，详情页直接展示，最多 6 个 */
  doc.tags = arrayOfStrings(data.tags, { field: '商品标签', max: 6, itemMax: 12 })
  /* 设备实拍图 / 视频（选填）：只落元信息；编辑时未重新提交由调用方保留原件 */
  doc.media = normalizeMedia(data.media)
  return doc
}

/**
 * 发布需求：求购 / 租赁。
 * relaxed = true 时按「草稿」处理：字段可以不填全，只落已填内容。
 */
function buildDemand(data, ownerId, at, opts) {
  const relaxed = !!(opts && opts.relaxed)
  const mode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.demand, '交易方式')
  const rental = isRental(mode)

  const title = str(data.title, { field: '标题', required: true, min: relaxed ? 2 : 4, max: 60 })
  const cat = str(data.cat, { field: '设备类型', required: !relaxed, max: 30 })
  /* 需求侧不强制型号：买方只表达「要多少、租多久、预算多少」，具体型号由坐席撮合时确认 */
  const brand = str(data.brand, { field: '品牌', max: 30 })
  const model = str(data.model, { field: '型号', max: 40 })
  /* 系列只用于商机撮合时判断同族，不单独展示，允许为空 */
  const series = str(data.series, { field: '系列', max: 40 })
  const qtyRaw = Number(data.qty)
  const qty = relaxed
    ? (Number.isInteger(qtyRaw) && qtyRaw > 0 ? qtyRaw : 0)
    : qtyRaw
  if (!relaxed && (!Number.isInteger(qty) || qty < 1 || qty > 1000000)) {
    throw new AppError(CODES.VALIDATION, '数量必须是大于 0 的整数')
  }

  /* 预算方式：固定预算 / 预算区间 / 面议（现场沟通） */
  const budgetMode = enumOf(data.budgetMode || 'fixed', ['fixed', 'range', 'nego'], '预算方式')

  const supply = enumOf(data.supply || '现货', SUPPLY_TYPES, '供给类型')
  const tax = arrayOfStrings(data.tax, { field: '税费要求', max: 4, itemMax: 20 })
  if (!tax.length && !relaxed) throw new AppError(CODES.VALIDATION, '请至少选择一项税费口径')
  /* 可见范围：默认公开；保密内容仅发布者与平台可见 */
  const visibility = enumOf(data.visibility || VISIBILITIES.PUBLIC, [VISIBILITIES.PUBLIC, VISIBILITIES.PRIVATE], '可见范围')
  const channel = channelOf(data, visibility)
  /* 币种：默认人民币 */
  const currencyCodes = CURRENCIES.map((c) => c.code)
  const currency = enumOf(data.currency || DEFAULT_CURRENCY, currencyCodes, '币种')
  const cur = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0]

  const doc = {
    id: str(data.id, { field: '需求号', max: 64 }) || '',
    visibility,
    /* 发布渠道：仅普通 / 仅商机 / 二者都发；保密发布强制仅普通 */
    channel,
    /* 是否进入商机池：由渠道推导，兼容旧字段与旧查询 */
    bizPool: visibility === VISIBILITIES.PUBLIC && channel !== PUBLISH_CHANNELS.NORMAL,
    currency,
    currencySymbol: cur.symbol,
    currencyLabel: cur.label,
    tradeMode: mode,
    side: 'demand',
    title,
    cat,
    brand,
    model,
    series,
    qty,
    supply,
    tax: tax.join(' · '),
    ownerId,
    status: '求购中',
    createdAt: at,
    responses: 0
  }

  if (rental) {
    doc.budget = budgetMode === 'nego'
      ? 0
      : (relaxed ? (Number(data.rent) > 0 ? parseAmount(data.rent, '月租金预算') : 0) : parseAmount(data.rent, '月租金预算'))
    doc.budgetUnit = cur.symbol + ' / 台 / 月'
    doc.term = arrayOfStrings(data.term, { field: '期望租期', max: 6, itemMax: 12 })
    if (!doc.term.length && !relaxed) throw new AppError(CODES.VALIDATION, '请选择期望租期')
    if (!relaxed) {
      doc.term.forEach((t) => {
        if (!RENT_TERMS.includes(t)) throw new AppError(CODES.VALIDATION, '租期取值不合法')
      })
    }
    doc.closed = relaxed ? str(data.closed, { field: '是否接受闭口价', max: 20 }) : enumOf(data.closed, ['接受闭口价', '只接受可议价'], '是否接受闭口价')
    doc.deposit = relaxed ? str(data.deposit, { field: '押金接受度', max: 20 }) : enumOf(data.deposit, RENT_DEPOSIT, '押金接受度')
    doc.pay = relaxed ? str(data.pay, { field: '期望支付方式', max: 20 }) : enumOf(data.pay, RENT_PAY, '期望支付方式')
    doc.rentLimits = arrayOfStrings(data.rentLimits, { field: '租赁条款要求', max: RENT_LIMITS.length, itemMax: 60 })
    if (!relaxed) {
      doc.rentLimits.forEach((c) => {
        if (!RENT_LIMITS.includes(c)) throw new AppError(CODES.VALIDATION, '租赁条款取值不合法')
      })
    }
    doc.cond = ''
    doc.condLevel = ''
    doc.city = ''
    doc.must = mustForDemand(rental, supply, data)
  } else {
    doc.budget = budgetMode === 'nego'
      ? 0
      : (relaxed ? (Number(data.budget) > 0 ? parseAmount(data.budget, '单台预算') : 0) : parseAmount(data.budget, '单台预算'))
    doc.budgetUnit = cur.symbol + ' / 台'
    doc.cond = str(data.cond, { field: '成色要求', max: 30 })
    doc.condLevel = str(data.condLevel, { field: '几成新', max: 12 })
    doc.city = str(data.city, { field: '交易地', required: !relaxed, max: 20 })
    doc.term = []
    doc.closed = ''
    doc.deposit = ''
    doc.pay = ''
    doc.rentLimits = []
    doc.must = mustForDemand(rental, supply, data)
  }

  /* 预算区间：最高预算必须高于最低预算；面议不落金额 */
  doc.budgetMode = budgetMode
  doc.budgetMax = 0
  if (budgetMode === 'range') {
    const max = relaxed
      ? (Number(data.budgetMax) > 0 ? parseAmount(data.budgetMax, '最高预算') : 0)
      : parseAmount(data.budgetMax, '最高预算')
    if (!relaxed && max <= doc.budget) throw new AppError(CODES.VALIDATION, '最高预算需高于最低预算')
    doc.budgetMax = max
  }

  doc.note = str(data.note, { field: '其他说明', max: 500 })
  doc.accept = str(data.accept, { field: '验收要求', max: 500 })
  doc.sameMachine = data.sameMachine !== false
  doc.codeAsk = data.codeAsk !== false
  /* 营业执照 / 验资视频等资质材料（选填）：只落元信息；编辑时未提交由调用方保留原件 */
  doc.media = normalizeMedia(data.media)
  return doc
}

/**
 * 需求侧必须条件：由「供给类型 / 同台互验 / 暗语视频」联动生成，客户端不能自定义。
 * 租赁场景固定含「明确租金 / 租期 / 押金条款」，期货场景改为租金资金监管。
 */
function mustForDemand(rental, supply, data) {
  const out = []
  if (rental) {
    out.push('明确租金 / 租期 / 押金条款')
    if (data.sameMachine !== false) out.push('接受同台互验')
    if (supply === '期货') out.push('支持租金资金监管账户')
    else out.push('提供设备实拍图片', '提供设备实拍视频')
    if (data.codeAsk !== false) out.push('可提供暗语视频（协商后录制）')
    return out
  }
  if (data.sameMachine !== false) out.push('接受同台互验')
  if (supply === '期货') out.push('支持资金监管账户')
  else out.push('提供设备实拍图片', '提供设备实拍视频')
  if (data.codeAsk !== false) out.push('可提供暗语视频（协商后录制）')
  return out
}

/**
 * 咨询人筛选规则判档（幂等）。
 *
 * 规则快照：调用方传入 rules（规则列表，含 id / name / tier / scope / enabled），
 * 判档只依据这份快照，不读「最新规则」，因此重放不会改变档位。
 *
 * @returns {{tier: string, tierName: string, hits: Array, ruleVersion: string}}
 */
function judgeTier({ rules, context }) {
  const enabled = (rules || []).filter((r) => r.enabled !== false)
  const version = enabled
    .map((r) => `${r.id}:${r.version || 1}`)
    .sort()
    .join(',')
  const hits = []
  let worst = TIERS.DEFAULT

  for (const rule of enabled) {
    const reason = evalRule(rule, context)
    if (!reason) continue
    hits.push({ ruleId: rule.id, ruleName: rule.name, tier: rule.tier, reason })
    if (rule.tier === TIERS.P0) worst = TIERS.P0
    else if (rule.tier === TIERS.P1 && worst !== TIERS.P0) worst = TIERS.P1
    else if (rule.tier === TIERS.P2 && worst === TIERS.DEFAULT) worst = TIERS.P2
  }

  const tierName = worst === TIERS.P0 ? 'P0 拦截'
    : worst === TIERS.P1 ? 'P1 待核'
      : worst === TIERS.P2 ? 'P2 优先' : '默认'
  return { tier: worst, tierName, hits, ruleVersion: version }
}

/**
 * 单条规则求值。规则用声明式条件，不写代码，避免线上改规则要发版。
 * 条件字段：blockedWords / keyword / action / blockedPhoneBidx / maxPerDay /
 *          requireMaterials / crossCategory / phoneInvalid / cat / minBudget
 */
function evalRule(rule, context) {
  const cond = rule.cond || {}
  /* 品类范围：声明 cat 的规则只对该品类生效，避免全平台误伤 */
  if (cond.cat && String(context.category || '') !== String(cond.cat)) return ''
  /* 手机号黑名单只比对盲索引，规则表不落明文号码 */
  if (Array.isArray(cond.blockedPhoneBidx) && cond.blockedPhoneBidx.length && context.phoneBidx) {
    if (cond.blockedPhoneBidx.indexOf(String(context.phoneBidx)) >= 0) return '命中手机号黑名单'
  }
  const words = cond.blockedWords || cond.keyword || cond.action
  if (Array.isArray(words) && words.length) {
    const hay = String(context.text || '').toLowerCase()
    for (const word of words) {
      if (word && hay.indexOf(String(word).toLowerCase()) >= 0) {
        return `命中禁用词：${word}`
      }
    }
  }
  if (cond.requireMaterials && context.materialCount < Number(cond.requireMaterials)) {
    return `资质材料不足 ${context.materialCount} / ${cond.requireMaterials}`
  }
  if (cond.maxPerDay && Number(context.perDayCount) > Number(cond.maxPerDay)) {
    return `当日咨询次数 ${context.perDayCount} 超过上限 ${cond.maxPerDay}`
  }
  if (cond.crossCategory && Number(context.crossCategoryCount) > Number(cond.crossCategory)) {
    return `跨品类刷单：${context.crossCategoryCount} 个品类`
  }
  if (cond.phoneInvalid && !/^1[3-9]\d{9}$/.test(String(context.phone || ''))) {
    return '手机号格式不合法'
  }
  if (cond.minBudget && Number(context.budget || 0) >= Number(cond.minBudget)) {
    return `预算 ${context.budget} 达到门槛 ${cond.minBudget}`
  }
  return ''
}

/**
 * 已拦截线索的复核窗口与自动清理时间。
 */
function blockedLifecycle(at) {
  return {
    at,
    reviewDeadline: at + BLOCKED_REVIEW_WINDOW_MS,
    cleanupAt: at + BLOCKED_CLEANUP_DAYS * 24 * 60 * 60 * 1000
  }
}

/**
 * 咨询热度：按买方主体去重，P0 已拦截不计入。
 * 同一买方重复咨询不重复计数，线索关闭后仍计入历史热度。
 */
function heatKey(lead) {
  return lead.buyerBidx || lead.uid || ''
}

function countHeat(leads) {
  const seen = new Set()
  for (const lead of leads || []) {
    if (lead.status === '已拦截') continue
    const key = heatKey(lead)
    if (key) seen.add(key)
  }
  return seen.size
}

module.exports = {
  SUPPLY_TYPES,
  CONDITIONS,
  TAX_OPTIONS,
  DELIVER_OPTIONS,
  RENT_DELIVER_OPTIONS,
  MUST_CONDITIONS,
  PUBLISH_MEDIA_LIMIT,
  PUBLISH_MEDIA_MAX_BYTES,
  normalizeMedia,
  isRental,
  sideOf,
  parseAmount,
  buildProduct,
  buildDemand,
  mustForDemand,
  judgeTier,
  evalRule,
  blockedLifecycle,
  heatKey,
  countHeat
}
