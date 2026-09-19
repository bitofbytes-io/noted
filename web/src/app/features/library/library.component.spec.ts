import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece } from '../../core/models';
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
