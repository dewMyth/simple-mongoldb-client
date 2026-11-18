import Store from 'electron-store'
import type { Settings, Theme } from '@shared/ipc-contract'

const store = new Store<Settings>({
  name: 'settings',
  defaults: { theme: 'system' }
})

export const settingsStore = {
  get(): Settings {
    return { theme: store.get('theme') }
  },
  setTheme(theme: Theme): Settings {
    store.set('theme', theme)
    return this.get()
  }
}
