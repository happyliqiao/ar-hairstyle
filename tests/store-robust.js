/**
 * store.addRecord 的健壮性
 *
 * 核心不变量：**callback 必须且只能被调用一次**。
 * 上层 tryon 在 callback 里才把 shooting 置回 false ——
 * 只要有一条路径漏掉 callback，快门按钮就永久停在「生成中」，
 * 用户只能退出重进。这是最容易被忽略、也最致命的一类 bug。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

function loadStore(wxImpl) {
  global.wx = wxImpl
  const abs = path.join(ROOT, 'utils/store.js')
  delete require.cache[require.resolve(abs)]
  return require(abs)
}

function mkStorage() {
  const s = {}
  return {
    getStorageSync(k) { return s[k] === undefined ? '' : s[k] },
    setStorageSync(k, v) { s[k] = v },
    removeStorageSync(k) { delete s[k] },
    _raw: s
  }
}

/* ---------- 1 getFileSystemManager 抛异常 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() { throw new Error('fs unavailable') }
  }))
  let calls = 0
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { calls++; result = r })
  ok('[1] fs 不可用时 callback 仍被调用', calls === 1, '实际 ' + calls + ' 次')
  ok('[1] reason 标明是 fs 不可用', result && result.reason === 'fs-unavailable', result && result.reason)
  ok('[1] 记录仍写入了 storage', !!st._raw['arhair_records_v1'])
})()

/* ---------- 2 没有 tempFilePath ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() { return { saveFile(o) { o.success({ savedFilePath: 'store://x' }) } } }
  }))
  let calls = 0
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑' },
    function (rec, r) { calls++; result = r })
  ok('[2] 无临时文件时 callback 调用一次', calls === 1)
  ok('[2] reason = no-temp-file', result && result.reason === 'no-temp-file', result && result.reason)
  ok('[2] photoSaved = false', result && result.photoSaved === false)
})()

/* ---------- 3 getFileInfo 回调两次（脏实现）---------- */
;(function () {
  const st = mkStorage()
  let saveCalls = 0
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 300 * 1024 }); o.success({ size: 300 * 1024 }) },
        saveFile(o) { saveCalls++; o.success({ savedFilePath: 'store://a.jpg' }) }
      }
    }
  }))
  let calls = 0
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function () { calls++ })
  ok('[3] getFileInfo 回调两次时 callback 仍只调一次', calls === 1, '实际 ' + calls)
  ok('[3] saveFile 也只调一次', saveCalls === 1, '实际 ' + saveCalls)
})()

/* ---------- 4 saveFile success 但没给路径 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 1000 }) },
        saveFile(o) { o.success({}) }
      }
    }
  }))
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { result = r })
  ok('[4] 没拿到 savedFilePath 时 photoSaved=false', result && result.photoSaved === false)
})()

/* ---------- 5 配额超限 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 300 * 1024 }) },
        saveFile(o) { o.fail({ errMsg: 'saveFile:fail the maximum size of the file storage limit is exceeded' }) }
      }
    }
  }))
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { result = r })
  ok('[5] 配额超限识别为 storage-full', result && result.reason === 'storage-full', result && result.reason)
})()

/* ---------- 6 其它失败 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 300 * 1024 }) },
        saveFile(o) { o.fail({ errMsg: 'saveFile:fail internal error' }) }
      }
    }
  }))
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { result = r })
  ok('[6] 其它失败识别为 save-failed', result && result.reason === 'save-failed', result && result.reason)
})()

/* ---------- 7 没有 getFileInfo 的老基础库 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        // 故意不提供 getFileInfo
        saveFile(o) { o.success({ savedFilePath: 'store://a.jpg' }) }
      }
    }
  }))
  let calls = 0
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { calls++; result = r })
  ok('[7] 老基础库无 getFileInfo 仍能保存', calls === 1 && result.photoSaved === true, JSON.stringify(result))
})()

/* ---------- 8 连续写 30 条：条数预算生效且 callback 各一次 ---------- */
;(function () {
  const st = mkStorage()
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 10 * 1024 }) },
        saveFile(o) { o.success({ savedFilePath: 'store://a' + Math.random() + '.jpg' }) },
        removeSavedFile(o) { o && o.success && o.success({}) }
      }
    }
  }))
  let calls = 0
  for (let i = 0; i < 30; i++) {
    store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
      function () { calls++ })
  }
  ok('[8] 30 次写入 → 30 次回调', calls === 30, '实际 ' + calls)
  const list = store.listRecords()
  ok('[8] 条数被限制在 20', list.length === 20, '实际 ' + list.length)
})()

/* ---------- 9 写入 storage 失败（超 10MB）时 ok=false 但仍回调 ---------- */
;(function () {
  const st = mkStorage()
  st.setStorageSync = function () { throw new Error('setStorageSync:fail exceed max size') }
  const store = loadStore(Object.assign({}, st, {
    getFileSystemManager() {
      return {
        getFileInfo(o) { o.success({ size: 1000 }) },
        saveFile(o) { o.success({ savedFilePath: 'store://a.jpg' }) }
      }
    }
  }))
  let calls = 0
  let result = null
  store.addRecord({ styleId: 'bob', styleName: '波波头', colorId: 'black', colorName: '自然黑', tempFilePath: '/tmp/a.jpg' },
    function (rec, r) { calls++; result = r })
  ok('[9] storage 写入失败时 callback 仍调用', calls === 1)
  ok('[9] result.ok = false', result && result.ok === false)
})()

console.log('')
console.log('[store 健壮性] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  9 组场景，核心不变量：callback 恰好调用一次')
}
