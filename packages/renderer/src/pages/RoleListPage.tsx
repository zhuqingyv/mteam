import { useEffect, useMemo, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import WorkerListPanel, { type WorkerListTab } from '../organisms/WorkerListPanel';
import TemplateEditor from '../organisms/TemplateEditor';
import Modal from '../atoms/Modal';
import ConfirmDialog from '../molecules/ConfirmDialog';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Input from '../atoms/Input';
import Logo from '../atoms/Logo';
import StatusDot from '../atoms/StatusDot';
import {
  useWorkerStore, selectWorkers, selectWorkersStats, selectWorkersLoading,
  usePrimaryAgentStore,
} from '../store';
import { useWorkers } from '../hooks/useWorkers';
import { useWorkersPage } from '../hooks/useWorkersPage';
import type { RoleTemplate } from '../api/templates';
import type { TemplateDraft } from '../organisms/TemplateEditor';
import './RoleListPage.css';

function toDraft(t: RoleTemplate): TemplateDraft {
  return {
    name: t.name,
    role: t.role,
    description: t.description ?? '',
    persona: t.persona ?? '',
    avatar: t.avatar ?? null,
    availableMcps: t.availableMcps.map((m) => m.name),
  };
}

export default function RoleListPage() {
  useWorkers();
  const workers = useWorkerStore(selectWorkers);
  const stats = useWorkerStore(selectWorkersStats);
  const loading = useWorkerStore(selectWorkersLoading);
  const paConfig = usePrimaryAgentStore((s) => s.config);
  const paStatus = usePrimaryAgentStore((s) => s.status);

  const page = useWorkersPage();
  const [tab, setTab] = useState<WorkerListTab>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !page.editorOpen && !page.chatHint) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page.editorOpen, page.chatHint]);

  const mcpOptions = useMemo(
    () => Array.from(new Set(page.templates.flatMap((t) => t.availableMcps.map((m) => m.name)))),
    [page.templates],
  );
  const existingNames = useMemo(() => page.templates.map((t) => t.name), [page.templates]);
  const isEdit = !!(page.editing && page.editing.name);
  const statusLabel = paStatus === 'RUNNING' ? '在线' : '离线';

  return (
    <PanelWindow>
      <header className="role-list-page__header">
        <div className="role-list-page__brand">
          <Logo size={26} status={paStatus === 'RUNNING' ? 'online' : 'offline'} />
          <span className="role-list-page__brand-name">{paConfig?.name ?? 'MTEAM'}</span>
          <StatusDot status={paStatus === 'RUNNING' ? 'online' : 'offline'} size="sm" />
          <span className="role-list-page__brand-status">{statusLabel}</span>
        </div>
        <div className="role-list-page__tools">
          <div className="role-list-page__search">
            <Input value={page.query} onChange={page.setQuery} placeholder="搜索员工 / 角色 / MCP…" />
          </div>
          <Button variant="primary" size="sm" onClick={page.handleCreate}>
            <span className="role-list-page__btn-label">
              <Icon name="plus" size={12} /><span>新建成员</span>
            </span>
          </Button>
          <Button variant="icon" size="sm" onClick={() => window.electronAPI?.openTeamPanel()}>
            <Icon name="team" size={20} />
          </Button>
          <Button variant="icon" size="sm" onClick={() => window.close()}>
            <Icon name="close" size={20} />
          </Button>
        </div>
      </header>

      <section className="role-list-page__title-area">
        <h1 className="role-list-page__title">数字员工</h1>
        <p className="role-list-page__subtitle">浏览、筛选团队里的每一位成员，查看在线状态与最近协作。</p>
      </section>

      <div className="role-list-page__body">
        <WorkerListPanel
          workers={workers}
          stats={stats}
          tab={tab}
          onTabChange={setTab}
          searchQuery={page.query}
          loading={loading}
          onChat={page.handleChat}
          onViewMore={page.handleViewMore}
        />
      </div>

      <footer className="role-list-page__footer">
        <span className="role-list-page__cheer" aria-hidden>✨</span>
        <span className="role-list-page__cheer-text">今天也辛苦各位数字员工了，继续冲！</span>
        <Button variant="ghost" size="sm" onClick={() => console.log('[worker-list] open activity view (TODO: next wave)')}>团队活跃度</Button>
      </footer>

      <Modal
        open={page.editorOpen}
        onClose={() => page.setEditorOpen(false)}
        title={isEdit ? `编辑：${page.editing!.name}` : '新建成员'}
        size="lg"
      >
        <TemplateEditor
          template={page.editing ? toDraft(page.editing) : undefined}
          mcpOptions={mcpOptions}
          avatars={page.avatars}
          existingNames={existingNames}
          isEdit={isEdit}
          onSave={page.handleSave}
          onCancel={() => page.setEditorOpen(false)}
          onRandomAvatar={page.handleRandomAvatar}
        />
      </Modal>

      <ConfirmDialog
        open={!!page.chatHint}
        title="提示"
        message={page.chatHint ?? ''}
        confirmLabel="知道了"
        onConfirm={() => page.setChatHint(null)}
        onCancel={() => page.setChatHint(null)}
      />
    </PanelWindow>
  );
}
