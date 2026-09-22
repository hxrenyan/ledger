const ITER = 10_000
const SALT_LEN = 16

function b64(u8: Uint8Array): string {
  let s = ''
  for (const x of u8) s += String.fromCharCode(x)
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    256,
  )
  return new Uint8Array(bits)
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i]
  return out === 0
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const key = await pbkdf2(password, salt, ITER)
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(key)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iter = Number(parts[1])
  if (!Number.isFinite(iter) || iter < 1000) return false
  const salt = fromB64(parts[2])
  const expected = fromB64(parts[3])
  const actual = await pbkdf2(password, salt, iter)
  return timingSafeEqual(actual, expected)
}

export function assertUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('用户名无效')
  const v = raw.trim()
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(v)) throw new Error('用户名须为 3–32 位字母、数字或下划线')
  return v
}

export function assertPassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 72) {
    throw new Error('密码须为 8–72 位')
  }
  return raw
}

export function assertNickname(raw: unknown, fallback: string): string {
  if (raw == null || raw === '') return fallback
  if (typeof raw !== 'string') throw new Error('昵称无效')
  const v = raw.trim()
  if (v.length < 1 || v.length > 32) throw new Error('昵称须为 1–32 字')
  return v
}
