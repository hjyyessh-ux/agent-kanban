import React, { type ReactElement, type ReactNode } from 'react';
import { describe, expect, test } from 'bun:test';
import { BoardColumnHeader, getColumnMenuItems } from './BoardColumnHeader';
import { BoardColumnMenu } from './BoardColumnMenu';
import { COLUMN_MENU_COPY } from '../../constants/copy';

interface ElementProps {
  children?: ReactNode;
  onClick?: (event: unknown) => void;
}

function renderHeader(
  props: React.ComponentProps<typeof BoardColumnHeader>,
): ReactElement<ElementProps> {
  const node = BoardColumnHeader(props);
  if (node instanceof Promise) {
    throw new Error('Expected BoardColumnHeader to render synchronously');
  }

  return asElement(node);
}

function asElement(node: ReactNode): ReactElement<ElementProps> {
  if (!React.isValidElement<ElementProps>(node)) {
    throw new Error('Expected a React element');
  }

  return node;
}

function getText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getText).join('');
  }

  if (React.isValidElement<ElementProps>(node)) {
    return getText(node.props.children);
  }

  return '';
}

function findMenu(node: ReactNode): ReactElement<React.ComponentProps<typeof BoardColumnMenu>> | null {
  if (!React.isValidElement<ElementProps>(node)) return null;
  if (node.type === BoardColumnMenu) {
    return node as unknown as ReactElement<React.ComponentProps<typeof BoardColumnMenu>>;
  }
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findMenu(child);
    if (found) return found;
  }
  return null;
}

function findByClass(node: ReactNode, className: string): ReactElement<ElementProps & { className?: string }> | null {
  if (!React.isValidElement<ElementProps & { className?: string }>(node)) return null;
  if (node.props.className?.split(' ').includes(className)) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function selectItem(
  props: Parameters<typeof getColumnMenuItems>[0],
  label: string,
): () => void {
  const item = getColumnMenuItems(props).find((candidate) => candidate.label === label);
  if (!item) throw new Error(`Menu item not found: ${label}`);
  return item.onSelect;
}

describe('BoardColumnHeader', () => {
  test('calls Archive All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onArchive = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    selectItem({ status: 'done', count: 1, onArchive }, COLUMN_MENU_COPY.archiveAll)();

    expect(receivedArg).toBeUndefined();
  });

  test('calls Done All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onCompleteAll = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    selectItem({ status: 'complete', count: 1, onCompleteAll }, COLUMN_MENU_COPY.doneAll)();

    expect(receivedArg).toBeUndefined();
  });

  test('calls Hide All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onHideAllSessions = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    selectItem({ status: 'complete', count: 1, onHideAllSessions }, COLUMN_MENU_COPY.hideAll)();

    expect(receivedArg).toBeUndefined();
  });

  test('uses the provided complete session collapse label', () => {
    const labels = getColumnMenuItems({
      status: 'complete',
      count: 1,
      hideAllSessionsLabel: COLUMN_MENU_COPY.collapseAll,
      onHideAllSessions: () => undefined,
    }).map((item) => item.label);

    expect(labels).toEqual([COLUMN_MENU_COPY.collapseAll]);
  });

  test('folds the complete column bulk actions into one ⋯ menu, in order', () => {
    const element = renderHeader({
      status: 'complete',
      label: 'Complete',
      count: 2,
      onHideAllSessions: () => undefined,
      onCompleteAll: () => undefined,
    });

    const menu = findMenu(element);
    expect(menu?.props.columnLabel).toBe('Complete');
    expect(menu?.props.items.map((item) => item.label)).toEqual([COLUMN_MENU_COPY.hideAll, COLUMN_MENU_COPY.doneAll]);
    // No bulk action is left behind as a header button next to the label.
    expect(getText(element)).not.toContain(COLUMN_MENU_COPY.doneAll);
    expect(getText(element)).not.toContain(COLUMN_MENU_COPY.hideAll);
  });

  test('renders no menu when there is nothing to act on', () => {
    expect(findMenu(renderHeader({ status: 'todo', label: 'To Do', count: 3 }))).toBeNull();
    expect(findMenu(renderHeader({
      status: 'done',
      label: 'Done',
      count: 2,
      actionableCount: 0,
      onArchive: () => undefined,
    }))).toBeNull();
  });

  test('shows the unread pill only on the complete column with unread cards', () => {
    const complete = renderHeader({ status: 'complete', label: 'Complete', count: 4, unreadCount: 3 });
    const pill = findByClass(complete, 'kv2-column-unread');
    expect(getText(pill?.props.children)).toBe('3');

    expect(findByClass(
      renderHeader({ status: 'complete', label: 'Complete', count: 4, unreadCount: 0 }),
      'kv2-column-unread',
    )).toBeNull();
    expect(findByClass(
      renderHeader({ status: 'done', label: 'Done', count: 4, unreadCount: 2 }),
      'kv2-column-unread',
    )).toBeNull();
  });

  test('offers Mark all read only on the complete column while something is unread', () => {
    let receivedArg: unknown = 'not-called';
    const onMarkAllRead = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    const labels = getColumnMenuItems({
      status: 'complete',
      count: 3,
      unreadCount: 2,
      onHideAllSessions: () => undefined,
      onMarkAllRead,
      onCompleteAll: () => undefined,
    }).map((item) => item.label);
    expect(labels).toEqual([COLUMN_MENU_COPY.hideAll, COLUMN_MENU_COPY.markAllRead, COLUMN_MENU_COPY.doneAll]);

    selectItem({ status: 'complete', count: 3, unreadCount: 2, onMarkAllRead }, COLUMN_MENU_COPY.markAllRead)();
    expect(receivedArg).toBeUndefined();

    expect(getColumnMenuItems({ status: 'complete', count: 3, unreadCount: 0, onMarkAllRead })).toEqual([]);
    expect(getColumnMenuItems({ status: 'done', count: 3, unreadCount: 2, onMarkAllRead })).toEqual([]);
  });

  test('makes the unread pill a jump button when a jump handler is wired', () => {
    let jumps = 0;
    const header = renderHeader({
      status: 'complete',
      label: 'Complete',
      count: 4,
      unreadCount: 3,
      onUnreadJump: () => { jumps += 1; },
    });
    const pill = findByClass(header, 'kv2-column-unread');
    expect(pill?.type).toBe('button');
    pill?.props.onClick?.({});
    expect(jumps).toBe(1);
  });
});
