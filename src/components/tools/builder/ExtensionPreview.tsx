import { useEffect, useMemo, useRef, useState } from "react"
import { FlaskConical } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount } from "@/lib/tools/builder-model"
import { createBridgeHost } from "@/lib/tools/host-bridge"
import { createToolHandlers } from "@/lib/tools/host-handlers"
import { defaultSmokeFixtures } from "@/lib/tools/smoke"
import { TOOL_SANDBOX, buildToolSrcdoc, readThemeVars } from "@/lib/tools/srcdoc"
import { cn } from "@/lib/utils"
import { ExtensionFrame } from "../ExtensionFrame"
import type { ToolManifest } from "../../../../shared/tools/manifest"

/** The frame takes the shape of where it will live: a side panel is narrow
 *  and tall, an editor or page wide. */
const FRAME = { panel: "h-[480px] w-full sm:w-[340px] sm:shrink-0", inline: "h-[240px] w-full", editor: "h-[520px] w-full", page: "h-[520px] w-full" } as const

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
    const fixtures = defaultSmokeFixtures(manifest)
    const sample = fixtures.find((f) => f.mount === mount) ?? fixtures[1]
    if (!sample) return
    const host = createBridgeHost({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      handlers: createToolHandlers(sample.data),
      authorize: async () => {},
      onReady: () => setReadyFor(srcdoc),
    })
    return host.listen(window)
  }, [srcdoc, manifest, mount])

  const frame = (
    <ExtensionFrame name={manifest.name} className={FRAME[mount]}>
    <div className="relative min-h-0 flex-1">
      <iframe
        ref={frameRef}
        title={t("extensions.frame.title", { name: manifest.name })}
        sandbox={TOOL_SANDBOX}
        srcDoc={srcdoc}
        className="size-full bg-background"
        data-testid="extension-preview-frame"
      />
      {readyFor !== srcdoc && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground" aria-live="polite">
          <Spinner className="size-4" />
          {t("extensions.candidate.previewLoading")}
        </div>
      )}
    </div>
    </ExtensionFrame>
  )

  return (
    <figure
      className="relative overflow-hidden rounded-2xl border bg-muted/40 bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] p-3 pt-12 sm:p-4 sm:pt-12 dark:bg-input/20"
      data-testid="extension-preview"
    >
      <figcaption className="absolute start-3 top-3">
        <AppTooltip content={t("extensions.candidate.previewHint")}>
          <span tabIndex={0} className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background/90 px-2.5 text-xs font-medium text-foreground/80 backdrop-blur-sm">
            <span className="relative flex size-1.5" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
            {t("extensions.candidate.preview")}
            <FlaskConical className="size-3 text-muted-foreground" aria-hidden />
          </span>
        </AppTooltip>
      </figcaption>
      {mount === "panel" ? (
        <div className="flex gap-3">
          <MockVerses className="hidden flex-1 sm:flex" />
          {frame}
        </div>
      ) : mount === "inline" ? (
        <div className="flex flex-col gap-2">
          <MockVerses rows={1} />
          {frame}
          <MockVerses rows={2} />
        </div>
      ) : (
        frame
      )}
    </figure>
  )
}

/** A faint stand-in for the editor's verse column, so a side panel reads as
 *  "this sits next to your verses". Decorative. */
function MockVerses({ rows = 8, className }: { rows?: number; className?: string }) {
  const widths = ["w-11/12", "w-4/5", "w-full", "w-3/4", "w-10/12", "w-2/3", "w-11/12"]
  return (
    <div className={cn("flex flex-col gap-1 rounded-xl border border-dashed bg-background/50 p-3 opacity-70 dark:bg-transparent", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-lg px-1 py-2">
          <span className="mt-0.5 h-2 w-5 shrink-0 rounded-full bg-muted-foreground/20" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className={cn("h-2 rounded-full bg-muted-foreground/15", widths[i % widths.length])} />
            <span className={cn("h-2 rounded-full bg-muted-foreground/10", widths[(i + 3) % widths.length])} />
          </span>
        </div>
      ))}
    </div>
  )
}
