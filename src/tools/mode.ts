/**
 * 底部「工具」用哪一套界面。
 *
 * 存在 app_configs.tools.mode。没写过、或值不是 h5，一律当原生。
 * 小程序每次进入这一栏都来读，改完下一次进入就生效，不用发版。
 */

import type { Db } from '../db/types.ts'
import { badRequest } from '../http.ts'

const KEY = 'tools.mode'

export type ToolsMode = 'native' | 'h5'

export async function readToolsMode(db: Db): Promise<ToolsMode> {
  const row = await db.first<{ value: string }>(`SELECT value FROM app_configs WHERE key = ?`, [KEY])
  return row?.value === 'h5' ? 'h5' : 'native'
}

export async function saveToolsMode(db: Db, body: Record<string, unknown>): Promise<{ mode: ToolsMode }> {
  const mode = body.mode
  if (mode !== 'native' && mode !== 'h5') throw badRequest('模式只能是 native 或 h5')
  const now = Date.now()
  await db.run(
    `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, mode, now],
  )
  return { mode }
}
