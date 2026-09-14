let timingSequence = 0;

export async function measureAsync<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (typeof performance === 'undefined' || !performance.mark || !performance.measure)
    return work();
  const invocation = ++timingSequence;
  const start = `${name}:start:${invocation}`;
  const end = `${name}:end:${invocation}`;
  performance.mark(start);
  try {
    return await work();
  } finally {
    performance.mark(end);
    performance.measure(name, start, end);
    performance.clearMarks(start);
    performance.clearMarks(end);
  }
}
