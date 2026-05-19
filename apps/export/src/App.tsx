// Placeholder UI for the export app (Phase 3d).
//
// The real export flow — surgical rebuilders, format selection, packaging —
// is deferred until after Phase 2c-β rewrites the underlying parser +
// import pipeline. For now this surface exists only so the deploy-all-apps
// workflow can pick the app up in its matrix and routes.json's `/export`
// mount owns the AD-11 route handoff from the workspace.

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
  fileId: string | null
  returnTo: string
} {
  if (typeof window === "undefined") {
    return { projectId: null, fileId: null, returnTo: "/projects/" }
  }
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get("project")
  const fileId = params.get("file")
  return {
    projectId,
    fileId,
    returnTo: params.get("return") || (projectId ? `/w/${projectId}/` : "/projects/"),
  }
}

export function App() {
  const { projectId, fileId, returnTo } = launchContext()

  return (
    <div className="min-h-screen bg-background">
      <AppHeader title="Export" titleHref="/projects/" />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Aquilla / Export
          </p>
          <h1 className="text-3xl font-semibold">Export translations</h1>
          <p className="text-base text-muted-foreground">
            This focused export surface receives project context from the
            workspace and will rebuild deliverables from server state.
          </p>
          {projectId && (
            <p className="text-sm text-muted-foreground">
              Project:{" "}
              <span className="font-mono text-foreground">{projectId}</span>
              {fileId ? (
                <>
                  {" "}/ File:{" "}
                  <span className="font-mono text-foreground">{fileId}</span>
                </>
              ) : null}
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
            Output formats
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PLANNED_FORMATS.map((f) => (
              <li key={f.ext} className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm">{f.ext}</span>
                  <span className="text-xs text-muted-foreground">{f.note}</span>
                </div>
                <button
                  type="button"
                  disabled
                  aria-label={`Export as ${f.ext} (disabled — coming soon)`}
                  className="cursor-not-allowed rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
                >
                  Export
                </button>
              </li>
            ))}
          </ul>
        </section>

        <p className="text-xs text-muted-foreground">
          Standalone exporting is not wired up yet.
        </p>
      </main>
    </div>
  )
}
