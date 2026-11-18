/**
 * Create index: keys and every option (unique, sparse, hidden, TTL, partial filter with query
 * autocomplete, collation, wildcard projection). Shows build progress while the server works.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { emptyCreateIndexForm, type CreateIndexForm, type IndexBuild } from '@shared/indexes'
import type { Tab } from '../../stores/tabs'
import { ipc } from '../../lib/ipc'
import { Dialog } from '../../components/Dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/spinner'
import { CheckboxField, ErrorBox, Field } from '../../components/form'
import { CodeEditor } from '../../components/CodeEditor'
import { indexKeys } from './keys'

export function CreateIndexDialog({
  tab,
  building,
  initial,
  onClose,
  onCreated
}: {
  tab: Tab
  building: IndexBuild[]
  initial?: Partial<CreateIndexForm>
  onClose: () => void
  onCreated?: (name: string) => void
}) {
  const qc = useQueryClient()
  const ns = tab.ns!
  const [form, setForm] = useState<CreateIndexForm>({ ...emptyCreateIndexForm, ...initial })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<CreateIndexForm>) => setForm((f) => ({ ...f, ...patch }))
  const wildcard = form.keys.includes('$**')
  const build = building[0]

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const name = await ipc('indexes:create', { connectionId: tab.connectionId, ns, form })
      await qc.invalidateQueries({ queryKey: indexKeys.list(tab.connectionId, ns) })
      onCreated?.(name)
      onClose()
    } catch (e) {
      const err = e as Error
      if (err.name !== 'CancelledError') setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create index"
      description={`On ${ns}. The build runs in the background; you can close this dialog.`}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {busy ? 'Close (keeps building)' : 'Cancel'}
          </Button>
          <Button
            onClick={() => void create()}
            disabled={busy || !form.keys.trim()}
            data-testid="create-index-submit"
          >
            {busy && <Spinner className="size-3" />} {busy ? 'Building…' : 'Create index'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Keys" editor>
          <CodeEditor
            value={form.keys}
            onChange={(keys) => set({ keys })}
            minLines={2}
            maxHeight={160}
            completion={{ mode: 'sort', connectionId: tab.connectionId, ns }}
            onSubmit={() => void create()}
            testId="index-keys"
          />
          <span className="text-[11px] text-muted-foreground">
            1 ascending, -1 descending, or "text", "2dsphere", "2d", "hashed". Use "$**" for a wildcard index.
          </span>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name (optional)">
            <Input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Generated from the keys"
            />
          </Field>
          <Field label="TTL in seconds (optional)">
            <Input
              value={form.ttlSeconds}
              inputMode="numeric"
              onChange={(e) => set({ ttlSeconds: e.target.value })}
              placeholder="Delete documents after…"
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-5">
          <CheckboxField checked={form.unique} onChange={(unique) => set({ unique })} label="Unique" />
          <CheckboxField checked={form.sparse} onChange={(sparse) => set({ sparse })} label="Sparse" />
          <CheckboxField
            checked={form.hidden}
            onChange={(hidden) => set({ hidden })}
            label="Hidden (not used by queries)"
          />
        </div>
        <Field label="Partial filter (optional): only index documents matching" editor>
          <CodeEditor
            value={form.partialFilter}
            onChange={(partialFilter) => set({ partialFilter })}
            minLines={2}
            maxHeight={160}
            autoFocus={false}
            completion={{ mode: 'filter', connectionId: tab.connectionId, ns }}
            testId="index-partial"
          />
        </Field>
        <Field label="Collation (optional)">
          <Input
            className="font-mono text-xs"
            value={form.collation}
            onChange={(e) => set({ collation: e.target.value })}
            placeholder="{ locale: 'en', strength: 2 }"
          />
        </Field>
        {wildcard && (
          <Field label="Wildcard projection (optional)">
            <Input
              className="font-mono text-xs"
              value={form.wildcardProjection}
              onChange={(e) => set({ wildcardProjection: e.target.value })}
              placeholder="{ secret: 0 }"
            />
          </Field>
        )}
        {busy && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="create-index-progress"
          >
            <Spinner className="size-3" />
            {build?.total
              ? `${build.message}: ${Math.round(((build.done ?? 0) / build.total) * 100)}%`
              : 'Building the index…'}
          </div>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    </Dialog>
  )
}
