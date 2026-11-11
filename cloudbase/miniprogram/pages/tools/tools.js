/* 工具中心：把几个测算工具收在一个类目下，点进去即用 */
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')

const TOOLS = [
  {
    key: 'calc',
    badge: '部署',
    name: '本地部署测算',
    desc: '语言 / 生图 / 视频 / 语音模型，算需要多少台设备',
    tag: '推理',
    url: '/pages/calc/calc',
    tone: 'c1'
  },
  {
    key: 'finetune',
    badge: '微调',
    name: '微调显存测算',
    desc: 'LoRA / 全参微调要多少显存，需要几台机器',
    tag: '训练',
    url: '/pages/finetune/finetune',
    tone: 'c2'
  },
  {
    key: 'power',
    badge: '功耗',
    name: '功耗与机柜测算',
    desc: '整机功耗、机柜数量、月电费与配电容量',
    tag: '部署',
    url: '/pages/power/power',
    tone: 'c3'
  },
  {
    key: 'roi',
    badge: '回本',
    name: '回本收益测算',
    desc: '本地部署与官方 API 的 token 价差，算电费成本与回本周期',
    tag: '经营',
    url: '/pages/roi/roi',
    tone: 'c4'
  }
]

const FALLBACK_CARD = '/assets/share/card-home.png'

Page({
  data: { tools: TOOLS },

  onLoad() {
    this.preparePosters()
  },

  onShow() {
    guard.enableShare()
    this.preparePosters()
  },

  /* 4 张工具海报串行预生成，结果留在 share-poster 的缓存里 */
  preparePosters() {
    if (this.posterReady) return
    this.posterReady = true
    let i = 0
    const step = () => {
      if (i >= TOOLS.length) return
      const spec = sharePoster.toolSpec(TOOLS[i].key)
      i += 1
      if (!spec) {
        step()
        return
      }
      sharePoster.prepare('tool', spec).then(step, step)
    }
    step()
  },

  /* 点哪个工具的分享按钮，就分享哪个工具：标题 / 描述 / 海报都取该工具自己的 */
  onShareAppMessage(e) {
    const ds = (e && e.target && e.target.dataset) || {}
    const tool = TOOLS.filter((t) => t.key === ds.tool)[0]
    if (!tool) {
      return {
        title: '算力工具 · 选型与预算测算',
        desc: '本地部署 / 微调 / 功耗 / 回本，选完参数直接出结果',
        imageUrl: FALLBACK_CARD,
        path: '/pages/tools/tools'
      }
    }
    return {
      title: tool.name + ' · 免登录直接算',
      desc: tool.desc,
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec(tool.key)) || FALLBACK_CARD,
      path: tool.url
    }
  },

  openTool(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },

  /* 分享按钮在卡片内部：阻止冒泡，避免点分享时同时跳转工具页 */
  noop() {}
})
