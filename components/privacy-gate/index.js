/**
 * 隐私协议授权弹窗。
 *
 * 为什么是一个组件而不是两段 wxml：
 * 首页（点「开始试戴」之前）和试戴页（相机被拦时）都要弹同一个东西，
 * 而里面的「同意」按钮**必须**是 `<button open-type="agreePrivacyAuthorization">`
 * —— 微信只认这个 open-type，用 view 加 bindtap 点一百次也不会记下同意。
 * 两处各写一份的话，迟早有一处写成 view。
 */
const privacy = require('../../utils/privacy')

Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    /** 协议在 mp 后台的名字，没拿到就用通用说法 */
    contractName: {
      type: String,
      value: ''
    },
    confirmText: {
      type: String,
      value: '同意并继续'
    },
    /** 允许「暂不」：首页可以，试戴页进来时也可以（退回首页） */
    showCancel: {
      type: Boolean,
      value: true
    }
  },

  data: {
    explain: privacy.EXPLAIN
  },

  methods: {
    /**
     * 用户点了「同意并继续」。
     *
     * 两条路都会到这里：
     *   bindagreeprivacyauthorization —— 正常路径，微信记下同意后触发
     *   bindtap                       —— 兜底。如果 mp 后台没配隐私指引，
     *     微信不认这个 open-type，同意事件永远不触发，按钮就成了死键。
     *     这种情况下其实也没有拦截，放行是对的。
     * 用 _settled 去重，避免两条路都走一遍导致跳两次页。
     */
    onAgree() {
      if (this._settled) return
      this._settled = true
      this.triggerEvent('agree')
    },

    onCancel() {
      if (this._settled) return
      this._settled = true
      this.triggerEvent('cancel')
    },

    openContract() {
      privacy.openContract()
    },

    /** 点遮罩不关。这是授权弹窗，必须明确选一个 —— 误触关掉后
     *  用户会以为「已经同意了」，下次又撞墙。 */
    noop() {}
  }
})
