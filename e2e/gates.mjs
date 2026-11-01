// 发版验收：15 张截图（三档 × 五页）+ 两张弹层 + 视觉断言 + docx 全流程 + 断开 AI 的降级。产物都在 artifacts/v<版本>/，不进 git
//   E2E_DATABASE_URL=mysql://… node e2e/gates.mjs     不给就用 Docker 起临时库
//   这里的「模型」是假平台返回的固定 JSON，验的是链路和降级，不是模型质量；模型质量用 scripts/real-model.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { chromium } from 'playwright-core'
import { startFakePlatform } from '../test/support/fake-platform.mjs'
import { buildDocx } from '../test/support/fixtures.mjs'
import { VERSION } from '../src/version.js'
import { MINUTE, SIZES, SMALL_TARGETS, startApp, startDatabase } from './support.mjs'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3070
const PLATFORM_PORT = APP_PORT + 1
const LOCAL_PORT = APP_PORT + 2
const OUT = `artifacts/v${VERSION}`
const LONG_TITLE = '第四季度华东区全部经销商返利对账与年度框架协议续签条款复核专题会议（含法务、财务、销售三方），需要逐条确认修订版本AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MINUTES_DOC = [
  'Q4 华东渠道推进会会议纪要',
  '时间：2026 年 10 月 28 日 14:00–15:30',
  '地点：上海总部三楼大会议室',
  '主持人：李总',
  '参会人：李总、郑国栋、王芳、陈晨',
  '一、决议',
  '1. 华东先上，华南放到明年一季度再启动。',
  '2. 返利比例维持 3%，不再往上谈。',
  '二、待办',
  [['事项', '负责人', '截止'], ['整理苏州客户名单并发群', '郑国栋', '11 月 2 日'], ['催法务返回合同模板', '王芳', '11 月 4 日'], ['出一版联调排期', '', '']],
  '三、风险',
  '合同模板法务未回，十一月第一批签约可能赶不上；接口联调只有两个人，可能影响月底上线。',
  '四、下次议题',
  '定价策略、竞品调价的影响。'
]
const AI_REPLY = {
  title: 'Q4 华东渠道推进会', held_at: '2026-10-28T14:00', location: '上海总部三楼大会议室', host: '李总', attendees: ['李总', '郑国栋', '王芳', '陈晨'], project: '华东渠道',
  summary: '确定华东先上、华南放到明年一季度，返利维持 3%。合同模板和联调人手是当前两大风险。',
  decisions: ['华东先上，华南放到明年一季度再启动', '返利比例维持 3%，不再往上谈'],
  todos: [{ title: '整理苏州客户名单并发群', owner: '郑国栋', due_date: '2026-11-02' }, { title: '催法务返回合同模板', owner: '王芳', due_date: '2026-11-04' }, { title: '出一版联调排期', owner: null, due_date: null }],
  risks: ['合同模板法务未回，十一月第一批签约可能赶不上', '接口联调只有两个人，可能影响月底上线'],
  nextAgenda: ['定价策略', '竞品调价的影响']
}

mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}
const section = (title) => console.log(`\n=== ${title} ===`)

const db = await startDatabase()
const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
platform.state.llm = () => JSON.stringify(AI_REPLY)
const appUrl = `${platform.url}/apps/meeting`
const appEnv = { DATABASE_URL: db.url, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/meeting', MEETING_AI_TIMEOUT_MS: '2000' }
const app = await startApp({ port: APP_PORT, env: appEnv })
const pool = mysql.createPool({ uri: db.url, timezone: 'Z' })
const browser = await chromium.launch()
const work = mkdtempSync(join(tmpdir(), 'meeting-gates-'))

const seed = async ({ title, startMin, project = null, note = null, attendees = [], owner = 11 }) => {
  const [r] = await pool.execute('INSERT INTO meeting (owner_id, title, starts_at, ends_at, project) VALUES (?, ?, ?, ?, ?)', [owner, title, new Date(Date.now() + startMin * MINUTE), new Date(Date.now() + (startMin + 60) * MINUTE), project])
  for (const a of attendees) await pool.execute('INSERT INTO meeting_attendee (meeting_id, user_id) VALUES (?, ?)', [r.insertId, a])
  if (note) await pool.execute('INSERT INTO meeting_note (meeting_id, content) VALUES (?, ?)', [r.insertId, note])
  return r.insertId
}

async function open(width, height, userId = 11) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  return { ctx, page }
}

const under44 = new Set()
async function audit(page, label) {
  const r = await page.evaluate(() => ({ body: document.body.scrollWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth }))
  check(`${label} 无横向滚动`, r.body <= r.inner && r.doc <= r.inner, `body=${r.body} doc=${r.doc} inner=${r.inner}`)
  for (const s of await page.evaluate(SMALL_TARGETS)) under44.add(`${label}: ${s}`)
}

/** 面包屑：离顶栏 12px，文字灰，‹ 和字隔 4px，滚回来时不钻到顶栏下面 */
async function checkCrumb(page, label) {
  const r = await page.evaluate(() => {
    const top = document.querySelector('.yh-top').getBoundingClientRect().bottom
    const back = document.querySelector('.back')
    const s = getComputedStyle(back)
    const probe = document.createElement('i')
    probe.style.color = 'var(--yh-text-3)'
    document.body.append(probe)
    const muted = getComputedStyle(probe).color
    probe.remove()
    const gap = back.getBoundingClientRect().top - top
    window.scrollTo(0, document.documentElement.scrollHeight)
    back.scrollIntoView()
    const scrolled = back.getBoundingClientRect().top - document.querySelector('.yh-top').getBoundingClientRect().bottom
    window.scrollTo(0, 0)
    return { gap, scrolled, inner: s.columnGap, color: s.color === muted }
  })
  check(`${label} 面包屑`, r.gap === 12 && r.scrolled >= 12 && r.inner === '4px' && r.color, JSON.stringify(r))
}

/** 列表：标题 ≤2 行、状态和第一行同基线、次行一行不溢出 */
async function checkRows(page, label) {
  const bad = await page.evaluate(() => {
    const baseline = (el) => {
      const i = document.createElement('span')
      i.style.cssText = 'display:inline-block;width:0;height:0'
      el.prepend(i)
      const y = i.getBoundingClientRect().bottom
      i.remove()
      return y
    }
    const out = []
    for (const m of document.querySelectorAll('.meeting')) {
      const title = m.querySelector('.yh-row-title')
      const sub = m.querySelector('.yh-row-sub')
      const line = parseFloat(getComputedStyle(title).lineHeight)
      const name = title.textContent.slice(0, 8)
      if (title.getBoundingClientRect().height > line * 2 + 1) out.push(`${name} 标题超两行`)
      if (Math.abs(baseline(title) - baseline(m.querySelector('.yh-row-status'))) > 1) out.push(`${name} 状态没对齐`)
      const tops = [...sub.children].map((c) => c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)
      if (Math.max(...tops) - Math.min(...tops) > 2) out.push(`${name} 次行换行`)
      if (sub.scrollWidth > sub.clientWidth) out.push(`${name} 次行溢出`)
    }
    return out
  })
  check(`${label} 列表行：标题两行内、状态同基线、次行一行`, bad.length === 0, bad.join(' | '))
}

const uploadOne = async (page, path) => {
  await page.setInputFiles('#file-input', path)
}

try {
  // ---------- 门槛 3：docx 全流程 ----------
  section('门槛 3：上传 → AI 结构化 → 列表 → 详情 → 指派')
  const docx = join(OUT, '会议纪要-Q4华东渠道推进会.docx')
  writeFileSync(docx, buildDocx(MINUTES_DOC))
  let flowId
  {
    const { ctx, page } = await open(1440, 900)
    await page.waitForSelector('.yh-empty a[href="import"]')
    check('空态：一句话 + 导入按钮', (await page.locator('.yh-empty p').allTextContents()).join() === '还没有会议。' && await page.locator('.yh-empty .yh-btn').count() === 1)
    await page.screenshot({ path: `${OUT}/flow-0-empty.png` })
    await page.click('#import-btn')
    await page.waitForSelector('#file-input', { state: 'attached' })
    await uploadOne(page, docx)
    await page.waitForSelector('.result .result-project')
    check('上传：结果行已整理', (await page.textContent('.result .yh-tag')) === '已整理', await page.textContent('.result .yh-row-title'))
    check('上传：AI 建议的项目在输入框里', (await page.inputValue('.result-project')) === '华东渠道')
    await page.screenshot({ path: `${OUT}/flow-1-uploaded.png`, fullPage: true })
    await page.fill('.result-project', '华东渠道二期')
    await page.locator('.result-project').blur()
    await page.waitForSelector('#toast:not([hidden])')
    check('项目直接改，没有确认弹窗', await page.locator('dialog[open]').count() === 0, await page.textContent('#toast'))
    await page.click('.result .yh-row-title a')
    await page.waitForSelector('.note-card')
    flowId = Number(page.url().split('/').pop())
    await page.screenshot({ path: `${OUT}/flow-3-detail.png`, fullPage: true })
    check('详情：摘要', (await page.textContent('#m-summary')).includes('华东先上'))
    check('详情：项目、主持人、来源', (await page.textContent('#m-project')) === '华东渠道二期' && (await page.textContent('#m-host')).includes('李总') && (await page.textContent('#m-source')).includes('.docx'))
    check('详情：四块条数', (await page.locator('.block h2').allTextContents()).join() === '决议 · 2,待办 · 3,风险 · 2,下次议题 · 2')
    check('详情：纪要原文来自 docx（含表格）', /催法务返回合同模板/.test(await page.inputValue('#note')))
    await page.goto(`${appUrl}/?view=all`)
    await page.waitForSelector('.meeting')
    check('列表：出现这场会，次行有项目', (await page.textContent('.meeting .yh-row-sub')).includes('华东渠道二期'))
    await page.screenshot({ path: `${OUT}/flow-2-list.png` })
    await page.goto(`${appUrl}/meetings/${flowId}`)
    await page.waitForSelector('[data-assign]')
    const third = page.locator('.block[data-kind="todo"] .item').nth(2)
    await third.locator('[data-assign]').click()
    await page.waitForSelector('#assign[open]')
    await page.fill('#assign-owner', '陈晨')
    await page.fill('#assign-due', '2026-11-06')
    await page.screenshot({ path: `${OUT}/flow-4-assign.png` })
    await audit(page, '1440 指派弹层')
    await page.click('#assign-save')
    await page.waitForSelector('[data-line="出一版联调排期 @陈晨 11-06"]')
    check('指派：负责人和截止日显示出来', (await third.locator('.item-owner').textContent()) === '@陈晨')
    await page.screenshot({ path: `${OUT}/flow-5-assigned.png`, fullPage: true })
    check('流程无控制台报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 200))
    await ctx.close()
  }
  console.log('\nmysql> select title, held_at, project from meeting order by id desc limit 3;')
  console.table((await pool.query('SELECT title, held_at, project FROM meeting ORDER BY id DESC LIMIT 3'))[0].map((r) => ({ title: r.title, held_at: r.held_at.toISOString().slice(0, 19).replace('T', ' '), project: r.project })))
  console.log('mysql> select kind, text, owner_name, due_date, source from meeting_item where meeting_id = 最新 order by id;')
  console.table((await pool.query("SELECT kind, text, owner_name, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date, source FROM meeting_item WHERE meeting_id = ? ORDER BY id", [flowId]))[0])

  // ---------- 真实文件：不是自己拼的字节 ----------
  section('真实文件：macOS textutil 生成的 docx、Chromium 打印的中文 PDF')
  {
    const { ctx, page } = await open(1440, 900)
    await page.setContent('<html lang="zh-CN"><body style="font-family:PingFang SC"><h1>华南项目复盘会</h1><p>决议：预算维持不变。王芳负责跟进客户。</p></body></html>')
    const pdf = join(work, '浏览器打印的纪要.pdf')
    await page.pdf({ path: pdf, format: 'A4' })
    await page.goto(`${appUrl}/import`)
    platform.state.llm = () => JSON.stringify({ ...AI_REPLY, title: '真实 PDF', project: '文件验证' })
    await uploadOne(page, pdf)
    await page.waitForSelector('.result .result-project')
    const [[pdfNote]] = await pool.query("SELECT n.content FROM meeting_note n JOIN meeting m ON m.id = n.meeting_id WHERE m.title = '真实 PDF'")
    check('Chromium PDF：中文抽取正确', pdfNote.content.includes('华南项目复盘会') && pdfNote.content.includes('预算维持不变'), JSON.stringify(pdfNote.content).slice(0, 80))
    if (existsSync('/usr/bin/textutil')) {
      const txt = join(work, 'in.txt')
      writeFileSync(txt, '华北项目周会\n决议：下周上线。\n')
      const real = join(work, 'textutil纪要.docx')
      execFileSync('/usr/bin/textutil', ['-convert', 'docx', '-output', real, txt])
      platform.state.llm = () => JSON.stringify({ ...AI_REPLY, title: '真实 DOCX', project: '文件验证' })
      await page.reload()
      await uploadOne(page, real)
      await page.waitForSelector('.result .result-project')
      const [[n]] = await pool.query("SELECT n.content FROM meeting_note n JOIN meeting m ON m.id = n.meeting_id WHERE m.title = '真实 DOCX'")
      check('textutil docx：抽取正确', n.content.includes('下周上线'), JSON.stringify(n.content))
    }
    platform.state.llm = () => JSON.stringify(AI_REPLY)
    await ctx.close()
  }

  // ---------- 门槛 2：15 张截图 + 断言 ----------
  section('门槛 2：三档五页')
  await seed({ title: LONG_TITLE, startMin: 90, project: '华东渠道二期', attendees: [12, 13] })
  await seed({ title: '产品评审', startMin: -20, project: '会议应用', attendees: [12] })
  await seed({ title: '客户复盘', startMin: -300, project: '华南项目', attendees: [12, 13], note: '讨论了返利' })
  await seed({ title: '销售周报', startMin: -1500, project: '华东渠道二期', note: '周报' })
  await seed({ title: '预算沟通', startMin: -3000, note: '预算' })
  const longProject = await seed({ title: '超长项目名的会议', startMin: -4000, project: '长'.repeat(100) })
  await seed({ title: '别人的会', startMin: 30, owner: 13, project: '别人的项目' })
  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await open(width, height)
    await page.goto(`${appUrl}/?view=all`)
    await page.waitForSelector('.meeting')
    await page.screenshot({ path: `${OUT}/${tag}-list.png` })
    await audit(page, `${tag} 列表`)
    await checkRows(page, tag)
    if (width >= 1024) {
      check(`${tag} 列表：主栏 + 右侧栏，不是一列到底`, await page.evaluate(() => {
        const main = document.querySelector('.split--rail > section').getBoundingClientRect()
        const side = document.querySelector('.side').getBoundingClientRect()
        return side.width > 200 && side.left >= main.right && Math.abs(side.top - main.top) < 8
      }))
      check(`${tag} 列表：本月统计和最近会议都在`, await page.locator('.yh-stat').count() === 3 && await page.locator('.side h2').allTextContents().then((t) => t.includes('最近会议')))
    } else check(`${tag} 列表：窄屏不显示右栏`, !(await page.locator('.side').isVisible()))
    check(`${tag} 顶栏 sticky、高 56`, await page.evaluate(() => {
      const el = document.querySelector('.yh-top')
      return getComputedStyle(el).position === 'sticky' && Math.round(el.getBoundingClientRect().height) === 56
    }))
    check(`${tag} 别人的项目不出现`, !(await page.content()).includes('别人的项目'))

    await page.selectOption('#project-filter', '华南项目')
    await page.waitForFunction(() => document.querySelectorAll('.meeting').length === 1)
    check(`${tag} 项目过滤`, (await page.textContent('.meeting .yh-row-title')) === '客户复盘')
    await page.selectOption('#project-filter', '')
    await page.waitForFunction(() => document.querySelectorAll('.meeting').length > 1)

    await page.click('#user-menu summary')
    await page.waitForSelector('.yh-menu-list a[href="settings"]')
    check(`${tag} 头像菜单：设置、关于、退出`, (await page.locator('.yh-menu-list a').allTextContents()).join() === '设置,关于,退出')
    await audit(page, `${tag} 头像菜单`)
    await page.keyboard.press('Escape')

    await page.click('#new-btn')
    await page.waitForSelector('#sheet[open]')
    await audit(page, `${tag} 新建弹层`)
    await page.click('#sheet [data-close]')

    await page.goto(`${appUrl}/meetings/${flowId}`)
    await page.waitForSelector('.note-card')
    await page.screenshot({ path: `${OUT}/${tag}-detail.png`, fullPage: true })
    await audit(page, `${tag} 详情`)
    await checkCrumb(page, `${tag} 详情`)
    check(`${tag} 详情：纪要默认只读，60vh 内滚动`, await page.evaluate(() => {
      const v = document.getElementById('note-text')
      return document.getElementById('note').hidden && !v.hidden && v.getBoundingClientRect().height <= innerHeight * 0.6 + 1 && getComputedStyle(v).overflowY === 'auto'
    }))
    check(`${tag} 详情：待办只露指派和 ⋯，没有收件箱说明`, (await page.locator('.block[data-kind="todo"] .item').first().locator('button').allTextContents()).join() === '指派,⋯' && await page.locator('.block .note-line').count() === 0)
    await page.click('#note-edit')
    check(`${tag} 详情：点编辑进输入框，焦点在里面`, await page.evaluate(() => document.activeElement?.id === 'note' && document.getElementById('note-text').hidden) && (await page.textContent('#note-edit')) === '完成')
    await audit(page, `${tag} 纪要编辑态`)
    await page.click('#note-edit')
    await page.click('.block[data-kind="todo"] .item:first-child [data-more]')
    await page.waitForSelector('#item-menu[open]')
    check(`${tag} 详情：⋯ 菜单含复制、删除`, (await page.locator('#item-menu .menu-item').allTextContents()).join() === '复制,删除')
    await audit(page, `${tag} 待办菜单`)
    if (tag === '1440') await page.screenshot({ path: `${OUT}/1440-detail-menu.png` })
    await page.click('#item-menu [data-close]')

    await page.goto(`${appUrl}/meetings/${longProject}`)
    await page.waitForSelector('.note-card')
    await audit(page, `${tag} 超长项目名详情`)

    await page.goto(`${appUrl}/import`)
    await page.waitForSelector('#drop')
    const bad = join(work, '白板照片.png')
    writeFileSync(bad, 'x')
    await page.setInputFiles('#file-input', [docx, bad])
    await page.waitForFunction(() => document.querySelectorAll('.result .result-project').length === 1 && document.querySelector('.result-msg.bad'))
    await page.screenshot({ path: `${OUT}/${tag}-import.png`, fullPage: true })
    await audit(page, `${tag} 导入`)
    await checkCrumb(page, `${tag} 导入`)
    check(`${tag} 导入：一行格式说明，没有格式清单`, (await page.textContent('.import-note .note-line')).trim() === '支持 .docx / .pdf / .txt / .md，单文件 ≤10MB，一次最多 5 个' && (await page.textContent('.drop')).trim() === '选择文件，或拖到这里' && !(await page.content()).includes('支持的格式'))
    const note = await page.evaluate(() => {
      const text = document.querySelector('.import-note .note-line').getBoundingClientRect()
      const link = document.getElementById('image-help-btn').getBoundingClientRect()
      const drop = document.getElementById('drop').getBoundingClientRect()
      return { lines: Math.round(text.height / 20.8), below: text.top >= drop.bottom, sameRow: link.left >= text.right && link.top < text.bottom && text.top < link.bottom, rightEdge: Math.round(innerWidth - link.right) }
    })
    check(`${tag} 导入：说明一行，在上传框下方${width > 640 ? '，文字链同一行靠右' : ''}`, note.lines === 1 && note.below && (width <= 640 || note.sameRow), JSON.stringify(note))
    check(`${tag} 导入：图片说明默认收起`, await page.locator('#image-help[open]').count() === 0)
    await page.click('#image-help-btn')
    await page.waitForSelector('#image-help[open]')
    await page.waitForFunction(() => !document.getAnimations().length)
    check(`${tag} 导入：图片说明一句话`, (await page.textContent('#image-help .yh-sheet-body')).trim() === '图片识别暂未开通，请先把图片内容转成文字再粘进来。')
    await audit(page, `${tag} 图片说明`)
    if (tag === '375') await page.screenshot({ path: `${OUT}/375-import-sheet.png` })
    await page.click('#image-help [data-close]')
    check(`${tag} 导入：图片明确提示`, (await page.textContent('.result-msg.bad')).includes('白板照片.png：图片识别暂未开通，请先转成文字'))
    await pool.execute('DELETE FROM meeting WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM meeting) t)')
    page.problems = page.problems.filter((p) => !p.includes('422'))

    await page.goto(`${appUrl}/about`)
    await page.waitForSelector('.info')
    await page.screenshot({ path: `${OUT}/${tag}-about.png` })
    await audit(page, `${tag} 关于`)
    await checkCrumb(page, `${tag} 关于`)

    await page.goto(`${appUrl}/settings`)
    await page.waitForSelector('.info')
    await page.screenshot({ path: `${OUT}/${tag}-settings.png` })
    await audit(page, `${tag} 设置`)
    await checkCrumb(page, `${tag} 设置`)
    await page.click('#f-people')
    await page.waitForSelector('#picker[open] #picker-list button')
    await audit(page, `${tag} 选人弹层`)
    await page.click('#picker-done')

    check(`${tag} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  // 右栏吸顶：只有左栏更高时才看得出来，用超长议程把左栏撑高
  section('详情右栏')
  {
    const id = await seed({ title: '议程很长的会', startMin: -5000, note: '短纪要' })
    await pool.execute('UPDATE meeting SET agenda = ? WHERE id = ?', ['一条议程\n'.repeat(200), id])
    const { ctx, page } = await open(1440, 900)
    await page.goto(`${appUrl}/meetings/${id}`)
    await page.waitForSelector('.note-card')
    const r = await page.evaluate(() => {
      window.scrollTo(0, 1500)
      const el = document.querySelector('.detail-rail')
      return { position: getComputedStyle(el).position, top: getComputedStyle(el).top, y: el.getBoundingClientRect().top }
    })
    check('1440 右栏 sticky，滚动后停在 68px', r.position === 'sticky' && r.top === '68px' && r.y === 68, JSON.stringify(r))
    await ctx.close()
    const m = await open(768, 1024)
    await m.page.goto(`${appUrl}/meetings/${id}`)
    await m.page.waitForSelector('.note-card')
    check('768 右栏不吸顶', await m.page.evaluate(() => getComputedStyle(document.querySelector('.detail-rail')).position) === 'static')
    await m.ctx.close()
  }

  // 设置改动即时生效：页面上改，下一次导入就用
  section('设置即时生效')
  {
    const { ctx, page } = await open(1440, 900)
    await page.goto(`${appUrl}/settings`)
    await page.selectOption('#s-lang', 'en')
    await page.waitForSelector('#toast:not([hidden])')
    await page.fill('#s-days', '7')
    await page.locator('#s-days').blur()
    await page.waitForFunction(() => document.getElementById('toast').textContent === '已保存')
    let prompt = ''
    platform.state.llm = (body) => { prompt = body.messages[0].content; return JSON.stringify({ ...AI_REPLY, title: '设置生效' }) }
    await page.goto(`${appUrl}/import`)
    await uploadOne(page, docx)
    await page.waitForSelector('.result .result-project')
    check('不重启：摘要语言已换英文', prompt.includes('write in English'))
    const [[{ due }]] = await pool.query("SELECT DATE_FORMAT(i.due_date, '%Y-%m-%d') AS due FROM meeting_item i JOIN meeting m ON m.id = i.meeting_id WHERE m.title = '设置生效' AND i.text = '出一版联调排期'")
    check('不重启：默认截止天数已生效（10-28 + 7 天）', due === '2026-11-04', due)
    await pool.execute("DELETE FROM meeting_setting WHERE user_id = 11")
    await ctx.close()
  }

  // ---------- 门槛 5：断开 AI ----------
  section('门槛 5：断开平台 AI')
  {
    const { ctx, page } = await open(1440, 900)
    await page.goto(`${appUrl}/import`)
    const docPath = join(work, '断开AI的纪要.docx')
    writeFileSync(docPath, buildDocx(MINUTES_DOC))
    const scenario = async (label, llm, models, rejectKey = false) => {
      platform.state.llm = llm
      platform.state.models = models
      platform.state.rejectKey = rejectKey
      await page.goto(`${appUrl}/import`)
      await uploadOne(page, docPath)
      await page.waitForSelector('.result .result-project')
      const msg = await page.textContent('.result-msg.bad')
      const tag = await page.textContent('.result .yh-tag')
      const [[row]] = await pool.query('SELECT m.title, CHAR_LENGTH(n.content) AS chars, (SELECT COUNT(*) FROM meeting_item i WHERE i.meeting_id = m.id) AS items FROM meeting m JOIN meeting_note n ON n.meeting_id = m.id ORDER BY m.id DESC LIMIT 1')
      console.log(`[${label}] 页面：${tag}｜${msg}`)
      console.log(`[${label}] 落库：title=${row.title} 原文 ${row.chars} 字 四块 ${row.items} 条`)
      check(`${label}：原文保住，提示可读`, row.chars > 100 && row.items === 0 && /自动整理失败，可手动填写/.test(msg))
    }
    await scenario('模型接口报错', () => undefined, null)
    await scenario('假 key（平台拒绝）', () => JSON.stringify(AI_REPLY), null, true)
    await scenario('模型回垃圾', () => '抱歉，我无法处理这个请求', null)
    await scenario('模型挂起超时', () => new Promise(() => {}), null)
    await page.goto(`${appUrl}/about`)
    console.log(`[断开后] 关于页 AI 模型：${await page.textContent('#a-model')}（平台模型名缓存 60 秒，缓存过期后是「未配置」）`)
    await page.screenshot({ path: `${OUT}/degrade-about.png` })
    await ctx.close()
  }

  // 本地单人：完全没有平台凭证
  {
    const local = await startApp({ port: LOCAL_PORT, env: { DATABASE_URL: db.url, YH_CLIENT_ID: '', YH_CLIENT_SECRET: '', YH_APP_URL: '', YH_BASE_PATH: '' } })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${LOCAL_PORT}/import`)
      await uploadOne(page, docx)
      await page.waitForSelector('.result .result-project')
      const msg = await page.textContent('.result-msg.bad')
      console.log(`[本地单人，无模型] 页面：${await page.textContent('.result .yh-tag')}｜${msg}`)
      check('本地单人：提示未配置模型，原文保存', /还没配置模型/.test(msg))
      await page.screenshot({ path: `${OUT}/degrade-import.png`, fullPage: true })
      await page.goto(`http://127.0.0.1:${LOCAL_PORT}/about`)
      check('本地单人：运行模式、模型', (await page.textContent('#a-mode')) === '本地单人' && (await page.textContent('#a-model')) === '未配置')
      check('本地单人：菜单没有退出', await page.locator('#logout-link').count() === 0)
      await page.goto(`http://127.0.0.1:${LOCAL_PORT}/settings`)
      console.log(`[本地单人] 设置页：${await page.textContent('#s-model')}｜${await page.textContent('#s-model-hint')}`)
      await ctx.close()
    } finally {
      local.kill()
    }
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 800))
} finally {
  await browser.close()
  await pool.end()
  app.kill()
  await platform.close()
  db.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n<44px 的可点元素（${under44.size} 个）：`)
for (const s of under44) console.log(`  ${s}`)
const failed = results.filter((r) => !r.pass)
console.log(`\n检查 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length || under44.size ? 1 : 0)
