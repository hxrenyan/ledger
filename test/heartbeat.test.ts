import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

function factory() {
  const mod = { exports: {} as any }
  new Function('require', 'module', 'exports', readFileSync(resolve('miniprogram/utils/heartbeat.js'), 'utf8'))(
    () => ({}), mod, mod.exports)
  return mod.exports.createHeartbeat
}
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>((done) => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('全局共享心跳', () => {
  it('普通10秒、房间5秒，取消恢复，后台停止且前台立即检查', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockResolvedValue({})
    const hb = factory()({ send, identity: () => 'user', random: () => 0 })
    hb.subscribe('ann', { refresh: vi.fn() })
    hb.start(); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9999)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    const stop = hb.subscribe('game:1', { rev: 4, interval: 5000, refresh: vi.fn() })
    await flush()
    expect(send.mock.calls[2][0]).toEqual({ s: { ann: 0, 'game:1': 4 } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(send).toHaveBeenCalledTimes(4)
    stop()
    await vi.advanceTimersByTimeAsync(9999)
    expect(send).toHaveBeenCalledTimes(4)
    hb.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(send).toHaveBeenCalledTimes(4)
    hb.start(); await flush()
    expect(send).toHaveBeenCalledTimes(5)
    hb.stop()
  })

  it('多个立即检查合并，不并发在途请求；旧账号、已取消订阅不执行回调', async () => {
    vi.useFakeTimers()
    let token = 'old'
    const first = deferred(), send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({})
    const refresh = vi.fn(), hb = factory()({ send, identity: () => token, random: () => 0 })
    hb.subscribe('game:1', { interval: 5000, refresh })
    hb.start(); hb.checkNow(); hb.checkNow()
    expect(send).toHaveBeenCalledTimes(1)
    token = 'new'; hb.contextChanged()
    first.resolve({ s: { 'game:1': 2 } }); await flush()
    expect(refresh).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toEqual({ s: {} })
    hb.stop()
  })

  it('详情成功才确认版本，失败重试，慢资源不阻塞另一资源及心跳', async () => {
    vi.useFakeTimers()
    const slow = deferred()
    const ann = vi.fn().mockReturnValue(slow.promise)
    const game = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(5)
    const send = vi.fn().mockResolvedValue({ s: { ann: 1, 'game:1': 5 } })
    const hb = factory()({ send, identity: () => 'user', random: () => 0 })
    hb.subscribe('ann', { refresh: ann })
    hb.subscribe('game:1', { rev: 3, interval: 5000, refresh: game })
    hb.start(); await flush()
    expect(game).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.mock.calls[1][0].s['game:1']).toBe(3)
    expect(ann).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.mock.calls[2][0].s['game:1']).toBe(5)
    slow.resolve(2); await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(send.mock.calls[3][0].s.ann).toBe(2)
    hb.stop()
  })

  it('后台迟到的详情不能应用，资源失效取消订阅', async () => {
    vi.useFakeTimers()
    const slow = deferred(), applied = vi.fn(), unavailable = vi.fn()
    const send = vi.fn().mockResolvedValueOnce({ s: { 'game:1': 2 } }).mockResolvedValue({ x: ['game:1'] })
    const hb = factory()({ send, identity: () => 'user', random: () => 0 })
    hb.subscribe('game:1', { rev: 1, interval: 5000, unavailable, refresh: async ({ isCurrent }: any) => {
      await slow.promise
      if (isCurrent()) applied()
      return 2
    } })
    hb.start(); await flush(); hb.stop(); slow.resolve(null); await flush()
    expect(applied).not.toHaveBeenCalled()
    hb.start(); await flush()
    expect(unavailable).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10000)
    expect(send.mock.calls[2][0]).toEqual({ s: {} })
    hb.stop()
  })

  it('失败指数退避，401转公共匿名订阅不跳登录', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockRejectedValueOnce(Error('offline')).mockRejectedValueOnce({ status: 401 }).mockResolvedValue({})
    const hb = factory()({ send, identity: () => 'expired', random: () => 0 })
    hb.subscribe('ann', { refresh: vi.fn() }); hb.subscribe('game:1', { interval: 5000, refresh: vi.fn() })
    hb.start(); await flush()
    await vi.advanceTimersByTimeAsync(10000)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(19999)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(send.mock.calls[2]).toEqual([{ s: { ann: 0 } }, true])
    hb.stop()
  })
})
