// MCP：无状态 Streamable HTTP，只回 JSON。平台调用时每个请求都带 Bearer access_token（代表当前用户）
import { VERSION } from './version.js'
import { rangeLabel, todayIn } from './dates.js'
import { card, summaryOf } from './present.js'

const DAY_MS = 86400_000
const DAYS_DEFAULT = 7
const DAYS_MAX = 90
const LIST_MAX = 50

export function buildTools({ meetings }) {
  return [
    {
      name: 'list_meetings',
      title: '查看会议',
      description: '查用户创建或参与的会议，范围是今天前后 N 天。用户问「最近有什么会」「这周开了哪些会」「明天有会吗」时用。返回会议 id，可以再用 get_meeting_notes 看纪要。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: `往前、往后各看几天，默认 ${DAYS_DEFAULT}，上限 ${DAYS_MAX}` }
        }
      },
      annotations: { readOnlyHint: true },
      run: async (user, args) => {
        const days = Math.min(Math.max(Number.parseInt(args.days, 10) || DAYS_DEFAULT, 1), DAYS_MAX)
        const now = new Date()
        const today = todayIn()
        const rows = await meetings.listBetween(user.id, new Date(now.getTime() - days * DAY_MS), new Date(now.getTime() + days * DAY_MS), LIST_MAX)
        return { days, total: rows.length, list: rows.map((m) => card(m, today, now)) }
      }
    },
    {
      name: 'get_meeting_notes',
      title: '查看会议纪要',
      description: '按会议 id 取纪要的摘要和四块结果：决议、待办、风险、下次议题。用户问「上次会定了什么」「会上给我派了什么活」时，先用 list_meetings 找到 id 再调这个。只能看用户创建或参与的会议。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '会议 id，来自 list_meetings' }
        },
        required: ['id']
      },
      annotations: { readOnlyHint: true },
      run: async (user, args) => {
        const m = await meetings.get(user.id, args.id)
        const rows = await meetings.items(user.id, args.id)
        return { id: m.id, title: m.title, time: rangeLabel(m.starts_at, m.ends_at, todayIn()), project: m.project, summary: m.summary, ...summaryOf(rows) }
      }
    }
  ]
}

export function mcpHandler({ ws, tools, devUser }) {
  return async (req, res) => {
    const { id, method, params } = req.body || {}
    const reply = (result) => res.json({ jsonrpc: '2.0', id, result })
    const fail = (code, message, status = 200) => res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

    // 不允许匿名：initialize / tools/list 也一样，平台每个请求都带 token
    const user = ws.enabled ? await ws.userFromToken(req.headers.authorization) : devUser
    if (!user) return fail(-32001, '未授权：需要平台签发的 access_token', 401)

    if (id === undefined) return res.status(202).end() // 通知（如 notifications/initialized）不用回
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meeting', version: VERSION } })
    }
    if (method === 'ping') return reply({})
    if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) })
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) return fail(-32602, `没有工具 ${params?.name}`)
      try {
        const out = await tool.run(user, params.arguments || {})
        ws.track(user, `mcp.${tool.name}`, { via: 'ai' })
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.status ? e.message : '操作失败，请稍后再试' }], isError: true })
      }
    }
    return fail(-32601, `不支持 ${method}`)
  }
}
