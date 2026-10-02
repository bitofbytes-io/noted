import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import {
  ImportAsset,
  ImportDraft,
  IMSLPSearch,
  MAX_PREPARED_PAGES,
  PageEdit,
  Piece,
} from '../../core/models';
import {
  PreparedPageCache,
  ProcessingStoppedError,
  ProcessingWorkerClient,
  preparedPhotoKey,
} from './prepare-processing';
import { PrepareComponent } from './prepare.component';
import { routes } from '../../app.routes';
import { canLeave } from '../../core/leave.guard';

describe('PrepareComponent', () => {
  const draft: ImportDraft = {
    id: '1b06330f-cee6-4cbd-a9e5-bcbad612a997',
    pieceId: null,
    revision: 1,
    metadata: {
      title: 'Draft score',
      composer: '',
      favorite: false,
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
    },
    manifest: { version: 1, pages: [] },
    initialManifest: { version: 1, pages: [] },
    sources: [],
    finalized: false,
    updatedAt: '2026-09-13T20:00:00Z',
    maxFileBytes: 50 * 1024 * 1024,
  };
  let fixture: ComponentFixture<PrepareComponent>;
  let api: {
    importDraft: ReturnType<typeof vi.fn>;
    deleteImport: ReturnType<typeof vi.fn>;
    updateImport: ReturnType<typeof vi.fn>;
    finalizeImport: ReturnType<typeof vi.fn>;
    searchIMSLP: ReturnType<typeof vi.fn>;
  };
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    openWindow = vi.spyOn(window, 'open').mockReturnValue(null);
    api = {
      importDraft: vi.fn(() => of(structuredClone(draft))),
      deleteImport: vi.fn((): Observable<void> => of(undefined)),
      updateImport: vi.fn((value: ImportDraft) => of(value)),
      finalizeImport: vi.fn(() => of({ id: 'piece-one', pdf: {} } as unknown as Piece)),
      searchIMSLP: vi.fn((): Observable<IMSLPSearch> => of({ status: 'ready', results: [] })),
    };
    await TestBed.configureTestingModule({
      imports: [PrepareComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ draftId: draft.id }),
              queryParamMap: convertToParamMap({}),
            },
          },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PrepareComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  it('marks meaningful page edits and clears the marker after reset', () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      manifest: {
        version: 1,
        pages: [
          { id: 'page-1', sourceId: 'photo', page: 0, paperCleanupStrength: 0.4 },
          { id: 'page-2', sourceId: 'photo', page: 0 },
        ],
      },
    });
    component.step.set('pages');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
    expect(
      fixture.nativeElement.querySelectorAll('.thumbnail button')[0].getAttribute('aria-label'),
    ).toBe('Preview page 1, adjusted');
    component.selected.set(0);
    component.resetPage();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(0);
    component.undo();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.adjusted-marker')).toHaveLength(1);
  });

  it('limits a chosen source range to the preparation page limit', () => {
    const component = fixture.componentInstance;
    const source = { id: 'book', mime: 'application/pdf', pageCount: 40 } as ImportAsset;
    component.draft.set({ ...structuredClone(draft), sources: [source] });
    component.rangeSourceId = source.id;
    component.rangeText = `1-${MAX_PREPARED_PAGES + 1}`;
    component.useRange();
    expect(component.error()).toContain(`at most ${MAX_PREPARED_PAGES} pages`);
    expect(component.draft()!.manifest.pages).toHaveLength(0);

    component.error.set('');
    component.rangeText = `3-${MAX_PREPARED_PAGES + 2}`;
    component.useRange();
    expect(component.error()).toBe('');
    expect(component.draft()!.manifest.pages.map((page) => page.page)).toEqual(
      Array.from({ length: MAX_PREPARED_PAGES }, (_, index) => index + 2),
    );
  });

  it('keeps work search fallback and prefills selected IMSLP metadata in the same draft', async () => {
    const component = fixture.componentInstance;
    const work = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [work] }));
    component.sourceMode.set('imslp');
    component.imslpQuery = 'Prelude';
    await component.searchIMSLP();
    fixture.detectChanges();
    expect(api.searchIMSLP).toHaveBeenCalledWith('Prelude');
    expect(fixture.nativeElement.textContent).toContain('Add downloaded PDF');
    component.selectIMSLPWork(work);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Draft score',
      composer: 'Example, Ada',
      sourceUrl: work.url,
    });
    expect(component.imslp).toBe(work.url);
  });

  it('does not select a work while uploading or finalizing', async () => {
    const component = fixture.componentInstance;
    const work = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [work] }));
    component.sourceMode.set('imslp');
    component.imslpQuery = 'Prelude';
    await component.searchIMSLP();

    for (const state of ['busy', 'finalizing'] as const) {
      component[state].set(true);
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      );
      expect(select.disabled).toBe(true);
      component.selectIMSLPWork(work);
      expect(component.draft()?.metadata).toEqual(draft.metadata);
      expect(component.imslp).toBe('');
      expect(openWindow).not.toHaveBeenCalled();
      component[state].set(false);
    }
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      ).disabled,
    ).toBe(false);
  });

  it('updates only auto-owned fields when switching IMSLP works', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    const first = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    const second = {
      title: 'Nocturne',
      composer: 'Sample, Bea',
      url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslpQuery = 'music';
    await component.searchIMSLP();
    component.sourceMode.set('imslp');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Showing IMSLP's top matches");

    component.selectIMSLPWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: first.title,
      composer: first.composer,
      sourceUrl: first.url,
    });
    component.selectIMSLPWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: second.title,
      composer: second.composer,
      sourceUrl: second.url,
    });

    component.updateMetadata('title', 'My printed edition');
    component.selectIMSLPWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: first.composer,
      sourceUrl: first.url,
    });
    component.updateMetadata('composer', 'Teacher attribution');
    component.selectIMSLPWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: 'Teacher attribution',
      sourceUrl: second.url,
    });
  });

  it('keeps autofill ownership across saving and resuming a draft', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    const first = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    const second = {
      title: 'Nocturne',
      composer: 'Sample, Bea',
      url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslpQuery = 'music';
    await component.searchIMSLP();
    component.selectIMSLPWork(first);
    await component.persist();
    const saved = structuredClone(component.draft()!);
    api.importDraft.mockReturnValue(of(saved));
    await component.load();
    component.selectIMSLPWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: second.title,
      composer: second.composer,
      sourceUrl: second.url,
    });
    expect(component.draft()?.imslpAutoFill).toMatchObject({
      title: second.title,
      composer: second.composer,
    });
  });

  it('preserves manually edited fields across IMSLP draft resume', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    const first = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    const second = {
      title: 'Nocturne',
      composer: 'Sample, Bea',
      url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslpQuery = 'music';
    await component.searchIMSLP();
    component.selectIMSLPWork(first);
    component.updateMetadata('title', 'My printed edition');
    component.updateMetadata('composer', '');
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    component.selectIMSLPWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: '',
      sourceUrl: second.url,
    });
    expect(component.draft()?.imslpAutoFill).toMatchObject({
      titleEdited: true,
      composerEdited: true,
    });
  });

  it('opens a draft that arrived with its PDF, as from Send to Noted, on the Pages step', async () => {
    const component = fixture.componentInstance;
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    const source = {
      id: 'shared-pdf',
      filename: 'IMSLP01240-Debussy_-_Clair_de_lune.pdf',
      mime: 'application/pdf',
      pageCount: 2,
    } as ImportAsset;
    const shared: ImportDraft = {
      ...structuredClone(draft),
      metadata: {
        ...structuredClone(draft.metadata),
        title: 'Clair de lune',
        composer: 'Debussy, Claude',
        sourceUrl: 'https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)',
      },
      imslpAutoFill: { title: 'Clair de lune', composer: 'Debussy, Claude' },
      sources: [source],
      manifest: {
        version: 1,
        pages: [
          { id: 'p1', sourceId: source.id, page: 0 },
          { id: 'p2', sourceId: source.id, page: 1 },
        ],
      },
    };
    api.importDraft.mockReturnValue(of(structuredClone(shared)));
    await component.load();
    fixture.detectChanges();
    expect(component.step()).toBe('pages');
    expect(component.imslp).toBe(shared.metadata.sourceUrl);
    expect(component.imslpAdded()).toEqual([]);
    const next = [...fixture.nativeElement.querySelectorAll('footer .btn-primary')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Continue'),
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  it('updates pasted IMSLP work metadata when the work link changes after resume', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    component.imslp = 'https://imslp.org/wiki/Prelude_(Example,_Ada)';
    Reflect.get(component, 'applyIMSLP').call(component);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Prelude',
      composer: 'Example, Ada',
    });
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    component.imslp = 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)';
    Reflect.get(component, 'applyIMSLP').call(component);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Nocturne',
      composer: 'Sample, Bea',
      sourceUrl: component.imslp,
    });
  });

  it('replaces an auto-owned filename fallback with a selected work title', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    component.imslp = 'https://imslp.org/wiki/(Composer,_Name)';
    Reflect.get(component, 'applyIMSLP').call(component);
    expect(component.draft()?.imslpAutoFill?.title).toBe('');
    // This is the draft returned by UploadImportSource after its filename fallback.
    component.draft.update((d) =>
      d
        ? {
            ...d,
            metadata: { ...d.metadata, title: 'from-book' },
            imslpAutoFill: { ...d.imslpAutoFill, title: 'from-book' },
          }
        : null,
    );
    const work = {
      title: 'Nocturne',
      composer: 'Sample, Bea',
      url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [work] }));
    component.imslpQuery = 'Nocturne';
    await component.searchIMSLP();
    component.selectIMSLPWork(work);
    expect(component.draft()?.metadata).toMatchObject({
      title: work.title,
      sourceUrl: work.url,
    });
  });

  describe('IMSLP live search', () => {
    const prelude = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    const type = (component: PrepareComponent, query: string) => {
      component.imslpQuery = query;
      component.imslpInput();
    };
    const text = () => fixture.nativeElement.textContent as string;
    const linkField = () =>
      fixture.nativeElement.querySelector('.imslp-link input[type="url"]') as HTMLInputElement;
    const addPDF = () =>
      Array.from(
        fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
      ).find((button) => button.textContent?.trim() === 'Add downloaded PDF')!;

    beforeEach(() => {
      vi.useFakeTimers();
      fixture.componentInstance.sourceMode.set('imslp');
      fixture.detectChanges();
    });
    afterEach(() => {
      vi.useRealTimers();
      // Focusing the search field leaves a document selection later specs rely on being empty.
      (document.activeElement as HTMLElement | null)?.blur();
      document.getSelection()?.removeAllRanges();
    });

    it('sends nothing below two characters and shows the idle hint', () => {
      const component = fixture.componentInstance;
      type(component, 'P');
      vi.advanceTimersByTime(1000);
      type(component, ' P ');
      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(api.searchIMSLP).not.toHaveBeenCalled();
      expect(component.imslpStatus()).toBe('idle');
      expect(text()).toContain('Type at least two characters.');
    });

    it('debounces typing into one request for the last query', () => {
      const component = fixture.componentInstance;
      type(component, 'Pre');
      vi.advanceTimersByTime(100);
      type(component, 'Prel');
      vi.advanceTimersByTime(100);
      type(component, 'Prelu');
      vi.advanceTimersByTime(349);
      expect(api.searchIMSLP).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      expect(api.searchIMSLP).toHaveBeenCalledWith('Prelu');
    });

    it('searches at once on Enter and cancels the pending debounce', () => {
      const component = fixture.componentInstance;
      type(component, 'Prelude');
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      component.imslpEnter(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(api.searchIMSLP).toHaveBeenCalledWith('Prelude');
      vi.advanceTimersByTime(1000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
    });

    it('skips a repeated query and answers earlier queries from the page cache', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockImplementation((query: string) =>
        of({ status: 'ready', results: query === 'Prelude' ? [prelude] : [] }),
      );
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      type(component, '  prelude ');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      type(component, 'Prelud');
      vi.advanceTimersByTime(350);
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);
      expect(component.imslpResults()).toEqual([prelude]);
      fixture.detectChanges();
      expect(text()).toContain("Showing IMSLP's top matches");
    });

    it('cancels the in-flight request and ignores its late response', () => {
      const component = fixture.componentInstance;
      const first = new Subject<IMSLPSearch>();
      const second = new Subject<IMSLPSearch>();
      api.searchIMSLP.mockReturnValueOnce(first).mockReturnValueOnce(second);
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      expect(first.observed).toBe(true);
      fixture.detectChanges();
      expect(text()).toContain('Searching IMSLP…');
      type(component, 'Nocturne');
      vi.advanceTimersByTime(350);
      expect(first.observed).toBe(false);
      first.next({ status: 'ready', results: [prelude] });
      expect(component.imslpResults()).toEqual([]);
      expect(component.imslpStatus()).toBe('searching');
      second.next({ status: 'ready', results: [] });
      fixture.detectChanges();
      expect(component.imslpStatus()).toBe('ready');
      expect(text()).toContain(
        'No works match. Check the spelling, try the composer alone, or paste a work link.',
      );
    });

    it('fades and disables earlier results while a newer search is pending', () => {
      const component = fixture.componentInstance;
      const nocturne = {
        title: 'Nocturne',
        composer: 'Sample, Bea',
        url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
      };
      const pending = new Subject<IMSLPSearch>();
      api.searchIMSLP
        .mockReturnValueOnce(of({ status: 'ready', results: [prelude] }))
        .mockReturnValueOnce(pending);
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      type(component, 'Nocturne');
      vi.advanceTimersByTime(350);
      fixture.detectChanges();
      expect(component.imslpStatus()).toBe('searching');
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      const old = fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      ) as HTMLButtonElement;
      expect(old.disabled).toBe(true);
      void component.selectIMSLPWork(prelude);
      expect(openWindow).not.toHaveBeenCalled();
      expect(component.draft()?.metadata.sourceUrl).toBe('');

      pending.next({ status: 'ready', results: [nocturne] });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).toBeNull();
      expect(
        (
          fixture.nativeElement.querySelector(
            'button[aria-label="Open Nocturne by Sample, Bea on IMSLP"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    it('marks results stale as soon as the query changes, before the debounce', () => {
      const component = fixture.componentInstance;
      const nocturne = {
        title: 'Nocturne',
        composer: 'Sample, Bea',
        url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
      };
      const older = new Subject<IMSLPSearch>();
      api.searchIMSLP
        .mockReturnValueOnce(of({ status: 'ready', results: [prelude] }))
        .mockReturnValueOnce(older)
        .mockReturnValueOnce(of({ status: 'ready', results: [nocturne] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      type(component, 'Prelude in C');
      vi.advanceTimersByTime(350);
      expect(older.observed).toBe(true);

      type(component, 'Nocturne');
      fixture.detectChanges();
      expect(older.observed).toBe(false);
      expect(component.imslpStatus()).not.toBe('ready');
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      expect(
        (
          fixture.nativeElement.querySelector(
            'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      older.next({ status: 'ready', results: [prelude] });
      void component.selectIMSLPWork(prelude);
      expect(openWindow).not.toHaveBeenCalled();
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(350);
      fixture.detectChanges();
      expect(api.searchIMSLP).toHaveBeenLastCalledWith('Nocturne');
      expect(component.imslpResults()).toEqual([nocturne]);
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).toBeNull();
      expect(
        (
          fixture.nativeElement.querySelector(
            'button[aria-label="Open Nocturne by Sample, Bea on IMSLP"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    it('keeps ready results selectable when the same query is retyped', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      type(component, ' prelude  ');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).toBeNull();
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
    });

    it('ignores an older response that resolves after a newer one', () => {
      const component = fixture.componentInstance;
      const nocturne = {
        title: 'Nocturne',
        composer: 'Sample, Bea',
        url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
      };
      const older = new Subject<IMSLPSearch>();
      const newer = new Subject<IMSLPSearch>();
      api.searchIMSLP.mockReturnValueOnce(older).mockReturnValueOnce(newer);
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      type(component, 'Nocturne');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

      newer.next({ status: 'ready', results: [nocturne] });
      older.next({ status: 'unavailable', results: [] });
      older.next({ status: 'ready', results: [prelude] });
      older.error(new Error('late failure'));
      fixture.detectChanges();
      expect(component.imslpStatus()).toBe('ready');
      expect(component.imslpResults()).toEqual([nocturne]);
      expect(text()).not.toContain('IMSLP is slow right now');
    });

    it('opens the chosen work on IMSLP, prefills, persists and offers Change', async () => {
      const component = fixture.componentInstance;
      component.draft.set({
        ...structuredClone(draft),
        metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
      });
      api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
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
      expect(component.imslp).toBe(prelude.url);
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

      const change = fixture.nativeElement.querySelector(
        '.chosen-work button',
      ) as HTMLButtonElement;
      change.click();
      fixture.detectChanges();
      await fixture.whenStable();
      const search = fixture.nativeElement.querySelector('input[type="search"]');
      expect(document.activeElement).toBe(search);
      expect(component.imslpQuery).toBe('Prelude');
      expect(component.imslpResults()).toEqual([prelude]);
      expect(component.draft()?.metadata.sourceUrl).toBe(prelude.url);

      component.updateMetadata('title', 'My edition');
      component.imslpChanging.set(false);
      fixture.detectChanges();
      expect(text()).toContain('Composer filled from IMSLP');
      expect(text()).not.toContain('Title and composer filled from IMSLP');
    });

    it('keeps earlier results faded while throttled and retries once the limit refills', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'throttled', results: [] }));
      type(component, 'Prelude in C');
      vi.advanceTimersByTime(350);
      fixture.detectChanges();
      expect(text()).toContain("You're searching quickly. Results will catch up in a moment.");
      expect(component.imslpResults()).toEqual([prelude]);
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      expect(linkField().disabled).toBe(false);
      expect(addPDF().disabled).toBe(false);

      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [] }));
      vi.advanceTimersByTime(1000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(3);
      expect(api.searchIMSLP).toHaveBeenLastCalledWith('Prelude in C');
      expect(component.imslpStatus()).toBe('ready');
    });

    it('clears results when IMSLP is unavailable and keeps the fallbacks open', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'unavailable', results: [] }));
      type(component, 'Chopin Nocturne');
      vi.advanceTimersByTime(350);
      fixture.detectChanges();
      expect(text()).toContain(
        'IMSLP is slow right now. Paste a work link or add a downloaded PDF, or press Enter to try again.',
      );
      expect(component.imslpResults()).toEqual([]);
      expect(fixture.nativeElement.querySelector('.imslp-link').open).toBe(true);
      expect(linkField().disabled).toBe(false);
      expect(addPDF().disabled).toBe(false);

      // An API error reads the same, and the same query can be tried again.
      api.searchIMSLP.mockReturnValueOnce(throwError(() => new Error('offline')));
      type(component, 'Chopin Nocturne ');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(3);
      expect(component.imslpStatus()).toBe('unavailable');
    });

    it('retries an unavailable search once after 30 seconds', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValue(of({ status: 'unavailable', results: [] }));
      type(component, 'Chopin Nocturne');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(29_999);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);
      expect(api.searchIMSLP).toHaveBeenLastCalledWith('Chopin Nocturne');
      expect(component.imslpStatus()).toBe('unavailable');
      vi.advanceTimersByTime(120_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

      // A recovered retry shows its results.
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'unavailable', results: [] }));
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350 + 30_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(4);
      expect(component.imslpStatus()).toBe('ready');
      expect(component.imslpResults()).toEqual([prelude]);
    });

    it('skips the unavailable retry once the query or panel changed', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValue(of({ status: 'unavailable', results: [] }));
      type(component, 'Chopin Nocturne');
      vi.advanceTimersByTime(350);
      component.imslpQuery = 'Chopin Nocturne Op.9';
      vi.advanceTimersByTime(30_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);

      type(component, 'Chopin');
      vi.advanceTimersByTime(350);
      component.chooseSource('all');
      vi.advanceTimersByTime(30_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);
    });

    it('stops a pending throttled retry when the draft leaves the IMSLP panel', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValue(of({ status: 'throttled', results: [] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350);
      expect(component.imslpStatus()).toBe('throttled');
      component.setStep('pages');
      vi.advanceTimersByTime(5000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      expect(component.imslpStatus()).toBe('idle');

      component.setStep('source');
      type(component, 'Nocturne');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);
      component.chooseSource('all');
      vi.advanceTimersByTime(5000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);
    });

    it('adds a dropped IMSLP PDF through the upload path and stays on Source', async () => {
      const component = fixture.componentInstance;
      vi.spyOn(component, 'renderPreview').mockResolvedValue();
      component.draft.update((d) =>
        d ? { ...d, metadata: { ...d.metadata, sourceUrl: prelude.url } } : null,
      );
      component.imslp = prelude.url;
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
      const panel = fixture.nativeElement.querySelector('article.imslp') as HTMLElement;
      const drag = (types: string[], files: File[] = []) =>
        ({
          preventDefault: vi.fn(),
          currentTarget: panel,
          relatedTarget: null,
          dataTransfer: { types, files, dropEffect: 'none' },
        }) as unknown as DragEvent;

      const over = drag(['Files']);
      component.imslpDragOver(over);
      fixture.detectChanges();
      expect(over.preventDefault).toHaveBeenCalled();
      expect(panel.querySelector('.imslp-drop.hot')?.textContent).toContain('Release to add');
      component.imslpDragLeave(drag(['Files']));
      expect(component.imslpDropHot()).toBe(false);

      await component.imslpDrop(drag(['Files'], [new File(['x'], 'notes.txt')]));
      expect(component.error()).toBe('Only PDF files can be dropped here.');
      expect(uploadImport).not.toHaveBeenCalled();
      component.error.set('');

      const file = new File(['%PDF-'], 'IMSLP01240-Example_-_Prelude.pdf', {
        type: 'application/pdf',
      });
      await component.imslpDrop(drag(['Files'], [file]));
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
      await component.imslpDrop(
        drag(['Files'], [second, new File(['png'], 'cover.png', { type: 'image/png' })]),
      );
      expect(uploadImport).toHaveBeenLastCalledWith(expect.anything(), second);
      expect(uploadImport).toHaveBeenCalledTimes(2);
      expect(component.error()).toBe('Only PDF files can be dropped here.');
    });
  });

  it('flushes a debounced edit before the route is left', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      component.updateMetadata('composer', 'Changed before Back');
      expect(api.updateImport).not.toHaveBeenCalled();

      await expect(canLeave(component, null!, null!, null!)).resolves.toBe(true);
      expect(api.updateImport).toHaveBeenCalledTimes(1);
      expect(api.updateImport.mock.calls[0][0].metadata.composer).toBe('Changed before Back');

      component.ngOnDestroy();
      await vi.runAllTimersAsync();
      expect(api.updateImport).toHaveBeenCalledTimes(1);
      await expect(component.canLeave()).resolves.toBe(true);
      expect(routes.find((route) => route.path === 'prepare/:draftId')?.canDeactivate).toEqual([
        canLeave,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before leaving when the departure save fails', async () => {
    const component = fixture.componentInstance;
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    api.updateImport.mockReturnValue(throwError(() => new Error('offline')));
    component.updateMetadata('notes', 'Unsaved');

    await expect(component.canLeave()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(component.error()).toBe('Offline.');
    await expect(component.canLeave()).resolves.toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('flushes and warns before unloading only with unsaved changes', () => {
    const component = fixture.componentInstance;
    const clean = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    component.updateMetadata('notes', 'Unsaved');
    const dirty = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(api.updateImport).toHaveBeenCalledTimes(1);
  });

  it('makes each uploaded file its own Undo step', async () => {
    const component = fixture.componentInstance;
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    const pdf = (id: string): ImportAsset => ({
      id,
      filename: `${id}.pdf`,
      mime: 'application/pdf',
      size: 1,
      checksum: id,
      pageCount: 1,
      width: 0,
      height: 0,
    });
    const pageA: PageEdit = { id: 'page-a', sourceId: 'a', page: 0 };
    component.draft.set({
      ...structuredClone(draft),
      sources: [pdf('a')],
      manifest: { version: 1, pages: [structuredClone(pageA)] },
    });
    component.step.set('pages');
    const uploaded = (source: ImportAsset, extra: PageEdit) => (current: ImportDraft) =>
      of({
        ...structuredClone(current),
        revision: current.revision + 1,
        sources: [...current.sources, source],
        manifest: { version: 1 as const, pages: [...current.manifest.pages, extra] },
      });
    const uploadImport = vi.fn(uploaded(pdf('b'), { id: 'page-b', sourceId: 'b', page: 0 }));
    Reflect.set(api, 'uploadImport', uploadImport);
    const choose = (replace = false) => {
      const input = document.createElement('input');
      Object.defineProperty(input, 'files', { value: [new File(['%PDF-'], 'b.pdf')] });
      return component.upload({ target: input } as unknown as Event, replace);
    };
    const pages = () => component.draft()!.manifest.pages;

    component.rotate();
    await choose();
    expect(pages().map((page) => page.id)).toEqual(['page-a', 'page-b']);

    component.undo();
    expect(pages()).toEqual([{ ...pageA, rotation: 90 }]);
    component.undo();
    expect(pages()).toEqual([pageA]);

    uploadImport.mockImplementation(uploaded(pdf('c'), { id: 'page-c', sourceId: 'c', page: 0 }));
    component.selected.set(0);
    await choose(true);
    expect(pages()).toEqual([{ id: 'page-a', sourceId: 'c', page: 0 }]);
    component.undo();
    expect(pages()).toEqual([pageA]);
  });

  it('discards a draft even when an in-flight autosave fails', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    let rejectSave!: (reason: Error) => void;
    const pendingSave = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    Reflect.set(component, 'pendingSave', pendingSave);

    const discard = component.discard();
    rejectSave(new Error('autosave failed'));
    await discard;

    expect(api.deleteImport).toHaveBeenCalledWith(draft.id);
    expect(router.navigate).toHaveBeenCalledWith(['/']);
    expect(component.error()).toBe('');
    expect(component.busy()).toBe(false);
  });

  async function openEdgeEditor() {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      manifest: { version: 1, pages: [{ id: 'page', sourceId: 'pdf', page: 0 }] },
    });
    component.step.set('pages');
    component.preview.set('data:image/png;base64,');
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    fixture.detectChanges();
    const surface = component.surface!.nativeElement;
    surface.scrollIntoView = vi.fn();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
    selection.addRange(range);
    expect(selection.isCollapsed).toBe(false);
    await component.beginEdges();
    fixture.detectChanges();
    return { component, surface, selection };
  }

  it('suppresses native preview interactions only while editing edges and clears selection', async () => {
    const { component, surface, selection } = await openEdgeEditor();
    expect(selection.isCollapsed).toBe(true);
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      true,
    );
    for (const type of ['contextmenu', 'dragstart']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      surface.querySelector('img')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }

    component.cancelEdges();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      false,
    );
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'cancel', 'apply', 'destroy'])(
    'confines a corner drag to its pointer and removes handlers after %s',
    async (ending) => {
      const { component, surface, selection } = await openEdgeEditor();
      vi.spyOn(surface.querySelector('img')!, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      } as DOMRect);
      const corner = surface.querySelector<HTMLButtonElement>('.corner')!;
      corner.setPointerCapture = vi.fn();
      corner.hasPointerCapture = vi.fn(() => true);
      corner.releasePointerCapture = vi.fn();
      const pointer = (type: string, pointerId = 1, x = 20) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: x,
          button: 0,
        });
        Object.defineProperties(event, {
          pointerId: { value: pointerId },
          isPrimary: { value: pointerId === 1 },
        });
        corner.dispatchEvent(event);
        return event;
      };
      const range = document.createRange();
      range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
      selection.addRange(range);
      expect(pointer('pointerdown').defaultPrevented).toBe(true);
      expect(selection.isCollapsed).toBe(true);
      pointer('pointermove', 2);
      pointer('pointerup', 2);
      expect(component.edgePoints[0]).toEqual([0, 0]);
      expect(pointer('pointermove').defaultPrevented).toBe(true);
      expect(component.edgePoints[0]).toEqual([0.2, 0.2]);

      if (ending === 'cancel') component.cancelEdges();
      else if (ending === 'apply') {
        vi.spyOn(component, 'changed').mockImplementation(() => {});
        component.applyEdges();
      } else if (ending === 'destroy') fixture.destroy();
      else pointer(ending);
      const edges = structuredClone(component.edgePoints);
      expect(pointer('pointermove', 1, 30).defaultPrevented).toBe(false);
      expect(component.edgePoints).toEqual(edges);
      expect(corner.releasePointerCapture).toHaveBeenCalledWith(1);
    },
  );

  it('keeps a prepared photo through reorder and invalidates it after an edit', () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const edited: PageEdit = {
      id: 'edited',
      sourceId: photo.id,
      page: 0,
      paperCleanupStrength: 0.5,
    };
    const other: PageEdit = { id: 'other', sourceId: photo.id, page: 0 };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [edited, other] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    const key = preparedPhotoKey(photo, edited);
    cache.set(key, new ArrayBuffer(4));

    component.move(1);
    expect(cache.has(key)).toBe(true);

    component.changePaperStrength(60);
    expect(cache.has(key)).toBe(false);

    const editedKey = preparedPhotoKey(photo, component.page!);
    cache.set(editedKey, new ArrayBuffer(4));
    const replacement = { ...photo, id: 'replacement', checksum: 'replacement-checksum' };
    component.draft()!.sources.push(replacement);
    component.page!.sourceId = replacement.id;
    component.changed();
    expect(cache.has(editedKey)).toBe(false);
  });

  it('keeps a shared prepared key until no current page references it', () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const first = { id: 'first', sourceId: photo.id, page: 0, paperCleanupStrength: 0.5 };
    const second = { ...first, id: 'second' };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [first, second] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    const sharedKey = preparedPhotoKey(photo, first);
    cache.set(sharedKey, new ArrayBuffer(4));

    component.page!.paperCleanupStrength = 0.6;
    component.changed();
    expect(cache.has(sharedKey)).toBe(true);

    component.draft()!.manifest.pages.splice(1, 1);
    component.changed();
    expect(cache.has(sharedKey)).toBe(false);
  });

  it('prepares an unedited selected photo after 750ms idle', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      const photo: ImportAsset = {
        id: 'photo',
        filename: 'page.jpg',
        mime: 'image/jpeg',
        size: 100,
        checksum: 'photo-checksum',
        pageCount: 1,
        width: 1000,
        height: 1400,
      };
      const page = { id: 'plain', sourceId: photo.id, page: 0 };
      component.draft.set({
        ...structuredClone(draft),
        sources: [photo],
        manifest: { version: 1, pages: [page] },
      });
      Reflect.get(component, 'reconcilePreparedKeys').call(component);
      Reflect.set(component, 'lastEditOrSelectionAt', performance.now());
      const revision = Reflect.get(component, 'previewRevision') as number;
      const run = vi
        .spyOn(
          component as unknown as { runWorker: (...args: unknown[]) => Promise<object> },
          'runWorker',
        )
        .mockResolvedValue({ bytes: new ArrayBuffer(4) });

      Reflect.get(component, 'scheduleBackgroundPrepare').call(
        component,
        structuredClone(page),
        photo,
        revision,
      );
      await vi.advanceTimersByTimeAsync(749);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(run).toHaveBeenCalledOnce();
      const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
      expect(cache.has(preparedPhotoKey(photo, page))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache background work after the edit revision changes', async () => {
    vi.useFakeTimers();
    try {
      const component = fixture.componentInstance;
      const photo: ImportAsset = {
        id: 'photo',
        filename: 'page.jpg',
        mime: 'image/jpeg',
        size: 100,
        checksum: 'photo-checksum',
        pageCount: 1,
        width: 1000,
        height: 1400,
      };
      const page = { id: 'plain', sourceId: photo.id, page: 0 };
      component.draft.set({
        ...structuredClone(draft),
        sources: [photo],
        manifest: { version: 1, pages: [page] },
      });
      Reflect.get(component, 'reconcilePreparedKeys').call(component);
      Reflect.set(component, 'lastEditOrSelectionAt', performance.now());
      const revision = Reflect.get(component, 'previewRevision') as number;
      let finish!: (response: { bytes: ArrayBuffer }) => void;
      vi.spyOn(
        component as unknown as { runWorker: (...args: unknown[]) => Promise<object> },
        'runWorker',
      ).mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const oldKey = preparedPhotoKey(photo, page);

      Reflect.get(component, 'scheduleBackgroundPrepare').call(
        component,
        structuredClone(page),
        photo,
        revision,
      );
      await vi.advanceTimersByTimeAsync(750);
      component.page!.paperCleanupStrength = 0.5;
      Reflect.set(component, 'previewRevision', revision + 1);
      finish({ bytes: new ArrayBuffer(4) });
      await Promise.resolve();
      await Promise.resolve();

      const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
      expect(cache.has(oldKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first three review thumbnails when a later page is selected', async () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const pages = Array.from({ length: 10 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: photo.id,
      page: 0,
    }));
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    component.selected.set(8);
    component.step.set('details');
    vi.spyOn(
      component as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockResolvedValue(document.createElement('canvas'));
    vi.spyOn(
      component as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    let nextURL = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++nextURL}`);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    component.thumbs.set({ stale: 'blob:stale' });

    await component.renderThumbnails(undefined);

    expect(Object.keys(component.thumbs()).sort()).toEqual([
      'page-0',
      'page-1',
      'page-2',
      'page-8',
    ]);
    expect(revoke).toHaveBeenCalledWith('blob:stale');
  });

  it('selects actual rail thumbnails near the viewport without eagerly selecting all pages', () => {
    const component = fixture.componentInstance;
    const pages = Array.from({ length: 10 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: 'photo',
      page: 0,
    }));
    const current = { ...structuredClone(draft), manifest: { version: 1 as const, pages } };
    component.draft.set(current);
    component.step.set('pages');
    component.selected.set(8);
    const container = document.createElement('div');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 300,
      width: 100,
      height: 300,
    } as DOMRect);
    for (const [index, page] of pages.entries()) {
      const element = document.createElement('div');
      element.dataset['thumbnailId'] = page.id;
      const top = index === 4 ? 20 : -500;
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top,
        bottom: top + 100,
        width: 100,
        height: 100,
      } as DOMRect);
      container.append(element);
    }

    const ids = Reflect.get(component, 'thumbnailIDs').call(
      component,
      current,
      container,
    ) as Set<string>;

    expect([...ids].sort()).toEqual(['page-4', 'page-8']);
  });

  it('serializes rapid thumbnail requests and advances to only the latest visible set', async () => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    const pages = Array.from({ length: 4 }, (_, index) => ({
      id: `page-${index}`,
      sourceId: photo.id,
      page: 0,
    }));
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages },
    });
    component.step.set('pages');
    const rail = (visibleIndex: number) => {
      const container = document.createElement('div');
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 100,
        width: 100,
        height: 100,
      } as DOMRect);
      for (const [index, page] of pages.entries()) {
        const element = document.createElement('div');
        element.dataset['thumbnailId'] = page.id;
        const top = index === visibleIndex ? 0 : -500;
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
          left: 0,
          right: 100,
          top,
          bottom: top + 100,
          width: 100,
          height: 100,
        } as DOMRect);
        container.append(element);
      }
      return container;
    };
    let releaseFirst!: () => void;
    const firstDecode = new Promise<void>((resolve) => (releaseFirst = resolve));
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const decode = vi
      .spyOn(
        component as unknown as {
          thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
        },
        'thumbnailCanvas',
      )
      .mockImplementation(async () => {
        const call = ++calls;
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (call === 1) await firstDecode;
          return document.createElement('canvas');
        } finally {
          active--;
        }
      });
    vi.spyOn(
      component as unknown as { canvasBlob: (...args: unknown[]) => Promise<Blob> },
      'canvasBlob',
    ).mockResolvedValue(new Blob());
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:latest');
    createURL.mockClear();

    component.selected.set(0);
    const first = component.renderThumbnails(rail(0));
    const duplicate = component.renderThumbnails(rail(0));
    component.selected.set(3);
    const latest = component.renderThumbnails(rail(3));
    await Promise.resolve();

    expect(decode).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);

    releaseFirst();
    await Promise.all([first, duplicate, latest]);

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls.map(([page]) => (page as PageEdit).id)).toEqual(['page-0', 'page-3']);
    expect(maximumActive).toBe(1);
    expect(createURL).toHaveBeenCalledOnce();
    expect(component.thumbs()).toEqual({ 'page-3': 'blob:latest' });
  });

  it.each([
    new ProcessingStoppedError('superseded'),
    new DOMException('The operation was aborted.', 'AbortError'),
  ])('does not report expected thumbnail cancellation errors', async (error) => {
    const component = fixture.componentInstance;
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: photo.id, page: 0 }] },
    });
    component.step.set('pages');
    vi.spyOn(
      component as unknown as {
        thumbnailCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement>;
      },
      'thumbnailCanvas',
    ).mockRejectedValue(error);

    await component.renderThumbnails(undefined);

    expect(component.error()).toBe('');
  });

  it('aligns mixed cached and uncached pages for final assembly', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const photo: ImportAsset = {
      id: 'photo',
      filename: 'page.jpg',
      mime: 'image/jpeg',
      size: 100,
      checksum: 'photo-checksum',
      pageCount: 1,
      width: 1000,
      height: 1400,
    };
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
    component.draft.set({
      ...structuredClone(draft),
      sources: [photo, missPhoto],
      manifest: { version: 1, pages: [miss, edited, { ...miss, id: 'miss-again' }] },
    });
    Reflect.get(component, 'reconcilePreparedKeys').call(component);
    const key = preparedPhotoKey(photo, edited);
    const cache = Reflect.get(component, 'preparedPages') as PreparedPageCache;
    cache.set(key, new ArrayBuffer(4));
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    const run = vi.spyOn(client, 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });

    await component.save();

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
    expect(router.navigate).toHaveBeenCalledWith(['/reader', 'piece-one']);
  });

  it('locks metadata after flushing the latest revision for finalization', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    component.step.set('details');
    api.updateImport.mockImplementationOnce((value: ImportDraft) =>
      of({ ...value, revision: 2, updatedAt: '2026-09-19T12:00:00Z' }),
    );
    component.updateMetadata('title', 'Latest persisted title');

    let finishBuild!: (response: { bytes: ArrayBuffer }) => void;
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    const run = vi
      .spyOn(client, 'run')
      .mockReturnValue(new Promise((resolve) => (finishBuild = resolve)));

    const saving = component.save();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('.details-form input') as HTMLInputElement;
    expect(title.disabled).toBe(true);
    component.updateMetadata('composer', 'Blocked edit');
    expect(component.draft()?.metadata.composer).toBe('');
    expect(api.updateImport).toHaveBeenCalledOnce();

    finishBuild({ bytes: new ArrayBuffer(10) });
    await saving;

    expect(api.finalizeImport).toHaveBeenCalledOnce();
    const finalizedDraft = api.finalizeImport.mock.calls[0][0] as ImportDraft;
    expect(finalizedDraft.revision).toBe(2);
    expect(finalizedDraft.metadata.title).toBe('Latest persisted title');
    expect(finalizedDraft.metadata.composer).toBe('');
    expect(component.finalizing()).toBe(false);
  });

  it('retains the draft when finalization fails', async () => {
    const component = fixture.componentInstance;
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    vi.spyOn(client, 'run').mockResolvedValue({ bytes: new ArrayBuffer(10) });
    api.finalizeImport.mockReturnValueOnce(throwError(() => new Error('Finalization failed.')));

    await component.save();

    expect(component.error()).toBe('Finalization failed.');
    expect(component.draft()?.id).toBe(draft.id);
    expect(component.busy()).toBe(false);
    expect(component.finalizing()).toBe(false);
    expect(navigate).not.toHaveBeenCalledWith(['/reader', expect.anything()]);
  });

  it('keeps draft controls locked until cancelled final processing unwinds', async () => {
    const component = fixture.componentInstance;
    const source: ImportAsset = {
      id: 'pdf',
      filename: 'score.pdf',
      mime: 'application/pdf',
      size: 100,
      checksum: 'pdf-checksum',
      pageCount: 1,
      width: 612,
      height: 792,
    };
    component.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });
    let rejectBuild!: (reason: Error) => void;
    const client = Reflect.get(component, 'workerClient') as ProcessingWorkerClient;
    vi.spyOn(client, 'run').mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBuild = reject;
      }),
    );
    vi.spyOn(client, 'cancel').mockImplementation(() =>
      rejectBuild(new ProcessingStoppedError('cancelled')),
    );

    const saving = component.save();
    await vi.waitFor(() => expect(component.cancellable()).toBe(true));
    component.cancel();

    expect(component.busy()).toBe(true);
    expect(component.finalizing()).toBe(true);
    await saving;
    expect(component.busy()).toBe(false);
    expect(component.finalizing()).toBe(false);
    expect(component.error()).toBe('Processing cancelled. Your draft and originals are retained.');
  });
});
