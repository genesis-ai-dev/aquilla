// Partner intake template routes (AQU-1294 §2.2).
//
//   GET  /api/v1/external/setup-template        — the intake form as Markdown
//                                                 (to email a partner) + the JSON
//                                                 schema of what parse returns.
//   POST /api/v1/external/setup-template/parse  — { markdown } (the filled form)
//                                                 → { setup, warnings, nextStep }.
//
// Both serve the SHARED module (db/shared/setup-template.ts) so the form a
// partner fills, the schema an agent reads, and the parser that joins them can
// never disagree. Deliberately UNAUTHENTICATED, like commands-doc-route.ts:
// the form is static text and parse is a pure transform of the caller's own
// bytes — no project data is read or written, and nothing is staged.
//
// Mounted in index.ts just before handleExternalCommandsDocRequest.

import { parseSetupTemplate, SETUP_TEMPLATE_JSON_SCHEMA, SETUP_TEMPLATE_MARKDOWN } from '../../../db/shared/setup-template'

const TEMPLATE_PATH = '/api/v1/external/setup-template'
const PARSE_PATH = `${TEMPLATE_PATH}/parse`

/** A filled form is a few KB; anything past this is not a form. */
const MAX_MARKDOWN_BYTES = 256 * 1024

const NEXT_STEP =
  'Resolve every warning with required: true by asking the partner — never guess those four. ' +
  'Upload each attached source file as an artifact, run the parse preview, and add one entry ' +
  'per file to setup.imports (the form carries attachments, not artifact ids). Then stage ONE ' +
  '{ kind: "ProjectSetup", projectId, ...setup } against an existing project — see ' +
  'GET /api/v1/external/skills/project-setup.'

function methodNotAllowed(path: string, allow: 'GET' | 'POST'): Response {
  return Response.json(
    { error: { code: 'validation_failed', message: `use ${allow} ${path}` } },
    { status: 405, headers: { Allow: allow } },
  )
}

function validationFailed(message: string): Response {
  return Response.json({ error: { code: 'validation_failed', message } }, { status: 400 })
}

export async function handleExternalSetupTemplateRequest(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname

  if (path === TEMPLATE_PATH) {
    if (request.method !== 'GET') return methodNotAllowed(TEMPLATE_PATH, 'GET')
    return Response.json({
      markdown: SETUP_TEMPLATE_MARKDOWN,
      jsonSchema: SETUP_TEMPLATE_JSON_SCHEMA,
      parseEndpoint: `POST ${PARSE_PATH}`,
      skill: '/api/v1/external/skills/project-setup',
    })
  }

  if (path === PARSE_PATH) {
    if (request.method !== 'POST') return methodNotAllowed(PARSE_PATH, 'POST')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return validationFailed('body must be JSON: { "markdown": "<the filled intake form>" }')
    }
    const markdown = (body as { markdown?: unknown } | null)?.markdown
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      return validationFailed('body.markdown (string, the filled intake form) is required')
    }
    if (markdown.length > MAX_MARKDOWN_BYTES) {
      return validationFailed(`body.markdown exceeds ${MAX_MARKDOWN_BYTES} characters — that is not an intake form`)
    }
    const { setup, warnings } = parseSetupTemplate(markdown)
    return Response.json({ setup, warnings, nextStep: NEXT_STEP })
  }

  return null
}
