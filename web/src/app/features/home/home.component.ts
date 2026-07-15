import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { Dashboard } from '../../core/models';

@Component({
  selector: 'app-home',
  imports: [FormsModule, RouterLink, DatePipe],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit {
  protected readonly dashboard = signal<Dashboard | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected query = '';

  constructor(
    private readonly api: ApiService,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.dashboard.set(await firstValueFrom(this.api.dashboard()));
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  search(): void {
    void this.router.navigate(['/library'], { queryParams: { q: this.query.trim() || null } });
  }

  duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  dayLabel(date: string): string {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T12:00:00Z`),
    );
  }

  barHeight(seconds: number, data: Dashboard): number {
    const max = Math.max(...data.week.days.map((day) => day.durationSeconds), 1);
    return seconds === 0 ? 3 : Math.max(12, Math.round((seconds / max) * 100));
  }
}
