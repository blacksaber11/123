'use strict'

/**
 * 订阅消息额度记账。
 *
 * 微信一次性订阅是「一次授权 = 一条推送」，客户端每次授权成功后调 notify.grant 上报，
 * 这里把次数累计到 users.notifyQuota，推送前检查、推送成功后扣减。
 * 没有上报记录的用户（旧版客户端）不限额，避免上线后提醒直接断掉。
 */
const KINDS = ['inquiry', 'chat', 'system', 'biz']
/* 单类最多累计条数：防止长时间不消耗时数字涨得离谱 */
const MAX = 20

function createQuota(deps) {
  const repo = deps.repo

  async function readOf(uid) {
    let user = null
    try {
      user = await repo.get('users', uid)
    } catch (err) {
      user = null
    }
    const q = user && user.notifyQuota
    return q && typeof q === 'object' ? q : null
  }

  function normalize(q) {
    const out = {}
    KINDS.forEach((k) => {
      out[k] = Math.max(0, Number(q && q[k]) || 0)
    })
    return out
  }

  async function save(uid, q) {
    try {
      await repo.updateWhere('users', { id: uid }, { notifyQuota: q })
    } catch (err) {
      /* 记账失败不能影响消息本身 */
    }
  }

  /* 剩余条数；null 表示用户从未上报过授权（旧版客户端），调用方按不限额处理 */
  async function state(uid) {
    const q = await readOf(uid)
    return q ? normalize(q) : null
  }

  /* 客户端授权成功：每个 kind 加一条 */
  async function grant(uid, kinds) {
    const q = normalize(await readOf(uid))
    ;(Array.isArray(kinds) ? kinds : []).forEach((k) => {
      if (KINDS.indexOf(k) < 0) return
      q[k] = Math.min(MAX, q[k] + 1)
    })
    await save(uid, q)
    return q
  }

  /* 推送前检查：没有记账记录视为可以推送 */
  async function allow(uid, kind) {
    const q = await readOf(uid)
    if (!q) return true
    return (Number(q[kind]) || 0) > 0
  }

  /* 推送成功后扣一条 */
  async function used(uid, kind) {
    const q = await readOf(uid)
    if (!q) return
    q[kind] = Math.max(0, (Number(q[kind]) || 0) - 1)
    await save(uid, normalize(q))
  }

  /* 微信明确告知额度已用完时清零，避免后续每条都白调接口 */
  async function exhaust(uid, kind) {
    const q = await readOf(uid)
    if (!q) return
    q[kind] = 0
    await save(uid, normalize(q))
  }

  return { state, grant, allow, used, exhaust }
}

/* 43101：用户未订阅或订阅次数已用完；43102：模板已删除或停用 */
function isExhausted(err) {
  const code = Number(err && err.errcode)
  return code === 43101 || code === 43102
}

module.exports = { createQuota, isExhausted, KINDS }
