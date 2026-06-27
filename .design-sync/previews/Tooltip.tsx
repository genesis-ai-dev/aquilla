import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  Button,
} from "codex-web-app"

export function ReviewerStatus() {
  return (
    <TooltipProvider delay={0}>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          paddingTop: 24,
        }}
      >
        <Tooltip defaultOpen>
          <TooltipTrigger
            render={<Button variant="outline" size="sm">MRK 4:3</Button>}
          />
          <TooltipContent side="bottom">
            Reviewed by Anna · Tok Pisin · 2 days ago
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
