#!/usr/bin/env node
// One-shot snapshot rebuilder for aquilla-sync-worker R2 snapshots.
//
// Why: a Yjs doc that accumulated tens of thousands of per-cell edits/history
// entries can encode to >10 MiB. The Cloudflare DO that hosts it ends up
// OOMing at runtime (live in-memory representation is several × the encoded
// size). The web client and sync-worker now cap per-cell edits/history at
// EDITS_CAP_PER_CELL/HISTORY_CAP_PER_CELL (100 each), but those caps don't
// retroactively shrink an existing bloated snapshot — Y.Array.delete leaves
// tombstones in the encoded form. To produce a small snapshot we need to
// rebuild a *fresh* Y.Doc from the visible state and re-encode that.
//
// This script does that work locally in Node where the 128 MiB DO limit
// doesn't apply. Pull the bloated snapshot from R2, run this, push back.
//
// Usage:
//   wrangler r2 object get codex-snapshots/projects/{P}/files/{F}/snapshot.bin --file old.bin
//   node scripts/rebuild-snapshot.mjs old.bin new.bin
//   wrangler r2 object put codex-snapshots/projects/{P}/files/{F}/snapshot.bin --file new.bin
//
// You should also delete the file's tail/ prefix in R2 after the upload —
// tails reference the old doc's clientID/clock space and won't merge cleanly
// against the rebuilt snapshot. The DELETE /admin/files/{P}/{F} endpoint
// nukes the whole prefix; that's too aggressive. Easier to delete each tail
// key individually via `wrangler r2 object delete`.
//
// Caveats — read before running on a file with active editors:
//   1. Any client edits NOT yet flushed to R2 (still buffered in their
//      local Y.Doc waiting to send) will be dropped. Tell editors to wait
//      for a "synced" status before you run this.
//   2. translatedXml rich-text marks (bold/italic/etc.) are preserved
//      structurally by walking Y.XmlElement/Y.XmlText. Other custom Y
//      types (nested Y.Maps in `__source`, comment threads) are flattened
//      via toJSON() and re-set as plain data — they keep their values but
//      lose CRDT merge ability for any future concurrent writes.
//   3. The output snapshot has a fresh Y clientID. Clients that connect
//      next will diff against it as if it were a brand-new doc and merge
//      their local IndexedDB state on top — their edits flow normally.

import * as Y from "yjs"
import { readFileSync, writeFileSync, statSync } from "node:fs"

const EDITS_CAP_PER_CELL = 100
const HISTORY_CAP_PER_CELL = 100

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) {
  console.error("usage: rebuild-snapshot.mjs <input-snapshot.bin> <output-snapshot.bin>")
  process.exit(1)
}

const inBytes = readFileSync(inPath)
console.log(`[rebuild] loaded ${inPath} (${inBytes.byteLength} bytes)`)

const oldDoc = new Y.Doc()
Y.applyUpdate(oldDoc, new Uint8Array(inBytes))

const oldMeta = oldDoc.getMap("meta")
const oldCells = oldDoc.getMap("cells")
const oldOrder = oldDoc.getArray("order")

const newDoc = new Y.Doc()
const newMeta = newDoc.getMap("meta")
const newCells = newDoc.getMap("cells")
const newOrder = newDoc.getArray("order")

let cellCount = 0
let editsTotalBefore = 0
let editsTotalAfter = 0
let historyTotalBefore = 0
let historyTotalAfter = 0

newDoc.transact(() => {
  oldMeta.forEach((v, k) => {
    if (v instanceof Y.AbstractType) {
      newMeta.set(k, v.toJSON())
    } else {
      newMeta.set(k, v)
    }
  })

  for (const id of oldOrder.toArray()) newOrder.push([id])

  oldCells.forEach((oldCell, id) => {
    cellCount++
    const newCell = new Y.Map()
    newCells.set(id, newCell)
    oldCell.forEach((value, key) => {
      if (key === "translatedXml" && value instanceof Y.XmlFragment) {
        const newFrag = new Y.XmlFragment()
        newCell.set(key, newFrag)
        copyXmlFragmentInto(value, newFrag)
      } else if (key === "edits" && value instanceof Y.Array) {
        const newArr = new Y.Array()
        newCell.set(key, newArr)
        const beforeLen = value.length
        const startIdx = Math.max(0, beforeLen - EDITS_CAP_PER_CELL)
        for (let i = startIdx; i < beforeLen; i++) {
          const oldEntry = value.get(i)
          const newEntry = new Y.Map()
          newArr.push([newEntry])
          copyEditEntryInto(oldEntry, newEntry)
        }
        editsTotalBefore += beforeLen
        editsTotalAfter += newArr.length
      } else if (key === "history" && value instanceof Y.Array) {
        const newArr = new Y.Array()
        newCell.set(key, newArr)
        const beforeLen = value.length
        const items = value.toArray()
        const start = Math.max(0, items.length - HISTORY_CAP_PER_CELL)
        for (let i = start; i < items.length; i++) newArr.push([items[i]])
        historyTotalBefore += beforeLen
        historyTotalAfter += newArr.length
      } else if (value instanceof Y.AbstractType) {
        // Catch-all for other nested Y types we don't specifically handle.
        // Flatten to JSON — preserves the value, drops CRDT merge ability
        // for that field. Fine for read-only / single-writer fields like
        // __source metadata; risky for fields we'd want to merge concurrently.
        newCell.set(key, value.toJSON())
      } else {
        // Primitive — copy directly.
        newCell.set(key, value)
      }
    })
  })
})

const outBytes = Y.encodeStateAsUpdate(newDoc)
writeFileSync(outPath, outBytes)

const inSize = inBytes.byteLength
const outSize = outBytes.byteLength
const pct = ((outSize / inSize) * 100).toFixed(1)
console.log(`[rebuild] wrote ${outPath} (${outSize} bytes, ${pct}% of input)`)
console.log(`[rebuild] cells=${cellCount}`)
console.log(`[rebuild] edits   trimmed: ${editsTotalBefore} -> ${editsTotalAfter}`)
console.log(`[rebuild] history trimmed: ${historyTotalBefore} -> ${historyTotalAfter}`)

// --- helpers ---

function copyXmlFragmentInto(src, dst) {
  for (let i = 0; i < src.length; i++) {
    const node = src.get(i)
    if (node instanceof Y.XmlElement) {
      const el = new Y.XmlElement(node.nodeName)
      dst.push([el])
      copyXmlElementInto(node, el)
    } else if (node instanceof Y.XmlText) {
      const txt = new Y.XmlText()
      dst.push([txt])
      copyXmlTextInto(node, txt)
    }
  }
}

function copyXmlElementInto(src, dst) {
  // Copy attributes first.
  const attrs = src.getAttributes()
  for (const [k, v] of Object.entries(attrs)) dst.setAttribute(k, v)
  // Then children.
  for (let i = 0; i < src.length; i++) {
    const node = src.get(i)
    if (node instanceof Y.XmlElement) {
      const el = new Y.XmlElement(node.nodeName)
      dst.push([el])
      copyXmlElementInto(node, el)
    } else if (node instanceof Y.XmlText) {
      const txt = new Y.XmlText()
      dst.push([txt])
      copyXmlTextInto(node, txt)
    }
  }
}

function copyXmlTextInto(src, dst) {
  // toDelta returns [{ insert: string, attributes?: { ...marks } }, ...]
  const delta = src.toDelta()
  let pos = 0
  for (const op of delta) {
    if (typeof op.insert !== "string") continue
    dst.insert(pos, op.insert, op.attributes)
    pos += op.insert.length
  }
}

function copyEditEntryInto(src, dst) {
  src.forEach((value, key) => {
    if (key === "authors" && value instanceof Y.Array) {
      const arr = new Y.Array()
      dst.set(key, arr)
      arr.push(value.toArray())
    } else if (key === "editMap" && value instanceof Y.Array) {
      const arr = new Y.Array()
      dst.set(key, arr)
      arr.push(value.toArray())
    } else if (key === "validatedBy" && value instanceof Y.Map) {
      const validators = new Y.Map()
      dst.set(key, validators)
      value.forEach((v, username) => {
        if (v instanceof Y.Map) {
          const innerMap = new Y.Map()
          validators.set(username, innerMap)
          v.forEach((iv, ik) => innerMap.set(ik, iv))
        } else {
          validators.set(username, v)
        }
      })
    } else if (value instanceof Y.AbstractType) {
      dst.set(key, value.toJSON())
    } else {
      dst.set(key, value)
    }
  })
}

// Quiet stat to avoid uncaught error if outPath is unwritable etc.
try {
  statSync(outPath)
} catch (err) {
  console.error("[rebuild] could not stat output:", err)
  process.exit(1)
}
