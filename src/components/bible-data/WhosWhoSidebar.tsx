// Who's Who panel (AQU-1689): the right rail's "People" panel.
//
// The cast of the passage (OpenText pericope) the editor is showing, from the
// Bible Knowledge Pack: who is in it, how often each is referred to, gender
// and number, the first mention, previous/next mention from where the editor
// is, and two flags a translator may want to act on (see people-index).
// Choosing a participant filters the editor to the cells that mention them;
// the editor shows the same bar it shows for "Show every line by …".
//
// Like Verse Resources: open, a resizable panel; closed, a slim edge tab;
// hidden below `sm`. It reads nothing until it is opened. It follows the
// first verse in view (`trackedRef`), and talks to the editor through the
// Bible data bus, so the workspace only renders it.

import { useMemo, type ReactNode } from "react"
import { UsersRound, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { BIBLE_DATA_SOURCE_SHORT_NAME_KEYS } from "@/lib/bible-data/enrichment-labels"
import { isOriginalLanguageTag } from "@/lib/bible-data/macula-alignment"
import type { BkpEntityId } from "@/lib/bible-data/pack-types"
import { pericopeAt, pericopeCast, peopleIndexFor } from "@/lib/bible-data/people-index"
import { cellVerses } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { normalizeLanguageTag } from "@/lib/language-normalize"
import type { ProjectRecord } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"
import { BIBLE_ENRICHMENTS } from "../../../db/shared/bible-enrichments"
import { RightSidebarPanel } from "../RightSidebarPanel"
import { WhosWhoCast, type CastActions } from "./WhosWhoCast"
import { requestBibleFilter, requestMentionJump, useActiveBibleFilter } from "./bible-data-bus"
import { participantName } from "./people-text"
import { usePeoplePack, type PeoplePack } from "./people-pack"
import { useEntityLabels } from "./useEntityLabels"

interface WhosWhoSidebarProps {
  project: ProjectRecord
  /** The file the editor shows, which filters and jumps go to. */
  fileId: string | null
  /** Canonical ref of the first visible editor row (e.g. "JHN 4:7"). */
  trackedRef: string | null
  /** The open file's source language, else the project's. */
  sourceLanguage: string | null | undefined
  open: boolean
  onToggle: () => void
  className?: string
}

export function WhosWhoSidebar({ open, onToggle, className, ...rest }: WhosWhoSidebarProps) {
  const t = useT()
  if (!open) {
    // Closed: a slim edge tab, so the cast is one click away while reading.
    return (
      <AppTooltip content={t("bibleData.whosWho.panel.openTooltip")} side="left">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("bibleData.whosWho.panel.showAria")}
          data-testid="whos-who-edge-tab"
          className={cn(
            "hidden h-full w-9 shrink-0 flex-col items-center gap-1.5 border-s bg-background pt-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex",
            className,
          )}
        >
          <UsersRound className="h-4 w-4" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-wide [writing-mode:vertical-rl]">
            {t("bibleData.whosWho.panel.edgeTab")}
          </span>
        </button>
      </AppTooltip>
    )
  }
  return (
    <RightSidebarPanel
      storageKey="whos-who"
      defaultWidth={300}
      minWidth={260}
      className={cn("hidden sm:flex", className)}
      resizeLabel={t("bibleData.whosWho.panel.resizeAria")}
    >
      <WhosWhoPanel {...rest} onToggle={onToggle} />
    </RightSidebarPanel>
  )
}

const UNAVAILABLE_KEYS: Readonly<Record<Extract<PeoplePack, { ok: false }>["reason"], MessageKey>> = {
  offline: "bibleData.whosWho.panel.unavailable.offline",
  "not-found": "bibleData.whosWho.panel.unavailable.notFound",
  invalid: "bibleData.whosWho.panel.unavailable.invalid",
}

function WhosWhoPanel({
  project,
  fileId,
  trackedRef,
  sourceLanguage,
  onToggle,
}: Omit<WhosWhoSidebarProps, "open" | "className">) {
  const t = useT()
  const fmt = useFormat()
  const here = useMemo(() => (trackedRef ? cellVerses({ ref: trackedRef }) : null), [trackedRef])
  const pack = usePeoplePack(here?.book ?? null, { structure: true, text: true })
  const loaded = pack?.ok ? pack : null
  const index = useMemo(
    () => (loaded ? peopleIndexFor(loaded.version, loaded.people, loaded.structure, loaded.text) : null),
    [loaded],
  )
  const labelFor = useEntityLabels(project, loaded ? loaded.people.entities : null)
  const nameOf = useMemo(() => {
    if (!index || !labelFor) return null
    const unnamed = t("bibleData.whosWho.unknownParticipant")
    return (entityId: BkpEntityId): string =>
      participantName(entityId, index.entities, labelFor, (items) => fmt.list(items, { type: "conjunction" })) ?? unnamed
  }, [index, labelFor, fmt, t])

  const pericope = index && here ? pericopeAt(index, here.refs[0]) : null
  const cast = index && pericope ? pericopeCast(index, pericope) : null
  const active = useActiveBibleFilter(fileId)
  const actions: CastActions = {
    filtering: active?.kind === "mentions" ? active.entity : null,
    toggleFilter: (entity) => {
      if (!fileId) return
      const on = active?.kind === "mentions" && active.entity === entity
      requestBibleFilter(fileId, on ? null : { kind: "mentions", entity })
    },
    jump: (ref) => {
      if (fileId) requestMentionJump(fileId, ref)
    },
  }
  const originalSource = isOriginalLanguageTag(normalizeLanguageTag(sourceLanguage))
  const { sources, license } = BIBLE_ENRICHMENTS["whos-who"]

  let body: ReactNode
  if (!here) {
    body = <p className="p-4 text-xs text-muted-foreground">{t("bibleData.whosWho.panel.scrollHint")}</p>
  } else if (!pack) {
    body = (
      <div className="flex items-center justify-center p-4 text-muted-foreground" aria-label={t("common.loading")}>
        <Spinner className="size-4" />
      </div>
    )
  } else if (!pack.ok) {
    body = <p className="p-4 text-xs text-muted-foreground">{t(UNAVAILABLE_KEYS[pack.reason])}</p>
  } else if (!index || !pericope || !cast || !nameOf) {
    body = (
      <p className="p-4 text-xs text-muted-foreground">
        {t("bibleData.whosWho.panel.noPassage", { ref: fmt.isolate(here.refs[0]) })}
      </p>
    )
  } else {
    body = (
      <>
        <div className="border-b px-3 py-2">
          <p lang="en" dir="auto" className="text-sm font-medium" data-testid="whos-who-passage">
            {pericope.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("bibleData.whosWho.panel.range", {
              from: fmt.isolate(pericope.fromRef),
              to: fmt.isolate(pericope.toRef),
            })}
          </p>
        </div>
        <WhosWhoCast index={index} cast={cast} hereRefs={here.refs} nameOf={nameOf} actions={actions} />
        {!originalSource && (
          <p data-testid="whos-who-alignment-note" className="border-t px-3 py-2 text-xs text-muted-foreground">
            {t("bibleData.whosWho.panel.alignmentNote")}
          </p>
        )}
      </>
    )
  }

  return (
    <div data-testid="whos-who-panel" className="flex h-full w-full flex-col border-s bg-card text-sm">
      <div className="flex items-center justify-between border-b p-2">
        <div className="flex items-center gap-1.5 font-medium">
          <UsersRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span>{t("bibleData.enrichment.whosWho.label")}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("bibleData.whosWho.panel.hideAria")}
          onClick={onToggle}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">{body}</div>
      <div className="border-t px-3 py-2">
        <p className="text-[10px] text-muted-foreground/70">
          {t("bibleData.enrichment.sourceChip", {
            sources: fmt.list(sources.map((source) => t(BIBLE_DATA_SOURCE_SHORT_NAME_KEYS[source]))),
            license,
          })}
        </p>
      </div>
    </div>
  )
}
