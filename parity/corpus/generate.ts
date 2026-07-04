/**
 * Round-trip eval corpus generator (F2).
 *
 * Deterministic: same SEED → identical corpus + split. The 60/40 dev/holdout
 * split is computed here, from the seed, BEFORE any human/agent inspection of
 * file contents. Holdout files must never be opened, listed with contents,
 * diffed, or logged (the scorer reports aggregates only).
 *
 * Usage:
 *   pnpm parity:corpus                  # full generation (fails if corpus exists)
 *   pnpm parity:corpus -- --refresh N   # every-5th-cycle holdout refresh: regenerate
 *                                       # N% of holdout files with a new sub-seed
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const here = dirname(fileURLToPath(import.meta.url))
const filesDir = join(here, 'files')
const SEED = 20260704

// ─── seeded RNG (mulberry32) ────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── text pool: realistic commercial-translation content ────────────────────
const SENTENCES = [
  'The undersigned parties agree to the terms & conditions set forth herein.',
  'Please review the attached invoice before the payment deadline.',
  'Adverse reactions may include nausea, dizziness, and <severe> headaches.',
  'Click "Save" to apply your changes, or press Cancel to discard them.',
  'Our team delivers world-class localization at scale — 24/7 support included.',
  'This warranty does not cover damage caused by misuse or unauthorized repair.',
  'Der Vertrag tritt am ersten Tag des Folgemonats in Kraft.',
  'La configuración se guardará automáticamente cada 5 minutos.',
  'Les données personnelles sont traitées conformément au RGPD.',
  'Take 2 tablets daily with food; do not exceed 6 tablets in 24 hours.',
  'Battery life: up to 18 hours of continuous video playback.',
  'All prices include VAT at the applicable rate of 21%.',
  'Error 404: the requested resource could not be found on this server.',
  'Free shipping on orders over $50 — terms apply.',
  "Don't share your password with anyone, including support staff.",
  'The quarterly report shows a 12.5% increase in recurring revenue.',
  'Ensure the device is powered off before removing the battery cover.',
  'This section intentionally left blank.',
  'Refunds are processed within 5–10 business days of approval.',
  'Установите приложение и войдите в свою учетную запись.',
  '請在使用前仔細閱讀本說明書。',
  '製品の仕様は予告なく変更されることがあります。',
  'Mesures de sécurité : portez des gants et des lunettes de protection.',
  'El usuario acepta las condiciones al hacer clic en “Continuar”.',
  'Uptime SLA of 99.95% measured monthly, excluding scheduled maintenance.',
  'Warning: contents may be hot. Handle with care.',
  'Enter your 6-digit verification code to continue.',
  'A load-bearing wall shall not be modified without engineering approval.',
  'Añada 250 ml de agua y mezcle hasta obtener una masa homogénea.',
  'The API returns HTTP 429 when the rate limit of 100 req/min is exceeded.',
  'Congratulations! You have unlocked the "Explorer" achievement 🎉.',
  'Storage temperature: −20 °C to +60 °C (−4 °F to +140 °F).',
  'By signing below, the lessee acknowledges receipt of the premises.',
  'Use the <b>bold</b> toggle to emphasize key phrases.',
  'Net weight: 454 g (16 oz). Packaged in a facility that handles nuts.',
  'Backup completed successfully at 02:00 UTC; 1,284 files archived.',
  'Die maximale Zuladung beträgt 750 kg einschließlich Fahrer.',
  'Third-party integrations require an Enterprise plan subscription.',
  'Rinse thoroughly with lukewarm water for at least 15 minutes.',
  'Session expired — please sign in again to continue where you left off.',
] as const

const pick = (rng: () => number, n: number): string[] => {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(SENTENCES[Math.floor(rng() * SENTENCES.length)])
  return out
}
const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const LANG_PAIRS = [
  ['en-US', 'fr-FR'], ['en-US', 'de-DE'], ['en-GB', 'es-ES'], ['en-US', 'ja-JP'],
  ['fr-FR', 'en-US'], ['de-DE', 'it-IT'], ['en-US', 'zh-CN'], ['es-ES', 'pt-BR'],
] as const

type Gen = { ext: string; count: number; make: (rng: () => number, i: number) => Promise<Uint8Array | string> | Uint8Array | string }

// ─── per-format generators ──────────────────────────────────────────────────
const eol = (rng: () => number): string => (rng() < 0.3 ? '\r\n' : '\n')
const maybeBom = (rng: () => number): string => (rng() < 0.2 ? '﻿' : '')

const genXliff12 = (rng: () => number, i: number): string => {
  const [src, tgt] = LANG_PAIRS[Math.floor(rng() * LANG_PAIRS.length)]
  const nFiles = rng() < 0.2 ? 2 : 1
  const files: string[] = []
  let unitId = 0
  for (let f = 0; f < nFiles; f++) {
    const n = 3 + Math.floor(rng() * 10)
    const units: string[] = []
    for (let u = 0; u < n; u++) {
      unitId++
      const s = pick(rng, 1)[0]
      const r = rng()
      let sourceXml = xml(s)
      if (r < 0.25) sourceXml = `<g id="g${unitId}">${xml(s)}</g>` // inline g tag
      else if (r < 0.4) sourceXml = `${xml(s.slice(0, 10))}<x id="x${unitId}"/>${xml(s.slice(10))}` // placeholder
      else if (r < 0.5) sourceXml = `<bpt id="b${unitId}">&lt;b&gt;</bpt>${xml(s)}<ept id="b${unitId}">&lt;/b&gt;</ept>`
      const hasTarget = rng() < 0.6
      const state = hasTarget ? (rng() < 0.5 ? 'translated' : 'final') : 'new'
      const targetXml = hasTarget ? sourceXml : ''
      const note = rng() < 0.4 ? `<note>ctx-${unitId}</note>` : ''
      units.push(
        `      <trans-unit id="u${unitId}"${rng() < 0.2 ? ' xml:space="preserve"' : ''}>\n        <source>${sourceXml}</source>\n        <target state="${state}">${targetXml}</target>\n${note ? `        ${note}\n` : ''}      </trans-unit>`,
      )
    }
    files.push(
      `  <file source-language="${src}" target-language="${tgt}" datatype="plaintext" original="doc${f}.txt">\n    <body>\n${units.join('\n')}\n    </body>\n  </file>`,
    )
  }
  return `${maybeBom(rng)}<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n${files.join('\n')}\n</xliff>\n`
}

const genXliff20 = (rng: () => number, i: number): string => {
  const [src, tgt] = LANG_PAIRS[Math.floor(rng() * LANG_PAIRS.length)]
  const n = 3 + Math.floor(rng() * 8)
  const units: string[] = []
  for (let u = 0; u < n; u++) {
    const multi = rng() < 0.3 ? 2 : 1
    const segs: string[] = []
    for (let sIdx = 0; sIdx < multi; sIdx++) {
      const s = pick(rng, 1)[0]
      const r = rng()
      let sourceXml = xml(s)
      if (r < 0.25) sourceXml = `<pc id="pc${u}-${sIdx}">${xml(s)}</pc>`
      else if (r < 0.35) sourceXml = `${xml(s.slice(0, 8))}<ph id="ph${u}-${sIdx}"/>${xml(s.slice(8))}`
      const hasTarget = rng() < 0.6
      const state = hasTarget ? (rng() < 0.5 ? 'translated' : 'final') : 'initial'
      segs.push(
        `      <segment id="s${u}-${sIdx}" state="${state}">\n        <source>${sourceXml}</source>\n${hasTarget ? `        <target>${sourceXml}</target>\n` : ''}      </segment>`,
      )
      if (multi > 1 && sIdx === 0) segs.push(`      <ignorable><source> </source></ignorable>`)
    }
    units.push(`    <unit id="u${u + 1}">\n${segs.join('\n')}\n    </unit>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${src}" trgLang="${tgt}">\n  <file id="f1">\n${units.join('\n')}\n  </file>\n</xliff>\n`
}

const genTmx = (rng: () => number, i: number): string => {
  const [src, tgt] = LANG_PAIRS[Math.floor(rng() * LANG_PAIRS.length)]
  const n = 4 + Math.floor(rng() * 12)
  const tus: string[] = []
  for (let u = 0; u < n; u++) {
    const s = pick(rng, 1)[0]
    const t = pick(rng, 1)[0]
    const segS = rng() < 0.15 ? `<![CDATA[${s}]]>` : xml(s)
    const segT = rng() < 0.3 ? `${xml(t.slice(0, 12))}<ph x="1">{0}</ph>${xml(t.slice(12))}` : xml(t)
    const prop = rng() < 0.3 ? `<prop type="x-domain">legal</prop>` : ''
    const note = rng() < 0.2 ? `<note>reviewed</note>` : ''
    tus.push(
      `<tu tuid="tu-${i}-${u}">${prop}${note}<tuv xml:lang="${src}"><seg>${segS}</seg></tuv><tuv xml:lang="${tgt}"><seg>${segT}</seg></tuv></tu>`,
    )
  }
  return `${maybeBom(rng)}<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tmx SYSTEM "tmx14.dtd">\n<tmx version="1.4">\n<header creationtool="corpus-gen" creationtoolversion="1.0" segtype="sentence" o-tmf="none" adminlang="en-US" srclang="${src}" datatype="plaintext"/>\n<body>\n${tus.join('\n')}\n</body>\n</tmx>\n`
}

const genTxt = (rng: () => number): string => {
  const nl = eol(rng)
  const n = 3 + Math.floor(rng() * 10)
  const paras = pick(rng, n).map((s) => (rng() < 0.3 ? `${s} ${pick(rng, 1)[0]}` : s))
  return maybeBom(rng) + paras.join(nl + nl) + (rng() < 0.5 ? nl : '')
}

const csvQuote = (v: string): string => (/[",\n\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const genCsv = (rng: () => number, i: number): string => {
  const n = 4 + Math.floor(rng() * 10)
  const header = rng() < 0.5
  const threeCol = rng() < 0.4
  const rows: string[] = []
  if (header) rows.push(threeCol ? 'id,source,target' : 'source,target')
  for (let r = 0; r < n; r++) {
    let s = pick(rng, 1)[0]
    const t = rng() < 0.6 ? pick(rng, 1)[0] : ''
    if (rng() < 0.2) s = `${s}, with "quoted" clause`
    if (rng() < 0.1) s = `${s}\nsecond line`
    rows.push(threeCol ? [`row-${i}-${r}`, csvQuote(s), csvQuote(t)].join(',') : [csvQuote(s), csvQuote(t)].join(','))
  }
  return maybeBom(rng) + rows.join('\n') + '\n'
}

const genTsv = (rng: () => number, i: number): string => {
  const n = 4 + Math.floor(rng() * 10)
  const rows: string[] = []
  if (rng() < 0.5) rows.push('source\ttarget')
  for (let r = 0; r < n; r++) {
    const s = pick(rng, 1)[0].replace(/\t/g, ' ')
    const t = rng() < 0.6 ? pick(rng, 1)[0].replace(/\t/g, ' ') : ''
    rows.push(`${s}\t${t}`)
  }
  return rows.join('\n') + '\n'
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
const srtTime = (ms: number): string =>
  `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
const vttTime = (ms: number): string => srtTime(ms).replace(',', '.')

const genSrt = (rng: () => number): string => {
  const n = 4 + Math.floor(rng() * 12)
  let t = Math.floor(rng() * 5000)
  const cues: string[] = []
  for (let c = 0; c < n; c++) {
    const dur = 1200 + Math.floor(rng() * 4000)
    const lines = rng() < 0.3 ? pick(rng, 2) : pick(rng, 1)
    const text = rng() < 0.15 ? `<i>${lines.join('\n')}</i>` : lines.join('\n')
    cues.push(`${c + 1}\n${srtTime(t)} --> ${srtTime(t + dur)}\n${text}`)
    t += dur + Math.floor(rng() * 2000)
  }
  return cues.join('\n\n') + '\n'
}

const genVtt = (rng: () => number): string => {
  const n = 4 + Math.floor(rng() * 12)
  let t = Math.floor(rng() * 5000)
  const cues: string[] = []
  if (rng() < 0.3) cues.push('NOTE\nGenerated corpus file\n')
  for (let c = 0; c < n; c++) {
    const dur = 1200 + Math.floor(rng() * 4000)
    const line = pick(rng, 1)[0]
    const voiced = rng() < 0.4 ? `<v Speaker ${1 + Math.floor(rng() * 3)}>${line}</v>` : line
    const settings = rng() < 0.2 ? ' align:start position:10%' : ''
    const id = rng() < 0.25 ? `cue-${c + 1}\n` : ''
    cues.push(`${id}${vttTime(t)} --> ${vttTime(t + dur)}${settings}\n${voiced}`)
    t += dur + Math.floor(rng() * 2000)
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

const genSbv = (rng: () => number): string => {
  const n = 4 + Math.floor(rng() * 10)
  let t = Math.floor(rng() * 5000)
  const cues: string[] = []
  for (let c = 0; c < n; c++) {
    const dur = 1200 + Math.floor(rng() * 4000)
    const fmt = (ms: number): string =>
      `${Math.floor(ms / 3600000)}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
    cues.push(`${fmt(t)},${fmt(t + dur)}\n${pick(rng, 1)[0]}`)
    t += dur + Math.floor(rng() * 1500)
  }
  return cues.join('\n\n') + '\n'
}

const genMd = (rng: () => number): string => {
  const blocks: string[] = []
  const n = 4 + Math.floor(rng() * 8)
  for (let b = 0; b < n; b++) {
    const r = rng()
    if (r < 0.2) blocks.push(`${'#'.repeat(1 + Math.floor(rng() * 3))} ${pick(rng, 1)[0]}`)
    else if (r < 0.35) blocks.push(pick(rng, 2).map((s) => `- ${s}`).join('\n'))
    else if (r < 0.45) blocks.push(`> ${pick(rng, 1)[0]}`)
    else if (r < 0.55) blocks.push(`Some **bold** and *italic* text: ${pick(rng, 1)[0]}`)
    else blocks.push(pick(rng, 1)[0])
  }
  return blocks.join('\n\n') + '\n'
}

const genHtml = (rng: () => number): string => {
  const n = 3 + Math.floor(rng() * 8)
  const body: string[] = []
  body.push(`<h1>${xml(pick(rng, 1)[0])}</h1>`)
  for (let b = 0; b < n; b++) {
    const r = rng()
    if (r < 0.2) body.push(`<h2>${xml(pick(rng, 1)[0])}</h2>`)
    else if (r < 0.4) body.push(`<p>${xml(pick(rng, 1)[0])} <strong>${xml(pick(rng, 1)[0])}</strong></p>`)
    else if (r < 0.55) body.push(`<ul>\n<li>${xml(pick(rng, 1)[0])}</li>\n<li><a href="https://example.com?a=1&amp;b=2">${xml(pick(rng, 1)[0])}</a></li>\n</ul>`)
    else body.push(`<p>${xml(pick(rng, 1)[0])}</p>`)
  }
  if (rng() < 0.3) body.push(`<script>var x = 1 < 2 && "no translate";</script>`)
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${xml(pick(rng, 1)[0])}</title>\n<style>p { color: #333; }</style>\n</head>\n<body>\n${body.join('\n')}\n</body>\n</html>\n`
}

const genJson = (rng: () => number, i: number): string => {
  const obj: Record<string, unknown> = {
    app: { title: pick(rng, 1)[0], subtitle: pick(rng, 1)[0] },
    buttons: { save: 'Save', cancel: 'Cancel', delete: pick(rng, 1)[0] },
    messages: pick(rng, 2 + Math.floor(rng() * 3)),
    meta: { version: 3, active: true, ratio: 0.5, nothing: null },
    ['weird "key" with quotes']: pick(rng, 1)[0],
  }
  if (rng() < 0.4) (obj as Record<string, unknown>)['nested'] = { deep: { deeper: { value: pick(rng, 1)[0] } } }
  return JSON.stringify(obj, null, rng() < 0.5 ? 2 : 4) + '\n'
}

const genPo = (rng: () => number, i: number): string => {
  const n = 4 + Math.floor(rng() * 8)
  const entries: string[] = [
    `msgid ""\nmsgstr ""\n"Project-Id-Version: corpus ${i}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"`,
  ]
  for (let e = 0; e < n; e++) {
    const s = pick(rng, 1)[0].replace(/"/g, '\\"')
    const t = rng() < 0.6 ? pick(rng, 1)[0].replace(/"/g, '\\"') : ''
    const comment = rng() < 0.4 ? `#. developer note ${e}\n#: src/app.ts:${10 + e}\n` : ''
    if (rng() < 0.15) {
      entries.push(
        `${comment}msgid "${s}"\nmsgid_plural "${s} (plural)"\nmsgstr[0] "${t}"\nmsgstr[1] "${t}"`,
      )
    } else {
      entries.push(`${comment}msgid "${s}"\nmsgstr "${t}"`)
    }
  }
  return entries.join('\n\n') + '\n'
}

const genProperties = (rng: () => number): string => {
  const n = 5 + Math.floor(rng() * 8)
  const lines: string[] = ['# generated corpus properties', '! alternate comment style']
  for (let e = 0; e < n; e++) {
    const key = `app.section${Math.floor(rng() * 5)}.key${e}`
    let v = pick(rng, 1)[0]
    if (rng() < 0.2) v = v.replace(/:/g, '\\:')
    if (rng() < 0.15) v = `${v} with unicode \\u00e9`
    lines.push(`${key}${rng() < 0.3 ? ' = ' : '='}${v}`)
  }
  return lines.join('\n') + '\n'
}

const buildDocx = async (rng: () => number): Promise<Uint8Array> => {
  const n = 4 + Math.floor(rng() * 10)
  const paras: string[] = []
  for (let p = 0; p < n; p++) {
    const r = rng()
    if (r < 0.2) {
      paras.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${1 + Math.floor(rng() * 2)}"/></w:pPr><w:r><w:t>${xml(pick(rng, 1)[0])}</w:t></w:r></w:p>`,
      )
    } else if (r < 0.4) {
      paras.push(
        `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xml(pick(rng, 1)[0])} </w:t></w:r><w:r><w:t>${xml(pick(rng, 1)[0])}</w:t></w:r></w:p>`,
      )
    } else {
      paras.push(`<w:p><w:r><w:t>${xml(pick(rng, 1)[0])}</w:t></w:r></w:p>`)
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file('word/document.xml', doc)
  return zip.generateAsync({ type: 'uint8array' })
}

const buildPptx = async (rng: () => number): Promise<Uint8Array> => {
  const nSlides = 2 + Math.floor(rng() * 3)
  const zip = new JSZip()
  const overrides: string[] = []
  const rels: string[] = []
  for (let s = 1; s <= nSlides; s++) {
    const nShapes = 1 + Math.floor(rng() * 3)
    const shapes: string[] = []
    for (let sh = 0; sh < nShapes; sh++) {
      const nP = 1 + Math.floor(rng() * 2)
      const ps = Array.from({ length: nP }, () => `<a:p><a:r><a:t>${xml(pick(rng, 1)[0])}</a:t></a:r></a:p>`).join('')
      shapes.push(`<p:sp><p:txBody>${ps}</p:txBody></p:sp>`)
    }
    zip.file(
      `ppt/slides/slide${s}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`,
    )
    overrides.push(
      `<Override PartName="/ppt/slides/slide${s}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    rels.push(
      `<Relationship Id="rId${s}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${s}.xml"/>`,
    )
  }
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides.join('')}</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const buildXlsx = async (rng: () => number): Promise<Uint8Array> => {
  const n = 4 + Math.floor(rng() * 8)
  const shared: string[] = []
  const rows: string[] = []
  for (let r = 0; r < n; r++) {
    const s = pick(rng, 1)[0]
    const t = rng() < 0.5 ? pick(rng, 1)[0] : ''
    const inline = rng() < 0.3
    let c1: string
    if (inline) {
      c1 = `<c r="A${r + 1}" t="inlineStr"><is><t>${xml(s)}</t></is></c>`
    } else {
      shared.push(`<si><t>${xml(s)}</t></si>`)
      c1 = `<c r="A${r + 1}" t="s"><v>${shared.length - 1}</v></c>`
    }
    let c2 = ''
    if (t) {
      shared.push(`<si><t>${xml(t)}</t></si>`)
      c2 = `<c r="B${r + 1}" t="s"><v>${shared.length - 1}</v></c>`
    }
    rows.push(`<row r="${r + 1}">${c1}${c2}<c r="C${r + 1}"><v>${Math.floor(rng() * 1000)}</v></c></row>`)
  }
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  )
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.join('')}</sst>`,
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
  )
  return zip.generateAsync({ type: 'uint8array' })
}

// ─── plan ───────────────────────────────────────────────────────────────────
const PLAN: Record<string, Gen> = {
  xliff12: { ext: 'xlf', count: 20, make: (r, i) => genXliff12(r, i) },
  xliff20: { ext: 'xlf', count: 16, make: (r, i) => genXliff20(r, i) },
  tmx: { ext: 'tmx', count: 16, make: (r, i) => genTmx(r, i) },
  txt: { ext: 'txt', count: 12, make: (r) => genTxt(r) },
  csv: { ext: 'csv', count: 12, make: (r, i) => genCsv(r, i) },
  tsv: { ext: 'tsv', count: 10, make: (r, i) => genTsv(r, i) },
  srt: { ext: 'srt', count: 12, make: (r) => genSrt(r) },
  vtt: { ext: 'vtt', count: 12, make: (r) => genVtt(r) },
  sbv: { ext: 'sbv', count: 8, make: (r) => genSbv(r) },
  md: { ext: 'md', count: 12, make: (r) => genMd(r) },
  html: { ext: 'html', count: 12, make: (r) => genHtml(r) },
  json: { ext: 'json', count: 12, make: (r, i) => genJson(r, i) },
  po: { ext: 'po', count: 10, make: (r, i) => genPo(r, i) },
  properties: { ext: 'properties', count: 8, make: (r) => genProperties(r) },
  docx: { ext: 'docx', count: 14, make: (r) => buildDocx(r) },
  pptx: { ext: 'pptx', count: 10, make: (r) => buildPptx(r) },
  xlsx: { ext: 'xlsx', count: 8, make: (r) => buildXlsx(r) },
}

// ─── main ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const refreshIdx = args.indexOf('--refresh')

async function generateAll(): Promise<void> {
  if (existsSync(filesDir)) {
    console.error('corpus already exists — refusing to overwrite (use --refresh N for holdout refresh)')
    process.exit(1)
  }
  const manifest: { file: string; format: string }[] = []
  const split: { seed: number; dev: string[]; holdout: string[] } = { seed: SEED, dev: [], holdout: [] }
  for (const [format, gen] of Object.entries(PLAN)) {
    const rng = mulberry32(SEED ^ hashCode(format))
    mkdirSync(join(filesDir, format), { recursive: true })
    const names: string[] = []
    for (let i = 0; i < gen.count; i++) {
      const name = `${format}/${format}-${String(i + 1).padStart(3, '0')}.${gen.ext}`
      const content = await gen.make(rng, i)
      writeFileSync(join(filesDir, name), content)
      manifest.push({ file: name, format })
      names.push(name)
    }
    // seeded shuffle → first 60% dev, rest holdout (split fixed BEFORE inspection)
    const shuffled = seededShuffle(names, mulberry32(SEED ^ hashCode(format + ':split')))
    const nDev = Math.round(names.length * 0.6)
    split.dev.push(...shuffled.slice(0, nDev))
    split.holdout.push(...shuffled.slice(nDev))
  }
  split.dev.sort()
  split.holdout.sort()
  writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(here, 'split.json'), JSON.stringify(split, null, 2) + '\n')
  console.log(`generated ${manifest.length} files across ${Object.keys(PLAN).length} formats`)
  console.log(`split: ${split.dev.length} dev / ${split.holdout.length} holdout (seed ${SEED})`)
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h >>> 0
}

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function refreshHoldout(pct: number, cycle: number): Promise<void> {
  const split = JSON.parse(readFileSync(join(here, 'split.json'), 'utf8')) as {
    seed: number
    dev: string[]
    holdout: string[]
  }
  const refreshSeed = SEED ^ 0x5f5f5f5f ^ cycle
  const shuffled = seededShuffle(split.holdout, mulberry32(refreshSeed))
  const nRefresh = Math.max(1, Math.floor(split.holdout.length * (pct / 100)))
  const targets = shuffled.slice(0, nRefresh)
  for (const name of targets) {
    const format = name.split('/')[0]
    const gen = PLAN[format]
    if (!gen) continue
    const idx = Number(name.match(/-(\d+)\./)?.[1] ?? 0)
    const rng = mulberry32(refreshSeed ^ hashCode(name))
    const content = await gen.make(rng, idx + 1000 * cycle)
    rmSync(join(filesDir, name), { force: true })
    writeFileSync(join(filesDir, name), content)
  }
  console.log(`refreshed ${targets.length} holdout files (cycle ${cycle}, seed ${refreshSeed})`)
}

if (refreshIdx >= 0) {
  const pct = Number(args[refreshIdx + 1] ?? 10)
  const cycleIdx = args.indexOf('--cycle')
  const cycle = Number(args[cycleIdx + 1] ?? 1)
  await refreshHoldout(pct, cycle)
} else {
  await generateAll()
}
