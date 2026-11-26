export function formatMicros(micros: number | undefined) {
  return `$${(Number(micros ?? 0) / 1_000_000).toFixed(4)}`;
}

export function normalizeSeoKeywords(value: string) {
  return [...new Set(
    value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  )].slice(0, 30);
}

export function pageCount(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}
