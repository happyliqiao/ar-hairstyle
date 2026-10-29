/**
 * 识脸锚点 → 屏幕发型框 的换算
 *
 * 单独抽成模块是为了可测：pages/tryon/tryon.js 和 tests/fit-check.js
 * 必须调用同一份代码，否则「测试通过但真机上错位」的事故还会再犯。
 *
 * 坐标系约定（全部来自微信官方文档与 hair-engine 的常量）：
 *   - anchor.origin 是人脸框【左上角】，anchor.size 是人脸框宽高
 *   - 摄像头预览按 cover 铺满取景区间
 *   - hair-engine 虚拟画布 200×240，人脸 cx=100 cy=118 rx=50 ry=64
 */

const FACE_W = 100
const FACE_CY = 118
const VIEW_W = 200
const VIEW_H = 240

/** 发型框宽 = 脸宽 × 这个倍数（发型总宽是脸宽的 2 倍） */
const HEAD_W_RATIO = VIEW_W / FACE_W
/** 脸心在发型框中的纵向比例 */
const HEAD_CY_RATIO = FACE_CY / VIEW_H
/** 发型框宽高比 */
const BOX_ASPECT = VIEW_H / VIEW_W
/** 脸高 / 脸宽，用于个别版本人脸框高宽比异常时兜底 */
const FACE_ASPECT = 128 / FACE_W

/**
 * 脸宽占取景宽度的合理区间。
 *
 * 不设限会出两种极端：
 *   - 用户把手机贴到脸上（近）：faceW 能到取景宽的 1.5 倍以上，
 *     发型框 = faceW × 2 直接铺满并溢出屏幕，整块画面被头发色糊住，
 *     用户完全看不到自己的脸，只会觉得「小程序崩了」。
 *   - 脸在画面很远处：faceW 只有几个像素，发型缩成一个点，
 *     看起来像画布上粘了颗黑芝麻。
 *
 * **这两个值必须和取景框（GUIDE_RX_RATIO）对得上。**
 * 产品模型是「固定框 + 用户主动把头放进去」，框宽 = 屏宽 × 0.60，
 * 框内理想脸宽 ≈ 框宽 × 0.82 ≈ 屏宽 × 0.49。
 * 所以夹取区间取 0.26 ~ 0.58（约 0.53 ~ 1.18 倍理想脸宽）：
 * 一旦超出，说明用户明显太远或太近，此时发型仍按极限值画出来
 * 不至于糊屏/消失，但页面会同时给出「靠近一点 / 后退一点」的提示 ——
 * 靠提示让用户配合，而不是靠夹取默默替他把距离改掉。
 *
 * 旧值是 0.09 ~ 0.78：上界意味着发型宽 1.56 屏宽，早就糊成一团；
 * 下界意味着脸只有 34px 也能画出正常大小的发型，用户永远不会
 * 被要求「靠近一点」，等于产品自己替用户凑合。
 */
const FACE_W_MIN_RATIO = 0.26
const FACE_W_MAX_RATIO = 0.58

/**
 * 取景引导框（屏幕坐标）。
 *
 * 这是「人脸验证」式的固定参考框：框不动，用户主动把头移进来。
 * 与曾经画在画布上的「虚拟头型」是两回事 ——
 * 虚拟头型是画一个假人 + 假发冒充效果；取景框只是一条参考线，
 * 明确告诉用户「请把头放进这里」，本身不代表任何效果。
 *
 * 几何只有这一份来源：wxml 用这里算出的 px 值做 inline style，
 * 判定也用这里的数值。否则「框画在 A 处、判定按 B 处算」，
 * 用户会看到框明明套住了脸却提示没对齐。
 */
const GUIDE_RX_RATIO = 0.30   // 框半宽 / 屏宽 → 框宽 = 0.60 屏宽
const GUIDE_CY_RATIO = 0.40   // 框心 y / 屏高（偏上，给底部操作区留位置）
const GUIDE_ASPECT = 1.22     // 半高 / 半宽，接近「脸 + 头顶头发」的轮廓比例

/** 框内理想脸宽 = 框宽 × 这个比例（脸略小于框，视觉上才有「套住」的感觉） */
const GUIDE_FACE_FILL = 0.82

/** 对齐容差：脸心偏移超过半轴的 45% 就算没对齐 */
const ALIGN_TOL = 0.45
/**
 * 脸高相对理想值的可接受区间。
 *
 * 理想脸高 = 框高 × 0.82。0.78~1.12 对应「脸高占屏高 32% ~ 46%」，
 * 也就是自拍时人脸在画面里的常见大小，且不会太靠近广角畸变的边缘。
 *
 * **用高度而不是宽度**：yaw（左右转头）只压缩检测框的宽度，
 * 高度几乎不变。用宽度判距离的话，用户一转头就会被误报「靠近一点」。
 * 上界特意取得比夹取上限更紧：夹取是为了防止糊屏，
 * 判定的目的是提醒用户后退，两者不是一回事，不能共用一个阈值。
 */
const ALIGN_SCALE_MIN = 0.78
const ALIGN_SCALE_MAX = 1.12
/** 头部倾斜容忍（弧度），约 12° */
const ALIGN_ANGLE_TOL = 0.21

/**
 * 侧脸（yaw）判定参数。
 *
 * 微信 VKSession 的 face anchor 只给 `angle`（画面内旋转 = roll），
 * **不给 yaw**。所以只能从几何上反推：
 *
 *   人脸检测框的宽度 ≈ 正脸宽度 × cos(yaw)
 *
 * 正脸时框最宽，越转越窄。于是「当前宽高比 / 该用户历史最大宽高比」
 * 就是 cos(yaw) 的估计值，反余弦即可还原角度。
 *
 * 三个阈值：
 *   - YAW_TOLERANCE 0.82 → 对应 yaw ≈ 35°，超过就提示「正对镜头」
 *   - YAW_ABS_MIN_ASPECT 0.50 → 绝对兜底。宽高比低于 0.5 意味着
 *     脸宽不到脸高一半（yaw > 60°），这种程度不需要基准也认得出来。
 *     有了它，「用户一进页面就是大侧脸」也能判出来 —— 否则基准会被
 *     侧脸污染，永远判成"正对"。
 *   - YAW_REF_MIN 0.55 → 基准本身低于这个值，说明这台设备/这版基础库
 *     给的人脸框本来就偏窄（不同算法框的范围不一样：有的框到下巴，
 *     有的框到发际线）。此时相对判定不可信，直接关掉，只留绝对兜底，
 *     宁可不提示也不要误报「正对镜头」。
 */
const YAW_TOLERANCE = 0.82
const YAW_ABS_MIN_ASPECT = 0.50
const YAW_REF_MIN = 0.55
const YAW_WARMUP_FRAMES = 5
/**
 * 有些实现会把人脸框「正方形化」（width 恒等于 height），此时宽高比
 * 永远不变，yaw 无从反推。连续观察到的宽高比波动小于 4% 就认定是这种情况：
 * 不做任何提示（假阴性可以接受，误报「正对镜头」会让人莫名其妙），
 * 但把 degenerate 标出来，调试和测试能看见。
 */
const YAW_DEGENERATE_SPREAD = 1.04
const YAW_DEGENERATE_FRAMES = 12

/**
 * 从 anchor 里取 roll（画面内旋转）。
 *
 * 官方文档里 `VKFaceAnchor.angle` 的类型是 **Array&lt;number&gt;**，
 * 但只说「人脸角度信息」，没有公开三个分量的顺序（pitch/yaw/roll 谁在前）。
 * 早期基础库给的是数字。两种都得接住：
 *
 *   - 数字：直接用
 *   - 数组：**不能猜**。猜错分量会让整头发型持续倾斜 ——
 *     用户看到的是「头发歪了」，而不是「角度没识别」，比不跟随更糟。
 *     所以数组一律返回 0，宁可不跟随歪头。
 *
 * 之前的代码直接 `clampAngle(anchor.angle || 0)`：数组传进去，
 * `a > limit` 是 NaN 比较恒为 false，函数原样返回数组，
 * 最后 `trackedAngle + rotRad` 变成字符串拼接，`ctx.rotate('0,0,0.1')`
 * 得到 NaN —— 整个造型的旋转会失效。这个函数就是来堵这条路的。
 */
function pickRoll(anchor) {
  const a = anchor && anchor.angle
  if (typeof a === 'number') return isFinite(a) ? a : 0
  return 0
}

/**
 * 侧脸估计器。有状态，每个摄像头会话建一个（切摄像头要 reset）。
 *
 * 只依赖 face.rawW / face.rawH —— 夹取后的 w 会被压到固定区间，
 * 用它算宽高比等于把侧脸也压平，永远判不出来。
 */
function createYawEstimator() {
  let ref = 0
  let frames = 0
  let minAspect = Infinity
  let maxAspect = 0

  return {
    /**
     * @param {{rawW?:number,rawH?:number,w?:number,h?:number}} face
     * @returns {{rel:number, yawDeg:number, suspect:boolean, ready:boolean}}
     */
    push(face) {
      const w = face && (face.rawW || face.w)
      const h = face && (face.rawH || face.h)
      if (!w || !h || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
        return { rel: 1, yawDeg: 0, suspect: false, ready: false, degenerate: false }
      }

      const aspect = w / h
      frames++
      if (aspect > ref) ref = aspect
      if (aspect < minAspect) minAspect = aspect
      if (aspect > maxAspect) maxAspect = aspect
      const degenerate = frames >= YAW_DEGENERATE_FRAMES &&
        (maxAspect / minAspect) < YAW_DEGENERATE_SPREAD

      // 绝对兜底不依赖基准，第一帧就能生效
      const absSuspect = aspect < YAW_ABS_MIN_ASPECT

      const ready = frames >= YAW_WARMUP_FRAMES && ref >= YAW_REF_MIN
      const rel = ref > 0 ? aspect / ref : 1
      const yawDeg = rel >= 1 ? 0 : Math.acos(Math.min(1, rel)) * 180 / Math.PI

      return {
        rel: rel,
        yawDeg: yawDeg,
        suspect: absSuspect || (ready && rel < YAW_TOLERANCE),
        ready: ready,
        degenerate: degenerate
      }
    },

    reset() {
      ref = 0
      frames = 0
      minAspect = Infinity
      maxAspect = 0
    },

    /** 供测试观察内部基准 */
    _ref() { return ref }
  }
}

function guideFrame(cw, ch) {
  if (!cw || !ch) return null
  const rx = cw * GUIDE_RX_RATIO
  const ry = rx * GUIDE_ASPECT
  return {
    cx: cw / 2,
    cy: ch * GUIDE_CY_RATIO,
    rx: rx,
    ry: ry,
    w: rx * 2,
    h: ry * 2
  }
}

/**
 * 判定脸和取景框的对齐程度。
 *
 * @param {{cx:number,cy:number,w:number}} face 已经过 cover 映射 + 镜像的屏幕坐标
 * @param {{w:number,h:number}} viewport
 * @param {number} [angle] 弧度（roll）
 * @param {{suspect?:boolean,yawDeg?:number}} [yaw] 侧脸估计（face-fit.createYawEstimator 的产出）
 * @returns {{state:'locked'|'aligning', dx:number, dy:number,
 *            ratio:number, angle:number, yawDeg:number, hint:string, keys:string[]}}
 */
function judgeAlign(face, viewport, angle, yaw) {
  const g = guideFrame(viewport && viewport.w, viewport && viewport.h)
  const empty = { state: 'aligning', dx: 0, dy: 0, ratio: 1, angle: 0, yawDeg: 0, hint: '', keys: [] }
  if (!g || !face || !isFinite(face.cx) || !isFinite(face.cy) || !isFinite(face.w) || face.w <= 0) {
    return empty
  }

  // 注意：这里比较的是**屏幕上看到的位置**。face.cx 在 faceAnchorToBox 里
  // 已经按 mirror 翻过一次，所以下面得出的「左/右」就是用户眼里的左右，
  // 不需要再按镜像反一次 —— 再翻一次就会提示成反方向。
  const dx = face.cx - g.cx
  const dy = face.cy - g.cy

  // 距离用**脸高**判，不用脸宽。
  //
  // 这是侧脸判定带来的连锁修正：yaw 只压缩宽度，几乎不影响高度。
  // 如果继续用宽判距离，用户把头转过去 40°，检测框变窄，
  // 产品就会喊「靠近一点」—— 而他人根本没动，只是转了个头。
  // 用高度判距离，两条判定互不污染：转头顶多触发「正对镜头」。
  const targetH = g.h * GUIDE_FACE_FILL
  const measuredH = (typeof face.rawH === 'number' && face.rawH > 0)
    ? face.rawH
    : ((typeof face.rawW === 'number' && face.rawW > 0) ? face.rawW : face.w)
  const ratio = measuredH / targetH
  const a = isFinite(angle) ? angle : 0
  const yawSuspect = !!(yaw && yaw.suspect)
  const yawDeg = (yaw && isFinite(yaw.yawDeg)) ? yaw.yawDeg : 0

  const keys = []
  const parts = []

  // 大小优先：距离不对时，位置怎么调都白调
  if (ratio < ALIGN_SCALE_MIN) {
    keys.push('far')
    parts.push('靠近一点')
  } else if (ratio > ALIGN_SCALE_MAX) {
    keys.push('near')
    parts.push('后退一点')
  }

  // 侧脸排在位置前面。侧脸时人脸框只框住半张脸，框心会往脸朝向那侧偏，
  // 这时候提示「往左一点」是错的 —— 用户把脸转正，偏移自己就消失了。
  if (yawSuspect) {
    keys.push('yaw')
    parts.push('正对镜头')
  }

  if (Math.abs(dx) > g.rx * ALIGN_TOL) {
    // 脸偏在画面右侧 → 让用户往左挪
    keys.push(dx > 0 ? 'left' : 'right')
    parts.push(dx > 0 ? '往左一点' : '往右一点')
  }
  if (Math.abs(dy) > g.ry * ALIGN_TOL) {
    keys.push(dy > 0 ? 'up' : 'down')
    parts.push(dy > 0 ? '往上一点' : '往下一点')
  }
  if (Math.abs(a) > ALIGN_ANGLE_TOL) {
    keys.push('tilt')
    parts.push('头摆正一点')
  }

  return {
    state: keys.length ? 'aligning' : 'locked',
    dx: dx,
    dy: dy,
    ratio: ratio,
    angle: a,
    yawDeg: yawDeg,
    // 最多给两条，三条以上用户记不住，也不知道先做哪个
    hint: parts.slice(0, 2).join(' · '),
    keys: keys
  }
}

/**
 * @param {{origin:{x:number,y:number}, size:{width:number,height:number}}} anchor
 * @param {{w:number,h:number}} frame   摄像头帧尺寸
 * @param {{w:number,h:number}} viewport 取景区间（屏幕）尺寸
 * @param {{mirror?:boolean, calibration?:{scale:number,offsetX:number,offsetY:number}}} [opt]
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function faceAnchorToBox(anchor, frame, viewport, opt) {
  const cw = viewport.w
  const ch = viewport.h
  if (!cw || !ch || !frame || !frame.w || !frame.h) return null

  const o = anchor && anchor.origin
  const s = anchor && anchor.size
  if (!o || !s || !s.width || !s.height) return null
  if (typeof o.x !== 'number' || typeof o.y !== 'number') return null

  let fx = o.x
  let fy = o.y
  let fw = s.width
  let fh = s.height

  // 少数基础库给的是 0~1 归一化坐标
  if (Math.abs(o.x) <= 1.5 && Math.abs(o.y) <= 1.5 && s.width <= 1.5) {
    fx = o.x * frame.w
    fy = o.y * frame.h
    fw = s.width * frame.w
    fh = (s.height || s.width) * frame.h
  }

  // cover 映射：摄像头画面按「铺满并裁切」的方式显示
  const scale = Math.max(cw / frame.w, ch / frame.h)
  const offX = (cw - frame.w * scale) / 2
  const offY = (ch - frame.h * scale) / 2

  // 人脸框左上角 → 人脸中心
  let cx = (fx + fw / 2) * scale + offX
  let cy = (fy + fh / 2) * scale + offY
  let faceW = fw * scale
  if (!isFinite(faceW) || faceW <= 0) faceW = (fh * scale) / FACE_ASPECT

  const cal = (opt && opt.calibration) || { scale: 1, offsetX: 0, offsetY: 0 }
  faceW = faceW * (cal.scale || 1)
  cx += cal.offsetX || 0
  cy += cal.offsetY || 0

  if (opt && opt.mirror) cx = cw - cx

  if (!isFinite(faceW) || faceW <= 0 || !isFinite(cx) || !isFinite(cy)) return null

  // 夹取之前先记下真实的屏幕脸宽/脸高。
  //
  // 这两个值是「用户到底离得多近、转得多侧」的唯一证据。夹取会把宽抹掉：
  // 贴到镜头上和正常手持，夹完都是同一个数，于是对齐判定永远
  // 认为「大小合适」，用户永远等不到「后退一点」这句提示。
  // 绘制用夹取后的值（防糊屏），判定用原始值（防自欺）。
  const rawW = faceW
  const rawH = (fh * scale) || rawW * FACE_ASPECT

  // 夹到合理区间。夹的是「脸宽」而不是「发型框」，因为发型框是脸宽
  // 的固定倍数（HEAD_W_RATIO），夹脸宽等于等比例缩放，遮挡关系不变。
  // 夹完要同步修正 cx/cy 吗？不用：cx 是脸心，脸心本身没有溢出问题，
  // 变的是脸有多大。脸心贴着屏幕边缘时发型会有一部分出画，这是对的 ——
  // 用户的脸本来就出画了。
  const wMin = cw * FACE_W_MIN_RATIO
  const wMax = cw * FACE_W_MAX_RATIO
  if (faceW < wMin) faceW = wMin
  else if (faceW > wMax) faceW = wMax

  const w = faceW * HEAD_W_RATIO
  const h = w * BOX_ASPECT

  return {
    x: cx - w / 2,
    y: cy - h * HEAD_CY_RATIO,
    w: w,
    h: h,
    // 附带返回人脸框在屏幕上的位置，供对齐判定与测试使用。
    // rawW/rawH 是夹取前的真实尺寸：别拿 w 去判距离，也别拿 w/h 去判侧脸。
    face: { cx: cx, cy: cy, w: faceW, h: rawH, rawW: rawW, rawH: rawH }
  }
}

module.exports = {
  faceAnchorToBox: faceAnchorToBox,
  guideFrame: guideFrame,
  judgeAlign: judgeAlign,
  createYawEstimator: createYawEstimator,
  pickRoll: pickRoll,
  HEAD_W_RATIO: HEAD_W_RATIO,
  HEAD_CY_RATIO: HEAD_CY_RATIO,
  BOX_ASPECT: BOX_ASPECT,
  FACE_W: FACE_W,
  FACE_CY: FACE_CY,
  VIEW_W: VIEW_W,
  VIEW_H: VIEW_H,
  FACE_W_MIN_RATIO: FACE_W_MIN_RATIO,
  FACE_W_MAX_RATIO: FACE_W_MAX_RATIO,
  GUIDE_RX_RATIO: GUIDE_RX_RATIO,
  GUIDE_CY_RATIO: GUIDE_CY_RATIO,
  GUIDE_ASPECT: GUIDE_ASPECT,
  GUIDE_FACE_FILL: GUIDE_FACE_FILL,
  ALIGN_TOL: ALIGN_TOL,
  ALIGN_SCALE_MIN: ALIGN_SCALE_MIN,
  ALIGN_SCALE_MAX: ALIGN_SCALE_MAX,
  ALIGN_ANGLE_TOL: ALIGN_ANGLE_TOL,
  YAW_TOLERANCE: YAW_TOLERANCE,
  YAW_ABS_MIN_ASPECT: YAW_ABS_MIN_ASPECT,
  YAW_REF_MIN: YAW_REF_MIN,
  YAW_WARMUP_FRAMES: YAW_WARMUP_FRAMES,
  YAW_DEGENERATE_SPREAD: YAW_DEGENERATE_SPREAD
}
