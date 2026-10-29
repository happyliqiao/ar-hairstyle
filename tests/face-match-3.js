/**
 * 「按人脸自动匹配」第 7 轮复核（真人使用视角）
 *
 * 前两轮解决的是「有没有」和「静默失效」。这一轮盯的是**用户表态之后**
 * 发生的事 —— 匹配本身已经算得对了，坏在「他说了话，系统没听见」：
 *
 *   U 点了 ×（不用了）→ 迟到的肤色结果照样把发色换掉，而且卡片已经消失
 *   V 认真接受推荐（点「换成这款」）→ 下次进来 AI 再也不动了
 *   W 卡片 7 秒收起 → 发色结果晚到，颜色变了但小条上只字未提
 *   X 用户正在微调 → 推荐落地，换款 + 把他刚调好的 150% 复位成 100%
 *   Y 切到后置摄像头 → 卡片还挂着「已换上」，切回前置也不再重新匹配
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const match = require(path.join(ROOT, 'utils/match.js'))
const swipe = require(path.join(ROOT, 'utils/swipe-guard.js'))
const hairstyles = require(path.join(ROOT, 'utils/hairstyles.js'))
const store = require(path.join(ROOT, 'utils/store.js'))

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

/* ================= 页面脚手架 ================= */

const timers = []
let timerSeq = 1
const state = { handlers: {}, toasts: [], store: {} }

function fireTimers(ms) {
  const fired = []
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].ms <= ms) { const t = timers[i]; timers.splice(i, 1); fired.push(t) }
  }
  fired.reverse().forEach(t => t.fn())
  return fired.length
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
  getStorageSync(k) { return state.store[k] || '' },
  setStorageSync(k, v) { state.store[k] = v },
  removeStorageSync(k) { delete state.store[k] },
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 2, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getFileSystemManager() {
    return {
      getFileInfo(o) { o && o.success && o.success({ size: 300 * 1024 }) },
      saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://p.jpg' }) },
      removeSavedFile(o) { o && o.success && o.success({}) }
    }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() {
    return {
      onCameraFrame() { return { stop() {} } },
      takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/x.jpg' }) }
    }
  },
  createVKSession() {
    return { on(n, fn) { state.handlers[n] = fn }, start(cb) { cb && cb(0) }, destroy() {} }
  },
  createSelectorQuery() {
    const q = {
      select() { return q }, selectAll() { return q }, fields() { return q },
      boundingClientRect() { return q }, in() { return q },
      exec(cb) { cb && cb([{ node: { width: 750, height: 1334, getContext() { return makeCtx() }, createImage() { return {} } }, width: 375, height: 667 }]) }
    }
    return q
  },
  canvasToTempFilePath(o) { o && o.success && o.success({ tempFilePath: '/tmp/c.jpg' }) },
  showToast(o) { state.toasts.push(o && o.title) }, hideLoading() {}, showLoading() {}, showModal() {}, vibrateShort() {}
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

global.wx = wx
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const env = {
  wx: wx,
  Page(o) { env.__page = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false }, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout(fn, ms) { const id = timerSeq++; timers.push({ id, fn, ms }); return id },
  clearTimeout(id) { for (let i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return } },
  setInterval() { return 0 },
  clearInterval() {}
}
env.__page = null
Object.keys(env).forEach(k => { global[k] = env[k] })

function anchor(ox, oy, w, h, extra) {
  const a = { origin: { x: ox, y: oy }, size: { width: w, height: h } }
  if (extra) Object.keys(extra).forEach(k => { a[k] = extra[k] })
  return a
}
function faceAnchor() { return anchor(162, 200, 156, 200, { angle: 0 }) }

function loadPage() {
  timers.length = 0
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = env.__page
  const inst = {}
  Object.keys(po).forEach(k => { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) {
    Object.keys(p || {}).forEach(k => { inst.data[k] = p[k] })
    cb && cb()
  }
  inst._alive = true
  inst.cw = 375
  inst.ch = 667
  inst.ctx = makeCtx()
  inst.frameSize = { w: 480, h: 640 }
  inst.data.cameraReady = true
  inst.data.isDevtools = false
  inst.data.mirrorX = false
  inst.data.guide = { show: true, cx: 187.5, cy: 266.8, w: 225, h: 274.5, state: 'idle', hint: '', hidden: false }
  inst.data.styles = hairstyles.HAIR_STYLES.map(function (s) { return { id: s.id, name: s.name, thumb: '' } })
  inst._explicitStyle = false
  inst._explicitColor = false
  inst._hasLastPick = false
  inst._userPickedStyle = false
  inst._userPickedColor = false
  inst._shape = match.createShapeEstimator()
  inst._recDone = false
  inst._recTimer = null
  inst._recTries = 0
  inst._recAltIdx = 0
  inst._recPending = false
  inst._faceRect = null
  inst._skinStarted = false
  inst._skinTries = 0
  inst._skinRetryTimer = null
  inst._stripSwipe = swipe.create()
  inst._colorSwipe = swipe.create()
  return inst
}

function feed(p, n, mk) {
  for (let i = 0; i < n; i++) p.onFaceAnchor((mk || faceAnchor)())
}

function skinFrame(w, h, rgb) {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = rgb.r
    buf[i * 4 + 1] = rgb.g
    buf[i * 4 + 2] = rgb.b
    buf[i * 4 + 3] = 255
  }
  return { width: w, height: h, data: buf }
}

const DEEP_SKIN = { r: 108, g: 62, b: 44 }

/* ================= U 说了「不用了」就别再动他 ================= */

console.log('\n[U] 点 × 之后，迟到的肤色结果不许再改发色')

const u1 = loadPage()
feed(u1, 8)
fireTimers(600)
ck('U1 先确认卡片已经出来了', u1.data.rec.show === true && u1.data.rec.expanded === true,
  JSON.stringify({ show: u1.data.rec.show, expanded: u1.data.rec.expanded }))

u1.dismissRec()
ck('U2 点 × 收成小条：卡片收起，但入口还在（手滑也找得回来）',
  u1.data.rec.show === true && u1.data.rec.expanded === false && u1._recDone === true,
  JSON.stringify({ show: u1.data.rec.show, expanded: u1.data.rec.expanded, done: u1._recDone }))

const u1Color = u1.data.currentColor
u1.applySkin(match.classifySkin(DEEP_SKIN))
ck('U3 点 × 之后肤色结果到达 → 发色不变（他刚说了不用）',
  u1.data.currentColor === u1Color,
  JSON.stringify({ before: u1Color, after: u1.data.currentColor }))
ck('U4 但建议照样写出来：只展示，不替他换',
  u1.data.rec.colorName === '自然黑', JSON.stringify({ colorName: u1.data.rec.colorName }))

u1.expandRec()
ck('U5 小条点得开（结论没丢）', u1.data.rec.expanded === true)

// 小条不能变成永久占位：用户自己动手之后就该退场
const u3 = loadPage()
feed(u3, 8)
fireTimers(600)
u3.dismissRec()
u3.pickStyle({ currentTarget: { dataset: { id: 'wavy' } } })
ck('U7 点过 × 之后再自己挑款 → 小条退场（不长期占那 30pt）',
  u3.data.rec.show === false, String(u3.data.rec.show))

const u4 = loadPage()
feed(u4, 8)
fireTimers(600)
u4.dismissRec()
u4.pickColor({ currentTarget: { dataset: { id: 'flaxen' } } })
ck('U8 点过 × 之后再自己挑色 → 小条同样退场', u4.data.rec.show === false)

// 完整异步路径：采样还在飞的时候点 ×，帧回来之后 finish
const u2 = loadPage()
feed(u2, 8)
fireTimers(600)
u2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
u2._skinStarted = false
u2._skinTries = 0
let skinCb = null
u2.camCtx = { onCameraFrame(cb) { skinCb = cb; return { stop() {} } } }
u2.startSkinSample()
u2.dismissRec()
const u2Color = u2.data.currentColor
if (skinCb) {
  for (let i = 0; i < 3; i++) skinCb(skinFrame(64, 64, DEEP_SKIN))
}
ck('U6 采样在飞时点 ×：结果回来也不改发色（这条是原来最典型的顺序）',
  u2.data.currentColor === u2Color,
  JSON.stringify({ before: u2Color, after: u2.data.currentColor }))

/* ================= V 接受推荐 ≠ 关掉推荐 ================= */

console.log('\n[V] 接受 AI 的推荐，不能把 AI 关掉')

state.store = {}
const v1 = loadPage()
feed(v1, 8)
fireTimers(600)
v1.useRecStyle()
const saved1 = JSON.parse(state.store.arhair_last_pick_v1 || '{}')
ck('V1 点「换成这款」记下来了，来源标成 rec',
  saved1.style === 'crop' && saved1.by === 'rec', JSON.stringify(saved1))

// 下次进页面：真的走一遍 onLoad，而不是在测试里重算一遍条件
const v2 = loadPage()
let onLoadOk = true
try { v2.onLoad({}) } catch (e) { onLoadOk = false; console.log('    onLoad 抛错: ' + e.message) }
ck('V2 上次是「接受推荐」→ 不算表过态，自动匹配照常可用',
  onLoadOk && v2._hasLastPick === false,
  JSON.stringify({ onLoadOk: onLoadOk, hasLastPick: v2._hasLastPick }))
ck('V3 但上次看的款照样还原（不用重新翻十款）',
  v2.data.currentStyle === 'crop', JSON.stringify({ style: v2.data.currentStyle }))

state.store = {}
const v3 = loadPage()
feed(v3, 8)
fireTimers(600)
v3.nextRecStyle()
const saved2 = JSON.parse(state.store.arhair_last_pick_v1 || '{}')
ck('V4 点「换一款」同样标成 rec', saved2.by === 'rec', JSON.stringify(saved2))

// 对照：自己横滑挑的才算表过态
state.store = {}
const v4 = loadPage()
feed(v4, 8)
fireTimers(600)
v4.pickStyle({ currentTarget: { dataset: { id: 'pompadour' } } })
const saved3 = JSON.parse(state.store.arhair_last_pick_v1 || '{}')
ck('V5 自己横滑挑的款标成 user', saved3.by === 'user' && saved3.style === 'pompadour', JSON.stringify(saved3))
const v5 = loadPage()
try { v5.onLoad({}) } catch (e) {}
ck('V6 自己挑过 → 下次只推荐不替换（这条不能改）', v5._hasLastPick === true, String(v5._hasLastPick))

/* ================= W 收起态也要看得到发色 ================= */

console.log('\n[W] 卡片收起后，小条上要有发色')

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxss'), 'utf8')

ck('W1 小条里渲染发色（rec.colorName）',
  /rec-mini-text[\s\S]{0,220}rec\.colorName/.test(wxml) && /rec-mini-color/.test(wxml))
ck('W2 小条永远单行（加长之后不许换行把面板顶高）',
  /\.rec-mini-text\s*\{[^}]*white-space:\s*nowrap/.test(wxss) &&
  /\.rec-mini-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(wxss))
ck('W3 小条的读屏文案也带发色',
  /aria-label="展开脸型匹配结果[^"]*rec\.colorName/.test(wxml))

const w1 = loadPage()
feed(w1, 8)
fireTimers(600)
fireTimers(7000)
ck('W4 7 秒后确实收成小条', w1.data.rec.expanded === false)
w1.applySkin(match.classifySkin(DEEP_SKIN))
ck('W5 晚到的发色结论写进 rec，收起态也读得到',
  w1.data.rec.colorName === '自然黑' && w1.data.rec.expanded === false,
  JSON.stringify({ color: w1.data.rec.colorName, expanded: w1.data.rec.expanded }))

/* ================= X 微调中不许换款 ================= */

console.log('\n[X] 用户正在微调时，推荐必须让路')

const x1 = loadPage()
x1.toggleAdjust()
x1.sizeVal = 150
x1.yVal = 62
x1.rotVal = 6
x1.setData({ sizeVal: 150, yVal: 62, rotVal: 6 })
feed(x1, 8)
fireTimers(600)
ck('X1 微调中不换款（当前还是默认的波波头）',
  x1.data.currentStyle === 'bob', x1.data.currentStyle)
ck('X2 刚调好的大小/位置没被复位',
  x1.data.sizeVal === 150 && x1.data.yVal === 62 && x1.data.rotVal === 6,
  JSON.stringify({ size: x1.data.sizeVal, y: x1.data.yVal, rot: x1.data.rotVal }))
ck('X3 微调中不展开卡片（卡片在 adjustMode 下本来就不渲染）',
  x1.data.rec.expanded === false && x1.data.rec.show === false)
ck('X4 但记下了「待算」，没把结论丢掉', x1._recPending === true)
ck('X5 也没白烧重试预算（收起微调后仍有一次完整机会）',
  x1._recTries === 0, String(x1._recTries))

x1.toggleAdjust()
fireTimers(600)
ck('X6 收起微调后补算：换上了推荐款', x1.data.currentStyle === 'crop', x1.data.currentStyle)
ck('X7 卡片这时候才出来', x1.data.rec.show === true && x1.data.rec.expanded === true)
ck('X8 待算标记清掉了', x1._recPending === false)

// 反过来：卡片已经展开时进微调，卡片必须让位
const x2 = loadPage()
feed(x2, 8)
fireTimers(600)
ck('X9 前置：卡片展开着', x2.data.rec.expanded === true)
x2.toggleAdjust()
ck('X10 进微调后卡片收起，微调面板不被卡片顶掉', x2.data.rec.expanded === false)

/* ================= Y 换摄像头 = 换一张脸 ================= */

console.log('\n[Y] 切摄像头后，旧结论必须作废')

const y1 = loadPage()
feed(y1, 8)
fireTimers(600)
ck('Y1 前置下给出了结论', y1.data.rec.show === true && y1._recDone === true)

y1.switchCamera()
ck('Y2 切到后置：卡片立刻消失（后置画面里没有脸，不能挂着「已换上」）',
  y1.data.rec.show === false, String(y1.data.rec.show))
ck('Y3 匹配状态复位（_recDone / 重试次数 / 采样次数）',
  y1._recDone === false && y1._recTries === 0 && y1._skinStarted === false && y1._skinTries === 0,
  JSON.stringify({ done: y1._recDone, tries: y1._recTries, skinStarted: y1._skinStarted, skinTries: y1._skinTries }))

y1.switchCamera()
y1.frameSize = { w: 480, h: 640 }
feed(y1, 8)
fireTimers(600)
ck('Y4 切回前置后重新匹配（不是拿着几分钟前那次结论）',
  y1.data.rec.show === true && y1._recDone === true,
  JSON.stringify({ show: y1.data.rec.show, done: y1._recDone }))

// 采样在飞时切摄像头：旧摄像头的帧不许改发色
const y2 = loadPage()
feed(y2, 8)
fireTimers(600)
y2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
y2._skinStarted = false
y2._skinTries = 0
let oldCb = null
y2.camCtx = { onCameraFrame(cb) { oldCb = cb; return { stop() {} } } }
y2.startSkinSample()
const y2Color = y2.data.currentColor
y2.switchCamera()
if (oldCb) for (let i = 0; i < 3; i++) oldCb(skinFrame(64, 64, DEEP_SKIN))
ck('Y5 切摄像头前发出的采样，回来后作废（不拿旧镜头的光线改发色）',
  y2.data.currentColor === y2Color,
  JSON.stringify({ before: y2Color, after: y2.data.currentColor }))

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项'))
console.log('  ' + pass + ' / ' + (pass + fail))
if (fail) {
  console.log('\n失败明细:')
  failures.forEach(f => console.log('  - ' + f))
  process.exitCode = 1
}
