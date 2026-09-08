import { useEffect, useState } from 'react';
import type { WikiConfigDto } from '../../../src/core/types';
import { fetchWikiConfig } from './useWikiApi';

/** Only mounted for a Work whose cards have been bulk-archived. */
export function useWorkWikiConfig() {
  const [config, setConfig] = useState<WikiConfigDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchWikiConfig()
      .then(value => { if (!cancelled) setConfig(value); })
      .catch(() => { if (!cancelled) setError('Wiki 디렉토리를 불러오지 못했습니다.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { config, error, loading };
}
