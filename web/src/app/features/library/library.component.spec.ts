import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
});
