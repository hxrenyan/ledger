-- 当前旧结构的联系人改归原账本主人。先备份，孤儿记录须在执行前修正，见 sql/README.md。
-- ADD COLUMN 在迁移工具中幂等；联系人、日子和字典映射在同一事务组中完成。
ALTER TABLE dict_items ADD COLUMN user_id INTEGER;

-- @when-column contacts.ledger_id
CREATE TEMP TABLE contact_owner_migration_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO contact_owner_migration_guard
SELECT NOT EXISTS (SELECT 1 FROM contacts c LEFT JOIN ledgers l ON l.id = c.ledger_id WHERE l.id IS NULL OR l.owner_id IS NULL);
INSERT INTO contact_owner_migration_guard
SELECT NOT EXISTS (SELECT 1 FROM contact_dates d LEFT JOIN contacts c ON c.id = d.contact_id WHERE c.id IS NULL);
INSERT INTO contact_owner_migration_guard
SELECT NOT EXISTS (SELECT 1 FROM dict_items d WHERE d.kind = 'contact_date' AND d.ledger_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.id = d.ledger_id AND l.owner_id IS NOT NULL));
DROP TABLE contact_owner_migration_guard;
DROP INDEX IF EXISTS idx_contacts_ledger;
DROP INDEX IF EXISTS idx_contact_dates_ledger;
DROP INDEX IF EXISTS idx_dict_items_public_name;
ALTER TABLE contacts RENAME COLUMN ledger_id TO user_id;
UPDATE contacts SET user_id = (SELECT owner_id FROM ledgers WHERE id = contacts.user_id);
ALTER TABLE contact_dates RENAME COLUMN ledger_id TO user_id;
UPDATE contact_dates SET user_id = (SELECT user_id FROM contacts WHERE id = contact_dates.contact_id);
UPDATE dict_items SET user_id = (SELECT owner_id FROM ledgers WHERE id = dict_items.ledger_id), ledger_id = NULL
WHERE kind = 'contact_date' AND ledger_id IS NOT NULL;
UPDATE contact_dates SET item_id = (
  SELECT MIN(d.id) FROM dict_items d JOIN dict_items old
  ON d.user_id = old.user_id AND d.kind = old.kind AND d.name = old.name
  WHERE old.id = contact_dates.item_id
) WHERE item_id IN (SELECT id FROM dict_items WHERE user_id IS NOT NULL);
DELETE FROM dict_items WHERE user_id IS NOT NULL AND id NOT IN (
  SELECT MIN(id) FROM dict_items WHERE user_id IS NOT NULL GROUP BY user_id, kind, name
);
-- @end-when

CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts (user_id, archived, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_contact_dates_user ON contact_dates (user_id, contact_id, sort_order, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dict_items_user_name ON dict_items (user_id, kind, name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dict_items_public_name ON dict_items (kind, name) WHERE ledger_id IS NULL AND user_id IS NULL;
