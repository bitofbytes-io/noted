import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { PieceSummary } from '../../core/models';
import { SuggestionsComponent } from './suggestions.component';

const piece = (id: string): PieceSummary => ({
  id,
  title: `Prelude ${id}`,
  composer: 'Rachmaninoff',
  aliases: '',
  favorite: false,
  status: 'playing',
  listeningUrl: '',
  lastPlayedAt: null,
  createdAt: '',
  pdf: null,
  searchText: 'prelude rachmaninoff',
});
async function setup() {
  const api = {
    suggestPieces: vi.fn<(q: string, filter: string) => Observable<PieceSummary[]>>(() =>
      of([piece('similar')]),
    ),
  };
  await TestBed.configureTestingModule({
    imports: [SuggestionsComponent],
    providers: [{ provide: ApiService, useValue: api }],
  }).compileComponents();
  const fixture = TestBed.createComponent(SuggestionsComponent);
  fixture.componentRef.setInput('owner', 'owner-a');
  fixture.componentRef.setInput('enabled', true);
  fixture.detectChanges();
  vi.useFakeTimers();
  const change = (name: string, value: unknown) => {
    fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };
  return { api, fixture, change, component: fixture.componentInstance };
}
afterEach(() => vi.useRealTimers());
describe('Additional library matches', () => {
  it('debounces eligible queries, preserving exact results and emitting an owned piece', async () => {
    const { api, fixture, change, component } = await setup();
    change('query', 'ra');
    vi.advanceTimersByTime(500);
    expect(api.suggestPieces).not.toHaveBeenCalled();
    change('query', 'rachman');
    vi.advanceTimersByTime(100);
    change('query', 'rachmaninov');
    change('exact', [piece('exact')]);
    vi.advanceTimersByTime(249);
    expect(api.suggestPieces).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(api.suggestPieces).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain('Similar matches');
    const opened = vi.fn();
    component.openPiece.subscribe(opened);
    fixture.nativeElement.querySelector('button').click();
    expect(opened).toHaveBeenCalledWith(piece('similar'));
    fixture.destroy();
  });
  it('clears immediately and cancels old responses on query, filter and session changes', async () => {
    const { api, fixture, change, component } = await setup();
    const old = new Subject<PieceSummary[]>();
    const current = new Subject<PieceSummary[]>();
    api.suggestPieces.mockReturnValueOnce(old).mockReturnValueOnce(current);
    change('query', 'rachmaninov');
    vi.advanceTimersByTime(250);
    old.next([piece('old')]);
    expect(component.results()).toHaveLength(1);
    change('query', 'tchaikovsky');
    expect(component.results()).toEqual([]);
    expect(old.observed).toBe(false);
    vi.advanceTimersByTime(250);
    current.next([piece('new')]);
    old.next([piece('stale')]);
    expect(component.results()[0].id).toBe('new');
    change('filter', 'shelved');
    expect(component.results()).toEqual([]);
    expect(current.observed).toBe(false);
    vi.advanceTimersByTime(250);
    expect(api.suggestPieces).toHaveBeenLastCalledWith('tchaikovsky', 'shelved');
    change('owner', '');
    expect(component.results()).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(api.suggestPieces).toHaveBeenCalledTimes(3);
    fixture.destroy();
  });
  it('deduplicates exact rows and handles offline/throttled results without changing the query', async () => {
    const { api, fixture, change, component } = await setup();
    api.suggestPieces.mockReturnValueOnce(of([piece('exact'), piece('similar')]));
    change('exact', [piece('exact')]);
    change('query', 'rachmaninov');
    vi.advanceTimersByTime(250);
    expect(component.results().map((p) => p.id)).toEqual(['similar']);
    api.suggestPieces.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 503 })));
    change('query', 'tchaikovsky');
    vi.advanceTimersByTime(250);
    expect(component.results()).toEqual([]);
    expect(component.message()).toContain('library results are still available');
    expect(component.query).toBe('tchaikovsky');
    api.suggestPieces.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 429 })));
    change('query', 'rachmaninoff');
    vi.advanceTimersByTime(250);
    expect(component.message()).toContain('Try again shortly');
    change('query', '');
    expect(component.message()).toBe('');
    expect(component.results()).toEqual([]);
    fixture.destroy();
  });
  it('never sends punctuation, numeric, oversized or excessive-term requests and cancels on destroy', async () => {
    const { api, fixture, change } = await setup();
    for (const q of [
      '%_',
      '12345',
      'op28',
      'c# minor',
      'Eb',
      'C#',
      'es-dur',
      'x'.repeat(201),
      'word '.repeat(9),
    ]) {
      change('query', q);
      vi.advanceTimersByTime(500);
    }
    expect(api.suggestPieces).not.toHaveBeenCalled();
    const pending = new Subject<PieceSummary[]>();
    api.suggestPieces.mockReturnValue(pending);
    change('query', 'chopin');
    vi.advanceTimersByTime(250);
    expect(pending.observed).toBe(true);
    fixture.destroy();
    expect(pending.observed).toBe(false);
  });
});
