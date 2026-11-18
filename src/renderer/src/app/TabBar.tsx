export function TabBar() {
  return (
    <div
      className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-panel px-2 [-webkit-app-region:drag]"
      data-testid="tab-bar"
    >
      <div className="flex h-8 items-center rounded-t-md border border-b-0 border-border bg-bg px-3 text-xs [-webkit-app-region:no-drag]">
        Welcome
      </div>
    </div>
  )
}
