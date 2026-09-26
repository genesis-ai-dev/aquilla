// Partner intake template (AQU-1294 §2.2) — dependency-free, importable by
// BOTH workers.
//
// One form, every partner, every console: the Markdown below is what a Frontier
// operator emails a partner; `parseSetupTemplate` turns the filled reply back
// into the body of a `ProjectSetup` command (minus `kind`/`projectId`) plus a
// `warnings[]` list naming every blank. The four fields an agent must NEVER
// guess — settings.sourceLanguage, settings.targetLanguage,
// brief.parameters.sourceTexts, brief.parameters.keyTerms — come back as
// `required: true` warnings; everything else may be defaulted by the agent as
// long as the approval summary marks it "(defaulted)".
//
// The human form is Joel Maves' `partner-intake.md` verbatim, plus ONE added
// line in section 3 (the source-text language code — his form had no slot for
// it and it is one of the four never-guess fields). `docs/agent-api/
// partner-intake.md` must stay byte-equal to SETUP_TEMPLATE_MARKDOWN; a test
// asserts it. Section 4's eleven numbered questions map, in order, onto
// BRIEF_FIELD_SPECS (the SetBrief section ids) — the module throws at load if
// the counts ever drift.
//
// The parser is deliberately tolerant of what an email reply does to Markdown:
// CRLF, trailing spaces, lost bullets, lost bold/backticks, an answer typed on
// the question line OR on the lines below it, and untouched `________`
// placeholders (which count as blank).

import { BRIEF_FIELD_SPECS } from './brief'

export const SETUP_TEMPLATE_MARKDOWN = `# Aquilla project setup — what we need from your team

Fill in what you can and send it back with your files attached. Leave a line blank if you don't know — we will ask, not guess. Short answers are fine.

## 1. The project

- Language you are translating **into** (name): ________
- Language code, if you know it (ISO 639-3, e.g. \`sty\`): ________
- Script (Cyrillic / Latin / Arabic / other): ________
- Your organization: ________
- What should the project be called in Aquilla? ________

## 2. Your team

One line per person. Everyone needs an Aquilla account first: https://aquilla.app/onboarding

| Aquilla username | Role on this project (translator / exegete / coordinator / reviewer) | Country they work from |
|---|---|---|
| | | |
| | | |
| | | |

## 3. The text you translate from

- Which text does the translator read while drafting? (e.g. Russian Synodal, NRT, Kazan Tatar Bible, Greek NA28): ________
- Language code of that text (ISO 639-3 / BCP-47, e.g. \`ru\`): ________
- Who owns that text (Biblica, RBS, public domain, your own)? ________
- Are we allowed to load it into Aquilla? (yes / need to check / no): ________
- Which book(s) to start with: ________
- File format you are attaching (USFM/SFM from Paratext is best; Word or CSV also work; please no PDF): ________
- Is there any existing translation into the target language for these books? If yes, attach it too.

## 4. About the translation (this becomes the AI's brief)

Answer in your own words; a sentence each is enough.

1. **Purpose** — What is this translation for? (full Bible, NT, portions, oral use, publishing)
2. **Readers** — Who will read it? Age, where they live, do they also read another language, are they familiar with Scripture?
3. **How it will be used** — Read silently, read aloud in church, recorded as audio, printed?
4. **Sponsor / partners** — Who is funding or overseeing it?
5. **Source texts** — What does the translator draft from, and what does the checker compare against?
6. **Which variety of the language** — Which dialect or standard? Which spelling? Anything to avoid (e.g. forms from a neighbouring language)?
7. **Style** — Should it sound formal and literary, or plain and everyday? Any examples of existing writing in the language that has the right feel?
8. **Literal or meaning-based** — Closer to the words, or closer to the sense?
9. **Key terms** — How do you already render God, Lord, Spirit, Son of God, prophet, Messiah/Christ? Do you have a term list (Paratext Biblical Terms export)? Attach it if so.
10. **Things the AI must never do** — e.g. never invent a religious term, never use words from language X, never change verse numbers.
11. **What "done" means** — Who checks a verse and against what before it counts as finished?

## 5. Practical

- Does the team need a VPN to reach aquilla.app from where they work? (yes / no / some people): ________
- Should translator names be hidden from any AI tools connected to the project? (yes / no): ________
- May your translations be used to help other projects in the same language family (shared translation memory)? (yes / no): ________
- Preferred interface language: ________

## 6. Attach

- [ ] Source text file(s)
- [ ] Existing translation, if any
- [ ] Term list, if any

That's everything. Once we have this, the project is set up in one step and your team gets a walkthrough call.
`

// ── result shapes ────────────────────────────────────────────────────────────

export interface SetupTemplateWarning {
  /** Dotted path into the setup body (e.g. "settings.targetLanguage",
   *  "brief.parameters.keyTerms", "members[2]", "notes.script"). */
  field: string
  message: string
  /** true only for the four never-guess fields. */
  required: boolean
}

export interface SetupTemplateMember {
  username: string
  role: number
}

export interface SetupTemplateImport {
  artifactId: string
  fileName: string
  fileType?: string
  resultIndex?: number
  sourceLanguage?: string
  targetLanguage?: string
}

/** The `ProjectSetup` command body minus `kind`/`projectId`, plus the two
 *  human-facing strings the form carries that no settings key holds. */
export interface SetupTemplateSetup {
  projectName?: string
  orgName?: string
  settings: Record<string, unknown>
  brief: { parameters: Record<string, string>; freeformNotes: string }
  members: SetupTemplateMember[]
  /** Always empty from the form — it carries file attachments, not artifact
   *  ids. The agent uploads the attachments and fills this in. */
  imports: SetupTemplateImport[]
}

export interface SetupTemplateParseResult {
  setup: SetupTemplateSetup
  warnings: SetupTemplateWarning[]
}

// ── the form's field table ───────────────────────────────────────────────────

/** Team-table role words → project role levels. Anything else is a warning
 *  and the row is skipped — never guess a role. */
export const TEAM_ROLE_LEVELS: Readonly<Record<string, number>> = {
  translator: 400,
  exegete: 300,
  reviewer: 300,
  coordinator: 600,
}

const PLACEHOLDER_RE = /_{3,}/g

/** Markdown-noise normalisation shared by the matcher: bold/backticks gone,
 *  leading bullet gone, whitespace collapsed. Case is preserved so answers
 *  come back as typed; comparisons lower-case both sides. */
function clean(line: string): string {
  return line
    .replace(/[*`]/g, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripPlaceholder(value: string): string {
  return value.replace(PLACEHOLDER_RE, '').trim()
}

type LineFieldTarget =
  | { kind: 'projectName' }
  | { kind: 'orgName' }
  | { kind: 'setting'; key: 'sourceLanguage' | 'targetLanguage' }
  | { kind: 'note'; label: string }
  | { kind: 'yesNo'; id: 'hideNames' | 'sharedTm' }

interface LineFieldSpec {
  /** Unique substring of the template line; the canonical prefix is derived
   *  from the template at load time so the two cannot drift. */
  marker: string
  /** Warning field name. */
  field: string
  target: LineFieldTarget
  required?: boolean
}

const LINE_FIELDS: readonly LineFieldSpec[] = [
  { marker: 'Language you are translating', field: 'notes.targetLanguageName', target: { kind: 'note', label: 'Target language name' } },
  { marker: 'Language code, if you know it', field: 'settings.targetLanguage', target: { kind: 'setting', key: 'targetLanguage' }, required: true },
  { marker: 'Script (', field: 'notes.script', target: { kind: 'note', label: 'Script' } },
  { marker: 'Your organization', field: 'orgName', target: { kind: 'orgName' } },
  { marker: 'What should the project be called', field: 'projectName', target: { kind: 'projectName' } },
  { marker: 'Which text does the translator read', field: 'notes.baseText', target: { kind: 'note', label: 'Base text' } },
  { marker: 'Language code of that text', field: 'settings.sourceLanguage', target: { kind: 'setting', key: 'sourceLanguage' }, required: true },
  { marker: 'Who owns that text', field: 'notes.baseTextOwner', target: { kind: 'note', label: 'Base text owner' } },
  { marker: 'Are we allowed to load it', field: 'notes.baseTextPermission', target: { kind: 'note', label: 'Permission to load base text' } },
  { marker: 'Which book(s) to start with', field: 'notes.books', target: { kind: 'note', label: 'Books to start with' } },
  { marker: 'File format you are attaching', field: 'notes.fileFormat', target: { kind: 'note', label: 'File format' } },
  { marker: 'Does the team need a VPN', field: 'notes.vpn', target: { kind: 'note', label: 'VPN needed' } },
  { marker: 'Should translator names be hidden', field: 'settings.agentAuthorship', target: { kind: 'yesNo', id: 'hideNames' } },
  { marker: 'May your translations be used', field: 'settings.contributeToGlobalTm', target: { kind: 'yesNo', id: 'sharedTm' } },
  { marker: 'Preferred interface language', field: 'notes.interfaceLanguage', target: { kind: 'note', label: 'Preferred interface language' } },
]

const TEMPLATE_LINES = SETUP_TEMPLATE_MARKDOWN.split('\n')

/** Canonical (cleaned, placeholder-stripped) prefix of one template line. */
function canonicalPrefix(marker: string): string {
  const line = TEMPLATE_LINES.find((l) => l.includes(marker))
  if (!line) throw new Error(`setup-template: no template line contains "${marker}"`)
  return clean(line.replace(PLACEHOLDER_RE, ''))
}

const LINE_PREFIXES: readonly { spec: LineFieldSpec; prefix: string }[] = LINE_FIELDS.map((spec) => ({
  spec,
  prefix: canonicalPrefix(spec.marker),
}))

const QUESTION_RE = /^\s*(\d{1,2})\.\s+(.+)$/

/** Section 4's numbered questions, in template order — index i is brief
 *  section BRIEF_FIELD_SPECS[i]. */
export const SETUP_TEMPLATE_BRIEF_QUESTIONS: readonly { number: number; label: string; line: string }[] =
  TEMPLATE_LINES.flatMap((raw) => {
    const m = raw.match(QUESTION_RE)
    if (!m) return []
    const bold = raw.match(/\*\*(.+?)\*\*/)
    return [{ number: Number(m[1]), label: clean(bold ? bold[1] : m[2]), line: clean(raw) }]
  })

if (SETUP_TEMPLATE_BRIEF_QUESTIONS.length !== BRIEF_FIELD_SPECS.length) {
  throw new Error(
    `setup-template: ${SETUP_TEMPLATE_BRIEF_QUESTIONS.length} numbered questions but ${BRIEF_FIELD_SPECS.length} brief sections`,
  )
}

// ── JSON schema (for agents) ─────────────────────────────────────────────────

const briefParameterProperties: Record<string, unknown> = {}
for (const f of BRIEF_FIELD_SPECS) {
  briefParameterProperties[f.id] = { type: 'string', description: f.heading }
}

/** Draft-07 schema of what `parseSetupTemplate` returns in `setup` — the
 *  `ProjectSetup` command body minus `kind`/`projectId`. */
export const SETUP_TEMPLATE_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ProjectSetup body (from the partner intake form)',
  description:
    'Stage as { kind: "ProjectSetup", projectId, ...this } against an EXISTING project. ' +
    'settings.sourceLanguage, settings.targetLanguage, brief.parameters.sourceTexts and ' +
    'brief.parameters.keyTerms must come from the partner — never guess them.',
  type: 'object',
  properties: {
    projectName: { type: 'string', description: 'Human project name (CreateProject.name); not a settings key.' },
    orgName: { type: 'string', description: 'Partner organization, informational only.' },
    settings: {
      type: 'object',
      description: 'PatchSettings keys. Policy keys are writable in the restrictive direction only.',
      properties: {
        sourceLanguage: { type: 'string', description: 'Language code of the text the translator drafts FROM (e.g. "ru").' },
        targetLanguage: { type: 'string', description: 'Language code of the translation (ISO 639-3, e.g. "sty").' },
        contributeToGlobalTm: { const: false, description: 'Present only when the partner declined shared translation memory.' },
        agentAuthorship: { const: 'none', description: 'Present only when the partner asked to hide translator names from agents.' },
      },
      additionalProperties: true,
    },
    brief: {
      type: 'object',
      properties: {
        parameters: {
          type: 'object',
          description: 'SetBrief sections, keyed by section id (the eleven numbered questions, in order).',
          properties: briefParameterProperties,
          additionalProperties: false,
        },
        freeformNotes: { type: 'string', description: 'Labelled "Key: value" lines for everything the form asks that has no section of its own.' },
      },
      required: ['parameters', 'freeformNotes'],
      additionalProperties: false,
    },
    members: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          role: { type: 'integer', enum: [100, 200, 300, 400, 500, 600, 700], description: 'translator → 400, exegete/reviewer → 300, coordinator → 600.' },
        },
        required: ['username', 'role'],
        additionalProperties: false,
      },
    },
    imports: {
      type: 'array',
      maxItems: 10,
      description: 'Always [] from the form. Upload each attached file as an artifact, preview it, then add one entry per file.',
      items: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          fileName: { type: 'string' },
          fileType: { type: 'string' },
          resultIndex: { type: 'integer', minimum: 0 },
          sourceLanguage: { type: 'string' },
          targetLanguage: { type: 'string' },
        },
        required: ['artifactId', 'fileName'],
        additionalProperties: false,
      },
    },
  },
  required: ['settings', 'brief', 'members', 'imports'],
  additionalProperties: false,
}

// ── parser ───────────────────────────────────────────────────────────────────

function yesNo(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (/^yes\b/.test(v)) return true
  if (/^no\b/.test(v)) return false
  return null
}

/** Value of a `- Label: value` line, or null when the line is not in the form. */
function lineValue(lines: readonly string[], prefix: string): string | null {
  const lower = prefix.toLowerCase()
  for (const raw of lines) {
    const c = clean(raw)
    if (c.toLowerCase().startsWith(lower)) return stripPlaceholder(c.slice(prefix.length))
  }
  return null
}

/** Answers to the eleven numbered questions, by index. An answer may sit on
 *  the question line itself (after the template text) and/or on the lines
 *  below it, up to the next question or heading. */
function briefAnswers(lines: readonly string[]): string[] {
  const answers: string[] = SETUP_TEMPLATE_BRIEF_QUESTIONS.map(() => '')
  let current = -1
  let block: string[] = []
  const flush = () => {
    if (current >= 0) {
      const inline = answers[current]
      answers[current] = [inline, ...block].filter((s) => s !== '').join('\n')
    }
    block = []
  }
  for (const raw of lines) {
    const c = clean(raw)
    if (/^#{1,6}\s/.test(raw.trim())) {
      flush()
      current = -1
      continue
    }
    const m = raw.match(QUESTION_RE)
    if (m) {
      const idx = SETUP_TEMPLATE_BRIEF_QUESTIONS.findIndex(
        (q) => q.number === Number(m[1]) && clean(m[2]).toLowerCase().startsWith(q.label.toLowerCase()),
      )
      if (idx >= 0) {
        flush()
        current = idx
        const q = SETUP_TEMPLATE_BRIEF_QUESTIONS[idx]
        answers[idx] = c.toLowerCase().startsWith(q.line.toLowerCase())
          ? stripPlaceholder(c.slice(q.line.length))
          : ''
        continue
      }
    }
    if (current >= 0) {
      const v = stripPlaceholder(c)
      if (v !== '') block.push(v)
    }
  }
  flush()
  return answers
}

interface TeamRow {
  username: string
  role: string
  country: string
}

function teamRows(lines: readonly string[]): TeamRow[] {
  const rows: TeamRow[] = []
  for (const raw of lines) {
    const t = raw.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => clean(c))
    if (cells.every((c) => c === '' || /^:?-+:?$/.test(c))) continue
    const [username = '', role = '', country = ''] = cells
    if (username.toLowerCase().startsWith('aquilla username')) continue
    if (stripPlaceholder(username) === '') continue
    rows.push({ username: stripPlaceholder(username), role: stripPlaceholder(role), country: stripPlaceholder(country) })
  }
  return rows
}

/** Parse a filled intake form. Never throws on content — an unrecognisable
 *  document simply comes back all-blank with every warning set. */
export function parseSetupTemplate(markdown: string): SetupTemplateParseResult {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
  const warnings: SetupTemplateWarning[] = []
  const settings: Record<string, unknown> = {}
  const parameters: Record<string, string> = {}
  const notes: string[] = []
  const setup: SetupTemplateSetup = {
    settings,
    brief: { parameters, freeformNotes: '' },
    members: [],
    imports: [],
  }

  const blank = (field: string, required: boolean) =>
    warnings.push({
      field,
      required,
      message: required
        ? 'blank in the form — ask the partner; never guess this field'
        : 'blank in the form — may be defaulted; mark it "(defaulted)" in the approval summary',
    })

  const answers = briefAnswers(lines)
  let baseText = ''

  for (const { spec, prefix } of LINE_PREFIXES) {
    const value = lineValue(lines, prefix) ?? ''
    const t = spec.target
    if (value === '') {
      blank(spec.field, spec.required === true)
      continue
    }
    switch (t.kind) {
      case 'projectName':
        setup.projectName = value
        break
      case 'orgName':
        setup.orgName = value
        break
      case 'setting':
        settings[t.key] = value
        break
      case 'note':
        notes.push(`${t.label}: ${value}`)
        if (t.label === 'Base text') baseText = value
        break
      case 'yesNo': {
        const yn = yesNo(value)
        if (yn === null) {
          warnings.push({
            field: spec.field,
            required: false,
            message: `could not read "${value}" as yes/no — left unset; confirm with the partner`,
          })
        } else if (t.id === 'hideNames' && yn) {
          settings.agentAuthorship = 'none'
        } else if (t.id === 'sharedTm' && !yn) {
          settings.contributeToGlobalTm = false
        }
        // "hide: no" / "shared TM: yes" are the defaults — and an agent write
        // of the loosening value would be refused — so the key is omitted.
        break
      }
    }
  }

  // Brief sections: question i → BRIEF_FIELD_SPECS[i].
  BRIEF_FIELD_SPECS.forEach((f, i) => {
    let answer = answers[i]
    if (f.id === 'sourceTexts' && answer === '' && baseText !== '') answer = baseText
    if (answer !== '') {
      parameters[f.id] = answer
      return
    }
    blank(`brief.parameters.${f.id}`, f.id === 'sourceTexts' || f.id === 'keyTerms')
  })

  // Team table.
  const rows = teamRows(lines)
  const locations: string[] = []
  rows.forEach((row, i) => {
    const level = TEAM_ROLE_LEVELS[row.role.toLowerCase()]
    if (level === undefined) {
      warnings.push({
        field: `members[${i}]`,
        required: false,
        message:
          `unknown role "${row.role}" for ${row.username} — expected translator / exegete / coordinator / reviewer; row skipped`,
      })
      return
    }
    setup.members.push({ username: row.username, role: level })
    if (row.country !== '') locations.push(`${row.username} (${row.country})`)
  })
  if (rows.length === 0) blank('members', false)
  if (locations.length > 0) notes.push(`Team locations: ${locations.join(', ')}`)

  setup.brief.freeformNotes = notes.join('\n')
  return { setup, warnings }
}
