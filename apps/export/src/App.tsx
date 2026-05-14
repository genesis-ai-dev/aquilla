// Placeholder UI for the export app (Phase 3d).
//
// The real export flow — surgical rebuilders, format selection, packaging —
// is deferred until after Phase 2c-β rewrites the underlying parser +
// import pipeline. For now this surface exists only so the deploy-all-apps
// workflow can pick the app up in its matrix and routes.json's `/export`
// mount serves something coherent on preview.

const PLANNED_FORMATS = [
  { ext: "USFM", note: "scripture (paratext)" },
  { ext: "DOCX", note: "Microsoft Word" },
  { ext: "PPTX", note: "Microsoft PowerPoint" },
  { ext: "Markdown", note: ".md / .markdown" },
  { ext: "Plaintext", note: ".txt" },
  { ext: "VTT / SRT", note: "subtitles" },
] as const

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12 text-slate-800">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Aquilla / Export
        </p>
        <h1 className="text-3xl font-semibold text-slate-900">
          Export translations
        </h1>
        <p className="text-base text-slate-600">
          Coming soon. Standalone exporting will live here. For now, open a
          project from your dashboard and use the workspace's export
          surface.
        </p>
        <a
          href="/projects/"
          className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
        >
          ← Back to projects
        </a>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Output formats
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PLANNED_FORMATS.map((f) => (
            <li key={f.ext} className="flex items-center justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm text-slate-800">{f.ext}</span>
                <span className="text-xs text-slate-500">{f.note}</span>
              </div>
              <button
                type="button"
                disabled
                aria-label={`Export as ${f.ext} (disabled — coming soon)`}
                className="cursor-not-allowed rounded-md bg-slate-200 px-3 py-1 text-xs font-medium text-slate-500"
              >
                Export
              </button>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-slate-400">
        Standalone exporting is not wired up yet.
      </p>
    </main>
  )
}
