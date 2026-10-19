import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = resolve(__dirname, '..')

function loadCjs(file: string): Record<string, any> {
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))(
    mod, mod.exports, (name: string) => loadCjs(resolve(dirname(file), `${name}.js`)),
  )
  return mod.exports
}

const money = loadCjs(resolve(root, 'miniprogram/utils/money.js'))
const time = loadCjs(resolve(root, 'miniprogram/utils/time.js'))
const selected = { filePath: 'previous-photo.jpg' }
const localText = '微信支付成功午饭35元'
const points = { wechat: true, balance: 100, today_checked: true }
const voicePreview = { parser: 'ai', items: [{ direction: 'expense', amount_cents: 1200, note: '语音午饭', status: 'ok' }] }
const cloudPreview = { parser: 'ai', items: [{ direction: 'expense', amount_cents: 8800, note: '照片晚饭', status: 'ok' }] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 执行真实组件与录音回调，只替换微信、网络和图片识别边界。 */
function panelHarness() {
  const request = {
    get: vi.fn().mockResolvedValue(points),
    post: vi.fn((path: string) => Promise.resolve(path.endsWith('/utterances') ? voicePreview : { parser: 'ai', items: [] })),
    uploadBinary: vi.fn().mockResolvedValue({ text: '午饭十二元' }),
    scanImage: vi.fn().mockResolvedValue({ text: '云端照片晚饭88元' }),
  }
  const image = { pick: vi.fn().mockResolvedValue(selected), prepare: vi.fn().mockResolvedValue({ filePath: 'prepared-photo.jpg' }) }
  const localOcr = { supported: () => true, usable: () => true, recognize: vi.fn().mockResolvedValue(localText) }
  const ui = { toast: vi.fn(), fail: vi.fn(), ok: vi.fn() }
  let confirm: (res: { confirm: boolean }) => void = () => {}
  let start: () => void = () => {}
  let stop: (res: unknown) => void = () => {}
  const recorder = {
    onStart: (cb: typeof start) => { start = cb },
    onStop: (cb: typeof stop) => { stop = cb },
    onError: vi.fn(),
    start: vi.fn(() => start()),
    stop: vi.fn(() => stop({ tempFilePath: 'current-voice.mp3', duration: 1000 })),
  }
  const wx = {
    showModal: vi.fn((options: { success: typeof confirm }) => { confirm = options.success }),
    getRecorderManager: () => recorder,
  }
  const modules: Record<string, unknown> = {
    '../../utils/request': request, '../../utils/image': image, '../../utils/localOcr': localOcr,
    '../../utils/session': { isWechat: () => true }, '../../utils/ui': ui, '../../utils/money': money, '../../utils/time': time,
  }
  let def: Record<string, any> = {}
  new Function('require', 'wx', 'Component', readFileSync(resolve(root, 'miniprogram/components/ai-panel/ai-panel.js'), 'utf8'))(
    (name: string) => {
      if (!(name in modules)) throw new Error(`未配置依赖：${name}`)
      return modules[name]
    }, wx, (value: typeof def) => { def = value },
  )
  const panel: Record<string, any> = { ...def.methods, data: structuredClone({ ...def.data, canSpeak: true, canPhoto: true }) }
  panel.setData = (patch: Record<string, unknown>) => Object.assign(panel.data, patch)
  def.lifetimes.attached.call(panel)
  return { panel, request, image, localOcr, ui, wx, recorder, confirm: (accepted = true) => confirm({ confirm: accepted }) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('语音与上一轮照片隔离', () => {
  it('本机识图未整理出记录后直接录音，语音核对不能再上传旧照片', async () => {
    const { panel, request, image, wx, recorder } = panelHarness()
    panel.pickPhoto()
    await settle()
    expect(panel.data).toMatchObject({ state: 'idle', mode: 'photo', canCloudRetry: true, ocrSource: 'local', rawText: localText })
    expect(panel.photoPicked).toEqual(selected)
    const gen = panel.photoGen

    panel.startRecord()
    expect(panel.photoPicked).toBeNull()
    expect(panel.photoGen).toBeGreaterThan(gen)
    expect(panel.data).toMatchObject({ mode: '', canCloudRetry: false, ocrSource: '', text: '', rawText: '', parser: '', aiError: '' })
    await settle()
    expect(recorder.start).toHaveBeenCalledOnce()
    panel.finishRecord()
    await settle()

    expect(panel.data).toMatchObject({ state: 'editing', mode: 'voice', canCloudRetry: false, ocrSource: '', rawText: '' })
    expect(panel.data.items[0]).toMatchObject({ amountText: '12.00', noteText: '语音午饭' })
    panel.cloudRetry()
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(image.prepare).not.toHaveBeenCalled()
    expect(request.scanImage).not.toHaveBeenCalled()
    expect(request.post.mock.calls.map(([path]) => path)).toEqual(['/api/v1/imports/receipt', '/api/v1/imports/utterances'])
  })

  it('即使残留照片和重试标记，语音模式也拒绝云端重试', () => {
    const { panel, image, wx } = panelHarness()
    panel.photoPicked = selected
    panel.setData({ state: 'editing', mode: 'voice', canCloudRetry: true, ocrSource: 'local' })
    panel.cloudRetry()
    expect(wx.showModal).not.toHaveBeenCalled()
    expect(image.prepare).not.toHaveBeenCalled()
  })

  it('上传确认晚于新语音积分检查时，不能上传上一张照片', async () => {
    const { panel, request, image, confirm, wx } = panelHarness()
    panel.pickPhoto()
    await settle()
    panel.cloudRetry()
    expect(wx.showModal).toHaveBeenCalledOnce()
    const pendingPoints = deferred<typeof points>()
    request.get.mockReturnValueOnce(pendingPoints.promise)
    panel.startRecord()
    confirm()
    await settle()
    expect(image.prepare).not.toHaveBeenCalled()
    pendingPoints.resolve(points)
    await settle()
    expect(panel.data).toMatchObject({ state: 'recording', mode: 'voice', canCloudRetry: false, ocrSource: '' })
  })

  it('确认时模式已变，即使照片代次未变也不上传', async () => {
    const { panel, image, confirm } = panelHarness()
    panel.pickPhoto()
    await settle()
    panel.cloudRetry()
    panel.setData({ mode: 'voice' })
    confirm()
    expect(image.prepare).not.toHaveBeenCalled()
  })

  it('选图积分检查晚于新语音时，不再打开选图器', async () => {
    const { panel, request, image } = panelHarness()
    const pendingPoints = deferred<typeof points>()
    request.get.mockReturnValueOnce(pendingPoints.promise)
    panel.pickPhoto()
    panel.startRecord()
    await settle()
    pendingPoints.resolve(points)
    await settle()
    expect(image.pick).not.toHaveBeenCalled()
    expect(panel.data).toMatchObject({ state: 'recording', mode: 'voice' })
  })

  it('选图器晚于新语音返回时，不再识别旧照片', async () => {
    const { panel, image, localOcr } = panelHarness()
    const pendingPick = deferred<typeof selected>()
    image.pick.mockReturnValueOnce(pendingPick.promise)
    panel.pickPhoto()
    await settle()
    expect(image.pick).toHaveBeenCalledOnce()
    panel.startRecord()
    await settle()
    pendingPick.resolve(selected)
    await settle()
    expect(localOcr.recognize).not.toHaveBeenCalled()
    expect(panel.photoPicked).toBeNull()
    expect(panel.data).toMatchObject({ state: 'recording', mode: 'voice' })
  })

  it('重新开始后迟到的照片整理结果不能覆盖语音核对', async () => {
    const { panel, request } = panelHarness()
    const pendingReceipt = deferred<typeof cloudPreview>()
    request.post.mockImplementation((path: string) => path.endsWith('/receipt') ? pendingReceipt.promise : Promise.resolve(voicePreview))
    panel.pickPhoto()
    await settle()
    expect(panel.data.state).toBe('busy')
    panel.retry()
    panel.startRecord()
    await settle()
    panel.finishRecord()
    await settle()
    const voiceState = structuredClone(panel.data)
    pendingReceipt.resolve(cloudPreview)
    await settle()
    expect(panel.data).toEqual(voiceState)
    expect(panel.data.items[0].noteText).toBe('语音午饭')
  })

  it('语音积分检查期间不能启动照片选择或旧照片重试', async () => {
    const { panel, request, image, wx } = panelHarness()
    const pendingPoints = deferred<typeof points>()
    request.get.mockReturnValueOnce(pendingPoints.promise)
    panel.startRecord()
    panel.pickPhoto()
    panel.cloudRetry()
    await settle()
    expect(request.get).toHaveBeenCalledOnce()
    expect(image.pick).not.toHaveBeenCalled()
    expect(wx.showModal).not.toHaveBeenCalled()
    pendingPoints.resolve(points)
    await settle()
    expect(panel.data).toMatchObject({ state: 'recording', mode: 'voice' })
  })

  it('未切换模式的本机识别仍可确认上传同一张照片并替换核对结果', async () => {
    const { panel, request, image, confirm } = panelHarness()
    panel.pickPhoto()
    await settle()
    request.post.mockResolvedValueOnce(cloudPreview)
    panel.cloudRetry()
    confirm()
    await settle()
    expect(image.prepare).toHaveBeenCalledWith(selected)
    expect(request.scanImage).toHaveBeenCalledWith({ filePath: 'prepared-photo.jpg' })
    expect(panel.data).toMatchObject({ state: 'editing', mode: 'photo', canCloudRetry: false, ocrSource: 'cloud' })
    expect(panel.data.items[0]).toMatchObject({ amountText: '88.00', noteText: '照片晚饭' })
    expect(request.post).toHaveBeenLastCalledWith('/api/v1/imports/receipt', { text: '云端照片晚饭88元' }, { timeout: 120000 })
  })
})

describe('日历语音先拆日期和事情', () => {
  it('识别后核对日期和事情，再记到对应那一天', async () => {
    const { panel, request, ui } = panelHarness()
    panel.triggerEvent = vi.fn()
    panel.setData({ target: 'note' })
    request.uploadBinary.mockResolvedValueOnce({ text: '明天下午三点开会' })
    request.post.mockImplementation((path: string, body: { day?: string; body?: string }) => {
      if (path.endsWith('/parse')) {
        return Promise.resolve({ items: [{ day: '2026-10-20', body: '下午三点开会', clipped: false }] })
      }
      if (path.endsWith('/day-notes')) return Promise.resolve({ id: 1, day: body.day, body: body.body })
      return Promise.resolve(voicePreview)
    })
    panel.startRecord()
    await settle()
    panel.finishRecord()
    await settle()
    expect(panel.data.state).toBe('note')
    expect(panel.data.noteItems[0]).toMatchObject({ day: '2026-10-20', body: '下午三点开会' })
    expect(request.post).toHaveBeenCalledWith('/api/v1/day-notes/parse', { text: '明天下午三点开会' })
    panel.saveNote()
    await settle()
    expect(request.post).toHaveBeenCalledWith('/api/v1/day-notes', { day: '2026-10-20', body: '下午三点开会' })
    expect(ui.ok).toHaveBeenCalledWith('已记到明天')
  })

  it('拆分失败时整句仍放在今天，不丢这句话', async () => {
    const { panel, request } = panelHarness()
    panel.setData({ target: 'note' })
    request.uploadBinary.mockResolvedValueOnce({ text: '明天下午三点开会' })
    request.post.mockRejectedValueOnce(new Error('解析失败'))
    panel.startRecord()
    await settle()
    panel.finishRecord()
    await settle()
    expect(panel.data.state).toBe('note')
    expect(panel.data.noteItems[0].body).toBe('明天下午三点开会')
    expect(panel.data.noteItems[0].day).toBe(time.todayISO())
  })
})
