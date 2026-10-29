const hairstyles = require('../../utils/hairstyles')
const swipe = require('../../utils/swipe-guard')
const nav = require('../../utils/nav')
const shopHours = require('../../utils/shop-hours')
const privacy = require('../../utils/privacy')

// 营业时间解析在 utils/shop-hours.js，测试台直接测同一份代码
const calcOpenState = shopHours.calcOpenState

Page({
  data: {
    shop: {},
    topPad: 24,
    styleCount: 0,
    colorCount: 0,
    hot: [],
    colors: [],
    shopOpen: null,
    // 隐私授权弹窗（相机是隐私接口，没同意时微信会直接拦住 <camera>）
    privacyOn: false,
    privacyContract: ''
  },

  onLoad() {
    // 热门发型横滑列表的误触判定状态
    this._hotSwipe = swipe.create()
    // getApp() 理论上一定有值，但这一页是小程序码的落地页：
    // 店门口立牌上的二维码扫进来，这里抛异常就是一片白屏，
    // 顾客站在门口看着白屏，什么信息都拿不到。
    // 所以整段都做防御，拿不到就用空对象继续渲染。
    let app = null
    try {
      app = getApp()
    } catch (e) {
      app = null
    }
    const shop = (app && app.globalData && app.globalData.shop) || {}
    // 让开右上角胶囊按钮：自定义导航栏下微信不会帮我们留位置，
    // 原来用 statusBarHeight + 12，页头右侧的按钮正好压在胶囊底下点不到。
    const topPad = nav.topPad(12)

    const hot = []
    const all = hairstyles.HAIR_STYLES
    const limit = Math.min(6, all.length)
    for (let i = 0; i < limit; i++) {
      const s = all[i]
      hot.push({
        id: s.id,
        name: s.name,
        tag: s.tag,
        face: s.face,
        thumb: hairstyles.buildThumb(s.id, 'black')
      })
    }

    this.setData({
      shop: shop,
      topPad: topPad,
      styleCount: all.length,
      colorCount: hairstyles.HAIR_COLORS.length,
      hot: hot,
      colors: hairstyles.HAIR_COLORS,
      shopOpen: calcOpenState(shop.hours)
    })
  },

  /**
   * 回到首页时重算营业状态，并开始盯着时间。
   *
   * 原来首页一个生命周期钩子都没有，营业状态只在 onLoad 算一次。
   * 二维码就印在店门口的立牌上，顾客扫进来很可能是傍晚六点 ——
   * 而店员早上十点就把这个小程序开着摆在台面上了。
   * 于是 22:00 打烊之后，首页仍然写着「营业中 · 22:00 打烊」，
   * 顾客推门进来发现已经关门。这是这个页面上代价最高的一种错误。
   */
  onShow() {
    this.refreshShopState()
    this.startShopClock()
  },

  onHide() {
    this.stopShopClock()
  },

  onUnload() {
    this.stopShopClock()
  },

  /**
   * 30 秒一次足够。状态只有「营业中 / 已打烊」两种，
   * 跨点的误差不会超过 30 秒；而 30 秒一次的 setInterval 成本可以忽略。
   * 用「算出下次切换时刻再 setTimeout」当然更精确，但那要处理跨夜、
   * 时钟回拨、用户改系统时间三种情况，代码量翻几倍换不来实际体验。
   */
  startShopClock() {
    const self = this
    this.stopShopClock()
    this._shopTimer = setInterval(function () {
      self.refreshShopState()
    }, 30000)
  },

  stopShopClock() {
    if (this._shopTimer) {
      clearInterval(this._shopTimer)
      this._shopTimer = null
    }
  },

  /** 只在状态真的变了才 setData，避免每 30 秒白刷一次视图 */
  refreshShopState() {
    let next = null
    try {
      const app = getApp()
      const hours = app && app.globalData && app.globalData.shop && app.globalData.shop.hours
      next = calcOpenState(hours)
    } catch (e) {
      next = null
    }
    const cur = this.data.shopOpen
    const same = (!cur && !next) ||
      (cur && next && cur.open === next.open && cur.hint === next.hint)
    if (!same) this.setData({ shopOpen: next })
  },

  /**
   * 进试戴页。
   *
   * **不能直接 nav.to。** 相机是隐私接口：用户没同意过隐私协议时，
   * 微信不弹任何系统提示，直接把 `<camera>` 拦掉 —— 用户看到的是
   * 「一片黑 + 相机启动失败」，而 `getSetting` 里 `scope.camera`
   * 明明是 true，点「开启相机」也永远好不了。
   *
   * 所以在跳转**之前**问一次。同意完再跳，用户全程看不到那个黑屏。
   */
  goTryon(url) {
    const self = this
    privacy.check(function (need, contractName) {
      if (!need) {
        nav.to(url)
        return
      }
      self.setData({ privacyOn: true, privacyContract: contractName })
      // 记住这次要去的地址：用户同意后直接跳过去，
      // 而不是把他扔回首页让他自己再点一次
      self._pendingTryonUrl = url
    })
  },

  startTryon() {
    this.goTryon('/pages/tryon/tryon')
  },

  onPrivacyAgree() {
    const url = this._pendingTryonUrl || '/pages/tryon/tryon'
    this._pendingTryonUrl = ''
    this.setData({ privacyOn: false })
    nav.to(url)
  },

  onPrivacyCancel() {
    this._pendingTryonUrl = ''
    this.setData({ privacyOn: false })
    // 不说「已取消」——用户没做错什么。给他另一条路走。
    wx.showToast({ title: '不进相机也能逛发型库', icon: 'none' })
  },

  /* 热门发型横滑：滑动时不触发卡片点击 */
  onHotTouchStart(e) {
    swipe.start(e, this._hotSwipe)
  },

  onHotTouchMove(e) {
    swipe.move(e, this._hotSwipe)
  },

  onHotTouchCancel() {
    swipe.cancel(this._hotSwipe)
  },

  openStyle(e) {
    // 横滑误触保护：用户滚动列表时不要顺手打开试戴页
    if (swipe.consume(this._hotSwipe)) return
    const id = e.currentTarget.dataset.id
    this.goTryon('/pages/tryon/tryon?style=' + id)
  },

  openColor(e) {
    const id = e.currentTarget.dataset.id
    this.goTryon('/pages/tryon/tryon?color=' + id)
  },

  goGallery() {
    nav.tab('/pages/gallery/gallery')
  },

  callShop() {
    const shop = this.data.shop
    if (!shop || !shop.phone) return
    wx.makePhoneCall({
      phoneNumber: shop.phone.replace(/-/g, ''),
      fail(err) {
        const msg = (err && err.errMsg) || ''
        if (/cancel/i.test(msg)) return
        wx.showToast({ title: '暂时无法拨打电话，请稍后再试', icon: 'none' })
      }
    })
  }
})
