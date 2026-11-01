// 导入：把上传的文件读成纯文字。失败分两级——读不出字抛 ImportError（文件名 + 一句原因，什么都不落库）；读出来但有缺憾放 notices（照常入库，页面提示）
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FILE_MAX = 10 * 1024 * 1024
export const FILES_MAX = 5
export const PDF_PAGES = 60
export const ACCEPT = ['.docx', '.pdf', '.txt', '.md']
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.bmp']
const WORKER_TIMEOUT_MS = 30_000
const WORKER_HEAP_MB = 160
const WORKER_MAX = 1 // 主进程加一个子进程峰值约 550MB，清单 memory 按这个留，调大要跟着改
const DOCX_INFLATED_MAX = 150 * 1024 * 1024 // 10MB 的 zip 解压出几个 G 是压缩炸弹，JSZip 的内存不受堆上限管
const WORKER_FILE = fileURLToPath(new URL('./import-worker.js', import.meta.url))
const SCANNED_CHARS = 20
const GARBLED_RATIO = 0.05

export class ImportError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const unreadable = (message) => new ImportError('unreadable', message)

/** 只认扩展名：浏览器给的 MIME 不可靠，内容再由各自的解析器验 */
export function kindOf(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  if (ext === '.docx') return 'docx'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.txt' || ext === '.md') return 'text'
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (ext === '.doc') return 'doc'
  return 'other'
}

/** 没有 BOM 时先按 UTF-8，不合法再按 GBK：Windows 记事本存的中文 .txt 大多是 GBK */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  if (buf.includes(0)) throw unreadable('这不是文本文件，可能是改了扩展名')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gbk').decode(buf)
  }
}

/** 读 zip 中央目录把解压后大小加起来，不解压。不是合法 zip 返回 null */
export function zipInflatedSize(buf) {
  const floor = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const entries = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null
    total += buf.readUInt32LE(at + 24)
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
  }
  return total
}

let running = 0
const waiting = []

async function withSlot(fn) {
  if (running >= WORKER_MAX) await new Promise((resolve) => waiting.push(resolve))
  else running++
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

function inWorker(kind, buf, timeoutMs) {
  return new Promise((resolve, reject) => {
    // 环境变量只给 PATH：解析不可信文件的进程不需要数据库地址和平台凭证
    const child = fork(WORKER_FILE, {
      execArgv: [`--max-old-space-size=${WORKER_HEAP_MB}`],
      env: { PATH: process.env.PATH ?? '' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, unreadable('文件太复杂，读取超时了，请粘贴文本')), timeoutMs)
    child.once('message', (m) => finish(m.ok ? resolve : reject, m.ok ? m.result : Object.assign(new Error(m.message), { name: m.name })))
    child.once('error', () => finish(reject, unreadable('文件没读出来，稍后再试')))
    child.once('exit', () => finish(reject, unreadable('文件太大太复杂，读不下来，请粘贴文本')))
    child.send({ kind, bytes: new Uint8Array(buf), maxPages: PDF_PAGES }, (e) => {
      if (e) finish(reject, unreadable('文件没读出来，稍后再试'))
    })
  })
}

async function readDocx(buf, timeoutMs) {
  const size = zipInflatedSize(buf)
  if (size === null || buf.subarray(0, 2).toString('latin1') !== 'PK') throw unreadable('这不是有效的 .docx，可能已损坏，或是改了扩展名的文件')
  if (size > DOCX_INFLATED_MAX) throw unreadable('文档解压后太大，请粘贴文本')
  try {
    const { text } = await withSlot(() => inWorker('docx', buf, timeoutMs))
    if (!text.trim()) throw unreadable('文档里没有文字（图片里的字读不出来），请粘贴文本')
    return { text, notices: [] }
  } catch (e) {
    if (e instanceof ImportError) throw e
    console.warn(`[meeting] docx 解析失败：${e.message}`)
    throw unreadable('这不是有效的 .docx，可能已损坏，或是改了扩展名的文件')
  }
}

/** 自定义编码的字体抽出来是控制符和替换符，不能当正文入库（解析不报错，模型也只会瞎编） */
export function looksGarbled(text) {
  const visible = text.replace(/\s/g, '')
  const bad = visible.match(/[\p{Cc}\p{Cs}\p{Co}�]/gu)?.length ?? 0
  return bad / Math.max(visible.length, 1) > GARBLED_RATIO
}

/**
 * PDF 的字体映射常把「目」写成长得一样的康熙部首（U+2F6C），看着对，搜「项目」搜不到。
 * 只归一部首和兼容汉字：整段做 NFKC 会把中文全角标点也改成半角
 */
export const fixRadicals = (text) => text.replace(/[\u2E80-\u2FD5\uF900-\uFAFF]/g, (c) => c.normalize('NFKC'))

async function readPdf(buf, timeoutMs) {
  if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) throw unreadable('这不是有效的 PDF，可能已损坏，或是改了扩展名的文件')
  let r
  try {
    r = await withSlot(() => inWorker('pdf', buf, timeoutMs))
  } catch (e) {
    if (e instanceof ImportError) throw e
    if (e.name === 'PasswordException') throw unreadable('这个 PDF 有密码，请解密后再上传，或粘贴文本')
    console.warn(`[meeting] pdf 解析失败：${e.message}`)
    throw unreadable('这个 PDF 打不开，可能已损坏')
  }
  if (r.text.replace(/\s/g, '').length < SCANNED_CHARS) throw new ImportError('scanned', '这是扫描件，暂不能识别文字，请粘贴文本')
  if (looksGarbled(r.text)) throw unreadable('这个 PDF 的字体编码读不出正确文字，请粘贴文本')
  const notices = []
  if (r.total > PDF_PAGES) notices.push(`只读前 ${PDF_PAGES} 页（共 ${r.total} 页）`)
  if (r.blank) notices.push(`有 ${r.blank} 页读不出文字，可能是扫描页`)
  return { text: fixRadicals(r.text), notices }
}

/** 文件 → { text, notices }。读不了抛 ImportError */
export async function readUpload(name, buf, { timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const kind = kindOf(name)
  if (kind === 'image') throw new ImportError('image', '图片识别暂未开通，请先转成文字')
  if (kind === 'doc') throw new ImportError('unsupported', '老版 .doc 读不了，请在 Word 里另存为 .docx')
  if (kind === 'other') throw new ImportError('unsupported', `不支持这种格式，可以上传 ${ACCEPT.join('、')}`)
  if (!buf.length) throw unreadable('这是空文件')
  if (buf.length > FILE_MAX) throw new ImportError('too_large', '单个文件不能超过 10MB')
  if (kind === 'docx') return readDocx(buf, timeoutMs)
  if (kind === 'pdf') return readPdf(buf, timeoutMs)
  const text = decodeText(buf).replace(/^﻿/, '')
  if (!text.trim()) throw unreadable('这是空文件')
  return { text, notices: [] }
}
