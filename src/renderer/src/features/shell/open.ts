import { useTabsStore } from '../../stores/tabs'

/** Opens (or switches to) a shell tab for a connection, optionally starting in a database. */
export function openShell(
  connectionId: string,
  name: string,
  db?: string,
  opts?: { newTab?: boolean }
): string {
  return useTabsStore
    .getState()
    .open({ type: 'shell', connectionId, ns: db ?? null, title: `${db ?? name} · shell` }, opts)
}
