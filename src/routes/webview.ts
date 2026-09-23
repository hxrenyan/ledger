/**
 * web-view 混合架构的服务端支撑。
 *
 * 两个职责：
 * 1. 签发一次性交接码，让原生小程序把会话交给 web-view 里的网页（见 auth/handoff.ts）。
 * 2. 下发「页面归属表」：某个功能页走原生还是走网页。
 *    改这张表不用发版，是混合架构最主要的免审红利。
 *
 * 边界：这里只下发**数据**（开关、路径、文案），不下发任何可执行代码。
 * 微信《运营规范》禁止的是「内嵌网页规避平台规则」和动态下发代码，下发业务配置是常规做法。
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { issueHandoff } from '../auth/handoff.ts'
import { badRequest } from '../http.ts'

/** 只能原生的页面：依赖微信专属能力（wx.login / 录音 / 拍照 / 选文件），或就是高频主路径。 */
const NATIVE_ONLY = [
  'login',
  'home',
  'tx-form',
  'favors',
  'favor-person',
  'gift-form',
  'assets',
  'me',
  'speak',
] as const

/**
 * 允许切到 web-view 的长尾页。默认全部 native，逐页灰度打开——
 * 这样即使业务域名配好了，也不会一次全量切过去。
 */
const WEBVIEW_PAGES: Record<string, { mode: 'native' | 'webview'; path: string }> = {
  budgets: { mode: 'native', path: '/budgets' },
  categories: { mode: 'native', path: '/categories' },
  recurring: { mode: 'native', path: '/recurring' },
  import: { mode: 'native', path: '/import' },
  ledger: { mode: 'native', path: '/me' },
}

export type WebviewConfig = {
  enabled: boolean
  host: string
  pages: Record<string, { mode: 'native' | 'webview'; path: string }>
}

const KEY_ENABLED = 'webview.enabled'
const KEY_HOST = 'webview.host'
const KEY_PAGES = 'webview.pages'

function clonePages(): WebviewConfig['pages'] {
  const out: WebviewConfig['pages'] = {}
  for (const [k, v] of Object.entries(WEBVIEW_PAGES)) out[k] = { ...v }
  return out
}

/** 读配置表并按默认值兜底。表里没有记录时等于「混合未启用」，即纯原生。 */
export async function readWebviewConfig(db: AppEnv['Variables']['db']): Promise<WebviewConfig> {
  const rows = await db.all<{ key: string; value: string }>(
    `SELECT key, value FROM app_configs WHERE key IN (?, ?, ?)`,
    [KEY_ENABLED, KEY_HOST, KEY_PAGES],
  )
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const host = (map.get(KEY_HOST) ?? '').trim().replace(/\/+$/, '')
  const enabledRaw = (map.get(KEY_ENABLED) ?? '').trim()

  const pages = clonePages()
  const rawPages = map.get(KEY_PAGES)
  if (rawPages) {
    try {
      const parsed = JSON.parse(rawPages) as Record<string, { mode?: string; path?: string }>
      for (const [key, val] of Object.entries(parsed)) {
        // 只认白名单里的键，且禁止把原生专属页改成 webview。
        if (!pages[key] || !val) continue
        const mode = val.mode === 'webview' ? 'webview' : 'native'
        const path = typeof val.path === 'string' && val.path.startsWith('/') ? val.path : pages[key].path
        pages[key] = { mode, path }
      }
    } catch {
      /* 配置写坏了就退回默认，不要让网页打不开 */
    }
  }

  // 没配域名时强制 disabled：避免下发一个必然打不开的 web-view。
  const enabled = !!(enabledRaw === '1' || enabledRaw === 'true') && !!host
  return { enabled, host, pages }
}

/** 校验运维写进来的配置，写坏了直接报错，不要留到线上才发现。 */
function normalizeWrite(body: Record<string, unknown>, current: WebviewConfig): WebviewConfig {
  const next: WebviewConfig = {
    enabled: current.enabled,
    host: current.host,
    pages: { ...current.pages },
  }

  if ('webview.host' in body) {
    const raw = body['webview.host']
    const host = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
    if (host && !/^https:\/\/[^\s/]+$/.test(host)) {
      throw badRequest('webview.host 必须是形如 https://ledger.example.com 的地址（不能带路径和结尾斜杠）')
    }
    next.host = host
  }

  if ('webview.enabled' in body) {
    const raw = body['webview.enabled']
    next.enabled = raw === true || raw === 1 || raw === '1' || raw === 'true'
  }

  if ('webview.pages' in body) {
    const raw = body['webview.pages']
    if (raw == null) {
      next.pages = clonePages()
    } else if (typeof raw === 'object') {
      const pages = clonePages()
      for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (!pages[key]) {
          if ((NATIVE_ONLY as readonly string[]).includes(key)) {
            throw badRequest(`${key} 依赖微信专属能力，不能切到 web-view`)
          }
          throw badRequest(`未知页面 ${key}`)
        }
        const v = (val ?? {}) as { mode?: unknown; path?: unknown }
        const mode = v.mode === 'webview' ? 'webview' : 'native'
        const path = typeof v.path === 'string' && v.path.startsWith('/') ? v.path : pages[key].path
        pages[key] = { mode, path }
      }
      next.pages = pages
    } else {
      throw badRequest('webview.pages 需要是对象')
    }
  }

  if (next.enabled && !next.host) {
    throw badRequest('启用 web-view 前必须先配置 webview.host')
  }
  return next
}

export function registerWebviewRoutes(app: Hono<AppEnv>) {
  /**
   * 签发交接码。走正常鉴权（Bearer），账本可选：
   * 带了就校验成员身份，网页端直接落到同一个账本；没带或身份不符就留空。
   */
  app.post('/api/v1/webview/handoff', async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const raw = typeof body.ledger_id === 'string' ? body.ledger_id : c.req.header('X-Ledger-Id') ?? ''
    const userId = c.get('userId')

    let ledgerId = ''
    if (raw) {
      const row = await c.get('db').first(
        `SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`,
        [raw, userId],
      )
      if (row) ledgerId = raw
    }

    return c.json(await issueHandoff(c.get('db'), { userId, ledgerId }))
  })

  /** 小程序启动时拉一次页面归属表；失败就退回本地默认（全原生）。 */
  app.get('/api/v1/app/config', async (c) => {
    return c.json({ webview: await readWebviewConfig(c.get('db')) })
  })

  /** 运维接口：读配置。 */
  app.get('/api/v1/admin/app-config', async (c) => {
    return c.json({ webview: await readWebviewConfig(c.get('db')), native_only: NATIVE_ONLY })
  })

  /**
   * 运维接口：改配置。只传要改的键即可。
   * 例：{"webview.host":"https://ledger.example.com","webview.enabled":"1",
   *      "webview.pages":{"budgets":{"mode":"webview","path":"/budgets"}}}
   */
  app.put('/api/v1/admin/app-config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const db = c.get('db')
    const next = normalizeWrite(body, await readWebviewConfig(db))
    const now = Date.now()
    await db.batch([
      {
        sql: `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [KEY_ENABLED, next.enabled ? '1' : '0', now],
      },
      {
        sql: `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [KEY_HOST, next.host, now],
      },
      {
        sql: `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [KEY_PAGES, JSON.stringify(next.pages), now],
      },
    ])
    return c.json({ webview: next })
  })
}
