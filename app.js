const cloudModule = require('./utils/cloud')

App({
  globalData: {
    cloud: cloudModule.cloud,
    cloudReady: cloudModule.isReady,
    pendingStyleId: '',
    shop: {
      name: '镜界造型',
      branch: '静安旗舰店',
      address: '南京西路 1266 号 3F',
      phone: '021-6288-8899',
      hours: '10:00 - 22:00'
    }
  },

  onLaunch() {
    // 记录一次启动，便于「我的」页展示使用天数
    try {
      const key = 'arhair_first_launch'
      if (!wx.getStorageSync(key)) {
        wx.setStorageSync(key, Date.now())
      }
      const n = Number(wx.getStorageSync('arhair_launch_count') || 0) + 1
      wx.setStorageSync('arhair_launch_count', n)
    } catch (e) {
      // 忽略存储异常，不影响主流程
    }

    if (!this.globalData.cloudReady) {
      console.info('[App] 云端能力未开启，当前以本机模式运行')
    }

    // 回收没人引用的照片文件。
    //
    // saveFile 的总配额只有 10MB。删记录时 removeSavedFile 偶尔会失败
    // （文件被系统占用、清理过程中被中断），那些文件就永远留在磁盘上，
    // 没有任何记录指向它们 —— 用户看不到、也删不掉，但配额照占。
    // 攒够之后每次拍照都提示「存储空间不足」，而用户什么都没做错。
    //
    // 放在启动时跑：此刻一定没有拍照流程在途，不会误删刚存好的照片。
    // 内部还留了 2 分钟的创建时间保护，双保险。
    try {
      require('./utils/store').collectGarbage()
    } catch (e) {
      console.warn('[App] 回收照片文件失败', e)
    }

    this.checkUpdate()
  },

  /**
   * 版本更新检查。
   *
   * 小程序的更新机制有个很容易被忽略的点：冷启动时在后台下载新版本，
   * **但新版本要等下一次冷启动才生效**。也就是说用户当天一直用着旧版 ——
   * 店主上午把营业时间从「10:00-22:00」改成「09:30-21:00」，
   * 店员下午扫码进来看到的还是旧时间，回头一句「我明明改过了」。
   * 对店里这种「改一次就要马上全员生效」的场景，不提示就等于没更新。
   *
   * 弹窗时机也要挑：用户正举着手机对准脸调发型时弹一个模态框，
   * 他顺手点「立即重启」，页面就重开回首页，调好的东西全丢。
   * 所以正在试戴页时先记下来，等他离开那一页再问。
   */
  checkUpdate() {
    if (typeof wx.getUpdateManager !== 'function') return
    let mgr = null
    try {
      mgr = wx.getUpdateManager()
    } catch (e) {
      // 低版本基础库 / 部分定制环境没有这个能力，静默跳过
      return
    }
    if (!mgr) return
    this._updateManager = mgr

    const self = this
    try {
      mgr.onCheckForUpdate(function (res) {
        if (res && res.hasUpdate) console.info('[App] 发现新版本，后台下载中')
      })
      mgr.onUpdateReady(function () {
        console.info('[App] 新版本已就绪')
        if (self.isBusy()) {
          self._pendingUpdate = true
          return
        }
        self.promptUpdate()
      })
      mgr.onUpdateFailed(function () {
        console.warn('[App] 新版本下载失败，本次仍使用当前版本')
      })
    } catch (e) {
      console.warn('[App] 更新管理器挂载失败', e)
    }
  },

  /** 用户是不是正在做「重启会丢东西」的事 */
  isBusy() {
    let cur = null
    try {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      cur = pages && pages.length ? pages[pages.length - 1] : null
    } catch (e) {
      return false
    }
    if (!cur) return false
    const route = cur.route || cur.__route__ || ''
    return route.indexOf('pages/tryon/') >= 0
  },

  /** 询问是否重启到新版本。已经问过就不重复问 */
  promptUpdate() {
    const mgr = this._updateManager
    if (!mgr || typeof mgr.applyUpdate !== 'function') return
    if (this._updating) return
    this._updating = true
    this._pendingUpdate = false
    const self = this
    wx.showModal({
      title: '有新版本',
      content: '新版本已下载完成，重启后生效。重启会回到首页。',
      confirmText: '立即重启',
      cancelText: '稍后',
      success(res) {
        if (res && res.confirm) {
          mgr.applyUpdate()
          return
        }
        // 用户选了「稍后」：下次冷启动会自动用新版，这里不用做别的。
        // 但要把 _updating 放开，否则他切出去再进来就再也不问了
        self._updating = false
      },
      fail() {
        self._updating = false
      }
    })
  },

  /**
   * 把挂起的更新提示补上。
   * 由试戴页在 onHide 时调用 —— 那一刻用户已经离开「会丢东西」的页面。
   */
  flushUpdate() {
    if (!this._pendingUpdate) return
    if (this.isBusy()) return
    this.promptUpdate()
  },

  /**
   * 全局默认转发。页面自己没有定义 onShareAppMessage 时走这里，
   * 否则右上角「··· → 转发」会分享出一个没有标题、没有封面图的
   * 空卡片，对方点进去也不知道这是什么。
   */
  onShareAppMessage() {
    const shop = this.globalData.shop || {}
    // 不要写 imageUrl: '' —— 空字符串会让微信按「有封面但加载失败」处理，
    // 卡片右上角留一块灰底；省略该字段才会走「自动截取页面首屏」。
    return {
      title: (shop.name || '镜界造型') + ' · AR 试发型，扫码看新发型',
      path: '/pages/index/index'
    }
  },

  /** 朋友圈分享：没有封面图时微信会自动截取页面首屏 */
  onShareTimeline() {
    const shop = this.globalData.shop || {}
    return {
      title: (shop.name || '镜界造型') + ' · AR 试发型'
    }
  },

  /**
   * 页面不存在时的兜底。
   *
   * 这个回调不是可选项：小程序码印在店门口立牌上、老顾客收藏的转发卡片、
   * 或者我们以后改页面路径，都会让用户落在一个不存在的路由上。
   * 没有 onPageNotFound 的话，微信显示的是它自己的「页面不存在」白屏，
   * 用户点返回就直接退出小程序 —— 到店的人当场卡在门口。
   * 这里直接换到首页，至少还能看到店名、地址、营业时间。
   */
  onPageNotFound(res) {
    console.warn('[App] 页面不存在', res && res.path)
    wx.switchTab({
      url: '/pages/index/index',
      fail() {
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  },

  /**
   * 全局 JS 错误兜底。
   *
   * 小程序的错误不会弹给用户（这点是好的），但也意味着线上出问题时
   * 我们只能靠日志。至少把页面路径和错误栈打出来，
   * 而不是让它在控制台里一闪而过。
   */
  onError(err) {
    console.error('[App] 未捕获错误', err)
  },

  /** 未处理的 Promise rejection。异步链路里最容易被吞掉的一类错误 */
  onUnhandledRejection(res) {
    console.error('[App] 未处理的 Promise 异常', res && res.reason)
  },

  /**
   * 系统内存告警。
   *
   * 不接这个回调的后果很具体：低端机 / 老 iPhone 在试戴页停留久了，
   * 常驻内存是「5 张烘焙位图 8.2MB + 4 款分桶路径 6MB + 几何缓存 + camera 预览」。
   * 系统先发 level 10，我们什么都不做；再发 level 15，
   * 微信会在几秒内直接销毁小程序 —— 用户看到的是「切了两款发型，
   * 小程序自己没了」，刚拍的照片如果还没落盘就一起没了。
   *
   * 这里做两件事：把能还的加速缓存全部还掉、进入低内存模式
   * （之后不再烘焙，退回矢量直绘），然后通知当前页面重画一帧。
   */
  onMemoryWarning(res) {
    const level = (res && res.level) || 10
    console.warn('[App] 内存告警 level=' + level)
    try {
      require('./utils/hairstyles').setLowMemory(true)
    } catch (e) {
      console.error('[App] 释放渲染缓存失败', e)
    }
    // 让当前页面知道这件事：只有它知道自己该不该重画、要不要停掉定时器
    let cur = null
    try {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      cur = pages && pages.length ? pages[pages.length - 1] : null
    } catch (e) {}
    if (cur && typeof cur.onMemoryLow === 'function') {
      try {
        cur.onMemoryLow(level)
      } catch (e) {
        console.error('[App] onMemoryLow 处理失败', e)
      }
    }
  }
})
