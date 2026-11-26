import type { ReactNode } from "react"
import { useInRouterContext, useNavigate } from "react-router-dom"
import { buildExtensionPath, type WhereChoice } from "@/lib/tools/builder-model"

interface BuildExtensionTriggerProps {
  projectId: string
  where: WhereChoice
  fileId?: string | null
  onBeforeNavigate?: () => void
  className?: string
  testId?: string
  ariaLabel?: string
  title?: string
  children: ReactNode
}

function RouterTrigger({
  to,
  onBeforeNavigate,
  className,
  testId,
  ariaLabel,
  title,
  children,
}: Omit<BuildExtensionTriggerProps, "projectId" | "where" | "fileId"> & { to: string }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
      title={title}
      onClick={() => {
        onBeforeNavigate?.()
        navigate(to)
      }}
    >
      {children}
    </button>
  )
}

/**
 * Contextual "+ Build a…" button that deep-links to `/project/:id/extensions?where=...`
 * while staying safe if a parent dialog is rendered outside a React Router in unit tests.
 */
export function BuildExtensionTrigger({
  projectId,
  where,
  fileId,
  onBeforeNavigate,
  className,
  testId,
  ariaLabel,
  title,
  children,
}: BuildExtensionTriggerProps) {
  const inRouter = useInRouterContext()
  const to = buildExtensionPath(projectId, { where, fileId })
  if (inRouter) {
    return (
      <RouterTrigger
        to={to}
        onBeforeNavigate={onBeforeNavigate}
        className={className}
        testId={testId}
        ariaLabel={ariaLabel}
        title={title}
      >
        {children}
      </RouterTrigger>
    )
  }
  return (
    <a
      href={to}
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
      title={title}
      onClick={(e) => {
        e.preventDefault()
        onBeforeNavigate?.()
      }}
    >
      {children}
    </a>
  )
}
