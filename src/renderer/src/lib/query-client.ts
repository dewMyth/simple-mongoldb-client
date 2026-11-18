import { QueryClient } from '@tanstack/react-query'

/** Shared so stores outside React (e.g. results-store) can invalidate cached queries. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } }
})
