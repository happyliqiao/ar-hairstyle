/**
 * 「按人脸自动匹配」第 6 轮复核（真人使用视角）
 *
 * 上一轮（face-match.js）解决的是「有没有」：引擎、接线、不谎报、
 * 曝光翻档、快门竞态。这一轮专门找**功能在真实使用中静默失效**的地方 ——
 * 五个问题都不是「算错了」，而是「该给结论的时候一声不吭」：
 *
 *   N 站得最稳的用户反而拿不到推荐（退化检测把「稳」当成「框被正方形化」）
 *   P 进页面时转了下头 → 4 次重试用尽 → 整个会话再也不匹配
 *   Q 暗光下第一轮采不到肤色 → 发色匹配永久消失
 *   R 自动换上的款排在锚点左边 → 条上没有一张高亮，用户不知道换成了什么
 *   S 一个脸型只给一个答案，且把 0.6 的置信度说成 100%
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const match = require(path.join(ROOT, 'utils/match.js'))
const swipe = require(path.join(ROOT, 'utils/swipe-guard.js'))
const hairstyles = require(path.join(ROOT, 'utils/hairstyles.js'))

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

/* ================= N 退化检测不能把「稳」当「假」 ================= */

console.log('\n[N] 稳定的人脸不能被判成「框被正方形化」')

function estimatorOf(w, h, n, jitter) {
  const e = match.createShapeEstimator()
  for (let i = 0; i < n; i++) {
    const dx = jitter ? ((i % 3) - 1) * jitter : 0
    e.push({ rawW: w + dx, rawH: h }, { rel: 1 })
  }
  return e.get()
}

const n1 = estimatorOf(156, 200, 20, 1)
ck('N1 稳定标准脸（宽高比 0.78，±1 抖动，20 帧）→ 给结论，不判退化',
  n1.ready === true && n1.degenerate === false && n1.shape === 'oval', JSON.stringify(n1))

const n2 = estimatorOf(156, 200, 20, 0)
ck('N2 一帧都不抖（完全静止）→ 仍然给结论（改之前这里判退化）',
  n2.ready === true && n2.shape === 'oval', JSON.stringify(n2))

const n3 = estimatorOf(150, 150, 20, 0)
ck('N3 真·正方形化（宽高比恒为 1）→ 仍然放弃判定',
  n3.degenerate === true && n3.ready === false, JSON.stringify(n3))

const n4 = estimatorOf(150, 151, 20, 1)
ck('N4 正方形化 + 轻微抖动（0.99~1.01）→ 仍然放弃（值接近 1 才算退化）',
  n4.degenerate === true && n4.ready === false, JSON.stringify(n4))

const n5 = estimatorOf(176, 190, 20, 1)
ck('N5 稳定的圆脸 → 偏圆', n5.ready && n5.shape === 'round', JSON.stringify(n5))

const n6 = estimatorOf(130, 200, 20, 1)
ck('N6 稳定的长脸 → 偏长', n6.ready && n6.shape === 'long', JSON.stringify(n6))

/* ================= 页面脚手架 ================= */

const timers = []
let timerSeq = 1
const state = { handlers: {}, setDataCount: 0, toasts: [], store: {} }

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
function roundAnchor() { return anchor(160, 205, 176, 190, { angle: 0 }) }
function longAnchor() { return anchor(170, 200, 130, 200, { angle: 0 }) }

function loadPage() {
  timers.length = 0
  state.setDataCount = 0
  state.toasts.length = 0
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = env.__page
  const inst = {}
  Object.keys(po).forEach(k => { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) {
    state.setDataCount++
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
  // 款式列表：wxml 里 id="st-{{item.id}}"，锚点必须指向真实存在的项
  inst.data.styles = hairstyles.HAIR_STYLES.map(function (s) {
    return { id: s.id, name: s.name, thumb: '' }
  })
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
  return buf
}

/* ================= P 测不出不许永久放弃 ================= */

console.log('\n[P] 测不出 ≠ 永久关闭')

// 场景：进页面时用户正转头（只有 4 帧正脸，其余侧脸），重试链跑完
const p1 = loadPage()
for (let i = 0; i < 4; i++) p1.onFaceAnchor(roundAnchor())
fireTimers(600)   // 第一次等 600ms → 不够 6 帧 → 进重试链
for (let i = 0; i < 4; i++) fireTimers(700)
ck('P1 正脸帧不够 + 重试 4 次 → 先不吭声（不编脸型）',
  p1.data.rec.show === false, JSON.stringify({ show: p1.data.rec.show }))
ck('P2 但**没有**标记为「已完成」—— 功能还开着',
  p1._recDone === false, String(p1._recDone))

// 用户把脸摆正了
feed(p1, 8, roundAnchor)
ck('P3 摆正脸之后立刻给出结论（不需要再等一轮定时器）',
  p1.data.rec.show === true && p1.data.rec.shape === 'round',
  JSON.stringify({ show: p1.data.rec.show, shape: p1.data.rec.shape }))
ck('P4 给出结论之后才标记完成，不会反复换款', p1._recDone === true)

// 场景：刚举起手机（正脸 4 帧，不够 6 帧）→ 转侧脸看效果（20 帧）
// → 重试链跑完 → 再转回正脸
const p2 = loadPage()
for (let i = 0; i < 4; i++) p2.onFaceAnchor(roundAnchor())
for (let i = 0; i < 20; i++) p2.onFaceAnchor(anchor(170, 200, 120, 200, { angle: 0 }))
fireTimers(600)
for (let i = 0; i < 4; i++) fireTimers(700)
const p2Before = p2.data.rec.show
feed(p2, 8, roundAnchor)
fireTimers(600)
ck('P5 转侧脸看完再转回来 → 结论补上了（侧脸帧不算数，转正后立刻匹配）',
  p2Before === false && p2.data.rec.show === true,
  JSON.stringify({ before: p2Before, after: p2.data.rec.show }))

// 用户主动收起 = 真的不要再打扰他
const p3 = loadPage()
feed(p3, 8, roundAnchor)
fireTimers(600)
p3.dismissRec()
feed(p3, 20, roundAnchor)
fireTimers(5000)
// 第 7 轮改：× = 收成小条 + 不再自动改动，但入口留着（见 face-match-3 的 U 组）
ck('P6 用户主动收起后，即使再对齐也不再弹（这条才是「用户说不」）',
  p3.data.rec.expanded === false && p3._recDone === true && p3.data.rec.declined === true)

/* ================= Q 肤色采样失败要能重来 ================= */

console.log('\n[Q] 肤色采不到时要能重来')

const q1 = loadPage()
q1._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
q1.camCtx = {
  onCameraFrame(cb) {
    // 画面里没有皮肤（全是背景色），12 帧都筛不出一个采样点
    for (let i = 0; i < 12; i++) cb({ width: 64, height: 64, data: skinFrame(64, 64, { r: 120, g: 140, b: 150 }) })
    return { stop() {} }
  }
}
q1.startSkinSample()
ck('Q1 一轮采不到 → 不编发色，但采样开关复位（可以再试）',
  q1.data.rec.colorName === '' && q1._skinStarted === false,
  JSON.stringify({ color: q1.data.rec.colorName, started: q1._skinStarted }))
ck('Q2 已经排了一轮重试', q1._skinRetryTimer !== null, String(q1._skinRetryTimer))
ck('Q3 重试期间卡片保持「正在测肤色」，不装死', q1.data.rec.skinBusy === true)

// 用户往窗边挪了两步：这次有皮肤了
q1.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrame(64, 64, { r: 108, g: 68, b: 48 }) })
    return { stop() {} }
  }
}
fireTimers(2500)
ck('Q4 2.5 秒后重试成功 → 给出肤色和发色',
  q1.data.rec.skinLabel === '偏深' && q1.data.rec.colorId !== '',
  JSON.stringify({ skin: q1.data.rec.skinLabel, color: q1.data.rec.colorId }))
ck('Q5 采到之后不再重试', q1._skinRetryTimer === null && q1.data.rec.skinBusy === false)

// 一直采不到：最多 3 轮，之后收手，不许无限读帧
const q2 = loadPage()
q2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
q2.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 12; i++) cb({ width: 64, height: 64, data: skinFrame(64, 64, { r: 120, g: 140, b: 150 }) })
    return { stop() {} }
  }
}
q2.startSkinSample()
fireTimers(1600)
fireTimers(2500)
fireTimers(2500)
fireTimers(2500)
ck('Q6 三轮都失败 → 收手（不无限常开帧监听）', q2._skinTries === 3 && q2._skinRetryTimer === null,
  JSON.stringify({ tries: q2._skinTries, timer: q2._skinRetryTimer }))
ck('Q7 最终没采到 → 「正在测」收掉，也不编发色',
  q2.data.rec.skinBusy === false && q2.data.rec.colorName === '')

// 守卫顺序：人脸框还没算出来时不能把开关焊死
const q3 = loadPage()
q3._faceRect = null
q3.startSkinSample()
ck('Q8 人脸框还没算出来时不置「已采样」标志（原来这里会把功能焊死）',
  q3._skinStarted === false, String(q3._skinStarted))

// 离开页面要清掉重试定时器
const q4 = loadPage()
q4._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
q4.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 12; i++) cb({ width: 64, height: 64, data: skinFrame(64, 64, { r: 120, g: 140, b: 150 }) })
    return { stop() {} }
  }
}
q4.startSkinSample()
q4.onUnload()
ck('Q9 离开页面清掉肤色重试定时器', q4._skinRetryTimer === null)

/* ================= R 换上了，就要看得见 ================= */

console.log('\n[R] 自动换上的款必须在横滑条里看得见')

const r1 = loadPage()
feed(r1, 8)          // 标准脸 → 首选 crop（第 2 张，在默认锚点 bob 的左边）
fireTimers(600)
ck('R1 标准脸自动换成短碎发', r1.data.currentStyle === 'crop', r1.data.currentStyle)
ck('R2 款式条锚点跟着走到短碎发（原来停在波波头，高亮项滚出视野）',
  r1.data.stripAnchor === 'st-crop', r1.data.stripAnchor)
ck('R3 锚点指向的卡片真实存在',
  r1.data.styles.some(function (s) { return 'st-' + s.id === r1.data.stripAnchor }), r1.data.stripAnchor)

const r2 = loadPage()
r2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
r2.data.rec = Object.assign({}, r2.data.rec, { show: true, expanded: true })
r2.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrame(64, 64, { r: 108, g: 68, b: 48 }) })
    return { stop() {} }
  }
}
r2.startSkinSample()
ck('R4 深肤色自动换成自然黑', r2.data.currentColor === 'black', r2.data.currentColor)
ck('R5 色带锚点跟着走到自然黑（原来是栗棕，高亮项在左边之外）',
  r2.data.colorAnchor === 'cl-black', r2.data.colorAnchor)

// 用户自己点条上的卡片：不许把刚点的那张甩到最左边
const r3 = loadPage()
feed(r3, 8, roundAnchor)
fireTimers(600)
r3.collapseRec()
const anchorBefore = r3.data.stripAnchor
r3.pickStyle({ currentTarget: { dataset: { id: 'curly' } } })
ck('R6 用户亲手点卡片时不重设锚点（否则刚点的那张会被甩到最左边）',
  r3.data.stripAnchor === anchorBefore, anchorBefore + ' → ' + r3.data.stripAnchor)

// 「换成这款」在卡片里点：卡片收起后条要能定位到它
const r4 = loadPage()
r4._explicitStyle = true
r4.data.currentStyle = 'wavy'
r4.data.stripAnchor = 'st-wavy'
feed(r4, 8, longAnchor)
fireTimers(600)
r4.useRecStyle()
ck('R7 点「换成这款」后锚点指向推荐款', r4.data.stripAnchor === 'st-' + r4.data.rec.styleId,
  r4.data.stripAnchor + ' vs ' + r4.data.rec.styleId)

/* ================= S 备选与置信度 ================= */

console.log('\n[S] 一个脸型不能只有一个答案')

const s1 = loadPage()
feed(s1, 8, roundAnchor)
fireTimers(600)
const alt1 = s1.data.rec.alt || []
ck('S1 推荐里带备选（≥2 项）', alt1.length >= 2, String(alt1.length))
ck('S2 第一项就是当前推荐', alt1[0] && alt1[0].id === s1.data.rec.styleId,
  (alt1[0] && alt1[0].id) + ' vs ' + s1.data.rec.styleId)
ck('S3 备选都是「也合适」的（适配分 ≥2），不是凑数',
  alt1.every(function (a) {
    const row = match.rankStyles('round').filter(function (x) { return x.id === a.id })[0]
    return row && row.score >= 2
  }), JSON.stringify(alt1.map(function (a) { return a.id })))
ck('S4 三种脸型都有备选', ['round', 'oval', 'long'].every(function (sh) {
  const r = match.rankStyles(sh)
  return r.filter(function (x) { return x.score >= 2 }).length >= 2
}))

const s2 = loadPage()
feed(s2, 8, roundAnchor)
fireTimers(600)
const firstId = s2.data.rec.styleId
s2.nextRecStyle()
ck('S5 点「换一款」换到第 2 名并真的应用', s2.data.currentStyle === s2.data.rec.alt[1].id,
  s2.data.currentStyle + ' (first=' + firstId + ')')
ck('S6 换过之后标题是「已换上」，理由同步换成新款的理由',
  s2.data.rec.auto === true && s2.data.rec.same === false && s2.data.rec.reason.length > 4,
  JSON.stringify({ auto: s2.data.rec.auto, same: s2.data.rec.same }))
s2.nextRecStyle()
s2.nextRecStyle()
ck('S7 轮完一圈回到第 1 名（不会卡在最后一项）',
  s2.data.rec.styleId === firstId, s2.data.rec.styleId)

// 置信度：边界值必须说「接近标准」，不能报成 100% 的标准脸
const s3 = loadPage()
for (let i = 0; i < 10; i++) s3.onFaceAnchor(anchor(162, 200, 169, 200, { angle: 0 }))  // 0.845
fireTimers(600)
ck('S8 宽高比 0.845（贴圆脸线）→ 标签是「接近标准」而不是「标准」',
  s3.data.rec.shapeLabel === '接近标准', s3.data.rec.shapeLabel)
ck('S9 同时标记 shapeUnsure，卡片上说明「在边界上」', s3.data.rec.shapeUnsure === true)

const s4 = loadPage()
feed(s4, 8, roundAnchor)
fireTimers(600)
s4.pickShape({ currentTarget: { dataset: { shape: 'long' } } })
ck('S10 用户亲手点脸型 → 用确定的标签，不再标「边界」',
  s4.data.rec.shapeLabel === '偏长' && s4.data.rec.shapeUnsure === false,
  s4.data.rec.shapeLabel + '/' + s4.data.rec.shapeUnsure)

/* ================= 静态接线 ================= */

console.log('\n[T] 界面接线')

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxss'), 'utf8')

ck('T1 卡片有「换一款」按钮且绑定了处理函数',
  /catchtap="nextRecStyle"/.test(wxml) && /nextRecStyle\s*\(/.test(fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')))
ck('T2 只在有备选时才显示「换一款」', /rec\.alt\.length > 1/.test(wxml))
ck('T3 边界脸型在卡片上明说', /rec\.shapeUnsure \?/.test(wxml) && /脸型在边界上/.test(wxml))
ck('T4 「换一款」与「换成这款」之间有视觉分隔', /\.rec-next \{/.test(wxss))
ck('T5 款式条 id 与锚点前缀一致', /id="st-\{\{item\.id\}\}"/.test(wxml) && /scroll-into-view="\{\{stripAnchor\}\}"/.test(wxml))
ck('T6 色带 id 与锚点前缀一致', /id="cl-\{\{item\.id\}\}"/.test(wxml) && /scroll-into-view="\{\{colorAnchor\}\}"/.test(wxml))

/* ================= 收尾 ================= */

console.log('\n----------------------------------------')
console.log(pass + ' 通过 / ' + (pass + fail) + ' 项')
if (fail) {
  console.log('\n失败项:')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
