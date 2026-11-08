/** 全局唯一资源轮询器；业务通过订阅回调拉详情，成功后才确认版本。 */
const request = require('./request')
const session = require('./session')

function createHeartbeat(options) {
  const opts = options || {}
  const send = opts.send || ((data, anonymous) => request.post('/api/v1/app/heartbeat', data, {
    withLedger: false, silentAuth: true, timeout: 8000, ...(anonymous ? { header: { authorization: '' } } : {}),
  }))
  const identity = opts.identity || (() => session.getToken())
  const later = opts.setTimeout || setTimeout
  const cancel = opts.clearTimeout || clearTimeout
  const random = opts.random || Math.random
  const subscriptions = new Map()
  let active = false, timer = null, busy = false, pending = false, epoch = 0, failures = 0, context = identity()
  let authFailed = false
  function interval() {
    return Math.min(10000, ...Array.from(subscriptions.values()).map((entry) => entry.interval))
  }
  function clearTimer() { if (timer !== null) cancel(timer); timer = null }
  function schedule() {
    clearTimer()
    if (!active) return
    const delay = failures ? Math.min(60000, 10000 * Math.pow(2, failures - 1)) : interval()
    timer = later(() => { timer = null; check() }, delay + Math.round(random() * 500))
  }
  function syncContext() {
    const next = identity()
    if (next === context) return
    context = next; epoch++; authFailed = false; failures = 0
    subscriptions.forEach((entry, key) => {
      if (key.startsWith('game:')) subscriptions.delete(key)
      else { entry.rev = 0; entry.generation++ }
    })
  }
  async function refresh(key, entry, version, generation, runEpoch, runContext) {
    if (entry.loading) return
    entry.loading = true
    try {
      const rev = await entry.refresh({ version, isCurrent: () => active && epoch === runEpoch && context === runContext &&
        identity() === runContext && subscriptions.get(key) === entry && entry.generation === generation })
      if (active && epoch === runEpoch && identity() === runContext && subscriptions.get(key) === entry && entry.generation === generation && Number.isSafeInteger(rev) && rev >= 0) entry.rev = rev
    } catch (e) { /* 保留旧版本，下次心跳重试 */ }
    finally { entry.loading = false }
  }
  async function check() {
    clearTimer()
    if (!active) return
    syncContext()
    if (busy) { pending = true; return }
    busy = true
    const runEpoch = epoch, runContext = context
    const entries = Array.from(subscriptions.entries()).filter(([key]) => !key.startsWith('game:') || (!!context && !authFailed))
    const snapshots = entries.map(([key, entry]) => [key, entry, entry.generation])
    try {
      const data = { s: {} }
      entries.forEach(([key, entry]) => { data.s[key] = entry.rev })
      const body = await send(data, authFailed)
      if (!active || runEpoch !== epoch || identity() !== runContext) return
      failures = 0
      const changed = (body && body.s) || {}
      const missing = (body && body.x) || []
      snapshots.forEach(([key, entry, generation]) => {
        if (subscriptions.get(key) !== entry || entry.generation !== generation) return
        if (missing.indexOf(key) >= 0) {
          subscriptions.delete(key)
          if (entry.unavailable) entry.unavailable()
        } else if (Number.isSafeInteger(changed[key])) {
          void refresh(key, entry, changed[key], generation, runEpoch, runContext)
        }
      })
    } catch (error) {
      if (active && runEpoch === epoch) {
        failures++
        if (error && error.status === 401) authFailed = true
      }
    } finally {
      busy = false
      if (active) {
        if (pending) { pending = false; check() } else schedule()
      }
    }
  }
  return {
    start() { if (active) return; active = true; syncContext(); check() },
    stop() { active = false; epoch++; pending = false; clearTimer() },
    checkNow() { if (active) return check() },
    contextChanged() { syncContext(); if (active) return check() },
    subscribe(key, config) {
      if (!/^(ann|game:[1-9]\d*)$/.test(key)) throw new Error('资源类型无效')
      // 首期页面最多一个房间资源；旧房间回调不可覆盖新页面。
      if (key.startsWith('game:')) subscriptions.forEach((_, oldKey) => { if (oldKey.startsWith('game:') && oldKey !== key) subscriptions.delete(oldKey) })
      const entry = { rev: config.rev || 0, interval: config.interval === 5000 ? 5000 : 10000,
        refresh: config.refresh, unavailable: config.unavailable, loading: false, generation: 0 }
      subscriptions.set(key, entry)
      if (active) check()
      return () => { if (subscriptions.get(key) === entry) { subscriptions.delete(key); schedule() } }
    },
    markSynced(key, rev) { const entry = subscriptions.get(key); if (entry && Number.isSafeInteger(rev)) entry.rev = rev },
  }
}

module.exports = { createHeartbeat }
