import { createApp } from './app.ts'
import { createD1Db } from './db/d1.ts'
import { patchSchema } from './db/patch.ts'

let patched = false

/** 微信 web-view 业务域名校验文件：/MP_verify_<随机串>.txt，必须是根目录下的纯文本。 */
const MP_VERIFY_RE = /^\/MP_verify_[A-Za-z0-9_-]+\.txt$/

/**
 * 业务域名校验文件的兜底出口。
 *
 * 注意配置里 `not_found_handling = "single-page-application"`：
 * 静态目录里没有这个文件时，请求会被 SPA 兜底成 index.html，微信校验必然失败。
 * 所以两种放法都支持，优先级：Wrangler 变量 > 静态目录里的真实文件。
 * 1. 把校验内容写进变量 MP_VERIFY（不用重新构建前端产物）——推荐；
 * 2. 或者把 txt 原样丢进 public/，靠 content-type 判断是不是真文件。
 */
async function serveMpVerify(request: Request, env: Env): Promise<Response> {
  const text = (env as unknown as { MP_VERIFY?: string }).MP_VERIFY
  if (text && text.trim()) {
    return new Response(`${text.trim()}\n`, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request)
    // SPA 兜底会把 index.html 返回成 200，这里用 content-type 把真文件挑出来。
    if (res.ok && (res.headers.get('content-type') ?? '').startsWith('text/plain')) return res
  }
  return new Response('未配置业务域名校验文件（MP_VERIFY 未设置，public/ 下也没有同名 txt）\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = createD1Db(env.DB)
    if (!patched) {
      await patchSchema(db)
      patched = true
    }
    const app = createApp({
      db,
      jwtSecret: env.JWT_SECRET || 'dev-change-me',
      adminToken: env.ADMIN_TOKEN || '',
      wechatAppId: env.WX_APPID,
      wechatAppSecret: env.WX_SECRET,
    })
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api')) {
      return app.fetch(request)
    }
    if (MP_VERIFY_RE.test(url.pathname)) {
      return serveMpVerify(request, env)
    }
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return app.fetch(request)
  },
}
