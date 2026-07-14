import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'jff-theme'

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * Light/dark theme toggle. The initial class is applied pre-paint by an inline
 * script in index.html; this hook keeps React in sync and persists the choice.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme)

  useEffect(() => {
    const isDark = theme === 'dark'
    document.documentElement.classList.toggle('dark', isDark)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }, [theme])

  function toggle() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  return { theme, toggle }
}
