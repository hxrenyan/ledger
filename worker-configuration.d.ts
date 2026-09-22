interface Env {
  DB: D1Database
  ASSETS?: Fetcher
  JWT_SECRET?: string
  ADMIN_TOKEN?: string
  WX_APPID?: string
  WX_SECRET?: string
}
