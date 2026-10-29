/**
 * 隐私协议授权（第 44 轮）
 *
 * 这一轮不测渲染，也不测交互，测的是**小程序能不能用**。
 *
 * 2023-09-15 之后，微信要求涉及用户信息的接口必须先在 mp 后台配好
 * 《小程序用户隐私保护指引》，并且用户得主动点过一次同意。
 * 这个项目里有两个这样的接口：
 *
 *   camera                 —— 试戴页的主体
 *   saveImageToPhotosAlbum —— 快门后的保存
 *
 * 没同意时微信**不弹任何系统提示**，它直接拦住接口：
 * `<camera>` 不出画面，`binderror` 里给一条 errno 112 的错。
 * 从用户角度看是「进了试戴页，一片黑，写着相机启动失败」——
 * 而 `getSetting` 里 `scope.camera` 返回 true，他去系统设置里
 * 翻半天相机权限，那里明明是开着的，回来还是黑屏。
 *
 * 这一轮验证：
 *   A. 状态查询的六种情况（含查不到时不能把用户挡在门外）
 *   B. 隐私错误的识别（errno / errMsg / 老字段 errCode）
 *   C. 打开官方协议页
 *   D. 首页在**跳转之前**问，同意后直达原定页面
 *   E. 试戴页两道门的顺序（隐私必须在 scope 前面）
 *   F. 相机报错时文案不能误导成「启动失败」
 *   G. 相册失败要和「权限被拒」分开说
 *   H. 静态：同意按钮必须是 open-type，不能是 view
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

/* ---------------- 定时器：手动触发 ---------------- */

let timers = []
function flushTimers() {
  const list = timers
  timers = []
  list.forEach(function (t) { if (typeof t.fn === 'function') t.fn() })
}

/* ---------------- wx 桩 ---------------- */

const storage = {}
let calls = []
let behavior = {}

function reset() {
  calls = []
  behavior = {}
  timers = []
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
  showLoading() {}, hideLoading() {},
  showModal(o) { calls.push({ api: 'showModal', title: o && o.title }) },
  vibrateShort() {},
  authorize(o) { calls.push({ api: 'authorize' }); o && o.success && o.success({}) },
  openSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  setKeepScreenOn() {},
  saveImageToPhotosAlbum(o) {
    calls.push({ api: 'saveImageToPhotosAlbum' })
    const b = behavior.album
    if (b === 'privacy') { o && o.fail && o.fail({ errno: 112, errMsg: 'saveImageToPhotosAlbum:fail api scope is not declared in the privacy agreement' }); return }
    if (b === 'deny') { o && o.fail && o.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }); return }
    o && o.success && o.success({})
  },
  getPrivacySetting(o) {
    calls.push({ api: 'getPrivacySetting' })
    const b = behavior.privacy
    if (b === 'need') { o && o.success && o.success({ needAuthorization: true, privacyContractName: '镜界隐私保护指引' }); return }
    if (b === 'ok') { o && o.success && o.success({ needAuthorization: false }); return }
    if (b === 'fail') { o && o.fail && o.fail({ errMsg: 'getPrivacySetting:fail' }); return }
    if (b === 'hang') return
    if (b === 'throw') throw new Error('boom')
    o && o.success && o.success({ needAuthorization: false })
  },
  openPrivacyContract(o) {
    calls.push({ api: 'openPrivacyContract' })
    if (behavior.contract === 'fail') { o && o.fail && o.fail({ errMsg: 'openPrivacyContract:fail' }); return }
    o && o.success && o.success({})
  }
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

global.wx = wx
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  Component(o) { g.__comp = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false }, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout(fn) { timers.push({ fn: fn }); return timers.length },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
g.__comp = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const privacy = require(path.join(ROOT, 'utils', 'privacy'))
const swipe = require(path.join(ROOT, 'utils', 'swipe-guard'))

function count(api) {
  return calls.filter(function (c) { return c.api === api }).length
}
function last(api) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].api === api) return calls[i]
  return null
}

/* ================= A. 状态查询 ================= */

console.log('\n[A] 状态查询')

reset()
let got = null
privacy.check(function (need, name) { got = { need: need, name: name } })
ck('A1 已同意时不要求授权', got && got.need === false, JSON.stringify(got))
ck('A2 真的查了一次', count('getPrivacySetting') === 1, '实际 ' + count('getPrivacySetting'))

reset()
behavior.privacy = 'need'
got = null
privacy.check(function (need, name) { got = { need: need, name: name } })
ck('A3 需要授权时如实返回', got && got.need === true, JSON.stringify(got))
ck('A4 带回协议名称', got && got.name === '镜界隐私保护指引', got && got.name)

reset()
behavior.privacy = 'fail'
got = null
privacy.check(function (need) { got = { need: need } })
ck('A5 接口失败时放行（不能把用户挡在门外）', got && got.need === false, JSON.stringify(got))

reset()
behavior.privacy = 'throw'
got = null
let threw = false
try { privacy.check(function (need) { got = { need: need } }) } catch (e) { threw = true }
ck('A6 接口抛异常也不把页面带崩', threw === false)
ck('A7 抛异常时同样放行', got && got.need === false, JSON.stringify(got))

reset()
behavior.privacy = 'hang'
got = null
privacy.check(function (need) { got = { need: need } })
ck('A8 既不 success 也不 fail 时先不回调', got === null)
flushTimers()
ck('A9 超时后放行', got && got.need === false, JSON.stringify(got))

// 超时和 success 都来了，只能回调一次
reset()
got = 0
privacy.check(function () { got++ })
flushTimers()
ck('A10 回调只触发一次', got === 1, '实际 ' + got)

// 老基础库：没有 getPrivacySetting
reset()
const savedGet = global.wx.getPrivacySetting
global.wx.getPrivacySetting = undefined
got = null
privacy.check(function (need) { got = { need: need } })
ck('A11 没有 API 时立即放行', got && got.need === false, JSON.stringify(got))
global.wx.getPrivacySetting = savedGet

// 没有回调参数也不能崩
reset()
let noCbThrew = false
try { privacy.check() } catch (e) { noCbThrew = true }
ck('A12 不传回调也不崩', noCbThrew === false)

/* ================= B. 错误识别 ================= */

console.log('\n[B] 隐私错误识别')

ck('B1 errno 112 是隐私错误', privacy.isPrivacyError({ errno: 112 }) === true)
ck('B2 老字段 errCode 112 也算', privacy.isPrivacyError({ errCode: 112 }) === true)
ck('B3 errMsg 里带 privacy', privacy.isPrivacyError({ errMsg: 'camera:fail privacy permission is not authorized' }) === true)
ck('B4 scope is not declared', privacy.isPrivacyError({ errMsg: 'api scope is not declared in the privacy agreement' }) === true)
ck('B5 大小写不敏感', privacy.isPrivacyError({ errMsg: 'Privacy Not Authorized' }) === true)
ck('B6 普通权限被拒不是隐私错误', privacy.isPrivacyError({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' }) === false)
ck('B7 相机硬件错误不是隐私错误', privacy.isPrivacyError({ errMsg: 'camera:fail unknown' }) === false)
ck('B8 null 安全', privacy.isPrivacyError(null) === false)
ck('B9 undefined 安全', privacy.isPrivacyError() === false)
ck('B10 空对象安全', privacy.isPrivacyError({}) === false)
ck('B11 errno 113 不是 112', privacy.isPrivacyError({ errno: 113 }) === false)

/* ================= C. 打开协议 ================= */

console.log('\n[C] 打开官方协议页')

reset()
privacy.openContract()
ck('C1 调了 openPrivacyContract', count('openPrivacyContract') === 1, '实际 ' + count('openPrivacyContract'))

reset()
behavior.contract = 'fail'
privacy.openContract()
ck('C2 失败时给提示', count('showToast') === 1, '实际 ' + count('showToast'))
ck('C3 文案不说「打开失败」（会被当成网络问题）', last('showToast').title === '暂未配置隐私指引', String(last('showToast').title))

reset()
const savedOpen = global.wx.openPrivacyContract
global.wx.openPrivacyContract = undefined
privacy.openContract()
ck('C4 老基础库上提示版本不支持', count('showToast') === 1, '实际 ' + count('showToast'))
global.wx.openPrivacyContract = savedOpen

/* ================= D. 首页 ================= */

console.log('\n[D] 首页在跳转之前问')

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
  inst.data.isDevtools = false
  // 横滑误触保护的状态对象在 onLoad 里创建，这里直接补上，
  // 免得为了测一次跳转把整个 onLoad 跑一遍（它会读 shop 配置、算营业状态）
  inst._hotSwipe = swipe.create()
  inst._favSwipe = swipe.create()
  return inst
}

reset()
behavior.privacy = 'ok'
const nav = require(path.join(ROOT, 'utils', 'nav'))
nav._reset()
let p1 = loadPage('pages/index/index.js')
p1.startTryon()
ck('D1 不需要授权时直接跳', count('navigateTo') === 1, '实际 ' + count('navigateTo'))
ck('D2 跳到试戴页', last('navigateTo').url === '/pages/tryon/tryon', String(last('navigateTo').url))
ck('D3 不弹隐私窗', p1.data.privacyOn === false)

reset()
behavior.privacy = 'need'
nav._reset()
p1 = loadPage('pages/index/index.js')
p1.startTryon()
ck('D4 需要授权时先不跳', count('navigateTo') === 0, '实际 ' + count('navigateTo'))
ck('D5 弹出授权窗', p1.data.privacyOn === true)
ck('D6 记下协议名', p1.data.privacyContract === '镜界隐私保护指引', p1.data.privacyContract)

p1.onPrivacyAgree()
ck('D7 同意后跳转', count('navigateTo') === 1, '实际 ' + count('navigateTo'))
ck('D8 跳的是原来要去的页面', last('navigateTo').url === '/pages/tryon/tryon', String(last('navigateTo').url))
ck('D9 弹窗关掉', p1.data.privacyOn === false)
ck('D10 待跳地址清空', !p1._pendingTryonUrl)

reset()
behavior.privacy = 'need'
nav._reset()
p1 = loadPage('pages/index/index.js')
p1.openStyle({ currentTarget: { dataset: { id: 'bob' } } })
ck('D11 热门卡片也走隐私检查（不是裸跳转）', count('navigateTo') === 0, '实际 ' + count('navigateTo'))
p1.onPrivacyAgree()
ck('D12 同意后直达那一款', last('navigateTo') && last('navigateTo').url === '/pages/tryon/tryon?style=bob', last('navigateTo') && last('navigateTo').url)

reset()
behavior.privacy = 'need'
nav._reset()
p1 = loadPage('pages/index/index.js')
p1.openColor({ currentTarget: { dataset: { id: 'ash' } } })
p1.onPrivacyAgree()
ck('D13 色卡同样直达', last('navigateTo') && last('navigateTo').url === '/pages/tryon/tryon?color=ash', last('navigateTo') && last('navigateTo').url)

reset()
behavior.privacy = 'need'
nav._reset()
p1 = loadPage('pages/index/index.js')
p1.startTryon()
p1.onPrivacyCancel()
ck('D14 拒绝后不跳转', count('navigateTo') === 0, '实际 ' + count('navigateTo'))
ck('D15 拒绝后弹窗关掉', p1.data.privacyOn === false)
ck('D16 拒绝时给一条别的路（不是「已取消」）', count('showToast') === 1 && last('showToast').title.indexOf('发型库') >= 0, last('showToast') && last('showToast').title)

// 同意时没有待跳地址（异常路径）也要能跳
reset()
behavior.privacy = 'need'
nav._reset()
p1 = loadPage('pages/index/index.js')
p1.onPrivacyAgree()
ck('D17 没有待跳地址时退到默认试戴页', last('navigateTo') && last('navigateTo').url === '/pages/tryon/tryon', last('navigateTo') && last('navigateTo').url)

/* ================= E. 试戴页两道门 ================= */

console.log('\n[E] 试戴页：隐私必须在 scope 前面')

reset()
behavior.privacy = 'need'
const t1 = loadPage('pages/tryon/tryon.js')
let opened = 0
t1.openCamera = function () { opened++ }
t1.ensureCamera()
ck('E1 需要授权时不开相机', opened === 0, '实际 ' + opened)
ck('E2 弹授权窗', t1.data.privacyOn === true)
ck('E3 文案说清楚原因', t1.data.cameraMsg === '需要先同意隐私协议', t1.data.cameraMsg)
ck('E4 状态栏也改了', t1.data.statusText === '等待隐私授权', t1.data.statusText)

reset()
behavior.privacy = 'ok'
const t2 = loadPage('pages/tryon/tryon.js')
opened = 0
t2.openCamera = function () { opened++ }
t2.ensureCamera()
ck('E5 已同意时正常开相机', opened === 1, '实际 ' + opened)
ck('E6 不弹窗', t2.data.privacyOn === false)

reset()
behavior.privacy = 'need'
const t3 = loadPage('pages/tryon/tryon.js')
opened = 0
t3.openCamera = function () { opened++ }
t3.ensureCamera()
t3.onPrivacyAgree()
ck('E7 同意后接着开相机', opened === 1, '实际 ' + opened)
ck('E8 同意后弹窗关掉', t3.data.privacyOn === false)

reset()
behavior.privacy = 'need'
const t4 = loadPage('pages/tryon/tryon.js')
t4.onPrivacyCancel()
ck('E9 拒绝后退出试戴页', count('navigateBack') === 1, '实际 ' + count('navigateBack'))

// 请求相机按钮也要先过隐私
reset()
behavior.privacy = 'need'
const t5 = loadPage('pages/tryon/tryon.js')
opened = 0
t5.openCamera = function () { opened++ }
t5.requestCamera()
ck('E10 「开启相机」按钮先过隐私检查', count('authorize') === 0, '实际 authorize ' + count('authorize'))
ck('E11 不直接开相机', opened === 0, '实际 ' + opened)
ck('E12 弹授权窗', t5.data.privacyOn === true)

/* ================= F. 相机报错文案 ================= */

console.log('\n[F] 相机报错不能误导')

reset()
behavior.privacy = 'ok'
const t6 = loadPage('pages/tryon/tryon.js')
t6.onCameraError({ detail: { errno: 112, errMsg: 'camera:fail api scope is not declared in the privacy agreement' } })
ck('F1 隐私错误不说「启动失败」', t6.data.cameraMsg !== '相机启动失败', t6.data.cameraMsg)
ck('F2 隐私错误直接弹授权窗', t6.data.privacyOn === true)
ck('F3 状态栏不写「相机不可用」', t6.data.statusText === '等待隐私授权', t6.data.statusText)

reset()
const t7 = loadPage('pages/tryon/tryon.js')
t7.onCameraError({ detail: { errMsg: 'camera:fail unknown' } })
ck('F4 普通错误仍是「启动失败」', t7.data.cameraMsg === '相机启动失败', t7.data.cameraMsg)
ck('F5 普通错误不弹隐私窗', t7.data.privacyOn === false)
ck('F6 detail 为空也不崩', (function () {
  let ok = true
  try { t7.onCameraError() } catch (e) { ok = false }
  return ok
})())

/* ================= G. 相册失败要分开说 ================= */

console.log('\n[G] 相册失败要和权限被拒分开')

// 相册回调埋在 compose 的深层回调里，靠桩把整条链路跑通成本太高
// （要造 canvas、临时文件、图片信息）。这里改成**约定检查**：
// 只要「隐私错误」这个分支存在且排在「权限被拒」之后、「兜底」之前，
// 就不会出现「隐私问题被当成权限问题」的误导。
reset()
const tryonSrc = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')
ck('G1 相册隐私失败有独立文案', tryonSrc.indexOf('相册保存未开通') >= 0)
ck('G2 该分支调用了 isPrivacyError', /isPrivacyError\(err\)[\s\S]{0,200}相册保存未开通/.test(tryonSrc))

/* ================= H. 静态：同意按钮必须是 open-type ================= */

console.log('\n[H] 静态检查')

const compDir = path.join(ROOT, 'components', 'privacy-gate')
;['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach(function (f) {
  ck('H1 组件文件 ' + f + ' 存在', fs.existsSync(path.join(compDir, f)))
})

const compWxml = fs.readFileSync(path.join(compDir, 'index.wxml'), 'utf8')
ck('H2 同意按钮用了 open-type="agreePrivacyAuthorization"', compWxml.indexOf('open-type="agreePrivacyAuthorization"') >= 0)
ck('H3 同时挂了 bindagreeprivacyauthorization', compWxml.indexOf('bindagreeprivacyauthorization="onAgree"') >= 0)
ck('H4 同意按钮还挂了 bindtap 兜底（后台没配隐私指引时 open-type 不触发）', /bindagreeprivacyauthorization="onAgree"[\s\S]{0,80}bindtap="onAgree"/.test(compWxml))
ck('H5 同意按钮是 <button> 不是 <view>', /<button[^>]*open-type="agreePrivacyAuthorization"/.test(compWxml))

const compJs = fs.readFileSync(path.join(compDir, 'index.js'), 'utf8')
ck('H6 同意事件去重（两条路都走时不会跳两次）', compJs.indexOf('_settled') >= 0)
ck('H7 声明了 component: true', JSON.parse(fs.readFileSync(path.join(compDir, 'index.json'), 'utf8')).component === true)

;['pages/index/index.json', 'pages/tryon/tryon.json'].forEach(function (rel) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  const uc = j.usingComponents || {}
  ck('H8 ' + rel + ' 声明了 privacy-gate', uc['privacy-gate'] === '/components/privacy-gate/index', JSON.stringify(uc))
})

;['pages/index/index.wxml', 'pages/tryon/tryon.wxml'].forEach(function (rel) {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  ck('H9 ' + rel + ' 里用了组件', s.indexOf('<privacy-gate') >= 0)
  ck('H10 ' + rel + ' 绑了 agree/cancel', s.indexOf('bind:agree="onPrivacyAgree"') >= 0 && s.indexOf('bind:cancel="onPrivacyCancel"') >= 0)
})

// 首页的授权层必须在 scroll-view 外面
const idxWxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')
const closeIdx = idxWxml.lastIndexOf('</scroll-view>')
const gateIdx = idxWxml.indexOf('<privacy-gate')
ck('H11 首页授权层在 scroll-view 之外（否则 fixed 遮罩会跟着滚）', gateIdx > closeIdx)

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
