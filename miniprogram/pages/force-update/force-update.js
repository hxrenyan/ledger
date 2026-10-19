/**
 * 正式版低于后台最低版本时停在这里。新版本下好后直接重新进入。
 */

function applyReadyUpdate() {
  const app = getApp()
  if (!app.globalData.updateReady || typeof wx.getUpdateManager !== 'function') return false
  wx.getUpdateManager().applyUpdate()
  return true
}

Page({
  data: {
    message: '当前版本已停用，请更新后继续使用。',
    failed: false,
  },

  onShow() {
    const app = getApp()
    const body = app.globalData.client
    const message = body && body.update_message ? body.update_message : this.data.message
    this.setData({
      message: message,
      failed: !!app.globalData.updateFailed,
    })
    applyReadyUpdate()
  },

  retry() {
    const app = getApp()
    if (applyReadyUpdate()) return
    // 这里只重新读取版本门槛，不会重启微信的下载任务，继续保留失败提示。
    if (typeof app.checkClient === 'function') return app.checkClient()
  },
})
