import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject, isDevMode, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './core/api.service';
import { Session } from './core/models';
import { SessionExpiryEvents } from './core/session-expiry.interceptor';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly prototype =
    isDevMode() && window.location.pathname === '/prototype/imslp-search';
  protected readonly session = signal<Session | null>(null);
  protected readonly loadingSession = signal(true);
  protected readonly apiOffline = signal(false);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly sessionExpiry = inject(SessionExpiryEvents);

  constructor() {
    this.sessionExpiry.expired$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.showSignInGate());
  }

  async ngOnInit(): Promise<void> {
    if (this.prototype) {
      this.loadingSession.set(false);
      return;
    }
    try {
      this.session.set(await firstValueFrom(this.api.session()));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.showSignInGate();
      } else {
        this.apiOffline.set(true);
      }
    } finally {
      this.loadingSession.set(false);
    }
  }

  reload(): void {
    window.location.reload();
  }

  protected googleSignInURL(): string {
    return `/api/auth/google?returnTo=${encodeURIComponent(this.router.url || '/')}`;
  }

  private showSignInGate(): void {
    this.session.set({ authenticated: false, authMode: 'google', development: false });
    this.loadingSession.set(false);
    this.apiOffline.set(false);
  }
}
