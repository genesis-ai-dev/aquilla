export function ComingSoonStep({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 opacity-60">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/30 text-[10px] text-muted-foreground">
        —
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Coming soon
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
