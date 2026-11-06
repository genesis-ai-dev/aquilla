import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, Save } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useParatextDiscovery } from "@/lib/paratext-bridge/use-paratext-discovery"
import { useParatextBook } from "@/lib/paratext-bridge/use-paratext-book"
import { useParatextNotes } from "@/lib/paratext-bridge/use-paratext-notes"
import { notesForUnit } from "@/lib/paratext-bridge/notes"
import { ParatextUnitNotes } from "./ParatextUnitNotes"
import { editDenial } from "@/lib/paratext-bridge/access"
import type { Unit } from "@/lib/paratext-bridge/units"
import { getBookName } from "@/lib/file-labeling/bible-book-names"

/** Edit one Paratext book in place. Units are derived from the file on every
 *  open; edits queue locally and are written back by splice with a byte-level
 *  proof. Paratext's own Send/Receive carries them onward. */
export function ParatextBookPage() {
  const t = useT()
  const [params] = useSearchParams()
  const projectPath = params.get("project")
  const fileName = params.get("file")
  const d = useParatextDiscovery()
  const project = useMemo(() => d.projects.find((p) => p.path === projectPath) ?? null, [d.projects, projectPath])
  const registered = d.discovery?.registeredUser?.name ?? null
  const [book, act] = useParatextBook(project, fileName, registered)
  const [notes, noteAct] = useParatextNotes(project, registered)

  const chapters = useMemo(() => {
    const out = new Map<number, Unit[]>()
    for (const u of book.units?.units ?? []) {
      const list = out.get(u.chapter) ?? []
      list.push(u)
      out.set(u.chapter, list)
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0])
  }, [book.units])

  const title = book.units ? (getBookName(book.units.book) ?? book.units.book) : fileName ?? ""
  const pendingCount = book.edits.size
  const canWrite = !book.denial && !book.onHold && pendingCount > 0 && !book.writing

  const doWrite = async (allowMarkerChanges?: Set<string>) => {
    const r = await act.write({ allowMarkerChanges })
    if ("refused" in r) {
      const reason = r.refused.startsWith("proof:")
        ? t("paratextBridge.book.refused.proof", { details: r.refused.slice(6) })
        : r.refused === "hash" ? t("paratextBridge.book.refused.hash") : r.refused
      toast.add({ type: "error", title: t("paratextBridge.book.refused", { reason }) })
    } else if (r.written > 0) {
      toast.add({ type: "success", title: t("paratextBridge.book.written", { count: r.written, file: r.file }), description: t("paratextBridge.book.backup") })
    }
  }

  const addNote = async (u: Unit, text: string) => {
    if (!book.units) return false
    const r = await noteAct.addNote(book.units.book, u, text)
    if ("refused" in r) {
      const reason = r.refused.startsWith("proof:") ? t("paratextBridge.book.refused.proof", { details: r.refused.slice(6) }) : r.refused
      toast.add({ type: "error", title: t("paratextBridge.notes.failed", { reason }) })
      return false
    }
    toast.add({ type: "success", title: t("paratextBridge.notes.added", { file: r.file }) })
    return true
  }

  const chapterDenied = (chapter: number) =>
    project?.access && registered ? editDenial(project.access, registered, book.units?.book ?? "", chapter) : null

  return (
    <AppShell
      sidebar={<ThisComputerSidebar />}
      header={<ThisComputerBreadcrumb trail={[{ label: t("paratextBridge.title"), to: "/paratext" }, { label: title }]} />}
      statusBar={null}
      main={
        <Page>
          <PageHeader
            title={<span className="flex items-center gap-2">{title}{project ? <Badge variant="outline">{project.settings.name}</Badge> : null}</span>}
            description={fileName ?? undefined}
            actions={
              <>
                <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/paratext" />}><ArrowLeft />{t("paratextBridge.book.back")}</Button>
                {pendingCount > 0 ? (
                  <Button variant="outline" size="sm" onClick={() => void act.discardEdits()} disabled={book.writing}>{t("paratextBridge.book.discard")}</Button>
                ) : null}
                <Button size="sm" onClick={() => void doWrite()} disabled={!canWrite} data-testid="paratext-write">
                  {book.writing ? <Spinner /> : <Save />}
                  {book.writing ? t("paratextBridge.book.writing") : pendingCount > 0 ? t("paratextBridge.book.pending", { count: pendingCount }) : t("paratextBridge.book.write")}
                </Button>
              </>
            }
          />

          {book.denial ? (
            <p className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <Badge variant="outline" className="mr-2">{t("paratextBridge.book.readOnly")}</Badge>
              {t(`paratextBridge.book.denied.${book.denial}` as MessageKey, { user: registered ?? "" })}
            </p>
          ) : null}
          {book.onHold ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <span>{t("paratextBridge.book.onHold")}</span>
              <Button size="sm" variant="outline" onClick={() => void act.releaseHold()}>{t("paratextBridge.book.releaseHold")}</Button>
            </div>
          ) : null}
          {book.theirsCount > 0 ? (
            <p className="mb-4 text-sm text-muted-foreground">{t("paratextBridge.book.fileChanged", { count: book.theirsCount })}</p>
          ) : null}
          {book.refusals.length > 0 ? (
            <div className="mb-4 space-y-2 rounded-md border border-border p-3 text-sm">
              {book.refusals.map((r) => (
                <div key={r.unitId} className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{r.unitId}</code>
                  <span>{r.reason === "marker-integrity" ? t("paratextBridge.book.conflict.markers") : r.reason === "unit-missing" ? t("paratextBridge.book.conflict.missing") : t("paratextBridge.book.refused.hash")}</span>
                  {r.reason === "marker-integrity" ? (
                    <Button size="sm" variant="outline" onClick={() => void doWrite(new Set([r.unitId]))}>{t("paratextBridge.book.conflict.allowMarkers")}</Button>
                  ) : null}
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={act.dismissRefusals}>{t("common.dismiss" as MessageKey)}</Button>
            </div>
          ) : null}
          {book.error ? <p className="text-sm text-destructive">{book.error}</p> : null}
          {notes.error ? <p className="text-sm text-destructive">{notes.error}</p> : null}
          {book.units && !notes.loading ? <p className="mb-4 text-xs text-muted-foreground">{t("paratextBridge.notes.ownOnly")}</p> : null}

          {book.loading && !book.units ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.book.loading", { file: fileName ?? "" })}</div>
          ) : (
            <div className="space-y-8" dir={project?.settings.rightToLeft ? "rtl" : undefined}>
              {chapters.map(([chapter, units]) => {
                const denied = book.denial ?? chapterDenied(chapter)
                return (
                  <section key={chapter} className="space-y-2">
                    <h2 className="sticky top-0 z-10 bg-background py-1 text-sm font-semibold text-muted-foreground">
                      {chapter === 0 ? t("paratextBridge.book.header") : t("paratextBridge.book.chapter", { n: chapter })}
                      {denied && !book.denial ? <Badge variant="outline" className="ms-2">{t("paratextBridge.book.readOnly")}</Badge> : null}
                    </h2>
                    {units.map((u) => {
                      const edit = book.edits.get(u.id)
                      const value = edit?.text ?? u.text
                      const label = u.kind === "verse" ? u.verse : `\\${u.marker}`
                      const unitNotes = notesForUnit(notes.notes, book.units?.book ?? "", u)
                      return (
                        <div key={u.id} className="grid grid-cols-[4rem_1fr_auto] items-start gap-2" data-unit-id={u.id}>
                          <span className={"pt-2 text-end font-mono text-xs " + (edit ? "text-primary" : "text-muted-foreground")} title={u.id}>{label}</span>
                          <Textarea
                            value={value}
                            readOnly={!!denied}
                            rows={Math.max(1, Math.ceil(value.length / 90) + (value.match(/\n/g)?.length ?? 0))}
                            className={"min-h-8 resize-none " + (u.kind !== "verse" ? "font-medium " : "") + (edit ? "border-primary/60 " : "")}
                            onChange={(e) => void act.setEditText(u, e.target.value)}
                          />
                          <ParatextUnitNotes unitId={u.id} notes={unitNotes} canAdd={!!registered} onAdd={(text) => addNote(u, text)} />
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          )}

          <AlertDialog open={book.conflicts.length > 0}>
            <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle>{t("paratextBridge.book.conflict.title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {book.conflicts.some((c) => c.case === "stale-revert")
                    ? t("paratextBridge.book.conflict.stale", { count: book.conflicts.filter((c) => c.case === "stale-revert").length })
                    : t("paratextBridge.book.conflict.description")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-4 text-sm">
                {book.conflicts.map((c) => (
                  <div key={c.unitId} className="space-y-2 rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-xs">{c.unitId}</code>
                      <div className="flex gap-2">
                        <Button size="sm" variant={c.case === "stale-revert" ? "default" : "outline"} onClick={() => void act.resolve(c.unitId, "mine")}>{t("paratextBridge.book.conflict.keepMine")}</Button>
                        <Button size="sm" variant="outline" onClick={() => void act.resolve(c.unitId, "theirs")}>{t("paratextBridge.book.conflict.takeTheirs")}</Button>
                      </div>
                    </div>
                    <dl className="grid gap-1 text-xs">
                      <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.base")}</dt><dd className="whitespace-pre-wrap">{c.base?.text ?? ""}</dd>
                      <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.theirs")}</dt><dd className="whitespace-pre-wrap">{c.theirs?.text ?? t("paratextBridge.book.conflict.missing")}</dd>
                      <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.mine")}</dt><dd className="whitespace-pre-wrap font-medium">{c.mine ?? ""}</dd>
                    </dl>
                  </div>
                ))}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => void act.resolveAll("theirs")}>{t("paratextBridge.book.conflict.takeAllTheirs")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void act.resolveAll("mine")}>{t("paratextBridge.book.conflict.keepAllMine")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Page>
      }
    />
  )
}
