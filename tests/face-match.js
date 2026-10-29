/**
 * 「按人脸自动匹配发型 / 发色」回归测试
 *
 * 产品定义（需求方原话）：
 *   前置摄像头扫人脸 → AI 根据人脸**自动生成匹配**合适的发型以及发色。
 *
 * 改之前这个功能一行代码都没有：currentStyle 写死 'bob'、
 * currentColor 写死 'chestnut'，hairstyles 里的 face 字段只是展示文案，
 * 从不参与任何判断。也就是说「自动匹配」是零，只有「手动挑」。
 *
 * 这套测试守的是四件事：
 *   A 脸型真的被算出来了，而且只在正脸时算（侧脸会把圆脸判成长脸）
 *   B 推荐是「有依据的排序」，不是随机挑一款
 *   C 肤色真的从摄像头帧里量出来了，不是编的
 *   D 自动匹配不能抢用户的选择权
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

/* ================= A 脸型分类 ================= */

console.log('\n[A] 脸型分类（只看人脸框宽高比）')

ck('A1 明显偏宽 → 圆脸', match.classifyShape(0.92).id === 'round', match.classifyShape(0.92).id)
ck('A2 明显偏窄 → 长脸', match.classifyShape(0.62).id === 'long', match.classifyShape(0.62).id)
ck('A3 常规比例 → 标准', match.classifyShape(0.78).id === 'oval', match.classifyShape(0.78).id)
ck('A4 边界附近置信度打折（0.845 离圆脸线很近）',
  match.classifyShape(0.845).confidence < 1, JSON.stringify(match.classifyShape(0.845)))
ck('A5 脏数据不抛异常，退化成标准且置信度为 0',
  match.classifyShape(NaN).id === 'oval' && match.classifyShape(NaN).confidence === 0)
ck('A6 三种脸型都有中文标签',
  match.SHAPE_LABEL.round && match.SHAPE_LABEL.oval && match.SHAPE_LABEL.long,
  JSON.stringify(match.SHAPE_LABEL))

/* ================= B 脸型估计器 ================= */

console.log('\n[B] 脸型估计器（跨帧统计 + 侧脸门控）')

const e1 = match.createShapeEstimator()
ck('B1 一帧都不给 → 不下结论', e1.get().ready === false)

for (let i = 0; i < 3; i++) e1.push({ rawW: 156, rawH: 200 }, { rel: 1 })
ck('B2 只给 3 帧 → 还不够（阈值 6 帧）', e1.get().ready === false, 'frames=' + e1.get().frames)
for (let i = 0; i < 5; i++) e1.push({ rawW: 156, rawH: 200 }, { rel: 1 })
ck('B3 攒够 6 帧正脸 → 给结论', e1.get().ready === true, JSON.stringify(e1.get()))
ck('B4 156/200 = 0.78 → 标准脸', e1.get().shape === 'oval', e1.get().shape)

// 侧脸帧：宽度按 cos40° 收缩，高度不变
const e2 = match.createShapeEstimator()
for (let i = 0; i < 10; i++) e2.push({ rawW: 156, rawH: 200 }, { rel: 1 })
for (let i = 0; i < 10; i++) e2.push({ rawW: 156 * 0.77, rawH: 200 }, { rel: 0.77 })
ck('B5 侧脸帧被门控挡住，不把标准脸改判成长脸', e2.get().shape === 'oval', JSON.stringify(e2.get()))
ck('B6 侧脸帧不计入有效帧数', e2.get().frames === 10, 'frames=' + e2.get().frames)

const e3 = match.createShapeEstimator()
// 先侧脸再转正：窗口取最大值，不能被前面的侧脸拖低
for (let i = 0; i < 8; i++) e3.push({ rawW: 120, rawH: 200 }, { rel: 0.77 })
for (let i = 0; i < 8; i++) e3.push({ rawW: 176, rawH: 200 }, { rel: 1 })
ck('B7 窗口取最大宽高比（先侧后正，不能被侧脸拖低）',
  e3.get().shape === 'round', 'aspect=' + e3.get().aspect.toFixed(2))

const e4 = match.createShapeEstimator()
for (let i = 0; i < 16; i++) e4.push({ rawW: 150, rawH: 150 }, { rel: 1 })
ck('B8 框被正方形化（宽高比恒为 1）→ 放弃判定，不说脸型',
  e4.get().degenerate === true && e4.get().ready === false, JSON.stringify(e4.get()))

const e5 = match.createShapeEstimator()
for (let i = 0; i < 8; i++) e5.push({ rawW: 156, rawH: 200 }, { rel: 1 })
e5.reset()
ck('B9 reset 后回到未就绪（切摄像头要重来）', e5.get().ready === false)

/* ================= C 发型排序 ================= */

console.log('\n[C] 发型排序')

const roundRank = match.rankStyles('round')
const longRank = match.rankStyles('long')
const ovalRank = match.rankStyles('oval')

ck('C1 三种脸型都给出完整 10 款排序',
  roundRank.length === 10 && longRank.length === 10 && ovalRank.length === 10)
ck('C2 排序里的 id 全部真实存在',
  roundRank.every(x => hairstyles.hasStyle(x.id)))
ck('C3 每条推荐都带理由（不能是黑箱）',
  roundRank.every(x => typeof x.reason === 'string' && x.reason.length >= 6))
ck('C4 按分数降序', roundRank.every((x, i) => i === 0 || roundRank[i - 1].score >= x.score))

ck('C5 圆脸首选拉长类（背头 / 长直发）',
  ['pompadour', 'long-straight'].indexOf(roundRank[0].id) >= 0, roundRank[0].id)
ck('C6 长脸首选加宽/缩短类（齐刘海 / 波波头 / 羊毛卷）',
  ['fringe', 'bob', 'curly'].indexOf(longRank[0].id) >= 0, longRank[0].id)
ck('C7 三种脸型的首选不完全相同（否则等于没匹配）',
  new Set([roundRank[0].id, longRank[0].id, ovalRank[0].id]).size >= 2,
  [roundRank[0].id, longRank[0].id, ovalRank[0].id].join(' / '))

// 造型逻辑上的硬约束：这几条错了就是推荐本身错了
function scoreOf(rank, id) { const f = rank.filter(x => x.id === id)[0]; return f ? f.score : -1 }
ck('C8 圆脸不推齐刘海（压额头会让圆脸更短）', scoreOf(roundRank, 'fringe') === 0,
  'score=' + scoreOf(roundRank, 'fringe'))
ck('C9 长脸不推背头（顶部再加高会更长）', scoreOf(longRank, 'pompadour') === 0,
  'score=' + scoreOf(longRank, 'pompadour'))
ck('C10 圆脸不推大波浪（两侧外扩继续加宽）', scoreOf(roundRank, 'wavy') === 0,
  'score=' + scoreOf(roundRank, 'wavy'))
ck('C11 未知脸型退化成标准脸，不抛异常',
  match.bestStyle('whatever') && match.bestStyle('whatever').id === ovalRank[0].id)

/* ================= D 肤色分类 ================= */

console.log('\n[D] 肤色（CIELAB + ITA°）')

const SKINS = {
  veryLight: { r: 240, g: 214, b: 196 },
  light: { r: 226, g: 190, b: 164 },
  medium: { r: 198, g: 146, b: 112 },
  tan: { r: 150, g: 100, b: 72 },
  deep: { r: 108, g: 68, b: 48 },
  veryDeep: { r: 78, g: 50, b: 36 }
}

ck('D1 很白 → 偏白', match.classifySkin(SKINS.veryLight).depth === 'light',
  match.classifySkin(SKINS.veryLight).label)
ck('D2 中等 → 中等', match.classifySkin(SKINS.medium).depth === 'medium',
  match.classifySkin(SKINS.medium).label)
ck('D3 深 → 偏深', match.classifySkin(SKINS.deep).depth === 'deep',
  match.classifySkin(SKINS.deep).label)
ck('D4 ITA 随肤色变深单调下降',
  match.classifySkin(SKINS.veryLight).ita >
  match.classifySkin(SKINS.light).ita &&
  match.classifySkin(SKINS.light).ita >
  match.classifySkin(SKINS.medium).ita &&
  match.classifySkin(SKINS.medium).ita >
  match.classifySkin(SKINS.tan).ita &&
  match.classifySkin(SKINS.tan).ita >
  match.classifySkin(SKINS.deep).ita)
ck('D5 脏数据返回 null，不编一个肤色出来',
  match.classifySkin(null) === null && match.classifySkin({ r: NaN, g: 0, b: 0 }) === null)

/* ================= E 从摄像头帧里取肤色 ================= */

console.log('\n[E] 肤色采样（只统计像皮肤的像素）')

const FW = 100
const FH = 120

function makeFrame(fill, paint) {
  const buf = new Uint8ClampedArray(FW * FH * 4)
  for (let i = 0; i < FW * FH; i++) {
    buf[i * 4] = fill.r
    buf[i * 4 + 1] = fill.g
    buf[i * 4 + 2] = fill.b
    buf[i * 4 + 3] = 255
  }
  if (paint) paint(buf)
  return buf
}

function paintRect(buf, rect, color) {
  const x0 = Math.round(rect.x * FW)
  const y0 = Math.round(rect.y * FH)
  const x1 = Math.round((rect.x + rect.w) * FW)
  const y1 = Math.round((rect.y + rect.h) * FH)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * FW + x) * 4
      buf[i] = color.r
      buf[i + 1] = color.g
      buf[i + 2] = color.b
    }
  }
}

const FACE_RECT = { x: 0.25, y: 0.2, w: 0.5, h: 0.6 }

const skinFrame = makeFrame({ r: 120, g: 140, b: 150 }, function (buf) {
  paintRect(buf, FACE_RECT, { r: 226, g: 190, b: 164 })
})
const s1 = match.sampleSkinPixels(skinFrame, FW, FH, FACE_RECT)
ck('E1 纯肤色帧 → 采到样本', !!s1 && s1.n >= 40, s1 && ('n=' + s1.n))
ck('E2 采样值接近真实肤色（不被背景拉偏）',
  s1 && Math.abs(s1.r - 226) < 6 && Math.abs(s1.g - 190) < 6 && Math.abs(s1.b - 164) < 6,
  s1 && (Math.round(s1.r) + ',' + Math.round(s1.g) + ',' + Math.round(s1.b)))

// 框里全是背景（灰墙）：不该被当成皮肤
const wallFrame = makeFrame({ r: 120, g: 140, b: 150 })
ck('E3 框里没有皮肤 → 返回 null（不能拿背景算出肤色）',
  match.sampleSkinPixels(wallFrame, FW, FH, FACE_RECT) === null)

// 框里全是头发（很暗）：同样不该采
const hairFrame = makeFrame({ r: 30, g: 25, b: 20 })
ck('E4 框里全是头发 → 返回 null', match.sampleSkinPixels(hairFrame, FW, FH, FACE_RECT) === null)

// 只有脸颊一块是皮肤，其余是头发：要能挑出来
const mixedFrame = makeFrame({ r: 30, g: 25, b: 20 }, function (buf) {
  // 采样带是局部 y 0.50~0.70 的两块脸颊，皮肤必须画在这里
  paintRect(buf, { x: 0.18, y: 0.52, w: 0.20, h: 0.16 }, { r: 226, g: 190, b: 164 })
  paintRect(buf, { x: 0.62, y: 0.52, w: 0.20, h: 0.16 }, { r: 226, g: 190, b: 164 })
})
const s2 = match.sampleSkinPixels(mixedFrame, FW, FH, FACE_RECT)
ck('E5 头发包着脸时，只统计脸颊那块皮肤', !!s2 && s2.r > 200,
  s2 && (Math.round(s2.r) + ',' + Math.round(s2.g) + ',' + Math.round(s2.b)))

ck('E6 缓冲区长度不够时返回 null，不越界读',
  match.sampleSkinPixels(new Uint8Array(10), FW, FH, FACE_RECT) === null)
ck('E7 空 rect 返回 null', match.sampleSkinPixels(skinFrame, FW, FH, null) === null)

/* ================= F 发色排序 ================= */

console.log('\n[F] 发色排序')

const cLight = match.rankColors('light', hairstyles.HAIR_COLORS)
const cMedium = match.rankColors('medium', hairstyles.HAIR_COLORS)
const cDeep = match.rankColors('deep', hairstyles.HAIR_COLORS)

ck('F1 三种肤色都给出完整 12 色排序',
  cLight.length === 12 && cMedium.length === 12 && cDeep.length === 12)
ck('F2 排序里的 id 全部真实存在', cDeep.every(x => hairstyles.hasColor(x.id)))
ck('F3 每条都带理由', cDeep.every(x => typeof x.reason === 'string' && x.reason.length >= 8))

ck('F4 三种肤色的首选不完全相同（否则「按肤色匹配」是摆设）',
  new Set([cLight[0].id, cMedium[0].id, cDeep[0].id]).size >= 2,
  [cLight[0].id, cMedium[0].id, cDeep[0].id].join(' / '))
ck('F5 深肤色不首选浅色（银灰/樱花粉/蜂蜜金）',
  ['silver', 'sakura', 'honey', 'rosegold'].indexOf(cDeep[0].id) < 0, cDeep[0].id)

function colorScore(rank, id) { const f = rank.filter(x => x.id === id)[0]; return f ? f.score : -1 }
ck('F6 深肤色给银灰打低分（对比过强显蜡黄）', colorScore(cDeep, 'silver') <= 1,
  'score=' + colorScore(cDeep, 'silver'))
ck('F7 浅肤色给自然黑的分低于首选（浅肤配纯黑偏硬）',
  colorScore(cLight, 'black') < cLight[0].score, colorScore(cLight, 'black') + ' vs ' + cLight[0].score)
ck('F8 未知肤色退化成中等，不抛异常', match.rankColors('???', hairstyles.HAIR_COLORS).length === 12)

/* ================= G 页面流程 ================= */

console.log('\n[G] 页面流程：什么时候可以自动换、什么时候不行')

const timers = []
let timerSeq = 1
const state = { handlers: {}, setDataCount: 0, lastPick: null, toasts: [], store: {} }

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
  // 真存真取：saveLastPick 的落点必须能被验证，否则
  // 「自动换的款有没有写进历史」这类断言测不到。
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

/** 正脸锚点：宽 156 高 200 → 0.78（标准脸） */
function faceAnchor() { return anchor(162, 200, 156, 200, { angle: 0 }) }
/** 宽脸锚点：宽 176 高 190 → 0.926（圆脸） */
function roundAnchor() { return anchor(160, 205, 176, 190, { angle: 0 }) }
/** 窄脸锚点：宽 130 高 200 → 0.65（长脸） */
function longAnchor() { return anchor(170, 200, 130, 200, { angle: 0 }) }

function resetStore() { state.store = {} }

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
  // 默认当成「第一次来的用户」：没指定、没历史、没手动选
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
  // 肤色采样状态（第 6 轮加了失败重试，必须一起初始化，
  // 否则 _skinTries 是 undefined，重试分支永远走不到）
  inst._skinStarted = false
  inst._skinTries = 0
  inst._skinRetryTimer = null
  // 横滑误触状态（onLoad 里建的，这里补上）
  inst._stripSwipe = swipe.create()
  inst._colorSwipe = swipe.create()
  return inst
}

function feed(p, n, mk) {
  for (let i = 0; i < n; i++) p.onFaceAnchor((mk || faceAnchor)())
}

// --- G1 首次对齐后自动换款 ---
const g1 = loadPage()
feed(g1, 8)
ck('G1 对齐 8 帧后还没换（要等 600ms 稳一下）', g1.data.currentStyle === 'bob', g1.data.currentStyle)
fireTimers(600)
ck('G2 600ms 后按脸型自动换了款（标准脸 → 波波头，恰好就是默认，换一款圆脸验证）',
  g1.data.rec.show === true, JSON.stringify(g1.data.rec))

const g1b = loadPage()
feed(g1b, 8, roundAnchor)
fireTimers(600)
ck('G3 圆脸 → 自动换成拉长类，且不是默认的波波头',
  g1b.data.currentStyle !== 'bob' && ['pompadour', 'long-straight'].indexOf(g1b.data.currentStyle) >= 0,
  g1b.data.currentStyle)
ck('G4 推荐卡片说明了测到的脸型和理由',
  g1b.data.rec.shape === 'round' && g1b.data.rec.reason.length > 5,
  g1b.data.rec.shape + ' / ' + g1b.data.rec.reason)
ck('G5 卡片标记为「已自动换上」', g1b.data.rec.auto === true)

// --- G6 URL 指定了款，不许覆盖 ---
const g2 = loadPage()
g2._explicitStyle = true
g2.data.currentStyle = 'wavy'
feed(g2, 8, roundAnchor)
fireTimers(600)
ck('G6 用户从发型库点了「大波浪」进来，自动匹配不覆盖他的选择',
  g2.data.currentStyle === 'wavy', g2.data.currentStyle)
ck('G7 但仍然给出推荐，并标记为「未自动应用」',
  g2.data.rec.show === true && g2.data.rec.auto === false,
  JSON.stringify({ show: g2.data.rec.show, auto: g2.data.rec.auto }))

// --- G8 上次用过某款，不许覆盖 ---
const g3 = loadPage()
g3._hasLastPick = true
g3.data.currentStyle = 'curly'
feed(g3, 8, longAnchor)
fireTimers(600)
ck('G8 有上次选择的老用户，自动匹配只推荐不替换',
  g3.data.currentStyle === 'curly' && g3.data.rec.auto === false, g3.data.currentStyle)

// --- G9 用户手动选过之后，不再自动换 ---
const g4 = loadPage()
feed(g4, 8, roundAnchor)
g4.pickStyle({ currentTarget: { dataset: { id: 'crop' } } })
ck('G9 手动选款被记下来', g4._userPickedStyle === true)
fireTimers(600)
ck('G10 手动选过之后，自动匹配不再覆盖', g4.data.currentStyle === 'crop',
  g4.data.currentStyle)

// --- G11 推荐只做一次 ---
const g5 = loadPage()
feed(g5, 8, roundAnchor)
fireTimers(600)
const firstPick = g5.data.currentStyle
g5.pickStyle({ currentTarget: { dataset: { id: 'curly' } } })
feed(g5, 20, roundAnchor)
fireTimers(5000)
ck('G11 换回别的款之后再怎么对齐，也不会被第二次自动改掉',
  g5.data.currentStyle === 'curly', g5.data.currentStyle + ' (first=' + firstPick + ')')

// --- G12 脸型测不出来就什么都不说 ---
const g6 = loadPage()
for (let i = 0; i < 4; i++) g6.onFaceAnchor(roundAnchor())
fireTimers(600)
fireTimers(700)
fireTimers(700)
fireTimers(700)
fireTimers(700)
ck('G12 正脸帧不够（只有 4 帧）→ 重试 4 次后放弃，不编脸型',
  g6.data.rec.show === false && g6.data.currentStyle === 'bob',
  JSON.stringify({ show: g6.data.rec.show, style: g6.data.currentStyle }))

// --- G13 用户自己改脸型 ---
const g7 = loadPage()
feed(g7, 8, roundAnchor)
fireTimers(600)
g7.pickShape({ currentTarget: { dataset: { shape: 'long' } } })
ck('G13 用户点「长脸」→ 按长脸重排', g7.data.rec.shape === 'long', g7.data.rec.shape)
ck('G14 重排后换成长脸的首选', ['fringe', 'bob', 'curly'].indexOf(g7.data.currentStyle) >= 0,
  g7.data.currentStyle)

// --- G15 用户点「换成这款」---
const g8 = loadPage()
g8._explicitStyle = true
g8.data.currentStyle = 'wavy'
feed(g8, 8, longAnchor)
fireTimers(600)
const recId = g8.data.rec.styleId
g8.useRecStyle()
ck('G15 点「换成这款」后应用的是推荐款', g8.data.currentStyle === recId, g8.data.currentStyle)
ck('G16 应用后卡片改成「已换上」', g8.data.rec.auto === true)

// --- G17 收起卡片后不再自动动手 ---
const g9 = loadPage()
feed(g9, 8, roundAnchor)
fireTimers(600)
g9.dismissRec()
// 第 7 轮改：× 现在是「收成小条」，不是「整个消失」——
// 手滑点掉一次就再也找不回来，而且肤色结果还会在卡片消失后改发色。
ck('G17 点 × 收成小条：卡片收起，入口留着', g9.data.rec.show === true && g9.data.rec.expanded === false)
ck('G18 收起后标记为已完成，不会再次弹出', g9._recDone === true)

// --- G19 自动换的款不写进「上次用的」 ---
resetStore()
const g10 = loadPage()
feed(g10, 8, roundAnchor)
fireTimers(600)
const autoSaved = state.store['arhair_last_pick_v1']
ck('G19 自动匹配换的款不写进「上次用的」（否则下次进来就不会再匹配了）',
  !autoSaved || JSON.parse(autoSaved).style !== g10.data.currentStyle, autoSaved)
g10.pickStyle({ currentTarget: { dataset: { id: 'crop' } } })
const userSaved = state.store['arhair_last_pick_v1']
ck('G20 用户手动选的款才写进「上次用的」',
  !!userSaved && JSON.parse(userSaved).style === 'crop', userSaved)

// --- G21 开发者工具里不跑（模拟器没有摄像头） ---
const g11 = loadPage()
g11.data.isDevtools = true
feed(g11, 8, roundAnchor)
fireTimers(600)
ck('G21 模拟器里不做自动匹配（没有真实人脸可测）',
  g11.data.rec.show === false && g11.data.currentStyle === 'bob')

// --- G22 手动定位模式下不做（位置是用户摆的，脸型无从谈起） ---
const g12 = loadPage()
g12.data.manualOn = true
feed(g12, 8, roundAnchor)
fireTimers(600)
ck('G22 手动定位模式不做脸型匹配', g12.data.rec.show === false)

/* ================= J 第 3 轮：不许谎报「已换上」 ================= */

console.log('\n[J] 推荐款就是当前款时，不能说「已换上」')

const j1 = loadPage()
// 标准脸的首选是「短碎发」，把它设成当前款，制造「推荐 = 当前」的场景
j1.data.currentStyle = 'crop'
j1.data.currentStyleName = '短碎发'
feed(j1, 8, faceAnchor)
fireTimers(600)
ck('J1 推荐款恰好就是当前款', j1.data.rec.styleId === 'crop', j1.data.rec.styleId)
ck('J2 这时标 same，不标 auto（画面确实没变化）',
  j1.data.rec.same === true && j1.data.rec.auto === false,
  JSON.stringify({ same: j1.data.rec.same, auto: j1.data.rec.auto }))
ck('J3 卡片仍然出现（告诉用户「查过了，这款合适」）', j1.data.rec.show === true)

const j2 = loadPage()
feed(j2, 8, roundAnchor)         // 圆脸 → 背头，和当前款不同
fireTimers(600)
ck('J4 真的换了款时 same = false / auto = true',
  j2.data.rec.same === false && j2.data.rec.auto === true,
  JSON.stringify({ same: j2.data.rec.same, auto: j2.data.rec.auto }))

ck('J5 边界样本不谎报「标准脸」', match.classifyShape(0.845).label === '接近标准',
  match.classifyShape(0.845).label)
ck('J6 明确的标准脸才叫「标准」', match.classifyShape(0.78).label === '标准',
  match.classifyShape(0.78).label)

/* ================= K 第 4 轮：曝光一变肤色就翻档 ================= */

console.log('\n[K] 肤色判定的曝光鲁棒性')

const NEUTRAL = { r: 198, g: 146, b: 112 }
function gain(rgb, k) {
  return { r: Math.min(255, rgb.r * k), g: Math.min(255, rgb.g * k), b: Math.min(255, rgb.b * k) }
}

ck('K1 中性光下两路一致', match.classifySkin(NEUTRAL).confident === true,
  JSON.stringify(match.classifySkin(NEUTRAL).satDepth))
ck('K2 画面暗 25% → ITA 从 30 掉到负值（会误判成偏深）',
  match.classifySkin(gain(NEUTRAL, 0.75)).ita < 10,
  match.classifySkin(gain(NEUTRAL, 0.75)).ita.toFixed(0))
ck('K3 但饱和度没变，两路打架 → 标记为测不准',
  match.classifySkin(gain(NEUTRAL, 0.75)).confident === false)
ck('K4 画面亮 30% → 同样标为测不准',
  match.classifySkin(gain(NEUTRAL, 1.3)).confident === false)
ck('K5 六档肤色在中性光下全部一致（不是一味保守）',
  [[240, 214, 196], [226, 190, 164], [198, 146, 112], [150, 100, 72], [108, 68, 48], [78, 50, 36]]
    .every(c => match.classifySkin({ r: c[0], g: c[1], b: c[2] }).confident === true))

// 页面层：测不准就不许自动替换发色
const k1 = loadPage()
k1._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
k1.camCtx = {
  onCameraFrame(cb) {
    const dim = { r: 149, g: 110, b: 84 }     // 中等肤色被压暗 25%
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrameFor(64, 64, dim) })
    return { stop() {} }
  }
}
k1.startSkinSample()
ck('K6 测不准时仍然给出发色建议（不装死）', k1.data.rec.colorName !== '', k1.data.rec.colorName)
ck('K7 但不自动替换用户的发色', k1.data.currentColor === 'chestnut', k1.data.currentColor)
ck('K8 并且明确标出「仅供参考」', k1.data.rec.colorUnsure === true)

const k2 = loadPage()
k2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
k2.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrameFor(64, 64, { r: 226, g: 190, b: 164 }) })
    return { stop() {} }
  }
}
k2.startSkinSample()
ck('K9 中性光下测准了，才自动替换发色',
  k2.data.currentColor === k2.data.rec.colorId && k2.data.rec.colorUnsure === false,
  JSON.stringify({ cur: k2.data.currentColor, rec: k2.data.rec.colorId }))

/* ================= L 第 5 轮：拍照瞬间 / 切摄像头 ================= */

console.log('\n[L] 拍照与切摄像头的边界')

const l1 = loadPage()
feed(l1, 8, roundAnchor)
l1.data.shooting = true
fireTimers(600)
ck('L1 按着快门时不做推荐（不能在这时候换款）',
  l1.data.rec.show === false && l1.data.currentStyle === 'bob', l1.data.currentStyle)
fireTimers(700)
ck('L2 拍照期间一直让路，重试也不硬来', l1.data.currentStyle === 'bob', l1.data.currentStyle)
l1.data.shooting = false
fireTimers(700)
ck('L3 拍完之后才把推荐补上', l1.data.rec.show === true, JSON.stringify(l1.data.rec.show))

const l2 = loadPage()
l2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
l2.data.shooting = true
l2.applySkin({ ita: 60, depth: 'light', label: '偏白', confident: true })
ck('L4 肤色结果撞上快门时不立刻改画面', l2.data.currentColor === 'chestnut', l2.data.currentColor)
ck('L5 也不立刻写卡片', l2.data.rec.colorName === '', l2.data.rec.colorName)
l2.data.shooting = false
fireTimers(500)
ck('L6 拍完后延后的结果自己补上', l2.data.rec.colorName !== '', l2.data.rec.colorName)

const l3 = loadPage()
feed(l3, 8, roundAnchor)
ck('L7 切摄像头前脸型已就绪', l3._shape.get().ready === true)
l3.switchCamera()
ck('L8 切摄像头后脸型基准被清掉（否则旧最大值会一直压着新观测）',
  l3._shape.get().ready === false, JSON.stringify(l3._shape.get()))

/* ================= M 卡片占位：展开不能吃掉半张脸 ================= */

console.log('\n[M] 展开/收起（卡片不能长期压住取景框）')

const m1 = loadPage()
feed(m1, 8, roundAnchor)
fireTimers(600)
ck('M1 推荐出现时卡片是展开的', m1.data.rec.expanded === true)
fireTimers(6999)
ck('M2 不到 7 秒不收起', m1.data.rec.expanded === true)
fireTimers(7000)
ck('M3 满 7 秒自动收成一行小条', m1.data.rec.expanded === false)
ck('M4 收起后推荐内容还在（不是清空）',
  m1.data.rec.show === true && m1.data.rec.styleName !== '')

m1.expandRec()
ck('M5 点小条能重新展开', m1.data.rec.expanded === true)

const m2 = loadPage()
feed(m2, 8, roundAnchor)
fireTimers(600)
m2.pickColor({ currentTarget: { dataset: { id: 'honey' } } })
ck('M6 用户一动手（选色）卡片立刻收起', m2.data.rec.expanded === false)

const m3 = loadPage()
feed(m3, 8, roundAnchor)
fireTimers(600)
m3.toggleAdjust()
ck('M7 进微调时卡片收起（两个都摊开会挤掉画面）', m3.data.rec.expanded === false)

const m4 = loadPage()
feed(m4, 8, roundAnchor)
fireTimers(600)
m4.collapseRec()
ck('M8 收起后点击卡片区域可收起（bindtap 绑在同一节点）', m4.data.rec.expanded === false)
m4.dismissRec()
// 第 7 轮改：小条必须留着，否则整场都找不回结论（见 U2）
ck('M9 点 × 后小条仍然在（结论没丢，还能点开）', m4.data.rec.show === true && m4.data.rec.declined === true)

const m5 = loadPage()
feed(m5, 8, roundAnchor)
fireTimers(600)
m5.onUnload()
ck('M10 离开页面清掉自动收起定时器', m5._recCollapseTimer === null)

/* ================= H 肤色接线 ================= */

console.log('\n[H] 肤色采样接线')

function skinFrameFor(w, h, rgb) {
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = rgb.r
    buf[i * 4 + 1] = rgb.g
    buf[i * 4 + 2] = rgb.b
    buf[i * 4 + 3] = 255
  }
  return buf
}

const h1 = loadPage()
h1._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
h1.camCtx = {
  onCameraFrame(cb) {
    // 三帧深肤色
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrameFor(64, 64, { r: 108, g: 68, b: 48 }) })
    return { stop() {} }
  }
}
h1.data.rec = Object.assign({}, h1.data.rec, { show: true, styleId: 'pompadour', styleName: '背头' })
h1.startSkinSample()
ck('H1 采到深肤色 → 记录肤色标签', h1.data.rec.skinLabel === '偏深', h1.data.rec.skinLabel)
ck('H2 深肤色 → 推荐深色系（自然黑 / 深棕）',
  ['black', 'darkbrown', 'wine'].indexOf(h1.data.rec.colorId) >= 0, h1.data.rec.colorId)
ck('H3 发色也自动应用了', h1.data.currentColor === h1.data.rec.colorId, h1.data.currentColor)
ck('H4 采样结束后不再显示「正在测肤色」', h1.data.rec.skinBusy === false)
ck('H5 采样只做一次（第二次直接返回）', (function () {
  const before = h1.data.rec.colorId
  h1.data.rec.colorId = 'sentinel'
  h1.startSkinSample()
  return h1.data.rec.colorId === 'sentinel'
})())

const h2 = loadPage()
h2._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
h2.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 12; i++) cb({ width: 64, height: 64, data: skinFrameFor(64, 64, { r: 120, g: 140, b: 150 }) })
    return { stop() {} }
  }
}
h2.startSkinSample()
// 第 6 轮起：采不到会重试（最多 3 轮，间隔 2.5 秒），
// 把重试也跑完，验证最终确实收手了
fireTimers(2500)
fireTimers(2500)
ck('H6 采不到肤色（画面里没有皮肤）→ 不编发色，也不改当前发色',
  h2.data.rec.colorName === '' && h2.data.currentColor === 'chestnut',
  JSON.stringify({ color: h2.data.rec.colorName, cur: h2.data.currentColor }))
ck('H7 采不到时也把「正在测肤色」收起来（不能一直转圈）', h2.data.rec.skinBusy === false)

const h3 = loadPage()
h3._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
h3._userPickedColor = true
h3.data.currentColor = 'silver'
h3.camCtx = {
  onCameraFrame(cb) {
    for (let i = 0; i < 3; i++) cb({ width: 64, height: 64, data: skinFrameFor(64, 64, { r: 108, g: 68, b: 48 }) })
    return { stop() {} }
  }
}
h3.startSkinSample()
ck('H8 用户自己选过发色 → 只推荐不替换', h3.data.currentColor === 'silver', h3.data.currentColor)
ck('H9 但推荐结果仍然展示出来', h3.data.rec.colorId !== '', h3.data.rec.colorId)

const h4 = loadPage()
h4._faceRect = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }
h4.camCtx = { onCameraFrame() { throw new Error('boom') } }
h4.startSkinSample()
ck('H10 onCameraFrame 抛错不崩页面，静默降级',
  h4.data.rec.skinBusy === false && h4.data.currentColor === 'chestnut')

/* ================= I wxml / 静态接线 ================= */

console.log('\n[I] 界面接线')

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxss'), 'utf8')
const pageSrc = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')

ck('I1 有推荐卡片', /class="rec-card"/.test(wxml))
ck('I2 卡片写明测到的脸型', /测得\{\{rec\.shapeLabel\}\}脸/.test(wxml))
ck('I3 卡片给出推荐理由', /class="rec-why">\{\{rec\.reason\}\}/.test(wxml))
ck('I4 卡片有收起按钮', /catchtap="dismissRec"/.test(wxml))
ck('I5 卡片有「换成这款」', /catchtap="useRecStyle"/.test(wxml))
ck('I6 卡片允许用户改判脸型', /data-shape="round"/.test(wxml) && /data-shape="long"/.test(wxml))
ck('I7 肤色测量中显示占位，不显示假结论', /rec\.skinBusy/.test(wxml))
ck('I7b 卡片区分「正适合 / 已换上 / 更推荐」三种说法',
  /rec\.same\}\}"[^>]*>「\{\{rec\.styleName\}\}」正适合/.test(wxml) &&
  /rec\.auto\}\}"[^>]*>已换上/.test(wxml) &&
  /更推荐「\{\{rec\.styleName\}\}」/.test(wxml))
ck('I7c 测不准时卡片上写明「仅供参考」', /仅供参考/.test(wxml))
ck('I7d 卡片展开时款式条 / 色带 / 标题行让位（否则会压住半张脸）',
  (wxml.match(/wx:if="\{\{!\(rec\.show && rec\.expanded\)\}\}"/g) || []).length >= 3,
  String((wxml.match(/wx:if="\{\{!\(rec\.show && rec\.expanded\)\}\}"/g) || []).length))
ck('I7e 收起态有一行小条可重新展开', /class="rec-mini"/.test(wxml) && /bindtap="expandRec"/.test(wxml))
ck('I8 卡片样式存在', /\.rec-card \{/.test(wxss) && /\.rec-chip\.is-on \{/.test(wxss))
ck('I9 页面引入了匹配引擎', /require\('\.\.\/\.\.\/utils\/match'\)/.test(pageSrc))
ck('I10 推荐逻辑只在锁定时触发', /state === 'locked'\) this\.maybeRecommend\(\)/.test(pageSrc))

/* ================= 收尾 ================= */

console.log('\n----------------------------------------')
console.log(pass + ' 通过 / ' + (pass + fail) + ' 项')
if (fail) {
  console.log('\n失败项:')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
