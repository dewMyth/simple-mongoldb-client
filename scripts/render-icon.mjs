// Renders build/icon.svg to build/icon.png (1024x1024) with Electron: `npx electron scripts/render-icon.mjs`.
// electron-builder makes the .icns/.ico from the PNG.
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const __dirname = import.meta.dirname

void app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '../build/icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  })
  win.webContents.setZoomFactor(1)
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`
      )
  )
  await sleep(300)
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024 }).toPNG()
  writeFileSync(join(__dirname, '../build/icon.png'), png)
  process.stdout.write(`build/icon.png ${png.length} bytes\n`)
  app.quit()
})
