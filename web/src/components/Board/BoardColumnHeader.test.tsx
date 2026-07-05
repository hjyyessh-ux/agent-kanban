import React, { type ReactElement, type ReactNode } from 'react';
import { describe, expect, test } from 'bun:test';
import { BoardColumnHeader } from './BoardColumnHeader';

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

function findButton(node: ReactNode, label: string): ReactElement<ElementProps> {
  if (React.isValidElement<ElementProps>(node)) {
    if (node.type === 'button' && getText(node.props.children).trim() === label) {
      return node;
    }

    for (const child of React.Children.toArray(node.props.children)) {
      try {
        return findButton(child, label);
      } catch {
        // Continue searching siblings.
      }
    }
  }

  throw new Error(`Button not found: ${label}`);
}

describe('BoardColumnHeader', () => {
  test('calls Archive All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onArchive = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    const element = renderHeader(
      {
        status: 'done',
        label: 'Done',
        count: 1,
        onArchive,
      },
    );
    const button = findButton(element, 'Archive All');

    button.props.onClick?.({ type: 'click' });

    expect(receivedArg).toBeUndefined();
  });

  test('calls Done All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onCompleteAll = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    const element = renderHeader(
      {
        status: 'complete',
        label: 'Complete',
        count: 1,
        onCompleteAll,
      },
    );
    const button = findButton(element, 'Done All');

    button.props.onClick?.({ type: 'click' });

    expect(receivedArg).toBeUndefined();
  });

  test('calls Hide All without forwarding the click event', () => {
    let receivedArg: unknown = 'not-called';
    const onHideAllSessions = ((value?: unknown) => {
      receivedArg = value;
    }) as () => void;

    const element = renderHeader(
      {
        status: 'complete',
        label: 'Complete',
        count: 1,
        onHideAllSessions,
      },
    );
    const button = findButton(element, 'Hide All');

    button.props.onClick?.({ type: 'click' });

    expect(receivedArg).toBeUndefined();
  });

  test('renders the provided complete session collapse label', () => {
    const element = renderHeader(
      {
        status: 'complete',
        label: 'Complete',
        count: 1,
        hideAllSessionsLabel: 'Collapse All',
        onHideAllSessions: () => undefined,
      },
    );

    expect(getText(element)).toContain('Collapse All');
  });
});
