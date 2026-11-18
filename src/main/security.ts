import { app, session, shell, type WebContents } from 'electron'

const isSafeExternal = (url: string) => /^https?:\/\//i.test(url)

/** Navigation inside the app window is limited to the app itself; everything else goes to the browser. */
export function hardenWebContents(contents: WebContents, appOrigin: () => string | null): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const origin = appOrigin()
    if (origin && url.startsWith(origin)) return
    event.preventDefault()
    if (isSafeExternal(url)) void shell.openExternal(url)
  })

  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export function applyGlobalSecurity(): void {
  // No camera, mic, notifications, geolocation, etc. Only writing text to the clipboard (the
  // "copy value/document" buttons) is allowed; reading the clipboard stays blocked.
  const allowed = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allowed.has(permission))
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
