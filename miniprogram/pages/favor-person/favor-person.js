/**
 * 某人的往来明细。
 *
 * 「还礼参考」的做法：把他当年的送出、收到的金额按事由列出来，
 * 下次还礼时照着看——这是人情账最实际的用法。
 */

const { toId } = require('../../utils/id')
const request = require('../../utils/request')
const session = require('../../utils/session')
const nav = require('../../utils/nav')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

Page({
  data: {
    contactId: '',
    name: '',
    relation: '',
    givenText: '0.00',
    receivedText: '0.00',
    netText: '0.00',
    netClass: 'income',
    hint: '',
    items: [],
    loading: true,
  },

  onLoad(query) {
    if (!session.ensure()) return
    const id = toId(query && query.id) || ''
    this.setData({ contactId: id })
    this.load()
  },

  onShow() {
    if (this.loaded) this.load()
    this.loaded = true
  },

  load() {
    const id = this.data.contactId
    if (!id) return Promise.resolve()
    this.setData({ loading: true })
    return Promise.all([
      request.get('/api/v1/gifts?contact_id=' + encodeURIComponent(id)),
      request.get('/api/v1/contacts'),
    ])
      .then((res) => {
        const gifts = (res[0] && res[0].items) || []
        const contacts = (res[1] && res[1].items) || []
        const me = contacts.find((c) => c.id === id)
        let given = 0
        let received = 0
        const items = gifts.map((g) => {
          if (g.kind === 'give') given += Number(g.amount_cents) || 0
          else received += Number(g.amount_cents) || 0
          return {
            id: g.id,
            kind: g.kind,
            kindText: g.kind === 'give' ? '送出' : '收入',
            date: time.occurredAtToDate(g.occurred_at),
            dateLabel: time.dateLabel(time.occurredAtToDate(g.occurred_at)),
            amountText: (g.kind === 'give' ? '-' : '+') + money.formatYuan(g.amount_cents),
            amountYuan: money.formatYuan(g.amount_cents),
            occasion: g.occasion || '未写事由',
            note: g.note || '',
          }
        })
        const net = received - given
        this.setData({
          loading: false,
          name: me ? me.name : items.length ? '' : '这位联系人',
          relation: me && me.relation ? me.relation : '',
          givenText: money.formatYuan(given),
          receivedText: money.formatYuan(received),
          netText: money.formatYuan(net),
          netClass: net >= 0 ? 'income' : 'expense',
          hint: this.hintFor(given, received),
          items: items,
        })
        if (me && me.name) wx.setNavigationBarTitle({ title: me.name })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  /** 把「收得多还是送得多」说成人话，比一个数字有用。 */
  hintFor(given, received) {
    if (!given && !received) return '还没有往来记录'
    if (received > given) return '收到的比送出的多 ' + money.formatYuan(received - given) + '，下次记得还上'
    if (given > received) return '送出的比收到的多 ' + money.formatYuan(given - received)
    return '两边刚好持平'
  },

  addGift() {
    nav.go('gift-form', { contact_id: this.data.contactId })
  },

  editGift(e) {
    nav.go('gift-form', { id: e.currentTarget.dataset.id })
  },

  async removeGift(e) {
    const yes = await ui.confirm('删掉这条记录？')
    if (!yes) return
    ui.withLoading('删除中', () => request.del('/api/v1/gifts/' + e.currentTarget.dataset.id))
      .then(() => {
        ui.ok('已删除')
        this.load()
      })
      .catch((err) => ui.fail(err, '删除失败'))
  },
})
