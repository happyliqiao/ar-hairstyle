/**
 * 本地存储预算守卫测试（第 16 轮）
 *
 * 背景：实测 1280x1920 q0.9 的 JPG 为 883KB，20 条记录 = 17.7MB，
 * 超出微信 saveFile 本地文件 10MB 上限约 1.8 倍。失败后旧代码走
 * finish('') 静默降级，历史页出现灰色「无照片」占位且零提示。
 *
 * 本测试验证修复后的行为：
 *   1. 条数超限 -> 淘汰最旧
 *   2. 总字节超限 -> 提前淘汰，不等条数跑满
 *   3. 旧规格大照片 -> 字节预算仍然生效
 *   4. saveFile 因空间不足失败 -> photoSaved=false + reason='storage-full'
 *   5. 至少保留 1 条，不会把刚拍的这条删掉
 */

const store = require('../utils/store')

/* ---------------- wx mock ---------------- */

const mem = {}
let savedFiles = []
let nextSaveFail = false

global.wx = {
  getStorageSync(key) {
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : ''
  },
  setStorageSync(key, val) {
    mem[key] = val
  },
  getFileSystemManager() {
    return {
      saveFile(opt) {
        if (nextSaveFail) {
          opt.fail && opt.fail({ errMsg: 'saveFile:fail exceed max size 10MB' })
          return
        }
        const p = 'store://' + Math.random().toString(36).slice(2, 10) + '.jpg'
        savedFiles.push(p)
        opt.success && opt.success({ savedFilePath: p })
      },
      getFileInfo(opt) {
        opt.success && opt.success({ size: opt.__size || 300 * 1024 })
      },
      removeSavedFile(opt) {
        const i = savedFiles.indexOf(opt.filePath)
        if (i >= 0) savedFiles.splice(i, 1)
        opt.fail && opt.fail({})
      }
    }
  }
}

/* ---------------- 工具 ---------------- */

let pass = 0
let fail = 0

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''))
  }
}

function reset() {
  for (const k in mem) delete mem[k]
  savedFiles = []
  nextSaveFail = false
}

function listBytes() {
  let sum = 0
  const list = store.listRecords()
  for (let i = 0; i < list.length; i++) {
    sum += list[i].bytes || (list[i].photoPath ? 400 * 1024 : 0)
  }
  return sum
}

/* ---------------- 场景 1：条数预算 ---------------- */

console.log('\n[1] 条数预算：连拍 25 张 300KB 照片')
reset()
let lastResult = null
for (let i = 0; i < 25; i++) {
  store.addRecord(
    {
      styleId: 'bob',
      styleName: '波波头',
      colorId: 'black',
      colorName: '自然黑',
      tempFilePath: 'tmp://' + i
    },
    function (record, result) { lastResult = result }
  )
}
{
  const list = store.listRecords()
  check('记录数收敛到 20', list.length === 20, '实际 ' + list.length)
  check('总字节 6MB <= 7.5MB 预算', listBytes() <= 7.5 * 1024 * 1024,
    '实际 ' + (listBytes() / 1024 / 1024).toFixed(2) + 'MB')
  check('淘汰的文件已从磁盘清理', savedFiles.length === 20,
    '磁盘残留 ' + savedFiles.length)
  check('保留的是最新的（第一条 id 最大）', list[0].createdAt >= list[19].createdAt)
  // 稳态下每次只淘汰 1 条：第 21 次起 list 恒为 20，unshift 后 21 -> 删 1 -> 20
  check('末次写入上报淘汰 1 条（稳态）', lastResult && lastResult.evicted === 1,
    '实际 ' + (lastResult && lastResult.evicted))
}

/* ---------------- 场景 2：字节预算先于条数触发 ---------------- */

console.log('\n[2] 字节预算：旧规格 883KB 照片（maxSide=1280/q0.9 时代遗留）')
reset()
// 注入 10 条 883KB 的旧记录 = 8.83MB，已超 7.5MB 预算（且逼近 10MB 硬上限）
{
  const legacy = []
  for (let i = 0; i < 10; i++) {
    legacy.push({
      id: 'legacy' + i,
      styleId: 'bob',
      styleName: '波波头',
      colorId: 'black',
      colorName: '自然黑',
      createdAt: 1000 + i,
      photoPath: 'store://legacy' + i + '.jpg',
      bytes: 883 * 1024
    })
  }
  mem['arhair_records_v1'] = JSON.stringify(legacy)
}
store.addRecord(
  {
    styleId: 'crop',
    styleName: '寸头',
    colorId: 'brown',
    colorName: '咖啡棕',
    tempFilePath: 'tmp://new'
  },
  function () {}
)
{
  const list = store.listRecords()
  const bytes = listBytes()
  // 10 条旧 8.83MB + 新 300KB = 9.13MB，超预算 -> 淘汰 2 条最旧的
  // 9.13 - 0.883 - 0.883 = 7.36MB <= 7.5MB 停手，剩 8 旧 + 1 新 = 9 条
  check('字节预算触发，未等条数跑满', list.length === 9, '条数 ' + list.length)
  check('总字节回落到预算内', bytes <= 7.5 * 1024 * 1024,
    '实际 ' + (bytes / 1024 / 1024).toFixed(2) + 'MB')
  check('最新一条保留在最前', list[0].styleId === 'crop')
  check('最新一条有照片', !!list[0].photoPath)
  check('淘汰的是最旧的 legacy0/legacy1',
    !list.some(function (r) { return r.id === 'legacy0' || r.id === 'legacy1' }))
}

/* ---------------- 场景 3：保存失败 ---------------- */

console.log('\n[3] saveFile 空间不足失败')
reset()
nextSaveFail = true
let captured = null
store.addRecord(
  {
    styleId: 'bob',
    styleName: '波波头',
    colorId: 'black',
    colorName: '自然黑',
    tempFilePath: 'tmp://x'
  },
  function (record, result) {
    captured = result
  }
)
{
  check('photoSaved = false', captured && captured.photoSaved === false)
  check('reason = storage-full', captured && captured.reason === 'storage-full',
    '实际 ' + (captured && captured.reason))
  check('发型信息仍然落库', store.listRecords().length === 1)
  check('photoPath 为空（页面会显示无照片占位）', !store.listRecords()[0].photoPath)
}

/* ---------------- 场景 4：单条超大也保留 ---------------- */

console.log('\n[4] 只有 1 条时即使超预算也不删自己')
reset()
{
  // 先写一条 8MB 的极端记录
  mem['arhair_records_v1'] = JSON.stringify([{
    id: 'huge', styleId: 'bob', styleName: '波波头', colorId: 'black',
    colorName: '自然黑', createdAt: 1, photoPath: 'store://huge.jpg',
    bytes: 8 * 1024 * 1024
  }])
}
store.addRecord(
  {
    styleId: 'bob',
    styleName: '波波头',
    colorId: 'black',
    colorName: '自然黑',
    tempFilePath: 'tmp://y'
  },
  function () {}
)
{
  const list = store.listRecords()
  check('至少保留 1 条', list.length >= 1, '条数 ' + list.length)
  check('最新一条在最前', list[0].id !== 'huge')
}

/* ---------------- 场景 5：无 tempFilePath ---------------- */

console.log('\n[5] 没有照片路径（合成失败的降级路径）')
reset()
let r5 = null
store.addRecord(
  { styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '' },
  function (record, result) { r5 = result }
)
{
  check('不崩溃', store.listRecords().length === 1)
  check('photoSaved = false', r5 && r5.photoSaved === false)
  check('reason = no-temp-file', r5 && r5.reason === 'no-temp-file')
}

/* ---------------- 汇总 ---------------- */

console.log('\n========================================')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('存在问题：' + fail + ' 项')
  process.exit(1)
} else {
  console.log('存储预算守卫全部通过')
}
