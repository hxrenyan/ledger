#!/usr/bin/env node
/**
 * 对 SQLite 文件幂等执行 sql/migrations/*.sql
 * - ADD COLUMN 若列已存在则跳过
 * - DROP COLUMN 若列已不存在则跳过
 * - -- @when-column 表.列 / -- @when-table 表 … -- @end-when：条件不成立则整组跳过
 * - 其它语句失败则中止
 *
 * 用法：
 *   node scripts/migrate.mjs
 *   DB_PATH=/data/ledger.db node scripts/migrate.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const migrationsDir = join(root, "sql", "migrations");
const dbPath = process.env.DB_PATH ?? join(root, "data", "ledger.db");

const args = process.argv.slice(2);
if (args.includes("--remote") || args.includes("--local") || args.includes("--env")) {
  console.error("数据库已是本地 SQLite 文件，不再区分 local/remote。");
  console.error("用法：DB_PATH=./data/ledger.db node scripts/migrate.mjs");
  process.exit(1);
}

const whenColumnRe = /^--\s*@when-column\s+(\w+)\.(\w+)\s*$/;
const whenTableRe = /^--\s*@when-table\s+(\w+)\s*$/;
const whenColumnTypeRe = /^--\s*@when-column-type\s+(\w+)\.(\w+)\s+(\w+)\s*$/m;
const endWhenRe = /^--\s*@end-when\s*$/;

/** 去掉普通注释，保留 @when-* 分组。同一组里的语句共享同一个 gate 对象。 */
export function parseMigration(sql) {
  const statements = [];
  let gate = null;
  for (const part of sql.split(";")) {
    const kept = [];
    for (const line of part.split("\n")) {
      const trimmed = line.trim();
      const column = trimmed.match(whenColumnRe);
      const table = trimmed.match(whenTableRe);
      if (column) {
        gate = { type: "column", table: column[1], column: column[2] };
        continue;
      }
      if (table) {
        gate = { type: "table", name: table[1] };
        continue;
      }
      if (endWhenRe.test(trimmed)) {
        gate = null;
        continue;
      }
      if (/^\s*--/.test(line)) continue;
      kept.push(line);
    }
    const text = kept.join("\n").trim();
    if (text) statements.push({ gate, sql: text });
  }
  return statements;
}

export function groupMigration(statements) {
  const groups = [];
  for (const stmt of statements) {
    const prev = groups.at(-1);
    if (stmt.gate && prev?.gate === stmt.gate) prev.items.push(stmt.sql);
    else groups.push({ gate: stmt.gate, items: [stmt.sql] });
  }
  return groups;
}

const addColumnRe =
  /^ALTER\s+TABLE\s+([`"[]?\w+[`"\]]?)\s+ADD\s+COLUMN\s+([`"[]?\w+[`"\]]?)/i;
const dropColumnRe =
  /^ALTER\s+TABLE\s+([`"[]?\w+[`"\]]?)\s+DROP\s+COLUMN\s+([`"[]?\w+[`"\]]?)/i;

function stripIdent(raw) {
  return String(raw || "").replace(/[`"[\]]/g, "");
}

function openDb() {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function listColumns(db, table) {
  if (!/^\w+$/.test(table)) throw new Error(`非法表名 ${table}`);
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function columnType(db, table, column) {
  if (!/^\w+$/.test(table) || !/^\w+$/.test(column)) throw new Error(`非法标识符 ${table}.${column}`);
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`PRAGMA table_info(${table})`).all().find((item) => item.name === column);
  return row ? row.type : null;
}

function tableExists(db, table) {
  if (!/^\w+$/.test(table)) throw new Error(`非法表名 ${table}`);
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

function gateOpen(db, gate) {
  if (gate.type === "table") return tableExists(db, gate.name);
  if (!tableExists(db, gate.table)) return false;
  return listColumns(db, gate.table).has(gate.column);
}

function formatGate(gate) {
  if (gate.type === "table") return `表 ${gate.name} 不存在`;
  return `列 ${gate.table}.${gate.column} 不存在`;
}

function fail(stmt, err) {
  console.error(`  FAIL: ${String(stmt).replace(/\s+/g, " ").slice(0, 120)}`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

function runCommand(db, stmt) {
  try {
    db.exec(stmt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(message)) {
      console.log(`  skip（duplicate column）：${stmt.slice(0, 80)}…`);
      return;
    }
    fail(stmt, err);
  }
  console.log(`  ok: ${stmt.replace(/\s+/g, " ").slice(0, 88)}`);
}

function runGroup(db, items) {
  const tx = db.transaction(() => {
    for (const sql of items) db.exec(sql);
  });
  try {
    tx();
  } catch (err) {
    fail(items[0], err);
  }
  console.log(`  ok: ${items.length} 条（一组）`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function main() {
  if (!existsSync(migrationsDir)) {
    console.log("无 migration 目录");
    return;
  }
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    console.log("无 migration 文件");
    return;
  }

  const db = openDb();
  console.log(`迁移目标：${dbPath}`);

  for (const file of files) {
    const full = join(migrationsDir, file);
    const sql = readFileSync(full, "utf8");
    const typeGate = sql.match(whenColumnTypeRe);
    if (typeGate) {
      const actual = columnType(db, typeGate[1], typeGate[2]);
      if (!actual || actual.toUpperCase() !== typeGate[3].toUpperCase()) {
        console.log(
          `\n→ ${file} skip（${typeGate[1]}.${typeGate[2]} 当前是 ${actual ?? "不存在"}，不是 ${typeGate[3]}）`,
        );
        continue;
      }
    }
    const executeWholeFile = /^\s*--\s*@execute-whole-file\b/m.test(sql);
    if (executeWholeFile) {
      console.log(`\n→ ${file}（整文件事务）`);
      const tx = db.transaction(() => {
        db.exec(sql);
      });
      try {
        tx();
      } catch (err) {
        fail(file, err);
      }
      console.log(`  ok: ${file}`);
      continue;
    }
    const statements = parseMigration(sql);
    const groups = groupMigration(statements);
    console.log(`\n→ ${file} (${statements.length} 条)`);

    for (const group of groups) {
      if (group.gate) {
        if (!gateOpen(db, group.gate)) {
          console.log(`  skip ${formatGate(group.gate)}`);
          continue;
        }
        runGroup(db, group.items);
        continue;
      }

      const stmt = group.items[0];
      const add = stmt.match(addColumnRe);
      if (add) {
        const table = stripIdent(add[1]);
        const column = stripIdent(add[2]);
        const cols = listColumns(db, table);
        if (cols.has(column)) {
          console.log(`  skip ADD COLUMN ${table}.${column}（已存在）`);
          continue;
        }
      }
      const drop = stmt.match(dropColumnRe);
      if (drop) {
        const table = stripIdent(drop[1]);
        const column = stripIdent(drop[2]);
        if (!tableExists(db, table) || !listColumns(db, table).has(column)) {
          console.log(`  skip DROP COLUMN ${table}.${column}（已不存在）`);
          continue;
        }
      }
      runCommand(db, stmt);
    }
  }

  db.close();
  console.log("\n全部 migration 完成");
}

if (isDirectRun()) main();
