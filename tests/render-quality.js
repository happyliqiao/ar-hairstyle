/**
 * 渲染质量的回归基线（第 41 轮）
 *
 * 前 40 轮都在做「代码会不会塌」，这一轮回到用户最原始的要求：
 * **看起来要像真头发，不能卡通**。
 *
 * 跑了一次真实绘制路径的截图（tests/canvas-shot.html），发现两处明显破绽：
 *
 *   1. 发际线上有一圈**均匀的亮描边**。原因是 edgeStrands 把贴脸发丝
 *      一律提亮到 tone 0.72（本意是「逆光绒发」），几十根等距排开，
 *      远看就是假发套的边。
 *
 *   2. 寸头的发际线是「中间高、两侧低」的浅弧 —— 画出来是一条横贯前额、
 *      中间微微上凸的线，像帽子的前沿。真人发际线是反过来的：
 *      两侧额角更高（露出更多额头），中央略低，形成一个 M 形开口。
 *
 * 两处都改了。这一轮把改动钉成可回归的指标 —— 渲染这种东西最容易
 * 「改别的时候顺手又改回去了」，靠眼睛看截图是发现不了的。
 *
 * 注意：整体「头发仍偏实心块」的问题**没有解决**，见文件末尾的说明。
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

const hs = require(path.join(ROOT, 'utils/hairstyles'))

/* ================= A. 贴脸发丝不能一律提亮 ================= */

console.log('\n[A] 发际线上的发丝：多数暗、少数亮')

const FACE = { cx: 100, cy: 118, rx: 50, ry: 64 }

function edgeStats(styleId) {
  const geom = hs.getGeom(hs.getStyle(styleId), 'high')
  let nearFace = 0
  let bright = 0
  let sum = 0
  for (let i = 0; i < geom.edge.length; i++) {
    const s = geom.edge[i]
    const p = s.pts[0]
    const ax = (p.x - FACE.cx) / FACE.rx
    const ay = (p.y - FACE.cy) / FACE.ry
    const d = ax * ax + ay * ay
    // 只统计贴脸那一圈（椭圆内或紧贴椭圆的）
    if (d > 1.35) continue
    nearFace++
    sum += s.tone
    if (s.tone > 0.4) bright++
  }
  return {
    nearFace: nearFace,
    bright: bright,
    brightRate: nearFace ? bright / nearFace : 0,
    avgTone: nearFace ? sum / nearFace : 0
  }
}

let worstBright = 0
let worstStyle = ''
let totalNear = 0
const perStyle = []
for (let i = 0; i < hs.HAIR_STYLES.length; i++) {
  const id = hs.HAIR_STYLES[i].id
  const st = edgeStats(id)
  perStyle.push({ id: id, st: st })
  totalNear += st.nearFace
  if (st.brightRate > worstBright) { worstBright = st.brightRate; worstStyle = id }
}

ck('A1 统计到足够的贴脸发丝样本', totalNear > 200, 'n=' + totalNear)

// 原来是 100% 提亮（tone 0.72），改后只有约 16% 是亮丝
ck('A2 亮丝占比低于 40%（原来接近 100%）', worstBright < 0.4,
  '最高 ' + (worstBright * 100).toFixed(0) + '% @ ' + worstStyle)
ck('A3 亮丝占比不是 0（还要保留一点逆光绒毛感）', worstBright > 0.02,
  '最高 ' + (worstBright * 100).toFixed(0) + '%')

// 平均 tone 应该接近发块本色，而不是 0.545（tanh 压缩后的 0.72）
let maxAvg = 0
let maxAvgStyle = ''
for (let i = 0; i < perStyle.length; i++) {
  if (perStyle[i].st.avgTone > maxAvg) { maxAvg = perStyle[i].st.avgTone; maxAvgStyle = perStyle[i].id }
}
ck('A4 贴脸发丝平均 tone 低于 0.35（提亮版的平均值约 0.55）', maxAvg < 0.35,
  '最高 ' + maxAvg.toFixed(3) + ' @ ' + maxAvgStyle)

console.log('    ' + perStyle.map(function (x) {
  return x.id + ':' + (x.st.brightRate * 100).toFixed(0) + '%/' + x.st.avgTone.toFixed(2)
}).join('  '))

/* ================= B. 贴脸发丝的密度 ================= */

console.log('\n[B] 发际线密度不能回到「等距铺满」')

// 改前是沿轮廓每个采样点都生成；改后贴脸处又砍掉一半。
// 用「贴脸发丝数 / 轮廓长度」衡量，避免受发型尺寸影响。
let maxDensity = 0
let maxDensityStyle = ''
for (let i = 0; i < hs.HAIR_STYLES.length; i++) {
  const style = hs.HAIR_STYLES[i]
  const geom = hs.getGeom(style, 'high')
  const st = edgeStats(style.id)
  // 用外轮廓包围盒的宽度做尺度
  let x0 = Infinity
  let x1 = -Infinity
  const ops = geom.outline[0]
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op[0] === 'M' || op[0] === 'L') {
      if (op[1] < x0) x0 = op[1]
      if (op[1] > x1) x1 = op[1]
    } else if (op[0] === 'C') {
      if (op[1] < x0) x0 = op[1]
      if (op[1] > x1) x1 = op[1]
      if (op[3] < x0) x0 = op[3]
      if (op[3] > x1) x1 = op[3]
      if (op[5] < x0) x0 = op[5]
      if (op[5] > x1) x1 = op[5]
    }
  }
  const w = Math.max(1, x1 - x0)
  const density = st.nearFace / w
  if (density > maxDensity) { maxDensity = density; maxDensityStyle = style.id }
}
ck('B1 贴脸发丝密度低于 1.6 根/单位宽', maxDensity < 1.6,
  '最高 ' + maxDensity.toFixed(2) + ' @ ' + maxDensityStyle)

/* ================= C. 寸头的 M 形发际线 ================= */

console.log('\n[C] 寸头发际线是 M 形（额角高、中央低）')

function outlineYAtX(ops, targetX) {
  // 在轮廓上按段采样，找 x 最接近 targetX 的点。
  // 同一条竖线通常有**两个**交点（头顶一个、发际线一个），
  // 我们要的是发际线那个 —— 也就是 y 更大（更靠下）的那个。
  // 只取「第一个命中」会拿到头顶，测出来永远是 M 形不成立。
  let best = null
  let bestD = Infinity
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op[0] === 'M') {
      cx = op[1]; cy = op[2]; sx = cx; sy = cy
    } else if (op[0] === 'L') {
      for (let t = 0; t <= 1; t += 0.1) {
        const x = cx + (op[1] - cx) * t
        const y = cy + (op[2] - cy) * t
        const d = Math.abs(x - targetX)
        if (d < bestD || (Math.abs(d - bestD) < 0.6 && best && y > best.y)) {
          if (d < bestD) bestD = d
          best = { x: x, y: y }
        }
      }
      cx = op[1]; cy = op[2]
    } else if (op[0] === 'C') {
      for (let t = 0; t <= 1; t += 0.05) {
        const mt = 1 - t
        const x = mt * mt * mt * cx + 3 * mt * mt * t * op[1] + 3 * mt * t * t * op[3] + t * t * t * op[5]
        const y = mt * mt * mt * cy + 3 * mt * mt * t * op[2] + 3 * mt * t * t * op[4] + t * t * t * op[6]
        const d = Math.abs(x - targetX)
        if (d < bestD || (Math.abs(d - bestD) < 0.6 && best && y > best.y)) {
          if (d < bestD) bestD = d
          best = { x: x, y: y }
        }
      }
      cx = op[5]; cy = op[6]
    } else if (op[0] === 'Z') {
      cx = sx; cy = sy
    }
  }
  return best
}

const buzzGeom = hs.getGeom(hs.getStyle('buzz'), 'high')
const ops = buzzGeom.outline[0]
const mid = outlineYAtX(ops, 100)
const leftTemple = outlineYAtX(ops, 62)

ck('C1 能取到发际线中点', !!mid && Math.abs(mid.x - 100) < 3, JSON.stringify(mid))
ck('C2 能取到左侧额角点', !!leftTemple && Math.abs(leftTemple.x - 62) < 4, JSON.stringify(leftTemple))
// 屏幕坐标 y 向下：中央的 y 更大 = 中央更低 = 额头中央被头发盖得更多
ck('C3 发际线中央低于两侧额角（M 形）',
  mid && leftTemple && mid.y - leftTemple.y > 3,
  'mid.y=' + (mid && mid.y.toFixed(1)) + ' temple.y=' + (leftTemple && leftTemple.y.toFixed(1)))

/* ================= D. 边缘发丝总量 ================= */

console.log('\n[D] 边缘发丝总量在预算内')

let maxEdge = 0
let maxEdgeStyle = ''
for (let i = 0; i < hs.HAIR_STYLES.length; i++) {
  const id = hs.HAIR_STYLES[i].id
  const geom = hs.getGeom(hs.getStyle(id), 'high')
  if (geom.edge.length > maxEdge) { maxEdge = geom.edge.length; maxEdgeStyle = id }
}
ck('D1 单款边缘发丝不超过 200 根', maxEdge <= 200,
  '最高 ' + maxEdge + ' @ ' + maxEdgeStyle)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '渲染质量基线：全部通过' : '渲染质量基线：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
console.log('\n已知未解决：整体仍偏「实心块」，见 tests/shot-buzz2.png')
