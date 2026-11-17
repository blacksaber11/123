/* 商品详情页 */
const { gate, readUser } = require('../../utils/auth')
const chat = require('../../utils/chat')
const fav = require('../../utils/fav')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')
const shop = require('../../utils/shop')
const prefs = require('../../utils/prefs')
const bizUtil = require('../../utils/biz')
const { request } = require('../../utils/request')

/* 水印瓦片数量：2 列 × 6 行，铺满整个查看层，任一截图区域都能截到账号标识 */
const WM_TILES = 12

function watermarkOf(productId, user) {
  return {
    /* 查看层底部完整水印：账号、哪条线索、什么时候看的 */
    full: guard.watermarkText(user, productId),
    /* 铺满画面的水印块用的短文案（账号尾 8 位 + 线索 + 时间） */
    tile: guard.watermarkTile(user, productId)
  }
}

function tilesOf(text) {
  return Array.from({ length: WM_TILES }, (_, k) => ({ k, t: text }))
}

/* 价格已带「/ 台」这类单位时直接拼接，避免出现「¥ 9,600 / 台 / 台」 */
function priceWithUnit(text, unit) {
  const u = String(unit || '').trim()
  const s = String(text || '').trim()
  if (!s) return ''
  return /^\//.test(u) ? s + ' ' + u : s
}

/* 海报字段：标题用品牌 + 型号，信息行走数量 / 城市 / 价格 + 单位 / 交易类型 */
function posterSpecOf(p) {
  if (!p) return null
  const rent = p.isRent === true || /租/.test(String(p.tradeMode || ''))
  return {
    id: String(p.id || ''),
    title: [p.brand, p.model].filter(Boolean).join(' ') || p.model || p.cat || '算力设备',
    /* 徽章交给 share-poster 按品类推断：GPU / 内存 / CPU / 整机 / 租赁 */
    isRent: rent,
    qty: p.qty ? String(p.qty) : '',
    unit: '台',
    city: p.city || '',
    priceText: p.priceMode === 'nego' ? (p.priceText || '现场沟通') : priceWithUnit(p.priceText, p.priceUnit),
    priceLabel: rent ? '租金' : '出售价',
    tag: p.tradeMode || (rent ? '出租' : '出售')
  }
}

/* 分享标题：品牌 + 型号 · 数量 · 城市 · 价格（含单位）；数据未就绪时返回空，交给 guard 兜底 */
function shareTitleOf(p) {
  const name = [p.brand, p.model].filter(Boolean).join(' ') || p.model || p.cat || ''
  if (!name) return ''
  return [
    name,
    p.qty ? p.qty + ' 台' : '',
    p.city || '',
    p.priceMode === 'nego' ? '价格现场沟通' : priceWithUnit(p.priceText, p.priceUnit)
  ].filter(Boolean).join(' · ')
}

/* 商机池条目 → 商品详情视图：字段与普通发布一一对齐，全平台共用同一套商品详情页 */
function poolProductOf(o) {
  const info = Array.isArray(o.info) ? o.info : []
  const pick = function () {
    for (let i = 0; i < arguments.length; i++) {
      const hit = info.filter((it) => it && it.k === arguments[i])[0]
      if (hit && hit.v) return String(hit.v)
    }
    return ''
  }
  const kind = String(o.kind || '')
  const isRent = /租/.test(kind)
  const mediaItems = (Array.isArray(o.media) ? o.media : []).map((m) => {
    if (!m) return null
    const url = m.url || m.fileId || m.src || ''
    if (!url) return null
    const type = String(m.type || m.mime || '')
    return {
      kind: m.kind === 'video' || /^video\//i.test(type) ? 'video' : 'image',
      url,
      poster: m.poster || m.cover || ''
    }
  }).filter(Boolean)
  const qty = Number(o.qty) || 0
  return {
    id: o.id,
    poolType: o.type,
    /* 代采 = 平台代买（我供货）；代售 = 平台代卖（我采购） */
    agencySide: o.type === 'agency' ? (o.side || (/代售/.test(kind) ? 'sell' : 'buy')) : '',
    title: o.title || [o.cat, o.model].filter(Boolean).join(' '),
    brand: o.brand || pick('品牌'),
    model: o.model || '',
    cat: o.cat || pick('设备品类') || '',
    qty,
    /* 商机条目没有单独的起订量：留空，避免和可售数量重复展示 */
    minQty: 0,
    supply: pick('供给类型'),
    cond: pick('成色', '成色要求'),
    condLevel: '',
    tax: pick('税费', '税费要求'),
    taxShort: pick('税费', '税费要求'),
    city: o.city || pick('所在城市'),
    deliver: pick('可交付时间', '可起租时间'),
    images: mediaItems.filter((m) => m.kind === 'image').length,
    isRent,
    tradeMode: kind || (o.type === 'demand' ? '求购' : '出售'),
    priceMode: 'fixed',
    priceText: o.priceText || '面议',
    priceUnit: '',
    status: o.closed ? '已关闭' : '在售',
    closed: isRent ? pick('价格方式') : '',
    term: pick('租期', '期望租期'),
    deposit: pick('押金', '押金接受度'),
    pay: pick('租金支付', '付款方式'),
    note: pick('交易说明', '其他说明', '补充说明'),
    accept: pick('验收标准', '验收要求'),
    limit: pick('可承接数量'),
    requirements: pick('接单要求', '承租方要求', '租赁条款要求'),
    flow: (Array.isArray(o.flow) ? o.flow : []).map((t) => ({ n: String(t), d: '' })),
    must: Array.isArray(o.must) ? o.must : [],
    nego: Array.isArray(o.nego) ? o.nego : [],
    mediaItems,
    checklist: [],
    views: Number(o.views) || 0,
    favCount: 0,
    published: o.published || '',
    tags: [],
    isMine: false,
    mine: false,
    privateShare: false,
    /* 商机池不直接公开主体主页，联系方式领取后在会话里对接 */
    contactHidden: true,
    ownerExposure: 'hidden',
    ownerKey: '',
    ownerSubject: o.org || '',
    owner: { short: o.type === 'demand' ? '需' : '商', nick: o.type === 'demand' ? '需求方' : '商机发布方' },
    org: o.org || '',
    platformOnly: o.type === 'agency'
  }
}

Page({
  data: {
    product: null,
    /* 实拍图片 + 视频混排轮播：左右滑动切换，点图片看大图 */
    mediaSlides: [],
    mediaIndex: 0,
    imgCount: 0,
    videoCount: 0,
    /* 媒体数量文案：无实拍时整行由页面显示「暂无实拍」，不出现 0 张 / 0 段 */
    mediaSummary: '',
    /* 水印保护：设置里可关闭，关闭后图片 / 视频 / 查看层都不叠水印 */
    wmOn: true,
    checklistDone: 0,
    checklistTotal: 0,
    checklistPercent: 0,
    fav: false,
    isMine: false,
    /* 保密：缩略图与查看层都叠水印，水印绑定当前登录账号 */
    watermark: '',
    wmTiles: [],
    viewerOpen: false,
    viewerType: 'image',
    /* 查看层当前序号：全屏后仍可左右滑动切换全部图片 / 视频 */
    viewerIndex: 0,
    /* 来自好友分享的落地页：只做提示，不额外暴露任何字段 */
    fromShare: false,
    /* 标的已下架 / 不存在：显示失效态，绝不用演示数据顶替 */
    missing: false,
    /* 顶部发布人的关注状态 */
    pubFollowing: false,
    /* 保密内容：只为非属主隐藏主体与联系方式，内容照常展示 */
    contactHidden: false,
    /* 私密发布：仅分享链接可见，发布人完全匿名 */
    privateShare: false,
    /* 直接对话：必须条件确认弹层 */
    condSheet: false,
    condList: [],
    condMet: 0,
    condTotal: 0,
    condUnmet: 0,
    condPass: false,
    openingChat: false,
    /* 货主自愿公开的联系电话：确认条件后可直接拨号 */
    ownerPhone: '',
    /* 货主公开了电话但当前用户不是商机会员：显示开通引导 */
    memberOnlyContact: false,
    /* 朋友圈单页模式：只能浏览，页面内提示从右上角进入完整小程序 */
    singlePage: false,
    /* 从商机池进入：展示与普通商品完全一致，只在确认条件后先领取再开会话 */
    bizMode: false
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    this.productId = id
    /* 商机池点进来：复用普通商品详情，额外带上领取动作；
       求购 / 代采代售也走这一页，全平台只有这一套商品详情 */
    const biz = String((options && options.biz) || '')
    this.bizType = ['supply', 'demand', 'agency'].indexOf(biz) >= 0 ? biz : ''
    this.bizMode = !!this.bizType
    this.bizMine = this.bizMode && !!(options && options.mine === '1')
    this.setData({ bizMode: this.bizMode, bizType: this.bizType })
    /* 分享链接只带 id 与 from=share，不带 uid / 手机号 / 线索号 */
    this.fromShare = !!(options && options.from === 'share')
    /* 栈底补首页后重建的本页：浏览记录 / 浏览量已由上一实例记过，避免重复计数 */
    this.rootFixed = !!(options && options.__rootfix)
    this.setData({ fromShare: this.fromShare })
    /* 没有 id 就是无效入口：不再兜底到演示商品，避免把假数据当成真实货源 */
    if (!id) {
      this.markMissing()
      return
    }
    this.loadRemote(id)
  },

  /* 云端商品详情：不可见状态（待审核 / 已下架 / 已驳回）对非属主返回不存在 */
  async loadRemote(id) {
    /* 商机池的求购 / 代采代售：取同一条商机数据，版式仍用这套商品详情 */
    if (this.bizType === 'demand' || this.bizType === 'agency') {
      await this.loadPoolItem(id)
      return
    }
    try {
      const doc = await request('user', 'product.detail', { id }, { silent: true })
      if (!doc || !doc.id) {
        this.markMissing()
        return
      }
      /* 保密：内容照常展示，只隐藏主体与联系方式，站内对话不受影响 */
      this.applyProduct(shop.toProduct(doc))
      /* 我的商机点进来：领取时已解锁的联系方式直接在详情页展示 */
      this.loadBizContact()
    } catch (e) {
      /* 云端不可用或商品已下架：有本地数据就继续展示，否则显示失效态 */
      this.markMissing()
    }
  },

  /* 商机池的求购 / 代采代售：数据取自同一条商机，页面仍是这套商品详情 */
  async loadPoolItem(id) {
    try {
      const res = await request('user', 'biz.list', {}, { silent: true })
      const items = (res && res.items) || []
      const item = items.filter((o) => o && String(o.id) === String(id))[0]
      if (!item) {
        this.markMissing()
        return
      }
      this.applyProduct(poolProductOf(item))
      /* 我的商机点进来：领取时已解锁的联系方式直接在详情页展示 */
      this.loadBizContact()
    } catch (e) {
      this.markMissing()
    }
  },

  /* 本地与云端都没有这条商品：说明已下架 / 被删除，而不是换成别的商品 */
  markMissing() {
    if (this.data.product) return
    this.setData({ missing: true })
  },

  applyProduct(product) {
    if (!product) return
    /* 防御：数据源裁剪或缺字段时不让页面白屏 */
    const checklist = Array.isArray(product.checklist) ? product.checklist : []
    const checklistDone = checklist.filter((c) => c && c.ok).length
    const checklistTotal = checklist.length
    // 实拍图片 / 视频：有媒体就展示真实内容，没有才回退到占位块
    const mediaItems = Array.isArray(product.mediaItems) ? product.mediaItems : []
    const mediaSlides = mediaItems
      .filter((m) => m && m.url && (m.kind === 'image' || m.kind === 'video'))
      .map((m, i) => ({ k: String(i), kind: m.kind, url: m.url, poster: m.poster || '' }))
    const imgCount = mediaSlides.filter((m) => m.kind === 'image').length
    const videoCount = mediaSlides.filter((m) => m.kind === 'video').length
    const mediaSummary = [
      imgCount ? imgCount + ' 张图片' : '',
      videoCount ? videoCount + ' 段视频' : ''
    ].filter(Boolean).join(' · ')
    const user = readUser()
    const wm = watermarkOf(product.id || this.productId, user)
    /* 保密内容：服务端不给联系电话，前端同时隐藏「查看主页 / 电话」入口 */
    const privateShare = product.privateShare === true
    const contactHidden = privateShare || product.contactHidden === true
    const ownerPhone = contactHidden ? '' : (product.ownerPhone || '')
    /* 货主公开了电话、但当前用户不是商机会员：只给开通引导，不下发号码 */
    const memberOnlyContact = !contactHidden && product.memberOnlyContact === true

    this.setData({
      product,
      missing: false,
      mediaSlides,
      mediaIndex: 0,
      imgCount,
      videoCount,
      mediaSummary,
      wmOn: prefs.watermarkOn(),
      checklistDone,
      checklistTotal,
      checklistPercent: checklistTotal ? Math.round((checklistDone / checklistTotal) * 100) : 0,
      fav: this.bizType ? false : fav.isFav('product', product.id),
      isMine: !!product.mine,
      contactHidden,
      privateShare,
      ownerPhone,
      memberOnlyContact,
      pubFollowing: contactHidden
        ? false
        : fav.isFollowing(String(product.ownerKey || product.ownerSubject || '')),
      watermark: wm.full,
      wmTiles: tilesOf(wm.tile)
    })
    this.recordView(product)
    this.incrViews(product)
    /* 分享海报跟着这条商品走：换了 id 就重画，同一条复用缓存 */
    this.prepareShare(product)
  },

  /* 浏览量计数：后端按 30 分钟去重，同一用户反复看只算一次；不计自己的发布 */
  incrViews(product) {
    if (!product || !product.id || product.mine || this.rootFixed || this.bizType) return
    request('user', 'view.count', {
      kind: 'product',
      id: product.id
    }, { silent: true }).catch(() => {})
  },

  /* 浏览记录：本地留存，供「我的 - 浏览记录」回看；自己的发布不记录 */
  recordView(product) {
    if (!product || !product.id || product.mine || this.rootFixed || this.bizType) return
    fav.recordView({
      kind: 'product',
      id: product.id,
      title: product.title || product.model || '',
      cat: product.cat || '',
      city: product.city || '',
      priceText: product.priceText || ''
    })
  },

  onShow() {
    if (!gate(this.route || 'pages/product/product', this.options)) return
    /* 货架信息本身对所有人可见，允许「发送给朋友」与分享到朋友圈；线索、材料查看层仍禁止转发 */
    guard.enableShare(true)
    const sp = guard.isSinglePage()
    if (sp !== this.data.singlePage) this.setData({ singlePage: sp })
    /* 水印开关可能在设置里改过：回到商品页立即生效 */
    this.setData({ wmOn: prefs.watermarkOn() })
    /* 返回本页 / 首次进入时数据已就绪：补生成一次海报（同 id 命中缓存不重画） */
    if (this.data.product) this.prepareShare(this.data.product)
  },

  /* 海报按本商品自己的字段生成，临时路径留给分享卡片；失败时保持空串，由 guard 回退静态底图 */
  prepareShare(product) {
    const spec = posterSpecOf(product)
    if (!spec || !spec.id) return
    this.shareSpec = spec
    if (this.shareImage && this.shareSpecId === spec.id) return
    if (this.sharePending === spec.id) return
    this.sharePending = spec.id
    const kind = sharePoster.shareKindOf('product', product)
    sharePoster.prepare(kind, spec).then((path) => {
      this.sharePending = ''
      if (!path) return
      this.shareImage = path
      this.shareSpecId = spec.id
    }, () => {
      this.sharePending = ''
    })
  },

  /* 分享卡片：标题 / 描述 / 底图 / 路径都按本页内容生成，联系方式一律不出现 */
  sharePayload() {
    const p = this.data.product || {}
    const kind = sharePoster.shareKindOf('product', p)
    const spec = this.shareSpec || posterSpecOf(p) || {}
    const poster = this.shareImage || sharePoster.cached(kind, spec)
    const extra = { shareImage: poster }
    const title = shareTitleOf(p)
    if (title) extra.shareTitle = title
    /* 私密发布：分享卡片不带任何主体名 */
    if (this.data.privateShare) extra.org = ''
    return guard.shareCard(kind, Object.assign({}, p, extra), p.id || this.productId)
  },

  onShareAppMessage() {
    const card = this.sharePayload()
    return {
      title: card.title,
      desc: card.desc,
      imageUrl: card.imageUrl,
      path: card.path
    }
  },

  onShareTimeline() {
    const card = this.sharePayload()
    const p = this.data.product || {}
    return {
      title: card.title,
      query: 'id=' + encodeURIComponent(String(p.id || this.productId || '')) + '&from=share',
      imageUrl: card.imageUrl
    }
  },

  /* 保存海报到相册：底部带小程序码，可发朋友圈或转到其他平台 */
  savePoster() {
    const p = this.data.product || {}
    const spec = posterSpecOf(p)
    if (!spec || !spec.id) {
      wx.showToast({ title: '商品还在加载，稍后再试', icon: 'none' })
      return
    }
    const kind = sharePoster.shareKindOf('product', p)
    const id = String(p.id || this.productId || '')
    sharePoster.save(kind, spec, {
      path: '/pages/product/product?id=' + encodeURIComponent(id) + '&from=share'
    }).then((ok) => {
      if (ok) wx.showToast({ title: '海报已存到相册', icon: 'success' })
    })
  },

  onHide() {
    this.stopWatermarkTimer()
  },

  onUnload() {
    this.stopWatermarkTimer()
  },

  /* 查看层打开期间每分钟刷新一次水印时间，保证任何时刻截到的都是「人 + 时间」 */
  startWatermarkTimer() {
    this.stopWatermarkTimer()
    if (!prefs.watermarkOn()) return
    this.wmTimer = setInterval(() => {
      if (!this.data.viewerOpen) return
      const id = this.data.product && this.data.product.id
      const wm = watermarkOf(id, readUser())
      this.setData({ watermark: wm.full, wmTiles: tilesOf(wm.tile) })
    }, 60000)
  },

  stopWatermarkTimer() {
    if (this.wmTimer) {
      clearInterval(this.wmTimer)
      this.wmTimer = null
    }
  },

  toggleFav() {
    const id = this.data.product && this.data.product.id
    if (!id) return
    const on = fav.toggleFav('product', id)
    this.setData({ fav: on })
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  /* 横滑切换媒体：记录当前序号，计数与点击全屏都按这一屏走 */
  onMediaSwipe(e) {
    const index = Number(e && e.detail && e.detail.current) || 0
    if (index === this.data.mediaIndex) return
    this.setData({ mediaIndex: index })
  },

  /* 查看材料：全屏查看层；水印开启时全程叠加账号水印，不提供保存/下载入口 */
  openMedia(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const slides = this.data.mediaSlides || []
    const index = Number(ds.index)
    const slide = Number.isInteger(index) && index >= 0 ? slides[index] : null
    const type = slide ? slide.kind : (ds.type === 'video' ? 'video' : 'image')
    const url = slide ? slide.url : String(ds.url || '')
    this.openViewer(type, url, slide ? index : 0)
  },

  openViewer(type, url, index) {
    if (!url) {
      wx.showToast({ title: '该商品暂未上传实拍' + (type === 'video' ? '视频' : '图片'), icon: 'none' })
      return
    }
    const user = readUser()
    const wmOn = prefs.watermarkOn()
    /* 开启水印时必须是已登录账号：未登录不展示材料，避免出现无法追责的「匿名查看」 */
    if (wmOn && !guard.boundToAccount(user)) {
      const id = this.data.product && this.data.product.id
      wx.showModal({
        title: '登录后才能查看材料',
        content: '商品图片与视频带查看人账号水印，用于泄漏追责。请先登录再查看。',
        confirmText: '去登录',
        success: (res) => {
          if (!res.confirm) return
          wx.navigateTo({
            url: '/pages/login/login?from=' + encodeURIComponent('/pages/product/product?id=' + (id || ''))
          })
        }
      })
      return
    }
    const wm = watermarkOf(this.data.product && this.data.product.id, user)
    this.setData({
      viewerOpen: true,
      viewerType: type === 'video' ? 'video' : 'image',
      viewerIndex: Number(index) || 0,
      wmOn,
      watermark: wm.full,
      wmTiles: tilesOf(wm.tile)
    })
    this.startWatermarkTimer()
  },

  /* 全屏查看层左右滑动：同步标题与类型，视频只在当前屏自动播放 */
  onViewerSwipe(e) {
    const index = Number(e && e.detail && e.detail.current) || 0
    const slide = (this.data.mediaSlides || [])[index] || {}
    this.setData({
      viewerIndex: index,
      viewerType: slide.kind === 'video' ? 'video' : 'image'
    })
  },

  closeViewer() {
    this.stopWatermarkTimer()
    this.setData({ viewerOpen: false })
  },

  noop() {},

  /* 点发布人头像进入对方主页：只展示对方公开发布的内容 */
  openSeller() {
    const p = this.data.product || {}
    /* 私密发布不提供对方主页：入口不渲染，这里也不响应任何跳转 */
    if (this.data.privateShare) return
    /* 主体未公开时不提供主页：避免从「同主体货源」反推出隐藏主体 */
    if (this.data.contactHidden || p.ownerExposure !== 'open' || !p.ownerKey) {
      wx.showToast({ title: '该商家未公开主体，请直接对话沟通', icon: 'none' })
      return
    }
    const o = p.owner || {}
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(p.ownerKey) +
        '&nick=' + encodeURIComponent(o.nick || p.ownerSubject || '货主')
    })
  },

  /* 顶部发布人：关注 / 取消关注（与主页关注共用同一份本地关注列表） */
  togglePubFollow() {
    const p = this.data.product || {}
    if (this.data.isMine) {
      wx.showToast({ title: '不能关注自己', icon: 'none' })
      return
    }
    if (this.data.contactHidden) {
      wx.showToast({ title: '该商家未公开主体，请直接对话沟通', icon: 'none' })
      return
    }
    const id = String(p.ownerKey || p.ownerSubject || '')
    if (!id) {
      wx.showToast({ title: '该商家未公开主体', icon: 'none' })
      return
    }
    const o = p.owner || {}
    const on = fav.toggleFollow({
      id,
      nick: o.nick || p.ownerSubject || '货主',
      short: o.short || String(o.nick || p.ownerSubject || '商').slice(-1),
      city: p.city || '',
      /* 认证状态只认服务端下发，避免本地乐观写入伪造「已认证」 */
      verified: !!(o.verified || p.ownerVerified)
    })
    this.setData({ pubFollowing: on })
    wx.showToast({
      title: on ? '已关注，可在「我的 - 我的关注」查看' : '已取消关注',
      icon: 'none'
    })
  },

  /* 平台代采 / 代售：不展示委托方，只能联系平台客服；
     带上商品上下文进入对话页，管理端按商品归组咨询留言 */
  contactPlatform() {
    const p = this.data.product || {}
    /* 代采 / 代售与其他商机一致：先在页面上确认必须条件，全部满足后由平台对接 */
    if (p.platformOnly) {
      this.consult()
      return
    }
    chat.goKf({
      targetType: 'product',
      targetId: String(p.id || this.productId || ''),
      targetTitle: p.title || [p.brand, p.model].filter(Boolean).join(' ') || p.model || '算力设备',
      /* 会话顶部商品卡：封面 / 价格 / 城市，双方都能看到同一条标的 */
      cover: p.cover || '',
      priceText: p.priceMode === 'nego' ? '价格面议' : ((p.priceText || '') + (p.priceUnit || '')),
      city: p.city || ''
    })
  },

  /* 复制货主公开的联系电话 */
  copyOwnerPhone() {
    const phone = this.data.ownerPhone || ''
    if (!phone) {
      wx.showToast({ title: '该商家未公开联系电话', icon: 'none' })
      return
    }
    chat.copyPhone(phone)
  },

  /* 联系货主：先在页面上逐项确认必须条件，全部满足后直接进入与货主的会话 */
  consult() {
    const p = this.data.product || {}
    if (this.data.isMine) {
      wx.showToast({ title: '不能联系自己的发布', icon: 'none' })
      return
    }
    /* 只有「在售」可发起对话：洽谈中 / 已成交 / 已下架直接提示，避免确认完才被拒绝 */
    if (p.status && p.status !== '在售') {
      wx.showToast({ title: '当前状态为「' + p.status + '」，暂不可发起对话', icon: 'none' })
      return
    }
    const must = Array.isArray(p.must) ? p.must : []
    if (!must.length) {
      /* 没有必须条件：直接开会话 */
      this.doOpenChat([])
      return
    }
    this.setData({
      condSheet: true,
      condList: must.map((t) => ({ t, state: '' })),
      condMet: 0,
      condTotal: must.length,
      condUnmet: must.length,
      condPass: false
    })
  },

  /* 必须条件逐项确认：满足 / 不满足 */
  setCond(e) {
    const i = Number(e.currentTarget.dataset.i)
    const val = e.currentTarget.dataset.val // yes / no
    const list = this.data.condList.slice()
    if (!list[i]) return
    list[i] = Object.assign({}, list[i], { state: list[i].state === val ? '' : val })
    const met = list.filter((c) => c.state === 'yes').length
    const total = list.length
    this.setData({
      condList: list,
      condMet: met,
      condTotal: total,
      condUnmet: total - met,
      condPass: total > 0 && met === total
    })
  },

  closeCondSheet() {
    this.setData({ condSheet: false })
  },

  /* 条件全部满足：直接开出会话，不再走「提交给平台代为联系」 */
  async doOpenChat(conds) {
    if (this.data.openingChat) return
    const p = this.data.product || {}
    const bizType = this.bizType || 'supply'
    this.setData({ openingChat: true })
    try {
      /* 商机池：先确认领取，领取成功才进入「我的商机」，随后自动进会话 */
      if (this.data.bizMode) {
        try {
          await bizUtil.claimRemote(bizType, p.id || this.productId, Array.isArray(p.must) ? p.must : [])
        } catch (err) {
          return
        }
      }
      /* 代采 / 代售由平台统一对接：领取后提交对接单并进入客服会话 */
      if (bizType === 'agency') {
        const res = await request('user', 'biz.consult', { agencyId: p.id || this.productId }, { silent: true })
        const threadId = (res && (res.threadId || res.leadId)) || ''
        this.setData({ condSheet: false })
        if (threadId) {
          wx.navigateTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(String(threadId)) })
        } else {
          wx.showToast({ title: (res && res.hint) || '已提交平台对接，正在等待平台客服处理', icon: 'none', duration: 3000 })
        }
        return
      }
      const ok = await chat.openChat({
        targetType: bizType === 'demand' ? 'demand' : 'product',
        targetId: p.id || this.productId,
        conds: conds,
        /* 商机池进入：会话打上来源标记，消息页展示「商机」 */
        fromBiz: this.data.bizMode === true,
        onPhone: (phone) => this.setData({ ownerPhone: phone })
      })
      if (ok) this.setData({ condSheet: false })
    } finally {
      this.setData({ openingChat: false })
    }
  },

  /* 商机：标记不满足，留在商机池但不再计入首页角标 */
  async markUnsatisfied() {
    if (this.marking) return
    const p = this.data.product || {}
    this.marking = true
    try {
      await bizUtil.markRemote(this.bizType || 'supply', p.id || this.productId, true)
      this.setData({ condSheet: false })
      wx.showToast({ title: '已标记不满足', icon: 'none' })
      setTimeout(() => {
        if ((getCurrentPages() || []).length > 1) wx.navigateBack()
      }, 600)
    } catch (err) {
      /* request 已按错误码提示，留在当前页 */
    } finally {
      this.marking = false
    }
  },

  /* 我的商机点进来：领取时已解锁的联系电话直接展示，列表里不再堆联系方式 */
  async loadBizContact() {
    if (!this.data.bizMode || !this.bizMine) return
    try {
      const res = await bizUtil.claimRemote(this.bizType || 'supply', this.productId, [], { silent: true })
      const phone = (res && res.contact && res.contact.phone) || ''
      if (phone) this.setData({ ownerPhone: phone })
    } catch (err) {
      /* 领取信息拉取失败不阻断详情展示 */
    }
  },

  /* 条件已全部确认：点「确认并开始对话」 */
  confirmCond() {
    if (!this.data.condPass) {
      wx.showToast({ title: '还有 ' + this.data.condUnmet + ' 项条件未确认', icon: 'none' })
      return
    }
    this.doOpenChat(this.data.condList.map((c) => ({ k: c.t, satisfied: c.state === 'yes' })))
  },

  /* 走完整咨询表单：采购数量、预算、税费等需要留档的场景；
     已逐项确认的必须条件一并带过去，表单里不用重新点一遍满足 */
  fullConsult() {
    const p = this.data.product || {}
    const id = encodeURIComponent(p.id || this.productId || '')
    const list = this.data.condList || []
    const conds = list
      .map((c) => (c.state === 'yes' ? '1' : (c.state === 'no' ? '0' : 'x')))
      .join('')
    /* 条件文本 + 结果一并带上：咨询页条件顺序与详情页可能不同，按文本对齐更稳 */
    const picked = list.filter((c) => c.state).map((c) => ({ k: c.t, v: c.state }))
    const bizType = this.bizType || ''
    /* 代采＝平台代买，我来供货 → 填供给信息；代售＝平台代卖，我来采购 → 填需求信息 */
    const demandForm = bizType === 'demand' || (bizType === 'agency' && p.agencySide === 'buy')
    wx.navigateTo({
      url: '/pages/consult/consult?id=' + id
        + (bizType ? '&biz=' + bizType : '')
        + (demandForm ? '&type=demand' : '')
        + (/^x*$/.test(conds) ? '' : '&conds=' + conds + '&condj=' + encodeURIComponent(JSON.stringify(picked)))
    })
  },

  /* 举报该商品：进入统一举报表单，提交后进入管理端「风险提示 - 举报反馈」 */
  report() {
    const p = this.data.product || {}
    const title = p.title || p.model || '商品'
    wx.navigateTo({
      url: '/pages/report/report?targetType=product'
        + '&targetId=' + encodeURIComponent(p.id || this.productId || '')
        + '&targetTitle=' + encodeURIComponent(title)
    })
  },

  /* 开通商机会员：搜索免费，联系电话等对接能力仅会员可用 */
  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  /* 自己发布的商品：底部主按钮「我的发布」→「我的 - 我发布的 - 商品」 */
  goMyPub() {
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.minePub = 'product'
    } catch (e) {}
    wx.switchTab({
      url: '/pages/mine/mine',
      fail: () => {
        wx.navigateTo({ url: '/pages/mine/mine' })
      }
    })
  },

  back() {
    /* 按进入顺序退回上一页；仅冷启动 / 分享直达（栈只有一层）才回落首页 tab */
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  },

  goHome() {
    /* 首页 / 资讯共用一个页面：回首页必须显式指定落点，
       否则会停在用户上次看的资讯圈视图 */
    const app = getApp()
    if (app && app.globalData) app.globalData.homeTab = 'sell'
    wx.switchTab({ url: '/pages/home/home' })
  }
})
