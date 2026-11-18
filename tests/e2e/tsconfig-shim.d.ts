// Playwright `page.evaluate` callbacks run in the renderer; give them DOM + window.api types.
/// <reference lib="dom" />
import type { Api } from '../../src/shared/api'

declare global {
  interface Window {
    api: Api
  }
}
