/** Display formatting. Kept out of components so charts and tables agree. */

const FULL = new Intl.NumberFormat('en-GB');

/** 1,284 — for table cells and axis ticks. */
export const full = (value: number): string => FULL.format(Math.round(value));

/** 1,284 / 12.9K / 4.2M — for stat-tile and hero values. */
export const compact = (value: number): string => {
  const magnitude = Math.abs(value);
  if (magnitude < 10_000) return FULL.format(Math.round(value));
  if (magnitude < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

export const percent = (value: number | undefined, digits = 0): string =>
  value === undefined ? '—' : `${value.toFixed(digits)}%`;

/** Seconds to a compact human duration: 45s, 1m 23s, 1h 04m. */
export const duration = (seconds: number | undefined): string => {
  if (seconds === undefined || Number.isNaN(seconds)) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

/** "3h ago", "yesterday", "12 Mar" — coarse, glanceable recency. */
export const relativeTime = (iso: string | undefined): string => {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';

  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;

  const days = Math.floor(seconds / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;

  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/** Absolute timestamp for title attributes, so hover gives the precise value. */
export const exactTime = (iso: string | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB');
};

/**
 * Axis maxima rounded to 1/2/5 × 10^n so ticks land on clean numbers rather
 * than the raw data maximum.
 */
export const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  // A fine ladder rather than 1/2/5/10: a coarse one rounds 2,400 up to 5,000
  // and leaves the plot filling under half its height. Every step still halves
  // to a clean mid gridline.
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const step = steps.find((candidate) => normalised <= candidate) ?? 10;
  return step * magnitude;
};

/** Shorten a Plausible time bucket for an axis tick. */
export const bucketLabel = (raw: string): string => {
  // Hourly buckets arrive as "2026-08-04 13:00:00".
  const hour = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):/.exec(raw);
  if (hour) return `${hour[1]}:00`;

  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month) {
    return new Date(Number(month[1]), Number(month[2]) - 1, 1).toLocaleDateString(
      'en-GB',
      { month: 'short' },
    );
  }

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    return new Date(
      Number(day[1]),
      Number(day[2]) - 1,
      Number(day[3]),
    ).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  return raw;
};
