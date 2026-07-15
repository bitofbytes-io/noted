import { DatePipe } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { PracticeInput, PracticeSession, WorkDetail, WorkSummary } from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';

export interface PracticeDraft {
  workId: string;
  startedAtLocal: string;
  durationMinutes: number;
  movementId: string;
  scoreAssetId: string;
  startMeasure: number | null;
  endMeasure: number | null;
  handPart: string;
  startingBpm: number | null;
  endingBpm: number | null;
  notes: string;
}

export function toLocalDateTimeInput(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function toPracticeTimestamp(localValue: string): string {
  const value = new Date(localValue);
  if (Number.isNaN(value.getTime()))
    throw new Error('Choose a valid practice start date and time.');
  return value.toISOString();
}

export function defaultManualStart(durationMinutes: number, now = new Date()): string {
  const elapsedMinutes = Math.max(1, Math.round(durationMinutes || 1));
  return toLocalDateTimeInput(new Date(now.getTime() - elapsedMinutes * 60_000));
}

export function practiceDraftFromSession(session: PracticeSession): PracticeDraft {
  return {
    workId: session.workId,
    startedAtLocal: toLocalDateTimeInput(session.startedAt),
    durationMinutes: Math.max(1, Math.round(session.durationSeconds / 60)),
    movementId: session.movementId ?? '',
    scoreAssetId: session.scoreAssetId ?? '',
    startMeasure: session.startMeasure ?? null,
    endMeasure: session.endMeasure ?? null,
    handPart: session.handPart ?? '',
    startingBpm: session.startingBpm ?? null,
    endingBpm: session.endingBpm ?? null,
    notes: session.notes ?? '',
  };
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
  protected readonly selectedWork = signal<WorkDetail | null>(null);
  protected readonly optionsLoading = signal(false);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected showManual = false;
  protected selectedTimerWork = '';
  protected editingId = '';
  protected draft: PracticeDraft = this.emptyDraft();
  protected manualStartEdited = false;
  protected stopDraft = {
    startMeasure: null as number | null,
    endMeasure: null as number | null,
    endingBpm: null as number | null,
    handPart: '',
    notes: '',
  };
  private optionsRequest = 0;

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
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
      if (this.draft.workId) await this.loadPracticeOptions(this.draft.workId, true);
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
      if (!this.editingId && !this.manualStartEdited) {
        this.draft.startedAtLocal = defaultManualStart(this.draft.durationMinutes);
      }
      const input: PracticeInput = {
        workId: this.draft.workId,
        startedAt: toPracticeTimestamp(this.draft.startedAtLocal),
        durationSeconds: Math.round(this.draft.durationMinutes * 60),
        movementId: this.draft.movementId || null,
        scoreAssetId: this.draft.scoreAssetId || null,
        startMeasure: this.draft.startMeasure,
        endMeasure: this.draft.endMeasure,
        handPart: this.draft.handPart,
        startingBpm: this.draft.startingBpm,
        endingBpm: this.draft.endingBpm,
        notes: this.draft.notes,
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

  async edit(session: PracticeSession): Promise<void> {
    this.editingId = session.id;
    this.showManual = true;
    this.manualStartEdited = true;
    this.draft = practiceDraftFromSession(session);
    await this.loadPracticeOptions(session.workId, true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async onManualWorkChange(workId: string): Promise<void> {
    this.draft.workId = workId;
    this.draft.movementId = '';
    this.draft.scoreAssetId = '';
    await this.loadPracticeOptions(workId, false);
  }

  protected onManualStartChange(startedAtLocal: string): void {
    this.draft.startedAtLocal = startedAtLocal;
    this.manualStartEdited = true;
  }

  protected onManualDurationChange(durationMinutes: number): void {
    this.draft.durationMinutes = durationMinutes;
    if (!this.editingId && !this.manualStartEdited) {
      this.draft.startedAtLocal = defaultManualStart(durationMinutes);
    }
  }

  async toggleManual(): Promise<void> {
    const opening = !this.showManual;
    this.showManual = opening;
    if (!opening) {
      if (!this.editingId) {
        const workId = this.draft.workId;
        this.draft = this.emptyDraft();
        this.draft.workId = workId;
        this.manualStartEdited = false;
      }
      return;
    }
    if (!this.editingId) {
      this.manualStartEdited = false;
      this.draft.startedAtLocal = defaultManualStart(this.draft.durationMinutes);
    }
    if (this.draft.workId) await this.loadPracticeOptions(this.draft.workId, true);
  }

  protected scoreOptions(): { id: string; label: string }[] {
    return (
      this.selectedWork()?.editions.flatMap((edition) =>
        edition.assets.map((asset) => ({
          id: asset.id,
          label: `${edition.name} — ${asset.originalFilename}`,
        })),
      ) ?? []
    );
  }

  protected movementMeasureCount(): number | null {
    return (
      this.selectedWork()?.movements.find((movement) => movement.id === this.draft.movementId)
        ?.measureCount ?? null
    );
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
    this.showManual = false;
    this.manualStartEdited = false;
    this.draft = this.emptyDraft();
    this.draft.workId = this.works()[0]?.id ?? '';
    if (this.draft.workId) void this.loadPracticeOptions(this.draft.workId, true);
  }

  duration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }

  private emptyDraft(): PracticeDraft {
    return {
      workId: '',
      startedAtLocal: '',
      durationMinutes: 30,
      movementId: '',
      scoreAssetId: '',
      startMeasure: null,
      endMeasure: null,
      handPart: '',
      startingBpm: null,
      endingBpm: null,
      notes: '',
    };
  }

  private async loadPracticeOptions(workId: string, preserveAssociations: boolean): Promise<void> {
    const request = ++this.optionsRequest;
    if (!workId) {
      this.selectedWork.set(null);
      return;
    }
    this.optionsLoading.set(true);
    try {
      const detail = await firstValueFrom(this.api.work(workId));
      if (request !== this.optionsRequest) return;
      this.selectedWork.set(detail);
      if (!preserveAssociations) {
        this.draft.movementId = '';
        this.draft.scoreAssetId = '';
      }
    } catch (error) {
      if (request === this.optionsRequest) this.error.set(errorMessage(error));
    } finally {
      if (request === this.optionsRequest) this.optionsLoading.set(false);
    }
  }
}
