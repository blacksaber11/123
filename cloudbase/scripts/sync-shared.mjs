/**
 * 把 shared 目录的所有 JS 文件复制到每个云函数的 _shared 子目录。
 *
 * 云开发每个云函数都是独立打包的，不能直接引用上层 shared。
 * 部署前运行：node scripts/sync-shared.mjs
 * 修改了 shared 里任何文件后都要重新同步。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const sharedDir = path.join(root, 'shared')
const functionsDir = path.join(root, 'cloudfunctions')

const FILES = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.js'))

/* 型号库静态目录的真源在 cloudbase/device-catalog.js，同步一份到 shared，
   管理端「型号库」才能拿到与小程序同一份内置目录（云函数只能读自己目录下的文件）。 */
fs.copyFileSync(path.join(root, 'device-catalog.js'), path.join(sharedDir, 'device-catalog.js'))
if (!FILES.includes('device-catalog.js')) FILES.push('device-catalog.js')

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function syncFunction(fnName) {
  const target = path.join(functionsDir, fnName, '_shared')
  ensureDir(target)
  for (const file of FILES) {
    fs.copyFileSync(path.join(sharedDir, file), path.join(target, file))
  }
  // 更新 require 路径：cloudfunctions/user/index.js → require('./_shared/xxx')
  const indexFile = path.join(functionsDir, fnName, 'index.js')
  console.log('  ↳ sync ' + fnName + ' (' + FILES.length + ' files)')
  return indexFile
}

const fns = fs.readdirSync(functionsDir).filter((d) => {
  const p = path.join(functionsDir, d)
  return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'index.js'))
})

console.log('Sync shared modules to ' + fns.length + ' cloud functions:')
for (const fn of fns) syncFunction(fn)

/* 型号归一化两端共用：小程序侧也拿同一份实现，避免匹配口径漂移 */
const miniTarget = path.join(root, 'miniprogram', 'utils')
if (fs.existsSync(miniTarget)) {
  fs.copyFileSync(path.join(sharedDir, 'model.js'), path.join(miniTarget, 'model.js'))
  console.log('  ↳ sync miniprogram/utils/model.js')
}
console.log('Done.')
