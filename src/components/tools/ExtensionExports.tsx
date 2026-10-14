/**
 * apiRev 7: export formats contributed by Smart Extensions (manifest
 * `exports`), offered in the normal export dialog. A format with `tags` is
 * offered only for a file carrying one of them. Choosing one runs the
 * extension headless (HeadlessRuns) with the active file; it hands its files
 * back with aquilla.export.deliver and the download starts.
 */

import { useEffect, useState } from "react"
import { Blocks } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchProjectFiles } from "@/lib/sync/cells-read"
import { useToolsMount } from "./ToolsMountContext"

export function ExtensionExports({
  projectId,
  fileId,
  lane,
  getToken,
}: {
  projectId: string
  fileId: string | null
  lane: string
  getToken: (fileId: string) => Promise<string | null>
}) {
  const t = useT()
  const ctx = useToolsMount()
  const [tags, setTags] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const formats = (ctx?.tools ?? []).flatMap((tool) => (tool.manifest.exports ?? []).map((x) => ({ tool, format: x })))
  const needsTags = formats.some(({ format }) => format.tags && format.tags.length > 0)

  useEffect(() => {
    if (!fileId || !needsTags) return
    let alive = true
    void getToken(fileId)
      .then((token) => (token ? fetchProjectFiles(projectId, token) : []))
      .then((files) => {
        if (alive) setTags(files.find((f) => f.fileId === fileId)?.extension?.tags ?? [])
      })
      .catch(() => alive && setTags([]))
    return () => {
      alive = false
    }
  }, [projectId, fileId, needsTags, getToken])

  if (!ctx || !fileId) return null
  const offered = formats.filter(({ format }) => !format.tags?.length || format.tags.some((tag) => tags?.includes(tag)))
  if (offered.length === 0) return null

  return (
    <section className="flex flex-col gap-2" data-testid="extension-exports" aria-label={t("extensions.export.groupLabel")}>
      <h3 className="text-xs font-medium text-muted-foreground">{t("extensions.export.groupLabel")}</h3>
      <div className="flex flex-wrap gap-2">
        {offered.map(({ tool, format }) => {
          const key = `${tool.id}:${format.id}`
          return (
            <Button
              key={key}
              size="sm"
              variant="outline"
              disabled={busy !== null}
              data-testid="extension-export"
              onClick={() => {
                setBusy(key)
                setError(null)
                void ctx.runExport(tool.id, format.id, [fileId], lane).then((outcome) => {
                  setBusy(null)
                  if (!outcome.ok) setError(outcome.error)
                })
              }}
              title={tool.name}
            >
              {busy === key ? <Spinner className="size-3.5" /> : <Blocks className="size-3.5" aria-hidden />}
              {format.label} <span className="text-muted-foreground">.{format.extension}</span>
            </Button>
          )
        })}
      </div>
      {busy && <p className="text-xs text-muted-foreground">{t("extensions.export.running", { extension: offered.find((o) => `${o.tool.id}:${o.format.id}` === busy)?.tool.name ?? "" })}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
