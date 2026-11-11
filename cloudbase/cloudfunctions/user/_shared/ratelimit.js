'use strict'

const { AppError, CODES } = require('./errors')

/** 固定窗口起始时间 */
function windowStartOf(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs
}

/**
 * 高频读接口的计数批量落库。
 *
 * 每次请求都跑一次数据库事务（读 + 写 counters）比业务本身还贵：
 * 浏览类接口 300 次 / 分钟，正常用户一进首页就会打十来个请求。
 * 因此 max >= 100 的接口先在进程内累计，每 SYNC_STEP 次（或本地已超限）才写一次库；
 * 小额度接口（登录 5 次、咨询 10 次、发布 10 条等）保持逐次落库，跨实例仍然精确。
 * 代价是多实例下最多放宽 SYNC_STEP 次，对反爬 / 防刷阈值无实质影响。
 */
const SYNC_STEP = 10
const LOCAL_MAX = 2048
const SYNC_MIN_MAX = 100
const DAY_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

const local = new Map()
let lastCleanupAt = 0

function localRow(key, windowMs, at) {
  let row = local.get(key)
  if (row && row.exp > at) return row
  row = { count: 0, buffer: 0, exp: at + windowMs }
  local.set(key, row)
  if (local.size > LOCAL_MAX) {
    /* 先清过期项；仍超上限说明是批量 key，直接整表重建（计数可短时重建） */
    for (const [k, v] of local) {
      if (v.exp <= at) local.delete(k)
    }
    if (local.size > LOCAL_MAX) local.clear()
  }
  return row
}

/**
 * 固定窗口计数（依赖 repo.incrCounter 的原子自增）。
 * 超限统一抛 RATE_LIMITED，不区分账号是否存在，避免枚举。
 */
async function hit(repo, opts) {
  const { key, max, windowMs, now } = opts
  if (!repo || typeof repo.incrCounter !== 'function') {
    throw new AppError(CODES.INTERNAL, '限流组件不可用')
  }
  const at = typeof now === 'number' ? now : Date.now()
  const start = windowStartOf(at, windowMs)
  const resetAt = start + windowMs

  /* 小额度接口：逐次落库，跨实例精确 */
  if (!(Number(max) >= SYNC_MIN_MAX)) {
    const count = await repo.incrCounter(key, start)
    if (count > max) {
      throw new AppError(CODES.RATE_LIMITED, '操作过于频繁，请稍后再试', {
        retryAfterMs: Math.max(0, resetAt - at)
      })
    }
    await cleanupCounters(repo, at)
    return { count, remaining: Math.max(0, max - count), resetAt }
  }

  /* 高频接口：先进程内累计，攒够一批或本地超限时落库 */
  const row = localRow(`${key}@${start}`, windowMs, at)
  row.count += 1
  row.buffer += 1
  let count = row.count
  if (row.buffer >= SYNC_STEP || row.count > max) {
    /* 先取走本批增量再发请求：并发请求会同时进入这里，
       若等 await 之后再清空，会把同一批增量重复累加，导致误限流 */
    const delta = row.buffer
    row.buffer = 0
    count = await repo.incrCounter(key, start, delta)
    row.count = count
  }
  if (count > max) {
    throw new AppError(CODES.RATE_LIMITED, '操作过于频繁，请稍后再试', {
      retryAfterMs: Math.max(0, resetAt - at)
    })
  }
  await cleanupCounters(repo, at)
  return { count, remaining: Math.max(0, max - count), resetAt }
}

/** 只读查询当前窗口计数，不产生自增（测试 / 运维用） */
async function peek(repo, opts) {
  const { key, now, windowMs } = opts
  const start = windowStartOf(typeof now === 'number' ? now : Date.now(), windowMs)
  const rows = await repo.find('counters', { id: `${key}@${start}` }, { limit: 1 })
  return rows.length ? rows[0].count : 0
}

/**
 * 过期计数清理：counters 每个账号 × 每个动作 × 每个窗口一行，
 * 不清理会无限增长，拖慢热词榜这类聚合查询。
 * 保留 2 天（覆盖最长 24 小时窗口）；每个进程每小时最多触发一次，
 * 避免把删除成本摊到每次请求上。
 */
async function cleanupCounters(repo, at, force) {
  if (!repo || typeof repo.removeWhere !== 'function') return { count: 0 }
  const ts = Number(at) || Date.now()
  if (!force && lastCleanupAt && ts - lastCleanupAt < CLEANUP_INTERVAL_MS) return { count: 0 }
  lastCleanupAt = ts
  try {
    const res = await repo.removeWhere('counters', { windowStart: { $lt: ts - 2 * DAY_MS } }, 40)
    return res || { count: 0 }
  } catch (err) {
    return { count: 0 }
  }
}

module.exports = { hit, peek, cleanupCounters, windowStartOf }
