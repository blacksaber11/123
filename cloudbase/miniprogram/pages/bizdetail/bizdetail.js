/* 商机详情：展示内容与普通发布详情一致（图片、规格、发布者全部信息、必须条件），
   只是打上商机标签进入商机池；条件全部满足后左下角变成「填写完整需求」，
   复用普通发布的咨询 / 响应页，填完提交才能发布 */
const biz = require('../../utils/biz')
const { request } = require('../../utils/request')
const features = require('../../utils/features')
const { goThread } = require('../../utils/chat')

/* 发布时上传的图片与视频：与普通详情页同一份数据，缺字段时按图片处理 */
function mediaSlidesOf(list) {
  return (Array.isArray(list) ? list : []).map((m, i) => {
    if (!m) return null
    const url = m.url || m.fileId || m.src || ''
    if (!url) return null
    const type = String(m.type || m.mime || '')
    return {
      k: String(i),
      kind: m.kind === 'video' || /^video\//i.test(type) ? 'video' : 'image',
      url,
      poster: m.poster || m.cover || ''
    }
  }).filter(Boolean)
}

/* 列表与详情共用同一条商机：优先按 id + 类型匹配，类型缺失时按 id 兜底 */
function pickItem(list, id, type) {
  const hit = (o) => o && String(o.id) === String(id)
  if (type) {
    const typed = (list || []).filter((o) => hit(o) && o.type === type)[0]
    if (typed) return typed
  }
  return (list || []).filter(hit)[0] || null
}

Page({
  data: {
    loading: true,
    notFound: false,
    /* 商机会员未开通 / 已到期：不展示商机内容，引导回商机页开通 */
    locked: false,
    opp: null,
    /* 与普通发布详情一致：发布时上传的图片与视频正常展示 */
    mediaSlides: [],
    mediaIndex: 0,
    mediaSummary: '',
    mustList: [],
    condTotal: 0,
    condMet: 0,
    condUnmet: 0,
    condPass: true,
    claiming: false,
    consulting: false,
    claimed: false,
    unsatisfied: false,
    consulted: false,
    /* 发消息 / 对话总开关：关闭时隐藏「站内对话」入口 */
    chatEnabled: false
  },

  onLoad(options) {
    this.id = options && options.id ? String(options.id) : ''
    this.type = options && options.type ? String(options.type) : ''
    /* 开关已拉到用真实值，没拉到先用缓存：避免冷启动分享进来被误判成关闭 */
    this.setData({ chatEnabled: features.chatEnabled() })
    /* 管理端随时可能打开 / 关闭社交功能：开关回来后本页立即跟随 */
    this.offFlags = features.onChange((on) => {
      if (this.data && on !== this.data.chatEnabled) this.setData({ chatEnabled: on })
    })
    features.ensure()
    wx.setNavigationBarTitle({ title: '商机详情' })
    this.load()
  },

  onUnload() {
    if (this.offFlags) {
      this.offFlags()
      this.offFlags = null
    }
  },

  /* 从「填写完整需求」返回：那边可能已提交响应并开通会话，回到本页刷新状态 */
  onShow() {
    if (this.needReload) {
      this.needReload = false
      this.load()
    }
  },

  async load() {
    if (!this.id) {
      this.setData({ loading: false, notFound: true })
      return
    }
    let item = null
    let remote = false
    let unlocked = false
    try {
      const res = await request('user', 'biz.list', {}, { silent: true })
      if (res && Array.isArray(res.items)) {
        remote = true
        unlocked = !!res.unlocked
        item = pickItem(res.items, this.id, this.type)
      }
    } catch (err) {
      /* 云端不可用：仅在未绑定账号的预览场景回落演示数据 */
    }
    if (!remote) {
      const info = biz.unlockInfo()
      unlocked = info.unlocked
      item = pickItem(biz.opportunities(), this.id, this.type)
    }
    this.remote = remote
    /* 发布者删除商品 / 关闭需求后，biz.list 不再返回该条：商机直接消失 */
    if (!item) {
      this.setData({ loading: false, notFound: true })
      return
    }
    if (!unlocked && !item.claimed) {
      this.setData({ loading: false, locked: true })
      return
    }
    this.apply(item)
  },

  apply(item) {
    const must = Array.isArray(item.must) ? item.must : []
    const claimed = item.claimed === true
    /* 已领取视为条件已逐项确认：仍展示条件清单，方便回看 */
    const mustList = must.map((t) => ({ t: t, state: claimed ? 'yes' : '' }))
    const condTotal = mustList.length
    const condMet = mustList.filter((c) => c.state === 'yes').length
    const opp = Object.assign({}, item, {
      unit: item.unit || '台',
      isAgency: item.type === 'agency',
      platformOnly: item.type === 'agency',
      /* 发布者设定的全部信息 / 可协商项 / 交易流程：历史数据缺失时按空数组渲染 */
      info: Array.isArray(item.info) ? item.info : [],
      nego: Array.isArray(item.nego) ? item.nego : [],
      flow: Array.isArray(item.flow) ? item.flow : []
    })
    /* 图片与视频：与普通发布详情同一套展示，没有媒体时退回文字概要 */
    const mediaSlides = mediaSlidesOf(item.media)
    const imgCount = mediaSlides.filter((m) => m.kind === 'image').length
    const videoCount = mediaSlides.filter((m) => m.kind === 'video').length
    const mediaSummary = [
      imgCount ? imgCount + ' 张图片' : '',
      videoCount ? videoCount + ' 段视频' : ''
    ].filter(Boolean).join(' · ')
    this.setData({
      loading: false,
      notFound: false,
      locked: false,
      opp: opp,
      mediaSlides: mediaSlides,
      mediaIndex: 0,
      mediaSummary: mediaSummary,
      claimed: claimed,
      unsatisfied: item.unsatisfied === true,
      consulted: item.consulted === true,
      mustList: mustList,
      condTotal: condTotal,
      condMet: condMet,
      condUnmet: condTotal - condMet,
      condPass: condTotal === 0 || condMet === condTotal
    })
  },

  /* 逐项点击「满足 / 不满足」：再点一次取消当前选择 */
  setCond(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const i = Number(ds.i)
    const val = ds.val
    const mustList = this.data.mustList.slice()
    if (!mustList[i]) return
    mustList[i] = Object.assign({}, mustList[i], {
      state: mustList[i].state === val ? '' : val
    })
    const condTotal = mustList.length
    const condMet = mustList.filter((c) => c.state === 'yes').length
    this.setData({
      mustList: mustList,
      condTotal: condTotal,
      condMet: condMet,
      condUnmet: condTotal - condMet,
      condPass: condTotal === 0 || condMet === condTotal
    })
  },

  /* 图片 / 视频：与普通发布详情一样正常展示，点击全屏查看 */
  onMediaSwipe(e) {
    const index = Number(e && e.detail && e.detail.current) || 0
    if (index === this.data.mediaIndex) return
    this.setData({ mediaIndex: index })
  },

  previewMedia(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const slides = this.data.mediaSlides || []
    const index = Number(ds.index) || 0
    const slide = slides[index]
    if (!slide) return
    if (slide.kind === 'video') {
      if (wx.previewMedia) {
        wx.previewMedia({
          sources: slides.map((s) => ({ url: s.url, type: s.kind, poster: s.poster || '' })),
          current: index
        })
        return
      }
      wx.showToast({ title: '当前微信版本不支持查看视频', icon: 'none' })
      return
    }
    const images = slides.filter((s) => s.kind === 'image').map((s) => s.url)
    wx.previewImage({ current: slide.url, urls: images })
  },

  /* 条件全部满足后：左下角变成「填写完整需求」，复用普通发布的咨询 / 响应页，
     填完提交后才能发布（发起对话），不再单独做商机填写页 */
  moreInfo() {
    const opp = this.data.opp
    if (!opp) return
    if (!this.data.condPass) {
      wx.showToast({ title: '请先确认全部必须条件', icon: 'none' })
      return
    }
    this.needReload = true
    const id = encodeURIComponent(opp.id)
    /* 本页已逐项确认的必须条件一并带入咨询页，不用在表单里重新点一遍 */
    const list = this.data.mustList || []
    const conds = list
      .map((c) => (c.state === 'yes' ? '1' : (c.state === 'no' ? '0' : 'x')))
      .join('')
    const picked = list.filter((c) => c.state).map((c) => ({ k: c.t, v: c.state }))
    const extra = /^x*$/.test(conds) ? '' : '&conds=' + conds + '&condj=' + encodeURIComponent(JSON.stringify(picked))
    const url = (opp.type === 'supply'
      ? '/pages/consult/consult?id=' + id
      : '/pages/consult/consult?type=demand&id=' + id) + '&from=biz' + extra
    wx.navigateTo({ url: url })
  },

  /* 领取商机：必须全部条件满足；成功后在本页内联展示联系方式，不弹窗 */
  async claim() {
    const opp = this.data.opp
    if (!opp || this.data.claiming) return
    if (this.data.claimed) return
    if (!this.data.condPass) {
      wx.showToast({
        title: '还有 ' + this.data.condUnmet + ' 项未满足，全部满足后才能领取',
        icon: 'none',
        duration: 2500
      })
      return
    }
    this.setData({ claiming: true })
    try {
      let contact = null
      if (this.remote) {
        const payload = opp.type === 'supply'
          ? { targetType: 'supply', supplyId: opp.id }
          : (opp.type === 'agency'
            ? { targetType: 'agency', agencyId: opp.id }
            : { targetType: 'demand', demandId: opp.id })
        /* 逐项确认过的必须条件一起提交，服务端会复核，避免前端被绕过 */
        payload.conds = this.data.mustList.filter((c) => c.state === 'yes').map((c) => c.t)
        const res = await request('user', 'biz.claim', payload, { silent: true })
        contact = (res && res.contact) || null
      } else {
        biz.claim(opp.id)
        /* 领取即视为已满足：清掉本地的不满足标记 */
        biz.markUnsatisfied(opp.id, false)
        contact = { org: opp.org || '', name: opp.contact || '', phone: opp.phone || '' }
      }
      const name = (contact && contact.name) || opp.contact || '对方未留联系人'
      const merged = Object.assign({}, opp, {
        claimed: true,
        contactVisible: !!(contact && (contact.name || contact.phone)),
        org: (contact && contact.org) || opp.org,
        contact: name,
        phone: (contact && contact.phone) || opp.phone || ''
      })
      this.setData({
        claiming: false,
        claimed: true,
        unsatisfied: false,
        opp: merged
      })
      wx.showToast({
        title: opp.platformOnly ? '已领取，可提交平台对接' : '已领取，联系方式已解锁',
        icon: 'none'
      })
    } catch (err) {
      const msg = String((err && err.message) || '')
      this.setData({ claiming: false })
      wx.showToast({ title: msg || '领取失败，请稍后重试', icon: 'none', duration: 3000 })
      /* 发布者刚删除 / 关闭：重新加载后展示「已下架」 */
      if (/不存在|下架|已关闭|删除/.test(msg)) this.load()
    }
  },

  /* 标记不满足：商机仍保留在列表里，只是不再计入角标提醒 */
  async markUnsatisfied() {
    const opp = this.data.opp
    if (!opp || this.marking || this.data.claimed) return
    this.marking = true
    try {
      if (this.remote) {
        await request('user', 'biz.mark', {
          targetType: opp.type,
          targetId: opp.id,
          marked: true
        }, { silent: true })
      } else {
        biz.markUnsatisfied(opp.id, true)
      }
      this.setData({ unsatisfied: true })
      wx.showToast({ title: '已标记不满足，商机保留在「不满足」里', icon: 'none', duration: 2200 })
      setTimeout(() => this.backList(), 700)
    } catch (err) {
      wx.showToast({ title: String((err && err.message) || '标记失败，请稍后重试'), icon: 'none' })
    } finally {
      this.marking = false
    }
  },

  /* 取消不满足标记：商机回到「可领取」 */
  async unmark() {
    const opp = this.data.opp
    if (!opp || this.marking) return
    this.marking = true
    try {
      if (this.remote) {
        await request('user', 'biz.mark', {
          targetType: opp.type,
          targetId: opp.id,
          marked: false
        }, { silent: true })
      } else {
        biz.markUnsatisfied(opp.id, false)
      }
      this.setData({ unsatisfied: false })
      wx.showToast({ title: '已取消标记，商机回到可领取', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: String((err && err.message) || '操作失败，请稍后重试'), icon: 'none' })
    } finally {
      this.marking = false
    }
  },

  /* 领取后发起站内对话：必须条件已逐项确认，直接带条件开通会话 */
  async openChat() {
    const opp = this.data.opp
    if (!opp || this.openingChat) return
    if (!this.data.claimed) {
      wx.showToast({ title: '先逐项确认条件并领取商机', icon: 'none' })
      return
    }
    this.openingChat = true
    try {
      let threadId = ''
      if (this.remote) {
        const conds = this.data.mustList.map((c) => ({ k: c.t, satisfied: true }))
        const payload = opp.type === 'supply'
          ? { productId: opp.id, conds: conds, fromBiz: true }
          : { demandId: opp.id, conds: conds, fromBiz: true }
        const res = await request('user', 'chat.open', payload, { silent: true })
        threadId = res && res.threadId ? String(res.threadId) : ''
      }
      if (!threadId) {
        wx.showToast({ title: '暂时无法直接对话，请稍后再试', icon: 'none' })
        return
      }
      /* 直达会话：消息页是 tabBar 页只能 switchTab，threadId 交给消息页当场打开该会话 */
      goThread(threadId)
    } catch (err) {
      wx.showToast({
        title: String((err && err.message) || '发起对话失败，请稍后重试'),
        icon: 'none',
        duration: 3000
      })
    } finally {
      this.openingChat = false
    }
  },

  /* 代采 / 代售：平台居中对接，提交申请后进入与平台客服的会话 */
  async consult() {
    const opp = this.data.opp
    if (!opp || this.data.consulting || this.data.consulted) return
    this.setData({ consulting: true })
    try {
      if (this.remote) {
        const res = await request('user', 'biz.consult', { agencyId: opp.id }, { silent: true })
        /* 咨询单已建立：直接进入该咨询会话，客服领取前显示「正在等待平台客服处理」 */
        const threadId = (res && (res.threadId || res.leadId)) || ''
        this.setData({ consulting: false, consulted: true })
        if (threadId) {
          wx.navigateTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(threadId) })
          return
        }
        wx.showToast({ title: (res && res.hint) || '需求已提交，正在等待平台客服处理', icon: 'none', duration: 3000 })
        return
      } else {
        biz.consult(opp.id)
      }
      this.setData({ consulting: false, consulted: true })
      wx.showToast({ title: '已提交对接申请，客服核实后推送采购方', icon: 'none', duration: 3000 })
    } catch (err) {
      this.setData({ consulting: false })
      wx.showToast({
        title: String((err && err.message) || '提交失败，请稍后重试'),
        icon: 'none',
        duration: 3000
      })
    }
  },

  /* 查看发布者主页：匿名 / 未公开主体也允许进入，敏感字段由主页侧脱敏 */
  openOwner(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const key = String(ds.key || '')
    if (!key) return
    const nick = String(ds.nick || '')
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(key) +
        (nick ? '&nick=' + encodeURIComponent(nick) : '') + '&from=biz'
    })
  },

  copyPhone(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const phone = ds.phone || (this.data.opp && this.data.opp.phone) || ''
    if (!phone) {
      wx.showToast({ title: '对方未留电话，请用站内对话', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(phone).replace(/\s/g, ''),
      success: () => wx.showToast({ title: '电话已复制', icon: 'none' })
    })
  },

  backList() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.redirectTo({ url: '/pages/biz/biz' })
  }
})
