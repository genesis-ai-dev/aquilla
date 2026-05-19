// Placeholder UI for the import app (Phase 3d).
//
// The real import flow — parsers, file ingestion, event emission — is
// deferred until after Phase 2c-β lands its parser + import-pipeline
// rewrite (parsers will emit `source.cell.create` events directly). For
// now this surface owns the AD-11 route handoff from the workspace while
// the parser commit path is still being extracted into a shared package.

import { AppHeader } from "@aquilla/ui"

const PLANNED_FORMATS = [
  { ext: "USFM", note: "scripture (paratext)" },
  { ext: "DOCX", note: "Microsoft Word" },
  { ext: "PPTX", note: "Microsoft PowerPoint" },
  { ext: "Markdown", note: ".md / .markdown" },
  { ext: "Plaintext", note: ".txt" },
  { ext: "VTT / SRT", note: "subtitles" },
] as const

function launchContext(): {
  projectId: string | null
  returnTo: string
} {
  if (typeof window === "undefined") {
    return { projectId: null, returnTo: "/projects/" }
  }
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get("project")
  return {
    projectId,
    returnTo: params.get("return") || (projectId ? `/w/${projectId}/` : "/projects/"),
  }
}

export function App() {
  const { projectId, returnTo } = launchContext()

  return (
    <div className="min-h-screen bg-background">
      <AppHeader title="Import" titleHref="/projects/" />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Aquilla / Import
          </p>
          <h1 className="text-3xl font-semibold">Import source documents</h1>
          <p className="text-base text-muted-foreground">
            This focused import surface receives project context from the
            workspace and writes parsed source cells through the event log.
            Parser commit wiring is the remaining implementation step.
          </p>
          {projectId && (
            <p className="text-sm text-muted-foreground">
              Project:{" "}
              <span className="font-mono text-foreground">{projectId}</span>
            </p>
          )}
          <a
            href={returnTo}
            className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
          >
            Return
          </a>
        </header>

        <section className="rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Planned formats
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PLANNED_FORMATS.map((f) => (
              <li
                key={f.ext}
                className="flex items-baseline justify-between rounded border bg-muted px-3 py-2"
              >
                <span className="font-mono text-sm">{f.ext}</span>
                <span className="text-xs text-muted-foreground">{f.note}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-dashed bg-muted/50 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Drop a source document here to import it.
          </p>
          <div className="mt-4 flex justify-center">
            <label
              htmlFor="import-file-picker"
              aria-disabled="true"
              className="cursor-not-allowed rounded-md bg-muted px-4 py-2 text-sm font-medium text-muted-foreground"
            >
              Choose file
            </label>
            <input
              id="import-file-picker"
              type="file"
              disabled
              className="hidden"
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Standalone import is not wired up yet; the route boundary is ready.
          </p>
        </section>
      </main>
    </div>
  )
}
