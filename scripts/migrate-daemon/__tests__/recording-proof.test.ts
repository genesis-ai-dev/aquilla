import { expect, it } from 'vitest'
import { collectAllCellAudio } from '../../../src/lib/migrate/audio'
import type { CodexCell } from '../../../src/lib/codex-editor/types'
import { recordingMetadata, revalidateRecordingProofs } from '../recording-proof'

it('revalidates unchanged recordings across notebook edits, failing closed for changed or ambiguous evidence', async () => {
  const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40)
  const cell = { kind: 2, languageId: 'html', value: 'before', metadata: { id: 'cell', type: 'text' as const, attachments: {
    take: { type: 'audio', url: '.project/attachments/files/take.webm', createdBy: 'author', createdAt: 123,
      mimeType: 'audio/webm', metadata: { durationSec: 2, sizeBytes: 456 }, isMissing: true },
  } } }
  const take = collectAllCellAudio(cell as CodexCell)[0]
  const proof = { projectId: 1, sha: oldSha, file: 'GEN.codex', cellId: 'cell', take, audioMetadata: recordingMetadata(cell as CodexCell, take), oid: 'c'.repeat(64), size: 456 }
  const cases: [string, (c: typeof cell) => void, boolean][] = [
    ['unrelated text', c => { c.value = 'after' }, true],
    ['missing marker cleared', c => { c.metadata.attachments.take.isMissing = false }, true],
    ['different author', c => { c.metadata.attachments.take.createdBy = 'other' }, false],
    ['different timestamp', c => { c.metadata.attachments.take.createdAt++ }, false],
    ['different duration', c => { c.metadata.attachments.take.metadata.durationSec++ }, false],
    ['different size', c => { c.metadata.attachments.take.metadata.sizeBytes++ }, false],
    ['different mime', c => { c.metadata.attachments.take.mimeType = 'audio/wav' }, false],
    ['different path', c => { c.metadata.attachments.take.url = 'other/take.webm' }, false],
    ['moved cell', c => { c.metadata.id = 'other' }, false],
    ['deleted', c => { Object.assign(c.metadata.attachments.take, { isDeleted: true }) }, false],
  ]
  const notebook = (cells: unknown[]) => Buffer.from(JSON.stringify({ metadata: {}, cells }))
  for (const [name, change, accepted] of cases) {
    const current = structuredClone(cell); change(current)
    const read = async (sha: string) => notebook([sha === oldSha ? cell : current])
    const result = await revalidateRecordingProofs([proof], 1, newSha, read)
    expect(result, name).toEqual(accepted ? [{ ...proof, sha: newSha }] : [])
  }
  for (const [name, old, current] of [
    ['duplicate current', [cell], [cell, cell]], ['duplicate old', [cell, cell], [cell]],
    ['missing old', null, [cell]], ['removed current', [cell], []],
  ] as const) {
    const result = await revalidateRecordingProofs([proof], 1, newSha, async sha => {
      const cells = sha === oldSha ? old : current
      return cells === null ? null : notebook([...cells])
    })
    expect(result, name).toEqual([])
  }
  expect(await revalidateRecordingProofs([proof], 2, newSha, async () => { throw Error('wrong project read') })).toEqual([])
  await expect(revalidateRecordingProofs([{ ...proof, file: '../GEN.codex' }], 1, newSha, async () => notebook([cell]))).rejects.toThrow('Invalid recording evidence')
})
