export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function listeningUrlError(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  if (candidate.length > 2000) return 'listening URL must be at most 2000 characters';
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) return '';
  } catch {
    // The shared validation message below is more useful than the browser's parser error.
  }
  return 'listening URL must be an http or https URL';
}
