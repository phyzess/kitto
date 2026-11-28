import type { ModelPricing } from './routing-catalog.ts';

export type UtcDayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type PricingWindowLabel = 'peak' | 'off-peak';
export type PricingLabel = PricingWindowLabel | 'standard';

export interface PricingTimeWindow {
  days: readonly UtcDayOfWeek[];
  startMinuteUtc: number;
  endMinuteUtc: number;
  multiplier: number;
  label: PricingWindowLabel;
}

export interface PricingSchedule {
  id: string;
  models: readonly string[];
  windows: readonly PricingTimeWindow[];
  defaultMultiplier: number;
  defaultLabel: 'off-peak' | 'standard';
  boundaryBufferMinutes: number;
}

export interface RemoteMultiplierHint {
  factor?: number;
  utcStart?: string;
  utcEnd?: string;
  utcDays?: readonly number[];
}

export interface PricingWindowEvaluation {
  scheduleId: string | null;
  label: PricingLabel;
  currentMultiplier: number;
  effectiveMultiplier: number;
  enteringPeakSoon: boolean;
  minutesUntilChange: number | null;
  reason: string;
}

export interface RouteCostEstimate {
  usd: number;
  longContextApplied: boolean;
  multiplier: number;
  freshInputRate: number;
  cachedInputRate: number;
  outputRate: number;
}

const WEEKDAYS: readonly UtcDayOfWeek[] = [1, 2, 3, 4, 5];
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

export const DEEPSEEK_PEAK_UTC_SCHEDULE: PricingSchedule = {
  id: 'deepseek-peak-utc',
  models: ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4-pro'],
  windows: [
    { days: WEEKDAYS, startMinuteUtc: 60, endMinuteUtc: 240, multiplier: 2, label: 'peak' },
    { days: WEEKDAYS, startMinuteUtc: 360, endMinuteUtc: 600, multiplier: 2, label: 'peak' },
  ],
  defaultMultiplier: 1,
  defaultLabel: 'off-peak',
  boundaryBufferMinutes: 15,
};

export const BUILTIN_PRICING_SCHEDULES: readonly PricingSchedule[] = [DEEPSEEK_PEAK_UTC_SCHEDULE];

interface PeakWindow {
  days: readonly UtcDayOfWeek[] | null;
  startMinuteUtc: number;
  endMinuteUtc: number;
  multiplier: number;
  holidayAware: boolean;
}

interface EvaluateOptions {
  expectedDurationMinutes?: number;
  boundaryBufferMinutes?: number;
  schedules?: readonly PricingSchedule[];
  holidayOverrides?: readonly string[];
  remoteMultipliers?: readonly RemoteMultiplierHint[];
}

const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function utcDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

const minuteOfDayUtc = (timestampMs: number): number => {
  const date = new Date(timestampMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};

const dayOfWeekUtc = (timestampMs: number): UtcDayOfWeek => new Date(timestampMs).getUTCDay() as UtcDayOfWeek;

function parseUtcClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function remotePeakWindows(hints: readonly RemoteMultiplierHint[] | undefined): PeakWindow[] {
  const windows: PeakWindow[] = [];
  for (const hint of hints ?? []) {
    const start = parseUtcClock(hint.utcStart);
    const end = parseUtcClock(hint.utcEnd);
    if (start === null || end === null || end <= start || !finitePositive(hint.factor)) continue;
    const days = Array.isArray(hint.utcDays)
      ? hint.utcDays.filter((day): day is UtcDayOfWeek => Number.isInteger(day) && day >= 0 && day <= 6)
      : null;
    windows.push({ days, startMinuteUtc: start, endMinuteUtc: end, multiplier: hint.factor, holidayAware: false });
  }
  return windows;
}

function staticRemoteMultiplier(hints: readonly RemoteMultiplierHint[] | undefined): number {
  let product = 1;
  for (const hint of hints ?? []) {
    const timed = hint.utcStart !== undefined || hint.utcEnd !== undefined;
    if (!timed && finitePositive(hint.factor) && hint.factor > 1) product *= hint.factor;
  }
  return product;
}

function scheduleWindows(schedule: PricingSchedule): PeakWindow[] {
  return schedule.windows.map((window) => ({
    days: window.days,
    startMinuteUtc: window.startMinuteUtc,
    endMinuteUtc: window.endMinuteUtc,
    multiplier: window.multiplier,
    holidayAware: true,
  }));
}

function activeWindows(windows: readonly PeakWindow[], timestampMs: number, holidays: ReadonlySet<string>): PeakWindow[] {
  const day = dayOfWeekUtc(timestampMs);
  const minute = minuteOfDayUtc(timestampMs);
  const holiday = holidays.has(utcDateKey(timestampMs));
  return windows.filter(
    (window) =>
      (!window.holidayAware || !holiday) &&
      (window.days === null || window.days.includes(day)) &&
      minute >= window.startMinuteUtc &&
      minute < window.endMinuteUtc,
  );
}

function nextPeak(
  windows: readonly PeakWindow[],
  nowMs: number,
  holidays: ReadonlySet<string>,
): { minutes: number; multiplier: number } | null {
  const firstMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  for (let offset = 1; offset <= MINUTES_PER_WEEK; offset++) {
    const active = activeWindows(windows, firstMinute + (offset - 1) * 60_000, holidays);
    if (active.length) return { minutes: offset, multiplier: Math.max(...active.map((window) => window.multiplier)) };
  }
  return null;
}

function offPeakReason(timestampMs: number, holiday: boolean): string {
  if (holiday) return 'holiday-override';
  const day = dayOfWeekUtc(timestampMs);
  return day === 0 || day === 6 ? 'weekend-off-peak' : 'weekday-off-peak';
}

export function evaluatePricingWindow(canonicalModel: string, nowMs: number, options: EvaluateOptions = {}): PricingWindowEvaluation {
  if (!Number.isFinite(nowMs)) {
    return {
      scheduleId: null,
      label: 'standard',
      currentMultiplier: 1,
      effectiveMultiplier: 1,
      enteringPeakSoon: false,
      minutesUntilChange: null,
      reason: 'invalid-timestamp',
    };
  }
  const model = canonicalModel.toLowerCase();
  const schedules = options.schedules ?? BUILTIN_PRICING_SCHEDULES;
  const schedule = schedules.find((candidate) => candidate.models.some((entry) => entry.toLowerCase() === model)) ?? null;
  const holidays = new Set(options.holidayOverrides ?? []);
  const remoteTimed = remotePeakWindows(options.remoteMultipliers);
  const windows = [...(schedule ? scheduleWindows(schedule) : []), ...remoteTimed];
  const scheduleId = schedule?.id ?? (remoteTimed.length ? 'remote-multiplier' : null);

  if (!windows.length) {
    const staticFactor = staticRemoteMultiplier(options.remoteMultipliers);
    if (staticFactor > 1) {
      return {
        scheduleId: 'remote-multiplier',
        label: 'peak',
        currentMultiplier: staticFactor,
        effectiveMultiplier: staticFactor,
        enteringPeakSoon: false,
        minutesUntilChange: null,
        reason: 'remote-static-multiplier',
      };
    }
    return {
      scheduleId: null,
      label: 'standard',
      currentMultiplier: 1,
      effectiveMultiplier: 1,
      enteringPeakSoon: false,
      minutesUntilChange: null,
      reason: 'no-time-window-pricing',
    };
  }

  const current = activeWindows(windows, nowMs, holidays);
  const currentMinute = minuteOfDayUtc(nowMs);
  if (current.length) {
    const multiplier = Math.max(...current.map((window) => window.multiplier));
    const endMinute = Math.min(...current.filter((window) => window.multiplier === multiplier).map((window) => window.endMinuteUtc));
    return {
      scheduleId,
      label: 'peak',
      currentMultiplier: multiplier,
      effectiveMultiplier: multiplier,
      enteringPeakSoon: false,
      minutesUntilChange: Math.max(0, endMinute - currentMinute),
      reason: 'in-peak-window',
    };
  }

  const lookaheadMinutes = Math.max(
    options.boundaryBufferMinutes ?? schedule?.boundaryBufferMinutes ?? 0,
    options.expectedDurationMinutes ?? 0,
  );
  const upcoming = nextPeak(windows, nowMs, holidays);
  const holiday = holidays.has(utcDateKey(nowMs));
  const defaultMultiplier = schedule?.defaultMultiplier ?? 1;
  const enteringPeakSoon = upcoming !== null && upcoming.minutes <= lookaheadMinutes;
  const minutesUntilChange = upcoming !== null && (enteringPeakSoon || upcoming.minutes <= MINUTES_PER_DAY) ? upcoming.minutes : null;
  return {
    scheduleId,
    label: 'off-peak',
    currentMultiplier: defaultMultiplier,
    effectiveMultiplier: enteringPeakSoon && upcoming ? upcoming.multiplier : defaultMultiplier,
    enteringPeakSoon,
    minutesUntilChange,
    reason: enteringPeakSoon ? 'entering-peak-window-soon' : offPeakReason(nowMs, holiday),
  };
}

function priceTripleValid(triple: readonly number[]): boolean {
  return triple.length === 3 && triple.every(finiteNonnegative);
}

export function estimateRouteCostUsd(
  pricing: ModelPricing,
  tokens: { input: number; output: number; cacheHitRatio?: number; promptTokens?: number },
  multiplier?: number,
): RouteCostEstimate | null {
  const effectiveMultiplier = multiplier ?? 1;
  const cacheHitRatio = tokens.cacheHitRatio ?? 0;
  if (!finiteNonnegative(tokens.input) || !finiteNonnegative(tokens.output) || !finitePositive(effectiveMultiplier)) return null;
  if (!Number.isFinite(cacheHitRatio) || cacheHitRatio < 0 || cacheHitRatio > 1) return null;
  if (!priceTripleValid(pricing.base) || !priceTripleValid(pricing.long)) return null;
  const longContextApplied = (tokens.promptTokens ?? tokens.input) > pricing.longContextThreshold;
  const [freshInputRate, cachedInputRate, outputRate] = longContextApplied ? pricing.long : pricing.base;
  const freshInput = tokens.input * (1 - cacheHitRatio);
  const cachedInput = tokens.input * cacheHitRatio;
  const usd =
    ((freshInput * freshInputRate + cachedInput * cachedInputRate + tokens.output * outputRate) * effectiveMultiplier) / 1_000_000;
  return { usd, longContextApplied, multiplier: effectiveMultiplier, freshInputRate, cachedInputRate, outputRate };
}
