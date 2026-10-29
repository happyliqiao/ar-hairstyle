const store = require('../../utils/store')
const hairstyles = require('../../utils/hairstyles')
const nav = require('../../utils/nav')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function formatTime(ts) {
  // 兜底：store 层已经会清洗掉 createdAt 非法的记录，
  // 但这里再防一层 —— 万一有别的路径传进来，也别把
  // 「NaN/NaN/NaN NaN:NaN」这种字符串怼到用户脸上。
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '时间未知'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '时间未知'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()

  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (sameDay) return '今天 ' + hm

  const yest = new Date(now.getTime() - 86400000)
  const isYest =
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  if (isYest) return '昨天 ' + hm

  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hm
}

/**
 * 从一条记录拼出「回试戴页重拍」的地址。
 *
 * 记录里的 styleId/colorId 可能是**已下架**的那一款（版本更新后发型库
 * 会变）。直接把 id 拼进 URL，tryon 那边 getStyle 会静默回落到 bob ——
 * 用户看到的是一个从没试过的发型，还以为记录错了。
 * 所以只带还存在的参数，剩下的交给 tryon 用它自己的默认值。
 */
function tryonUrlFor(item) {
  const q = []
  if (item && hairstyles.hasStyle(item.styleId)) q.push('style=' + item.styleId)
  if (item && hairstyles.hasColor(item.colorId)) q.push('color=' + item.colorId)
  return '/pages/tryon/tryon' + (q.length ? '?' + q.join('&') : '')
}

Page({
  data: {
    topPad: 24,
    records: []
  },

  onLoad(options) {
    // 生命周期标志：延迟回调执行前检查，避免往已销毁的页面写数据
    this._alive = true
    // 让开右上角胶囊按钮：自定义导航栏下微信不会帮我们留位置，
    // 原来用 statusBarHeight + 12，页头右侧的按钮正好压在胶囊底下点不到。
    const topPad = nav.topPad(12)
    this.setData({ topPad: topPad })

    // 从转发卡片进来：定位到被分享的那条记录。
    // 没有这一段，对方点开会落在列表顶部，还得自己翻。
    if (options && options.record) {
      this._pendingRecordId = options.record
    }
  },

  onShow() {
    this.refresh()
    if (this._pendingRecordId) {
      const id = this._pendingRecordId
      this._pendingRecordId = ''
      // 等列表渲染出来再打开预览，否则 previewImage 找不到文件。
      // 存字段：用户可能在这 300ms 内就返回退出了，
      // 未跟踪的回调会往已销毁的页面上弹 previewImage。
      const self = this
      if (this._openTimer) clearTimeout(this._openTimer)
      this._openTimer = setTimeout(function () {
        self._openTimer = null
        if (!self._alive) return
        self.openRecordById(id)
      }, 300)
    }
  },

  onUnload() {
    this._alive = false
    if (this._openTimer) {
      clearTimeout(this._openTimer)
      this._openTimer = null
    }
  },

  openRecordById(id) {
    const item = this.findRecord(id)
    if (!item) {
      // 记录已被删除（分享出去很久之后才被点开）
      wx.showToast({ title: '这条记录已不存在', icon: 'none' })
      return
    }
    if (item.photoPath) {
      const urls = []
      for (let i = 0; i < this.data.records.length; i++) {
        if (this.data.records[i].photoPath) urls.push(this.data.records[i].photoPath)
      }
      wx.previewImage({
        current: item.photoPath,
        urls: urls,
        fail() {
          // 照片文件已失效时 previewImage 会静默失败 ——
          // 用户点了一下卡片，什么都没发生，只能反复点。
          wx.showToast({ title: '照片已失效，仅保留记录', icon: 'none' })
        }
      })
    } else {
      nav.to(tryonUrlFor(item))
    }
  },

  refresh() {
    const raw = store.listRecords()
    // 脏检查：previewImage 是全屏原生组件，用户看完大图返回时也会走
    // onShow。此时记录一条都没变，但无条件 refresh 会让 20 张图片
    // 全部重新解码，列表明显闪一下，低端机上尤其难看。
    // 用 id + photoPath 做指纹，没变就直接返回。
    // 前缀不能省：空列表时 join 出来是空字符串，
    // 而 _lastKey 的初始值也是 undefined/'', 两者容易被当成「没变化」
    // 而跳过刷新，结果是「清空后列表还显示着旧记录」。
    const key = 'v1|' + raw.map(function (r) {
      return r.id + ':' + r.photoPath + ':' + r.thumbPath
    }).join(',')
    if (key === this._lastKey) return
    this._lastKey = key

    const list = []
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]
      // 用 hasColor 判存在性，不能用 getColor 的返回值 —— 它对认不出的
      // id 一律回落 HAIR_COLORS[0]，结果是一条「蜜茶棕」的记录
      // 在色点上显示成黑色，用户以为记录串了。
      const color = hairstyles.hasColor(r.colorId) ? hairstyles.getColor(r.colorId) : null
      list.push({
        id: r.id,
        styleId: r.styleId,
        colorId: r.colorId,
        styleName: r.styleName,
        colorName: r.colorName,
        photoPath: r.photoPath,
        // 列表用缩略图，点开大图才用 photoPath。
        // 老记录没有 thumbPath（归一成空串），退回原图。
        thumbPath: r.thumbPath || r.photoPath,
        // 色点没有就整块不画（wxml 里 wx:if），不要给个错颜色。
        // colorName 仍然照常显示 —— 那是**拍下那一刻**的名字，
        // 属于历史事实，不该因为后来改了名字就抹掉。
        swatch: color ? color.swatch : '',
        timeText: formatTime(r.createdAt)
      })
    }
    this.setData({ records: list })
  },

  openRecord(e) {
    // 长按删除之后抬手，微信仍会再派发一次 tap。
    // 不拦住的话「长按 → 弹删除确认框」的同时，大图预览也盖上来，
    // 两个界面叠在一起，用户点哪都不是。
    if (this._suppressTap) {
      this._suppressTap = false
      return
    }
    // 用 id 定位而不是 index。列表可能刚被删除过，
    // index 会指向错误的记录，用户点第二条结果打开第一条的照片。
    const id = e.currentTarget.dataset.id
    let item = null
    for (let i = 0; i < this.data.records.length; i++) {
      if (this.data.records[i].id === id) { item = this.data.records[i]; break }
    }
    if (!item) return

    if (item.photoPath) {
      const urls = []
      for (let i = 0; i < this.data.records.length; i++) {
        if (this.data.records[i].photoPath) urls.push(this.data.records[i].photoPath)
      }
      wx.previewImage({
        current: item.photoPath,
        urls: urls,
        fail() {
          wx.showToast({ title: '照片已失效，仅保留记录', icon: 'none' })
        }
      })
    } else {
      nav.to(tryonUrlFor(item))
    }
  },

  confirmRemove(e) {
    this._suppressTap = true
    const id = e.currentTarget.dataset.id
    const self = this
    wx.showModal({
      title: '删除这条记录',
      content: '删除后照片也会一并清理，无法恢复。',
      confirmText: '删除',
      confirmColor: '#e94560',
      success(res) {
        if (!res.confirm || !self._alive) return
        store.removeRecord(id)
        self.refresh()
        wx.showToast({ title: '已删除', icon: 'none' })
      }
    })
  },

  clearAll() {
    const self = this
    wx.showModal({
      title: '清空全部记录',
      content: '将删除 ' + this.data.records.length + ' 条记录及其照片，无法恢复。',
      confirmText: '清空',
      confirmColor: '#e94560',
      success(res) {
        if (!res.confirm || !self._alive) return
        store.clearRecords()
        self.refresh()
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  },

  goTryon() {
    nav.to('/pages/tryon/tryon')
  },

  /**
   * 转发某条试戴记录。带上 id，对方点进来直接定位到这条记录，
   * 而不是落到一个空列表上。照片同时作为分享卡片封面。
   */
  onShareAppMessage(e) {
    const id = (e && e.from === 'button' && e.target && e.target.dataset)
      ? e.target.dataset.id
      : ''
    const item = id ? this.findRecord(id) : null
    if (!item) {
      return { title: '我的试戴记录', path: '/pages/history/history' }
    }
    const payload = {
      title: item.styleName + ' · ' + item.colorName + '｜点我试同款',
      // 不能分享 /history?record=本机ID：接收者的 storage 里没有这条记录，
      // 他点开只会看到「记录不存在」。照片做卡片封面，落地页给同款试戴。
      path: tryonUrlFor(item)
    }
    // 没有照片时不要传 imageUrl: ''，空串会被当成「有封面但加载失败」，
    // 卡片右上角留一块灰底；省略字段才会自动截取页面首屏。
    if (item.photoPath) payload.imageUrl = item.photoPath
    return payload
  },

  /**
   * 照片文件加载失败。
   *
   * 微信会把 saveFile 存下来的文件当「缓存」管理，长期不打开或系统空间
   * 紧张时会被清掉，而 storage 里的记录还在。此时 <image> 加载失败，
   * 没有 binderror 就是一片空白。
   * 这里只改内存里的这一份（把 photoPath 清空 → 立刻变成「无照片」占位），
   * 不动 storage：万一是临时读取失败（比如正在被相册写入），
   * 下次进页面还能再试一次。
   */
  onImgError(e) {
    const id = e.currentTarget.dataset.id
    const list = this.data.records
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        if (!list[i].photoPath && !list[i].thumbPath) return
        // 列表实际加载的是缩略图。只有小图失效、主图还在时，
        // 应该退回主图，而不是把主图也一起隐藏——用户明明拍过照片。
        if (list[i].thumbPath && list[i].photoPath && list[i].thumbPath !== list[i].photoPath) {
          list[i].thumbPath = ''
        } else {
          list[i].photoPath = ''
          list[i].thumbPath = ''
        }
        // 指纹也要同步改，否则下次 onShow 的脏检查会认为「没变化」
        this._lastKey = ''
        this.setData({ records: list })
        return
      }
    }
  },

  findRecord(id) {
    for (let i = 0; i < this.data.records.length; i++) {
      if (this.data.records[i].id === id) return this.data.records[i]
    }
    return null
  },

  /** 分享按钮的冒泡拦截：只弹分享面板，不打开大图预览 */
  noop() {}
})
