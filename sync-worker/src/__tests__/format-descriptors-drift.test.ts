// The server half of "one registry" (AQU-2384).
//
// `src/lib/formats/descriptors.ts` declares, as data, where each format's
// parse can run. The Agent API import route keeps its own two tables of the
// same fact (`SERVER_PARSEABLE_FILE_TYPES` and `CLIENT_ONLY_FORMATS`), because
// it has to answer with them in an error body and in the discovery document.
//
// Two statements of one fact drift. When they do, the failure is not a type
// error: the route either throws "DOMParser is not defined" deep inside a
// parser on a format it thought it could handle, or refuses a format it could
// have parsed and tells the caller to use the browser instead. This test is
// the only thing that holds them together, and it lives on the server side
// because these are the server's tables: a change to them should fail the
// suite of the worker that publishes them.
import { describe, expect, it } from 'vitest'
import {
  FORMAT_DESCRIPTORS,
  descriptorById,
} from '../../../src/lib/formats/descriptors'
import {
  BINARY_PARSE_FILE_TYPES,
  CLIENT_ONLY_FORMATS,
  SERVER_PARSEABLE_FILE_TYPES,
} from '../external/import-parse-formats'

describe('format descriptors vs the server parse tables', () => {
  it('declares every universally-parseable format as server-parseable', () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      if (descriptor.runtime.parse !== 'universal') continue
      expect(
        SERVER_PARSEABLE_FILE_TYPES.includes(descriptor.id),
        `${descriptor.id} declares runtime.parse "universal" but the route cannot parse it`,
      ).toBe(true)
    }
  })

  it('declares every DOM-bound format client-only', () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      if (descriptor.runtime.parse !== 'dom') continue
      expect(
        CLIENT_ONLY_FORMATS.includes(descriptor.id),
        `${descriptor.id} needs DOMParser to parse but the route offers to parse it server-side`,
      ).toBe(true)
    }
  })

  it('never lists one format as both', () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      const both =
        SERVER_PARSEABLE_FILE_TYPES.includes(descriptor.id)
        && CLIENT_ONLY_FORMATS.includes(descriptor.id)
      expect(both, `${descriptor.id} is in both server-parseable and client-only`).toBe(false)
    }
  })

  it('agrees that docx is the one binary format the server parses', () => {
    // The whole reason the descriptor splits parse from build: AQU-1237 moved
    // the DOCX walk off DOMParser, the DOCX *build* still needs it.
    expect([...BINARY_PARSE_FILE_TYPES]).toEqual(['docx'])
    expect(descriptorById('docx')?.runtime).toEqual({ parse: 'universal', build: 'dom' })
  })
})
