/**
 * storage 数据损坏恢复测试（第 2 轮）
 *
 * 用户设备上的 storage 可能被这些情况弄脏：
 *   - 旧版本字段结构不同
 *   - 用户用开发者工具手工改过
 *   - 写入过程被系统中断
 * 这里验证 listRecords 能清洗脏数据，而不是把
 * 「NaN/NaN/NaN NaN:NaN」这类东西传到界面上。
 */

const store = require('../utils/store')

const mem = {}
let removedFiles = []

global.wx = {
  getStorageSync(k) {
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : ''
  },
  setStorageSync(k, v) {
    mem[k] = v
  },
  getFileSystemManager() {
    return {
      saveFile(opt) { opt.success && opt.success({ savedFilePath: 'store://x' }) },
      getFileInfo(opt) { opt.success && opt.success({ size: 1000 }) },
      removeSavedFile(opt) {
        removedFiles.push(opt.filePath)
        opt.fail && opt.fail({})
      }
    }
  }
}

let pass = 0
let fail = 0
function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

function reset(raw) {
  for (const k in mem) delete mem[k]
  removedFiles = []
  if (raw !== undefined) mem['arhair_records_v1'] = typeof raw === 'string' ? raw : JSON.stringify(raw)
}

function validRecord(id, ts) {
  return {
    id: id, styleId: 'bob', styleName: '波波头',
    colorId: 'black', colorName: '自然黑',
    createdAt: ts, photoPath: 'store://' + id + '.jpg', bytes: 1000
  }
}

console.log('[1] storage 完全为空')
reset()
ck('返回空数组', Array.isArray(store.listRecords()) && store.listRecords().length === 0)

console.log('\n[2] storage 是非法 JSON 字符串')
reset('{not json at all')
ck('返回空数组不崩溃', store.listRecords().length === 0)

console.log('\n[3] storage 是对象而不是数组')
reset({ foo: 'bar' })
ck('返回空数组', store.listRecords().length === 0)

console.log('\n[4] 数组里混入各种脏元素')
reset([
  validRecord('good1', 1700000000000),
  null,
  undefined,
  'a string',
  42,
  [],
  { noId: true, createdAt: 1700000000000 },
  { id: '', createdAt: 1700000000000 },
  { id: 'noTime' },
  { id: 'badTime', createdAt: 'abc' },
  { id: 'nanTime', createdAt: NaN },
  { id: 'infTime', createdAt: Infinity },
  { id: 'zeroTime', createdAt: 0 },
  { id: 'negTime', createdAt: -1 },
  validRecord('good2', 1700000001000)
])
{
  const list = store.listRecords()
  ck('只保留 2 条合法记录', list.length === 2, '实际 ' + list.length)
  ck('保留的 id 正确', list[0].id === 'good1' && list[1].id === 'good2')
  ck('脏数据被写回 storage', JSON.parse(mem['arhair_records_v1']).length === 2)
}

console.log('\n[5] 脏记录的照片文件被清理')
reset([
  validRecord('good', 1700000000000),
  { id: '', createdAt: 1, photoPath: 'store://orphan.jpg' },
  { id: 'noTime', photoPath: 'store://noTime.jpg' }
])
store.listRecords()
ck('orphan.jpg 被删除', removedFiles.indexOf('store://orphan.jpg') >= 0)
ck('noTime.jpg 被删除', removedFiles.indexOf('store://noTime.jpg') >= 0)
ck('合法记录的照片没被误删', removedFiles.indexOf('store://good.jpg') < 0)

console.log('\n[6] 清洗是幂等的（第二次读不再删文件）')
reset([
  validRecord('good', 1700000000000),
  { id: '', createdAt: 1, photoPath: 'store://orphan.jpg' }
])
store.listRecords()
const firstRound = removedFiles.length
store.listRecords()
ck('第二次读取不再产生删除动作', removedFiles.length === firstRound,
  '第一次 ' + firstRound + ' 次，累计 ' + removedFiles.length + ' 次')

console.log('\n[7] 全部脏数据')
reset([null, null, { id: 'x' }])
ck('返回空数组', store.listRecords().length === 0)
ck('storage 被重置为空数组', mem['arhair_records_v1'] === '[]')

console.log('\n[8] 正常数据不受影响')
reset([validRecord('a', 1700000000000), validRecord('b', 1700000001000)])
ck('两条都保留', store.listRecords().length === 2)
ck('无删除动作', removedFiles.length === 0)

console.log('\n========================================')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) process.exit(1)
