/**
 * One-off alignment for cell 1924 in
 * "Atos a Apocalipse - Atualizado (repaired)".
 *
 * The repaired note kept the Portuguese wording, but Align styles dropped the
 * bold keywords into the wrong runs (and left "Paulo" / "presbíteros da igreja"
 * in the plain tail). This writes one target commit that puts each keyword and
 * scripture reference back in the run the English source uses.
 *
 * The English slot order is Paul, then church elders, then 1 Timothy 5:20.
 * The finished Portuguese had the reference first ("Em 1 Timóteo 5.20, Paulo
 * ensinou..."). Slot order is the published order, so that one clause is
 * turned around to "Paulo ensinou sobre corrigir presbíteros da igreja em
 * 1 Timóteo 5.20." Every other word stays where it was.
 *
 * Usage:
 *   node scripts/align-atos-cell-1924.mjs           # print the plan
 *   node scripts/align-atos-cell-1924.mjs --apply   # write the commit
 */

import { randomUUID } from "node:crypto"
import pg from "pg"
import { validateIdmlTranslation } from "@aquilla/idml-roundtrip"

const PROJECT = "81c2c777-eb82-5256-9f62-842f26118aa7"
const FILE = "01a15429-6af7-7475-85a0-04303464f6af"
const CELL = "Stories/Story_u452.xml#/idPkg:Story[1]/Story[1]/ParagraphStyleRange[2176]:part-0"
const APPLY = process.argv.includes("--apply")

const TIMOTHY_BEFORE = "Em 1 Timóteo 5.20, Paulo ensinou sobre corrigir presbíteros da igreja. "
const TIMOTHY_AFTER = "Paulo ensinou sobre corrigir presbíteros da igreja em 1 Timóteo 5.20. "

const client = new pg.Client({
  connectionString: "postgresql://aquilla:aquilla@127.0.0.1:5432/aquilla_dev",
})
await client.connect()

await alignCell()

async function alignCell() {
try {
  const source = await one(
    `SELECT value_html, metadata, event_id
     FROM cells
     WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [PROJECT, FILE, CELL],
  )
  const target = await one(
    `SELECT value, value_html, event_id, source_event_id, lane_id, ai_drafted, word_count, validated
     FROM cells
     WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
    [PROJECT, FILE, CELL],
  )
  const metadata = source.metadata?.idml
  if (!metadata || metadata.version !== 2) throw new Error("Cell is missing IDML v2 metadata")

  const alignedValue = retimedTimothy(target.value)
  const slots = placeSlots(alignedValue)
  const valueHtml = writeSlots(target.value_html, slots)
  const validation = validateIdmlTranslation(source.value_html, valueHtml, metadata)
  if (!validation.valid) {
    throw new Error(`Aligned HTML is not a valid IDML cell: ${JSON.stringify(validation.diagnostics)}`)
  }
  const joined = validation.slots.join("")
  if (joined !== alignedValue) {
    throw new Error(`Joined slots do not match the aligned text.\n joined: ${joined}\n wanted: ${alignedValue}`)
  }

  console.log(diffWords(target.value, alignedValue))
  console.log("\nSlots:")
  for (const slot of readSlotLabels(source.value_html)) {
    const text = slots[slot.index] ?? ""
    if (!text && !slot.style.includes("k_xt") && !slot.style.includes("/xt") && !slot.style.endsWith("/bd")) continue
    console.log(`${String(slot.index).padStart(2, " ")}  ${styleName(slot.style).padEnd(16, " ")}  ${JSON.stringify(text)}`)
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write the commit.")
    process.exitCode = 0
    return
  }
  if (target.value === alignedValue && target.value_html === valueHtml) {
    console.log("\nAlready aligned. Nothing written.")
    return
  }

  const eventId = randomUUID()
  const now = Date.now()
  const wordCount = countWords(alignedValue)
  const hash = contentHash(alignedValue)
  const payload = {
    value: alignedValue,
    valueHtml,
    targetLang: "",
    laneId: target.lane_id,
    sourceEventId: target.source_event_id,
  }

  await client.query("BEGIN")
  const seq = await client.query(
    `INSERT INTO project_seq_counters (project_id, last_seq)
     VALUES ($1, COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = $1), 0) + 1)
     ON CONFLICT (project_id) DO UPDATE SET
       last_seq = GREATEST(
         project_seq_counters.last_seq + 1,
         COALESCE((SELECT MAX(server_seq) FROM events WHERE project_id = $1), 0) + 1
       )
     RETURNING last_seq`,
    [PROJECT],
  )
  const serverSeq = Number(seq.rows[0].last_seq)
  const sample = await client.query(
    `SELECT schema_version FROM events WHERE project_id = $1 ORDER BY server_seq DESC LIMIT 1`,
    [PROJECT],
  )
  const schemaVersion = sample.rows[0]?.schema_version ?? 2
  await client.query(
    `INSERT INTO events (
       id, schema_version, project_id, file_id, cell_id, parent_id, kind,
       author, payload, client_ts, server_ts, server_seq
     ) VALUES ($1, $2, $3, $4, $5, $6, 'target.cell.commit', $7, $8, $9, $9, $10)`,
    [
      eventId,
      schemaVersion,
      PROJECT,
      FILE,
      CELL,
      target.event_id,
      "manual-align",
      JSON.stringify(payload),
      now,
      serverSeq,
    ],
  )
  await client.query(
    `UPDATE cells SET
       value = $1,
       value_html = $2,
       event_id = $3,
       last_editor = $4,
       last_edit_at = $5,
       validated = 0,
       endorsement_count = 0,
       word_count = $6,
       content_hash = $7,
       ai_drafted = 0,
       ai_draft = NULL
     WHERE project_id = $8 AND file_id = $9 AND cell_id = $10 AND side = 'target' AND lane_id = $11`,
    [alignedValue, valueHtml, eventId, "manual-align", now, wordCount, hash, PROJECT, FILE, CELL, target.lane_id],
  )
  if (target.ai_drafted === 1) {
    await client.query(
      `UPDATE files SET ai_drafted_count = GREATEST(ai_drafted_count - 1, 0), last_edit_at = $1, updated_at = $1
       WHERE project_id = $2 AND id = $3`,
      [now, PROJECT, FILE],
    )
  }
  const wordDelta = wordCount - Number(target.word_count)
  if (wordDelta !== 0) {
    await client.query(
      `UPDATE files SET word_count = word_count + $1 WHERE project_id = $2 AND id = $3`,
      [wordDelta, PROJECT, FILE],
    )
  }
  await client.query("COMMIT")
  console.log(`\nWrote target.cell.commit ${eventId} (server_seq ${serverSeq}). Reload the file to see cell 1924.`)
} catch (error) {
  await client.query("ROLLBACK").catch(() => {})
  throw error
} finally {
  await client.end()
}
}

function retimedTimothy(value) {
  if (value.includes(TIMOTHY_AFTER) && !value.includes(TIMOTHY_BEFORE)) return value
  const at = value.indexOf(TIMOTHY_BEFORE)
  if (at < 0) {
    throw new Error("The Timothy sentence is not the text this script knows. Refusing to rewrite it.")
  }
  return value.slice(0, at) + TIMOTHY_AFTER + value.slice(at + TIMOTHY_BEFORE.length)
}

function placeSlots(value) {
  const state = { rest: value, slots: Array.from({ length: 34 }, () => "") }
  const take = (index, text) => {
    if (!state.rest.startsWith(text)) {
      throw new Error(
        `Slot ${index} expected ${JSON.stringify(text)} but the text continues ${JSON.stringify(state.rest.slice(0, 90))}`,
      )
    }
    state.slots[index] = text
    state.rest = state.rest.slice(text.length)
  }
  take(0, "1.1–15")
  take(1, " ")
  take(2, "João")
  take(3, " chamou a si mesmo de ancião. Talvez estivesse falando da própria idade ou de ser um ")
  take(4, "presbítero da igreja")
  take(5, ". Estava cheio de alegria porque a vida")
  take(6, "")
  take(7, " ")
  take(8, "espiritual")
  take(9, " do seu amigo Gaio ia bem. Isso queria dizer que Gaio seguia ")
  take(10, "Jesus")
  take(11, " fielmente. Em ")
  take(12, "1 João 3.18")
  take(13, ", João escreveu sobre ")
  take(14, "crentes")
  take(15, " que praticam a ")
  take(16, "fé")
  take(17, " e o amor. Gaio fez isso ao receber e ajudar crentes que estavam viajando. Assim, apoiava quem anunciava as ")
  take(18, "boas-novas")
  take(19, " sobre Jesus. Isso era muito diferente do que fazia um homem chamado Diótrefes. Diótrefes dominava os outros na ")
  take(20, "igreja")
  take(21, ". Isso ia contra as instruções de ")
  take(22, "Pedro")
  take(23, "")
  take(24, "")
  take(25, " para os líderes da igreja em ")
  take(26, "1 Pedro 5.3")
  take(27, ". Diótrefes contava mentiras sobre João. João planejava falar com Diótrefes sobre o que ele fazia de errado. ")
  take(28, "Paulo")
  take(29, " ensinou sobre corrigir ")
  take(30, "presbíteros da igreja")
  take(31, " em ")
  take(32, "1 Timóteo 5.20")
  if (!state.rest.startsWith(". O plano de João")) {
    throw new Error(`Closing run does not start as expected: ${JSON.stringify(state.rest.slice(0, 90))}`)
  }
  take(33, state.rest)
  return state.slots
}

function writeSlots(html, slots) {
  return html.replace(
    /(<span\b[^>]*\bdata-idml-slot="(\d+)"[^>]*>)([\s\S]*?)(<\/span>)/g,
    (match, open, index, _inner, close) => {
      const slot = Number(index)
      if (!Number.isInteger(slot) || slots[slot] === undefined) return match
      return `${open}${escapeHtml(slots[slot])}${close}`
    },
  )
}

function readSlotLabels(html) {
  const labels = []
  const pattern = /<span\b[^>]*\bdata-idml-slot="(\d+)"[^>]*\bdata-idml-character-style="([^"]+)"[^>]*>/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    labels.push({ index: Number(match[1]), style: match[2] })
  }
  return labels
}

function styleName(style) {
  const slash = style.lastIndexOf("/")
  return slash >= 0 ? decodeURIComponent(style.slice(slash + 1)) : style
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function countWords(text) {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function contentHash(text) {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function diffWords(before, after) {
  if (before === after) return "Wording unchanged."
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  return [
    "Wording change:",
    `  - ${JSON.stringify(before.slice(start, endBefore))}`,
    `  + ${JSON.stringify(after.slice(start, endAfter))}`,
  ].join("\n")
}

async function one(sql, params) {
  const result = await client.query(sql, params)
  if (result.rows.length !== 1) throw new Error(`Expected one row, got ${result.rows.length}`)
  return result.rows[0]
}
