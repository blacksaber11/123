/* 功耗与机柜测算：从平台预设设备里选型号 + 台数，估总功率、机柜数与电费。
   单台功耗来自 device-spec（单卡 TDP × 卡数 + 系统开销），PUE 用于折算机房总用电。 */
const D = require('../../utils/device-spec')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')

function round1(n) {
  return Math.round(n * 10) / 10
}

function kwText(w) {
  return round1(w / 1000) + ' kW'
}

function kwhText(n) {
  if (n >= 10000) return round1(n / 10000) + ' 万度'
  return Math.round(n) + ' 度'
}

function moneyText(n) {
  if (n >= 10000) return round1(n / 10000) + ' 万元'
  return Math.round(n) + ' 元'
}

Page({
  data: {
    cats: ['全部'].concat(D.CALC_CATS),
    cat: '全部',
    keyword: '',
    list: [],
    more: 0,
    hitCount: 0,
    deviceKey: '',
    device: null,
    qty: '1',
    price: '0.7',
    pue: '1.3',
    rack: '8',
    result: null
  },

  onLoad() {
    this.devices = D.buildDevices().filter((x) => x.power > 0)
    /* 默认落在主流 8 卡整机，避免一进来就是最贵的机型 */
    const first = this.devices.filter((x) => x.cards > 1 && /H100/.test(x.model))[0] || this.devices[0]
    this.setData({ deviceKey: first ? first.key : '', device: first || null })
    this.refreshList()
    this.recalc()
  },

  /* 工具页是公开内容：允许分享给朋友，也允许分享到朋友圈 */
  onShow() {
    guard.enableShare(true)
    sharePoster.prepare('tool', sharePoster.toolSpec('power'))
  },

  onShareAppMessage() {
    return {
      title: '功耗与机柜测算 · 一台机器吃多少电',
      desc: '整机功耗、机柜数量、月电费与配电容量一次算清',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('power')) || '/assets/share/card-home.png',
      path: '/pages/power/power'
    }
  },

  onShareTimeline() {
    return {
      title: '功耗与机柜测算 · 一台机器吃多少电',
      query: '',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('power')) || '/assets/share/card-home.png'
    }
  },

  /* ---------- 设备筛选 ---------- */

  refreshList() {
    const d = this.data
    const kw = d.keyword.trim().toLowerCase()
    /* 多关键词乱序匹配：输入「三星 64 5600」也能命中，与发布页保持一致 */
    const tokens = kw.split(/\s+/).filter(Boolean)
    const hit = this.devices.filter((x) => {
      if (d.cat !== '全部' && x.cat !== d.cat) return false
      if (!tokens.length) return true
      const hay = (x.model + ' ' + x.brand + ' ' + x.cat).toLowerCase()
      return tokens.every((t) => hay.indexOf(t) > -1)
    })
    const list = hit.slice(0, 40).map((x) => ({
      key: x.key,
      model: x.model,
      brand: x.brand,
      spec: x.specText,
      cat: x.cat,
      powerText: kwText(x.power)
    }))
    this.setData({ list, more: Math.max(0, hit.length - list.length), hitCount: hit.length })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.refreshList())
  },

  pickCat(e) {
    this.setData({ cat: e.currentTarget.dataset.v }, () => this.refreshList())
  },

  pickDevice(e) {
    const key = e.currentTarget.dataset.key
    const device = this.devices.filter((x) => x.key === key)[0] || null
    this.setData({ deviceKey: key, device }, () => this.recalc())
  },

  /* ---------- 参数 ---------- */

  onQty(e) { this.setData({ qty: e.detail.value }, () => this.recalc()) },
  onPrice(e) { this.setData({ price: e.detail.value }, () => this.recalc()) },
  onPue(e) { this.setData({ pue: e.detail.value }, () => this.recalc()) },
  onRack(e) { this.setData({ rack: e.detail.value }, () => this.recalc()) },

  recalc() {
    const d = this.data
    if (!d.device) {
      this.setData({ result: null })
      return
    }
    const qty = Math.max(1, Math.round(Number(d.qty) || 1))
    const price = Math.max(0, Number(d.price) || 0)
    const pue = Math.max(1, Number(d.pue) || 1.3)
    const rackCap = Math.max(1, Number(d.rack) || 8)

    const singleW = d.device.power
    const singleKw = singleW / 1000
    const itW = singleW * qty
    const facilityW = itW * pue
    /* 机柜按整机装柜：单柜能放几台先取整，再向上取整，
       避免按总功率算出「半台设备塞进另一个机柜」，单台超柜时也能如实显示每台占一个柜 */
    const perRack = Math.max(1, Math.floor(rackCap / singleKw))
    const rackCount = Math.ceil(qty / perRack)
    const monthKwh = facilityW / 1000 * 24 * 30
    const monthCost = monthKwh * price

    let warn = ''
    if (singleKw > rackCap) warn = '单台功率 ' + round1(singleKw) + ' kW 已超过单柜 ' + rackCap + ' kW 上限，需要降低单柜密度或改用高密机柜。'
    else if (rackCap > 30) warn = '单柜 ' + rackCap + ' kW 属于液冷 / 高密机柜，风冷机房通常只能做到 8~12 kW。'

    this.setData({
      result: {
        totalText: kwText(itW),
        singleText: kwText(singleW),
        qtyText: qty + ' ' + d.device.unitLabel,
        deviceText: d.device.model + ' · ' + d.device.specText,
        rackText: rackCount + ' 个',
        rackSub: '按单柜 ' + rackCap + ' kW',
        monthKwhText: kwhText(monthKwh),
        monthCostText: moneyText(monthCost),
        yearCostText: moneyText(monthCost * 12),
        warning: warn,
        note: '按 24 小时满载 × 30 天估算，PUE ' + pue + '；实际负载通常低于满载，电费会相应下降。'
      }
    })
  }
})
