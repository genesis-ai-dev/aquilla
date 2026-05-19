// Placeholder UI for the import app (Phase 3d).
//
// The real import flow — parsers, file ingestion, event emission — is
// deferred until after Phase 2c-β lands its parser + import-pipeline
// rewrite (parsers will emit `source.cell.create` events directly). For
// now this surface owns the AD-11 route handoff from the workspace while
// the parser commit path is still being extracted into a shared package.

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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12 text-slate-800">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Aquilla / Import
        </p>
        <h1 className="text-3xl font-semibold text-slate-900">
          Import source documents
        </h1>
        <p className="text-base text-slate-600">
          This focused import surface receives project context from the
          workspace and writes parsed source cells through the event log.
          Parser commit wiring is the remaining implementation step.
        </p>
        {projectId && (
          <p className="text-sm text-slate-500">
            Project: <span className="font-mono text-slate-700">{projectId}</span>
          </p>
        )}
        <a
          href={returnTo}
          className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
        >
          Return
        </a>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Planned formats
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PLANNED_FORMATS.map((f) => (
            <li
              key={f.ext}
              className="flex items-baseline justify-between rounded border border-slate-100 bg-slate-50 px-3 py-2"
            >
              <span className="font-mono text-sm text-slate-800">{f.ext}</span>
              <span className="text-xs text-slate-500">{f.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm text-slate-500">
          Drop a source document here to import it.
        </p>
        <div className="mt-4 flex justify-center">
          <label
            htmlFor="import-file-picker"
            aria-disabled="true"
            className="cursor-not-allowed rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500"
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
        <p className="mt-3 text-xs text-slate-400">
          Standalone import is not wired up yet; the route boundary is ready.
        </p>
      </section>
    </main>
  )
}
