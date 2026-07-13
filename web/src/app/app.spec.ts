import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { App } from './app';
import { ApiService } from './core/api.service';

describe('App navigation', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            session: () =>
              of({
                authMode: 'development',
                development: true,
                user: {
                  id: 'u1',
                  email: 'learner@noted.local',
                  displayName: 'Local learner',
                  weekStartsOn: 1,
                  metronomeBpm: 96,
                  metronomeAccent: true,
                },
              }),
          },
        },
      ],
    }).compileComponents();
  });

  it('renders all five required primary destinations', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const nodes = fixture.nativeElement.querySelectorAll(
      '.bottom-nav small',
    ) as NodeListOf<Element>;
    const labels = Array.from(nodes).map((node) => node.textContent?.trim());
    expect(labels).toEqual(['Home', 'Library', 'Metronome', 'Practice', 'Settings']);
    expect(fixture.nativeElement.textContent).toContain('Local learner');
    expect(fixture.nativeElement.textContent).toContain('DEV');
  });
});
