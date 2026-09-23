import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

/**
 * 跨语言边界的契约测试：把 miniprogram/utils/request.js 真的跑起来，
 * 让它发出的请求打到真实的 Hono 应用上。
 *
 * 为什么值得单独做：收据接口读的是 multipart 分片自己的 Content-Type
 * （src/routes/transactions.ts 里 `file.type` 必须命中 jpeg/png/webp 白名单），
 * 而小程序侧是手工拼的 multipart——边界串、头部字节长度、分片类型任何一个写错，
 * 在真机上只会看到一个「仅支持 jpeg / png / webp」的模糊报错。这里把它钉死。
 *
 * 加载方式：miniprogram 下的 .js 是 CommonJS，但仓库 package.json 是 type: module，
 * 直接被 node 当 ESM。所以用 new Function 手工注入 module/exports/require/wx。
 */

const REQUEST_SRC = readFileSync(join(process.cwd(), 'miniprogram/utils/request.js'), 'utf8')
const TRANSPORT_SRC = readFileSync(join(process.cwd(), 'miniprogram/utils/transport.js'), 'utf8')

/** 注入后拿到的模块导出。参数/返回值类型未知，用 unknown[] 收口。 */
type RequestModule = Record<string, (...args: unknown[]) => Promise<unknown>>

/**
 * 按小程序的方式加载一个 CommonJS 模块：手工注入 module/exports/require/wx。
 *
 * 之所以连 transport.js 也真的加载而不是打桩：request.js 现在把「请求怎么送出去」
 * 委托给了它，如果这里塞个假实现，这条契约测试就测不到真实路径了。
 */
function loadModule(
  src: string,
  wx: unknown,
  resolveRequire: (id: string) => unknown,
  label: string,
): Record<string, unknown> {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const requireStub = (id: string) => {
    const hit = resolveRequire(id)
    if (hit === undefined) throw new Error(`${label} 里出现了预期外的 require('${id}')`)
    return hit
  }
  const factory = new Function('module', 'exports', 'require', 'wx', src)
  factory(moduleObj, moduleObj.exports, requireStub, wx)
  return moduleObj.exports
}

/** 只放行 transport.js 与 request.js 真正用到的依赖，多一个就报错，防止悄悄扩大耦合。 */
function loadTransport(wx: unknown, configStub: unknown) {
  return loadModule(
    TRANSPORT_SRC,
    wx,
    (id) => (id === '../config' ? configStub : undefined),
    'transport.js',
  ) as {
    send: (options: {
      path: string
      method: string
      data?: unknown
      header?: Record<string, string>
    }) => Promise<{ statusCode: number; data: unknown }>
    usingCloud: () => boolean
  }
}

function loadRequestModule(
  wx: unknown,
  sessionState: { token: string; ledgerId: string },
  transportKind: 'direct' | 'cloud' = 'direct',
  cloudEnv = '',
) {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const calls = { cleared: 0 }
  const sessionStub = {
    getToken: () => sessionState.token,
    getLedgerId: () => sessionState.ledgerId,
    clear: () => {
      calls.cleared += 1
      sessionState.token = ''
    },
  }
  const configStub = {
    getBaseUrl: () => 'https://test.local',
    // 默认只覆盖直连通道；云通道的降级边界与认图送法另有专门用例。
    getTransport: () => transportKind,
    getCloudEnv: () => cloudEnv,
  }
  const transport = loadTransport(wx, configStub)
  const requireStub = (id: string) => {
    if (id === '../config') return configStub
    if (id === './session') return sessionStub
    if (id === './transport') return transport
    throw new Error(`request.js 里出现了预期外的 require('${id}')`)
  }
  // wx 作为参数注入，模块里对 wx 的引用就会落到这个桩上。
  const factory = new Function('module', 'exports', 'require', 'wx', REQUEST_SRC)
  factory(moduleObj, moduleObj.exports, requireStub, wx)
  return { mod: moduleObj.exports as RequestModule, calls }
}

/** 把 wx.request 转发给 Hono 应用，并记录实际发出的头部与体积。 */
function createWx(app: ReturnType<typeof createApp>, fileBytes: Uint8Array | null) {
  const log = {
    relaunch: [] as string[],
    requests: [] as { path: string; contentType: string; bodyBytes: number }[],
  }

  const wx = {
    request(opts: {
      url: string
      method?: string
      header?: Record<string, string>
      data?: unknown
      success: (res: { statusCode: number; data: unknown }) => void
      fail: (err: unknown) => void
    }) {
      const url = new URL(opts.url)
      const headers = new Headers()
      for (const [k, v] of Object.entries(opts.header ?? {})) headers.set(k, String(v))
      const raw = opts.data
      const body =
        raw !== undefined && raw !== null && typeof raw === 'object' && !(raw instanceof ArrayBuffer)
          ? // 真机 wx.request 会把对象按 content-type 序列化，桩要还原这一步，否则后端收到 [object Object]
            JSON.stringify(raw)
          : (raw as string | ArrayBuffer | undefined)
      log.requests.push({
        path: url.pathname,
        contentType: headers.get('content-type') ?? '',
        bodyBytes:
          body instanceof ArrayBuffer ? body.byteLength : typeof body === 'string' ? body.length : 0,
      })
      const init: RequestInit = { method: opts.method ?? 'GET', headers }
      if (body !== undefined) init.body = body
      // Hono 的 app.request 返回 Response | Promise<Response>，包一层统一成 Promise。
      Promise.resolve(app.request(url.pathname + url.search, init))
        .then(async (res: Response) => {
          const text = await res.text()
          // 真机 wx.request 对 JSON 响应会自动解析成对象，桩要还原，
          // 否则 request.js 里按 body.code 取错误码的分支测不出来。
          const isJson = (res.headers.get('content-type') ?? '').includes('json')
          let data: unknown = text
          if (isJson) {
            try {
              data = text ? JSON.parse(text) : null
            } catch {
              data = text
            }
          }
          opts.success({ statusCode: res.status, data })
        })
        .catch((err: unknown) => opts.fail(err))
    },
    reLaunch(o: { url: string }) {
      log.relaunch.push(o.url)
    },
    getFileSystemManager() {
      return {
        readFile(opts: {
          encoding?: string
          success: (res: { data: ArrayBuffer | string }) => void
          fail?: (err: unknown) => void
        }) {
          if (!fileBytes) {
            opts.fail?.(new Error('文件不存在'))
            return
          }
          // 云通道送图读的是 base64（readFileBase64），桩要按 encoding 分流，
          // 否则那条路径会拿到 ArrayBuffer 而静默拼出空的 data URL。
          if (opts.encoding === 'base64') {
            opts.success({ data: Buffer.from(fileBytes).toString('base64') })
            return
          }
          opts.success({
            data: fileBytes.buffer.slice(
              fileBytes.byteOffset,
              fileBytes.byteOffset + fileBytes.byteLength,
            ) as ArrayBuffer,
          })
        },
      }
    },
  }

  return { wx, log }
}

async function setupWithTx() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })

  const reg = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'mpuser', password: 'password1' }),
  })
  const session = (await reg.json()) as { token: string; ledgers: { id: string }[] }
  const ledgerId = session.ledgers[0].id
  const headers = {
    authorization: `Bearer ${session.token}`,
    'x-ledger-id': ledgerId,
    'content-type': 'application/json',
  }

  const accounts = (await (
    await app.request('/api/v1/accounts', { headers })
  ).json()) as { items: { id: string }[] }
  const categories = (await (
    await app.request('/api/v1/categories', { headers })
  ).json()) as { items: { id: string; kind: string }[] }

  const created = await app.request('/api/v1/transactions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'expense',
      amount_cents: 2300,
      account_id: accounts.items[0].id,
      category_id: categories.items.find((c) => c.kind === 'expense')?.id,
      date: '2026-09-23',
      note: '午饭',
    }),
  })
  const tx = (await created.json()) as { id: string }

  return { app, db, session, ledgerId, txId: tx.id }
}

describe('小程序请求层与后端的线上契约', () => {
  it('手工拼的 multipart 能被收据接口正确解析，字节数不多不少', async () => {
    const { app, db, session, ledgerId, txId } = await setupWithTx()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])
    const { wx, log } = createWx(app, png)
    const { mod } = loadRequestModule(wx, { token: session.token, ledgerId })

    await expect(mod.uploadReceipt(txId, 'wxfile://tmp_receipt.png', 'image/png')).resolves.toMatchObject({
      ok: true,
      has_receipt: true,
    })

    expect(log.requests).toHaveLength(1)
    expect(log.requests[0].contentType).toContain('multipart/form-data; boundary=')
    expect(log.requests[0].path).toBe(`/api/v1/transactions/${txId}/receipt`)

    // 关键断言：服务端按分片里的 Content-Type 存 mime，字节数必须和原图完全一致。
    const row = await db.first<{ mime: string; bytes: Uint8Array }>(
      `SELECT mime, bytes FROM attachments WHERE transaction_id = ?`,
      [txId],
    )
    expect(row?.mime).toBe('image/png')
    expect(new Uint8Array(row!.bytes).length).toBe(png.length)
    expect(Array.from(new Uint8Array(row!.bytes))).toEqual(Array.from(png))

    const flag = await db.first<{ has_receipt: number }>(
      `SELECT has_receipt FROM transactions WHERE id = ?`,
      [txId],
    )
    expect(flag?.has_receipt).toBe(1)
  })

  it('白名单外的类型本地就挡掉，不发请求也不调压缩', async () => {
    const { app, session, ledgerId, txId } = await setupWithTx()
    const { wx, log } = createWx(app, new Uint8Array([1, 2, 3]))
    const { mod } = loadRequestModule(wx, { token: session.token, ledgerId })

    await expect(mod.uploadReceipt(txId, 'x.gif', 'image/gif')).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect(log.requests).toHaveLength(0)
  })

  it('401 清会话并回小程序登录页，而不是跳网页登录', async () => {
    const { app, ledgerId } = await setupWithTx()
    const { wx, log } = createWx(app, null)
    const { mod, calls } = loadRequestModule(wx, { token: 'invalid.token.value', ledgerId })

    await expect(mod.get('/api/v1/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(calls.cleared).toBe(1)
    expect(log.relaunch).toEqual(['/pages/login/login'])
  })

  it('登录接口自身的 401 不当成掉登录，不触发跳转', async () => {
    const { app, ledgerId } = await setupWithTx()
    const { wx, log } = createWx(app, null)
    const { mod, calls } = loadRequestModule(wx, { token: '', ledgerId })

    await expect(
      mod.post('/api/v1/auth/login', { username: 'mpuser', password: 'wrong-password' }),
    ).rejects.toMatchObject({ status: 401 })
    expect(calls.cleared).toBe(0)
    expect(log.relaunch).toHaveLength(0)
  })
})

/**
 * 认图（拍照记账）的两条送法。
 *
 * 为什么单测这一层：云通道只有 JSON 一条路，图片必须转成 base64 塞进
 * callFunction 的 event（约 1MB 上限），而这条分支**只在体验版上生效** ——
 * 开发者工具里永远走不到，写错了本地一点都看不出来。
 */
describe('认图：直连与云通道各走各的送法', () => {
  /** 带 PNG 文件头的几个字节，够后端嗅探类型。 */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])

  it('直连：走 multipart，分片类型就是图片类型', async () => {
    const { app, session, ledgerId } = await setupWithTx()
    const { wx, log } = createWx(app, PNG)
    const { mod } = loadRequestModule(wx, { token: session.token, ledgerId })

    // 测试库里没配 OCR 模型，所以期望 502：图已经读入并通过类型校验，卡在「没配置」。
    // 类型不对会先返回 400 —— 两者足以区分「送对了」和「送错了」。
    await expect(
      mod.scanImage({ filePath: 'wxfile://shot.png', mime: 'image/png' }),
    ).rejects.toMatchObject({ status: 502, code: 'ocr_failed' })

    expect(log.requests).toHaveLength(1)
    expect(log.requests[0].path).toBe('/api/v1/ocr/scan')
    expect(log.requests[0].contentType).toContain('multipart/form-data; boundary=')
  })

  it('直连：分片类型不在白名单时后端 400（说明读的是分片自己的 Content-Type）', async () => {
    const { app, session, ledgerId } = await setupWithTx()
    const { wx } = createWx(app, PNG)
    const { mod } = loadRequestModule(wx, { token: session.token, ledgerId })

    await expect(
      mod.scanImage({ filePath: 'wxfile://shot.gif', mime: 'image/gif' }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('云通道：图片转成 JSON base64 走 callFunction，不发 wx.request', async () => {
    const events: { path: string; method: string; body: { image_base64: string; mime: string } }[] = []
    let directCalls = 0
    const wx = {
      cloud: {
        callFunction(o: { data: unknown; success: (r: unknown) => void }) {
          events.push(o.data as (typeof events)[number])
          o.success({ result: { statusCode: 200, data: { text: '合计 23.00' } } })
        },
      },
      request() {
        directCalls += 1
      },
      getFileSystemManager: () => ({
        readFile: (o: { encoding?: string; success: (r: { data: string }) => void }) =>
          o.success({ data: Buffer.from(PNG).toString('base64') }),
      }),
      reLaunch() {},
    }
    const { mod } = loadRequestModule(wx, { token: 't', ledgerId: 'l' }, 'cloud', 'ledger-test-env')

    await expect(mod.scanImage({ filePath: 'wxfile://a.png', mime: 'image/png' })).resolves.toEqual({
      text: '合计 23.00',
    })
    expect(directCalls).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0].path).toBe('/api/v1/ocr/scan')
    expect(events[0].method).toBe('POST')
    expect(events[0].body.image_base64).toBe(Buffer.from(PNG).toString('base64'))
    expect(events[0].body.mime).toBe('image/png')
  })

  it('云通道的体积上限更小，且 base64 膨胀后仍在 event 容量内', async () => {
    // loadRequestModule 会把 imageLimit 一起带出来（request.js 的导出）。
    const direct = loadRequestModule({}, { token: '', ledgerId: '' })
    const cloud = loadRequestModule({}, { token: '', ledgerId: '' }, 'cloud', 'ledger-test-env')
    // imageLimit 是同步函数，但 RequestModule 统一按「返回 Promise」收口，
    // 所以要经 unknown 转一次类型。
    const directLimit = (direct.mod.imageLimit as unknown as () => number)()
    const cloudLimit = (cloud.mod.imageLimit as unknown as () => number)()

    expect(cloudLimit).toBeLessThan(directLimit)
    // base64 会把字节放大 1/3（外加 JSON 外壳），换算后必须明显小于 event 的 1MB 上限。
    expect(Math.ceil((cloudLimit / 3) * 4)).toBeLessThan(1024 * 1024)
  })
})

/**
 * 云通道（体验版 / 正式版走的路）的降级边界。
 *
 * 这里守的是一条会造成真实损失的规则：**超时不能降级重试**。
 * 云函数超时意味着请求可能已经被转发并落库了，再走一遍直连就是重复记一笔。
 * 只有「云函数压根没发出去」（未开通 / 未部署 / 调用失败）才允许改走直连。
 */
describe('传输层：云通道何时可以降级', () => {
  const cloudConfig = {
    getBaseUrl: () => 'https://test.local',
    getTransport: () => 'cloud',
    getCloudEnv: () => 'ledger-test-env',
  }

  /** 桩要负责 settle，否则 Promise 一直挂着，测试只会超时看不出所以然。 */
  function wxStub(cloud: object, direct: (opts: { success: (r: unknown) => void; fail: (e: unknown) => void }) => void) {
    return { cloud: cloud, request: direct }
  }

  const cloudFail = (errMsg: string) => ({
    callFunction: (o: { fail: (e: unknown) => void }) => o.fail({ errMsg: errMsg }),
  })

  it('云函数未部署：降级直连，请求照样发得出去', async () => {
    let direct = 0
    const wx = wxStub(cloudFail('cloud.callFunction:fail 函数未找到'), (o) => {
      direct += 1
      o.success({ statusCode: 200, data: { ok: true } })
    })
    const transport = loadTransport(wx, cloudConfig)
    expect(transport.usingCloud()).toBe(true)
    await expect(transport.send({ path: '/api/v1/me', method: 'GET' })).resolves.toEqual({
      statusCode: 200,
      data: { ok: true },
    })
    expect(direct).toBe(1)
  })

  it('云函数超时：不降级，绝不重复提交', async () => {
    let direct = 0
    const wx = wxStub(cloudFail('cloud.callFunction:fail timeout'), (o) => {
      direct += 1
      o.success({ statusCode: 200, data: null })
    })
    const transport = loadTransport(wx, cloudConfig)
    await expect(
      transport.send({ path: '/api/v1/transactions', method: 'POST' }),
    ).rejects.toMatchObject({ code: 'cloud_unavailable', fallback: false })
    expect(direct).toBe(0)
  })

  it('云函数正常转发：状态码原样带回，不降级', async () => {
    let direct = 0
    const wx = wxStub(
      {
        callFunction: (o: { success: (r: unknown) => void }) =>
          o.success({ result: { statusCode: 401, data: { code: 'unauthorized' } } }),
      },
      (o) => {
        direct += 1
        o.success({ statusCode: 200, data: null })
      },
    )
    const transport = loadTransport(wx, cloudConfig)
    await expect(transport.send({ path: '/api/v1/me', method: 'GET' })).resolves.toEqual({
      statusCode: 401,
      data: { code: 'unauthorized' },
    })
    expect(direct).toBe(0)
  })

  it('没配云环境 ID 时不走云通道（改造前行为不变）', async () => {
    let cloudCalls = 0
    let directCalls = 0
    const wx = wxStub(
      {
        callFunction: () => {
          cloudCalls += 1
        },
      },
      (o) => {
        directCalls += 1
        o.success({ statusCode: 200, data: { ok: true } })
      },
    )
    const transport = loadTransport(wx, {
      getBaseUrl: () => 'https://test.local',
      getTransport: () => 'cloud',
      getCloudEnv: () => '',
    })
    expect(transport.usingCloud()).toBe(false)
    await expect(transport.send({ path: '/api/v1/me', method: 'GET' })).resolves.toEqual({
      statusCode: 200,
      data: { ok: true },
    })
    expect(cloudCalls).toBe(0)
    expect(directCalls).toBe(1)
  })
})
