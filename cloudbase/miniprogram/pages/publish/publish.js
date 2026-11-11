/* 发布页：入口卡片 + 表单 */
const { gate } = require('../../utils/auth')
const notify = require('../../utils/notify')
const { request, uploadFile } = require('../../utils/request')
const catalog = require('../../utils/catalog')
const { normalizePhone, isValidContactPhone, contactPhoneError } = require('../../utils/validate')
const { ensureProfileReady } = require('../../utils/profile-ready')
const { normSearch, searchHit } = require('../../utils/model')
const M = require('../../utils/mock')

// 表单选项：multi 为多选，def 为默认选中项
const GROUPS = {
  rentTerm: { multi: true, list: ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议'], def: ['6 个月'] },
  closed: { list: ['闭口价（不议价）', '开口价（可议价）'], def: '闭口价（不议价）' },
  deposit: { list: ['免押金', '1 个月租金', '2 个月租金', '可议'], def: '1 个月租金' },
  pay: { list: ['月付', '季付', '半年付', '年付'], def: '季付' },
  supply: { list: ['现货', '期货'], def: '现货' },
  tax: { list: ['含税', '不含税', '可开专票', '可开普票'], def: '含税' },
  deliver: { list: ['当日可提', '3 天内', '7 天内', '30 天内', '可议'], def: '3 天内' }
}

// 需求验收方式：现场压测 / 第三方报告，可多选
const ACCEPT_OPTIONS = ['现场压测', '第三方报告']

// 交易地按「省 / 直辖市 → 城市」两级选择
const CITY_TREE = M.CITY_TREE
const PROVINCES = Object.keys(CITY_TREE)

// 设备目录：设备类型 → 品牌 → 系列 → 型号，四级滚轮
// 内置目录 + 管理端「产品型号库」的平台增量，联网后在 refreshCatalog 中合并
let DEVICE_TREE = M.DEVICE_TREE
let DEVICE_CATS = Object.keys(DEVICE_TREE)

function brandsOf(cat) {
  return Object.keys(DEVICE_TREE[cat] || {})
}
function seriesOf(cat, brand) {
  return Object.keys((DEVICE_TREE[cat] || {})[brand] || {})
}
function modelsOf(cat, brand, series) {
  return (((DEVICE_TREE[cat] || {})[brand] || {})[series]) || []
}
// 按选中的四列下标，算出四列各自的候选与合法下标
function clampIndex(v, len) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), Math.max(0, len - 1))
}

function deviceColumns(index) {
  const cats = DEVICE_CATS
  /* 设备目录为空时返回空列，页面照常渲染而不是整页白屏 */
  if (!cats.length) return { cols: [[], [], [], []], index: [0, 0, 0, 0] }
  const raw = Array.isArray(index) ? index : []
  const ci = clampIndex(raw[0], cats.length)
  const cat = cats[ci]
  const brands = brandsOf(cat)
  const bi = clampIndex(raw[1], brands.length)
  const brand = brands[bi] || ''
  const seriesList = seriesOf(cat, brand)
  const si = clampIndex(raw[2], seriesList.length)
  const series = seriesList[si] || ''
  const models = modelsOf(cat, brand, series)
  const mi = clampIndex(raw[3], models.length)
  return {
    cols: [cats, brands, seriesList, models],
    index: [ci, bi, si, mi]
  }
}

/** 编辑回填：把已保存的条件合并回预设选项，自定义条件也一并保留 */
function mergeOptions(list, values) {
  const picked = Array.isArray(values) ? values : []
  const out = (list || []).map((v) => ({ v, on: picked.indexOf(v) > -1 }))
  picked.forEach((v) => {
    if (!out.some((o) => o.v === v)) out.push({ v, on: true })
  })
  return out
}

/** 编辑回填：按「类型 / 品牌 / 系列 / 型号」反查四级滚轮下标 */
function deviceIndexOf(cat, brand, model) {
  const ci = Math.max(0, DEVICE_CATS.indexOf(cat))
  const catName = DEVICE_CATS[ci] || ''
  const brands = brandsOf(catName)
  const bi = Math.max(0, brands.indexOf(brand))
  const brandName = brands[bi] || ''
  const seriesList = seriesOf(catName, brandName)
  let si = 0
  for (let i = 0; i < seriesList.length; i++) {
    if (modelsOf(catName, brandName, seriesList[i]).indexOf(model) > -1) {
      si = i
      break
    }
  }
  const first = deviceColumns([ci, bi, si, 0])
  const mi = Math.max(0, (first.cols[3] || []).indexOf(model))
  return deviceColumns([ci, bi, si, mi])
}

// 媒体上限：图片 5 张 / 视频 3 段；大小上限与后端 shared/constants.js 保持同口径
// 图片 10MB（手机直出照片）、文档 20MB、视频 50MB（约 1 分钟 1080p）
const MEDIA_LIMIT = { image: 5, video: 3 }
const MEDIA_MAX_BYTES = { image: 10 * 1024 * 1024, doc: 20 * 1024 * 1024, video: 50 * 1024 * 1024 }
const MEDIA_SIZE_TEXT = { image: '单张图片不能超过 10MB', doc: '单个文件不能超过 20MB', video: '单段视频不能超过 50MB' }
const MEDIA_MAX_NAME_LEN = 30

/* 按临时文件扩展名识别真实媒体类型：iPhone 常见的 MOV 不再被当成 MP4 上传 */
function mediaMeta(kind, file) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String((file && file.tempFilePath) || ''))
  const ext = (m ? m[1] : '').toLowerCase()
  if (kind === 'image') {
    if (ext === 'png') return { type: 'image/png', ext: 'png' }
    if (ext === 'webp') return { type: 'image/webp', ext: 'webp' }
    return { type: 'image/jpeg', ext: 'jpg' }
  }
  if (ext === 'mov') return { type: 'video/quicktime', ext: 'mov' }
  if (ext === 'm4v') return { type: 'video/x-m4v', ext: 'm4v' }
  return { type: 'video/mp4', ext: 'mp4' }
}

function fmtSize(n) {
  const size = Number(n) || 0
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  if (size >= 1024) return Math.round(size / 1024) + ' KB'
  return size + ' B'
}

/** 金额千分位：服务费试算与展示统一走这里 */
function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 服务费：代采 / 代售统一后付费，发布、审核、上架都不收费，成交后再支付。
 * 计费口径：≤3 万 299 元 / 单；3 万–100 万 1% 封顶 5000；100 万元以上 0.5% 上不封顶；
 * 1000 万元及以上代采 / 代售同样按 0.5% 收取（仅资料核验要求不同），成交后支付；
 * 租赁：按首月租金合计，服务费为一个月租金，买卖双方各承担 50%，委托方只支付半个月租金。
 * 与云函数 shared/market.js 的 agencyFee 保持同一口径，最终以服务端计算为准。
 */
const LARGE_AMOUNT_THRESHOLD = 10000000

function agencyFee(amount, rental, side) {
  const total = Number(amount) || 0
  if (!(total > 0)) return { fee: 0, upfront: 0, rule: '', note: '' }

  /* 租赁：一个月租金由买卖双方各承担 50%，委托方账单为半个月租金 */
  if (rental) {
    return {
      fee: total * 0.5,
      upfront: 0,
      deferredFee: true,
      rule: '按首月租金合计，买卖双方各承担 50%（成交后支付）',
      note: '本账单为委托方应承担的半个月租金，另一方 50% 由平台另行收取，成交后支付。'
    }
  }

  /* 1000 万元及以上：费率与 100 万元以上一致（0.5% 上不封顶），只是资料核验要求更高 */
  if (total >= LARGE_AMOUNT_THRESHOLD) {
    return {
      fee: total * 0.005,
      upfront: 0,
      largeAmount: true,
      deferredFee: true,
      rule: '100 万元以上：0.5%，上不封顶（成交后支付）',
      note: side === 'buy'
        ? '提交采购意向函、委托授权书、联系人身份证，资料核验后上架；订单只对平台可见；成交后支付 0.5% 服务费。'
        : '提交营业执照、货源证明、委托授权书、联系人身份证，资料核验后上架；成交后支付 0.5% 服务费。'
    }
  }

  if (total <= 30000) {
    return { fee: 299, upfront: 0, rule: '≤ 3 万元：299 元 / 单', note: '3 万元以内按单收取 299 元服务费，成交后支付。' }
  }
  if (total <= 1000000) {
    return { fee: Math.min(total * 0.01, 5000), upfront: 0, rule: '3 万 – 100 万元：1%，封顶 5,000 元', note: '3 万至 100 万元按 1% 收取，单笔封顶 5,000 元，成交后支付。' }
  }
  return {
    fee: total * 0.005,
    upfront: 0,
    rule: '100 万元以上：0.5%，上不封顶（成交后支付）',
    note: '100 万元以上按成交金额 0.5% 收取，上不封顶，成交后支付。'
  }
}

/** 本地日期（YYYY-MM-DD）：截止时间选择器的最早 / 最晚与默认值都走这里 */
function dateStr(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() + Number(offsetDays || 0))
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd)
}

// 条件与流程的展示口径：发布方设定，对方必须满足 / 可协商
const SIDE_TITLE = {
  seller: { must: '买家必须满足', nego: '可与买家协商', flow: '购买流程', who: '买家' },
  buyer: { must: '供给方必须满足', nego: '可与供给方协商', flow: '响应流程', who: '供给方' },
  renter: { must: '承租方必须满足', nego: '可与承租方协商', flow: '租赁流程', who: '承租方' },
  lessor: { must: '出租方必须满足', nego: '可与出租方协商', flow: '租赁申请流程', who: '出租方' }
}

function sideOf(type, isRent) {
  if (type === 'buy') return isRent ? 'lessor' : 'buyer'
  return isRent ? 'renter' : 'seller'
}

Page({
  data: {
    /* 自定义导航：状态栏 + 标题栏高度，标题随发布类型变化 */
    statusBarH: 20,
    navH: 44,
    navTitle: '发布',
    type: '', // sell / buy / ''（入口页）
    mode: '', // 出售/出租/求购/租赁
    isRent: false,
    /* 成色：全新 / 二手；二手再标几成新，商机按「新二手 + 起订量」匹配 */
    condType: 'new',
    condLevel: '9成新',
    condLevels: ['95新', '9成新', '8成新', '7成新及以下'],
    /* 更多要求默认收起：条件与流程不预设，用户自己添加 */
    moreOpen: false,
    /* 主体信息统一取自「我的 · 个人信息」，发布页不再逐条设置公开 / 保密 */
    profileSubject: '',
    profileSubjectType: '',
    profileKindLabel: '企业主体',
    profileExposureLabel: '不公开主体',
    profileOpen: false,
    profileQualDone: 0,
    profileQualTotal: 0,
    /* 币种：默认人民币 */
    currency: 'CNY',
    currencyIndex: 0,
    currencyOptions: [
      { code: 'CNY', symbol: '¥', label: '人民币' },
      { code: 'USD', symbol: '$', label: '美元' },
      { code: 'USDT', symbol: '₮', label: 'USDT' },
      { code: 'HKD', symbol: 'HK$', label: '港币' },
      { code: 'EUR', symbol: '€', label: '欧元' },
      { code: 'GBP', symbol: '£', label: '英镑' },
      { code: 'JPY', symbol: '¥', label: '日元' },
      { code: 'SGD', symbol: 'S$', label: '新加坡元' },
      { code: 'AED', symbol: 'د.إ', label: '迪拉姆' },
      { code: 'BTC', symbol: '₿', label: '比特币' }
    ],
    currencyLabels: ['人民币 ¥', '美元 $', 'USDT ₮', '港币 HK$', '欧元 €', '英镑 £', '日元 ¥', '新加坡元 S$', '迪拉姆 د.إ', '比特币 ₿'],
    form: { title: '', qty: '', minQty: '', price: '', priceMax: '', priceMode: 'fixed', accept: '', limit: '', note: '', requirements: '', cat: '', brand: '', series: '', model: '', device: '', devicePath: '', province: '', city: '', subject: '', phone: '' },
    modeOptions: ['出售', '出租'],
    /* 设备列在 onLoad 里计算：模块加载阶段算会让缺键 / 空目录直接白屏 */
    deviceCols: [],
    deviceIndex: [0, 0, 0, 0],
    /* 设备搜索：输入关键词即时匹配，点结果直接选中并回填到同一个输入框 */
    deviceKeyword: '',
    deviceResults: [],
    deviceSearchOpen: false,
    /* 需求侧只选设备类型时用的单列滚轮 */
    catIndex: 0,
    catOptions: DEVICE_CATS,
    /* 需求验收方式：现场压测 / 第三方报告 */
    acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: false })),
    provinces: PROVINCES,
    cities: [],
    groups: {},
    selected: {},
    /* 条件设置：必须条件 / 可沟通条件（可自己新增） */
    condSide: 'seller',
    mustTitle: '买家必须满足',
    negoTitle: '可与买家协商',
    flowTitle: '购买流程',
    mustOpts: [],
    negoOpts: [],
    mustInput: '',
    negoInput: '',
    /* 交易流程（可增删与排序） */
    flow: [],
    stepSeq: 0,
    stepName: '',
    stepDesc: '',
    /* 出售商品可同步一条私库存，参与平台新需求的商机匹配 */
    syncStock: true,
    /* 发布渠道：仅普通 / 仅商机 / 二者都发；需公开主体信息 */
    channel: 'both',
    poolDisabled: false,
    /* 私密发布＝匿名公开：默认关闭，商品照常实名公开；需求同样默认关闭 */
    privatePublish: false,
    /* 主体信息公开范围以「我的信息」为准，这里只读展示 */
    subjectExposure: 'hidden',
    profileExposureLabel: '不公开主体',
    /* 代采 / 代售设备：只能从平台预设型号库选择，支持搜索或展开目录 */
    agDeviceCols: [],
    agDeviceIndex: [0, 0, 0, 0],
    agDevicePath: '',
    agDeviceKeyword: '',
    agDeviceResults: [],
    agDeviceSearchOpen: false,
    /* 媒体：选填，图片最多 5 张、视频最多 3 段，可自定义命名 */
    imgList: [],
    videoList: [],
    mediaSeq: 0,
    /* 当前草稿 id：连续存草稿覆盖同一条 */
    draftId: '',
    /* 编辑模式：从「我的 · 我发布的」带 id + kind 进入，回填后原地保存 */
    editing: false,
    editId: '',
    editKind: 'product',
    editStatus: '',
    editLoading: false,
    /* 代采 / 代售委托：独立于普通发布流程，不影响原有表单与校验 */
    agencyType: '', // buy / sell
    /* 重新提交：被驳回的委托带 id 回到本页预填，提交时原地覆盖并重新排队审核 */
    agencyResubmitId: '',
    agencyMode: '求购',
    agencyModeOptions: ['求购', '租赁'],
    agencyRent: false,
    agencyTerms: ['3 个月', '6 个月', '12 个月', '长期'],
    agencyTerm: '6 个月',
    /* 截止时间：到期仍未成交则委托自动停止；代采合同即以此时间为准 */
    agencyDeadline: '',
    agencyDeadlineMin: dateStr(1),
    agencyDeadlineMax: dateStr(365),
    agencySubjectType: 'company', // company 企业 / person 个人
    agencyForm: { item: '', qty: '', price: '', subject: '', creditCode: '', legal: '', idCard: '', phone: '', authPhone: '' },
    agencyAgree: false,
    /* 代采 / 代售的条件与流程：常显，条件逐项添加、流程可增删排序 */
    agencyCondSide: 'buyer',
    agencyMustTitle: '供给方必须满足',
    agencyNegoTitle: '可与供给方协商',
    agencyFlowTitle: '交易流程',
    agencyMustOpts: [],
    agencyNegoOpts: [],
    agencyMustInput: '',
    agencyNegoInput: '',
    agencyFlow: [],
    agencyStepSeq: 0,
    agencyStepName: '',
    agencyStepDesc: '',
    agLicense: null,
    agProof: null,
    agLoi: null,
    agAuthorization: null,
    agIdcard: null,
    agOther: [],
    feeAmountText: '—',
    feeText: '0',
    feeRule: '填写金额后自动试算',
    feeNote: '发布、审核、上架都不收费，成交后再支付服务费。'
  },

  onLoad(options) {
    const opts = options || {}
    /* 自定义导航尺寸：状态栏高度 + 与胶囊对齐的标题栏高度 */
    let statusBarH = 20
    let navH = 44
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarH = info.statusBarHeight
    } catch (e) {}
    try {
      const rect = wx.getMenuButtonBoundingClientRect()
      if (rect && rect.height && rect.top >= statusBarH) {
        navH = (rect.top - statusBarH) * 2 + rect.height
      }
    } catch (e) {}
    this.setData({ statusBarH, navH })
    /* 从首页「实时货盘 / 找平台代采」直达代采委托表单 */
    if (opts.agency === 'buy' || opts.agency === 'sell') {
      let target = ''
      try {
        target = opts.target ? decodeURIComponent(opts.target) : ''
      } catch (e) {
        target = ''
      }
      this.enterAgency(opts.agency, target)
      /* 被驳回的委托：进入表单后拉取本人委托详情回填，可改内容、重传材料后重新提交 */
      if (opts.agencyId) this.loadAgencyResubmit(String(opts.agencyId))
      return
    }
    this.setData({ type: opts.type || '' })
    this.setData({ deviceCols: deviceColumns([0, 0, 0, 0]).cols })
    /* 平台型号库会在后台合并进来，编辑回填前会等待 catalogReady */
    this.catalogReady = this.refreshCatalog()
    if (opts.id) {
      /* 编辑：先按 kind 定好出售 / 求购，再拉详情回填；回填前不允许提交 */
      const kind = opts.kind === 'demand' ? 'demand' : 'product'
      this.setData({
        editing: true,
        editId: String(opts.id),
        editKind: kind,
        type: kind === 'demand' ? 'buy' : 'sell',
        mode: kind === 'demand' ? '求购' : '出售'
      })
      this.initSelected()
      this.checkRent()
      this.syncModeOptions()
      this.syncTitle()
      this.resetCondFlow()
      this.loadEdit()
      /* 编辑页同样按个人信息展示主体，避免已填过还提示「去填写」 */
      this.loadProfileSubject()
      return
    }
    if (opts.type === 'sell') {
      /* 商品默认实名公开：内容进列表，展示发布者身份 */
      this.setData({ mode: '出售', privatePublish: false })
    } else if (opts.type === 'buy') {
      this.setData({ mode: '求购', privatePublish: false })
    }
    this.initSelected()
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    /* 主体信息默认取个人信息里已设置的；个人档案为空时留待本次发布回填 */
    this.loadProfileSubject()
  },

  onShow() {
    gate(this.route || 'pages/publish/publish', this.options)
    /* 从「我的 · 我的信息」修改公开范围后返回，立即刷新只读展示 */
    if (this.data.type) this.loadProfileSubject()
    /* 返回本页后恢复离开提醒（跳去个人信息时临时关闭过） */
    this.syncLeaveGuard()
  },

  /* 主体信息统一取「我的 · 我的信息」：名称、类别、公开范围、资质完成情况 */
  async loadProfileSubject() {
    if (this.profileLoading) return
    this.profileLoading = true
    let profile = null
    try {
      profile = await request('user', 'profile.get', {}, { silent: true })
    } catch (e) {
      this.profileLoading = false
      return
    }
    this.profileLoading = false
    if (!profile) return
    const subject = String(profile.subject || '').trim()
    const kind = profile.subjectKind === 'person' ? 'person' : 'company'
    const subjectType = String(profile.subjectType || '')
    const exposure = String(profile.exposure || 'hidden')
    const open = exposure === 'open'
    const defs = kind === 'person' ? ['身份证'] : ['营业执照', '法定代表人身份证']
    const rows = Array.isArray(profile.quals) ? profile.quals : []
    const done = defs.filter((n) => rows.some((q) => q && q.name === n && q.fileId)).length
    /* 公开范围以「我的信息」为准：本页只读展示，不再让用户在发布流程里另选一份 */
    const shown = open ? 'open' : 'hidden'
    const labelMap = { open: '公开主体', hidden: '不公开主体' }
    this.profileSubjectEmpty = !subject
    this.profileOpen = open
    const patch = {
      profileSubject: subject,
      profileKindLabel: kind === 'person' ? '个人主体' : '企业主体',
      profileSubjectType: subjectType || (kind === 'person' ? '个人' : ''),
      subjectExposure: shown,
      profileExposureLabel: labelMap[shown],
      profileOpen: open,
      profileQualDone: done,
      profileQualTotal: defs.length,
      /* 只有「公开主体」才能发布商机可见内容，其余只能普通发布；私密发布固定仅普通 */
      poolDisabled: !open,
      channel: (open && !this.data.privatePublish) ? (this.data.channel || 'both') : 'normal'
    }
    if (subject && !String(this.data.form.subject || '').trim()) patch['form.subject'] = subject
    this.setData(patch)
  },

  goProfile() {
    /* 去个人信息页补主体：临时关闭离开提醒，避免被当成「放弃发布」 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
    /* 主体为空时带 focus 参数，个人信息页会定位并高亮主体名称 */
    const focus = this.profileSubjectEmpty ? '?focus=subject' : ''
    wx.navigateTo({ url: '/pages/profile/profile' + focus })
  },

  /* ---------- 离开提醒：已填写内容时，返回前先问是否存草稿 ---------- */
  hasDraftContent() {
    const f = this.data.form || {}
    if (String(f.title || '').trim()) return true
    if (String(f.device || '').trim()) return true
    if (String(f.price || '').trim() || String(f.qty || '').trim()) return true
    if (String(f.note || '').trim() || String(f.requirements || '').trim()) return true
    if ((this.data.imgList || []).length) return true
    if ((this.data.videoList || []).length) return true
    return false
  },

  /* 只在「发布 / 编辑表单」里有内容时开启返回询问；选类型的入口页和提交成功后的空表单都不提示 */
  syncLeaveGuard() {
    if (this.data.agencyType) return
    const inForm = !!this.data.type
    const on = inForm && (this.data.editing || this.hasDraftContent())
    if (on === this._leaveGuard) return
    this._leaveGuard = on
    if (!wx.enableAlertBeforeUnload) return
    try {
      if (on) {
        wx.enableAlertBeforeUnload({
          message: this.data.editing
            ? '修改还没保存：点「取消」留在本页继续编辑；点「确定」直接退出，修改不保存。'
            : '内容还没保存：点「取消」留在本页，可点底部「存草稿」保留；点「确定」直接退出，内容不保存。'
        })
      } else {
        wx.disableAlertBeforeUnload()
      }
    } catch (e) {}
  },

  onUnload() {
    if (!wx.disableAlertBeforeUnload) return
    try { wx.disableAlertBeforeUnload() } catch (e) {}
  },

  /**
   * 首次在发布页填写主体名称时回填到个人信息。
   * 个人信息已有主体名称则不再写入，后续商品内修改不回写。
   */
  async syncProfileSubject() {
    if (!this.profileSubjectEmpty) return
    const subject = String(this.data.form.subject || '').trim()
    if (!subject) return
    this.profileSubjectEmpty = false
    try {
      await request('user', 'profile.bootstrapSubject', { subject }, { silent: true })
    } catch (e) {
      /* 回填失败不影响发布结果 */
    }
  },

  // 交易方式候选：发布商品 → 出售/出租；发布需求 → 求购/租赁
  syncModeOptions() {
    this.setData({ modeOptions: this.data.type === 'buy' ? ['求购', '租赁'] : ['出售', '出租'] })
  },

  syncTitle() {
    const type = this.data.type
    let title = '发布'
    if (this.data.editing) {
      title = this.data.editKind === 'demand'
        ? (this.data.isRent ? '编辑租赁需求' : '编辑求购需求')
        : (this.data.isRent ? '编辑出租设备' : '编辑商品')
    } else if (type === 'sell') title = this.data.isRent ? '发布出租设备' : '发布商品'
    else if (type === 'buy') title = this.data.isRent ? '发布租赁需求' : '发布求购需求'
    this.setData({ navTitle: title })
  },

  checkRent() {
    const isRent = this.data.mode === '出租' || this.data.mode === '租赁'
    this.setData({ isRent })
  },

  /* ---------- 选项组 ---------- */
  initSelected() {
    const selected = {}
    Object.keys(GROUPS).forEach((k) => {
      selected[k] = GROUPS[k].multi ? GROUPS[k].def.slice() : GROUPS[k].def
    })
    this.setData({ selected, groups: this.buildGroups(selected) })
  },

  buildGroups(selected) {
    const groups = {}
    Object.keys(GROUPS).forEach((key) => {
      const g = GROUPS[key]
      const sel = selected[key]
      groups[key] = g.list.map((v) => ({
        v,
        on: g.multi ? (sel || []).indexOf(v) > -1 : sel === v
      }))
    })
    return groups
  },

  pickChip(e) {
    const key = e.currentTarget.dataset.key
    const val = e.currentTarget.dataset.val
    const g = GROUPS[key]
    if (!g) return
    const selected = Object.assign({}, this.data.selected)
    if (g.multi) {
      const arr = (selected[key] || []).slice()
      const i = arr.indexOf(val)
      if (i > -1) arr.splice(i, 1)
      else arr.push(val)
      selected[key] = arr
    } else {
      selected[key] = val
    }
    this.setData({ selected, groups: this.buildGroups(selected) })
  },

  /* ---------- 条件设置：必须条件 / 可沟通条件 ---------- */
  // 切换出售 / 出租 / 求购 / 租赁时，只换文案与候选，不预设任何条件与流程
  resetCondFlow() {
    const type = this.data.type
    const isRent = this.data.isRent
    const side = sideOf(type, isRent)
    const t = SIDE_TITLE[side]
    const presets = M.COND_PRESETS
    const mustList = presets[side] || []
    const negoList = (isRent ? presets.negoRent : presets.nego) || []
    this.setData({
      condSide: side,
      mustTitle: t.must,
      negoTitle: t.nego,
      flowTitle: t.flow,
      mustOpts: mustList.map((v) => ({ v, on: false })),
      negoOpts: negoList.map((v) => ({ v, on: false })),
      flow: [],
      stepSeq: 0,
      mustInput: '',
      negoInput: '',
      stepName: '',
      stepDesc: ''
    })
  },

  /* 更多要求：默认收起，展开后才显示条件与交易流程 */
  toggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  /* 成色：全新 / 二手；二手时再选几成新 */
  pickCondType(e) {
    const v = e.currentTarget.dataset.v === 'used' ? 'used' : 'new'
    this.setData({ condType: v })
  },

  pickCondLevel(e) {
    this.setData({ condLevel: String(e.currentTarget.dataset.v || '') })
  },

  pickCond(e) {
    const kind = e.currentTarget.dataset.kind
    const val = e.currentTarget.dataset.v
    const key = kind === 'must' ? 'mustOpts' : 'negoOpts'
    const opts = this.data[key].map((o) => (o.v === val ? Object.assign({}, o, { on: !o.on }) : o))
    this.setData({ [key]: opts })
  },

  onCondInput(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData(kind === 'must' ? { mustInput: e.detail.value } : { negoInput: e.detail.value })
  },

  // 自定义新增一条条件，并默认选中
  addCond(e) {
    const kind = e.currentTarget.dataset.kind
    const key = kind === 'must' ? 'mustOpts' : 'negoOpts'
    const inputKey = kind === 'must' ? 'mustInput' : 'negoInput'
    const val = String(this.data[inputKey] || '').trim()
    if (!val) {
      wx.showToast({ title: '请先输入条件内容', icon: 'none' })
      return
    }
    if (this.data[key].some((o) => o.v === val)) {
      wx.showToast({ title: '该条件已存在', icon: 'none' })
      return
    }
    this.setData({ [key]: this.data[key].concat([{ v: val, on: true }]), [inputKey]: '' })
  },

  /* ---------- 交易流程：改步骤 / 增删 / 排序 ---------- */
  onStepInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    const k = e.currentTarget.dataset.k
    const flow = this.data.flow.slice()
    flow[i] = Object.assign({}, flow[i], { [k]: e.detail.value })
    this.setData({ flow })
  },

  onStepDraft(e) {
    const k = e.currentTarget.dataset.k
    this.setData(k === 'name' ? { stepName: e.detail.value } : { stepDesc: e.detail.value })
  },

  addStep() {
    const n = String(this.data.stepName || '').trim()
    const d = String(this.data.stepDesc || '').trim()
    if (!n) {
      wx.showToast({ title: '请填写步骤名称', icon: 'none' })
      return
    }
    const seq = this.data.stepSeq + 1
    this.setData({
      flow: this.data.flow.concat([{ id: 's' + seq, n, d }]),
      stepSeq: seq,
      stepName: '',
      stepDesc: ''
    })
  },

  removeStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const flow = this.data.flow.slice()
    flow.splice(i, 1)
    this.setData({ flow })
  },

  moveStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const j = e.currentTarget.dataset.dir === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= this.data.flow.length) return
    const flow = this.data.flow.slice()
    const tmp = flow[i]
    flow[i] = flow[j]
    flow[j] = tmp
    this.setData({ flow })
  },

  /* ---------- 文本输入 ---------- */
  onInput(e) {
    const key = e.currentTarget.dataset.key
    const form = Object.assign({}, this.data.form)
    form[key] = e.detail.value
    this.setData({ form })
    this.syncLeaveGuard()
  },

  /* 价格方式：固定单价 / 价格区间 / 现场沟通；切回固定时清掉最高价 */
  pickPriceMode(e) {
    const raw = e.currentTarget.dataset.mode
    const mode = raw === 'range' || raw === 'nego' ? raw : 'fixed'
    if (mode === this.data.form.priceMode) return
    const form = Object.assign({}, this.data.form, { priceMode: mode })
    if (mode === 'fixed') form.priceMax = ''
    this.setData({ form })
    this.syncLeaveGuard()
  },

  /* ---------- 设备搜索：把四级目录摊平成一行一条，输入即匹配 ---------- */
  deviceSearchIndex() {
    if (this.deviceFlat) return this.deviceFlat
    const out = []
    DEVICE_CATS.forEach((cat) => {
      Object.keys(DEVICE_TREE[cat] || {}).forEach((brand) => {
        Object.keys(DEVICE_TREE[cat][brand] || {}).forEach((series) => {
          (DEVICE_TREE[cat][brand][series] || []).forEach((model) => {
            out.push({
              k: cat + '|' + brand + '|' + series + '|' + model,
              cat,
              brand,
              series,
              model,
              path: [cat, brand, series].join(' · '),
              hay: (cat + ' ' + brand + ' ' + series + ' ' + model).toLowerCase()
            })
          })
        })
      })
    })
    this.deviceFlat = out
    return out
  },

  /* 输入即匹配：整串包含 / 多词乱序 / 子序列兜底都算命中；
     型号前缀命中的排前面，最多 20 条。空关键词返回目录前 20 条，点开即可浏览。 */
  matchDevices(rawKeyword) {
    const kw = String(rawKeyword == null ? '' : rawKeyword)
    const query = normSearch(kw)
    const toItem = (it) => ({
      k: it.k,
      model: it.model,
      path: it.path,
      cat: it.cat,
      brand: it.brand,
      series: it.series
    })
    const index = this.deviceSearchIndex()
    if (!query) return { results: index.slice(0, 20).map(toItem) }
    const head = []
    const rest = []
    index.forEach((it) => {
      if (!searchHit(it.hay, kw)) return
      if (normSearch(it.model).indexOf(query) === 0) head.push(it)
      else rest.push(it)
    })
    return { results: head.concat(rest).slice(0, 20).map(toItem) }
  },

  /* 原样保留输入内容（含空格），只把关键词用于匹配；回写 trim 后的值会导致空格打不进去 */
  onDeviceSearch(e) {
    const value = String((e.detail && e.detail.value) || '')
    this.setData({
      deviceKeyword: value,
      deviceResults: this.matchDevices(value).results,
      deviceSearchOpen: true,
      'form.model': '',
      'form.device': '',
      'form.devicePath': ''
    })
  },

  /* 空输入框聚焦时列出目录前 30 条，替代原来的「展开目录」入口 */
  focusDeviceSearch() {
    if (String(this.data.deviceKeyword || '').trim()) return
    this.setData({ deviceResults: this.matchDevices('').results, deviceSearchOpen: true })
  },

  clearDeviceSearch() {
    this.setData({
      deviceKeyword: '',
      deviceResults: [],
      deviceSearchOpen: false,
      'form.model': '',
      'form.device': '',
      'form.devicePath': ''
    })
  },

  /* 点搜索结果：反算四级下标，同步滚轮位置后回填表单，并把型号显示在同一个输入框里 */
  pickDeviceSearch(e) {
    const item = (this.data.deviceResults || [])[Number(e.currentTarget.dataset.i)]
    if (!item) return
    const cat = DEVICE_CATS[Math.max(0, DEVICE_CATS.indexOf(item.cat))] || ''
    const brands = brandsOf(cat)
    const brand = brands[Math.max(0, brands.indexOf(item.brand))] || ''
    const seriesList = seriesOf(cat, brand)
    const series = seriesList[Math.max(0, seriesList.indexOf(item.series))] || ''
    const models = modelsOf(cat, brand, series)
    const mi = Math.max(0, models.indexOf(item.model))
    const next = deviceColumns([DEVICE_CATS.indexOf(cat), brands.indexOf(brand), seriesList.indexOf(series), mi])
    this.setData({
      deviceIndex: next.index,
      deviceCols: next.cols,
      deviceKeyword: item.model,
      deviceResults: [],
      deviceSearchOpen: false,
      'form.cat': cat,
      'form.brand': brand,
      'form.series': series,
      'form.model': item.model,
      'form.device': item.model,
      'form.devicePath': [cat, brand, series].join(' · ')
    })
    this.syncLeaveGuard()
  },

  /* 发布渠道：仅普通 / 仅商机 / 二者都发；只有「公开主体」才能进商机池 */
  pickChannel(e) {
    const v = String(e.currentTarget.dataset.v || '')
    if (v !== 'normal' && v !== 'pool' && v !== 'both') return
    /* 匿名发布固定仅普通：渠道置灰不可选 */
    if (this.data.privatePublish) {
      wx.showToast({ title: '匿名发布只能普通发布，关闭匿名发布后可选择渠道', icon: 'none' })
      return
    }
    if (v !== 'normal' && !this.data.profileOpen) {
      wx.showToast({ title: '请先在「我的信息」把主体设为公开', icon: 'none' })
      return
    }
    this.setData({ channel: v })
  },

  /* 匿名发布开关：开启后内容照常公开、发布者匿名，渠道强制仅普通 */
  togglePrivate(e) {
    const on = e && e.detail && typeof e.detail.value === 'boolean'
      ? e.detail.value
      : !this.data.privatePublish
    /* 开启前记住原渠道，关闭后恢复用户此前的选择 */
    if (on) this.privatePrevChannel = this.data.channel || 'both'
    this.setData({
      privatePublish: on,
      channel: on ? 'normal' : (this.data.profileOpen ? (this.privatePrevChannel || 'both') : 'normal')
    })
  },

  /* 代采 / 代售设备搜索：输入型号 / 品牌 / 系列，下面列出匹配项，点选即回填到同一个框 */
  onAgencyDeviceSearch(e) {
    const value = String((e.detail && e.detail.value) || '')
    this.setData({
      agDeviceKeyword: value,
      agDeviceResults: this.matchDevices(value).results,
      agDeviceSearchOpen: true,
      agDevicePath: '',
      'agencyForm.item': ''
    })
  },

  /* 空输入框聚焦时列出目录前 30 条，替代原来的「展开目录」入口 */
  focusAgencyDeviceSearch() {
    if (String(this.data.agDeviceKeyword || '').trim()) return
    this.setData({ agDeviceResults: this.matchDevices('').results, agDeviceSearchOpen: true })
  },

  clearAgencyDeviceSearch() {
    this.setData({
      agDeviceKeyword: '',
      agDeviceResults: [],
      agDeviceSearchOpen: false,
      agDevicePath: '',
      'agencyForm.item': ''
    })
  },

  /* 点搜索结果：反算四级下标同步目录滚轮，并回填设备型号 */
  pickAgencyDeviceSearch(e) {
    const item = (this.data.agDeviceResults || [])[Number(e.currentTarget.dataset.i)]
    if (!item) return
    const cat = DEVICE_CATS[Math.max(0, DEVICE_CATS.indexOf(item.cat))] || ''
    const brands = brandsOf(cat)
    const brand = brands[Math.max(0, brands.indexOf(item.brand))] || ''
    const seriesList = seriesOf(cat, brand)
    const series = seriesList[Math.max(0, seriesList.indexOf(item.series))] || ''
    const models = modelsOf(cat, brand, series)
    const mi = Math.max(0, models.indexOf(item.model))
    const next = deviceColumns([DEVICE_CATS.indexOf(cat), brands.indexOf(brand), seriesList.indexOf(series), mi])
    this.setData({
      agDeviceIndex: next.index,
      agDeviceCols: next.cols,
      agDeviceKeyword: item.model,
      agDeviceResults: [],
      agDeviceSearchOpen: false,
      agDevicePath: [cat, brand, series].filter(Boolean).join(' · '),
      agencyCat: cat,
      'agencyForm.item': item.model
    })
  },

  /* 需求侧：设备类型必选，品牌 / 型号选填（填了能匹配到具体库存） */
  pickCategory(e) {
    const i = Number(e.detail.value)
    const cat = DEVICE_CATS[i] || ''
    const next = deviceColumns([i, 0, 0, 0])
    this.setData({
      catIndex: i,
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.cat': cat,
      'form.brand': '',
      'form.series': '',
      'form.model': '',
      'form.devicePath': cat,
      'form.device': ''
    })
  },

  /* 需求侧品牌 / 型号：四级目录选填，选完回填品牌与型号，用于精准匹配库存 */
  pickDemandDevice(e) {
    const raw = e.detail.value || []
    const next = deviceColumns(raw.map(Number))
    const cat = next.cols[0][next.index[0]] || ''
    const brand = next.cols[1][next.index[1]] || ''
    const series = next.cols[2][next.index[2]] || ''
    const model = next.cols[3][next.index[3]] || ''
    this.setData({
      catIndex: Math.max(0, DEVICE_CATS.indexOf(cat)),
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.cat': cat,
      'form.brand': brand,
      'form.series': series,
      'form.model': model,
      'form.devicePath': cat
    })
  },

  /* 清空选填的品牌 / 型号，回到「只按设备类型匹配」 */
  clearDemandDevice() {
    const i = Math.max(0, DEVICE_CATS.indexOf(this.data.form.cat))
    const next = deviceColumns([i, 0, 0, 0])
    this.setData({
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.brand': '',
      'form.series': '',
      'form.model': ''
    })
  },

  // 需求验收方式：现场压测 / 第三方报告，可多选
  pickAccept(e) {
    const v = e.currentTarget.dataset.v
    this.setData({
      acceptOpts: this.data.acceptOpts.map((o) => (o.v === v ? { v: o.v, on: !o.on } : o))
    })
  },

  // 先选省 / 直辖市，再选市；换省后清空已选城市
  pickProvince(e) {
    const i = Number(e.detail.value)
    const province = this.data.provinces[i] || ''
    this.setData({
      'form.province': province,
      'form.city': '',
      cities: (CITY_TREE[province] || []).slice()
    })
  },

  pickCity(e) {
    const i = Number(e.detail.value)
    this.setData({ 'form.city': this.data.cities[i] || '' })
  },

  /* 定位自动填写省 / 市：用户主动点击才拉起地图，拒绝授权则保持手动选择 */
  useLocation() {
    const { chooseCity } = require('../../utils/location')
    chooseCity().then((hit) => {
      if (!hit) return
      this.setData({
        'form.province': hit.province,
        'form.city': hit.city,
        cities: (CITY_TREE[hit.province] || []).slice()
      })
      this.syncLeaveGuard()
      wx.showToast({ title: '已填入 ' + hit.city, icon: 'none' })
    }).catch((err) => {
      const msg = (err && err.message) || ''
      if (msg) wx.showToast({ title: msg, icon: 'none' })
    })
  },

  /* ---------- 平台型号库：合并进四级滚轮 ---------- */
  async refreshCatalog() {
    try {
      const res = await catalog.loadCatalog()
      if (!res || !res.tree) return
      DEVICE_TREE = res.tree
      DEVICE_CATS = res.cats
      /* 目录变了，搜索索引必须重建 */
      this.deviceFlat = null
      const next = deviceColumns(this.data.deviceIndex)
      this.setData({
        catOptions: DEVICE_CATS,
        deviceIndex: next.index,
        deviceCols: next.cols
      })
      if (this.data.deviceKeyword) this.onDeviceSearch({ detail: { value: this.data.deviceKeyword } })
    } catch (e) {
      /* 目录刷新失败沿用内置目录，不打断发布流程 */
    }
  },

  /* ---------- 编辑模式：回填与保存 ---------- */
  async loadEdit() {
    /* 编辑回填依赖完整目录：先等平台型号合并完成，避免型号定位偏差 */
    if (this.catalogReady) {
      try { await this.catalogReady } catch (e) { /* 目录拉取失败用内置目录继续 */ }
    }
    this.setData({ editLoading: true })
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const doc = await request('user', 'mine.publish.detail', {
        id: this.data.editId,
        kind: this.data.editKind
      }, { silent: true })
      this.fillForm(doc || {})
    } catch (e) {
      /* 未登录已由 request 统一跳登录页，这里不再叠加弹层 */
      if (e && e.code === 'UNAUTHENTICATED') return
      /* 其余失败：回填不了就退回上一页，避免在空表单上误发成新条目 */
      wx.showModal({
        title: '无法加载',
        content: (e && e.message) || '内容加载失败，请返回后重试',
        showCancel: false,
        confirmText: '返回',
        success: () => this.backToMine()
      })
    } finally {
      wx.hideLoading()
      this.setData({ editLoading: false })
    }
  },

  fillForm(doc) {
    const isBuy = this.data.editKind === 'demand'
    const mode = doc.tradeMode || (isBuy ? '求购' : '出售')
    const isRent = mode === '出租' || mode === '租赁'
    const cat = String(doc.cat || '')
    const brand = String(doc.brand || '')
    const model = String(doc.model || '')
    const city = String(doc.city || '')
    let province = ''
    PROVINCES.forEach((p) => {
      if ((CITY_TREE[p] || []).indexOf(city) > -1) province = p
    })

    const selected = Object.assign({}, this.data.selected)
    selected.supply = doc.supply || selected.supply
    /* 税费是单选：回填时取第一个值，保持 selected.tax 为字符串 */
    if (doc.tax) selected.tax = (Array.isArray(doc.tax) ? doc.tax[0] : String(doc.tax).split(' · ')[0]) || selected.tax
    if (isRent) {
      if (Array.isArray(doc.term) && doc.term.length) selected.rentTerm = doc.term.slice()
      selected.deposit = doc.deposit || selected.deposit
      selected.pay = doc.pay || selected.pay
      /* 服务端枚举与表单文案不同，回填时换回表单口径 */
      if (doc.closed) {
        selected.closed = (doc.closed === '接受闭口价' || doc.closed === '闭口价（不议价）')
          ? '闭口价（不议价）'
          : '开口价（可议价）'
      }
      if (doc.deliver) selected.deliver = doc.deliver === '当日可起租' ? '当日可提' : doc.deliver
    } else {
      if (doc.deliver) selected.deliver = doc.deliver
    }
    /* 成色：服务端只存「全新 / 二手」，几成新单独回填 */
    const condRaw = String(doc.cond || '')
    const condType = (condRaw && condRaw !== '全新') ? 'used' : 'new'
    const condLevel = String(doc.condLevel || '9成新')

    /* 买卖两侧都按已保存的「品类 / 品牌 / 型号」反查四级滚轮下标：
       否则编辑需求时滚轮停在默认型号，点一次「确定」就会把原型号覆盖掉 */
    const next = DEVICE_CATS.indexOf(cat) < 0 ? null : deviceIndexOf(cat, brand, model)
    const seriesName = next ? (next.cols[2][next.index[2]] || '') : ''

    /* 媒体只回填元信息：编辑页不再持有原文件路径，保存时按名称 / 类型 / 大小原样上送。
       必须同时保留 fileId：编辑保存会把整个列表重新提交，丢了 fileId 原件就变成不可预览的占位。 */
    const media = Array.isArray(doc.media) ? doc.media : []
    let seq = 0
    const toItem = (m, kind) => {
      seq++
      return {
        key: 'e' + seq,
        name: String(m.name || (kind === 'image' ? '图片' : '视频')),
        path: '',
        size: Number(m.size) || 0,
        sizeText: fmtSize(m.size),
        type: m.type || (kind === 'image' ? 'image/jpeg' : 'video/mp4'),
        fileId: String(m.fileId || ''),
        kind
      }
    }
    const imgList = media.filter((m) => m && m.kind === 'image').map((m) => toItem(m, 'image'))
    const videoList = media.filter((m) => m && m.kind !== 'image').map((m) => toItem(m, 'video'))

    const side = sideOf(this.data.type, isRent)
    const presets = M.COND_PRESETS
    const mustList = presets[side] || []
    const negoList = (isRent ? presets.negoRent : presets.nego) || []
    const bodyFlow = Array.isArray(doc.flow) ? doc.flow : []
    const flow = bodyFlow.length
      ? bodyFlow.map((s, i) => {
        const parts = String(s).split('｜')
        return { id: 's' + (i + 1), n: parts[0] || '', d: parts[1] || '' }
      })
      : this.data.flow

    this.setData({
      mode,
      isRent,
      condType,
      condLevel,
      editStatus: doc.status || '',
      /* 编辑回填：按已保存的可见范围还原开关，公开商品不会被误改私密 */
      privatePublish: doc.visibility === 'private',
      channel: doc.visibility === 'private' ? 'normal' : this.data.channel,
      selected,
      groups: this.buildGroups(selected),
      mustOpts: mergeOptions(mustList, doc.must),
      negoOpts: mergeOptions(negoList, doc.nego),
      acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: String(doc.accept || '').indexOf(v) > -1 })),
      mustInput: '',
      negoInput: '',
      flow,
      stepSeq: flow.length,
      /* 已保存过条件 / 流程时自动展开，避免用户以为丢了 */
      moreOpen: !!((doc.must || []).length || (doc.nego || []).length || flow.length),
      imgList,
      videoList,
      mediaSeq: seq,
      cities: province ? (CITY_TREE[province] || []).slice() : [],
      deviceCols: next ? next.cols : this.data.deviceCols,
      deviceIndex: next ? next.index : this.data.deviceIndex,
      /* 编辑回填时把已选型号显示在同一个搜索框里 */
      deviceKeyword: model || '',
      deviceResults: [],
      deviceSearchOpen: false,
      catIndex: Math.max(0, DEVICE_CATS.indexOf(cat)),
      condSide: side,
      mustTitle: SIDE_TITLE[side].must,
      negoTitle: SIDE_TITLE[side].nego,
      flowTitle: SIDE_TITLE[side].flow,
      form: {
        title: String(doc.title || ''),
        qty: doc.qty ? String(doc.qty) : '',
        minQty: doc.minQty ? String(doc.minQty) : '',
        price: String((isBuy ? doc.budget : doc.price) || ''),
        priceMode: String((isBuy ? doc.budgetMode : doc.priceMode) || 'fixed'),
        priceMax: String((isBuy ? doc.budgetMax : doc.priceMax) || ''),
        accept: String(doc.accept || ''),
        limit: String(doc.limit || ''),
        note: String(doc.note || ''),
        requirements: String(doc.requirements || ''),
        cat,
        brand,
        series: seriesName,
        /* 编辑回填必须同时写 model 与 device：保存校验与页面展示分别读这两个字段，
           之前商品只回填 device、需求只回填 model，导致二次编辑被「请选择设备型号」拦住 */
        model,
        device: model,
        devicePath: [cat, brand, seriesName].filter(Boolean).join(' · '),
        province,
        city,
        subject: this.data.form.subject || '',
        phone: this.data.form.phone || ''
      }
    })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
  },

  backToMine() {
    /* 保存 / 发布成功后退出：先解除返回询问，避免自己弹自己 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
    /* 发布 / 编辑成功：标记「我的」本地快照失效，避免 60 秒内显示旧列表 */
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.mineDirty = true
    } catch (e) {}
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  /* ---------- 媒体（选填）：图片 5 张 / 视频 3 段，单文件大小受限 ---------- */
  /* 把本次选择结果并入列表：超限的文件跳过并提示，避免一次性占满存储。
     选中即上传到平台存储，管理端审核时可直接看到原件，不再只有文件名。 */
  async addMedia(kind, files) {
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    const limit = MEDIA_LIMIT[kind]
    const maxBytes = MEDIA_MAX_BYTES[kind]
    let seq = this.data.mediaSeq
    let oversize = 0
    let overflow = 0
    const pending = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {}
      const size = Number(f.size) || 0
      if (size > maxBytes) {
        oversize++
        continue
      }
      if (list.length + pending.length >= limit) {
        overflow++
        continue
      }
      seq++
      const fallbackName = kind === 'image'
        ? (this.data.type === 'buy' ? '资质材料 ' + seq : '设备实拍图 ' + seq)
        : (this.data.type === 'buy' ? '验资视频 ' + seq : '设备实拍视频 ' + seq)
      const meta = mediaMeta(kind, f)
      pending.push({
        key: 'm' + seq,
        seq,
        name: fallbackName,
        path: f.tempFilePath || '',
        size,
        sizeText: fmtSize(size),
        type: meta.type,
        ext: meta.ext,
        kind
      })
    }
    if (pending.length) {
      wx.showLoading({ title: '上传中', mask: true })
      try {
        for (let i = 0; i < pending.length; i++) {
          const it = pending[i]
          if (!it.path) continue
          it.fileId = await uploadFile(it.path, {
            cloudPath: 'publish/' + kind + '/' + Date.now() + '-' + it.seq + '.' + (it.ext || 'jpg')
          })
        }
      } catch (err) {
        wx.hideLoading()
        wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
        return
      }
      wx.hideLoading()
    }
    const accepted = pending.filter((it) => it.fileId)
    this.setData({ [listKey]: list.concat(accepted), mediaSeq: seq })
    this.syncLeaveGuard()
    if (oversize) {
      wx.showToast({ title: '已跳过 ' + oversize + ' 个' + (kind === 'image' ? '图片' : '视频') + '（' + MEDIA_SIZE_TEXT[kind] + '）', icon: 'none' })
    } else if (overflow) {
      wx.showToast({ title: '最多 ' + limit + (kind === 'image' ? ' 张图片' : ' 段视频'), icon: 'none' })
    } else if (accepted.length) {
      wx.showToast({ title: '已添加 ' + accepted.length + (kind === 'image' ? ' 张' : ' 段'), icon: 'none' })
    }
  },

  uploadImage() {
    const remain = MEDIA_LIMIT.image - this.data.imgList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 5 张图片', icon: 'none' })
      return
    }
    const pick = (res) => {
      /* chooseMedia 返回 tempFiles（含 size），chooseImage 只保证 tempFilePaths */
      const files = (res && res.tempFiles) || ((res && res.tempFilePaths) || []).map((p) => ({ tempFilePath: p }))
      if (files.length) this.addMedia('image', files)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['image'], success: pick })
    } else {
      wx.chooseImage({ count: remain, success: pick })
    }
  },

  uploadVideo() {
    const remain = MEDIA_LIMIT.video - this.data.videoList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 3 段视频', icon: 'none' })
      return
    }
    const pick = (res) => {
      const files = (res && res.tempFiles) ||
        ((res && res.tempFilePath) ? [{ tempFilePath: res.tempFilePath, size: res.size }] : [])
      if (files.length) this.addMedia('video', files)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['video'], success: pick })
    } else {
      wx.chooseVideo({ maxDuration: 60, success: pick })
    }
  },

  // 自定义命名：文件叫什么由发布方决定，方便交易对象快速识别
  renameMedia(e) {
    const kind = e.currentTarget.dataset.kind
    const i = Number(e.currentTarget.dataset.i)
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const cur = this.data[listKey][i]
    if (!cur) return
    wx.showModal({
      title: '给文件命名',
      editable: true,
      placeholderText: kind === 'image' ? '如：营业执照 / 整机正面实拍' : '如：验资视频 / 开机铭牌实拍',
      content: cur.name,
      success: (res) => {
        if (!res.confirm) return
        const name = String(res.content || '').trim().slice(0, MEDIA_MAX_NAME_LEN)
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' })
          return
        }
        const list = this.data[listKey].slice()
        list[i] = Object.assign({}, list[i], { name })
        this.setData({ [listKey]: list })
      }
    })
  },

  removeMedia(e) {
    const kind = e.currentTarget.dataset.kind
    const i = Number(e.currentTarget.dataset.i)
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    list.splice(i, 1)
    this.setData({ [listKey]: list })
    this.syncLeaveGuard()
  },

  /* ---------- 提交 ---------- */
  // 把表单字段翻译成云函数契约（buildProduct / buildDemand 的字段名与枚举）
  buildPayload(opts) {
    const f = this.data.form
    const num = (v) => Number(String(v).replace(/,/g, '').trim())
    const isBuy = this.data.type === 'buy'
    const sel = this.data.selected || {}
    const path = String(f.devicePath || '').split(' · ')
    const cat = String(f.cat || path[0] || '').trim()
    const brand = String(f.brand || path[1] || '').trim()
    const series = String(f.series || path[2] || '').trim()
    const model = String(f.model || f.device || series || '').trim()
    const rental = this.data.isRent
    const tradeMode = isBuy ? (rental ? '租赁' : '求购') : (rental ? '出租' : '出售')
    /* 出租与租赁的「可交付时间」枚举不同：出租方用「当日可起租」 */
    const deliver = rental
      ? (sel.deliver === '当日可提' ? '当日可起租' : (sel.deliver || '当日可起租'))
      : (sel.deliver || '3 天内')
    /* 租赁需求对「闭口价」的口径是接受度，需要换成需求侧枚举 */
    const closed = rental && isBuy
      ? (sel.closed === '闭口价（不议价）' ? '接受闭口价' : '只接受可议价')
      : sel.closed

    /* 私密发布只看用户开关：开启后内容照常公开，但发布者完全匿名 */
    const secret = this.data.privatePublish === true
    const payload = {
      tradeMode,
      visibility: secret ? 'private' : 'public',
      channel: secret ? 'normal' : (this.data.channel || 'both'),
      currency: this.data.currency || 'CNY',
      title: String(f.title || '').trim(),
      cat,
      brand,
      series,
      model,
      qty: num(f.qty),
      supply: sel.supply || '现货',
      /* 税费是单选（selected.tax 为字符串），服务端契约要数组；这里统一数组化，
         否则 '含税'.slice() 仍是字符串，服务端会报「税费格式不正确」 */
      tax: Array.isArray(sel.tax) ? sel.tax.slice() : (sel.tax ? [String(sel.tax)] : []),
      deliver,
      must: (this.data.mustOpts || []).filter((o) => o.on).map((o) => o.v),
      nego: (this.data.negoOpts || []).filter((o) => o.on).map((o) => o.v),
      flow: (this.data.flow || [])
        .filter((s) => String(s.n || '').trim())
        .map((s) => {
          const name = String(s.n).trim()
          const desc = String(s.d || '').trim()
          return (desc ? name + '｜' + desc : name).slice(0, 40)
        }),
      /* 媒体元信息 + 上传得到的 fileId：管理端据此直接展示原件。
         编辑时同样整份提交（列表已回填原件的 fileId）：服务端按此保留未删的原件、
         并接收本次新上传的图片 / 视频。之前编辑时直接删掉 media，新素材永远存不进管理端。 */
      media: this.data.imgList.concat(this.data.videoList).map((m) => ({
        name: m.name,
        type: m.type,
        size: m.size,
        kind: m.kind,
        fileId: m.fileId || ''
      }))
    }
    /* 商品展示信息：验收标准 / 可承接数量 / 交易说明，均由发布者填写 */
    if (!isBuy) {
      payload.accept = String(f.accept || '').trim()
      payload.limit = String(f.limit || '').trim()
      payload.note = String(f.note || '').trim()
      payload.requirements = String(f.requirements || '').trim()
    } else {
      /* 需求验收方式：现场压测 / 第三方报告 */
      payload.accept = (this.data.acceptOpts || [])
        .filter((o) => o.on)
        .map((o) => o.v)
        .join(' + ')
    }
    if (opts && opts.draft) payload.draft = true
    /* 同一草稿反复保存要覆盖同一条，带上 id */
    if (this.data.draftId) payload.id = this.data.draftId
    /* 价格方式：固定 / 区间 / 现场沟通；面议不落金额 */
    const priceMode = f.priceMode || 'fixed'
    const priceMax = priceMode === 'range' ? num(f.priceMax) : 0
    if (isBuy) {
      payload.budgetMode = priceMode
      payload.budgetMax = priceMax
    } else {
      payload.priceMode = priceMode
      payload.priceMax = priceMax
    }
    if (rental) {
      /* 出租用月租金，租赁需求用月租金预算；服务端字段都叫 rent */
      payload.rent = priceMode === 'nego' ? 0 : num(f.price)
      payload.term = (sel.rentTerm || []).slice()
      payload.closed = closed
      payload.deposit = sel.deposit
      payload.pay = sel.pay
    } else {
      if (isBuy) payload.budget = priceMode === 'nego' ? 0 : num(f.price)
      else payload.price = priceMode === 'nego' ? 0 : num(f.price)
      /* 成色：全新 / 二手，二手再带几成新；商机按「新二手」匹配 */
      payload.cond = this.data.condType === 'used' ? '二手' : '全新'
      payload.condLevel = this.data.condType === 'used' ? this.data.condLevel : ''
      payload.city = String(f.city || '').trim()
      if (!isBuy) payload.minQty = num(f.minQty)
    }
    /* 出售商品可同步一条私库存用于商机匹配；草稿与租赁不写库存 */
    if (!isBuy && !rental && !(opts && opts.draft) && this.data.syncStock) {
      payload.syncStock = true
    }
    return payload
  },

  /* 存草稿：只要求标题，其余字段可空；存完在「我的 · 我发布的」里补齐再提交 */
  async saveDraft() {
    if (this.submitting) return
    /* 编辑模式不产生新草稿：保存修改走 update，状态保持不变 */
    if (this.data.editing) return
    const f = this.data.form
    if (!String(f.title || '').trim()) {
      wx.showToast({ title: '请先填写标题', icon: 'none' })
      return
    }
    const isBuy = this.data.type === 'buy'
    const payload = this.buildPayload({ draft: true })
    this.submitting = true
    try {
      const res = await request('user', isBuy ? 'demand.publish' : 'product.publish', payload)
      this.setData({ draftId: (res && res.id) || this.data.draftId })
    } catch (e) {
      /* request 已按错误码提示，留在当前页让用户修改 */
      return
    } finally {
      this.submitting = false
    }
    wx.showModal({
      title: '已存草稿',
      content: '草稿不会对外展示，可在「我的 · 我发布的」里补齐信息后重新提交。',
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        /* 我的发布列表有 60 秒本地快照：不标脏会命中缓存，看起来像「草稿没存上」 */
        try {
          const app = getApp()
          if (app && app.globalData) {
            app.globalData.mineDirty = true
            /* 落地「我的 · 我发布的」对应子类，不用用户自己找 */
            app.globalData.minePub = isBuy ? 'demand' : 'product'
          }
        } catch (e) {}
        this.reset()
        /* 留在发布页入口卡片：用户从「＋」进来，提交完就回到「＋」之后的界面，
           由系统返回键回到进入时的 tab 页，不再把用户丢到「我的」 */
      }
    })
  },

  /* 提交发布：整段流程先加锁，避免连点或授权弹窗期间落下两条记录 */
  async submit() {
    if (this.submitting) return
    this.submitting = true
    try {
      await this.submitNow()
    } catch (e) {
      /* 未预期的异常不能让按钮永久锁死 */
    } finally {
      this.submitting = false
    }
  },

  async submitNow() {
    const f = this.data.form
    const num = (v) => Number(String(v).replace(/,/g, '').trim())
    const err = (t) => wx.showToast({ title: t, icon: 'none' })
    const isBuy = this.data.type === 'buy'
    const qtyWord = isBuy ? '需求' : (this.data.isRent ? '可租' : '可售')
    const priceWord = isBuy
      ? (this.data.isRent ? '月租金预算' : '预算单价')
      : (this.data.isRent ? '月租金' : '出售单价')
    const priceMode = f.priceMode || 'fixed'

    if (!String(f.title || '').trim()) return err('请填写标题')
    if (String(f.title).trim().length < 4) return err('标题至少 4 个字')
    /* 设备必须选到平台预设型号库里的型号，否则无法参与商机匹配；
       编辑回填时 model / device 只有一个有值，两者取其一即可，避免老数据被误拦。 */
    const deviceModel = String(f.model || f.device || '').trim()
    if (!deviceModel) return err('请选择设备型号')
    if (!(num(f.qty) > 0)) return err('请填写' + qtyWord + '数量')
    /* 起订量只属于供给方（发布商品）；需求方只表达明确需求量，不校验起订量 */
    if (!isBuy) {
      if (!(num(f.minQty) > 0)) return err(this.data.isRent ? '请填写起租数量' : '请填写起订量')
      if (num(f.minQty) > num(f.qty)) return err(this.data.isRent ? '起租数量不能大于可租数量' : '起订量不能大于可售数量')
    }
    /* 价格方式：现场沟通不填金额；价格区间需给出高于最低价的最高价 */
    if (priceMode !== 'nego') {
      if (!(num(f.price) > 0)) return err('请填写' + priceWord)
      if (priceMode === 'range') {
        if (!(num(f.priceMax) > 0)) return err('请填写最高价')
        if (!(num(f.priceMax) > num(f.price))) return err('最高价需高于最低价')
      }
    }
    if (!this.data.isRent && !f.city) return err(isBuy ? '请选择交付城市' : '请选择交易地/发货地')
    if (this.data.isRent && !(this.data.selected.rentTerm || []).length) return err('请选择租期')
    /* 本页「联系人手机号」只是补充说明，不会随发布上送（平台用「我的信息」里已绑定的号码），
       因此不做格式拦截：填了座机、分机或国内外号码都不该挡住发布。 */
    const must = this.data.mustOpts.filter((o) => o.on).map((o) => o.v)
    const nego = this.data.negoOpts.filter((o) => o.on).map((o) => o.v)
    const flow = this.data.flow.filter((s) => String(s.n || '').trim())
    if (flow.some((s) => !String(s.n || '').trim())) return err('交易流程步骤名称不能为空')

    /* 发布 / 编辑前先确认资料齐全：缺主体信息或联系方式时弹窗引导补齐 */
    if (!(await ensureProfileReady())) return
    /* 主体公开范围由「我的信息」统一设置，本页只读展示，不再重复写入 */

    /* 编辑：原地更新内容，状态不变（在售仍上架、草稿仍是草稿），也不申请发布订阅 */
    if (this.data.editing) {
      const payload = this.buildPayload()
      payload.id = this.data.editId
      try {
        await request('user', this.data.editKind === 'demand' ? 'demand.update' : 'product.update', payload)
      } catch (e) {
        return
      }
      wx.showModal({
        title: '已保存',
        content: '修改已生效，当前状态保持不变。可在「我的 · 我发布的」中继续管理。',
        showCancel: false,
        confirmText: '知道了',
        success: () => this.backToMine()
      })
      return
    }

    /* 发布后（求购被响应 / 商品被咨询）通过微信服务通知提醒发布方。
       订阅消息必须由点击触发，这里借「提交」这一次点击申请授权；未授权不影响发布。
       先等授权弹窗关闭再弹审核提示，避免两个弹层抢焦点；
       模板未配置或环境不支持时不会弹框，直接继续。 */
    if (notify.configured() && notify.supported()) await notify.requestSubscribe()

    /* 真正落库：商品进 products、需求进 demands，
       管理端 product.list / demand.list 读到的就是这份真实数据 */
    const payload = this.buildPayload()
    let published = null
    try {
      published = await request('user', isBuy ? 'demand.publish' : 'product.publish', payload)
    } catch (e) {
      /* request 已按错误码提示（未实名 / 校验失败 / 限流），留在当前页让用户修改 */
      return
    }

    // 自动过审：发布即上架，不再有「平台审核中」的等待环节
    /* 个人档案还没有主体名称时，把本次填写的主体名称回填一次（不影响发布结果） */
    await this.syncProfileSubject()
    const typeLabel = isBuy
      ? (this.data.isRent ? '租赁需求' : '求购需求')
      : (this.data.isRent ? '出租设备' : '出售商品')
    /* 条件与流程都是选填，没填就不提，避免低价值商品发布时堆一串 0 */
    const extra = []
    if (must.length) extra.push('必须条件 ' + must.length + ' 条')
    if (nego.length) extra.push('可协商条件 ' + nego.length + ' 条')
    if (flow.length) extra.push('交易流程 ' + flow.length + ' 步')
    const extraText = extra.length ? '（' + extra.join(' / ') + '）' : ''
    /* 私密发布＝匿名公开：内容照常进列表，成功文案必须与真实可见范围一致 */
    const secretPublish = this.data.privatePublish === true
    const successText = secretPublish
      ? '你的' + typeLabel + '已匿名发布' + extraText + '。\n\n内容会正常出现在首页、在售货源与需求列表中，但不会显示你的头像、主体与主页入口，别人也无法通过这条内容进入你的主页；主页列表中也不会出现这条内容。只有你在站内对话里主动告知，对方才知道发布人是谁。可在「我的 · 我发布的」中查看与管理（会标注「匿名发布」）。材料已加密存储，仅平台内可见，查看时叠加账号与昵称水印。'
      : '你的' + typeLabel + '已发布并上架到「' + (isBuy ? '求购需求' : '在售货源') + '」' + extraText + '。\n\n有用户满足必须条件即可与你直接对话，并会通过站内消息通知你。可在「我的 · 我发布的」中查看与管理。材料已加密存储，仅平台内可见，查看时叠加账号与昵称水印。\n\n平台已自动完成基础审核；命中风险规则的内容会进入风险池人工复核，未处理前照常展示。'
    wx.showModal({
      title: '发布成功',
      content: successText +
        (published && published.stockSynced ? '\n\n已同步到「我的库存」：平台新发布的求购需求会与这条货源匹配，匹配结果在「商机」中查看。' : ''),
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        /* 「我的」列表有 60 秒快照：标脏后返回即可看到新发布的内容 */
        try {
          const app = getApp()
          if (app && app.globalData) {
            app.globalData.mineDirty = true
            app.globalData.minePub = isBuy ? 'demand' : 'product'
          }
        } catch (e) {}
        /* 留在发布页入口卡片（「＋」之后的界面），返回键回原 tab 页；
           首页信息流在 onShow 会重新拉取，新发布内容返回即可看到 */
        this.reset()
      }
    })
  },

  /* 是否把这条出售商品同步进私库存（仅用于商机匹配） */
  toggleSyncStock(e) {
    const on = e && e.detail && typeof e.detail.value === 'boolean'
      ? e.detail.value
      : !this.data.syncStock
    this.setData({ syncStock: on })
  },

  reset() {
    this.setData({
      condType: 'new',
      condLevel: '9成新',
      moreOpen: false,
      form: { title: '', qty: '', minQty: '', price: '', priceMax: '', priceMode: 'fixed', accept: '', limit: '', note: '', requirements: '', cat: '', brand: '', series: '', model: '', device: '', devicePath: '', province: '', city: '', subject: '', phone: '' },
      cities: [],
      deviceIndex: [0, 0, 0, 0],
      deviceCols: deviceColumns([0, 0, 0, 0]).cols,
      deviceKeyword: '',
      deviceResults: [],
      deviceSearchOpen: false,
      acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: false })),
      syncStock: true,
      privatePublish: false,
      subjectExposure: 'hidden',
      profileExposureLabel: '不公开主体',
      imgList: [],
      videoList: [],
      mediaSeq: 0,
      draftId: '',
      /* 清空后回到「点加号之后」的入口卡片：从哪进来就停在哪，不再跳首页 / 我的 */
      type: '',
      mode: '',
      agencyType: ''
    })
    this.initSelected()
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    /* 内容已清空 / 已保存：关闭返回询问 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
  },

  /* ---------- 代采 / 代售委托 ---------- */
  openAgency(e) {
    const t = e.currentTarget.dataset.type === 'sell' ? 'sell' : 'buy'
    this.enterAgency(t, '')
  },

  enterAgency(t, target) {
    this.setData({
      type: '',
      agencyType: t,
      agencyResubmitId: '',
      /* 交易方式必须与服务端 TRADE_MODES 枚举一致：代采为「求购 / 租赁」，代售为「出售 / 出租」 */
      agencyMode: t === 'buy' ? '求购' : '出售',
      agencyModeOptions: t === 'buy' ? ['求购', '租赁'] : ['出售', '出租'],
      agencyRent: false,
      agencyDeadline: dateStr(30),
      agencyDeadlineMin: dateStr(1),
      agencyDeadlineMax: dateStr(365),
      agencySubjectType: 'company',
      agencyForm: { item: target || '', qty: '', price: '', subject: '', creditCode: '', legal: '', idCard: '', phone: '', authPhone: '' },
      agencyTerm: '6 个月',
      agencyAgree: false,
      /* 代采 / 代售直接对接平台：不公开展示、不进商机池；设备只能从平台预设型号库选择 */
      agDeviceCols: deviceColumns([0, 0, 0, 0]).cols,
      agDeviceIndex: [0, 0, 0, 0],
      agDevicePath: '',
      agDeviceKeyword: '',
      agDeviceResults: [],
      agencyCat: '',
      agLicense: null,
      agProof: null,
      agLoi: null,
      agAuthorization: null,
      agIdcard: null,
      agOther: [],
      feeAmountText: '—',
      feeText: '0',
      feeLarge: false,
        feeDeferred: false,
      feeRule: '填写金额后自动试算',
      agencySubmitText: '填写金额后试算',
      agencySubmitTip: t === 'buy'
        ? '发布、审核、上架都不收费，成交后支付服务费；审核通过后客服通过预留手机号与你联系。'
        : '发布、审核、上架都不收费，成交后支付服务费；审核通过后开始代寻、撮合。',
      feeNote: t === 'buy'
        ? '代采委托直接对接平台，资料仅平台可见；审核通过后客服与你联系确认需求，成交后支付服务费。'
        : '代售委托直接对接平台，资料仅平台可见；审核通过后开始代寻、撮合，成交后支付服务费。'
    })
    this.setData({ navTitle: t === 'buy' ? '发起代采' : '发起代售' })
    this.resetAgencyCondFlow()
  },

  /* 被驳回委托的重新编辑：拉本人委托详情回填，材料沿用已上传文件，可逐项重传 */
  async loadAgencyResubmit(id) {
    if (!id) return
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const d = await request('user', 'agency.detail', { id }, { silent: false })
      if (!d) return
      const side = d.side === 'sell' ? 'sell' : 'buy'
      const rental = d.rental === true
      const media = Array.isArray(d.media) ? d.media : []
      const fileOf = (kind) => {
        const hit = media.filter((m) => m && m.kind === kind)[0]
        if (!hit) return null
        return {
          key: 'ag-' + kind,
          name: hit.name || '',
          path: '',
          fileId: hit.fileId || '',
          size: 0,
          sizeText: '已上传',
          type: 'image/jpeg'
        }
      }
      const others = media.filter((m) => m && m.kind === 'other').map((m, i) => ({
        key: 'ag-other-' + i,
        name: m.name || '补充材料',
        path: '',
        fileId: m.fileId || '',
        size: 0,
        sizeText: '已上传',
        type: 'image/jpeg'
      }))
      const item = String(d.item || '')
      /* 型号库里反查品牌 / 系列；目录外的历史型号只展示品类，输入框仍显示原型号 */
      let agDeviceCols = deviceColumns([0, 0, 0, 0]).cols
      let agDeviceIndex = [0, 0, 0, 0]
      let agDevicePath = String(d.cat || '')
      const hit = item ? this.deviceSearchIndex().filter((r) => r.model === item)[0] : null
      if (hit) {
        const next = deviceIndexOf(hit.cat, hit.brand, hit.model)
        agDeviceCols = next.cols
        agDeviceIndex = next.index
        agDevicePath = [next.cols[0][next.index[0]], next.cols[1][next.index[1]], next.cols[2][next.index[2]]]
          .filter(Boolean)
          .join(' · ')
      }
      const currency = d.currency || 'CNY'
      const currencyList = this.data.currencyOptions || []
      this.setData({
        agencyResubmitId: id,
        agencyType: side,
        agencyMode: d.mode || (side === 'buy' ? '求购' : '出售'),
        agencyModeOptions: side === 'buy' ? ['求购', '租赁'] : ['出售', '出租'],
        agencyRent: rental,
        agencyTerm: d.term || '6 个月',
        /* 回填原截止时间；已过期时留空，要求重新选择 */
        agencyDeadline: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || '')) && d.deadline >= dateStr(1) ? d.deadline : '',
        agencyDeadlineMin: dateStr(1),
        agencyDeadlineMax: dateStr(365),
        agencySubjectType: d.subjectType === 'person' ? 'person' : 'company',
        agencyForm: {
          item,
          qty: Number(d.qty) ? String(d.qty) : '',
          price: Number(d.price) ? String(d.price) : '',
          subject: d.subject || '',
          creditCode: d.creditCode || '',
          legal: d.legal || '',
          idCard: d.idCard || '',
          phone: d.phone || '',
          authPhone: d.authPhone || ''
        },
        currency,
        currencyIndex: Math.max(0, currencyList.findIndex((c) => c.code === currency)),
        agencyCat: d.cat || '',
        agDeviceKeyword: item,
        agDeviceResults: [],
        agDeviceSearchOpen: false,
        agDevicePath,
        agDeviceCols,
        agDeviceIndex,
        agLicense: fileOf('license'),
        agProof: fileOf('proof'),
        agLoi: fileOf('loi'),
        agAuthorization: fileOf('authorization'),
        agIdcard: fileOf('idcard'),
        agOther: others,
        navTitle: side === 'buy' ? '重新提交代采' : '重新提交代售'
      })
      /* 条件与流程：预设项合并原选择，自定义项原样保留 */
      const condSide = sideOf(side, rental)
      const presets = M.COND_PRESETS
      const flow = (Array.isArray(d.flow) ? d.flow : []).map((text, i) => {
        const s = String(text || '')
        const k = s.indexOf('：')
        return {
          id: 'as' + (i + 1),
          n: k > -1 ? s.slice(0, k) : s,
          d: k > -1 ? s.slice(k + 1) : ''
        }
      })
      this.setData({
        agencyCondSide: condSide,
        agencyMustTitle: SIDE_TITLE[condSide].must,
        agencyNegoTitle: SIDE_TITLE[condSide].nego,
        agencyFlowTitle: '交易流程',
        agencyMustOpts: mergeOptions(presets[condSide] || [], d.must || []),
        agencyNegoOpts: mergeOptions((rental ? presets.negoRent : presets.nego) || [], d.nego || []),
        agencyFlow: flow,
        agencyStepSeq: flow.length
      })
      this.calcFee()
    } catch (err) {
      /* request 已按错误码提示（委托不存在 / 非本人 / 状态已变化） */
    } finally {
      wx.hideLoading()
    }
  },

  pickCurrency(e) {
    const idx = Number(e.detail.value) || 0
    const opts = this.data.currencyOptions || []
    const c = opts[Math.min(idx, opts.length - 1)] || opts[0]
    this.setData({ currency: c.code, currencyIndex: idx })
  },

  /* 截止时间（必填）：最早明天 */
  pickAgencyDeadline(e) {
    this.setData({ agencyDeadline: e.detail.value || '' })
  },

  pickAgencySubject(e) {
    const v = e.currentTarget.dataset.v === 'person' ? 'person' : 'company'
    this.setData({ agencySubjectType: v })
  },

  closeAgency() {
    this.setData({ agencyType: '', agencyResubmitId: '', agencyRent: false, agencyAgree: false, agencyDeadline: '' })
    this.syncTitle()
  },

  /* 提交委托后直达「我的委托」，让用户立即看到进度时间线 */
  goMineAgency() {
    this.setData({ agencyType: '', agencyResubmitId: '', agencyRent: false, agencyAgree: false })
    try {
      const app = getApp()
      if (app && app.globalData) {
        app.globalData.mineView = 'agency'
        app.globalData.mineDirty = true
      }
    } catch (e) {}
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  pickAgencyMode(e) {
    const v = String(e.currentTarget.dataset.v || '')
    if (!v) return
    const agencyRent = v === '租赁' || v === '出租'
    this.setData({ agencyMode: v, agencyRent })
    /* 买卖与租赁的侧别不同，条件预设与流程文案要跟着换 */
    this.resetAgencyCondFlow()
    this.calcFee()
  },

  /* 代采 / 代售的条件与流程：侧别由委托类型 + 买卖 / 租赁决定 */
  resetAgencyCondFlow() {
    const side = sideOf(this.data.agencyType, this.data.agencyRent)
    const t = SIDE_TITLE[side]
    const presets = M.COND_PRESETS
    this.setData({
      agencyCondSide: side,
      agencyMustTitle: t.must,
      agencyNegoTitle: t.nego,
      agencyFlowTitle: '交易流程',
      agencyMustOpts: (presets[side] || []).map((v) => ({ v, on: false })),
      agencyNegoOpts: ((this.data.agencyRent ? presets.negoRent : presets.nego) || []).map((v) => ({ v, on: false })),
      agencyFlow: [],
      agencyStepSeq: 0,
      agencyMustInput: '',
      agencyNegoInput: '',
      agencyStepName: '',
      agencyStepDesc: ''
    })
  },

  pickAgencyCond(e) {
    const kind = e.currentTarget.dataset.kind
    const val = e.currentTarget.dataset.v
    const key = kind === 'must' ? 'agencyMustOpts' : 'agencyNegoOpts'
    const opts = this.data[key].map((o) => (o.v === val ? Object.assign({}, o, { on: !o.on }) : o))
    this.setData({ [key]: opts })
  },

  onAgencyCondInput(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData(kind === 'must' ? { agencyMustInput: e.detail.value } : { agencyNegoInput: e.detail.value })
  },

  addAgencyCond(e) {
    const kind = e.currentTarget.dataset.kind
    const key = kind === 'must' ? 'agencyMustOpts' : 'agencyNegoOpts'
    const inputKey = kind === 'must' ? 'agencyMustInput' : 'agencyNegoInput'
    const val = String(this.data[inputKey] || '').trim()
    if (!val) {
      wx.showToast({ title: '请先输入条件内容', icon: 'none' })
      return
    }
    if (this.data[key].some((o) => o.v === val)) {
      wx.showToast({ title: '该条件已存在', icon: 'none' })
      return
    }
    this.setData({ [key]: this.data[key].concat([{ v: val, on: true }]), [inputKey]: '' })
  },

  onAgencyStepInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    const k = e.currentTarget.dataset.k
    const flow = this.data.agencyFlow.slice()
    flow[i] = Object.assign({}, flow[i], { [k]: e.detail.value })
    this.setData({ agencyFlow: flow })
  },

  onAgencyStepDraft(e) {
    const k = e.currentTarget.dataset.k
    this.setData(k === 'name' ? { agencyStepName: e.detail.value } : { agencyStepDesc: e.detail.value })
  },

  addAgencyStep() {
    const n = String(this.data.agencyStepName || '').trim()
    const d = String(this.data.agencyStepDesc || '').trim()
    if (!n) {
      wx.showToast({ title: '请填写步骤名称', icon: 'none' })
      return
    }
    const seq = this.data.agencyStepSeq + 1
    this.setData({
      agencyFlow: this.data.agencyFlow.concat([{ id: 'as' + seq, n, d }]),
      agencyStepSeq: seq,
      agencyStepName: '',
      agencyStepDesc: ''
    })
  },

  removeAgencyStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const flow = this.data.agencyFlow.slice()
    flow.splice(i, 1)
    this.setData({ agencyFlow: flow })
  },

  moveAgencyStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const j = e.currentTarget.dataset.dir === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= this.data.agencyFlow.length) return
    const flow = this.data.agencyFlow.slice()
    const tmp = flow[i]
    flow[i] = flow[j]
    flow[j] = tmp
    this.setData({ agencyFlow: flow })
  },

  pickAgencyTerm(e) {
    this.setData({ agencyTerm: String(e.currentTarget.dataset.v || '') })
  },

  onAgencyInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const form = Object.assign({}, this.data.agencyForm, { [key]: e.detail.value })
    this.setData({ agencyForm: form })
    if (key === 'qty' || key === 'price') this.calcFee()
  },

  /* 联系电话失焦归一化：粘贴的 +86 / 空格 / 短横线统一成纯数字（座机也保留） */
  onAgencyPhoneBlur(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const raw = String((e.detail && e.detail.value) || '')
    const val = normalizePhone(raw)
    if (val && val !== raw && isValidContactPhone(val)) {
      const form = Object.assign({}, this.data.agencyForm, { [key]: val })
      this.setData({ agencyForm: form })
    }
  },

  /* 按「数量 × 单价」算交易金额，再按档位试算服务费；租赁取首月租金合计后按 50% 计 */
  calcFee() {
    const f = this.data.agencyForm
    const qty = Number(f.qty) || 0
    const price = Number(String(f.price || '').replace(/,/g, '')) || 0
    const amount = qty > 0 && price > 0 ? qty * price : 0
    const res = agencyFee(amount, this.data.agencyRent, this.data.agencyType)
    let submitText = '填写金额后试算'
    /* 代采 / 代售统一后付费：发布、审核、上架都不收费，成交后再支付服务费 */
    let submitTip = '发布、审核、上架都不收费，成交后支付服务费。'
    if (amount > 0) {
      if (this.data.agencyRent) {
        submitText = '提交审核'
        submitTip = '审核通过后即上架；成交后支付半个月租金（服务费为一个月租金，买卖双方各承担 50%）。'
      } else if (res.largeAmount) {
        submitText = '提交资料核验 · 成交后付费'
        submitTip = this.data.agencyType === 'buy'
          ? '大额代采订单只对平台可见。提交后核验资料，通过后由坐席代为寻源；成交后按 0.5% 支付服务费。'
          : '大额代售审核通过后上架；成交后按 0.5% 支付服务费。'
      } else if (this.data.agencyType === 'buy') {
        submitText = '提交审核'
        submitTip = '审核通过后客服将在 1 个工作日内通过预留手机号与你联系；成交后支付服务费。'
      } else {
        submitText = '提交审核'
        submitTip = '审核通过后即上架；成交后支付服务费。'
      }
    }
    this.setData({
      feeAmountText: amount > 0 ? fmtMoney(amount) : '—',
      feeText: fmtMoney(res.fee),
      feeLarge: res.largeAmount === true,
        feeDeferred: res.deferredFee === true,
      feeRule: res.rule || '填写金额后自动试算',
      feeNote: this.data.agencyType === 'buy'
        ? '发布、审核、上架都不收费，成交后支付服务费；客服会通过预留手机号与你联系确认需求。'
        : '发布、审核、上架都不收费；审核通过后开始代寻、撮合，成交后支付服务费。',
      agencySubmitText: submitText,
      agencySubmitTip: submitTip
    })
  },

  chooseAgencyFile(e) {
    const kind = e.currentTarget.dataset.kind || 'license'
    if (kind === 'other' && this.data.agOther.length >= 3) {
      wx.showToast({ title: '补充材料最多 3 张', icon: 'none' })
      return
    }
    const pick = async (res) => {
      const files = (res && res.tempFiles) ||
        ((res && res.tempFilePaths) || []).map((p) => ({ tempFilePath: p }))
      const file = files[0]
      if (!file) return
      const size = Number(file.size) || 0
      if (size > MEDIA_MAX_BYTES.image) {
        wx.showToast({ title: MEDIA_SIZE_TEXT.image, icon: 'none' })
        return
      }
      const labelMap = {
        license: '营业执照',
        proof: this.data.agencyType === 'buy' ? '资金 / 验资证明' : '货源 / 产权证明',
        loi: '采购意向函',
        authorization: '委托授权书',
        idcard: '联系人身份证'
      }
      const fallback = labelMap[kind] || ('补充材料 ' + (this.data.agOther.length + 1))
      /* 选中即上传：管理端审核时直接看到原件，而不是只有文件名 */
      let fileId = ''
      if (file.tempFilePath) {
        wx.showLoading({ title: '上传中', mask: true })
        try {
          fileId = await uploadFile(file.tempFilePath, {
            cloudPath: 'agency/' + kind + '/' + Date.now() + '.jpg'
          })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
          return
        }
        wx.hideLoading()
      }
      const item = {
        key: 'ag' + Date.now(),
        name: fallback,
        path: file.tempFilePath || '',
        fileId,
        size,
        sizeText: fmtSize(size),
        type: 'image/jpeg'
      }
      if (kind === 'license') this.setData({ agLicense: item })
      else if (kind === 'proof') this.setData({ agProof: item })
      else if (kind === 'loi') this.setData({ agLoi: item })
      else if (kind === 'authorization') this.setData({ agAuthorization: item })
      else if (kind === 'idcard') this.setData({ agIdcard: item })
      else this.setData({ agOther: this.data.agOther.concat(item) })
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], success: pick })
    } else {
      wx.chooseImage({ count: 1, success: pick })
    }
  },

  removeAgencyFile(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === 'license') {
      this.setData({ agLicense: null })
      return
    }
    if (kind === 'proof') {
      this.setData({ agProof: null })
      return
    }
    const singles = { loi: 'agLoi', authorization: 'agAuthorization', idcard: 'agIdcard' }
    if (singles[kind]) {
      this.setData({ [singles[kind]]: null })
      return
    }
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.agOther.slice()
    list.splice(i, 1)
    this.setData({ agOther: list })
  },

  toggleAgencyAgree() {
    this.setData({ agencyAgree: !this.data.agencyAgree })
  },

  async submitAgency() {
    if (this.submitting) return
    const f = this.data.agencyForm
    const err = (t) => wx.showToast({ title: t, icon: 'none' })
    const isBuy = this.data.agencyType === 'buy'
    const qty = Number(f.qty) || 0
    const price = Number(String(f.price || '').replace(/,/g, '')) || 0

    const isCompany = this.data.agencySubjectType === 'company'
    if (!String(f.item || '').trim()) return err('请从平台预设型号库选择设备')
    if (!(qty > 0)) return err('请填写数量')
    if (!(price > 0)) return err(this.data.agencyRent ? '请填写月租金' : (isBuy ? '请填写采购预算' : '请填写期望售价'))
    /* 截止时间必填，最早明天：到期仍未成交则委托自动停止 */
    const deadline = String(this.data.agencyDeadline || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return err('请选择截止时间')
    if (deadline < dateStr(1)) return err('截止时间最早为明天')
    if (isCompany) {
      if (!String(f.subject || '').trim()) return err('请填写企业名称')
      if (!/^[0-9A-Za-z]{18}$/.test(String(f.creditCode || '').trim())) return err('请填写 18 位统一社会信用代码')
      if (!String(f.legal || '').trim()) return err('请填写法定代表人')
      if (!this.data.agLicense) return err('请上传营业执照')
    } else {
      if (!String(f.subject || '').trim()) return err('请填写姓名')
      if (!/^\d{17}[\dXx]$/.test(String(f.idCard || '').trim())) return err('请填写 18 位身份证号')
    }
    /* 联系电话先归一化（去空格 / 短横线 / +86 前缀）再校验：
       手机、座机、400 都允许，只拦空值和带 * 的脱敏号码 */
    const phone = normalizePhone(String(f.phone || ''))
    const authPhone = normalizePhone(String(f.authPhone || ''))
    if (phone !== String(f.phone || '') || authPhone !== String(f.authPhone || '')) {
      this.setData({ agencyForm: Object.assign({}, f, { phone, authPhone }) })
    }
    if (!isValidContactPhone(phone)) return err('联系人电话：' + contactPhoneError(String(f.phone || '')))
    /* 代采 / 代售直接对接平台：委托授权书、被委托人身份证、授权书联系人电话必传 */
    if (!this.data.agAuthorization) return err('请上传委托授权书')
    if (!this.data.agIdcard) return err('请上传被委托人身份证')
    if (!isValidContactPhone(authPhone)) return err('授权书联系人电话：' + contactPhoneError(String(f.authPhone || '')))
    /* 授权书联系人与预留手机号是否一致，交给客服在审核环节核验，提交时不拦截 */
    /* 1000 万元及以上：代采补采购意向函，代售补货源证明 */
    const largeAmount = this.data.feeLarge === true
    if (largeAmount) {
      if (isBuy) {
        if (!this.data.agLoi) return err('请上传采购意向函')
      } else if (!this.data.agProof) {
        return err('请上传货源证明')
      }
    }
    if (!this.data.agencyAgree) return err('请先阅读并勾选服务费规则')

    /* 代采 / 代售也是对外发布：提交前先确认主体信息与联系方式齐全 */
    if (!(await ensureProfileReady())) return

    const fee = Number(String(this.data.feeText).replace(/,/g, '')) || 0
    /* 与「发布商品」的更多要求同口径：勾选的条件 + 自定义条件，流程按步骤顺序提交 */
    const must = this.data.agencyMustOpts.filter((o) => o.on).map((o) => o.v)
    const nego = this.data.agencyNegoOpts.filter((o) => o.on).map((o) => o.v)
    const flow = this.data.agencyFlow.map((s) => (s.d ? s.n + '：' + s.d : s.n))
    this.submitting = true
    const payload = {
      /* 被驳回的委托：带原委托 id 重新提交，服务端原地覆盖并重新排队审核 */
      id: this.data.agencyResubmitId || undefined,
      side: isBuy ? 'buy' : 'sell',
      mode: this.data.agencyMode,
      rental: this.data.agencyRent,
      term: this.data.agencyRent ? this.data.agencyTerm : '',
      /* 代采 / 代售直接对接平台：可见范围与发布渠道不开放选择，由服务端统一处理 */
      item: String(f.item || '').trim(),
      cat: String(this.data.agencyCat || ''),
      qty,
      price,
      currency: this.data.currency || 'CNY',
      amount: qty * price,
      /* 截止时间：到点仍未成交即停止，代采合同以该时间为准 */
      deadline,
      /* 交易流程 / 必要条件 / 可协商条件：逐项添加后提交，全部选填 */
      flow,
      must,
      nego,
      subjectType: isCompany ? 'company' : 'person',
      subject: String(f.subject || '').trim(),
      creditCode: isCompany ? String(f.creditCode || '').trim() : '',
      legal: isCompany ? String(f.legal || '').trim() : '',
      idCard: isCompany ? '' : String(f.idCard || '').trim(),
      phone,
      authPhone,
      serviceFee: fee,
      /* 后付费：发布时 payAmount 恒为 0，成交后再付服务费 */
      payAmount: 0,
      /* 只提交已上传的材料，未上传项不占位；fileId 供管理端直接预览原件 */
      media: [
        this.data.agLicense && { name: this.data.agLicense.name, kind: 'license', fileId: this.data.agLicense.fileId || '' },
        this.data.agProof && { name: this.data.agProof.name, kind: 'proof', fileId: this.data.agProof.fileId || '' },
        this.data.agLoi && { name: this.data.agLoi.name, kind: 'loi', fileId: this.data.agLoi.fileId || '' },
        this.data.agAuthorization && { name: this.data.agAuthorization.name, kind: 'authorization', fileId: this.data.agAuthorization.fileId || '' },
        this.data.agIdcard && { name: this.data.agIdcard.name, kind: 'idcard', fileId: this.data.agIdcard.fileId || '' }
      ].filter(Boolean).concat(this.data.agOther.map((m) => ({ name: m.name, kind: 'other', fileId: m.fileId || '' })))
    }
    /* 必须等云端落库成功再提示：接口失败时明确报错，不能假装「已提交」 */
    try {
      await request('user', 'agency.submit', payload, { silent: false })
      /* 后付费：提交后进入审核，审核通过即上架，成交后支付服务费 */
      const resubmit = !!this.data.agencyResubmitId
      wx.showModal({
        title: resubmit ? '已重新提交' : '已提交，等待审核',
        content: resubmit
          ? '已按退回原因修改并重新提交，将在 1 个工作日内重新审核，结果通过站内信通知。\n进度可在「我的 - 我的委托」查看。'
          : (this.data.agencyRent
            ? '你的租赁委托已提交，将在 1 个工作日内完成审核。\n审核通过后即上架；成交后支付半个月租金（服务费为一个月租金，买卖双方各承担 50%）。\n进度可在「我的 - 我的委托」查看，审核前可随时撤销。'
            : (largeAmount
              ? (isBuy
                ? '本单代采金额达到 1000 万元，成交后按 0.5% 支付服务费，订单只对平台可见。\n将在 1 个工作日内完成审核，通过后客服通过预留手机号与你联系，核对采购意向函、委托授权书与联系人信息。'
                : '本单代售金额达到 1000 万元，成交后按 0.5% 支付服务费。\n客服将在 1 个工作日内核对营业执照、货源证明、委托授权书与联系人信息，通过后上架。')
              : (isBuy
                ? '你的代采委托已提交，将在 1 个工作日内完成审核。\n审核通过后客服联系你确认需求；成交后支付服务费。\n进度可在「我的 - 我的委托」查看，审核前可随时撤销。'
                : '你的代售委托已提交，将在 1 个工作日内完成审核。\n审核通过后即上架，成交后支付服务费。\n进度可在「我的 - 我的委托」查看，审核前可随时撤销。'))),
        showCancel: false,
        confirmText: '查看进度',
        success: () => this.goMineAgency()
      })
      return
    } catch (err) {
      /* request 已按错误码提示（字段不合规 / 同时进行委托超限），留在当前页修改 */
    } finally {
      this.submitting = false
    }
  },

  noop() {},

  /* ---------- 入口页跳转 ---------- */
  goSell() {
    /* 商品默认实名公开：内容进列表，展示发布者身份 */
    this.setData({ type: 'sell', mode: '出售', privatePublish: false })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    /* 入口卡片不经过 onLoad / onShow，必须在这里主动取一次主体信息 */
    this.loadProfileSubject()
    this.syncLeaveGuard()
  },

  goBuy() {
    this.setData({ type: 'buy', mode: '求购', privatePublish: false })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    this.loadProfileSubject()
    this.syncLeaveGuard()
  },

  goBack() {
    this.setData({ type: '', mode: '' })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    /* 回到选类型入口页：这里没有可保存的表单，不能再弹「存草稿」 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
  },

  /* 自定义导航返回：在某个发布表单里未发布退出时，先回「发布类型选择」；
     编辑模式回「我发布的」，只有在入口页退出才真正离开发布页 */
  onNavBack() {
    if (this.data.editing) return this.backToMine()
    if (this.data.agencyType) return this.closeAgency()
    if (this.data.type) return this.goBack()
    const pages = getCurrentPages() || []
    if (pages.length > 1) return wx.navigateBack()
    wx.switchTab({ url: '/pages/home/home' })
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode })
    this.checkRent()
    this.syncTitle()
    this.resetCondFlow()
  }
})
