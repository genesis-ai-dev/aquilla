import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { hydrateYDocFromEvents } from '../events/hydrate'
import { makeInMemoryD1, type EventRow } from './helpers/d1-fake'

function evt(overrides: Partial<EventRow>): EventRow {
  return {
    id: overrides.id ?? 'ev',
    schema_version: overrides.schema_version ?? 1,
    project_id: overrides.project_id ?? 'p',
    file_id: overrides.file_id ?? 'f',
    cell_id: overrides.cell_id ?? null,
    kind: overrides.kind ?? 'cell.commit',
    author: overrides.author ?? 'alice',
    payload: overrides.payload ?? '{}',
    client_ts: overrides.client_ts ?? 1000,
    server_ts: overrides.server_ts ?? 1000,
  }
}

function commitPayload(value: string, meta?: object) {
  return JSON.stringify(meta ? { value, meta } : { value })
}

describe('hydrateYDocFromEvents', () => {
  it('returns 0 when no events exist for the file', async () => {
    const db = makeInMemoryD1({ events: [] })
    const doc = new Y.Doc()
    const result = await hydrateYDocFromEvents(db, 'p', 'f', doc)
    expect(result).toEqual({ cellCount: 0, eventsRead: 0, cellCommitsApplied: 0 })
    expect(doc.getMap('cells').size).toBe(0)
  })

  it('seeds cells, order, and translatedXml from cell.commit events', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, payload: commitPayload('hello') }),
        evt({ id: 'e2', cell_id: 'c2', server_ts: 200, payload: commitPayload('world') }),
      ],
    })
    const doc = new Y.Doc()
    const result = await hydrateYDocFromEvents(db, 'p', 'f', doc)

    expect(result.cellCount).toBe(2)
    expect(result.cellCommitsApplied).toBe(2)

    const cells = doc.getMap('cells')
    const order = doc.getArray<string>('order')
    expect(order.toArray()).toEqual(['c1', 'c2'])

    const c1 = cells.get('c1') as Y.Map<unknown>
    expect(c1.get('id')).toBe('c1')
    const frag1 = c1.get('translatedXml') as Y.XmlFragment
    expect(extract(frag1)).toBe('hello')

    const c2 = cells.get('c2') as Y.Map<unknown>
    expect(extract(c2.get('translatedXml') as Y.XmlFragment)).toBe('world')
  })

  it('applies seed metadata from the first cell.commit and not subsequent ones', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({
          id: 'e1',
          cell_id: 'c1',
          server_ts: 100,
          payload: commitPayload('first', {
            original: 'hola',
            originalHtml: '<b>hola</b>',
            context: 'greeting',
            group: 'ch1',
            type: 'text',
            sourceLocation: { startTime: 1.5, endTime: 2.0 },
            globalReferences: ['LUK 1:1'],
            cellLabel: 'Narrator',
          }),
        }),
        // Second commit without meta — should NOT clobber the seed fields.
        evt({
          id: 'e2',
          cell_id: 'c1',
          server_ts: 200,
          payload: commitPayload('second'),
        }),
        // Third commit WITH meta — also should NOT overwrite (defends against
        // misbehaving client; first-write wins for seed metadata).
        evt({
          id: 'e3',
          cell_id: 'c1',
          server_ts: 300,
          payload: commitPayload('third', {
            original: 'OVERWRITE',
            cellLabel: 'NEW LABEL',
          }),
        }),
      ],
    })
    const doc = new Y.Doc()
    await hydrateYDocFromEvents(db, 'p', 'f', doc)

    const c1 = doc.getMap('cells').get('c1') as Y.Map<unknown>
    expect(c1.get('original')).toBe('hola')
    expect(c1.get('originalHtml')).toBe('<b>hola</b>')
    expect(c1.get('context')).toBe('greeting')
    expect(c1.get('group')).toBe('ch1')
    expect(c1.get('type')).toBe('text')
    expect(c1.get('sourceLocation')).toEqual({ startTime: 1.5, endTime: 2.0 })
    expect(c1.get('globalReferences')).toEqual(['LUK 1:1'])
    // cellLabel lives under __source.metadata for editor compatibility.
    expect(c1.get('__source')).toEqual({
      metadata: { id: 'c1', cellLabel: 'Narrator' },
    })

    // Latest value wins for translatedXml.
    expect(extract(c1.get('translatedXml') as Y.XmlFragment)).toBe('third')
  })

  it('does not duplicate a cell in `order` across multiple commits', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, payload: commitPayload('v1') }),
        evt({ id: 'e2', cell_id: 'c1', server_ts: 200, payload: commitPayload('v2') }),
        evt({ id: 'e3', cell_id: 'c1', server_ts: 300, payload: commitPayload('v3') }),
      ],
    })
    const doc = new Y.Doc()
    await hydrateYDocFromEvents(db, 'p', 'f', doc)

    expect(doc.getArray<string>('order').toArray()).toEqual(['c1'])
    expect(doc.getMap('cells').size).toBe(1)
    const c1 = doc.getMap('cells').get('c1') as Y.Map<unknown>
    expect(extract(c1.get('translatedXml') as Y.XmlFragment)).toBe('v3')
  })

  it('orders cells by server_ts ASC even when input rows arrive out-of-order', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, payload: commitPayload('a') }),
        evt({ id: 'e2', cell_id: 'c2', server_ts: 200, payload: commitPayload('b') }),
        evt({ id: 'e3', cell_id: 'c3', server_ts: 150, payload: commitPayload('c') }),
      ],
    })
    const doc = new Y.Doc()
    await hydrateYDocFromEvents(db, 'p', 'f', doc)

    // The d1-fake helper preserves insertion order for SELECT * patterns,
    // but our hydrate query is ORDER BY server_ts ASC. Match that contract.
    expect(doc.getArray<string>('order').toArray()).toEqual(['c1', 'c3', 'c2'])
  })

  it('skips cell.validate / cell.unvalidate / thread events during hydration', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, kind: 'cell.commit', payload: commitPayload('v') }),
        evt({ id: 'e2', cell_id: 'c1', server_ts: 110, kind: 'cell.validate', payload: '{"editEventId":"e1"}' }),
        evt({ id: 'e3', cell_id: 'c1', server_ts: 120, kind: 'cell.unvalidate', payload: '{"editEventId":"e1"}' }),
      ],
    })
    const doc = new Y.Doc()
    const result = await hydrateYDocFromEvents(db, 'p', 'f', doc)

    expect(result.eventsRead).toBe(3)
    expect(result.cellCommitsApplied).toBe(1)
    const c1 = doc.getMap('cells').get('c1') as Y.Map<unknown>
    // Validation state is NOT mirrored into the Y.Doc — that lives in
    // cell_validators (D1) and the UI reads it from there post-Phase 4a.
    expect(c1.get('validatedBy')).toBeUndefined()
  })

  it('handles empty cell values without throwing', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, payload: commitPayload('') }),
      ],
    })
    const doc = new Y.Doc()
    const result = await hydrateYDocFromEvents(db, 'p', 'f', doc)
    expect(result.cellCommitsApplied).toBe(1)
    const c1 = doc.getMap('cells').get('c1') as Y.Map<unknown>
    expect(extract(c1.get('translatedXml') as Y.XmlFragment)).toBe('')
  })

  it('ignores events with malformed JSON payloads but still hydrates valid ones', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', cell_id: 'c1', server_ts: 100, payload: 'not-json' }),
        evt({ id: 'e2', cell_id: 'c2', server_ts: 200, payload: commitPayload('ok') }),
      ],
    })
    const doc = new Y.Doc()
    const result = await hydrateYDocFromEvents(db, 'p', 'f', doc)
    expect(result.cellCommitsApplied).toBe(1)
    expect(doc.getMap('cells').get('c1')).toBeUndefined()
    const c2 = doc.getMap('cells').get('c2') as Y.Map<unknown>
    expect(extract(c2.get('translatedXml') as Y.XmlFragment)).toBe('ok')
  })

  it('only reads events for the requested file', async () => {
    const db = makeInMemoryD1({
      events: [
        evt({ id: 'e1', file_id: 'f1', cell_id: 'c1', server_ts: 100, payload: commitPayload('f1') }),
        evt({ id: 'e2', file_id: 'f2', cell_id: 'c2', server_ts: 200, payload: commitPayload('f2') }),
      ],
    })
    const doc = new Y.Doc()
    await hydrateYDocFromEvents(db, 'p', 'f1', doc)
    expect(doc.getMap('cells').size).toBe(1)
    expect(doc.getMap('cells').get('c2')).toBeUndefined()
  })
})

function extract(frag: Y.XmlFragment): string {
  const parts: string[] = []
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i)
    if (node instanceof Y.XmlText) {
      parts.push(node.toString())
    } else if (node instanceof Y.XmlElement) {
      for (let j = 0; j < node.length; j++) {
        const child = node.get(j)
        if (child instanceof Y.XmlText) parts.push(child.toString())
      }
    }
  }
  return parts.join('')
}
