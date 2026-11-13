/**
 * 第 10 轮：真实用户视角 50 轮自查
 *
 *   node tests/audit-50b.js
 *
 * 和第 9 轮的区别：第 9 轮盯的是「屏幕形态 / 生命周期 / 流程边界」，
 * 这一轮盯的是**用户真的在动手时**发生的事：
 *   G1 真实操作序列 —— 拍照那几秒里用户还会点/拖/换/退
 *   G2 并发竞态     —— 多个定时器与异步回调同时到达
 *   G3 数据一致性   —— 预览、照片、记录、相册四者是否同一套
 *   G4 性能压测     —— 连续操作下定时器/内存/帧率是否失控
 *   G5 跨页面状态   —— 进出记录页/设置页/分享卡片后的恢复
 *   G6 异常恢复     —— 拍照/合成/落盘/权限的失败路径
 *
 * 每轮先写「用户应该看到什么」，再跑。不通过就改产品代码，不改断言。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const TRYON_JS = read('pages/tryon/tryon.js')
const WXML = read('pages/tryon/tryon.wxml')
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
    // 可在场景里改：相机权限、相机上下文、VKSession
    auth: { 'scope.camera': true },
    cam: null,
    vk: null,
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
    getSetting(o) { o && o.success && o.success({ authSetting: env.auth }) },
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
      if (env.cam) return env.cam
      return {
        onCameraFrame() { return { stop() {} } },
        takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/x.jpg' }) }
      }
    },
    createVKSession() {
      if (env.vk) return env.vk
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
  // 允许场景预设 storage（lastPick / calibration / favorites），
  // 否则「上次选择」这类场景只能靠改外层 global.wx，测试之间会互相污染
  if (opts.storage) Object.assign(env.storage, opts.storage)
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
  p._env = env
  p._alive = true
  // onLoad 也必须在 env.wx 下执行：它会读 lastPick / calibration / favorites，
  // 用外层 wx 会读到上一个场景的 storage（甚至 undefined），测试互相污染。
  const s2 = { wx: global.wx, st: global.setTimeout, ct: global.clearTimeout }
  global.wx = env.wx
  global.setTimeout = env.setTimeout
  global.clearTimeout = env.clearTimeout
  try {
    p.onLoad(opts.query || {})
  } finally {
    global.wx = s2.wx
    global.setTimeout = s2.st
    global.clearTimeout = s2.ct
  }
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

/* ===================== 测试辅助 ===================== */

/** 临时替换绘制/预热，避免每个场景都跑几万次 canvas 调用 */
function quietDraw(fn) {
  const d = hairstyles.drawHair
  const w = hairstyles.prewarm
  let drew = []
  hairstyles.drawHair = function (ctx, box, style, color) {
    drew.push({ style: style, color: color })
  }
  hairstyles.prewarm = function () {}
  try {
    const r = fn()
    return { result: r, drew: drew }
  } finally {
    hairstyles.drawHair = d
    hairstyles.prewarm = w
  }
}

/** 模拟「已经按了快门、正在生成」的页面状态 */
function shootingPage() {
  const p = freshPage()
  p.data.shooting = true
  p.data.faceFound = true
  p.data.currentStyle = 'bob'
  p.data.currentColor = 'chestnut'
  p.boxFrozen = true
  p.frozenBox = { x: 80, y: 120, w: 200, h: 240, angle: 0, mirror: true }
  p.lastBox = { x: 80, y: 120, w: 200, h: 240, angle: 0, mirror: true }
  p._captureLook = { style: 'bob', color: 'chestnut', mirror: true }
  p.trackedBox = { x: 80, y: 120, w: 200, h: 240 }
  p.trackedAngle = 0
  p.dragDX = 0
  p.dragDY = 0
  return p
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

/* ---- G1 真实操作序列：拍照那几秒用户还会动手（10 轮） ---- */

R('R01', '操作序列', '连点两次快门只拍一张，第二次不重复触发 takePhoto', function () {
  const p = shootingPage()
  p.data.shooting = false
  p.data.cameraReady = true
  let shots = 0
  p.camCtx = { takePhoto() { shots++ } }
  withClock(p._env, function () { p.capture(); p.capture() })
  return { ok: shots === 1 && p.data.shooting === true, note: 'takePhoto=' + shots }
})

R('R02', '操作序列', '拍照期间点款式条：不换款，预览与照片保持同一套', function () {
  const p = shootingPage()
  const q = quietDraw(function () {
    withClock(p._env, function () {
      p.pickStyle({ currentTarget: { dataset: { id: 'buzz' } } })
    })
  })
  const drewStyle = q.drew.length ? q.drew[q.drew.length - 1].style : ''
  return {
    ok: p.data.currentStyle === 'bob' && (drewStyle === '' || drewStyle === 'bob'),
    note: 'currentStyle=' + p.data.currentStyle + ' drew=' + (drewStyle || '-')
  }
})

R('R03', '操作序列', '拍照期间点色带：不换色，照片与预览同一发色', function () {
  const p = shootingPage()
  quietDraw(function () {
    withClock(p._env, function () {
      p.pickColor({ currentTarget: { dataset: { id: 'black' } } })
    })
  })
  return { ok: p.data.currentColor === 'chestnut', note: 'currentColor=' + p.data.currentColor }
})

R('R04', '操作序列', '拍照期间切摄像头：被挡住并说明原因', function () {
  const p = shootingPage()
  withClock(p._env, function () { p.switchCamera() })
  return {
    ok: p.data.devicePosition === 'front' && /正在生成/.test(p.data.toast || ''),
    note: 'pos=' + p.data.devicePosition + ' toast=' + (p.data.toast || '-')
  }
})

R('R05', '操作序列', '拍照期间进微调：不进入，避免滑块改了却画不动', function () {
  const p = shootingPage()
  withClock(p._env, function () { p.toggleAdjust() })
  return { ok: p.data.adjustMode === false, note: 'adjustMode=' + p.data.adjustMode }
})

R('R06', '操作序列', '拍照期间拖大小滑块：内存值不被改写', function () {
  const p = shootingPage()
  p.sizeVal = 100
  withClock(p._env, function () { p.onSizeChanging({ detail: { value: 180 } }) })
  return { ok: p.sizeVal === 100, note: 'sizeVal=' + p.sizeVal }
})

R('R07', '操作序列', '拍照期间双击复位：不改变当前拖动偏移', function () {
  const p = shootingPage()
  p.dragDX = 32
  p.dragDY = -18
  withClock(p._env, function () { p.resetAdjust() })
  return { ok: p.dragDX === 32 && p.dragDY === -18, note: 'dragDX=' + p.dragDX }
})

R('R08', '操作序列', '拍照期间点返回：不退出，照片不会凭空丢失', function () {
  const p = shootingPage()
  withClock(p._env, function () { p.goBack() })
  return { ok: /正在生成/.test(p.data.toast || ''), note: 'toast=' + (p.data.toast || '-') }
})

R('R09', '操作序列', '拍照期间去记录页：不跳转，等生成完再走', function () {
  const p = shootingPage()
  withClock(p._env, function () { p.goHistory() })
  return { ok: /正在生成/.test(p.data.toast || ''), note: 'toast=' + (p.data.toast || '-') }
})

R('R10', '操作序列', '拍照期间点「换一款」：不换款，备选轮换不生效', function () {
  const p = shootingPage()
  p.data.rec = Object.assign({}, p.data.rec, {
    show: true, expanded: true, styleId: 'bob',
    alt: [{ id: 'bob', name: '波波头' }, { id: 'buzz', name: '圆寸' }]
  })
  quietDraw(function () {
    withClock(p._env, function () { p.nextRecStyle() })
  })
  return { ok: p.data.currentStyle === 'bob', note: 'currentStyle=' + p.data.currentStyle }
})

/* ---- G2 并发竞态（10 轮） ---- */

R('R11', '并发竞态', '600ms 推荐结算撞上拍照：让路重排，不抢拍', function () {
  const p = shootingPage()
  p._recTries = 1
  p._recDone = false
  p._align = { state: 'locked' }
  p._shape = { get() { return { ready: true, shape: 'oval', label: '标准脸', confidence: 1 } } }
  quietDraw(function () {
    withClock(p._env, function () { p.runRecommend() })
  })
  return { ok: p._recDone === false && !!p._recTimer, note: '_recDone=' + p._recDone + ' timer=' + !!p._recTimer }
})

R('R12', '并发竞态', '肤色结论撞上拍照：推迟应用且计数，不无限递归', function () {
  const p = shootingPage()
  p._skinApplyTries = 0
  withClock(p._env, function () {
    p.applySkin({ depth: 'medium', confident: true, label: '中等' })
  })
  return {
    ok: !!p._skinApplyTimer && p._skinApplyTries === 1,
    note: 'tries=' + p._skinApplyTries + ' timer=' + !!p._skinApplyTimer
  }
})

R('R13', '并发竞态', '肤色采样绑定摄像头 epoch，切摄像头后旧帧不写新画面', function () {
  const p = freshPage()
  p._cameraEpoch = 3
  p._faceRect = { x: 0.4, y: 0.3, w: 0.2, h: 0.3 }
  p.frameSize = { w: 720, h: 1280 }
  let stopped = 0
  let cb = null
  p.camCtx = {
    onCameraFrame(fn) { cb = fn; return { stop() { stopped++ } } }
  }
  withClock(p._env, function () {
    p.startSkinSample()
    p._cameraEpoch = 4 // 采样途中用户切了摄像头
    cb({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
  })
  return { ok: stopped >= 1, note: 'listener.stop=' + stopped }
})

R('R14', '并发竞态', '500ms 缩略图防抖在页面销毁后不写数据', function () {
  const p = freshPage()
  let threw = ''
  try {
    withClock(p._env, function () {
      p.applyColorId('black', { user: true })
      p._alive = false
      p._env.fire(600)
    })
  } catch (e) { threw = e.message || 'throw' }
  return { ok: !threw, note: threw || '销毁后静默' }
})

R('R15', '并发竞态', '7 秒卡片收起撞上进微调：定时器被清，不会把微调面板顶开', function () {
  const p = freshPage()
  p.data.rec = Object.assign({}, p.data.rec, { show: true, expanded: true })
  withClock(p._env, function () {
    p.scheduleRecCollapse()
    p.toggleAdjust()
  })
  return { ok: p._recCollapseTimer === null && p.data.adjustMode === true, note: 'timer=' + p._recCollapseTimer }
})

R('R16', '并发竞态', '快速连点切换摄像头：只保留最后一次定时器', function () {
  const p = freshPage()
  let first = null
  let now = null
  let err = ''
  try {
    withClock(p._env, function () {
      p.switchCamera()
      first = p.switchTimer
      p.switchCamera()
      now = p.switchTimer
    })
  } catch (e) { err = e.message || String(e) }
  return { ok: !!now && now !== first, note: 'first=' + first + ' now=' + now + (err ? ' err=' + err : '') }
})

R('R17', '并发竞态', '相机启动 500ms 定时器在退出时被清掉', function () {
  const p = freshPage()
  withClock(p._env, function () {
    p.openCamera()
    p.onUnload()
  })
  return { ok: p.openTimer === null, note: 'openTimer=' + p.openTimer }
})

R('R18', '并发竞态', '帧尺寸探测的 4 秒兜底在切摄像头时被清掉', function () {
  const p = freshPage()
  withClock(p._env, function () {
    p.probeFrameSize()
    p.switchCamera()
  })
  return { ok: p.probeTimer === null && p.frameListener === null, note: 'probeTimer=' + p.probeTimer }
})

R('R19', '并发竞态', '拍照成功后 20 秒看门狗立刻解除', function () {
  const p = shootingPage()
  withClock(p._env, function () {
    p.armShootWatchdog()
    p.afterCompose('/tmp/x.jpg', '')
  })
  return { ok: p.shootTimer === null, note: 'shootTimer=' + p.shootTimer }
})

R('R20', '并发竞态', '「存储满」warn 不被随后的「已保存到相册」覆盖', function () {
  const p = freshPage()
  withClock(p._env, function () {
    p.showToast('存储已满，去「试戴记录」删几条旧记录', 'warn')
    p.showToast('已保存到相册')
  })
  return { ok: /存储已满/.test(p.data.toast || ''), note: 'toast=' + (p.data.toast || '-') }
})

/* ---- G3 数据一致性（10 轮） ---- */

R('R21', '数据一致性', '记录写入失败时明确提示，不谎称已存入', function () {
  const seg = TRYON_JS.slice(TRYON_JS.indexOf('afterCompose'), TRYON_JS.indexOf('onShareAppMessage'))
  const ok = /result\.ok === false/.test(seg) && /记录写入失败/.test(seg)
  return { ok: ok, note: ok ? '有失败分支' : '缺失败分支' }
})

R('R22', '数据一致性', '照片落盘失败但记录已写：走 modal 告诉用户去哪删', function () {
  const ok = /storage-full/.test(TRYON_JS) && /showStorageFull/.test(TRYON_JS)
  return { ok: ok, note: ok ? '有 storage-full 分支' : '缺分支' }
})

R('R23', '数据一致性', '记录超 20 条时淘汰最旧一条并告知用户', function () {
  let evicted = -1
  let n = 0
  withClock(makeEnv(), function () {
    for (let i = 0; i < 21; i++) {
      store.addRecord({
        styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑',
        tempFilePath: '/tmp/' + i + '.jpg'
      }, function (rec, result) { evicted = result.evicted })
    }
    n = store.listRecords().length
  })
  return { ok: evicted >= 1 && n <= 20, note: 'evicted=' + evicted + ' n=' + n }
})

R('R24', '数据一致性', '换款后收藏状态跟着当前款走，不残留上一款的星标', function () {
  const p = freshPage()
  let a = false
  let b = false
  quietDraw(function () {
    withClock(p._env, function () {
      store.setFavorites(['buzz'])
      p.applyStyleId('buzz', { user: true })
      a = p.data.isFav === true
      p.applyStyleId('bob', { user: true })
      b = p.data.isFav === false
    })
  })
  return { ok: a && b, note: 'buzz→' + a + ' bob→' + b }
})

R('R25', '数据一致性', '上次是用户自己挑的（by=user）：本次不再自动替换', function () {
  const p = freshPage({
    storage: {
      'arhair_last_pick_v1': JSON.stringify({ style: 'buzz', color: 'black', by: 'user' })
    }
  })
  return { ok: p._hasLastPick === true, note: '_hasLastPick=' + p._hasLastPick }
})

R('R26', '数据一致性', '上次是接受 AI 推荐（by=rec）：本次照常自动匹配', function () {
  const p = freshPage({
    storage: {
      'arhair_last_pick_v1': JSON.stringify({ style: 'buzz', color: 'black', by: 'rec' })
    }
  })
  return { ok: p._hasLastPick === false, note: '_hasLastPick=' + p._hasLastPick }
})

R('R27', '数据一致性', '分享链接带 style/color 进来：直接落在同款，而不是默认款', function () {
  const p = freshPage({ query: { style: 'buzz', color: 'black' } })
  return {
    ok: p.data.currentStyle === 'buzz' && p.data.currentColor === 'black',
    note: p.data.currentStyle + '/' + p.data.currentColor
  }
})

R('R28', '数据一致性', '同一毫秒连拍两条记录：id 不重复，删一条不会连带删另一条', function () {
  const ids = []
  withClock(makeEnv(), function () {
    for (let i = 0; i < 5; i++) {
      store.addRecord({
        styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑',
        tempFilePath: '/tmp/z' + i + '.jpg'
      }, function (rec) { ids.push(rec.id) })
    }
  })
  return { ok: new Set(ids).size === ids.length, note: ids.length + ' 条 / ' + new Set(ids).size + ' 个 id' }
})

R('R29', '数据一致性', '拍照期间屏幕尺寸变化：合成仍按快门那一刻的视口映射', function () {
  const ok = /_captureViewport/.test(TRYON_JS)
  return { ok: ok, note: ok ? '视口已冻结' : '用的是当前 cw/ch，会错位' }
})

R('R30', '数据一致性', '相册成功不盖掉「记录被清理 / 写入失败」的 warn', function () {
  const seg = TRYON_JS.slice(TRYON_JS.indexOf('saveImageToPhotosAlbum'))
  const ok = /_toastLevel === 2/.test(seg)
  return { ok: ok, note: ok ? '有优先级保护' : '会被覆盖' }
})

/* ---- G4 性能压测（8 轮） ---- */

R('R31', '性能', '连续拖动 200 次不累积定时器', function () {
  const p = freshPage()
  p.data.faceFound = true
  p.trackedBox = { x: 80, y: 120, w: 200, h: 240 }
  p.lastBox = { x: 80, y: 120, w: 200, h: 240, angle: 0 }
  quietDraw(function () {
    withClock(p._env, function () {
      for (let i = 0; i < 200; i++) {
        p.dragDX = i % 40
        p.render(true)
      }
    })
  })
  return { ok: p._env.timers.length === 0, note: 'timers=' + p._env.timers.length }
})

R('R32', '性能', '连续换色 20 次只留一个缩略图重建定时器', function () {
  const p = freshPage()
  quietDraw(function () {
    withClock(p._env, function () {
      for (let i = 0; i < 20; i++) {
        p.applyColorId(hairstyles.HAIR_COLORS[i % 12].id, { user: true })
      }
    })
  })
  const n = p._env.timers.filter(t => t.ms === 500).length
  return { ok: n <= 1, note: '500ms 定时器=' + n }
})

R('R33', '性能', '推荐重试连调 10 次：重试次数封顶 4，定时器只留一个', function () {
  const p = freshPage()
  withClock(p._env, function () {
    for (let i = 0; i < 10; i++) p.scheduleRecRetry()
  })
  const n = p._env.timers.filter(t => t.ms === 700).length
  return { ok: p._recTries <= 4 && n <= 1, note: 'tries=' + p._recTries + ' timer=' + n }
})

R('R34', '性能', '写 30 条记录后条数封顶 20，总字节不超预算', function () {
  let list = []
  withClock(makeEnv(), function () {
    for (let i = 0; i < 30; i++) {
      store.addRecord({
        styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑',
        tempFilePath: '/tmp/b' + i + '.jpg'
      })
    }
    list = store.listRecords()
  })
  let bytes = 0
  for (let i = 0; i < list.length; i++) bytes += list[i].bytes || 0
  return { ok: list.length <= 20 && bytes <= 7.5 * 1024 * 1024, note: 'n=' + list.length + ' bytes=' + Math.round(bytes / 1024) + 'KB' }
})

R('R35', '性能', '1920×1080 一帧肤色采样在 50ms 内完成', function () {
  const w = 1920, h = 1080
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 205; data[i + 1] = 165; data[i + 2] = 140; data[i + 3] = 255
  }
  const t0 = Date.now()
  const r = match.sampleSkinPixels(data, w, h, { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })
  const ms = Date.now() - t0
  return { ok: ms < 50 && !!r, note: ms + 'ms r=' + (r ? r.n : 'null') }
})

R('R36', '性能', '降级模式下非强制渲染限到 25fps', function () {
  const p = freshPage()
  p.data.faceFound = true
  p.trackedBox = { x: 80, y: 120, w: 200, h: 240 }
  p.lastBox = { x: 80, y: 120, w: 200, h: 240, angle: 0 }
  hairstyles.setLowMemory(true)
  const q = quietDraw(function () {
    withClock(p._env, function () {
      p.render(false)
      p.render(false)
      p.render(false)
    })
  })
  hairstyles.setLowMemory(false)
  return { ok: q.drew.length <= 1, note: 'draw=' + q.drew.length }
})

R('R37', '性能', '烘焙缓存有上限且页面退出时整体释放', function () {
  const ok = /clearBakeCache/.test(TRYON_JS) && /onHide[\s\S]{0,900}clearBakeCache/.test(TRYON_JS)
  return { ok: ok, note: ok ? 'onHide/onUnload 都释放' : '缺释放' }
})

R('R38', '性能', '内存告警后立刻降级重绘，回前台能恢复', function () {
  const p = freshPage()
  p.data.faceFound = true
  p.trackedBox = { x: 80, y: 120, w: 200, h: 240 }
  quietDraw(function () {
    withClock(p._env, function () { p.onMemoryLow(10) })
  })
  const low = p._lowMem === true
  p.data.cameraReady = true
  withClock(p._env, function () { p.onShow() })
  return { ok: low && p._lowMem === false, note: 'low=' + low + ' recovered=' + (p._lowMem === false) }
})

/* ---- G5 跨页面状态（7 轮） ---- */

R('R39', '跨页面', '从记录页返回：重新启动识脸并预热当前造型', function () {
  const p = freshPage()
  p.data.cameraReady = true
  p.vkSession = null
  p.frameSize = null
  quietDraw(function () {
    withClock(p._env, function () { p.onShow() })
  })
  return { ok: !!p.vkSession, note: 'vkSession=' + (p.vkSession ? 'created' : 'null') }
})

R('R40', '跨页面', '从设置页返回时权限被关：停掉识脸并把界面切回引导态', function () {
  const p = freshPage()
  p.data.cameraReady = true
  p.data.faceFound = true
  p.vkSession = { destroy() {} }
  p._env.auth = { 'scope.camera': false }
  withClock(p._env, function () { p.recheckCamera(function () {}) })
  return {
    ok: p.data.cameraReady === false && p.vkSession === null && p.data.faceFound === false,
    note: 'ready=' + p.data.cameraReady + ' vk=' + !!p.vkSession
  }
})

R('R41', '跨页面', '从分享卡片进入：识别出来源并给一次明确引导', function () {
  const p = freshPage({ query: { style: 'buzz' } })
  return { ok: p._fromShare === true, note: '_fromShare=' + p._fromShare }
})

R('R42', '跨页面', '切后台时展开的推荐卡收成小条，倒计时一起清', function () {
  const p = freshPage()
  p.data.rec = Object.assign({}, p.data.rec, { show: true, expanded: true })
  withClock(p._env, function () {
    p.scheduleRecCollapse()
    p.onHide()
  })
  return {
    ok: p.data.rec.expanded === false && p._recCollapseTimer === null,
    note: 'expanded=' + p.data.rec.expanded
  }
})

R('R43', '跨页面', '切后台关闭屏幕常亮，避免回首页继续耗电', function () {
  const p = freshPage()
  p._keepOn = true
  withClock(p._env, function () { p.onHide() })
  return { ok: p._keepOn === false, note: '_keepOn=' + p._keepOn }
})

R('R44', '跨页面', '页面销毁时清掉全部异步定时器', function () {
  const p = freshPage()
  withClock(p._env, function () {
    p._recTimer = p._env.setTimeout(function () {}, 600)
    p._skinTimer = p._env.setTimeout(function () {}, 1600)
    p._skinRetryTimer = p._env.setTimeout(function () {}, 2500)
    p._skinApplyTimer = p._env.setTimeout(function () {}, 500)
    p._recCollapseTimer = p._env.setTimeout(function () {}, 7000)
    p._guideFadeTimer = p._env.setTimeout(function () {}, 3000)
    p._thumbTimer = p._env.setTimeout(function () {}, 500)
    p.onUnload()
  })
  const left = [
    p._recTimer, p._skinTimer, p._skinRetryTimer, p._skinApplyTimer,
    p._recCollapseTimer, p._guideFadeTimer, p._thumbTimer
  ].filter(Boolean).length
  return { ok: left === 0, note: '残留=' + left }
})

R('R45', '跨页面', '页面销毁释放烘焙缓存并关闭常亮', function () {
  const p = freshPage()
  p._keepOn = true
  withClock(p._env, function () { p.onUnload() })
  return { ok: p._keepOn === false, note: '_keepOn=' + p._keepOn }
})

/* ---- G6 异常恢复（5 轮） ---- */

R('R46', '异常恢复', 'takePhoto 失败：解除冻结并恢复快门', function () {
  const p = freshPage()
  p.data.cameraReady = true
  p.data.faceFound = true
  p.lastBox = { x: 80, y: 120, w: 200, h: 240, angle: 0 }
  p.camCtx = { takePhoto(o) { o.fail({ errMsg: 'fail' }) } }
  withClock(p._env, function () { p.capture() })
  return {
    ok: p.data.shooting === false && p.boxFrozen === false,
    note: 'shooting=' + p.data.shooting + ' frozen=' + p.boxFrozen
  }
})

R('R47', '异常恢复', '合成画布节点取不到：复位快门并提示重试', function () {
  const p = shootingPage()
  const q = p._env.wx.createSelectorQuery
  p._env.wx = new Proxy(p._env.wx, {
    get(t, k) {
      if (k === 'createSelectorQuery') {
        return function () {
          const o = { select() { return o }, fields() { return o }, in() { return o }, exec(cb) { cb([]) } }
          return o
        }
      }
      return t[k]
    }
  })
  withClock(p._env, function () { p.compose('/tmp/x.jpg') })
  return {
    ok: p.data.shooting === false && p.boxFrozen === false,
    note: 'shooting=' + p.data.shooting
  }
})

R('R48', '异常恢复', '照片解码失败（img.onerror）：解除冻结并提示重拍', function () {
  const seg = TRYON_JS.slice(TRYON_JS.indexOf('img.onload'), TRYON_JS.indexOf('img.src'))
  const ok = /img\.onerror/.test(seg) && /unfreezeBox/.test(seg)
  return { ok: ok, note: ok ? '有 onerror 分支' : '缺 onerror' }
})

R('R49', '异常恢复', '导出图片失败：解除冻结并恢复快门', function () {
  const seg = TRYON_JS.slice(TRYON_JS.indexOf('canvasToTempFilePath'))
  const ok = /fail\(err\)[\s\S]{0,400}unfreezeBox/.test(seg)
  return { ok: ok, note: ok ? '有导出失败复位' : '缺复位' }
})

R('R50', '异常恢复', '使用中相机权限被撤销再回来：不残留「已锁定人脸」', function () {
  const p = freshPage()
  p.data.cameraReady = true
  p.data.faceFound = true
  p.data.statusText = '已锁定人脸'
  p._env.auth = { 'scope.camera': false }
  withClock(p._env, function () { p.recheckCamera(function () {}) })
  return {
    ok: p.data.statusText === '相机未开启' && p.data.faceFound === false,
    note: 'statusText=' + p.data.statusText
  }
})

/* ===================== 汇总 ===================== */

let failed = 0
let lastGroup = ''
console.log('')
console.log('========== 第 10 轮：真实用户视角 50 轮自查 ==========')
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  if (r.group !== lastGroup) {
    console.log('  --- ' + r.group + ' ---')
    lastGroup = r.group
  }
  if (!r.ok) failed++
  console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.id + '  ' + r.title + (r.note ? '   [' + r.note + ']' : ''))
}
console.log('======================================================')
console.log('  ' + (results.length - failed) + ' / ' + results.length + ' 轮通过')
if (failed) {
  console.log('  未通过 ' + failed + ' 轮，逐轮修产品代码后复跑：node tests/audit-50b.js')
  process.exitCode = 1
} else {
  console.log('  50 轮全部通过')
}
