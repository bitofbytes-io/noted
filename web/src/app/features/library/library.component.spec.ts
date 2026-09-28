import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { MAX_PREPARED_PAGES, Piece } from '../../core/models';
import { LibraryComponent } from './library.component';
import { listeningUrlError, titleFromFilename } from './library.utils';

describe('LibraryComponent', () => {
  it('cancels a stale search so it cannot replace newer results', async () => {
    const stale = new Subject<Piece[]>();
    const latest = new Subject<Piece[]>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      pieces: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(latest),
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
    Reflect.set(component, 'query', 'new search');

    const latestLoad = component.load();
    expect(stale.observed).toBe(false);
    const latestPiece = { id: 'latest', title: 'Latest result' } as Piece;
    latest.next([latestPiece]);
    latest.complete();
    await latestLoad;

    stale.next([{ id: 'stale', title: 'Stale result' } as Piece]);
    stale.complete();
    expect(Reflect.get(component, 'pieces')()).toEqual([latestPiece]);
    fixture.destroy();
  });

  it('ignores a PDF read that finishes after its editor session or selection was replaced', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      pieces: vi.fn(() => of([])),
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
    const tasks: { finish: (pages: number) => void; destroy: ReturnType<typeof vi.fn> }[] = [];
    vi.spyOn(component as unknown as { openPdf: () => unknown }, 'openPdf').mockImplementation(
      () => {
        let finish!: (value: { numPages: number }) => void;
        const promise = new Promise<{ numPages: number }>((resolve) => (finish = resolve));
        const destroy = vi.fn(() => Promise.resolve());
        tasks.push({ finish: (numPages) => finish({ numPages }), destroy });
        return { promise, destroy };
      },
    );
    const choose = (name: string) => {
      const input = document.createElement('input');
      const file = { name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
      Object.defineProperty(input, 'files', { value: [file] });
      return component.choosePdf({ target: input } as unknown as Event);
    };
    const piece = (id: string) =>
      ({
        id,
        title: id,
        composer: '',
        favorite: false,
        sourceUrl: '',
        listeningUrl: '',
        notes: '',
        pdf: null,
      }) as unknown as Piece;
    const state = () => ({
      file: Reflect.get(component, 'selectedFile')?.name ?? null,
      pages: Reflect.get(component, 'selectedPageCount'),
      reading: Reflect.get(component, 'readingPdf')(),
    });

    component.openEdit(piece('A'));
    const staleSession = choose('replacement-for-A.pdf');
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    component.closeEditor();
    component.openEdit(piece('B'));
    expect(tasks[0].destroy).toHaveBeenCalled();
    tasks[0].finish(9);
    await staleSession;
    expect(state()).toEqual({ file: null, pages: 0, reading: false });

    const older = choose('older.pdf');
    await vi.waitFor(() => expect(tasks).toHaveLength(2));
    const newer = choose('newer.pdf');
    await vi.waitFor(() => expect(tasks).toHaveLength(3));
    expect(tasks[1].destroy).toHaveBeenCalled();
    tasks[2].finish(2);
    await newer;
    tasks[1].finish(7);
    await older;
    expect(state()).toEqual({ file: 'newer.pdf', pages: 2, reading: false });
    expect(tasks[2].destroy).toHaveBeenCalled();
    fixture.destroy();
  });

  it('disables page editing for a score longer than the preparation limit', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      pieces: vi.fn(() => of([])),
      createImport: vi.fn(),
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
    const piece = (pageCount: number) =>
      ({
        id: `piece-${pageCount}`,
        title: 'Score',
        composer: '',
        favorite: false,
        sourceUrl: '',
        listeningUrl: '',
        notes: '',
        pdf: { pageCount, contentUrl: '/api/pieces/x/pdf' },
      }) as Piece;
    const editPagesButton = () =>
      [...fixture.nativeElement.querySelectorAll('.pdf-actions button')].find((button) =>
        button.textContent.includes('Edit pages'),
      ) as HTMLButtonElement;

    const render = () => {
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };

    component.openEdit(piece(MAX_PREPARED_PAGES + 1));
    render();
    expect(editPagesButton().disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit').textContent).toContain(
      `up to ${MAX_PREPARED_PAGES} pages`,
    );
    await component.editPages();
    expect(api.createImport).not.toHaveBeenCalled();

    component.openEdit(piece(MAX_PREPARED_PAGES));
    render();
    expect(editPagesButton().disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit')).toBeNull();
    fixture.destroy();
  });
});

describe('titleFromFilename', () => {
  it('turns a scan filename into an editable title', () => {
    expect(titleFromFilename('bach_wtc-prelude-01.PDF')).toBe('bach wtc prelude 01');
  });
});

describe('listeningUrlError', () => {
  it('accepts empty and absolute HTTP(S) listening URLs', () => {
    expect(listeningUrlError('')).toBe('');
    expect(listeningUrlError('  https://www.youtube.com/watch?v=example  ')).toBe('');
  });

  it('rejects malformed and non-HTTP(S) listening URLs with a clear message', () => {
    expect(listeningUrlError('youtube.com/watch?v=example')).toBe(
      'listening URL must be an http or https URL',
    );
    expect(listeningUrlError('file:///tmp/recording.mp3')).toBe(
      'listening URL must be an http or https URL',
    );
  });
});
