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
  if (session.ledgerId) headers.set('x-ledger-id', session.ledgerId)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    session.clear()
    if (!path.startsWith('/api/v1/auth/')) location.href = '/login'
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

export type Ledger = { id: string; name: string; role: string }
export type SessionBody = {
  token: string
  user: { id: string; username: string; nickname: string }
  ledgers: Ledger[]
}
export type Account = { id: string; name: string; type: string; archived: boolean; current_cents: number }
export type Category = { id: string; name: string; kind: 'expense' | 'income'; archived: boolean }
export type Tx = {
  id: string
  account_id: string
  to_account_id: string | null
  category_id: string | null
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
  category_id: string
  category_name: string
  account_id: string
  account_name: string
  status: 'ok' | 'skip' | 'error'
  reason: string
  duplicate: boolean
  favor_contact: string
  favor_kind: '' | 'give' | 'receive'
  favor_occasion: string
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
  accounts: { id: string; name: string }[]
  categories: Category[]
}

export type ImportCommitResult = {
  batch_id: string
  imported: number
  duplicates: number
  skipped: number
  failed: { row: number; reason: string }[]
  gifts: number
}

export type ImportBatch = {
  id: string
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
