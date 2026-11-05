// AQU-2383: byte-level fidelity of a text export against the file that was
// imported.
//
// Every text parser in `src/lib/parsers/` normalizes before it segments: a
// leading UTF-8 byte-order mark is stripped and CRLF is folded to LF, because
// the segmenters downstream are written against `\n`. Nothing used to put
// either back, so a Windows upload came back from export as a BOM-less LF
// file even when not a single cell had been translated — the content was
// right and the bytes were wrong, which is the whole of the complaint behind
// this rule.
//
// The rule, from the decision record this issue cites: an untouched target
// exports the stored original bytes verbatim, and an EDITED target keeps the
// source's BOM and line terminator around the new text. The first half is a
// short-circuit at each export seam that holds the original bytes (see
// `fidelity.ts` for which formats hold it); this module is the second half.
//
// This file is a leaf ON PURPOSE: sync-worker's tsconfig has no `@/` paths,
// so the worker's `.txt` export route imports it by relative path and both
// sides apply one copy of the rules. Do not add imports here.

/** The line terminator a text file uses. */
export type LineEnding = "\n" | "\r\n"

/** What a source file's bytes say about its encoding envelope. */
export interface TextFidelity {
  /** The source began with a UTF-8 byte-order mark (U+FEFF). */
  bom: boolean
  /** The source's dominant line terminator. */
  eol: LineEnding
}

/** What a parser's normalized output looks like: no BOM, LF only. */
export const NORMALIZED_TEXT_FIDELITY: TextFidelity = { bom: false, eol: "\n" }

const BOM = "﻿"

/**
 * Read the encoding envelope off a source file's decoded text.
 *
 * The line terminator is decided by majority, not by first sighting: a file
 * pasted together from both conventions still has one that dominates, and
 * rewriting it to the dominant one is what every editor does. A tie — which
 * includes a file with no line breaks at all — resolves to LF, matching the
 * parsers' normalized form so a file with nothing to preserve is unchanged.
 */
export function detectTextFidelity(source: string): TextFidelity {
  const crlf = (source.match(/\r\n/g) ?? []).length
  const lf = (source.match(/\n/g) ?? []).length - crlf
  return { bom: source.startsWith(BOM), eol: crlf > lf ? "\r\n" : "\n" }
}

/**
 * Put a source's envelope back around a rebuilt export body.
 *
 * `body` is whatever an exporter built, which is LF-terminated and BOM-less by
 * construction. An empty body stays empty: a file with no exportable content
 * should be zero bytes, not a lone byte-order mark.
 */
export function applyTextFidelity(body: string, fidelity: TextFidelity): string {
  if (body === "") return ""
  // Fold first so a body that already carries CRLF (a cell whose text holds
  // one) cannot come out as CR-CR-LF.
  const normalized = body.replace(/\r\n/g, "\n")
  const withEol = fidelity.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized
  if (!fidelity.bom) return withEol.startsWith(BOM) ? withEol.slice(BOM.length) : withEol
  return withEol.startsWith(BOM) ? withEol : `${BOM}${withEol}`
}
