export function escapeHtml(value: unknown): string {
  const normalized = typeof value === "string" ? value : value == null ? "" : String(value);
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
