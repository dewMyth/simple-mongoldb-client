/**
 * mongodb-connection-string-url depends on the `whatwg-url` package, whose dependency
 * webidl-conversions touches SharedArrayBuffer at load time (undefined without cross-origin
 * isolation). Chromium's native URL implements the same WHATWG spec, so the renderer uses it.
 */
export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams
