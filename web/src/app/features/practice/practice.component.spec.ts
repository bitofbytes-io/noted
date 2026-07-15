import { PracticeSession } from '../../core/models';
import { ApiService } from '../../core/api.service';
import { PracticeTimerService } from '../../core/practice-timer.service';
import {
  defaultManualStart,
  PracticeComponent,
  practiceDraftFromSession,
  toLocalDateTimeInput,
  toPracticeTimestamp,
} from './practice.component';

describe('practice entry drafts', () => {
  it('defaults completed practice to an elapsed start instead of a future end', () => {
    const openedAt = new Date(2031, 4, 6, 14, 35, 12);
    const startedAt = new Date(toPracticeTimestamp(defaultManualStart(30, openedAt)));
    expect(startedAt.getTime() + 30 * 60_000).toBe(openedAt.getTime());
  });

  it('refreshes the elapsed default after an unsaved new entry is closed and reopened', async () => {
    vi.useFakeTimers();
    try {
      const component = new PracticeComponent({} as ApiService, {} as PracticeTimerService) as any;
      vi.setSystemTime(new Date(2031, 4, 6, 14, 35, 12));
      await component.toggleManual();
      const firstStart = component.draft.startedAtLocal;
      await component.toggleManual();

      vi.setSystemTime(new Date(2031, 4, 6, 16, 5, 12));
      await component.toggleManual();
      expect(component.draft.startedAtLocal).not.toBe(firstStart);
      expect(component.draft.startedAtLocal).toBe(
        defaultManualStart(component.draft.durationMinutes, new Date()),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an automatic start aligned to duration edits without replacing an explicit start', async () => {
    vi.useFakeTimers();
    try {
      const component = new PracticeComponent({} as ApiService, {} as PracticeTimerService) as any;
      vi.setSystemTime(new Date(2031, 4, 6, 14, 35, 12));
      await component.toggleManual();

      component.onManualDurationChange(60);
      expect(component.draft.startedAtLocal).toBe(defaultManualStart(60, new Date()));

      const explicitStart = '2031-05-05T08:15:00';
      component.onManualStartChange(explicitStart);
      component.onManualDurationChange(90);
      expect(component.draft.startedAtLocal).toBe(explicitStart);
    } finally {
      vi.useRealTimers();
    }
  });

  it('round-trips the local date/time input without moving the instant', () => {
    const instant = new Date(2031, 4, 6, 14, 35, 12);
    expect(toPracticeTimestamp(toLocalDateTimeInput(instant))).toBe(instant.toISOString());
  });

  it('preserves every optional field while preparing a correction', () => {
    const session: PracticeSession = {
      id: 'session-1',
      workId: 'work-1',
      workTitle: 'Work',
      movementId: 'movement-1',
      scoreAssetId: 'asset-1',
      startedAt: '2031-05-06T18:35:12.000Z',
      endedAt: '2031-05-06T18:55:12.000Z',
      durationSeconds: 1200,
      entryMethod: 'manual',
      startMeasure: 2,
      endMeasure: 7,
      handPart: 'RH',
      startingBpm: 72,
      endingBpm: 88,
      notes: 'Focused correction',
    };
    const draft = practiceDraftFromSession(session);
    expect(draft).toMatchObject({
      workId: 'work-1',
      movementId: 'movement-1',
      scoreAssetId: 'asset-1',
      durationMinutes: 20,
      startMeasure: 2,
      endMeasure: 7,
      handPart: 'RH',
      startingBpm: 72,
      endingBpm: 88,
      notes: 'Focused correction',
    });
    expect(toPracticeTimestamp(draft.startedAtLocal)).toBe(session.startedAt);
  });
});
