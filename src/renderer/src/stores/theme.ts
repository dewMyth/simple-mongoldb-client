import { create } from 'zustand'
import type { Theme } from '@shared/ipc-contract'
import { ipc } from '../lib/ipc'

interface ThemeState {
  theme: Theme
  resolved: 'light' | 'dark'
  init: () => Promise<void>
  setTheme: (theme: Theme) => Promise<void>
}

const media = window.matchMedia('(prefers-color-scheme: dark)')
const resolve = (theme: Theme): 'light' | 'dark' =>
  theme === 'system' ? (media.matches ? 'dark' : 'light') : theme

function apply(resolved: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'system',
  resolved: resolve('system'),
  async init() {
    const { theme } = await ipc('settings:get')
    const resolved = resolve(theme)
    apply(resolved)
    set({ theme, resolved })
    media.addEventListener('change', () => {
      const r = resolve(get().theme)
      apply(r)
      set({ resolved: r })
    })
  },
  async setTheme(theme) {
    const resolved = resolve(theme)
    apply(resolved)
    set({ theme, resolved })
    await ipc('settings:setTheme', theme)
  }
}))
