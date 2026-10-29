// 羊毛卷下半球层次回归测试。
//
// 背景：curly 曾整片死黑（中带死黑率 69~83%）。根因有三个，缺一都会复发：
//   A. 卷簇撒点椭圆只盖头顶，侧下方 lobe（x<52 / x>148，y 110..176）没有卷粒；
//   B. 卷簇画在 panels 之前 —— 6 束宽 15 的暗色长发束整片盖住 lobe，亮卷全被压住；
//   C. 发块填充的径向渐变外圈只抬 lift*0.35，黑发下缝里露出的仍是 shadow（≈纯黑）。
// 另外卷簇必须按轮廓裁剪（bounds），否则会垂进脖子正中（fit-check 下巴项）。
//
// 这里用节点级几何断言锁住 A/B/C 的结果，不依赖浏览器截图。
const path = require('path')
const root = path.join(__dirname, '..')
const E = require(path.join(root, 'utils/hair-engine'))
const hs = require(path.join(root, 'utils/hairstyles'))

let pass = 0
let fail = 0
function ck(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  [' + detail + ']' : '')) }
}

console.log('=== 羊毛卷下半球层次 ===')
const style = hs.getStyle('curly')
const geom = hs.getGeom(style, 'high')

// --- 1. lobe 内必须有足量亮发丝（锁住 A+B：撒点覆盖 + 绘制顺序） ---
// 每条发丝取中点判断归属。tone 是 clampTone(base+shadeAt) 后的最终值。
function mid(s) {
  const p = s.pts
  return p[Math.floor(p.length / 2)]
}
let lobeTotal = 0
let lobeBright = 0
for (const s of geom.body) {
  const m = mid(s)
  if (m.y >= 110 && m.y <= 176 && (m.x < 52 || m.x > 148)) {
    lobeTotal++
    if (s.tone > 0.2) lobeBright++
  }
}
ck('F1 侧下 lobe 有发丝覆盖', lobeTotal >= 800, '实际 ' + lobeTotal)
ck('F2 lobe 内亮发丝(tone>0.2) >= 150', lobeBright >= 150,
  '实际 ' + lobeBright + '（死黑复发的特征是这个数掉回两位数）')

// --- 3. lobe 亮度分布：中位 tone 不得深于 -0.10（锁住 C：填充抬升） ---
const tones = []
for (const s of geom.body) {
  const m = mid(s)
  if (m.y >= 120 && m.y <= 160 && (m.x < 52 || m.x > 148)) tones.push(s.tone)
}
tones.sort((a, b) => a - b)
const p50 = tones.length ? tones[Math.floor(tones.length * 0.5)] : -1
ck('F3 y120-160 侧带 tone 中位数 >= -0.10', p50 >= -0.10, '实际 ' + p50.toFixed(2))

// --- 4. 卷簇按轮廓裁剪：起点/终点不得飞出发型轮廓 ---
const locks = style.locks()
const outlinePts = E.sampleOps(style.outline()[0], 16)
let tuftOut = 0
let tuftN = 0
for (const l of locks) {
  if (!l.tuft) continue
  tuftN++
  const p = l.p
  const n = p.length / 2
  // 起点与终点都要在轮廓内（终点允许少量越界是碎卷的设计意图，
  // 但只允许 5 个单位以内 —— 越多了就是悬空的毛）
  if (!E.inPoly(p[0], p[1], outlinePts)) tuftOut++
  const ex = p[(n - 1) * 2]
  const ey = p[(n - 1) * 2 + 1]
  if (!E.inPoly(ex, ey, outlinePts)) {
    const dx = ex - p[0]
    const dy = ey - p[1]
    if (Math.sqrt(dx * dx + dy * dy) > 5) tuftOut++
  }
}
ck('F4 卷簇出轮廓(>5单位)的比例 < 2%', tuftOut / Math.max(1, tuftN) < 0.02,
  tuftOut + '/' + tuftN)

// --- 5. 脖子正中（下巴）不得被卷簇侵入 ---
// fit-check 的下巴区：x 79..121, y 184..199
let chinHits = 0
for (const s of geom.body) {
  const m = mid(s)
  if (m.x >= 79 && m.x <= 121 && m.y >= 184 && m.y <= 199) chinHits++
}
ck('F5 下巴区(脖子正中)发丝 <= 8 条', chinHits <= 8, '实际 ' + chinHits)

// --- 6. 卷簇画在 panels 之后（锁住绘制顺序 B） ---
// tuft 锁在 locks 数组里的平均序号必须大于 panels 锁的平均序号。
let tuftIdx = []
let panelIdx = []
locks.forEach((l, i) => {
  if (l.tuft) tuftIdx.push(i)
  else panelIdx.push(i)
})
const tuftAvg = tuftIdx.reduce((a, b) => a + b, 0) / Math.max(1, tuftIdx.length)
const panelAvg = panelIdx.reduce((a, b) => a + b, 0) / Math.max(1, panelIdx.length)
ck('F6 卷簇序号在长发束之后（画在上面）', tuftAvg > panelAvg,
  'tuft均值 ' + tuftAvg.toFixed(0) + ' vs 其他 ' + panelAvg.toFixed(0))

console.log('---')
console.log(fail === 0 ? '全部通过 (' + pass + ')' : '失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
