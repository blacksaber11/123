/* 消息页：需求响应通知 / 客服会话入口
   数据优先读云端：通知来自 demand.responses，系统通知与客服会话来自 outbox(msg.list)；
   云端不可用时才回落到本地演示收件箱，避免整页空白。
   会话本身是独立页面 pages/chat/chat：安卓返回 / iOS 侧滑都回到上一级，不会退出小程序。 */
const { gate } = require('../../utils/auth')
const inbox = require('../../utils/inbox')
const notify = require('../../utils/notify')
const { request } = require('../../utils/request')

const SYSTEM_NOTICES = inbox.SYSTEM_NOTICES

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/* 时间戳 -> 列表展示文案 */
function fmtTime(at) {
  const n = Number(at)
  if (!n) return ''
  const d = new Date(n)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    /* 自定义导航尺寸：顶部状态栏 + 标题栏，彻底避开右上角胶囊 */
    statusBarH: 20,
    navH: 44,
    navTotal: 64,
    tab: 'chat',
    notices: [],
    chats: [],
    noticeUnread: 0,
    chatUnread: 0,
    /* 展开的响应面板消息 id */
    expanded: '',
    /* 微信订阅消息授权状态 */
    notifyOn: false,
    /* 剩余可推送条数：-1 表示还没有授权记录，0 表示已用完 */
    notifyRemain: -1
  },

  onLoad(options) {
    /* 旧版会话提醒仍带 threadId：直接转到独立对话页，避免落在列表上 */
    const threadId = String((options && options.threadId) || '')
    if (threadId) {
      wx.redirectTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(threadId), fail: () => {} })
    }
    let statusBarH = 20
    let navH = 44
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarH = info.statusBarHeight
    } catch (e) {}
    try {
      const rect = wx.getMenuButtonBoundingClientRect()
      if (rect && rect.height && rect.top >= statusBarH) {
        navH = (rect.top - statusBarH) * 2 + rect.height
      }
    } catch (e) {}
    /* 服务端消息原文：标记已读 / 组装会话时复用，避免重复请求 */
    this.server = { sysNotices: [], chatList: [], unreadStaffIds: [] }
    this.setData({ statusBarH, navH, navTotal: statusBarH + navH })
  },

  onUnload() {
    this.stopPoll()
  },

  /* 消息页可见时每 5 秒拉一次：有人发消息不用手动刷新也能看到 */
  startPoll() {
    this.stopPoll()
    this.pollTimer = setInterval(() => this.pollTick(), 5000)
  },

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  },

  async pollTick() {
    if (this.polling) return
    this.polling = true
    try {
      await this.refresh()
    } finally {
      this.polling = false
    }
  },

  async onShow() {
    gate(this.route || 'pages/msg/msg', this.options)
    this.syncTabBar()
    this.setData({ notifyOn: notify.enabled() })
    this.loadNotifyQuota()
    this.startPoll()
    await this.refresh()
  },

  /* 一次性订阅一次授权只推一条：拉回剩余条数，用完时重新显示提醒条 */
  async loadNotifyQuota(force) {
    await notify.loadConfig(force)
    const n = notify.quota()
    this.setData({ notifyRemain: n === null ? -1 : n })
  },

  onHide() {
    this.stopPoll()
  },

  // 消息已是底部导航的一页，选中态由页面自己同步
  syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  /* 未读角标立即同步：消息列表刷新后（已读 / 点开）马上刷新底部导航，
     不用等切页，避免「看完了角标还挂着」 */
  syncTabBarBadge() {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && typeof bar.refreshUnread === 'function') bar.refreshUnread()
  },

  /* 开启微信订阅消息：会话、系统消息、商机消息都会推送微信服务通知 */
  async enableNotify() {
    const kinds = ['inquiry', 'chat', 'system', 'biz']
    const on = await notify.enable(kinds)
    this.setData({ notifyOn: on })
    this.loadNotifyQuota(true)
  },

  /* ---------- 数据装载 ---------- */

  async refresh() {
    const online = await this.loadServer()
    if (!online) this.loadLocal()
  },

  /* 云端：客服会话 + 系统通知 + 我发布需求的响应 */
  async loadServer() {
    let list = null
    try {
      list = await request('user', 'msg.list', { page: 1, limit: 50 }, { silent: true })
    } catch (e) {
      return false
    }

    const sysNotices = []
    const chatList = []
    const unreadStaffIds = []
    /* 直聊会话按 threadId 聚合：列表里每条消息只取一次，未读按对方消息计数 */
    const directThreads = []
    const threadIndex = new Map()
    const items = (list && list.items) || []
    items.forEach((m) => {
      const isDirect = m.channel === 'direct' || m.type === 'direct.chat'
      if (isDirect && m.threadId) {
        let thread = threadIndex.get(m.threadId)
        if (!thread) {
          const priv = m.private === true
          thread = {
            threadId: m.threadId,
            private: priv,
            name: priv ? '私密发布' : (m.peerName || '直聊会话'),
            /* 商机会员标识：列表里跟在名字后面，点进会话仍保持一致；私密会话不展示 */
            memberLabel: priv ? '' : (m.memberLabel || ''),
            title: m.title || '',
            content: m.body || '',
            time: fmtTime(m.createdAt),
            atRaw: Number(m.createdAt) || 0,
            unread: 0
          }
          threadIndex.set(m.threadId, thread)
          directThreads.push(thread)
        } else if (m.private === true && !thread.private) {
          /* 同一会话里任意一条消息标记私密：整段会话都按匿名处理 */
          thread.private = true
          thread.name = '私密发布'
          thread.memberLabel = ''
        }
        if (m.from === 'peer' && m.unread) thread.unread += 1
        return
      }
      const isChat = m.channel === 'kf' || m.type === 'kf.chat'
      if (isChat) {
        chatList.push({
          id: m.id,
          role: m.from === 'staff' ? 'sys' : 'me',
          kind: m.kind || 'text',
          text: m.body || '',
          at: fmtTime(m.createdAt)
        })
        if (m.from === 'staff' && m.unread) unreadStaffIds.push(m.id)
        return
      }
      sysNotices.push({
        id: m.id,
        kind: 'system',
        title: m.title || '站内消息',
        content: m.body || '',
        /* 系统提示（下架 / 退回）单独带出原因，列表里直接可见 */
        reason: m.reason || '',
        time: fmtTime(m.createdAt),
        unread: !!m.unread,
        server: true
      })
    })
    /* msg.list 按时间倒序返回，会话流需要正序 */
    chatList.reverse()

    const inquiries = await this.loadInquiries()
    const notices = inquiries.concat(sysNotices)
    const noticeUnread = notices.filter((n) => n.unread).length
    const directEntries = directThreads.map((t) => ({
      id: 'thread:' + t.threadId,
      name: t.private ? '私密发布' : t.name,
      memberLabel: t.private ? '' : (t.memberLabel || ''),
      content: t.content,
      time: t.time,
      avatar: t.private ? '私' : String(t.name || '对').slice(0, 1),
      direct: true,
      private: t.private === true,
      unread: t.unread
    }))
    const chatUnread = unreadStaffIds.length + directThreads.reduce((sum, t) => sum + t.unread, 0)
    const chats = [this.buildChatEntry(chatList, unreadStaffIds.length)].concat(directEntries)
    const displayList = [Object.assign({}, inbox.WELCOME)].concat(chatList)

    this.server = { sysNotices, chatList, unreadStaffIds }
    this.setData({ notices, chats, noticeUnread, chatUnread })
    inbox.cacheServer({
      notices,
      chats,
      chatList: displayList,
      noticeUnread,
      chatUnread,
      /* 分开记系统通知未读：全局轮询重算未读时不会把咨询回复的未读算丢 */
      sysUnread: sysNotices.filter((n) => n.unread).length
    })
    /* 未读角标与列表同源：读完 / 点开后立即刷新底部导航，角标当场消失 */
    this.syncTabBarBadge()
    return true
  },

  /* 我发布的需求收到的响应：先取我发布的需求，再逐个拉响应 */
  async loadInquiries() {
    let mine = null
    try {
      mine = await request('user', 'mine.publish.list', { page: 1, limit: 50 }, { silent: true })
    } catch (e) {
      return []
    }
    const demands = ((mine && mine.demands) || []).filter((d) => Number(d.responses) > 0).slice(0, 10)
    const settled = await Promise.all(demands.map((d) =>
      request('user', 'demand.responses', { demandId: d.id }, { silent: true })
        .then((res) => ({ demand: d, res }))
        .catch(() => null)
    ))
    const notices = []
    settled.forEach((row) => {
      if (!row || !row.res || !row.res.items || !row.res.items.length) return
      const d = row.demand
      const responses = row.res.items
      const msgId = 'inq-' + d.id
      notices.push({
        id: msgId,
        kind: 'inquiry',
        demandId: d.id,
        demandTitle: d.title || row.res.title || '',
        demandMeta: [d.model, '需 ' + (d.qty || 0) + ' 台', d.city].filter(Boolean).join(' · '),
        title: '有 ' + responses.length + ' 位供给方响应了你的需求',
        content: d.title || row.res.title || '',
        time: fmtTime(responses[responses.length - 1].at) || fmtTime(d.createdAt),
        unread: !inbox.isRead(msgId),
        responses: responses.map((r) => ({
          id: r.id,
          masked: r.masked,
          matchPct: Number(r.matchPct) || 0,
          status: r.status,
          metCount: r.metCount,
          total: r.total,
          allMet: r.allMet,
          conds: r.conds || [],
          note: '',
          atText: fmtTime(r.at)
        }))
      })
    })
    /* 有未读响应的需求排前面 */
    return notices.sort((a, b) => (b.unread - a.unread))
  },

  buildChatEntry(chatList, unread) {
    const last = chatList[chatList.length - 1]
    return {
      id: 'platform',
      name: '算力聚合 · 官方客服',
      content: last ? (last.role === 'me' ? '我：' : '') + last.text : '可直接咨询平台',
      time: last ? last.at : '',
      avatar: '平',
      official: true,
      unread: unread || 0
    }
  },

  /* 离线兜底：使用本地演示收件箱，保证页面结构可用 */
  loadLocal() {
    const notices = inbox.inquiryNotices().concat(
      SYSTEM_NOTICES.map((n) => Object.assign({}, n, { unread: !inbox.isRead(n.id) }))
    )
    const chatList = inbox.chatMessages()
    const noticeUnread = notices.filter((n) => n.unread).length
    this.server = { sysNotices: [], chatList: [], unreadStaffIds: [] }
    this.setData({
      notices,
      chats: [this.buildChatEntry(chatList, 0)],
      noticeUnread,
      chatUnread: 0
    })
  },

  /* ---------- 交互 ---------- */

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  async openMsg(e) {
    const id = e.currentTarget.dataset.id
    const notice = this.data.notices.filter((n) => n.id === id)[0]
    if (!notice) return
    if (notice.kind === 'inquiry') {
      inbox.markRead(id)
      const next = this.data.expanded === id ? '' : id
      await this.refresh()
      this.setData({ expanded: next })
      return
    }
    if (notice.server) {
      try {
        await request('user', 'msg.read', { id }, { silent: true })
      } catch (err) { /* 标记已读失败不影响详情展示 */ }
      await this.refresh()
    } else {
      inbox.markRead(id)
      await this.refresh()
    }
    wx.showModal({
      title: notice.title,
      content: (notice.reason ? '原因：' + notice.reason + '\n\n' : '') + (notice.content || '') + '\n\n' + notice.time,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /* 消息里的需求卡：跳转到对应需求详情，发布方可在详情里继续查看响应人 */
  openDemand(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/demand/demand?id=' + id })
  },

  /* 会话列表点开：进独立对话页（普通页面入栈，返回即回到消息列表） */
  openChatEntry(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset.id) || '')
    if (id.indexOf('thread:') === 0) {
      wx.navigateTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(id.slice(7)) })
      return
    }
    wx.navigateTo({ url: '/pages/chat/chat' })
  },

  back() {
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
