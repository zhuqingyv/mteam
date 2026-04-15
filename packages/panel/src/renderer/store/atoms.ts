import { atom } from 'jotai'

// ── 核心数据 ──────────────────────────────────────────────────────────────────
export const teamStatusAtom = atom<TeamStatus | null>(null)
export const themeAtom = atom<'dark' | 'light'>('light')
export const mcpStoreAtom = atom<McpStoreData>({ store: [], memberMounts: [] })
export const registryAtom = atom<RegistryData>({ servers: [], metadata: { count: 0 } })
export const projectsAtom = atom<ProjectData[]>([])

// ── 导航状态 ──────────────────────────────────────────────────────────────────
export type Page = 'team' | 'store' | 'projects'
export const pageAtom = atom<Page>('team')
export type StoreTab = 'installed' | 'registry'
export const storeTabAtom = atom<StoreTab>('installed')
export const selectedMemberAtom = atom<string | null>(null)
export const selectedProjectAtom = atom<string | null>(null) // project id
export const registrySearchAtom = atom<string>('')

// ── 派生状态 ──────────────────────────────────────────────────────────────────
export const membersAtom = atom((get) => get(teamStatusAtom)?.members ?? [])
export const sessionsAtom = atom((get) => get(teamStatusAtom)?.sessions ?? [])
export const workingCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === 'working').length)
export const reservedCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === 'reserved').length)
export const offlineCountAtom = atom((get) => get(membersAtom).filter((m) => m.status === 'offline').length)
export const healthyAtom = atom((get) => get(teamStatusAtom)?.healthy ?? true)
export const activeProjectsCountAtom = atom((get) => get(projectsAtom).filter((p) => !['done', 'abandoned'].includes(p.status)).length)
