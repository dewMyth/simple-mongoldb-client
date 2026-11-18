import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FolderOpen } from 'lucide-react'
import {
  connectionColors,
  type ConnectionColor,
  type ConnectionDraft,
  type SavedConnection,
  type ServerInfo,
  type SshConfig
} from '@shared/connection'
import {
  DEFAULT_URI,
  fieldsToUri,
  uriToFields,
  validateUri,
  type ConnectionFields
} from '@shared/connection-fields'
import { cn } from '@renderer/lib/utils'
import { Dialog } from '../../components/Dialog'
import { CheckboxField, ErrorBox, Field, SimpleSelect, Spinner, StatusBadge } from '../../components/form'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { Textarea } from '../../components/ui/textarea'
import { ipc } from '../../lib/ipc'
import { colorHex } from './colors'
import { useConnect, useSaveConnection } from './queries'

type Mode = 'uri' | 'fields'
type Section = 'general' | 'auth' | 'tls' | 'ssh' | 'advanced'

interface DraftState {
  id?: string
  name: string
  color: ConnectionColor
  folder: string
  uri: string
  keepPassword: boolean
  ssh: SshConfig | null
  sshPassword: string
  sshPassphrase: string
  tlsKeyPassword: string
  readOnly: boolean
  production: boolean
  serverSelectionTimeoutMS: number
}

function initialDraft(existing?: SavedConnection | null, duplicate?: boolean): DraftState {
  return {
    id: duplicate ? undefined : existing?.id,
    name: existing ? `${existing.name}${duplicate ? ' (copy)' : ''}` : '',
    color: existing?.color ?? 'none',
    folder: existing?.folder ?? '',
    uri: existing?.uri ?? DEFAULT_URI,
    // Duplicates can't reuse another record's secrets.
    keepPassword: !!existing?.hasPassword && !duplicate,
    ssh: existing?.ssh ?? null,
    sshPassword: '',
    sshPassphrase: '',
    tlsKeyPassword: '',
    readOnly: existing?.readOnly ?? false,
    production: existing?.production ?? false,
    serverSelectionTimeoutMS: existing?.serverSelectionTimeoutMS ?? 10_000
  }
}

function toDraft(s: DraftState): ConnectionDraft {
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    folder: s.folder,
    uri: s.uri.trim(),
    keepPassword: s.keepPassword,
    ssh: s.ssh,
    secrets: {
      sshPassword: s.sshPassword || undefined,
      sshPassphrase: s.sshPassphrase || undefined,
      tlsCertificateKeyFilePassword: s.tlsKeyPassword || undefined
    },
    readOnly: s.readOnly,
    production: s.production,
    serverSelectionTimeoutMS: s.serverSelectionTimeoutMS
  }
}

const topologyLabel: Record<ServerInfo['topology'], string> = {
  standalone: 'Standalone',
  replicaSet: 'Replica set',
  sharded: 'Sharded cluster',
  loadBalanced: 'Load balanced',
  unknown: 'Unknown'
}

const sections: [Section, string][] = [
  ['general', 'General'],
  ['auth', 'Authentication'],
  ['tls', 'TLS / SSL'],
  ['ssh', 'SSH tunnel'],
  ['advanced', 'Advanced']
]

export function ConnectionDialog({
  open,
  onOpenChange,
  existing,
  duplicate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing?: SavedConnection | null
  duplicate?: boolean
}) {
  const [state, setState] = useState<DraftState>(() => initialDraft(existing, duplicate))
  const [mode, setMode] = useState<Mode>('uri')
  const [section, setSection] = useState<Section>('general')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ServerInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const save = useSaveConnection()
  const connect = useConnect()

  const uriError = validateUri(state.uri)
  const fields = useMemo<ConnectionFields | null>(() => {
    try {
      return uriToFields(state.uri)
    } catch {
      return null
    }
  }, [state.uri])
  const savedPasswordInUse = state.keepPassword && !!fields?.username && !fields.password
  const insecureTls = fields?.tlsAllowInvalidCertificates || fields?.tlsAllowInvalidHostnames

  const patch = (p: Partial<DraftState>) => {
    setState((s) => ({ ...s, ...p }))
    setTestResult(null)
  }
  const setField = <K extends keyof ConnectionFields>(key: K, value: ConnectionFields[K]) => {
    if (!fields) return
    patch({ uri: fieldsToUri({ ...fields, [key]: value }, state.uri) })
  }

  const pickFile = async (title: string, onPick: (p: string) => void) => {
    const path = await ipc('dialog:openFile', {
      title,
      filters: [
        { name: 'Certificates and keys', extensions: ['pem', 'crt', 'cer', 'key', 'p12', 'pfx'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (path) onPick(path)
  }

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onTest = () =>
    run(async () => {
      setTesting(true)
      setTestResult(null)
      try {
        setTestResult(await ipc('connections:test', toDraft(state)))
      } finally {
        setTesting(false)
      }
    })

  const onSave = (andConnect: boolean) =>
    run(async () => {
      const saved = await save.mutateAsync(toDraft(state))
      if (andConnect) await connect.mutateAsync(saved.id)
      onOpenChange(false)
    })

  const busy = save.isPending || connect.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={state.id ? 'Edit connection' : 'New connection'}
      footer={
        <>
          <Button
            variant="outline"
            onClick={onTest}
            disabled={!!uriError || testing || busy}
            data-testid="test-connection"
            className="mr-auto"
          >
            {testing ? <Spinner /> : null} Test connection
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => onSave(false)}
            disabled={!!uriError || busy}
            data-testid="save-connection"
          >
            Save
          </Button>
          <Button onClick={() => onSave(true)} disabled={!!uriError || busy} data-testid="save-connect">
            {busy ? <Spinner /> : null} Save &amp; connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-3">
          <Field label="Name">
            <Input
              value={state.name}
              placeholder={fields?.hosts[0] ?? 'My cluster'}
              onChange={(e) => patch({ name: e.target.value })}
              data-testid="conn-name"
            />
          </Field>
          <Field label="Folder">
            <Input
              value={state.folder}
              placeholder="(none)"
              onChange={(e) => patch({ folder: e.target.value })}
            />
          </Field>
          <Field label="Colour">
            <div className="flex h-8 items-center gap-1.5">
              {connectionColors.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  onClick={() => patch({ color: c })}
                  className={cn(
                    'size-5 rounded-full border',
                    state.color === c && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                    c === 'none' ? 'border-dashed border-muted-foreground' : 'border-transparent'
                  )}
                  style={{ background: colorHex[c] ?? 'transparent' }}
                />
              ))}
            </div>
          </Field>
        </div>

        <Tabs value={fields ? mode : 'uri'} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="uri">Connection string</TabsTrigger>
            <TabsTrigger value="fields" disabled={!fields}>
              Fields
            </TabsTrigger>
          </TabsList>

          <TabsContent value="uri" className="pt-2">
            <Field
              label="Connection string"
              error={uriError}
              hint={
                savedPasswordInUse
                  ? 'The saved password will be used. Type a new one in the string to replace it.'
                  : undefined
              }
            >
              <Textarea
                value={state.uri}
                spellCheck={false}
                rows={3}
                data-testid="conn-uri"
                aria-invalid={!!uriError}
                onChange={(e) => patch({ uri: e.target.value })}
                className="selectable min-h-0 resize-none font-mono text-xs"
              />
            </Field>
          </TabsContent>

          {fields && (
            <TabsContent value="fields" className="pt-2">
              <Tabs
                value={section}
                onValueChange={(v) => setSection(v as Section)}
                orientation="vertical"
                className="flex-row gap-4"
              >
                <TabsList className="h-fit w-36 shrink-0 flex-col items-stretch bg-transparent p-0">
                  {sections.map(([k, label]) => (
                    <TabsTrigger
                      key={k}
                      value={k}
                      className="justify-start px-2.5 py-1.5 text-xs data-[state=active]:bg-accent data-[state=active]:shadow-none"
                    >
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                <div className="min-w-0 flex-1">
                  <TabsContent value="general" className="flex flex-col gap-3">
                    <Field label="Scheme">
                      <SimpleSelect
                        value={fields.scheme}
                        onValueChange={(v) => setField('scheme', v)}
                        options={[
                          { value: 'mongodb', label: 'mongodb://' },
                          { value: 'mongodb+srv', label: 'mongodb+srv:// (DNS seed list, e.g. Atlas)' }
                        ]}
                      />
                    </Field>
                    <Field
                      label={fields.scheme === 'mongodb+srv' ? 'Host' : 'Hosts'}
                      hint={
                        fields.scheme === 'mongodb'
                          ? 'host:port, comma-separated for replica sets'
                          : undefined
                      }
                    >
                      <Input
                        value={fields.hosts.join(',')}
                        onChange={(e) => setField('hosts', e.target.value.split(','))}
                        placeholder="localhost:27017"
                      />
                    </Field>
                    {fields.scheme === 'mongodb' && (
                      <CheckboxField
                        checked={fields.directConnection}
                        onChange={(v) => setField('directConnection', v)}
                        label="Direct connection (connect to this host only, don't discover the replica set)"
                      />
                    )}
                    <Field label="Default database" hint="Optional">
                      <Input
                        value={fields.defaultDatabase}
                        onChange={(e) => setField('defaultDatabase', e.target.value)}
                      />
                    </Field>
                  </TabsContent>

                  <TabsContent value="auth" className="flex flex-col gap-3">
                    <Field label="Method">
                      <SimpleSelect
                        value={fields.authMechanism}
                        onValueChange={(v) => setField('authMechanism', v)}
                        options={[
                          { value: 'none', label: 'None' },
                          { value: 'DEFAULT', label: 'Username / password (default SCRAM)' },
                          { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
                          { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' },
                          { value: 'MONGODB-X509', label: 'X.509 certificate' }
                        ]}
                      />
                    </Field>
                    {fields.authMechanism !== 'none' && (
                      <>
                        <Field
                          label="Username"
                          hint={
                            fields.authMechanism === 'MONGODB-X509'
                              ? 'Optional: the certificate subject'
                              : undefined
                          }
                        >
                          <Input
                            value={fields.username}
                            onChange={(e) => setField('username', e.target.value)}
                          />
                        </Field>
                        {fields.authMechanism !== 'MONGODB-X509' && (
                          <Field
                            label="Password"
                            hint={
                              savedPasswordInUse ? (
                                <span>
                                  A password is saved.{' '}
                                  <button
                                    type="button"
                                    className="text-primary underline"
                                    onClick={() => patch({ keepPassword: false })}
                                  >
                                    Clear it
                                  </button>
                                </span>
                              ) : undefined
                            }
                          >
                            <Input
                              type="password"
                              value={fields.password}
                              placeholder={savedPasswordInUse ? '•••••••• (saved)' : ''}
                              onChange={(e) => setField('password', e.target.value)}
                            />
                          </Field>
                        )}
                        <Field label="Authentication database (authSource)" hint="Usually admin">
                          <Input
                            value={fields.authSource}
                            placeholder="admin"
                            onChange={(e) => setField('authSource', e.target.value)}
                          />
                        </Field>
                        {fields.authMechanism === 'MONGODB-X509' && fields.tls === 'off' && (
                          <ErrorBox>X.509 authentication requires TLS. Turn TLS on.</ErrorBox>
                        )}
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="tls" className="flex flex-col gap-3">
                    <Field label="TLS/SSL">
                      <SimpleSelect
                        value={fields.tls}
                        onValueChange={(v) => setField('tls', v)}
                        options={[
                          { value: 'default', label: 'Default (on for mongodb+srv, off otherwise)' },
                          { value: 'on', label: 'On' },
                          { value: 'off', label: 'Off' }
                        ]}
                      />
                    </Field>
                    {fields.tls !== 'off' && (
                      <>
                        <FileField
                          label="Certificate authority (CA) file"
                          value={fields.tlsCAFile}
                          onChange={(v) => setField('tlsCAFile', v)}
                          onBrowse={() => pickFile('Choose CA file', (p) => setField('tlsCAFile', p))}
                        />
                        <FileField
                          label="Client certificate and key (PEM)"
                          hint="Required for X.509 authentication"
                          value={fields.tlsCertificateKeyFile}
                          onChange={(v) => setField('tlsCertificateKeyFile', v)}
                          onBrowse={() =>
                            pickFile('Choose client certificate', (p) => setField('tlsCertificateKeyFile', p))
                          }
                        />
                        {fields.tlsCertificateKeyFile && (
                          <Field
                            label="Client key password"
                            hint={
                              existing?.hasSecrets.tlsCertificateKeyFilePassword
                                ? 'Saved. Type to replace.'
                                : 'Only if the key is encrypted'
                            }
                          >
                            <Input
                              type="password"
                              value={state.tlsKeyPassword}
                              onChange={(e) => patch({ tlsKeyPassword: e.target.value })}
                            />
                          </Field>
                        )}
                        <CheckboxField
                          checked={fields.tlsAllowInvalidCertificates}
                          onChange={(v) => setField('tlsAllowInvalidCertificates', v)}
                          label="Allow invalid certificates (insecure)"
                        />
                        <CheckboxField
                          checked={fields.tlsAllowInvalidHostnames}
                          onChange={(v) => setField('tlsAllowInvalidHostnames', v)}
                          label="Allow invalid host names (insecure)"
                        />
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="ssh" className="flex flex-col gap-3">
                    <SshSection
                      state={state}
                      patch={patch}
                      existing={existing}
                      pickFile={pickFile}
                      isSrv={fields.scheme === 'mongodb+srv'}
                    />
                  </TabsContent>

                  <TabsContent value="advanced" className="flex flex-col gap-3">
                    <Field label="Replica set name">
                      <Input
                        value={fields.replicaSet}
                        onChange={(e) => setField('replicaSet', e.target.value)}
                      />
                    </Field>
                    <Field label="Read preference">
                      <SimpleSelect
                        value={fields.readPreference}
                        onValueChange={(v) => setField('readPreference', v)}
                        options={[
                          { value: '', label: 'Default (primary)' },
                          { value: 'primary', label: 'primary' },
                          { value: 'primaryPreferred', label: 'primaryPreferred' },
                          { value: 'secondary', label: 'secondary' },
                          { value: 'secondaryPreferred', label: 'secondaryPreferred' },
                          { value: 'nearest', label: 'nearest' }
                        ]}
                      />
                    </Field>
                    <Field label="App name" hint="Shown in server logs and currentOp">
                      <Input
                        value={fields.appName}
                        placeholder="Mongo Studio"
                        onChange={(e) => setField('appName', e.target.value)}
                      />
                    </Field>
                  </TabsContent>
                </div>
              </Tabs>
            </TabsContent>
          )}
        </Tabs>

        <div className="grid grid-cols-2 gap-3 border-t pt-3">
          <Field label="Server selection timeout (ms)" hint="How long to wait for a reachable server">
            <Input
              type="number"
              min={500}
              max={120000}
              step={500}
              value={state.serverSelectionTimeoutMS}
              onChange={(e) => patch({ serverSelectionTimeoutMS: Number(e.target.value) || 10_000 })}
            />
          </Field>
          <div className="flex flex-col justify-center gap-2.5">
            <CheckboxField
              checked={state.readOnly}
              onChange={(v) => patch({ readOnly: v })}
              label="Read-only (block all writes)"
            />
            <CheckboxField
              checked={state.production}
              onChange={(v) => patch({ production: v })}
              label="Production (confirm every write)"
            />
          </div>
        </div>

        {insecureTls && (
          <div className="flex items-center gap-2 text-xs text-warn">
            <AlertTriangle size={14} />
            <StatusBadge tone="warn">Insecure TLS</StatusBadge>
            Certificate validation is disabled. Only use this for development.
          </div>
        )}

        {testResult && (
          <div
            className="flex items-start gap-3 rounded-md border border-ok/40 bg-ok/10 px-3 py-2.5 text-xs"
            data-testid="test-result"
          >
            <CheckCircle2 size={16} className="mt-0.5 text-ok" />
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              <span className="text-muted-foreground">Server</span>
              <span>
                MongoDB {testResult.version}
                {testResult.isEnterprise ? ' Enterprise' : ''}
              </span>
              <span className="text-muted-foreground">Topology</span>
              <span>
                {testResult.isAtlas ? 'Atlas · ' : ''}
                {topologyLabel[testResult.topology]}
                {testResult.replicaSetName ? ` (${testResult.replicaSetName})` : ''}
              </span>
              <span className="text-muted-foreground">Latency</span>
              <span>{testResult.latencyMs} ms</span>
            </div>
          </div>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    </Dialog>
  )
}

function FileField({
  label,
  hint,
  value,
  onChange,
  onBrowse
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  onBrowse: () => void
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="/path/to/file.pem" />
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onBrowse}
          aria-label={`Browse for ${label}`}
        >
          <FolderOpen />
        </Button>
      </div>
    </Field>
  )
}

function SshSection({
  state,
  patch,
  existing,
  pickFile,
  isSrv
}: {
  state: DraftState
  patch: (p: Partial<DraftState>) => void
  existing?: SavedConnection | null
  pickFile: (title: string, onPick: (p: string) => void) => Promise<void>
  isSrv: boolean
}) {
  const ssh = state.ssh
  const setSsh = (p: Partial<SshConfig>) =>
    patch({ ssh: { host: '', port: 22, username: '', authMethod: 'password', ...ssh, ...p } })
  return (
    <>
      <Field label="SSH tunnel">
        <SimpleSelect
          value={ssh ? ssh.authMethod : 'none'}
          onValueChange={(v) => {
            if (v === 'none') patch({ ssh: null })
            else setSsh({ authMethod: v })
          }}
          options={[
            { value: 'none', label: 'None' },
            { value: 'password', label: 'Password' },
            { value: 'privateKey', label: 'Private key' }
          ]}
        />
      </Field>
      {ssh && (
        <>
          {isSrv && (
            <ErrorBox>
              SSH tunnels need a mongodb:// connection string with one host. mongodb+srv:// won't work.
            </ErrorBox>
          )}
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="SSH host">
              <Input
                value={ssh.host}
                onChange={(e) => setSsh({ host: e.target.value })}
                placeholder="bastion.example.com"
              />
            </Field>
            <Field label="Port">
              <Input
                type="number"
                value={ssh.port}
                onChange={(e) => setSsh({ port: Number(e.target.value) || 22 })}
              />
            </Field>
          </div>
          <Field label="SSH username">
            <Input value={ssh.username} onChange={(e) => setSsh({ username: e.target.value })} />
          </Field>
          {ssh.authMethod === 'password' ? (
            <Field
              label="SSH password"
              hint={existing?.hasSecrets.sshPassword ? 'Saved. Type to replace.' : undefined}
            >
              <Input
                type="password"
                value={state.sshPassword}
                onChange={(e) => patch({ sshPassword: e.target.value })}
              />
            </Field>
          ) : (
            <>
              <FileField
                label="Private key file"
                value={ssh.privateKeyFile ?? ''}
                onChange={(v) => setSsh({ privateKeyFile: v })}
                onBrowse={() => pickFile('Choose SSH private key', (p) => setSsh({ privateKeyFile: p }))}
              />
              <Field
                label="Key passphrase"
                hint={
                  existing?.hasSecrets.sshPassphrase
                    ? 'Saved. Type to replace.'
                    : 'Only if the key is encrypted'
                }
              >
                <Input
                  type="password"
                  value={state.sshPassphrase}
                  onChange={(e) => patch({ sshPassphrase: e.target.value })}
                />
              </Field>
            </>
          )}
        </>
      )}
    </>
  )
}
