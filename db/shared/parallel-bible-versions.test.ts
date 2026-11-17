import { describe, expect, it } from 'vitest'
import { parallelBibleVersionsProblem } from './parallel-bible-versions'

// A stored id becomes one path segment of a URL every project member's browser
// fetches, so the write refuses anything that would name a different resource.
describe('parallelBibleVersionsProblem', () => {
  it('accepts real helloao ids', () => {
    expect(parallelBibleVersionsProblem(['grc_sbl', 'hbo_wlc', 'BSB', 'eng-kjv2006', 'spa.rv1909'])).toBeNull()
  })

  it.each([
    ['../../other/path', 'traversal'],
    ['BSB/../x', 'separator'],
    ['BSB\\x', 'backslash'],
    ['BSB?x=1', 'query'],
    ['BSB#frag', 'fragment'],
    ['%2e%2e%2fx', 'percent escape'],
    ['BSB KJV', 'space'],
    ['BSB\n', 'control character'],
    ['..', 'dot segment'],
    ['.', 'dot segment'],
  ])('refuses %j (%s)', (id) => {
    expect(parallelBibleVersionsProblem(['BSB', id])).toMatch(/cannot contain/)
  })
})
