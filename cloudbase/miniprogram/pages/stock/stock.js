/* 我的库存：本机维护的现货清单，用于商机自动匹配与需求领取 */
const stock = require('../../utils/stock')
const biz = require('../../utils/biz')
const { getUser } = require('../../utils/auth')
const { request } = require('../../utils/request')
const { ensureProfileReady, handleProfileError } = require('../../utils/profile-ready')
const { normSearch, searchHit } = require('../../utils/model')
const M = require('../../utils/mock')

const DEVICE_TREE = M.DEVICE_TREE || {}
const CATS = Object.keys(DEVICE_TREE)
const CONDS = stock.CONDS
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'on', label: '在售' },
  { key: 'off', label: '已下架' }
]

/* 设备目录：品类 → 品牌 → 系列 → 型号，与发布页同源，保证库存名称与需求字段对得上 */
function brandsOf(cat) {
  return Object.keys(DEVICE_TREE[cat] || {})
}
function seriesOf(cat, brand) {
  return Object.keys((DEVICE_TREE[cat] || {})[brand] || {})
}
function modelsOf(cat, brand, series) {
  return (((DEVICE_TREE[cat] || {})[brand] || {})[series]) || []
}

/* 目录摊平成一行一条：添加库存时输入型号 / 品牌即匹配，点一条直接回填 */
let deviceFlat = null
function deviceSearchIndex() {
  if (deviceFlat) return deviceFlat
  const out = []
  CATS.forEach((cat) => {
    brandsOf(cat).forEach((brand) => {
      seriesOf(cat, brand).forEach((series) => {
        modelsOf(cat, brand, series).forEach((model) => {
          out.push({
            k: cat + '|' + brand + '|' + series + '|' + model,
            cat, brand, series, model,
            path: [cat, brand, series].join(' · ')
          })
        })
      })
    })
  })
  deviceFlat = out
  return out
}

/* 输入即匹配：整串包含 / 乱序多词 / 子序列兜底都算命中，型号前缀命中排前面，最多 12 条 */
function matchDevices(raw) {
  const kw = String(raw == null ? '' : raw)
  const query = normSearch(kw)
  if (!query) return deviceSearchIndex().slice(0, 12)
  const head = []
  const rest = []
  deviceSearchIndex().forEach((it) => {
    if (!searchHit(it.model + ' ' + it.path, kw)) return
    if (normSearch(it.model).indexOf(query) === 0) head.push(it)
    else rest.push(it)
  })
  return head.concat(rest).slice(0, 12)
}

function fmt(n) {
  return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/* 默认城市读本机定位 / 用户资料；库存可手动改，改完只影响本条库存 */
function localCity() {
  try {
    const u = getUser()
    if (u && u.city) return String(u.city).replace(/市$/, '')
    return wx.getStorageSync('city') || '深圳'
  } catch (err) {
    return '深圳'
  }
}

function emptyForm(city) {
  return {
    cat: CATS[0] || '其他配件',
    brand: '',
    model: '',
    qty: '',
    price: '',
    city: city || '',
    cond: '全新',
    note: ''
  }
}

/* 列表里的时间：今天 / 昨天 / 月-日，弱化到一眼扫过 */
function atText(ts) {
  const t = Number(ts)
  if (!t) return ''
  const d = new Date(t)
  const now = new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return '今天更新'
  const yest = new Date(now.getTime() - 86400000)
  if (d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate()) return '昨天更新'
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' 更新'
}

/* 导出用时间戳：20261104-1530 */
function stamp() {
  const d = new Date()
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
}

function tableRows() {
  return stock.list().map((x) => [
    x.cat, x.brand, x.model, x.qty, String(x.unit || '').replace('元 / ', ''), x.price,
    x.city, x.cond, x.note, x.status
  ])
}

const HEADERS = ['设备类型', '品牌', '型号', '数量', '单位', '单价(元)', '所在城市', '新旧成色', '描述', '状态']

Page({
  data: {
    items: [],
    stats: { sku: 0, total: 0, qty: 0 },
    matched: 0,
    filters: FILTERS.map((f) => Object.assign({ count: 0 }, f)),
    filter: 'all',
    keyword: '',
    city: '',
    sheetOpen: false,
    editingId: '',
    conds: CONDS,
    condIndex: 0,
    form: emptyForm(''),
    formUnit: stock.unitOf(CATS[0]),
    /* 设备搜索：一个输入框，选中后型号直接显示在里面 */
    devKw: '',
    devPath: '',
    devResults: [],
    devSearchOpen: false,
    exportOpen: false,
    rowCount: 0,
    listEmpty: true
  },

  onLoad() {
    const city = localCity()
    this.setData({ city: city, form: emptyForm(city) })
    this.refresh()
    this.syncCloud()
  },

  onShow() {
    this.refresh()
  },

  /* 云端优先：与本地按 id 合并（以最近更新时间为准），避免离线保存的记录被覆盖；
     未部署 / 失败时保持本地数据，页面照常可用 */
  syncCloud() {
    request('user', 'stock.list', {}, { silent: true })
      .then((res) => {
        const remote = (res && res.items) || []
        if (!remote.length) return
        const map = {}
        remote.forEach((x) => {
          map[x.id] = x
        })
        stock.list().forEach((x) => {
          const hit = map[x.id]
          if (!hit || (Number(x.at) || 0) > (Number(hit.at) || 0)) map[x.id] = x
        })
        stock.replaceAll(Object.keys(map).map((k) => map[k]))
        this.refresh()
      })
      .catch(() => {})
  },

  refresh() {
    const all = stock.list().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    const kw = String(this.data.keyword || '').trim()
    let matched = 0
    let opps = []
    try {
      opps = biz.opportunities()
      matched = opps.length
    } catch (err) {
      opps = []
    }
    const on = all.filter((x) => x.status === stock.STATUS_ON).length

    const items = all
      .filter((x) => {
        const f = this.data.filter
        if (f === 'on' && x.status !== stock.STATUS_ON) return false
        if (f === 'off' && x.status === stock.STATUS_ON) return false
        if (!kw) return true
        /* 型号 / 品牌 / 城市 / 备注混检：不带空格、乱序多词、部分子串都能命中 */
        return searchHit([x.model, x.brand, x.cat, x.city, x.note, x.unit].join(' '), kw)
      })
      .map((x) => {
        const hits = opps.filter((o) => stock.modelMatch(x.model, o.model)).length
        return Object.assign({}, x, {
          priceText: '¥ ' + fmt(x.price),
          unitText: String(x.unit || stock.unitOf(x.cat)).replace('元 / ', ''),
          meta: [x.cat, x.brand, x.cond].filter(Boolean).join(' · '),
          off: x.status !== stock.STATUS_ON,
          hits: hits,
          atText: atText(x.at)
        })
      })

    this.setData({
      items: items,
      stats: stock.stats(),
      matched: matched,
      rowCount: all.length,
      listEmpty: items.length === 0,
      filters: FILTERS.map((f) => Object.assign({}, f, {
        count: f.key === 'all' ? all.length : f.key === 'on' ? on : all.length - on
      }))
    })
  },

  switchFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.key })
    this.refresh()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  clearSearch() {
    this.setData({ keyword: '' })
    this.refresh()
  },

  openAdd() {
    const f = emptyForm(this.data.city)
    this.setData({
      sheetOpen: true,
      editingId: '',
      condIndex: 0,
      form: f,
      formUnit: stock.unitOf(f.cat),
      devKw: '',
      devPath: '',
      devResults: [],
      devSearchOpen: false
    })
  },

  /* 手动修改：把整条库存回填到弹层，保存时按 id 覆盖 */
  openEdit(e) {
    const id = e.currentTarget.dataset.id
    const item = stock.list().filter((x) => x.id === id)[0]
    if (!item) return
    const form = {
      cat: item.cat || CATS[0] || '其他配件',
      brand: item.brand || '',
      model: item.model || '',
      qty: String(item.qty == null ? '' : item.qty),
      price: String(item.price == null ? '' : item.price),
      city: item.city || this.data.city,
      cond: item.cond || '全新',
      note: item.note || ''
    }
    this.setData({
      sheetOpen: true,
      editingId: id,
      condIndex: Math.max(0, CONDS.indexOf(item.cond || '全新')),
      formUnit: item.unit || stock.unitOf(item.cat),
      form: form,
      devKw: form.model || '',
      devPath: [form.cat, form.brand].filter(Boolean).join(' · '),
      devResults: [],
      devSearchOpen: false
    })
  },

  closeSheet() {
    this.setData({ sheetOpen: false, editingId: '' })
  },

  noop() {},

  /* 输入型号 / 品牌即出候选；输入内容原样保留（含空格），只把关键词用于匹配 */
  onDeviceInput(e) {
    const value = String((e.detail && e.detail.value) || '')
    this.setData({
      devKw: value,
      devResults: matchDevices(value),
      devSearchOpen: true,
      devPath: '',
      'form.model': ''
    })
  },

  /* 空输入框聚焦时列出目录前 30 条，不用再展开四级滚轮 */
  focusDeviceSearch() {
    if (String(this.data.devKw || '').trim()) return
    this.setData({ devResults: matchDevices(''), devSearchOpen: true })
  },

  clearDevice() {
    this.setData({
      devKw: '',
      devPath: '',
      devResults: [],
      devSearchOpen: false,
      'form.cat': CATS[0] || '其他配件',
      'form.brand': '',
      'form.model': '',
      formUnit: stock.unitOf(CATS[0])
    })
  },

  /* 点候选：品类 / 品牌 / 型号一起写回表单，型号显示在同一个输入框里 */
  pickDevice(e) {
    const item = (this.data.devResults || [])[Number(e.currentTarget.dataset.i)]
    if (!item) return
    const form = Object.assign({}, this.data.form, {
      cat: item.cat,
      brand: item.brand,
      model: item.model
    })
    this.setData({
      form: form,
      formUnit: stock.unitOf(item.cat),
      devKw: item.model,
      devPath: [item.cat, item.brand].filter(Boolean).join(' · '),
      devResults: [],
      devSearchOpen: false
    })
  },

  pickCondIndex(e) {
    const i = Number(e.detail.value) || 0
    this.setData({ condIndex: i, 'form.cond': CONDS[i] || CONDS[0] })
  },

  /* 城市允许手填，也可以一键回填本机定位城市 */
  useLocalCity() {
    this.setData({ 'form.city': this.data.city })
  },

  onFormInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  async submitForm() {
    const f = this.data.form
    const model = String(f.model || '').trim()
    const city = String(f.city || '').trim()
    if (!model) {
      wx.showToast({ title: '请从预设库选择型号', icon: 'none' })
      return
    }
    if (!(Number(f.qty) > 0)) {
      wx.showToast({ title: '请填写库存数量', icon: 'none' })
      return
    }
    if (!(Number(f.price) > 0)) {
      wx.showToast({ title: '请填写库存单价', icon: 'none' })
      return
    }
    if (!city) {
      wx.showToast({ title: '请填写库存所在城市', icon: 'none' })
      return
    }
    /* 上架库存会参与商机匹配：主体信息与联系方式不齐时先引导补齐 */
    if (!(await ensureProfileReady())) return
    const payload = {
      cat: f.cat,
      brand: String(f.brand || '').trim(),
      model: model,
      qty: Math.floor(Number(f.qty)),
      price: Number(f.price),
      unit: stock.unitOf(f.cat),
      city: city,
      cond: f.cond,
      note: String(f.note || '').trim()
    }
    const editing = this.data.editingId
    let id = editing
    if (editing) {
      stock.update(editing, payload)
    } else {
      id = 'sk' + Date.now()
      stock.add(Object.assign({ id: id }, payload))
    }
    this.setData({ sheetOpen: false, editingId: '', form: emptyForm(this.data.city) })
    this.refresh()
    wx.showToast({ title: editing ? '已保存修改' : '已加入库存', icon: 'success' })
    /* 本地先落盘保证界面即时可用，再静默同步云端 */
    this.pushSave(Object.assign({ id: id, status: this.statusOf(id) }, payload))
  },

  statusOf(id) {
    const item = stock.list().filter((x) => x.id === id)[0]
    return item ? item.status : stock.STATUS_ON
  },

  /* 云端库存决定商机匹配，同步失败必须明确告知，避免「界面有、匹配没有」 */
  pushSave(item) {
    request('user', 'stock.save', item, { silent: true }).catch((err) => {
      /* 后端资料兜底拦截：弹窗引导补齐，而不是只提示同步失败 */
      if (handleProfileError(err)) return
      wx.showToast({ title: '已存本机，云端同步失败，请重试', icon: 'none' })
    })
  },

  pushRemove(id) {
    request('user', 'stock.remove', { id: id }, { silent: true }).catch(() => {
      wx.showToast({ title: '本机已删除，云端同步失败，请重试', icon: 'none' })
    })
  },

  toggleItem(e) {
    const id = e.currentTarget.dataset.id
    stock.toggle(id)
    this.refresh()
    const item = stock.list().filter((x) => x.id === id)[0]
    if (item) this.pushSave(item)
  },

  removeItem(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除库存',
      content: '删除后将不再参与商机匹配，确定删除？',
      success: (res) => {
        if (!res.confirm) return
        stock.remove(id)
        this.refresh()
        wx.showToast({ title: '已删除', icon: 'none' })
        this.pushRemove(id)
      }
    })
  },

  /* ---------- 导出表格 ---------- */
  openExport() {
    this.setData({ exportOpen: true, rowCount: stock.list().length })
  },

  closeExport() {
    this.setData({ exportOpen: false })
  },

  /* 复制为制表符分隔文本，直接粘贴进 Excel / 飞书表格即成表 */
  copyTable() {
    const text = [HEADERS].concat(tableRows())
      .map((row) => row.map((c) => String(c == null ? '' : c).replace(/\t|\r|\n/g, ' ')).join('\t'))
      .join('\n')
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制，可粘贴到表格', icon: 'none' })
      }
    })
  },

  saveCsv() {
    const csv = [HEADERS].concat(tableRows())
      .map((row) => row.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(','))
      .join('\r\n')
    const file = wx.env.USER_DATA_PATH + '/我的库存_' + stamp() + '.csv'
    try {
      /* 带 BOM，Excel 打开不乱码 */
      wx.getFileSystemManager().writeFileSync(file, '\ufeff' + csv, 'utf8')
      wx.showModal({
        title: '已导出 CSV',
        content: '文件：' + file + '\n可用「转发」发到微信 / 电脑后打开，或直接点「复制表格」粘贴到 Excel。',
        showCancel: false
      })
    } catch (err) {
      wx.showToast({ title: '导出失败，请改用复制表格', icon: 'none' })
    }
  },

  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' })
  },

  backToAll() {
    this.setData({ filter: 'all', keyword: '' })
    this.refresh()
  }
})
