import React from 'react';

export interface BoardWorkspaceProps {
  leadingPanel: React.ReactNode;
  leadingPanelExpanded: boolean;
  children: React.ReactNode;
}

export const BoardWorkspace: React.FC<BoardWorkspaceProps> = ({
  leadingPanel,
  leadingPanelExpanded,
  children,
}) => (
  <div
    className={`kv2-board-workspace${leadingPanelExpanded ? ' kv2-board-workspace--quick-actions-open' : ''}`}
    data-quick-actions-expanded={leadingPanelExpanded}
  >
    {leadingPanel}
    <div
      className="kv2-board-workspace-content"
      inert={leadingPanelExpanded}
      aria-hidden={leadingPanelExpanded || undefined}
    >
      {children}
    </div>
  </div>
);
