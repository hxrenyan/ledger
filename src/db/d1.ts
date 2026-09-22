import type { Db, Stmt } from './types.ts'

export function createD1Db(d1: D1Database): Db {
  return {
    async all(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).all()
      return (r.results ?? []) as never
    },
    async first(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) as never
    },
    async run(sql, params = []) {
      await d1.prepare(sql).bind(...params).run()
    },
    async exec(sql) {
      await d1.exec(sql)
    },
    async batch(stmts: Stmt[]) {
      await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))))
    },
  }
}
