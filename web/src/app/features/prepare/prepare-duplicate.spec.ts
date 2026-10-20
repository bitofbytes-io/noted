import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ImportAsset } from '../../core/models';
import { ProcessingWorkerClient } from './prepare-processing';
import { createPrepareFixture, draft } from './prepare-testing';

describe('Prepare duplicate completion', () => {
  it('keeps both saved navigation actions and prevents further draft writes', async () => {
    const { fixture, api, openWindow } = await createPrepareFixture();
    const component = fixture.componentInstance;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const source = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'same-pdf',
      pageCount: 1,
      width: 612,
      height: 792,
    } as ImportAsset;
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    component.step.set('details');
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    vi.spyOn(client, 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });
    api.finalizeImport.mockReturnValueOnce(
      of({
        id: 'saved-copy',
        title: 'My saved copy',
        duplicateOf: { id: 'existing-piece', title: '<img src=x onerror=alert(1)>' },
      }),
    );
    await component.save();
    fixture.detectChanges();
    await fixture.whenStable();

    const section = fixture.nativeElement.querySelector('.completion') as HTMLElement;
    expect(section.textContent).toContain(
      'Already in your library as <img src=x onerror=alert(1)>.',
    );
    expect(section.querySelector('img')).toBeNull();
    expect(section.querySelector('a.btn-primary')?.getAttribute('href')).toBe('/reader/saved-copy');
    expect(section.querySelector('a.btn-secondary')?.getAttribute('href')).toBe(
      '/reader/existing-piece',
    );
    expect(fixture.nativeElement.querySelector('.prepare-footer')).toBeNull();
    expect(fixture.nativeElement.querySelector('.steps')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(component.draft()?.finalized).toBe(true);
    expect(component.draft()?.pieceId).toBe('saved-copy');

    await component.save();
    await component.discard();
    component.updateMetadata('title', 'Too late');
    component.mark();
    await component.persist();
    expect(component.draft()?.metadata.title).toBe(draft.metadata.title);
    expect(api.finalizeImport).toHaveBeenCalledOnce();
    expect(api.deleteImport).not.toHaveBeenCalled();
    expect(api.updateImport).not.toHaveBeenCalled();
    await component.close();
    expect(navigate).toHaveBeenCalledWith(['/']);
    fixture.destroy();
    openWindow.mockRestore();
  });

  it('keeps a stale-tab discard conflict recoverable without claiming completion', async () => {
    const { fixture, api, openWindow } = await createPrepareFixture();
    const component = fixture.componentInstance;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.deleteImport.mockReturnValueOnce(
      throwError(
        () => new HttpErrorResponse({ status: 409, error: { error: 'Draft changed. Reload it.' } }),
      ),
    );
    await component.discard();
    fixture.detectChanges();
    expect(component.error()).toBe('Draft changed. Reload it.');
    expect(component.busy()).toBe(false);
    expect(component.completed()).toBeNull();
    expect(component.draft()?.finalized).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.completion')).toBeNull();
    const reload = Array.from(
      fixture.nativeElement.querySelectorAll(
        '[role="alert"] button',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.trim() === 'Reload draft');
    expect(reload?.disabled).toBe(false);
    api.importDraft.mockReturnValueOnce(
      of({ ...structuredClone(draft), finalized: true, pieceId: 'saved-copy' }),
    );
    reload!.click();
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/reader', 'saved-copy']);
    expect(api.deleteImport).toHaveBeenCalledOnce();
    expect(api.finalizeImport).not.toHaveBeenCalled();
    fixture.destroy();
    confirm.mockRestore();
    openWindow.mockRestore();
  });

  it('opens an already finalized draft without running finalization again', async () => {
    const { fixture, api, openWindow } = await createPrepareFixture();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    api.importDraft.mockReturnValueOnce(
      of({ ...structuredClone(draft), finalized: true, pieceId: 'saved-copy' }),
    );
    await fixture.componentInstance.load();
    expect(navigate).toHaveBeenCalledWith(['/reader', 'saved-copy']);
    expect(api.finalizeImport).not.toHaveBeenCalled();
    expect(api.deleteImport).not.toHaveBeenCalled();
    fixture.destroy();
    openWindow.mockRestore();
  });
});
