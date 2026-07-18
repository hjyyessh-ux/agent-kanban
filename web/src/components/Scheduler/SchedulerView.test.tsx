import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  SchedulerEntry,
  SchedulerRun,
} from '../../../../src/core/types';
import { RuntimeModelFields } from '../shared/RuntimeModelFields';
import {
  getInitialSchedulerScheduleInput,
  getSchedulerSchedulePreview,
  SchedulerActionFields,
  SchedulerCronPreview,
  SchedulerTimezoneNotice,
} from './SchedulerJobModal';
import { SchedulerHistoryRunCard } from './SchedulerHistoryPanel';
import { SchedulerEntryCard, SchedulerView } from './SchedulerView';

const promptEntry: SchedulerEntry = {
  id: 'scheduler-1',
  name: 'Daily digest',
  description: 'Summarize open work',
  cron: '0 9 * * 1-5',
  cronDescription: 'Weekdays at 9 AM',
  scheduleInput: {
    mode: 'cron',
    expression: '0 9 * * 1-5',
  },
  timezone: 'Asia/Seoul',
  status: 'active',
  action: {
    type: 'prompt',
    prompt: 'Summarize incidents',
    projectDir: '/workspace/project',
    agentRuntime: 'codex',
    model: 'gpt-5.6-sol',
  },
  nextRunAt: '2026-07-17T00:00:00.000Z',
  lastRunAt: '2026-07-16T23:50:00.000Z',
  lastRunStatus: 'success',
  history: [],
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
};

const bashEntry: SchedulerEntry = {
  ...promptEntry,
  id: 'scheduler-2',
  name: 'Nightly healthcheck',
  action: {
    type: 'bash',
    command: 'bun run scripts/healthcheck.ts',
    cwd: '/workspace/project',
  },
};

describe('SchedulerView kv2 scheduler UI', () => {
  test('renders KST note and prompt runtime/model summary in the list', () => {
    const html = renderToStaticMarkup(
      <SchedulerView
        entries={[promptEntry]}
        loading={false}
        error={null}
        onCreateEntry={async () => promptEntry}
        onUpdateEntry={async () => {}}
        onDeleteEntry={async () => {}}
        onToggleEntry={async () => {}}
        onRunEntry={async (): Promise<SchedulerRun> => ({
          id: 'run-1',
          schedulerId: promptEntry.id,
          startedAt: '2026-07-17T00:00:00.000Z',
          status: 'success',
        })}
        onRefresh={async () => {}}
        onClearError={() => {}}
      />,
    );

    expect(html).toContain('모든 일정은 Asia/Seoul (KST) 기준입니다.');
    expect(html).toContain('Prompt runtime / model');
    expect(html).toContain('Codex · gpt-5.6-sol');
    expect(html).toContain('Next run KST');
  });

  test('shows legacy prompt entries as edit-required', () => {
    const html = renderToStaticMarkup(
      <SchedulerEntryCard
        entry={{
          ...promptEntry,
          action: {
            ...promptEntry.action,
            editState: 'edit-required',
            legacy: {
              type: 'skill',
              skillName: 'legacy-review',
              skillInput: 'review',
            },
          },
          status: 'inactive',
        }}
        onToggleEntry={async () => {}}
        onRunEntry={async () => ({
          id: 'run-legacy',
          schedulerId: promptEntry.id,
          startedAt: '2026-07-17T00:00:00.000Z',
          status: 'fail',
        })}
        onEditEntry={() => {}}
        onDeleteEntry={() => {}}
        onOpenHistory={() => {}}
      />,
    );

    expect(html).toContain('편집 필요');
    expect(html).toContain('legacy skill에서 변환됨');
  });

  test('renders bash action-specific fields', () => {
    const html = renderToStaticMarkup(
      <SchedulerActionFields
        actionType="bash"
        command="bun run scripts/healthcheck.ts"
        cwd="/workspace/project"
        prompt=""
        projectDir=""
        runtime="opencode"
        model=""
        orderedRuntimes={[]}
        displayedModels={[]}
        codexReasoningEffort="medium"
        codexSandbox="workspace-write"
        codexSkipGitRepoCheck
        codexBypassApprovalsAndSandbox={false}
        claudePermissionMode="acceptEdits"
        claudeDangerouslySkipPermissions={false}
        disabled={false}
        onCommandChange={() => {}}
        onCwdChange={() => {}}
        onPromptChange={() => {}}
        onProjectDirChange={() => {}}
        onRuntimeChange={() => {}}
        onModelChange={() => {}}
        onCodexReasoningEffortChange={() => {}}
        onCodexSandboxChange={() => {}}
        onCodexSkipGitRepoCheckChange={() => {}}
        onCodexBypassApprovalsAndSandboxChange={() => {}}
        onClaudePermissionModeChange={() => {}}
        onClaudeDangerouslySkipPermissionsChange={() => {}}
      />,
    );

    expect(html).toContain('Bash command *');
    expect(html).toContain('Working directory');
    expect(html).not.toContain('Project directory');
  });

  test('renders prompt action-specific fields and filtered runtime models', () => {
    const fieldsHtml = renderToStaticMarkup(
      <SchedulerActionFields
        actionType="prompt"
        command=""
        cwd=""
        prompt="Summarize incidents"
        projectDir="/workspace/project"
        runtime="codex"
        model="gpt-5.6-sol"
        orderedRuntimes={[
          {
            runtime: 'codex',
            label: 'Codex',
            selection: 'model',
            models: [],
          },
          {
            runtime: 'claude',
            label: 'Claude',
            selection: 'model',
            models: [],
            disabled: true,
            available: false,
            unavailableReason: 'Missing CLI',
          },
        ]}
        displayedModels={[
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
        ]}
        codexReasoningEffort="medium"
        codexSandbox="workspace-write"
        codexSkipGitRepoCheck
        codexBypassApprovalsAndSandbox={false}
        claudePermissionMode="acceptEdits"
        claudeDangerouslySkipPermissions={false}
        disabled={false}
        onCommandChange={() => {}}
        onCwdChange={() => {}}
        onPromptChange={() => {}}
        onProjectDirChange={() => {}}
        onRuntimeChange={() => {}}
        onModelChange={() => {}}
        onCodexReasoningEffortChange={() => {}}
        onCodexSandboxChange={() => {}}
        onCodexSkipGitRepoCheckChange={() => {}}
        onCodexBypassApprovalsAndSandboxChange={() => {}}
        onClaudePermissionModeChange={() => {}}
        onClaudeDangerouslySkipPermissionsChange={() => {}}
      />,
    );

    expect(fieldsHtml).toContain('Agent prompt *');
    expect(fieldsHtml).toContain('Project directory');
    expect(fieldsHtml).toContain('Codex reasoning');
    expect(fieldsHtml).toContain('GPT-5.6-Sol');
    expect(fieldsHtml).toContain('Unavailable');
  });

  test('renders scheduler runtime selector cards without regressing shared runtime fields', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelFields
        runtime="codex"
        model="gpt-5.6-sol"
        orderedRuntimes={[
          {
            runtime: 'codex',
            label: 'Codex',
            selection: 'model',
            models: [],
          },
          {
            runtime: 'claude',
            label: 'Claude',
            selection: 'model',
            models: [],
          },
          {
            runtime: 'opencode',
            label: 'Opencode',
            selection: 'model',
            models: [],
          },
        ]}
        displayedModels={[
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
        ]}
        runtimeInputId="scheduler-runtime-group"
        modelInputId="scheduler-model-select"
        layoutVariant="scheduler"
        selectorVariant="cards"
        onRuntimeChange={() => {}}
        onModelChange={() => {}}
      />,
    );

    expect(html).toContain('runtime-model-fields--scheduler');
    expect(html).toContain('kv2-create-agent-chip--selector-card');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('✓');
  });

  test('renders cron preview copy for valid KST parse results', () => {
    const scheduleInput = { mode: 'cron', expression: '0 9 * * 1-5' } as const;
    const html = renderToStaticMarkup(
      <SchedulerCronPreview
        scheduleInput={scheduleInput}
        preview={getSchedulerSchedulePreview(scheduleInput)}
      />,
    );

    expect(html).toContain('Cron preview');
    expect(html).toContain('0 9 * * 1-5');
    expect(html).toContain('Every weekday at 09:00');
  });

  test('restores quick mode from stored cron when metadata is missing', () => {
    expect(getInitialSchedulerScheduleInput({
      ...promptEntry,
      scheduleInput: undefined,
      cron: '30 9 * * *',
    })).toEqual({
      mode: 'simple',
      simple: { repeat: 'daily', hour: 9, minute: 30 },
    });
  });

  test('renders history prompt runs as card links and bash runs with output', () => {
    const promptRunHtml = renderToStaticMarkup(
      <SchedulerHistoryRunCard
        entry={promptEntry}
        run={{
          id: 'run-prompt',
          schedulerId: promptEntry.id,
          startedAt: '2026-07-17T00:00:00.000Z',
          status: 'success',
          cardId: 'card-123',
        }}
        onOpenCard={() => {}}
      />,
    );
    const bashRunHtml = renderToStaticMarkup(
      <SchedulerHistoryRunCard
        entry={bashEntry}
        run={{
          id: 'run-bash',
          schedulerId: bashEntry.id,
          startedAt: '2026-07-17T00:00:00.000Z',
          finishedAt: '2026-07-17T00:00:03.000Z',
          status: 'success',
          exitCode: 0,
          stdout: 'ok',
        }}
      />,
    );

    expect(promptRunHtml).toContain('카드로 전달됨');
    expect(promptRunHtml).toContain('card-123');
    expect(bashRunHtml).toContain('Bash output');
    expect(bashRunHtml).toContain('Exit code');
    expect(bashRunHtml).toContain('ok');
  });

  test('shared runtime/model field component preserves filtered models only', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelFields
        runtime="codex"
        model="gpt-5.6-sol"
        orderedRuntimes={[
          {
            runtime: 'codex',
            label: 'Codex',
            selection: 'model',
            models: [],
          },
        ]}
        displayedModels={[
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
        ]}
        runtimeInputId="runtime-group"
        modelInputId="model-select"
        onRuntimeChange={() => {}}
        onModelChange={() => {}}
      />,
    );

    expect(html).toContain('GPT-5.6-Sol');
    expect(html).not.toContain('claude-opus-4-8');
  });

  test('timezone note component renders KST guidance', () => {
    const html = renderToStaticMarkup(<SchedulerTimezoneNotice />);
    expect(html).toContain('Asia/Seoul (KST)');
  });
});
