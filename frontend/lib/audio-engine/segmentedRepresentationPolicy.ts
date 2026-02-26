const CHUNK_REPRESENTATION_PATTERN = /^chunk-(.+)-\d+\.(?:m4s|webm)$/i;
const INIT_REPRESENTATION_PATTERN = /^init-(.+)\.(?:m4s|webm)$/i;

const stripQueryAndHash = (value: string): string => value.split(/[?#]/, 1)[0];

const normalizeToken = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const resolveSegmentAssetNameFromUri = (uri: string): string | null => {
  const normalizedUri = normalizeToken(uri);
  if (!normalizedUri) {
    return null;
  }

  const pathOnly = stripQueryAndHash(normalizedUri);
  const finalSegment = pathOnly.slice(pathOnly.lastIndexOf("/") + 1);
  return normalizeToken(finalSegment);
};

export const resolveSegmentRepresentationIdFromName = (
  segmentName: string,
): string | null => {
  const normalizedSegmentName = normalizeToken(segmentName);
  if (!normalizedSegmentName) {
    return null;
  }

  const chunkMatch = normalizedSegmentName.match(CHUNK_REPRESENTATION_PATTERN);
  if (chunkMatch) {
    return normalizeToken(chunkMatch[1]);
  }

  const initMatch = normalizedSegmentName.match(INIT_REPRESENTATION_PATTERN);
  if (initMatch) {
    return normalizeToken(initMatch[1]);
  }

  return null;
};

export const resolveSegmentRepresentationIdFromUri = (
  uri: string,
): string | null => {
  const segmentName = resolveSegmentAssetNameFromUri(uri);
  if (!segmentName) {
    return null;
  }
  return resolveSegmentRepresentationIdFromName(segmentName);
};
