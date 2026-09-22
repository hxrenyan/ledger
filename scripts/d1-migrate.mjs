#!/usr/bin/env node
/**
 * 幂等执行 sql/migrations/*.sql
 * - ADD COLUMN 若列已存在则跳过
 * - DROP COLUMN 若列已不存在则跳过
 * - -- @when-column 表.列 / -- @when-table 表 … -- @end-when：条件不成立则整组跳过
 * - 其它语句失败则中止
 *
 * 用法：
 *   node scripts/d1-migrate.mjs --local
 *   node scripts/d1-migrate.mjs --remote
 *   node scripts/d1-migrate.mjs --local --env local
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const migrationsDir = join(root, "sql", "migrations");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const local = args.includes("--local") || !remote;
const envIdx = args.indexOf("--env");
const envName = envIdx >= 0 ? args[envIdx + 1] : null;
const dbName = "ledger-db";

function runWrangler(extraArgs) {
  const cmd = [
    "wrangler",
    "d1",
    "execute",
    dbName,
    local ? "--local" : "--remote",
    ...(envName ? ["--env", envName] : []),
    ...extraArgs,
  ];
  return spawnSync("npx", cmd, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function listColumns(table) {
  const r = runWrangler(["--command", `PRAGMA table_info(${table});`]);
  if (r.status !== 0) {
    throw new Error(
      `PRAGMA table_info(${table}) 失败：${r.stderr || r.stdout}`
    );
  }
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  const names = new Set();
  const re = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (!["cid", "type", "notnull", "dflt_value", "pk"].includes(m[1])) {
      names.add(m[1]);
    }
  }
  return names;
}

const whenColumnRe = /^--\s*@when-column\s+(\w+)\.(\w+)\s*$/;
const whenTableRe = /^--\s*@when-table\s+(\w+)\s*$/;
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

function namesFrom(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const names = new Set();
  const re = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

function tableExists(table) {
  if (!/^\w+$/.test(table)) throw new Error(`非法表名 ${table}`);
  const r = runWrangler([
    "--command",
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}';`,
  ]);
  if (r.status !== 0) {
    throw new Error(`查询表 ${table} 失败：${r.stderr || r.stdout}`);
  }
  return namesFrom(r).has(table);
}

function gateOpen(gate) {
  if (gate.type === "table") return tableExists(gate.name);
  if (!tableExists(gate.table)) return false;
  return listColumns(gate.table).has(gate.column);
}

function formatGate(gate) {
  if (gate.type === "table") return `表 ${gate.name} 不存在`;
  return `列 ${gate.table}.${gate.column} 不存在`;
}

function runCommand(stmt) {
  const r = runWrangler(["--command", `${stmt};`]);
  if (r.status !== 0) {
    const err = `${r.stderr || ""}\n${r.stdout || ""}`;
    if (/duplicate column name/i.test(err)) {
      console.log(`  skip（duplicate column）：${stmt.slice(0, 80)}…`);
      return;
    }
    console.error(`  FAIL: ${stmt.slice(0, 120)}`);
    console.error(err);
    process.exit(1);
  }
  console.log(`  ok: ${stmt.replace(/\s+/g, " ").slice(0, 88)}`);
}

function runGroup(items) {
  const body = items.map((sql) => `${sql.trim().replace(/;\s*$/, "")};`).join("\n");
  const file = join(tmpdir(), `ledger-mig-${process.pid}-${Date.now()}.sql`);
  writeFileSync(file, body);
  try {
    const r = runWrangler(["--file", file]);
    if (r.status !== 0) {
      console.error(`  FAIL: ${items[0].replace(/\s+/g, " ").slice(0, 80)}`);
      console.error(`${r.stderr || ""}\n${r.stdout || ""}`);
      process.exit(1);
    }
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* 临时文件清不掉不影响迁移结果 */
    }
  }
  console.log(`  ok: ${items.length} 条（一组）`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function main() {
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (!files.length) {
  console.log("无 migration 文件");
  process.exit(0);
}

console.log(
  `迁移目标：${local ? "local" : "remote"}${envName ? ` env=${envName}` : ""}`
);

for (const file of files) {
  const full = join(migrationsDir, file);
  const sql = readFileSync(full, "utf8");
  const executeWholeFile = /^\s*--\s*@execute-whole-file\b/m.test(sql);
  if (executeWholeFile) {
    console.log(`\n→ ${file}（整文件事务）`);
    const r = runWrangler(["--file", full]);
    if (r.status !== 0) {
      console.error(`  FAIL: ${file}`);
      console.error(`${r.stderr || ""}\n${r.stdout || ""}`);
      process.exit(1);
    }
    console.log(`  ok: ${file}`);
    continue;
  }
  const statements = parseMigration(sql);
  const groups = groupMigration(statements);
  console.log(`\n→ ${file} (${statements.length} 条)`);

  for (const group of groups) {
    if (group.gate) {
      if (!gateOpen(group.gate)) {
        console.log(`  skip ${formatGate(group.gate)}`);
        continue;
      }
      runGroup(group.items);
      continue;
    }

    const stmt = group.items[0];
    const add = stmt.match(addColumnRe);
    if (add) {
      const table = stripIdent(add[1]);
      const column = stripIdent(add[2]);
      const cols = listColumns(table);
      if (cols.has(column)) {
        console.log(`  skip ADD COLUMN ${table}.${column}（已存在）`);
        continue;
      }
    }
    const drop = stmt.match(dropColumnRe);
    if (drop) {
      const table = stripIdent(drop[1]);
      const column = stripIdent(drop[2]);
      if (!tableExists(table) || !listColumns(table).has(column)) {
        console.log(`  skip DROP COLUMN ${table}.${column}（已不存在）`);
        continue;
      }
    }
    runCommand(stmt);
  }
}

console.log("\n全部 migration 完成");
}

if (isDirectRun()) main();
