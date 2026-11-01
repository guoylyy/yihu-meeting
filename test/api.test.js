import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { clearTables, startHarness } from './support/harness.js'
import { createApp } from '../src/app.js'
import { Workspace } from '../src/yh-one.mjs'
import { createPool, ensureSchema } from '../src/db.js'
import { toLocal } from '../src/dates.js'
import { NOTE_MAX } from '../src/meetings.js'
import { VERSION } from '../src/version.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const MINUTE = 60_000
const SUMMARY = { decisions: ['先上华东'], todos: [{ title: '整理客户名单', owner: '郑国栋', due: '2026-11-02' }], risks: ['合同可能拖期'], nextAgenda: ['定价'] }

let h, alice, bob, carol

before(async () => {
  h = await startHarness({ aiTimeoutMs: 200 })
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  carol = await h.login(CAROL)
})
after(() => h.close())
beforeEach(async () => {
  await clearTables(h.pool)
  h.platform.state.usersDown = false
  h.platform.state.llm = () => JSON.stringify(SUMMARY)
})

const local = (minutes) => toLocal(new Date(Date.now() + minutes * MINUTE))
const create = async (who, body = {}) => {
  const r = await who.post('/api/meetings', { title: '周会', starts_at: local(60), ...body })
  assert.equal(r.status, 201, r.text)
  return r.json
}
const withNote = async (who, body, content = '记录') => {
  const m = await create(who, body)
  assert.equal((await who.put(`/api/meetings/${m.id}/note`, { content })).status, 200)
  return m
}
const extract = (who, id, content = '记录') => who.post(`/api/meetings/${id}/extract`, { content })
const itemsOf = async (who, id) => (await h.pool.query('SELECT kind, text, owner_name, due_date, source, id FROM meeting_item WHERE meeting_id = ? ORDER BY id', [id]))[0]
const ids = (r) => r.json.groups.flatMap((g) => g.list.map((m) => m.id))
const search = (who, q) => who.get(`/api/meetings?q=${encodeURIComponent(q)}`)

// ---------- 健康检查与页面 ----------
test('/health 免登录，返回规定格式', async () => {
  const r = await fetch(`${h.base}/health`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { status: 'ok', version: '0.2.1' })
})

test('版本号三处一致：清单、package.json、页面', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(pkg.version, VERSION)
  assert.match((await alice.get('/')).text, new RegExp(`id="version">v${VERSION}<`))
})

test('清单 code 是 meeting', async () => {
  assert.equal(JSON.parse(await readFile('yh-app.json', 'utf8')).code, 'meeting')
})

test('页面带规定的 viewport，地址都是相对路径', async () => {
  const m = await create(alice)
  for (const path of ['/', `/meetings/${m.id}`]) {
    const { text } = await alice.get(path)
    assert.ok(text.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'))
    assert.ok(!/(?:href|src)="\/[^/]/.test(text.replace(/<base[^>]*>/, '')), path)
  }
})

test('平台转发时 <base> 带上路径前缀', async () => {
  assert.match((await alice.get('/')).text, /<base href="\/">/)
  assert.match((await alice.get('/', { 'x-forwarded-prefix': '/apps/meeting' })).text, /<base href="\/apps\/meeting\/">/)
})

test('未登录：页面跳平台授权，接口 401', async () => {
  const page = await fetch(`${h.base}/`, { redirect: 'manual' })
  assert.equal(page.status, 302)
  assert.match(page.headers.get('location'), /\/sso\/authorize/)
  assert.equal((await fetch(`${h.base}/api/meetings`)).status, 401)
})

test('生产环境没配凭证：拒绝服务，不退回匿名', async () => {
  const keep = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const pool = createPool(process.env.TEST_DATABASE_URL)
  const server = createApp({ ws: new Workspace({ clientId: ' ', clientSecret: '', appUrl: '' }), pool }).listen(0)
  process.env.NODE_ENV = keep
  await new Promise((r) => server.once('listening', r))
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/meetings`)
  assert.equal(r.status, 503)
  server.closeAllConnections()
  await new Promise((r2) => server.close(r2))
  await pool.end()
})

// ---------- 会议 ----------
test('新建：时间按当地录入，读出来一致', async () => {
  const m = await create(alice, { title: ' 周会 ', starts_at: '2026-11-02T15:00', ends_at: '2026-11-02T16:30', location: '三楼', agenda: '一\n二' })
  assert.equal(m.title, '周会')
  assert.equal(m.starts_at, '2026-11-02T15:00')
  assert.equal(m.ends_at, '2026-11-02T16:30')
  const [[row]] = await h.pool.query('SELECT starts_at FROM meeting WHERE id = ?', [m.id])
  assert.equal(row.starts_at.toISOString(), '2026-11-02T07:00:00.000Z')
})

test('新建：标题必填，开始时间必填', async () => {
  assert.equal((await alice.post('/api/meetings', { title: '  ', starts_at: local(10) })).status, 400)
  const r = await alice.post('/api/meetings', { title: '周会' })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, '开始时间不能为空')
})

test('新建：时间格式错、结束不晚于开始都 400', async () => {
  for (const body of [{ starts_at: '明天' }, { starts_at: '2026-02-30T10:00' }, { starts_at: '2026-11-02T15:00', ends_at: '2026-11-02T15:00' }, { starts_at: '2026-11-02T15:00', ends_at: '2026-11-02T14:00' }, { starts_at: '2026-11-02T15:00', ends_at: 'x' }]) {
    assert.equal((await alice.post('/api/meetings', { title: '周会', ...body })).status, 400, JSON.stringify(body))
  }
})

test('新建：超长字段 400，中文按字数算', async () => {
  assert.equal((await alice.post('/api/meetings', { title: '会'.repeat(201), starts_at: local(1) })).status, 400)
  assert.equal((await alice.post('/api/meetings', { title: '会'.repeat(200), starts_at: local(1) })).status, 201)
})

test('参与人：平台上有的才能加，自己不算，重复去掉', async () => {
  const m = await create(alice, { attendee_ids: [BOB, BOB, ALICE, CAROL] })
  assert.deepEqual(m.attendees.map((a) => a.name), ['李雷', '韩梅梅'])
  assert.equal(m.owner.name, '王小明')
  assert.equal((await alice.post('/api/meetings', { title: '周会', starts_at: local(1), attendee_ids: [999] })).status, 400)
  assert.equal((await alice.post('/api/meetings', { title: '周会', starts_at: local(1), attendee_ids: 'x' })).status, 400)
})

test('参与人：已离职的不能加，选人接口只给最少字段', async () => {
  assert.equal((await alice.post('/api/meetings', { title: '周会', starts_at: local(1), attendee_ids: [14] })).status, 400)
  const { json } = await alice.get('/api/users?q=法务')
  assert.deepEqual(json, { total: 1, list: [{ id: BOB, name: '李雷', dept: '法务部' }] })
})

test('平台连不上：原有参与人不受影响，加新人给人话', async () => {
  // 新实例：名单缓存是空的，才真的会碰到平台
  const h2 = await startHarness({ keepData: true })
  const owner = await h2.login(ALICE)
  const m = await create(alice, { attendee_ids: [BOB] })
  h2.platform.state.usersDown = true
  const body = { title: '改了', starts_at: local(5) }
  assert.equal((await owner.post('/api/meetings', { ...body, attendee_ids: [] })).status, 201)
  assert.equal((await owner.patch(`/api/meetings/${m.id}`, { ...body, attendee_ids: [BOB] })).status, 200)
  const r = await owner.patch(`/api/meetings/${m.id}`, { ...body, attendee_ids: [BOB, CAROL] })
  assert.equal(r.status, 503)
  assert.equal(r.json.error, '平台暂时连不上，稍后再试')
  const page = await owner.get(`/meetings/${m.id}`) // 姓名退回「用户 12」，页面照开
  assert.equal(page.status, 200)
  assert.match(page.text, /用户 12/)
  await h2.close()
})

test('编辑：创建者能改，参与人 403', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  const body = { title: '新标题', starts_at: local(120), attendee_ids: [CAROL], location: '线上' }
  assert.equal((await bob.patch(`/api/meetings/${m.id}`, body)).status, 403)
  const r = await alice.patch(`/api/meetings/${m.id}`, body)
  assert.equal(r.status, 200)
  assert.equal(r.json.title, '新标题')
  assert.deepEqual(r.json.attendees.map((a) => a.id), [CAROL])
  assert.equal((await bob.get(`/api/meetings/${m.id}`)).status, 404) // 被移出后看不到了
  assert.equal((await carol.get(`/api/meetings/${m.id}`)).status, 200)
})

test('编辑：只传部分字段时其余不动，尤其是参与人', async () => {
  const m = await create(alice, { starts_at: '2026-11-02T15:00', ends_at: '2026-11-02T16:00', location: '三楼', agenda: '议程', attendee_ids: [BOB] })
  const r = await alice.patch(`/api/meetings/${m.id}`, { title: '只改标题' })
  assert.equal(r.status, 200)
  assert.equal(r.json.title, '只改标题')
  assert.deepEqual([r.json.starts_at, r.json.ends_at, r.json.location, r.json.agenda], ['2026-11-02T15:00', '2026-11-02T16:00', '三楼', '议程'])
  assert.deepEqual(r.json.attendees.map((a) => a.id), [BOB])
})

test('编辑：显式清空可选字段，开始时间挪到结束之后 400', async () => {
  const m = await create(alice, { starts_at: '2026-11-02T15:00', ends_at: '2026-11-02T16:00', location: '三楼', attendee_ids: [BOB] })
  assert.equal((await alice.patch(`/api/meetings/${m.id}`, { starts_at: '2026-11-02T17:00' })).status, 400)
  const r = await alice.patch(`/api/meetings/${m.id}`, { ends_at: null, location: '', attendee_ids: [] })
  assert.deepEqual([r.json.ends_at, r.json.location, r.json.attendees], ['', '', []])
})

test('删除：纪要和条目一并删掉', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  assert.equal((await alice.del(`/api/meetings/${m.id}`)).status, 204)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).status, 404)
  for (const table of ['meeting_note', 'meeting_item', 'meeting_attendee']) {
    const [[{ n }]] = await h.pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE meeting_id = ?`, [m.id])
    assert.equal(n, 0, table)
  }
})

test('详情页：删除确认文案写明纪要一并删除', async () => {
  const js = await readFile('src/public/detail.js', 'utf8')
  assert.match(js, /纪要一并删除/)
})

// ---------- 权限 ----------
test('权限：非参与人看详情 404（接口和页面）', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  assert.equal((await carol.get(`/api/meetings/${m.id}`)).status, 404)
  const page = await carol.get(`/meetings/${m.id}`)
  assert.equal(page.status, 404)
  assert.ok(!page.text.includes('周会'))
})

test('权限：非创建者改纪要 403', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] }, '原文')
  const r = await bob.put(`/api/meetings/${m.id}/note`, { content: '改掉' })
  assert.equal(r.status, 403)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '原文')
})

test('权限：参与人不能提炼、不能增删条目、不能删会议', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  const [item] = await itemsOf(alice, m.id)
  assert.equal((await extract(bob, m.id)).status, 403)
  assert.equal((await bob.post(`/api/meetings/${m.id}/items`, { kind: 'risk', text: 'x' })).status, 403)
  assert.equal((await bob.del(`/api/meetings/${m.id}/items/${item.id}`)).status, 403)
  assert.equal((await bob.del(`/api/meetings/${m.id}`)).status, 403)
  assert.equal((await itemsOf(alice, m.id)).length, 4)
})

test('权限：非参与人的所有写操作都是 404，不暴露存在', async () => {
  const m = await create(alice)
  const url = `/api/meetings/${m.id}`
  for (const r of [await carol.patch(url, { title: 'x', starts_at: local(1) }), await carol.del(url), await carol.put(`${url}/note`, { content: 'x' }), await extract(carol, m.id), await carol.post(`${url}/items`, { kind: 'risk', text: 'x' }), await carol.get(`${url}/blocks.html`)]) {
    assert.equal(r.status, 404)
  }
})

test('权限：改 PATCH 时不能靠报错探测平台用户', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  assert.equal((await bob.patch(`/api/meetings/${m.id}`, { title: 'x', starts_at: local(1), attendee_ids: [999] })).status, 403)
  assert.equal((await carol.patch(`/api/meetings/${m.id}`, { title: 'x', starts_at: local(1), attendee_ids: [999] })).status, 404)
})

test('权限：参与人能看，页面只读', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id, '会议原文')
  const { text, status } = await bob.get(`/meetings/${m.id}`)
  assert.equal(status, 200)
  assert.match(text, /会议原文/)
  assert.match(text, /先上华东/)
  assert.ok(!text.includes('id="note"'))
  assert.ok(!text.includes('id="extract-btn"'))
  assert.ok(!text.includes('data-del'))
  assert.ok(text.includes('data-copy')) // 待办的复制谁都能用
})

test('权限：畸形 id 一律 404', async () => {
  for (const id of ['abc', '0', '-1', '1;DROP', '99999999999999999999']) {
    assert.equal((await alice.get(`/api/meetings/${encodeURIComponent(id)}`)).status, 404, id)
    assert.equal((await alice.get(`/meetings/${encodeURIComponent(id)}`)).status, 404, id)
  }
})

test('权限：条目 id 属于别的会议时 404', async () => {
  const a = await withNote(alice)
  const b = await withNote(alice)
  await extract(alice, a.id)
  const [item] = await itemsOf(alice, a.id)
  assert.equal((await alice.del(`/api/meetings/${b.id}/items/${item.id}`)).status, 404)
})

// ---------- 纪要 ----------
test('纪要：保存后读回，一场会只有一份', async () => {
  const m = await create(alice)
  await alice.put(`/api/meetings/${m.id}/note`, { content: '第一版' })
  const r = await alice.put(`/api/meetings/${m.id}/note`, { content: '第二版 😀' })
  assert.ok(r.json.saved_at)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '第二版 😀')
  const [[{ n }]] = await h.pool.query('SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?', [m.id])
  assert.equal(n, 1)
})

test('纪要：缺 content 400，不会把已有内容清空', async () => {
  const m = await withNote(alice, {}, '原文')
  assert.equal((await alice.put(`/api/meetings/${m.id}/note`, {})).status, 400)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '原文')
})

test('纪要：上限内能存，超长 400 给人话', async () => {
  const m = await create(alice)
  assert.equal((await alice.put(`/api/meetings/${m.id}/note`, { content: '字'.repeat(NOTE_MAX) })).status, 200)
  const r = await alice.put(`/api/meetings/${m.id}/note`, { content: '字'.repeat(NOTE_MAX + 1) })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /不能超过/)
})

test('纪要：内容转义，不会变成脚本', async () => {
  const m = await withNote(alice, { title: '<img src=x onerror=alert(1)>' }, '<script>alert(1)</script>')
  const { text } = await alice.get(`/meetings/${m.id}`)
  assert.ok(!text.includes('<script>alert(1)'))
  assert.ok(!text.includes('<img src=x'))
  assert.ok((await alice.get('/')).headers.get('content-security-policy').includes("default-src 'self'"))
})

// ---------- AI 提炼 ----------
test('提炼：结果落成四块，来源是 ai', async () => {
  const m = await create(alice)
  const r = await extract(alice, m.id, '会议记录')
  assert.deepEqual({ ok: r.json.ok, count: r.json.count, message: r.json.message }, { ok: true, count: 4, message: '' })
  const rows = await itemsOf(alice, m.id)
  assert.deepEqual(rows.map((i) => i.kind), ['decision', 'todo', 'risk', 'agenda'])
  assert.deepEqual([rows[1].text, rows[1].owner_name, rows[1].due_date], ['整理客户名单', '郑国栋', '2026-11-02'])
  assert.ok(rows.every((i) => i.source === 'ai'))
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '会议记录')
})

test('提炼：模型收到会议标题、日期和纪要原文', async () => {
  let seen
  h.platform.state.llm = (body) => { seen = body; return JSON.stringify(SUMMARY) }
  const m = await create(alice, { title: 'Q4 复盘', starts_at: '2026-11-02T15:00' })
  await extract(alice, m.id, '这是原文')
  assert.match(seen.messages[0].content, /Q4 复盘/)
  assert.match(seen.messages[0].content, /2026-11-02 星期一/)
  assert.equal(seen.messages[1].content, '这是原文')
})

test('提炼：返回带 ```json 代码块也能入库', async () => {
  h.platform.state.llm = () => '```json\n' + JSON.stringify(SUMMARY) + '\n```'
  const m = await create(alice)
  assert.equal((await extract(alice, m.id)).json.count, 4)
})

test('提炼：返回垃圾时纪要照存，四块留空，200 加一句说明', async () => {
  h.platform.state.llm = () => '抱歉，我无法处理'
  const m = await create(alice)
  const r = await extract(alice, m.id, '原文要保住')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.match(r.json.message, /纪要已保存/)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '原文要保住')
  assert.equal((await itemsOf(alice, m.id)).length, 0)
})

test('提炼：超时时纪要照存，四块留空，200 加一句说明', async () => {
  h.platform.state.llm = () => new Promise(() => {})
  const m = await create(alice)
  const r = await extract(alice, m.id, '原文要保住')
  assert.equal(r.status, 200)
  assert.equal(r.json.reason, 'timeout')
  assert.match(r.json.message, /超时/)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '原文要保住')
})

test('提炼：模型报错时纪要照存', async () => {
  h.platform.state.llm = () => undefined
  const m = await create(alice)
  const r = await extract(alice, m.id, '原文')
  assert.equal(r.status, 200)
  assert.equal(r.json.reason, 'failed')
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '原文')
})

test('提炼：无 AI 时纪要仍能保存，提炼给一句说明', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
  const server = createApp({ ws: new Workspace({ clientId: ' ', clientSecret: '', appUrl: '' }), pool }).listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const created = await (await send('POST', '/api/meetings', { title: '没有 AI', starts_at: local(10) })).json()
  assert.equal((await send('PUT', `/api/meetings/${created.id}/note`, { content: '手写纪要' })).status, 200)
  const r = await send('POST', `/api/meetings/${created.id}/extract`, { content: '手写纪要' })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.reason, 'unconfigured')
  assert.match(body.message, /还没配置模型/)
  const [[note]] = await pool.query('SELECT content FROM meeting_note WHERE meeting_id = ?', [created.id])
  assert.equal(note.content, '手写纪要')
  server.closeAllConnections()
  await new Promise((r2) => server.close(r2))
  await pool.end()
})

test('提炼：失败时不动已有的四块', async () => {
  const m = await create(alice)
  await extract(alice, m.id)
  h.platform.state.llm = () => '垃圾'
  assert.equal((await extract(alice, m.id, '新原文')).json.ok, false)
  assert.equal((await itemsOf(alice, m.id)).length, 4)
  assert.equal((await alice.get(`/api/meetings/${m.id}`)).json.note, '新原文')
})

test('提炼：成功时整批替换，手动补的也替换', async () => {
  const m = await create(alice)
  await alice.post(`/api/meetings/${m.id}/items`, { kind: 'risk', text: '手动' })
  await extract(alice, m.id)
  assert.ok(!(await itemsOf(alice, m.id)).some((i) => i.text === '手动'))
})

test('提炼：空纪要 400，也没有调模型', async () => {
  let called = false
  h.platform.state.llm = () => { called = true; return '{}' }
  const m = await create(alice)
  assert.equal((await extract(alice, m.id, '   ')).status, 400)
  assert.equal(called, false)
})

test('提炼：模型说四块都没有，给一句说明', async () => {
  h.platform.state.llm = () => JSON.stringify({ decisions: [], todos: [], risks: [], nextAgenda: [] })
  const m = await create(alice)
  const r = await extract(alice, m.id)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.message, '这次没提炼出内容，可以手动补')
})

test('上报：提炼和保存的 detail 里没有原文', async () => {
  h.platform.state.events.length = 0
  const m = await create(alice)
  await extract(alice, m.id, '机密原文XYZ')
  await alice.put(`/api/meetings/${m.id}/note`, { content: '机密原文XYZ' })
  await h.ws.flush()
  const events = h.platform.state.events
  assert.ok(events.some((e) => e.action === 'note.extract'))
  assert.ok(events.some((e) => e.action === 'note.save'))
  assert.ok(!JSON.stringify(events).includes('机密原文XYZ'))
})

// ---------- 四块 ----------
test('条目：手动补一条，待办带负责人和日期', async () => {
  const m = await create(alice)
  const r = await alice.post(`/api/meetings/${m.id}/items`, { kind: 'todo', text: '发报价', owner: '王芳', due: '2026-11-06' })
  assert.equal(r.status, 201)
  const [item] = await itemsOf(alice, m.id)
  assert.deepEqual([item.text, item.owner_name, item.due_date, item.source], ['发报价', '王芳', '2026-11-06', 'manual'])
})

test('条目：非待办忽略负责人和日期，错的块、空内容、错日期都 400', async () => {
  const m = await create(alice)
  await alice.post(`/api/meetings/${m.id}/items`, { kind: 'risk', text: '风险', owner: '王芳', due: '2026-11-06' })
  const [item] = await itemsOf(alice, m.id)
  assert.equal(item.owner_name, null)
  assert.equal(item.due_date, null)
  for (const body of [{ kind: 'x', text: 'a' }, { kind: 'risk', text: ' ' }, { kind: 'todo', text: 'a', due: '下周' }, { kind: 'risk', text: '长'.repeat(501) }]) {
    assert.equal((await alice.post(`/api/meetings/${m.id}/items`, body)).status, 400, JSON.stringify(body))
  }
})

test('条目：单条删除，其他不动', async () => {
  const m = await withNote(alice)
  await extract(alice, m.id)
  const [first] = await itemsOf(alice, m.id)
  assert.equal((await alice.del(`/api/meetings/${m.id}/items/${first.id}`)).status, 204)
  assert.equal((await itemsOf(alice, m.id)).length, 3)
  assert.equal((await alice.del(`/api/meetings/${m.id}/items/${first.id}`)).status, 404)
})

test('条目：页面里待办的 ⋯ 按钮带一行文本，不再放收件箱说明', async () => {
  const m = await withNote(alice)
  await extract(alice, m.id)
  const { text } = await alice.get(`/api/meetings/${m.id}/blocks.html`)
  assert.ok(text.includes('data-line="整理客户名单 @郑国栋 11-02"'))
  assert.ok(!text.includes('收件箱'))
  assert.equal((text.match(/data-line=/g) || []).length, 1) // 只有待办有复制
})

test('条目：创建者的待办只露指派和 ⋯，复制、删除收进菜单；其他三块还是 ×', async () => {
  const m = await withNote(alice)
  await extract(alice, m.id)
  const { text } = await alice.get(`/api/meetings/${m.id}/blocks.html`)
  const todo = text.slice(text.indexOf('data-kind="todo"'), text.indexOf('data-kind="risk"'))
  assert.equal((todo.match(/data-more/g) || []).length, 1)
  for (const absent of ['data-copy', 'data-del']) assert.ok(!todo.includes(absent), absent)
  assert.ok(text.slice(0, text.indexOf('data-kind="todo"')).includes('data-del'))
  const page = (await alice.get(`/meetings/${m.id}`)).text
  for (const part of ['id="item-menu"', 'id="item-copy"', 'id="item-del"']) assert.ok(page.includes(part), part)
})

test('条目：参与人没有菜单，只有一个动作就直接放复制', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  const { text } = await bob.get(`/meetings/${m.id}`)
  assert.ok(text.includes('data-copy="整理客户名单 @郑国栋 11-02"'))
  for (const absent of ['data-more', 'id="item-menu"']) assert.ok(!text.includes(absent), absent)
})

test('条目：表单默认收起，标题带条数，每块一个添加按钮', async () => {
  const m = await withNote(alice)
  await extract(alice, m.id)
  const { text } = await alice.get(`/api/meetings/${m.id}/blocks.html`)
  assert.match(text, />决议 · 1</)
  assert.match(text, />待办 · 1</)
  assert.equal((text.match(/<form class="add"[^>]* hidden>/g) || []).length, 4)
  assert.equal((text.match(/<form /g) || []).length, 4)
  assert.equal((text.match(/data-toggle aria-expanded="false"/g) || []).length, 4)
})

test('条目：待办表单保留标题、负责人、日期三栏', async () => {
  const m = await create(alice)
  const { text } = await alice.get(`/api/meetings/${m.id}/blocks.html`)
  const todo = text.slice(text.indexOf('id="add-todo"'), text.indexOf('</form>', text.indexOf('id="add-todo"')))
  for (const name of ['name="text"', 'name="owner"', 'name="due"']) assert.ok(todo.includes(name), name)
})

test('条目：空的块只有标题和添加，待办没条目时不显示收件箱说明', async () => {
  const m = await create(alice)
  const { text } = await alice.get(`/api/meetings/${m.id}/blocks.html`)
  assert.equal((text.match(/>\s*(决议|待办|风险|下次议题)\s*<\/h2>/g) || []).length, 4) // 没有条数
  assert.ok(!text.includes('note-line'))
  assert.ok(!text.includes('<ul'))
  assert.equal((text.match(/data-toggle/g) || []).length, 4)
})

test('条目：参与人看到标题和条目，没有添加入口，空的块不写暂无', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  await alice.post(`/api/meetings/${m.id}/items`, { kind: 'risk', text: '风险' })
  const { text } = await bob.get(`/api/meetings/${m.id}/blocks.html`)
  assert.match(text, />风险 · 1</)
  for (const absent of ['data-toggle', '<form', 'data-del', '暂无']) assert.ok(!text.includes(absent), absent)
})

test('详情页：提炼按钮在纪要标题行，参与人没有', async () => {
  const m = await create(alice, { attendee_ids: [BOB] })
  const head = (html) => html.slice(html.indexOf('class="note-head"'), html.indexOf('</div>', html.indexOf('class="note-head"')))
  assert.ok(head((await alice.get(`/meetings/${m.id}`)).text).includes('id="extract-btn"'))
  assert.ok(!(await bob.get(`/meetings/${m.id}`)).text.includes('id="extract-btn"'))
})

test('详情页：有纪要时默认只读，输入框收起，点编辑才出来', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  const { text } = await alice.get(`/meetings/${m.id}`)
  assert.match(text, /<textarea[^>]*id="note"[^>]*\shidden>/)
  assert.match(text, /id="note-edit"/)
  assert.match(text, /<div class="plain note-view" id="note-text" tabindex="0">/)
  assert.ok(!(await bob.get(`/meetings/${m.id}`)).text.includes('id="note-edit"'))
})

test('详情页：还没纪要时直接是输入框，不用先点编辑', async () => {
  const m = await create(alice)
  const { text } = await alice.get(`/meetings/${m.id}`)
  assert.ok(!/<textarea[^>]*id="note"[^>]*\shidden>/.test(text))
  assert.match(text, /id="note-text" tabindex="0" hidden>/)
})

// ---------- 列表 ----------
test('近期：即将开始和最近结束分组，各 5 条，顺序对', async () => {
  for (let i = 1; i <= 7; i++) await create(alice, { title: `将来${i}`, starts_at: local(i * 120) })
  for (let i = 1; i <= 7; i++) await create(alice, { title: `过去${i}`, starts_at: local(-i * 200) })
  const { json } = await alice.get('/api/meetings?view=recent')
  const [up, ended] = json.groups
  assert.deepEqual(up.list.map((m) => m.title), ['将来1', '将来2', '将来3', '将来4', '将来5'])
  assert.deepEqual(ended.list.map((m) => m.title), ['过去1', '过去2', '过去3', '过去4', '过去5'])
})

test('近期：进行中的算在即将开始里，判断和详情一致', async () => {
  await create(alice, { title: '进行中', starts_at: local(-10), ends_at: local(50) })
  await create(alice, { title: '没写结束时间', starts_at: local(-30) })
  await create(alice, { title: '刚过默认时长', starts_at: local(-61) })
  const { json } = await alice.get('/api/meetings?view=recent')
  const [up, ended] = json.groups
  assert.deepEqual(up.list.map((m) => [m.title, m.status_label]), [['没写结束时间', '进行中'], ['进行中', '进行中']])
  assert.deepEqual(ended.list.map((m) => [m.title, m.status_label]), [['刚过默认时长', '已结束']])
})

test('全部：显示全部，开始时间倒序', async () => {
  for (let i = 1; i <= 12; i++) await create(alice, { title: `会${i}`, starts_at: local(i * 60) })
  const { json } = await alice.get('/api/meetings?view=all')
  assert.equal(json.groups[0].list.length, 12)
  assert.equal(json.groups[0].list[0].title, '会12')
})

test('列表：每条有相对时间、人数、纪要标记', async () => {
  const a = await withNote(alice, { title: '有纪要', attendee_ids: [BOB, CAROL], starts_at: local(-90) }, '内容')
  await create(alice, { title: '没纪要', starts_at: local(10) })
  const list = (await alice.get('/api/meetings?view=all')).json.groups[0].list
  const row = list.find((m) => m.id === a.id)
  assert.equal(row.people, 3)
  assert.equal(row.has_note, true)
  assert.match(row.when, /^(今天|昨天) \d\d:\d\d$/)
  assert.equal(list.find((m) => m.id !== a.id).has_note, false)
})

test('列表：清空的纪要不算有纪要，只有条目也算有', async () => {
  const a = await withNote(alice, {}, '内容')
  await alice.put(`/api/meetings/${a.id}/note`, { content: '' })
  const b = await create(alice)
  await alice.post(`/api/meetings/${b.id}/items`, { kind: 'risk', text: 'x' })
  const list = (await alice.get('/api/meetings?view=all')).json.groups[0].list
  assert.equal(list.find((m) => m.id === a.id).has_note, false)
  assert.equal(list.find((m) => m.id === b.id).has_note, true)
})

test('列表：只有创建者和参与人看得到', async () => {
  const a = await create(alice, { attendee_ids: [BOB] })
  assert.deepEqual(ids(await bob.get('/api/meetings?view=all')), [a.id])
  assert.deepEqual(ids(await carol.get('/api/meetings?view=all')), [])
  assert.deepEqual(ids(await carol.get('/api/meetings?view=recent')), [])
  assert.ok(!(await carol.get('/')).text.includes('周会'))
})

// ---------- 搜索 ----------
test('搜索：标题命中', async () => {
  const a = await create(alice, { title: '华东区预算评审' })
  await create(alice, { title: '别的会' })
  assert.deepEqual(ids(await search(alice, '预算')), [a.id])
})

test('搜索：正文命中', async () => {
  const a = await withNote(alice, { title: '周会' }, '讨论了返利对账')
  await withNote(alice, { title: '周会2' }, '别的内容')
  assert.deepEqual(ids(await search(alice, '返利')), [a.id])
})

test('搜索：中文标点不影响命中', async () => {
  const a = await withNote(alice, { title: '周会' }, '第一，预算；第二、评审。')
  assert.deepEqual(ids(await search(alice, '预算，评审')), [a.id])
  assert.deepEqual(ids(await search(alice, '「预算」')), [a.id])
  assert.deepEqual(ids(await search(alice, '预算, 评审')), [a.id])
  assert.deepEqual(ids(await search(alice, '预算，没有的词')), [])
})

test('搜索：词可以分别落在标题和正文', async () => {
  const a = await withNote(alice, { title: 'Q4 复盘' }, '预算超了')
  assert.deepEqual(ids(await search(alice, 'Q4，预算')), [a.id])
})

test('搜索：通配符和引号按字面，不注入', async () => {
  const a = await withNote(alice, { title: '100%达成' }, '记录')
  await withNote(alice, { title: '普通会议' }, '记录')
  assert.deepEqual(ids(await search(alice, '%')), [a.id])
  assert.deepEqual(ids(await search(alice, '_')), [])
  assert.deepEqual(ids(await search(alice, "' OR 1=1 -- ")), [])
  assert.equal((await search(alice, '\\')).status, 200)
})

test('搜索：看不到的会议搜不出来', async () => {
  await withNote(alice, { title: '机密会议' }, '机密内容')
  assert.deepEqual(ids(await search(carol, '机密')), [])
})

test('搜索：列表片段带上搜索词，空结果有说明', async () => {
  await create(alice, { title: '周会' })
  const hit = await alice.get('/api/list.html?view=recent&q=' + encodeURIComponent('周会'))
  assert.match(hit.text, /周会/)
  const miss = await alice.get('/api/list.html?q=' + encodeURIComponent('不存在'))
  assert.match(miss.text, /没有找到相关会议/)
})

// ---------- 项目归类 ----------
const listProject = (who, project, view = 'all') => who.get(`/api/meetings?view=${view}&project=${encodeURIComponent(project)}`)

test('项目：新建、编辑都能写，详情读得到', async () => {
  const m = await create(alice, { project: ' 华东渠道 ' })
  assert.equal(m.project, '华东渠道')
  assert.equal((await alice.patch(`/api/meetings/${m.id}`, { project: '华南' })).json.project, '华南')
  assert.equal((await alice.patch(`/api/meetings/${m.id}`, { title: '只改标题' })).json.project, '华南')
  assert.equal((await alice.patch(`/api/meetings/${m.id}`, { project: '' })).json.project, '')
  assert.equal((await alice.post('/api/meetings', { title: 'x', starts_at: local(1), project: '项'.repeat(101) })).status, 400)
})

test('项目过滤：全部、近期、搜索都按项目收窄', async () => {
  const a = await withNote(alice, { title: '华东周会', project: '华东', starts_at: local(-200) }, '预算')
  const b = await withNote(alice, { title: '华南周会', project: '华南', starts_at: local(-300) }, '预算')
  assert.deepEqual(ids(await listProject(alice, '华东')), [a.id])
  assert.deepEqual(ids(await listProject(alice, '华南', 'recent')), [b.id])
  assert.deepEqual(ids(await alice.get(`/api/meetings?q=${encodeURIComponent('预算')}&project=${encodeURIComponent('华东')}`)), [a.id])
  assert.deepEqual(new Set(ids(await listProject(alice, ''))), new Set([a.id, b.id]))
})

test('项目过滤：大小写不敏感，没有的项目给空列表和说明', async () => {
  const a = await create(alice, { project: 'Acme' })
  assert.deepEqual(ids(await listProject(alice, 'acme')), [a.id])
  assert.deepEqual(ids(await listProject(alice, '没有的项目')), [])
  assert.match((await alice.get(`/api/list.html?project=${encodeURIComponent('没有的项目')}`)).text, /没有找到相关会议/)
})

test('项目过滤：不越权，看不到别人的会', async () => {
  await create(alice, { project: '机密项目' })
  assert.deepEqual(ids(await listProject(carol, '机密项目')), [])
  assert.deepEqual((await carol.get('/api/projects')).json.list, [])
  assert.ok(!(await carol.get('/')).text.includes('机密项目'))
})

test('项目联想：去重计数，最近开过的排前面', async () => {
  await create(alice, { project: '老项目', starts_at: local(-5000) })
  await create(alice, { project: '新项目', starts_at: local(10) })
  await create(alice, { project: '新项目', starts_at: local(20) })
  await create(alice, { title: '没项目' })
  assert.deepEqual((await alice.get('/api/projects')).json.list, [{ name: '新项目', count: 2 }, { name: '老项目', count: 1 }])
})

test('列表页：项目下拉含全部，选中项回显，联想在表单里', async () => {
  await create(alice, { project: '华东' })
  const { text } = await alice.get(`/?view=all&project=${encodeURIComponent('华东')}`)
  assert.match(text, /<option value="">全部项目<\/option>/)
  assert.match(text, /<option value="华东" selected>华东<\/option>/)
  assert.match(text, /<datalist id="project-names">[\s\S]*value="华东"/)
})

test('列表行：次行带上项目', async () => {
  await create(alice, { project: '华东' })
  assert.match((await alice.get('/api/list.html?view=all')).text, /class="project">华东</)
})

test('右栏：本月会议数、待办数、项目数只算本月且只算看得到的', async () => {
  const m = await withNote(alice, { project: '华东', starts_at: local(-1) })
  await extract(alice, m.id)
  await create(alice, { project: '华南', starts_at: local(-1) })
  await create(alice, { project: '老项目', starts_at: local(-60 * 24 * 65) })
  await create(bob, { project: '别人的', starts_at: local(-1) })
  const { text } = await alice.get('/')
  assert.match(text, /id="stat-meetings">2</)
  assert.match(text, /id="stat-todos">1</)
  assert.match(text, /id="stat-projects">2</)
})

// ---------- 待办指派 ----------
const todoOf = async (m) => (await itemsOf(alice, m.id)).find((i) => i.kind === 'todo')

test('指派：改负责人和截止日，部分字段不动', async () => {
  const m = await withNote(alice)
  await extract(alice, m.id)
  const todo = await todoOf(m)
  const r = await alice.patch(`/api/meetings/${m.id}/items/${todo.id}`, { owner: ' 陈晨 ', due: '2026-12-01' })
  assert.equal(r.status, 200)
  assert.deepEqual([r.json.owner_name, r.json.due_date], ['陈晨', '2026-12-01'])
  await alice.patch(`/api/meetings/${m.id}/items/${todo.id}`, { owner: '王芳' })
  const after = await todoOf(m)
  assert.deepEqual([after.owner_name, after.due_date], ['王芳', '2026-12-01'])
  await alice.patch(`/api/meetings/${m.id}/items/${todo.id}`, { due: null })
  assert.equal((await todoOf(m)).due_date, null)
})

test('指派：参与人 403，外人 404，错日期 400，非待办 400', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  const items = await itemsOf(alice, m.id)
  const todo = items.find((i) => i.kind === 'todo')
  const url = `/api/meetings/${m.id}/items/${todo.id}`
  assert.equal((await bob.patch(url, { owner: 'x' })).status, 403)
  assert.equal((await carol.patch(url, { owner: 'x' })).status, 404)
  assert.equal((await alice.patch(url, { due: '下周' })).status, 400)
  assert.equal((await alice.patch(`/api/meetings/${m.id}/items/${items[0].id}`, { owner: 'x' })).status, 400)
  assert.equal((await alice.patch(`/api/meetings/${m.id}/items/999999`, { owner: 'x' })).status, 404)
})

test('指派：只有创建者的页面有指派按钮', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  assert.match((await alice.get(`/meetings/${m.id}`)).text, /data-assign/)
  assert.ok(!(await bob.get(`/meetings/${m.id}`)).text.includes('data-assign'))
})

// ---------- 设置 ----------
test('设置：默认值、部分更新、读回', async () => {
  assert.deepEqual((await alice.get('/api/settings')).json, { default_attendee_ids: [], summary_lang: 'zh', todo_due_days: 0 })
  assert.equal((await alice.put('/api/settings', { summary_lang: 'en' })).status, 200)
  await alice.put('/api/settings', { todo_due_days: 3 })
  await alice.put('/api/settings', { default_attendee_ids: [BOB, BOB, ALICE] })
  assert.deepEqual((await alice.get('/api/settings')).json, { default_attendee_ids: [BOB], summary_lang: 'en', todo_due_days: 3 })
})

test('设置：每人一份，互不影响', async () => {
  await alice.put('/api/settings', { summary_lang: 'en' })
  assert.equal((await bob.get('/api/settings')).json.summary_lang, 'zh')
})

test('设置：非法值 400，不改原值', async () => {
  await alice.put('/api/settings', { todo_due_days: 7 })
  for (const body of [{ summary_lang: 'fr' }, { todo_due_days: -1 }, { todo_due_days: 366 }, { todo_due_days: 1.5 }, { todo_due_days: 'x' }, { default_attendee_ids: 'x' }, { default_attendee_ids: [999] }]) {
    assert.equal((await alice.put('/api/settings', body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await alice.get('/api/settings')).json.todo_due_days, 7)
})

test('设置：默认截止天数对手动补的待办即时生效，写了日期的不动', async () => {
  const m = await create(alice)
  await alice.put('/api/settings', { todo_due_days: 5 })
  const auto = await alice.post(`/api/meetings/${m.id}/items`, { kind: 'todo', text: '没写日期' })
  assert.match(auto.json.due_date, /^\d{4}-\d{2}-\d{2}$/)
  const manual = await alice.post(`/api/meetings/${m.id}/items`, { kind: 'todo', text: '写了日期', due: '2026-12-31' })
  assert.equal(manual.json.due_date, '2026-12-31')
})

test('设置：默认参与人带进新建表单', async () => {
  await alice.put('/api/settings', { default_attendee_ids: [BOB] })
  assert.match((await alice.get('/')).text, /data-defaults="\[{&#34;id&#34;:12,&#34;name&#34;:&#34;李雷&#34;}\]"/)
})

test('设置页：平台托管时模型只读并说明', async () => {
  const { status, text } = await alice.get('/settings')
  assert.equal(status, 200)
  assert.match(text, /id="s-model">通义千问 Max</)
  assert.match(text, /由平台统一配置/)
  for (const id of ['f-people', 's-lang', 's-days', 'picker']) assert.ok(text.includes(`id="${id}"`), id)
})

test('设置页：平台拿不到模型时写未配置', async () => {
  const h2 = await startHarness({ keepData: true })
  h2.platform.state.models = null
  const owner = await h2.login(ALICE)
  assert.match((await owner.get('/settings')).text, /id="s-model">未配置</)
  await h2.close()
})

// ---------- 关于 ----------
test('关于：所有字段齐全，不漏账号密码', async () => {
  const { json } = await alice.get('/api/about')
  assert.equal(json.version, VERSION)
  assert.equal(json.mode, '平台')
  assert.equal(json.model, '通义千问 Max')
  assert.match(json.database, /^MySQL \d+\.\d+/)
  assert.equal(json.node, process.version)
  assert.equal(json.dependencies, 5)
  assert.ok(json.build_time)
  assert.ok(!JSON.stringify(json).includes('@127.0.0.1'))
})

test('关于页：八项都显示', async () => {
  const { status, text } = await alice.get('/about')
  assert.equal(status, 200)
  for (const label of ['版本号', '构建时间', '运行模式', '数据目录', '数据库版本', 'AI 模型', 'Node 版本', '依赖数']) assert.ok(text.includes(`<dt>${label}</dt>`), label)
})

test('关于：模型拿不到写未配置，不影响页面', async () => {
  const h2 = await startHarness({ keepData: true })
  h2.platform.state.models = []
  const owner = await h2.login(ALICE)
  assert.equal((await owner.get('/api/about')).json.model, '未配置')
  await h2.close()
})

test('顶栏：标题、版本号、设置、关于、退出都在，所有页面一致', async () => {
  const m = await create(alice)
  for (const path of ['/', `/meetings/${m.id}`, '/import', '/settings', '/about']) {
    const { text } = await alice.get(path)
    for (const part of ['class="yh-top"', '会议与纪要', 'href="settings"', 'href="about"', 'href="logout"']) assert.ok(text.includes(part), `${path} ${part}`)
    assert.match(text, new RegExp(`id="version">v${VERSION}<`), path)
  }
})

test('退出：清会话并跳平台，带上回到本应用的地址', async () => {
  const other = await h.login(CAROL)
  const r = await other.get('/logout', { 'x-forwarded-prefix': '/apps/meeting' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), `${h.platform.url}/logout?redirect=${encodeURIComponent('/apps/meeting/')}`)
  assert.equal((await other.get('/api/meetings')).status, 401)
})

test('MCP：get_meeting_notes 带上项目和摘要', async () => {
  h.platform.state.llm = () => JSON.stringify({ ...SUMMARY, project: '华东', summary: '一句话。' })
  const m = await withNote(alice)
  await extract(alice, m.id)
  const out = (await h.mcp('tools/call', { name: 'get_meeting_notes', arguments: { id: m.id } }, `token-${ALICE}`)).json.result.structuredContent
  assert.deepEqual([out.project, out.summary], ['华东', '一句话。'])
})

// ---------- MCP ----------
const call = (name, args, token) => h.mcp('tools/call', { name, arguments: args }, token)

test('MCP：不带 token 或 token 无效都 401', async () => {
  assert.equal((await h.mcp('tools/list', {})).status, 401)
  assert.equal((await h.mcp('tools/list', {}, 'bad')).status, 401)
})

test('MCP：列出两个工具，都声明只读', async () => {
  const { json } = await h.mcp('tools/list', {}, `token-${ALICE}`)
  assert.deepEqual(json.result.tools.map((t) => t.name), ['list_meetings', 'get_meeting_notes'])
  assert.ok(json.result.tools.every((t) => t.annotations.readOnlyHint === true && t.description.length > 20))
})

test('MCP：list_meetings 只看近 N 天，只看自己的', async () => {
  const near = await create(alice, { title: '近', starts_at: local(-60), attendee_ids: [BOB] })
  await create(alice, { title: '远', starts_at: local(-60 * 24 * 30) })
  const out = (await call('list_meetings', { days: 7 }, `token-${ALICE}`)).json.result.structuredContent
  assert.deepEqual(out.list.map((m) => m.id), [near.id])
  assert.equal((await call('list_meetings', {}, `token-${BOB}`)).json.result.structuredContent.total, 1)
  assert.equal((await call('list_meetings', {}, `token-${CAROL}`)).json.result.structuredContent.total, 0)
  assert.equal((await call('list_meetings', { days: 45 }, `token-${ALICE}`)).json.result.structuredContent.total, 2)
})

test('MCP：get_meeting_notes 返回四块', async () => {
  const m = await withNote(alice, { attendee_ids: [BOB] })
  await extract(alice, m.id)
  const out = (await call('get_meeting_notes', { id: m.id }, `token-${BOB}`)).json.result.structuredContent
  assert.deepEqual({ decisions: out.decisions, todos: out.todos, risks: out.risks, nextAgenda: out.nextAgenda }, SUMMARY)
  assert.equal(out.title, '周会')
})

test('MCP：看不到的会议和不存在一样', async () => {
  const m = await create(alice)
  const r = (await call('get_meeting_notes', { id: m.id }, `token-${CAROL}`)).json.result
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, '会议不存在')
})

test('MCP：调用上报使用数据，标 via=ai', async () => {
  h.platform.state.events.length = 0
  await call('list_meetings', {}, `token-${ALICE}`)
  await h.ws.flush()
  assert.ok(h.platform.state.events.some((e) => e.action === 'mcp.list_meetings' && e.detail.via === 'ai'))
})
