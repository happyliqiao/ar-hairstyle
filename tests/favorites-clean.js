/**
 * 收藏列表的清洗与一致性（第 31 轮）
 *
 * listRecords 从第 2 轮起就有严格清洗（缺 id / createdAt 非法就丢掉），
 * listFavorites 到今天还是 `readJson(...) || []` —— 同一个文件里两套标准。
 *
 * 收藏的脏数据来源和记录一模一样：旧版本字段变更、用户手改 storage、
 * 写入过程被中断。另外还有一个记录不会遇到的情况：**发型库改版后下架的 id**。
 * 记录里存的是照片 + 快照文字，发型下架不影响；收藏里只存 id，
 * 一旦某款发型被删掉，那个 id 就永远指向空气。
 *
 * 脏收藏的后果不是「显示难看」，是三个具体故障：
 *
 *   1. 重复 id → wxml 的 wx:key 撞车。微信不报错，只在控制台打一行
 *      duplicate key，然后列表复用错位。更直接的是 toggleFavorite 用
 *      indexOf 只删第一个：用户长按取消收藏，卡片删了还在。
 *   2. 已下架 id → getStyle 返回 null，卡片被 continue 跳过，
 *      但 stat.favs 用的是原始 length：界面上「收藏 5」下面只有 3 张卡。
 *   3. 脏数据永远留在 storage 里，每次进页面都要失败一遍、永远清不掉。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

/* ---------------- wx 桩 ---------------- */

const storage = {}

global.wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getWindowInfo() {
    return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
  },
  getSystemInfoSync() {
    return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
  },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getFileSystemManager() {
    return {
      getFileInfo(o) { o && o.success && o.success({ size: 280 * 1024 }) },
      saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://p.jpg' }) },
      removeSavedFile(o) { o && o.success && o.success({}) }
    }
  }
}, {
  get(t, k) {
    if (k in t) return t[k]
    if (typeof k !== 'string') return undefined
    if (k === 'then') return undefined
    return function () {}
  }
})

const KEY_FAV = 'arhair_favorites_v1'
const KEY_REC = 'arhair_records_v1'

function resetFav(raw) {
  delete storage[KEY_FAV]
  delete storage[KEY_REC]
  if (raw !== undefined) storage[KEY_FAV] = typeof raw === 'string' ? raw : JSON.stringify(raw)
}

const store = require(path.join(ROOT, 'utils/store'))
const hairstyles = require(path.join(ROOT, 'utils/hairstyles'))

/* ================= A. listFavorites 的清洗 ================= */

console.log('\n[A] listFavorites 清洗脏数据')

resetFav()
ck('A1 storage 为空 → []', JSON.stringify(store.listFavorites()) === '[]', JSON.stringify(store.listFavorites()))

resetFav('{ 这不是 json')
ck('A2 非法 JSON → []', JSON.stringify(store.listFavorites()) === '[]', JSON.stringify(store.listFavorites()))

resetFav({ a: 1 })
ck('A3 对象而非数组 → []', JSON.stringify(store.listFavorites()) === '[]', JSON.stringify(store.listFavorites()))

resetFav(['bob', null, 3, '', 'wavy', true, { id: 'curly' }, '  '])
const a4 = store.listFavorites()
ck('A4 剔除 null/数字/空串/布尔/对象', JSON.stringify(a4) === '["bob","wavy"]', JSON.stringify(a4))

resetFav(['bob', 'wavy', 'bob', 'bob'])
const a5 = store.listFavorites()
ck('A5 重复 id 去重且保序', JSON.stringify(a5) === '["bob","wavy"]', JSON.stringify(a5))

resetFav([' bob ', 'wavy '])
const a6 = store.listFavorites()
ck('A6 首尾空白被 trim', JSON.stringify(a6) === '["bob","wavy"]', JSON.stringify(a6))

const many = []
for (let i = 0; i < 40; i++) many.push('bob')
for (let i = 0; i < 40; i++) many.push(hairstyles.HAIR_STYLES[i % hairstyles.HAIR_STYLES.length].id)
resetFav(many)
const a7 = store.listFavorites()
ck('A7 超长列表被截断', a7.length <= store.MAX_FAVORITES, 'len=' + a7.length)

resetFav(['bob', 'wavy', 'curly'])
ck('A8 正常数据原样返回', JSON.stringify(store.listFavorites()) === '["bob","wavy","curly"]', JSON.stringify(store.listFavorites()))

/* ================= B. toggleFavorite 的幂等 ================= */

console.log('\n[B] toggleFavorite 在脏列表上仍然幂等')

resetFav(['bob', 'bob', 'wavy'])
store.toggleFavorite('bob')
const b1 = store.listFavorites()
ck('B1 取消收藏一次删干净（不留重复项）', b1.indexOf('bob') < 0, JSON.stringify(b1))

resetFav(['bob', 'bob'])
store.toggleFavorite('bob')
store.toggleFavorite('bob')
const b2 = store.listFavorites()
ck('B2 反复 toggle 不会越删越多 / 越加越多', JSON.stringify(b2) === '["bob"]' || JSON.stringify(b2) === '[]', JSON.stringify(b2))

resetFav(['bob', null, 'bob'])
store.toggleFavorite('wavy')
const b3 = store.listFavorites()
ck('B3 写入前先清洗（脏项不会写回去）', JSON.stringify(b3) === '["bob","wavy"]', JSON.stringify(b3))

resetFav()
ck('B4 空列表 toggle 返回 true（已收藏）', store.toggleFavorite('bob') === true)

/* ================= C. 「我的」页的计数一致性 ================= */

console.log('\n[C] 「我的」页：收藏计数 = 实际卡片数')

function loadProfile() {
  const abs = path.join(ROOT, 'pages/profile/profile.js')
  const g = {
    wx: global.wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: {}, cloudReady: false } } },
    getCurrentPages() { return [] },
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null
  Object.keys(g).forEach(function (k) { global[k] = g[k] })
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) {
    Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] })
    cb && cb()
  }
  return inst
}

// 3 个真实 id + 2 个已下架 id + 1 个重复
resetFav(['bob', 'wavy', 'long-straight', 'style-that-was-removed', 'another-removed', 'bob'])
const profile = loadProfile()
profile.onLoad({})
profile.onShow()

const cards = profile.data.favStyles
ck('C1 卡片只渲染真实存在的发型', cards.length === 3, 'cards=' + cards.length + ' ' + JSON.stringify(cards.map(function (c) { return c.id })))
ck('C2 卡片 id 唯一（wx:key 不撞车）',
  new Set(cards.map(function (c) { return c.id })).size === cards.length,
  JSON.stringify(cards.map(function (c) { return c.id })))
ck('C3 stat.favs 与实际卡片数一致', profile.data.stat.favs === cards.length,
  'stat=' + profile.data.stat.favs + ' cards=' + cards.length)

// 自愈：脏 id 应该被写回 storage，而不是每次进页面都失败一遍
const healed = store.listFavorites()
ck('C4 已下架 / 重复 id 被从 storage 里清掉',
  JSON.stringify(healed) === '["bob","wavy","long-straight"]', JSON.stringify(healed))

// 再进一次页面，指纹不该变化（不能因为自愈而每次重传 30KB）
const fp1 = profile._favFp
profile.onShow()
ck('C5 自愈后再次 onShow 不重复重建缩略图', profile._favFp === fp1, fp1 + ' vs ' + profile._favFp)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '收藏清洗：全部通过' : '收藏清洗：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
