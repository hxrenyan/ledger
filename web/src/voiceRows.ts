/**
 * 语音入账的行筛选规则（纯函数，无浏览器 / Vue 依赖，便于单测）。
 * 页面和浮层都用这里的规则，保证「明细记全部、人情只记人情」两处一致。
 */

export type VoiceScope = 'tx' | 'favor'

/** 只描述筛选需要的字段，ImportPreviewRow 天然满足。 */
export type VoiceRowLike = {
  status: 'ok' | 'skip' | 'error'
  direction: 'expense' | 'income' | 'skip'
  favor_contact: string
  favor_kind: '' | 'give' | 'receive'
}

/** 是否是识别人情往来的行（有对方姓名且有送出 / 收入方向）。 */
export function isFavorRow(r: VoiceRowLike) {
  return !!r.favor_contact && (r.favor_kind === 'give' || r.favor_kind === 'receive')
}

/** 待入账的行：解析成功、方向不是忽略；人情场景只取识别人情的行。 */
export function pickPayable<T extends VoiceRowLike>(rows: T[], scope: VoiceScope): T[] {
  return rows.filter((r) => r.status === 'ok' && r.direction !== 'skip' && (scope === 'tx' || isFavorRow(r)))
}

/** 人情场景下不会被记入的行数（普通流水行，以及没识别出人情方向的行）。 */
export function countIgnored(rows: VoiceRowLike[]) {
  return rows.filter((r) => r.status === 'ok' && r.direction !== 'skip' && !isFavorRow(r)).length
}
