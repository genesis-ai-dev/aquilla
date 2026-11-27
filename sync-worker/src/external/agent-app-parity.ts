// What the app can do, and whether an agent can do it too — as data.
//
// Why: docs/decisions/0020-agent-app-parity-tables.md.
//
// A user asked an agent to import .docx files and was told Aquilla cannot. The
// server could; one hand-written list had not been updated. That is the cheap
// version of a wider problem: the app grows (a file type, an event kind, a
// command) and nothing asks whether the Agent API and its MCP tools grew with
// it. The answer is discovered months later, by a user.
//
// The three tables below are keyed by the app's OWN vocabulary, so the question
// is asked when the vocabulary changes:
//
//   IMPORT_FORMAT_PARITY   Record<FileType, …>   every file type the Import
//                                                dialog parses
//   EVENT_PARITY           Record<EventKind, …>  every write the event log
//                                                accepts
//   OAUTH_COMMAND_PARITY   every agent-reachable command in the catalog, against
//                          the fixed tool list an OAuth connection gets
//
// The first two are exhaustive records: a new `FileType` or `EventKind` is a
// type error in this file until it has a row, and `npm run type-check` is part
// of the Workers build. `__tests__/agent-app-parity.test.ts` holds every row to
// the code it describes — a `covered` row must name a real door, a format the
// route parses cannot be listed as a gap, and so on.
//
// A row is one of three answers:
//
//   covered   an agent can do this; `via` names the command or tool
//   gap       the app can, an agent cannot YET. Unbuilt, not refused. This is
//             the backlog, and adding a `gap` row is a decision someone made in
//             review rather than an omission nobody saw
//   excluded  not a thing an agent should do: the server emits it itself, or a
//             human must (those are also in ui-only.ts, which promises "never")
//
// What this file does NOT see: features that are not event-sourced and are not
// file imports — the auth-worker `/api/v2/*` routes (living memory writes,
// source linking, billing, org admin). They have no single vocabulary to key a
// table by; `uiOnly` and the command catalog are the only statements about them.

import type { FileType } from '../../../src/lib/parsers/types'
import type { EventKind } from '../events/types'

export type Parity =
  | { status: 'covered'; via: string }
  | { status: 'gap'; note: string }
  | { status: 'excluded'; why: string }

const covered = (via: string): Parity => ({ status: 'covered', via })
const gap = (note: string): Parity => ({ status: 'gap', note })
const excluded = (why: string): Parity => ({ status: 'excluded', why })

// ── Imports ──────────────────────────────────────────────────────────

const PARSED = covered('prepare_import')
const DOM_BOUND = gap('the parser cannot run in a Worker yet (DOMParser); docx got there by moving onto xml-lite (AQU-1237)')
const CATALOG = gap('imported from a remote catalog by the app; no agent command starts one')

/** Every file type `parseFile` (src/lib/import.ts) switches on. */
export const IMPORT_FORMAT_PARITY: Record<FileType, Parity> = {
  txt: PARSED,
  md: PARSED,
  json: PARSED,
  po: PARSED,
  properties: PARSED,
  obs: PARSED,
  vtt: PARSED,
  srt: PARSED,
  sbv: PARSED,
  csv: PARSED,
  tsv: PARSED,
  usfm: PARSED,
  docx: PARSED,
  pptx: DOM_BOUND,
  idml: DOM_BOUND,
  xlsx: gap('imports through spreadsheet column mapping in the app; no agent equivalent'),
  html: DOM_BOUND,
  epub: DOM_BOUND,
  xliff: DOM_BOUND,
  tmx: DOM_BOUND,
  ebible: CATALOG,
  helloao: CATALOG,
  sdbh: CATALOG,
  custom: gap('prepared by the AI-assisted recipe service in the app'),
  audio: gap('LinkMedia attaches audio to an existing cell; nothing creates a media FILE the way dropping one on the Import dialog does'),
  video: gap('same as audio: no agent command creates a media file'),
  codex: excluded('a server-side file kind (migrated Codex notebooks), never an upload format'),
  source: excluded('a server-side file kind (the role fallback), never an upload format'),
}

// ── Event log writes ─────────────────────────────────────────────────

const EMIT = covered('EmitEvents')
const SERVER_EMITTED = (by: string): Parity => excluded(`server-emitted by ${by}; no client writes it`)
const AUDIO_EDIT = gap('take editing has no agent command; LinkMedia only attaches and selects')

/** Every kind the event log accepts (sync-worker/src/events/types.ts). */
export const EVENT_PARITY: Record<EventKind, Parity> = {
  'source.cell.create': covered('PlanImport'),
  'source.cell.commit': covered('SetSource'),
  'source.cell.delete': covered('DeleteCell'),
  'source.cell.reorder': covered('InsertCell'),
  'source.cell.metadata.patch': SERVER_EMITTED('the import-envelope backfill'),
  'source.cell.reanchor': SERVER_EMITTED('migration reconciliation'),
  'source.cell.visibility.set': covered('HideCell'),
  'source.cell.restore': excluded('undoing a removal is refused on the external API by authorize.ts (AQU-1767)'),

  'target.cell.create': gap('no agent command adds a target-only cell'),
  'target.cell.commit': covered('SetTranslation'),
  'target.cell.delete': covered('DeleteCell'),
  'target.cell.reorder': gap('no agent command reorders target cells'),

  'cell.validate': EMIT,
  'cell.unvalidate': EMIT,
  'cell.waive': EMIT,
  'cell.unwaive': EMIT,

  'cell.audio.attach': covered('LinkMedia'),
  'cell.audio.select': covered('LinkMedia'),
  'cell.audio.remove': AUDIO_EDIT,
  'cell.audio.rename': AUDIO_EDIT,
  'cell.audio.trim': AUDIO_EDIT,
  'cell.audio.gain': AUDIO_EDIT,
  'cell.audio.even': AUDIO_EDIT,
  'cell.audio.place': AUDIO_EDIT,
  'cell.audio.cut': AUDIO_EDIT,
  'cell.audio.uncut': AUDIO_EDIT,
  'cell.audio.measure': SERVER_EMITTED('the duration backfill'),
  'cell.audio.validate': gap('text validation is on EmitEvents; audio validation is not'),
  'cell.audio.unvalidate': gap('text validation is on EmitEvents; audio validation is not'),

  'cell.attachment.add': gap('no agent command attaches a reference file to a cell'),
  'cell.attachment.remove': gap('no agent command removes a cell attachment'),
  'cell.link.set': gap('no agent command pairs a subtitle line with an audio cue'),

  'file.create': covered('PlanImport'),
  'file.rename': covered('RenameFile'),
  'file.corpus.set': gap('no agent command moves a file between sidebar folders'),
  'file.extension.set': gap('written by Smart Extensions; no agent command'),
  'file.reorder': gap('no agent command sets a file\'s sidebar position'),
  'file.delete': EMIT,
  'file.restore': EMIT,
  'file.revision': SERVER_EMITTED('the revisions route'),

  'comment.create': EMIT,
  'comment.edit': EMIT,
  'comment.delete': EMIT,
  'comment.resolve': EMIT,

  'term.create': EMIT,
  'term.update': EMIT,
  'term.delete': EMIT,
  'term.approve': EMIT,
  'term.reject': EMIT,

  'cell.backtranslation.set': EMIT,
  'cell.gloss.set': gap('no agent command corrects a gloss'),

  'assignment.create': EMIT,
  'assignment.reassign': EMIT,
  'assignment.unassign': EMIT,

  'project.link-source': SERVER_EMITTED('auth-worker when a source link is made or cleared'),
  'cast.assign': gap('no agent command assigns a cast name'),
  'cell.label.set': gap('no agent command sets a cell label'),
  'cell.retime': covered('SetTiming'),
  'cell.lane.retime': gap('SetTiming retimes the cell for every lane; nothing retimes one lane'),
  'file.video.set': gap('no agent command sets a file\'s video'),
  'file.timing.set': covered('SetTiming'),
  'file.track.set': covered('SetTrackOverride'),
  'file.milestone.set': gap('no agent command sets a milestone'),
  'file.milestone.remove': gap('no agent command removes a milestone'),

  'source.cell.mirror': SERVER_EMITTED('the link mirror engine'),
  'file.mirror': SERVER_EMITTED('the link mirror engine'),
  'link.cursor.advance': SERVER_EMITTED('the link mirror engine'),
  'target.cell.repin': EMIT,
}

// ── The OAuth tool list ──────────────────────────────────────────────

const NO_OAUTH_TOOL = gap('reachable with a personal token through the generic `commands` argument; no declared tool on OAuth connections')
const ORG_ADMIN = gap('org administration has no declared tool on OAuth connections')

/**
 * Every agent-reachable command in db/shared/command-catalog.ts, against the
 * tools an OAuth connection (claude.ai, ChatGPT) is given. Those connections
 * have no generic `commands` door — each write is its own reviewed tool
 * (mcp-chatgpt-tools.ts) — so a command added to the catalog reaches personal
 * tokens at once and OAuth users never, unless someone declares a tool for it.
 */
export const OAUTH_COMMAND_PARITY: Record<string, Parity> = {
  SetTranslation: covered('prepare_translations'),
  PlanImport: covered('prepare_import'),
  PatchSettings: covered('patch_settings'),
  SetBrief: covered('prepare_set_brief'),
  RegenerateBriefSummary: covered('regenerate_brief_summary'),
  PatchOrthographyExceptions: covered('prepare_orthography_exceptions'),
  CreateProject: covered('prepare_create_project'),
  UpdateProjectSettings: covered('prepare_replace_project_settings'),
  LinkMedia: covered('prepare_link_media'),
  DraftCells: covered('prepare_draft_cells'),
  InsertCell: covered('prepare_insert_cell'),
  DeleteCell: covered('prepare_delete_cell'),
  SplitCell: covered('prepare_split_cell'),
  HideCell: covered('prepare_hide_cells'),
  ShowCell: covered('prepare_show_cells'),
  InviteMember: covered('prepare_invite_member'),
  SetRole: covered('prepare_set_role'),
  RemoveMember: covered('prepare_remove_member'),

  EmitEvents: gap('comments, validation, waivers, terminology, assignments and file delete/restore all ride this one command, so none of them has a tool on OAuth connections'),
  ProjectSetup: NO_OAUTH_TOOL,
  SetSource: NO_OAUTH_TOOL,
  SetTranscription: NO_OAUTH_TOOL,
  SetTiming: NO_OAUTH_TOOL,
  SetTrackOverride: NO_OAUTH_TOOL,
  RenameFile: NO_OAUTH_TOOL,
  RenameProject: NO_OAUTH_TOOL,
  ArchiveProject: NO_OAUTH_TOOL,
  UnarchiveProject: NO_OAUTH_TOOL,
  AddExample: NO_OAUTH_TOOL,
  AddDecision: NO_OAUTH_TOOL,
  AddNote: NO_OAUTH_TOOL,
  RetireExample: NO_OAUTH_TOOL,
  ReviewStyleRules: NO_OAUTH_TOOL,
  AddOrgMember: ORG_ADMIN,
  SetOrgRole: ORG_ADMIN,
  RemoveOrgMember: ORG_ADMIN,
  CreateOrg: ORG_ADMIN,
}

/** The rows of one table with a given answer, as `[key, row]` pairs. */
export function rowsWithStatus<K extends string, S extends Parity['status']>(
  table: Record<K, Parity>,
  status: S,
): [K, Extract<Parity, { status: S }>][] {
  return (Object.entries(table) as [K, Parity][]).filter(
    (entry): entry is [K, Extract<Parity, { status: S }>] => entry[1].status === status,
  )
}
