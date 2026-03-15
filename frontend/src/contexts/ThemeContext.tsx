import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface ThemeCtx {
  isDark: boolean
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeCtx>({ isDark: false, toggleTheme: () => {} })

function applyTheme(dark: boolean) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState<boolean>(
    () => localStorage.getItem('exam_theme') === 'dark',
  )

  // Sync the data-theme attribute whenever isDark changes (including on mount).
  // main.tsx also does this before React hydrates to prevent a flash, but this
  // useEffect ensures the attribute stays in sync if state changes at runtime.
  useEffect(() => {
    applyTheme(isDark)
  }, [isDark])

  const toggleTheme = () => {
    setIsDark(d => {
      const next = !d
      localStorage.setItem('exam_theme', next ? 'dark' : 'light')
      return next
    })
  }

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
