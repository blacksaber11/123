/**
 * 收藏 / 关注：本地缓存 + 云端同步。
 * 本地缓存保证首屏秒开与离线可用，云端保证换手机不丢；
 * 收藏与关注都不通知对方，货主不会知道你收藏 / 关注了。
 */
const { request } = require('./request')

const FAV_KEY = 'suanli_fav_v1'
/* 云端写失败时留在本地的待同步队列，下次 pull 时补发 */
const PENDING_KEY = 'suanli_fav_pending_v1'
const PENDING_MAX = 200
/* 最近一次成功对账的服务端时间戳：用于增量拉取；为空说明是首次 / 换设备，走全量 */
const FAV_SYNC_KEY = 'suanli_fav_sync_v1'
const FOLLOW_SYNC_KEY = 'suanli_follow_sync_v1'
/* 本地优先：同一端 5 分钟内不重复对账，避免频繁切页打服务器 */
const SYNC_TTL_MS = 5 * 60 * 1000
/* 连续点收藏合并成一批再写，减少云端写入请求 */
const FLUSH_DELAY_MS = 800

/** 只接受字符串 id 的数组；旧版本缓存被改写或结构异常时回落到空数组 */
function idList(v) {
  if (!Array.isArray(v)) return []
  return v.filter((x) => typeof x === 'string' && x)
}

function read() {
  try {
    const raw = wx.getStorageSync(FAV_KEY)
    if (raw && typeof raw === 'object') {
      return { product: idList(raw.product), demand: idList(raw.demand), news: idList(raw.news) }
    }
  } catch (e) {}
  return { product: [], demand: [], news: [] }
}

function write(data) {
  try {
    wx.setStorageSync(FAV_KEY, {
      product: idList(data && data.product),
      demand: idList(data && data.demand),
      news: idList(data && data.news)
    })
  } catch (e) {}
}

/* ========== 云端同步（本地优先） ==========
   微信式取舍：收藏 / 关注这类「关系数据」本地常驻，云端只做备份与换机恢复；
   浏览记录、筛选条件等只留本地，不上传。
   - 页面先读本地缓存渲染，后台再做增量对账；
   - 同一端 5 分钟内不重复请求，连续操作合并成一批再写；
   - 写入失败进队列，下次进入「我的」或退出页面时补发。 */
function readSync(key) {
  try {
    return Number(wx.getStorageSync(key)) || 0
  } catch (e) {
    return 0
  }
}

function writeSync(key, at) {
  if (!at) return
  try {
    wx.setStorageSync(key, Number(at))
  } catch (e) {}
}

function readPending() {
  try {
    const raw = wx.getStorageSync(PENDING_KEY)
    return Array.isArray(raw) ? raw.filter((x) => x && x.key) : []
  } catch (e) {
    return []
  }
}

function writePending(list) {
  try {
    wx.setStorageSync(PENDING_KEY, (Array.isArray(list) ? list : []).slice(-PENDING_MAX))
  } catch (e) {}
}

/** 同一对象只保留最后一次操作，避免队列里「收藏 + 取消」重复往返 */
function enqueue(op) {
  const rest = readPending().filter((x) => x.key !== op.key)
  rest.push(op)
  writePending(rest)
}

async function pushOp(op) {
  if (op.kind === 'follow') {
    await request('user', 'follow.set', { id: op.id, type: op.type || 'account', nick: op.nick, city: op.city, on: op.on }, { silent: true })
    return
  }
  await request('user', 'fav.set', { type: op.type, id: op.id, on: op.on }, { silent: true })
}

/* 连续操作先入队，延迟合并推送；退出页面时用 flushNow 立刻发 */
let flushTimer = null

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPending().catch(() => {})
  }, FLUSH_DELAY_MS)
}

async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushPending()
}

function pushFav(type, id, on) {
  const op = { kind: 'fav', key: 'fav:' + normType(type) + ':' + id, type: normType(type), id, on }
  enqueue(op)
  scheduleFlush()
}

function pushFollow(acc, on) {
  const a = acc || {}
  if (!a.id) return
  const type = a.type === 'product' ? 'product' : 'account'
  const op = {
    kind: 'follow', key: 'follow:' + type + ':' + a.id, id: String(a.id), type,
    nick: a.nick || (type === 'product' ? '商品' : '货主'), city: a.city || '', on: on !== false
  }
  enqueue(op)
  scheduleFlush()
}

/** 补发队列：成功的移除，失败的留下次再试 */
async function flushPending() {
  const queue = readPending()
  if (!queue.length) return
  const rest = []
  for (let i = 0; i < queue.length; i += 1) {
    try {
      await pushOp(queue[i])
    } catch (e) {
      rest.push(queue[i])
    }
  }
  writePending(rest)
}

/** 增量合并：先删云端告知已取消的，再补上云端有变化的 */
function mergeIds(localIds, cloudIds, removedIds) {
  const drop = {}
  ;(removedIds || []).forEach((id) => { drop[id] = 1 })
  const out = localIds.filter((id) => !drop[id])
  ;(cloudIds || []).forEach((id) => {
    if (id && out.indexOf(id) < 0) out.push(id)
  })
  return out
}

/** 还没推送成功的本地操作重新盖回结果，避免拉取把刚点的收藏冲掉 */
function replayPendingFav(data) {
  readPending().filter((op) => op.kind === 'fav').forEach((op) => {
    const type = normType(op.type)
    const list = data[type]
    const i = list.indexOf(op.id)
    if (op.on && i < 0) list.push(op.id)
    if (!op.on && i >= 0) list.splice(i, 1)
  })
  return data
}

function replayPendingFollow(list) {
  const out = list.slice()
  readPending().filter((op) => op.kind === 'follow').forEach((op) => {
    const i = out.findIndex((f) => f.id === op.id)
    if (op.on && i < 0) {
      out.push({
        id: op.id,
        type: op.type === 'product' ? 'product' : 'account',
        nick: op.nick || '货主',
        short: String(op.nick || '货').slice(-1),
        city: op.city || '',
        /* 待对账的本地关注不做认证声明，等后台同步后再展示徽标 */
        verified: false,
        at: Date.now()
      })
    }
    if (!op.on && i >= 0) out.splice(i, 1)
  })
  return out
}

/**
 * 后台对账：页面已用本地缓存渲染，这里只做增量同步。
 * 返回 true 表示本地数据有更新（调用方可重绘），false 表示跳过 / 离线。
 */
async function pull(options) {
  const force = !!(options && options.force)
  const favAt = readSync(FAV_SYNC_KEY)
  const followAt = readSync(FOLLOW_SYNC_KEY)
  const hasPending = readPending().length > 0
  /* 刚同步过、也没有待补发的变更：直接跳过，不打服务器 */
  if (!force && !hasPending && favAt && Date.now() - favAt < SYNC_TTL_MS) return false

  await flushPending()
  const offline = readPending().length > 0
  let changed = false

  try {
    const favs = await request('user', 'fav.list', { since: favAt }, { silent: true })
    const local = read()
    let product = local.product
    let demand = local.demand
    let news = local.news
    if (favs && favs.full) {
      product = (favs.product || []).map((x) => x.id).filter(Boolean)
      demand = (favs.demand || []).map((x) => x.id).filter(Boolean)
      news = (favs.news || []).map((x) => x.id).filter(Boolean)
    } else if (favs) {
      const removed = favs.removed || {}
      product = mergeIds(product, (favs.product || []).map((x) => x.id).filter(Boolean), removed.product)
      demand = mergeIds(demand, (favs.demand || []).map((x) => x.id).filter(Boolean), removed.demand)
      news = mergeIds(news, (favs.news || []).map((x) => x.id).filter(Boolean), removed.news)
    }
    const next = offline ? replayPendingFav({ product, demand, news }) : { product, demand, news }
    write(next)
    /* 时间戳用服务端时间，避免手机时钟不准导致漏同步 */
    writeSync(FAV_SYNC_KEY, (favs && favs.serverTime) || Date.now())
    changed = true
  } catch (e) {
    /* 云端不可用：保持本地缓存，不影响使用 */
  }

  try {
    const res = await request('user', 'follow.list', { since: followAt }, { silent: true })
    const remote = (res && res.items) || []
    let list
    if (!res || res.full) {
      list = remote
    } else {
      const drop = {}
      ;(res.removed || []).forEach((id) => { drop[id] = 1 })
      const byId = {}
      readFollows().forEach((f) => { if (!drop[f.id]) byId[f.id] = f })
      remote.forEach((f) => { byId[f.id] = f })
      list = Object.keys(byId).map((k) => byId[k])
    }
    if (offline) list = replayPendingFollow(list)
    list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    writeFollows(list)
    writeSync(FOLLOW_SYNC_KEY, (res && res.serverTime) || Date.now())
    changed = true
  } catch (e) {}

  return changed
}


/* 类型归一化：异常 type 一律按商品处理，避免 read()[type] 为 undefined 时调用 indexOf 崩溃 */
function normType(type) {
  if (type === 'demand') return 'demand'
  if (type === 'news') return 'news'
  return 'product'
}

function isFav(type, id) {
  if (!id) return false
  return read()[normType(type)].indexOf(id) >= 0
}

/** 切换收藏，本地立即生效并后台同步云端；返回切换后的状态 */
function toggleFav(type, id) {
  if (!id) return false
  const target = normType(type)
  const data = read()
  const list = data[target]
  const i = list.indexOf(id)
  if (i >= 0) {
    list.splice(i, 1)
    data[target] = list
    write(data)
    pushFav(target, id, false)
    return false
  }
  list.push(id)
  data[target] = list
  write(data)
  pushFav(target, id, true)
  return true
}

function favCount() {
  const data = read()
  return data.product.length + data.demand.length + data.news.length
}

/* ========== 关注（本地缓存 + 云端同步） ==========
   只保存展示用字段：昵称、头像字与城市。
   对象 id 是服务端下发的匿名货主键，手机号、联系人、openid 一律不落本地。 */
const FOLLOW_KEY = 'suanli_follow_v1'
const FOLLOW_MAX = 100

function readFollows() {
  try {
    const raw = wx.getStorageSync(FOLLOW_KEY)
    if (!Array.isArray(raw)) return []
    return raw
      .filter((x) => x && typeof x.id === 'string' && x.id)
      .map((x) => ({
        id: x.id,
        type: x.type === 'product' ? 'product' : 'account',
        nick: x.nick || '货主',
        short: x.short || String(x.nick || '货').slice(-1),
        city: x.city || '',
        verified: x.verified !== false,
        at: Number(x.at) || 0
      }))
  } catch (e) {
    return []
  }
}

function writeFollows(list) {
  try {
    wx.setStorageSync(FOLLOW_KEY, (Array.isArray(list) ? list : []).slice(0, FOLLOW_MAX))
  } catch (e) {}
}

/** 关注只针对账号（货主 / 资讯作者）；商品统一走收藏 */
function isFollowing(id) {
  if (!id) return false
  return readFollows().some((f) => f.id === id && (f.type || 'account') === 'account')
}

/** 切换关注，本地立即生效并后台同步云端；返回切换后的状态 */
function toggleFollow(account) {
  const acc = account || {}
  if (!acc.id) return false
  const list = readFollows()
  const i = list.findIndex((f) => f.id === acc.id && (f.type || 'account') === 'account')
  if (i >= 0) {
    list.splice(i, 1)
    writeFollows(list)
    pushFollow({ id: acc.id, type: 'account' }, false)
    return false
  }
  const nick = acc.nick || '货主'
  const item = {
    id: String(acc.id),
    type: 'account',
    nick,
    short: acc.short || nick.slice(-1),
    city: acc.city || '',
    verified: acc.verified !== false,
    at: Date.now()
  }
  list.unshift(item)
  writeFollows(list)
  pushFollow(item, true)
  return true
}

function removeFollow(id) {
  if (!id) return
  writeFollows(readFollows().filter((f) => !(f.id === id && (f.type || 'account') === 'account')))
  pushFollow({ id, type: 'account' }, false)
}

/* ========== 浏览记录（本地，最多 50 条） ========== */
const VIEW_KEY = 'suanli_view_history_v1'
const VIEW_MAX = 50

function readViews() {
  try {
    const raw = wx.getStorageSync(VIEW_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((x) => x && x.id).slice(0, VIEW_MAX)
  } catch (e) {
    return []
  }
}

/** 记录一次浏览：同一条内容只保留最近一次，最新的排在最前 */
function recordView(item) {
  const it = item || {}
  if (!it.id) return readViews()
  const kind = it.kind === 'demand' ? 'demand' : 'product'
  const key = kind + ':' + it.id
  const list = readViews().filter((x) => (x.kind === 'demand' ? 'demand' : 'product') + ':' + x.id !== key)
  list.unshift({
    key,
    id: String(it.id),
    kind,
    title: it.title || '',
    cat: it.cat || '',
    city: it.city || '',
    priceText: it.priceText || '',
    at: Date.now()
  })
  const next = list.slice(0, VIEW_MAX)
  try {
    wx.setStorageSync(VIEW_KEY, next)
  } catch (e) {}
  return next
}

function clearViews() {
  try {
    wx.removeStorageSync(VIEW_KEY)
  } catch (e) {}
}

module.exports = {
  read,
  isFav,
  toggleFav,
  favCount,
  pull,
  flushNow,
  readFollows,
  isFollowing,
  toggleFollow,
  removeFollow,
  readViews,
  recordView,
  clearViews,
  FAV_KEY,
  FOLLOW_KEY,
  VIEW_KEY
}
