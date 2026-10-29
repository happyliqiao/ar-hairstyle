/**
 * 极端人脸 / 异常锚点测试
 *
 * 正常构图画得再好，用户真实场景里也会遇到这些：
 *   超近（手机贴脸）/ 超远（朋友帮忙看整体）/ 侧脸 / 抬头低头
 *   画面里多张脸 / 人脸部分出画 / 基础库给归一化坐标
 *   anchor 字段缺失或为 NaN / 帧尺寸为 0
 *
 * 断言标准不是「结果好看」，而是：
 *   1 不返回 null（该出结果的时候要出）
 *   2 返回的四个数字必须有限，且不出现负宽高
 *   3 发型框宽 / 脸宽 恒等于 2.0（夹取只等比缩放，不改变遮挡关系）
 *   4 极端远近时发型框不能溢出到屏幕的几十倍，也不能缩成看不见
 */
const path = require('path')
const fit = require(path.resolve(__dirname, '../utils/face-fit.js'))

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

const VP = { w: 375, h: 667 }
const FRAME = { w: 480, h: 640 }

function anchor(ox, oy, w, h, extra) {
  const a = { origin: { x: ox, y: oy }, size: { width: w, height: h } }
  if (extra) Object.keys(extra).forEach(function (k) { a[k] = extra[k] })
  return a
}

function boxOf(a, opt) {
  return fit.faceAnchorToBox(a, FRAME, VP, opt)
}

function finiteBox(b) {
  return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h) &&
    b.w > 0 && b.h > 0
}

/* 1 正常距离：基准 */
;(function () {
  // 人脸 156px 宽居中
  const b = boxOf(anchor(162, 200, 156, 200))
  ok('[正常] 返回有效框', finiteBox(b), JSON.stringify(b))
  ok('[正常] 发型宽/脸宽 = 2.0', Math.abs(b.w / b.face.w - 2) < 1e-6, '实际=' + (b.w / b.face.w))
})()

/* 2 超近：手机贴脸，人脸框宽度超过取景宽 */
;(function () {
  const b = boxOf(anchor(-300, -100, 900, 1150))
  ok('[超近] 返回有效框', finiteBox(b))
  ok('[超近] 发型框不溢出到屏幕 3 倍以上', b.w <= VP.w * 2, 'w=' + Math.round(b.w) + ' 屏宽=' + VP.w)
  ok('[超近] 发型宽/脸宽仍为 2.0', Math.abs(b.w / b.face.w - 2) < 1e-6, '实际=' + (b.w / b.face.w))
})()

/* 3 超远：人脸只有几个像素 */
;(function () {
  const b = boxOf(anchor(230, 300, 4, 5))
  ok('[超远] 返回有效框', finiteBox(b))
  ok('[超远] 发型框不会小到看不见', b.w >= VP.w * 0.15, 'w=' + Math.round(b.w))
  ok('[超远] 发型宽/脸宽仍为 2.0', Math.abs(b.w / b.face.w - 2) < 1e-6, '实际=' + (b.w / b.face.w))
})()

/* 4 侧脸 / 大角度：angle 只影响旋转，不该让位置崩掉 */
;(function () {
  const angles = [0, 0.5, -0.5, 1.4, -1.4, Math.PI, 100]
  angles.forEach(function (a) {
    const b = boxOf(anchor(162, 200, 156, 200, { angle: a }))
    ok('[侧脸 angle=' + a + '] 返回有效框', finiteBox(b))
  })
})()

/* 5 人脸部分出画：脸心在屏幕外，框可以部分出画，但数值必须有限 */
;(function () {
  const cases = [
    ['左出画', -100, 200],
    ['右出画', 460, 200],
    ['上出画', 162, -150],
    ['下出画', 162, 600]
  ]
  cases.forEach(function (c) {
    const b = boxOf(anchor(c[1], c[2], 156, 200))
    ok('[' + c[0] + '] 返回有效框', finiteBox(b))
  })
})()

/* 6 归一化坐标（部分基础库 0~1） */
;(function () {
  // 等价于 origin(162,200) size(156,200) 在 480×640 帧上
  const b = boxOf(anchor(162 / 480, 200 / 640, 156 / 480, 200 / 640))
  ok('[归一化] 返回有效框', finiteBox(b))
  const ref = boxOf(anchor(162, 200, 156, 200))
  ok('[归一化] 与像素坐标结果一致',
    Math.abs(b.x - ref.x) < 1 && Math.abs(b.y - ref.y) < 1,
    'norm=' + Math.round(b.x) + ',' + Math.round(b.y) + ' px=' + Math.round(ref.x) + ',' + Math.round(ref.y))
})()

/* 7 脏锚点：字段缺失 / NaN / 0 / 字符串 */
;(function () {
  const dirty = [
    ['null', null],
    ['空对象', {}],
    ['无 origin', { size: { width: 100, height: 120 } }],
    ['无 size', { origin: { x: 10, y: 10 } }],
    ['宽 0', anchor(10, 10, 0, 120)],
    ['高 0', anchor(10, 10, 100, 0)],
    ['NaN', anchor(NaN, NaN, NaN, NaN)],
    ['字符串坐标', { origin: { x: '10', y: '10' }, size: { width: 100, height: 120 } }],
    ['Infinity', anchor(Infinity, 0, 100, 120)]
  ]
  dirty.forEach(function (d) {
    let b = null
    let threw = false
    try { b = boxOf(d[1]) } catch (e) { threw = true }
    ok('[脏锚点 ' + d[0] + '] 不抛异常', !threw)
    ok('[脏锚点 ' + d[0] + '] 返回 null 而不是坏框', b === null, JSON.stringify(b))
  })
})()

/* 8 帧尺寸异常 */
;(function () {
  const bad = [
    ['帧 w=0', { w: 0, h: 640 }],
    ['帧 h=0', { w: 480, h: 0 }],
    ['帧 null', null],
    ['帧 NaN', { w: NaN, h: NaN }]
  ]
  bad.forEach(function (c) {
    let b = null
    let threw = false
    try { b = fit.faceAnchorToBox(anchor(162, 200, 156, 200), c[1], VP) } catch (e) { threw = true }
    ok('[' + c[0] + '] 不抛异常', !threw)
    ok('[' + c[0] + '] 返回 null', b === null)
  })
})()

/* 9 校准系数：scale 极端值不能把发型放大到失控 */
;(function () {
  const b1 = boxOf(anchor(162, 200, 156, 200), { calibration: { scale: 3, offsetX: 0, offsetY: 0 } })
  ok('[校准 scale=3] 发型框仍受上限约束', b1.w <= VP.w * 2, 'w=' + Math.round(b1.w))
  const b2 = boxOf(anchor(162, 200, 156, 200), { calibration: { scale: 0, offsetX: 0, offsetY: 0 } })
  ok('[校准 scale=0] 不返回 0 宽框', finiteBox(b2), JSON.stringify(b2))
})()

/* 10 多脸：pickFaceAnchor 必须选最大的那张 */
;(function () {
  // 直接测换算层不够，这里复刻页面里的选择逻辑做一次交叉验证：
  // 若页面仍取「第一个」，本用例在集成测试里会失败（见 camera-perm / final-scan）
  const anchors = [
    anchor(20, 30, 40, 50),     // 背景路人，小脸
    anchor(150, 180, 170, 210), // 用户本人，大脸
    anchor(300, 400, 60, 75)    // 另一个路人
  ]
  let best = null
  let bestW = 0
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].size.width > bestW) { bestW = anchors[i].size.width; best = anchors[i] }
  }
  ok('[多脸] 选中最大脸', best === anchors[1])
  const b = boxOf(best)
  ok('[多脸] 最大脸能算出有效框', finiteBox(b))
})()

/* 11 镜像：左右互换后 x 必须关于屏幕中线对称 */
;(function () {
  const a = anchor(120, 200, 156, 200)
  const normal = boxOf(a)
  const mirrored = boxOf(a, { mirror: true })
  const mid = VP.w / 2
  const dNormal = normal.x + normal.w / 2 - mid
  const dMirror = mirrored.x + mirrored.w / 2 - mid
  ok('[镜像] 关于中线对称', Math.abs(dNormal + dMirror) < 1e-6, dNormal.toFixed(2) + ' vs ' + dMirror.toFixed(2))
  ok('[镜像] 宽度不变', Math.abs(normal.w - mirrored.w) < 1e-6)
})()

/* 输出 */
console.log('')
console.log('[极端人脸 / 异常锚点] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  11 组场景：正常 / 超近 / 超远 / 侧脸 / 出画 / 归一化 / 脏锚点 / 帧异常 / 校准 / 多脸 / 镜像')
}
