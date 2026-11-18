/**
 * Workspace keyboard shortcuts. Listens in the capture phase so they also work while a Monaco
 * editor has focus (Monaco's own Cmd+K chords are given up for the palette).
 *
 *   Cmd/Ctrl+K            command palette
 *   Cmd/Ctrl+Shift+T      reopen closed tab
 *   Ctrl+Tab / +Shift     next / previous tab
 *   Cmd/Ctrl+1…9          go to tab 1…8, 9 = last tab
 */
import { useEffect } from 'react'
import { useTabsStore } from '../stores/tabs'
import { usePaletteStore } from '../stores/palette'

export function useWorkspaceShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const tabs = useTabsStore.getState()
      let handled = true
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        const p = usePaletteStore.getState()
        p.setOpen(!p.open)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        tabs.reopenClosed()
      } else if (e.ctrlKey && e.key === 'Tab') {
        tabs.cycle(e.shiftKey ? -1 : 1)
      } else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key)
        const target = n === 9 ? tabs.tabs.at(-1) : tabs.tabs[n - 1]
        if (target) tabs.activate(target.id)
        else handled = false
      } else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
