/* 咨询页：标的对照 + 必须条件确认 + 13 项信息填写 + 补充材料 */
const { gate, readUser } = require('../../utils/auth')
const guard = require('../../utils/guard')
const { SUBJECT_NOTICE } = require('../../utils/privacy')
const M = require('../../utils/mock')
const shop = require('../../utils/shop')
const { request } = require('../../utils/request')
const { normalizePhone, isValidPhone, phoneError } = require('../../utils/validate')

/* 上传材料的缩略图水印：指向当前账号与昵称，便于泄漏追责 */
function uploadMark() {
  return guard.accountMark()
}

/* 补充材料上限：图片 5 张 / 视频 3 段；与后端 shared/constants.js 同口径 */
const MEDIA_LIMIT = { image: 5, video: 3 }
const MEDIA_MAX_BYTES = { image: 10 * 1024 * 1024, doc: 20 * 1024 * 1024, video: 50 * 1024 * 1024 }
const MEDIA_SIZE_TEXT = { image: '单张图片不能超过 10MB', doc: '单个文件不能超过 20MB', video: '单段视频不能超过 50MB' }
const MEDIA_MAX_NAME_LEN = 30

function fmtSize(n) {
  const size = Number(n) || 0
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  if (size >= 1024) return Math.round(size / 1024) + ' KB'
  return size + ' B'
}

/* 按临时文件扩展名识别真实媒体类型：iPhone 拍摄的 MOV / M4V 不再统一标成 MP4 */
function mediaType(kind, filePath) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String(filePath || ''))
  const ext = (m ? m[1] : '').toLowerCase()
  if (kind === 'image') {
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    return 'image/jpeg'
  }
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'm4v') return 'video/x-m4v'
  return 'video/mp4'
}

/* 返回上一页：按进入顺序退回；栈只有一层（冷启动 / 分享直达）时回落首页 tab */
function safeBack() {
  const pages = getCurrentPages() || []
  if (pages.length > 1) {
    wx.navigateBack()
    return
  }
  wx.switchTab({ url: '/pages/home/home' })
}

/* ---------- 字段构造 ---------- */
function F(key, label, req, type, extra) {
  return Object.assign({
    key,
    label,
    req: !!req,
    type,
    value: '',
    ph: '',
    multi: false,
    opts: [],
    tip: ''
  }, extra || {})
}

function chips(key, label, req, list, multi, extra) {
  return F(key, label, req, 'chips', Object.assign({
    multi: !!multi,
    opts: list.map((l) => ({ label: l, on: false }))
  }, extra || {}))
}

/* 微信已授权手机号：直接展示脱敏值，不再手填；服务端按本人号码兜底 */
function wechatPhoneMasked() {
  const u = readUser() || {}
  return u.hasPhone ? (u.phoneMasked || '已授权微信手机号') : ''
}

/* 主体类型必填；手机号优先用微信授权，未授权时才手填 */
const CONTACT_SECTION = () => {
  const masked = wechatPhoneMasked()
  return {
    title: '主体与联系人',
    note: masked ? '手机号已用微信授权' : '手机号仅平台坐席可见',
    tip: SUBJECT_NOTICE,
    fields: [
      chips('strong', '主体类型', true, ['个人', '个体户', '国央企', '央企', '国企', '上市公司', '民企', '外企', '合资企业', '合伙企业', '事业单位', '政府机关', '社会团体', '其他'], false),
      F('subject', '单位 / 主体名称', false, 'text', { ph: '如：杭州云帆数据科技有限公司（选填）' }),
      masked
        ? F('phone_info', '联系人手机号', false, 'info', { value: masked })
        : F('phone', '联系人手机号', true, 'phone', { ph: '11 位手机号，用于建企微群时邀请' })
    ]
  }
}

const NOTE_SECTION = (ph) => ({
  title: '补充说明',
  note: '选填',
  fields: [F('note', '其他说明', false, 'textarea', { ph })]
})

/* 出售商品咨询：型号等规格只读，只填采购条件；成色、付款方式、试用支持等由卖家在发布时设置，咨询方不填 */
function sellSections(p) {
  return [
    {
      title: '需求信息',
      note: '采购条件',
      fields: [
        F('qty', '采购数量（台）', true, 'number', { value: String(p.minQty || 1), ph: '如 8' }),
        F('budget', '预算（元 / 台）', true, 'text', { ph: '如 240,000' }),
        chips('tax', '税费要求', true, ['必须含税', '可开专票', '不含税'], true),
        chips('deliver', '期望交付时间', true, ['3 天内', '7 天内', '30 天内', '不限'], false)
      ]
    },
    NOTE_SECTION('补充条件，如分批交付、发票类型等'),
    CONTACT_SECTION()
  ]
}

/* 出租商品咨询：租期、租金预算与条款接受度 */
function rentSections(p) {
  return [
    {
      title: '承租信息',
      note: '租期与租金条件',
      fields: [
        F('qty', '承租数量（台）', true, 'number', { value: String(p.minQty || 1), ph: '如 8' }),
        F('rent_budget', '月租金预算（元 / 台 / 月）', true, 'text', { ph: '如 16,000' }),
        chips('term', '期望租期', true, ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议'], true),
        chips('closed', '是否接受闭口价', true, ['接受闭口价', '只接受可议价'], false),
        chips('deposit', '押金接受度', true, ['接受免押', '接受 1 个月租金', '接受 2 个月租金', '可议'], true),
        chips('pay', '期望支付方式', true, ['月付', '季付', '半年付', '年付'], false),
        chips('tax', '税费要求', true, ['必须含税', '可开专票', '不含税'], true),
        chips('deliver', '期望起租时间', true, ['3 天内', '7 天内', '30 天内', '不限'], false)
      ]
    },
    {
      title: '租赁条款接受',
      note: '须逐条选择接受',
      fields: [
        chips('rent_agree', '签署租赁意向协议', true, ['接受签署租赁意向协议', '不接受'], false),
        chips('rent_prepay', '按期预付租金', true, ['接受按期预付租金', '不接受'], false),
        chips('rent_usage', '用途合规', true, ['承诺用途仅限训练 / 推理等合规业务', '不接受'], false),
        chips('rent_nosub', '不转租', true, ['承诺不转租、不二次转让', '不接受'], false)
      ]
    },
    NOTE_SECTION('补充条件，如接入方式、试租期等'),
    CONTACT_SECTION()
  ]
}

/* 响应求购需求：直接确认需求方必须条件并填写供给信息，不要求绑定在售商品 */
function demandSellSections(d) {
  return [
    {
      title: '供给信息',
      note: '需求方关心的必填项',
      fields: [
        chips('supply', '供给类型', true, ['现货', '期货'], false),
        F('qty', '可供数量（台）', true, 'number', { ph: '如 8' }),
        F('price', '报价（元 / 台）', true, 'text', { ph: '如 240,000' }),
        chips('city_accept', '交易地点', true, ['接受（' + d.city + '）', '不接受'], false),
        chips('cond', '成色', true, ['全新', '二手', '拆机件'], true),
        chips('tax', '税费', true, ['含税', '不含税', '可开专票'], true),
        chips('deliver', '可交付时间', true, ['3 天内', '7 天内', '30 天内'], false),
        chips('accept', '同台互验', true, ['接受同台互验', '不接受'], false),
        chips('code_yn', '暗语视频', true, ['能提供', '暂不能提供'], false, { tip: '协商后按约定录制' }),
        chips('regulate', '资金监管账户', false, ['支持', '不支持'], false, { tip: '期货需求建议填写' }),
        chips('dc_info', '是否需要实际使用机房信息', true, ['需要', '不需要'], false, { tip: '是否需要向需求方提供实际使用机房的相关信息' })
      ]
    },
    NOTE_SECTION('如分批交付、质保、序列号清单等'),
    CONTACT_SECTION()
  ]
}

/* 响应租赁需求：租期、租金、押金与租赁条款承诺 */
function demandRentSections(d) {
  return [
    {
      title: '出租信息',
      note: '承租方关心的必填项',
      fields: [
        chips('supply', '供给状态', true, ['现货', '期货'], false),
        F('qty', '可租数量（台）', true, 'number', { ph: '如 8' }),
        F('rent', '月租金报价（元 / 台 / 月）', true, 'text', { ph: '如 18,000' }),
        chips('term', '可提供的租期', true, ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议'], true),
        chips('closed', '是否闭口价', true, ['闭口价（不议价）', '开口价（可议价）'], false),
        chips('deposit', '押金', true, ['免押金', '1 个月租金', '2 个月租金', '可议'], false),
        chips('pay', '租金支付方式', true, ['月付', '季付', '半年付', '年付'], false),
        F('rent_terms', '租金 / 租期 / 押金条款', true, 'text', { ph: '如：月租 18,000 元，6 个月起租，押 1 个月租金' }),
        chips('tax', '税费', true, ['含税', '不含税', '可开专票'], true),
        chips('deliver', '可起租时间', true, ['当日可起租', '3 天内', '7 天内', '30 天内'], false),
        chips('accept', '同台互验', true, ['接受同台互验', '不接受'], false),
        chips('code_yn', '暗语视频', true, ['能提供', '暂不能提供'], false, { tip: '协商后按约定录制' }),
        chips('regulate', '租金资金监管账户', false, ['支持', '不支持'], false, { tip: '期货需求建议填写' }),
        chips('dc_info', '是否需要实际使用机房信息', true, ['需要', '不需要'], false, { tip: '是否需要向需求方提供实际使用机房的相关信息' })
      ]
    },
    {
      title: '租赁条款承诺',
      note: '须逐条选择接受',
      fields: [
        chips('rent_agree', '签署租赁意向协议', true, ['接受签署租赁意向协议', '不接受'], false),
        chips('rent_prepay', '按期预付租金', true, ['接受按期预付租金', '不接受'], false),
        chips('rent_usage', '用途合规', true, ['承诺用途仅限训练 / 推理等合规业务', '不接受'], false),
        chips('rent_nosub', '不转租', true, ['承诺不转租、不二次转让', '不接受'], false)
      ]
    },
    NOTE_SECTION('如接入方式、带宽、试租期等'),
    CONTACT_SECTION()
  ]
}

/* 统计已填写项：文本有值 / chips 至少选中一项 */
function countFilled(sections) {
  let n = 0
  sections.forEach((sec) => {
    sec.fields.forEach((f) => {
      if (f.type === 'chips') {
        if (f.opts.some((o) => o.on)) n++
      } else if (String(f.value || '').trim()) {
        n++
      }
    })
  })
  return n
}

/* 首个未填的必填项 */
function firstMissing(sections) {
  let miss = null
  sections.forEach((sec) => {
    if (miss) return
    sec.fields.forEach((f) => {
      if (miss || !f.req) return
      if (f.type === 'chips') {
        if (!f.opts.some((o) => o.on)) miss = f
      } else if (!String(f.value || '').trim()) {
        miss = f
      }
    })
  })
  return miss
}

Page({
  data: {
    productId: '',
    product: null,
    isRent: false,
    isDemand: false,
    topTip: '',
    sections: [],
    total: 0,
    /* 补充材料：图片与视频分开管理，各自计数与限大小 */
    imgList: [],
    videoList: [],
    mediaSeq: 0,
    filled: 0,
    /* 发布方设定的条件与流程：原样展示 */
    mustList: [],
    negoList: [],
    flow: [],
    condMet: 0,
    condTotal: 0,
    condUnmet: 0,
    condPass: false,
    /* 自己的发布不能咨询 / 响应（防止绕过详情页直接打开本页） */
    isMine: false,
    /* 标的已下架 / 不存在：显示失效态，不渲染空表单 */
    missing: false,
    /* 提交中：避免重复点击产生两条线索 */
    submitting: false
  },

  onLoad(options) {
    const opts = options || {}
    const isDemand = opts.type === 'demand'
    const id = String(opts.id || '')
    this.targetId = id
    this.isDemandTarget = isDemand
    /* 没有标的 id 说明链接不完整：直接返回，绝不拿演示数据顶替成别人的标的 */
    if (!id) {
      wx.showToast({ title: '咨询链接已失效，请从详情页进入', icon: 'none' })
      setTimeout(safeBack, 800)
      return
    }
    /* 先渲染本地演示数据，云端数据到达后覆盖 */
    this.applyTarget(isDemand ? this.buildDemandTarget(id) : M.productById(id))
    this.loadRemote(id, isDemand)
  },

  /* 云端标的：商品 / 需求的最新发布方条件与流程 */
  async loadRemote(id, isDemand) {
    try {
      const doc = isDemand
        ? await request('user', 'demand.detail', { id }, { silent: true })
        : await request('user', 'product.detail', { id }, { silent: true })
      /* 响应里没有 id 说明标的不可见（已下架 / 已关闭）：进入失效态 */
      if (!doc || !doc.id) {
        this.markMissing()
        return
      }
      const view = isDemand ? this.buildDemandTarget(id, shop.toDemand(doc)) : shop.toProduct(doc)
      this.applyTarget(view)
    } catch (e) {
      /* 云端不可用：本地有演示数据就继续，否则显示失效态，不渲染空表单 */
      this.markMissing()
    }
  },

  /* 本地与云端都没有该标的：说明已下架，而不是换一件商品继续咨询 */
  markMissing() {
    if (this.data.product) return
    this.setData({ missing: true })
  },

  /* 按标的重算表单与条件（云端 / 本地共用同一套渲染逻辑） */
  applyTarget(product) {
    if (!product) return
    const isDemand = this.isDemandTarget
    const isRent = !!product.isRent
    const isMine = !!product.mine
    /* 必须条件：云端后到时按条件文本沿用用户已确认的选项，不重置勾选 */
    const mustList = (product.must || []).map((t) => {
      const prev = (this.data.mustList || []).filter((c) => c.t === t)[0]
      return { t, state: (prev && prev.state) || '' }
    })
    const negoList = (product.nego || []).slice()
    const flow = (product.flow || []).slice()
    const condTotal = mustList.length
    const condMet = mustList.filter((c) => c.state === 'yes').length

    /* 用户已经开始填写：保留已填内容，只刷新标的与条件，避免云端数据到达时清空表单 */
    const sections = this.formDirty && this.data.sections.length
      ? this.data.sections
      : (!isDemand
        ? (isRent ? rentSections(product) : sellSections(product))
        : (isRent ? demandRentSections(product) : demandSellSections(product)))

    wx.setNavigationBarTitle({
      title: isDemand
        ? (isRent ? '填写出租信息' : '填写供给信息')
        : (isRent ? '填写承租信息' : '填写咨询信息')
    })

    this.setData({
      productId: this.targetId,
      product,
      isRent,
      isDemand,
      isMine,
      topTip: isMine
        ? (isDemand
          ? '这是你自己发布的需求，不能响应。请等待其他供给方响应后由平台对接。'
          : '这是你自己发布的商品，不能咨询。可返回详情页查看咨询情况。')
        : (isDemand
          ? '请对照需求方的必须条件逐项确认，并填写供给信息。平台核对后联系双方。'
          : (isRent
            ? '设备留在出租方机房、你方远程接入使用，不涉及实物交付与成色。填写租期、租金预算与条款接受情况。'
            : '你填写的信息越完整，平台越能优先把你对接给合适的货主。必须条件未满足时无法提交。')),
      sections,
      total: sections.reduce((s, sec) => s + sec.fields.length, 0),
      mustList,
      negoList,
      flow,
      condTotal,
      condMet,
      condUnmet: condTotal - condMet,
      missing: false,
      condPass: condTotal > 0 ? condMet === condTotal : true,
      filled: countFilled(sections)
    })
  },

  // 求购 / 租赁需求转成可复用的咨询目标结构（条件与流程沿用发布方设定）
  buildDemandTarget(id, doc) {
    const d = doc || M.demandById(id)
    /* 需求已被删除 / 关闭：返回 null，由调用方进入失效态 */
    if (!d) return null
    return Object.assign({}, d, {
      priceText: d.budgetText,
      priceUnit: '以内',
      requirements: '响应需提供可承接数量、报价与可交付时间，主体资质由平台核对后转交发布方。',
      rentLimits: []
    })
  },

  /* 返回：页面栈只有一层（冷启动 / 分享直达）时回落首页 */
  back() {
    safeBack()
  },

  onShow() {
    gate(this.route || 'pages/consult/consult', this.options)
  },

  /* ---------- 表单输入 ---------- */
  onFieldInput(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const fi = Number(e.currentTarget.dataset.fi)
    const sections = this.data.sections.slice()
    const sec = Object.assign({}, sections[gi])
    /* 防御：section / field 下标越界（数据被裁剪或事件参数异常）时直接忽略本次输入 */
    if (!sec || !Array.isArray(sec.fields) || !sec.fields[fi]) return
    const fields = sec.fields.slice()
    fields[fi] = Object.assign({}, fields[fi], { value: e.detail.value })
    sec.fields = fields
    sections[gi] = sec
    /* 标记用户已开始填写：云端详情后到时不再重建表单，避免清空输入 */
    this.formDirty = true
    this.setData({ sections, filled: countFilled(sections) })
  },

  toggleChip(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const fi = Number(e.currentTarget.dataset.fi)
    const oi = Number(e.currentTarget.dataset.oi)
    const sections = this.data.sections.slice()
    const sec = Object.assign({}, sections[gi])
    if (!sec || !Array.isArray(sec.fields) || !sec.fields[fi]) return
    const fields = sec.fields.slice()
    const field = Object.assign({}, fields[fi])
    if (!Array.isArray(field.opts) || !field.opts[oi]) return
    const opts = field.opts.map((o, i) => {
      if (field.multi) {
        return i === oi ? Object.assign({}, o, { on: !o.on }) : o
      }
      return Object.assign({}, o, { on: i === oi ? !o.on : false })
    })
    field.opts = opts
    fields[fi] = field
    sec.fields = fields
    sections[gi] = sec
    this.formDirty = true
    this.setData({ sections, filled: countFilled(sections) })
  },

  /* ---------- 必须条件：逐项由咨询人自己确认 ---------- */
  setCond(e) {
    const i = Number(e.currentTarget.dataset.i)
    const state = e.currentTarget.dataset.val // yes / no
    const mustList = this.data.mustList.slice()
    /* 防御：条件下标越界时忽略 */
    if (!mustList[i]) return
    mustList[i] = Object.assign({}, mustList[i], { state: mustList[i].state === state ? '' : state })
    const condTotal = mustList.length
    const condMet = mustList.filter((c) => c.state === 'yes').length
    this.setData({
      mustList,
      condTotal,
      condMet,
      condUnmet: condTotal - condMet,
      condPass: condTotal > 0 ? condMet === condTotal : true
    })
  },

/* ---------- 材料 ---------- */
  /* 补充材料：图片 5 张 / 视频 3 段；大小上限按手机常规拍摄体量设定 */
  chooseImage() {
    const remain = MEDIA_LIMIT.image - this.data.imgList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 5 张图片', icon: 'none' })
      return
    }
    const mark = uploadMark()
    const pick = (res) => {
      /* chooseMedia 返回 tempFiles（含 size），chooseImage 只保证 tempFilePaths */
      const list = (res && res.tempFiles) || ((res && res.tempFilePaths) || []).map((p) => ({ tempFilePath: p }))
      if (!Array.isArray(list) || !list.length) return
      this.addFiles('image', list, mark)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['image'], success: pick })
    } else {
      wx.chooseImage({ count: remain, success: pick })
    }
  },

  chooseVideo() {
    const remain = MEDIA_LIMIT.video - this.data.videoList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 3 段视频', icon: 'none' })
      return
    }
    const mark = uploadMark()
    const pick = (res) => {
      const list = (res && res.tempFiles) ||
        ((res && res.tempFilePath) ? [{ tempFilePath: res.tempFilePath, size: res.size }] : [])
      if (!list.length) return
      this.addFiles('video', list, mark)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['video'], success: pick })
    } else {
      wx.chooseVideo({ maxDuration: 60, success: pick })
    }
  },

  /* 把本次选择并入列表：超限跳过并提示，避免一次性占满存储 */
  addFiles(kind, files, mark) {
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    const limit = MEDIA_LIMIT[kind]
    const maxBytes = MEDIA_MAX_BYTES[kind]
    let seq = this.data.mediaSeq
    let oversize = 0
    let overflow = 0
    let added = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {}
      const size = Number(f.size) || 0
      if (size > maxBytes) {
        oversize++
        continue
      }
      if (list.length >= limit) {
        overflow++
        continue
      }
      seq++
      list.push({
        key: 'm' + seq,
        name: (kind === 'image' ? '补充图片 ' : '补充视频 ') + seq,
        path: f.tempFilePath || '',
        size,
        sizeText: fmtSize(size),
        type: mediaType(kind, f.tempFilePath || ''),
        kind,
        wm: mark
      })
      added++
    }
    this.setData({ [listKey]: list, mediaSeq: seq })
    if (oversize) {
      wx.showToast({ title: '已跳过 ' + oversize + ' 个（' + MEDIA_SIZE_TEXT[kind] + '）', icon: 'none' })
    } else if (overflow) {
      wx.showToast({ title: '最多 ' + limit + (kind === 'image' ? ' 张图片' : ' 段视频'), icon: 'none' })
    } else if (added) {
      wx.showToast({ title: '已添加 ' + added + (kind === 'image' ? ' 张' : ' 段'), icon: 'none' })
    }
  },

  /* 自定义命名：文件叫什么由上传方决定，坐席能一眼认出是哪份材料 */
  renameFile(e) {
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

  removeFile(e) {
    const kind = e.currentTarget.dataset.kind
    const i = Number(e.currentTarget.dataset.i)
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    list.splice(i, 1)
    this.setData({ [listKey]: list })
  },

  /* ---------- 提交 ---------- */

  /* 汇总表单值：key → 已填内容 */
  collectValues() {
    const out = {}
    this.data.sections.forEach((sec) => {
      sec.fields.forEach((f) => {
        if (f.type === 'chips') {
          const on = f.opts.filter((o) => o.on).map((o) => o.label)
          if (on.length) out[f.key] = on.join(' / ')
        } else if (String(f.value || '').trim()) {
          out[f.key] = String(f.value).trim()
        }
      })
    })
    return out
  },

  /* 需求说明：给坐席看的客观摘要，可直接留联系方式（平台不拦截） */
  buildSummary(values) {
    const p = this.data.product || {}
    const parts = []
    if (values.qty) parts.push('数量 ' + values.qty + ' 台')
    if (values.budget) parts.push('预算 ' + values.budget + ' 元/台')
    if (values.rent_budget) parts.push('月租金预算 ' + values.rent_budget + ' 元/台/月')
    if (values.rent) parts.push('月租金报价 ' + values.rent + ' 元/台/月')
    if (values.price) parts.push('报价 ' + values.price + ' 元/台')
    if (values.tax) parts.push('税费 ' + values.tax)
    if (values.deliver) parts.push('交付 ' + values.deliver)
    if (values.city_accept) parts.push('交易地点 ' + values.city_accept)
    if (values.cond) parts.push('成色 ' + values.cond)
    if (values.term) parts.push('租期 ' + values.term)
    if (values.closed) parts.push('闭口价 ' + values.closed)
    if (values.deposit) parts.push('押金 ' + values.deposit)
    if (values.pay) parts.push('支付 ' + values.pay)
    if (values.supply) parts.push('供给 ' + values.supply)
    if (values.note) parts.push(values.note)
    if (!parts.length) parts.push('咨询「' + (p.title || '') + '」')
    return parts.join('；').slice(0, 200)
  },

  async submit() {
    if (this.data.isMine) {
      wx.showToast({
        title: this.data.isDemand ? '不能响应自己的需求' : '不能咨询自己的发布',
        icon: 'none'
      })
      return
    }
    if (this.submitting) return
    if (!this.data.condPass) {
      const rejected = this.data.mustList.filter((c) => c.state === 'no').length
      wx.showToast({
        title: rejected
          ? '有 ' + rejected + ' 项必须条件你不满足，无法提交'
          : '请逐项确认必须条件（还剩 ' + this.data.condUnmet + ' 项）',
        icon: 'none'
      })
      return
    }
    const miss = firstMissing(this.data.sections)
    if (miss) {
      wx.showToast({ title: '请填写「' + miss.label + '」', icon: 'none' })
      return
    }
    const values = this.collectValues()
    /* 手填才校验；已微信授权时 phone 留空，服务端按本人授权号码兜底 */
    const phoneInput = String(values.phone || '').trim()
    const phone = phoneInput ? normalizePhone(phoneInput) : ''
    if (phoneInput && !isValidPhone(phone)) {
      wx.showToast({ title: phoneError(phoneInput), icon: 'none' })
      return
    }

    /* 必须条件逐项上报：服务端只接受白名单条件，且要求全部 satisfied */
    const conds = this.data.mustList.map((c) => ({
      k: c.t,
      satisfied: c.state === 'yes',
      note: ''
    }))
    const payload = {
      phone,
      summary: this.buildSummary(values),
      conds,
      /* 补充材料：只上送元信息（名称 / 类型 / 大小 / 类别），文件本体另行上传 */
      media: this.data.imgList.concat(this.data.videoList).map((m) => ({
        name: m.name,
        type: m.type,
        size: m.size,
        kind: m.kind
      }))
    }
    if (this.data.isDemand) payload.demandId = this.targetId
    else payload.productId = this.targetId

    this.submitting = true
    this.setData({ submitting: true })
    let receipt = null
    try {
      receipt = await request('user', 'consult.submit', payload)
    } catch (err) {
      /* request 已按错误码提示（未实名 / 条件不满足 / 重复提交），留在当前页让用户修改 */
      this.submitting = false
      this.setData({ submitting: false })
      return
    }
    this.submitting = false
    this.setData({ submitting: false })

    /* 咨询成功：标记「我的」快照失效，返回后能立刻看到这条咨询 */
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.mineDirty = true
    } catch (e) {}

    /* 必须条件全部满足：后端已开通直聊，直接带用户进入独立对话页 */
    if (receipt && receipt.chatReady && receipt.threadId) {
      wx.showModal({
        title: '已开启对话',
        content: (receipt.receipt || '必须条件已满足，已为你开启与对方的会话。') +
          '可在对话中继续沟通，材料仅你与平台可见。',
        showCancel: false,
        confirmText: '去沟通',
        success: () => {
          wx.navigateTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(receipt.threadId) })
        }
      })
      return
    }

    wx.showModal({
      title: '已提交',
      content: (receipt && receipt.receipt)
        ? receipt.receipt
        : (this.data.isDemand
          ? '你的响应已提交。若匹配，后台客服会进行联系，请不要重复发起咨询。'
          : '咨询已提交。若匹配，后台客服会进行联系，请不要重复发起咨询。')
        + '材料仅你与平台可见，预览时会叠加你的账号与昵称水印。',
      showCancel: false,
      success: () => {
        safeBack()
      }
    })
  }
})
