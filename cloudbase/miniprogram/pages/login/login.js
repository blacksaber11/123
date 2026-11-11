const { wxLogin, readUser, writeUser, hasPhone } = require('../../utils/auth')
const { request, uploadFile } = require('../../utils/request')
const { requestLocation } = require('../../utils/location')

const HOME = '/pages/home/home'
const LOGIN_ROUTE = '/pages/login/login'
/* tabBar 页面：redirectTo 拒绝打开，只能用 switchTab */
const TAB_ROUTES = ['/pages/home/home', '/pages/msg/msg', '/pages/mine/mine']

/* tab 页只能用 switchTab（不接受 query）：首页的 tab 落点通过 globalData 传递 */
function goTabPage(from) {
  const raw = String(from || HOME)
  const route = raw.split('?')[0]
  const tab = raw.match(/[?&]tab=([^&#]*)/)
  const target = TAB_ROUTES.indexOf(route) > -1 ? route : HOME
  if (target === HOME && tab) {
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.homeTab = decodeURIComponent(tab[1])
    } catch (err) { /* 忽略全局态写入失败 */ }
  }
  wx.switchTab({
    url: target,
    fail: () => wx.reLaunch({ url: HOME, fail: () => {} })
  })
}

/**
 * 登录成功后回到触发登录的页面：tab 页走 switchTab，普通页走 redirectTo。
 * 任何一步失败都逐级回退到首页。
 */
function leaveLogin(from) {
  const raw = String(from || HOME)
  const route = raw.split('?')[0] || HOME
  const home = () => wx.reLaunch({ url: HOME, fail: () => {} })
  if (TAB_ROUTES.indexOf(route) > -1) {
    goTabPage(raw)
    return
  }
  if (route.indexOf('/pages/') !== 0) {
    home()
    return
  }
  wx.redirectTo({
    url: raw,
    fail: () => wx.reLaunch({ url: raw, fail: home })
  })
}

/* 看门狗：跳转后若仍停在登录页（跳转被系统吞掉），直接重建首页，绝不让用户卡死在登录页 */
function ensureLeft(delay) {
  setTimeout(() => {
    try {
      const pages = getCurrentPages() || []
      const cur = pages[pages.length - 1]
      if (!cur || String(cur.route || '') === 'pages/login/login') {
        wx.reLaunch({ url: HOME, fail: () => {} })
      }
    } catch (err) {
      wx.reLaunch({ url: HOME, fail: () => {} })
    }
  }, delay || 600)
}

/**
 * 回跳地址只接受站内页面路径，并且不允许回到登录页本身，避免循环跳转与白屏。
 * 解码失败（非法 % 转义）时直接回首页。
 */
function safeFrom(raw) {
  if (!raw) return HOME
  let path = String(raw)
  try {
    path = decodeURIComponent(path)
  } catch (err) {
    return HOME
  }
  if (path.indexOf('/pages/') !== 0) return HOME
  if (path.indexOf(LOGIN_ROUTE) === 0) return HOME
  return path
}

Page({
  data: {
    loading: false,
    error: '',
    from: '',
    /* 已静默登录但还没授权手机号：停在「手机号登录」这一步 */
    needPhone: false,
    phoneLoading: false,
    phoneMasked: '',
    /* 微信手机号快捷验证不可用时的兜底提示与手填入口 */
    phoneFail: '',
    manual: false,
    manualPhone: '',
    manualLoading: false,
    /* 头像 / 昵称：可选，用户自己点头像按钮 / 昵称输入框才会带过来 */
    avatar: '',
    nick: '',
    /* 隐私保护指引是否需要先同意：微信要求先同意再调用手机号等隐私接口 */
    privacyNeed: false
  },

  onLoad(options) {
    this.setData({ from: safeFrom(options && options.from) })
    this.checkPrivacy()
  },

  /* 查询隐私协议状态：需要时先让用户点「同意」，否则手机号接口会被微信拒绝 */
  checkPrivacy() {
    if (!wx.getPrivacySetting) return
    wx.getPrivacySetting({
      success: (res) => {
        this.setData({ privacyNeed: res && res.needAuthorization === true })
      },
      fail: () => {}
    })
  },

  /* 用户点击「同意隐私保护指引」后，微信放行手机号等隐私接口 */
  onAgreePrivacy(e) {
    const msg = String((e && e.detail && e.detail.errMsg) || '')
    if (msg.indexOf('ok') < 0) {
      wx.showToast({ title: '需同意隐私保护指引后才能授权手机号', icon: 'none', duration: 2400 })
      /* 用户拒绝或组件异常：保底让手填入口可见，不让人卡在这一步 */
      this.setData({ phoneFail: '未同意隐私保护指引时微信不会返回手机号，可手动填写手机号继续。', manual: true })
      return
    }
    this.setData({ privacyNeed: false, phoneFail: '' })
    wx.showToast({ title: '已同意，请点击下方按钮授权', icon: 'none', duration: 2000 })
  },

  /* 微信头像：拿到临时文件，登录时一并上传保存 */
  onChooseAvatar(e) {
    const url = (e && e.detail && e.detail.avatarUrl) || ''
    if (url) this.setData({ avatar: url })
  },

  /* 微信昵称：type="nickname" 输入框选中微信昵称后回填 */
  onNickInput(e) {
    this.setData({ nick: (e && e.detail && e.detail.value) || '' })
  },

  /* 进入即静默登录；没有手机号的账号停在「手机号登录」这一步 */
  onShow() {
    if (!this.data.loading && !this.data.error && !this.data.needPhone) this.doLogin()
  },

  /* 协议正文：登录页必须可查 */
  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' })
  },

  openTerms() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=terms' })
  },

  retry() {
    this.setData({ error: '' })
    this.doLogin()
  },

  async doLogin() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '', needPhone: false })
    try {
      const user = await wxLogin({})
      /* 头像昵称已有则回填，避免重复填写 */
      this.setData({
        avatar: (user && user.avatar) || this.data.avatar || '',
        nick: (user && user.nick && String(user.nick).indexOf('用户') !== 0) ? user.nick : this.data.nick || ''
      })
      if (!hasPhone(user)) {
        /* 微信要求手机号快捷验证必须由用户点击按钮触发，这里停在手机号登录这一步 */
        this.setData({ loading: false, needPhone: true })
        return
      }
      await this.enterApp()
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '登录失败，请重试' })
    }
  },

  /**
   * 微信手机号快捷验证：code 换明文手机号，服务端加密落库。
   * 失败分两类：用户主动拒绝 → 按「先逛逛」退出；
   * 组件不可用（未开通 / 额度耗尽 / 开发者工具）→ 展示原因并给出手填入口。
   */
  async getPhone(e) {
    const detail = (e && e.detail) || {}
    const code = detail.code || ''
    const denied = String(detail.errMsg || '').indexOf('deny') > -1
    if (!code && denied) {
      this.skip()
      return
    }
    if (!code) {
      const raw = String(detail.errMsg || '')
      /* jsapi has no permission：小程序后台未开通「手机号快速验证」能力，重试无效，直接放手填 */
      const noPerm = /no permission|not support|unsupported/i.test(raw)
      if (raw) console.warn('[login] getPhoneNumber', raw)
      this.setData({
        phoneLoading: false,
        /* 有权限问题时直接展开手填；其余失败先提示重试，手填仍是兜底入口 */
        manual: noPerm,
        phoneFail: noPerm
          ? '当前小程序还没有「手机号快速验证」权限，一键授权暂时不可用，请手动填写手机号继续；平台开通后即可一键授权。'
          : '微信没有返回手机号，请再点一次上方按钮授权；多次失败可手动填写手机号继续。'
      })
      return
    }
    if (this.data.phoneLoading) return
    this.setData({ phoneLoading: true, phoneFail: '' })
    try {
      const res = (await request('user', 'auth.phone', { code }, { silent: true })) || {}
      await this.afterPhone(res)
    } catch (err) {
      this.setData({
        phoneLoading: false,
        phoneFail: ((err && err.message) || '手机号授权失败') + '，可手动填写手机号继续。'
      })
    }
  },

  /* 手填手机号兜底：只写手机号字段，不动主体资料 */
  toggleManual() {
    this.setData({ manual: !this.data.manual })
  },

  onManualInput(e) {
    this.setData({ manualPhone: (e && e.detail && e.detail.value) || '' })
  },

  async saveManual() {
    if (this.data.manualLoading) return
    const phone = String(this.data.manualPhone || '').replace(/\s+/g, '')
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的 11 位手机号', icon: 'none' })
      return
    }
    this.setData({ manualLoading: true })
    try {
      const res = (await request('user', 'auth.phoneManual', { phone }, { silent: true })) || {}
      await this.afterPhone(res)
    } catch (err) {
      this.setData({ manualLoading: false })
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none', duration: 2400 })
    }
  },

  /* 头像上传：失败不影响登录，昵称照常保存 */
  async saveAvatar(user) {
    const src = String(this.data.avatar || '')
    if (!src || src.indexOf('http') === 0 || src.indexOf('cloud://') === 0) return src
    try {
      const ext = (src.match(/\.(png|jpe?g|webp)$/i) || [null, 'png'])[1]
      return await uploadFile(src, { cloudPath: 'avatar/' + String(user && user.uid ? user.uid : Date.now()) + '-' + Date.now() + '.' + ext })
    } catch (err) {
      return ''
    }
  },

  /* 手机号就绪：同步头像昵称 → 写本地登录态 → 进入程序（回到触发登录的页面） */
  async afterPhone(res) {
    let stored = Object.assign({}, readUser() || {}, {
      hasPhone: res.hasPhone === true,
      phoneMasked: res.phoneMasked || ''
    })
    const nick = String(this.data.nick || '').trim()
    const avatar = await this.saveAvatar(stored)
    if (nick || avatar) {
      try {
        const fresh = await wxLogin({ nick: nick, avatar: avatar })
        stored = Object.assign({}, fresh, {
          hasPhone: true,
          phoneMasked: res.phoneMasked || fresh.phoneMasked || ''
        })
      } catch (err) {
        /* 头像昵称保存失败不阻断登录，后续可在「我的 - 个人信息」补充 */
      }
    }
    writeUser(stored)
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.user = stored
    } catch (err) { /* 忽略全局态写入失败 */ }
    this.setData({
      phoneLoading: false,
      manualLoading: false,
      needPhone: false,
      loading: true,
      phoneMasked: stored.phoneMasked || ''
    })
    wx.showToast({ title: '登录成功', icon: 'success' })
    this.enterApp()
  },

  /* 暂不登录：直接回首页浏览。不回上一步，避免门禁页再次跳回登录页形成循环 */
  skip() {
    wx.switchTab({ url: HOME, fail: () => wx.reLaunch({ url: HOME, fail: () => {} }) })
  },

  /* 登录 + 手机号都就绪后进入程序：定位权限不阻塞进入 */
  enterApp() {
    /* 先回跳、再异步申请定位：系统权限弹窗不卡住页面切换 */
    setTimeout(() => { requestLocation(getApp()) }, 300)
    /* from 已在 onLoad 规范化：站内路径、非登录页、解码失败回落首页 */
    leaveLogin(this.data.from || HOME)
    ensureLeft(1200)
  }
})
