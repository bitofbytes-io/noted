import { describe, expect, it, vi } from 'vitest';
import { ImportAsset, PageEdit } from '../../core/models';
import {
  PreparedPageCache,
  ProcessingWorkerClient,
  measureAsync,
  preparedPhotoKey,
} from './prepare-processing';

const source: ImportAsset = {
  id: 'source-one',
  filename: 'private-name.jpg',
  mime: 'image/jpeg',
  size: 123,
  checksum: 'abc123',
  pageCount: 1,
  width: 100,
  height: 200,
};

function page(overrides: Partial<PageEdit> = {}): PageEdit {
  return { id: 'page-one', sourceId: source.id, page: 0, ...overrides };
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  reply(data: object): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe('preparedPhotoKey', () => {
  it('normalizes semantic defaults and excludes ids and order', () => {
    const first = preparedPhotoKey(source, page());
    const renamedSource = { ...source, id: 'replacement-id', filename: 'other.jpg' };
    const equivalent = page({
      id: 'different-page-id',
      sourceId: renamedSource.id,
      rotation: 360,
      angle: 0,
      scale: 1,
      margins: [0, 0, 0, 0],
      crop: [0, 0, 1, 1],
      paperCleanupStrength: 0,
    });

    expect(preparedPhotoKey(renamedSource, equivalent)).toBe(first);
  });

  it('changes for source content, page number, and semantic edits', () => {
    const original = preparedPhotoKey(source, page());

    expect(preparedPhotoKey({ ...source, checksum: 'new' }, page())).not.toBe(original);
    expect(preparedPhotoKey(source, page({ page: 1 }))).not.toBe(original);
    expect(preparedPhotoKey(source, page({ paperCleanupStrength: 0.4 }))).not.toBe(original);
    expect(
      preparedPhotoKey(
        source,
        page({
          corners: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        }),
      ),
    ).not.toBe(original);
  });

  it('ignores fixed-canvas fields when fitEdges makes them inactive', () => {
    const fitted = page({ fitEdges: true, angle: 1 });
    const staleLegacyFields = page({
      fitEdges: true,
      angle: 1,
      x: 0.3,
      y: -0.2,
      scale: 2,
      outputWidth: 500,
      outputHeight: 700,
    });

    expect(preparedPhotoKey(source, staleLegacyFields)).toBe(preparedPhotoKey(source, fitted));
  });
});

describe('PreparedPageCache', () => {
  it('enforces byte and entry limits and refreshes recently read entries', () => {
    const cache = new PreparedPageCache(2, 8);
    cache.set('a', new ArrayBuffer(4));
    cache.set('b', new ArrayBuffer(4));
    expect(cache.get('a')).toBeDefined();
    cache.set('c', new ArrayBuffer(4));

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.bytes).toBe(8);

    cache.set('too-large', new ArrayBuffer(9));
    expect(cache.has('too-large')).toBe(false);
  });

  it('removes transferred entries with take', () => {
    const cache = new PreparedPageCache();
    cache.set('page', new ArrayBuffer(5));

    expect(cache.take('page')?.byteLength).toBe(5);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('measureAsync', () => {
  it('records overlapping calls without clearing another invocation marks', async () => {
    const name = 'noted.test.overlapping';
    performance.clearMeasures(name);
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = measureAsync(name, () => new Promise<void>((resolve) => (finishFirst = resolve)));
    const second = measureAsync(
      name,
      () => new Promise<void>((resolve) => (finishSecond = resolve)),
    );

    finishSecond();
    await second;
    finishFirst();
    await first;

    expect(performance.getEntriesByName(name, 'measure')).toHaveLength(2);
    performance.clearMeasures(name);
  });
});

describe('ProcessingWorkerClient', () => {
  it('keeps a completed worker warm and routes exact request ids', async () => {
    const workers: FakeWorker[] = [];
    const client = new ProcessingWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });

    const first = client.run({ kind: 'preview' });
    const firstID = workers[0].postMessage.mock.calls[0][0].requestId;
    workers[0].reply({ requestId: 'stale', blob: new Blob() });
    expect(client.activeRequest).toBe(true);
    workers[0].reply({ requestId: firstID, blob: new Blob() });
    await first;

    const second = client.run({ kind: 'build' });
    const secondID = workers[0].postMessage.mock.calls[1][0].requestId;
    workers[0].reply({ requestId: secondID, bytes: new ArrayBuffer(1) });
    await second;

    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it('accepts a legacy response without a request id', async () => {
    const worker = new FakeWorker();
    const client = new ProcessingWorkerClient(() => worker as unknown as Worker);
    const request = client.run({ kind: 'build' });

    worker.reply({ bytes: new ArrayBuffer(2) });

    expect((await request).bytes?.byteLength).toBe(2);
  });

  it('discards a worker after an operation error', async () => {
    const workers: FakeWorker[] = [];
    const client = new ProcessingWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const failed = client.run({ kind: 'preview' });
    const requestID = workers[0].postMessage.mock.calls[0][0].requestId;
    workers[0].reply({ requestId: requestID, error: 'bad page' });

    await expect(failed).rejects.toThrow('bad page');
    expect(workers[0].terminate).toHaveBeenCalledOnce();

    const retry = client.run({ kind: 'preview' });
    const retryID = workers[1].postMessage.mock.calls[0][0].requestId;
    workers[1].reply({ requestId: retryID, blob: new Blob() });
    await retry;
    expect(workers).toHaveLength(2);
  });

  it('terminates and rejects superseded, cancelled, and destroyed work', async () => {
    const workers: FakeWorker[] = [];
    const client = new ProcessingWorkerClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = client.run({ kind: 'preview' });
    const second = client.run({ kind: 'build' });
    await expect(first).rejects.toMatchObject({ reason: 'superseded' });
    expect(workers[0].terminate).toHaveBeenCalledOnce();

    client.cancel();
    await expect(second).rejects.toMatchObject({ reason: 'cancelled' });
    const third = client.run({ kind: 'preview' });
    client.destroy();
    await expect(third).rejects.toMatchObject({ reason: 'destroyed' });
    await expect(client.run({ kind: 'build' })).rejects.toMatchObject({ reason: 'destroyed' });
  });
});
