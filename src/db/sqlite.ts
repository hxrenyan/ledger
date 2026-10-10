import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { insertedId, type Db, type Stmt } from './types.ts'

/**
 * 预编译语句缓存上限。语句的原生内存只在 JS 回收包装对象时才释放，
 * 每次 prepare 新对象会让进程常驻内存持续上涨；IN (?,?,…) 这类按参数个数变化的 SQL
 * 会产生很多不同文本，所以要有上限，按最近使用淘汰。
 */
const STMT_CACHE_MAX = 200

export function createSqliteDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')

  const stmts = new Map<string, Database.Statement>()
  function prepare(sql: string) {
    const hit = stmts.get(sql)
    if (hit) {
      stmts.delete(sql)
      stmts.set(sql, hit)
      return hit
    }
    const stmt = raw.prepare(sql)
    stmts.set(sql, stmt)
    if (stmts.size > STMT_CACHE_MAX) stmts.delete(stmts.keys().next().value!)
    return stmt
  }

  return {
    async all(sql, params = []) {
      return prepare(sql).all(...params) as never
    },
    async first(sql, params = []) {
      return (prepare(sql).get(...params) as never) ?? null
    },
    async run(sql, params = []) {
      prepare(sql).run(...params)
    },
    async exec(sql) {
      raw.exec(sql)
    },
    async batch(list: Stmt[]) {
      const tx = raw.transaction(() => {
        return list.map((s) => {
          const info = prepare(s.sql).run(...(s.params ?? []))
          return { lastId: insertedId(s.sql, info.changes, Number(info.lastInsertRowid)) }
        })
      })
      return tx()
    },
  }
}
