import { createContext, useContext } from 'react'

/** Which collection a documents tab is showing, for actions deep in the tree. */
export interface DocsTarget {
  tabId: string
  connectionId: string
  ns: string
  /** Set for views (and other read-only namespaces): why writes are unavailable. */
  readOnlyReason: string | null
}

export const DocsContext = createContext<DocsTarget | null>(null)

export function useDocsTarget(): DocsTarget {
  const v = useContext(DocsContext)
  if (!v) throw new Error('useDocsTarget outside DocsContext')
  return v
}
