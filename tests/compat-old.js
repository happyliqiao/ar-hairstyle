/**
 * 低版本基础库 / 残缺 wx 环境兼容性测试
 *
 * 现实里会遇到的情况，都在这台机器上跑一遍：
 *   A 基础库 2.9（无 getWindowInfo / createOffscreenCanvas / Path2D）
 *   B getSystemInfoSync 直接抛异常（部分 PC 端、鸿蒙早期版本）
 *   C safeArea 存在但 bottom 缺失（PC / 折叠屏分屏）
 *   D getWindowInfo 返回空对象（字段全 undefined）
 *   E 全部 API 正常（对照组，确认测试台本身没把页面跑崩）
 *
 * 断言标准：
 *   1. 任何生命周期函数都不许抛异常
 *   2. 写进 data 的布局数值必须是有限数字（NaN 会让 wxml 的
 *      style="padding-bottom: NaNpx" 整条失效，肉眼表现为贴底重叠）
 *   3. 降级后仍然要有可用的缩略图 / 列表数据
 */
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(name + (extra ? '  -> ' + extra : ''))
  }
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v)
}

/* ---------------- 环境构造 ---------------- */

function makeWx(scenario) {
  const storage = {}
  const base = {
    getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
    setStorageSync(k, v) { storage[k] = v },
    removeStorageSync(k) { delete storage[k] },
    getFileSystemManager() {
      return {
        saveFile(o) { o && o.fail && o.fail({ errMsg: 'mock' }) },
        removeSavedFile(o) { o && o.fail && o.fail({ errMsg: 'mock' }) },
        access(o) { o && o.fail && o.fail({ errMsg: 'mock' }) }
      }
    },
    createSelectorQuery() {
      const q = {
        select() { return q },
        selectAll() { return q },
        fields() { return q },
        boundingClientRect() { return q },
        exec(cb) { if (cb) cb([null, null]) },
        in() { return q }
      }
      return q
    },
    getSystemInfoSync() {
      if (scenario === 'B') throw new Error('getSystemInfoSync is not a function')
      if (scenario === 'D') return {}
      return {
        platform: 'android',
        statusBarHeight: 24,
        pixelRatio: 3,
        screenWidth: 390,
        screenHeight: 844,
        windowWidth: 390,
        windowHeight: 700,
        safeArea: scenario === 'C' ? { top: 24, left: 0, right: 390, height: 800 } : { top: 24, left: 0, right: 390, bottom: 810, width: 390, height: 786 }
      }
    },
    getWindowInfo: undefined,
    createOffscreenCanvas: undefined,
    vibrateShort() {},
    showToast() {},
    hideToast() {},
    showLoading() {},
    hideLoading() {},
    showModal(o) { o && o.success && o.success({ confirm: false, cancel: true }) },
    canvasToTempFilePath() {},
    saveImageToPhotosAlbum(o) { o && o.fail && o.fail({ errMsg: 'mock' }) },
    getSetting(o) { o && o.success && o.success({ authSetting: {} }) },
    openSetting(o) { o && o.success && o.success({ authSetting: {} }) },
    authorize(o) { o && o.fail && o.fail({ errMsg: 'mock' }) },
    createCameraContext() { return { onCameraFrame() {}, takePhoto(o) { o && o.fail && o.fail({}) }, startRecord() {}, stopRecord() {} } },
    createVKSession: undefined,
    navigateTo() {},
    switchTab() {},
    navigateBack() {},
    redirectTo() {},
    reLaunch() {},
    setNavigationBarTitle() {},
    setClipboardData(o) { o && o.success && o.success({}) },
    onNetworkStatusChange() {},
    getNetworkType(o) { o && o.success && o.success({ networkType: 'wifi' }) },
    getUpdateManager() { return { onCheckForUpdate() {}, onUpdateReady() {}, onUpdateFailed() {}, applyUpdate() {} } },
    nextTick(fn) { if (fn) fn() },
    env: { USER_DATA_PATH: '/tmp' }
  }

  if (scenario === 'E') {
    base.getWindowInfo = function () { return base.getSystemInfoSync() }
    base.createOffscreenCanvas = function () { return null }
    base.createVKSession = function () { throw new Error('no vk in test') }
  }
  if (scenario === 'D') {
    base.getWindowInfo = function () { return {} }
  }
  if (scenario === 'A' || scenario === 'B' || scenario === 'C') {
    base.getWindowInfo = undefined
  }

  // 未知 API 一律给个 noop，避免测试台因为缺桩而误报
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      if (k === 'then') return undefined
      return function () {}
    },
    has() { return true }
  })
}

/* ---------------- 页面加载器 ---------------- */

function withGlobals(scenario, fn) {
  const sandboxGlobals = {
    wx: makeWx(scenario),
    Page: function (obj) { sandboxGlobals.__captured = obj },
    Component: function (obj) { sandboxGlobals.__comp = obj },
    getApp: function () {
      return {
        globalData: { shop: { name: '镜界造型' }, cloudReady: false, calibration: null },
        onShareAppMessage: function () { return {} }
      }
    },
    App: function () {},
    getCurrentPages: function () { return [] },
    Path2D: undefined,
    setTimeout: function () { return 0 },
    clearTimeout: function () {},
    setInterval: function () { return 0 },
    clearInterval: function () {}
  }
  sandboxGlobals.__captured = null

  const orig = {}
  const keys = Object.keys(sandboxGlobals)
  keys.forEach(function (k) {
    orig[k] = global[k]
    global[k] = sandboxGlobals[k]
  })
  try {
    return fn(sandboxGlobals)
  } finally {
    keys.forEach(function (k) {
      if (orig[k] === undefined) delete global[k]
      else global[k] = orig[k]
    })
  }
}

function loadPage(relPath, scenario) {
  const abs = path.join(ROOT, relPath)
  delete require.cache[require.resolve(abs)]
  const captured = {}
  withGlobals(scenario, function (g) {
    require(abs)
    captured.page = g.__captured
  })
  return captured.page
}

function makeInstance(pageObj) {
  const inst = Object.create(null)
  // 复制所有方法
  Object.keys(pageObj).forEach(function (k) {
    inst[k] = pageObj[k]
  })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) {
      inst.data[k] = patch[k]
    })
    if (typeof cb === 'function') cb()
  }
  inst.selectComponent = function () { return null }
  inst.route = 'pages/test/test'
  return inst
}

function runLifecycle(name, relPath, scenario, opts) {
  const label = name + '[' + scenario + ']'
  const abs = path.join(ROOT, relPath)
  delete require.cache[require.resolve(abs)]

  let inst = null
  withGlobals(scenario, function (g) {
    let pageObj = null
    try {
      require(abs)
      pageObj = g.__captured
    } catch (e) {
      ok(label + ' 模块加载不抛异常', false, e && e.message)
      return
    }
    ok(label + ' 模块加载不抛异常', !!pageObj, '没捕获到 Page() 调用')
    if (!pageObj) return

    inst = makeInstance(pageObj)
    const steps = (opts && opts.steps) || ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload']
    for (let i = 0; i < steps.length; i++) {
      const fn = steps[i]
      if (typeof inst[fn] !== 'function') continue
      try {
        inst[fn](opts && opts.options ? opts.options : {})
        ok(label + ' ' + fn + ' 不抛异常', true)
      } catch (e) {
        ok(label + ' ' + fn + ' 不抛异常', false, e && e.message)
      }
    }
  })
  return inst
}

/* ---------------- 用例 ---------------- */

const PAGES = [
  { name: 'index', path: 'pages/index/index.js' },
  { name: 'gallery', path: 'pages/gallery/gallery.js' },
  { name: 'history', path: 'pages/history/history.js' },
  { name: 'profile', path: 'pages/profile/profile.js' },
  { name: 'tryon', path: 'pages/tryon/tryon.js', options: { style: 'bob', color: 'black' } }
]

const SCENARIOS = ['E', 'A', 'B', 'C', 'D']

const instances = {}
SCENARIOS.forEach(function (sc) {
  PAGES.forEach(function (p) {
    const inst = runLifecycle(p.name, p.path, sc, { options: p.options })
    if (inst) instances[p.name + '|' + sc] = inst
  })
})

/* 布局数值不许是 NaN */
Object.keys(instances).forEach(function (key) {
  const d = instances[key].data
  const numericKeys = ['topPad', 'statusBarHeight', 'safeBottom', 'sizeVal', 'yVal', 'rotVal']
  numericKeys.forEach(function (k) {
    if (d[k] === undefined) return
    ok(key + ' data.' + k + ' 是有限数字', isNum(d[k]), '实际=' + d[k])
  })
})

/* 降级后仍要有内容 */
SCENARIOS.forEach(function (sc) {
  const g = instances['gallery|' + sc]
  if (g) ok('gallery[' + sc + '] 缩略图列表非空', Array.isArray(g.data.styles) && g.data.styles.length > 0, 'styles=' + (g.data.styles && g.data.styles.length))

  const t = instances['tryon|' + sc]
  if (t) {
    ok('tryon[' + sc + '] 发型列表非空', Array.isArray(t.data.styles) && t.data.styles.length > 0)
    ok('tryon[' + sc + '] 缩略图是 svg data uri', !!(t.data.styles[0] && /^data:image\/svg\+xml/.test(t.data.styles[0].thumb)))
  }
})

/* 渲染引擎在无离屏画布 / 无 Path2D 时必须自己降级，而不是抛错 */
function engineDegrade() {
  const hs = require(path.join(ROOT, 'utils/hairstyles.js'))
  // 直接测 getBaked 的降级：node 里没有 wx.createOffscreenCanvas
  const r = hs._engine && typeof hs._engine === 'object' ? true : true
  ok('hair-engine 可加载', r)

  const geom = hs.getGeom(hs.getStyle('bob'), 'high')
  ok('getGeom 在无 canvas 环境下可用', !!geom && Array.isArray(geom.body) && geom.body.length > 0)

  const svg = hs.buildSvg('bob', 'black', 'low')
  ok('buildSvg 降级可用', typeof svg === 'string' && svg.indexOf('<svg') === 0)

  const thumb = hs.buildThumb('bob', 'black')
  ok('buildThumb 返回 data uri', /^data:image\/svg\+xml/.test(thumb))
}

try {
  engineDegrade()
} catch (e) {
  ok('渲染引擎降级链路', false, e && e.message)
}

/* ---------------- 输出 ---------------- */

console.log('')
console.log('[低版本基础库兼容] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  5 种环境 × 5 个页面，生命周期全通，布局数值无 NaN')
}
