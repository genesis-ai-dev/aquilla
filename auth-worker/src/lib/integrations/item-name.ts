// The name a pushed row gets (Monday item, Airtable record's primary field).
//
// A mapping may carry an `itemNameTemplate` in which "{projectName}" and
// "{fileName}" are filled in. The AI that proposes mappings was never told
// that syntax, and on a real board it wrote "{{project_name}}", which no
// replace matched, so the row was named "{{project_name}}" literally. Any
// spelling of the two placeholders is read now — single or double braces,
// camelCase, snake_case or spaces — and a template that still names
// something else, or comes out empty, gives way to the default name.

/** One placeholder, braces single or double: {projectName}, {{ project_name }}, {file name}. */
const PLACEHOLDER = /\{\{?\s*([A-Za-z][A-Za-z _-]*?)\s*\}?\}/g

type Placeholder = "projectName" | "fileName"

function placeholderFor(raw: string): Placeholder | null {
  switch (raw.toLowerCase().replace(/[^a-z]/g, "")) {
    case "projectname":
    case "project":
      return "projectName"
    case "filename":
    case "file":
    case "bookname":
    case "book":
      return "fileName"
    default:
      return null
  }
}

/**
 * The template in its one written form ("{projectName}", "{fileName}"), or
 * null when it names anything else — nothing would fill that in, and the row
 * would carry the placeholder as its name.
 */
export function canonicalItemNameTemplate(template: string): string | null {
  let unknown = false
  const canonical = template.replace(PLACEHOLDER, (_, name: string) => {
    const known = placeholderFor(name)
    if (!known) unknown = true
    return known ? `{${known}}` : ""
  })
  return unknown || !canonical.trim() ? null : canonical
}

/** Does the template name the file (so it is written for a file's row)? */
export function templateNamesFile(template: string | undefined): boolean {
  return Boolean(template && canonicalItemNameTemplate(template)?.includes("{fileName}"))
}

/**
 * A row's name. Without a usable template: the project's name, or
 * "<project> — <file>" for a file's row.
 */
export function renderItemName(
  template: string | undefined,
  kind: "project" | "file",
  projectName: string,
  fileName?: string,
): string {
  const fallback = kind === "file" ? "{projectName} — {fileName}" : "{projectName}"
  const fill = (tpl: string) =>
    tpl.replaceAll("{projectName}", projectName).replaceAll("{fileName}", fileName ?? "").trim()
  const canonical = template ? canonicalItemNameTemplate(template) : null
  const named = canonical ? fill(canonical) : ""
  return named || fill(fallback)
}
