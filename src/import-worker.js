// 在独立子进程里抽 .docx / .pdf 的文字：上传的是不可信文件，解析卡死、吃光内存都不能带垮主进程（/health 要一直能答）
// 不用 worker_threads：实测线程撞上 resourceLimits 时 V8 可能直接 FATAL，把整个进程带走。子进程还能把内存全部还回去
import { createRequire } from 'node:module'
import path from 'node:path'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
const BLANK_PAGE_CHARS = 5

async function docx(bytes) {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return { text: value }
}

/** 按 hasEOL 和纵坐标还原换行：pdfjs 给的是一段段碎文字，直接拼起来整页只有一行 */
function pageText(items) {
  let out = ''
  let lastY = null
  for (const item of items) {
    if (typeof item.str !== 'string') continue
    const y = item.transform?.[5]
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n'
    out += item.str
    if (item.hasEOL && !out.endsWith('\n')) out += '\n'
    lastY = y ?? lastY
  }
  return out
}

async function pdf(bytes, maxPages) {
  const doc = await getDocument({
    data: bytes,
    // 中文 PDF 常用预定义 CMap，不给这份数据抽出来是空的或乱码
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + path.sep,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  }).promise
  const pages = Math.min(doc.numPages, maxPages)
  const texts = []
  let blank = 0
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n)
    const text = pageText((await page.getTextContent()).items)
    if (text.replace(/\s/g, '').length < BLANK_PAGE_CHARS) blank++
    texts.push(text)
    page.cleanup()
  }
  const total = doc.numPages
  await doc.destroy()
  return { text: texts.join('\n\n'), pages, total, blank }
}

process.once('disconnect', () => process.exit(1)) // 主进程没了就退，不留孤儿
process.once('message', ({ kind, bytes, maxPages }) => {
  const run = kind === 'pdf' ? pdf(bytes, maxPages) : docx(bytes)
  const reply = (m) => process.send(m, () => process.exit(0))
  run.then(
    (result) => reply({ ok: true, result }),
    (e) => reply({ ok: false, name: e?.name, message: String(e?.message ?? e) })
  )
})
