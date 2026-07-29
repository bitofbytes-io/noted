interface WakeLockSentinelLike {
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
  release(): Promise<void>;
}

interface WakeLockProviderLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

interface WakeLockDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
}

/** Owns a best-effort screen wake lock for one active reader session. */
export class ScreenWakeLock {
  private readonly provider?: WakeLockProviderLike;
  private active = false;
  private generation = 0;
  private pendingGeneration?: number;
  private sentinel?: WakeLockSentinelLike;
  private sentinelReleaseListener?: () => void;

  private readonly onVisibilityChange = (): void => {
    if (this.document.visibilityState === 'visible') {
      this.acquire();
      return;
    }
    this.invalidatePendingRequest();
    this.releaseHeldLock();
  };

  private readonly onReaderActivity = (): void => this.acquire();

  constructor(
    private readonly document: WakeLockDocumentLike = globalThis.document,
    navigatorValue: unknown = globalThis.navigator,
  ) {
    this.provider = wakeLockProvider(navigatorValue);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.document.addEventListener('pointerdown', this.onReaderActivity, true);
    this.document.addEventListener('keydown', this.onReaderActivity);
    this.acquire();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.document.removeEventListener('pointerdown', this.onReaderActivity, true);
    this.document.removeEventListener('keydown', this.onReaderActivity);
    this.invalidatePendingRequest();
    this.releaseHeldLock();
  }

  private acquire(): void {
    if (
      !this.active ||
      this.document.visibilityState !== 'visible' ||
      !this.provider ||
      this.sentinel ||
      this.pendingGeneration !== undefined
    ) {
      return;
    }

    const generation = ++this.generation;
    this.pendingGeneration = generation;
    let request: Promise<WakeLockSentinelLike>;
    try {
      request = this.provider.request('screen');
    } catch {
      this.pendingGeneration = undefined;
      return;
    }

    void request.then(
      (sentinel) => this.acceptSentinel(generation, sentinel),
      () => {
        if (this.pendingGeneration === generation) this.pendingGeneration = undefined;
      },
    );
  }

  private acceptSentinel(generation: number, sentinel: WakeLockSentinelLike): void {
    if (this.pendingGeneration === generation) this.pendingGeneration = undefined;
    if (
      generation !== this.generation ||
      !this.active ||
      this.document.visibilityState !== 'visible' ||
      this.sentinel
    ) {
      releaseSilently(sentinel);
      return;
    }

    const releaseListener = (): void => {
      if (this.sentinel !== sentinel) return;
      this.removeSentinelListener(sentinel, releaseListener);
      this.sentinel = undefined;
      this.sentinelReleaseListener = undefined;
    };

    try {
      sentinel.addEventListener('release', releaseListener);
    } catch {
      releaseSilently(sentinel);
      return;
    }
    this.sentinel = sentinel;
    this.sentinelReleaseListener = releaseListener;
  }

  private invalidatePendingRequest(): void {
    this.generation += 1;
    this.pendingGeneration = undefined;
  }

  private releaseHeldLock(): void {
    const sentinel = this.sentinel;
    const listener = this.sentinelReleaseListener;
    this.sentinel = undefined;
    this.sentinelReleaseListener = undefined;
    if (!sentinel) return;
    if (listener) this.removeSentinelListener(sentinel, listener);
    releaseSilently(sentinel);
  }

  private removeSentinelListener(sentinel: WakeLockSentinelLike, listener: () => void): void {
    try {
      sentinel.removeEventListener('release', listener);
    } catch {
      // A broken release event implementation must not affect score reading.
    }
  }
}

function wakeLockProvider(value: unknown): WakeLockProviderLike | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const wakeLock = (value as { wakeLock?: unknown }).wakeLock;
    if (typeof wakeLock !== 'object' || wakeLock === null) return undefined;
    if (typeof (wakeLock as { request?: unknown }).request !== 'function') return undefined;
    return wakeLock as WakeLockProviderLike;
  } catch {
    return undefined;
  }
}

function releaseSilently(sentinel: WakeLockSentinelLike): void {
  try {
    void sentinel.release().catch(() => undefined);
  } catch {
    // Wake locking is an optional enhancement and release failures are harmless.
  }
}
