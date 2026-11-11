/* 「我的」菜单页：二级视图统一由 pages/mine/sub 承载，系统返回直接回到本页 */
const { BASE } = require('./mine-core')

Page(Object.assign({}, BASE, {
  data: Object.assign({}, BASE.data, { mode: 'menu' })
}))
