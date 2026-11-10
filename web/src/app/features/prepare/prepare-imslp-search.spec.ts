import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMSLPSearch } from '../../core/models';
import { PrepareImslpComponent } from './prepare-imslp.component';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { PrepareApiMock, createPrepareFixture } from './prepare-testing';

describe('IMSLP live search', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  const prelude = {
    title: 'Prelude',
    composer: 'Example, Ada',
    url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
  };
  const nocturne = {
    title: 'Nocturne',
    composer: 'Sample, Bea',
    url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
  };
  const type = (component: PrepareStore, query: string) => {
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
  const panel = () =>
    fixture.debugElement.query(By.directive(PrepareImslpComponent))
      .componentInstance as PrepareImslpComponent;
  const resultButton = (work: typeof prelude) =>
    fixture.nativeElement.querySelector(
      `button[aria-label="Open ${work.title} by ${work.composer} on IMSLP"]`,
    ) as HTMLButtonElement;

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

  it('sends nothing below two characters and shows the idle hint', () => {
    const component = store;
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
    const component = store;
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
    const component = store;
    type(component, 'Prelude');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    component.imslp.enter(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(api.searchIMSLP).toHaveBeenCalledWith('Prelude');
    vi.advanceTimersByTime(1000);
    expect(api.searchIMSLP).toHaveBeenCalledTimes(1);
  });

  it('skips a repeated query and answers earlier queries from the page cache', () => {
    const component = store;
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
    const component = store;
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
    const component = store;
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
    expect(resultButton(prelude).disabled).toBe(true);
    void panel().selectWork(prelude);
    expect(openWindow).not.toHaveBeenCalled();
    expect(component.draft()?.metadata.sourceUrl).toBe('');

    pending.next({ status: 'ready', results: [nocturne] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.imslp-results.stale')).toBeNull();
    expect(resultButton(nocturne).disabled).toBe(false);
  });

  it('marks results stale as soon as the query changes, before the debounce', () => {
    const component = store;
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
    expect(resultButton(prelude).disabled).toBe(true);
    older.next({ status: 'ready', results: [prelude] });
    void panel().selectWork(prelude);
    expect(openWindow).not.toHaveBeenCalled();
    expect(api.searchIMSLP).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(350);
    fixture.detectChanges();
    expect(api.searchIMSLP).toHaveBeenLastCalledWith('Nocturne');
    expect(component.imslp.results()).toEqual([nocturne]);
    expect(fixture.nativeElement.querySelector('.imslp-results.stale')).toBeNull();
    expect(resultButton(nocturne).disabled).toBe(false);
  });

  it('keeps ready results selectable when the same query is retyped', () => {
    const component = store;
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
    const component = store;
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

  it('keeps earlier results faded while throttled and retries once the limit refills', () => {
    const component = store;
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
    const component = store;
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
    const component = store;
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
    const component = store;
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
    const component = store;
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
});
