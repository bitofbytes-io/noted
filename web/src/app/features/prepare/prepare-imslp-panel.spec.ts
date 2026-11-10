import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft } from '../../core/models';
import { PrepareImslpComponent } from './prepare-imslp.component';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { PrepareApiMock, createPrepareFixture, draft } from './prepare-testing';

describe('PrepareImslpComponent chosen work and drop', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  const prelude = {
    title: 'Prelude',
    composer: 'Example, Ada',
    url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
  };
  const text = () => fixture.nativeElement.textContent as string;
  const panel = () =>
    fixture.debugElement.query(By.directive(PrepareImslpComponent))
      .componentInstance as PrepareImslpComponent;

  beforeEach(async () => {
    ({ fixture, store, api, openWindow } = await createPrepareFixture());
    vi.useFakeTimers();
    store.sourceMode.set('imslp');
    fixture.detectChanges();
  });

  afterEach(() => {
    openWindow.mockRestore();
    vi.useRealTimers();
    // Focusing the search field leaves a document selection later specs rely on being empty.
    (document.activeElement as HTMLElement | null)?.blur();
    document.getSelection()?.removeAllRanges();
  });

  it('opens the chosen work on IMSLP, prefills, persists and offers Change', async () => {
    const component = store;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [prelude] }));
    component.imslp.query = 'Prelude';
    component.imslp.input();
    vi.advanceTimersByTime(350);
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      ) as HTMLButtonElement
    ).click();
    expect(openWindow).toHaveBeenCalledWith(prelude.url, '_blank', 'noopener,noreferrer');
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Prelude',
      composer: 'Example, Ada',
      sourceUrl: prelude.url,
    });
    expect(component.imslp.link).toBe(prelude.url);
    await vi.runOnlyPendingTimersAsync();
    expect(api.updateImport).toHaveBeenCalledTimes(1);
    expect(api.updateImport.mock.calls[0][0].metadata.sourceUrl).toBe(prelude.url);

    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.chosen-title').textContent).toContain('Prelude');
    expect(text()).toContain('Title and composer filled from IMSLP');
    expect(text()).toContain('IMSLP opened in a new tab');
    // Send to Noted always starts a new draft, so this panel does not offer it.
    expect(text()).toContain('Waiting for your PDF. Drop it here, or use Add downloaded PDF.');
    expect(text()).not.toContain('Send to Noted');
    expect(fixture.nativeElement.querySelector('input[type="search"]')).toBeNull();

    const change = fixture.nativeElement.querySelector('.chosen-work button') as HTMLButtonElement;
    change.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const search = fixture.nativeElement.querySelector('input[type="search"]');
    expect(document.activeElement).toBe(search);
    expect(component.imslp.query).toBe('Prelude');
    expect(component.imslp.results()).toEqual([prelude]);
    expect(component.draft()?.metadata.sourceUrl).toBe(prelude.url);

    component.updateMetadata('title', 'My edition');
    component.imslp.changing.set(false);
    fixture.detectChanges();
    expect(text()).toContain('Composer filled from IMSLP');
    expect(text()).not.toContain('Title and composer filled from IMSLP');
  });

  it('adds a dropped IMSLP PDF through the upload path and stays on Source', async () => {
    const component = store;
    vi.spyOn(component.preview, 'render').mockResolvedValue();
    component.draft.update((d) =>
      d ? { ...d, metadata: { ...d.metadata, sourceUrl: prelude.url } } : null,
    );
    component.imslp.link = prelude.url;
    const source: ImportAsset = {
      id: 'imslp-file',
      filename: 'IMSLP01240-Example_-_Prelude.pdf',
      mime: 'application/pdf',
      size: 1,
      checksum: 'imslp-file',
      pageCount: 1,
      width: 0,
      height: 0,
    };
    const uploadImport = vi.fn((current: ImportDraft) =>
      of({
        ...structuredClone(current),
        revision: current.revision + 1,
        sources: [source],
        manifest: {
          version: 1 as const,
          pages: [{ id: 'page-1', sourceId: source.id, page: 0 }],
        },
      }),
    );
    Reflect.set(api, 'uploadImport', uploadImport);
    fixture.detectChanges();
    const article = fixture.nativeElement.querySelector('article.imslp') as HTMLElement;
    const drag = (types: string[], files: File[] = []) =>
      ({
        preventDefault: vi.fn(),
        currentTarget: article,
        relatedTarget: null,
        dataTransfer: { types, files, dropEffect: 'none' },
      }) as unknown as DragEvent;

    const over = drag(['Files']);
    panel().dragOver(over);
    fixture.detectChanges();
    expect(over.preventDefault).toHaveBeenCalled();
    expect(article.querySelector('.imslp-drop.hot')?.textContent).toContain('Release to add');
    panel().dragLeave(drag(['Files']));
    expect(component.imslp.dropHot()).toBe(false);

    await panel().drop(drag(['Files'], [new File(['x'], 'notes.txt')]));
    expect(component.error()).toBe('Only PDF files can be dropped here.');
    expect(uploadImport).not.toHaveBeenCalled();
    component.error.set('');

    const file = new File(['%PDF-'], 'IMSLP01240-Example_-_Prelude.pdf', {
      type: 'application/pdf',
    });
    await panel().drop(drag(['Files'], [file]));
    expect(uploadImport).toHaveBeenCalledWith(expect.anything(), file);
    expect(component.step()).toBe('source');
    expect(component.error()).toBe('');
    fixture.detectChanges();
    expect(text()).toContain('IMSLP01240-Example_-_Prelude.pdf');
    expect(text()).toContain("IMSLP file 01240, by the chosen work's composer.");
    const continueButton = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.trim() === 'Continue')!;
    expect(continueButton.disabled).toBe(false);

    // A mixed drop uploads the PDF and still reports the skipped file.
    const second = new File(['%PDF-'], 'second.pdf', { type: 'application/pdf' });
    await panel().drop(
      drag(['Files'], [second, new File(['png'], 'cover.png', { type: 'image/png' })]),
    );
    expect(uploadImport).toHaveBeenLastCalledWith(expect.anything(), second);
    expect(uploadImport).toHaveBeenCalledTimes(2);
    expect(component.error()).toBe('Only PDF files can be dropped here.');
  });
});
