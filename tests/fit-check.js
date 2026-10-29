/**
 * 用户视角贴合度检测
 *
 * 之前所有测试都在看「发型本身好不好看」，没有一条在验证
 * 「戴到用户脸上位置对不对」。这个文件模拟真机识脸：
 *   取景 375×667、摄像头帧 480×640、人脸框落在画面中上部，
 * 用 utils/face-fit.js（页面里同一份代码）算出发型框，
 * 再把头发包围盒和人脸各部位换算到同一坐标系逐项比对。
 *
 * 合格标准按真实人脸比例推导（脸宽:脸高 = 1:1.28）：
 *   水平中心  必须对齐脸心        —— 偏了就是「发型戴歪」
 *   头顶      必须高过额头        —— 盖不住就是「刘海浮在额头上方」
 *   两侧      必须宽于脸          —— 盖不住就是「一顶帽子扣在脸上」
 *   眼睛      不能盖              —— 盖住就是「刘海糊眼睛」
 *   嘴巴      不能盖              —— 盖住就是「头发垂到嘴里」
 *   额前      按款式要求          —— 有刘海要盖住，背头要露出
 */
const path = require('path')
const faceFit = require(path.join(__dirname, '..', 'utils', 'face-fit'))
const H = require(path.join(__dirname, '..', 'utils', 'hairstyles'))
const E = require(path.join(__dirname, '..', 'utils', 'hair-engine'))

const VIEW_W = faceFit.VIEW_W
const VIEW_H = faceFit.VIEW_H

/* ---------- 模拟真机取景 ---------- */
const VIEWPORT = { w: 375, h: 667 }
const FRAME = { w: 480, h: 640 }
// 人脸框左上角（帧坐标）：脸宽 150、脸高 192（真实 1:1.28 比例），
// 中心落在屏幕 (187.5, 300) —— 用户举手机的典型距离。
const ANCHOR = { origin: { x: 165, y: 192 }, size: { width: 150, height: 192 } }

/* ---------- 每款发型的贴合预期 ---------- */
// forehead: 额前(眉骨以上)应被覆盖的比例；有刘海要高，背头要低
// chin:    下巴正下方那一条（脖子正中）允许被覆盖的比例。
//          **所有款式都必须是 0** —— 头发垂在脖子后面，正面看过去
//          脖子正中间是被脖子自己挡住的，那里出现头发就是一撮山羊胡。
//          这条判据原来写的是「长发要 ≥ 0.10」，等于把 bug 写成了需求：
//          为了让测试变绿，四款长发各自加了一条盖住脖子的补丁。
// neckSide: 脖子两侧（|x| 0.22~0.55 脸宽）。长发必须铺满，
//          短发必须留白 —— 「长发过下巴」这件事现在由这里来验证。
const EXPECT = {
  'buzz':          { forehead: [0.60, 1.01], chin: [0, 0.12], neckSide: [0, 0.25] },
  'crop':          { forehead: [0.70, 1.01], chin: [0, 0.12], neckSide: [0, 0.25] },
  'bob':           { forehead: [0.70, 1.01], chin: [0, 0.12], neckSide: [0, 0.30] },
  'fringe':        { forehead: [0.70, 1.01], chin: [0, 0.12], neckSide: [0, 0.30] },
  'long-straight': { forehead: [0.60, 1.01], chin: [0, 0.12], neckSide: [0.45, 1.01] },
  'wavy':          { forehead: [0.55, 1.01], chin: [0, 0.12], neckSide: [0.45, 1.01] },
  // 背头 / 马尾：头发往后梳，额前只剩高处的发际线。
  // 上界现在要按「包含发块」的口径来定（见 coverage 的注释）：
  // 有刘海的款式是 0.97~1.00，往后梳的是 0.20~0.90。
  'pompadour':     { forehead: [0.00, 0.45], chin: [0, 0.12], neckSide: [0, 0.30] },
  'curly':         { forehead: [0.55, 1.01], chin: [0, 0.12], neckSide: [0.40, 1.01] },
  'ponytail':      { forehead: [0.30, 0.93], chin: [0, 0.12], neckSide: [0, 0.45] },
  'middle-part':   { forehead: [0.60, 1.01], chin: [0, 0.12], neckSide: [0.45, 1.01] }
}

/* ---------- 几何工具 ---------- */

function pointInPoly(px, py, pts) {
  let inside = false
  const n = pts.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** 屏幕矩形 → 虚拟画布矩形 */
function toView(box, r) {
  return {
    x0: ((r.x0 - box.x) / box.w) * VIEW_W,
    x1: ((r.x1 - box.x) / box.w) * VIEW_W,
    y0: ((r.y0 - box.y) / box.h) * VIEW_H,
    y1: ((r.y1 - box.y) / box.h) * VIEW_H
  }
}

/**
 * 虚拟画布矩形被头发覆盖的比例（bbox 预筛 + 网格采样）。
 *
 * 「头发」不只是发丝，还包括**发块本身**（outline 的填充）。
 * 这一点在寸头上是决定性的：寸头是 3mm 的发茬，身体层是几百个
 * 2~5 单位的小点，网格采样落在发丝内部的概率很低 ——
 * 只数发丝的话，一块明明被头发盖满的额前会算出 7%。
 * 所以先把 outline 也算进来：点在轮廓内、且不在挖掉的洞里，
 * 就算被覆盖。轮廓是用 even-odd 射线法判的，洞会自然扣掉。
 */
function coverage(geom, rect, gridN) {
  const outlinePts = E.sampleOps(geom.outline[0], 6)
  const polys = []
  for (const s of geom.body) {
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity
    for (const p of s.pts) {
      if (p.x < bx0) bx0 = p.x
      if (p.x > bx1) bx1 = p.x
      if (p.y < by0) by0 = p.y
      if (p.y > by1) by1 = p.y
    }
    if (bx1 < rect.x0 || bx0 > rect.x1 || by1 < rect.y0 || by0 > rect.y1) continue
    polys.push(s)
  }
  let hit = 0
  let total = 0
  for (let i = 0; i <= gridN; i++) {
    for (let j = 0; j <= gridN; j++) {
      const x = rect.x0 + ((rect.x1 - rect.x0) * i) / gridN
      const y = rect.y0 + ((rect.y1 - rect.y0) * j) / gridN
      total++
      if (pointInPoly(x, y, outlinePts)) { hit++; continue }
      for (const s of polys) {
        if (pointInPoly(x, y, s.pts)) { hit++; break }
      }
    }
  }
  return total ? hit / total : 0
}

function bboxOf(geom, yLo, yHi) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const s of geom.body) {
    for (const p of s.pts) {
      if (yLo != null && (p.y < yLo || p.y > yHi)) continue
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
  }
  return { x0: x0, x1: x1, y0: y0, y1: y1 }
}

/**
 * 只量**头部轮廓**（outline 的第一条子路径）。
 *
 * 「水平中心必须对齐脸心」这条判据问的是「发型戴歪了没有」。
 * 而马尾、侧编发这些延伸物本来就长在头的一侧 —— 把它们的包围盒
 * 算进来，「高马尾」会被判成「中心偏 11.7%」，可用户看到的头是正的。
 * 之前用 y 30~210 裁剪来规避，但高马尾的马尾正好落在这个区间里。
 */
function bboxOfHead(geom, yLo, yHi) {
  const pts = E.sampleOps(geom.outline[0], 6)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of pts) {
    if (yLo != null && (p.y < yLo || p.y > yHi)) continue
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x0: x0, x1: x1, y0: y0, y1: y1 }
}

/* ---------- 主流程 ---------- */

const box = faceFit.faceAnchorToBox(ANCHOR, FRAME, VIEWPORT, { mirror: true })
if (!box) { console.log('FATAL: 换算失败'); process.exit(1) }
const face = box.face

console.log('=== 模拟真机识脸 ===')
console.log('取景 ' + VIEWPORT.w + '×' + VIEWPORT.h + '  帧 ' + FRAME.w + '×' + FRAME.h)
console.log('人脸框(屏幕) ' + face.w.toFixed(0) + '×' + face.h.toFixed(0) +
  ' @ (' + face.cx.toFixed(1) + ',' + face.cy.toFixed(1) + ')')
console.log('发型框 ' + box.w.toFixed(0) + '×' + box.h.toFixed(0) +
  '  发型宽/脸宽 = ' + (box.w / face.w).toFixed(3) + ' (期望 2.000)')
console.log('')

let fail = 0
const rows = []

for (const style of H.HAIR_STYLES) {
  const geom = H.getGeom(style, 'high')
  const exp = EXPECT[style.id] || { forehead: [0, 1], chin: [0, 1] }
  const bad = []
  const m = {}

  // 两个包围盒，用途不同：
  //   bbHead —— 头部轮廓，用来判断「戴没戴歪」。马尾长在头的一侧，
  //             把它算进来会把「高马尾」判成偏 11.7%。
  //   bb     —— 全部发丝，用来判断「盖没盖住脸」。用户眼睛量到的是
  //             发丝外沿，轮廓线藏在里面，只看轮廓会把寸头判成「只比脸宽 5%」。
  const bbHead = bboxOfHead(geom, 30, 210)
  const bb = bboxOf(geom, 30, 210)
  const hcx0 = box.x + (bbHead.x0 / VIEW_W) * box.w
  const hcx1 = box.x + (bbHead.x1 / VIEW_W) * box.w
  const hy0 = box.y + (bb.y0 / VIEW_H) * box.h
  const hy1 = box.y + (bb.y1 / VIEW_H) * box.h
  const hairCx = (hcx0 + hcx1) / 2
  const hairW = (box.x + (bb.x1 / VIEW_W) * box.w) - (box.x + (bb.x0 / VIEW_W) * box.w)

  // 1) 水平中心对齐
  m.center = (hairCx - face.cx) / face.w
  if (Math.abs(m.center) > 0.03) bad.push('中心偏 ' + (m.center * 100).toFixed(1) + '%')

  // 2) 头顶高过额头：头发顶端应在脸顶之上 3%~30% 脸高
  m.crown = (face.cy - face.h / 2 - hy0) / face.h
  if (m.crown < 0.03) bad.push('头顶只高 ' + (m.crown * 100).toFixed(0) + '%')
  if (m.crown > 0.32) bad.push('头顶过高 ' + (m.crown * 100).toFixed(0) + '%')

  // 3) 两侧宽于脸
  m.side = (hairW - face.w) / face.w
  if (m.side < 0.08) bad.push('只比脸宽 ' + (m.side * 100).toFixed(0) + '%')
  if (m.side > 0.85) bad.push('比脸宽 ' + (m.side * 100).toFixed(0) + '% 过度')

  // 4) 眼睛不能被盖
  // 区域必须按真实眼位收窄：两眼中心约在脸心两侧 0.11 脸宽处，
  // 单眼宽约 0.12 脸宽，所以眼区取 ±0.22 脸宽。
  // 早期版本取 ±0.32，那一带正好是太阳穴 —— 侧发本来就该在那里，
  // 于是每款都被误报成「遮眼」。
  const eye = toView(box, {
    x0: face.cx - face.w * 0.22, x1: face.cx + face.w * 0.22,
    y0: face.cy - face.h * 0.10, y1: face.cy + face.h * 0.03
  })
  m.eye = coverage(geom, eye, 11)
  if (m.eye > 0.10) bad.push('遮眼 ' + (m.eye * 100).toFixed(0) + '%')

  // 5) 嘴巴不能被盖
  const mouth = toView(box, {
    x0: face.cx - face.w * 0.25, x1: face.cx + face.w * 0.25,
    y0: face.cy + face.h * 0.28, y1: face.cy + face.h * 0.42
  })
  m.mouth = coverage(geom, mouth, 9)
  if (m.mouth > 0.12) bad.push('遮嘴 ' + (m.mouth * 100).toFixed(0) + '%')

  // 6) 额前覆盖（眉骨以上到发际线）
  const forehead = toView(box, {
    x0: face.cx - face.w * 0.38, x1: face.cx + face.w * 0.38,
    y0: face.cy - face.h * 0.48, y1: face.cy - face.h * 0.20
  })
  m.forehead = coverage(geom, forehead, 9)
  if (m.forehead < exp.forehead[0] - 1e-9 || m.forehead > exp.forehead[1] + 1e-9) {
    bad.push('额前 ' + (m.forehead * 100).toFixed(0) + '%[' +
      (exp.forehead[0] * 100).toFixed(0) + '~' + (exp.forehead[1] * 100).toFixed(0) + ']')
  }

  // 7) 下巴正下方（脖子正中）
  const chin = toView(box, {
    x0: face.cx - face.w * 0.20, x1: face.cx + face.w * 0.20,
    y0: face.cy + face.h * 0.46, y1: face.cy + face.h * 0.56
  })
  m.chin = coverage(geom, chin, 9)
  if (m.chin < exp.chin[0] - 1e-9 || m.chin > exp.chin[1] + 1e-9) {
    bad.push('下巴 ' + (m.chin * 100).toFixed(0) + '%[' +
      (exp.chin[0] * 100).toFixed(0) + '~' + (exp.chin[1] * 100).toFixed(0) + ']')
  }

  // 7b) 脖子两侧：长发在这里必须有头发，短发必须没有
  const nsl = toView(box, {
    x0: face.cx - face.w * 0.55, x1: face.cx - face.w * 0.22,
    y0: face.cy + face.h * 0.46, y1: face.cy + face.h * 0.56
  })
  const nsr = toView(box, {
    x0: face.cx + face.w * 0.22, x1: face.cx + face.w * 0.55,
    y0: face.cy + face.h * 0.46, y1: face.cy + face.h * 0.56
  })
  m.neckSide = Math.min(coverage(geom, nsl, 9), coverage(geom, nsr, 9))
  if (m.neckSide < exp.neckSide[0] - 1e-9 || m.neckSide > exp.neckSide[1] + 1e-9) {
    bad.push('颈侧 ' + (m.neckSide * 100).toFixed(0) + '%[' +
      (exp.neckSide[0] * 100).toFixed(0) + '~' + (exp.neckSide[1] * 100).toFixed(0) + ']')
  }

  rows.push({ id: style.id, m: m, bad: bad })
  fail += bad.length
}

const cols = [
  ['中心', r => (r.m.center * 100).toFixed(1) + '%'],
  ['顶高', r => (r.m.crown * 100).toFixed(0) + '%'],
  ['侧宽', r => (r.m.side * 100).toFixed(0) + '%'],
  ['遮眼', r => (r.m.eye * 100).toFixed(0) + '%'],
  ['遮嘴', r => (r.m.mouth * 100).toFixed(0) + '%'],
  ['额前', r => (r.m.forehead * 100).toFixed(0) + '%'],
  ['下巴', r => (r.m.chin * 100).toFixed(0) + '%'],
  ['颈侧', r => (r.m.neckSide * 100).toFixed(0) + '%']
]
console.log('style'.padEnd(15) + cols.map(c => c[0].padStart(7)).join('') + '   问题')
for (const r of rows) {
  console.log(r.id.padEnd(15) + cols.map(c => c[1](r).padStart(7)).join('') +
    '   ' + (r.bad.length ? r.bad.join('  ') : 'OK'))
}
console.log('')
console.log(fail === 0 ? '全部通过：' + rows.length + ' 款发型在模拟人脸上遮挡关系全部正确'
  : '不合格项 ' + fail + ' 个')

// 换算自检：脸心应落在画面中央
if (Math.abs(face.cx - VIEWPORT.w / 2) > 1 || Math.abs(face.cy - VIEWPORT.h * 0.45) > 2) {
  console.log('换算自检失败：脸心 (' + face.cx.toFixed(1) + ',' + face.cy.toFixed(1) + ')')
  fail++
}
process.exit(fail === 0 ? 0 : 1)
