/* 隐私政策 / 用户协议：登录页与「我的」可查看，正文统一由 utils/privacy.js 维护 */
const { PRIVACY_BLOCKS, TERMS_BLOCKS, PRIVACY_VERSION } = require('../../utils/privacy')

Page({
  data: {
    type: 'privacy',
    title: '隐私政策',
    version: PRIVACY_VERSION,
    blocks: []
  },

  onLoad(options) {
    const type = (options && options.type) === 'terms' ? 'terms' : 'privacy'
    const title = type === 'terms' ? '用户协议' : '隐私政策'
    this.setData({
      type,
      title,
      blocks: type === 'terms' ? TERMS_BLOCKS : PRIVACY_BLOCKS
    })
    wx.setNavigationBarTitle({ title })
  }
})
