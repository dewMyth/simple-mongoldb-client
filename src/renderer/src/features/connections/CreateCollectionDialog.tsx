import { useState } from 'react'
import { validateCollectionName, validateDatabaseName } from '@shared/connection'
import { Dialog } from '../../components/Dialog'
import { Button, Checkbox, ErrorBox, Field, Input, Select, Spinner } from '../../components/ui'
import { ipc } from '../../lib/ipc'

/** Creates a collection; when `db` is not given it creates a database (with its first collection). */
export function CreateCollectionDialog({
  open,
  onOpenChange,
  connectionId,
  db,
  onCreated
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  connectionId: string
  db?: string
  onCreated: (db: string, name: string) => void
}) {
  const [dbName, setDbName] = useState(db ?? '')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'normal' | 'capped' | 'timeseries' | 'clustered'>('normal')
  const [cappedSize, setCappedSize] = useState(1_048_576)
  const [cappedMax, setCappedMax] = useState<number | ''>('')
  const [timeField, setTimeField] = useState('timestamp')
  const [metaField, setMetaField] = useState('')
  const [granularity, setGranularity] = useState<'seconds' | 'minutes' | 'hours'>('seconds')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dbErr = validateDatabaseName(dbName)
  const nameErr = validateCollectionName(name)
  const invalid = !!dbErr || !!nameErr || (kind === 'timeseries' && !timeField)

  const submit = async () => {
    setTouched(true)
    if (invalid) return
    setBusy(true)
    setError(null)
    try {
      await ipc('db:createCollection', {
        connectionId,
        db: dbName,
        name,
        capped: kind === 'capped' ? { size: cappedSize, max: cappedMax || undefined } : undefined,
        timeseries:
          kind === 'timeseries' ? { timeField, metaField: metaField || undefined, granularity } : undefined,
        clusteredIndex: kind === 'clustered' || undefined
      })
      onCreated(dbName, name)
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="sm"
      title={db ? `Create collection in ${db}` : 'Create database'}
      description={db ? undefined : 'MongoDB creates a database together with its first collection.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || (touched && invalid)}
            data-testid="create-collection-submit"
          >
            {busy ? <Spinner /> : null} Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {!db && (
          <Field label="Database name" error={touched ? dbErr : null}>
            <Input
              autoFocus
              value={dbName}
              onChange={(e) => setDbName(e.target.value)}
              data-testid="create-db-name"
            />
          </Field>
        )}
        <Field label="Collection name" error={touched ? nameErr : null}>
          <Input
            autoFocus={!!db}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="create-collection-name"
          />
        </Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="normal">Standard</option>
            <option value="capped">Capped</option>
            <option value="timeseries">Time series</option>
            <option value="clustered">Clustered (by _id)</option>
          </Select>
        </Field>
        {kind === 'capped' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max size (bytes)">
              <Input
                type="number"
                min={1}
                value={cappedSize}
                onChange={(e) => setCappedSize(Number(e.target.value))}
              />
            </Field>
            <Field label="Max documents" hint="Optional">
              <Input
                type="number"
                min={1}
                value={cappedMax}
                onChange={(e) => setCappedMax(e.target.value ? Number(e.target.value) : '')}
              />
            </Field>
          </div>
        )}
        {kind === 'timeseries' && (
          <>
            <Field label="Time field">
              <Input value={timeField} onChange={(e) => setTimeField(e.target.value)} />
            </Field>
            <Field label="Meta field" hint="Optional">
              <Input value={metaField} onChange={(e) => setMetaField(e.target.value)} />
            </Field>
            <Field label="Granularity">
              <Select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as typeof granularity)}
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </Select>
            </Field>
          </>
        )}
        {kind === 'clustered' && (
          <Checkbox checked disabled onChange={() => {}} label="Clustered index on _id (unique)" />
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
