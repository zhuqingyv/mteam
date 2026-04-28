import type { ReactNode } from 'react';
import Button from '../../atoms/Button';
import './TabFilter.css';

export interface TabFilterTab {
  key: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

interface TabFilterProps {
  tabs: TabFilterTab[];
  activeKey: string;
  onChange: (key: string) => void;
}

export default function TabFilter({ tabs, activeKey, onChange }: TabFilterProps) {
  return (
    <div className="tab-filter" role="tablist">
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          <div
            key={tab.key}
            className={`tab-filter__item${active ? ' tab-filter__item--active' : ''}`}
            role="tab"
            aria-selected={active}
          >
            <Button
              variant={active ? 'primary' : 'ghost'}
              size="md"
              onClick={() => onChange(tab.key)}
            >
              {tab.icon !== undefined && (
                <span className="tab-filter__icon" aria-hidden="true">
                  {tab.icon}
                </span>
              )}
              <span className="tab-filter__label">{tab.label}</span>
              {typeof tab.count === 'number' && (
                <span className="tab-filter__count">{tab.count}</span>
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
