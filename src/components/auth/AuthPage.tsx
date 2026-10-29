import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useBrand } from "@/branding/use-brand"
import { Card } from "@/components/ui/card"
import { VersionBadge } from "@/components/VersionBadge"

/** The standalone counterpart to the app's account dialog. */
export function AuthPage({ children, label }: { children: ReactNode; label?: string }) {
  const brand = useBrand()
  const Mark = brand.logo.Mark

  return (
    <main aria-label={label} className="flex min-h-svh flex-col items-center gap-6 bg-background p-4 sm:p-6">
      <div className="flex w-full flex-1 items-center justify-center py-6 sm:py-10">
        <div className="flex w-full max-w-md flex-col gap-6">
          <Link to="/app" className="mx-auto inline-flex items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <Mark className="size-9" aria-hidden />
            <span className="text-lg font-semibold">{brand.app.name}</span>
          </Link>
          {children}
        </div>
      </div>
      <footer className="w-full max-w-md">
        <VersionBadge inline />
      </footer>
    </main>
  )
}

export function AuthPanel({ children }: { children: ReactNode }) {
  return <Card className="w-full [--card-spacing:--spacing(6)]">{children}</Card>
}
