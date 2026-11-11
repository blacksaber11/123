/* 举报 / 投诉 / 意见反馈：商品、资讯、用户主页共用同一张表单
   - 入口通过 query 带 targetType / targetId / targetTitle，提交后进入管理端「风险提示 - 举报反馈」队列；
   - 处置结果在「我的 - 帮助与反馈」与站内信同步。 */
const { request } = require('../../utils/request')
const auth = require('../../utils/auth')

/* 对象类型文案：与 shared/handlers.user.js 的 REPORT_TARGETS 保持一致 */
const TARGET_TEXT = {
  product: '商品',
  news: '资讯',
  demand: '需求',
  owner: '用户',
  chat: '会话',
  other: '其他'
}

Page({
  data: {
    targetType: 'other',
    targetTypeText: '其他',
    targetTitle: '',
    types: ['举报', '投诉', '意见反馈'],
    type: '举报',
    content: '',
    contact: '',
    sending: false
  },

  onLoad(options) {
    const opt = options || {}
    const targetType = TARGET_TEXT[opt.targetType] ? opt.targetType : 'other'
    this.targetId = decodeURIComponent(opt.targetId || '')
    this.setData({
      targetType,
      targetTypeText: TARGET_TEXT[targetType],
      targetTitle: decodeURIComponent(opt.targetTitle || ''),
      type: opt.type === '投诉' || opt.type === '意见反馈' ? opt.type : '举报'
    })
  },

  pickType(e) {
    this.setData({ type: (e.currentTarget.dataset || {}).t || '举报' })
  },

  onContent(e) {
    this.setData({ content: String(e.detail.value || '') })
  },

  onContact(e) {
    this.setData({ contact: String(e.detail.value || '') })
  },

  async submit() {
    if (this.data.sending) return
    const content = String(this.data.content || '').trim()
    if (content.length < 5) {
      wx.showToast({ title: '请写清具体情况（至少 5 个字）', icon: 'none' })
      return
    }
    this.setData({ sending: true })
    try {
      await auth.ensureLogin(getApp())
      await request('user', 'report.create', {
        type: this.data.type,
        targetType: this.data.targetType,
        targetId: this.targetId,
        targetTitle: String(this.data.targetTitle || '').trim(),
        content,
        contact: String(this.data.contact || '').trim()
      })
      wx.showToast({ title: '已提交，等待平台核实', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1200)
    } catch (err) {
      this.setData({ sending: false })
      wx.showToast({ title: (err && err.message) || '提交失败，请稍后重试', icon: 'none' })
    }
  }
})
