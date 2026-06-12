/**
 * MarkedSnippet — renders an FTS5 snippet string containing literal
 * `<mark>...</mark>` markers as highlighted text.
 *
 * The server only ever emits <mark> tags — no other tags are injected.
 * We walk the string manually so no raw HTML is set on the DOM.
 */
export function MarkedSnippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>.*?<\/mark>)/g)
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^<mark>(.*)<\/mark>$/)
        if (match) {
          return (
            <mark
              key={i}
              className="bg-yellow-200/60 dark:bg-yellow-700/50 rounded-[2px] px-[1px] text-inherit"
            >
              {match[1]}
            </mark>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
