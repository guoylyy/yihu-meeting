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

test('新增列清单当前为空（v0.1 是初始结构）', () => assert.deepEqual(ADDED_COLUMNS, []))

test('库和纪要列都是 utf8mb4，放得下 emoji 和大段中文', async () => {
  const [rows] = await pool.query("SELECT COLUMN_TYPE, CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting_note' AND COLUMN_NAME = 'content'")
  assert.equal(rows[0].COLUMN_TYPE, 'mediumtext')
  assert.equal(rows[0].CHARACTER_SET_NAME, 'utf8mb4')
})
