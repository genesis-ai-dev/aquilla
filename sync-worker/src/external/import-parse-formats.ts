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
  // xlsx and epub: the Import dialog takes both (src/lib/import.ts parseFile);
  // they were missing here, so the route called them "unsupported" instead of
  // naming the in-app alternative. agent-app-parity.ts holds the two lists
  // together now.
  'xlsx',
  'epub',
  'paratext-project',
  'zip',
]

export const CLIENT_ONLY_HINT =
  'this format is not yet server-parseable — import it through the in-app Import dialog ' +
  '(which runs the full parser set in the browser), or parse it yourself and stage raw ' +
  'PlanImport cells via POST .../changesets'

/** Caller-supplied fileType spellings → canonical parse types. */
export const FILE_TYPE_ALIASES: Readonly<Record<string, ServerParseFileType>> = {
  sfm: 'usfm',
  markdown: 'md',
  plaintext: 'txt',
  text: 'txt',
  word: 'docx',
}

/**
 * The prose forms of the tables above, for tool descriptions and the discovery
 * document. They are BUILT from the tables because the hand-written copies
 * drifted: when docx became server-parseable the `fileType` hint on
 * preview_import / prepare_import kept its old list, and on a connection whose
 * get_capabilities carried no format list that hint was the only statement an
 * agent could read — so it told a user Aquilla cannot import .docx.
 */
export const SERVER_PARSEABLE_PROSE = SERVER_PARSEABLE_FILE_TYPES.join(', ')
export const CLIENT_ONLY_PROSE = CLIENT_ONLY_FORMATS.join(', ')
export const FILE_TYPE_OVERRIDE_HINT =
  `Override format detection: ${SERVER_PARSEABLE_FILE_TYPES.join('|')} ` +
  `(${Object.keys(FILE_TYPE_ALIASES).join(', ')} accepted as aliases).`
