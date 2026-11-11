/**
 * 本机用小程序代码上传密钥发布体验/开发版本（不走公众平台网页、不经服务器）。
 *
 * 用法：
 *   NODE_OPTIONS=--no-experimental-webstorage node cloudbase/scripts/wx-upload.cjs 1.5.1 "本次改动说明"
 *
 * 说明：
 * 1. Node 25 自带 localStorage 桩（无 getItem），会让 miniprogram-ci 内部报错，先清掉；
 * 2. 上传密钥默认取 ~/.wxci/ 下的私钥，可用 CI_KEY 覆盖；
 * 3. 上传成功后仍需到公众平台「版本管理」提交审核 / 设为体验版。
 */
try {
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true })
} catch (e) { /* no-op */ }

const fs = require('node:fs')
const path = require('node:path')

/* miniprogram-ci 只装在本机 ~/.wxci，不污染项目依赖：优先本地解析，失败再回退到该目录 */
function loadCi() {
  try {
    return require('miniprogram-ci')
  } catch (err) {
    const fallback = path.join(process.env.HOME || '', '.wxci/node_modules/miniprogram-ci')
    return require(fallback)
  }
}
const ci = loadCi()

const version = process.argv[2] || ''
const desc = process.argv[3] || '常规更新'
const appid = process.env.CI_APPID || 'wxe21e1b8732bfb4a3'
const projectPath = process.env.CI_PROJECT || path.join(__dirname, '..')
const keyCandidates = [
  process.env.CI_KEY,
  path.join(process.env.HOME || '', '.wxci/private.' + appid + '.key'),
  path.join(process.env.HOME || '', 'Downloads/private.' + appid + '.key')
].filter(Boolean)
const privateKeyPath = keyCandidates.filter((p) => fs.existsSync(p))[0] || ''

if (!version) {
  console.error('用法：node cloudbase/scripts/wx-upload.cjs <版本号> "<描述>"')
  process.exit(2)
}
if (!privateKeyPath) {
  console.error('未找到上传密钥，请放到 ~/.wxci/private.' + appid + '.key 或用 CI_KEY 指定')
  process.exit(2)
}

;(async () => {
  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath,
    privateKeyPath,
    ignores: ['node_modules/**/*', '.dev-data/**/*', '**/.DS_Store']
  })
  const result = await ci.upload({
    project,
    version,
    desc,
    setting: { es6: true, minify: true, autoPrefixWXSS: true },
    onProgressTask: () => {}
  })
  console.log('UPLOAD_OK ' + JSON.stringify({ version, privateKeyPath, result }))
})().catch((err) => {
  console.error('UPLOAD_FAIL ' + (err && (err.message || err)))
  process.exit(1)
})
