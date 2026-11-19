import Store from 'electron-store'
import { normalizeSettings, type Settings, type Theme } from '@shared/settings'

const store = new Store<{ settings: unknown; theme?: Theme }>({ name: 'settings' })

/** Settings, merged with defaults (older files only stored `theme`). */
export const settingsStore = {
  get(): Settings {
    const stored = store.get('settings') ?? (store.get('theme') ? { theme: store.get('theme') } : {})
    return normalizeSettings(stored)
  },
  update(patch: Partial<Settings>): Settings {
    const next = normalizeSettings({ ...this.get(), ...patch })
    store.set('settings', next)
    return next
  },
  setTheme(theme: Theme): Settings {
    return this.update({ theme })
  }
}
