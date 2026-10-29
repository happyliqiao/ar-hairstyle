/**
 * 首次使用引导（第 39 轮）
 *
 * 前 38 轮打磨的都是「老用户会碰到什么」。这一轮换个维度：
 * **第一次来的人看到的是什么**。
 *
 * 他扫码 → 首页 → 点「开始试戴」，得到的是：相机画面 + 一个悬空的发型
 * + 底部一排控件。没有任何一行字告诉他：
 *   - 要把脸放进画面（他可能对着空镜头等半天，以为坏了）
 *   - 可以左右滑换款、点色卡换发色
 *   - 位置不准可以拖动、双击复位
 *
 * 之前只有「从转发卡片进来的用户」会收到一次 toast 提示，
 * 而扫码进来的（也就是绝大多数）什么都没有。
 *
 * 这一轮验证：
 *   A. 第一次进来会显示，关掉后写标记
 *   B. 第二次进来不再显示
 *   C. 标记被写坏（"1" / "true"）时不要反复骚扰老用户
 *   D. 相机没起来时不显示（对着「相机未开启」讲怎么放脸没意义）
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
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
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
  showToast() {}, showLoading() {}, hideLoading() {}, showModal() {}, vibrateShort() {}
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

function loadTryon() {
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
  inst.data.isDevtools = false
  return inst
}

function clearAll() {
  for (const k in storage) delete storage[k]
}

/* ================= A. 第一次 ================= */

console.log('\n[A] 第一次进来会看到引导')

clearAll()
ck('A1 新用户标记为未看过', store.hasSeenGuide() === false)

const p1 = loadTryon()
ck('A2 初始不显示（相机还没起来）', p1.data.guideOn === false)

p1.afterCameraReady()
ck('A3 相机就绪后显示引导', p1.data.guideOn === true)

p1.closeGuide()
ck('A4 关掉后隐藏', p1.data.guideOn === false)
ck('A5 关掉后写了标记', store.hasSeenGuide() === true)

/* ================= B. 第二次 ================= */

console.log('\n[B] 第二次不再打扰')

const p2 = loadTryon()
p2.afterCameraReady()
ck('B1 老用户进来不显示引导', p2.data.guideOn === false)

/* ================= C. 标记被写坏 ================= */

console.log('\n[C] 标记被写坏时不能反复骚扰')

const badValues = [true, 1, '1', 'true']
for (let i = 0; i < badValues.length; i++) {
  clearAll()
  storage['arhair_guide_v1'] = JSON.stringify(badValues[i])
  const p = loadTryon()
  p.afterCameraReady()
  ck('C' + (i + 1) + ' 存的是 ' + JSON.stringify(badValues[i]) + ' → 视为已看过',
    p.data.guideOn === false && store.hasSeenGuide() === true)
}

// 存的是垃圾值 → 当作没看过，再引导一次（总比永远不引导好）
clearAll()
storage['arhair_guide_v1'] = '"yes"'
ck('C5 存的是无法识别的值 → 当作没看过', store.hasSeenGuide() === false)

clearAll()
storage['arhair_guide_v1'] = '{坏掉的 json'
let c6Threw = false
let c6 = null
try { c6 = store.hasSeenGuide() } catch (e) { c6Threw = true }
ck('C6 非法 JSON 不抛异常', c6Threw === false)
ck('C7 非法 JSON 当作没看过', c6 === false)

/* ================= D. 相机没起来时不显示 ================= */

console.log('\n[D] 相机没就绪时不显示')

clearAll()
const p3 = loadTryon()
// 只走到 openCamera，不触发 afterCameraReady
p3.openCamera && p3.openCamera()
ck('D1 相机启动中不显示引导（对着「相机未开启」讲怎么放脸没意义）',
  p3.data.guideOn === false, JSON.stringify(p3.data.guideOn))

/* ================= E. 关闭的幂等与副作用 ================= */

console.log('\n[E] 关闭动作要幂等')

clearAll()
const p4 = loadTryon()
p4.afterCameraReady()
let eThrew = false
try {
  p4.closeGuide()
  p4.closeGuide()
  p4.closeGuide()
} catch (e) { eThrew = true }
ck('E1 重复关闭不抛异常', eThrew === false)
ck('E2 关闭后状态稳定', p4.data.guideOn === false)
ck('E3 标记只写一次且为 true', JSON.parse(storage['arhair_guide_v1']) === true)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '首次引导：全部通过' : '首次引导：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
