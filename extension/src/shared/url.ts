import { normalizeBilibiliUrl } from "@bili-syncplay/protocol";

const NORMALIZE_CACHE_CAPACITY = 16;
const normalizeCache = new Map<string, string | null>();

export function normalizeSharedVideoUrl(
  url: string | null | undefined,
): string | null {
  if (!url) {
    return null;
  }
  if (normalizeCache.has(url)) {
    const cached = normalizeCache.get(url)!;
    // Refresh to most-recently-used position
    normalizeCache.delete(url);
    normalizeCache.set(url, cached);
    return cached;
  }
  const result = normalizeBilibiliUrl(url);
  if (normalizeCache.size >= NORMALIZE_CACHE_CAPACITY) {
    normalizeCache.delete(normalizeCache.keys().next().value!);
  }
  normalizeCache.set(url, result);
  return result;
}

export function areSharedVideoUrlsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeSharedVideoUrl(left);
  const normalizedRight = normalizeSharedVideoUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
