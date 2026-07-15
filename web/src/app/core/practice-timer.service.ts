import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { PracticeInput, PracticeSession } from './models';

@Injectable({ providedIn: 'root' })
export class PracticeTimerService {
  readonly running = signal<PracticeSession | null>(null);
  readonly elapsedSeconds = signal(0);
  readonly busy = signal(false);
  private tick?: ReturnType<typeof setInterval>;
  private initialized = false;

  constructor(private readonly api: ApiService) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const response = await firstValueFrom(this.api.practiceSessions());
    const active = response.items.find((session) => !session.endedAt) ?? null;
    this.running.set(active);
    if (active) this.startClock(active.startedAt);
  }

  async start(input: PracticeInput): Promise<PracticeSession> {
    this.busy.set(true);
    try {
      const session = await firstValueFrom(this.api.startPractice(input));
      this.running.set(session);
      this.startClock(session.startedAt);
      return session;
    } finally {
      this.busy.set(false);
    }
  }

  async stop(input: PracticeInput): Promise<PracticeSession> {
    const current = this.running();
    if (!current) throw new Error('No practice timer is running');
    this.busy.set(true);
    try {
      const session = await firstValueFrom(this.api.stopPractice(current.id, input));
      this.running.set(null);
      this.clearClock();
      return session;
    } finally {
      this.busy.set(false);
    }
  }

  async discard(): Promise<void> {
    const current = this.running();
    if (!current) throw new Error('No practice timer is running');
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deletePractice(current.id));
      this.running.set(null);
      this.clearClock();
    } finally {
      this.busy.set(false);
    }
  }

  formatElapsed(): string {
    const total = this.elapsedSeconds();
    const hours = Math.floor(total / 3600)
      .toString()
      .padStart(2, '0');
    const minutes = Math.floor((total % 3600) / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (total % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  private startClock(startedAt: string): void {
    this.clearClock();
    const update = () => {
      this.elapsedSeconds.set(
        Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
      );
    };
    update();
    this.tick = setInterval(update, 1000);
  }

  private clearClock(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    this.elapsedSeconds.set(0);
  }
}
