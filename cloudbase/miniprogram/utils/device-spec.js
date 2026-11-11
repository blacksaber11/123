/* 设备规格推断：显存 / 卡数 / 单台功耗，各测算工具共用一份规则，避免口径漂移。
   设备来源：device-catalog.js → mock.js 的 DEVICE_TREE。
   显存 / 卡数认不出的型号不进测算列表，避免瞎猜。 */
const M = require('./mock')

/* 参与测算的品类：按目录顺序（即需求热度）展示。
   笔记本 / 边缘盒子 / 一体机不参与：前者不适合长时推理，后两者型号里看不出卡型。 */
const CALC_CATS = ['GPU 服务器', 'GPU 加速卡', '消费级显卡', 'NPU 加速卡', 'Apple 算力设备', 'AI 工作站', '台式机与迷你主机']

const VRAM_RULES = [
  [/GB300/, 288],
  [/GB200/, 192],
  [/B300/, 288],
  [/B200 180G/, 180],
  [/B200/, 192],
  [/H200/, 141],
  [/H100 NVL/, 94],
  [/H100/, 80],
  [/A100 40G/, 40],
  [/A100/, 80],
  [/A800/, 80],
  [/H800/, 80],
  [/H20/, 96],
  [/L40S|L40|L20/, 48],
  [/L4 24G|L4 16G/, 24],
  [/MI400/, 432],
  [/MI355X|MI350X/, 288],
  [/MI325X/, 256],
  [/MI300X/, 192],
  [/MI250X/, 128],
  [/Gaudi 3/, 128],
  [/Gaudi 2/, 96],
  [/RTX PRO 6000 Max-Q/, 72],
  [/RTX PRO 6000/, 96],
  [/RTX PRO 5000/, 48],
  [/RTX PRO 4000/, 24],
  [/RTX 6000 Ada/, 48],
  [/RTX 5000 Ada/, 32],
  [/RTX 4000 Ada/, 20],
  [/RTX A6000/, 48],
  [/RTX A5000/, 24],
  [/RTX A4000/, 16],
  [/R9700/, 32],
  [/PRO W7900/, 48],
  /* 消费级：Ti / SUPER 必须先于非 Ti 匹配，否则 16G 会被算成 12G */
  [/RTX 5090/, 32],
  [/RTX 5080/, 16],
  [/RTX 5070 Ti/, 16],
  [/RTX 5070/, 12],
  [/RTX 5060 Ti/, 16],
  [/RTX 5060/, 8],
  [/RTX 5050/, 8],
  [/RTX 4090/, 24],
  [/RTX 4080/, 16],
  [/RTX 4070 Ti/, 16],
  [/RTX 4070/, 12],
  [/RTX 4060 Ti/, 16],
  [/RTX 4060/, 8],
  [/RTX 3090/, 24],
  [/RTX 3080/, 10],
  [/RTX 2080 Ti/, 22],
  [/RX 9070 XT/, 16],
  [/RX 9070/, 12],
  [/RX 7900 XTX/, 24],
  [/RX 7800 XT/, 16],
  [/Arc B770/, 16],
  [/Arc A770/, 16],
  [/Arc B580/, 12],
  [/昇腾 950DT/, 144],
  [/昇腾 950PR/, 128],
  [/昇腾 910C/, 128],
  [/昇腾 910B/, 64],
  [/昇腾 310P/, 24],
  [/DCU Z100|DCU K100/, 64],
  [/MLU590/, 64],
  [/MLU370/, 48],
  [/MTT S5000/, 80],
  [/MTT S4000|MTT S3000/, 48],
  [/昆仑芯 P800/, 96],
  [/昆仑芯 R200/, 32],
  [/天垓 150/, 64],
  [/天垓 100/, 32],
  [/T4 16G/, 16],
  [/V100 32G/, 32],
  [/V100 16G/, 16]
]

const CN_CARDS = { 单: 1, 双: 2, 四: 4, 八: 8 }

function vramOf(name) {
  for (let i = 0; i < VRAM_RULES.length; i++) {
    if (VRAM_RULES[i][0].test(name)) return VRAM_RULES[i][1]
  }
  return 0
}

function cardsOf(name) {
  const m = String(name).match(/(\d+)\s*卡|(\d+)-GPU/i)
  if (m) return Number(m[1] || m[2])
  const cn = String(name).match(/(单|双|四|八)卡/)
  if (cn) return CN_CARDS[cn[1]]
  if (/NVL72/.test(name)) return 72
  if (/Superchip/.test(name)) return 2
  if (/DGX|HGX/.test(name)) return 8
  /* 整机型号名里不带卡数，按公开规格补映射；不补会当成单卡，少算 8 倍 */
  if (/XE9680|NF5488|NF5688|NF5468|SR670|SR675|SR680|SYS-821|AS-8125GS|420GP|G5500|B300 8T|ESC8000A|ESC N8|G493|G593|X785-G30|X795-G30|X740-H30|PR4908P|Ingrasys G8800/.test(name)) return 8
  if (/XE8640|XE7745|R760xa|B300 4T|PR4904P/.test(name)) return 4
  if (/整机/.test(name)) {
    if (/RTX|L40|L20|L4 /.test(name)) return 1
    return 8
  }
  return 1
}

function memOf(name) {
  const m = String(name).match(/(\d+)G/)
  return m ? Number(m[1]) : 0
}

/* 型号 → 单台可用的推断规格；认不出的型号不进入测算列表 */
function specOf(cat, brand, model) {
  if (/NVL72|SuperPOD|CloudMatrix/.test(model)) return null
  if (cat === 'Apple 算力设备') {
    const mem = memOf(model)
    if (!mem) return null
    return { memGB: mem, perCardGB: mem, cards: 1, kind: 'unified' }
  }
  const vram = vramOf(model)
  if (!vram) return null
  const cards = cardsOf(model)
  return { memGB: vram * cards, perCardGB: vram, cards, kind: 'gpu' }
}

/* 单张 / 单台的口径：多卡整机按台，裸卡按张 */
function unitLabelOf(d) {
  if (d.cards > 1) return '台'
  if (d.cat === 'GPU 加速卡') return '张'
  if (/Mac|整机|工作站|台式|迷你|服务器|PowerEdge|FusionServer|ThinkSystem|SYS-/.test(d.model)) return '台'
  return '张'
}

function specTextOf(d) {
  if (d.kind === 'unified') return '统一内存 ' + d.memGB + 'G · 1 台'
  if (d.cards > 1) return d.cards + ' × ' + d.perCardGB + 'G · 单台 ' + d.memGB + 'G 显存'
  return d.memGB + 'G 显存 · 单' + (d.unitLabel === '张' ? '张' : '台')
}

function buildDevices() {
  const out = []
  const seen = {}
  Object.keys(M.DEVICE_TREE || {}).forEach((cat) => {
    if (CALC_CATS.indexOf(cat) < 0) return
    const brands = M.DEVICE_TREE[cat] || {}
    Object.keys(brands).forEach((brand) => {
      const seriesMap = brands[brand] || {}
      const isFlat = Array.isArray(seriesMap)
      const seriesNames = isFlat ? [''] : Object.keys(seriesMap)
      seriesNames.forEach((sn) => {
        const list = isFlat ? seriesMap : (seriesMap[sn] || [])
        list.forEach((model) => {
          if (seen[model]) return
          const spec = specOf(cat, brand, model)
          if (!spec) return
          seen[model] = 1
          const d = Object.assign({ key: cat + '|' + brand + '|' + model, cat, brand, model }, spec)
          d.unitLabel = unitLabelOf(d)
          d.specText = specTextOf(d)
          d.power = powerOf(d)
          d.bw = bwOf(d.model)
          out.push(d)
        })
      })
    })
  })
  return out
}


/* 单卡功耗（W）：按型号匹配，取不到的整机不估算功耗 */
const POWER_RULES = [
  [/GB300/, 1400],
  [/GB200/, 1200],
  [/B300/, 1400],
  [/B200/, 1000],
  [/H200/, 700],
  [/H100 NVL|H100|H800/, 700],
  [/A100 40G|A100|A800/, 400],
  [/H20/, 400],
  [/L40S|L40|L20/, 350],
  [/L4 24G|L4 16G/, 72],
  [/MI400/, 1200],
  [/MI355X|MI350X|MI325X/, 1000],
  [/MI300X/, 750],
  [/MI250X/, 560],
  [/Gaudi 3|Gaudi 2/, 600],
  [/RTX PRO 6000 Max-Q/, 300],
  [/RTX PRO 6000/, 600],
  [/RTX PRO 5000/, 300],
  [/RTX PRO 4000/, 130],
  [/RTX 6000 Ada/, 300],
  [/RTX 5000 Ada/, 250],
  [/RTX 4000 Ada/, 130],
  [/RTX A6000/, 300],
  [/RTX A5000/, 230],
  [/RTX A4000/, 140],
  [/RTX 5090/, 575],
  [/RTX 5080/, 360],
  [/RTX 5070 Ti/, 300],
  [/RTX 5070/, 250],
  [/RTX 5060 Ti/, 180],
  [/RTX 5060/, 145],
  [/RTX 5050/, 130],
  [/RTX 4090/, 450],
  [/RTX 4080/, 320],
  [/RTX 4070 Ti/, 285],
  [/RTX 4070/, 200],
  [/RTX 4060 Ti/, 160],
  [/RTX 4060/, 115],
  [/RTX 3090/, 350],
  [/RTX 3080/, 320],
  [/RTX 2080 Ti/, 250],
  [/RX 9070 XT/, 304],
  [/RX 9070/, 220],
  [/RX 7900 XTX/, 355],
  [/RX 7800 XT/, 263],
  [/R9700/, 300],
  [/PRO W7900/, 295],
  [/Arc B770/, 250],
  [/Arc A770/, 225],
  [/Arc B580/, 190],
  [/昇腾 950DT|昇腾 950PR/, 1000],
  [/昇腾 910C|昇腾 910B/, 400],
  [/昇腾 310P/, 72],
  [/DCU Z100|DCU K100/, 300],
  [/MLU590/, 300],
  [/MLU370/, 250],
  [/MTT S5000/, 400],
  [/MTT S4000|MTT S3000/, 250],
  [/昆仑芯 P800/, 400],
  [/昆仑芯 R200/, 150],
  [/天垓 150/, 350],
  [/天垓 100/, 250],
  [/T4 16G/, 70],
  [/V100 32G|V100 16G/, 300]
]

function tdpOf(name) {
  for (let i = 0; i < POWER_RULES.length; i++) {
    if (POWER_RULES[i][0].test(name)) return POWER_RULES[i][1]
  }
  return 0
}

/* 单卡显存带宽（GB/s）：回本测算按带宽折算解码吞吐，认不出的按 0 处理 */
const BW_RULES = [
  [/GB300|B300/, 8000],
  [/GB200|B200/, 8000],
  [/H200/, 4800],
  [/H100 NVL/, 3900],
  [/H100|H800/, 3350],
  [/A100 40G/, 1555],
  [/A100|A800/, 2039],
  [/H20/, 4000],
  [/L40S|L40|L20/, 864],
  [/L4 24G|L4 16G/, 300],
  [/MI400/, 8000],
  [/MI355X|MI350X/, 8000],
  [/MI325X/, 6000],
  [/MI300X/, 5300],
  [/MI250X/, 3270],
  [/Gaudi 3/, 3700],
  [/Gaudi 2/, 2450],
  [/RTX PRO 6000 Max-Q/, 1344],
  [/RTX PRO 6000/, 1792],
  [/RTX PRO 5000/, 1344],
  [/RTX PRO 4000/, 672],
  [/RTX 6000 Ada/, 960],
  [/RTX 5000 Ada/, 576],
  [/RTX 4000 Ada/, 360],
  [/RTX A6000/, 768],
  [/RTX A5000/, 768],
  [/RTX A4000/, 448],
  [/RTX 5090/, 1792],
  [/RTX 5080/, 960],
  [/RTX 5070 Ti/, 896],
  [/RTX 5070/, 672],
  [/RTX 5060 Ti/, 448],
  [/RTX 5060/, 448],
  [/RTX 5050/, 320],
  [/RTX 4090/, 1008],
  [/RTX 4080/, 717],
  [/RTX 4070 Ti/, 504],
  [/RTX 4070/, 504],
  [/RTX 4060 Ti/, 288],
  [/RTX 4060/, 272],
  [/RTX 3090/, 936],
  [/RTX 3080/, 760],
  [/RTX 2080 Ti/, 616],
  [/RX 9070 XT|RX 9070/, 645],
  [/RX 7900 XTX/, 960],
  [/RX 7800 XT/, 624],
  [/R9700/, 640],
  [/PRO W7900/, 864],
  [/Arc B770|Arc A770/, 560],
  [/Arc B580/, 456],
  [/昇腾 950/, 4000],
  [/昇腾 910/, 3200],
  [/昇腾 310P/, 408],
  [/DCU Z100|DCU K100/, 1600],
  [/MLU590/, 1200],
  [/MLU370/, 800],
  [/MTT S5000/, 800],
  [/MTT S4000|MTT S3000/, 600],
  [/昆仑芯 P800/, 1600],
  [/昆仑芯 R200/, 512],
  [/天垓 150/, 800],
  [/天垓 100/, 400],
  [/T4 16G/, 320],
  [/V100 32G|V100 16G/, 900]
]

function bwOf(name) {
  for (let i = 0; i < BW_RULES.length; i++) {
    if (BW_RULES[i][0].test(name)) return BW_RULES[i][1]
  }
  return 0
}

/* 单台功耗（W）：多卡整机补 15% 系统开销，单卡设备补 250W 主板 / CPU / 风扇 */
function powerOf(d) {
  if (d.kind === 'unified') return d.memGB >= 256 ? 480 : 300
  const per = tdpOf(d.model)
  if (!per) return 0
  const sys = d.cards > 1 ? Math.round(per * d.cards * 0.15) : 250
  return per * d.cards + sys
}

module.exports = { CALC_CATS, vramOf, cardsOf, specOf, unitLabelOf, specTextOf, buildDevices, powerOf, bwOf }
