// Placeholder UI for the migrate app (Phase 3d).
//
// GitLab integration is being phased out (AD-7). This app will eventually
// surface a one-time migration tool for translators with legacy
// GitLab-backed projects, then become inert once the migration window
// closes. For now the surface exists only so the deploy-all-apps workflow
// can pick the app up in its matrix and routes.json's `/migrate` mount
// serves something coherent on preview.

import { AppHeader } from "@aquilla/ui"

export function App() {
  return (
    <div className="min-h-screen bg-background">
      <AppHeader title="Legacy migration" titleHref="/projects/" />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Aquilla / Legacy migration
          </p>
          <h1 className="text-3xl font-semibold">Legacy migration</h1>
          <p className="text-base text-muted-foreground">
            Coming soon. A one-time migration tool for translators with
            legacy GitLab-backed projects will live here.
          </p>
          <a
            href="/projects/"
            className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
          >
            ← Back to projects
          </a>
        </header>

        <section className="rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Migrate a legacy project
          </h2>
          <form className="mt-4 flex flex-col gap-4" aria-disabled="true">
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor="migrate-url">GitLab project URL</label>
              <input
                id="migrate-url"
                type="url"
                disabled
                placeholder="https://gitlab.com/owner/legacy-project"
                className="cursor-not-allowed rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
              />
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor="migrate-token">GitLab access token</label>
              <input
                id="migrate-token"
                type="password"
                disabled
                placeholder="glpat-…"
                className="cursor-not-allowed rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
              />
            </div>
            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded-md bg-muted px-4 py-2 text-sm font-medium text-muted-foreground"
              >
                Start migration
              </button>
            </div>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            The migration importer is not wired up yet.
          </p>
        </section>
      </main>
    </div>
  )
}
