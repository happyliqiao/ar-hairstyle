/**
 * 端到端用户旅程
 *
 * 前面十几轮都是「单点深挖」，这一轮换回用户视角，把整条路走一遍：
 *   首页 → 试戴 → 换发型 → 换发色 → 收藏 → 拍照 → 返回
 *   → 发型库 → 记录页 → 我的
 *
 * 单点测试全绿但整体走不通是很常见的事（比如 A 页存的数据 B 页读不出来、
 * 换发型后缩略图和当前发色不一致）。这一轮专门抓这类**跨页面一致性**问题。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []
const trace = []

function ok(name, cond, extra) {
  if (cond) { pass++ }
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

/* ---------------- 共享的 wx 环境（storage 跨页面共享） ---------------- */

const storage = {}
const files = {}
const navLog = []
const toastLog = []

function makeWx() {
  const base = {
    getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
    setStorageSync(k, v) { storage[k] = v },
    removeStorageSync(k) { delete storage[k] },
    getWindowInfo() {
      return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
    },
    getSystemInfoSync() {
      return { platform: 'android', statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
    },
    getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true, 'scope.writePhotosAlbum': true } }) },
    getFileSystemManager() {
      return {
        getFileInfo(o) { o && o.success && o.success({ size: 280 * 1024 }) },
        saveFile(o) {
          const p = 'store://photo' + (Object.keys(files).length + 1) + '.jpg'
          files[p] = o.tempFilePath
          o && o.success && o.success({ savedFilePath: p })
        },
        removeSavedFile(o) { if (o && o.filePath) delete files[o.filePath]; o && o.success && o.success({}) }
      }
    },
    showToast(o) { toastLog.push(o && o.title) },
    hideToast() {},
    showLoading() {},
    hideLoading() {},
    showModal(o) { o && o.success && o.success({ confirm: true }) },
    openSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
    saveImageToPhotosAlbum(o) { o && o.success && o.success({}) },
    previewImage(o) { if (o && o.success) o.success({}) },
    navigateTo(o) { navLog.push({ type: 'navigateTo', url: o && o.url }) },
    switchTab(o) { navLog.push({ type: 'switchTab', url: o && o.url }) },
    navigateBack(o) { navLog.push({ type: 'navigateBack' }); o && o.fail && o.fail({}) },
    setNavigationBarTitle() {},
    createSelectorQuery() {
      // 必须真的返回一个 canvas 节点，否则 compose 会走「合成失败」分支，
      // 拍照链路整条断在这里，后面所有跨页断言都会跟着假失败。
      const grad = { addColorStop() {} }
      const ctx = new Proxy({
        createLinearGradient() { return grad },
        createRadialGradient() { return grad },
        measureText() { return { width: 10 } }
      }, {
        get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} },
        set() { return true }
      })
      const canvas = {
        width: 960,
        height: 1200,
        getContext() { return ctx },
        createImage() {
          const img = {}
          Object.defineProperty(img, 'src', {
            set(v) { img._src = v; if (typeof img.onload === 'function') img.onload() },
            get() { return img._src }
          })
          return img
        }
      }
      const q = {
        select() { return q }, selectAll() { return q },
        fields() { return q }, boundingClientRect() { return q }, in() { return q },
        exec(cb) { cb && cb([{ node: canvas, width: 375, height: 667 }]) }
      }
      return q
    },
    createCameraContext() {
      return {
        onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
        takePhoto(o) { if (o && o.success) o.success({ tempImagePath: '/tmp/shot.jpg' }) }
      }
    },
    createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
    canvasToTempFilePath(o) { if (o && o.success) o.success({ tempFilePath: '/tmp/composed.jpg' }) },
    vibrateShort() {},
    getUpdateManager() { return { onCheckForUpdate() {}, onUpdateReady() {}, onUpdateFailed() {}, applyUpdate() {} } },
    onNetworkStatusChange() {}
  }
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      if (k === 'then') return undefined
      return function () {}
    }
  })
}

const WX = makeWx()

function loadPage(name, data) {
  const abs = path.join(ROOT, 'pages', name, name + '.js')
  const g = {
    wx: WX,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: { name: '镜界造型', hours: '10:00 - 22:00' }, cloudReady: false }, onShareAppMessage() { return {} } } },
    getCurrentPages() { return [] },
    Path2D: undefined,
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null
  Object.keys(g).forEach(function (k) { global[k] = g[k] })

  delete require.cache[require.resolve(abs)]
  require(abs)

  const pageObj = g.__page
  const inst = {}
  Object.keys(pageObj).forEach(function (k) { inst[k] = pageObj[k] })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst.selectComponent = function () { return null }
  return inst
}

/* ---------------- 1 首页 ---------------- */

trace.push('1. 打开首页')
const index = loadPage('index')
index.onLoad({})
index.onShow && index.onShow()

ok('首页有热门发型', Array.isArray(index.data.hot) && index.data.hot.length > 0, 'hot=' + (index.data.hot && index.data.hot.length))
ok('首页有发色', Array.isArray(index.data.colors) && index.data.colors.length > 0)
ok('首页有营业状态', index.data.shopOpen !== undefined && index.data.shopOpen !== null,
  JSON.stringify(index.data.shopOpen))
ok('首页 topPad 是数字', typeof index.data.topPad === 'number' && isFinite(index.data.topPad))

const hotStyle = index.data.hot[0]
ok('热门发型带 id/name/thumb', !!(hotStyle && hotStyle.id && hotStyle.name && hotStyle.thumb))

/* ---------------- 2 从首页点热门发型进试戴 ---------------- */

trace.push('2. 点热门发型 → 试戴页')
const firstStyleId = hotStyle.id
index.openStyle({ currentTarget: { dataset: { id: firstStyleId } } })
const nav = navLog[navLog.length - 1]
ok('跳转链接带 style 参数', nav && nav.url && nav.url.indexOf('style=' + firstStyleId) >= 0, nav && nav.url)

const tryon = loadPage('tryon')
tryon.onLoad({ style: firstStyleId })
tryon.onReady()
ok('试戴页正确解析 style 参数', tryon.data.currentStyle === firstStyleId,
  '期望 ' + firstStyleId + ' 实际 ' + tryon.data.currentStyle)
ok('试戴页当前发型名与 id 对应', tryon.data.currentStyleName === hotStyle.name,
  tryon.data.currentStyleName + ' vs ' + hotStyle.name)
ok('试戴页缩略图列表非空', tryon.data.styles.length > 0)

/* ---------------- 3 换发型 ---------------- */

trace.push('3. 换发型')
const targetStyle = tryon.data.styles.find(function (s) { return s.id !== tryon.data.currentStyle })
tryon.pickStyle({ currentTarget: { dataset: { id: targetStyle.id } } })
ok('换发型后 currentStyle 更新', tryon.data.currentStyle === targetStyle.id)
ok('换发型后名称同步', tryon.data.currentStyleName === targetStyle.name)
ok('换发型后标签同步', !!tryon.data.currentTag)

/* ---------------- 4 换发色 ---------------- */

trace.push('4. 换发色')
const targetColor = tryon.data.colors.find(function (c) { return c.id !== tryon.data.currentColor })
tryon.pickColor({ currentTarget: { dataset: { id: targetColor.id } } })
ok('换发色后 currentColor 更新', tryon.data.currentColor === targetColor.id)
ok('换发色后名称同步', tryon.data.currentColorName === targetColor.name)

/* ---------------- 5 收藏 ---------------- */

trace.push('5. 收藏当前发型')
const beforeFav = tryon.data.isFav
tryon.toggleFavorite()
ok('收藏状态翻转', tryon.data.isFav === !beforeFav)
const store = require(path.join(ROOT, 'utils/store.js'))
ok('store 里能查到收藏', store.isFavorite(targetStyle.id) === tryon.data.isFav,
  'store=' + store.isFavorite(targetStyle.id) + ' ui=' + tryon.data.isFav)

/* ---------------- 6 拍照 ---------------- */

trace.push('6. 拍照保存')
tryon.lastBox = { x: 40, y: 60, w: 300, h: 360, angle: 0 }
tryon.capture()

const recs = store.listRecords()
ok('拍照后记录数 = 1', recs.length === 1, '实际 ' + recs.length)
if (recs.length) {
  const r = recs[0]
  ok('记录的发型 = 当前选的', r.styleId === targetStyle.id, r.styleId + ' vs ' + targetStyle.id)
  ok('记录的发色 = 当前选的', r.colorId === targetColor.id, r.colorId + ' vs ' + targetColor.id)
  ok('记录有照片路径', !!r.photoPath, r.photoPath)
  ok('记录照片文件真实存在（桩文件系统里）', !!files[r.photoPath], r.photoPath)
  ok('记录的 createdAt 是有效时间', typeof r.createdAt === 'number' && r.createdAt > 0)
}
ok('拍照后 shooting 已复位', tryon.data.shooting === false, 'shooting=' + tryon.data.shooting)

/* ---------------- 7 发型库 ---------------- */

trace.push('7. 进发型库')
const gallery = loadPage('gallery')
gallery.onLoad()
gallery.onShow()
ok('发型库列表非空', gallery.data.styles.length > 0)
ok('发型库能看到刚才收藏的款式',
  gallery.data.styles.some(function (s) { return s.id === targetStyle.id && s.fav }),
  '收藏状态没有同步到发型库')
ok('发型库预览色默认是 black', gallery.data.previewColor === 'black')

gallery.pickPreviewColor({ currentTarget: { dataset: { id: targetColor.id } } })
ok('切预览色后 previewColor 更新', gallery.data.previewColor === targetColor.id)

/* ---------------- 8 记录页 ---------------- */

trace.push('8. 进记录页')
const history = loadPage('history')
history.onLoad({})
history.onShow()
ok('记录页显示 1 条', history.data.records.length === 1, '实际 ' + history.data.records.length)
if (history.data.records.length) {
  const h = history.data.records[0]
  ok('记录页显示的发型名正确', h.styleName === targetStyle.name, h.styleName)
  ok('记录页显示的发色名正确', h.colorName === targetColor.name, h.colorName)
  ok('记录页时间文案正常（不是 NaN）', /今天|昨天|\d{4}\//.test(h.timeText), h.timeText)
  ok('记录页有发色圆点色值', /^#|rgb/.test(h.swatch || ''), h.swatch)
}

/* ---------------- 9 我的 ---------------- */

trace.push('9. 进「我的」')
const profile = loadPage('profile')
profile.onLoad()
profile.onShow && profile.onShow()
ok('我的页统计记录数 = 1', profile.data.stat && profile.data.stat.records === 1,
  JSON.stringify(profile.data.stat))
ok('我的页收藏数 >= 1', profile.data.stat && profile.data.stat.favs >= 1,
  JSON.stringify(profile.data.stat))
ok('我的页收藏列表非空', Array.isArray(profile.data.favStyles) && profile.data.favStyles.length >= 1)
ok('我的页收藏列表包含刚才那款',
  (profile.data.favStyles || []).some(function (s) { return s.id === targetStyle.id }))

/* ---------------- 10 删除记录后各处同步 ---------------- */

trace.push('10. 删除记录')
const rid = (history.data.records[0] || {}).id
if (rid) store.removeRecord(rid)
history._lastKey = null
history.refresh()
ok('删除后记录页清空', history.data.records.length === 0, '实际 ' + history.data.records.length)

profile.onShow()
ok('删除后「我的」统计同步', profile.data.stat && profile.data.stat.records === 0,
  JSON.stringify(profile.data.stat))

/* ---------------- 输出 ---------------- */

console.log('')
console.log('[端到端用户旅程]')
trace.forEach(function (t) { console.log('   ' + t) })
console.log('')
console.log('   ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('   10 个环节全部走通，跨页面数据一致')
}
