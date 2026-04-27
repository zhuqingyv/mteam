import { useEffect, useState } from 'react';
import PanelWindow from '../templates/PanelWindow';
import PrimaryAgentSettings from '../organisms/PrimaryAgentSettings';
import CliList, { type CliEntry } from '../molecules/CliList';
import Button from '../atoms/Button';
import Icon from '../atoms/Icon';
import { listCli, refreshCli, type CliInfo } from '../api/cli';
import { usePrimaryAgentStore, selectOnline, selectPaConfig } from '../store';
import './SettingsPage.css';

function toCliEntries(list: CliInfo[]): CliEntry[] {
  return list.map((c) => ({
    name: c.name,
    path: c.path ?? '',
    available: c.available,
  }));
}

export default function SettingsPage() {
  const config = usePrimaryAgentStore(selectPaConfig);
  const online = usePrimaryAgentStore(selectOnline);

  const [clis, setClis] = useState<CliEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    listCli().then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setClis(toCliEntries(res.data));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRefresh = async () => {
    const res = await refreshCli();
    if (res.ok && res.data) setClis(toCliEntries(res.data));
  };

  const handleClose = () => {
    window.close();
  };

  return (
    <PanelWindow>
      <div className="settings-page__close">
        <Button variant="icon" size="sm" onClick={handleClose}>
          <Icon name="close" size={14} />
        </Button>
      </div>
      <div className="settings-page__content">
        <PrimaryAgentSettings config={config} running={online} />
        <CliList clis={clis} onRefresh={handleRefresh} />
      </div>
    </PanelWindow>
  );
}
