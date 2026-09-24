export type Stmt = { sql: string; params?: unknown[] }

export type BatchResult = { lastId: number | null }

export type Db = {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>
  run(sql: string, params?: unknown[]): Promise<void>
  exec(sql: string): Promise<void>
  batch(stmts: Stmt[]): Promise<BatchResult[]>
}

/** INSERT 语句的自增主键。非 INSERT 或没插进行返回 null。 */
export function insertedId(sql: string, changes: number, lastRowId: number): number | null {
  if (!/^\s*insert\b/i.test(sql) || changes <= 0 || !Number.isSafeInteger(lastRowId) || lastRowId <= 0) return null
  return lastRowId
}
