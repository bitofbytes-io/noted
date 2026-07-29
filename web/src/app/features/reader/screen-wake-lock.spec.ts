import { describe, expect, it, vi } from 'vitest';
import { ScreenWakeLock } from './screen-wake-lock';

class FakeDocument {
  visibilityState = 'visible';
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly registrations: Array<{ action: 'add' | 'remove'; type: string; capture: boolean }> = [];

  addEventListener(type: string, listener: () => void, capture = false): void {
    this.registrations.push({ action: 'add', type, capture });
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void, capture = false): void {
    this.registrations.push({ action: 'remove', type, capture });
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  setVisibility(visibility: 'visible' | 'hidden'): void {
    this.visibilityState = visibility;
    this.dispatch('visibilitychange');
  }
}

class FakeSentinel {
  readonly release = vi.fn(async (): Promise<void> => undefined);
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'release', listener: () => void): void {
    this.listeners.delete(listener);
  }

  systemRelease(): void {
    for (const listener of this.listeners) listener();
  }
}

describe('ScreenWakeLock', () => {
  it('requests one screen lock and suppresses duplicate starts and activity', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinel));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    wakeLock.start();
    document.dispatch('pointerdown');
    document.dispatch('keydown');
    await settlePromises();
    document.dispatch('pointerdown');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('observes pointer activation in capture phase and removes the matching listener', () => {
    const document = new FakeDocument();
    const wakeLock = new ScreenWakeLock(document, {});

    wakeLock.start();
    wakeLock.stop();

    expect(document.registrations).toContainEqual({
      action: 'add',
      type: 'pointerdown',
      capture: true,
    });
    expect(document.registrations).toContainEqual({
      action: 'remove',
      type: 'pointerdown',
      capture: true,
    });
  });

  it('silently ignores unsupported environments', () => {
    const document = new FakeDocument();
    const wakeLock = new ScreenWakeLock(document, {});

    expect(() => {
      wakeLock.start();
      document.dispatch('pointerdown');
      wakeLock.stop();
    }).not.toThrow();
  });

  it('silently ignores release failures', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    sentinel.release.mockRejectedValue(new Error('Release failed'));
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinel));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    expect(() => wakeLock.stop()).not.toThrow();
    await settlePromises();
  });

  it('retries a rejected request after reader interaction', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    let attempt = 0;
    const request = vi.fn((_type: 'screen') => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('User activation required'))
        : Promise.resolve(sentinel);
    });
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    document.dispatch('pointerdown');
    await settlePromises();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases when hidden and reacquires when visible', async () => {
    const document = new FakeDocument();
    const first = new FakeSentinel();
    const sentinels = [first, new FakeSentinel()];
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinels.shift()!));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    document.setVisibility('hidden');

    expect(first.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);

    document.setVisibility('visible');
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('waits for visibility or user activity before retrying a system release', async () => {
    const document = new FakeDocument();
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    const sentinels = [first, second];
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinels.shift()!));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    first.systemRelease();
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(1);

    document.dispatch('keydown');
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases on teardown and no longer responds to reader activity', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinel));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    wakeLock.stop();
    document.dispatch('pointerdown');
    document.setVisibility('hidden');
    document.setVisibility('visible');

    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('immediately releases a request that resolves after teardown', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    const pending = deferred<FakeSentinel>();
    const request = vi.fn((_type: 'screen') => pending.promise);
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    wakeLock.stop();
    pending.resolve(sentinel);
    await settlePromises();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale sentinel release clear a newer lock', async () => {
    const document = new FakeDocument();
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    const sentinels = [first, second];
    const request = vi.fn((_type: 'screen') => Promise.resolve(sentinels.shift()!));
    const wakeLock = new ScreenWakeLock(document, { wakeLock: { request } });

    wakeLock.start();
    await settlePromises();
    document.setVisibility('hidden');
    document.setVisibility('visible');
    await settlePromises();
    first.systemRelease();
    document.dispatch('pointerdown');

    expect(request).toHaveBeenCalledTimes(2);
    expect(second.release).not.toHaveBeenCalled();
  });
});

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
