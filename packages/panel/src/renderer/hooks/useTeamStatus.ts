import { useState, useEffect } from 'react'

export function useTeamStatus() {
  const [status, setStatus] = useState<TeamStatus | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('light')

  useEffect(() => {
    // 初始化主题
    window.teamHub.getTheme().then((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })

    // 初始化状态
    window.teamHub.getInitialStatus().then((s) => {
      setStatus(s)
    })

    // 订阅状态更新
    const unsubStatus = window.teamHub.onStatusUpdate((s) => {
      setStatus(s)
    })

    // 订阅主题变化
    const unsubTheme = window.teamHub.onThemeChange((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })

    return () => {
      unsubStatus()
      unsubTheme()
    }
  }, [])

  return { status, theme }
}
