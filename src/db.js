// 连接与建表。启动时幂等执行，重复跑、回滚后再跑都不出错
import mysql from 'mysql2/promise'

const TABLES = [
  `CREATE TABLE IF NOT EXISTS meeting (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NULL,
    location VARCHAR(200) NULL,
    agenda TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_owner_start (owner_id, starts_at)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meeting_attendee (
    meeting_id BIGINT UNSIGNED NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (meeting_id, user_id),
    INDEX idx_user (user_id)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meeting_note (
    meeting_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    content MEDIUMTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  `CREATE TABLE IF NOT EXISTS meeting_item (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    meeting_id BIGINT UNSIGNED NOT NULL,
    kind ENUM('decision','todo','risk','agenda') NOT NULL,
    text VARCHAR(500) NOT NULL,
    owner_name VARCHAR(50) NULL,
    due_date DATE NULL,
    source ENUM('ai','manual') NOT NULL DEFAULT 'ai',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_meeting_kind (meeting_id, kind)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
]

// 建表之后新增的列登记在这里：{ table, column, ddl }，ddl 是 ADD COLUMN 后面那段定义
// 回滚只回代码不回库，新列要可空或有默认值
export const ADDED_COLUMNS = []

/** 所有时间按 UTC 进出库；DATE 保持字符串，避免被驱动按时区挪一天 */
export function createPool(url) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 8, charset: 'utf8mb4', timezone: 'Z', dateStrings: ['DATE'], waitForConnections: true })
  pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"))
  return pool
}

export async function ensureColumn(pool, { table, column, ddl }) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  if (rows.length) return false
  await pool.query('ALTER TABLE ?? ADD COLUMN ?? ' + ddl, [table, column])
  return true
}

export async function ensureSchema(pool, columns = ADDED_COLUMNS) {
  for (const sql of TABLES) await pool.query(sql)
  for (const c of columns) await ensureColumn(pool, c)
}
