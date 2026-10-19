import { expandHomePath } from '../../utils/path';

export function normalizeConfiguredCLIPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  try {
    return expandHomePath(trimmed);
  } catch {
    return trimmed;
  }
}
