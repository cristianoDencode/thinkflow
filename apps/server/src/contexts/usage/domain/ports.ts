/** One aggregation bucket: counters are added to the row of (day, provider, model, source). */
export interface UsageEntry {
  day: string;
  providerId: string;
  model: string;
  source: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estimatedRequests: number;
}

export interface UsageRepository {
  record(entry: UsageEntry): Promise<void>;
  /** All buckets of a 'YYYY-MM' month. */
  monthRows(month: string): Promise<UsageEntry[]>;
  /** Total tokens per day (only days with data) between two day keys, inclusive. */
  dailyTotals(fromDay: string, toDay: string): Promise<{ day: string; totalTokens: number }[]>;
  /** Months ('YYYY-MM') that have data. */
  months(): Promise<string[]>;
  pruneBefore(day: string): Promise<void>;
}

/** Where the optional monthly token budget lives. */
export interface BudgetSource {
  getMonthlyTokens(): number;
  setMonthlyTokens(tokens: number): void;
}
