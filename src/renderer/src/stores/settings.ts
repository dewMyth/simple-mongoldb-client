/** App settings in the renderer, kept in sync with main (settings:changed). */
import { create } from 'zustand'
import { defaultSettings, type Settings } from '@shared/settings'
import { ipc } from '../lib/ipc'

interface SettingsState {
  settings: Settings
  loaded: boolean
  init: () => Promise<Settings>
  update: (patch: Partial<Settings>) => Promise<void>
}

let started = false

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: defaultSettings,
  loaded: false,
  async init() {
    const settings = await ipc('settings:get')
    set({ settings, loaded: true })
    if (!started) {
      started = true
      window.api.on('settings:changed', (s) => set({ settings: s }))
    }
    applyFontSize(settings.fontSize)
    useSettingsStore.subscribe((s, prev) => {
      if (s.settings.fontSize !== prev.settings.fontSize) applyFontSize(s.settings.fontSize)
    })
    return settings
  },
  async update(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    set({ settings: await ipc('settings:update', patch) })
  }
}))

/** Document views size their monospace text from this CSS variable. */
function applyFontSize(px: number) {
  document.documentElement.style.setProperty('--mono-size', `${px}px`)
}

/** Current settings outside React (stores, Monaco options). */
export const currentSettings = () => useSettingsStore.getState().settings
