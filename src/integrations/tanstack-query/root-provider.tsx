import { QueryClient } from '@tanstack/react-query'

export function getContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Treat data as fresh for 30s so navigating back to a screen doesn't
        // re-hit the serverless functions every time. Keep unused data around
        // for 5 min so a quick revisit is instant.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // Avoid refetch storms when the window/tab regains focus.
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })

  return {
    queryClient,
  }
}
export default function TanstackQueryProvider() {}
