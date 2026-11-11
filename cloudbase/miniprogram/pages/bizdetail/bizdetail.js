/* 商机详情：逐项确认发布者的必须条件，全部满足后才能领取；
   不满足可标记，商机仍保留在列表的「不满足」分类里，只是不再角标提醒 */
const biz = require('../../utils/biz')
const { request } = require('../../utils/request')

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
    mustList: [],
    condTotal: 0,
    condMet: 0,
    condUnmet: 0,
    condPass: true,
    claiming: false,
    consulting: false,
    claimed: false,
    unsatisfied: false,
    consulted: false
  },

  onLoad(options) {
    this.id = options && options.id ? String(options.id) : ''
    this.type = options && options.type ? String(options.type) : ''
    wx.setNavigationBarTitle({ title: '商机详情' })
    this.load()
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
      platformOnly: item.type === 'agency'
    })
    this.setData({
      loading: false,
      notFound: false,
      locked: false,
      opp: opp,
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
          : { targetType: 'demand', demandId: opp.id }
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
      wx.showToast({ title: '已领取，联系方式已解锁', icon: 'none' })
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
          ? { productId: opp.id, conds: conds }
          : { demandId: opp.id, conds: conds }
        const res = await request('user', 'chat.open', payload, { silent: true })
        threadId = res && res.threadId ? String(res.threadId) : ''
      }
      if (!threadId) {
        wx.showToast({ title: '暂时无法直接对话，请稍后再试', icon: 'none' })
        return
      }
      /* 直达会话：消息页是 tabBar 页只能 switchTab，threadId 交给消息页当场打开该会话 */
      const app = getApp()
      app.globalData = app.globalData || {}
      app.globalData.openThread = threadId
      wx.switchTab({ url: '/pages/msg/msg' })
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
        await request('user', 'biz.consult', { agencyId: opp.id }, { silent: true })
        try {
          await request('user', 'msg.send', {
            body: '我想咨询该委托：' + (opp.title || '') + '（委托编号 ' + opp.id + '）',
            targetType: 'agency',
            targetId: opp.id,
            targetTitle: opp.title || ''
          }, { silent: true })
          this.setData({ consulting: false, consulted: true })
          wx.switchTab({ url: '/pages/msg/msg' })
          return
        } catch (err) {
          /* 对话建立失败不影响已提交的对接申请 */
        }
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
