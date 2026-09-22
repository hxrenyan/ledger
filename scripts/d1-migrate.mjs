#!/usr/bin/env node
/**
 * 幂等执行 sql/migrations/*.sql
 * - ADD COLUMN 若列已存在则跳过
 * - 其它语句失败则中止
 *
 * 用法：
 *   node scripts/d1-migrate.mjs --local
 *   node scripts/d1-migrate.mjs --remote
 *   node scripts/d1-migrate.mjs --local --env local
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

function parseStatements(sql) {
  return sql
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

const addColumnRe =
  /^ALTER\s+TABLE\s+([`"[]?\w+[`"\]]?)\s+ADD\s+COLUMN\s+([`"[]?\w+[`"\]]?)/i;

function stripIdent(raw) {
  return String(raw || "").replace(/[`"[\]]/g, "");
}

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
  const statements = parseStatements(sql);
  console.log(`\n→ ${file} (${statements.length} 条)`);

  for (const stmt of statements) {
    const m = stmt.match(addColumnRe);
    if (m) {
      const table = stripIdent(m[1]);
      const column = stripIdent(m[2]);
      const cols = listColumns(table);
      if (cols.has(column)) {
        console.log(`  skip ADD COLUMN ${table}.${column}（已存在）`);
        continue;
      }
    }

    const r = runWrangler(["--command", `${stmt};`]);
    if (r.status !== 0) {
      const err = `${r.stderr || ""}\n${r.stdout || ""}`;
      if (/duplicate column name/i.test(err)) {
        console.log(`  skip（duplicate column）：${stmt.slice(0, 80)}…`);
        continue;
      }
      console.error(`  FAIL: ${stmt.slice(0, 120)}`);
      console.error(err);
      process.exit(1);
    }
    console.log(`  ok: ${stmt.replace(/\s+/g, " ").slice(0, 88)}`);
  }
}

console.log("\n全部 migration 完成");
