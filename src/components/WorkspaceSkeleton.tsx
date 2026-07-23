import { LoadingOverlay } from "@/components/ui/loading-overlay"
import { Skeleton } from "@/components/ui/skeleton"

const ROWS = 7

export function WorkspaceSkeleton() {
  return (
    <LoadingOverlay label="Loading project" data-testid="workspace-loading">
      <div
        data-testid="workspace-loading-template"
        className="flex min-h-screen bg-sidebar"
      >
        <aside className="hidden w-72 shrink-0 flex-col gap-4 p-3 sm:flex">
          <div className="flex items-center justify-between">
            <Skeleton className="size-8 rounded-lg" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 9 }).map((_, index) => (
              <Skeleton
                key={index}
                className="h-8"
                style={{ width: `${72 + (index % 3) * 8}%` }}
              />
            ))}
          </div>
          <div className="mt-auto flex flex-col gap-2">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-10 w-full" />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center justify-between gap-4 px-4">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-8 w-72" />
          </div>
          <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background p-3">
            <Skeleton className="mb-3 h-9 w-56" />
            <div className="flex flex-col gap-2 overflow-hidden">
              {Array.from({ length: ROWS }).map((_, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[56px_1fr_1fr_56px] gap-3 rounded-2xl bg-card px-4 py-3"
                >
                  <Skeleton className="h-6 w-10" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-6 w-10" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </LoadingOverlay>
  )
}
