import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { authFilesApi } from '@/services/api/authFiles';
import { usageApi } from '@/services/api';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { parseTimestampMs } from '@/utils/timestamp';
import {
  calculateCost,
  collectUsageDetails,
  extractLatencyMs,
  extractTotalTokens,
  formatDurationMs,
  formatUsd,
  LATENCY_SOURCE_FIELD,
  normalizeAuthIndex,
  type ModelPrice,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const MAX_RENDERED_EVENTS = 500;

interface LogSection {
  title: string;
  body: string;
}

const SECTION_HEADER_RE = /^=== (.+) ===$/;


function parseLogSections(text: string): LogSection[] {
  const lines = text.split('\n');
  const sections: LogSection[] = [];
  let currentTitle = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const match = SECTION_HEADER_RE.exec(line);
    if (match) {
      if (currentTitle || currentBody.length) {
        sections.push({ title: currentTitle, body: currentBody.join('\n') });
      }
      currentTitle = match[1];
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle || currentBody.length) {
    sections.push({ title: currentTitle, body: currentBody.join('\n') });
  }
  return sections;
}

type RequestEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  model: string;
  sourceKey: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  authIndex: string;
  failed: boolean;
  latencyMs: number | null;
  cost: number;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  modelPrices,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [authIndexFilter, setAuthIndexFilter] = useState(ALL_FILTER);
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

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    const baseRows = details
      .map((detail, index) => {
        const timestamp = detail.timestamp;
        const timestampMs =
          typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
            ? detail.__timestampMs
            : parseTimestampMs(timestamp);
        const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
        const sourceRaw = String(detail.source ?? '').trim();
        const authIndexRaw = detail.auth_index as unknown;
        const authIndex =
          authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
            ? '-'
            : String(authIndexRaw);
        const sourceInfo = resolveSourceDisplay(
          sourceRaw,
          authIndexRaw,
          sourceInfoMap,
          authFileMap
        );
        const source = sourceInfo.displayName;
        const sourceKey = sourceInfo.identityKey ?? `source:${sourceRaw || source}`;
        const sourceType = sourceInfo.type;
        const model = String(detail.__modelName ?? '').trim() || '-';
        const inputTokens = Math.max(toNumber(detail.tokens?.input_tokens), 0);
        const outputTokens = Math.max(toNumber(detail.tokens?.output_tokens), 0);
        const reasoningTokens = Math.max(toNumber(detail.tokens?.reasoning_tokens), 0);
        const cachedTokens = Math.max(
          Math.max(toNumber(detail.tokens?.cached_tokens), 0),
          Math.max(toNumber(detail.tokens?.cache_tokens), 0)
        );
        const totalTokens = Math.max(
          toNumber(detail.tokens?.total_tokens),
          extractTotalTokens(detail)
        );
        const latencyMs = extractLatencyMs(detail);
        const cost = calculateCost(detail, modelPrices);
        const requestId = detail.request_id ?? '';

        return {
          id: `${timestamp}-${model}-${sourceKey}-${authIndex}-${index}`,
          timestamp,
          timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
          timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
          model,
          sourceKey,
          sourceRaw: sourceRaw || '-',
          source,
          sourceType,
          authIndex,
          failed: detail.failed === true,
          latencyMs,
          cost,
          requestId,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          totalTokens,
        };
      });

    const sourceLabelKeyMap = new Map<string, Set<string>>();
    baseRows.forEach((row) => {
      const keys = sourceLabelKeyMap.get(row.source) ?? new Set<string>();
      keys.add(row.sourceKey);
      sourceLabelKeyMap.set(row.source, keys);
    });

    const buildDisambiguatedSourceLabel = (row: RequestEventRow) => {
      const labelKeyCount = sourceLabelKeyMap.get(row.source)?.size ?? 0;
      if (labelKeyCount <= 1) {
        return row.source;
      }

      if (row.authIndex !== '-') {
        return `${row.source} · ${row.authIndex}`;
      }

      if (row.sourceRaw !== '-' && row.sourceRaw !== row.source) {
        return `${row.source} · ${row.sourceRaw}`;
      }

      if (row.sourceType) {
        return `${row.source} · ${row.sourceType}`;
      }

      return `${row.source} · ${row.sourceKey}`;
    };

    return baseRows
      .map((row) => ({
        ...row,
        source: buildDisambiguatedSourceLabel(row),
      }))
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [authFileMap, i18n.language, modelPrices, sourceInfoMap, usage]);

  const hasLatencyData = useMemo(() => rows.some((row) => row.latencyMs !== null), [rows]);

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(() => {
    const optionMap = new Map<string, string>();
    rows.forEach((row) => {
      if (!optionMap.has(row.sourceKey)) {
        optionMap.set(row.sourceKey, row.source);
      }
    });

    return [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(optionMap.entries()).map(([value, label]) => ({
        value,
        label,
      })),
    ];
  }, [rows, t]);

  const authIndexOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.authIndex))).map((authIndex) => ({
        value: authIndex,
        label: authIndex,
      })),
    ],
    [rows, t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const authIndexOptionSet = useMemo(
    () => new Set(authIndexOptions.map((option) => option.value)),
    [authIndexOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveAuthIndexFilter = authIndexOptionSet.has(authIndexFilter)
    ? authIndexFilter
    : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.sourceKey === effectiveSourceFilter;
        const authIndexMatched =
          effectiveAuthIndexFilter === ALL_FILTER || row.authIndex === effectiveAuthIndexFilter;
        return modelMatched && sourceMatched && authIndexMatched;
      }),
    [effectiveAuthIndexFilter, effectiveModelFilter, effectiveSourceFilter, rows]
  );

  const renderedRows = useMemo(() => filteredRows.slice(0, MAX_RENDERED_EVENTS), [filteredRows]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveAuthIndexFilter !== ALL_FILTER;

  const [logModal, setLogModal] = useState<{
    open: boolean;
    requestId: string;
    content: string;
    loading: boolean;
    error: string | null;
  }>({ open: false, requestId: '', content: '', loading: false, error: null });
  const [expandedSection, setExpandedSection] = useState(-1);

  const handleViewLog = async (requestId: string) => {
    setLogModal({ open: true, requestId, content: '', loading: true, error: null });
    setExpandedSection(-1);
    try {
      const response = await usageApi.getRequestLog(requestId);
      const text = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
      setLogModal((prev) => ({ ...prev, content: text, loading: false }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setLogModal((prev) => ({ ...prev, error: message, loading: false }));
    }
  };

  const handleDownloadLog = () => {
    if (!logModal.content) return;
    downloadBlob({
      filename: `request-log-${logModal.requestId}.txt`,
      blob: new Blob([logModal.content], { type: 'text/plain;charset=utf-8' }),
    });
  };

  const logSections = useMemo(
    () => (logModal.content ? parseLogSections(logModal.content) : []),
    [logModal.content]
  );

  const handleCloseLogModal = () => {
    setLogModal((prev) => ({ ...prev, open: false }));
  };

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setAuthIndexFilter(ALL_FILTER);
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'auth_index',
      'result',
      ...(hasLatencyData ? ['latency_ms'] : []),
      'cost',
      'request_id',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'total_tokens',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.authIndex,
        row.failed ? 'failed' : 'success',
        ...(hasLatencyData ? [row.latencyMs ?? ''] : []),
        row.cost,
        row.requestId,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.totalTokens,
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      auth_index: row.authIndex,
      failed: row.failed,
      ...(hasLatencyData && row.latencyMs !== null ? { latency_ms: row.latencyMs } : {}),
      cost: row.cost || undefined,
      request_id: row.requestId || undefined,
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_auth_index')}
          </span>
          <Select
            value={effectiveAuthIndexFilter}
            options={authIndexOptions}
            onChange={setAuthIndexFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_auth_index')}
            fullWidth={false}
          />
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {hasLatencyData && <span className={styles.requestEventsLimitHint}>{latencyHint}</span>}
            {filteredRows.length > MAX_RENDERED_EVENTS && (
              <span className={styles.requestEventsLimitHint}>
                {t('usage_stats.request_events_limit_hint', {
                  shown: MAX_RENDERED_EVENTS,
                  total: filteredRows.length,
                })}
              </span>
            )}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('usage_stats.request_events_timestamp')}</th>
                  <th>{t('usage_stats.model_name')}</th>
                  <th>{t('usage_stats.request_events_source')}</th>
                  <th>{t('usage_stats.request_events_auth_index')}</th>
                  <th>{t('usage_stats.request_events_result')}</th>
                  {hasLatencyData && <th title={latencyHint}>{t('usage_stats.time')}</th>}
                  <th>{t('usage_stats.cost')}</th>
                  <th>{t('usage_stats.request_events_request_id')}</th>
                  <th>{t('usage_stats.input_tokens')}</th>
                  <th>{t('usage_stats.output_tokens')}</th>
                  <th>{t('usage_stats.reasoning_tokens')}</th>
                  <th>{t('usage_stats.cached_tokens')}</th>
                  <th>{t('usage_stats.total_tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    <td title={row.timestamp} className={styles.requestEventsTimestamp}>
                      {row.timestampLabel}
                    </td>
                    <td className={styles.modelCell}>{row.model}</td>
                    <td className={styles.requestEventsSourceCell} title={row.source}>
                      <span>{row.source}</span>
                      {row.sourceType && (
                        <span className={styles.credentialType}>{row.sourceType}</span>
                      )}
                    </td>
                    <td className={styles.requestEventsAuthIndex} title={row.authIndex}>
                      {row.authIndex}
                    </td>
                    <td>
                      <span
                        className={
                          row.failed
                            ? styles.requestEventsResultFailed
                            : styles.requestEventsResultSuccess
                        }
                      >
                        {row.failed ? t('stats.failure') : t('stats.success')}
                      </span>
                    </td>
                    {hasLatencyData && (
                      <td className={styles.durationCell}>{formatDurationMs(row.latencyMs)}</td>
                    )}
                    <td className={styles.costCell}>{row.cost > 0 ? formatUsd(row.cost) : '-'}</td>
                    <td>
                      {row.requestId ? (
                        <button
                          type="button"
                          className={styles.requestIdLink}
                          onClick={() => void handleViewLog(row.requestId)}
                          title={t('usage_stats.request_events_view_log')}
                        >
                          {row.requestId}
                        </button>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{row.reasoningTokens.toLocaleString()}</td>
                    <td>{row.cachedTokens.toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={logModal.open}
        title={t('usage_stats.request_log_modal_title', { id: logModal.requestId })}
        onClose={handleCloseLogModal}
        fullscreen
        headerActions={
          !logModal.loading && !logModal.error && logModal.content
            ? [
                {
                  icon: 'download' as const,
                  onClick: handleDownloadLog,
                  label: t('usage_stats.request_log_download'),
                },
              ]
            : undefined
        }
      >
        {logModal.loading ? (
          <div className={styles.logModalLoading}>{t('common.loading')}</div>
        ) : logModal.error ? (
          <div className={styles.logModalError}>{logModal.error}</div>
        ) : (
          <div className={styles.logSections}>
            {logSections.map((section, idx) => (
              <LogSectionView
                key={idx}
                section={section}
                collapsed={expandedSection !== idx}
                onToggle={() =>
                  setExpandedSection((prev) => (prev === idx ? -1 : idx))
                }
              />
            ))}
          </div>
        )}
      </Modal>
    </Card>
  );
}

function LogSectionView({
  section,
  collapsed,
  onToggle,
}: {
  section: LogSection;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [formatted, setFormatted] = useState(true);
  const bodyLines = section.body.split('\n').filter((l) => l !== '');
  const bodyBytes = new Blob([section.body]).size;

  return (
    <div className={styles.logSection}>
      <div className={styles.logSectionHeader}>
        <button className={styles.logSectionHeaderLeft} onClick={onToggle}>
          <span className={`${styles.logSectionChevron} ${collapsed ? '' : styles.logSectionChevronOpen}`}>
            ▶
          </span>
          <span className={styles.logSectionTitle}>{section.title}</span>
        </button>
        {!collapsed && (
          <span
            className={styles.logSectionFormatToggle}
            onClick={() => setFormatted((f) => !f)}
          >
            {formatted ? 'pretty' : 'raw'}
          </span>
        )}
        <span className={styles.logSectionLineCount}>{bodyBytes >= 1024 ? `${(bodyBytes / 1024).toFixed(1)} KB` : `${bodyBytes} B`}</span>
      </div>
      {!collapsed && (
        <div className={styles.logSectionBody}>
          {formatted ? (
            bodyLines.map((line, i) => (
              <FormattedLine key={i} line={line} />
            ))
          ) : (
            bodyLines.map((line, i) => (
              <LogLine key={i} line={line} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FormattedLine({ line }: { line: string }) {
  if (line.startsWith('event:')) {
    return (
      <div className={styles.logLine}>
        <span className={styles.logLineEvent}>event:</span>
        <span className={styles.logLineEventValue}>{line.slice(7)}</span>
      </div>
    );
  }
  if (line.startsWith('data:')) {
    const dataStr = line.slice(5).trim();
    try {
      const parsed = JSON.parse(dataStr);
      return (
        <div className={styles.logLine}>
          <span className={styles.logLineData}>data:</span>
          <YamlBlock value={parsed} />
        </div>
      );
    } catch {
      return (
        <div className={styles.logLine}>
          <span className={styles.logLineData}>data:</span>
          <span className={styles.logLineDataValue}>{dataStr}</span>
        </div>
      );
    }
  }
  if (line.startsWith('{') || line.startsWith('[')) {
    try {
      const parsed = JSON.parse(line);
      return <YamlBlock value={parsed} />;
    } catch {
      return <div className={styles.logLine}>{line}</div>;
    }
  }
  return <LogLine line={line} />;
}

function LogLine({ line }: { line: string }) {
  if (line.startsWith('event:')) {
    return (
      <div className={styles.logLine}>
        <span className={styles.logLineEvent}>event:</span>
        <span className={styles.logLineEventValue}>{line.slice(7)}</span>
      </div>
    );
  }
  if (line.startsWith('data:')) {
    return (
      <div className={styles.logLine}>
        <span className={styles.logLineData}>data:</span>
        <span className={styles.logLineDataValue}>{line.slice(6)}</span>
      </div>
    );
  }
  if (line.startsWith('Headers:') || line.startsWith('Body:')) {
    return <div className={styles.logLineSubHeader}>{line}</div>;
  }
  if (/^[A-Z][A-Za-z ]+:/.test(line)) {
    const colonIdx = line.indexOf(':');
    return (
      <div className={styles.logLine}>
        <span className={styles.logLineKey}>{line.slice(0, colonIdx + 1)}</span>
        <span>{line.slice(colonIdx + 1)}</span>
      </div>
    );
  }
  if (line.startsWith('{') || line.startsWith('[')) {
    return <div className={styles.logLine}>{line}</div>;
  }
  return <div className={styles.logLine}>{line}</div>;
}

type YamlToken =
  | { type: 'indent'; depth: number }
  | { type: 'key'; value: string }
  | { type: 'colon' }
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'bool'; value: string }
  | { type: 'null' }
  | { type: 'dash' }
  | { type: 'pipe' }
  | { type: 'literal-line'; value: string }
  | { type: 'fold-marker'; collapsed: boolean; count: number };

const TOP_LEVEL_KEY_ORDER = ['system', 'tools', 'messages'];

function jsonToYamlTokens(
  value: unknown,
  depth = 0,
  collapsedKeys?: Set<string>,
): YamlToken[][] {
  const ind = (d = depth) => [{ type: 'indent' as const, depth: d }];
  const lines: YamlToken[][] = [];

  if (value === null || value === undefined) {
    lines.push([...ind(), { type: 'null' }]);
    return lines;
  }
  if (typeof value === 'boolean') {
    lines.push([...ind(), { type: 'bool', value: String(value) }]);
    return lines;
  }
  if (typeof value === 'number') {
    lines.push([...ind(), { type: 'number', value: String(value) }]);
    return lines;
  }
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const allLines = value.split('\n');
      lines.push([...ind(), { type: 'pipe' }]);
      for (const line of allLines) {
        lines.push([{ type: 'indent', depth: depth + 1 }, { type: 'literal-line', value: line }]);
      }
    } else {
      lines.push([...ind(), { type: 'string', value }]);
    }
    return lines;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push([...ind(), { type: 'string', value: '[]' }]);
      return lines;
    }
    for (const item of value) {
      const inner = jsonToYamlTokens(item, depth);
      if (inner.length > 0) {
        const first = inner[0];
        lines.push([
          ...ind(depth > 0 ? depth - 1 : 0),
          { type: 'dash' },
          ...(first[0]?.type === 'indent' ? first.slice(1) : first),
        ]);
        lines.push(...inner.slice(1));
      }
    }
    return lines;
  }
  if (typeof value === 'object') {
    let entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push([...ind(), { type: 'string', value: '{}' }]);
      return lines;
    }
    if (depth === 0) {
      const ordered: [string, unknown][] = [];
      const tail: [string, unknown][] = [];
      for (const entry of entries) {
        if (TOP_LEVEL_KEY_ORDER.includes(entry[0])) {
          tail.push(entry);
        } else {
          ordered.push(entry);
        }
      }
      tail.sort(
        (a, b) =>
          TOP_LEVEL_KEY_ORDER.indexOf(a[0]) - TOP_LEVEL_KEY_ORDER.indexOf(b[0]),
      );
      entries = [...ordered, ...tail];
    }
    for (const [k, v] of entries) {
      const isCollapsed = collapsedKeys?.has(k) ?? false;
      if (typeof v === 'object' && v !== null) {
        lines.push([...ind(), { type: 'key', value: k }, { type: 'colon' }]);
        const inner = jsonToYamlTokens(v, depth + 1, collapsedKeys);
        if (isCollapsed) {
          lines.push([{ type: 'fold-marker', collapsed: true, count: inner.length }]);
        } else {
          lines.push(...inner);
        }
      } else if (typeof v === 'string' && v.includes('\n')) {
        lines.push([...ind(), { type: 'key', value: k }, { type: 'colon' }, { type: 'pipe' }]);
        if (isCollapsed) {
          const lineCount = v.split('\n').length;
          lines.push([{ type: 'fold-marker', collapsed: true, count: lineCount }]);
        } else {
          for (const line of v.split('\n')) {
            lines.push([
              ...ind(depth + 1),
              { type: 'literal-line', value: line },
            ]);
          }
        }
      } else {
        const valTokens = jsonToYamlTokens(v, 0);
        const firstLine = valTokens[0];
        if (firstLine) {
          const withoutIndent = firstLine[0]?.type === 'indent' ? firstLine.slice(1) : firstLine;
          lines.push([...ind(), { type: 'key', value: k }, { type: 'colon' }, ...withoutIndent]);
          lines.push(...valTokens.slice(1));
        }
      }
    }
    return lines;
  }
  lines.push([...ind(), { type: 'string', value: String(value) }]);
  return lines;
}

const COLLAPSED_BY_DEFAULT_KEYS = new Set(['system', 'tools']);
const MULTILINE_PREVIEW_LINES = 5;

function YamlBlock({ value }: { value: unknown }) {
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(
    () => new Set(COLLAPSED_BY_DEFAULT_KEYS),
  );
  const [expandedLiterals, setExpandedLiterals] = useState<Set<number>>(new Set());
  const allTokens = useMemo(
    () => jsonToYamlTokens(value, 0, collapsedKeys),
    [value, collapsedKeys],
  );

  const toggleKey = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleLiteral = useCallback((idx: number) => {
    setExpandedLiterals((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  // Identify consecutive literal-line runs and render with folding
  const rendered: React.ReactNode[] = [];
  let i = 0;
  while (i < allTokens.length) {
    const line = allTokens[i];
    const hasFold = line.some((t) => t.type === 'fold-marker');
    if (hasFold) {
      const marker = line.find((t) => t.type === 'fold-marker') as {
        type: 'fold-marker';
        collapsed: boolean;
        count: number;
      };
      if (marker.collapsed) {
        // Replace previous key line: "▶ key: ... N more lines"
        const lastIdx = rendered.length - 1;
        if (lastIdx >= 0) {
          const prevLine = i > 0 ? allTokens[i - 1] : [];
          const keyToken = prevLine.find((t) => t.type === 'key');
          const keyName = keyToken && 'value' in keyToken ? keyToken.value : '';
          rendered[lastIdx] = (
            <YamlLine
              key={`foldkey-${i}`}
              tokens={prevLine}
              suffix={
                <span
                  className={styles.yamlFoldToggle}
                  onClick={() => keyName && toggleKey(keyName)}
                >
                  ... {marker.count} more lines
                </span>
              }
            />
          );
        }
      }
      i++;
      continue;
    }
    // Check if this line starts a literal-line run
    const hasPipe = line.some((t) => t.type === 'pipe');
    if (hasPipe) {
      // Collect consecutive literal lines
      const runStart = i + 1;
      let runEnd = runStart;
      while (
        runEnd < allTokens.length &&
        allTokens[runEnd].some((t) => t.type === 'literal-line')
      ) {
        runEnd++;
      }
      const literalCount = runEnd - runStart;
      const isExpanded = expandedLiterals.has(runStart);
      const canFold = literalCount > MULTILINE_PREVIEW_LINES;
      // Render pipe line with toggle
      const pipeSuffix = canFold
        ? isExpanded
          ? <span className={styles.yamlFoldToggle} onClick={() => toggleLiteral(runStart)}>collapse</span>
          : <span className={styles.yamlFoldToggle} onClick={() => toggleLiteral(runStart)}>
              ... {literalCount - MULTILINE_PREVIEW_LINES} more lines
            </span>
        : undefined;
      rendered.push(
        <YamlLine key={i} tokens={line} suffix={pipeSuffix} />,
      );
      if (canFold && !isExpanded) {
        for (let j = runStart; j < runStart + MULTILINE_PREVIEW_LINES; j++) {
          rendered.push(<YamlLine key={j} tokens={allTokens[j]} />);
        }
      } else {
        for (let j = runStart; j < runEnd; j++) {
          rendered.push(<YamlLine key={j} tokens={allTokens[j]} />);
        }
      }
      i = runEnd;
      continue;
    }
    // Check if this is a key line that belongs to a collapsible section (currently expanded)
    const keyToken = line.find((t) => t.type === 'key');
    const keyName = keyToken && 'value' in keyToken ? (keyToken as { type: 'key'; value: string }).value : '';
    const isCollapsibleKey = COLLAPSED_BY_DEFAULT_KEYS.has(keyName) && !collapsedKeys.has(keyName);
    if (isCollapsibleKey) {
      rendered.push(
        <YamlLine
          key={i}
          tokens={line}
          suffix={
            <span
              className={styles.yamlFoldToggle}
              onClick={() => toggleKey(keyName)}
            >
              collapse
            </span>
          }
        />,
      );
    } else {
      rendered.push(<YamlLine key={i} tokens={line} />);
    }
    i++;
  }

  return <div className={styles.yamlBlock}>{rendered}</div>;
}

function YamlLine({
  tokens,
  suffix,
}: {
  tokens: YamlToken[];
  suffix?: React.ReactNode;
}) {
  return (
    <div className={styles.logLine}>
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case 'indent':
            return <span key={i}>{'  '.repeat(tok.depth)}</span>;
          case 'key':
            return (
              <span key={i} className={styles.yamlKey}>
                {tok.value}
              </span>
            );
          case 'colon':
            return <span key={i}>{': '}</span>;
          case 'string':
            return (
              <span key={i} className={styles.yamlString}>
                {needsQuote(tok.value) ? JSON.stringify(tok.value) : tok.value}
              </span>
            );
          case 'number':
            return (
              <span key={i} className={styles.yamlNumber}>
                {tok.value}
              </span>
            );
          case 'bool':
            return (
              <span key={i} className={styles.yamlBool}>
                {tok.value}
              </span>
            );
          case 'null':
            return (
              <span key={i} className={styles.yamlNull}>
                null
              </span>
            );
          case 'dash':
            return (
              <span key={i} className={styles.yamlDash}>
                -{' '}
              </span>
            );
          case 'pipe':
            return (
              <span key={i} className={styles.yamlPipe}>
                |
              </span>
            );
          case 'literal-line':
            return (
              <span key={i} className={styles.yamlLiteral}>
                {tok.value}
              </span>
            );
          case 'fold-marker':
            return null;
        }
      })}
      {suffix}
    </div>
  );
}

function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (/[:\{\}\[\],&\*#\?|\-<>=!%@\\]/.test(s)) return true;
  if (s === 'true' || s === 'false' || s === 'null') return true;
  if (/^\d/.test(s)) return true;
  if (s.includes('\n')) return true;
  return false;
}
