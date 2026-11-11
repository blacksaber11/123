/* 我的页面：用户卡 + 顶部四宫格（浏览 / 收藏 / 关注 / 我发布的）+ 竖向菜单（委托 / 缴费 / 咨询 / 资质 / 设置） */
const { gate, logout, readUser, writeUser } = require('../../utils/auth')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')
const notify = require('../../utils/notify')
const M = require('../../utils/mock')
const fav = require('../../utils/fav')
const shop = require('../../utils/shop')
const { request } = require('../../utils/request')
const { ensureProfileReady } = require('../../utils/profile-ready')
const prefs = require('../../utils/prefs')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtTime(at) {
  const n = Number(at)
  if (!n) return ''
  const d = new Date(n)
  return pad(d.getFullYear()).slice(2) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/* 「我的」本地快照：先渲染本机数据，云端只做后台刷新，减少无效请求 */
const CACHE_PUB = 'suanli_mine_pub_v1'
const CACHE_AGENCY = 'suanli_mine_agency_v1'
const CACHE_TTL = 60 * 1000

/* 缓存按账号隔离：换号后不能读到上一位用户的发布 / 委托 */
function scopedKey(key) {
  const user = readUser()
  return key + ':' + ((user && user.uid) || 'anon')
}

function readCache(key) {
  try {
    const v = wx.getStorageSync(scopedKey(key))
    return v && v.data !== undefined ? v : null
  } catch (e) {
    return null
  }
}

function writeCache(key, data) {
  try {
    wx.setStorageSync(scopedKey(key), { at: Date.now(), data })
  } catch (e) {}
}

/* 顶部固定四宫格：浏览 / 收藏 / 关注 / 我发布的，最常用的四个入口 */
const QUICKS = [
  { k: 'history', icon: 'menu-history', n: '浏览记录' },
  { k: 'fav', icon: 'menu-fav', n: '我的收藏' },
  { k: 'follow', icon: 'menu-follow', n: '我的关注' },
  { k: 'pub', icon: 'menu-pub', n: '我发布的' }
]

/* 竖向菜单：先看分类，点进去再看该分类的详情。
   「我的商机」不在本页展开二级页，直接进商机页（未开通时由商机页展示套餐引导） */
const MENUS = [
  { k: 'biz', icon: 'menu-agency', n: '我的商机', d: '只显示你已领取的商机，可回看联系方式并发起对话', url: '/pages/biz/biz?mode=mine' },
  { k: 'agency', icon: 'menu-agency', n: '我的委托', d: '代采 / 代售订单、服务费与撤销' },
  { k: 'pay', icon: 'menu-agency', n: '我的订单', d: '会员开通记录与代采 / 代售订单记录' },
  { k: 'profile', icon: 'menu-qual', n: '我的信息', d: '资料、资质与公开范围', url: '/pages/profile/profile' },
  { k: 'report', icon: 'menu-inq', n: '帮助与反馈', d: '举报 / 投诉 / 意见反馈与处理进度' },
  { k: 'set', icon: 'menu-set', n: '设置', d: '账号、通知与隐私' }
]

/* 状态 → 展示色：草稿 / 待审核 / 已驳回 / 已下架 需要一眼看出与「在售」的差别 */
const STATUS_STYLE = {
  '草稿': 'st-draft',
  '待审核': 'st-pending',
  '待确认': 'st-pending',
  '待确认成交': 'st-pending',
  '已通过': 'st-pending',
  '已驳回': 'st-reject',
  '已下架': 'st-offline',
  '已关闭': 'st-offline',
  '在售': 'st-ok',
  '求购中': 'st-ok',
  '洽谈中': 'st-ok',
  '已对接': 'st-ok',
  '已上架': 'st-ok',
  '已成交': 'st-ok',
  '已完成': 'st-ok'
}

/* 可编辑状态：与后端 PRODUCT/DEMAND_EDITABLE_STATUS 同口径，终态不给编辑入口 */
const EDITABLE_STATUS = {
  product: ['草稿', '已驳回', '在售', '已下架'],
  demand: ['草稿', '已驳回', '求购中', '已下架']
}

const BASE = {
  data: {
    user: null,
    quick: QUICKS.map((q) => Object.assign({ cnt: 0 }, q)),
    menu: MENUS.map((m) => Object.assign({ cnt: '' }, m)),
    /* menu = 分类列表；二级视图由 pages/mine/sub 承载，这里只保留菜单态 */
    view: 'menu',
    /* menu = 我的页；sub = 二级视图页 */
    mode: 'menu',
    /* 二级页全屏标题，随进入的分类变化 */
    viewTitle: '',
    subTab: 'product',
    favTab: 'product',
    /* 我的发布只认云端结果：不回落到演示数据，避免把假条目当成真实资产 */
    myProducts: [],
    myDemands: [],
    /* 我投稿的资讯：与商品 / 需求一起在「我发布的」按页签切换，可自行删除 */
    myNews: [],
    pubList: [],
    /* 代采 / 代售委托：云端提交后在这里跟进，避免「提交了就没了下文」 */
    agencyList: [],
    /* 委托详情面板：列表只展示商品信息，点击后查看流程、处理人并操作 */
    agencyDetailOpen: false,
    agencyDetail: null,
    /* 我的订单：会员开通记录（收款单）与代采 / 代售订单记录，只做查询 */
    payList: [],
    orderTab: 'member',
    /* 修改已上架委托：提交后先下架，平台审核通过后自动更新并重新上架 */
    editOpen: false,
    editId: '',
    editSaving: false,
    editForm: { item: '', qty: '', price: '', city: '', detail: '' },
    /* 交易流程与条件项不在小程序内改，提交时原样带回，避免被清空 */
    editConds: { flow: [], must: [], nego: [] },
    /* 举报 / 投诉 / 意见反馈：表单草稿与历史提交 */
    reportTypes: ['举报', '投诉', '意见反馈'],
    reportType: '意见反馈',
    reportTarget: '',
    reportContent: '',
    reportContact: '',
    reportSending: false,
    reportList: [],
    /* 账号注销申请：最新一条的状态与平台回复 */
    delReq: null,
    favProducts: [],
    favDemands: [],
    /* 收藏的资讯：标题与失效态以云端 news.fav.list 为准 */
    favNews: [],
    favList: [],
    follows: [],
    /* 关注：只保留账号；商品统一走收藏 */
    followAccounts: [],
    followList: [],
    /* 我的评论：我发出的评论 + 收到的回复，未读回复计入角标 */
    commentList: [],
    commentUnread: 0,
    views: [],
    seller: null,
    sellerList: [],
    /* 微信订阅消息授权状态：仅表示本机是否授权过，真实推送取决于服务端模板配置 */
    notifyOn: false,
    /* 商机提醒偏好：存在服务端，关闭后不再推送商机类微信提醒，站内消息不受影响 */
    notifyBiz: true,
    /* 水印保护默认开启；关闭后聊天与作品图片、视频不再叠加水印 */
    wmOn: true,
    /* 未开通商机会员时，在四宫格上方展示开通引导；默认展示，确认已开通后再收起 */
    bizLocked: true,
    /* 已领取的商机条数：只统计「我的商机」里已领取的，不含商机池中可领取的 */
    bizClaimed: 0
  },

  /* 二级视图独立成页：系统返回 / 侧滑返回都回到「我的」，不会退出小程序 */
  onLoad(options) {
    if (this.data.mode !== 'sub') return
    const q = options || {}
    const view = String(q.view || '')
    const entry = QUICKS.concat(MENUS).filter((x) => x.k === view)[0]
    const title = view === 'seller' ? '卖家主页' : (entry ? entry.n : '')
    const sub = String(q.sub || '')
    const subTab = sub === 'demand' || sub === 'news' || sub === 'comment' ? sub : this.data.subTab
    this.setData({ view: view || 'menu', viewTitle: title, subTab })
    if (title) wx.setNavigationBarTitle({ title })
    if (view === 'seller') this.applySeller(String(q.id || ''))
  },

  /* 二级页只加载当前视图需要的数据 */
  loadSubView() {
    const view = this.data.view
    if (view === 'pub') {
      this.loadRemote()
      this.loadCommentBadge()
      if (this.data.subTab === 'comment') this.loadComments()
    }
    if (view === 'agency') this.loadAgencies()
    if (view === 'pay') {
      this.loadPayments()
      this.loadAgencies()
    }
    if (view === 'fav') {
      this.loadFav()
      this.loadFavNews()
    }
    if (view === 'follow') this.loadFollows()
    if (view === 'history') this.loadViews()
    if (view === 'report') this.loadReports()
    if (view === 'set') {
      this.setData({ wmOn: prefs.watermarkOn() })
      this.loadSetPrefs()
      this.loadDeleteStatus()
      this.refreshNotify()
    }
  },

  async onShow() {
    if (gate(this.route || 'pages/mine/mine', this.options)) {
      /* 只允许把「已发布的公开条目」发给朋友，分享链接不带任何联系方式 */
      guard.enableShare()
    }
    if (this.data.mode === 'sub') {
      /* 已经在二级页：清掉发布页留下的落点，避免之后回菜单时被再次跳转 */
      try {
        const app = getApp()
        if (app && app.globalData) {
          app.globalData.minePub = ''
          app.globalData.mineView = ''
        }
      } catch (e) {}
      this.loadUser()
      this.loadSubView()
      return
    }
    this.syncTabBar()
    this.loadUser()
    this.refreshNotify()
    this.setData({ wmOn: prefs.watermarkOn() })
    this.loadViews()
    this.loadBizGuide()
    /* 先切到「我发布的」再拉取：applyPub 按当前子类组装列表 */
    this.openPendingPub()
    /* 委托刚提交：直接打开「我的委托」看进度 */
    this.openPendingAgency()
    this.loadRemote()
    this.loadPayments()
    this.loadReports()
    /* 本地缓存先渲染：收藏 / 关注 / 浏览记录都在本机，打开即有内容 */
    this.loadFav()
    this.loadFollows()
    /* 收到的新回复：在「我发布的」上显示红色数字角标 */
    this.loadCommentBadge()
    /* 云端只做后台增量对账：5 分钟内不重复请求，失败也不影响展示 */
    fav.pull().then((changed) => {
      if (!changed) return
      this.loadFav()
      this.loadFollows()
    })
    /* 回到本页：若上次停在二级视图，底部导航继续保持隐藏 */
    this.syncTabHidden()
  },

  /* 离开页面时把攒下的收藏 / 关注变更一次性补发，减少零散请求 */
  onHide() {
    fav.flushNow().catch(() => {})
  },

  /* 分享卡片：点某一条发布的「分享」→ 分享该条；直接右上角分享 → 分享平台首页 */
  onShareAppMessage(e) {
    const ds = (e && e.target && e.target.dataset) || {}
    const kind = ds.kind === 'demand' ? 'demand' : 'product'
    if (ds.id) {
      const list = kind === 'demand' ? this.data.myDemands : this.data.myProducts
      const item = (list || []).filter((x) => String(x.id) === String(ds.id))[0] || {}
      /* 我的发布分享出去仍然是公开内容：标题与底图与详情页一致 */
      const shareKind = sharePoster.shareKindOf(kind, item)
      /* 有预生成的海报就用自己的那条，未命中时由 guard 回退静态底图 */
      const poster = sharePoster.cached(shareKind, item)
      const card = guard.shareCard(shareKind, Object.assign({}, item, { shareImage: poster }), ds.id)
      return {
        title: card.title,
        desc: card.desc,
        imageUrl: card.imageUrl,
        path: card.path
      }
    }
    /* 分享整个平台：用平台自己的卡片与文案 */
    const card = guard.shareCard('home', {}, '')
    return {
      title: '算力聚合 · 优质货源与求购需求',
      desc: card.desc,
      imageUrl: card.imageUrl,
      path: '/pages/home/home'
    }
  },

  /* 云端：我发布的商品 / 需求 + 我的委托。本地快照先渲染，后台再刷新 */
  async loadRemote() {
    let app = null
    try {
      app = getApp()
    } catch (e) {}
    const dirty = !!(app && app.globalData && app.globalData.mineDirty)
    const pub = readCache(CACHE_PUB)
    const agency = readCache(CACHE_AGENCY)
    /* 本地快照先渲染：冷启动 / 切页都不用等网络 */
    if (pub) this.applyPub(pub.data.products || [], pub.data.demands || [], pub.data.news || [], false)
    if (agency) this.setData({ agencyList: agency.data })

    const at = Date.now()
    const fresh = (c) => !!c && at - (Number(c.at) || 0) < CACHE_TTL
    /* 刚发布 / 编辑过，或任一块快照过期，才真正回源 */
    if (!dirty && fresh(pub) && fresh(agency)) return
    if (dirty && app && app.globalData) app.globalData.mineDirty = false
    try {
      const res = await request('user', 'mine.publish.list', { page: 1, limit: 50 }, { silent: true })
      const hasShape = !!res && Array.isArray(res.products) && Array.isArray(res.demands)
      const products = ((res && res.products) || []).map((p) => this.adaptPub(p, 'product'))
      const demands = ((res && res.demands) || []).map((d) => this.adaptPub(d, 'demand'))
      const news = ((res && res.news) || []).map((n) => this.adaptPub(n, 'news'))
      /* 云端返回 0 条是合法结果：以云端为准，不再用演示条数冒充我的发布 */
      if (hasShape) this.applyPub(products, demands, news, true)
      await this.loadAgencies()
    } catch (err) { /* 云端不可用：保持本地快照 / 演示数据 */ }
  },

  /* 发布列表落到页面与本地快照，供下次切页秒开（persist=false 表示来自缓存，不回写） */
  applyPub(products, demands, news, persist) {
    const list = news || []
    this.cloudPubCount = products.length + demands.length + list.length
    this.setData({
      myProducts: products,
      myDemands: demands,
      myNews: list,
      pubList: this.pubListOf(this.data.subTab, products, demands, list)
    })
    this.buildMenu()
    if (persist !== false) writeCache(CACHE_PUB, { products, demands, news: list })
    this.prepareShareImages(products, demands)
  },

  /* 我发布前 10 条的商品 / 需求海报：串行生成，分享时同步取缓存 */
  prepareShareImages(products, demands) {
    const jobs = []
    ;(products || []).slice(0, 10).forEach((p) => {
      jobs.push({ kind: sharePoster.shareKindOf('product', p), item: p })
    })
    ;(demands || []).slice(0, 10).forEach((d) => {
      jobs.push({ kind: sharePoster.shareKindOf('demand', d), item: d })
    })
    if (!jobs.length) return
    this.posterQueue = (this.posterQueue || Promise.resolve()).then(() => {
      let chain = Promise.resolve()
      jobs.forEach((job) => {
        chain = chain.then(() => sharePoster.prepare(job.kind, job.item))
      })
      return chain
    })
  },

  /* 当前页签对应的列表：资讯放在求购需求之后 */
  pubListOf(sub, products, demands, news) {
    if (sub === 'demand') return demands
    if (sub === 'news') return news
    return products
  },

  /**
   * 发布条目 → 列表展示结构。
   * statusCls 用于状态标签配色；reason 承载退回 / 下架原因；canSubmit 表示可否直接发布上架。
   */
  adaptPub(row, kind) {
    const status = row.status || ''
    /* 私密发布：后端下发 visibility=private（兼容「保密」文案）或 isPrivate 标记 */
    const isPrivate = row.isPrivate === true || row.visibility === 'private' || row.visibility === '保密'
    const reason = row.reviewReason || row.offlineReason || row.closeReason || row.reason || ''
    if (kind === 'news') {
      return {
        id: row.id,
        kind: 'news',
        status,
        isPrivate,
        statusCls: STATUS_STYLE[status] || (status === '已发布' ? 'st-ok' : 'st-pending'),
        published: fmtTime(row.createdAt),
        title: row.title || '',
        summary: row.summary || '',
        city: row.city || '',
        views: Number(row.views) || 0,
        reason,
        reasonText: reason ? (status === '已驳回' ? '退回原因：' + reason : '下架原因：' + reason) : '',
        canDelete: true
      }
    }
    /* 币种符号由后端下发；单位在模板里统一补，避免「¥1 万 元 / 台」重复 */
    const sym = row.currencySymbol || '¥'
    return {
      id: row.id,
      kind: kind,
      status,
      isPrivate,
      /* 私密发布＝匿名公开：我的发布列表统一标注「匿名」 */
      visibilityLabel: isPrivate ? '匿名' : (row.visibilityLabel || '公开'),
      statusCls: STATUS_STYLE[status] || '',
      published: fmtTime(row.createdAt),
      title: row.title || '',
      /* 分享卡片只用结构化字段拼标题，型号与交易方式要一并带上 */
      model: row.model || '',
      tradeMode: row.tradeMode || (row.isRent ? '出租' : (kind === 'demand' ? '求购' : '出售')),
      cat: row.cat || '',
      brand: row.brand || '',
      city: row.city || '',
      priceMode: shop.priceModeOf(row.priceMode, row.price, row.priceMax),
      priceText: shop.amountText(row.price, row.priceMax, row.priceMode, sym),
      budgetMode: shop.priceModeOf(row.budgetMode, row.budget, row.budgetMax),
      budgetText: shop.amountText(row.budget, row.budgetMax, row.budgetMode, sym),
      qty: row.qty || 0,
      /* 浏览量：服务端随列表下发；自己看自己的发布也照常展示 */
      views: Number(row.views) || 0,
      cond: row.cond || '',
      reason,
      reasonText: reason
        ? (status === '已驳回'
          ? '退回原因：' + reason
          : (status === '已关闭' ? '关闭原因：' + reason : '下架原因：' + reason))
        : '',
      canSubmit: status === '草稿' || status === '已驳回',
      /* 与后端 PRODUCT/DEMAND_EDITABLE_STATUS 同口径：终态（成交 / 关闭 / 洽谈中）不给编辑入口 */
      canEdit: (kind === 'demand'
        ? ['草稿', '已驳回', '求购中', '已下架']
        : ['草稿', '已驳回', '在售', '已下架']).indexOf(status) > -1,
      /* 自助收尾：下架 / 关闭由发布方发起；只有「本人下架 / 本人关闭」才能自助恢复，
         平台处置的必须联系客服，避免绕过平台审核 */
      canOffline: kind === 'product' && (status === '在售' || status === '洽谈中'),
      canOnline: kind === 'product' && status === '已下架' && row.selfOffline === true,
      platformOffline: kind === 'product' && status === '已下架' && row.selfOffline !== true,
      canClose: kind === 'demand' && (status === '求购中' || status === '已对接'),
      canReopen: kind === 'demand' && status === '已关闭' && row.selfClosed === true,
      platformClosed: kind === 'demand' && status === '已关闭' && row.selfClosed !== true,
      /* 自己发布的内容随时可以删除：删除后不再对外展示 */
      canDelete: true
    }
  },

  /* 我的委托：状态、服务费、到期时间与驳回 / 关闭原因都来自服务端 */
  async loadAgencies() {
    try {
      const res = await request('user', 'agency.mine', { page: 1, limit: 30 }, { silent: true })
      const items = (res && res.items) || []
      const list = items.map((a) => {
          const status = a.status || ''
          const statusText = a.statusText || status || '待处理'
          const reason = a.reason || ''
          const rental = a.rental === true
          const deadlineText = String(a.deadlineText || a.deadline || '')
          const feeNum = Number(a.serviceFee) || 0
          const feeStatusText = a.feeStatusText || ''
          /* 精确匹配 paid / 已支付，避免把 unpaid 误判为已支付 */
          const feeStatusKey = String(a.feeStatus || '').toLowerCase()
          const feePaid = feeStatusKey === 'paid' || /(^|_)paid$/.test(feeStatusKey) || /已支付|已到账/.test(feeStatusText)
          /* 流程节点由服务端按时间升序给出：只展示节点名、时间、处理人 */
          const flowNodes = (Array.isArray(a.flowNodes) ? a.flowNodes : []).map((n, i) => ({
            key: 'fn' + i,
            label: n.label || '',
            atText: n.atText || '',
            staffText: n.staffText || '',
            /* 时间与处理人同一行展示，空值不补分隔符 */
            line: [n.atText, n.staffText].filter(Boolean).join(' · ')
          }))
          return {
            id: a.id,
            kind: a.kind || '委托',
            title: (a.kind || '委托') + ' ' + (a.item || ''),
            status,
            statusText,
            statusCls: STATUS_STYLE[status] || 'st-pending',
            meta: (a.mode || '') + ' · ' + (Number(a.qty) || 0) + ' 台' + (a.city ? ' · ' + a.city : ''),
            priceText: a.price ? (a.currencySymbol || '¥') + a.price + ' / 台' + (rental ? ' / 月' : '') : '面议',
            deadlineLabel: deadlineText
              ? (/截止|到期/.test(deadlineText) ? deadlineText : deadlineText + ' 截止')
              : '',
            feeText: feeNum > 0
              ? (rental ? '成交后支付半个月租金 ¥' : '成交后支付服务费 ¥') + feeNum
              : (rental ? '成交后支付半个月租金' : '成交后支付服务费'),
            /* 详情面板：服务费金额与状态（支付截止日以服务端 feeDueAtText 为准） */
            serviceFeeText: feeNum > 0
              ? '¥' + feeNum + (rental ? ' · 半个月租金 · 成交后支付' : ' · 成交后支付')
              : (rental ? '成交后按半个月租金计算' : '成交后按成交金额计算'),
            feeStatusText,
            feeDueAtText: a.feeDueAtText || '',
            feePaid,
            deferredFee: a.deferredFee === true,
            /* 可见范围：1000 万元及以上代采固定仅平台可见；其余代采 / 代售公开给平台匹配 */
            visibility: a.visibility || 'public',
            visibilityLabel: a.visibilityLabel || (a.visibility === 'private' ? '保密' : '公开'),
            isPrivate: a.visibility === 'private',
            exposureLabel: a.exposureLabel || '',
            atText: a.createdText || fmtTime(a.createdAt),
            expireText: a.expireText || '',
            reasonText: reason
              ? (status === '已驳回' ? '退回原因：' + reason : (status === '已关闭' ? '关闭原因：' + reason : '处理说明：' + reason))
              : '',
            canCancel: a.canCancel === true,
            selfClosed: a.selfClosed === true,
            paidClaimText: a.paidClaimText || '',
            /* 委托方确认成交：服务端在待确认成交时给出 canConfirmDeal */
            canConfirmDeal: a.canConfirmDeal === true,
            /* 已成交且服务费未到账时，保留「我已支付」上报入口 */
            canPayFee: status === '已成交' && feeNum > 0 && !feePaid,
            flowNodes,
            dealAmountText: a.dealAmountText || '',
            completedText: a.completedText || '',
            receiptText: a.receiptText || '',
            canConfirmReceipt: a.canConfirmReceipt === true,
            /* 已上架委托可提交修改：提交即下架，审核通过后自动更新并重新上架 */
            canEdit: a.canEdit === true,
            /* 被驳回的委托：可回发布页修改并重传材料重新提交，也可直接删除 */
            canResubmit: a.canResubmit === true,
            canDelete: a.canDelete === true,
            side: a.side || '',
            editPending: a.editPending === true,
            /* 修改面板回填：条件项原样带回，避免提交时被清空 */
            itemName: a.item || '',
            rawQty: Number(a.qty) || 0,
            rawPrice: Number(a.price) || 0,
            rawCity: a.city || '',
            rawDetail: a.detail || '',
            flow: Array.isArray(a.flow) ? a.flow.slice() : [],
            must: Array.isArray(a.must) ? a.must.slice() : [],
            nego: Array.isArray(a.nego) ? a.nego.slice() : []
          }
        })
      const openId = this.data.agencyDetailOpen && this.data.agencyDetail ? String(this.data.agencyDetail.id) : ''
      const hit = openId ? list.filter((a) => String(a.id) === openId)[0] : null
      const patch = { agencyList: list }
      /* 操作后刷新：详情面板跟着取最新状态，委托被删除时自动关闭 */
      if (openId) {
        patch.agencyDetailOpen = !!hit
        patch.agencyDetail = hit || null
      }
      this.setData(patch)
      writeCache(CACHE_AGENCY, list)
      this.buildMenu()
    } catch (err) { /* 云端不可用时保持空态，不伪造委托记录 */ }
  },

  /* 我的缴费：收款单由平台财务登记，确认 / 退款后状态同步回显 */
  async loadPayments() {
    try {
      const [res, rf] = await Promise.all([
        request('user', 'payment.mine', { page: 1, limit: 20 }, { silent: true }),
        request('user', 'refund.mine', { page: 1, limit: 20 }, { silent: true })
      ])
      const items = (res && res.items) || []
      /* 同一收款单取最新一条退款申请展示进度 */
      const byPayment = {}
      ;((rf && rf.items) || []).forEach((r) => {
        if (!byPayment[r.paymentId]) byPayment[r.paymentId] = r
      })
      const list = items.map((p) => {
        const status = p.status || '待确认'
        const refund = byPayment[p.id]
        return {
          id: p.id,
          title: (p.bizType || '收款') + (p.planLabel ? ' · ' + p.planLabel : ''),
          status,
          statusCls: status === '已确认' ? 'st-ok' : (status === '已退款' ? 'st-offline' : 'st-pending'),
          amountText: '¥' + (Number(p.received) || 0),
          meta: [p.method, p.days ? p.days + ' 天' : ''].filter(Boolean).join(' · '),
          atText: fmtTime(p.paidAt || p.createdAt),
          noteText: status === '已确认' ? '财务已确认到账' : (status === '已退款' ? '已按原路退回' : '等待平台财务确认到账'),
          refundStatus: refund ? refund.status : '',
          refundNote: refund && refund.handlerNote ? refund.handlerNote : ''
        }
      })
      this.setData({ payList: list })
      this.buildMenu()
    } catch (err) { /* 云端不可用时保持空态 */ }
  },

  /* 举报 / 反馈：管理端处置后 handlerNote 作为平台回复展示在这里 */
  async loadReports() {
    try {
      const res = await request('user', 'report.mine', { page: 1, limit: 20 }, { silent: true })
      const list = ((res && res.items) || []).map((r) => {
        const status = r.status || '待处理'
        return {
          id: r.id,
          type: r.type || '意见反馈',
          status,
          statusCls: status === '已处理' ? 'st-ok' : (status === '已驳回' ? 'st-reject' : 'st-pending'),
          content: r.content || '',
          targetTitle: r.targetTitle || '',
          reply: r.handlerNote || '',
          atText: fmtTime(r.createdAt),
          handledText: r.handledAt ? fmtTime(r.handledAt) : ''
        }
      })
      this.setData({ reportList: list })
      this.buildMenu()
    } catch (err) { /* 云端不可用时保持空态 */ }
  },

  onReportType(e) {
    this.setData({ reportType: (e.currentTarget.dataset || {}).type || '意见反馈' })
  },

  onReportInput(e) {
    const field = (e.currentTarget.dataset || {}).field
    if (!field) return
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  async submitReport() {
    const content = String(this.data.reportContent || '').trim()
    if (content.length < 5) {
      wx.showToast({ title: '请描述清楚问题（至少 5 个字）', icon: 'none' })
      return
    }
    if (this.data.reportSending) return
    this.setData({ reportSending: true })
    try {
      await request('user', 'report.create', {
        type: this.data.reportType,
        targetType: 'other',
        targetTitle: String(this.data.reportTarget || '').trim(),
        content,
        contact: String(this.data.reportContact || '').trim()
      })
      this.setData({ reportContent: '', reportTarget: '', reportContact: '', reportSending: false })
      wx.showToast({ title: '已提交，平台会尽快处理', icon: 'none' })
      this.loadReports()
    } catch (err) {
      this.setData({ reportSending: false })
    }
  },

  // 自定义 tabBar 的选中态由页面自己同步
  syncTabBar() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 })
    }
  },

  /* 二级视图是整屏的，底部导航要让位：
     菜单页显示，进任何二级视图（我的委托 / 我的资质 / 设置…）即隐藏，返回菜单再恢复 */
  syncTabHidden() {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (!bar) return
    const hidden = this.data.view !== 'menu'
    if (bar.data.hidden !== hidden) bar.setData({ hidden })
  },

  /* 菜单角标：各分类的条数，只做提示，不做统计排行。
     浏览记录 / 我的收藏 / 我的关注只是入口，不显示数字角标；
     「我发布的」显示收到的新回复数，「我的商机」只显示已领取条数（不含商机池可领取）。 */
  buildMenu() {
    const d = this.data
    const counts = {
      /* 收到的新回复：红点数字挂在「我发布的」入口上 */
      pub: d.commentUnread ? (d.commentUnread > 99 ? '99+' : d.commentUnread) : '',
      biz: d.bizClaimed || '',
      agency: d.agencyList.length,
      pay: d.payList.length,
      follow: '',
      history: '',
      fav: '',
      report: d.reportList.filter((r) => r.status === '待处理' || r.status === '处理中').length,
      set: ''
    }
    this.setData({
      quick: QUICKS.map((q) => Object.assign({}, q, { cnt: counts[q.k] || 0 })),
      menu: MENUS.map((m) => Object.assign({}, m, { cnt: counts[m.k] }))
    })
  },

  loadFav() {
    const store = fav.read()
    const pIds = (store.product || []).map(String)
    const dIds = (store.demand || []).map(String)
    /* 本地演示数据里能查到的先立即渲染，查不到的走云端拉详情 */
    const favProducts = pIds.map((id) => M.productById(id)).filter(Boolean)
    const favDemands = dIds.map((id) => M.demandById(id)).filter(Boolean)
    this.setData({
      favProducts,
      favDemands,
      favList: this.favListOf(this.data.favTab, favProducts, favDemands, this.data.favNews)
    })
    this.buildMenu()
    /* 云端收藏（不在演示数据里的 id）单独取详情；拉不到的说明已下架，不再展示 */
    const missP = pIds.filter((id) => !M.productById(id))
    const missD = dIds.filter((id) => !M.demandById(id))
    if (missP.length || missD.length) this.loadFavRemote(missP, missD)
  },

  /* 收藏页签对应的列表：货源 / 求购需求 / 资讯 */
  favListOf(tab, products, demands, news) {
    if (tab === 'demand') return demands
    if (tab === 'news') return news
    return products
  },

  /* 我收藏的资讯：已删除 / 已下架的资讯保留条目但标记失效 */
  async loadFavNews() {
    try {
      const res = await request('user', 'news.fav.list', {}, { silent: true })
      const favNews = ((res && res.items) || []).map((item) => ({
        id: item.id,
        title: item.title,
        cat: item.cat || '',
        city: item.city || '',
        author: item.author || '',
        published: item.publishedText || '',
        valid: item.valid !== false
      }))
      this.setData({
        favNews,
        favList: this.favListOf(this.data.favTab, this.data.favProducts, this.data.favDemands, favNews)
      })
    } catch (err) { /* 云端不可用：保留已有收藏 */ }
  },

  /* 收藏里的云端条目：按 id 取详情，返回结构与本地区目一致 */
  async loadFavRemote(productIds, demandIds) {
    const [ps, ds] = await Promise.all([
      Promise.all(productIds.map((id) =>
        request('user', 'product.detail', { id }, { silent: true }).catch(() => null))),
      Promise.all(demandIds.map((id) =>
        request('user', 'demand.detail', { id }, { silent: true }).catch(() => null)))
    ])
    const moreP = ps.filter((d) => d && d.id).map((d) => {
      const item = shop.toProduct(d)
      item.kind = 'product'
      return item
    })
    const moreD = ds.filter((d) => d && d.id).map((d) => {
      const item = shop.toDemand(d)
      item.kind = 'demand'
      return item
    })
    if (!moreP.length && !moreD.length) return
    const favProducts = this.data.favProducts.concat(moreP)
    const favDemands = this.data.favDemands.concat(moreD)
    this.setData({
      favProducts,
      favDemands,
      favList: this.favListOf(this.data.favTab, favProducts, favDemands, this.data.favNews)
    })
    this.buildMenu()
  },

  loadUser() {
    const u = readUser() || {}
    let app = null
    try {
      app = getApp()
    } catch (e) { /* 非页面环境（构建期检查）忽略 */ }
    const geo = !!u.geo || !!(app && app.globalData && app.globalData.geo)
    /* 微信授权登录后：头像、昵称与手机号（脱敏）都由登录态带入 */
    this.setData({
      user: {
        nick: u.nick || '微信用户',
        avatar: u.avatar || '',
        avatarText: String(u.nick || '算').slice(0, 1),
        city: u.city || '未填写城市',
        phoneText: u.phoneMasked || u.phone || '手机号未授权',
        phoneOn: !!(u.phoneMasked || u.phone),
        joined: u.joined || '刚刚',
        /* 用户ID：用户本人可见，报给客服即可按 ID 查账号 / 开权限 */
        userNo: u.userNo || '',
        login: !!u.login,
        geo,
        subject: u.subject || '',
        subjectKindText: u.subjectKind === 'person' ? '个人主体' : (u.subjectKind === 'company' ? '企业主体' : '未设置')
      }
    })
  },

  /* 复制用户ID：用户报给客服即可按 ID 查账号 / 开权限 */
  copyUserNo() {
    const no = (this.data.user && this.data.user.userNo) || ''
    if (!no) return
    wx.setClipboardData({
      data: no,
      success: () => wx.showToast({ title: '用户ID已复制', icon: 'none' })
    })
  },

  /* 关注列表：只展示关注的账号；账号注销后保留条目并标记 */
  loadFollows() {
    const accounts = fav.readFollows()
      /* 历史遗留的商品关注不再展示，商品统一走收藏 */
      .filter((f) => f.type !== 'product')
      .map((f) => Object.assign({}, f, {
        short: f.short || String(f.nick || '货').slice(-1),
        valid: f.valid !== false,
        count: M.PRODUCTS.filter((p) => p.owner && p.owner.nick === f.id).length
      }))
    this.setData({ follows: accounts, followAccounts: accounts, followList: accounts })
    this.buildMenu()
    this.loadFollowOverview()
  },

  /* 关注对象有效性：账号注销后仍保留条目，只标记失效 */
  async loadFollowOverview() {
    try {
      const res = await request('user', 'follow.overview', {}, { silent: true })
      const rows = (res && res.accounts) || []
      const map = {}
      rows.forEach((row) => { map[String(row.id)] = row })
      const accounts = this.data.followAccounts.map((f) => {
        const hit = map[String(f.id)]
        if (!hit) return f
        return Object.assign({}, f, {
          valid: hit.valid !== false,
          invalidText: hit.invalidText || (hit.valid === false ? '账号已注销' : ''),
          count: Number(hit.count) || f.count
        })
      })
      this.setData({ follows: accounts, followAccounts: accounts, followList: accounts })
    } catch (err) { /* 云端不可用：保留本地关注 */ }
  },

  /* 我发出的评论与收到的回复：未读回复计入「我发布的」角标 */
  async loadComments() {
    try {
      const res = await request('user', 'news.comment.mine', {}, { silent: true })
      const commentList = ((res && res.items) || []).map((item) => ({
        id: item.id,
        content: item.content,
        newsId: item.newsId,
        newsTitle: item.newsTitle,
        newsValid: item.newsValid !== false,
        createdText: item.createdText || '',
        replies: (item.replies || []).map((rep) => ({
          id: rep.id,
          author: rep.author,
          content: rep.content,
          createdText: rep.createdText || '',
          unread: rep.unread === true
        })),
        replyCount: (item.replies || []).length,
        unread: Number(item.unread) || 0
      }))
      this.setData({ commentList, commentUnread: Number(res && res.unread) || 0 })
      this.buildMenu()
      /* 已打开「我的评论」：清空云端未读位置，下次进入不再提示 */
      request('user', 'news.comment.read', {}, { silent: true })
        .then(() => {
          const cleared = this.data.commentList.map((item) => Object.assign({}, item, {
            unread: 0,
            replies: (item.replies || []).map((rep) => Object.assign({}, rep, { unread: false }))
          }))
          this.setData({ commentList: cleared, commentUnread: 0 })
          this.buildMenu()
        })
        .catch(() => {})
    } catch (err) { /* 云端不可用：保留已有列表 */ }
  },

  /* 只查角标：用户没进「我的评论」也能看到红点 */
  async loadCommentBadge() {
    try {
      const res = await request('user', 'news.badge', {}, { silent: true })
      const unread = Math.max(0, Number(res && res.replies) || 0)
      if (unread !== this.data.commentUnread) {
        this.setData({ commentUnread: unread })
        this.buildMenu()
      }
    } catch (err) {}
  },

  /* 商机会员引导：未开通时在「浏览记录」上方留一行入口，开通后自动收起 */
  loadBizGuide() {
    /* 默认展示引导：只有服务端明确返回已开通才收起，避免登录态未就绪时整条消失 */
    request('user', 'biz.badge', {}, { silent: true })
      .then((res) => {
        const locked = !(res && res.unlocked === true)
        const claimed = Math.max(0, Number(res && res.claimed) || 0)
        if (locked !== this.data.bizLocked || claimed !== this.data.bizClaimed) {
          this.setData({ bizLocked: locked, bizClaimed: claimed })
          this.buildMenu()
        }
      })
      .catch(() => {})
  },

  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz?mode=mine' })
  },

  /* 浏览记录：商品与需求混合，最新的排在最前 */
  loadViews() {
    const views = fav.readViews().map((v) => Object.assign({}, v, {
      kindText: v.kind === 'demand' ? '求购需求' : '商品',
      atText: fmtTime(v.at)
    }))
    this.setData({ views })
    this.buildMenu()
  },

  /* 微信消息提醒：申请订阅消息授权，会话 / 系统消息 / 商机消息都会推送 */
  refreshNotify() {
    this.setData({ notifyOn: notify.enabled() })
    this.loadNotifyPrefs()
  },

  /* 商机提醒偏好以服务端为准，换设备后保持一致 */
  async loadNotifyPrefs() {
    try {
      const res = await request('user', 'notify.prefs', {}, { silent: true })
      if (res && typeof res.biz === 'boolean') this.setData({ notifyBiz: res.biz })
    } catch (err) {}
  },

  /* 商机提醒开关：只影响微信推送，站内消息始终保留 */
  async toggleNotifyBiz(e) {
    const on = !!(e && e.detail && e.detail.value)
    this.setData({ notifyBiz: on })
    try {
      await request('user', 'notify.save', { biz: on })
      wx.showToast({ title: on ? '已开启商机提醒' : '已关闭商机提醒', icon: 'none' })
    } catch (err) {
      this.setData({ notifyBiz: !on })
      wx.showToast({ title: '设置失败，请稍后重试', icon: 'none' })
    }
  },

  async enableNotify() {
    if (notify.enabled()) {
      const on = await notify.openSetting()
      this.setData({ notifyOn: on })
      wx.showToast({ title: on ? '保持开启' : '已关闭微信消息提醒', icon: 'none' })
      return
    }
    const on = await notify.enable(['inquiry', 'chat', 'system', 'biz'])
    this.setData({ notifyOn: on })
  },

  /* 进设置页：同步本机水印偏好 */
  loadSetPrefs() {
    this.setData({ wmOn: prefs.watermarkOn() })
  },

  /* 水印保护：默认开启，关闭后聊天与作品图片、视频不再叠加水印 */
  toggleWatermark() {
    const next = !this.data.wmOn
    prefs.setWatermark(next)
    this.setData({ wmOn: next })
    wx.showToast({ title: next ? '水印保护已开启' : '水印保护已关闭', icon: 'none' })
  },

  openView(e) {
    const view = e.currentTarget.dataset.k
    if (!view) return
    const entry = QUICKS.concat(MENUS).filter((x) => x.k === view)[0]
    /* 直接跳页的菜单项（如「我的商机」）：不进二级页，交给目标页面处理 */
    if (entry && entry.url) {
      wx.navigateTo({ url: entry.url })
      return
    }
    /* 二级视图独立成页：系统返回直接回到「我的」，不会退出小程序 */
    const sub = view === 'pub' ? '&sub=' + encodeURIComponent(this.data.subTab) : ''
    wx.navigateTo({ url: '/pages/mine/sub/sub?view=' + encodeURIComponent(view) + sub })
  },

  /* 我的订单：会员开通记录 / 代采代售订单，只做历史查询 */
  switchOrderTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.orderTab) return
    this.setData({ orderTab: tab })
  },

  noop() {},

  /* 打开修改面板：回填当前上架内容，条件项原样保存在 editConds */
  openAgencyEdit(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    const item = (this.data.agencyList || []).find((a) => String(a.id) === id)
    if (!item) return
    this.setData({
      editOpen: true,
      editId: id,
      editForm: {
        item: item.itemName || '',
        qty: String(item.rawQty || ''),
        price: String(item.rawPrice || ''),
        city: item.rawCity || '',
        detail: item.rawDetail || ''
      },
      editConds: {
        flow: item.flow || [],
        must: item.must || [],
        nego: item.nego || []
      }
    })
  },

  closeAgencyEdit() {
    if (this.data.editSaving) return
    this.setData({ editOpen: false, editId: '' })
  },

  onAgencyEditInput(e) {
    const field = (e.currentTarget.dataset || {}).field
    if (!field) return
    this.setData({ ['editForm.' + field]: e.detail.value })
  },

  /* 提交修改：服务端会先把委托置为待审核（等于临时下架），审核通过后自动更新并重新上架 */
  async submitAgencyEdit() {
    if (this.data.editSaving) return
    const id = this.data.editId
    const form = this.data.editForm || {}
    const item = String(form.item || '').trim()
    const qty = Number(form.qty)
    const price = Number(form.price)
    if (!id) return
    if (item.length < 2) {
      wx.showToast({ title: '请填写设备名称（至少 2 个字）', icon: 'none' })
      return
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) {
      wx.showToast({ title: '数量需为 1 - 9999 的整数', icon: 'none' })
      return
    }
    if (!Number.isFinite(price) || price < 0) {
      wx.showToast({ title: '请填写正确的单价', icon: 'none' })
      return
    }
    this.setData({ editSaving: true })
    try {
      await request('user', 'agency.update', {
        id,
        item,
        qty,
        price,
        city: String(form.city || '').trim(),
        detail: String(form.detail || '').trim(),
        flow: (this.data.editConds || {}).flow || [],
        must: (this.data.editConds || {}).must || [],
        nego: (this.data.editConds || {}).nego || []
      }, { silent: false })
      this.setData({ editOpen: false, editId: '' })
      wx.showToast({ title: '已提交，审核后自动更新', icon: 'none', duration: 2500 })
      this.loadAgencies()
    } catch (err) {
      /* request 已按错误码提示（非本人 / 状态已变化 / 已有修改待审核） */
    } finally {
      this.setData({ editSaving: false })
    }
  },

  goMenu() {
    /* 二级页：交给页面栈返回，回到「我的」菜单 */
    if (this.data.mode === 'sub') {
      wx.navigateBack()
      return
    }
    this.setData({ view: 'menu', viewTitle: '', seller: null })
    this.syncTabHidden()
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  /* 刚存完草稿：直接打开「我发布的」对应子类，避免用户以为草稿丢了 */
  openPendingPub() {
    let app = null
    try {
      app = getApp()
    } catch (e) {}
    const sub = (app && app.globalData && app.globalData.minePub) || ''
    if (!sub) return
    app.globalData.minePub = ''
    const tab = sub === 'demand' ? 'demand' : (sub === 'news' ? 'news' : 'product')
    wx.navigateTo({ url: '/pages/mine/sub/sub?view=pub&sub=' + tab })
  },

  /* 委托刚提交：直接打开「我的委托」看进度 */
  openPendingAgency() {
    let app = null
    try {
      app = getApp()
    } catch (e) {}
    if (!app || !app.globalData || app.globalData.mineView !== 'agency') return
    app.globalData.mineView = ''
    wx.navigateTo({ url: '/pages/mine/sub/sub?view=agency' })
  },

  /* 点头像 / 昵称进入对方主页：只看公开发布的货源，看不到手机号与联系人 */
  openSeller(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const rec = this.data.follows.filter((f) => f.id === id)[0] ||
      fav.readFollows().filter((f) => f.id === id)[0] || { id }
    /* 关注的账号已注销：保留在列表里，但不再进入主页 */
    if (rec.valid === false) {
      wx.showToast({ title: rec.invalidText || '该账号已注销', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/mine/sub/sub?view=seller&id=' + encodeURIComponent(id) })
  },

  /* 卖家主页：二级页按 id 渲染 */
  applySeller(id) {
    if (!id) return
    const rec = this.data.follows.filter((f) => f.id === id)[0] ||
      fav.readFollows().filter((f) => f.id === id)[0] || { id }
    const products = M.PRODUCTS
      .filter((p) => p.owner && p.owner.nick === id)
      .map((p) => ({
        id: p.id,
        title: p.title,
        cat: p.cat,
        city: p.city,
        priceText: p.priceText,
        tradeMode: p.tradeMode,
        isRent: !!p.isRent
      }))
    this.setData({
      view: 'seller',
      viewTitle: '卖家主页',
      seller: {
        id,
        nick: rec.nick || id,
        short: rec.short || String(rec.nick || id).slice(-1),
        city: rec.city || '',
        count: products.length,
        following: fav.isFollowing(id)
      },
      sellerList: products
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  toggleSellerFollow() {
    const s = this.data.seller
    if (!s) return
    const on = fav.toggleFollow({ id: s.id, nick: s.nick, short: s.short, city: s.city })
    this.setData({ 'seller.following': on })
    this.loadFollows()
    wx.showToast({ title: on ? '已关注' : '已取消关注', icon: 'none' })
  },

  unfollow(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    fav.removeFollow(id)
    this.loadFollows()
    if (this.data.seller && this.data.seller.id === id) {
      this.setData({ 'seller.following': false })
    }
    wx.showToast({ title: '已取消关注', icon: 'none' })
  },

  clearViews() {
    wx.showModal({
      title: '清空浏览记录',
      content: '浏览记录仅保存在本机，清空后不可恢复。',
      success: (res) => {
        if (!res.confirm) return
        fav.clearViews()
        this.loadViews()
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  },

  switchSub(e) {
    const sub = e.currentTarget.dataset.sub
    if (!sub) return
    /* 我的评论：列表来自云端，进入页签即拉取并清空回复角标 */
    if (sub === 'comment') {
      this.setData({ subTab: sub })
      this.loadComments()
      return
    }
    this.setData({
      subTab: sub,
      pubList: this.pubListOf(sub, this.data.myProducts, this.data.myDemands, this.data.myNews)
    })
  },

  switchFav(e) {
    const sub = e.currentTarget.dataset.sub
    if (!sub) return
    this.setData({
      favTab: sub,
      favList: this.favListOf(sub, this.data.favProducts, this.data.favDemands, this.data.favNews)
    })
    /* 资讯收藏只有云端有标题，切到资讯页签时拉取 */
    if (sub === 'news') this.loadFavNews()
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  /* 在线客服：进入平台内的官方客服会话，消息发给管理端坐席，不走微信客服 */
  goService() {
    const app = getApp()
    if (app && app.globalData) app.globalData.openChat = true
    wx.switchTab({ url: '/pages/msg/msg' })
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' })
  },

  /* 账号注销：先查最新一条申请，待处理时展示撤回入口 */
  async loadDeleteStatus() {
    try {
      const res = await request('user', 'account.deleteStatus', {}, { silent: true })
      if (!res || !res.status) {
        this.setData({ delReq: null })
        return
      }
      this.setData({
        delReq: {
          id: res.id,
          status: res.status,
          handlerNote: res.handlerNote || '',
          createdAt: fmtTime(res.createdAt),
          handledText: res.handledAt ? fmtTime(res.handledAt) : '',
          pending: res.status === '待处理'
        }
      })
    } catch (err) { /* 查询失败不打扰用户 */ }
  },

  applyDelete() {
    wx.showModal({
      title: '申请注销账号',
      content: '注销后账号将停用，发布的内容与交易记录仍会按法规留存。确定提交申请？',
      confirmText: '提交申请',
      success: async (res) => {
        if (!res.confirm) return
        wx.showModal({
          title: '注销原因',
          editable: true,
          placeholderText: '请简要说明原因（选填）',
          content: '',
          success: async (r2) => {
            if (!r2.confirm) return
            try {
              await request('user', 'account.deleteApply', { reason: r2.content || '' }, { silent: false })
              wx.showToast({ title: '已提交，等待审核', icon: 'none' })
              this.loadDeleteStatus()
            } catch (err) {
              /* request 已按错误码提示 */
            }
          }
        })
      }
    })
  },

  cancelDelete() {
    wx.showModal({
      title: '撤回注销申请',
      content: '撤回后账号继续正常使用，确定撤回？',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'account.deleteCancel', {}, { silent: false })
          wx.showToast({ title: '已撤回', icon: 'success' })
          this.loadDeleteStatus()
        } catch (err) {
          /* request 已按错误码提示 */
        }
      }
    })
  },

  goHome() {
    /* 首页 / 资讯共用一个页面：回首页必须显式指定落点 */
    const app = getApp()
    if (app && app.globalData) app.globalData.homeTab = 'sell'
    wx.switchTab({ url: '/pages/home/home' })
  },

  goPublish() {
    /* 资讯投稿入口在首页资讯圈：带落点切到首页，由首页 onShow 打开资讯视图 */
    if (this.data.subTab === 'news') {
      const app = getApp()
      if (app && app.globalData) app.globalData.homeTab = 'news'
      wx.switchTab({ url: '/pages/home/home' })
      return
    }
    wx.navigateTo({ url: '/pages/publish/publish' })
  },

  viewProduct(e) {
    const id = String(e.currentTarget.dataset.id)
    const type = e.currentTarget.dataset.type
    // data-type 为 product / demand 或「商品 / 需求」
    if (type === 'demand' || type === '需求') {
      wx.navigateTo({ url: '/pages/demand/demand?id=' + id })
      return
    }
    wx.navigateTo({ url: '/pages/product/product?id=' + id })
  },

  editProduct(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const kind = String(e.currentTarget.dataset.kind || this.data.subTab || 'product')
    /* 进发布页的编辑模式：按 id 回填，保存时走 product.update / demand.update */
    wx.navigateTo({
      url: '/pages/publish/publish?id=' + encodeURIComponent(id) + '&kind=' + (kind === 'demand' ? 'demand' : 'product')
    })
  },

  /** 发布：草稿 / 已驳回可直接发布上架（审核不是发布的前置路径） */
  async submitPub(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const kind = String(e.currentTarget.dataset.kind || this.data.subTab)
    if (!id) return
    const action = kind === 'demand' ? 'demand.submit' : 'product.submit'
    /* 草稿转发布前先确认主体信息与联系方式齐全，缺项引导去个人信息页 */
    if (!(await ensureProfileReady())) return
    try {
      await request('user', action, { id }, { silent: false })
      wx.showToast({ title: '已发布上架', icon: 'success' })
      /* 状态已变：标记快照失效，避免 loadRemote 命中 60s 缓存看到旧状态 */
      const app = getApp()
      if (app && app.globalData) app.globalData.mineDirty = true
      this.loadRemote()
    } catch (err) {
      /* request 已按错误码提示（字段不全 / 状态冲突），留在当前页 */
    }
  },

  /**
   * 自助收尾：下架 / 重新上架 / 关闭需求 / 重新开启。
   * 动作与后端 action 一一对应，成功后重新拉取列表，状态以服务端为准。
   */
  endPublish(e) {
    const ds = e.currentTarget.dataset || {}
    const id = String(ds.id || '')
    const act = String(ds.act || '')
    if (!id || !act) return
    const conf = {
      offline: { action: 'product.offline', title: '下架商品', content: '下架后不再出现在首页，也无法被咨询；需要时可重新上架。', toast: '已下架' },
      online: { action: 'product.online', title: '重新上架', content: '重新上架后商品会再次出现在首页。', toast: '已重新上架' },
      close: { action: 'demand.close', title: '关闭需求', content: '关闭后不再接受新的响应；需要时可重新开启。', toast: '已关闭需求' },
      reopen: { action: 'demand.reopen', title: '重新开启', content: '重新开启后需求会再次出现在求购列表。', toast: '已重新开启' }
    }[act]
    if (!conf) return
    wx.showModal({
      title: conf.title,
      content: conf.content,
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', conf.action, { id }, { silent: false })
          wx.showToast({ title: conf.toast, icon: 'none' })
          /* 下架 / 重新上架 / 关闭 / 开启后状态已变，标记快照失效 */
          const app = getApp()
          if (app && app.globalData) app.globalData.mineDirty = true
          this.loadRemote()
        } catch (err) {
          /* request 已按错误码提示（状态冲突 / 平台下架等），留在当前页 */
        }
      }
    })
  },

  /**
   * 删除自己发布的内容：商品 / 求购需求 / 资讯统一入口。
   * 删除后立即从本页移除并回源，避免 60 秒快照里残留已删条目。
   */
  deletePub(e) {
    const ds = e.currentTarget.dataset || {}
    const id = String(ds.id || '')
    const kind = String(ds.kind || this.data.subTab || 'product')
    if (!id) return
    const conf = {
      product: { action: 'product.delete', title: '删除商品', content: '删除后商品不再展示，已对接的沟通会同步结束。删除后不可恢复。', toast: '商品已删除' },
      demand: { action: 'demand.delete', title: '删除求购需求', content: '删除后需求不再展示，已对接的沟通会同步结束。删除后不可恢复。', toast: '需求已删除' },
      news: { action: 'news.delete', title: '删除资讯', content: '删除后这条资讯会从资讯圈移除，删除后不可恢复。', toast: '资讯已删除' }
    }[kind]
    if (!conf) return
    wx.showModal({
      title: conf.title,
      content: conf.content,
      confirmText: '删除',
      confirmColor: '#d93026',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', conf.action, { id }, { silent: false })
          wx.showToast({ title: conf.toast, icon: 'none' })
          this.removePub(kind, id)
          const app = getApp()
          if (app && app.globalData) app.globalData.mineDirty = true
          this.loadRemote()
        } catch (err) {
          /* request 已按错误码提示（非本人 / 已删除），留在当前页 */
        }
      }
    })
  },

  /* 本地立即移除已删条目，并同步快照 */
  removePub(kind, id) {
    const drop = (list) => list.filter((x) => String(x.id) !== String(id))
    const myProducts = kind === 'product' ? drop(this.data.myProducts) : this.data.myProducts
    const myDemands = kind === 'demand' ? drop(this.data.myDemands) : this.data.myDemands
    const myNews = kind === 'news' ? drop(this.data.myNews) : this.data.myNews
    this.setData({
      myProducts,
      myDemands,
      myNews,
      pubList: this.pubListOf(this.data.subTab, myProducts, myDemands, myNews)
    })
    writeCache(CACHE_PUB, { products: myProducts, demands: myDemands, news: myNews })
  },

  /* 打开委托详情：流程节点、各节点时间与处理人只在面板里展示 */
  openAgencyDetail(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    const item = (this.data.agencyList || []).filter((a) => String(a.id) === id)[0]
    if (!item) return
    this.setData({ agencyDetailOpen: true, agencyDetail: item })
  },

  closeAgencyDetail() {
    this.setData({ agencyDetailOpen: false, agencyDetail: null })
  },

  /* 确认成交：委托方确认后服务端再计算服务费，到账状态以 feeStatusText 为准 */
  confirmDeal(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    wx.showModal({
      title: '确认成交',
      content: '确认本次委托已成交？确认后按成交金额结算服务费，可在委托详情查看服务费状态。',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'agency.dealConfirm', { id }, { silent: false })
          wx.showToast({ title: '已确认成交', icon: 'none' })
          this.loadAgencies()
        } catch (err) {
          /* request 已按错误码提示（状态已变化 / 非本人委托） */
        }
      }
    })
  },

  /* 撤销委托：由服务端按状态给出 canCancel，成功后以服务端状态为准 */
  cancelAgency(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    wx.showModal({
      title: '撤销委托',
      content: '撤销后该委托不再进入商机池；如已支付服务费，请凭付款记录联系客服处理。需要时可重新提交委托。',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'agency.cancel', { id }, { silent: false })
          wx.showToast({ title: '已撤销委托', icon: 'none' })
          this.loadAgencies()
        } catch (err) {
          /* request 已按错误码提示（已上架需联系客服 / 状态已结束） */
        }
      }
    })
  },

  /* 被驳回的委托：回代采 / 代售发布页，预填原内容并允许重传材料后重新提交 */
  resubmitAgency(e) {
    const ds = e.currentTarget.dataset || {}
    const id = String(ds.id || '')
    const side = String(ds.side || '')
    if (!id) return
    wx.navigateTo({ url: '/pages/publish/publish?agency=' + (side === 'sell' ? 'sell' : 'buy') + '&agencyId=' + id })
  },

  /* 删除被驳回的委托：软删除，删除后不再出现在我的委托 */
  deleteAgency(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    wx.showModal({
      title: '删除委托',
      content: '删除后该委托不再出现在我的委托中，且无法恢复。',
      confirmText: '确认删除',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'agency.delete', { id }, { silent: false })
          wx.showToast({ title: '已删除', icon: 'none' })
          this.loadAgencies()
        } catch (err) {
          /* request 已按错误码提示（仅被驳回的委托可删除） */
        }
      }
    })
  },

  /* 我已支付：只向平台上报付款信号，到账仍以财务核对为准 */
  reportPaid(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    wx.showModal({
      title: '确认已支付服务费',
      editable: true,
      placeholderText: '可填写付款时间 / 末四位流水号（选填）',
      content: '',
      success: async (res) => {
        if (!res.confirm) return
        try {
          const out = await request('user', 'agency.paid', { id, note: res.content || '' }, { silent: false })
          wx.showToast({ title: (out && out.hint) || '已上报，等待平台确认', icon: 'none', duration: 2500 })
          this.loadAgencies()
        } catch (err) {
          /* request 已按错误码提示 */
        }
      }
    })
  },

  /* 确认收货：成交后由委托方确认，确认即结束本次委托 */
  confirmReceipt(e) {
    const id = String((e.currentTarget.dataset || {}).id || '')
    if (!id) return
    const item = (this.data.agencyList || []).find((a) => a.id === id) || {}
    wx.showModal({
      title: '确认收货',
      content: '确认已收到本次委托的' + (item.title || '货物') + '（成交金额 ' + (item.dealAmountText || '面议') + '）？确认后委托即结束，不可撤销。',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'agency.receipt', { id }, { silent: false })
          wx.showToast({ title: '已确认收货，委托结束', icon: 'none' })
          this.loadAgencies()
        } catch (err) {
          /* request 已按错误码提示（未成交 / 已确认收货） */
        }
      }
    })
  },

  unfav(e) {
    const id = e.currentTarget.dataset.id
    const type = this.data.favTab === 'product' ? 'product'
      : (this.data.favTab === 'news' ? 'news' : 'demand')
    fav.toggleFav(type, id)
    this.loadFav()
    if (type === 'news') this.loadFavNews()
    wx.showToast({ title: '已取消收藏', icon: 'none' })
  },

  /* 打开收藏的资讯：资讯被删除 / 下架后只提示失效 */
  openFavNews(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const item = this.data.favNews.filter((f) => String(f.id) === id)[0] || {}
    if (item.valid === false) {
      wx.showToast({ title: '资讯已失效', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/news/news?id=' + encodeURIComponent(id) })
  },

  clearCache() {
    try {
      wx.removeStorageSync(fav.FAV_KEY)
      wx.removeStorageSync(fav.FOLLOW_KEY)
      wx.removeStorageSync(fav.VIEW_KEY)
    } catch (e) {}
    this.loadFav()
    this.loadFollows()
    this.loadViews()
    wx.showToast({ title: '本地缓存已清空', icon: 'none' })
  },

  doLogout() {
    wx.showModal({
      title: '确认退出',
      content: '退出后需重新授权登录',
      success: (res) => {
        if (res.confirm) {
          logout()
          wx.reLaunch({ url: '/pages/login/login' })
        }
      }
    })
  }
}

module.exports = { BASE }
