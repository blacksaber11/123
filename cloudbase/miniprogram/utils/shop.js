/**
 * 商城数据适配层：后端投影 → 页面视图模型。
 *
 * 为什么需要这一层：
 * 1. 后端投影字段是「安全口径」（ownerLabel / publisherLabel / heat），
 *    页面模板需要的是「展示口径」（ownerText / priceText / published）；
 * 2. 页面之间共用同一套字段名，改一处不会只改到一半；
 * 3. 云端不可用时回落到本地演示数据，字段结构保持一致，页面不会因缺字段白屏。
 */
const M = require('./mock')

/* 关键信息清单模板：与 mock 同口径，仅用于展示提交状态 */
const CHECKLIST_TEMPLATE = [
  { n: '所有权证明' },
  { n: '设备图片' },
  { n: '规格文档' },
  { n: '第三方检测 / 验收报告' },
  { n: '支持同台核验' },
  { n: '支持先验后付' },
  { n: '支持短周期试用' },
  { n: '接单要求' }
]

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/* 时间戳 → 「12 分钟前 / 3 天前 / 2026-08-01」 */
function fmtPublished(at) {
  const n = Number(at)
  if (!n) return ''
  const diff = Date.now() - n
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const hour = Math.floor(min / 60)
  if (hour < 24) return hour + ' 小时前'
  const day = Math.floor(hour / 24)
  if (day < 30) return day + ' 天前'
  const d = new Date(n)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/* 金额 → 「24.8 万」，与 mock 展示口径一致 */
function moneyText(num) {
  const n = Number(num)
  if (!isFinite(n) || n <= 0) return ''
  if (n >= 10000) {
    const w = n / 10000
    const s = (Math.round(w * 100) / 100).toString()
    return s + ' 万'
  }
  return String(Math.round(n))
}

/* 币种符号：老数据没有 currencySymbol 时按人民币展示 */
function currencySymbolOf(doc) {
  const s = String((doc && doc.currencySymbol) || '')
  return s || '¥'
}

/* 价格口径：现场沟通 / 价格区间 / 固定单价；mode 缺省按固定单价，区间缺少最高价时退回单价 */
function priceModeOf(mode, low, max) {
  if (mode === 'nego') return 'nego'
  if (mode === 'range' && Number(max) > Number(low)) return 'range'
  return 'fixed'
}

function amountText(low, max, mode, sym) {
  const m = priceModeOf(mode, low, max)
  if (m === 'nego') return '现场沟通'
  const s = sym || '¥'
  const lo = moneyText(low)
  if (!lo) return ''
  if (m === 'range') return s + lo + ' - ' + s + moneyText(max)
  return s + lo
}

/* 单位只保留「/ 台」部分：币种已由金额前缀表达，避免与「元」重复 */
function unitOnly(unit) {
  const s = String(unit || '')
  const m = s.match(/^\S+\s*(\/.*)$/)
  return m ? m[1] : s
}

/* 税费多选（后端存 ' · ' 连接）→ 展示用短标签 */
function taxShort(tax) {
  const s = String(tax || '')
  if (!s) return '—'
  if (s.indexOf('可开专票') >= 0 || s.indexOf('含专票') >= 0) return '含税'
  if (s.indexOf('不含税') >= 0) return '不含税'
  return s.split(' · ')[0]
}

/* 出租 / 租赁判定 */
function isRentOf(doc) {
  return doc.tradeMode === '出租' || doc.tradeMode === '租赁'
}

/* 后端下发的公开媒体 → 展示用列表；没有媒体时返回空数组，由页面回退占位块 */
function mediaItemsOf(doc) {
  const list = Array.isArray(doc && doc.media) ? doc.media : []
  return list.map((m) => {
    if (!m) return null
    const url = m.url || m.fileId || m.src || ''
    if (!url) return null
    const type = String(m.type || m.mime || '')
    return {
      name: m.name || '',
      kind: m.kind === 'video' || /^video\//i.test(type) ? 'video' : 'image',
      type,
      url,
      /* 视频封面（上传时可能没有）：列表 / 详情页优先用它当预览图 */
      poster: m.poster || m.cover || ''
    }
  }).filter(Boolean)
}

/* 列表封面：优先第一张图片，只有视频时用视频封面（若有） */
function coverOf(doc) {
  const items = mediaItemsOf(doc)
  const img = items.filter((m) => m.kind === 'image')[0]
  if (img) return img.url
  const video = items.filter((m) => m.kind === 'video')[0]
  return (doc && doc.poster) || (video && video.poster) || ''
}

/* 发布时间：搜索排序与列表展示都以它为准 */
function publishedAtOf(doc) {
  return Number((doc && (doc.createdAt || doc.updatedAt)) || 0)
}

/* 统一补齐可选字段：模板与页面脚本对 undefined 求值也不会崩 */
function fillProduct(doc) {
  const rental = isRentOf(doc)
  const checklist = Array.isArray(doc.checklist) && doc.checklist.length
    ? doc.checklist
    : CHECKLIST_TEMPLATE.map((c) => ({ n: c.n, ok: false }))
  return Object.assign({
    term: '',
    closed: '',
    deposit: '',
    pay: '',
    rentLimits: [],
    must: [],
    nego: [],
    flow: [],
    images: 1,
    status: '',
    reviewReason: '',
    mine: false
  }, doc, {
    type: rental ? 'rent' : 'sell',
    isRent: rental,
    priceMode: priceModeOf(doc.priceMode, doc.price, doc.priceMax),
    priceText: amountText(doc.price, doc.priceMax, doc.priceMode, currencySymbolOf(doc)),
    priceUnit: priceModeOf(doc.priceMode, doc.price, doc.priceMax) === 'nego' ? '' : (unitOnly(doc.priceUnit) || '/ 台'),
    currencyLabel: doc.currencyLabel || '人民币',
    taxShort: taxShort(doc.tax),
    published: fmtPublished(doc.createdAt),
    publishedAt: publishedAtOf(doc),
    /* 实拍图 / 视频：列表显示封面，详情页显示全部 */
    cover: coverOf(doc),
    mediaItems: mediaItemsOf(doc),
    subText: [doc.brand, doc.model, doc.city].filter(Boolean).join(' · '),
    /* 私密发布＝匿名公开：内容照常展示，发布者只显示「匿名发布」且不可进主页 */
    anon: doc.privateShare === true,
    ownerShort: doc.platformOnly ? '平' : (doc.privateShare === true ? '匿' : '货'),
    ownerText: doc.privateShare === true
      ? '匿名发布'
      : (doc.ownerExposureLabel || doc.ownerLabel || '货主'),
    /* 平台代采 / 代售：只对用户展示「平台」，不暴露委托方主体 */
    platformOnly: doc.platformOnly === true,
    agencyId: doc.agencyId || '',
    ownerSubject: doc.ownerSubject || '',
    ownerContactName: doc.ownerContactName || '',
    ownerPhoneMasked: doc.ownerPhoneMasked || '',
    ownerExposure: doc.ownerExposure || 'hidden',
    owner: {
      short: doc.platformOnly ? '平' : '货',
      nick: doc.ownerExposureLabel || doc.ownerLabel || '货主',
      /* 只有「公开主体」才拿到主体，手机号始终脱敏 */
      realname: doc.platformOnly ? '平台' : (doc.ownerSubject || '未公开主体'),
      contact: doc.ownerContactName || '',
      phone: doc.ownerPhoneMasked || '',
      deals: ''
    },
    /* 商品标签由发布者自己填写，展示在详情页标签区 */
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    inquiries: Number(doc.heat) || 0,
    views: Number(doc.views) || 0,
    favCount: Number(doc.favCount) || 0,
    checklist: checklist.map((c) => ({
      n: c.n,
      ok: !!c.ok,
      statusText: c.ok ? '已上传' : '未上传',
      text: ''
    })),
    checklistDone: checklist.filter((c) => !!c.ok).length,
    checklistTotal: checklist.length
  })
}

/* 统一补齐可选字段：求购需求 */
function fillDemand(doc) {
  const rental = isRentOf(doc)
  const term = Array.isArray(doc.term) ? doc.term : []
  return Object.assign({
    termText: '',
    closed: '',
    flow: [],
    must: [],
    nego: [],
    tags: [],
    cond: '',
    accept: '',
    deliver: '',
    contact: '',
    status: '',
    responses: 0,
    views: 0,
    budgetText: '',
    budgetUnit: '',
    publisher: '',
    mine: false
  }, doc, {
    isRent: rental,
    budgetMode: priceModeOf(doc.budgetMode, doc.budget, doc.budgetMax),
    budgetText: amountText(doc.budget, doc.budgetMax, doc.budgetMode, currencySymbolOf(doc)),
    budgetUnit: priceModeOf(doc.budgetMode, doc.budget, doc.budgetMax) === 'nego' ? '' : (unitOnly(doc.budgetUnit) || '/ 台'),
    currencyLabel: doc.currencyLabel || '人民币',
    termText: term.join(' / '),
    published: fmtPublished(doc.createdAt),
    publishedAt: publishedAtOf(doc),
    cover: coverOf(doc),
    mediaItems: mediaItemsOf(doc),
    /* 私密发布＝匿名公开：需求照常展示，发布方只显示「匿名发布」 */
    anon: doc.privateShare === true,
    contact: doc.privateShare === true ? '匿名发布' : (doc.publisherLabel || '企业'),
    publisher: doc.privateShare === true ? '匿名发布' : (doc.publisherLabel || '企业'),
    ownerExposure: doc.ownerExposure || 'hidden',
    /* 平台代采 / 代售：只展示「平台」，不暴露委托方 */
    platformOnly: doc.platformOnly === true,
    agencyId: doc.agencyId || '',
    ownerExposureLabel: doc.privateShare === true ? '匿名发布' : (doc.ownerExposureLabel || '平台核验 · 主体已隐藏'),
    ownerSubject: doc.ownerSubject || '',
    ownerContactName: doc.ownerContactName || '',
    ownerPhoneMasked: doc.ownerPhoneMasked || ''
  })
}

/** 后端商品投影 → 页面视图模型 */
function toProduct(doc) {
  if (!doc) return null
  return fillProduct(doc)
}

/** 后端需求投影 → 页面视图模型 */
function toDemand(doc) {
  if (!doc) return null
  return fillDemand(doc)
}

/** 列表批量转换 */
function toProducts(list) {
  return (list || []).map(toProduct).filter(Boolean)
}

function toDemands(list) {
  return (list || []).map(toDemand).filter(Boolean)
}

module.exports = {
  toProduct,
  toDemand,
  toProducts,
  toDemands,
  fillProduct,
  fillDemand,
  moneyText,
  amountText,
  priceModeOf,
  taxShort,
  fmtPublished,
  isRentOf
}
