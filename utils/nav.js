/**
 * 页面跳转的唯一入口。
 *
 * 为什么不能直接 `wx.navigateTo`：
 *
 * 1) **重复点击会推两个页面。**
 *    首页那个「开始试戴」按钮下面就是相机。用户点一下没反应（相机启动要
 *    300~800ms），很自然会再点一下 —— 两次 navigateTo 各推一个 tryon 页，
 *    栈里同时存在两个 camera 实例。微信的 camera 是独占的，第二个拿不到
 *    摄像头，用户看到的是**黑屏**，而且返回时还会退到另一个黑屏的 tryon 页。
 *
 * 2) **栈满时静默失败。**
 *    navigateTo 最多 10 层，超了只调 fail，不调 success。不接 fail 的话
 *    用户点了一下什么都没发生，会以为小程序卡死了。
 *
 * 3) **跳转本身也会抛。**
 *    url 拼错、页面被删，navigateTo 直接抛异常而不是走 fail。
 */

// 两次跳转的最小间隔。用户不可能在 400ms 内合法地跳两次页面 ——
// 低于这个间隔的一律视为手抖或双击。
const LOCK_MS = 400

let lockAt = 0

function now() {
  return Date.now()
}

/**
 * 栈满的判定。
 * 微信的报错文案换过几次（navigateTo:fail page limit exceeded /
 * exceed max navigate depth / 最多 10 层），所以用宽匹配。
 */
function isStackFull(msg) {
  if (!msg) return false
  const m = String(msg).toLowerCase()
  return m.indexOf('limit') >= 0 ||
    m.indexOf('exceed') >= 0 ||
    m.indexOf('depth') >= 0
}

/**
 * 打开一个页面。
 * @returns {boolean} 是否真的发起了跳转（false = 被防抖挡掉 / 已经抛错）
 */
function to(url) {
  if (typeof url !== 'string' || !url) return false
  const t = now()
  if (t - lockAt < LOCK_MS) return false
  lockAt = t

  try {
    wx.navigateTo({
      url: url,
      fail(err) {
        const msg = (err && err.errMsg) || ''
        if (isStackFull(msg)) {
          // 栈满：换成 redirectTo 顶掉当前页。
          // 对用户来说仍然是「打开了这一页」，只是没有返回栈 ——
          // 比什么都不发生强得多。
          try {
            wx.redirectTo({ url: url, fail() {} })
          } catch (e) {}
          return
        }
        wx.showToast({ title: '页面打开失败', icon: 'none' })
      }
    })
  } catch (e) {
    return false
  }
  return true
}

/** 切换 tab。tab 之间不叠加栈，但同样需要防抖 */
function tab(url) {
  if (typeof url !== 'string' || !url) return false
  const t = now()
  if (t - lockAt < LOCK_MS) return false
  lockAt = t
  try {
    wx.switchTab({ url: url, fail() {} })
  } catch (e) {
    return false
  }
  return true
}

/* ------------------------------------------------------------------
 * 页头让开胶囊按钮
 * ------------------------------------------------------------------ */

/** 拿状态栏高度。getWindowInfo 是新 API，老基础库上不存在 */
function statusBarHeight() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const info = wx.getWindowInfo()
      if (info && typeof info.statusBarHeight === 'number' && info.statusBarHeight > 0) {
        return info.statusBarHeight
      }
    }
  } catch (e) {}
  try {
    const info = wx.getSystemInfoSync()
    if (info && typeof info.statusBarHeight === 'number' && info.statusBarHeight > 0) {
      return info.statusBarHeight
    }
  } catch (e) {}
  // 兜底 20：这是最保守的安卓状态栏高度。宁可页头低一点，
  // 也不能返回 0 —— 返回 0 时页头会顶到屏幕最上沿，被状态栏和时间盖住。
  return 20
}

/**
 * 页头需要的顶部内边距（从屏幕最上沿算起，单位 px）。
 *
 * **为什么要用胶囊而不是状态栏算。**
 * 这几页都是自定义导航栏（`navigationStyle: custom`），微信不会帮我们留位置。
 * 之前统一写 `statusBarHeight + 12`，在 iPhone 上算出来是 56px；
 * 但胶囊按钮的底边在 80px 左右 —— 页头右侧那个按钮正好落在胶囊底下，
 * 用户点下去触发的是微信的「···」和「关闭」，自己的按钮永远点不到。
 * 更糟的是它看起来完全正常，只是「点了没反应」。
 *
 * 所以基准必须取**状态栏底边和胶囊底边里更靠下的那个**。
 * 老基础库上拿不到胶囊（getMenuButtonBoundingClientRect 不存在），
 * 这时退回 `状态栏 + 32`：32 是胶囊的标准高度，够用。
 *
 * @param {number} gap 胶囊底边往下再留多少 px
 */
function topPad(gap) {
  const g = typeof gap === 'number' && isFinite(gap) ? gap : 12
  const sb = statusBarHeight()
  let base = sb + 32
  try {
    if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const r = wx.getMenuButtonBoundingClientRect()
      // 部分安卓机型在特定时刻会返回全 0，这种值不能直接用
      if (r && r.height > 0 && r.bottom > 0) base = r.bottom
    }
  } catch (e) {}
  if (base < sb) base = sb
  return base + g
}

/**
 * 返回。栈里只有一页时（比如从分享卡片直接进 tryon）返回会失败，
 * 这时退到 fallbackUrl。
 */
function back(fallbackUrl) {
  try {
    wx.navigateBack({
      delta: 1,
      fail() {
        if (fallbackUrl) tab(fallbackUrl)
      }
    })
  } catch (e) {
    if (fallbackUrl) tab(fallbackUrl)
  }
}

/** 测试用：清掉防抖锁 */
function _reset() {
  lockAt = 0
}

module.exports = {
  to: to,
  tab: tab,
  back: back,
  topPad: topPad,
  _reset: _reset,
  LOCK_MS: LOCK_MS
}
