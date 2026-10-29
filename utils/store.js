/**
 * 本地数据层（试戴记录 / 收藏 / 客户档案）
 *
 * 说明：目前使用小程序本地存储 + 本地文件系统保存试戴照片。
 * 云服务开通后，可在此文件的 addRecord / listRecords / removeRecord 中
 * 追加 cloud.database 调用，实现多设备同步；本地实现可作为离线兜底保留。
 */

const KEY_RECORDS = 'arhair_records_v1'
const KEY_FAVORITES = 'arhair_favorites_v1'
const KEY_PROFILE = 'arhair_profile_v1'
const KEY_CALIBRATION = 'arhair_calibration_v1'

const MAX_RECORDS = 20

/**
 * 本地文件总字节预算。
 * 微信 saveFile 的本地缓存文件总上限为 10MB（超限后 saveFile 直接 fail）。
 * 留 25% 余量给系统其它占用，到 7.5MB 就开始淘汰最旧记录。
 *
 * 照片规格：compose 侧 maxSide=960 / quality=0.82，实测单张约 300KB。
 * 旧版本（maxSide=1280 / q0.9）留下来的记录没有 bytes 字段，
 * 按 BYTES_FALLBACK 估算，避免预算被低估。
 */
const BYTES_BUDGET = 7.5 * 1024 * 1024
const BYTES_FALLBACK = 400 * 1024

function sizeOf(r) {
  if (!r) return 0
  if (typeof r.bytes === 'number' && r.bytes > 0) return r.bytes
  // 旧记录没有 bytes 字段，按新规格的保守值估算
  return r.photoPath ? BYTES_FALLBACK : 0
}

function totalBytesOf(list) {
  let sum = 0
  for (let i = 0; i < list.length; i++) sum += sizeOf(list[i])
  return sum
}

function readJson(key, fallback) {
  try {
    const v = wx.getStorageSync(key)
    if (!v) return fallback
    return typeof v === 'string' ? JSON.parse(v) : v
  } catch (e) {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    wx.setStorageSync(key, JSON.stringify(value))
    return true
  } catch (e) {
    console.warn('[store] 写入失败', key)
    return false
  }
}

/* ---------------- 试戴记录 ---------------- */

function listRecords() {
  const list = readJson(KEY_RECORDS, [])
  if (!Array.isArray(list)) return []

  // 清洗脏记录。storage 里可能出现结构不对的数据：
  // 旧版本字段变更、用户手工改过、或者写入过程被中断。
  // 只要缺 id 或 createdAt 不是有效数字，formatTime 就会算出
  // 「NaN/NaN/NaN NaN:NaN」直接显示在历史页上，用户以为坏了。
  // 这类记录没有任何恢复价值，直接丢掉并清理它的照片文件
  // （否则文件会一直占着 10MB 本地配额）。
  const clean = []
  const dropped = []
  const seenIds = {}
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const ok = r && typeof r === 'object' &&
      typeof r.id === 'string' && r.id.length > 0 &&
      typeof r.createdAt === 'number' && isFinite(r.createdAt) && r.createdAt > 0
    if (!ok) {
      dropped.push(r)
      continue
    }
    // 重复 id 也要丢。旧版本用 'r'+Date.now() 生成 id，
    // 系统时间回拨或同毫秒连拍会撞车；撞了之后
    // wx:key 会报 duplicate key，removeRecord 还会一次删掉多条。
    // 保留先出现的那条（列表里位置更靠前，也就是更新的）。
    if (seenIds[r.id]) {
      dropped.push(r)
      continue
    }
    seenIds[r.id] = true
    // 老记录没有 thumbPath 字段，统一归一成空串，
    // 上层就可以无条件写 `thumbPath || photoPath` 而不用判 undefined
    if (typeof r.thumbPath !== 'string') r.thumbPath = ''
    clean.push(r)
  }

  if (dropped.length) {
    for (let i = 0; i < dropped.length; i++) {
      const r = dropped[i]
      if (r && typeof r === 'object') {
        removeSavedFile(r.photoPath)
        removeSavedFile(r.thumbPath)
      }
    }
    writeJson(KEY_RECORDS, clean)
    console.warn('[store] 清理了 ' + dropped.length + ' 条损坏记录')
  }
  return clean
}

function removeSavedFile(path) {
  if (!path) return
  try {
    wx.getFileSystemManager().removeSavedFile({
      filePath: path,
      fail() {}
    })
  } catch (e) {
    // 忽略：文件可能已被清理
  }
}

/**
 * 新增一条试戴记录
 * @param {{styleId:string, styleName:string, colorId:string, colorName:string, tempFilePath:string}} item
 * @param {function(record:Object, result:{ok:boolean, photoSaved:boolean, reason:string})=} callback
 *   result.ok        —— storage 写入是否成功
 *   result.photoSaved —— 照片文件是否真的落盘
 *   result.reason    —— photoSaved 为 false 时的原因，供上层提示用户
 */
function addRecord(item, callback) {
  const record = {
    // id 必须全局唯一。只用 Date.now() 有两个坑：
    //   1. 系统时间被回拨后，新记录可能拿到和旧记录相同的毫秒数
    //   2. 同一毫秒内连续写入（脚本、极快的连拍）也会撞
    // 一旦撞了，removeRecord 遍历时会把同 id 的记录全删掉，
    // 用户点一次删除丢掉两条；wx:key 也会报 duplicate key。
    id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7),
    styleId: item.styleId,
    styleName: item.styleName,
    colorId: item.colorId,
    colorName: item.colorName,
    createdAt: Date.now(),
    photoPath: '',
    // 列表用的小图。拍照时额外导出一张 240px 宽的版本，
    // 记录页只加载它；点开大图预览才用 photoPath。
    thumbPath: '',
    bytes: 0
  }

  const finish = function (photoPath, bytes, reason, thumbPath) {
    record.photoPath = photoPath || ''
    record.thumbPath = thumbPath || ''
    record.bytes = bytes || 0
    const list = listRecords()
    list.unshift(record)

    // 显式按 createdAt 降序，不依赖「unshift 进来的这条一定在最旧」这个隐式约定。
    // 只要 storage 里的顺序和写入顺序不一致（手工改过数据、以后接云端同步、
    // 或者有人把 unshift 写成 push），pop() 删掉的就不再是最旧那条，
    // 用户会莫名丢掉较新的记录、留下更老的。
    list.sort(function (a, b) {
      return (b && b.createdAt ? b.createdAt : 0) - (a && a.createdAt ? a.createdAt : 0)
    })

    // 双预算淘汰：条数超限 或 总字节超限，都从最旧的开始删。
    // 只按条数会在「单张照片变大」时失效——这正是 1280px/q0.9 时代
    // 20 张就撑爆 10MB 配额、后半段照片静默丢失的原因。
    // 至少保留 1 条，避免把刚拍的这条也删掉。
    let evicted = 0
    while (
      list.length > 1 &&
      (list.length > MAX_RECORDS || totalBytesOf(list) > BYTES_BUDGET)
    ) {
      const dropped = list.pop()
      evicted++
      if (dropped) {
        removeSavedFile(dropped.photoPath)
        removeSavedFile(dropped.thumbPath)
      }
    }

    const ok = writeJson(KEY_RECORDS, list)
    if (callback) {
      callback(record, {
        ok: ok,
        photoSaved: !!record.photoPath,
        evicted: evicted,
        reason: reason || ''
      })
    }
  }

  if (!item.tempFilePath) {
    finish('', 0, 'no-temp-file')
    return
  }

  let settled = false
  let fs
  try {
    fs = wx.getFileSystemManager()
  } catch (e) {
    // 拿不到文件系统（极少数机型/基础库异常）。
    // 这里**必须**仍然走 finish —— 否则 callback 永远不触发，
    // 上层 tryon 的 shooting 状态就一直停在 true，
    // 快门按钮永久禁用，用户只能退出重进才能再拍。
    // 宁可只存发型信息不存照片，也不能把按钮锁死。
    finish('', 0, 'fs-unavailable')
    return
  }

  // 先探测照片实际大小，超预算就先腾地方再 saveFile，
  // 而不是等 saveFile 失败后静默丢照片。
  try {
    fs.getFileInfo({
      filePath: item.tempFilePath,
      success(info) {
        const bytes = (info && info.size) || 0
        savePhoto(item.tempFilePath, bytes)
      },
      fail() {
        // getFileInfo 在某些基础库上不稳定，拿不到大小就按 0 记，仍继续保存
        savePhoto(item.tempFilePath, 0)
      }
    })
  } catch (e) {
    savePhoto(item.tempFilePath, 0)
  }

  function savePhoto(tempFilePath, bytes) {
    if (settled) return
    settled = true
    try {
      fs.saveFile({
        tempFilePath: tempFilePath,
        success(res) {
          saveThumb(res.savedFilePath, bytes)
        },
        fail(err) {
          const msg = (err && err.errMsg) || ''
          console.warn('[store] 照片保存失败', msg)
          // 记录仍然保存（发型/发色信息不丢），但照片为空。
          // reason 透出给上层，让用户知道该清理历史记录了。
          const reason = /exceed|size|space|quota/i.test(msg) ? 'storage-full' : 'save-failed'
          finish('', 0, reason)
        }
      })
    } catch (e) {
      finish('', 0, 'save-failed')
    }
  }

  /**
   * 缩略图是「锦上添花」，绝不能因为它失败就丢掉整条记录。
   * 主图已经落盘了，这里任何异常都只是让记录退化成「列表里用大图」。
   */
  function saveThumb(photoPath, bytes) {
    if (!item.tempThumbPath) {
      finish(photoPath, bytes, '')
      return
    }
    try {
      fs.saveFile({
        tempFilePath: item.tempThumbPath,
        success(res) {
          finish(photoPath, bytes, '', res.savedFilePath)
        },
        fail() {
          finish(photoPath, bytes, '')
        }
      })
    } catch (e) {
      finish(photoPath, bytes, '')
    }
  }
}

function removeRecord(id) {
  const list = listRecords()
  const kept = []
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      // 两个文件都要删。只删主图会留下一个孤儿缩略图，
      // 它同样占着 10MB 的 saveFile 配额，而且永远没人再引用它 ——
      // 用户删了 20 条记录，配额却没腾出来。
      removeSavedFile(list[i].photoPath)
      removeSavedFile(list[i].thumbPath)
    } else {
      kept.push(list[i])
    }
  }
  writeJson(KEY_RECORDS, kept)
  return kept
}

function clearRecords() {
  const list = listRecords()
  for (let i = 0; i < list.length; i++) {
    removeSavedFile(list[i].photoPath)
    removeSavedFile(list[i].thumbPath)
  }
  writeJson(KEY_RECORDS, [])
}

/* ---------------- 全量清理与孤儿文件回收 ---------------- */

const KEY_PREFIX = 'arhair_'

/**
 * 兜底 key 名单。
 *
 * 只在 getStorageInfoSync 拿不到 keys 时才用（个别老基础库、
 * 或者 storage 被系统裁过）。**正常情况下不该走这条路** ——
 * 手抄名单的问题见 clearAll 的注释。
 */
function knownKeys() {
  // 必须是**函数**而不是常量数组：KEY_GUIDE / KEY_LAST_PICK 定义在
  // 这个文件的更下面，模块初始化时就引用会撞上 const 的暂时性死区
  // （`Cannot access 'KEY_GUIDE' before initialization`），
  // 整个 store 都加载不起来，所有页面跟着白屏。
  return [
    KEY_RECORDS,
    KEY_FAVORITES,
    KEY_PROFILE,
    KEY_CALIBRATION,
    KEY_GUIDE,
    KEY_LAST_PICK,
    'arhair_first_launch',
    'arhair_launch_count'
  ]
}

function storageKeys() {
  try {
    const info = wx.getStorageInfoSync()
    if (info && Array.isArray(info.keys)) return info.keys
  } catch (e) {}
  return null
}

/**
 * 清除本机数据，恢复到「刚装好」的状态。
 *
 * **不能靠手抄 key 名单。** 之前 profile 页里就是硬编码着
 * removeStorageSync('arhair_favorites_v1') 这么一串，每加一个新 key
 * 都得记得回来补一行 —— 而「记得」这件事从来没成功过：
 * 第 45 轮加的 arhair_last_pick_v1 就没补进去，
 * 用户点了「清除本机数据」，下次进试戴页还是上次那款发型。
 *
 * 所以改成按前缀扫。前缀是这套代码自己的命名空间，将来再加 key
 * 也会自动被清掉。顺手把 guide 标记也清了 —— 用户要求的是
 * 「清除本机数据」，那就该回到第一次打开的样子，包括再看一次引导。
 *
 * @returns {string[]} 实际被删掉的 key
 */
function clearAll() {
  // 顺序有讲究：先读记录、删照片文件，再删 key。
  // 反过来的话 clearRecords 读到的已经是空列表，
  // 照片文件就永远留在 10MB 配额里没人认领了。
  clearRecords()

  // 头像也是 saveFile 落到本地的，同样占配额
  try {
    const p = getProfile()
    if (p && p.avatarUrl && p.avatarUrl.indexOf('store://') === 0) {
      removeSavedFile(p.avatarUrl)
    }
  } catch (e) {}

  const removed = []
  const keys = storageKeys()
  if (keys) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (typeof k !== 'string' || k.indexOf(KEY_PREFIX) !== 0) continue
      try {
        wx.removeStorageSync(k)
        removed.push(k)
      } catch (e) {}
    }
  } else {
    const fallback = knownKeys()
    for (let i = 0; i < fallback.length; i++) {
      try {
        wx.removeStorageSync(fallback[i])
        removed.push(fallback[i])
      } catch (e) {}
    }
  }
  return removed
}

/** 回收时跳过这么新的文件（毫秒）。见 collectGarbage 的说明 */
const GC_MIN_AGE = 120000

/**
 * 回收没人引用的照片文件。
 *
 * 什么时候会产生孤儿：
 *   1) 记录被淘汰/删除时 removeSavedFile 失败（文件被占用、系统清理中），
 *      文件留在磁盘上但已经没有任何记录指向它
 *   2) 用户手动清了小程序缓存里的 storage 部分，照片还在
 *   3) 早期版本的 bug（只删主图不删缩略图）
 *
 * 危害是实打实的：saveFile 的总配额只有 10MB，孤儿文件永远不释放，
 * 攒够之后**每次拍照都保存失败**，而用户什么都没做错，
 * 记录里也看不出任何异常（只有一句「存储空间不足」）。
 *
 * **必须跳过刚创建的文件。** 拍照流程是 saveFile → 写记录，
 * 中间有几十毫秒的窗口。如果这时候跑回收，会把刚存好、
 * 还没被记录引用的照片当成孤儿删掉 —— 用户按下快门，
 * 照片在记录里变成裂图。
 */
function collectGarbage() {
  let fs
  try {
    fs = wx.getFileSystemManager()
  } catch (e) {
    return
  }
  if (!fs || typeof fs.getSavedFileList !== 'function') return

  const keep = {}
  const recs = listRecords()
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].photoPath) keep[recs[i].photoPath] = 1
    if (recs[i].thumbPath) keep[recs[i].thumbPath] = 1
  }
  try {
    const p = getProfile()
    if (p && p.avatarUrl) keep[p.avatarUrl] = 1
  } catch (e) {}

  const now = Date.now()
  fs.getSavedFileList({
    success(res) {
      const files = (res && res.fileList) || []
      let n = 0
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        if (!f || !f.filePath) continue
        if (keep[f.filePath]) continue
        // createTime 缺失时不敢删 —— 宁可留一个孤儿，
        // 也不能删掉一张用户还没看到过的照片
        if (typeof f.createTime !== 'number') continue
        if (now - f.createTime < GC_MIN_AGE) continue
        removeSavedFile(f.filePath)
        n++
      }
      if (n) console.info('[store] 回收了 ' + n + ' 个无人引用的照片文件')
    },
    fail() {}
  })
}

/* ---------------- 收藏 ---------------- */

/**
 * 收藏上限。发型库一共 10 款，给到 20 已经是很宽的余量；
 * 这个数字存在的意义是**兜住失控数据**，不是限制用户
 * （storage 被写坏成 400 个 id 时，页面会一次性渲染 400 张 2.9KB 的缩略图）。
 */
const MAX_FAVORITES = 20

/**
 * 收藏列表。
 *
 * 这里的清洗比 listRecords 简单（收藏只存 id，没有时间戳可校验），
 * 但**不能不做**。listRecords 从第 2 轮起就有一整套清洗，
 * 收藏一直是 `readJson(...) || []` —— 同一个文件里两套标准，
 * 脏数据的来源却是完全一样的：旧版本字段变更、用户手改 storage、
 * 写入过程被中断。收藏还多一种：**发型库改版后下架的 id**。
 *
 * 脏收藏不是「显示难看」那么轻，它会造成三个具体故障：
 *   1. 重复 id → wxml 的 wx:key 撞车，列表复用错位；且 toggleFavorite
 *      用 indexOf 只删第一个，用户长按取消收藏，卡片删了还在
 *   2. 非字符串项 → getStyle 认不出来，一律回落到 HAIR_STYLES[0]，
 *      界面上就是「用户从没收藏过的 buzz」凭空出现在收藏栏里
 *   3. 脏数据永远留在 storage 里，每次进页面都要失败一遍
 */
function listFavorites() {
  const raw = readJson(KEY_FAVORITES, [])
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = {}
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]
    if (typeof v !== 'string') continue
    const id = v.trim()
    if (!id || seen[id]) continue
    seen[id] = true
    out.push(id)
    if (out.length >= MAX_FAVORITES) break
  }
  return out
}

/** 整体覆盖收藏列表（用于「我的」页把已下架 / 重复的 id 清出去） */
function setFavorites(ids) {
  writeJson(KEY_FAVORITES, Array.isArray(ids) ? ids : [])
}

function isFavorite(styleId) {
  return listFavorites().indexOf(styleId) >= 0
}

function toggleFavorite(styleId) {
  // 基于清洗后的列表操作：脏项不会在写回时被带回去
  const list = listFavorites()
  const idx = list.indexOf(styleId)
  if (idx >= 0) {
    // 用 filter 而不是 splice：万一历史数据里同一款被存了多次，
    // splice 只删第一个，用户会看到「取消了收藏，卡片还在」
    const kept = []
    for (let i = 0; i < list.length; i++) if (list[i] !== styleId) kept.push(list[i])
    writeJson(KEY_FAVORITES, kept)
    return false
  }
  list.push(styleId)
  writeJson(KEY_FAVORITES, list)
  return true
}

/* ---------------- 首次使用引导 ---------------- */

const KEY_GUIDE = 'arhair_guide_v1'

/**
 * 是否已经看过试戴页的新手指引。
 *
 * 用 readJson 而不是直接 getStorageSync，是为了容忍被写坏的值：
 * `"1"`、`"true"`、`"yes"` 这些都当「看过」，只有明确不是 true
 * 才再引导一次。反过来（把 "1" 当没看过）会让老用户每次进来都被拦一次。
 */
function hasSeenGuide() {
  const v = readJson(KEY_GUIDE, false)
  return v === true || v === 1 || v === '1' || v === 'true'
}

function markGuideSeen() {
  writeJson(KEY_GUIDE, true)
}

/* ---------------- 使用天数 ---------------- */

const KEY_FIRST_LAUNCH = 'arhair_first_launch'

/**
 * 「已使用 N 天」。
 *
 * 这个数字只为了给用户一点「我在这儿存了东西」的实在感，
 * 所以宁可算得保守：任何异常都当第 1 天，不显示 0 天。
 */
function getUsageDays() {
  let first = 0
  try {
    first = Number(readJson(KEY_FIRST_LAUNCH, 0) || 0)
  } catch (e) {
    first = 0
  }
  if (!isFinite(first) || first <= 0) return 1
  const days = Math.floor((Date.now() - first) / 86400000) + 1
  return days > 1 ? days : 1
}

/* ---------------- 上次用的发型/发色 ---------------- */

const KEY_LAST_PICK = 'arhair_last_pick_v1'

/**
 * 上次停留的发型和发色。
 *
 * 理发店的真实场景：顾客昨天试了 mohawk，今天回来还想再看一眼，
 * 或者发型师说「就按你上次看中那款剪」。每次都跳回写死的 bob，
 * 等于让他每次进来重新找一遍 —— 十款里翻两屏。
 *
 * **这里不校验 id 还在不在。** store 不该知道发型库长什么样，
 * 而且「下架」是版本更新时才会发生的事：如果在这里就把不认识的 id
 * 抹成空串，用户下次进来会被默默退回默认款，他还以为是自己记错了。
 * 校验放在真正要用它的地方（tryon / history），那里才能决定
 * 「回落到默认」还是「提示这款已下架」。
 */
function getLastPick() {
  const raw = readJson(KEY_LAST_PICK, null)
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    style: typeof p.style === 'string' ? p.style : '',
    color: typeof p.color === 'string' ? p.color : '',
    // 这条记录是怎么来的：'user' = 自己在款式条上点的，'rec' = 接受 AI 的推荐。
    // 老记录没有这个字段，一律当 'user' —— 不能凭猜测放宽已有用户的行为。
    by: p.by === 'rec' ? 'rec' : 'user'
  }
}

/**
 * @param {string} styleId
 * @param {string} colorId
 * @param {'user'|'rec'} [by] 'rec' = 用户点了推荐卡上的「换成这款 / 换一款」。
 *   这仍然是他的选择（下次进来要还原），但**不等于他关掉了自动匹配**：
 *   页面用 by 区分「自己挑的」（自动匹配从此只推荐）和「接受 AI 给的」
 *   （下次照常自动匹配）。
 */
function saveLastPick(styleId, colorId, by) {
  return writeJson(KEY_LAST_PICK, {
    style: typeof styleId === 'string' ? styleId : '',
    color: typeof colorId === 'string' ? colorId : '',
    by: by === 'rec' ? 'rec' : 'user'
  })
}

/* ---------------- 客户档案 ---------------- */

const PROFILE_FIELDS = { nickName: 40, avatarUrl: 512, hairType: 40, note: 200 }

/**
 * 按**码点**截断。
 * `s.slice(0, n)` 数的是 UTF-16 码元，昵称里的 emoji（👨‍🦰 这类）
 * 占 2 个甚至更多码元，切在代理对中间会存进一个乱码方块。
 */
function clip(s, n) {
  const arr = Array.from(s)
  return arr.length > n ? arr.slice(0, n).join('') : s
}

function strOf(v, max) {
  if (typeof v === 'string') return clip(v, max)
  if (typeof v === 'number' && isFinite(v)) return String(v)
  return ''
}

/**
 * 客户档案。
 *
 * readJson 只能保证「是合法 JSON」，保证不了「是个对象」：
 * storage 里可能是 `"null"`、`"123"`、`"[1,2]"`，这些都过 JSON.parse，
 * 返回的却是 null / 数字 / 数组。原来直接把这个返回值交给页面，
 * 于是 `profile.nickName` 在 null 上取值 → **整个「我的」页白屏**，
 * 而用户只会说「点我的就没了」。
 *
 * 这里逐字段归一：认不出的类型一律给空串，页面拿到的永远是
 * 一个四个字段齐全的普通对象。
 */
function getProfile() {
  const raw = readJson(KEY_PROFILE, null)
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const k in PROFILE_FIELDS) out[k] = strOf(p[k], PROFILE_FIELDS[k])
  return out
}

/** 写入前同样归一，保证 storage 里永远是干净结构（白名单，不存多余字段） */
function saveProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {}
  const out = {}
  for (const k in PROFILE_FIELDS) out[k] = strOf(p[k], PROFILE_FIELDS[k])
  return writeJson(KEY_PROFILE, out)
}

/* ---------------- 识脸校准参数 ---------------- */

/**
 * 校准参数的合理区间。
 * 缩放 0.5~2 已经覆盖「脸偏小/偏大」的全部真实需求；
 * 偏移 ±240px 足够把一个完全跑偏的框拉回屏幕中央。
 * 超出区间的值不可能是用户调出来的，只可能是数据坏了。
 */
const CAL_SCALE_MIN = 0.5
const CAL_SCALE_MAX = 2
const CAL_OFFSET_MAX = 240

function numOf(v, def) {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && isFinite(n) ? n : def
}

function clampNum(n, lo, hi) {
  return n < lo ? lo : (n > hi ? hi : n)
}

/**
 * 识脸校准参数。
 *
 * 这三个数直接进 `faceAnchorToBox` 的算式：
 *   faceW = faceW * cal.scale
 *   cx += cal.offsetX
 * 只要有一个不是有限数，算出来的 faceW/cx 就是 NaN，
 * 函数按约定返回 null，**画布上就永远不会有发型**。
 * 用户看到的是相机画面正常、状态栏写着「已锁定人脸」，
 * 但头上什么都没有 —— 而且他没有任何办法知道是校准参数坏了。
 *
 * `cal.scale || 1` 这种写法挡不住 NaN 以外的东西：
 * "abc" 会让 faceW 变 NaN（被后面的 isFinite 拦下，退化成没发型），
 * 负数会被脸宽夹取逻辑夹成最小脸。所以这里统一按数值归一 + 夹区间。
 */
function getCalibration() {
  const raw = readJson(KEY_CALIBRATION, null)
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    scale: clampNum(numOf(c.scale, 1), CAL_SCALE_MIN, CAL_SCALE_MAX),
    offsetX: clampNum(numOf(c.offsetX, 0), -CAL_OFFSET_MAX, CAL_OFFSET_MAX),
    offsetY: clampNum(numOf(c.offsetY, 0), -CAL_OFFSET_MAX, CAL_OFFSET_MAX)
  }
}

function saveCalibration(cal) {
  const c = cal && typeof cal === 'object' ? cal : {}
  return writeJson(KEY_CALIBRATION, {
    scale: clampNum(numOf(c.scale, 1), CAL_SCALE_MIN, CAL_SCALE_MAX),
    offsetX: clampNum(numOf(c.offsetX, 0), -CAL_OFFSET_MAX, CAL_OFFSET_MAX),
    offsetY: clampNum(numOf(c.offsetY, 0), -CAL_OFFSET_MAX, CAL_OFFSET_MAX)
  })
}

module.exports = {
  listRecords: listRecords,
  addRecord: addRecord,
  removeRecord: removeRecord,
  clearRecords: clearRecords,
  listFavorites: listFavorites,
  setFavorites: setFavorites,
  isFavorite: isFavorite,
  toggleFavorite: toggleFavorite,
  MAX_FAVORITES: MAX_FAVORITES,
  hasSeenGuide: hasSeenGuide,
  markGuideSeen: markGuideSeen,
  getUsageDays: getUsageDays,
  getLastPick: getLastPick,
  saveLastPick: saveLastPick,
  clearAll: clearAll,
  collectGarbage: collectGarbage,
  getProfile: getProfile,
  saveProfile: saveProfile,
  getCalibration: getCalibration,
  saveCalibration: saveCalibration,
  CAL_SCALE_MIN: CAL_SCALE_MIN,
  CAL_SCALE_MAX: CAL_SCALE_MAX,
  CAL_OFFSET_MAX: CAL_OFFSET_MAX
}
