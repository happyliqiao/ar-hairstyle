const store = require('../../utils/store')
const hairstyles = require('../../utils/hairstyles')
const swipe = require('../../utils/swipe-guard')
const nav = require('../../utils/nav')

Page({
  data: {
    topPad: 24,
    profile: { nickName: '', avatarUrl: '' },
    stat: { records: 0, favs: 0, days: 1 },
    favStyles: [],
    cloudReady: false,
    cloudLabel: '本机模式'
  },

  onLoad() {
    this._alive = true
    // 收藏横滑列表的误触判定状态
    this._favSwipe = swipe.create()
    // 让开右上角胶囊按钮：自定义导航栏下微信不会帮我们留位置，
    // 原来用 statusBarHeight + 12，页头右侧的按钮正好压在胶囊底下点不到。
    const topPad = nav.topPad(12)

    const app = getApp()
    this.setData({
      topPad: topPad,
      cloudReady: !!app.globalData.cloudReady,
      cloudLabel: app.globalData.cloudReady ? '已连接云端' : '本机模式 · 未开通云同步'
    })
  },

  onShow() {
    this.refresh()
  },

  onUnload() {
    this._alive = false
  },

  /** 头像文件失效（store:// 被系统清理）时退回「+」占位 */
  onAvatarError() {
    const profile = store.getProfile()
    profile.avatarUrl = ''
    store.saveProfile(profile)
    this._favFp = ''
    this.setData({ profile: profile })
  },

  refresh() {
    const profile = store.getProfile()
    const records = store.listRecords()
    const favIds = store.listFavorites()

    // 收藏缩略图是 SVG data URI，一张约 2.9KB。
    // onShow 每次进页面都无条件重建 + setData，等于每次切回「我的」
    // 都白传 30KB 字符串；收藏没变的时候这纯属浪费。
    // 用收藏 id 列表 + 头像 + 昵称做指纹，没变就不重建。
    function fpOf(ids) {
      return ids.join(',') + '|' + (profile.avatarUrl || '') + '|' + (profile.nickName || '')
    }
    const fp = fpOf(favIds)
    let favStyles = this._favStyles || []
    if (fp !== this._favFp) {
      this._favFp = fp
      favStyles = []
      const valid = []
      for (let i = 0; i < favIds.length; i++) {
        const id = favIds[i]
        // 必须用 hasStyle 判存在性，不能用 getStyle 的返回值判。
        // getStyle 对认不出的 id 一律回落 HAIR_STYLES[0]，
        // 所以 `const s = getStyle(id); if (!s) continue` 里的 continue
        // 永远不会执行 —— 收藏里存着一个已下架的 id，卡片上就会出现
        // buzz 的名字和缩略图，而用户根本没收藏过 buzz。
        if (!hairstyles.hasStyle(id)) continue
        valid.push(id)
        favStyles.push({
          id: id,
          name: hairstyles.getStyle(id).name,
          thumb: hairstyles.buildThumb(id, 'black')
        })
      }
      this._favStyles = favStyles
      // 自愈：已下架的 id 不该永远留在 storage 里。
      // 不清的话每次进本页都要 getStyle 失败一遍，而且 stat 的计数
      // 会永远比卡片多 —— 用户看着「收藏 5」数出 3 张卡，
      // 只会觉得这个功能坏了，也找不到地方清理。
      if (valid.length !== favIds.length) {
        store.setFavorites(valid)
        // 指纹要跟着改成「清洗后」的样子。storage 已经被我们改写了，
        // 下一次 onShow 读到的就是 valid；还用脏列表算出来的指纹，
        // 下次进来必然对不上，会白重建一遍缩略图。
        this._favFp = fpOf(valid)
      }
    }

    // key 名不许出现在页面里 —— 第 46 轮把「清除本机数据」改成按前缀扫，
    // 靠的就是「所有 arhair_ key 只在 store.js 里出现」这一条纪律。
    const days = store.getUsageDays()

    this.setData({
      profile: profile,
      favStyles: favStyles,
      stat: {
        records: records.length,
        // 用 favStyles.length 而不是 favIds.length：
        // 计数必须和用户眼睛数得出来的卡片数一致
        favs: favStyles.length,
        days: days
      }
    })
  },

  onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl
    if (!url) return
    const self = this

    // chooseAvatar 返回的是本地临时文件路径，会被系统随时清理。
    // 直接存进 profile 的话，用户过几天再打开就是一张裂图。
    // 先 saveFile 落到持久化目录，再存这个稳定路径。
    // saveFile 失败时退回原路径（至少这次能用），不要因为存盘失败
    // 就让用户点选头像完全没反应。
    let saved = url
    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath: url,
        success(res) {
          // 用户可能选完头像立刻切走了
          if (!self._alive) return
          if (res && res.savedFilePath) saved = res.savedFilePath
          self.commitAvatar(saved)
        },
        fail() {
          if (!self._alive) return
          self.commitAvatar(url)
        }
      })
    } catch (err) {
      if (self._alive) self.commitAvatar(url)
    }
  },

  commitAvatar(avatarUrl) {
    const profile = store.getProfile()
    // 换头像时删掉上一张的持久化文件。
    // 头像文件和试戴照片共享微信 10MB 本地文件配额 —— 不清理的话，
    // 用户换 20 次头像就能把配额吃光，之后试戴照片全部保存失败。
    // 只删 saveFile 产生的 store:// 路径；wxfile:// 是系统托管的临时
    // 路径，删了反而可能误伤，且系统会自己回收。
    const old = profile.avatarUrl
    if (old && old !== avatarUrl && old.indexOf('store://') === 0) {
      try {
        wx.getFileSystemManager().removeSavedFile({
          filePath: old,
          fail() {}
        })
      } catch (e) {}
    }
    profile.avatarUrl = avatarUrl
    store.saveProfile(profile)
    this.setData({ profile: profile })
  },

  onNicknameBlur(e) {
    // maxlength 之外再兜一层：用户可以从别处粘贴超长文本
    let value = (e.detail && e.detail.value) || ''
    // 粘贴进来的内容可能带换行（从微信聊天里复制一段带换行的文字），
    // 单行 input 显示不了，存进去之后再回填就会看到一个怪异的空格块。
    value = value.replace(/[\r\n\t]+/g, ' ').trim()
    // 按**码点**截断而不是按 length。
    // JS 的 length 数的是 UTF-16 码元，一个 emoji（👨‍🦰 这类）占 2 个甚至更多，
    // 直接 slice(0, 20) 有概率切在代理对中间，存进去就是一个乱码方块。
    const cps = Array.from(value)
    if (cps.length > 20) value = cps.slice(0, 20).join('')
    const profile = store.getProfile()
    profile.nickName = value
    store.saveProfile(profile)
    this.setData({ profile: profile })
  },

  onFavTouchStart(e) {
    swipe.start(e, this._favSwipe)
  },

  onFavTouchMove(e) {
    swipe.move(e, this._favSwipe)
  },

  onFavTouchCancel() {
    swipe.cancel(this._favSwipe)
  },

  openFav(e) {
    // 横滑误触保护：滚动收藏列表时不要顺手打开试戴页
    if (swipe.consume(this._favSwipe)) return
    const id = e.currentTarget.dataset.id
    nav.to('/pages/tryon/tryon?style=' + id)
  },

  goGallery() {
    nav.tab('/pages/gallery/gallery')
  },

  showAbout() {
    wx.showModal({
      title: '镜界 AR 试发型',
      content: '实时预览发型与发色，帮你在动剪刀之前先看见结果。\n\n发型与发色为矢量示意渲染，实际效果以发型师现场确认为准。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  showPrivacy() {
    wx.showModal({
      title: '相机与照片说明',
      content: '相机画面只在你本机实时处理，不会上传到任何服务器。\n\n只有你主动按下快门时，才会生成一张合成照片：可保存到相册，同时存入本机试戴记录。你可以随时在「试戴记录」里删除。',
      showCancel: false,
      confirmText: '明白了'
    })
  },

  clearAllData() {
    const self = this
    wx.showModal({
      title: '清除本机数据',
      content: '将删除试戴记录、收藏、头像昵称和微调参数，恢复到刚装好的状态。无法恢复。',
      confirmText: '清除',
      confirmColor: '#e94560',
      success(res) {
        if (!res.confirm) return
        // 一行搞定，别在这里手抄 key 名单。
        // 原来这里是 5 个 removeStorageSync('arhair_xxx_v1')，每加一个
        // 新 key 都得记得回来补 —— 而「记得」从来没成功过：
        // 第 45 轮加的 arhair_last_pick_v1 就没补进去，
        // 用户点了「清除本机数据」，下次进试戴页还是上次那款发型。
        // clearAll 按 arhair_ 前缀扫，将来再加 key 也会自动清掉。
        store.clearAll()
        self._favFp = ''
        self._favStyles = []
        self.refresh()
        wx.showToast({ title: '已清除', icon: 'none' })
      }
    })
  }
})
