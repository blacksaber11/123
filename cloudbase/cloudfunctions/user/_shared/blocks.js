'use strict'

/**
 * 用户黑名单：拉黑是单向关系（uid 拉黑 peerUid），但效果分两层：
 * 1. 私聊：任一方拉黑后，双方都不能再开新会话，也不能继续发消息（双向静默）；
 * 2. 内容：拉黑者看不到被拉黑者发布的商品与资讯，对方主页也一并隐藏（单向屏蔽）。
 * 反向不成立：被拉黑者仍能浏览拉黑者的内容，只是无法发起私聊。
 */

const { sha256Hex } = require('./crypto')

/** 黑名单行 id：同一对用户只有一行，重复拉黑幂等 */
function blockIdOf(uid, peerUid) {
  return 'ub_' + sha256Hex(`user-block:${String(uid || '')}:${String(peerUid || '')}`).slice(0, 22)
}

/** 我拉黑的人：列表过滤按集合走，避免逐条查库 */
async function blockedPeerIds(repo, uid) {
  const id = String(uid || '')
  if (!id) return new Set()
  const rows = await repo.find('userBlocks', { uid: id }, { limit: 500 })
  return new Set(rows.map((row) => String(row.peerUid || '')).filter(Boolean))
}

/** uid 是否拉黑了 peerUid（单向，判断内容可见性用） */
async function isBlocked(repo, uid, peerUid) {
  const a = String(uid || '')
  const b = String(peerUid || '')
  if (!a || !b || a === b) return false
  const row = await repo.get('userBlocks', blockIdOf(a, b))
  return !!row
}

/** 双方是否存在任一方向的拉黑（私聊口径：双向静默） */
async function blockedBetween(repo, a, b) {
  const x = String(a || '')
  const y = String(b || '')
  if (!x || !y || x === y) return false
  const rows = await repo.find('userBlocks', {
    id: { $in: [blockIdOf(x, y), blockIdOf(y, x)] }
  }, { limit: 2 })
  return rows.length > 0
}

module.exports = { blockIdOf, blockedPeerIds, isBlocked, blockedBetween }
