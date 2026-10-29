// 渲染自检：跑遍所有发型 × 发色，检查坐标合法性、几何包围盒、SVG 体积
const hs = require('../utils/hairstyles')

let problems = 0
let ops = 0
const issues = []

function bad(msg) {
  issues.push(msg)
  problems++
}

function makeCtx(label) {
  const check = function (name, args) {
    ops++
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (typeof v === 'number' && !isFinite(v)) {
        bad('NaN/Infinity ' + label + ' ' + name + ' arg' + i)
        return
      }
    }
  }
  const grad = { addColorStop() {} }
  return {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    clip() {},
    arc() {
      check('arc', [].slice.call(arguments))
    },
    ellipse() {
      check('ellipse', [].slice.call(arguments))
    },
    fill() {},
    stroke() {},
    fillRect() {},
    clearRect() {},
    drawImage() {},
    createLinearGradient() {
      return grad
    },
    createRadialGradient() {
      return grad
    },
    moveTo() {
      check('moveTo', [].slice.call(arguments))
    },
    lineTo() {
      check('lineTo', [].slice.call(arguments))
    },
    bezierCurveTo() {
      check('bezierCurveTo', [].slice.call(arguments))
    }
  }
}

const boxes = [
  { x: 0, y: 0, w: 360, h: 432, angle: 0 },
  { x: -40, y: 120, w: 240, h: 288, angle: 0.3 },
  { x: 100, y: -60, w: 900, h: 1080, angle: -0.52 }
]

/* ---------- 1. 绘制路径合法性 ---------- */
hs.HAIR_STYLES.forEach(function (style) {
  hs.HAIR_COLORS.forEach(function (color) {
    boxes.forEach(function (box) {
      const ctx = makeCtx(style.id + '/' + color.id)
      try {
        hs.drawHair(ctx, box, style.id, color.id, 1)
      } catch (e) {
        bad('THROW ' + style.id + '/' + color.id + ' ' + e.message)
      }
    })
  })
})

/* ---------- 2. 几何统计与越界检查 ---------- */
function bboxOf(strands) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (const s of strands) {
    for (const p of s.pts) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  }
  return { x0, y0, x1, y1 }
}

console.log('=== 几何统计 ===')
console.log('style'.padEnd(15), 'strands'.padStart(8), 'edge'.padStart(6), 'tone范围'.padStart(14), 'bbox'.padStart(28))

const stats = []
hs.HAIR_STYLES.forEach(function (style) {
  const geom = hs.getGeom(style, 'high')
  const bb = bboxOf(geom.body)
  let tmin = 9, tmax = -9
  for (const s of geom.body) {
    if (s.tone < tmin) tmin = s.tone
    if (s.tone > tmax) tmax = s.tone
  }
  stats.push({ id: style.id, n: geom.body.length, edge: geom.edge.length, bb, tmin, tmax })

  console.log(
    style.id.padEnd(15),
    String(geom.body.length).padStart(8),
    String(geom.edge.length).padStart(6),
    (tmin.toFixed(2) + ' ~ ' + tmax.toFixed(2)).padStart(14),
    ('x ' + bb.x0.toFixed(0) + '..' + bb.x1.toFixed(0) + '  y ' + bb.y0.toFixed(0) + '..' + bb.y1.toFixed(0)).padStart(28)
  )

  // 发丝必须覆盖足够的画布面积，否则说明生成器算错了
  if (geom.body.length < 80) bad('STRAND TOO FEW ' + style.id + ' = ' + geom.body.length)
  if (bb.x1 - bb.x0 < 60) bad('BBOX TOO NARROW ' + style.id + ' w=' + (bb.x1 - bb.x0).toFixed(1))
  if (bb.y1 - bb.y0 < 40) bad('BBOX TOO SHORT ' + style.id + ' h=' + (bb.y1 - bb.y0).toFixed(1))
  // 越界：允许边缘发丝溢出一点，但不应飞出去
  if (bb.x0 < -12 || bb.x1 > 212 || bb.y0 < -12 || bb.y1 > 252) {
    bad('BBOX OUT OF RANGE ' + style.id)
  }
  // 色调必须铺开，否则没有体积感
  if (tmax - tmin < 0.7) bad('TONE RANGE TOO NARROW ' + style.id + ' = ' + (tmax - tmin).toFixed(2))
})

/* ---------- 3. 左右平衡 ---------- */
console.log('=== 左右平衡 ===')
hs.HAIR_STYLES.forEach(function (style) {
  const geom = hs.getGeom(style, 'high')
  const bb = bboxOf(geom.body)
  const lw = 100 - bb.x0
  const rw = bb.x1 - 100
  const diff = Math.abs(lw - rw)
  // 马尾、背头这类天然不对称的跳过
  const asym = style.id === 'ponytail' || style.id === 'pompadour' || style.id === 'middle-part'
  const tag = diff > 14 && !asym ? '  <-- 偏斜' : ''
  console.log(style.id.padEnd(15), ('L' + lw.toFixed(0) + ' R' + rw.toFixed(0)).padStart(10), tag)
  if (diff > 22 && !asym) bad('ASYMMETRIC ' + style.id + ' diff=' + diff.toFixed(1))
})

/* ---------- 3.5 发丝覆盖率 ---------- */
// 把发型区域栅格化，逐格检查有没有发丝覆盖。
// 这一项专门用来抓「轮廓内有一块只有底色、没有发丝」的裸露带 ——
// 冠部发束的终点弧和轮廓内边界对不上时就会出现，肉眼表现为一条死黑的横带。
console.log('=== 发丝覆盖率 ===')

const CELL = 4
const GW = Math.ceil(200 / CELL)
const GH = Math.ceil(240 / CELL)

function pathToPolyline(ops) {
  const pts = []
  let cur = null
  for (const op of ops) {
    const t = op[0]
    if (t === 'M') {
      cur = [op[1], op[2]]
      pts.push(cur)
    } else if (t === 'L') {
      cur = [op[1], op[2]]
      pts.push(cur)
    } else if (t === 'C') {
      const p = [cur[0], cur[1], op[1], op[2], op[3], op[4], op[5], op[6]]
      for (let i = 1; i <= 8; i++) {
        const mt = 1 - i / 8
        const a = mt * mt * mt, b = 3 * mt * mt * (i / 8), c = 3 * mt * (i / 8) * (i / 8), d = Math.pow(i / 8, 3)
        pts.push([
          a * p[0] + b * p[2] + c * p[4] + d * p[6],
          a * p[1] + b * p[3] + c * p[5] + d * p[7]
        ])
      }
      cur = [op[5], op[6]]
    }
  }
  return pts
}

// 射线法：点是否在闭合折线内（偶奇规则，可以处理带内轮廓的 U 形）
function inside(poly, x, y) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

console.log('style'.padEnd(15), 'hair格'.padStart(7), '有发丝'.padStart(7), '覆盖率'.padStart(8), '最大空洞'.padStart(9), '靠边缘'.padStart(8))

hs.HAIR_STYLES.forEach(function (style) {
  const geom = hs.getGeom(style, 'high')
  const poly = pathToPolyline(geom.outline[0])

  // 发丝覆盖的格子集合。
  // 只统计主体发丝（body）：边缘碎发和分隔线是装饰性的细丝，
  // 如果一块区域只靠它们"覆盖"，视觉上仍然是一片死黑的底色。
  const covered = new Set()
  const all = geom.body
  const mark = function (x, y) {
    const gx = Math.floor(x / CELL)
    const gy = Math.floor(y / CELL)
    // 半径 1 格扩散，避免细发丝穿过格子却落不进采样点
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) covered.add((gx + dx) + ',' + (gy + dy))
    }
  }
  // 边缘发丝单独记一份：贴着轮廓的那几格本来就该由它们负责
  // （真实头发在轮廓处也是由超出边界的碎发收尾的），
  // 所以这些格子不算"裸露"；但内部空洞仍然必须由 body 覆盖。
  const edgeTouched = new Set()
  const markEdge = function (x, y) {
    const gx = Math.floor(x / CELL)
    const gy = Math.floor(y / CELL)
    edgeTouched.add(gx + ',' + gy)
  }
  for (const s of geom.edge || []) {
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i]
      const b = s.pts[i + 1]
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.max(1, Math.ceil(d / (CELL * 0.5)))
      for (let k = 0; k <= steps; k++) {
        markEdge(a.x + (b.x - a.x) * (k / steps), a.y + (b.y - a.y) * (k / steps))
      }
    }
    markEdge(s.pts[s.pts.length - 1].x, s.pts[s.pts.length - 1].y)
  }
  for (const s of all) {
    // 沿折线逐段插值标记，不能只标记顶点 ——
    // 发丝多边形的相邻顶点最多可相隔 20 个单位，
    // 只标顶点会在中间漏出一整条带子，误报成"裸露"。
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i]
      const b = s.pts[i + 1]
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.max(1, Math.ceil(d / (CELL * 0.5)))
      for (let k = 0; k <= steps; k++) {
        mark(a.x + (b.x - a.x) * (k / steps), a.y + (b.y - a.y) * (k / steps))
      }
    }
    mark(s.pts[s.pts.length - 1].x, s.pts[s.pts.length - 1].y)
  }

  let hairCells = 0
  let hitCells = 0
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const x = gx * CELL + CELL / 2
      const y = gy * CELL + CELL / 2
      if (!inside(poly, x, y)) continue
      hairCells++
      if (covered.has(gx + ',' + gy)) hitCells++
    }
  }

  const rate = hairCells ? hitCells / hairCells : 1
  // 统计最大连续空洞面积（以格为单位，BFS 求最大连通块）
  const empty = []
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const x = gx * CELL + CELL / 2
      const y = gy * CELL + CELL / 2
      if (inside(poly, x, y) && !covered.has(gx + ',' + gy) && !edgeTouched.has(gx + ',' + gy)) {
        empty.push(gx + ',' + gy)
      }
    }
  }
  const emptySet = new Set(empty)
  let maxHole = 0
  let holeAt = ''
  while (emptySet.size) {
    const start = emptySet.values().next().value
    emptySet.delete(start)
    const q = [start]
    const cells = []
    while (q.length) {
      const cur = q.pop()
      cells.push(cur)
      const [cx, cy] = cur.split(',').map(Number)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (cx + dx) + ',' + (cy + dy)
        if (emptySet.has(k)) {
          emptySet.delete(k)
          q.push(k)
        }
      }
    }
    if (cells.length > maxHole) {
      maxHole = cells.length
      let sx = 0, sy = 0
      for (const c of cells) {
        const [cx, cy] = c.split(',').map(Number)
        sx += cx * CELL + CELL / 2
        sy += cy * CELL + CELL / 2
      }
      holeAt = '(' + Math.round(sx / cells.length) + ',' + Math.round(sy / cells.length) + ')'
    }
  }

  // 只被边缘发丝覆盖、body 没碰到的格子数：这个数越大说明越靠边界碎发撑场面
  let edgeOnly = 0
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if (!covered.has(gx + ',' + gy) && edgeTouched.has(gx + ',' + gy)) edgeOnly++
    }
  }

  console.log(
    style.id.padEnd(15),
    String(hairCells).padStart(7),
    String(hitCells).padStart(7),
    ((rate * 100).toFixed(1) + '%').padStart(8),
    String(maxHole).padStart(9),
    String(edgeOnly).padStart(8),
    holeAt
  )

  if (rate < 0.90) bad('LOW COVERAGE ' + style.id + ' = ' + (rate * 100).toFixed(1) + '%')
  // 单个连通空洞超过 12 格（约 190 平方单位）就是一条肉眼可见的裸露带
  if (maxHole > 12) bad('BARE PATCH ' + style.id + ' = ' + maxHole + ' cells')
})

/* ---------- 4. 缩略图合法性 ---------- */
let svgBad = 0
let maxLen = 0
let maxStyle = ''
hs.HAIR_STYLES.forEach(function (style) {
  hs.HAIR_COLORS.forEach(function (color) {
    const uri = hs.buildThumb(style.id, color.id)
    if (uri.indexOf('data:image/svg+xml') !== 0) {
      bad('BAD URI ' + style.id + '/' + color.id)
      svgBad++
    }
    // 缩略图 URI 是 base64 形态（真机 image 只认 base64 的 data URI），
    // 这里要按 base64 解回 SVG 源码再检查内容
    const head = uri.split(',')[0] || ''
    const body = uri.split(',').slice(1).join(',')
    const svg = head.indexOf('base64') >= 0
      ? Buffer.from(body, 'base64').toString('utf8')
      : decodeURIComponent(body)
    if (/NaN|undefined|Infinity/.test(svg)) {
      bad('BAD SVG VALUE ' + style.id + '/' + color.id)
      svgBad++
    }
    // 至少要有发块 + 2 个色调层，否则说明发丝没画出来
    if ((svg.match(/<path/g) || []).length < 3) {
      bad('TOO FEW PATHS ' + style.id + '/' + color.id)
      svgBad++
    }
    if (uri.length > maxLen) {
      maxLen = uri.length
      maxStyle = style.id + '/' + color.id
    }
    if (uri.length > 12000) bad('THUMB TOO BIG ' + style.id + '/' + color.id + ' = ' + uri.length)
  })
})

console.log('=== 缩略图 ===')
console.log('最大 data URI:', maxLen, 'bytes @', maxStyle)
console.log('10 张预估:', Math.round((maxLen * 10) / 1024), 'KB')

/* ---------- 汇总 ---------- */
console.log('---')
console.log('发型数:', hs.HAIR_STYLES.length, '发色数:', hs.HAIR_COLORS.length)
console.log('绘制调用次数:', ops)
console.log('问题数:', problems)

if (problems > 0) {
  console.log('=== 问题清单 ===')
  issues.slice(0, 30).forEach(function (m) {
    console.log(' -', m)
  })
  process.exit(1)
}
console.log('全部通过')
