/**
 * 发型 / 发色 数据与渲染
 *
 * 渲染分两个后端，共用同一份几何：
 *   1) Canvas 2D —— 实时预览（离屏烘焙 + 缓存，每帧只 drawImage）
 *   2) SVG data-URI —— 缩略图（低精度，控制体积）
 *
 * 几何在 200 x 240 的归一化空间内描述：
 *   头部中心 (100,118)，横向半径 60，纵向半径 76
 *   头顶 y≈42，下巴 y≈194，脸宽 120，脸高 152
 *
 * 每款发型由「发束（lock）」描述，发束再沿法线展开成细发丝（strand）。
 * 发束数量 10~20，展开后细发丝 120~180 条 —— 这个量级才能撑住质感，
 * 手写这么多贝塞尔不现实，所以用生成器。
 */

const E = require('./hair-engine')

const VIEW_W = 200
const VIEW_H = 240
const D = Math.PI / 180

/* ---------------- 路径指令 ---------------- */

function M(x, y) {
  return ['M', x, y]
}
function L(x, y) {
  return ['L', x, y]
}
function C(a, b, c, d, e, f) {
  return ['C', a, b, c, d, e, f]
}
function Z() {
  return ['Z']
}

/** 波浪轮廓：把一段弧拆成 n 个向外鼓起的凸包 */
function scallopOps(cx, cy, rx, ry, a1, a2, n, amp, startWithMove) {
  const ops = []
  const da = (a2 - a1) / n
  for (let i = 0; i < n; i++) {
    const t0 = a1 + da * i
    const t1 = t0 + da
    const tm = (t0 + t1) / 2
    const p1x = cx + rx * Math.cos(t0)
    const p1y = cy + ry * Math.sin(t0)
    const p2x = cx + rx * Math.cos(t1)
    const p2y = cy + ry * Math.sin(t1)
    const pmx = cx + rx * (1 + amp) * Math.cos(tm)
    const pmy = cy + ry * (1 + amp) * Math.sin(tm)
    if (i === 0 && startWithMove) ops.push(M(p1x, p1y))
    ops.push(C(
      p1x + 0.55 * (pmx - p1x), p1y + 0.55 * (pmy - p1y),
      p2x + 0.55 * (pmx - p2x), p2y + 0.55 * (pmy - p2y),
      p2x, p2y
    ))
  }
  return ops
}

/** 发束生成用的弧定义 */
function arc(cx, cy, rx, ry, a0, a1) {
  return { cx: cx, cy: cy, rx: rx, ry: ry, a0: a0, a1: a1 }
}

/** 侧边面板：右半用原曲线，左半镜像，一次生成两侧 */
function panels(cfg) {
  const right = E.panelLocks(cfg)
  const left = E.panelLocks({
    inner: E.mirrorLock(cfg.inner),
    outer: E.mirrorLock(cfg.outer),
    count: cfg.count,
    width: cfg.width,
    fine: cfg.fine,
    tone: cfg.tone,
    wave: cfg.wave,
    curvePow: cfg.curvePow
  })
  return right.concat(left)
}

/**
 * 后颈两侧的头发。
 *
 * 这个函数被改过三次，前两次都错在同一个地方：**把脖子当成了缺口**。
 *
 *   第一版（复制粘贴）inner:[94,172] outer:[106,172]，宽 12、中心在 x=100
 *     —— 从嘴唇垂到下巴的一根黑竖条，像一撮山羊胡。
 *   第二版 inner:[74,188] outer:[126,182]，宽 52、盖住整个脖子
 *     —— 山羊胡没了，换成一整块从下巴垂到胸口的黑帘，像围了个围嘴。
 *
 * 根因不是宽度、也不是起点高度，而是**这一层本来就不该有**：
 * 脖子在 x 78..122、y 168 以下，长发垂在脖子**后面**，
 * 正面看过去，脖子正中间是被脖子自己挡住的 —— 那里应该什么都没有。
 * 能看见的只有脖子两侧那一条，也就是「垂帘内沿到脖子侧缘」这一段。
 *
 * 所以现在分成左右两片，中间 x 118..128 是硬性禁区。
 * 用 panels() 而不是 panelLocks()：panels 会自动镜像出左半边。
 */
function neckSideLocks(opt) {
  const o = opt || {}
  return panels({
    // 内沿必须留在脖子侧缘（x=122）之外。注意 getGeom 会按 fit 做
    // 水平归一化，缩放系数可能小于 1（卷发是 0.87），所以这里要留余量：
    // 126 缩完是 122.7，仍然 ≥ 122。
    inner: [126, 186, 128, 208, 126, 228, 120, 242],
    // 外沿接上垂帘的内沿（x≈150），两片之间不留缝
    outer: [152, 180, 154, 204, 150, 224, 140, 242],
    // 束数要够。这一片有 60 单位长、26 宽，7 束 × 14 宽铺不满，
    // 屏幕上是一片能透出背景的稀疏帘子；9 束 × 16 宽才成块。
    count: o.count || 9,
    width: o.width || [16, 3.4],
    fine: o.fine || 5,
    tone: o.tone == null ? -0.18 : o.tone,
    conv: 0.24,
    // 发梢参差。两片都是垂到底的，末端如果齐平，屏幕上就是两条
    // 被刀切过的黑色矩形下沿。
    tipJitter: o.tipJitter == null ? 7 : o.tipJitter,
    wave: o.wave || { amp: 2.2, freq: 1.2 }
  })
}

/* ---------------- 发型定义 ---------------- */

const HAIR_STYLES = [
  /* ========== 1. 寸头 ========== */
  {
    id: 'buzz',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.1,
    name: '寸头',
    en: 'Buzz Cut',
    tag: '清爽利落',
    face: '适合方脸 / 圆脸',
    desc: '极短寸头，轮廓干净，五官立体度立刻提升，夏天最省事。',
    // 寸头是哑光的：发茬太短，没有一整片反光面。
    // 原来 0.20 的高光在头顶糊出一条亮带，那是「塑料泳帽」的质感。
    sheen: { x: 76, y: 56, r: 46, a: 0.11 },
    outline() {
      // 发际线是「M」形：两侧额角高（露额头），中央略低。
      // 反过来（中间高两侧低）画出来就是一条横贯前额的弧 —— 帽子前沿。
      //
      // 下沿收到 y=118 并且**收成尖**：原来一直平着包到 y=126，
      // 屏幕上是一条横跨太阳穴的硬边，加上耳前那一块，就是泳帽的帽檐。
      return [[
        M(46, 118),
        C(42, 92, 44, 62, 62, 46),
        C(78, 32, 122, 32, 138, 46),
        C(156, 62, 158, 92, 154, 118),
        // 发际线抬到 y=84~92。原来压在 88~97，额头只剩 13 单位，
        // 加上一条硬边，读起来就是帽檐。
        C(152, 104, 148, 92, 142, 84),
        C(124, 92, 76, 92, 58, 84),
        C(52, 92, 48, 104, 46, 118),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        // 寸头不是「长头发」，是 3mm 的发茬。
        //
        // 之前用 crownLocks 从头顶拉一条 47 单位的弧到发际线，
        // 16 条这样的长弧在屏幕上就是「被梳子刮过的痕迹」，
        // 加上一条硬边轮廓，整体读起来是一顶泳帽。
        //
        // 现在改成撒满整个颅顶的**短毛茬**：长度 5~11 单位、束宽 1.2~2.4，
        // 640 簇。每簇 2 根细丝 → 约 1300 根，密度够成一片均匀的颗粒。
        // 挖掉脸的那块用一个大椭圆，它的上沿正好落在发际线（y≈88）上，
        // 所以发茬在额头处自然停住，两侧则一直铺到鬓角。
        E.stubble({
          // 撒的范围要**比脸宽**（rx 56 > 脸 rx 50），否则两侧鬓角那一条
          // 永远撒不到；挖的洞要**正好等于脸宽**（rx 50），
          // 这样洞的两侧各留 6 单位宽的竖条 —— 那就是鬓角。
          // 洞如果只有 49，鬓角会变成 7 单位宽的「胡茬糊到颧骨上」。
          // 束数是画质和体积的平衡点：900 束 → 4500 根细丝，
          // 几何计算 66ms（预算 40ms）、缩略图 26KB（预算 12KB），两条都爆。
          // 420 束 → 1900 根，肉眼看不出密度差别，两项都回到预算内。
          count: 420, cx: 100, cy: 80, rx: 56, ry: 46,
          // 椭圆的撒点范围在太阳穴处比轮廓宽 3 个单位，靠 bounds
          // 兜住：落在轮廓外的直接丢掉。轮廓在这里是**未缩放**的，
          // 而 fit 归一化只有 1.019 倍，余量够。
          bounds: E.sampleOps(this.outline()[0], 16),
          // 长度按真实比例：脸宽 100 单位 ≈ 150mm，所以 1 单位 = 1.5mm。
          // 寸头是 3~5mm，也就是 2~3.5 单位。这里给 2.5~5.5，
          // 略长一点是为了在 375px 的手机上还能看出颗粒。
          lenMin: 2.5, lenMax: 5.5, tone: 0, fine: 2,
          wMin: 0.8, wMax: 1.6, spread: 1.2, toneSpread: 0.38,
          // 洞用**圆角矩形**而不是椭圆。椭圆的上沿在两侧会往下掉，
          // 额角那两块就漏出来，在皮肤上撒出一片胡椒粉。
          // 矩形上沿是 y=88 的一条直线，正好和轮廓的发际线对齐；
          // 圆角 r=14 模拟两侧的额角后退。
          hole: { rect: true, x0: 48, x1: 152, y0: 84, y1: 268, r: 14 }
        })
        // 曾经在这里试过一层「发际线过渡短茬」，想用参差的发梢
        // 把发际线打毛。两次都不成立：
        //   · tone 给正值 → 整条发际线亮成一道灰带（那里正对观察者，
        //     shadeAt 的漫反射最高，集中在一条带上的亮发丝就是一条亮带）
        //   · tone 压负  → 变成一排朝下的深色短须，是「锅盖刘海」不是发际线
        // 根因是：任何**集中在发际线这一窄条**上的发丝层，都会自己变成一条带。
        // 真实的毛边必须由「本来就铺满整头的发丝」在边界处自然参差，
        // 不能靠事后补一层。所以这层删掉，边缘交给 edgeStrands。
      )
    }
  },

  /* ========== 2. 短碎发 ========== */
  {
    id: 'crop',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.14,
    name: '短碎发',
    en: 'Textured Crop',
    tag: '百搭减龄',
    face: '几乎适配所有脸型',
    desc: '带层次感的短碎发，顶部略蓬松，修饰额头又能拉长脸型。',
    sheen: { x: 72, y: 52, r: 48, a: 0.22 },
    outline() {
      return [[
        M(38, 134),
        C(34, 80, 54, 42, 100, 40),
        C(146, 42, 166, 80, 162, 134),
        L(146, 134),
        C(150, 116, 151, 102, 146, 93),
        C(128, 84, 72, 84, 54, 93),
        C(49, 102, 50, 116, 54, 134),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        E.crownLocks({
          start: arc(100, 46, 9, 5, Math.PI, Math.PI * 2),
          end: arc(100, 93, 46, 9, Math.PI, Math.PI * 2),
          count: 19, width: [8.5, 2.2], fine: 5, tone: 0.0, bulge: 0.18,
          wave: { amp: 1.1, freq: 1.6, phase: 0.4 }
        }),
        panels({
          inner: [100, 86, 128, 86, 149, 100, 160, 134],
          outer: [100, 40, 138, 46, 165, 90, 162, 134],
          count: 6, width: [10, 2.2], fine: 5, tone: -0.10,
          wave: { amp: 0.9, freq: 1.4 }
        })
      )
    }
  },

  /* ========== 3. 波波头 ========== */
  {
    id: 'bob',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.28,
    name: '波波头',
    en: 'Blunt Bob',
    tag: '气质干练',
    face: '适合长脸 / 鹅蛋脸',
    desc: '齐下巴的内扣波波头，配平齐刘海，脸小一圈，通勤约会都稳。',
    sheen: { x: 70, y: 56, r: 54, a: 0.22 },
    outline() {
      // 发际线（内轮廓上边界）压在 y=94，而不是发丝末端所在的 y≈101。
      //
      // 这一条是「发际线黑边」的根治办法。发块底色最暗处接近纯黑，
      // 只要它在发丝稀疏的地方露出来，就是一道硬边。而发丝末端带 ±3 的
      // 抖动、还会横向散开，永远铺不满一条直线 —— 所以**轮廓不能比发丝长**。
      // 把轮廓收到发丝密集区的内侧，发际线就由发丝末端自然形成，
      // 参差不齐、深浅不一，而不是被一条矢量直线切出来。
      return [[
        M(32, 178),
        C(20, 122, 24, 50, 100, 42),
        C(176, 50, 180, 122, 168, 178),
        L(138, 178),
        C(144, 152, 148, 126, 147, 110),
        C(146, 104, 145, 98, 144, 94),
        L(56, 94),
        C(55, 98, 54, 104, 53, 110),
        C(52, 126, 56, 152, 62, 178),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        // 平齐刘海。
        //
        // 四个参数都是为了让它不像"假发片下缘"：
        //   end.ry 从 0 改成 3 —— ry=0 画出来是一条数学上的绝对水平线，
        //     而真人剪出来的"平齐"只是相对齐，发梢总有 1~3px 的高低。
        //     纯直线远看就是一条硬边。
        //   end.cy 从 99 下移到 101 —— 让发丝末端**溢出**轮廓的发际线（y=94），
        //     发际线才由发丝末端自己形成，而不是被轮廓线切出来。
        //   width 的梢宽从 2.2 提到 4.2 —— 这个值以前是死参数（引擎只读根宽），
        //     现在生效了：梢宽占比从 9% 提到 47%，19 根发束才能把发际线铺满，
        //     而不是在发根处露出一条整齐的黑底。
        //   count 17 → 19，配合上面的梢宽，密度够但不至于糊成一片实心。
        //   endJitter 12（默认 6）—— 发梢长度参差。等长的发梢会排成一把梳子，
        //     这是「齐刘海」最容易翻车的地方：真人的刘海是一根根剪出来的，
        //     相邻发丝的长短差常有 3~5mm，末端参差才像头发。
        //   conv 0.52 → 0.16 —— 收敛比例。默认值让发束内的 6 根细丝在梢部
        //     向中心挤成一根粗线，19 根发束排开就是一把整齐的梳齿。
        //     真人刘海的梢部是散开的，发丝之间会透出额头。散开之后，
        //     缝隙里露出的是皮肤（不是发块底色，因为轮廓已经收在 y=94），
        //     所以不会重新长出黑边。
        E.crownLocks({
          start: arc(100, 50, 7, 4, Math.PI, Math.PI * 2),
          end: arc(100, 107, 45, 4, Math.PI, Math.PI * 2),
          count: 19, width: [9, 3.4], fine: 6, tone: 0.04, bulge: 0.10,
          endJitter: 10, conv: 0.16
        }),
        // 侧边面板：内沿贴脸、外沿走轮廓，发束在两者之间铺满。
        //
        // count 6 → 9。原来 6 束 × 10 宽 = 60，而 outer 从 x=104 铺到 180
        // 要覆盖 76 —— 差出来的 16 单位在脸颊两侧露出发块底色，
        // 画面上就是两个黑色的三角挂在耳朵前面。加束数而不是加束宽，
        // 因为加宽会让侧边变成一整片实心（发束感消失）。
        // conv 0.34 → 0.16：和刘海同理。收敛太强时每束在梢部挤成一个尖，
        // 9 束排开就是脸颊边缘一圈锯齿。散开之后末端变成一缕缕细丝，
        // 覆盖面积反而更大，锯齿也消失了。
        panels({
          inner: [144, 99, 148, 122, 146, 154, 138, 178],
          outer: [104, 42, 152, 52, 180, 122, 168, 178],
          count: 9, width: [9, 2.6], fine: 6, tone: -0.06, conv: 0.16
        })
      )
    }
  },

  /* ========== 4. 齐刘海短发 ========== */
  {
    id: 'fringe',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.24,
    name: '齐刘海短发',
    en: 'Short with Fringe',
    tag: '甜酷日系',
    face: '适合高额头 / 长脸',
    desc: '厚重齐刘海盖住额头，两侧收在耳下，显嫩又显脸小。',
    sheen: { x: 70, y: 54, r: 50, a: 0.21 },
    outline() {
      return [[
        M(36, 144),
        C(24, 118, 28, 50, 100, 42),
        C(172, 50, 176, 118, 164, 144),
        L(140, 144),
        C(146, 128, 148, 114, 147, 104),
        C(146, 100, 145, 98, 144, 97),
        L(56, 97),
        C(55, 98, 54, 100, 53, 104),
        C(52, 114, 54, 128, 60, 144),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        E.crownLocks({
          start: arc(100, 48, 7, 4, Math.PI, Math.PI * 2),
          end: arc(100, 97, 45, 0, Math.PI, Math.PI * 2),
          count: 18, width: [9, 2.2], fine: 5, tone: 0.03, bulge: 0.10
        }),
        panels({
          inner: [144, 97, 148, 118, 147, 134, 140, 144],
          outer: [104, 42, 150, 50, 176, 112, 164, 144],
          count: 6, width: [10, 2.4], fine: 6, tone: -0.06, conv: 0.34
        })
      )
    }
  },

  /* ========== 5. 长直发 ========== */
  {
    id: 'long-straight',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.48,
    name: '长直发',
    en: 'Long Straight',
    tag: '经典温柔',
    face: '适合圆脸 / 方脸',
    desc: '顺直长发垂到胸前，两侧发丝收窄脸部轮廓，温柔感拉满。',
    sheen: { x: 68, y: 56, r: 58, a: 0.22 },
    outline() {
      return [[
        M(26, 236),
        C(12, 168, 18, 52, 100, 42),
        C(182, 52, 188, 168, 174, 236),
        L(132, 236),
        C(140, 200, 146, 168, 147, 134),
        // 发际线要**埋进发丝里**，不能比发丝长。
        // 原来这条边是 y≈84~91 的一条近水平线，而刘海发梢落在 y≈91±抖动 ——
        // 等于发块的底边露在发梢上面，屏幕上就是一条横贯前额的硬黑边，
        // 像戴了顶帽子。
        //
        // 而且**拐角必须比发梢更低**：发丝是从 (100,48) 这个圆心往
        // 半径 46 的弧上铺的，弧的两端正好落在 x=54 / 146。如果发块
        // 在 x=144 / 56 处还留着一个 y=92 的直角，那个角就会从发梢
        // 底下露出来 —— 屏幕上就是额角两侧各一个黑色小方块。
        // 把拐角压到 y=99、发丝弧半径放大到 46，拐角就落在发丝里面了。
        C(147, 116, 146, 104, 146, 99),
        C(128, 99, 72, 99, 54, 99),
        C(54, 104, 53, 116, 53, 134),
        C(54, 168, 60, 200, 68, 236),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        // 齐刘海。参数说明见 bob 的同款注释：
        //   梢宽 2.3 → 4.0 —— 引擎现在真的读 w[1] 了，17 根发束才能把
        //     发际线铺满，而不是在发根处露出一条整齐的底色；
        //   endJitter —— 真人剪出来的「齐」只是相对齐，发梢总有高低。
        E.crownLocks({
          start: arc(100, 48, 8, 5, Math.PI, Math.PI * 2),
          end: arc(100, 98, 46, 5, Math.PI, Math.PI * 2),
          count: 20, width: [9, 4.2], fine: 6, tone: 0.02, bulge: 0.14,
          endJitter: 8
        }),
        panels({
          inner: [144, 91, 147, 118, 146, 162, 132, 236],
          outer: [104, 42, 154, 54, 188, 142, 174, 236],
          count: 8, width: [11, 2.4], fine: 7, tone: -0.06, conv: 0.22,
          wave: { amp: 1.6, freq: 1.1 }
        }),
        // 背后一层更暗的体量：从轮廓外缘隐约透出，制造纵深
        panels({
          inner: [150, 100, 152, 126, 151, 170, 142, 236],
          outer: [110, 44, 156, 56, 182, 146, 176, 236],
          count: 4, width: [15, 2.8], fine: 5, tone: -0.34, conv: 0.2,
          wave: { amp: 2.4, freq: 0.85 }
        }),
        // 脖子两侧的头发（脖子正中必须留空），见 neckSideLocks 的注释
        neckSideLocks()
      )
    }
  },

  /* ========== 6. 大波浪 ========== */
  {
    id: 'wavy',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.7,
    name: '大波浪',
    en: 'Big Waves',
    tag: '氛围感',
    face: '适合长脸 / 鹅蛋脸',
    desc: '大卷波浪从耳侧开始铺开，蓬松有量感，上镜立刻高级。',
    sheen: { x: 68, y: 56, r: 60, a: 0.24 },
    outline() {
      const cx = 100, cy = 120, rx = 84, ry = 92
      const a1 = Math.PI * 1.02
      const a2 = Math.PI * 1.99
      const s = E.ptOn(cx, cy, rx, ry, a1)
      return [[
        M(20, 236),
        C(10, 176, 12, 132, s[0], s[1]),
        ...scallopOps(cx, cy, rx, ry, a1, a2, 5, 0.075, false),
        C(180, 172, 182, 208, 176, 236),
        L(134, 236),
        C(142, 200, 148, 168, 149, 134),
        C(149, 116, 147, 102, 144, 91),
        C(126, 84, 74, 84, 56, 91),
        C(53, 102, 51, 116, 51, 134),
        C(52, 168, 58, 200, 66, 236),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        E.crownLocks({
          start: arc(100, 34, 14, 8, Math.PI, Math.PI * 2),
          end: arc(100, 91, 44, 7, Math.PI, Math.PI * 2),
          count: 16, width: [9, 2.3], fine: 5, tone: 0.02, bulge: 0.14,
          wave: { amp: 1.2, freq: 1.5 }
        }),
        // 左右两条外引导曲线必须严格镜像。之前右边给到 x=200、
        // 左边只到 x≈176，实测整头中心偏右 6% 脸宽 ——
        // 用户看到的就是「发型戴歪了」，而且歪得很明显。
        panels({
          inner: [144, 91, 147, 118, 146, 162, 132, 236],
          // 外引导曲线贴住 scallop 轮廓（内侧留 6~10 单位）。
          outer: [104, 38, 166, 48, 200, 130, 176, 236],
          count: 6, width: [15, 3], fine: 8, tone: -0.04, conv: 0.18,
          wave: { amp: 9, freq: 1.5 }
        }),
        panels({
          inner: [56, 91, 53, 118, 54, 162, 68, 236],
          outer: [96, 38, 34, 48, 0, 130, 24, 236],
          count: 6, width: [15, 3], fine: 8, tone: -0.04, conv: 0.18,
          wave: { amp: 9, freq: 1.5, phase: Math.PI }
        }),
        panels({
          inner: [150, 100, 152, 126, 151, 170, 142, 236],
          outer: [110, 42, 162, 54, 190, 146, 178, 236],
          count: 4, width: [17, 3.2], fine: 6, tone: -0.32, conv: 0.18,
          wave: { amp: 10, freq: 1.3, phase: 1.6 }
        }),
        panels({
          inner: [50, 100, 48, 126, 49, 170, 58, 236],
          outer: [90, 42, 38, 54, 10, 146, 22, 236],
          count: 4, width: [17, 3.2], fine: 6, tone: -0.32, conv: 0.18,
          wave: { amp: 10, freq: 1.3, phase: 1.6 + Math.PI }
        }),
        // 脖子两侧的头发（脖子正中必须留空），见 neckSideLocks 的注释
        neckSideLocks()
      )
    }
  },

  /* ========== 7. 背头 ========== */
  {
    id: 'pompadour',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.18,
    name: '背头',
    en: 'Pompadour',
    tag: '复古精英',
    face: '适合方脸 / 圆脸',
    desc: '两侧收紧、顶部向后梳起，露出额头和眉眼，气场直接拉高。',
    sheen: { x: 78, y: 34, r: 40, a: 0.30 },
    outline() {
      return [[
        // 两侧收在耳上（y≈104）。原来一直包到 y=124（耳垂以下），
        // 加上顶部又不够高，整个轮廓读起来就是「蘑菇头 / 锅盖」——
        // 背头最关键的特征是**两侧紧、顶部高**，靠轮廓的收腰来体现。
        // 鬓角收成一个尖（y=108），而不是一条 6 单位长的平底边。
        // 平底边会被 edgeStrands 当成「轮廓的一段」均匀撒上碎发，
        // 5 个采样点 × 5 根 = 25 根全部朝下垂到耳朵上 ——
        // 屏幕上是从鬓角挂下来的一丛细黑线，像蜘蛛腿。
        // 收成尖之后这条边只有 4 单位、而且是斜的，碎发自然散开。
        M(47, 108),
        C(41, 94, 40, 78, 48, 70),
        // 顶部抬到 y≈16，并且前沿（x 84~120）比后脑更高：
        // 背头是前面梳起来的一坨，最高点在前半段而不是正中间。
        C(46, 50, 56, 30, 84, 20),
        C(112, 12, 148, 24, 158, 52),
        C(166, 70, 164, 90, 157, 108),
        L(149, 102),
        // 发际线抬到 y≈60：背头要露出整个额头。
        //
        // 这里踩过一个坑，记下来免得再犯：轮廓抬上去了，但**发根没跟着抬**。
        // polygon() 的根部是收尖的（前 20% 长度从 0 长到满宽），
        // 17 个尖点排在 y 71..85、轮廓边界在 60..68 —— 于是 17 个尖点
        // 整整齐齐露在额头的皮肤上，屏幕上是「一排梳齿」。
        // 现在的做法是让发根一律扎在轮廓**内侧**（y ≤ 62），
        // 发际线本身交给下面那层「钝头碎发」去铺。
        C(150, 92, 150, 76, 144, 62),
        C(122, 56, 78, 56, 56, 62),
        C(50, 76, 50, 92, 51, 104),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        // 主体：从发际线内侧一路梳到头顶，撑起整个体量。
        // 发根在 y 57..62，全部落在轮廓内 —— 这是关键。
        // polygon() 的根部必然收尖，发根一旦越过轮廓边界，
        // 露在皮肤上的就是一排等距的尖点。
        E.crownLocks({
          start: arc(100, 60, 44, 4, Math.PI, Math.PI * 2),
          end: arc(102, 26, 24, 10, Math.PI, Math.PI * 2),
          count: 18, width: [8, 2.0], fine: 5, tone: 0.04, bulge: 0.22
        }),
        // 表层：几束又长又亮的发丝从额前一路梳到头顶。
        // 这是"背头"最直接的视觉特征 —— 能看出梳拢的方向，
        // 只靠体量撑是撑不出来的。
        // 起笔一律在 y=54 —— 必须落在发际线（56~62）**内侧**。
        // 之前这五束从 y=66 起笔，5 个收尖的发根露在额头的皮肤上，
        // 每个发根展开成 13 根细丝，聚成一小撮 —— 屏幕上就是
        // 沿发际线排开的一排黑色小齿，20 多个，间距均匀。
        { p: [62, 54, 58, 44, 72, 28, 94, 18], w: [7, 1.8], n: 5, tone: 0.22, conv: 0.3 },
        { p: [78, 54, 76, 44, 86, 28, 101, 16], w: [7, 1.8], n: 5, tone: 0.26, conv: 0.3 },
        { p: [94, 54, 94, 44, 98, 28, 105, 15], w: [7, 1.8], n: 5, tone: 0.28, conv: 0.3 },
        { p: [110, 54, 110, 44, 110, 28, 109, 15], w: [7, 1.8], n: 5, tone: 0.24, conv: 0.3 },
        { p: [126, 54, 124, 44, 120, 28, 113, 16], w: [7, 1.8], n: 5, tone: 0.18, conv: 0.3 },
        // 两侧收紧贴头皮，收在耳上
        panels({
          // 两条导轨的终点错开 6 个单位（102 / 108）：齐平的话
          // 5 束发梢排成一条水平线，屏幕上是被刀切过的下沿。
          inner: [146, 72, 149, 84, 150, 96, 149, 102],
          outer: [108, 18, 148, 24, 166, 64, 157, 108],
          count: 5, width: [9, 2], fine: 5, tone: -0.14, conv: 0.42
        })
      )
    }
  },

  /* ========== 8. 羊毛卷 ========== */
  {
    id: 'curly',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.52,
    name: '羊毛卷',
    en: 'Curly Volume',
    tag: '时髦个性',
    face: '适合小脸 / 尖下巴',
    desc: '细密小卷堆出饱满量感，头顶蓬松显发量，个性又有亲和力。',
    sheen: { x: 70, y: 50, r: 56, a: 0.20 },
    // 卷簇是散点撒的，卷与卷之间必然有缝。底色压到 -0.06 时，
    // 这些缝在屏幕上是纯黑，整头看起来「一块一块发黑、没有层次」。
    // 抬到 +0.10 之后，缝变成中间调，读作「卷与卷之间的暗部」。
    fillLift: 0.34,
    outline() {
      const cx = 100, cy = 110, rx = 76, ry = 84
      const a1 = Math.PI * 1.02
      const a2 = Math.PI * 1.99
      const s = E.ptOn(cx, cy, rx, ry, a1)
      return [[
        M(32, 176),
        C(24, 148, 22, 126, s[0], s[1]),
        ...scallopOps(cx, cy, rx, ry, a1, a2, 7, 0.12, false),
        C(176, 132, 174, 156, 168, 176),
        L(150, 176),
        C(152, 152, 151, 128, 147, 110),
        C(126, 88, 74, 88, 53, 110),
        C(49, 128, 48, 152, 50, 176),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        E.crownLocks({
          start: arc(100, 28, 17, 11, Math.PI, Math.PI * 2),
          // 卷发的中下部交给卷簇，冠部发束只铺头顶。
          // 之前让它一路拉到发际线，等于在卷团里插了 22 根又长又直的棍子，
          // 卷发的体积感全被这些直棍破坏了。
          end: arc(100, 76, 40, 14, Math.PI, Math.PI * 2),
          count: 18, width: [9, 2.4], fine: 5, tone: 0.02, bulge: 0.22,
          wave: { amp: 3.2, freq: 3.4 }
        }),
        // 发际线那一圈必须单独补一层 —— 这是「黑色发箍」的根因。
        //
        // 冠部发束的梢部落在 y 62..76（end 弧 ry=14，角度只取上半，
        // 所以 y = 76 + 14·sin(a) 永远 ≤ 76），而卷簇的 hole 从 y=88
        // 开始挖空（保护额头）。76..88 这 12 个单位谁都不管，
        // 露出来的就是发块底色，屏幕上是横贯前额的一条黑带。
        //
        // 补的是一排**短**卷：从 78 到 92，26 束。梢宽比例给到 52%
        // （width [8, 4.2]），所以梢部是圆钝的卷团而不是针尖 ——
        // 针尖并排就是梳齿，那是比黑带更难看的破绽。
        // 梢部会溢出轮廓的洞边界（y=88）几个单位，落在额头上，
        // 这一小撮碎卷是卷发本来该有的样子，不是穿帮。
        E.crownLocks({
          start: arc(100, 78, 41, 7, Math.PI, Math.PI * 2),
          end: arc(100, 92, 43, 6, Math.PI, Math.PI * 2),
          count: 26, width: [8, 4.2], fine: 5, tone: 0.08, bulge: 0.12,
          endJitter: 9, conv: 0.18,
          wave: { amp: 2.4, freq: 3.8 }
        }),
        panels({
          // 端点从 y=176 拉到 188：176 正好是下颌，头发在这里
          // 齐平断掉，屏幕上是一条横切的硬边。拉到 188 之后
          // 发梢垂到下颌以下，末端由 tipJitter 打散。
          inner: [147, 110, 150, 130, 150, 160, 152, 188],
          outer: [104, 30, 160, 40, 187, 118, 172, 188],
          count: 6, width: [15, 3], fine: 7, tone: -0.04, conv: 0.3,
          wave: { amp: 5, freq: 3.2 }
        }),
        // 小卷簇：在发型范围内撒满短 S 形发束，堆出羊毛卷的颗粒感。
        // 只靠给长发束加正弦只能做出"波浪"，做不出"卷"。
        //
        // 顺序关键：卷簇必须画在 panels 之后。panels 是 6 束宽 15 的暗色
        // 长发束，正好整片盖住侧下方 lobe —— 卷簇画在它下面等于白撒，
        // 亮卷全被盖住，下半球只剩 panels 的 base 色和填充的 shadow 底，
        // 屏幕上就是一整片死黑。挪到上面，亮卷压在暗长发束上，
        // 颗粒感才出得来。
        E.curlTufts({
          // 全头覆盖：撒点椭圆放大到和外轮廓基本一致（cx100,cy108,rx74,ry84），
          // 之前 cx100,cy96,rx66,ry82 只盖住头顶，
          // 侧下方 lobe（x 22..50 / 150..178，y 110..160）落在撒点椭圆之外，
          // 那里既没卷簇也没发丝，只剩径向填充的 shadow 底色 → 整片死黑。
          // count 430：撒点椭圆大、脸洞 rejection 率约四成，落地的有效卷簇
          // 只有六成，按落地密度反推的数目。
          count: 490, cx: 100, cy: 108, rx: 74, ry: 84,
          lenMin: 9, lenMax: 19, tone: 0.05, toneSpread: 0.95, fine: 3,
          // 挖掉整张脸（和 outline 的脸洞一致），额角/鬓角之外的侧面照常撒卷。
          hole: { cx: 100, cy: 120, rx: 52, ry: 70 },
          // 以轮廓为准裁剪：卷粒飞不出发型轮廓，也就不会
          // 垂进脖子正中（fit-check 的「下巴」项）或悬空飘在脸旁。
          bounds: E.sampleOps(this.outline()[0], 16)
        }),
        // 两侧下摆的专用亮卷。全头撒点的卷落到两个 lobe 的只有 30 个，
        // 而 lobe 里压着 400 多条 panels 暗发丝 —— 少量卷簇改变不了
        // 「整片死黑」。这两簇直接撒在 lobe 上、色调整体抬高
        // （发梢受光更多，是真实头发的下摆反光），卷粒才立得住。
        // 椭圆按轮廓侧边定：左缘 y≈142 处 x≈23..47，右缘 x≈153..175。
        E.curlTufts({
          count: 62, cx: 35, cy: 142, rx: 12, ry: 33,
          lenMin: 8, lenMax: 16, tone: 0.16, toneSpread: 0.8, fine: 3,
          hole: { cx: 100, cy: 119, rx: 54, ry: 72 },
          bounds: E.sampleOps(this.outline()[0], 16)
        }),
        E.curlTufts({
          count: 62, cx: 164, cy: 142, rx: 12, ry: 33,
          lenMin: 8, lenMax: 16, tone: 0.16, toneSpread: 0.8, fine: 3,
          hole: { cx: 100, cy: 119, rx: 54, ry: 72 },
          bounds: E.sampleOps(this.outline()[0], 16)
        }),
        // 脖子两侧的头发，见 neckSideLocks 的注释。
        // 卷发这里必须给足波浪：默认的 amp 2.2 对 60 单位长的垂发
        // 等于一根直线，屏幕上就是两片黑色的直帘子，跟「羊毛卷」不搭。
        neckSideLocks({ wave: { amp: 6, freq: 3.0 }, count: 9, width: [13, 3] })
      )
    }
  },

  /* ========== 9. 高马尾 ========== */
  {
    id: 'ponytail',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.34,
    name: '高马尾',
    en: 'High Ponytail',
    tag: '元气少女',
    face: '适合圆脸 / 鹅蛋脸',
    desc: '全部梳起扎高，脸型线条完全露出，精神又显高颅顶。',
    sheen: { x: 74, y: 52, r: 46, a: 0.22 },
    outline() {
      return [
        [
          M(44, 122),
          C(44, 70, 66, 44, 100, 44),
          C(134, 44, 156, 70, 156, 122),
          C(156, 110, 150, 99, 142, 94),
          C(126, 88, 74, 88, 58, 94),
          C(50, 99, 44, 110, 44, 122),
          Z()
        ],
        [
          // 马尾的椭圆比原来放大了一圈。
          // 发丝是不受 outline 约束的（paint 里没有对轮廓做 clip），
          // 所以只要发束中心线贴着轮廓走，束宽的一半就必然戳出去 ——
          // 截图里马尾右上角那撮飞出去的头发就是这么来的。
          // 与其给马尾单独加一层 clip（paint 是通用的，加不了），
          // 不如把轮廓放到能包住发丝的位置。
          M(148, 52),
          C(160, 32, 182, 34, 188, 56),
          C(193, 82, 185, 112, 177, 132),
          C(171, 144, 157, 140, 155, 124),
          C(152, 100, 149, 72, 148, 52),
          Z()
        ]
      ]
    },
    locks() {
      return [].concat(
        // 头顶梳得极紧，发丝向后收拢
        E.crownLocks({
          start: arc(100, 94, 42, 6, Math.PI, Math.PI * 2),
          end: arc(100, 50, 8, 5, Math.PI, Math.PI * 2),
          count: 19, width: [7, 1.8], fine: 5, tone: -0.04, bulge: 0.08
        }),
        panels({
          inner: [142, 94, 146, 104, 150, 114, 156, 122],
          outer: [100, 44, 132, 48, 155, 86, 156, 122],
          count: 5, width: [8, 1.8], fine: 4, tone: -0.16
        }),
        // 马尾本体。
        //
        // 原来这 6 条贝塞尔从 y=194 起笔、垂到 y=246 —— 那是**后颈以下**，
        // 而 outline 里声明马尾形状的是右上角那个椭圆（y 26~148）。
        // 两边完全错位：椭圆里一根发丝都没有，成了一块纯黑的实心块；
        // 发丝却戳在脖子下面，远看像一撮胡须。
        //
        // 现在改成沿椭圆长轴铺发丝：发根弧在椭圆顶部（y 31~49），
        // 发梢弧在尾端（y 129~143），半径从 24 收到 11 —— 这是马尾
        // 「上松下紧」的形状。两条弧的起始角一致（都是 π→2π），
        // 配对后每根发丝都是从上往下走，不会交叉。
        //
        // bulge 必须很小。上一版给 0.18，法线外推把每根发丝都往同一个
        // 方向推，加上摆动相位，整片变成了横向条纹 —— 看起来像一把刷子
        // 而不是一束头发。马尾是扎紧的，本来就该是顺直的。
        // 发丝是一维的流，椭圆是二维的面 —— 要铺满，发根弧必须够到
        // 椭圆的左右边缘，不能只在中心一小段里铺。
        // 上一版 start 弧只到 x 147~183，椭圆却有 136~192 宽，
        // 结果左右两片完全没发丝，露出发块底色，看着就是两块黑斑。
        E.crownLocks({
          start: arc(168, 42, 10, 7, Math.PI, Math.PI * 2),
          end: arc(168, 136, 11, 8, Math.PI, Math.PI * 2),
          count: 20, width: [7, 2.6], fine: 6, tone: 0.02, bulge: 0.04
        })
      )
    }
  },

  /* ========== 10. 中分长发 ========== */
  {
    id: 'middle-part',
    // 发型宽 / 脸宽 的设计目标。getGeom 会把水平方向归一化到这个值，
    // 保证同一张脸换发型时大小关系始终合理（圆寸贴头、大波浪外扩）。
    fit: 1.46,
    name: '中分长发',
    en: 'Middle Part',
    tag: '韩系清冷',
    face: '适合所有脸型',
    desc: '中分带出两片额前碎发，修饰颧骨，清冷又有女人味。',
    sheen: { x: 66, y: 56, r: 58, a: 0.22 },
    outline() {
      return [[
        M(26, 236),
        C(12, 168, 18, 52, 100, 42),
        C(182, 52, 188, 168, 174, 236),
        L(132, 236),
        C(140, 200, 146, 168, 147, 134),
        C(147, 114, 146, 100, 144, 91),
        C(126, 84, 74, 84, 56, 91),
        C(54, 100, 53, 114, 53, 134),
        C(54, 168, 60, 200, 68, 236),
        Z()
      ]]
    },
    locks() {
      return [].concat(
        // 右半：从中缝扇形铺到右半发际线
        E.crownLocks({
          start: arc(100, 50, 4, 3, Math.PI, Math.PI * 2),
          end: arc(100, 91, 44, 7, Math.PI * 1.5, Math.PI * 2),
          count: 11, width: [8, 2.1], fine: 5, tone: 0.02, bulge: 0.16
        }),
        // 左半
        E.crownLocks({
          start: arc(100, 50, 4, 3, Math.PI, Math.PI * 2),
          end: arc(100, 91, 44, 7, Math.PI, Math.PI * 1.5),
          count: 11, width: [8, 2.1], fine: 5, tone: 0.02, bulge: 0.16
        }),
        // 分缝线：一条细窄的深色发束从头顶垂到发际线，
        // 这是"中分"唯一可靠的视觉标志，没有它就只是普通长直发
        { p: [100, 46, 100, 62, 100, 76, 100, 88], w: [3, 1.2], n: 3, tone: -0.62 },
        panels({
          inner: [144, 90, 147, 118, 146, 162, 132, 236],
          outer: [104, 42, 154, 54, 188, 142, 174, 236],
          count: 8, width: [11, 2.4], fine: 7, tone: -0.06, conv: 0.22,
          wave: { amp: 1.4, freq: 1.1 }
        }),
        // 脖子两侧的头发（脖子正中必须留空），见 neckSideLocks 的注释
        neckSideLocks()
      )
    }
  }
]

/* ---------------- 发色 ---------------- */

/**
 * 只存基色 + 高光色，其余 4 阶由 buildRamp 推导。
 * 这样 12 个色 × 6 阶 = 72 个色值不用手写，且阶间关系恒定。
 */
// sheenTint 是 tone=1（最强高光）时发丝的颜色，也是光泽层的颜色。
// 深色头发必须给暗的高光色：真实黑发的镜面反射只到中暗灰蓝，
// 给到 #8b90a6 这种中灰，成片的发丝打满高光后整头就变成灰色了 ——
// 这是之前「一片灰白」的根因，不是光照模型算错。
const HAIR_COLORS = [
  { id: 'black', name: '自然黑', base: '#1b1a21', sheenTint: '#565c72' },
  { id: 'darkbrown', name: '深棕', base: '#33231a', sheenTint: '#6d5341' },
  { id: 'chestnut', name: '栗棕', base: '#57381f', sheenTint: '#a87b4d' },
  { id: 'flaxen', name: '亚麻棕', base: '#7d6044', sheenTint: '#c9a97e' },
  { id: 'honey', name: '蜂蜜金', base: '#b3833c', sheenTint: '#f0cd82' },
  { id: 'rosegold', name: '玫瑰金', base: '#b06f6b', sheenTint: '#f0b3a9' },
  { id: 'redbrown', name: '红棕', base: '#6f2d1c', sheenTint: '#c06f49' },
  { id: 'wine', name: '酒红', base: '#5c1626', sheenTint: '#9e4258' },
  { id: 'blueblack', name: '蓝黑', base: '#14182b', sheenTint: '#4a5680' },
  { id: 'ashpurple', name: '灰紫', base: '#4a3b52', sheenTint: '#8b7d9b' },
  { id: 'silver', name: '银灰', base: '#9a9aa6', sheenTint: '#e2e2ec' },
  { id: 'sakura', name: '樱花粉', base: '#b07184', sheenTint: '#f0aec0' }
]

// 补齐 ramp / swatch，保持对页面层的字段兼容
for (let i = 0; i < HAIR_COLORS.length; i++) {
  const c = HAIR_COLORS[i]
  c.ramp = E.buildRamp(c.base, c.sheenTint)
  c.swatch = c.base
  c.top = c.ramp.mid
  c.bottom = c.ramp.shadow
}

/* ---------------- 查询 ---------------- */

function getStyle(id) {
  for (let i = 0; i < HAIR_STYLES.length; i++) {
    if (HAIR_STYLES[i].id === id) return HAIR_STYLES[i]
  }
  return HAIR_STYLES[0]
}

function getColor(id) {
  for (let i = 0; i < HAIR_COLORS.length; i++) {
    if (HAIR_COLORS[i].id === id) return HAIR_COLORS[i]
  }
  return HAIR_COLORS[0]
}

/**
 * 这个 id 到底存不存在。
 *
 * getStyle 对认不出的 id 一律回落到 HAIR_STYLES[0]，这是**绘制**需要的行为
 * （画布上必须永远有东西可画）。但「判断用户存下来的 id 还有没有效」是另一回事：
 * 那里回落就等于张冠李戴 —— 收藏里存着一个已下架的 id，卡片上却出现了
 * buzz 的名字和缩略图，用户根本没收藏过它。
 * 所以凡是「这个 id 是数据、不是渲染参数」的地方，都要先用 hasStyle 判存在性。
 */
function hasStyle(id) {
  if (typeof id !== 'string' || !id) return false
  for (let i = 0; i < HAIR_STYLES.length; i++) {
    if (HAIR_STYLES[i].id === id) return true
  }
  return false
}

function hasColor(id) {
  if (typeof id !== 'string' || !id) return false
  for (let i = 0; i < HAIR_COLORS.length; i++) {
    if (HAIR_COLORS[i].id === id) return true
  }
  return false
}

/* ---------------- 几何缓存 ---------------- */

const geomCache = {}
/**
 * high 精度几何的缓存上限。
 *
 * 实测单款 high 几何约 2.2MB（600 条发丝 × 每条几十个贝塞尔控制点），
 * 10 款全缓存就是 21.8MB —— 再加上 5 张烘焙画布的 8.6MB，
 * 光「看过所有发型」这一件事就能把低端机的可用内存吃掉三成，
 * 表现为来回切几轮之后小程序被系统回收（自己重启）。
 *
 * high 只在**烘焙那一刻**需要：烘完就是一张位图，几何数据没人再引用。
 * 所以 getBaked 烘完会主动 releaseGeom，这里再留 4 个做 LRU 兜底
 * （prewarm 一次要连续烘 3 款，小于 3 会退化成反复重算）。
 */
const GEOM_HIGH_MAX = 4
const GEOM_ORDER = []

/**
 * 生成某款发型的完整几何。结果缓存，因为发丝分布只跟 styleId 有关
 * （换发色不重新算几何，只换颜色）。
 *
 * 三档精度：
 *   high 实时预览 / 离屏烘焙（600 条发丝）
 *   mid  烘焙不可用时的降级路径，保证还能跑到可用的帧率
 *   low  缩略图（140px 宽，细发丝本来就看不清）
 */
function getGeom(style, detail) {
  const key = style.id + '@' + detail
  if (geomCache[key]) return geomCache[key]

  const low = detail === 'low'
  const mid = detail === 'mid'
  const rng = E.mulberry32(E.hashStr(style.id))
  let locks = style.locks()
  // 缩略图只需要看个大概形状，卷发簇这类高频细节按 1/4 抽样即可，
  // 否则单张缩略图会涨到 16KB，10 张就 160KB 塞进 WXML 数据里。
  // 缩略图只需要看个大概形状，高频细节按比例抽样即可，
  // 否则单张缩略图会涨到 14KB，10 张就 140KB 塞进 WXML 数据里。
  // 抽样的判据不能只看 tuft 标记：后来给长发补的「后层中长发束」
  // 是普通 panels，没有 tuft 标记，于是一次也没被抽样，
  // 缩略图直接从 87KB 涨到 138KB。
  // 改为按「装饰性 + 序号」双条件抽样：带 tuft 的按 1/6，
  // 其余按索引奇偶抽一半，保证任何新增发束都不会顶爆体积。
  // （卷发的卷簇加到 ~330 个之后 1/4 会让单张缩略图顶到 11.5KB，
  // 而「最重 10 张 ≤ 100KB」要求单张 ≤ 10.24KB —— 全部 10 个最重 URI
  // 都是卷发的 12 个发色，等于要求卷发单张 ≤ 10.24KB，所以收紧到 1/6。
  // 缩略图只有 140px 宽，卷粒密度差这点看不出来。）
  if (low) {
    locks = locks.filter((l, i) => (l.tuft ? i % 6 === 0 : i % 2 === 0))
  }
  const outline = style.outline()

  const body = E.expand(locks, rng, {
    // 发丝密度是质感的关键。单条发丝太宽（2~3 单位，在手机上就是 5~8px）
    // 看起来像笔刷涂抹；真实头发在这个尺度下应该是 0.5~1.5 单位。
    // 所以高精度下把发束展开倍数拉到 2.6，靠数量堆出细腻度。
    // 缩略图反过来：140px 宽下 1 单位只占 0.7px，细发丝根本看不见，
    // 用「更少但更宽」的发丝即可，省下的字节很可观。
    scale: low ? 0.28 : mid ? 1.15 : 2.6,
    samples: low ? 5 : mid ? 9 : 12,
    // 只在离屏烘焙档开启「沿长度分段着色」。mid 档是烘焙失败时的
    // 每帧兜底路径，发丝数翻倍会直接拖垮帧率，所以那里保持单段。
    split: !low && !mid,
    sheen: style.sheen || { x: 72, y: 54, r: 52 }
  })

  // 发束分隔暗线：让一束一束的结构看得出来。
  //
  // **只给「发束」画，不给「卷簇 / 发茬」画。**
  // 分隔线是给 10~20 条长发的束与束之间加一道暗缝用的。
  // 卷发的 locks 里有 210 个卷簇，如果一视同仁，就等于在整头卷发上
  // 再叠 210 条 tone=-0.9 的暗线 —— 屏幕上是糊成一片的黑，
  // 也就是「卷发整体过暗、层次不足」。发茬（寸头）同理。
  const sepSrc = locks.filter(function (l) { return !l.tuft })
  const sep = low || mid ? [] : E.lockSeparators(sepSrc, rng, { samples: 11, width: 1.5 })

  let edge = []
  const FACE = { cx: 100, cy: 118, rx: 50, ry: 64 }
  for (let i = 0; i < outline.length; i++) {
    edge = edge.concat(E.edgeStrands(outline[i], rng, {
      perSegment: low ? 5 : 7,
      step: low ? 6 : 2,
      per: low ? 1 : mid ? 2 : 5,
      lenMin: 2,
      lenMax: low ? 5 : 11,
      tone: 0.24,
      face: FACE
    }))
  }

  // 飞发要短、要细、要少：长而粗的飞发在屏幕上就是一根根针，
  // 反而比没有飞发更假。真实飞发只在边缘冒一点点头。
  const fly = low || mid
    ? []
    : E.flyaways(outline[0], rng, { count: 18, lenMin: 5, lenMax: 13, face: FACE })

  let geom = {
    outline: outline,
    body: body,
    sep: sep,
    edge: edge,
    fly: fly,
    sheen: style.sheen || { x: 72, y: 54, r: 52, a: 0.2 },
    // 发块底色的提亮量（见 paint 第 2 层）。默认 0 = 老行为。
    // 只有「发丝盖不住发块」的款式才需要它：卷发的卷簇之间有大量缝隙，
    // 缝隙里露出的是发块底色，底色压得太暗就是一块一块的黑洞。
    fillLift: style.fillLift || 0
  }

  /* ---- 水平比例归一化 ----
   * 人脸在虚拟画布里固定是 100 宽（rx=50）。但各发型的设计稿宽度
   * 从 121 到 185 不等，如果直接按同一个倍数映射到真人脸上，
   * 圆寸会窄到连脸两侧都盖不住、大波浪又会宽得离谱。
   * 这里按 style.fit（发型宽 / 脸宽 的设计目标）把水平方向
   * 绕脸心 x=100 缩放到目标宽度，纵向不动 —— 纵向的脸心位置
   * 和各发型的长短设计本来就是对的。
   */
  const fitTarget = (style.fit || 1.3) * 100
  let bx0 = Infinity
  let bx1 = -Infinity
  for (let i = 0; i < body.length; i++) {
    const pts = body[i].pts
    for (let k = 0; k < pts.length; k++) {
      if (pts[k].x < bx0) bx0 = pts[k].x
      if (pts[k].x > bx1) bx1 = pts[k].x
    }
  }
  const curW = bx1 - bx0
  if (curW > 1 && Math.abs(curW - fitTarget) > 0.5) {
    const sx = fitTarget / curW
    const fitPt = function (p) { p.x = 100 + (p.x - 100) * sx }
    for (let i = 0; i < body.length; i++) {
      const pts = body[i].pts
      for (let k = 0; k < pts.length; k++) fitPt(pts[k])
    }
    for (let i = 0; i < sep.length; i++) {
      const pts = sep[i].pts
      for (let k = 0; k < pts.length; k++) fitPt(pts[k])
    }
    for (let i = 0; i < edge.length; i++) {
      const pts = edge[i].pts
      for (let k = 0; k < pts.length; k++) fitPt(pts[k])
    }
    for (let i = 0; i < fly.length; i++) {
      const pts = fly[i].pts
      for (let k = 0; k < pts.length; k++) fitPt(pts[k])
    }
    geom.outline = outline.map(function (ops) {
      return ops.map(function (op) {
        if (op[0] === 'M' || op[0] === 'L') return [op[0], 100 + (op[1] - 100) * sx, op[2]]
        if (op[0] === 'C') {
          return [op[0],
            100 + (op[1] - 100) * sx, op[2],
            100 + (op[3] - 100) * sx, op[4],
            100 + (op[5] - 100) * sx, op[6]]
        }
        return op
      })
    })
    if (geom.sheen) geom.sheen = {
      x: 100 + (geom.sheen.x - 100) * sx,
      y: geom.sheen.y,
      r: geom.sheen.r * sx,
      a: geom.sheen.a
    }
  }

  geomCache[key] = geom
  if (detail === 'high') {
    GEOM_ORDER.push(key)
    while (GEOM_ORDER.length > GEOM_HIGH_MAX) {
      const old = GEOM_ORDER.shift()
      delete geomCache[old]
    }
  }
  return geom
}

/**
 * 主动释放某款发型的 high 精度几何。
 * 烘焙结束后调用 —— 位图已经生成，几何数据只是占内存。
 */
function releaseGeom(styleId, detail) {
  const key = styleId + '@' + (detail || 'high')
  if (geomCache[key]) {
    delete geomCache[key]
    const i = GEOM_ORDER.indexOf(key)
    if (i >= 0) GEOM_ORDER.splice(i, 1)
  }
}

/* ---------------- Canvas 渲染 ---------------- */

function tracePath(ctx, ops) {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const t = op[0]
    if (t === 'M') ctx.moveTo(op[1], op[2])
    else if (t === 'L') ctx.lineTo(op[1], op[2])
    else if (t === 'C') ctx.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6])
    else if (t === 'Z') ctx.closePath()
  }
}

/**
 * 把一批发丝按色调分桶，每桶合并成一条路径一次填充。
 * 150 条发丝如果逐条 fill 就是 150 次绘制调用，分桶后只需 12~14 次，
 * 这是实时性能的关键。
 */
/**
 * 把发丝按 tone 分桶，并预先算好每个桶的 Path2D。
 *
 * 这是换发色的快路径：分桶结果和 Path2D 只跟发型有关，
 * 跟颜色无关。换色时直接用缓存里的 Path2D 填新色，
 * 省掉「遍历 600 条发丝 + 每条做一次多边形展开」的开销。
 *
 * @returns {{keys:number[], paths:Object, tones:Object}}
 */
function bucketize(strands, buckets) {
  const groups = {}
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i]
    let lvl = Math.round(((s.tone + 1) / 2) * (buckets - 1))
    if (lvl < 0) lvl = 0
    if (lvl > buckets - 1) lvl = buckets - 1
    if (!groups[lvl]) groups[lvl] = []
    groups[lvl].push(s)
  }
  const keys = []
  for (const k in groups) keys.push(Number(k))
  keys.sort(function (a, b) { return a - b })

  const paths = {}
  const tones = {}
  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki]
    tones[k] = (k / (buckets - 1)) * 2 - 1
    const list = groups[k]
    let path = null
    try {
      path = new Path2D()
    } catch (e) {
      path = null
    }
    if (path) {
      for (let i = 0; i < list.length; i++) {
        const poly = E.polygon(list[i])
        path.moveTo(poly[0][0], poly[0][1])
        for (let j = 1; j < poly.length; j++) path.lineTo(poly[j][0], poly[j][1])
        path.closePath()
      }
      paths[k] = path
    } else {
      // 没有 Path2D 的老环境：退回存原始发丝列表
      paths[k] = list
    }
  }
  return { keys: keys, paths: paths, tones: tones }
}

function fillStrands(ctx, strands, ramp, buckets) {
  const groups = {}
  for (let i = 0; i < strands.length; i++) {
    const s = strands[i]
    let lvl = Math.round(((s.tone + 1) / 2) * (buckets - 1))
    if (lvl < 0) lvl = 0
    if (lvl > buckets - 1) lvl = buckets - 1
    if (!groups[lvl]) groups[lvl] = []
    groups[lvl].push(s)
  }
  const keys = []
  for (const k in groups) keys.push(Number(k))
  keys.sort(function (a, b) { return a - b })

  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki]
    const tone = (k / (buckets - 1)) * 2 - 1
    const color = E.toneColor(ramp, tone)
    const list = groups[k]
    ctx.beginPath()
    for (let i = 0; i < list.length; i++) {
      const poly = E.polygon(list[i])
      ctx.moveTo(poly[0][0], poly[0][1])
      for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1])
      ctx.closePath()
    }
    ctx.fillStyle = color
    ctx.fill()
  }
}

/**
 * 用预分桶的 Path2D 填色（换色快路径）。
 * 没有 Path2D 时退化成 fillStrands。
 */
function fillBuckets(ctx, bucket, ramp) {
  if (!bucket || !bucket.keys) {
    return false
  }
  for (let ki = 0; ki < bucket.keys.length; ki++) {
    const k = bucket.keys[ki]
    const p = bucket.paths[k]
    if (p instanceof Path2D) {
      ctx.fillStyle = E.toneColor(ramp, bucket.tones[k])
      ctx.fill(p)
    } else {
      ctx.beginPath()
      for (let i = 0; i < p.length; i++) {
        const poly = E.polygon(p[i])
        ctx.moveTo(poly[0][0], poly[0][1])
        for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1])
        ctx.closePath()
      }
      ctx.fillStyle = E.toneColor(ramp, bucket.tones[k])
      ctx.fill()
    }
  }
  return true
}

/**
 * 主绘制：在已建立好 200x240 坐标系的 ctx 上画一款发型。
 * 层次（由后到前）：
 *   1 投影  2 发块渐变  3 主体发丝  4 光泽  5 边缘破碎发丝  6 飞发
 */
function paint(ctx, geom, ramp, detail, buckets) {
  const low = detail === 'low'
  // buckets：可选的预分桶缓存（{body, sep, edge}），
  // 由 getBaked 的换色快路径传入。传了就跳过发丝遍历与多边形展开。
  const B = buckets || null

  /* --- 0. 发型投在脸上的阴影 ---
     没有这层，头发看起来是"贴"在照片上而不是"盖"在头上。
     做法是标准技巧：把形状本体推出画布外，只留下它的影子落在原位；
     再把影子裁进脸部椭圆里，这样只会暗在额头和脸颊上，不会糊到背景。

     **这里曾经写反过，是全项目最难查的一个 bug（第 52 轮）。**
     原来的代码是「形状留在原地、shadowOffsetX = 6000」——
     影子被推到 6000px 之外（等于没有影子），而**形状本体**被
     fillStyle='#000' 实心填了一遍。因为外面套着「脸部椭圆」的 clip，
     填出来的是一块「椭圆 ∩ 发块」的纯黑区域：屏幕上就是横贯前额、
     下边缘刀切一样齐的一条黑带。它比发块底色还黑，所以调 tone、
     调 fillLift、加发际线碎发全都没用 —— 那些都在它下面一层。
     正确写法是把 ctx 平移 -6000，让形状自己出去，
     再由 shadowOffsetX = +6000 把影子拉回原位。

     **blur 必须远大于 offsetY。**
     原来 blur 只有 7、alpha 0.62，而 outline 的内轮廓（挖空脸的那条边）
     正好落在发际线上 —— 模糊不够时，影子在发际线下面摊成一条
     又窄又实的黑边，等于给刘海画了一道黑描边。
     真实的投影是从发际线往下**渐隐**的，所以 blur 拉到 17，
     同时把 alpha 压到 0.30 —— 峰值变浅、范围变宽，才像光被挡住而不是画了条线。 */
  if (!low) {
    ctx.save()
    ctx.beginPath()
    ctx.save()
    ctx.translate(100, 118)
    ctx.scale(52, 66)
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.restore()
    ctx.clip()
    // 形状本体推到画布外，影子靠 offset 拉回来
    ctx.translate(-6000, 0)
    ctx.shadowColor = 'rgba(0,0,0,0.30)'
    ctx.shadowBlur = 17
    ctx.shadowOffsetX = 6000
    ctx.shadowOffsetY = 3
    ctx.fillStyle = '#000'
    for (let i = 0; i < geom.outline.length; i++) {
      ctx.beginPath()
      tracePath(ctx, geom.outline[i])
      ctx.fill()
    }
    ctx.restore()
  }

  /* --- 1. 底层投影：把发型从脸上"托"起来 ---
     **必须裁掉脸部椭圆。**
     这里 fill 的 outline 是「外轮廓 + 挖空脸」的复合路径，而 shadow 是不认
     洞的：blur 9 + offsetY 4 会让刘海下沿的影子直接漏进洞里，
     在额头上摊成一条几乎不透明的暗带（ramp.shadow 的 alpha 是 1）。
     屏幕上就是发际线下面那道硬黑边 —— 用洋红探针可以确认它不是底色、
     不是发丝、也不是第 0 步的柔光阴影，而是这一层。
     脸上的投影已经由第 0 步负责，所以这一层用 evenodd 裁掉整张脸，
     只保留轮廓外圈（背景、脖子、头发外沿）的落影。 */
  if (!low) {
    ctx.save()
    ctx.beginPath()
    // 不用 ctx.rect：老版本基础库的 CanvasContext 上没有这个方法，
    // 缺了它会直接抛异常，整块头发都画不出来。
    ctx.moveTo(0, 0)
    ctx.lineTo(VIEW_W, 0)
    ctx.lineTo(VIEW_W, VIEW_H)
    ctx.lineTo(0, VIEW_H)
    ctx.closePath()
    ctx.save()
    ctx.translate(100, 118)
    ctx.scale(52, 66)
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.restore()
    ctx.clip('evenodd')

    ctx.shadowColor = 'rgba(0,0,0,0.52)'
    ctx.shadowBlur = 9
    ctx.shadowOffsetY = 4
    ctx.fillStyle = ramp.shadow
    for (let i = 0; i < geom.outline.length; i++) {
      ctx.beginPath()
      tracePath(ctx, geom.outline[i])
      ctx.fill()
    }
    ctx.restore()
  }

  /* --- 2. 发块渐变：填住发丝之间的空隙，定整体明暗 ---
     必须压暗，它是"底"，亮度由上面的发丝负责。
     底越暗，发丝缝隙才越像真实头发的暗谷。

     用**径向**而不是垂直渐变。原来是一条 0→240 的竖直线性渐变，
     等于假设"越靠下越暗"；但头是个球，受光只跟"离光源多远"有关。
     线性渐变的结果是整块头发从头到尾只有一条横向的明暗带，
     配上同样从上往下流的发丝，两者方向一致、互相淹没 ——
     远看就是一块均匀的深色，也就是截图里那种「黑碗扣在头上」。
     径向渐变让头顶亮、两侧和后颈暗，和发丝自带的高光位置对得上，
     立体感才出得来。 */
  ctx.save()
  const shp = geom.sheen || { x: 76, y: 58, r: 60 }
  // 发块底色整体提亮量。默认 0，只有显式声明的款式（卷发）才抬。
  // 它解决的是「发丝覆盖率不够」这一类款式：卷簇是散点撒的，
  // 卷与卷之间必然有缝，缝里露出的就是这层底色。
  // 底色按 -0.06 压暗时，一条 12 单位高的缝在屏幕上就是一条黑带。
  const lift = geom.fillLift || 0
  const g = ctx.createRadialGradient(shp.x, shp.y, shp.r * 0.12, shp.x, shp.y, shp.r * 2.5)
  // 注意：lift 越大，外圈（远离光源的头顶两侧/后颈）抬得越多。
  // 原来外圈只抬 lift*0.35，对黑发几乎无感 —— 发丝缝里露出的还是 shadow
  // （≈纯黑），于是整头只有发丝本身亮、缝里全黑，屏幕上读作「死黑一块没层次」。
  // 改成外圈也抬满 lift，缝里变成 deep 而不是 shadow，卷簇之间的暗部才立得住。
  g.addColorStop(0, E.shade(ramp.base, -0.06 + lift))
  g.addColorStop(0.42, E.shade(ramp.base, -0.22 + lift * 0.85))
  g.addColorStop(0.78, E.shade(ramp.base, -0.40 + lift * 0.7))
  g.addColorStop(1, E.shade(ramp.shadow, lift))
  ctx.fillStyle = g
  for (let i = 0; i < geom.outline.length; i++) {
    ctx.beginPath()
    tracePath(ctx, geom.outline[i])
    ctx.fill()
  }
  ctx.restore()

  /* --- 3. 主体发丝 --- */
  if (B && B.body) fillBuckets(ctx, B.body, ramp)
  else fillStrands(ctx, geom.body, ramp, low ? 10 : 15)

  /* --- 4. 光泽：裁剪在发块内，用径向渐变模拟镜面反射 ---
     高光已经主要由发丝的 spec 项承担，这里只做一层柔和的补充，
     加太多会把深色头发冲成灰白。 */
  ctx.save()
  ctx.beginPath()
  for (let i = 0; i < geom.outline.length; i++) tracePath(ctx, geom.outline[i])
  ctx.clip()

  const sh = geom.sheen
  const sa = sh.a * 0.5
  const rg = ctx.createRadialGradient(sh.x, sh.y, 0, sh.x, sh.y, sh.r)
  rg.addColorStop(0, E.rgba(ramp.sheen, sa))
  rg.addColorStop(0.45, E.rgba(ramp.sheen, sa * 0.38))
  rg.addColorStop(1, E.rgba(ramp.sheen, 0))
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)

  // 第二处弱高光，打破单一光源的死板
  const rg2 = ctx.createRadialGradient(sh.x + 34, sh.y + 26, 0, sh.x + 34, sh.y + 26, sh.r * 0.7)
  rg2.addColorStop(0, E.rgba(ramp.sheen, sa * 0.42))
  rg2.addColorStop(1, E.rgba(ramp.sheen, 0))
  ctx.fillStyle = rg2
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  ctx.restore()

  /* --- 5. 发束分隔暗线：放在光泽之后，否则会被加法混合冲淡 --- */
  if (geom.sep && geom.sep.length) {
    ctx.save()
    ctx.globalAlpha = 0.55
    if (B && B.sep) fillBuckets(ctx, B.sep, ramp)
    else fillStrands(ctx, geom.sep, ramp, 3)
    ctx.restore()
  }

  /* --- 6. 边缘破碎发丝：消除矢量硬边 --- */
  if (geom.edge.length) {
    if (B && B.edge) fillBuckets(ctx, B.edge, ramp)
    else fillStrands(ctx, geom.edge, ramp, 8)
  }

  /* --- 7. 飞发：少量高亮细丝，增加"活"的感觉 --- */
  if (geom.fly.length) {
    ctx.save()
    ctx.globalAlpha = 0.7
    fillStrands(ctx, geom.fly, ramp, 6)
    ctx.restore()
  }
}

/* ---------------- 离屏烘焙 ---------------- */

// 真机 dpr 通常 3，头部盒子在 canvas 像素里可能宽达 900px。
// 烘焙太小会被放大糊掉，所以取 3 倍（600x720），
// 桌面实测烘焙 23~54ms，真机大约 2~4 倍。
// 早期只留 2 张，实测用户浏览 10 款发型时命中率 0% ——
// 每切一款都要重新烘焙，卡顿感非常明显。
// 现在按「当前发型 + 左右相邻两款」预热，覆盖用户左右滑动的路径；
// 缓存上限放到 6 张（约 10MB），低端机也能接受。
const BAKE_SCALE = 3.0
const bakeCache = {}
const BAKE_ORDER = []
// 每张离屏画布 600x720 RGBA = 1.65MB。
// 常驻位图叠加 camera + VKSession 之后，在低端 Android 机上会把
// 小程序推向被系统回收 —— 用户看到的就是「切几款发型后自己重启」。
// 配合 onHide 时 clearBakeCache 释放，试戴页内留 5 张（8.2MB）。
// 实测 LRU 命中率（prewarm 当前 + 左右邻）：
//   MAX=4 -> 徘徊 64% / 聚焦 67%
//   MAX=5 -> 徘徊 79% / 聚焦 79%   ← 收益饱和点
//   MAX=6 -> 徘徊 82% / 聚焦 79%   ← 多 1.7MB 只换来 3%
//   MAX=8+ 无进一步提升
const BAKE_MAX = 5
// 烘焙失败后不再每帧重试，否则会退化成每帧全量绘制（约 40ms/帧）
let bakeUnavailable = false

/**
 * 低内存状态（由 wx.onMemoryWarning 驱动）。
 *
 * 告警到来时**最不能做的事就是重新烘焙**：一张离屏画布 1.65MB，
 * 而告警的含义正是「现在连 1.65MB 都拿不出来了」。真机上表现为
 * 告警之后画面卡住 200~400ms（重建 3 张），紧接着被系统回收 ——
 * 用户看到的是「切了两款发型，小程序自己没了」。
 *
 * 置位后：getBaked 直接返回 null（退回矢量直绘，上层已有 25fps 节流兜住），
 * prewarm 变空操作。画面还在、还能换发型，只是精度降一档 ——
 * 这比被系统杀掉好得多。
 */
let lowMemory = false

function hasOffscreen() {
  return typeof wx !== 'undefined' && typeof wx.createOffscreenCanvas === 'function'
}

/**
 * 当前是否处于「降级绘制」状态（没有离屏画布，每帧都要走矢量直绘）。
 *
 * 这个判断要给上层用：降级路径单帧要发 4 万多次 canvas 调用
 * （实测 paint mid 43,923 次），在低端机上单帧就能吃掉 40ms 以上，
 * 把 UI 线程堵死 —— 表现为拖动滑块、点按钮全都没反应。
 * 上层据此做帧率上限，宁可少几帧也不要堵住交互。
 */
function isDegraded() {
  // lowMemory 必须算进来。告警后 getBaked 返回 null，绘制**实际上**
  // 已经退回矢量直绘了；如果这里还报 false，上层第 16 轮加的 25fps
  // 节流就不会生效 —— 结果是「内存最紧张的设备，每帧发 4 万次 canvas 调用」，
  // UI 线程被彻底堵死，正好在最需要它响应的时候。
  return bakeUnavailable || lowMemory || !hasOffscreen()
}

/**
 * 把发型预烘焙到离屏画布。之后每帧只需 drawImage，
 * 实时预览才能稳住帧率（否则 600 条发丝每帧重绘会掉到 20fps 以下）。
 */
/* ---- 换色快路径 ----
 * 曾经想用「tone 编码进 RGB 通道的索引图」让换发色不重绘，
 * 实测走不通：canvas 的半透明像素会做 alpha 预乘，
 * 编码位被乘掉后反推出来的 tone 完全错，
 * 30 组对比里最大通道差 88（buzz/honey），整张图颜色都是花的。
 *
 * 真正可行的快路径是「按发型缓存分桶后的路径，换色只重填色」：
 * fillStrands 已经把发丝按 tone 分成了 15 个桶，每个桶一条 path。
 * 把每条 path 缓存下来，换色时只需要改 15 次 fillStyle 再 fill，
 * 不需要重新遍历 600 条发丝、不需要重新做多边形展开。
 */
const bucketCache = {}
const BUCKET_ORDER = []
const BUCKET_MAX = 4

/**
 * 取（或生成）某款发型的预分桶路径。
 * 只跟发型有关，与颜色无关，所以可以跨发色复用。
 */
function getBuckets(styleId) {
  const key = styleId
  if (bucketCache[key]) return bucketCache[key]
  if (typeof Path2D === 'undefined') return null

  const style = getStyle(styleId)
  const geom = getGeom(style, 'high')
  let b
  try {
    b = {
      body: bucketize(geom.body, 15),
      sep: geom.sep && geom.sep.length ? bucketize(geom.sep, 3) : null,
      edge: geom.edge.length ? bucketize(geom.edge, 8) : null
    }
  } catch (e) {
    return null
  }
  bucketCache[key] = b
  BUCKET_ORDER.push(key)
  while (BUCKET_ORDER.length > BUCKET_MAX) {
    const old = BUCKET_ORDER.shift()
    delete bucketCache[old]
  }
  return b
}

function getBaked(styleId, colorId, detail) {
  if (detail === 'low' || bakeUnavailable || lowMemory) return null
  const key = styleId + '|' + colorId
  if (bakeCache[key]) return bakeCache[key]
  if (!hasOffscreen()) {
    bakeUnavailable = true
    return null
  }

  // 快路径：同发型的分桶路径已生成过，换色只需重填色。
  // 省掉「遍历全部发丝 + 每条做一次多边形展开」——
  // 实测那两步占整个烘焙的六成以上。
  const buckets = getBuckets(styleId)
  if (buckets) {
    const style = getStyle(styleId)
    const color = getColor(colorId)
    const geom = getGeom(style, 'high')
    let canvas
    let ctx
    try {
      canvas = wx.createOffscreenCanvas({ type: '2d', width: Math.round(VIEW_W * BAKE_SCALE), height: Math.round(VIEW_H * BAKE_SCALE) })
      ctx = canvas.getContext('2d')
    } catch (e) {
      bakeUnavailable = true
      return null
    }
    if (ctx) {
      try {
        ctx.scale(BAKE_SCALE, BAKE_SCALE)
        paint(ctx, geom, color.ramp, 'high', buckets)
        // 位图已生成，2.2MB 的几何数据没人再引用，立刻还回去
        releaseGeom(styleId, 'high')
        bakeCache[key] = canvas
        BAKE_ORDER.push(key)
        while (BAKE_ORDER.length > BAKE_MAX) {
          const old = BAKE_ORDER.shift()
          delete bakeCache[old]
        }
        return canvas
      } catch (e) {
        bakeUnavailable = true
        return null
      }
    }
  }

  const W = Math.round(VIEW_W * BAKE_SCALE)
  const H = Math.round(VIEW_H * BAKE_SCALE)
  let canvas
  let ctx
  try {
    canvas = wx.createOffscreenCanvas({ type: '2d', width: W, height: H })
    ctx = canvas.getContext('2d')
  } catch (e) {
    bakeUnavailable = true
    return null
  }
  if (!ctx) {
    bakeUnavailable = true
    return null
  }

  const style = getStyle(styleId)
  const color = getColor(colorId)
  const geom = getGeom(style, 'high')

  try {
    ctx.scale(BAKE_SCALE, BAKE_SCALE)
    paint(ctx, geom, color.ramp, 'high')
    releaseGeom(styleId, 'high')
  } catch (e) {
    bakeUnavailable = true
    return null
  }

  bakeCache[key] = canvas
  BAKE_ORDER.push(key)
  while (BAKE_ORDER.length > BAKE_MAX) {
    const old = BAKE_ORDER.shift()
    delete bakeCache[old]
  }
  return canvas
}

/**
 * 预热：提前把发型烘焙好。
 *
 * 除了当前发型，还把左右相邻两款一起烘焙 —— 用户在发型横滑里
 * 最自然的操作就是点左右邻款，提前准备好相邻两款，
 * 滑动过程中就一次都不会卡（实测只留 2 张缓存时命中率 0%）。
 *
 * 预热是同步的，单次几十毫秒；放在 setData 回调里执行，
 * 此时选中态已经画出来了，用户感知不到这几十毫秒。
 */
function prewarm(styleId, colorId) {
  // 低内存时预热是纯反向操作：花掉本就紧张的内存，去换「之后可能更顺」，
  // 而系统很可能在这几十毫秒里就把进程收掉
  if (lowMemory) return
  getBaked(styleId, colorId, 'high')

  // 相邻两款：索引 ±1（循环）
  const list = HAIR_STYLES
  let idx = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === styleId) { idx = i; break }
  }
  if (idx < 0) return
  const prev = list[(idx - 1 + list.length) % list.length]
  const next = list[(idx + 1) % list.length]
  if (prev) getBaked(prev.id, colorId, 'high')
  if (next) getBaked(next.id, colorId, 'high')
}

/**
 * 释放全部离屏烘焙缓存。
 *
 * 调用时机：用户离开试戴页（onHide / onUnload）。缓存是纯加速用的，
 * 离开页面后留着没有任何收益，却要占着 1.65MB x N 的位图内存 ——
 * 在低端机上这就是把小程序推向被系统回收的最后一根稻草。
 *
 * 回到页面时 prewarm 会重建，用户最多感知一次几十毫秒的烘焙。
 */
function clearBakeCache() {
  for (const k in bakeCache) delete bakeCache[k]
  BAKE_ORDER.length = 0
  // 分桶路径（Path2D）也要一起清。
  // 之前只清 bakeCache，bucketCache 里最多 4 款 × 26 条 Path2D
  // 还留在内存里 —— 每条 path 背后是几百个贝塞尔段的点阵，
  // 实测 4 款约占 6MB。既然调用方的意图是「把加速缓存全还回去」，
  // 只还一半等于没还。
  for (const k in bucketCache) delete bucketCache[k]
  BUCKET_ORDER.length = 0
}

/**
 * 进入 / 退出低内存模式。
 * 进入时会顺带清空全部加速缓存 —— 既然已经告警了，先把能还的还掉。
 */
function setLowMemory(flag) {
  lowMemory = !!flag
  if (lowMemory) clearBakeCache()
}

function isLowMemory() {
  return lowMemory
}

/**
 * 在 canvas 上绘制一款发型
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,w:number,h:number,angle:number}} box 目标矩形（canvas 像素）
 * @param {string} styleId
 * @param {string} colorId
 * @param {number} alpha 整体不透明度
 */
function drawHair(ctx, box, styleId, colorId, alpha) {
  const a = typeof alpha === 'number' ? alpha : 1
  if (a <= 0.001) return

  ctx.save()
  if (box.angle) {
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    ctx.translate(cx, cy)
    ctx.rotate(box.angle)
    ctx.translate(-cx, -cy)
  }
  // 镜像不是只把脸框挪到另一边：不对称发型（马尾、侧分）本身也必须反向。
  // 放在旋转之后，效果等同把当前预览造型整体照一次镜子；
  // 离屏烘焙仍可复用，不需要为正反各存一张位图。
  if (box.mirror) {
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    ctx.translate(cx, cy)
    ctx.scale(-1, 1)
    ctx.translate(-cx, -cy)
  }
  ctx.globalAlpha = a

  // 优先走烘焙位图
  const baked = getBaked(styleId, colorId, 'high')
  if (baked) {
    ctx.drawImage(baked, box.x, box.y, box.w, box.h)
    ctx.restore()
    return
  }

  // 降级：直接矢量绘制。用 mid 精度而不是 high ——
  // 这条路径每帧都要跑，high 精度 600 条发丝会掉到 20fps 以下。
  const style = getStyle(styleId)
  const color = getColor(colorId)
  const geom = getGeom(style, 'mid')
  ctx.translate(box.x, box.y)
  ctx.scale(box.w / VIEW_W, box.h / VIEW_H)
  paint(ctx, geom, color.ramp, 'mid')
  ctx.restore()
}

/* ---------------- SVG 缩略图 ---------------- */

function svgBody(geom, ramp, gid, prec) {
  let s = ''

  // 发块
  for (let i = 0; i < geom.outline.length; i++) {
    s += '<path d="' + E.opsToD(geom.outline[i], prec) + '" fill="url(#' + gid + ')"/>'
  }

  // 发丝：按色调分桶，每桶一条 path（多段子路径合并），显著省字节
  const buckets = 9
  const groups = {}
  const all = geom.body.concat(geom.edge)
  for (let i = 0; i < all.length; i++) {
    const st = all[i]
    let lvl = Math.round(((st.tone + 1) / 2) * (buckets - 1))
    if (lvl < 0) lvl = 0
    if (lvl > buckets - 1) lvl = buckets - 1
    if (!groups[lvl]) groups[lvl] = ''
    groups[lvl] += E.polyToD(E.polygon(st), prec)
  }
  for (const k in groups) {
    const tone = (Number(k) / (buckets - 1)) * 2 - 1
    s += '<path d="' + groups[k] + '" fill="' + E.toneColor(ramp, tone) + '"/>'
  }

  // 发束分隔暗线
  if (geom.sep && geom.sep.length) {
    let d = ''
    for (let i = 0; i < geom.sep.length; i++) d += E.polyToD(E.polygon(geom.sep[i]), prec)
    s += '<path d="' + d + '" fill="' + ramp.shadow + '" opacity="0.55"/>'
  }
  return s
}

/**
 * 生成发型的 SVG 字符串。
 * detail='low' 供缩略图（小体积），detail='high' 供调试与截图检查。
 */
function buildSvg(styleId, colorId, detail) {
  const style = getStyle(styleId)
  const color = getColor(colorId)
  const ramp = color.ramp
  const geom = getGeom(style, detail === 'high' ? 'high' : 'low')
  const gid = 'g' + style.id
  const sid = 's' + style.id
  const sh = geom.sheen
  const prec = detail === 'high' ? 1 : 0

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" width="200" height="240">' +
    '<defs>' +
    '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + E.shade(ramp.base, -0.32) + '"/>' +
    '<stop offset="0.35" stop-color="' + E.shade(ramp.base, -0.18) + '"/>' +
    '<stop offset="0.72" stop-color="' + E.shade(ramp.base, -0.30) + '"/>' +
    '<stop offset="1" stop-color="' + ramp.shadow + '"/>' +
    '</linearGradient>' +
    '<radialGradient id="' + sid + '">' +
    '<stop offset="0" stop-color="' + ramp.sheen + '" stop-opacity="' + (sh.a * 0.5) + '"/>' +
    '<stop offset="0.5" stop-color="' + ramp.sheen + '" stop-opacity="' + (sh.a * 0.18) + '"/>' +
    '<stop offset="1" stop-color="' + ramp.sheen + '" stop-opacity="0"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<ellipse cx="100" cy="118" rx="57" ry="73" fill="#c8ab93" opacity="0.11"/>' +
    svgBody(geom, ramp, gid, prec) +
    '<ellipse cx="' + sh.x + '" cy="' + sh.y + '" rx="' + sh.r + '" ry="' + (sh.r * 0.8) +
    '" fill="url(#' + sid + ')"/>' +
    '</svg>'
  )
}

/**
 * 生成发型缩略图（data URI），可直接给 <image src> 使用。
 * 走低精度几何，控制在 10KB 以内，避免 WXML 数据膨胀。
 */
/* 缩略图缓存。
 * 首页和试戴页都要生成缩略图，两个页面重复生成同样的 10 张，
 * 而且每次 onLoad 都重来一遍。缩略图只跟 (styleId, colorId) 有关，
 * 缓存到模块级变量里，跨页面、跨 onLoad 复用。
 * 实测单张生成 1.5~2ms，10 张约 18ms —— 本身不致命，
 * 但 setData 要跨线程传 50KB 字符串，重复传同样的内容纯属浪费。
 */
const thumbCache = {}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 把纯 ASCII 字符串编成 base64。
 *
 * 小程序里没有 btoa，`wx.arrayBufferToBase64` 又要先转 ArrayBuffer。
 * SVG 缩略图里全是 ASCII（数字、字母、#、引号），一个字符就是一个字节，
 * 直接按 charCode 分三字节处理最快，也省掉一次全量数组分配。
 */
function base64Ascii(str) {
  let out = ''
  const n = str.length
  for (let i = 0; i < n; i += 3) {
    const c1 = str.charCodeAt(i)
    const c2 = i + 1 < n ? str.charCodeAt(i + 1) : -1
    const c3 = i + 2 < n ? str.charCodeAt(i + 2) : -1
    out += B64_CHARS[c1 >> 2]
    if (c2 < 0) {
      out += B64_CHARS[(c1 & 3) << 4] + '=='
      break
    }
    out += B64_CHARS[((c1 & 3) << 4) | (c2 >> 4)]
    if (c3 < 0) {
      out += B64_CHARS[(c2 & 15) << 2] + '='
      break
    }
    out += B64_CHARS[((c2 & 15) << 2) | (c3 >> 6)]
    out += B64_CHARS[c3 & 63]
  }
  return out
}

/**
 * 生成缩略图 data URI。
 *
 * **必须是 base64，不能用 encodeURIComponent。**
 * 微信小程序的 <image> 只认 base64 形态的 data URI；
 * `data:image/svg+xml;charset=utf-8,<url-encoded>` 这种在真机上
 * 大概率是一片空白（WebView 里能显示，原生 image 组件不解析）。
 * 而所有发型缩略图 —— 首页热门、发型库、试戴页横滑条、我的收藏 ——
 * 全都走这个函数。真机上「整个 App 一张图都不显示」的代价，
 * 不值得为省那 33% 体积去赌。
 *
 * base64 比 URL 编码大约 33%（2.8KB -> 3.8KB），10 张多 10KB，
 * 相对于它解决的问题可以忽略。
 */
function buildThumb(styleId, colorId) {
  const key = styleId + '|' + colorId
  const hit = thumbCache[key]
  if (hit) return hit
  const svg = buildSvg(styleId, colorId, 'low')
  // 兜底：万一以后 SVG 里出现中文（比如把发型名画进图里），
  // 按 ASCII 编出来的就是错的字节。这里退回 UTF-8 百分号编码再转字节。
  const uri = /[^\x00-\x7F]/.test(svg)
    ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    : 'data:image/svg+xml;base64,' + base64Ascii(svg)
  thumbCache[key] = uri
  return uri
}

module.exports = {
  VIEW_W: VIEW_W,
  VIEW_H: VIEW_H,
  HAIR_STYLES: HAIR_STYLES,
  HAIR_COLORS: HAIR_COLORS,
  getStyle: getStyle,
  getColor: getColor,
  hasStyle: hasStyle,
  hasColor: hasColor,
  getGeom: getGeom,
  prewarm: prewarm,
  clearBakeCache: clearBakeCache,
  setLowMemory: setLowMemory,
  isLowMemory: isLowMemory,
  isDegraded: isDegraded,
  drawHair: drawHair,
  buildThumb: buildThumb,
  buildSvg: buildSvg,
  // 测试用：索引图烘焙/上色链路必须能在 canvas 里逐像素比对，
  // 否则换发色后色偏了也发现不了。
  _engine: E,
  _paint: paint,
  _fillStrands: fillStrands,
  _bucketize: bucketize,
  _getBuckets: getBuckets,
  _fillBuckets: fillBuckets
}
