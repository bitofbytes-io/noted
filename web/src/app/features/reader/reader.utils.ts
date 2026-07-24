export function pageDeltaForKey(key: string): number {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(key)) return 1;
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) return -1;
  return 0;
}
