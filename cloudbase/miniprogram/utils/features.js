/* 管理端功能开关（社交总开关）的唯一读取入口。
   之前各页面各自在 onLoad 里读一次 app.globalData.chatEnabled：
   冷启动时开关还没从服务端回来，页面就会一直停在「关闭」的界面；
   切页 / 从后台回来也不会再同步。这里统一成：
   1) 已拉到结果用真实值，没拉到先用上次缓存，避免误判；
   2) 页面订阅 onChange，开关回来后立即刷新，不必等重新进入；
   3) ensure() 做并发去重，多个页面同时补拉只发一次请求。 */
const KEY = 'featureFlags'

/* 订阅者：app.loadFeatureFlags 拿到新值后统一通知 */
const listeners = []
let pending = null

function appRef() {
  try {
    return getApp()
  } catch (e) {
    return null
  }
}

/* 上次成功拉取的结果：冷启动第一屏先用它，避免闪一下 / 误判 */
function cached() {
  try {
    const v = wx.getStorageSync(KEY)
    return !!(v && v.chatEnabled === true)
  } catch (e) {
    return false
  }
}

/* 开关是否已经拿到过服务端结果 */
function loaded() {
  const app = appRef()
  return !!(app && app.globalData && app.globalData.featureFlagsLoaded)
}

/* 当前开关值：未拿到服务端结果前用缓存兜底 */
function chatEnabled() {
  const app = appRef()
  const g = (app && app.globalData) || {}
  return g.featureFlagsLoaded ? g.chatEnabled === true : cached()
}

/* 还没拿到结果时补拉一次；并发调用共用同一个请求 */
function ensure() {
  if (loaded()) return Promise.resolve(chatEnabled())
  if (pending) return pending
  const app = appRef()
  if (!app || typeof app.loadFeatureFlags !== 'function') return Promise.resolve(chatEnabled())
  pending = app.loadFeatureFlags()
  const done = () => { pending = null }
  pending.then(done, done)
  return pending
}

/* 订阅开关变化：返回取消订阅函数，页面 onUnload 里务必调用 */
function onChange(cb) {
  if (typeof cb !== 'function') return function () {}
  listeners.push(cb)
  return function off() {
    const i = listeners.indexOf(cb)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/* 开关变化广播：由 app.loadFeatureFlags 在拿到新值后调用 */
function emit() {
  const on = chatEnabled()
  listeners.slice().forEach((cb) => {
    try {
      cb(on)
    } catch (e) { /* 单个页面回调异常不影响其他页面 */ }
  })
}

module.exports = {
  chatEnabled,
  cached,
  loaded,
  ensure,
  onChange,
  emit
}
