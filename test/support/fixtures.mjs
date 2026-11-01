// 测试用的 .docx / .pdf：运行时用标准库现造，仓库里不放二进制文件。结构和真实文件一样，走的是真实的 mammoth / pdfjs
import zlib from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 最小的 zip：files 是 [路径, 内容]。declaredSize 用来造「解压后声称很大」的文件 */
export function buildZip(files, { declaredSize } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of files) {
    const raw = Buffer.from(content)
    const packed = zlib.deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(raw), 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(raw.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    locals.push(head, nameBuf, packed)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(crc32(raw), 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(declaredSize ?? raw.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    centrals.push(dir, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const paragraph = (text) => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`
const tableXml = (rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc>${paragraph(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`

/** blocks：字符串是段落，二维数组是表格 */
export function buildDocx(blocks, opts) {
  const body = blocks.map((b) => (Array.isArray(b) ? tableXml(b) : paragraph(b))).join('')
  return buildZip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`]
  ], opts)
}

const ucs2Hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')

/** 把对象串成合法 PDF，带 xref，pdfjs 不需要走修复逻辑 */
function assemblePdf(objects) {
  const parts = ['%PDF-1.7\n']
  const offsets = []
  let pos = parts[0].length
  objects.forEach((body, i) => {
    const text = `${i + 1} 0 obj\n${body}\nendobj\n`
    offsets.push(pos)
    parts.push(text)
    pos += Buffer.byteLength(text, 'latin1')
  })
  const table = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`)
  return Buffer.from(parts.join(''), 'latin1')
}

/**
 * pages：每页一段字符串；null 是整页图片（扫描件）。
 * 中文走 Adobe-GB1 预定义 CMap、不嵌字体，这是中文 PDF 最容易抽成乱码的形态
 */
export function buildPdf(pages) {
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >> >>] >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream'
  ]
  for (const [i, text] of pages.entries()) {
    const stream = text === null
      ? 'q 500 0 0 700 50 50 cm /Im1 Do Q'
      : `BT /F1 14 Tf 50 750 Td 18 TL ${text.split('\n').map((line) => `<${ucs2Hex(line)}> Tj T*`).join(' ')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${6 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  return assemblePdf(objects)
}
