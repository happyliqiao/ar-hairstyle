/**
 * 发丝级发型渲染引擎
 *
 * 纯几何计算模块，不依赖 canvas / wx，可同时在
 *   1) 小程序 Canvas 2D（实时渲染 + 离屏烘焙）
 *   2) Node 测试环境（SVG 序列化 + 数值自检）
 * 两个后端复用同一份几何数据。
 *
 * 设计要点：
 * - 种子随机（mulberry32）：同一款发型每次生成的发丝分布完全一致，
 *   否则实时预览时每帧发丝都会抖动。
 * - 发束（lock）→ 细发丝（strand）两层结构：
 *   发束决定整体流向与体量，细发丝提供表面质感。手写 150 条贝塞尔不现实，
 *   所以只定义 10~18 条发束，再沿法线展开成细发丝。
 * - 每条细发丝是「锥形多边形」而非等宽描边：根部粗、梢部收成针尖，
 *   这是真实头发最关键的形态特征。
 * - 明暗不是整体贴一层白，而是按每条发丝的**空间位置**相对光源计算色调，
 *   形成自然的体积感。
 */

/* ============================================================
 * 一、种子随机
 * ============================================================ */

/** FNV-1a 字符串哈希，用来把 styleId 变成稳定的种子 */
function hashStr(s) {
  var h = 2166136261 >>> 0
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** mulberry32：小、快、分布好，同种子必然同序列 */
function mulberry32(seed) {
  var a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    var t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ============================================================
 * 二、颜色工具
 * ============================================================ */

function hex2rgb(h) {
  var s = h.charAt(0) === '#' ? h.slice(1) : h
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  var n = parseInt(s, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

function hex2(n) {
  var s = n.toString(16)
  return s.length < 2 ? '0' + s : s
}

function rgb2hex(r, g, b) {
  return '#' + hex2(clamp255(r)) + hex2(clamp255(g)) + hex2(clamp255(b))
}

/** 线性插值两个颜色，t=0 取 a，t=1 取 b */
function mixHex(a, b, t) {
  var A = hex2rgb(a)
  var B = hex2rgb(b)
  return rgb2hex(
    A.r + (B.r - A.r) * t,
    A.g + (B.g - A.g) * t,
    A.b + (B.b - A.b) * t
  )
}

/** amt > 0 向白色提亮，amt < 0 向黑色压暗 */
function shade(hex, amt) {
  return amt >= 0 ? mixHex(hex, '#ffffff', amt) : mixHex(hex, '#000000', -amt)
}

/** 加透明度，输出 rgba() 字符串 */
function rgba(hex, a) {
  var c = hex2rgb(hex)
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'
}

/**
 * 由基色 + 高光色推导出完整的 6 阶色板。
 * 真实头发从发根到发梢、从背光到迎光，色调跨度远大于「两色渐变」，
 * 必须显式建模，否则看起来就是一块塑料。
 */
function buildRamp(base, sheenTint) {
  var sheen = sheenTint || shade(base, 0.56)
  return {
    shadow: shade(base, -0.62),
    deep: shade(base, -0.34),
    base: base,
    mid: shade(base, 0.18),
    tip: shade(base, 0.36),
    sheen: sheen,
    rim: shade(sheen, 0.34),
    swatch: base
  }
}

/**
 * 色调值 tone ∈ [-1, 1] → 具体颜色（连续插值）
 * tone: -1 最暗（发根/背光）… 0 基调 … +1 最强高光
 */
var TONE_STOPS = [-1.0, -0.5, 0.0, 0.36, 0.7, 1.0]
function toneColor(ramp, tone) {
  var t = tone < -1 ? -1 : tone > 1 ? 1 : tone
  var keys = [ramp.shadow, ramp.deep, ramp.base, ramp.mid, ramp.tip, ramp.sheen]
  for (var i = 0; i < TONE_STOPS.length - 1; i++) {
    if (t <= TONE_STOPS[i + 1]) {
      var span = TONE_STOPS[i + 1] - TONE_STOPS[i]
      var u = span === 0 ? 0 : (t - TONE_STOPS[i]) / span
      return mixHex(keys[i], keys[i + 1], u)
    }
  }
  return keys[keys.length - 1]
}

/* ============================================================
 * 三、贝塞尔与路径采样
 * ============================================================ */

/** 椭圆上某角度对应的点（角度用弧度，canvas 坐标系 y 向下） */
function ptOn(cx, cy, rx, ry, a) {
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
}

/** 三次贝塞尔求点，p = [x0,y0, x1,y1, x2,y2, x3,y3] */
function bez(p, t) {
  var mt = 1 - t
  var a = mt * mt * mt
  var b = 3 * mt * mt * t
  var c = 3 * mt * t * t
  var d = t * t * t
  return {
    x: a * p[0] + b * p[2] + c * p[4] + d * p[6],
    y: a * p[1] + b * p[3] + c * p[5] + d * p[7]
  }
}

/** 三次贝塞尔求切向 */
function bezD(p, t) {
  var mt = 1 - t
  var a = 3 * mt * mt
  var b = 6 * mt * t
  var c = 3 * t * t
  return {
    x: a * (p[2] - p[0]) + b * (p[4] - p[2]) + c * (p[6] - p[4]),
    y: a * (p[3] - p[1]) + b * (p[5] - p[3]) + c * (p[7] - p[5])
  }
}

/**
 * 采样一条发束中心线，返回带单位法线的点序列。
 * wave 让发丝沿法线做正弦摆动（大波浪、羊毛卷靠它成形）。
 */
function sampleCurve(p, n, wave) {
  var out = []
  var last = n - 1
  for (var i = 0; i < n; i++) {
    var t = last === 0 ? 0 : i / last
    var pos = bez(p, t)
    var d = bezD(p, t)
    var len = Math.sqrt(d.x * d.x + d.y * d.y) || 1
    var nx = -d.y / len
    var ny = d.x / len
    var x = pos.x
    var y = pos.y
    if (wave) {
      // 摆动幅度随 t 增大（发根不摆，发梢摆得厉害）
      var env = Math.pow(t, wave.power == null ? 0.7 : wave.power)
      var off = wave.amp * Math.sin(t * Math.PI * 2 * wave.freq + (wave.phase || 0)) * env
      x += nx * off
      y += ny * off
    }
    out.push({ x: x, y: y, nx: nx, ny: ny, t: t })
  }
  return out
}

/**
 * 采样一组路径指令（M / L / C / Z），按固定步数均匀取点。
 * 用于沿轮廓生成「边缘破碎发丝」和「边缘光」。
 */
function sampleOps(ops, perSegment) {
  var pts = []
  var cur = null
  var per = perSegment || 6
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i]
    var t = op[0]
    if (t === 'M') {
      cur = { x: op[1], y: op[2] }
    } else if (t === 'L' && cur) {
      for (var k = 0; k <= per; k++) {
        var u = k / per
        pts.push({ x: cur.x + (op[1] - cur.x) * u, y: cur.y + (op[2] - cur.y) * u })
      }
      cur = { x: op[1], y: op[2] }
    } else if (t === 'C' && cur) {
      var p = [cur.x, cur.y, op[1], op[2], op[3], op[4], op[5], op[6]]
      for (var j = 1; j <= per; j++) {
        var v = bez(p, j / per)
        pts.push({ x: v.x, y: v.y })
      }
      cur = { x: op[5], y: op[6] }
    }
  }
  // 补法线
  for (var m = 0; m < pts.length; m++) {
    var a = pts[m === 0 ? 0 : m - 1]
    var b = pts[m === pts.length - 1 ? m : m + 1]
    var dx = b.x - a.x
    var dy = b.y - a.y
    var len = Math.sqrt(dx * dx + dy * dy) || 1
    pts[m].nx = -dy / len
    pts[m].ny = dx / len
  }
  return pts
}

/* ============================================================
 * 四、发束生成器
 * ============================================================ */

/** 把一条发束的贝塞尔控制点沿 x=100 镜像 */
function mirrorLock(p) {
  return [200 - p[0], p[1], 200 - p[2], p[3], 200 - p[4], p[5], 200 - p[6], p[7]]
}

/** 确定性伪随机：不依赖 rng 状态，同样入参永远同样结果 */
function wob(i, seed) {
  var x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * 冠部发束：从分缝/头顶一片小弧，扇形铺到发际线弧。
 * 这一层决定「头发是从哪里长出来、往哪个方向梳」。
 *
 * 两个内建修正，避免每处调用都手写：
 * 1) start 弧强制一个最小宽度 —— 所有发束汇聚到一个点，会在头顶留下
 *    放射状的"蜘蛛"痕迹，真实头发是从一条带子上长出来的。
 * 2) 发梢做确定性抖动 —— 否则发际线会像刀切的一样齐。
 */
function crownLocks(o) {
  var out = []
  var n = o.count
  var start = o.start
  var end = o.end
  var bulge = o.bulge == null ? 0.16 : o.bulge
  var endJitter = o.endJitter == null ? 6 : o.endJitter
  var srx = Math.max(start.rx, 12)
  var sry = Math.max(start.ry, 5)
  for (var i = 0; i < n; i++) {
    var u = n === 1 ? 0.5 : i / (n - 1)
    var a = start.a0 + (start.a1 - start.a0) * u
    var b = end.a0 + (end.a1 - end.a0) * u
    var r = ptOn(start.cx, start.cy, srx * (0.78 + wob(i, 3) * 0.52), sry * (0.8 + wob(i, 4) * 0.45), a)
    var t = ptOn(end.cx, end.cy, end.rx, end.ry, b)
    if (endJitter) {
      t[0] += (wob(i, 1) - 0.5) * endJitter * 0.6
      t[1] += (wob(i, 2) - 0.5) * endJitter
    }
    var dx = t[0] - r[0]
    var dy = t[1] - r[1]
    // 控制点沿法线外推，让发束鼓出弧线而不是直线
    var nx = -dy
    var ny = dx
    var nl = Math.sqrt(nx * nx + ny * ny) || 1
    nx /= nl
    ny /= nl
    var push = Math.sqrt(dx * dx + dy * dy) * bulge
    var p = [
      r[0], r[1],
      r[0] + dx * 0.35 + nx * push, r[1] + dy * 0.35 + ny * push,
      r[0] + dx * 0.72 + nx * push * 0.6, r[1] + dy * 0.72 + ny * push * 0.6,
      t[0], t[1]
    ]
    out.push({
      p: p,
      w: o.width,
      n: o.fine,
      tone: o.tone || 0,
      conv: o.conv,
      // 每条发束错开相位，波浪才会互相交错而不是整体平移
      wave: o.wave
        ? {
            amp: o.wave.amp,
            freq: o.wave.freq,
            phase: (o.wave.phase || 0) + u * 2.4,
            power: o.wave.power
          }
        : undefined
    })
  }
  return out
}

/**
 * 面板发束：在两条引导曲线之间铺满发束。
 *
 * 侧边头发本质上是一「块」面板，用内/外两条引导曲线夹住它，
 * 中间按 u 线性插值控制点生成发束，就能精确铺满整块面板。
 * 用弧线 + 外扩系数做不到这一点 —— 那样发束会全挤在中间，
 * 面板靠近脸的一侧和靠外的一侧都会裸露，渲染出来就是一块平板。
 *
 * @param {object} o
 *   inner / outer: [x0,y0, c1x,c1y, c2x,c2y, x3,y3] 三次贝塞尔
 */
function panelLocks(o) {
  var inner = o.inner
  var outer = o.outer
  var out = []
  for (var i = 0; i < o.count; i++) {
    var u = o.count === 1 ? 0.5 : i / (o.count - 1)
    // 轻微非线性：让发束在外侧更密一点，符合真实头发的分布
    var uu = Math.pow(u, o.curvePow == null ? 1 : o.curvePow)
    var p = []
    for (var k = 0; k < 8; k++) p.push(inner[k] + (outer[k] - inner[k]) * uu)
    // 发梢参差：齐发尾如果完全平齐会像假发片，真实剪裁总有几毫米的差异
    var jt = o.tipJitter == null ? 3.4 : o.tipJitter
    if (jt) {
      p[7] += (wob(i, 5) - 0.5) * jt
      p[5] += (wob(i, 6) - 0.5) * jt * 0.6
    }
    // 每条发束给不同的波浪相位。如果整个面板共用一个相位，
    // 所有发束会整体一起摆动 —— 形状上完全看不出来，只是整块平移。
    // 相位错开之后才会互相交错，形成真正的波浪结构。
    var wv = o.wave
    if (wv) {
      wv = {
        amp: wv.amp,
        freq: wv.freq,
        phase: (wv.phase || 0) + uu * (o.phaseSpread == null ? 3.2 : o.phaseSpread),
        power: wv.power
      }
    }
    out.push({
      p: p,
      w: o.width,
      n: o.fine,
      tone: o.tone || 0,
      conv: o.conv,
      wave: wv
    })
  }
  return out
}

/**
 * 侧边垂落发束：从太阳穴/耳侧一片弧，向下垂到发梢线。
 * toY 决定长度（波波头到下巴、长直到胸前），spread 决定发梢外扩程度。
 */
function sideLocks(o) {
  var out = []
  var n = o.count
  var from = o.from
  for (var i = 0; i < n; i++) {
    var u = n === 1 ? 0.5 : i / (n - 1)
    var a = from.a0 + (from.a1 - from.a0) * u
    var r = ptOn(from.cx, from.cy, from.rx, from.ry, a)
    var tipY = typeof o.toY === 'function' ? o.toY(u) : o.toY
    var tipX = 100 + (r[0] - 100) * (o.spread == null ? 1.1 : o.spread)
    // 中段向外鼓，模拟头发离开颅骨后的体量
    var bulge = o.bulge == null ? 10 : o.bulge
    var p = [
      r[0], r[1],
      r[0] + bulge, r[1] + (tipY - r[1]) * 0.22,
      tipX + bulge * 0.35, tipY - (tipY - r[1]) * 0.30,
      tipX, tipY
    ]
    if (o.side < 0) p = mirrorLock(p)
    out.push({
      p: p,
      w: o.width,
      n: o.fine,
      tone: o.tone || 0,
      wave: o.wave
    })
  }
  return out
}

/* ============================================================
 * 五、发束 → 细发丝
 * ============================================================ */

/**
 * 沿法线把每条发束展开成多条细发丝。
 * 细发丝的偏移量在发根处最大、向发梢收敛（真实头发的发丝是聚拢到发梢的）。
 *
 * 色调模型是真实感的核心，由 6 个物理直觉项叠加：
 *   height  越高越受光（头顶亮、发梢暗）
 *   ao      环境光遮蔽：贴着脸的那一圈最暗
 *   tip     发梢透光（光穿过发丝末端）
 *   spec    镜面高光：只在光泽带附近，衰减很陡
 *   valley  发束边缘压暗 → 形成发束之间的暗谷，这是最关键的一项
 *   lockBias 每条发束一个固定偏移 → 相邻发束明暗相间
 */
function expand(locks, rng, opt) {
  var scale = opt && opt.scale != null ? opt.scale : 1
  var samples = (opt && opt.samples) || 10
  var sheen = (opt && opt.sheen) || { x: 72, y: 54, r: 52 }
  var out = []

  for (var li = 0; li < locks.length; li++) {
    var lock = locks[li]
    var center = sampleCurve(lock.p, samples, lock.wave)
    var count = Math.max(1, Math.round((lock.n || 5) * scale))
    var lockW = lock.w[0]
    // 每条发束一个稳定亮度偏移 —— 相邻发束明暗相间。
    // 这个值必须很小：发束内所有发丝共享它，一旦超过 ±0.12，
    // 整条发束就变成一条纯色带，十几种发束并排就是「条形码」。
    // 大范围的明暗应该由 diffuse 承担，发束只做轻微分组。
    var lockBias = (rng() - 0.5) * 0.20
    // 本发束的噪声相位：同一条发束共用，保证横向亮度是连续变化的
    var lockSeed = rng() * 6.2832

    for (var i = 0; i < count; i++) {
      var u = count === 1 ? 0 : (i / (count - 1)) * 2 - 1
      var jit = (rng() - 0.5) * 0.34
      var off = (u + jit) * lockW * 0.5
      // 宽度略大于间距：逐根波动会把相邻发丝拉开，留 12% 重叠才不会露出暗底。
      // 但也不能太大 —— 乘 1.45 会让每条发丝粗到肉眼能数清，那是「描线」不是「头发」；
      // 真实头发是靠极细 + 极密 + 逐根随机明暗堆出质感的。
      var sw = (lockW / count) * 1.12 * (0.82 + rng() * 0.42)

      // 逐根发丝的亮度抖动，拆成两部分：
      //   一部分只跟发丝在发束里的位置 u 有关（相邻发丝取值接近，形成连续过渡），
      //   另一部分才是纯随机（提供细碎颗粒）。
      // 如果整项都做成纯随机，相邻发丝的明暗会毫无规律地跳变，
      // 一片片并排起来就是「条形码」—— 这是刘海最难去掉的塑料感来源。
      var grainPos = Math.sin(u * 1.9 + lockSeed) * 0.55 + Math.sin(u * 4.7 + lockSeed * 2.3) * 0.3
      var grain = grainPos * 0.20 + (rng() - 0.5) * 0.17

      // 每根发丝自己的波动相位、频率、幅度。
      // 之前整条发束共用一条引导曲线，所有发丝只是沿法线平移，
      // 于是变成一排严格平行的线 —— 这才是「条形码」感的真正来源，
      // 光调明暗是治不好的。真实头发的每根发丝都有独立的卷曲相位，
      // 彼此交叉、分开、再合拢，视觉上才有「绒」的质感。
      var ph = rng() * 6.2832
      var freq = 0.6 + rng() * 1.6
      var amp = lockW * (0.05 + rng() * 0.13)

      var pts = []
      var convAmt = lock.conv == null ? 0.52 : lock.conv
      for (var k = 0; k < center.length; k++) {
        var t = center[k].t
        // 发束向发梢收敛的程度。短发收敛强（一束束很清楚），
        // 长发必须收敛弱 —— 收敛太强会在发束之间留出竖向暗缝，
        // 长发看起来就变成一根一根的绳子了。
        var conv = 1 - convAmt * t
        // 发根固定在头皮上，所以波动幅度按 t 放大，只在后半段散开
        var wob = Math.sin(t * 6.2832 * freq + ph) * amp * (0.18 + 0.82 * t)
        var offK = off * conv + wob
        pts.push({
          x: center[k].x + center[k].nx * offK,
          y: center[k].y + center[k].ny * offK,
          nx: center[k].nx,
          ny: center[k].ny,
          t: t
        })
      }

      var mid = pts[Math.floor(pts.length * 0.45)]
      var last = pts[pts.length - 1]

      var valley = -Math.pow(Math.abs(u), 1.8) * 0.26
      var baseTone = (lock.tone || 0) + lockBias + valley + grain

      // 把「某一点受多少光」抽成函数：整根发丝一次算完是最省事的，
      // 但真实发丝从根到梢跨越了头部曲面的不同朝向，受光一直在变。
      // 整根同色会变成一条条死板的长线，所以后面按段分别取样。
      function shadeAt(p) {
        // --- 漫反射：用「发丝相对头部中心的径向位置」近似表面法线 ---
        // 之前用「高度」当受光量是错的：刘海在头部的位置很低，但它正对观察者，
        // 物理上是全脸最受光的地方，用高度算会把它压成一条死黑的横带。
        // 这里把头部近似成椭球，nx/ny 是法线的水平/垂直分量，
        // nz 由 1 - nx² - ny² 推出（球面约束），再用左上偏前的方向做点积。
        var rx3 = (p.x - 100) / 60
        var ry3 = (p.y - 118) / 76
        var rr = rx3 * rx3 + ry3 * ry3
        // 椭球外的头发（马尾、披在肩上的长发）必须把方向投影回椭球面，
        // 而不是把法线清零。清零会让整条马尾得到一个恒定的暗值，
        // 于是一大团头发没有任何明暗变化，变成一块黑布。
        var nz
        if (rr > 1) {
          var inv = 1 / Math.sqrt(rr)
          rx3 *= inv
          ry3 *= inv
          nz = 0
        } else {
          nz = Math.sqrt(1 - rr)
        }
        var diff = -rx3 * 0.46 - ry3 * 0.50 + nz * 0.73
        if (diff < 0) diff = 0
        // 增益和偏置决定整体明暗。偏置太小会一片死黑，
        // 太大则深色头发被冲成灰白 —— 这一组值是反复对比截图调出来的。
        var diffuse = diff * 0.72 - 0.13

        // 环境光遮蔽：只压脸两侧（那里头发贴着面部、进不了光）
        var aoY = p.y < 105 ? 0 : Math.min(1, (p.y - 105) / 34)
        var ao = -Math.max(0, 1 - Math.abs(p.x - 100) / 72) * 0.16 * aoY

        var tipTerm = 0.16 * Math.pow(p.t, 1.4)

        // 主高光：真实头发的镜面反射是一条「宽而柔」的带，
        // 指数 2.6 会把带压得太窄太硬，看起来像一道白漆刷上去。
        // 降到 1.55 让高光横向铺开，再靠逐根发丝的明暗抖动把它打散成碎光。
        var sdx = (p.x - sheen.x) / sheen.r
        var sdy = (p.y - sheen.y) / (sheen.r * 0.82)
        var sd = Math.sqrt(sdx * sdx + sdy * sdy)
        var spec = sd >= 1 ? 0 : Math.pow(1 - sd, 1.55) * 0.64

        // 次高光：位置更低、更弱。真实头发通常有两道反光，
        // 只有一道会显得像塑料。
        var sdx2 = (p.x - (sheen.x + 26)) / (sheen.r * 1.12)
        var sdy2 = (p.y - (sheen.y + 64)) / (sheen.r * 1.35)
        var sd2 = Math.sqrt(sdx2 * sdx2 + sdy2 * sdy2)
        var spec2 = sd2 >= 1 ? 0 : Math.pow(1 - sd2, 1.9) * 0.28
        if (spec2 > spec) spec = spec2

        return diffuse + ao + tipTerm + spec
      }

      function clampTone(t) {
        // 平滑压缩，不能用硬截断。
        // 硬截断会让所有过曝的发丝同时停在 tone=1，于是它们被染成完全相同的
        // 高光色 —— 在深色头发上就表现为一片片等亮的灰色「刮痕」。
        // tanh 让高光平滑滚降：越亮的发丝仍然更亮，但不会挤成同一个色块。
        return Math.tanh(t * 0.85)
      }

      var w0 = sw
      // 发梢宽度。
      //
      // 原来这里恒等于 sw * 0.09 —— 也就是**无论发束声明了什么梢宽，
      // 收尖比例永远是 9%**。数据里 `width: [9, 2.2]` 的 2.2 从来没被读过。
      //
      // 这个 bug 在齐刘海上是致命的：bob 的刘海是 17 根发束铺满一条
      // 90 单位宽的直线，每根梢宽只剩 9 × 9% = 0.8，17 根加起来才 13.7，
      // 覆盖不到 15% —— 于是发际线处露出一条整齐的黑底，
      // 远看就是假发片下缘那道硬边。
      //
      // 现在按发束自己声明的比例收尖。默认仍是 9%（不改变其他发型的行为），
      // 只有真正需要"发梢不散开"的款式（齐刘海、齐耳短发）才显式调高。
      var tipRatio = (lock.w.length > 1 && lock.w[0] > 0)
        ? Math.max(0.04, Math.min(0.85, lock.w[1] / lock.w[0]))
        : 0.09
      var w1 = Math.max(0.1, sw * tipRatio)

      if (opt && opt.split && pts.length >= 8) {
        // 沿长度切成两段分别取样受光。发梢段额外提亮一点：
        // 光会穿过发丝末端，这是真实头发末端发虚发亮的原因。
        var cut = Math.max(3, Math.round(pts.length * 0.46))
        var segA = pts.slice(0, cut + 1)
        var segB = pts.slice(cut)
        var mA = segA[Math.floor(segA.length * 0.5)]
        var mB = segB[Math.floor(segB.length * 0.5)]
        out.push({
          pts: segA,
          w: [w0, w0 + (w1 - w0) * 0.55],
          tip: tipRatio,
          tone: clampTone(baseTone + shadeAt(mA)),
          edge: Math.abs(u)
        })
        out.push({
          pts: segB,
          w: [w0 + (w1 - w0) * 0.55, w1],
          tip: tipRatio,
          tone: clampTone(baseTone + shadeAt(mB) + 0.05),
          edge: Math.abs(u)
        })
      } else {
        out.push({
          pts: pts,
          w: [w0, w1],
          tip: tipRatio,
          tone: clampTone(baseTone + shadeAt(mid)),
          edge: Math.abs(u)
        })
      }
    }
  }
  return out
}

/**
 * 发丝 → 锥形多边形（左右两侧各一串点，首尾收拢成尖）
 *
 * 宽度沿长度用纺锤形，而不是「根部满宽、梢部收尖」的楔形。
 * 楔形会让所有发根变成一个平头，当一排发束共用同一条起始弧时
 * （刘海、发际线全是这种情况），这些平头一字排开就是一排小黑方块 ——
 * 看起来像拉链齿，是最容易露馅的矢量痕迹之一。
 */
function polygon(s, samples) {
  var pts = s.pts
  var n = pts.length
  var L = []
  var R = []
  for (var i = 0; i < n; i++) {
    var t = n === 1 ? 0 : i / (n - 1)
    // 前 20% 从 0 长到满宽（圆润的发根），之后缓慢收细，末端几乎归零。
    // 注意不能拿梢宽 w[1] 当根部的下限 —— 那样根部就是一个 w[1] 宽的平头，
    // 一排发束共用同一条起始弧（刘海、发际线全是这种情况）时，
    // 这些平头一字排开就是一排小黑方块，像拉链齿。
    var rise = Math.min(1, t / 0.2)
    // 梢宽比例由发束自己声明（s.tip）。缺省 0.06 与旧行为一致。
    //
    // 原来这里硬编码 `1 - t^2.6 * 0.94`，等于所有发丝一律收到 6%。
    // 对披散的长发这是对的（发梢本来就散成细丝），但对"齐"的款式
    // ——齐刘海、齐耳 bob——是错的：它们剪口是一条线，发梢不会散开。
    // 硬收的结果是发际线处露出一条整齐的黑底，像假发片的下缘。
    var tip = s.tip == null ? 0.06 : s.tip
    var prof = Math.pow(rise, 0.62) * (1 - Math.pow(t, 2.6) * (1 - tip))
    var hw = s.w[0] * 0.5 * prof
    var p = pts[i]
    L.push([p.x + p.nx * hw, p.y + p.ny * hw])
    R.push([p.x - p.nx * hw, p.y - p.ny * hw])
  }
  var out = L
  for (var j = R.length - 1; j >= 0; j--) out.push(R[j])
  return out
}

/**
 * 沿轮廓生成「边缘破碎发丝」。
 * 真实头发不会有一条矢量硬边，边缘一定是毛的。
 * 这是提升真实感性价比最高的一步。
 *
 * face: {cx,cy,rx,ry} 脸部椭圆。用它做两件事：
 *   1) 深陷脸内部的点直接跳过
 *   2) 法线朝向脸部时缩短发丝 —— 刘海下沿、贴脸内轮廓都属于这种情况。
 *      如果不缩短，这些位置会堆出一圈短毛，看起来像胡茬或者一道黑边。
 *      朝外的轮廓线则保留全长，形成毛茸茸的边。
 */
function edgeStrands(ops, rng, opt) {
  var pts = sampleOps(ops, opt && opt.perSegment ? opt.perSegment : 5)
  if (!pts.length) return []
  var out = []
  var step = Math.max(1, Math.round((opt && opt.step) || 2))
  var lenMin = (opt && opt.lenMin) || 2
  var lenMax = (opt && opt.lenMax) || 7
  var face = opt && opt.face

  for (var i = 0; i < pts.length; i += step) {
    var p = pts[i]
    if (face) {
      var ax = (p.x - face.cx) / face.rx
      var ay = (p.y - face.cy) / face.ry
      if (ax * ax + ay * ay < 0.5) continue
    }
    // 轮廓切线：取相邻采样点的方向。
    // 边缘碎发必须「顺着发流」而不是「垂直于轮廓外戳」——
    // 垂直外戳的短线段看起来就是一圈胡茬，是大波浪那版最刺眼的破绽。
    var pv = pts[i > 0 ? i - 1 : i]
    var pw = pts[i < pts.length - 1 ? i + 1 : i]
    var tx = pw.x - pv.x
    var ty = pw.y - pv.y
    var tl = Math.sqrt(tx * tx + ty * ty)
    if (tl < 0.001) {
      tx = -p.ny
      ty = p.nx
      tl = 1
    }
    tx /= tl
    ty /= tl

    var count = (opt && opt.per) || 2
    for (var j = 0; j < count; j++) {
      var len = lenMin + rng() * (lenMax - lenMin)
      var skew = (rng() - 0.5) * 0.9
      // 切线为主、法线为辅：既有沿发流的走向，又略微探出轮廓打破硬边
      var outAmt = 0.42 + rng() * 0.34
      var nx = tx * 0.86 + p.nx * outAmt + skew * 0.16
      var ny = ty * 0.86 + p.ny * outAmt + skew * 0.16
      var nl = Math.sqrt(nx * nx + ny * ny) || 1
      nx /= nl
      ny /= nl

      var inward = 0
      if (face) {
        var fx = face.cx - p.x
        var fy = face.cy - p.y
        var fl = Math.sqrt(fx * fx + fy * fy) || 1
        inward = (nx * fx + ny * fy) / fl
      }

      // 发际线、贴脸内轮廓这些位置，发丝是「从皮肤里长出来、往发丛里走」的，
      // 方向必须翻到背向脸部那一侧。
      // 之前让它朝脸内戳，等于在额头上钉了一排深色短齿 —— 这是最难看的破绽。
      var atFace = inward > 0.15
      if (atFace) {
        nx = -nx
        ny = -ny
        inward = -inward
        len *= 0.62
        // 发际线处密度直接砍掉一半。
        // 原来沿整个发际线等距铺满，看起来像一条连续的边；
        // 真实发际线是「疏 — 密 — 疏」的渐变带，中间还夹着几乎空白的段落。
        if (rng() < 0.5) continue
      }

      var bend = (rng() - 0.5) * len * 0.7
      // 贴脸的一圈原来是一律提亮（tone 0.72），本意是「逆光绒发」。
      // 实际效果是发际线上出现一条**均匀的亮描边** —— 远看就是假发套的边，
      // 而且是这一版最刺眼的一处不真实。
      //
      // 真实的发际线上，绝大多数发根是和发块同色的暗丝（有的还更暗，
      // 因为发根处没有反光），只有迎着光的一小段才透出绒毛感。
      // 所以这里改成「绝大多数跟发块同色，少数偏亮」，
      // 亮度也不均匀 —— 这样它才像发根的疏密过渡，而不是一圈线。
      var baseTone = opt && opt.tone != null ? opt.tone : 0.2
      var tone
      if (atFace) {
        tone = rng() < 0.16
          ? 0.5 + rng() * 0.22
          : baseTone + (rng() - 0.5) * 0.34
      } else {
        tone = baseTone + (rng() - 0.5) * 0.62
      }
      // 贴脸那圈必须细到亚像素级：宽度只要到 0.5 单位，
      // 在手机屏幕上就是一根 1.5px 的实心黑条，一排排开就是「梳齿」。
      var wRoot = atFace ? 0.08 + rng() * 0.14 : 0.5 + rng() * 0.85
      // 贴脸的发丝整体收在发块一侧，只让尾尖轻轻探出边界，
      // 探太多就会在额头上钉出一排短齿。
      var tail = atFace ? 0.22 : 0.45
      var s = {
        pts: [
          { x: p.x - nx * len * tail, y: p.y - ny * len * tail, nx: nx, ny: ny, t: 0 },
          { x: p.x + nx * len * 0.3 + ny * bend, y: p.y + ny * len * 0.3 - nx * bend, nx: nx, ny: ny, t: 0.5 },
          { x: p.x + nx * len, y: p.y + ny * len, nx: nx, ny: ny, t: 1 }
        ],
        w: [wRoot, 0.08],
        tone: tone,
        edge: 1
      }
      // 和主体发丝一致：平滑压缩而不是硬截断，否则亮部会挤成同一个色块
      s.tone = Math.tanh(s.tone * 0.85)
      out.push(s)
    }
  }
  return out
}

/**
 * 飞散发丝：从发型轮廓上挑起、脱出轮廓的几缕。
 * 打破轮廓的完整性，是「真人头发」的关键细节。
 *
 * 必须从轮廓采样生成，不能在一个矩形框里随机撒点 ——
 * 那样会有相当一部分落在脸上，变成满脸的乱线。
 */
function flyaways(ops, rng, opt) {
  var pts = sampleOps(ops, opt && opt.perSegment ? opt.perSegment : 5)
  var out = []
  if (!pts.length) return out
  var n = (opt && opt.count) || 14
  var face = opt && opt.face
  var lenMin = (opt && opt.lenMin) || 5
  var lenMax = (opt && opt.lenMax) || 13

  for (var i = 0; i < n; i++) {
    var p = pts[Math.floor(rng() * pts.length)]
    if (face) {
      var ax = (p.x - face.cx) / face.rx
      var ay = (p.y - face.cy) / face.ry
      if (ax * ax + ay * ay < 0.92) continue
    }
    var len = lenMin + rng() * (lenMax - lenMin)
    var skew = (rng() - 0.5) * 1.4
    var nx = p.nx + skew * 0.5
    var ny = p.ny + skew * 0.5
    var nl = Math.sqrt(nx * nx + ny * ny) || 1
    nx /= nl
    ny /= nl

    // 贴着脸的那一段（发际线、鬓角内沿），法线是**朝脸内**的。
    // 直接沿法线甩出去，飞发就会扎到额头和太阳穴上 ——
    // 屏幕上是一丛细细的黑线趴在皮肤上，像蜘蛛腿。
    //
    // edgeStrands 早就处理了这件事（把方向翻到背向脸部），
    // 这里当初漏了。漏掉的后果在背头上最明显：鬓角拐角处的法线
    // 正好指向脸颊，18 根飞发全钉在那儿。
    var atFace = false
    if (face) {
      var fx = face.cx - p.x
      var fy = face.cy - p.y
      var fl = Math.sqrt(fx * fx + fy * fy) || 1
      if ((nx * fx + ny * fy) / fl > 0.15) {
        atFace = true
        nx = -nx
        ny = -ny
        // 朝脸那一侧本来就不该有飞发，长度砍掉六成，
        // 只留一点点毛边压在发际线上
        len *= 0.4
      }
    }
    // 明显的外弯：飞发不会笔直伸出，末端总是勾一下
    var curl = (rng() - 0.5) * len * 1.5
    var sx = p.x - nx * len * 0.15
    var sy = p.y - ny * len * 0.15
    var ex = p.x + nx * len + ny * curl * 0.5
    var ey = p.y + ny * len - nx * curl * 0.5
    var c1x = p.x + nx * len * 0.45 - ny * curl * 0.5
    var c1y = p.y + ny * len * 0.45 + nx * curl * 0.5
    var c2x = p.x + nx * len * 0.8 + ny * curl * 0.8
    var c2y = p.y + ny * len * 0.8 - nx * curl * 0.8
    out.push({
      pts: sampleCurve([sx, sy, c1x, c1y, c2x, c2y, ex, ey], 5, null),
      // 贴脸的那几根也要细到亚像素级，否则还是一排小刺
      w: [atFace ? 0.35 + rng() * 0.35 : 0.55 + rng() * 0.85, 0.08],
      // 朝脸的一侧不许亮：亮线趴在皮肤上就是「发光的蜘蛛腿」，
      // 比暗线更假
      tone: atFace ? 0.05 + rng() * 0.25 : 0.2 + rng() * 0.75,
      edge: 1
    })
  }
  return out
}

/**
 * 发茬：极短的**直**发束，撒在一片椭圆里。
 *
 * 寸头 / 板寸专用。这类发型的本质是「3mm 的发茬」，不是「头发」——
 * 屏幕上应该是一片均匀的细颗粒，而不是几十条长弧线。
 *
 * 为什么不能复用 curlTufts：那个生成器的 S 形控制点偏移是长度的
 * 50%~85%，长度 8 就会横甩 4~7 个单位 —— 撒出来是一头小卷，
 * 像非洲卷而不是寸头。这里只给 3.5% 的弯，肉眼几乎看不出。
 *
 * 方向取「从颅心向外辐射」，符合头发从发旋往外长的实际走向。
 */
/**
 * 点是否落在「挖掉的洞」里。
 *
 * 两种洞：
 *   椭圆   {cx, cy, rx, ry}       —— 卷发用（脸是圆的）
 *   圆角矩形 {rect, x0, x1, y0, y1, r} —— 寸头用
 *
 * 寸头必须用矩形：脸的洞如果写成椭圆，洞的上沿在两侧会往下掉
 * （椭圆在 x 偏离中心处的 y 范围变窄），发茬就从额角两侧漏出来，
 * 在皮肤上撒出一片「胡椒粉」。矩形的上沿是一条直线，不会漏。
 */
function inHole(x, y, hole) {
  if (!hole) return false
  if (hole.rect) {
    var x0 = hole.x0
    var x1 = hole.x1
    var y0 = hole.y0
    var y1 = hole.y1
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    var r = hole.r || 0
    if (r > 0) {
      var qx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x)
      var qy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y)
      var ddx = x - qx
      var ddy = y - qy
      if (ddx * ddx + ddy * ddy > r * r) return false
    }
    return true
  }
  var hx = (x - hole.cx) / hole.rx
  var hy = (y - hole.cy) / hole.ry
  return hx * hx + hy * hy < 1
}

/** 射线法判点是否在多边形内（even-odd） */
function inPoly(px, py, pts) {
  var hit = false
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var a = pts[i]
    var b = pts[j]
    if ((a.y > py) !== (b.y > py) &&
        px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

function stubble(opt) {
  var rng = opt.rng || mulberry32(hashStr('stubble|' + (opt.seed || 0)))
  var out = []
  var n = opt.count || 200
  var cx = opt.cx
  var cy = opt.cy
  var rx = opt.rx
  var ry = opt.ry
  var lenMin = opt.lenMin || 5
  var lenMax = opt.lenMax || 11
  var wMin = opt.wMin == null ? 1.2 : opt.wMin
  var wMax = opt.wMax == null ? 2.4 : opt.wMax
  var hole = opt.hole
  var bounds = opt.bounds
  var spread = opt.spread == null ? 1.1 : opt.spread
  for (var i = 0; i < n; i++) {
    var a = rng() * Math.PI * 2
    var rr = Math.sqrt(rng())
    var x = cx + Math.cos(a) * rx * rr
    var y = cy + Math.sin(a) * ry * rr
    // 挖掉脸：发茬只能长在头皮上，撒到额头上就是一片胡茬
    if (inHole(x, y, hole)) continue
    // 撒的范围是个椭圆，而轮廓不是 —— 在太阳穴那一带，椭圆比轮廓宽，
    // 落在外面的发茬会从鬓角戳出去，屏幕上是一圈毛刺。
    // 传了 bounds（轮廓采样点）就以轮廓为准。
    if (bounds && !inPoly(x, y, bounds)) continue
    var len = lenMin + rng() * (lenMax - lenMin)
    // 边缘渐短：发茬是从头皮长出来的，越靠发际线越不该往外戳。
    // 不做这一步，撒在椭圆边缘的发茬会全部越过轮廓边界，
    // 屏幕上是一圈刺 —— 寸头本来是最服帖的发型，反而最炸。
    if (opt.edgeShrink !== false) {
      var e2 = rr * rr * rr
      len *= 1 - 0.72 * e2
    }
    // 径向 + 一点随机偏角。椭圆的 ry/rx 要参与 atan2，
    // 否则在扁椭圆里方向会整体偏斜。
    var ang = Math.atan2((y - cy) / ry, (x - cx) / rx) + (rng() - 0.5) * spread
    var dx = Math.cos(ang) * len
    var dy = Math.sin(ang) * len
    // 端点不许落进洞里。
    //
    // 只判起点是不够的：起点在洞外紧贴边界时，方向是随机偏的，
    // 有一半会朝脸内长 —— 发茬于是越过发际线糊到额头和颧骨上，
    // 屏幕上是一小片「胡椒粉」撒在皮肤上。洞的外沿越长越明显。
    // 端点进洞就先砍半再试，还进就丢掉这一根。
    if (hole) {
      if (inHole(x + dx, y + dy, hole)) {
        dx *= 0.5
        dy *= 0.5
        if (inHole(x + dx, y + dy, hole)) continue
      }
    }
    if (bounds) {
      if (!inPoly(x + dx, y + dy, bounds)) {
        dx *= 0.5
        dy *= 0.5
        if (!inPoly(x + dx, y + dy, bounds)) continue
      }
    }
    var bend = (rng() - 0.5) * len * 0.35
    out.push({
      p: [
        x, y,
        x + dx * 0.35 - dy * 0.06 + bend * 0.3, y + dy * 0.35 + dx * 0.06,
        x + dx * 0.72 - dy * 0.03, y + dy * 0.72,
        x + dx, y + dy
      ],
      w: [wMin + rng() * wMax, 0.3],
      n: opt.fine || 2,
      tone: (opt.tone || 0) + (rng() - 0.5) * (opt.toneSpread == null ? 0.5 : opt.toneSpread),
      conv: 0.25,
      // 标记为「装饰性高频细节」：缩略图（low）按 1/4 抽样。
      // 不标的话 low 走 1/2，寸头的缩略图会到 26KB —— 而单张预算只有 12KB。
      tuft: 1
    })
  }
  return out
}

/**
 * 卷发簇：在给定椭圆范围内撒一批短 S 形发束。
 *
 * 卷发靠"拉长一条发束再加正弦"是做不出来的 —— 那样只是波浪。
 * 真正的卷发是大量短小、方向各异、互相叠压的小卷簇，
 * 必须用独立的生成器撒，才能堆出羊毛卷那种颗粒感。
 */
function curlTufts(opt) {
  var rng = opt.rng || mulberry32(hashStr('curl|' + (opt.seed || 0)))
  var out = []
  var n = opt.count || 60
  var cx = opt.cx
  var cy = opt.cy
  var rx = opt.rx
  var ry = opt.ry
  var lenMin = opt.lenMin || 8
  var lenMax = opt.lenMax || 16
  var hole = opt.hole
  // bounds：轮廓采样点（sampleOps 的输出）。传了就以轮廓为准——
  // 撒点椭圆永远比轮廓「方」，落在轮廓外的卷会悬空飘在脸旁/脖子正中，
  // 远看是下巴上粘了一撮毛。和 stubble 同一套裁剪逻辑。
  var bounds = opt.bounds
  for (var i = 0; i < n; i++) {
    var a = rng() * Math.PI * 2
    var rr = Math.sqrt(rng())
    var x = cx + Math.cos(a) * rx * rr
    var y = cy + Math.sin(a) * ry * rr
    // 挖掉脸部区域：卷簇只能撒在头发上，撒到脸上就变成一片乱涂
    if (hole) {
      var hx = (x - hole.cx) / hole.rx
      var hy = (y - hole.cy) / hole.ry
      if (hx * hx + hy * hy < 1) continue
    }
    if (bounds && !inPoly(x, y, bounds)) continue
    var len = lenMin + rng() * (lenMax - lenMin)
    var ang = rng() * Math.PI * 2
    var dx = Math.cos(ang) * len
    var dy = Math.sin(ang) * len
    // 端点不许出轮廓/进洞：先砍半再试，还不行就丢掉。
    // 只判起点不够——卷簇的梢部是随机的，一半会朝轮廓外长。
    if (hole) {
      if (inHole(x + dx, y + dy, hole)) {
        dx *= 0.5
        dy *= 0.5
        if (inHole(x + dx, y + dy, hole)) continue
      }
    }
    if (bounds) {
      if (!inPoly(x + dx, y + dy, bounds)) {
        dx *= 0.5
        dy *= 0.5
        if (!inPoly(x + dx, y + dy, bounds)) continue
      }
    }
    // S 形：两个控制点向相反方向偏，形成一个小回勾
    var px = -dy * (0.5 + rng() * 0.35)
    var py = dx * (0.5 + rng() * 0.35)
    var p = [
      x, y,
      x + dx * 0.33 + px, y + dy * 0.33 + py,
      x + dx * 0.66 - px, y + dy * 0.66 - py,
      x + dx, y + dy
    ]
    // 束宽可调。卷发要粗（3~5 单位才堆得出颗粒），
    // 但同一套生成器拿来撒「发茬」时必须细到 1~2.5 ——
    // 3mm 的发茬在屏幕上不该有厚度。
    var wMin = opt.wMin == null ? 2.6 : opt.wMin
    var wMax = opt.wMax == null ? 2.6 : opt.wMax
    // 色调散布可调。默认 ±0.3 对深棕/黑色不够：base 本身就接近死黑，
    // ±0.3 内最亮的卷也到不了 mid 色，卷与卷之间没有明暗差，
    // 整头读作「均匀的死黑」。深色发要 0.9 左右（±0.45），
    // 一部分卷冲到 tip/mid 色才立得住颗粒感。
    var spread = opt.toneSpread == null ? 0.6 : opt.toneSpread
    out.push({
      p: p,
      w: [wMin + rng() * wMax, 0.5],
      n: opt.fine || 3,
      tone: (opt.tone || 0) + (rng() - 0.5) * spread,
      conv: 0.2,
      tuft: 1
    })
  }
  return out
}

/* ============================================================
 * 六、SVG 序列化（缩略图用）
 * ============================================================ */

/**
 * 数值格式化。缩略图在 140px 宽下渲染，1 个归一化单位只占 0.7px，
 * 保留整数位已经绰绰有余，却能省下近一半字节。
 */
function num(v, prec) {
  var p = prec == null ? 1 : prec
  if (p === 0) return Math.round(v)
  var m = p === 1 ? 10 : 100
  return Math.round(v * m) / m
}

function opsToD(ops, prec) {
  var d = ''
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i]
    var t = op[0]
    if (t === 'M') d += 'M' + num(op[1], prec) + ' ' + num(op[2], prec)
    else if (t === 'L') d += 'L' + num(op[1], prec) + ' ' + num(op[2], prec)
    else if (t === 'C') {
      d += 'C' + num(op[1], prec) + ' ' + num(op[2], prec) +
        ' ' + num(op[3], prec) + ' ' + num(op[4], prec) +
        ' ' + num(op[5], prec) + ' ' + num(op[6], prec)
    } else if (t === 'Z') d += 'Z'
  }
  return d
}

/** 多边形 → SVG path d，点足够密所以用折线即可，省字节 */
function polyToD(poly, prec) {
  var d = 'M' + num(poly[0][0], prec) + ' ' + num(poly[0][1], prec)
  for (var i = 1; i < poly.length; i++) {
    d += 'L' + num(poly[i][0], prec) + ' ' + num(poly[i][1], prec)
  }
  return d + 'Z'
}

/**
 * 发束分隔线：沿每条发束的一侧画一条很细的暗线。
 *
 * 真实头发是一束一束的，束与束之间有暗缝。发丝彼此重叠时这层暗缝会被
 * 盖掉，整块就糊成一片。补一层极细的暗线是最省事的解法 ——
 * 它必须细（1~1.6 单位）且够暗（接近 shadow 色），否则会变成描边。
 */
function lockSeparators(locks, rng, opt) {
  var out = []
  var samples = (opt && opt.samples) || 9
  var w = (opt && opt.width) || 1.4
  for (var i = 0; i < locks.length; i++) {
    var lock = locks[i]
    if (rng && rng() < 0.18) continue // 少量跳过，避免过于规律
    var c = sampleCurve(lock.p, samples, lock.wave)
    var sgn = rng && rng() > 0.5 ? 1 : -1
    var off = sgn * lock.w[0] * 0.5
    var pts = []
    for (var k = 0; k < c.length; k++) {
      var conv = 1 - 0.52 * c[k].t
      pts.push({
        x: c[k].x + c[k].nx * off * conv,
        y: c[k].y + c[k].ny * off * conv,
        nx: c[k].nx,
        ny: c[k].ny,
        t: c[k].t
      })
    }
    out.push({ pts: pts, w: [w, 0.15], tone: -0.9 })
  }
  return out
}

module.exports = {
  hashStr: hashStr,
  mulberry32: mulberry32,
  hex2rgb: hex2rgb,
  rgb2hex: rgb2hex,
  mixHex: mixHex,
  shade: shade,
  rgba: rgba,
  buildRamp: buildRamp,
  toneColor: toneColor,
  ptOn: ptOn,
  bez: bez,
  bezD: bezD,
  sampleCurve: sampleCurve,
  sampleOps: sampleOps,
  mirrorLock: mirrorLock,
  crownLocks: crownLocks,
  panelLocks: panelLocks,
  sideLocks: sideLocks,
  expand: expand,
  polygon: polygon,
  edgeStrands: edgeStrands,
  lockSeparators: lockSeparators,
  curlTufts: curlTufts,
  stubble: stubble,
  inPoly: inPoly,
  flyaways: flyaways,
  opsToD: opsToD,
  polyToD: polyToD
}
