/* 微调显存测算：模型规模 + 微调方式 + 序列长度 → 训练显存与机器数量。
   公式按 AdamW 混合精度估算：权重 2B/参数、梯度 2B/参数、优化器状态 12B/参数；
   LoRA 只算冻结权重 + 约 1.5% 可训练参数的开销。激活用预留比例近似，不追求逐层精确。
   设备既可看推荐，也可以从全部 GPU 设备里自己挑。 */
const D = require('../../utils/device-spec')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')

const SCALES = [7, 14, 32, 70, 110, 235, 400, 671, 1000, 2800]
const MODES = [
  /* 精度只提供 BF16 / FP8，没有 4bit 权重，所以不写 QLoRA 以免口径不符 */
  { key: 'lora', name: 'LoRA', tip: '只训适配器，显存最省' },
  { key: 'full', name: '全参数微调', tip: '权重 + 梯度 + 优化器' }
]
const PRECISIONS = [
  { key: 'bf16', name: 'BF16', bytes: 2 },
  { key: 'fp8', name: 'FP8', bytes: 1 }
]
const SEQS = [2048, 4096, 8192, 16384, 32768]
const BATCHES = [1, 2, 4, 8]
const RESERVES = [20, 40, 60]

function round1(n) {
  return Math.round(n * 10) / 10
}

function gbText(n) {
  if (n >= 1024) return round1(n / 1024) + ' TB'
  return (n >= 100 ? Math.round(n) : round1(n)) + ' GB'
}

function usableOf(d) {
  return d.memGB * 0.9 - 1.5
}

Page({
  data: {
    scales: SCALES,
    modes: MODES,
    precisions: PRECISIONS,
    seqs: SEQS,
    batches: BATCHES,
    reserves: RESERVES,
    scale: 70,
    mode: 'full',
    precision: 'bf16',
    seq: 4096,
    batch: 1,
    reserve: 40,
    pickKey: '',
    device: null,
    recos: [],
    deviceSheet: false,
    deviceSearch: '',
    deviceCat: '全部',
    deviceCats: ['全部'],
    deviceList: [],
    deviceMore: 0,
    result: null
  },

  onLoad() {
    /* 只保留能算出显存的 GPU 设备，设备太少时列表也没有意义 */
    this.gpus = D.buildDevices().filter((x) => x.kind === 'gpu')
    const cats = []
    this.gpus.forEach((x) => {
      if (cats.indexOf(x.cat) < 0) cats.push(x.cat)
    })
    this.setData({ deviceCats: ['全部'].concat(cats) })
    this.recalc()
  },

  /* 工具页是公开内容：允许分享给朋友，也允许分享到朋友圈 */
  onShow() {
    guard.enableShare(true)
    sharePoster.prepare('tool', sharePoster.toolSpec('finetune'))
  },

  onShareAppMessage() {
    return {
      title: '微调成本测算 · LoRA / 全参要多少显存',
      desc: '按模型规模与序列长度估算训练显存、机器数量与成本',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('finetune')) || '/assets/share/card-home.png',
      path: '/pages/finetune/finetune'
    }
  },

  onShareTimeline() {
    return {
      title: '微调成本测算 · LoRA / 全参要多少显存',
      query: '',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('finetune')) || '/assets/share/card-home.png'
    }
  },

  pickScale(e) { this.setData({ scale: Number(e.currentTarget.dataset.v) }, () => this.recalc()) },
  pickMode(e) { this.setData({ mode: e.currentTarget.dataset.v }, () => this.recalc()) },
  pickPrecision(e) { this.setData({ precision: e.currentTarget.dataset.v }, () => this.recalc()) },
  pickSeq(e) { this.setData({ seq: Number(e.currentTarget.dataset.v) }, () => this.recalc()) },
  pickBatch(e) { this.setData({ batch: Number(e.currentTarget.dataset.v) }, () => this.recalc()) },
  pickReserve(e) { this.setData({ reserve: Number(e.currentTarget.dataset.v) }, () => this.recalc()) },
  pickDevice(e) { this.setData({ pickKey: e.currentTarget.dataset.key }, () => this.recalc()) },

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
    this.setData({ pickKey: e.currentTarget.dataset.key, deviceSheet: false }, () => this.recalc())
  },

  refreshDeviceList() {
    const d = this.data
    const tokens = d.deviceSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (this.allDevices || []).filter((x) => {
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
      memText: x.memText,
      unitsText: '×' + x.units + ' ' + x.unitLabel
    }))
    this.setData({ deviceList: list, deviceMore: Math.max(0, hit.length - list.length) })
  },

  recalc() {
    const d = this.data
    const bytes = d.precision === 'fp8' ? 1 : 2
    const weights = d.scale * bytes * 1.05
    /* LoRA 可训练参数按 1.5% 估，开销口径与全参一致（权重 + 梯度 + 优化器 ≈ 16B/参数） */
    const core = d.mode === 'full'
      ? d.scale * (bytes * 2 + 12) * 1.05
      : weights + d.scale * 0.015 * 16
    /* 激活近似：序列 / batch 越长越高，8192 序列单并发为基准 */
    const act = weights * (d.reserve / 100) * Math.sqrt(d.batch * d.seq / 8192)
    const total = core + act

    const all = (this.gpus || []).map((x) => {
      const usable = usableOf(x)
      return {
        key: x.key,
        model: x.model,
        brand: x.brand,
        cat: x.cat,
        memText: x.memGB + 'G 显存 · 单' + x.unitLabel,
        units: Math.ceil(total / usable),
        unitLabel: x.unitLabel,
        memGB: x.memGB
      }
    })
    all.sort((a, b) => (a.units - b.units) || (a.memGB - b.memGB))
    this.allDevices = all
    const recos = all.slice(0, 4)
    const picked = all.filter((r) => r.key === d.pickKey)[0] || recos[0]
    if (!picked) {
      this.setData({ recos: [], device: null, result: null })
      return
    }
    recos.forEach((r) => { r.on = r.key === picked.key })

    let warn = ''
    if (picked.units > 4) warn = '需要 ' + picked.units + ' ' + picked.unitLabel + '，建议缩短序列、降低 batch 或改用 LoRA。'
    else if (picked.units > 1 && d.mode === 'full' && d.scale >= 70) warn = '全参微调 70B 以上需要跨机并行，实际可用显存会被通信缓冲吃掉一部分，建议按多留 10% 余量规划。'

    /* 选裸卡时张数不好落地，补一句 8 卡整机折算，方便直接报机器数量 */
    const machineText = (picked.unitLabel === '张' && picked.units > 1)
      ? '按 8 卡整机折算约需 ' + Math.ceil(picked.units / 8) + ' 台服务器。'
      : ''

    this.setData({
      pickKey: picked.key,
      device: {
        key: picked.key,
        model: picked.model,
        brand: picked.brand,
        cat: picked.cat,
        memText: picked.memText
      },
      recos,
      result: {
        unitsText: picked.units + ' ' + picked.unitLabel,
        fitText: d.mode === 'full' ? '全参' : 'LoRA',
        totalText: gbText(total),
        coreText: gbText(core),
        actText: gbText(act),
        weightsText: gbText(weights),
        device: picked.model,
        machineText,
        warn,
        note: '按 ' + d.scale + 'B · ' + (d.mode === 'full' ? '全参' : 'LoRA') + ' · ' +
          d.seq / 1024 + 'K 序列 · batch ' + d.batch + ' 估算；优化器按 AdamW 计，激活为近似预留。' +
          '实际建议预留 10%~20% 显存给碎片与通信缓冲。'
      }
    })
    if (d.deviceSheet) this.refreshDeviceList()
  }
})
