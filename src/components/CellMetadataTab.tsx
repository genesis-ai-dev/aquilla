// Read-only "Metadata" tab body for the cell expansion panel (AQU-615).
//
// DCS TSV imports (Translation Notes / Questions, etc.) carry untranslated
// columns — supportReference, quote, occurrence, tags — in `cell.metadata`;
// OBS carries `metadata.attachments` ({ type: "image", url, alt } entries).
// This renders that bucket as a compact key/value list in the same visual
// language as the neighbouring expansion tabs (text-xs, muted keys,
// foreground values). No editing in v1.
//
// Contract: EditorTable only mounts this tab when `metadata` is a non-null
// object with at least one key, so an empty object renders an empty list —
// `hasCellMetadata` (exported below) is the gate.

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

/** Renders one metadata value in the most legible form available. */
function MetadataValue({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="text-foreground">{String(value)}</span>
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
  // Objects / other arrays: compact JSON fallback.
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground break-all">
      {JSON.stringify(value)}
    </code>
  )
}

/** Compact read-only key/value view of a cell's metadata bucket. */
export function CellMetadataTab({ metadata }: { metadata: Record<string, unknown> }) {
  return (
    <dl className="space-y-1.5 py-3 text-xs">
      {Object.entries(metadata).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="shrink-0 font-medium text-muted-foreground">{key}</dt>
          <dd className="min-w-0">
            <MetadataValue value={value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
