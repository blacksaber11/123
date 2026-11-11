'use strict'

const { AppError, CODES } = require('./errors')
const { VISIBILITIES, VISIBILITY_LABELS } = require('./constants')

/**
 * 对外投影：列表 / 详情绝不返回手机号、证件号、材料原件、密文、盲索引。
 * 只有 contact.reveal（admin + 已对接 + 原因 + 审计）能输出明文手机号。
 */

function pick(obj, keys) {
  const out = {}
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) out[key] = obj[key]
  }
  return out
}

/**
 * 图片 / 视频列表：只下发展示所需的地址与类型，不含本地路径等内部字段。
 * 媒体是公开内容，浏览者可直接看到实拍图。
 */
function projectMedia(media) {
  return (Array.isArray(media) ? media : []).map((m) => {
    if (!m) return null
    const url = m.fileId || m.url || ''
    if (!url) return null
    const type = String(m.type || m.mime || '')
    return {
      name: m.name || '',
      kind: m.kind === 'video' || /^video\//i.test(type) ? 'video' : 'image',
      type,
      url
    }
  }).filter(Boolean)
}

/**
 * 商品 / 货源投影。
 * 出售与出租共用一张表，用 tradeMode 区分字段；租赁字段（租期 / 闭口价 / 押金 /
 * 支付方式 / 租赁限制条款）在出售场景不存在，不会带出。
 */
const PRODUCT_FIELDS = [
  'id', 'tradeMode', 'side', 'title', 'cat', 'brand', 'model', 'qty', 'minQty',
  'price', 'priceMax', 'priceMode', 'priceUnit', 'currency', 'currencySymbol', 'currencyLabel',
  'supply', 'tax', 'city', 'cond', 'condLevel', 'deliver', 'status', 'createdAt', 'tags', 'images'
]

const PRODUCT_RENT_FIELDS = ['term', 'closed', 'deposit', 'pay', 'rentLimits', 'must', 'nego', 'flow']

const PRODUCT_SELL_FIELDS = ['must', 'nego', 'flow']

function projectProduct(product) {
  if (!product) return null
  const rental = product.tradeMode === '出租'
  const out = pick(product, PRODUCT_FIELDS)
  const extra = rental ? PRODUCT_RENT_FIELDS : PRODUCT_SELL_FIELDS
  for (const key of extra) {
    if (product[key] !== undefined && product[key] !== null) out[key] = product[key]
  }
  out.note = product.note || ''
  out.accept = product.accept || ''
  out.requirements = product.requirements || ''
  out.limit = product.limit || ''
  /* 货主身份只给匿名主体标识，不给 openid、公司名、联系人、电话 */
  out.ownerLabel = '货主'
  /* 形式审核驳回原因：仅属主在「已驳回」状态下可见（对外状态不可见，不会外泄） */
  out.reviewReason = product.reviewReason || ''
  /* 管理端强制下架原因：同样只对属主可见 */
  out.offlineReason = product.offlineReason || ''
  out.heat = Number(product.heat) || 0
  /* 浏览量：详情页被打开的次数，属主自己打开不计入 */
  out.views = Number(product.views) || 0
  /* 可见范围：前端据此给保密内容打「保密」标识 */
  out.visibility = product.visibility === VISIBILITIES.PRIVATE ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC
  out.visibilityLabel = VISIBILITY_LABELS[out.visibility]
  out.isPrivate = out.visibility === VISIBILITIES.PRIVATE
  /* 实拍图片 / 视频：列表封面与详情页展示实物用 */
  out.media = projectMedia(product.media)
  return out
}

/**
 * 求购 / 需求投影：不返回买方 ID 对应的公司名、联系人与材料。
 */
const DEMAND_FIELDS = [
  'id', 'tradeMode', 'side', 'title', 'cat', 'brand', 'model', 'qty',
  'budget', 'budgetMax', 'budgetMode', 'budgetUnit', 'currency', 'currencySymbol', 'currencyLabel',
  'supply', 'tax', 'city', 'cond', 'condLevel', 'status', 'createdAt', 'responses'
]

const DEMAND_RENT_FIELDS = ['term', 'closed', 'deposit', 'pay', 'rentLimits', 'must', 'sameMachine', 'codeAsk', 'nego', 'flow']

const DEMAND_SELL_FIELDS = ['must', 'sameMachine', 'codeAsk', 'nego', 'flow']

function projectDemand(demand) {
  if (!demand) return null
  const rental = demand.tradeMode === '租赁'
  const out = pick(demand, DEMAND_FIELDS)
  const extra = rental ? DEMAND_RENT_FIELDS : DEMAND_SELL_FIELDS
  for (const key of extra) {
    if (demand[key] !== undefined && demand[key] !== null) out[key] = demand[key]
  }
  out.note = demand.note || ''
  out.accept = demand.accept || ''
  /* 审核退回 / 下架原因：仅属主可见 */
  out.reviewReason = demand.reviewReason || ''
  out.offlineReason = demand.offlineReason || ''
  /* 买方身份同样不下发 openid */
  out.publisherLabel = '企业'
  out.heat = Number(demand.heat) || 0
  /* 浏览量：详情页被打开的次数 */
  out.views = Number(demand.views) || 0
  /* 可见范围：前端据此给保密内容打「保密」标识 */
  out.visibility = demand.visibility === VISIBILITIES.PRIVATE ? VISIBILITIES.PRIVATE : VISIBILITIES.PUBLIC
  out.visibilityLabel = VISIBILITY_LABELS[out.visibility]
  out.isPrivate = out.visibility === VISIBILITIES.PRIVATE
  /* 需求方上传的实拍 / 参考图：列表封面与详情页展示用 */
  out.media = projectMedia(demand.media)
  return out
}

/** 用户自己的线索 */
function projectLeadForUser(lead, targetTitle) {
  return {
    id: lead.id,
    status: lead.status,
    productId: lead.productId || '',
    demandId: lead.demandId || '',
    title: targetTitle || '',
    matchPct: Number(lead.matchPct) || 0,
    contactReleased: !!lead.contactReleased,
    /* 催办留痕：用户端据此展示「已催办」，管理端据此置顶提醒坐席 */
    remindedAt: Number(lead.remindedAt) || 0,
    remindCount: Number(lead.remindCount) || 0,
    createdAt: lead.createdAt
  }
}

/**
 * 管理端（cs 与 admin 同一份；联系方式永不出现）。
 * 档位与命中原因对坐席可见，但不含规则正文与身份。
 */
function projectLeadForStaff(lead) {
  return {
    id: lead.id,
    source: lead.source,
    productId: lead.productId || '',
    demandId: lead.demandId || '',
    /* 代采 / 代售平台对接工单：targetType=agency，targetId 指向委托 */
    targetType: lead.targetType || '',
    targetId: lead.targetId || '',
    agencyId: lead.agencyId || '',
    formSummary: lead.formSummary || '',
    compare: Array.isArray(lead.compare) ? lead.compare.map((row) => ({
      n: row.n,
      req: row.req,
      filled: row.filled,
      res: row.res,
      note: row.note || ''
    })) : [],
    matchPct: Number(lead.matchPct) || 0,
    status: lead.status,
    tier: lead.tier || '默认',
    tierName: lead.tierName || '',
    assignedTo: lead.assignedTo || '',
    assignedAccount: lead.assignedAccount || '',
    assignedAt: lead.assignedAt || 0,
    contactReleased: !!lead.contactReleased,
    /* 用户催办：管理端线索列表展示「已催办」标记 */
    remindedAt: Number(lead.remindedAt) || 0,
    remindCount: Number(lead.remindCount) || 0,
    createdAt: lead.createdAt
  }
}

/** 求购 / 商品在管理端的摘要（仍然不带手机号） */
function projectProductForStaff(product) {
  const out = projectProduct(product)
  out.hasOwnerPhone = !!product.ownerPhoneCipher
  out.checklist = Array.isArray(product.checklist)
    ? product.checklist.map((c) => ({ n: c.n, ok: !!c.ok }))
    : []
  /* 用户上传的图片 / 视频：仅管理端可见，含上传得到的 fileId，审核时直接展示原件 */
  out.media = Array.isArray(product.media)
    ? product.media.map((m) => ({
      name: (m && m.name) || '',
      type: (m && m.type) || '',
      kind: (m && m.kind) || 'image',
      size: Number(m && m.size) || 0,
      fileId: (m && m.fileId) || ''
    }))
    : []
  return out
}

/**
 * 扫描返回体：密文 / 盲索引 / 材料原件字段一律视为投影泄漏（这些字段不允许出站）。
 * 用户主动填写的手机号 / 证件号不再拦截——平台允许用户直接发布或留言联系方式。
 */
function assertNoPlaintextContact(value, path, depth) {
  return scan(value, path || 'body', depth || 0)
}

/**
 * 扫描返回体，兼容旧调用签名。
 * 明文手机号 / 证件号不再视为泄漏（用户可直接发布联系方式）；
 * 只拦截密文、盲索引、材料原件路径等内部字段出站。
 */
function assertNoPlaintextContactAllowingPhone(value, allowPath, path, depth) {
  return scan(value, path || 'body', depth || 0, allowPath || '')
}

function scan(value, p, level, allowPath) {
  if (level > 8) return true
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return true
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scan(item, `${p}[${idx}]`, level + 1, allowPath))
    return true
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (/(cipher|phonebidx|idcard|storagepath|original|blindindex|bidx)/i.test(key)) {
        throw new AppError(CODES.INTERNAL, '服务暂时不可用', { leakAt: `${p}.${key}` })
      }
      scan(value[key], `${p}.${key}`, level + 1, allowPath)
    }
    return true
  }
  return true
}

module.exports = {
  PROJECT_FIELDS: Object.freeze({
    product: PRODUCT_FIELDS,
    productRent: PRODUCT_RENT_FIELDS,
    productSell: PRODUCT_SELL_FIELDS,
    demand: DEMAND_FIELDS,
    demandRent: DEMAND_RENT_FIELDS,
    demandSell: DEMAND_SELL_FIELDS
  }),
  projectProduct,
  projectDemand,
  projectLeadForUser,
  projectLeadForStaff,
  projectProductForStaff,
  assertNoPlaintextContact,
  assertNoPlaintextContactAllowingPhone
}
