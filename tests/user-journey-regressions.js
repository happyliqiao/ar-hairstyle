// 用户视角 20 轮自查的行为回归。每段对应一个独立用户场景。
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const swipe = require(path.join(ROOT, 'utils/swipe-guard'))
let pass = 0, fail = 0
function ck(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' [' + detail + ']' : '')) }
}
const storage = {}
const state = { modals: [], toasts: [], album: null, albumMode: 'ok', frameCb: null, timers: [] }
function ctxMock() {
  const grad = { addColorStop() {} }
  return new Proxy({ createLinearGradient() { return grad }, createRadialGradient() { return grad } }, {
    get(t, k) { if (k in t) return t[k]; return function () {} }, set() { return true }
  })
}
global.Path2D = global.Path2D || class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }
const wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) {
    if (state.failRecordWrite && k === 'arhair_records_v1') throw new Error('quota')
    storage[k] = v
  },
  removeStorageSync(k) { delete storage[k] },
  getStorageInfoSync() { return { keys: Object.keys(storage) } },
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 2, safeArea: { bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, pixelRatio: 2 } },
  getMenuButtonBoundingClientRect() { return { bottom: 60, height: 32 } },
  getSetting(o) { o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getPrivacySetting(o) { o.success && o.success({ needAuthorization: false }) },
  getFileSystemManager() { return {
    getFileInfo(o) { o.success && o.success({ size: 1024 }) },
    saveFile(o) { o.success && o.success({ savedFilePath: 'store://photo-' + Math.random() + '.jpg' }) },
    removeSavedFile(o) { o.success && o.success({}) },
    getSavedFileList(o) { o.success && o.success({ fileList: [] }) }
  } },
  createOffscreenCanvas(o) { return { width: o.width, height: o.height, getContext() { return ctxMock() } } },
  createCameraContext() { return {
    onCameraFrame(cb) { state.frameCb = cb; return { stop() { state.listenerStopped = true } } },
    takePhoto(o) { state.takePhoto = o }
  } },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() { state.sessionDestroyed = true } } },
  createSelectorQuery() { const q = { select() { return q }, fields() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }; return q },
  saveImageToPhotosAlbum(o) {
    if (state.albumMode === 'defer') { state.album = o; return }
    if (state.albumMode === 'deny') o.fail && o.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
    else o.success && o.success({})
  },
  showModal(o) { state.modals.push(o) },
  showToast(o) { state.toasts.push(o && o.title) },
  makePhoneCall(o) { o.fail && o.fail({ errMsg: 'makePhoneCall:fail system' }) },
  showLoading() {}, hideLoading() {}, navigateTo() {}, switchTab() {}, navigateBack() {},
  setKeepScreenOn() {}, vibrateShort() {}
}, { get(t, k) { if (k in t) return t[k]; if (k === 'then') return undefined; return function () {} } })
global.wx = wx
global.getApp = () => ({ globalData: { shop: {} }, flushUpdate() {} })
global.getCurrentPages = () => []
global.setTimeout = (fn, ms) => { const t = { fn, ms }; state.timers.push(t); return t }
global.clearTimeout = t => { if (!t) return; const i = state.timers.indexOf(t); if (i >= 0) state.timers.splice(i, 1) }
global.setInterval = () => 0
global.clearInterval = () => {}
global.Page = o => { global.__page = o }

function reset() {
  for (const k in storage) delete storage[k]
  state.modals = []; state.toasts = []; state.album = null; state.albumMode = 'ok'
  state.frameCb = null; state.timers = []; state.failRecordWrite = false
  state.listenerStopped = false; state.sessionDestroyed = false
}
function load(name) {
  const abs = path.join(ROOT, 'pages', name, name + '.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = global.__page
  const p = {}
  Object.keys(po).forEach(k => { p[k] = po[k] })
  p.data = JSON.parse(JSON.stringify(po.data || {}))
  p.setData = function (v, cb) { Object.assign(p.data, v || {}); cb && cb() }
  p._alive = true
  return p
}
function tryon() {
  const p = load('tryon')
  p._stripSwipe = swipe.create(); p._colorSwipe = swipe.create()
  p._frontMirror = true; p.cw = 375; p.ch = 667; p.ctx = ctxMock()
  p.render = function () {}
  p.data.cameraReady = true; p.data.isDevtools = false
  p.lastBox = { x: 80, y: 100, w: 240, h: 288, angle: 0, mirror: true }
  return p
}

console.log('\n[01-03] 镜像、前后置偏好、触摸取消')
{
  const p = tryon()
  p.toggleMirror(); ck('01 用户可关闭前置镜像', p.data.mirrorX === false && p._frontMirror === false)
  p.toggleMirror(); p.switchCamera(); ck('02 后置临时关镜像', p.data.mirrorX === false)
  p.switchCamera(); ck('02 切回前置恢复原偏好', p.data.mirrorX === true)
  p.touchOrigin = { x: 1, y: 2 }; p._lastTapAt = 123
  p.onTouchCancel(); ck('03 touchcancel 清空拖动与双击状态', !p.touchOrigin && !p._lastTapAt)
}

console.log('\n[04-06] 拍照造型冻结、记录写入失败、相机异常')
{
  const p = tryon(); p.capture()
  p.data.currentStyle = 'curly'; p.data.currentColor = 'honey'; p.data.mirrorX = false
  ck('04 快门冻结的是旧造型', p._captureLook.style === 'bob' && p._captureLook.color === 'chestnut' && p._captureLook.mirror === true)
  p.afterCompose('/tmp/a.jpg', '')
  const records = JSON.parse(storage.arhair_records_v1)
  ck('04 记录仍写快门时的款式', records[0].styleId === 'bob' && records[0].colorId === 'chestnut')

  reset(); const q = tryon(); state.failRecordWrite = true
  q.afterCompose('/tmp/b.jpg', '')
  ck('05 写记录失败不再提示已存入', /记录写入失败/.test(q.data.toast), q.data.toast)

  reset(); const r = tryon(); r.vkSession = { destroy() { state.sessionDestroyed = true } }
  r.frameListener = { stop() { state.listenerStopped = true } }
  r.onCameraError({ detail: { errMsg: 'camera error' } })
  ck('06 相机异常停止会话和帧监听', state.sessionDestroyed && state.listenerStopped && !r.vkSession && !r.frameListener)
}

console.log('\n[07-10] 分享接收者、缩略图兜底、拍照中切换、迟到弹窗')
{
  const h = load('history')
  h.data.records = [{ id: 'r1', styleId: 'bob', colorId: 'black', styleName: '波波头', colorName: '自然黑', photoPath: 'store://p.jpg', thumbPath: 'store://t.jpg', createdAt: Date.now() }]
  const share = h.onShareAppMessage({ from: 'button', target: { dataset: { id: 'r1' } } })
  ck('07 分享落地到同款而非接收者不存在的本机记录', /^\/pages\/tryon\/tryon\?style=bob&color=black$/.test(share.path), share.path)
  h.onImgError({ currentTarget: { dataset: { id: 'r1' } } })
  ck('08 小图失效仍保留主图', h.data.records[0].photoPath === 'store://p.jpg' && h.data.records[0].thumbPath === '')
  h.onImgError({ currentTarget: { dataset: { id: 'r1' } } })
  ck('08 主图也失效才显示无照片', !h.data.records[0].photoPath)

  const p = tryon(); p.data.shooting = true; p.switchCamera()
  ck('09 拍照中不允许切摄像头', p.data.devicePosition === 'front' && /完成后再切换/.test(p.data.toast))

  reset(); const q = tryon(); state.albumMode = 'defer'
  q.afterCompose('/tmp/c.jpg', '')
  q._alive = false; state.album.fail({ errMsg: 'auth deny' })
  ck('10 离开页面后不再弹相册权限框', state.modals.length === 0)
}

console.log('\n[11-15] 无障碍、多人稳定、后置镜像、旧帧隔离')
{
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
  ck('11 三个微调滑块都有读屏名称', ['发型大小', '发型上下位置', '发型旋转角度'].every(s => wxml.indexOf('aria-label="' + s + '"') >= 0))
  const p = tryon()
  const a = { origin: { x: 100, y: 100 }, size: { width: 100, height: 120 } }
  const b = { origin: { x: 260, y: 100 }, size: { width: 150, height: 180 } }
  ck('12 第一张最大脸成为跟踪目标', p.pickFaceAnchor([a]) === a)
  ck('12 路人只大一帧时不跳目标', p.pickFaceAnchor([a, b]) === a)
  ck('12 新脸持续更大才切换', p.pickFaceAnchor([a, b]) === b)

  const r = tryon(); r.data.devicePosition = 'back'; r.data.mirrorX = true; r.frameSize = { w: 720, h: 1280 }
  const box = r.anchorToBox({ origin: { x: 100, y: 300 }, size: { width: 200, height: 250 } })
  r.data.mirrorX = false
  const plain = r.anchorToBox({ origin: { x: 100, y: 300 }, size: { width: 200, height: 250 } })
  const mirroredCx = box.x + box.w / 2
  const plainCx = plain.x + plain.w / 2
  ck('13 后置开启镜像也参与人脸定位', Math.abs(mirroredCx + plainCx - r.cw) < 0.001,
    mirroredCx + ' + ' + plainCx + ' != ' + r.cw)

  const q = tryon(); q.probeFrameSize(); const oldCb = state.frameCb
  q.switchCamera(); oldCb({ width: 720, height: 1280 })
  ck('15 旧摄像头迟到帧不污染新尺寸', q.frameSize === null)

  const dead = tryon(); dead._alive = false; dead.data.cameraReady = true
  dead.onCameraError({ detail: {} })
  ck('14 销毁后的相机异常不更新页面', dead.data.cameraReady === true)
}

console.log('\n[16-20] 连点、提示优先级、离开后的删除确认、电话失败')
{
  const p = tryon(); p.sizeVal = 137; p.data.sizeVal = 137
  p.pickStyle({ currentTarget: { dataset: { id: 'bob' } } })
  ck('16 重复点已选发型不清微调', p.sizeVal === 137 && p.data.sizeVal === 137)
  p.pickColor({ currentTarget: { dataset: { id: 'chestnut' } } })
  ck('17 重复点已选发色不重建缩略图', !p._thumbTimer)

  const q = tryon(); state.albumMode = 'defer'; q.afterCompose('/tmp/d.jpg', '')
  q.showToast('已保存，清理最早 1 条旧记录', 'warn')
  state.album.success({})
  ck('18 相册成功不覆盖清理警告', /清理最早/.test(q.data.toast), q.data.toast)

  const h = load('history'); const before = JSON.stringify(h.data.records)
  h.confirmRemove({ currentTarget: { dataset: { id: 'r1' } } })
  h._alive = false; state.modals[state.modals.length - 1].success({ confirm: true })
  ck('19 离开后不执行迟到的删除', JSON.stringify(h.data.records) === before)

  const i = load('index'); i.data.shop = { phone: '020-12345678' }
  const n = state.toasts.length; i.callShop()
  ck('20 拨号失败给出反馈', state.toasts.length === n + 1 && /稍后再试/.test(state.toasts[state.toasts.length - 1]))
}

console.log('---')
console.log(fail ? '失败 ' + fail + ' 项' : '全部通过 (' + pass + ' 项)')
process.exit(fail ? 1 : 0)
