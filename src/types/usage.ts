/**
 * 使用统计相关类型
 * 基于原项目 src/modules/usage.js
 */

// 时间段类型
export type TimePeriod = 'hour' | 'day';

// 数据点
export interface DataPoint {
  timestamp: string;
  value: number;
}

// 模型使用统计
export interface ModelUsage {
  modelName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

// 使用统计数据
export interface UsageStats {
  overview: {
    totalRequests: number;
    totalTokens: number;
    totalCost: number;
  };
  requestsData: {
    hour: DataPoint[];
    day: DataPoint[];
  };
  tokensData: {
    hour: DataPoint[];
    day: DataPoint[];
  };
  costData: {
    hour: DataPoint[];
    day: DataPoint[];
  };
  modelStats: ModelUsage[];
}

// 限制器指标配置与当前值
export interface LimitMetrics {
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  price?: number;
}

// 限制器配置
export interface LimitConfig extends LimitMetrics {
  window?: number;
  models?: string[];
}

// 限制器条目
export interface LimitEntry {
  source?: string;
  auth_index?: string;
  config?: LimitConfig;
  current?: LimitMetrics;
}

// 模型价格
export interface ModelPrice {
  modelName: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
}
