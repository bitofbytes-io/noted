import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { Preferences, Session } from '../../core/models';

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  protected readonly session = signal<Session | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected preferences: Preferences = {
    weekStartsOn: 1,
    metronomeBpm: 96,
    metronomeAccent: true,
    metronomeBeatsPerBar: 4,
    metronomeSound: 'classic',
  };

  constructor(private readonly api: ApiService) {}

  async ngOnInit(): Promise<void> {
    try {
      const [session, preferences] = await Promise.all([
        firstValueFrom(this.api.session()),
        firstValueFrom(this.api.preferences()),
      ]);
      this.session.set(session);
      this.preferences = preferences;
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      this.preferences = await firstValueFrom(this.api.updatePreferences(this.preferences));
      this.success.set('Preferences saved.');
      setTimeout(() => this.success.set(''), 1800);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}
