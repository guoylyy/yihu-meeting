// 导入页：一个个传，一个失败不影响下一个。每个文件一行结果，项目就地改，不弹确认
const FILE_MAX = 10 * 1024 * 1024
const FILES_MAX = 5
const fileInput = $('file-input')
const drop = $('drop')
const results = $('results')

function row(name) {
  const li = document.createElement('li')
  li.className = 'yh-row result'
  const head = document.createElement('span')
  head.className = 'yh-row-main'
  const title = document.createElement('span')
  title.className = 'yh-row-title'
  title.textContent = name
  const tag = document.createElement('span')
  tag.className = 'yh-tag'
  tag.textContent = '等待中'
  head.append(title, tag)
  li.append(head)
  results.prepend(li)
  return { li, title, tag }
}

const skeleton = () => {
  const el = document.createElement('div')
  el.className = 'yh-skeleton'
  el.append(document.createElement('i'))
  return el
}

const message = (text, bad = false) => {
  const p = document.createElement('p')
  p.className = `result-msg${bad ? ' bad' : ''}`
  p.textContent = text
  return p
}

function fail(r, name, reason) {
  r.tag.textContent = '未导入'
  r.li.querySelector('.yh-skeleton')?.remove()
  r.li.append(message(`${name}：${reason}`, true))
}

/** 成功或降级都走这里：会议已经落库，这一行给链接和可改的项目 */
function done(r, out) {
  r.li.querySelector('.yh-skeleton')?.remove()
  r.tag.textContent = out.ok ? '已整理' : '已保存原文'
  const link = document.createElement('a')
  link.href = `meetings/${out.meeting.id}`
  link.className = 'result-link'
  link.textContent = out.meeting.title
  r.title.replaceChildren(link)
  const sub = document.createElement('span')
  sub.className = 'yh-row-sub'
  sub.textContent = out.meeting.when
  r.li.append(sub)
  if (out.message) r.li.append(message(out.message, true))
  for (const n of out.notices) r.li.append(message(n))

  const edit = document.createElement('div')
  edit.className = 'result-edit'
  const label = document.createElement('label')
  label.className = 'yh-field'
  const cap = document.createElement('span')
  cap.className = 'yh-label'
  cap.textContent = '项目 / 客户'
  const input = document.createElement('input')
  input.className = 'result-project'
  input.value = out.meeting.project
  input.maxLength = 100
  input.autocomplete = 'off'
  input.setAttribute('list', 'project-names')
  label.append(cap, input)
  edit.append(label)
  r.li.append(edit)
  input.addEventListener('change', async () => {
    try {
      await api('PATCH', `api/meetings/${out.meeting.id}`, { project: input.value })
      toast('项目已改')
    } catch (err) { toast(err.message) }
  })
}

/** 只有服务端判不了的放这里：超过 10MB 的不用白传一遍。格式提示以服务端为准，页面和接口说同一句话 */
async function send(file) {
  const r = row(file.name)
  r.tag.textContent = '处理中'
  r.li.append(skeleton())
  if (file.size > FILE_MAX) return fail(r, file.name, '单个文件不能超过 10MB')
  try {
    const out = await api('POST', `api/import/file?name=${encodeURIComponent(file.name)}`, undefined, { body: file, headers: { 'Content-Type': 'application/octet-stream' } })
    done(r, out)
  } catch (err) {
    fail(r, file.name, err.message)
  }
}

async function takeFiles(list) {
  const files = [...list]
  if (files.length > FILES_MAX) toast(`一次最多 ${FILES_MAX} 个文件，后面 ${files.length - FILES_MAX} 个没有导入`)
  for (const f of files.slice(0, FILES_MAX)) await send(f)
  fileInput.value = ''
}

fileInput.addEventListener('change', () => takeFiles(fileInput.files))

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over') })
}
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  takeFiles(e.dataTransfer.files)
})

const imageHelp = $('image-help')
$('image-help-btn').addEventListener('click', () => imageHelp.showModal())
imageHelp.querySelector('[data-close]').addEventListener('click', () => imageHelp.close())
imageHelp.addEventListener('click', (e) => { if (e.target === imageHelp) imageHelp.close() })

$('paste-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('paste-text').value
  if (!text.trim()) return toast('先粘贴会议记录')
  const btn = $('paste-btn')
  btn.disabled = true
  const r = row('粘贴的文字')
  r.tag.textContent = '处理中'
  r.li.append(skeleton())
  try {
    done(r, await api('POST', 'api/import/text', { text }))
    $('paste-text').value = ''
  } catch (err) {
    fail(r, '粘贴的文字', err.message)
  }
  btn.disabled = false
})
