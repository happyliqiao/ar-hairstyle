/**
 * 第 9 轮：真实用户视角 50 轮自查
 *
 *   node tests/audit-50.js
 *
 * 和前 8 轮的区别：前几轮盯的是「权限/存储/拍照/推荐卡」这些已经修过的点。
 * 这一轮换六个以前完全没碰过的维度：
 *   G1 屏幕形态（折叠屏 / 平板 / 横屏 / 分屏）
 *   G2 尺寸变化与生命周期
 *   G3 核心流程里「人已经走了」的边界
 *   G4 交互细节
 *   G5 算法健壮性
 *   G6 性能 / 隐私 / 文档 / 回归入口
 *
 * 每轮是一个独立场景：先写出「用户应该看到什么」，再跑，
 * 不通过的就改产品代码，而不是改断言。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const TRYON_JS = read('pages/tryon/tryon.js')
const WXML = read('pages/tryon/tryon.wxml')
const WXSS = read('pages/tryon/tryon.wxss')
const FIT_JS = read('utils/face-fit.js')
const MATCH_JS = read('utils/match.js')
const ALL_JS = read('tests/all.js')
const README = read('README.md')

const faceFit = require(path.join(ROOT, 'utils/face-fit.js'))
const match = require(path.join(ROOT, 'utils/match.js'))
const hairstyles = require(path.join(ROOT, 'utils/hairstyles.js'))
const store = require(path.join(ROOT, 'utils/store.js'))

/* ===================== 小程序运行环境（可控时钟） ===================== */

function makeCtx() {
  const grad = { addColorStop() {} }
  return new Proxy({
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } }
  }, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      return function () {}
    },
    set() { return true }
  })
}

function makeEnv() {
  const timers = []
  let seq = 1
  const storage = {}
  const toasts = []
  const env = {
    timers: timers,
    storage: storage,
    toasts: toasts,
    querySize: { width: 375, height: 667 },
    windowInfo: {
      statusBarHeight: 24, screenHeight: 844, windowWidth: 375, windowHeight: 667,
      pixelRatio: 2, safeArea: { top: 24, left: 0, right: 375, bottom: 810 }
    }
  }

  const wxTarget = {
    getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
    setStorageSync(k, v) { storage[k] = v },
    removeStorageSync(k) { delete storage[k] },
    getStorageInfoSync() { return { keys: Object.keys(storage), currentSize: 1, limitSize: 10240 } },
    getWindowInfo() { return env.windowInfo },
    getSystemInfoSync() {
      return { platform: 'android', statusBarHeight: 24, screenHeight: 844, pixelRatio: 2, safeArea: { bottom: 810 } }
    },
    getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
    getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
    getFileSystemManager() {
      return {
        getFileInfo(o) { o && o.success && o.success({ size: 300 * 1024 }) },
        saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://p.jpg' }) },
        removeSavedFile(o) { o && o.success && o.success({}) }
      }
    },
    createOffscreenCanvas(o) {
      return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } }
    },
    createCameraContext() {
      return {
        onCameraFrame() { return { stop() {} } },
        takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/x.jpg' }) }
      }
    },
    createVKSession() {
      return { on() {}, start(cb) { cb && cb(0) }, destroy() {} }
    },
    createSelectorQuery() {
      const q = {
        select() { return q }, selectAll() { return q }, fields() { return q },
        boundingClientRect() { return q }, in() { return q },
        exec(cb) {
          cb && cb([{
            node: {
              width: 750, height: 1334,
              getContext() { return makeCtx() },
              createImage() { return {} }
            },
            width: env.querySize.width,
            height: env.querySize.height
          }])
        }
      }
      return q
    },
    canvasToTempFilePath(o) { o && o.success && o.success({ tempFilePath: '/tmp/c.jpg' }) },
    showToast(o) { toasts.push(o && o.title) },
    hideLoading() {}, showLoading() {}, showModal() {},
    setKeepScreenOn() {}, vibrateShort() {}
  }

  env.wx = new Proxy(wxTarget, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string' || k === 'then') return undefined
      return function () {}
    }
  })

  env.fire = function (ms) {
    const due = timers.filter(t => t.ms <= ms)
    const rest = timers.filter(t => t.ms > ms)
    timers.length = 0
    for (let i = 0; i < rest.length; i++) timers.push(rest[i])
    for (let i = 0; i < due.length; i++) due[i].fn()
    return due.length
  }
  env.setTimeout = function (fn, ms) {
    const id = seq++
    timers.push({ id: id, fn: fn, ms: ms })
    return id
  }
  env.clearTimeout = function (id) {
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].id === id) { timers.splice(i, 1); return }
    }
  }
  return env
}

/** 造一个干净的试戴页实例。每个场景一份，避免状态互相污染 */
function freshPage(opts) {
  opts = opts || {}
  const env = makeEnv()
  const saved = {
    wx: global.wx, Page: global.Page, getApp: global.getApp,
    getCurrentPages: global.getCurrentPages,
    setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
    Path2D: global.Path2D
  }
  global.wx = env.wx
  let def = null
  global.Page = function (o) { def = o }
  global.getApp = function () { return { globalData: {}, flushUpdate() {} } }
  global.getCurrentPages = function () { return [] }
  global.setTimeout = env.setTimeout
  global.clearTimeout = env.clearTimeout
  if (typeof global.Path2D === 'undefined') {
    global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }
  }

  const pagePath = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(pagePath)]
  try {
    require(pagePath)
  } finally {
    global.wx = saved.wx
    global.Page = saved.Page
    global.getApp = saved.getApp
    global.getCurrentPages = saved.getCurrentPages
    global.setTimeout = saved.setTimeout
    global.clearTimeout = saved.clearTimeout
  }

  const p = Object.create(def)
  p.data = JSON.parse(JSON.stringify(def.data))
  p.setData = function (patch, cb) {
    if (patch && typeof patch === 'object') Object.assign(p.data, patch)
    if (typeof cb === 'function') cb()
  }
  // 让页面里的异步回调继续用这个可控时钟
  p._env = env
  p._alive = true
  p.onLoad(opts.query || {})
  p.cw = opts.cw || 375
  p.ch = opts.ch || 667
  p.ctx = makeCtx()
  return p
}

/** 让页面的 setTimeout 走可控时钟（onLoad 之后到场景结束之前都有效） */
function withClock(env, fn) {
  const s = { st: global.setTimeout, ct: global.clearTimeout, wx: global.wx }
  global.setTimeout = env.setTimeout
  global.clearTimeout = env.clearTimeout
  global.wx = env.wx
  try { return fn() } finally {
    global.setTimeout = s.st
    global.clearTimeout = s.ct
    global.wx = s.wx
  }
}

/* ===================== 50 轮 ===================== */

const results = []
function R(id, group, title, fn) {
  let ok = false
  let note = ''
  try {
    const r = fn()
    if (r && typeof r === 'object') { ok = !!r.ok; note = r.note || '' }
    else ok = !!r
  } catch (e) {
    ok = false
    note = 'EXCEPTION ' + (e && e.message ? e.message : e)
  }
  results.push({ id: id, group: group, title: title, ok: ok, note: note })
}

const GUIDE_MAX_H = 0.461 // 框高最多占屏高 46%（普通手机约为 41%）
function inScreen(cw, ch, g) {
  return !!g && g.cx - g.w / 2 >= -0.5 && g.cx + g.w / 2 <= cw + 0.5 &&
    g.cy - g.h / 2 >= 0 && g.cy + g.h / 2 <= ch
}

/* ---- G1 屏幕形态（10 轮） ---- */

R('R01', '屏幕形态', '375×667 常规竖屏：取景框尺寸不变、完整在屏内', function () {
  const g = faceFit.guideFrame(375, 667)
  return { ok: Math.abs(g.w - 225) < 0.01 && g.h / 667 <= GUIDE_MAX_H && inScreen(375, 667, g), note: 'w=' + g.w.toFixed(1) + ' h=' + g.h.toFixed(1) }
})

R('R02', '屏幕形态', '320×568 小屏：框不压顶部栏、也不压底部面板', function () {
  const g = faceFit.guideFrame(320, 568)
  return { ok: g.cy - g.h / 2 > 60 && g.cy + g.h / 2 < 568 * 0.75, note: 'top=' + (g.cy - g.h / 2).toFixed(0) + ' bottom=' + (g.cy + g.h / 2).toFixed(0) }
})

R('R03', '屏幕形态', '390×844 全面屏：框心仍在上半屏黄金位', function () {
  const g = faceFit.guideFrame(390, 844)
  return { ok: Math.abs(g.cy / 844 - 0.40) < 0.001 && inScreen(390, 844, g), note: 'cy=' + g.cy }
})

R('R04', '屏幕形态', '768×1024 平板竖屏：框高不能吃掉半屏', function () {
  const g = faceFit.guideFrame(768, 1024)
  return { ok: g.h / 1024 <= GUIDE_MAX_H && inScreen(768, 1024, g), note: 'h/ch=' + (g.h / 1024).toFixed(3) }
})

R('R05', '屏幕形态', '1024×768 平板横屏：框宽不能按屏宽等比放大', function () {
  const g = faceFit.guideFrame(1024, 768)
  return { ok: g.h / 768 <= GUIDE_MAX_H && g.w / 1024 < 0.40 && inScreen(1024, 768, g), note: 'w/cw=' + (g.w / 1024).toFixed(3) + ' h/ch=' + (g.h / 768).toFixed(3) }
})

R('R06', '屏幕形态', '844×390 折叠屏展开 / 横屏：框必须完整在屏内', function () {
  const g = faceFit.guideFrame(844, 390)
  return { ok: inScreen(844, 390, g), note: 'top=' + (g.cy - g.h / 2).toFixed(0) + ' bottom=' + (g.cy + g.h / 2).toFixed(0) }
})

R('R07', '屏幕形态', '360×1280 分屏极窄高：框宽不超过屏宽 62%', function () {
  const g = faceFit.guideFrame(360, 1280)
  return { ok: g.w / 360 <= 0.62 && inScreen(360, 1280, g), note: 'w/cw=' + (g.w / 360).toFixed(3) }
})

R('R08', '屏幕形态', '横屏下真实人脸也能判「已对齐」（否则自动匹配永远不触发）', function () {
  const vp = { w: 844, h: 390 }
  const g = faceFit.guideFrame(vp.w, vp.h)
  const face = { cx: g.cx, cy: g.cy, w: vp.h * 0.36 * 0.78, h: vp.h * 0.36, rawW: vp.h * 0.36 * 0.78, rawH: vp.h * 0.36 }
  const r = faceFit.judgeAlign(face, vp, 0, null)
  return { ok: r.state === 'locked', note: 'state=' + r.state + ' hint=' + r.hint + ' ratio=' + r.ratio.toFixed(2) }
})

R('R09', '屏幕形态', '宽屏下发型框不会比取景框大三倍（脸宽夹取要跟着框走）', function () {
  const vp = { w: 844, h: 390 }
  const box = faceFit.faceAnchorToBox(
    { origin: { x: 500, y: 200 }, size: { width: 210, height: 270 } },
    { w: 1280, h: 720 }, vp, { mirror: false }
  )
  return { ok: !!box && box.w <= vp.w * 0.5, note: 'box.w=' + (box ? box.w.toFixed(1) : 'null') + ' 上限=' + (vp.w * 0.5).toFixed(0) }
})

R('R10', '屏幕形态', '非法尺寸（0 / 负 / NaN / 字符串 / Infinity）不产生脏几何', function () {
  const bad = [0, -375, NaN, '375', Infinity, undefined, null]
  const allNull = bad.every(v => faceFit.guideFrame(v, 667) === null) &&
    bad.every(v => faceFit.guideFrame(375, v) === null)
  return { ok: allNull, note: allNull ? '7 种输入全部返回 null' : '仍有输入返回了几何对象' }
})

/* ---- G2 生命周期（8 轮） ---- */

R('R11', '生命周期', '屏幕尺寸变化时有 onResize 重算取景框', function () {
  if (!/\bonResize\s*\(/.test(TRYON_JS)) return { ok: false, note: '页面没有 onResize' }
  const p = freshPage()
  const env = p._env
  env.querySize = { width: 844, height: 390 }
  withClock(env, function () { p.onResize({ size: { windowWidth: 844, windowHeight: 390, screenWidth: 844, screenHeight: 390 } }) })
  const g = p.data.guide
  return { ok: !!g.show && Math.abs(g.w - faceFit.guideFrame(844, 390).w) < 0.01, note: 'guide.w=' + g.w }
})

R('R12', '生命周期', '重复初始化画布不会累积 ctx.scale（否则每转一次屏画面放大一倍）', function () {
  return { ok: /setTransform\s*\(\s*1\s*,\s*0\s*,\s*0\s*,\s*1\s*,\s*0\s*,\s*0\s*\)/.test(TRYON_JS), note: /setTransform/.test(TRYON_JS) ? '已有重置' : '只有 scale，没有重置' }
})

R('R13', '生命周期', 'onResize 后 cw/ch 与框的几何来自同一份新尺寸', function () {
  if (!/\bonResize\s*\(/.test(TRYON_JS)) return { ok: false, note: '页面没有 onResize' }
  const p = freshPage()
  const env = p._env
  env.querySize = { width: 1024, height: 768 }
  withClock(env, function () { p.onResize({ size: { windowWidth: 1024, windowHeight: 768 } }) })
  return { ok: p.cw === 1024 && p.ch === 768 && Math.abs(p.data.guide.cx - 512) < 0.01, note: 'cw=' + p.cw + ' ch=' + p.ch + ' cx=' + p.data.guide.cx }
})

R('R14', '生命周期', '切后台时收起展开的推荐卡，回到前台不压住脸', function () {
  const p = freshPage()
  p.data.rec = Object.assign({}, p.data.rec, { show: true, expanded: true })
  p.onHide()
  return { ok: p.data.rec.expanded === false, note: 'expanded=' + p.data.rec.expanded }
})

R('R15', '生命周期', '切后台时清掉卡片倒计时（后台不跑无用的定时器）', function () {
  const p = freshPage()
  p._recCollapseTimer = 4242
  p.onHide()
  return { ok: p._recCollapseTimer === null, note: '_recCollapseTimer=' + p._recCollapseTimer }
})

R('R16', '生命周期', '相机异常后不再挂着「已换上 X」的推荐卡', function () {
  const p = freshPage()
  p.data.rec = Object.assign({}, p.data.rec, { show: true, expanded: true, auto: true, styleName: '背头' })
  p.onCameraError({ detail: {} })
  return { ok: p.data.rec.expanded === false || p.data.rec.show === false, note: 'show=' + p.data.rec.show + ' expanded=' + p.data.rec.expanded }
})

R('R17', '生命周期', '页面销毁时清掉快门看门狗', function () {
  const p = freshPage()
  p.shootTimer = 777
  p.onUnload()
  return { ok: p.shootTimer === null, note: 'shootTimer=' + p.shootTimer }
})

R('R18', '生命周期', '切摄像头后不能留着上一台摄像头的人脸采样框', function () {
  const p = freshPage()
  p._faceRect = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }
  p.data.shooting = false
  withClock(p._env, function () { p.switchCamera() })
  return { ok: p._faceRect === null, note: '_faceRect=' + JSON.stringify(p._faceRect) }
})

/* ---- G3 核心流程（10 轮） ---- */

R('R19', '核心流程', '人已经离开画面、但还在 2.5 秒宽限期内：不许拍出悬空发型', function () {
  const p = freshPage()
  p.data.faceFound = false
  p.data.manualOn = false
  p.data.cameraReady = true
  p.lastBox = { x: 100, y: 100, w: 200, h: 240, angle: 0 }
  p.trackedBox = { x: 100, y: 100, w: 200, h: 240, face: { cx: 200, cy: 200, w: 100 } }
  p.trackedLostAt = Date.now()
  withClock(p._env, function () { p.capture() })
  return { ok: p.data.shooting === false && /放进/.test(p.data.toast), note: 'shooting=' + p.data.shooting + ' toast=' + p.data.toast }
})

R('R20', '核心流程', '手动定位用户没识到脸也要能拍照（别把上一条修过头）', function () {
  const p = freshPage()
  p.data.faceFound = false
  p.data.manualOn = true
  p.data.cameraReady = true
  p.lastBox = { x: 100, y: 100, w: 200, h: 240, angle: 0 }
  withClock(p._env, function () { p.capture() })
  return { ok: p.data.shooting === true, note: 'shooting=' + p.data.shooting }
})

R('R21', '核心流程', '有脸时快门正常进入拍摄流程', function () {
  const p = freshPage()
  p.data.faceFound = true
  p.data.cameraReady = true
  p.lastBox = { x: 100, y: 100, w: 200, h: 240, angle: 0 }
  withClock(p._env, function () { p.capture() })
  return { ok: p.data.shooting === true, note: 'shooting=' + p.data.shooting }
})

R('R22', '核心流程', '照片生成结束后解除 20 秒看门狗（成功路径也别白挂定时器）', function () {
  const p = freshPage()
  p.shootTimer = 888
  withClock(p._env, function () { p.afterCompose('/tmp/a.jpg', '/tmp/t.jpg') })
  return { ok: p.shootTimer === null, note: 'shootTimer=' + p.shootTimer }
})

R('R23', '核心流程', '肤色结论撞上拍摄时的延后重试必须有上限，不能无限挂定时器', function () {
  const p = freshPage()
  const skin = match.classifySkin({ r: 226, g: 190, b: 164 })
  p.data.shooting = true
  const env = p._env
  withClock(env, function () {
    p.applySkin(skin)
    for (let i = 0; i < 25; i++) env.fire(500)
  })
  const left = env.timers.filter(t => t.ms === 500).length
  return { ok: left === 0, note: '连推 25 次后仍挂着 ' + left + ' 个 500ms 定时器' }
})

R('R24', '核心流程', '拍照期间换款：照片仍用快门那一刻冻结的造型', function () {
  const ok = /_captureLook/.test(TRYON_JS) && /captureLook\.style/.test(TRYON_JS) && /captureLook\.color/.test(TRYON_JS)
  return { ok: ok, note: ok ? '合成读的是冻结造型' : '合成直接读了当前 data' }
})

R('R25', '核心流程', '切摄像头后重新匹配：_recDone 复位，不是整场只匹配一次', function () {
  const p = freshPage()
  p._recDone = true
  withClock(p._env, function () { p.switchCamera() })
  return { ok: p._recDone === false, note: '_recDone=' + p._recDone }
})

R('R26', '核心流程', '刚对齐不立刻换发型：先等 600ms 让用户看清当前画面', function () {
  const p = freshPage()
  p._align = { state: 'locked' }
  p._shape = { get() { return { ready: true, shape: 'oval', label: '标准脸', confidence: 1 } }, push() {}, reset() {} }
  const env = p._env
  withClock(env, function () { p.maybeRecommend() })
  const hasSettle = env.timers.some(t => t.ms === 600)
  return { ok: p.data.rec.show === false && hasSettle, note: 'rec.show=' + p.data.rec.show + ' 600ms定时器=' + hasSettle }
})

R('R27', '核心流程', '推荐款就是当前款时不谎报「已换上」', function () {
  const p = freshPage()
  p.data.currentStyle = match.bestStyle('oval').id
  p.applyShape('oval')
  return { ok: p.data.rec.same === true && p.data.rec.auto === false, note: 'same=' + p.data.rec.same + ' auto=' + p.data.rec.auto }
})

R('R28', '核心流程', '点过 × 之后，迟到的肤色结论不偷偷改发色', function () {
  const p = freshPage()
  p.dismissRec()
  p.data.shooting = false
  const before = p.data.currentColor
  const skin = match.classifySkin({ r: 230, g: 195, b: 170 })
  withClock(p._env, function () { p.applySkin(skin) })
  return { ok: p.data.currentColor === before, note: before + ' -> ' + p.data.currentColor }
})

/* ---- G4 交互细节（9 轮） ---- */

R('R29', '交互细节', '推荐卡展开时款式条 / 色带 / 标题行让位', function () {
  const n = (WXML.match(/rec\.show && rec\.expanded/g) || []).length
  return { ok: n >= 4, note: '让位判断 ' + n + ' 处' }
})

R('R30', '交互细节', '卡片展开时快门 / 收藏 / 记录仍然可点', function () {
  const seg = WXML.slice(WXML.indexOf('shutter-row'), WXML.indexOf('</view>\n  </view>', WXML.indexOf('shutter-row')))
  const ok = /bindtap="capture"/.test(seg) && /bindtap="toggleFavorite"/.test(seg) && !/wx:if="\{\{!\(rec\.show/.test(seg)
  return { ok: ok, note: ok ? '快门行不受让位影响' : '快门行被让位条件包住了' }
})

R('R31', '交互细节', '「换一款」只在有备选时显示，不给点了没反应的按钮', function () {
  return { ok: /rec\.alt\.length > 1/.test(WXML), note: /rec-next/.test(WXML) ? '有条件渲染' : '找不到按钮' }
})

R('R32', '交互细节', '收起成小条后结论和发色都还在', function () {
  return { ok: /rec-mini-color/.test(WXML) && /colorName/.test(WXML) && /rec-mini-text/.test(WXML), note: '小条含发色' }
})

R('R33', '交互细节', '展开卡片点空白处能收起（不是只能等 7 秒）', function () {
  return { ok: /class="rec-card"[\s\S]{0,120}bindtap="collapseRec"/.test(WXML) || /bindtap="collapseRec"[\s\S]{0,120}class="rec-card"/.test(WXML), note: 'rec-card 有 collapseRec' }
})

R('R34', '交互细节', '微调中攒下的推荐先挂起，不在滑块上面弹卡片', function () {
  return { ok: /if \(this\.data\.adjustMode\)[\s\S]{0,160}_recPending = true/.test(TRYON_JS), note: '有挂起分支' }
})

R('R35', '交互细节', '详情弹层有自己的层级，盖在面板之上而不是并排挤布局', function () {
  const i = WXSS.indexOf('.sheet-mask')
  return { ok: i >= 0 && /z-index/.test(WXSS.slice(i, i + 260)), note: i >= 0 ? '有遮罩层级' : '没有遮罩' }
})

R('R36', '交互细节', '双击复位退出手动定位，没识到脸时不留悬空发型', function () {
  const p = freshPage()
  p.data.manualOn = true
  p.data.faceFound = false
  p.resetAdjust()
  return { ok: p.data.manualOn === false && p.computeBox() === null, note: 'manualOn=' + p.data.manualOn }
})

R('R37', '交互细节', '顶部按钮起点用胶囊位置算，不直接拿状态栏高度', function () {
  return { ok: /statusBarHeight: nav\.topPad\(/.test(TRYON_JS), note: '用 nav.topPad' }
})

/* ---- G5 算法健壮性（8 轮） ---- */

function frame(w, h, base, paint) {
  const u = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    u[i * 4] = base.r; u[i * 4 + 1] = base.g; u[i * 4 + 2] = base.b; u[i * 4 + 3] = 255
  }
  if (paint) paint(u)
  return u
}
function fillPatch(u, w, h, rect, x0, x1, y0, y1, c) {
  for (let y = Math.floor((rect.y + rect.h * y0) * h); y < Math.ceil((rect.y + rect.h * y1) * h); y++) {
    for (let x = Math.floor((rect.x + rect.w * x0) * w); x < Math.ceil((rect.x + rect.w * x1) * w); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const i = (y * w + x) * 4
      u[i] = c.r; u[i + 1] = c.g; u[i + 2] = c.b
    }
  }
}
const RECT = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }

R('R38', '算法健壮性', '整帧都是深色头发 → 不给肤色结论', function () {
  const f = frame(64, 64, { r: 30, g: 25, b: 20 })
  return { ok: match.sampleSkinPixels(f, 64, 64, RECT) === null }
})

R('R39', '算法健壮性', '只有一边脸颊露出来也能采样（暗光/侧脸不被一刀切）', function () {
  const f = frame(64, 64, { r: 30, g: 25, b: 20 }, function (u) {
    fillPatch(u, 64, 64, RECT, 0.16, 0.40, 0.50, 0.70, { r: 230, g: 180, b: 150 })
  })
  const s = match.sampleSkinPixels(f, 64, 64, RECT)
  return { ok: !!s && s.r > 200, note: s ? 'r=' + s.r.toFixed(0) : 'null' }
})

R('R40', '算法健壮性', '暗光下一边是脸、一边是红墙：不能拿两块颜色的平均值当肤色', function () {
  const f = frame(64, 64, { r: 60, g: 40, b: 30 }, function (u) {
    fillPatch(u, 64, 64, RECT, 0.60, 0.84, 0.50, 0.70, { r: 200, g: 30, b: 30 })
  })
  const s = match.sampleSkinPixels(f, 64, 64, RECT)
  return { ok: s === null, note: s ? '误报肤色 r=' + s.r.toFixed(0) + ' n=' + s.n : '已拒绝' }
})

R('R41', '算法健壮性', '肤色分类器对 NaN / 越界像素返回 null，不写脏结论', function () {
  const a = match.classifySkin({ r: NaN, g: 100, b: 100 })
  const b = match.classifySkin(null)
  return { ok: a === null && b === null }
})

R('R42', '算法健壮性', '深 / 中 / 浅三种肤色拿到的首选发色确实不同', function () {
  const pick = d => { const r = match.rankColors(d, hairstyles.HAIR_COLORS); return r.length ? r[0].id : '' }
  const xs = [pick('deep'), pick('medium'), pick('light')]
  return { ok: new Set(xs).size === 3, note: xs.join(' / ') }
})

R('R43', '算法健壮性', '上次选择被写成 null / 数组 / 数字时，页面仍能正常启动', function () {
  const p = freshPage()
  p._env.storage['arhair_last_pick_v1'] = 'null'
  const a = store.getLastPick()
  p._env.storage['arhair_last_pick_v1'] = '[1,2]'
  const b = store.getLastPick()
  return { ok: a.by === 'user' && a.style === '' && b.style === '' && !!p.data.currentStyle, note: 'currentStyle=' + p.data.currentStyle }
})

R('R44', '算法健壮性', '10 款缩略图各不相同且单张不超 12KB', function () {
  const ids = []
  let max = 0
  for (let i = 0; i < hairstyles.HAIR_STYLES.length; i++) {
    const u = hairstyles.buildThumb(hairstyles.HAIR_STYLES[i].id, 'black')
    ids.push(u)
    max = Math.max(max, Buffer.byteLength(u, 'utf8'))
  }
  return { ok: new Set(ids).size === ids.length && max <= 12 * 1024, note: ids.length + ' 张，最大 ' + Math.round(max / 1024) + 'KB' }
})

R('R45', '算法健壮性', '触摸坐标回传 NaN 时不把 NaN 几何交给绘制层', function () {
  const p = freshPage()
  p.data.faceFound = true
  // sizeVal 有 `|| 100` 兜底，NaN 穿不透；dragDX 才是真正会漏进来的脏值
  //（touchPoint 只验 typeof === 'number'，NaN 也过）。
  p.dragDX = NaN
  p.trackedBox = null
  let called = 0
  const orig = hairstyles.drawHair
  hairstyles.drawHair = function () { called++ }
  try { withClock(p._env, function () { p.render(true) }) } catch (e) {}
  finally { hairstyles.drawHair = orig }
  return { ok: p.lastBox === null && called === 0, note: 'lastBox=' + (p.lastBox ? 'NaN 几何' : 'null') + ' drawHair=' + called }
})

/* ---- G6 性能 / 隐私 / 文档 / 回归（5 轮） ---- */

R('R46', '性能', '连续划色带重建 10 张缩略图有 500ms 防抖', function () {
  return { ok: /_thumbTimer[\s\S]{0,400}500\)/.test(TRYON_JS), note: '有防抖' }
})

R('R47', '隐私', '日志不打印摄像头帧像素与人脸原始坐标', function () {
  const bad = /console\.(log|warn|info)\([^\n]*(frame\.data|anchor\.origin|_faceRect\.x)/.test(TRYON_JS)
  return { ok: !bad, note: bad ? '日志里出现原始帧/坐标' : '只打印状态与错误摘要' }
})

R('R48', '隐私', '分享链接只带款式/发色 id，不带任何个人字段', function () {
  const seg = TRYON_JS.slice(TRYON_JS.indexOf('onShareAppMessage'), TRYON_JS.indexOf('onShareTimeline'))
  return { ok: /style=|&color=/.test(seg) && !/nickName|avatar|profile|phone/.test(seg) }
})

R('R49', '文档', 'README 的已知限制与这一轮新发现的屏幕形态问题对得上', function () {
  return { ok: /宽高比|宽屏|自适应/.test(README) && /第 9 轮|50 轮/.test(README), note: '已同步已知限制与自测入口' }
})

R('R50', '回归', '新套件已挂到全量回归入口 tests/all.js', function () {
  return { ok: /audit-50\.js/.test(ALL_JS), note: '已挂到全量回归' }
})

/* ===================== 汇总 ===================== */

let failed = 0
let lastGroup = ''
console.log('')
console.log('============ 第 9 轮：真实用户视角 50 轮自查 ============')
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  if (r.group !== lastGroup) {
    console.log('  --- ' + r.group + ' ---')
    lastGroup = r.group
  }
  if (!r.ok) failed++
  console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.id + '  ' + r.title + (r.note ? '   [' + r.note + ']' : ''))
}
console.log('========================================================')
console.log('  ' + (results.length - failed) + ' / ' + results.length + ' 轮通过')
if (failed) {
  console.log('  未通过 ' + failed + ' 轮，逐轮修产品代码后复跑：node tests/audit-50.js')
  process.exitCode = 1
} else {
  console.log('  50 轮全部通过')
}
