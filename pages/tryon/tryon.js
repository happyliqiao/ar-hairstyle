const hairstyles = require('../../utils/hairstyles')
const store = require('../../utils/store')
const faceFit = require('../../utils/face-fit')
const match = require('../../utils/match')
const swipe = require('../../utils/swipe-guard')
const nav = require('../../utils/nav')
const privacy = require('../../utils/privacy')

// 换算逻辑在 utils/face-fit.js，测试台直接测同一份代码
const HEAD_W_RATIO = faceFit.HEAD_W_RATIO
const HEAD_CY_RATIO = faceFit.HEAD_CY_RATIO
const BOX_ASPECT = faceFit.BOX_ASPECT
const FACE_ASPECT = 128 / faceFit.FACE_W

/**
 * 对齐后取景框自动淡出的时长。
 *
 * 框的职责是「把脸引进构图区」，引到位之后它就只剩干扰。
 * 但也不能一直不显示 —— 用户稍微一动就偏了，没有参照他不知道偏了。
 * 3 秒是「摆好姿势后不会马上大幅移动」的经验值：
 * 更短会让框反复出现，更长等于没退场。
 */
const GUIDE_FADE_MS = 3000

/**
 * 自动匹配的时序。
 *
 * 对齐之后不能立刻换发型：用户刚把头摆正，画面里突然换一顶头发，
 * 第一反应是「它自己乱动」。等 600ms 让他先看清当前画面，再换。
 * 脸型估计器需要连续几帧正脸才敢下结论，所以最多重试 4 次；
 * 4 次都测不出来就**先不吭声，但继续等**（用户摆正脸之后照样会匹配），
 * 不硬猜，也不永久关闭 —— 见 maybeRecommend / scheduleRecRetry。
 */
const REC_SETTLE_MS = 600
const REC_RETRY_MS = 700
const REC_MAX_RETRY = 4
/** 肤色采样最多等多久；超时就只给发型推荐，不阻塞流程 */
const SKIN_TIMEOUT_MS = 1600
/**
 * 肤色采样最多试几轮、失败后隔多久再试。
 *
 * 采样会失败：暗光、逆光、脸偏出框、戴大框眼镜，都会让 144 个采样点
 * 一个都过不了肤色规则。原来一次采不到就收工（`_skinStarted` 已置位），
 * 这一半的核心功能（发色匹配）对整次会话永久消失。
 * 现在最多试 3 轮，间隔 2.5 秒 —— 用户往窗边挪两步就够补救了。
 */
const SKIN_MAX_TRIES = 3
const SKIN_RETRY_MS = 2500
/**
 * 推荐卡片展开多久后自动收起。
 *
 * 卡片是贴在底部面板上方的，展开时会把面板顶高 ~150pt，
 * 正好盖住取景框下沿（下巴那一段）。所以它不能常驻：
 * 7 秒够读完三行字，之后收成一行小条，面板回到原来的高度。
 * 用户任何操作（拖画面、选款、选色）都会让它立刻收起 ——
 * 正在动手的人不需要再读说明。
 */
const REC_CARD_MS = 7000

/**
 * toast 该显示多久。
 *
 * 原来固定 1800ms。这个数字对「已收藏」够了（3 个字，一眼看完），
 * 但「已保存，清理最早 2 条旧记录」有 14 个字 —— 中文阅读速度大约
 * 每秒 5~8 字，1.8 秒刚读到一半就消失了。用户只看到有东西弹出来，
 * 没看到它说了什么，而这偏偏是唯一告诉他「你的旧记录被删了」的通道。
 *
 * 按字数算：4 字以内保持 1800（短消息不需要拖），之后每多一个字加 160ms，
 * 封顶 4000。封顶是为了不让一句超长文案把屏幕糊住太久 ——
 * 真要讲清楚的事应该用 showModal，不是拉长 toast。
 */
function toastDuration(msg) {
  const n = typeof msg === 'string' ? Array.from(msg).length : 0
  if (n <= 4) return 1800
  const d = 1800 + (n - 4) * 160
  return d > 4000 ? 4000 : d
}

/**
 * 把人脸框换算成 0~1 归一化坐标（相对摄像头原始帧）。
 *
 * 基础库两种给法都存在：像素坐标、或 0~1 归一化。这里统一成归一化，
 * 因为肤色采样要在原始帧 buffer 里定位，用像素还是归一化都无所谓，
 * 但两套代码各写一遍必然会漂。
 */
function anchorRect(anchor, frame) {
  const o = anchor && anchor.origin
  const s = anchor && anchor.size
  if (!o || !s || !(s.width > 0) || !(s.height > 0)) return null
  if (typeof o.x !== 'number' || typeof o.y !== 'number') return null

  let x = o.x
  let y = o.y
  let w = s.width
  let h = s.height

  const normalized = Math.abs(x) <= 1.5 && Math.abs(y) <= 1.5 && w <= 1.5
  if (!normalized) {
    if (!frame || !frame.w || !frame.h) return null
    x /= frame.w
    y /= frame.h
    w /= frame.w
    h /= frame.h
  }
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null
  return { x: x, y: y, w: w, h: h }
}

function nowWindowInfo() {
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo()
    return wx.getSystemInfoSync()
  } catch (e) {
    return { statusBarHeight: 20, pixelRatio: 2, safeArea: null }
  }
}

/** 把「可能是数字、可能是字符串、可能缺失」的尺寸字段归一成数字，取不到返回 null */
function numOf(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && isFinite(n) ? n : null
}

Page({
  data: {
    // 顶部栏的安全起点：胶囊底边 + 8。用 statusBarHeight 会让
    // 右侧的「切换摄像头」按钮正好压在胶囊底下点不到。
    statusBarHeight: 56,
    safeBottom: 0,

    cameraReady: false,
    cameraMsg: '相机未开启',
    // 隐私授权弹窗。从分享卡片直接进本页的人没经过首页，
    // 那条路径上没有机会提前问，只能在这里拦。
    privacyOn: false,
    privacyContract: '',
    // 横滑条的定位锚点。只在 onLoad 设一次 —— 见 wxml 里的说明。
    stripAnchor: '',
    colorAnchor: '',
    devicePosition: 'front',

    faceFound: false,
    // 用户是否主动微调过。没识到脸又没主动调时，不画发型。
    manualOn: false,
    // 取景引导框（人脸验证式）。框固定不动，用户主动把头移进去。
    //   show  是否显示（画布尺寸算出来之后才有）
    //   state idle | aligning | locked —— 决定框的颜色和粗细
    //   hint  方向提示：「靠近一点 · 往左一点」
    // 注意：它不是「虚拟头型」。虚拟头型是在框里画一个假人冒充效果，
    // 已经被删掉；这里只是一条参考线，本身不代表任何发型效果。
    //   hidden 对齐满 3 秒后置 true，框淡出；一偏离立刻回来
    guide: { show: false, cx: 0, cy: 0, w: 0, h: 0, state: 'idle', hint: '', hidden: false },
    // 自动识脸这条路彻底走不通（微信版本没有 VKSession / 创建失败 /
    // 启动返回错误码）。这种情况下要露出「手动定位」入口，
    // 而不是留一句「可拖动微调」让用户对着一片空画面猜。
    arUnavailable: false,
    statusText: '正在启动…',
    isDevtools: false,

    styles: [],
    colors: [],
    currentStyle: 'bob',
    currentStyleName: '波波头',
    currentTag: '气质干练',
    currentColor: 'chestnut',
    currentColorName: '栗棕',

    adjustMode: false,
    sizeVal: 100,
    yVal: 46,
    rotVal: 0,
    mirrorX: true,

    isFav: false,
    shooting: false,
    showInfo: false,
    info: { name: '', en: '', tag: '', face: '', desc: '' },
    toast: '',

    // 自动匹配结果。这是产品的核心功能，也是唯一会「自己动手」的地方，
    // 所以每一层都写清楚：测到了什么、推了什么、为什么。
    //   shape       round | oval | long
    //   auto        true = 已经自动换上去了；false = 只推荐，等用户点
    //   skinBusy    肤色还在测（发色那一行显示「正在测肤色…」）
    rec: {
      show: false,
      shape: '',
      shapeLabel: '',
      // 脸型落在两条边界之间（置信度 0.6）：标签会变成「接近标准」，
      // 页面上也要说一句「在边界上」，不能报成 100% 肯定的结论
      shapeUnsure: false,
      styleId: '',
      styleName: '',
      reason: '',
      // 同档也合适的备选（含第一名，最多 3 个），供「换一款」轮换
      alt: [],
      colorId: '',
      colorName: '',
      colorReason: '',
      skinLabel: '',
      colorUnsure: false,
      auto: false,
      // 推荐款就是当前款：不是「换上了」，是「本来就合适」
      same: false,
      // 展开 / 收起。展开是完整卡片，收起是一行小条
      expanded: false,
      // 用户点过 ×：不再自动改动发型/发色，但结论留着（小条还能点开）
      declined: false,
      skinBusy: false
    },

    // 首次使用引导（只在相机就绪且从没看过时打开）
    guideOn: false
  },

  /* ==================== 生命周期 ==================== */

  onLoad(options) {
    // 页面生命周期标志。所有异步回调（定时器 / VKSession / 图片导出）
    // 执行前都要检查，避免往已销毁的页面写数据或持有相机资源。
    this._alive = true
    // 横滑误触判定状态（发型列表 / 发色列表各一份）
    this._stripSwipe = swipe.create()
    this._colorSwipe = swipe.create()
    // 从转发卡片进来（带 style/color 参数）：给接收者一次明确引导。
    // 他没见过这个界面，不知道要把脸放进画面才有反应，
    // 常常对着空镜头等半天，以为小程序坏了。
    this._fromShare = !!(options && (options.style || options.color))
    const win = nowWindowInfo()
    // 这里必须逐个字段校验「是数字」，不能只判断对象存在。
    // PC 端 / 折叠屏分屏 / 部分鸿蒙机型的 safeArea 只有 top/left/right/height，
    // 没有 bottom；老代码 safeArea && screenHeight 判真后拿 undefined 相减，
    // 结果是 NaN，写进 wxml 就变成 style="padding-bottom: NaNpx" —— 整条声明失效，
    // 底部操作栏直接贴到屏幕边缘、和 tabBar 重叠。
    const safeBottom = numOf(win.screenHeight) !== null && win.safeArea && numOf(win.safeArea.bottom) !== null
      ? Math.max(0, numOf(win.screenHeight) - numOf(win.safeArea.bottom))
      : 0

    // 开发者工具模拟器没有摄像头，用参考头型代替，便于确认渲染效果
    let isDevtools = false
    try {
      const sys = wx.getSystemInfoSync()
      isDevtools = sys.platform === 'devtools'
    } catch (e) {}

    // 先解析 URL 参数（发型 / 发色），再构建底部缩略图列表 ——
    // 缩略图必须用「当前发色」而不是固定的黑色，否则用户从发型库
    // 选了蜜茶棕进来，底部 10 张卡片却全是黑发，观感上像没选中。
    // 优先级：URL 参数 > 上次用的 > 默认款。
    //
    // 「上次用的」这一层是理发店的真实场景：顾客昨天试了 mohawk，
    // 今天回来还想再看一眼，或者发型师说「就按你上次看中那款剪」。
    // 每次跳回写死的 bob，等于让他每次重新找一遍。
    //
    // **三处都必须用 hasStyle/hasColor 判存在性，不能用 getStyle 的返回值。**
    // getStyle 对认不出的 id 一律回落 HAIR_STYLES[0]，所以
    // `if (!picked) return` 这种写法永远不会生效 —— 一个已下架的 id
    // 会被静默换成 bob，用户明明点的是「大波浪」那一款。
    const last = store.getLastPick()

    // 「用户是不是已经明确表过态」决定自动匹配能不能动他当前的选择。
    // 三种表态：URL 里带了款（从发型库/分享点进来）、上次用过、本次已手动选。
    // 只要有一种成立，就只推荐不替换 —— 用户点了「大波浪」，进来却变成
    // 「背头」，那叫功能失控，不叫智能。
    this._explicitStyle = !!(options && hairstyles.hasStyle(options.style))
    this._explicitColor = !!(options && hairstyles.hasColor(options.color))
    // 只有「他自己在款式条上点的」才算表态。
    // 推荐卡上的「换成这款 / 换一款」也是他点的，但那是**接受 AI 给的答案**，
    // 不是「别自动匹配了」。原来两者都写进 last pick，于是最配合的那批用户
    // （认真读了卡片、还点了按钮）第二次进来就再也拿不到自动匹配，
    // 而完全无视卡片的用户每次都有 —— 激励正好反了。
    this._hasLastPick = last.by !== 'rec' &&
      (hairstyles.hasStyle(last.style) || hairstyles.hasColor(last.color))
    this._userPickedStyle = false
    this._userPickedColor = false

    let styleId = hairstyles.hasStyle(last.style) ? last.style : 'bob'
    if (options && hairstyles.hasStyle(options.style)) {
      styleId = options.style
    }
    const style = hairstyles.getStyle(styleId)

    let colorId = hairstyles.hasColor(last.color) ? last.color : 'chestnut'
    if (options && hairstyles.hasColor(options.color)) {
      colorId = options.color
    }
    const color = hairstyles.getColor(colorId)

    const styles = []
    for (let i = 0; i < hairstyles.HAIR_STYLES.length; i++) {
      const s = hairstyles.HAIR_STYLES[i]
      styles.push({
        id: s.id,
        name: s.name,
        thumb: hairstyles.buildThumb(s.id, colorId)
      })
    }

    this.sizeVal = 100
    this.yVal = 46
    this.rotVal = 0
    this.dragDX = 0
    this.dragDY = 0
    this.trackedBox = null
    this.trackedAngle = 0
    this.calibration = store.getCalibration()
    this.frameSize = null
    // 脸型估计器：跨帧统计，不能每帧新建
    this._shape = match.createShapeEstimator()
    // 自动匹配只做一次。用户看过结论之后，无论他接不接受，
    // 都不再自动动手 —— 否则每次重新对齐都换一顶头发，像坏了。
    this._recDone = false
    this._recTimer = null
    this._recTries = 0
    // 微调期间到达的推荐先挂起，收起微调再算
    this._recPending = false
    // 最近一次 anchor 的归一化人脸框，肤色采样要用它定位脸颊
    this._faceRect = null
    // 肤色采样：成功一次就不再采；失败（暗光/脸偏）最多重试 SKIN_MAX_TRIES 轮
    this._skinStarted = false
    this._skinTries = 0
    this._skinRetryTimer = null
    // 前置镜像偏好要单独记住。切到后置必须临时关镜像，
    // 但不能把用户原来的选择覆盖掉。
    this._frontMirror = this.data.mirrorX

    this.setData({
      statusBarHeight: nav.topPad(8),
      safeBottom: safeBottom,
      isDevtools: isDevtools,
      statusText: isDevtools ? '模拟器无摄像头 · 用真机预览' : '正在启动…',
      styles: styles,
      colors: hairstyles.HAIR_COLORS,
      currentStyle: styleId,
      // 让横滑条滚到选中项。发型库 10 款、发色 12 个，
      // 从收藏/分享进来时选中的往往是第 8、9 位，默认停在最左边
      // 等于「画面上是马尾，底部高亮着波波头」。
      stripAnchor: 'st-' + styleId,
      colorAnchor: 'cl-' + colorId,
      currentStyleName: style.name,
      currentTag: style.tag,
      currentColor: color.id,
      currentColorName: color.name,
      isFav: store.isFavorite(styleId)
    })
  },

  onReady() {
    this.initCanvas()
    this.ensureCamera()
  },

  onUnload() {
    // 标记页面已销毁。所有延迟回调（定时器、VKSession.start 回调、
    // canvasToTempFilePath 回调）在执行前都要看这个标志，
    // 否则会在一个不存在的页面上 createVKSession / setData：
    // 真机上表现为退出试戴页后相机仍然发热、再次进入黑屏。
    this._alive = false
    // 必须清掉所有挂起的定时器。之前只停了识脸和帧监听，
    // switchTimer / switchTimer2 / toastTimer 仍在跑，
    // 页面销毁后它们触发 setData 会往一个已经不存在的页面写数据，
    // 真机上表现为「返回后偶尔闪一下 / 控制台报 setData 警告」。
    // 注：switchTimer2 目前是预留字段（没有任何地方再创建它），
    // 清理逻辑保留作为防御，成本为零。
    if (this.switchTimer) {
      clearTimeout(this.switchTimer)
      this.switchTimer = null
    }
    if (this.switchTimer2) {
      clearTimeout(this.switchTimer2)
      this.switchTimer2 = null
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    // openCamera 的 500ms 启动定时器
    if (this.openTimer) {
      clearTimeout(this.openTimer)
      this.openTimer = null
    }
    // probeFrameSize 的 4 秒兜底定时器此前没有存 id，onUnload 清不掉，
    // 退出后它仍会触发 startTracking -> createVKSession，白占相机资源。
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
    // 分享接收者的引导提示定时器
    if (this._hintTimer) {
      clearTimeout(this._hintTimer)
      this._hintTimer = null
    }
    // 换色后重建缩略图的防抖定时器
    if (this._thumbTimer) {
      clearTimeout(this._thumbTimer)
      this._thumbTimer = null
    }
    // 快门看门狗
    this.disarmShootWatchdog()
    // 失脸宽限期的重绘定时器。回调里已经检查了 _alive，不清也不会写坏
    // 页面；但它会白白把整个 page 对象多留 2.5 秒，顺手清掉。
    if (this._lostTimer) {
      clearTimeout(this._lostTimer)
      this._lostTimer = null
    }
    // 取景框自动淡出的定时器
    if (this._guideFadeTimer) {
      clearTimeout(this._guideFadeTimer)
      this._guideFadeTimer = null
    }
    // 自动匹配的等待/重试定时器。回调里都有 _alive 检查，
    // 但不清掉会让页面对象多活几百毫秒，还会在退出后多跑一轮推荐。
    if (this._recTimer) {
      clearTimeout(this._recTimer)
      this._recTimer = null
    }
    // 肤色采样的超时定时器
    if (this._skinTimer) {
      clearTimeout(this._skinTimer)
      this._skinTimer = null
    }
    // 撞上快门而延后的肤色应用
    if (this._skinApplyTimer) {
      clearTimeout(this._skinApplyTimer)
      this._skinApplyTimer = null
    }
    // 肤色采样失败后的重试
    if (this._skinRetryTimer) {
      clearTimeout(this._skinRetryTimer)
      this._skinRetryTimer = null
    }
    // 推荐卡片的自动收起
    if (this._recCollapseTimer) {
      clearTimeout(this._recCollapseTimer)
      this._recCollapseTimer = null
    }
    this.teardown()
    // 页面销毁：连烘焙缓存一起放掉，不留任何位图给下一个页面
    hairstyles.clearBakeCache()
    // 常亮是全局状态，页面没了也必须关（onHide 不一定总会先跑）
    this.setKeepOn(false)
  },

  onHide() {
    // 页面切走时停止识脸，省电；相机由框架自行挂起
    this.stopTracking()
    this.stopFrameProbe()
    // 常亮是全局状态，切走必须关：不关的话用户回到首页、进记录页，
    // 手机都不会自动熄屏，一下午白白耗电
    this.setKeepOn(false)
    // 释放离屏烘焙缓存。每张 1.65MB，4 张就是 6.6MB ——
    // 用户去记录页看一眼再回来，这些缓存全程白占着内存，
    // 低端机上足以把小程序推向被系统回收（表现为自己重启）。
    hairstyles.clearBakeCache()

    // 如果刚才有新版本下载好了、但用户正在调发型，更新提示被挂起了。
    // 现在他已经离开这一页，正是问的时候。
    try {
      const app = getApp()
      if (app && typeof app.flushUpdate === 'function') app.flushUpdate()
    } catch (e) {}
  },

  /**
   * 系统内存告警（由 app.js 的 onMemoryWarning 转发）。
   *
   * 缓存已经在 App 层清掉了，这里只做页面该做的事：
   * 停掉预热、把当前画面按降级路径重画一帧。
   * 不重画的话 canvas 上还贴着上一帧的位图 —— 看着正常，
   * 但那一帧是靠已经被释放的离屏画布画的，下一次 setData 重排
   * 就会变成一片空白，用户会以为发型消失了。
   */
  onMemoryLow(level) {
    if (!this._alive) return
    this._lowMem = true
    console.warn('[tryon] 内存告警 level=' + level + '，绘制降级')
    this.render(true)
  },

  onShow() {
    // 上一次在前台时收到过内存告警 → 现在回到前台，说明中间离开过
    // （onHide 已经清空了烘焙缓存），系统大概率腾出了空间，解除降级。
    // 如果内存仍然紧张，系统会再发一次告警，我们再降级 ——
    // 每次进出最多多试一次烘焙，不会来回抖。
    //
    // 判断里必须带上 isLowMemory()：告警可能发生在**别的页面**上
    // （记录页翻照片同样吃内存），那时本页实例根本不存在，
    // this._lowMem 永远是 undefined。只认自己的标志位的话，
    // 用户下次进试戴页会一直停在降级画质，直到重启小程序。
    if (this._lowMem || hairstyles.isLowMemory()) {
      this._lowMem = false
      hairstyles.setLowMemory(false)
    }
    // 回前台先核对一次相机权限，再做其它恢复动作。
    // 顺序很重要：之前是「先 startTracking 再 recheck」，
    // 结果是权限刚被撤销的那一刻，代码会先对着一个断流的 camera
    // 建出一个 VKSession，紧接着又被 recheck 销毁 ——
    // 白建白毁，真机上还会在控制台打一串 start 失败。
    //
    // 用户很可能就是「切出去到系统设置把相机权限关掉再切回来」：
    // 此时 camera 组件还挂在树上、cameraReady 仍为 true，
    // 但流已经断了，画面停在最后一帧，状态栏还写着「已锁定人脸」，
    // 用户会以为是小程序卡死，怎么晃脸都没反应。
    const self = this
    const wasReady = this.data.cameraReady
    this.recheckCamera(function () {
      if (!self._alive) return
      // 从其它页面返回时恢复识脸。
      // 注意：必须重新探测 frameSize —— switchCamera 会把它清空，
      // 而 onHide 只停了帧监听、没清 frameSize，
      // 于是「切摄像头 → 进记录页 → 返回」之后 frameSize 是 null，
      // anchorToBox 会拿屏幕尺寸当帧尺寸，识脸坐标整体算错，
      // 发型会飘到画面外。这个路径在模拟器里永远走不到。
      if (self.data.cameraReady && !self.vkSession) {
        if (!self.frameSize) self.probeFrameSize()
        self.startTracking()
      }
      // onHide 清掉了烘焙缓存，回来先把当前发型重新烘焙好，
      // 否则第一帧要走全量绘制（约 40ms），用户会看到一次明显卡顿。
      // 只在「本来就在正常用」时做：如果是这次 onShow 才刚把相机
      // 打开（wasReady=false），画面还没就绪，prewarm 白做一遍。
      if (self.data.cameraReady && wasReady) {
        // onHide 关掉了常亮，回到前台要重新打开
        self.setKeepOn(true)
        hairstyles.prewarm(self.data.currentStyle, self.data.currentColor)
        // 主动画一帧。识脸要等下一个 anchor 才触发 render，
        // 而用户把脸移出画面时可能几秒都没有 anchor ——
        // 这段时间画布是空的，看起来像「发型没了」。
        self.render(true)
      }
    })
  },

  /** 回到前台时核对相机权限，处理「使用中被系统/用户撤销」。done 一定会被调用一次 */
  recheckCamera(done) {
    const self = this
    let finished = false
    function finish() {
      if (finished) return
      finished = true
      if (typeof done === 'function') done()
    }
    wx.getSetting({
      success(res) {
        if (!self._alive) {
          finish()
          return
        }
        const auth = res.authSetting['scope.camera']
        if (auth === false) {
          // 权限被关掉：停掉一切吃相机的东西，把界面切回引导态。
          // 不能只改文案 —— VKSession 还在的话会持续向一个断流的
          // camera 要帧，真机上表现为发热 + 每帧都失败重试。
          self.teardown()
          // 相机没了，常亮也要关 —— 否则用户切到设置页关了权限回来，
          // 画面是黑的，屏幕却一直亮着
          self.setKeepOn(false)
          if (self.data.cameraReady || self.data.faceFound) {
            self.setData({
              cameraReady: false,
              cameraMsg: '相机权限已被关闭',
              faceFound: false,
              statusText: '相机未开启'
            })
          }
        } else if (auth === true && !self.data.cameraReady) {
          // 用户在设置里重新打开了权限，别让他再点一次按钮
          self.openCamera()
        }
        finish()
      },
      fail() {
        finish()
      }
    })
  },

  stopFrameProbe() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
    if (this.frameListener && this.frameListener.stop) {
      try {
        this.frameListener.stop()
      } catch (e) {}
    }
    this.frameListener = null
  },

  stopTracking() {
    if (this.vkSession) {
      try {
        this.vkSession.destroy()
      } catch (e) {}
      this.vkSession = null
    }
    this.trackedBox = null
    this.trackedAngle = 0
    this._activeFace = null
    this._faceChallenger = null
  },

  teardown() {
    this.stopFrameProbe()
    this.stopTracking()
  },

  /**
   * 解除「拍照冻结」。
   *
   * 拍照时会把发型框冻结在按下快门那一刻（boxFrozen），避免合成期间
   * 识脸继续更新导致照片里外位置不一致。**每一条「这次拍照没走通」的
   * 路径都必须调它** —— 漏一条的后果不是「这次没拍成」，而是：
   * 冻结标志一直为 true，render 永远用那个静止的 frozenBox，
   * 用户怎么动脸、怎么拖发型都不跟手，画面像卡死了一样，
   * 而且他完全不知道要退出重进才能恢复。
   */
  unfreezeBox() {
    this.boxFrozen = false
    this.frozenBox = null
  },

  /**
   * 屏幕常亮。
   *
   * 试戴时用户把手机举在面前对着镜子看效果，两只手都不在屏幕上 ——
   * iOS 默认 30 秒、部分安卓 15 秒就自动熄屏。画面一黑，
   * 用户的第一反应是「小程序崩了」，而不是「屏幕睡了」。
   * 店里这种「举着看十几秒」的用法，不常亮基本没法用。
   *
   * 两个必须注意的点：
   *   1. setKeepScreenOn 是**全局**状态，不是页面级。离开试戴页不关掉，
   *      整个小程序（首页、记录页）都不熄屏，一下午能把电耗掉一截。
   *      所以 onHide / onUnload 都要显式关。
   *   2. 只在相机真的起来之后才开。用户可能只是点进来看看、相机还没授权，
   *      这时候常亮纯属白耗电。
   */
  setKeepOn(on) {
    const want = !!on
    if (this._keepOn === want) return
    this._keepOn = want
    try {
      wx.setKeepScreenOn({
        keepScreenOn: want,
        fail() {
          // 部分定制环境 / 开发者工具不支持，静默忽略
        }
      })
    } catch (e) {}
  },

  /* ==================== 画布 ==================== */

  initCanvas() {
    const self = this
    const query = wx.createSelectorQuery().in(this)
    query.select('#hairCanvas').fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) {
        console.warn('[tryon] 画布节点未取到')
        return
      }
      const canvas = res[0].node
      const ctx = canvas.getContext('2d')
      // dpr 封顶 2，不是直接用屏幕的 3。
      //
      // 画布内容只有一个来源：600×720 的烘焙位图，drawImage 铺到
      // box.w × box.h（约 300×360 CSS px）。也就是说在 dpr=2 时
      // 目标正好是 600×720，已经 1:1 像素对齐；再往上到 dpr=3，
      // 目标变成 900×1080，多出来的全是插值 —— 画质一点没涨，
      // 内存却从 390×844×4×2.25 ≈ 5.3MB 涨到 11.8MB，
      // 填充率也是 2.25 倍。低端机上这一项就够把帧率打下来。
      const dpr = Math.min(nowWindowInfo().pixelRatio || 2, 2)

      canvas.width = res[0].width * dpr
      canvas.height = res[0].height * dpr
      ctx.scale(dpr, dpr)

      self.canvas = canvas
      self.ctx = ctx
      self.cw = res[0].width
      self.ch = res[0].height

      // 取景框的几何只从 face-fit 算一次，wxml 直接用这些 px 值画。
      // 判定和绘制共用同一份数值，才不会出现「框套住了脸却说没对齐」。
      const gf = faceFit.guideFrame(self.cw, self.ch)
      if (gf) {
        self.setData({
          guide: {
            show: true,
            cx: gf.cx,
            cy: gf.cy,
            w: gf.w,
            h: gf.h,
            state: 'idle',
            hint: ''
          }
        })
      }

      self.render(true)
    })
  },

  /* ==================== 相机 ==================== */

  /**
   * 打开相机前的两道门，顺序不能反：
   *
   *   1) **隐私协议**。没同意时微信直接拦住 `<camera>`，且
   *      `getSetting` 里 `scope.camera` 仍然是 true —— 先查 scope
   *      会一路放行，然后用户盯着黑屏。所以隐私必须查在前面。
   *   2) 相机 scope。这是常规的系统权限，被拒了可以引导去设置里开。
   */
  ensureCamera() {
    const self = this
    privacy.check(function (need, contractName) {
      if (!self._alive) return
      if (need) {
        self.setData({
          cameraReady: false,
          cameraMsg: '需要先同意隐私协议',
          privacyOn: true,
          privacyContract: contractName,
          statusText: '等待隐私授权'
        })
        return
      }
      self.checkCameraScope()
    })
  },

  checkCameraScope() {
    const self = this
    wx.getSetting({
      success(res) {
        if (!self._alive) return
        const auth = res.authSetting['scope.camera']
        if (auth === false) {
          self.setData({ cameraReady: false, cameraMsg: '相机权限未开启' })
          return
        }
        self.openCamera()
      },
      fail() {
        if (!self._alive) return
        self.openCamera()
      }
    })
  },

  /** 用户点了「同意并继续」：关掉弹窗，重新走一遍开门流程 */
  onPrivacyAgree() {
    this.setData({ privacyOn: false, privacyContract: '' })
    this.checkCameraScope()
  },

  onPrivacyCancel() {
    this.setData({ privacyOn: false, privacyContract: '' })
    // 试戴页离了相机什么都做不了，直接退回首页 ——
    // 留在这里只有一个黑屏和一句「需要先同意隐私协议」，
    // 用户点无可点。
    nav.back('/pages/index/index')
  },

  openCamera() {
    const self = this
    this.setData({ cameraReady: true, statusText: '正在启动相机…' })
    // 500ms 内用户可能已经返回退出。存字段以便 onUnload 清理，
    // 并在回调里挡住已销毁的页面——否则 afterCameraReady 会继续
    // 注册帧监听、起 4 秒兜底定时器，onUnload 已经跑完就再没人清它们。
    this.openTimer = setTimeout(function () {
      self.openTimer = null
      if (!self._alive) return
      self.afterCameraReady()
    }, 500)
  },

  requestCamera() {
    const self = this
    // 「开启相机」按钮也得先过隐私这一关。否则用户点了，wx.authorize
    // 返回成功（scope 本来就是开的），openCamera 起一个黑屏，
    // 兜一圈回到原地说「相机启动失败」—— 点多少次都一样。
    privacy.check(function (need, contractName) {
      if (!self._alive) return
      if (need) {
        self.setData({ privacyOn: true, privacyContract: contractName })
        return
      }
      self.doRequestCamera()
    })
  },

  doRequestCamera() {
    const self = this
    wx.authorize({
      scope: 'scope.camera',
      success() {
        self.openCamera()
      },
      fail() {
        wx.showModal({
          title: '需要相机权限',
          content: '开启摄像头后，才能在镜子里实时看到换发型的效果。请到设置里打开相机权限。',
          confirmText: '去设置',
          cancelText: '暂不',
          success(r) {
            if (r.confirm) {
              wx.openSetting({
                success(res) {
                  if (res.authSetting['scope.camera']) self.openCamera()
                }
              })
            }
          }
        })
      }
    })
  },

  onCameraError(e) {
    if (!this._alive) return
    const detail = e && e.detail
    console.warn('[tryon] 相机异常', detail)

    // 相机挂了就没必要继续常亮；帧监听和 VKSession 也必须一起停，
    // 否则它们还会持续向断流的相机要帧，发热并刷错误日志。
    this.setKeepOn(false)
    this.teardown()

    // 隐私协议被拦。这时说「相机启动失败」是误导 ——
    // 用户会去系统设置里翻相机权限，那里明明是开着的，
    // 翻完回来还是黑屏，只能卸载。
    if (privacy.isPrivacyError(detail)) {
      this.setData({
        cameraReady: false,
        cameraMsg: '需要先同意隐私协议',
        statusText: '等待隐私授权',
        privacyOn: true
      })
      return
    }

    this.setData({
      cameraReady: false,
      cameraMsg: '相机启动失败',
      statusText: '相机不可用'
    })
  },

  afterCameraReady() {
    // 相机流已经起来了，从这里开始屏幕不该熄
    this.setKeepOn(true)
    // 第一次来的人：相机画面 + 一个发型 + 一排控件，
    // 没有任何一行字告诉他「要把脸放进画面」「可以左右滑」「可以拖」。
    // 引导放在相机就绪之后，因为「把脸放进画面」这句话
    // 得先有画面才有意义。
    if (!store.hasSeenGuide()) this.setData({ guideOn: true })
    if (this.data.isDevtools) return
    if (this.frameSize) {
      this.startTracking()
      this.hintShareEntry()
      return
    }
    // 等帧尺寸就绪再启动识脸。之前是「启动探测 + 立刻启动识脸」，
    // 前几帧 anchorToBox 拿屏幕尺寸当帧尺寸，发型会先飘一下再跳回来。
    const self = this
    this.probeFrameSize(function () {
      // 1200ms 内用户可能又切了摄像头，此时 frameSize 属于新摄像头，
      // 但 devicePosition 已变；重新判断一次，避免用旧尺寸启动。
      if (self.frameSize) self.startTracking()
      self.hintShareEntry()
    })
  },

  /** 关闭新手指引。点遮罩或点按钮都走这里 */
  closeGuide() {
    if (!this.data.guideOn) return
    store.markGuideSeen()
    this.setData({ guideOn: false })
  },

  /** 分享接收者的首次引导，只提示一次 */
  hintShareEntry() {
    if (!this._fromShare) return
    this._fromShare = false
    const self = this
    // 相机刚起来时用户还在找手机位置，晚一点再提示更容易被看到。
    // 必须存字段：onUnload 要能清掉它，否则退出后回调仍会跑
    // setData/showToast，往一个不存在的页面写数据。
    this._hintTimer = setTimeout(function () {
      self._hintTimer = null
      if (!self._alive) return
      if (self.data.faceFound) return
      self.showToast('把头放进虚线框，就能看到这款发型')
    }, 1200)
  },

  /** 读取摄像头画面尺寸，用于把识脸坐标换算到屏幕坐标 */
  probeFrameSize(onReady) {
    const self = this
    if (this.frameListener) return
    const epoch = this._cameraEpoch || 0
    try {
      const camCtx = wx.createCameraContext()
      this.camCtx = camCtx
      if (!camCtx.onCameraFrame) return
      this.frameListener = camCtx.onCameraFrame(function (frame) {
        // 旧摄像头已经切换，迟到的帧不能覆盖新摄像头的尺寸，
        // 否则发型会按旧比例换算，整头偏到一边。
        if (epoch !== (self._cameraEpoch || 0) || !self._alive) return
        if (!self.frameSize && frame && frame.width && frame.height) {
          self.frameSize = { w: frame.width, h: frame.height }
          // 拿到尺寸就停监听并通知等待方。
          // 原来是死等 4 秒超时，期间 startTracking 已经用 null 的
          // frameSize 跑起来了，发型会飘到画面外；
          // 而且用户切摄像头后要干等最多 4 秒才有识脸。
          self.stopFrameProbe()
          if (onReady) {
            const cb = onReady
            onReady = null
            cb()
          }
        }
      })
      // 兜底超时：个别机型 onCameraFrame 不回调
      this.probeTimer = setTimeout(function () {
        self.probeTimer = null
        if (self.frameListener) {
          self.stopFrameProbe()
          if (onReady) {
            const cb = onReady
            onReady = null
            cb()
          }
        }
      }, 4000)
    } catch (e) {
      console.warn('[tryon] 取帧尺寸失败', e)
      if (onReady) {
        const cb = onReady
        onReady = null
        cb()
      }
    }
  },

  /* ==================== 人脸追踪 ==================== */

  startTracking() {
    const self = this

    // 页面已销毁（用户在 4 秒兜底定时器触发前退出了试戴页）：
    // 绝不能再 createVKSession，否则相机资源被一个死页面占着不放，
    // 真机上表现为退出后相机仍发热、再次进入黑屏。
    if (!this._alive) return

    // 幂等：onShow 会主动重启识脸，openCamera 的 500ms 定时器回调
    // 也会经 afterCameraReady 再启动一次。两条路径在「进入后立刻
    // 切走再返回」时会撞车，建出两个 VKSession 同时收 anchor，
    // 发型会跳。已有 session 就直接返回。
    if (this.vkSession) return

    if (this.data.isDevtools) {
      this.setData({ statusText: '模拟器预览 · 用真机看 AR' })
      return
    }

    if (!wx.createVKSession) {
      // 旧版微信（或部分定制系统）根本没有 VKSession。
      // 以前这里只把文案改成「可拖动微调」，画布却是空的 ——
      // 用户既不知道能拖，也不知道拖了会出现什么。
      // 现在改为「如实告知 + 给一个手动定位的按钮」。
      this.setData({ arUnavailable: true, statusText: '这台设备不支持自动识脸' })
      return
    }

    let session
    try {
      session = wx.createVKSession({
        track: { face: { mode: 1 } },
        version: 'v2'
      })
    } catch (e) {
      console.warn('[tryon] createVKSession 失败', e)
      this.setData({ arUnavailable: true, statusText: '自动识脸没能启动' })
      return
    }

    if (!session || typeof session.on !== 'function') {
      this.setData({ arUnavailable: true, statusText: '自动识脸没能启动' })
      return
    }

    this.vkSession = session

    session.on('updateAnchors', function (anchors) {
      const anchor = self.pickFaceAnchor(anchors)
      if (anchor) self.onFaceAnchor(anchor)
    })

    session.on('removeAnchors', function () {
      // 不再立即清空 trackedBox。识脸是逐帧的，用户转头、被手挡一下、
      // 或者有人从画面里走过，都会瞬时丢锚点 —— 立即清空会让发型
      // 猛地跳回屏幕中央默认位置再跳回来，看起来就是「抖了一下」。
      // 改为打时间戳，computeBox 在超过 TRACK_KEEP_MS 之后才回退默认位置。
      // 状态提示仍然立刻告诉用户「把脸放进框里」，反馈不丢。
      self.trackedLostAt = Date.now()
      // 丢脸时对齐状态必须一起复位。否则框还停在 locked 的淡色上，
      // 提示也停在「已对齐」，用户把脸拿开了页面却还在说对齐成功。
      self._align = null
      if (self.data.faceFound) {
        self.setData({
          faceFound: false,
          statusText: '把脸放进框里',
          guide: Object.assign({}, self.data.guide, { state: 'idle', hint: '', hidden: false })
        })
        self.render(true)
      }
      // 宽限期结束要主动重绘一次，否则画面停在失脸前的发型上，
      // 看起来像识脸一直成功。没有主动微调时这一帧会把发型清掉。
      if (self._lostTimer) clearTimeout(self._lostTimer)
      self._lostTimer = setTimeout(function () {
        self._lostTimer = null
        if (self._alive) self.render(true)
      }, 2500)
    })

    session.start(function (errno) {
      if (errno) {
        console.warn('[tryon] VKSession.start 返回错误', errno)
        // 启动失败要把 session 放掉。否则 this.vkSession 一直非空，
        // onShow 的幂等检查会直接返回，用户这一页再也拿不到自动识脸，
        // 只能手动拖发型——而他其实只是碰上一次相机还没就绪。
        self.stopTracking()
        self.setData({ arUnavailable: true, statusText: '自动识脸没能启动' })
        return
      }
      self.setData({ arUnavailable: false, statusText: '正在寻找人脸…' })
    })
  },

  /**
   * 进入手动定位。
   *
   * 自动识脸不可用时，这是唯一能让用户看到东西的路径，所以必须是一个
   * 用户看得见、点得到的动作，不能靠「他碰巧拖了一下画面」。
   * 进入后文案明确写「手动」，不冒充 AR —— 否则用户会以为识脸在工作，
   * 转头发现发型不跟着动，只会觉得产品坏了。
   *
   * 拖动画面、拉微调滑块都走这里，保证三条入口的行为和文案完全一致。
   * 识脸正常时不进入手动模式：发型本来就跟着脸，再加个「手动定位中」
   * 只会让人以为自己把自动追踪关掉了。
   */
  enterManual() {
    if (this.data.manualOn) return
    if (this.data.faceFound) return
    this.setData({
      manualOn: true,
      statusText: '手动定位 · 拖动对齐发际线，双击复位'
    })
    this.render(true)
  },

  pickFaceAnchor(anchors) {
    if (!anchors || !anchors.length) return null
    // 默认取最大脸（离镜头最近），但不能每帧无条件换目标：
    // 店员从旁边走过时只要有一帧脸更大，发型就会跳到店员头上。
    // 先跟踪与上一帧位置接近的脸；新脸要连续两帧明显更大才切换。
    const valid = []
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]
      if (a && a.origin && a.size && a.size.width > 0) valid.push(a)
    }
    if (!valid.length) return null
    const area = a => a.size.width * (a.size.height || a.size.width)
    const center = a => ({
      x: a.origin.x + a.size.width / 2,
      y: a.origin.y + (a.size.height || a.size.width) / 2
    })
    let largest = valid[0]
    for (let i = 1; i < valid.length; i++) if (area(valid[i]) > area(largest)) largest = valid[i]

    let matched = null
    const prev = this._activeFace
    if (prev && prev.origin && prev.size) {
      const pc = center(prev)
      let bestDist = Infinity
      for (let i = 0; i < valid.length; i++) {
        const c = center(valid[i])
        const dist = Math.hypot(c.x - pc.x, c.y - pc.y)
        const radius = Math.max(prev.size.width, valid[i].size.width) * 0.9
        if (dist <= radius && dist < bestDist) {
          matched = valid[i]
          bestDist = dist
        }
      }
    }
    if (!matched) {
      this._activeFace = largest
      this._faceChallenger = null
      return largest
    }
    if (largest !== matched && area(largest) > area(matched) * 1.25) {
      const last = this._faceChallenger
      const same = last && last.anchor === largest
      this._faceChallenger = { anchor: largest, frames: same ? last.frames + 1 : 1 }
      if (this._faceChallenger.frames >= 2) {
        this._activeFace = largest
        this._faceChallenger = null
        return largest
      }
    } else {
      this._faceChallenger = null
    }
    this._activeFace = matched
    return matched
  },

  onFaceAnchor(anchor) {
    const box = this.anchorToBox(anchor)
    if (!box) return

    this.trackedBox = box
    // pickRoll 而不是 anchor.angle：文档里 angle 是数组，
    // 直接拿去做数值运算会得到 NaN，整头造型的旋转会失效。
    this.trackedAngle = this.clampAngle(faceFit.pickRoll(anchor))
    this.trackedLostAt = 0
    if (this._lostTimer) {
      clearTimeout(this._lostTimer)
      this._lostTimer = null
    }

    // 先判对齐：它可能已经把状态文案改写成「往左一点」或「已对齐」。
    // 侧脸估计器要有状态地看连续多帧（宽高比基准靠历史最大值建立），
    // 所以在这里喂，不放在无状态的 judgeAlign 里。
    if (!this._yaw) this._yaw = faceFit.createYawEstimator()
    const yaw = this._yaw.push(box.face)
    this.updateAlign(box, this.trackedAngle, yaw)

    // 脸型估计同样要看连续多帧，而且必须用**这一帧的 yaw 结论**做门控：
    // 转头会让宽高比变小，侧脸帧混进去就会把圆脸判成长脸。
    if (this._shape) this._shape.push(box.face, yaw)
    // 记下归一化人脸框，肤色采样要用它在原始帧里定位脸颊
    this._faceRect = anchorRect(anchor, this.frameSize)

    // 对齐成功才谈得上推荐：没对齐时脸可能只露一半，
    // 这时候测出来的宽高比不是脸的宽高比。
    if (this._align && this._align.state === 'locked') this.maybeRecommend()

    if (!this.data.faceFound) {
      // 只置位，不写文案 —— 文案由 updateAlign 按对齐结果给，
      // 否则会出现「检测到脸就宣称已锁定」的老问题。
      this.setData({ faceFound: true })
    }
    this.render()
  },

  clampAngle(a) {
    const limit = 0.52 // 约 30 度
    if (a > limit) return limit
    if (a < -limit) return -limit
    return a
  },

  /** 把识脸锚点换算成画布上的发型外框（真实逻辑见 utils/face-fit.js） */
  anchorToBox(anchor) {
    if (!this.cw || !this.ch) return null
    const box = faceFit.faceAnchorToBox(
      anchor,
      this.frameSize || { w: this.cw, h: this.ch },
      { w: this.cw, h: this.ch },
      {
        mirror: this.data.mirrorX,
        calibration: this.calibration
      }
    )
    if (!box) return null
    // face 一定要带上：它是「脸在屏幕上的真实位置和大小」，
    // 取景框的对齐判定全靠它。以前这里只回 x/y/w/h，
    // 把 face-fit 算好的脸心丢掉了，于是页面永远无法知道
    // 「脸偏左了还是偏右了」，只能干巴巴说一句「把脸放进画面中」。
    return { x: box.x, y: box.y, w: box.w, h: box.h, face: box.face }
  },

  /**
   * 把当前脸位置和取景框比对一次，更新框的状态与方向提示。
   *
   * 每帧都会调用（anchor 是逐帧来的），但 **只有状态或提示真的变了才 setData**。
   * 每帧 setData 会让逻辑层和渲染层来回通信，低端机上直接把帧率拖下来 ——
   * 表现就是「引导文字一闪一闪」。
   */
  updateAlign(box, angle, yaw) {
    if (!box || !box.face) return
    const r = faceFit.judgeAlign(box.face, { w: this.cw, h: this.ch }, angle, yaw)
    const prev = this._align
    const changed = !prev || prev.state !== r.state || prev.hint !== r.hint
    this._align = r

    // 框的显隐每帧都要维护，跟 changed 无关：
    // 对齐满 3 秒就该自己退场，一旦偏离就得立刻回来。
    if (r.state === 'locked') {
      this.scheduleGuideFade()
    } else {
      this.revealGuide()
    }

    if (!changed) return

    const guide = Object.assign({}, this.data.guide, {
      state: r.state,
      // 对齐之后不要再挂一句提示：框已经淡下去了，文字留着只会挡脸
      hint: r.state === 'locked' ? '' : r.hint
    })
    this.setData({
      guide: guide,
      // 文案跟着对齐状态走。以前只要检测到脸就写「已锁定人脸」，
      // 哪怕脸只露出半张、贴在屏幕角上，也宣称锁定成功 ——
      // 用户看到的是一顶明显错位的发型 + 一句"已锁定"，只会觉得产品坏了。
      statusText: r.state === 'locked' ? '已对齐 · 实时试戴中' : (r.hint || '把脸放进框里')
    })
  },

  /**
   * 对齐之后让取景框自己退场。
   *
   * 框的用途是「把脸引进构图区」，一旦引到位，它就只剩干扰：
   * 挡脸、挡头发、让人误以为还要操作。但直接隐藏又不行 ——
   * 用户稍微一动就偏了，没有参照他根本不知道自己偏了。
   *
   * 所以：**对齐满 3 秒淡出，一偏离立刻回来。**
   * 3 秒这个值取自「用户摆好姿势后不会再大幅移动」的经验时长；
   * 太短会让框反复出现，太长等于没退场。
   */
  scheduleGuideFade() {
    if (this._guideFadeTimer) return
    if (this.data.guide.hidden) return
    const self = this
    this._guideFadeTimer = setTimeout(function () {
      self._guideFadeTimer = null
      if (!self._alive) return
      // 定时器跑完时可能已经偏离了，再确认一次
      if (!self._align || self._align.state !== 'locked') return
      self.setData({ guide: Object.assign({}, self.data.guide, { hidden: true }) })
    }, GUIDE_FADE_MS)
  },

  /** 偏离（或还没对齐）时把框叫回来。这里不加节流：看不见框比框闪一下更糟。 */
  revealGuide() {
    if (this._guideFadeTimer) {
      clearTimeout(this._guideFadeTimer)
      this._guideFadeTimer = null
    }
    if (!this.data.guide.hidden) return
    this.setData({ guide: Object.assign({}, this.data.guide, { hidden: false }) })
  },

  /* ==================== 渲染 ==================== */

  computeBox() {
    const cw = this.cw
    const ch = this.ch
    if (!cw || !ch) return null

    const sizeK = (this.sizeVal || 100) / 100
    const rotRad = ((this.rotVal || 0) * Math.PI) / 180
    const dy = (((this.yVal || 46) - 46) / 100) * ch * 0.5

    // 识脸丢失后的宽限期。超过这个时间才认为人真的走了，
    // 回退到屏幕中央的默认位置。
    const TRACK_KEEP_MS = 2500
    const keepTrack = this.trackedBox &&
      (!this.trackedLostAt || Date.now() - this.trackedLostAt < TRACK_KEEP_MS)

    if (keepTrack) {
      const w = this.trackedBox.w * sizeK
      const h = w * BOX_ASPECT
      const cx = this.trackedBox.x + this.trackedBox.w / 2
      const cy = this.trackedBox.y + this.trackedBox.h * HEAD_CY_RATIO
      return {
        x: cx - w / 2 + this.dragDX,
        y: cy - h * HEAD_CY_RATIO + dy + this.dragDY,
        w: w,
        h: h,
        angle: this.trackedAngle + rotRad
      }
    }

    // 既没识到脸、用户也没主动微调时，不凭空在屏幕中央画发型。
    // 那是虚拟示意，不是 AR；用户会误以为识脸已经工作。
    if (!this.data.faceFound && !this.data.manualOn) return null

    const w = cw * 0.62 * sizeK
    const h = w * BOX_ASPECT
    const cx = cw * 0.5 + this.dragDX
    const cy = ch * ((this.yVal || 46) / 100) + this.dragDY

    return {
      x: cx - w / 2,
      y: cy - h * HEAD_CY_RATIO,
      w: w,
      h: h,
      angle: rotRad
    }
  },

  render(force) {
    const ctx = this.ctx
    if (!ctx || !this.cw) return
    // 页面已销毁后不要再往 canvas 上画。this.ctx 还指着那个 canvas 节点，
    // 但它已经随页面一起销毁了，继续 clearRect / drawImage 在真机上
    // 会抛「canvas is detached」类错误，或者在下一帧的日志里刷一片红。
    if (!this._alive) return

    // 降级路径（没有离屏画布，走矢量直绘）每帧要发 4 万多次 canvas 调用，
    // 低端机上单帧就可能吃掉 40ms 以上。识脸 anchor 是跟着摄像头帧来的，
    // 不设上限的话 UI 线程会被绘制彻底占满 —— 表现为「画面在动，
    // 但点按钮、拖滑块全都没反应」，用户以为小程序卡死了。
    // 限到 25fps：视觉上依然是实时，交互却回来了。
    // force=true 用于用户主动操作（换发型、换色、复位），必须立刻生效。
    if (!force && hairstyles.isDegraded()) {
      const now = Date.now()
      if (this._lastRenderAt && now - this._lastRenderAt < 40) return
      this._lastRenderAt = now
    }

    // 拍照冻结期间，预览和合成都用同一个框，
    // 否则用户会看到「按下快门后预览里的发型跳了一下」。
    const box = this.boxFrozen && this.frozenBox ? this.frozenBox : this.computeBox()
    // 先清空再判断：没有可信位置时必须把上一帧的发型擦掉，
    // 否则失脸后画布上会残留一顶悬空的假发。
    ctx.clearRect(0, 0, this.cw, this.ch)
    if (!box) {
      // 同时把 lastBox 清掉。它只在有框的时候被赋值，
      // 如果这里留着上一次的位置，拍照会拿一个「人脸早就走了」的
      // 旧坐标去合成 —— 照片上出现一顶漂在背景里的发型。
      this.lastBox = null
      return
    }
    if (!(this.boxFrozen && this.frozenBox)) box.mirror = !!this.data.mirrorX

    this.lastBox = box
    // 模拟器没有真实画面。这里不画虚拟头型、也不画悬空发型：
    // 那会让开发者和体验者把「假人头上的示意」当成产品能力，
    // 甚至以为可以在这里出图。模拟器只做真机引导，不出任何虚拟效果。
    if (this.data.isDevtools) return
    hairstyles.drawHair(ctx, box, this.data.currentStyle, this.data.currentColor, 1)
  },

  /* ==================== 拖动 ==================== */

  touchPoint(e) {
    const t = e.touches && e.touches[0]
    if (!t) return null
    const x = typeof t.x === 'number' ? t.x : t.clientX
    const y = typeof t.y === 'number' ? t.y : t.clientY
    if (typeof x !== 'number' || typeof y !== 'number') return null
    return { x: x, y: y }
  },

  onTouchStart(e) {
    const p = this.touchPoint(e)
    if (!p) return
    // 手指一落到画面上，推荐卡片就先让开 —— 他要看的是自己的脸，
    // 不是三行说明。收起后留一行小条，想看再点开。
    this.collapseRec()
    // 双击画面复位。拖动范围被 clamp 之后发型不会整个飞出屏幕，
    // 但用户仍可能把它推到很偏的位置；给他一个「双击回到识脸位置」
    // 的退路，比让他去重新点一次发型卡片自然得多。
    const now = Date.now()
    if (
      this._lastTapAt && now - this._lastTapAt < 300 &&
      Math.abs(p.x - this._lastTapX) < 24 &&
      Math.abs(p.y - this._lastTapY) < 24
    ) {
      this._lastTapAt = 0
      this.resetAdjust()
      this.showToast('已复位到识脸位置')
    } else {
      this._lastTapAt = now
      this._lastTapX = p.x
      this._lastTapY = p.y
    }
    this.touchOrigin = {
      x: p.x,
      y: p.y,
      dx: this.dragDX || 0,
      dy: this.dragDY || 0
    }
  },

  onTouchMove(e) {
    if (!this.touchOrigin) return
    const p = this.touchPoint(e)
    if (!p) return
    // 一旦有明显位移就取消双击判定，否则拖动也会触发复位
    if (Math.abs(p.x - this._lastTapX) > 24 || Math.abs(p.y - this._lastTapY) > 24) {
      this._lastTapAt = 0
    }
    this.dragDX = this.touchOrigin.dx + (p.x - this.touchOrigin.x)
    this.dragDY = this.touchOrigin.dy + (p.y - this.touchOrigin.y)
    // 用户主动拖了，说明他要手动定位 —— 这时才允许在没有识脸的情况下
    // 显示发型。否则「拖了个空」比不显示更让人困惑。
    this.enterManual()
    // 限制拖动范围。发型框宽约 0.62 屏宽，允许中心在 ±25% 屏宽内移动，
    // 保证脸和头发始终有一部分在画面里 —— 否则用户把发型拖飞出屏幕后
    // 没有任何反馈，画面空空一片，只能猜「是不是卡了」。
    if (this.cw && this.ch) {
      const maxDX = this.cw * 0.25
      const maxDY = this.ch * 0.18
      if (this.dragDX > maxDX) this.dragDX = maxDX
      if (this.dragDX < -maxDX) this.dragDX = -maxDX
      if (this.dragDY > maxDY) this.dragDY = maxDY
      if (this.dragDY < -maxDY) this.dragDY = -maxDY
    }
    this.render(true)
  },

  onTouchEnd() {
    this.touchOrigin = null
  },

  onTouchCancel() {
    // 系统手势、来电或原生弹层会打断触摸，不发 touchend。
    // 不清掉起点的话，下一次 touchmove 会接着上次的偏移飞出去。
    this.touchOrigin = null
    this._lastTapAt = 0
  },

  /** 复位微调参数到识脸默认值 */
  resetAdjust() {
    this.dragDX = 0
    this.dragDY = 0
    this.sizeVal = 100
    this.yVal = 46
    this.rotVal = 0
    // 复位 = 回到识脸位置。手动定位状态也一起退出，
    // 没识到脸时画布随之清空，不留悬空发型。
    this.setData({
      sizeVal: 100, yVal: 46, rotVal: 0, manualOn: false,
      statusText: this.data.faceFound ? this.data.statusText : '把脸放进框里'
    })
    this.render(true)
  },

  /* ==================== 选择发型 / 发色 ==================== */

  /* ---------- 横滑列表的「滑动 vs 点击」判定 ---------- */

  /**
   * scroll-view 的横滑在手指抬起时会照样派发 tap。
   * 用户只是想滚动看一眼，结果发型/发色被切换了。
   * 具体阈值与状态机见 utils/swipe-guard.js。
   */
  onStripTouchStart(e) {
    swipe.start(e, this._stripSwipe)
  },

  onStripTouchMove(e) {
    swipe.move(e, this._stripSwipe)
  },

  onStripTouchCancel() {
    swipe.cancel(this._stripSwipe)
  },

  onColorTouchStart(e) {
    swipe.start(e, this._colorSwipe)
  },

  onColorTouchMove(e) {
    swipe.move(e, this._colorSwipe)
  },

  onColorTouchCancel() {
    swipe.cancel(this._colorSwipe)
  },

  /* ==================== 自动匹配 ==================== */

  /**
   * 换摄像头时把「这一张脸的结论」整组清掉。
   *
   * 清四样东西，缺一个就会留下半截状态：
   *   - 定时器：600ms 的结算、7 秒的收起、肤色重试、延后应用
   *   - 结论：_recDone / _recTries / 备选索引
   *   - 采样：_skinStarted / _skinTries（否则新摄像头永远不再采样）
   *   - 卡片：rec.show（后置画面里挂着「已换上」是最明显的谎）
   */
  resetRecommendForCamera() {
    if (this._recTimer) {
      clearTimeout(this._recTimer)
      this._recTimer = null
    }
    this.clearRecCollapse()
    if (this._skinRetryTimer) {
      clearTimeout(this._skinRetryTimer)
      this._skinRetryTimer = null
    }
    if (this._skinApplyTimer) {
      clearTimeout(this._skinApplyTimer)
      this._skinApplyTimer = null
    }
    if (this._skinTimer) {
      clearTimeout(this._skinTimer)
      this._skinTimer = null
    }
    this._recDone = false
    this._recTries = 0
    this._recAltIdx = 0
    this._recPending = false
    this._skinStarted = false
    this._skinTries = 0
    if (this.data.rec && (this.data.rec.show || this.data.rec.declined)) {
      this.setData({
        rec: Object.assign({}, this.data.rec, {
          show: false,
          expanded: false,
          declined: false,
          skinBusy: false
        })
      })
    }
  },

  /**
   * 对齐成功后的入口。只调度，不判断。
   *
   * 三个前置条件缺一不可：
   *   - 已经对齐（脸可能只露一半时，测出来的宽高比不是脸的宽高比）
   *   - 还没做过（_recDone）
   *   - 没有排队中的定时器（每帧都会调到这里）
   */
  maybeRecommend() {
    if (this._recDone || this._recTimer) return
    if (this.data.isDevtools) return
    if (this.data.manualOn) return
    // 用户在微调：滑块正被手指拖着，这时候换款会连大小/位置一起复位
    // （见 applyStyleId），他刚调好的 150% 会突然跳回 100%，
    // 而且卡片本身在 adjustMode 下不渲染，屏幕上只剩「发型变了」。
    // 记下来，等收起微调再算 —— 不烧重试预算，也不在滑块上面弹卡片。
    if (this.data.adjustMode) {
      this._recPending = true
      return
    }
    if (!this._align || this._align.state !== 'locked') return

    const est = this._shape ? this._shape.get() : null
    const ready = !!(est && est.ready)

    // 第一次对齐：不管测没测出来，都先等 600ms 让用户看清画面。
    // 600ms 后 runRecommend 自己判断够不够，不够就进重试链。
    if (this._recTries === 0) {
      const self = this
      this._recTimer = setTimeout(function () {
        self._recTimer = null
        if (!self._alive || self._recDone) return
        // 定时器跑完时可能已经偏了（用户动了），再确认一次
        if (!self._align || self._align.state !== 'locked') return
        self.runRecommend()
      }, REC_SETTLE_MS)
      return
    }

    // 重试链已经跑完（预算用尽）之后，不再定时 —— 改为每帧看一眼估计器。
    // 这个方法每帧都会被调用，所以只要用户把脸摆正、攒够正脸帧，
    // 下面的 ready 分支会立刻接上。
    //
    // 原来的写法是一用尽就 `_recDone = true`，等于「进页面时先转了下头」
    // 就把整个功能永久关掉。而**转侧脸看看效果，恰恰是试发型时最自然的动作**，
    // 用户看到的却是「说好的自动匹配一次都没出现」。
    if (!ready) {
      if (this._recTries < REC_MAX_RETRY) this.scheduleRecRetry()
      return
    }
    this.runRecommend()
  },

  /**
   * 真正做推荐。
   *
   * 脸型估计器要攒够正脸帧才敢下结论。攒不够就等一会儿再来，
   * 最多 4 次；还是不够就**什么都不说** —— 用户一直转头的时候，
   * 任何脸型结论都是编的。
   */
  runRecommend() {
    if (this._recDone) return

    // 正在拍照时必须让路。
    // 快门已经冻结了当前款和当前框（_captureLook / frozenBox），
    // 这一刻换款不会影响这张照片，但会让「刚拍的和刚才看到的不一样」——
    // 用户会以为照片错了。等拍完再说。
    if (this.data.shooting) {
      this.scheduleRecRetry()
      return
    }

    // 微调中：同 maybeRecommend，改由 toggleAdjust 收起时补算。
    // 这里也必须挡一道 —— 600ms 的定时器可能在用户点开微调之前就挂上了。
    if (this.data.adjustMode) {
      this._recPending = true
      return
    }

    const est = this._shape ? this._shape.get() : null

    if (!est || !est.ready) {
      this.scheduleRecRetry()
      return
    }

    this._recDone = true
    // 把「测得有多准」一起带过去。
    // 分类器在边界附近返回的是「接近标准」（confidence 0.6），
    // 但 applyShape 原来只用 SHAPE_LABEL 常量重新拼标签，
    // 于是那句诚实的话在页面上被抹平成 100% 肯定的「标准脸」——
    // 用户是拿这句话判断「它测得准不准」的。
    this.applyShape(est.shape, {
      measured: true,
      label: est.label,
      confidence: est.confidence
    })
    this.startSkinSample()
  },

  /**
   * 脸型还没测准 / 正在拍照：隔一会儿再来，最多 4 次。
   *
   * 注意：**次数用尽不等于放弃**。这里只停掉「定时重试」这条链，
   * 不置 `_recDone` —— 真正的开关交给 maybeRecommend 每帧观察估计器。
   * `_recDone` 只在一件事发生后置位：**真的给出过结论**（或用户主动收起）。
   * 否则「用户刚进页面时在转头」会变成「这个功能今天不会再出现了」。
   */
  scheduleRecRetry() {
    if (this._recTries >= REC_MAX_RETRY) return
    this._recTries++
    const self = this
    this._recTimer = setTimeout(function () {
      self._recTimer = null
      if (!self._alive) return
      self.runRecommend()
    }, REC_RETRY_MS)
  },

  /**
   * 按脸型给出推荐，并决定「替不替用户换」。
   *
   * @param {'round'|'oval'|'long'} shapeId
   * @param {{force?:boolean, measured?:boolean}} [opt] force = 用户亲手点的脸型
   */
  applyShape(shapeId, opt) {
    const force = !!(opt && opt.force)
    const best = match.bestStyle(shapeId)
    if (!best) return
    const style = hairstyles.getStyle(best.id)

    // 「同档也合适」的备选（适配分 ≥2 的前三名）。
    //
    // 原来只把第 1 名交给用户：不满意就没有第二条路，只能自己去横滑 10 款 ——
    // 而「哪几款也合适」这个信息引擎本来就算出来了（rankStyles 是完整排序），
    // 只是从来没给出去。三个脸型 × 一档一个答案，同脸型的用户拿到的东西
    // 一模一样，这不像匹配，像查表。
    const ranked = match.rankStyles(shapeId)
    const alt = []
    for (let i = 0; i < ranked.length && alt.length < 3; i++) {
      if (ranked[i].score < 2) break
      const s = hairstyles.getStyle(ranked[i].id)
      if (!s) continue
      alt.push({ id: s.id, name: s.name, reason: ranked[i].reason })
    }
    this._recAltIdx = 0

    // 什么时候可以自己动手：
    //   force                       用户刚亲手点了脸型，等于授权
    //   否则必须三个「没表态」同时成立
    const canAuto = force || (!this._userPickedStyle && !this._explicitStyle && !this._hasLastPick)

    // 推荐款可能**就是当前款**。标准脸的首选是波波头，而波波头正是默认款，
    // 这时候如果还写「已换上」，用户盯着画面看半天发现没变化，
    // 只会觉得功能坏了。所以分开两种说法：
    //   same  「波波头」正适合你的脸型   （确实没换，因为本来就对）
    //   auto  已换上「背头」            （真的换了）
    const changed = style.id !== this.data.currentStyle

    const rec = Object.assign({}, this.data.rec, {
      show: true,
      shape: shapeId,
      // 测出来的标签优先（可能是「接近标准」），用户自己点的脸型才用常量
      shapeLabel: (opt && opt.label) || match.SHAPE_LABEL[shapeId],
      shapeUnsure: !!(opt && opt.confidence != null && opt.confidence < 1),
      styleId: style.id,
      styleName: style.name,
      reason: best.reason,
      alt: alt,
      auto: canAuto && changed,
      same: !changed,
      expanded: true,
      // 重新算过一轮 = 用户又参与了（点了脸型），解除「别再动我」的状态
      declined: false
    })
    this.setData({ rec: rec })
    this.scheduleRecCollapse()

    if (canAuto && changed) {
      this.applyStyleId(style.id, { auto: true })
    }
  },

  /**
   * 「换一款」：在同样合适的那几款之间轮换。
   *
   * 不是重新算推荐 —— 推荐仍然按脸型排序，只是把第 2、3 名也放出来。
   * 脸型只有三档，第一名对所有同档用户都是同一款；不给备选的话，
   * 用户不接受就只剩「自己乱划」这一条路，AI 匹配等于只值一次点击。
   */
  nextRecStyle() {
    const alts = this.data.rec.alt || []
    if (alts.length < 2) return
    this._recAltIdx = ((this._recAltIdx || 0) + 1) % alts.length
    const pick = alts[this._recAltIdx]
    if (!hairstyles.hasStyle(pick.id)) return
    const wasSame = pick.id === this.data.currentStyle
    // 用户亲手换了推荐里的款：等于表过态，后面不再自动替换
    this._userPickedStyle = true
    // via:'rec' —— 这是 AI 给的备选，不是他自己翻条挑的，
    // 所以只记「上次看的是这款」，不记「别再自动匹配了」。
    this.applyStyleId(pick.id, { user: true, via: 'rec' })
    this.setData({
      rec: Object.assign({}, this.data.rec, {
        styleId: pick.id,
        styleName: pick.name,
        reason: pick.reason,
        auto: !wasSame,
        same: wasSame,
        expanded: true
      })
    })
    this.scheduleRecCollapse()
  },

  /**
   * 用户点 ×：收成一行小条，并且**不再自动改动**。
   *
   * 原来这里直接把 `rec.show` 置 false。问题是肤色采样还在飞
   * （最多 1.6 秒 × 3 轮），结果一到照样把发色换掉 ——
   * 用户刚说完「不用了」，头发颜色自己变了，而屏幕上已经没有任何东西
   * 能解释这件事。× 的 aria-label 本来就是「收起推荐」，
   * 收成小条才是它该做的事；同时记下 declined，后续只展示不替换。
   *
   * 小条必须留着：原来置 false 之后连入口一起消失，
   * 手滑点掉一次，整场都找不回来。
   */
  dismissRec() {
    this._recDone = true
    this.clearRecCollapse()
    this.setData({
      rec: Object.assign({}, this.data.rec, { expanded: false, declined: true })
    })
  },

  /** 收成一行小条：面板高度回到原位，不再压住取景框下沿 */
  collapseRec() {
    if (!this.data.rec.show || !this.data.rec.expanded) return
    this.clearRecCollapse()
    this.setData({ rec: Object.assign({}, this.data.rec, { expanded: false }) })
  },

  /** 点小条重新展开 */
  expandRec() {
    if (!this.data.rec.show || this.data.rec.expanded) return
    this.setData({ rec: Object.assign({}, this.data.rec, { expanded: true }) })
    this.scheduleRecCollapse()
  },

  scheduleRecCollapse() {
    const self = this
    this.clearRecCollapse()
    this._recCollapseTimer = setTimeout(function () {
      self._recCollapseTimer = null
      if (!self._alive) return
      self.collapseRec()
    }, REC_CARD_MS)
  },

  clearRecCollapse() {
    if (this._recCollapseTimer) {
      clearTimeout(this._recCollapseTimer)
      this._recCollapseTimer = null
    }
  },

  /** 点过 × 之后，用户一旦自己动手挑款/挑色/进微调，小条就彻底退场 */
  dropDeclinedRec() {
    if (!this.data.rec.declined || !this.data.rec.show) return
    this.clearRecCollapse()
    this.setData({ rec: Object.assign({}, this.data.rec, { show: false, expanded: false }) })
  },

  /** 用户点「换成这款」：把推荐款应用上去，并记为主动选择 */
  useRecStyle() {
    const id = this.data.rec.styleId
    if (!hairstyles.hasStyle(id)) return
    this._userPickedStyle = true
    // 同上：接受推荐 ≠ 关掉推荐
    this.applyStyleId(id, { user: true, via: 'rec' })
    this.setData({ rec: Object.assign({}, this.data.rec, { auto: true, same: false }) })
  },

  /** 用户说「判得不准」，自己指定脸型：重新排一遍，并强制应用 */
  pickShape(e) {
    const id = e.currentTarget.dataset.shape
    if (!match.SHAPE_LABEL[id]) return
    if (id === this.data.rec.shape) return
    this.applyShape(id, { force: true })
  },

  /**
   * 采样肤色。
   *
   * 一轮最多读 3 帧有效数据 / 1.6 秒。摄像头帧是整屏 RGBA，
   * 常开监听在低端机上会明显发热，所以采到就立刻停。
   *
   * **采不到会重来**（最多 SKIN_MAX_TRIES 轮，间隔 2.5 秒）：
   * 暗光、逆光、脸偏出框都会让 144 个采样点一个都过不了肤色规则，
   * 而用户挪到窗边只要两秒。原来一轮失败就永久关闭，
   * 等于「发色匹配」对暗光用户整场不存在。
   * 但无论重试几轮，**没测到就是没测到**，绝不编一个「你的肤色偏白」。
   */
  startSkinSample() {
    if (this._skinStarted) return
    if (this._skinTries >= SKIN_MAX_TRIES) {
      // 试满了还没采到：把「正在测」收掉，不编一个肤色出来
      if (this.data.rec.skinBusy) {
        this.setData({ rec: Object.assign({}, this.data.rec, { skinBusy: false }) })
      }
      return
    }
    // 守卫必须放在置位之前。
    // 原来先 `_skinStarted = true` 再判 `_faceRect`：万一调用的那一刻
    // 人脸框还没算出来，这个开关就永久关上了，之后再也不会采样。
    if (!this._faceRect || !this.frameSize) {
      this._skinTries++
      this.scheduleSkinRetry()
      return
    }

    this._skinStarted = true
    this._skinTries++

    const self = this
    // 这一轮采样属于哪台摄像头。切摄像头后 _cameraEpoch 会 +1，
    // 旧摄像头的帧监听可能还在回调 —— 拿着上一台摄像头的光线去改发色，
    // 而且那时候页面已经把推荐状态清空了。
    const epoch = this._cameraEpoch || 0
    this.setData({ rec: Object.assign({}, this.data.rec, { skinBusy: true }) })

    let listener = null
    let finished = false
    let frames = 0
    const got = []

    const finish = function () {
      if (finished) return
      finished = true
      if (self._skinTimer) {
        clearTimeout(self._skinTimer)
        self._skinTimer = null
      }
      if (listener && listener.stop) listener.stop()
      listener = null
      if (!self._alive) return
      if ((self._cameraEpoch || 0) !== epoch) return

      let skin = null
      if (got.length) {
        let r = 0
        let g = 0
        let b = 0
        for (let i = 0; i < got.length; i++) {
          r += got[i].r
          g += got[i].g
          b += got[i].b
        }
        skin = match.classifySkin({ r: r / got.length, g: g / got.length, b: b / got.length })
      } else {
        // 一帧有效皮肤像素都没采到：暗光、逆光、脸偏出框、大框眼镜都会这样。
        // 不立刻收工 —— 用户往窗边挪两步、把手机抬一点就能补救，
        // 而「发色匹配」是核心功能的一半，不该因为最初那 1.6 秒的光线
        // 对整次会话永久失效。留有限次重试（SKIN_MAX_TRIES），
        // 期间卡片继续显示「正在测肤色…」，不装死也不编结论。
        self._skinStarted = false
        if (self._skinTries < SKIN_MAX_TRIES) {
          self.scheduleSkinRetry()
          return
        }
      }
      self.applySkin(skin)
    }

    try {
      const camCtx = this.camCtx || (wx.createCameraContext && wx.createCameraContext())
      if (!camCtx || !camCtx.onCameraFrame) {
        finish()
        return
      }
      // 超时先挂上，再注册监听。反过来的话，如果第一帧是同步回调
      // （部分机型会先给一帧缓存画面），finish 会在监听赋值之前跑完，
      // 于是定时器永远挂着、listener 也停不掉。
      this._skinTimer = setTimeout(finish, SKIN_TIMEOUT_MS)
      listener = camCtx.onCameraFrame(function (frame) {
        if (finished || !self._alive) return
        if ((self._cameraEpoch || 0) !== epoch) {
          // 已经换摄像头了：立刻停掉，别再读旧画面的像素
          finished = true
          if (listener && listener.stop) listener.stop()
          listener = null
          return
        }
        frames++
        const px = frame && frame.data
          ? match.sampleSkinPixels(frame.data, frame.width, frame.height, self._faceRect)
          : null
        if (px) got.push(px)
        if (got.length >= 3 || frames >= 12) finish()
      })
      // 同步回调里已经结束的话，这个监听是「刚注册就过期」的，补一次 stop
      if (finished && listener && listener.stop) {
        listener.stop()
        listener = null
      }
    } catch (e) {
      console.warn('[tryon] 肤色采样失败', e)
      // 接口不存在、或者直接抛错：这不是光线问题，重试也不会好。
      // 直接把重试预算用掉，免得卡片挂着「正在测肤色…」白等 5 秒。
      this._skinTries = SKIN_MAX_TRIES
      finish()
    }
  },

  /** 采样失败（暗光/脸偏出框）时隔一会儿再来一轮，最多 SKIN_MAX_TRIES 轮 */
  scheduleSkinRetry() {
    if (this._skinRetryTimer) return
    if (this._skinTries >= SKIN_MAX_TRIES) {
      if (this.data.rec.skinBusy) {
        this.setData({ rec: Object.assign({}, this.data.rec, { skinBusy: false }) })
      }
      return
    }
    const self = this
    this._skinRetryTimer = setTimeout(function () {
      self._skinRetryTimer = null
      if (!self._alive) return
      self.startSkinSample()
    }, SKIN_RETRY_MS)
  },

  /** 肤色 → 发色推荐。skin 为 null 时只把「正在测」收起来，不做任何结论 */
  applySkin(skin) {
    // 采样是异步的，很可能正好落在按快门之后那几百毫秒里。
    // 这时候改发色会让照片和预览对不上，推到拍完再应用。
    if (this.data.shooting) {
      const self = this
      if (this._skinApplyTimer) clearTimeout(this._skinApplyTimer)
      this._skinApplyTimer = setTimeout(function () {
        self._skinApplyTimer = null
        if (!self._alive) return
        self.applySkin(skin)
      }, 500)
      return
    }

    const base = Object.assign({}, this.data.rec, { skinBusy: false })
    if (!skin) {
      this.setData({ rec: base })
      return
    }

    const rank = match.rankColors(skin.depth, hairstyles.HAIR_COLORS)
    const best = rank.length ? rank[0] : null
    if (!best) {
      this.setData({ rec: base })
      return
    }
    const color = hairstyles.getColor(best.id)

    // 两路测量打架时不自动替换发色。
    // 肤色判定依赖画面亮度，自动曝光一动就能把「中等」变成「偏深」，
    // 这时候替他换一个发色，等于把相机的曝光问题算到他脸上。
    // 仍然把建议显示出来，但让他自己决定要不要用。
    //
    // declined：他点过 ×。这一条最硬 —— 肤色结果是异步的，
    // 常常在他关掉卡片之后才回来，此时屏幕上没有卡片、没有小条文案变化，
    // 换色就是一次无解释的改动。
    const canAuto = !this.data.rec.declined &&
      !this._userPickedColor && !this._explicitColor &&
      !this._hasLastPick && skin.confident

    const rec = Object.assign(base, {
      skinLabel: skin.label,
      colorId: color.id,
      colorName: color.name,
      colorReason: best.reason,
      // 测不准要写在脸上，不能悄悄降级
      colorUnsure: !skin.confident
    })
    this.setData({ rec: rec })

    if (canAuto && color.id !== this.data.currentColor) {
      this.applyColorId(color.id, { auto: true })
    }
  },

  /* ==================== 选款 / 选色 ==================== */

  pickStyle(e) {
    // 横滑误触保护：这次 tap 之前手指移动过，当作滚动而不是选择
    if (swipe.consume(this._stripSwipe)) return
    const id = e.currentTarget.dataset.id
    // 列表是本地生成的，理论上不会出现无效 id；但列表可能停留在
    // 上一次版本的数据上（热更新期间），认不出就当作没点，
    // 总比静默换成 bob 好 —— 用户点的是「大波浪」，结果出来圆寸。
    if (!hairstyles.hasStyle(id)) return
    // 已选中的卡片再点一次应保持现状。把它当成重新选择会清空
    // 用户刚调好的大小/位置，还会白白触发一次烘焙。
    if (id === this.data.currentStyle) return
    // 用户亲手选了款，自动匹配从此只推荐不替换。
    this._userPickedStyle = true
    // 他在动手挑款了，说明卡片已经读够（或者根本没在读），别再占地方
    this.collapseRec()
    this.dropDeclinedRec()
    this.applyStyleId(id, { user: true })
  },

  /**
   * 真正应用一款发型。
   *
   * @param {string} id
   * @param {{user?:boolean, auto?:boolean}} [opt]
   *        user = 用户亲手点的（要记住偏好）；
   *        auto = 自动匹配替他换的（**不记**，否则下次进来
   *               _hasLastPick 成立，自动匹配就再也不会发生了）
   */
  applyStyleId(id, opt) {
    if (!hairstyles.hasStyle(id)) return
    const user = !!(opt && opt.user)
    const style = hairstyles.getStyle(id)

    // 记住这次的选择。放在这里而不是 onUnload：用户可能在
    // 选完之后直接杀进程，onUnload 不一定会跑。
    // 自动匹配的结果不写进去 —— 见上面 opt 的说明。
    // 「接受推荐」要写，但标成 rec：下次进来还原这款，但别因此关掉自动匹配。
    if (user) store.saveLastPick(style.id, this.data.currentColor, (opt && opt.via) || 'user')

    // 换发型时把微调参数一起复位。
    // 每款发型的 fit（发型宽/脸宽）从 1.10 到 1.70 不等，
    // 用户给大波浪调好的 150% 大小切到圆寸上会变成一顶巨帽，
    // 切到长发又会因为已经调过而叠加。微调是「针对当前发型的补偿」，
    // 换对象就该归零，否则用户每次切发型都要先拖回 100%。
    this.dragDX = 0
    this.dragDY = 0
    this.sizeVal = 100
    this.yVal = 46
    this.rotVal = 0

    const patch = {
      currentStyle: style.id,
      currentStyleName: style.name,
      currentTag: style.tag,
      isFav: store.isFavorite(style.id),
      sizeVal: 100,
      yVal: 46,
      rotVal: 0
    }

    // 横滑条要跟着滚过去。
    //
    // 锚点原来只在 onLoad 设一次，于是自动换上的款如果排在锚点**左边**，
    // 收起卡片后那一排里一张高亮的都没有 —— 画面确实换了头发，
    // 条上却找不到是哪一款。这不是假想：锚点是默认的波波头（第 3 张），
    // 而标准脸的首选短碎发是第 2 张、深肤色的首选自然黑是第 1 个，
    // 两个最常走的分支都落在锚点左边。
    //
    // 只在两种情况下重设：自动匹配换的、或者此刻条正被卡片挡着。
    // 用户亲手点条上的卡片时**不能**重设，否则会把刚点的那张甩到最左边。
    if ((opt && opt.auto) || (this.data.rec.show && this.data.rec.expanded)) {
      patch.stripAnchor = 'st-' + style.id
    }

    // 用户自己换掉了推荐款：卡片改成「更推荐 X」，把选择权还给他，
    // 而不是继续宣称「已按你的脸型换上」。
    if (this.data.rec.show && this.data.rec.styleId && this.data.rec.styleId !== style.id) {
      patch.rec = Object.assign({}, this.data.rec, { auto: false, same: false })
    }

    this.setData(patch, () => {
      // 在 setData 回调里烘焙：此时界面已经更新，用户看到选中态之后
      // 才开始付烘焙的那几十毫秒，不会觉得"点了没反应"。
      hairstyles.prewarm(style.id, this.data.currentColor)
      this.render(true)
    })
  },

  pickColor(e) {
    // 与 pickStyle 同一套横滑误触保护
    if (swipe.consume(this._colorSwipe)) return
    const id = e.currentTarget.dataset.id
    if (!hairstyles.hasColor(id)) return
    if (id === this.data.currentColor) return
    // 用户亲手选了色，肤色推荐从此只展示不替换。
    this._userPickedColor = true
    this.collapseRec()
    this.dropDeclinedRec()
    this.applyColorId(id, { user: true })
  },

  /**
   * 真正应用一个发色。
   * @param {string} id
   * @param {{user?:boolean, auto?:boolean}} [opt] 语义同 applyStyleId
   */
  applyColorId(id, opt) {
    if (!hairstyles.hasColor(id)) return
    const user = !!(opt && opt.user)
    const color = hairstyles.getColor(id)
    if (user) store.saveLastPick(this.data.currentStyle, color.id)
    const patch = { currentColor: color.id, currentColorName: color.name }
    // 与款式条同理：深肤色的首选是自然黑（第 1 个），
    // 而色带锚点默认停在栗棕（第 3 个），自动换色后高亮项在视野左侧之外。
    if ((opt && opt.auto) || (this.data.rec.show && this.data.rec.expanded)) {
      patch.colorAnchor = 'cl-' + color.id
    }
    this.setData(patch, () => {
      hairstyles.prewarm(this.data.currentStyle, color.id)
      this.render(true)
      // 底部发型缩略图跟着换成新发色，保持「选了什么看到什么」。
      //
      // 但这一步的 setData 载荷是 10 张缩略图 ≈ 50KB。用户连续划色带时
      // 每换一个色就传一次 50KB，实测连划 5 次就是 250KB，真机上明显掉帧。
      // 所以做 500ms 防抖：等用户停下来再重建一次。
      // 主画面（currentColor + render）不受影响，是即时的。
      if (this._thumbTimer) clearTimeout(this._thumbTimer)
      const self = this
      this._thumbTimer = setTimeout(function () {
        self._thumbTimer = null
        if (!self._alive) return
        const styles = self.data.styles
        for (let i = 0; i < styles.length; i++) {
          styles[i].thumb = hairstyles.buildThumb(styles[i].id, self.data.currentColor)
        }
        self.setData({ styles: styles })
      }, 500)
    })
  },

  toggleFavorite() {
    const on = store.toggleFavorite(this.data.currentStyle)
    this.setData({ isFav: on })
    this.showToast(on ? '已加入收藏' : '已取消收藏')
  },

  /* ==================== 微调 ==================== */

  toggleAdjust() {
    // 进微调前先收起推荐卡片：卡片展开时占着面板，
    // 两个都摊开会把画面挤掉一半。
    this.collapseRec()
    this.dropDeclinedRec()
    const wasAdjust = this.data.adjustMode
    this.setData({ adjustMode: !wasAdjust })
    // 微调期间攒下的推荐，收起微调后补算。
    // 走 maybeRecommend 而不是直接 runRecommend：这几分钟里他可能已经把脸移出画面，
    // 得重新过一遍「对齐了吗 / 估计器攒够帧了吗」。
    if (wasAdjust && this._recPending) {
      this._recPending = false
      if (!this._recDone) this.maybeRecommend()
    }
  },

  /* 滑块拖动中：只更新内存值和画面，**不 setData**。
   *
   * 这里踩过一次：原来 bindchanging 里直接 setData({sizeVal: v})，
   * 而 wxml 上 <slider value="{{sizeVal}}"> 又绑着同一个字段。
   * setData 一写，滑块组件的 value 属性就被"回写"一次，
   * 正在被手指拖着的 thumb 被强行拉回上一帧的位置 ——
   * iOS 上表现为拖动一顿一顿地跟手、松手瞬间还会跳一下。
   * 拖动中真正需要的只有「画面跟着变」，数值显示可以等松手再更新。
   */
  onSizeChanging(e) {
    this.sizeVal = e.detail.value
    // 拉滑块和拖画面是同一件事：都在手动摆位置。
    // 不置 manualOn 的话，识脸不可用时滑块拖到底画布也不动一下，
    // 用户会认为整个页面卡死了 —— 这排滑块成了摆设。
    this.enterManual()
    this.render(true)
  },

  onYChanging(e) {
    this.yVal = e.detail.value
    this.enterManual()
    this.render(true)
  },

  onRotChanging(e) {
    this.rotVal = e.detail.value
    this.enterManual()
    this.render(true)
  },

  /* 松手：把值同步回 data，让 wxml 的 value 与真实值一致 */
  onSizeChange(e) {
    this.sizeVal = e.detail.value
    this.enterManual()
    this.render(true)
    this.setData({ sizeVal: e.detail.value })
  },

  onYChange(e) {
    this.yVal = e.detail.value
    this.enterManual()
    this.render(true)
    this.setData({ yVal: e.detail.value })
  },

  onRotChange(e) {
    this.rotVal = e.detail.value
    this.enterManual()
    this.render(true)
    this.setData({ rotVal: e.detail.value })
  },

  toggleMirror() {
    const next = !this.data.mirrorX
    if (this.data.devicePosition === 'front') this._frontMirror = next
    this.setData({ mirrorX: next })
    this.render(true)
  },

  switchCamera() {
    if (this.data.shooting) {
      this.showToast('正在生成照片，完成后再切换')
      return
    }
    // 快速连点时，前一次切换的定时器还没跑完，
    // 会把 cameraReady 又置回 true、再启动一次识脸，
    // 结果两个 VKSession 同时跑，anchor 互相覆盖、发型乱跳。
    if (this.switchTimer) {
      clearTimeout(this.switchTimer)
      this.switchTimer = null
    }
    if (this.switchTimer2) {
      clearTimeout(this.switchTimer2)
      this.switchTimer2 = null
    }

    const next = this.data.devicePosition === 'front' ? 'back' : 'front'
    this._cameraEpoch = (this._cameraEpoch || 0) + 1
    this.stopTracking()
    this.stopFrameProbe()
    this.frameSize = null
    this.dragDX = 0
    this.dragDY = 0
    // 切到后置摄像头时临时关镜像；切回前置恢复用户自己的偏好，
    // 而不是把 false 当成新偏好一路带回去。
    const mirror = next === 'front' ? this._frontMirror !== false : false
    // 对齐状态必须跟着清。切摄像头后画面左右会翻（后置不镜像），
    // 留着上一台摄像头的对齐结论，框会显示成「已对齐」而实际没对。
    this._align = null
    // 侧脸基准是「这台摄像头 + 这个用户」的统计量，换摄像头必须重来：
    // 前置后置的取景比例不同，沿用旧基准会把正脸判成侧脸。
    if (this._yaw) this._yaw.reset()
    // 脸型估计器同理，而且它取的是「窗口内最大宽高比」——
    // 不重置的话，上一台摄像头那个最大值会一直压着，新的观测永远改不动结论。
    if (this._shape) this._shape.reset()
    // 推荐结论是「上一台摄像头看到的那张脸」的结论。
    // 切到后置之后画面里根本没有脸，卡片却还挂在那里说「已换上「短碎发」」；
    // 切回前置时 `_recDone` 又是 true，于是**整场再也不会重新匹配** ——
    // 用户换了个光线、换了个距离，拿到的还是几分钟前那一次的结果。
    // 这里连同肤色采样一起清零，切回前置重新走一遍完整流程。
    this.resetRecommendForCamera()
    if (this._guideFadeTimer) {
      clearTimeout(this._guideFadeTimer)
      this._guideFadeTimer = null
    }
    this.setData({
      devicePosition: next,
      mirrorX: mirror,
      faceFound: false,
      cameraReady: false,
      statusText: '切换摄像头…',
      guide: Object.assign({}, this.data.guide, { state: 'idle', hint: '', hidden: false })
    })
    const self = this
    this.switchTimer = setTimeout(function () {
      self.switchTimer = null
      // 150ms 内用户可能已经返回退出，此时页面已销毁
      if (!self._alive) return
      self.setData({ cameraReady: true })
      // afterCameraReady 内部会等帧尺寸就绪再启动识脸，
      // 这里不需要再套一层定时器死等。
      self.afterCameraReady()
    }, 150)
  },

  /* ==================== 拍照 ==================== */

  capture() {
    if (this.data.shooting) return
    if (this.data.isDevtools) {
      this.showToast('模拟器不能拍照，请用真机预览')
      return
    }
    if (!this.data.cameraReady) {
      this.showToast('相机正在启动，稍等一下再按')
      return
    }

    // 没有可信位置就不按快门。
    // 合成逻辑里是 `if (box) drawHair(...)`，框为空时它会安安静静地
    // 存下一张「只有自拍、没有发型」的普通照片 —— 用户以为自己拍到了
    // 试戴效果，翻记录才发现是原图，而且已经写进相册和本地记录了。
    // 与其产出一个假结果，不如当场说清楚下一步该做什么。
    const shotBox = this.lastBox || this.computeBox()
    if (!shotBox) {
      this.showToast(this.data.arUnavailable ? '先点「手动定位」，再按快门' : '把脸放进虚线框再按快门')
      return
    }
    this.setData({ shooting: true })

    // 拍照期间冻结发型框。识脸是每帧更新的，
    // 如果一边拍一边收 anchor，lastBox 会在拍照和合成之间漂移，
    // 用户看到的就是「照片里的发型和刚才预览的不在一个位置」。
    // 冻结后 compose 用的就是按下快门那一刻的框，所见即所得。
    this.frozenBox = shotBox
    this.boxFrozen = true
    // 位置冻结还不够：合成是异步的，期间用户可以换款、换色、切镜像。
    // 快门时的整套造型必须一起冻结，否则记录里写的是新款，
    // 照片里画的却是另一款，和用户按下快门时看到的不一样。
    this._captureLook = {
      style: this.data.currentStyle,
      color: this.data.currentColor,
      mirror: !!this.data.mirrorX
    }
    // 快门看门狗。takePhoto 的回调在真机上不是「一定会来」的：
    // 相机被别的 App 抢占、来电、或者用户拍到一半切走，
    // 都可能让 success/fail 一个都不触发。此时 shooting 停在 true，
    // 快门按钮永久禁用，用户只能退出重进 —— 而他刚摆好的姿势全白费。
    // 20 秒足够覆盖最慢的一次「合成 + 落盘 + 写相册」。
    this._shootingAt = Date.now()
    this.armShootWatchdog()

    const self = this
    let camCtx = this.camCtx
    if (!camCtx) {
      try {
        camCtx = wx.createCameraContext()
      } catch (e) {
        this.setData({ shooting: false })
        this.unfreezeBox()
        this.showToast('相机不可用，点「开启相机」重试')
        return
      }
    }

    camCtx.takePhoto({
      quality: 'high',
      success(res) {
        self.compose(res.tempImagePath)
      },
      fail(err) {
        console.warn('[tryon] 拍照失败', err)
        if (!self._alive) return
        self.setData({ shooting: false })
        // 这条路径原来只复位了 shooting，没解冻 ——
        // 拍照失败之后预览就再也不跟脸了
        self.unfreezeBox()
        self.showToast('拍照失败，请重试')
      }
    })
  },

  /**
   * 快门看门狗：超过 20 秒还没走完，强制把页面恢复到可拍照状态。
   * 宁可让用户在极少数情况下重拍一次，也不要让快门永久失效。
   */
  armShootWatchdog() {
    const self = this
    if (this.shootTimer) clearTimeout(this.shootTimer)
    this.shootTimer = setTimeout(function () {
      self.shootTimer = null
      if (!self._alive) return
      if (!self.data.shooting) return
      console.warn('[tryon] 拍照流程超时，强制复位')
      self.setData({ shooting: false })
      self.unfreezeBox()
      self.showToast('拍照超时，请重试')
    }, 20000)
  },

  disarmShootWatchdog() {
    if (this.shootTimer) {
      clearTimeout(this.shootTimer)
      this.shootTimer = null
    }
  },

  compose(tempPath) {
    const self = this
    // 必须在 showLoading **之前**判断。
    // 用户完全可能按完快门立刻返回退出：takePhoto 的回调照样会进来，
    // 于是 showLoading 在一个已经销毁的页面上弹出来 ——
    // 微信不会替你收掉它，用户回到首页还能看到一个「正在生成」的转圈，
    // 只能杀掉小程序重进。
    if (!this._alive) return
    wx.showLoading({ title: '正在生成', mask: true })

    const query = wx.createSelectorQuery().in(this)
    query.select('#composeCanvas').fields({ node: true, size: true }).exec(function (res) {
      if (!res || !res[0] || !res[0].node) {
        wx.hideLoading()
        if (!self._alive) return
        self.unfreezeBox()
        self.setData({ shooting: false })
        self.showToast('合成失败，请重试')
        return
      }

      const canvas = res[0].node
      const ctx = canvas.getContext('2d')
      const img = canvas.createImage()

      img.onload = function () {
        // 用户可能在「正在生成」期间就返回退出了。此时页面已销毁，
        // 再往下走会 setData / 操作一个不存在的 canvas。
        if (!self._alive) {
          wx.hideLoading()
          return
        }
        try {
          // 控制输出尺寸，既保证清晰度又避免占满本地存储。
          // 实测（skia JPG，与 canvasToTempFilePath 同源）：
          //   1280x1920 q0.9 = 883 KB  -> 20 张 = 17.7MB，超出微信 10MB 本地文件上限
          //   960x1707  q0.82 = ~300KB -> 20 张 = ~6MB，留有余量
          // 960px 宽在历史列表（显示宽约 200px）与预览大图（约 750px 物理像素）都够清晰。
          const maxSide = 960
          const srcW = img.width
          const srcH = img.height
          const shrink = Math.min(1, maxSide / Math.max(srcW, srcH))
          const pw = Math.max(1, Math.round(srcW * shrink))
          const ph = Math.max(1, Math.round(srcH * shrink))

          canvas.width = pw
          canvas.height = ph
          ctx.clearRect(0, 0, pw, ph)

          // 前置摄像头：把照片翻转成和预览一致的镜像效果。
          // 必须读快门时冻结的状态，不能读此刻的 data（用户可能刚切过镜像）。
          const captureLook = self._captureLook || {
            style: self.data.currentStyle,
            color: self.data.currentColor,
            mirror: self.data.mirrorX
          }
          if (captureLook.mirror) {
            ctx.save()
            ctx.translate(pw, 0)
            ctx.scale(-1, 1)
            ctx.drawImage(img, 0, 0, pw, ph)
            ctx.restore()
          } else {
            ctx.drawImage(img, 0, 0, pw, ph)
          }

          // 用冻结框：与按下快门时的预览完全一致
          const box = self.frozenBox || self.lastBox || self.computeBox()
          // 兜底：快门那一刻已经拦过一次空框，正常走不到这里。
          // 真走到了也绝不能默默存一张没有发型的原图。
          if (!box) {
            wx.hideLoading()
            self.unfreezeBox()
            self.setData({ shooting: false })
            self.showToast('没有定位到发型位置，请重拍')
            return
          }
          if (self.cw && self.ch) {
            // 屏幕坐标 -> 照片坐标（cover 映射）
            const k = Math.max(pw / self.cw, ph / self.ch)
            const offX = (pw - self.cw * k) / 2
            const offY = (ph - self.ch * k) / 2
            const mapped = {
              x: box.x * k + offX,
              y: box.y * k + offY,
              w: box.w * k,
              h: box.h * k,
              angle: box.angle,
              mirror: !!box.mirror
            }
            hairstyles.drawHair(ctx, mapped, captureLook.style, captureLook.color, 1)
          }

          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'jpg',
            quality: 0.82,
            success(r) {
              const mainPath = r.tempFilePath
              // 顺手再导一张 240px 宽的小图给记录列表用。
              //
              // 不导的话，记录页会把 20 张 960px 的原图全部解码进内存：
              // 单张 960×1707 的 RGBA 位图是 6.5MB，20 张就是 130MB ——
              // 低端机进一次记录页直接被系统回收，用户看到的是
              // 「点记录就闪退」。而列表里那张图实际只显示约 100pt 宽。
              //
              // 240px 宽、q0.72 约 15KB，20 张 300KB，磁盘上也划算。
              const thumbW = 240
              const thumbH = Math.max(1, Math.round(ph * (thumbW / pw)))
              wx.canvasToTempFilePath({
                canvas: canvas,
                x: 0,
                y: 0,
                width: pw,
                height: ph,
                destWidth: thumbW,
                destHeight: thumbH,
                fileType: 'jpg',
                quality: 0.72,
                success(rt) {
                  wx.hideLoading()
                  self.afterCompose(mainPath, rt.tempFilePath)
                },
                fail() {
                  // 小图失败不能影响这次拍照：列表退回用原图，只是费点内存
                  wx.hideLoading()
                  self.afterCompose(mainPath, '')
                }
              })
            },
            fail(err) {
              console.warn('[tryon] 导出图片失败', err)
              wx.hideLoading()
              if (!self._alive) return
              self.unfreezeBox()
              self.setData({ shooting: false })
              self.showToast('生成图片失败，再按一次快门试试')
            }
          })
        } catch (err) {
          console.warn('[tryon] 合成异常', err)
          wx.hideLoading()
          if (!self._alive) return
          self.unfreezeBox()
          self.setData({ shooting: false })
          self.showToast('生成图片失败，再按一次快门试试')
        }
      }

      img.onerror = function () {
        wx.hideLoading()
        if (!self._alive) return
        self.unfreezeBox()
        self.setData({ shooting: false })
        self.showToast('照片读取失败，请重新拍一张')
      }

      img.src = tempPath
    })
  },

  afterCompose(tempFilePath, thumbFilePath) {
    const self = this
    // 用户可能已经退出，页面实例不在了
    if (!this._alive) return
    // 合成结束，解除冻结，识脸继续实时跟踪
    this.unfreezeBox()
    const captureLook = this._captureLook || {
      style: this.data.currentStyle,
      color: this.data.currentColor,
      mirror: this.data.mirrorX
    }
    const style = hairstyles.getStyle(captureLook.style)
    const color = hairstyles.getColor(captureLook.color)

    const persist = function () {
      store.addRecord(
        {
          styleId: style.id,
          styleName: style.name,
          colorId: color.id,
          colorName: color.name,
          tempFilePath: tempFilePath,
          tempThumbPath: thumbFilePath || ''
        },
        function (record, result) {
          // 落盘是异步的（saveFile），回调回来时页面可能已经销毁
          if (!self._alive) return
          self.setData({ shooting: false })
          if (result && result.ok === false) {
            // 文件落盘成功不等于记录写入成功。之前只看 photoSaved，
            // storage 写失败时仍提示「已存入试戴记录」，用户回去找不到。
            self.showToast('记录写入失败，请检查存储空间', 'warn')
          } else if (result && result.photoSaved) {
            // 记录被自动淘汰时必须说清楚。否则用户只是发现历史列表
            // 从 20 条变成 19 条，完全不知道是自己存储满了被清理的。
            if (result.evicted > 0) {
              self.showToast('已保存，清理最早 ' + result.evicted + ' 条旧记录', 'warn')
            } else {
              self.showToast('已存入试戴记录')
            }
          } else if (result && result.reason === 'storage-full') {
            // 照片落盘失败但发型信息已记录。
            //
            // **这条不能用 toast。** 它是全站唯一一条「用户有明确解法
            // 却需要记住一句话再去找入口」的消息：本机最多 20 条记录、
            // 满了就存不下新照片，解法是去「试戴记录」删几条。
            // toast 飘 2 秒就没了，用户读完「存储空间不足」，
            // 剩下的「那怎么办」只能自己猜 —— 而绝大多数人会以为是
            // 手机空间不够，跑去清相册，清完再拍还是不行。
            self.showStorageFull()
          } else {
            self.showToast('已记录发型，照片保存失败', 'warn')
          }
        }
      )
    }

    // 调整执行顺序：先把记录落到本地（快，几十毫秒），用户立刻得到反馈；
    // 再慢慢写相册（慢，部分机型要 1-3 秒）。
    // 原来是「等相册写完才 persist 才弹 toast」，用户点完快门要干等
    // 好几秒才知道成没成功，中途还可能以为卡死了。
    persist()

    wx.saveImageToPhotosAlbum({
      filePath: tempFilePath,
      success() {
        // 相册成功是补充信息，不能盖掉「旧记录被清理 / 记录写入失败」
        // 这类后果警告。警告消失后，记录里和相册里都已各有明确反馈。
        if (self._toastLevel === 2 && self.data.toast) return
        self.showToast('已保存到相册')
      },
      fail(err) {
        const msg = (err && err.errMsg) || ''
        const denied = msg.indexOf('auth deny') >= 0 ||
          msg.indexOf('authorize') >= 0 ||
          msg.indexOf('permission') >= 0 ||
          msg.indexOf('cancel') >= 0
        if (denied) {
          self.showToast('已存入记录（相册未授权）', 'warn')
          // 第一次被拒时给一次明确的恢复入口。
          // 只弹 toast 的话用户永远不知道要去哪开权限，
          // 之后每次拍照都静默失败、只留一句「未授权」。
          // 用标记位保证只引导一次，避免每次拍照都弹窗打断。
          if (!self._albumPrompted) {
            self._albumPrompted = true
            if (!self._alive) return
            wx.showModal({
              title: '无法保存到相册',
              content: '发型照片已存进「试戴记录」，但保存到相册需要相册权限。可以在设置里打开。',
              confirmText: '去设置',
              cancelText: '不用了',
              success(r) {
                if (r.confirm) {
                  wx.openSetting({
                    success(res) {
                      // 用户真的打开了就允许下次再提示一次，
                      // 否则他会在下一次拍照时又撞上同一个静默失败
                      if (res.authSetting && res.authSetting['scope.writePhotosAlbum']) {
                        self._albumPrompted = false
                      }
                    }
                  })
                }
              }
            })
          }
        } else if (privacy.isPrivacyError(err)) {
          // 隐私协议里没声明相册，或者用户还没同意。
          // 和「权限被拒」不是一回事：去系统设置里翻也翻不出东西。
          self.showToast('已存入记录，相册保存未开通', 'warn')
        } else {
          self.showToast('已存入记录，相册保存失败', 'warn')
        }
      }
    })
  },

  /* ==================== 分享 ==================== */

  /**
   * 转发当前试戴结果。理发店最典型的传播路径：顾客试到满意的一款，
   * 想发给朋友征求意见 —— 没有这一条就只能截屏，对方看不到动态效果。
   * 带上 style/color 参数，对方点进来直接落在同款发型上
   * （tryon 是非 tabBar 页，path 可以带 query）。
   */
  onShareAppMessage() {
    const style = hairstyles.getStyle(this.data.currentStyle)
    const color = hairstyles.getColor(this.data.currentColor)
    return {
      title: '我刚试了「' + style.name + ' · ' + color.name + '」，点击同款',
      path: '/pages/tryon/tryon?style=' + style.id + '&color=' + color.id
    }
  },

  onShareTimeline() {
    const style = hairstyles.getStyle(this.data.currentStyle)
    const color = hairstyles.getColor(this.data.currentColor)
    // 朋友圈分享**不支持 path**，只能给 query。
    // 之前只写了 title，没带 query：好友在朋友圈看到「蜜茶棕 · 波波头」，
    // 点进来却落在默认的黑发波波头上，图文不符，等于白分享一次。
    // query 里不要写前导 '?'（那是 path 的写法）。
    return {
      title: style.name + ' · ' + color.name + '｜AR 试发型',
      query: 'style=' + style.id + '&color=' + color.id
    }
  },

  /* ==================== 其它交互 ==================== */

  openInfo() {
    const style = hairstyles.getStyle(this.data.currentStyle)
    this.setData({
      showInfo: true,
      info: {
        name: style.name,
        en: style.en,
        tag: style.tag,
        face: style.face,
        desc: style.desc
      }
    })
  },

  closeInfo() {
    this.setData({ showInfo: false })
  },

  noop() {},

  goBack() {
    // 从分享卡片直接进本页时，栈里只有这一层，navigateBack 会失败。
    // nav.back 的兜底就是退回首页 tab。
    nav.back('/pages/index/index')
  },

  goHistory() {
    nav.tab('/pages/history/history')
  },

  /**
   * 轻提示。level='warn' 表示这条信息关系到「东西有没有存下来」。
   *
   * 为什么需要优先级：拍照保存是两条并行链路 ——
   *   persist()  落本地记录（快）
   *   saveImageToPhotosAlbum() 写相册（慢，1~3 秒）
   * 两条各自弹 toast，后弹的会盖掉先弹的。
   * 结果就是「存储空间不足，照片未保存」被一句「已保存到相册」盖掉，
   * 用户以为一切正常，回头在记录页看到灰色的「无照片」占位才发现丢了。
   * 所以 warn 级别在 1.2 秒内不允许被 info 级别覆盖。
   */
  /**
   * 存储满了。用 modal 而不是 toast —— 这条消息带一个用户必须执行的动作。
   *
   * 只弹一次：用户点「稍后」之后不该每次拍照都被拦一次。
   * 但如果他真的去记录页删了东西，再回来拍就不该再被拦 ——
   * 所以标记位在真正存满时重置。
   */
  showStorageFull() {
    if (this._storageFullShown) {
      this.showToast('存储已满，去「试戴记录」删几条旧记录', 'warn')
      return
    }
    this._storageFullShown = true
    const self = this
    wx.showModal({
      title: '照片没存下来',
      content: '本机最多存 20 条试戴记录，现在满了。\n\n去「试戴记录」删掉几条旧的，就能继续保存照片。',
      confirmText: '去记录页',
      cancelText: '稍后',
      success(r) {
        if (!r.confirm) return
        if (!self._alive) return
        // 用户要去删记录了，把标记位放开：下次回来拍照存不下时
        // 还应该再弹一次（他可能只删了一条，仍然不够）
        self._storageFullShown = false
        nav.tab('/pages/history/history')
      }
    })
  },

  showToast(msg, level) {
    // 页面销毁后不要再 setData。拍照合成是异步的，用户完全可能
    // 在「正在生成」期间就返回退出，此时回调里弹 toast 会往
    // 一个不存在的页面写数据。
    if (!this._alive) return
    const self = this
    const lv = level === 'warn' ? 2 : 1
    const now = Date.now()
    if (this._toastLevel === 2 && lv < 2 && now - (this._toastAt || 0) < 1200) return
    this._toastLevel = lv
    this._toastAt = now
    this.setData({ toast: msg })
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(function () {
      self.toastTimer = null
      self._toastLevel = 0
      if (!self._alive) return
      self.setData({ toast: '' })
    }, toastDuration(msg))
  }
})
