import React, { useEffect, useState } from 'react'
import styles from './LeadModal.module.css'

interface AgentCli {
  name: string
  bin: string
  version: string
  status: 'found'
}

interface Props {
  memberName: string
  onClose: () => void
}

const mockClis: AgentCli[] = [
  { name: 'claude', bin: '/usr/local/bin/claude', version: '1.0.0', status: 'found' },
]

type LaunchState = 'idle' | 'loading' | 'trusting' | 'success' | 'error'
type Step = 'cli' | 'workspace' | 'trust'

export function LeadModal({ memberName, onClose }: Props) {
  const [clis, setClis] = useState<AgentCli[]>([])
  const [selected, setSelected] = useState<AgentCli | null>(null)
  const [step, setStep] = useState<Step>('cli')
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [trustPath, setTrustPath] = useState<string | null>(null)
  const [launchState, setLaunchState] = useState<LaunchState>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const result = await window.api?.scanAgentClis?.()
        if (result?.found && result.found.length > 0) {
          setClis(result.found)
          if (result.found.length === 1) setSelected(result.found[0])
        } else {
          setClis(mockClis)
          if (mockClis.length === 1) setSelected(mockClis[0])
        }
      } catch {
        setClis(mockClis)
        if (mockClis.length === 1) setSelected(mockClis[0])
      }
    }
    load()
  }, [])

  const handleNext = () => {
    if (!selected) return
    setStep('workspace')
  }

  const handleSelectFolder = async () => {
    try {
      const result = await window.api?.selectDirectory?.()
      if (result && !result.canceled && result.path) {
        setWorkspacePath(result.path)
      }
    } catch {
      // dialog failed silently
    }
  }

  const handleClearFolder = () => {
    setWorkspacePath(null)
  }

  const handleBack = () => {
    setStep('cli')
    setLaunchState('idle')
    setErrorMsg('')
  }

  const doLaunch = async () => {
    if (!selected) return
    setLaunchState('loading')
    setErrorMsg('')
    try {
      const result = await window.api?.launchMember?.({
        memberName,
        cliBin: selected.bin,
        cliName: selected.name,
        isLeader: true,
        workspacePath: workspacePath ?? undefined
      })
      if (result && result.ok === false) {
        if (result.reason === 'trust_required' && result.workspacePath) {
          setTrustPath(result.workspacePath)
          setStep('trust')
          setLaunchState('idle')
          return
        }
        setLaunchState('error')
        setErrorMsg(result.reason ?? '启动失败，请重试')
        return
      }
      setLaunchState('success')
      setTimeout(onClose, 1200)
    } catch (e: any) {
      setLaunchState('error')
      setErrorMsg(e?.message ?? '启动失败，请重试')
    }
  }

  const handleLaunch = doLaunch

  const handleTrust = async () => {
    if (!trustPath) return
    setLaunchState('trusting')
    setErrorMsg('')
    try {
      const trustResult = await window.api?.trustWorkspace?.(trustPath)
      if (trustResult && !trustResult.ok) {
        setLaunchState('error')
        setErrorMsg(trustResult.reason ?? '信任写入失败')
        return
      }
      setStep('workspace')
      await doLaunch()
    } catch (e: any) {
      setLaunchState('error')
      setErrorMsg(e?.message ?? '信任写入失败')
    }
  }

  const handleTrustCancel = () => {
    setTrustPath(null)
    setStep('workspace')
    setLaunchState('idle')
    setErrorMsg('')
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>带队 {memberName}</span>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <div className={styles.body}>
          {step === 'cli' && (
            <>
              {clis.length === 0 ? (
                <div className={styles.empty}>未检测到 agent CLI</div>
              ) : (
                <>
                  <div className={styles.hint}>选择 CLI 启动代理实例</div>
                  <div className={styles.cliList}>
                    {clis.map((cli) => (
                      <div
                        key={cli.bin}
                        className={`${styles.cliRow} ${selected?.bin === cli.bin ? styles.cliSelected : ''}`}
                        onClick={() => setSelected(cli)}
                      >
                        <span className={styles.cliIcon}>&#62;_</span>
                        <div className={styles.cliInfo}>
                          <span className={styles.cliName}>{cli.name}</span>
                          <span className={styles.cliBin}>{cli.bin}</span>
                        </div>
                        <span className={styles.cliVersion}>v{cli.version}</span>
                        {selected?.bin === cli.bin && (
                          <span className={styles.cliCheck}>&#10003;</span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {step === 'workspace' && (
            <>
              <div className={styles.hint}>选择工作目录（可选）</div>
              <div className={styles.workspaceSection}>
                {workspacePath ? (
                  <div className={styles.workspaceSelected}>
                    <span className={styles.folderIcon}>&#128193;</span>
                    <span className={styles.workspacePath}>{workspacePath}</span>
                    <button className={styles.clearBtn} onClick={handleClearFolder}>&#10005;</button>
                  </div>
                ) : (
                  <button className={styles.selectFolderBtn} onClick={handleSelectFolder}>
                    选择文件夹...
                  </button>
                )}
                <div className={styles.workspaceHint}>
                  不选择则使用默认目录
                </div>
              </div>

              {/* Summary */}
              <div className={styles.summary}>
                <div className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>CLI</span>
                  <span className={styles.summaryValue}>{selected?.name}</span>
                </div>
                {workspacePath && (
                  <div className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>目录</span>
                    <span className={styles.summaryValue}>{workspacePath.split('/').pop()}</span>
                  </div>
                )}
              </div>

              {launchState === 'success' && (
                <div className={styles.toast}>
                  已启动 {selected?.name} — {memberName}
                </div>
              )}

              {launchState === 'error' && (
                <div className={styles.errorMsg}>{errorMsg}</div>
              )}
            </>
          )}

          {step === 'trust' && (
            <>
              <div className={styles.trustSection}>
                <div className={styles.trustTitle}>工作目录未受信任</div>
                <div className={styles.trustDesc}>
                  该目录尚未在 Claude 配置中标记为可信。是否信任此目录并继续启动？
                </div>
                <div className={styles.trustPathBox}>
                  <span className={styles.folderIcon}>&#128193;</span>
                  <span className={styles.workspacePath}>{trustPath}</span>
                </div>
              </div>

              {launchState === 'error' && (
                <div className={styles.errorMsg}>{errorMsg}</div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          {step === 'cli' && (
            <>
              <button className={styles.cancelBtn} onClick={onClose}>取消</button>
              <button
                className={styles.launchBtn}
                disabled={!selected}
                onClick={handleNext}
              >
                下一步
              </button>
            </>
          )}
          {step === 'workspace' && (
            <>
              {launchState === 'error' && (
                <button
                  className={styles.retryBtn}
                  onClick={() => { setLaunchState('idle'); setErrorMsg('') }}
                >
                  重试
                </button>
              )}
              <button className={styles.cancelBtn} onClick={handleBack}>
                上一步
              </button>
              <button
                className={styles.launchBtn}
                disabled={launchState === 'loading' || launchState === 'success'}
                onClick={handleLaunch}
              >
                {launchState === 'loading' ? (
                  <span className={styles.spinner} />
                ) : launchState === 'success' ? (
                  '已启动'
                ) : (
                  '确认启动'
                )}
              </button>
            </>
          )}
          {step === 'trust' && (
            <>
              <button className={styles.cancelBtn} onClick={handleTrustCancel}>
                返回
              </button>
              <button
                className={styles.launchBtn}
                disabled={launchState === 'trusting'}
                onClick={handleTrust}
              >
                {launchState === 'trusting' ? (
                  <span className={styles.spinner} />
                ) : (
                  '信任并启动'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
