import { useEffect, useState } from "react"
import { History, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { versionRequest } from "@/lib/tools/builder-model"
import { fetchToolSource, listToolVersions, saveToolVersion, type ToolDetail, type ToolVersion } from "@/lib/tools/tools-api"

/**
 * Every version of an extension, newest first: how it was made, the words it
 * was made from, and "Go back to this version" — which saves the old code as a
 * NEW version, so history only grows and changes stay attributable.
 */
export function VersionList({
  projectId,
  jwt,
  tool,
  onRestored,
}: {
  projectId: string
  jwt: string
  tool: ToolDetail
  onRestored: (next: ToolDetail, from: number) => void
}) {
  const t = useT()
  const [versions, setVersions] = useState<ToolVersion[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listToolVersions(jwt, projectId, tool.id)
      .then((list) => {
        if (!cancelled) setVersions([...list].sort((a, b) => b.version - a.version))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, tool.id, tool.currentVersion])

  const restore = async (v: ToolVersion) => {
    setBusy(v.version)
    setError(null)
    try {
      const { source } = await fetchToolSource(jwt, projectId, tool.id, v.version)
      const next = await saveToolVersion(jwt, projectId, tool.id, {
        source,
        manifest: v.manifest,
        origin: "edit",
        buildMeta: { request: t("extensions.versions.restoreRequest", { version: v.version }), restoredFrom: v.version, fromVersion: tool.currentVersion },
      })
      onRestored(next, v.version)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="versions-heading" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted-foreground" aria-hidden />
        <h3 id="versions-heading" className="text-sm font-medium">{t("extensions.versions.heading")}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t("extensions.versions.hint")}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {versions === null && !error ? (
        <Spinner />
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border bg-card" data-testid="tool-versions">
          {(versions ?? []).map((v) => {
            const current = v.version === tool.currentVersion
            const words = versionRequest(v)
            return (
              <li key={v.version} className="flex items-start gap-3 px-3.5 py-2.5 text-sm" data-testid="tool-version">
                <span className="mt-0.5 w-8 shrink-0 font-mono text-xs text-muted-foreground">{t("extensions.version", { version: v.version })}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>{t(`extensions.versions.origin.${v.origin}`)}</span>
                    {current && <Badge variant="soft">{t("extensions.versions.current")}</Badge>}
                    <span className="text-xs text-muted-foreground">{fmtShortCalendarDate(v.createdAt)}</span>
                  </span>
                  {words && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">“{words}”</span>}
                </span>
                {!current && (
                  <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void restore(v)}>
                    {busy === v.version ? <Spinner className="size-3" /> : <RotateCcw className="size-3" aria-hidden />}
                    {t("extensions.versions.restore")}
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
