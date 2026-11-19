/**
 * Settings: appearance, query defaults, sampling, keyboard shortcuts and diagnostics.
 * Changes apply immediately (and to every window) and are saved in main.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ClipboardCopy, FolderOpen } from 'lucide-react'
import type { Settings, Theme } from '@shared/settings'
import type { ViewMode } from '@shared/workspace'
import { Dialog } from '../components/Dialog'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { SimpleSelect } from '../components/form'
import { ipc } from '../lib/ipc'
import { appInfo } from '../lib/app-info'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore } from '../stores/theme'
import { SHORTCUTS } from './shortcut-list'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[12rem_minmax(0,1fr)] items-center gap-4 py-1.5">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

/** A number field that saves valid values on blur/Enter. */
function NumberSetting({
  value,
  min,
  max,
  onSave,
  testId,
  suffix
}: {
  value: number
  min: number
  max: number
  onSave: (n: number) => void
  testId: string
  suffix?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const n = Number(text)
  const valid = text === null || (Number.isInteger(n) && n >= min && n <= max)
  const commit = () => {
    if (text !== null && valid) onSave(n)
    setText(null)
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        className="h-8 w-32 font-mono"
        inputMode="numeric"
        value={text ?? String(value)}
        aria-invalid={!valid}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        data-testid={testId}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      {!valid && (
        <span className="text-xs text-destructive">
          {min.toLocaleString()}–{max.toLocaleString()}
        </span>
      )}
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const setTheme = useThemeStore((s) => s.setTheme)
  const { data: info } = useQuery({ queryKey: ['app-info'], queryFn: appInfo })
  const [copied, setCopied] = useState(false)
  const save = (patch: Partial<Settings>) => void update(patch)

  const copyDiagnostics = () => {
    if (!info) return
    const text = [
      `${info.name} ${info.version}`,
      `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
      `Platform ${info.platform}`
    ].join('\n')
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Settings" width="lg">
      <div className="flex flex-col gap-5" data-testid="settings">
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Appearance
          </h3>
          <Row label="Theme">
            <SimpleSelect<Theme>
              value={settings.theme}
              onValueChange={(t) => void setTheme(t)}
              options={[
                { value: 'system', label: 'Match the system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' }
              ]}
              className="w-48"
              ariaLabel="Theme"
            />
          </Row>
          <Row label="Font size" hint="Editors, the shell and document views">
            <NumberSetting
              value={settings.fontSize}
              min={10}
              max={20}
              onSave={(fontSize) => save({ fontSize })}
              suffix="px"
              testId="setting-font-size"
            />
          </Row>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Queries
          </h3>
          <Row label="Default view" hint="For new documents tabs">
            <SimpleSelect<ViewMode>
              value={settings.defaultViewMode}
              onValueChange={(defaultViewMode) => save({ defaultViewMode })}
              options={[
                { value: 'tree', label: 'Tree' },
                { value: 'json', label: 'JSON' },
                { value: 'table', label: 'Table' }
              ]}
              className="w-48"
              ariaLabel="Default view"
            />
          </Row>
          <Row label="Default maxTimeMS" hint="When the query bar leaves it empty; 0 = no limit">
            <NumberSetting
              value={settings.defaultMaxTimeMS}
              min={0}
              max={86_400_000}
              onSave={(defaultMaxTimeMS) => save({ defaultMaxTimeMS })}
              suffix="ms"
              testId="setting-max-time"
            />
          </Row>
          <Row label="Page size" hint="Fixed at 25 documents per page">
            <span className="text-sm text-muted-foreground">25</span>
          </Row>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Sampling
          </h3>
          <Row
            label="Sample size"
            hint="Documents sampled for the Schema tab and autocomplete (autocomplete uses at most 10,000)"
          >
            <NumberSetting
              value={settings.sampleSize}
              min={10}
              max={100_000}
              onSave={(sampleSize) => save({ sampleSize })}
              suffix="documents"
              testId="setting-sample-size"
            />
          </Row>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Keyboard shortcuts
          </h3>
          <table className="w-full text-sm" data-testid="shortcuts">
            <tbody>
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={keys} className="border-b last:border-0">
                  <td className="w-48 py-1 pr-4">
                    <kbd className="rounded border bg-panel-2 px-1.5 py-0.5 font-mono text-[11px]">
                      {keys}
                    </kbd>
                  </td>
                  <td className="py-1 text-muted-foreground">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            About and diagnostics
          </h3>
          <div className="text-sm text-muted-foreground">
            {info ? `${info.name} ${info.version} · Electron ${info.electron} · ${info.platform}` : '…'}
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void ipc('app:openLogs')}>
              <FolderOpen /> Open logs folder
            </Button>
            <Button size="sm" variant="outline" onClick={copyDiagnostics}>
              {copied ? <Check /> : <ClipboardCopy />} {copied ? 'Copied' : 'Copy version info'}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Logs never contain documents, queries or credentials; connection strings are redacted.
          </p>
        </section>
      </div>
    </Dialog>
  )
}
