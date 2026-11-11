'use strict'

/**
 * 站内聊天媒体口径（用户端 / 管理端 / 服务端清理任务共用）。
 *
 * - 聊天记录服务端保留 CHAT_RETENTION_DAYS 天；
 * - 图片 / 视频在 CHAT_MEDIA_UNOPENED_DAYS 天内未被打开即过期；
 * - 打开后随聊天记录保留到 30 天，客户端负责落本地缓存。
 */

const {
  CHAT_RETENTION_DAYS,
  CHAT_MEDIA_UNOPENED_DAYS
} = require('./constants')

const DAY_MS = 24 * 60 * 60 * 1000

/** 消息类型：显式 kind 优先，历史数据按字段推断 */
function chatKindOf(p) {
  const payload = p || {}
  if (payload.kind === 'image' || payload.kind === 'video' || payload.kind === 'card') return payload.kind
  if (payload.video) return 'video'
  if (payload.image) return 'image'
  if (payload.card) return 'card'
  return 'text'
}

/**
 * 媒体当前可见状态：过期后不再下发文件地址，前端展示「已过期」占位。
 * @param {object} payload 消息 payload
 * @param {number} createdAt 消息创建时间（毫秒）
 * @param {number} nowMs 当前时间
 */
function mediaState(payload, createdAt, nowMs) {
  const p = payload || {}
  if (!p.image && !p.video) {
    return { image: '', video: '', poster: '', expired: false, expiresAt: 0 }
  }
  const at = Number(createdAt) || 0
  const openedAt = Number(p.mediaOpenedAt) || 0
  const keepDays = openedAt ? CHAT_RETENTION_DAYS : CHAT_MEDIA_UNOPENED_DAYS
  const expiresAt = at ? at + keepDays * DAY_MS : 0
  const now = Number(nowMs) || Date.now()
  if (!at || now >= expiresAt) {
    return { image: '', video: '', poster: '', expired: true, expiresAt }
  }
  return {
    image: p.image || '',
    video: p.video || '',
    poster: p.poster || '',
    expired: false,
    expiresAt,
    opened: !!openedAt
  }
}

/** 聊天记录保留截止时间：早于该时间的消息不再下发 */
function chatCutoff(nowMs) {
  return (Number(nowMs) || Date.now()) - CHAT_RETENTION_DAYS * DAY_MS
}

/** 未打开媒体的过期截止时间：早于该时间且未打开的媒体文件可清理 */
function mediaCutoff(nowMs) {
  return (Number(nowMs) || Date.now()) - CHAT_MEDIA_UNOPENED_DAYS * DAY_MS
}

module.exports = {
  DAY_MS,
  chatKindOf,
  mediaState,
  chatCutoff,
  mediaCutoff
}
