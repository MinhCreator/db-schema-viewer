export function generateId(): string {
  // randomUUID only exists in secure contexts; plain-HTTP deployments fall back to Math.random.
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2, 9);
  return `${Date.now()}-${random}`;
}

export const TABLE_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f43f5e", // rose
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export function getTableColor(index: number): string {
  return TABLE_COLORS[index % TABLE_COLORS.length]!;
}
