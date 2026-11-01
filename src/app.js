// 只做接线：中间件 → 接口 → MCP → 页面。路由在 routes/，权限在 meetings.js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { VERSION } from './version.js'
import { todayIn } from './dates.js'
import { HttpError, createMeetings } from './meetings.js'
import { PlatformUsersError, createPlatformUsers } from './platform-users.js'
import { createSettings } from './settings.js'
import { createModelInfo } from './about.js'
import { detail } from './present.js'
import { buildTools, mcpHandler } from './mcp.js'
import { apiRouter } from './routes/api.js'
import { importRouter } from './routes/import.js'
import { pageRouter } from './routes/pages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEV_USER = { id: 1, name: '本地用户' }
const BODY_LIMIT = '256kb' // 纪要上限 5 万字，全是四字节字符也放得下

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next)
const CSP = "default-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'"

export function createApp({ ws, pool, getReady = () => !!pool, aiTimeoutMs, importTimeoutMs }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('views', path.join(here, 'views'))
  app.set('view engine', 'ejs')

  const meetings = pool ? createMeetings({ pool }) : null
  const settings = pool ? createSettings({ pool }) : null
  const credentials = { clientId: ws.clientId, clientSecret: ws.clientSecret, apiUrl: ws.apiUrl }
  const users = createPlatformUsers(credentials)
  const modelInfo = createModelInfo(credentials)
  const llm = ws.clientId && ws.clientSecret ? (opts) => ws.llm(opts) : null
  // 没配平台凭证时只有本地开发能进（单一用户）；生产环境绝不能退回匿名，否则人人都是同一个创建者
  const devMode = !ws.enabled && process.env.NODE_ENV !== 'production'

  // 健康检查必须免登录。配了数据库但表还没建好时不算正常，平台据此自动回滚
  app.get('/health', (req, res) => {
    if (process.env.DATABASE_URL && !getReady()) return res.status(503).json({ status: 'starting', version: VERSION })
    res.json({ status: 'ok', version: VERSION })
  })

  app.use(ws.middleware({ publicPaths: ['/health', '/mcp', '/static/'] }))
  app.use(express.json({ limit: BODY_LIMIT }))
  app.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }))
  app.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP); next() })

  const userOf = (req) => req.yhUser || (devMode ? DEV_USER : null)
  const ready = () => !!meetings && getReady()
  const requireReady = (req, res, next) => {
    if (!ready()) return next(new HttpError(503, '数据库还没准备好，稍后再试'))
    next()
  }
  const requireUser = (req, res, next) => {
    req.me = userOf(req)
    if (!req.me) return next(new HttpError(503, '应用未接入平台，请联系管理员'))
    next()
  }

  async function loadDetail(me, id) {
    const m = await meetings.get(me.id, id)
    const names = await users.names([m.owner_id, ...m.attendee_ids])
    return detail(m, me, names, todayIn())
  }

  const about = { pool, modelInfo, hosted: ws.enabled }
  app.use('/api', importRouter({ ws, meetings, settings, llm, aiTimeoutMs, importTimeoutMs, requireReady, requireUser, wrap }))
  app.use('/api', apiRouter({ ws, meetings, settings, users, llm, about, aiTimeoutMs, requireReady, requireUser, wrap, loadDetail }))

  if (meetings) app.post('/mcp', requireReady, mcpHandler({ ws, tools: buildTools({ meetings }), devUser: devMode ? DEV_USER : null }))
  else app.post('/mcp', requireReady)
  // 无状态模式不开 SSE
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '只支持 POST' }))

  app.use(pageRouter({ ws, meetings, settings, users, about, ready, userOf, wrap, loadDetail }))

  app.use((req, res) => res.status(404).json({ error: '没有这个地址' }))

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    if (err instanceof PlatformUsersError) return res.status(503).json({ error: err.message })
    if (err.type === 'entity.too.large') return res.status(400).json({ error: '内容太长了' })
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求内容不对' })
    console.error('[meeting]', req.method, req.path, err.message)
    res.status(500).json({ error: '出错了，稍后再试' })
  })

  return app
}
