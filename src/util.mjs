// Small, dependency-free helpers shared across modules.
import crypto from 'crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function shortId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function round(n) {
  return typeof n === 'number' && !Number.isNaN(n) ? Math.round(n) : null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))];
}

export function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (clean.length === 0) return { count: 0, avg: null, min: null, max: null, p75: null, p90: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
  return {
    count: clean.length,
    avg: round(avg),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}
