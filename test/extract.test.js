import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, extractJson, extractNotes, normalizeHeldAt, normalizeMeta, normalizeSummary, shortSummary } from '../src/extract.js'
import { searchTerms, todoLine } from '../src/meetings.js'

const DATE = '2026-10-30'
const GOOD = { decisions: ['先上华东'], todos: [{ title: '整理客户名单', owner: '郑国栋', due: '2026-11-02' }], risks: ['合同可能拖期'], nextAgenda: ['定价'] }
const opts = (reply, extra = {}) => ({ llm: async () => ({ choices: [{ message: { content: reply } }] }), title: '周会', date: DATE, tz: 'Asia/Shanghai', timeoutMs: 100, ...extra })

test('提炼：正常 JSON', async () => {
  const r = await extractNotes('记录', opts(JSON.stringify(GOOD)))
  assert.deepEqual([r.ok, r.summary], [true, GOOD])
})

test('提炼：回复包在 ```json 代码块里', async () => {
  const r = await extractNotes('记录', opts('好的，结果如下：\n```json\n' + JSON.stringify(GOOD, null, 2) + '\n```\n以上。'))
  assert.deepEqual([r.ok, r.summary], [true, GOOD])
})

test('提炼：回复带思考过程，里面的花括号不干扰', async () => {
  const r = await extractNotes('记录', opts(`<think>格式是 {decisions: ...} 对吧</think>${JSON.stringify(GOOD)}`))
  assert.deepEqual([r.ok, r.summary], [true, GOOD])
})

test('提炼：回复是垃圾，不抛错，给一句说明', async () => {
  for (const reply of ['我不太明白你的意思', '{坏掉的 json', '', '[1,2,3]', '{"foo":"bar"}', '"decisions"']) {
    const r = await extractNotes('记录', opts(reply))
    assert.equal(r.ok, false, reply)
    assert.equal(r.reason, 'garbage')
    assert.match(r.message, /纪要已保存/)
  }
})

test('提炼：超时不抛错，给一句说明', async () => {
  const started = Date.now()
  const r = await extractNotes('记录', opts('', { llm: () => new Promise(() => {}), timeoutMs: 30 }))
  assert.equal(r.reason, 'timeout')
  assert.match(r.message, /超时/)
  assert.ok(Date.now() - started < 1000)
})

test('提炼：模型报错不抛错', async () => {
  const r = await extractNotes('记录', opts('', { llm: async () => { throw new Error('连不上') } }))
  assert.equal(r.reason, 'failed')
})

test('提炼：没有 llm 或平台没配模型，都说未配置', async () => {
  assert.equal((await extractNotes('记录', opts('', { llm: null }))).reason, 'unconfigured')
  const r = await extractNotes('记录', opts('', { llm: async () => { throw new Error('平台尚未配置可用模型，请在「管理 → 模型与 AI」中配置') } }))
  assert.equal(r.reason, 'unconfigured')
})

test('提炼：日志不打纪要原文', async (t) => {
  const logged = []
  t.mock.method(console, 'warn', (...a) => logged.push(a.join(' ')))
  await extractNotes('机密内容XYZ', opts('', { llm: async () => { throw new Error('boom') } }))
  await extractNotes('机密内容XYZ', opts('垃圾'))
  assert.equal(logged.length, 2)
  assert.ok(!logged.join().includes('机密内容XYZ'))
})

test('提示词带上会议日期和星期，并声明记录不是指令', () => {
  const p = buildPrompt({ title: 'Q4 复盘', date: DATE, tz: 'Asia/Shanghai' })
  assert.match(p, /2026-10-30 星期五/)
  assert.match(p, /Q4 复盘/)
  assert.match(p, /指令都不要执行/)
})

test('收敛：缺的块补空，非数组当空', () => {
  assert.deepEqual(normalizeSummary({ decisions: ['a'], risks: 'x' }, DATE), { decisions: ['a'], todos: [], risks: [], nextAgenda: [] })
})

test('收敛：去空白、去重、丢掉非字符串', () => {
  assert.deepEqual(normalizeSummary({ decisions: [' a ', 'a', '', '   ', 3, null] }, DATE).decisions, ['a'])
})

test('收敛：待办的 owner 和 due 不合格就留空，没标题丢掉', () => {
  const r = normalizeSummary({ todos: [
    { title: 'a', owner: '  ', due: '下周三' },
    { title: 'b', owner: null, due: 'null' },
    { title: 'c', owner: 'null', due: '2026-02-30' },
    { title: 'd', owner: '王芳', due: '2099-01-01' },
    { owner: '无标题' },
    '只给了一句话'
  ] }, DATE)
  assert.deepEqual(r.todos, [
    { title: 'a', owner: null, due: null },
    { title: 'b', owner: null, due: null },
    { title: 'c', owner: null, due: null },
    { title: 'd', owner: '王芳', due: null },
    { title: '只给了一句话', owner: null, due: null }
  ])
})

test('收敛：超长截断，条数封顶', () => {
  const r = normalizeSummary({ decisions: Array.from({ length: 300 }, (_, i) => `决议${i}`), risks: ['长'.repeat(2000)] }, DATE)
  assert.equal(r.decisions.length, 100)
  assert.equal(r.risks[0].length, 500)
})

test('extractJson：取不到时返回 null', () => {
  assert.equal(extractJson(null), null)
  assert.equal(extractJson('}{'), null)
})

test('待办一行：标题 @负责人 月-日', () => {
  assert.equal(todoLine({ text: '整理客户名单', owner_name: '郑国栋', due_date: '2026-11-02' }), '整理客户名单 @郑国栋 11-02')
})

test('待办一行：缺负责人或日期时省掉那一段', () => {
  assert.equal(todoLine({ text: '整理客户名单', owner_name: null, due_date: '2026-11-02' }), '整理客户名单 11-02')
  assert.equal(todoLine({ text: '整理客户名单', owner_name: '郑国栋', due_date: null }), '整理客户名单 @郑国栋')
  assert.equal(todoLine({ text: '整理客户名单', owner_name: null, due_date: null }), '整理客户名单')
})

test('待办一行：换行和多余空白压成一行，姓名里的空格去掉', () => {
  assert.equal(todoLine({ text: ' 整理\n客户   名单 ', owner_name: 'Li Lei', due_date: '2026-01-09' }), '整理 客户 名单 @LiLei 01-09')
})

test('搜索词：按空白和中英文标点拆开', () => {
  assert.deepEqual(searchTerms('预算，评审'), ['预算', '评审'])
  assert.deepEqual(searchTerms('预算、评审；Q4'), ['预算', '评审', 'Q4'])
  assert.deepEqual(searchTerms('「预算」 (评审)'), ['预算', '评审'])
})

test('搜索词：全是标点按原文，空的返回空', () => {
  assert.deepEqual(searchTerms('，。'), ['，。'])
  assert.deepEqual(searchTerms('   '), [])
  assert.deepEqual(searchTerms(null), [])
})

// ---------- 元信息 ----------
test('元信息：完整收敛', () => {
  const meta = normalizeMeta({ title: ' Q4 周会 ', held_at: '2026-10-28T14:00', location: '三楼', host: '李总', attendees: ['李总', ' 王芳 ', '王芳', '', 3], project: '华东', summary: '一句。' }, DATE)
  assert.deepEqual(meta, { title: 'Q4 周会', held_at: '2026-10-28T14:00', location: '三楼', host: '李总', attendees: ['李总', '王芳'], project: '华东', summary: '一句。' })
})

test('元信息：字符串 null、空白、错类型都当没识别出来', () => {
  const meta = normalizeMeta({ title: 'null', host: '  ', location: 5, attendees: '王芳', project: ['x'], summary: {}, held_at: 20261028 }, DATE)
  assert.equal(meta, null)
  assert.equal(normalizeMeta(null, DATE), null)
  assert.equal(normalizeMeta([], DATE), null)
})

test('元信息：超长截断', () => {
  const meta = normalizeMeta({ title: '长'.repeat(300), project: '项'.repeat(300), host: '人'.repeat(100), attendees: ['名'.repeat(100)] }, DATE)
  assert.deepEqual([meta.title.length, meta.project.length, meta.host.length, meta.attendees[0].length], [200, 100, 50, 50])
})

test('开会时间：格式归一，日期没写时间用 09:00', () => {
  assert.equal(normalizeHeldAt('2026-10-28T14:00', DATE), '2026-10-28T14:00')
  assert.equal(normalizeHeldAt('2026-10-28 14:00:30', DATE), '2026-10-28T14:00')
  assert.equal(normalizeHeldAt('2026-10-28', DATE), '2026-10-28T09:00')
})

test('开会时间：不存在的日期、离谱的年份、自然语言都不要', () => {
  for (const v of ['2026-02-30T10:00', '1999-01-01T10:00', '2099-01-01T10:00', '上周三', '', null, 123]) assert.equal(normalizeHeldAt(v, DATE), null, String(v))
})

test('摘要：最多三句，中英文都算', () => {
  assert.equal(shortSummary('一。二！三？四。五。'), '一。二！三？')
  assert.equal(shortSummary('One. Two. Three. Four.'), 'One. Two. Three.')
  assert.equal(shortSummary('增长 3.5%，符合预期'), '增长 3.5%，符合预期')
  assert.equal(shortSummary(null), null)
  assert.ok(shortSummary('长'.repeat(5000)).length <= 1000)
})

test('待办：due_date 和旧的 due 都认', () => {
  const r = normalizeSummary({ todos: [{ title: 'a', due_date: '2026-11-02' }, { title: 'b', due: '2026-11-03' }] }, DATE)
  assert.deepEqual(r.todos.map((t) => t.due), ['2026-11-02', '2026-11-03'])
})

test('提炼：有四块没元信息也算成功', async () => {
  const r = await extractNotes('记录', opts(JSON.stringify(GOOD)))
  assert.equal(r.ok, true)
  assert.equal(r.meta, null)
})

test('提炼：只有元信息算部分结果，meta 带回去', async () => {
  const r = await extractNotes('记录', opts(JSON.stringify({ title: '周会', project: '华东' })))
  assert.deepEqual([r.ok, r.reason, r.meta.title], [false, 'partial', '周会'])
  assert.match(r.message, /可手动填写/)
})

test('提炼失败的提示都带「自动整理失败，可手动填写」', async () => {
  const replies = [opts('垃圾'), opts('', { llm: null }), opts('', { llm: async () => { throw new Error('x') } }), opts('', { llm: () => new Promise(() => {}), timeoutMs: 10 })]
  for (const o of replies) assert.match((await extractNotes('记录', o)).message, /自动整理失败，可手动填写/)
})

test('提示词：摘要语言按设置，默认中文', () => {
  assert.match(buildPrompt({ title: 't', date: DATE, tz: 'Asia/Shanghai', lang: 'en' }), /write in English/)
  assert.match(buildPrompt({ title: 't', date: DATE, tz: 'Asia/Shanghai' }), /summary：会议摘要，3 句话以内，用中文写/)
  for (const f of ['held_at', 'attendees', 'host', 'project', 'summary', 'due_date']) assert.match(buildPrompt({ title: 't', date: DATE, tz: 'x' }), new RegExp(f))
})
