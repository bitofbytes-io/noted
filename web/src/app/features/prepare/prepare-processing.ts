import { ImportAsset, PageEdit } from '../../core/models';

const PREPARED_KEY_VERSION = 'prepared-photo-v1';
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function finite(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value!.toFixed(6)) : fallback;
}

function vector(value: number[] | undefined, fallback: number[]): number[] {
  return fallback.map((item, index) => finite(value?.[index], item));
}

function points(value: number[][] | undefined): number[][] {
  return (value ?? []).map((point) => [finite(point[0]), finite(point[1])]);
}

/** Whether preparation changes the page image or its output canvas. */
export function hasPageAdjustments(edit: PageEdit): boolean {
  const differs = (value: number | undefined, original: number) =>
    finite(value, original) !== original;
  const crop = vector(edit.crop, [0, 0, 1, 1]);
  const corners = points(edit.corners);
  const fullCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  return (
    differs(edit.angle, 0) ||
    ((finite(edit.rotation) % 360) + 360) % 360 !== 0 ||
    (edit.paperCleanupStrength ?? (edit.paperCleanup ? 1 : 0)) > 0 ||
    vector(edit.margins, [0, 0, 0, 0]).some((value) => value !== 0) ||
    crop.some((value, index) => value !== [0, 0, 1, 1][index]) ||
    (corners.length > 0 &&
      (corners.length !== 4 ||
        corners.some((point, index) =>
          point.some((value, axis) => value !== fullCorners[index][axis]),
        ))) ||
    (!edit.fitEdges &&
      (differs(edit.scale, 1) ||
        differs(edit.x, 0) ||
        differs(edit.y, 0) ||
        differs(edit.outputWidth, 0) ||
        differs(edit.outputHeight, 0)))
  );
}

export function preparedPhotoKey(source: ImportAsset, edit: PageEdit): string {
  const strength = edit.paperCleanupStrength ?? (edit.paperCleanup ? 1 : 0);
  const rotation = ((finite(edit.rotation) % 360) + 360) % 360;
  const fitEdges = Boolean(edit.fitEdges);
  return JSON.stringify([
    PREPARED_KEY_VERSION,
    source.checksum,
    source.mime,
    edit.page,
    finite(strength),
    rotation,
    finite(edit.angle),
    fitEdges ? 0 : finite(edit.x),
    fitEdges ? 0 : finite(edit.y),
    fitEdges ? 1 : finite(edit.scale || 1),
    fitEdges,
    vector(edit.margins, [0, 0, 0, 0]),
    vector(edit.crop, [0, 0, 1, 1]),
    points(edit.corners),
    fitEdges ? 0 : finite(edit.outputWidth),
    fitEdges ? 0 : finite(edit.outputHeight),
  ]);
}

export class PreparedPageCache {
  private readonly entries = new Map<string, ArrayBuffer>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: ArrayBuffer): void {
    this.delete(key);
    if (value.byteLength > this.maxBytes || this.maxEntries < 1) return;
    this.entries.set(key, value);
    this.totalBytes += value.byteLength;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (!value) return false;
    this.totalBytes -= value.byteLength;
    return this.entries.delete(key);
  }

  take(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value) this.delete(key);
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

export type ProcessingStopReason = 'cancelled' | 'superseded' | 'destroyed';

export class ProcessingStoppedError extends Error {
  constructor(readonly reason: ProcessingStopReason) {
    super(
      reason === 'superseded'
        ? 'Processing superseded.'
        : reason === 'destroyed'
          ? 'Processing stopped.'
          : 'Processing cancelled.',
    );
    this.name = 'ProcessingStoppedError';
  }
}

export function isProcessingStopped(error: unknown): error is ProcessingStoppedError {
  return error instanceof ProcessingStoppedError;
}

export interface ProcessingResponse {
  requestId?: string;
  progress?: string;
  bytes?: ArrayBuffer;
  result?: unknown;
  blob?: Blob;
  width?: number;
  height?: number;
  error?: string;
}

interface ActiveRequest {
  id: string;
  resolve: (response: ProcessingResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: string) => void;
}

type WorkerFactory = () => Worker;

export class ProcessingWorkerClient {
  private worker?: Worker;
  private active?: ActiveRequest;
  private destroyed = false;

  constructor(private readonly workerFactory: WorkerFactory) {}

  get activeRequest(): boolean {
    return this.active !== undefined;
  }

  run(
    payload: Record<string, unknown>,
    options: { transfer?: Transferable[]; onProgress?: (progress: string) => void } = {},
  ): Promise<ProcessingResponse> {
    if (this.destroyed) return Promise.reject(new ProcessingStoppedError('destroyed'));
    if (this.active) this.stopActive('superseded');
    const worker = this.ensureWorker();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.active = { id, resolve, reject, onProgress: options.onProgress };
      try {
        worker.postMessage({ ...payload, requestId: id }, options.transfer ?? []);
      } catch (error) {
        this.active = undefined;
        this.releaseWorker();
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }

  cancel(): void {
    this.stopActive('cancelled');
  }

  supersede(): void {
    this.stopActive('superseded');
  }

  destroy(): void {
    this.destroyed = true;
    if (this.active) this.stopActive('destroyed');
    else this.releaseWorker();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.onmessage = ({ data }: MessageEvent<ProcessingResponse>) => this.receive(worker, data);
    worker.onerror = () => {
      if (this.worker !== worker) return;
      const active = this.active;
      this.active = undefined;
      this.releaseWorker();
      active?.reject(Error('Page processing could not start. Please reload.'));
    };
    this.worker = worker;
    return worker;
  }

  private receive(worker: Worker, response: ProcessingResponse): void {
    const active = this.active;
    if (this.worker !== worker || !active) return;
    // requestId-less replies are accepted for the old worker test fixtures only.
    if (response.requestId !== undefined && response.requestId !== active.id) return;
    if (response.progress) {
      active.onProgress?.(response.progress);
      return;
    }
    if (!('bytes' in response || 'result' in response || 'blob' in response || 'error' in response))
      return;
    this.active = undefined;
    if (response.error) {
      this.releaseWorker();
      active.reject(Error(response.error));
    } else active.resolve(response);
  }

  private stopActive(reason: ProcessingStopReason): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.releaseWorker();
    active.reject(new ProcessingStoppedError(reason));
  }

  private releaseWorker(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }
}
