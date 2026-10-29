/**
 * 寸头：发茬不是长发（第 54 轮）
 *
 * 「寸头看起来像泳帽」是第二批留下的三个未解决项之一，也是十款发型里
 * 最假的一款。拆开看有三个独立的原因：
 *
 *   1. **发丝长度错了两个数量级。**
 *      脸宽 100 单位 ≈ 150mm，所以 1 单位 = 1.5mm。寸头是 3~5mm 的头发，
 *      也就是 2~3.5 单位。而代码里用的是 crownLocks：从头顶拉一条
 *      47 单位长的弧到发际线 —— 那是 7 厘米的长发。
 *      47 单位的长弧 × 16 条在屏幕上就是「被梳子刮过的痕迹」。
 *
 *   2. **轮廓一直包到耳垂以下（y=126），而且底部是一条平边。**
 *      寸头贴着头骨，两侧应该收在太阳穴附近。一条横跨太阳穴的硬边
 *      加上耳前那一块，正好是泳帽的帽檐。
 *
 *   3. **高光太强（sheen.a = 0.20）。**
 *      发茬太短，形不成一整片反光面；0.20 的高光在头顶糊出一条亮带，
 *      那是塑料的质感，不是头发的。
 *
 * 这一轮把身体层换成 `E.stubble()`：短（2.5~5.5 单位）、细（0.8~1.6）、
 * 密（420 簇），方向从颅顶向外辐射。轮廓收到 y=118 并收成尖。
 *
 * 这个测试钉住的就是上面三条 —— 尤其第一条：它是个**数量级**错误，
 * 不是调参能救的，一旦有人把它改回 crownLocks 长弧，A 组立刻红。
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

global.wx = { getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {} }
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const hs = require(path.join(ROOT, 'utils', 'hairstyles'))
const E = require(path.join(ROOT, 'utils', 'hair-engine'))
const src = fs.readFileSync(path.join(ROOT, 'utils', 'hairstyles.js'), 'utf8')
const engSrc = fs.readFileSync(path.join(ROOT, 'utils', 'hair-engine.js'), 'utf8')

const style = hs.getStyle('buzz')
const geom = hs.getGeom(style, 'high')

/* ================= A. 长度必须是发茬 ================= */

console.log('\n[A] 长度：发茬，不是长发')

let maxLen = 0
let totalLen = 0
for (const s of geom.body) {
  let len = 0
  for (let i = 1; i < s.pts.length; i++) {
    const dx = s.pts[i].x - s.pts[i - 1].x
    const dy = s.pts[i].y - s.pts[i - 1].y
    len += Math.sqrt(dx * dx + dy * dy)
  }
  totalLen += len
  if (len > maxLen) maxLen = len
}
const avgLen = totalLen / geom.body.length

ck('A1 最长发丝 ≤ 9 单位（≈13mm）', maxLen <= 9, maxLen.toFixed(1))
ck('A2 平均长度 ≤ 6 单位（≈9mm）', avgLen <= 6, avgLen.toFixed(2))
// 之前用 crownLocks 时平均长度是 40 单位上下，这条会直接抓住回退
// 边缘渐短（stubble 的 edgeShrink）会把外圈压到 1 单位左右，
// 所以下限不能定太高，只要不退化成「一堆点」就行
ck('A3 平均长度 ≥ 1.5 单位（不能退化成点）', avgLen >= 1.5, avgLen.toFixed(2))

/* ================= B. 不许越出轮廓 ================= */

console.log('\n[B] 轮廓：贴着头骨，不外炸')

// perSegment 必须给大。采样点是用**弦**去逼近三次曲线的，
// 8 段在一条 90 单位长的弧上，弦和曲线的偏差有 1 个多单位 ——
// 贴边界的发丝会被误判成「越界」。24 段之后偏差降到 0.1 以下。
const outlinePts = E.sampleOps(geom.outline[0], 24)
function inside(px, py) {
  let hit = false
  const n = outlinePts.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = outlinePts[i]
    const b = outlinePts[j]
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

let outside = 0
let worst = 0
for (const s of geom.body) {
  for (const p of s.pts) {
    if (inside(p.x, p.y)) continue
    outside++
    // 离轮廓多远（粗略用 bbox 判断，够用）
    const dx = Math.max(0, Math.abs(p.x - 100) - 60)
    const dy = Math.max(0, p.y - 126)
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > worst) worst = d
  }
}
const ratio = outside / (geom.body.length * geom.body[0].pts.length)
ck('B1 越界采样点 < 6%', ratio < 0.06, (ratio * 100).toFixed(1) + '%')
ck('B2 越界不超过 4 单位', worst <= 4, worst.toFixed(1))

/* ================= C. 脸上不能有发茬 ================= */

console.log('\n[C] 额头和颧骨上不能有发茬')

function countIn(x0, x1, y0, y1) {
  let n = 0
  for (const s of geom.body) {
    for (const p of s.pts) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) n++
    }
  }
  return n
}

// 发际线在 y≈84~92，眉骨在 108。92~108 这一段必须是干净的皮肤。
const forehead = countIn(60, 140, 95, 108)
ck('C1 眉骨以上到发际线之间没有发茬', forehead === 0, '命中 ' + forehead)

// 颧骨：脸的左右两侧（|x-100| 40~50），y 120~150
const cheekL = countIn(50, 60, 120, 150)
const cheekR = countIn(140, 150, 120, 150)
ck('C2a 左颧骨没有发茬', cheekL === 0, '命中 ' + cheekL)
ck('C2b 右颧骨没有发茬', cheekR === 0, '命中 ' + cheekR)

/* ================= D. 轮廓收在太阳穴 ================= */

console.log('\n[D] 轮廓：收在太阳穴，不是帽檐')

/** 去掉注释再扫，否则注释里提到的函数名会被算成「还在用」 */
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const block = stripComments(src.slice(src.indexOf("id: 'buzz'"), src.indexOf("id: 'crop'")))
const mv = block.match(/M\(\s*(\d+),\s*(\d+)\s*\)/)
ck('D1 起点（鬓角）在 y ≤ 120', mv && Number(mv[2]) <= 120, mv && mv[2])
// 泳帽的特征是「两侧一直包到耳垂以下」，也就是有 y>120 的竖直边
ck('D2 没有 y > 120 的轮廓点', !/M\(\s*\d+,\s*12[1-9]\)|C\([^)]*,\s*1[3-9]\d\s*\)/.test(block))

/* ================= E. 哑光 ================= */

console.log('\n[E] 质感：哑光')

ck('E1 高光强度 ≤ 0.14', style.sheen.a <= 0.14, String(style.sheen.a))

/* ================= F. 静态：用的是 stubble ================= */

console.log('\n[F] 生成器')

ck('F1 引擎导出了 stubble', /stubble:\s*stubble/.test(engSrc))
ck('F2 引擎定义了 stubble', /function stubble\(/.test(engSrc))
ck('F3 寸头调用 E.stubble', /E\.stubble\(/.test(block))
ck('F4 寸头不再用 crownLocks 拉长弧', block.indexOf('crownLocks') < 0)
ck('F5 寸头不再用 panels 画侧边', block.indexOf('panels(') < 0)

// 洞的形状必须是矩形：椭圆的上沿在两侧会往下掉，额角会漏
ck('F6 洞是圆角矩形（不是椭圆）', /hole:\s*\{\s*rect:\s*true/.test(block))
ck('F7 洞的上沿和轮廓发际线对齐（y=84）', /y0:\s*84/.test(block))

// 体积：缩略图预算 12KB
const uri = hs.buildThumb(style, hs.getColor('black'), 140)
ck('F8 缩略图 ≤ 12KB', uri.length <= 12 * 1024, uri.length + 'B')

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
