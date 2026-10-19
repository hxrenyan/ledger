import type { Db } from '../db/types.ts'
import { badRequest } from '../http.ts'

/** 没配过时，「关于记账」仍用这段，和原来弹窗一致。 */
export const DEFAULT_ABOUT_TITLE = '记账'
export const DEFAULT_ABOUT_BODY =
  '个人和家庭记账。记录收入、支出和转账，查看月度明细与预算，管理账户和分类。可以建多个账本，邀请家人一起记，也能记人情往来、做周期记账、导入和导出账单。'
export const DEFAULT_UPDATE_MESSAGE = '当前版本已停用，请更新后继续使用。'

const KEY = 'miniprogram.client'
const TITLE_MAX = 20
const BODY_MAX = 400
const MESSAGE_MAX = 80

export type ClientConfig = {
  about_title: string
  about_body: string
  /** 空字符串表示不限制版本。 */
  min_version: string
  update_message: string
}

type Stored = Partial<ClientConfig>

/**
 * 小程序「关于」文案，以及正式版最低可用版本。
 * 存在 app_configs.miniprogram.client。没写过就用默认文案，不强制更新。
 */
export async function readClientConfig(db: Db): Promise<ClientConfig> {
  const row = await db.first<{ value: string }>(`SELECT value FROM app_configs WHERE key = ?`, [KEY])
  return normalize(parseStored(row?.value))
}

export async function saveClientConfig(db: Db, body: Record<string, unknown>): Promise<ClientConfig> {
  const next = normalize({
    about_title: textField(body.about_title, '标题', TITLE_MAX),
    about_body: textField(body.about_body, '正文', BODY_MAX),
    min_version: versionField(body.min_version),
    update_message: optionalText(body.update_message, MESSAGE_MAX),
  })
  const now = Date.now()
  await db.run(
    `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(next), now],
  )
  return next
}

/** 正式版把正在运行的版本传上来。低于最低版本时必须更新。 */
export function clientView(config: ClientConfig, version: string) {
  const required = versionBelow(version, config.min_version)
  return {
    about_title: config.about_title,
    about_body: config.about_body,
    min_version: config.min_version,
    update_required: required,
    update_message: config.update_message || DEFAULT_UPDATE_MESSAGE,
  }
}

/** 当前版本低于最低版本。最低版本为空则不限制；当前版本空着或格式不对，视为过低。 */
export function versionBelow(current: string, min: string): boolean {
  const need = versionParts(min)
  if (!need.length) return false
  const have = versionParts(current)
  if (!have.length) return true
  const length = Math.max(need.length, have.length)
  for (let i = 0; i < length; i += 1) {
    const left = have[i] ?? 0
    const right = need[i] ?? 0
    if (left < right) return true
    if (left > right) return false
  }
  return false
}

function parseStored(raw: string | undefined): Stored {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Stored
  } catch {
    return {}
  }
}

function normalize(input: Stored): ClientConfig {
  return {
    about_title: clean(input.about_title, DEFAULT_ABOUT_TITLE, TITLE_MAX),
    about_body: clean(input.about_body, DEFAULT_ABOUT_BODY, BODY_MAX),
    min_version: typeof input.min_version === 'string' ? input.min_version.trim() : '',
    update_message: typeof input.update_message === 'string' ? input.update_message.trim().slice(0, MESSAGE_MAX) : '',
  }
}

function clean(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text) return fallback
  return [...text].slice(0, max).join('')
}

function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw badRequest(`${label}须为文字`)
  const text = value.trim()
  const length = [...text].length
  if (length < 1 || length > max) throw badRequest(`${label}须为 1–${max} 字`)
  return text
}

function optionalText(value: unknown, max: number): string {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw badRequest('更新提示须为文字')
  const text = value.trim()
  if ([...text].length > max) throw badRequest(`更新提示最多 ${max} 字`)
  return text
}

function versionField(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') throw badRequest('最低版本格式应为 1.2.3')
  const text = value.trim()
  if (!text) return ''
  if (!versionParts(text).length) throw badRequest('最低版本格式应为 1.2.3')
  return text
}

function versionParts(raw: string): number[] {
  const text = raw.trim()
  if (!text || !/^\d+(\.\d+){0,2}$/.test(text)) return []
  return text.split('.').map((part) => Number(part))
}
