/** Human-facing order number, stable for a top-up: INX-2026-1A2B3C4D */
export function orderNumber(topUpId: string, createdAt: Date): string {
  return `INX-${createdAt.getUTCFullYear()}-${topUpId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
