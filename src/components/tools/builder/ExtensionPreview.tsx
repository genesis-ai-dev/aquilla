import { useEffect, useMemo, useRef, useState } from "react"
import { FlaskConical } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount } from "@/lib/tools/builder-model"
import { createBridgeHost } from "@/lib/tools/host-bridge"
import { createToolHandlers } from "@/lib/tools/host-handlers"
import { defaultSmokeFixtures } from "@/lib/tools/smoke"
import { TOOL_SANDBOX, buildToolSrcdoc, readThemeVars } from "@/lib/tools/srcdoc"
import { cn } from "@/lib/utils"
import type { ToolManifest } from "../../../../shared/tools/manifest"

/** Frame height per mount: a side panel is tall and narrow, a page wide. */
const FRAME = { panel: "h-[420px] w-full max-w-[340px]", inline: "h-[260px] w-full", editor: "h-[440px] w-full", page: "h-[420px] w-full" } as const

/**
 * Review & try: the built extension, running for real in the same sandbox
 * and CSP as an installed one, against the smoke render's SAMPLE project
 * (made-up verses, writes that go nowhere). Nothing it does can reach the
 * user's project — that is what makes it safe to try before adding.
 */
export function ExtensionPreview({ source, manifest }: { source: string; manifest: ToolManifest }) {
  const t = useT()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // Ready for THIS srcdoc: a rebuilt candidate shows the loading state again.
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const mount = primaryMount(manifest.mounts)
  const srcdoc = useMemo(
    () =>
      buildToolSrcdoc(
        source,
        {
          tool: { id: "preview", name: manifest.name, version: 0, scopes: manifest.scopes },
          project: { id: "preview-project", name: t("extensions.candidate.preview") },
          user: { username: "preview", roleLevel: 700 },
          mount,
          ...(mount === "editor" ? { file: { fileId: "f1", name: "MAT" } } : {}),
          ...(mount === "inline" ? { cell: { fileId: "f1", cellId: "c1" } } : {}),
          theme: readThemeVars(),
        },
        { sdk: manifest.sdk },
      ),
    [source, manifest, mount, t],
  )

  useEffect(() => {
    const sample = defaultSmokeFixtures(manifest).find((f) => f.mount === mount) ?? defaultSmokeFixtures(manifest)[1]
    if (!sample) return
    const host = createBridgeHost({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      handlers: createToolHandlers(sample.data),
      authorize: async () => {},
      onReady: () => setReadyFor(srcdoc),
    })
    const stop = host.listen(window)
    return stop
  }, [srcdoc, manifest, mount])

  return (
    <figure className="flex flex-col gap-2" data-testid="extension-preview">
      <figcaption className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t("extensions.candidate.preview")}</span>
          <span className="block text-xs text-muted-foreground">{t("extensions.candidate.previewHint")}</span>
        </span>
      </figcaption>
      <div className="relative flex justify-center overflow-hidden rounded-xl border bg-muted/30 p-2">
        <iframe
          ref={frameRef}
          title={t("extensions.frame.title", { name: manifest.name })}
          sandbox={TOOL_SANDBOX}
          srcDoc={srcdoc}
          className={cn("rounded-lg border bg-background shadow-xs", FRAME[mount])}
          data-testid="extension-preview-frame"
        />
        {readyFor !== srcdoc && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Spinner className="size-4" />
            {t("extensions.candidate.previewLoading")}
          </div>
        )}
      </div>
    </figure>
  )
}
