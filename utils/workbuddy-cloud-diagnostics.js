// utils/workbuddy-cloud-diagnostics.js
// 云服务请求诊断助手 - 用于在手机vConsole中查看失败的云请求日志
function diagnosticObject(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (e) {
      return {}
    }
  }
  return value !== null && typeof value === 'object' ? value : {}
}

function diagnosticText(value) {
  return typeof value === 'string' ? value.slice(0, 512) : undefined
}

function responseHeader(headers, name) {
  var key = Object.keys(headers || {}).find(function(k) {
    return k.toLowerCase() === name
  })
  return key ? diagnosticText(headers[key]) : undefined
}

function logFailure(options, startedAt, status, data, headers) {
  var url = options.url.split(/[?#]/, 1)[0].replace(/^(https?:\/\/)[^/]*@/, '$1')
  var payload = diagnosticObject(data)
  var nestedError = typeof payload.error === 'object' ? diagnosticObject(payload.error) : {}
  var code = payload.code
  if (typeof payload.error === 'string') code = payload.error
  else if (nestedError.code !== undefined) code = nestedError.code
  var rawMessage = payload.error_description || nestedError.message || payload.message
  var message = typeof rawMessage === 'string'
    ? diagnosticText(rawMessage.split(options.url).join(url))
    : undefined
  var login = /^https?:\/\/[^/]+\/\.cloud\/auth\/v1\/login-wechat$/.test(url)
    ? diagnosticObject(options.data)
    : {}

  console.error('[WorkBuddy Cloud] request failed', JSON.stringify({
    stage: status === 0 ? 'network' : 'http',
    method: (options.method || 'GET').toUpperCase(),
    url: url,
    status: status,
    durationMs: Date.now() - startedAt,
    appid: diagnosticText(login.appid),
    code: typeof code === 'number' ? code : diagnosticText(code),
    message: message || 'HTTP ' + status,
    requestId: responseHeader(headers, 'x-request-id'),
    traceId: responseHeader(headers, 'x-trace-id')
  }))
}

function createDiagnosticWx(originalWx) {
  if (typeof originalWx.getAccountInfoSync === 'function') {
    var appid = originalWx.getAccountInfoSync().miniProgram.appId
    console.info('[WorkBuddy Cloud] initialized', JSON.stringify({ appid: appid }))
  }

  return {
    request: function(options) {
      var startedAt = Date.now()
      return originalWx.request({
        ...options,
        success: function(result) {
          if (result.statusCode < 200 || result.statusCode >= 300) {
            logFailure(options, startedAt, result.statusCode, result.data, result.header)
          }
          if (options.success) options.success.call(this, result)
        },
        fail: function(result) {
          if (result.errMsg !== 'request:fail abort') {
            logFailure(options, startedAt, 0, { message: result.errMsg })
          }
          if (options.fail) options.fail.call(this, result)
        }
      })
    },
    getStorageSync: function(key) {
      return originalWx.getStorageSync(key)
    },
    setStorageSync: function(key, value) {
      return originalWx.setStorageSync(key, value)
    },
    removeStorageSync: function(key) {
      return originalWx.removeStorageSync(key)
    }
  }
}

module.exports = { createDiagnosticWx: createDiagnosticWx }
