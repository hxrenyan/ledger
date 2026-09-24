import { inMiniProgram, reLaunch } from './bridge.ts'
import { useSession } from './stores/session.ts'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = useSession()
  const headers = new Headers(init.headers)
  const isFD = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (!isFD && !headers.has('content-type') && init.body) headers.set('content-type', 'application/json')
  if (session.token) headers.set('authorization', `Bearer ${session.token}`)
  if (session.ledgerId) headers.set('x-ledger-id', String(session.ledgerId))
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    session.clear()
    if (!path.startsWith('/api/v1/auth/')) {
      // web-view 里没有 wx.login，网页自己的 /login 登录不了，
      // 要把用户交回小程序的登录页。
      if (inMiniProgram) reLaunch('/pages/login/login')
      else location.href = '/login'
    }
  }
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    if (!res.ok) throw new ApiError(res.status, 'error', '请求失败')
    return undefined as T
  }
  const data = JSON.parse(await res.text())
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? '请求失败')
  }
  return data as T
}

export type Ledger = { id: number; name: string; role: string }
export type SessionBody = {
  token: string
  user: { id: number; username: string; nickname: string; has_password: boolean; wechat_bound: boolean }
  ledgers: Ledger[]
  /** 仅 web-view 交接登录返回：小程序当时的账本，用于对齐首屏账本。未指定时是空字符串。 */
  ledger_id?: number | ''
}
export type Account = { id: number; name: string; type: string; archived: boolean; current_cents: number }
export type Category = { id: number; name: string; kind: 'expense' | 'income'; archived: boolean }
export type Tx = {
  id: number
  account_id: number
  to_account_id: number | null
  category_id: number | null
  kind: 'expense' | 'income' | 'transfer'
  amount_cents: number
  occurred_at: number
  note: string
  has_receipt: boolean
  excluded?: boolean
}

// ---------------------------------------------------------------------------
// 账单导入
// ---------------------------------------------------------------------------

export type ImportPreviewRow = {
  row: number
  date: string
  amount_cents: number
  direction: 'expense' | 'income' | 'skip'
  note: string
  counterparty: string
  category_id: number | null
  category_name: string
  account_id: number | null
  account_name: string
  status: 'ok' | 'skip' | 'error'
  reason: string
  duplicate: boolean
  favor_contact: string
  favor_kind: '' | 'give' | 'receive'
  favor_occasion: string
  /** 识别结果编辑时使用的元字段，提交前会转换回 amount_cents。 */
  amount_text?: string
}

export type ImportPreview = {
  source: string
  via: 'csv' | 'json'
  sheet?: string
  filename: string
  header_index: number
  header: string[]
  mapping: Record<string, number>
  stats: { total: number; ok: number; skip: number; failed: number; duplicate: number }
  truncated: boolean
  ai: { available: boolean; used: boolean; error?: string; truncated?: boolean }
  rows: ImportPreviewRow[]
  accounts: { id: number; name: string }[]
  categories: Category[]
}

export type ImportCommitResult = {
  batch_id: number
  imported: number
  duplicates: number
  skipped: number
  failed: { row: number; reason: string }[]
  gifts: number
}

export type ImportBatch = {
  id: number
  source: string
  filename: string
  parsed_rows: number
  imported_rows: number
  skipped_rows: number
  duplicate_rows: number
  ai_used: boolean
  status: string
  created_at: number
  undone_at: number | null
  created_by_name: string
}
