import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { MetronomeService } from '../../core/metronome.service';
import { MetronomeSound } from '../../core/models';

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
  protected beatsPerBar: 1 | 2 | 3 | 4 = 4;
  protected sound: MetronomeSound = 'classic';

  constructor(
    private readonly api: ApiService,
    protected readonly metronome: MetronomeService,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      const preferences = await firstValueFrom(this.api.preferences());
      this.bpm = preferences.metronomeBpm;
      this.accent = preferences.metronomeAccent;
      this.beatsPerBar = preferences.metronomeBeatsPerBar;
      this.sound = preferences.metronomeSound;
      this.metronome.setBpm(this.bpm);
      this.metronome.setAccent(this.accent);
      this.metronome.setBeatsPerBar(this.beatsPerBar);
      this.metronome.setSound(this.sound);
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

  updateBeatsPerBar(value: number): void {
    this.beatsPerBar = Math.min(4, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4;
    this.metronome.setBeatsPerBar(this.beatsPerBar);
  }

  updateSound(value: MetronomeSound): void {
    this.sound = value;
    this.metronome.setSound(value);
  }

  beatNumbers(): number[] {
    return Array.from({ length: this.beatsPerBar }, (_, index) => index + 1);
  }

  async save(): Promise<void> {
    try {
      await firstValueFrom(
        this.api.updatePreferences({
          weekStartsOn: 1,
          metronomeBpm: this.bpm,
          metronomeAccent: this.accent,
          metronomeBeatsPerBar: this.beatsPerBar,
          metronomeSound: this.sound,
        }),
      );
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 1800);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
