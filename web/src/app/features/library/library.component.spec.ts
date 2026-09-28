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
