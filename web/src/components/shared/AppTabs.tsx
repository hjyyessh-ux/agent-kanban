import React, { useRef } from 'react';

export type MainTab = 'board' | 'wiki' | 'scheduler' | 'capabilities' | 'settings';

/** Render + keyboard order of the main tab strip. */
export const MAIN_TABS: MainTab[] = ['board', 'wiki', 'capabilities', 'scheduler', 'settings'];

export const TAB_IDS = {
  board: 'app-tab-board',
  wiki: 'app-tab-wiki',
  scheduler: 'app-tab-scheduler',
  capabilities: 'app-tab-capabilities',
  settings: 'app-tab-settings',
} as const;

export const PANEL_IDS = {
  board: 'app-panel-board',
  wiki: 'app-panel-wiki',
  scheduler: 'app-panel-scheduler',
  capabilities: 'app-panel-capabilities',
  settings: 'app-panel-settings',
} as const;

const TAB_LABELS: Record<MainTab, string> = {
  board: 'Board',
  wiki: 'Wiki',
  capabilities: 'Capabilities',
  scheduler: 'Scheduler',
  settings: 'Settings',
};

interface AppTabsProps {
  activeTab: MainTab;
  onActivate: (tab: MainTab) => void;
}

/** Main section tab strip with roving-tabindex keyboard navigation. */
export function AppTabs({ activeTab, onActivate }: AppTabsProps) {
  const tabRefs = useRef<Record<MainTab, HTMLButtonElement | null>>({
    board: null,
    wiki: null,
    scheduler: null,
    capabilities: null,
    settings: null,
  });

  const activateTab = (tab: MainTab, shouldFocus = false) => {
    onActivate(tab);

    if (shouldFocus) {
      requestAnimationFrame(() => {
        tabRefs.current[tab]?.focus();
      });
    }
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: MainTab,
  ) => {
    const currentIndex = MAIN_TABS.indexOf(currentTab);

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      activateTab(MAIN_TABS[(currentIndex + 1) % MAIN_TABS.length], true);
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      activateTab(MAIN_TABS[(currentIndex - 1 + MAIN_TABS.length) % MAIN_TABS.length], true);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      activateTab('board', true);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      activateTab('settings', true);
    }
  };

  return (
    <div className="app-tabs" role="tablist" aria-label="Main sections">
      {MAIN_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          ref={(element) => {
            tabRefs.current[tab] = element;
          }}
          id={TAB_IDS[tab]}
          role="tab"
          aria-selected={activeTab === tab}
          aria-controls={PANEL_IDS[tab]}
          tabIndex={activeTab === tab ? 0 : -1}
          className={`app-tab${activeTab === tab ? ' app-tab--active' : ''}`}
          onClick={() => activateTab(tab)}
          onKeyDown={(event) => handleTabKeyDown(event, tab)}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}
