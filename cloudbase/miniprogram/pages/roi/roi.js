/* 回本收益测算：本地部署 vs 官方 API 的 token 价差。
   单台吞吐由「显存带宽 ÷ 单个 token 需读取的激活权重」自动折算，单台月产出是确定值；
   用户只填电价、使用率、设备采购价和卖价，就能得到每百万 token 电费成本、单位价差与回本周期。 */
const D = require('../../utils/device-spec')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')

/* 固定口径：FP8 部署，24 小时 × 30 天，PUE 1.3；
   使用率由用户填，设备静置功耗按满载的 35% 计（GPU 空转也要耗电） */
const PUE = 1.3
const IDLE_RATIO = 0.35
const HOURS = 720
const TP_EFF = 0.8
const BATCH_GAIN = 3

/* 主流开源大模型：只列官网公开了 API 价、仍在售的开源型号，按厂商归类。
   params 总参数（B）、active 输出激活参数（B）、price 官方 API 输出价（元/百万 token，2026-11 官网页面）。
   口径：DeepSeek 取高峰时段价；MiniMax M3 取永久五折后的实付价；其余取官网标准价，不计限时活动。 */
const MODELS = [
  { id: 'ds-v41-flash', name: 'DeepSeek-V4.1-Flash', vendor: 'DeepSeek', params: 552, active: 16, price: 8 },
  { id: 'ds-v4-pro', name: 'DeepSeek-V4-Pro', vendor: 'DeepSeek', params: 1600, active: 49, price: 27 },
  { id: 'qwen38-flash', name: 'Qwen3.8-Flash', vendor: '通义千问', params: 125, active: 6, price: 2.7 },
  { id: 'qwen38-27b', name: 'Qwen3.8-27B', vendor: '通义千问', params: 27, active: 27, price: 12 },
  { id: 'qwen38-24t', name: 'Qwen3.8-2.4T-A95B', vendor: '通义千问', params: 2400, active: 95, price: 36 },
  { id: 'kimi-k31-pro', name: 'Kimi-K3.1-Pro', vendor: 'Moonshot', params: 2800, active: 104, price: 68 },
  { id: 'kimi-k3', name: 'Kimi-K3', vendor: 'Moonshot', params: 2800, active: 104, price: 100 },
  { id: 'minimax-m3', name: 'MiniMax-M3', vendor: 'MiniMax', params: 428, active: 23, price: 8.4 },
  { id: 'glm53', name: 'GLM-5.3', vendor: '智谱', params: 753, active: 40, price: 28 },
  { id: 'glm53-flash', name: 'GLM-5.3-Flash', vendor: '智谱', params: 320, active: 18, price: 2.8 },
  { id: 'hy4', name: '混元 Hy4', vendor: '腾讯混元', params: 770, active: 49, price: 18 },
  { id: 'hunyuan-a13b', name: 'Hunyuan-A13B', vendor: '腾讯混元', params: 80, active: 13, price: 2 },
  { id: 'step-5-preview', name: 'Step-5-Preview', vendor: '阶跃星辰', params: 600, active: 27, price: 20 },
  { id: 'step-37-flash', name: 'Step-3.7-Flash', vendor: '阶跃星辰', params: 198, active: 11, price: 8.1 }
]

/* 参考采购价（万元 / 卡）：只用于选设备时的默认值，用户可改 */
const CARD_PRICE = [
  [/GB300|B300/, 45],
  [/GB200|B200/, 38],
  [/H200/, 28],
  [/H100 NVL/, 26],
  [/H100|H800/, 24],
  [/H20/, 11],
  [/A100 40G/, 8],
  [/A100|A800/, 11],
  [/L40S|L40|L20/, 5],
  [/L4 24G|L4 16G/, 2],
  [/MI400/, 40],
  [/MI355X|MI350X/, 30],
  [/MI325X/, 24],
  [/MI300X/, 18],
  [/MI250X/, 8],
  [/Gaudi 3/, 14],
  [/Gaudi 2/, 8],
  [/RTX PRO 6000/, 7],
  [/RTX PRO 5000/, 4],
  [/RTX PRO 4000/, 2.2],
  [/RTX 6000 Ada/, 3.5],
  [/RTX 5000 Ada/, 2.4],
  [/RTX 4000 Ada/, 1.4],
  [/RTX A6000/, 2.4],
  [/RTX A5000/, 1.4],
  [/RTX 5090/, 4.5],
  [/RTX 5080/, 2],
  [/RTX 5070/, 1.2],
  [/RTX 5060/, 0.6],
  [/RTX 4090/, 2.4],
  [/RTX 4080/, 1.4],
  [/RTX 3090/, 0.85],
  [/RX 9070/, 0.5],
  [/RX 7900 XTX/, 0.8],
  [/昇腾 950/, 18],
  [/昇腾 910/, 11],
  [/昇腾 310P/, 1.5],
  [/DCU Z100|DCU K100/, 7],
  [/MLU590/, 10],
  [/昆仑芯 P800/, 9],
  [/天垓 150/, 8],
  [/T4 16G/, 0.5],
  [/V100 32G|V100 16G/, 1.5]
]

function round1(n) {
  return Math.round(n * 10) / 10
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function numText(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function priceText(n) {
  if (n > 0 && n < 0.01) return '<0.01 元/百万'
  return round2(n) + ' 元/百万'
}

function tokenText(n) {
  if (n >= 1e9) return round2(n / 1e9) + ' B tokens'
  if (n >= 1e6) return round1(n / 1e6) + ' M tokens'
  return Math.round(n) + ' tokens'
}

function moneyText(n) {
  if (n >= 1e8) return round2(n / 1e8) + ' 亿元'
  if (n >= 1e4) return round1(n / 1e4) + ' 万元'
  return Math.round(n) + ' 元'
}

function monthsText(n) {
  if (!(n > 0)) return '无法回本'
  if (n > 600) return '超 50 年'
  if (n < 1) return '< 1 个月'
  /* 超过 2 年用「年 + 月」，否则用月并保留一位小数，电价微调也能看出来 */
  if (n >= 24) {
    const y = Math.floor(n / 12)
    const m = Math.round(n - y * 12)
    return m > 0 ? y + ' 年 ' + m + ' 个月' : y + ' 年'
  }
  return round1(n) + ' 个月'
}

function priceOf(x) {
  for (let i = 0; i < CARD_PRICE.length; i++) {
    if (CARD_PRICE[i][0].test(x.model)) {
      const total = CARD_PRICE[i][1] * x.cards + (x.cards > 1 ? 8 : 0)
      return String(Math.round(total * 10) / 10)
    }
  }
  return '20'
}

Page({
  data: {
    models: MODELS,
    modelId: 'ds-v41-flash',
    sellPrice: '',
    electricity: '0.7',
    usage: '90',
    price: '240',
    deviceKey: '',
    device: null,
    deviceSheet: false,
    deviceSearch: '',
    deviceCat: '全部',
    deviceCats: ['全部'],
    deviceList: [],
    deviceMore: 0,
    result: null
  },

  onLoad() {
    this.devices = D.buildDevices().filter((x) => x.kind === 'gpu' && x.power > 0 && x.bw > 0)
    const cats = []
    this.devices.forEach((x) => {
      if (cats.indexOf(x.cat) < 0) cats.push(x.cat)
    })
    const first = this.devices.filter((x) => /H200/.test(x.model) && x.cards > 1)[0] ||
      this.devices.filter((x) => /H100/.test(x.model) && x.cards > 1)[0] ||
      this.devices[0]
    this.setData({
      deviceCats: ['全部'].concat(cats),
      deviceKey: first ? first.key : '',
      device: first ? this.cardOf(first) : null,
      price: first ? priceOf(first) : '20'
    })
    this.recalc()
  },

  /* 工具页是公开内容：允许分享给朋友，也允许分享到朋友圈 */
  onShow() {
    guard.enableShare(true)
    sharePoster.prepare('tool', sharePoster.toolSpec('roi'))
  },

  onShareAppMessage() {
    return {
      title: '回本收益测算 · 本地部署多久回本',
      desc: '对比官方 API 的 token 价差，算电费成本与回本周期',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('roi')) || '/assets/share/card-home.png',
      path: '/pages/roi/roi'
    }
  },

  onShareTimeline() {
    return {
      title: '回本收益测算 · 本地部署多久回本',
      query: '',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('roi')) || '/assets/share/card-home.png'
    }
  },

  cardOf(x) {
    return {
      key: x.key,
      model: x.model,
      brand: x.brand,
      cat: x.cat,
      specText: x.specText,
      cards: x.cards,
      memGB: x.memGB,
      bw: x.bw,
      power: x.power,
      /* 多卡整机按「台」、裸卡按「张」，结果单位要跟着设备走 */
      unitLabel: x.unitLabel || '台',
      powerText: round1(x.power / 1000) + ' kW',
      bwText: x.bw + ' GB/s',
      memText: Math.round(x.memGB) + ' GB'
    }
  },

  /* ---------- 设备选择面板 ---------- */

  openDevices() {
    this.refreshDeviceList()
    this.setData({ deviceSheet: true })
  },
  closeDevices() {
    this.setData({ deviceSheet: false })
  },
  onDeviceSearch(e) {
    this.setData({ deviceSearch: e.detail.value }, () => this.refreshDeviceList())
  },
  pickDeviceCat(e) {
    this.setData({ deviceCat: e.currentTarget.dataset.v }, () => this.refreshDeviceList())
  },
  pickSheetDevice(e) {
    const key = e.currentTarget.dataset.key
    const device = this.devices.filter((x) => x.key === key)[0]
    this.setData({
      deviceKey: key,
      device: device ? this.cardOf(device) : null,
      price: device ? priceOf(device) : this.data.price,
      deviceSheet: false
    }, () => this.recalc())
  },

  refreshDeviceList() {
    const d = this.data
    const tokens = d.deviceSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = this.devices.filter((x) => {
      if (d.deviceCat !== '全部' && x.cat !== d.deviceCat) return false
      if (!tokens.length) return true
      const hay = (x.model + ' ' + x.brand + ' ' + x.cat).toLowerCase()
      return tokens.every((t) => hay.indexOf(t) > -1)
    })
    const list = hit.slice(0, 80).map((x) => ({
      key: x.key,
      model: x.model,
      brand: x.brand,
      cat: x.cat,
      specText: x.specText,
      powerText: round1(x.power / 1000) + ' kW'
    }))
    this.setData({ deviceList: list, deviceMore: Math.max(0, hit.length - list.length) })
  },

  /* ---------- 价格参数 ---------- */

  pickModel(e) {
    this.setData({ modelId: e.currentTarget.dataset.id }, () => this.recalc())
  },
  onSellPrice(e) { this.setData({ sellPrice: e.detail.value }, () => this.recalc()) },
  onElectricity(e) { this.setData({ electricity: e.detail.value }, () => this.recalc()) },
  onUsage(e) { this.setData({ usage: e.detail.value }, () => this.recalc()) },
  onPrice(e) { this.setData({ price: e.detail.value }, () => this.recalc()) },

  recalc() {
    const d = this.data
    if (!d.device) {
      this.setData({ result: null })
      return
    }
    const model = MODELS.filter((x) => x.id === d.modelId)[0] || MODELS[0]
    const elec = Math.max(0, Number(d.electricity) || 0)
    const usage = Math.min(1, Math.max(0, (Number(d.usage) || 0) / 100))
    const official = model.price
    const sellInput = Math.max(0, Number(d.sellPrice) || 0)
    const sell = sellInput > 0 ? sellInput : official
    const invest = Math.max(0, Number(d.price) || 0) * 10000

    /* 电费：设备静置也要耗电，负载部分按使用率折算，再乘 PUE */
    const loadRatio = IDLE_RATIO + (1 - IDLE_RATIO) * usage
    const kw = d.device.power / 1000 * loadRatio * PUE
    const powerCostMonth = kw * HOURS * elec

    /* 显存：FP8 权重 1 字节 / 参数，留 5% 给 embedding 与输出头。
       单台装不下时，取能装下的最小台数，按集群满载产出平均到单台。 */
    const needGB = model.params * 1.05
    const usableGB = Math.max(d.device.memGB * 0.9 - 1.5, 1)
    const units = Math.max(1, Math.ceil(needGB / usableGB))
    const fits = units <= 1

    /* 吞吐：多卡带宽汇总 ÷ 单 token 需读取的激活权重（FP8），再乘批处理增益；
       装不下时按 units 台集群满载，再把产出平均到单台 */
    const bwUnit = d.device.bw * (d.device.cards > 1 ? d.device.cards * TP_EFF : 1)
    const tpsUnit = bwUnit > 0 ? bwUnit / model.active * BATCH_GAIN : 0
    const tps = tpsUnit
    const tokensMonth = tps * 3600 * HOURS * usage
    const costPerM = tokensMonth > 0 ? powerCostMonth / (tokensMonth / 1e6) : 0

    const gap = sell - costPerM
    const revenueMonth = tokensMonth / 1e6 * sell
    const profitMonth = revenueMonth - powerCostMonth
    const payback = profitMonth > 0 ? invest / profitMonth : 0
    const roiYear = invest > 0 ? profitMonth * 12 / invest * 100 : 0
    const costShare = revenueMonth > 0 ? powerCostMonth / revenueMonth * 100 : 0
    const cum3 = profitMonth * 36 - invest

    let warn = ''
    if (!tps) warn = '这台设备缺少带宽数据，算不出吞吐，请换一个型号。'
    else if (usage <= 0) warn = '使用率为 0，没有产出，算不出回本周期。'
    else if (sell <= 0) warn = '请填写卖价，否则算不出单位 token 价差。'
    else if (gap <= 0) warn = '单位 token 价差为负：电费成本已经高于卖价，按当前价格越卖越亏。'
    else if (payback > 60) warn = '回本超过 5 年，超过设备常规服役周期，建议核对设备采购价与卖价。'
    else if (costPerM > official) warn = '本地电费成本已高于官方 API 价，自建没有价格优势。'

    const unit = d.device.unitLabel || '台'
    const machineText = (unit === '张' && units > 1)
      ? '按 8 卡整机折算约需 ' + Math.ceil(units / 8) + ' 台服务器。'
      : ''
    const clusterTip = fits
      ? ''
      : '单' + unit + '显存装不下：按 FP8 约需 ' + Math.round(needGB) + ' GB，单' + unit + '可用 ' + Math.round(usableGB) + ' GB，取最少 ' + units + ' ' + unit + '集群满载运行，投入与产出都平均到单' + unit + '。' + machineText + '跨机并行未计通信损耗，实际吞吐会低于此估算。'

    const verdict = (tps && profitMonth > 0 && gap > 0)
      ? (fits ? '单' + unit : units + ' ' + unit + '集群平均每' + unit) + '按 ' + round1(usage * 100) + '% 使用率，每月净赚 ' + moneyText(profitMonth) + '，' + monthsText(payback) + '回本' +
        (cum3 > 0
          ? '；三年累计净收益约 ' + moneyText(cum3) + '（已扣设备成本）。'
          : '；三年内还没回本，届时仍净投入约 ' + moneyText(-cum3) + '。')
      : ''

    this.setData({
      result: {
        paybackText: !tps ? '—' : monthsText(payback),
        paybackSub: sellInput > 0 ? '按你的卖价' : '按官方 API 价',
        deviceText: d.device.model + ' · ' + d.device.specText,
        modelText: model.name + ' · ' + model.params + 'B 总参 / ' + model.active + 'B 激活',
        tpsText: tps > 0 ? numText(tps) + ' token/s' : '—',
        unitsText: units + ' ' + unit,
        vramText: Math.round(needGB) + ' / ' + Math.round(usableGB * units) + ' GB',
        usageText: round1(usage * 100) + '%',
        costText: priceText(costPerM),
        officialText: priceText(official),
        sellText: priceText(sell),
        gapText: priceText(gap),
        tokensText: tokenText(tokensMonth),
        powerCostText: moneyText(powerCostMonth),
        costShareText: round1(costShare) + '%',
        revenueText: moneyText(revenueMonth),
        profitText: moneyText(profitMonth),
        roiText: invest > 0 ? round1(roiYear) + '%' : '—',
        clusterTip,
        warn,
        verdict,
        note: '设备吞吐按显存带宽 ÷ 单个 token 需读取的激活权重（FP8）折算，并计入批处理增益；月产出 = 峰值吞吐 × 使用率 × 24 小时 × 30 天。电费含静置功耗（满载的 35%），PUE 按 1.3 计，未含折旧、带宽、运维与机房租金。'
      }
    })
  }
})
