/** React Query keys for a collection's indexes. */
export const indexKeys = {
  list: (connectionId: string, ns: string) => ['indexes', connectionId, ns] as const,
  builds: (connectionId: string, ns: string) => ['indexes', connectionId, ns, 'builds'] as const
}
