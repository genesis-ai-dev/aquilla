/** Live grant sentence shown above an add/invite submit button (AQU-1030). */
export function GrantScopeNotice({ sentence }: { sentence: string }) {
  return (
    <p className="text-xs text-muted-foreground" data-testid="grant-scope-sentence">
      {sentence}
    </p>
  )
}
