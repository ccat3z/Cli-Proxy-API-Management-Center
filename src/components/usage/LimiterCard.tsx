import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig, LimitEntry } from '@/types';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { formatUsd, normalizeAuthIndex, normalizeUsageSourceId } from '@/utils/usage';
import { authFilesApi } from '@/services/api/authFiles';
import { useEffect, useState } from 'react';
import type { AuthFileItem } from '@/types/authFile';
import styles from '@/pages/UsagePage.module.scss';

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

function formatWindow(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

const LIMIT_METRICS = [
  { key: 'input_tokens', labelKey: 'usage_stats.limiter_input_tokens', format: 'tokens' },
  { key: 'output_tokens', labelKey: 'usage_stats.limiter_output_tokens', format: 'tokens' },
  { key: 'cache_tokens', labelKey: 'usage_stats.limiter_cache_tokens', format: 'tokens' },
  { key: 'price', labelKey: 'usage_stats.limiter_price', format: 'price' },
] as const;

export interface LimiterCardProps {
  limits: LimitEntry[];
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

export function LimiterCard({
  limits,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: LimiterCardProps) {
  const { t } = useTranslation();
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;
    authFilesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return;
        const map = new Map<string, CredentialInfo>();
        files.forEach((file) => {
          const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (!key) return;
          map.set(key, {
            name: file.name || key,
            type: (file.type || file.provider || '').toString(),
          });
        });
        setAuthFileMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, vertexConfigs]
  );

  if (loading && limits.length === 0) {
    return (
      <Card title={t('usage_stats.limiter_title')}>
        <div className={styles.hint}>{t('common.loading')}</div>
      </Card>
    );
  }

  if (limits.length === 0) {
    return (
      <Card title={t('usage_stats.limiter_title')}>
        <EmptyState
          title={t('usage_stats.limiter_no_limits')}
          description=""
        />
      </Card>
    );
  }

  return (
    <Card title={t('usage_stats.limiter_title')}>
      <div className={styles.limiterSection}>
        {limits.map((limit, idx) => {
          const entry = limit;
          const sourceRaw = normalizeUsageSourceId(entry.source);
          const authIndexRaw = entry.auth_index;
          const sourceInfo = resolveSourceDisplay(sourceRaw, authIndexRaw, sourceInfoMap, authFileMap);
          const models = entry.config?.models;
          const isAllModels = !models || (Array.isArray(models) && models.length === 0);
          const windowSec = toNumber(entry.config?.window);

          const metrics = LIMIT_METRICS.filter((m) => {
            const cfgVal = toNumber(entry.config?.[m.key]);
            return cfgVal > 0;
          });

          return (
            <div key={idx} className={styles.limiterItem}>
              <div className={styles.limiterHeader}>
                <span className={styles.limiterSource}>{sourceInfo.displayName}</span>
                {authIndexRaw && (
                  <span className={styles.limiterAuthIndex}>{authIndexRaw}</span>
                )}
                <span className={styles.limiterTag}>
                  {isAllModels
                    ? t('usage_stats.limiter_all_models')
                    : models!.join(', ')}
                </span>
                {windowSec > 0 && (
                  <span className={styles.limiterTag}>
                    {t('usage_stats.limiter_window')}: {formatWindow(windowSec)}
                  </span>
                )}
              </div>
              <div className={styles.limiterBars}>
                {metrics.map((m) => {
                  const cfgVal = toNumber(entry.config?.[m.key]);
                  const curVal = toNumber(entry.current?.[m.key]);
                  const pct = cfgVal > 0 ? Math.min((curVal / cfgVal) * 100, 100) : 0;
                  const fillClass =
                    pct >= 90
                      ? styles.limiterBarFillHigh
                      : pct >= 70
                        ? styles.limiterBarFillMedium
                        : styles.limiterBarFillLow;
                  const fmtVal = (v: number, fmt: string) =>
                    fmt === 'price' ? formatUsd(v) : v.toLocaleString();
                  return (
                    <div key={m.key} className={styles.limiterBarRow}>
                      <span className={styles.limiterBarLabel}>{t(m.labelKey)}</span>
                      <div className={styles.limiterBar}>
                        <div
                          className={`${styles.limiterBarFill} ${fillClass}`}
                          style={{ width: `${Math.round(pct)}%` }}
                        />
                      </div>
                      <span className={styles.limiterBarValues}>
                        {fmtVal(curVal, m.format)} / {fmtVal(cfgVal, m.format)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
