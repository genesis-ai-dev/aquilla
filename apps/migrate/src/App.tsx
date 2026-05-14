// Placeholder UI for the migrate app (Phase 3d).
//
// GitLab integration is being phased out (AD-7). This app will eventually
// surface a one-time migration tool for translators with legacy
// GitLab-backed projects, then become inert once the migration window
// closes. For now the surface exists only so the deploy-all-apps workflow
// can pick the app up in its matrix and routes.json's `/migrate` mount
// serves something coherent on preview.

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12 text-slate-800">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Aquilla / Legacy migration
        </p>
        <h1 className="text-3xl font-semibold text-slate-900">
          Legacy migration
        </h1>
        <p className="text-base text-slate-600">
          Coming soon. GitLab integration is being phased out; this app will
          surface a one-time migration tool for translators with legacy
          projects.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Migrate a legacy project
        </h2>
        <form className="mt-4 flex flex-col gap-4" aria-disabled="true">
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="migrate-url" className="text-slate-700">
              GitLab project URL
            </label>
            <input
              id="migrate-url"
              type="url"
              disabled
              placeholder="https://gitlab.com/owner/legacy-project"
              className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
            />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="migrate-token" className="text-slate-700">
              GitLab access token
            </label>
            <input
              id="migrate-token"
              type="password"
              disabled
              placeholder="glpat-…"
              className="cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
            />
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500"
            >
              Start migration
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-slate-400">
          Disabled until the migration importer is wired up after Phase 2c-β.
        </p>
      </section>
    </main>
  )
}
