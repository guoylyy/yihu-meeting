import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { ADDED_COLUMNS, createPool, ensureColumn, ensureSchema } from '../src/db.js'

let pool
before(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
})
after(() => pool.end())

const indexes = async (table) => {
  const [rows] = await pool.query(`SHOW INDEX FROM ${table}`)
  const out = {}
  for (const r of rows) (out[r.Key_name] ??= []).push(r.Column_name)
  return out
}

test('建表幂等：重复执行不报错', async () => {
  await ensureSchema(pool)
  await ensureSchema(pool)
})

test('索引和约定一致', async () => {
  assert.deepEqual((await indexes('meeting')).idx_owner_start, ['owner_id', 'starts_at'])
  assert.deepEqual((await indexes('meeting_attendee')).idx_user, ['user_id'])
  assert.deepEqual((await indexes('meeting_item')).idx_meeting_kind, ['meeting_id', 'kind'])
})

test('ensureColumn：缺列才加，再跑一次不动', async () => {
  await pool.query('DROP TABLE IF EXISTS meeting_col_test')
  await pool.query('CREATE TABLE meeting_col_test (id INT PRIMARY KEY)')
  const col = { table: 'meeting_col_test', column: 'extra', ddl: 'VARCHAR(20) NULL' }
  assert.equal(await ensureColumn(pool, col), true)
  assert.equal(await ensureColumn(pool, col), false)
  await pool.query('DROP TABLE meeting_col_test')
})

test('新增列都可空或是虚拟列，回滚旧代码写入不受影响', async () => {
  const [rows] = await pool.query("SELECT COLUMN_NAME, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting'")
  for (const c of ADDED_COLUMNS) {
    const row = rows.find((r) => r.COLUMN_NAME === c.column)
    assert.ok(row, c.column)
    assert.equal(row.IS_NULLABLE, 'YES', c.column)
  }
})

test('held_at 是 starts_at 的虚拟列，两边不会不一致', async () => {
  const [r] = await pool.query("INSERT INTO meeting (owner_id, title, starts_at) VALUES (1, '虚拟列', '2026-11-02 07:00:00')")
  const [[row]] = await pool.query('SELECT starts_at, held_at FROM meeting WHERE id = ?', [r.insertId])
  assert.equal(row.held_at.getTime(), row.starts_at.getTime())
  await pool.query("UPDATE meeting SET starts_at = '2026-11-03 07:00:00' WHERE id = ?", [r.insertId])
  const [[moved]] = await pool.query('SELECT held_at FROM meeting WHERE id = ?', [r.insertId])
  assert.equal(moved.held_at.toISOString(), '2026-11-03T07:00:00.000Z')
  await pool.query('DELETE FROM meeting WHERE id = ?', [r.insertId])
})

test('v0.1 的库升上来：缺的列补齐，老数据还在', async () => {
  await pool.query('DROP TABLE IF EXISTS meeting_upgrade_test')
  await pool.query('CREATE TABLE meeting_upgrade_test (id INT PRIMARY KEY, starts_at DATETIME NOT NULL)')
  await pool.query("INSERT INTO meeting_upgrade_test VALUES (1, '2026-01-01 00:00:00')")
  await ensureColumn(pool, { table: 'meeting_upgrade_test', column: 'held_at', ddl: 'DATETIME GENERATED ALWAYS AS (starts_at) VIRTUAL' })
  const [[row]] = await pool.query('SELECT held_at FROM meeting_upgrade_test WHERE id = 1')
  assert.equal(row.held_at.toISOString(), '2026-01-01T00:00:00.000Z')
  await pool.query('DROP TABLE meeting_upgrade_test')
})

test('库和纪要列都是 utf8mb4，放得下 emoji 和大段中文', async () => {
  const [rows] = await pool.query("SELECT COLUMN_TYPE, CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting_note' AND COLUMN_NAME = 'content'")
  assert.equal(rows[0].COLUMN_TYPE, 'mediumtext')
  assert.equal(rows[0].CHARACTER_SET_NAME, 'utf8mb4')
})
