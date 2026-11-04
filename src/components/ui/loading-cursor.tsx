import { cn } from "@/lib/utils"

/**
 * Blinking terminal-style cursor that marks the one place in a region where
 * content is still being written: the end of the sidebar's nav list, the
 * pending crumb in the breadcrumb, the top of a main body that has not
 * arrived yet. One per region, so the page reads as "printing", not as a
 * field of placeholders. It inherits the font size of its parent, so it sits
 * on the baseline the text will land on. Purely decorative: the container
 * announces the loading state (`role="status"` / `aria-busy`).
 */
function LoadingCursor({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="loading-cursor"
      aria-hidden="true"
      className={cn(
        "inline-block h-[1em] w-[0.5em] translate-y-[0.1em] rounded-[2px] bg-foreground/50",
        "animate-cursor-blink motion-reduce:animate-none motion-reduce:opacity-40",
        className,
      )}
      {...props}
    />
  )
}

export { LoadingCursor }
