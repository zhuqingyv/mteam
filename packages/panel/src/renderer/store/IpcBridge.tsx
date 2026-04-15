import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { teamStatusAtom, themeAtom, mcpStoreAtom, registryAtom, projectsAtom } from './atoms'

/**
 * IPC → jotai 桥接。
 * 订阅 IPC 事件，将服务端数据直接写入 atoms。
 * 不渲染任何 UI。
 */
export function IpcBridge() {
  const setStatus = useSetAtom(teamStatusAtom)
  const setTheme = useSetAtom(themeAtom)
  const setMcpStore = useSetAtom(mcpStoreAtom)
  const setRegistry = useSetAtom(registryAtom)
  const setProjects = useSetAtom(projectsAtom)

  useEffect(() => {
    // 初始加载
    window.teamHub.getInitialStatus().then(setStatus)
    window.teamHub.getTheme().then((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })
    window.teamHub.getMcpStore().then(setMcpStore)
    window.teamHub.getRegistry().then(setRegistry)
    window.teamHub.listProjects().then(setProjects)

    // 订阅实时更新
    const unsubStatus = window.teamHub.onStatusUpdate((s) => {
      setStatus(s)
      // 商店和项目数据跟着刷新
      window.teamHub.getMcpStore().then(setMcpStore)
      window.teamHub.listProjects().then(setProjects)
    })

    const unsubTheme = window.teamHub.onThemeChange((t) => {
      setTheme(t)
      document.documentElement.setAttribute('data-theme', t)
    })

    return () => {
      unsubStatus()
      unsubTheme()
    }
  }, [setStatus, setTheme, setMcpStore, setRegistry, setProjects])

  return null
}
