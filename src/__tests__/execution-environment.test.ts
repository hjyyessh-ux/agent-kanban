import { describe, expect, test } from 'bun:test';
import { SettingsStore } from '../core/settings-store';
import {
  buildExecutionEnvironment,
  capExecutionOutput,
  parameterEnvironmentKey,
  redactSecrets,
} from '../core/execution-environment';
import { withTempDir } from './setup';

describe('execution environment', () => {
  test('merges settings and typed parameters without allowing reserved collisions', async () => {
    await withTempDir(async (dir) => {
      const settingsStore = new SettingsStore(dir);
      await settingsStore.createEntry({
        key: 'DEPLOY_REGION', value: 'ap-northeast-2', description: 'region', masked: false,
      });
      await settingsStore.createEntry({
        key: 'DEPLOY_TOKEN', value: 'settings-secret', description: 'token',
      });
      await settingsStore.createEntry({
        key: 'PATH', value: '/attacker/bin', description: 'must not replace PATH',
      });
      await settingsStore.createEntry({
        key: 'AK_PARAM_TARGET', value: 'settings-injection', description: 'must not replace a parameter',
      });

      const result = await buildExecutionEnvironment({
        settingsStore,
        baseEnv: { PATH: '/usr/bin', HOME: '/safe/home', AK_PARAM_STALE: 'previous-run' },
        parameterValues: {
          target: 'production', retryCount: 3, dry_run: false, token: 'parameter-secret',
        },
        secretParameterKeys: new Set(['token']),
      });

      expect(result.env).toMatchObject({
        PATH: '/usr/bin',
        HOME: '/safe/home',
        DEPLOY_REGION: 'ap-northeast-2',
        DEPLOY_TOKEN: 'settings-secret',
        AK_PARAM_TARGET: 'production',
        AK_PARAM_RETRY_COUNT: '3',
        AK_PARAM_DRY_RUN: 'false',
        AK_PARAM_TOKEN: 'parameter-secret',
      });
      expect(result.ignoredSettingKeys).toEqual(['PATH', 'AK_PARAM_TARGET']);
      expect(result.env.AK_PARAM_STALE).toBeUndefined();
      expect(result.secretValues).toEqual(expect.arrayContaining(['settings-secret', 'parameter-secret']));
    });
  });

  test('normalizes parameter names and redacts every occurrence of secret values', () => {
    expect(parameterEnvironmentKey('deployTarget')).toBe('AK_PARAM_DEPLOY_TARGET');
    expect(parameterEnvironmentKey('retry_count')).toBe('AK_PARAM_RETRY_COUNT');
    expect(redactSecrets('before s3cr3t middle s3cr3t after', ['s3cr3t']))
      .toBe('before [REDACTED] middle [REDACTED] after');
  });

  test('rejects parameter names that normalize to the same environment key', async () => {
    await expect(buildExecutionEnvironment({
      baseEnv: {},
      parameterValues: { deployTarget: 'one', deploy_target: 'two' },
    })).rejects.toThrow('Script parameter environment collision');
    await expect(buildExecutionEnvironment({
      baseEnv: {},
      parameterValues: { unsafe: 'null\0byte' },
    })).rejects.toThrow('Script parameter contains a null byte: unsafe');
  });

  test('caps multibyte output by UTF-8 bytes', () => {
    const suffix = '\n... (truncated)';
    const capped = capExecutionOutput('가'.repeat(5000))!;
    expect(capped.endsWith(suffix)).toBe(true);
    expect(Buffer.byteLength(capped.slice(0, -suffix.length), 'utf8')).toBeLessThanOrEqual(8192);
  });
});
