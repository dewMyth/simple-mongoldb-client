/** Renders a permission reason, showing `backtick` parts as inline code. */
export function ReasonText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          <code key={i} className="rounded bg-muted px-1 font-mono text-[0.95em] text-foreground">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  )
}
