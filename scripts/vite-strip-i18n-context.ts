import ts from "typescript"
import type { Plugin } from "vite"

/**
 * AQU-2090: keep translator notes out of the browser.
 *
 * Every namespace module under `src/lib/i18n/namespaces/` is one
 * `defineNamespace({ keys, context, surfaces })` call. The app only ever reads
 * `keys`; `context` (a description, length limit and placeholder notes for every
 * string, about 40% of the module) and `surfaces` (screenshot routes) exist for
 * the translation tooling: `context.ts`, `screenshots.ts`, the catalog export
 * and the i18n check, all of which run from source, never from the build.
 *
 * In a production build this replaces those two values with empty stand-ins of
 * the same shape. Dev, tests and the catalog scripts read the modules untouched.
 */
export function stripI18nContextPlugin(): Plugin {
  return {
    name: "strip-i18n-context",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (!NAMESPACE_MODULE.test(id.split("?")[0]!)) return null
      const stripped = stripNamespaceContext(code)
      return stripped === code ? null : { code: stripped, map: null }
    },
  }
}

const NAMESPACE_MODULE = /\/src\/lib\/i18n\/namespaces\/(?!types\.ts$|index\.ts$|duplicate-exceptions\.ts$)[^/]+(?<!\.test)\.ts$/

const STAND_INS: Record<string, string> = {
  context: '{ _context: { description: "" } }',
  surfaces: "[]",
}

/** The module's text with every `defineNamespace` call's `context` and `surfaces` emptied. */
export function stripNamespaceContext(code: string): string {
  const source = ts.createSourceFile("namespace.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineNamespace" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
        const standIn = name ? STAND_INS[name] : undefined
        if (standIn) edits.push({ start: property.initializer.getStart(source), end: property.initializer.getEnd(), text: standIn })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let out = code
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}
