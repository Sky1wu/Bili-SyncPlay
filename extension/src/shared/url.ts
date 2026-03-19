import { normalizeBilibiliUrl } from "@bili-syncplay/protocol";

export function normalizeSharedVideoUrl(
  url: string | null | undefined,
): string | null {
  return normalizeBilibiliUrl(url);
}

export function areSharedVideoUrlsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeSharedVideoUrl(left);
  const normalizedRight = normalizeSharedVideoUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
