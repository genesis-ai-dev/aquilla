// Partner intake template (AQU-1294 §2.2): the form, its parser, and the two
// unauthenticated routes that serve them. The properties worth guarding: the
// human form in docs/ is byte-equal to the served constant; section 4's
// numbered questions map 1:1 onto the SetBrief sections; a filled form
// round-trips to a ProjectSetup body; the four never-guess fields come back as
// required warnings and nothing else does; policy answers only ever produce
// the restrictive value.

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  SETUP_TEMPLATE_MARKDOWN,
  SETUP_TEMPLATE_BRIEF_QUESTIONS,
  SETUP_TEMPLATE_JSON_SCHEMA,
  parseSetupTemplate,
} from '../../../db/shared/setup-template'
import { BRIEF_FIELD_SPECS } from '../../../db/shared/brief'
import { handleExternalSetupTemplateRequest } from '../external/setup-template-route'

const REQUIRED_FIELDS = [
  'settings.targetLanguage',
  'settings.sourceLanguage',
  'brief.parameters.sourceTexts',
  'brief.parameters.keyTerms',
]

/** Fill a `- Label: ________` line by its distinctive label text. */
function fillLine(md: string, marker: string, value: string): string {
  const lines = md.split('\n')
  const i = lines.findIndex((l) => l.includes(marker))
  if (i < 0) throw new Error(`no template line contains ${marker}`)
  lines[i] = lines[i].replace(/_{3,}/, value)
  return lines.join('\n')
}

/** Answer numbered question N on the line(s) below it. */
function answerQuestion(md: string, n: number, answer: string): string {
  const lines = md.split('\n')
  const i = lines.findIndex((l) => new RegExp(`^${n}\\. \\*\\*`).test(l))
  if (i < 0) throw new Error(`no question ${n}`)
  lines.splice(i + 1, 0, `   ${answer}`)
  return lines.join('\n')
}

function fillTeam(md: string, rows: string[]): string {
  return md.replace('| | | |\n| | | |\n| | | |', rows.join('\n'))
}

/** The sibtatar-shaped form a partner would actually send back. */
function filledForm(): string {
  let md = SETUP_TEMPLATE_MARKDOWN
  md = fillLine(md, 'Language you are translating', 'Siberian Tatar')
  md = fillLine(md, 'Language code, if you know it', 'sty')
  md = fillLine(md, 'Script (', 'Cyrillic')
  md = fillLine(md, 'Your organization', 'IBT')
  md = fillLine(md, 'What should the project be called', 'Siberian Tatar — IBT pilot')
  md = fillTeam(md, [
    '| gulsifa | translator | Russia |',
    '| terciman | Coordinator | Russia |',
    '| ivan | exegete | |',
    '| | | |',
  ])
  md = fillLine(md, 'Which text does the translator read', 'NRT (Russian)')
  md = fillLine(md, 'Language code of that text', 'ru')
  md = fillLine(md, 'Who owns that text', 'Biblica')
  md = fillLine(md, 'Are we allowed to load it', 'yes')
  md = fillLine(md, 'Which book(s) to start with', 'Acts')
  md = fillLine(md, 'File format you are attaching', 'USFM from Paratext')
  md = answerQuestion(md, 1, 'Full NT, printed and audio.')
  md = answerQuestion(md, 2, 'Village adults, bilingual in Russian.')
  md = answerQuestion(md, 3, 'Read aloud in church.')
  md = answerQuestion(md, 4, 'IBT')
  md = answerQuestion(md, 5, 'NRT to draft, NA28 to check.')
  md = answerQuestion(md, 6, 'Tobol-Irtysh dialect, Cyrillic.')
  md = answerQuestion(md, 7, 'Plain and everyday.')
  md = answerQuestion(md, 8, 'Meaning-based.')
  md = answerQuestion(md, 9, 'God = Алла; term list attached.')
  md = answerQuestion(md, 10, 'Never use Kazakh words.')
  md = answerQuestion(md, 11, 'Exegete checks against NA28.')
  md = fillLine(md, 'Does the team need a VPN', 'some people')
  md = fillLine(md, 'Should translator names be hidden', 'yes')
  md = fillLine(md, 'May your translations be used', 'no')
  md = fillLine(md, 'Preferred interface language', 'Russian')
  return md
}

describe('the template constant', () => {
  it('is byte-equal to docs/agent-api/partner-intake.md (the form humans get)', async () => {
    const doc = await readFile(resolve(import.meta.dirname, '../../../docs/agent-api/partner-intake.md'), 'utf8')
    expect(doc).toBe(SETUP_TEMPLATE_MARKDOWN)
  })

  it('has exactly one numbered question per SetBrief section, in interview order', () => {
    expect(SETUP_TEMPLATE_BRIEF_QUESTIONS).toHaveLength(BRIEF_FIELD_SPECS.length)
    expect(SETUP_TEMPLATE_BRIEF_QUESTIONS.map((q) => q.number)).toEqual(
      BRIEF_FIELD_SPECS.map((_, i) => i + 1),
    )
    // Q5 is the source-texts section and Q9 the key-terms section — the two
    // brief fields the agent may never guess.
    expect(SETUP_TEMPLATE_BRIEF_QUESTIONS[4].label).toBe('Source texts')
    expect(BRIEF_FIELD_SPECS[4].id).toBe('sourceTexts')
    expect(SETUP_TEMPLATE_BRIEF_QUESTIONS[8].label).toBe('Key terms')
    expect(BRIEF_FIELD_SPECS[8].id).toBe('keyTerms')
  })

  it('has a slot for the source-text language code (the line added to Joel’s form)', () => {
    expect(SETUP_TEMPLATE_MARKDOWN).toContain('Language code of that text')
  })

  it('publishes a draft-07 schema keyed by the brief section ids', () => {
    expect(SETUP_TEMPLATE_JSON_SCHEMA.$schema).toContain('draft-07')
    const brief = (SETUP_TEMPLATE_JSON_SCHEMA.properties as Record<string, { properties: Record<string, { properties: Record<string, unknown> }> }>).brief
    expect(Object.keys(brief.properties.parameters.properties)).toEqual(BRIEF_FIELD_SPECS.map((f) => f.id))
  })
})

describe('parseSetupTemplate', () => {
  it('round-trips a filled form to a ProjectSetup body with no required warnings', () => {
    const { setup, warnings } = parseSetupTemplate(filledForm())

    expect(setup.projectName).toBe('Siberian Tatar — IBT pilot')
    expect(setup.orgName).toBe('IBT')
    expect(setup.settings).toEqual({
      targetLanguage: 'sty',
      sourceLanguage: 'ru',
      agentAuthorship: 'none',
      contributeToGlobalTm: false,
    })
    expect(setup.brief.parameters).toEqual({
      purpose: 'Full NT, printed and audio.',
      audience: 'Village adults, bilingual in Russian.',
      useAndMedium: 'Read aloud in church.',
      motiveSponsor: 'IBT',
      sourceTexts: 'NRT to draft, NA28 to check.',
      targetVariety: 'Tobol-Irtysh dialect, Cyrillic.',
      registerNaturalness: 'Plain and everyday.',
      literalness: 'Meaning-based.',
      keyTerms: 'God = Алла; term list attached.',
      constraints: 'Never use Kazakh words.',
      qualityBar: 'Exegete checks against NA28.',
    })
    expect(setup.brief.freeformNotes).toBe(
      [
        'Target language name: Siberian Tatar',
        'Script: Cyrillic',
        'Base text: NRT (Russian)',
        'Base text owner: Biblica',
        'Permission to load base text: yes',
        'Books to start with: Acts',
        'File format: USFM from Paratext',
        'VPN needed: some people',
        'Preferred interface language: Russian',
        'Team locations: gulsifa (Russia), terciman (Russia)',
      ].join('\n'),
    )
    // Role words → levels; case-insensitive; the blank row is ignored.
    expect(setup.members).toEqual([
      { username: 'gulsifa', role: 400 },
      { username: 'terciman', role: 600 },
      { username: 'ivan', role: 300 },
    ])
    // The form carries attachments, never artifact ids.
    expect(setup.imports).toEqual([])
    expect(warnings.filter((w) => w.required)).toEqual([])
    expect(warnings).toEqual([])
  })

  it('a blank form yields exactly the four required warnings, plus one per other blank', () => {
    const { setup, warnings } = parseSetupTemplate(SETUP_TEMPLATE_MARKDOWN)
    expect(warnings.filter((w) => w.required).map((w) => w.field).sort()).toEqual([...REQUIRED_FIELDS].sort())
    expect(setup.settings).toEqual({})
    expect(setup.brief.parameters).toEqual({})
    expect(setup.brief.freeformNotes).toBe('')
    expect(setup.members).toEqual([])
    expect(setup.projectName).toBeUndefined()
    // Every optional blank is named too, so the agent knows what it defaulted.
    const optional = warnings.filter((w) => !w.required).map((w) => w.field)
    expect(optional).toContain('projectName')
    expect(optional).toContain('brief.parameters.purpose')
    expect(optional).toContain('members')
    for (const w of warnings) expect(w.message.length).toBeGreaterThan(10)
  })

  it('survives what email does to Markdown: CRLF, trailing spaces, lost bold and bullets, inline answers', () => {
    const md = [
      '## 1. The project',
      '',
      'Language you are translating into (name): Siberian Tatar   ',
      '- Language code, if you know it (ISO 639-3, e.g. sty): sty',
      '',
      '## 3. The text you translate from',
      '- Which text does the translator read while drafting? (e.g. Russian Synodal, NRT, Kazan Tatar Bible, Greek NA28): NRT',
      '- Language code of that text (ISO 639-3 / BCP-47, e.g. `ru`): ru',
      '',
      '## 4. About the translation',
      '5. **Source texts** — What does the translator draft from, and what does the checker compare against? NRT and NA28',
      '9. Key terms — How do you already render God, Lord, Spirit, Son of God, prophet, Messiah/Christ? Do you have a term list (Paratext Biblical Terms export)? Attach it if so.',
      '',
      'God = Алла',
      'Lord = Раббы',
      '',
      '## 5. Practical',
    ].join('\r\n')
    const { setup, warnings } = parseSetupTemplate(md)
    expect(setup.settings).toEqual({ targetLanguage: 'sty', sourceLanguage: 'ru' })
    expect(setup.brief.parameters.sourceTexts).toBe('NRT and NA28')
    expect(setup.brief.parameters.keyTerms).toBe('God = Алла\nLord = Раббы')
    expect(setup.brief.freeformNotes).toContain('Target language name: Siberian Tatar')
    expect(warnings.filter((w) => w.required)).toEqual([])
  })

  it('fills brief.sourceTexts from the base-text line when question 5 is blank', () => {
    const md = fillLine(SETUP_TEMPLATE_MARKDOWN, 'Which text does the translator read', 'Russian Synodal')
    const { setup, warnings } = parseSetupTemplate(md)
    expect(setup.brief.parameters.sourceTexts).toBe('Russian Synodal')
    expect(warnings.map((w) => w.field)).not.toContain('brief.parameters.sourceTexts')
  })

  it('policy answers only ever produce the restrictive value; the default answer omits the key', () => {
    let md = fillLine(SETUP_TEMPLATE_MARKDOWN, 'Should translator names be hidden', 'No')
    md = fillLine(md, 'May your translations be used', 'Yes, please')
    const { setup, warnings } = parseSetupTemplate(md)
    expect(setup.settings).toEqual({})
    expect(warnings.map((w) => w.field)).not.toContain('settings.agentAuthorship')
    expect(warnings.map((w) => w.field)).not.toContain('settings.contributeToGlobalTm')
  })

  it('an unreadable yes/no is a warning, not a guess', () => {
    const md = fillLine(SETUP_TEMPLATE_MARKDOWN, 'Should translator names be hidden', 'ask the coordinator')
    const { setup, warnings } = parseSetupTemplate(md)
    expect(setup.settings.agentAuthorship).toBeUndefined()
    const w = warnings.find((x) => x.field === 'settings.agentAuthorship')
    expect(w?.required).toBe(false)
    expect(w?.message).toContain('ask the coordinator')
  })

  it('an unknown team role skips the row and names it; blank usernames are ignored', () => {
    const md = fillTeam(SETUP_TEMPLATE_MARKDOWN, [
      '| gulsifa | translator | |',
      '| bob | consultant | UK |',
      '|  | reviewer | |',
    ])
    const { setup, warnings } = parseSetupTemplate(md)
    expect(setup.members).toEqual([{ username: 'gulsifa', role: 400 }])
    const w = warnings.find((x) => x.field === 'members[1]')
    expect(w?.required).toBe(false)
    expect(w?.message).toContain('consultant')
    expect(w?.message).toContain('bob')
    // Country never reaches settings.
    expect(setup.brief.freeformNotes).toBe('')
    expect(JSON.stringify(setup.settings)).not.toContain('UK')
  })
})

describe('GET /api/v1/external/setup-template', () => {
  it('serves the form, the schema, and where to send the filled form back', async () => {
    const res = await handleExternalSetupTemplateRequest(new Request('https://w/api/v1/external/setup-template'))
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { markdown: string; jsonSchema: unknown; parseEndpoint: string; skill: string }
    expect(body.markdown).toBe(SETUP_TEMPLATE_MARKDOWN)
    expect(body.jsonSchema).toEqual(SETUP_TEMPLATE_JSON_SCHEMA)
    expect(body.parseEndpoint).toBe('POST /api/v1/external/setup-template/parse')
    expect(body.skill).toBe('/api/v1/external/skills/project-setup')
  })

  it('405s a non-GET with Allow, and ignores unrelated paths', async () => {
    const post = await handleExternalSetupTemplateRequest(
      new Request('https://w/api/v1/external/setup-template', { method: 'POST' }),
    )
    expect(post!.status).toBe(405)
    expect(post!.headers.get('Allow')).toBe('GET')
    expect(((await post!.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
    expect(await handleExternalSetupTemplateRequest(new Request('https://w/api/v1/external/projects'))).toBeNull()
  })
})

describe('POST /api/v1/external/setup-template/parse', () => {
  const parse = (body: BodyInit | null, method = 'POST') =>
    handleExternalSetupTemplateRequest(
      new Request('https://w/api/v1/external/setup-template/parse', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    )

  it('round-trips the filled form through the HTTP boundary and says what to do next', async () => {
    const res = await parse(JSON.stringify({ markdown: filledForm() }))
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      setup: { settings: Record<string, unknown>; members: unknown[]; imports: unknown[] }
      warnings: unknown[]
      nextStep: string
    }
    expect(body.setup.settings.targetLanguage).toBe('sty')
    expect(body.setup.members).toHaveLength(3)
    expect(body.setup.imports).toEqual([])
    expect(body.warnings).toEqual([])
    expect(body.nextStep).toContain('artifact')
    expect(body.nextStep).toContain('ProjectSetup')
  })

  it('the blank template comes back with the four required warnings', async () => {
    const res = await parse(JSON.stringify({ markdown: SETUP_TEMPLATE_MARKDOWN }))
    const body = (await res!.json()) as { warnings: { field: string; required: boolean }[] }
    expect(body.warnings.filter((w) => w.required).map((w) => w.field).sort()).toEqual([...REQUIRED_FIELDS].sort())
  })

  it('rejects a missing/non-string markdown and a non-JSON body as validation_failed', async () => {
    for (const body of ['{}', JSON.stringify({ markdown: 7 }), 'not json']) {
      const res = await parse(body)
      expect(res!.status, body).toBe(400)
      expect(((await res!.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
    }
  })

  it('405s a GET on the parse path with Allow: POST', async () => {
    const res = await parse(null, 'GET')
    expect(res!.status).toBe(405)
    expect(res!.headers.get('Allow')).toBe('POST')
  })
})
