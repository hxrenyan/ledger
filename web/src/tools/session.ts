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
  const res = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } })
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  if (!res.ok) throw new Error(body.message || '请求失败')
  return body as T
}

type MiniProgram = { navigateTo: (opts: { url: string }) => void }

export function inMiniProgram() {
  if (typeof navigator === 'undefined') return false
  if (/miniProgram/i.test(navigator.userAgent || '')) return true
  const env = (window as Window & { __wxjs_environment?: string }).__wxjs_environment
  return env === 'miniprogram'
}

export async function openFavorPerson(id: number) {
  await loadJweixin()
  const mp = (window as Window & { wx?: { miniProgram?: MiniProgram } }).wx?.miniProgram
  if (!mp) throw new Error('请在小程序里查看往来')
  mp.navigateTo({ url: `/pages/favor-person/favor-person?id=${id}` })
}

function loadJweixin(): Promise<void> {
  const wxObj = (window as Window & { wx?: { miniProgram?: MiniProgram } }).wx
  if (wxObj?.miniProgram) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('打不开往来'))
    document.head.appendChild(script)
  })
}
