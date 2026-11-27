// Holds each row of external/agent-app-parity.ts to the code it describes.
//
// The tables are only worth having if a row cannot go stale quietly. The type
// system forces a row to EXIST for every file type and event kind; these tests
// force the row to be TRUE: a `covered` row names a door that is really open,
// and nothing the route can do is written down as a gap.
import { describe, expect, it } from 'vitest'
import { COMMAND_CATALOG } from '../../../db/shared/command-catalog'
import { FORMAT_DESCRIPTORS } from '../../../src/lib/formats/descriptors'
import { REQUIRED_ROLE } from '../events/role-policy'
import {
  EVENT_PARITY,
  IMPORT_FORMAT_PARITY,
  OAUTH_COMMAND_PARITY,
  rowsWithStatus,
} from '../external/agent-app-parity'
import { ALLOWED_EMIT_KINDS } from '../external/commands-emit-events'
import {
  CLIENT_ONLY_FORMATS,
  FILE_TYPE_OVERRIDE_HINT,
  SERVER_PARSEABLE_FILE_TYPES,
} from '../external/import-parse-formats'
import { CHATGPT_COMMAND_KINDS, CHATGPT_TOOLS } from '../external/mcp-chatgpt-tools'
import { MCP_TOOLS } from '../external/mcp-tools'

const keys = (rows: [string, unknown][]) => rows.map(([key]) => key).sort()
const agentReachable = COMMAND_CATALOG.filter((c) => c.agentReachable).map((c) => c.kind)

describe('import formats: the Import dialog vs the parse route', () => {
  it('lists as covered exactly the formats the route parses', () => {
    // Either direction is a lie an agent repeats to a user: "covered" for a
    // format the route refuses, or a gap for one it parses (the docx report).
    expect(keys(rowsWithStatus(IMPORT_FORMAT_PARITY, 'covered'))).toEqual(
      [...SERVER_PARSEABLE_FILE_TYPES].sort(),
    )
  })

  it('names every upload-format gap in the list the route refuses with', () => {
    // CLIENT_ONLY_FORMATS is what turns "unsupported fileType" into "import it
    // through the app instead". A gap missing from it gets the unhelpful error.
    const uploadFormats = new Set(FORMAT_DESCRIPTORS.map((d) => d.id).concat(['xlsx', 'epub', 'tmx']))
    for (const [format] of rowsWithStatus(IMPORT_FORMAT_PARITY, 'gap')) {
      if (!uploadFormats.has(format)) continue
      expect(CLIENT_ONLY_FORMATS, `${format} is a gap the route does not name`).toContain(format)
    }
  })

  it('offers every parseable format in the fileType hint agents read', () => {
    // The regression itself: the hint was hand-written and omitted docx.
    for (const format of SERVER_PARSEABLE_FILE_TYPES) {
      expect(FILE_TYPE_OVERRIDE_HINT).toContain(format)
    }
    for (const name of ['preview_import', 'prepare_import']) {
      for (const tools of [MCP_TOOLS, CHATGPT_TOOLS]) {
        const tool = tools.find((t) => t.name === name)!
        const fileType = tool.inputSchema.properties.fileType as { description: string }
        expect(fileType.description, name).toBe(FILE_TYPE_OVERRIDE_HINT)
      }
    }
  })
})

describe('event kinds: what the event log accepts vs what an agent can stage', () => {
  it('has a row for every kind the log accepts', () => {
    // The Record type says this too; this is the copy vitest can see.
    expect(Object.keys(EVENT_PARITY).sort()).toEqual(Object.keys(REQUIRED_ROLE).sort())
  })

  it('marks a kind as EmitEvents exactly when the allowlist carries it', () => {
    // file.rename is on the allowlist and also has its own command; either
    // door makes it covered, so only the allowlist direction is strict.
    for (const kind of ALLOWED_EMIT_KINDS) {
      expect(EVENT_PARITY[kind as keyof typeof EVENT_PARITY]?.status, kind).toBe('covered')
    }
    for (const [kind, row] of rowsWithStatus(EVENT_PARITY, 'covered')) {
      if (row.via !== 'EmitEvents') continue
      expect(ALLOWED_EMIT_KINDS, `${kind} claims EmitEvents`).toContain(kind)
    }
  })

  it('names an agent-reachable command for every covered kind', () => {
    for (const [kind, row] of rowsWithStatus(EVENT_PARITY, 'covered')) {
      expect(agentReachable, `${kind} is covered via ${row.via}`).toContain(row.via)
    }
  })
})

describe('commands: the catalog vs the tools an OAuth connection gets', () => {
  it('has a row for every agent-reachable command, and no others', () => {
    // A command added to the catalog reaches personal tokens through the
    // generic door at once. This is where someone decides about OAuth.
    expect(Object.keys(OAUTH_COMMAND_PARITY).sort()).toEqual([...agentReachable].sort())
  })

  it('names a declared OAuth tool for every covered command', () => {
    const names = CHATGPT_TOOLS.map((t) => t.name)
    for (const [kind, row] of rowsWithStatus(OAUTH_COMMAND_PARITY, 'covered')) {
      expect(names, `${kind} is covered via ${row.via}`).toContain(row.via)
    }
  })

  it('lets confirm_changeset through for every command a declared tool stages', () => {
    // The OAuth confirm gate keeps its own list of reviewed kinds. A tool that
    // stages a kind missing from it produces a changeset the same connection
    // can never confirm.
    expect([...CHATGPT_COMMAND_KINDS].sort()).toEqual(
      keys(rowsWithStatus(OAUTH_COMMAND_PARITY, 'covered')),
    )
  })
})
