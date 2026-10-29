/**
 * 客户档案与校准参数的清洗（第 37 轮）
 *
 * `readJson` 只能保证「是合法 JSON」，保证不了「是想要的那个类型」。
 * storage 里完全可能是 `"null"`、`"123"`、`"[1,2]"` —— 这些都过 JSON.parse，
 * 返回的却是 null / 数字 / 数组。
 *
 * 记录和收藏在前几轮已经补了清洗，档案和校准这两个一直裸着：
 *
 *   1. `getProfile()` 返回 null → 页面里 `profile.nickName` 在 null 上取值
 *      → **整个「我的」页白屏**。用户只会说「点我的就没了」
 *
 *   2. `getCalibration()` 返回 `{scale:'abc'}` 或 `{offsetX:'x'}`
 *      → `faceAnchorToBox` 里算出 NaN → 函数按约定返回 null
 *      → **画布上永远不会有发型**。用户看到的是相机画面正常、
 *      状态栏写着「已锁定人脸」，头上却什么都没有，
 *      而且他没有任何办法知道是校准参数坏了
 *
 * 这一轮把这两个入口钉死：无论 storage 里是什么，页面拿到的
 * 永远是一个字段齐全、数值在合理区间的对象。
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

global.wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getFileSystemManager() {
    return { getFileInfo(o) { o && o.success && o.success({ size: 1024 }) }, saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) }, removeSavedFile(o) { o && o.success && o.success({}) } }
  }
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

const store = require(path.join(ROOT, 'utils/store'))
const faceFit = require(path.join(ROOT, 'utils/face-fit'))

const KEY_PROFILE = 'arhair_profile_v1'
const KEY_CAL = 'arhair_calibration_v1'

function put(key, v) {
  storage[key] = typeof v === 'string' ? v : JSON.stringify(v)
}
function clearAll() {
  for (const k in storage) delete storage[k]
}

const EMPTY_PROFILE = { nickName: '', avatarUrl: '', hairType: '', note: '' }
const DEFAULT_CAL = { scale: 1, offsetX: 0, offsetY: 0 }

/* ================= A. 客户档案 ================= */

console.log('\n[A] getProfile 永远返回四个字段')

function sameProfile(p) {
  return p && typeof p === 'object' && !Array.isArray(p) &&
    p.nickName === '' && p.avatarUrl === '' && p.hairType === '' && p.note === ''
}

clearAll()
ck('A1 storage 为空 → 空档案', sameProfile(store.getProfile()))

clearAll()
put(KEY_PROFILE, 'null')
let a2 = null
let a2Threw = false
try { a2 = store.getProfile() } catch (e) { a2Threw = true }
ck('A2 存的是 "null" 不抛异常', a2Threw === false)
ck('A3 存的是 "null" → 空档案（原来会白屏）', sameProfile(a2), JSON.stringify(a2))

clearAll()
put(KEY_PROFILE, '123')
ck('A4 存的是数字 → 空档案', sameProfile(store.getProfile()), JSON.stringify(store.getProfile()))

clearAll()
put(KEY_PROFILE, '[1,2]')
ck('A5 存的是数组 → 空档案', sameProfile(store.getProfile()), JSON.stringify(store.getProfile()))

clearAll()
put(KEY_PROFILE, { nickName: 42, avatarUrl: { a: 1 }, hairType: null, note: true })
const a6 = store.getProfile()
// 数字会被转成字符串（"42"）：昵称填个数字是真实会发生的，
// 而对象 / null / 布尔只可能是数据坏了，一律丢成空串。
ck('A6 对象/null/布尔 → 空串，数字 → 字符串',
  a6.nickName === '42' && a6.avatarUrl === '' && a6.hairType === '' && a6.note === '',
  JSON.stringify(a6))

clearAll()
put(KEY_PROFILE, { nickName: '数字型昵称', avatarUrl: 'store://x.jpg', hairType: '细软', note: '想剪短' })
const a7 = store.getProfile()
ck('A7 正常数据原样返回',
  a7.nickName === '数字型昵称' && a7.avatarUrl === 'store://x.jpg' && a7.hairType === '细软' && a7.note === '想剪短',
  JSON.stringify(a7))

// 超长昵称按码点截断，不能切在代理对中间
clearAll()
const emojiName = new Array(60).join('👨‍🦰')
put(KEY_PROFILE, { nickName: emojiName })
const a8 = store.getProfile().nickName
ck('A8 超长昵称被截断', Array.from(a8).length <= 40, 'len=' + Array.from(a8).length)
ck('A9 截断没切出乱码（无孤立代理项）', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(a8) && !/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(a8))

// 写入白名单
clearAll()
store.saveProfile({ nickName: '小李', extra: '不该存进去', __proto__x: 1 })
const rawSaved = JSON.parse(storage[KEY_PROFILE])
ck('A10 写入时只保留白名单字段', !('extra' in rawSaved) && !('__proto__x' in rawSaved), JSON.stringify(rawSaved))
ck('A11 写入的昵称被保留', rawSaved.nickName === '小李')

clearAll()
store.saveProfile(null)
ck('A12 saveProfile(null) 不抛且写入空档案', sameProfile(store.getProfile()))

/* ================= B. 校准参数 ================= */

console.log('\n[B] getCalibration 永远返回有限数且在区间内')

function calOk(c, scale, ox, oy) {
  return c && c.scale === scale && c.offsetX === ox && c.offsetY === oy
}

clearAll()
ck('B1 storage 为空 → 默认值', calOk(store.getCalibration(), 1, 0, 0), JSON.stringify(store.getCalibration()))

clearAll()
put(KEY_CAL, 'null')
ck('B2 存的是 "null" → 默认值', calOk(store.getCalibration(), 1, 0, 0), JSON.stringify(store.getCalibration()))

clearAll()
put(KEY_CAL, { scale: 'abc', offsetX: 'x', offsetY: null })
ck('B3 非数值字符串 → 默认值', calOk(store.getCalibration(), 1, 0, 0), JSON.stringify(store.getCalibration()))

clearAll()
put(KEY_CAL, { scale: 100 })
ck('B4 scale 过大被夹到上限', store.getCalibration().scale === store.CAL_SCALE_MAX, 'scale=' + store.getCalibration().scale)

clearAll()
put(KEY_CAL, { scale: -5 })
ck('B5 scale 为负被夹到下限', store.getCalibration().scale === store.CAL_SCALE_MIN, 'scale=' + store.getCalibration().scale)

clearAll()
put(KEY_CAL, { offsetX: 1e9, offsetY: -1e9 })
const b6 = store.getCalibration()
ck('B6 偏移过大被夹到 ±上限',
  b6.offsetX === store.CAL_OFFSET_MAX && b6.offsetY === -store.CAL_OFFSET_MAX,
  JSON.stringify(b6))

clearAll()
put(KEY_CAL, { scale: '1.25', offsetX: '30', offsetY: '-12' })
ck('B7 字符串数字被正确解析', calOk(store.getCalibration(), 1.25, 30, -12), JSON.stringify(store.getCalibration()))

clearAll()
store.saveCalibration({ scale: 999, offsetX: NaN, offsetY: 'x' })
const b8 = store.getCalibration()
ck('B8 saveCalibration 写入前就归一', b8.scale === store.CAL_SCALE_MAX && b8.offsetX === 0 && b8.offsetY === 0,
  JSON.stringify(b8))

/* ================= C. 端到端：坏校准不能把发型弄没 ================= */

console.log('\n[C] 坏校准不会让发型消失')

const anchor = { origin: { x: 100, y: 120 }, size: { width: 160, height: 200 }, angle: 0 }
const frame = { w: 720, h: 1280 }
const screen = { w: 375, h: 667 }

// 先证明「脏对象直接传进去」确实会让发型消失 —— 这样下面的修复才有意义
const dirty = { scale: 'abc', offsetX: 'x', offsetY: 'y' }
const bad = faceFit.faceAnchorToBox(anchor, frame, screen, { calibration: dirty })
ck('C1 脏校准直接传进去 → 返回 null（发型消失）', bad === null, JSON.stringify(bad))

// 走 store 清洗后应该正常
clearAll()
put(KEY_CAL, dirty)
const cleaned = store.getCalibration()
const good = faceFit.faceAnchorToBox(anchor, frame, screen, { calibration: cleaned })
ck('C2 经过 store 清洗后能算出框', !!good && good.w > 0, JSON.stringify(good))
ck('C3 框是有限数', good && isFinite(good.x) && isFinite(good.y) && isFinite(good.w) && isFinite(good.h))

// 存档为 null 的情况
clearAll()
put(KEY_CAL, 'null')
const good2 = faceFit.faceAnchorToBox(anchor, frame, screen, { calibration: store.getCalibration() })
ck('C4 存档为 null 时仍能算出框', !!good2 && good2.w > 0)

/* ================= D. 页面不崩 ================= */

console.log('\n[D] 「我的」页在脏档案下不崩')

function loadProfile() {
  const abs = path.join(ROOT, 'pages/profile/profile.js')
  const g = {
    wx: global.wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: {}, cloudReady: false } } },
    getCurrentPages() { return [] },
    setTimeout(fn) { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null
  Object.keys(g).forEach(function (k) { global[k] = g[k] })
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  return inst
}

clearAll()
put(KEY_PROFILE, 'null')
put(KEY_CAL, { scale: 'abc' })
const p = loadProfile()
let dThrew = false
try { p.onLoad({}); p.onShow() } catch (e) { dThrew = true; console.log('    ' + e.message) }
ck('D1 脏档案下 onLoad/onShow 不抛', dThrew === false)
ck('D2 页面拿到的是完整档案对象', sameProfile(p.data.profile), JSON.stringify(p.data.profile))

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '档案与校准清洗：全部通过' : '档案与校准清洗：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
