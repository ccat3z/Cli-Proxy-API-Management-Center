import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { providersApi } from '@/services/api';
import { useThemeStore, useConfigStore } from '@/stores';
import type { OpenAIProviderConfig } from '@/types';
import {
  StatCards,
  UsageChart,
  ChartLineSelector,
  ApiDetailsCard,
  ModelStatsCard,
  PriceSettingsCard,
  CredentialStatsCard,
  RequestEventsDetailsCard,
  TokenBreakdownChart,
  CostTrendChart,
  ServiceHealthCard,
  LimiterCard,
  useUsageData,
  useSparklines,
  useChartData
} from '@/components/usage';
import {
  getModelNamesFromUsage,
  getApiStats,
  getModelStats,
  type UsageTimeRange
} from '@/utils/usage';
import styles from './UsagePage.module.scss';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const CHART_LINES_STORAGE_KEY = 'cli-proxy-usage-chart-lines-v1';
const TIME_RANGE_STORAGE_KEY = 'cli-proxy-usage-time-range-v2';
const DEFAULT_CHART_LINES = ['all'];
const DEFAULT_TIME_RANGE: UsageTimeRange = '1d';
const MAX_CHART_LINES = 9;
const TIME_RANGE_OPTIONS: ReadonlyArray<{ value: UsageTimeRange; labelKey: string }> = [
  { value: '1h', labelKey: 'usage_stats.range_1h' },
  { value: '3h', labelKey: 'usage_stats.range_3h' },
  { value: '12h', labelKey: 'usage_stats.range_12h' },
  { value: '1d', labelKey: 'usage_stats.range_1d' },
  { value: '7d', labelKey: 'usage_stats.range_7d' },
];
const HOUR_WINDOW_BY_TIME_RANGE: Record<UsageTimeRange, number> = {
  '1h': 1,
  '3h': 3,
  '12h': 12,
  '1d': 24,
  '7d': 7 * 24,
};

const isUsageTimeRange = (value: unknown): value is UsageTimeRange =>
  value === '1h' || value === '3h' || value === '12h' || value === '1d' || value === '7d';

const normalizeChartLines = (value: unknown, maxLines = MAX_CHART_LINES): string[] => {
  if (!Array.isArray(value)) {
    return DEFAULT_CHART_LINES;
  }

  const filtered = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxLines);

  return filtered.length ? filtered : DEFAULT_CHART_LINES;
};

const loadChartLines = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CHART_LINES;
    }
    const raw = localStorage.getItem(CHART_LINES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_CHART_LINES;
    }
    return normalizeChartLines(JSON.parse(raw));
  } catch {
    return DEFAULT_CHART_LINES;
  }
};

const loadTimeRange = (): UsageTimeRange => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_TIME_RANGE;
    }
    const raw = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return isUsageTimeRange(raw) ? raw : DEFAULT_TIME_RANGE;
  } catch {
    return DEFAULT_TIME_RANGE;
  }
};

export function UsagePage() {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isDark = resolvedTheme === 'dark';
  const config = useConfigStore((state) => state.config);
  const openaiCompatibilityConfig = config?.openaiCompatibility;
  const [openaiProvidersWithAuthIndex, setOpenaiProvidersWithAuthIndex] = useState<{
    source: OpenAIProviderConfig[] | undefined;
    providers: OpenAIProviderConfig[];
  } | null>(null);

  // Time range state
  const [chartLines, setChartLines] = useState<string[]>(loadChartLines);
  const [timeRange, setTimeRange] = useState<UsageTimeRange>(loadTimeRange);

  const windowHours = HOUR_WINDOW_BY_TIME_RANGE[timeRange];

  // Data hook — pass windowHours so the API fetches server-side filtered data
  const {
    usage,
    limits,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    setModelPrices,
    loadUsage
  } = useUsageData(windowHours);

  useHeaderRefresh(loadUsage);

  useEffect(() => {
    let cancelled = false;
    const source = openaiCompatibilityConfig;

    providersApi
      .getOpenAIProviders()
      .then((providers) => {
        if (cancelled) return;
        setOpenaiProvidersWithAuthIndex({ source, providers: providers || [] });
      })
      .catch(() => {
        if (cancelled) return;
        setOpenaiProvidersWithAuthIndex(null);
      });

    return () => {
      cancelled = true;
    };
  }, [openaiCompatibilityConfig]);

  const openaiProviderState = openaiProvidersWithAuthIndex;
  const openaiProvidersForUsage =
    openaiProviderState && openaiProviderState.source === openaiCompatibilityConfig
      ? openaiProviderState.providers
      : openaiCompatibilityConfig ?? [];

  const timeRangeOptions = useMemo(
    () =>
      TIME_RANGE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: t(opt.labelKey)
      })),
    [t]
  );

  const handleChartLinesChange = useCallback((lines: string[]) => {
    setChartLines(normalizeChartLines(lines));
  }, []);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(CHART_LINES_STORAGE_KEY, JSON.stringify(chartLines));
    } catch {
      // Ignore storage errors.
    }
  }, [chartLines]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, timeRange);
    } catch {
      // Ignore storage errors.
    }
  }, [timeRange]);

  const nowMs = lastRefreshedAt?.getTime() ?? 0;

  // Sparklines hook
  const {
    requestsSparkline,
    tokensSparkline,
    rpmSparkline,
    tpmSparkline,
    costSparkline
  } = useSparklines({ usage, loading, nowMs, modelPrices });

  // Chart data hook
  const {
    requestsPeriod,
    setRequestsPeriod,
    tokensPeriod,
    setTokensPeriod,
    requestsChartData,
    tokensChartData,
    requestsChartOptions,
    tokensChartOptions
  } = useChartData({ usage, chartLines, isDark, isMobile, hourWindowHours: windowHours });

  // Derived data
  const modelNames = useMemo(() => getModelNamesFromUsage(usage), [usage]);
  const apiStats = useMemo(
    () => getApiStats(usage, modelPrices),
    [usage, modelPrices]
  );
  const modelStats = useMemo(
    () => getModelStats(usage, modelPrices),
    [usage, modelPrices]
  );

  return (
    <div className={styles.container}>
      {loading && !usage && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <h1 className={styles.pageTitle}>{t('usage_stats.title')}</h1>
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeGroup}>
            <span className={styles.timeRangeLabel}>{t('usage_stats.range_filter')}</span>
            <Select
              value={timeRange}
              options={timeRangeOptions}
              onChange={(value) => setTimeRange(value as UsageTimeRange)}
              className={styles.timeRangeSelectControl}
              ariaLabel={t('usage_stats.range_filter')}
              fullWidth={false}
            />
          </div>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {/* Stats Overview Cards */}
      <StatCards
        usage={usage}
        loading={loading}
        modelPrices={modelPrices}
        nowMs={nowMs}
        sparklines={{
          requests: requestsSparkline,
          tokens: tokensSparkline,
          rpm: rpmSparkline,
          tpm: tpmSparkline,
          cost: costSparkline
        }}
      />

      {/* Chart Line Selection */}
      <ChartLineSelector
        chartLines={chartLines}
        modelNames={modelNames}
        maxLines={MAX_CHART_LINES}
        onChange={handleChartLinesChange}
      />

      {/* Service Health */}
      <ServiceHealthCard usage={usage} loading={loading} windowHours={windowHours} timeRange={timeRange} />

      {/* Charts Grid */}
      <div className={styles.chartsGrid}>
        <UsageChart
          title={t('usage_stats.requests_trend')}
          period={requestsPeriod}
          onPeriodChange={setRequestsPeriod}
          chartData={requestsChartData}
          chartOptions={requestsChartOptions}
          loading={loading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
        <UsageChart
          title={t('usage_stats.tokens_trend')}
          period={tokensPeriod}
          onPeriodChange={setTokensPeriod}
          chartData={tokensChartData}
          chartOptions={tokensChartOptions}
          loading={loading}
          isMobile={isMobile}
          emptyText={t('usage_stats.no_data')}
        />
      </div>

      {/* Token Breakdown Chart */}
      <TokenBreakdownChart
        usage={usage}
        loading={loading}
        isDark={isDark}
        isMobile={isMobile}
        hourWindowHours={windowHours}
      />

      {/* Cost Trend Chart */}
      <CostTrendChart
        usage={usage}
        loading={loading}
        isDark={isDark}
        isMobile={isMobile}
        modelPrices={modelPrices}
        hourWindowHours={windowHours}
      />

      {/* Details Grid */}
      <div className={styles.detailsGrid}>
        <ApiDetailsCard apiStats={apiStats} loading={loading} />
        <ModelStatsCard modelStats={modelStats} loading={loading} />
      </div>

      <LimiterCard
        limits={limits}
        loading={loading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={openaiProvidersForUsage}
      />

      <RequestEventsDetailsCard
        usage={usage}
        loading={loading}
        modelPrices={modelPrices}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={openaiProvidersForUsage}
      />

      {/* Credential Stats */}
      <CredentialStatsCard
        usage={usage}
        loading={loading}
        geminiKeys={config?.geminiApiKeys || []}
        claudeConfigs={config?.claudeApiKeys || []}
        codexConfigs={config?.codexApiKeys || []}
        vertexConfigs={config?.vertexApiKeys || []}
        openaiProviders={openaiProvidersForUsage}
      />

      {/* Price Settings — hidden: cost now provided by API */}
      <div style={{ display: 'none' }}>
        <PriceSettingsCard
          modelNames={modelNames}
          modelPrices={modelPrices}
          onPricesChange={setModelPrices}
        />
      </div>
    </div>
  );
}
