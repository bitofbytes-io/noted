import { DatePipe } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { PracticeInput, PracticeSession, WorkSummary } from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';

interface PracticeDraft {
  workId: string;
  durationMinutes: number;
  startMeasure: number | null;
  endMeasure: number | null;
  handPart: string;
  startingBpm: number | null;
  endingBpm: number | null;
  notes: string;
}

export function correctionAssociationPatch(
  originalWorkId: string,
  selectedWorkId: string,
): Pick<PracticeInput, 'movementId' | 'scoreAssetId'> | Record<string, never> {
  return originalWorkId && originalWorkId !== selectedWorkId
    ? { movementId: null, scoreAssetId: null }
    : {};
}

@Component({
  selector: 'app-practice',
  imports: [FormsModule, RouterLink, DatePipe],
  templateUrl: './practice.component.html',
  styleUrl: './practice.component.scss',
})
export class PracticeComponent implements OnInit {
  protected readonly sessions = signal<PracticeSession[]>([]);
  protected readonly works = signal<WorkSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected showManual = false;
  protected selectedTimerWork = '';
  protected editingId = '';
  protected editingWorkId = '';
  protected draft: PracticeDraft = this.emptyDraft();
  protected stopDraft = {
    startMeasure: null as number | null,
    endMeasure: null as number | null,
    endingBpm: null as number | null,
    handPart: '',
    notes: '',
  };

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      await this.timer.initialize();
      const [works, sessions] = await Promise.all([
        firstValueFrom(this.api.works()),
        firstValueFrom(this.api.practiceSessions()),
      ]);
      this.works.set(works.items);
      this.sessions.set(sessions.items.filter((session) => Boolean(session.endedAt)));
      this.selectedTimerWork ||= works.items[0]?.id ?? '';
      this.draft.workId ||= works.items[0]?.id ?? '';
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async startTimer(): Promise<void> {
    if (!this.selectedTimerWork) return;
    try {
      await this.timer.start({ workId: this.selectedTimerWork });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async stopTimer(): Promise<void> {
    try {
      await this.timer.stop(this.stopDraft);
      this.stopDraft = {
        startMeasure: null,
        endMeasure: null,
        endingBpm: null,
        handPart: '',
        notes: '',
      };
      this.success.set('Timed session saved.');
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async saveManual(): Promise<void> {
    this.saving.set(true);
    try {
      const input: PracticeInput = {
        workId: this.draft.workId,
        durationSeconds: Math.round(this.draft.durationMinutes * 60),
        startMeasure: this.draft.startMeasure,
        endMeasure: this.draft.endMeasure,
        handPart: this.draft.handPart,
        startingBpm: this.draft.startingBpm,
        endingBpm: this.draft.endingBpm,
        notes: this.draft.notes,
        ...correctionAssociationPatch(this.editingWorkId, this.draft.workId),
      };
      if (this.editingId) await firstValueFrom(this.api.updatePractice(this.editingId, input));
      else await firstValueFrom(this.api.createPractice(input));
      this.success.set(
        this.editingId ? 'Practice entry corrected.' : 'Manual practice entry saved.',
      );
      this.cancelEdit();
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  edit(session: PracticeSession): void {
    this.editingId = session.id;
    this.editingWorkId = session.workId;
    this.showManual = true;
    this.draft = {
      workId: session.workId,
      durationMinutes: Math.max(1, Math.round(session.durationSeconds / 60)),
      startMeasure: session.startMeasure ?? null,
      endMeasure: session.endMeasure ?? null,
      handPart: session.handPart ?? '',
      startingBpm: session.startingBpm ?? null,
      endingBpm: session.endingBpm ?? null,
      notes: session.notes ?? '',
    };
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async remove(session: PracticeSession): Promise<void> {
    if (
      !window.confirm(
        `Delete the ${this.duration(session.durationSeconds)} practice entry for ${session.workTitle}?`,
      )
    )
      return;
    try {
      await firstValueFrom(this.api.deletePractice(session.id));
      this.sessions.update((items) => items.filter((item) => item.id !== session.id));
      this.success.set('Practice entry deleted.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async discardTimer(): Promise<void> {
    const running = this.timer.running();
    if (!running || !window.confirm(`Discard the running timer for ${running.workTitle}?`)) return;
    try {
      await this.timer.discard();
      this.success.set('Running timer discarded.');
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  cancelEdit(): void {
    this.editingId = '';
    this.editingWorkId = '';
    this.showManual = false;
    this.draft = this.emptyDraft();
    this.draft.workId = this.works()[0]?.id ?? '';
  }

  duration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }

  private emptyDraft(): PracticeDraft {
    return {
      workId: '',
      durationMinutes: 30,
      startMeasure: null,
      endMeasure: null,
      handPart: '',
      startingBpm: null,
      endingBpm: null,
      notes: '',
    };
  }
}
