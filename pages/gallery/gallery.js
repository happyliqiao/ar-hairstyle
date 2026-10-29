const hairstyles = require('../../utils/hairstyles')
const store = require('../../utils/store')
const swipe = require('../../utils/swipe-guard')
const nav = require('../../utils/nav')

Page({
  data: {
    topPad: 24,
    total: 0,
    colors: [],
    previewColor: 'black',
    styles: []
  },

  onLoad() {
    // 预览发色横滑列表的误触判定状态
    this._previewSwipe = swipe.create()
    // 让开右上角胶囊按钮：自定义导航栏下微信不会帮我们留位置，
    // 原来用 statusBarHeight + 12，页头右侧的按钮正好压在胶囊底下点不到。
    const topPad = nav.topPad(12)

    this.setData({
      topPad: topPad,
      total: hairstyles.HAIR_STYLES.length,
      colors: hairstyles.HAIR_COLORS
    })
    this.buildList('black')
  },

  onShow() {
    // 收藏状态可能在试戴页发生变化，回到本页时刷新。
    // 但没必要每次 onShow 都重建整个列表并 setData 50KB 缩略图 ——
    // 用户从试戴页返回时大概率什么都没改，白传一遍大字符串
    // 在真机上就是一次可感的卡顿。
    // 只在「收藏集合」或「预览发色」真的变了时才重建。
    const favKey = store.listFavorites().join(',')
    if (favKey === this._lastFavKey && this.data.previewColor === this._lastColor) return
    this.buildList(this.data.previewColor)
  },

  buildList(colorId) {
    const favs = store.listFavorites()
    this._lastFavKey = favs.join(',')
    this._lastColor = colorId
    const list = []
    const all = hairstyles.HAIR_STYLES
    for (let i = 0; i < all.length; i++) {
      const s = all[i]
      list.push({
        id: s.id,
        name: s.name,
        tag: s.tag,
        face: s.face,
        fav: favs.indexOf(s.id) >= 0,
        thumb: hairstyles.buildThumb(s.id, colorId)
      })
    }
    this.setData({ styles: list, previewColor: colorId })
  },

  onPreviewTouchStart(e) {
    swipe.start(e, this._previewSwipe)
  },

  onPreviewTouchMove(e) {
    swipe.move(e, this._previewSwipe)
  },

  onPreviewTouchCancel() {
    swipe.cancel(this._previewSwipe)
  },

  pickPreviewColor(e) {
    // 横滑误触保护：滚动色带时不要顺手切换预览发色 ——
    // 那会触发 10 张缩略图重建，列表连续闪。
    if (swipe.consume(this._previewSwipe)) return
    const id = e.currentTarget.dataset.id
    if (id === this.data.previewColor) return

    // 选中态立刻更新（视觉反馈要即时），但 10 张缩略图的重建
    // 会传输约 51KB。用户连续划色带时每换一次就传一次，明显卡顿。
    // 500ms 防抖：停下来之后再重建。
    this.setData({ previewColor: id })
    this._lastColor = id
    const self = this
    if (this._thumbTimer) clearTimeout(this._thumbTimer)
    this._thumbTimer = setTimeout(function () {
      self._thumbTimer = null
      self.buildList(self.data.previewColor)
    }, 500)
  },

  onUnload() {
    if (this._thumbTimer) {
      clearTimeout(this._thumbTimer)
      this._thumbTimer = null
    }
  },

  openStyle(e) {
    // 长按收藏之后抬手，微信仍会再派发一次 tap。
    // 不拦住的话「长按收藏」会顺手把用户带进试戴页 ——
    // 他只是想收藏，结果页面跳走了，回来还得重新滚到那一款。
    if (this._suppressTap) {
      this._suppressTap = false
      return
    }
    const id = e.currentTarget.dataset.id
    nav.to('/pages/tryon/tryon?style=' + id + '&color=' + this.data.previewColor)
  },

  /**
   * 长按卡片直接收藏。原来只能进试戴页点快门旁的 ☆，
   * 用户在发型库浏览时看到喜欢的必须先进去才能收，多一步。
   */
  toggleFav(e) {
    this._suppressTap = true
    const id = e.currentTarget.dataset.id
    const on = store.toggleFavorite(id)
    // 只更新这一颗星，不重建整个列表（重建会重取 10 张缩略图）
    const styles = this.data.styles
    for (let i = 0; i < styles.length; i++) {
      if (styles[i].id === id) {
        styles[i] = { id: styles[i].id, name: styles[i].name, tag: styles[i].tag, face: styles[i].face, fav: on, thumb: styles[i].thumb }
        break
      }
    }
    this.setData({ styles: styles })
    this._lastFavKey = store.listFavorites().join(',')
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  /**
   * 分享发型库/当前预览发色。店员最常用：把某一款发型直接发给顾客，
   * 顾客点进来已经选好发色，不用自己再翻一遍 12 个色。
   */
  onShareAppMessage() {
    const color = hairstyles.getColor(this.data.previewColor)
    return {
      title: hairstyles.HAIR_STYLES.length + ' 款发型 · 当前预览「' + color.name + '」',
      path: '/pages/tryon/tryon?color=' + color.id
    }
  }
})
