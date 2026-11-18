import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Clock, Database, Eye, Folder, Lock, Plug, Table2 } from 'lucide-react'
import type { CollectionInfo, SavedConnection } from '@shared/connection'
import { ContextMenu, type MenuItem } from '../../components/Menu'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Spinner } from '../../components/form'
import { ipc } from '../../lib/ipc'
import { formatBytes, formatCount } from '../../lib/format'
import { useTabsStore } from '../../stores/tabs'
import { openAggregation } from '../aggregation/open'
import { colorHex } from './colors'
import { ConnectionDialog } from './ConnectionDialog'
import { CreateCollectionDialog } from './CreateCollectionDialog'
import { useCan, useCanCreateDatabase } from '../permissions/queries'
import {
  keys,
  useActiveConnections,
  useCollections,
  useConnect,
  useDatabases,
  useDisconnect,
  useSavedConnections
} from './queries'

export function ConnectionTree({ filter }: { filter: string }) {
  const { data: saved = [], isLoading } = useSavedConnections()

  const groups = useMemo(() => {
    const byFolder = new Map<string, SavedConnection[]>()
    for (const c of [...saved].sort((a, b) => a.name.localeCompare(b.name))) {
      const list = byFolder.get(c.folder) ?? []
      list.push(c)
      byFolder.set(c.folder, list)
    }
    return [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [saved])

  if (isLoading) return null
  if (!saved.length)
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        No connections yet. Click + to add one.
      </div>
    )

  return (
    <div className="flex flex-col py-1 text-[13px]" role="tree" data-testid="connection-tree">
      {groups.map(([folder, conns]) =>
        folder ? (
          <FolderNode key={folder} name={folder}>
            {conns.map((c) => (
              <ConnectionNode key={c.id} conn={c} filter={filter} depth={1} />
            ))}
          </FolderNode>
        ) : (
          conns.map((c) => <ConnectionNode key={c.id} conn={c} filter={filter} depth={0} />)
        )
      )}
    </div>
  )
}

function Row({
  depth,
  expanded,
  onToggle,
  onClick,
  onDoubleClick,
  icon,
  label,
  right,
  testId,
  active
}: {
  depth: number
  expanded?: boolean
  onToggle?: () => void
  onClick?: (e: MouseEvent) => void
  onDoubleClick?: () => void
  icon: ReactNode
  label: ReactNode
  right?: ReactNode
  testId?: string
  active?: boolean
}) {
  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      data-testid={testId}
      onClick={(e) => (onClick ? onClick(e) : onToggle?.())}
      onDoubleClick={onDoubleClick}
      className={cn(
        'group flex h-7 cursor-default items-center gap-1.5 pr-2 hover:bg-panel-2',
        active && 'bg-panel-2'
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span
        className="flex w-3.5 justify-center text-muted-foreground"
        onClick={(e) => {
          if (onToggle && onClick) {
            e.stopPropagation()
            onToggle()
          }
        }}
      >
        {onToggle ? (
          <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
        ) : null}
      </span>
      <span className="flex shrink-0 items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right ? (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{right}</span>
      ) : null}
    </div>
  )
}

function FolderNode({ name, children }: { name: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Row
        depth={0}
        expanded={open}
        onToggle={() => setOpen(!open)}
        icon={<Folder size={14} />}
        label={<span className="text-muted-foreground">{name}</span>}
      />
      {open && children}
    </>
  )
}

function ConnectionNode({ conn, filter, depth }: { conn: SavedConnection; filter: string; depth: number }) {
  const qc = useQueryClient()
  const createDb = useCanCreateDatabase(conn.id)
  const { data: active = [] } = useActiveConnections()
  const isOpen = active.some((a) => a.id === conn.id)
  const connect = useConnect()
  const disconnect = useDisconnect()
  const closeTabs = useTabsStore((s) => s.closeForConnection)
  const openTab = useTabsStore((s) => s.open)
  const [expanded, setExpanded] = useState(true)
  const [dialog, setDialog] = useState<null | 'edit' | 'duplicate' | 'delete' | 'createDb'>(null)

  const doConnect = () => {
    connect.reset()
    connect.mutate(conn.id, { onSuccess: () => setExpanded(true) })
  }
  const doDisconnect = async () => {
    closeTabs(conn.id)
    await disconnect.mutateAsync(conn.id)
  }

  const items: MenuItem[] = [
    isOpen
      ? { label: 'Disconnect', onSelect: () => void doDisconnect() }
      : { label: 'Connect', onSelect: doConnect },
    {
      label: 'Refresh',
      disabled: !isOpen,
      onSelect: () => void qc.invalidateQueries({ queryKey: keys.connection(conn.id) })
    },
    {
      label: 'Connection info',
      disabled: !isOpen,
      onSelect: () => openTab({ type: 'connection-info', connectionId: conn.id, ns: null, title: conn.name })
    },
    {
      label: 'Create database…',
      disabled: !isOpen || !createDb.allowed,
      reason: isOpen ? createDb.reason : undefined,
      onSelect: () => setDialog('createDb'),
      separatorBefore: true
    },
    {
      label: conn.readOnly ? 'Turn read-only off' : 'Turn read-only on',
      onSelect: () =>
        void ipc('connections:setReadOnly', { id: conn.id, readOnly: !conn.readOnly }).then(() =>
          qc.invalidateQueries({ queryKey: keys.saved })
        )
    },
    { label: 'Edit…', onSelect: () => setDialog('edit'), separatorBefore: true },
    { label: 'Duplicate…', onSelect: () => setDialog('duplicate') },
    { label: 'Delete', danger: true, onSelect: () => setDialog('delete') }
  ]

  const dot = colorHex[conn.color]
  return (
    <>
      <ContextMenu items={items}>
        <div>
          <Row
            depth={depth}
            testId={`conn-${conn.name}`}
            expanded={isOpen && expanded}
            onToggle={isOpen ? () => setExpanded(!expanded) : undefined}
            onClick={() => (isOpen ? setExpanded(!expanded) : undefined)}
            onDoubleClick={() => (isOpen ? undefined : doConnect())}
            icon={
              <span className="relative flex">
                <Plug size={14} />
                {dot && (
                  <span
                    className="absolute -right-1 -bottom-0.5 h-2 w-2 rounded-full ring-1 ring-panel"
                    style={{ background: dot }}
                  />
                )}
              </span>
            }
            label={
              <span className="flex items-center gap-1.5">
                <span className={cn(isOpen && 'font-medium')}>{conn.name}</span>
                {conn.readOnly && <Lock size={11} className="text-muted-foreground" aria-label="Read-only" />}
                {conn.production && (
                  <span className="rounded bg-destructive/15 px-1 text-[9px] font-bold text-destructive">
                    PROD
                  </span>
                )}
              </span>
            }
            right={
              connect.isPending ? (
                <Spinner className="size-3" />
              ) : isOpen ? (
                <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-label="Connected" />
              ) : (
                <button
                  type="button"
                  className="hidden rounded px-1.5 text-[11px] text-primary group-hover:block hover:bg-background"
                  onClick={(e) => {
                    e.stopPropagation()
                    doConnect()
                  }}
                >
                  Connect
                </button>
              )
            }
          />
        </div>
      </ContextMenu>
      {connect.error && !isOpen && (
        <div
          className="selectable mx-2 my-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
          style={{ marginLeft: 20 + depth * 14 }}
        >
          {connect.error.message}
        </div>
      )}
      {isOpen && expanded && <DatabaseList connId={conn.id} filter={filter} depth={depth + 1} />}

      {(dialog === 'edit' || dialog === 'duplicate') && (
        <ConnectionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          existing={conn}
          duplicate={dialog === 'duplicate'}
        />
      )}
      {dialog === 'createDb' && (
        <CreateCollectionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          connectionId={conn.id}
          onCreated={() => void qc.invalidateQueries({ queryKey: keys.databases(conn.id) })}
        />
      )}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Delete connection"
        body={
          <>
            Delete the saved connection <b>{conn.name}</b> and its stored credentials? This doesn't touch the
            database.
          </>
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          closeTabs(conn.id)
          await ipc('connections:delete', conn.id)
          await qc.invalidateQueries({ queryKey: keys.saved })
          await qc.invalidateQueries({ queryKey: keys.active })
        }}
      />
    </>
  )
}

function DatabaseList({ connId, filter, depth }: { connId: string; filter: string; depth: number }) {
  const { data, isLoading, error } = useDatabases(connId, true)
  if (isLoading)
    return (
      <Row
        depth={depth}
        icon={<Spinner className="size-3" />}
        label={<span className="text-muted-foreground">Loading…</span>}
      />
    )
  if (error)
    return (
      <div
        className="selectable px-3 py-1 text-[11px] text-destructive"
        style={{ paddingLeft: 20 + depth * 14 }}
      >
        {error.message}
      </div>
    )
  return (
    <>
      {data?.map((d) => (
        <DatabaseNode
          key={d.name}
          connId={connId}
          name={d.name}
          size={d.sizeOnDisk}
          filter={filter}
          depth={depth}
        />
      ))}
    </>
  )
}

function DatabaseNode({
  connId,
  name,
  size,
  filter,
  depth
}: {
  connId: string
  name: string
  size: number | null
  filter: string
  depth: number
}) {
  const qc = useQueryClient()
  const createColl = useCan(connId, name, 'createCollection')
  const dropDb = useCan(connId, name, 'dropDatabase')
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState<null | 'create' | 'drop'>(null)
  const closeTabs = useTabsStore((s) => s.tabs)
  const closeTab = useTabsStore((s) => s.close)
  const { data: colls, isLoading, error } = useCollections(connId, name, expanded || !!filter)

  const f = filter.trim().toLowerCase()
  const visible = f
    ? (colls ?? []).filter((c) => c.name.toLowerCase().includes(f) || name.toLowerCase().includes(f))
    : (colls ?? [])
  if (f && colls && !visible.length) return null
  const isExpanded = expanded || (!!f && visible.length > 0)

  const items: MenuItem[] = [
    {
      label: 'Create collection…',
      disabled: !createColl.allowed,
      reason: createColl.reason,
      onSelect: () => setDialog('create')
    },
    {
      label: 'Refresh',
      onSelect: () => void qc.invalidateQueries({ queryKey: keys.collections(connId, name) })
    },
    {
      label: 'Drop database…',
      danger: true,
      disabled: !dropDb.allowed,
      reason: dropDb.reason,
      onSelect: () => setDialog('drop'),
      separatorBefore: true
    }
  ]

  return (
    <>
      <ContextMenu items={items}>
        <div>
          <Row
            depth={depth}
            testId={`db-${name}`}
            expanded={isExpanded}
            onToggle={() => setExpanded(!expanded)}
            icon={<Database size={14} />}
            label={name}
            right={size ? formatBytes(size) : undefined}
          />
        </div>
      </ContextMenu>
      {isExpanded && isLoading && (
        <Row
          depth={depth + 1}
          icon={<Spinner className="size-3" />}
          label={<span className="text-muted-foreground">Loading…</span>}
        />
      )}
      {isExpanded && error && (
        <div
          className="selectable py-1 text-[11px] text-destructive"
          style={{ paddingLeft: 20 + (depth + 1) * 14 }}
        >
          {error.message}
        </div>
      )}
      {isExpanded &&
        visible.map((c) => (
          <CollectionNode key={c.name} connId={connId} db={name} coll={c} depth={depth + 1} />
        ))}
      {isExpanded && colls && !colls.length && (
        <div
          className="py-1 text-[11px] text-muted-foreground"
          style={{ paddingLeft: 26 + (depth + 1) * 14 }}
        >
          No collections
        </div>
      )}

      {dialog === 'create' && (
        <CreateCollectionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          connectionId={connId}
          db={name}
          onCreated={() => {
            setExpanded(true)
            void qc.invalidateQueries({ queryKey: keys.collections(connId, name) })
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'drop'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Drop database"
        body={
          <>
            This permanently deletes <b>{name}</b> and all of its collections, documents and indexes.
          </>
        }
        typeToConfirm={name}
        confirmLabel="Drop database"
        onConfirm={async () => {
          await ipc('db:dropDatabase', { connectionId: connId, db: name })
          for (const t of closeTabs)
            if (t.connectionId === connId && t.ns?.startsWith(`${name}.`)) closeTab(t.id)
          await qc.invalidateQueries({ queryKey: keys.databases(connId) })
          qc.removeQueries({ queryKey: keys.collections(connId, name) })
        }}
      />
    </>
  )
}

function CollectionNode({
  connId,
  db,
  coll,
  depth
}: {
  connId: string
  db: string
  coll: CollectionInfo
  depth: number
}) {
  const qc = useQueryClient()
  const ns = `${db}.${coll.name}`
  const dropColl = useCan(connId, ns, 'dropCollection')
  const openTab = useTabsStore((s) => s.open)
  const closeTab = useTabsStore((s) => s.close)
  const tabs = useTabsStore((s) => s.tabs)
  const activeTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId))
  const [dropping, setDropping] = useState(false)

  const open = (newTab: boolean) =>
    openTab({ type: 'documents', connectionId: connId, ns, title: coll.name }, { newTab })
  const Icon = coll.type === 'view' ? Eye : coll.type === 'timeseries' ? Clock : Table2

  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => open(false) },
    { label: 'Open in new tab', onSelect: () => open(true) },
    { label: 'Open aggregation', onSelect: () => openAggregation(connId, ns) },
    {
      label: coll.type === 'view' ? 'Drop view…' : 'Drop collection…',
      danger: true,
      disabled: !dropColl.allowed,
      reason: dropColl.reason,
      onSelect: () => setDropping(true),
      separatorBefore: true
    }
  ]

  return (
    <>
      <ContextMenu items={items}>
        <div>
          <Row
            depth={depth}
            testId={`coll-${ns}`}
            active={activeTab?.connectionId === connId && activeTab.ns === ns}
            onClick={(e) => open(e.metaKey || e.ctrlKey)}
            icon={<Icon size={13} />}
            label={
              <span title={coll.viewOn ? `View on ${coll.viewOn}` : undefined}>
                {coll.name}
                {coll.capped && <span className="ml-1 text-[10px] text-muted-foreground">capped</span>}
              </span>
            }
            right={formatCount(coll.count)}
          />
        </div>
      </ContextMenu>
      <ConfirmDialog
        open={dropping}
        onOpenChange={setDropping}
        title={coll.type === 'view' ? 'Drop view' : 'Drop collection'}
        body={
          <>
            This permanently deletes <b>{ns}</b>
            {coll.type !== 'view' && coll.count !== null
              ? ` and its ${coll.count.toLocaleString()} documents`
              : ''}
            .
          </>
        }
        typeToConfirm={coll.name}
        confirmLabel="Drop"
        onConfirm={async () => {
          await ipc('db:dropCollection', { connectionId: connId, db, name: coll.name })
          for (const t of tabs) if (t.connectionId === connId && t.ns === ns) closeTab(t.id)
          await qc.invalidateQueries({ queryKey: keys.collections(connId, db) })
        }}
      />
    </>
  )
}
