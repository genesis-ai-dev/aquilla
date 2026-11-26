// "Open in Aquilla": mirror a Paratext project found on this computer into a
// regular Aquilla project, so its books get the full editor (AI drafts, health,
// comments, audio) with the file bridge as the write path. The books go
// through the ordinary Paratext importer — paired with a source Bible the user
// picks — so every cell carries the verse reference the bridge maps back to
// its unit. The link (GUID → project, book → file) lives in the bridge store.

import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { v7 as uuidv7 } from "uuid"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ParatextChoice } from "@/components/import/ParatextChoice"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { useParatextDiscovery } from "@/lib/paratext-bridge/use-paratext-discovery"
import { bridgeStore } from "@/lib/paratext-bridge/store"
import { otherCopies } from "@/lib/paratext-bridge/copies"
import { clearPendingImport, getPendingImport, setPendingImport } from "@/lib/paratext-bridge/pending-import"
import { setMirrorBase } from "@/lib/paratext-bridge/book-sync"
import { paratextTauri } from "@/lib/paratext-bridge/tauri"
import { decodeUtf8Strict } from "@/lib/paratext-bridge/units"
import type { ProjectEntry } from "@/lib/parsers/paratext-project"
import type { FileReference } from "@/lib/parsers/types"
import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProjectLane, fetchProjectSettings, fetchProjectSettingsResult, renameProjectLane } from "@/lib/sync/project-settings"
import { createProject } from "@/lib/store/project-index"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"

function editorPathForLink(projectId: string, fileId: string | undefined): string {
  return fileId ? `/project/${projectId}/editor/file/${fileId}` : `/project/${projectId}/editor`
}

type Phase =
  | { kind: "reading" }
  | { kind: "creating" }
  | { kind: "import"; projectId: string; targetLang: string; entries: ProjectEntry[]; jwt: string }
  | { kind: "error"; message: string }

export function ParatextOpenPage() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const projectPath = params.get("project")
  const d = useParatextDiscovery()
  const project = useMemo(() => d.projects.find((p) => p.path === projectPath) ?? null, [d.projects, projectPath])
  const raw = useMemo(() => d.discovery?.projects.find((p) => p.path === projectPath) ?? null, [d.discovery, projectPath])
  const { session } = useFrontierSession()
  const org = useActiveOrgOptional()
  const [phase, setPhase] = useState<Phase>({ kind: "reading" })
  const started = useRef(false)
  // Unmount only. The setup below runs once and must survive re-renders: a
  // fresh session or org object used to cancel it after the cloud project was
  // made, leaving the page on "Creating" and the project unlinked.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  /** The book bytes the import read, by file name: the mirror's base. */
  const importedBytes = useRef(new Map<string, Uint8Array>())

  useEffect(() => {
    // Wait for the org: a project created before it is known lands outside it.
    if (!project || !raw || !session || org?.isLoading || started.current) return
    started.current = true
    const { jwt, username } = session
    const orgId = org?.activeOrgId ?? null
    const run = async () => {
      // Already mirrored, from this folder or from another copy of the same
      // project (Paratext 9 and 10 each keep one): straight to its editor.
      // A second Aquilla project for the same Paratext project is never made.
      let existing = await bridgeStore.link(project.stateId)
      for (const other of otherCopies(project, d.projects)) existing ??= await bridgeStore.link(other.stateId)
      if (existing) {
        const first = project.books.map((b) => existing.books[b.code]?.fileId).find(Boolean)
        navigate(editorPathForLink(existing.projectId, first), { replace: true })
        return
      }
      // Read the project folder as the importer expects it: Settings.xml,
      // BookNames.xml when present, and every book file. A book the bridge
      // cannot read (not UTF-8) is left out rather than failing the import.
      const entries: ProjectEntry[] = [{ name: "Settings.xml", text: async () => raw.settingsXml }]
      try {
        const names = await paratextTauri.readFile(project.path, "BookNames.xml")
        entries.push({ name: "BookNames.xml", text: async () => decodeUtf8Strict(names) })
      } catch { /* optional */ }
      for (const b of project.books) {
        const bytes = await paratextTauri.readFile(project.path, b.fileName)
        const text = decodeUtf8Strict(bytes)
        importedBytes.current.set(b.fileName, bytes)
        entries.push({ name: b.fileName, text: async () => text })
      }
      if (!alive.current) return
      // Left at the source step last time: carry on with that project.
      const pending = getPendingImport(project.stateId)
      if (pending && (await fetchProjectSettingsResult(jwt, pending.projectId)).ok) {
        if (alive.current) setPhase({ kind: "import", projectId: pending.projectId, targetLang: pending.targetLang, entries, jwt })
        return
      }
      setPhase({ kind: "creating" })
      const projectId = uuidv7()
      const name = project.settings.fullName || project.settings.name
      const language = project.settings.language || project.settings.languageIsoCode || ""
      await createCloudProject(jwt, { id: projectId, name, ...(orgId != null ? { orgId } : {}) })
      // Languages are lane rows: the source lane is named once the import has
      // picked a source Bible; the Paratext project's language is the target.
      let targetLang = ""
      const created = language ? await createProjectLane(jwt, projectId, { name: "", language }) : null
      if (created?.kind === "ok") targetLang = created.lane.legacyTag ?? ""
      setPendingImport(project.stateId, { projectId, targetLang })
      await createProject({
        id: projectId, name, sourceLanguage: "", targetLanguage: language,
        createdAt: new Date().toISOString(), files: [], members: [{ userId: username, role: "owner" }],
      })
      if (!alive.current) return
      setPhase({ kind: "import", projectId, targetLang, entries, jwt })
    }
    run().catch((e: unknown) => { if (alive.current) setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) }) })
  }, [project, raw, session, org?.isLoading, org?.activeOrgId, navigate, d.projects])

  const getToken = useMemo(
    () => (phase.kind === "import" ? buildFileScopedTokenFetcher(() => phase.jwt, phase.projectId) : async () => null),
    [phase],
  )

  const onImported = async (refs: FileReference[], inferred?: { sourceLanguage?: string }) => {
    if (phase.kind !== "import" || !project) return
    if (inferred?.sourceLanguage && session) {
      const settings = await fetchProjectSettings(session.jwt, phase.projectId).catch(() => null)
      const sourceLane = settings?.lanes?.find((l) => l.role === "source")
      if (sourceLane) await renameProjectLane(session.jwt, phase.projectId, sourceLane.id, { language: inferred.sourceLanguage }).catch(() => undefined)
    }
    const books: Record<string, { fileId: string; fileName: string }> = {}
    for (const ref of refs) {
      const code = ref.bookCode?.toUpperCase()
      const file = code ? project.books.find((b) => b.code === code) : undefined
      if (code && file) books[code] = { fileId: ref.id, fileName: file.fileName }
    }
    const mirrored = Object.values(books).flatMap((b) => importedBytes.current.get(b.fileName) ?? [])
    await setMirrorBase(project.stateId, mirrored)
    await bridgeStore.putLink({
      projectGuid: project.guid, projectPath: project.path, projectId: phase.projectId,
      books, targetLang: phase.targetLang, createdAt: Date.now(),
    })
    clearPendingImport(project.stateId)
    const first = project.books.map((b) => books[b.code]?.fileId).find(Boolean)
    navigate(editorPathForLink(phase.projectId, first), { replace: true })
  }

  const title = project?.settings.fullName ?? ""
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("paratextBridge.open.title")} parent={{ label: t("paratextBridge.title"), to: "/paratext" }} />}
      statusBar={null}
      main={
        <Page>
          <PageHeader
            title={title || t("paratextBridge.open.title")}
            description={t("paratextBridge.open.description")}
            actions={<Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/paratext" />}><ArrowLeft />{t("paratextBridge.book.back")}</Button>}
          />
          {!d.supported ? (
            <p className="text-sm text-muted-foreground">{t("paratextBridge.notDesktop")}</p>
          ) : !session ? (
            <p className="text-sm text-muted-foreground">{t("paratextBridge.open.needLogin")}</p>
          ) : d.error ? (
            <p className="text-sm text-destructive">{d.error}</p>
          ) : !project || !raw ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.scanning")}</div>
          ) : phase.kind === "error" ? (
            <p className="text-sm text-destructive">{phase.message}</p>
          ) : phase.kind === "reading" || phase.kind === "creating" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />{phase.kind === "reading" ? t("paratextBridge.open.reading") : t("paratextBridge.open.creating")}
            </div>
          ) : (
            <div className="max-w-2xl">
              <ParatextChoice
                entries={phase.entries}
                bookCount={project.books.length}
                projectId={phase.projectId}
                username={session.username}
                sourceLanguage=""
                targetLanguage={project.settings.language || project.settings.languageIsoCode || ""}
                targetLang={phase.targetLang}
                getToken={getToken}
                initialMode="pickSource"
                onImported={onImported}
                onCancel={() => navigate("/paratext")}
              />
            </div>
          )}
        </Page>
      }
    />
  )
}
