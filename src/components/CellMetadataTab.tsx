// Read-only "Metadata" tab body for the cell expansion panel (AQU-615).
//
// DCS TSV imports (Translation Notes / Questions, etc.) carry untranslated
// columns — supportReference, quote, occurrence, tags — in `cell.metadata`;
// OBS carries `metadata.attachments` ({ type: "image", url, alt } entries).
// This renders that bucket as a compact key/value list in the same visual
// language as the neighbouring expansion tabs (text-xs, muted keys,
// foreground values). No editing in v1.
//
// Nested objects/arrays recurse into the same key/value layout so a translator
// reads labelled rows rather than a JSON blob; anything that doesn't fit that
// shape (too deep, non-plain values) still falls back to compact JSON.
//
// Contract: EditorTable only mounts this tab when `metadata` is a non-null
// object with at least one key, so an empty object renders an empty list —
// `hasCellMetadata` (exported below) is the gate.

import { Checkbox } from "@/components/ui/checkbox"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  displayFieldLabel,
  setCellDisplayField,
  useCellDisplayFields,
} from "@/lib/store/cell-display-fields"

/** True when the metadata bucket is worth showing a tab for. */
export function hasCellMetadata(
  metadata: Record<string, unknown> | null | undefined,
): metadata is Record<string, unknown> {
  return metadata != null && typeof metadata === "object" && Object.keys(metadata).length > 0
}

interface AttachmentLike {
  type?: unknown
  url?: unknown
  alt?: unknown
}

// Metadata originates from imported third-party repos (e.g. DCS) — only ever
// link/embed http(s) URLs so a hostile `javascript:`/`data:` value cannot run.
const isSafeUrl = (url: string): boolean => /^https?:\/\//i.test(url)

const isAttachmentArray = (value: unknown): value is AttachmentLike[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item) =>
      item != null &&
      typeof item === "object" &&
      typeof (item as AttachmentLike).url === "string",
  )

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value)

// Past this nesting depth the labelled layout costs more indentation than it
// buys in legibility, so we stop recursing and show the raw JSON.
const MAX_DEPTH = 3

function JsonFallback({ value }: { value: unknown }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground break-all">
      {JSON.stringify(value) ?? String(value)}
    </code>
  )
}

/** Renders one metadata value in the most legible form available. */
function MetadataValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isPrimitive(value)) {
    return <span className="text-foreground">{String(value)}</span>
  }
  if (value == null) {
    return <span className="text-muted-foreground">—</span>
  }
  if (isAttachmentArray(value)) {
    return (
      <span className="flex flex-wrap items-start gap-1.5">
        {value.map((att, i) => {
          const url = att.url as string
          if (!isSafeUrl(url)) {
            return (
              <code key={`${url}-${i}`} className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground break-all">
                {url}
              </code>
            )
          }
          const isImage =
            att.type === "image" || /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url)
          return isImage ? (
            <img
              key={`${url}-${i}`}
              src={url}
              alt={typeof att.alt === "string" ? att.alt : ""}
              className="max-h-16 rounded"
              loading="lazy"
            />
          ) : (
            <a
              key={`${url}-${i}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-2 break-all"
            >
              {url}
            </a>
          )
        })}
      </span>
    )
  }
  if (depth >= MAX_DEPTH) {
    return <JsonFallback value={value} />
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">—</span>
    }
    // A flat list of labels (DCS `tags`, say) reads best as chips; anything
    // with structure in it gets one labelled block per entry.
    if (value.every(isPrimitive)) {
      return (
        <span className="flex flex-wrap items-baseline gap-1">
          {value.map((item, i) => (
            <span
              key={`${String(item)}-${i}`}
              className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground break-all"
            >
              {String(item)}
            </span>
          ))}
        </span>
      )
    }
    return (
      <span className="flex flex-col gap-1.5">
        {value.map((item, i) => (
          <span key={i} className="flex items-baseline gap-2">
            <span className="shrink-0 font-medium text-muted-foreground">{i + 1}.</span>
            <span className="min-w-0">
              <MetadataValue value={item} depth={depth + 1} />
            </span>
          </span>
        ))}
      </span>
    )
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return <span className="text-muted-foreground">—</span>
    }
    return (
      <span className="flex flex-col gap-1.5">
        {entries.map(([key, child]) => (
          <span key={key} className="flex items-baseline gap-2">
            <span className="shrink-0 font-medium text-muted-foreground">{key}</span>
            <span className="min-w-0">
              <MetadataValue value={child} depth={depth + 1} />
            </span>
          </span>
        ))}
      </span>
    )
  }
  return <JsonFallback value={value} />
}

/**
 * Compact read-only key/value view of a cell's metadata bucket.
 *
 * AQU-1369: with a `projectId`, every key whose value can read as a label gets
 * a "show on cells" checkbox. It is a project-wide display setting — checking
 * it here labels every cell in the project that carries the key, and
 * unchecking it from any such cell clears it everywhere. A nested object's
 * fields get their own checkboxes one level down, keyed `parent.child` —
 * SDBH keeps every field under `sdbh`, so without this it offered none.
 * Attachments and deeper structures get no checkbox: they have no one-line
 * label to show.
 */
export function CellMetadataTab({
  metadata,
  projectId,
}: {
  metadata: Record<string, unknown>
  projectId?: string
}) {
  const t = useT()
  const displayFields = useCellDisplayFields(projectId)

  const toggle = (fieldKey: string, value: unknown) =>
    projectId && displayFieldLabel(value) != null ? (
      <Checkbox
        className="self-center"
        checked={displayFields.includes(fieldKey)}
        onCheckedChange={(checked) => setCellDisplayField(projectId, fieldKey, checked === true)}
        aria-label={t("editor.metadata.showOnCells", { key: fieldKey })}
        title={t("editor.metadata.showOnCells", { key: fieldKey })}
      />
    ) : null

  return (
    <dl className="space-y-1.5 py-3 text-xs">
      {Object.entries(metadata).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2">
          {toggle(key, value)}
          <dt className="shrink-0 font-medium text-muted-foreground">{key}</dt>
          <dd className="min-w-0">
            {projectId && isPlainObject(value) && Object.keys(value).length > 0 ? (
              <span className="flex flex-col gap-1.5">
                {Object.entries(value).map(([child, childValue]) => (
                  <span key={child} className="flex items-baseline gap-2">
                    {toggle(`${key}.${child}`, childValue)}
                    <span className="shrink-0 font-medium text-muted-foreground">{child}</span>
                    <span className="min-w-0">
                      <MetadataValue value={childValue} depth={1} />
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <MetadataValue value={value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
