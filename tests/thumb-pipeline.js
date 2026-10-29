/**
 * 记录页缩略图链路（第 36 轮）
 *
 * 记录页的列表图只显示约 100pt 宽，但 `<image>` 加载的是拍照导出的
 * 960px 原图。微信会把整张图解码进内存：
 *   960 × 1707 × 4 字节 = 6.5MB / 张
 *   20 张（MAX_RECORDS）= 131MB
 *
 * 低端机进一次记录页就被系统回收 —— 用户看到的是「点记录就闪退」，
 * 而且删了记录、清了缓存都不一定好（他删的时候页面已经崩了）。
 * `lazy-load` 只能推迟加载，不能减少单张的解码内存。
 *
 * 真正管用的是「列表用小图，点开大图才用原图」：
 * 拍照时顺手多导一张 240px 宽的版本（约 15KB，解码后 240×427×4 = 410KB），
 * 20 张从 131MB 降到 8MB。
 *
 * 这一轮验证整条链路：导出 → 落盘 → 列表取用 → 删除时清理。
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
const files = {}          // path -> 内容标记
const removed = []
const exportCalls = []    // canvasToTempFilePath 的入参
const state = { thumbFail: false, saveFail: false }

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

let fileSeq = 0

const wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getFileSystemManager() {
    return {
      getFileInfo(o) {
        const isThumb = /thumb/.test(o.filePath || '')
        o && o.success && o.success({ size: isThumb ? 15 * 1024 : 300 * 1024 })
      },
      saveFile(o) {
        if (state.saveFail) { o && o.fail && o.fail({ errMsg: 'exceed max size' }); return }
        if (/thumb/.test(o.tempFilePath || '') && state.thumbFail) {
          o && o.fail && o.fail({ errMsg: 'thumb fail' })
          return
        }
        const p = 'store://f' + (++fileSeq) + (/thumb/.test(o.tempFilePath || '') ? '-thumb' : '') + '.jpg'
        files[p] = o.tempFilePath
        o && o.success && o.success({ savedFilePath: p })
      },
      removeSavedFile(o) {
        removed.push(o.filePath)
        delete files[o.filePath]
        o && o.success && o.success({})
      }
    }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() {
    return {
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
      takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/shot.jpg' }) }
    }
  },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = {
      select() { return q }, selectAll() { return q }, fields() { return q },
      boundingClientRect() { return q }, in() { return q },
      exec(cb) {
        const canvas = {
          width: 960, height: 1707,
          getContext() { return makeCtx() },
          createImage() {
            const img = {}
            Object.defineProperty(img, 'src', {
              set(v) {
                img._src = v
                img.width = 720
                img.height = 1280
                if (typeof img.onload === 'function') img.onload()
              },
              get() { return img._src }
            })
            return img
          }
        }
        cb && cb([{ node: canvas, width: 375, height: 667 }])
      }
    }
    return q
  },
  canvasToTempFilePath(o) {
    exportCalls.push(o)
    // 第二次调用（带 destWidth）是小图
    const isThumb = !!o.destWidth
    o && o.success && o.success({ tempFilePath: isThumb ? '/tmp/thumb.jpg' : '/tmp/main.jpg' })
  },
  saveImageToPhotosAlbum(o) { o && o.success && o.success({}) },
  showToast() {},
  showLoading() {},
  hideLoading() {},
  showModal() {},
  vibrateShort() {}
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
  // 定时器一律不触发：这一轮测的是正常链路，
  // 看门狗/防抖在这里同步触发反而会打乱时序（上一版就刷了一屏「拍照超时」）
  setTimeout() { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const store = require(path.join(ROOT, 'utils/store'))

function loadPage(name) {
  const abs = path.join(ROOT, 'pages', name, name + '.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst._alive = true
  inst.selectComponent = function () { return null }
  return inst
}

function resetAll() {
  for (const k in storage) delete storage[k]
  for (const k in files) delete files[k]
  removed.length = 0
  exportCalls.length = 0
  state.thumbFail = false
  state.saveFail = false
}

/* ================= A. 导出两张 ================= */

console.log('\n[A] 拍照时导出主图 + 缩略图')

resetAll()
const tryon = loadPage('tryon')
tryon.cw = 375
tryon.ch = 667
tryon.ctx = makeCtx()
tryon.data.cameraReady = true
tryon.data.isDevtools = false
tryon.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
tryon.render = function () {}
tryon.capture()

ck('A1 一共导出了两张图', exportCalls.length === 2, 'n=' + exportCalls.length)
const main = exportCalls[0]
const thumb = exportCalls[1]
ck('A2 主图不带 destWidth（原尺寸）', !main.destWidth)
ck('A3 缩略图宽 240', thumb.destWidth === 240, 'destWidth=' + thumb.destWidth)
ck('A4 缩略图保持原图宽高比',
  Math.abs(thumb.destWidth / thumb.destHeight - 960 / 1707) < 0.02,
  thumb.destWidth + 'x' + thumb.destHeight)
ck('A5 缩略图质量低于主图', (thumb.quality || 1) < (main.quality || 1),
  'thumb=' + thumb.quality + ' main=' + main.quality)

/* ================= B. 落盘 ================= */

console.log('\n[B] 缩略图落盘')

const recs = store.listRecords()
ck('B1 记录了 thumbPath', recs.length === 1 && !!recs[0].thumbPath, JSON.stringify(recs[0] && recs[0].thumbPath))
ck('B2 thumbPath 与 photoPath 不同', recs[0].thumbPath !== recs[0].photoPath)
ck('B3 两个文件都真的存在', !!files[recs[0].photoPath] && !!files[recs[0].thumbPath])

resetAll()
const t2 = loadPage('tryon')
t2.cw = 375; t2.ch = 667; t2.ctx = makeCtx()
t2.data.cameraReady = true; t2.data.isDevtools = false
t2.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
t2.render = function () {}
state.thumbFail = true
t2.capture()
const r2 = store.listRecords()
ck('B4 缩略图落盘失败时记录仍然保存', r2.length === 1)
ck('B5 此时 thumbPath 为空串（列表退回原图）', r2[0].thumbPath === '')
ck('B6 主图不受影响', !!r2[0].photoPath)

/* ================= C. 清理 ================= */

console.log('\n[C] 删除记录要把两个文件都删掉')

resetAll()
const t3 = loadPage('tryon')
t3.cw = 375; t3.ch = 667; t3.ctx = makeCtx()
t3.data.cameraReady = true; t3.data.isDevtools = false
t3.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
t3.render = function () {}
t3.capture()
const r3 = store.listRecords()[0]
removed.length = 0
store.removeRecord(r3.id)
ck('C1 删除时两个文件都清理了',
  removed.indexOf(r3.photoPath) >= 0 && removed.indexOf(r3.thumbPath) >= 0,
  JSON.stringify(removed))

// 淘汰路径
resetAll()
const t4 = loadPage('tryon')
t4.cw = 375; t4.ch = 667; t4.ctx = makeCtx()
t4.data.cameraReady = true; t4.data.isDevtools = false
t4.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
t4.render = function () {}
const ids = []
for (let i = 0; i < 22; i++) {
  t4.capture()
  const l = store.listRecords()
  ids.push(l[0].id)
}
const left = store.listRecords()
ck('C2 超过上限后只留 20 条', left.length === 20, 'len=' + left.length)
let orphan = 0
for (const p in files) {
  const used = left.some(function (r) { return r.photoPath === p || r.thumbPath === p })
  if (!used) orphan++
}
ck('C3 没有孤儿文件（淘汰时缩略图也被删了）', orphan === 0, 'orphan=' + orphan)

/* ================= D. 老记录兼容 ================= */

console.log('\n[D] 老记录（没有 thumbPath 字段）')

resetAll()
storage['arhair_records_v1'] = JSON.stringify([
  { id: 'old1', styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', createdAt: Date.now(), photoPath: 'store://old.jpg' }
])
const oldList = store.listRecords()
ck('D1 thumbPath 被归一成空串', oldList[0].thumbPath === '', JSON.stringify(oldList[0].thumbPath))

const hist = loadPage('history')
hist.data.records = []
hist.refresh()
const item = hist.data.records[0]
ck('D2 列表项有 thumbPath 字段', item && typeof item.thumbPath === 'string')
ck('D3 老记录退回用原图', item.thumbPath === 'store://old.jpg', item && item.thumbPath)

/* ================= E. 列表取用与错误兜底 ================= */

console.log('\n[E] 列表用缩略图 / 加载失败处理')

resetAll()
const t5 = loadPage('tryon')
t5.cw = 375; t5.ch = 667; t5.ctx = makeCtx()
t5.data.cameraReady = true; t5.data.isDevtools = false
t5.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
t5.render = function () {}
t5.capture()

const hist2 = loadPage('history')
hist2.data.records = []
hist2.refresh()
const it2 = hist2.data.records[0]
ck('E1 列表项指向缩略图而不是原图', it2.thumbPath !== it2.photoPath, it2.thumbPath + ' vs ' + it2.photoPath)
ck('E2 原图路径仍然保留（预览大图要用）', !!it2.photoPath)

hist2.onImgError({ currentTarget: { dataset: { id: it2.id } } })
ck('E3 仅缩略图失效时退回原图，不误藏主照片',
  hist2.data.records[0].thumbPath === '' && hist2.data.records[0].photoPath === it2.photoPath)
hist2.onImgError({ currentTarget: { dataset: { id: it2.id } } })
ck('E4 原图也失效后才显示无照片',
  hist2.data.records[0].thumbPath === '' && hist2.data.records[0].photoPath === '')

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '缩略图链路：全部通过' : '缩略图链路：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
