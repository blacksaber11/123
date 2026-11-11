/* ============================================================
   算力聚合 · 运营中台 · 核心运行时
   —— 路由 / 接口 / 登录 / 框架 / 通用组件 / 图表
   ============================================================ */
(function () {
  'use strict'

  const Console = window.Console = {}
  const TOKEN_KEY = 'hx_console_token'
  const SESSION_KEY = 'hx_console_session'
  const API_URL = '/api/admin'

  const state = Console.state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    account: null,
    pages: [],
    actions: [],
    page: '',
    pageQuery: null,
    busy: false
  }

  /* ---------------- 基础工具 ---------------- */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function num(value) {
    const n = Number(value) || 0
    return n.toLocaleString('zh-CN')
  }
  function money(value, decimals) {
    const n = Number(value) || 0
    const d = decimals === undefined ? (Number.isInteger(n) ? 0 : 2) : decimals
    return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })
  }
  function compact(value) {
    const n = Number(value) || 0
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 2) + ' 亿'
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + ' 万'
    return num(n)
  }
  function pct(value) {
    const n = Number(value) || 0
    return (Math.round(n * 10) / 10).toLocaleString('zh-CN') + '%'
  }
  function pad(n) { return String(n).padStart(2, '0') }
  function dateText(ms) {
    if (!ms) return '—'
    const d = new Date(Number(ms))
    if (isNaN(d.getTime())) return '—'
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  function dayText(ms) {
    if (!ms) return '—'
    const d = new Date(Number(ms))
    if (isNaN(d.getTime())) return '—'
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  function ago(ms) {
    if (!ms) return '—'
    const diff = Date.now() - Number(ms)
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
    if (diff < 30 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前'
    return dayText(ms)
  }
  function initials(name) {
    const text = String(name || '管').trim()
    return esc(text.slice(0, 1).toUpperCase())
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
  function qs(params) {
    return Object.keys(params).filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&')
  }
  function debounce(fn, wait) {
    let timer = 0
    return function () {
      const args = arguments
      clearTimeout(timer)
      timer = setTimeout(() => fn.apply(null, args), wait || 260)
    }
  }
  function bytesText(value) {
    const n = Number(value) || 0
    if (n > 1024 * 1024 * 1024) return (n / 1073741824).toFixed(1) + ' GB'
    if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB'
    return n + ' B'
  }

  /* ---------------- 接口 ---------------- */
  class ApiError extends Error {
    constructor(message, code) { super(message); this.name = 'ApiError'; this.code = code || 'INTERNAL' }
  }

  async function api(action, data) {
    let res
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, data: data || {}, token: state.token })
      })
    } catch (err) {
      throw new ApiError('网络连接失败，请确认本地服务已启动', 'NETWORK')
    }
    let body
    try { body = await res.json() } catch (err) { throw new ApiError('服务返回格式异常', 'INTERNAL') }
    if (!body || body.ok !== true) {
      const code = (body && body.code) || 'INTERNAL'
      const message = (body && body.message) || '操作失败'
      if (code === 'UNAUTHENTICATED') handleUnauthenticated()
      throw new ApiError(message, code)
    }
    return body.data
  }

  function handleUnauthenticated() {
    state.token = ''
    state.account = null
    state.pages = []
    state.actions = []
    clearNavCountTimer()
    clearPageTimer()
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(SESSION_KEY)
    /* 被后台接口判为未登录时给出明确提示，避免用户以为是自己操作错了 */
    if (state.page) { state.page = ''; renderLogin('登录状态已过期，请重新登录') }
  }

  function saveSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ account: state.account, pages: state.pages, actions: state.actions }))
    } catch (err) { /* 忽略存储失败 */ }
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (!raw) return false
      const data = JSON.parse(raw)
      if (!data || !data.account || !Array.isArray(data.pages)) return false
      state.account = data.account
      state.pages = data.pages
      state.actions = Array.isArray(data.actions) ? data.actions : []
      return true
    } catch (err) { return false }
  }

  /* ---------------- 图标 ---------------- */
  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    bolt: '<path d="M13 2 4.5 13.2h6L10 22l8.5-11.2h-6L13 2Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    media: '<path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4Z"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    spark: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 15h6M9 11h2"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3M17 6l3 3M14 9l3 3"/>',
    star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3Z"/>'
  }
  function icon(name, cls) {
    const body = ICONS[name] || ICONS.grid
    return `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = 0
  function toast(message, type) {
    const wrap = document.getElementById('toast')
    if (!wrap) return
    const el = document.createElement('div')
    el.className = 'toast ' + (type || '')
    el.innerHTML = `<span>${type === 'ok' ? icon('check') : type === 'err' ? icon('alert') : icon('spark')}</span><span>${esc(message)}</span>`
    wrap.appendChild(el)
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220) }, 2600)
  }

  /* ---------------- 弹窗 ---------------- */
  function modalRoot() { return document.getElementById('modal') }

  function openModal(opts) {
    const root = modalRoot()
    if (!root) return null
    root.hidden = false
    root.innerHTML = `
      <div class="modal-mask" data-close="1"></div>
      <div class="modal ${opts.wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div class="grow">
            <div class="flex flex-wrap" style="align-items:center;gap:8px"><h3>${esc(opts.title || '')}</h3>${opts.titleTag || ''}</div>
            ${opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : ''}
          </div>
          <button class="close" data-close="1" aria-label="关闭">${icon('close')}</button>
        </div>
        <div class="modal-body">${opts.body || ''}</div>
        ${opts.footer === false ? '' : `<div class="modal-foot">${opts.footer || '<button class="btn" data-close="1">关闭</button>'}</div>`}
      </div>`
    const modalEl = root.querySelector('.modal')
    /* 调用方普遍按 root.body / root.foot 取内容区，这里挂上引用，避免每个页面自己 querySelector */
    modalEl.body = modalEl.querySelector('.modal-body')
    modalEl.foot = modalEl.querySelector('.modal-foot')
    root.onclick = (e) => {
      const hit = e.target.closest('[data-close]')
      if (hit) closeModal()
    }
    document.addEventListener('keydown', escHandler)
    if (typeof opts.onMount === 'function') opts.onMount(modalEl)
    return modalEl
  }
  function escHandler(e) { if (e.key === 'Escape') closeModal() }
  function closeModal() {
    const root = modalRoot()
    if (!root) return
    root.hidden = true
    root.innerHTML = ''
    document.removeEventListener('keydown', escHandler)
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const modal = openModal({
        title: opts.title || '请确认',
        sub: opts.sub || '',
        body: `<div class="small" style="line-height:1.8;color:var(--ink-2)">${opts.message || ''}</div>`,
        footer: `<button class="btn" data-close="1">取消</button><button class="btn ${opts.danger ? 'danger' : 'primary'}" data-confirm="1">${esc(opts.okText || '确认')}</button>`,
        onMount(el) {
          el.querySelector('[data-confirm]').onclick = () => { closeModal(); resolve(true) }
          el.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => resolve(false)))
        }
      })
      if (!modal) resolve(false)
    })
  }

  let drawerEl = null
  function openDrawer(opts) {
    closeDrawer()
    const mask = document.createElement('div')
    mask.className = 'drawer-mask'
    mask.onclick = closeDrawer
    const drawer = document.createElement('div')
    drawer.className = 'drawer'
    drawer.innerHTML = `
      <div class="drawer-head">
        <div class="avatar lg">${initials(opts.avatar || opts.title)}</div>
        <div class="grow">
          <div class="flex flex-wrap" style="align-items:center;gap:8px"><h2>${esc(opts.title || '')}</h2>${opts.titleTag || ''}</div>
          <div class="sub">${opts.sub || ''}</div>
          ${opts.badges ? `<div class="flex flex-wrap" style="margin-top:6px;gap:5px">${opts.badges}</div>` : ''}
        </div>
        <button class="close" aria-label="关闭">${icon('close')}</button>
      </div>
      <div class="drawer-body">${opts.body || ''}</div>
      ${opts.foot ? `<div class="drawer-foot">${opts.foot}</div>` : ''}`
    document.body.appendChild(mask)
    document.body.appendChild(drawer)
    drawer.querySelector('.close').onclick = closeDrawer
    drawerEl = { mask, drawer, body: drawer.querySelector('.drawer-body'), foot: drawer.querySelector('.drawer-foot') }
    document.addEventListener('keydown', drawerEsc)
    return drawerEl
  }
  function drawerEsc(e) { if (e.key === 'Escape') closeDrawer() }
  function closeDrawer() {
    if (!drawerEl) return
    drawerEl.mask.remove()
    drawerEl.drawer.remove()
    drawerEl = null
    document.removeEventListener('keydown', drawerEsc)
  }

  /* ---------------- UI 片段 ---------------- */
  function badge(text, tone, withDot) {
    if (text === undefined || text === null || text === '') return '<span class="badge">—</span>'
    return `<span class="badge ${tone || ''} ${withDot ? 'dot' : ''}">${esc(text)}</span>`
  }
  function autoBadge(text) {
    const value = String(text || '')
    if (!value) return badge('—')
    if (/在售|求购中|已开通|已到账|已处理|已确认|已通过|正常|已上架|已成交|启用/.test(value)) return badge(value, 'ok', true)
    if (/待|处理中|跟进中|洽淡|洽谈|审核|待核验|已对接/.test(value)) return badge(value, 'warn', true)
    if (/驳回|停用|封禁|已退款|已下架|已关闭|已到期|风险|异常/.test(value)) return badge(value, 'danger', true)
    if (/草稿|未开通|未知/.test(value)) return badge(value, '')
    return badge(value, 'info', true)
  }
  function emptyState(title, desc, action) {
    return `<div class="empty"><div class="ico">${icon('file')}</div><b>${esc(title || '暂无数据')}</b><div>${esc(desc || '')}</div>${action ? `<div class="mt12">${action}</div>` : ''}</div>`
  }
  function loadingBlock(text) {
    return `<div class="loading-block"><span class="spinner"></span><span>${esc(text || '正在加载')}</span></div>`
  }
  function pageHead(title, desc, actions) {
    return `<div class="page-head"><div><h2 class="title">${esc(title)}</h2>${desc ? `<div class="desc">${desc}</div>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`
  }
  function delta(value, label) {
    const n = Number(value) || 0
    const cls = n > 0 ? '' : n < 0 ? 'down' : 'flat'
    const arrow = n > 0 ? icon('arrowUp') : n < 0 ? icon('arrowDown') : ''
    return `<span class="delta ${cls}">${arrow}${n > 0 ? '+' : ''}${pct(n)}${label ? ' ' + esc(label) : ''}</span>`
  }

  /* ---------------- 图表 ---------------- */
  function niceMax(value) {
    const n = Number(value) || 0
    if (n <= 0) return 10
    const exp = Math.floor(Math.log10(n))
    const base = Math.pow(10, exp)
    const scaled = n / base
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
    return step * base
  }
  function smoothPath(pts) {
    if (!pts.length) return ''
    if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`
    let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] || p2
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
    }
    return d
  }
  /**
   * 折线图
   * labels: ['11-01', ...]，series: [{name,color,values,area}]
   */
  function lineChart(labels, series, opts) {
    const o = opts || {}
    const w = 760
    const h = o.height || 240
    const padL = o.padL === undefined ? 46 : o.padL
    const padR = 16
    const padT = 16
    const padB = 28
    const list = (series || []).filter((s) => s && s.values && s.values.length)
    if (!list.length || !labels.length) return emptyState('暂无趋势数据', '产生业务数据后自动生成')
    const all = []
    list.forEach((s) => s.values.forEach((v) => all.push(Number(v) || 0)))
    const max = niceMax(Math.max.apply(null, all))
    const n = labels.length
    const innerW = w - padL - padR
    const innerH = h - padT - padB
    const xOf = (i) => padL + (n <= 1 ? innerW / 2 : innerW * i / (n - 1))
    const yOf = (v) => padT + innerH * (1 - (Number(v) || 0) / max)
    const grid = [0, .25, .5, .75, 1].map((r) => {
      const y = padT + innerH * r
      const v = max * (1 - r)
      const text = o.format ? o.format(v) : compact(v)
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="#eef0f6" stroke-width="1"/>
        <text x="${padL - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#98a2b3" font-size="10">${esc(text)}</text>`
    }).join('')
    const step = Math.max(1, Math.ceil(n / 6))
    const xLabels = labels.map((label, i) => {
      if (i % step !== 0 && i !== n - 1) return ''
      return `<text x="${xOf(i).toFixed(1)}" y="${h - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" fill="#98a2b3" font-size="10">${esc(label)}</text>`
    }).join('')
    const defs = `<defs>${list.map((s, idx) => `<linearGradient id="g${idx}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity=".22"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`).join('')}</defs>`
    const paths = list.map((s, idx) => {
      const pts = s.values.map((v, i) => [xOf(i), yOf(v)])
      const d = smoothPath(pts)
      const area = s.area === false ? '' : `<path d="${d} L${xOf(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${xOf(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="url(#g${idx})"/>`
      const last = pts[pts.length - 1]
      const dots = `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.2" fill="#fff" stroke="${s.color}" stroke-width="2"/>`
      return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>${dots}`
    }).join('')
    const hover = list.map((s) => s.values.map((v, i) => `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="8" fill="transparent"><title>${esc(labels[i])} · ${esc(s.name)}：${esc(o.format ? o.format(v) : num(v))}</title></circle>`).join('')).join('')
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="height:${h}px">${defs}${grid}${xLabels}${paths}${hover}</svg>`
  }

  function barChart(items, opts) {
    const o = opts || {}
    const w = 760
    const h = o.height || 220
    const padL = 46, padR = 16, padT = 16, padB = 30
    if (!items.length) return emptyState('暂无数据')
    const max = niceMax(Math.max.apply(null, items.map((i) => Number(i.value) || 0)))
    const innerW = w - padL - padR
    const innerH = h - padT - padB
    const slot = innerW / items.length
    const barW = Math.min(34, slot * .52)
    const grid = [0, .5, 1].map((r) => {
      const y = padT + innerH * r
      return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#eef0f6"/><text x="${padL - 9}" y="${y + 3.5}" text-anchor="end" fill="#98a2b3" font-size="10">${esc(o.format ? o.format(max * (1 - r)) : compact(max * (1 - r)))}</text>`
    }).join('')
    const bars = items.map((item, i) => {
      const value = Number(item.value) || 0
      const bh = innerH * value / max
      const x = padL + slot * i + (slot - barW) / 2
      const y = padT + innerH - bh
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="4" fill="${item.color || '#6366f1'}"><title>${esc(item.label)}：${esc(o.format ? o.format(value) : num(value))}</title></rect>
        <text x="${(x + barW / 2).toFixed(1)}" y="${h - 9}" text-anchor="middle" fill="#98a2b3" font-size="10">${esc(item.label)}</text>`
    }).join('')
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" style="height:${h}px">${grid}${bars}</svg>`
  }

  function progressRows(items) {
    const max = Math.max.apply(null, items.map((i) => Number(i.value) || 0).concat([1]))
    return items.map((item) => `
      <div class="bar-row">
        <span class="name">${esc(item.label)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(2, Math.round((Number(item.value) || 0) / max * 100))}%"></span></span>
        <span class="val">${esc(item.text || compact(item.value))}</span>
      </div>`).join('')
  }

  /* ---------------- 导航配置 ---------------- */
  const NAV = [
    { group: '运营', items: [
      { key: 'dashboard', page: 'stats', label: '数据看板', icon: 'grid', desc: '业务增长与实时指标' },
      { key: 'workbench', page: 'workbench', label: '工作台', icon: 'bolt', desc: '今天要处理的事' }
    ] },
    { group: '业务', items: [
      { key: 'leads', page: 'leads', label: '咨询单', icon: 'bolt', desc: '领取、转派与推进咨询' },
      { key: 'products', page: 'products', label: '商品管理', icon: 'media', desc: '货源审核与上下架' },
      { key: 'demands', page: 'demands', label: '需求管理', icon: 'file', desc: '求购需求审核与关闭' },
      { key: 'biz', page: 'biz', label: '代采代售', icon: 'spark', desc: '委托审核、联系缴费与成交' },
      { key: 'users', page: 'users', label: '用户管理', icon: 'users', desc: '用户档案、商机会员与权限' },
      { key: 'messages', page: 'messages', label: '消息中心', icon: 'chat', desc: '用户留言与客服回复' },
      { key: 'risk', page: 'risk', label: '风险提示', icon: 'shield', desc: '风险单与内容监管' },
      { key: 'media', page: ['boards', 'news'], label: '媒体', icon: 'media', desc: '资讯 / 榜单 / 价格水平' }
    ] },
    { group: '经营', items: [
      { key: 'finance', page: 'finance', label: '财务中心', icon: 'wallet', desc: '收款与营收' },
      { key: 'accounts', page: 'accounts', label: '账号与权限', icon: 'key', desc: '账号、角色与临时权限' },
      { key: 'settings', page: 'settings', label: '设置', icon: 'settings', desc: '规则与平台配置' }
    ] },
    { group: '监督', items: [
      { key: 'audit', page: 'audit', label: '审计日志', icon: 'shield', desc: '谁在什么时候改了什么' },
      { key: 'service', page: 'service', label: '服务记录', icon: 'chat', desc: '客服处置量与跟进明细' },
      { key: 'logs', page: 'logs', label: '系统日志', icon: 'file', desc: '运行日志 / 登录日志' }
    ] }
  ]
  const NAV_FLAT = NAV.reduce((acc, group) => acc.concat(group.items), [])
  const ROLE_LABEL = { admin: '管理员', cs: '客服坐席', finance: '财务专员' }

  function canPage(page) {
    if (!page) return true
    const keys = Array.isArray(page) ? page : [page]
    return keys.some((k) => state.pages.indexOf(k) >= 0)
  }
  /** 页面内按钮级权限：动作不在登录返回的 actions 里就不渲染，避免客服点了才 403 */
  function can(action) {
    if (!action) return true
    if (state.actions.length) return state.actions.indexOf(action) >= 0
    return !!state.account && state.account.role === 'admin'
  }

  function accessibleNav() {
    return NAV.map((group) => ({
      group: group.group,
      items: group.items.filter((item) => canPage(item.page))
    })).filter((group) => group.items.length)
  }
  function navConf(key) {
    return NAV_FLAT.find((item) => item.key === key) || NAV_FLAT[0]
  }
  function firstPage() {
    const groups = accessibleNav()
    return groups.length ? groups[0].items[0].key : 'users'
  }

  /* ---------------- 登录 ---------------- */
  function renderLogin(message) {
    closeDrawer()
    closeModal()
    const root = document.getElementById('root')
    root.innerHTML = `
      <div class="login">
        <section class="login-brand">
          <div class="brand-mark"><span class="brand-logo">算</span><span>算力聚合 · 运营中台</span></div>
          <div class="login-copy">
            <h1>把算力交易<br>做成<em>可运营的生意</em></h1>
            <p>从用户、货盘、代采代售，到会员、收款与风险处置，一套后台完成日常运营闭环。所有对外信息默认脱敏，关键动作全程留痕。</p>
            <div class="login-points">
              <span>用户全生命周期</span><span>商机会员续费</span><span>企微收款对账</span><span>风险自动检测</span>
            </div>
          </div>
          <div class="login-meta">
            <div><b>7</b>运营工作域</div>
            <div><b>全链路</b>行为留痕</div>
            <div><b>0</b>明文联系方式出站</div>
          </div>
        </section>
        <section class="login-panel">
          <form class="login-card" id="login-form" autocomplete="on">
            <h2>登录运营中台</h2>
            <p class="sub">请使用管理员或客服坐席账号登录</p>
            <div class="field">
              <label for="lg-user">账号</label>
              <input id="lg-user" name="username" type="text" placeholder="请输入账号" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="lg-pass">口令</label>
              <input id="lg-pass" name="password" type="password" placeholder="请输入登录口令" autocomplete="current-password" required>
            </div>
            <div class="field">
              <label for="lg-otp">动态口令</label>
              <input id="lg-otp" name="otp" type="text" inputmode="numeric" maxlength="6" placeholder="身份验证器里的 6 位数字" autocomplete="one-time-code" required>
              <details id="lg-otp-help" style="margin-top:8px;font-size:12px;line-height:1.7">
                <summary style="cursor:pointer">没有身份验证器？用 16 位密钥直接生成</summary>
                <div style="margin-top:8px">
                  <div class="flex" style="gap:8px">
                    <input id="lg-otp-secret" class="grow" type="password" placeholder="粘贴 16 位 Base32 密钥" autocomplete="off">
                    <button class="btn" type="button" id="lg-otp-fill">生成并填入</button>
                  </div>
                  <div id="lg-otp-result" class="mt8" hidden></div>
                </div>
              </details>
            </div>
            <button class="btn primary" type="submit" id="lg-submit">进入中台</button>
            <div id="lg-error" class="login-error" hidden></div>
            <div class="login-hint">
              首次使用请联系超级管理员开通账号；「动态口令」填身份验证器每 30 秒刷新的 6 位数字，密钥不填在输入框里。登录行为会记录审计日志。
              <div class="mt8"><a href="javascript:void 0" id="lg-dev">开发环境快捷登录</a></div>
            </div>
          </form>
        </section>
      </div>`
    if (message) {
      const box = document.getElementById('lg-error')
      box.textContent = message
      box.hidden = false
    }
    const form = document.getElementById('login-form')
    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = document.getElementById('lg-submit')
      const errBox = document.getElementById('lg-error')
      errBox.hidden = true
      const payload = {
        username: form.username.value.trim(),
        password: form.password.value,
        otp: form.otp.value.trim()
      }
      if (!payload.username || !payload.password || !payload.otp) {
        errBox.textContent = '请填写账号、口令与动态口令'
        errBox.hidden = false
        return
      }
      btn.disabled = true
      btn.textContent = '正在验证…'
      try {
        const data = await api('admin.login', payload)
        state.token = data.token
        state.account = { name: data.name, role: data.role, org: data.org }
        state.pages = Array.isArray(data.pages) ? data.pages : []
        state.actions = Array.isArray(data.actions) ? data.actions : []
        state.tempPermission = data.tempPermission || null
        localStorage.setItem(TOKEN_KEY, data.token)
        saveSession()
        renderShell()
      } catch (err) {
        errBox.textContent = err.message || '登录失败'
        errBox.hidden = false
        btn.disabled = false
        btn.textContent = '进入中台'
      }
    }
    /* 动态口令助手：浏览器本地算 TOTP，密钥不出本机；方便尚未绑定验证器的人先登进来 */
    const otpHelp = document.getElementById('lg-otp-help')
    const otpSecret = document.getElementById('lg-otp-secret')
    const otpFill = document.getElementById('lg-otp-fill')
    const otpResult = document.getElementById('lg-otp-result')
    let otpTimer = null
    let otpBytes = null

    function base32Bytes(raw) {
      const clean = String(raw || '').toUpperCase().replace(/[\s=]/g, '')
      if (!/^[A-Z2-7]{16,64}$/.test(clean)) return null
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
      let bits = 0
      let value = 0
      const out = []
      for (let i = 0; i < clean.length; i += 1) {
        value = (value << 5) | alphabet.indexOf(clean[i])
        bits += 5
        if (bits >= 8) {
          bits -= 8
          out.push((value >>> bits) & 0xff)
        }
      }
      return new Uint8Array(out)
    }

    async function totpAt(bytes, atMs) {
      const counter = Math.floor(atMs / 30000)
      const msg = new Uint8Array(8)
      const view = new DataView(msg.buffer)
      view.setUint32(0, Math.floor(counter / 0x100000000))
      view.setUint32(4, counter % 0x100000000)
      const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg))
      const offset = sig[sig.length - 1] & 0x0f
      const code = ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) | ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff)
      return String(code % 1000000).padStart(6, '0')
    }

    async function refreshOtp() {
      if (!otpBytes) return
      try {
        const code = await totpAt(otpBytes, Date.now())
        form.otp.value = code
        const left = 30 - Math.floor((Date.now() % 30000) / 1000)
        otpResult.hidden = false
        otpResult.innerHTML = '当前动态口令：<b style="font-family:monospace;font-size:16px;letter-spacing:2px">' + code + '</b>，' + left + ' 秒后刷新（已自动填入上方输入框）'
      } catch (err) {
        otpResult.hidden = false
        otpResult.textContent = '当前浏览器无法本地生成（需要 HTTPS 环境），请改用身份验证器 App。'
      }
    }

    function startOtp() {
      stopOtp()
      if (!otpBytes) return
      refreshOtp()
      otpTimer = setInterval(refreshOtp, 1000)
    }
    function stopOtp() {
      if (otpTimer) clearInterval(otpTimer)
      otpTimer = null
    }
    if (otpFill && otpSecret) {
      otpFill.onclick = () => {
        const bytes = base32Bytes(otpSecret.value)
        if (!bytes) {
          otpResult.hidden = false
          otpResult.textContent = '密钥格式不对：应为 16-64 位 A-Z、2-7 字符（不含 0、1、8、9）。'
          return
        }
        otpBytes = bytes
        startOtp()
      }
      otpHelp.addEventListener('toggle', () => {
        if (otpHelp.open) startOtp()
        else stopOtp()
      })
    }

    const devBtn = document.getElementById('lg-dev')
    /* 线上不存在演示账号，入口直接隐藏，避免点了只报「无法快捷登录」 */
    const isLocalDev = location.protocol === 'file:' ||
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(location.hostname) ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)
    if (!isLocalDev) {
      const wrap = devBtn.parentNode
      if (wrap) wrap.hidden = true
      return
    }
    devBtn.onclick = async () => {
      try {
        const res = await fetch('/api/health')
        const data = await res.json()
        const list = data.demoAccounts || []
        if (!list.length) throw new Error('未获取到演示账号')
        const fill = (acc) => {
          form.username.value = acc.username
          form.password.value = acc.password
          form.otp.value = (data.demoOtps || {})[acc.username] || (data.demoOtps || {})[acc.role] || data.demoOtp || ''
          toast('已填入' + (acc.name || acc.username) + '，点击「进入中台」即可', 'ok')
        }
        if (list.length === 1) {
          fill(list[0])
          return
        }
        /* 三个内置角色各给一个演示号，便于核对页面与按钮级权限 */
        const roleText = { admin: '管理员', cs: '客服坐席', finance: '财务专员' }
        const root = openModal({
          title: '选择演示账号',
          sub: '仅本地开发环境可用，登录后按角色展示页面与操作',
          body: '<div>' + list.map((acc) => {
            return '<div class="list-row" data-role="' + esc(acc.role) + '">' +
              '<div class="grow"><div class="strong">' + esc(acc.name || acc.username) + '</div>' +
              '<div class="small" style="color:var(--ink-3)">' + esc(acc.username) + ' · ' + esc(roleText[acc.role] || acc.role) + '</div></div>' +
              '<span class="btn xs">填入</span></div>'
          }).join('') + '</div>'
        })
        if (!root) return
        root.body.querySelectorAll('[data-role]').forEach((row) => {
          row.onclick = () => {
            const acc = list.find((item) => item.role === row.getAttribute('data-role'))
            if (!acc) return
            fill(acc)
            closeModal()
          }
        })
      } catch (err) {
        toast('当前不是本地开发环境，无法快捷登录', 'err')
      }
    }
  }

  /* ---------------- 侧边栏角标 / 数量 ---------------- */
  let navCountTimer = 0
  function clearNavCountTimer() {
    if (navCountTimer) { clearInterval(navCountTimer); navCountTimer = 0 }
  }
  /* 页面级定时器（消息中心静默刷新等）统一在切页 / 卸载前清理 */
  function clearPageTimer() {
    if (window.__pageTimer) { clearInterval(window.__pageTimer); window.__pageTimer = null }
  }
  window.addEventListener('beforeunload', function () {
    clearNavCountTimer()
    clearPageTimer()
  })
  function paintNav(el, value) {
    if (!el) return
    const n = Number(value) || 0
    el.hidden = n <= 0
    el.textContent = n > 999 ? '999+' : String(n)
  }
  /**
   * 侧边栏口径：
   * - 红色待办角标统一取 admin.todos：工作台 total / 咨询单 leads / 消息 unread / 举报 reports / 风控 risk / 财务 payments / 代采代售 agency
   * - 商品管理 / 需求管理 / 用户管理 / 媒体：白色数字 = 对应总量
   * - admin.todos 不可用时回退到各模块自身的待处理统计
   */
  async function loadNavCounts() {
    if (!state.token) return
    const badgeOf = (key) => document.querySelector('[data-badge="' + key + '"]')
    const countOf = (key) => document.querySelector('[data-nav-count="' + key + '"]')
    const fetchTotal = (action, data) => api(action, data)
      .then((r) => Number(r && r.total) || 0)
      .catch(() => null)
    const jobs = []

    /* 白色总量：保持原有逻辑 */
    if (canPage('products')) {
      jobs.push(fetchTotal('product.list', { page: 1, limit: 1 })
        .then((n) => { if (n !== null) paintNav(countOf('products'), n) }))
    }
    if (canPage('demands')) {
      jobs.push(fetchTotal('demand.list', { page: 1, limit: 1 })
        .then((n) => { if (n !== null) paintNav(countOf('demands'), n) }))
    }
    if (canPage('users')) {
      jobs.push(api('user.list', { page: 1, limit: 1 })
        .then((r) => {
          const s = (r && r.summary) || {}
          paintNav(countOf('users'), s.total != null ? s.total : (r && r.total))
        })
        .catch(() => {}))
    }
    if (canPage('media')) {
      jobs.push(fetchTotal('news.list', { page: 1, limit: 1 })
        .then((n) => { if (n !== null) paintNav(countOf('media'), n) }))
    }

    /* 多个角标共用同一份待处理数据，避免重复请求 */
    let leadPendingP = null
    const leadPending = () => canPage('leads')
      ? (leadPendingP = leadPendingP || fetchTotal('lead.list', { targetType: 'agency', status: '待分配', page: 1, limit: 1 }))
      : Promise.resolve(null)
    let agencyPendingP = null
    const agencyPending = () => canPage('biz')
      ? (agencyPendingP = agencyPendingP || fetchTotal('agency.list', { statuses: ['待审核', '已通过', '待确认'], page: 1, limit: 1 }))
      : Promise.resolve(null)
    let unreadP = null
    const unread = () => canPage('messages')
      ? (unreadP = unreadP || api('msg.threads', {})
        .then((r) => Number(r && r.unread) || 0)
        .catch(() => null))
      : Promise.resolve(null)

    /* 优先一次性拿全红色待办；失败时回退到旧的模块统计口径 */
    let todos = null
    try {
      todos = await api('admin.todos', {})
    } catch (err) { todos = null }

    if (todos) {
      paintNav(badgeOf('workbench'), todos.total)
      paintNav(badgeOf('leads'), todos.leads)
      paintNav(badgeOf('messages'), todos.unread)
      paintNav(badgeOf('reports'), todos.reports)
      paintNav(badgeOf('risk'), todos.risk)
      paintNav(badgeOf('finance'), todos.payments)
      paintNav(badgeOf('biz'), todos.agency)
    } else {
      if (canPage('leads')) {
        jobs.push(leadPending().then((n) => { if (n !== null) paintNav(badgeOf('leads'), n) }))
      }
      if (canPage('biz')) {
        jobs.push(agencyPending().then((n) => { if (n !== null) paintNav(badgeOf('biz'), n) }))
      }
      if (canPage('messages')) {
        jobs.push(unread().then((n) => { if (n !== null) paintNav(badgeOf('messages'), n) }))
      }
      if (canPage('workbench')) {
        jobs.push(Promise.all([leadPending(), agencyPending(), unread()]).then((vals) => {
          const sum = vals.reduce((acc, v) => acc + (Number(v) || 0), 0)
          paintNav(badgeOf('workbench'), sum)
        }))
      }
    }
    await Promise.all(jobs)
  }

  /* ---------------- 应用框架 ---------------- */
  function renderShell() {
    const navGroups = accessibleNav()
    if (!state.page || !navConf(state.page) || !canPage(navConf(state.page).page)) state.page = firstPage()
    const conf = navConf(state.page)
    const account = state.account || { name: '运营账号', role: 'admin' }
    const root = document.getElementById('root')
    root.innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="side-brand">
            <span class="brand-logo">算</span>
            <div><b>算力聚合中台</b><small>OPERATIONS CONSOLE</small></div>
          </div>
          <nav id="main-nav">
            ${navGroups.map((group) => `
              <div class="side-group">
                <div class="side-label">${esc(group.group)}</div>
                ${group.items.map((item) => `
                  <button class="nav-item ${item.key === state.page ? 'on' : ''}" data-nav="${item.key}">
                    <span class="nav-ico">${icon(item.icon)}</span>
                    <span class="nav-text">${esc(item.label)}</span>
                    <span class="nav-badge" data-badge="${item.key}" hidden></span>
                    <span class="nav-count" data-nav-count="${item.key}" hidden></span>
                  </button>`).join('')}
              </div>`).join('')}
          </nav>
          <div class="side-foot">
            <b>${esc(account.name)}</b>
            ${esc(ROLE_LABEL[account.role] || '运营账号')} · 数据仅限内部使用<br>
            所有查看与处置动作均写入审计日志
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <div>
              <div class="crumb">运营中台 / ${esc((NAV.find((g) => g.items.some((i) => i.key === state.page)) || {}).group || '')}</div>
              <h1>${esc(conf.label)}</h1>
            </div>
            <div class="topbar-right">
              <button class="btn ghost" id="btn-refresh" title="刷新当前页">${icon('refresh')}<span>刷新</span></button>
              <div class="account-chip">
                <div><div class="strong" style="font-size:12px">${esc(account.name)}</div></div>
                <span class="role">${esc(ROLE_LABEL[account.role] || '运营')}</span>
                <span class="avatar">${initials(account.name)}</span>
              </div>
              <button class="btn ghost" id="btn-logout" title="退出登录">${icon('logout')}</button>
            </div>
          </header>
          <main class="view" id="view">${loadingBlock('正在进入中台')}</main>
        </div>
      </div>`
    root.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.onclick = () => navigate(btn.getAttribute('data-nav'))
    })
    document.getElementById('btn-refresh').onclick = () => renderPage(true)
    document.getElementById('btn-logout').onclick = async () => {
      const ok = await confirmDialog({ title: '退出登录', message: '退出后需要重新输入口令与动态口令。', okText: '退出' })
      if (!ok) return
      try { await api('admin.logout') } catch (err) { /* 忽略 */ }
      handleUnauthenticated()
      renderLogin()
    }
    renderPage()
    loadNavCounts()
    /* 新咨询单进来后角标要能自己亮起来，不用等用户切页面 */
    clearNavCountTimer()
    navCountTimer = setInterval(loadNavCounts, 60000)
  }

  function navigate(key, query) {
    if (!navConf(key) || !canPage(navConf(key).page)) { toast('当前账号无权访问该页面', 'err'); return }
    state.page = key
    /* 跨页定位参数：例如从工作台「举报反馈」直接落到风险提示的举报 tab */
    state.pageQuery = query && typeof query === 'object' ? Object.assign({}, query) : null
    const hash = '#/' + key
    if (location.hash !== hash) history.replaceState(null, '', hash)
    closeDrawer()
    closeModal()
    const root = document.getElementById('root')
    if (!root.querySelector('.app')) { renderShell(); return }
    root.querySelectorAll('[data-nav]').forEach((btn) => btn.classList.toggle('on', btn.getAttribute('data-nav') === key))
    const group = NAV.find((g) => g.items.some((i) => i.key === key)) || {}
    const conf = navConf(key)
    const crumb = root.querySelector('.topbar .crumb')
    if (crumb) crumb.textContent = '运营中台 / ' + (group.group || '')
    const title = root.querySelector('.topbar h1')
    if (title) title.textContent = conf.label
    renderPage()
  }

  let renderSeq = 0
  async function renderPage(showToast) {
    const view = document.getElementById('view')
    if (!view) return
    const seq = ++renderSeq
    const conf = navConf(state.page)
    const fn = (window.ConsolePages || {})[state.page]
    /* 切页 / 重载前统一清理上一页留下的轮询定时器 */
    clearPageTimer()
    view.innerHTML = loadingBlock('正在加载' + conf.label)
    if (!fn) { view.innerHTML = emptyState('页面未注册', conf.label + ' 模块尚未加载'); return }
    try {
      await fn(view, { refresh: () => renderPage(true), query: state.pageQuery || {} })
      if (seq !== renderSeq) return
      if (showToast) toast('已刷新', 'ok')
      loadNavCounts()
      if (typeof window.Console.onAfterRender === 'function') window.Console.onAfterRender(state.page)
    } catch (err) {
      if (seq !== renderSeq) return
      if (err && err.code === 'UNAUTHENTICATED') return
      view.innerHTML = `<div class="card card-body" style="margin-top:8px">
        <div class="empty"><div class="ico" style="background:var(--danger-soft);color:var(--danger)">${icon('alert')}</div>
        <b>加载失败</b><div>${esc(err.message || '请稍后重试')}</div>
        <div class="mt12"><button class="btn primary" id="retry-page">重新加载</button></div></div></div>`
      const retry = document.getElementById('retry-page')
      if (retry) retry.onclick = () => renderPage()
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    const hash = (location.hash || '').replace(/^#\/?/, '')
    if (hash && navConf(hash)) state.page = hash
    if (!state.token) { renderLogin(); return }
    if (!loadSession()) {
      /* 只有 token 没有账号快照：无法确认页面权限，重新登录 */
      handleUnauthenticated()
      renderLogin('登录状态已更新，请重新登录')
      return
    }
    renderShell()
  }

  Object.assign(Console, {
    api, esc, num, money, compact, pct, dateText, dayText, ago, initials, clamp, qs, debounce, bytesText,
    icon, toast, modal: openModal, closeModal, confirm: confirmDialog, openDrawer, closeDrawer,
    badge, autoBadge, emptyState, loadingBlock, pageHead, delta, lineChart, barChart, progressRows,
    navigate, renderPage, navConf, canPage, can, state, NAV
  })

  /* 暴露页面注册入口 */
  window.ConsolePages = window.ConsolePages || {}

  window.addEventListener('hashchange', () => {
    const key = (location.hash || '').replace(/^#\/?/, '')
    if (key && key !== state.page && navConf(key) && canPage(navConf(key).page)) navigate(key)
  })

  /* 等页面脚本注册完再启动，避免恢复登录态时首屏拿不到模块 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else setTimeout(boot, 0)
})()
