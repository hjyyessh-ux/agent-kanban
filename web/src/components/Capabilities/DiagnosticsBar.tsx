import type { ContextDiagnostics } from '../../../../src/core/types';

interface DiagnosticsBarProps {
  diagnostics: ContextDiagnostics;
}

export function DiagnosticsBar({ diagnostics }: DiagnosticsBarProps) {
  const {
    enableToolSearch,
    toolSearchEffective,
    runtimeSupportsToolSearch,
    userScopeMcpCount,
    alwaysLoadCount,
  } = diagnostics;

  const hasWarnings = alwaysLoadCount > 0 || !runtimeSupportsToolSearch || !toolSearchEffective;

  const etsLabel = enableToolSearch === 'unset' ? 'unset (auto-defer)' : enableToolSearch;

  return (
    <div className={`diag-bar${hasWarnings ? ' diag-bar--warn' : ''}`}>
      <div className="diag-bar-inner">
        <span className="diag-bar-label">진단</span>

        <span className={`diag-badge${toolSearchEffective ? ' diag-badge--ok' : ' diag-badge--danger'}`}>
          ENABLE_TOOL_SEARCH={etsLabel}
          {' · '}
          {toolSearchEffective
            ? 'MCP schema 지연 로딩 (startup ≈0 tok)'
            : '⚠ MCP schema 선로딩됨'}
        </span>

        {!runtimeSupportsToolSearch && (
          <span className="diag-badge diag-badge--danger">
            ⚠ 이 런타임은 tool-search 미지원 → MCP schema 전부 선로딩
          </span>
        )}

        <span className="diag-badge diag-badge--info">
          user-scope MCP {userScopeMcpCount}개
        </span>

        {alwaysLoadCount > 0 && (
          <span className="diag-badge diag-badge--danger diag-badge--headline">
            ⚡ alwaysLoad {alwaysLoadCount}개 (강제 선로딩)
          </span>
        )}
      </div>
    </div>
  );
}
