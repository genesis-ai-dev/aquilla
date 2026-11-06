// Which formats the server can parse — pure data, no Worker runtime (AQU-2384).
//
// Lifted out of import-parse-core.ts so these tables can be read without
// pulling in the parse ROUTE's module graph, which reaches `cloudflare:`
// imports and therefore cannot be loaded outside a Worker. They were already
// "kept as data so the error and the capability docs can never drift"; being
// importable from a plain test is the same intent carried one step further —
// `src/lib/formats/descriptors.ts` states the same fact for the SPA and the
// parse Web Worker, and `__tests__/format-descriptors-drift.test.ts` is what
// holds the two statements together.
//
// import-parse-core.ts re-exports every name here, so existing importers are
// unaffected.

import {
  TEXT_PARSE_FILE_TYPES,
  type TextParseFileType,
} from '../../../src/lib/parsers/parse-text-formats'

/** Formats parsed from BYTES rather than decoded text — zip containers whose
 *  parser reads members itself. Routed around the text-parse core. */
export const BINARY_PARSE_FILE_TYPES: ReadonlySet<string> = new Set<string>(['docx'])

/** The union the parse route accepts. */
export type ServerParseFileType = TextParseFileType | 'docx'

/** Formats the server can parse (published by discovery + get_capabilities). */
export const SERVER_PARSEABLE_FILE_TYPES: readonly string[] = [
  ...TEXT_PARSE_FILE_TYPES,
  ...BINARY_PARSE_FILE_TYPES,
].sort()

/** Detected formats we recognize but cannot parse in the worker (DOM-bound
 *  parsers, binary containers, or multi-member packages). Kept as data so the
 *  error and the capability docs can never drift. */
export const CLIENT_ONLY_FORMATS: readonly string[] = [
  'pptx',
  'doc',
  'html',
  'xliff',
  'tmx',
  'usx',
  'idml',
  'paratext-project',
  'zip',
]

export const CLIENT_ONLY_HINT =
  'this format is not yet server-parseable — import it through the in-app Import dialog ' +
  '(which runs the full parser set in the browser), or parse it yourself and stage raw ' +
  'PlanImport cells via POST .../changesets'
