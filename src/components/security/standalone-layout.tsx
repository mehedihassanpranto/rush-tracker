import type { ReactNode } from 'react'

/** Centered single-card layout for sign-in steps that sit outside the app
 * areas (two-factor code, mandatory setup) — matches the login page. */
export function StandaloneLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Rush Tracker</h1>
      </div>
      <div className={wide ? 'w-full max-w-lg' : 'w-full max-w-sm'}>{children}</div>
    </div>
  )
}
