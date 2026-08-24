import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

import { applyTheme, getStoredTheme, getSystemTheme } from '@/lib/theme/theme'
import { Button } from '@/components/ui/button'
import type { Theme } from '@/lib/theme/theme'

export function ThemeToggle({ className }: { className?: string }) {
  // Starts 'light' to match SSR markup; the blocking init script has
  // already set the real attribute on <html> before this ever paints, so
  // this only needs to sync its own icon state on mount.
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    setTheme(getStoredTheme() ?? getSystemTheme())
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      className={className}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}
