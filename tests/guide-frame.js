/**
 * 取景引导框（人脸验证式）回归测试
 *
 * 产品定义：
 *   前置摄像头 → 画面里有一个固定的人脸形状框 → 用户主动把头移进去
 *   → 对齐后发型实时自动贴合。
 *
 * 这套范式有三个必须成立的前提，缺一个就退回「脸在哪儿发型跟到哪儿、
 * 用户完全不用配合」的旧状态：
 *   1 框必须存在，且几何只有一份来源（JS 算，wxml 用）
 *   2 必须能判出「脸偏在哪、离得太近还是太远、头有没有歪」
 *   3 判定必须用**夹取前的真实脸宽**，否则贴到镜头上也会判成已对齐
 *
 * 第 3 条是最隐蔽的：face-fit 会把脸宽夹到 26%~58% 屏宽防糊屏，
 * 夹完之后「贴脸」和「正常手持」是同一个数，判定永远通过 ——
 * 用户永远等不到「后退一点」，框也就成了纯装饰。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const fit = require(path.join(ROOT, 'utils/face-fit.js'))

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

const VP = { w: 375, h: 667 }
const FRAME = { w: 480, h: 640 }

function anchor(ox, oy, w, h, extra) {
  const a = { origin: { x: ox, y: oy }, size: { width: w, height: h } }
  if (extra) Object.keys(extra).forEach(k => { a[k] = extra[k] })
  return a
}
function boxOf(a, opt) { return fit.faceAnchorToBox(a, FRAME, VP, opt) }
function alignOf(a, angle, opt) {
  const b = boxOf(a, opt)
  if (!b) return null
  return fit.judgeAlign(b.face, VP, angle)
}

/* ================= A 框的几何 ================= */

console.log('\n[A] 取景框几何')

const g = fit.guideFrame(VP.w, VP.h)
ck('A1 返回有效几何', !!g && g.w > 0 && g.h > 0)
ck('A2 框水平居中', Math.abs(g.cx - VP.w / 2) < 1e-6, 'cx=' + g.cx)
ck('A3 框宽 = 屏宽 × GUIDE_RX_RATIO × 2',
  Math.abs(g.w - VP.w * fit.GUIDE_RX_RATIO * 2) < 1e-6, 'w=' + g.w)
ck('A4 框高宽比符合人脸（约 1.28）', Math.abs(g.h / g.w - fit.GUIDE_ASPECT) < 1e-6,
  'h/w=' + (g.h / g.w).toFixed(3))
ck('A5 框心在屏幕上半部（给底部操作区留位置）', g.cy < VP.h / 2, 'cy=' + Math.round(g.cy))
ck('A6 框不超出屏幕宽度', g.cx - g.w / 2 >= 0 && g.cx + g.w / 2 <= VP.w)
ck('A7 尺寸为 0 时返回 null（画布还没初始化）', fit.guideFrame(0, 0) === null)

/* ================= B 对齐判定 ================= */

console.log('\n[B] 对齐判定')

const centered = alignOf(anchor(162, 200, 156, 200), 0)
ck('B1 居中且大小合适 → locked', centered.state === 'locked', centered.state)
ck('B2 已对齐时不再给方向提示', centered.hint === '', 'hint=' + centered.hint)

const left = alignOf(anchor(60, 200, 156, 200), 0)
ck('B3 脸偏左 → 提示往右', left.state === 'aligning' && /往右/.test(left.hint), left.hint)
ck('B4 方向键是 right', left.keys.indexOf('right') >= 0, left.keys.join(','))

const right = alignOf(anchor(270, 200, 156, 200), 0)
ck('B5 脸偏右 → 提示往左', /往左/.test(right.hint), right.hint)

const far = alignOf(anchor(162, 200, 60, 77), 0)
ck('B6 离太远 → 提示靠近', /靠近/.test(far.hint), far.hint)

const near = alignOf(anchor(-300, -100, 900, 1150), 0)
ck('B7 贴到镜头 → 提示后退', /后退/.test(near.hint), near.hint)

const tilted = alignOf(anchor(162, 200, 156, 200), 0.6)
ck('B8 歪头 → 提示摆正', /摆正/.test(tilted.hint), tilted.hint)

const low = alignOf(anchor(162, 480, 156, 200), 0)
ck('B9 脸偏下 → 提示往上', /往上/.test(low.hint), low.hint)

ck('B10 提示最多两条（三条以上用户记不住先做哪个）',
  near.hint.split(' · ').length <= 2, near.hint)

ck('B11 脏脸数据不抛异常，退化成未对齐',
  (function () {
    const r = fit.judgeAlign({ cx: NaN, cy: 0, w: 100 }, VP, 0)
    return r.state === 'aligning' && r.hint === ''
  })())

/* ================= C 夹取不能掩盖真实距离 ================= */

console.log('\n[C] 判定必须用夹取前的真实脸宽')

const nearBox = boxOf(anchor(-300, -100, 900, 1150))
ck('C1 绘制用的脸宽被夹到上限（防糊屏）',
  nearBox.face.w <= VP.w * fit.FACE_W_MAX_RATIO + 1e-6, 'w=' + Math.round(nearBox.face.w))
ck('C2 但 rawW 保留了真实脸宽（没有被夹取抹掉）',
  nearBox.face.rawW > nearBox.face.w * 2,
  'rawW=' + Math.round(nearBox.face.rawW) + ' w=' + Math.round(nearBox.face.w))
ck('C3 所以贴脸仍然判成未对齐（不会自欺）',
  fit.judgeAlign(nearBox.face, VP, 0).state === 'aligning')
ck('C4 正常距离下 rawW 与 w 相同（没被夹取）',
  Math.abs(centered.ratio - 1) < 0.35, 'ratio=' + centered.ratio.toFixed(2))

const farBox = boxOf(anchor(230, 300, 4, 5))
ck('C5 极远时绘制脸宽被夹到下限', farBox.face.w >= VP.w * fit.FACE_W_MIN_RATIO - 1e-6)
ck('C6 极远时 rawW 仍然很小', farBox.face.rawW < farBox.face.w * 0.2,
  'rawW=' + farBox.face.rawW.toFixed(2))
ck('C7 极远时判成未对齐', fit.judgeAlign(farBox.face, VP, 0).state === 'aligning')

/* ================= D 镜像下的方向一致性 ================= */

console.log('\n[D] 镜像后提示方向必须和屏幕一致')

const plain = boxOf(anchor(60, 200, 156, 200), { mirror: false })
const mirrored = boxOf(anchor(60, 200, 156, 200), { mirror: true })
ck('D1 同一锚点，镜像后脸心翻到屏幕另一侧',
  Math.abs((plain.face.cx + mirrored.face.cx) - VP.w) < 1,
  'plain=' + Math.round(plain.face.cx) + ' mirror=' + Math.round(mirrored.face.cx))
ck('D2 不镜像时脸在左 → 提示往右',
  /往右/.test(fit.judgeAlign(plain.face, VP, 0).hint))
ck('D3 镜像后脸显示在右 → 提示往左（不是同一句）',
  /往左/.test(fit.judgeAlign(mirrored.face, VP, 0).hint))

/* ================= E 页面层：状态机与节流 ================= */

console.log('\n[E] 页面层：框状态、文案、节流')

const timers = []
let timerSeq = 1
const state = { handlers: {}, setDataCount: 0 }

// 语义是「时间前进到第 ms 毫秒」，所以只触发延迟 <= ms 的定时器。
// 用 >= 会让 fireTimers(2999) 把 3000ms 的定时器也跑掉，
// 边界测试就失去意义了。
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
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
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
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 480, height: 640 }); return { stop() {} } },
      takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/x.jpg' }) }
    }
  },
  createVKSession() {
    return {
      on(name, fn) { state.handlers[name] = fn },
      start(cb) { cb && cb(0) },
      destroy() {}
    }
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
  showToast() {}, hideLoading() {}, showLoading() {}, showModal() {}, vibrateShort() {}
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

function loadPage() {
  timers.length = 0
  state.setDataCount = 0
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
  return inst
}

const p1 = loadPage()
const box1 = p1.anchorToBox(anchor(162, 200, 156, 200))
ck('E1 anchorToBox 带回了脸在屏幕上的位置', !!(box1 && box1.face && box1.face.cx),
  JSON.stringify(box1 && box1.face))

p1.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
ck('E2 对齐后 guide.state = locked', p1.data.guide.state === 'locked', p1.data.guide.state)
ck('E3 对齐后文案是「已对齐」', /已对齐/.test(p1.data.statusText), p1.data.statusText)
ck('E4 对齐后不再挂方向提示', p1.data.guide.hint === '', 'hint=' + p1.data.guide.hint)

const p2 = loadPage()
p2.onFaceAnchor(anchor(60, 200, 156, 200, { angle: 0 }))
ck('E5 没对齐时 guide.state = aligning', p2.data.guide.state === 'aligning', p2.data.guide.state)
ck('E6 没对齐时文案就是方向提示', /往右/.test(p2.data.statusText), p2.data.statusText)
ck('E7 没对齐时不再宣称「已锁定人脸」', !/已锁定/.test(p2.data.statusText), p2.data.statusText)

const p3 = loadPage()
const before = state.setDataCount
for (let i = 0; i < 6; i++) p3.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
ck('E8 连续 6 帧同一状态只 setData 一次（否则引导文字会闪）',
  state.setDataCount - before <= 2, 'setData ' + (state.setDataCount - before) + ' 次')

const p4 = loadPage()
p4.startTracking()          // 先注册 removeAnchors 回调
p4.data.faceFound = true
p4.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
state.handlers.removeAnchors && state.handlers.removeAnchors()
ck('E9 丢脸后 guide 回到 idle', p4.data.guide.state === 'idle', p4.data.guide.state)
ck('E10 丢脸后文案改回「把脸放进框里」', /把脸放进框里/.test(p4.data.statusText), p4.data.statusText)

const p5 = loadPage()
p5.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
p5.switchCamera()
ck('E11 切摄像头后对齐结论被清掉（不能沿用上一台摄像头的判定）',
  p5.data.guide.state === 'idle' && p5._align === null)

/* ================= G 侧脸（yaw）判定 ================= */

console.log('\n[G] 侧脸判定（VKSession 不给 yaw，只能用宽高比反推）')

const est = fit.createYawEstimator()
// 正脸：宽 156 高 200 → aspect 0.78
let last = null
for (let i = 0; i < 10; i++) last = est.push({ rawW: 156, rawH: 200 })
ck('G1 持续正脸 → 不判侧脸', last.suspect === false, 'rel=' + last.rel.toFixed(2))
ck('G2 正脸基准建立后 ready', last.ready === true, 'ref=' + est._ref().toFixed(3))

// 转头 45°：宽度按 cos45≈0.707 收缩，高度不变
const turned = est.push({ rawW: 156 * 0.71, rawH: 200 })
ck('G3 转 45° → 判侧脸', turned.suspect === true, 'rel=' + turned.rel.toFixed(2))
ck('G4 反推角度接近 45°', Math.abs(turned.yawDeg - 45) < 8, turned.yawDeg.toFixed(1) + '°')

// 小角度不该报
const slight = est.push({ rawW: 156 * 0.95, rawH: 200 })
ck('G5 转 18° 不报侧脸（避免频繁打扰）', slight.suspect === false,
  'yaw=' + slight.yawDeg.toFixed(1) + '°')

const fresh = fit.createYawEstimator()
const extreme = fresh.push({ rawW: 90, rawH: 200 })
ck('G6 一进来就是 60° 大侧脸 → 绝对兜底也能判出（不靠基准）',
  extreme.suspect === true, 'aspect=' + (90 / 200).toFixed(2))

const odd = fit.createYawEstimator()
let oddLast = null
for (let i = 0; i < 10; i++) oddLast = odd.push({ rawW: 104, rawH: 200 })
ck('G7 设备给的人脸框本来就窄（aspect 0.52）→ 关掉相对判定，不误报',
  oddLast.suspect === false, 'ref=' + odd._ref().toFixed(3))

const p6 = loadPage()
for (let i = 0; i < 8; i++) p6.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
ck('G8 页面层：正脸 → 对齐', p6.data.guide.state === 'locked', p6.data.guide.state)
p6.onFaceAnchor(anchor(162, 200, 111, 200, { angle: 0 }))
ck('G9 页面层：转头后判侧脸', p6.data.guide.state === 'aligning', p6.data.guide.state)
ck('G10 提示「正对镜头」', /正对镜头/.test(p6.data.guide.hint), p6.data.guide.hint)
ck('G11 侧脸时不再误报「靠近一点」（宽度变窄不等于离得远）',
  !/靠近/.test(p6.data.guide.hint), p6.data.guide.hint)

const sq = fit.createYawEstimator()
let sqLast = null
for (let i = 0; i < 16; i++) sqLast = sq.push({ rawW: 150, rawH: 150 })
ck('G12 框被正方形化（宽高比恒为 1）→ 标出 degenerate，且不误报侧脸',
  sqLast.degenerate === true && sqLast.suspect === false, JSON.stringify(sqLast))

/* ---- angle 的类型陷阱 ---- */

ck('G13 pickRoll 对数字原样返回', fit.pickRoll({ angle: 0.2 }) === 0.2)
ck('G14 pickRoll 对数组返回 0（文档说 angle 是数组，但分量顺序未公开，猜错会让整头歪）',
  fit.pickRoll({ angle: [0.1, 0.3, 0.2] }) === 0)
ck('G15 pickRoll 对缺失/NaN 返回 0',
  fit.pickRoll({}) === 0 && fit.pickRoll({ angle: NaN }) === 0)

const p10 = loadPage()
p10.onFaceAnchor(anchor(162, 200, 156, 200, { angle: [0.1, 0.3, 0.2] }))
ck('G16 数组 angle 不会污染 trackedAngle（否则 ctx.rotate 收到 NaN）',
  typeof p10.trackedAngle === 'number' && isFinite(p10.trackedAngle),
  'trackedAngle=' + JSON.stringify(p10.trackedAngle))
const b10 = p10.computeBox()
ck('G17 最终发型框的 angle 是有限数字', b10 && typeof b10.angle === 'number' && isFinite(b10.angle),
  'angle=' + JSON.stringify(b10 && b10.angle))

/* ================= H 对齐后框自动淡出 ================= */

console.log('\n[H] 对齐满 3 秒淡出，一偏离立刻回来')

const p7 = loadPage()
p7.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
ck('H1 刚对齐时框还在', p7.data.guide.hidden === false)
fireTimers(2999)
ck('H2 不到 3 秒不淡出', p7.data.guide.hidden === false)
fireTimers(3000)
ck('H3 满 3 秒后框淡出', p7.data.guide.hidden === true)

p7.onFaceAnchor(anchor(60, 200, 156, 200, { angle: 0 }))
ck('H4 一偏离框立刻回来', p7.data.guide.hidden === false)
ck('H5 回来时状态是 aligning', p7.data.guide.state === 'aligning', p7.data.guide.state)

const p8 = loadPage()
p8.onFaceAnchor(anchor(60, 200, 156, 200, { angle: 0 }))
fireTimers(3000)
ck('H6 一直没对齐就不会淡出（框得留着引导）', p8.data.guide.hidden === false)

const p9 = loadPage()
p9.onFaceAnchor(anchor(162, 200, 156, 200, { angle: 0 }))
p9.onUnload()
ck('H7 离开页面时清掉淡出定时器', p9._guideFadeTimer === null && timers.length === 0,
  '剩余定时器 ' + timers.length)

/* ================= F wxml 接线 ================= */

console.log('\n[F] wxml 接线')

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
ck('F1 有取景框元素', /class="face-guide is-\{\{guide\.state\}\}/.test(wxml))
ck('F1b 框带 is-hidden 淡出类（对齐后自动退场）',
  /guide\.hidden \? 'is-hidden'/.test(wxml))
ck('F2 框的几何来自 JS 算出的 px 值（不是写死的 CSS 百分比）',
  /left: \{\{guide\.cx\}\}px/.test(wxml) && /width: \{\{guide\.w\}\}px/.test(wxml))
ck('F3 框在相机未就绪 / 手动定位 / 模拟器时都不显示',
  /guide\.show && cameraReady && !manualOn && !isDevtools/.test(wxml))
ck('F4 框对读屏隐藏（同样信息 statusText 已播报，不能念两遍）',
  /class="face-guide[^"]*"[\s\S]{0,220}aria-hidden="true"/.test(wxml))
ck('F5 首次引导文案指向虚线框，而不是笼统的「画面」',
  /把头放进中间的虚线框/.test(wxml))

/* ================= 汇总 ================= */

console.log('\n[取景引导框] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('\n失败项:')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('  覆盖：框几何 / 对齐判定 / 夹取不自欺 / 镜像方向 / 状态机与节流 / wxml 接线')
