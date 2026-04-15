import React, { useCallback, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { mcpStoreAtom, registryAtom, storeTabAtom, registrySearchAtom, membersAtom } from '../store/atoms'
import styles from './McpStore.module.css'

function RuntimeBadge({ hint }: { hint?: string }) {
  if (!hint) return null
  return <span className={styles.runtimeBadge}>{hint}</span>
}

/** 从 registry 数据生成安装用的 command/args */
function buildCommand(pkg: RegistryPackage): { command: string; args: string[] } {
  const hint = pkg.runtimeHint ?? ''
  const id = pkg.identifier
  if (hint === 'npx') return { command: 'npx', args: ['-y', id] }
  if (hint === 'uvx') return { command: 'uvx', args: [id] }
  if (hint === 'node') return { command: 'node', args: [id] }
  if (hint === 'docker') return { command: 'docker', args: ['run', '-i', id] }
  // fallback based on registryType
  if (pkg.registryType === 'npm') return { command: 'npx', args: ['-y', id] }
  if (pkg.registryType === 'pypi') return { command: 'uvx', args: [id] }
  return { command: id, args: [] }
}

export function McpStore() {
  const [tab, setTab] = useAtom(storeTabAtom)
  const { store, memberMounts } = useAtomValue(mcpStoreAtom)
  const setMcpStore = useSetAtom(mcpStoreAtom)
  const registry = useAtomValue(registryAtom)
  const members = useAtomValue(membersAtom)
  const [search, setSearch] = useAtom(registrySearchAtom)
  const setRegistry = useSetAtom(registryAtom)
  const [installing, setInstalling] = useState<Set<string>>(new Set())

  const installedNames = new Set(store.map((s) => s.name))

  const doSearch = useCallback((q: string) => {
    setSearch(q)
    window.teamHub.getRegistry(q || undefined).then(setRegistry)
  }, [setSearch, setRegistry])

  const refreshStore = useCallback(() => {
    window.teamHub.getMcpStore().then(setMcpStore)
  }, [setMcpStore])

  const handleInstall = useCallback(async (server: RegistryServer) => {
    const pkg = server.packages?.[0]
    if (!pkg) return
    const { command, args } = buildCommand(pkg)
    setInstalling((prev) => new Set(prev).add(server.name))
    await window.teamHub.installStoreMcp({
      name: server.name,
      command,
      args,
      description: server.description
    })
    setInstalling((prev) => { const n = new Set(prev); n.delete(server.name); return n })
    refreshStore()
  }, [refreshStore])

  const handleUninstall = useCallback(async (name: string) => {
    await window.teamHub.uninstallStoreMcp(name)
    refreshStore()
  }, [refreshStore])

  // 已安装的 MCP，每个被哪些成员挂载
  function getMountedMembers(mcpName: string): string[] {
    return memberMounts
      .filter((m) => m.mcps.includes(mcpName))
      .map((m) => m.displayName)
  }

  return (
    <div className={styles.container}>
      {/* sub-tabs */}
      <div className={styles.subTabs}>
        <button
          className={`${styles.subTab} ${tab === 'installed' ? styles.subTabActive : ''}`}
          onClick={() => setTab('installed')}
        >
          已安装 {store.length > 0 && <span className={styles.countBadge}>{store.length}</span>}
        </button>
        <button
          className={`${styles.subTab} ${tab === 'registry' ? styles.subTabActive : ''}`}
          onClick={() => setTab('registry')}
        >
          仓库 {registry.metadata.count > 0 && <span className={styles.countBadge}>{registry.metadata.count}</span>}
        </button>
      </div>

      {/* 已安装 tab */}
      {tab === 'installed' && (
        store.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>+</div>
            <div className={styles.emptyText}>尚未安装 MCP</div>
            <div className={styles.emptyHint}>切换到「仓库」浏览可用 MCP</div>
          </div>
        ) : (
          <div className={styles.list}>
            {store.map((mcp) => {
              const mountedBy = getMountedMembers(mcp.name)
              return (
                <div key={mcp.name} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div className={styles.mcpIcon}>M</div>
                    <div className={styles.cardInfo}>
                      <div className={styles.mcpName}>{mcp.name}</div>
                      {mcp.description && (
                        <div className={styles.mcpDesc}>{mcp.description}</div>
                      )}
                    </div>
                    <button className={styles.uninstallBtn} onClick={() => handleUninstall(mcp.name)}>卸载</button>
                  </div>
                  <div className={styles.cardMeta}>
                    <span className={styles.command}>{mcp.command} {mcp.args?.join(' ')}</span>
                  </div>
                  {mountedBy.length > 0 ? (
                    <div className={styles.mountedBy}>
                      <span className={styles.mountLabel}>已挂载</span>
                      {mountedBy.map((name) => (
                        <span key={name} className={styles.mountBadge}>{name}</span>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.mountedBy}>
                      <span className={styles.mountNone}>未被挂载</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      {/* 仓库 tab */}
      {tab === 'registry' && (
        <>
          <div className={styles.searchBar}>
            <input
              className={styles.searchInput}
              placeholder="搜索 MCP..."
              value={search}
              onChange={(e) => doSearch(e.target.value)}
            />
          </div>
          {registry.servers.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>?</div>
              <div className={styles.emptyText}>
                {search ? '无搜索结果' : '加载中...'}
              </div>
            </div>
          ) : (
            <div className={styles.list}>
              {registry.servers.map((item) => {
                const s = item.server
                const pkg = s.packages?.[0]
                const installed = installedNames.has(s.name)
                return (
                  <div key={s.name} className={`${styles.card} ${installed ? styles.cardInstalled : ''}`}>
                    <div className={styles.cardHeader}>
                      <div className={styles.mcpIcon}>
                        {s.title ? s.title.charAt(0).toUpperCase() : 'M'}
                      </div>
                      <div className={styles.cardInfo}>
                        <div className={styles.mcpName}>
                          {s.title || s.name}
                        </div>
                      </div>
                      {installed ? (
                        <span className={styles.installedTag}>已安装</span>
                      ) : (
                        <button
                          className={styles.installBtn}
                          disabled={installing.has(s.name)}
                          onClick={() => handleInstall(s)}
                        >
                          {installing.has(s.name) ? '...' : '安装'}
                        </button>
                      )}
                    </div>
                    <div className={styles.descBlock}>{s.description}</div>
                    <div className={styles.cardMeta}>
                      {pkg && (
                        <>
                          <RuntimeBadge hint={pkg.runtimeHint} />
                          <span className={styles.pkgId}>{pkg.identifier}</span>
                          <span className={styles.version}>v{s.version}</span>
                          {pkg.environmentVariables && pkg.environmentVariables.length > 0 && (
                            <span className={styles.envBadge}>{pkg.environmentVariables.length} env</span>
                          )}
                        </>
                      )}
                      {s.repository?.source && (
                        <span className={styles.sourceBadge}>{s.repository.source}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
