import Button from '../../atoms/Button';
import Icon from '../../atoms/Icon';
import Surface from '../../atoms/Surface';
import Tag from '../../atoms/Tag';
import './TemplateList.css';

export interface McpToolVisibility {
  name: string;
  surface: string[] | '*';
  search: string[] | '*';
}

export interface RoleTemplate {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  avatar: string | null;
  availableMcps: McpToolVisibility[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateListProps {
  templates: RoleTemplate[];
  onSelect?: (name: string) => void;
  onEdit?: (name: string) => void;
  onDelete?: (name: string) => void;
  onCreate?: () => void;
  loading?: boolean;
}

function resolveAvatarUrl(id: string | null): string | null {
  if (!id) return null;
  if (id.startsWith('avatar-') && /^avatar-\d{2}$/.test(id)) {
    return new URL(`../../assets/avatars/${id}.png`, import.meta.url).href;
  }
  return `/avatars/${id}.png`;
}

function truncate(text: string | null, max = 80): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const ch = Array.from(trimmed)[0] ?? '?';
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

export default function TemplateList({
  templates,
  onSelect,
  onEdit,
  onDelete,
  onCreate,
  loading = false,
}: TemplateListProps) {
  return (
    <div className="tpl-list">
      <div className="tpl-list__header">
        <h2 className="tpl-list__title">角色模板</h2>
        {onCreate && (
          <Button variant="primary" size="sm" onClick={onCreate}>
            <span className="tpl-list__create-label">
              <Icon name="plus" size={12} />
              <span>新建模板</span>
            </span>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="tpl-list__grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="tpl-list__skeleton" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <Surface variant="panel">
          <div className="tpl-list__empty">
            <div className="tpl-list__empty-icon" aria-hidden>📋</div>
            <div className="tpl-list__empty-text">暂无模板</div>
            {onCreate && (
              <Button variant="primary" size="sm" onClick={onCreate}>
                创建第一个模板
              </Button>
            )}
          </div>
        </Surface>
      ) : (
        <div className="tpl-list__grid">
          {templates.map((tpl) => {
            const avatarUrl = resolveAvatarUrl(tpl.avatar);
            return (
              <article
                key={tpl.name}
                className="tpl-list__card"
                onClick={() => onSelect?.(tpl.name)}
                role={onSelect ? 'button' : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onKeyDown={(e) => {
                  if (!onSelect) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(tpl.name);
                  }
                }}
              >
                <header className="tpl-list__card-head">
                  <div className="tpl-list__avatar">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt={tpl.avatar ?? tpl.name}
                        className="tpl-list__avatar-img"
                        draggable={false}
                      />
                    ) : (
                      <div className="tpl-list__avatar-placeholder" aria-hidden>
                        {initialOf(tpl.name)}
                      </div>
                    )}
                  </div>
                  <div className="tpl-list__meta">
                    <div className="tpl-list__name">{tpl.name}</div>
                    <Tag label={tpl.role} size="sm" />
                  </div>
                </header>

                {tpl.description && (
                  <p className="tpl-list__desc" title={tpl.description}>
                    {truncate(tpl.description, 100)}
                  </p>
                )}

                {tpl.availableMcps.length > 0 && (
                  <div className="tpl-list__mcps">
                    {tpl.availableMcps.slice(0, 3).map((m) => (
                      <Tag key={m.name} label={m.name} size="sm" variant="default" />
                    ))}
                    {tpl.availableMcps.length > 3 && (
                      <span className="tpl-list__mcps-more">
                        +{tpl.availableMcps.length - 3}
                      </span>
                    )}
                  </div>
                )}

                <footer
                  className="tpl-list__ops"
                  onClick={(e) => e.stopPropagation()}
                >
                  {onEdit && (
                    <Button variant="ghost" size="sm" onClick={() => onEdit(tpl.name)}>
                      <span className="tpl-list__op-label">
                        <Icon name="settings" size={12} />
                        <span>编辑</span>
                      </span>
                    </Button>
                  )}
                  {onDelete && (
                    <Button variant="ghost" size="sm" onClick={() => onDelete(tpl.name)}>
                      <span className="tpl-list__op-label">
                        <Icon name="close" size={12} />
                        <span>删除</span>
                      </span>
                    </Button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
