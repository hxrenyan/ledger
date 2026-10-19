import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

type Value = Record<string, any>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** 请求层和导航、会话均执行真实源码，仅替换微信与网络边界。 */
function runtime(env = 'release') {
  const root = resolve(__dirname, '..', 'miniprogram')
  const storage = new Map<string, unknown>([['ledger.token', 'expired-token']])
  const pages: Value[] = [{ route: 'pages/home/home' }]
  const pending: { options: Value; task: ReturnType<typeof deferred<Value>> }[] = []
  const uploads: Value[] = []
  const send = vi.fn((options: Value) => {
    const task = deferred<Value>()
    pending.push({ options, task })
    return task.promise
  })
  const manager = { onUpdateReady: vi.fn(), onUpdateFailed: vi.fn(), applyUpdate: vi.fn() }
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: env, version: '1.0.0' } }),
    getUpdateManager: () => manager,
    getStorageSync: (key: string) => storage.get(key) ?? '',
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    reLaunch: vi.fn(({ url }: { url: string }) => { pages.splice(0, pages.length, { route: url.slice(1) }) }),
    switchTab: vi.fn(({ url }: { url: string }) => { pages.splice(0, pages.length, { route: url.slice(1) }) }),
    navigateTo: vi.fn(), redirectTo: vi.fn(), navigateBack: vi.fn(),
    uploadFile: vi.fn((options: Value) => uploads.push(options)),
    showToast: vi.fn(), showModal: vi.fn(),
  }
  const config = { getCloudEnv: () => '', getBaseUrl: () => 'https://test.local', currentEnv: () => ({}), currentEnvKey: () => 'prod' }
  const cache = new Map<string, Value>([
    [resolve(root, 'config.js'), config],
    [resolve(root, 'utils/transport.js'), { send, usingCloud: () => false }],
    [resolve(root, 'utils/ui.js'), { confirm: vi.fn().mockResolvedValue(true) }],
  ])
  let app: Value
  function load(file: string): Value {
    const path = resolve(root, file)
    const hit = cache.get(path)
    if (hit) return hit
    const mod = { exports: {} as Value }
    cache.set(path, mod.exports)
    let definition: Value | undefined
    const register = (value: Value) => { definition = value }
    new Function('module', 'exports', 'require', 'wx', 'getApp', 'getCurrentPages', 'App', 'Page', readFileSync(path, 'utf8'))(
      mod, mod.exports, (name: string) => load(resolve(dirname(path), name + '.js')),
      wx, () => app, () => pages, register, register,
    )
    const result = definition ?? mod.exports
    cache.set(path, result)
    return result
  }
  app = load('app.js')
  app.globalData = { ...app.globalData }
  const request = load('utils/request.js')
  const session = load('utils/session.js')
  const nav = load('utils/nav.js')
  function respond(index: number, data: unknown, statusCode = 200) {
    pending[index].task.resolve({ statusCode, data })
  }
  return { app, wx, pending, uploads, send, respond, session, nav, pages, load }
}

describe('强制更新优先于鉴权与页面跳转', () => {
  it('启动与前台检查复用同一请求，确认强制更新后不再签到', async () => {
    const { app, send, respond, pages } = runtime()
    app.onLaunch()
    const showing = app.onShow()
    expect(send).toHaveBeenCalledOnce()
    respond(0, { update_required: true })
    await showing
    expect(send).toHaveBeenCalledOnce()
    expect(pages[0].route).toBe('pages/force-update/force-update')
    expect(app._clientCheck).toBeNull()
  })

  it('普通请求迟到的 401 会清会话，但不能覆盖已经生效的更新页', async () => {
    const { app, respond, session, wx, pages, load } = runtime()
    const request = load('utils/request.js')
    const failed = expect(request.get('/api/v1/me')).rejects.toMatchObject({ status: 401 })
    const checking = app.checkClient()
    respond(1, { update_required: true })
    await checking
    respond(0, { code: 'unauthorized' }, 401)
    await failed
    expect(session.getToken()).toBe('')
    expect(pages[0].route).toBe('pages/force-update/force-update')
    expect(wx.reLaunch.mock.calls.map(([args]) => args.url)).toEqual(['/pages/force-update/force-update'])
  })

  it.each(['get', 'upload'])('旧账号的 %s 请求失败不能清掉新会话', async (kind) => {
    const { wx, uploads, respond, session, load } = runtime()
    const request = load('utils/request.js')
    const failed = expect(kind === 'get'
      ? request.get('/api/v1/me')
      : request.upload({ path: '/api/v1/speech/transcribe', filePath: 'voice.mp3' })).rejects.toMatchObject({ status: 401 })
    session.apply({ token: 'new-token' })
    if (kind === 'get') respond(0, {}, 401)
    else uploads[0].success({ statusCode: 401, data: '{}' })
    await failed
    expect(session.getToken()).toBe('new-token')
    expect(wx.reLaunch).not.toHaveBeenCalled()
  })

  it('上传的迟到 401 同样遵守版本门槛', async () => {
    const { app, uploads, session, pages, load } = runtime()
    const request = load('utils/request.js')
    const failed = expect(request.upload({ path: '/api/v1/speech/transcribe', filePath: 'voice.mp3' })).rejects.toMatchObject({ status: 401 })
    app.globalData.updateRequired = true
    uploads[0].success({ statusCode: 401, data: '{}' })
    await failed
    expect(session.getToken()).toBe('')
    expect(pages[0].route).toBe('pages/force-update/force-update')
  })

  it('已发出的签到迟到返回 401 时不能覆盖新检查触发的更新页', async () => {
    const { app, pending, respond, session, pages, wx } = runtime()
    const showing = app.onShow()
    respond(0, { update_required: false })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    const checking = app.checkClient()
    respond(2, { update_required: true })
    await checking
    respond(1, { code: 'unauthorized' }, 401)
    await showing
    expect(session.getToken()).toBe('')
    expect(pages[0].route).toBe('pages/force-update/force-update')
    expect(wx.reLaunch).toHaveBeenCalledOnce()
    expect(wx.showToast).not.toHaveBeenCalled()
  })

  it('公共导航、主动登录、登录成功与先看看都不能离开更新页', () => {
    const { app, nav, session, wx, pages, load } = runtime()
    app.globalData.updateRequired = true
    nav.go('home')
    nav.openNative('tx-form', {}, true)
    session.goLogin()
    const login = load('pages/login/login.js')
    login.onLoad()
    login.browse()
    login.afterLogin({ token: 'new-token' })
    expect(session.getToken()).toBe('new-token')
    expect(pages[0].route).toBe('pages/force-update/force-update')
    expect(wx.reLaunch).toHaveBeenCalledOnce()
    expect(wx.navigateTo).not.toHaveBeenCalled()
    expect(wx.redirectTo).not.toHaveBeenCalled()
    expect(wx.switchTab).not.toHaveBeenCalled()
    expect(wx.navigateBack).not.toHaveBeenCalled()
  })

  it('关于弹窗每次打开都读最新文案，不用启动时的缓存', async () => {
    const { app, wx, pending, respond, load } = runtime()
    app.globalData.client = { about_title: '旧标题', about_body: '旧正文' }
    const me = load('pages/me/me.js')
    const opening = me.about()
    expect(pending.some((item) => item.options.path === '/api/v1/app/client')).toBe(true)
    const index = pending.findIndex((item) => item.options.path === '/api/v1/app/client')
    respond(index, { about_title: '新标题', about_body: '个人和家庭记账' })
    await opening
    expect(wx.showModal).toHaveBeenCalledWith({
      title: '新标题',
      content: '个人和家庭记账',
      showCancel: false,
    })
  })

  it('我的页面入口和迟到的退出确认也遵守门槛', async () => {
    const { app, session, wx, pages, load } = runtime()
    const me = load('pages/me/me.js')
    app.globalData.updateRequired = true
    me.openFeedback()
    me.openPoints()
    me.logout()
    await vi.waitFor(() => expect(session.getToken()).toBe(''))
    expect(pages[0].route).toBe('pages/force-update/force-update')
    expect(wx.reLaunch).toHaveBeenCalledOnce()
    expect(wx.navigateTo).not.toHaveBeenCalled()
  })

  it('未触发门槛时公共导航仍按原方式打开页面', () => {
    const { nav, wx } = runtime()
    nav.go('home')
    nav.go('tx-form', { id: 7 })
    nav.openNative('tx-form', { id: 8 }, true)
    expect(wx.switchTab).toHaveBeenCalledWith({ url: '/pages/home/home' })
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: '/pages/tx-form/tx-form?id=7' })
    expect(wx.redirectTo).toHaveBeenCalledWith({ url: '/pages/tx-form/tx-form?id=8' })
    expect(wx.reLaunch).not.toHaveBeenCalled()
  })

  it.each(['release', 'develop', 'trial'])('允许使用的 %s 版本在检查完成后照常签到', async (env) => {
    const { app, respond, pending, wx } = runtime(env)
    const showing = app.onShow()
    expect(pending).toHaveLength(1)
    respond(0, { update_required: env !== 'release' })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].options.path).toBe('/api/v1/points/check-in')
    respond(1, { granted_daily: 1 })
    await showing
    expect(wx.showToast).toHaveBeenCalledWith({ title: '今日进入 +1', icon: 'none' })
    expect(wx.reLaunch).not.toHaveBeenCalled()
  })

  it('检查失败不会解除已生效的门槛，重查成功解除后可回首页', async () => {
    const { app, pending, respond, pages } = runtime()
    app.globalData.updateRequired = true
    const failed = app.onShow()
    pending[0].task.reject(new Error('网络不可用'))
    await failed
    expect(pending).toHaveLength(1)
    expect(pages[0].route).toBe('pages/force-update/force-update')
    const checking = app.checkClient()
    respond(1, { update_required: false })
    await checking
    expect(app.globalData.updateRequired).toBe(false)
    expect(pages[0].route).toBe('pages/home/home')
  })
})
