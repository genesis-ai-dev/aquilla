import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : typescriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('postgres.js JSON bind contract', () => {
  it('casts serialized placeholders through text before jsonb', () => {
    const offenders = typescriptFiles(SRC).flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split('\n')
      return lines.flatMap((line, index) =>
        /\?::jsonb\b/.test(line)
          ? [`${relative(SRC, path)}:${index + 1}`]
          : [],
      )
    })

    // postgres.js sees a direct ?::jsonb parameter as JSON-typed and encodes
    // an already-serialized string again. The projection then stores a JSON
    // string instead of an object. ?::text::jsonb keeps both postgres.js and
    // PGlite on the same representation.
    expect(offenders).toEqual([])
  })
})
