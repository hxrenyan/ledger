/**
 * 我的。
 *
 * 这一页承担三件事：
 *   1. 入口导航（账本、预算、分类、周期、导入）；
 *   2. 账号：微信绑定已有账号（POST /me/wechat/bind，会返回**新 token**，必须替换）、退出登录。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const nav = require('../../utils/nav')
const ui = require('../../utils/ui')

/**
 * 把导出接口的正文收成账单 JSON。
 * 线上旧接口是 CSV；地址写错时服务会返回网站页面，那种内容不能进剪贴板。
 */
function billsText(body) {
  if (body && typeof body === 'object') return JSON.stringify(body, null, 2)
  const text = String(body == null ? '' : body).replace(/^\uFEFF/, '').trim()
  if (!text || text.charAt(0) === '<') {
    const err = new Error('导出失败')
    throw err
  }
  if (text.charAt(0) === '{' || text.charAt(0) === '[') {
    return JSON.stringify(JSON.parse(text), null, 2)
  }
  return JSON.stringify(csvToBills(text), null, 2)
}

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quoted) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function csvToBills(text) {
  const lines = text.split(/\r?\n/).map(function (line) { return line.trim() }).filter(Boolean)
  const split = lines.indexOf('人情往来')
  const billLines = split === -1 ? lines : lines.slice(0, split)
  const favorLines = split === -1 ? [] : lines.slice(split + 1)
  return { 账单: billRows(billLines), 人情: favorRows(favorLines) }
}

function billRows(lines) {
  const bills = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    if (cols.length < 5) continue
    const item = {
      日期: cols[0],
      类型: cols[1],
      金额: cols[2],
      分类: cols[3],
      账户: cols[4],
    }
    if (cols[5]) item.转入账户 = cols[5]
    if (cols[6]) item.不计入 = cols[6]
    if (cols[7]) item.备注 = cols[7]
    bills.push(item)
  }
  return bills
}

function favorRows(lines) {
  const favors = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    if (cols.length < 4) continue
    const item = {
      日期: cols[0],
      方向: cols[1],
      金额: cols[2],
      对方: cols[3],
    }
    if (cols[4]) item.事由 = cols[4]
    if (cols[5]) item.备注 = cols[5]
    favors.push(item)
  }
  return favors
}

Page({
  data: {
    nickname: '',
    initial: '',
    username: '',
    wechatBound: false,
    hasPassword: false,
    ledgerName: '',
    ledgerCount: 0,
    guest: false,
    pointBalance: '',
  },

  onShow() {
    if (!session.getToken()) {
      this.setData({
        guest: true,
        nickname: '未登录',
        initial: '登',
        username: '',
        wechatBound: false,
        hasPassword: false,
        ledgerName: '登录后查看',
        ledgerCount: 0,
        pointBalance: '',
      })
      return
    }
    this.setData({ guest: false })
    this.render()
  },

  goLogin() {
    session.goLogin()
  },

  render() {
    const user = session.getUser() || {}
    const ledger = session.currentLedger()
    const nickname = user.nickname || user.username || '未登录'
    this.setData({
      nickname: nickname,
      initial: nickname.slice(0, 1),
      username: user.username || '',
      wechatBound: !!user.wechat_bound,
      hasPassword: !!user.has_password,
      ledgerName: ledger ? ledger.name : '未选择',
      ledgerCount: session.getLedgers().length,
      pointBalance: '',
    })
    if (!user.wechat_bound) return
    request
      .get('/api/v1/points', null, { withLedger: false })
      .then((raw) => {
        const body = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!body || body.balance == null) return
        this.setData({ pointBalance: String(body.balance) })
      })
      .catch(() => {})
  },

  openFeedback() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  openPoints() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    wx.navigateTo({ url: '/pages/points/points' })
  },

  /** 修改昵称后用服务端返回的会话刷新本地用户信息。 */
  editNickname() {
    ui.prompt({ title: '修改昵称', value: this.data.nickname, placeholder: '1–32 个字' }).then((nickname) => {
      if (nickname == null || nickname === this.data.nickname) return
      ui.withLoading('保存中', () => request.post('/api/v1/me/nickname', { nickname: nickname }))
        .then((body) => {
          session.apply(body)
          this.render()
          ui.toast('昵称已更新')
        })
        .catch((err) => ui.fail(err, '修改失败'))
    })
  },

  /** 用 /me 刷新一次，拿到最新的绑定状态与账本列表。 */
  refreshMe() {
    return request
      .get('/api/v1/me')
      .then((body) => {
        session.apply(body)
        this.render()
      })
      .catch((err) => ui.fail(err, '刷新失败'))
  },

  go(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go(e.currentTarget.dataset.key)
  },

  /** 微信账号 + 已有密码账号合并：成功后服务端会换一个新 token 回来。 */
  bindAccount() {
    ui.prompt({ title: '已有账号的用户名', placeholder: '用户名' }).then((username) => {
      if (username == null || !username) return
      ui.prompt({ title: '密码', placeholder: '密码' }).then((password) => {
        if (password == null) return
        ui.withLoading('合并中', () =>
          request.post('/api/v1/me/wechat/bind', { username: username, password: password }),
        )
          .then((body) => {
            // 必须换上新 token：合并后本地的旧 token 指向的是被并掉的那个用户。
            session.apply(body)
            ui.ok('已合并')
            this.refreshMe()
          })
          .catch((err) => ui.fail(err, '合并失败'))
      })
    })
  },

  exportBook() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    if (!session.getLedgerId()) {
      ui.toast('请先选择账本')
      return
    }
    ui.actions(['复制', '下载 JSON 文件']).then((index) => {
      if (index === 0) this.copyExport()
      else if (index === 1) this.downloadExport()
    })
  },

  copyExport() {
    this.loadExport().then((text) => {
      if (!text) return
      wx.setClipboardData({
        data: text,
        fail: () => ui.toast('复制失败'),
      })
    })
  },

  /**
   * 写成 json 文件再转发。微信里不能直接存到相册或文件夹，
   * 转发按钮才算用户点击，shareFileMessage 才能把文件发出去。
   */
  downloadExport() {
    this.loadExport().then((text) => {
      if (!text) return
      const dest = wx.env.USER_DATA_PATH + '/ledger.json'
      wx.getFileSystemManager().writeFile({
        filePath: dest,
        data: text,
        encoding: 'utf8',
        success: () => {
          wx.showModal({
            title: '下载 JSON',
            content: '点转发，把记账.json 发到文件传输助手后再保存。',
            confirmText: '转发',
            success: (res) => {
              if (!res.confirm) return
              if (typeof wx.shareFileMessage !== 'function') {
                ui.toast('当前微信版本不能转发文件')
                return
              }
              wx.shareFileMessage({
                filePath: dest,
                fileName: '记账.json',
                fail: () => ui.toast('转发失败，请重试'),
              })
            },
          })
        },
        fail: () => ui.toast('保存文件失败'),
      })
    })
  },

  loadExport() {
    if (!session.getToken()) {
      session.goLogin()
      return Promise.resolve('')
    }
    if (!session.getLedgerId()) {
      ui.toast('请先选择账本')
      return Promise.resolve('')
    }
    ui.loading('准备中')
    return request
      .get('/api/v1/export', null, { dataType: 'text' })
      .then((body) => {
        ui.hideLoading()
        return billsText(body)
      })
      .catch((err) => {
        ui.hideLoading()
        ui.fail(err, '导出失败')
        return ''
      })
  },

  logout() {
    ui.confirm('退出后需要重新登录。').then((yes) => {
      if (!yes) return
      session.clear()
      wx.reLaunch({ url: '/pages/login/login' })
    })
  },

  copyInvite() {
    nav.go('ledger')
  },

  about() {
    wx.showModal({
      title: '记账',
      content:
        '个人和家庭记账。记录收入、支出和转账，查看月度明细与预算，管理账户和分类。可以建多个账本，邀请家人一起记，也能记人情往来、做周期记账、导入和导出账单。',
      showCancel: false,
    })
  },
})
