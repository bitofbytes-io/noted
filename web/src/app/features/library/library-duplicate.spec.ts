import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { Piece } from '../../core/models';
import { LibraryComponent } from './library.component';
import { summaryOf } from './library.utils';

describe('Library duplicate title warning', () => {
  it('updates on actual typing, excludes self and remains advisory across filters', async () => {
    const edited: Piece = {
      id: 'edited',
      title: 'Nocturne',
      composer: '',
      favorite: false,
      status: 'playing',
      sourceUrl: '',
      listeningUrl: '',
      notes: '',
      aliases: '',
      createdAt: '2026-10-20T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
      lastPlayedAt: null,
      pdf: null,
    };
    const existing: Piece = { ...edited, id: 'existing', title: 'Prélude', status: 'shelved' };
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      preferences: vi.fn(() => of({ libraryFilter: 'current', librarySort: 'title' })),
      pieceSummaries: vi.fn(() => of([summaryOf(edited), summaryOf(existing)])),
      continuePiece: vi.fn(() => of(null)),
      piece: vi.fn(() => of(edited)),
      updatePiece: vi.fn((id: string, input: object) => of({ ...edited, ...input, id })),
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
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    await fixture.componentInstance.openEdit(summaryOf(edited));
    fixture.detectChanges();
    const input = dialog.querySelector('input[name="title"]') as HTMLInputElement;
    const warning = () => dialog.querySelector('#duplicate-title-warning');
    const type = async (title: string) => {
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    expect(warning()).toBeNull();
    await type('  PRELUDE  ');
    expect(warning()?.textContent).toContain('Already in your library as Prélude');
    expect(input.getAttribute('aria-describedby')).toBe('duplicate-title-warning');
    expect((dialog.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    await type('Different piece');
    expect(warning()).toBeNull();
    await type('');
    expect(warning()).toBeNull();
    await type('  NOCTURNE ');
    expect(warning()).toBeNull();
    await type('Prélude');
    expect(warning()).not.toBeNull();
    expect(api.pieceSummaries).toHaveBeenCalledOnce();
    (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(api.updatePiece).toHaveBeenCalledWith(
      'edited',
      expect.objectContaining({ title: 'Prélude' }),
    );
    fixture.destroy();
  });
});
