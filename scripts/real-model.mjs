// 门槛 5：用真实平台模型提炼一段会议记录，打印模型原始回复、收敛后的元信息和四块。凭证只从环境变量读，不打印
//   YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> node scripts/real-model.mjs
import { Workspace } from '../src/yh-one.mjs'
import { extractNotes } from '../src/extract.js'
import { todoLine } from '../src/meetings.js'
import { todayIn, tzName } from '../src/dates.js'

const NOTES = `Q4 华东渠道推进会，李总主持，郑国栋、王芳、陈晨参加。
李总：华东先上，华南放到明年一季度再说，这个就这么定了。返利比例维持 3%，不再往上谈。
郑国栋：客户名单还差苏州那批，我下周一前整理完发群里。
王芳：合同模板法务还没回，最晚周三要拿到，否则十一月第一批签约可能赶不上。我去催。
陈晨：技术这边接口联调人手紧张，只有两个人，可能影响月底上线。
李总：陈晨周五前出一版排期给我。定价策略今天来不及，下次会再聊，顺便看一下竞品调价的影响。`

const missing = ['YH_CLIENT_ID', 'YH_CLIENT_SECRET', 'YH_API_URL'].filter((k) => !process.env[k])
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}`)
  process.exit(2)
}

const ws = new Workspace()
let raw = null
let model = null
const llm = async (opts) => {
  const r = await ws.llm(opts)
  raw = r?.choices?.[0]?.message?.content ?? null
  model = r?.model ?? null
  return r
}
const date = todayIn()
const started = Date.now()
const out = await extractNotes(NOTES, { llm, title: 'Q4 华东渠道推进会', date, tz: tzName(), timeoutMs: 120_000 })
console.log(`会议日期：${date}  模型：${model}  耗时：${Date.now() - started}ms`)
console.log('--- 会议记录\n' + NOTES)
console.log('--- 模型原始回复\n' + raw)
console.log('--- 收敛后的元信息\n' + JSON.stringify(out.meta, null, 2))
console.log('--- 收敛后的四块\n' + JSON.stringify(out.summary ?? out, null, 2))
if (out.ok) console.log('--- 复制成一行\n' + out.summary.todos.map((t) => todoLine({ text: t.title, owner_name: t.owner, due_date: t.due })).join('\n'))
process.exit(out.ok ? 0 : 1)
