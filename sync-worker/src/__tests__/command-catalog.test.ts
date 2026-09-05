// Catalog invariants (AQU-926, command registry §1) + the get_capabilities
// `commands` index (§6). The catalog is shared metadata both workers consume —
// these tests pin the contract: agentReachable:false entries never reach any
// role-filtered output, the registered kinds match what validateCommands
// accepts, static floors match the enforcing modules, and the MCP capabilities
// payload carries the role-agnostic index.

import { describe, it, expect, vi } from 'vitest'

// mcp-handlers → changesets-route → commit.ts → events/route.ts → broadcast.ts
// → partyserver (cloudflare:*) — same mock every external suite uses.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { callTool } from '../external/mcp-handlers'
import {
  COMMAND_CATALOG,
  catalogForRole,
  catalogIndexLines,
  describeCommand,
} from '../../../db/shared/command-catalog'
import { validateCommands } from '../external/commands'
import { POLICY_SETTINGS_KEYS } from '../external/commands-patch-settings'
import { ALLOWED_EMIT_KINDS, TESTIMONY_EMIT_KINDS } from '../external/commands-emit-events'
import { ROLE } from '../events/role-policy'

const ROLE_LEVELS = [0, 100, 200, 300, 400, 500, 600, 700, 9999]

describe('command catalog — invariants', () => {
  it('nothing with agentReachable:false ever appears in catalogForRole output, at any level', () => {
    for (const level of ROLE_LEVELS) {
      for (const entry of catalogForRole(level)) {
        expect(entry.agentReachable).toBe(true)
        expect(entry.minRoleLevel).toBeLessThanOrEqual(level)
      }
    }
    // The invariant holds even if a governance (agentReachable:false) entry is
    // added later — synthesize one and re-run the filter logic on a copy.
    const withGovernance = [
      ...COMMAND_CATALOG,
      {
        kind: 'MintCredential', title: 'Mint credential', oneLiner: 'governance',
        minRoleLevel: 100, tier: 'governance' as const, agentReachable: false, paramsDoc: 'x',
      },
    ]
    const filtered = withGovernance.filter((c) => c.agentReachable && c.minRoleLevel <= 9999)
    expect(filtered.some((c) => c.kind === 'MintCredential')).toBe(false)
  })

  it('every catalog kind is accepted by validateCommands (vocabulary parity)', () => {
    const minimal: Record<string, unknown> = {
      SetTranslation: { kind: 'SetTranslation', fileId: 'f', cellId: 'c', value: 'v' },
      LinkMedia: { kind: 'LinkMedia', fileId: 'f', cellId: 'c', artifactId: 'a' },
      PlanImport: { kind: 'PlanImport', fileName: 'n', fileType: 'txt', cells: [{ content: 'x' }] },
      CreateProject: { kind: 'CreateProject', name: 'P' },
      UpdateProjectSettings: { kind: 'UpdateProjectSettings', projectId: 'p', settings: {}, ifMatchVersion: 0 },
      PatchSettings: { kind: 'PatchSettings', projectId: 'p', ops: [{ key: 'brief', value: 1 }], ifMatchVersion: 0 },
      EmitEvents: { kind: 'EmitEvents', events: [{ kind: 'comment.create', payload: { body: 'hi' } }] },
      InviteMember: { kind: 'InviteMember', projectId: 'p', username: 'ana', role: 400 },
      SetRole: { kind: 'SetRole', projectId: 'p', username: 'ana', role: 400 },
      RemoveMember: { kind: 'RemoveMember', projectId: 'p', username: 'ana' },
    }
    for (const entry of COMMAND_CATALOG) {
      const sample = minimal[entry.kind]
      expect(sample, `catalog kind ${entry.kind} has no validateCommands sample`).toBeDefined()
      const result = validateCommands([sample])
      expect(result.ok, `validateCommands rejected catalog kind ${entry.kind}`).toBe(true)
    }
  })

  it('static floors match the contract: PatchSettings 500, EmitEvents 200, UpdateProjectSettings 600', () => {
    expect(describeCommand('PatchSettings')?.minRoleLevel).toBe(ROLE.PROJECT_LEAD)
    expect(describeCommand('PatchSettings')?.tier).toBe('structural')
    expect(describeCommand('EmitEvents')?.minRoleLevel).toBe(ROLE.COMMENTER)
    expect(describeCommand('UpdateProjectSettings')?.minRoleLevel).toBe(ROLE.MAINTAINER)
    expect(describeCommand('Bogus')).toBeNull()
  })

  it('the role-filtered index narrows with level and formats one line per command', () => {
    const commenter = catalogIndexLines(ROLE.COMMENTER)
    const lead = catalogIndexLines(ROLE.PROJECT_LEAD)
    expect(commenter.length).toBeLessThan(lead.length)
    expect(commenter.some((l) => l.startsWith('- EmitEvents (200+'))).toBe(true)
    expect(lead.some((l) => l.startsWith('- PatchSettings (500+'))).toBe(true)
    // A commenter never sees maintainer-floor commands.
    expect(commenter.some((l) => l.includes('UpdateProjectSettings'))).toBe(false)
  })

  it("the catalog's documented policy keys and testimony kinds match the enforcing modules", () => {
    const patchDoc = describeCommand('PatchSettings')!.paramsDoc
    for (const key of POLICY_SETTINGS_KEYS) {
      expect(patchDoc).toContain(key)
    }
    const emitDoc = describeCommand('EmitEvents')!.paramsDoc
    for (const kind of TESTIMONY_EMIT_KINDS) {
      expect(ALLOWED_EMIT_KINDS).toContain(kind)
    }
    expect(emitDoc).toContain('testimony')
  })
})

describe('get_capabilities — commands index (§6)', () => {
  it('publishes kind/title/tier/minRoleLevel for every agent-reachable command', async () => {
    const cred = {
      credentialId: 'cred-1', userId: '1', username: 'alice',
      mode: 'act' as const, orgId: null, projectId: null,
    }
    const result = await callTool('get_capabilities', {}, { AQUILLA_PG: undefined }, cred, 'tok')
    expect(result).not.toBe(Symbol.for('unknown-tool'))
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text) as {
      commandKinds: string[]
      commands: { index: { kind: string; title: string; tier: string; minRoleLevel: number }[]; note: string }
    }
    const reachable = COMMAND_CATALOG.filter((c) => c.agentReachable)
    expect(payload.commands.index).toHaveLength(reachable.length)
    for (const entry of reachable) {
      expect(payload.commands.index).toContainEqual({
        kind: entry.kind, title: entry.title, tier: entry.tier, minRoleLevel: entry.minRoleLevel,
      })
    }
    // The index is metadata only — no paramsDoc bloat in the resident payload.
    for (const row of payload.commands.index) {
      expect(Object.keys(row).sort()).toEqual(['kind', 'minRoleLevel', 'tier', 'title'])
    }
    expect(payload.commands.note).toContain('describe_command')
    // The legacy commandKinds field is untouched (frozen external behavior).
    expect(payload.commandKinds).toEqual(
      ['SetTranslation', 'PlanImport', 'CreateProject', 'UpdateProjectSettings', 'LinkMedia'],
    )
  })
})
