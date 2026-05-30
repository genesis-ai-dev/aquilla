import { useActiveOrg } from "@/context/OrgContext"

export function OrgBreadcrumb({ section }: { section: string }) {
  const { activeOrg } = useActiveOrg()
  return (
    <div className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{activeOrg?.name ?? "Workspace"}</span>
      <span>›</span>
      <span>{section}</span>
    </div>
  )
}
