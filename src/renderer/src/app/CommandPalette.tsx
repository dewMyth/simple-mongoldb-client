/**
 * Command palette (Cmd/Ctrl+K): switch tabs, jump to any collection on any open connection,
 * re-run a recent query, and run workspace commands.
 */
import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Columns2, CopyPlus, History, Info, Rows2, RotateCcw, Table2, X } from 'lucide-react'
import type { QueryText } from '@shared/query'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from '../components/ui/command'
import { ipc } from '../lib/ipc'
import { keys, useActiveConnections, useSavedConnections } from '../features/connections/queries'
import { useResultsStore } from '../features/documents/results-store'
import { colorHex } from '../features/connections/colors'
import { useTabsStore } from '../stores/tabs'
import { usePaletteStore } from '../stores/palette'

/** Databases scanned per connection, to keep the palette quick on large clusters. */
const MAX_DATABASES = 100
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl+'

function summary(q: QueryText): string {
  const filter = q.filter.trim() || '{}'
  const extras = (['sort', 'project', 'limit'] as const)
    .filter((k) => q[k].trim())
    .map((k) => `${k}: ${q[k].trim()}`)
  return [filter, ...extras].join('  ·  ')
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open)
  const setOpen = usePaletteStore((s) => s.setOpen)
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const split = useTabsStore((s) => s.split)
  const closedCount = useTabsStore((s) => s.closed.length)
  const { data: saved = [] } = useSavedConnections()
  const { data: active = [] } = useActiveConnections()
  const connName = (id: string) => saved.find((c) => c.id === id)?.name ?? 'Connection'
  const connColor = (id: string) => colorHex[saved.find((c) => c.id === id)?.color ?? 'none']

  // Databases and collections of every open connection (shared cache with the sidebar).
  const dbQueries = useQueries({
    queries: active.map((c) => ({
      queryKey: keys.databases(c.id),
      queryFn: () => ipc('db:listDatabases', c.id),
      enabled: open
    }))
  })
  const dbs = active.flatMap((c, i) =>
    (dbQueries[i]?.data ?? []).slice(0, MAX_DATABASES).map((d) => ({ connectionId: c.id, db: d.name }))
  )
  const collQueries = useQueries({
    queries: dbs.map((d) => ({
      queryKey: keys.collections(d.connectionId, d.db),
      queryFn: () => ipc('db:listCollections', { connectionId: d.connectionId, db: d.db }),
      enabled: open
    }))
  })
  const collections = dbs.flatMap((d, i) =>
    (collQueries[i]?.data ?? []).map((c) => ({ ...d, name: c.name, ns: `${d.db}.${c.name}` }))
  )

  const activeIds = useMemo(() => active.map((c) => c.id), [active])
  const { data: recent = [] } = useQuery({
    queryKey: ['history-recent', activeIds],
    queryFn: () => ipc('history:recent', { limit: 30, connectionIds: activeIds }),
    enabled: open && activeIds.length > 0
  })

  const close = () => setOpen(false)
  const store = useTabsStore.getState
  const current = split && store().focusedPane === 'secondary' ? split.tabId : activeId

  const runRecent = (connectionId: string, ns: string, query: QueryText) => {
    const tabId = store().open(
      { type: 'documents', connectionId, ns, title: ns.slice(ns.indexOf('.') + 1), query, autoRun: false },
      { newTab: false }
    )
    void useResultsStore.getState().run({ tabId, connectionId, ns, query })
  }

  const act = (fn: () => void) => () => {
    close()
    fn()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Switch tabs, open collections and re-run recent queries"
      className="sm:max-w-xl"
    >
      <CommandInput placeholder="Search tabs, collections, recent queries…" data-testid="palette-input" />
      <CommandList className="max-h-[60vh]" data-testid="palette-list">
        <CommandEmpty>Nothing found.</CommandEmpty>

        {tabs.length > 0 && (
          <CommandGroup heading="Open tabs">
            {tabs.map((t) => (
              <CommandItem
                key={t.id}
                value={`tab ${t.title} ${t.ns ?? ''} ${connName(t.connectionId)} ${t.id}`}
                onSelect={act(() => store().activate(t.id))}
                data-testid={`palette-tab-${t.ns ?? t.title}`}
              >
                {t.type === 'connection-info' ? <Info /> : <Table2 />}
                <span className="truncate">{t.ns ?? t.title}</span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Dot color={connColor(t.connectionId)} />
                  {connName(t.connectionId)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {collections.length > 0 && (
          <CommandGroup heading="Collections">
            {collections.map((c) => (
              <CommandItem
                key={`${c.connectionId}|${c.ns}`}
                value={`collection ${c.ns} ${connName(c.connectionId)} ${c.connectionId}`}
                onSelect={act(() =>
                  store().open({ type: 'documents', connectionId: c.connectionId, ns: c.ns, title: c.name })
                )}
                data-testid={`palette-coll-${c.ns}`}
              >
                <Table2 />
                <span className="truncate">{c.ns}</span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Dot color={connColor(c.connectionId)} />
                  {connName(c.connectionId)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {recent.length > 0 && (
          <CommandGroup heading="Recent queries">
            {recent.map((r) => (
              <CommandItem
                key={`${r.connectionId}|${r.ns}|${r.id}`}
                value={`recent ${r.ns} ${summary(r.query)} ${r.id}`}
                onSelect={act(() => runRecent(r.connectionId, r.ns, r.query))}
                data-testid="palette-recent"
              >
                <History />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary(r.query)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.ns}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Commands">
          {closedCount > 0 && (
            <CommandItem value="command reopen closed tab" onSelect={act(() => store().reopenClosed())}>
              <RotateCcw /> Reopen closed tab <CommandShortcut>{mod}⇧T</CommandShortcut>
            </CommandItem>
          )}
          {current && (
            <>
              <CommandItem value="command duplicate tab" onSelect={act(() => store().duplicate(current))}>
                <CopyPlus /> Duplicate tab
              </CommandItem>
              <CommandItem
                value="command split right"
                onSelect={act(() => store().splitWith(current, 'horizontal'))}
              >
                <Columns2 /> Split right
              </CommandItem>
              <CommandItem
                value="command split down"
                onSelect={act(() => store().splitWith(current, 'vertical'))}
              >
                <Rows2 /> Split down
              </CommandItem>
              <CommandItem
                value="command close other tabs"
                onSelect={act(() => store().closeOthers(current))}
              >
                <X /> Close other tabs
              </CommandItem>
            </>
          )}
          {split && (
            <CommandItem value="command close split" onSelect={act(() => store().closeSplit())}>
              <X /> Close split view
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

function Dot({ color }: { color: string | null }) {
  return color ? <span className="size-2 rounded-full" style={{ background: color }} /> : null
}
