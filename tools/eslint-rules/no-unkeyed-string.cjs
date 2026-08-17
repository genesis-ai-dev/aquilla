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
 * String-bearing JSX expressions are inspected as well as plain literals.
 * This covers the common regression shapes that the original rule missed:
 * interpolated templates, conditional branches, concatenation, and dynamic
 * values of translatable attributes.
 *
 * Escape hatch: `// i18n-exempt <reason>` on the line or the line above, or the
 * standard `// eslint-disable-next-line i18n/no-unkeyed-string`.
 *
 * KNOWN LIMITATIONS (see docs/swarm/TRACES.md SWARM-TODO for the follow-up
 * workstream — a typed `MessageKey` prop convention is the planned fix):
 *
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

/**
 * Return string-bearing nodes from a value that is known to reach a
 * user-visible position. We intentionally do not walk arbitrary calls or
 * identifiers: `t("key")`, formatter output, and server-provided content are
 * already dynamic. The selected expression shapes all contain authored copy
 * directly in the component.
 */
function visibleStringsOf(node) {
  if (!node) return []

  const staticText = staticStringOf(node)
  if (staticText !== null) return [{ node, text: staticText }]

  switch (node.type) {
    case 'TemplateLiteral': {
      const text = node.quasis
        .map((q, index) => `${q.value.cooked ?? ''}${index < node.expressions.length ? '{…}' : ''}`)
        .join('')
      return [{ node, text }]
    }
    case 'ConditionalExpression':
      return [...visibleStringsOf(node.consequent), ...visibleStringsOf(node.alternate)]
    case 'LogicalExpression':
    case 'BinaryExpression':
      return [...visibleStringsOf(node.left), ...visibleStringsOf(node.right)]
    case 'ArrayExpression':
      return node.elements.flatMap((element) => visibleStringsOf(element))
    case 'SequenceExpression':
      return node.expressions.flatMap((expression) => visibleStringsOf(expression))
    // TypeScript/ESTree wrappers around the actual rendered expression.
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
    case 'ChainExpression':
      return visibleStringsOf(node.expression)
    default:
      return []
  }
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

    const reportVisibleStrings = (node) => {
      for (const candidate of visibleStringsOf(node)) {
        if (!isAllowedString(candidate.text)) report(candidate.node, candidate.text)
      }
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
        reportVisibleStrings(valueNode)
      },

      JSXExpressionContainer(node) {
        // Attribute expression containers are handled above so a literal is
        // reported once. Child containers are visible JSX content.
        if (node.parent?.type === 'JSXAttribute') return
        reportVisibleStrings(node.expression)
      },

      CallExpression(node) {
        const name = calleeName(node.callee)
        if (!name || !USER_FACING_CALLS.some((re) => re.test(name))) return
        reportVisibleStrings(node.arguments[0])
      },
    }
  },
}
