// 空态组件：TeamPage 无团队时显示"尚未创建团队"卡片 + 创建入口。
// 拆出独立文件让 TeamPage.tsx 控制在 ≤200 行。

import Surface from '../atoms/Surface';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import Text from '../atoms/Text';

export interface TeamPageEmptyProps {
  onCreateTeam: () => void;
  canCreate: boolean;
}

export default function TeamPageEmpty({ onCreateTeam, canCreate }: TeamPageEmptyProps) {
  return (
    <div className="team-page__empty">
      <Surface variant="panel">
        <div className="team-page__empty-inner">
          <div className="team-page__empty-icon" aria-hidden>
            <Icon name="team" size={32} />
          </div>
          <Text variant="title">尚未创建团队</Text>
          <Text variant="subtitle">让主 Agent 帮你拉起第一个团队，开始协作（Esc 关闭）</Text>
          <div className="team-page__empty-actions">
            <Button variant="primary" size="md" onClick={onCreateTeam} disabled={!canCreate}>
              创建团队
            </Button>
          </div>
        </div>
      </Surface>
    </div>
  );
}
