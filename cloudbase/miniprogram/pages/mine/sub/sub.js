/* 「我的」二级视图页：复用 mine-core 的逻辑，系统返回 / 侧滑返回回到「我的」而不是退出小程序 */
const { BASE } = require('../mine-core')

Page(Object.assign({}, BASE, {
  data: Object.assign({}, BASE.data, { mode: 'sub' })
}))
