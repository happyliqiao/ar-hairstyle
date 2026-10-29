/**
 * 脸 → 发型 / 肤色 → 发色 的匹配引擎。
 *
 * 这是「自动匹配」这件事的全部判断逻辑，纯函数，不依赖 canvas / wx，
 * 可以在 Node 里直接跑。页面只负责喂数据和显示结论。
 *
 * 设计原则（与前面几轮自查的结论一致）：
 *   1. **只根据真的量得到的东西下结论。** 微信 VKSession 只给人脸框，
 *      没有五官关键点，所以能测的只有「框的宽高比」和「脸的像素颜色」。
 *      测不出来的（比如方脸需要下颌角宽度）就不说，不猜。
 *   2. **测不准就不给结论。** 每个判定都带 confidence，低于阈值时
 *      返回 null，由页面显示「还在测」，而不是硬给一个可能错的脸型。
 *   3. **结论必须可解释。** 每条推荐都带一句人话理由，用户能判断
 *      说得对不对 —— 黑箱推荐比不推荐更让人不安。
 */

/* ==================================================================
 * 一、脸型
 * ================================================================== */

/**
 * 脸型分类阈值。
 *
 * 依据：人脸框一般从发际线框到下巴，脸长 ≈ 1.28 × 颧宽，
 * 所以正常比例落在 0.78 附近。
 *   - 圆脸：脸长/脸宽接近 1.1~1.2 → 宽高比 0.84 以上
 *   - 长脸：脸长/脸宽 1.45 以上   → 宽高比 0.70 以下
 *
 * **这两个值是「本产品 + 这版基础库」的经验值，不是普适常数。**
 * 不同基础库框的范围不一样（有的框到发际线，有的框到头顶头发），
 * 整体会平移。所以：
 *   - 死区留得比较宽（±0.015），边界附近一律判「标准」；
 *   - 页面上允许用户手动改判（「不像？圆 / 标准 / 长」）；
 *   - 连续多帧宽高比几乎不变时（SDK 把人脸框正方形化），
 *     直接放弃脸型判定 —— 见 createShapeEstimator 的 degenerate。
 */
const ASPECT_ROUND = 0.84
const ASPECT_LONG = 0.70
const ASPECT_DEAD = 0.015

/** 需要多少帧有效样本才敢下结论。太少会被单帧抖动带偏。 */
const SHAPE_MIN_FRAMES = 6

/**
 * 「框被正方形化」的判据容差：宽高比必须落在 1±0.03 之内。
 *
 * 这个常量是第 6 轮补的，起因是一个反直觉的假阴性：
 * 退化检测原来只看「波动幅度」，于是**站得最稳的用户**
 * （宽高比 20 帧几乎不变）被判成「框被正方形化」，
 * 永远拿不到推荐；而手抖的用户反而能拿到结论。
 * 真实人脸宽高比在 0.6~0.95，被正方形化的框恒等于 1.0，
 * 所以「稳」必须叠加「值接近 1」才算退化。
 */
const SQUARE_TOL = 0.03

const SHAPE_LABEL = {
  round: '偏圆',
  oval: '标准',
  long: '偏长'
}

/**
 * @param {number} aspect 检测框宽 / 高（必须是夹取前的原始值）
 * @returns {{id:'round'|'oval'|'long', label:string, confidence:number}}
 */
function classifyShape(aspect) {
  if (!isFinite(aspect) || aspect <= 0) {
    return { id: 'oval', label: SHAPE_LABEL.oval, confidence: 0 }
  }
  if (aspect >= ASPECT_ROUND + ASPECT_DEAD) {
    return { id: 'round', label: SHAPE_LABEL.round, confidence: 1 }
  }
  if (aspect <= ASPECT_LONG - ASPECT_DEAD) {
    return { id: 'long', label: SHAPE_LABEL.long, confidence: 1 }
  }
  // 死区：离两条边界都够远才算「标准」，否则置信度打折
  const dRound = Math.abs(aspect - ASPECT_ROUND)
  const dLong = Math.abs(aspect - ASPECT_LONG)
  const d = Math.min(dRound, dLong)
  const confidence = d >= 0.04 ? 1 : 0.6
  // 贴着边界时不要报「标准」，报「接近标准」。
  // 0.845 这种值离圆脸线只有 0.005，说是标准脸是在装准 ——
  // 而用户会拿这句话去判断「它测得准不准」。
  return {
    id: 'oval',
    label: confidence < 1 ? '接近标准' : SHAPE_LABEL.oval,
    confidence: confidence
  }
}

/**
 * 脸型估计器。
 *
 * 三个必须做的门控，少一个都会给出错误的脸型：
 *
 * 1. **只收正脸帧。** 宽高比 = 宽/高，而 yaw 只压缩宽度。
 *    用户转 30° 头，宽高比直接掉到 0.67，会被判成「长脸」。
 *    所以要求该帧的 yaw rel ≥ 0.94（约 20° 以内）才收。
 * 2. **取窗口最大值，不取平均。** yaw 只会让宽度变小、不会变大，
 *    所以窗口内最大的宽高比最接近真实正脸。平均会被侧脸帧拖低。
 * 3. **检测「框被正方形化」。** 如果连续多帧宽高比波动极小、
 *    **而且这个值本身接近 1**，说明 SDK 输出的框宽恒等于高，
 *    宽高比里没有人脸信息。此时给 degenerate，页面据此不说脸型 ——
 *    假阴性可以接受，把所有人都判成同一个脸型会让推荐彻底失去意义。
 *    ⚠️ 两个条件缺一不可：只看波动会把「站得稳的用户」误判成退化。
 */
function createShapeEstimator() {
  let best = 0          // 窗口内最大宽高比
  let frames = 0        // 有效（正脸）帧数
  let minAspect = Infinity
  let maxAspect = 0
  let seen = 0          // 所有帧（含侧脸），用于退化检测

  return {
    /**
     * @param {{rawW?:number, rawH?:number, w?:number, h?:number}} face
     * @param {{rel?:number}} [yaw] createYawEstimator 的产出
     */
    push(face, yaw) {
      const w = face && (face.rawW || face.w)
      const h = face && (face.rawH || face.h)
      if (!w || !h || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return this.get()

      const aspect = w / h
      seen++
      if (aspect < minAspect) minAspect = aspect
      if (aspect > maxAspect) maxAspect = aspect

      const rel = (yaw && isFinite(yaw.rel)) ? yaw.rel : 1
      if (rel >= 0.94) {
        frames++
        if (aspect > best) best = aspect
      }
      return this.get()
    },

    get() {
      // 退化 = 「框稳」+「值是 1」两个条件同时成立。
      //
      // 只判「稳」会造成最难受的一种假阴性：用户把手机举稳、一帧不晃，
      // 宽高比波动 <4%，被判成 SDK 把框正方形化了 → 永远不给脸型结论。
      // 也就是说**越配合的用户越拿不到推荐**，而手抖的人反而有结论。
      // 真实人脸的宽高比在 0.6~0.95 之间，被正方形化的框恒等于 1，
      // 所以补上「值」这一半，两者才分得开。
      const steady = seen >= 12 && (maxAspect / minAspect) < 1.04
      const square = minAspect >= 1 - SQUARE_TOL && maxAspect <= 1 + SQUARE_TOL
      const degenerate = steady && square
      if (degenerate) {
        return { shape: null, aspect: best, frames: frames, degenerate: true, ready: false }
      }
      if (frames < SHAPE_MIN_FRAMES) {
        return { shape: null, aspect: best, frames: frames, degenerate: false, ready: false }
      }
      const c = classifyShape(best)
      return { shape: c.id, label: c.label, confidence: c.confidence, aspect: best, frames: frames, degenerate: false, ready: true }
    },

    reset() {
      best = 0
      frames = 0
      minAspect = Infinity
      maxAspect = 0
      seen = 0
    },

    _state() { return { best: best, frames: frames, seen: seen } }
  }
}

/* ==================================================================
 * 二、发型排序
 * ================================================================== */

/**
 * 每款发型对三种脸型的适配度（0~3）与理由。
 *
 * 打分依据是造型上的真实作用，不是文案：
 *   - 圆脸要「拉长」：顶部加高（背头）、垂直线条（长直发）、收窄两侧（寸头）
 *   - 长脸要「加宽、缩短」：齐刘海压额头、齐下巴的横向体积、两侧蓬松
 *   - 标准脸几乎都行，只避开过度修饰
 */
const STYLE_FIT = {
  buzz: {
    round: [2, '两侧推短，脸不会被横向撑开'],
    oval: [1, '利落，但很挑头型'],
    long: [0, '两侧推光会让长脸显得更窄更长']
  },
  crop: {
    round: [2, '顶部留一点蓬松，能把脸型往上带'],
    oval: [3, '百搭款，几乎不会出错'],
    long: [1, '可以，但两侧要留点厚度才不显窄']
  },
  bob: {
    round: [0, '齐下巴的横向体积会把下半脸加宽'],
    oval: [3, '标准脸配齐下巴长度最稳'],
    long: [3, '齐下巴的横向体积正好补上脸的宽度']
  },
  fringe: {
    round: [0, '齐刘海压掉额头，脸会显得更短更圆'],
    oval: [2, '甜感强，但会遮掉一部分五官'],
    long: [3, '压掉一截额头，长脸立刻显短']
  },
  'long-straight': {
    round: [3, '垂直线条把视觉长度拉出来'],
    oval: [2, '经典，但很依赖发量'],
    long: [0, '垂直长发会把长脸拉得更长']
  },
  wavy: {
    round: [0, '两侧外扩的体积会继续加宽脸'],
    oval: [3, '横向体积对标准脸是加分项'],
    long: [2, '两侧有宽度，但长度还是偏长']
  },
  pompadour: {
    round: [3, '顶部堆高，直接把脸型往上拉长'],
    oval: [2, '精神，需要一点发量支撑'],
    long: [0, '顶部再加高，脸会更长']
  },
  curly: {
    round: [0, '两侧蓬松会横向加宽'],
    oval: [2, '有个性，但体积大、显头重'],
    long: [3, '横向蓬松正好把窄脸撑开']
  },
  ponytail: {
    round: [2, '全部收上去，露出下颌线，脖子显长'],
    oval: [2, '干净利落，适合日常'],
    long: [1, '收得越干净，脸显得越长']
  },
  'middle-part': {
    round: [2, '两侧长发垂下来，能收窄脸宽'],
    oval: [3, '中分对标准脸是最安全的选择'],
    long: [1, '两侧遮挡可以，但整体还是纵向线条']
  }
}

/**
 * @param {'round'|'oval'|'long'} shapeId
 * @returns {Array<{id:string, score:number, reason:string}>} 按适配度降序
 */
function rankStyles(shapeId) {
  const key = SHAPE_LABEL[shapeId] ? shapeId : 'oval'
  const out = []
  const ids = Object.keys(STYLE_FIT)
  for (let i = 0; i < ids.length; i++) {
    const row = STYLE_FIT[ids[i]][key]
    out.push({ id: ids[i], score: row[0], reason: row[1], order: i })
  }
  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score
    return a.order - b.order
  })
  return out.map(function (x) {
    return { id: x.id, score: x.score, reason: x.reason }
  })
}

function bestStyle(shapeId) {
  const list = rankStyles(shapeId)
  return list.length ? list[0] : null
}

/* ==================================================================
 * 三、肤色
 * ================================================================== */

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** sRGB → CIELAB（D65 白点） */
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r)
  const G = srgbToLinear(g)
  const B = srgbToLinear(b)
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047
  const Y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / 1.00000
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883
  const f = function (t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  }
  const fx = f(X)
  const fy = f(Y)
  const fz = f(Z)
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  }
}

/**
 * 肤色深浅用 ITA°（Individual Typology Angle）分级。
 *
 * 分级（皮肤科常用）：ITA > 41 浅，10~41 中等，< 10 偏深。
 *
 * **只判深浅，不判冷暖。** 冷暖要靠色相，而手机白平衡不可知，
 * 同一张脸在暖光/冷光下 hue 能差 15°，据此推荐发色等于瞎猜。
 *
 * ⚠️ ITA 的致命弱点：**它依赖绝对亮度**。
 * 同一个人，画面暗 25% 时 ITA 从 30 掉到 -1（判「偏深」），
 * 亮 30% 时升到 45（判「偏白」）。也就是说自动曝光一动，
 * 发色推荐就整个翻档 —— 这不是理论风险，是实测出来的。
 *
 * 所以加一路**增益无关**的旁证：HSV 饱和度。
 * 曝光是三个通道同乘一个系数，饱和度 (max-min)/max 不受影响；
 * 而肤色越深，饱和度越高。两路都指向同一档才敢用，
 * 不一致就标 confident=false，页面据此只展示不自动替换。
 *
 * 实测（同一批样本）：中性光下 6 档肤色两路全部一致；
 * 偏暗 0.75× / 偏亮 1.3× / 暖光 +30%R 时两路必然打架。
 */
function classifySkin(rgb) {
  if (!rgb || !isFinite(rgb.r) || !isFinite(rgb.g) || !isFinite(rgb.b)) return null
  const lab = rgbToLab(rgb.r, rgb.g, rgb.b)
  // b* 接近 0 时 atan 会炸，兜一个下限；正常肤色 b* 在 10~30
  const bStar = Math.max(1, lab.b)
  const ita = Math.atan((lab.L - 50) / bStar) * 180 / Math.PI

  let depth = 'medium'
  if (ita >= 41) depth = 'light'
  else if (ita < 10) depth = 'deep'

  const max = Math.max(rgb.r, rgb.g, rgb.b)
  const min = Math.min(rgb.r, rgb.g, rgb.b)
  const sat = max > 0 ? (max - min) / max : 0

  let satDepth = 'medium'
  if (sat < 0.30) satDepth = 'light'
  else if (sat > 0.50) satDepth = 'deep'

  const label = depth === 'light' ? '偏白' : (depth === 'deep' ? '偏深' : '中等')
  return {
    ita: ita,
    depth: depth,
    label: label,
    sat: sat,
    satDepth: satDepth,
    // 两路一致才算测得准。不一致几乎总是因为曝光或白平衡偏了，
    // 此时仍然给推荐，但不许自动替换用户的发色。
    confident: satDepth === depth,
    L: lab.L,
    a: lab.a,
    b: lab.b
  }
}

/**
 * 从摄像头帧里取肤色。
 *
 * 为什么取「脸颊」而不是整张脸：额头常被头发和阴影盖住，下巴有胡子和
 * 阴影，鼻梁有高光。脸颊两侧是最稳定的一块皮肤。
 *
 * 为什么要过滤像素：框里除了皮肤还有头发、背景、眼镜框、手。
 * 用经典肤色规则先筛一遍，只统计像皮肤的像素；有效像素太少就
 * 返回 null（宁可不说，也不要拿一撮头发算出一个肤色）。
 *
 * @param {ArrayBuffer|Uint8Array} data RGBA
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,w:number,h:number}} rect 人脸框，0~1 归一化
 * @returns {{r:number,g:number,b:number,n:number}|null}
 */
function sampleSkinPixels(data, width, height, rect) {
  if (!data || !width || !height || !rect) return null
  if (!(rect.w > 0) || !(rect.h > 0)) return null

  const u8 = (data instanceof Uint8Array) ? data : new Uint8Array(data)
  const need = width * height * 4
  if (u8.length < need) return null

  // 两块脸颊：相对人脸框的局部坐标
  const patches = [
    { x0: 0.16, x1: 0.40, y0: 0.50, y1: 0.70 },
    { x0: 0.60, x1: 0.84, y0: 0.50, y1: 0.70 }
  ]
  const GRID = 12

  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  let loose = 0

  for (let p = 0; p < patches.length; p++) {
    const pt = patches[p]
    for (let gy = 0; gy < GRID; gy++) {
      const ly = pt.y0 + (pt.y1 - pt.y0) * (gy + 0.5) / GRID
      const py = Math.round((rect.y + rect.h * ly) * height)
      if (py < 0 || py >= height) continue
      for (let gx = 0; gx < GRID; gx++) {
        const lx = pt.x0 + (pt.x1 - pt.x0) * (gx + 0.5) / GRID
        const px = Math.round((rect.x + rect.w * lx) * width)
        if (px < 0 || px >= width) continue
        const i = (py * width + px) * 4
        const r = u8[i]
        const g = u8[i + 1]
        const b = u8[i + 2]
        if (isSkinStrict(r, g, b)) {
          sr += r; sg += g; sb += b; n++
        } else if (isSkinLoose(r, g, b)) {
          loose++
        }
      }
    }
  }

  // 严格规则对深肤色偏严（R>95 这条在暗光下直接筛空）。
  // 严格像素不够时放宽一次再算，避免「深肤色用户永远测不出肤色」。
  if (n < 40 && loose >= 40) {
    for (let p = 0; p < patches.length; p++) {
      const pt = patches[p]
      for (let gy = 0; gy < GRID; gy++) {
        const ly = pt.y0 + (pt.y1 - pt.y0) * (gy + 0.5) / GRID
        const py = Math.round((rect.y + rect.h * ly) * height)
        if (py < 0 || py >= height) continue
        for (let gx = 0; gx < GRID; gx++) {
          const lx = pt.x0 + (pt.x1 - pt.x0) * (gx + 0.5) / GRID
          const px = Math.round((rect.x + rect.w * lx) * width)
          if (px < 0 || px >= width) continue
          const i = (py * width + px) * 4
          const r = u8[i]
          const g = u8[i + 1]
          const b = u8[i + 2]
          if (isSkinLoose(r, g, b)) { sr += r; sg += g; sb += b; n++ }
        }
      }
    }
  }

  if (n < 40) return null
  return { r: sr / n, g: sg / n, b: sb / n, n: n }
}

/** Kovac 经典肤色规则，适合中浅肤色 */
function isSkinStrict(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return r > 95 && g > 40 && b > 20 &&
    (max - min) > 15 && Math.abs(r - g) > 15 && r > g && r > b
}

/** 放宽版：去掉绝对亮度门槛，只保留「红占优、有一定饱和度」 */
function isSkinLoose(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return r > 35 && r > g && g >= b && (max - min) > 8 && (r - g) > 6
}

/* ==================================================================
 * 四、发色排序
 * ================================================================== */

/**
 * 发色明度分级（按 base 的感知亮度）。
 * 用感知亮度而不是 HSL 的 L：HSL 的 L 对深色不敏感，
 * 自然黑(#1b1a21) 和蓝黑(#14182b) 会被算成同一档。
 */
function hairLightness(hex) {
  if (typeof hex !== 'string' || hex.length < 7) return 0
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function hairBucket(hex) {
  const L = hairLightness(hex)
  if (L < 45) return 'deep'
  if (L > 110) return 'light'
  return 'mid'
}

/**
 * 每种肤色深浅偏好的发色目标明度。
 *
 * 规则不是「越衬越好」，而是**避免对比过强**：
 *   - 深肤色配很浅的发色，脸会被压得发灰发黄，所以目标压到 40 附近；
 *   - 浅肤色可选的跨度最大，目标放在偏亮（88）：浅肤配亚麻/蜜茶是
 *     最不容易出错的组合，纯黑反而显得硬。
 * 三个目标值必须拉开距离，否则不同肤色会算出同一个推荐，
 * 「按肤色匹配」就成了摆设。
 * 这也是理发店里的常识，不是模型编的。
 */
const PREFERRED_HAIR_L = {
  deep: 40,
  medium: 62,
  light: 88
}

/**
 * 日常接受度顺序，只用于同分时的先后。
 *
 * 这是**编辑判断**，不是算出来的：自然黑、深棕、栗棕是理发店默认三件套，
 * 银灰/樱花粉/灰紫属于「有态度」的选择，除非用户自己要，不主动推。
 * 没有这个序，同分时就会退回数组顺序，12 个色里永远推荐自然黑 ——
 * 不同肤色得到同一个答案，等于没匹配。
 */
const SAFE_ORDER = [
  'black', 'darkbrown', 'chestnut', 'flaxen',
  'redbrown', 'honey', 'wine', 'ashpurple',
  'rosegold', 'blueblack', 'sakura', 'silver'
]

/**
 * @param {'light'|'medium'|'deep'} depth
 * @param {Array<{id:string,name:string,base:string}>} colors 由调用方传入，避免这里依赖 hairstyles
 */
function rankColors(depth, colors) {
  const key = PREFERRED_HAIR_L[depth] ? depth : 'medium'
  const target = PREFERRED_HAIR_L[key]
  const list = colors || []
  const out = []

  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    const L = hairLightness(c.base)
    const bucket = hairBucket(c.base)
    const d = Math.abs(L - target)
    let score = 0
    if (d <= 18) score = 3
    else if (d <= 38) score = 2
    else if (d <= 62) score = 1
    else score = 0
    const safe = SAFE_ORDER.indexOf(c.id)
    out.push({
      id: c.id,
      score: score,
      reason: colorReason(key, bucket),
      // 同分时先比日常接受度，再比离目标明度的远近
      safe: safe < 0 ? 99 : safe,
      dist: d,
      L: L
    })
  }

  out.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score
    if (a.safe !== b.safe) return a.safe - b.safe
    return a.dist - b.dist
  })
  return out.map(function (x) {
    return { id: x.id, score: x.score, reason: x.reason }
  })
}

function colorReason(depth, bucket) {
  if (depth === 'deep') {
    if (bucket === 'light') return '你的肤色偏深，这么浅的发色对比太强，容易显蜡黄'
    if (bucket === 'deep') return '深发色和深肤色对比柔和，不刺眼'
    return '中深棕最衬深肤色，显得气色好'
  }
  if (depth === 'light') {
    if (bucket === 'light') return '肤色偏白，配浅发色不容易显脏'
    if (bucket === 'deep') return '黑白对比强，五官会更立体'
    return '中明度最稳，不会抢脸色'
  }
  if (bucket === 'light') return '中等肤色也能压住浅色，但要注意眉毛颜色'
  if (bucket === 'deep') return '深发色最稳妥，几乎不会出错'
  return '中等肤色最不挑，中棕系都能试'
}

module.exports = {
  classifyShape: classifyShape,
  createShapeEstimator: createShapeEstimator,
  rankStyles: rankStyles,
  bestStyle: bestStyle,
  classifySkin: classifySkin,
  sampleSkinPixels: sampleSkinPixels,
  rankColors: rankColors,
  hairLightness: hairLightness,
  hairBucket: hairBucket,
  rgbToLab: rgbToLab,
  SHAPE_LABEL: SHAPE_LABEL,
  ASPECT_ROUND: ASPECT_ROUND,
  ASPECT_LONG: ASPECT_LONG,
  SHAPE_MIN_FRAMES: SHAPE_MIN_FRAMES,
  SQUARE_TOL: SQUARE_TOL,
  PREFERRED_HAIR_L: PREFERRED_HAIR_L
}
