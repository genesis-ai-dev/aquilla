import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { htmlToFragment, plainTextToFragment } from '../events/html-to-fragment'

interface Op {
  insert: string
  attributes?: Record<string, unknown>
}

/**
 * Walk a fragment for assertions. Yjs requires types to be attached to a doc
 * before `toDelta` / `nodeName` can be read, so the helper attaches the
 * passed-in fragment to a fresh doc first when it's still detached.
 */
function ops(frag: Y.XmlFragment): Array<{ tag: string; ops?: Op[] }> {
  let target = frag
  if (!frag.doc) {
    const doc = new Y.Doc()
    const cell = new Y.Map<unknown>()
    doc.getMap('cells').set('c', cell)
    cell.set('translatedXml', frag)
    target = cell.get('translatedXml') as Y.XmlFragment
  }
  const out: Array<{ tag: string; ops?: Op[] }> = []
  for (let i = 0; i < target.length; i++) {
    const n = target.get(i)
    if (!(n instanceof Y.XmlElement)) continue
    if (n.nodeName === 'paragraph' || n.nodeName === 'p') {
      const inner: Op[] = []
      for (let j = 0; j < n.length; j++) {
        const c = n.get(j)
        if (c instanceof Y.XmlText) {
          inner.push(...((c.toDelta() as Op[]) ?? []))
        } else if (c instanceof Y.XmlElement && (c.nodeName === 'br' || c.nodeName === 'hardBreak')) {
          inner.push({ insert: '\n' })
        }
      }
      out.push({ tag: n.nodeName, ops: inner })
    } else {
      out.push({ tag: n.nodeName })
    }
  }
  return out
}

describe('htmlToFragment', () => {
  it('plain text becomes a single paragraph', () => {
    const frag = htmlToFragment('hello world')
    const out = ops(frag)
    expect(out).toHaveLength(1)
    expect(out[0].ops).toEqual([{ insert: 'hello world' }])
  })

  it('two <p> tags produce two paragraphs', () => {
    const frag = htmlToFragment('<p>one</p><p>two</p>')
    const out = ops(frag)
    expect(out).toHaveLength(2)
    expect(out[0].ops).toEqual([{ insert: 'one' }])
    expect(out[1].ops).toEqual([{ insert: 'two' }])
  })

  it('preserves bold marks for <b> and <strong>', () => {
    const frag = htmlToFragment('<p>plain <b>bold</b> and <strong>strong</strong></p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'plain ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' and ' },
      { insert: 'strong', attributes: { bold: true } },
    ])
  })

  it('preserves italic marks for <i> and <em>', () => {
    const frag = htmlToFragment('<p><i>i</i><em>em</em></p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'i', attributes: { italic: true } },
      { insert: 'em', attributes: { italic: true } },
    ])
  })

  it('preserves underline, strike, code, and combinations', () => {
    const frag = htmlToFragment('<p><u>u</u><s>s</s><strike>s2</strike><del>d</del><code>c</code></p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'u', attributes: { underline: true } },
      { insert: 's', attributes: { strike: true } },
      { insert: 's2', attributes: { strike: true } },
      { insert: 'd', attributes: { strike: true } },
      { insert: 'c', attributes: { code: true } },
    ])
  })

  it('nested marks compose', () => {
    const frag = htmlToFragment('<p><b><i>both</i></b></p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'both', attributes: { bold: true, italic: true } },
    ])
  })

  it('<br> produces a hardBreak inside the paragraph', () => {
    const frag = htmlToFragment('<p>line1<br/>line2</p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'line1' },
      { insert: '\n' },
      { insert: 'line2' },
    ])
  })

  it('decodes HTML entities', () => {
    const frag = htmlToFragment('<p>Tom&apos;s &amp; Jerry &#39;hi&#39; &lt;t&gt;</p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([{ insert: "Tom's & Jerry 'hi' <t>" }])
  })

  it('drops unknown wrapper tags but keeps their text', () => {
    const frag = htmlToFragment('<p>before<span>middle</span>after</p>')
    const out = ops(frag)
    expect(out[0].ops).toEqual([
      { insert: 'before' },
      { insert: 'middle' },
      { insert: 'after' },
    ])
  })

  it('skips comments and declarations', () => {
    const frag = htmlToFragment('<!-- ignore --><p>kept</p><!--also ignored-->')
    const out = ops(frag)
    expect(out).toHaveLength(1)
    expect(out[0].ops).toEqual([{ insert: 'kept' }])
  })

  it('empty input produces a single empty paragraph', () => {
    const out = ops(htmlToFragment(''))
    expect(out).toHaveLength(1)
    expect(out[0].ops ?? []).toEqual([])
  })

  it('malformed unclosed tag falls back to text rather than throwing', () => {
    // Unclosed `<` is treated as the start of a tag; if no `>` follows, the
    // remaining input is consumed as text. Caller doesn't crash.
    const frag = htmlToFragment('<p>start <broken')
    expect(() => ops(frag)).not.toThrow()
  })

  it('attaching the produced fragment to a doc preserves inline marks via toDelta', () => {
    // This is the integration check that matters for hydration: the fragment
    // returned must round-trip through Y.Doc attachment without losing marks.
    const frag = htmlToFragment('<p><b>x</b><i>y</i></p>')
    const doc = new Y.Doc()
    const cell = new Y.Map()
    doc.getMap('cells').set('c1', cell)
    cell.set('translatedXml', frag)

    const attached = cell.get('translatedXml') as Y.XmlFragment
    const para = attached.get(0) as Y.XmlElement
    const xt0 = para.get(0) as Y.XmlText
    const xt1 = para.get(1) as Y.XmlText
    expect((xt0.toDelta() as Op[])[0]).toEqual({ insert: 'x', attributes: { bold: true } })
    expect((xt1.toDelta() as Op[])[0]).toEqual({ insert: 'y', attributes: { italic: true } })
  })
})

describe('plainTextToFragment', () => {
  it('produces a single paragraph with the plain text', () => {
    const frag = plainTextToFragment('hello')
    const out = ops(frag)
    expect(out).toHaveLength(1)
    expect(out[0].ops).toEqual([{ insert: 'hello' }])
  })

  it('empty string still produces one (empty) paragraph', () => {
    const out = ops(plainTextToFragment(''))
    expect(out).toHaveLength(1)
    expect(out[0].ops ?? []).toEqual([])
  })
})
