/**
 * 横滑条的定位锚点（第 47 轮）
 *
 * 试戴页底部有两条横滑：10 款发型、12 个发色。两条都默认停在最左边。
 *
 * 从「我的收藏」点一款进来、或者从朋友分享的卡片进来、或者上次用的
 * 是马尾 —— 这三种情况下选中的往往排在第 8、9 位，横滑条却还在 x=0。
 * 结果画面上是马尾，底部高亮着最左边的波波头：
 * 用户会以为自己点错了，或者以为收藏跳错了款。
 *
 * 更隐蔽的是**发色**：12 个色里「樱花粉」在最后一位，选中它的时候
 * 色条上根本看不到任何一个高亮框。
 *
 * 这一轮验证：
 *   A. 进页面时锚点跟着当前款/当前色走
 *   B. 用户自己点卡片时不重设锚点（否则会把刚点的那张甩到最左边）
 *   C. 模板里 scroll-view 挂了 scroll-into-view，卡片 id 与锚点对得上
 *   D. 每一款/每一个色都有 id（不能只有前几个能定位）
 *   E. 静态：锚点只在 onLoad 里赋值
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

function reset() {
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
  getStorageInfoSync() { return { keys: Object.keys(storage) } },
  getWindowInfo() { return { statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getPrivacySetting(o) { o && o.success && o.success({ needAuthorization: false }) },
  getFileSystemManager() {
    return {
      getFileInfo(o) { o && o.success && o.success({ size: 1024 }) },
      saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) },
      removeSavedFile(o) { o && o.success && o.success({}) },
      getSavedFileList(o) { o && o.success && o.success({ fileList: [] }) }
    }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() { return { onCameraFrame() { return { stop() {} } }, takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/s.jpg' }) } } },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
    return q
  },
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
  vibrateShort() {}, setKeepScreenOn() {},
  navigateTo(o) { o && o.success && o.success({}) }
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

const hairstyles = require(path.join(ROOT, 'utils/hairstyles'))
const swipe = require(path.join(ROOT, 'utils/swipe-guard'))

function bootTryon(options) {
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
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
  inst._stripSwipe = swipe.create()
  inst._colorSwipe = swipe.create()
  inst.data.isDevtools = false
  inst.onLoad(options || {})
  return inst
}

/* ================= A. 进页面时的锚点 ================= */

console.log('\n[A] 进页面时锚点跟着当前款走')

reset()
let t = bootTryon({})
ck('A1 默认款锚点是 st-bob', t.data.stripAnchor === 'st-bob', t.data.stripAnchor)
ck('A2 默认色锚点是 cl-chestnut', t.data.colorAnchor === 'cl-chestnut', t.data.colorAnchor)

reset()
t = bootTryon({ style: 'ponytail' })
ck('A3 第 9 款马尾：锚点跟着走', t.data.stripAnchor === 'st-ponytail', t.data.stripAnchor)
ck('A4 锚点和 currentStyle 一致', t.data.stripAnchor === 'st-' + t.data.currentStyle)

reset()
t = bootTryon({ color: 'sakura' })
ck('A5 最后一个发色：锚点跟着走', t.data.colorAnchor === 'cl-sakura', t.data.colorAnchor)
ck('A6 锚点和 currentColor 一致', t.data.colorAnchor === 'cl-' + t.data.currentColor)

reset()
t = bootTryon({ style: 'middle-part', color: 'blueblack' })
ck('A7 两个都指定时都对', t.data.stripAnchor === 'st-middle-part' && t.data.colorAnchor === 'cl-blueblack',
  t.data.stripAnchor + '/' + t.data.colorAnchor)

// 上次用的选择也要能定位
reset()
storage['arhair_last_pick_v1'] = { style: 'ponytail', color: 'sakura' }
t = bootTryon({})
ck('A8 上次用的款也会定位', t.data.stripAnchor === 'st-ponytail', t.data.stripAnchor)
ck('A9 上次用的色也会定位', t.data.colorAnchor === 'cl-sakura', t.data.colorAnchor)

// 失效 id 回落之后，锚点要跟着回落值，不能留在失效 id 上
reset()
storage['arhair_last_pick_v1'] = { style: 'gone', color: 'gone' }
t = bootTryon({})
ck('A10 失效款回落时锚点也跟着回落', t.data.stripAnchor === 'st-bob', t.data.stripAnchor)
ck('A11 失效色回落时锚点也跟着回落', t.data.colorAnchor === 'cl-chestnut', t.data.colorAnchor)

/* ================= B. 点卡片不重设锚点 ================= */

console.log('\n[B] 用户点卡片时不重设锚点')

reset()
t = bootTryon({ style: 'bob' })
const before = t.data.stripAnchor
t.pickStyle({ currentTarget: { dataset: { id: 'ponytail' } } })
ck('B1 点第 9 款：当前款变了', t.data.currentStyle === 'ponytail', t.data.currentStyle)
ck('B2 锚点没变（不会把刚点的那张甩到最左边）', t.data.stripAnchor === before, t.data.stripAnchor)

const beforeColor = t.data.colorAnchor
t.pickColor({ currentTarget: { dataset: { id: 'sakura' } } })
ck('B3 点最后一个色：当前色变了', t.data.currentColor === 'sakura', t.data.currentColor)
ck('B4 色卡锚点也没变', t.data.colorAnchor === beforeColor, t.data.colorAnchor)

/* ================= C. 模板 ================= */

console.log('\n[C] 模板绑定')

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')

ck('C1 发型条挂了 scroll-into-view', /scroll-into-view="\{\{stripAnchor\}\}"/.test(wxml))
ck('C2 色卡挂了 scroll-into-view', /scroll-into-view="\{\{colorAnchor\}\}"/.test(wxml))
ck('C3 发型卡片有 id="st-{{item.id}}"', /id="st-\{\{item\.id\}\}"/.test(wxml))
ck('C4 色卡有 id="cl-{{item.id}}"', /id="cl-\{\{item\.id\}\}"/.test(wxml))
ck('C5 两条都关掉了滚动动画（进页面时不该看到横滑条自己跑）',
  (wxml.match(/scroll-with-animation="\{\{false\}\}"/g) || []).length === 2,
  String((wxml.match(/scroll-with-animation="\{\{false\}\}"/g) || []).length))

// id 必须在 wx:for 里（每一张都有），不能在 for 外面
const stripBlock = wxml.slice(wxml.indexOf('class="strip-inner"'), wxml.indexOf('class="strip-inner"') + 900)
ck('C6 发型 id 在 wx:for 循环体内', stripBlock.indexOf('wx:for') >= 0 && stripBlock.indexOf('id="st-') > stripBlock.indexOf('wx:for'))
const colorBlock = wxml.slice(wxml.indexOf('class="color-inner"'), wxml.indexOf('class="color-inner"') + 900)
ck('C7 色卡 id 在 wx:for 循环体内', colorBlock.indexOf('wx:for') >= 0 && colorBlock.indexOf('id="cl-') > colorBlock.indexOf('wx:for'))

/* ================= D. 覆盖所有款/色 ================= */

console.log('\n[D] 每一款都能定位')

let okStyle = true
for (let i = 0; i < hairstyles.HAIR_STYLES.length; i++) {
  const id = hairstyles.HAIR_STYLES[i].id
  reset()
  const inst = bootTryon({ style: id })
  if (inst.data.stripAnchor !== 'st-' + id) { okStyle = false; break }
}
ck('D1 10 款逐款都能定位', okStyle)

let okColor = true
for (let i = 0; i < hairstyles.HAIR_COLORS.length; i++) {
  const id = hairstyles.HAIR_COLORS[i].id
  reset()
  const inst = bootTryon({ color: id })
  if (inst.data.colorAnchor !== 'cl-' + id) { okColor = false; break }
}
ck('D2 12 色逐色都能定位', okColor)

/* ================= E. 静态 ================= */

console.log('\n[E] 静态')

const js = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')
// 只数**非空**赋值：data 里的初始值 `stripAnchor: ''` 不算
const assignCount = (js.match(/stripAnchor:\s*'st-/g) || []).length
ck('E1 stripAnchor 只在 onLoad 里赋值一次', assignCount === 1, String(assignCount))
const colorCount = (js.match(/colorAnchor:\s*'cl-/g) || []).length
ck('E2 colorAnchor 只在 onLoad 里赋值一次', colorCount === 1, String(colorCount))
ck('E3 锚点前缀与模板一致（st-/cl-）',
  js.indexOf("'st-' + styleId") >= 0 && js.indexOf("'cl-' + colorId") >= 0)

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
