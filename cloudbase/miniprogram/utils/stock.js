/**
 * 我的库存：本机维护的现货清单。
 *
 * 用途：
 * 1. 商机池里已缴费的代采 / 代售委托，按库存自动匹配后加入商机；
 * 2. 广场上的求购需求，库存能对上时可以领取并查看联系方式。
 *
 * 库存只用于本人视角的匹配，不对其他用户公开；云端 stock.list 就绪后
 * 由服务端数据覆盖，本地结构保持一致。
 */
const KEY = 'suanli_stock_v1'

const STATUS_ON = '在售'
const STATUS_OFF = '已下架'

/* 成色口径：页面上单选，导出与匹配文案共用同一份 */
const CONDS = ['全新', '99新', '95新', '9成新', '8成新及以下']

/* 单位随品类走：卡按张、内存按根、整机按台 */
function unitOf(cat) {
  const name = String(cat || '')
  if (/内存/.test(name)) return '元 / 根'
  if (/加速卡|显卡/.test(name)) return '元 / 张'
  if (/服务器|整机|一体机/.test(name)) return '元 / 台'
  return '元 / 件'
}

/* 演示库存：与首页实时货盘、求购需求的型号保持可匹配 */
function seed() {
  const now = Date.now()
  return [
    { id: 'sk1', cat: 'GPU 加速卡', brand: 'NVIDIA', model: 'H100 80G SXM', qty: 6, price: 228000, unit: '元 / 张', city: '深圳', cond: '全新', note: '原厂盒装，未拆封，可提供序列号与出厂检测报告。', status: STATUS_ON, at: now - 86400000 * 2 },
    { id: 'sk2', cat: 'GPU 加速卡', brand: 'NVIDIA', model: 'A100 80G PCIE', qty: 20, price: 102000, unit: '元 / 张', city: '上海', cond: '99新', note: '机房在役 8 个月，无维修记录，风扇与供电接口完好。', status: STATUS_ON, at: now - 86400000 * 3 },
    { id: 'sk3', cat: 'GPU 加速卡', brand: 'NVIDIA', model: 'L40S 48G', qty: 16, price: 148000, unit: '元 / 张', city: '杭州', cond: '95新', note: '一张外壳有轻微磕碰（不影响使用），其余外观完好。', status: STATUS_ON, at: now - 86400000 * 5 },
    { id: 'sk4', cat: '内存条', brand: '金百达', model: 'DDR5 64G 6400', qty: 200, price: 1880, unit: '元 / 根', city: '深圳', cond: '全新', note: '原厂封装，整箱 200 根，不拆零。', status: STATUS_ON, at: now - 86400000 * 8 }
  ]
}

function read() {
  try {
    const saved = wx.getStorageSync(KEY)
    /* 空数组也算已初始化：删光库存后不能又把演示数据放回来 */
    if (Array.isArray(saved)) return saved
  } catch (err) {
    /* 读取失败回落演示库存 */
  }
  return seed()
}

function write(list) {
  try {
    wx.setStorageSync(KEY, list)
  } catch (err) {
    /* 写入失败不影响当前页展示 */
  }
}

function list() {
  return read().map((x) => Object.assign({}, x))
}

/* 图片：云端 fileID / https 链接，最多 5 张；本机只做展示 */
const IMAGE_LIMIT = 5

function imagesOf(src) {
  const list = Array.isArray(src) ? src : []
  return list.filter(Boolean).slice(0, IMAGE_LIMIT)
}

/** 云端 / 本地统一结构：字段缺失一律补默认值，页面不需要再做防御式判断 */
function normalize(doc) {
  const d = doc || {}
  return {
    id: String(d.id || d._id || ''),
    cat: d.cat || '其他配件',
    brand: d.brand || '',
    model: String(d.model || ''),
    qty: Number(d.qty) || 0,
    price: Number(d.price) || 0,
    unit: d.unit || unitOf(d.cat),
    city: d.city || '',
    cond: d.cond || '',
    note: String(d.note || ''),
    images: imagesOf(d.images),
    status: d.status === STATUS_OFF ? STATUS_OFF : STATUS_ON,
    at: Number(d.at || d.updatedAt || d.createdAt) || 0
  }
}

/** 云端拉回后整体覆盖本地缓存，返回归一化后的列表 */
function replaceAll(list) {
  const next = (Array.isArray(list) ? list : []).map(normalize)
  write(next)
  return next
}

function active() {
  return list().filter((x) => x.status === STATUS_ON)
}

function add(item) {
  const src = item || {}
  const next = list()
  next.unshift({
    /* 允许页面预生成 id：本地与云端用同一个标识，保存后不需要再改名 */
    id: src.id || 'sk' + Date.now(),
    cat: src.cat || '其他配件',
    brand: src.brand || '',
    model: String(src.model || '').trim(),
    qty: Number(src.qty) || 0,
    price: Number(src.price) || 0,
    unit: src.unit || unitOf(src.cat),
    city: src.city || '',
    cond: src.cond || '',
    note: String(src.note || '').trim(),
    images: imagesOf(src.images),
    status: STATUS_ON,
    at: Date.now()
  })
  write(next)
  return next
}

/* 手动修改库存：只改展示与匹配相关字段，状态保持原样，at 记为最近修改时间 */
function update(id, patch) {
  const src = patch || {}
  const next = list().map((x) => {
    if (x.id !== id) return x
    const merged = Object.assign({}, x)
    if (src.cat != null) merged.cat = src.cat
    if (src.brand != null) merged.brand = src.brand
    if (src.model != null) merged.model = String(src.model).trim()
    if (src.qty != null) merged.qty = Number(src.qty) || 0
    if (src.price != null) merged.price = Number(src.price) || 0
    /* 换了设备类型，单位跟着品类走，避免「内存条 / 张」这种错配 */
    if (src.cat != null) merged.unit = src.unit || unitOf(src.cat)
    else if (src.unit != null) merged.unit = src.unit
    if (src.city != null) merged.city = src.city
    if (src.cond != null) merged.cond = src.cond
    if (src.note != null) merged.note = String(src.note).trim()
    if (src.images != null) merged.images = imagesOf(src.images)
    merged.at = Date.now()
    return merged
  })
  write(next)
  return next
}

function remove(id) {
  const next = list().filter((x) => x.id !== id)
  write(next)
  return next
}

function toggle(id) {
  const next = list().map((x) => {
    if (x.id !== id) return x
    return Object.assign({}, x, { status: x.status === STATUS_ON ? STATUS_OFF : STATUS_ON })
  })
  write(next)
  return next
}

/* 型号归一与匹配：与云函数共用同一份实现（scripts/sync-shared.mjs 生成） */
const { normModel, modelHit, modelMatch } = require('./model')

/**
 * 库存匹配：设备类型硬校验 + 核心型号命中 + 数量 / 城市 / 成色，
 * 与云函数 shared/market.js 的 stockMatch 同口径。
 * 品牌不参与：客户要 B300 时，超微 / 戴尔 / 超聚变等任何厂商的 B300 都算命中。
 *
 * opp.qty  对方需要的最小数量，库存合计不足时不算命中
 * opp.city 对方要求的城市，双方都填了才比对
 * opp.cond 对方要求的成色，双方都填了才比对（「不限」视为未填）
 */
function normPlace(value) {
  const text = String(value == null ? '' : value).trim()
  return text === '不限' ? '' : text
}

function matchStock(opp) {
  const target = opp || {}
  const cat = String(target.cat || '')
  const model = String(target.model || '')
  const needQty = Number(target.qty) || 0
  const needCity = normPlace(target.city)
  const needCond = normPlace(target.cond)
  const items = active().filter((s) => {
    if (cat && s.cat && s.cat !== cat) return false
    if (model) {
      if (!modelMatch(s.model, model)) return false
    } else if (!cat) {
      /* 品类与型号都没填，无法判断是否匹配 */
      return false
    }
    if (needCity && s.city && normPlace(s.city) !== needCity) return false
    if (needCond && s.cond && normPlace(s.cond) !== needCond) return false
    return true
  })
  const qty = items.reduce((n, s) => n + (Number(s.qty) || 0), 0)
  const enough = needQty <= 0 || qty >= needQty
  return {
    ok: items.length > 0 && enough,
    items: items,
    qty,
    text: items.map((s) => s.model + ' × ' + s.qty).join('、')
  }
}

function stats() {
  const all = list()
  const on = all.filter((x) => x.status === STATUS_ON)
  return {
    sku: on.length,
    total: all.length,
    qty: on.reduce((n, x) => n + (Number(x.qty) || 0), 0)
  }
}

module.exports = {
  KEY, STATUS_ON, STATUS_OFF, CONDS, unitOf,
  list, active, add, update, remove, toggle, matchStock, modelHit, modelMatch, stats, replaceAll
}
