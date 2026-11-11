/* 消息收件箱：需求响应通知 / 已读状态 / 平台直连会话
   本地 storage 只作为离线兜底；真实消息以云端 outbox 为准，
   云端结果缓存到 SERVER_KEY，首页与消息页共用同一份未读口径 */
const M = require('./mock')

const KEY = 'suanli_inbox_v1'
const SERVER_KEY = 'suanli_msg_server_v1'

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function nowText() {
  const d = new Date()
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function read() {
  let raw = null
  try {
    raw = wx.getStorageSync(KEY)
  } catch (e) {}
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    read: s.read && typeof s.read === 'object' ? s.read : {},
    chat: Array.isArray(s.chat) ? s.chat.slice(-200) : []
  }
}

function write(s) {
  try {
    wx.setStorageSync(KEY, s)
  } catch (e) {}
}

/* 某个需求的响应列表：以需求方设定的必须条件为全集，逐条比对满足度 */
function responsesOf(demandId) {
  const demand = M.MY_DEMANDS.filter((d) => d.id === demandId)[0]
  const must = (demand && demand.must) || []
  return M.DEMAND_RESPONSES
    .filter((r) => r.demandId === demandId)
    .map((r) => {
      let metCount = 0
      const conds = must.map((c) => {
        const ok = r.met.indexOf(c) >= 0
        if (ok) metCount++
        return { n: c, ok: ok }
      })
      return Object.assign({}, r, {
        conds: conds,
        metCount: metCount,
        total: must.length,
        allMet: must.length > 0 && metCount === must.length,
        /* 与云端字段对齐，页面同一套模板即可渲染 */
        matchPct: must.length ? Math.round((metCount / must.length) * 100) : 0,
        status: r.status || '待分配'
      })
    })
    /* 全部满足的排前面，其次按满足项数量 */
    .sort((a, b) => (b.allMet - a.allMet) || (b.metCount - a.metCount))
}

function markRead(id) {
  if (!id) return
  const s = read()
  s.read[id] = 1
  write(s)
}

/* 我发布的需求收到的响应，按需求聚合成一条消息 */
function inquiryNotices() {
  const s = read()
  const ids = []
  M.DEMAND_RESPONSES.forEach((r) => {
    if (ids.indexOf(r.demandId) < 0) ids.push(r.demandId)
  })
  return ids.map((id) => {
    const demand = M.MY_DEMANDS.filter((d) => d.id === id)[0] || {}
    const responses = responsesOf(id)
    const msgId = 'inq-' + id
    return {
      id: msgId,
      kind: 'inquiry',
      demandId: id,
      demandTitle: demand.title || '',
      demandMeta: [demand.model, '需 ' + (demand.qty || 0) + ' 台', demand.city].filter(Boolean).join(' · '),
      title: '有 ' + responses.length + ' 位供给方响应了你的需求',
      content: demand.title || '',
      time: responses[0] ? responses[0].at : '',
      unread: !s.read[msgId],
      responses: responses
    }
  })
}

function isRead(id) {
  return !!read().read[id]
}

/* 系统通知：消息页与首页未读角标共用同一份，避免两处口径不一致 */
const SYSTEM_NOTICES = [
  { id: 'sys-1', kind: 'system', title: '咨询进度更新', content: '您对「H100 80G SXM 全新现货」的咨询已分配给客服小王', time: '10分钟前' },
  { id: 'sys-2', kind: 'system', title: '材料审核通过', content: '您上传的资质材料已通过审核，可正常发布商品', time: '2小时前' },
  { id: 'sys-3', kind: 'system', title: '新功能上线', content: '支持在线签订电子合同，交易更便捷', time: '1天前' }
]

/* ---------- 云端消息缓存 ----------
   消息页每次刷新都会把云端聚合结果写进来，首页角标直接读同一份数字，
   保证「首页角标」与「消息页 Tab 角标之和」永远一致。 */
function serverCache() {
  let raw = null
  try {
    raw = wx.getStorageSync(SERVER_KEY)
  } catch (e) {}
  const s = raw && typeof raw === 'object' ? raw : null
  if (!s) return null
  return {
    notices: Array.isArray(s.notices) ? s.notices : [],
    chats: Array.isArray(s.chats) ? s.chats : [],
    chatList: Array.isArray(s.chatList) ? s.chatList : [],
    noticeUnread: Number(s.noticeUnread) || 0,
    chatUnread: Number(s.chatUnread) || 0,
    unread: Number(s.unread) || 0,
    at: Number(s.at) || 0
  }
}

function cacheServer(data) {
  const d = data || {}
  const notices = Array.isArray(d.notices) ? d.notices.slice(0, 100) : []
  const chatList = Array.isArray(d.chatList) ? d.chatList.slice(-200) : []
  const chats = Array.isArray(d.chats) ? d.chats.slice(0, 20) : []
  const noticeUnread = Number(d.noticeUnread) || 0
  const chatUnread = Number(d.chatUnread) || 0
  const next = {
    notices,
    chats,
    chatList,
    noticeUnread,
    chatUnread,
    unread: noticeUnread + chatUnread,
    at: Date.now()
  }
  try {
    wx.setStorageSync(SERVER_KEY, next)
  } catch (e) {}
  return next
}

function clearServer() {
  try {
    wx.removeStorageSync(SERVER_KEY)
  } catch (e) {}
}

/* 未读总数：优先取云端缓存（与消息页同源），无缓存时回落本地演示数据 */
function unreadCount() {
  const server = serverCache()
  if (server) return server.unread
  const inq = inquiryNotices().filter((n) => n.unread).length
  const sys = SYSTEM_NOTICES.filter((n) => !isRead(n.id)).length
  return inq + sys
}

/* 平台直连会话：用户主动联系平台，消息只写给平台坐席 */
const WELCOME = {
  id: 'c-welcome',
  role: 'sys',
  text: '这里是算力聚合官方客服。询价、撮合、资料核对与纠纷都可以直接留言，平台坐席会尽快回复。',
  at: '平台'
}

function chatMessages() {
  const chat = read().chat
  return chat.length ? chat.map((m) => Object.assign({}, m)) : [Object.assign({}, WELCOME)]
}

function sendChat(text) {
  const t = String(text || '').trim().slice(0, 500)
  if (!t) return null
  const s = read()
  if (!s.chat.length) s.chat.push(Object.assign({}, WELCOME))
  const msg = { id: 'c' + Date.now(), role: 'me', text: t, at: nowText() }
  s.chat.push(msg)
  if (s.chat.length > 200) s.chat = s.chat.slice(-200)
  write(s)
  return msg
}

module.exports = {
  responsesOf,
  inquiryNotices,
  markRead,
  isRead,
  SYSTEM_NOTICES,
  unreadCount,
  serverCache,
  cacheServer,
  clearServer,
  chatMessages,
  sendChat,
  WELCOME
}
