/** App settings (persisted in main, validated on the way in). */
import { z } from 'zod'
import { viewModes } from './workspace'

export const themeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof themeSchema>

export const settingsSchema = z.object({
  theme: themeSchema,
  /** How new documents tabs show results. */
  defaultViewMode: z.enum(viewModes),
  /** maxTimeMS for finds when the query bar leaves it empty (0 = no limit). */
  defaultMaxTimeMS: z.number().int().min(0).max(86_400_000),
  /** Documents sampled for the Schema tab and autocomplete. */
  sampleSize: z.number().int().min(10).max(100_000),
  /** Font size of editors, the shell and document views. */
  fontSize: z.number().int().min(10).max(20)
})
export type Settings = z.infer<typeof settingsSchema>

export const defaultSettings: Settings = {
  theme: 'system',
  defaultViewMode: 'tree',
  defaultMaxTimeMS: 60_000,
  sampleSize: 1000,
  fontSize: 12
}

/** Merges stored values with defaults, dropping anything invalid (hand-edited or older files). */
export function normalizeSettings(stored: unknown): Settings {
  const out: Record<string, unknown> = { ...defaultSettings }
  if (stored && typeof stored === 'object')
    for (const [k, v] of Object.entries(stored)) {
      const field = settingsSchema.shape[k as keyof Settings]
      if (field?.safeParse(v).success) out[k] = v
    }
  return out as Settings
}
