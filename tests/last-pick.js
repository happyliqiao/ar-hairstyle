/**
 * 记住上次的选择 + 下架款的安全回落（第 45 轮）
 *
 * 第 31 轮修过「收藏里存着已下架的 id，卡片上却显示 bob」——
 * 那一轮只扫了收藏页。这一轮把同一个 bug 家族在**其余三处**扫一遍，
 * 并且补上一个一直缺的能力：**记住上次用的发型/发色**。
 *
 * 理发店的真实场景：顾客昨天试了 mohawk，今天回来还想再看一眼，
 * 或者发型师说「就按你上次看中那款剪」。原来每次进试戴页都跳回
 * 写死的 bob + chestnut，等于让他每次进来重新找一遍。
 *
 * 但「记住」和「下架」是一对：记住了的 id 过几个版本可能就不存在了。
 * 这时**必须回落**，而且回落不能是静默的 —— 用户点的是大波浪，
 * 出来一个圆寸，他会以为记录/收藏坏了。
 *
 * 这一轮验证：
 *   A. store 层的读写与脏值清洗
 *   B. 进试戴页的优先级：URL 参数 > 上次用的 > 默认款
 *   C. 已下架的 id 一律回落，且回落路径用的是 hasStyle/hasColor
 *   D. 选款/选色时写回 lastPick
 *   E. 记录页：失效发色不画错色点、失效发型不带进 URL
 *   F. 静态：不允许再出现「用 getStyle 返回值判存在性」的写法
 */
const fs = require('fs')
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
let calls = []

function reset() {
  calls = []
  for (const k in storage) delete storage[k]
}

function makeCtx() {
  const grad = { addColorStop() {} }
  return new Proxy({
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } }
  }, {
    get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} },
    set() { return true }
  })
}

const wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getWindowInfo() { return { statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getPrivacySetting(o) { o && o.success && o.success({ needAuthorization: false }) },
  getFileSystemManager() {
    return { getFileInfo(o) { o && o.success && o.success({ size: 1024 }) }, saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) }, removeSavedFile(o) { o && o.success && o.success({}) } }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() {
    return {
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
      takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/s.jpg' }) }
    }
  },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
    return q
  },
  navigateTo(o) { calls.push({ api: 'navigateTo', url: o && o.url }); o && o.success && o.success({}) },
  redirectTo(o) { calls.push({ api: 'redirectTo', url: o && o.url }); o && o.success && o.success({}) },
  switchTab(o) { calls.push({ api: 'switchTab', url: o && o.url }); o && o.success && o.success({}) },
  navigateBack(o) { calls.push({ api: 'navigateBack' }); o && o.success && o.success({}) },
  showToast(o) { calls.push({ api: 'showToast', title: o && o.title }) },
  showLoading() {}, hideLoading() {}, showModal() {},
  vibrateShort() {}, setKeepScreenOn() {}
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

global.wx = wx
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false }, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout() { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const store = require(path.join(ROOT, 'utils/store'))
const hairstyles = require(path.join(ROOT, 'utils/hairstyles'))
const nav = require(path.join(ROOT, 'utils/nav'))
const swipe = require(path.join(ROOT, 'utils/swipe-guard'))

function loadPage(rel) {
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst._alive = true
  inst.cw = 375
  inst.ch = 667
  inst.ctx = makeCtx()
  inst.render = function () {}
  inst.persist = function () {}
  inst.data.isDevtools = false
  inst._stripSwipe = swipe.create()
  inst._colorSwipe = swipe.create()
  inst._hotSwipe = swipe.create()
  inst._favSwipe = swipe.create()
  return inst
}

/** 起一个试戴页实例并跑 onLoad（initial pick 就发生在 onLoad 里） */
function bootTryon(options) {
  const inst = loadPage('pages/tryon/tryon.js')
  inst.onLoad(options || {})
  return inst
}

/* ================= A. store 层 ================= */

console.log('\n[A] store 层读写')

reset()
let lp = store.getLastPick()
ck('A1 没存过时返回空串', lp.style === '' && lp.color === '', JSON.stringify(lp))

reset()
store.saveLastPick('wavy', 'ashpurple')
lp = store.getLastPick()
ck('A2 写进去能读出来', lp.style === 'wavy' && lp.color === 'ashpurple', JSON.stringify(lp))

reset()
storage['arhair_last_pick_v1'] = 'not-an-object'
lp = store.getLastPick()
ck('A3 存成字符串时不崩', lp.style === '' && lp.color === '', JSON.stringify(lp))

reset()
storage['arhair_last_pick_v1'] = [1, 2, 3]
lp = store.getLastPick()
ck('A4 存成数组时不崩', lp.style === '' && lp.color === '', JSON.stringify(lp))

reset()
storage['arhair_last_pick_v1'] = { style: 123, color: null }
lp = store.getLastPick()
ck('A5 非字符串字段归一成空串', lp.style === '' && lp.color === '', JSON.stringify(lp))

reset()
storage['arhair_last_pick_v1'] = { style: 'bob' }
lp = store.getLastPick()
ck('A6 缺字段补空串', lp.style === 'bob' && lp.color === '', JSON.stringify(lp))

reset()
store.saveLastPick(null, undefined)
lp = store.getLastPick()
ck('A7 写非字符串不崩', lp.style === '' && lp.color === '', JSON.stringify(lp))

/* ================= B. 进试戴页的优先级 ================= */

console.log('\n[B] 优先级：URL > 上次用的 > 默认')

reset()
let t = bootTryon({})
ck('B1 全新用户用默认款 bob', t.data.currentStyle === 'bob', t.data.currentStyle)
ck('B2 全新用户用默认发色 chestnut', t.data.currentColor === 'chestnut', t.data.currentColor)

reset()
store.saveLastPick('wavy', 'ashpurple')
t = bootTryon({})
ck('B3 老用户回到上次的发型', t.data.currentStyle === 'wavy', t.data.currentStyle)
ck('B4 老用户回到上次的发色', t.data.currentColor === 'ashpurple', t.data.currentColor)

reset()
store.saveLastPick('wavy', 'ashpurple')
t = bootTryon({ style: 'ponytail' })
ck('B5 URL 参数压过记忆', t.data.currentStyle === 'ponytail', t.data.currentStyle)
ck('B6 发色仍取记忆（URL 没带）', t.data.currentColor === 'ashpurple', t.data.currentColor)

reset()
store.saveLastPick('wavy', 'ashpurple')
t = bootTryon({ style: 'ponytail', color: 'wine' })
ck('B7 两个参数都在时都用参数', t.data.currentStyle === 'ponytail' && t.data.currentColor === 'wine',
  t.data.currentStyle + '/' + t.data.currentColor)

/* ================= C. 下架款回落 ================= */

console.log('\n[C] 已下架的 id 一律回落')

reset()
store.saveLastPick('hairstyle-that-no-longer-exists', 'color-that-no-longer-exists')
t = bootTryon({})
ck('C1 记忆里的发型已下架 → 回默认款', t.data.currentStyle === 'bob', t.data.currentStyle)
ck('C2 记忆里的发色已下架 → 回默认色', t.data.currentColor === 'chestnut', t.data.currentColor)
ck('C3 名字跟着回落（不会出现「已下架款的名字 + bob 的图」）', t.data.currentStyleName === hairstyles.getStyle('bob').name, t.data.currentStyleName)

reset()
t = bootTryon({ style: 'nope-nope', color: 'nope-nope' })
ck('C4 URL 里的下架款也回落', t.data.currentStyle === 'bob' && t.data.currentColor === 'chestnut',
  t.data.currentStyle + '/' + t.data.currentColor)

reset()
t = bootTryon({ style: null, color: 0 })
ck('C5 URL 参数是 null/0 时不崩', t.data.currentStyle === 'bob' && t.data.currentColor === 'chestnut',
  t.data.currentStyle + '/' + t.data.currentColor)

// 记忆有效但 URL 无效 → 应该退回**记忆**，不是退回默认
reset()
store.saveLastPick('wavy', 'ashpurple')
t = bootTryon({ style: 'gone', color: 'gone' })
ck('C6 URL 无效时退回记忆而不是默认', t.data.currentStyle === 'wavy' && t.data.currentColor === 'ashpurple',
  t.data.currentStyle + '/' + t.data.currentColor)

/* ================= D. 选款/选色写回 ================= */

console.log('\n[D] 选择时写回 lastPick')

reset()
t = bootTryon({})
t.pickStyle({ currentTarget: { dataset: { id: 'ponytail' } } })
lp = store.getLastPick()
ck('D1 选款后写回发型', lp.style === 'ponytail', lp.style)
ck('D2 同时记住当前发色', lp.color === 'chestnut', lp.color)

reset()
t = bootTryon({})
t.pickColor({ currentTarget: { dataset: { id: 'wine' } } })
lp = store.getLastPick()
ck('D3 选色后写回发色', lp.color === 'wine', lp.color)
ck('D4 同时记住当前发型', lp.style === 'bob', lp.style)

reset()
store.saveLastPick('wavy', 'ashpurple')
t = bootTryon({})
t.pickStyle({ currentTarget: { dataset: { id: 'gone-style' } } })
ck('D5 点了不存在的款：不改当前发型', t.data.currentStyle === 'wavy', t.data.currentStyle)
lp = store.getLastPick()
ck('D6 点了不存在的款：不写回', lp.style === 'wavy', lp.style)

reset()
t = bootTryon({})
t.pickColor({ currentTarget: { dataset: { id: 'gone-color' } } })
ck('D7 点了不存在的色：不改当前发色', t.data.currentColor === 'chestnut', t.data.currentColor)
ck('D8 点了不存在的色：不写回', store.getLastPick().color === '', store.getLastPick().color)

/* ================= E. 记录页的失效处理 ================= */

console.log('\n[E] 记录页')

reset()
// 造两条记录：一条正常、一条发色已下架
storage['arhair_records_v1'] = [
  { id: 'r1', styleId: 'bob', colorId: 'ashpurple', styleName: '波波头', colorName: '冷灰', photoPath: '', thumbPath: '', createdAt: Date.now() },
  { id: 'r2', styleId: 'bob', colorId: 'gone-color', styleName: '波波头', colorName: '已下架色', photoPath: '', thumbPath: '', createdAt: Date.now() }
]
const h = loadPage('pages/history/history.js')
h.refresh()
ck('E1 两条记录都在', h.data.records.length === 2, String(h.data.records.length))
ck('E2 有效发色有 swatch', !!h.data.records[0].swatch, h.data.records[0].swatch)
ck('E3 失效发色没有 swatch（不能给个错颜色）', h.data.records[1].swatch === '', String(h.data.records[1].swatch))
ck('E4 失效发色仍显示当时的名字', h.data.records[1].colorName === '已下架色', h.data.records[1].colorName)

// 点开无照片 + 已下架发型的记录
reset()
storage['arhair_records_v1'] = [
  { id: 'r3', styleId: 'gone-style', colorId: 'ashpurple', styleName: '已下架款', colorName: '冷灰', photoPath: '', thumbPath: '', createdAt: Date.now() }
]
const h2 = loadPage('pages/history/history.js')
nav._reset()
h2.refresh()
h2.openRecord({ currentTarget: { dataset: { id: 'r3' } } })
ck('E5 无照片时会去试戴页', calls.some(function (c) { return c.api === 'navigateTo' }), JSON.stringify(calls))
const url = (calls.filter(function (c) { return c.api === 'navigateTo' })[0] || {}).url || ''
ck('E6 失效发型不带进 URL', url.indexOf('gone-style') < 0, url)
ck('E7 有效发色仍然带上', url.indexOf('color=ash') >= 0, url)

reset()
storage['arhair_records_v1'] = [
  { id: 'r4', styleId: 'bob', colorId: 'ashpurple', styleName: '波波头', colorName: '冷灰', photoPath: '', thumbPath: '', createdAt: Date.now() }
]
const h3 = loadPage('pages/history/history.js')
nav._reset()
h3.refresh()
h3.openRecord({ currentTarget: { dataset: { id: 'r4' } } })
const url2 = (calls.filter(function (c) { return c.api === 'navigateTo' })[0] || {}).url || ''
ck('E8 都有效时两个参数都带', url2 === '/pages/tryon/tryon?style=bob&color=ashpurple', url2)

/* ================= F. 静态扫描 ================= */

console.log('\n[F] 静态扫描')

const tryonSrc = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')
const histSrc = fs.readFileSync(path.join(ROOT, 'pages/history/history.js'), 'utf8')

ck('F1 tryon 用 hasStyle 判 URL 参数', /hairstyles\.hasStyle\(options\.style\)/.test(tryonSrc))
ck('F2 tryon 用 hasColor 判 URL 参数', /hairstyles\.hasColor\(options\.color\)/.test(tryonSrc))
ck('F3 tryon 用 hasStyle 判记忆', /hairstyles\.hasStyle\(last\.style\)/.test(tryonSrc))
ck('F4 tryon 用 hasColor 判记忆', /hairstyles\.hasColor\(last\.color\)/.test(tryonSrc))
ck('F5 history 用 hasColor 判色点', /hairstyles\.hasColor\(r\.colorId\)/.test(histSrc))
ck('F6 history 跳转前判 styleId', /hasStyle\(item\.styleId\)/.test(histSrc))

// 「用 getStyle 的返回值判存在性」是个反复出现的错法：
// getStyle 永远返回一个对象，`if (!x) return` 是死代码。
const badPatterns = [
  /const\s+\w+\s*=\s*hairstyles\.getStyle\([^)]*\)\s*;\s*if\s*\(\s*!\s*\w+\s*\)/,
  /const\s+\w+\s*=\s*hairstyles\.getColor\([^)]*\)\s*;\s*if\s*\(\s*!\s*\w+\s*\)/
]
const pageFiles = []
function walk(dir) {
  fs.readdirSync(dir).forEach(function (n) {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.js$/.test(n)) pageFiles.push(p)
  })
}
walk(path.join(ROOT, 'pages'))
const bad = []
pageFiles.forEach(function (f) {
  const s = fs.readFileSync(f, 'utf8')
  badPatterns.forEach(function (re) {
    if (re.test(s)) bad.push(path.relative(ROOT, f))
  })
})
ck('F7 没有「拿 getStyle 返回值判存在性」的死代码', bad.length === 0, bad.join(','))

ck('F8 store 导出了 getLastPick/saveLastPick', typeof store.getLastPick === 'function' && typeof store.saveLastPick === 'function')

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
