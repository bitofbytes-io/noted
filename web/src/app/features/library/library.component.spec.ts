import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { LibraryComponent } from './library.component';

describe('LibraryComponent', () => {
  it('renders works with learner filters and PDF-only capability state', async () => {
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            tags: () => of({ items: [{ id: 'tag-1', name: 'Sight reading' }] }),
            works: () =>
              of({
                items: [
                  {
                    id: 'work-1',
                    title: 'PDF Work',
                    composer: 'Composer',
                    status: 'Interested',
                    isFavorite: false,
                    tags: ['Sight reading'],
                    hasPdf: true,
                    hasPlayback: false,
                    updatedAt: '2026-07-13T00:00:00Z',
                  },
                ],
              }),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('PDF Work');
    expect(text).toContain('Sight reading');
    const capabilities = fixture.nativeElement.querySelectorAll('.capability');
    expect(capabilities[0].classList).toContain('yes');
    expect(capabilities[1].classList).toContain('no');
  });

  it('highlights the missing composer without sending the invalid form', async () => {
    const api = {
      tags: () => of({ items: [] }),
      works: () => of({ items: [] }),
      createWork: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const component = fixture.componentInstance as unknown as {
      showCreate: boolean;
      draft: { title: string };
    };
    component.showCreate = true;
    component.draft.title = 'Moonlight Sonata';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button[type="submit"]').click();
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('#title');
    const composer = fixture.nativeElement.querySelector('#composer');
    expect(api.createWork).not.toHaveBeenCalled();
    expect(composer.getAttribute('aria-invalid')).toBe('true');
    expect(composer.closest('.field').textContent).toContain('is required');
    expect(title.getAttribute('aria-invalid')).toBe('false');
  });

  it('highlights the field named by a server validation response', async () => {
    const api = {
      tags: () => of({ items: [] }),
      works: () => of({ items: [] }),
      createWork: vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 422,
              error: {
                error: {
                  code: 'validation_failed',
                  message: 'correct the highlighted fields',
                  fields: { title: 'is already in your library' },
                },
              },
            }),
        ),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [provideRouter([]), { provide: ApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const component = fixture.componentInstance as unknown as {
      showCreate: boolean;
      draft: { title: string; composer: string };
    };
    component.showCreate = true;
    component.draft.title = 'Moonlight Sonata';
    component.draft.composer = 'Ludwig van Beethoven';
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button[type="submit"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('#title');
    const composer = fixture.nativeElement.querySelector('#composer');
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.closest('.field').textContent).toContain('is already in your library');
    expect(composer.getAttribute('aria-invalid')).toBe('false');
  });
});
