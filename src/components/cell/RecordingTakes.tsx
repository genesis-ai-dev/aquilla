// The expanded cell's Recording tab, as one job (Sam, 2026-09-29): choose which
// take this line uses, and check that it says the text.
//
// Per track, the take that PLAYS sits on top (CellTakeBlock), and every other
// take is listed under it (TakesStrip, variant "tab") with how it compares with
// the text and a check to use it instead. The default track's recordings and
// generated voices are one list, since only one of them can play; each added
// track has its own section, headed by its name and colour once there is more
// than one. A heard line that performs this line (dubbing) gets a section of
// its own, last.
//
// Making takes is the recorder's (New take opens it); placing them is the
// timeline's; voice, volume and colour are the Audio view card's. The take
// that plays is validated here as from the line's audio check (Sam,
// 2026-09-30); the listed takes show their validation read-only.

import { useMemo } from "react"
import { Mic } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { useT } from "@/lib/i18n/I18nProvider"
import { useRecordingTextDrift } from "@/hooks/useRecordingTextDrift"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioIdSeededWith } from "@/lib/audio/upload"
import { groupSelection, groupTakesByTrack, playingTakeId, type TakeGroup } from "@/lib/audio/take-groups"
import { DEFAULT_TARGET_TRACK_ID, GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { takeTrackVars, tracksForTakesIn } from "@/lib/timeline/take-colors"
import { useEditorActions } from "@/context/EditorActionsContext"
import { fmtClock } from "@/components/timeline/format"
import { CellTakeBlock } from "@/components/CellTakeBlock"
import { TakesStrip } from "@/components/AudioRecorder/TakesStrip"

interface Shared {
  project: ProjectRecord
  /** What a take is checked against — see CellTakeBlock's `cellText`. */
  cellText: string | null
  editable: boolean
  username: string
  session: FrontierSession | null
  onOpenRecording?: (cellId: string, slot?: string) => void
  onUseAsCellText?: (transcript: string) => void
  onCommitted?: (cellId: string) => void | Promise<void>
  /** AQU-1462: lane the member is working in, stamped on every write here so
   *  an archived lane can refuse it. Omitted for the default lane. */
  targetLang?: string
  /** A cell's last recording was deleted here; the workspace resets the
   *  target row it justified. Given the OWNER's id (a cue for a heard line). */
  onLastTakeRemoved?: (cellId: string) => void
}

export interface RecordingTakesProps extends Shared {
  /** The row's own cell. */
  cell: CellData
  /** Takes that live on the heard lines performing this row (dubbing). */
  linkedTakes?: ReadonlyArray<{
    cell: CellData
    sharedWith: number
    hasTake?: boolean
    performs?: readonly string[]
    partOfSplit?: boolean
  }>
}

/**
 * A cell's audio as the takes list reads it. The cell carries its clips keyed
 * by id with the read's extra fields (label, votes, who recorded it) riding
 * along; the list wants each clip to name itself. Clips gone from the read but
 * still flagged deleted are left for the grouping to drop.
 */
function takesOfCell(
  attachments: CellData["attachments"],
  generatedId: string | null | undefined,
): Record<string, AudioAttachmentOut> {
  const out: Record<string, AudioAttachmentOut> = {}
  for (const [audioId, raw] of Object.entries(attachments ?? {})) {
    const a = raw as typeof raw & Partial<AudioAttachmentOut>
    out[audioId] = {
      ...a,
      audioId,
      url: a.url,
      slot: a.slot ?? (audioId === generatedId ? GENERATED_VOICE_SLOT : RECORDING_SLOT),
      mimeType: a.mimeType ?? null,
      voiceId: a.voiceId ?? null,
      referenceAudioId: a.referenceAudioId ?? null,
      durationMs: a.durationMs ?? null,
      trimStartMs: a.trimStartMs ?? null,
      trimEndMs: a.trimEndMs ?? null,
    } as AudioAttachmentOut
  }
  return out
}

const selectionsOf = (cell: CellData) => ({
  selectedBySlot: cell.selectedBySlot,
  selectedAudioId: cell.selectedAudioId ?? null,
  selectedGeneratedVoiceAudioId: cell.selectedGeneratedVoiceAudioId ?? null,
})

/** One cell's takes: a section per track, playing take above its others. */
function OwnerTakes({
  owner,
  trackFileId,
  header,
  offerWhenEmpty = false,
  project,
  session,
  ...rest
}: Shared & {
  owner: CellData
  /** The file whose timeline the takes are on: the ROW's, for a heard line's
   *  takes too — they live in the hidden cue sibling, but their tracks (names,
   *  colours, added ones) are the subtitle file's (Sam, 2026-09-30). */
  trackFileId: string
  header?: React.ReactNode
  /** A heard line nobody has recorded yet: say so and offer New take, rather
   *  than draw nothing (Sam, 2026-09-29 — a line split across heard lines). */
  offerWhenEmpty?: boolean
}) {
  const t = useT()
  const shared: Shared = { ...rest, project, session }
  const { attachments, selectedAudioId, selectedGeneratedVoiceAudioId, fileId, id: cellId } = owner
  // The timeline's tracks — the row's file's, for a heard line too.
  const files = project.files
  const tracks = useMemo(() => tracksForTakesIn(files, trackFileId), [files, trackFileId])
  const takes = useMemo(
    () => takesOfCell(attachments, selectedGeneratedVoiceAudioId),
    [attachments, selectedGeneratedVoiceAudioId],
  )
  const groups = useMemo(() => groupTakesByTrack(takes, fileId, tracks), [takes, fileId, tracks])
  const entry = selectionsOf(owner)

  // The imported programme audio riding the recording slot: not a take, but
  // what the line plays when no take does — its section, shown as before.
  const sourceClip = useMemo(() => {
    const att = selectedAudioId ? takes[selectedAudioId] : undefined
    return att && audioIdSeededWith(att.audioId, fileId) && !(att as { isDeleted?: boolean }).isDeleted
      ? att
      : null
  }, [selectedAudioId, takes, fileId])

  // Who made each take and whether the text has moved on since: ONE history
  // read for the cell, shared by the playing take and its list.
  const allIds = useMemo(() => groups.flatMap((g) => g.takes.map((a) => a.audioId)), [groups])
  const getTokenForFile = useMemo(() => audioSyncTokenFetcherForSession(session), [session])
  const history = useRecordingTextDrift({
    enabled: Boolean(session?.jwt) && allIds.length > 0,
    projectId: project.id,
    fileId,
    cellId,
    audioIds: allIds,
    getTokenForFile,
  })

  const defaultGroup: TakeGroup | undefined = groups.find((g) => g.trackId === DEFAULT_TARGET_TRACK_ID)
  const defaultPlays = defaultGroup ? playingTakeId(defaultGroup, entry) : null
  // Takes named by their track once there is more than one track to tell
  // apart — "Target audio · Take 1", "Track · Take 1", since every track
  // numbers its own takes — or when the one track is not the line's own dub
  // track, which should not pass as it (Sam, 2026-09-30). The heard line's
  // takes too: its sections used to carry no track name at all.
  const showTracks = groups.length > 1 || (groups.length === 1 && groups[0].trackId !== DEFAULT_TARGET_TRACK_ID)
  // Takes, but none chosen — every one set aside. The playing take's line is
  // where New take lives, so without one it needs a line of its own.
  const nonePlays = !sourceClip && groups.length > 0 && groups.every((g) => !playingTakeId(g, entry))

  // Nothing of this cell's to show (a subtitle line whose takes are all on its
  // heard lines): no section, rather than an empty one opening the tab with a
  // gap.
  if (!header && !offerWhenEmpty && groups.length === 0 && !sourceClip) return null

  return (
    <div className="flex flex-col gap-3">
      {header}
      {offerWhenEmpty && groups.length === 0 && !sourceClip && (
        <div data-testid="rec-tab-no-take" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t("editor.recordingTab.noTakeYet")}
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ms-auto"
            onClick={() => shared.onOpenRecording?.(owner.id)}
            disabled={!shared.editable || !shared.onOpenRecording}
          >
            <Mic className="h-3 w-3" />
            {t("editor.recordingTab.newTake")}
          </Button>
        </div>
      )}
      {nonePlays && (
        <div data-testid="rec-tab-none-plays" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t("editor.recordingTab.nonePlays")}
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ms-auto"
            onClick={() => shared.onOpenRecording?.(owner.id)}
            disabled={!shared.editable || !shared.onOpenRecording}
          >
            <Mic className="h-3 w-3" />
            {t("editor.recordingTab.newTake")}
          </Button>
        </div>
      )}
      {/* A media line whose only audio is its section of the programme. */}
      {!defaultPlays && sourceClip && (
        <CellTakeBlock {...shared} owner={owner} audioId={sourceClip.audioId} timings={owner.audioTimings?.[sourceClip.audioId]} />
      )}
      {groups.map((group) => {
        const playing = playingTakeId(group, entry)
        const isDefault = group.trackId === DEFAULT_TARGET_TRACK_ID
        const playingAtt = playing ? group.takes.find((a) => a.audioId === playing) : undefined
        const generated = Boolean(playingAtt && (playingAtt.voiceId || playingAtt.slot === GENERATED_VOICE_SLOT))
        return (
          <section key={group.trackId} data-testid={`rec-tab-track-${group.trackId}`} className="flex flex-col gap-2">
            {/* A track whose takes are all set aside has no take on top to
                carry its name, so its list is headed by it. */}
            {showTracks && !playing && (
              <div data-testid="rec-tab-track-heading" className="flex items-center gap-2 text-xs font-medium">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{
                    background: takeTrackVars({
                      files: project.files,
                      fileId: trackFileId,
                      slot: isDefault ? RECORDING_SLOT : group.takes[0]?.slot,
                    })["--tl-track-hue"],
                  }}
                />
                {group.name || t("editor.recordingTab.addedTrack")}
              </div>
            )}
            {playing && (
              <CellTakeBlock
                {...shared}
                owner={owner}
                audioId={playing}
                timings={owner.audioTimings?.[playing]}
                readOnlyTranscript={generated}
                provenance={history.get(playing) ?? null}
                onLastTakeRemoved={shared.onLastTakeRemoved}
                trackName={showTracks ? group.name || t("editor.recordingTab.addedTrack") : null}
                trackFileId={trackFileId}
              />
            )}
            <TakesStrip
              variant="tab"
              projectId={project.id}
              project={project}
              fileId={owner.fileId}
              trackFileId={trackFileId}
              cellId={owner.id}
              takes={group.takes}
              hide={playing ? [playing] : undefined}
              selectedAudioId={groupSelection(entry, group.trackId)}
              // The displace-to-source dance belongs to the default row alone.
              selectedGeneratedAudioId={isDefault ? entry.selectedGeneratedVoiceAudioId : null}
              sourceClip={isDefault ? sourceClip : null}
              author={shared.username}
              session={session}
              targetLang={shared.targetLang}
              history={history}
              cellText={shared.cellText}
              timingsFor={(audioId) => owner.audioTimings?.[audioId] as never}
              onLastTakeRemoved={shared.onLastTakeRemoved}
              readOnly={!shared.editable}
            />
          </section>
        )
      })}
    </div>
  )
}

export function RecordingTakes({ cell, linkedTakes, ...shared }: RecordingTakesProps) {
  const t = useT()
  const { cellStore } = useEditorActions()
  /**
   * What a heard line's take should say (Sam, 2026-09-30). It was checked
   * against this row's text alone, which is wrong twice over: a heard line
   * shared with other lines says all of their text, and one that says only
   * PART of a split line cannot be checked against any text at all — which
   * part is not written down anywhere — so it is left unchecked.
   */
  const textFor = (heard: { performs?: readonly string[]; partOfSplit?: boolean }): string | null => {
    if (heard.partOfSplit) return null
    const performs = heard.performs ?? [cell.id]
    if (performs.length <= 1) return shared.cellText
    return performs
      .map((id) => {
        if (id === cell.id) return { text: shared.cellText ?? "", at: cell.startTime ?? 0 }
        const other = cellStore?.getCellView(id)
        return { text: other?.translated ?? "", at: other?.startTime ?? 0 }
      })
      .sort((a, b) => a.at - b.at)
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join(" ")
  }
  return (
    <div data-testid="recording-takes" className="flex flex-col gap-4">
      <OwnerTakes {...shared} owner={cell} trackFileId={cell.fileId} />
      {linkedTakes?.map((heard) => {
        const { cell: cue, sharedWith } = heard
        // Only a heard line performing exactly this line says this line's
        // text, so only its transcript may be put into it.
        const own = !heard.partOfSplit && (heard.performs?.length ?? 1) <= 1
        return (
        <OwnerTakes
          key={cue.id}
          {...shared}
          cellText={textFor(heard)}
          onUseAsCellText={own ? shared.onUseAsCellText : undefined}
          owner={cue}
          trackFileId={cell.fileId}
          // A heard line performs one or more subtitle lines at once; its take
          // is recorded, chosen and validated there.
          offerWhenEmpty
          header={
            <div data-testid="cell-linked-take" className="flex flex-col gap-0.5 border-t border-border pt-2">
              {/* What this heard line SAYS — the one thing that tells two
                  heard lines of one subtitle line apart (Sam, 2026-09-29). */}
              {cue.original?.trim() && (
                <span data-testid="cell-linked-take-text" className="text-xs font-medium text-foreground">
                  “{cue.original.trim()}”
                </span>
              )}
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {t("editor.audio.heardLineAt", {
                  range: `${fmtClock(cue.startTime ?? 0, true)}–${fmtClock(cue.endTime ?? cue.startTime ?? 0, true)}`,
                })}
              </span>
              {sharedWith > 1 && (
                // The one warning: a new take, or choosing another, changes
                // every line this heard line performs (Sam, 2026-09-29).
                <span data-testid="rec-tab-shared-note" className="text-[10px] text-muted-foreground">
                  {t("editor.audio.heardLineShared", { count: sharedWith - 1 })}
                </span>
              )}
            </div>
          }
        />
        )
      })}
    </div>
  )
}
