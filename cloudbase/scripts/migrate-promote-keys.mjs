#!/usr/bin/env node
/**
 * 一次性数据迁移：把终态提现单 / 出款明细的唯一占用键改写为退休键 R#<id>。
 *
 * 为什么需要：
 * - 提现单在途时 activeKey = uid（同一用户同时只允许一笔），终态必须改写为 R#<id>；
 * - 出款明细在途时 activeCommissionKey = commissionId（一笔佣金同时只允许一条有效明细），
 *   终态必须改写为 R#<id>。
 * 历史终态记录若仍占着 uid / commissionId，MySQL 适配器的应用层唯一校验会误报「记录已存在」，
 * 表现为：用户无法再次提现、同一笔佣金无法再次出款。
 *
 * 说明：MySQL 适配器的唯一约束在应用层（assertNoDuplicate）实现，data 存在 JSON 列里，
 * 不需要（也无法直接）建数据库唯一索引；把键回填正确即可。
 *
 * 用法（在 cloudbase 目录执行，MYSQL_URL 从环境变量或 .env 读取）：
 *   node scripts/migrate-promote-keys.mjs           # 体检，只读不写
 *   node scripts/migrate-promote-keys.mjs --apply   # 正式回填
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/* 与 server/index.js 同口径：PM2 里只放 ENV_FILE，密钥落盘 */
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const idx = text.indexOf('=')
    if (idx <= 0) continue
    const key = text.slice(0, idx).trim()
    let value = text.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = value
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(root, '.env'))

const MYSQL_URL = String(process.env.MYSQL_URL || '').trim()
if (!MYSQL_URL) {
  console.error('[migrate] 缺少 MYSQL_URL：请在环境变量或 cloudbase/.env 中配置后重试')
  process.exit(1)
}

const { createMysqlRepo } = require('../server/repo.mysql')
const { WITHDRAW_STATUS, PAYOUT_ITEM_STATUS } = require('../shared/promote')

const APPLY = process.argv.includes('--apply')
const WITHDRAW_TERMINAL = [WITHDRAW_STATUS.PAID, WITHDRAW_STATUS.REJECTED, WITHDRAW_STATUS.CANCELLED]
/* failed 仍占着 commissionId（等待重新打款），不算终态 */
const ITEM_TERMINAL = [PAYOUT_ITEM_STATUS.DONE, PAYOUT_ITEM_STATUS.CANCELLED, PAYOUT_ITEM_STATUS.REFUNDED]
const RETIRED = (id) => 'R#' + String(id || '')

const repo = createMysqlRepo({ url: MYSQL_URL, connectionLimit: 5 })

/** 扫描一个集合：终态里键不等于退休键的记为待回填；在途键重复的单独报出来（不能自动修） */
async function scan(collection, field) {
  const todo = []
  const activeKeys = new Map()
  const page = 500
  let skip = 0
  for (;;) {
    const rows = await repo.find(collection, {}, { sort: { id: 1 }, limit: page, skip })
    if (!rows.length) break
    for (const doc of rows) {
      const raw = Object.prototype.hasOwnProperty.call(doc, field) ? doc[field] : undefined
      const key = raw === undefined || raw === null ? '' : String(raw)
      const terminal = collection === 'promoterWithdrawals'
        ? WITHDRAW_TERMINAL.indexOf(doc.status) >= 0
        : ITEM_TERMINAL.indexOf(doc.status) >= 0
      if (terminal) {
        const want = RETIRED(doc.id)
        if (key !== want) todo.push({ id: doc.id, status: doc.status, from: key, to: want })
      } else if (key) {
        activeKeys.set(key, (activeKeys.get(key) || 0) + 1)
      }
    }
    if (rows.length < page) break
    skip += page
  }
  return { todo, dup: [...activeKeys].filter(([, n]) => n > 1) }
}

async function main() {
  const withdraw = await scan('promoterWithdrawals', 'activeKey')
  const items = await scan('promotePayoutItems', 'activeCommissionKey')

  for (const [label, result, field, collection] of [
    ['提现单 promoterWithdrawals.activeKey', withdraw, 'activeKey', 'promoterWithdrawals'],
    ['出款明细 promotePayoutItems.activeCommissionKey', items, 'activeCommissionKey', 'promotePayoutItems']
  ]) {
    console.log(`\n[${label}] 待回填 ${result.todo.length} 条`)
    for (const row of result.todo.slice(0, 10)) {
      console.log(`  - ${row.id} · ${row.status} · "${row.from || '空'}" → "${row.to}"`)
    }
    if (result.todo.length > 10) console.log(`  ... 其余 ${result.todo.length - 10} 条略`)
    if (result.dup.length) {
      console.warn(`  ! 在途键重复 ${result.dup.length} 个（需人工核对，脚本不会自动改）：`)
      for (const [key, n] of result.dup.slice(0, 10)) console.warn(`    ${key} × ${n}`)
    }
    if (APPLY && result.todo.length) {
      let done = 0
      for (const row of result.todo) {
        const saved = await repo.updateWhere(collection, { id: row.id }, { [field]: row.to })
        if (saved && saved.count > 0) done += 1
      }
      console.log(`  ✔ 已回填 ${done} / ${result.todo.length}`)
    }
  }

  const pending = withdraw.todo.length + items.todo.length
  if (!APPLY && pending) {
    console.log('\n当前为体检模式，未写库。确认无误后追加 --apply 正式回填。')
  } else if (!pending) {
    console.log('\n没有需要回填的记录，唯一占用键已全部正确。')
  }
}

main()
  .catch((err) => {
    console.error('[migrate] 执行失败：' + ((err && err.message) || err))
    process.exitCode = 1
  })
  .finally(() => {
    repo.close().catch(() => {})
  })
