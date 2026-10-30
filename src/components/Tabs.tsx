import type { ReactNode } from 'react';

interface TabItem {
  key: string;
  label: string;
  count?: number;
}

interface TabsProps {
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (key: string) => void;
  id?: string;
  children?: ReactNode;
}

export function Tabs({ tabs, activeTab, onTabChange, id = 'tabs' }: TabsProps) {
  return (
    <div className="tabs" id={id} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          className={`tabs__tab ${activeTab === tab.key ? 'tabs__tab--active' : ''}`}
          onClick={() => onTabChange(tab.key)}
          id={`${id}-${tab.key}`}
          aria-selected={activeTab === tab.key}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tabs__count">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
