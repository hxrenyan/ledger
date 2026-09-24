import { SignJWT, jwtVerify } from 'jose'

function key(secret: string) {
  return new TextEncoder().encode(secret)
}

export type TokenPayload = { sub: string; admin: boolean }

export async function signToken(secret: string, userId: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key(secret))
}

export async function signAdminToken(secret: string): Promise<string> {
  return new SignJWT({ admin: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key(secret))
}

export async function verifyToken(secret: string, token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, key(secret))
  if (!payload.sub) throw new Error('token 无 sub')
  return { sub: payload.sub, admin: payload.admin === true }
}
