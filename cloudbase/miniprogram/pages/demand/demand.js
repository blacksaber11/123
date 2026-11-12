/* 求购 / 租赁需求详情页 */
const { gate } = require('../../utils/auth')
const guard = require('../../utils/guard')
const chat = require('../../utils/chat')
const fav = require('../../utils/fav')
const inbox = require('../../utils/inbox')
const shop = require('../../utils/shop')
const sharePoster = require('../../utils/share-poster')
const { request } = require('../../utils/request')

/* 预算已带「/ 台」这类单位时直接拼接，避免出现「¥ 9,600 / 台 / 台」 */
function priceWithUnit(text, unit) {
  const u = String(unit || '').trim()
  const s = String(text || '').trim()
  if (!s) return ''
  return /^\//.test(u) ? s + ' ' + u : s
}

/* 海报字段：型号 / 数量 / 城市 / 预算 / 交期，徽章按品类或租赁推断 */
function posterSpecOf(d) {
  if (!d) return null
  const rent = d.isRent === true || /租/.test(String(d.tradeMode || ''))
  const must = Array.isArray(d.must) ? d.must.length : 0
  return {
    id: String(d.id || ''),
    title: [d.brand, d.model].filter(Boolean).join(' ') || d.model || d.cat || '算力需求',
    isRent: rent,
    qty: d.qty ? String(d.qty) : '',
    unit: '台',
    city: d.city || '',
    priceText: d.budgetMode === 'nego' ? (d.budgetText || '现场沟通') : priceWithUnit(d.budgetText, d.budgetUnit),
    priceLabel: '预算',
    tag: d.status || (rent ? '求租' : '求购'),
    desc: [d.deliver ? '交期 ' + d.deliver : '', must ? must + ' 项必须条件' : '']
      .filter(Boolean).join(' · ')
  }
}

/* 分享标题：求购 / 求租 + 型号 · 数量 · 城市 · 预算；数据未就绪时返回空，交给 guard 兜底 */
function shareTitleOf(d) {
  const name = [d.brand, d.model].filter(Boolean).join(' ') || d.model || d.cat || ''
  if (!name) return ''
  const rent = d.isRent === true || /租/.test(String(d.tradeMode || ''))
  const budget = d.budgetMode === 'nego'
    ? '价格现场沟通'
    : (d.budgetText ? '预算 ' + priceWithUnit(d.budgetText, d.budgetUnit) : '')
  return [
    (rent ? '求租 ' : '求购 ') + name,
    d.qty ? d.qty + ' 台' : '',
    d.city || '',
    budget
  ].filter(Boolean).join(' · ')
}

/* 分享描述：交期与必须条件条数是需求方自己填的公开信息 */
function shareDescOf(d) {
  if (!d || (!d.model && !d.cat)) return ''
  const rent = d.isRent === true || /租/.test(String(d.tradeMode || ''))
  const must = Array.isArray(d.must) ? d.must.length : 0
  return [
    rent ? '租赁需求' : '求购需求',
    d.deliver ? '交期 ' + d.deliver : '',
    must ? must + ' 项必须条件' : '',
    rent ? '条件确认后可直接与需求方对话' : '对照条件后可直接响应'
  ].filter(Boolean).join(' · ')
}

Page({
  data: {
    demand: null,
    /* 发布方设定的条件与流程：原样展示，与咨询页共用同一份数据 */
    must: [],
    nego: [],
    flow: [],
    /* 我发布的求购收到的响应：仅条件满足度、报价与数量 */
    responses: [],
    fav: false,
    isMine: false,
    /* 来自好友分享的落地页：只做提示，不额外暴露任何字段 */
    fromShare: false,
    /* 需求已关闭 / 不存在：显示失效态，绝不用演示数据顶替 */
    missing: false,
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
    /* 需求方自愿公开的联系电话 */
    ownerPhone: '',
    /* 需求方公开了电话但当前用户不是商机会员：显示开通引导 */
    memberOnlyContact: false,
    /* 朋友圈单页模式：只能浏览，页面内提示从右上角进入完整小程序 */
    singlePage: false
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    this.demandId = id
    /* 分享链接只带 id 与 from=share，不带 uid / 手机号 / 线索号 */
    this.fromShare = !!(options && options.from === 'share')
    this.setData({ fromShare: this.fromShare })
    /* 没有 id 就是无效入口：不再兜底到演示需求 */
    if (!id) {
      this.markMissing()
      return
    }
    this.loadRemote(id)
  },

  /* 云端需求详情：非属主只看得到对外可见状态 */
  async loadRemote(id) {
    try {
      const doc = await request('user', 'demand.detail', { id }, { silent: true })
      if (!doc || !doc.id) {
        this.markMissing()
        return
      }
      /* 已切到云端数据：响应列表必须以云端为准，不再混入本地演示数据 */
      this.cloudMode = true
      /* 保密：内容照常展示，只隐藏主体与联系方式，站内对话不受影响 */
      this.applyDemand(shop.toDemand(doc))
      if (this.data.isMine) await this.loadResponses()
    } catch (e) {
      /* 云端不可用或需求已关闭：有本地数据就继续展示，否则显示失效态 */
      this.markMissing()
    }
  },

  /* 本地与云端都没有这条需求：说明已关闭 / 被删除，而不是换成别的需求 */
  markMissing() {
    if (this.data.demand) return
    this.setData({ missing: true })
  },

  applyDemand(demand) {
    if (!demand) return
    wx.setNavigationBarTitle({ title: demand.isRent ? '租赁需求详情' : '求购需求详情' })
    const isMine = !!demand.mine
    /* 保密发布：服务端不给联系电话，前端同时隐藏主体信息 */
    const privateShare = demand.privateShare === true
    const contactHidden = privateShare || demand.contactHidden === true
    this.setData({
      demand,
      missing: false,
      must: (demand.must || []).slice(),
      nego: (demand.nego || []).slice(),
      flow: (demand.flow || []).slice(),
      fav: fav.isFav('demand', demand.id),
      isMine,
      contactHidden,
      privateShare,
      /* 需求方公开了联系电话时，详情页直接展示并可复制拨号 */
      ownerPhone: contactHidden ? '' : (demand.ownerPhone || ''),
      /* 需求方公开了电话、但当前用户不是商机会员：只给开通引导，不下发号码 */
      memberOnlyContact: !contactHidden && demand.memberOnlyContact === true,
      /* 云端响应由 loadResponses 拉取；本地演示数据才读 inbox */
      responses: isMine && !this.cloudMode ? inbox.responsesOf(demand.id) : this.data.responses
    })
    /* 浏览记录：本地留存，供「我的 - 浏览记录」回看；自己的需求不记录 */
    if (!isMine && demand.id) {
      fav.recordView({
        kind: 'demand',
        id: demand.id,
        title: demand.title || demand.model || '',
        cat: demand.cat || '',
        city: demand.city || '',
        priceText: demand.budgetText || ''
      })
    }
    /* 浏览量计数：后端 30 分钟去重，自己的需求不计 */
    if (!isMine && demand.id) {
      request('user', 'view.count', {
        kind: 'demand',
        id: demand.id
      }, { silent: true }).catch(() => {})
    }
    /* 分享海报跟着这条需求走：换了 id 就重画，同一条复用缓存 */
    this.prepareShare(demand)
  },

  async onShow() {
    if (gate(this.route || 'pages/demand/demand', this.options)) {
      /* 需求是公开信息，允许「发送给朋友」与分享到朋友圈；响应详情、联系方式仍不下发 */
      guard.enableShare(true)
      const sp = guard.isSinglePage()
      if (sp !== this.data.singlePage) this.setData({ singlePage: sp })
    }
    /* 返回本页 / 首次进入时数据已就绪：补生成一次海报（同 id 命中缓存不重画） */
    if (this.data.demand) this.prepareShare(this.data.demand)
    if (this.data.isMine && this.data.demand) await this.loadResponses()
  },

  /* 海报按本需求自己的字段生成：型号 / 数量 / 城市 / 预算 / 交期 */
  prepareShare(demand) {
    const spec = posterSpecOf(demand)
    if (!spec || !spec.id) return
    this.shareSpec = spec
    if (this.shareImage && this.shareSpecId === spec.id) return
    if (this.sharePending === spec.id) return
    this.sharePending = spec.id
    const kind = sharePoster.shareKindOf('demand', demand)
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
    const d = this.data.demand || {}
    const kind = sharePoster.shareKindOf('demand', d)
    const spec = this.shareSpec || posterSpecOf(d) || {}
    const poster = this.shareImage || sharePoster.cached(kind, spec)
    const extra = {
      shareImage: poster,
      shareTitle: shareTitleOf(d),
      shareDesc: shareDescOf(d)
    }
    /* 私密发布：分享卡片不带任何主体名 */
    if (this.data.privateShare) extra.org = ''
    return guard.shareCard(
      kind,
      Object.assign({}, d, extra),
      d.id || this.demandId
    )
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
    const d = this.data.demand || {}
    return {
      title: card.title,
      query: 'id=' + encodeURIComponent(String(d.id || this.demandId || '')) + '&from=share',
      imageUrl: card.imageUrl
    }
  },

  /* 保存海报到相册：底部带小程序码，可发朋友圈或转到其他平台 */
  savePoster() {
    const d = this.data.demand || {}
    const spec = posterSpecOf(d)
    if (!spec || !spec.id) {
      wx.showToast({ title: '需求还在加载，稍后再试', icon: 'none' })
      return
    }
    const kind = sharePoster.shareKindOf('demand', d)
    const id = String(d.id || this.demandId || '')
    sharePoster.save(kind, spec, {
      path: '/pages/demand/demand?id=' + encodeURIComponent(id) + '&from=share'
    }).then((ok) => {
      if (ok) wx.showToast({ title: '海报已存到相册', icon: 'success' })
    })
  },

  /* 我发布的求购：响应列表优先取云端，失败回落本地演示 */
  async loadResponses() {
    const id = this.data.demand.id
    try {
      const res = await request('user', 'demand.responses', { demandId: id }, { silent: true })
      const items = ((res && res.items) || []).map((r) => ({
        id: r.id,
        masked: r.masked,
        matchPct: Number(r.matchPct) || 0,
        status: r.status,
        metCount: r.metCount,
        total: r.total,
        allMet: r.allMet,
        conds: r.conds || [],
        quoteText: r.quoteText || '',
        note: '',
        at: shop.fmtPublished(r.at)
      }))
      this.setData({ responses: items })
    } catch (err) {
      /* 已切到云端数据时不再用本地演示响应顶替，避免展示不存在的咨询人 */
      if (!this.cloudMode) this.setData({ responses: inbox.responsesOf(id) })
    }
  },

  toggleFav() {
    const id = this.data.demand && this.data.demand.id
    if (!id) return
    const on = fav.toggleFav('demand', id)
    this.setData({ fav: on })
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  // 联系需求方：先逐项确认需求方的必须条件，全部满足后直接进入与需求方的会话
  respond() {
    if (this.data.isMine) {
      wx.showToast({ title: '不能响应自己的需求', icon: 'none' })
      return
    }
    /* 只有「求购中」可响应：洽谈中 / 已对接 / 已关闭都提示，避免确认完才被拒绝 */
    const status = this.data.demand.status
    if (status && status !== '求购中') {
      wx.showToast({ title: '当前状态为「' + status + '」，暂不可响应', icon: 'none' })
      return
    }
    const must = Array.isArray(this.data.must) ? this.data.must : []
    if (!must.length) {
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

  /* 条件全部满足：直接开出会话 */
  async doOpenChat(conds) {
    if (this.data.openingChat) return
    const d = this.data.demand || {}
    this.setData({ openingChat: true })
    try {
      const ok = await chat.openChat({
        targetType: 'demand',
        targetId: d.id || this.demandId,
        conds: conds,
        onPhone: (phone) => this.setData({ ownerPhone: phone })
      })
      if (ok) this.setData({ condSheet: false })
    } finally {
      this.setData({ openingChat: false })
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

  /* 走完整响应表单：报价、数量等需要留档的场景 */
  fullRespond() {
    wx.navigateTo({
      url: '/pages/consult/consult?type=demand&id=' + this.data.demand.id
    })
  },

  /* 开通商机会员：搜索免费，联系电话等对接能力仅会员可用 */
  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  /* 复制需求方公开的联系电话 */
  copyOwnerPhone() {
    const phone = this.data.ownerPhone || ''
    if (!phone) {
      wx.showToast({ title: '该需求方未公开联系电话', icon: 'none' })
      return
    }
    chat.copyPhone(phone)
  },

  // 弹层遮罩占位：拦截穿透滚动，不做任何动作
  noop() {},

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
    /* 首页 / 资讯共用一个页面：回首页必须显式指定落点 */
    const app = getApp()
    if (app && app.globalData) app.globalData.homeTab = 'sell'
    wx.switchTab({ url: '/pages/home/home' })
  }
})
