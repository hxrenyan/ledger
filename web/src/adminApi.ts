import { ApiError } from './api.ts'

const KEY = 'ledger.adminToken'

export function getAdminToken() {
  return localStorage.getItem(KEY) ?? ''
}

export function setAdminToken(token: string) {
  if (token) localStorage.setItem(KEY, token)
  else localStorage.removeItem(KEY)
}

export async function adminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json')
  const token = getAdminToken()
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    setAdminToken('')
    if (!path.endsWith('/login')) location.href = '/admin/login'
  }
  const data = JSON.parse(await res.text())
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? '请求失败')
  return data as T
}
