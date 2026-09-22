import { createApp } from './app.ts'
import { createD1Db } from './db/d1.ts'
import { patchSchema } from './db/patch.ts'

let patched = false

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
    })
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api')) {
      return app.fetch(request)
    }
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return app.fetch(request)
  },
}
