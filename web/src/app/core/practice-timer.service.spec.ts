import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from './api.service';
import { PracticeTimerService } from './practice-timer.service';

describe('PracticeTimerService', () => {
  it('starts only through the explicit API command and clears after stop', async () => {
    const started = {
      id: 'session-1',
      workId: 'work-1',
      workTitle: 'Exercise',
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      entryMethod: 'timer' as const,
    };
    const api = {
      practiceSessions: () => of({ items: [] }),
      startPractice: () => of(started),
      stopPractice: () =>
        of({ ...started, endedAt: new Date().toISOString(), durationSeconds: 30 }),
    };
    TestBed.configureTestingModule({
      providers: [PracticeTimerService, { provide: ApiService, useValue: api }],
    });
    const service = TestBed.inject(PracticeTimerService);

    await service.initialize();
    expect(service.running()).toBeNull();
    await service.start({ workId: 'work-1' });
    expect(service.running()?.id).toBe('session-1');
    await service.stop({ notes: 'Focused repetition' });
    expect(service.running()).toBeNull();
  });
});
