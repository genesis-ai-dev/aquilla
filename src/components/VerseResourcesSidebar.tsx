// Verse Resources sidebar (AQU-461) — the *visual* helps beside a verse.
//
// Parallel Bibles answers "how does another version word this?". This panel
// answers "what is this verse talking about?": the people, places, terms and
// flora/fauna the Aquifer corpus links to the tracked verse, each with its
// one-line gloss — and, for places that publish coordinates, a map.
//
// Sourcing: the gated `/api/v1/aquifer/page` route the Search dock already
// uses, so the project's `bibleResourcesEnabled` gate, the worker-side host
// allowlist and the Workers Cache all apply unchanged. Parsing, promise-caching
// and the map-tile math live in `@/lib/aquifer/passage-resources`.
//
// API kindness, mirroring ParallelBiblesSidebar: fetches fire only while the
// panel is open, the tracked ref is debounced so fast scrolling doesn't burst,
// pages are promise-cached for the tab's lifetime, and entity lookups are
// capped per verse (MAX_DETAIL_LOOKUPS).
//
// Maps are a mosaic of plain <img> OpenStreetMap tiles — no map library, no
// iframe, no third-party script — so the tile URLs ride the AQU-627 same-origin
// resource proxy like every other third-party content fetch in the SPA.

import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ExternalLink, MapPin, Shapes, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBoundary } from "./ErrorBoundary"
import { ResourcePaneCrash, ResourcePaneError } from "./ResourcePaneError"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  buildMapMosaic,
  formatCoordinates,
  loadEntityDetail,
  loadPassageEntities,
  MAX_DETAIL_LOOKUPS,
  osmPermalink,
  OSM_TILE_SIZE,
  passagePathFromRef,
  type AquiferEntityDetail,
  type AquiferEntityRef,
} from "@/lib/aquifer/passage-resources"

const OPEN_STORAGE_KEY_PREFIX = "aquilla:verse-resources:"

/** Map viewport inside the panel, in CSS pixels. */
const MAP_WIDTH = 272
const MAP_HEIGHT = 150

function openStateKey(projectId: string): string {
  return `${OPEN_STORAGE_KEY_PREFIX}${projectId}:open`
}

export function readVerseResourcesOpen(projectId: string): boolean {
  try {
    return window.localStorage.getItem(openStateKey(projectId)) === "true"
  } catch {
    return false
  }
}

export function writeVerseResourcesOpen(projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(openStateKey(projectId), value ? "true" : "false")
  } catch {
    // localStorage may be unavailable — ignore
  }
}

interface VerseResourcesSidebarProps {
  projectId: string
  /** Canonical ref of the first visible editor row (e.g. "MAT 2:1"). */
  trackedRef: string | null
  /** Mints the auth-worker JWT the aquifer routes require. */
  getJwt: () => string | null
  open: boolean
  onToggle: () => void
  className?: string
}

type DetailState =
  | { status: "loading" }
  | { status: "ready"; detail: AquiferEntityDetail }
  | { status: "error" }

/** Static OpenStreetMap locator, drawn from raster tiles. */
function LocatorMap({ detail, title }: { detail: AquiferEntityDetail; title: string }) {
  const t = useT()
  const coords = detail.coordinates!
  const mosaic = useMemo(() => buildMapMosaic(coords, MAP_WIDTH, MAP_HEIGHT), [coords])

  return (
    <div className="mt-2">
      <div
        role="img"
        aria-label={t("editor.resources.mapAria", {
          place: title,
          coords: formatCoordinates(coords),
        })}
        className="relative overflow-hidden rounded border bg-muted"
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
      >
        {mosaic.tiles.map((tile) => (
          <img
            key={tile.url}
            src={tile.url}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            width={OSM_TILE_SIZE}
            height={OSM_TILE_SIZE}
            className="absolute max-w-none select-none"
            style={{ left: tile.left, top: tile.top }}
          />
        ))}
        <MapPin
          aria-hidden
          className="absolute h-5 w-5 -translate-x-1/2 -translate-y-full fill-primary stroke-background drop-shadow"
          style={{ left: mosaic.marker.left, top: mosaic.marker.top }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatCoordinates(coords)}
        </span>
        <a
          href={osmPermalink(coords)}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-muted-foreground underline transition-colors hover:text-foreground"
        >
          {t("editor.resources.openMap")}
        </a>
      </div>
    </div>
  )
}

function EntityCard({
  entity,
  state,
}: {
  entity: AquiferEntityRef
  state: DetailState | undefined
}) {
  const t = useT()
  const detail = state?.status === "ready" ? state.detail : null

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium leading-snug">{entity.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {entity.kind && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[9px] capitalize">
              {entity.kind.replace("-", " ")}
            </Badge>
          )}
          {detail && (
            <AppTooltip content={t("editor.resources.openExternal")}>
              <a
                href={detail.url}
                target="_blank"
                rel="noreferrer"
                aria-label={t("editor.resources.openExternalAria", { entity: entity.title })}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </AppTooltip>
          )}
        </div>
      </div>

      {/* i18n-exempt "loading" is a DetailState discriminant, not copy */}
      {state?.status === "loading" && (
        <div className="mt-1 flex items-center text-muted-foreground" aria-label={t("common.loading")}>
          <Spinner className="size-3.5" />
        </div>
      )}

      {detail?.summary && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail.summary}</p>
      )}

      {detail?.image && (
        <img
          src={detail.image.url}
          alt={detail.image.alt || entity.title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="mt-2 w-full rounded border object-cover"
        />
      )}

      {detail?.coordinates && <LocatorMap detail={detail} title={entity.title} />}
    </div>
  )
}

/** Pane-local crash boundary — a render throw here must not take the workspace
 *  down until the translator reloads the page (AQU-849). */
export function VerseResourcesSidebar(props: VerseResourcesSidebarProps) {
  return (
    <ErrorBoundary
      label="verse-resources-sidebar"
      fallback={(reset) => <ResourcePaneCrash onRetry={reset} />}
    >
      <VerseResourcesSidebarBody {...props} />
    </ErrorBoundary>
  )
}

function VerseResourcesSidebarBody({
  projectId,
  trackedRef,
  getJwt,
  open,
  onToggle,
  className,
}: VerseResourcesSidebarProps) {
  const t = useT()
  const [entities, setEntities] = useState<AquiferEntityRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<Map<string, DetailState>>(new Map())
  // Retry re-arms the lookup without a page reload; see ParallelBiblesSidebar.
  const [retryNonce, setRetryNonce] = useState(0)

  // Hold the last verse-scoped ref so headings and chapter rows don't blank the
  // panel as the translator scrolls past them.
  const lastPathRef = useRef<string | null>(null)
  const path = trackedRef ? passagePathFromRef(trackedRef) : null
  if (path) lastPathRef.current = path
  const trackedPath = path ?? lastPathRef.current

  // Debounced path — fast scrolling shouldn't fetch every verse passed over.
  const [debouncedPath, setDebouncedPath] = useState(trackedPath)
  useEffect(() => {
    if (trackedPath === debouncedPath) return
    const timer = window.setTimeout(() => setDebouncedPath(trackedPath), 300)
    return () => window.clearTimeout(timer)
  }, [trackedPath, debouncedPath])

  // Load the tracked verse's entity list.
  useEffect(() => {
    if (!open || !debouncedPath) return
    const jwt = getJwt()
    if (!jwt) return
    let cancelled = false
    setEntities(null)
    setError(null)
    loadPassageEntities(jwt, projectId, debouncedPath)
      .then((list) => {
        if (!cancelled) setEntities(list)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntities([])
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open, debouncedPath, projectId, getJwt, retryNonce])

  // Load each listed entity's header (gloss / coordinates / image), capped.
  useEffect(() => {
    if (!open || !entities || entities.length === 0) return
    const jwt = getJwt()
    if (!jwt) return
    let cancelled = false

    for (const entity of entities.slice(0, MAX_DETAIL_LOOKUPS)) {
      setDetails((prev) => {
        if (prev.has(entity.path)) return prev
        const next = new Map(prev)
        next.set(entity.path, { status: "loading" })
        return next
      })
      loadEntityDetail(jwt, projectId, entity.path)
        .then((detail) => {
          if (cancelled) return
          setDetails((prev) => new Map(prev).set(entity.path, { status: "ready", detail }))
        })
        .catch(() => {
          if (cancelled) return
          setDetails((prev) => new Map(prev).set(entity.path, { status: "error" }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [open, entities, projectId, getJwt])

  // Closed: slim edge tab so the helps are one click away while reading.
  if (!open) {
    return (
      <AppTooltip content={t("editor.resources.openTooltip")} side="left">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("editor.resources.show")}
          className={cn(
            "hidden h-full w-9 shrink-0 flex-col items-center gap-1.5 border-l bg-background pt-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex",
            className,
          )}
        >
          <Shapes className="h-4 w-4" />
          <span className="text-sm font-semibold tracking-wide [writing-mode:vertical-rl]">
            {t("editor.resources.edgeTab")}
          </span>
        </button>
      </AppTooltip>
    )
  }

  const trackedLabel = trackedPath
    ? trackedPath.replace(/^\/[a-z-]+\/passages\//, "").replace(/\/$/, "").replace(/\//g, " ")
    : null
  const shown = entities?.slice(0, MAX_DETAIL_LOOKUPS) ?? []

  return (
    <RightSidebarPanel
      storageKey="verse-resources"
      defaultWidth={320}
      minWidth={300}
      className={cn("hidden sm:flex", className)}
      resizeLabel="Resize verse resources panel"
    >
      <div className="flex h-full w-full flex-col border-l bg-card text-sm">
        {/* Header — p-2 matches the other side panels' header strip. */}
        <div className="flex items-center justify-between border-b p-2">
          <div className="flex items-center gap-1.5 font-medium">
            <Shapes className="h-4 w-4 text-muted-foreground" />
            <span>{t("editor.resources.title")}</span>
            {trackedLabel && (
              <span className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-muted-foreground">
                {trackedLabel}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("editor.resources.hide")}
            onClick={onToggle}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {!trackedPath ? (
            <p className="p-4 text-xs text-muted-foreground">
              {t("editor.resources.scrollHint")}
            </p>
          ) : error ? (
            <ResourcePaneError
              className="p-4"
              message={t("editor.resources.failedToLoad", { error })}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : entities === null ? (
            <div
              className="flex items-center justify-center p-4 text-muted-foreground"
              aria-label={t("common.loading")}
            >
              <Spinner className="size-4" />
            </div>
          ) : shown.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {t("editor.resources.noneForRef", { ref: trackedLabel ?? "" })}
            </p>
          ) : (
            <div className="divide-y">
              {shown.map((entity) => (
                <EntityCard key={entity.path} entity={entity} state={details.get(entity.path)} />
              ))}
            </div>
          )}
        </div>

        {/* Footer: attribution for both upstreams the panel draws from. */}
        <div className="border-t px-3 py-2">
          <p className="text-[10px] text-muted-foreground/60">
            {t("editor.resources.attribution")}{" "}
            <a
              href="https://bibletranslation.org/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {/* i18n-exempt: proper-noun name of the external corpus this data is sourced from */}
              Bible Aquifer
            </a>
            {" · "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {/* i18n-exempt: proper-noun name of the map data provider, per its attribution terms */}
              © OpenStreetMap contributors
            </a>
          </p>
        </div>
      </div>
    </RightSidebarPanel>
  )
}
