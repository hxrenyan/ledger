export type Stmt = { sql: string; params?: unknown[] }

export type Db = {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>
  run(sql: string, params?: unknown[]): Promise<void>
  exec(sql: string): Promise<void>
  batch(stmts: Stmt[]): Promise<void>
}
