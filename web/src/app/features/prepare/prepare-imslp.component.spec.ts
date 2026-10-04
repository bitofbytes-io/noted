import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft, IMSLPSearch } from '../../core/models';
import { PrepareImslpComponent } from './prepare-imslp.component';
import { PrepareComponent } from './prepare.component';
import { PrepareApiMock, createPrepareFixture, draft } from './prepare-testing';

describe('PrepareImslpComponent', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, api, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  /** The IMSLP panel, opened on the Source step if it is not showing. */
  const panel = () => {
    fixture.componentInstance.sourceMode.set('imslp');
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(PrepareImslpComponent))
      .componentInstance as PrepareImslpComponent;
  };

  it('keeps work search fallback and prefills selected IMSLP metadata in the same draft', async () => {
    const component = fixture.componentInstance;
    const work = {
      title: 'Prelude',
      composer: 'Example, Ada',
      url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
    };
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [work] }));
    component.sourceMode.set('imslp');
    component.imslp.query = 'Prelude';
    await component.imslp.find();
    fixture.detectChanges();
    expect(api.searchIMSLP).toHaveBeenCalledWith('Prelude');
    expect(fixture.nativeElement.textContent).toContain('Add downloaded PDF');
    panel().selectWork(work);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Draft score',
      composer: 'Example, Ada',
      sourceUrl: work.url,
    });
    expect(component.imslp.link).toBe(work.url);
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
    component.imslp.query = 'Prelude';
    await component.imslp.find();

    for (const state of ['busy', 'finalizing'] as const) {
      component[state].set(true);
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      );
      expect(select.disabled).toBe(true);
      panel().selectWork(work);
      expect(component.draft()?.metadata).toEqual(draft.metadata);
      expect(component.imslp.link).toBe('');
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
    component.imslp.query = 'music';
    await component.imslp.find();
    component.sourceMode.set('imslp');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Showing IMSLP's top matches");

    panel().selectWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: first.title,
      composer: first.composer,
      sourceUrl: first.url,
    });
    panel().selectWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: second.title,
      composer: second.composer,
      sourceUrl: second.url,
    });

    component.updateMetadata('title', 'My printed edition');
    panel().selectWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: first.composer,
      sourceUrl: first.url,
    });
    component.updateMetadata('composer', 'Teacher attribution');
    panel().selectWork(second);
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
    component.imslp.query = 'music';
    await component.imslp.find();
    panel().selectWork(first);
    await component.persist();
    const saved = structuredClone(component.draft()!);
    api.importDraft.mockReturnValue(of(saved));
    await component.load();
    panel().selectWork(second);
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
    component.imslp.query = 'music';
    await component.imslp.find();
    panel().selectWork(first);
    component.updateMetadata('title', 'My printed edition');
    component.updateMetadata('composer', '');
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    panel().selectWork(second);
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
    expect(component.imslp.link).toBe(shared.metadata.sourceUrl);
    expect(component.imslp.added()).toEqual([]);
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
    component.imslp.link = 'https://imslp.org/wiki/Prelude_(Example,_Ada)';
    component.applyIMSLP();
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Prelude',
      composer: 'Example, Ada',
    });
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    component.imslp.link = 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)';
    component.applyIMSLP();
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Nocturne',
      composer: 'Sample, Bea',
      sourceUrl: component.imslp.link,
    });
  });

  it('replaces an auto-owned filename fallback with a selected work title', async () => {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });
    component.imslp.link = 'https://imslp.org/wiki/(Composer,_Name)';
    component.applyIMSLP();
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
    component.imslp.query = 'Nocturne';
    await component.imslp.find();
    panel().selectWork(work);
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
      component.imslp.query = query;
      component.imslp.input();
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
      expect(component.imslp.status()).toBe('idle');
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
      component.imslp.enter(enter);
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
      expect(component.imslp.results()).toEqual([prelude]);
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
      expect(component.imslp.results()).toEqual([]);
      expect(component.imslp.status()).toBe('searching');
      second.next({ status: 'ready', results: [] });
      fixture.detectChanges();
      expect(component.imslp.status()).toBe('ready');
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
      expect(component.imslp.status()).toBe('searching');
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      const old = fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      ) as HTMLButtonElement;
      expect(old.disabled).toBe(true);
      void panel().selectWork(prelude);
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
      expect(component.imslp.status()).not.toBe('ready');
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      expect(
        (
          fixture.nativeElement.querySelector(
            'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      older.next({ status: 'ready', results: [prelude] });
      void panel().selectWork(prelude);
      expect(openWindow).not.toHaveBeenCalled();
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(350);
      fixture.detectChanges();
      expect(api.searchIMSLP).toHaveBeenLastCalledWith('Nocturne');
      expect(component.imslp.results()).toEqual([nocturne]);
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
      expect(component.imslp.status()).toBe('ready');
      expect(component.imslp.results()).toEqual([nocturne]);
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

      const change = fixture.nativeElement.querySelector(
        '.chosen-work button',
      ) as HTMLButtonElement;
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
      expect(component.imslp.results()).toEqual([prelude]);
      expect(fixture.nativeElement.querySelector('.imslp-results.stale')).not.toBeNull();
      expect(linkField().disabled).toBe(false);
      expect(addPDF().disabled).toBe(false);

      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [] }));
      vi.advanceTimersByTime(1000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(3);
      expect(api.searchIMSLP).toHaveBeenLastCalledWith('Prelude in C');
      expect(component.imslp.status()).toBe('ready');
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
      expect(component.imslp.results()).toEqual([]);
      expect(fixture.nativeElement.querySelector('.imslp-link').open).toBe(true);
      expect(linkField().disabled).toBe(false);
      expect(addPDF().disabled).toBe(false);

      // An API error reads the same, and the same query can be tried again.
      api.searchIMSLP.mockReturnValueOnce(throwError(() => new Error('offline')));
      type(component, 'Chopin Nocturne ');
      vi.advanceTimersByTime(350);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(3);
      expect(component.imslp.status()).toBe('unavailable');
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
      expect(component.imslp.status()).toBe('unavailable');
      vi.advanceTimersByTime(120_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

      // A recovered retry shows its results.
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'unavailable', results: [] }));
      api.searchIMSLP.mockReturnValueOnce(of({ status: 'ready', results: [prelude] }));
      type(component, 'Prelude');
      vi.advanceTimersByTime(350 + 30_000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(4);
      expect(component.imslp.status()).toBe('ready');
      expect(component.imslp.results()).toEqual([prelude]);
    });

    it('skips the unavailable retry once the query or panel changed', () => {
      const component = fixture.componentInstance;
      api.searchIMSLP.mockReturnValue(of({ status: 'unavailable', results: [] }));
      type(component, 'Chopin Nocturne');
      vi.advanceTimersByTime(350);
      component.imslp.query = 'Chopin Nocturne Op.9';
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
      expect(component.imslp.status()).toBe('throttled');
      component.setStep('pages');
      vi.advanceTimersByTime(5000);
      expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
      expect(component.imslp.status()).toBe('idle');

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
});
