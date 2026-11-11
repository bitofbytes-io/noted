import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDraft, PageEdit } from '../../core/models';
import {
  PreparedPageCache,
  ProcessingStoppedError,
  ProcessingWorkerClient,
  preparedPhotoKey,
} from './prepare-processing';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { PrepareApiMock, createPrepareFixture, draft, pdfSource, photo } from './prepare-testing';

describe('PrepareTransfer save', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, store, api, openWindow } = await createPrepareFixture());
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  const workerClient = () => Reflect.get(store.preview, 'workerClient') as ProcessingWorkerClient;
  const showPdfPage = () =>
    store.draft.set({
      ...structuredClone(draft),
      sources: [pdfSource],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: pdfSource.id, page: 0 }] },
    });

  it('aligns mixed cached and uncached pages for final assembly', async () => {
    const edited: PageEdit = {
      id: 'edited',
      sourceId: photo.id,
      page: 0,
      paperCleanupStrength: 0.5,
    };
    const missPhoto = { ...photo, id: 'miss-photo', checksum: 'miss-checksum' };
    const miss: PageEdit = {
      id: 'miss',
      sourceId: missPhoto.id,
      page: 0,
      paperCleanupStrength: 0.25,
    };
    store.draft.set({
      ...structuredClone(draft),
      sources: [photo, missPhoto],
      manifest: { version: 1, pages: [miss, edited, { ...miss, id: 'miss-again' }] },
    });
    store.preview.reconcileKeys();
    const key = preparedPhotoKey(photo, edited);
    const cache = Reflect.get(store.preview, 'preparedPages') as PreparedPageCache;
    cache.set(key, new ArrayBuffer(4));
    const run = vi.spyOn(workerClient(), 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });

    await store.transfer.save();

    const payload = run.mock.calls[0][0] as {
      prepared: { key: string; bytes: ArrayBuffer }[];
      preparedKeys: string[];
      manifest: { pages: PageEdit[] };
    };
    const missKey = preparedPhotoKey(missPhoto, miss);
    expect(payload.preparedKeys).toEqual([missKey, key, missKey]);
    expect(payload.manifest.pages.map((page) => page.id)).toEqual(['miss', 'edited', 'miss-again']);
    expect(payload.prepared).toHaveLength(1);
    expect(payload.prepared[0].key).toBe(key);
    expect(api.finalizeImport).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(['/reader', 'piece-one']);
  });

  it('locks metadata after flushing the latest revision for finalization', async () => {
    showPdfPage();
    store.step.set('details');
    api.updateImport.mockImplementationOnce((value: ImportDraft) =>
      of({ ...value, revision: 2, updatedAt: '2026-09-19T12:00:00Z' }),
    );
    store.updateMetadata('title', 'Latest persisted title');

    let finishBuild!: (response: { bytes: ArrayBuffer }) => void;
    const run = vi
      .spyOn(workerClient(), 'run')
      .mockReturnValue(new Promise((resolve) => (finishBuild = resolve)));

    const saving = store.transfer.save();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('.details-form input') as HTMLInputElement;
    expect(title.disabled).toBe(true);
    store.updateMetadata('composer', 'Blocked edit');
    expect(store.draft()?.metadata.composer).toBe('');
    expect(api.updateImport).toHaveBeenCalledOnce();

    finishBuild({ bytes: new ArrayBuffer(10) });
    await saving;

    expect(api.finalizeImport).toHaveBeenCalledOnce();
    const finalizedDraft = api.finalizeImport.mock.calls[0][0] as ImportDraft;
    expect(finalizedDraft.revision).toBe(2);
    expect(finalizedDraft.metadata.title).toBe('Latest persisted title');
    expect(finalizedDraft.metadata.composer).toBe('');
    expect(store.finalizing()).toBe(false);
  });

  it('retains the draft when finalization fails', async () => {
    showPdfPage();
    vi.spyOn(workerClient(), 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });
    api.finalizeImport.mockReturnValueOnce(throwError(() => new Error('Finalization failed.')));

    await store.transfer.save();

    expect(store.error()).toBe('Finalization failed.');
    expect(store.draft()?.id).toBe(draft.id);
    expect(store.busy()).toBe(false);
    expect(store.finalizing()).toBe(false);
    expect(navigate).not.toHaveBeenCalledWith(['/reader', expect.anything()]);
  });

  it('keeps draft controls locked until cancelled final processing unwinds', async () => {
    showPdfPage();
    let rejectBuild!: (reason: Error) => void;
    const client = workerClient();
    vi.spyOn(client, 'run').mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBuild = reject;
      }),
    );
    vi.spyOn(client, 'cancel').mockImplementation(() =>
      rejectBuild(new ProcessingStoppedError('cancelled')),
    );

    const saving = store.transfer.save();
    await vi.waitFor(() => expect(store.cancellable()).toBe(true));
    store.transfer.cancel();

    expect(store.busy()).toBe(true);
    expect(store.finalizing()).toBe(true);
    await saving;
    expect(store.busy()).toBe(false);
    expect(store.finalizing()).toBe(false);
    expect(store.error()).toBe('Processing cancelled. Your draft and originals are retained.');
  });
});
