/* 对方主页：从消息会话点对方头像进入
   - 对方公开主体时：展示主体名称、城市、联系电话与在架货源 / 需求；
   - 未公开主体时：只展示昵称，仍可关注、可回会话私信；
   - 关注复用本地 + 云端关注列表，私信回到原会话，不新建会话。 */
const fav = require('../../utils/fav')
const { request } = require('../../utils/request')

Page({
  data: {
    key: '',
    nick: '',
    avatar: '用',
    threadId: '',
    loading: true,
    /* 对方未公开主体：不展示主体与联系方式，只保留关注 / 私信 */
    hidden: false,
    /* 商机会员标识：与消息列表 / 会话顶部保持一致 */
    member: false,
    memberLabel: '',
    /* 实名 / 资质徽标：只认服务端下发 */
    verified: false,
    error: '',
    ownerSubject: '',
    contactName: '',
    city: '',
    phone: '',
    phonePublic: false,
    phoneMasked: '',
    /* 对方公开了电话但当前用户不是商机会员：显示开通引导 */
    memberOnlyContact: false,
    items: [],
    /* 作者发布的资讯：从资讯详情点头像进入时展示 */
    news: [],
    following: false,
    tab: 'all'
  },

  onLoad(options) {
    const key = decodeURIComponent((options && options.key) || '')
    const nick = decodeURIComponent((options && options.nick) || '')
    const threadId = decodeURIComponent((options && options.thread) || '')
    /* 资讯作者入口：未公开主体也允许查看公开在架内容 */
    this.fromNews = (options && options.from) === 'news'
    if (!key) {
      this.setData({ loading: false, error: '主页不存在' })
      return
    }
    if (this.fromNews) wx.setNavigationBarTitle({ title: '作者主页' })
    this.setData({
      key,
      nick: nick || '对方',
      avatar: String(nick || '对方').slice(0, 1),
      threadId,
      following: fav.isFollowing(key)
    })
    this.load()
  },

  onShow() {
    if (this.data.key) this.setData({ following: fav.isFollowing(this.data.key) })
  },

  async load() {
    this.setData({ loading: true, error: '', hidden: false })
    let res = null
    try {
      res = await request('user', 'owner.home', {
        ownerKey: this.data.key,
        allowHidden: this.fromNews === true
      }, { silent: true })
    } catch (err) {
      res = null
      /* 主体未公开是正常状态，不是加载失败 */
      const msg = String((err && err.message) || '')
      if (!/未公开主体|不存在/.test(msg)) {
        this.setData({ loading: false, error: msg || '暂时无法加载该主页' })
        return
      }
    }
    if (!res) {
      this.setData({ loading: false, hidden: true })
      return
    }
    const items = (res.items || []).map((it) => ({
      id: it.id,
      type: it.type === 'demand' ? 'demand' : 'product',
      title: it.title || '',
      cat: it.cat || '',
      city: it.city || '',
      priceText: it.priceText || '面议',
      tradeMode: it.tradeMode || ''
    }))
    const news = (res.news || []).map((it) => ({
      id: it.id,
      title: it.title || '',
      summary: it.summary || '',
      cat: it.cat || '',
      views: Number(it.views) || 0,
      published: it.published || ''
    }))
    /* 未公开主体时保留外部传入的昵称（资讯作者为脱敏名），但公开内容照常展示 */
    const hidden = res.hidden === true
    const nick = hidden ? this.data.nick : (res.ownerSubject || this.data.nick)
    this.setData({
      loading: false,
      hidden,
      member: res.member === true,
      memberLabel: res.memberLabel || '',
      verified: res.verified === true,
      nick,
      avatar: String(nick || '用').slice(0, 1),
      ownerSubject: res.ownerSubject || '',
      contactName: res.ownerContactName || '',
      city: res.city || '',
      phonePublic: res.phonePublic === true,
      phone: res.phonePublic ? (res.phone || '') : '',
      phoneMasked: res.phoneMasked || '',
      memberOnlyContact: res.memberOnlyContact === true,
      items,
      news,
      following: fav.isFollowing(this.data.key)
    })
  },

  retry() {
    this.load()
  },

  /* 开通商机会员：搜索免费，联系电话等对接能力仅会员可用 */
  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  /* 关注 / 取消关注：本地立即生效，云端后台同步 */
  toggleFollow() {
    const key = this.data.key
    if (!key) return
    const on = fav.toggleFollow({
      id: key,
      nick: this.data.ownerSubject || this.data.nick || '平台用户',
      short: String(this.data.ownerSubject || this.data.nick || '用').slice(-1),
      city: this.data.city,
      /* 认证状态只认服务端下发，不能用「是否可见」推断 */
      verified: !!this.data.verified
    })
    this.setData({ following: on })
    wx.showToast({
      title: on ? '已关注，可在「我的 - 我的关注」查看' : '已取消关注',
      icon: 'none'
    })
  },

  /* 举报该用户：进入统一举报表单，提交后进入管理端「风险提示 - 举报反馈」 */
  report() {
    const key = this.data.key
    if (!key) return
    wx.navigateTo({
      url: '/pages/report/report?targetType=owner'
        + '&targetId=' + encodeURIComponent(key)
        + '&targetTitle=' + encodeURIComponent(this.data.ownerSubject || this.data.nick || '用户')
    })
  },

  /* 复制 / 拨打对方公开的电话 */
  copyPhone() {
    const phone = this.data.phone
    if (!phone) return
    wx.setClipboardData({ data: phone })
  },

  callPhone() {
    const phone = this.data.phone
    if (!phone) return
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} })
  },

  /* 私信：回到原会话；从资讯作者主页进入时没有会话，先去消息页 */
  sendMessage() {
    const threadId = this.data.threadId
    if (!threadId) {
      wx.switchTab({ url: '/pages/msg/msg' })
      return
    }
    const app = getApp()
    if (app && app.globalData) app.globalData.openThread = threadId
    wx.navigateBack()
  },

  /* 作者主页里的资讯：同样只给标题与开头，点开看全文 */
  openNewsItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/news/news?id=' + encodeURIComponent(id) })
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id
    const type = e.currentTarget.dataset.type
    if (!id) return
    wx.navigateTo({
      url: type === 'demand'
        ? '/pages/demand/demand?id=' + encodeURIComponent(id)
        : '/pages/product/product?id=' + encodeURIComponent(id)
    })
  }
})
