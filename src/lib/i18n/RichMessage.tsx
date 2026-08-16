/**
 * `<RichMessage>` — one translated sentence, with markup around its placeholders
 * (AQU-511).
 *
 * Extraction repeatedly hit the same wall. A sentence like
 *
 *     Attached to <span className="font-mono">{ref}</span>.
 *
 * has to become ONE catalog key, because splitting it into
 * `"Attached to "` + ref + `"."` freezes English word order and cannot be
 * translated into Burmese or Arabic. But keying the whole sentence as
 * `"Attached to {ref}."` and interpolating a plain string throws the markup away
 * — and the wave-3 review found seven places where exactly that silently dropped
 * meaning: the `<em>` distinguishing "who *can* edit" from "who is assigned", the
 * two `<strong>`s naming the conflicting values in the LTR/RTL warning, the
 * monospacing that marks a scripture reference as machine-readable.
 *
 * So the placeholder stays in the translated string and the *rendering* of each
 * placeholder is supplied here. The translator controls word order; the component
 * controls presentation; neither has to know about the other.
 *
 *     <RichMessage
 *       k="editor.footnote.attachedTo"
 *       values={{ ref: <span className="font-mono text-foreground">{ref}</span> }}
 *     />
 *
 * Plain values may be passed too — `{ count: 3 }` interpolates as text — so a
 * sentence with both a styled and an unstyled placeholder needs only one key.
 *
 * Placeholders the translation omits are simply not rendered, and placeholders the
 * translation keeps but `values` does not supply are left as literal `{name}`,
 * matching `interpolate()`'s behaviour rather than rendering `undefined`.
 *
 * A count-governed key may style the number itself — pass `count` for plural
 * selection and a node for `{count}` in `values`:
 *
 *     <RichMessage
 *       k="editor.expansion.endorsements"
 *       count={n}
 *       values={{ count: <span className="font-medium">{n}</span> }}
 *     />
 *
 * The number then chooses the plural form without being interpolated away, which
 * is why this resolves the template and the interpolation in two steps instead of
 * calling `t()`.
 */

import { Fragment, type ReactNode } from "react"
import { useI18n } from "./I18nProvider"
import { DEFAULT_LOCALE } from "./locales"
import { CATALOGS } from "./messages"
import type { MessageKey } from "./messages/en"
import { interpolate, selectTemplate, type TVars } from "./translate"

/** A placeholder's rendering: a node to substitute, or a value to interpolate. */
export type RichVars = Record<string, ReactNode>

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Split a resolved string on `{placeholder}` spans and substitute each one.
 *
 * Exported for testing without a React tree; prefer `<RichMessage>` in
 * components.
 */
export function renderRichMessage(resolved: string, values: RichVars): ReactNode[] {
  const out: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  PLACEHOLDER.lastIndex = 0
  while ((match = PLACEHOLDER.exec(resolved)) !== null) {
    if (match.index > cursor) out.push(resolved.slice(cursor, match.index))
    const name = match[1]
    // An unsupplied placeholder stays literal, so a missing value is visible in
    // review rather than rendering the word "undefined" to a user.
    out.push(name in values ? values[name] : match[0])
    cursor = match.index + match[0].length
  }
  if (cursor < resolved.length) out.push(resolved.slice(cursor))
  return out
}

export function RichMessage({
  k,
  values,
  count,
}: {
  /** Catalog key. Named `k` so JSX call sites stay short at the many use sites. */
  k: MessageKey
  /** Rendering for each `{placeholder}` in the string. */
  values: RichVars
  /**
   * Governing number for a count-based key. Passed through to plural selection;
   * also available to the string as `{count}` unless `values` overrides it.
   */
  count?: number
}) {
  const { locale } = useI18n()
  // Node-valued placeholders take no part in plural selection or in text
  // interpolation — they are substituted here, after the template is resolved.
  const nodeValues: RichVars = {}
  const textVars: TVars = {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number") textVars[name] = value
    else nodeValues[name] = value
  }
  // Selection and interpolation see different var sets. The governing count must
  // reach plural selection, but if `values` renders `{count}` as markup it must
  // NOT be interpolated — otherwise the digits become bare text and there is
  // nothing left for the markup to wrap.
  const scalars: TVars = count === undefined ? textVars : { count, ...textVars }
  const interpolationVars: TVars =
    count === undefined || "count" in nodeValues ? textVars : { count, ...textVars }
  // Same catalog choice the provider's t() makes; RichMessage needs the
  // uninterpolated template, which t() cannot hand back.
  const catalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE]
  const resolved = interpolate(selectTemplate(catalog, k, scalars, locale), interpolationVars)
  const nodes = renderRichMessage(resolved, nodeValues)
  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  )
}
