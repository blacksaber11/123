/**
 * 平台产品型号目录。
 *
 * 数据源优先级：
 *   1) 服务端 catalog.tree → 完整四级目录（内置型号库 + 管理端「产品型号库」覆盖，仅 active）；
 *   2) 本机 Storage 缓存（上一次成功拉取的目录，冷启动先渲染，不闪烁）；
 *   3) 内置静态目录（utils/mock.js 的 DEVICE_TREE，仅离线 / 接口异常时兜底）。
 *
 * 管理端增删型号后，用户在发布页下次进入即可看到，无需重新上传小程序版本。
 */

const M = require('./mock')
const { request } = require('./request')

/** 目录内存缓存有效期：服务端本身有 300s 缓存，这里短一些保证管理端操作后尽快生效 */
const TTL = 60 * 1000
const STORAGE_KEY = 'device_catalog_v1'

let cache = { tree: null, cats: null, at: 0 }
let inflight = null

function baseClone() {
  try {
    return JSON.parse(JSON.stringify(M.DEVICE_TREE || {}))
  } catch (e) {
    return {}
  }
}

function readStorage() {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return null
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (!raw || !raw.tree || typeof raw.tree !== 'object') return null
    return raw
  } catch (e) {
    return null
  }
}

function writeStorage(tree, at) {
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return
  try {
    wx.setStorageSync(STORAGE_KEY, { tree, cats: Object.keys(tree), at })
  } catch (e) {
    /* 缓存写入失败不影响使用 */
  }
}

/* 冷启动先用本机缓存的目录铺满滚轮，网络回来后再更新 */
const storedCache = readStorage()
if (storedCache) {
  cache = {
    tree: storedCache.tree,
    cats: storedCache.cats && storedCache.cats.length ? storedCache.cats : Object.keys(storedCache.tree),
    at: Number(storedCache.at) || 0
  }
}

/** 把平台记录合并进目录：active 补齐，disabled / removed 移除（仅旧接口 / 离线兜底使用） */
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

function snapshot(tree, at, persist) {
  cache = { tree: tree, cats: Object.keys(tree), at: at || Date.now() }
  if (persist) writeStorage(cache.tree, cache.at)
  return cache
}

/**
 * 读取目录。
 * @param {boolean} force 忽略缓存强制拉取
 * @returns {Promise<{tree: object, cats: string[]}>}
 *          网络失败时回退到本机缓存或内置目录，不阻塞发布流程。
 */
function loadCatalog(force) {
  const now = Date.now()
  if (!force && cache.tree && now - cache.at < TTL) return Promise.resolve(cache)
  if (inflight) return inflight

  inflight = request('user', 'catalog.tree', {}, { silent: true })
    .then((res) => {
      inflight = null
      /* 服务端已返回合并后的完整目录；旧版本接口只有 items，这里本地合并兜底 */
      if (res && res.tree) return snapshot(res.tree, Date.now(), true)
      const tree = baseClone()
      applyPlatform(tree, (res && res.items) || [])
      return snapshot(tree, Date.now(), true)
    })
    .catch(() => {
      inflight = null
      if (cache.tree) return cache
      return snapshot(baseClone(), now, false)
    })
  return inflight
}

/** 同步取当前目录（未加载过时返回本机缓存或内置目录），用于首屏兜底渲染 */
function currentTree() {
  if (cache.tree) return cache.tree
  return baseClone()
}

/** 同步取当前品类（与 currentTree 同源） */
function currentCats() {
  if (cache.cats && cache.cats.length) return cache.cats
  return Object.keys(currentTree())
}

module.exports = { loadCatalog, currentTree, currentCats, applyPlatform }
