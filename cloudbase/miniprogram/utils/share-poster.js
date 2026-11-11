/**
 * 分享海报：按每条内容自己的字段离屏画一张 5:4 卡片。
 *
 * 为什么不直接用商品图：商品图在详情页是锁定展示的，没有可对外引用的公开地址，
 * 所以分享封面改为「按公开字段实时绘制」：品类、型号、数量、城市、价格、主体。
 *
 * 用法：
 *   sharePoster.prepare('biz', sharePoster.specOf('biz', opp)).then(...)  // 预生成
 *   sharePoster.cached('biz', opp)                                        // 分享时同步取
 * 低版本基础库没有离屏画布 / 导出能力时统一返回空字符串，由页面回退静态底图。
 */

const W = 500
const H = 400
const BRAND = '算力聚合'
const FOOTER = '长按识别查看详情'

/* 5 套渐变：按 id + 标题做 hash 选一套，保证同一内容稳定、不同内容不同色 */
const PALETTES = [
  ['#4338CA', '#7C3AED'],
  ['#0F766E', '#0284C7'],
  ['#B45309', '#EA580C'],
  ['#BE123C', '#9333EA'],
  ['#047857', '#0D9488']
]

/* 工具类分享文案：工具中心与四个工具页共用同一份，缓存才能命中 */
const TOOL_SPECS = {
  calc: {
    id: 'calc',
    badge: '工具',
    title: '本地部署测算',
    desc: '语言 / 生图 / 视频 / 语音模型选型',
    tag: '推理'
  },
  finetune: {
    id: 'finetune',
    badge: '工具',
    title: '微调显存测算',
    desc: 'LoRA / 全参微调要多少显存，需要几台机器',
    tag: '训练'
  },
  power: {
    id: 'power',
    badge: '工具',
    title: '功耗与机柜测算',
    desc: '整机功耗、机柜数量、月电费与配电容量',
    tag: '部署'
  },
  roi: {
    id: 'roi',
    badge: '工具',
    title: '回本收益测算',
    desc: '本地部署与官方 API 的 token 价差与回本周期',
    tag: '经营'
  }
}

const cache = new Map()
const pending = new Map()

function hash(str) {
  const s = String(str || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function available() {
  return typeof wx !== 'undefined' &&
    typeof wx.createOffscreenCanvas === 'function' &&
    typeof wx.canvasToTempFilePath === 'function'
}

function keyOf(kind, spec) {
  const s = spec || {}
  return String(kind || '') + ':' + String(s.id || s.title || '')
}

/** 工具海报的固定 spec；未知 key 返回 null */
function toolSpec(key) {
  return TOOL_SPECS[key] || null
}

/** 内容 → 海报字段：商品 / 需求 / 商机 / 工具共用一套映射 */
function specOf(kind, item) {
  const d = item || {}
  const rent = d.isRent === true || /租/.test(String(d.tradeMode || d.kind || ''))
  const isDemand = kind === 'demand' || kind === 'demandRent' || /求购|需求/.test(String(d.kind || ''))
  const hay = [d.cat, d.model, d.name, d.title, d.brand].filter(Boolean).join(' ')
  const title = d.posterTitle || d.title ||
    [d.brand, d.model].filter(Boolean).join(' ') || d.name || d.model || '算力聚合'
  return {
    id: String(d.id || d.key || title),
    badge: d.badge || d.posterBadge || badgeOf(kind, hay, rent, isDemand),
    title: title,
    desc: d.posterDesc || d.desc || d.summary || '',
    qty: d.qty ? String(d.qty) : '',
    unit: d.unit || '台',
    city: d.city || '',
    priceText: d.priceText || d.budgetText || (d.price ? '¥ ' + d.price : ''),
    priceLabel: (d.priceLabel && String(d.priceLabel).length <= 4)
      ? d.priceLabel
      : (isDemand ? '预算' : (d.kind === '代售' ? '报价' : '价格')),
    org: d.org || '',
    tag: d.tag || ''
  }
}

function badgeOf(kind, hay, rent, isDemand) {
  if (kind === 'tool') return '工具'
  if (rent) return '租赁'
  if (isDemand) return '需求'
  if (/内存|DDR\d|HBM|内存条/i.test(hay)) return '内存'
  if (/CPU|EPYC|至强|Xeon|霄龙/i.test(hay)) return 'CPU'
  if (/整机|服务器|工作站|Server/i.test(hay)) return '整机'
  if (/GPU|显卡|加速卡|A100|H100|H200|H800|H20|L40|RTX|4090|5090|MI3|Gaudi/i.test(hay)) return 'GPU'
  return '算力'
}

/** 价格补单位：已是区间 / 面议 / 带斜杠时原样展示，避免「¥ 9,600 以内 / 台」 */
function priceValue(spec) {
  const text = String(spec.priceText || '').trim()
  if (!text) return ''
  if (!spec.unit) return text
  if (/[\/]/.test(text) || /以内|面议|沟通|另议/.test(text)) return text
  return text + ' / ' + spec.unit
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.lineTo(x + w - rad, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad)
  ctx.lineTo(x + w, y + h - rad)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h)
  ctx.lineTo(x + rad, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad)
  ctx.lineTo(x, y + rad)
  ctx.quadraticCurveTo(x, y, x + rad, y)
  ctx.closePath()
}

/** 单行超宽截断 */
function ellipsis(ctx, text, maxWidth) {
  const s = String(text || '')
  if (ctx.measureText(s).width <= maxWidth) return s
  let out = s
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

/** 自动换行：最多 maxLines 行，超出以省略号收尾 */
function wrap(ctx, text, maxWidth, maxLines) {
  const chars = String(text || '').split('')
  const lines = []
  let cur = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (cur && ctx.measureText(cur + ch).width > maxWidth) {
      lines.push(cur.replace(/\s+$/, ''))
      cur = ch
      if (lines.length === maxLines) break
    } else {
      cur += ch
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur.replace(/\s+$/, ''))
  const used = lines.join('').replace(/\s/g, '').length
  const total = String(text || '').replace(/\s/g, '').length
  if (used < total && lines.length) {
    let last = lines[lines.length - 1]
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) {
      last = last.slice(0, -1)
    }
    lines[lines.length - 1] = last + '…'
  }
  return lines.slice(0, maxLines)
}

/** 商品 / 需求按交易方式归到出租、求购等分享口径，缓存 key 才能对齐 */
function shareKindOf(kind, item) {
  const d = item || {}
  if (kind === 'demand') return (d.tradeMode === '租赁' || d.isRent === true) ? 'demandRent' : 'demand'
  if (kind === 'product') return (d.tradeMode === '出租' || d.isRent === true) ? 'productRent' : 'product'
  return kind
}

/** 画一张海报，返回是否成功；全部使用 2d context 接口 */
function draw(canvas, spec) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  const pal = PALETTES[hash(spec.id + '|' + spec.title) % PALETTES.length]

  /* 背景渐变 */
  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, pal[0])
  grad.addColorStop(1, pal[1])
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  /* 半透明圆形装饰 */
  ctx.save()
  ctx.globalAlpha = 0.1
  ctx.fillStyle = '#FFFFFF'
  ctx.beginPath()
  ctx.arc(W - 56, 62, 132, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(52, H + 18, 156, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  /* 网格装饰 */
  ctx.save()
  ctx.globalAlpha = 0.07
  ctx.strokeStyle = '#FFFFFF'
  ctx.lineWidth = 1
  for (let x = 0; x <= W; x += 50) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
    ctx.stroke()
  }
  for (let y = 0; y <= H; y += 50) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }
  ctx.restore()

  /* 顶部品类徽章 */
  ctx.font = 'bold 20px sans-serif'
  ctx.textBaseline = 'middle'
  const badgeW = Math.min(ctx.measureText(spec.badge).width + 34, W - 64)
  roundRect(ctx, 32, 30, badgeW, 38, 19)
  ctx.fillStyle = 'rgba(255,255,255,0.20)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.34)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#FFFFFF'
  ctx.fillText(spec.badge, 49, 50)

  /* 主标题：最多两行 */
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 40px sans-serif'
  const titleLines = wrap(ctx, spec.title, W - 64, 2)
  let ty = 90
  titleLines.forEach((line) => {
    ctx.fillText(line, 32, ty)
    ty += 46
  })

  /* 副标题（工具描述等） */
  let cy = ty + 4
  if (spec.desc) {
    ctx.font = '20px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.72)'
    ctx.fillText(ellipsis(ctx, spec.desc, W - 64), 32, cy)
    cy += 32
  }

  /* 信息行：数量 / 城市 / 价格 / 类型，按传入字段与空间选择性绘制 */
  const rows = []
  if (spec.qty) rows.push(['数量', spec.qty + ' ' + spec.unit])
  if (spec.city) rows.push(['城市', spec.city])
  const price = priceValue(spec)
  if (price) rows.push([spec.priceLabel || '价格', price])
  if (spec.tag) rows.push(['类型', spec.tag])

  const footerTop = H - 56
  let bottom = footerTop - 18
  if (spec.org) {
    ctx.font = '17px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.fillText(ellipsis(ctx, '主体 · ' + spec.org, W - 64), 32, bottom - 20)
    bottom -= 34
  }
  const rowTop = cy + 10
  /* 行高 30，末行还要占约 21 的行高，算完再与字段数取小 */
  const fitRows = Math.floor((bottom - rowTop - 21) / 30) + 1
  const maxRows = Math.max(0, Math.min(rows.length, fitRows))
  rows.slice(0, maxRows).forEach((row, i) => {
    const ry = rowTop + i * 30
    ctx.font = '18px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.60)'
    ctx.fillText(row[0], 32, ry + 2)
    ctx.font = 'bold 21px sans-serif'
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(ellipsis(ctx, row[1], W - 140), 112, ry)
  })

  /* 底部品牌条 */
  ctx.fillStyle = 'rgba(0,0,0,0.20)'
  ctx.fillRect(0, footerTop, W, 56)
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#FFFFFF'
  ctx.font = 'bold 21px sans-serif'
  ctx.fillText(BRAND, 32, footerTop + 29)
  ctx.font = '17px sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.76)'
  const tipW = ctx.measureText(FOOTER).width
  ctx.fillText(FOOTER, W - 32 - tipW, footerTop + 30)
  return true
}

/**
 * 生成海报，返回 Promise<临时文件路径>；失败 / 低版本返回空字符串。
 * 同一 kind + id 命中缓存或正在生成中的任务时直接复用。
 */
function prepare(kind, itemOrSpec) {
  if (!available()) return Promise.resolve('')
  const s = specOf(kind, itemOrSpec || {})
  const key = keyOf(kind, s)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (pending.has(key)) return pending.get(key)

  const task = new Promise((resolve) => {
    let canvas = null
    try {
      canvas = wx.createOffscreenCanvas({ type: '2d', width: W, height: H })
      if (!draw(canvas, s)) {
        resolve('')
        return
      }
    } catch (err) {
      resolve('')
      return
    }
    try {
      wx.canvasToTempFilePath({
        canvas: canvas,
        x: 0,
        y: 0,
        width: W,
        height: H,
        destWidth: W,
        destHeight: H,
        fileType: 'png',
        success: (res) => {
          const path = (res && res.tempFilePath) || ''
          if (path) cache.set(key, path)
          resolve(path)
        },
        fail: () => resolve('')
      })
    } catch (err) {
      resolve('')
    }
  })
  pending.set(key, task)
  return task.then((path) => {
    pending.delete(key)
    return path
  }, () => {
    pending.delete(key)
    return ''
  })
}

/** 同步取已生成的海报；未命中返回空字符串 */
function cached(kind, itemOrSpec) {
  if (!available()) return ''
  return cache.get(keyOf(kind, specOf(kind, itemOrSpec || {}))) || ''
}

function clear(kind, id) {
  const key = String(kind || '') + ':' + String(id || '')
  cache.delete(key)
  pending.delete(key)
}

module.exports = {
  TOOL_SPECS,
  toolSpec,
  specOf,
  shareKindOf,
  prepare,
  cached,
  clear
}
