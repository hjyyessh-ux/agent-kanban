import React, { useMemo } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { buildDirectoryOptions } from './directory-display';

interface BoardProjectSwitcherProps {
  cards: KanbanCard[];
  selectedDirectory: string;
  onDirectoryChange: (directory: string) => void;
}

export const BoardProjectSwitcher: React.FC<BoardProjectSwitcherProps> = ({
  cards,
  selectedDirectory,
  onDirectoryChange,
}) => {
  const options = useMemo(() => buildDirectoryOptions(cards), [cards]);

  if (options.length === 0) {
    return null;
  }

  return (
    <nav className="app-project-switcher" aria-label="Project directory quick switcher">
      <button
        type="button"
        className={`app-project-chip${selectedDirectory ? '' : ' is-active'}`}
        aria-pressed={!selectedDirectory}
        onClick={() => onDirectoryChange('')}
      >
        <span className="app-project-chip-label">All</span>
        <span className="app-project-chip-count">{cards.length}</span>
      </button>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`app-project-chip${selectedDirectory === option.value ? ' is-active' : ''}`}
          aria-pressed={selectedDirectory === option.value}
          title={option.value}
          onClick={() => onDirectoryChange(selectedDirectory === option.value ? '' : option.value)}
        >
          <span className="app-project-chip-label">{option.label}</span>
          <span className="app-project-chip-count">{option.count}</span>
        </button>
      ))}
    </nav>
  );
};
