/**
 * 微信隐私协议授权。
 *
 * 为什么单独拎出来做一轮：
 *
 * 2023-09-15 之后，微信要求涉及用户信息的接口必须先在 mp 后台配好
 * 《小程序用户隐私保护指引》，且用户得**主动点过一次同意**。
 * 这个小程序里有两个这样的接口：
 *
 *   camera                —— 试戴页的主体
 *   saveImageToPhotosAlbum —— 快门后的保存
 *
 * 没同意时微信不会弹任何系统提示，它**直接拦住接口**：
 * `<camera>` 不出画面，`binderror` 里给一条 errno 112 的错。
 * 从用户角度看，就是「进了试戴页，一片黑，写着相机启动失败」，
 * 点「开启相机」也没用 —— 因为相机权限明明是开着的。
 *
 * 更麻烦的是这条路走不通时**看不出原因**：`getSetting` 里
 * `scope.camera` 返回 true，我们所有权限判断都通过，画面还是没有。
 *
 * 所以策略是：**在进相机页之前就问**，别让用户先撞墙再看到弹窗。
 */

/** errno 112：调用的接口没有在《隐私保护指引》里声明 */
const ERRNO_NOT_DECLARED = 112

function supported() {
  return typeof wx.getPrivacySetting === 'function'
}

/**
 * 查一下还需不需要用户同意。
 *
 * 三种情况都必须放行：
 *   1) 老基础库没有这个 API —— 那时微信根本不检查，相机直接能用
 *   2) 用户已经同意过 —— needAuthorization 为 false
 *   3) **查不到**（接口 fail / 超时）—— 不能因为拿不到状态就把用户
 *      挡在门外。真被拦了，相机那边还有一层错误兜底。
 *
 * @param {function(boolean, string)} cb  (需要授权?, 协议名称)
 */
function check(cb) {
  const done = typeof cb === 'function' ? cb : function () {}
  if (!supported()) {
    done(false, '')
    return
  }

  let settled = false
  function finish(need, name) {
    if (settled) return
    settled = true
    done(!!need, typeof name === 'string' ? name : '')
  }

  try {
    wx.getPrivacySetting({
      success(res) {
        finish(!!(res && res.needAuthorization), res && res.privacyContractName)
      },
      fail() {
        finish(false, '')
      }
    })
  } catch (e) {
    finish(false, '')
  }

  // getPrivacySetting 在个别机型上既不 success 也不 fail（被安全键盘、
  // 分屏之类的系统弹层卡住）。1.2 秒后无条件放行 —— 这里等下去没有意义，
  // 用户只会盯着一个转不动的按钮。
  setTimeout(function () {
    finish(false, '')
  }, 1200)
}

/**
 * 打开微信官方的《隐私保护指引》。
 * 这是我们自己写不了的页面 —— 内容在 mp 后台维护，必须调官方接口。
 */
function openContract() {
  if (typeof wx.openPrivacyContract !== 'function') {
    wx.showToast({ title: '当前微信版本不支持查看', icon: 'none' })
    return
  }
  wx.openPrivacyContract({
    fail() {
      // 后台还没配隐私指引时会走到这里。文案不能说「打开失败」——
      // 用户会以为是网络问题，反复点。
      wx.showToast({ title: '暂未配置隐私指引', icon: 'none' })
    }
  })
}

/**
 * 这个错误是不是「隐私协议没同意」造成的。
 *
 * 各个接口的 errMsg 文案不统一（camera 组件走 binderror，
 * 保存相册走 fail），所以同时看 errno 和文案。
 */
function isPrivacyError(err) {
  if (!err) return false
  const errno = typeof err.errno === 'number'
    ? err.errno
    : (typeof err.errCode === 'number' ? err.errCode : 0)
  if (errno === ERRNO_NOT_DECLARED) return true

  const msg = String(err.errMsg || err.message || err.msg || '')
  if (!msg) return false
  const m = msg.toLowerCase()
  return m.indexOf('privacy') >= 0 ||
    m.indexOf('scope is not declared') >= 0 ||
    m.indexOf('not authorized by privacy') >= 0
}

/** 相机和相册都是隐私接口，文案里点明「本机处理、不上传」 */
const EXPLAIN = '试戴需要打开摄像头。画面只在你手机上实时处理，不会上传到任何服务器。\n\n只有你主动按下快门时，才会生成一张照片：可存到相册，同时存进本机试戴记录。'

module.exports = {
  supported: supported,
  check: check,
  openContract: openContract,
  isPrivacyError: isPrivacyError,
  EXPLAIN: EXPLAIN,
  ERRNO_NOT_DECLARED: ERRNO_NOT_DECLARED
}
