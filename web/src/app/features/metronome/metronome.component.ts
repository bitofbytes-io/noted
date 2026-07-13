import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { MetronomeService } from '../../core/metronome.service';

@Component({
  selector: 'app-metronome',
  imports: [FormsModule],
  templateUrl: './metronome.component.html',
  styleUrl: './metronome.component.scss',
})
export class MetronomeComponent implements OnInit, OnDestroy {
  protected readonly error = signal('');
  protected readonly saved = signal(false);
  protected bpm = 96;
  protected accent = true;

  constructor(
    private readonly api: ApiService,
    protected readonly metronome: MetronomeService,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      const preferences = await firstValueFrom(this.api.preferences());
      this.bpm = preferences.metronomeBpm;
      this.accent = preferences.metronomeAccent;
      this.metronome.setBpm(this.bpm);
      this.metronome.setAccent(this.accent);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  ngOnDestroy(): void {
    this.metronome.stop();
  }

  async toggle(): Promise<void> {
    try {
      if (this.metronome.running()) this.metronome.stop();
      else await this.metronome.start();
    } catch {
      this.error.set(
        'Audio could not start. Tap Start again and confirm browser audio permission.',
      );
    }
  }

  updateBpm(value: number): void {
    this.metronome.setBpm(value);
    this.bpm = this.metronome.bpm();
  }

  updateAccent(value: boolean): void {
    this.accent = value;
    this.metronome.setAccent(value);
  }

  async save(): Promise<void> {
    try {
      await firstValueFrom(
        this.api.updatePreferences({
          weekStartsOn: 1,
          metronomeBpm: this.bpm,
          metronomeAccent: this.accent,
        }),
      );
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 1800);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
