import { Monitor, Moon, Sun } from 'lucide-react'
import type { Theme } from '@shared/settings'
import { useThemeStore } from '../stores/theme'
import { IconButton } from '../components/IconButton'

const order: Theme[] = ['system', 'light', 'dark']
const icons = { system: Monitor, light: Sun, dark: Moon }

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const Icon = icons[theme]
  const next = order[(order.indexOf(theme) + 1) % order.length]!
  return (
    <IconButton
      label={`Theme: ${theme} (switch to ${next})`}
      data-testid="theme-toggle"
      onClick={() => void setTheme(next)}
    >
      <Icon size={15} />
    </IconButton>
  )
}
