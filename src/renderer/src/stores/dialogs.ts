/** App-level dialogs that can be opened from anywhere (documents tab, sidebar, palette). */
import { create } from 'zustand'
import type { QueryText } from '@shared/query'

export type AppDialog =
  | { kind: 'export'; connectionId: string; ns: string; query: QueryText | null }
  | { kind: 'import'; connectionId: string; ns: string }
  | { kind: 'settings' }

export const useDialogStore = create<{
  dialog: AppDialog | null
  open: (d: AppDialog) => void
  close: () => void
}>((set) => ({
  dialog: null,
  // Deferred: opening from a menu item while it closes can lose keyboard focus.
  open: (dialog) => setTimeout(() => set({ dialog })),
  close: () => set({ dialog: null })
}))
