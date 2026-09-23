/**
 * 交互封装：toast / 确认 / 输入框 / loading，以及统一的请求错误提示。
 */

function toast(title, icon) {
  wx.showToast({ title: String(title || ''), icon: icon || 'none', duration: 1800 })
}

function ok(title) {
  wx.showToast({ title: String(title || ''), icon: 'success', duration: 1500 })
}

/** 请求失败的统一提示：接口错（带 message）直接透出，网络错给兜底文案。 */
function fail(err, fallback) {
  const msg = (err && err.message) || fallback || '操作失败'
  wx.showToast({ title: msg, icon: 'none', duration: 2200 })
}

/**
 * 确认框。
 * @returns {Promise<boolean>}
 */
function confirm(content, title) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '确认',
      content: content || '',
      confirmColor: '#e5484d',
      success: function (res) { resolve(!!res.confirm) },
      fail: function () { resolve(false) },
    })
  })
}

/**
 * 输入框（微信原生就支持 editable，不用自己弹浮层）。
 * @param {{title?:string, value?:string, placeholder?:string, confirmText?:string}} opts
 * @returns {Promise<string|null>} 取消返回 null
 */
function prompt(opts) {
  const o = opts || {}
  return new Promise(function (resolve) {
    wx.showModal({
      title: o.title || '请输入',
      editable: true,
      value: o.value || '',
      placeholderText: o.placeholder || '',
      confirmText: o.confirmText || '确定',
      success: function (res) {
        if (!res.confirm) {
          resolve(null)
          return
        }
        resolve(typeof res.content === 'string' ? res.content.trim() : '')
      },
      fail: function () { resolve(null) },
    })
  })
}

let loadingCount = 0

function loading(title) {
  loadingCount += 1
  wx.showLoading({ title: title || '处理中', mask: true })
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1)
  if (loadingCount === 0) {
    try {
      wx.hideLoading()
    } catch (e) {
      /* ignore */
    }
  }
}

/** 包一层 loading，保证异常路径也会 hide。 */
function withLoading(title, task) {
  loading(title)
  return Promise.resolve()
    .then(task)
    .then(
      function (v) { hideLoading(); return v },
      function (e) { hideLoading(); throw e },
    )
}

/** 底部操作菜单。 */
function actions(itemList) {
  return new Promise(function (resolve) {
    wx.showActionSheet({
      itemList: itemList,
      success: function (res) { resolve(res.tapIndex) },
      fail: function () { resolve(-1) },
    })
  })
}

module.exports = {
  toast: toast,
  ok: ok,
  fail: fail,
  confirm: confirm,
  prompt: prompt,
  loading: loading,
  hideLoading: hideLoading,
  withLoading: withLoading,
  actions: actions,
}
