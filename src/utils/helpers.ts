export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
