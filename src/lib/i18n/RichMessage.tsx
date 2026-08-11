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
 */

import { Fragment, type ReactNode } from "react"
import { useI18n } from "./I18nProvider"
import { CATALOGS } from "./messages"
import { en, type MessageKey } from "./messages/en"
import { isPluralMessage, selectPluralForm } from "./plurals"
import { interpolate, type TVars } from "./translate"

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
   * Governing number for a count-based key. Always used for plural selection;
   * also interpolated into the string as `{count}` unless `values` supplies a
   * node for `count`, in which case the node is drawn there instead.
   */
  count?: number
}) {
  const { t, locale } = useI18n()
  // Only scalars can take part in plural selection and text interpolation, so
  // node-valued placeholders are resolved here, after t(), not inside it.
  const scalars: TVars = {}
  const nodeValues = Object.fromEntries(
    Object.entries(values).filter(
      ([, v]) => typeof v !== "string" && typeof v !== "number",
    ),
  )
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" || typeof value === "number") scalars[name] = value
  }
  const base = en[k]
  // The count itself is often the thing that carries markup — a bold,
  // tabular-figure numeral inside an otherwise muted sentence. `values` then
  // "overrides" `{count}`, and handing the number to `t()` as a var would defeat
  // that: `interpolate` would consume `{count}` and leave the node nothing to
  // replace. So when `count` is rendered as a node, selection is done here with
  // the real number and only the *other* vars are interpolated. Selection has to
  // see the number — a locale with six plural categories cannot be served by a
  // call-site `=== 1` branch, which is the whole reason `count` exists.
  const countIsNode = "count" in nodeValues
  if (count !== undefined && !countIsNode) scalars.count = count
  const resolved =
    countIsNode && count !== undefined && isPluralMessage(base)
      ? interpolate(selectPluralForm(CATALOGS[locale]?.[k], base, locale, { count }), scalars)
      : t(k, scalars)
  const nodes = renderRichMessage(resolved, nodeValues)
  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  )
}
