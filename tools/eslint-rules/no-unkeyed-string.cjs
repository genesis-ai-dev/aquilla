/**
 * ESLint rule: i18n/no-unkeyed-string
 *
 * Fails on a user-visible string literal that is not routed through the i18n
 * catalog (`t("key")` / `<RichMessage>`). Three detection classes, ordered by
 * how confidently a hit is a real regression:
 *
 *   1. JSXText        — literal text between tags.  Highest confidence.
 *   2. JSX attribute  — a literal on a translatable attribute (aria-label,
 *                       placeholder, title, alt, tooltip content, …).
 *   3. Notification   — first string argument to toast.* / alert / confirm.
 *
 * Escape hatch: `// i18n-exempt <reason>` on the line or the line above, or the
 * standard `// eslint-disable-next-line i18n/no-unkeyed-string`.
 *
 * KNOWN LIMITATIONS (see docs/swarm/TRACES.md SWARM-TODO for the follow-up
 * workstream — a typed `MessageKey` prop convention is the planned fix):
 *
 *   - Template literals WITH expressions (`` `Deleted ${n} files` ``) are not
 *     flagged at all — only zero-expression templates are treated as static
 *     strings. Interpolated strings are exactly the ones that need catalog
 *     placeholders and plural categories, so this is a real coverage hole,
 *     not a cosmetic one. Left out deliberately: flagging static quasis
 *     inside an interpolated template raises the false-positive rate a lot
 *     (`` `${label}:` `` would report the literal `":"`).
 *   - Strings in const arrays/objects hoisted outside component scope
 *     (`const ROLE_OPTIONS = [{ label: 'Owner' }]`) are invisible to this
 *     rule — it has no data-flow analysis and cannot know that `.label`
 *     later reaches JSX.
 *
 * Both are structural: this rule only sees JSXText, JSX attribute values, and
 * the first argument of a small allowlisted set of calls. Closing them needs
 * either a naming-convention heuristic (flag `label`/`title`/`description`
 * properties in any object literal in a .tsx file) or type-aware linting.
 */

const {
  TRANSLATABLE_ATTRS,
  USER_FACING_CALLS,
  isIgnoredFile,
  isAllowedString,
} = require('./allowlist.cjs')

function calleeName(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = calleeName(node.object)
    const prop = node.property.type === 'Identifier' ? node.property.name : null
    return obj && prop ? `${obj}.${prop}` : null
  }
  return null
}

/** Template literals with no expressions are just strings with extra steps. */
function staticStringOf(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? '').join('')
  }
  return null
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'User-visible strings must come from the i18n catalog.' },
    schema: [
      {
        type: 'object',
        properties: {
          extraIgnoredFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unkeyed:
        'Unkeyed user-visible string {{text}}. Add a key to src/lib/i18n/messages/ and use t("…"), or mark it `// i18n-exempt <reason>`.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (isIgnoredFile(filename)) return {}

    const source = context.sourceCode ?? context.getSourceCode()
    const exemptLines = new Set()
    for (const c of source.getAllComments()) {
      if (/\bi18n-exempt\b/.test(c.value)) {
        exemptLines.add(c.loc.start.line)
        exemptLines.add(c.loc.start.line + 1)
      }
    }

    const report = (node, text) => {
      if (exemptLines.has(node.loc.start.line)) return
      const shown = text.trim().replace(/\s+/g, ' ').slice(0, 60)
      context.report({ node, messageId: 'unkeyed', data: { text: JSON.stringify(shown) } })
    }

    return {
      JSXText(node) {
        const raw = node.value
        if (isAllowedString(raw)) return
        report(node, raw)
      },

      JSXAttribute(node) {
        const name =
          node.name.type === 'JSXIdentifier'
            ? node.name.name
            : node.name.type === 'JSXNamespacedName'
              ? `${node.name.namespace.name}:${node.name.name.name}`
              : null
        if (!name || !TRANSLATABLE_ATTRS.has(name)) return

        let valueNode = node.value
        if (valueNode && valueNode.type === 'JSXExpressionContainer') {
          valueNode = valueNode.expression
        }
        const text = staticStringOf(valueNode)
        if (text === null || isAllowedString(text)) return
        report(node, text)
      },

      CallExpression(node) {
        const name = calleeName(node.callee)
        if (!name || !USER_FACING_CALLS.some((re) => re.test(name))) return
        const text = staticStringOf(node.arguments[0])
        if (text === null || isAllowedString(text)) return
        report(node.arguments[0], text)
      },
    }
  },
}
