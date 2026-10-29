/**
 * 本机存储的完整性（第 46 轮）
 *
 * 这一轮问一个不好回答的问题：**「清除本机数据」真的清干净了吗？**
 *
 * 答案是「没有」。profile 页里是这么写的：
 *
 *   removeStorageSync('arhair_favorites_v1')
 *   removeStorageSync('arhair_records_v1')
 *   removeStorageSync('arhair_calibration_v1')
 *   removeStorageSync('arhair_first_launch')
 *   removeStorageSync('arhair_launch_count')
 *
 * 五个手抄的 key。而 store.js 里还有 arhair_profile_v1（靠 saveProfile
 * 写空值绕过去）和 arhair_guide_v1；第 45 轮刚加的
 * arhair_last_pick_v1 更是完全没人管 —— 用户点了「清除本机数据」，
 * 下次进试戴页还是上次那款发型。
 *
 * 手抄名单这件事的本质问题不是「漏了一个」，而是**它一定会再漏**：
 * 每次加 key 都要跨文件记得改一处，而「记得」从来没成功过。
 *
 * 另一半是孤儿文件：saveFile 的配额只有 10MB，删记录时
 * removeSavedFile 偶尔失败，那些文件就永远留着，没有记录指向它们 ——
 * 用户看不到、删不掉，但配额照占，攒够之后每次拍照都失败。
 *
 * 这一轮验证：
 *   A. clearAll 按前缀扫，不靠名单
 *   B. clearAll 的删除顺序（先删文件，再删 key）
 *   C. collectGarbage 只删「没人引用 + 够旧」的文件
 *   D. profile / app 接上了新接口
 *   E. 静态：不许再出现手抄的 removeStorageSync('arhair_...')
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

/* ---------------- wx 桩 ---------------- */

const storage = {}
const files = {}      // path -> { filePath, createTime, size }
let removedFiles = []
let behavior = {}

function reset() {
  for (const k in storage) delete storage[k]
  for (const k in files) delete files[k]
  removedFiles = []
  behavior = {}
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

const fsStub = {
  getFileInfo(o) { o && o.success && o.success({ size: 1024 }) },
  saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://new.jpg' }) },
  removeSavedFile(o) { removedFiles.push(o && o.filePath); o && o.success && o.success({}) },
  getSavedFileList(o) {
    if (behavior.savedList === 'fail') { o && o.fail && o.fail({ errMsg: 'boom' }); return }
    const list = Object.keys(files).map(function (k) { return files[k] })
    o && o.success && o.success({ fileList: list })
  }
}

const wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getStorageInfoSync() {
    if (behavior.info === 'throw') throw new Error('boom')
    if (behavior.info === 'noKeys') return { currentSize: 1, limitSize: 10240 }
    return { keys: Object.keys(storage), currentSize: 1, limitSize: 10240 }
  },
  getFileSystemManager() {
    if (behavior.fs === 'throw') throw new Error('boom')
    return fsStub
  },
  getWindowInfo() { return { statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 } },
  showToast() {}, showModal() {}, showLoading() {}, hideLoading() {},
  getSetting(o) { o && o.success && o.success({ authSetting: {} }) },
  getPrivacySetting(o) { o && o.success && o.success({ needAuthorization: false }) },
  navigateTo(o) { o && o.success && o.success({}) },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } }
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

global.wx = wx
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  App(o) { g.__app = o },
  getApp() { return { globalData: {}, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout() { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
g.__app = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const store = require(path.join(ROOT, 'utils/store'))

/* ================= A. clearAll 按前缀扫 ================= */

console.log('\n[A] clearAll')

reset()
storage['arhair_records_v1'] = []
storage['arhair_favorites_v1'] = ['bob']
storage['arhair_profile_v1'] = { nickName: '小王' }
storage['arhair_calibration_v1'] = { scale: 1.2 }
storage['arhair_guide_v1'] = true
storage['arhair_last_pick_v1'] = { style: 'wavy', color: 'wine' }
storage['arhair_first_launch'] = 1700000000000
storage['arhair_launch_count'] = 7
// 将来才会加的新 key：不在任何名单里
storage['arhair_future_thing_v2'] = 'whatever'
// 别家的 key（云 SDK 之类），不该被碰
storage['other_app_token'] = 'keep-me'

const removed = store.clearAll()
ck('A1 收藏被清', storage['arhair_favorites_v1'] === undefined)
ck('A2 记录被清', storage['arhair_records_v1'] === undefined)
ck('A3 档案被清', storage['arhair_profile_v1'] === undefined)
ck('A4 微调参数被清', storage['arhair_calibration_v1'] === undefined)
ck('A5 引导标记被清（回到刚装好的样子）', storage['arhair_guide_v1'] === undefined)
ck('A6 上次选择被清（第 45 轮加的，原来漏在这）', storage['arhair_last_pick_v1'] === undefined)
ck('A7 使用天数被清', storage['arhair_first_launch'] === undefined)
ck('A8 启动次数被清', storage['arhair_launch_count'] === undefined)
ck('A9 未来新增的 key 也会被清（按前缀，不靠名单）', storage['arhair_future_thing_v2'] === undefined)
ck('A10 别家的 key 不碰', storage['other_app_token'] === 'keep-me', String(storage['other_app_token']))
ck('A11 返回被删的 key 列表', Array.isArray(removed) && removed.length === 9, String(removed && removed.length))
ck('A12 返回的列表里没有别家的 key', removed.indexOf('other_app_token') < 0)

// 清完之后读到的都应该是「空」
ck('A13 清完后 getLastPick 为空', store.getLastPick().style === '')
ck('A14 清完后 hasSeenGuide 为 false', store.hasSeenGuide() === false)
ck('A15 清完后收藏为空', store.listFavorites().length === 0)
ck('A16 清完后记录为空', store.listRecords().length === 0)
ck('A17 清完后档案是空字段', store.getProfile().nickName === '')
ck('A18 清完后微调是默认值', store.getCalibration().scale === 1)

// getStorageInfoSync 拿不到 keys
reset()
storage['arhair_favorites_v1'] = ['bob']
storage['arhair_last_pick_v1'] = { style: 'wavy', color: '' }
storage['other_app_token'] = 'keep-me'
behavior.info = 'noKeys'
const removed2 = store.clearAll()
ck('A19 拿不到 keys 时走兜底名单', storage['arhair_favorites_v1'] === undefined && storage['arhair_last_pick_v1'] === undefined)
ck('A20 兜底时也不碰别家 key', storage['other_app_token'] === 'keep-me')
ck('A21 兜底返回的列表非空', removed2.length > 0, String(removed2.length))

reset()
behavior.info = 'throw'
let threw = false
try { store.clearAll() } catch (e) { threw = true }
ck('A22 getStorageInfoSync 抛异常不崩', threw === false)

/* ================= B. 删除顺序 ================= */

console.log('\n[B] 先删文件再删 key')

reset()
storage['arhair_records_v1'] = [
  { id: 'r1', styleId: 'bob', colorId: 'black', styleName: 'x', colorName: 'y', photoPath: 'store://a.jpg', thumbPath: 'store://a-t.jpg', createdAt: 1700000000000 }
]
storage['arhair_profile_v1'] = { nickName: 'n', avatarUrl: 'store://avatar.jpg', hairType: '', note: '' }
store.clearAll()
ck('B1 主图被删', removedFiles.indexOf('store://a.jpg') >= 0, JSON.stringify(removedFiles))
ck('B2 缩略图被删', removedFiles.indexOf('store://a-t.jpg') >= 0, JSON.stringify(removedFiles))
ck('B3 头像被删', removedFiles.indexOf('store://avatar.jpg') >= 0, JSON.stringify(removedFiles))
ck('B4 三个文件都删到了（没有因为先删 key 而丢引用）', removedFiles.length === 3, JSON.stringify(removedFiles))

reset()
storage['arhair_profile_v1'] = { nickName: 'n', avatarUrl: '/tmp/local.png', hairType: '', note: '' }
store.clearAll()
ck('B5 不是 store:// 的头像不去删（那是临时文件）', removedFiles.indexOf('/tmp/local.png') < 0, JSON.stringify(removedFiles))

/* ================= C. collectGarbage ================= */

console.log('\n[C] 孤儿文件回收')

const OLD = Date.now() - 3600000
reset()
storage['arhair_records_v1'] = [
  { id: 'r1', styleId: 'bob', colorId: 'black', styleName: 'x', colorName: 'y', photoPath: 'store://keep.jpg', thumbPath: 'store://keep-t.jpg', createdAt: OLD }
]
storage['arhair_profile_v1'] = { nickName: 'n', avatarUrl: 'store://avatar.jpg', hairType: '', note: '' }
files['store://keep.jpg'] = { filePath: 'store://keep.jpg', createTime: OLD, size: 1000 }
files['store://keep-t.jpg'] = { filePath: 'store://keep-t.jpg', createTime: OLD, size: 100 }
files['store://avatar.jpg'] = { filePath: 'store://avatar.jpg', createTime: OLD, size: 500 }
files['store://orphan1.jpg'] = { filePath: 'store://orphan1.jpg', createTime: OLD, size: 900 }
files['store://orphan2.jpg'] = { filePath: 'store://orphan2.jpg', createTime: OLD, size: 900 }

store.collectGarbage()
ck('C1 记录引用的主图保留', removedFiles.indexOf('store://keep.jpg') < 0, JSON.stringify(removedFiles))
ck('C2 记录引用的缩略图保留', removedFiles.indexOf('store://keep-t.jpg') < 0, JSON.stringify(removedFiles))
ck('C3 头像保留', removedFiles.indexOf('store://avatar.jpg') < 0, JSON.stringify(removedFiles))
ck('C4 孤儿被回收', removedFiles.indexOf('store://orphan1.jpg') >= 0 && removedFiles.indexOf('store://orphan2.jpg') >= 0, JSON.stringify(removedFiles))
ck('C5 只删了两个孤儿', removedFiles.length === 2, JSON.stringify(removedFiles))

// 刚拍的照片不能删
reset()
storage['arhair_records_v1'] = []
files['store://just-shot.jpg'] = { filePath: 'store://just-shot.jpg', createTime: Date.now() - 5000, size: 900 }
files['store://old.jpg'] = { filePath: 'store://old.jpg', createTime: OLD, size: 900 }
store.collectGarbage()
ck('C6 5 秒前拍的照片不删（还在写记录的窗口里）', removedFiles.indexOf('store://just-shot.jpg') < 0, JSON.stringify(removedFiles))
ck('C7 一小时前的孤儿照删', removedFiles.indexOf('store://old.jpg') >= 0, JSON.stringify(removedFiles))

// createTime 缺失
reset()
files['store://no-time.jpg'] = { filePath: 'store://no-time.jpg', size: 900 }
store.collectGarbage()
ck('C8 createTime 缺失时不敢删', removedFiles.indexOf('store://no-time.jpg') < 0, JSON.stringify(removedFiles))

// 记录为空 → 所有旧文件都是孤儿
reset()
storage['arhair_records_v1'] = []
files['store://x1.jpg'] = { filePath: 'store://x1.jpg', createTime: OLD, size: 900 }
files['store://x2.jpg'] = { filePath: 'store://x2.jpg', createTime: OLD, size: 900 }
store.collectGarbage()
ck('C9 记录全没了时旧照片都回收', removedFiles.length === 2, JSON.stringify(removedFiles))

// 容错
reset()
behavior.fs = 'throw'
let threw2 = false
try { store.collectGarbage() } catch (e) { threw2 = true }
ck('C10 getFileSystemManager 抛异常不崩', threw2 === false)

reset()
behavior.savedList = 'fail'
let threw3 = false
try { store.collectGarbage() } catch (e) { threw3 = true }
ck('C11 getSavedFileList 失败不崩', threw3 === false)

reset()
const savedFs = wx.getFileSystemManager
global.wx.getFileSystemManager = function () { return {} }
let threw4 = false
try { store.collectGarbage() } catch (e) { threw4 = true }
ck('C12 老基础库没有 getSavedFileList 时静默跳过', threw4 === false)
global.wx.getFileSystemManager = savedFs

/* ================= D. 页面接入 ================= */

console.log('\n[D] 页面接入')

const profileSrc = fs.readFileSync(path.join(ROOT, 'pages/profile/profile.js'), 'utf8')
ck('D1 profile 调用了 store.clearAll', /store\.clearAll\(\)/.test(profileSrc))
ck('D2 profile 不再逐个手删 key', stripComments(profileSrc).indexOf("removeStorageSync('arhair_") < 0)
ck('D3 弹窗文案说明「恢复到刚装好的状态」', profileSrc.indexOf('恢复到刚装好') >= 0)

const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
ck('D4 onLaunch 里调用了 collectGarbage', /collectGarbage\(\)/.test(appSrc))
ck('D5 回收失败不能影响启动', /collectGarbage\(\)[\s\S]{0,200}catch/.test(appSrc))

/* ================= E. 静态 ================= */

console.log('\n[E] 静态扫描')

const storeSrc = fs.readFileSync(path.join(ROOT, 'utils/store.js'), 'utf8')
function stripComments(src) {
  return src.split(/\r?\n/).map(function (L) {
    const t = L.trim()
    if (t.indexOf('//') === 0 || t.indexOf('*') === 0 || t.indexOf('/*') === 0) return ''
    return L
  }).join('\n')
}
ck('E1 store 里没有手抄的 removeStorageSync 名单',
  !/removeStorageSync\(\s*'arhair_/.test(stripComments(storeSrc)))

// 所有 arhair_ key 必须集中在 store.js 里定义，页面不许自己拼
const pageJs = []
function walk(dir) {
  fs.readdirSync(dir).forEach(function (n) {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.js$/.test(n)) pageJs.push(p)
  })
}
walk(path.join(ROOT, 'pages'))
const keyOffenders = pageJs.filter(function (f) {
  const s = stripComments(fs.readFileSync(f, 'utf8'))
  return /['"]arhair_[a-z_0-9]+['"]/.test(s)
})
ck('E2 页面里不许出现硬编码的 arhair_ key', keyOffenders.length === 0,
  keyOffenders.map(function (f) { return path.relative(ROOT, f) }).join(','))

ck('E3 store 导出了 clearAll / collectGarbage',
  typeof store.clearAll === 'function' && typeof store.collectGarbage === 'function')

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
