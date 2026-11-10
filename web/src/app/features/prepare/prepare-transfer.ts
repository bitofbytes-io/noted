import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api.service';
import { MAX_PREPARED_PAGES } from '../../core/models';
import { measureAsync } from '../../core/performance';
import { IMSLPAddedFile, chosenIMSLPWork, imslpFileMatch } from './prepare-imslp';
import { isProcessingStopped, preparedPhotoKey } from './prepare-processing';
import type { PrepareStore } from './prepare.store';

/**
 * The two operations that move the draft's bytes: adding or replacing pages from
 * uploaded files, and the final assembly that saves the prepared PDF to the library.
 */
export class PrepareTransfer {
  /** True while files are being added; a cancel then stops the remaining ones. */
  uploading = false;
  private skipRemainingUploads = false;
  private uploadGeneration = 0;
  private replaceID?: string;

  constructor(private readonly store: PrepareStore) {}

  async upload(event: Event, replace = false) {
    if (this.store.busy()) return;
    const input = event.target as HTMLInputElement,
      files = Array.from(input.files ?? []);
    input.value = '';
    await this.uploadFiles(files, replace);
  }

  /** The file inputs and the IMSLP drop target share this path. */
  async uploadFiles(files: File[], replace = false) {
    const store = this.store;
    if (store.busy() || !files.length) return;
    // A PDF downloaded from IMSLP keeps the draft on Source with the chosen work
    // in view; Continue moves on to Pages.
    const stayOnSource = !replace && store.step() === 'source' && store.sourceMode() === 'imslp';
    const added: IMSLPAddedFile[] = [];
    store.busy.set(true);
    store.error.set('');
    this.uploading = true;
    this.skipRemainingUploads = false;
    this.syncCancellable();
    const uploadGeneration = ++this.uploadGeneration;
    let pagesOmitted = false;
    try {
      store.applyIMSLP();
      await store.persist();
      const chosen = chosenIMSLPWork(store.draft());
      this.replaceID = replace ? store.page?.id : undefined;
      for (const [i, file] of files.entries()) {
        if (uploadGeneration !== this.uploadGeneration) break;
        const d = store.draft()!;
        if (file.size > d.maxFileBytes)
          throw Error(
            `${file.name} exceeds the ${Math.round(d.maxFileBytes / 1048576)} MiB file limit.`,
          );
        store.progress.set(`Adding ${i + 1} of ${files.length}: ${file.name}`);
        const oldCount = d.manifest.pages.length;
        const next = await firstValueFrom(store.api.uploadImport(d, file));
        // Each completed file is one Undo step, even when later files fail or are cancelled.
        store.edits.remember();
        store.draft.set(next);
        store.rangeSourceId ||= next.sources[0]?.id || '';
        const incoming = next.sources.find(
          (source) => !d.sources.some((old) => old.id === source.id),
        );
        if (
          !this.replaceID &&
          incoming &&
          next.manifest.pages.length - oldCount < incoming.pageCount
        )
          pagesOmitted = true;
        if (this.replaceID) {
          const target = next.manifest.pages.findIndex((p) => p.id === this.replaceID);
          if (!incoming || target < 0) throw Error('Replacement source was not received.');
          next.manifest.pages = next.manifest.pages.filter((page) => page.sourceId !== incoming.id);
          next.manifest.pages[target] = { id: this.replaceID, sourceId: incoming.id, page: 0 };
          store.mark();
          await store.persist();
          store.preview.renderer.dropThumbnail(this.replaceID);
          store.preview.renderer.releaseDisplayRaster();
          store.preview.reconcileKeys();
          this.replaceID = undefined;
        }
        store.selected.set(Math.min(oldCount, store.draft()!.manifest.pages.length - 1));
        if (stayOnSource)
          added.push({ filename: file.name, match: imslpFileMatch(file.name, chosen) });
      }
      if (!stayOnSource) store.setStep('pages');
      store.preview.reconcileKeys();
      if (pagesOmitted)
        store.error.set(
          `A draft holds at most ${MAX_PREPARED_PAGES} pages, so some uploaded pages were not added. Use Choose source pages to pick others.`,
        );
      await store.preview.render();
    } catch (e) {
      store.error.set(errorMessage(e) + ' Pages already added remain in this draft.');
    } finally {
      if (added.length) store.imslp.added.update((files) => [...files, ...added]);
      this.uploading = false;
      this.skipRemainingUploads = false;
      this.syncCancellable();
      store.busy.set(false);
      store.progress.set('');
    }
  }

  /** Builds the final PDF in the worker, saves it as a piece, and opens it in the reader. */
  async save() {
    const store = this.store,
      d = store.draft();
    if (!d || d.finalized || store.busy() || store.finalizing()) return;
    try {
      store.applyIMSLP();
    } catch (e) {
      store.error.set(errorMessage(e));
      return;
    }
    store.finalizing.set(true);
    store.preview.invalidate();
    store.busy.set(true);
    store.error.set('');
    store.progress.set('Preparing score');
    try {
      await store.persist();
      const current = structuredClone(store.draft()!);
      const prepared: { key: string; bytes: ArrayBuffer }[] = [];
      const preparedKeys = current.manifest.pages.map((page) => {
        const source = current.sources.find((item) => item.id === page.sourceId);
        return source?.mime.startsWith('image/') ? preparedPhotoKey(source, page) : '';
      });
      for (const key of new Set(preparedKeys.filter(Boolean))) {
        const bytes = store.preview.takePrepared(key);
        if (bytes) prepared.push({ key, bytes });
      }
      const transfer = prepared.map((item) => item.bytes);
      const response = await measureAsync('noted.intake.final-assembly', () =>
        store.preview.runWorker(
          {
            kind: 'build',
            draftId: current.id,
            sources: current.sources,
            manifest: current.manifest,
            prepared,
            preparedKeys,
          },
          true,
          transfer,
        ),
      );
      const bytes = response.bytes;
      if (!bytes) throw Error('Prepared PDF was not returned.');
      if (bytes.byteLength > current.maxFileBytes)
        throw Error(
          'Prepared PDF exceeds the file limit. Remove pages or use smaller images; your draft is retained.',
        );
      const piece = await measureAsync('noted.intake.finalize', () =>
        firstValueFrom(
          store.api.finalizeImport(current, new Blob([bytes], { type: 'application/pdf' })),
        ),
      );
      store.dirty = false;
      store.draft.update((d) => (d ? { ...d, finalized: true, pieceId: piece.id } : null));
      store.completed.set(piece);
      if (piece.duplicateOf) {
        setTimeout(() => store.views.completionHeading?.nativeElement.focus());
      } else {
        await store.router.navigate(['/reader', piece.id]);
      }
    } catch (e) {
      store.error.set(
        isProcessingStopped(e) && e.reason === 'cancelled'
          ? 'Processing cancelled. Your draft and originals are retained.'
          : errorMessage(e),
      );
    } finally {
      store.finalizing.set(false);
      store.busy.set(false);
      store.progress.set('');
    }
  }

  cancel() {
    const store = this.store;
    if (!store.cancellable()) return;
    if (this.uploading) {
      this.uploadGeneration++;
      this.skipRemainingUploads = true;
      this.syncCancellable();
      store.progress.set('Finishing the current upload; remaining files cancelled.');
      return;
    }
    store.preview.cancelWorker();
    this.uploadGeneration++;
    this.syncCancellable();
    if (store.finalizing()) return;
    store.busy.set(false);
    store.progress.set('');
    store.error.set('Processing cancelled. Your draft and originals are retained.');
  }

  syncCancellable(): void {
    this.store.cancellable.set(
      (this.uploading && !this.skipRemainingUploads) ||
        (this.store.busy() && this.store.preview.foreground),
    );
  }
}
