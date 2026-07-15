import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class MetronomeService {
  readonly running = signal(false);
  readonly bpm = signal(96);
  readonly accent = signal(true);
  readonly beat = signal(0);
  private context?: AudioContext;
  private interval?: ReturnType<typeof setInterval>;
  private beatIndex = 0;

  async start(): Promise<void> {
    if (this.running()) return;
    this.context = new AudioContext();
    await this.context.resume();
    this.running.set(true);
    this.beatIndex = 0;
    this.schedule();
  }

  stop(): void {
    this.running.set(false);
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.beat.set(0);
    void this.context?.close();
    this.context = undefined;
  }

  setBpm(value: number): void {
    this.bpm.set(Math.min(240, Math.max(30, Math.round(value || 96))));
    if (this.running()) this.schedule();
  }

  setAccent(value: boolean): void {
    this.accent.set(value);
  }

  private schedule(): void {
    if (this.interval) clearInterval(this.interval);
    const tick = () => this.click();
    tick();
    this.interval = setInterval(tick, 60_000 / this.bpm());
  }

  private click(): void {
    if (!this.context) return;
    const accented = this.accent() && this.beatIndex % 4 === 0;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = accented ? 1320 : 880;
    gain.gain.setValueAtTime(accented ? 0.28 : 0.16, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + 0.045);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.05);
    this.beatIndex = (this.beatIndex + 1) % 4;
    this.beat.set(this.beatIndex || 4);
  }
}
