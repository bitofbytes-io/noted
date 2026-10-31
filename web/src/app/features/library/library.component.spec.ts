import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { MAX_PREPARED_PAGES, Piece, PieceSummary } from '../../core/models';
import { LibraryComponent } from './library.component';
import { TestPiece, testPiece } from './library-testing';

describe('LibraryComponent', () => {
  it('lets a newer load replace an older one still running', async () => {
    const stale = new Subject<PieceSummary[]>();
    const latest = new Subject<PieceSummary[]>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(latest),
      continuePiece: vi.fn(() => of(null)),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture: ComponentFixture<LibraryComponent> = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    expect(stale.observed).toBe(true);

    const latestLoad = component.load();
    expect(stale.observed).toBe(false);
    const latestPiece = testPiece({ id: 'latest', title: 'Latest result' });
    latest.next([latestPiece]);
    latest.complete();
    await latestLoad;

    stale.next([testPiece({ id: 'stale', title: 'Stale result' })]);
    stale.complete();
    expect(Reflect.get(component, 'visible')()).toEqual([latestPiece]);
    fixture.destroy();
  });

  it('filters the loaded library as the search is typed, without asking the server', async () => {
    const pieces = [
      testPiece({ id: 'humoresque', title: 'Humoresque', composer: 'Antonín Dvořák' }),
      testPiece({ id: 'nocturne', title: 'Nocturne in C♯ minor', composer: 'Frédéric Chopin' }),
      testPiece({
        id: 'prelude',
        title: 'Prelude Op. 28 No. 4',
        composer: 'Frédéric Chopin',
        notes: 'Keep the left hand quiet',
      }),
      testPiece({
        id: 'shelved',
        title: 'Gymnopédie No. 1',
        composer: 'Erik Satie',
        status: 'shelved',
      }),
    ];
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current', librarySort: 'title' })),
      pieceSummaries: vi.fn(() => of(pieces)),
      continuePiece: vi.fn(() => of(null)),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('.search input') as HTMLInputElement;
    const type = (text: string) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      return [...root.querySelectorAll('.piece-row h2')].map((h) => h.textContent);
    };

    expect(type('')).toEqual(['Humoresque', 'Nocturne in C♯ minor', 'Prelude Op. 28 No. 4']);
    // Accents fold away, and every word must match, in any field.
    expect(type('dvorak')).toEqual(['Humoresque']);
    expect(type('chopin c#')).toEqual(['Nocturne in C♯ minor']);
    // Notes are searched through the search text the server folded.
    expect(type('left hand')).toEqual(['Prelude Op. 28 No. 4']);
    // A search never hides a shelved piece.
    expect(type('satie')).toEqual(['Gymnopédie No. 1']);
    expect(root.querySelector('.results-count p')?.textContent?.replace(/\s+/g, ' ')).toContain(
      '1 piece matching “satie”',
    );
    expect(type('chopin waltz')).toEqual([]);
    expect(root.querySelector('.empty-state h2')?.textContent).toBe('No matching pieces');
    // Whole terms outrank prefixes, even a title prefix; remaining matches further in.
    expect(type('no')).toEqual([
      'Gymnopédie No. 1',
      'Prelude Op. 28 No. 4',
      'Nocturne in C♯ minor',
    ]);
    expect(api.pieceSummaries).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('adds or replaces a PDF only through Prepare, and explains the page limit', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([])),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn(),
      createImport: vi.fn(() => of({ id: 'draft-1' })),
      updatePiece: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    const piece = (pageCount: number | null) =>
      testPiece({
        id: `piece-${pageCount ?? 'none'}`,
        title: 'Score',
        pdf:
          pageCount === null
            ? null
            : ({ pageCount, contentUrl: '/api/pieces/x/pdf' } as Piece['pdf']),
      });
    const render = () => {
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    // The details form reads the whole piece first.
    const openEdit = async (whole: TestPiece) => {
      api.piece.mockReturnValueOnce(of(whole));
      await component.openEdit(whole);
      expect(api.piece).toHaveBeenLastCalledWith(whole.id);
    };
    const actions = () =>
      [...fixture.nativeElement.querySelectorAll('.pdf-actions button, .pdf-actions a')].map(
        (action) => action.textContent.trim(),
      );
    const prepareButton = () =>
      fixture.nativeElement.querySelector('.pdf-actions button') as HTMLButtonElement;

    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();

    await openEdit(piece(null));
    render();
    expect(actions()).toEqual(['Add PDF']);
    prepareButton().click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.createImport).toHaveBeenLastCalledWith('piece-none');
    expect(navigate).toHaveBeenLastCalledWith(['/prepare', 'draft-1'], {
      queryParams: { source: 'all' },
    });

    await openEdit(piece(MAX_PREPARED_PAGES));
    render();
    expect(actions()).toEqual(['Edit or replace PDF', 'Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit')).toBeNull();
    prepareButton().click();
    await vi.waitFor(() =>
      expect(api.createImport).toHaveBeenLastCalledWith(`piece-${MAX_PREPARED_PAGES}`),
    );

    api.createImport.mockClear();
    await openEdit(piece(MAX_PREPARED_PAGES + 1));
    render();
    expect(actions()).toEqual(['Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit').textContent).toContain(
      `up to ${MAX_PREPARED_PAGES} pages, so this score’s PDF`,
    );
    await component.editPages();
    expect(api.createImport).not.toHaveBeenCalled();
    expect(api.updatePiece).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('edits the other names a piece is searched by', async () => {
    const saved = testPiece({
      id: 'sonata',
      title: 'Piano Sonata No. 14',
      composer: 'Ludwig van Beethoven',
      notes: 'Pedal through each bar',
      sourceUrl: 'https://example.test/sonata',
    });
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([saved])),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn(() =>
        of({ ...saved, aliases: 'Moonlight', opus: 'Op. 27 No. 2', musicKey: 'C♯ minor' }),
      ),
      updatePiece: vi.fn((_id: string, input: Partial<Piece>) => of({ ...saved, ...input })),
      createPiece: vi.fn((input: Partial<Piece>) => of({ ...saved, ...input, id: 'new' })),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    const aliasesInput = () =>
      fixture.nativeElement.querySelector('input[name="aliases"]') as HTMLInputElement;

    // A library row has no notes or source; the form reads them from the whole piece.
    await component.openEdit(saved);
    expect(api.piece).toHaveBeenCalledWith('sonata');
    // The form fills itself once the whole piece arrives, with no change detection forced here.
    await fixture.whenStable();
    expect(aliasesInput().value).toBe('Moonlight');
    const opusInput = fixture.nativeElement.querySelector('input[name="opus"]') as HTMLInputElement;
    const keyInput = fixture.nativeElement.querySelector(
      'input[name="musicKey"]',
    ) as HTMLInputElement;
    expect(opusInput.value).toBe('Op. 27 No. 2');
    expect(keyInput.value).toBe('C♯ minor');
    opusInput.value = '';
    opusInput.dispatchEvent(new Event('input'));
    keyInput.value = 'D minor';
    keyInput.dispatchEvent(new Event('input'));
    expect(
      (fixture.nativeElement.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value,
    ).toBe('Pedal through each bar');
    expect(fixture.nativeElement.querySelector('.editor-head h2').textContent).toBe(
      'Piano Sonata No. 14',
    );
    expect(Reflect.get(component, 'form').notes).toBe('Pedal through each bar');
    expect(Reflect.get(component, 'form').sourceUrl).toBe('https://example.test/sonata');
    aliasesInput().value = 'Moonlight Sonata';
    aliasesInput().dispatchEvent(new Event('input'));
    await component.save();
    expect(api.updatePiece).toHaveBeenCalledWith(
      'sonata',
      expect.objectContaining({
        aliases: 'Moonlight Sonata',
        notes: 'Pedal through each bar',
        opus: '',
        musicKey: 'D minor',
      }),
    );
    // Saving reloads the library from the server.
    expect(api.pieceSummaries).toHaveBeenCalledTimes(2);

    component.openCreate();
    expect(Reflect.get(component, 'form').aliases).toBe('');
    fixture.destroy();
  });

  it('treats a search of punctuation alone as no search', async () => {
    // The default view is empty, but the binder holds a shelved piece.
    const shelved = testPiece({ id: 'shelved', title: 'Shelved', status: 'shelved' });
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current' })),
      pieceSummaries: vi.fn(() => of([shelved])),
      continuePiece: vi.fn(() => of(null)),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;

    const query = Reflect.get(component, 'query');
    query.set(' % ');
    expect(Reflect.get(component, 'onlyShelved')()).toBe(true);
    expect(Reflect.get(component, 'visible')()).toEqual([]);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.results-count p')?.textContent).not.toContain('matching');
    expect(root.querySelector('.empty-state h2')?.textContent).toBe(
      'Nothing in Learning or Playing',
    );

    query.set('Dvořák');
    expect(Reflect.get(component, 'onlyShelved')()).toBe(false);
    fixture.destroy();
  });
});
