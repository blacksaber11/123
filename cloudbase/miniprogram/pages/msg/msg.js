/* 消息页：需求响应通知 / 客服会话
   数据优先读云端：通知来自 demand.responses，系统通知与客服会话来自 outbox(msg.list)；
   云端不可用时才回落到本地演示收件箱，避免整页空白。 */
const { gate } = require('../../utils/auth')
const guard = require('../../utils/guard')
const inbox = require('../../utils/inbox')
const notify = require('../../utils/notify')
const prefs = require('../../utils/prefs')
const shop = require('../../utils/shop')
const { request, uploadFile } = require('../../utils/request')
const { PENDING_THREAD_KEY } = require('../../utils/chat')

const SYSTEM_NOTICES = inbox.SYSTEM_NOTICES

/* 会话页水印：铺满 3 列 × 6 行，绑定当前账号；聊天图片右下角再单独叠一条 */
const WM_TILES = 18

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

/* 服务端返回的会话标的 → 顶部商品卡；缺标题时回退为空，不展示空卡 */
function targetCardOf(t) {
  if (!t || !t.id) return null
  const price = Number(t.price) || 0
  let priceText = ''
  if (t.priceMode === 'nego') priceText = '价格面议'
  else if (price > 0) priceText = (t.currencySymbol || '¥') + shop.moneyText(price) + (t.priceUnit || '')
  return {
    type: t.type === 'demand' ? 'demand' : 'product',
    id: String(t.id),
    title: String(t.title || '关联商品'),
    cover: t.cover || '',
    priceText,
    city: t.city || ''
  }
}

/* 平台客服上下文的展示卡：价格文案已在商品页格式化好 */
function targetCardOfCtx(ctx) {
  if (!ctx || !ctx.targetId) return null
  return {
    type: ctx.targetType === 'demand' ? 'demand' : 'product',
    id: String(ctx.targetId),
    title: String(ctx.targetTitle || '关联商品'),
    cover: ctx.cover || '',
    priceText: ctx.priceText || '',
    city: ctx.city || ''
  }
}

Page({
  data: {
    /* 自定义导航尺寸：顶部状态栏 + 标题栏，彻底避开右上角胶囊 */
    statusBarH: 20,
    navH: 44,
    navTotal: 64,
    /* 键盘高度：只抬升底部输入条，消息列表与顶部导航保持不动 */
    kbHeight: 0,
    kbAware: false,
    panelBottom: '0px',
    tab: 'chat',
    notices: [],
    chats: [],
    noticeUnread: 0,
    chatUnread: 0,
    /* 展开的响应面板消息 id */
    expanded: '',
    /* 微信订阅消息授权状态 */
    notifyOn: false,
    /* 会话：chatThread 为空 = 平台客服，非空 = 与货主 / 需求方的直聊 */
    chatOpen: false,
    chatThread: '',
    chatTitle: '算力聚合 · 官方客服',
    chatAvatar: '平',
    /* 对方匿名主页键：点会话头像进入对方主页（平台客服会话为空） */
    chatPeerKey: '',
    chatList: [],
    /* 平台客服会话的商品上下文：仅从商品页咨询入口带入，管理端按商品归组留言 */
    chatCtx: null,
    /* 会话顶部商品卡：直聊由服务端返回标的，客服会话由咨询入口带入；双方看到同一条 */
    chatTarget: null,
    draft: '',
    chatAnchor: '',
    sending: false,
    /* 加号面板：展开后可发送图片 / 个人名片 */
    toolsOpen: false,
    peerContact: null,
    /* 直聊顶部标识：双方任一为商机会员时展示 */
    chatMember: '',
    /* 私密发布会话：对方身份全程匿名 */
    chatPrivate: false,
    /* 名片详情弹层：聊天里点方形名片打开 */
    cardOpen: false,
    cardDetail: {},
    /* 账号水印：用户 id + 昵称，整页与消息图片都带；设置关闭后不渲染 */
    wmText: '',
    wmTiles: [],
    wmOn: true,
    /* 页内图片查看器：不走 wx.previewImage，避免长按保存 / 转发 */
    imgOpen: false,
    imgSrc: ''
  },

  onLoad(options) {
    /* 微信会话提醒点开时带 threadId，落地直接进入对应会话 */
    this.entryThread = String((options && options.threadId) || '')
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
    /* 键盘弹起时由系统上报高度，只把输入条抬到键盘上方，页面不做整体上移 */
    const kbAware = typeof wx.onKeyboardHeightChange === 'function'
    this.setData({ statusBarH, navH, navTotal: statusBarH + navH, kbAware })
    if (kbAware) {
      this.onKbChange = (res) => this.handleKeyboard(res)
      wx.onKeyboardHeightChange(this.onKbChange)
    }
  },

  /* 键盘高度变化：面板顶部（navTotal）不变，只调整底部到键盘顶边 */
  handleKeyboard(res) {
    const h = Math.max(0, Number(res && res.height) || 0)
    const patch = {
      kbHeight: h,
      /* 会话整屏：无键盘时贴底，安全区由输入条 / 功能面板自己留 */
      panelBottom: h > 0 ? h + 'px' : '0px'
    }
    /* 键盘弹起时收起加号面板，避免面板与键盘同时占位 */
    if (h > 0) patch.toolsOpen = false
    this.setData(patch, () => {
      /* 可视区变矮后把最新消息留在视线内 */
      if (h > 0 && this.data.chatOpen) this.scrollChat()
    })
  },

  onUnload() {
    this.stopPoll()
    if (this.onKbChange && typeof wx.offKeyboardHeightChange === 'function') {
      wx.offKeyboardHeightChange(this.onKbChange)
    }
  },

  /* 返回手势 / 安卓物理返回：会话打开时先回到消息列表，不直接退出小程序 */
  onBackPress() {
    if (this.data.chatOpen) {
      this.closeChat()
      return true
    }
    return false
  },

  /*
   * iOS 右滑返回：页面已禁用系统侧滑（避免在 tabBar 根页直接退出小程序），
   * 这里自己识别「左边缘起手 + 向右滑」来关闭会话，回到上一级消息列表。
   */
  onChatTouchStart(e) {
    const t = (e.touches && e.touches[0]) || {}
    const x = Number(t.clientX) || 0
    this.chatSwipe = { x, y: Number(t.clientY) || 0, active: x <= 32, done: false }
  },

  onChatTouchMove(e) {
    const s = this.chatSwipe
    if (!s || !s.active || s.done) return
    const t = (e.touches && e.touches[0]) || {}
    const dx = (Number(t.clientX) || 0) - s.x
    const dy = Math.abs((Number(t.clientY) || 0) - s.y)
    if (dx > 72 && dx > dy * 1.6) {
      s.done = true
      this.closeChat()
    }
  },

  onChatTouchEnd() {
    this.chatSwipe = null
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
    /* 正在发送或页面已切走时不打扰 */
    if (this.data.sending) return
    /* 兜底：站点跳转时消息页已在后台，onShow 没取到待打开会话，轮询时补开 */
    const pending = this.takePendingThread()
    if (pending) {
      await this.openThread(pending)
      return
    }
    this.polling = true
    try {
      const prevUnread = new Map((this.data.chats || []).map((c) => [c.id, Number(c.unread) || 0]))
      const openThread = this.data.chatThread
      const inChat = this.data.chatOpen
      /* 直聊会话打开时，列表只更新未读与红点，不能覆盖当前会话的消息流 */
      await this.refresh(!!openThread)
      if (openThread) {
        if (this.data.chatOpen && this.data.chatThread === openThread) await this.refreshThread()
        if (inChat) this.notifyNewChats(prevUnread)
        return
      }
      if (!inChat) return
      /* 平台客服会话：新到的客服消息直接标记已读 */
      const unread = (this.server && this.server.unreadStaffIds) || []
      if (unread.length) {
        await Promise.all(unread.map((id) =>
          request('user', 'msg.read', { id }, { silent: true }).catch(() => null)
        ))
        if (this.server) this.server.unreadStaffIds = []
        this.setData({ chatUnread: Math.max(0, Number(this.data.chatUnread) - unread.length) })
      }
      /* 不在当前会话的新消息：轻提示一次，会话列表同时保留红点 */
      this.notifyNewChats(prevUnread)
    } finally {
      this.polling = false
    }
  },

  /* 当前打开的会话之外出现新消息：轻提示；正在看该会话时不打扰 */
  notifyNewChats(prevUnread) {
    const cur = this.data.chatThread ? 'thread:' + this.data.chatThread : 'platform'
    const hit = (this.data.chats || []).some((c) =>
      c.id !== cur && (Number(c.unread) || 0) > (prevUnread.get(c.id) || 0)
    )
    if (hit) wx.showToast({ title: '收到新消息', icon: 'none' })
  },

  /* 直聊会话轮询：只重绘消息流，草稿与页面状态保持不变 */
  async refreshThread() {
    const id = this.data.chatThread
    if (!id) return
    let res = null
    try {
      res = await request('user', 'msg.thread', { threadId: id }, { silent: true })
    } catch (e) {
      return
    }
    if (!res || !res.threadId || this.data.chatThread !== id) return
    const list = this.enrichMedia(this.mapThreadItems(res.items), id)
    /* 顶部商品卡随会话标的更新；被用户叉掉后同一条不再反复弹出 */
    const card = targetCardOf(res.target)
    if (card && String(card.id) !== this.targetDismissed) {
      const cur = this.data.chatTarget
      if (!cur || cur.id !== card.id || cur.title !== card.title) this.setData({ chatTarget: card })
    }
    const old = this.data.chatList || []
    const lastOld = old[old.length - 1]
    const lastNew = list[list.length - 1]
    const changed = old.length !== list.length ||
      (lastOld && lastNew && lastOld.id !== lastNew.id)
    if (!changed) return
    const patch = { chatList: list }
    if (res.private === true) {
      /* 私密发布会话：轮询后仍保持匿名标题，绝不回填昵称与主页入口 */
      patch.chatPrivate = true
      patch.chatTitle = '私密发布'
      patch.chatAvatar = '私'
      patch.chatPeerKey = ''
      patch.peerContact = null
      patch.chatMember = ''
    } else {
      patch.chatPeerKey = res.peerKey || this.data.chatPeerKey
      patch.peerContact = res.peerContact || this.data.peerContact
      patch.chatMember = res.memberLabel || this.data.chatMember
    }
    this.setData(patch, () => this.scrollChat())
    this.writeChatCache(id, patch.chatList)
  },

  /* 取出待打开的会话：globalData 优先，本地缓存兜底（switchTab 不能带参数） */
  takePendingThread() {
    let id = ''
    try {
      const app = getApp()
      if (app && app.globalData && app.globalData.openThread) {
        id = String(app.globalData.openThread)
        app.globalData.openThread = ''
      }
    } catch (e) { /* globalData 不可用时读缓存 */ }
    if (!id) {
      try {
        const saved = wx.getStorageSync(PENDING_THREAD_KEY)
        if (saved) {
          id = String(saved)
          wx.removeStorageSync(PENDING_THREAD_KEY)
        }
      } catch (e) { /* 没有缓存就直接进会话列表 */ }
    }
    return id
  },

  async onShow() {
    gate(this.route || 'pages/msg/msg', this.options)
    this.syncTabBar()
    /* 会话是整屏模式：进入会话隐藏底部导航，返回列表再恢复 */
    this.setTabBarHidden(!!this.data.chatOpen)
    this.setData({ notifyOn: notify.enabled() })
    /* 水印跟随当前账号：ID 尾 8 位 + 昵称，换账号重新进入即刷新；开关关闭则不渲染 */
    const wmText = guard.accountMark()
    const wmOn = prefs.watermarkOn()
    this.setData({
      wmOn,
      wmText,
      wmTiles: wmOn ? Array.from({ length: WM_TILES }, (_, k) => ({ k, t: wmText })) : []
    })
    this.startPoll()
    /* 咨询页 / 商机页条件满足后会写入待打开会话，落地即进入直聊 */
    const app = getApp()
    const pending = this.takePendingThread()
    if (pending) {
      await this.openThread(pending)
      return
    }
    /* 设置里的「在线客服」/ 商品页咨询：落地即打开平台官方客服会话（消息进管理端，不走微信客服） */
    const pendingChat = app && app.globalData && app.globalData.openChat
    if (pendingChat) {
      app.globalData.openChat = false
      /* 商品页入口带 productId：随客服消息一起上报，管理端按商品归组 */
      const ctx = pendingChat && typeof pendingChat === 'object' && pendingChat.productId
        ? {
          targetType: 'product',
          targetId: String(pendingChat.productId),
          targetTitle: String(pendingChat.title || ''),
          cover: pendingChat.cover || '',
          priceText: pendingChat.priceText || '',
          city: pendingChat.city || ''
        }
        : null
      await this.refresh()
      await this.openChat(ctx)
      return
    }
    /* 微信会话提醒带过来的会话：刷新列表后直接进入 */
    if (this.entryThread) {
      const threadId = this.entryThread
      this.entryThread = ''
      await this.refresh()
      await this.openThread(threadId)
      return
    }
    /* 直聊会话仍开着时只刷新列表未读，保留当前会话的消息流 */
    await this.refresh(!!this.data.chatThread)
  },

  onHide() {
    /* 离开消息页时恢复底部导航，避免把隐藏态带到其它页 */
    this.setTabBarHidden(false)
    this.stopPoll()
  },

  // 消息已是底部导航的一页，选中态由页面自己同步
  syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  /* 自定义 tabBar 显隐：会话页整屏时隐藏，与微信聊天页一致 */
  setTabBarHidden(hidden) {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && bar.setData && bar.data && bar.data.hidden !== hidden) bar.setData({ hidden })
  },

  /* 未读角标立即同步：消息列表刷新后（已读 / 点开）马上刷新底部导航，
     不用等切页，避免「看完了角标还挂着」 */
  syncTabBarBadge() {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && typeof bar.refreshUnread === 'function') bar.refreshUnread()
  },

  /* 开启微信订阅消息：会话、系统消息、商机消息都会推送微信服务通知 */
  async enableNotify() {
    const on = await notify.enable(['inquiry', 'chat', 'system', 'biz'])
    this.setData({ notifyOn: on })
  },

  /* ---------- 本地缓存 ----------
     聊天记录 / 已看媒体都按会话维度存本地，任何缓存失败都不影响聊天主流程 */

  /* 会话标识：平台客服固定 kf，直聊用 lead id */
  threadKey() {
    return this.data.chatThread ? String(this.data.chatThread) : 'kf'
  },

  readChatCache(key) {
    try {
      const raw = wx.getStorageSync('chat:' + (key || this.threadKey()))
      return Array.isArray(raw) ? raw : []
    } catch (e) {
      return []
    }
  },

  /* 最近 100 条，超过 100KB 继续丢最旧的；同一批消息不重复写入 */
  writeChatCache(key, list) {
    const k = key || this.threadKey()
    try {
      let rows = (list || []).filter((m) => m && m.id).slice(-100)
      while (rows.length && JSON.stringify(rows).length > 100 * 1024) rows = rows.slice(1)
      this.cacheSig = this.cacheSig || {}
      const last = rows[rows.length - 1]
      const sig = rows.length + '|' + (last ? last.id : '') + '|' +
        rows.filter((m) => m.opened).length + '|' + rows.filter((m) => m.mediaExpired).length
      if (this.cacheSig[k] === sig) return
      wx.setStorageSync('chat:' + k, rows)
      this.cacheSig[k] = sig
    } catch (e) {}
  },

  readMediaList(key) {
    try {
      const raw = wx.getStorageSync('media:' + (key || this.threadKey()))
      return Array.isArray(raw) ? raw : []
    } catch (e) {
      return []
    }
  },

  writeMediaList(key, list) {
    try {
      wx.setStorageSync('media:' + (key || this.threadKey()), (list || []).slice(0, 10))
    } catch (e) {}
  },

  /* 媒体消息补上渲染地址：本地缓存优先，过期消息不给地址 */
  enrichMedia(list, key) {
    const cache = {}
    this.readMediaList(key).forEach((m) => {
      if (m && m.msgId) cache[m.msgId] = m
    })
    return (list || []).map((m) => {
      if (m.kind !== 'image' && m.kind !== 'video') return m
      const hit = cache[m.id]
      const local = (hit && hit.localPath) || ''
      const expired = m.mediaExpired === true
      return Object.assign({}, m, {
        opened: !!m.opened || !!hit,
        src: expired ? '' : (local || (m.kind === 'video' ? m.video : m.image) || '')
      })
    })
  },

  /* 会话消息统一映射：文本 / 图片 / 视频 / 名片 */
  mapThreadItems(items) {
    return (items || []).map((it) => {
      const atMs = Number(it.at || it.createdAt) || 0
      const expiresAt = Number(it.mediaExpiresAt) || 0
      const isMedia = it.kind === 'image' || it.kind === 'video' || !!it.image || !!it.video
      return {
        id: it.id,
        role: it.role === 'me' ? 'me' : 'sys',
        kind: it.kind || 'text',
        text: (it.text !== undefined ? it.text : it.body) || '',
        image: it.image || '',
        video: it.video || '',
        poster: it.poster || '',
        mediaExpired: it.mediaExpired === true,
        /* 服务端把已打开的媒体保留期延长到 30 天，据此判断无需再次登记 */
        opened: isMedia && !it.mediaExpired && expiresAt > 0 && expiresAt - atMs > 8 * 86400000,
        card: it.card || null,
        at: fmtTime(atMs),
        read: it.read === true
      }
    })
  },

  /* 单条消息原地更新：媒体状态变化后同步重绘与本地缓存 */
  patchChatItem(id, patch) {
    const chatList = (this.data.chatList || []).map((m) =>
      String(m.id) === String(id) ? Object.assign({}, m, patch) : m
    )
    this.setData({ chatList })
    this.writeChatCache(this.threadKey(), chatList)
  },

  /* ---------- 数据装载 ---------- */

  async refresh(keepChatList) {
    const online = await this.loadServer(keepChatList)
    if (!online && !keepChatList) this.loadLocal()
  },

  /* 云端：客服会话 + 系统通知 + 我发布需求的响应
     keepChatList：打开直聊会话时只刷新列表未读，不覆盖当前会话的消息流 */
  async loadServer(keepChatList) {
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
          image: m.image || '',
          video: m.video || '',
          poster: m.poster || '',
          mediaExpired: m.mediaExpired === true,
          /* 已打开的媒体服务端保留 30 天，据此判断无需再登记 */
          opened: !m.mediaExpired && Number(m.mediaExpiresAt) > Number(m.createdAt) + 8 * 86400000,
          card: m.card || null,
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
    /* 图片 / 视频走本地缓存优先的渲染地址 */
    const enriched = this.enrichMedia(chatList, 'kf')

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
    const chats = [this.buildChatEntry(enriched, unreadStaffIds.length)].concat(directEntries)
    const displayList = [Object.assign({}, inbox.WELCOME)].concat(enriched)

    this.server = { sysNotices, chatList, unreadStaffIds }
    const patch = { notices, chats, noticeUnread, chatUnread }
    if (!keepChatList) patch.chatList = displayList
    this.setData(patch)
    /* 客服会话记录落本地：下次进入先秒开，再由本次结果覆盖 */
    this.writeChatCache('kf', displayList)
    inbox.cacheServer({ notices, chats, chatList: displayList, noticeUnread, chatUnread })
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
      chatList,
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

  /* 打开平台客服会话；ctx 为商品咨询上下文（从商品页进入时才有） */
  async openChat(ctx) {
    /* 会话整屏：隐藏底部导航，返回列表时恢复 */
    this.setTabBarHidden(true)
    /* 本地缓存先渲染秒开，随后用服务端结果覆盖 */
    const cached = this.enrichMedia(this.readChatCache('kf'), 'kf')
    const ctxOk = !!(ctx && ctx.targetId)
    this.targetDismissed = ''
    this.setData({
      tab: 'chat',
      chatOpen: true,
      chatThread: '',
      /* 从其它入口进入默认平台客服时清空上下文，避免串到上一个商品 */
      chatCtx: ctxOk ? ctx : null,
      chatTarget: ctxOk ? targetCardOfCtx(ctx) : null,
      chatTitle: '算力聚合 · 官方客服',
      chatAvatar: '平',
      chatPeerKey: '',
      chatList: cached.length ? cached : this.data.chatList,
      draft: '',
      chatAnchor: 'chat-end',
      toolsOpen: false,
      peerContact: null,
      chatMember: '',
      chatPrivate: false
    }, () => this.scrollChat())
    /* 打开会话即把客服回复标记为用户已读，首页角标随之归零 */
    const unread = (this.server && this.server.unreadStaffIds) || []
    if (unread.length) {
      await Promise.all(unread.map((id) =>
        request('user', 'msg.read', { id }, { silent: true }).catch(() => null)
      ))
      this.server.unreadStaffIds = []
    }
    await this.refresh()
  },

  /* 打开与货主 / 需求方的直聊会话：拉取完整对话并置为已读 */
  async openThread(threadId) {
    const id = String(threadId || '')
    if (!id) return
    /* 本地缓存先渲染秒开，服务端返回后覆盖 */
    this.setTabBarHidden(true)
    this.targetDismissed = ''
    this.setData({
      tab: 'chat',
      chatOpen: true,
      chatThread: id,
      chatCtx: null,
      chatTarget: null,
      /* 拉取前先清掉上一个会话的身份信息，避免短暂串号 */
      chatTitle: '直聊会话',
      chatAvatar: '对',
      chatPeerKey: '',
      peerContact: null,
      chatMember: '',
      chatList: this.enrichMedia(this.readChatCache(id), id),
      draft: '',
      chatAnchor: 'chat-end',
      toolsOpen: false,
      chatPrivate: false
    }, () => this.scrollChat())
    let res = null
    try {
      res = await request('user', 'msg.thread', { threadId: id }, { silent: true })
    } catch (e) {
      return
    }
    if (!res || !res.threadId) return
    await this.refresh()
    const chatList = this.enrichMedia(this.mapThreadItems(res.items), id)
    const name = res.peerName || '直聊会话'
    /* 私密发布会话：标题 / 头像 / 标识全部匿名，也不提供对方主页入口 */
    const isPrivate = res.private === true
    const card = targetCardOf(res.target)
    /* 会话整屏：隐藏底部导航，返回列表时恢复 */
    this.setTabBarHidden(true)
    this.setData({
      tab: 'chat',
      chatOpen: true,
      chatThread: id,
      chatCtx: null,
      chatTarget: card && String(card.id) !== this.targetDismissed ? card : null,
      chatTitle: isPrivate ? '私密发布' : name,
      chatAvatar: isPrivate ? '私' : (String(name).slice(0, 1) || '对'),
      chatPeerKey: isPrivate ? '' : (res.peerKey || ''),
      chatList,
      draft: '',
      chatAnchor: 'chat-end',
      toolsOpen: false,
      peerContact: isPrivate ? null : (res.peerContact || null),
      chatMember: isPrivate ? '' : (res.memberLabel || ''),
      chatPrivate: isPrivate
    }, () => this.scrollChat())
    this.writeChatCache(id, chatList)
  },

  /* 对方已授权时，复制其电话（仅当前会话可见） */
  copyPeerPhone() {
    const phone = (this.data.peerContact && this.data.peerContact.phone) || ''
    if (!phone) return
    wx.setClipboardData({ data: phone })
  },

  /* 点对方头像 / 会话标题进入对方主页：关注、主体信息与联系方式，私信回到本会话 */
  openPeerHome() {
    if (!this.data.chatOpen || !this.data.chatThread) return
    if (this.data.chatPrivate) {
      wx.showToast({ title: '该会话为私密发布，无法查看对方主页', icon: 'none' })
      return
    }
    const key = this.data.chatPeerKey
    if (!key) {
      wx.showToast({ title: '对方暂未开通个人主页', icon: 'none' })
      return
    }
    const nick = String(this.data.chatTitle || '').replace(/\s*·\s*官方客服$/, '') || '对方'
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(key) +
        '&nick=' + encodeURIComponent(nick) +
        '&thread=' + encodeURIComponent(this.data.chatThread)
    })
  },

  async closeChat() {
    this.setTabBarHidden(false)
    this.setData({
      chatOpen: false,
      chatThread: '',
      chatCtx: null,
      chatTarget: null,
      chatTitle: '算力聚合 · 官方客服',
      chatAvatar: '平',
      chatPeerKey: '',
      chatAnchor: '',
      toolsOpen: false,
      peerContact: null,
      chatMember: '',
      chatPrivate: false,
      cardOpen: false,
      cardDetail: {}
    })
    await this.refresh()
  },

  /* 关闭顶部商品卡：本次会话不再弹出，也停止向平台客服续报该商品上下文 */
  closeChatTarget() {
    const card = this.data.chatTarget
    this.targetDismissed = card ? String(card.id) : ''
    this.setData({ chatTarget: null, chatCtx: null })
  },

  /* 点顶部商品卡进入对应商品 / 需求详情：双方看的是同一条标的 */
  openChatTarget() {
    const card = this.data.chatTarget
    if (!card || !card.id) return
    const url = card.type === 'demand'
      ? '/pages/demand/demand?id=' + encodeURIComponent(card.id)
      : '/pages/product/product?id=' + encodeURIComponent(card.id)
    wx.navigateTo({ url })
  },

  onDraft(e) {
    this.setData({ draft: e.detail.value, toolsOpen: false })
  },

  /* 输入框聚焦时收起加号面板，和微信一致 */
  onInputFocus() {
    if (this.data.toolsOpen) this.setData({ toolsOpen: false })
  },

  /* 加号：展开 / 收起功能面板，展开时先收起键盘 */
  toggleTools() {
    const open = !this.data.toolsOpen
    if (open) wx.hideKeyboard({ fail: () => {} })
    this.setData({ toolsOpen: open })
  },

  /* 选图后上传并作为图片消息发送 */
  pickImage() {
    this.setData({ toolsOpen: false })
    const send = (path) => {
      if (!path) return
      this.uploadAndSendImage(path)
    }
    const onPick = (files) => {
      const first = (files || [])[0]
      if (!first) return
      if (Number(first.size) > 10 * 1024 * 1024) {
        wx.showToast({ title: '图片不能超过 10MB', icon: 'none' })
        return
      }
      send(first.tempFilePath || first.path || first)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'], success: (res) => onPick(res.tempFiles) })
    } else {
      wx.chooseImage({ count: 1, sizeType: ['compressed'], success: (res) => onPick(res.tempFilePaths) })
    }
  },

  async uploadAndSendImage(filePath) {
    if (this.data.sending) return
    wx.showLoading({ title: '发送中', mask: true })
    try {
      /* 文件名只用随机串 + 36 进制时间戳，避免云端文件 ID 里出现连续数字被联系方式校验拦截 */
      const image = await uploadFile(filePath, {
        kind: 'chat',
        cloudPath: 'chat/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.jpg'
      })
      await this.sendMessage({ kind: 'image', body: '[图片]', image })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '图片发送失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  /* 选视频：支持 MP4 / MOV / M4V，超过 50MB 直接中止 */
  pickVideo() {
    this.setData({ toolsOpen: false })
    if (!wx.chooseMedia) {
      wx.showToast({ title: '当前微信版本不支持发送视频', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      maxDuration: 60,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = (res.tempFiles || [])[0]
        if (!file) return
        if (Number(file.size) > 50 * 1024 * 1024) {
          wx.showToast({ title: '视频不能超过 50MB', icon: 'none' })
          return
        }
        this.uploadAndSendVideo(file.tempFilePath || file.path)
      }
    })
  },

  async uploadAndSendVideo(filePath) {
    if (!filePath || this.data.sending) return
    wx.showLoading({ title: '发送中', mask: true })
    try {
      const video = await uploadFile(filePath, {
        kind: 'chat',
        cloudPath: 'chat/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.mp4'
      })
      await this.sendMessage({ kind: 'video', body: '[视频]', video })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '视频发送失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  /* 发送个人名片：名片内容由服务端按本人档案生成，避免客户端伪造 */
  async sendCard() {
    this.setData({ toolsOpen: false })
    await this.sendMessage({ kind: 'card', body: '[名片]' })
  },

  async sendChat() {
    const t = String(this.data.draft || '').trim()
    if (!t) return
    const ok = await this.sendMessage({ kind: 'text', body: t })
    if (ok) this.setData({ draft: '' })
  },

  /* 统一发送入口：文本 / 图片 / 视频 / 名片都由这里落库并回显 */
  async sendMessage(msg) {
    if (this.data.sending) return false
    this.setData({ sending: true })
    let saved = null
    try {
      const payload = { body: msg.body || '', kind: msg.kind || 'text' }
      if (msg.image) payload.image = msg.image
      if (msg.video) payload.video = msg.video
      if (msg.poster) payload.poster = msg.poster
      if (this.data.chatThread) {
        payload.threadId = this.data.chatThread
      } else if (this.data.chatCtx && this.data.chatCtx.targetId) {
        /* 客服通道才带商品上下文：管理端按商品归组咨询留言 */
        payload.targetType = this.data.chatCtx.targetType || 'product'
        payload.targetId = this.data.chatCtx.targetId
        payload.targetTitle = this.data.chatCtx.targetTitle || ''
      }
      saved = await request('user', 'msg.send', payload)
    } catch (err) {
      this.setData({ sending: false })
      return false
    }
    const item = {
      id: saved && saved.id ? saved.id : 'c' + Date.now(),
      role: 'me',
      kind: (saved && saved.kind) || msg.kind || 'text',
      text: (saved && saved.body) || msg.body || '',
      image: (saved && saved.image) || msg.image || '',
      video: (saved && saved.video) || msg.video || '',
      poster: (saved && saved.poster) || msg.poster || '',
      mediaExpired: false,
      opened: false,
      card: (saved && saved.card) || null,
      at: fmtTime(saved && saved.createdAt ? saved.createdAt : Date.now())
    }
    item.src = item.kind === 'video' ? item.video : (item.kind === 'image' ? item.image : '')
    const chatList = this.data.chatList.concat([item])
    this.setData({ chatList, sending: false }, () => this.scrollChat())
    this.writeChatCache(this.threadKey(), chatList)
    return true
  },

  /* 打开媒体前登记：成功后保留期从 7 天延长到 30 天，过期则阻断查看 */
  async ensureMediaOpen(row) {
    if (!row || !row.id || row.opened) return true
    try {
      await request('user', 'msg.mediaOpen', { id: row.id }, { silent: true })
      this.patchChatItem(row.id, { opened: true })
      return true
    } catch (err) {
      const msg = String((err && err.message) || '')
      /* 只有「已过期」阻断查看，其它异常（网络 / 未登录）静默放行 */
      if (msg.indexOf('过期') >= 0) {
        this.patchChatItem(row.id, { mediaExpired: true, src: '' })
        wx.showToast({ title: '图片/视频已过期', icon: 'none' })
        return false
      }
      return true
    }
  },

  /* 已看媒体落本地：下载失败静默回退网络地址 */
  cacheMedia(row) {
    if (!row || !row.id || (row.kind !== 'image' && row.kind !== 'video')) return
    const key = 'media:' + this.threadKey()
    const list = this.readMediaList(key)
    const hit = list.filter((m) => m.msgId === row.id)[0]
    if (hit && hit.localPath) return
    const url = String((row.kind === 'video' ? row.video : row.image) || '')
    if (!/^http/i.test(url)) return
    wx.downloadFile({
      url,
      success: (res) => {
        if (!res || res.statusCode !== 200 || !res.tempFilePath) return
        try {
          wx.getFileSystemManager().saveFile({
            tempFilePath: res.tempFilePath,
            success: (saved) => {
              this.pushMediaCache(key, {
                msgId: row.id,
                localPath: (saved && saved.savedFilePath) || '',
                kind: row.kind,
                savedAt: Date.now(),
                url
              })
            },
            fail: () => {}
          })
        } catch (e) {}
      },
      fail: () => {}
    })
  },

  /* 每个会话最多留 10 个媒体，超过 7 天的本地文件一并清掉 */
  pushMediaCache(key, entry) {
    if (!entry || !entry.msgId) return
    const now = Date.now()
    const rows = this.readMediaList(key).filter((m) => m && m.msgId !== entry.msgId)
    rows.push(entry)
    rows.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0))
    const keep = []
    rows.forEach((m) => {
      const stale = m.localPath && now - (Number(m.savedAt) || 0) > 7 * 86400000
      if (stale || keep.length >= 10) {
        if (m.localPath) {
          try {
            wx.getFileSystemManager().removeSavedFile({ filePath: m.localPath, fail: () => {} })
          } catch (e) {}
        }
        return
      }
      keep.push(m)
    })
    this.writeMediaList(key, keep)
  },

  /* 图片消息：先登记打开，再进页内查看器（叠加账号水印） */
  async previewImage(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset.id) || '')
    const row = (this.data.chatList || []).filter((m) => String(m.id) === id)[0]
    const src = String((row && row.src) || (e && e.currentTarget && e.currentTarget.dataset.src) || '')
    if (!src) {
      if (row && row.mediaExpired) wx.showToast({ title: '图片已过期', icon: 'none' })
      return
    }
    if (row && !(await this.ensureMediaOpen(row))) return
    this.setData({ imgOpen: true, imgSrc: src })
    if (row) this.cacheMedia(row)
  },

  /* 视频消息：封面块点开，先登记再走系统播放器 */
  async playVideo(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset.id) || '')
    const row = (this.data.chatList || []).filter((m) => String(m.id) === id)[0]
    if (!row) return
    const src = String(row.src || row.video || '')
    if (row.mediaExpired || !src) {
      wx.showToast({ title: '视频已过期', icon: 'none' })
      return
    }
    if (!(await this.ensureMediaOpen(row))) return
    wx.previewMedia({
      sources: [{ url: src, type: 'video', poster: row.poster || '' }],
      fail: () => {}
    })
    this.cacheMedia(row)
  },

  closeImage() {
    if (!this.data.imgOpen) return
    this.setData({ imgOpen: false, imgSrc: '' })
  },

  /* 名片上的电话：本人主动展示，可直接拨打 */
  callCardPhone(e) {
    const phone = String((e && e.currentTarget && e.currentTarget.dataset.phone) || '').trim()
    if (!phone) return
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} })
  },

  /* 点方形名片：打开详情弹层，完整信息不在聊天气泡里铺开 */
  openCard(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset.id) || '')
    const row = (this.data.chatList || []).find((x) => String(x.id) === id)
    if (!row || !row.card) return
    this.setData({ cardOpen: true, cardDetail: row.card })
  },

  closeCard() {
    if (!this.data.cardOpen) return
    this.setData({ cardOpen: false, cardDetail: {} })
  },

  /* 弹层内部点击不关闭 */
  stopTap() {},

  scrollChat() {
    this.setData({ chatAnchor: '' }, () => this.setData({ chatAnchor: 'chat-end' }))
  },

  openChatEntry(e) {
    const id = String((e && e.currentTarget && e.currentTarget.dataset.id) || '')
    if (id.indexOf('thread:') === 0) return this.openThread(id.slice(7))
    return this.openChat()
  },

  back() {
    /* 先退内部步骤：会话整屏 → 会话列表；再离页 */
    if (this.data.chatOpen) {
      this.closeChat()
      return
    }
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
