import { useEffect } from 'react'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { Toaster } from '@/components/ui/sonner'
import { installStaleChunkReload } from '@/lib/app/stale-chunk-reload'
import { THEME_INIT_SCRIPT } from '@/lib/theme/theme'
import { getCurrentUserFn } from '@/server/auth/auth.fns'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  // Server-validated session, available to every route as context.user.
  // Routes use it for UX-level protection only — server functions always
  // re-check authorization themselves.
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    return { user }
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Rush Tracker',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // Reload a tab left open across a deploy when it hits a stale route chunk.
  useEffect(installStaleChunkReload, [])

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets data-theme before first paint — avoids a flash of the wrong
            theme when a stored/system preference is dark. suppressHydrationWarning
            above is needed because this script sets the attribute before React
            hydrates, so the server-rendered markup never has it. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster richColors position="top-right" />
        {import.meta.env.DEV && (
          <TanStackDevtools
            config={{
              position: 'bottom-right',
            }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
              TanStackQueryDevtools,
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  )
}
