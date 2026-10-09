/**
 * 小程序登录用的 AppID / AppSecret。
 *
 * 管理后台写入 app_configs，下一次登录请求就读新值，不用重启。
 * 后台没配齐时才退回进程环境变量 WX_APPID / WX_SECRET。
 * 测试注入的 exchangeWechatCode 优先于库和环境变量。
 */

import type { Db } from '../db/types.ts'
import { badRequest } from '../http.ts'
import { maskSecret } from '../profiles.ts'
import { exchangeWechatCode, resolveWechatExchange, type WechatCodeExchange, type WechatConfig } from './wechat.ts'

const KEY_APP_ID = 'wechat.app_id'
const KEY_APP_SECRET = 'wechat.app_secret'
const APP_ID = /^wx[0-9a-f]{16}$/i
const APP_SECRET = /^[A-Za-z0-9]{16,64}$/

export type WechatAdminConfig = {
  app_id: string
  secret_hint: string
  configured: boolean
}

type StoredWechat = { appId: string; appSecret: string }

async function readStored(db: Db): Promise<StoredWechat> {
  const rows = await db.all<{ key: string; value: string }>(
    `SELECT key, value FROM app_configs WHERE key IN (?, ?)`,
    [KEY_APP_ID, KEY_APP_SECRET],
  )
  const map = new Map(rows.map((row) => [row.key, row.value]))
  return {
    appId: (map.get(KEY_APP_ID) ?? '').trim(),
    appSecret: (map.get(KEY_APP_SECRET) ?? '').trim(),
  }
}

function toPublic(stored: StoredWechat): WechatAdminConfig {
  const configured = !!(stored.appId && stored.appSecret)
  return {
    app_id: stored.appId,
    secret_hint: maskSecret(stored.appSecret),
    configured,
  }
}

export async function readWechatAdminConfig(db: Db): Promise<WechatAdminConfig> {
  return toPublic(await readStored(db))
}

export async function saveWechatAdminConfig(db: Db, body: Record<string, unknown>): Promise<WechatAdminConfig> {
  const current = await readStored(db)
  const appId = typeof body.app_id === 'string' ? body.app_id.trim() : ''
  if (!APP_ID.test(appId)) throw badRequest('AppID 须为 wx 开头的 18 位小程序 AppID')

  const incoming = typeof body.app_secret === 'string' ? body.app_secret.trim() : ''
  let appSecret = current.appSecret
  if (incoming) {
    if (!APP_SECRET.test(incoming)) throw badRequest('AppSecret 格式不正确')
    appSecret = incoming
  } else if (body.clear_secret === true) {
    appSecret = ''
  }
  if (!appSecret) throw badRequest('请填写 AppSecret')

  const now = Date.now()
  await db.batch([
    {
      sql: `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [KEY_APP_ID, appId, now],
    },
    {
      sql: `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [KEY_APP_SECRET, appSecret, now],
    },
  ])
  return toPublic({ appId, appSecret })
}

/** 登录时用哪套凭证换 openid。注入 > 后台 > 环境变量。 */
export async function resolveLoginExchange(db: Db, cfg: WechatConfig): Promise<WechatCodeExchange | null> {
  if (cfg.exchangeWechatCode) return cfg.exchangeWechatCode
  const stored = await readStored(db)
  if (stored.appId && stored.appSecret) {
    return (code) => exchangeWechatCode(stored.appId, stored.appSecret, code)
  }
  return resolveWechatExchange({ wechatAppId: cfg.wechatAppId, wechatAppSecret: cfg.wechatAppSecret })
}
