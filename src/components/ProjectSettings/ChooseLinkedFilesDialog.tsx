// ChooseLinkedFilesDialog — AQU-1560/AQU-1562 "Choose files" on the Source link card.
//
// AQU-1559 let a Project Lead pick which of the upstream's files a link follows,
// but only while making the link. A team that linked Matthew and later needed
// Mark had to detach (irreversible) and link again; a file the upstream gained
// after the link was made never arrived on a fixed-list link, and nothing in
// the project offered it. This dialog lists the upstream's files as they are
// now: the ones the link follows checked, every other one — including files the
// upstream gained since — unchecked.
//
// Checking a file (AQU-1560) posts the newly checked UPSTREAM file ids
// (POST /api/v2/projects/:id/link-source/files). Each file arrives with its
// complete current source, not only changes from now on: the server replays its
// upstream history before the file joins the link, and answers once that has
// run. If every upstream file is linked afterwards, the link follows the whole
// project again (AQU-1559's rule) — the scope note below says which outcome a
// confirm will produce.
//
// UNCHECKING a file the link follows (AQU-1562) stops this project following
// that one file — a per-file detach, which until this slice meant deleting the
// file (losing its translations) or detaching the whole project. The file stays
// here with the source text it has at that moment and every translation,
// validation and comment on it; only the flow of upstream changes ends, and
// every other followed file keeps syncing. Unchecking a file on a whole-project
// link pins the link to the rest (AQU-1559's rule again), so files the upstream
// gains later stop arriving on their own. At least one file must stay linked:
// stopping everything is "Detach from source", which is unchanged.
//
// A file that was stopped reads as an unchecked row like any other, but checking
// it does something different — it resumes following THE SAME file, bringing its
// source text up to the upstream's current text while its translations stay,
// where checking a never-had file only brings one in. The server tells the two
// apart (`loadLinkedSourceFileState` → `stoppedFileIds`), because the mirror's
// file identity lives in the workers. Anything that carries a promise the row
// does not — a stop, or a resume — goes through a confirm step that says what
// will happen in those terms before anything changes; a plain add of files this
// project never had is still one press, as AQU-1560 made it.
//
// The count sentence, the scope notes and the same-name warning are the link
// flow's own (LinkSourceFlow, AQU-1526/AQU-1559) — the same file list, the same
// preview read (`loadLinkSourcePreview`), the same words, so adding a file later
// reads exactly like picking it at link time.
//
// AQU-1679: and so is "replace the source in my existing file". An added
// upstream file whose name matches exactly one file this project already has
// can follow INTO that file instead of arriving as a second copy — the file
// keeps its translations and takes the upstream's source. The option, its
// comparison and its refusals are the link flow's (`useReplaceFileChoices`,
// `ReplaceMatchNote`); a replace carries a promise a checkbox does not, so it
// goes through the confirm step like a stop or a resume. Only a link that
// consumes the upstream's SOURCE offers it. Not offered on a stopped file: a
// resume already brings the upstream's text into the same file.
//
// A change that is SAVED but whose files have not all arrived (the add answers
// `complete: false`) is not a failure and is not shown as one. The addition is
// recorded server-side and any sync of the link finishes it, so the dialog runs
// that sync itself — the link flow's own self-heal (`triggerLinkSync`, AQU-476)
// — and closes when the files are in. This is the ordinary path wherever the
// server's own trigger does not reach the sync worker, not a rare one: before
// it, the dialog answered every such add with a red "try again" over a Confirm
// button that repeated the request and the sentence. Only when the files are
// still not in after that does the dialog say so, in a step of its own with
// nothing left to confirm: the change is saved, the files are on their way, and
// "Check again" looks for them.

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ReplaceFileOption, replaceOfferedFor } from "@/components/UpstreamFileChoiceList"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useReplaceFileChoices } from "@/hooks/useReplaceFileChoices"
import {
  addLinkedSourceFiles,
  loadLinkedSourceFileState,
  stopLinkedSourceFiles,
  triggerLinkSync,
} from "@/lib/sync/archive"
import { loadLinkSourcePreview, type LinkSourcePreview } from "@/lib/sync/link-source-preview"
import { fetchLinkedFileCopies } from "@/lib/sync/link-join-copy"
import { markAdoptedFilesForIdmlAlignment } from "@/lib/idml/link-adopted-align"
import { toUserFacingError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"

/** AQU-2549: the preview with only `ownFiles` left as files a replace can
 *  follow into, and no same-name default that points anywhere else. */
function onlyJoinableOwnFiles(
  preview: LinkSourcePreview,
  joinable: ReadonlyArray<{ id: string }>,
): LinkSourcePreview {
  const ok = new Set(joinable.map((f) => f.id))
  return {
    ...preview,
    ownFiles: preview.ownFiles?.filter((f) => ok.has(f.id)),
    files: preview.files.map(({ clashFileId, ...file }) =>
      clashFileId !== undefined && ok.has(clashFileId) ? { ...file, clashFileId } : file,
    ),
  }
}

export interface ChooseLinkedFilesDialogProps {
  projectId: string
  /** The upstream this project's live link reads from. */
  sourceProjectId: string
  /** AQU-1679: which corpus the link consumes. Only a link to the upstream's
   *  SOURCE can replace a file's source here; null/undefined reads as source,
   *  the server's own default. */
  sourceLinkConsumes?: "source" | "target" | null
  /** The UPSTREAM file ids the link follows, or null/undefined for a
   *  whole-project link (which already follows every file). Used until the
   *  server's own answer arrives, and as the fallback when it cannot. */
  followedFileIds: string[] | null | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the confirmed changes are in, so the host can refresh the
   *  project record (the card's count and scope badge, the file list). */
  onApplied: () => void
}

export function ChooseLinkedFilesDialog({
  projectId,
  sourceProjectId,
  sourceLinkConsumes,
  followedFileIds,
  open,
  onOpenChange,
  onApplied,
}: ChooseLinkedFilesDialogProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt

  const [preview, setPreview] = useState<LinkSourcePreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  // Bumped by "Try again" so the effect re-reads the same upstream.
  const [previewAttempt, setPreviewAttempt] = useState(0)
  // AQU-1562: the link's selection and its stopped files as the SERVER has them
  // now. Null until it answers, and left null when it cannot (an older server
  // has no such route) — the prop is then the selection and nothing reads as
  // stopped, which is exactly how every link looked before this slice.
  const [linkState, setLinkState] = useState<{ fileIds: string[] | null; stoppedFileIds: string[] } | null>(null)
  // The NEWLY checked upstream file ids — followed rows are never in here.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // AQU-1562: followed upstream file ids the lead has UNCHECKED, to stop.
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set())
  // "arriving": the change is saved and its files are still coming in.
  const [view, setView] = useState<"list" | "confirm" | "arriving">("list")
  const [applying, setApplying] = useState(false)
  // The save has gone through and the dialog is now bringing its files in.
  const [bringingIn, setBringingIn] = useState(false)
  // The upstream files a saved change is still waiting on, by name, and whether
  // the lead has looked for them again since — so a second look that finds the
  // same thing reads as an answer rather than as a button that did nothing.
  const [arriving, setArriving] = useState<{ ids: string[]; names: string[] } | null>(null)
  const [checkedAgain, setCheckedAgain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const files = useMemo(() => preview?.files ?? [], [preview])
  // AQU-1679: the picked upstream files set to replace the project's own
  // same-named file, and the server's comparison of each pair.
  const canReplace = sourceLinkConsumes !== "target"
  // AQU-2549: the rows showing the option — picked, not a stopped copy, with a
  // file here to follow into (see replaceOffered below).
  const replaceOfferedIds = useMemo(() => {
    const stoppedIds = new Set(linkState?.stoppedFileIds ?? [])
    const hasOwnFiles = (preview?.ownFiles?.length ?? 0) > 0
    return new Set(
      canReplace
        ? files
            .filter((f) => picked.has(f.id) && !stoppedIds.has(f.id) && (f.clashFileId !== undefined || hasOwnFiles))
            .map((f) => f.id)
        : [],
    )
  }, [canReplace, files, picked, linkState, preview])
  const replaceChoices = useReplaceFileChoices({
    jwt,
    projectId,
    sourceProjectId,
    files,
    ownFiles: preview?.ownFiles,
    offeredFileIds: replaceOfferedIds,
  })
  const {
    replaceFileIds,
    targetOf: replaceTargetOf,
    takenTargets: replaceTakenTargets,
    reset: resetReplace,
    isUnresolved: replaceIsUnresolved,
  } = replaceChoices

  // Both reads happen on every open: the list has to show files the upstream
  // gained since the link was made, and the selection can have moved on (a
  // teammate's add, a finished backfill) since the card last refreshed.
  useEffect(() => {
    if (!open || !jwt) return
    let cancelled = false
    // AQU-2549: the files a replace may follow into are this project's own
    // files that follow nothing yet — never a copy the link brought in, never
    // a file already in the replace record (the server's answer, as the join
    // offers). Unreadable: the full list, and the server refuses a bad pick.
    void Promise.all([
      loadLinkSourcePreview(jwt, projectId, sourceProjectId),
      fetchLinkedFileCopies(jwt, projectId).catch(() => null),
    ])
      .then(([result, joinable]) => {
        if (!cancelled) setPreview(joinable ? onlyJoinableOwnFiles(result, joinable.ownFiles) : result)
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true)
      })
    // Best-effort, and deliberately not fatal: without it the dialog still adds
    // and stops correctly off the prop — it just describes a resume as a plain
    // add, which understates it rather than promising something that will not
    // happen.
    void loadLinkedSourceFileState(jwt, projectId)
      .then((state) => {
        if (!cancelled) setLinkState(state)
      })
      .catch(() => {
        if (!cancelled) setLinkState(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, jwt, projectId, sourceProjectId, previewAttempt])

  // Closing (cancel, Esc, or after an apply) forgets everything, so the next
  // open starts from the server's current answer rather than a stale pick.
  const close = useCallback(() => {
    onOpenChange(false)
    setPreview(null)
    setPreviewFailed(false)
    setLinkState(null)
    setPicked(new Set())
    setUnpicked(new Set())
    resetReplace()
    setView("list")
    setArriving(null)
    setCheckedAgain(false)
    setError(null)
  }, [onOpenChange, resetReplace])

  // The server's answer wins once it is in; the prop carries the dialog until
  // then. A non-empty list is a fixed-list link, null/empty the whole project.
  const effectiveFollowed = linkState ? linkState.fileIds : followedFileIds
  const followed = useMemo(
    () => (effectiveFollowed && effectiveFollowed.length > 0 ? new Set(effectiveFollowed) : null),
    [effectiveFollowed],
  )
  const stopped = useMemo(() => new Set(linkState?.stoppedFileIds ?? []), [linkState])
  const isFollowed = useCallback((fileId: string) => followed === null || followed.has(fileId), [followed])
  // A row's state after the lead's edits: followed-and-kept, or checked-to-add.
  const isChecked = useCallback(
    (fileId: string) => (isFollowed(fileId) ? !unpicked.has(fileId) : picked.has(fileId)),
    [isFollowed, unpicked, picked],
  )

  const followedCount = files.filter((f) => isFollowed(f.id)).length
  const unfollowedCount = files.length - followedCount
  const hasChanges = picked.size > 0 || unpicked.size > 0
  // What the selection would hold after confirming. Zero is the one outcome
  // this dialog cannot produce: "follow no files" is not a link, it is
  // "Detach from source".
  const nextSelectionCount = followedCount - unpicked.size + picked.size
  const emptiesSelection = hasChanges && nextSelectionCount === 0
  // Once every upstream file is followed, the link follows the whole project.
  const becomesWholeProject = hasChanges && unpicked.size === 0 && followedCount + picked.size === files.length
  // AQU-1562: stopping a file on a whole-project link pins it to the rest, so
  // the files the upstream gains later stop arriving on their own.
  const pinsWholeProject = followed === null && unpicked.size > 0

  const named = useCallback(
    (ids: Set<string>) => files.filter((f) => ids.has(f.id)).map((f) => f.name),
    [files],
  )
  // The three things a confirm can be about, kept apart because they promise
  // different things: a resume replaces a file's source text, an add brings a
  // file this project never had, a stop ends the flow of changes to one.
  const stopNames = useMemo(() => named(unpicked), [named, unpicked])
  const resumeIds = useMemo(() => [...picked].filter((id) => stopped.has(id)), [picked, stopped])
  // AQU-1679: a picked file set to follow INTO the project's own same-named
  // file — the fourth thing a confirm can be about. Its row offers the option
  // only while it is picked, has one file here to stand in for, and is not a
  // stopped copy (resuming one already brings the upstream's text into it).
  const replaceOffered = useCallback(
    (f: { id: string; clashFileId?: string }) =>
      canReplace && picked.has(f.id) && !stopped.has(f.id) && replaceOfferedFor(f, replaceChoices),
    [canReplace, picked, stopped, replaceChoices],
  )
  const replacing = useMemo(
    () => files.filter((f) => replaceOffered(f) && replaceFileIds.has(f.id)),
    [files, replaceOffered, replaceFileIds],
  )
  const replacingIds = useMemo(() => new Set(replacing.map((f) => f.id)), [replacing])
  // AQU-2549: two rows that picked the same file of this project.
  const replaceTakenIds = useMemo(
    () => replaceTakenTargets(replacing.map((f) => f.id)),
    [replaceTakenTargets, replacing],
  )
  const addIds = useMemo(
    () => [...picked].filter((id) => !stopped.has(id) && !replacingIds.has(id)),
    [picked, stopped, replacingIds],
  )
  const resumeNames = useMemo(() => named(new Set(resumeIds)), [named, resumeIds])
  const addNames = useMemo(() => named(new Set(addIds)), [named, addIds])
  // AQU-2549: the lead's own file, which may be named differently now.
  const replaceNames = useMemo(
    () =>
      replacing.map(
        (f) => replaceChoices.ownFiles.find((own) => own.id === replaceTargetOf(f.id))?.name ?? f.name,
      ),
    [replacing, replaceChoices.ownFiles, replaceTargetOf],
  )
  // A replace the server has not cleared holds the action back; the row says why.
  const replaceUnresolved = replaceIsUnresolved(replacing.map((f) => f.id))
  // A plain add of files this project never had is one press, as AQU-1560 made
  // it. A stop, a resume or a replace says what it will do first.
  const needsConfirm = unpicked.size > 0 || resumeIds.length > 0 || replacing.length > 0

  // Same rule as the link flow's warning: only files still coming can clash,
  // and a name is listed once however many rows carry it. A resumed file does
  // not clash with itself — it IS the file already here — so only genuine
  // additions are weighed; nor (AQU-1679) does a file replacing the project's
  // own, which does not arrive as a copy.
  const pickedClashNames = useMemo(() => {
    const adding = new Set(addIds)
    const names: string[] = []
    const seen = new Set<string>()
    for (const f of files) {
      if (!f.clashes || !adding.has(f.id)) continue
      const key = f.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      names.push(f.name)
    }
    return names
  }, [files, addIds])

  const toggle = useCallback(
    (fileId: string) => {
      setError(null)
      if (isFollowed(fileId)) {
        setUnpicked((current) => {
          const next = new Set(current)
          if (next.has(fileId)) next.delete(fileId)
          else next.add(fileId)
          return next
        })
        return
      }
      setPicked((current) => {
        const next = new Set(current)
        if (next.has(fileId)) next.delete(fileId)
        else next.add(fileId)
        return next
      })
    },
    [isFollowed],
  )

  /**
   * Sync the link from here, then ask the server whether `ids` have joined it.
   * A file joins the selection only once it has arrived whole (and, for a
   * replace, after its join), so being in the selection is the whole answer.
   * Never throws: a sync or a read that fails is "not in yet".
   */
  async function bringIn(token: string, ids: readonly string[]): Promise<boolean> {
    await triggerLinkSync(token, projectId)
    try {
      const state = await loadLinkedSourceFileState(token, projectId)
      const followedNow = state.fileIds
      return followedNow === null || ids.every((id) => followedNow.includes(id))
    } catch {
      return false
    }
  }

  async function handleCheckAgain() {
    if (!jwt || applying || !arriving) return
    setApplying(true)
    try {
      if (await bringIn(jwt, arriving.ids)) {
        close()
        onApplied()
        return
      }
      setCheckedAgain(true)
    } finally {
      setApplying(false)
    }
  }

  async function handleApply() {
    if (!jwt || applying || !hasChanges || emptiesSelection) return
    setApplying(true)
    setBringingIn(false)
    setError(null)
    // Stopping first, so an add lands on the narrowed selection rather than
    // being undone by it — and so a refused stop changes nothing at all.
    let stoppedAnything = false
    try {
      if (unpicked.size > 0) {
        const result = await stopLinkedSourceFiles(jwt, projectId, [...unpicked])
        stoppedAnything = result.stopped.length > 0
      }
      if (picked.size > 0) {
        // AQU-1679: the pairs ride with the add. Three arguments when there are
        // none, so the request is the one AQU-1560 made.
        const ids = [...picked]
        const pairs = replacing.map((f) => ({ upstreamFileId: f.id, fileId: replaceTargetOf(f.id) as string }))
        const result =
          pairs.length > 0
            ? await addLinkedSourceFiles(jwt, projectId, ids, pairs)
            : await addLinkedSourceFiles(jwt, projectId, ids)
        // The pairs are recorded server-side, whether or not the join has run
        // yet: the workspace syncs the link before it places an IDML file's
        // kept translations into its new source, so — as in the link flow —
        // this rides on the request's success, not on the files' arrival.
        if (pairs.length > 0) {
          markAdoptedFilesForIdmlAlignment(projectId, pairs.map((pair) => pair.fileId))
        }
        if (!result.complete) {
          // Saved, and not in yet. Nothing is half-added (a file joins the link
          // only once it has arrived whole) and nothing needs asking for again:
          // any sync of the link carries on from where the last one stopped, so
          // run one from here and see.
          setBringingIn(true)
          if (!(await bringIn(jwt, ids))) {
            setArriving({ ids, names: named(picked) })
            setCheckedAgain(false)
            setView("arriving")
            // A stop that already went through is in effect, so the card is
            // refreshed regardless.
            if (stoppedAnything) onApplied()
            return
          }
        }
      }
      close()
      onApplied()
    } catch (err) {
      setError(toUserFacingError(err, "project").message)
      if (stoppedAnything) onApplied()
    } finally {
      setApplying(false)
      setBringingIn(false)
    }
  }

  const confirming = view === "confirm"
  // The files a saved change is still waiting on; null on every other step.
  const waitingOn = view === "arriving" ? arriving : null

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (applying) return
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {waitingOn
              ? t("projectSettings.sourceLink.chooseFilesArrivingTitle", { count: waitingOn.names.length })
              : confirming
                ? t("projectSettings.sourceLink.chooseFilesConfirmTitle")
                : t("projectSettings.sourceLink.chooseFilesTitle")}
          </DialogTitle>
          {!confirming && !waitingOn && (
            <DialogDescription>{t("projectSettings.sourceLink.chooseFilesDescription")}</DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3 py-1">
          {waitingOn ? (
            // Saved, not a failure: said in the dialog's ordinary voice, with
            // nothing to confirm and nothing in red.
            <div className="space-y-2">
              <ul className="list-inside list-disc text-sm font-medium">
                {waitingOn.names.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                {t("projectSettings.sourceLink.chooseFilesArrivingBody", { count: waitingOn.names.length })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("projectSettings.sourceLink.chooseFilesArrivingCloseNote")}
              </p>
              {checkedAgain && !applying && (
                <p className="text-sm" role="status">
                  {t("projectSettings.sourceLink.chooseFilesArrivingStillNote", { count: waitingOn.names.length })}
                </p>
              )}
            </div>
          ) : confirming ? (
            <>
              {stopNames.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("projectSettings.sourceLink.chooseFilesStopHeading", { count: stopNames.length })}
                  </p>
                  <ul className="list-inside list-disc text-sm font-medium">
                    {stopNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted-foreground">
                    {t("projectSettings.sourceLink.chooseFilesStopBody", { count: stopNames.length })}
                  </p>
                  {nextSelectionCount > 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t("projectSettings.sourceLink.chooseFilesStopOthersNote")}
                    </p>
                  )}
                </div>
              )}
              {pinsWholeProject && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>{t("projectSettings.sourceLink.chooseFilesStopWholeProjectWarning")}</p>
                </div>
              )}
              {resumeNames.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("projectSettings.sourceLink.chooseFilesResumeHeading", { count: resumeNames.length })}
                  </p>
                  <ul className="list-inside list-disc text-sm font-medium">
                    {resumeNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted-foreground">
                    {t("projectSettings.sourceLink.chooseFilesResumeBody", { count: resumeNames.length })}
                  </p>
                </div>
              )}
              {replaceNames.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("projectSettings.sourceLink.chooseFilesReplaceHeading", { count: replaceNames.length })}
                  </p>
                  <ul className="list-inside list-disc text-sm font-medium">
                    {replaceNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted-foreground">
                    {t("projectSettings.sourceLink.chooseFilesReplaceBody", { count: replaceNames.length })}
                  </p>
                </div>
              )}
              {addNames.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("projectSettings.sourceLink.chooseFilesAddHeading", { count: addNames.length })}
                  </p>
                  <ul className="list-inside list-disc text-sm font-medium">
                    {addNames.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted-foreground">
                    {t("projectSettings.sourceLink.chooseFilesAddBody", { count: addNames.length })}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {becomesWholeProject
                  ? t("projectSettings.linkSource.scopeAllNote")
                  : t("projectSettings.linkSource.scopeSubsetNote")}
              </p>
            </>
          ) : previewFailed ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive" role="alert">
                {t("projectSettings.sourceLink.chooseFilesLoadError")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPreviewFailed(false)
                  setPreviewAttempt((n) => n + 1)
                }}
              >
                {t("projectSettings.linkSource.previewRetryButton")}
              </Button>
            </div>
          ) : !preview ? (
            <p className="text-sm text-muted-foreground">{t("projectSettings.sourceLink.chooseFilesLoading")}</p>
          ) : (
            <>
              {/* The upstream's own order, scrolled rather than paged — an
                  upstream can hold 66 books or more. */}
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded border px-3 py-2">
                {files.map((f) => {
                  const followedRow = isFollowed(f.id)
                  return (
                    <li key={f.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={isChecked(f.id)}
                          disabled={applying}
                          onCheckedChange={() => toggle(f.id)}
                        />
                        <span className={followedRow ? "truncate text-muted-foreground" : "truncate"}>{f.name}</span>
                        {followedRow ? (
                          <Badge variant="outline" className="shrink-0">
                            {t("projectSettings.sourceLink.chooseFilesLinkedBadge")}
                          </Badge>
                        ) : stopped.has(f.id) ? (
                          <Badge variant="outline" className="shrink-0">
                            {t("projectSettings.sourceLink.chooseFilesStoppedBadge")}
                          </Badge>
                        ) : (
                          f.clashes && (
                            <Badge variant="outline" className="shrink-0 text-amber-700 dark:text-amber-300">
                              {t("projectSettings.linkSource.fileClashBadge")}
                            </Badge>
                          )
                        )}
                      </label>
                      {/* AQU-1679: follow INTO the file this project already has,
                          instead of adding a copy beside it. */}
                      {replaceOffered(f) && (
                        <ReplaceFileOption
                          file={f}
                          choices={replaceChoices}
                          taken={replaceTakenIds.has(f.id)}
                          disabled={applying}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
              {emptiesSelection ? (
                <p className="text-sm text-destructive" role="alert">
                  {t("projectSettings.sourceLink.chooseFilesKeepOneError")}
                </p>
              ) : !hasChanges ? (
                unfollowedCount === 0 ? (
                  <p className="text-sm">{t("projectSettings.sourceLink.chooseFilesAllLinked")}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("projectSettings.sourceLink.chooseFilesNoneChecked")}
                  </p>
                )
              ) : (
                <>
                  {/* AQU-1679: a file replacing the project's own is not ADDED,
                      so it leaves the count and gets a sentence of its own. */}
                  {picked.size - replacing.length > 0 && (
                    <p className="text-sm">
                      {t("projectSettings.linkSource.previewCount", { count: picked.size - replacing.length })}
                    </p>
                  )}
                  {replacing.length > 0 && (
                    <p className="text-sm">
                      {t("projectSettings.linkSource.replaceCount", { count: replacing.length })}
                    </p>
                  )}
                  {unpicked.size > 0 && (
                    <p className="text-sm">
                      {t("projectSettings.sourceLink.chooseFilesStopHeading", { count: unpicked.size })}{" "}
                      {stopNames.join(", ")}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {becomesWholeProject
                      ? t("projectSettings.linkSource.scopeAllNote")
                      : t("projectSettings.linkSource.scopeSubsetNote")}
                  </p>
                </>
              )}
              {/* A warning, never a refusal: the confirm button stays live. */}
              {pickedClashNames.length > 0 && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <p>{t("projectSettings.linkSource.clashWarningHeading", { count: pickedClashNames.length })}</p>
                    <ul className="list-inside list-disc font-medium">
                      {pickedClashNames.map((name) => (
                        <li key={name.toLowerCase()}>{name}</li>
                      ))}
                    </ul>
                    <p>{t("projectSettings.linkSource.clashWarningBody", { count: pickedClashNames.length })}</p>
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => (confirming ? setView("list") : close())}
            disabled={applying}
          >
            {waitingOn
              ? t("common.close")
              : confirming
                ? t("common.back")
                : t("projectSettings.linkSource.cancelButton")}
          </Button>
          {waitingOn ? (
            <Button onClick={() => void handleCheckAgain()} disabled={applying || !jwt}>
              {applying
                ? t("projectSettings.sourceLink.chooseFilesArrivingCheckingButton")
                : t("projectSettings.sourceLink.chooseFilesArrivingCheckButton")}
            </Button>
          ) : confirming ? (
            <Button onClick={() => void handleApply()} disabled={applying || !jwt || replaceUnresolved}>
              {applying
                ? bringingIn
                  ? t("projectSettings.sourceLink.chooseFilesBringingInButton")
                  : t("projectSettings.sourceLink.chooseFilesApplyingButton")
                : t("common.confirm")}
            </Button>
          ) : (
            <Button
              onClick={() => (needsConfirm ? setView("confirm") : void handleApply())}
              disabled={applying || !hasChanges || emptiesSelection || !jwt || replaceUnresolved}
            >
              {needsConfirm
                ? t("projectSettings.sourceLink.chooseFilesReviewButton")
                : applying
                  ? bringingIn
                    ? t("projectSettings.sourceLink.chooseFilesBringingInButton")
                    : t("projectSettings.sourceLink.chooseFilesAddingButton")
                  : t("projectSettings.sourceLink.chooseFilesAddButton")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
