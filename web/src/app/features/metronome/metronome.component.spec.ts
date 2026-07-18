import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { MetronomeComponent } from './metronome.component';

describe('MetronomeComponent meter controls', () => {
  it('renders one dot per saved beat and offers all sound profiles', async () => {
    await TestBed.configureTestingModule({
      imports: [MetronomeComponent],
      providers: [
        {
          provide: ApiService,
          useValue: {
            preferences: () =>
              of({
                weekStartsOn: 1,
                metronomeBpm: 96,
                metronomeAccent: true,
                metronomeBeatsPerBar: 3,
                metronomeSound: 'woodblock',
              }),
            updatePreferences: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(MetronomeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.beat-dots span')).toHaveLength(3);
    expect(fixture.nativeElement.querySelectorAll('.sound-control option')).toHaveLength(3);

    (fixture.nativeElement.querySelector('.meter-options button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.beat-dots span')).toHaveLength(1);
    fixture.destroy();
  });
});
