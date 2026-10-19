const TOKEN = 'ledger.tools.token'
const LEDGER = 'ledger.tools.ledger'

export function hasSession() {
  return !!sessionStorage.getItem(TOKEN) && !!sessionStorage.getItem(LEDGER)
}

export function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${sessionStorage.getItem(TOKEN) || ''}`,
    'x-ledger-id': sessionStorage.getItem(LEDGER) || '',
    'content-type': 'application/json',
  }
}

export async function exchangeHandoff(code: string) {
  const res = await fetch('/api/v1/auth/webview-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const body = (await res.json().catch(() => ({}))) as { message?: string; token?: string; ledger_id?: number }
  if (!res.ok) throw new Error(body.message || '登录失败')
  if (!body.token || !body.ledger_id) throw new Error('会话不完整')
  sessionStorage.setItem(TOKEN, body.token)
  sessionStorage.setItem(LEDGER, String(body.ledger_id))
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init, headers: { ...authHeaders(), ...(init.headers || {}) } })
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok) throw new Error(body.message || '请求失败')
  return body as T
}
