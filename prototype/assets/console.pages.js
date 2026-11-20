/* 运营中台 · 页面实现（数据看板 / 工作台 / 用户管理 / 风险提示 / 媒体 / 设置 / 财务中心） */
(function () {
  'use strict'

  const C = window.Console
  const {
    esc, num, money, compact, pct, dateText, dayText, ago, icon, toast, badge, autoBadge,
    emptyState, loadingBlock, pageHead, delta, lineChart, barChart, progressRows,
    api, state, openDrawer, closeDrawer, modal, closeModal, confirm
  } = C

  const Pages = (window.ConsolePages = window.ConsolePages || {})

  /* ---------------- 基础片段 ---------------- */

  function card(title, body, extra, flush) {
    return '<section class="card"><div class="card-head"><h3>' + esc(title) + '</h3><div class="grow"></div>' +
      (extra || '') + '</div><div class="card-body' + (flush ? ' flush' : '') + '">' + body + '</div></section>'
  }

  function kpi(label, value, foot) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div>' +
      (foot ? '<div class="foot">' + foot + '</div>' : '') + '</div>'
  }

  function kpiRow(items) {
    return '<div class="grid g5">' + items.map(function (i) { return kpi(i[0], i[1], i[2]) }).join('') + '</div>'
  }

  function table(headers, rows, emptyText) {
    const head = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>' }).join('') + '</tr></thead>'
    /* 无数据时保留表头，避免筛选无结果时整块表格「塌陷」 */
    if (!rows || !rows.length) {
      return '<div class="table-wrap"><table class="tbl">' + head +
        '<tbody><tr><td colspan="' + headers.length + '">' + emptyState(emptyText || '暂无数据') + '</td></tr></tbody>' +
        '</table></div>'
    }
    return '<div class="table-wrap"><table class="tbl">' + head +
      '<tbody>' + rows.map(function (r) { return '<tr>' + r + '</tr>' }).join('') +
      '</tbody></table></div>'
  }

  function pager(total, page, limit) {
    const pages = Math.max(1, Math.ceil(Number(total || 0) / limit))
    /* 不足一页时不渲染翻页器，避免「第 1 / 1 页」占位 */
    if (pages <= 1) return ''
    return '<div class="pager"><span>共 ' + num(total) + ' 条 · 第 ' + page + ' / ' + pages + ' 页</span>' +
      '<div class="flex" style="gap:6px">' +
      '<button class="btn xs" data-pg="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<button class="btn xs" data-pg="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
      '</div></div>'
  }

  /* 管理端可见全部内容（含私密发布），此处仅做标识 */
  function isPrivateItem(item) {
    return !!item && (item.visibility === 'private' || item.isPrivate === true)
  }

  function privateTag(text) {
    return badge(text || '私密', 'danger')
  }

  /* 发布方式有三种：普通发布（公开 + 自动匹配）/ 仅发商机池（不进首页，只走匹配）/ 私密发布（仅本人与平台可见） */
  function isPoolOnlyItem(item) {
    return !!item && !isPrivateItem(item) && item.channel === 'pool'
  }

  function poolTag() {
    return badge('仅发商机池', 'ok')
  }

  function channelLabelOf(item) {
    if (isPrivateItem(item)) return '私密发布'
    return isPoolOnlyItem(item) ? '仅发商机池' : '普通发布'
  }

  function wirePager(root, fn) {
    root.querySelectorAll('[data-pg]').forEach(function (btn) {
      btn.onclick = function () {
        const p = Number(btn.getAttribute('data-pg'))
        if (p >= 1) fn(p)
      }
    })
  }

  function wireGo(root) {
    root.querySelectorAll('[data-go]').forEach(function (btn) {
      const tab = btn.getAttribute('data-go-tab')
      btn.onclick = function () { C.navigate(btn.getAttribute('data-go'), tab ? { tab: tab } : null) }
    })
  }

  function options(list, current, allLabel) {
    const head = allLabel === false ? '' : '<option value="">' + esc(allLabel || '全部') + '</option>'
    return head + (list || []).map(function (v) {
      const value = typeof v === 'object' ? v.value : v
      const label = typeof v === 'object' ? v.label : v
      return '<option value="' + esc(value) + '"' + (String(current || '') === String(value) ? ' selected' : '') + '>' + esc(label) + '</option>'
    }).join('')
  }

  function countOf(value) {
    if (Array.isArray(value)) return value.length
    return Number(value) || 0
  }

  /* 金额 + 单位：单位形如「¥ / 台」「₿ / 台 / 月」，符号提前，避免「¥100,000 / ₿ / 台」 */
  function unitMoney(value, unit) {
    const u = String(unit || '').trim()
    if (!u) return money(value)
    const m = u.match(/^([¥$₿€£₹]|[A-Z]{2,5})\s*\/\s*(.+)$/)
    if (!m) return num(value) + ' ' + esc(u)
    return esc(m[1]) + num(value) + ' / ' + esc(m[2])
  }

  /* 价格口径：现场沟通 / 价格区间 / 固定单价，统一带单位展示 */
  function amountOf(item, field, maxField, modeField, unitField) {
    const row = item || {}
    const mode = String(row[modeField] || 'fixed')
    if (mode === 'nego') return '现场沟通'
    const low = Number(row[field]) || 0
    const max = Number(row[maxField]) || 0
    if (!(low > 0)) return '—'
    if (mode === 'range' && max > low) {
      return unitMoney(low, row[unitField]) + ' ~ ' + unitMoney(max, row[unitField])
    }
    return unitMoney(low, row[unitField])
  }

  function kvList(items) {
    return '<div class="kv-grid">' + items.map(function (it) {
      return '<div class="kv"><div class="k">' + esc(it[0]) + '</div><div class="v">' + (it[1] === undefined || it[1] === '' ? '—' : it[1]) + '</div></div>'
    }).join('') + '</div>'
  }

  /**
   * 用户信息块：咨询单 / 商品管理 / 需求管理 / 代采代售四个抽屉共用。
   * 用户ID 与用户端「我的」页同一串，客服可据此检索与开权限。
   * opts.title 自定义标题（咨询单里区分委托方 / 咨询方），opts.hint 附加说明。
   */
  function publisherBlock(user, fallbackUid, opts) {
    const o = opts || {}
    const title = o.title || '发布用户'
    const u = user || {}
    const uid = u.id || fallbackUid || ''
    if (!uid) {
      return '<div class="setting-row"><div class="info"><div class="strong">' + esc(title) + '</div>' +
        '<div class="small" style="color:var(--muted-2)">该记录未关联到用户（历史数据）</div></div></div>'
    }
    const activity = [
      u.publishCount != null ? '发布 ' + num(u.publishCount) + ' 条' : '',
      u.agencyBuy != null ? '代采 ' + num(u.agencyBuy) + ' 单' : '',
      u.agencySell != null ? '代售 ' + num(u.agencySell) + ' 单' : ''
    ].filter(Boolean).join(' · ')
    return '<div class="setting-row"><div class="info">' +
      '<div class="flex" style="align-items:center;gap:8px">' +
        '<div class="strong">' + esc(title) + '</div>' +
        (o.hint ? '<span class="small" style="color:var(--muted-2)">' + esc(o.hint) + '</span>' : '') +
        '<div class="grow"></div>' +
        '<button class="btn xs" data-open-user="' + esc(uid) + '">查看用户资料</button>' +
      '</div>' +
      kvList([
        ['用户ID', u.userNo ? '<span class="mono strong">' + esc(u.userNo) + '</span>' : '—'],
        ['昵称', esc(u.nick || '—')],
        ['主体名称', esc(u.subjectHidden ? '未公开主体' : (u.subject || '未填写')) + (u.subjectType ? ' · ' + esc(u.subjectType) : '')],
        ['城市', esc(u.city || '—')],
        ['手机号', esc(u.phone || u.phoneMasked || (u.phoneSaved ? '已留存，需在用户资料中查看' : '未留存'))],
        ['公开范围', esc(u.exposureLabel || '—')],
        ['会员状态', esc(u.memberStatus || '未开通')],
        ['账号状态', esc(u.status || '正常')],
        ['注册时间', esc(u.joined || '—')],
        ['发布 / 委托', activity || '—']
      ]) + '</div></div>'
  }

  /** 绑定「查看用户资料」按钮：四个抽屉共用同一套跳转逻辑 */
  function wirePublisherLinks(root) {
    if (!root) return
    root.querySelectorAll('[data-open-user]').forEach(function (btn) {
      btn.onclick = function () {
        const uid = btn.getAttribute('data-open-user')
        if (uid) openUserDrawer(uid)
      }
    })
  }

  function filterBar(fields) {
    return '<div class="filters">' + fields.join('') + '</div>'
  }

  function field(label, control) {
    return '<div class="field"><label>' + esc(label) + '</label>' + control + '</div>'
  }

  /* ---------------- 客服常用语 ---------------- */

  /* 按工单阶段区分话术：客服在不同阶段看到对应常用语，消息中心等场景用通用话术 */
  const QUICK_REPLY_DEFAULTS = {
    default: [
      '您好，平台客服已接入，请描述您的问题',
      '收到，我们正在核实，请稍候',
      '已为您登记，处理结果会在这里通知',
      '麻烦提供商品编号或链接，方便定位',
      '该内容已核实并处理，感谢您的反馈',
      '请在消息中心查看最新进展',
      '很抱歉给您带来不便，我们会尽快跟进',
      '如需进一步了解，可随时在这里留言',
      '您的咨询已转交专业顾问，请保持电话畅通',
      '服务已完成，感谢您的评价'
    ],
    communicating: [
      '您好，我是平台客服，已收到您的委托，请补充一下具体需求',
      '请问数量、交期和预算范围大概是多少？',
      '麻烦提供商品编号或链接，方便帮您匹配货源',
      '已记下您的条件，我这边帮您匹配合适的对接方',
      '收到，我们正在核实，请稍候',
      '如需进一步了解，可随时在这里留言'
    ],
    terms: [
      '双方条件已确认，我这边安排居间合同',
      '请核对合同中的价格、数量与交期是否一致',
      '确认无误后请上传签章版居间合同',
      '合同归档后即可进入服务费环节'
    ],
    contract: [
      '已收到居间合同，正在审核，请稍候',
      '合同信息与委托条件不一致，请核对后重新上传',
      '合同审核通过后会通知双方进入下一步'
    ],
    signed: [
      '居间合同已归档，接下来由客服登记成交',
      '请双方按合同约定完成交付，完成后告知我',
      '成交登记后我会通知服务费金额'
    ],
    fee: [
      '成交已登记，请在消息中心查看服务费金额',
      '服务费到账后，工单即进入完成环节',
      '如对服务费有疑问，可直接在这里留言'
    ],
    paid: [
      '服务费已到账，感谢您的配合',
      '请确认本次服务是否已完成，确认后工单归档',
      '后续有新的采购 / 出售需求，随时找我'
    ]
  }

  const QUICK_REPLY_STAGE_LABELS = {
    default: '通用',
    communicating: '沟通中',
    terms: '条件已确认',
    contract: '居间合同待审核',
    signed: '居间合同已归档',
    fee: '服务费待支付',
    paid: '服务费已到账'
  }

  /* 客服的自定义差异（新增 / 删除）按阶段存在本机浏览器，默认话术更新后仍能沿用 */
  const QUICK_REPLY_STORE_KEY = 'hx_quick_replies_v1'

  function quickReplyStore() {
    try {
      const raw = localStorage.getItem(QUICK_REPLY_STORE_KEY)
      const obj = raw ? JSON.parse(raw) : {}
      return obj && typeof obj === 'object' ? obj : {}
    } catch (err) { return {} }
  }

  function saveQuickReplyStore(next) {
    try { localStorage.setItem(QUICK_REPLY_STORE_KEY, JSON.stringify(next)) } catch (err) { /* 隐私模式写入失败时仅当次生效 */ }
  }

  function quickReplyStageOf(stage) {
    return QUICK_REPLY_DEFAULTS[stage] ? stage : 'default'
  }

  function quickReplyDefaultsOf(stage) {
    return QUICK_REPLY_DEFAULTS[quickReplyStageOf(stage)]
  }

  function quickReplyList(stage) {
    const key = quickReplyStageOf(stage)
    const diff = quickReplyStore()[key] || {}
    const removed = Array.isArray(diff.removed) ? diff.removed : []
    const added = Array.isArray(diff.added) ? diff.added : []
    return quickReplyDefaultsOf(key).filter(function (text) { return removed.indexOf(text) < 0 })
      .concat(added.filter(function (text) { return quickReplyDefaultsOf(key).indexOf(text) < 0 }))
  }

  function quickReplyAddText(stage, text) {
    const key = quickReplyStageOf(stage)
    const value = String(text || '').trim()
    if (!value) return false
    if (quickReplyList(key).indexOf(value) >= 0) return false
    const store = quickReplyStore()
    const diff = store[key] || {}
    diff.added = (Array.isArray(diff.added) ? diff.added : []).concat([value]).slice(0, 40)
    store[key] = diff
    saveQuickReplyStore(store)
    return true
  }

  function quickReplyRemoveText(stage, text) {
    const key = quickReplyStageOf(stage)
    const store = quickReplyStore()
    const diff = store[key] || {}
    if (quickReplyDefaultsOf(key).indexOf(text) >= 0) {
      diff.removed = (Array.isArray(diff.removed) ? diff.removed : []).concat([text])
    } else {
      diff.added = (Array.isArray(diff.added) ? diff.added : []).filter(function (t) { return t !== text })
    }
    store[key] = diff
    saveQuickReplyStore(store)
  }

  function quickReplyReset(stage) {
    const key = quickReplyStageOf(stage)
    const store = quickReplyStore()
    delete store[key]
    saveQuickReplyStore(store)
  }

  function quickReplyInner(stage) {
    const key = quickReplyStageOf(stage)
    return '<span class="qr-label">常用语</span>' +
      quickReplyList(key).map(function (text) {
        return '<button type="button" class="qr-chip" data-quick="' + esc(text) + '">' + esc(text) + '</button>'
      }).join('') +
      '<button type="button" class="qr-chip qr-manage" data-quick-edit="1" ' +
      'title="点击后可以编辑常用语：添加或者删除">＋ 编辑常用语</button>'
  }

  /**
   * 常用语条：按阶段取话术，末尾「编辑常用语」可增删。
   * 数据只做展示，点击行为由 wireQuickReplies 绑定。
   */
  function quickReplyBar(stage) {
    const key = quickReplyStageOf(stage)
    return '<div class="quick-replies" data-quick-stage="' + esc(key) + '">' + quickReplyInner(key) + '</div>'
  }

  /** 点击常用语：插到光标处；未聚焦时追加，不覆盖客服已经写好的内容 */
  function insertQuickReply(box, text) {
    if (!box) return
    const value = box.value || ''
    const focused = document.activeElement === box
    const start = focused ? box.selectionStart : null
    const end = focused ? box.selectionEnd : null
    let next
    let caret
    if (focused && start != null && end != null) {
      next = value.slice(0, start) + text + value.slice(end)
      caret = start + text.length
    } else if (value.trim()) {
      next = value.replace(/\s+$/, '') + '\n' + text
      caret = next.length
    } else {
      next = text
      caret = text.length
    }
    box.value = next
    box.focus()
    try { box.setSelectionRange(caret, caret) } catch (err) { /* 部分浏览器不支持 setSelectionRange */ }
  }

  /** 编辑后刷新页面上同阶段的常用语条；输入框引用挂在条上，重绘不丢焦点目标 */
  function refreshQuickReplyBars(stage) {
    const key = quickReplyStageOf(stage)
    document.querySelectorAll('.quick-replies[data-quick-stage="' + key + '"]').forEach(function (bar) {
      const box = bar._quickBox || null
      bar.innerHTML = quickReplyInner(key)
      wireQuickReplyBar(bar, box)
    })
  }

  function wireQuickReplyBar(bar, box) {
    if (!bar) return
    if (box) bar._quickBox = box
    const stage = quickReplyStageOf(bar.getAttribute('data-quick-stage') || 'default')
    bar.querySelectorAll('.qr-chip[data-quick]').forEach(function (chip) {
      if (chip.getAttribute('data-quick-bound') === '1') return
      chip.setAttribute('data-quick-bound', '1')
      chip.onclick = function () { insertQuickReply(bar._quickBox, chip.getAttribute('data-quick') || '') }
    })
    const edit = bar.querySelector('[data-quick-edit]')
    if (edit && edit.getAttribute('data-quick-bound') !== '1') {
      edit.setAttribute('data-quick-bound', '1')
      edit.onclick = function () { openQuickReplyEditor(stage) }
    }
  }

  function quickReplyEditorList(stage) {
    const list = quickReplyList(stage)
    if (!list.length) return '<div class="small" style="color:var(--muted-2);padding:8px 0">该阶段暂无常用语，可在下方添加</div>'
    return list.map(function (text) {
      return '<div class="setting-row" style="align-items:center;gap:8px">' +
        '<div class="info"><div class="small" style="line-height:1.6;color:var(--ink-2)">' + esc(text) + '</div></div>' +
        '<button class="btn xs" data-qr-del="' + esc(text) + '">删除</button></div>'
    }).join('')
  }

  /** 常用语编辑弹窗：添加 / 删除当前阶段话术，可恢复默认 */
  function openQuickReplyEditor(stage) {
    const key = quickReplyStageOf(stage)
    const label = QUICK_REPLY_STAGE_LABELS[key] || '通用'
    const root = modal({
      title: '编辑常用语',
      sub: '当前阶段：' + label + ' · 仅影响你自己看到的常用语',
      body: '<div id="qr-list" style="max-height:320px;overflow:auto">' + quickReplyEditorList(key) + '</div>' +
        '<div style="margin-top:14px">' +
        '<input id="qr-input" maxlength="80" placeholder="输入新的常用语，如：已为您安排专属顾问，请保持电话畅通">' +
        '</div>' +
        '<div class="small" style="margin-top:8px;color:var(--muted-2);line-height:1.7">' +
        '删除后点「恢复默认」可还原该阶段默认话术；常用语保存在当前浏览器，换设备需重新设置。</div>',
      footer: '<button class="btn" data-close="1">关闭</button>' +
        '<button class="btn" id="qr-reset">恢复默认</button>' +
        '<button class="btn primary" id="qr-add">添加常用语</button>'
    })
    if (!root) return
    const listBox = root.body.querySelector('#qr-list')
    const input = root.body.querySelector('#qr-input')
    function repaint() {
      listBox.innerHTML = quickReplyEditorList(key)
      bindList()
      refreshQuickReplyBars(key)
    }
    function bindList() {
      listBox.querySelectorAll('[data-qr-del]').forEach(function (btn) {
        btn.onclick = function () {
          quickReplyRemoveText(key, btn.getAttribute('data-qr-del'))
          repaint()
        }
      })
    }
    bindList()
    root.foot.querySelector('#qr-add').onclick = function () {
      if (!quickReplyAddText(key, input.value)) {
        toast(input.value.trim() ? '该常用语已存在' : '请输入新的常用语', 'err')
        return
      }
      input.value = ''
      input.focus()
      repaint()
    }
    root.foot.querySelector('#qr-reset').onclick = function () {
      quickReplyReset(key)
      repaint()
    }
  }

  /** 绑定常用语条：阶段由 quickReplyBar(stage) 写在条上，未识别的阶段回落到通用话术 */
  function wireQuickReplies(root, targetSel) {
    if (!root) return
    const box = root.querySelector(targetSel)
    root.querySelectorAll('.quick-replies').forEach(function (bar) { wireQuickReplyBar(bar, box) })
  }

  /* ---------------- 设置与套餐 ---------------- */

  const DEFAULT_PLANS = [
    { key: 'month', label: '月卡', days: 30, price: 99, original: 99 },
    { key: 'quarter', label: '季卡', days: 90, price: 268, original: 297 },
    { key: 'half', label: '半年卡', days: 180, price: 499, original: 594 },
    { key: 'year', label: '年卡', days: 365, price: 899, original: 1188 }
  ]
  let settingsCache = null

  async function loadSettings(force) {
    if (settingsCache && !force) return settingsCache
    const data = await api('setting.get', {})
    settingsCache = (data && data.settings) || {}
    return settingsCache
  }

  /**
   * 套餐列表：始终输出四档，按 key 用后台配置覆盖默认值。
   * 历史库里若只存了一档（旧版本写入 / 手工改库），也不会让开通弹窗只剩月卡。
   */
  function planList(settings) {
    const src = settings && Array.isArray(settings.plans) ? settings.plans : []
    const byKey = {}
    src.forEach(function (p) {
      const key = String((p && p.key) || '')
      if (key) byKey[key] = p
    })
    return DEFAULT_PLANS.map(function (def) {
      const p = byKey[def.key] || {}
      const price = Number(p.price) || def.price
      return {
        key: def.key,
        label: p.label || def.label,
        days: Number(p.days) || def.days,
        price: price,
        original: Number(p.original) || price
      }
    })
  }

  function planCard(p, active) {
    const save = p.original > p.price ? Math.round(p.original - p.price) : 0
    return '<button type="button" class="plan-card' + (active ? ' on' : '') + '" data-plan="' + esc(p.key) + '">' +
      '<span class="p-label">' + esc(p.label) + ' · ' + p.days + ' 天</span>' +
      '<span class="p-price">' + money(p.price) + '</span>' +
      (save > 0
        ? '<span class="p-cut">原价 ' + money(p.original) + '</span><span class="p-save">省 ' + money(save) + '</span>'
        : '<span class="p-cut">按 30 天折算</span>') +
      '</button>'
  }

  function userQuery(prefix, placeholder) {
    return '<div class="field full"><label>选择用户</label>' +
      '<div class="flex"><input id="' + prefix + '-q" placeholder="' + esc(placeholder || '昵称 / 手机号 / 用户ID') + '">' +
      '<button class="btn" id="' + prefix + '-go" type="button">' + icon('search') + '<span>搜索</span></button></div>' +
      '<div id="' + prefix + '-list" style="margin-top:8px;max-height:190px;overflow:auto"></div>' +
      '<div id="' + prefix + '-picked" class="small" style="margin-top:6px;color:var(--muted-2)"></div></div>'
  }

  function wireUserQuery(root, prefix, picked) {
    const input = root.querySelector('#' + prefix + '-q')
    const list = root.querySelector('#' + prefix + '-list')
    const info = root.querySelector('#' + prefix + '-picked')
    if (!input) return
    async function run() {
      const kw = input.value.trim()
      if (!kw) return
      list.innerHTML = loadingBlock('搜索中')
      try {
        const data = await api('user.list', {
          q: kw,
          phone: /^\d{5,}$/.test(kw) ? kw : '',
          page: 1,
          limit: 8
        })
        const items = (data && data.items) || []
        if (!items.length) {
          list.innerHTML = '<div class="small" style="color:var(--muted-2)">没有匹配的用户</div>'
          return
        }
        list.innerHTML = items.map(function (u) {
          return '<div class="list-row" data-uid="' + esc(u.id) + '" data-nick="' + esc(u.nick) + '">' +
            '<div class="grow"><div class="strong">' + esc(u.nick) + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(u.userNo || '—') + ' · ' + esc(u.id) + ' · ' + esc(u.city || '城市未知') + '</div></div>' +
            '<span class="btn xs">选择</span></div>'
        }).join('')
        list.querySelectorAll('[data-uid]').forEach(function (row) {
          row.onclick = function () {
            picked.uid = row.getAttribute('data-uid')
            picked.nick = row.getAttribute('data-nick')
            info.innerHTML = '已选：<b>' + esc(picked.nick) + '</b> · ' + esc(picked.uid)
            list.querySelectorAll('[data-uid]').forEach(function (r) { r.classList.remove('picked') })
            row.classList.add('picked')
          }
        })
      } catch (err) {
        list.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }
    root.querySelector('#' + prefix + '-go').onclick = run
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); run() } }
  }

  /* 开通 / 续费会员：四档套餐 + 自定义天数，写 bizOrders 并给用户发站内信 */
  async function openGrantModal(opts) {
    const o = opts || {}
    const settings = await loadSettings()
    const plans = planList(settings)
    const picked = { uid: o.uid || '', nick: o.nick || '' }
    let planKey = plans[0].key

    const body = (picked.uid
      ? '<div class="card card-body" style="margin-bottom:12px"><div class="strong">' + esc(picked.nick || picked.uid) + '</div>' +
        '<div class="small" style="color:var(--muted-2)">' + esc(picked.uid) + '</div></div>'
      : userQuery('g', '搜索要开通会员的用户')) +
      '<div class="plan-grid" id="g-plans">' + plans.map(function (p, i) { return planCard(p, i === 0) }).join('') + '</div>' +
      '<div class="form-grid" style="margin-top:14px">' +
      field('开通天数', '<input id="g-days" type="number" min="1" max="3650" value="' + plans[0].days + '">') +
      field('实收金额（元）', '<input id="g-amount" type="number" min="0" step="0.01" value="' + plans[0].price + '">') +
      field('备注', '<input id="g-note" placeholder="如：客服补偿开通，工单 #1234">') +
      '</div>' +
      '<div class="small" style="margin-top:10px;color:var(--muted-2);line-height:1.7">未到期按剩余时长顺延，已到期从当天重新计算；确认后立即写入会员订单并通知用户。</div>'

    const root = modal({
      title: o.uid ? '开通 / 续费会员' : '为指定用户开通会员',
      sub: '四档套餐由「设置 · 商机会员价格」统一维护',
      body: body,
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="g-ok">确认开通</button>'
    })
    if (!root) return
    if (!picked.uid) wireUserQuery(root.body, 'g', picked)

    const daysInput = root.body.querySelector('#g-days')
    const amountInput = root.body.querySelector('#g-amount')

    function selectPlan(key) {
      planKey = key
      const p = plans.filter(function (x) { return x.key === key })[0]
      if (!p) return
      root.body.querySelectorAll('[data-plan]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-plan') === key)
      })
      daysInput.value = p.days
      amountInput.value = p.price
    }
    root.body.querySelectorAll('[data-plan]').forEach(function (b) {
      b.onclick = function () { selectPlan(b.getAttribute('data-plan')) }
    })

    /* 按钮渲染在 modal-foot 里，必须从 root.foot 取，否则拿不到元素、点击无响应 */
    root.foot.querySelector('#g-ok').onclick = async function () {
      if (!picked.uid) return toast('请先选择用户', 'err')
      const days = Number(daysInput.value)
      const amount = Number(amountInput.value)
      if (!days || days < 1) return toast('开通天数不正确', 'err')
      const btn = this
      btn.disabled = true
      try {
        await api('biz.grant', {
          uid: picked.uid,
          plan: planKey,
          days: days,
          amount: amount,
          note: root.body.querySelector('#g-note').value.trim()
        })
        closeModal()
        toast('会员已开通，用户已收到站内信')
        if (typeof o.onDone === 'function') o.onDone()
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  /* ---------------- 1. 数据看板 ---------------- */

  const METRICS = {
    business: { label: '业务全景', series: [['咨询线索', '#4f46e5', 'leads'], ['完成成交', '#16a34a', 'deals']] },
    users: { label: '用户增长', series: [['新增用户', '#4f46e5', 'newUsers'], ['日活', '#0ea5e9', 'dau']] },
    goods: { label: '供需发布', series: [['新增货源', '#f59e0b', 'products'], ['新增需求', '#8b5cf6', 'demands']] },
    revenue: { label: '营收', money: true, series: [['营收（元）', '#16a34a', 'revenue']] }
  }

  function trendKpis(trend) {
    const t = trend.totals || {}
    const g = trend.growth || {}
    return kpiRow([
      ['今日活跃', compact(t.dauToday), delta(g.dau, '较上期')],
      ['新增用户', compact(t.newUsers), delta(g.newUsers, '较上期')],
      ['咨询线索', compact(t.leads), delta(g.leads, '较上期')],
      ['完成成交', compact(t.deals), '<span class="small" style="color:var(--muted-2)">近 ' + trend.days + ' 天</span>'],
      ['累计营收', money(t.revenue, 0), delta(g.revenue, '较上期')]
    ])
  }

  /* 停留时长文案：秒 / 分 / 小时，看板按会话均值展示 */
  function durationText(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
    if (total < 60) return total + ' 秒'
    const m = Math.floor(total / 60)
    if (m < 60) return m + ' 分'
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
  }

  /* 宏观经营概览：此刻盘面 + 累计营收，放在看板最上方 */
  function macroKpis(macro) {
    const o = macro.online || {}
    const st = macro.stay || {}
    const rev = macro.revenue || {}
    const foot = function (text) { return '<span class="small" style="color:var(--muted-2)">' + text + '</span>' }
    return '<div class="grid g5">' +
      kpi('实时在线', num(o.count), foot('近 5 分钟有心跳')) +
      kpi('在线比例', pct(o.rate), foot('注册 ' + compact(o.usersTotal) + ' 人')) +
      kpi('平均停留', durationText(st.avgMs), foot('今日 ' + num(st.sessions) + ' 段会话')) +
      kpi('今日营收', money(rev.today, 0), foot('近 30 天 ' + money(rev.last30, 0))) +
      kpi('累计营收', money(rev.total, 0), foot('客单价 ' + money(rev.avgOrder, 0) + ' · ' + num(rev.orders) + ' 单')) +
      '</div>'
  }

  Pages.dashboard = async function (view) {
    const results = await Promise.all([
      api('stats.overview', {}),
      api('finance.summary', { days: 30 }),
      api('insights.board', {}),
      api('insights.boards', { scope: 'all', limit: 6 }),
      api('risk.cases', { status: '待处理', limit: 5 })
    ])
    const ov = results[0] || {}
    const fin = results[1] || {}
    const hot = results[2] || {}
    const boards = results[3] || {}
    const risks = results[4] || {}
    /* 宏观概览单独取：自定义角色没有该动作时降级为 0，不影响整页其他模块 */
    let macro = {}
    try { macro = await api('stats.macro', {}) } catch (err) { macro = {} }
    let days = 30
    let metric = 'business'
    let trend = await api('stats.trend', { days: days })

    view.innerHTML = pageHead('数据看板', '实时在线、停留、供需、成交与营收的全局盘面',
      '<div class="seg" id="d-days">' + [7, 30, 90].map(function (d) {
        return '<button data-days="' + d + '"' + (d === 30 ? ' class="on"' : '') + '>近 ' + d + ' 天</button>'
      }).join('') + '</div>') +
      '<div id="d-macro">' + macroKpis(macro) + '</div>' +
      '<div class="small" style="color:var(--muted-2);margin:6px 0 16px">在线与停留数据每 30 秒自动刷新</div>' +
      '<div id="d-kpis">' + trendKpis(trend) + '</div>' +
      '<div class="grid g-side" style="margin-top:16px">' +
      '<section class="card"><div class="card-head"><h3>业务趋势</h3><div class="grow"></div>' +
      '<div class="seg" id="d-metric">' + Object.keys(METRICS).map(function (k) {
        return '<button data-metric="' + k + '"' + (k === metric ? ' class="on"' : '') + '>' + METRICS[k].label + '</button>'
      }).join('') + '</div></div><div class="card-body"><div id="d-chart"></div><div class="legend" id="d-legend"></div></div></section>' +
      '<div class="grid" style="gap:16px">' +
      card('转化漏斗', '<div id="d-funnel"></div>') +
      card('平台概况', kvList([
        ['在架货源', num(ov.productsOnSale) + ' / ' + num(ov.products)],
        ['在架需求', num(ov.demandsOpen) + ' / ' + num(ov.demands)],
        ['风险拦截', num(ov.blocked) + ' 条'],
        ['启用规则', num(ov.rulesEnabled) + ' 条'],
        ['累计线索', num((ov.leads || {}).total)],
        ['线索转化', pct((ov.conversion || {}).rate)]
      ])) +
      '</div></div>' +
      '<div class="grid g2" style="margin-top:16px">' +
      card('营收趋势（近 6 个月）', '<div id="d-rev"></div><div id="d-rev-mix" style="margin-top:12px"></div>') +
      card('风险待处理', '<div id="d-risk"></div>', '<button class="btn xs" data-go="risk">查看全部</button>') +
      '</div>' +
      '<div class="grid g2" style="margin-top:16px">' +
      card('热门搜索', '<div id="d-hotsearch"></div>') +
      card('热销货盘', '<div id="d-hotlist"></div>', '<button class="btn xs" data-go="media">媒体</button>') +
      '</div>'

    function drawTrend() {
      const conf = METRICS[metric]
      const series = conf.series.map(function (s) {
        return {
          name: s[0],
          color: s[1],
          values: (trend.series || []).map(function (row) { return Number(row[s[2]]) || 0 })
        }
      })
      const labels = (trend.series || []).map(function (row) { return String(row.date || '').slice(5) })
      view.querySelector('#d-chart').innerHTML = lineChart(labels, series, {
        height: 252,
        format: conf.money ? function (v) { return money(v, 0) } : undefined
      })
      view.querySelector('#d-legend').innerHTML = conf.series.map(function (s) {
        return '<span><i style="background:' + s[1] + '"></i>' + esc(s[0]) + '</span>'
      }).join('')
    }

    function drawFunnel() {
      const funnel = trend.funnel || []
      view.querySelector('#d-funnel').innerHTML = funnel.length
        ? progressRows(funnel.map(function (f) {
          return { label: f.label, value: f.value, text: compact(f.value) + ' · ' + pct(f.rate) }
        }))
        : emptyState('暂无漏斗数据')
    }

    function drawRevenue() {
      const months = (fin.months || []).slice(-6)
      view.querySelector('#d-rev').innerHTML = barChart(months.map(function (m) {
        return { label: String(m.month || m.label || ''), value: Number(m.revenue) || 0, color: '#4f46e5' }
      }), { height: 214, format: function (v) { return money(v, 0) } })
    }

    /* 营收构成：会员续费 + 委托服务费，与顶部今日 / 累计营收同一口径 */
    function drawRevMix() {
      const rev = macro.revenue || {}
      view.querySelector('#d-rev-mix').innerHTML = kvList([
        ['会员续费', money(rev.member, 0) + ' · ' + num(rev.memberOrders) + ' 单'],
        ['委托服务费', money(rev.fee, 0) + ' · ' + num(rev.feeCount) + ' 单'],
        ['本月营收', money(rev.month, 0)],
        ['付费会员', num(rev.payers) + ' 人'],
        ['有效会员', num(rev.activeMembers) + ' 人']
      ])
    }

    function drawRisk() {
      const items = risks.items || []
      view.querySelector('#d-risk').innerHTML = items.length
        ? items.map(function (r) {
          const tone = r.level === '高' ? 'danger' : r.level === '中' ? 'warn' : ''
          return '<div class="list-row"><div class="grow"><div class="strong">' + esc(r.ruleLabel || r.detail || '风险') + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(r.type || '') + ' · ' + esc(r.targetLabel || r.targetId || '') + ' · ' + esc(r.createdText || '') + '</div></div>' +
            badge(r.level || '低', tone, true) + '</div>'
        }).join('')
        : emptyState('暂无待处理风险', '规则命中后会自动进入这里')
    }

    function drawHotSearch() {
      const items = (hot.hotSearches || []).slice(0, 6)
      view.querySelector('#d-hotsearch').innerHTML = items.length
        ? items.map(function (it, i) {
          return '<div class="rank-item"><span class="rank-no ' + (i < 3 ? 'top' + (i + 1) : '') + '">' + (i + 1) + '</span>' +
            '<span class="grow">' + esc(it.word || it.label || '') + '</span><span class="small" style="color:var(--muted-2)">' + num(it.count) + '</span></div>'
        }).join('')
        : emptyState('暂无搜索数据')
    }

    function drawHotList() {
      const list = []
      ;(boards.boards || []).forEach(function (b) {
        (b.items || []).forEach(function (it) { list.push(it) })
      })
      list.sort(function (a, b) { return (Number(b.views) || 0) - (Number(a.views) || 0) })
      const items = list.slice(0, 6)
      view.querySelector('#d-hotlist').innerHTML = items.length
        ? items.map(function (it, i) {
          return '<div class="rank-item"><span class="rank-no ' + (i < 3 ? 'top' + (i + 1) : '') + '">' + (i + 1) + '</span>' +
            '<span class="grow"><div class="strong" style="font-size:13px">' + esc(it.model || it.title || '') + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(it.city || '') + ' · 浏览 ' + num(it.views) + ' · 咨询 ' + num(it.consults) + '</div></span></div>'
        }).join('')
        : emptyState('暂无货盘')
    }

    drawTrend()
    drawFunnel()
    drawRevenue()
    drawRevMix()
    drawRisk()
    drawHotSearch()
    drawHotList()
    wireGo(view)

    /* 在线人数 / 停留 / 营收按 30 秒刷新；只重画宏观块，避免整页跳动 */
    if (window.__pageTimer) { clearInterval(window.__pageTimer); window.__pageTimer = null }
    window.__pageTimer = setInterval(async function () {
      const box = view.querySelector('#d-macro')
      if (!box) { clearInterval(window.__pageTimer); window.__pageTimer = null; return }
      try {
        macro = await api('stats.macro', {})
        box.innerHTML = macroKpis(macro)
        drawRevMix()
      } catch (err) { /* 单次刷新失败保留上一次数据，等下一轮 */ }
    }, 30000)

    view.querySelectorAll('#d-days [data-days]').forEach(function (btn) {
      btn.onclick = async function () {
        days = Number(btn.getAttribute('data-days'))
        view.querySelectorAll('#d-days [data-days]').forEach(function (b) { b.classList.toggle('on', b === btn) })
        view.querySelector('#d-kpis').innerHTML = loadingBlock('统计中')
        try {
          trend = await api('stats.trend', { days: days })
          view.querySelector('#d-kpis').innerHTML = trendKpis(trend)
          drawTrend()
          drawFunnel()
        } catch (err) {
          toast(err.message, 'err')
        }
      }
    })
    view.querySelectorAll('#d-metric [data-metric]').forEach(function (btn) {
      btn.onclick = function () {
        metric = btn.getAttribute('data-metric')
        view.querySelectorAll('#d-metric [data-metric]').forEach(function (b) { b.classList.toggle('on', b === btn) })
        drawTrend()
      }
    })
  }

  /* ---------------- 2. 工作台 ---------------- */

  function sectionHead(title, goKey, goText) {
    return '<div class="flex" style="justify-content:space-between;align-items:center;margin:16px 0 6px">' +
      '<div class="strong">' + esc(title) + '</div>' +
      (goKey ? '<button class="btn xs ghost" data-go="' + goKey + '">' + esc(goText || '查看全部') + '</button>' : '') + '</div>'
  }

  /* 委托状态文案：只保留真正需要跟进的阶段，旧状态合并到同一口径
     待确认 → 待审核；已通过 / 已锁定 → 对接中；待确认成交 → 交易中。
     原始 status 仍保留给操作判断，这里只影响展示。 */
  const AGENCY_STATUS_DISPLAY = {
    待审核: '待审核',
    待确认: '待审核',
    已通过: '对接中',
    已上架: '对接中',
    已锁定: '对接中',
    待确认成交: '交易中',
    已成交: '交易中',
    已完成: '已完成',
    已关闭: '已关闭',
    已驳回: '已驳回'
  }

  function agencyStatusText(itemOrStatus) {
    if (itemOrStatus && typeof itemOrStatus === 'object') {
      if (agencyExpired(itemOrStatus)) return '已到期'
      const raw = String(itemOrStatus.status || itemOrStatus.statusText || '')
      return AGENCY_STATUS_DISPLAY[raw] || raw
    }
    const raw = String(itemOrStatus || '')
    return AGENCY_STATUS_DISPLAY[raw] || raw
  }

  /* 旧数据兼容：DEAL_PENDING（待确认成交）只可能来自升级前的委托，
     现在不能再直接确认成交，只能在工单中心按流程登记成交 */
  function agencyDealPending(item) {
    if (!item) return false
    if (item.dealPending === true) return true
    if (String(item.status || '') === '待确认成交') return true
    return /待确认成交|待成交确认|dealPending/i.test(String(item.statusText || ''))
  }

  /* 成交只能走工单流程：有工单时直接带去工单中心，没有工单则等用户发起咨询 */
  function agencyLeadButton(item) {
    if (item && item.consultLeadId) {
      return '<button class="btn primary" data-act="ticket">去工单中心登记成交</button>'
    }
    return '<button class="btn" disabled title="该委托还没有咨询工单，需用户发起咨询后才能走成交流程">等待用户发起咨询</button>'
  }

  /* 是否已到期：到期后状态为已关闭，后端用 closeReason「已到截止时间」与 expired 标记区分 */
  function agencyExpired(item) {
    if (!item) return false
    if (item.expired === true) return true
    if (String(item.closeReason || '') === '已到截止时间') return true
    return /已到期|expired/i.test(String(item.statusText || item.status || ''))
  }

  function agencyOrderBadge(itemOrStatus) {
    const text = agencyStatusText(itemOrStatus)
    let tone = {
      待审核: 'warn', 对接中: 'ok', 交易中: 'info', 已完成: 'ok',
      已到期: 'danger', 已驳回: 'danger', 已关闭: ''
    }[text]
    if (!tone) {
      if (/已到期|驳回|关闭/.test(text)) tone = 'danger'
      else if (/待/.test(text)) tone = 'warn'
      else if (/已完成|对接中/.test(text)) tone = 'ok'
      else if (/交易中/.test(text)) tone = 'info'
    }
    return badge(text, tone || '', true)
  }

  /** 图片放大预览：审核时不必下载，点开即可核对 */
  function previewImage(url) {
    if (!url) return
    const el = document.createElement('div')
    el.className = 'img-lightbox'
    el.innerHTML = '<img src="' + esc(url) + '" alt="预览">'
    el.onclick = function () { el.remove() }
    document.body.appendChild(el)
  }

  /** 聊天媒体续期：点开图片 / 视频前调用 msg.mediaOpen，成功后保留期 7 天延长到 30 天 */
  async function mediaKeep(id) {
    if (!id) return true
    try {
      await api('msg.mediaOpen', { id: id })
      return true
    } catch (err) {
      /* 已过期 / 无权查看时只提示，不打开预览 */
      toast(err.message || '图片/视频已过期，无法查看', 'err')
      return false
    }
  }

  /** 给聊天容器绑定媒体交互：图片点击先续期再放大，视频首次播放时续期 */
  function mediaBind(root) {
    if (!root) return
    root.querySelectorAll('[data-media-id]').forEach(function (el) {
      const id = el.getAttribute('data-media-id')
      if (!id) return
      if (el.tagName === 'VIDEO') {
        el.addEventListener('play', function () { mediaKeep(id) }, { once: true })
        return
      }
      el.onclick = async function () {
        if (!(await mediaKeep(id))) return
        previewImage(el.getAttribute('data-img'))
      }
    })
  }

  /** 聊天媒体上传：/api/upload?kind=chat 用登录令牌鉴权，返回可直接发送的 https 链接 */
  async function mediaUpload(file) {
    const fd = new FormData()
    fd.append('file', file)
    let res
    try {
      res = await fetch('/api/upload?kind=chat', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token },
        body: fd
      })
    } catch (err) {
      throw new Error('网络连接失败，请重试')
    }
    let body
    try { body = await res.json() } catch (err) { throw new Error('上传返回格式异常') }
    if (!body || body.ok !== true) throw new Error((body && body.message) || '上传失败，请重试')
    const fileId = body.data && body.data.fileId
    if (!fileId) throw new Error('上传失败，请重试')
    return fileId
  }

  /** 合同扫描件 / 服务费凭证上传：走资质目录（PDF ≤20MB、图片 ≤10MB），返回 fileId */
  async function docUpload(file) {
    const fd = new FormData()
    fd.append('file', file)
    let res
    try {
      res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.token },
        body: fd
      })
    } catch (err) {
      throw new Error('网络连接失败，请重试')
    }
    let body
    try { body = await res.json() } catch (err) { throw new Error('上传返回格式异常') }
    if (!body || body.ok !== true) throw new Error((body && body.message) || '上传失败，请重试')
    const data = body.data || {}
    if (!data.fileId) throw new Error('上传失败，请重试')
    return { fileId: data.fileId, name: file.name || '扫描件', size: Number(data.size) || file.size || 0 }
  }

  /** 聊天文件类型：按 MIME 或扩展名判断图片 / 视频，无法识别返回空 */
  function chatMediaKindOf(file) {
    if (!file) return ''
    const type = String(file.type || '')
    const name = String(file.name || '')
    if (/^image\//i.test(type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(name)) return 'image'
    if (/^video\//i.test(type) || /\.(mp4|mov|m4v)$/i.test(name)) return 'video'
    return ''
  }

  /** 聊天媒体校验：服务端按文件头识别，这里按可支持格式与大小时限提前拦截 */
  function chatMediaError(file, kind) {
    if (!file) return '请选择要发送的文件'
    if (kind === 'image') {
      const okImage = /^image\/(jpeg|png|webp)$/i.test(file.type || '') || /\.(jpe?g|png|webp)$/i.test(file.name || '')
      if (!okImage) return '图片仅支持 JPG / PNG / WEBP'
      if (file.size > 10 * 1024 * 1024) return '图片不能超过 10MB'
    } else {
      /* 服务端按文件头识别，MP4 / MOV / M4V 都支持；iPhone 相册多为 MOV */
      const okVideo = /^video\/(mp4|quicktime|x-m4v)$/i.test(file.type || '') || /\.(mp4|mov|m4v)$/i.test(file.name || '')
      if (!okVideo) return '视频仅支持 MP4 / MOV 格式'
      if (file.size > 50 * 1024 * 1024) return '视频不能超过 50MB'
    }
    return ''
  }

  /** 平台给用户发图片 / 视频：先校验大小再上传，成功后复用 msg.reply 发送并刷新会话 */
  async function mediaSendToUser(uid, kind, file, threadId) {
    if (!file) return
    const invalid = chatMediaError(file, kind)
    if (invalid) return toast(invalid, 'err')
    toast(kind === 'image' ? '正在上传图片…' : '正在上传视频…')
    try {
      const url = await mediaUpload(file)
      const payload = { uid: uid, kind: kind }
      /* 咨询会话必须带 threadId，后端据此校验领取归属 */
      if (threadId) payload.threadId = threadId
      payload[kind] = url
      await api('msg.reply', payload)
      toast(kind === 'image' ? '图片已发送' : '视频已发送')
      /* 发送后强制刷新并回到底部，沿用文本回复的刷新逻辑 */
      MSG_BOX.scrollTop = null
      MSG_BOX.scrollUid = ''
      openMsgThread(uid)
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  /** 上传材料面板：左栏直接展示图片 / 视频，右侧填写内容用于逐项核对 */
  function mediaPanel(source) {
    return '<div class="rev-side">' +
      '<div class="rev-col-hd">上传材料<span class="small" style="color:var(--muted-2)">（点击图片可放大）</span></div>' +
      '<div class="rev-media" id="o-media-' + esc(source) + '">' + loadingBlock('加载原件') + '</div>' +
      '<div class="small" style="margin-top:10px;color:var(--muted-2);line-height:1.7">图片直接展示，视频与文档可在线打开；如原件较多可滚动查看。</div>' +
      '</div>'
  }

  /**
   * 拉取记录自身的上传材料并渲染：
   * source = agency / product / demand，后端只解析该记录内登记的 fileId。
   */
  function loadMediaPanel(root, item, source) {
    const box = root && root.querySelector('#o-media-' + source)
    if (!box) return
    const meta = Array.isArray(item.media) ? item.media : []
    if (!meta.length) {
      box.innerHTML = '<div class="rev-media-empty">该用户未上传材料</div>'
      return
    }
    api('media.fileUrls', { id: item.id, source: source }).then(function (data) {
      const items = (data && data.items) || []
      if (!items.length) {
        box.innerHTML = '<div class="rev-media-empty">已登记 ' + num(meta.length) + ' 份材料，但原件不可预览</div>'
        return
      }
      box.innerHTML = items.map(function (m) {
        const url = m.url || ''
        const name = esc(m.name || '材料')
        const isVideo = /^video/i.test(m.type || '') || /\.(mp4|mov|m4v)$/i.test(m.name || '')
        /* 委托材料在发布页只允许选图片，历史记录没有 type 时按图片展示 */
        const isImage = source === 'agency' || /^image/i.test(m.type || '') || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(m.name || '')
        let inner = ''
        if (!url) {
          inner = '<div class="rev-media-missing">原件不可预览</div>'
        } else if (isVideo) {
          inner = '<video class="rev-video" src="' + esc(url) + '" controls preload="metadata"></video>'
        } else if (isImage) {
          inner = '<img class="rev-img" src="' + esc(url) + '" data-full="' + esc(url) + '" alt="' + name + '">'
        } else {
          inner = '<a class="rev-file" href="' + esc(url) + '" target="_blank" rel="noopener">打开原件</a>'
        }
        return '<div class="rev-media-item">' + inner + '<div class="rev-media-name">' + name + '</div></div>'
      }).join('')
      box.querySelectorAll('img[data-full]').forEach(function (img) {
        img.onclick = function () { previewImage(img.getAttribute('data-full')) }
      })
    }).catch(function (err) {
      box.innerHTML = '<div class="rev-media-empty" style="color:var(--danger)">' + esc(err.message || '原件加载失败') + '</div>'
    })
  }

  /**
   * 代采代售详情里的「谁咨询了这单」：按委托单反查咨询工单。
   * 客服能直接看到咨询人、领取坐席与工单状态，便于多任务分派与催办。
   */
  async function renderAgencyLeads(box, item) {
    if (!box) return
    const info = box.querySelector('.info')
    if (!info) return
    const head = function (text) {
      return '<div class="flex" style="align-items:center;gap:8px"><div class="strong">咨询 / 对接记录</div>' +
        '<span class="small" style="color:var(--muted-2)">' + esc(text) + '</span></div>'
    }
    let data = null
    try {
      data = await api('lead.list', { agencyId: item.id, page: 1, limit: 20 })
    } catch (err) {
      info.innerHTML = head(err.message || '加载失败')
      return
    }
    const rows = (data && data.items) || []
    if (!rows.length) {
      info.innerHTML = head('共 0 条') +
        '<div class="small" style="color:var(--muted-2)">还没有用户咨询这单。上架后用户在小程序点「咨询」会生成一条待领取工单，客服在这里领取并跟进。</div>'
      return
    }
    const cells = rows.map(function (l) {
      const who = esc(l.consultNick || '咨询方') +
        (l.consultUid ? '<div class="small mono" style="color:var(--muted-2)">' + esc(l.consultUid) + '</div>' : '')
      const staff = l.assignedTo ? esc(l.assignedTo) : '<span class="small" style="color:var(--warn)">待领取</span>'
      /* 标准流程走到第几步 + 当前阶段 + 归属客服，管理员在委托详情里直接看进度 */
      const stepIdx = l.serviceStage ? cfStepIndex(l.serviceStage) : -1
      const progress = l.serviceStage
        ? badge(l.serviceStageLabel || cfStageText(l.serviceStage), cfTone(l.serviceStage)) +
          '<div class="small" style="color:var(--muted-2)">第 ' + (stepIdx + 1) + '/' + CF_STAGES.length + ' 步</div>'
        : '<span class="small" style="color:var(--muted-2)">未开始</span>'
      /* 咨询记录整行可点进入工单，不在表格正文里放「处理」按钮 */
      return '<tr class="row-link" data-lead="' + esc(l.id) + '"><td>' + who + '</td>' +
        '<td class="small">' + esc(l.source || l.sideLabel || LEAD_SOURCE_LABEL[l.targetType] || '代采代售') + '</td>' +
        '<td>' + badge(l.status, LEAD_TONE[l.status] || '') + '</td>' +
        '<td>' + progress + '</td>' +
        '<td class="small">' + staff + '</td>' +
        '<td class="small">' + esc(ago(l.createdAt)) + '</td></tr>'
    })
    info.innerHTML = head('共 ' + num((data && data.total) || rows.length) + ' 条，点任意一行进入咨询工单') +
      '<div class="table-wrap" style="margin-top:8px"><table class="tbl"><thead><tr>' +
      ['咨询人', '来源', '状态', '服务进度', '领取客服', '提交时间'].map(function (h) { return '<th>' + h + '</th>' }).join('') +
      '</tr></thead><tbody>' + cells.join('') + '</tbody></table></div>'
    info.querySelectorAll('[data-lead]').forEach(function (btn) {
      btn.onclick = function () {
        openLeadDrawer(btn.getAttribute('data-lead'), function () { renderAgencyLeads(box, item) })
      }
    })
  }

  function openAgencyOrder(item, onDone) {
    /* 代采 / 代售工单的发布用户：字段来自 agency.list 的 owner* / 主体资料 */
    const ownerUser = {
      id: item.ownerId || '',
      userNo: item.ownerUserNo || '',
      nick: item.ownerNick || '',
      subject: item.subjectMasked || '',
      subjectType: item.ownerSubjectType || '',
      city: item.ownerCity || '',
      exposureLabel: item.exposureLabel || '',
      memberStatus: item.ownerMemberStatus || '',
      joined: item.ownerJoined || '',
      phoneMasked: item.phoneMasked || '',
      phoneSaved: !!item.phoneMasked
    }
    const right =
      publisherBlock(ownerUser, item.ownerId) +
      '<div class="setting-row" style="margin-top:4px"><div class="info"><div class="strong">填写内容</div>' +
      kvList([
        ['委托用户', esc(item.ownerNick || item.ownerId || '') + (item.ownerUserNo ? ' · ' + esc(item.ownerUserNo) : '')],
        ['预留手机号', esc(item.phoneMasked || '—')],
        ['授权书联系人电话', esc(item.authPhoneMasked || '—')],
        ['币种', esc(item.currencyLabel || '人民币')],
        ['交易方式', esc(item.mode || '') + (item.term ? ' · ' + esc(item.term) : '')],
        ['设备型号', esc(item.item || '')],
        ['数量 / 城市', num(item.qty) + ' 台 · ' + esc(item.city || '不限')],
        ['预算单价', money(item.price)],
        ['预算总额', money(item.amount)],
        ['服务费', money(item.serviceFee)],
        ['主体类型', esc(item.subjectType || '—')],
        ['主体名称', esc(item.subjectMasked || '—')],
        ['法人 / 联系人', esc(item.legalMasked || '—')],
        ['信用代码', esc(item.creditMasked || '—')],
        ['联系人证件', esc(item.idCardMasked || '—')],
        ['曝光方式', esc(item.exposureLabel || '—')],
        ['提交时间', esc(item.createdText || '')],
        ['审核时间', esc(item.approvedText || '—')],
        ['审核人', esc(item.staff || '—')],
        ['截止时间', esc(item.deadlineText || item.deadline || (item.expiresAt ? dateText(item.expiresAt) : '—'))],
        ['费用状态', esc(item.feeStatusText || '—')],
        ['成交金额', item.dealAmountText ? esc(item.dealAmountText) : '—'],
        ['平台确认成交', item.dealConfirmedAt ? esc(dateText(item.dealConfirmedAt)) + (item.dealConfirmedBy ? ' · ' + esc(item.dealConfirmedBy) : '') : (agencyDealPending(item) ? '<span style="color:var(--warn)">待补确认（旧数据）</span>' : '—')],
        ['完成时间', esc(item.completedText || '—')],
        ['工单编号', '<span class="mono small">' + esc(item.id) + '</span>']
      ]) + '</div></div>' +
      (String(item.detail || '').trim()
        ? '<div class="setting-row"><div class="info"><div class="strong">需求说明</div>' +
          '<div class="small" style="color:var(--muted-2);white-space:pre-wrap;line-height:1.7">' + esc(item.detail) + '</div></div></div>'
        : '') +
      '<div class="setting-row" id="o-lead-box"><div class="info"><div class="strong">咨询 / 对接记录</div>' +
      '<div class="small" style="color:var(--muted-2)">加载中…</div></div></div>' +
      '<div class="setting-row"><div class="info"><div class="strong">交易流程</div>' +
      ((item.flowNodes || []).length
        ? (item.flowNodes || []).map(function (node) {
            let label = node.label || node.title || node.text || ''
            if (label === '已关闭' && agencyExpired(item)) label = '已到期'
            const extra = [node.atText || node.timeText || '', node.staffText || '', node.stateText || node.status || ''].filter(Boolean).join(' · ')
            return '<div class="small" style="color:var(--muted-2);line-height:1.8">' + esc(label) + (extra ? ' · ' + esc(extra) : '') + '</div>'
          }).join('')
        : '<div class="small" style="color:var(--muted-2)">' + ((item.flow || []).length ? esc(item.flow.join('；')) : '未填写（按平台标准流程）') + '</div>') +
      '</div></div>' +
      '<div class="setting-row"><div class="info"><div class="strong">必要条件</div>' +
      '<div class="small" style="color:var(--muted-2)">' + ((item.must || []).length ? esc(item.must.join('；')) : '未填写') + '</div></div></div>' +
      '<div class="setting-row"><div class="info"><div class="strong">可协商条件</div>' +
      '<div class="small" style="color:var(--muted-2)">' + ((item.nego || []).length ? esc(item.nego.join('；')) : '未填写') + '</div></div></div>' +
      '<div class="setting-row"><div class="info"><div class="strong">费用口径</div>' +
      '<div class="small" style="color:var(--muted-2)">' + esc(item.feeRule || '—') + (item.feeNote ? ' · ' + esc(item.feeNote) : '') + '</div></div></div>' +
      (item.reviewNote || item.reason
        ? '<div class="setting-row"><div class="info"><div class="strong">审核意见</div><div class="small">' + esc(item.reviewNote || item.reason) + '</div></div></div>'
        : '') +
      /* 用户提交修改后委托会临时下架，平台通过时按待审内容覆盖并重新上架 */
      (item.editPending
        ? '<div class="setting-row"><div class="info"><div class="strong">委托修改待审核</div>' +
          '<div class="small" style="color:var(--warn)">用户提交了修改，委托已临时下架；点「通过」将更新为：' + esc(item.pendingItem || '（见待审内容）') + '，并重新上架。</div>' +
          '<div class="small" style="color:var(--muted-2)">点「打回」则保持原上架内容不变，理由会通过站内信发送给用户。</div></div></div>'
        : '') +
      /* 委托详情内嵌对话：无历史会话也能直接发第一条消息；支持拖拽 / 选择图片、视频 */
      '<div class="setting-row"><div class="info" style="min-width:0"><div class="flex" style="align-items:center;justify-content:space-between;gap:8px">' +
      '<div class="strong">用户咨询对话</div><span class="small" style="color:var(--muted-2)">' + (item.ownerId ? '发送后用户可在小程序「消息」查看' : '缺少发布人用户 ID') + '</span></div>' +
      '<div class="agency-chat" id="o-chat-box">' +
        '<div class="agency-chat-head"><span class="small" id="o-chat-count">可直接发送第一条消息</span>' +
        '<button class="btn xs" id="o-chat-refresh">刷新</button></div>' +
        '<div class="chat-stream agency-chat-stream" id="o-chat-stream"><div class="agency-chat-empty">暂无咨询对话，输入消息或拖入图片 / 视频即可发起对话</div></div>' +
        '<div class="agency-chat-drop" id="o-chat-drop">拖拽图片 / 视频到这里，松手加入待发送</div>' +
        '<div class="chat-preview" id="o-chat-preview" hidden></div>' +
        quickReplyBar() +
        '<textarea id="o-chat-input" rows="3" maxlength="500" placeholder="回复 ' + esc(item.ownerNick || '用户') + '（最多 500 字）"></textarea>' +
        '<input type="file" id="o-chat-img-file" accept="image/jpeg,image/png,image/webp" multiple hidden>' +
        '<input type="file" id="o-chat-video-file" accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v" multiple hidden>' +
        '<div class="flex" style="justify-content:flex-end;gap:8px;margin-top:8px">' +
          '<button class="btn xs" id="o-chat-pick-image">图片</button>' +
          '<button class="btn xs" id="o-chat-pick-video">视频</button>' +
          '<button class="btn xs primary" id="o-chat-send">发送</button>' +
        '</div>' +
      '</div></div></div>'

    const body =
      '<div class="flex" style="gap:8px;align-items:center;margin-bottom:12px">' +
      '<div class="strong" style="font-size:15px">' + esc(item.kind || '代采') + '工单 · ' + esc(item.item || '') + '</div>' +
      agencyOrderBadge(item) + '</div>' +
      '<div class="rev-split">' + mediaPanel('agency') + '<div class="rev-main">' + right + '</div></div>' +
      '<div class="small" style="margin-top:14px;color:var(--muted-2);line-height:1.8">' +
      (item.status === '待审核'
        ? '请按左图右文逐项核对：材料与填写内容一致即点「通过」，通过后委托立即上架，无需再确认付款；有问题的点「打回」并填写理由，理由会通过站内信发送给用户。'
        : agencyDealPending(item)
          ? '这是升级前的「待确认成交」旧数据，不能再直接确认成交；请到工单中心按「合同归档 → 登记成交」完成，若该委托已无工单，请联系技术处理。'
          : agencyExpired(item)
            ? '该委托已到期，不再展示；如需继续合作请与委托方确认后重新发布。'
            : item.status === '已锁定'
              ? '唯一对接方已确定（居间合同上传后、审核前手动锁定）：委托已从商机池下架，同委托其他对接方的工单已结束并通知「已售出」。成交需到工单中心由客服按流程登记，委托方只收通知。'
              : '审核通过即自动上架，平台等待用户发起咨询。成交必须走工单流程：确定唯一对接方 → 居间合同归档 → 客服登记成交 → 服务费到账 → 确认完成；平台不提供直接成交入口。') +
      '查看完整联系方式会记入操作日志。</div>'

    let foot = '<button class="btn" data-close="1">关闭</button>'
    /* 平台修改 / 下架：仅管理员可用，审核通过后委托方不能再随意改，改由平台统一维护 */
    const canManage = C.can('agency.update') && ['待审核', '待确认', '已通过', '已上架'].indexOf(item.status) >= 0
    if (item.status === '待审核' || item.status === '待确认') {
      foot += '<button class="btn danger" data-act="reject">打回</button><button class="btn primary" data-act="approve">通过</button>'
    } else if (agencyDealPending(item)) {
      /* 旧数据：不再直接确认成交，转到工单中心按流程完成 */
      foot += '<button class="btn" data-act="contact">查看联系方式</button>'
      foot += agencyLeadButton(item)
    } else if (item.status === '已上架' || item.status === '已通过' || item.status === '已锁定') {
      /* 成交必须走工单：确定对接方 → 合同归档 → 客服登记成交，不提供直接成交入口 */
      foot += '<button class="btn" data-act="contact">查看联系方式</button>'
      foot += agencyLeadButton(item)
    } else if (item.status === '已成交') {
      /* 已成交：服务费到账与完成确认都在工单中心闭环，委托详情不再提供手动完成 */
      foot += '<button class="btn" data-act="contact">查看联系方式</button>'
    } else if (item.status === '已完成') {
      foot += '<button class="btn" data-act="contact">查看联系方式</button>'
    }
    if (item.status !== '已关闭' && item.status !== '已驳回') {
      foot += '<button class="btn" data-act="chats">对话</button>'
    }
    if (canManage) foot += '<button class="btn" data-act="edit">平台修改</button>'
    if (item.status === '已上架' && C.can('agency.offline')) foot += '<button class="btn danger" data-act="offline">下架</button>'

    const root = openDrawer({
      title: (item.kind || '代采') + '工单 · 人工核对',
      sub: esc(item.ownerNick || item.ownerId || '') + (item.ownerUserNo ? ' · ' + esc(item.ownerUserNo) : '') + ' · 提交于 ' + esc(item.createdText || ''),
      badges: agencyOrderBadge(item),
      body: body,
      foot: foot
    })
    if (!root) return
    wirePublisherLinks(root.body)
    loadMediaPanel(root.body, item, 'agency')
    renderAgencyLeads(root.body.querySelector('#o-lead-box'), item)

    function done(text) {
      closeDrawer()
      toast(text || '已处理')
      if (typeof onDone === 'function') onDone()
    }

    function reject() {
      const m = modal({
        title: '打回工单',
        sub: '打回理由会通过站内信发送到用户端，用户修改后可重新提交',
        body: '<div class="field"><label>打回理由（必填）</label>' +
          '<textarea id="o-reason" rows="4" maxlength="100" placeholder="例如：营业执照与主体名称不一致 / 预算与型号不匹配 / 缺少委托授权书"></textarea></div>' +
          '<div class="small" style="margin-top:8px;color:var(--muted-2)">请写清需要修改的具体位置，用户会原样看到这条理由。</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="o-reject-ok">确认打回</button>'
      })
      if (!m) return
      m.foot.querySelector('#o-reject-ok').onclick = async function () {
        const note = m.body.querySelector('#o-reason').value.trim()
        if (!note) return toast('请填写打回理由', 'err')
        this.disabled = true
        try {
          await api('agency.review', { id: item.id, decision: '驳回', note: note })
          closeModal()
          done('已打回，理由已发送到用户端')
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }

    async function approve() {
      const ok = await confirm({
        title: '核对通过并上架',
        message: '通过后委托立即上架并进入商机池，平台开始等待用户咨询，无需再确认付款。',
        okText: '通过并上架'
      })
      if (!ok) return
      try {
        await api('agency.review', { id: item.id, decision: '通过' })
        done('已通过并上架，用户可在小程序看到该委托')
      } catch (err) {
        toast(err.message, 'err')
      }
    }

    async function contact() {
      const ok = await confirm({
        title: '查看完整联系方式',
        message: '仅用于本次联系用户，查看记录会写入操作日志。',
        okText: '确认查看'
      })
      if (!ok) return
      try {
        const data = await api('agency.reveal', { id: item.id, reason: '审核通过后联系委托方' })
        modal({
          title: '委托方联系方式',
          sub: '本次查看已记入操作日志',
          body: kvList([
            ['联系电话', '<span class="strong" style="font-size:16px">' + esc(data.phone || '—') + '</span>'],
            ['主体名称', esc(data.subject || '—')],
            ['法人 / 联系人', esc(data.legal || '—')],
            ['设备型号', esc(item.item || '')],
            ['需求数量', num(item.qty) + ' 台'],
            ['预算总额', money(item.amount)]
          ]) + '<div class="small" style="margin-top:12px;color:var(--muted-2);line-height:1.8">联系时请确认型号、数量、交付城市与付款方式；谈定后到工单中心按流程登记成交，由平台确认并通知委托方支付服务费。</div>',
          footer: '<button class="btn primary" data-close="1">已记录</button>'
        })
      } catch (err) {
        toast(err.message, 'err')
      }
    }

    /* 成交不再由委托页直接确认：跳转到工单中心，按「合同归档 → 登记成交」推进 */
    function ticket() {
      if (!item.consultLeadId) return toast('该委托还没有咨询工单', 'err')
      closeDrawer()
      C.navigate('consult', { leadId: item.consultLeadId })
    }

    /* 委托对话：走委托专属的 agency.chats / agency.reply（targetType=agency），
       按发布人 ownerId 建立会话；没有历史会话也能直接发第一条；
       图片 / 视频复用 mediaUpload 上传后再走 agency.reply */
    const CHAT = {
      agencyId: String(item.id || ''),
      uid: String(item.ownerId || ''),
      files: [],
      seq: 0,
      loaded: false,
      nick: item.ownerNick || '用户'
    }
    const chatBox = root.body.querySelector('#o-chat-box')
    const chatStream = root.body.querySelector('#o-chat-stream')
    const chatPreview = root.body.querySelector('#o-chat-preview')
    const chatInput = root.body.querySelector('#o-chat-input')
    const chatCount = root.body.querySelector('#o-chat-count')
    const chatSendBtn = root.body.querySelector('#o-chat-send')

    /* 常用语：点一下填入回复框，客服可先改再发 */
    wireQuickReplies(root.body, '#o-chat-input')

    function chatMessageHtml(m) {
      const fromStaff = m.from === 'staff' || m.from === 'admin'
      const time = m.createdAt || m.at || ''
      return '<div class="chat-bubble' + (fromStaff ? ' me' : '') + '">' +
        '<div class="meta">' + esc(fromStaff ? (m.staffName || '平台客服') : (m.nick || CHAT.nick || '用户')) +
        (time ? ' · ' + esc(dateText(time)) : '') + '</div>' +
        msgContentHtml(m, { uid: CHAT.uid, nick: CHAT.nick }) +
        '</div>'
    }

    function renderChatMessages(items, info) {
      if (!chatStream) return
      if (!items || !items.length) {
        chatStream.innerHTML = '<div class="agency-chat-empty">暂无咨询对话，输入消息或拖入图片 / 视频即可发起对话</div>'
        return
      }
      chatStream.innerHTML = items.map(function (m) { return chatMessageHtml(m) }).join('')
      mediaBind(chatStream)
      chatStream.scrollTop = chatStream.scrollHeight
      if (info && info.nick) CHAT.nick = info.nick
    }

    function appendChatMessage(m) {
      if (!chatStream) return
      const empty = chatStream.querySelector('.agency-chat-empty')
      if (empty) chatStream.innerHTML = ''
      chatStream.insertAdjacentHTML('beforeend', chatMessageHtml(m))
      mediaBind(chatStream)
      chatStream.scrollTop = chatStream.scrollHeight
      CHAT.loaded = true
    }

    async function loadChats(silent) {
      if (!CHAT.uid) {
        if (chatStream) chatStream.innerHTML = '<div class="agency-chat-empty" style="color:var(--danger)">该委托缺少发布人用户 ID，无法发起对话</div>'
        return
      }
      if (!silent && chatStream) chatStream.innerHTML = '<div class="agency-chat-empty">正在读取历史消息…</div>'
      try {
        /* 优先读取委托专属会话（targetType=agency），不受消息中心跟进入口限制 */
        const data = await api('agency.chats', { id: CHAT.agencyId })
        const threads = (data && data.threads) || []
        const target = threads.filter(function (t) { return String(t.uid) === CHAT.uid })[0] || threads[0]
        const items = (target && target.messages) || []
        CHAT.loaded = true
        if (chatCount) chatCount.textContent = '共 ' + num(items.length) + ' 条' + (target && target.userName ? ' · ' + target.userName : '')
        renderChatMessages(items, { nick: target && target.userName })
      } catch (err) {
        if (silent) return
        /* 兜底：读取该用户与平台的历史客服会话（含旧版本发出的消息） */
        try {
          const data = await api('msg.list', { uid: CHAT.uid, page: 1, limit: 30 })
          const list = (data && data.items) || []
          CHAT.loaded = true
          if (chatCount) chatCount.textContent = '共 ' + num((data && data.total) || list.length) + ' 条' + (data && data.nick ? ' · ' + data.nick : '')
          renderChatMessages(list, data)
        } catch (err2) {
          if (chatStream) chatStream.innerHTML = '<div class="agency-chat-empty" style="color:var(--danger)">' + esc(err.message || '对话加载失败') + '</div>'
        }
      }
    }

    /* 待发送文件：图片用本地 objectURL 出缩略图，视频显示文件名，可逐个取消 */
    function renderChatPreview() {
      if (!chatPreview) return
      chatPreview.hidden = !CHAT.files.length
      chatPreview.innerHTML = CHAT.files.map(function (f) {
        const thumb = f.kind === 'image' && f.preview
          ? '<img src="' + esc(f.preview) + '" alt="待发送图片">'
          : '<div class="chat-preview-file">' + (f.kind === 'video' ? '视频' : '文件') + '</div>'
        return '<div class="chat-preview-item">' + thumb +
          '<div class="chat-preview-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
          '<button class="chat-preview-del" data-remove="' + esc(f.id) + '" title="取消">×</button></div>'
      }).join('')
      chatPreview.querySelectorAll('[data-remove]').forEach(function (btn) {
        btn.onclick = function () { removeChatFile(btn.getAttribute('data-remove')) }
      })
    }

    function removeChatFile(id) {
      CHAT.files = CHAT.files.filter(function (f) {
        if (f.id !== id) return true
        if (f.preview) URL.revokeObjectURL(f.preview)
        return false
      })
      renderChatPreview()
    }

    function addChatFiles(fileList) {
      const files = Array.prototype.slice.call(fileList || [])
      let added = 0
      files.forEach(function (file) {
        const kind = chatMediaKindOf(file)
        if (!kind) return toast('仅支持图片或视频：' + (file.name || ''), 'err')
        const invalid = chatMediaError(file, kind)
        if (invalid) return toast(invalid + '：' + (file.name || ''), 'err')
        CHAT.seq += 1
        CHAT.files.push({
          id: 'chat-file-' + CHAT.seq,
          file: file,
          kind: kind,
          name: file.name || (kind === 'image' ? '图片' : '视频'),
          preview: kind === 'image' ? URL.createObjectURL(file) : ''
        })
        added += 1
      })
      renderChatPreview()
      if (added) toast('已加入 ' + added + ' 个待发送文件')
    }

    /* 拖拽：dragover 高亮，dragleave 取消，drop 接收多文件；抽屉其他区域也阻止浏览器直接打开文件 */
    function hasFileDrag(e) {
      const dt = e.dataTransfer
      if (!dt) return false
      const types = dt.types || []
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true
      }
      return false
    }

    if (chatBox) {
      let dragDepth = 0
      chatBox.addEventListener('dragenter', function (e) {
        if (!hasFileDrag(e)) return
        e.preventDefault()
        e.stopPropagation()
        dragDepth += 1
        chatBox.classList.add('drag-on')
      })
      chatBox.addEventListener('dragover', function (e) {
        if (!hasFileDrag(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      })
      chatBox.addEventListener('dragleave', function (e) {
        /* 子元素间移动会连续触发 dragenter / dragleave，用计数避免高亮闪烁 */
        e.preventDefault()
        e.stopPropagation()
        dragDepth = Math.max(0, dragDepth - 1)
        if (!dragDepth) chatBox.classList.remove('drag-on')
      })
      chatBox.addEventListener('drop', function (e) {
        e.preventDefault()
        e.stopPropagation()
        dragDepth = 0
        chatBox.classList.remove('drag-on')
        addChatFiles(e.dataTransfer && e.dataTransfer.files)
      })
      root.drawer.addEventListener('dragover', function (e) {
        if (hasFileDrag(e)) e.preventDefault()
      })
      root.drawer.addEventListener('drop', function (e) {
        if (hasFileDrag(e)) e.preventDefault()
      })
    }

    async function sendChat() {
      if (chatSendBtn && chatSendBtn.disabled) return
      if (!CHAT.agencyId || !CHAT.uid) return toast('该委托缺少发布人用户 ID，无法发起对话', 'err')
      const body = String((chatInput && chatInput.value) || '').trim()
      const pending = CHAT.files.slice()
      if (!body && !pending.length) return toast('请输入消息或拖入图片 / 视频', 'err')
      if (chatSendBtn) {
        chatSendBtn.disabled = true
        chatSendBtn.textContent = '发送中…'
      }
      let sent = 0
      let failed = 0
      try {
        if (body) {
          await api('agency.reply', { id: CHAT.agencyId, uid: CHAT.uid, body: body })
          appendChatMessage({ from: 'staff', body: body, createdAt: Date.now() })
          chatInput.value = ''
          sent += 1
        }
        for (let i = 0; i < pending.length; i++) {
          const f = pending[i]
          try {
            const url = await mediaUpload(f.file)
            const payload = { id: CHAT.agencyId, uid: CHAT.uid, kind: f.kind }
            payload[f.kind] = url
            await api('agency.reply', payload)
            appendChatMessage({
              from: 'staff', kind: f.kind, createdAt: Date.now(),
              image: f.kind === 'image' ? url : '',
              video: f.kind === 'video' ? url : ''
            })
            removeChatFile(f.id)
            sent += 1
          } catch (err) {
            failed += 1
            toast((f.name || '文件') + ' 发送失败：' + (err.message || '请重试'), 'err')
          }
        }
        if (sent) {
          toast(failed ? '已发送 ' + sent + ' 条，' + failed + ' 个文件失败' : '已发送')
          loadChats(true)
        }
      } catch (err) {
        toast(err.message || '发送失败', 'err')
      } finally {
        if (chatSendBtn) {
          chatSendBtn.disabled = false
          chatSendBtn.textContent = '发送'
        }
      }
    }

    if (chatBox) {
      const imgInput = root.body.querySelector('#o-chat-img-file')
      const videoInput = root.body.querySelector('#o-chat-video-file')
      const refreshBtn = root.body.querySelector('#o-chat-refresh')
      const pickImage = root.body.querySelector('#o-chat-pick-image')
      const pickVideo = root.body.querySelector('#o-chat-pick-video')
      if (refreshBtn) refreshBtn.onclick = function () { loadChats(false) }
      if (pickImage && imgInput) pickImage.onclick = function () { imgInput.value = ''; imgInput.click() }
      if (pickVideo && videoInput) pickVideo.onclick = function () { videoInput.value = ''; videoInput.click() }
      if (imgInput) imgInput.onchange = function () { addChatFiles(this.files); this.value = '' }
      if (videoInput) videoInput.onchange = function () { addChatFiles(this.files); this.value = '' }
      if (chatSendBtn) chatSendBtn.onclick = sendChat
      if (chatInput) {
        chatInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            sendChat()
          }
        })
      }
    }

    /* 底部「对话」：展开面板、读取历史并聚焦输入框；没有历史也可直接发第一条 */
    function focusChat() {
      if (!CHAT.agencyId || !CHAT.uid) return toast('该委托缺少发布人用户 ID，无法发起对话', 'err')
      if (chatBox) {
        if (!CHAT.loaded) loadChats(false)
        chatBox.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      if (chatInput) setTimeout(function () { chatInput.focus() }, 220)
    }

    /* 平台修改：完整复刻小程序发布委托的表单（型号库搜索 + 条件 chips + 流程步骤编辑），
       委托人主体信息 / 联系人 / 授权书与证明材料不展示、不可修改；保存后立即生效并记入操作日志 */
    function editAgency() {
      const termList = ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议']
      const currencyList = [
        { value: 'CNY', label: '人民币（¥）' }, { value: 'USD', label: '美元（$）' },
        { value: 'USDT', label: 'USDT（₮）' }, { value: 'HKD', label: '港币（HK$）' },
        { value: 'EUR', label: '欧元（€）' }, { value: 'GBP', label: '英镑（£）' },
        { value: 'JPY', label: '日元（¥）' }, { value: 'SGD', label: '新加坡元（S$）' },
        { value: 'AED', label: '迪拉姆（د.إ）' }, { value: 'BTC', label: '比特币（₿）' }
      ]
      /* 与小程序发布页同源：条件预设、侧别文案、租期档位 */
      const COND_PRESETS = {
        seller: ['接受同台互验', '接受先验资再看货', '可提供采购意向函', '接受指定交易地点', '强主体（国企 / 央企）'],
        buyer: ['接受同台互验', '提供设备实拍图片', '提供设备实拍视频', '支持资金监管账户'],
        renter: ['接受同台互验', '接受先验资再看货', '可提供采购意向函', '强主体（国企 / 央企）',
          '接受签署租赁意向协议', '接受按期预付租金', '用途仅限训练 / 推理等合规业务', '不得转租或二次转让'],
        lessor: ['提供设备实拍图片', '提供设备实拍视频', '明确租金 / 租期 / 押金条款', '接受同台互验', '支持租金资金监管账户'],
        nego: ['价格可议', '交付周期可放宽', '起订量可下调', '接受二手 / 拆机件',
          '可接受先付款后发货', '可接受分批交付', '可提供验资视频', '可接受指定时间验收'],
        negoRent: ['租金可议', '租期可议', '押金可减免', '可提供试租期', '可给长租折扣',
          '可接受预付折扣', '可接受到期顺延', '可接受分批付款']
      }
      const SIDE_TITLE = {
        seller: { must: '买家必须满足', nego: '可与买家协商' },
        buyer: { must: '供给方必须满足', nego: '可与供给方协商' },
        renter: { must: '承租方必须满足', nego: '可与承租方协商' },
        lessor: { must: '出租方必须满足', nego: '可与出租方协商' }
      }
      const modeOptionsOf = function (side) {
        return side === 'buy' ? ['求购', '租赁'] : ['出售', '出租']
      }
      const rentalOf = function (mode) { return mode === '出租' || mode === '租赁' }
      const sideOf = function (side, rental) {
        return side === 'buy' ? (rental ? 'lessor' : 'buyer') : (rental ? 'renter' : 'seller')
      }
      const mergeCond = function (presets, current) {
        const out = (presets || []).map(function (v) {
          const hit = current.filter(function (o) { return o.v === v })[0]
          return { v: v, on: !!hit && hit.on }
        })
        current.forEach(function (o) {
          if (!out.some(function (x) { return x.v === o.v })) out.push({ v: o.v, on: o.on })
        })
        return out
      }
      const condFrom = function (list) {
        return (Array.isArray(list) ? list : []).map(function (v) { return { v: String(v), on: true } })
      }
      /* 发布时 flow 以「步骤名：说明」拼接，这里按同一个分隔符还原成可编辑的步骤 */
      const flowFrom = function (list) {
        return (Array.isArray(list) ? list : []).map(function (text) {
          const s = String(text || '')
          const k = s.indexOf('：')
          if (k < 0) return { n: s, d: '' }
          return { n: s.slice(0, k), d: s.slice(k + 1) }
        }).filter(function (step) { return !!step.n })
      }

      const state = {
        side: (item.side || (item.kind === '代售' ? 'sell' : 'buy')) === 'buy' ? 'buy' : 'sell',
        mode: String(item.mode || ''),
        term: item.term || termList[2],
        cat: String(item.cat || item.itemCat || ''),
        model: String(item.item || ''),
        path: '',
        must: condFrom(item.must),
        nego: condFrom(item.nego),
        flow: flowFrom(item.flow),
        catalog: null
      }
      if (modeOptionsOf(state.side).indexOf(state.mode) < 0) {
        state.mode = modeOptionsOf(state.side)[0]
      }
      const m = modal({
        wide: true,
        title: '平台修改委托',
        sub: '与小程序发布委托相同的表单，委托内容可逐项重新编辑；委托方主体信息、联系人与证明材料不展示、不可修改',
        body:
          '<div class="grid g2">' +
            '<div class="field"><label>委托类型</label><div class="ag-chips" id="oe-side-chips">' +
              '<button type="button" class="ag-chip' + (state.side === 'buy' ? ' on' : '') + '" data-side="buy">代采</button>' +
              '<button type="button" class="ag-chip' + (state.side === 'sell' ? ' on' : '') + '" data-side="sell">代售</button>' +
            '</div></div>' +
            '<div class="field"><label>委托方式</label><div class="ag-chips" id="oe-mode-chips"></div>' +
              '<div class="hint" id="oe-mode-hint"></div></div>' +
            '<div class="field" style="grid-column:1/-1">' +
              '<label id="oe-dev-label"></label>' +
              '<div class="ag-dev-search"><input id="oe-dev-q" type="text" autocomplete="off" value="' + esc(state.model) + '" placeholder="搜索型号 / 品牌，如 H100、A100、DDR5">' +
                '<button type="button" class="btn xs" id="oe-dev-clear">清空</button></div>' +
              '<div class="ag-dev-results" id="oe-dev-results" style="display:none"></div>' +
              '<div class="ag-dev-path" id="oe-dev-path"></div>' +
              '<div class="hint">设备必须从平台预设型号库选择，平台按型号匹配商机；配件规格、成色与交付要求写在下方条件设置中。</div>' +
            '</div>' +
            '<div class="field"><label>数量（台 / 套）</label>' +
              '<input id="oe-qty" type="number" min="1" step="1" value="' + (Number(item.qty) || 1) + '" placeholder="如 8"></div>' +
            '<div class="field"><label>计价币种</label>' +
              '<select id="oe-currency">' + options(currencyList, item.currency || 'CNY', false) + '</select></div>' +
            '<div class="field"><label id="oe-price-label"></label>' +
              '<input id="oe-price" type="number" min="1" step="1" value="' + (Number(item.price) || 0) + '" placeholder="请输入金额"></div>' +
            '<div class="field"><label>截止时间</label>' +
              '<input id="oe-deadline" type="date" min="' + dayText(Date.now() + 86400000) + '" max="' + dayText(Date.now() + 365 * 86400000) + '" value="' + esc(item.deadline || '') + '">' +
              '<div class="hint">到期仍未成交即停止代寻；代采委托的合同截止时间即为此日期。</div></div>' +
            '<div class="field" style="grid-column:1/-1" id="oe-term-wrap"><label>计划租期</label>' +
              '<div class="ag-chips" id="oe-term-chips"></div></div>' +
          '</div>' +
          '<div class="ag-sub"><span class="t">条件设置</span><span class="d">对方必须满足 / 可协商，逐项勾选，也可自行添加</span></div>' +
          '<div class="field"><label id="oe-must-title"></label><div class="ag-chips" id="oe-must-chips"></div>' +
            '<div class="ag-cond-add"><input id="oe-must-input" maxlength="30" placeholder="没有合适的？自己加一条必须条件">' +
              '<button type="button" class="btn xs" data-add-cond="must">＋ 添加</button></div></div>' +
          '<div class="field"><label id="oe-nego-title"></label><div class="ag-chips" id="oe-nego-chips"></div>' +
            '<div class="ag-cond-add"><input id="oe-nego-input" maxlength="30" placeholder="没有合适的？自己加一条可协商条件">' +
              '<button type="button" class="btn xs" data-add-cond="nego">＋ 添加</button></div></div>' +
          '<div class="ag-sub"><span class="t">交易流程</span><span class="d">不预设，可自行添加、排序与删除</span></div>' +
          '<div id="oe-flow-list"></div>' +
          '<div class="ag-cond-add">' +
            '<input id="oe-step-name" maxlength="20" placeholder="新步骤名称">' +
            '<input id="oe-step-desc" maxlength="40" placeholder="说明（选填）">' +
            '<button type="button" class="btn xs" id="oe-step-add">＋ 添加步骤</button>' +
          '</div>' +
          '<div class="small" style="margin-top:14px;color:var(--muted-2);line-height:1.7">委托方主体名称 / 信用代码 / 身份证 / 法人、联系人手机号、授权书联系人电话、证明材料与服务费由委托方提交，平台修改不展示也不涉及这些内容。</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="oe-ok">保存修改</button>'
      })
      if (!m) return

      const body = m.body
      const devQ = body.querySelector('#oe-dev-q')
      const devRes = body.querySelector('#oe-dev-results')
      const priceLabel = body.querySelector('#oe-price-label')
      const devLabel = body.querySelector('#oe-dev-label')
      const modeHint = body.querySelector('#oe-mode-hint')

      function paintDevPath() {
        const el = body.querySelector('#oe-dev-path')
        el.innerHTML = state.model
          ? '已选：<b>' + esc(state.model) + '</b>' + (state.path ? ' · ' + esc(state.path) : '')
          : '尚未选择设备型号'
      }

      function paintMode() {
        const modes = modeOptionsOf(state.side)
        body.querySelector('#oe-mode-chips').innerHTML = modes.map(function (v) {
          return '<button type="button" class="ag-chip' + (state.mode === v ? ' on' : '') + '" data-mode="' + esc(v) + '">' + esc(v) + '</button>'
        }).join('')
        const rental = rentalOf(state.mode)
        body.querySelector('#oe-term-wrap').style.display = rental ? '' : 'none'
        body.querySelector('#oe-term-chips').innerHTML = termList.map(function (v) {
          return '<button type="button" class="ag-chip' + (state.term === v ? ' on' : '') + '" data-term="' + esc(v) + '">' + esc(v) + '</button>'
        }).join('')
        priceLabel.textContent = rental ? '月租金' : (state.side === 'buy' ? '采购预算' : '期望售价')
        devLabel.textContent = state.side === 'buy' ? '需要采购的设备 / 配件' : '需要代售的设备 / 配件'
        modeHint.textContent = rental
          ? '租赁按「元 / 台 / 月」填月租金；服务费为一个月租金，买卖双方各承担 50%，委托方支付半个月租金，成交后支付。'
          : '购买 / 出售按「元 / 台」填预算或期望售价，服务费按成交金额分档计。'
        const t = SIDE_TITLE[sideOf(state.side, rental)]
        body.querySelector('#oe-must-title').textContent = t.must
        body.querySelector('#oe-nego-title').textContent = t.nego
      }

      function paintConds() {
        ;['must', 'nego'].forEach(function (kind) {
          const box = body.querySelector('#oe-' + kind + '-chips')
          box.innerHTML = state[kind].length
            ? state[kind].map(function (o, i) {
              return '<button type="button" class="ag-chip' + (o.on ? ' on' : '') + '" data-cond="' + kind + '" data-i="' + i + '">' + esc(o.v) + '</button>'
            }).join('')
            : '<span class="small" style="color:var(--muted-2)">暂无候选条件，可在下方自行添加</span>'
        })
      }

      function rebuildConds() {
        const rental = rentalOf(state.mode)
        state.must = mergeCond(COND_PRESETS[sideOf(state.side, rental)] || [], state.must)
        state.nego = mergeCond(rental ? COND_PRESETS.negoRent : COND_PRESETS.nego, state.nego)
        paintConds()
      }

      function paintFlow() {
        const box = body.querySelector('#oe-flow-list')
        box.innerHTML = state.flow.length
          ? state.flow.map(function (step, i) {
            return '<div class="ag-flow-row">' +
              '<div class="ag-flow-idx">' + (i + 1) + '</div>' +
              '<div class="ag-flow-main">' +
                '<input data-fk="n" data-i="' + i + '" maxlength="20" placeholder="步骤名称" value="' + esc(step.n) + '">' +
                '<input data-fk="d" data-i="' + i + '" maxlength="40" placeholder="步骤说明（选填）" value="' + esc(step.d) + '">' +
              '</div>' +
              '<div class="ag-flow-acts">' +
                '<button type="button" class="btn xs" data-fmove="-1" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
                '<button type="button" class="btn xs" data-fmove="1" data-i="' + i + '"' + (i === state.flow.length - 1 ? ' disabled' : '') + '>↓</button>' +
                '<button type="button" class="btn xs danger" data-fdel="1" data-i="' + i + '">✕</button>' +
              '</div>' +
            '</div>'
          }).join('')
          : '<div class="ag-flow-empty">还没有步骤，需要时在下方添加；不设置也可以直接保存。</div>'
        box.querySelectorAll('input[data-fk]').forEach(function (input) {
          input.oninput = function () {
            const step = state.flow[Number(input.getAttribute('data-i'))]
            if (step) step[input.getAttribute('data-fk')] = input.value
          }
        })
        box.querySelectorAll('[data-fmove]').forEach(function (btn) {
          btn.onclick = function () {
            const i = Number(btn.getAttribute('data-i'))
            const j = i + Number(btn.getAttribute('data-fmove'))
            if (j < 0 || j >= state.flow.length) return
            const tmp = state.flow[i]
            state.flow[i] = state.flow[j]
            state.flow[j] = tmp
            paintFlow()
          }
        })
        box.querySelectorAll('[data-fdel]').forEach(function (btn) {
          btn.onclick = function () {
            state.flow.splice(Number(btn.getAttribute('data-i')), 1)
            paintFlow()
          }
        })
      }

      function paintDevResults() {
        if (!state.catalog) {
          devRes.style.display = ''
          devRes.innerHTML = '<div class="ag-dev-empty">型号库加载中…</div>'
          return
        }
        const kw = String(devQ.value || '').trim().toLowerCase()
        const tokens = kw ? kw.split(/\s+/) : []
        const hit = state.catalog.filter(function (it) {
          const text = [it.cat, it.brand, it.series, it.model].join(' ').toLowerCase()
          return tokens.every(function (t) { return text.indexOf(t) > -1 })
        }).slice(0, 30)
        devRes.style.display = ''
        if (!hit.length) {
          devRes.innerHTML = '<div class="ag-dev-empty">没有匹配的设备，换个关键词试试</div>'
          return
        }
        devRes.innerHTML = hit.map(function (it, i) {
          return '<div class="ag-dev-result" data-di="' + i + '">' +
            '<div class="n">' + esc(it.model) + '</div>' +
            '<div class="p">' + esc([it.cat, it.brand, it.series].filter(Boolean).join(' · ')) + '</div>' +
          '</div>'
        }).join('')
        /* 用 mousedown 选型，避免输入框 blur 先收起结果导致点不中 */
        devRes.querySelectorAll('[data-di]').forEach(function (row) {
          row.onmousedown = function (e) {
            e.preventDefault()
            const it = hit[Number(row.getAttribute('data-di'))]
            state.cat = it.cat || ''
            state.model = it.model || ''
            state.path = [it.cat, it.brand, it.series].filter(Boolean).join(' · ')
            devQ.value = state.model
            devRes.style.display = 'none'
            paintDevPath()
          }
        })
      }

      body.querySelector('#oe-side-chips').onclick = function (e) {
        const btn = e.target.closest('[data-side]')
        if (!btn) return
        state.side = btn.getAttribute('data-side')
        body.querySelectorAll('#oe-side-chips [data-side]').forEach(function (el) {
          el.classList.toggle('on', el === btn)
        })
        if (modeOptionsOf(state.side).indexOf(state.mode) < 0) {
          state.mode = modeOptionsOf(state.side)[0]
        }
        paintMode()
        rebuildConds()
      }
      body.querySelector('#oe-mode-chips').onclick = function (e) {
        const btn = e.target.closest('[data-mode]')
        if (!btn) return
        state.mode = btn.getAttribute('data-mode')
        paintMode()
        rebuildConds()
      }
      body.querySelector('#oe-term-chips').onclick = function (e) {
        const btn = e.target.closest('[data-term]')
        if (!btn) return
        state.term = btn.getAttribute('data-term')
        body.querySelectorAll('#oe-term-chips [data-term]').forEach(function (el) {
          el.classList.toggle('on', el === btn)
        })
      }
      body.querySelectorAll('.ag-chips').forEach(function (box) {
        if (box.id === 'oe-side-chips' || box.id === 'oe-mode-chips' || box.id === 'oe-term-chips') return
        box.onclick = function (e) {
          const btn = e.target.closest('[data-cond]')
          if (!btn) return
          const kind = btn.getAttribute('data-cond')
          const row = state[kind][Number(btn.getAttribute('data-i'))]
          if (!row) return
          row.on = !row.on
          btn.classList.toggle('on', row.on)
        }
      })
      body.querySelectorAll('[data-add-cond]').forEach(function (btn) {
        btn.onclick = function () {
          const kind = btn.getAttribute('data-add-cond')
          const input = body.querySelector('#oe-' + kind + '-input')
          const value = String(input.value || '').trim().slice(0, 30)
          if (!value) return toast('请先填写条件内容', 'err')
          const exist = state[kind].filter(function (o) { return o.v === value })[0]
          if (exist) {
            exist.on = true
            paintConds()
            input.value = ''
            return
          }
          if (state[kind].length >= 10) return toast('最多 10 条条件', 'err')
          state[kind].push({ v: value, on: true })
          input.value = ''
          paintConds()
        }
      })
      body.querySelector('#oe-step-add').onclick = function () {
        const nameEl = body.querySelector('#oe-step-name')
        const descEl = body.querySelector('#oe-step-desc')
        const name = String(nameEl.value || '').trim().slice(0, 20)
        if (!name) return toast('请填写步骤名称', 'err')
        if (state.flow.length >= 10) return toast('最多 10 个步骤', 'err')
        state.flow.push({ n: name, d: String(descEl.value || '').trim().slice(0, 40) })
        nameEl.value = ''
        descEl.value = ''
        paintFlow()
      }
      devQ.oninput = paintDevResults
      devQ.onfocus = paintDevResults
      devQ.onblur = function () { setTimeout(function () { devRes.style.display = 'none' }, 120) }
      body.querySelector('#oe-dev-clear').onclick = function () {
        devQ.value = ''
        state.cat = ''
        state.model = ''
        state.path = ''
        paintDevPath()
        devRes.style.display = 'none'
        devQ.focus()
      }

      paintMode()
      rebuildConds()
      paintFlow()
      paintDevPath()
      api('catalog.list', { status: 'active' }).then(function (data) {
        state.catalog = (data && data.items) || []
        if (state.model) {
          const hit = state.catalog.filter(function (it) { return it.model === state.model })[0]
          if (hit) {
            state.cat = state.cat || hit.cat
            state.path = [hit.cat, hit.brand, hit.series].filter(Boolean).join(' · ')
            paintDevPath()
          }
        }
      }).catch(function (err) {
        state.catalog = []
        toast('型号库加载失败：' + err.message, 'err')
      })

      m.foot.querySelector('#oe-ok').onclick = async function () {
        const rental = rentalOf(state.mode)
        const qty = Number(body.querySelector('#oe-qty').value)
        const price = Number(body.querySelector('#oe-price').value)
        const deadline = String(body.querySelector('#oe-deadline').value || '')
        const flow = state.flow.map(function (step) {
          const n = String(step.n || '').trim()
          const d = String(step.d || '').trim()
          return n ? (d ? n + '：' + d : n) : ''
        }).filter(Boolean).slice(0, 10)
        const must = state.must.filter(function (o) { return o.on }).map(function (o) { return o.v }).slice(0, 10)
        const nego = state.nego.filter(function (o) { return o.on }).map(function (o) { return o.v }).slice(0, 10)
        if (!state.model || state.model.length < 2) return toast('请从平台预设型号库选择设备', 'err')
        if (!state.cat) return toast('设备品类缺失，请重新从型号库选择设备', 'err')
        if (!Number.isInteger(qty) || qty < 1) return toast('数量需为正整数', 'err')
        if (!Number.isInteger(price) || price < 1) return toast('请填写正确的' + (rental ? '月租金' : (state.side === 'buy' ? '采购预算' : '期望售价')), 'err')
        if (!deadline) return toast('请选择委托截止时间', 'err')
        if (deadline <= dayText(Date.now())) return toast('委托截止时间需晚于今天', 'err')
        if (rental && termList.indexOf(state.term) < 0) return toast('请选择计划租期', 'err')
        const payload = {
          id: item.id,
          side: state.side,
          mode: state.mode,
          term: rental ? state.term : '',
          cat: state.cat,
          item: state.model,
          qty: qty,
          currency: body.querySelector('#oe-currency').value,
          price: price,
          deadline: deadline,
          flow: flow,
          must: must,
          nego: nego
        }
        this.disabled = true
        try {
          await api('agency.update', payload)
          closeModal()
          done('已按发布口径更新委托内容')
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }

    /* 下架：仅已上架委托可操作，理由会通过站内信发送给委托方 */
    function offlineAgency() {
      const m = modal({
        title: '下架委托',
        sub: '下架后委托不再展示，理由是必填项，会通过站内信发送给委托方',
        body: '<div class="field"><label>下架理由（必填）</label>' +
          '<textarea id="o-offline-reason" rows="3" maxlength="100" placeholder="例如：接口信息变更 / 用户申请暂停 / 商品信息需重新核实"></textarea></div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="o-offline-ok">确认下架</button>'
      })
      if (!m) return
      m.foot.querySelector('#o-offline-ok').onclick = async function () {
        const reason = String(m.body.querySelector('#o-offline-reason').value || '').trim()
        if (!reason) return toast('请填写下架理由', 'err')
        this.disabled = true
        try {
          await api('agency.offline', { id: item.id, reason: reason })
          closeModal()
          done('已下架，理由已发送给委托方')
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }

    root.foot.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.onclick = function () {
        const act = btn.getAttribute('data-act')
        if (act === 'approve') approve()
        else if (act === 'reject') reject()
        else if (act === 'contact') contact()
        else if (act === 'ticket') ticket()
        else if (act === 'chats') focusChat()
        else if (act === 'edit') editAgency()
        else if (act === 'offline') offlineAgency()
      }
    })
  }

  /**
   * 工作台待办卡片：每类事项一张独立卡片，左侧色条 + 图标区分类型，
   * 头部显示数量，卡片内最多 4 条，剩余条目引导到对应模块，避免信息堆叠。
   */
  function todoCard(o) {
    const total = Number(o.total || 0)
    const items = (o.items || []).slice(0, 4)
    const more = Math.max(0, total - items.length)
    return '<section class="todo-card tone-' + esc(o.tone || 'brand') + '">' +
      '<div class="todo-head">' +
        '<span class="todo-ico">' + icon(o.icon || 'grid') + '</span>' +
        '<div class="todo-head-main">' +
          '<div class="todo-title">' + esc(o.title) +
            '<span class="todo-count' + (total ? ' on num-red' : '') + '">' + num(total) + '</span></div>' +
          '<div class="todo-desc">' + esc(o.desc || '') + '</div>' +
        '</div>' +
        (o.goKey ? '<button class="btn xs ghost" data-go="' + o.goKey + '"' +
          (o.goTab ? ' data-go-tab="' + o.goTab + '"' : '') + '>' + esc(o.goText || '查看全部') + '</button>' : '') +
      '</div>' +
      '<div class="todo-body">' +
        (items.length ? items.map(o.row).join('') : '<div class="todo-empty">' + esc(o.empty || '暂无待处理') + '</div>') +
        (more > 0 && o.goKey ? '<button class="todo-more" data-go="' + o.goKey + '">还有 ' + num(more) + ' 条 · 查看全部</button>' : '') +
      '</div></section>'
  }

  /* 待办条目：标题 + 一行标签化信息（可选提醒行）+ 右侧操作 */
  function todoItem(o) {
    const meta = (o.meta || []).filter(Boolean).map(function (t) {
      return '<span class="todo-tag">' + t + '</span>'
    }).join('')
    return '<div class="todo-item">' +
      '<div class="todo-item-main">' +
        '<div class="todo-item-title">' + o.title + '</div>' +
        (meta ? '<div class="todo-item-meta">' + meta + '</div>' : '') +
        (o.note || '') +
      '</div>' +
      '<div class="todo-item-actions">' + (o.actions || '') + '</div>' +
    '</div>'
  }

  /* 工作台按角色渲染：角色与周期由 workbench.data 统一给出 */
  const WB_STATE = { period: 'today' }
  const WB_PERIODS = [['today', '今日'], ['7d', '近7天'], ['30d', '近30天']]
  const WB_ROLE_TEXT = {
    admin: '管理员', cs: '客服', finance: '财务', sales: '电销',
    ops: '运营专员', content: '内容运营', cs_lead: '客服主管', auditor: '审核专员', analyst: '数据运营'
  }
  /* 角色工作台工作入口：key 与左侧导航一致，pages 用于按权限过滤 */
  const WB_ENTRIES = [
    { key: 'dashboard', label: '数据看板', desc: '业务增长与实时指标', icon: 'grid', pages: ['stats'] },
    { key: 'consult', label: '工单中心', desc: '已生成工单的咨询与分步流程', icon: 'chat', pages: ['consult'] },
    { key: 'biz', label: '代采代售', desc: '委托审核与成交确认', icon: 'file', pages: ['biz'] },
    { key: 'products', label: '商品管理', desc: '货源审核与上下架', icon: 'media', pages: ['products'] },
    { key: 'demands', label: '需求管理', desc: '求购需求审核与关闭', icon: 'file', pages: ['demands'] },
    { key: 'users', label: '用户管理', desc: '用户档案、会员与权限', icon: 'users', pages: ['users'] },
    { key: 'messages', label: '消息中心', desc: '用户留言与客服回复', icon: 'chat', pages: ['messages'] },
    { key: 'cs', label: '客服业务', desc: '绑定用户、委托佣金与评价', icon: 'users', pages: ['cs'] },
    { key: 'risk', label: '风险提示', desc: '风险单与内容监管', icon: 'shield', pages: ['risk'] },
    { key: 'media', label: '媒体', desc: '资讯 / 榜单 / 价格水平', icon: 'media', pages: ['boards', 'news'] },
    { key: 'finance', label: '财务中心', desc: '收款与营收', icon: 'wallet', pages: ['finance'] },
    { key: 'accounts', label: '账号与权限', desc: '账号、角色与临时权限', icon: 'key', pages: ['accounts'] },
    { key: 'settings', label: '设置', desc: '规则与平台配置', icon: 'settings', pages: ['settings'] },
    { key: 'audit', label: '审计日志', desc: '关键动作全程留痕', icon: 'shield', pages: ['audit'] },
    { key: 'service', label: '服务记录', desc: '客服处置量与明细', icon: 'file', pages: ['service'] },
    { key: 'logs', label: '系统日志', desc: '运行日志 / 登录日志', icon: 'file', pages: ['logs'] }
  ]
  function wbHello() {
    const hour = new Date().getHours()
    return hour < 6 ? '凌晨好' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  }
  function wbNum(v) { return Number(v || 0) }
  function wbPill(v) { return '<span class="num-pill danger">' + num(wbNum(v)) + '</span>' }
  function wbRoleText(role) { return WB_ROLE_TEXT[role] || role || '—' }

  /* 管理员专属：账号作业记录表，切换周期只刷新这张表 */
  function wbAccountsHtml(accounts) {
    const rows = (accounts || []).map(function (a) {
      return '<td><div class="strong">' + esc(a.name || a.username || '—') + '</div>' +
        '<div class="small mono" style="color:var(--muted-2)">' + esc(a.username || '') + '</div></td>' +
        '<td>' + badge(wbRoleText(a.role), 'info', true) + '</td>' +
        '<td>' + num(wbNum(a.tickets)) + '</td>' +
        '<td>' + num(wbNum(a.replies)) + '</td>' +
        '<td>' + num(wbNum(a.reviews)) + '</td>' +
        '<td>' + num(wbNum(a.payments)) + '</td>' +
        '<td>' + money(wbNum(a.paymentAmount)) + '</td>' +
        '<td>' + num(wbNum(a.risk)) + '</td>' +
        '<td>' + num(wbNum(a.reports)) + '</td>' +
        '<td>' + (a.lastAt ? esc(ago(a.lastAt)) : '<span class="small" style="color:var(--muted-2)">暂无动作</span>') + '</td>'
    })
    return table(['账号', '角色', '处理工单', '消息回复', '内容审核', '收款笔数', '收款金额', '风控处置', '举报处理', '最近动作'],
      rows, '暂无账号作业记录')
  }

  function wbPeriodSeg() {
    return '<div class="seg" id="wb-period">' + WB_PERIODS.map(function (p) {
      return '<button data-period="' + p[0] + '"' + (WB_STATE.period === p[0] ? ' class="on"' : '') + '>' + p[1] + '</button>'
    }).join('') + '</div>'
  }

  function wbAccountsCard(accounts) {
    return '<section class="card" style="margin-top:16px" id="wb-accounts">' +
      '<div class="card-head"><h3>团队作业记录</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2);margin-right:10px">按处理工单 / 回复 / 审核 / 收款统计</span>' +
      wbPeriodSeg() + '</div>' +
      '<div class="card-body flush" id="wb-accounts-body">' + wbAccountsHtml(accounts) + '</div></section>'
  }

  function wbWirePeriod(view) {
    view.querySelectorAll('#wb-period [data-period]').forEach(function (btn) {
      btn.onclick = async function () {
        WB_STATE.period = btn.getAttribute('data-period')
        view.querySelectorAll('#wb-period [data-period]').forEach(function (b) {
          b.classList.toggle('on', b === btn)
        })
        const body = view.querySelector('#wb-accounts-body')
        if (body) body.innerHTML = loadingBlock('加载作业记录')
        try {
          const data = await api('workbench.data', { period: WB_STATE.period })
          if (body) body.innerHTML = wbAccountsHtml((data && data.accounts) || [])
        } catch (err) {
          if (body) body.innerHTML = '<div class="card-body" style="color:var(--danger)">' + esc(err.message || '作业记录加载失败') + '</div>'
        }
      }
    })
  }

  Pages.workbench = async function (view) {
    let wb = null
    let wbError = ''
    try {
      wb = await api('workbench.data', { period: WB_STATE.period })
    } catch (err) {
      wbError = (err && err.message) || '工作台数据加载失败'
    }
    const role = (state.account && state.account.role) || (wb && wb.role) || 'admin'
    if (role === 'cs') return renderCsWorkbench(view, wb, wbError)
    if (role === 'finance') return renderFinanceWorkbench(view, wb, wbError)
    /* 其余角色（电销 / 预设角色 / 自定义角色）统一按页面权限生成工作台，避免越权调接口或整页空白 */
    if (role !== 'admin') return renderRoleWorkbench(view, wb, wbError)
    return renderAdminWorkbench(view, wb, wbError)
  }

  /**
   * 工作台登录后的审核提醒：有待审核的委托 / 居间合同时弹一次，
   * 每次会话只提醒一次，处理完刷新不会反复打扰。
   */
  function maybeReviewPopup(todos) {
    const agencyReview = Number(todos && todos.agencyReview) || 0
    const contracts = Number(todos && todos.contracts) || 0
    if (!agencyReview && !contracts) return
    const who = String((state.account && (state.account.username || state.account.name)) || 'admin')
    const key = 'console.reviewPopup.' + who
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch (err) { /* 无痕模式忽略 */ }
    const rows = []
    if (contracts) {
      rows.push('<div class="wb-review-row"><span class="badge danger">居间合同</span><span class="grow">' +
        num(contracts) + ' 份合同待审核，通过后才能继续成交</span>' +
        '<button class="btn xs primary" id="wb-review-contract">去审核</button></div>')
    }
    if (agencyReview) {
      rows.push('<div class="wb-review-row"><span class="badge warn">代采代售</span><span class="grow">' +
        num(agencyReview) + ' 条委托待核对，通过后立即上架</span>' +
        '<button class="btn xs primary" id="wb-review-agency">去核对</button></div>')
    }
    const root = modal({
      title: '有新的待审核事项',
      sub: '来自工单中心的审核提醒',
      body: '<div class="wb-review-list">' + rows.join('') + '</div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:10px">处理后可直接在工单中心继续推进整条链路。</div>',
      footer: '<button class="btn" data-close="1">稍后处理</button>'
    })
    if (!root) return
    const contractBtn = root.querySelector('#wb-review-contract')
    if (contractBtn) contractBtn.onclick = function () {
      /* 工作台已内嵌工单台：直接切到「合同待审核」分栏，不跳页 */
      closeModal()
      CF.tab = 'review'
      cfReload(false)
    }
    const agencyBtn = root.querySelector('#wb-review-agency')
    if (agencyBtn) agencyBtn.onclick = function () { C.navigate('biz', { agencyStatus: '待审核' }) }
  }

  /**
   * 管理员工作台 = 工单处理台。
   * 用户从代采 / 代售发来的咨询会直接生成工单：顶部 KPI 看积压，
   * 下方常驻「工单列表 / 沟通会话 / 委托详情」三栏，点工单原地处理，不跳页、不需要返回。
   * 委托核对、用户留言、举报风控等其它待办收敛成头部的计数按钮。
   */
  async function renderAdminWorkbench(view, wb, wbError) {
    /* 单个模块失败只降级该模块，避免整页空白 */
    const failed = []
    if (wbError) failed.push(wbError)
    const wbTodos = (wb && wb.todos) || null
    function safe(p, fallback) {
      return p.catch(function (err) {
        failed.push((err && err.message) || '接口异常')
        return fallback
      })
    }
    const results = await Promise.all([
      /* 用户直接发给平台的消息（客服会话未读数） */
      safe(api('msg.threads', {}), {}),
      safe(api('agency.list', { status: '待审核', page: 1, limit: 1 }), {}),
      safe(api('report.list', { status: '待处理', page: 1, limit: 1 }), {}),
      safe(api('risk.cases', { status: '待处理', page: 1, limit: 1 }), {})
    ])
    const threads = results[0] || {}
    const agencyReview = results[1] || {}
    const reports = results[2] || {}
    const risks = results[3] || {}
    const msgTodo = wbNum(wbTodos && wbTodos.unread) || Number(threads.unread || 0)
    const agencyTodo = wbNum(wbTodos && wbTodos.agency) || Number(agencyReview.total || 0)
    const securityTotal = wbTodos
      ? wbNum(wbTodos.reports) + wbNum(wbTodos.risk)
      : Number(reports.total || 0) + Number(risks.total || 0)
    const hello = wbHello()
    const today = dayText(Date.now())
    const who = (state.account && state.account.name) || '管理员'

    /* 头部只放「不属于工单台」的待办入口，避免再占首屏高度 */
    const headActions = []
    if (agencyTodo) headActions.push('<button class="btn" id="wb-go-agency">委托待核对 <span class="strong">' + num(agencyTodo) + '</span></button>')
    if (msgTodo) headActions.push('<button class="btn" data-go="messages">用户留言 <span class="strong">' + num(msgTodo) + '</span></button>')
    if (securityTotal) headActions.push('<button class="btn" data-go="risk">举报 / 风控 <span class="strong">' + num(securityTotal) + '</span></button>')
    /* 推广提现：客服处理待审核，财务 / 管理员继续跟进待打款与失败重打 */
    const withdrawPending = wbNum(wbTodos && wbTodos.withdrawPending)
    const withdrawPayout = wbNum(wbTodos && wbTodos.withdrawPayout)
    const withdrawTimeout = wbNum(wbTodos && wbTodos.withdrawTimeout)
    const withdrawFailed = wbNum(wbTodos && wbTodos.withdrawFailed)
    if (withdrawPending && C.can('promote.withdrawList')) {
      headActions.push('<button class="btn" data-go="promote" data-go-tab="withdraw">提现待审核 <span class="strong">' + num(withdrawPending) + '</span></button>')
    }
    if (C.can('promote.payoutList') && (withdrawPayout || withdrawFailed)) {
      headActions.push('<button class="btn" data-go="promote" data-go-tab="payout">' +
        (withdrawFailed ? '打款失败 <span class="strong">' + num(withdrawFailed) + '</span>' : '待打款 <span class="strong">' + num(withdrawPayout) + '</span>') +
        (withdrawTimeout ? ' · 超时 ' + num(withdrawTimeout) : '') + '</button>')
    }

    view.classList.add('view-fill', 'cf-fill')
    view.innerHTML = '<div class="cf-page wb-cf">' +
      '<div class="page-head"><div><h2 class="title">' + hello + '，' + esc(who) + '</h2>' +
      '<div class="desc">' + today + ' · 只显示进行中的工单：领取 → 沟通 → 推进，谈不拢可直接终止；已完成 / 已终止的委托在「代采代售」按工单状态查看' +
      (failed.length ? ' · <span style="color:var(--warn)">部分数据加载失败</span>' : '') + '</div></div>' +
      '<div class="actions">' + headActions.join('') +
      '<button class="btn" id="cf-refresh">' + icon('refresh') + '<span>刷新</span></button>' +
      '</div></div>' +
      '<div id="cf-kpi"></div>' +
      '<div class="cf-bar"><div class="tabs" id="cf-tabs"></div><div class="grow"></div>' +
      '<input id="cf-q" placeholder="搜索委托标题 / 需求内容" style="width:220px">' +
      '<button class="btn" id="cf-search">' + icon('search') + '<span>查询</span></button></div>' +
      '<div id="cf-body">' + loadingBlock('读取工单') + '</div>' +
      '</div>'

    wireGo(view)
    view.querySelector('#cf-refresh').onclick = function () { cfReload(true) }
    view.querySelector('#cf-search').onclick = function () {
      CF.q = view.querySelector('#cf-q').value.trim()
      cfReload(false)
    }
    view.querySelector('#cf-q').onkeydown = function (e) {
      if (e && e.key === 'Enter') {
        CF.q = view.querySelector('#cf-q').value.trim()
        cfReload(false)
      }
    }
    const agencyBtn = view.querySelector('#wb-go-agency')
    if (agencyBtn) agencyBtn.onclick = function () { C.navigate('biz', { agencyStatus: '待审核' }) }

    /* 从消息中心等深链进入时带上工单与分栏，进入后直接停在对应工单上 */
    const jumpLead = (state.pageQuery && state.pageQuery.leadId) || ''
    const jumpTab = (state.pageQuery && state.pageQuery.tab) || ''
    if (jumpLead || jumpTab) state.pageQuery = null
    CF.tab = CF_TABS.some(function (t) { return t[0] === jumpTab }) ? jumpTab : 'all'
    CF.q = ''
    CF.leadId = jumpLead
    CF.jumpLead = jumpLead
    await cfReload(false)
    cfStartPoll()
    /* 有代采代售 / 合同待审核时，进入工作台先弹一次待处理提醒 */
    maybeReviewPopup(wbTodos)
  }

  /**
   * 客服工作台 = 同一页面的工单处理台。
   * 直接复用管理员的「工单列表 / 沟通会话 / 委托详情」三栏：领取、回复、推进阶段、
   * 结束服务全部在这一页完成，领取后不再跳转到工单中心。底部补一张「我的工资」卡片。
   */
  async function renderCsWorkbench(view, wb, wbError) {
    await renderAdminWorkbench(view, wb, wbError)
    const page = view.querySelector('.cf-page')
    if (!page) return
    let salary = null
    try { salary = await api('cs.salary', {}) } catch (err) { salary = null }
    if (!salary) return
    const section = document.createElement('section')
    section.className = 'card'
    section.style.marginTop = '16px'
    section.style.flex = 'none'
    section.innerHTML = '<div class="card-head"><h3>我的工资</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2)">' + esc(salary.monthLabel || '') + ' · 佣金比例 ' +
      num(Math.round((Number(salary.agencyRate) || 0) * 100)) + '%</span></div><div class="card-body">' +
      kpiRow([
        ['本月工资', money(salary.monthSalary), '<span class="small" style="color:var(--muted-2)">委托佣金合计</span>'],
        ['代采代售佣金', money(salary.agencyCommission), '<span class="small" style="color:var(--muted-2)">' + num(salary.agencyOrderCount) + ' 笔</span>'],
        ['累计工资', money(salary.totalSalary), '<span class="small" style="color:var(--muted-2)">历史累计</span>']
      ]) +
      '<div class="small" style="color:var(--muted-2);margin-top:8px">工资只含代采代售委托佣金 = 委托服务费实收 × 佣金比例；会员付款的二级推广佣金在推广中心单独结算，不计入工资。退款冲正后当月工资同步扣回。</div>' +
      '</div>'
    page.appendChild(section)
  }

  /* 财务工作台：每周对账提醒 + 自己的收款作业量 + 到期会员提醒 */
  async function renderFinanceWorkbench(view, wb, wbError) {
    const mine = (wb && wb.mine) || {}
    const who = (state.account && state.account.name) || '财务'
    const results = await Promise.all([
      api('biz.list', { page: 1, limit: 50 }).catch(function () { return {} }),
      loadSettings().catch(function () { return {} }),
      api('finance.summary', { days: 30 }).catch(function () { return {} }),
      api('promote.stats', {}).catch(function () { return {} })
    ])
    const promoteStats = results[3] || {}
    const biz = results[0] || {}
    const plans = planList(results[1])
    const recon = (results[2] && results[2].recon) || {}
    const reconSt = reconState()
    const expiring = (biz.expiring && biz.expiring.items) || []
    const expiringTotal = Number(biz.expiring && biz.expiring.total) || expiring.length

    view.innerHTML = '<div class="page-head"><div><h2 class="title">' + wbHello() + '，' + esc(who) + '</h2>' +
      '<div class="desc">' + dayText(Date.now()) + ' · 支付已自动加时长，每周核对一次流水；续费提醒在「媒体」页</div></div></div>' +
      (wbError ? '<div class="small" style="margin-bottom:8px;color:var(--warn)">待办数据加载失败：' + esc(wbError) + '</div>' : '') +
      '<div class="grid g2" style="gap:16px">' +
      '<section class="card"><div class="card-head"><h3>每周对账</h3><div class="grow"></div>' +
      (reconSt.due
        ? '<span class="todo-flag">本周待对账</span>'
        : '<span class="small" style="color:var(--muted-2)">本周已对账</span>') + '</div><div class="card-body">' +
      '<div class="todo-item"><div class="todo-item-main">' +
      '<div class="todo-item-title">近 7 天到账 ' + money(recon.total) + '</div>' +
      '<div class="todo-item-meta"><span class="todo-tag">微信支付 ' + num(recon.wechatCount) + ' 笔 · ' + money(recon.wechatAmount) + '</span></div></div>' +
      '<div class="todo-item-actions"><button class="btn xs primary" data-go="finance">去对账</button></div></div>' +
      '<div class="small" style="color:var(--muted-2);margin-top:8px">上次对账：' + (reconSt.lastAt ? esc(dateText(reconSt.lastAt)) : '尚未对账') +
      '；系统已自动加时长，只需核对微信支付流水；手动开通不计营收。</div>' +
      '</div></section>' +
      '<section class="card"><div class="card-head"><h3>我的作业量</h3></div><div class="card-body">' +
      '<div class="grid g3" style="gap:12px">' +
      kpi('收款笔数', num(wbNum(mine.payments)), '<span class="small" style="color:var(--muted-2)">服务费确认</span>') +
      kpi('收款金额', money(wbNum(mine.paymentAmount)), '<span class="small" style="color:var(--muted-2)">委托服务费确认金额</span>') +
      kpi('最近动作', mine.lastAt ? esc(ago(mine.lastAt)) : '暂无', '<span class="small" style="color:var(--muted-2)">最近一笔处理</span>') +
      '</div></div></section></div>' +
      '<div style="margin-top:16px">' + promoteTodoCard(promoteStats) + '</div>' +
      '<section class="card" style="margin-top:16px"><div class="card-head"><h3>7 天内到期会员</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2)">' + num(expiringTotal) + ' 人</span></div><div class="card-body">' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:8px">系统每天自动提醒一次；手动补发站内信在「媒体」页</div>' +
      (expiring.length ? expiring.slice(0, 10).map(function (m) {
        return '<div class="member-row"><div class="who"><div class="strong">' + esc(m.nick || m.uid) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + esc(m.expireText || dayText(m.expireAt)) + ' · 剩 ' + num(m.daysLeft) + ' 天</div></div>' +
          '<div class="quick">' + (C.can('biz.grant') ? plans.map(function (p) {
            return '<button class="btn xs" data-renew="' + esc(m.uid) + '" data-plan-key="' + esc(p.key) + '" data-days="' + p.days + '" data-amount="' + p.price + '" data-nick="' + esc(m.nick || '') + '">' + esc(p.label) + '</button>'
          }).join('') : '<span class="small" style="color:var(--muted-2)">待到账确认</span>') + '</div></div>'
      }).join('') : emptyState('暂无临近到期会员', '会员到期前 7 天会集中提醒')) +
      '</div></section>'
    wireGo(view)

    view.querySelectorAll('[data-renew]').forEach(function (btn) {
      btn.onclick = async function () {
        const uid = btn.getAttribute('data-renew')
        const nick = btn.getAttribute('data-nick') || uid
        const days = Number(btn.getAttribute('data-days'))
        const planKey = btn.getAttribute('data-plan-key')
        const amount = Number(btn.getAttribute('data-amount'))
        const ok = await confirm({
          title: '续费 ' + days + ' 天',
          message: '为 <b>' + esc(nick) + '</b> 增加 ' + days + ' 天会员，实收 ' + money(amount) + '。',
          okText: '确认续费'
        })
        if (!ok) return
        btn.disabled = true
        try {
          await api('biz.grant', { uid: uid, plan: planKey, days: days, amount: amount, note: '工作台快捷续费' })
          toast('续费成功')
          C.renderPage()
        } catch (err) {
          toast(err.message, 'err')
          btn.disabled = false
        }
      }
    })

    /* 提醒口径（提前天数 / 时间 / 次数）统一取媒体页「提醒设置」 */
    api('biz.remindExpiring', {}).then(function (r) {
      if (r && Number(r.reminded) > 0) toast('已自动提醒 ' + num(r.reminded) + ' 位会员续费')
    }).catch(function () {})
  }

  /**
   * 通用角色工作台：电销 / 运营 / 内容 / 客服主管 / 审核 / 数据运营与自定义角色共用。
   * 只渲染 state.pages 允许的模块，不调用越权接口，保证新角色登录后页面完整可用。
   */
  async function renderRoleWorkbench(view, wb, wbError) {
    const role = (state.account && state.account.role) || (wb && wb.role) || ''
    const who = (state.account && state.account.name) || wbRoleText(role)
    const todos = (wb && wb.todos) || {}
    const mine = (wb && wb.mine) || {}
    function allow(page) { return C.canPage(page) }

    /* 待领取工单：用户咨询已直接生成工单，客服 / 运营领取后即可对话推进 */
    let unclaimed = 0
    if (allow('consult')) {
      try {
        const res = await api('consult.list', { tab: 'unclaimed', page: 1, limit: 1 })
        unclaimed = Number((res && res.counts && res.counts.unclaimed) || 0)
      } catch (err) { unclaimed = 0 }
    }

    const entries = WB_ENTRIES.filter(function (e) {
      return e.pages.some(allow)
    })

    /* 待处理事项：先按页面权限过滤，再按 admin.todos 的真实数量展示 */
    const defs = [
      { label: '待领取工单', todo: 'leads', count: unclaimed, note: '用户咨询已直接生成工单，领取后即可对话推进', go: 'consult', tab: 'unclaimed', goText: '去领取', page: 'consult' },
      { label: '用户留言', todo: 'unread', note: '用户直接发给平台的消息', go: 'messages', goText: '去回复', page: 'messages' },
      { label: '委托待审核', todo: 'agency', note: '待人工核对的代采 / 代售委托', go: 'biz', goText: '去审核', page: 'biz' },
      { label: '举报反馈', todo: 'reports', note: '用户提交的举报、投诉与建议', go: 'risk', tab: 'reports', goText: '去查看', page: 'risk' },
      { label: '风控待处理', todo: 'risk', note: '规则命中的风险单待处置', go: 'risk', goText: '去处置', page: 'risk' }
    ].filter(function (d) { return allow(d.page) })

    function todoOf(d) {
      return d.count != null ? Number(d.count) || 0 : wbNum(todos[d.todo])
    }
    const pendingTotal = defs.reduce(function (sum, d) { return sum + todoOf(d) }, 0)
    const kpis = [['待处理合计', wbPill(pendingTotal), '<span class="small" style="color:var(--muted-2)">' + defs.length + ' 类事项</span>']]
    defs.slice(0, 4).forEach(function (d) {
      kpis.push([d.label, num(todoOf(d)),
        '<button class="btn xs ghost" data-go="' + d.go + '"' + (d.tab ? ' data-go-tab="' + d.tab + '"' : '') + '>' + esc(d.goText) + '</button>'])
    })
    /* 补齐到 5 张，保持顶部卡片不空位 */
    if (kpis.length < 5) {
      kpis.push(['可访问模块', num(entries.length), '<span class="small" style="color:var(--muted-2)">个</span>'])
    }
    if (kpis.length < 5) {
      kpis.push(['今日', dayText(Date.now()), '<span class="small" style="color:var(--muted-2)">' + esc(wbRoleText(role)) + '</span>'])
    }

    const entryHtml = entries.length
      ? '<div class="wb-entry-grid">' + entries.map(function (e) {
        return '<button class="wb-entry" data-go="' + esc(e.key) + '">' +
          '<span class="wb-entry-icon">' + icon(e.icon) + '</span>' +
          '<span class="wb-entry-text"><b>' + esc(e.label) + '</b><i>' + esc(e.desc) + '</i></span>' +
          '<span class="wb-entry-arrow">' + icon('external') + '</span></button>'
      }).join('') + '</div>'
      : emptyState('当前角色还没有可访问的模块', '请联系管理员在「账号与权限」中为该角色分配页面')

    const todoBody = defs.length
      ? table(['事项', '待处理', '入口'], defs.map(function (d) {
        const count = todoOf(d)
        return '<td><div class="strong">' + esc(d.label) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + esc(d.note) + '</div></td>' +
          '<td>' + (count ? wbPill(count) : '<span class="small" style="color:var(--muted-2)">0</span>') + '</td>' +
          '<td><button class="btn xs' + (count ? ' primary' : '') + '" data-go="' + d.go + '"' +
          (d.tab ? ' data-go-tab="' + d.tab + '"' : '') + '>' + esc(d.goText) + '</button></td>'
      }), '当前角色暂无需处理事项')
      : emptyState('当前角色没有待处理事项', '待办会按页面权限自动出现')

    view.innerHTML = pageHead(wbHello() + '，' + who,
      dayText(Date.now()) + ' · ' + wbRoleText(role) + ' · 只展示你有权限的模块与待办') +
      (wbError ? '<div class="small" style="margin-bottom:8px;color:var(--warn)">待办数据加载失败：' + esc(wbError) + '</div>' : '') +
      kpiRow(kpis.slice(0, 5)) +
      '<section class="card" style="margin-top:16px"><div class="card-head"><h3>我的工作入口</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2)">按角色权限展示 · 共 ' + num(entries.length) + ' 个模块</span></div>' +
      '<div class="card-body">' + entryHtml + '</div></section>' +
      '<div class="grid g2" style="gap:16px;margin-top:16px">' +
      '<section class="card"><div class="card-head"><h3>待处理事项</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2)">合计 ' + wbPill(pendingTotal) + '</span></div>' +
      '<div class="card-body flush">' + todoBody + '</div></section>' +
      '<section class="card"><div class="card-head"><h3>我的作业量</h3><div class="grow"></div>' +
      '<span class="small" style="color:var(--muted-2)">' + (mine.lastAt ? '最近动作 ' + esc(ago(mine.lastAt)) : '暂无作业记录') + '</span></div>' +
      '<div class="card-body"><div class="grid g2" style="gap:12px">' +
      kpi('处理工单', num(wbNum(mine.tickets)), '<span class="small" style="color:var(--muted-2)">咨询 / 委托</span>') +
      kpi('消息回复', num(wbNum(mine.replies)), '<span class="small" style="color:var(--muted-2)">用户留言</span>') +
      kpi('内容审核', num(wbNum(mine.reviews)), '<span class="small" style="color:var(--muted-2)">商品 / 需求 / 资讯</span>') +
      kpi('风控 / 举报', num(wbNum(mine.risk) + wbNum(mine.reports)), '<span class="small" style="color:var(--muted-2)">处置合计</span>') +
      '</div></div></section></div>'
    wireGo(view)
  }

  /* ---------------- 3. 用户管理 ---------------- */

  /* 用户导出可选列：与后端 user.export 的字段白名单一一对应，导出前先勾选 */
  const USER_EXPORT_GROUPS = [
    { name: '基础信息', cols: [['id', '用户ID'], ['userNo', '用户编号'], ['nick', '昵称'], ['phone', '手机号']] },
    { name: '主体信息', cols: [['subject', '主体名称'], ['subjectType', '主体类型'], ['exposureLabel', '主体展示']] },
    {
      name: '账号与会员',
      cols: [
        ['status', '账号状态'], ['memberStatus', '会员状态'], ['memberExpireAt', '会员到期时间'],
        ['expireDays', '距到期天数'], ['bizOpen1d', '近1天会员页打开次数'], ['bizOpen7d', '近7天会员页打开次数']
      ]
    },
    {
      name: '行为数据',
      cols: [['favorites', '收藏数'], ['follows', '关注数'], ['products', '发布商品数'], ['demands', '发布需求数'], ['leads', '咨询数']]
    },
    { name: '时间与备注', cols: [['lastActiveAt', '最后活跃时间'], ['createdAt', '注册时间'], ['note', '备注']] }
  ]
  const USER_EXPORT_KEYS = USER_EXPORT_GROUPS.reduce(function (list, g) {
    return list.concat(g.cols.map(function (c) { return c[0] }))
  }, [])

  /**
   * 导出用户数据：独立整页（不是弹窗）。
   * 第 1 步选择数据类别，第 2 步底部「确认导出」；返回用户管理时保留原筛选条件。
   */
  function renderUserExport(view, baseFilters) {
    const f = baseFilters || {}
    const chosen = {}
    USER_EXPORT_KEYS.forEach(function (k) { chosen[k] = true })
    const scope = [
      f.q ? '关键词：' + f.q : '',
      f.phone ? '手机号：' + f.phone : '',
      f.status ? '状态：' + f.status : '',
      f.member ? '会员：' + (f.member === 'yes' ? '有效期内' : '非会员 / 已到期') : '',
      f.subjectType ? '主体类型：' + f.subjectType : '',
      f.city ? '城市：' + f.city : '',
      f.hasPhone ? '手机号授权：' + (f.hasPhone === 'yes' ? '已授权' : '未授权') : '',
      f.hasLicense ? '资质：' + (f.hasLicense === 'yes' ? '已上传营业执照' : '未上传') : '',
      f.agency ? '历史委托：' + (f.agency === 'buy' ? '发起过代采' : '发起过代售') : '',
      f.exposure ? '公开范围：' + (f.exposure === 'open' ? '公开主体' : '不公开主体') : ''
    ].filter(Boolean).join(' · ') || '全部用户'

    view.innerHTML = pageHead(
      '导出用户数据',
      '第 1 步：选择要导出的数据类别；第 2 步：确认导出',
      '<button class="btn" id="uex-back">返回用户管理</button>'
    ) +
      '<section class="card"><div class="card-body">' +
      '<div style="background:var(--bg);border-radius:12px;padding:12px 14px">' +
      '<div class="small" style="color:var(--muted-2)">导出范围（沿用用户列表当前筛选）</div>' +
      '<div class="strong" style="margin-top:4px">' + esc(scope) + '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-top:4px">单次最多导出 5,000 条；未勾选的数据类别不会写进 Excel。</div>' +
      '</div>' +
      '<div class="flex" style="gap:8px;margin:14px 0 2px;align-items:center">' +
      '<button class="btn xs" id="uex-all">全选</button>' +
      '<button class="btn xs" id="uex-none">清空</button>' +
      '<span class="small" style="color:var(--muted-2);margin-left:auto">已选 <strong id="uex-cnt">' + USER_EXPORT_KEYS.length + '</strong> / ' + USER_EXPORT_KEYS.length + ' 项</span>' +
      '</div>' +
      USER_EXPORT_GROUPS.map(function (g, gi) {
        return '<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px">' +
          '<label class="flex" style="gap:8px;align-items:center;cursor:pointer">' +
          '<input type="checkbox" data-uexg="' + gi + '" checked>' +
          '<span class="strong">' + esc(g.name) + '</span>' +
          '<span class="small" style="color:var(--muted-2)">全选本组</span></label>' +
          '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px">' +
          g.cols.map(function (c) {
            return '<label style="display:flex;align-items:center;gap:6px;font-size:12px">' +
              '<input type="checkbox" name="uex" value="' + esc(c[0]) + '" checked>' + esc(c[1]) + '</label>'
          }).join('') +
          '</div></div>'
      }).join('') +
      '</div></section>' +
      '<div style="position:sticky;bottom:0;margin-top:16px;background:var(--card,#fff);border-top:1px solid var(--line);' +
      'padding:12px 0;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:5">' +
      '<div class="small" style="color:var(--ink-2)">已选 <strong id="uex-cnt2">' + USER_EXPORT_KEYS.length + '</strong> 项数据</div>' +
      '<button class="btn primary" id="uex-ok">确认导出</button></div>'

    const okBtn = view.querySelector('#uex-ok')
    function inputs() {
      return Array.prototype.slice.call(view.querySelectorAll('input[name="uex"]'))
    }
    function sync() {
      const n = USER_EXPORT_KEYS.filter(function (k) { return chosen[k] }).length
      view.querySelector('#uex-cnt').textContent = n
      view.querySelector('#uex-cnt2').textContent = n
      okBtn.disabled = n === 0
      view.querySelectorAll('[data-uexg]').forEach(function (box) {
        const g = USER_EXPORT_GROUPS[Number(box.getAttribute('data-uexg'))]
        const on = g.cols.filter(function (c) { return chosen[c[0]] }).length
        box.checked = on === g.cols.length
        box.indeterminate = on > 0 && on < g.cols.length
      })
    }
    inputs().forEach(function (el) {
      el.onchange = function () {
        chosen[el.value] = el.checked
        sync()
      }
    })
    view.querySelectorAll('[data-uexg]').forEach(function (box) {
      box.onchange = function () {
        const g = USER_EXPORT_GROUPS[Number(box.getAttribute('data-uexg'))]
        g.cols.forEach(function (c) {
          chosen[c[0]] = box.checked
          const el = view.querySelector('input[name="uex"][value="' + c[0] + '"]')
          if (el) el.checked = box.checked
        })
        sync()
      }
    })
    view.querySelector('#uex-all').onclick = function () {
      USER_EXPORT_KEYS.forEach(function (k) { chosen[k] = true })
      inputs().forEach(function (el) { el.checked = true })
      sync()
    }
    view.querySelector('#uex-none').onclick = function () {
      USER_EXPORT_KEYS.forEach(function (k) { chosen[k] = false })
      inputs().forEach(function (el) { el.checked = false })
      sync()
    }
    view.querySelector('#uex-back').onclick = function () { Pages.users(view, f) }

    let exporting = false
    okBtn.onclick = async function () {
      if (exporting) return
      const fields = USER_EXPORT_KEYS.filter(function (k) { return chosen[k] })
      if (!fields.length) return toast('请至少勾选一项数据', 'err')
      exporting = true
      okBtn.disabled = true
      okBtn.textContent = '导出中…'
      try {
        const res = await api('user.export', {
          q: f.q, phone: f.phone, status: f.status, member: f.member,
          subjectType: f.subjectType, hasPhone: f.hasPhone, city: f.city,
          hasLicense: f.hasLicense, qualStatus: f.qualStatus, agency: f.agency, exposure: f.exposure,
          fields: fields
        })
        if (!res || !res.base64) throw new Error('没有可导出的数据')
        const raw = atob(res.base64)
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
        const blob = new Blob([bytes], { type: res.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = res.filename || ('用户导出-' + Date.now() + '.xlsx')
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
        toast('已导出 ' + num(res.total) + ' 条用户数据（' + fields.length + ' 项）')
      } catch (err) {
        toast(err.message || '导出失败', 'err')
      } finally {
        exporting = false
        okBtn.disabled = false
        okBtn.textContent = '确认导出'
      }
    }
    sync()
  }

  Pages.users = async function (view, savedFilters) {
    const filters = {
      q: '', phone: '', city: '', subjectType: '', status: '', hasLicense: '', qualStatus: '', agency: '',
      member: '', hasPhone: '', exposure: '', page: 1, limit: 12
    }
    /* 从「导出用户数据」页返回时恢复之前的筛选条件与页码 */
    if (savedFilters && typeof savedFilters === 'object') {
      Object.keys(filters).forEach(function (k) {
        if (savedFilters[k] !== undefined && savedFilters[k] !== null) filters[k] = savedFilters[k]
      })
    }
    let meta = { cities: [], subjectTypes: [], summary: {}, total: 0 }

    view.innerHTML = pageHead('用户管理', '账号、主体、资质、商机会员与历史委托一屏掌握',
      (C.can('accountRequest.list') ? '<button class="btn" id="u-delreq">注销申请</button>' : '') +
      '<button class="btn primary" id="u-grant">' + icon('plus') + '<span>开通 / 续费会员</span></button>') +
      '<div id="u-summary"></div>' +
      '<div class="filters" style="margin-top:16px"><div class="filter-grid">' +
      '<div class="field wide"><label>关键词</label><input id="u-q" placeholder="昵称 / 主体 / 城市 / 用户ID / 手机号"></div>' +
      field('手机号', '<input id="u-phone" placeholder="完整手机号">') +
      field('会员', '<select id="u-member">' + options([{ value: 'yes', label: '商机会员（有效期内）' }, { value: 'no', label: '非会员 / 已到期' }], '') + '</select>') +
      field('主体类型', '<select id="u-subject">' + options(meta.subjectTypes, '') + '</select>') +
      field('城市', '<select id="u-city">' + options(meta.cities, '') + '</select>') +
      field('资质', '<select id="u-license">' + options([{ value: 'yes', label: '已上传营业执照' }, { value: 'no', label: '未上传' }], '') + '</select>') +
      field('核验状态', '<select id="u-qual">' + options([{ value: 'verified', label: '已核验' }, { value: 'unverified', label: '未核验（含待核验 / 已驳回）' }, { value: 'none', label: '未上传资质' }], '') + '</select>') +
      field('公开范围', '<select id="u-exposure">' + options([{ value: 'open', label: '公开主体' }, { value: 'hidden', label: '不公开主体' }], '') + '</select>') +
      field('联系方式', '<select id="u-hasphone">' + options([{ value: 'yes', label: '已授权手机号' }, { value: 'no', label: '未授权手机号' }], '') + '</select>') +
      field('历史委托', '<select id="u-agency">' + options([{ value: 'buy', label: '发起过代采' }, { value: 'sell', label: '发起过代售' }], '') + '</select>') +
      field('账号状态', '<select id="u-status">' + options(['正常', '停用'], '') + '</select>') +
      '<div class="field action"><label>&nbsp;</label><div class="flex" style="gap:8px">' +
      '<button class="btn primary" id="u-search">' + icon('search') + '<span>检索</span></button>' +
      '<button class="btn" id="u-reset">重置</button>' +
      '<button class="btn" id="u-export"><span>导出 Excel</span></button></div></div>' +
      '</div></div>' +
      '<section class="card"><div class="card-body flush"><div id="u-table">' + loadingBlock() + '</div></div></section>'

    const qInput = view.querySelector('#u-q')
    const pInput = view.querySelector('#u-phone')
    const mSelect = view.querySelector('#u-member')
    const sSelect = view.querySelector('#u-subject')
    const cSelect = view.querySelector('#u-city')
    const lSelect = view.querySelector('#u-license')
    const qSelect = view.querySelector('#u-qual')
    const eSelect = view.querySelector('#u-exposure')
    const hpSelect = view.querySelector('#u-hasphone')
    const aSelect = view.querySelector('#u-agency')
    const stSelect = view.querySelector('#u-status')

    function readFilters() {
      filters.q = qInput.value.trim()
      filters.phone = pInput.value.trim()
      filters.member = mSelect.value
      filters.subjectType = sSelect.value
      filters.city = cSelect.value
      filters.hasLicense = lSelect.value
      filters.qualStatus = qSelect.value
      filters.exposure = eSelect.value
      filters.hasPhone = hpSelect.value
      filters.agency = aSelect.value
      filters.status = stSelect.value
    }

    function summaryHtml(summary) {
      const s = summary || {}
      return kpiRow([
        ['用户总数', num(s.total), '<span class="small" style="color:var(--muted-2)">全部注册账号</span>'],
        ['正常账号', num(s.active), '<span class="small" style="color:var(--muted-2)">停用 ' + num(s.stopped) + '</span>'],
        ['商机会员', num(s.members), '<span class="small" style="color:var(--muted-2)">有效期内</span>'],
        ['已上传资质', num(s.licenses), '<span class="small" style="color:var(--muted-2)">营业执照 / 法人证件</span>'],
        ['国央企主体', num(s.stateOwned), '<span class="small" style="color:var(--muted-2)">主体类型为国企 / 央企</span>']
      ])
    }

    function rowHtml(u) {
      const member = u.memberStatus
        ? autoBadge(u.memberStatus) + (u.memberExpireAt ? '<div class="small" style="color:var(--muted-2)">' + dayText(u.memberExpireAt) + ' 到期</div>' : '')
        : badge('未开通')
      /* 资质直接展示在列表里：每项材料 + 核验状态 + 原件入口，不必先打开详情 */
      const qualItems = Array.isArray(u.qualItems) ? u.qualItems : []
      const qualCell = qualItems.length
        ? qualItems.map(function (q) {
          return '<div class="flex" style="gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0">' +
            '<span class="small strong">' + esc(q.name || '资质材料') + '</span>' +
            autoBadge(q.status || '待核验') +
            (q.fileId ? '<button class="btn xs" data-qual-uid="' + esc(u.id) + '" data-qual-file="' + esc(q.fileId) + '">原件</button>' : '') +
            '</div>'
        }).join('')
        : badge('未上传', 'warn', true)
      return '<td><div class="flex" style="gap:8px;align-items:center"><span class="avatar sm">' + esc(String(u.nick || '用').slice(0, 1)) + '</span>' +
        '<div><div class="strong">' + esc(u.nick) + '</div>' +
        '<div class="small mono strong" style="color:var(--ink-2)">' + esc(u.userNo || '—') + '</div>' +
        '<div class="small mono" style="color:var(--muted-2)">' + esc(u.id) + '</div></div></div></td>' +
        '<td>' + (u.phone
          ? '<span class="mono">' + esc(u.phone) + '</span>'
          : '<span class="small" style="color:var(--muted-2)">' + (u.phoneSaved ? '加密号码解析失败' : '未授权') + '</span>') + '</td>' +
        '<td><div>' + esc(u.subjectType || '个人') + '</div><div class="small" style="color:var(--muted-2)">' + esc(u.subject || '未填写主体') + '</div></td>' +
        '<td>' + esc(u.city || '—') + '</td>' +
        '<td>' + member + '</td>' +
        '<td>' + qualCell + '</td>' +
        '<td><span class="small">代采 ' + num(u.agencyBuy) + ' · 代售 ' + num(u.agencySell) + '</span></td>' +
        '<td>' + num(u.publishCount) + '</td>' +
        '<td>' + autoBadge(u.status) + '</td>' +
        '<td><button class="btn xs" data-open="' + esc(u.id) + '">详情</button></td>'
    }

    async function load() {
      const box = view.querySelector('#u-table')
      box.innerHTML = loadingBlock('加载用户')
      try {
        const data = await api('user.list', Object.assign({ page: filters.page, limit: filters.limit }, filters))
        meta = {
          cities: data.cities || meta.cities,
          subjectTypes: data.subjectTypes || meta.subjectTypes,
          summary: data.summary || {},
          total: data.total || 0
        }
        view.querySelector('#u-summary').innerHTML = summaryHtml(meta.summary)
        if (!cSelect.options.length || cSelect.options.length <= 1) cSelect.innerHTML = options(meta.cities, filters.city)
        if (!sSelect.options.length || sSelect.options.length <= 1) sSelect.innerHTML = options(meta.subjectTypes, filters.subjectType)
        const rows = (data.items || []).map(rowHtml)
        box.innerHTML = table(['用户', '手机号', '主体', '城市', '会员', '资质', '历史委托', '发布', '状态', '操作'], rows, '没有匹配的用户') +
          (meta.total > filters.limit ? pager(meta.total, filters.page, filters.limit) : '')
        wirePager(box, function (p) { filters.page = p; load() })
        box.querySelectorAll('[data-open]').forEach(function (btn) {
          btn.onclick = function () { openUserDrawer(btn.getAttribute('data-open'), load) }
        })
        /* 列表内直接查看资质原件：不打开用户详情抽屉，看完仍停在当前页 */
        box.querySelectorAll('[data-qual-file]').forEach(function (btn) {
          btn.onclick = async function () {
            const uid = btn.getAttribute('data-qual-uid')
            const fileId = btn.getAttribute('data-qual-file')
            if (!fileId) return toast('该材料没有上传原件', 'err')
            btn.disabled = true
            try {
              const res = await api('qual.fileUrl', { uid: uid, fileId: fileId })
              if (res && res.url) window.open(res.url, '_blank')
              else toast('原件链接不可用', 'err')
            } catch (err) {
              toast(err.message, 'err')
            }
            btn.disabled = false
          }
        })
      } catch (err) {
        box.innerHTML = '<div class="card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    view.querySelector('#u-search').onclick = function () {
      readFilters()
      filters.page = 1
      load()
    }
    view.querySelector('#u-reset').onclick = function () {
      filters.q = ''
      filters.phone = ''
      filters.city = ''
      filters.subjectType = ''
      filters.status = ''
      filters.hasLicense = ''
      filters.qualStatus = ''
      filters.agency = ''
      filters.member = ''
      filters.hasPhone = ''
      filters.exposure = ''
      filters.page = 1
      qInput.value = ''
      pInput.value = ''
      ;[mSelect, sSelect, cSelect, lSelect, qSelect, eSelect, hpSelect, aSelect, stSelect].forEach(function (s) { if (s) s.value = '' })
      load()
    }
    view.querySelector('#u-grant').onclick = function () { openGrantModal({}) }
    /* 导出：进入独立页面选数据类别，确认后生成 Excel；数据范围沿用当前筛选条件 */
    const exportBtn = view.querySelector('#u-export')
    exportBtn.onclick = function () {
      readFilters()
      renderUserExport(view, Object.assign({}, filters))
    }
    const delReqBtn = view.querySelector('#u-delreq')
    if (delReqBtn) delReqBtn.onclick = function () { openAccountRequests(function () { load() }) }
    qInput.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); view.querySelector('#u-search').click() } }
    pInput.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); view.querySelector('#u-search').click() } }

    load()
  }

  /* 用户发布历史：先按 ID 取完整详情，再关闭用户抽屉并打开对应详情抽屉 */
  async function openUserPublishDetail(kind, id, btn) {
    if (!id) return
    const label = kind === 'product' ? '商品' : '需求'
    const oldText = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = '加载中…' }
    try {
      const data = await api(kind + '.detail', { id: id })
      const item = (data && (data.product || data.demand)) || data
      if (!item || !item.id) throw new Error(label + '详情暂不可用')
      closeDrawer()
      if (kind === 'product') openProductDrawer(item)
      else openDemandDrawer(item)
    } catch (err) {
      toast(err.message || (label + '详情加载失败'), 'err')
      if (btn) { btn.disabled = false; btn.textContent = oldText }
    }
  }

  /* ---------------- 3.2 调整账号（用户页 / 举报处置共用） ---------------- */

  const RESTRICT_KINDS = [
    ['publish', '发布内容'],
    ['news', '发布资讯'],
    ['chat', '发起对话']
  ]

  function restrictionBadges(rest) {
    if (!rest) return ''
    return RESTRICT_KINDS.filter(function (k) { return rest[k[0]] }).map(function (k) {
      return badge(k[1] + ' 剩 ' + num(rest[k[0]].daysLeft) + ' 天', 'danger', true)
    }).join('')
  }

  function restrictionSummary(rest) {
    const active = RESTRICT_KINDS.filter(function (k) { return rest && rest[k[0]] })
    if (!active.length) return '当前没有功能限制'
    return '限制中：' + active.map(function (k) {
      return k[1] + '至 ' + rest[k[0]].untilText
    }).join('；') + (rest.reason ? '（原因：' + rest.reason + '）' : '')
  }

  function restrictionSelect(rest, kind) {
    const hit = rest && rest[kind]
    const list = [
      { value: '', label: hit ? '保持当前（剩 ' + num(hit.daysLeft) + ' 天）' : '保持当前（不限制）' },
      { value: '0', label: '解除该限制' }
    ]
    ;[1, 3, 7, 15, 30, 90].forEach(function (d) {
      list.push({ value: String(d), label: '禁止 ' + d + ' 天' })
    })
    return '<select id="ua-' + kind + '">' + options(list, '', false) + '</select>'
  }

  /**
   * 调整账号：账号状态、主体曝光、发布内容 / 发布资讯 / 发起对话三类限制。
   * 限制按截止时间落库，到期自动恢复；举报处置时可直接复用。
   */
  function openUserEditModal(u, onDone) {
    const rest = u.restrictions || {}
    const root = modal({
      title: '调整账号',
      sub: u.nick || u.id,
      wide: true,
      body: '<div class="form-grid">' +
        field('账号状态', '<select id="ua-status">' + options(['正常', '停用'], u.status || '正常', false) + '</select>') +
        field('主体曝光范围', '<select id="ua-exposure">' + options([
          { value: 'hidden', label: '不公开主体' },
          { value: 'open', label: '公开主体' }
        ], u.exposure === 'open' ? 'open' : 'hidden', false) + '</select>') +
        field('禁止发布内容', restrictionSelect(rest, 'publish')) +
        field('禁止发布资讯', restrictionSelect(rest, 'news')) +
        field('禁止发起对话', restrictionSelect(rest, 'chat')) +
        '<div class="field full"><label>限制原因（会站内信通知用户）</label>' +
        '<input id="ua-reason" maxlength="120" value="' + esc(rest.reason || '') + '" placeholder="例如：发布虚假信息，举报核实成立"></div>' +
        '<div class="field full"><label>内部备注</label><textarea id="ua-note" rows="3">' + esc(u.note || '') + '</textarea></div>' +
        '</div>' +
        '<div class="card" style="margin-top:12px"><div class="card-body">' +
        '<div class="strong">' + esc(restrictionSummary(rest)) + '</div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:6px;line-height:1.8">' +
        '限制按天设置，到期自动恢复；重复处罚会在当前截止时间上顺延，避免多次举报只算一次。' +
        '「发布内容」影响商品 / 需求的发布与草稿转正式；「发布资讯」影响资讯圈投稿；' +
        '「发起对话」影响直聊、咨询与商机对接，已存在的会话仍可回复。' +
        '</div></div></div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ua-ok">保存</button>'
    })
    if (!root) return
    root.querySelector('#ua-ok').onclick = async function () {
      this.disabled = true
      try {
        await api('user.admin', {
          uid: u.id,
          status: root.body.querySelector('#ua-status').value,
          exposure: root.body.querySelector('#ua-exposure').value,
          note: root.body.querySelector('#ua-note').value.trim(),
          restrict: {
            publish: root.body.querySelector('#ua-publish').value,
            news: root.body.querySelector('#ua-news').value,
            chat: root.body.querySelector('#ua-chat').value
          },
          restrictReason: root.body.querySelector('#ua-reason').value.trim()
        })
        closeModal()
        toast('账号与权限已更新')
        if (typeof onDone === 'function') onDone()
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  async function openUserDrawer(uid, onDone) {
    let data
    try {
      data = await api('user.detail', { uid: uid })
    } catch (err) {
      toast(err.message, 'err')
      return
    }
    const u = data.user || {}
    const tabs = data.tabs || {}
    const recent = data.recent

    const tabConf = [
      ['overview', '概览'], ['promote', '推广'], ['membership', '会员'], ['qualification', '资质'],
      ['buy', '代采'], ['sell', '代售'], ['consult', '咨询'], ['stock', '库存'],
      ['publish', '发布'], ['social', '收藏关注'], ['chats', '聊天记录'], ['events', '操作记录']
    ].filter(function (t) {
      /* 聊天记录需要消息监管权限，财务等角色不展示该页 */
      if (t[0] === 'chats' && !C.can('user.chats')) return false
      /* 推广数据涉及佣金与提现，仅管理员 / 财务可见 */
      if (t[0] === 'promote' && !promoteCanView()) return false
      return true
    })

    const drawer = openDrawer({
      title: u.nick || u.id,
      avatar: u.nick || '用',
      sub: esc(u.userNo || u.id) + ' · ' + esc(u.id) + ' · ' + esc(u.city || '城市未知') + ' · 注册 ' + esc(u.joined || '—'),
      badges: autoBadge(u.status) +
        (u.hasLicense ? badge('有营业执照', 'ok', true) : badge('未上传资质', 'warn', true)) +
        (u.phoneSaved ? badge('已留手机号', 'info') : badge('未留手机号')) +
        badge(u.exposureLabel || '不公开主体') + restrictionBadges(u.restrictions),
      body: '<div class="tabs" id="u-tabs">' + tabConf.map(function (t, i) {
        return '<button data-tab="' + t[0] + '"' + (i === 0 ? ' class="on"' : '') + '>' + t[1] + '</button>'
      }).join('') + '</div><div id="u-panel" style="margin-top:14px"></div>',
      foot: '<button class="btn" id="u-edit">调整账号</button>' +
        '<button class="btn primary" id="u-grant">开通 / 续费会员</button>'
    })
    if (!drawer) return

    const panel = drawer.body.querySelector('#u-panel')
    /* 记录当前 Tab：操作完成后原地刷新，仍停留在操作前的页面 */
    let activeKey = 'overview'

    function renderTab(key) {
      activeKey = key
      drawer.body.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === key) })
      if (key === 'overview') {
        const o = tabs.overview || {}
        panel.innerHTML = kvList([
          ['用户ID', '<span class="mono strong">' + esc(u.userNo || '—') + '</span>'],
          ['账号标识', '<span class="mono small">' + esc(u.id) + '</span>'],
          ['发布商品', num(o.productCount)], ['发布需求', num(o.demandCount)],
          ['历史代采 / 代售', num(o.agencyCount)], ['领取商机', num(o.leadCount)],
          ['库存记录', num(o.stockCount)], ['收款记录', num(o.paymentCount)],
          ['商机会员', o.memberActive
            ? '有效 · ' + esc(o.memberExpireText || '')
            : (o.memberStatus && o.memberStatus !== '未开通'
              ? esc(o.memberStatus) + (o.memberExpireText ? ' · ' + esc(o.memberExpireText) : '')
              : '未开通')],
          ['主体类型', esc(u.subjectType || '个人')], ['主体名称', esc(u.subject || '未填写')],
          ['联系方式', esc(u.phone || u.contact || u.phoneMasked || '未留')],
          ['曝光范围', esc(u.exposureLabel || '不公开主体')],
          ['功能限制', esc(restrictionSummary(u.restrictions))],
          ['内部备注', esc(u.note || '无')]
        ]) + (recent ? '<div class="small" style="margin-top:12px;color:var(--muted-2)">最近动态：' + esc(String(recent).slice(0, 120)) + '</div>' : '') +
          '<div id="u-promote" style="margin-top:18px"></div>'
        renderUserPromote(panel.querySelector('#u-promote'), u, uid)
      } else if (key === 'promote') {
        panel.innerHTML = '<div id="u-promote-tab"></div>'
        renderUserPromoteTab(panel.querySelector('#u-promote-tab'), u, uid)
      } else if (key === 'membership') {
        const m = tabs.membership || {}
        panel.innerHTML = kvList([
          ['当前状态', m.active ? '有效' : esc(m.status || '未开通')],
          ['开始时间', m.startAt ? dateText(m.startAt) : '—'],
          ['到期时间', m.expireAt ? dayText(m.expireAt) + '（剩 ' + num(m.daysLeft) + ' 天）' : '—'],
          ['累计订单', num((m.orders || []).length)]
        ]) + '<div class="flex flex-wrap" style="gap:8px;margin-top:14px">' +
          (m.status && m.status !== '未开通' ? '<button class="btn xs" id="u-expire">修改到期时间</button>' : '') +
          (m.status === '已开通' || m.status === '待确认' ? '<button class="btn xs danger" id="u-revoke">关闭会员权限</button>' : '') +
          '</div>' + '<div style="margin-top:14px">' + table(['订单', '套餐', '天数', '金额', '收款方式', '到期', '时间'],
          (m.orders || []).map(function (o) {
            return '<td class="mono">' + esc(o.id) + '</td><td>' + esc(o.planLabel || o.planKey || '') + '</td>' +
              '<td>' + num(o.days) + '</td><td>' + money(o.amount) + '</td><td>' + esc(o.method || '') + '</td>' +
              '<td>' + dayText(o.expireAt) + '</td><td>' + esc(o.createdText || dateText(o.createdAt)) + '</td>'
          }), '暂无会员订单') + '</div>'
        const expireBtn = panel.querySelector('#u-expire')
        if (expireBtn) {
          expireBtn.onclick = function () {
            openBizExpireModal({ uid: uid, nick: u.nick, expireAt: m.expireAt }, function () { reloadTabs() })
          }
        }
        const revokeBtn = panel.querySelector('#u-revoke')
        if (revokeBtn) {
          revokeBtn.onclick = function () {
            openRevokeModal({ uid: uid, nick: u.nick }, function () { reloadTabs() })
          }
        }
      } else if (key === 'qualification') {
        const q = tabs.qualification || {}
        panel.innerHTML = kvList([
          ['主体类型', esc(q.subjectType || '个人')],
          ['主体名称', esc(q.subject || '未填写')],
          ['营业执照', q.hasLicense ? '已上传' : '未上传'],
          ['曝光范围', esc(q.exposureLabel || '')],
          ['注册时间', esc(q.joined || '—')],
          ['城市', esc(q.city || '—')]
        ]) + '<div style="margin-top:14px">' + table(['材料', '类型', '核验状态', '上传时间', '操作'],
          (q.quals || []).map(function (qq) {
            return '<td>' + esc(qq.name) + '</td><td>' + esc(qq.kind || '—') + '</td>' +
              '<td>' + autoBadge(qq.status || '待核验') + '</td><td>' + (qq.at ? dateText(qq.at) : '—') + '</td>' +
              '<td><div class="flex" style="gap:6px"><button class="btn xs" data-file="' + esc(qq.fileId || '') + '">查看原件</button>' +
              '<button class="btn xs primary" data-verify="' + esc(qq.name) + '" data-kind="' + esc(qq.kind || '') + '">核验</button></div></td>'
          }), '用户尚未上传资质材料') + '</div>'
        panel.querySelectorAll('[data-file]').forEach(function (btn) {
          btn.onclick = async function () {
            const fileId = btn.getAttribute('data-file')
            if (!fileId) return toast('该材料只有名称，没有上传原件', 'err')
            btn.disabled = true
            try {
              const res = await api('qual.fileUrl', { uid: u.id, fileId: fileId })
              if (res && res.url) window.open(res.url, '_blank')
              else toast('原件链接不可用', 'err')
            } catch (err) {
              toast(err.message, 'err')
            }
            btn.disabled = false
          }
        })
        panel.querySelectorAll('[data-verify]').forEach(function (btn) {
          btn.onclick = function () {
            const name = btn.getAttribute('data-verify')
            const kind = btn.getAttribute('data-kind')
            const root = modal({
              title: '核验资质原件',
              sub: name,
              body: field('核验结论', '<select id="v-status">' + options(['已核验', '已驳回', '待核验'], '已核验', false) + '</select>') +
                field('驳回原因', '<input id="v-reason" maxlength="120" placeholder="选择「已驳回」时填写，会同步展示给用户">') +
                '<div class="small" style="margin-top:10px;color:var(--muted-2);line-height:1.7">请先通过「查看原件」比对营业执照 / 法人证件；核验结论与驳回原因会记录操作人并站内信通知用户。</div>',
              footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="v-ok">提交</button>'
            })
            if (!root) return
            root.querySelector('#v-ok').onclick = async function () {
              const status = root.body.querySelector('#v-status').value
              const reason = root.body.querySelector('#v-reason').value.trim()
              if (status === '已驳回' && !reason) { toast('请填写驳回原因，用户需要知道补什么材料'); return }
              this.disabled = true
              try {
                await api('qual.verify', { uid: uid, name: name, kind: kind, status, reason })
                closeModal()
                toast('核验结论已保存')
                /* 留在资质页原地刷新，不跳回概览 */
                reloadTabs()
              } catch (err) {
                toast(err.message, 'err')
                this.disabled = false
              }
            }
          }
        })
      } else if (key === 'buy' || key === 'sell') {
        const list = tabs[key] || []
        panel.innerHTML = table(['委托内容', '类型', '城市', '金额', '服务费', '状态', '时间'],
          list.map(function (a) {
            return '<td>' + esc(a.item || '') + '</td><td>' + esc(a.kind || '') + '</td><td>' + esc(a.city || '') + '</td>' +
              '<td>' + money(a.amount) + '</td><td>' + money(a.serviceFee) + '</td><td>' + autoBadge(a.status) + '</td>' +
              '<td>' + esc(a.createdText || dateText(a.createdAt)) + '</td>'
          }), key === 'buy' ? '没有代采记录' : '没有代售记录')
      } else if (key === 'consult') {
        const list = tabs.consult || []
        panel.innerHTML = table(['咨询对象', '城市', '状态', '时间'],
          list.map(function (c) {
            return '<td>' + esc(c.title || '') + '</td><td>' + esc(c.city || '') + '</td>' +
              '<td>' + autoBadge(c.status) + '</td><td>' + esc(c.createdText || dateText(c.createdAt)) + '</td>'
          }), '没有咨询记录')
      } else if (key === 'stock') {
        const list = tabs.stock || []
        panel.innerHTML = table(['品类 / 型号', '数量', '价格', '城市', '更新时间'],
          list.map(function (s) {
            return '<td>' + esc(s.cat || '') + ' · ' + esc(s.model || '') + '</td><td>' + num(s.qty) + '</td>' +
              '<td>' + money(s.price) + '</td><td>' + esc(s.city || '') + '</td><td>' + esc(s.updatedText || dayText(s.updatedAt)) + '</td>'
          }), '没有库存记录')
      } else if (key === 'publish') {
        const p = tabs.publish || {}
        const blocks = [
          ['商品', p.products || [], function (x) { return esc(x.title || x.model || '') + ' · ' + money(x.price) }, function (x) {
            return '<div class="flex" style="gap:8px;align-items:center"><span class="small" style="color:var(--muted-2)">' + esc(x.status || '') + '</span>' +
              (x.id ? '<button class="btn xs" data-pub-product="' + esc(x.id) + '">查看商品</button>' : '') + '</div>'
          }],
          ['需求', p.demands || [], function (x) { return esc(x.title || x.model || '') + ' · 预算 ' + money(x.budget) }, function (x) {
            return '<div class="flex" style="gap:8px;align-items:center"><span class="small" style="color:var(--muted-2)">' + esc(x.status || '') + '</span>' +
              (x.id ? '<button class="btn xs" data-pub-demand="' + esc(x.id) + '">查看需求</button>' : '') + '</div>'
          }],
          ['报价', p.quotes || [], function (x) { return esc(x.title || x.model || '') + ' · ' + money(x.price) }],
          ['资讯', p.news || [], function (x) { return esc(x.title || '') }],
          ['收款', p.payments || [], function (x) { return esc(x.bizType || '') + ' · ' + money(x.amount) }]
        ]
        panel.innerHTML = blocks.map(function (b) {
          return '<div class="strong" style="margin:10px 0 6px">' + b[0] + '（' + b[1].length + '）</div>' +
            (b[1].length
              ? '<div class="card card-body" style="padding:10px 12px">' + b[1].slice(0, 8).map(function (x) {
                return '<div class="list-row" style="padding:6px 0"><div class="grow">' + b[2](x) + '</div>' +
                  (b[3] ? b[3](x) : '<span class="small" style="color:var(--muted-2)">' + esc(x.status || '') + '</span>') + '</div>'
              }).join('') + '</div>'
              : '<div class="small" style="color:var(--muted-2)">暂无</div>')
        }).join('')
        panel.querySelectorAll('[data-pub-product]').forEach(function (btn) {
          btn.onclick = function () { openUserPublishDetail('product', btn.getAttribute('data-pub-product'), btn) }
        })
        panel.querySelectorAll('[data-pub-demand]').forEach(function (btn) {
          btn.onclick = function () { openUserPublishDetail('demand', btn.getAttribute('data-pub-demand'), btn) }
        })
      } else if (key === 'chats') {
        renderChats()
      } else if (key === 'events') {
        const e = tabs.events || {}
        const counts = e.counts || {}
        panel.innerHTML = '<div class="flex flex-wrap" style="gap:6px;margin-bottom:10px">' +
          Object.keys(counts).map(function (k) { return badge(k + ' ' + counts[k], 'info') }).join('') + '</div>' +
          table(['行为', '对象', '页面', '时间'],
            (e.items || []).map(function (it) {
              return '<td><div class="strong">' + esc(it.label || it.kind) + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(it.kind) + '</div></td>' +
                '<td>' + esc(it.title || it.refId || '') + '</td><td>' + esc(it.page || '') + '</td>' +
                '<td>' + esc(it.atText || dateText(it.at)) + '</td>'
            }), '暂无操作记录')
      } else if (key === 'social') {
        const s = tabs.social || {}
        panel.innerHTML = '<div class="strong" style="margin-bottom:6px">收藏（' + (s.favorites || []).length + '）</div>' +
          table(['对象类型', '对象', '时间'],
            (s.favorites || []).map(function (f) {
              return '<td>' + esc(f.targetType || '') + '</td><td>' + esc(f.title || f.targetId || '') + '</td><td>' + esc(f.atText || dateText(f.at)) + '</td>'
            }), '暂无收藏') +
          '<div class="strong" style="margin:16px 0 6px">关注（' + (s.follows || []).length + '）</div>' +
          table(['关注对象', '类型', '时间'],
            (s.follows || []).map(function (f) {
              return '<td>' + esc(f.nick || f.targetNick || f.targetKey || '') + '</td><td>' + esc(f.targetType || f.targetKey || '') + '</td><td>' + esc(f.atText || dateText(f.at)) + '</td>'
            }), '暂无关注')
      }
    }

    /* 操作后原地刷新数据并重绘当前 Tab：不关闭抽屉、不跳回概览页 */
    async function reloadTabs() {
      try {
        const fresh = await api('user.detail', { uid: uid })
        Object.assign(u, fresh.user || {})
        Object.assign(tabs, fresh.tabs || {})
        renderTab(activeKey)
        /* 抽屉后面是用户列表：同步刷新，保持筛选与页码不变 */
        if (typeof onDone === 'function') onDone()
      } catch (err) {
        toast(err.message || '刷新失败', 'err')
      }
    }

    /* 历史对话：会话列表 → 点开查看完整消息流（用户与货主 / 买家 / 客服的全部往来） */
    function chatsVisible() {
      const btn = drawer.body.querySelector('[data-tab="chats"]')
      return !!btn && btn.classList.contains('on')
    }

    function renderChats() {
      panel.innerHTML = loadingBlock('加载历史对话')
      api('user.chats', { uid: uid }).then(function (data) {
        if (!chatsVisible()) return
        const items = (data && data.items) || []
        if (!items.length) {
          panel.innerHTML = emptyState('该用户暂无历史对话', '用户与货主、买家或客服发起沟通后，会话会汇总到这里')
          return
        }
        panel.innerHTML = '<div class="small" style="color:var(--muted-2);margin-bottom:8px">共 ' +
          num(data.total) + ' 个会话 · ' + num(data.messages) + ' 条消息，点击「查看」翻看完整记录（手机号、证件号已脱敏）</div>' +
          table(['会话', '消息', '最近时间', '操作'],
            items.map(function (t) {
              const isKf = t.channel === 'kf'
              /* 客服会话按商品 / 委托拆分：标题优先用对象标题，管理端直接看出围绕哪个商品聊的 */
              const title = isKf ? (t.targetTitle || '客服留言') : (t.title || '直聊会话')
              const sub = isKf ? '平台客服' : ('对方：' + (t.peerName || '—'))
              const typeText = isKf
                ? (t.targetType === 'agency' ? '委托咨询' : (t.targetType === 'product' ? '商品咨询' : (t.targetType === 'demand' ? '需求咨询' : '客服')))
                : (t.targetType === 'demand' ? '需求' : (t.targetType === 'product' ? '商品' : '直聊'))
              return '<td><div class="strong">' + esc(title) + '</div>' +
                '<div class="small" style="color:var(--muted-2)">' + badge(typeText, 'info') + ' ' + esc(sub) +
                (t.leadStatus ? ' · ' + esc(t.leadStatus) : '') + '</div>' +
                '<div class="small" style="color:var(--muted-2);margin-top:2px">' + esc(t.lastBody || '') + '</div></td>' +
                '<td>' + num(t.total) + ' 条</td>' +
                '<td>' + esc(t.lastText || dateText(t.lastAt)) + '</td>' +
                '<td><button class="btn xs" data-chat="' + esc(t.threadId) + '" data-channel="' + esc(t.channel) + '">查看</button></td>'
            }), '该用户暂无历史对话')
        panel.querySelectorAll('[data-chat]').forEach(function (btn) {
          btn.onclick = function () {
            const threadId = btn.getAttribute('data-chat')
            const channel = btn.getAttribute('data-channel')
            panel.innerHTML = loadingBlock('加载会话')
            api('user.chatThread', { uid: uid, threadId: threadId, channel: channel }).then(function (detail) {
              if (!chatsVisible()) return
              const list = detail.items || []
              panel.innerHTML = '<div class="flex" style="align-items:center;gap:8px;margin-bottom:8px">' +
                '<button class="btn xs" id="u-chat-back">返回会话列表</button>' +
                '<span class="small" style="color:var(--muted-2)">' + esc(detail.peerName || '') + ' · 共 ' + num(detail.total) + ' 条</span></div>' +
                '<div class="chat-note">聊天内容已脱敏展示：手机号、证件号中间位已隐藏，仅用于核实沟通情况。</div>' +
                '<div class="chat-stream">' + (list.length ? list.map(function (m) {
                  return '<div class="chat-bubble' + (m.outgoing ? ' me' : '') + '">' +
                    '<div class="meta">' + esc(m.senderName || '') + ' · ' + esc(m.atText || dateText(m.at)) + '</div>' +
                    msgContentHtml(m, { uid: detail.uid || uid, nick: detail.nick || detail.peerName }) + '</div>'
                }).join('') : emptyState('该会话暂无消息')) + '</div>'
              /* 图片 / 视频先续期再查看，过期的媒体只显示占位 */
              mediaBind(panel)
              const back = panel.querySelector('#u-chat-back')
              if (back) back.onclick = function () { renderChats() }
            }).catch(function (err) {
              panel.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
            })
          }
        })
      }).catch(function (err) {
        panel.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      })
    }

    drawer.body.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.onclick = function () { renderTab(btn.getAttribute('data-tab')) }
    })
    renderTab('overview')

    drawer.foot.querySelector('#u-grant').onclick = function () {
      openGrantModal({ uid: uid, nick: u.nick, onDone: function () { reloadTabs() } })
    }
    drawer.foot.querySelector('#u-edit').onclick = function () {
      openUserEditModal(u, function () { reloadTabs() })
    }
  }

  /* ---------------- 3.5 咨询单 ---------------- */

  const LEAD_STATUS_LIST = ['待分配', '跟进中', '已对接', '已成交', '已关闭', '已拦截']
  const LEAD_TONE = { 待分配: 'warn', 跟进中: 'info', 已对接: 'ok', 已成交: 'ok', 已关闭: '', 已拦截: 'danger' }
  /* 与后端 LEAD_TRANSITIONS 保持一致；前端只控制按钮显隐，最终以后端校验为准 */
  const LEAD_NEXT = {
    已拦截: ['待分配', '已关闭'],
    待分配: ['跟进中', '已关闭'],
    跟进中: ['已对接', '待分配', '已关闭'],
    已对接: ['已成交', '已关闭'],
    已成交: ['已关闭'],
    已关闭: []
  }
  const LEAD_SOURCE_LABEL = { product: '商品咨询', demand: '求购咨询', agency: '代采代售' }

  /* 筛选条件跨刷新保留，避免处置完一单回来又回到第一页 */
  const leadState = { status: '待分配', q: '', mine: false, page: 1, limit: 12 }

  function leadTitle(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (!value) return '用户咨询'
    return value.length > max ? value.slice(0, max) + '…' : value
  }

  Pages.leads = async function (view) {
    view.innerHTML = pageHead(
      '咨询单',
      '仅展示代采 / 代售委托收到的咨询。列表直接标明「谁向谁发起」，详情可核对双方资料与委托条件；先领取再跟进，驳回或关闭需填写原因。'
    ) +
      '<div class="tabs ld-tabs" id="ld-tabs">' + LEAD_STATUS_LIST.map(function (s) {
        return '<button data-st="' + esc(s) + '" class="' + (leadState.status === s ? 'on' : '') + '">' + esc(s) +
          '<span class="count" data-count="' + esc(s) + '"></span></button>'
      }).join('') + '</div>' +
      '<div class="filters">' +
        '<div class="field" style="flex:1 1 260px;min-width:240px"><label>关键词</label><input id="ld-q" placeholder="咨询摘要 / 目标名称" value="' + esc(leadState.q) + '"></div>' +
        '<label class="check-line"><input type="checkbox" id="ld-mine"' + (leadState.mine ? ' checked' : '') + '><span>只看我的已领取</span></label>' +
        '<button class="btn primary" id="ld-search">' + icon('search') + '<span>查询</span></button>' +
        '<button class="btn" id="ld-reset">重置</button>' +
      '</div>' +
      card('咨询单列表',
        '<div id="ld-list">' + loadingBlock('加载咨询单') + '</div>',
        '', true)

    const root = view

    async function loadCounts() {
      const counts = await Promise.all(LEAD_STATUS_LIST.map(function (s) {
        return api('lead.list', { targetType: 'agency', status: s, page: 1, limit: 1 }).then(function (r) { return r.total || 0 }).catch(function () { return 0 })
      }))
      const map = {}
      LEAD_STATUS_LIST.forEach(function (s, i) { map[s] = counts[i] })
      return map
    }

    async function loadList() {
      const list = root.querySelector('#ld-list')
      if (list) list.innerHTML = loadingBlock('加载咨询单')
      let res = null
      try {
        res = await api('lead.list', {
          targetType: 'agency',
          status: leadState.status,
          q: leadState.q,
          mine: leadState.mine,
          page: leadState.page,
          limit: leadState.limit
        })
      } catch (err) {
        if (list) list.innerHTML = emptyState(err.message || '加载失败')
        return
      }
      const items = res.items || []
      const rows = items.map(function (l) {
        /* 列表第一眼就能看出是谁对谁发起了代采 / 代售咨询 */
        const consultNick = l.consultNick || '咨询方'
        const publisherNick = l.publisherNick || '委托方'
        const sideLabel = l.sideLabel || (LEAD_SOURCE_LABEL[l.targetType] || '代采代售')
        return '<td><div class="strong">' + esc(consultNick) +
            ' <span class="small" style="color:var(--muted-2)">向</span> ' + esc(publisherNick) +
            ' <span class="small" style="color:var(--muted-2)">发起</span>' + esc(sideLabel) + '咨询</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(leadTitle(l.formSummary, 34)) +
            (l.targetTitle ? ' · ' + esc(l.targetTitle) : '') + '</div></td>' +
          '<td>' + num(l.matchPct) + '%</td>' +
          '<td class="small">' + esc(l.tierName || l.tier || '默认') + '</td>' +
          '<td>' + (l.assignedAccount ? esc(l.assignedTo || l.assignedAccount) : '<span class="small" style="color:var(--muted-2)">未领取</span>') +
            (l.isCsConsult ? '<div style="margin-top:3px">' + badge(l.csStatus || '待领取', l.csStatus === '已结束' ? '' : (l.csStatus === '服务中' ? 'ok' : 'warn')) +
              (l.ticketStateLabel && l.ticketState !== 'ticketed'
                ? ' ' + badge(l.ticketStateLabel, l.ticketState === 'invalid' ? 'danger' : 'warn')
                : '') +
              (l.rating ? ' ' + csStars(l.rating) : '') + '</div>' : '') + '</td>' +
          '<td>' + badge(l.status, LEAD_TONE[l.status] || '') +
            (l.remindCount ? ' ' + badge('催办 ' + num(l.remindCount), 'warn') : '') + '</td>' +
          '<td class="small">' + esc(ago(l.createdAt)) + '</td>' +
          '<td><button class="btn xs" data-lead="' + esc(l.id) + '">详情</button>' +
            (C.can('lead.claim') && ((l.status === '待分配') || (l.isCsConsult && l.csStatus === '待领取'))
              ? '<button class="btn xs primary" data-claim="' + esc(l.id) + '">' + (l.isCsConsult ? '领取并磋商' : '领取') + '</button>' : '') +
          '</td>'
      })
      if (list) {
        list.innerHTML = table(['谁 → 谁（咨询关系）', '匹配度', '档位', '归属坐席', '状态', '提交时间', '操作'], rows, '当前筛选下暂无代采 / 代售咨询') +
          pager(res.total, leadState.page, leadState.limit)
        wirePager(list, function (p) { leadState.page = p; loadList() })
        list.querySelectorAll('[data-lead]').forEach(function (btn) {
          btn.onclick = function () { openLeadDrawer(btn.getAttribute('data-lead'), refresh) }
        })
        list.querySelectorAll('[data-claim]').forEach(function (btn) {
          btn.onclick = async function () {
            btn.disabled = true
            try {
              await api('lead.claim', { leadId: btn.getAttribute('data-claim') })
              toast('已领取，用户端将显示客服正在接入，可先在会话里磋商条件')
              await refresh()
            } catch (err) {
              toast(err.message, 'err')
              btn.disabled = false
            }
          }
        })
      }
      return res
    }

    async function refresh() {
      const [counts] = await Promise.all([loadCounts(), loadList()])
      root.querySelectorAll('[data-st]').forEach(function (btn) {
        btn.classList.toggle('on', btn.getAttribute('data-st') === leadState.status)
      })
      root.querySelectorAll('[data-count]').forEach(function (span) {
        const s = span.getAttribute('data-count')
        span.textContent = counts[s] ? String(counts[s]) : ''
      })
    }

    root.querySelectorAll('[data-st]').forEach(function (btn) {
      btn.onclick = function () {
        leadState.status = btn.getAttribute('data-st')
        leadState.page = 1
        refresh()
      }
    })
    const search = function () {
      const q = root.querySelector('#ld-q')
      const mine = root.querySelector('#ld-mine')
      leadState.q = (q && q.value || '').trim()
      leadState.mine = !!(mine && mine.checked)
      leadState.page = 1
      loadList()
    }
    root.querySelector('#ld-search').onclick = search
    root.querySelector('#ld-q').onkeydown = function (e) { if (e.key === 'Enter') search() }
    root.querySelector('#ld-mine').onchange = search
    root.querySelector('#ld-reset').onclick = function () {
      leadState.q = ''
      leadState.mine = false
      leadState.page = 1
      root.querySelector('#ld-q').value = ''
      root.querySelector('#ld-mine').checked = false
      loadList()
    }

    await refresh()
  }

  /* 详情抽屉：领取 / 分配 / 推进状态，全部走后端留痕 */
  async function openLeadDrawer(id, reload) {
    let d = null
    try {
      d = await api('lead.detail', { leadId: id })
    } catch (err) {
      toast(err.message, 'err')
      return
    }
    const next = LEAD_NEXT[d.status] || []
    const isCsConsult = d.targetType === 'agency'
    const claimable = (!d.assignedAccount && ['待分配', '跟进中', '已对接'].indexOf(d.status) >= 0) ||
      (isCsConsult && d.csStatus === '待领取')
    const sat = d.satisfaction || { total: 0, met: 0, unmet: 0, allMet: false, rate: 0 }
    const revealable = ['已对接', '已成交'].indexOf(d.status) >= 0 && C.can('contact.reveal')
    /* 对比项结论：res 是中文枚举（满足 / 一致 / 不同城市），不能按布尔判断 */
    const compareRows = (d.compare || []).map(function (c) {
      const res = String(c.res || '').trim()
      const ok = res === '满足' || res === '一致'
      const bad = res === '不满足' || res === '不一致' || res === '不符合' || res === '不同城市'
      return '<td>' + esc(c.n || '') + '</td><td class="small">' + esc(c.req || '') + '</td>' +
        '<td class="small">' + esc(c.filled || '—') + '</td>' +
        '<td>' + (ok ? badge('满足', 'ok') : bad ? badge(res === '不同城市' ? '不满足（不同城市）' : '不满足', 'danger') : badge(res || '待确认', '')) + '</td>' +
        '<td class="small">' + esc(c.note || '') + '</td>'
    })
    const blockedRows = (d.blocked || []).map(function (b) {
      return '<div class="setting-row"><div class="info"><div class="strong" style="color:var(--danger)">' + esc(b.reason || '触发风控规则') + '</div>' +
        '<div class="small" style="color:var(--muted-2)">' + esc(dateText(b.at)) + ' · 规则 ' + esc(b.ruleId || '—') +
        (b.reviewDeadline ? ' · 复核截止 ' + esc(dateText(b.reviewDeadline)) : '') + '</div></div></div>'
    })
    const timelineRows = (d.timeline || []).map(function (t) {
      return '<div class="setting-row"><div class="info"><div class="strong">' + esc(t.actionName || t.action || '') +
        ' <span class="small" style="color:var(--muted-2)">' + esc(t.resultName || '') + '</span></div>' +
        '<div class="small" style="color:var(--muted-2)">' + esc(t.actor || '') + ' · ' + esc(dateText(t.at)) +
        (t.reason ? ' · ' + esc(t.reason) : '') + '</div></div></div>'
    })

    /* 委托 / 发布方填写的交易条件：代采代售咨询没有对比项时，靠这块人工核对 */
    const side = d.publisherSide || null
    const tagRow = function (label, list) {
      const arr = (list || []).map(function (x) {
        return typeof x === 'object' && x ? (x.k || x.label || x.text || '') : String(x || '')
      }).filter(Boolean)
      return '<div class="setting-row"><div class="info"><div class="small strong">' + esc(label) + '</div>' +
        (arr.length ? '<div class="flex flex-wrap" style="gap:6px;margin-top:6px">' +
          arr.map(function (t) { return badge(t, '') }).join('') + '</div>'
          : '<div class="small" style="color:var(--muted-2);margin-top:4px">未填写</div>') + '</div></div>'
    }
    const sideBlock = side
      ? '<div class="strong" style="margin:18px 0 8px">委托 / 发布条件</div>' +
        kvList([
          ['类型', esc(side.type || '—')],
          ['标的', esc(side.title || '—')],
          ['城市', esc(side.city || '—')]
        ]) +
        tagRow('必要条件', side.must) +
        tagRow('可协商条件', side.nego) +
        tagRow('交易流程', side.flow) +
        (side.note ? '<div class="setting-row"><div class="info"><div class="small strong">补充说明</div>' +
          '<div class="small" style="white-space:pre-wrap;margin-top:4px">' + esc(side.note) + '</div></div></div>' : '')
      : ''

    const revealBtn = function (uid, label) {
      if (!uid) return ''
      if (!C.can('contact.reveal')) {
        return '<button class="btn" disabled>查看' + esc(label) + '手机号（仅管理员）</button>'
      }
      return '<button class="btn' + (revealable ? ' primary' : '') + '" data-reveal-uid="' + esc(uid) +
        '" data-reveal-label="' + esc(label) + '"' + (revealable ? '' : ' disabled') + '>查看' + esc(label) + '手机号</button>'
    }

    /* 谁向谁发起：左侧咨询方 → 右侧委托方，箭头写明发起了代采 / 代售咨询 */
    const sideType = (side && side.type) || '委托'
    const cu = d.consultUser || {}
    const pu = d.publisherUser || {}
    const whoCard = function (u, label, hint) {
      return '<div class="who' + (label === '咨询方' ? ' consult' : '') + '">' +
        '<div class="small" style="color:var(--muted-2)">' + esc(label) + (hint ? ' · ' + esc(hint) : '') + '</div>' +
        '<div class="strong" style="font-size:15px">' + esc(u.nick || '未关联用户') + '</div>' +
        '<div class="small mono" style="color:var(--muted-2)">' + esc(u.userNo || u.id || '—') + '</div>' +
        (u.id ? '<div><button class="btn xs" data-open-user="' + esc(u.id) + '">查看资料</button></div>' : '') +
        '</div>'
    }
    const whoBar = '<div class="lead-who">' +
      whoCard(cu, '咨询方', '发起咨询') +
      '<div class="arrow"><b>→</b><span>发起' + esc(sideType) + '咨询</span></div>' +
      whoCard(pu, '委托方', '发布' + sideType) +
      '</div>'

    /* 双方资料逐项对齐：同一行左咨询方、右委托方，差异一眼可见 */
    const activityOf = function (u) {
      return [
        u.publishCount != null ? '发布 ' + num(u.publishCount) + ' 条' : '',
        u.agencyBuy != null ? '代采 ' + num(u.agencyBuy) + ' 单' : '',
        u.agencySell != null ? '代售 ' + num(u.agencySell) + ' 单' : ''
      ].filter(Boolean).join(' · ') || '—'
    }
    const pairRow = function (label, consultHtml, publisherHtml) {
      return '<td class="small">' + esc(label) + '</td><td>' + consultHtml + '</td><td>' + publisherHtml + '</td>'
    }
    const subjectOf = function (u) {
      return esc(u.subjectHidden ? '未公开主体' : (u.subject || '未填写')) + (u.subjectType ? ' · ' + esc(u.subjectType) : '')
    }
    const infoRows = [
      pairRow('用户ID',
        cu.userNo || cu.id ? '<span class="mono strong">' + esc(cu.userNo || cu.id) + '</span>' : '—',
        pu.userNo || pu.id ? '<span class="mono strong">' + esc(pu.userNo || pu.id) + '</span>' : '—'),
      pairRow('昵称', esc(cu.nick || '—'), esc(pu.nick || '—')),
      pairRow('主体名称', subjectOf(cu), subjectOf(pu)),
      pairRow('城市', esc(cu.city || '—'), esc(pu.city || '—')),
      pairRow('手机号', esc(cu.phoneMasked || (cu.phoneSaved ? '已留存' : '未留存')), esc(pu.phoneMasked || (pu.phoneSaved ? '已留存' : '未留存'))),
      pairRow('会员状态', esc(cu.memberStatus || '未开通'), esc(pu.memberStatus || '未开通')),
      pairRow('账号状态', esc(cu.status || '正常'), esc(pu.status || '正常')),
      pairRow('注册时间', esc(cu.joined || '—'), esc(pu.joined || '—')),
      pairRow('发布 / 委托', esc(activityOf(cu)), esc(activityOf(pu)))
    ]

    const body =
      kvList([
        ['状态', badge(d.status, LEAD_TONE[d.status] || '') + (d.claimedByMe ? ' ' + badge('我领取的', 'info') : '')],
        ['咨询对象', esc(d.targetTitle || '—') + '<div class="small" style="color:var(--muted-2)">' + esc(LEAD_SOURCE_LABEL[d.targetType] || '咨询') + '</div>'],
        ['匹配度', num(d.matchPct) + '%'],
        ['归属坐席', d.assignedAccount ? esc(d.assignedTo || d.assignedAccount) : '未领取'],
        ['档位', esc(d.tierName || d.tier || '默认')],
        ['联系方式', d.contactReleased ? badge('已释放', 'ok') : '未释放'],
        ['用户催办', d.remindCount ? num(d.remindCount) + ' 次' : '无'],
        ['提交时间', esc(dateText(d.createdAt))]
      ]) +
      (isCsConsult
        ? '<div class="strong" style="margin:18px 0 8px">客服服务</div>' +
          '<div class="setting-row"><div class="info">' +
          '<div class="flex flex-wrap" style="align-items:center;gap:8px">' +
            badge(d.csStatus || '待领取', d.csStatus === '已结束' ? '' : (d.csStatus === '服务中' ? 'ok' : 'warn')) +
            (d.ticketStateLabel
              ? badge(d.ticketStateLabel, d.ticketState === 'ticketed' ? 'ok' : (d.ticketState === 'invalid' ? 'danger' : 'warn'))
              : '') +
            (d.csName ? '<span class="small">客服 ' + esc(d.csName) + '</span>' : '') +
            (d.csClaimedAt ? '<span class="small" style="color:var(--muted-2)">' + dateText(d.csClaimedAt) + ' 接入</span>' : '') +
            (d.csEndedAt ? '<span class="small" style="color:var(--muted-2)">' + dateText(d.csEndedAt) + ' 结束</span>' : '') +
          '</div>' +
          '<div class="small" style="margin-top:6px;color:var(--muted-2)">' +
            (d.ticketState === 'intake'
              ? '用户从代采 / 代售商机发起咨询：领取后才接入消息中心，先在会话里磋商委托条件。'
              : d.ticketState === 'consulting'
                ? '正在磋商委托条件，尚未生成工单；条件谈妥后点「生成工单」进入分步流程，条件不成立可标记无效。'
                : d.ticketState === 'invalid'
                  ? '该咨询已标记为无效，不生成工单，也不会出现在工单中心。'
                  : d.csStatus === '待领取'
                    ? '用户正在等待客服联系，领取后用户端会显示「XX 正在接入」并开启对话。'
                    : d.csStatus === '服务中'
                      ? '客服已接入，可在消息中心按咨询会话回复用户；服务完成后点「结束服务」触发用户评价。'
                      : d.ratedAt
                        ? '用户已评价：' + csStars(d.rating) + (d.ratingText ? ' · ' + esc(d.ratingText) : '')
                        : '服务已结束，等待用户评价；评价结果会自动进入客服档案。') +
          '</div></div></div>'
        : '') +
      '<div class="strong" style="margin:18px 0 8px">谁向谁发起</div>' +
      whoBar +
      '<div class="strong" style="margin:18px 0 8px">双方资料对比</div>' +
      table(['对比项', '咨询方', '委托方（发布' + esc(sideType) + '）'], infoRows, '双方资料缺失') +
      '<div class="strong" style="margin:18px 0 8px">双方条件是否满足</div>' +
      '<div class="setting-row"><div class="info"><div class="flex flex-wrap" style="align-items:center;gap:8px">' +
        (sat.total === 0
          ? badge('无对比项', '')
          : sat.allMet ? badge('条件全部满足', 'ok') : badge('有 ' + num(sat.unmet) + ' 项差异', 'warn')) +
        '<span class="small" style="color:var(--muted-2)">' +
          (sat.total
            ? '满足 ' + num(sat.met) + ' / ' + num(sat.total) + ' 项 · 匹配度 ' + num(sat.rate) + '%'
            : '咨询方未填写对比条件，请按下方委托条件人工核对双方是否匹配') +
        '</span>' +
      '</div></div></div>' +
      table(['对比项', '委托方要求', '咨询方填写', '结论', '备注'], compareRows, '该咨询没有对比项') +
      sideBlock +
      '<div class="strong" style="margin:18px 0 8px">联系双方</div>' +
      '<div class="flex flex-wrap" style="gap:8px">' +
        revealBtn(d.consultUser && d.consultUser.id, '咨询方') +
        revealBtn(d.publisherUser && d.publisherUser.id, '发布方') +
      '</div>' +
      '<div class="small" style="margin-top:8px;color:var(--muted-2)">' +
        (C.can('contact.reveal')
          ? (revealable ? '明文手机号仅管理员可见，需填写查看原因并写入审计。' : '咨询单进入「已对接 / 已成交」后才可查看双方手机号。')
          : '当前账号无联系方式释放权限，可先通过站内会话或查看用户资料联系。') +
      '</div>' +
      (blockedRows.length ? '<div class="strong" style="margin:18px 0 8px">风控拦截记录</div>' + blockedRows.join('') : '') +
      '<div class="strong" style="margin:18px 0 8px">操作时间线</div>' +
      (timelineRows.length ? timelineRows.join('') : emptyState('暂无操作记录'))

    /* 所有处置按钮统一放抽屉底部：领取 / 转派 / 推进（含驳回关闭） */
    const actionBtns = []
    const mineOrAssign = d.claimedByMe || C.can('lead.assign')
    /* 待领取咨询：默认「领取并磋商」；确认条件已谈妥时也可直接生成工单 */
    if (claimable && C.can('lead.claim')) {
      if (isCsConsult && d.ticketState === 'intake') {
        actionBtns.push('<button class="btn primary" id="ld-claim">领取并磋商</button>')
        actionBtns.push('<button class="btn" id="ld-claim-ticket">领取并直接生成工单</button>')
      } else {
        actionBtns.push('<button class="btn primary" id="ld-claim">领取到自己名下</button>')
      }
    }
    if (isCsConsult && d.csStatus === '服务中') {
      actionBtns.push('<button class="btn primary" id="ld-chat">进入咨询会话</button>')
    }
    /* 磋商中：条件谈妥才建单；判定为无效咨询直接结束，不产生工单 */
    if (isCsConsult && d.ticketState === 'consulting' && mineOrAssign) {
      if (C.can('consult.openTicket')) actionBtns.push('<button class="btn primary" id="ld-open-ticket">生成工单</button>')
      if (C.can('consult.dismiss')) actionBtns.push('<button class="btn danger" id="ld-dismiss">标记无效咨询</button>')
    }
    if (isCsConsult && d.ticketState === 'ticketed') {
      actionBtns.push('<button class="btn" id="ld-view-ticket">前往工单中心</button>')
    }
    /* 结束服务只在已生成工单后出现：磋商阶段用「生成工单 / 标记无效」两个出口收口 */
    if (isCsConsult && d.csStatus === '服务中' && d.ticketState === 'ticketed' && C.can('lead.endService') && (d.claimedByMe || C.can('lead.assign'))) {
      actionBtns.push('<button class="btn" id="ld-end">结束服务并发起评价</button>')
    }
    /* 未成交前都允许客服把咨询单转给其他客服 / 管理员继续跟进 */
    if (['待分配', '跟进中', '已对接'].indexOf(d.status) >= 0 && C.can('lead.assign')) actionBtns.push('<button class="btn" id="ld-assign">分配 / 转派</button>')
    next.forEach(function (to) {
      /* 代采代售：未生成工单前不提供「已对接 / 已成交」，统一走「生成工单」或「标记无效」 */
      if (isCsConsult && d.ticketState !== 'ticketed') return
      actionBtns.push('<button class="btn' + (to === '已关闭' ? ' danger' : '') + '" data-next="' + esc(to) + '">' +
        (to === '已关闭' ? '驳回 / 关闭' : '推进为「' + esc(to) + '」') + '</button>')
    })
    const foot = '<span class="small" style="color:var(--muted-2)">处置会写入审计；驳回 / 关闭需填原因并通知咨询用户</span>' +
      '<span class="spacer"></span>' + actionBtns.join('') +
      '<button class="btn" id="ld-close">关闭</button>'

    const root = openDrawer({
      title: leadTitle(d.formSummary, 26),
      sub: (LEAD_SOURCE_LABEL[d.targetType] || '咨询') + ' · 匹配 ' + num(d.matchPct) + '%',
      badges: badge(d.status, LEAD_TONE[d.status] || '') + (d.assignedAccount ? ' ' + badge(d.assignedTo || d.assignedAccount, 'info') : ''),
      body: body,
      foot: foot
    })
    if (!root) return
    root.foot.querySelector('#ld-close').onclick = closeDrawer
    const chatBtn = root.foot.querySelector('#ld-chat')
    if (chatBtn) chatBtn.onclick = function () { openCsChat(id, d.targetTitle || '代采代售咨询', d.csName || '') }
    const endBtn = root.foot.querySelector('#ld-end')
    if (endBtn) {
      endBtn.onclick = async function () {
        const ok = await confirm({
          title: '结束服务',
          message: '结束后会话将锁定输入，用户会对本次客服服务打分评价，评价自动进入客服档案。确认结束？',
          okText: '结束并发起评价'
        })
        if (!ok) return
        endBtn.disabled = true
        try {
          await api('lead.endService', { leadId: id })
          toast('服务已结束，已通知用户评价')
          closeDrawer()
          await reload()
        } catch (err) {
          toast(err.message, 'err')
          endBtn.disabled = false
        }
      }
    }
    wirePublisherLinks(root.body)

    /* 双方联系方式：管理员填写原因后释放明文，后端写审计；客服在 RBAC 层已被拒绝 */
    root.body.querySelectorAll('[data-reveal-uid]').forEach(function (btn) {
      btn.onclick = function () {
        const uid = btn.getAttribute('data-reveal-uid')
        const label = btn.getAttribute('data-reveal-label') || '对方'
        const m = modal({
          title: '查看' + label + '手机号',
          sub: '明文手机号仅管理员可见，本次查看会写入审计日志',
          body: field('查看原因（至少 5 个字）', '<input id="ld-reveal-reason" maxlength="100" placeholder="例如：已与用户确认，需电话对接">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ld-reveal-ok">确认查看</button>'
        })
        if (!m) return
        m.querySelector('#ld-reveal-ok').onclick = async function () {
          const reason = m.querySelector('#ld-reveal-reason').value.trim()
          if (reason.length < 5) { toast('请填写至少 5 个字的查看原因', 'err'); return }
          this.disabled = true
          try {
            const r = await api('contact.reveal', { leadId: id, uid: uid, reason: reason })
            closeModal()
            const result = modal({
              title: '联系方式 · ' + (r.side || label),
              sub: '已写入审计日志，请勿外传',
              body: kvList([
                ['用户', esc(label)],
                ['手机号', '<span class="mono strong">' + esc(r.phone || '—') + '</span>'],
                ['查看时间', esc(dateText(r.revealedAt))]
              ]),
              footer: '<button class="btn primary" data-close="1">我已记录</button>'
            })
            if (result) result.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeModal })
          } catch (err) {
            toast(err.message, 'err')
            this.disabled = false
          }
        }
      }
    })

    const done = function (msg) {
      toast(msg)
      closeDrawer()
      if (typeof reload === 'function') reload()
    }

    const doClaim = async function (direct, btn) {
      btn.disabled = true
      try {
        await api('lead.claim', { leadId: id, directTicket: !!direct })
        done(direct ? '已领取并生成工单' : '已领取，可在会话里磋商条件')
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }

    const claimBtn = root.foot.querySelector('#ld-claim')
    if (claimBtn) {
      claimBtn.onclick = function () { doClaim(false, claimBtn) }
    }

    /* 直接建单：说明后果并二次确认，避免把无效沟通拉进工单中心 */
    const claimTicketBtn = root.foot.querySelector('#ld-claim-ticket')
    if (claimTicketBtn) {
      claimTicketBtn.onclick = async function () {
        const ok = await confirm({
          title: '领取并直接生成工单',
          message: '生成后该咨询立即进入工单中心并开启分步流程。请确认已与用户核对委托条件。',
          okText: '领取并生成工单'
        })
        if (!ok) return
        doClaim(true, claimTicketBtn)
      }
    }

    /* 磋商完成：咨询转正式工单，工单中心出现并进入沟通 → 条件 → 合同 → 成交分步流程 */
    const openTicketBtn = root.foot.querySelector('#ld-open-ticket')
    if (openTicketBtn) {
      openTicketBtn.onclick = async function () {
        const ok = await confirm({
          title: '生成工单',
          message: '确认双方委托条件已谈妥？生成后进入工单中心并开启分步流程，会话继续沿用。',
          okText: '生成工单'
        })
        if (!ok) return
        openTicketBtn.disabled = true
        try {
          await api('consult.openTicket', { leadId: id })
          done('工单已生成，已进入工单中心')
        } catch (err) {
          toast(err.message, 'err')
          openTicketBtn.disabled = false
        }
      }
    }

    /* 无效咨询：关闭咨询单并结束会话，不产生工单、不进入工单中心 */
    const dismissBtn = root.foot.querySelector('#ld-dismiss')
    if (dismissBtn) {
      dismissBtn.onclick = function () {
        const m = modal({
          title: '标记无效咨询',
          sub: '不会生成工单；咨询单关闭并结束会话，用户侧会话随之结束',
          body: field('无效原因', '<input id="ld-dismiss-reason" maxlength="100" placeholder="例如：用户仅咨询价格，暂无代采需求">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="ld-dismiss-ok">确认标记</button>'
        })
        if (!m) return
        m.querySelector('#ld-dismiss-ok').onclick = async function () {
          const reason = m.querySelector('#ld-dismiss-reason').value.trim()
          if (!reason) { toast('请填写无效原因', 'err'); return }
          this.disabled = true
          try {
            await api('consult.dismiss', { leadId: id, reason: reason })
            closeModal()
            done('已标记为无效咨询')
          } catch (err) {
            toast(err.message, 'err')
            this.disabled = false
          }
        }
      }
    }

    const viewTicketBtn = root.foot.querySelector('#ld-view-ticket')
    if (viewTicketBtn) {
      viewTicketBtn.onclick = function () {
        closeDrawer()
        C.navigate('consult', { leadId: id })
      }
    }

    const assignBtn = root.foot.querySelector('#ld-assign')
    if (assignBtn) {
      assignBtn.onclick = async function () {
        let staff = []
        try {
          staff = (await api('staff.list')).items || []
        } catch (err) {
          toast(err.message, 'err')
          return
        }
        const opts = staff.map(function (s) {
          return { value: s.username, label: (s.name || s.username) + (s.role === 'cs' ? '（客服）' : s.role === 'admin' ? '（管理员）' : '（财务）') }
        })
        const m = modal({
          title: '分配 / 转派咨询单',
          sub: '转派后原坐席会失去该单的处置入口，操作写入审计日志',
          body: field('目标坐席', '<select id="ld-staff">' + options(opts, d.assignedAccount || '', '未分配') + '</select>') +
            field('转派说明', '<input id="ld-assign-note" maxlength="100" placeholder="选填，会写入审计">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ld-assign-ok">确认</button>'
        })
        if (!m) return
        m.querySelector('#ld-assign-ok').onclick = async function () {
          const assignee = m.querySelector('#ld-staff').value
          if (!assignee) { toast('请选择坐席', 'err'); return }
          this.disabled = true
          try {
            await api('lead.assign', { leadId: id, assignee: assignee, reason: m.querySelector('#ld-assign-note').value.trim() })
            closeModal()
            done('已更新归属坐席')
          } catch (err) {
            toast(err.message, 'err')
            this.disabled = false
          }
        }
      }
    }

    root.foot.querySelectorAll('[data-next]').forEach(function (btn) {
      btn.onclick = async function () {
        const to = btn.getAttribute('data-next')
        /* 关闭与「已拦截 → 待分配」必须填原因：用户会收到这条说明 */
        const needReason = to === '已关闭' || (d.status === '已拦截' && to === '待分配')
        if (!needReason) {
          const ok = await confirm({ title: '确认推进', message: '将咨询单从「' + d.status + '」推进为「' + to + '」，确定继续？', okText: '推进' })
          if (!ok) return
        }
        const submit = async function (reason) {
          try {
            await api('lead.updateStatus', { leadId: id, to: to, reason: reason || '' })
            done('已推进为「' + to + '」')
          } catch (err) {
            toast(err.message, 'err')
          }
        }
        if (!needReason) { await submit(''); return }
        const m = modal({
          title: '推进为「' + to + '」',
          sub: '原因会展示给提交咨询的用户',
          body: field('变更原因', '<input id="ld-reason" maxlength="100" placeholder="例如：已与用户确认无需继续对接">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ld-next-ok">确认</button>'
        })
        if (!m) return
        m.querySelector('#ld-next-ok').onclick = async function () {
          const reason = m.querySelector('#ld-reason').value.trim()
          if (!reason) { toast('请填写变更原因', 'err'); return }
          this.disabled = true
          closeModal()
          await submit(reason)
        }
      }
    })
  }

  /* 注销申请：通过后账号立即停用，驳回需填写原因并通知本人 */
  async function openAccountRequests(reload) {
    let data = null
    try {
      data = await api('accountRequest.list', { status: '待处理' })
    } catch (err) {
      toast(err.message, 'err')
      return
    }
    const items = data.items || []
    const rows = items.map(function (r) {
      return '<div class="setting-row"><div class="info"><div class="strong">' + esc(r.nick) + ' · ' + esc(r.uid) +
        '</div><div class="small" style="color:var(--muted-2)">' + esc(dateText(r.createdAt)) + ' 提交 · 账号当前' + esc(r.userStatus) +
        '</div><div class="small" style="white-space:pre-wrap">' + esc(r.reason || '未填写注销原因') + '</div></div>' +
        '<div class="flex" style="gap:8px">' +
        '<button class="btn xs danger" data-del-approve="' + esc(r.id) + '">通过并停用</button>' +
        '<button class="btn xs" data-del-reject="' + esc(r.id) + '">驳回</button></div></div>'
    })
    const root = openDrawer({
      title: '账号注销申请',
      sub: '核实身份与资产归属后再通过；通过后账号立即停用，用户将无法登录',
      body: items.length ? rows.join('') : emptyState('暂无待处理的注销申请'),
      foot: '<button class="btn" id="ad-close">关闭</button>'
    })
    if (!root) return
    root.foot.querySelector('#ad-close').onclick = closeDrawer

    async function decide(id, decision) {
      let note = ''
      if (decision === '已驳回') {
        const m = modal({
          title: '驳回注销申请',
          sub: '原因会通过站内信发给用户',
          body: field('驳回原因', '<input id="ad-note" maxlength="200" placeholder="例如：存在未完成的交易与退款">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ad-note-ok">确认驳回</button>'
        })
        if (!m) return
        m.querySelector('#ad-note-ok').onclick = async function () {
          const value = m.querySelector('#ad-note').value.trim()
          if (!value) { toast('请填写驳回原因', 'err'); return }
          this.disabled = true
          try {
            await api('accountRequest.handle', { id: id, decision: decision, note: value })
            closeModal()
            toast('已驳回并通知用户')
            closeDrawer()
            openAccountRequests(reload)
            if (typeof reload === 'function') reload()
          } catch (err) {
            toast(err.message, 'err')
            this.disabled = false
          }
        }
        return
      }
      const ok = await confirm({ title: '确认注销账号', message: '通过后该账号会立即停用，用户无法再登录。确定继续？', okText: '通过并停用' })
      if (!ok) return
      try {
        await api('accountRequest.handle', { id: id, decision: decision, note: note })
        toast('已注销并停用账号')
        closeDrawer()
        openAccountRequests(reload)
        if (typeof reload === 'function') reload()
      } catch (err) {
        toast(err.message, 'err')
      }
    }

    root.body.querySelectorAll('[data-del-approve]').forEach(function (btn) {
      btn.onclick = function () { decide(btn.getAttribute('data-del-approve'), '已通过') }
    })
    root.body.querySelectorAll('[data-del-reject]').forEach(function (btn) {
      btn.onclick = function () { decide(btn.getAttribute('data-del-reject'), '已驳回') }
    })
  }

  /* ---------------- 4. 风险提示 ---------------- */

  const RISK_LEVEL_CLASS = { '高': 'high', '中': 'mid', '低': 'low' }

  function riskCaseActions(c) {
    const canHandle = C.can('risk.caseUpdate')
    /* 转单不受处置权限限制：任何人（含管理员）都能把他人领取的单子转走 */
    const canAssign = C.can('risk.assign') && ['待处理', '处理中'].indexOf(c.status) >= 0
    const assignBtn = canAssign ? '<button class="btn xs" data-case-assign="' + esc(c.id) + '">转单</button>' : ''
    const claimedByOther = !!c.ownerAccount && !c.ownedByMe
    if (['已处理', '已忽略'].indexOf(c.status) >= 0) {
      return '<span class="small" style="color:var(--muted-2)">' + esc(c.owner || '已闭环') + '</span>'
    }
    /* 已由他人领取：只能转单，不能做任何处置 */
    if (claimedByOther) {
      return '<span class="small" style="color:var(--muted-2)">已由 ' + esc(c.owner || '其他同事') + ' 领取</span>' + assignBtn
    }
    if (!canHandle) return assignBtn || '<span class="small" style="color:var(--muted-2)">只读</span>'
    /* 未领取：先领取，领取后才会出现处置按钮 */
    if (!c.ownedByMe && c.status === '待处理') {
      return '<button class="btn xs primary" data-case="' + esc(c.id) + '" data-to="处理中">领取</button>' + assignBtn
    }
    return '<button class="btn xs primary" data-case="' + esc(c.id) + '" data-to="已处理">标记已处理</button>' +
      '<button class="btn xs ghost" data-case="' + esc(c.id) + '" data-to="已忽略">忽略</button>' + assignBtn
  }

  /**
   * 风险单转单：把当前待办交给别的客服或管理员。
   * 只换处理人，不改变处置状态；已闭环的单子不会出现转单入口。
   */
  async function openCaseAssign(c) {
    let staff = []
    try {
      const res = await api('staff.list', {})
      staff = res.items || []
    } catch (err) { return toast(err.message || '客服列表加载失败', 'err') }
    const opts = staff.filter(function (s) { return s.name !== c.owner }).map(function (s) {
      return '<option value="' + esc(s.username) + '">' + esc(s.name + ' · ' + (s.roleName || '')) + '</option>'
    }).join('')
    if (!opts) return toast('暂无可转派的客服或管理员', 'err')
    const root = modal({
      title: '转单风险单',
      sub: '当前处理人：' + (c.owner || '未分配') + '；转单后由新处理人继续跟进',
      body: '<div class="form-grid">' +
        field('转给', '<select id="rc-x-staff">' + opts + '</select>') +
        '<div class="field full"><label>转单说明</label><input id="rc-x-reason" maxlength="200" placeholder="选填，会写入操作日志"></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rc-x-ok">确认转单</button>'
    })
    if (!root) return
    root.querySelector('#rc-x-ok').onclick = async function () {
      this.disabled = true
      try {
        await api('risk.assign', {
          id: c.id,
          assignee: root.querySelector('#rc-x-staff').value,
          reason: root.querySelector('#rc-x-reason').value.trim()
        })
        closeModal()
        toast('已转单', 'ok')
        C.renderPage()
      } catch (err) {
        toast(err.message || '转单失败', 'err')
        this.disabled = false
      }
    }
  }

  async function openCaseResolve(c, to) {
    const isClaim = to === '处理中'
    const root = modal({
      title: isClaim ? '领取风险单' : '处置风险单',
      sub: c.ruleLabel || c.detail || '',
      body: (isClaim
        ? '<div class="small" style="color:var(--muted-2)">领取后只有你可以处置这条风险单，其他人只能转单；领取记录会写入操作日志。</div>'
        : field('处置说明', '<input id="rc-reason" placeholder="如：已电话核实，用户提供了采购凭证">')),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rc-ok">确定</button>'
    })
    if (!root) return
    root.querySelector('#rc-ok').onclick = async function () {
      const reason = isClaim ? '领取处理' : root.body.querySelector('#rc-reason').value.trim()
      if (!isClaim && reason.length < 2) return toast('请填写处置说明', 'err')
      this.disabled = true
      try {
        await api('risk.caseUpdate', {
          id: c.id,
          status: to,
          owner: (state.account && state.account.name) || '管理员',
          action: isClaim ? '领取' : to === '已处理' ? '人工核实' : '忽略',
          reason: reason
        })
        closeModal()
        toast(isClaim ? '已领取，只有你可以继续处置' : '风险单已更新')
        C.renderPage()
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  function caseCard(c, picked) {
    /* 未领取的可勾选去领取；本人领取的可勾选去处置；他人领取的不允许勾选 */
    const open = ['待处理', '处理中'].indexOf(c.status) >= 0
    const selectable = C.can('risk.caseUpdate') && open && (!c.ownerAccount || c.ownedByMe)
    const ownerText = !open
      ? ''
      : (c.ownerAccount ? (c.ownedByMe ? '你已领取' : '已由 ' + (c.owner || '其他同事') + ' 领取') : '待领取')
    return '<div class="risk-card ' + (RISK_LEVEL_CLASS[c.level] || 'low') + '">' +
      '<div class="r-head">' +
      (selectable ? '<input type="checkbox" class="r-pick" data-pick="' + esc(c.id) + '"' + (picked ? ' checked' : '') + ' title="勾选后可批量领取 / 处置">' : '') +
      '<div class="r-title">' + esc(c.ruleLabel || c.detail || '风险命中') + '</div><div class="grow"></div>' +
      badge(c.type || '系统', 'info') + badge(c.level || '低', c.level === '高' ? 'danger' : c.level === '中' ? 'warn' : '') + autoBadge(c.status) +
      (ownerText ? ' ' + badge(ownerText, c.ownedByMe ? 'ok' : '') : '') + '</div>' +
      '<div class="r-detail">' + esc(c.detail || '') + '</div>' +
      (c.reason ? '<div class="small" style="color:var(--muted-2);margin-top:4px">' + esc((c.action ? c.action + '：' : '') + c.reason) + '</div>' : '') +
      '<div class="r-foot"><span>' + esc(c.targetLabel || c.targetId || '') + (c.uid ? ' · ' + esc(c.uid) : '') + ' · ' + esc(c.createdText || '') +
      (c.owner && c.status !== '已处理' && c.status !== '已忽略' ? ' · 处理人 ' + esc(c.owner) : '') + '</span>' +
      '<div class="actions">' + riskCaseActions(c) + '</div></div></div>'
  }

  /* 举报对象类型：与 shared/handlers.user.js 的 REPORT_TARGETS 保持一致 */
  const REPORT_TARGET_TEXT = { product: '商品', news: '资讯', demand: '需求', owner: '用户', chat: '会话', other: '其他' }
  const REPORT_TARGET_OPTIONS = Object.keys(REPORT_TARGET_TEXT).map(function (k) {
    return { value: k, label: REPORT_TARGET_TEXT[k] }
  })

  Pages.risk = async function (view, ctx) {
    /* 支持从工作台的「举报反馈」直接落到举报 tab（navigate('risk', { tab: 'reports' })） */
    const askTab = (ctx && ctx.query && ctx.query.tab) || ''
    /* 先取待处理举报数：既用于 tab 角标，也决定无参数进入时默认展示哪个 tab */
    let pendingReports = 0
    if (C.can('report.list')) {
      try {
        const pending = await api('report.list', { status: '待处理', type: '', targetType: '', q: '', page: 1, limit: 1 })
        pendingReports = Number(pending.total) || 0
      } catch (err) {
        pendingReports = 0
      }
    }
    /* 有未处理举报且没指定 tab 时直接落到举报反馈，避免举报进来了却停在风险单看不到 */
    let tab = askTab === 'reports' && C.can('report.list')
      ? 'reports'
      : (!askTab && pendingReports > 0 && C.can('report.list') ? 'reports' : 'cases')
    let stateCase = { type: '', status: '待处理', level: '', keyword: '', page: 1, limit: 12 }
    let stateReport = { group: '', status: '', type: '', targetType: '', q: '', page: 1, limit: 20 }
    let scanning = false
    /* 批量处置：当前页勾选的风险单 id → true */
    let pickedCases = {}

    function pickedOf(items) {
      return items.filter(function (x) { return pickedCases[x.id] })
    }

    /* 批量领取 / 已处理 / 忽略：复用单条处置接口，逐条留痕 */
    function openBatchResolve(items, to) {
      if (!items.length) return toast('当前勾选没有可' + (to === '处理中' ? '领取' : '处置') + '的风险单', 'err')
      const isClaim = to === '处理中'
      const title = isClaim ? '批量领取' : to === '已处理' ? '批量标记已处理' : '批量忽略'
      const root = modal({
        title: title,
        sub: '已选 ' + items.length + ' 条风险单',
        body: isClaim
          ? '<div class="small" style="color:var(--muted-2)">领取后只有你可以处置这批风险单，其他人只能转单；领取记录写入操作日志。</div>'
          : field('处置说明', '<input id="rb-reason" placeholder="如：同一批低风险提醒，已统一核实">'),
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rb-ok">确定</button>'
      })
      if (!root) return
      root.querySelector('#rb-ok').onclick = async function () {
        const reason = isClaim ? '批量领取' : root.body.querySelector('#rb-reason').value.trim()
        if (!isClaim && reason.length < 2) return toast('请填写处置说明', 'err')
        this.disabled = true
        let ok = 0
        let fail = 0
        for (const item of items) {
          try {
            await api('risk.caseUpdate', {
              id: item.id,
              status: to,
              owner: (state.account && state.account.name) || '管理员',
              action: isClaim ? '领取' : to === '已处理' ? '人工核实' : '忽略',
              reason: reason
            })
            ok += 1
          } catch (err) { fail += 1 }
        }
        closeModal()
        pickedCases = {}
        toast(fail ? ('已处理 ' + ok + ' 条，' + fail + ' 条失败') : ('已批量处理 ' + ok + ' 条'), fail ? 'err' : 'ok')
        renderCases()
      }
    }

    /* 批量转单：统一转给同一个人，单条接口逐条写入操作日志 */
    async function openBatchAssign(items) {
      let staff = []
      try {
        const res = await api('staff.list', {})
        staff = res.items || []
      } catch (err) { return toast(err.message || '客服列表加载失败', 'err') }
      const opts = staff.map(function (s) {
        return '<option value="' + esc(s.username) + '">' + esc(s.name + ' · ' + (s.roleName || '')) + '</option>'
      }).join('')
      if (!opts) return toast('暂无可转派的客服或管理员', 'err')
      const root = modal({
        title: '批量转单',
        sub: '已选 ' + items.length + ' 条风险单，转单后由新处理人继续跟进',
        body: '<div class="form-grid">' +
          field('转给', '<select id="rb-staff">' + opts + '</select>') +
          '<div class="field full"><label>转单说明</label><input id="rb-assign-reason" maxlength="200" placeholder="选填，会写入操作日志"></div>' +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rb-assign-ok">确认转单</button>'
      })
      if (!root) return
      root.querySelector('#rb-assign-ok').onclick = async function () {
        this.disabled = true
        const assignee = root.querySelector('#rb-staff').value
        const reason = root.querySelector('#rb-assign-reason').value.trim()
        let ok = 0
        let fail = 0
        for (const item of items) {
          try {
            await api('risk.assign', { id: item.id, assignee: assignee, reason: reason })
            ok += 1
          } catch (err) { fail += 1 }
        }
        closeModal()
        pickedCases = {}
        toast(fail ? ('已转单 ' + ok + ' 条，' + fail + ' 条失败') : ('已批量转单 ' + ok + ' 条'), fail ? 'err' : 'ok')
        renderCases()
      }
    }

    view.innerHTML = pageHead('风险提示', '低风险常见项（信息过少 / 资质未上传 / 超时未分配）由系统自动归档、咨询联系方式自动打码；风险单需先领取，领取后只有领取人可处置，其他人只能转单',
      '<button class="btn" id="r-scan">' + icon('refresh') + '<span>重新扫描</span></button>') +
      '<div class="seg" id="r-tabs">' +
      '<button data-tab="cases" class="' + (tab === 'cases' ? 'on' : '') + '">风险单</button>' +
      '<button data-tab="pool" class="' + (tab === 'pool' ? 'on' : '') + '">内容风险池</button>' +
      '<button data-tab="social" class="' + (tab === 'social' ? 'on' : '') + '">收藏关注</button>' +
      (C.can('behavior.list') ? '<button data-tab="security" class="' + (tab === 'security' ? 'on' : '') + '">安全监测</button>' : '') +
      (C.can('blocked.list') ? '<button data-tab="blocked" class="' + (tab === 'blocked' ? 'on' : '') + '">已拦截</button>' : '') +
      (C.can('report.list') ? '<button data-tab="reports" class="' + (tab === 'reports' ? 'on' : '') + '">举报反馈' +
        (pendingReports > 0 ? '<span class="count">' + num(pendingReports) + '</span>' : '') + '</button>' : '') + '</div>' +
      '<div id="r-body" style="margin-top:16px"></div>'

    const body = view.querySelector('#r-body')

    /* 受理 / 处置后同步「举报反馈」tab 上的待处理角标 */
    function syncReportBadge() {
      const btn = view.querySelector('#r-tabs [data-tab="reports"]')
      if (!btn) return
      const old = btn.querySelector('.count')
      if (pendingReports > 0) {
        if (old) {
          old.textContent = num(pendingReports)
        } else {
          const s = document.createElement('span')
          s.className = 'count'
          s.textContent = num(pendingReports)
          btn.appendChild(s)
        }
      } else if (old) {
        old.remove()
      }
    }

    view.querySelectorAll('#r-tabs [data-tab]').forEach(function (btn) {
      btn.onclick = function () {
        tab = btn.getAttribute('data-tab')
        view.querySelectorAll('#r-tabs [data-tab]').forEach(function (b) { b.classList.toggle('on', b === btn) })
        render()
      }
    })

    view.querySelector('#r-scan').onclick = async function () {
      if (tab !== 'cases') {
        tab = 'cases'
        view.querySelectorAll('#r-tabs [data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === 'cases') })
      }
      scanning = true
      toast('正在按规则重新扫描，常见低风险项会自动归档')
      render()
    }

    function render() {
      if (tab === 'cases') return renderCases()
      if (tab === 'pool') return renderPool()
      if (tab === 'social') return renderSocial()
      if (tab === 'blocked') return renderBlocked()
      if (tab === 'reports') return renderReports()
      return renderSecurity()
    }

    async function renderCases() {
      body.innerHTML = loadingBlock('加载风险单')
      try {
        const data = await api('risk.cases', Object.assign({ refresh: scanning }, stateCase))
        scanning = false
        const counts = data.counts || {}
        const items = data.items || []
        body.innerHTML = (pendingReports > 0
          ? '<div class="card"><div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
            '<span>有 <b>' + num(pendingReports) + '</b> 条用户举报待处理</span>' +
            '<button class="btn xs primary" id="r-goto-reports">查看举报 ›</button></div></div>'
          : '') +
          '<div class="grid g5"' + (pendingReports > 0 ? ' style="margin-top:16px"' : '') + '>' +
          kpi('待处理', num((counts.byStatus || {})['待处理'] || 0), '<span class="small" style="color:var(--muted-2)">需人工确认</span>') +
          kpi('高风险', num((counts.byLevel || {})['高'] || 0), '<span class="small" style="color:var(--muted-2)">优先处置</span>') +
          kpi('处理中', num((counts.byStatus || {})['处理中'] || 0), '<span class="small" style="color:var(--muted-2)">已认领</span>') +
          kpi('系统自动处置', num(counts.auto || 0), '<span class="small" style="color:var(--muted-2)">常见低风险自动闭环</span>') +
          kpi('累计风险单', num(counts.total), '<span class="small" style="color:var(--muted-2)">全部类型</span>') +
          '</div>' +
          '<section class="card" style="margin-top:16px"><div class="card-body">' +
          filterBar([
            field('类型', '<select id="r-type">' + options(data.types || ['商品', '用户', '咨询', '对话', '系统'], stateCase.type) + '</select>'),
            field('等级', '<select id="r-level">' + options(data.levels || ['高', '中', '低'], stateCase.level) + '</select>'),
            field('状态', '<select id="r-status">' + options(data.statusList || ['待处理', '处理中', '已处理', '已忽略'], stateCase.status, false) + '</select>'),
            '<div class="field grow"><label>关键词</label><input id="r-keyword" value="' + esc(stateCase.keyword) + '" placeholder="规则 / 对象 / 用户"></div>',
            '<div class="field"><label>&nbsp;</label><button class="btn primary" id="r-search">' + icon('search') + '<span>筛选</span></button></div>'
          ]) + '</div></section>' +
          (C.can('risk.caseUpdate') && items.length
            ? '<div class="risk-batch" id="r-batch">' +
              '<label class="risk-pick-all"><input type="checkbox" id="r-pick-all"><span>全选本页</span></label>' +
              '<span class="small" style="color:var(--muted-2)">已选 <b id="r-picked">0</b> 条</span>' +
              '<div class="grow"></div>' +
              '<button class="btn xs" id="r-batch-claim" disabled>批量领取</button>' +
              '<button class="btn xs primary" id="r-batch-done" disabled>标记已处理</button>' +
              '<button class="btn xs ghost" id="r-batch-ignore" disabled>批量忽略</button>' +
              (C.can('risk.assign') ? '<button class="btn xs" id="r-batch-assign" disabled>批量转单</button>' : '') +
              '</div>'
            : '') +
          '<div style="margin-top:16px">' +
          (items.length ? items.map(function (c) { return caseCard(c, !!pickedCases[c.id]) }).join('') : emptyState('没有符合条件的风险单', '规则命中后会自动生成风险单')) +
          (Number(data.total) > stateCase.limit ? pager(data.total, stateCase.page, stateCase.limit) : '') +
          '</div>'

        body.querySelector('#r-type').onchange = function () { stateCase.type = this.value }
        body.querySelector('#r-level').onchange = function () { stateCase.level = this.value }
        body.querySelector('#r-status').onchange = function () { stateCase.status = this.value }
        body.querySelector('#r-search').onclick = function () {
          stateCase.keyword = body.querySelector('#r-keyword').value.trim()
          stateCase.page = 1
          renderCases()
        }
        const gotoReports = body.querySelector('#r-goto-reports')
        if (gotoReports) {
          gotoReports.onclick = function () {
            tab = 'reports'
            view.querySelectorAll('#r-tabs [data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === 'reports') })
            render()
          }
        }
        wirePager(body, function (p) { stateCase.page = p; renderCases() })
        body.querySelectorAll('[data-case]').forEach(function (btn) {
          btn.onclick = function () {
            const item = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-case') })[0]
            if (item) openCaseResolve(item, btn.getAttribute('data-to'))
          }
        })
        body.querySelectorAll('[data-case-assign]').forEach(function (btn) {
          btn.onclick = function () {
            const item = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-case-assign') })[0]
            if (item) openCaseAssign(item)
          }
        })

        /* 批量处理：只保留当前页可领取 / 本人可处置的勾选，换筛选 / 翻页后自动收敛 */
        const isClaimable = function (x) { return x.status === '待处理' && !x.ownerAccount }
        const isHandleable = function (x) { return !!x.ownedByMe && ['待处理', '处理中'].indexOf(x.status) >= 0 }
        const selectable = items.filter(function (x) { return isClaimable(x) || isHandleable(x) })
        Object.keys(pickedCases).forEach(function (id) {
          if (!selectable.some(function (x) { return String(x.id) === String(id) })) delete pickedCases[id]
        })
        const pickAll = body.querySelector('#r-pick-all')
        function syncPicked() {
          const chosen = selectable.filter(function (x) { return pickedCases[x.id] })
          const pickedEl = body.querySelector('#r-picked')
          if (pickedEl) pickedEl.textContent = String(chosen.length)
          const limit = {
            'r-batch-claim': chosen.filter(isClaimable).length,
            'r-batch-done': chosen.filter(isHandleable).length,
            'r-batch-ignore': chosen.filter(isHandleable).length,
            'r-batch-assign': chosen.length
          }
          Object.keys(limit).forEach(function (id) {
            const btn = body.querySelector('#' + id)
            if (btn) btn.disabled = limit[id] === 0
          })
          if (pickAll) pickAll.checked = selectable.length > 0 && chosen.length === selectable.length
        }
        body.querySelectorAll('[data-pick]').forEach(function (box) {
          box.onchange = function () {
            const id = box.getAttribute('data-pick')
            if (box.checked) pickedCases[id] = true
            else delete pickedCases[id]
            syncPicked()
          }
        })
        if (pickAll) {
          pickAll.onchange = function () {
            selectable.forEach(function (x) {
              if (pickAll.checked) pickedCases[x.id] = true
              else delete pickedCases[x.id]
            })
            body.querySelectorAll('[data-pick]').forEach(function (box) {
              box.checked = !!pickedCases[box.getAttribute('data-pick')]
            })
            syncPicked()
          }
        }
        function batchClick(id, fn) {
          const btn = body.querySelector('#' + id)
          if (!btn) return
          btn.onclick = function () {
            const chosen = pickedOf(items)
            if (!chosen.length) return toast('请先勾选风险单', 'err')
            fn(chosen)
          }
        }
        batchClick('r-batch-claim', function (chosen) { openBatchResolve(chosen.filter(isClaimable), '处理中') })
        batchClick('r-batch-done', function (chosen) { openBatchResolve(chosen.filter(isHandleable), '已处理') })
        batchClick('r-batch-ignore', function (chosen) { openBatchResolve(chosen.filter(isHandleable), '已忽略') })
        batchClick('r-batch-assign', function (chosen) {
          openBatchAssign(chosen.filter(function (x) { return ['待处理', '处理中'].indexOf(x.status) >= 0 }))
        })
        syncPicked()
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    async function renderPool() {
      body.innerHTML = loadingBlock('加载风险内容')
      let poolStatus = '待看'
      async function load() {
        try {
          const data = await api('risk.list', { status: poolStatus })
          const items = data.items || []
          body.innerHTML = '<div class="seg" id="r-pool">' + ['待看', '已打回', '已排除'].map(function (s) {
            return '<button data-ps="' + s + '"' + (s === poolStatus ? ' class="on"' : '') + '>' + s + '</button>'
          }).join('') + '</div>' +
            '<div style="margin-top:14px">' + (items.length
              ? items.map(function (it) {
                const kind = it.kind === 'demand' ? 'demand' : 'product'
                return '<div class="risk-card ' + (RISK_LEVEL_CLASS[it.riskLevel] || 'low') + '">' +
                  '<div class="r-head"><div class="r-title">' + esc(it.title || it.model || '') + '</div><div class="grow"></div>' +
                  badge(kind === 'demand' ? '需求' : '商品', 'info') + autoBadge(it.riskStatus || poolStatus) + '</div>' +
                  '<div class="r-detail">' + esc((it.riskHits || []).map(function (h) { return (h && h.label) || h }).join(' / ') || it.riskReason || it.note || '命中内容风险规则') + '</div>' +
                  '<div class="r-foot"><span>' + esc(it.city || '') + ' · ' + money(it.price || it.budget) + ' · ' + esc(dateText(it.at)) + '</span>' +
                  '<div class="actions">' +
                  (poolStatus === '待看' && C.can('risk.handle')
                    ? '<button class="btn xs danger" data-pool="' + esc(it.id) + '" data-kind="' + kind + '" data-decision="打回">打回</button>' +
                      '<button class="btn xs" data-pool="' + esc(it.id) + '" data-kind="' + kind + '" data-decision="排除">排除</button>'
                    : '') +
                  '</div></div></div>'
              }).join('')
              : emptyState('当前分类没有内容', '风险内容会按状态归档')) + '</div>'

          body.querySelectorAll('#r-pool [data-ps]').forEach(function (b) {
            b.onclick = function () { poolStatus = b.getAttribute('data-ps'); load() }
          })
          body.querySelectorAll('[data-pool]').forEach(function (btn) {
            btn.onclick = function () {
              const root = modal({
                title: btn.getAttribute('data-decision') === '打回' ? '打回内容' : '排除风险',
                body: field('说明', '<input id="rp-reason" placeholder="打回原因会同步给发布者">'),
                footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rp-ok">确定</button>'
              })
              if (!root) return
              root.querySelector('#rp-ok').onclick = async function () {
                const reason = root.body.querySelector('#rp-reason').value.trim()
                if (reason.length < 2) return toast('请填写说明', 'err')
                this.disabled = true
                try {
                  await api('risk.handle', {
                    kind: btn.getAttribute('data-kind'),
                    id: btn.getAttribute('data-pool'),
                    decision: btn.getAttribute('data-decision'),
                    reason: reason
                  })
                  closeModal()
                  toast('已处置')
                  load()
                } catch (err) {
                  toast(err.message, 'err')
                  this.disabled = false
                }
              }
            }
          })
        } catch (err) {
          body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
        }
      }
      load()
    }

    async function renderSocial() {
      body.innerHTML = loadingBlock('加载收藏与关注')
      try {
        const results = await Promise.all([api('favorite.list', {}), api('follow.list', {})])
        const favs = results[0].items || []
        const follows = results[1].items || []
        body.innerHTML = '<div class="grid g2">' +
          card('收藏监管（' + favs.length + '）', table(['用户', '对象类型', '对象', '时间'],
            favs.map(function (f) {
              return '<td>' + esc(f.nick || f.uid) + '</td><td>' + esc(f.targetType || '') + '</td>' +
                '<td class="mono">' + esc(f.targetId || '') + '</td><td>' + esc(f.atText || dateText(f.at)) + '</td>'
            }), '暂无收藏记录'), '', true) +
          card('关注监管（' + follows.length + '）', table(['用户', '关注对象', '类型', '时间'],
            follows.map(function (f) {
              return '<td>' + esc(f.nick || f.uid) + '</td><td>' + esc(f.targetNick || f.targetKey || '') + '</td>' +
                '<td>' + esc(f.targetType || '') + '</td><td>' + esc(f.atText || dateText(f.at)) + '</td>'
            }), '暂无关注记录'), '', true) +
          '</div>'
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    /* 安全监测：用户截屏 / 录屏 / 复制联系方式、风控拦截、管理端操作与搜索记录统一留痕 */
    let secCategory = 'all'
    async function renderSecurity() {
      body.innerHTML = loadingBlock('加载安全监测')
      try {
        const data = await api('behavior.list', { category: secCategory, days: 7, page: 1, limit: 40 })
        const s = data.summary || {}
        const items = data.items || []
        body.innerHTML = '<div class="seg" id="sec-tabs">' + [
          ['all', '全部 ' + num(s.all)],
          ['capture', '截屏录屏 ' + num(s.capture)],
          ['security', '风控拦截 ' + num(s.security)],
          ['admin', '管理操作 ' + num(s.admin)],
          ['user', '用户行为 ' + num(s.user)],
          ['search', '搜索记录 ' + num(s.search)]
        ].map(function (it) {
          return '<button data-sec="' + it[0] + '"' + (secCategory === it[0] ? ' class="on"' : '') + '>' + esc(it[1]) + '</button>'
        }).join('') + '</div>' +
          '<div style="margin-top:16px">' + card('近 7 天安全与操作留痕（' + num(data.total) + '）',
            table(['时间', '分类', '行为', '对象', '结果'], items.map(function (it) {
              return '<td>' + esc(dateText(it.at)) + '</td><td>' + esc(it.categoryLabel || '') + '</td>' +
                '<td><div class="strong">' + esc(it.title) + '</div>' +
                (it.detail ? '<div class="small" style="color:var(--muted-2)">' + esc(it.detail) + '</div>' : '') + '</td>' +
                '<td>' + esc(it.actorName || '') + '</td>' +
                '<td>' + badge(it.resultLabel || '', it.result === 'warn' ? 'warn' : (it.result === 'allow' ? '' : 'danger'), true) + '</td>'
            }), '近 7 天暂无记录'), '', true) + '</div>' +
          '<div class="small" style="margin-top:10px;color:var(--muted-2)">用户身份已按哈希打码；截屏 / 录屏为小程序端上报，用于事后追溯，不作为处置依据。</div>'

        body.querySelectorAll('#sec-tabs [data-sec]').forEach(function (btn) {
          btn.onclick = function () {
            secCategory = btn.getAttribute('data-sec')
            renderSecurity()
          }
        })
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    /* 举报 / 投诉 / 意见反馈：用户端提交后在此受理并回复，回复会发站内信 */
    async function renderReports() {
      body.innerHTML = loadingBlock('加载举报反馈')
      try {
        const data = await api('report.list', stateReport)
        const items = data.items || []
        const counts = data.counts || {}
        pendingReports = Number(counts['待处理'] || 0)
        syncReportBadge()
        body.innerHTML = '<div class="grid g4">' +
          kpi('待处理', num(counts['待处理'] || 0), '<span class="small" style="color:var(--muted-2)">需要首次响应</span>') +
          kpi('处理中', num(counts['处理中'] || 0), '<span class="small" style="color:var(--muted-2)">已受理待结论</span>') +
          kpi('已处理', num(counts['已处理'] || 0), '<span class="small" style="color:var(--muted-2)">已回复用户</span>') +
          kpi('已驳回', num(counts['已驳回'] || 0), '<span class="small" style="color:var(--muted-2)">不成立 / 信息不足</span>') +
          '</div>' +
          /* 反馈分类：处理中的待办与已完成的结论分开展示，避免翻旧单找待办 */
          '<div class="seg" id="rp-group" style="margin-top:16px">' +
          [['', '全部'], ['open', '处理中'], ['done', '处理完毕']].map(function (g) {
            const n = g[0] === 'open' ? Number((data.groupCounts || {}).open) || 0
              : g[0] === 'done' ? Number((data.groupCounts || {}).done) || 0 : 0
            return '<button data-g="' + g[0] + '"' + (stateReport.group === g[0] ? ' class="on"' : '') + '>' + g[1] +
              (g[0] && n > 0 ? '<span class="count">' + num(n) + '</span>' : '') + '</button>'
          }).join('') + '</div>' +
          '<section class="card" style="margin-top:12px"><div class="card-body">' +
          filterBar([
            field('类型', '<select id="rp-type">' + options((data.types || ['举报', '投诉', '意见反馈']), stateReport.type, '全部类型') + '</select>'),
            field('对象', '<select id="rp-target">' + options(REPORT_TARGET_OPTIONS, stateReport.targetType) + '</select>'),
            field('状态', '<select id="rp-status">' + options((data.statusList || ['待处理', '处理中', '已处理', '已驳回']), stateReport.status, '全部状态') + '</select>'),
            '<div class="field grow"><label>关键词</label><input id="rp-q" value="' + esc(stateReport.q) + '" placeholder="内容 / 对象 / 联系方式"></div>',
            '<div class="field"><label>&nbsp;</label><button class="btn primary" id="rp-search">' + icon('search') + '<span>筛选</span></button></div>'
          ]) + '</div></section>' +
          '<div style="margin-top:16px">' + card('反馈列表（' + num(data.total) + '）',
            table(['时间', '类型', '被举报对象', '商品ID', '发布人', '商品当前状态', '内容摘要', '联系方式', '状态', '操作'], items.map(function (r) {
              const tone = r.status === '已处理' ? 'ok' : r.status === '已驳回' ? 'danger' : r.status === '处理中' ? 'info' : 'warn'
              const tPreview = r.targetPreview || {}
              const curStatus = tPreview.status || ''
              const curTone = /在售|求购中/.test(curStatus) ? 'ok'
                : /已下架|已驳回/.test(curStatus) ? 'danger'
                : /洽谈|对接|待/.test(curStatus) ? 'warn' : ''
              const canOffline = (r.targetType === 'product' || r.targetType === 'demand')
                && curStatus && !/已下架|已驳回|已成交|已关闭/.test(curStatus)
                && C.can(r.targetType === 'product' ? 'product.offline' : 'demand.offline')
              const typeLabel = REPORT_TARGET_TEXT[r.targetType] || r.targetType
              return '<td class="small">' + esc(dateText(r.createdAt)) + '</td>' +
                '<td>' + badge(r.type, r.type === '举报' ? 'danger' : r.type === '投诉' ? 'warn' : 'info') + '</td>' +
                '<td class="small">' + badge(typeLabel, 'info') + ' ' + esc(r.targetTitle || tPreview.title || '—') + '</td>' +
                '<td class="small mono">' + (r.targetId ? '<a href="javascript:" class="link" data-open-id="' + esc(r.targetId) + '" data-open-type="' + esc(r.targetType) + '"' +
                  (r.targetLeadId ? ' data-open-lead="' + esc(r.targetLeadId) + '"' : '') + '>' + esc(r.targetId) + '</a>' : '—') + '</td>' +
                '<td class="small mono">' + (r.targetUid ? esc(r.targetUid) : '—') + '</td>' +
                '<td>' + (curStatus ? badge(curStatus, curTone) : '<span class="small" style="color:var(--muted-2)">—</span>') + '</td>' +
                '<td class="small">' + esc(leadTitle(r.content, 36)) + '</td>' +
                '<td class="small">' + esc(r.contact || '—') + '</td>' +
                '<td>' + badge(r.status, tone) +
                  (r.assignee && r.status !== '已处理' && r.status !== '已驳回'
                    ? '<div class="small" style="color:var(--muted-2)">处理人：' + esc(r.assignee) + '</div>' : '') +
                '</td>' +
                '<td><div class="flex" style="gap:4px;flex-wrap:wrap">' +
                  (canOffline && C.can('report.handle')
                    ? '<button class="btn xs danger" data-act-offline="' + esc(r.id) + '">直接下架</button>' : '') +
                  (C.can('report.assign') && r.status !== '已处理' && r.status !== '已驳回'
                    ? '<button class="btn xs" data-report-assign="' + esc(r.id) + '">转单</button>' : '') +
                  '<button class="btn xs' + (r.status === '待处理' ? ' primary' : '') + '" data-report="' + esc(r.id) + '">' +
                    (r.status === '待处理' ? '受理' : '查看 / 处置') + '</button>' +
                '</div></td>'
            }), '暂无举报或反馈'), '', true) + '</div>' +
          (Number(data.total) > stateReport.limit ? pager(data.total, stateReport.page, stateReport.limit) : '')

        body.querySelector('#rp-type').onchange = function () { stateReport.type = this.value }
        body.querySelector('#rp-target').onchange = function () { stateReport.targetType = this.value }
        body.querySelector('#rp-status').onchange = function () { stateReport.status = this.value }
        body.querySelector('#rp-search').onclick = function () {
          stateReport.q = body.querySelector('#rp-q').value.trim()
          stateReport.page = 1
          renderReports()
        }
        wirePager(body, function (p) { stateReport.page = p; renderReports() })
        body.querySelectorAll('#rp-group [data-g]').forEach(function (btn) {
          btn.onclick = function () {
            stateReport.group = btn.getAttribute('data-g') || ''
            /* 分类与状态下拉会互相抵消（如「处理中 + 已处理」），切分类时重置状态 */
            stateReport.status = ''
            stateReport.page = 1
            renderReports()
          }
        })
        body.querySelectorAll('[data-report-assign]').forEach(function (btn) {
          btn.onclick = function () {
            const item = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-report-assign') })[0]
            if (item) openReportAssign(item)
          }
        })
        body.querySelectorAll('[data-report]').forEach(function (btn) {
          btn.onclick = function () {
            const item = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-report') })[0]
            if (item) openReportHandle(item, renderReports)
          }
        })
        /* 列表内「直接下架」快捷按钮：弹出确认框后调用 report.handle + targetAction=offline */
        body.querySelectorAll('[data-act-offline]').forEach(function (btn) {
          btn.onclick = async function () {
            const rid = btn.getAttribute('data-act-offline')
            const item = items.filter(function (x) { return String(x.id) === rid })[0]
            if (!item) return
            const note = prompt('下架原因会同步给被举报人，请填写（必填）：', item.content ? item.content.slice(0, 60) : '举报核实违规')
            if (!note) return
            try {
              const res = await api('report.handle', { id: item.id, status: '已处理', note: note, targetAction: 'offline' })
              toast('已下架并通知举报双方（处置：' + (res.targetResult && res.targetResult.to ? res.targetResult.to : '已执行') + '）')
              renderReports()
            } catch (err) { toast(err.message, 'err') }
          }
        })
        /* 商品/需求 ID 列：直接在当前页打开详情抽屉，不再跳页（跳页落不到具体记录）；
           会话类举报能反查到咨询工单时，直接进工单中心定位该工单 */
        body.querySelectorAll('[data-open-id]').forEach(function (link) {
          link.onclick = async function () {
            const leadId = link.getAttribute('data-open-lead')
            if (leadId) {
              state.pageQuery = { leadId: leadId }
              C.navigate('consult')
              return
            }
            const type = link.getAttribute('data-open-type')
            const id = link.getAttribute('data-open-id')
            if (type === 'owner') return openUserDrawer(id)
            if (type === 'chat') return toast('未找到该会话对应的咨询工单，可能已删除或不是平台咨询', 'err')
            if (type !== 'product' && type !== 'demand') return toast('该类型暂不支持查看详情')
            try {
              const res = await api(type === 'product' ? 'product.detail' : 'demand.detail', { id: id })
              if (type === 'product' && res.product) openProductDrawer(res.product, renderReports)
              else if (type === 'demand' && res.demand) openDemandDrawer(res.demand, renderReports)
              else toast('详情不存在或已删除', 'err')
            } catch (err) { toast(err.message, 'err') }
          }
        })
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    /** 举报 / 反馈转单：把待办交给别的客服或管理员，已处理完毕的单子不再提供入口 */
    async function openReportAssign(item) {
      let staff = []
      try {
        const res = await api('staff.list', {})
        staff = res.items || []
      } catch (err) { return toast(err.message || '客服列表加载失败', 'err') }
      const opts = staff.filter(function (s) { return s.name !== item.assignee }).map(function (s) {
        return '<option value="' + esc(s.username) + '">' + esc(s.name + ' · ' + (s.roleName || '')) + '</option>'
      }).join('')
      if (!opts) return toast('暂无可转派的客服或管理员', 'err')
      const root = modal({
        title: '转单举报 / 反馈',
        sub: (item.type || '反馈') + '：' + leadTitle(item.content, 40) + '；当前处理人：' + (item.assignee || '未分配'),
        body: '<div class="form-grid">' +
          field('转给', '<select id="rp-x-staff">' + opts + '</select>') +
          '<div class="field full"><label>转单说明</label><input id="rp-x-reason" maxlength="200" placeholder="选填，会写入操作日志"></div>' +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rp-x-ok">确认转单</button>'
      })
      if (!root) return
      root.querySelector('#rp-x-ok').onclick = async function () {
        this.disabled = true
        try {
          await api('report.assign', {
            id: item.id,
            assignee: root.querySelector('#rp-x-staff').value,
            reason: root.querySelector('#rp-x-reason').value.trim()
          })
          closeModal()
          toast('已转单', 'ok')
          renderReports()
        } catch (err) {
          toast(err.message || '转单失败', 'err')
          this.disabled = false
        }
      }
    }

    function openReportHandle(item, done) {
      const canHandle = C.can('report.handle')
      const tPreview = item.targetPreview || {}
      const typeLabel = REPORT_TARGET_TEXT[item.targetType] || item.targetType
      const reporter = item.reporter || null
      const publisher = tPreview.owner || null
      const isGoods = item.targetType === 'product' || item.targetType === 'demand'

      /* 用户摘要：被举报内容的发布人 / 举报人都在弹窗里直接给出，可一键打开用户资料 */
      function briefRow(title, brief, uidHint) {
        const b = brief || {}
        const uid = b.uid || uidHint || ''
        return '<div class="setting-row"><div class="info">' +
          '<div class="flex" style="align-items:center;gap:8px"><div class="strong">' + esc(title) + '</div>' +
          '<div class="grow"></div>' +
          (uid && C.can('user.detail') ? '<button class="btn xs" data-open-user="' + esc(uid) + '">查看用户资料</button>' : '') +
          '</div>' +
          (uid
            ? kvList([
              ['用户ID', b.userNo ? '<span class="mono strong">' + esc(b.userNo) + '</span>' : '<span class="mono">' + esc(uid) + '</span>'],
              ['账号标识', '<span class="mono small">' + esc(uid) + '</span>'],
              ['昵称', esc(b.nick || '—')],
              ['账号状态', esc(b.status || '—')],
              ['手机号', esc(b.phoneMasked || '—')]
            ])
            : '<div class="small" style="color:var(--muted-2)">未关联到用户</div>') +
          '</div></div>'
      }

      /* 被举报内容：受理时直接把原文摊开——投诉什么就展示什么，不再让客服自己跳页去找 */
      let previewSection = ''
      if (isGoods && item.targetId) {
        const amount = item.targetType === 'product'
          ? amountOf(tPreview, 'price', 'priceMax', 'priceMode', 'priceUnit')
          : amountOf(tPreview, 'budget', 'budgetMax', 'budgetMode', 'budgetUnit')
        const tone = /在售|求购中/.test(tPreview.status) ? 'ok'
          : /已下架|已驳回|已关闭|已成交/.test(tPreview.status) ? 'danger' : 'warn'
        previewSection = '<div class="setting-row" style="background:var(--bg);border-radius:10px;padding:12px 14px">' +
          '<div class="info"><div class="flex" style="align-items:center;gap:8px">' +
          '<div class="strong">被举报' + typeLabel + '内容</div>' +
          '<span class="small mono" style="color:var(--muted-2)">' + esc(item.targetId) + '</span>' +
          '<div class="grow"></div>' + (tPreview.status ? badge(tPreview.status, tone) : '') + '</div>' +
          '<div class="rev-split" style="margin-top:12px">' + mediaPanel(item.targetType) +
          '<div class="rev-main">' +
          kvList([
            ['标题', esc(tPreview.title || item.targetTitle || '—')],
            ['品类 / 品牌 / 型号', esc([tPreview.cat, tPreview.brand, tPreview.model].filter(Boolean).join(' / ') || '—')],
            [item.targetType === 'product' ? '价格' : '预算', amount],
            ['数量', tPreview.qty ? num(tPreview.qty) : '—'],
            ['成色 / 状况', esc(tPreview.cond || '—')],
            ['交易地', esc(tPreview.city || '—')],
            ['发布时间', esc(dateText(tPreview.createdAt))]
          ]) +
          (tPreview.note
            ? '<div class="strong" style="margin:14px 0 6px">' + (item.targetType === 'product' ? '商品描述' : '需求说明') + '</div>' +
              '<div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(tPreview.note) + '</div>'
            : '') +
          (tPreview.requirements
            ? '<div class="strong" style="margin:14px 0 6px">补充要求</div>' +
              '<div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(tPreview.requirements) + '</div>'
            : '') +
          (tPreview.accept
            ? '<div class="strong" style="margin:14px 0 6px">可接受条件</div>' +
              '<div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(tPreview.accept) + '</div>'
            : '') +
          (tPreview.offlineReason || tPreview.reviewReason
            ? '<div class="small" style="margin-top:12px;color:var(--muted-2)">' +
              (tPreview.offlineReason ? '下架原因：' + esc(tPreview.offlineReason) : '') +
              (tPreview.reviewReason ? '审核意见：' + esc(tPreview.reviewReason) : '') + '</div>'
            : '') +
          '</div></div></div></div>'
      } else if (item.targetType === 'news' && item.targetId) {
        previewSection = '<div class="setting-row" style="background:var(--bg);border-radius:10px;padding:12px 14px">' +
          '<div class="info"><div class="flex" style="align-items:center;gap:8px">' +
          '<div class="strong">被举报资讯内容</div>' +
          '<span class="small mono" style="color:var(--muted-2)">' + esc(item.targetId) + '</span>' +
          '<div class="grow"></div>' + (tPreview.status ? badge(tPreview.status, 'info') : '') + '</div>' +
          '<div class="strong" style="margin-top:10px">' + esc(tPreview.title || item.targetTitle || '未填写标题') + '</div>' +
          '<div class="small" style="white-space:pre-wrap;line-height:1.8;margin-top:8px;color:var(--ink-2)">' +
          esc(tPreview.content || tPreview.summary || '资讯正文为空或已删除') + '</div>' +
          '</div></div>'
      } else if (item.targetType === 'chat' && item.targetId) {
        const leadId = item.targetLeadId || ''
        previewSection = '<div class="setting-row" style="background:var(--bg);border-radius:10px;padding:12px 14px">' +
          '<div class="info"><div class="flex" style="align-items:center;gap:8px">' +
          '<div class="strong">被举报会话</div>' +
          '<span class="small mono" style="color:var(--muted-2)">' + esc(item.targetId) + '</span>' +
          '<div class="grow"></div>' + (tPreview.status ? badge(tPreview.status, 'info') : '') +
          (leadId ? '<button class="btn xs" data-open-lead="' + esc(leadId) + '">查看咨询工单</button>' : '') +
          '</div>' +
          (leadId
            ? kvList([
              ['关联咨询工单', '<span class="mono small">' + esc(leadId) + '</span>'],
              ['委托主题', esc(tPreview.title || item.targetTitle || '—')],
              ['当前阶段', esc(tPreview.status || '—')],
              ['发起时间', esc(dateText(tPreview.createdAt))],
              ['跟进客服', esc(tPreview.csName || '未分配')]
            ])
            : '<div class="small" style="color:var(--muted-2)">未找到该会话对应的咨询工单：可能是用户之间的直聊，或工单已删除。</div>') +
          '</div></div>'
      } else if (item.targetType === 'owner') {
        previewSection = briefRow('被举报用户', Object.assign({ uid: item.targetUid }, tPreview), item.targetUid)
      }

      /* 谁发的内容、谁举报的：受理时同一屏看全 */
      const peopleSection =
        ((isGoods || item.targetType === 'news') ? briefRow('被举报内容发布人', publisher, item.targetUid) : '') +
        (item.targetType === 'chat' ? briefRow('被举报会话发起人', publisher, item.targetUid) : '') +
        briefRow('举报人', reporter, item.uid) +
        (item.targetUid && C.can('user.admin')
          ? '<div class="flex" style="gap:8px;margin-top:2px">' +
            '<button class="btn xs" id="rp-open-user">调整被举报账号（停用 / 限制发布、资讯、对话）</button></div>'
          : '')

      /* 处置动作按对象类型区分：内容类走「下架 / 退回」，账号类走「限制功能」，不再所有类型统一套「下架商品」 */
      const offlineAction = item.targetType === 'product' ? 'product.offline'
        : item.targetType === 'demand' ? 'demand.offline' : 'news.offline'
      const canContentAction = item.targetType === 'news'
        ? (!!item.targetId && tPreview.status !== '已下架' && C.can('news.offline'))
        : (isGoods && !!item.targetId && !/已下架|已驳回|已成交|已关闭/.test(tPreview.status || '') && C.can(offlineAction))
      const canRestrict = !!item.targetUid && C.can('user.admin')
      const offlineLabel = item.targetType === 'product' ? '下架商品'
        : item.targetType === 'demand' ? '下架需求' : '下架资讯'
      const pendingLabel = item.targetType === 'product' ? '驳回商品（退回，不下架）'
        : item.targetType === 'demand' ? '驳回需求（退回，不下架）' : '驳回资讯（退回，不下架）'
      let actionOptions = '<option value="">不处置被举报对象（只回复举报人）</option>'
      if (canContentAction) {
        actionOptions += '<option value="offline">' + esc(offlineLabel) + '（违规核实）</option>' +
          '<option value="pending">' + esc(pendingLabel) + '</option>'
      }
      if (canRestrict) {
        actionOptions += '<option value="restrict:7">限制账号 7 天（禁发布 / 资讯 / 对话）</option>' +
          '<option value="restrict:30">限制账号 30 天（禁发布 / 资讯 / 对话）</option>'
      }

      /* 通知对象写清楚：这条处理说明到底发给谁，避免把「举报人」当成「被举报人」 */
      const reporterName = (reporter && reporter.nick) || '未留昵称'
      const reporterNo = (reporter && reporter.userNo) || item.uid || '未关联账号'
      const targetName = (publisher && publisher.nick) || tPreview.nick || item.targetTitle || '未命名账号'
      const targetNo = (publisher && publisher.userNo) || tPreview.userNo || item.targetUid || ''
      const notifySection = '<div class="setting-row" style="background:var(--bg);border-radius:10px;padding:12px 14px">' +
        '<div class="info"><div class="strong">处理说明会发给谁</div>' +
        '<div class="small" style="line-height:1.9;color:var(--ink-2)">' +
        '① 举报人：' + esc(reporterName) + ' <span class="mono">' + esc(reporterNo) + '</span><br>' +
        (item.targetUid
          ? '② 被举报人：' + esc(targetName) + ' <span class="mono">' + esc(targetNo) + '</span>'
          : '② 被举报人：该反馈未关联到账号，不发送站内信（仅留处置记录）') +
        '</div></div></div>'
      const root = modal({
        title: item.type + ' · ' + (item.targetTitle || '未指定对象'),
        sub: dateText(item.createdAt) + ' 提交' + (item.contact ? ' · 联系方式 ' + item.contact : ''),
        wide: true,
        body: previewSection + peopleSection + notifySection +
          '<div class="setting-row"><div class="info"><div class="strong">举报内容原文</div>' +
          '<div class="small" style="white-space:pre-wrap;line-height:1.8">' + esc(item.content) + '</div></div></div>' +
          (item.handlerNote ? '<div class="setting-row"><div class="info"><div class="strong">上次回复</div>' +
            '<div class="small" style="color:var(--muted-2);white-space:pre-wrap">' + esc(item.handlerNote) + '</div></div></div>' : '') +
          (canHandle
            ? '<div class="form-grid" style="margin-top:14px">' +
              field('处置结论', '<select id="rp-to">' + options(['处理中', '已处理', '已驳回'], item.status === '待处理' ? '处理中' : item.status, false) + '</select>') +
              field('对被举报对象执行', '<select id="rp-action">' + actionOptions + '</select>') +
              '<div class="field full"><label>处理说明（举报人与被举报人都会收到）</label>' +
              '<textarea id="rp-note" rows="4" placeholder="写清核实结果与处理动作，用户会在站内信看到这段文字">' + esc(item.handlerNote || '') + '</textarea>' +
              '<div class="flex" style="gap:6px;flex-wrap:wrap;margin-top:8px">' +
                [['内容违规', '经核实内容违反平台规则，已按规则处置。'],
                  ['举报不成立', '经核实未发现违规，举报不成立。'],
                  ['需补充信息', '现有信息不足，请补充截图或详细描述后重新提交。'],
                  ['警告教育', '已提醒发布人规范发布，再次出现将限制账号。']].map(function (p) {
                  return '<button type="button" class="btn xs" data-note="' + esc(p[1]) + '">' + esc(p[0]) + '</button>'
                }).join('') +
              '</div>' +
              '<div class="small" style="color:var(--muted-2);margin-top:6px">预览给双方的通知文案：<span id="rp-preview" style="color:var(--ink-2)">选择「已处理」后自动生成</span></div>' +
              '</div>' +
              '</div>'
            : '<div class="small" style="margin-top:12px;color:var(--muted-2)">当前角色无处置权限，只能查看。</div>'),
        footer: canHandle
          ? '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rp-ok">提交处置</button>'
          : '<button class="btn" data-close="1">关闭</button>'
      })
      if (!root) return
      /* 被举报商品 / 需求的材料：弹窗内直接出图，不用再开页面 */
      if (isGoods && item.targetId) loadMediaPanel(root.body, { id: item.targetId, media: tPreview.media }, item.targetType)
      root.body.querySelectorAll('[data-open-user]').forEach(function (btn) {
        btn.onclick = function () { closeModal(); openUserDrawer(btn.getAttribute('data-open-user')) }
      })
      /* 会话类举报：弹窗内直接跳到工单中心，处置时能顺手核对会话与委托 */
      root.body.querySelectorAll('[data-open-lead]').forEach(function (btn) {
        btn.onclick = function () {
          const leadId = btn.getAttribute('data-open-lead')
          if (!leadId) return
          closeModal()
          state.pageQuery = { leadId: leadId }
          C.navigate('consult')
        }
      })
      /* 调整被举报账号：直接打开「调整账号」弹窗（停用 / 限制发布、资讯、对话），不必再走资料抽屉 */
      const openUserBtn = root.querySelector('#rp-open-user')
      if (openUserBtn) {
        openUserBtn.onclick = async function () {
          if (!item.targetUid) return toast('该反馈未关联到账号，无法调整', 'err')
          this.disabled = true
          try {
            const res = await api('user.detail', { uid: item.targetUid })
            const user = Object.assign({}, (res && res.user) || {}, { id: (res && res.user && res.user.id) || item.targetUid })
            closeModal()
            openUserEditModal(user, typeof done === 'function' ? done : null)
          } catch (err) {
            toast(err.message, 'err')
            this.disabled = false
          }
        }
      }
      /* 处置预览：随处置结论 + targetAction + note 实时生成通知文案草稿 */
      const previewEl = root.body.querySelector('#rp-preview')
      const statusSel = root.body.querySelector('#rp-to')
      const actionSel = root.body.querySelector('#rp-action')
      const noteArea = root.body.querySelector('#rp-note')
      const updatePreview = function () {
        if (!previewEl) return
        const st = statusSel ? statusSel.value : '处理中'
        const raw = actionSel ? actionSel.value : ''
        const note = (noteArea ? noteArea.value.trim() : '') || '平台已完成核实'
        const days = raw.indexOf('restrict:') === 0 ? Number(raw.slice(9)) || 0 : 0
        const isRestrict = raw === 'restrict' || days > 0
        const subject = item.targetTitle || tPreview.title || item.targetId || ''
        if (st === '处理中') {
          previewEl.textContent = '举报人：「平台客服已受理你的反馈，正在核实处理...」｜被举报人：暂不通知'
          return
        }
        const lines = ['举报人：「' + note + '」']
        if (isRestrict) {
          lines.push('被举报人：「你的账号因被举报核实违规，已限制发布 / 资讯 / 对话 ' + (days || 7) + ' 天，到期自动恢复」')
        } else if (raw === 'offline') {
          lines.push('被举报人：「你的' + typeLabel + (subject ? '（' + subject + '）' : '') + '已下架，原因：' + note + '」')
        } else if (raw === 'pending') {
          lines.push('被举报人：「你的' + typeLabel + (subject ? '（' + subject + '）' : '') + '已退回，原因：' + note + '」')
        } else if (st === '已驳回') {
          lines.push('被举报人：「你发布的' + typeLabel + '（' + (subject || '内容') + '）被举报，经核实未发现违规，本次不作处置」')
        } else if (item.targetUid) {
          lines.push('被举报人：「你发布的' + typeLabel + (subject ? '（' + subject + '）' : '') + '被举报，核实结论：' + note + '」')
        } else {
          lines.push('被举报人：该反馈未关联到账号，不发送站内信（仅留处置记录）')
        }
        previewEl.textContent = lines.join('｜')
      }
      if (statusSel) statusSel.onchange = updatePreview
      if (actionSel) actionSel.onchange = updatePreview
      if (noteArea) noteArea.oninput = updatePreview
      updatePreview()

      /* 快捷处理用语：点一下填入输入框，仍可继续修改 */
      root.body.querySelectorAll('[data-note]').forEach(function (btn) {
        btn.onclick = function () {
          if (!noteArea) return
          noteArea.value = btn.getAttribute('data-note') || ''
          noteArea.focus()
          updatePreview()
        }
      })

      if (!canHandle) return
      root.querySelector('#rp-ok').onclick = async function () {
        const status = statusSel.value
        const raw = actionSel ? actionSel.value : ''
        const note = noteArea.value.trim()
        const restrictDays = raw.indexOf('restrict:') === 0 ? Number(raw.slice(9)) || 7 : 0
        const action = (restrictDays || raw === 'restrict') ? 'restrict' : raw
        if (status !== '处理中' && !note) return toast('请填写处理说明，用户需要知道处理结果', 'err')
        if (action && status !== '已处理') {
          return toast(action === 'restrict' ? '限制账号时结论必须选「已处理」' : '联动下架 / 退回时结论必须选「已处理」', 'err')
        }
        this.disabled = true
        try {
          const payload = { id: item.id, status: status, note: note, targetAction: action || '' }
          if (action === 'restrict') payload.restrictDays = restrictDays || 7
          const res = await api('report.handle', payload)
          closeModal()
          let tip = status === '处理中' ? '已受理，等待核实结论' : '已处置'
          if (res.targetResult) {
            tip += res.targetResult.skipped
              ? '（对象已是终态，未联动处置）'
              : '（被举报对象：' + res.targetResult.from + ' → ' + res.targetResult.to + '）'
          }
          const notified = res.notified || {}
          if (status !== '处理中') {
            tip += '；举报人' + (notified.reporter ? '已通知' : '未关联账号未通知') +
              '，被举报人' + (notified.target ? '已通知' : '未关联账号未通知')
          }
          toast(tip)
          if (typeof done === 'function') done()
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }

    /* 已拦截：用户提交联系方式 / 证件号命中规则后的留痕，复核窗口内可回溯 */
    async function renderBlocked() {
      body.innerHTML = loadingBlock('加载已拦截记录')
      try {
        const data = await api('blocked.list', { page: 1, limit: 50 })
        const items = data.items || []
        body.innerHTML = '<div class="grid g3">' +
          kpi('累计拦截', num(data.total), '<span class="small" style="color:var(--muted-2)">近 ' + num(data.cleanupDays || 90) + ' 天</span>') +
          kpi('可复核', num(items.filter(function (it) { return it.reviewable }).length), '<span class="small" style="color:var(--muted-2)">在复核窗口内</span>') +
          kpi('复核窗口', num(data.reviewWindowHours || 0) + ' 小时', '<span class="small" style="color:var(--muted-2)">超时仅保留留痕</span>') +
          '</div>' +
          '<div style="margin-top:16px">' + card('拦截明细（' + num(data.total) + '）',
            table(['时间', '命中规则', '档位', '拦截原因', '关联工单', '复核'], items.map(function (it) {
              return '<td>' + esc(dateText(it.at)) + '</td>' +
                '<td><div class="strong">' + esc(it.ruleName || it.ruleId || '—') + '</div></td>' +
                '<td>' + esc(it.tier || '—') + '</td>' +
                '<td class="small">' + esc(it.reason || '') + '</td>' +
                '<td class="small">' + esc(it.leadId || '—') + '</td>' +
                '<td>' + badge(it.reviewable ? '可复核' : '已过期', it.reviewable ? 'warn' : '', true) + '</td>'
            }), '暂无拦截记录'), '', true) + '</div>' +
          '<div class="small" style="margin-top:10px;color:var(--muted-2)">用户端提交手机号 / 证件号等内容会在此留痕，正文已脱敏；' +
          num(data.cleanupDays || 90) + ' 天后自动清理。</div>'
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    render()
  }

  /* ---------------- 5. 媒体 ---------------- */

  function openNewsCreate() {
    const root = modal({
      title: '发布平台资讯',
      wide: true,
      body: '<div class="form-grid">' +
        field('分类', '<select id="n-cat">' + options(['平台公告', '行情解读', '行业资讯'], '平台公告', false) + '</select>') +
        field('城市（可选）', '<input id="n-city" placeholder="如：深圳">') +
        '<div class="field full"><label>标题</label><input id="n-title" placeholder="不超过 60 字"></div>' +
        '<div class="field full"><label>摘要</label><input id="n-summary" placeholder="列表页展示的一句话摘要"></div>' +
        '<div class="field full"><label>发布方式</label><select id="n-mode">' +
          '<option value="now">立即发布</option>' +
          '<option value="later">加入待发布（每天 11:00 / 15:00 / 21:00 自动上线）</option>' +
        '</select></div>' +
        '<div class="field full"><label>正文</label><textarea id="n-content" rows="10" placeholder="支持纯文本段落，1000–1300 字"></textarea>' +
          '<div class="small" id="n-count" style="margin-top:6px;color:var(--muted-2)">0 字（要求 1000–1300 字）</div></div>' +
        '<div class="field full"><label>图片 / 视频（最多 9 图 + 1 视频）</label>' +
          '<input type="file" id="n-media" accept="image/*,video/*" multiple style="display:none">' +
          '<div id="n-media-list" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<button type="button" class="btn sm" id="n-media-add">＋ 选择文件</button>' +
            '<span class="small" id="n-media-hint" style="color:var(--muted-2)">0 张图片 · 0 段视频</span>' +
          '</div></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="n-ok">发布</button>'
    })
    if (!root) return
    const countEl = root.body.querySelector('#n-count')
    const contentEl = root.body.querySelector('#n-content')
    const syncCount = function () {
      const n = contentEl.value.trim().length
      countEl.textContent = n + ' 字（要求 1000–1300 字）'
      countEl.style.color = n >= 1000 && n <= 1300 ? 'var(--ok)' : 'var(--danger)'
    }
    contentEl.addEventListener('input', syncCount)

    /* 图片 / 视频：与小程序同口径，9 图 + 1 视频，直传 /api/upload 后只提交元信息 */
    const media = []
    let mediaBusy = false
    const mediaListEl = root.body.querySelector('#n-media-list')
    const mediaInput = root.body.querySelector('#n-media')
    const mediaHint = root.body.querySelector('#n-media-hint')
    const syncMedia = function () {
      mediaListEl.innerHTML = media.map(function (m, i) {
        const inner = m.kind === 'video'
          ? '<video src="' + esc(m.fileId) + '" muted style="width:100%;height:100%;object-fit:cover"></video>'
          : '<img src="' + esc(m.fileId) + '" style="width:100%;height:100%;object-fit:cover">'
        return '<div style="position:relative;width:88px;height:88px;border-radius:8px;overflow:hidden;background:var(--line-2)">' +
          inner +
          '<button type="button" data-mi="' + i + '" style="position:absolute;top:0;right:0;width:20px;height:20px;line-height:18px;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer">×</button>' +
          '</div>'
      }).join('')
      mediaListEl.querySelectorAll('[data-mi]').forEach(function (btn) {
        btn.onclick = function () {
          media.splice(Number(btn.dataset.mi), 1)
          syncMedia()
        }
      })
      const imgs = media.filter(function (m) { return m.kind === 'image' }).length
      const vids = media.filter(function (m) { return m.kind === 'video' }).length
      mediaHint.textContent = imgs + ' 张图片 · ' + vids + ' 段视频'
    }
    root.body.querySelector('#n-media-add').onclick = function () { mediaInput.click() }
    mediaInput.onchange = async function () {
      const files = Array.prototype.slice.call(mediaInput.files || [])
      mediaInput.value = ''
      mediaBusy = true
      for (const file of files) {
        const kind = chatMediaKindOf(file)
        if (!kind) { toast('仅支持图片与视频：' + (file.name || ''), 'err'); continue }
        const imgs = media.filter(function (m) { return m.kind === 'image' }).length
        const vids = media.filter(function (m) { return m.kind === 'video' }).length
        if (kind === 'image' && imgs >= 9) { toast('最多上传 9 张图片', 'err'); break }
        if (kind === 'video' && vids >= 1) { toast('最多上传 1 段视频', 'err'); continue }
        if (kind === 'image' && file.size > 10 * 1024 * 1024) { toast('单张图片不能超过 10MB', 'err'); continue }
        if (kind === 'video' && file.size > 50 * 1024 * 1024) { toast('视频不能超过 50MB', 'err'); continue }
        mediaHint.textContent = '上传中：' + (file.name || '')
        try {
          const up = await docUpload(file)
          media.push({
            kind: kind,
            name: up.name,
            size: up.size,
            fileId: up.fileId,
            type: file.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg')
          })
        } catch (err) {
          toast(err.message, 'err')
        }
      }
      mediaBusy = false
      syncMedia()
    }
    /* 待发布稿由服务端到点批量上线，这里同步提示当前配置的时间点 */
    api('news.schedule.get').then(function (cfg) {
      const opt = root.body.querySelector('#n-mode option[value="later"]')
      if (opt && cfg && cfg.slots && cfg.slots.length) {
        opt.textContent = '加入待发布（每天 ' + cfg.slots.join(' / ') + ' 自动上线）'
      }
    }).catch(function () {})
    root.querySelector('#n-ok').onclick = async function () {
      const title = root.body.querySelector('#n-title').value.trim()
      const content = contentEl.value.trim()
      const scheduled = root.body.querySelector('#n-mode').value === 'later'
      if (title.length < 4) return toast('标题至少 4 个字', 'err')
      if (mediaBusy) return toast('媒体还在上传，请稍候再发布', 'err')
      if (content.length < 1000 || content.length > 1300) {
        return toast('正文请控制在 1000–1300 字（当前 ' + content.length + ' 字）', 'err')
      }
      this.disabled = true
      try {
        await api('news.create', {
          cat: root.body.querySelector('#n-cat').value,
          city: root.body.querySelector('#n-city').value.trim(),
          title: title,
          summary: root.body.querySelector('#n-summary').value.trim(),
          content: content,
          media: media.map(function (m) {
            return { name: m.name, type: m.type, size: m.size, fileId: m.fileId }
          }),
          scheduled: scheduled
        })
        closeModal()
        toast(scheduled ? '已加入待发布，到点自动上线' : '资讯已发布')
        if (C.state.page === 'media') C.renderPage()
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  /* 自动发布设置：每天哪些时间点把「待发布」资讯批量上线 */
  function openNewsSchedule(done) {
    api('news.schedule.get').then(function (cfg) {
      const root = modal({
        title: '资讯自动发布设置',
        body: '<div class="form-grid">' +
          '<div class="field full"><label>每天发布时间</label>' +
          '<input id="ns-slots" value="' + esc((cfg.slots || []).join(', ')) + '" placeholder="11:00, 15:00, 21:00">' +
          '<div class="small" style="margin-top:6px;color:var(--muted-2)">24 小时制，多个时间用逗号隔开，最多 6 个；到点把「待发布」的资讯批量上线</div></div>' +
          field('开关', '<select id="ns-enabled">' + options(['开启', '关闭'], cfg.enabled === false ? '关闭' : '开启', false) + '</select>') +
          '<div class="field full"><div class="small" style="color:var(--muted-2)">当前待发布 ' + num(cfg.pending) + ' 条' +
            (cfg.updatedText ? ' · 上次修改 ' + esc(cfg.updatedText) : '') + '</div></div>' +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="ns-ok">保存</button>'
      })
      if (!root) return
      root.querySelector('#ns-ok').onclick = async function () {
        const slots = root.body.querySelector('#ns-slots').value.split(/[,，\s]+/).filter(Boolean)
        if (!slots.length) return toast('请至少保留一个发布时间', 'err')
        this.disabled = true
        try {
          const res = await api('news.schedule.save', {
            slots: slots,
            enabled: root.body.querySelector('#ns-enabled').value === '开启'
          })
          closeModal()
          toast(res.slots && res.slots.length ? '已保存：每天 ' + res.slots.join('、') + ' 自动发布' : '已保存')
          if (typeof done === 'function') done()
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }).catch(function (err) { toast(err.message, 'err') })
  }

  /** 会员到期提醒设置：文案模板、提前天数、每日提醒时间、提醒次数与间隔 */
  function openRemindSetting(done) {
    api('biz.remindSetting', {}).then(function (res) {
      const cfg = (res && res.memberRemind) || {}
      const root = modal({
        title: '会员到期提醒设置',
        body: '<div class="form-grid">' +
          field('自动提醒', '<select id="mr-enabled">' + options(['开启', '关闭'], cfg.enabled === false ? '关闭' : '开启', false) + '</select>') +
          field('提前天数', '<input id="mr-days" type="number" min="1" max="30" value="' + Number(cfg.days || 7) + '">') +
          field('每日提醒时间', '<select id="mr-hour">' + Array.from({ length: 24 }, function (_, h) {
            return '<option value="' + h + '"' + (Number(cfg.hour) === h ? ' selected' : '') + '>' + (h < 10 ? '0' + h : h) + ':00</option>'
          }).join('') + '</select>') +
          field('最多提醒次数', '<input id="mr-max" type="number" min="1" max="10" value="' + Number(cfg.maxTimes || 3) + '">') +
          field('提醒间隔（天）', '<input id="mr-interval" type="number" min="0" max="30" value="' + Number(cfg.intervalDays || 0) + '">') +
          '<div class="field full"><label>提醒标题</label><input id="mr-title" maxlength="40" value="' + esc(cfg.title || '') + '"></div>' +
          '<div class="field full"><label>提醒内容</label>' +
          '<textarea id="mr-body" rows="4" maxlength="200">' + esc(cfg.body || '') + '</textarea>' +
          '<div class="small" style="margin-top:6px;color:var(--muted-2)">可用变量：{nick} 昵称、{days} 剩余天数、{expire} 到期日；内容最多 200 字</div></div>' +
          '<div class="field full"><div class="small" style="color:var(--muted-2)">开启后，每天到点由工作台首次加载触发；「提醒会员续费」按钮可随时手动补发，同一到期周期内不超过设定次数</div></div>' +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="mr-ok">保存</button>'
      })
      if (!root) return
      root.querySelector('#mr-ok').onclick = async function () {
        this.disabled = true
        try {
          const res2 = await api('biz.remindSetting', {
            memberRemind: {
              enabled: root.body.querySelector('#mr-enabled').value === '开启',
              days: Number(root.body.querySelector('#mr-days').value),
              hour: Number(root.body.querySelector('#mr-hour').value),
              maxTimes: Number(root.body.querySelector('#mr-max').value),
              intervalDays: Number(root.body.querySelector('#mr-interval').value),
              title: root.body.querySelector('#mr-title').value.trim(),
              body: root.body.querySelector('#mr-body').value.trim()
            }
          })
          closeModal()
          const saved = (res2 && res2.memberRemind) || {}
          toast('已保存：提前 ' + Number(saved.days || 7) + ' 天，' + Number(saved.hour || 0) + ' 点后提醒，最多 ' + Number(saved.maxTimes || 1) + ' 次')
          if (typeof done === 'function') done()
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }).catch(function (err) { toast(err.message, 'err') })
  }

  /**
   * 社交功能总开关：评论 / 私信 / 对话统一控制。
   * 关闭后小程序端评论入口、评论内容、对话与私信入口全部隐藏，
   * 服务端同时拒绝评论发表、发消息与会话读取；已发布内容保留，开启后恢复。
   */
  function openSocialSetting(done) {
    api('setting.get').then(function (res) {
      const cfg = (res && res.settings) || res || {}
      const on = cfg.socialEnabled !== undefined
        ? cfg.socialEnabled === true
        : cfg.chatEnabled === true
      const reviewOn = cfg.reviewHideSocial === true
      const root = modal({
        title: '社交功能开关',
        body: field('评论 / 私信 / 对话', '<select id="sc-enabled">' +
            options(['开启', '关闭'], on ? '开启' : '关闭', false) + '</select>') +
          field('审核期隐藏社交（仅新版）', '<select id="sc-review">' +
            options(['开启', '关闭'], reviewOn ? '开启' : '关闭', false) + '</select>') +
          '<div class="small" style="color:var(--muted-2);line-height:1.8">关闭「评论 / 私信 / 对话」后用户端不再显示任何社交入口：资讯评论、回复、我的评论、私信货主、站内对话、消息页对话 tab 全部隐藏，服务端同时拒绝评论发表、发消息与会话读取。已发布内容保留，重新开启后恢复展示。<br>「审核期隐藏社交」开启后，只对上报了版本号的新版本隐藏社交入口，线上老版本照常展示；提交审核时打开，审核通过并发布后改回「关闭」即可，无需重新上传小程序版本。</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="sc-ok">保存</button>'
      })
      if (!root) return
      root.foot.querySelector('#sc-ok').onclick = async function () {
        this.disabled = true
        try {
          const enabled = root.body.querySelector('#sc-enabled').value === '开启'
          const review = root.body.querySelector('#sc-review').value === '开启'
          await api('setting.save', { socialEnabled: enabled, reviewHideSocial: review })
          closeModal()
          toast(enabled ? '社交功能已开启，用户端恢复评论与对话' : '社交功能已关闭，用户端不再显示评论与对话')
          if (typeof done === 'function') done()
        } catch (err) {
          toast(err.message, 'err')
          this.disabled = false
        }
      }
    }).catch(function (err) { toast(err.message, 'err') })
  }

  Pages.media = async function (view) {
    let tab = 'news'
    const newsStatus = { status: '', cat: '', page: 1, limit: 12 }
    let boardScope = 'all'

    view.innerHTML = pageHead('媒体', '资讯发布即展示、可随时下架；排行榜、价格水平与首页横幅运营',
      (C.can('news.schedule.get') ? '<button class="btn" id="m-schedule">自动发布设置</button>' : '') +
      (C.can('news.create') ? '<button class="btn primary" id="m-new">' + icon('plus') + '<span>发布资讯</span></button>' : '')) +
      '<div class="media-bar"><div class="seg" id="m-tabs"><button data-tab="news" class="on">资讯</button>' +
      '<button data-tab="rank">排行榜</button><button data-tab="price">价格水平</button>' +
      '<button data-tab="banner">首页横幅</button></div><div class="grow"></div>' +
      (C.can('biz.remindExpiring') ? '<button class="btn" id="m-remind">' + icon('clock') + '<span>提醒会员续费</span></button>' : '') +
      (C.can('biz.remindSetting') ? '<button class="btn" id="m-remind-set">' + icon('settings') + '<span>提醒设置</span></button>' : '') +
      (C.can('setting.save') ? '<button class="btn" id="m-social">' + icon('settings') + '<span>社交功能开关</span></button>' : '') +
      '</div>' +
      '<div id="m-body" style="margin-top:16px"></div>'

    const body = view.querySelector('#m-body')
    const newsNewBtn = view.querySelector('#m-new')
    if (newsNewBtn) newsNewBtn.onclick = openNewsCreate
    /* 会员续费提醒：按媒体页「提醒设置」的文案与提前天数给会员补发站内信 */
    const remindBtn = view.querySelector('#m-remind')
    if (remindBtn) {
      remindBtn.onclick = async function () {
        remindBtn.disabled = true
        try {
          const r = await api('biz.remindExpiring', { force: true })
          toast(Number(r.reminded) > 0 ? '已提醒 ' + num(r.reminded) + ' 位会员续费' : '当前没有需要提醒的会员（或已达到提醒次数上限）')
        } catch (err) {
          toast(err.message, 'err')
        } finally {
          remindBtn.disabled = false
        }
      }
    }
    const remindSetBtn = view.querySelector('#m-remind-set')
    if (remindSetBtn) remindSetBtn.onclick = function () { openRemindSetting() }
    /* 社交功能开关：评论 / 私信 / 对话统一控制，审核期间关闭 */
    const socialBtn = view.querySelector('#m-social')
    if (socialBtn) socialBtn.onclick = function () { openSocialSetting() }
    const scheduleBtn = view.querySelector('#m-schedule')
    if (scheduleBtn) {
      scheduleBtn.onclick = function () {
        tab = 'news'
        openNewsSchedule(function () { renderNews() })
      }
    }

    view.querySelectorAll('#m-tabs [data-tab]').forEach(function (btn) {
      btn.onclick = function () {
        tab = btn.getAttribute('data-tab')
        view.querySelectorAll('#m-tabs [data-tab]').forEach(function (b) { b.classList.toggle('on', b === btn) })
        if (tab === 'news') renderNews()
        else if (tab === 'rank') renderRank()
        else if (tab === 'banner') {
          renderBanner(body, function () { renderBanner(body) }).catch(function (err) {
            body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
          })
        } else renderPriceLevels()
      }
    })

    /** 资讯媒体摘要：列表只显示数量，点「查看」看大图 / 视频 */
    function mediaSummary(media) {
      const list = Array.isArray(media) ? media : []
      if (!list.length) return ''
      const imgs = list.filter(function (m) { return m.kind !== 'video' }).length
      const vids = list.filter(function (m) { return m.kind === 'video' }).length
      return '<div class="small" style="color:var(--brand);margin-top:3px">' +
        [imgs ? '图片 ' + imgs : '', vids ? '视频 ' + vids : ''].filter(Boolean).join(' · ') + '</div>'
    }

    async function renderNews() {
      body.innerHTML = loadingBlock('加载资讯')
      try {
        const data = await api('news.list', Object.assign({ page: newsStatus.page, limit: newsStatus.limit }, newsStatus))
        const items = data.items || []
        const counts = data.counts || {}
        body.innerHTML = '<div class="grid g4">' +
          kpi('已发布', num(counts['已发布']), '<span class="small" style="color:var(--muted-2)">线上可见</span>') +
          kpi('待发布', num(counts['待发布']), '<span class="small" style="color:var(--muted-2)">到点自动上线</span>') +
          kpi('已下架', num(counts['已下架']), '<span class="small" style="color:var(--muted-2)">停止展示</span>') +
          kpi('全部资讯', num(data.total), '<span class="small" style="color:var(--muted-2)">平台与用户发布均不审核</span>') +
          '</div>' +
          '<section class="card" style="margin-top:16px"><div class="card-body">' + filterBar([
            field('状态', '<select id="m-status">' + options(['已发布', '待发布', '已下架'], newsStatus.status) + '</select>'),
            field('分类', '<select id="m-cat">' + options(['平台公告', '行情解读', '行业资讯', '用户发布'], newsStatus.cat) + '</select>')
          ]) + '</div></section>' +
          '<section class="card" style="margin-top:16px"><div class="card-body flush">' +
          table(['标题', '分类', '作者', '状态', '浏览', '时间', '操作'], items.map(function (n) {
            return '<td><div class="strong">' + esc(n.title) + (isPrivateItem(n) ? ' ' + privateTag() : '') + '</div><div class="small" style="color:var(--muted-2)">' + esc(n.summary || '') + '</div>' +
              mediaSummary(n.media) + '</td>' +
              '<td>' + esc(n.cat || '') + '</td><td>' + esc(n.author || (n.official ? '官方' : '')) + '</td>' +
              '<td>' + autoBadge(n.status) + '</td><td>' + num(n.views) + '</td>' +
              '<td>' + esc(n.published || n.createdText || dateText(n.publishedAt)) + '</td>' +
              '<td><div class="flex" style="gap:5px">' +
              (n.status === '待发布' && C.can('news.publish') ? '<button class="btn xs primary" data-publish="' + esc(n.id) + '">立即发布</button>' : '') +
              (n.status === '已发布' && C.can('news.offline') ? '<button class="btn xs" data-offline="' + esc(n.id) + '">下架</button>' : '') +
              '<button class="btn xs ghost" data-view="' + esc(n.id) + '">查看</button></div></td>'
          }), '暂无资讯') + (Number(data.total) > newsStatus.limit ? pager(data.total, newsStatus.page, newsStatus.limit) : '') +
          '</div></section>'

        body.querySelector('#m-status').onchange = function () { newsStatus.status = this.value; newsStatus.page = 1; renderNews() }
        body.querySelector('#m-cat').onchange = function () { newsStatus.cat = this.value; newsStatus.page = 1; renderNews() }
        wirePager(body, function (p) { newsStatus.page = p; renderNews() })

        body.querySelectorAll('[data-publish]').forEach(function (btn) {
          btn.onclick = function () {
            const root = modal({
              title: '立即发布',
              body: '<div class="small">该资讯将马上上线，不用等到下一个自动发布时间点。</div>',
              footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="n-pub-ok">立即发布</button>'
            })
            if (!root) return
            root.body.querySelector('#n-pub-ok').onclick = async function () {
              this.disabled = true
              try {
                await api('news.publish', { id: btn.getAttribute('data-publish') })
                closeModal()
                toast('资讯已发布')
                renderNews()
              } catch (err) {
                toast(err.message, 'err')
                this.disabled = false
              }
            }
          }
        })

        body.querySelectorAll('[data-offline]').forEach(function (btn) {
          btn.onclick = function () {
            const root = modal({
              title: '下架资讯',
              body: field('下架原因', '<input id="n-off" placeholder="会记录到审计日志">'),
              footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="n-off-ok">确认下架</button>'
            })
            if (!root) return
            root.body.querySelector('#n-off-ok').onclick = async function () {
              const reason = root.body.querySelector('#n-off').value.trim()
              if (reason.length < 2) return toast('请填写下架原因', 'err')
              this.disabled = true
              try {
                await api('news.offline', { id: btn.getAttribute('data-offline'), reason: reason })
                closeModal()
                toast('资讯已下架')
                renderNews()
              } catch (err) {
                toast(err.message, 'err')
                this.disabled = false
              }
            }
          }
        })

        body.querySelectorAll('[data-view]').forEach(function (btn) {
          btn.onclick = function () {
            const n = items.filter(function (x) { return String(x.id) === btn.getAttribute('data-view') })[0]
            if (!n) return
            const media = Array.isArray(n.media) ? n.media : []
            const mediaHtml = media.length
              ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">' + media.map(function (m) {
                return m.kind === 'video'
                  ? '<video src="' + esc(m.fileId) + '" controls style="width:160px;height:160px;object-fit:cover;border-radius:8px;background:#000"></video>'
                  : '<a href="' + esc(m.fileId) + '" target="_blank"><img src="' + esc(m.fileId) + '" style="width:160px;height:160px;object-fit:cover;border-radius:8px"></a>'
              }).join('') + '</div>'
              : ''
            modal({
              title: n.title,
              titleTag: isPrivateItem(n) ? privateTag('私密发布') : '',
              sub: n.cat + (n.city ? ' · ' + n.city : '') + ' · ' + (n.author || '官方'),
              body: '<div class="small" style="line-height:1.9;white-space:pre-wrap">' + esc(n.content || n.summary || '无正文') + '</div>' + mediaHtml,
              footer: '<button class="btn" data-close="1">关闭</button>'
            })
          }
        })
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    async function renderRank() {
      body.innerHTML = loadingBlock('加载榜单')
      try {
        const [data, search] = await Promise.all([
          api('insights.boards', { scope: boardScope, limit: 10 }),
          api('insights.searches', { scope: boardScope }).catch(function () { return { items: [] } })
        ])
        const boards = data.boards || []
        const words = search.items || []
        body.innerHTML = '<div class="seg" id="m-scope">' + [
          ['all', '全品类'], ['GPU', 'GPU 加速卡'], ['NPU', 'NPU 加速卡'],
          ['CPU', 'CPU'], ['内存', '内存条'], ['存储', '存储'], ['网络', '网络设备'], ['其他', '其他']
        ].map(function (s) {
          return '<button data-scope="' + esc(s[0]) + '"' + (s[0] === boardScope ? ' class="on"' : '') + '>' + esc(s[1]) + '</button>'
        }).join('') + '</div>' +
          (boards.length ? '<div class="grid g2" style="margin-top:16px">' + boards.map(function (b) {
            return card('热度榜 · ' + (b.scope || '全品类'), (b.items || []).map(function (it, i) {
              return '<div class="rank-item"><span class="rank-no ' + (i < 3 ? 'top' + (i + 1) : '') + '">' + (i + 1) + '</span>' +
                '<div class="grow"><div class="t">' + esc(it.model || it.title || '') + '</div>' +
                '<div class="s">' + esc(it.city || '') + ' · ' + money(it.price) + ' · 咨询 ' + num(it.consults) + '</div></div>' +
                '<span class="v">' + num(it.views) + '</span></div>'
            }).join('') || emptyState('暂无榜单数据'))
          }).join('') + '</div>'
            : '<div style="margin-top:16px">' + card('热度榜', emptyState('当前维度暂无榜单数据', '货盘商品 / 求购需求上架并产生浏览后会自动进入榜单')) + '</div>') +
          '<div style="margin-top:16px">' + card('今日搜索热词', words.length ? words.map(function (w, i) {
            return '<div class="list-row"><div class="grow"><div class="strong">' + (i + 1) + '. ' + esc(w.word) + '</div></div>' +
              '<span class="small" style="color:var(--muted-2)">' + num(w.count) + ' 次</span></div>'
          }).join('') : emptyState('今日暂无搜索记录', '用户在小程序搜索后会实时进入这里')) + '</div>'

        body.querySelectorAll('#m-scope [data-scope]').forEach(function (btn) {
          btn.onclick = function () {
            boardScope = btn.getAttribute('data-scope')
            renderRank()
          }
        })
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    /** 价格水平：平台货盘为基准 + 代采代售高权重 + 报价补充，输出最终参考价 */
    async function renderPriceLevels() {
      body.innerHTML = loadingBlock('计算价格水平')
      try {
        const data = await api('price.levels', { limit: 100 })
        const items = data.items || []
        const totals = data.totals || {}
        body.innerHTML = '<div class="grid g4">' +
          kpi('价格样本组', num(totals.groups), '<span class="small" style="color:var(--muted-2)">按品类 / 型号 / 城市聚合</span>') +
          kpi('平台货盘', num(totals.products), '<span class="small" style="color:var(--muted-2)">在售商品基准价</span>') +
          kpi('代采代售', num(totals.agencies), '<span class="small" style="color:var(--muted-2)">真实意向，权重更高</span>') +
          kpi('已出价格水平', num(totals.withLevel), '<span class="small" style="color:var(--muted-2)">' + esc(data.generatedText || '') + '</span>') +
          '</div>' +
          '<section class="card" style="margin-top:16px"><div class="card-body flush">' +
          table(['品类 / 型号', '城市', '货盘基准', '代采代售', '最终价格水平', '参考区间', '置信度', '样本', '更新'], items.map(function (it) {
            const tone = (it.confidence || 0) >= 78 ? 'ok' : (it.confidence || 0) >= 55 ? 'warn' : 'danger'
            return '<td><div class="strong">' + esc(it.model || it.cat) + '</div>' +
                '<div class="small" style="color:var(--muted-2)">' + esc(it.cat) + '</div></td>' +
              '<td>' + esc(it.city || '不限') + '</td>' +
              '<td>' + esc(it.anchorText || '—') + '</td>' +
              '<td>' + esc(it.agencyText || '—') + '</td>' +
              '<td><span class="strong">' + esc(it.priceLevelText || '—') + '</span></td>' +
              '<td class="small">' + esc(it.priceRangeText || '—') + '</td>' +
              '<td>' + (it.priceLevel ? badge(it.confidenceText + ' ' + it.confidence + '%', tone) : '—') + '</td>' +
              '<td>' + num(it.sampleCount) + '<div class="small" style="color:var(--muted-2)">' + esc(it.sourceText || '') + '</div></td>' +
              '<td class="small">' + esc(it.updated || '') + '</td>'
          }), '暂无价格样本') +
          '</div></section>' +
          '<div class="small" style="margin-top:10px;color:var(--muted-2)">口径：平台在售商品（货盘）作为基准占 45%，代采 / 代售真实意向占 40%，用户粘贴报价补充 15%；再按委托数量与时效做小幅修正，输出最终价格水平与参考区间。</div>'
      } catch (err) {
        body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
      }
    }

    renderNews()
  }

  Pages.media.openCreate = openNewsCreate

  /* ============================================================
     6. 设置：系统信息 / 商机会员价格 / 平台规则 / 型号库 / 排序规则
     ============================================================ */

  const SETTING_TABS = [
    ['basic', '系统设置'],
    ['member', '商机会员'],
    ['rules', '平台规则'],
    ['catalog', '型号库'],
    ['sort', '排序规则']
  ]
  let settingTab = 'basic'
  let catalogFilter = { q: '', status: '' }
  let catalogTotal = 0

  Pages.settings = async function (view) {
    view.innerHTML = pageHead('设置', '平台基础规则、型号库、排序规则、企微二维码与商机会员价格') +
      '<div class="seg" id="set-tabs">' + SETTING_TABS.map(function (t) {
        return '<button data-tab="' + t[0] + '" class="' + (settingTab === t[0] ? 'on' : '') + '">' + t[1] +
          (t[0] === 'catalog' ? '<span class="count" id="set-catalog-count">' + (catalogTotal ? num(catalogTotal) : '') + '</span>' : '') +
          '</button>'
      }).join('') + '</div><div id="set-body" style="margin-top:14px">' + loadingBlock('读取配置') + '</div>'
    view.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.onclick = function () { settingTab = btn.getAttribute('data-tab'); Pages.settings(view) }
    })
    const body = view.querySelector('#set-body')
    try {
      if (settingTab === 'basic') await renderBasic(body)
      else if (settingTab === 'member') await renderMember(body)
      else if (settingTab === 'rules') await renderRules(body)
      else if (settingTab === 'catalog') await renderCatalog(body)
      else await renderSort(body)
    } catch (err) {
      body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
    }
  }

  function stackWrap(left, right) {
    return '<div class="grid g-side" style="align-items:start">' +
      '<div style="display:grid;gap:14px">' + left + '</div>' +
      '<div style="display:grid;gap:14px">' + right + '</div></div>'
  }

  async function renderBasic(root) {
    const s = await loadSettings(true)
    let qr = s.qrUrl || ''
    root.innerHTML = stackWrap(
      card('平台信息', '<div class="form-grid">' +
        field('平台名称', '<input id="b-site" value="' + esc(s.siteName || '') + '">') +
        field('客服电话', '<input id="b-phone" value="' + esc(s.servicePhone || '') + '" placeholder="如 400-000-0000">') +
        field('服务时间', '<input id="b-time" value="' + esc(s.serviceTime || '') + '">') +
        field('客服企微号', '<input id="b-wecom" value="' + esc(s.wecomId || '') + '">') +
        '<div class="field full"><label>接口地址</label><input id="b-api" value="' + esc(s.apiBase || '') + '" placeholder="小程序调用的云函数 / 接口域名"></div>' +
        '</div>') +
      card('商机说明', '<div class="field"><label>套餐说明</label><textarea id="b-note" rows="3">' + esc(s.planNote || '') + '</textarea></div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:8px">展示在用户端会员购买页与收款说明位置。</div>') +
      card('平台联系二维码',
        '<div id="b-qr" style="display:flex;align-items:center;justify-content:center;min-height:190px;border:1px dashed var(--line);border-radius:12px;background:#fbfbfd">' +
        (qr ? '<img src="' + esc(qr) + '" alt="企业微信活码" style="max-width:180px;max-height:180px;border-radius:8px">' : '<span class="small" style="color:var(--muted-2)">未上传二维码</span>') +
        '</div><div class="form-grid" style="margin-top:12px">' +
        field('扫码说明', '<input id="b-qr-note" value="' + esc(s.qrNote || '') + '">') + '</div>' +
        '<div class="flex" style="gap:8px;margin-top:12px">' +
        '<input type="file" id="b-qr-file" accept="image/png,image/jpeg,image/webp" hidden>' +
        '<button class="btn" id="b-qr-up">' + icon('file') + '<span>上传图片</span></button>' +
        '<button class="btn ghost" id="b-qr-clear">移除</button></div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:8px">PNG / JPG / WEBP，建议 300KB 以内，图片直存 base64。</div>') +
      card('微信消息提醒模板',
        '<div class="form-grid">' +
        field('咨询通知模板 ID', '<input id="b-tmpl-inquiry" value="' + esc(s.tmplInquiry || '') + '" placeholder="在微信公众平台选用订阅消息模板">') +
        field('会话通知模板 ID', '<input id="b-tmpl-chat" value="' + esc(s.tmplChat || '') + '" placeholder="有用户发来会话消息时推送">') +
        field('系统消息模板 ID', '<input id="b-tmpl-system" value="' + esc(s.tmplSystem || '') + '" placeholder="审核结果、平台通知等站内信推送">') +
        field('商机消息模板 ID', '<input id="b-tmpl-biz" value="' + esc(s.tmplBiz || '') + '" placeholder="有新匹配商机、会员到期时推送">') +
        '</div><div class="small" style="color:var(--muted-2);margin-top:8px;line-height:1.8">模板字段约定为 thing1（发送人 / 标题） / thing2（内容摘要） / time3（时间）。留空时用户端不展示对应提醒授权，也不推送。</div>')
    ) + '<div class="flex" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" id="b-save">保存设置</button></div>'

    const file = root.querySelector('#b-qr-file')
    root.querySelector('#b-qr-up').onclick = function () { file.click() }
    file.onchange = function () {
      const f = file.files && file.files[0]
      if (!f) return
      if (f.size > 400 * 1024) return toast('图片请控制在 400KB 以内', 'err')
      const reader = new FileReader()
      reader.onload = function () {
        qr = String(reader.result || '')
        root.querySelector('#b-qr').innerHTML = '<img src="' + esc(qr) + '" alt="企业微信活码" style="max-width:180px;max-height:180px;border-radius:8px">'
      }
      reader.readAsDataURL(f)
    }
    root.querySelector('#b-qr-clear').onclick = function () {
      qr = ''
      root.querySelector('#b-qr').innerHTML = '<span class="small" style="color:var(--muted-2)">未上传二维码</span>'
    }
    root.querySelector('#b-save').onclick = async function () {
      const btn = this
      btn.disabled = true
      try {
        await api('setting.save', {
          siteName: root.querySelector('#b-site').value.trim(),
          servicePhone: root.querySelector('#b-phone').value.trim(),
          serviceTime: root.querySelector('#b-time').value.trim(),
          wecomId: root.querySelector('#b-wecom').value.trim(),
          apiBase: root.querySelector('#b-api').value.trim(),
          planNote: root.querySelector('#b-note').value.trim(),
          qrNote: root.querySelector('#b-qr-note').value.trim(),
          qrUrl: qr,
          tmplInquiry: root.querySelector('#b-tmpl-inquiry').value.trim(),
          tmplChat: root.querySelector('#b-tmpl-chat').value.trim(),
          tmplSystem: root.querySelector('#b-tmpl-system').value.trim(),
          tmplBiz: root.querySelector('#b-tmpl-biz').value.trim(),
          planPrice: s.planPrice || '99 元 / 月',
          planDays: Number(s.planDays) || 30,
          plans: planList(s)
        })
        settingsCache = null
        toast('设置已保存')
        Pages.settings(document.getElementById('view'))
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  /**
   * 首页跑马灯横幅：多条标题拼接后横向逐字滚动，点击弹窗展示每条正文。
   * 速度按「像素 / 秒」配置，小程序端据此换算动画时长；未配置时不展示。
   */
  async function renderBanner(root, onSaved) {
    const s = await loadSettings(true)
    let on = s.bannerEnabled !== false
    let speed = Number(s.bannerSpeed) || 40
    let items = (s.bannerItems || []).map(function (x) {
      return { id: x.id || '', title: x.title || '', content: x.content || '' }
    })
    if (!items.length) items = [{ id: '', title: '', content: '' }]

    function rowHtml(x, i) {
      return '<div class="setting-row" data-i="' + i + '" style="align-items:flex-start">' +
        '<div class="ctrl" style="flex:1;display:grid;gap:8px">' +
        '<label class="small">第 ' + (i + 1) + ' 条标题<input data-f="title" value="' + esc(x.title) +
        '" maxlength="60" placeholder="滚动条上显示的一句话" style="margin-left:6px;width:100%"></label>' +
        '<label class="small">弹窗正文<textarea data-f="content" rows="3" maxlength="2000" placeholder="点击横幅后展示的完整内容" style="margin-top:6px">' +
        esc(x.content) + '</textarea></label>' +
        '</div>' +
        '<button class="btn ghost" data-del="' + i + '">删除</button>' +
        '</div>'
    }

    /* 输入框内容只在 DOM 中，重绘前先回写到内存，避免添加 / 删除时丢失未保存的编辑 */
    function sync() {
      const rows = root.querySelectorAll('#bn-list [data-i]')
      if (!rows.length) return
      const next = []
      rows.forEach(function (row) {
        const i = Number(row.getAttribute('data-i'))
        next[i] = {
          id: (items[i] && items[i].id) || '',
          title: row.querySelector('[data-f="title"]').value.trim(),
          content: row.querySelector('[data-f="content"]').value.trim()
        }
      })
      items = next
    }

    function paint() {
      root.innerHTML = card('横幅开关与速度',
        '<div class="setting-row">' +
        '<div class="info"><div class="strong">首页展示横幅</div>' +
        '<div class="small" style="color:var(--muted-2)">关闭后小程序首页不再展示跑马灯，已配置内容保留</div></div>' +
        '<div class="ctrl"><label class="small"><input type="checkbox" id="bn-on"' + (on ? ' checked' : '') +
        ' style="margin-right:6px">启用</label></div></div>' +
        '<div class="setting-row">' +
        '<div class="info"><div class="strong">滚动速度</div>' +
        '<div class="small" style="color:var(--muted-2)">像素 / 秒，数值越大滚动越快（10 - 200）</div></div>' +
        '<div class="ctrl"><input id="bn-speed" type="number" min="10" max="200" step="5" value="' + speed +
        '" style="width:110px"></div></div>') +
        card('横幅内容',
          '<div id="bn-list">' + items.map(rowHtml).join('') + '</div>' +
          '<div class="flex" style="margin-top:10px"><button class="btn" id="bn-add">＋ 添加一条</button></div>' +
          '<div class="small" style="color:var(--muted-2);margin-top:8px">标题拼接后横向滚动，点击横幅在弹窗中展示每条正文；最多 20 条。</div>') +
        '<div class="flex" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" id="bn-save">保存横幅</button></div>'

      root.querySelector('#bn-on').onchange = function () { on = this.checked }
      root.querySelector('#bn-speed').oninput = function () { speed = Number(this.value) || 0 }
      root.querySelector('#bn-add').onclick = function () {
        sync()
        if (items.length >= 20) return toast('最多 20 条', 'err')
        items.push({ id: '', title: '', content: '' })
        paint()
      }
      root.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.onclick = function () {
          sync()
          items.splice(Number(btn.getAttribute('data-del')), 1)
          if (!items.length) items.push({ id: '', title: '', content: '' })
          paint()
        }
      })
      root.querySelector('#bn-save').onclick = async function () {
        sync()
        const btn = this
        btn.disabled = true
        try {
          await api('setting.save', {
            siteName: s.siteName || '算力聚合',
            servicePhone: s.servicePhone || '',
            serviceTime: s.serviceTime || '',
            wecomId: s.wecomId || '',
            apiBase: s.apiBase || '',
            planNote: s.planNote || '',
            qrNote: s.qrNote || '',
            qrUrl: s.qrUrl || '',
            tmplInquiry: s.tmplInquiry || '',
            tmplChat: s.tmplChat || '',
            tmplSystem: s.tmplSystem || '',
            tmplBiz: s.tmplBiz || '',
            planPrice: s.planPrice || '99 元 / 月',
            planDays: Number(s.planDays) || 30,
            plans: planList(s),
            bannerEnabled: on,
            bannerSpeed: speed || 40,
            /* 空标题行直接丢弃，避免管理端留白行出现在小程序滚动条里 */
            bannerItems: items.filter(function (x) { return x.title })
          })
          settingsCache = null
          toast('横幅已保存')
          if (onSaved) onSaved()
          else Pages.settings(document.getElementById('view'))
        } catch (err) {
          toast(err.message, 'err')
          btn.disabled = false
        }
      }
    }

    paint()
  }

  async function renderMember(root) {
    const s = await loadSettings(true)
    const plans = planList(s)
    root.innerHTML = stackWrap(
      card('四档会员套餐', '<div id="m-plans">' + plans.map(function (p) {
        return '<div class="setting-row" data-key="' + esc(p.key) + '">' +
          '<div class="info"><div class="strong">' + esc(p.label) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + esc(p.key) + ' · 用户端确认开通即调起微信支付，成功后自动加时长</div></div>' +
          '<div class="ctrl" style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<label class="small">天数<input data-f="days" type="number" min="1" max="3650" value="' + p.days + '" style="width:82px;margin-left:6px"></label>' +
          '<label class="small">现价<input data-f="price" type="number" min="1" step="0.01" value="' + p.price + '" style="width:92px;margin-left:6px"></label>' +
          '<label class="small">原价<input data-f="original" type="number" min="0" step="0.01" value="' + p.original + '" style="width:92px;margin-left:6px"></label>' +
          '</div></div>'
      }).join('') + '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-top:10px">原价用于展示划线价与「省多少」，不得低于现价。</div>'),
      card('默认口径', '<div class="form-grid">' +
        field('用户端价格文案', '<input id="m-price" value="' + esc(s.planPrice || '99 元 / 月') + '">') +
        field('默认开通天数', '<input id="m-days" type="number" min="1" max="365" value="' + (Number(s.planDays) || 30) + '">') +
        '<div class="field full"><label>套餐说明</label><textarea id="m-note" rows="3">' + esc(s.planNote || '') + '</textarea></div>' +
        '</div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:8px;line-height:1.8">用户端点「确认开通」后直接调起微信支付，支付成功自动写入会员时长并通知用户；委托服务费由超管在财务中心确认到账。</div>')
    ) + '<div class="flex" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" id="m-save">保存套餐</button></div>'

    root.querySelector('#m-save').onclick = async function () {
      const btn = this
      const rows = []
      root.querySelectorAll('#m-plans [data-key]').forEach(function (row) {
        rows.push({
          key: row.getAttribute('data-key'),
          days: Number(row.querySelector('[data-f="days"]').value),
          price: Number(row.querySelector('[data-f="price"]').value),
          original: Number(row.querySelector('[data-f="original"]').value)
        })
      })
      btn.disabled = true
      try {
        await api('setting.save', {
          siteName: s.siteName || '算力聚合',
          servicePhone: s.servicePhone || '',
          serviceTime: s.serviceTime || '',
          wecomId: s.wecomId || '',
          apiBase: s.apiBase || '',
          planNote: root.querySelector('#m-note').value.trim(),
          qrNote: s.qrNote || '',
          qrUrl: s.qrUrl || '',
          tmplInquiry: s.tmplInquiry || '',
          tmplChat: s.tmplChat || '',
          planPrice: root.querySelector('#m-price').value.trim(),
          planDays: Number(root.querySelector('#m-days').value),
          plans: rows
        })
        settingsCache = null
        toast('套餐已保存')
        Pages.settings(document.getElementById('view'))
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  async function renderRules(root) {
    const data = await api('rules.list', {})
    const items = data.items || []
    const on = items.filter(function (r) { return r.enabled }).length
    const canEdit = C.can('rule.create')
    root.innerHTML =
      '<div class="grid g4">' +
      kpi('规则总数', num(items.length), '覆盖商品 / 用户 / 咨询 / 系统') +
      kpi('已启用', num(on), '<span class="small" style="color:var(--muted-2)">命中即生成风险单</span>') +
      kpi('未启用', num(items.length - on), '可在下方逐条开启') +
      kpi('累计命中', num(items.reduce(function (n, r) { return n + (Number(r.hitCount) || 0) }, 0)), '规则命中总次数') +
      '</div><div style="height:14px"></div>' +
      card('检测规则', table(['规则', '类型', '适用范围', '档位', '命中', '更新时间', '状态'], items.map(function (r) {
        return '<td><div class="strong">' + esc(r.name) + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.condText || r.note || '') + '</div></td>' +
          '<td>' + esc(r.typeName || '—') + '</td>' +
          '<td>' + esc(r.scopeText || '全局') + '</td>' +
          '<td><div>' + esc(r.tierName || r.tier) + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.tierDesc || '') + '</div></td>' +
          '<td class="mono">' + num(r.hitCount) + '</td>' +
          '<td class="small">' + esc(r.updatedAt ? dateText(r.updatedAt) : '—') + '</td>' +
          '<td>' + autoBadge(r.enabled ? '启用' : '停用') +
          '<button class="btn xs" data-rule="' + esc(r.id) + '" data-on="' + (r.enabled ? '1' : '0') + '" style="margin-left:6px">' + (r.enabled ? '停用' : '启用') + '</button>' +
          (canEdit ? '<button class="btn xs" data-edit-rule="' + esc(r.id) + '" style="margin-left:6px">编辑</button>' : '') + '</td>'
      }), '暂无规则'),
      canEdit ? '<button class="btn primary" id="r-add">' + icon('plus') + '<span>新增规则</span></button>' : '')

    if (canEdit) {
      const byId = {}
      items.forEach(function (r) { byId[r.id] = r })
      root.querySelector('#r-add').onclick = function () {
        openRuleModal(data, null, function () { Pages.settings(document.getElementById('view')) })
      }
      root.querySelectorAll('[data-edit-rule]').forEach(function (btn) {
        btn.onclick = function () {
          const rule = byId[btn.getAttribute('data-edit-rule')]
          if (rule) openRuleModal(data, rule, function () { Pages.settings(document.getElementById('view')) })
        }
      })
    }

    root.querySelectorAll('[data-rule]').forEach(function (btn) {
      btn.onclick = async function () {
        btn.disabled = true
        try {
          await api('rule.toggle', { id: btn.getAttribute('data-rule'), enabled: btn.getAttribute('data-on') !== '1' })
          toast('规则状态已更新')
          Pages.settings(document.getElementById('view'))
        } catch (err) {
          toast(err.message, 'err')
          btn.disabled = false
        }
      }
    })
  }

  /* 规则条件回填：手机号 / 敏感词按行展示，数值型直接回填 */
  function ruleValueOf(rule) {
    if (!rule) return ''
    const c = rule.cond || {}
    if (rule.type === 'phone') return (c.blockedPhones || []).join('，')
    if (rule.type === 'word') return (c.blockedWords || []).join('\n')
    if (rule.type === 'repeat') return c.maxPerDay ? String(c.maxPerDay) : ''
    if (rule.type === 'materials') return c.requireMaterials === undefined ? '' : String(c.requireMaterials)
    if (rule.type === 'cross') return c.crossCategory ? String(c.crossCategory) : ''
    if (rule.type === 'budget') return c.minBudget ? String(c.minBudget) : ''
    if (rule.type === 'category') return c.cat || ''
    return ''
  }

  /* 不同类型给不同的录入提示，避免把手机号填进「咨询次数」 */
  function ruleHintOf(type) {
    const map = {
      phone: '每行一个手机号，或用逗号分隔；服务端只落盲索引',
      word: '每行一个敏感词，最多 30 个',
      repeat: '同一账号 24 小时内咨询次数上限，整数',
      materials: '有效资质材料少于该份数时命中，整数',
      cross: '跨品类数量超过该值时命中，整数',
      budget: '预算达到该金额（元）及以上时命中，整数',
      category: '填写品类名称，例如 GPU 服务器'
    }
    return map[type] || ''
  }

  /* 新增 / 编辑筛选规则：档位与类型口径完全由后端下发，前端不硬编码 */
  function openRuleModal(meta, rule, done) {
    const isEdit = !!rule
    const types = (meta && meta.types) || []
    const tiers = (meta && meta.tiers) || []
    const originValue = ruleValueOf(rule)
    const m = modal({
      title: isEdit ? '编辑筛选规则' : '新增筛选规则',
      sub: '命中 P0 直接进已拦截箱；P1 标红待核；P2 排到待分配队列前面',
      body:
        field('规则名称', '<input id="r-name" maxlength="40" placeholder="例如：手机号黑名单" value="' + esc(isEdit ? rule.name : '') + '">') +
        '<div class="grid g2">' +
        field('规则类型', '<select id="r-type">' + options(types.map(function (t) { return { value: t.key, label: t.name } }), isEdit ? rule.type : (types[0] && types[0].key), false) + '</select>') +
        field('档位', '<select id="r-tier">' + options(tiers.map(function (t) { return { value: t.tier, label: t.name } }), isEdit ? rule.tier : 'P2', false) + '</select>') +
        '</div>' +
        field('条件值', '<textarea id="r-value" rows="3" placeholder="' + esc(ruleHintOf(isEdit ? rule.type : (types[0] && types[0].key))) + '">' + esc(originValue) + '</textarea>') +
        '<div class="small" id="r-hint" style="color:var(--muted-2);margin:-6px 0 10px">' + esc(ruleHintOf(isEdit ? rule.type : (types[0] && types[0].key))) + '</div>' +
        '<div class="grid g2">' +
        field('作用范围', '<select id="r-scope">' + options([{ value: 'global', label: '全平台' }, { value: 'category', label: '指定品类' }, { value: 'product', label: '指定商品' }], isEdit ? (rule.scope || 'global') : 'global', false) + '</select>') +
        field('范围对象', '<input id="r-key" maxlength="60" placeholder="品类或商品 ID" value="' + esc(isEdit ? (rule.scopeKey || '') : '') + '">') +
        '</div>' +
        field('备注', '<input id="r-note" maxlength="100" placeholder="选填，说明这条规则的用途" value="' + esc(isEdit ? (rule.note || '') : '') + '">'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="r-save">' + (isEdit ? '保存修改' : '创建规则') + '</button>'
    })
    if (!m) return
    const typeEl = m.querySelector('#r-type')
    const valueEl = m.querySelector('#r-value')
    const hintEl = m.querySelector('#r-hint')
    const keyEl = m.querySelector('#r-key')
    typeEl.onchange = function () {
      /* 换类型后旧条件不可复用，清空避免误提交 */
      valueEl.value = ''
      hintEl.textContent = ruleHintOf(typeEl.value)
      valueEl.setAttribute('placeholder', ruleHintOf(typeEl.value))
    }
    m.querySelector('#r-save').onclick = async function () {
      const btn = this
      const payload = {
        name: m.querySelector('#r-name').value.trim(),
        type: typeEl.value,
        tier: m.querySelector('#r-tier').value,
        scope: m.querySelector('#r-scope').value,
        scopeKey: keyEl.value.trim(),
        note: m.querySelector('#r-note').value.trim()
      }
      if (!payload.name) { toast('请填写规则名称', 'err'); return }
      /* 未改动条件时不下发 value，服务端沿用原条件（手机号规则只回填打码值） */
      const current = valueEl.value
      if (!isEdit || current !== originValue) payload.value = current
      if (isEdit) payload.version = rule.version
      btn.disabled = true
      try {
        await api(isEdit ? 'rule.update' : 'rule.create', payload)
        closeModal()
        toast(isEdit ? '规则已更新' : '规则已创建')
        if (typeof done === 'function') done()
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  async function renderCatalog(root) {
    const data = await api('catalog.list', { q: catalogFilter.q, status: catalogFilter.status })
    const items = data.items || []
    const counts = data.counts || {}
    catalogTotal = (counts.active || 0) + (counts.disabled || 0) + (counts.removed || 0)
    const totalSpan = document.getElementById('set-catalog-count')
    if (totalSpan) totalSpan.textContent = catalogTotal ? num(catalogTotal) : ''
    root.innerHTML =
      '<div class="grid g4">' +
      kpi('型号总数', num(catalogTotal), '内置目录 + 平台维护') +
      kpi('启用', num(counts.active), '用户端可选') +
      kpi('停用', num(counts.disabled), '不展示但保留记录') +
      kpi('已删除', num(counts.removed), '软删除，可追溯') +
      '</div><div style="height:14px"></div>' +
      '<div class="filters"><div class="field"><label>关键词</label><input id="c-q" placeholder="品类 / 品牌 / 系列 / 型号" value="' + esc(catalogFilter.q) + '"></div>' +
      '<div class="field"><label>状态</label><select id="c-fs">' + options([{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }, { value: 'removed', label: '已删除' }], catalogFilter.status) + '</select></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn" id="c-search">' + icon('search') + '<span>查询</span></button></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="c-add">' + icon('plus') + '<span>新增型号</span></button></div></div>' +
      card('型号列表', table(['品类', '品牌', '系列', '型号', '状态', '来源', '更新时间', '操作'], items.map(function (r) {
        return '<td>' + esc(r.cat) + '</td><td>' + esc(r.brand) + '</td><td>' + esc(r.series) + '</td><td class="strong">' + esc(r.model) + '</td>' +
          '<td>' + autoBadge(r.status === 'active' ? '启用' : r.status === 'disabled' ? '停用' : '已删除') + '</td>' +
          '<td class="small">' + esc(r.source === 'platform' ? '平台维护' : r.source === 'builtin' ? '内置目录' : r.source || '—') + '</td>' +
          '<td class="small">' + esc(r.updatedAt ? dateText(r.updatedAt) : '—') + '</td>' +
          '<td><button class="btn xs" data-edit="' + esc(r.id) + '">编辑</button>' +
          (r.status === 'active' ? '<button class="btn xs" data-off="' + esc(r.id) + '" style="margin-left:6px">停用</button>' : '') +
          '<button class="btn xs danger" data-del="' + esc(r.id) + '" data-model="' + esc(r.cat + ' ' + r.brand + ' ' + r.model) + '" style="margin-left:6px">删除</button></td>'
      }), '暂无型号记录'))

    root.querySelector('#c-search').onclick = function () {
      catalogFilter = { q: root.querySelector('#c-q').value.trim(), status: root.querySelector('#c-fs').value }
      Pages.settings(document.getElementById('view'))
    }
    root.querySelector('#c-q').onkeydown = function (e) {
      if (e.key === 'Enter') root.querySelector('#c-search').click()
    }
    root.querySelector('#c-add').onclick = function () {
      openCatalogModal(null, function () { Pages.settings(document.getElementById('view')) })
    }
    const byId = {}
    items.forEach(function (r) { byId[r.id] = r })
    root.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.onclick = function () {
        openCatalogModal(byId[btn.getAttribute('data-edit')], function () { Pages.settings(document.getElementById('view')) })
      }
    })
    root.querySelectorAll('[data-off]').forEach(function (btn) {
      btn.onclick = async function () {
        const r = byId[btn.getAttribute('data-off')]
        btn.disabled = true
        try {
          await api('catalog.save', { cat: r.cat, brand: r.brand, series: r.series, model: r.model, note: r.note, status: 'disabled' })
          toast('型号已停用')
          Pages.settings(document.getElementById('view'))
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      }
    })
    root.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.onclick = async function () {
        const ok = await confirm({ title: '删除型号', message: '确认删除「' + btn.getAttribute('data-model') + '」？删除后用户端不再展示。', okText: '删除', danger: true })
        if (!ok) return
        try {
          await api('catalog.remove', { id: btn.getAttribute('data-del') })
          toast('型号已删除')
          Pages.settings(document.getElementById('view'))
        } catch (err) { toast(err.message, 'err') }
      }
    })
  }

  function openCatalogModal(row, onDone) {
    const r = row || {}
    const root = modal({
      title: row ? '编辑型号' : '新增型号',
      sub: '同一「品类 + 品牌 + 系列 + 型号」只保留一条记录',
      body: '<div class="form-grid">' +
        field('品类', '<input id="c-cat" value="' + esc(r.cat || '') + '" placeholder="如 GPU 服务器 / GPU 加速卡">') +
        field('品牌', '<input id="c-brand" value="' + esc(r.brand || '') + '">') +
        field('系列', '<input id="c-series" value="' + esc(r.series || '') + '">') +
        field('型号', '<input id="c-model" value="' + esc(r.model || '') + '">') +
        field('状态', '<select id="c-status">' + options([{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }], r.status || 'active', false) + '</select>') +
        field('备注', '<input id="c-note" value="' + esc(r.note || '') + '">') +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="c-ok">保存</button>'
    })
    if (!root) return
    root.querySelector('#c-ok').onclick = async function () {
      const btn = this
      btn.disabled = true
      try {
        await api('catalog.save', {
          cat: root.body.querySelector('#c-cat').value.trim(),
          brand: root.body.querySelector('#c-brand').value.trim(),
          series: root.body.querySelector('#c-series').value.trim(),
          model: root.body.querySelector('#c-model').value.trim(),
          status: root.body.querySelector('#c-status').value,
          note: root.body.querySelector('#c-note').value.trim()
        })
        closeModal()
        toast('型号已保存')
        if (typeof onDone === 'function') onDone()
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  async function renderSort(root) {
    const data = await api('rule.sort', {})
    const rules = data.rules || {}
    const weights = rules.weights || {}
    const factors = data.factors || []
    root.innerHTML = stackWrap(
      card('排序因素权重', factors.map(function (f) {
        return '<div class="setting-row"><div class="info"><div class="strong">' + esc(f.label) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + esc(f.hint) + '</div></div>' +
          '<div class="ctrl"><input data-w="' + esc(f.key) + '" type="number" min="0" max="100" value="' + (Number(weights[f.key]) || 0) + '" style="width:88px"> <span class="small">分</span></div></div>'
      }).join('') + '<div class="small" style="color:var(--muted-2);margin-top:10px">权重 0 - 100，合计需大于 0；分高的商机排前面。</div>'),
      card('大额与开关', '<div class="form-grid">' +
        field('大额门槛（元）', '<input id="s-threshold" type="number" min="10000" step="10000" value="' + (Number(rules.amountThreshold) || 10000000) + '">') +
        '</div>' +
        '<div class="setting-row"><div class="info"><div class="strong">启用排序规则</div><div class="small" style="color:var(--muted-2)">关闭后商机按提交时间倒序</div></div>' +
        '<div class="ctrl"><label class="switch"><input type="checkbox" id="s-enabled"' + (rules.enabled !== false ? ' checked' : '') + '><i></i></label></div></div>' +
        '<div class="setting-row"><div class="info"><div class="strong">大额只看资料齐全度</div><div class="small" style="color:var(--muted-2)">达到门槛的委托之间只按资料齐全度排序</div></div>' +
        '<div class="ctrl"><label class="switch"><input type="checkbox" id="s-large"' + (rules.largeCompletenessFirst !== false ? ' checked' : '') + '><i></i></label></div></div>' +
        '<div class="small" style="color:var(--muted-2);margin-top:8px">大额委托（1000 万以上）优先看资料是否齐全，避免只按金额压过资质核验。</div>')
    ) + '<div class="flex" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" id="s-save">保存排序规则</button></div>'

    root.querySelector('#s-save').onclick = async function () {
      const btn = this
      const next = {}
      root.querySelectorAll('[data-w]').forEach(function (input) {
        next[input.getAttribute('data-w')] = Number(input.value) || 0
      })
      btn.disabled = true
      try {
        await api('rule.sortSave', {
          weights: next,
          amountThreshold: Number(root.querySelector('#s-threshold').value),
          enabled: root.querySelector('#s-enabled').checked,
          largeCompletenessFirst: root.querySelector('#s-large').checked
        })
        toast('排序规则已保存')
        Pages.settings(document.getElementById('view'))
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  /* ============================================================
     7. 财务中心：营收汇总 / 收款流水 / 用户消费
     ============================================================ */

  const PAY_FILTER = { status: '', bizType: '', keyword: '', page: 1, limit: 20 }
  const REFUND_FILTER = { status: '待处理', q: '', page: 1, limit: 10 }
  /* 收款方式兜底：接口返回 methods 时用接口值，避免前后端枚举不一致 */
  const PAY_METHOD_FALLBACK = ['微信支付', '企业微信', '微信转账', '对公转账', '支付宝', '现金', '其他']
  let payMeta = { statusList: [], bizTypes: [] }

  /**
   * 每周对账：系统已按支付结果自动加时长，财务不再逐笔确认，只需每周核对一次流水。
   * 对账状态按账号存在本地，跨周自动重新提醒；无痕模式下取不到 localStorage 就当作未对账。
   */
  const RECON_DAY_MS = 24 * 60 * 60 * 1000

  function reconKey() {
    const account = state.account || {}
    return 'console.financeRecon.' + String(account.username || account.name || 'admin')
  }

  /* 周一 00:00（北京时间）作为一周起点 */
  function weekStartOf(ms) {
    const shifted = (Number(ms) || 0) + 8 * 60 * 60 * 1000
    const day = Math.floor(shifted / RECON_DAY_MS)
    const mondayOffset = (day + 3) % 7
    return (day - mondayOffset) * RECON_DAY_MS - 8 * 60 * 60 * 1000
  }

  function reconState() {
    let lastAt = 0
    try { lastAt = Number(localStorage.getItem(reconKey())) || 0 } catch (err) { lastAt = 0 }
    return { lastAt: lastAt, due: !lastAt || weekStartOf(lastAt) < weekStartOf(Date.now()) }
  }

  function markReconciled() {
    try { localStorage.setItem(reconKey(), String(Date.now())) } catch (err) { /* 无痕模式忽略 */ }
  }

  function reconCard(recon) {
    const r = recon || {}
    const st = reconState()
    return '<section class="card" style="margin-top:14px"><div class="card-head"><h3>每周对账</h3><div class="grow"></div>' +
      (st.due
        ? '<span class="todo-flag">本周待对账</span>'
        : '<span class="small" style="color:var(--muted-2)">本周已对账</span>') +
      '<button class="btn xs" id="f-recon-ok" style="margin-left:8px">标记本周已对账</button></div>' +
      '<div class="card-body">' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:10px">支付成功已自动加时长，财务每周核对一次即可：微信支付商户平台 ↔ 系统订单，差异写在收款备注里。手动开通只留痕，不计营收。</div>' +
      '<div class="grid g3">' +
      kpi('微信支付（近 7 天）', money(r.wechatAmount), num(r.wechatCount) + ' 笔自动开通') +
      kpi('本周合计', money(r.total), '营收口径 · 仅微信支付') +
      kpi('上次对账', st.lastAt ? dateText(st.lastAt) : '尚未对账', st.due ? '本周尚未核对' : '本周已核对') +
      '</div></div></section>'
  }

  function wireRecon(root) {
    const btn = root && root.querySelector('#f-recon-ok')
    if (!btn) return
    btn.disabled = !reconState().due
    btn.onclick = function () {
      markReconciled()
      toast('已标记本周对账完成')
      C.renderPage()
    }
  }

  /* 财务中心页签与筛选状态：切页签只换内容区，各页签筛选条件互不影响 */
  const FIN = {
    tab: 'overview',
    withdraw: { status: '', keyword: '', page: 1, limit: 20 },
    commission: { month: '', type: '', keyword: '', page: 1, limit: 20 }
  }

  function finTabs() {
    const tabs = [
      ['overview', '资金总览'],
      ['payments', '收款入账'],
      ['withdrawals', '提现台账'],
      ['commissions', '佣金台账']
    ]
    if (C.can('refund.list')) tabs.push(['refunds', '退款申请'])
    if (C.can('promote.saveSettings')) tabs.push(['rates', '佣金设置'])
    return tabs
  }

  /* 近 12 个自然月选项：佣金 / 工资按自然月归档，默认全部 */
  function finMonthList() {
    const list = [{ value: '', label: '全部月份' }]
    const base = new Date(Date.now() + 8 * 60 * 60 * 1000)
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
      const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
      list.push({ value: key, label: key + (i === 0 ? '（本月）' : i === 1 ? '（上月）' : '') })
    }
    return list
  }

  function finReload(tab) {
    const view = document.getElementById('view')
    if (!view) return
    if (tab) FIN.tab = tab
    Pages.finance(view, { query: { tab: FIN.tab } })
  }

  function finDirectionBadge(dir) {
    return badge(dir === 'out' ? '支出' : '收入', dir === 'out' ? 'danger' : 'ok', true)
  }

  function finPayableOf(w) {
    /* 已冲正 / 被占用佣金不会生成出款明细，实际应付 = 净额 − 未覆盖金额 */
    return Math.max(0, Math.round((Number(w.net || 0) - Number(w.uncoveredAmount || 0)) * 100) / 100)
  }

  Pages.finance = async function (view, ctx) {
    const query = (ctx && ctx.query) || {}
    const tabs = finTabs()
    if (query.tab && tabs.some(function (t) { return t[0] === query.tab })) FIN.tab = query.tab
    if (!tabs.some(function (t) { return t[0] === FIN.tab })) FIN.tab = 'overview'

    view.innerHTML = pageHead('财务中心', '收款入账 · 提现打款 · 佣金计提 · 退款处理：每笔资金一条台账，可查、可改、可追溯',
      (C.can('payment.manual') ? '<button class="btn primary" id="f-manual">' + icon('plus') + '<span>补录入账</span></button>' : '') +
      '<button class="btn" id="f-grant">' + icon('spark') + '<span>开通会员</span></button>') +
      '<div class="tabs" id="f-tabs">' + tabs.map(function (t) {
        return '<button class="' + (FIN.tab === t[0] ? 'on' : '') + '" data-f-tab="' + t[0] + '">' + esc(t[1]) + '</button>'
      }).join('') + '</div>' +
      '<div id="f-body" style="margin-top:14px">' + loadingBlock('读取财务数据') + '</div>'

    view.querySelectorAll('[data-f-tab]').forEach(function (btn) {
      btn.onclick = function () {
        const key = btn.getAttribute('data-f-tab')
        if (FIN.tab === key) return
        finReload(key)
      }
    })
    view.querySelector('#f-grant').onclick = function () { openGrantModal({ onDone: function () { Pages.finance(view) } }) }
    const manualBtn = view.querySelector('#f-manual')
    if (manualBtn) manualBtn.onclick = function () { openFinManualPayment(function () { finReload('payments') }) }

    const body = view.querySelector('#f-body')
    try {
      if (FIN.tab === 'payments') await renderPayFlow(body)
      else if (FIN.tab === 'withdrawals') await renderFinWithdrawals(body)
      else if (FIN.tab === 'commissions') await renderFinCommissions(body)
      else if (FIN.tab === 'rates') await renderFinRates(body)
      else if (FIN.tab === 'refunds') renderRefundQueue(body, await api('refund.list', Object.assign({}, REFUND_FILTER)))
      else await renderFinOverview(body)
    } catch (err) {
      body.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
    }
  }

  /* ---------------- 总览：现金口径 = 收款 − 退款 − 已打款提现 ---------------- */
  async function renderFinOverview(root) {
    const data = await api('finance.summary', { days: 30 })
    const t = data.totals || {}
    const c = data.cash || {}
    const months = data.months || []
    const byBizType = data.byBizType || []
    const byChannel = data.byChannel || []
    const byPlan = data.byPlan || []
    const topSpenders = data.topSpenders || []
    const recentCash = data.recentCash || []
    root.innerHTML =
      '<div class="grid g5">' +
      kpi('本月收款', money(c.incomeMonth), '累计 ' + money(c.incomeTotal) + ' · 退款 ' + money(c.refundMonth)) +
      kpi('本月已打款', money(c.withdrawPaidMonth), '累计 ' + money(c.withdrawPaid) + ' · 共 ' + num(c.withdrawCount) + ' 笔提现') +
      kpi('本月现金结余', money(c.balanceMonth), '累计结余 ' + money(c.balance)) +
      kpi('本月佣金计提', money(c.commissionMonth), '累计 ' + money(c.commissionTotal)) +
      kpi('待打款提现', money(c.withdrawPending), num(c.withdrawPendingCount) + ' 笔待处理 · 失败 ' + num(c.withdrawFailedCount) + ' 笔') +
      '</div>' +
      '<div class="grid g2" style="margin-top:12px">' +
      kpi('客服工资 · 本月', money(c.staffSalaryMonth), '累计 ' + money(c.staffSalaryTotal) + ' · 仅委托佣金') +
      kpi('推广者佣金', money(c.promoterCommissionMonth), '累计 ' + money(c.promoterCommissionTotal)) +
      '</div>' +
      '<div class="grid g4" style="margin-top:12px">' +
      kpi('总营收（会员 + 委托服务费）', money(t.revenue), '今日 ' + money(t.today) + ' · 近 30 天 ' + money(t.last30)) +
      kpi('委托服务费收入', money(t.serviceFeeRevenue), '会员开通收入 ' + money(t.memberRevenue) + ' · 服务费 ' + num(t.feeOrders) + ' 笔') +
      kpi('待确认收款', money(t.pendingAmount), num(t.pendingCount) + ' 笔待确认到账') +
      kpi('活跃会员 / 7 天内到期', num(t.activeMembers) + ' / ' + num(t.expiringSoon), '付费用户 ' + num(t.payers) + ' 人 · ARPU ' + money(t.arpu)) +
      '</div>' +
      reconCard(data.recon) +
      card('渠道营收（Apple 单独核算）', table(['渠道', '笔数', '金额', '占比'], byChannel.map(function (r) {
        const pct = Number(t.revenue) > 0 ? Math.round((Number(r.amount) / Number(t.revenue)) * 1000) / 10 : 0
        return '<td>' + esc(r.label) + (r.key === 'apple' ? ' ' + badge('单独出表', 'warn', true) : '') + '</td>' +
          '<td>' + num(r.count) + '</td><td class="mono strong">' + money(r.amount) + '</td><td class="mono">' + pct + '%</td>'
      }), '暂无渠道数据'), '<span class="small">Apple 内购收入按 Apple 账单单独核算，不并入微信对账；手动开通 / 线下登记单列可追溯。</span>') +
      '<div class="grid g-side" style="margin-top:14px;align-items:start">' +
      card('近 6 个月资金流向', table(['月份', '总营收', '其中委托服务费', 'Apple 营收', '已打款提现', '佣金计提'], months.map(function (m) {
        return '<td class="strong">' + esc(m.month) + '</td><td class="mono">' + money(m.revenue) + '</td>' +
          '<td class="mono">' + money(m.fee) + '</td>' +
          '<td class="mono">' + money(m.apple) + '</td>' +
          '<td class="mono">' + money(m.withdraw) + '</td><td class="mono">' + money(m.commission) + '</td>'
      }), '暂无资金数据')) +
      card('营收结构', '<div style="margin-bottom:14px"><div class="small" style="color:var(--muted-2);margin-bottom:8px">按业务类型</div>' +
        progressRows(byBizType.map(function (b) {
          return { label: b.bizType, value: b.amount, text: money(b.amount) + ' · ' + b.count + ' 笔' }
        })) + '</div>' +
        '<div class="small" style="color:var(--muted-2);margin-bottom:8px">按会员套餐</div>' +
        table(['套餐', '笔数', '金额', '累计天数'], byPlan.map(function (p) {
          return '<td>' + esc(p.label) + '</td><td>' + num(p.count) + '</td><td>' + money(p.amount) + '</td><td>' + num(p.days) + ' 天</td>'
        }), '暂无会员订单')) +
      '</div>' +
      '<div class="grid g-side" style="margin-top:14px;align-items:start">' +
      card('最近资金流水', table(['时间', '方向', '用户', '摘要', '金额'], recentCash.map(function (r) {
        return '<td class="small">' + esc(r.paidText || dateText(r.at)) + '</td>' +
          '<td>' + finDirectionBadge(r.direction) + '</td>' +
          '<td><div>' + esc(r.nick || '—') + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.method || '') + '</div></td>' +
          '<td class="small">' + esc(r.label || r.kind || '') + '</td>' +
          '<td class="mono strong">' + (r.direction === 'out' ? '-' : '+') + money(r.amount) + '</td>'
      }), '暂无资金流水')) +
      card('用户消费排行', table(['用户', '累计消费', '近 30 天', '笔数', '最近消费'], topSpenders.map(function (u) {
        return '<td><div class="strong">' + esc(u.nick) + '</div><div class="small" style="color:var(--muted-2)">' + esc(u.uid) + '</div></td>' +
          '<td class="mono">' + money(u.total) + '</td><td class="mono">' + money(u.last30) + '</td>' +
          '<td>' + num(u.count) + '</td><td class="small">' + esc(u.lastText) + '</td>'
      }), '暂无消费记录')) +
      '</div>'
    wireRecon(root)
  }

  /* ---------------- 收款入账：可编辑备注 / 凭证，可补录线下收入 ---------------- */
  async function renderPayFlow(root) {
    const data = await api('payment.list', Object.assign({}, PAY_FILTER))
    payMeta = {
      statusList: data.statusList || [],
      bizTypes: data.bizTypes || [],
      methods: data.methods || PAY_METHOD_FALLBACK.slice()
    }
    const items = data.items || []
    const totals = data.totals || {}
    root.innerHTML = card('收款入账台账',
      '<div class="filters">' +
      '<div class="field"><label>状态</label><select id="pf-status">' + options(payMeta.statusList, PAY_FILTER.status) + '</select></div>' +
      '<div class="field"><label>业务类型</label><select id="pf-biz">' + options(payMeta.bizTypes, PAY_FILTER.bizType) + '</select></div>' +
      '<div class="field"><label>关键词</label><input id="pf-kw" placeholder="用户 / 备注 / 收款单号" value="' + esc(PAY_FILTER.keyword) + '"></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn" id="pf-search">' + icon('search') + '<span>查询</span></button></div>' +
      '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:10px">合计 ' + money(totals.all) + ' · 已到账 ' + money(totals.confirmed) +
      (Number(totals.pending) > 0 ? ' · 待确认 ' + money(totals.pending) : '') +
      ' · 已退款 ' + money(totals.refunded) + '</div>' +
      table(['用户', '业务', '套餐', '应收', '优惠', '实收', '方式', '状态', '收款日期', '备注 / 凭证', '操作'], items.map(function (r) {
        return '<td><div class="strong">' + esc(r.nick) + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.uid) + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(r.id) + '</div></td>' +
          '<td>' + esc(r.bizType) + (r.manual ? badge('补录', 'warn', true) : '') + '</td>' +
          '<td class="small">' + esc(r.planLabel || (r.days ? r.days + ' 天' : '—')) + '</td>' +
          '<td class="mono">' + money(r.amount) + '</td><td class="mono">' + money(r.discount) + '</td>' +
          '<td class="mono strong">' + money(r.received) + '</td><td>' + esc(r.method || '—') + '</td>' +
          '<td>' + autoBadge(r.status) + '</td><td class="small">' + esc(r.paidText) + '</td>' +
          '<td class="small" style="max-width:220px">' +
            (r.note ? esc(r.note) : '<span style="color:var(--muted-2)">未填写</span>') +
            (r.voucher ? '<div><button class="btn xs ghost" data-pv="' + esc(r.voucher) + '">' + icon('eye') + '<span>凭证</span></button></div>' : '') +
          '</td>' +
          '<td>' +
          (C.can('payment.updateNote') ? '<button class="btn xs" data-edit="' + esc(r.id) + '">编辑备注</button>' : '') +
          (r.status === '待确认' && r.agencyId && C.can('payment.feeConfirm')
            ? '<button class="btn xs" data-ok="' + esc(r.id) + '">确认到账</button>'
            : '') +
          (r.status === '已确认' && C.can('payment.refund')
            ? '<button class="btn xs danger" data-back="' + esc(r.id) + '">退款</button>'
            : '') + '</td>'
      }), '暂无收款记录') + pager(data.total, data.page || PAY_FILTER.page, data.limit || PAY_FILTER.limit),
      '<span class="small">提醒：收款以实际到账为准；补录只用于线下 / 对公转账，需填写说明并保留凭证。</span>')

    root.querySelector('#pf-search').onclick = function () {
      PAY_FILTER.status = root.querySelector('#pf-status').value
      PAY_FILTER.bizType = root.querySelector('#pf-biz').value
      PAY_FILTER.keyword = root.querySelector('#pf-kw').value.trim()
      PAY_FILTER.page = 1
      finReload('payments')
    }
    root.querySelector('#pf-kw').onkeydown = function (e) {
      if (e.key === 'Enter') root.querySelector('#pf-search').click()
    }
    wirePager(root, function (page) {
      PAY_FILTER.page = page
      finReload('payments')
    })
    root.querySelectorAll('[data-pv]').forEach(function (btn) {
      btn.onclick = function () { previewImage(btn.getAttribute('data-pv')) }
    })
    root.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.onclick = function () {
        const row = items.filter(function (r) { return r.id === btn.getAttribute('data-edit') })[0]
        if (row) openFinEditPayment(row, function () { finReload('payments') })
      }
    })
    root.querySelectorAll('[data-ok]').forEach(function (btn) {
      btn.onclick = async function () {
        btn.disabled = true
        try {
          await api('payment.feeConfirm', { id: btn.getAttribute('data-ok'), note: '' })
          toast('服务费已确认到账')
          finReload('payments')
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      }
    })
    root.querySelectorAll('[data-back]').forEach(function (btn) {
      btn.onclick = async function () {
        const ok = await confirm({ title: '确认退款', message: '退款后该笔收款标记为已退款，会员时长不会自动扣回，请人工核对。', okText: '确认退款', danger: true })
        if (!ok) return
        try {
          await api('payment.refund', { id: btn.getAttribute('data-back'), reason: '后台退款' })
          toast('已标记退款')
          finReload('payments')
        } catch (err) { toast(err.message, 'err') }
      }
    })
  }

  /* ---------------- 提现台账：审核 → 领取 → 打款回填，全状态可查 ---------------- */
  async function renderFinWithdrawals(root) {
    const data = await api('promote.withdrawList', {
      status: FIN.withdraw.status,
      q: FIN.withdraw.keyword,
      page: FIN.withdraw.page,
      limit: FIN.withdraw.limit
    })
    const items = data.items || []
    const pageNet = items.reduce(function (sum, w) {
      return sum + (w.status === '已到账' ? Number(w.net || 0) : 0)
    }, 0)
    root.innerHTML = card('提现台账',
      '<div class="filters">' +
      '<div class="field"><label>状态</label><select id="fw-status">' +
        options(['待审核', '待打款', '打款中', '打款失败', '已到账', '已驳回', '已撤销'], FIN.withdraw.status) +
        '</select></div>' +
      '<div class="field"><label>关键词</label><input id="fw-kw" placeholder="提现单号 / 昵称 / 用户ID" value="' + esc(FIN.withdraw.keyword) + '"></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn" id="fw-search">' + icon('search') + '<span>查询</span></button></div>' +
      '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:10px">共 ' + num(data.total) + ' 笔 · 本页已到账净额 ' + money(pageNet) + '</div>' +
      table(['用户', '提现金额', '手续费 / 税 / 净额', '收款银行卡', '状态', '单据 / 凭证', '申请时间', '操作'], items.map(function (w) {
        const payable = finPayableOf(w)
        return '<td><div class="strong">' + esc(w.nick || '—') + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(w.userNo || w.uid) + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(w.id) + '</div></td>' +
          '<td class="mono strong">' + money(w.amount) + '</td>' +
          '<td class="small"><div class="mono">' + money(w.fee) + ' / ' + money(w.tax) + '</div>' +
            '<div class="mono strong">' + money(payable) + '</div></td>' +
          '<td class="small"><div>' + esc(w.bankHolder || '未填写持卡人') + '</div>' +
            '<div>' + esc(w.bankName || '未填写开户行') + '</div>' +
            '<div class="mono">' + esc(w.bankAccount || w.bankAccountMasked || '未登记卡号') + '</div></td>' +
          '<td>' + autoBadge(w.status) + (w.overdue ? '<div class="small" style="color:var(--danger)">已超时</div>' : '') +
            (w.failReason ? '<div class="small" style="color:var(--danger)">' + esc(w.failReason) + '</div>' : '') + '</td>' +
          '<td class="small">' + (w.payoutNo ? '<div class="mono">' + esc(w.payoutNo) + '</div>' : '') +
            (w.checkedBy ? '<div>复核：' + esc(w.checkedBy) + '</div>' : '') +
            (w.voucherUrl ? '<button class="btn xs ghost" data-wpv="' + esc(w.voucherUrl) + '">' + icon('eye') + '<span>凭证</span></button>' : '') +
            (w.note ? '<div style="color:var(--muted-2)">' + esc(w.note) + '</div>' : '') + '</td>' +
          '<td class="small">' + esc(dateText(w.applyAt)) +
            (w.paidAt ? '<div style="color:var(--muted-2)">到账 ' + esc(dateText(w.paidAt)) + '</div>' : '') + '</td>' +
          '<td>' + finWithdrawActions(w) + '</td>'
      }), '暂无提现记录') + pager(data.total, data.page || FIN.withdraw.page, data.limit || FIN.withdraw.limit),
      '<span class="small">流程：推广者申请 → 客服 / 财务审核 → 财务领取并打款 → 上传凭证回填；打款金额必须与净额（扣除已冲正佣金）一致。</span>')

    root.querySelector('#fw-search').onclick = function () {
      FIN.withdraw.status = root.querySelector('#fw-status').value
      FIN.withdraw.keyword = root.querySelector('#fw-kw').value.trim()
      FIN.withdraw.page = 1
      finReload('withdrawals')
    }
    root.querySelector('#fw-kw').onkeydown = function (e) {
      if (e.key === 'Enter') root.querySelector('#fw-search').click()
    }
    wirePager(root, function (page) {
      FIN.withdraw.page = page
      finReload('withdrawals')
    })
    root.querySelectorAll('[data-wpv]').forEach(function (btn) {
      btn.onclick = function () { previewImage(btn.getAttribute('data-wpv')) }
    })
    root.querySelectorAll('[data-wact]').forEach(function (btn) {
      btn.onclick = function () {
        const w = items.filter(function (row) { return row.id === btn.getAttribute('data-id') })[0]
        const act = btn.getAttribute('data-wact')
        if (!w) return
        if (act === 'approve') finApproveWithdraw(w)
        else if (act === 'reject') finRejectWithdraw(w)
        else if (act === 'claim') finClaimWithdraw(w)
        else if (act === 'payout') openFinPayout(w, function () { finReload('withdrawals') })
        else if (act === 'fail') finFailWithdraw(w)
        else if (act === 'cancel') finCancelWithdraw(w)
      }
    })
  }

  function finWithdrawActions(w) {
    const canApprove = C.can('promote.withdrawApprove')
    const canClaim = C.can('promote.payoutClaim')
    const canPayout = C.can('promote.payoutMark')
    if (w.status === '待审核' && canApprove) {
      return '<button class="btn xs primary" data-wact="approve" data-id="' + esc(w.id) + '">通过</button>' +
        '<button class="btn xs danger" data-wact="reject" data-id="' + esc(w.id) + '">驳回</button>'
    }
    if (w.status === '待打款' && canClaim) {
      return '<button class="btn xs primary" data-wact="claim" data-id="' + esc(w.id) + '">领取打款</button>'
    }
    if (w.status === '打款中') {
      return (canPayout ? '<button class="btn xs primary" data-wact="payout" data-id="' + esc(w.id) + '">回填打款</button>' : '') +
        (canPayout ? '<button class="btn xs danger" data-wact="fail" data-id="' + esc(w.id) + '">标记失败</button>' : '')
    }
    if (w.status === '打款失败' && canClaim) {
      return '<button class="btn xs" data-wact="claim" data-id="' + esc(w.id) + '">重新打款</button>' +
        '<button class="btn xs ghost" data-wact="cancel" data-id="' + esc(w.id) + '">退回余额</button>'
    }
    return '<span class="small" style="color:var(--muted-2)">' + (w.status === '已到账' ? '已完成' : '—') + '</span>'
  }

  async function finApproveWithdraw(w) {
    const ok = await confirm({
      title: '通过提现申请',
      message: '确认提现单 ' + w.id + '（净额 ' + money(finPayableOf(w)) + '）信息无误？通过后进入待打款，由财务领取打款。',
      okText: '通过'
    })
    if (!ok) return
    try {
      await api('promote.withdrawApprove', { id: w.id })
      toast('已通过，等待财务打款')
      finReload('withdrawals')
    } catch (err) { toast(err.message, 'err') }
  }

  function finRejectWithdraw(w) {
    const m = modal({
      title: '驳回提现申请',
      sub: w.nick + ' · 净额 ' + money(finPayableOf(w)),
      body: field('驳回原因（会通知推广者）', '<textarea id="fr-reason" rows="3" maxlength="200" placeholder="例如：收款卡信息有误，请补全后重新申请"></textarea>'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="fr-ok">确认驳回</button>'
    })
    m.foot.querySelector('#fr-ok').onclick = async function () {
      const reason = m.body.querySelector('#fr-reason').value.trim()
      if (!reason) return toast('请填写驳回原因', 'err')
      try {
        await api('promote.withdrawReject', { id: w.id, reason })
        closeModal()
        toast('已驳回，金额已退回可提现余额')
        finReload('withdrawals')
      } catch (err) { toast(err.message, 'err') }
    }
  }

  async function finClaimWithdraw(w) {
    try {
      await api('promote.payoutClaim', { id: w.id })
      toast('已领取，请按银行卡打款后回填')
      finReload('withdrawals')
    } catch (err) { toast(err.message, 'err') }
  }

  function finFailWithdraw(w) {
    const m = modal({
      title: '登记打款失败',
      sub: w.nick + ' · 净额 ' + money(finPayableOf(w)),
      body: field('失败原因（会通知推广者，金额保留）', '<textarea id="ff-reason" rows="3" maxlength="200" placeholder="例如：银行卡号与户名不一致，银行退回"></textarea>'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="ff-ok">确认失败</button>'
    })
    m.foot.querySelector('#ff-ok').onclick = async function () {
      const reason = m.body.querySelector('#ff-reason').value.trim()
      if (!reason) return toast('请填写失败原因', 'err')
      try {
        await api('promote.payoutMark', { id: w.id, result: 'failed', failReason: reason })
        closeModal()
        toast('已登记失败，可重新打款')
        finReload('withdrawals')
      } catch (err) { toast(err.message, 'err') }
    }
  }

  async function finCancelWithdraw(w) {
    const ok = await confirm({
      title: '退回可提现余额',
      message: '退回后该提现单终止，净额 ' + money(finPayableOf(w)) + ' 回到推广者可提现余额，推广者需重新申请。',
      okText: '确认退回', danger: true
    })
    if (!ok) return
    try {
      await api('promote.payoutCancel', { id: w.id })
      toast('已退回余额')
      finReload('withdrawals')
    } catch (err) { toast(err.message, 'err') }
  }

  /* 打款回填：单据号 / 实际金额 / 凭证 / 复核人，金额必须与净额闭合 */
  function openFinPayout(w, done) {
    if (!w) return
    const payable = finPayableOf(w)
    const nowLocal = (function () {
      const d = new Date()
      const pad = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    })()
    const m = modal({
      title: '回填打款',
      sub: '提现单 ' + w.id + ' · 应付净额 ' + money(payable),
      wide: true,
      body:
        '<div class="setting-row" style="margin-bottom:12px"><div class="info">' +
          '<div class="small" style="color:var(--muted-2)">请按推广者登记的收款银行卡打款</div>' +
          '<div class="strong">' + esc(w.bankHolder || '未填写持卡人') + ' · ' + esc(w.bankName || '未填写开户行') + '</div>' +
          '<div class="mono strong" style="font-size:16px">' + esc(w.bankAccount || w.bankAccountMasked || '未登记卡号') + '</div>' +
          (w.bankReady === false ? '<div class="small" style="color:var(--danger)">该提现单未登记完整银行卡，请先让推广者补全后再回填</div>' : '') +
        '</div></div>' +
        field('出款单据号（银行流水号 / 分账单号，全局唯一）', '<input id="fp-no" placeholder="如 BANK-20261118-001">') +
        field('实际出款金额（元）', '<input id="fp-amount" type="number" step="0.01" min="0" value="' + payable.toFixed(2) + '">' +
          '<div class="small" style="color:var(--muted-2)">必须等于应付净额 ' + payable.toFixed(2) + ' 元；差额请走「退回余额」后重新申请。</div>') +
        field('打款凭证（截图）', '<div style="display:flex;gap:8px;align-items:center">' +
          '<input id="fp-voucher" placeholder="上传后自动填入" style="flex:1">' +
          '<button class="btn xs" id="fp-upload">' + icon('file') + '<span>上传</span></button>' +
          '<button class="btn xs ghost" id="fp-view" style="display:none">查看</button>' +
          '</div>') +
        field('出款时间', '<input id="fp-paid" type="datetime-local" value="' + nowLocal + '">') +
        field('复核人（≥ ¥5000 必填，且不能与审核人 / 执行人相同）', '<input id="fp-checker" placeholder="复核人姓名（账号名）">'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="fp-ok">确认已打款</button>'
    })
    const viewBtn = m.body.querySelector('#fp-view')
    m.body.querySelector('#fp-upload').onclick = async function () {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async function () {
        const file = input.files && input.files[0]
        if (!file) return
        try {
          const fileId = await mediaUpload(file)
          m.body.querySelector('#fp-voucher').value = fileId
          viewBtn.style.display = ''
          viewBtn.onclick = function () { previewImage(fileId) }
          toast('凭证已上传')
        } catch (err) { toast(err.message, 'err') }
      }
      input.click()
    }
    m.foot.querySelector('#fp-ok').onclick = async function () {
      const payoutNo = m.body.querySelector('#fp-no').value.trim()
      const amount = Number(m.body.querySelector('#fp-amount').value)
      const voucherUrl = m.body.querySelector('#fp-voucher').value.trim()
      const paidAt = m.body.querySelector('#fp-paid').value
      const checkedBy = m.body.querySelector('#fp-checker').value.trim()
      if (!payoutNo) return toast('请填写出款单据号', 'err')
      if (!voucherUrl) return toast('请上传打款凭证', 'err')
      if (!(amount > 0)) return toast('请填写实际出款金额', 'err')
      if (Math.abs(amount - payable) > 0.001) return toast('实际出款金额必须等于应付净额 ' + payable.toFixed(2) + ' 元', 'err')
      const btn = m.foot.querySelector('#fp-ok')
      btn.disabled = true
      try {
        await api('promote.payoutMark', {
          id: w.id,
          payoutNo,
          payoutAmount: amount,
          voucherUrl,
          checkedBy,
          payoutAt: paidAt ? new Date(paidAt).getTime() : undefined
        })
        closeModal()
        toast('已回填，提现单已完成')
        if (typeof done === 'function') done()
      } catch (err) { toast(err.message, 'err'); btn.disabled = false }
    }
  }

  /* ---------------- 佣金设置：客服绑定推广（两级）/ 普通推广（一级）+ 客服委托比例（仅管理员） ---------------- */
  async function renderFinRates(root) {
    const [pmRaw, csRaw] = await Promise.all([
      api('promote.settings', {}),
      api('cs.settings', {})
    ])
    const pm = (pmRaw && (pmRaw.settings || pmRaw)) || {}
    const cs = (csRaw && (csRaw.settings || csRaw)) || {}
    const l1 = Math.round(Number(pm.commissionRate === undefined ? 0.15 : pm.commissionRate) * 1000) / 10
    /* 客服绑定用户一级比例：老配置没有该字段时按一级比例展示，避免出现 0 */
    const csL1 = Math.round(Number(pm.csLevel1Rate === undefined ? (pm.commissionRate === undefined ? 0.15 : pm.commissionRate) : pm.csLevel1Rate) * 1000) / 10
    const l2 = Math.round(Number(pm.level2Rate === undefined ? 0.15 : pm.level2Rate) * 1000) / 10
    const agency = Math.round(Number(cs.agencyRate === undefined ? 0.2 : cs.agencyRate) * 1000) / 10
    /* 区间取平台配置的最低 / 最高比例，避免表单允许的区间与服务端校验不一致 */
    const rateMin = Math.round(Number(pm.rateMin === undefined ? 0.05 : pm.rateMin) * 1000) / 10
    const rateMax = Math.round(Number(pm.rateMax === undefined ? 0.3 : pm.rateMax) * 1000) / 10
    const rateHint = '可设 ' + rateMin + '%–' + rateMax + '%'
    const agencyMin = Math.round(Number(cs.agencyRateMin === undefined ? 0 : cs.agencyRateMin) * 100)
    const agencyMax = Math.round(Number(cs.agencyRateMax === undefined ? 0.5 : cs.agencyRateMax) * 100)
    const rateInput = function (id, label, value, min, max, hint) {
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<div class="flex" style="gap:6px;align-items:center">' +
        '<input id="' + id + '" type="number" min="' + min + '" max="' + max + '" step="0.5" value="' + value + '" style="max-width:120px">' +
        '<span class="small">%</span></div>' +
        (hint ? '<div class="small" style="color:var(--muted-2);margin-top:4px">' + esc(hint) + '</div>' : '') + '</div>'
    }
    root.innerHTML =
      '<div class="grid g2" style="align-items:start">' +
      card('客服绑定用户推广（两级佣金）',
        '<div class="small" style="color:var(--muted-2);margin-bottom:12px">客服绑定的推广账号可拿两级：其直接下级首次付款计一级，下级的直接下级首次付款计二级。两级比例在这里分开设置，与普通推广互不影响。</div>' +
        rateInput('fr-cs-l1', '一级佣金比例（客服绑定）', csL1, rateMin, rateMax, '默认 15%，' + rateHint) +
        rateInput('fr-l2', '二级佣金比例（客服绑定）', l2, rateMin, rateMax, '默认 15%，' + rateHint) +
        '<div style="margin-top:14px"><button class="btn primary" id="fr-save-cs">' + icon('check') + '<span>保存客服绑定推广比例</span></button></div>',
        '<span class="small">对应动作 promote.saveSettings</span>') +
      card('普通用户推广（仅一级佣金）',
        '<div class="small" style="color:var(--muted-2);margin-bottom:12px">未绑定客服的推广人（含商机会员）只有一级佣金：其直接下级首次付款按这里的比例计佣，没有二级。调整只影响之后新产生的佣金，已计提佣金不变。</div>' +
        rateInput('fr-l1', '一级佣金比例（普通推广）', l1, rateMin, rateMax, '默认 15%，' + rateHint) +
        '<div class="small" style="color:var(--muted-2);margin-top:10px">普通推广人无二级佣金，二级比例不适用。</div>' +
        '<div style="margin-top:14px"><button class="btn primary" id="fr-save-promote">' + icon('check') + '<span>保存普通推广比例</span></button></div>',
        '<span class="small">对应动作 promote.saveSettings</span>') +
      '</div>' +
      '<div class="grid g2" style="align-items:start;margin-top:14px">' +
      card('客服委托佣金比例',
        '<div class="small" style="color:var(--muted-2);margin-bottom:12px">代采 / 代售服务费实收 × 比例计入客服工资。单个客服的专属比例在「客服业务」页设置，优先于此处全局默认。</div>' +
        rateInput('fr-agency', '全局委托佣金比例', agency, agencyMin, agencyMax, '默认 20%，可设 ' + agencyMin + '%–' + agencyMax + '%；绑定即锁定') +
        '<div style="margin-top:14px"><button class="btn primary" id="fr-save-agency">' + icon('check') + '<span>保存委托比例</span></button></div>',
        '<span class="small">对应动作 cs.saveSettings</span>') +
      card('收入与支出口径', kvList([
        ['会员开通收入', '会员订单实收（微信支付 / 手动开通 / Apple 内购），计入总营收，资金总览可按业务类型与渠道查看'],
        ['委托服务费收入', '代采 / 代售 / 租赁服务费到账（财务确认）后计入总营收，可在收款入账台账逐笔查看、修改备注与凭证'],
        ['客服绑定推广佣金', '一级 + 二级两笔计提，进佣金台账，可查可审核；退款自动冲正'],
        ['普通推广佣金', '仅一级计提，进佣金台账；退款自动冲正'],
        ['客服委托佣金', '按委托比例计提，进客服工资与佣金台账，退款冲正']
      ])) +
      '</div>'
    /* 两张卡各存各的，但都提交完整三项，避免把另一组的比例改回默认 */
    const savePromote = function (btn, tip) {
      btn.onclick = async function () {
        btn.disabled = true
        try {
          await api('promote.saveSettings', {
            commissionRate: Number(root.querySelector('#fr-l1').value) / 100,
            csLevel1Rate: Number(root.querySelector('#fr-cs-l1').value) / 100,
            level2Rate: Number(root.querySelector('#fr-l2').value) / 100
          })
          toast(tip)
          finReload('rates')
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      }
    }
    savePromote(root.querySelector('#fr-save-promote'), '普通推广佣金比例已更新')
    savePromote(root.querySelector('#fr-save-cs'), '客服绑定推广佣金比例已更新')
    const aBtn = root.querySelector('#fr-save-agency')
    aBtn.onclick = async function () {
      aBtn.disabled = true
      try {
        await api('cs.saveSettings', { agencyRate: Number(root.querySelector('#fr-agency').value) / 100 })
        toast('客服委托佣金比例已更新')
        finReload('rates')
      } catch (err) { toast(err.message, 'err'); aBtn.disabled = false }
    }
  }

  /* ---------------- 佣金台账：客服委托 / 推广者，两种口径合并查询 ---------------- */
  async function renderFinCommissions(root) {
    const data = await api('finance.commissions', {
      month: FIN.commission.month,
      type: FIN.commission.type,
      keyword: FIN.commission.keyword,
      page: FIN.commission.page,
      limit: FIN.commission.limit
    })
    const items = data.items || []
    const totals = data.totals || {}
    root.innerHTML = card('佣金台账',
      '<div class="filters">' +
      '<div class="field"><label>月份</label><select id="fc-month">' + options(finMonthList(), FIN.commission.month) + '</select></div>' +
      '<div class="field"><label>类型</label><select id="fc-type">' +
        options([{ value: '', label: '全部类型' }].concat((data.types || []).map(function (t) { return { value: t, label: t } })), FIN.commission.type) +
        '</select></div>' +
      '<div class="field"><label>关键词</label><input id="fc-kw" placeholder="客服 / 用户 / 记录号" value="' + esc(FIN.commission.keyword) + '"></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn" id="fc-search">' + icon('search') + '<span>查询</span></button></div>' +
      '</div>' +
      '<div class="grid g3" style="margin-bottom:12px">' +
      kpi('筛选合计', money(totals.all), num(totals.count) + ' 条计提记录') +
      kpi('客服委托佣金', money(totals.csAgency), '进客服工资') +
      kpi('推广者佣金', money(totals.promoter), '进推广者余额') +
      '</div>' +
      table(['月份', '类型', '归属', '用户', '计提基数', '比例', '佣金', '状态', '时间'], items.map(function (r) {
        return '<td>' + esc(r.month || '—') + '</td>' +
          '<td>' + badge(r.type, r.type === '推广佣金' ? 'warn' : 'ok', true) + '</td>' +
          '<td class="strong">' + esc(r.staffName || r.staffId || '—') + '</td>' +
          '<td class="small"><div>' + esc(r.userLabel || r.uid || '—') + '</div>' +
            (r.bizLabel ? '<div style="color:var(--muted-2)">' + esc(r.bizLabel) + '</div>' : '') + '</td>' +
          '<td class="mono">' + money(r.base) + '</td>' +
          '<td class="small">' + esc(r.rateText || '—') + '</td>' +
          '<td class="mono strong">' + money(r.amount) + '</td>' +
          '<td>' + autoBadge(r.status || '已计提') + '</td>' +
          '<td class="small">' + esc(r.paidText || '—') + '</td>'
      }), '该条件下暂无佣金记录') + pager(data.total, data.page || FIN.commission.page, data.limit || FIN.commission.limit),
      '<span class="small">比例在客服绑定账号时锁定，之后调价不追溯；佣金按自然月汇入客服工资 / 推广者余额，退款会冲正对应佣金。</span>')

    root.querySelector('#fc-search').onclick = function () {
      FIN.commission.month = root.querySelector('#fc-month').value
      FIN.commission.type = root.querySelector('#fc-type').value
      FIN.commission.keyword = root.querySelector('#fc-kw').value.trim()
      FIN.commission.page = 1
      finReload('commissions')
    }
    root.querySelector('#fc-kw').onkeydown = function (e) {
      if (e.key === 'Enter') root.querySelector('#fc-search').click()
    }
    wirePager(root, function (page) {
      FIN.commission.page = page
      finReload('commissions')
    })
  }

  /* 编辑收款记录：只改备注与凭证，金额与状态不可改，全部留审计 */
  function openFinEditPayment(row, done) {
    const m = modal({
      title: '编辑入账记录',
      sub: (row.bizType || '') + ' · ' + (row.nick || row.uid) + ' · 实收 ' + money(row.received) + ' · ' + row.paidText,
      body: field('入账说明', '<textarea id="fe-note" rows="3" maxlength="200" placeholder="例如：对公转账尾号 8899，已与银行流水核对">' + esc(row.note || '') + '</textarea>') +
        field('回款凭证', '<div style="display:flex;gap:8px;align-items:center">' +
          '<input id="fe-voucher" placeholder="上传后自动填入" value="' + esc(row.voucher || '') + '" style="flex:1">' +
          '<button class="btn xs" id="fe-upload">' + icon('file') + '<span>上传</span></button>' +
          '<button class="btn xs ghost" id="fe-view" style="display:' + (row.voucher ? '' : 'none') + '">查看</button>' +
          '</div>'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="fe-ok">保存</button>'
    })
    const viewBtn = m.body.querySelector('#fe-view')
    if (row.voucher) viewBtn.onclick = function () { previewImage(row.voucher) }
    m.body.querySelector('#fe-upload').onclick = function () {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async function () {
        const file = input.files && input.files[0]
        if (!file) return
        try {
          const fileId = await mediaUpload(file)
          m.body.querySelector('#fe-voucher').value = fileId
          viewBtn.style.display = ''
          viewBtn.onclick = function () { previewImage(fileId) }
          toast('凭证已上传')
        } catch (err) { toast(err.message, 'err') }
      }
      input.click()
    }
    m.foot.querySelector('#fe-ok').onclick = async function () {
      const note = m.body.querySelector('#fe-note').value.trim()
      const voucher = m.body.querySelector('#fe-voucher').value.trim()
      if (!note) return toast('请填写入账说明', 'err')
      try {
        await api('payment.updateNote', { id: row.id, note, voucher })
        closeModal()
        toast('已保存')
        if (typeof done === 'function') done()
      } catch (err) { toast(err.message, 'err') }
    }
  }

  /* 补录线下收入：固定「其他」类型，直接记已确认，需要说明与凭证 */
  function openFinManualPayment(done) {
    const m = modal({
      title: '补录入账',
      sub: '仅用于微信支付之外的线下收入（对公转账 / 现金等），补录后直接计入收款台账',
      wide: true,
      body: '<div style="margin-bottom:12px">' + userQuery('mp', '搜索并选择付款用户（昵称 / 手机号 / 用户ID）') + '</div>' +
        field('入账金额（元）', '<input id="mp-amount" type="number" step="0.01" min="0" placeholder="0.00">') +
        field('收款方式', '<select id="mp-method">' + options(PAY_METHOD_FALLBACK, '对公转账') + '</select>') +
        field('收款时间', '<input id="mp-paid" type="datetime-local" value="' + (function () {
          const d = new Date()
          const pad = function (n) { return String(n).padStart(2, '0') }
          return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
        })() + '">') +
        field('入账说明', '<textarea id="mp-note" rows="2" maxlength="200" placeholder="例如：XX 公司代采服务费尾款，合同号 2026-118"></textarea>') +
        field('回款凭证', '<div style="display:flex;gap:8px;align-items:center">' +
          '<input id="mp-voucher" placeholder="上传后自动填入" style="flex:1">' +
          '<button class="btn xs" id="mp-upload">' + icon('file') + '<span>上传</span></button>' +
          '<button class="btn xs ghost" id="mp-view" style="display:none">查看</button>' +
          '</div>'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="mp-ok">确认入账</button>'
    })
    let picked = null
    wireUserQuery(m.body, 'mp', function (user) { picked = user })
    const viewBtn = m.body.querySelector('#mp-view')
    m.body.querySelector('#mp-upload').onclick = function () {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async function () {
        const file = input.files && input.files[0]
        if (!file) return
        try {
          const fileId = await mediaUpload(file)
          m.body.querySelector('#mp-voucher').value = fileId
          viewBtn.style.display = ''
          viewBtn.onclick = function () { previewImage(fileId) }
          toast('凭证已上传')
        } catch (err) { toast(err.message, 'err') }
      }
      input.click()
    }
    m.foot.querySelector('#mp-ok').onclick = async function () {
      if (!picked) return toast('请先搜索并选择付款用户', 'err')
      const amount = Number(m.body.querySelector('#mp-amount').value)
      const note = m.body.querySelector('#mp-note').value.trim()
      const method = m.body.querySelector('#mp-method').value
      const voucher = m.body.querySelector('#mp-voucher').value.trim()
      const paid = m.body.querySelector('#mp-paid').value
      if (!(amount > 0)) return toast('请填写入账金额', 'err')
      if (!note) return toast('请填写入账说明', 'err')
      const btn = m.foot.querySelector('#mp-ok')
      btn.disabled = true
      try {
        await api('payment.manual', {
          uid: picked.id,
          amount,
          method,
          note,
          voucher,
          paidAt: paid ? new Date(paid).getTime() : undefined
        })
        closeModal()
        toast('补录成功')
        if (typeof done === 'function') done()
      } catch (err) { toast(err.message, 'err'); btn.disabled = false }
    }
  }

  /* 用户发起的退款申请：财务核对后通过即执行退款并停用会员权限，驳回必须写原因 */
  function renderRefundQueue(root, data) {
    if (!root) return
    const items = data.items || []
    const counts = data.counts || {}
    const statusList = data.statusList || []

    root.innerHTML = card('退款申请',
      '<div class="filters">' +
      '<div class="field"><label>处理状态</label><select id="rf-status">' + options(statusList, REFUND_FILTER.status) + '</select></div>' +
      '<div class="field"><label>关键词</label><input id="rf-q" placeholder="用户 / 原因 / 业务" value="' + esc(REFUND_FILTER.q) + '"></div>' +
      '<div class="field" style="justify-content:flex-end"><button class="btn" id="rf-search">' + icon('search') + '<span>查询</span></button></div>' +
      '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:10px">待处理 ' + num(counts['待处理']) + ' · 已通过 ' + num(counts['已通过']) +
      ' · 已驳回 ' + num(counts['已驳回']) + ' · 已撤销 ' + num(counts['已撤销']) + '</div>' +
      table(['用户', '业务 / 金额', '退款原因', '收款单状态', '申请时间', '处理状态', '操作'], items.map(function (r) {
        return '<td><div class="strong">' + esc(r.nick) + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.uid) + '</div></td>' +
          '<td>' + esc(r.bizType || '—') + '<div class="mono strong">' + money(r.amount) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + esc(r.paymentId) + '</div></td>' +
          '<td class="small" style="max-width:220px">' + esc(r.reason) + '</td>' +
          '<td>' + autoBadge(r.paymentStatus || '—') + '</td>' +
          '<td class="small">' + esc(r.createdAt ? dateText(r.createdAt) : '—') + '</td>' +
          '<td>' + autoBadge(r.status) +
          (r.handlerNote ? '<div class="small" style="color:var(--muted-2)">' + esc(r.handlerNote) + '</div>' : '') + '</td>' +
          '<td>' + (r.status === '待处理'
            ? '<button class="btn xs primary" data-rf-ok="' + esc(r.id) + '" data-rf-amount="' + num(r.amount) + '">通过并退款</button>' +
              '<button class="btn xs" data-rf-no="' + esc(r.id) + '" style="margin-left:6px">驳回</button>'
            : '<span class="small" style="color:var(--muted-2)">' + esc(r.handledBy || '已处理') + '</span>') + '</td>'
      }), '暂无退款申请'),
      '<span class="small" style="color:var(--muted-2)">通过后立即标记收款单退款并停用对应会员权限</span>') +
      pager(data.total, data.page || REFUND_FILTER.page, data.limit || REFUND_FILTER.limit)

    root.querySelector('#rf-search').onclick = function () {
      REFUND_FILTER.status = root.querySelector('#rf-status').value
      REFUND_FILTER.q = root.querySelector('#rf-q').value.trim()
      REFUND_FILTER.page = 1
      Pages.finance(document.getElementById('view'))
    }
    root.querySelector('#rf-q').onkeydown = function (e) {
      if (e.key === 'Enter') root.querySelector('#rf-search').click()
    }
    wirePager(root, function (page) {
      REFUND_FILTER.page = page
      Pages.finance(document.getElementById('view'))
    })
    root.querySelectorAll('[data-rf-ok]').forEach(function (btn) {
      btn.onclick = async function () {
        const ok = await confirm({
          title: '通过退款申请',
          message: '将把该笔 ' + money(btn.getAttribute('data-rf-amount')) + ' 标记为已退款，并停用对应会员权限。确认已实际退回款项？',
          okText: '确认通过',
          danger: true
        })
        if (!ok) return
        btn.disabled = true
        try {
          await api('refund.handle', { id: btn.getAttribute('data-rf-ok'), decision: '已通过', note: '' })
          toast('已通过，退款已生效')
          Pages.finance(document.getElementById('view'))
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      }
    })
    root.querySelectorAll('[data-rf-no]').forEach(function (btn) {
      btn.onclick = function () {
        const m = modal({
          title: '驳回退款申请',
          sub: '驳回原因会通过站内信发给用户，请写清楚依据',
          body: field('驳回原因', '<textarea id="rf-note" rows="3" maxlength="200" placeholder="例如：会员权益已使用 / 已超过退款期限"></textarea>'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="rf-submit">确认驳回</button>'
        })
        if (!m) return
        m.querySelector('#rf-submit').onclick = async function () {
          const note = m.querySelector('#rf-note').value.trim()
          if (!note) { toast('请填写驳回原因', 'err'); return }
          this.disabled = true
          try {
            await api('refund.handle', { id: btn.getAttribute('data-rf-no'), decision: '已驳回', note: note })
            closeModal()
            toast('已驳回并通知用户')
            Pages.finance(document.getElementById('view'))
          } catch (err) { toast(err.message, 'err'); this.disabled = false }
        }
      }
    })
  }

  /* ---------------- 8. 消息中心 ---------------- */

  /* 直聊处置：警告会向双方各发一条系统提醒，转风险单进入风险池 */
  function directDispose(threadId, action) {
    const m = modal({
      title: action === '警告' ? '警告会话双方' : '转风险单',
      sub: action === '警告' ? '处置说明会作为系统提醒发给双方，并记入审计' : '处置说明会进入风险池待跟进，并记入审计',
      body: field('处置说明', '<textarea id="dh-note" rows="3" maxlength="200" placeholder="说明违规点，例如：引导线下转账 / 发送手机号"></textarea>'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="dh-ok">确定</button>'
    })
    if (!m) return
    m.querySelector('#dh-ok').onclick = async function () {
      const note = m.querySelector('#dh-note').value.trim()
      if (note.length < 2) { toast('请填写处置说明', 'err'); return }
      this.disabled = true
      try {
        await api('msg.directHandle', { threadId: threadId, action: action, note: note })
        closeModal()
        toast(action === '警告' ? '已向双方发送警告' : '已转入风险池')
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  /** 用户之间直聊的监管面板：会话列表 + 完整聊天记录 + 处置，消息中心使用 */
  async function renderDirectPanel(host) {
    host.innerHTML = loadingBlock('加载直聊会话')
    try {
      const data = await api('msg.directThreads', {})
      const threads = data.items || []
      MSG_BOX.directItems = threads
      MSG_BOX.direct = threads.length
      MSG_BOX.directUnread = Number(data.unread) || 0
      if (!threads.length) {
        host.innerHTML = emptyState('暂无用户直聊', '用户之间发起直聊后，会话与聊天记录会自动进入这里')
        return
      }
      host.innerHTML = '<div class="chat-layout"><div class="thread-list" id="d-threads">' +
        threads.map(function (t, i) {
          const active = MSG_BOX.directThread ? t.threadId === MSG_BOX.directThread : i === 0
          return '<div class="thread' + (active ? ' on' : '') + '" data-dthread="' + esc(t.threadId) + '">' +
            '<div class="t">' + esc(t.title || t.userNames || t.threadId) +
            (t.unread ? ' <span class="badge danger">' + num(t.unread) + '</span>' : '') + '</div>' +
            '<div class="s">' + esc(t.lastBody || '') + '</div>' +
            '<div class="m"><span>' + num(t.total) + ' 条</span><span>' + esc(t.lastText || '') + '</span></div></div>'
        }).join('') + '</div><div class="chat-panel" id="d-chat">' + loadingBlock('加载会话') + '</div></div>'

      async function openThread(threadId) {
        const panelEl = host.querySelector('#d-chat')
        panelEl.innerHTML = loadingBlock('加载会话')
        try {
          const detail = await api('msg.directThread', { threadId: threadId })
          const items = detail.items || []
          panelEl.innerHTML = '<div class="chat-note">直聊内容已脱敏展示：手机号、证件号中间位已隐藏，仅用于风险核查。图片消息可直接查看，名片消息展示对方向会话公开的主体信息。</div>' +
            '<div class="chat-stream">' + (items.length ? items.map(function (m) {
              const who = m.senderName || m.from || ''
              const kind = m.kind || 'text'
              let content = '<div class="body">' + esc(m.body || '') + '</div>'
              if (kind === 'image' || kind === 'video') {
                /* 直聊与客服会话共用媒体渲染：图片可放大、视频可播放，过期显示占位 */
                content = msgContentHtml(m, null)
              } else if (kind === 'card') {
                const c = m.card || {}
                content = '<div class="chat-card">' +
                  '<div class="cc-av">' + esc(c.avatar || String(c.name || '名').slice(0, 1)) + '</div>' +
                  '<div class="cc-body"><div class="cc-nm">' + esc(c.name || '平台用户') + '</div>' +
                  (c.subject ? '<div class="cc-sub">' + esc(c.subject) + '</div>' : '') +
                  '<div class="cc-meta">' + esc(c.city || '') + '</div></div>' +
                  '<span class="cc-tag">名片</span></div>'
              }
              return '<div class="chat-bubble"><div class="meta">' + esc(who) + ' · ' + esc(m.atText || dateText(m.at)) + '</div>' + content + '</div>'
            }).join('') : emptyState('会话暂无内容')) + '</div>' +
            '<div class="flex" style="gap:8px;margin-top:12px">' +
            '<button class="btn xs" data-dw="' + esc(threadId) + '">警告双方</button>' +
            '<button class="btn xs danger" data-df="' + esc(threadId) + '">转风险单</button>' +
            '<span class="small grow" style="color:var(--muted-2);align-self:center">警告会给双方各发一条系统提醒；转风险单进入风险池待跟进</span>' +
            '</div>'
          mediaBind(panelEl)
          panelEl.querySelector('[data-dw]').onclick = function () { directDispose(threadId, '警告') }
          panelEl.querySelector('[data-df]').onclick = function () { directDispose(threadId, '转风险单') }
        } catch (err) {
          panelEl.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
        }
      }

      host.querySelectorAll('[data-dthread]').forEach(function (el) {
        el.onclick = function () {
          host.querySelectorAll('[data-dthread]').forEach(function (x) { x.classList.remove('on') })
          el.classList.add('on')
          const threadId = el.getAttribute('data-dthread')
          MSG_BOX.directThread = threadId
          /* 主动点击直聊会话才标记已读；自动打开/轮询不清零 */
          markDirectThreadRead(threadId, el)
          openThread(threadId)
        }
      })
      /* 轮询重绘后保持原来选中的会话 */
      const keep = threads.some(function (t) { return t.threadId === MSG_BOX.directThread })
      openThread(keep ? MSG_BOX.directThread : threads[0].threadId)
      if (!keep) MSG_BOX.directThread = threads[0].threadId
    } catch (err) {
      host.innerHTML = '<div class="card card-body" style="color:var(--danger)">' + esc(err.message) + '</div>'
    }
  }

  const MSG_BOX = {
    q: '', uid: '', threads: [], unread: 0,
    tab: 'kf',
    direct: 0, directUnread: 0, directItems: [], directThread: '',
    draft: '', scrollTop: null, scrollUid: ''
  }
  let msgPollTimer = null
  let msgPollSig = ''

  /* 消息中心自动刷新：每 10 秒对比一次会话摘要，有变化才重绘，避免打断正在输入的回复 */
  function msgStopPoll() {
    if (msgPollTimer) {
      clearInterval(msgPollTimer)
      if (window.__pageTimer === msgPollTimer) window.__pageTimer = null
      msgPollTimer = null
    }
  }

  /* 离开消息页就清空当前会话，避免下次进入时把残留会话的未读直接当成已读 */
  C.onAfterRender = function (page) {
    /* 离开工单台 / 工单中心后停止轮询，进入对应页面时会重新启动 */
    if (page !== 'workbench' && page !== 'consult') cfStopPoll()
    if (page === 'messages') return
    msgStopPoll()
    MSG_BOX.uid = ''
    MSG_BOX.draft = ''
    MSG_BOX.q = ''
    MSG_BOX.tab = 'kf'
    MSG_BOX.directThread = ''
    MSG_BOX.scrollTop = null
    MSG_BOX.scrollUid = ''
    msgPollSig = ''
  }

  /* 侧栏「消息中心」角标同步真实未读数，不必等下一轮 60 秒轮询 */
  function msgPaintNav() {
    const el = document.querySelector('[data-badge="messages"]')
    if (!el) return
    const n = Number(MSG_BOX.unread) || 0
    el.hidden = n <= 0
    el.textContent = n > 999 ? '999+' : String(n)
  }

  /* 只有用户主动点击会话或点「标为已读」才调用 msg.read；自动刷新绝不清零 */
  function markThreadRead(uid) {
    const thread = MSG_BOX.threads.find(function (t) { return t.uid === uid })
    if (!thread || !thread.unread) return
    const n = Number(thread.unread) || 0
    thread.unread = 0
    MSG_BOX.unread = Math.max(0, Number(MSG_BOX.unread) - n)
    msgPaintNav()
    api('msg.read', { uid: uid }).catch(function () {})
  }

  /* 直聊未读：同样只有用户点击会话才清零并落库 */
  function markDirectThreadRead(threadId, el) {
    const thread = (MSG_BOX.directItems || []).find(function (t) { return t.threadId === threadId })
    if (!thread || !thread.unread) return
    const n = Number(thread.unread) || 0
    thread.unread = 0
    MSG_BOX.directUnread = Math.max(0, Number(MSG_BOX.directUnread) - n)
    if (el) {
      const b = el.querySelector('.t .badge')
      if (b) b.remove()
    }
    const tab = document.querySelector('#msg-tabs [data-mtab="direct"]')
    if (tab) tab.textContent = '用户直聊 ' + num(MSG_BOX.direct) + (MSG_BOX.directUnread ? ' · 未读 ' + num(MSG_BOX.directUnread) : '')
    api('msg.read', { threadId: threadId }).catch(function () {})
  }

  function msgSig(threads, unread, direct, directUnread) {
    return [unread, direct, directUnread].join('|') + '|' + threads.map(function (t) {
      return [t.uid, t.lastAt, t.lastBody, t.unread].join('~')
    }).join('|')
  }

  function msgStartPoll(view) {
    msgStopPoll()
    msgPollTimer = setInterval(function () {
      const key = (location.hash || '').replace(/^#\/?/, '')
      if (!view.querySelector('#msg-body') || (key && key !== 'messages')) { msgStopPoll(); return }
      pollMessages(view)
    }, 10000)
    window.__pageTimer = msgPollTimer
  }

  async function pollMessages(view) {
    const body = view.querySelector('#msg-body')
    if (!body) { msgStopPoll(); return }
    let data
    try {
      data = await api('msg.threads', {})
    } catch (err) {
      return
    }
    const threads = data.items || []
    const unread = Number(data.unread) || 0
    let direct = MSG_BOX.direct
    let directUnread = MSG_BOX.directUnread
    if (C.can('msg.directThreads')) {
      try {
        const d = await api('msg.directThreads', {})
        MSG_BOX.directItems = d.items || []
        direct = MSG_BOX.directItems.length
        directUnread = Number(d.unread) || 0
      } catch (err) { /* 直聊统计失败不影响用户留言刷新 */ }
    }
    /* 当前打开的会话单独取一次消息指纹：避免会话摘要未变时新消息不显示 */
    let openSig = ''
    if (MSG_BOX.uid) {
      try {
        const res = await api('msg.list', { uid: MSG_BOX.uid, page: 1, limit: 30 })
        const list = res.items || []
        const last = list[list.length - 1] || {}
        openSig = list.length + '|' + (last.id || '') + '|' + (last.createdAt || '')
      } catch (err) { openSig = 'err' }
    }
    const sig = msgSig(threads, unread, direct, directUnread) + '|' + (MSG_BOX.uid || '') + '|' + openSig
    if (sig === msgPollSig) return
    msgPollSig = sig
    MSG_BOX.threads = threads
    MSG_BOX.unread = unread
    MSG_BOX.direct = direct
    MSG_BOX.directUnread = directUnread
    msgPaintNav()
    /* 重绘前保留未提交的搜索词与回复草稿；当前选中的会话保持不变 */
    const qEl = body.querySelector('#msg-q')
    const qVal = qEl ? qEl.value : ''
    const draftEl = body.querySelector('#msg-reply')
    MSG_BOX.draft = draftEl ? draftEl.value : ''
    /* 记录当前会话的滚动位置，重绘后恢复，避免静默刷新把阅读位置拉回底部 */
    const streamEl = body.querySelector('#msg-stream')
    if (streamEl) {
      MSG_BOX.scrollTop = streamEl.scrollTop
      MSG_BOX.scrollUid = MSG_BOX.uid
    }
    renderMsgShell(body)
    const qBox = body.querySelector('#msg-q')
    if (qBox && qVal) qBox.value = qVal
  }

  /* 切回前台 / 窗口聚焦时立即拉一次：后台期间定时器被浏览器节流，不能干等下一轮 */
  C.msgPollNow = function () {
    const view = document.getElementById('view')
    if (!view || !view.querySelector('#msg-body')) return
    const key = (location.hash || '').replace(/^#\/?/, '')
    if (key && key !== 'messages') return
    pollMessages(view)
  }

  /* 切回前台时工单台也立即补一次，避免后台节流导致工单与消息延迟 */
  C.cfPollNow = function () {
    if (document.getElementById('cf-body')) cfAutoRefresh()
  }

  /* ---------------- 推广管理（人工分账交付版） ---------------- */
  const PROMOTE_TABS = [
    ['promoters', '推广者'], ['commissions', '佣金明细'], ['withdraw', '提现审核'],
    ['payout', '待打款'], ['items', '出款明细'], ['rules', '规则与对账']
  ]
  const PROMOTE = {
    tab: 'promoters',
    stats: {},
    settings: {},
    promoters: { q: '', status: '', page: 1, limit: 20, items: [], total: 0 },
    commissions: { uid: '', status: '', from: '', to: '', page: 1, limit: 20, items: [], total: 0 },
    withdraw: { q: '', status: '待审核', page: 1, limit: 20, items: [], total: 0, checked: {} },
    payout: { q: '', status: '', page: 1, limit: 20, items: [], total: 0 },
    items: { q: '', page: 1, limit: 20, items: [], total: 0 },
    reconcile: { diffs: [], loading: false, error: '' }
  }

  function promotePick(obj, keys, fallback) {
    const o = obj || {}
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]]
      if (v !== undefined && v !== null && v !== '') return v
    }
    return fallback
  }
  function promoteNum(obj, keys) {
    return Number(promotePick(obj, keys, 0)) || 0
  }
  function promoteList(data) {
    if (!data) return []
    if (Array.isArray(data)) return data
    return data.items || data.list || data.rows || data.records || []
  }
  function promoteTotal(data, list) {
    if (data && data.total != null) return Number(data.total) || 0
    return (list || []).length
  }
  function promoteMs(v) {
    if (!v) return 0
    if (typeof v === 'number' || /^\d+$/.test(String(v))) return Number(v)
    const t = Date.parse(String(v))
    return isNaN(t) ? 0 : t
  }
  function promoteDate(v) {
    const ms = promoteMs(v)
    return ms ? dateText(ms) : '—'
  }
  function promoteMoney(v) { return money(Number(v) || 0, 2) }
  function promoteRate(v) {
    const n = Number(v) || 0
    return pct(n > 0 && n <= 1 ? n * 100 : n)
  }
  function promoteText(v) { return String(v == null ? '' : v) }
  /* 超时行整行标红（表格按单元格拼接，无法在 tr 上挂样式） */
  function promoteOverdueRow(row, overdue) {
    return overdue ? row.replace(/<td/g, '<td style="background:var(--danger-soft)"') : row
  }
  function promoteStatusOf(v) {
    const s = promoteText(v)
    const map = {
      pending: '待审核', review: '待审核', reviewing: '待审核', pendingReview: '待审核',
      approved: '待打款', pendingPayout: '待打款', toPayout: '待打款',
      paying: '打款中', processing: '打款中',
      paid: '已到账', success: '已到账', completed: '已到账',
      failed: '打款失败', fail: '打款失败',
      rejected: '已驳回', reject: '已驳回',
      cancelled: '已撤销', canceled: '已撤销', revoked: '已撤销',
      pendingSettle: '待结算', settled: '已结算', frozen: '已冻结', reversed: '已冲正',
      active: '正常', normal: '正常', none: '未开通', banned: '封禁', blocked: '封禁', disabled: '已停用'
    }
    return map[s] || s || '—'
  }
  function promoteStatusBadge(v) {
    const s = promoteStatusOf(v)
    const tone = s === '已到账' || s === '已结算' || s === '正常' ? 'ok'
      : s === '打款失败' || s === '已驳回' || s === '已冲正' || s === '封禁' ? 'danger'
        : s === '待审核' || s === '待结算' || s === '待打款' ? 'warn' : 'info'
    return badge(s, tone, true)
  }
  function promotePathText(v) {
    const s = promoteText(v)
    if (!s) return '待选择'
    if (/^A/i.test(s) || /split/i.test(s)) return 'A 手动分账'
    if (/^B/i.test(s) || /transfer/i.test(s)) return 'B 手动转账'
    return s
  }
  function promotePathValue(v) {
    const s = promoteText(v)
    if (/^A/i.test(s) || /split/i.test(s)) return 'A'
    if (/^B/i.test(s) || /transfer/i.test(s)) return 'B'
    return ''
  }
  function promotePromoter(p) {
    const row = p || {}
    return {
      raw: row,
      uid: promotePick(row, ['uid', 'userId', 'id'], ''),
      userNo: promotePick(row, ['userNo'], ''),
      nick: promotePick(row, ['nick', 'nickname', 'name', 'userNick'], '未命名用户'),
      refCode: promotePick(row, ['refCode', 'code', 'promoteCode'], '—'),
      bound: promoteNum(row, ['referrals', 'boundCount', 'bindCount', 'referralCount', 'inviteCount', 'boundUsers']),
      level1Count: promoteNum(row, ['level1Count']),
      level2Count: promoteNum(row, ['level2Count']),
      earning: promoteNum(row, ['earning', 'promoterEarning']),
      level1Earning: promoteNum(row, ['level1Earning']),
      level2Earning: promoteNum(row, ['level2Earning']),
      csBound: row.csBound === true,
      csName: promotePick(row, ['csName'], ''),
      statusText: promotePick(row, ['statusText'], ''),
      pending: promoteNum(row, ['pending', 'pendingAmount', 'promoterPending', 'settlePending']),
      available: promoteNum(row, ['available', 'availableAmount', 'promoterAvailable', 'balance']),
      withdrawn: promoteNum(row, ['withdrawn', 'withdrawnAmount', 'promoterWithdrawn', 'paidAmount']),
      debt: promoteNum(row, ['debt', 'debtAmount', 'promoterDebt']),
      status: promoteStatusOf(promotePick(row, ['status', 'promoterStatus'], '正常')),
      splitReady: promotePick(row, ['splitReceiverReady', 'splitReady'], null)
    }
  }
  function promoteWithdraw(w) {
    const row = w || {}
    const gross = promoteNum(row, ['grossAmount', 'amount', 'gross'])
    const fee = promoteNum(row, ['feeAmount', 'fee'])
    const net = row.netAmount != null || row.net != null
      ? promoteNum(row, ['netAmount', 'net'])
      : Math.max(0, gross - fee)
    return {
      raw: row,
      id: promotePick(row, ['id', 'withdrawalId'], ''),
      no: promotePick(row, ['no', 'withdrawalNo', 'orderNo', 'id'], '—'),
      uid: promotePick(row, ['uid', 'userId'], ''),
      userNo: promotePick(row, ['userNo'], ''),
      nick: promotePick(row, ['nick', 'nickname', 'userNick', 'payeeName'], '—'),
      gross: gross,
      fee: fee,
      net: net,
      status: promoteStatusOf(promotePick(row, ['status'], '')),
      appliedAt: promoteMs(promotePick(row, ['applyAt', 'appliedAt', 'createdAt', 'requestedAt'], 0)),
      reviewedAt: promoteMs(promotePick(row, ['reviewedAt', 'auditedAt'], 0)),
      reviewedBy: promotePick(row, ['reviewedBy', 'auditor', 'auditBy'], ''),
      claimedBy: promotePick(row, ['claimedBy', 'executor', 'payer'], ''),
      method: promotePick(row, ['method', 'path', 'payoutPath'], ''),
      payoutNo: promotePick(row, ['payoutNo', 'payoutOrderNo'], ''),
      payoutAt: promoteMs(promotePick(row, ['payoutAt', 'paidAt', 'finishedAt'], 0)),
      deadlineAt: promoteMs(promotePick(row, ['payoutDeadlineAt', 'deadlineAt', 'payoutDeadline'], 0)),
      voucherUrl: promotePick(row, ['voucherUrl', 'voucher', 'proofUrl'], ''),
      /* 收款银行卡：审核 / 打款前先核对卡号与持卡人 */
      bankHolder: promotePick(row, ['bankHolder', 'payeeName'], ''),
      bankName: promotePick(row, ['bankName', 'bank'], ''),
      bankAccount: promotePick(row, ['bankAccount'], ''),
      bankAccountMasked: promotePick(row, ['bankAccountMasked', 'bankMasked'], ''),
      bankReady: row.bankReady !== false,
      checkedBy: promotePick(row, ['checkedBy', 'checker'], ''),
      note: promotePick(row, ['note', 'remark'], ''),
      failReason: promotePick(row, ['failReason', 'errorMsg'], ''),
      /* 净额中无法覆盖的金额：回填时按 net − uncovered 作为应付合计 */
      uncoveredAmount: promoteNum(row, ['uncoveredAmount', 'uncovered'])
    }
  }
  function promoteSettingsOf(s) {
    const o = (s && (s.settings || s.config)) || s || {}
    return {
      commissionRate: promoteNum(o, ['commissionRate', 'rate']),
      /* 客服绑定用户的一级比例：与普通推广人分开设置 */
      csLevel1Rate: promoteNum(o, ['csLevel1Rate']),
      level2Rate: promoteNum(o, ['level2Rate']),
      feeRate: promoteNum(o, ['feeRate']),
      minWithdraw: promoteNum(o, ['minWithdraw']),
      freezeDay: promoteNum(o, ['freezeDay']),
      manualDualCheckThreshold: promoteNum(o, ['manualDualCheckThreshold', 'dualCheckThreshold']) || 5000,
      payoutTimeoutHours: promoteNum(o, ['payoutTimeoutHours', 'timeoutHours']) || 24,
      reviewTimeoutHours: promoteNum(o, ['reviewTimeoutHours', 'reviewTimeout']) || 24,
      maxSplitRatio: promoteNum(o, ['maxSplitRatio', 'splitRatioLimit']) || 0.3,
      splitEnabled: o.splitEnabled === true
    }
  }
  function promoteIsAdmin() {
    return !!state.account && state.account.role === 'admin'
  }
  function promoteCanView() {
    const role = state.account && state.account.role
    /* 客服可查看推广者与提现单并做审核；打款回填仍由财务 / 管理员操作 */
    return role === 'admin' || role === 'finance' || role === 'cs'
  }
  /* 按动作权限裁剪页签：客服看不到待打款 / 出款明细 / 对账，避免点进去 403 */
  function promoteTabsFor() {
    return PROMOTE_TABS.filter(function (t) {
      if (t[0] === 'payout' || t[0] === 'items') return C.can('promote.payoutList')
      if (t[0] === 'rules') return C.can('promote.reconcile')
      return true
    })
  }
  function promoteTodoCard(stats) {
    const s = (stats && stats.stats) || stats || {}
    const items = [
      {
        label: '待审核提现', tab: 'withdraw', btn: '去审核',
        value: promoteNum(s, ['pendingReview', 'pendingAudit', 'withdrawPending', 'pendingWithdraw', 'reviewPending', 'toReview']),
        desc: '超过 24 小时未审核会在列表标红'
      },
      {
        label: '待打款超 24 小时', tab: 'payout', btn: '去处理',
        value: promoteNum(s, ['payoutTimeout', 'payoutOverdue', 'overduePayout', 'timeoutPayout', 'payoutTimeoutCount']),
        desc: '领取后尽快在商户平台完成人工打款'
      },
      {
        label: '打款失败', tab: 'payout', btn: '去处理',
        value: promoteNum(s, ['payoutFailed', 'failedPayout', 'payoutFail', 'payoutFailCount', 'failedCount']),
        desc: '核对失败原因，必要时退回余额'
      },
      {
        label: '对账差异', tab: 'rules', btn: '去对账',
        value: promoteNum(s, ['reconcileDiff', 'reconcileDiffs', 'reconcilePending', 'diffCount', 'reconcileDiffCount']),
        desc: '系统台账与人工回填不一致，需逐笔核实'
      }
    ]
    const total = items.reduce(function (sum, it) { return sum + (Number(it.value) || 0) }, 0)
    return todoCard({
      tone: total ? 'danger' : 'brand', icon: 'chart', title: '推广分账待办', total: total,
      goKey: 'promote', goText: '推广管理',
      desc: '提现审核、超时打款、失败打款与对账差异，全部需要人工处理',
      empty: '推广分账暂无待办', items: items,
      row: function (it) {
        return todoItem({
          title: '<span class="todo-strong">' + esc(it.label) + '</span><span class="todo-sep">·</span>' + num(it.value) + ' 项',
          meta: [esc(it.desc)],
          actions: '<button class="btn xs' + (it.value ? ' primary' : '') + '" data-go="promote" data-go-tab="' + it.tab + '">' + esc(it.btn) + '</button>'
        })
      }
    })
  }

  Pages.promote = async function (view, ctx) {
    const query = (ctx && ctx.query) || {}
    const tabs = promoteTabsFor()
    if (query.tab && tabs.some(function (t) { return t[0] === query.tab })) PROMOTE.tab = query.tab
    if (!tabs.some(function (t) { return t[0] === PROMOTE.tab })) PROMOTE.tab = 'promoters'
    view.innerHTML = pageHead('推广管理', '推广者绑定、佣金结算与人工分账出款全流程；审核与执行分离，所有资金动作留痕',
      '<button class="btn" id="pm-refresh">' + icon('refresh') + '<span>刷新</span></button>') +
      '<div id="pm-stats">' + loadingBlock('读取推广数据') + '</div>' +
      '<div class="tabs" id="pm-tabs" style="margin-top:14px">' + tabs.map(function (t) {
        return '<button data-pm-tab="' + t[0] + '"' + (PROMOTE.tab === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>'
      }).join('') + '</div>' +
      '<div id="pm-body" style="margin-top:14px">' + loadingBlock('读取列表') + '</div>'
    view.querySelector('#pm-refresh').onclick = function () { Pages.promote(view) }
    view.querySelectorAll('[data-pm-tab]').forEach(function (btn) {
      btn.onclick = function () { PROMOTE.tab = btn.getAttribute('data-pm-tab'); Pages.promote(view) }
    })
    const body = view.querySelector('#pm-body')
    const [stats, settings] = await Promise.all([
      api('promote.stats', {}).catch(function (err) { return { _error: err.message } }),
      api('promote.settings', {}).catch(function () { return {} })
    ])
    PROMOTE.stats = stats || {}
    PROMOTE.settings = promoteSettingsOf(settings || PROMOTE.settings)
    renderPromoteStats(view.querySelector('#pm-stats'), PROMOTE.stats)
    await renderPromoteTab(body)
    /* pm-tab-render */
  }

  function renderPromoteStats(root, stats) {
    const s = (stats && stats.stats) || stats || {}
    root.innerHTML = kpiRow([
      ['推广者', num(promoteNum(s, ['promoters', 'promoterCount', 'totalPromoters'])), '<span class="small" style="color:var(--muted-2)">已开通推广</span>'],
      ['待结算佣金', promoteMoney(promoteNum(s, ['pending', 'pendingAmount', 'pendingCommission'])), '<span class="small" style="color:var(--muted-2)">冻结期内</span>'],
      ['可提现余额', promoteMoney(promoteNum(s, ['available', 'availableAmount', 'balance'])), '<span class="small" style="color:var(--muted-2)">推广者合计</span>'],
      ['待审核提现', num(promoteNum(s, ['pendingReview', 'pendingAudit', 'withdrawPending'])), '<span class="small" style="color:var(--muted-2)">人工审核</span>'],
      ['待处理打款', num(promoteNum(s, ['payoutPending', 'pendingPayout', 'payoutTimeout', 'payoutOverdue']) + promoteNum(s, ['payoutFailed', 'failedPayout', 'failedCount'])), '<span class="small" style="color:var(--muted-2)">超时 / 失败</span>']
    ]) + (s._error ? '<div class="small" style="margin-top:8px;color:var(--warn)">推广汇总加载失败：' + esc(s._error) + '，列表仍可单独查看</div>' : '')
  }

  function renderPromoteTab(root) {
    if (PROMOTE.tab === 'promoters') return renderPromotePromoters(root)
    if (PROMOTE.tab === 'commissions') return renderPromoteCommissions(root)
    if (PROMOTE.tab === 'withdraw') return renderPromoteWithdraw(root)
    if (PROMOTE.tab === 'payout') return renderPromotePayout(root)
    if (PROMOTE.tab === 'items') return renderPromoteItems(root)
    return renderPromoteRules(root)
  }

  async function renderPromotePromoters(root) {
    const f = PROMOTE.promoters
    root.innerHTML = filterBar([
      '<div class="field" style="min-width:240px"><label>推广者</label><input id="pm-p-q" placeholder="昵称 / 用户ID / 推广码（可搜未开通用户）" value="' + esc(f.q) + '"></div>',
      field('状态', '<select id="pm-p-status">' + options(['正常', '封禁', '未开通'], f.status) + '</select>'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pm-p-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) + '<div id="pm-p-list" style="margin-top:12px">' + loadingBlock('读取推广者') + '</div>'
    root.querySelector('#pm-p-search').onclick = function () {
      f.q = root.querySelector('#pm-p-q').value.trim()
      f.status = root.querySelector('#pm-p-status').value
      f.page = 1
      renderPromotePromoters(root)
    }
    const box = root.querySelector('#pm-p-list')
    try {
      const data = await api('promote.list', { q: f.q, status: f.status, page: f.page, limit: f.limit })
      const raw = promoteList(data)
      const rows = raw.map(function (item) {
        const p = promotePromoter(item)
        const banned = p.status === '封禁' || p.status === 'banned'
        const nameCell = '<div class="strong">' + esc(p.nick) + '</div>' +
          '<div class="small mono" style="color:var(--muted-2)">' + esc(p.userNo || p.uid) + '</div>' +
          (p.csBound ? '<div class="small" style="color:#2563eb">客服绑定' + (p.csName ? ' · ' + esc(p.csName) : '') + '</div>' : '')
        return '<td>' + nameCell + '</td>' +
          '<td class="mono">' + esc(p.refCode) + '</td>' +
          '<td class="mono">' + num(p.level1Count) + ' / ' + num(p.level2Count) + '</td>' +
          '<td class="mono">' + promoteMoney(p.level1Earning) + '</td>' +
          '<td class="mono">' + promoteMoney(p.level2Earning) + '</td>' +
          '<td class="mono">' + promoteMoney(p.pending) + '</td>' +
          '<td class="mono strong">' + promoteMoney(p.available) + '</td>' +
          '<td class="mono"' + (p.debt > 0 ? ' style="color:var(--danger)"' : '') + '>' + promoteMoney(p.debt) + '</td>' +
          '<td>' + promoteStatusBadge(p.status) + (p.statusText ? '<div class="small" style="color:var(--muted-2)">' + esc(p.statusText) + '</div>' : '') + '</td>' +
          '<td><div class="flex" style="gap:5px;flex-wrap:wrap">' +
          '<button class="btn xs" data-pm-detail="' + esc(p.uid) + '">查看详情</button>' +
          (promoteIsAdmin() && p.status === '未开通' ? '<button class="btn xs primary" data-pm-open="' + esc(p.uid) + '" data-name="' + esc(p.nick) + '">开通推广</button>' : '') +
          (promoteIsAdmin() && p.status !== '未开通' ? '<button class="btn xs ' + (banned ? '' : 'danger') + '" data-pm-ban="' + esc(p.uid) + '" data-name="' + esc(p.nick) + '" data-status="' + esc(banned ? '正常' : '封禁') + '">' + (banned ? '解封' : '封禁') + '</button>' : '') +
          '</div></td>'
      })
      box.innerHTML = table(['昵称', '推广码', '一级 / 二级人数', '一级佣金', '二级佣金', '待结算', '可提现', '欠款', '状态', '操作'], rows, '暂无推广者') +
        (rows.length ? pager(promoteTotal(data, raw), f.page, f.limit) : '')
      wirePager(box, function (page) { f.page = page; renderPromotePromoters(root) })
      box.querySelectorAll('[data-pm-detail]').forEach(function (btn) {
        btn.onclick = function () { openPromoteDetail(btn.getAttribute('data-pm-detail'), root) }
      })
      box.querySelectorAll('[data-pm-open]').forEach(function (btn) {
        btn.onclick = function () {
          grantPromoteTo(btn.getAttribute('data-pm-open'), btn.getAttribute('data-name'), function () {
            renderPromotePromoters(root)
          })
        }
      })
      box.querySelectorAll('[data-pm-ban]').forEach(function (btn) {
        btn.onclick = async function () {
          const name = btn.getAttribute('data-name')
          const next = btn.getAttribute('data-status')
          const ok = await confirm({
            title: (next === '封禁' ? '封禁' : '解封') + '推广者',
            message: '确认将 <b>' + esc(name) + '</b> 的推广状态改为「' + next + '」？封禁后停止计佣与新绑定。',
            okText: next === '封禁' ? '确认封禁' : '确认解封',
            danger: next === '封禁'
          })
          if (!ok) return
          btn.disabled = true
          try {
            await api('promote.setStatus', { uid: btn.getAttribute('data-pm-ban'), status: next === '封禁' ? 'blocked' : 'active' })
            toast('已' + next)
            renderPromotePromoters(root)
          } catch (err) {
            toast(err.message, 'err')
            btn.disabled = false
          }
        }
      })
    } catch (err) {
      box.innerHTML = card('推广者列表', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  async function openPromoteDetail(uid, root) {
    const drawer = openDrawer({
      title: '推广者详情',
      sub: esc(uid),
      body: '<div id="pm-detail-body">' + loadingBlock('读取推广者数据') + '</div>',
      foot: '<button class="btn" id="pm-detail-close">关闭</button>'
    })
    if (!drawer) return
    drawer.foot.querySelector('#pm-detail-close').onclick = closeDrawer
    const body = drawer.body.querySelector('#pm-detail-body')
    try {
      const [detail, commData, wdData] = await Promise.all([
        /* 一级 / 二级下级名单、人数与开通情况由后端按关系链汇总 */
        api('promote.detail', { uid: uid }).catch(function () { return null }),
        api('promote.commissions', { uid: uid, page: 1, limit: 8 }).catch(function () { return {} }),
        api('promote.withdrawList', { uid: uid, page: 1, limit: 8 }).catch(function () { return {} })
      ])
      const d = detail || {}
      const counts = d.counts || {}
      const opened = d.opened || {}
      const level1 = Array.isArray(d.level1) ? d.level1 : []
      const level2 = Array.isArray(d.level2) ? d.level2 : []
      const comms = promoteList(commData)
      const wds = promoteList(wdData).map(promoteWithdraw)
      const childRow = function (r, withParent) {
        return '<td><div class="strong">' + esc(r.nick || '未命名用户') + '</div>' +
          '<div class="small mono" style="color:var(--muted-2)">' + esc(r.userNo || r.uid) + '</div></td>' +
          (withParent ? '<td>' + esc(r.parentNick || r.parentUid || '—') + '</td>' : '') +
          '<td>' + (r.member ? '<span style="color:#059669">' + esc(r.memberText || '已开通会员') + '</span>' : '<span class="small" style="color:var(--muted-2)">未开通会员</span>') + '</td>' +
          '<td>' + (r.promoterStatus === 'active'
            ? '<span style="color:#059669">已开通推广</span>'
            : '<span class="small" style="color:var(--muted-2)">' + esc(r.promoterStatus === 'blocked' ? '推广已封禁' : '未开通推广') + '</span>') + '</td>' +
          '<td class="small">' + esc(promoteDate(r.boundAt)) + '</td>' +
          '<td class="small">' + (r.firstOrderAt ? esc(promoteDate(r.firstOrderAt)) : '—') + '</td>'
      }
      body.innerHTML = kvList([
        ['昵称', esc(d.nick || '—')], ['用户ID', '<span class="mono">' + esc(uid) + '</span>'],
        ['推广码', '<span class="mono">' + esc(d.refCode || '—') + '</span>'],
        ['状态', (d.statusText ? esc(d.statusText) : promoteStatusBadge(d.status)) + (d.csBound ? ' · 客服绑定' : '')],
        ['一级人数', num(counts.level1 || level1.length) + ' 人（开通会员 ' + num(opened.level1Member) + ' · 开通推广 ' + num(opened.level1Promoter) + '）'],
        ['二级人数', num(counts.level2 || level2.length) + ' 人（开通会员 ' + num(opened.level2Member) + ' · 开通推广 ' + num(opened.level2Promoter) + '）'],
        ['一级佣金', promoteMoney(d.level1Earning) + ' <span class="small" style="color:var(--muted-2)">单价 ' + promoteRate(d.rateText || (d.csBound ? PROMOTE.settings.csLevel1Rate : PROMOTE.settings.commissionRate)) + '</span>'],
        ['二级佣金', d.csBound
          ? promoteMoney(d.level2Earning) + ' <span class="small" style="color:var(--muted-2)">单价 ' + promoteRate(d.level2RateText || PROMOTE.settings.level2Rate) + '</span>'
          : '<span class="small" style="color:var(--muted-2)">普通推广无二级佣金</span>'],
        ['待结算 / 可提现', promoteMoney(d.pending) + ' / ' + promoteMoney(d.available)],
        ['欠款', '<span' + (Number(d.debt) > 0 ? ' style="color:var(--danger)"' : '') + '>' + promoteMoney(d.debt) + '</span>']
      ]) +
        '<div class="strong" style="margin:16px 0 8px">一级下级（' + num(level1.length) + '）</div>' +
        table(['下级', '开通会员', '推广资格', '绑定时间', '首次付费'], level1.map(function (r) { return childRow(r, false) }), '暂无一级下级') +
        '<div class="strong" style="margin:16px 0 8px">二级下级（' + num(level2.length) + '）</div>' +
        table(['下级', '所属一级', '开通会员', '推广资格', '绑定时间', '首次付费'], level2.map(function (r) { return childRow(r, true) }), '暂无二级下级') +
        '<div class="strong" style="margin:16px 0 8px">最近佣金</div>' +
        table(['订单号', '通道', '级别', '比例快照', '净额', '状态'], comms.map(function (c) {
          const lv = Number(promotePick(c, ['level'], 1)) === 2 ? '二级' : '一级'
          return '<td class="mono">' + esc(promotePick(c, ['orderNo', 'orderId', 'id'], '—')) + '</td>' +
            '<td>' + esc(promotePick(c, ['channel', 'payChannel'], '—')) + '</td>' +
            '<td>' + lv + '</td>' +
            '<td>' + promoteRate(promotePick(c, ['rate', 'rateSnapshot', 'commissionRate'], 0)) + '</td>' +
            '<td class="mono">' + promoteMoney(promotePick(c, ['netAmount', 'net', 'amount'], 0)) + '</td>' +
            '<td>' + promoteStatusBadge(promotePick(c, ['status'], '')) + '</td>'
        }), '暂无佣金记录') +
        '<div class="strong" style="margin:16px 0 8px">最近提现</div>' +
        table(['提现单号', '净额', '状态', '申请时间'], wds.map(function (w) {
          return '<td class="mono">' + esc(w.no) + '</td><td class="mono">' + promoteMoney(w.net) + '</td>' +
            '<td>' + promoteStatusBadge(w.status) + '</td><td>' + esc(promoteDate(w.appliedAt)) + '</td>'
        }), '暂无提现记录')
      if (!detail) {
        body.insertAdjacentHTML('afterbegin', '<div class="small" style="margin-bottom:8px;color:var(--warn)">下级名单加载失败，仅展示佣金与提现记录</div>')
      }
    } catch (err) {
      body.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>'
    }
  }

  async function renderPromoteCommissions(root) {
    const f = PROMOTE.commissions
    /* 财务 / 管理员：Apple 结算到账后按月确认，解冻该月佣金 */
    const canArrival = promoteCanView()
    root.innerHTML = filterBar([
      '<div class="field" style="min-width:200px"><label>推广者</label><input id="pm-c-uid" placeholder="昵称 / 推广码 / 用户ID" value="' + esc(f.uid) + '"></div>',
      field('状态', '<select id="pm-c-status">' + options(['待结算', '可提现', '已提现', '已冲正'], f.status) + '</select>'),
      field('开始日期', '<input type="date" id="pm-c-from" value="' + esc(f.from) + '">'),
      field('结束日期', '<input type="date" id="pm-c-to" value="' + esc(f.to) + '">'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pm-c-search">' + icon('search') + '<span>查询</span></button></div>'
    ].concat(canArrival
      ? ['<div class="field" style="justify-content:flex-end"><button class="btn" id="pm-c-arrival"><span>确认 Apple 到账</span></button></div>']
      : [])) + '<div id="pm-c-list" style="margin-top:12px">' + loadingBlock('读取佣金明细') + '</div>'
    root.querySelector('#pm-c-search').onclick = function () {
      f.uid = root.querySelector('#pm-c-uid').value.trim()
      f.status = root.querySelector('#pm-c-status').value
      f.from = root.querySelector('#pm-c-from').value
      f.to = root.querySelector('#pm-c-to').value
      f.page = 1
      renderPromoteCommissions(root)
    }
    const arrivalBtn = root.querySelector('#pm-c-arrival')
    if (arrivalBtn) arrivalBtn.onclick = function () { openAppleArrival(root) }
    const box = root.querySelector('#pm-c-list')
    try {
      const params = { uid: f.uid, status: f.status, page: f.page, limit: f.limit }
      if (f.from) params.from = new Date(f.from + 'T00:00:00').getTime()
      if (f.to) params.to = new Date(f.to + 'T23:59:59').getTime()
      const data = await api('promote.commissions', params)
      const raw = promoteList(data)
      const isAdmin = promoteIsAdmin()
      const rows = raw.map(function (c) {
        const st = promotePick(c, ['status'], '')
        const reversed = st === '已冲正' || st === 'reversed'
        const paymentId = promotePick(c, ['paymentId'], '')
        const userNo = promotePick(c, ['userNo'], '')
        return '<td><div class="strong">' + esc(promotePick(c, ['nick', 'userNick', 'uid'], '—')) + '</div>' +
          '<div class="small" style="color:var(--muted-2)">' + (userNo ? '<span class="mono">' + esc(userNo) + '</span> · ' : '') +
            esc(promoteDate(promotePick(c, ['createdAt', 'settledAt'], 0))) + '</div></td>' +
          '<td class="mono">' + esc(promotePick(c, ['orderNo', 'orderId', 'id'], '—')) + '</td>' +
          '<td class="mono">' + esc(promotePick(c, ['transactionId', 'tradeNo', 'payNo'], '—')) + '</td>' +
          '<td>' + esc(promotePick(c, ['channel', 'payChannel'], '—')) + '</td>' +
          '<td>' + promoteRate(promotePick(c, ['rate', 'rateSnapshot', 'commissionRate'], 0)) + '</td>' +
          '<td class="mono">' + promoteMoney(promotePick(c, ['grossAmount', 'amount'], 0)) + '</td>' +
          '<td class="mono">' + promoteMoney(promotePick(c, ['feeAmount', 'fee'], 0)) + '</td>' +
          '<td class="mono strong">' + promoteMoney(promotePick(c, ['netAmount', 'net', 'commissionAmount'], 0)) + '</td>' +
          '<td>' + promoteStatusBadge(st) +
            (promotePick(c, ['arrivalHold'], false) === true
              ? ' <span class="small" style="color:#d97706">待到账确认</span>'
              : '') + '</td>' +
          (isAdmin
            ? '<td>' + (reversed || !paymentId
              ? '—'
              : '<button class="btn xs danger" data-pm-rev="' + esc(paymentId) + '">冲正</button>') + '</td>'
            : '')
      })
      const heads = ['推广者 / 时间', '订单号', '交易单号', '通道', '比例快照', '毛额', '手续费', '净额', '状态']
      if (isAdmin) heads.push('操作')
      box.innerHTML = table(heads, rows, '暂无佣金明细') +
        (rows.length ? pager(promoteTotal(data, raw), f.page, f.limit) : '')
      wirePager(box, function (page) { f.page = page; renderPromoteCommissions(root) })
      box.querySelectorAll('[data-pm-rev]').forEach(function (btn) {
        btn.onclick = function () { openReverseCommission(btn.getAttribute('data-pm-rev'), root) }
      })
    } catch (err) {
      box.innerHTML = card('佣金明细', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  /**
   * 手工冲正（管理员）：按支付单号定位佣金。
   * 未出款直接冲正并扣减对应余额；已出款且走分账路径的，必须先在商户平台手动回退，
   * 填了回退单号后端才会把佣金标记「已冲正」，否则只记欠款（对齐文档 3.9）。
   */
  function openReverseCommission(paymentId, root) {
    const m = modal({
      title: '手工冲正佣金',
      sub: '支付单号 ' + paymentId,
      body: '<div class="field"><label>冲正原因（必填）</label><textarea id="pm-rev-reason" rows="3" placeholder="如：订单已退款 / 违规套利"></textarea></div>' +
        '<div class="field"><label>回退单号（已出款且已在商户平台回退成功时填写）</label><input id="pm-rev-refund" placeholder="分账回退单号 / 转账回退单号"></div>' +
        '<div class="small" style="margin-top:6px;color:var(--muted-2)">未出款佣金会直接冲正；已出款且走分账路径的，未填回退单号只会记欠款，佣金不会标记为已冲正。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="pm-rev-ok">确认冲正</button>'
    })
    if (!m) return
    m.foot.querySelector('#pm-rev-ok').onclick = async function () {
      const reason = m.body.querySelector('#pm-rev-reason').value.trim()
      if (!reason) return toast('请填写冲正原因', 'err')
      const refundNo = m.body.querySelector('#pm-rev-refund').value.trim()
      this.disabled = true
      try {
        const res = await api('promote.reverseCommission', {
          paymentId: paymentId,
          reason: reason,
          splitRefundNo: refundNo,
          splitRefundDone: !!refundNo
        })
        closeModal()
        toast(res && res.pendingSplitRefund ? '已记欠款，回退成功后再次冲正' : '佣金已冲正')
        renderPromoteCommissions(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  /**
   * 确认 Apple 结算到账（财务 / 管理员）：Apple 款项到账后按「支付月份」解冻该月佣金。
   * 只解冻「待结算 · 待到账确认」的 Apple 渠道佣金，推广者有欠款时解冻自动抵扣；
   * 同一月份重复确认幂等（返回 0 笔）。确认前请先核对 Apple 结算报告与到账流水。
   */
  function openAppleArrival(root) {
    const m = modal({
      title: '确认 Apple 结算到账',
      sub: '按支付月份解冻 Apple 渠道佣金',
      body: '<div class="field"><label>支付月份（YYYY-MM）</label><input id="pm-arr-month" placeholder="如 2026-11"></div>' +
        '<div class="small" style="margin-top:6px;color:var(--muted-2)">只解冻「待结算 · 待到账确认」的 Apple 渠道佣金；该月推广者如有欠款，解冻时自动抵扣。确认前请先核对 Apple 结算报告与到账流水。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="pm-arr-ok">确认到账并解冻</button>'
    })
    if (!m) return
    m.foot.querySelector('#pm-arr-ok').onclick = async function () {
      const month = m.body.querySelector('#pm-arr-month').value.trim()
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return toast('月份格式应为 YYYY-MM', 'err')
      this.disabled = true
      try {
        const res = await api('promote.appleSettle', { month: month })
        closeModal()
        const released = res && res.count ? res.count : 0
        toast('已确认到账，解冻 ' + released + ' 笔 Apple 佣金' +
          (res && res.offset ? '（其中 ¥' + Number(res.offset).toFixed(2) + ' 自动抵扣欠款）' : ''))
        renderPromoteCommissions(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  async function renderPromoteWithdraw(root) {
    const f = PROMOTE.withdraw
    const timeoutHours = PROMOTE.settings.reviewTimeoutHours || 24
    root.innerHTML = filterBar([
      '<div class="field" style="min-width:220px"><label>提现单号 / 推广者</label><input id="pm-w-q" placeholder="提现单号 / 昵称 / 用户ID" value="' + esc(f.q) + '"></div>',
      field('状态', '<select id="pm-w-status">' + options(['待审核', '待打款', '打款中', '已到账', '打款失败', '已驳回', '已撤销'], f.status) + '</select>'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pm-w-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) + '<div id="pm-w-list" style="margin-top:12px">' + loadingBlock('读取提现申请') + '</div>'
    root.querySelector('#pm-w-search').onclick = function () {
      f.q = root.querySelector('#pm-w-q').value.trim()
      f.status = root.querySelector('#pm-w-status').value
      f.page = 1
      f.checked = {}
      renderPromoteWithdraw(root)
    }
    const box = root.querySelector('#pm-w-list')
    try {
      const data = await api('promote.withdrawList', { q: f.q, status: f.status, page: f.page, limit: f.limit })
      const raw = promoteList(data)
      const rows = raw.map(function (item) {
        const w = promoteWithdraw(item)
        const pending = w.status === '待审核'
        const overdue = pending && w.appliedAt && Date.now() - w.appliedAt > timeoutHours * 3600e3
        return promoteOverdueRow('' +
          '<td>' + (pending ? '<input type="checkbox" data-pm-wdsel="' + esc(w.id) + '"' + (f.checked[w.id] ? ' checked' : '') + '>' : '') + '</td>' +
          '<td class="mono">' + esc(w.no) + (overdue ? '<div class="small" style="color:var(--danger)">超 ' + timeoutHours + ' 小时未审核</div>' : '') + '</td>' +
          '<td><div class="strong">' + esc(w.nick) + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(w.userNo || w.uid) + '</div></td>' +
          '<td>' + '<div class="strong">' + esc(w.bankHolder || '未填写') + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(w.bankName || '—') + '</div>' +
            '<div class="small mono">' + esc(w.bankAccount || w.bankAccountMasked || '—') + '</div>' +
            (w.bankReady === false ? '<div class="small" style="color:var(--danger)">未补全收款卡</div>' : '') + '</td>' +
          '<td class="mono">' + promoteMoney(w.gross) + '</td>' +
          '<td class="mono">' + promoteMoney(w.fee) + '</td>' +
          '<td class="mono strong">' + promoteMoney(w.net) + '</td>' +
          '<td>' + esc(promoteDate(w.appliedAt)) + '</td>' +
          '<td>' + promoteStatusBadge(w.status) +
            (w.failReason ? '<div class="small" style="color:var(--danger)">' + esc(w.failReason) + '</div>' : '') +
            (w.voucherUrl ? '<div><button class="btn xs ghost" data-pm-wdvoucher="' + esc(w.voucherUrl) + '">查看打款凭证</button></div>' : '') + '</td>' +
          '<td>' + esc(w.reviewedBy || '—') + '</td>' +
          '<td><div class="flex" style="gap:5px;flex-wrap:wrap">' +
          (pending
            ? '<button class="btn xs primary" data-pm-wdok="' + esc(w.id) + '" data-no="' + esc(w.no) + '" data-net="' + w.net + '">通过</button>' +
              '<button class="btn xs danger" data-pm-wdno="' + esc(w.id) + '" data-no="' + esc(w.no) + '">驳回</button>'
            : '') +
          '<button class="btn xs" data-pm-wditems="' + esc(w.no) + '">出款明细</button>' +
          '</div></td>', overdue)
      })
      box.innerHTML = table(['', '提现单号', '推广者', '收款银行卡', '毛额', '手续费', '提现净额', '申请时间', '状态', '审核人', '操作'], rows, f.status === '待审核' ? '暂无待审核提现' : '暂无提现记录') +
        (rows.length ? pager(promoteTotal(data, raw), f.page, f.limit) : '')
      const toolbar = document.createElement('div')
      toolbar.className = 'flex flex-wrap'
      toolbar.style.cssText = 'gap:8px;justify-content:flex-end;margin-bottom:10px'
      toolbar.innerHTML = (f.status === '待审核'
        ? '<label class="small" style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="pm-wd-all">全选本页待审核</label>' +
          '<button class="btn primary" id="pm-wd-batch">批量通过</button>'
        : '')
      box.insertBefore(toolbar, box.firstChild)
      wirePager(box, function (page) { f.page = page; f.checked = {}; renderPromoteWithdraw(root) })
      const all = box.querySelector('#pm-wd-all')
      if (all) {
        all.onchange = function () {
          box.querySelectorAll('[data-pm-wdsel]').forEach(function (cb) {
            cb.checked = all.checked
            if (all.checked) f.checked[cb.getAttribute('data-pm-wdsel')] = true
            else delete f.checked[cb.getAttribute('data-pm-wdsel')]
          })
        }
      }
      box.querySelectorAll('[data-pm-wdsel]').forEach(function (cb) {
        cb.onchange = function () {
          const id = cb.getAttribute('data-pm-wdsel')
          if (cb.checked) f.checked[id] = true
          else delete f.checked[id]
        }
      })
      box.querySelectorAll('[data-pm-wdok]').forEach(function (btn) {
        btn.onclick = function () {
          approveWithdraw(btn.getAttribute('data-pm-wdok'), btn.getAttribute('data-no'), Number(btn.getAttribute('data-net')), root)
        }
      })
      box.querySelectorAll('[data-pm-wdno]').forEach(function (btn) {
        btn.onclick = function () {
          openRejectWithdraw(btn.getAttribute('data-pm-wdno'), btn.getAttribute('data-no'), root)
        }
      })
      box.querySelectorAll('[data-pm-wditems]').forEach(function (btn) {
        btn.onclick = function () {
          PROMOTE.items.q = btn.getAttribute('data-pm-wditems')
          PROMOTE.items.page = 1
          PROMOTE.tab = 'items'
          C.renderPage()
        }
      })
      box.querySelectorAll('[data-pm-wdvoucher]').forEach(function (btn) {
        btn.onclick = function () { previewImage(btn.getAttribute('data-pm-wdvoucher')) }
      })
      /* 客服没有出款明细页权限时，隐藏「出款明细」入口，避免点击后 403 */
      if (!C.can('promote.payoutList')) {
        box.querySelectorAll('[data-pm-wditems]').forEach(function (btn) { btn.style.display = 'none' })
      }
      const batch = box.querySelector('#pm-wd-batch')
      if (batch) {
        batch.onclick = async function () {
          const ids = Object.keys(f.checked)
          if (!ids.length) return toast('请先勾选待审核提现', 'err')
          const first = await confirm({
            title: '批量通过提现',
            message: '本次将审核通过 <b>' + num(ids.length) + '</b> 笔提现，通过后进入「待打款」，由财务在商户平台人工打款。',
            okText: '确认通过'
          })
          if (!first) return
          if (ids.length > 50) {
            const second = await confirm({
              title: '超过 50 笔，需要二次确认',
              message: '批量审核单次上限 50 笔，本次 ' + num(ids.length) + ' 笔。请再次确认批量通过。',
              okText: '仍要提交',
              danger: true
            })
            if (!second) return
          }
          batch.disabled = true
          try {
            await api('promote.withdrawApprove', { ids: ids, note: '中台批量审核' })
            toast('已通过 ' + num(ids.length) + ' 笔')
            f.checked = {}
            renderPromoteWithdraw(root)
          } catch (err) {
            toast(err.message, 'err')
            batch.disabled = false
          }
        }
      }
    } catch (err) {
      box.innerHTML = card('提现审核', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  async function approveWithdraw(id, no, net, root) {
    const ok = await confirm({
      title: '审核通过',
      message: '提现单 <b>' + esc(no) + '</b>，净额 <b>' + promoteMoney(net) + '</b>。通过后进入待打款，请财务在商户平台人工打款。',
      okText: '确认通过'
    })
    if (!ok) return
    try {
      await api('promote.withdrawApprove', { id: id, ids: [id] })
      toast('已通过，进入待打款')
      renderPromoteWithdraw(root)
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  function openRejectWithdraw(id, no, root) {
    const m = modal({
      title: '驳回提现',
      sub: '提现单 ' + no,
      body: '<div class="field"><label>驳回原因（必填）</label><textarea id="pm-reject-reason" rows="4" placeholder="请填写驳回原因，用户端可见"></textarea></div>' +
        '<div class="small" style="margin-top:6px;color:var(--muted-2)">驳回后金额退回推广者余额，需重新申请。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="pm-reject-ok">确认驳回</button>'
    })
    if (!m) return
    m.foot.querySelector('#pm-reject-ok').onclick = async function () {
      const reason = m.body.querySelector('#pm-reject-reason').value.trim()
      if (!reason) return toast('请填写驳回原因', 'err')
      this.disabled = true
      try {
        await api('promote.withdrawReject', { id: id, reason: reason })
        closeModal()
        toast('已驳回')
        renderPromoteWithdraw(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  async function renderPromotePayout(root) {
    const f = PROMOTE.payout
    const timeoutHours = PROMOTE.settings.payoutTimeoutHours || 24
    root.innerHTML = filterBar([
      '<div class="field" style="min-width:220px"><label>提现单号 / 收款人</label><input id="pm-o-q" placeholder="提现单号 / 昵称 / 用户ID" value="' + esc(f.q) + '"></div>',
      field('状态', '<select id="pm-o-status">' + options(['待打款', '打款中', '打款失败', '已到账', '已撤销'], f.status) + '</select>'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pm-o-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) + '<div class="small" style="margin:10px 2px;color:var(--muted-2)">路径 A 手动分账需在微信服务商平台逐笔发起；路径 B 手动转账需在商户平台转账后回填。超过 ' + timeoutHours + ' 小时未打款会标红提醒。</div>' +
      '<div id="pm-o-list">' + loadingBlock('读取待打款清单') + '</div>'
    root.querySelector('#pm-o-search').onclick = function () {
      f.q = root.querySelector('#pm-o-q').value.trim()
      f.status = root.querySelector('#pm-o-status').value
      f.page = 1
      renderPromotePayout(root)
    }
    const box = root.querySelector('#pm-o-list')
    try {
      const data = await api('promote.payoutList', { q: f.q, status: f.status, page: f.page, limit: f.limit })
      const raw = promoteList(data)
      f.raw = raw
      const rows = raw.map(function (item) {
        const w = promoteWithdraw(item)
        const generated = w.reviewedAt || w.appliedAt
        const deadline = w.deadlineAt || (generated ? generated + timeoutHours * 3600e3 : 0)
        const open = w.status === '待打款' || w.status === '打款中'
        const overdue = open && deadline && Date.now() > deadline
        const terminal = w.status === '已到账' || w.status === '已撤销' || w.status === '已驳回'
        const canFail = w.status === '待打款' || w.status === '打款中'
        const canCancel = w.status === '待打款' || w.status === '打款中' || w.status === '打款失败'
        return promoteOverdueRow('' +
          '<td class="mono">' + esc(w.no) + (overdue ? '<div class="small" style="color:var(--danger)">已超时</div>' : '') + '</td>' +
          '<td><div class="strong">' + esc(w.nick) + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(w.userNo || w.uid) + '</div></td>' +
          '<td><div class="strong">' + esc(w.bankHolder || '未填写') + '</div>' +
            '<div class="small" style="color:var(--muted-2)">' + esc(w.bankName || '—') + '</div>' +
            '<div class="small mono">' + esc(w.bankAccount || w.bankAccountMasked || '—') + '</div>' +
            (w.bankReady === false ? '<div class="small" style="color:var(--danger)">未补全收款卡</div>' : '') + '</td>' +
          '<td class="mono strong">' + promoteMoney(w.net) + '</td>' +
          '<td>' + esc(promotePathText(w.method)) + '</td>' +
          '<td>' + esc(promoteDate(generated)) + '<div class="small" style="color:var(--muted-2)">截止 ' + esc(promoteDate(deadline)) + '</div></td>' +
          '<td>' + promoteStatusBadge(w.status) +
            (w.failReason ? '<div class="small" style="color:var(--danger)">' + esc(w.failReason) + '</div>' : '') +
            (w.voucherUrl ? '<div><button class="btn xs ghost" data-pm-o-voucher="' + esc(w.voucherUrl) + '">查看打款凭证</button></div>' : '') + '</td>' +
          '<td>' + esc(w.claimedBy || '—') + '</td>' +
          '<td><div class="flex" style="gap:5px;flex-wrap:wrap">' +
          '<button class="btn xs" data-pm-o-claim="' + esc(w.id) + '" data-no="' + esc(w.no) + '"' + (w.status === '待打款' ? '' : ' disabled') + '>领取</button>' +
          '<button class="btn xs" data-pm-o-export="' + esc(w.id) + '">导出 CSV</button>' +
          '<button class="btn xs primary" data-pm-o-fill="' + esc(w.id) + '"' + (terminal ? ' disabled' : '') + '>回填</button>' +
          '<button class="btn xs danger" data-pm-o-fail="' + esc(w.id) + '" data-no="' + esc(w.no) + '"' + (canFail ? '' : ' disabled') + '>标记失败</button>' +
          '<button class="btn xs" data-pm-o-cancel="' + esc(w.id) + '" data-no="' + esc(w.no) + '"' + (canCancel ? '' : ' disabled') + '>退回余额</button>' +
          '</div></td>', overdue)
      })
      box.innerHTML = table(['提现单号', '收款人', '收款银行卡', '金额', '路径', '生成 / 截止时间', '状态', '执行人', '操作'], rows, '暂无待打款记录') +
        (rows.length ? pager(promoteTotal(data, raw), f.page, f.limit) : '')
      wirePager(box, function (page) { f.page = page; renderPromotePayout(root) })
      box.querySelectorAll('[data-pm-o-voucher]').forEach(function (btn) {
        btn.onclick = function () { previewImage(btn.getAttribute('data-pm-o-voucher')) }
      })
      const byId = {}
      raw.forEach(function (item) { const w = promoteWithdraw(item); byId[w.id] = w })
      box.querySelectorAll('[data-pm-o-claim]').forEach(function (btn) {
        btn.onclick = async function () {
          const w = byId[btn.getAttribute('data-pm-o-claim')]
          const ok = await confirm({
            title: '领取打款任务',
            message: '领取提现单 <b>' + esc(w.no) + '</b> 后，由你负责在商户平台人工打款并回填。审核人不得回填自己审核的提现单。',
            okText: '确认领取'
          })
          if (!ok) return
          btn.disabled = true
          try {
            await api('promote.payoutClaim', { id: w.id })
            toast('已领取')
            renderPromotePayout(root)
          } catch (err) {
            toast(err.message, 'err')
            btn.disabled = false
          }
        }
      })
      box.querySelectorAll('[data-pm-o-export]').forEach(function (btn) {
        btn.onclick = function () { exportPayout(btn.getAttribute('data-pm-o-export'), byId) }
      })
      box.querySelectorAll('[data-pm-o-fill]').forEach(function (btn) {
        btn.onclick = function () { openPayoutModal(byId[btn.getAttribute('data-pm-o-fill')], root) }
      })
      box.querySelectorAll('[data-pm-o-fail]').forEach(function (btn) {
        btn.onclick = function () { openPayoutFail(byId[btn.getAttribute('data-pm-o-fail')], root) }
      })
      box.querySelectorAll('[data-pm-o-cancel]').forEach(function (btn) {
        btn.onclick = function () { openPayoutCancel(byId[btn.getAttribute('data-pm-o-cancel')], root) }
      })
    } catch (err) {
      box.innerHTML = card('待打款清单', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  function promoteDownload(filename, content) {
    const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || ('推广打款_' + Date.now() + '.csv')
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 1500)
  }

  async function exportPayout(id, byId) {
    const w = byId && byId[id]
    try {
      const data = await api('promote.payoutExport', { id: id, ids: [id], no: w ? w.no : '' })
      const content = typeof data === 'string' ? data : (data && (data.csv || data.content))
      if (content) return promoteDownload(data.filename || ((w ? w.no : '推广打款') + '.csv'), content)
      if (data && (data.url || data.downloadUrl)) return window.open(data.url || data.downloadUrl, '_blank')
      if (data && Array.isArray(data.items)) {
        const head = ['提现单号', '收款人', '金额', '路径', '生成时间', '状态']
        const lines = data.items.map(function (x) {
          return [x.no || x.withdrawalNo || '', x.nick || x.payee || '', Number(x.net || x.amount || 0).toFixed(2), promotePathText(x.method), promoteDate(x.createdAt || x.reviewedAt), promoteStatusOf(x.status)]
            .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"' }).join(',')
        })
        return promoteDownload((w ? w.no : '推广打款') + '.csv', [head.join(',')].concat(lines).join('\n'))
      }
      toast('导出已提交', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  async function openPayoutModal(w, root) {
    if (!w) return
    const threshold = PROMOTE.settings.manualDualCheckThreshold || 5000
    /* 已冲正 / 被占用佣金不会生成出款明细，实际应付 = 净额 − 未覆盖金额 */
    const payable = Math.max(0, Math.round((Number(w.net) - Number(w.uncoveredAmount || 0)) * 100) / 100)
    const accounts = await api('account.list', {}).catch(function () { return { items: [] } })
    const users = promoteList(accounts)
    const me = state.account || {}
    const optionsHtml = users.filter(function (a) {
      const name = promotePick(a, ['name', 'username', 'nick', 'displayName'], '')
      return name && name !== w.reviewedBy && name !== w.claimedBy
    }).map(function (a) {
      const name = promotePick(a, ['name', 'username', 'nick', 'displayName'], '')
      return '<option value="' + esc(name) + '">' + esc(name) + (a.role ? ' · ' + esc(a.role) : '') + '</option>'
    }).join('')
    const checkerControl = optionsHtml
      ? '<select id="pm-f-checker"><option value="">请选择</option>' + optionsHtml + '</select>'
      : '<input id="pm-f-checker" placeholder="请输入复核人姓名（账号列表不可用时手工填写）">'
    const nowLocal = (function () {
      const d = new Date()
      const pad = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    })()
    const m = modal({
      title: '回填出款',
      sub: '提现单 ' + w.no + ' · 净额 ' + promoteMoney(w.net),
      wide: true,
      body: '<div class="setting-row" style="margin-bottom:12px"><div class="info">' +
          '<div class="small" style="color:var(--muted-2)">请按推广者登记的收款银行卡打款</div>' +
          '<div class="strong">' + esc(w.bankHolder || '未填写持卡人') + ' · ' + esc(w.bankName || '未填写开户行') + '</div>' +
          '<div class="mono strong" style="font-size:16px">' + esc(w.bankAccount || w.bankAccountMasked || '未登记卡号') + '</div>' +
          (w.bankReady === false ? '<div class="small" style="color:var(--danger)">该提现单未登记完整银行卡，请先让推广者在推广中心补全后再回填</div>' : '') +
        '</div></div>' +
        field('出款路径', '<select id="pm-f-path"><option value="">请选择</option>' +
          '<option value="A"' + (promotePathValue(w.method) === 'A' ? ' selected' : '') + '>A 手动分账（微信服务商）</option>' +
          '<option value="B"' + (promotePathValue(w.method) === 'B' ? ' selected' : '') + '>B 手动转账（银行卡 / 微信）</option></select>') +
        field('单据号', '<input id="pm-f-no" placeholder="微信分账单号 / 银行流水号，全局唯一" value="' + esc(w.payoutNo) + '">') +
        '<div class="small" style="margin-top:-4px;color:var(--muted-2)">单据号必填且全局唯一，建议按路径加前缀（如 FX-A- / FX-B-）。</div>' +
        field('实际出款金额（元）', '<input id="pm-f-amount" type="number" step="0.01" min="0" value="' + payable.toFixed(2) + '">') +
        '<div id="pm-f-amount-tip" class="small" style="color:var(--danger);display:none">实际出款金额不得超过提现净额 ' + Number(w.net).toFixed(2) + ' 元，禁止提交</div>' +
        '<div class="small" style="margin-top:-4px;color:var(--muted-2)">可用明细合计 ' + payable.toFixed(2) + ' 元' +
          (Number(w.uncoveredAmount || 0) > 0 ? '（净额 ' + Number(w.net).toFixed(2) + ' 元，其中 ' + Number(w.uncoveredAmount).toFixed(2) + ' 元因佣金已冲正 / 被占用无法覆盖，差额记入 uncovered 并对账告警）' : '') +
          '。回填金额须与可用明细合计一致。</div>' +
        field('出款时间', '<input id="pm-f-time" type="datetime-local" value="' + nowLocal + '">') +
        field('凭证截图', '<input id="pm-f-file" type="file" accept="image/*"><div id="pm-f-file-tip" class="small" style="color:var(--muted-2)">支持 png / jpg，上传成功后自动关联</div>') +
        field('复核人', checkerControl) +
        '<div class="small" style="margin-top:-4px;color:var(--muted-2)">金额 ≥ ' + num(threshold) + ' 元必填，且复核人 ≠ 审核人（' + esc(w.reviewedBy || '未记录') + '）≠ 执行人（' + esc(w.claimedBy || me.name || '未领取') + '）。</div>' +
        field('备注', '<input id="pm-f-note" placeholder="选填，如银行流水备注、异常说明" value="' + esc(w.note) + '">'),
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="pm-f-submit">提交回填</button>'
    })
    if (!m) return
    let voucher = w.voucherUrl || ''
    const fileInput = m.body.querySelector('#pm-f-file')
    const fileTip = m.body.querySelector('#pm-f-file-tip')
    fileInput.onchange = async function () {
      const file = fileInput.files && fileInput.files[0]
      if (!file) return
      fileTip.textContent = '上传中…'
      try {
        const uploaded = await mediaUpload(file)
        const fileId = typeof uploaded === 'string' ? uploaded : (uploaded && (uploaded.fileId || uploaded.id))
        if (!fileId) throw new Error('上传失败，请重试')
        voucher = fileId
        fileTip.textContent = '凭证已上传：' + file.name
        fileTip.style.color = 'var(--ok)'
      } catch (err) {
        voucher = ''
        fileTip.textContent = err.message || '上传失败，请重试'
        fileTip.style.color = 'var(--danger)'
      }
    }
    const amountInput = m.body.querySelector('#pm-f-amount')
    const amountTip = m.body.querySelector('#pm-f-amount-tip')
    amountInput.oninput = function () {
      const v = Number(amountInput.value) || 0
      const diff = Math.abs(v - payable) > 0.005
      amountTip.textContent = '实际出款金额须等于可用明细合计 ' + payable.toFixed(2) + ' 元（提现净额 ' + Number(w.net).toFixed(2) + ' 元），禁止提交'
      amountTip.style.display = diff ? 'block' : 'none'
    }
    m.foot.querySelector('#pm-f-submit').onclick = async function () {
      const path = m.body.querySelector('#pm-f-path').value
      const payoutNo = m.body.querySelector('#pm-f-no').value.trim()
      const amount = Number(amountInput.value)
      const payoutAt = m.body.querySelector('#pm-f-time').value
      const checker = m.body.querySelector('#pm-f-checker').value
      const note = m.body.querySelector('#pm-f-note').value.trim()
      if (!path) return toast('请选择出款路径', 'err')
      if (!payoutNo) return toast('请填写单据号（必填且全局唯一）', 'err')
      if (w.payoutNo && w.status !== '打款失败') return toast('已回填，无需重复提交', 'err')
      const dup = (PROMOTE.payout.raw || []).map(promoteWithdraw).filter(function (y) {
        return String(y.id) !== String(w.id) && y.payoutNo === payoutNo
      })[0]
      if (dup) return toast('该单据号已存在于提现单 ' + (dup.no || dup.id), 'err')
      if (!amount || amount <= 0) return toast('请填写实际出款金额', 'err')
      if (Math.abs(amount - payable) > 0.005) return toast('实际出款金额须等于可用明细合计 ' + payable.toFixed(2) + ' 元（提现净额 ' + Number(w.net).toFixed(2) + ' 元）', 'err')
      if (!payoutAt) return toast('请选择出款时间', 'err')
      if (!voucher) return toast('请上传凭证截图', 'err')
      if (amount >= threshold) {
        if (!checker) return toast('金额 ≥ ' + num(threshold) + ' 元，请选择第二复核人', 'err')
        if (checker === w.reviewedBy) return toast('复核人不能与审核人相同', 'err')
        if (checker === w.claimedBy || checker === me.name) return toast('复核人不能与执行人相同', 'err')
      }
      this.disabled = true
      try {
        await api('promote.payoutMark', {
          id: w.id, result: 'success', path: path, payoutNo: payoutNo,
          amount: Number(amount.toFixed(2)), payoutAt: new Date(payoutAt).getTime(),
          voucherUrl: voucher, checkedBy: checker, note: note
        })
        closeModal()
        toast('回填成功，等待对账')
        renderPromotePayout(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  function openPayoutFail(w, root) {
    const m = modal({
      title: '标记打款失败',
      sub: '提现单 ' + w.no,
      body: '<div class="field"><label>失败原因（必填）</label><textarea id="pm-fail-reason" rows="4" placeholder="如：银行卡号错误、商户平台余额不足"></textarea></div>' +
        '<div class="small" style="margin-top:6px;color:var(--muted-2)">标记失败后金额不会自动退回，可在待打款列表执行「退回余额」。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="pm-fail-ok">确认失败</button>'
    })
    if (!m) return
    m.foot.querySelector('#pm-fail-ok').onclick = async function () {
      const reason = m.body.querySelector('#pm-fail-reason').value.trim()
      if (!reason) return toast('请填写失败原因', 'err')
      this.disabled = true
      try {
        await api('promote.payoutMark', { id: w.id, result: 'failed', failReason: reason })
        closeModal()
        toast('已标记失败')
        renderPromotePayout(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  function openPayoutCancel(w, root) {
    const m = modal({
      title: '退回余额',
      sub: '提现单 ' + w.no + ' · 净额 ' + promoteMoney(w.net),
      body: '<div class="field"><label>退回原因（必填）</label><textarea id="pm-cancel-reason" rows="4" placeholder="请填写退回原因，操作会记入审计日志"></textarea></div>' +
        '<div class="small" style="margin-top:6px;color:var(--danger)">退回后提现单关闭，金额回到推广者可提现余额；本操作不可撤销。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="pm-cancel-ok">确认退回</button>'
    })
    if (!m) return
    m.foot.querySelector('#pm-cancel-ok').onclick = async function () {
      const reason = m.body.querySelector('#pm-cancel-reason').value.trim()
      if (!reason) return toast('请填写退回原因', 'err')
      this.disabled = true
      try {
        await api('promote.payoutCancel', { id: w.id, reason: reason })
        closeModal()
        toast('已退回余额')
        renderPromotePayout(root)
      } catch (err) {
        toast(err.message, 'err')
        this.disabled = false
      }
    }
  }

  async function renderPromoteItems(root) {
    const f = PROMOTE.items
    root.innerHTML = filterBar([
      '<div class="field" style="min-width:320px"><label>检索</label><input id="pm-i-q" placeholder="单据号 / 交易单号 / 提现单号" value="' + esc(f.q) + '"></div>',
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pm-i-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) + '<div id="pm-i-list" style="margin-top:12px">' + loadingBlock('读取出款明细') + '</div>'
    root.querySelector('#pm-i-search').onclick = function () {
      f.q = root.querySelector('#pm-i-q').value.trim()
      f.page = 1
      renderPromoteItems(root)
    }
    const box = root.querySelector('#pm-i-list')
    try {
      const data = await api('promote.payoutItems', { q: f.q, page: f.page, limit: f.limit })
      const raw = promoteList(data)
      const rows = raw.map(function (it) {
        const voucher = promotePick(it, ['voucherUrl', 'voucher', 'proofUrl'], '')
        const isUrl = /^https?:\/\//i.test(String(voucher))
        return '<td class="mono">' + esc(promotePick(it, ['payoutNo', 'orderNo', 'no', 'id'], '—')) + '</td>' +
          '<td class="mono">' + esc(promotePick(it, ['transactionId', 'tradeNo', 'payNo', 'payoutTransactionId'], '—')) + '</td>' +
          '<td class="mono">' + esc(promotePick(it, ['withdrawalNo', 'withdrawNo', 'withdrawalId'], '—')) + '</td>' +
          '<td class="mono strong">' + promoteMoney(promotePick(it, ['amount', 'itemAmount', 'netAmount'], 0)) + '</td>' +
          '<td>' + promoteStatusBadge(promotePick(it, ['status'], '')) + '</td>' +
          '<td>' + esc(promotePick(it, ['executor', 'claimedBy', 'operator'], '—')) + '</td>' +
          '<td>' + esc(promoteDate(promotePick(it, ['filledAt', 'payoutAt', 'updatedAt', 'createdAt'], 0))) + '</td>' +
          '<td>' + (isUrl ? '<button class="btn xs ghost" data-pm-voucher="' + esc(voucher) + '">查看凭证</button>' : (voucher ? '<span class="small" style="color:var(--ok)">已上传</span>' : '—')) + '</td>'
      })
      box.innerHTML = table(['单据号', '交易单号', '提现单号', '明细金额', '状态', '执行人', '回填时间', '凭证'], rows, '暂无出款明细') +
        (rows.length ? pager(promoteTotal(data, raw), f.page, f.limit) : '')
      wirePager(box, function (page) { f.page = page; renderPromoteItems(root) })
      box.querySelectorAll('[data-pm-voucher]').forEach(function (btn) {
        btn.onclick = function () { previewImage(btn.getAttribute('data-pm-voucher')) }
      })
    } catch (err) {
      box.innerHTML = card('出款明细', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  async function renderPromoteRules(root) {
    const s = PROMOTE.settings
    const ratePct = function (v) { const n = Number(v) || 0; return n > 0 && n <= 1 ? n * 100 : n }
    const disabled = promoteIsAdmin() ? '' : ' disabled'
    let diffs = []
    let reconcileError = ''
    try {
      const data = await api('promote.reconcile', {})
      diffs = (data && (data.diffs || data.differences || data.items)) || []
      PROMOTE.reconcile.diffs = diffs
    } catch (err) {
      reconcileError = err.message
    }
    root.innerHTML = card('规则配置',
      '<div class="strong" style="margin-bottom:8px">客服绑定用户推广（两级佣金）</div>' +
      '<div class="grid g3" style="gap:12px">' +
        field('一级佣金比例（%）', '<input id="pm-r-cs1" type="number" step="0.01" min="0" max="100" value="' + ratePct(s.csLevel1Rate === undefined ? s.commissionRate : s.csLevel1Rate) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">客服绑定的推广账号：直接下级首次付款计一级</div>') +
        field('二级佣金比例（%）', '<input id="pm-r-l2rate" type="number" step="0.01" min="0" max="100" value="' + ratePct(s.level2Rate) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">客服绑定的推广账号：其下级的直接下级首次付款计二级</div>') +
      '</div>' +
      '<div class="strong" style="margin:14px 0 8px">普通用户推广（仅一级佣金，含商机会员）</div>' +
      '<div class="grid g3" style="gap:12px">' +
        field('一级佣金比例（%）', '<input id="pm-r-rate" type="number" step="0.01" min="0" max="100" value="' + ratePct(s.commissionRate) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">未绑定客服的推广人：好友首次开会员时给直接推广人，无二级佣金</div>') +
      '</div>' +
      '<div class="strong" style="margin:14px 0 8px">提现与结算</div>' +
      '<div class="grid g3" style="gap:12px">' +
        field('手续费率（%）', '<input id="pm-r-fee" type="number" step="0.01" min="0" max="100" value="' + ratePct(s.feeRate) + '"' + disabled + '>') +
        field('最低提现（元）', '<input id="pm-r-min" type="number" step="0.01" min="0.01" value="' + (Number(s.minWithdraw) || 0.01).toFixed(2) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">填 0.01 即不设起提门槛</div>') +
        field('冻结日（1-31）', '<input id="pm-r-freeze" type="number" step="1" min="1" max="31" value="' + (s.freezeDay || 1) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">次月解冻日，冻结期内佣金不可提现</div>') +
        field('分账比例上限（%）', '<input id="pm-r-maxsplit" type="number" step="0.1" min="0" max="100" value="' + (ratePct(s.maxSplitRatio) || 30) + '"' + disabled + '><div class="small" style="color:var(--muted-2)">商户平台分账上限，须满足佣金比例 × 95% ≤ 上限</div>') +
        field('路径 A 分账开关', '<select id="pm-r-split"' + disabled + '><option value="off"' + (s.splitEnabled ? '' : ' selected') + '>关闭（推荐：资金不冻结，只留佣金，全部走 B 商家转账）</option><option value="on"' + (s.splitEnabled ? ' selected' : '') + '>开启（整单资金冻结最长 180 天，可分账订单优先走 A）</option></select>') +
        field('双人复核阈值（元）', '<input id="pm-r-check" type="number" step="0.01" min="0" value="' + (Number(s.manualDualCheckThreshold) || 0).toFixed(2) + '"' + disabled + '>') +
        field('打款超时（小时）', '<input id="pm-r-timeout" type="number" step="1" min="1" value="' + (s.payoutTimeoutHours || 24) + '"' + disabled + '>') +
      '</div>' +
      (promoteIsAdmin()
        ? '<div class="field" style="margin-top:10px"><label>变更原因（保存必填）</label><input id="pm-r-reason" placeholder="如：2026 年 Q4 推广政策调整"></div>' +
          '<div class="flex" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="pm-r-save">保存规则</button></div>'
        : '<div class="small" style="margin-top:10px;color:var(--muted-2)">规则仅管理员可修改，财务只读。</div>'),
      '<div class="small" style="color:var(--muted-2)">两组推广比例分开生效：客服绑定账号按「客服绑定」两级计提，其余推广人（含商机会员）只按普通一级计提。</div>') +
      '<div style="margin-top:16px">' + card('对账',
        '<div class="flex flex-wrap" style="align-items:center;gap:10px;margin-bottom:10px">' +
          '<div class="grow small" style="color:var(--muted-2)">核对系统佣金台账与人工回填出款明细，差异单需逐笔核实。</div>' +
          '<button class="btn" id="pm-r-reconcile"' + (promoteIsAdmin() ? '' : ' disabled') + '>立即对账</button>' +
          '<button class="btn" id="pm-r-settle"' + (promoteIsAdmin() ? '' : ' disabled') + '>触发结算</button>' +
        '</div>' +
        (reconcileError ? '<div class="small" style="color:var(--danger);margin-bottom:8px">对账数据加载失败：' + esc(reconcileError) + '</div>' : '') +
        table(['类型', '单据号 / 提现单号', '系统金额', '实际金额', '差异原因', '状态'], diffs.map(function (d) {
          return '<td>' + esc(promotePick(d, ['type', 'diffType'], '差异')) + '</td>' +
            '<td class="mono">' + esc(promotePick(d, ['payoutNo', 'withdrawalNo', 'orderNo', 'no'], '—')) + '</td>' +
            '<td class="mono">' + promoteMoney(promotePick(d, ['expected', 'systemAmount', 'expectAmount'], 0)) + '</td>' +
            '<td class="mono">' + promoteMoney(promotePick(d, ['actual', 'actualAmount', 'payoutAmount'], 0)) + '</td>' +
            '<td>' + esc(promotePick(d, ['reason', 'message', 'remark'], '—')) + '</td>' +
            '<td>' + promoteStatusBadge(promotePick(d, ['status'], '待处理')) + '</td>'
        }), '暂无对账差异')) + '</div>'
    const save = root.querySelector('#pm-r-save')
    if (save) {
      save.onclick = async function () {
        const reason = root.querySelector('#pm-r-reason').value.trim()
        if (!reason) return toast('请填写变更原因', 'err')
        const rate = Number(root.querySelector('#pm-r-rate').value)
        const csL1Rate = Number(root.querySelector('#pm-r-cs1').value)
        const l2Rate = Number(root.querySelector('#pm-r-l2rate').value)
        const fee = Number(root.querySelector('#pm-r-fee').value)
        const minWithdraw = Number(root.querySelector('#pm-r-min').value)
        const freezeDay = Number(root.querySelector('#pm-r-freeze').value)
        const maxSplit = Number(root.querySelector('#pm-r-maxsplit').value)
        const splitOn = root.querySelector('#pm-r-split').value === 'on'
        const check = Number(root.querySelector('#pm-r-check').value)
        const timeout = Number(root.querySelector('#pm-r-timeout').value)
        if (!(rate > 0 && rate <= 100)) return toast('普通推广一级佣金比例需在 0-100 之间', 'err')
        if (!(csL1Rate > 0 && csL1Rate <= 100)) return toast('客服绑定一级佣金比例需在 0-100 之间', 'err')
        if (!(l2Rate > 0 && l2Rate <= 100)) return toast('客服绑定二级佣金比例需在 0-100 之间', 'err')
        if (!(fee >= 0 && fee <= 100)) return toast('手续费率需在 0-100 之间', 'err')
        if (!(minWithdraw >= 0.01)) return toast('最低提现金额需不少于 0.01 元', 'err')
        if (!(freezeDay >= 1 && freezeDay <= 31)) return toast('冻结日需在 1-31 之间', 'err')
        if (!(maxSplit > 0 && maxSplit <= 100)) return toast('分账比例上限需在 0-100 之间', 'err')
        if (splitOn && (rate * 0.95 > maxSplit || csL1Rate * 0.95 > maxSplit || l2Rate * 0.95 > maxSplit)) return toast('佣金比例 × 95% 不得超过分账比例上限', 'err')
        if (!(check > 0)) return toast('双人复核阈值需大于 0', 'err')
        if (!(timeout > 0)) return toast('打款超时小时需大于 0', 'err')
        save.disabled = true
        const next = {
          commissionRate: Number((rate / 100).toFixed(6)),
          csLevel1Rate: Number((csL1Rate / 100).toFixed(6)),
          level2Rate: Number((l2Rate / 100).toFixed(6)),
          feeRate: Number((fee / 100).toFixed(6)),
          minWithdraw: Number(minWithdraw.toFixed(2)), freezeDay: freezeDay,
          maxSplitRatio: Number((maxSplit / 100).toFixed(6)), splitEnabled: splitOn,
          manualDualCheckThreshold: Number(check.toFixed(2)), payoutTimeoutHours: timeout, reason: reason
        }
        try {
          const saved = await api('promote.saveSettings', next)
          PROMOTE.settings = promoteSettingsOf(saved && (saved.settings || saved.config) ? saved : next)
          toast('规则已保存')
          renderPromoteRules(root)
        } catch (err) {
          toast(err.message, 'err')
          save.disabled = false
        }
      }
    }
    const reconcile = root.querySelector('#pm-r-reconcile')
    if (reconcile) {
      reconcile.onclick = async function () {
        reconcile.disabled = true
        try {
          await api('promote.reconcile', { run: true })
          toast('对账完成')
          renderPromoteRules(root)
        } catch (err) {
          toast(err.message, 'err')
          reconcile.disabled = false
        }
      }
    }
    const settle = root.querySelector('#pm-r-settle')
    if (settle) {
      settle.onclick = async function () {
        const ok = await confirm({
          title: '触发结算',
          message: '将按当前规则结算到期佣金，请确认已核对冻结期与提现申请。',
          okText: '开始结算'
        })
        if (!ok) return
        settle.disabled = true
        try {
          const data = await api('promote.runSettle', {})
          toast('结算完成' + (data && data.count != null ? '，处理 ' + num(data.count) + ' 笔' : ''))
          renderPromoteRules(root)
        } catch (err) {
          toast(err.message, 'err')
          settle.disabled = false
        }
      }
    }
  }

  /**
   * 管理端手动开通推广：给任意未开通账号生成推广码，开通后分享任意页面即可绑定。
   * 已封禁账号不能从这里绕过，需要先在推广管理里「解封」。
   */
  async function grantPromoteTo(uid, name, onDone) {
    if (!uid) return
    const ok = await confirm({
      title: '开通推广权限',
      message: '确认给 <b>' + esc(name || uid) + '</b> 开通推广权限？开通后会自动生成推广码，TA 分享任意页面即可绑定下级并按平台比例计佣。',
      okText: '确认开通'
    })
    if (!ok) return
    try {
      const res = await api('promote.openByAdmin', { uid: uid })
      toast(res && res.opened === false ? '该用户已开通推广' : '已开通推广')
      if (onDone) onDone()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  /**
   * 用户详情「推广」页：佣金、提现、下级与付款转化一并展示。
   * 二级关系与二级佣金仅客服绑定账号可见（平台规则：两级各按 15% 计佣）。
   */
  async function renderUserPromoteTab(host, u, uid) {
    if (!host) return
    host.innerHTML = loadingBlock('读取推广数据')
    let detail
    let commissionData
    let withdrawData
    let settingData
    try {
      const res = await Promise.all([
        api('promote.detail', { uid: uid }),
        api('promote.commissions', { uid: uid, page: 1, limit: 10 }).catch(function () { return {} }),
        api('promote.withdrawList', { uid: uid, page: 1, limit: 10 }).catch(function () { return {} }),
        PROMOTE.settings.commissionRate ? Promise.resolve(PROMOTE.settings) : api('promote.settings', {}).catch(function () { return {} })
      ])
      detail = res[0] || {}
      commissionData = res[1] || {}
      withdrawData = res[2] || {}
      settingData = res[3] || {}
    } catch (err) {
      host.innerHTML = '<div class="small" style="color:var(--danger)">推广数据加载失败：' + esc(err.message) + '</div>'
      return
    }
    const d = detail
    const settings = promoteSettingsOf(settingData || PROMOTE.settings)
    const stats = d.commissionStats || {}
    const funnel = d.funnel || {}
    const l1 = funnel.level1 || {}
    const l2 = funnel.level2 || {}
    const all = funnel.total || {}
    const ws = d.withdrawStats || {}
    const counts = d.counts || {}
    const opened = d.opened || {}
    const csBound = d.csBound === true
    const rate1 = d.rateText || promoteRate(csBound ? settings.csLevel1Rate : settings.commissionRate)
    const rate2 = d.level2RateText || promoteRate(settings.level2Rate)
    const commissions = (commissionData.items || [])
    const withdrawals = (withdrawData.items || [])
    const dash = '<span style="color:var(--muted-2)">—</span>'

    const childTable = function (rows, emptyText) {
      return table(['下级用户', '会员', '推广资格', '绑定时间', '付款', '累计付款', '贡献佣金'], (rows || []).map(function (r) {
        return '<td><div class="strong">' + esc(r.nick || '未命名用户') + '</div>' +
            '<div class="small mono" style="color:var(--muted-2)">' + esc(r.userNo || r.uid) + (r.parentNick ? ' · 上级 ' + esc(r.parentNick) : '') + '</div></td>' +
          '<td>' + esc(r.memberText || (r.member ? '已开通' : '未开通')) + '</td>' +
          '<td>' + esc(r.promoterStatusText || '—') + '</td>' +
          '<td>' + (r.boundAt ? dateText(r.boundAt) : '—') + '</td>' +
          '<td>' + (r.paid ? badge('已付款 ' + num(r.paidCount) + ' 次', 'ok') : badge('未付款')) + '</td>' +
          '<td class="mono">' + promoteMoney(r.paidAmount) + '</td>' +
          '<td class="mono strong">' + promoteMoney(r.commission) + '</td>'
      }), emptyText)
    }

    host.innerHTML =
      '<div class="flex" style="align-items:center;gap:8px;margin-bottom:10px">' +
        '<div class="strong">推广与佣金</div>' +
        '<span class="small" style="color:var(--muted-2)">' + (csBound ? '客服绑定推广（一级 / 二级）：' + esc(rate1) + ' / ' + esc(rate2) : '普通推广（仅一级）：' + esc(rate1)) + '</span>' +
        '<div class="grow"></div>' +
        (promoteIsAdmin() && (d.status === 'none' || d.statusText === '未开通')
          ? '<button class="btn xs primary" id="u-promote-open">开通推广</button>' : '') +
        '<button class="btn xs" id="u-promote-refresh">刷新</button>' +
      '</div>' +
      kpiRow([
        ['累计佣金（毛额）', promoteMoney(stats.total || d.earning)],
        ['可提现', promoteMoney(d.available)],
        ['待结算', promoteMoney(d.pending)],
        ['已提现', promoteMoney(ws.withdrawn || d.withdrawn)],
        ['欠款 / 提现中', promoteMoney(d.debt) + ' / ' + promoteMoney(ws.withdrawing)]
      ]) +
      '<div style="margin-top:14px">' + kpiRow([
        ['下级用户', num(all.total)],
        ['已付款用户', num(all.paid)],
        ['付款比例', pct(all.rate)],
        ['累计付款金额', promoteMoney(all.paidAmount)],
        ['下级会员 / 推广员', num(all.member) + ' / ' + num(all.promoter)]
      ]) + '</div>' +
      '<div style="margin-top:16px">' + kvList([
        ['推广状态', promoteStatusBadge(d.statusText || d.status)],
        ['推广码', d.refCode ? '<span class="mono">' + esc(d.refCode) + '</span>' : dash],
        ['客服绑定', csBound
          ? badge('已绑定' + (d.csName ? ' · ' + esc(d.csName) : ''), 'ok')
          : badge('未绑定客服（仅一级佣金）', 'info')],
        ['开通时间', d.openedAt ? dateText(d.openedAt) : dash],
        ['一级 / 二级人数', num(counts.level1) + ' / ' + (csBound ? num(counts.level2) : dash)],
        ['一级 / 二级已付款', num(l1.paid) + ' / ' + (csBound ? num(l2.paid) : dash)],
        ['一级 / 二级付款比例', pct(l1.rate) + ' / ' + (csBound ? pct(l2.rate) : dash)],
        ['一级 / 二级会员', num(opened.level1Member) + ' / ' + (csBound ? num(opened.level2Member) : dash)],
        ['一级 / 二级佣金', promoteMoney(d.level1Earning) + ' / ' + (csBound ? promoteMoney(d.level2Earning) : dash)],
        ['佣金明细笔数 / 冲正', num(stats.count) + ' 笔 / ' + promoteMoney(stats.reversed) + '（' + num(stats.level1Count) + ' 一级 · ' + num(stats.level2Count) + ' 二级）'],
        ['提现记录', num(ws.total) + ' 笔 · 已到账 ' + num(ws.paidCount) + ' 笔'],
        ['佣金口径', '一级 ' + esc(rate1) + ' · 二级 ' + esc(rate2) + (csBound ? '（客服绑定账号两级均计佣）' : '（未绑定客服只计一级）')]
      ]) + '</div>' +
      '<div class="strong" style="margin:18px 0 8px">层级转化</div>' +
      table(['层级', '下级人数', '已付款', '付款比例', '累计付款', '贡献佣金', '佣金比例'], [
        '<td>一级</td><td>' + num(l1.total) + '</td><td>' + num(l1.paid) + '</td><td>' + pct(l1.rate) + '</td>' +
          '<td class="mono">' + promoteMoney(l1.paidAmount) + '</td><td class="mono strong">' + promoteMoney(d.level1Earning) + '</td><td>' + esc(rate1) + '</td>',
        csBound
          ? '<td>二级</td><td>' + num(l2.total) + '</td><td>' + num(l2.paid) + '</td><td>' + pct(l2.rate) + '</td>' +
            '<td class="mono">' + promoteMoney(l2.paidAmount) + '</td><td class="mono strong">' + promoteMoney(d.level2Earning) + '</td><td>' + esc(rate2) + '</td>'
          : '<td>二级</td><td colspan="6" class="small" style="color:var(--muted-2)">该账号未绑定客服，按平台规则只计一级佣金，二级数据不展示</td>'
      ]) +
      '<div class="strong" style="margin:18px 0 8px">一级下级（' + num(counts.level1) + '）</div>' +
      childTable(d.level1, '暂无一级下级') +
      (csBound
        ? '<div class="strong" style="margin:18px 0 8px">二级下级（' + num(counts.level2) + '）</div>' +
          childTable(d.level2, '暂无二级下级')
        : '') +
      '<div class="strong" style="margin:18px 0 8px">佣金明细（最近 ' + num(commissions.length) + ' 笔）</div>' +
      table(['时间', '层级', '买家', '订单金额', '佣金', '状态'], commissions.map(function (c) {
        return '<td>' + esc(dateText(c.createdAt)) + '</td>' +
          '<td>' + (Number(c.level) === 2 ? '二级' : '一级') + '</td>' +
          '<td class="mono">' + esc(c.buyerUid || '—') + '</td>' +
          '<td class="mono">' + promoteMoney(c.paidAmount) + '</td>' +
          '<td class="mono strong">' + promoteMoney(c.amount) + '</td>' +
          '<td>' + promoteStatusBadge(c.status) + '</td>'
      }), '暂无佣金记录') +
      '<div class="strong" style="margin:18px 0 8px">提现记录（最近 ' + num(withdrawals.length) + ' 笔）</div>' +
      table(['提现单号', '申请金额', '到账净额', '状态', '申请时间', '到账时间'], withdrawals.map(function (w) {
        return '<td class="mono">' + esc(w.id || w.payoutNo || '—') + '</td>' +
          '<td class="mono">' + promoteMoney(w.amount) + '</td>' +
          '<td class="mono strong">' + promoteMoney(w.net) + '</td>' +
          '<td>' + promoteStatusBadge(w.status) + '</td>' +
          '<td>' + esc(promoteDate(w.applyAt)) + '</td>' +
          '<td>' + (w.paidAt ? esc(dateText(w.paidAt)) : '—') + '</td>'
      }), '暂无提现记录')

    const refresh = host.querySelector('#u-promote-refresh')
    if (refresh) refresh.onclick = function () { renderUserPromoteTab(host, u, uid) }
    const openBtn = host.querySelector('#u-promote-open')
    if (openBtn) openBtn.onclick = function () {
      grantPromoteTo(uid, (u && (u.nick || u.name)) || uid, function () { renderUserPromoteTab(host, u, uid) })
    }
  }

  async function renderUserPromote(host, u, uid) {
    if (!host) return
    host.innerHTML = '<div class="strong" style="margin-bottom:8px">推广信息</div>' + loadingBlock('读取推广信息')
    try {
      const [listData, wdData, settingData] = await Promise.all([
        api('promote.list', { q: uid, uid: uid, page: 1, limit: 5 }).catch(function () { return {} }),
        api('promote.withdrawList', { uid: uid, page: 1, limit: 5 }).catch(function () { return {} }),
        PROMOTE.settings.commissionRate ? Promise.resolve(PROMOTE.settings) : api('promote.settings', {}).catch(function () { return {} })
      ])
      const raw = promoteList(listData)
      let hit = raw.filter(function (p) {
        return String(promotePick(p, ['uid', 'userId', 'id'], '')) === String(uid)
      })[0] || null
      if (!hit && (u.refCode || u.promoteCode || u.promoterStatus)) hit = u
      const wds = promoteList(wdData).map(promoteWithdraw)
      const settings = promoteSettingsOf(settingData || PROMOTE.settings)
      if (!hit) {
        host.innerHTML = '<div class="strong" style="margin-bottom:8px">推广信息</div>' +
          '<div class="small" style="color:var(--muted-2)">该用户尚未开通推广，或推广关系尚未同步。平台佣金比例：客服绑定推广 一级 ' +
          promoteRate(settings.csLevel1Rate) + ' / 二级 ' + promoteRate(settings.level2Rate) +
          '；普通推广 仅一级 ' + promoteRate(settings.commissionRate) + '（只读）。</div>'
        return
      }
      const p = promotePromoter(hit)
      const splitReady = p.splitReady !== false && hit.splitReceiverReady !== false
      const banned = p.status === '封禁'
      const pathHint = banned ? '账号已封禁，暂停推广与提现'
        : (!splitReady ? '仅转账（未添加分账接收方，仅路径 B）' : '可分账（路径 A / B）')
      host.innerHTML = '<div class="flex" style="align-items:center;gap:8px;margin-bottom:8px">' +
          '<div class="strong">推广信息</div>' +
          '<div class="grow"></div>' +
          (promoteIsAdmin() && p.status === '未开通'
            ? '<button class="btn xs primary" id="u-promote-open-inline">开通推广</button>' : '') +
        '</div>' +
        kvList([
          ['推广状态', promoteStatusBadge(p.status)],
          ['推广码', '<span class="mono">' + esc(p.refCode) + '</span>'],
          ['绑定关系', '上级：' + esc(promotePick(hit, ['parentNick', 'referrerNick', 'parentId', 'referrerId'], '平台直推')) +
            ' · 绑定人数：' + num(p.bound)],
          ['绑定时间', esc(promoteDate(promotePick(hit, ['boundAt', 'referrerBoundAt', 'createdAt'], 0)))],
          ['平台比例（只读）', hit.csBound
            ? '客服绑定推广 一级 ' + promoteRate(settings.csLevel1Rate) + ' / 二级 ' + promoteRate(settings.level2Rate)
            : '普通推广 仅一级 ' + promoteRate(settings.commissionRate)],
          ['待结算 / 可提现', promoteMoney(p.pending) + ' / ' + promoteMoney(p.available)],
          ['已到账', promoteMoney(p.withdrawn)],
          ['欠款', '<span' + (p.debt > 0 ? ' style="color:var(--danger)"' : '') + '>' + promoteMoney(p.debt) + '</span>'],
          ['出款路径提示', '<span' + (splitReady && !banned ? '' : ' style="color:var(--warn)"') + '>' + esc(pathHint) + '</span>']
        ]) +
        '<div class="small" style="margin-top:14px;color:var(--muted-2)">最近提现记录</div>' +
        table(['提现单号', '净额', '路径', '状态', '申请时间'], wds.map(function (w) {
          return '<td class="mono">' + esc(w.no) + '</td>' +
            '<td class="mono">' + promoteMoney(w.net) + '</td>' +
            '<td>' + esc(promotePathText(w.method)) + '</td>' +
            '<td>' + promoteStatusBadge(w.status) + '</td>' +
            '<td>' + esc(promoteDate(w.appliedAt)) + '</td>'
        }), '暂无提现记录')
      const inlineOpen = host.querySelector('#u-promote-open-inline')
      if (inlineOpen) inlineOpen.onclick = function () {
        grantPromoteTo(uid, (u && (u.nick || u.name)) || uid, function () { renderUserPromote(host, u, uid) })
      }
    } catch (err) {
      host.innerHTML = '<div class="strong" style="margin-bottom:8px">推广信息</div>' +
        '<div class="small" style="color:var(--danger)">推广信息加载失败：' + esc(err.message) + '</div>'
    }
  }

  Pages.messages = async function (view) {
    msgStopPoll()
    /* 固定一屏：只有会话列表与消息流在框内滚动，输入框和操作按钮始终可见 */
    view.classList.add('view-fill')
    view.innerHTML = pageHead('消息中心', '用户端「联系客服」的留言都汇总在这里，回复后用户端消息列表立即能看到',
      '<button class="btn" id="msg-refresh">刷新</button>') +
      '<div class="msg-page"><div id="msg-body">' + loadingBlock('读取用户留言') + '</div></div>'
    view.querySelector('#msg-refresh').onclick = function () { Pages.messages(view) }

    let data
    try {
      data = await api('msg.threads', {})
    } catch (err) {
      view.querySelector('#msg-body').innerHTML = card('用户留言', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
      return
    }
    MSG_BOX.threads = data.items || []
    MSG_BOX.unread = Number(data.unread) || 0
    /* 消息中心只处理用户 → 平台客服的留言，用户之间的直聊不在管理端展示 */
    MSG_BOX.tab = 'kf'
    msgPollSig = msgSig(MSG_BOX.threads, MSG_BOX.unread)
    renderMsgShell(view.querySelector('#msg-body'))
    msgStartPoll(view)
  }

  function renderMsgShell(root) {
    const tabs = '<div class="seg" id="msg-tabs" style="margin-bottom:10px">' +
      '<button data-mtab="kf" class="on">咨询客服留言 ' + num(MSG_BOX.unread) + '</button>' +
      '</div>'
    const q = MSG_BOX.q.toLowerCase()
    const list = MSG_BOX.threads.filter(function (t) {
      if (!q) return true
      return ((t.nick || '') + ' ' + (t.lastBody || '') + ' ' + t.uid).toLowerCase().indexOf(q) >= 0
    })
    /* 首次进入默认展示第一条会话的内容，但不算已读：未读徽标保留到用户点击 */
    if (!MSG_BOX.uid && list.length) MSG_BOX.uid = list[0].uid
    root.innerHTML = tabs +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr);gap:16px">' +
      '<section class="card"><div class="card-head"><h3>用户留言</h3><div class="grow"></div>' +
      '<span class="badge ' + (MSG_BOX.unread ? 'danger' : '') + '" id="msg-unread">未读 ' + num(MSG_BOX.unread) + '</span></div>' +
      '<div class="card-body">' +
      '<div class="flex" style="gap:8px;margin-bottom:12px">' +
      '<input class="grow" id="msg-q" placeholder="搜索用户名 / 留言内容 / UID" value="' + esc(MSG_BOX.q) + '">' +
      '</div>' +
      '<div class="chat-layout"><div class="thread-list">' +
      (list.length ? list.map(function (t) {
        return '<div class="thread' + (t.uid === MSG_BOX.uid ? ' on' : '') + '" data-uid="' + esc(t.uid) + '">' +
          '<div class="t">' + esc(t.nick || t.uid) + (t.unread ? ' <span class="badge danger">' + num(t.unread) + '</span>' : '') + '</div>' +
          (t.leadId
            ? '<div class="s" style="color:var(--muted-2)">委托 ' + esc(t.agencyTitle || '代采代售') +
              ' · ' + esc(t.consultStageLabel || '待领取') +
              (t.leadClaimedByOther ? ' · <span style="color:var(--warn)">' + esc(t.consultCsName || '他人') + '已领取</span>' : '') + '</div>'
            : '<div class="s" style="color:var(--muted-2)">直接咨询 · 未关联委托（不产生工单）</div>') +
          '<div class="s">' + esc(t.lastBody || '暂无内容') + '</div>' +
          '<div class="m"><span>' + (t.lastFrom === 'user' ? '用户' : '平台') + '</span><span class="grow"></span><span>' + esc(ago(t.lastAt)) + '</span></div>' +
          '</div>'
      }).join('') : emptyState('暂无用户留言', '用户在小程序「联系平台」留言后会出现在这里')) +
      '</div><div class="chat-panel" id="msg-chat"></div></div></div></section></div>'

    root.querySelectorAll('#msg-tabs [data-mtab]').forEach(function (btn) {
      btn.onclick = function () { MSG_BOX.tab = btn.getAttribute('data-mtab'); renderMsgShell(root) }
    })
    const input = root.querySelector('#msg-q')
    if (input) input.onkeydown = function (e) {
      if (e.key !== 'Enter') return
      MSG_BOX.q = input.value.trim()
      renderMsgShell(root)
    }
    root.querySelectorAll('[data-uid]').forEach(function (el) {
      el.onclick = function () {
        const uid = el.getAttribute('data-uid')
        MSG_BOX.uid = uid
        /* 主动点击会话才标记已读 */
        markThreadRead(uid)
        renderMsgShell(root)
      }
    })
    if (MSG_BOX.uid) openMsgThread(MSG_BOX.uid)
  }

  /**
   * 留言会话内容：按 kind 渲染。
   * text 走原正文气泡；image / video 渲染可点击查看的媒体；card 渲染个人名片明细。
   * 媒体过期时只展示灰色占位，不再输出原链接。
   */
  function msgContentHtml(m, wm) {
    const kind = m.kind || 'text'
    const mediaId = String(m.id || '')
    if (kind === 'image') {
      const src = String(m.image || '')
      if (m.mediaExpired || !src) {
        return '<div class="body chat-media-expired">' + (m.mediaExpired ? '图片已过期' : '图片加载失败') + '</div>'
      }
      const label = wm ? String(wm.nick || '').trim() + ' · ID ' + String(wm.uid || '').slice(-8) : ''
      if (!/^https?:\/\//i.test(src)) return '<div class="body">[图片] 暂时无法预览，请点击右上角刷新后重试</div>'
      return '<div class="body chat-thumb-wrap"><img class="chat-thumb" src="' + esc(src) + '" alt="聊天图片" loading="lazy" data-img="' + esc(src) + '" data-media-id="' + esc(mediaId) + '">' +
        (label ? '<span class="chat-thumb-wm">' + esc(label.trim()) + '</span>' : '') + '</div>'
    }
    if (kind === 'video') {
      const src = String(m.video || '')
      if (m.mediaExpired || !src) {
        return '<div class="body chat-media-expired">' + (m.mediaExpired ? '视频已过期' : '视频加载失败') + '</div>'
      }
      if (!/^https?:\/\//i.test(src)) return '<div class="body">[视频] 暂时无法预览，请点击右上角刷新后重试</div>'
      const poster = /^https?:\/\//i.test(String(m.poster || '')) ? ' poster="' + esc(m.poster) + '"' : ''
      return '<div class="body chat-video-wrap"><video class="chat-video" src="' + esc(src) + '"' + poster +
        ' controls preload="metadata" data-media-id="' + esc(mediaId) + '"></video></div>'
    }
    if (kind === 'card') {
      const c = m.card || {}
      const kindText = c.subjectKind === 'company' ? '企业' : (c.subjectKind === 'person' ? '个人' : (c.subjectKind || ''))
      const rows = [
        ['主体类型', c.subjectType],
        ['主体类别', kindText],
        ['联系人', c.contact],
        ['手机号', c.phone],
        ['联系备注', c.contactNote || c.note || c.remark || ''],
        ['真实姓名', c.realname],
        ['职位', c.position]
      ].filter(function (r) { return String(r[1] == null ? '' : r[1]).trim() })
      return '<div class="chat-card detail">' +
        '<div class="cc-head">' +
        '<div class="cc-av">' + esc(c.avatar || String(c.name || '名').slice(0, 1)) + '</div>' +
        '<div class="cc-body"><div class="cc-nm">' + esc(c.name || '平台用户') + '</div>' +
        '<div class="cc-sub">' + esc(c.subject || '未填写主体名称') + '</div></div>' +
        '<span class="cc-tag">名片</span></div>' +
        '<div class="cc-rows">' + rows.map(function (r) {
          return '<div class="cc-row"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>'
        }).join('') +
        '<div class="cc-row"><b>实名状态</b><span class="' + (c.verified ? 'ok' : '') + '">' + (c.verified ? '已实名' : '未实名') + '</span></div>' +
        '</div></div>'
    }
    return '<div class="body">' + esc(m.body || '') + '</div>'
  }

  /* ---------------- 消息中心：生成咨询工单 ---------------- */

  /* 工单分类与后端 LEAD_KIND_LABELS 对应，标题前缀便于在咨询工单里快速识别诉求 */
  const LEAD_KINDS = [
    ['agency_buy', '代采委托 · 帮客户采购算力'],
    ['agency_sell', '代售委托 · 帮客户出售算力'],
    ['product', '商品采购 · 指定货源采购'],
    ['demand', '货源出售 · 对接求购需求'],
    ['other', '其他咨询 · 先沟通再定']
  ]

  /**
   * 会话里确认需求后生成工单：选类型 + 备注即可。
   * 生成后工单进入「待领取」并计入工作台待办，客服领取后回到本会话继续沟通。
   */
  function openCreateLead(uid, nick, thread) {
    const m = modal({
      title: '生成咨询工单',
      sub: '生成后进入咨询工单「待领取」，工作台同步出现待办',
      body: '<div class="form-grid">' +
        field('工单类型', '<select id="mk-kind">' + LEAD_KINDS.map(function (k) {
          return '<option value="' + k[0] + '">' + esc(k[1]) + '</option>'
        }).join('') + '</select>') +
        field('需求备注', '<textarea id="mk-note" rows="3" placeholder="客户想采购 / 出售什么、预算与交付要求（选填，最多 300 字）"></textarea>') +
        '</div>' +
        '<div class="small" style="margin-top:8px;color:var(--muted-2)">用户：' + esc(nick || uid) + ' · 会话记录会保留，领取后在同一条会话继续沟通</div>',
      footer: '<button class="btn" data-close="1">取消</button>' +
        '<button class="btn primary" id="mk-submit">生成并进入工单</button>'
    })
    if (!m) return
    const submit = m.foot.querySelector('#mk-submit')
    submit.onclick = async function () {
      const kind = m.body.querySelector('#mk-kind').value
      const note = m.body.querySelector('#mk-note').value.trim()
      submit.disabled = true
      try {
        const res = await api('lead.create', {
          uid: uid,
          kind: kind,
          note: note,
          threadId: (thread && thread.threadId) || ''
        })
        closeModal()
        toast(res && res.duplicated ? '该用户已有待领取工单，已为你打开' : '工单已生成，领取后即可处理')
        C.navigate('consult', { leadId: res.leadId })
      } catch (err) {
        toast(err.message)
        submit.disabled = false
      }
    }
  }

  async function openMsgThread(uid) {
    const panel = document.getElementById('msg-chat')
    if (!panel) return
    panel.innerHTML = loadingBlock('加载会话')
    let data
    const thread = MSG_BOX.threads.find(function (t) { return t.uid === uid })
    try {
      data = await api('msg.list', { uid: uid, page: 1, limit: 30 })
    } catch (err) {
      panel.innerHTML = '<div class="small" style="color:var(--danger);padding:16px">' + esc(err.message) + '</div>'
      return
    }
    const items = data.items || []
    const unread = thread ? Number(thread.unread) || 0 : 0
    /* 已被他人领取：管理员可查看历史，但不能回复 / 发图片视频，需先转单 */
    const locked = !!(thread && thread.leadClaimedByOther)
    const lockNote = locked
      ? '<div class="chat-note" style="text-align:left">该咨询已由 ' + esc(thread.consultCsName || '其他客服') +
        ' 领取，只有领取人可以回复；需要接手请先转单</div>'
      : ''
    const step = thread && thread.consultStage ? cfStepIndex(thread.consultStage) : -1
    /* 咨询三态分流：待领取只进工作台；磋商中在本会话谈条件；谈妥后才生成工单进工单中心 */
    const ticketState = (thread && thread.ticketState) || ''
    let consultBar = ''
    if (thread && thread.leadId && ticketState === 'consulting') {
      consultBar = '<div class="chat-note" style="display:flex;align-items:center;gap:8px;text-align:left">' +
        '<span>委托咨询 · ' + esc(thread.agencyTitle || '代采代售委托') + ' · 磋商中 · ' +
        esc(thread.consultCsName || '待客服联系') + '（条件谈妥后再生成工单）</span>' +
        '<span class="grow"></span>' +
        (C.can('consult.openTicket')
          ? '<button class="btn xs primary" id="msg-open-ticket">生成工单</button>'
          : '') + '</div>'
    } else if (thread && thread.leadId && ticketState === 'invalid') {
      consultBar = '<div class="chat-note" style="text-align:left">' +
        '本次委托咨询已结束（无效咨询）· 未生成工单</div>'
    } else if (thread && thread.leadId && ticketState !== 'intake') {
      consultBar = '<div class="chat-note" style="display:flex;align-items:center;gap:8px;text-align:left">' +
        '<span>委托咨询 · ' + esc(thread.agencyTitle || '代采代售委托') +
        (step >= 0
          ? ' · 第 ' + (step + 1) + '/' + CF_STAGES.length + ' 步 ' + esc(thread.consultStageLabel || '')
          : ' · 待领取') +
        ' · ' + esc(thread.consultCsName || '待客服联系') + '</span>' +
        '<span class="grow"></span>' +
        '<button class="btn xs primary" id="msg-open-consult">进入委托工单</button></div>'
    } else if (thread && thread.leadId) {
      /* 待领取咨询不写消息，正常不会出现在这里；兜底引导回工作台领取 */
      consultBar = '<div class="chat-note" style="display:flex;align-items:center;gap:8px;text-align:left">' +
        '<span>委托咨询 · ' + esc(thread.agencyTitle || '代采代售委托') + ' · 待领取（领取后才会接入消息中心）</span>' +
        '<span class="grow"></span>' +
        '<button class="btn xs primary" id="msg-go-workbench">去工作台领取</button></div>'
    } else if (C.canPage('consult')) {
      consultBar = '<div class="chat-note" style="display:flex;align-items:center;gap:8px;text-align:left">' +
        '<span>直接咨询 · 尚未生成工单。确认客户需求后生成，工单直接进入工单中心并归到你名下</span>' +
        '<span class="grow"></span>' +
        '<button class="btn xs primary" id="msg-new-consult">生成工单</button></div>'
    }
    panel.innerHTML =
      consultBar +
      '<div class="chat-note">与 ' + esc(data.nick || uid) + ' 的会话 · 共 ' + num(data.total) + ' 条' +
      (unread ? ' · 未读 ' + num(unread) : '') + '</div>' +
      '<div class="chat-stream" id="msg-stream">' +
      (items.length ? items.map(function (m) {
        if (m.from !== 'user' && m.from !== 'staff') {
          return '<div class="chat-note" style="text-align:center">' + esc(m.title || '系统通知') + (m.body ? '：' + esc(m.body) : '') + '</div>'
        }
        return '<div class="chat-bubble' + (m.from === 'staff' ? ' me' : '') + '">' +
          '<div class="meta">' + esc(m.from === 'staff' ? (m.staffName || '平台') : '用户') + ' · ' + esc(dateText(m.createdAt)) + '</div>' +
          msgContentHtml(m, { uid: data.uid || uid, nick: data.nick }) + '</div>'
      }).join('') : emptyState('会话暂无内容')) +
      '</div>' +
      (locked
        ? lockNote
        : '<div style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:12px">' +
          quickReplyBar(thread && thread.consultStage) +
          '<textarea id="msg-reply" rows="3" placeholder="输入回复内容，请勿索要手机号 / 证件号（最多 500 字）"></textarea>' +
          '<input type="file" id="msg-img-file" accept="image/*" hidden>' +
          '<input type="file" id="msg-video-file" accept="video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v" hidden>' +
          '<div class="flex" style="justify-content:flex-end;gap:8px">' +
          '<button class="btn" id="msg-send-image">图片</button>' +
          '<button class="btn" id="msg-send-video">视频</button>' +
          (unread ? '<button class="btn" id="msg-mark-read">标为已读</button>' : '') +
          '<button class="btn primary" id="msg-send">发送回复</button></div></div>')

    /* 图片点击先调 msg.mediaOpen 续期，再打开灯箱；视频首次播放时续期 */
    mediaBind(panel)

    /* 常用语：点一下填入回复框，客服可先改再发 */
    wireQuickReplies(panel, '#msg-reply')

    /* 跳转委托工单：工单页会按 leadId 定位，右侧直接是委托内容与双方联系方式 */
    const consultBtn = panel.querySelector('#msg-open-consult')
    if (consultBtn) {
      consultBtn.onclick = function () { C.navigate('consult', { leadId: thread.leadId }) }
    }

    /* 磋商完成建单：条件谈妥后才把咨询转成工单，建单后直接进入工单流程 */
    const openTicketBtn = panel.querySelector('#msg-open-ticket')
    if (openTicketBtn) {
      openTicketBtn.onclick = async function () {
        const ok = await confirm({
          title: '生成工单',
          message: '确认双方委托条件已谈妥？生成后进入工单中心并开启分步流程，本会话继续沿用。',
          okText: '生成工单'
        })
        if (!ok) return
        openTicketBtn.disabled = true
        try {
          await api('consult.openTicket', { leadId: thread.leadId })
          toast('工单已生成')
          C.navigate('consult', { leadId: thread.leadId })
        } catch (err) {
          toast(err.message, 'err')
          openTicketBtn.disabled = false
        }
      }
    }

    /* 待领取咨询不写消息，兜底引导回工作台领取 */
    const goWorkbench = panel.querySelector('#msg-go-workbench')
    if (goWorkbench) goWorkbench.onclick = function () { C.navigate('workbench') }

    /* 生成工单：选类型 + 备注，建单后直接进入咨询工单，工单为「待领取」计入工作台待办 */
    const newLeadBtn = panel.querySelector('#msg-new-consult')
    if (newLeadBtn) {
      newLeadBtn.onclick = function () { openCreateLead(uid, data.nick, thread) }
    }

    const stream = panel.querySelector('#msg-stream')
    if (stream) {
      if (MSG_BOX.scrollTop != null && MSG_BOX.scrollUid === uid) {
        stream.scrollTop = MSG_BOX.scrollTop
      } else {
        stream.scrollTop = stream.scrollHeight
      }
      MSG_BOX.scrollTop = null
      MSG_BOX.scrollUid = ''
    }

    /* 自动刷新重绘后恢复未发送的回复草稿 */
    const replyBox = panel.querySelector('#msg-reply')
    if (replyBox && MSG_BOX.draft) {
      replyBox.value = MSG_BOX.draft
      MSG_BOX.draft = ''
    }

    /* 打开会话只展示内容，不自动标已读；需要用户点「标为已读」或点击左栏会话 */
    const markBtn = panel.querySelector('#msg-mark-read')
    if (markBtn) markBtn.onclick = function () {
      markThreadRead(uid)
      const root = document.getElementById('msg-body')
      if (root) renderMsgShell(root)
    }

    /* 图片 / 视频：选中后校验大小并上传，成功后走 msg.reply 发送并刷新会话 */
    const threadId = (thread && thread.leadId) || ''
    const imgInput = panel.querySelector('#msg-img-file')
    const videoInput = panel.querySelector('#msg-video-file')
    const pickFile = function (input) {
      if (!input) return
      input.value = ''
      input.click()
    }
    const sendImgBtn = panel.querySelector('#msg-send-image')
    const sendVideoBtn = panel.querySelector('#msg-send-video')
    if (sendImgBtn) sendImgBtn.onclick = function () { pickFile(imgInput) }
    if (sendVideoBtn) sendVideoBtn.onclick = function () { pickFile(videoInput) }
    if (imgInput) imgInput.onchange = function () {
      mediaSendToUser(uid, 'image', this.files && this.files[0], threadId)
    }
    if (videoInput) videoInput.onchange = function () {
      mediaSendToUser(uid, 'video', this.files && this.files[0], threadId)
    }

    const sendBtn = panel.querySelector('#msg-send')
    if (sendBtn) sendBtn.onclick = async function () {
      const btn = this
      const box = panel.querySelector('#msg-reply')
      const body = box.value.trim()
      if (!body) return toast('请先输入回复内容', 'err')
      btn.disabled = true
      try {
        const payload = { uid: uid, body: body }
        /* 咨询会话必须带 threadId，后端据此校验领取归属 */
        if (threadId) payload.threadId = threadId
        await api('msg.reply', payload)
        toast('回复已发送')
        box.value = ''
        openMsgThread(uid)
      } catch (err) {
        toast(err.message, 'err')
        btn.disabled = false
      }
    }
  }

  /* ---------------- 8.5 监督：审计 / 服务记录 / 系统日志 ---------------- */

  const AUDIT_FILTER = { action: '', actorId: '', result: '', days: '30', page: 1, limit: 20 }
  const AUDIT_RESULTS = [
    { value: 'allow', label: '成功' },
    { value: 'UNAUTHENTICATED', label: '认证失败' },
    { value: 'FORBIDDEN', label: '无权限' },
    { value: 'CONFLICT', label: '状态冲突' },
    { value: 'VALIDATION', label: '校验未通过' },
    { value: 'NOT_FOUND', label: '对象不存在' }
  ]

  /* 审计日志：管理员改了什么、什么时候改的、从哪个 IP 改的 */
  Pages.audit = async function (view) {
    view.innerHTML = pageHead('审计日志', '保留 180 天：分配、审核、退款、权限调整等敏感动作逐条留痕') +
      '<div id="audit-body">' + loadingBlock('读取审计日志') + '</div>'
    await loadAudit(view.querySelector('#audit-body'))
  }

  async function loadAudit(root) {
    const days = Number(AUDIT_FILTER.days) || 30
    const params = {
      action: AUDIT_FILTER.action,
      actorId: AUDIT_FILTER.actorId,
      result: AUDIT_FILTER.result,
      from: Date.now() - days * 24 * 60 * 60 * 1000,
      page: AUDIT_FILTER.page,
      limit: AUDIT_FILTER.limit
    }
    try {
      const data = await api('audit.list', params)
      const items = data.items || []
      root.innerHTML =
        '<div class="filters">' +
        '<div class="field"><label>动作编码</label><input id="au-action" placeholder="如 lead.assign" value="' + esc(AUDIT_FILTER.action) + '"></div>' +
        '<div class="field"><label>操作人</label><input id="au-actor" placeholder="账号名" value="' + esc(AUDIT_FILTER.actorId) + '"></div>' +
        '<div class="field"><label>结果</label><select id="au-result">' + options(AUDIT_RESULTS, AUDIT_FILTER.result) + '</select></div>' +
        '<div class="field"><label>时间范围</label><select id="au-days">' + options([{ value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '180', label: '最近 180 天' }], AUDIT_FILTER.days, false) + '</select></div>' +
        '<div class="field" style="justify-content:flex-end"><button class="btn" id="au-search">' + icon('search') + '<span>查询</span></button></div>' +
        '</div>' +
        card('操作留痕', table(['时间', '操作人', '动作', '对象', '原因', '结果', '来源 IP'], items.map(function (r) {
          return '<td class="small">' + esc(r.atText || dateText(r.at)) + '</td>' +
            '<td><div>' + esc(r.actorName || r.actorId || '—') + '</div><div class="small" style="color:var(--muted-2)">' + esc(r.actorType || '') + '</div></td>' +
            '<td>' + esc(r.actionLabel || r.action) + '</td>' +
            '<td class="small mono" style="max-width:200px;word-break:break-all">' + esc(r.target || '—') + '</td>' +
            '<td class="small" style="max-width:200px">' + esc(r.reason || '—') + '</td>' +
            '<td>' + badge(r.resultLabel || r.result || '—', r.result === 'allow' ? 'ok' : 'danger', true) + '</td>' +
            '<td class="small mono">' + esc(r.ip || '—') + '</td>'
        }), '该时间范围内暂无审计记录'), '') +
        pager(data.total, data.page, data.limit)
      root.querySelector('#au-search').onclick = function () {
        AUDIT_FILTER.action = root.querySelector('#au-action').value.trim()
        AUDIT_FILTER.actorId = root.querySelector('#au-actor').value.trim()
        AUDIT_FILTER.result = root.querySelector('#au-result').value
        AUDIT_FILTER.days = root.querySelector('#au-days').value
        AUDIT_FILTER.page = 1
        loadAudit(root)
      }
      wirePager(root, function (page) { AUDIT_FILTER.page = page; loadAudit(root) })
    } catch (err) {
      root.innerHTML = card('审计日志', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  const SERVICE_FILTER = { actorId: '', leadId: '', page: 1, limit: 20 }

  /* 客服服务记录：谁领取 / 推进 / 回复了多少，以及每笔工单的处置明细 */
  Pages.service = async function (view) {
    view.innerHTML = pageHead('客服服务记录', '按坐席汇总领取、推进、释放联系方式与回复量，可下钻到单笔工单') +
      '<div id="svc-body">' + loadingBlock('读取服务记录') + '</div>'
    await loadService(view.querySelector('#svc-body'))
  }

  async function loadService(root) {
    try {
      const data = await api('service.records', {
        actorId: SERVICE_FILTER.actorId,
        leadId: SERVICE_FILTER.leadId,
        page: SERVICE_FILTER.page,
        limit: SERVICE_FILTER.limit
      })
      const staff = data.staff || []
      const items = data.items || []
      root.innerHTML =
        '<div class="grid g4">' + staff.slice(0, 8).map(function (s) {
          return kpi(s.name || s.username, num(s.handled || 0),
            '分配 ' + num(s.assign || 0) + ' · 推进 ' + num(s.status || 0) + ' · 回复 ' + num(s.reply || 0) +
            (s.lastAt ? '<div class="small" style="color:var(--muted-2)">最近 ' + esc(ago(s.lastAt)) + '</div>' : ''))
        }).join('') + '</div><div style="height:14px"></div>' +
        '<div class="filters">' +
        '<div class="field"><label>坐席</label><select id="sv-actor">' + options(staff.map(function (s) { return { value: s.username, label: s.name || s.username } }), SERVICE_FILTER.actorId) + '</select></div>' +
        '<div class="field"><label>工单 ID</label><input id="sv-lead" placeholder="按工单下钻" value="' + esc(SERVICE_FILTER.leadId) + '"></div>' +
        '<div class="field" style="justify-content:flex-end"><button class="btn" id="sv-search">' + icon('search') + '<span>查询</span></button></div>' +
        '</div>' +
        card('处置明细', table(['时间', '坐席', '动作', '工单', '说明', '结果'], items.map(function (r) {
          return '<td class="small">' + esc(dateText(r.at)) + '</td>' +
            '<td>' + esc(r.actorName || '—') + '</td>' +
            '<td>' + esc(r.actionLabel || r.action) + '</td>' +
            '<td class="small">' + (r.leadId
              ? '<a href="javascript:void(0)" data-lead="' + esc(r.leadId) + '">' + esc(r.leadTitle || r.leadId) + '</a>'
              : '—') +
            (r.leadStatus ? ' ' + autoBadge(r.leadStatus) : '') + '</td>' +
            '<td class="small" style="max-width:220px">' + esc(r.reason || '—') + '</td>' +
            '<td>' + badge(r.resultLabel || r.result || '—', r.result === 'allow' ? 'ok' : 'danger', true) + '</td>'
        }), '该筛选下暂无服务记录'), '') +
        pager(data.total, data.page, data.limit)
      root.querySelector('#sv-search').onclick = function () {
        SERVICE_FILTER.actorId = root.querySelector('#sv-actor').value
        SERVICE_FILTER.leadId = root.querySelector('#sv-lead').value.trim()
        SERVICE_FILTER.page = 1
        loadService(root)
      }
      wirePager(root, function (page) { SERVICE_FILTER.page = page; loadService(root) })
      root.querySelectorAll('[data-lead]').forEach(function (btn) {
        btn.onclick = function () {
          const leadId = btn.getAttribute('data-lead')
          /* 客服点工单号回到工作台（同一页三栏）看服务进度；管理员仍用详情抽屉 */
          if (((state.account && state.account.role) || '') === 'cs') {
            C.navigate('workbench', { leadId: leadId })
            return
          }
          openLeadDrawer(leadId, function () { loadService(root) })
        }
      })
    } catch (err) {
      root.innerHTML = card('客服服务记录', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  const LOG_FILTER = { tab: 'system', level: '', keyword: '', page: 1, limit: 20 }

  /* 系统日志：运行日志 / 登录日志 / 操作日志三类，登录失败与报错优先暴露 */
  Pages.logs = async function (view) {
    view.innerHTML = pageHead('系统日志', '运行异常、登录失败与操作留痕集中查看，便于排查与合规取证') +
      '<div id="log-body">' + loadingBlock('读取系统日志') + '</div>'
    await loadLogs(view.querySelector('#log-body'))
  }

  async function loadLogs(root) {
    try {
      const data = await api('log.list', {
        tab: LOG_FILTER.tab,
        level: LOG_FILTER.level,
        keyword: LOG_FILTER.keyword,
        page: LOG_FILTER.page,
        limit: LOG_FILTER.limit
      })
      const counts = data.counts || {}
      const items = data.items || []
      const tabs = [{ value: 'system', label: '运行日志' }, { value: 'login', label: '登录日志' }, { value: 'audit', label: '操作日志' }]
      root.innerHTML =
        '<div class="seg" id="lg-tabs">' + tabs.map(function (t) {
          return '<button data-tab="' + t.value + '" class="' + (LOG_FILTER.tab === t.value ? 'on' : '') + '">' + t.label + '</button>'
        }).join('') + '</div>' +
        '<div class="filters" style="margin-top:12px">' +
        (LOG_FILTER.tab === 'system'
          ? '<div class="field"><label>级别</label><select id="lg-level">' + options([{ value: 'info', label: 'info' }, { value: 'warn', label: 'warn' }, { value: 'error', label: 'error' }], LOG_FILTER.level) + '</select></div>'
          : '') +
        '<div class="field"><label>关键词</label><input id="lg-kw" placeholder="消息 / 账号 / IP" value="' + esc(LOG_FILTER.keyword) + '"></div>' +
        '<div class="field" style="justify-content:flex-end"><button class="btn" id="lg-search">' + icon('search') + '<span>查询</span></button></div>' +
        '</div>' +
        '<div class="small" style="color:var(--muted-2);margin-bottom:10px">' +
        '总 ' + num(data.total) + ' 条 · 错误 ' + num(counts.error) + ' · 警告 ' + num(counts.warn) + ' · 拒绝 ' + num(counts.deny) + '</div>' +
        card('日志明细', table(['时间', '级别', '来源', '主体', '消息', 'IP'], items.map(function (r) {
          const tone = r.level === 'error' ? 'danger' : (r.level === 'warn' ? 'warn' : '')
          return '<td class="small">' + esc(r.timeText || dateText(r.time)) + '</td>' +
            '<td>' + badge(r.level || 'info', tone, true) + '</td>' +
            '<td class="small">' + esc(r.source || '—') + '</td>' +
            '<td class="small">' + esc(r.actor || '—') + '</td>' +
            '<td class="small" style="max-width:320px"><div>' + esc(r.message || r.action || '—') + '</div>' +
            (r.detail ? '<div class="small" style="color:var(--muted-2)">' + esc(r.detail) + '</div>' : '') + '</td>' +
            '<td class="small mono">' + esc(r.ip || '—') + '</td>'
        }), '暂无日志'), '') +
        pager(data.total, data.page, data.limit)

      root.querySelectorAll('#lg-tabs [data-tab]').forEach(function (btn) {
        btn.onclick = function () {
          LOG_FILTER.tab = btn.getAttribute('data-tab')
          LOG_FILTER.page = 1
          loadLogs(root)
        }
      })
      root.querySelector('#lg-search').onclick = function () {
        LOG_FILTER.keyword = root.querySelector('#lg-kw').value.trim()
        const lv = root.querySelector('#lg-level')
        if (lv) LOG_FILTER.level = lv.value
        LOG_FILTER.page = 1
        loadLogs(root)
      }
      wirePager(root, function (page) { LOG_FILTER.page = page; loadLogs(root) })
    } catch (err) {
      root.innerHTML = card('系统日志', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  /* ---------------- 9. 账号与权限 ---------------- */

  const ROLE_TEXT = { admin: '管理员', cs: '客服坐席', finance: '财务专员', sales: '电销专员' }
  /* 角色名以「角色」页配置为准，内置角色用作兜底 */
  function roleNameOf(key) {
    const hit = (ACC.roles || []).find(function (r) { return r.roleKey === key })
    return (hit && hit.name) || ROLE_TEXT[key] || key || '—'
  }
  const PAGE_TEXT = {
    workbench: '工作台', stats: '数据看板', products: '货源管理',
    demands: '求购管理', leads: '咨询单', consult: '咨询工单', messages: '消息中心', service: '客服服务记录',
    audit: '审计日志', behavior: '行为中心', blocked: '已拦截', rules: '筛选规则',
    accounts: '账号与权限', users: '用户管理', biz: '商机与会员', sales: '电销线索', news: '资讯',
    boards: '榜单', risk: '风险提示', finance: '财务中心', logs: '系统日志',
    roles: '角色权限', settings: '系统设置'
  }
  const ACC = { tab: 'accounts', accounts: [], roles: [], pages: [], actions: [], permissions: [] }

  function pageText(page) { return PAGE_TEXT[page] || page }

  Pages.accounts = async function (view) {
    view.innerHTML = pageHead('账号与权限', '角色收敛为管理员与客服坐席：管理员统管审批 / 财务 / 系统设置，客服坐席负责日常对接与工单；可按需新建自定义角色补位',
      '<button class="btn" id="acc-refresh">刷新</button>') +
      '<div id="acc-body">' + loadingBlock('读取账号与权限') + '</div>'
    view.querySelector('#acc-refresh').onclick = function () { loadAccounts(view) }

    const body = view.querySelector('#acc-body')
    ACC.view = view
    try {
      const [accData, roleData] = await Promise.all([api('account.list', {}), api('role.list', {})])
      ACC.accounts = accData.items || []
      ACC.roles = roleData.roles || []
      ACC.pages = roleData.pages || []
      ACC.actions = roleData.actions || []
      ACC.permissions = roleData.permissions || []
      body.innerHTML = renderAccounts()
      wireAccounts(body, view)
    } catch (err) {
      body.innerHTML = card('账号与权限', '<div class="small" style="color:var(--danger)">' + esc(err.message) + '</div>')
    }
  }

  function loadAccounts(view) { Pages.accounts(view) }

  function renderAccounts() {
    const tabs = [['accounts', '账号'], ['roles', '角色'], ['permissions', '临时权限']]
    let panel = ''
    if (ACC.tab === 'accounts') {
      panel = table(['账号', '姓名', '角色', '来源', '状态', '操作'], ACC.accounts.map(function (a) {
        const env = a.source === 'env'
        return '<td><strong>' + esc(a.username) + '</strong><div class="small" style="color:var(--muted-2)">' + (a.source === 'env' ? '引导账号' : 'ID ' + esc(a.id || '')) + '</div></td>' +
          '<td>' + esc(a.name || '') + '</td>' +
          '<td>' + badge(roleNameOf(a.role), a.role === 'admin' ? 'info' : '') + '</td>' +
          '<td>' + (env ? '环境变量' : '后台创建') + '</td>' +
          '<td>' + autoBadge(a.status === 'active' ? '正常' : '停用') + '</td>' +
          '<td><div class="flex" style="gap:5px">' +
          (env ? '<span class="small" style="color:var(--muted-2)">环境引导账号请在云函数环境变量维护</span>' :
            '<button class="btn xs" data-reset="' + esc(a.id) + '" data-name="' + esc(a.username) + '">重置口令</button>' +
            '<button class="btn xs ' + (a.status === 'active' ? 'danger' : '') + '" data-toggle="' + esc(a.id) + '" data-name="' + esc(a.username) + '" data-status="' + esc(a.status) + '">' +
            (a.status === 'active' ? '停用' : '启用') + '</button>') +
          '</div></td>'
      }), '暂无账号') +
        '<div style="margin-top:12px"><button class="btn primary" id="acc-new-account">新建账号</button></div>' +
        '<div class="small" style="margin-top:10px;color:var(--muted-2)">角色在新增时确定，内置管理员 / 客服 / 财务账号来自环境变量，改动需在云函数环境变量里维护。</div>'
    } else if (ACC.tab === 'roles') {
      panel = table(['角色', '类型', '可见页面', '动作数', '状态', '操作'], ACC.roles.map(function (r) {
        return '<td><strong>' + esc(r.name || r.roleKey) + '</strong><div class="small" style="color:var(--muted-2)">' + esc(r.roleKey) + '</div></td>' +
          '<td>' + (r.builtin ? badge('内置', 'info') : badge('自定义')) + '</td>' +
          '<td class="small">' + esc((r.pages || []).map(pageText).join('、') || '—') + '</td>' +
          '<td>' + num((r.actions || []).length) + '</td>' +
          '<td>' + autoBadge(r.status === 'disabled' ? '停用' : '正常') + '</td>' +
          '<td>' + (r.builtin ? '<span class="small" style="color:var(--muted-2)">内置角色不可修改</span>' :
            '<div class="flex" style="gap:5px"><button class="btn xs" data-role-edit="' + esc(r.roleKey) + '">编辑</button>' +
            '<button class="btn xs danger" data-role-del="' + esc(r.roleKey) + '">删除</button></div>') + '</td>'
      }), '暂无角色') +
        '<div style="margin-top:12px"><button class="btn primary" id="acc-new-role">新建角色</button></div>'
    } else {
      panel = table(['账号', '额外页面', '额外动作', '到期', '状态', '备注', '操作'], ACC.permissions.map(function (p) {
        return '<td><strong>' + esc(p.username) + '</strong></td>' +
          '<td class="small">' + esc((p.extraPages || []).map(pageText).join('、') || '—') + '</td>' +
          '<td class="small">' + esc((p.extraActions || []).join('、') || '—') + '</td>' +
          '<td>' + esc(p.expiresText || '—') + '</td>' +
          '<td>' + autoBadge(p.status === 'active' ? '生效中' : '已失效') + '</td>' +
          '<td class="small">' + esc(p.note || '') + '</td>' +
          '<td><button class="btn xs danger" data-perm-revoke="' + esc(p.username) + '">收回</button></td>'
      }), '暂无临时权限') +
        '<div style="margin-top:12px"><button class="btn primary" id="acc-new-perm">发放临时权限</button></div>'
    }
    return '<div class="tabs" id="acc-tabs">' + tabs.map(function (t) {
      return '<button data-atab="' + t[0] + '"' + (ACC.tab === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>'
    }).join('') + '</div><div class="tab-panel" style="margin-top:14px">' + panel + '</div>'
  }

  function checkGroup(name, list, selected, cols) {
    return '<div style="display:grid;grid-template-columns:repeat(' + (cols || 3) + ',minmax(0,1fr));gap:6px;' +
      'max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px">' +
      list.map(function (item) {
        const value = typeof item === 'object' ? item.value : item
        const label = typeof item === 'object' ? item.label : pageText(item)
        return '<label style="display:flex;align-items:center;gap:6px;font-size:12px">' +
          '<input type="checkbox" name="' + name + '" value="' + esc(value) + '"' +
          ((selected || []).indexOf(value) >= 0 ? ' checked' : '') + '>' + esc(label) + '</label>'
      }).join('') + '</div>'
  }

  function picked(root, name) {
    return Array.prototype.slice.call(root.querySelectorAll('input[name="' + name + '"]:checked')).map(function (el) { return el.value })
  }

  function wireAccounts(body, view) {
    body.querySelectorAll('[data-atab]').forEach(function (btn) {
      btn.onclick = function () { ACC.tab = btn.getAttribute('data-atab'); body.innerHTML = renderAccounts(); wireAccounts(body, view) }
    })
    body.querySelectorAll('[data-reset]').forEach(function (btn) {
      btn.onclick = function () {
        const id = btn.getAttribute('data-reset')
        const username = btn.getAttribute('data-name')
        const root = modal({
          title: '重置口令',
          sub: username,
          body: field('新口令', '<input id="acc-pwd" type="password" placeholder="至少 10 位，含大小写 / 数字 / 符号">'),
          footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="acc-pwd-ok">确认重置</button>'
        })
        if (!root) return
        root.body.querySelector('#acc-pwd-ok').onclick = async function () {
          const password = root.body.querySelector('#acc-pwd').value.trim()
          if (password.length < 10) return toast('口令至少 10 位', 'err')
          this.disabled = true
          try {
            await api('account.resetPassword', { id: id, password: password })
            closeModal()
            toast('口令已重置，该账号的在线会话已失效')
          } catch (err) { toast(err.message, 'err'); this.disabled = false }
        }
      }
    })
    body.querySelectorAll('[data-toggle]').forEach(function (btn) {
      btn.onclick = async function () {
        const id = btn.getAttribute('data-toggle')
        const username = btn.getAttribute('data-name')
        const next = btn.getAttribute('data-status') === 'active' ? 'disabled' : 'active'
        const ok = await confirm({ title: next === 'disabled' ? '停用账号' : '启用账号', message: username + '：停用后该账号立即无法登录管理端。' })
        if (!ok) return
        try {
          await api('account.update', { id: id, status: next })
          toast('已更新')
          loadAccounts(view)
        } catch (err) { toast(err.message, 'err') }
      }
    })
    const newAccount = body.querySelector('#acc-new-account')
    if (newAccount) newAccount.onclick = function () { openAccountForm() }
    const newRole = body.querySelector('#acc-new-role')
    if (newRole) newRole.onclick = function () { openRoleForm(null) }
    body.querySelectorAll('[data-role-edit]').forEach(function (btn) {
      btn.onclick = function () {
        const role = ACC.roles.find(function (r) { return r.roleKey === btn.getAttribute('data-role-edit') })
        openRoleForm(role)
      }
    })
    body.querySelectorAll('[data-role-del]').forEach(function (btn) {
      btn.onclick = async function () {
        const roleKey = btn.getAttribute('data-role-del')
        const ok = await confirm({ title: '删除角色', message: '删除后该角色下的账号将失去对应权限，确认删除？', danger: true })
        if (!ok) return
        try {
          await api('role.remove', { roleKey: roleKey })
          toast('角色已删除')
          loadAccounts(view)
        } catch (err) { toast(err.message, 'err') }
      }
    })
    const newPerm = body.querySelector('#acc-new-perm')
    if (newPerm) newPerm.onclick = openPermForm
    body.querySelectorAll('[data-perm-revoke]').forEach(function (btn) {
      btn.onclick = async function () {
        const username = btn.getAttribute('data-perm-revoke')
        const ok = await confirm({ title: '收回临时权限', message: username + '：收回后该账号只保留角色本身的权限。', danger: true })
        if (!ok) return
        try {
          await api('permission.save', {
            username: username,
            extraPages: [],
            extraActions: [],
            expiresAt: Date.now() + 86400000,
            note: '后台收回'
          })
          toast('已收回')
          loadAccounts(view)
        } catch (err) { toast(err.message, 'err') }
      }
    })
  }

  /* 动态口令密钥：账号登录需要 6 位动态码，这里生成 Base32 种子交给账号使用人绑定 */
  function randomTotpSecret() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const bytes = new Uint8Array(20)
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    let out = ''
    for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % 32]
    return out
  }

  function openAccountForm() {
    /* 角色来自「角色」页：内置 + 自定义（停用的角色不再分配），页面与动作随角色自动生效 */
    const roleOpts = (ACC.roles || []).filter(function (r) {
      return r.status !== 'disabled'
    }).map(function (r) {
      return { value: r.roleKey, label: (r.name || r.roleKey) + (r.builtin ? '' : ' · 自定义') }
    })
    const roleList = roleOpts.length ? roleOpts : [
      { value: 'cs', label: '客服坐席' }, { value: 'admin', label: '管理员' }
    ]
    const root = modal({
      title: '新建管理端账号',
      sub: '角色决定可见页面与可执行动作，创建后立即生效',
      body: '<div class="form-grid">' +
        field('登录账号', '<input id="af-user" placeholder="如 kf02，3-32 位字母 / 数字 / . _ -">') +
        field('姓名', '<input id="af-name" placeholder="如 客服小张">') +
        field('所属组织', '<input id="af-org" value="算力聚合">') +
        field('角色', '<select id="af-role">' + options(roleList, 'cs', false) + '</select>') +
        field('初始口令', '<input id="af-pwd" type="password" placeholder="至少 10 位，含大写 / 小写 / 数字 / 符号中三类">') +
        '<div class="field full"><label>动态口令密钥（Base32）</label>' +
          '<div class="flex" style="gap:8px"><input id="af-otp" class="grow" placeholder="16 位以上 Base32，登录时用于生成 6 位动态码">' +
          '<button class="btn" type="button" id="af-otp-gen">生成</button></div>' +
          '<div class="small" style="margin-top:6px;color:var(--muted-2)">密钥只在创建时展示一次，请与账号使用人通过安全渠道交接。</div></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="af-ok">创建账号</button>'
    })
    if (!root) return
    const otpInput = root.body.querySelector('#af-otp')
    otpInput.value = randomTotpSecret()
    root.body.querySelector('#af-otp-gen').onclick = function () { otpInput.value = randomTotpSecret() }
    root.querySelector('#af-ok').onclick = async function () {
      const payload = {
        username: root.body.querySelector('#af-user').value.trim().toLowerCase(),
        name: root.body.querySelector('#af-name').value.trim(),
        org: root.body.querySelector('#af-org').value.trim(),
        role: root.body.querySelector('#af-role').value,
        password: root.body.querySelector('#af-pwd').value,
        totpSecret: otpInput.value.trim()
      }
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(payload.username)) return toast('账号需为 3-32 位字母、数字、点、下划线或连字符', 'err')
      if (!payload.name) return toast('请填写姓名', 'err')
      if (payload.password.length < 10) return toast('初始口令至少 10 位', 'err')
      if (!/^[A-Z2-7]{16,64}$/.test(payload.totpSecret)) return toast('动态口令密钥需为 16 位以上 Base32 字符', 'err')
      this.disabled = true
      try {
        await api('account.create', payload)
        closeModal()
        toast('账号已创建')
        loadAccounts(ACC.view)
      } catch (err) { toast(err.message, 'err'); this.disabled = false }
    }
  }

  function openRoleForm(role) {
    const pages = ACC.pages
    const root = modal({
      title: role ? '编辑角色' : '新建角色',
      sub: role ? role.roleKey : '自定义角色：先勾页面，再勾页面里允许执行的动作',
      body: '<div class="form-grid">' +
        field('角色标识', '<input id="rf-key" placeholder="英文小写，如 auditor"' + (role ? ' value="' + esc(role.roleKey) + '" disabled' : '') + '>') +
        field('角色名称', '<input id="rf-name" placeholder="如 审核员" value="' + esc(role ? role.name : '') + '">') +
        '<div class="field full"><label>可见页面</label>' + checkGroup('rf-page', pages, role ? role.pages : [], 4) + '</div>' +
        '<div class="field full"><label>允许动作</label>' + checkGroup('rf-action', ACC.actions, role ? role.actions : [], 3) + '</div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="rf-ok">保存</button>'
    })
    if (!root) return
    root.querySelector('#rf-ok').onclick = async function () {
      const roleKey = role ? role.roleKey : root.body.querySelector('#rf-key').value.trim().toLowerCase()
      const name = root.body.querySelector('#rf-name').value.trim()
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(roleKey)) return toast('角色标识需为 2-24 位英文小写 / 数字 / 下划线', 'err')
      if (!name) return toast('请填写角色名称', 'err')
      const pagesPicked = picked(root.body, 'rf-page')
      if (!pagesPicked.length) return toast('请至少勾选一个页面', 'err')
      this.disabled = true
      try {
        await api('role.save', { roleKey: roleKey, name: name, pages: pagesPicked, actions: picked(root.body, 'rf-action') })
        closeModal()
        toast('角色已保存')
        loadAccounts(ACC.view)
      } catch (err) { toast(err.message, 'err'); this.disabled = false }
    }
  }

  function openPermForm() {
    const defaultDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    const root = modal({
      title: '发放临时权限',
      sub: '在账号原有角色上叠加页面 / 动作，到期自动失效',
      body: '<div class="form-grid">' +
        field('账号', '<select id="pm-acc">' + options(ACC.accounts.map(function (a) {
          return { value: a.username, label: a.username + '（' + (ROLE_TEXT[a.role] || a.role) + '）' }
        }), '', false) + '</select>') +
        field('到期时间', '<input id="pm-exp" type="date" value="' + defaultDate + '">') +
        field('备注', '<input id="pm-note" placeholder="如：双十一大促临时开财务中心">') +
        '<div class="field full"><label>额外页面</label>' + checkGroup('pm-page', ACC.pages, [], 4) + '</div>' +
        '<div class="field full"><label>额外动作</label>' + checkGroup('pm-action', ACC.actions, [], 3) + '</div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="pm-ok">发放</button>'
    })
    if (!root) return
    root.querySelector('#pm-ok').onclick = async function () {
      const username = root.body.querySelector('#pm-acc').value
      if (!username) return toast('请选择账号', 'err')
      const expiresAt = Date.parse(root.body.querySelector('#pm-exp').value + 'T23:59:59')
      if (!expiresAt) return toast('请选择到期时间', 'err')
      const extraPages = picked(root.body, 'pm-page')
      const extraActions = picked(root.body, 'pm-action')
      if (!extraPages.length && !extraActions.length) return toast('至少勾选一个页面或动作', 'err')
      this.disabled = true
      try {
        await api('permission.save', {
          username: username,
          extraPages: extraPages,
          extraActions: extraActions,
          expiresAt: expiresAt,
          note: root.body.querySelector('#pm-note').value.trim()
        })
        closeModal()
        toast('临时权限已发放')
        loadAccounts(ACC.view)
      } catch (err) { toast(err.message, 'err'); this.disabled = false }
    }
  }

  /* ================= 11. 商品管理（用户发布货源） ================= */

  const PRODUCT_STATUS_OPTIONS = ['草稿', '在售', '洽谈中', '已下架', '已成交']
  const PRODUCT_FILTER = { q: '', status: '', cat: '', bizPool: '', page: 1, limit: 20, items: [], truncated: false }
  /* 商品批量转移：勾选集合跨分页保留，进入页面时清空 */
  const PRODUCT_PICK = new Set()

  async function loadAllRows(action, params) {
    const limit = 50
    let items = []
    let total = 0
    let page = 1
    let truncated = false
    /* 商品 / 需求已过千条：原来最多 20 页（1000 条）会把尾部记录截掉，导致搜索漏项 */
    while (page <= 60) {
      const res = await api(action, Object.assign({}, params || {}, { page: page, limit: limit }))
      const rows = res.items || []
      items = items.concat(rows)
      total = Number(res.total) || items.length
      if (!res.hasMore || !rows.length) break
      if (page === 60) { truncated = true; break }
      page += 1
    }
    if (items.length < total) truncated = true
    return { items: items, total: total, truncated: truncated }
  }

  function reasonModal(opts, onOk) {
    const reasons = opts.reasons || []
    const root = modal({
      title: opts.title,
      sub: opts.sub || '',
      body: '<div class="form-grid">' +
        field(opts.label || '原因', '<select id="rs-reason">' + reasons.map(function (r) {
          return '<option value="' + esc(r) + '">' + esc(r) + '</option>'
        }).join('') + '</select>') +
        field('补充说明', '<input id="rs-note" maxlength="60" placeholder="选填，会一并同步给发布人">') +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="rs-ok">' + esc(opts.okText || '确认') + '</button>'
    })
    if (!root) return
    root.querySelector('#rs-ok').onclick = function () {
      const sel = root.body.querySelector('#rs-reason').value
      const note = root.body.querySelector('#rs-note').value.trim()
      onOk(note ? sel + '：' + note : sel, this)
    }
  }

  function productActions(item, noDetail) {
    const ops = noDetail ? [] : ['<button class="btn xs" data-pd-detail="' + esc(item.id) + '">详情</button>']
    /* 商品发布即对外展示，平台不参与审核；只保留违规下架与恢复入口 */
    const openable = ['已下架', '已成交'].indexOf(item.status) < 0
    if (openable && C.can('product.offline')) {
      ops.push('<button class="btn xs danger" data-pd-act="offline" data-pd-id="' + esc(item.id) + '">下架</button>')
    }
    if (item.status === '已下架' && C.can('product.online')) {
      ops.push('<button class="btn xs primary" data-pd-act="online" data-pd-id="' + esc(item.id) + '">上架</button>')
    }
    return ops.join('')
  }

  async function productAction(act, item, reload) {
    const id = item.id
    if (act === 'offline') {
      reasonModal({
        title: '下架商品',
        sub: item.title || id,
        label: '下架原因',
        reasons: ['发布人申请下架', '信息过期', '价格异常', '涉嫌违规', '重复发布', '其他'],
        okText: '下架',
        danger: true
      }, async function (reason, btn) {
        btn.disabled = true
        try {
          await api('product.offline', { productId: id, reason: reason })
          closeModal()
          toast('商品已下架')
          if (reload) reload()
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      })
      return
    }
    if (act === 'online') {
      const ok = await confirm({
        title: '重新上架',
        message: '确认将「' + esc(item.title || id) + '」恢复为「在售」？',
        okText: '上架'
      })
      if (!ok) return
      try {
        await api('product.online', { productId: id })
        toast('商品已上架')
        if (reload) reload()
      } catch (err) { toast(err.message, 'err') }
    }
  }

  /* 商品详情对话：自动加载，按会话分块展示直聊 / 客服咨询，图片与名片复用留言渲染 */
  async function loadProductChats(rootBody, product) {
    const box = rootBody.querySelector('#pd-chat-box')
    if (!box) return
    let data
    try {
      data = await api('product.chats', { id: product.id })
    } catch (err) {
      box.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message || '对话加载失败') + '</div>'
      return
    }
    const threads = (data && data.threads) || []
    if (!threads.length) {
      box.innerHTML = '<div class="small" style="color:var(--muted-2)">该商品暂无用户咨询记录</div>'
      return
    }
    box.innerHTML = threads.map(function (t) {
      const title = t.channel === 'kf'
        ? '平台客服 · ' + (t.userName || '用户')
        : ((t.userName || '用户') + ' ↔ ' + (t.peerName || '发布方'))
      const total = t.total != null ? t.total : (t.messages || []).length
      const messages = (t.messages || []).map(function (m) {
        const who = m.fromName || (m.fromStaff ? '平台客服' : (t.userName || '用户'))
        return '<div class="chat-bubble">' +
          '<div class="meta">' + esc(who) + (m.at ? ' · ' + esc(dateText(m.at)) : '') + '</div>' +
          msgContentHtml(m, { uid: t.uid, nick: t.userName }) + '</div>'
      }).join('')
      return '<div class="pd-chat">' +
        '<div class="pd-chat-head"><div class="strong">' + esc(title) + '</div>' +
        '<div class="small" style="color:var(--muted-2)">' + num(total) + ' 条 · ' + esc(dateText(t.lastAt)) + '</div></div>' +
        '<div class="chat-stream pd-chat-stream">' + (messages || emptyState('该会话暂无消息')) + '</div>' +
        '</div>'
    }).join('')
    /* 图片保持新窗口打开，但先调用 msg.mediaOpen 续期；视频首次播放时由 mediaBind 续期 */
    mediaBind(box)
    box.querySelectorAll('[data-img]').forEach(function (el) {
      el.onclick = async function () {
        const src = el.getAttribute('data-img')
        if (!src) return
        if (!(await mediaKeep(el.getAttribute('data-media-id')))) return
        window.open(src, '_blank', 'noopener')
      }
    })
  }

  function openProductDrawer(item, reload) {
    const p = item
    const tags = (p.tags || []).map(function (t) { return badge(t, 'info') }).join(' ')
    const checklist = (p.checklist || []).map(function (c) {
      return '<td>' + esc(c.n || '') + '</td><td>' + (c.ok ? badge('已核验', 'ok') : badge('待核验', 'warn')) + '</td>'
    })
    const extra = []
    /* 这些字段在云函数里多为数组（租期 / 租赁限制 / 交易要求 / 交易流程），直接 esc 会渲染成逗号串 */
    const joined = function (v) {
      return Array.isArray(v) ? v.filter(Boolean).join('；') : (v == null ? '' : String(v))
    }
    if (joined(p.term)) extra.push(['租期', esc(joined(p.term))])
    if (p.closed) extra.push(['报价方式', esc(p.closed)])
    if (p.deposit) extra.push(['押金', esc(p.deposit)])
    if (p.pay) extra.push(['付款方式', esc(p.pay)])
    if (joined(p.rentLimits)) extra.push(['租赁限制', esc(joined(p.rentLimits))])
    if (joined(p.must)) extra.push(['交易要求', esc(joined(p.must))])
    /* 可议价选项为数组：空数组表示一口价，不能被数组真值误判为「可议价」 */
    const negoOn = Array.isArray(p.nego) ? p.nego.length > 0 : !!p.nego
    if (p.nego !== undefined && p.nego !== null && p.nego !== '') extra.push(['是否议价', negoOn ? '可议价' : '一口价'])
    if (joined(p.flow)) extra.push(['交易流程', esc(joined(p.flow))])
    extra.push(['交付方式', esc(p.deliver || '—')])
    extra.push(['税票', esc(p.tax || '—')])
    extra.push(['供给类型', esc(p.supply || '—')])
    extra.push(['交易地', esc(p.city || '—')])
    extra.push(['可承接数量', esc(p.limit || '—')])

    const body =
      '<div class="rev-split">' + mediaPanel('product') + '<div class="rev-main">' +
      publisherBlock(p.user, p.ownerId) +
      kvList([
        ['状态', autoBadge(p.status)],
        ['发布主体', esc(p.ownerLabel || '—') +
          (p.ownerPhoneMasked ? ' · ' + esc(p.ownerPhoneMasked) : '') +
          (p.hasOwnerPhone ? ' ' + badge('已留联系方式', 'ok') : '')],
        ['交易方式', esc(p.tradeMode || '—')],
        ['品类', esc(p.cat || '—')],
        ['品牌 / 型号', esc([p.brand, p.model].filter(Boolean).join(' / ') || '—')],
        ['价格', amountOf(p, 'price', 'priceMax', 'priceMode', 'priceUnit')],
        ['数量', num(p.qty) + (p.minQty ? '（起订 ' + num(p.minQty) + '）' : '')],
        ['成色', esc(p.cond || '—') + (p.condLevel ? ' · ' + esc(p.condLevel) : '')],
        ['可见范围', esc(p.visibilityLabel || '—')],
        ['发布方式', esc(channelLabelOf(p))],
        ['热度 / 浏览', num(p.heat) + ' 人 · ' + num(p.views) + ' 次'],
        ['发布时间', esc(dateText(p.createdAt))],
        ['商品 ID', '<span class="mono small">' + esc(p.id) + '</span>']
      ]) +
      '<div class="strong" style="margin:16px 0 8px">租赁 / 交易条款</div>' +
      kvList(extra) +
      (p.reviewReason || p.offlineReason ? '<div class="flex flex-wrap" style="gap:6px;margin-top:12px">' +
        (p.reviewReason ? badge('驳回原因：' + p.reviewReason, 'danger') : '') +
        (p.offlineReason ? badge('下架原因：' + p.offlineReason, 'warn') : '') + '</div>' : '') +
      '<div class="strong" style="margin:16px 0 8px">对话记录</div>' +
      '<div class="small" style="color:var(--muted-2);margin-bottom:6px">用户与平台围绕该商品的直聊 / 客服咨询汇总</div>' +
      '<div id="pd-chat-box" class="pd-chat-box"><div class="small" style="color:var(--muted-2)">正在加载对话…</div></div>' +
      '<div class="strong" style="margin:16px 0 8px">商品描述</div>' +
      '<div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(p.note || '—') + '</div>' +
      (p.requirements ? '<div class="strong" style="margin:16px 0 8px">交易要求</div><div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(p.requirements) + '</div>' : '') +
      (p.accept ? '<div class="strong" style="margin:16px 0 8px">承接说明</div><div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(p.accept) + '</div>' : '') +
      (tags ? '<div class="strong" style="margin:16px 0 8px">标签</div><div class="flex flex-wrap" style="gap:6px">' + tags + '</div>' : '') +
      (checklist.length ? '<div class="strong" style="margin:16px 0 8px">资料核验</div>' + table(['核验项', '结论'], checklist) : '') +
      '</div></div>'

    const root = openDrawer({
      title: p.title || '商品详情',
      titleTag: isPrivateItem(p) ? privateTag('私密发布') : (isPoolOnlyItem(p) ? poolTag() : ''),
      sub: [p.tradeMode, p.cat, p.ownerLabel].filter(Boolean).map(esc).join(' · '),
      badges: autoBadge(p.status) + (p.visibilityLabel ? ' ' + badge(p.visibilityLabel, 'info') : '') + (p.heat ? ' ' + badge('热度 ' + num(p.heat), 'warn') : ''),
      body: body,
      foot: '<div class="flex flex-wrap" style="gap:8px">' + productActions(p, true) + '<button class="btn" id="pd-d-close">关闭</button></div>'
    })
    if (!root) return
    root.foot.querySelector('#pd-d-close').onclick = closeDrawer
    wirePublisherLinks(root.body)
    loadMediaPanel(root.body, p, 'product')

    /* 商品对话：打开抽屉即汇总该商品下发布方与咨询方的直聊、以及用户发给平台的客服咨询 */
    loadProductChats(root.body, p)
    root.foot.querySelectorAll('[data-pd-detail]').forEach(function (btn) {
      btn.onclick = function () { closeDrawer(); openProductDrawer(p, reload) }
    })
    root.foot.querySelectorAll('[data-pd-act]').forEach(function (btn) {
      btn.onclick = function () {
        productAction(btn.getAttribute('data-pd-act'), p, function () { closeDrawer(); if (reload) reload() })
      }
    })
  }

  Pages.products = async function (view) {
    PRODUCT_PICK.clear()
    view.innerHTML = pageHead(
      '商品管理',
      '用户发布的货源发布后直接对外展示，平台不审核、不干预；仅在违规或信息异常时下架，日常上下架由发布人自行操作。',
      '<button class="btn" id="pd-refresh">刷新</button>'
    ) +
    filterBar([
      '<div class="field" style="min-width:240px"><label>关键词</label><input id="pd-q" placeholder="标题 / 品类 / 品牌 / 型号 / ID" value="' + esc(PRODUCT_FILTER.q) + '"></div>',
      field('状态', '<select id="pd-status">' + options(PRODUCT_STATUS_OPTIONS, PRODUCT_FILTER.status) + '</select>'),
      field('品类', '<input id="pd-cat" placeholder="如 GPU 服务器" value="' + esc(PRODUCT_FILTER.cat) + '">'),
      field('发布方式', '<select id="pd-pool">' + options(['普通发布', '仅发商机池', '私密发布'], PRODUCT_FILTER.bizPool) + '</select>'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="pd-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) +
    card('商品列表', '<div id="pd-list">' + loadingBlock('加载商品') + '</div>', '', true)

    const list = view.querySelector('#pd-list')

    function matched() {
      const q = PRODUCT_FILTER.q.toLowerCase()
      return (PRODUCT_FILTER.items || []).filter(function (p) {
        if (PRODUCT_FILTER.status && p.status !== PRODUCT_FILTER.status) return false
        if (PRODUCT_FILTER.cat && String(p.cat || '').indexOf(PRODUCT_FILTER.cat) < 0) return false
        if (PRODUCT_FILTER.bizPool === '私密发布' && !isPrivateItem(p)) return false
        if (PRODUCT_FILTER.bizPool === '仅发商机池' && !isPoolOnlyItem(p)) return false
        if (PRODUCT_FILTER.bizPool === '普通发布' && (isPrivateItem(p) || isPoolOnlyItem(p))) return false
        if (!q) return true
        return [p.title, p.cat, p.brand, p.model, p.city, p.ownerLabel, p.id].join(' ').toLowerCase().indexOf(q) >= 0
      })
    }

    function bulkBar() {
      return '<div class="flex flex-wrap" style="gap:8px;align-items:center;margin-bottom:10px">' +
        '<button class="btn" id="pd-all-btn">全选本页</button>' +
        '<span class="small" id="pd-sel" style="color:var(--muted-2)">已选 0 项</span>' +
        '<button class="btn primary" id="pd-transfer" disabled>转移归属</button>' +
        '<span class="small" style="color:var(--muted-2)">可跨页勾选，单次最多 50 个</span>' +
        '</div>'
    }

    function render() {
      const all = PRODUCT_FILTER.items || []
      const items = matched()
      const canTransfer = C.can('product.transfer')
      /* 过滤条件变化后，把已不在结果里的勾选剔除 */
      const valid = {}
      items.forEach(function (p) { valid[p.id] = 1 })
      Array.from(PRODUCT_PICK).forEach(function (id) { if (!valid[id]) PRODUCT_PICK.delete(id) })
      const limit = PRODUCT_FILTER.limit
      const pages = Math.max(1, Math.ceil(items.length / limit))
      if (PRODUCT_FILTER.page > pages) PRODUCT_FILTER.page = pages
      const page = PRODUCT_FILTER.page
      const slice = items.slice((page - 1) * limit, page * limit)
      const byId = {}
      all.forEach(function (p) { byId[p.id] = p })

      const rows = slice.map(function (p) {
        const pick = canTransfer
          ? '<td><input type="checkbox" class="pd-pick" data-id="' + esc(p.id) + '"' + (PRODUCT_PICK.has(p.id) ? ' checked' : '') + '></td>'
          : ''
        return '<tr>' + pick +
          '<td><div class="strong">' + esc(p.title || '—') + (isPoolOnlyItem(p) ? ' ' + poolTag() : '') + (isPrivateItem(p) ? ' ' + privateTag() : '') + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(p.id) + '</div></td>' +
          '<td>' + esc(p.ownerLabel || '—') + '</td>' +
          '<td>' + esc(p.tradeMode || '—') + '</td>' +
          '<td>' + amountOf(p, 'price', 'priceMax', 'priceMode', 'priceUnit') + '</td>' +
          '<td>' + num(p.qty) + (p.minQty ? '<div class="small" style="color:var(--muted-2)">起订 ' + num(p.minQty) + '</div>' : '') + '</td>' +
          '<td>' + esc(p.cond || '—') + '</td>' +
          '<td>' + autoBadge(p.status) + '</td>' +
          '<td class="small">' + esc(dateText(p.createdAt)) + '</td>' +
          '<td><div class="flex flex-wrap" style="gap:6px">' + productActions(p) + '</div></td>' +
          '</tr>'
      })

      const heads = ['标题', '发布主体', '交易方式', '价格', '数量', '成色', '状态', '发布时间', '操作']
      if (canTransfer) heads.unshift('<input type="checkbox" id="pd-all" aria-label="全选本页">')

      list.innerHTML = (canTransfer ? bulkBar() : '') +
        table(heads, rows, '当前筛选下暂无商品') +
        pager(items.length, page, limit) +
        (PRODUCT_FILTER.truncated ? '<div class="small" style="margin-top:8px;color:var(--muted-2)">数据量较大，已加载最近 ' + num(all.length) + ' 条，可结合状态 / 品类缩小范围。</div>' : '')

      wirePager(list, function (p) { PRODUCT_FILTER.page = p; render() })
      list.querySelectorAll('[data-pd-detail]').forEach(function (btn) {
        btn.onclick = function () {
          const item = byId[btn.getAttribute('data-pd-detail')]
          if (item) openProductDrawer(item, load)
        }
      })
      list.querySelectorAll('[data-pd-act]').forEach(function (btn) {
        btn.onclick = function () {
          const item = byId[btn.getAttribute('data-pd-id')]
          if (item) productAction(btn.getAttribute('data-pd-act'), item, load)
        }
      })
      if (canTransfer) wirePick()
    }

    /* 勾选状态与批量按钮联动：全选框只作用于当前页，跨页勾选会累计 */
    function wirePick() {
      const allBox = list.querySelector('#pd-all')
      const selText = list.querySelector('#pd-sel')
      const transferBtn = list.querySelector('#pd-transfer')
      const pageIds = function () {
        return Array.prototype.map.call(list.querySelectorAll('.pd-pick'), function (box) {
          return box.getAttribute('data-id')
        })
      }
      function sync() {
        if (selText) selText.textContent = '已选 ' + PRODUCT_PICK.size + ' 项'
        if (transferBtn) transferBtn.disabled = !PRODUCT_PICK.size
        if (allBox) {
          const ids = pageIds()
          allBox.checked = ids.length > 0 && ids.every(function (id) { return PRODUCT_PICK.has(id) })
        }
      }
      list.querySelectorAll('.pd-pick').forEach(function (box) {
        box.onchange = function () {
          const id = box.getAttribute('data-id')
          if (box.checked) PRODUCT_PICK.add(id)
          else PRODUCT_PICK.delete(id)
          sync()
        }
      })
      if (allBox) allBox.onchange = function () {
        pageIds().forEach(function (id) {
          if (allBox.checked) PRODUCT_PICK.add(id)
          else PRODUCT_PICK.delete(id)
        })
        render()
      }
      const allBtn = list.querySelector('#pd-all-btn')
      if (allBtn) allBtn.onclick = function () {
        const ids = pageIds()
        const allOn = ids.length > 0 && ids.every(function (id) { return PRODUCT_PICK.has(id) })
        ids.forEach(function (id) {
          if (allOn) PRODUCT_PICK.delete(id)
          else PRODUCT_PICK.add(id)
        })
        render()
      }
      if (transferBtn) transferBtn.onclick = openTransferModal
      sync()
    }

    /* 转移归属：先按 ID / 编号 / 手机号 / 昵称定位接收人，再批量提交 */
    function openTransferModal() {
      if (!PRODUCT_PICK.size) return toast('请先勾选要转移的商品', 'err')
      if (PRODUCT_PICK.size > 50) return toast('单次最多转移 50 个商品', 'err')
      const ids = Array.from(PRODUCT_PICK)
      let target = null
      const root = modal({
        title: '转移商品归属',
        sub: '已选 ' + ids.length + ' 个商品，转移后由接收人管理并接收咨询',
        body: '<div class="form-grid">' +
          '<div class="field"><label>接收人</label><div class="flex" style="gap:8px">' +
          '<input id="pd-target-q" placeholder="用户 ID / 用户编号 / 手机号 / 昵称">' +
          '<button class="btn" id="pd-target-search">查找</button>' +
          '</div></div>' +
          '<div id="pd-target-list" class="small" style="color:var(--muted-2)">输入后点击「查找」，最多显示 10 个候选</div>' +
          field('转移说明', '<input id="pd-target-reason" maxlength="60" placeholder="选填，例如：客户更换账号 / 员工离职交接">') +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="pd-target-ok" disabled>确认转移</button>'
      })
      if (!root) return
      const box = root.body.querySelector('#pd-target-list')
      const okBtn = root.body.querySelector('#pd-target-ok')

      function renderTargets(items) {
        if (!items.length) {
          box.innerHTML = '未找到用户，请确认输入的是完整手机号或用户编号'
          return
        }
        box.innerHTML = items.map(function (u) {
          const disabled = u.status === '停用'
          return '<label style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">' +
            '<input type="radio" name="pd-target" value="' + esc(u.id) + '"' + (disabled ? ' disabled' : '') + '>' +
            '<span class="strong">' + esc(u.nick || '未设置昵称') + '</span>' +
            badge(u.status || '正常', disabled ? 'danger' : 'info') +
            '<span class="small mono" style="color:var(--muted-2);margin-left:auto">' + esc(u.userNo) + '</span>' +
            '</label>'
        }).join('')
        box.querySelectorAll('input[name="pd-target"]').forEach(function (radio) {
          radio.onchange = function () {
            target = items.filter(function (u) { return u.id === radio.value })[0] || null
            okBtn.disabled = !target || target.status === '停用'
          }
        })
      }

      async function doSearch() {
        const q = root.body.querySelector('#pd-target-q').value.trim()
        if (!q) return toast('请输入用户 ID、编号、手机号或昵称', 'err')
        box.textContent = '查找中…'
        try {
          const res = await api('product.transferTargets', { q: q })
          renderTargets(res.items || [])
        } catch (err) {
          box.textContent = err.message || '查找失败'
        }
      }

      root.body.querySelector('#pd-target-search').onclick = doSearch
      root.body.querySelector('#pd-target-q').onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doSearch() }
      }
      okBtn.onclick = async function () {
        if (!target) return
        okBtn.disabled = true
        try {
          const res = await api('product.transfer', {
            productIds: ids,
            targetId: target.id,
            reason: (root.body.querySelector('#pd-target-reason').value || '').trim()
          })
          closeModal()
          PRODUCT_PICK.clear()
          toast('已转移 ' + num(res.moved) + ' 个商品' + (res.skipped && res.skipped.length ? '，跳过 ' + res.skipped.length + ' 个' : ''))
          load()
        } catch (err) {
          toast(err.message, 'err')
          okBtn.disabled = false
        }
      }
    }

    async function load() {
      list.innerHTML = loadingBlock('加载商品')
      try {
        const res = await loadAllRows('product.list', {})
        PRODUCT_FILTER.items = res.items
        PRODUCT_FILTER.truncated = res.truncated
        render()
      } catch (err) {
        list.innerHTML = emptyState(err.message || '商品加载失败')
      }
    }

    function search() {
      PRODUCT_FILTER.q = (view.querySelector('#pd-q').value || '').trim()
      PRODUCT_FILTER.status = view.querySelector('#pd-status').value
      PRODUCT_FILTER.cat = (view.querySelector('#pd-cat').value || '').trim()
      PRODUCT_FILTER.bizPool = view.querySelector('#pd-pool').value
      PRODUCT_FILTER.page = 1
      render()
    }

    view.querySelector('#pd-search').onclick = search
    view.querySelector('#pd-q').onkeydown = function (e) { if (e.key === 'Enter') search() }
    view.querySelector('#pd-cat').onkeydown = function (e) { if (e.key === 'Enter') search() }
    view.querySelector('#pd-status').onchange = search
    view.querySelector('#pd-pool').onchange = search
    view.querySelector('#pd-refresh').onclick = function () { load() }
    load()
  }

  /* ================= 12. 需求管理（用户发布求购） ================= */

  const DEMAND_STATUS_OPTIONS = ['草稿', '求购中', '已对接', '已关闭', '已下架']
  const DEMAND_FILTER = { q: '', status: '', cat: '', bizPool: '', page: 1, limit: 20, items: [], truncated: false }
  /* 批量转移归属的勾选集合：可跨页累计，切换筛选后自动剔除已不在结果里的项 */
  const DEMAND_PICK = new Set()

  function demandActions(item, noDetail) {
    const ops = noDetail ? [] : ['<button class="btn xs" data-dm-detail="' + esc(item.id) + '">详情</button>']
    /* 需求发布即对外展示，平台不参与审核；只保留违规下架与恢复入口 */
    if (['已关闭', '已下架'].indexOf(item.status) < 0 && C.can('demand.offline')) {
      ops.push('<button class="btn xs danger" data-dm-act="offline" data-dm-id="' + esc(item.id) + '">下架</button>')
    }
    if (['求购中', '已对接'].indexOf(item.status) >= 0 && C.can('demand.close')) {
      ops.push('<button class="btn xs danger" data-dm-act="close" data-dm-id="' + esc(item.id) + '">关闭</button>')
    }
    if (item.status === '已下架' && C.can('demand.setStatus')) {
      ops.push('<button class="btn xs" data-dm-act="online" data-dm-id="' + esc(item.id) + '">恢复展示</button>')
    }
    return ops.join('')
  }

  async function demandAction(act, item, reload) {
    const id = item.id
    if (act === 'offline') {
      reasonModal({
        title: '下架需求',
        sub: item.title || id,
        label: '下架原因',
        reasons: ['发布人申请下架', '需求已成交', '信息过期', '涉嫌违规', '重复发布', '其他'],
        okText: '下架',
        danger: true
      }, async function (reason, btn) {
        btn.disabled = true
        try {
          await api('demand.offline', { demandId: id, reason: reason })
          closeModal()
          toast('需求已下架')
          if (reload) reload()
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      })
      return
    }
    if (act === 'close') {
      reasonModal({
        title: '关闭需求',
        sub: item.title || id,
        label: '关闭原因',
        reasons: ['需求已完成', '发布人取消', '长期无响应', '信息失效', '其他'],
        okText: '关闭',
        danger: true
      }, async function (reason, btn) {
        btn.disabled = true
        try {
          await api('demand.close', { demandId: id, reason: reason })
          closeModal()
          toast('需求已关闭')
          if (reload) reload()
        } catch (err) { toast(err.message, 'err'); btn.disabled = false }
      })
      return
    }
    if (act === 'online') {
      const ok = await confirm({
        title: '重新上架',
        message: '确认将「' + esc(item.title || id) + '」恢复为「求购中」？',
        okText: '上架'
      })
      if (!ok) return
      try {
        await api('demand.setStatus', { demandId: id, to: '求购中' })
        toast('需求已重新上架')
        if (reload) reload()
      } catch (err) { toast(err.message, 'err') }
    }
  }

  function openDemandDrawer(item, reload) {
    const d = item
    const tags = (d.tags || []).map(function (t) { return badge(t, 'info') }).join(' ')
    const extra = []
    /* 租期 / 租赁限制 / 必须满足 / 交易流程均为数组，统一拼接后再展示 */
    const joined = function (v) {
      return Array.isArray(v) ? v.filter(Boolean).join('；') : (v == null ? '' : String(v))
    }
    if (joined(d.term)) extra.push(['需求周期', esc(joined(d.term))])
    if (d.deposit) extra.push(['押金', esc(d.deposit)])
    if (d.pay) extra.push(['付款方式', esc(d.pay)])
    if (joined(d.rentLimits)) extra.push(['租赁限制', esc(joined(d.rentLimits))])
    if (joined(d.must)) extra.push(['必须满足', esc(joined(d.must))])
    if (d.sameMachine !== undefined && d.sameMachine !== '') extra.push(['同机要求', d.sameMachine ? '要求同机' : '可不同机'])
    const negoOn = Array.isArray(d.nego) ? d.nego.length > 0 : !!d.nego
    if (d.nego !== undefined && d.nego !== null && d.nego !== '') extra.push(['是否议价', negoOn ? '可议价' : '一口价'])
    if (joined(d.flow)) extra.push(['交易流程', esc(joined(d.flow))])
    extra.push(['承接范围', esc(d.accept || '—')])
    extra.push(['供给要求', esc(d.supply || '—')])
    extra.push(['税票', esc(d.tax || '—')])
    extra.push(['交易地', esc(d.city || '—')])
    extra.push(['成色要求', esc(d.cond || '—') + (d.condLevel ? ' · ' + esc(d.condLevel) : '')])

    const body =
      '<div class="rev-split">' + mediaPanel('demand') + '<div class="rev-main">' +
      publisherBlock(d.user, d.ownerId) +
      kvList([
        ['状态', autoBadge(d.status)],
        ['发布主体', esc(d.publisherLabel || '—')],
        ['交易方式', esc(d.tradeMode || '—')],
        ['品类', esc(d.cat || '—')],
        ['品牌 / 型号', esc([d.brand, d.model].filter(Boolean).join(' / ') || '—')],
        ['预算', d.budget || d.budgetMode === 'nego' ? amountOf(d, 'budget', 'budgetMax', 'budgetMode', 'budgetUnit') : '面议'],
        ['数量', num(d.qty)],
        ['响应 / 浏览', num(d.responses) + ' 条 · ' + num(d.views) + ' 次'],
        ['可见范围', esc(d.visibilityLabel || '—')],
        ['发布方式', esc(channelLabelOf(d))],
        ['发布时间', esc(dateText(d.createdAt))],
        ['需求 ID', '<span class="mono small">' + esc(d.id) + '</span>']
      ]) +
      '<div class="strong" style="margin:16px 0 8px">需求条款</div>' +
      kvList(extra) +
      (d.reviewReason || d.offlineReason ? '<div class="flex flex-wrap" style="gap:6px;margin-top:12px">' +
        (d.reviewReason ? badge('驳回原因：' + d.reviewReason, 'danger') : '') +
        (d.offlineReason ? badge('下架原因：' + d.offlineReason, 'warn') : '') + '</div>' : '') +
      '<div class="strong" style="margin:16px 0 8px">需求描述</div>' +
      '<div class="small" style="white-space:pre-wrap;line-height:1.8;color:var(--ink-2)">' + esc(d.note || '—') + '</div>' +
      (tags ? '<div class="strong" style="margin:16px 0 8px">标签</div><div class="flex flex-wrap" style="gap:6px">' + tags + '</div>' : '') +
      '</div></div>'

    const root = openDrawer({
      title: d.title || '需求详情',
      titleTag: isPrivateItem(d) ? privateTag('私密发布') : (isPoolOnlyItem(d) ? poolTag() : ''),
      sub: [d.tradeMode, d.cat, d.publisherLabel].filter(Boolean).map(esc).join(' · '),
      badges: autoBadge(d.status) + (d.heat ? ' ' + badge('热度 ' + num(d.heat), 'warn') : ''),
      body: body,
      foot: '<div class="flex flex-wrap" style="gap:8px">' + demandActions(d, true) + '<button class="btn" id="dm-d-close">关闭</button></div>'
    })
    if (!root) return
    root.foot.querySelector('#dm-d-close').onclick = closeDrawer
    wirePublisherLinks(root.body)
    loadMediaPanel(root.body, d, 'demand')
    root.foot.querySelectorAll('[data-dm-detail]').forEach(function (btn) {
      btn.onclick = function () { closeDrawer(); openDemandDrawer(d, reload) }
    })
    root.foot.querySelectorAll('[data-dm-act]').forEach(function (btn) {
      btn.onclick = function () {
        demandAction(btn.getAttribute('data-dm-act'), d, function () { closeDrawer(); if (reload) reload() })
      }
    })
  }

  Pages.demands = async function (view) {
    view.innerHTML = pageHead(
      '需求管理',
      '用户发布的求购需求发布后直接对外展示，平台不审核、不干预；仅在违规或信息异常时下架，日常上下架由发布人自行操作。',
      '<button class="btn" id="dm-refresh">刷新</button>'
    ) +
    filterBar([
      '<div class="field" style="min-width:240px"><label>关键词</label><input id="dm-q" placeholder="标题 / 品类 / 品牌 / 型号 / ID" value="' + esc(DEMAND_FILTER.q) + '"></div>',
      field('状态', '<select id="dm-status">' + options(DEMAND_STATUS_OPTIONS, DEMAND_FILTER.status) + '</select>'),
      field('品类', '<input id="dm-cat" placeholder="如 GPU 服务器" value="' + esc(DEMAND_FILTER.cat) + '">'),
      field('发布方式', '<select id="dm-pool">' + options(['普通发布', '仅发商机池', '私密发布'], DEMAND_FILTER.bizPool) + '</select>'),
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="dm-search">' + icon('search') + '<span>查询</span></button></div>'
    ]) +
    card('需求列表', '<div id="dm-list">' + loadingBlock('加载需求') + '</div>', '', true)

    const list = view.querySelector('#dm-list')

    function matched() {
      const q = DEMAND_FILTER.q.toLowerCase()
      return (DEMAND_FILTER.items || []).filter(function (d) {
        if (DEMAND_FILTER.status && d.status !== DEMAND_FILTER.status) return false
        if (DEMAND_FILTER.cat && String(d.cat || '').indexOf(DEMAND_FILTER.cat) < 0) return false
        if (DEMAND_FILTER.bizPool === '私密发布' && !isPrivateItem(d)) return false
        if (DEMAND_FILTER.bizPool === '仅发商机池' && !isPoolOnlyItem(d)) return false
        if (DEMAND_FILTER.bizPool === '普通发布' && (isPrivateItem(d) || isPoolOnlyItem(d))) return false
        if (!q) return true
        return [d.title, d.cat, d.brand, d.model, d.city, d.publisherLabel, d.id].join(' ').toLowerCase().indexOf(q) >= 0
      })
    }

    function bulkBar() {
      return '<div class="flex flex-wrap" style="gap:8px;align-items:center;margin-bottom:10px">' +
        '<button class="btn" id="dm-all-btn">全选本页</button>' +
        '<span class="small" id="dm-sel" style="color:var(--muted-2)">已选 0 项</span>' +
        '<button class="btn primary" id="dm-transfer" disabled>转移归属</button>' +
        '<span class="small" style="color:var(--muted-2)">可跨页勾选，单次最多 50 个</span>' +
        '</div>'
    }

    function render() {
      const all = DEMAND_FILTER.items || []
      const items = matched()
      const canTransfer = C.can('demand.transfer')
      /* 过滤条件变化后，把已不在结果里的勾选剔除 */
      const valid = {}
      items.forEach(function (d) { valid[d.id] = 1 })
      Array.from(DEMAND_PICK).forEach(function (id) { if (!valid[id]) DEMAND_PICK.delete(id) })
      const limit = DEMAND_FILTER.limit
      const pages = Math.max(1, Math.ceil(items.length / limit))
      if (DEMAND_FILTER.page > pages) DEMAND_FILTER.page = pages
      const page = DEMAND_FILTER.page
      const slice = items.slice((page - 1) * limit, page * limit)
      const byId = {}
      all.forEach(function (d) { byId[d.id] = d })

      const rows = slice.map(function (d) {
        const pick = canTransfer
          ? '<td><input type="checkbox" class="dm-pick" data-id="' + esc(d.id) + '"' + (DEMAND_PICK.has(d.id) ? ' checked' : '') + '></td>'
          : ''
        return '<tr>' + pick +
          '<td><div class="strong">' + esc(d.title || '—') + (isPoolOnlyItem(d) ? ' ' + poolTag() : '') + (isPrivateItem(d) ? ' ' + privateTag() : '') + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(d.id) + '</div></td>' +
          '<td>' + esc(d.publisherLabel || '—') + '</td>' +
          '<td>' + esc(d.tradeMode || '—') + '</td>' +
          '<td>' + (d.budget || d.budgetMode === 'nego' ? amountOf(d, 'budget', 'budgetMax', 'budgetMode', 'budgetUnit') : '面议') + '</td>' +
          '<td>' + num(d.qty) + '</td>' +
          '<td>' + esc(d.cond || '—') + '</td>' +
          '<td>' + autoBadge(d.status) + '</td>' +
          '<td class="small">' + esc(dateText(d.createdAt)) + '</td>' +
          '<td><div class="flex flex-wrap" style="gap:6px">' + demandActions(d) + '</div></td>' +
          '</tr>'
      })

      const heads = ['需求标题', '发布主体', '交易方式', '预算', '数量', '成色要求', '状态', '发布时间', '操作']
      if (canTransfer) heads.unshift('<input type="checkbox" id="dm-all" aria-label="全选本页">')

      list.innerHTML = (canTransfer ? bulkBar() : '') +
        table(heads, rows, '当前筛选下暂无需求') +
        pager(items.length, page, limit) +
        (DEMAND_FILTER.truncated ? '<div class="small" style="margin-top:8px;color:var(--muted-2)">数据量较大，已加载最近 ' + num(all.length) + ' 条，可结合状态 / 品类缩小范围。</div>' : '')

      wirePager(list, function (p) { DEMAND_FILTER.page = p; render() })
      list.querySelectorAll('[data-dm-detail]').forEach(function (btn) {
        btn.onclick = function () {
          const item = byId[btn.getAttribute('data-dm-detail')]
          if (item) openDemandDrawer(item, load)
        }
      })
      list.querySelectorAll('[data-dm-act]').forEach(function (btn) {
        btn.onclick = function () {
          const item = byId[btn.getAttribute('data-dm-id')]
          if (item) demandAction(btn.getAttribute('data-dm-act'), item, load)
        }
      })
      if (canTransfer) wirePick()
    }

    /* 勾选状态与批量按钮联动：全选框只作用于当前页，跨页勾选会累计 */
    function wirePick() {
      const allBox = list.querySelector('#dm-all')
      const selText = list.querySelector('#dm-sel')
      const transferBtn = list.querySelector('#dm-transfer')
      const pageIds = function () {
        return Array.prototype.map.call(list.querySelectorAll('.dm-pick'), function (box) {
          return box.getAttribute('data-id')
        })
      }
      function sync() {
        if (selText) selText.textContent = '已选 ' + DEMAND_PICK.size + ' 项'
        if (transferBtn) transferBtn.disabled = !DEMAND_PICK.size
        if (allBox) {
          const ids = pageIds()
          allBox.checked = ids.length > 0 && ids.every(function (id) { return DEMAND_PICK.has(id) })
        }
      }
      list.querySelectorAll('.dm-pick').forEach(function (box) {
        box.onchange = function () {
          const id = box.getAttribute('data-id')
          if (box.checked) DEMAND_PICK.add(id)
          else DEMAND_PICK.delete(id)
          sync()
        }
      })
      if (allBox) allBox.onchange = function () {
        pageIds().forEach(function (id) {
          if (allBox.checked) DEMAND_PICK.add(id)
          else DEMAND_PICK.delete(id)
        })
        render()
      }
      const allBtn = list.querySelector('#dm-all-btn')
      if (allBtn) allBtn.onclick = function () {
        const ids = pageIds()
        const allOn = ids.length > 0 && ids.every(function (id) { return DEMAND_PICK.has(id) })
        ids.forEach(function (id) {
          if (allOn) DEMAND_PICK.delete(id)
          else DEMAND_PICK.add(id)
        })
        render()
      }
      if (transferBtn) transferBtn.onclick = openDemandTransferModal
      sync()
    }

    /* 转移归属：先按 ID / 编号 / 手机号 / 昵称定位接收人，再批量提交（与商品转移同一套逻辑） */
    function openDemandTransferModal() {
      if (!DEMAND_PICK.size) return toast('请先勾选要转移的需求', 'err')
      if (DEMAND_PICK.size > 50) return toast('单次最多转移 50 个需求', 'err')
      const ids = Array.from(DEMAND_PICK)
      let target = null
      const root = modal({
        title: '转移需求归属',
        sub: '已选 ' + ids.length + ' 个需求，转移后由接收人管理并接收咨询',
        body: '<div class="form-grid">' +
          '<div class="field"><label>接收人</label><div class="flex" style="gap:8px">' +
          '<input id="dm-target-q" placeholder="用户 ID / 用户编号 / 手机号 / 昵称">' +
          '<button class="btn" id="dm-target-search">查找</button>' +
          '</div></div>' +
          '<div id="dm-target-list" class="small" style="color:var(--muted-2)">输入后点击「查找」，最多显示 10 个候选</div>' +
          field('转移说明', '<input id="dm-target-reason" maxlength="60" placeholder="选填，例如：客户更换账号 / 员工离职交接">') +
          '</div>',
        footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="dm-target-ok" disabled>确认转移</button>'
      })
      if (!root) return
      const box = root.body.querySelector('#dm-target-list')
      const okBtn = root.body.querySelector('#dm-target-ok')

      function renderTargets(items) {
        if (!items.length) {
          box.innerHTML = '未找到用户，请确认输入的是完整手机号或用户编号'
          return
        }
        box.innerHTML = items.map(function (u) {
          const disabled = u.status === '停用'
          return '<label style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">' +
            '<input type="radio" name="dm-target" value="' + esc(u.id) + '"' + (disabled ? ' disabled' : '') + '>' +
            '<span class="strong">' + esc(u.nick || '未设置昵称') + '</span>' +
            badge(u.status || '正常', disabled ? 'danger' : 'info') +
            '<span class="small mono" style="color:var(--muted-2);margin-left:auto">' + esc(u.userNo) + '</span>' +
            '</label>'
        }).join('')
        box.querySelectorAll('input[name="dm-target"]').forEach(function (radio) {
          radio.onchange = function () {
            target = items.filter(function (u) { return u.id === radio.value })[0] || null
            okBtn.disabled = !target || target.status === '停用'
          }
        })
      }

      async function doSearch() {
        const q = root.body.querySelector('#dm-target-q').value.trim()
        if (!q) return toast('请输入用户 ID、编号、手机号或昵称', 'err')
        box.textContent = '查找中…'
        try {
          const res = await api('demand.transferTargets', { q: q })
          renderTargets(res.items || [])
        } catch (err) {
          box.textContent = err.message || '查找失败'
        }
      }

      root.body.querySelector('#dm-target-search').onclick = doSearch
      root.body.querySelector('#dm-target-q').onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doSearch() }
      }
      okBtn.onclick = async function () {
        if (!target) return
        okBtn.disabled = true
        try {
          const res = await api('demand.transfer', {
            demandIds: ids,
            targetId: target.id,
            reason: (root.body.querySelector('#dm-target-reason').value || '').trim()
          })
          closeModal()
          DEMAND_PICK.clear()
          toast('已转移 ' + num(res.moved) + ' 个需求' + (res.skipped && res.skipped.length ? '，跳过 ' + res.skipped.length + ' 个' : ''))
          load()
        } catch (err) {
          toast(err.message, 'err')
          okBtn.disabled = false
        }
      }
    }

    async function load() {
      list.innerHTML = loadingBlock('加载需求')
      try {
        const res = await loadAllRows('demand.list', {})
        DEMAND_FILTER.items = res.items
        DEMAND_FILTER.truncated = res.truncated
        render()
      } catch (err) {
        list.innerHTML = emptyState(err.message || '需求加载失败')
      }
    }

    function search() {
      DEMAND_FILTER.q = (view.querySelector('#dm-q').value || '').trim()
      DEMAND_FILTER.status = view.querySelector('#dm-status').value
      DEMAND_FILTER.cat = (view.querySelector('#dm-cat').value || '').trim()
      DEMAND_FILTER.bizPool = view.querySelector('#dm-pool').value
      DEMAND_FILTER.page = 1
      render()
    }

    view.querySelector('#dm-search').onclick = search
    view.querySelector('#dm-q').onkeydown = function (e) { if (e.key === 'Enter') search() }
    view.querySelector('#dm-cat').onkeydown = function (e) { if (e.key === 'Enter') search() }
    view.querySelector('#dm-status').onchange = search
    view.querySelector('#dm-pool').onchange = search
    view.querySelector('#dm-refresh').onclick = function () { load() }
    load()
  }

  /* ================= 13. 代采代售（委托管理） ================= */

  /**
   * 委托列表只保留 4 个业务分组 + 全部：
   * 全部 / 上架审核中 / 已上架（含锁定、已成交） / 已完成 / 已到期或已下架（到期、下架、驳回）。
   * 旧状态「待确认」「已通过」「待确认成交」只存在于历史数据，按上述口径合并展示。
   * 新发布与修改都会在工作台生成上架审核工单；成交必须在工单中心按流程登记。
   * 商机会员不在这里，统一在「用户管理 · 商机会员」维护。
   */
  const AGENCY_STAGE_TABS = [
    { key: '', label: '全部', statuses: [] },
    { key: 'review', label: '上架审核中', statuses: ['待审核', '待确认'] },
    { key: 'active', label: '已上架', statuses: ['已上架', '已通过', '已锁定', '已成交', '待确认成交'] },
    { key: 'done', label: '已完成', statuses: ['已完成'] },
    { key: 'closed', label: '已到期或已下架', statuses: ['已关闭', '已驳回'] }
  ]
  /* 排序口径：与后端 agency.list 的 sort 参数一一对应 */
  const AGENCY_SORTS = [
    { key: 'created_desc', label: '最新提交' },
    { key: 'created_asc', label: '最早提交' },
    { key: 'amount_desc', label: '金额从高到低' },
    { key: 'deadline_asc', label: '截止时间最近' },
    { key: 'updated_desc', label: '最近更新' }
  ]
  const AGENCY_FILTER = { stage: '', side: '', sort: 'created_desc', q: '', page: 1, limit: 12, counts: {}, sideCounts: {} }

  /* 商机权限开通：与「用户管理 · 开通会员」不是同一套套餐，函数名必须区分，否则会被后者覆盖 */
  function openBizGrantModal(member, plans, onDone) {
    /* 服务端未返回套餐（接口异常 / 历史数据）时也保持四档，避免只剩月卡 */
    const defs = [
      { key: 'month', label: '月度', days: 30, price: 99 },
      { key: 'quarter', label: '季度', days: 90, price: 268 },
      { key: 'half', label: '半年', days: 180, price: 499 },
      { key: 'year', label: '年度', days: 365, price: 899 }
    ]
    const src = plans && plans.length ? plans : []
    const byKey = {}
    src.forEach(function (p) {
      const key = String((p && p.key) || '')
      if (key) byKey[key] = p
    })
    const list = defs.map(function (def) {
      const p = byKey[def.key] || {}
      return {
        key: def.key,
        label: p.label || def.label,
        days: Number(p.days) || def.days,
        price: Number(p.price) || def.price
      }
    })
    const root = modal({
      title: '开通 / 续费商机权限',
      sub: (member.nick || member.uid) + ' · 当前 ' + (member.status || '未开通'),
      body: '<div class="form-grid">' +
        field('套餐', '<select id="bz-plan">' + list.map(function (p) {
          return '<option value="' + esc(p.key) + '" data-price="' + (Number(p.price) || 0) + '">' +
            esc((p.label || p.key) + ' · ' + p.days + ' 天 · ¥' + (Number(p.price) || 0)) + '</option>'
        }).join('') + '</select>') +
        field('实收金额（元）', '<input id="bz-amount" type="number" min="0" step="0.01" value="' + (Number(list[0].price) || 0) + '">') +
        field('备注', '<input id="bz-note" maxlength="100" placeholder="选填，如客服补偿开通，会写入订单与审计">') +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="bz-ok">确认开通</button>'
    })
    if (!root) return
    const planSel = root.body.querySelector('#bz-plan')
    planSel.onchange = function () {
      const opt = planSel.options[planSel.selectedIndex]
      root.body.querySelector('#bz-amount').value = opt.getAttribute('data-price') || 0
    }
    root.querySelector('#bz-ok').onclick = async function () {
      this.disabled = true
      try {
        await api('biz.grant', {
          uid: member.uid,
          plan: planSel.value,
          amount: Number(root.body.querySelector('#bz-amount').value) || 0,
          note: root.body.querySelector('#bz-note').value.trim()
        })
        closeModal()
        toast('商机权限已开通 / 续费')
        if (typeof onDone === 'function') onDone()
      } catch (err) { toast(err.message, 'err'); this.disabled = false }
    }
  }

  /* 用户管理 · 手动改会员到期时间：按天选择，保存为当天 23:59:59 */
  function openBizExpireModal(member, onDone) {
    const current = Number(member.expireAt) || 0
    const from = current > Date.now() ? new Date(current) : new Date(Date.now() + 30 * 86400e3)
    const pad2 = function (n) { return String(n).padStart(2, '0') }
    const value = from.getFullYear() + '-' + pad2(from.getMonth() + 1) + '-' + pad2(from.getDate())
    const root = modal({
      title: '修改会员到期时间',
      sub: member.nick || member.uid,
      body: '<div class="form-grid">' +
        field('到期日期', '<input id="u-expire-at" type="date" value="' + value + '">') +
        '<div class="field full"><label>修改说明</label><input id="u-expire-note" maxlength="100" placeholder="如：线下补偿 30 天（写入操作日志并站内信通知用户）"></div>' +
        '</div>' +
        '<div class="small" style="margin-top:10px;color:var(--muted-2);line-height:1.7">到期日当天 23:59:59 前仍可使用；已停用的账号改到期不会自动恢复，需要重新开通。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="u-expire-ok">保存</button>'
    })
    if (!root) return
    root.querySelector('#u-expire-ok').onclick = async function () {
      const day = root.body.querySelector('#u-expire-at').value
      if (!day) { toast('请选择到期日期'); return }
      const expireAt = new Date(day + 'T23:59:59').getTime()
      if (!expireAt) { toast('到期日期不正确', 'err'); return }
      this.disabled = true
      try {
        await api('biz.setExpire', {
          uid: member.uid,
          expireAt: expireAt,
          reason: root.body.querySelector('#u-expire-note').value.trim()
        })
        closeModal()
        toast('到期时间已更新')
        if (typeof onDone === 'function') onDone()
      } catch (err) { toast(err.message, 'err'); this.disabled = false }
    }
  }

  function openRevokeModal(member, onDone) {
    reasonModal({
      title: '停用商机权限',
      sub: member.nick || member.uid,
      label: '停用原因',
      reasons: ['用户申请停用', '退款处理', '违规使用商机', '套餐到期处理', '其他'],
      okText: '停用',
      danger: true
    }, async function (reason, btn) {
      btn.disabled = true
      try {
        await api('biz.revoke', { uid: member.uid, reason: reason })
        closeModal()
        toast('商机权限已停用')
        if (typeof onDone === 'function') onDone()
      } catch (err) { toast(err.message, 'err'); btn.disabled = false }
    })
  }

  /* ---------------- 电销线索：多次打开会员页但没下单 ---------------- */
  Pages.sales = async function (view) {
    const filters = { q: '', days: 7, minOpens: 2, page: 1, limit: 12 }
    let meta = { total: 0, days: 7, minOpens: 2 }

    view.innerHTML = pageHead('电销线索', '多次打开商机会员页却没开通的用户，按打开次数排序，可直接拨号',
      '<button class="btn" id="sl-refresh">' + icon('search') + '<span>刷新</span></button>') +
      '<div class="filters" style="margin-bottom:16px"><div class="filter-grid">' +
      '<div class="field wide"><label>关键词</label><input id="sl-q" placeholder="昵称 / 用户ID / 手机号 / 城市"></div>' +
      field('统计窗口', '<select id="sl-days">' + options([
        { value: '1', label: '近 1 天' }, { value: '3', label: '近 3 天' },
        { value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }
      ], '7') + '</select>') +
      field('最少打开次数', '<select id="sl-min">' + options([
        { value: '2', label: '≥ 2 次' }, { value: '3', label: '≥ 3 次' }, { value: '5', label: '≥ 5 次' }
      ], '2') + '</select>') +
      '<div class="field action"><label>&nbsp;</label><div class="flex" style="gap:8px">' +
      '<button class="btn primary" id="sl-search">' + icon('search') + '<span>筛选</span></button></div></div>' +
      '</div></div><div id="sl-summary"></div>' +
      '<section class="card" style="margin-top:16px"><div class="card-body flush"><div id="sl-table">' + loadingBlock() + '</div></div></section>'

    const qInput = view.querySelector('#sl-q')
    const dSelect = view.querySelector('#sl-days')
    const mSelect = view.querySelector('#sl-min')

    function rowHtml(u) {
      const member = u.memberStatus === '未开通'
        ? badge('未开通', 'warn')
        : autoBadge(u.memberStatus) + (u.expireAt ? '<div class="small" style="color:var(--muted-2)">' + dayText(u.expireAt) + ' 到期</div>' : '')
      const phone = u.phone
        ? '<span class="mono strong">' + esc(u.phone) + '</span>'
        : '<span class="small" style="color:var(--muted-2)">未授权手机号</span>'
      const call = u.phone
        ? '<a class="btn xs primary" href="tel:' + esc(u.phone) + '">拨号</a>' +
          '<button class="btn xs" data-copy="' + esc(u.phone) + '">复制</button>'
        : ''
      return '<td><div class="flex" style="gap:8px;align-items:center"><span class="avatar sm">' + esc(String(u.nick || '用').slice(0, 1)) + '</span>' +
        '<div><div class="strong">' + esc(u.nick || '未命名') + '</div>' +
        '<div class="small mono" style="color:var(--ink-2)">' + esc(u.userNo || '') + '</div>' +
        '<div class="small" style="color:var(--muted-2)">' + esc(u.city || '未填城市') + (u.subjectType ? ' · ' + esc(u.subjectType) : '') + '</div></div></div></td>' +
        '<td><div class="strong">' + num(u.open7d) + ' 次</div>' +
        '<div class="small" style="color:var(--muted-2)">今天 ' + num(u.open1d) + ' 次</div></td>' +
        '<td class="small">' + esc(ago(u.lastAt)) + '<div class="small" style="color:var(--muted-2)">首次 ' + esc(ago(u.firstAt)) + '</div></td>' +
        '<td>' + member + '</td>' +
        '<td>' + phone + '</td>' +
        '<td><div class="flex" style="gap:6px;flex-wrap:wrap">' + call +
        '<button class="btn xs" data-open-user="' + esc(u.id) + '">档案</button></div></td>'
    }

    async function load() {
      const box = view.querySelector('#sl-table')
      box.innerHTML = loadingBlock('统计会员页打开次数')
      try {
        const data = await api('sales.unpaid', {
          q: filters.q, days: filters.days, minOpens: filters.minOpens,
          page: filters.page, limit: filters.limit
        })
        meta = { total: data.total || 0, days: data.days || filters.days, minOpens: data.minOpens || filters.minOpens }
        view.querySelector('#sl-summary').innerHTML = kpiRow([
          ['待跟进用户', num(meta.total), '<span class="small" style="color:var(--muted-2)">近 ' + meta.days + ' 天打开 ≥ ' + meta.minOpens + ' 次</span>'],
          ['当前页', num((data.items || []).length), '<span class="small" style="color:var(--muted-2)">按打开次数降序</span>'],
          ['口径', '未开通', '<span class="small" style="color:var(--muted-2)">排除已购买会员与有效会员</span>']
        ])
        const rows = (data.items || []).map(rowHtml)
        box.innerHTML = table(['用户', '打开次数', '最近打开', '会员状态', '手机号', '操作'], rows, '当前条件下没有待跟进用户') +
          (rows.length ? pager(meta.total, filters.page, filters.limit) : '')
        box.querySelectorAll('[data-open-user]').forEach(function (btn) {
          btn.onclick = function () { openUserDrawer(btn.getAttribute('data-open-user')) }
        })
        box.querySelectorAll('[data-copy]').forEach(function (btn) {
          btn.onclick = function () {
            const text = btn.getAttribute('data-copy')
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () { toast('手机号已复制') }).catch(function () { toast('复制失败，请手动选择', 'err') })
            } else {
              toast('当前浏览器不支持一键复制', 'err')
            }
          }
        })
        wirePager(box, function (p) { filters.page = p; load() })
      } catch (err) {
        box.innerHTML = emptyState(err.message || '加载失败')
      }
    }

    function search() {
      filters.q = qInput.value.trim()
      filters.days = dSelect.value
      filters.minOpens = mSelect.value
      filters.page = 1
      load()
    }
    view.querySelector('#sl-search').onclick = search
    view.querySelector('#sl-refresh').onclick = search
    qInput.onkeydown = function (e) { if (e.key === 'Enter') search() }
    load()
  }

  Pages.biz = async function (view) {
    /* 工作台待审核弹窗可直接跳到「待审核」筛选 */
    const jumpReview = (state.pageQuery && state.pageQuery.agencyStatus) || ''
    if (jumpReview) {
      state.pageQuery = null
      AGENCY_FILTER.stage = 'review'
      AGENCY_FILTER.page = 1
    }
    view.innerHTML = pageHead(
      '代采代售委托',
      '提交委托 → 平台核对 → 审核通过即上架 → 对接中 → 工单中心按流程登记成交 → 服务费到账 → 确认完成。状态只保留「待审核 / 对接中 / 交易中 / 已完成 / 已结束」；成交必须在工单中心走「确定对接方 → 合同归档 → 登记成交」，本页不提供直接成交入口。',
      '<button class="btn" data-go="users">' + icon('users') + '<span>用户管理</span></button>' +
      '<button class="btn" id="bz-refresh" style="margin-left:8px">刷新</button>'
    ) + '<div id="bz-body" style="margin-top:14px">' + loadingBlock('加载委托') + '</div>'

    const body = view.querySelector('#bz-body')

    function stageOf() {
      for (let i = 0; i < AGENCY_STAGE_TABS.length; i += 1) {
        if (AGENCY_STAGE_TABS[i].key === AGENCY_FILTER.stage) return AGENCY_STAGE_TABS[i]
      }
      return AGENCY_STAGE_TABS[0]
    }

    function rowHtml(a) {
      const isBuy = a.side === 'buy'
      const dealPending = agencyDealPending(a)
      const deadline = a.deadlineText || a.deadline || (a.expiresAt ? dateText(a.expiresAt) : '')
      /* 咨询单的标准流程进度：管理员在委托列表就能看到作业走到第几步；终止单独标红 */
      const consultLine = (a.consultStage
        ? (a.consultState === 'aborted'
          ? '<div class="small" style="color:var(--danger)">咨询 · 已终止' + (a.consultCsName ? ' · ' + esc(a.consultCsName) : '') + '</div>'
          : '<div class="small" style="color:var(--muted-2)">咨询 ' + (cfStepIndex(a.consultStage) + 1) + '/' + CF_STAGES.length +
            ' · ' + esc(a.consultStageLabel || '') + (a.consultCsName ? ' · ' + esc(a.consultCsName) : '') + '</div>')
        : '') +
        (Number(a.consultTotal) > 1
          ? '<div class="small" style="color:var(--warn)">同委托 ' + num(a.consultTotal) + ' 人咨询 · ' +
            num(a.consultActive) + ' 人在对接</div>'
          : '')
      /* 整行可点进入详情抽屉：正文 / 表格内不再放「审核 / 详情」按钮 */
      return '<tr data-order="' + esc(a.id) + '" class="row-link">' +
        '<td><div class="strong">' + esc(a.item || '—') + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(a.id) + '</div></td>' +
        '<td>' + badge(a.kind || (isBuy ? '代采' : '代售'), isBuy ? 'info' : 'ok', true) + '</td>' +
        '<td><div class="strong">' + esc(a.ownerNick || '—') + '</div><div class="small mono" style="color:var(--muted-2)">' + esc(a.ownerUserNo || a.ownerId || '') + '</div></td>' +
        '<td>' + num(a.qty) + ' 台<div class="small" style="color:var(--muted-2)">' + (isBuy ? '预算 ' : '报价 ') + money(a.amount) + '</div></td>' +
        '<td>' + esc(a.city || '不限') + '</td>' +
        '<td>' + money(a.serviceFee) + '</td>' +
        '<td>' + agencyOrderBadge(a) + consultLine +
        (dealPending ? '<div class="small" style="color:var(--warn)">旧数据 · 请到工单中心登记成交</div>'
          : (a.status === '已上架' || a.status === '已锁定' || agencyExpired(a)) && deadline
            ? '<div class="small" style="color:var(--muted-2)">' + (agencyExpired(a) ? '到期 ' : '截止 ') + esc(deadline) + '</div>' : '') + '</td>' +
        '<td class="small">' + esc(a.createdText || dateText(a.createdAt)) + '</td>' +
        '</tr>'
    }

    function render(items, data) {
      const counts = data.counts || AGENCY_FILTER.counts || {}
      AGENCY_FILTER.counts = counts
      const sideCounts = data.sideCounts || AGENCY_FILTER.sideCounts || {}
      AGENCY_FILTER.sideCounts = sideCounts
      body.innerHTML =
        '<div class="grid g5">' +
          kpi('全部委托', num(sideCounts.all || 0), '代采 / 代售全部委托') +
          kpi('上架审核中', num(Number(counts['待审核'] || 0) + Number(counts['待确认'] || 0)), '提交后自动生成审核工单，在工作台核对资料') +
          kpi('已上架', num(Number(counts['已上架'] || 0) + Number(counts['已通过'] || 0) + Number(counts['已锁定'] || 0) + Number(counts['已成交'] || 0) + Number(counts['待确认成交'] || 0)), '已上架对外展示，成交在工单中心按流程登记') +
          kpi('已完成', num(counts['已完成'] || 0), '工单走完且服务费到账') +
          kpi('已到期或已下架', num(Number(counts['已关闭'] || 0) + Number(counts['已驳回'] || 0)), '到期、人工下架或审核驳回') +
        '</div>' +
        '<div style="height:14px"></div>' +
        /* 方向 tab 带总量：代采 / 代售各自多少单一眼可见，切换方向不影响角标口径 */
        '<div class="seg" id="bz-sides" style="margin-bottom:10px">' +
          [{ key: '', label: '全部方向' }, { key: 'buy', label: '代采' }, { key: 'sell', label: '代售' }].map(function (t) {
            const c = t.key ? Number(sideCounts[t.key] || 0) : Number(sideCounts.all || 0)
            return '<button data-side="' + t.key + '"' + (AGENCY_FILTER.side === t.key ? ' class="on"' : '') + '>' +
              esc(t.label) + ' ' + num(c) + '</button>'
          }).join('') + '</div>' +
        filterBar([
          '<div class="field" style="min-width:220px"><label>关键词</label><input id="bz-q" placeholder="型号 / 主体 / 城市 / 手机号" value="' + esc(AGENCY_FILTER.q) + '"></div>',
          '<div class="field" style="min-width:160px"><label>排序</label><select id="bz-sort">' +
            AGENCY_SORTS.map(function (s) {
              return '<option value="' + esc(s.key) + '"' + (AGENCY_FILTER.sort === s.key ? ' selected' : '') + '>' + esc(s.label) + '</option>'
            }).join('') + '</select></div>',
          '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="bz-search">' + icon('search') + '<span>查询</span></button></div>'
        ]) +
        /* 分类以横向 Tab 固定在委托列表正上方，切 Tab 即按阶段过滤 */
        card('委托列表',
          '<div class="tabs" id="bz-stages">' + AGENCY_STAGE_TABS.map(function (t) {
            const c = t.statuses.length
              ? t.statuses.reduce(function (n, s) { return n + Number(counts[s] || 0) }, 0)
              : Number(sideCounts.all || 0)
            return '<button data-stage="' + t.key + '"' + (AGENCY_FILTER.stage === t.key ? ' class="on"' : '') + '>' +
              esc(t.label) + '<span class="count">' + num(c) + '</span></button>'
          }).join('') + '</div>' +
          table(['委托单', '方向', '委托方', '数量 / 金额', '城市', '服务费', '进度', '提交时间'], items.map(rowHtml), '该阶段暂无委托') +
          (data.total > data.limit ? pager(data.total, data.page, data.limit) : ''), '', true)

      const byId = {}
      ;(items || []).forEach(function (a) { byId[a.id] = a })
      body.querySelectorAll('[data-order]').forEach(function (btn) {
        btn.onclick = function () {
          const item = byId[btn.getAttribute('data-order')]
          if (item) openAgencyOrder(item, function () { load() })
        }
      })
      body.querySelectorAll('[data-side]').forEach(function (btn) {
        btn.onclick = function () {
          AGENCY_FILTER.side = btn.getAttribute('data-side')
          AGENCY_FILTER.page = 1
          load()
        }
      })
      body.querySelectorAll('[data-stage]').forEach(function (btn) {
        btn.onclick = function () {
          AGENCY_FILTER.stage = btn.getAttribute('data-stage')
          AGENCY_FILTER.page = 1
          load()
        }
      })
      const sortSel = body.querySelector('#bz-sort')
      if (sortSel) {
        sortSel.onchange = function () {
          AGENCY_FILTER.sort = sortSel.value || 'created_desc'
          AGENCY_FILTER.page = 1
          load()
        }
      }
      wirePager(body, function (p) { AGENCY_FILTER.page = p; load() })
      const search = function () {
        AGENCY_FILTER.q = (body.querySelector('#bz-q').value || '').trim()
        AGENCY_FILTER.page = 1
        load()
      }
      body.querySelector('#bz-search').onclick = search
      body.querySelector('#bz-q').onkeydown = function (e) { if (e.key === 'Enter') search() }
    }

    async function load() {
      body.innerHTML = loadingBlock('加载委托')
      const stage = stageOf()
      const payload = { page: AGENCY_FILTER.page, limit: AGENCY_FILTER.limit, sort: AGENCY_FILTER.sort || 'created_desc' }
      if (stage.statuses.length) payload.statuses = stage.statuses
      if (AGENCY_FILTER.side) payload.side = AGENCY_FILTER.side
      if (AGENCY_FILTER.q) payload.keyword = AGENCY_FILTER.q
      try {
        const data = await api('agency.list', payload)
        render(data.items || [], data)
      } catch (err) {
        body.innerHTML = card('委托管理', '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>')
      }
    }

    view.querySelector('[data-go="users"]').onclick = function () { C.navigate('users') }
    view.querySelector('#bz-refresh').onclick = function () { load() }
    load()
  }

  /* ============================================================
     咨询工单：代采代售咨询的标准服务流程
     —— 领取 → 沟通 → 条件确认 → 居间合同归档 → 客服登记成交（平台确认）
     —— → 服务费到账 → 客服确认完成（工单与委托同时归档，佣金随服务费自动计提）
     ============================================================ */
  const CF_STAGES = [
    ['communicating', '沟通中'],
    ['terms', '条件已确认'],
    ['contract', '居间合同待审核'],
    ['signed', '居间合同已归档'],
    ['fee', '服务费待支付'],
    ['paid', '服务费已到账'],
    ['done', '已完成']
  ]
  /* 分栏顺序即业务推进顺序：待领取 → 沟通 → 合同 → 服务费 → 待完成
     已完成 / 已终止的工单不在工作台展示，改到「代采代售」按工单状态查看 */
  const CF_TABS = [
    ['all', '全部'],
    ['unclaimed', '待领取'],
    ['audit', '上架审核'],
    ['communicating', '沟通中'],
    ['review', '合同待审核'],
    ['contract', '合同进度'],
    ['fee', '待付服务费'],
    ['paid', '待完成']
  ]
  const CF = {
    tab: 'all',
    q: '',
    leadId: '',
    jumpLead: '',
    counts: {},
    items: [],
    detail: null,
    msgs: [],
    msgsSig: '',
    revealed: null,
    denied: '',
    staff: []
  }

  /* ---------------- 工单台自动刷新 ---------------- */

  /* 每 15 秒拉一次工单列表；选中工单仍在时只重画列表，不打断正在看的会话与回复草稿 */
  let cfPollTimer = null
  let cfPollSig = ''

  function cfMsgsSig(list) {
    return (list || []).map(function (m) {
      return m.id || (m.createdAt + '|' + String(m.body || '').length)
    }).join(',')
  }

  function cfStopPoll() {
    if (cfPollTimer) {
      clearInterval(cfPollTimer)
      cfPollTimer = null
    }
  }

  function cfStartPoll() {
    cfStopPoll()
    cfPollTimer = setInterval(cfAutoRefresh, 15000)
  }

  async function cfAutoRefresh() {
    const body = document.getElementById('cf-body')
    if (!body) { cfStopPoll(); return }
    /* 弹窗打开或正在输入时暂停，避免打断操作 */
    const modalEl = document.getElementById('modal')
    if (modalEl && !modalEl.hidden) return
    const active = document.activeElement
    if (active && (active.id === 'cf-reply' || active.id === 'cf-q')) return
    let data
    try {
      data = await api('consult.list', { tab: CF.tab, q: CF.q, page: 1, limit: 80 })
    } catch (err) { return }
    const items = data.items || []
    const counts = data.counts || {}
    const sig = JSON.stringify([items, counts])
    const keep = CF.leadId
    const before = (CF.items || []).find(function (it) { return it.leadId === keep }) || {}
    if (sig !== cfPollSig) {
      cfPollSig = sig
      const draftEl = document.getElementById('cf-reply')
      const draft = draftEl ? draftEl.value : ''
      CF.items = items
      CF.counts = counts
      cfPaintTabs()
      const current = items.find(function (it) { return it.leadId === keep })
      if (!current) {
        CF.leadId = items.length ? items[0].leadId : ''
        if (CF.leadId) await cfPick(CF.leadId)
      } else {
        cfPaintList()
        /* 阶段变了（用户付款 / 合同状态变化）才重拉详情，普通新消息只刷会话 */
        if (current.stage !== before.stage || current.contractStatus !== before.contractStatus) {
          await cfPick(keep)
        } else if (draft) {
          const box = document.getElementById('cf-reply')
          if (box) box.value = draft
        }
      }
    }
    await cfSyncChat()
  }

  /* 会话增量刷新：只有消息发生变化才重画，保留回复草稿、焦点与阅读位置 */
  async function cfSyncChat() {
    if (!CF.detail || !CF.leadId) return
    const lead = CF.detail.lead || {}
    if (lead.ticketKind === 'audit') return
    let res
    try {
      res = await api('msg.list', { threadId: cfThreadId(), limit: 80 })
    } catch (err) { return }
    const items = res.items || []
    const sig = cfMsgsSig(items)
    if (sig === CF.msgsSig) return
    CF.msgsSig = sig
    CF.msgs = items
    const input = document.getElementById('cf-reply')
    const draft = input ? input.value : ''
    const focused = !!input && document.activeElement === input
    const stream = document.getElementById('cf-stream')
    const top = stream ? stream.scrollTop : 0
    const nearBottom = stream ? (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 100) : true
    cfPaintChat()
    const box = document.getElementById('cf-reply')
    if (box && draft) box.value = draft
    if (box && focused) box.focus()
    const next = document.getElementById('cf-stream')
    if (next) next.scrollTop = nearBottom ? next.scrollHeight : top
  }

  function cfTone(stage) {
    if (stage === 'done' || stage === 'paid' || stage === 'signed') return 'ok'
    if (stage === 'aborted' || stage === 'fee') return 'danger'
    if (stage === 'communicating') return 'info'
    return 'warn'
  }

  function cfStageText(stage) {
    if (stage === 'aborted') return '已终止'
    if (stage === 'audit') return '上架审核中'
    for (let i = 0; i < CF_STAGES.length; i += 1) {
      if (CF_STAGES[i][0] === stage) return CF_STAGES[i][1]
    }
    return stage || '沟通中'
  }

  function cfStepIndex(stage) {
    for (let i = 0; i < CF_STAGES.length; i += 1) {
      if (CF_STAGES[i][0] === stage) return i
    }
    return -1
  }

  /**
   * 阶段进度：竖排 8 步，已完成 / 当前 / 未开始三态。
   * 每一步推进都会写入 stageHistory，这里把「谁确认的 / 什么时候确认的」直接标在步骤上，
   * 管理员不用再翻阶段记录就能看到每一步的确认情况。
   */
  function cfTrail(stage, aborted, history) {
    const idx = cfStepIndex(stage)
    const confirmed = {}
    ;(Array.isArray(history) ? history : []).forEach(function (h) {
      if (h && h.stage) confirmed[h.stage] = h
    })
    const rows = CF_STAGES.map(function (s, i) {
      const state = aborted ? 'off' : i < idx ? 'done' : i === idx ? 'now' : 'todo'
      const hit = i <= idx ? confirmed[s[0]] : null
      const meta = hit
        ? [hit.by ? esc(hit.by) : '', hit.at ? dateText(hit.at) : ''].filter(Boolean).join(' · ')
        : ''
      return '<div class="cf-trail-row ' + state + '"><span class="cf-dot"></span><span>' + esc(s[1]) + '</span>' +
        (meta
          ? '<span class="small" style="margin-left:auto;color:var(--muted-2)"' +
            (hit.note ? ' title="' + esc(hit.note) + '"' : '') + '>' +
            (i === idx && !aborted ? '<span style="color:var(--brand);margin-right:6px">当前</span>' : '') + meta + '</span>'
          : i === idx && !aborted
            ? '<span class="small" style="margin-left:auto;color:var(--brand)">当前</span>' : '') +
        '</div>'
    })
    if (aborted) rows.push('<div class="cf-trail-row off"><span class="cf-dot"></span><span>已终止服务</span></div>')
    return '<div class="cf-trail">' + rows.join('') + '</div>'
  }

  /**
   * 工单列表卡片：正文只放信息，卡片底部是统一的「查看详情」操作区。
   * 整张卡片可点，不在正文里散落任何按钮。
   */
  function cfPaintList() {
    const list = document.getElementById('cf-list')
    if (!list) return
    const cnt = document.getElementById('cf-list-count')
    if (cnt) cnt.textContent = CF.items.length + ' 单'
    if (!CF.items.length) {
      list.innerHTML = emptyState(CF.tab === 'unclaimed' ? '暂无待领取工单：用户从代采 / 代售发来咨询后会出现在这里' : '当前分栏暂无工单')
      return
    }
    list.innerHTML = CF.items.map(function (it) {
      const on = it.leadId === CF.leadId
      const audit = it.ticketKind === 'audit'
      const title = it.title || (audit ? '委托审核' : '委托咨询')
      const owner = it.unclaimed ? '待领取' : (it.ownerName || it.csName || '未指派')
      const review = it.contractStatus === '待审核'
      return '<div class="cf-list-item' + (on ? ' on' : '') + '" data-lead="' + esc(it.leadId) + '">' +
        '<div class="t">' + esc(title) + '</div>' +
        '<div class="m">' + badge(it.sideLabel || '代采', 'brand') +
        badge(it.stageLabel || '沟通中', cfTone(it.stage)) + '</div>' +
        '<div class="cf-list-meta">' +
        '<span>' + esc(owner) + '</span>' +
        (it.amount ? '<span>' + money(it.amount) + '</span>' : '') +
        (Number(it.consultTotal) > 1
          ? '<span title="同一委托的咨询工单总数">同委托 ' + num(it.consultTotal) + ' 人咨询</span>' : '') +
        (Number(it.consultActive) > 1
          ? '<span style="color:var(--warn)" title="同一委托下仍在对接的工单数">' +
            num(it.consultActive) + ' 人在对接</span>' : '') +
        '<span class="cf-list-ago">' + esc(ago(it.stageAt || it.createdAt)) + '</span>' +
        '</div>' +
        '<div class="cf-list-foot">' +
        '<span>' + (audit
          ? (it.unclaimed ? '上架审核 · 领取后处理' : '上架审核 · 点击处理')
          : (it.unclaimed ? '待领取 · 点击领取并沟通' : review ? '合同待审核 · 点击处理' : '点击查看工单详情')) + '</span>' +
        '<span class="cf-list-arrow">›</span></div>' +
        '</div>'
    }).join('')
    list.querySelectorAll('[data-lead]').forEach(function (el) {
      el.onclick = function () { cfPick(el.getAttribute('data-lead')) }
    })
  }

  /** 顶部指标：管理员一眼看到待审核与各阶段积压 */
  function cfPaintKpi() {
    const el = document.getElementById('cf-kpi')
    if (!el) return
    const c = CF.counts || {}
    el.innerHTML = kpiRow([
      ['待领取工单', num(c.unclaimed || 0), '<span class="small" style="color:' + (c.unclaimed ? 'var(--warn)' : 'var(--muted-2)') + '">先领取再沟通</span>'],
      ['上架审核', num(c.audit || 0), '<span class="small" style="color:' + (c.audit ? 'var(--warn)' : 'var(--muted-2)') + '">新发布委托待审核</span>'],
      ['进行中', num(Math.max(0, Number(c.all || 0) - Number(c.unclaimed || 0))), '<span class="small" style="color:var(--muted-2)">已领取跟进</span>'],
      ['合同待审核', num(c.review || 0), '<span class="small" style="color:' + (c.review ? 'var(--danger)' : 'var(--muted-2)') + '">管理员处理</span>'],
      ['服务费待支付', num(c.fee || 0), '<span class="small" style="color:var(--muted-2)">等委托方打款 → 财务确认</span>'],
      ['服务费已到账', num(c.paid || 0), '<span class="small" style="color:var(--muted-2)">客服点确认完成即结束</span>']
    ])
  }

  function cfPaintTabs() {
    const el = document.getElementById('cf-tabs')
    if (!el) return
    cfPaintKpi()
    el.innerHTML = CF_TABS.map(function (t) {
      const n = Number(CF.counts[t[0]]) || 0
      return '<button data-cf-tab="' + t[0] + '" class="' + (CF.tab === t[0] ? 'on' : '') + '">' +
        esc(t[1]) + '<span class="count">' + (n ? n : '') + '</span></button>'
    }).join('')
    el.querySelectorAll('[data-cf-tab]').forEach(function (btn) {
      btn.onclick = function () {
        CF.tab = btn.getAttribute('data-cf-tab')
        cfReload(false)
      }
    })
  }

  /** 三栏骨架：工单列表 / 左对话 / 右委托信息 */
  function cfPaintShell(body) {
    /* 右栏拆成「可滚动正文 + 固定操作栏」：所有操作与查看入口都贴在工单底部 */
    body.innerHTML =
      '<div class="cf-grid">' +
      '<section class="card cf-col">' +
      '<div class="cf-col-head"><span>工单列表</span><span class="small" id="cf-list-count"></span></div>' +
      '<div class="card-body flush" id="cf-list"></div>' +
      '</section>' +
      '<section class="card cf-col">' +
      '<div class="cf-col-head"><span>沟通会话</span><span class="small">进度自动同步给用户</span></div>' +
      '<div class="card-body" id="cf-chat"></div>' +
      '</section>' +
      '<section class="card cf-info cf-info-card">' +
      '<div class="cf-col-head"><span>委托详情</span><span class="small">操作在底部</span></div>' +
      '<div class="card-body cf-info-body" id="cf-info"></div>' +
      '<div class="cf-foot" id="cf-actions" hidden></div>' +
      '</section>' +
      '</div>'
    cfPaintList()
  }

  async function cfReload(keep) {
    const body = document.getElementById('cf-body')
    if (!body) return
    if (!keep) body.innerHTML = loadingBlock('读取咨询工单')
    let data
    try {
      data = await api('consult.list', { tab: CF.tab, q: CF.q, page: 1, limit: 80 })
    } catch (err) {
      body.innerHTML = card('咨询工单', '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>')
      return
    }
    CF.items = data.items || []
    CF.counts = data.counts || {}
    cfPollSig = JSON.stringify([CF.items, CF.counts])
    cfPaintTabs()
    const exists = CF.items.some(function (it) { return it.leadId === CF.leadId })
    /* 深链指向的工单可能在当前筛选 / 权限范围外，给出提示而不是空白 */
    if (CF.jumpLead && !CF.items.some(function (it) { return it.leadId === CF.jumpLead })) {
      toast('未找到该工单：可能已被终止、删除或不在你的权限范围', 'err')
    }
    CF.jumpLead = ''
    /* 刷新时保留当前选中；仅当原工单不在当前筛选结果里才回落到第一条 */
    if (!CF.leadId || !exists) CF.leadId = CF.items.length ? CF.items[0].leadId : ''
    cfPaintShell(body)
    if (CF.leadId) {
      await cfPick(CF.leadId)
    } else {
      const chat = document.getElementById('cf-chat')
      const info = document.getElementById('cf-info')
      const foot = document.getElementById('cf-actions')
      if (chat) chat.innerHTML = emptyState('暂无选中的咨询工单')
      if (info) info.innerHTML = emptyState('选中左侧工单查看委托内容')
      if (foot) { foot.hidden = true; foot.innerHTML = '' }
    }
  }

  /** 选中工单：拉详情 + 会话；未领取时 detail 抛 FORBIDDEN，转成领取提示 */
  async function cfPick(leadId) {
    if (!leadId) return
    CF.leadId = leadId
    CF.detail = null
    CF.msgs = []
    CF.msgsSig = ''
    CF.revealed = null
    CF.denied = ''
    cfPaintList()
    const chat = document.getElementById('cf-chat')
    const info = document.getElementById('cf-info')
    const foot = document.getElementById('cf-actions')
    if (chat) chat.innerHTML = loadingBlock('读取会话')
    if (info) info.innerHTML = loadingBlock('读取工单')
    if (foot) { foot.hidden = true; foot.innerHTML = '' }
    try {
      CF.detail = await api('consult.detail', { leadId: leadId })
    } catch (err) {
      if (err && err.code === 'FORBIDDEN') {
        CF.denied = err.message || '该工单尚未领取'
      } else {
        if (chat) chat.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>'
        if (info) info.innerHTML = ''
        if (foot) { foot.hidden = true; foot.innerHTML = '' }
        return
      }
    }
    /* 审核工单不面向用户对话，没有会话可拉，直接跳过 */
    const isAudit = !!(CF.detail && CF.detail.lead && CF.detail.lead.ticketKind === 'audit')
    if (CF.detail && !isAudit) {
      try {
        const res = await api('msg.list', { threadId: cfThreadId(), limit: 80 })
        CF.msgs = res.items || []
        CF.msgsSig = cfMsgsSig(CF.msgs)
      } catch (err) {
        CF.msgs = []
        CF.msgsSig = ''
      }
    }
    cfPaintChat()
    cfPaintInfo()
  }

  function cfThreadId() {
    const lead = (CF.detail && CF.detail.lead) || {}
    return lead.threadId || CF.leadId
  }

  function cfMsgHtml(m) {
    if (!m) return ''
    if (m.from === 'system') return '<div class="chat-note">' + esc(m.body || '') + '</div>'
    const mine = m.from === 'staff'
    let body
    if (m.kind === 'image' && m.image) {
      body = '<img src="' + esc(m.image) + '" alt="图片" style="max-width:220px;border-radius:10px">'
    } else if (m.kind === 'video' && m.video) {
      body = '<video src="' + esc(m.video) + '" controls style="max-width:240px;border-radius:10px"></video>'
    } else {
      body = esc(m.body || '')
    }
    return '<div class="chat-bubble' + (mine ? ' me' : '') + '">' +
      '<div class="meta">' + esc((mine ? '客服' : '用户') + ' · ' + dateText(m.createdAt)) + '</div>' +
      '<div class="body">' + body + '</div></div>'
  }

  function cfPaintChat() {
    const box = document.getElementById('cf-chat')
    if (!box) return
    if (!CF.detail) {
      box.innerHTML = '<div class="small" style="color:var(--muted);line-height:1.9">' +
        '<div class="strong" style="color:var(--ink);margin-bottom:6px">该工单尚未领取</div>' +
        esc(CF.denied || '领取后才能查看对话、委托内容与双方联系方式。') + '</div>' +
        '<div class="chat-note" style="margin-top:14px">领取入口在右栏「委托详情」底部</div>'
      return
    }
    const d = CF.detail
    const lead = d.lead || {}
    /* 上架审核工单不面向用户沟通：不展示会话，也不提供回复框 */
    if (lead.ticketKind === 'audit') {
      const a = d.agency || {}
      const audit = d.audit || {}
      box.innerHTML =
        '<div class="flex flex-wrap" style="align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--line)">' +
        '<div class="strong" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        esc(lead.targetTitle || a.item || '委托审核') + '</div>' +
        badge(lead.sideLabel || a.kind || '代采', 'brand') +
        badge('上架审核中', 'warn') +
        '<div class="grow"></div>' +
        '<span class="small" style="color:var(--muted)">' + esc(lead.csName || '') + '</span>' +
        '</div>' +
        '<div class="chat-note" style="margin-top:18px;line-height:1.9">' +
        '<div class="strong" style="color:var(--ink);margin-bottom:6px">审核工单无需对话</div>' +
        '用户发布或修改委托后自动生成此工单。请在右侧核对委托内容与上传材料：' +
        '一致即通过，通过后委托立即上架；有问题点驳回并填写原因，用户会收到站内信，可修改后重新提交。' +
        '</div>' +
        '<div class="small" style="color:var(--muted);margin-top:14px">提交时间 ' +
        esc(dateText(audit.submittedAt || lead.createdAt)) + '</div>'
      return
    }
    const ended = d.stage === 'done' || d.stage === 'aborted'
    box.innerHTML =
      '<div class="flex flex-wrap" style="align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--line)">' +
      '<div class="strong" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(lead.targetTitle || '咨询对话') + '</div>' +
      badge(lead.sideLabel || '代采', 'brand') +
      badge(d.stageLabel || cfStageText(d.stage), cfTone(d.stage)) +
      '<div class="grow"></div>' +
      '<span class="small" style="color:var(--muted)">' + esc(lead.csName || '') + '</span>' +
      '</div>' +
      '<div class="chat-stream" id="cf-stream">' +
      (CF.msgs.length ? CF.msgs.map(cfMsgHtml).join('') : '<div class="chat-note">暂无对话记录，可主动联系双方了解需求</div>') +
      '</div>' +
      (ended
        ? '<div class="chat-note">工单已结束，会话不再接收新消息</div>'
        : '<div style="border-top:1px solid var(--line);padding-top:10px">' +
          quickReplyBar(d.stage) +
          '<div class="flex" style="gap:8px">' +
          '<input id="cf-reply" placeholder="输入回复，回车发送" maxlength="1000" style="flex:1">' +
          '<button class="btn primary" id="cf-send">发送</button></div></div>')
    const stream = box.querySelector('#cf-stream')
    if (stream) stream.scrollTop = stream.scrollHeight
    const send = box.querySelector('#cf-send')
    if (send) send.onclick = cfSend
    /* 常用语：点一下填入回复框 */
    wireQuickReplies(box, '#cf-reply')
    const input = box.querySelector('#cf-reply')
    if (input) {
      input.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          cfSend()
        }
      }
    }
  }

  async function cfSend() {
    const input = document.getElementById('cf-reply')
    if (!input) return
    const text = input.value.trim()
    if (!text) return
    input.disabled = true
    try {
      await api('msg.reply', { threadId: cfThreadId(), body: text })
      input.value = ''
      const res = await api('msg.list', { threadId: cfThreadId(), limit: 80 })
      CF.msgs = res.items || []
      CF.msgsSig = cfMsgsSig(CF.msgs)
      cfPaintChat()
      /* 重新拉详情：对话发生后底部才会出现「确认满足条件」 */
      try {
        CF.detail = await api('consult.detail', { leadId: CF.leadId })
        cfPaintInfo()
      } catch (err) {
        /* 详情刷新失败不影响已发出的消息 */
      }
    } catch (err) {
      toast(err.message || '发送失败', 'err')
      input.disabled = false
    }
  }

  async function cfClaim() {
    try {
      await api('lead.claim', { leadId: CF.leadId })
      toast('已领取，可以开始联系双方', 'ok')
      /* 领取后工单离开「待领取」分栏，切到全部，避免右侧会话跟着列表一起消失 */
      if (CF.tab === 'unclaimed') CF.tab = 'all'
      await cfReload(true)
    } catch (err) {
      toast(err.message || '领取失败', 'err')
    }
  }

  /* ---------------- 右栏：委托内容 / 联系方式 / 合同 / 服务费 ---------------- */

  function cfAgencyHtml(a, dealAmount) {
    if (!a || !a.id) return '<div class="small" style="color:var(--muted)">委托单未关联或已删除</div>'
    const spec = [a.cat, a.brand, a.series, a.model].filter(Boolean).join(' · ')
    const must = (a.must || []).length
      ? (a.must || []).map(function (m) { return badge(m, 'brand') }).join(' ')
      : '—'
    return kvList([
      ['方向 / 类型', esc(a.kind || (a.side === 'sell' ? '代售' : '代采'))],
      ['设备 / 需求', esc(a.item || '—')],
      ['品类 / 型号', esc(spec || '—')],
      ['数量', a.qty ? num(a.qty) : '—'],
      ['挂牌金额', a.amount ? money(a.amount) : (a.nego ? '现场沟通' : '—')],
      ['成交金额', dealAmount ? money(dealAmount) : '—'],
      ['城市', esc(a.city || '—')],
      ['交易方式', esc(a.tradeMode || '—')],
      ['租期', esc(a.rental || '—')],
      ['期望交付', esc(a.deadline || '—')],
      ['硬性条件', must],
      ['备注', esc(a.note || '—')],
      ['委托状态', badge(a.status || '—', a.status === '已成交' || a.status === '已完成' ? 'ok' : 'warn')]
    ])
  }

  /**
   * 同一委托对接情况：委托方只发一条委托，可能有多人分别咨询。
   * 这里只给序号、所属客服、阶段与是否已锁定，不暴露其他咨询用户的身份。
   */
  function cfThreadsHtml(d) {
    const t = d.agencyThreads
    if (!t) return '<div class="small" style="color:var(--muted)">该工单未关联委托，暂无对接统计</div>'
    const lockText = t.isLockedLead
      ? '<span style="color:var(--brand)">当前工单已确定为唯一对接方</span>'
      : t.lockedLeadId
        ? '本委托已锁定其他对接方，本单已结束对接'
        : '尚未确定唯一对接方'
    return '<div class="small" style="color:var(--muted);line-height:1.8;margin-bottom:8px">' +
      '同一委托共 ' + num(t.total) + ' 条咨询工单：' + num(t.active) + ' 条对接中 · ' + num(t.closed) + ' 条已结束' +
      '<br>' + lockText + '</div>' +
      '<div class="cf-trail">' + (d.peers || []).map(function (p) {
        const state = p.current ? 'now' : (p.stage === 'closed' ? 'off' : 'done')
        const meta = [
          p.locked ? '<span style="color:var(--brand);margin-right:6px">唯一对接</span>' : '',
          esc(p.stageLabel || p.stage || ''),
          p.csName ? '客服 ' + esc(p.csName) : '待领取'
        ].filter(Boolean).join(' · ')
        return '<div class="cf-trail-row ' + state + '"><span class="cf-dot"></span>' +
          '<span>第 ' + num(p.no) + ' 单' + (p.current ? '（当前）' : '') + '</span>' +
          '<span class="small" style="margin-left:auto;color:var(--muted-2)">' + meta + '</span></div>'
      }).join('') + '</div>'
  }

  function cfPartyCard(label, c) {
    if (!c || !c.uid) {
      return '<div class="setting-row"><div class="info"><div class="strong">' + label + '</div>' +
        '<div class="small" style="color:var(--muted)">未关联用户</div></div></div>'
    }
    return '<div class="setting-row"><div class="info">' +
      '<div class="flex" style="align-items:center;gap:8px"><div class="strong">' + label + '</div>' +
      (c.verified ? badge('已实名', 'ok') : badge('未实名', 'warn')) + '</div>' +
      kvList([
        ['用户ID', '<span class="mono">' + esc(c.userNo || '') + '</span>'],
        ['主体', esc(c.subject || '未公开') + (c.subjectType ? ' · ' + esc(c.subjectType) : '')],
        ['联系人', esc(c.name || c.realname || '—')],
        ['联系方式', esc(c.contact || '—')],
        ['手机号', esc(c.phone || '—')],
        ['角色', esc(c.role || label)]
      ]) + '</div></div>'
  }

  function cfPartiesHtml(d) {
    const src = CF.revealed || d.parties || {}
    const masked = !CF.revealed
    return '<div class="small" style="color:var(--muted);margin-bottom:8px">' +
      (masked
        ? '为保护隐私默认只显示掩码；客服沟通前查看明文会记录审计日志。查看入口在底部操作栏。'
        : '已展示明文联系方式，本次查看已记录审计日志。') + '</div>' +
      cfPartyCard('咨询方', src.consult) +
      cfPartyCard('委托方', src.owner)
  }

  function cfContractHtml(d) {
    const c = d.contract
    if (!c) {
      return '<div class="small" style="color:var(--muted);line-height:1.8">' +
        '双方签署的居间合同扫描件上传后在此展示：客服上传 → 管理员审核归档 → 客服登记成交（平台确认后通知委托方付款）。</div>'
    }
    const rows = kvList([
      ['版本', 'v' + (Number(c.version) || 1)],
      ['状态', badge(c.status, c.status === '已归档' ? 'ok' : c.status === '已驳回' ? 'danger' : 'warn')],
      ['签约日期', esc(c.signDate || '—')],
      ['文件', esc(c.fileName || '扫描件') + (c.fileSize ? ' · ' + Math.round(c.fileSize / 1024) + 'KB' : '')],
      ['上传', esc(c.submittedByName || c.submittedBy || '—') + ' · ' + esc(dateText(c.submittedAt))],
      ['审核', c.reviewedAt ? esc(c.reviewedByName || c.reviewedBy) + ' · ' + esc(dateText(c.reviewedAt)) : '待审核'],
      ['审核说明', esc(c.reviewNote || '—')],
      ['备注', esc(c.note || '—')]
    ])
    const canReview = c.status === '待审核' && C.can('contract.review')
    const lockedHere = !!(d.agencyThreads && d.agencyThreads.isLockedLead)
    /* 扫描件与审核按钮统一放在右栏底部固定操作栏 */
    return rows +
      (canReview
        ? '<div class="small" style="color:var(--brand);margin-top:8px">合同待审核：' +
          (lockedHere ? '唯一对接方已确定，通过 / 驳回入口在底部操作栏' : '先在底部「确定唯一对接方」，再审核通过') +
          '</div>'
        : '') +
      (d.contracts && d.contracts.length > 1
        ? '<div class="small" style="color:var(--muted);margin-top:6px">历史版本 ' + (d.contracts.length - 1) + ' 个</div>'
        : '')
  }

  function cfPaymentHtml(d) {
    const p = d.payment
    if (!p) {
      return '<div class="small" style="color:var(--muted);line-height:1.8">' +
        '客服登记成交（平台直接确认）后自动生成服务费账单，支持线下打款 + 上传转账凭证 + 财务确认到账；' +
        '确认到账后按佣金比例自动计提，客服点「确认完成」即结束交易。</div>'
    }
    const rows = kvList([
      ['账单', '<span class="mono">' + esc(p.id) + '</span>'],
      ['金额 / 实收', money(p.amount) + (p.received ? ' / ' + money(p.received) : '')],
      ['状态', badge(p.status || '—', p.status === '已确认' ? 'ok' : p.status === '已退款' ? 'danger' : 'warn')],
      ['付款方式', esc(p.method || '线下打款')],
      ['到账时间', esc(p.confirmedAt ? dateText(p.confirmedAt) : '待财务确认')],
      ['凭证', p.proofFiles.length ? p.proofFiles.length + ' 个 · ' + esc(dateText(p.proofAt)) : '未上传'],
      ['确认人', esc(p.confirmedBy || '—')]
    ])
    /* 凭证查看按钮收到底部操作栏，正文只展示凭证数量 */
    return rows
  }

  function cfHistoryHtml(d) {
    const hist = d.stageHistory || []
    if (!hist.length) return '<div class="small" style="color:var(--muted)">暂无阶段记录</div>'
    return '<div class="cf-trail">' + hist.map(function (h) {
      return '<div class="cf-trail-row done">' +
        '<span class="cf-dot"></span>' +
        '<div style="min-width:0"><div>' + esc(cfStageText(h.stage)) +
        (h.by ? ' · ' + esc(h.by) : '') + '</div>' +
        '<div class="small" style="color:var(--muted)">' + esc(dateText(h.at)) +
        (h.note ? ' · ' + esc(h.note) : '') + '</div></div></div>'
    }).join('') + '</div>'
  }

  /* 阶段操作按钮：按当前工单状态只给出能推进下一步的动作，终止放在最后 */
  function cfActionItems(d) {
    const a = d.actions || {}
    const items = []
    if (a.canTerms) items.push({ k: 'terms', label: '确认满足条件', cls: 'primary' })
    if (a.canContract) items.push({ k: 'contract', label: '上传居间合同', cls: 'primary' })
    if (a.canProposeDeal) items.push({ k: 'deal', label: '确认成交', cls: 'primary' })
    if (a.canUploadProof) items.push({ k: 'proof', label: '上传服务费凭证', cls: 'primary' })
    if (a.canComplete) items.push({ k: 'complete', label: '确认完成', cls: 'primary' })
    if (a.canAbort) items.push({ k: 'abort', label: '终止服务', cls: 'danger' })
    return items
  }

  /* 每个阶段的下一步说明：操作人只看底部也能知道该做什么 */
  function cfNextTip(d) {
    if (d.stage === 'aborted') return '工单已终止，无需继续操作'
    if (d.stage === 'done') return '本单已完成，无待办操作'
    const c = d.contract || {}
    const unclaimed = d.lead && d.lead.csStatus === '待领取'
    const map = {
      communicating: unclaimed
        ? '确认领取工单后即可与用户对话，对话后再确认满足条件'
        : d.chatStarted === false
          ? '先在左侧会话与用户对话沟通；双方聊过之后才会出现「确认满足条件」'
          : '与双方沟通需求，确认数量、价格与交付条件，确认后上传居间合同',
      terms: '上传居间合同扫描件，提交管理员审核',
      contract: c.status === '待审核'
        ? (d.agencyThreads && d.agencyThreads.isLockedLead
          ? '唯一对接方已确定：审核通过后进入成交登记，驳回则退回条件确认'
          : '先在底部「确定唯一对接方」结束同委托的其他对接，再审核通过居间合同')
        : '居间合同审核中，等待管理员处理',
      signed: '合同已归档：核实实际成交后点「确认成交」，平台直接确认并生成服务费账单（委托方只收通知）',
      deal_pending: '升级前旧单：点「确认成交」由平台直接确认，无需再等委托方确认',
      fee: '等委托方在「我的缴费」打款并上传凭证，财务确认到账',
      paid: '点「确认完成」结束交易：工单归档，关联委托同步置为已完成'
    }
    return map[d.stage] || ''
  }

  /* 底部固定操作栏：所有操作与查看入口都在这里，不随正文滚动，也不出现在正文里 */
  function cfPaintFoot(d) {
    const box = document.getElementById('cf-actions')
    if (!box) return
    if (!d) {
      /* 未领取：领取入口同样放在底部操作栏 */
      if (CF.denied && CF.leadId) {
        box.hidden = false
        box.innerHTML = '<div class="cf-foot-tip"><span class="k">待领取</span>' + esc(CF.denied) + '</div>' +
          '<div class="cf-foot-btns"><button class="btn primary" data-cf="claim">领取该工单</button></div>'
        cfBindInfo(box)
        return
      }
      box.hidden = true
      box.innerHTML = ''
      return
    }
    const c = d.contract || {}
    const p = d.payment || {}
    const lead = d.lead || {}
    /* 上架审核工单：底部只给「通过上架 / 驳回 / 转派」，不出现合同与收款动作 */
    if (lead.ticketKind === 'audit') {
      const a = d.agency || {}
      const btns = []
      const utils = []
      if (C.can('agency.review') && a.status === '待审核') {
        btns.push('<button class="btn primary" data-cf="audit-ok">通过并上架</button>')
        btns.push('<button class="btn danger" data-cf="audit-no">驳回</button>')
      }
      if (!lead.assignedAccount) btns.push('<button class="btn primary" data-cf="claim">领取该工单</button>')
      if (C.can('lead.assign')) {
        utils.push('<button class="btn" data-cf="transfer">' + (lead.assignedAccount ? '转派客服' : '分配客服') + '</button>')
      }
      box.hidden = false
      box.innerHTML =
        '<div class="cf-foot-tip"><span class="k">下一步</span>' +
        (a.status === '待审核'
          ? '核对委托内容、主体资质与上传材料：一致即通过，通过后立即上架；有问题点驳回并填写原因'
          : '该委托当前状态为「' + esc(a.status || '—') + '」，无需审核') + '</div>' +
        (btns.length || utils.length
          ? '<div class="cf-foot-btns">' + btns.join('') + '</div>' +
            (utils.length ? '<div class="cf-foot-utils">' + utils.join('') + '</div>' : '')
          : '')
      cfBindInfo(box)
      return
    }
    const ended = d.stage === 'done' || d.stage === 'aborted'
    const canAudit = c.status === '待审核' && C.can('contract.review')
    /* 唯一对接方在「合同已上传、待审核」时手动确定：跟进客服或管理员都可一键结束其他对接；
       未确定前不出现审核通过，避免合同先归档、商机还挂在池子里 */
    const threads = d.agencyThreads || {}
    const lockedHere = !!threads.isLockedLead
    const settled = ['已成交', '已完成', '已关闭'].indexOf(String(threads.agencyStatus || '')) >= 0
    const canLock = c.status === '待审核' && C.can('contract.lock') && !lockedHere && !settled
    const canReview = canAudit && (lockedHere || settled)
    const btns = []
    const utils = []
    if (canLock) {
      btns.push('<button class="btn primary" data-cf="lock">确定唯一对接方' +
        (Number(threads.active) > 1 ? '（结束其他 ' + (Number(threads.active) - 1) + ' 家）' : '') +
        '</button>')
    }
    if (canReview) {
      btns.push('<button class="btn primary" data-cf="review-ok">审核通过</button>')
    }
    if (canAudit) {
      btns.push('<button class="btn danger" data-cf="review-no">驳回</button>')
    }
    if (!lead.assignedAccount) btns.push('<button class="btn primary" data-cf="claim">领取该工单</button>')
    cfActionItems(d).forEach(function (it) {
      if (it.k !== 'abort') btns.push('<button class="btn ' + it.cls + '" data-cf="' + it.k + '">' + esc(it.label) + '</button>')
    })
    /* 查看类入口统一收在底部：合同扫描件、服务费凭证、明文联系方式 */
    if (c.fileId) {
      utils.push('<button class="btn" data-cf-file="' + esc(c.fileId) + '">查看合同扫描件</button>')
    }
    ;(p.proofFiles || []).forEach(function (id, i) {
      utils.push('<button class="btn" data-cf-file="' + esc(id) + '">查看凭证 ' + (i + 1) + '</button>')
    })
    if (!ended) {
      utils.push('<button class="btn" id="cf-reveal">' + (CF.revealed ? '刷新联系方式' : '查看明文联系方式') + '</button>')
    }
    if (p.status === '待确认' && C.can('payment.feeConfirm')) {
      btns.push('<button class="btn primary" data-cf="fee-confirm">确认服务费到账</button>')
    }
    /* 转单：未指派时是「分配客服」，已有负责人时是「转派客服」，客服与管理员都可用 */
    if (!ended && C.can('lead.assign')) {
      utils.push('<button class="btn" data-cf="transfer">' + (lead.assignedAccount ? '转派客服' : '分配客服') + '</button>')
    }
    const abort = cfActionItems(d).filter(function (it) { return it.k === 'abort' })[0]
    if (abort) utils.push('<button class="btn danger" data-cf="abort">' + esc(abort.label) + '</button>')
    const tip = cfNextTip(d)
    box.hidden = false
    box.innerHTML =
      (tip ? '<div class="cf-foot-tip"><span class="k">下一步</span>' + esc(tip) + '</div>' : '') +
      (btns.length || utils.length
        ? '<div class="cf-foot-btns">' + btns.join('') + '</div>' +
          (utils.length ? '<div class="cf-foot-utils">' + utils.join('') + '</div>' : '')
        : '<div class="cf-foot-tip" style="margin:0;color:var(--muted)">当前阶段没有待办操作</div>')
    cfBindInfo(box)
  }

  function cfPaintInfo() {
    const box = document.getElementById('cf-info')
    if (!box) return
    if (!CF.detail) {
      box.innerHTML = '<div class="small" style="color:var(--muted);line-height:1.9">' +
        '<div class="strong" style="color:var(--ink);margin-bottom:6px">领取后可见</div>' +
        '根据平台规则，未领取的咨询不展示委托内容、成交金额与双方联系方式。</div>'
      cfPaintFoot(null)
      return
    }
    const d = CF.detail
    const lead = d.lead || {}
    const a = d.agency || {}
    /* 上架审核工单：只核对委托内容与资质材料，不展示合同 / 收款 / 对接情况 */
    if (lead.ticketKind === 'audit') {
      const audit = d.audit || {}
      const subjectRows = kvList([
        ['主体名称', esc(a.subjectMasked || '未登记') + (a.subjectType ? ' · ' + esc(a.subjectType) : '')],
        ['证照 / 信用代码', esc(a.creditMasked || '未登记')],
        ['法定代表人', esc(a.legalMasked || '未登记')],
        ['联系人手机号', esc(a.phoneMasked || '未登记')],
        ['材料核验', a.status === '已上架' ? badge('已核验', 'ok') : badge('待核对', 'warn')]
      ])
      box.innerHTML =
        '<div class="flex flex-wrap" style="align-items:center;gap:6px">' +
        badge(lead.sideLabel || a.kind || '代采', 'brand') +
        badge('上架审核中', 'warn') +
        (lead.largeAmount ? badge('大额', 'warn') : '') +
        '</div>' +
        '<div class="strong" style="font-size:14px;line-height:1.5;margin:6px 0 2px">' +
        esc(lead.targetTitle || a.item || '委托审核') + '</div>' +
        '<div class="small" style="color:var(--muted)">工单 ' + esc(CF.leadId) +
        (lead.csName ? ' · 客服 ' + esc(lead.csName) : '') +
        ' · 提交 ' + esc(dateText(audit.submittedAt || lead.createdAt)) + '</div>' +
        '<div class="cf-info-sec"><h4>审核说明</h4>' +
        '<div class="small" style="color:var(--muted);line-height:1.8">' +
        '用户发布 / 修改委托后自动生成此工单。核对下方委托内容、主体资质与上传材料：' +
        '一致即「通过并上架」，委托立即生效；有问题点「驳回」并填写原因，用户会收到站内信，可修改后重新提交。' +
        (audit.result
          ? '<br>最近结论：' + esc(audit.result) + (audit.note ? ' · ' + esc(audit.note) : '')
          : '') + '</div></div>' +
        '<div class="cf-info-sec"><h4>委托内容</h4>' + cfAgencyHtml(a, 0) + '</div>' +
        '<div class="cf-info-sec"><h4>委托人主体</h4>' + subjectRows + '</div>' +
        '<div class="cf-info-sec"><h4>上传材料</h4>' +
        (a.id
          ? '<div class="small" style="color:var(--muted-2);margin-bottom:8px">点击图片可放大</div>' +
            '<div class="rev-media" id="o-media-agency">' + loadingBlock('加载原件') + '</div>'
          : '<div class="small" style="color:var(--muted)">委托单未关联或已删除</div>') +
        '</div>' +
        '<div class="cf-info-sec"><h4>阶段记录</h4>' + cfHistoryHtml(d) + '</div>'
      cfBindInfo(box)
      if (a.id) loadMediaPanel(box, a, 'agency')
      cfPaintFoot(d)
      return
    }
    const head =
      '<div class="flex flex-wrap" style="align-items:center;gap:6px">' +
      badge(lead.sideLabel || a.kind || '代采', 'brand') +
      badge(d.stageLabel || cfStageText(d.stage), cfTone(d.stage)) +
      (lead.largeAmount ? badge('大额', 'warn') : '') +
      '</div>' +
      '<div class="strong" style="font-size:14px;line-height:1.5;margin:6px 0 2px">' +
      esc(lead.targetTitle || a.item || '代采代售咨询') + '</div>' +
      '<div class="small" style="color:var(--muted)">工单 ' + esc(CF.leadId) +
      (lead.csName ? ' · 客服 ' + esc(lead.csName) : '') + '</div>'
    box.innerHTML = head +
      '<div class="cf-info-sec"><h4>标准流程进度' +
      (d.stage === 'aborted' ? '' : ' · 第 ' + (cfStepIndex(d.stage) + 1) + '/' + CF_STAGES.length + ' 步') +
      '</h4>' + cfTrail(d.stage, d.stage === 'aborted', d.stageHistory) + '</div>' +
      '<div class="cf-info-sec"><h4>委托内容</h4>' + cfAgencyHtml(a, Number(d.dealAmount) || 0) + '</div>' +
      '<div class="cf-info-sec"><h4>同一委托对接情况</h4>' + cfThreadsHtml(d) + '</div>' +
      '<div class="cf-info-sec"><h4>双方联系方式</h4>' + cfPartiesHtml(d) + '</div>' +
      '<div class="cf-info-sec"><h4>居间合同</h4>' + cfContractHtml(d) + '</div>' +
      '<div class="cf-info-sec"><h4>服务费</h4>' + cfPaymentHtml(d) + '</div>' +
      (d.abortReason
        ? '<div class="cf-info-sec"><h4>终止原因</h4><div class="small" style="color:var(--danger)">' + esc(d.abortReason) + '</div></div>'
        : '') +
      '<div class="cf-info-sec"><h4>阶段记录</h4>' + cfHistoryHtml(d) + '</div>'
    cfBindInfo(box)
    /* 审核与阶段推进按钮固定在右栏底部，正文滚动不影响操作 */
    cfPaintFoot(d)
  }

  function cfBindInfo(box) {
    box.querySelectorAll('[data-cf]').forEach(function (btn) {
      const act = btn.getAttribute('data-cf')
      btn.onclick = function () {
        if (act === 'terms') cfTermsModal()
        else if (act === 'contract') cfContractModal()
        else if (act === 'deal') cfDealModal()
        else if (act === 'proof') cfProofModal()
        else if (act === 'complete') cfComplete()
        else if (act === 'abort') cfAbortModal()
        else if (act === 'review-ok') cfReview('approve')
        else if (act === 'review-no') cfReview('reject')
        else if (act === 'audit-ok') cfAgencyAudit('approve')
        else if (act === 'audit-no') cfAgencyAudit('reject')
        else if (act === 'lock') cfLockAgency()
        else if (act === 'claim') cfClaim()
        else if (act === 'transfer') cfTransferModal()
        else if (act === 'fee-confirm') cfFeeConfirm()
      }
    })
    box.querySelectorAll('[data-cf-file]').forEach(function (btn) {
      btn.onclick = function () { cfOpenFile(btn.getAttribute('data-cf-file')) }
    })
    const reveal = box.querySelector('#cf-reveal')
    if (reveal) reveal.onclick = cfReveal
  }

  async function cfOpenFile(fileId) {
    if (!fileId) return
    try {
      const res = await api('consult.fileUrls', { leadId: CF.leadId })
      const url = (res.urls || {})[fileId]
      if (!url) return toast('文件链接获取失败，请稍后重试', 'err')
      window.open(url, '_blank')
    } catch (err) {
      toast(err.message || '文件链接获取失败', 'err')
    }
  }

  async function cfReveal() {
    const ok = await confirm({
      title: '查看双方联系方式',
      message: '查看明文手机号 / 微信会记录到审计日志（操作人、时间、工单）。确认查看？',
      okText: '确认查看'
    })
    if (!ok) return
    try {
      const res = await api('consult.reveal', { leadId: CF.leadId, reason: '客服沟通需要' })
      CF.revealed = res.parties || null
      cfPaintInfo()
      toast('已展示明文联系方式', 'ok')
    } catch (err) {
      toast(err.message || '查看失败', 'err')
    }
  }

  async function cfAfterAction(message) {
    closeModal()
    toast(message, 'ok')
    await cfReload(true)
  }

  /* ---------------- 各阶段操作弹窗 ---------------- */

  function cfTermsModal() {
    const d = CF.detail
    const a = d.agency || {}
    const t = d.terms || {}
    const amount = Number(t.amount) || Number(d.dealAmount) || Number(a.amount) || 0
    const root = modal({
      title: '确认满足条件',
      sub: '对话确认满足条件后进入居间合同环节，成交金额作为服务费与佣金计提口径',
      wide: true,
      body: '<div class="form-grid">' +
        field('成交金额（元）', '<input id="cf-t-amount" type="number" min="0" step="0.01" value="' + (amount || '') + '">') +
        field('交付方式', '<input id="cf-t-delivery" maxlength="100" value="' + esc(t.delivery || '') + '" placeholder="例如：现场验机后自提 / 物流发货">') +
        field('付款方式', '<input id="cf-t-payment" maxlength="100" value="' + esc(t.payment || '') + '" placeholder="例如：签约后 3 个工作日内对公转账">') +
        '<div class="field full"><label>确认条件</label><textarea id="cf-t-condition" rows="3" maxlength="500" placeholder="双方确认满足的条件，例如设备成色、验收标准、交付时间">' + esc(t.condition || '') + '</textarea></div>' +
        '<div class="field full"><label>备注</label><textarea id="cf-t-remark" rows="2" maxlength="500">' + esc(t.remark || '') + '</textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="cf-t-ok">确认满足条件</button>'
    })
    if (!root) return
    root.querySelector('#cf-t-ok').onclick = async function () {
      const value = Number(root.querySelector('#cf-t-amount').value)
      if (!(value > 0)) return toast('请填写正确的成交金额', 'err')
      this.disabled = true
      try {
        await api('consult.terms', {
          leadId: CF.leadId,
          amount: value,
          delivery: root.querySelector('#cf-t-delivery').value.trim(),
          payment: root.querySelector('#cf-t-payment').value.trim(),
          condition: root.querySelector('#cf-t-condition').value.trim(),
          remark: root.querySelector('#cf-t-remark').value.trim()
        })
        await cfAfterAction('条件已确认，请上传居间合同')
      } catch (err) {
        toast(err.message || '提交失败', 'err')
        this.disabled = false
      }
    }
  }

  function cfContractModal() {
    const root = modal({
      title: '上传居间合同',
      sub: '纯线下签署：上传双方签章的扫描件，由管理员审核归档',
      wide: true,
      body: '<div class="form-grid">' +
        '<div class="field full"><label>合同扫描件（PDF / 图片，≤20MB）</label>' +
        '<input id="cf-c-file" type="file" accept="application/pdf,image/*"></div>' +
        field('签约日期', '<input id="cf-c-date" type="date" value="' + dayText(Date.now()) + '">') +
        '<div class="field full"><label>备注</label><textarea id="cf-c-note" rows="2" maxlength="500" placeholder="例如：双方已盖章，原件由委托方留存"></textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="cf-c-ok">上传并提交审核</button>'
    })
    if (!root) return
    root.querySelector('#cf-c-ok').onclick = async function () {
      const input = root.querySelector('#cf-c-file')
      const file = input && input.files && input.files[0]
      if (!file) return toast('请选择双方签章的合同扫描件', 'err')
      const signDate = root.querySelector('#cf-c-date').value
      if (!/^\d{4}-\d{2}-\d{2}$/.test(signDate)) return toast('请填写签约日期', 'err')
      this.disabled = true
      this.textContent = '上传中…'
      try {
        const up = await docUpload(file)
        await api('consult.contractSubmit', {
          leadId: CF.leadId,
          fileId: up.fileId,
          fileName: up.name,
          fileSize: up.size,
          signDate: signDate,
          note: root.querySelector('#cf-c-note').value.trim()
        })
        await cfAfterAction('合同已提交，等待管理员审核')
      } catch (err) {
        toast(err.message || '上传失败', 'err')
        this.disabled = false
        this.textContent = '上传并提交审核'
      }
    }
  }

  function cfDealModal() {
    const d = CF.detail
    const a = d.agency || {}
    const amount = Number(d.dealAmount) || Number(a.amount) || 0
    const root = modal({
      title: '确认成交',
      sub: '平台直接确认成交：按成交金额生成服务费账单并通知委托方付款，无需委托方再确认',
      body: '<div class="form-grid">' +
        field('成交金额（元）', '<input id="cf-d-amount" type="number" min="0" step="0.01" value="' + (amount || '') + '">') +
        '<div class="field full"><label>说明</label><textarea id="cf-d-note" rows="3" maxlength="300" placeholder="成交说明（会展示在工单记录里）"></textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="cf-d-ok">确认成交</button>'
    })
    if (!root) return
    root.querySelector('#cf-d-ok').onclick = async function () {
      const value = Number(root.querySelector('#cf-d-amount').value)
      if (!(value > 0)) return toast('请填写成交金额', 'err')
      this.disabled = true
      try {
        await api('consult.proposeDeal', {
          leadId: CF.leadId,
          amount: value,
          note: root.querySelector('#cf-d-note').value.trim()
        })
        await cfAfterAction('已确认成交，服务费账单已生成并通知委托方')
      } catch (err) {
        toast(err.message || '发起失败', 'err')
        this.disabled = false
      }
    }
  }

  function cfProofModal() {
    const p = CF.detail.payment || {}
    const left = Math.max(0, 5 - (p.proofFiles || []).length)
    const root = modal({
      title: '上传服务费凭证',
      sub: left ? '线下打款后上传转账凭证，财务确认到账后自动计提佣金（最多 5 个，还可传 ' + left + ' 个）'
        : '凭证已达 5 个上限，如需替换请联系管理员',
      wide: true,
      body: '<div class="form-grid">' +
        '<div class="field full"><label>转账凭证（图片 / PDF，支持多选）</label>' +
        '<input id="cf-p-file" type="file" accept="application/pdf,image/*" multiple' + (left ? '' : ' disabled') + '></div>' +
        '<div class="field full"><label>备注</label><textarea id="cf-p-note" rows="2" maxlength="200" placeholder="例如：对公转账回单，户名与合同一致"></textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button>' +
        (left ? '<button class="btn primary" id="cf-p-ok">上传凭证</button>' : '')
    })
    if (!root) return
    const ok = root.querySelector('#cf-p-ok')
    if (!ok) return
    ok.onclick = async function () {
      const input = root.querySelector('#cf-p-file')
      const files = input && input.files ? Array.prototype.slice.call(input.files) : []
      if (!files.length) return toast('请选择转账凭证', 'err')
      if (files.length > left) return toast('最多还能上传 ' + left + ' 个凭证', 'err')
      this.disabled = true
      this.textContent = '上传中…'
      try {
        const ids = []
        let lastName = ''
        for (const file of files) {
          const up = await docUpload(file)
          ids.push(up.fileId)
          lastName = up.name
        }
        await api('consult.uploadProof', {
          leadId: CF.leadId,
          files: ids,
          fileName: lastName,
          note: root.querySelector('#cf-p-note').value.trim()
        })
        await cfAfterAction('凭证已上传，等待财务确认到账')
      } catch (err) {
        toast(err.message || '上传失败', 'err')
        this.disabled = false
        this.textContent = '上传凭证'
      }
    }
  }

  async function cfComplete() {
    const ok = await confirm({
      title: '确认完成',
      message: '服务费已确认到账后才会允许完成；完成后工单归档、关联委托同步置为「已完成」，佣金计入客服工资。确认完成该咨询？',
      okText: '确认完成'
    })
    if (!ok) return
    try {
      await api('consult.complete', { leadId: CF.leadId })
      toast('咨询已完成', 'ok')
      await cfReload(true)
    } catch (err) {
      toast(err.message || '操作失败', 'err')
    }
  }

  function cfAbortModal() {
    const root = modal({
      title: '终止服务',
      sub: '客户不付款或条件谈不拢时结束流程，该单不计佣金',
      body: '<div class="form-grid">' +
        '<div class="field full"><label>终止原因</label><textarea id="cf-a-reason" rows="3" maxlength="300" placeholder="例如：双方价格未谈拢，客户放弃成交"></textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="cf-a-ok">确认终止</button>'
    })
    if (!root) return
    root.querySelector('#cf-a-ok').onclick = async function () {
      const reason = root.querySelector('#cf-a-reason').value.trim()
      if (!reason) return toast('请填写终止原因', 'err')
      this.disabled = true
      try {
        await api('consult.abort', { leadId: CF.leadId, reason: reason })
        await cfAfterAction('已终止服务')
      } catch (err) {
        toast(err.message || '操作失败', 'err')
        this.disabled = false
      }
    }
  }

  /**
   * 确定唯一对接方：居间合同上传后、审核前手动执行。
   * 委托立即退出商机池，同委托其他对接工单结束（待审核合同作废），
   * 并自动给这些用户发「商品已售出」消息。
   */
  async function cfLockAgency() {
    const d = CF.detail || {}
    const t = d.agencyThreads || {}
    const others = Math.max(0, (Number(t.active) || 1) - 1)
    const ok = await confirm({
      title: '确定唯一对接方',
      message: '确定后该委托立即退出商机池' +
        (others ? '，同一委托其他 ' + others + ' 条对接工单将结束（其待审核合同作废）' : '') +
        '，并自动给对方发送「商品已售出」消息。确认以当前工单为唯一对接方？',
      okText: '确定并结束其他对接'
    })
    if (!ok) return
    try {
      const res = await api('contract.lock', { leadId: CF.leadId })
      const closed = Number(res && res.closedOthers) || 0
      toast(closed
        ? '已确定唯一对接方，结束其他 ' + closed + ' 家对接并通知已售出'
        : '已确定唯一对接方，委托已退出商机池', 'ok')
      await cfReload(true)
    } catch (err) {
      toast(err.message || '操作失败', 'err')
    }
  }

  async function cfReview(decision) {
    if (decision === 'approve') {
      const ok = await confirm({
        title: '审核通过',
        message: '通过后合同归档；随后由客服核实成交金额并点「确认成交」，平台直接确认并通知委托方支付服务费。',
        okText: '通过并归档'
      })
      if (!ok) return
      try {
        await api('contract.review', { leadId: CF.leadId, decision: 'approve' })
        toast('合同已归档', 'ok')
        await cfReload(true)
      } catch (err) {
        toast(err.message || '审核失败', 'err')
      }
      return
    }
    const root = modal({
      title: '驳回合同',
      sub: '驳回后退回「条件已确认」，客服可重新上传扫描件',
      body: '<div class="form-grid"><div class="field full"><label>驳回原因</label>' +
        '<textarea id="cf-r-note" rows="3" maxlength="200" placeholder="例如：缺少委托方骑缝章，请重新上传"></textarea></div></div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="cf-r-ok">确认驳回</button>'
    })
    if (!root) return
    root.querySelector('#cf-r-ok').onclick = async function () {
      const note = root.querySelector('#cf-r-note').value.trim()
      if (!note) return toast('请填写驳回原因', 'err')
      this.disabled = true
      try {
        await api('contract.review', { leadId: CF.leadId, decision: 'reject', note: note })
        await cfAfterAction('合同已驳回')
      } catch (err) {
        toast(err.message || '审核失败', 'err')
        this.disabled = false
      }
    }
  }

  /**
   * 上架审核：在工作台的审核工单里直接审核委托。
   * 通过后委托立即上架、工单自动收尾；驳回必须写原因，用户会收到站内信。
   */
  async function cfAgencyAudit(decision) {
    const d = CF.detail || {}
    const a = d.agency || {}
    if (!a.id) return toast('该工单未关联委托，无法审核', 'err')
    if (decision === 'approve') {
      const ok = await confirm({
        title: '通过并上架',
        message: '通过后委托立即上架（修改中的委托会用新内容覆盖并重新上架），审核工单自动收尾。确认通过？',
        okText: '通过并上架'
      })
      if (!ok) return
      try {
        await api('agency.review', { id: a.id, decision: '通过' })
        await cfAfterAction('已通过审核，委托已上架')
      } catch (err) {
        toast(err.message || '审核失败', 'err')
      }
      return
    }
    const root = modal({
      title: '驳回委托',
      sub: '驳回后用户会收到站内信，可按意见修改后重新提交；修改中的委托将恢复原上架内容',
      body: '<div class="form-grid"><div class="field full"><label>驳回原因</label>' +
        '<textarea id="cf-au-note" rows="3" maxlength="100" placeholder="例如：委托材料与填写型号不一致，请重新上传"></textarea></div></div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn danger" id="cf-au-ok">确认驳回</button>'
    })
    if (!root) return
    root.querySelector('#cf-au-ok').onclick = async function () {
      const note = root.querySelector('#cf-au-note').value.trim()
      if (!note) return toast('请填写驳回原因', 'err')
      this.disabled = true
      try {
        await api('agency.review', { id: a.id, decision: '驳回', note: note })
        await cfAfterAction('已驳回委托，审核工单已收尾')
      } catch (err) {
        toast(err.message || '审核失败', 'err')
        this.disabled = false
      }
    }
  }

  /* 转派：工单处理中可把负责人换成其他客服，交接后新客服继续推进整条链路 */
  async function cfTransferModal() {
    const d = CF.detail || {}
    const lead = d.lead || {}
    if (!CF.staff.length) {
      try {
        const res = await api('staff.list', {})
        CF.staff = res.items || []
      } catch (err) {
        toast(err.message || '客服列表加载失败', 'err')
        return
      }
    }
    const options = CF.staff
      .filter(function (s) { return s.name !== lead.assignedTo })
      .map(function (s) {
        return '<option value="' + esc(s.username) + '">' + esc(s.name + ' · ' + (s.roleName || '')) + '</option>'
      }).join('')
    if (!options) return toast('暂无可转派的客服', 'err')
    const root = modal({
      title: '转派工单',
      sub: '当前负责人：' + (lead.assignedTo || '未指派') + '；交接后新客服继续处理整条链路',
      body: '<div class="form-grid">' +
        field('转派给', '<select id="cf-x-staff">' + options + '</select>') +
        '<div class="field full"><label>交接说明</label><textarea id="cf-x-note" rows="3" maxlength="200" placeholder="例如：客户已确认条件，请继续上传合同"></textarea></div>' +
        '</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" id="cf-x-ok">确认转派</button>'
    })
    if (!root) return
    root.querySelector('#cf-x-ok').onclick = async function () {
      this.disabled = true
      try {
        await api('lead.assign', {
          leadId: CF.leadId,
          assignee: root.querySelector('#cf-x-staff').value,
          reason: root.querySelector('#cf-x-note').value.trim()
        })
        closeModal()
        toast('已转派', 'ok')
        await cfReload(true)
      } catch (err) {
        toast(err.message || '转派失败', 'err')
        this.disabled = false
      }
    }
  }

  /* 服务费到账确认：工单中心直接闭环，不必再切到财务中心 */
  async function cfFeeConfirm() {
    const p = (CF.detail && CF.detail.payment) || {}
    if (!p.id) return toast('未找到服务费账单', 'err')
    const ok = await confirm({
      title: '确认服务费到账',
      message: '确认后完成收款并自动计提客服佣金，工单同步推进到「服务费已到账」。',
      okText: '确认到账'
    })
    if (!ok) return
    try {
      await api('payment.feeConfirm', { id: p.id })
      toast('服务费已确认到账', 'ok')
      await cfReload(true)
    } catch (err) {
      toast(err.message || '确认失败', 'err')
    }
  }

  Pages.consult = async function (view) {
    /* 从工作台待审核弹窗 / 消息中心带过来的定位参数：直接落到对应分栏或工单 */
    const jumpLead = (state.pageQuery && state.pageQuery.leadId) || ''
    const jumpTab = (state.pageQuery && state.pageQuery.tab) || ''
    if (jumpLead || jumpTab) state.pageQuery = null
    CF.tab = CF_TABS.some(function (t) { return t[0] === jumpTab }) ? jumpTab : 'all'
    CF.q = ''
    CF.leadId = jumpLead
    CF.jumpLead = jumpLead
    /* 固定一屏：指标 / 分栏 / 查询固定在顶部，只有三栏内容各自滚动，底部操作栏始终可见 */
    view.classList.add('view-fill', 'cf-fill')
    view.innerHTML = '<div class="cf-page">' + pageHead('工单中心',
      '用户从代采 / 代售发来的咨询会直接生成工单：待领取 → 领取对话 → 条件确认 → 合同审核 → 成交确认 → 服务费到账 → 完成；不合适可直接终止服务。',
      '<button class="btn" id="cf-refresh">' + icon('refresh') + '<span>刷新</span></button>') +
      '<div id="cf-kpi"></div>' +
      '<div class="tabs" id="cf-tabs"></div>' +
      filterBar([
        '<div class="field" style="min-width:240px"><label>关键词</label>' +
        '<input id="cf-q" placeholder="委托标题 / 需求内容"></div>',
        '<div class="field" style="justify-content:flex-end">' +
        '<button class="btn primary" id="cf-search">' + icon('search') + '<span>查询</span></button></div>'
      ]) +
      '<div id="cf-body">' + loadingBlock('读取工单') + '</div>' +
      '</div>'
    view.querySelector('#cf-refresh').onclick = function () { cfReload(true) }
    view.querySelector('#cf-search').onclick = function () {
      CF.q = view.querySelector('#cf-q').value.trim()
      cfReload(false)
    }
    view.querySelector('#cf-q').onkeydown = function (e) {
      if (e.key === 'Enter') view.querySelector('#cf-search').click()
    }
    await cfReload(false)
    cfStartPoll()
  }

  /* ============================================================
     客服业务：绑定用户、委托佣金、服务评价档案
     —— 佣金口径：客服只有推广二级佣金（推广中心计提）与委托佣金（代采/代售服务费到账后按比例计提）
     ============================================================ */
  const CS_VIEW = {
    staff: [],
    settings: { agencyRate: 0.2, idleMinutes: 30 },
    tags: [],
    tab: 'rate',
    dailyCs: '',
    dailyDays: 7,
    daily: null
  }

  const CS_TABS = [
    ['rate', '佣金配置'],
    ['daily', '每日工作量'],
    ['bind', '客服与绑定']
  ]

  function csPct(value) {
    const n = Number(value) || 0
    return (Math.round(n * 1000) / 10).toFixed(1) + '%'
  }

  function csStars(score) {
    const n = Math.round(Number(score) || 0)
    if (!n) return '<span class="small" style="color:var(--muted-2)">暂无评价</span>'
    return '<span style="color:#f59e0b;letter-spacing:1px">' + '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) + '</span>' +
      ' <span class="small strong">' + n + '.0</span>'
  }

  function csBindingCell(binding) {
    if (!binding || !binding.uid) return badge('未绑定', 'warn', true)
    return '<div class="mono small strong">' + esc(binding.nick || binding.uid) + '</div>' +
      '<div class="small mono" style="color:var(--muted-2)">' + esc(binding.uid) + '</div>' +
      (binding.boundAt ? '<div class="small" style="color:var(--muted-2)">' + dayText(binding.boundAt) + ' 绑定</div>' : '')
  }

  /* 规则块：大号比例一眼看清，可编辑时直接在同一位置改 */
  function csRuleBlock(title, hint, inputId, value, canEdit) {
    const pctText = (Math.round((Number(value) || 0) * 1000) / 10).toFixed(1)
    return '<div style="border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--bg-2,transparent)">' +
      '<div class="strong">' + esc(title) + '</div>' +
      '<div class="flex" style="align-items:baseline;gap:6px;margin:8px 0 4px">' +
        (canEdit
          ? '<input id="' + inputId + '" type="number" min="0" max="50" step="0.1" value="' + pctText + '" ' +
            'style="width:110px;font-size:28px;font-weight:700;line-height:1.2;padding:2px 8px">'
          : '<span style="font-size:32px;font-weight:700;line-height:1.2">' + csPct(value) + '</span>') +
        (canEdit ? '<span style="font-size:22px;font-weight:700">%</span>' : '') +
      '</div>' +
      '<div class="small" style="color:var(--muted-2)">' + esc(hint) + '</div>' +
      '</div>'
  }

  /* 锁定比例单元格：已绑定展示绑定时刻快照，未绑定展示当前默认并提示绑定时锁定 */
  function csLockCell(row) {
    const bound = !!(row.binding && row.binding.uid)
    const locked = Number(row.lockedAgencyRate) || 0
    const current = Number(row.agencyRate) || 0
    const changed = Math.abs(locked - current) > 0.0001
    if (!bound) {
      return '<div class="mono strong" style="color:var(--muted-2)">' + csPct(current) + '</div>' +
        '<div class="small" style="color:var(--muted-2)">待绑定 · 当前默认</div>'
    }
    return '<div class="mono strong">' + csPct(locked) + '</div>' +
      '<div>' + badge('绑定锁定', 'ok', true) + '</div>' +
      '<div class="small" style="color:var(--muted-2)">' +
        (changed ? '新绑定将按 ' + csPct(current) : '代采代售佣金') +
      '</div>'
  }

  Pages.cs = async function (view) {
    view.innerHTML = pageHead('客服业务',
      '客服佣金只有两项：委托佣金（代采代售服务费到账后按比例计提，进工资）与推广二级佣金（推广中心计提）；客服绑定用户由管理员在此设置，客服无权限修改',
      '<button class="btn" id="cs-refresh">' + icon('refresh') + '<span>刷新</span></button>') +
      '<div id="cs-stats"></div>' +
      '<div class="tabs" id="cs-tabs" style="margin-top:14px">' + CS_TABS.map(function (t) {
        return '<button data-cs-tab="' + t[0] + '"' + (CS_VIEW.tab === t[0] ? ' class="on"' : '') + '>' + esc(t[1]) + '</button>'
      }).join('') + '</div>' +
      '<div id="cs-body" style="margin-top:14px">' + loadingBlock('读取客服数据') + '</div>'
    view.querySelector('#cs-refresh').onclick = function () { Pages.cs(view) }
    view.querySelectorAll('[data-cs-tab]').forEach(function (btn) {
      btn.onclick = function () {
        const tab = btn.getAttribute('data-cs-tab')
        if (CS_VIEW.tab === tab) return
        CS_VIEW.tab = tab
        view.querySelectorAll('[data-cs-tab]').forEach(function (b) { b.classList.toggle('on', b === btn) })
        renderCsBody(view.querySelector('#cs-body'), view)
      }
    })
    let data = {}
    try {
      data = (await api('cs.settings', {})) || {}
    } catch (err) {
      view.querySelector('#cs-stats').innerHTML = ''
      view.querySelector('#cs-body').innerHTML = card('客服业务',
        '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>')
      return
    }
    CS_VIEW.settings = data.settings || CS_VIEW.settings
    CS_VIEW.staff = data.items || []
    CS_VIEW.tags = data.ratingTags || []
    renderCsStats(view.querySelector('#cs-stats'))
    renderCsBody(view.querySelector('#cs-body'), view)
  }

  function renderCsStats(root) {
    const staff = CS_VIEW.staff
    const sum = function (key) {
      return staff.reduce(function (acc, row) { return acc + (Number(row.stats && row.stats[key]) || 0) }, 0)
    }
    let rated = 0
    let ratingTotal = 0
    staff.forEach(function (row) {
      const s = row.stats || {}
      if (Number(s.ratingCount) > 0) { rated += 1; ratingTotal += Number(s.ratingAvg) || 0 }
    })
    root.innerHTML = kpiRow([
      ['客服坐席', num(staff.length), '<span class="small" style="color:var(--muted-2)">含管理员</span>'],
      ['已绑定用户', num(staff.filter(function (r) { return r.binding && r.binding.uid }).length), '<span class="small" style="color:var(--muted-2)">一对一绑定</span>'],
      ['本月委托业绩', money(sum('monthAgencyFee')), '<span class="small" style="color:var(--muted-2)">委托服务费实收</span>'],
      ['本月委托佣金', money(sum('monthCommission')), '<span class="small" style="color:var(--muted-2)">按委托比例计提</span>'],
      ['平均评分', rated ? (ratingTotal / rated).toFixed(1) + ' 星' : '—', '<span class="small" style="color:var(--muted-2)">' + num(sum('ratingCount')) + ' 条评价</span>']
    ])
  }

  function renderCsBody(root, view) {
    if (CS_VIEW.tab === 'daily') return renderCsDaily(root, view)
    if (CS_VIEW.tab === 'bind') return renderCsBind(root, view)
    return renderCsRate(root, view)
  }

  /* 佣金配置：全局委托比例 + 单客服默认比例（均仅管理员可改） */
  function renderCsRate(root, view) {
    const canEdit = C.can('cs.saveSettings')
    const globalAgencyRate = Number(CS_VIEW.settings.agencyRate) || 0
    const globalIdle = Number(CS_VIEW.settings.idleMinutes) || 30
    const agencyExample = Math.round(5000 * globalAgencyRate * 100) / 100
    const rule = card('客服委托佣金规则（绑定即锁定）',
      '<div class="grid g2" style="gap:14px">' +
        csRuleBlock('全局委托佣金比例', '代采 / 代售委托服务费实收 × 此比例', 'cs-agency-rate', globalAgencyRate, canEdit) +
        '<div style="border:1px solid var(--line);border-radius:12px;padding:16px">' +
          '<div class="strong">客服佣金构成</div>' +
          '<div class="small" style="color:var(--muted-2);line-height:1.9;margin-top:8px">' +
            '① 委托佣金：代采 / 代售服务费到账后按本页比例计提，计入客服工资；<br>' +
            '② 推广二级佣金：仅客服绑定用户在推广中心计提，不重复计入工资。<br>' +
            '平台不设「客服会员提成」，会员付款不产生客服佣金。' +
          '</div>' +
        '</div>' +
      '</div>' +
      (canEdit
        ? '<div class="flex flex-wrap" style="gap:10px;align-items:flex-end;margin-top:14px">' +
            '<div class="field" style="min-width:210px"><label>超时未回复自动结束（分钟）</label>' +
            '<input id="cs-idle" type="number" min="5" max="240" step="1" value="' + globalIdle + '"></div>' +
            '<button class="btn primary" id="cs-rule-save">' + icon('check') + '<span>保存佣金规则</span></button>' +
          '</div>'
        : '<div class="small" style="margin-top:12px;color:var(--muted-2)">超时自动结束：' + num(globalIdle) + ' 分钟 · 佣金比例仅管理员可修改</div>') +
      '<div class="grid g2" style="margin-top:14px">' +
        kpi('示例：委托服务费 ¥5,000', money(agencyExample), '委托佣金 × ' + csPct(globalAgencyRate)) +
        kpi('单客服专属比例', num(CS_VIEW.staff.filter(function (r) { return r.agencyRateSource === 'staff' }).length) + ' 人已单独设置', '未设置时按全局默认') +
      '</div>' +
      '<div class="small" style="color:var(--muted-2);margin-top:12px;line-height:1.9">' +
        '<strong>绑定即锁定：</strong>保存后新比例只对之后新绑定的账号生效，已绑定账号按下表「锁定比例」计提，后续调价不追溯、不改动。' +
        '委托服务费到账后系统自动计提并计入客服当月工资；退款冲正自动扣回，同一笔收款只计提一次。' +
      '</div>')

    const rows = CS_VIEW.staff.map(function (row) {
      const ops = []
      if (C.can('cs.saveAgencyRate')) {
        ops.push('<button class="btn xs" data-cs-agency-rate="' + esc(row.username) + '">设置默认比例</button>')
      }
      return '<td><div class="strong">' + esc(row.name || row.username) + '</div>' +
        '<div class="small mono" style="color:var(--muted-2)">' + esc(row.username) + ' · ' + esc(row.roleName || '') + '</div></td>' +
        '<td class="mono">' + csPct(row.agencyRate) +
          '<div class="small" style="color:var(--muted-2)">' + (row.agencyRateSource === 'staff' ? '专属设置' : '沿用全局默认') + '</div></td>' +
        '<td>' + csLockCell(row) + '</td>' +
        '<td>' + (canEdit || ops.length ? '<div class="flex" style="gap:5px;flex-wrap:wrap">' + (ops.join('') || '<span class="small" style="color:var(--muted-2)">只读</span>') + '</div>' : '<span class="small" style="color:var(--muted-2)">只读</span>') + '</td>'
    })

    root.innerHTML = rule + '<div style="margin-top:14px">' +
      card('各客服委托佣金比例',
        table(['客服', '默认比例', '委托佣金（锁定）', '操作'], rows, '暂无客服账号'),
        canEdit ? '' : '<span class="small" style="color:var(--muted-2)">仅管理员可调整</span>', true) + '</div>'

    const ruleBtn = root.querySelector('#cs-rule-save')
    if (ruleBtn) {
      ruleBtn.onclick = async function () {
        const rawAgency = root.querySelector('#cs-agency-rate').value.trim()
        const rawIdle = root.querySelector('#cs-idle').value.trim()
        const agencyRate = Number(rawAgency) / 100
        const minutes = Number(rawIdle)
        if (!rawAgency || !Number.isFinite(agencyRate) || agencyRate < 0 || agencyRate > 0.5) return toast('委托佣金比例需在 0–50% 之间', 'err')
        if (!rawIdle || !Number.isFinite(minutes) || minutes < 5 || minutes > 240) {
          return toast('超时时长需在 5–240 分钟之间', 'err')
        }
        const ok = await confirm({
          title: '保存佣金规则',
          message: '委托佣金 ' + csPct(agencyRate) +
            '。新比例仅对之后新绑定的账号生效，已绑定账号维持原锁定比例，不会追溯调整。确认保存？',
          okText: '确认保存'
        })
        if (!ok) return
        ruleBtn.disabled = true
        try {
          await api('cs.saveSettings', { agencyRate: agencyRate, idleMinutes: Math.round(minutes) })
          toast('佣金规则已保存')
          Pages.cs(view)
        } catch (err) {
          toast(err.message, 'err')
          ruleBtn.disabled = false
        }
      }
    }
    root.querySelectorAll('[data-cs-agency-rate]').forEach(function (btn) {
      btn.onclick = function () { csAgencyRateModal(btn.getAttribute('data-cs-agency-rate'), function () { Pages.cs(view) }) }
    })
  }

  /* 每日工作量：按北京时间自然日聚合，客服只看自己，管理员可查全部或指定客服 */
  function renderCsDaily(root, view) {
    const isAdmin = C.can('cs.saveSettings')
    const options = CS_VIEW.staff.map(function (row) {
      return '<option value="' + esc(row.username) + '"' + (CS_VIEW.dailyCs === row.username ? ' selected' : '') + '>' +
        esc(row.name || row.username) + '（' + esc(row.username) + '）</option>'
    }).join('')
    const dayOptions = [7, 14, 30].map(function (d) {
      return '<option value="' + d + '"' + (Number(CS_VIEW.dailyDays) === d ? ' selected' : '') + '>最近 ' + d + ' 天</option>'
    }).join('')
    const head = filterBar([
      (isAdmin
        ? '<div class="field" style="min-width:220px"><label>客服</label><select id="cs-daily-cs"><option value="">全部客服</option>' + options + '</select></div>'
        : '<div class="field" style="min-width:220px"><label>客服</label><input value="' + esc((CS_VIEW.staff[0] && (CS_VIEW.staff[0].name || CS_VIEW.staff[0].username)) || '本人') + '" disabled></div>') +
      '<div class="field" style="min-width:150px"><label>时间范围</label><select id="cs-daily-days">' + dayOptions + '</select></div>',
      '<div class="field" style="justify-content:flex-end"><button class="btn primary" id="cs-daily-query">' + icon('search') + '<span>查询</span></button></div>'
    ])
    root.innerHTML = head + '<div id="cs-daily-body" style="margin-top:12px">' + loadingBlock('读取每日工作量') + '</div>'
    const query = function () {
      const csSel = root.querySelector('#cs-daily-cs')
      CS_VIEW.dailyCs = csSel ? csSel.value : ''
      CS_VIEW.dailyDays = Number(root.querySelector('#cs-daily-days').value) || 7
      loadCsDaily(root, view)
    }
    root.querySelector('#cs-daily-query').onclick = query
    if (!CS_VIEW.daily || Number(CS_VIEW.daily.days) !== Number(CS_VIEW.dailyDays)) loadCsDaily(root, view)
    else renderCsDailyBody(root, view)
  }

  async function loadCsDaily(root, view) {
    const host = root.querySelector('#cs-daily-body') || root
    host.innerHTML = loadingBlock('读取每日工作量')
    try {
      CS_VIEW.daily = await api('cs.daily', { days: CS_VIEW.dailyDays, csId: CS_VIEW.dailyCs || undefined })
      renderCsDailyBody(root, view)
    } catch (err) {
      host.innerHTML = card('每日工作量',
        '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>')
    }
  }

  function renderCsDailyBody(root, view) {
    const host = root.querySelector('#cs-daily-body') || root
    const data = CS_VIEW.daily || {}
    const items = data.items || []
    if (!items.length) {
      host.innerHTML = card('每日工作量', emptyState('暂无可统计的客服'))
      return
    }
    const blocks = items.map(function (item) {
      const totals = item.totals || {}
      const dayRows = (item.items || []).map(function (d) {
        return '<td class="mono small">' + esc(d.day) + '</td>' +
          '<td class="mono">' + num(d.newLeads) + '</td>' +
          '<td class="mono">' + num(d.claimed) + '</td>' +
          '<td class="mono">' + num(d.ended) + '</td>' +
          '<td class="mono">' + num(d.orders) + '</td>' +
          '<td class="mono">' + money(d.feeAmount) + '</td>' +
          '<td class="mono strong">' + money(d.commission) + '</td>' +
          '<td class="mono">' + num(d.ratingCount) + (Number(d.ratingCount) > 0 ? ' · ' + Number(d.ratingAvg).toFixed(1) + ' 星' : '') + '</td>'
      })
      /* 最新日期在前，便于先看最近一天 */
      dayRows.reverse()
      return '<div style="margin-top:14px">' + card(
        (item.name || item.csId) + ' · 每日工作量',
        kpiRow([
          ['新增咨询', num(totals.newLeads), ''],
          ['领取工单', num(totals.claimed), ''],
          ['结束服务', num(totals.ended), ''],
          ['委托成交', num(totals.orders), ''],
          ['委托服务费', money(totals.feeAmount), ''],
          ['委托佣金', money(totals.commission), '']
        ]) + '<div style="margin-top:12px">' +
          table(['日期', '新增咨询', '领取', '结束', '委托成交', '服务费', '委托佣金', '评价'], dayRows, '该时间段暂无工作数据') +
        '</div>',
        '<span class="small" style="color:var(--muted-2)">客服 ' + esc(item.csId) + ' · 最近 ' + num(data.days) + ' 天</span>', true) + '</div>'
    }).join('')
    host.innerHTML = blocks
  }

  /* 客服与绑定：绑定关系只允许管理员设置与修改 */
  function renderCsBind(root, view) {
    const canBind = C.can('cs.bind')
    const canUnbind = C.can('cs.unbind')
    const rows = CS_VIEW.staff.map(function (row) {
      const s = row.stats || {}
      const ops = []
      if (row.binding && row.binding.uid) {
        if (canUnbind) ops.push('<button class="btn xs" data-cs-unbind="' + esc(row.username) + '" data-cs-name="' + esc(row.name || row.username) + '">解绑</button>')
      } else if (canBind) {
        ops.push('<button class="btn xs primary" data-cs-bind="' + esc(row.username) + '">绑定用户</button>')
      }
      ops.push('<button class="btn xs" data-cs-profile="' + esc(row.username) + '">档案</button>')
      return '<td><div class="strong">' + esc(row.name || row.username) + '</div>' +
        '<div class="small mono" style="color:var(--muted-2)">' + esc(row.username) + ' · ' + esc(row.roleName || '') + '</div></td>' +
        '<td>' + csBindingCell(row.binding) + '</td>' +
        '<td>' + csLockCell(row) + '</td>' +
        '<td class="mono">' + money(s.monthAgencyFee) + '<div class="small" style="color:var(--muted-2)">累计 ' + money(s.agencyFeeTotal) + '</div></td>' +
        '<td class="mono strong">' + money(s.monthSalary) +
          '<div class="small" style="color:var(--muted-2)">累计 ' + money(s.totalSalary) + ' · 委托 ' + money(s.monthAgencyCommission) + '</div></td>' +
        '<td>' + num(s.servedCount) + '<div class="small" style="color:var(--muted-2)">已结束 ' + num(s.endedCount) + '</div></td>' +
        '<td>' + csStars(s.ratingAvg) + '<div class="small" style="color:var(--muted-2)">' + num(s.ratingCount) + ' 条</div></td>' +
        '<td><div class="flex" style="gap:5px;flex-wrap:wrap">' + ops.join('') + '</div></td>'
    })
    root.innerHTML = card('客服绑定关系',
      (canBind || canUnbind
        ? '<div class="small" style="color:var(--muted-2);margin-bottom:10px">一个客服只能绑定一个用户，绑定后该用户作为推广人可拿一级 + 二级佣金。绑定与解绑仅管理员可操作，客服无权限设置或修改。</div>'
        : '<div class="small" style="color:var(--muted-2);margin-bottom:10px">绑定关系仅管理员可设置与修改，此处只读。</div>') +
      table(['客服', '绑定用户', '委托佣金（锁定）', '本月 / 累计委托业绩', '本月 / 累计工资', '服务单', '评分', '操作'], rows, '暂无客服账号'),
      '', true)

    root.querySelectorAll('[data-cs-bind]').forEach(function (btn) {
      btn.onclick = function () { csBindModal(btn.getAttribute('data-cs-bind'), function () { Pages.cs(view) }) }
    })
    root.querySelectorAll('[data-cs-unbind]').forEach(function (btn) {
      btn.onclick = async function () {
        const name = btn.getAttribute('data-cs-name')
        const ok = await confirm({
          title: '解绑用户',
          message: '解绑后该客服不再统计此用户下级新增的委托服务费，历史业绩与佣金保留。确认解绑「' + esc(name) + '」？',
          okText: '确认解绑',
          danger: true
        })
        if (!ok) return
        try {
          await api('cs.unbind', { csId: btn.getAttribute('data-cs-unbind') })
          toast('已解绑')
          Pages.cs(view)
        } catch (err) {
          toast(err.message, 'err')
        }
      }
    })
    root.querySelectorAll('[data-cs-profile]').forEach(function (btn) {
      btn.onclick = function () { openCsProfile(btn.getAttribute('data-cs-profile')) }
    })
  }

  function csRowOf(csId) {
    return CS_VIEW.staff.filter(function (row) { return row.username === csId })[0] || { username: csId, name: csId }
  }

  function csBindModal(csId, done) {
    const row = csRowOf(csId)
    const el = modal({
      title: '绑定用户账号',
      sub: (row.name || csId) + ' · 一个客服只能绑定一个用户，一个用户也只归属一个客服',
      body: '<div class="field"><label>搜索用户</label><div class="flex" style="gap:8px">' +
        '<input id="cs-bind-q" placeholder="昵称 / 手机号 / 用户ID"><button class="btn primary" id="cs-bind-search">搜索</button>' +
        '</div></div><div id="cs-bind-list" style="margin-top:12px"></div>'
    })
    if (!el) return
    const list = el.querySelector('#cs-bind-list')
    async function search() {
      const q = el.querySelector('#cs-bind-q').value.trim()
      if (!q) return toast('请输入搜索关键词', 'err')
      list.innerHTML = loadingBlock('搜索用户')
      try {
        const data = await api('user.list', { q: q, page: 1, limit: 8 })
        const items = data.items || []
        if (!items.length) { list.innerHTML = emptyState('没有匹配的用户'); return }
        list.innerHTML = items.map(function (u) {
          return '<div class="flex" style="justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)">' +
            '<div><div class="strong">' + esc(u.nick || '用户') + '</div>' +
            '<div class="small mono" style="color:var(--muted-2)">' + esc(u.id) + (u.userNo ? ' · ' + esc(u.userNo) : '') + '</div></div>' +
            '<button class="btn xs primary" data-bind="' + esc(u.id) + '">绑定</button></div>'
        }).join('')
        list.querySelectorAll('[data-bind]').forEach(function (btn) {
          btn.onclick = async function () {
            btn.disabled = true
            try {
              await api('cs.bind', { csId: csId, uid: btn.getAttribute('data-bind') })
              toast('已绑定用户')
              closeModal()
              done()
            } catch (err) {
              toast(err.message, 'err')
              btn.disabled = false
            }
          }
        })
      } catch (err) {
        list.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message || '搜索失败') + '</div>'
      }
    }
    el.querySelector('#cs-bind-search').onclick = search
    el.querySelector('#cs-bind-q').onkeydown = function (e) { if (e.key === 'Enter') search() }
  }

  function csAgencyRateModal(csId, done) {
    const row = csRowOf(csId)
    const own = row.agencyRateSource === 'staff'
    const el = modal({
      title: '设置该客服的默认委托佣金比例',
      sub: (row.name || csId) + ' · 留空表示按全局默认',
      body: '<div class="field"><label>默认佣金比例（%）</label>' +
        '<input id="cs-agency-rate-one" type="number" min="0" max="50" step="0.1" value="' +
        (own ? (Number(row.agencyRate) * 100).toFixed(1) : '') + '"></div>' +
        '<div class="small" style="color:var(--muted-2);line-height:1.8">全局默认 ' + csPct(CS_VIEW.settings.agencyRate) +
        '；佣金 = 委托服务费实收 × 比例，上限 50%。' +
        '<br><strong>仅影响之后新绑定的账号</strong>，已绑定账号的锁定比例不会改变。</div>',
      footer: '<button class="btn" data-close="1">取消</button><button class="btn primary" data-save="1">保存</button>'
    })
    if (!el) return
    el.querySelector('[data-save]').onclick = async function () {
      const raw = el.querySelector('#cs-agency-rate-one').value.trim()
      const rate = raw === '' ? null : Number(raw) / 100
      if (raw !== '' && (!Number.isFinite(rate) || rate < 0 || rate > 0.5)) return toast('佣金比例需在 0–50% 之间', 'err')
      try {
        await api('cs.saveAgencyRate', { csId: csId, rate: rate })
        toast('已保存')
        closeModal()
        done()
      } catch (err) {
        toast(err.message, 'err')
      }
    }
  }

  async function openCsProfile(csId) {
    const row = csRowOf(csId)
    const s = row.stats || {}
    const d = openDrawer({
      title: row.name || csId,
      sub: '客服业务档案 · ' + csId,
      body: loadingBlock('读取档案'),
      badges: badge(row.roleName || '客服坐席', 'info') + ' ' + csStars(s.ratingAvg)
    })
    if (!d) return
    try {
      const results = await Promise.all([
        api('cs.commissions', { csId: csId, page: 1, limit: 20 }).catch(function (err) { return { items: [], total: 0, error: err.message } }),
        api('cs.ratings', { csId: csId, page: 1, limit: 20 }).catch(function (err) { return { items: [], total: 0, error: err.message } })
      ])
      const commissions = results[0] || {}
      const ratings = results[1] || {}
      const cRows = (commissions.items || []).map(function (item) {
        return '<td class="mono small">' + dayText(item.paidAt) + '</td>' +
          '<td class="small">' + esc(item.item || '代采代售') + '</td>' +
          '<td class="mono">' + money(item.feeAmount) + '</td>' +
          '<td class="mono">' + csPct(item.rate) + '</td>' +
          '<td class="mono strong">' + money(item.commission - (Number(item.reversedCommission) || 0)) + '</td>' +
          '<td class="small">' + esc(item.status || '已计提') + '</td>'
      })
      const rRows = (ratings.items || []).map(function (item) {
        return '<td class="mono small">' + dayText(item.createdAt) + '</td>' +
          '<td>' + csStars(item.score) + '</td>' +
          '<td class="small">' + (Array.isArray(item.tags) && item.tags.length ? item.tags.map(function (t) { return badge(t, 'info') }).join(' ') : '—') + '</td>' +
          '<td class="small">' + esc(item.text || '—') + '</td>' +
          '<td class="small mono">' + esc(item.agencyTitle || '—') + '</td>'
      })
      d.body.innerHTML = '<div class="grid g3">' +
        kpi('累计委托业绩', money(s.agencyFeeTotal), '<span class="small" style="color:var(--muted-2)">' + num(s.orderCount) + ' 笔委托') +
        kpi('累计委托佣金', money(s.commissionTotal), '<span class="small" style="color:var(--muted-2)">本月 ' + money(s.monthCommission) + '</span>') +
        kpi('服务咨询', num(s.servedCount), '<span class="small" style="color:var(--muted-2)">已结束 ' + num(s.endedCount) + '</span>') +
        '</div>' +
        '<div style="margin-top:16px">' + card('委托佣金流水', table(['日期', '委托事项', '服务费', '比例', '佣金', '状态'], cRows, '暂无委托佣金流水'), '', true) + '</div>' +
        '<div style="margin-top:16px">' + card('评价记录', table(['日期', '评分', '标签', '内容', '咨询单'], rRows, '暂无评价'), '', true) + '</div>'
    } catch (err) {
      d.body.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message || '加载失败') + '</div>'
    }
  }

  /**
   * 代采代售咨询会话：管理员或领取该咨询的客服可直接与用户对话。
   * 会话按 threadId（咨询单 id）归组，与用户端「我的消息」里的咨询会话同源。
   */
  function openCsChat(leadId, title, csName) {
    const d = openDrawer({
      title: '咨询会话',
      sub: esc(title || '代采代售咨询'),
      badges: badge(csName ? '客服 ' + csName : '未分配客服', csName ? 'info' : 'warn'),
      body: '<div class="chat-stream" id="cs-chat-stream" style="max-height:50vh;overflow:auto">' + loadingBlock('加载会话') + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:12px;margin-top:12px">' +
        quickReplyBar() +
        '<textarea id="cs-chat-input" rows="3" placeholder="输入回复内容，请勿索要手机号 / 证件号（最多 500 字）"></textarea>' +
        '<div class="flex" style="justify-content:flex-end"><button class="btn primary" id="cs-chat-send">发送回复</button></div></div>'
    })
    if (!d) return
    const stream = d.body.querySelector('#cs-chat-stream')
    const inputEl = d.body.querySelector('#cs-chat-input')
    const sendBtn = d.body.querySelector('#cs-chat-send')
    /* 常用语：点一下填入回复框 */
    wireQuickReplies(d.body, '#cs-chat-input')

    async function load() {
      try {
        const data = await api('msg.list', { threadId: leadId, page: 1, limit: 100 })
        const items = data.items || []
        stream.innerHTML = (items.length ? items.map(function (m) {
          if (m.from !== 'user' && m.from !== 'staff') {
            return '<div class="chat-note" style="text-align:center">' + esc(m.body || m.title || '系统通知') + '</div>'
          }
          return '<div class="chat-bubble' + (m.from === 'staff' ? ' me' : '') + '">' +
            '<div class="meta">' + esc(m.from === 'staff' ? (m.staffName || '平台客服') : '用户') + ' · ' + esc(dateText(m.createdAt)) + '</div>' +
            msgContentHtml(m) + '</div>'
        }).join('') : emptyState('会话暂无内容'))
        stream.scrollTop = stream.scrollHeight
      } catch (err) {
        stream.innerHTML = '<div class="small" style="color:var(--danger)">' + esc(err.message || '会话读取失败') + '</div>'
      }
    }

    async function send() {
      const body = inputEl.value.trim()
      if (!body) return toast('请输入回复内容', 'err')
      sendBtn.disabled = true
      try {
        await api('msg.reply', { threadId: leadId, body: body })
        inputEl.value = ''
        await load()
      } catch (err) {
        toast(err.message, 'err')
      }
      sendBtn.disabled = false
    }

    sendBtn.onclick = send
    inputEl.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    }
    load()
    const timer = setInterval(function () {
      if (!document.body.contains(d.drawer)) { clearInterval(timer); return }
      load()
    }, 6000)
  }

})()
