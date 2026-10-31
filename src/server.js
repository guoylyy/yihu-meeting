// 会议与纪要。入口只做接线，先监听再连库，/health 才能如实反映启动状态
import { Workspace } from './yh-one.mjs'
import { createApp } from './app.js'
import { createPool, ensureSchema } from './db.js'
import { VERSION } from './version.js'

const RETRY_MS = 3000

const ws = new Workspace()
const url = process.env.DATABASE_URL
const pool = url ? createPool(url) : null
let ready = false

const app = createApp({
  ws,
  pool,
  getReady: () => ready,
  aiTimeoutMs: Number(process.env.MEETING_AI_TIMEOUT_MS) || undefined
})

async function prepare() {
  try {
    await ensureSchema(pool)
    ready = true
    console.log('[meeting] 数据库已就绪')
  } catch (e) {
    console.error(`[meeting] 连不上数据库，${RETRY_MS / 1000} 秒后重试：${e.message}`)
    setTimeout(prepare, RETRY_MS)
  }
}

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`[meeting] v${VERSION} listening on :${port}`)
  if (pool) prepare()
  else console.warn('[meeting] 没有 DATABASE_URL，只提供 /health')
})
