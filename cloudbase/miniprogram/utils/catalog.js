/**
 * 平台产品型号目录。
 *
 * 真源分两层：
 *   1) 内置静态目录（utils/mock.js 的 DEVICE_TREE，由 cloudbase/device-catalog.js 同步生成）；
 *   2) 管理端「产品型号库」维护的增量记录（catalog 集合，动作 catalog.tree）。
 *
 * 发布页的四级滚轮读这里：静态目录兜底、离线可用，平台新增/停用的型号在联网后合并进滚轮。
 */

const M = require('./mock')
const { request } = require('./request')

/** 目录缓存有效期：新增型号后最多 30s 生效，页面 onLoad 会主动刷新 */
const TTL = 30 * 1000

let cache = { tree: null, cats: null, at: 0 }
let inflight = null

function baseClone() {
  try {
    return JSON.parse(JSON.stringify(M.DEVICE_TREE || {}))
  } catch (e) {
    return {}
  }
}

/** 把平台记录合并进目录：active 补齐，disabled / removed 移除 */
function applyPlatform(tree, items) {
  ;(items || []).forEach((item) => {
    if (!item || !item.cat || !item.brand || !item.series || !item.model) return
    const disabled = item.status === 'disabled' || item.status === 'removed'
    if (disabled) {
      const brandMap = tree[item.cat] && tree[item.cat][item.brand]
      const arr = brandMap && brandMap[item.series]
      if (!arr) return
      const i = arr.indexOf(item.model)
      if (i >= 0) arr.splice(i, 1)
      if (!arr.length) delete brandMap[item.series]
      if (!Object.keys(brandMap).length) delete tree[item.cat][item.brand]
      if (tree[item.cat] && !Object.keys(tree[item.cat]).length) delete tree[item.cat]
      return
    }
    const cat = tree[item.cat] || (tree[item.cat] = {})
    const brand = cat[item.brand] || (cat[item.brand] = {})
    const series = brand[item.series] || (brand[item.series] = [])
    if (series.indexOf(item.model) < 0) series.push(item.model)
  })
}

function snapshot(tree, at) {
  cache = { tree: tree, cats: Object.keys(tree), at: at || Date.now() }
  return cache
}

/**
 * 读取目录。
 * @param {boolean} force 忽略缓存强制拉取
 * @returns {Promise<{tree: object, cats: string[]}>}
 *          网络失败时回退到内置目录或上一次缓存，不阻塞发布流程。
 */
function loadCatalog(force) {
  const now = Date.now()
  if (!force && cache.tree && now - cache.at < TTL) return Promise.resolve(cache)
  if (inflight) return inflight

  inflight = request('user', 'catalog.tree', {}, { silent: true })
    .then((res) => {
      inflight = null
      const tree = baseClone()
      applyPlatform(tree, (res && res.items) || [])
      return snapshot(tree, Date.now())
    })
    .catch(() => {
      inflight = null
      if (cache.tree) return cache
      return snapshot(baseClone(), now)
    })
  return inflight
}

/** 同步取当前目录（未加载过时返回内置目录），用于兜底渲染 */
function currentTree() {
  if (cache.tree) return cache.tree
  return baseClone()
}

module.exports = { loadCatalog, currentTree, applyPlatform }
