/**
 * 个人信息页：查看 / 编辑资料 + 资质上传。
 *
 * 保密要点：
 * 1. 展示永远是脱敏值，明文只在编辑输入框里短暂出现；
 * 2. 手机号不走手填：由「微信手机号快捷验证」授权后服务端落密文；
 * 3. 资质原件由服务端上传接口保存，列表只给文件名与状态，不给下载入口。
 */
const { request, uploadFile } = require('../../utils/request')
const { gate, readUser, writeUser } = require('../../utils/auth')
const { SUBJECT_NOTICE } = require('../../utils/privacy')
const M = require('../../utils/mock')

/* 主体类型：与管理端筛选、服务端白名单保持一致 */
const SUBJECT_TYPES = [
  '个人', '个体户', '国央企', '央企', '国企', '上市公司', '民企', '外企',
  '合资企业', '合伙企业', '事业单位', '政府机关', '社会团体', '其他'
]

/* 主体类别：企业主体要营业执照 + 法定代表人身份证，个人主体只需本人身份证 */
const SUBJECT_KINDS = [
  { key: 'company', label: '企业主体', desc: '上传营业执照与法定代表人身份证' },
  { key: 'person', label: '个人主体', desc: '只需上传本人身份证' }
]
const QUAL_DEFS = {
  company: [
    { k: '营业执照', kind: 'license' },
    { k: '法定代表人身份证', kind: 'idcard' }
  ],
  person: [{ k: '身份证', kind: 'idcard' }]
}

function qualDefs(kind) {
  return kind === 'person' ? QUAL_DEFS.person : QUAL_DEFS.company
}

/* 云端存 {name, kind, fileId, status, reason}；按当前主体类别渲染对应资质行 */
function qualRows(list, kind) {
  const rows = Array.isArray(list) ? list : []
  const map = {}
  rows.forEach((x) => {
    if (typeof x === 'string') map[x] = { fileId: '', status: '', reason: '' }
    else if (x && x.name) map[x.name] = { fileId: x.fileId || '', status: x.status || '', reason: x.reason || '' }
  })
  return qualDefs(kind).map((def) => {
    const row = map[def.k] || {}
    const ok = !!row.fileId
    const v = row.status === '已核验' ? '已核验' : row.status === '已驳回' ? '已驳回' : (ok ? '已上传待核验' : '未提交')
    return { k: def.k, kind: def.kind, v, ok, fileId: row.fileId || '', status: row.status || '', reason: row.reason || '' }
  })
}

/* 所在城市：省 / 直辖市 → 地级市，与发布页交易地共用 region.js 的同一份目录 */
const CITY_TREE = M.CITY_TREE || {}
const PROVINCES = Object.keys(CITY_TREE)
const citiesOf = (pi) => (CITY_TREE[PROVINCES[pi]] || [])

function cityColumns(pi, ci) {
  const cities = citiesOf(pi)
  const list = cities.length ? cities : ['—']
  return {
    cols: [PROVINCES, list],
    index: [pi, Math.min(Math.max(ci, 0), list.length - 1)]
  }
}

/* 已存的城市名可能是「成都市」，也可能是历史数据的「成都」，两种都要能反查回滚轮位置 */
function locateCity(city) {
  const raw = String(city || '').trim()
  if (!raw) return { pi: 0, ci: 0 }
  for (let pi = 0; pi < PROVINCES.length; pi++) {
    const list = citiesOf(pi)
    const ci = list.findIndex((n) => n === raw || n.replace(/(市|地区|盟|自治州)$/, '') === raw)
    if (ci >= 0) return { pi, ci }
  }
  return { pi: 0, ci: 0 }
}

Page({
  data: {
    user: null,
    subjectNotice: SUBJECT_NOTICE,
    avatarText: '算',
    /* 头像地址：登录没设置过的用户也可以在这里补传 */
    avatar: '',
    nick: '',
    phoneMasked: '',
    hasPhone: false,
    realname: '',
    realnameMasked: '',
    subject: '',
    subjectKind: 'company',
    subjectKinds: SUBJECT_KINDS,
    subjectType: '',
    subjectTypes: SUBJECT_TYPES,
    /* 职位 / 身份：选填，最长 20 字 */
    position: '',
    /* 发布前必填项缺失时，页面顶部提示条与字段高亮 */
    profileMissing: [],
    missingText: '',
    focusKey: '',
    city: '',
    cityCols: [PROVINCES, citiesOf(0)],
    cityIndex: [0, 0],
    /* 信息公开范围：主体公开 / 不公开，发布页只读展示并回此处修改 */
    exposure: 'hidden',
    /* 自愿公开联系电话：只有在「公开主体」档下才可开启 */
    phonePublic: false,
    quals: qualRows([], 'company'),
    qualDone: 0,
    saving: false
  },

  /**
   * 支持从发布页「去完善」带参进入：focus=缺失字段名（subject / subjectType / subjectKind / realname / phone），
   * 加载完成后滚动并高亮该字段；多个缺失时前端传第一个缺失项即可。
   */
  onLoad(options) {
    const focus = String((options && options.focus) || '').trim()
    this.focusKey = focus
    /* 有未保存内容时返回 / 侧滑先提醒，避免刚上传的资质原件跟手填资料一起丢失 */
    this.dirty = false
    this.loaded = false
  },

  onShow() {
    if (!gate('pages/profile/profile')) return
    /* 首次进入必拉取；有未保存修改时不再用服务端数据覆盖本地，只增量合并资质 */
    if (!this.loaded || !this.dirty) this.load()
  },

  /** 未保存提醒：只在有修改时启用，保存成功后立即解除 */
  syncLeaveGuard() {
    const on = !!this.dirty
    if (on === this._leaveGuard) return
    this._leaveGuard = on
    if (typeof wx.enableAlertBeforeUnload !== 'function') return
    if (on) {
      wx.enableAlertBeforeUnload({ message: '资料还没保存，离开将丢失已填写内容和已上传原件' })
    } else if (typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload()
    }
  },

  /** 用户主动定位：从微信地图返回的地址里识别省 / 市并回填 */
  useLocation() {
    const { chooseCity } = require('../../utils/location')
    chooseCity().then((hit) => {
      if (!hit) return
      const loc = locateCity(hit.city)
      const geo = cityColumns(loc.pi, loc.ci)
      this.dirty = true
      this.setData({ city: hit.city, cityCols: geo.cols, cityIndex: geo.index })
      this.syncLeaveGuard()
      wx.showToast({ title: '已填入 ' + hit.city + '，保存后生效', icon: 'none' })
    }).catch((err) => {
      const msg = (err && err.message) || ''
      if (msg) wx.showToast({ title: msg, icon: 'none' })
    })
  },

  /** 发布必填口径：主体名称、主体类型、主体类别、联系人、手机号（职位选填） */
  computeMissing() {
    const d = this.data
    const missing = []
    if (!String(d.subject || '').trim()) missing.push({ key: 'subject', label: '主体名称' })
    if (!String(d.subjectType || '').trim()) missing.push({ key: 'subjectType', label: '主体类型' })
    if (!String(d.subjectKind || '').trim()) missing.push({ key: 'subjectKind', label: '主体类别' })
    if (!String(d.realname || '').trim()) missing.push({ key: 'realname', label: '联系人' })
    if (!d.hasPhone) missing.push({ key: 'phone', label: '手机号' })
    this.setData({
      profileMissing: missing,
      missingText: missing.map((m) => m.label).join('、')
    })
    return missing
  },

  /** 滚动到指定字段并高亮：进入页面时提示「请补齐以下信息」 */
  focusField(key) {
    const field = String(key || '')
    if (!field) return
    this.setData({ focusKey: field })
    /* 等 setData 渲染完成后再测量位置，避免提示条高度变化导致偏移 */
    setTimeout(() => {
      const q = this.createSelectorQuery()
      q.select('#pf-field-' + field).boundingClientRect()
      q.selectViewport().scrollOffset()
      q.exec((res) => {
        const rect = res && res[0]
        const scroll = res && res[1]
        if (!rect || !scroll) return
        wx.pageScrollTo({ scrollTop: Math.max(0, rect.top + scroll.scrollTop - 140), duration: 300 })
      })
    }, 80)
  },

  async load() {
    const user = readUser()
    let profile = null
    try {
      profile = await request('user', 'profile.get', {}, { silent: true })
    } catch (err) {
      /* 云函数不可用时回落到本地缓存 */
    }
    const u = user || {}
    const p = profile || {}
    const nick = p.nick || u.nick || ''
    const subject = p.subject || u.subject || ''
    const subjectKind = (p.subjectKind || u.subjectKind) === 'person' ? 'person' : 'company'
    const subjectType = p.subjectType || u.subjectType || (subjectKind === 'person' ? '个人' : '')
    const city = p.city || u.city || ''
    const position = p.position || u.position || ''
    const hasPhone = p.hasPhone === true || u.hasPhone === true || !!p.phoneMasked || !!u.phoneMasked
    const loc = locateCity(city)
    const geo = cityColumns(loc.pi, loc.ci)
    /* 两个类别的资质都留在本地，切换类别不丢已上传原件；
       本地已上传但还没保存的原件优先，不能被服务端返回的旧列表覆盖 */
    const remote = Array.isArray(p.quals) ? p.quals.slice() : []
    ;(this.qualStore || []).forEach((x) => {
      if (!x || !x.fileId) return
      const name = x.name || x.k
      if (!name) return
      const i = remote.findIndex((r) => r && (r.name || r.k) === name)
      if (i > -1) remote[i] = Object.assign({}, remote[i], x)
      else remote.push(x)
    })
    this.qualStore = remote
    const quals = qualRows(this.qualStore, subjectKind)
    this.loaded = true
    this.setData({
      user: u,
      avatarText: (nick || '算').slice(0, 1),
      avatar: p.avatar || u.avatar || '',
      nick,
      /* 手机号明文不回显、不手填：只展示微信授权后的脱敏值 */
      phoneMasked: p.phoneMasked || u.phoneMasked || '',
      hasPhone,
      realname: p.realname || '',
      realnameMasked: p.realnameMasked || u.realnameMasked || '',
      subject,
      subjectKind,
      subjectType,
      position,
      city,
      cityCols: geo.cols,
      cityIndex: geo.index,
      exposure: ((p.exposure || u.exposure) === 'open' ? 'open' : 'hidden'),
      phonePublic: p.phonePublic === true,
      quals,
      qualDone: quals.filter((q) => q.ok).length
    })
    /* 从发布页带 focus 进入：顶部提示 + 滚动高亮到缺失字段 */
    this.computeMissing()
    this.syncLeaveGuard()
    if (this.focusKey) {
      this.focusField(this.focusKey)
      this.focusKey = ''
    }
  },

  /* 当前类别的资质行 → 上送数组；另一类别已上传的原件一并保留 */
  buildQuals() {
    const store = (this.qualStore || []).slice()
    const put = (row) => {
      if (!row || !row.fileId) return
      const name = row.name || row.k
      if (!name) return
      const item = { name, kind: row.kind || 'other', fileId: row.fileId }
      const i = store.findIndex((x) => x && (x.name || x.k) === name)
      if (i > -1) store[i] = Object.assign({}, store[i], item)
      else store.push(item)
    }
    this.data.quals.forEach((q) => put({ name: q.k, kind: q.kind, fileId: q.fileId }))
    return store
      .filter((x) => x && (x.name || x.k) && x.fileId)
      .map((x) => ({ name: x.name || x.k, kind: x.kind || 'other', fileId: x.fileId }))
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({ [key]: e.detail.value })
  },

  pickSubjectKind(e) {
    const key = e.currentTarget.dataset.key === 'person' ? 'person' : 'company'
    if (key === this.data.subjectKind) return
    const quals = qualRows(this.qualStore, key)
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({
      subjectKind: key,
      subjectType: key === 'person' ? '个人' : (this.data.subjectType === '个人' ? '' : this.data.subjectType),
      quals,
      qualDone: quals.filter((q) => q.ok).length
    })
  },

  pickSubjectType(e) {
    const idx = Number(e.detail.value)
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({ subjectType: SUBJECT_TYPES[idx] || '' })
  },

  /* 公开 / 不公开主体：发布页只读展示这里的结果，统一在本页修改 */
  pickExposure(e) {
    const v = e.currentTarget.dataset.v === 'open' ? 'open' : 'hidden'
    if (v === this.data.exposure) return
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({ exposure: v, phonePublic: v === 'open' ? this.data.phonePublic : false })
  },

  /* 展示手机号：仅「公开主体」且已授权手机号时可开启 */
  togglePhonePublic(e) {
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({ phonePublic: !!(e.detail && e.detail.value) })
  },

  /* 省份滚动时联动刷新第二列城市，并重置到该省第一个城市 */
  cityColumnChange(e) {
    const col = Number(e.detail.column)
    const val = Number(e.detail.value)
    const cur = this.data.cityIndex || [0, 0]
    if (col === 0) {
      const geo = cityColumns(val, 0)
      this.setData({ cityCols: geo.cols, cityIndex: geo.index })
    } else {
      const pi = cur[0] || 0
      const geo = cityColumns(pi, val)
      this.setData({ cityCols: geo.cols, cityIndex: geo.index })
    }
  },

  pickCity(e) {
    const idx = (e.detail.value || []).map(Number)
    const geo = cityColumns(idx[0] || 0, idx[1] || 0)
    const city = geo.cols[1][geo.index[1]] || ''
    this.dirty = true
    this.syncLeaveGuard()
    this.setData({
      city: city === '—' ? '' : city,
      cityCols: geo.cols,
      cityIndex: geo.index
    })
  },

  /* 微信头像授权：用官方头像按钮拿当前微信头像，直接传上来 */
  onChooseAvatar(e) {
    const src = String((e && e.detail && e.detail.avatarUrl) || '')
    if (src) this.uploadAvatar(src)
  },

  /* 自己上传：相册 / 拍照，压缩后再传 */
  pickAvatarUpload() {
    const onPick = (res) => {
      const file = (res && res.tempFiles && res.tempFiles[0]) || {}
      const path = file.tempFilePath || (res && res.tempFilePaths && res.tempFilePaths[0]) || ''
      if (path) this.uploadAvatar(path)
    }
    if (typeof wx.chooseMedia === 'function') {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: onPick
      })
    } else {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: onPick
      })
    }
  },

  uploadAvatar(filePath) {
    const uid = (this.data.user && this.data.user.uid) || (readUser() || {}).uid || 'u'
    const ext = (String(filePath).split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg'
    wx.showLoading({ title: '上传中' })
    uploadFile(filePath, { cloudPath: `avatar/${uid}-${Date.now()}.${ext}` })
      .then((fileId) => {
        wx.hideLoading()
        if (!fileId) throw new Error('upload failed')
        this.dirty = true
        this.syncLeaveGuard()
        this.setData({ avatar: fileId })
        wx.showToast({ title: '头像已上传，保存后生效', icon: 'none' })
      })
      .catch(() => {
        wx.hideLoading()
        wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
      })
  },

  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      /* 云函数返回 { ok:true } 但缺 data 时 result 为 undefined，这里兜底成空对象 */
      const result = (await request('user', 'profile.save', {
        nick: this.data.nick,
        avatar: this.data.avatar,
        realname: this.data.realname,
        subject: this.data.subject,
        subjectKind: this.data.subjectKind,
        subjectType: this.data.subjectType,
        /* 职位 / 身份：选填，参与名片展示 */
        position: this.data.position,
        city: this.data.city,
        /* 手机号只走微信授权（auth.phone），这里留空表示不修改 */
        phone: '',
        exposure: this.data.exposure,
        phonePublic: this.data.exposure === 'open' && this.data.phonePublic === true,
        quals: this.buildQuals()
      }, { silent: true })) || {}
      writeUser(Object.assign({}, readUser() || {}, {
        nick: result.nick,
        avatar: result.avatar || this.data.avatar,
        hasPhone: result.hasPhone,
        phoneMasked: result.phoneMasked,
        realnameMasked: result.realnameMasked,
        subject: result.subject || this.data.subject,
        subjectKind: result.subjectKind || this.data.subjectKind,
        subjectType: result.subjectType || this.data.subjectType,
        position: result.position || this.data.position,
        city: result.city || this.data.city,
        exposure: result.exposure || this.data.exposure,
        phonePublic: result.phonePublic === true
      }))
      this.setData({
        profile: result,
        avatarText: (result.nick || '算').slice(0, 1),
        avatar: result.avatar || this.data.avatar,
        phoneMasked: result.phoneMasked || this.data.phoneMasked,
        hasPhone: result.hasPhone === true || this.data.hasPhone,
        realname: result.realname || this.data.realname,
        realnameMasked: result.realnameMasked || this.data.realnameMasked,
        position: result.position || this.data.position,
        /* 服务端才是最终口径：只有「公开主体」档才可能公开号码 */
        phonePublic: result.phonePublic === true,
        saving: false
      })
      /* 补齐后顶部提示条同步消失 */
      this.computeMissing()
      this.dirty = false
      this.syncLeaveGuard()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      const e = err || {}
      this.setData({ saving: false })
      /* 业务校验失败（如实名 / 手机号不合法）必须如实提示，不能静默回落本地保存 */
      if (e.code === 'VALIDATION' || e.code === 'CONFLICT' || e.code === 'FORBIDDEN' || e.code === 'UNAUTHENTICATED') {
        wx.showToast({ title: e.message || '保存失败，请检查填写内容', icon: 'none', duration: 2400 })
        return
      }
      // 云函数未部署（如游客模式）时回落到本地缓存，保证信息能保存并即时生效
      writeUser(Object.assign({}, readUser() || {}, {
        nick: this.data.nick,
        avatar: this.data.avatar,
        /* 本地只留脱敏姓名，不落明文 */
        realnameMasked: this.data.realname ? this.data.realname.slice(0, 1) + '**' : '',
        subject: this.data.subject,
        subjectKind: this.data.subjectKind,
        subjectType: this.data.subjectType,
        position: this.data.position,
        city: this.data.city
      }))
      this.setData({
        avatarText: (this.data.nick || '算').slice(0, 1)
      })
      this.computeMissing()
      this.dirty = false
      this.syncLeaveGuard()
      wx.showToast({ title: '已保存（本地）', icon: 'success' })
    }
  },

  /* 按行上传原件：企业为营业执照 / 法定代表人身份证，个人为身份证 */
  uploadQual(e) {
    const key = e.currentTarget.dataset.k
    const item = this.data.quals.find((q) => q.k === key)
    if (!key || !item) return
    const finish = (fileId) => {
      /* 同时写进本地原件库，切换主体类别再切回来不会丢 */
      this.qualStore = (this.qualStore || []).filter((x) => x && (x.name || x.k) !== key)
      this.qualStore.push({ name: key, kind: item.kind, fileId, status: '待核验' })
      const quals = this.data.quals.map((q) => (
        q.k === key ? { k: q.k, kind: q.kind, v: '已上传待核验', ok: true, fileId, status: '待核验' } : q
      ))
      this.dirty = true
      this.syncLeaveGuard()
      this.setData({ quals, qualDone: quals.filter((q) => q.ok).length })
      wx.showToast({ title: '原件已上传，保存后生效', icon: 'none' })
    }
    const upload = (filePath) => {
      wx.showLoading({ title: '上传中' })
      const ext = (String(filePath).split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg'
      uploadFile(filePath, { cloudPath: `quals/${key}-${Date.now()}.${ext}` }).then((fileId) => {
        wx.hideLoading()
        if (!fileId) throw new Error('upload failed')
        finish(fileId)
      }).catch(() => {
        wx.hideLoading()
        wx.showToast({ title: '上传失败，请重试', icon: 'none' })
      })
    }
    const onPick = (res) => {
      const file = (res && res.tempFiles && res.tempFiles[0]) || {}
      if (file.tempFilePath) upload(file.tempFilePath)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], success: onPick })
    } else {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: onPick
      })
    }
  },

  /* 微信手机号快捷验证：授权后只回脱敏值，明文不落客户端 */
  async getPhone(e) {
    const code = (e && e.detail && e.detail.code) || ''
    if (!code) {
      /* 快捷验证不可用 / 用户拒绝：引导手动填写，避免停在未授权状态 */
      this.manualPhone()
      return
    }
    wx.showLoading({ title: '授权中' })
    try {
      const res = (await request('user', 'auth.phone', { code }, { silent: true })) || {}
      wx.hideLoading()
      writeUser(Object.assign({}, readUser() || {}, {
        hasPhone: res.hasPhone === true,
        phoneMasked: res.phoneMasked || this.data.phoneMasked
      }))
      this.setData({ phoneMasked: res.phoneMasked || this.data.phoneMasked })
      wx.showToast({ title: '手机号已授权', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '授权失败，请重试', icon: 'none', duration: 2400 })
    }
  },

  /* 手动填写手机号兜底：只更新号码，不动其它资料 */
  manualPhone() {
    wx.showModal({
      title: '手机号授权未完成',
      content: '',
      editable: true,
      placeholderText: '请输入 11 位手机号',
      confirmText: '保存',
      cancelText: '取消',
      success: async (r) => {
        if (!r || !r.confirm) return
        const phone = String(r.content || '').replace(/\s+/g, '')
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          wx.showToast({ title: '请输入正确的 11 位手机号', icon: 'none' })
          return
        }
        wx.showLoading({ title: '保存中' })
        try {
          const res = (await request('user', 'auth.phoneManual', { phone }, { silent: true })) || {}
          wx.hideLoading()
          writeUser(Object.assign({}, readUser() || {}, {
            hasPhone: res.hasPhone === true,
            phoneMasked: res.phoneMasked || this.data.phoneMasked
          }))
          this.setData({ phoneMasked: res.phoneMasked || this.data.phoneMasked })
          wx.showToast({ title: '手机号已保存', icon: 'success' })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none', duration: 2400 })
        }
      }
    })
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' })
  },

  openTerms() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=terms' })
  }
})
