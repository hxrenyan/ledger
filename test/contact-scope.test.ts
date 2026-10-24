import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { signToken } from '../src/auth/jwt.ts'
import { mergeUserStmts } from '../src/auth/mergeUser.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { patchSchema } from '../src/db/patch.ts'
import { upgradeContactScope, upgradeSchema } from '../src/db/upgrade.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { commitImport, undoBatch } from '../src/imports/service.ts'

const secret = 'contact-scope-test-secret'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  await db.exec(`
    INSERT INTO users (id, username, created_at) VALUES (1, 'owner', 1), (2, 'member', 1), (3, 'other', 1);
    INSERT INTO ledgers (id, name, owner_id, created_at) VALUES
      (11, '主人甲', 1, 1), (12, '主人乙', 1, 2), (21, '成员自己的', 2, 1), (31, '第三人', 3, 1);
    INSERT INTO members (ledger_id, user_id, role, created_at) VALUES
      (11, 1, 'owner', 1), (12, 1, 'owner', 1), (21, 2, 'owner', 1), (31, 3, 'owner', 1),
      (11, 2, 'member', 1), (12, 2, 'member', 1);
  `)
  const app = createApp({ db, jwtSecret: secret, adminToken: 'admin-secret' })
  async function request(userId: number, ledgerId: number, path: string, body?: unknown, method = 'POST') {
    const res = await app.request('/api/v1' + path, {
      method: body === undefined ? 'GET' : method,
      headers: {
        authorization: `Bearer ${await signToken(secret, userId)}`,
        'X-Ledger-Id': String(ledgerId),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as any }
  }
  return { db, request }
}

describe('联系人归账本主人账号', () => {
  it('同主人跨账本共用联系人和日子，礼金、导出仍按当前账本', async () => {
    const { request } = await setup()
    const created = await request(1, 11, '/contacts', {
      name: '张三', relation: '同事', dates: [{ kind: '乔迁', calendar: 'solar', month: 10, day: 21 }],
    })
    expect(created.status).toBe(201)
    const reused = await request(1, 12, '/contacts', { name: '张三' })
    expect(reused.body.id).toBe(created.body.id)
    expect(reused.body.dates).toEqual(created.body.dates)
    for (const [ledgerId, kind, amount] of [[11, 'give', 30000], [12, 'receive', 50000]] as const) {
      expect((await request(1, ledgerId, '/gifts', {
        contact_id: created.body.id, kind, amount_cents: amount, date: '2026-10-21',
      })).status).toBe(201)
    }
    expect((await request(1, 11, '/contacts')).body.items).toEqual([
      expect.objectContaining({ id: created.body.id, given_cents: 30000, received_cents: 0 }),
    ])
    expect((await request(1, 12, '/contacts')).body.items).toEqual([
      expect.objectContaining({ id: created.body.id, given_cents: 0, received_cents: 50000 }),
    ])
    expect((await request(1, 12, '/gifts')).body.items).toHaveLength(1)
    expect((await request(1, 12, '/export')).body.人情).toEqual([
      expect.objectContaining({ 对方: '张三', 方向: '收入', 金额: '500.00' }),
    ])
    const labels = await request(1, 12, '/dicts?kind=contact_date')
    expect(labels.body.items.map((item: { name: string }) => item.name)).toEqual(['乔迁'])
  })

  it('共享账本展示并修改主人的联系人，不混入成员私有名单；非成员不可访问', async () => {
    const { db, request } = await setup()
    const host = await request(1, 11, '/contacts', { name: '张三' })
    const own = await request(2, 21, '/contacts', {
      name: '张三', dates: [{ kind: '成员纪念日', calendar: 'solar', month: 1, day: 1 }],
    })
    expect(own.body.id).not.toBe(host.body.id)
    expect((await request(2, 11, '/contacts')).body.items.map((item: { id: number }) => item.id)).toEqual([host.body.id])
    expect((await request(2, 11, '/contacts/' + own.body.id, { relation: '错误归属' }, 'PATCH')).status).toBe(404)
    expect((await request(2, 11, '/gifts', { contact_id: own.body.id, kind: 'give', amount_cents: 100 })).status).toBe(400)
    const edited = await request(2, 11, '/contacts/' + host.body.id, {
      relation: '朋友', dates: [{ kind: '主人纪念日', calendar: 'solar', month: 2, day: 2 }],
    }, 'PATCH')
    expect(edited.status).toBe(200)
    const shared = await request(2, 12, '/contacts', { name: '李四' })
    expect(await db.first('SELECT user_id FROM contacts WHERE id = ?', [shared.body.id])).toEqual({ user_id: 1 })
    expect((await request(1, 12, '/contacts')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: host.body.id, relation: '朋友' }), expect.objectContaining({ id: shared.body.id }),
    ]))
    expect((await request(2, 11, '/dicts?kind=contact_date')).body.items.map((item: { name: string }) => item.name)).toEqual(['主人纪念日'])
    expect((await request(2, 21, '/dicts?kind=contact_date')).body.items.map((item: { name: string }) => item.name)).toEqual(['成员纪念日'])
    const another = await request(3, 31, '/contacts', { name: '张三' })
    expect(another.body.id).not.toBe(host.body.id)
    for (const path of ['/contacts', '/dicts?kind=contact_date', '/gifts']) {
      expect((await request(3, 11, path)).status).toBe(403)
    }
    expect((await request(3, 11, '/contacts', { name: '越权' })).status).toBe(403)
  })

  it('成员导入复用主人联系人，撤销保留跨账本人情及账号通讯录', async () => {
    const { db, request } = await setup()
    const contact = await request(1, 12, '/contacts', { name: '张三' })
    const own = await request(2, 21, '/contacts', { name: '张三' })
    await request(1, 12, '/gifts', { contact_id: contact.body.id, kind: 'give', amount_cents: 700 })
    const result = await commitImport(db, 11, 2, { rows: ['张三', '李四'].map((name) => ({
      date: '2026-10-21', direction: 'expense', amount_cents: 500,
      favor_contact: name, favor_kind: 'give', favor_occasion: '随礼', also_tx: false,
    })) })
    expect(result.gifts).toBe(2)
    expect(await db.first('SELECT contact_id, created_by FROM gifts WHERE ledger_id = ? AND contact_id = ?', [11, contact.body.id]))
      .toEqual({ contact_id: contact.body.id, created_by: 2 })
    expect(await db.first("SELECT user_id FROM contacts WHERE name = '李四'")).toEqual({ user_id: 1 })
    await undoBatch(db, 11, result.batch_id)
    expect(await db.first('SELECT COUNT(*) AS n FROM gifts WHERE ledger_id = 11')).toEqual({ n: 0 })
    expect(await db.first('SELECT COUNT(*) AS n FROM gifts WHERE ledger_id = 12')).toEqual({ n: 1 })
    expect(await db.first('SELECT user_id FROM contacts WHERE id = ?', [own.body.id])).toEqual({ user_id: 2 })
    expect((await request(1, 11, '/contacts')).body.items.map((item: { name: string }) => item.name)).toEqual(['张三'])
  })

  it('账号合并时一次迁移联系人及私有标签，共享账本也保留原有日子', async () => {
    const { db, request } = await setup()
    const target = await request(1, 11, '/contacts', {
      name: '张三', dates: [{ kind: '生日', calendar: 'solar', month: 1, day: 1 }],
    })
    const source = await request(2, 21, '/contacts', {
      name: '张三', dates: [
        { kind: '生日', calendar: 'solar', month: 1, day: 1 },
        { kind: '搬家', calendar: 'solar', month: 2, day: 2 },
      ],
    })
    const extra = await request(2, 21, '/contacts', { name: '李四' })
    await db.run("INSERT INTO members (ledger_id, user_id, role, created_at) VALUES (21, 3, 'member', 1)")
    await db.run("INSERT INTO user_identities (provider, openid, user_id, created_at) VALUES ('wechat', 'merge-openid', 2, 1)")
    await request(2, 21, '/gifts', { contact_id: source.body.id, kind: 'give', amount_cents: 600 })
    await db.batch(await mergeUserStmts(db, 2, 1, 'merge-openid'))
    expect(await db.first('SELECT user_id FROM contacts WHERE id = ?', [extra.body.id])).toEqual({ user_id: 1 })
    expect(await db.first('SELECT id FROM contacts WHERE id = ?', [source.body.id])).toBeNull()
    expect(await db.first('SELECT contact_id FROM gifts WHERE ledger_id = 21')).toEqual({ contact_id: target.body.id })
    expect((await request(3, 21, '/contacts')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.body.id, dates: [expect.objectContaining({ kind: '生日' }), expect.objectContaining({ kind: '搬家' })] }),
    ]))
    expect(await db.first('SELECT COUNT(*) AS n FROM dict_items WHERE user_id = 2')).toEqual({ n: 0 })
    expect((await request(1, 12, '/dicts?kind=contact_date')).body.items.map((item: { name: string }) => item.name)).toEqual(['生日', '搬家'])
  })
})

/** 从唯一 schema 派生旧结构，保留旧索引和有数据的关联用于验证迁移。 */
async function legacyDb(path = ':memory:') {
  const db = createSqliteDb(path)
  await db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'))
  await db.exec(`
    DROP INDEX idx_contacts_user;
    DROP INDEX idx_contact_dates_user;
    DROP INDEX idx_dict_items_user_name;
    DROP INDEX idx_dict_items_public_name;
    ALTER TABLE contacts RENAME COLUMN user_id TO ledger_id;
    ALTER TABLE contact_dates RENAME COLUMN user_id TO ledger_id;
    ALTER TABLE dict_items DROP COLUMN user_id;
    CREATE INDEX idx_contacts_ledger ON contacts (ledger_id, archived, name COLLATE NOCASE);
    CREATE INDEX idx_contact_dates_ledger ON contact_dates (ledger_id, contact_id, sort_order, id);
    CREATE UNIQUE INDEX idx_dict_items_public_name ON dict_items (kind, name) WHERE ledger_id IS NULL;
    INSERT INTO users (id, username, created_at) VALUES (7, 'old-owner', 1);
    INSERT INTO ledgers (id, name, owner_id, created_at) VALUES (101, '甲', 7, 1), (102, '乙', 7, 1);
    INSERT INTO contacts (id, ledger_id, name, created_at) VALUES (201, 101, '张三', 1), (202, 102, '李四', 1);
    INSERT INTO dict_items (id, ledger_id, kind, name, created_at) VALUES
      (301, 101, 'contact_date', '生日', 1), (302, 102, 'contact_date', '生日', 1);
    INSERT INTO contact_dates (ledger_id, contact_id, item_id, calendar, month, day, created_at) VALUES
      (101, 201, 301, 'solar', 1, 1, 1), (102, 202, 302, 'solar', 2, 2, 1);
    INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occurred_at, created_by, created_at, updated_at)
      VALUES (101, 201, 'give', 100, 1, 7, 1, 1);
  `)
  return db
}

async function assertMigrated(db: Awaited<ReturnType<typeof legacyDb>>) {
  expect(await db.all('SELECT id, user_id FROM contacts ORDER BY id')).toEqual([{ id: 201, user_id: 7 }, { id: 202, user_id: 7 }])
  expect(await db.all('SELECT user_id, item_id FROM contact_dates ORDER BY id')).toEqual([{ user_id: 7, item_id: 301 }, { user_id: 7, item_id: 301 }])
  expect(await db.all('SELECT id, ledger_id, user_id FROM dict_items')).toEqual([{ id: 301, ledger_id: null, user_id: 7 }])
  expect(await db.first('SELECT ledger_id, contact_id, amount_cents FROM gifts')).toEqual({ ledger_id: 101, contact_id: 201, amount_cents: 100 })
  expect((await db.all<{ name: string }>('PRAGMA table_info(contacts)')).map((row) => row.name)).not.toContain('ledger_id')
  const plan = await db.all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE user_id = 7 ORDER BY archived, name COLLATE NOCASE')
  expect(plan.some((row) => row.detail.includes('idx_contacts_user'))).toBe(true)
  expect(await db.first('SELECT COUNT(*) AS n FROM contact_dates d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN dict_items i ON i.id = d.item_id WHERE c.id IS NULL OR i.id IS NULL OR c.user_id != d.user_id')).toEqual({ n: 0 })
}

describe.each(['/export', '/export.json'])('账本导出 %s', (path) => {
  it.each([
    { label: '旧库没有人情记录', ownerScoped: false, hasGifts: false },
    { label: '旧库有人情记录', ownerScoped: false, hasGifts: true },
    { label: '已迁移账号范围', ownerScoped: true, hasGifts: true },
  ])('$label：共享成员导出当前账本，联系人按实际归属关联', async ({ ownerScoped, hasGifts }) => {
    const db = await legacyDb()
    await ensureMigrated(db)
    if (ownerScoped) await upgradeContactScope(db)
    const columns = (await db.all<{ name: string }>('PRAGMA table_info(contacts)')).map((row) => row.name)
    expect(columns).toContain(ownerScoped ? 'user_id' : 'ledger_id')
    expect(columns).not.toContain(ownerScoped ? 'ledger_id' : 'user_id')
    await db.batch([
      { sql: `INSERT INTO users (id, username, created_at) VALUES (8, 'export-member', 1)` },
      { sql: `INSERT INTO ledgers (id, name, owner_id, created_at) VALUES (103, '成员自己的', 8, 1)` },
      { sql: `INSERT INTO members (ledger_id, user_id, role, created_at)
              VALUES (101, 7, 'owner', 1), (102, 7, 'owner', 1), (101, 8, 'member', 1), (103, 8, 'owner', 1)` },
      { sql: `INSERT INTO accounts (id, ledger_id, name, type, created_at)
              VALUES (401, 101, '现金', 'cash', 1), (402, 102, '另一账户', 'cash', 1)` },
      { sql: `INSERT INTO categories (id, ledger_id, name, kind, created_at)
              VALUES (501, 101, '餐饮', 'expense', 1), (502, 102, '交通', 'expense', 1)` },
      { sql: `INSERT INTO transactions
                (ledger_id, account_id, category_id, kind, amount_cents, occurred_at, note, created_by, created_at, updated_at)
              VALUES (101, 401, 501, 'expense', 1234, 1, '账单甲', 7, 1, 1),
                     (102, 402, 502, 'expense', 5678, 1, '账单乙', 7, 1, 1)` },
      {
        sql: `INSERT INTO contacts (id, ${ownerScoped ? 'user_id' : 'ledger_id'}, name, created_at)
              VALUES (203, ?, '成员私有联系人', 1)`,
        params: [ownerScoped ? 8 : 103],
      },
      // 模拟历史错误关联，导出保留往来，但不泄露范围外的联系人姓名。
      { sql: `INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occurred_at, created_by, created_at, updated_at)
              VALUES (101, 202, 'receive', 300, 2, 7, 2, 2),
                     (101, 203, 'give', 500, 3, 7, 3, 3),
                     (102, 202, 'receive', 900, 4, 7, 4, 4)` },
    ])
    if (!hasGifts) await db.run('DELETE FROM gifts WHERE ledger_id = 101')
    const app = createApp({ db, jwtSecret: secret })
    const response = await app.request('/api/v1' + path, {
      headers: { authorization: `Bearer ${await signToken(secret, 8)}`, 'X-Ledger-Id': '101' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      账本: '甲',
      账单: [{ 日期: '1970-01-01', 类型: '支出', 金额: '12.34', 分类: '餐饮', 账户: '现金', 备注: '账单甲' }],
      人情: hasGifts ? [
        { 日期: '1970-01-01', 方向: '送出', 金额: '1.00', 对方: '张三' },
        { 日期: '1970-01-01', 方向: '收入', 金额: '3.00', 对方: ownerScoped ? '李四' : '' },
        { 日期: '1970-01-01', 方向: '送出', 金额: '5.00', 对方: '' },
      ] : [],
    })
  })
})

describe('联系人账号范围迁移', () => {
  it('启动不迁移联系人归属，旧账本范围的联系人接口仍可使用', async () => {
    const db = await legacyDb()
    await ensureMigrated(db)
    await ensureMigrated(db)
    await patchSchema(db)
    await upgradeSchema(db)
    const contactColumns = (await db.all<{ name: string }>('PRAGMA table_info(contacts)')).map((row) => row.name)
    expect(contactColumns).toContain('ledger_id')
    expect(contactColumns).not.toContain('user_id')
    expect(await db.all('SELECT id, ledger_id FROM contacts ORDER BY id')).toEqual([
      { id: 201, ledger_id: 101 }, { id: 202, ledger_id: 102 },
    ])
    expect(await db.all('SELECT ledger_id, contact_id FROM contact_dates ORDER BY id')).toEqual([
      { ledger_id: 101, contact_id: 201 }, { ledger_id: 102, contact_id: 202 },
    ])

    await db.exec(`
      INSERT INTO users (id, username, created_at) VALUES (8, 'old-member', 1);
      INSERT INTO members (ledger_id, user_id, role, created_at)
      VALUES (101, 7, 'owner', 1), (102, 7, 'owner', 1), (101, 8, 'member', 1);
    `)
    const app = createApp({ db, jwtSecret: secret, adminToken: 'admin-secret' })
    const request = async (ledgerId: number, path: string, body?: unknown, method = 'POST') => {
      const response = await app.request('/api/v1' + path, {
        method: body === undefined ? 'GET' : method,
        headers: {
          authorization: `Bearer ${await signToken(secret, ledgerId === 101 ? 8 : 7)}`,
          'X-Ledger-Id': String(ledgerId),
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as any }
    }
    const created = await request(101, '/contacts', {
      name: '新联系人', dates: [{ kind: '生日', calendar: 'solar', month: 3, day: 4 }],
    })
    expect(created.status).toBe(201)
    expect(created.body.dates).toEqual([expect.objectContaining({ kind: '生日', month: 3, day: 4 })])
    expect((await request(101, '/contacts')).body.items.map((item: { name: string }) => item.name)).toContain('新联系人')
    expect((await request(102, '/contacts')).body.items.map((item: { name: string }) => item.name)).not.toContain('新联系人')
    const edited = await request(101, '/contacts/' + created.body.id, {
      relation: '朋友', dates: [{ kind: '乔迁', calendar: 'solar', month: 4, day: 5 }],
    }, 'PATCH')
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ relation: '朋友', dates: [expect.objectContaining({ kind: '乔迁' })] })
    expect((await request(101, '/dicts?kind=contact_date')).body.items.map((item: { name: string }) => item.name)).toContain('乔迁')
    expect((await request(102, '/dicts?kind=contact_date')).body.items.map((item: { name: string }) => item.name)).not.toContain('乔迁')
    const gift = await request(101, '/gifts', { contact_id: created.body.id, kind: 'give', amount_cents: 300 })
    expect(gift.status).toBe(201)
    expect((await request(101, '/gifts/' + gift.body.id)).body.contact_id).toBe(created.body.id)
    expect((await request(101, '/gifts')).body.items).toHaveLength(2)
    expect((await request(102, '/gifts', { contact_id: created.body.id, kind: 'give', amount_cents: 300 })).status).toBe(400)

    const imported = await commitImport(db, 101, 8, { rows: ['新联系人', '导入联系人'].map((name) => ({
      date: '2026-10-21', direction: 'expense', amount_cents: 500,
      favor_contact: name, favor_kind: 'give', also_tx: false,
    })) })
    expect(imported.gifts).toBe(2)
    expect(await db.first("SELECT ledger_id FROM contacts WHERE name = '导入联系人'")).toEqual({ ledger_id: 101 })
    await undoBatch(db, 101, imported.batch_id)
    expect(await db.first("SELECT id FROM contacts WHERE name = '导入联系人'")).toBeNull()
    expect(await db.first('SELECT id FROM contacts WHERE id = ?', [created.body.id])).toEqual({ id: created.body.id })
  })

  it('旧结构账号合并按账本迁移联系人、日子和礼金，不要求账号字段', async () => {
    const db = await legacyDb()
    await ensureMigrated(db)
    await db.exec(`
      INSERT INTO users (id, username, created_at) VALUES (8, 'old-source', 1);
      INSERT INTO ledgers (id, name, owner_id, created_at) VALUES (103, '待合并', 8, 1);
      INSERT INTO members (ledger_id, user_id, role, created_at)
      VALUES (101, 7, 'owner', 1), (102, 7, 'owner', 1), (103, 8, 'owner', 1);
      INSERT INTO user_identities (provider, openid, user_id, created_at) VALUES ('wechat', 'old-merge-openid', 8, 1);
      INSERT INTO contacts (id, ledger_id, name, created_at) VALUES (203, 103, '张三', 1);
      INSERT INTO dict_items (id, ledger_id, kind, name, created_at) VALUES (303, 103, 'contact_date', '乔迁', 1);
      INSERT INTO contact_dates (ledger_id, contact_id, item_id, calendar, month, day, created_at)
      VALUES (103, 203, 303, 'solar', 3, 4, 1);
      INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occurred_at, created_by, created_at, updated_at)
      VALUES (103, 203, 'give', 200, 1, 8, 1, 1);
    `)
    await db.batch(await mergeUserStmts(db, 8, 7, 'old-merge-openid'))
    expect(await db.first('SELECT ledger_id, contact_id FROM gifts WHERE amount_cents = 200')).toEqual({ ledger_id: 101, contact_id: 201 })
    expect(await db.first('SELECT ledger_id, contact_id FROM contact_dates WHERE item_id = 303')).toEqual({ ledger_id: 101, contact_id: 201 })
    expect(await db.first('SELECT ledger_id FROM dict_items WHERE id = 303')).toEqual({ ledger_id: 101 })
  })

  it('更早旧库缺少日子表时补账本范围日子表，不改变联系人归属', async () => {
    const db = await legacyDb()
    await db.exec(`
      DROP TABLE contact_dates;
      ALTER TABLE contacts ADD COLUMN date_item_id INTEGER;
      ALTER TABLE contacts ADD COLUMN date_calendar TEXT;
      ALTER TABLE contacts ADD COLUMN date_month INTEGER;
      ALTER TABLE contacts ADD COLUMN date_day INTEGER;
      ALTER TABLE contacts ADD COLUMN date_year INTEGER;
      ALTER TABLE contacts ADD COLUMN date_leap INTEGER DEFAULT 0;
      UPDATE contacts SET date_item_id = 301, date_calendar = 'solar', date_month = 1, date_day = 1 WHERE id = 201;
    `)
    await ensureMigrated(db)
    expect(await db.first('SELECT ledger_id FROM contacts WHERE id = 201')).toEqual({ ledger_id: 101 })
    expect(await db.first('SELECT ledger_id, contact_id, item_id FROM contact_dates'))
      .toEqual({ ledger_id: 101, contact_id: 201, item_id: 301 })
  })

  it('显式执行迁移脚本后切换账号范围，重复执行不改数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-contact-scope-'))
    try {
      const path = join(dir, 'ledger.db')
      const db = await legacyDb(path)
      for (let i = 0; i < 2; i++) execFileSync(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, DB_PATH: path }, stdio: 'pipe' })
      await assertMigrated(db)
      await ensureMigrated(db)
      await assertMigrated(db)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无法解析原账本主人时整批回滚，不生成错误归属', async () => {
    const db = await legacyDb()
    await db.run('DELETE FROM ledgers WHERE id = 101')
    await expect(ensureMigrated(db)).resolves.toBeUndefined()
    await expect(upgradeContactScope(db)).rejects.toThrow()
    expect(await db.first('SELECT ledger_id FROM contacts WHERE id = 201')).toEqual({ ledger_id: 101 })
    expect((await db.all<{ name: string }>('PRAGMA table_info(dict_items)')).map((row) => row.name)).not.toContain('user_id')
  })
})
