import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './core/api.service';
import { clearLibraryParams } from './core/library-address';
import { Session } from './core/models';
import { SessionExpiryEvents } from './core/session-expiry.interceptor';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
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
    try {
      const session = await firstValueFrom(this.api.session());
      this.session.set(session);
      if (!session.authenticated) this.forgetLibrarySearch();
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
    const tree = this.router.parseUrl(this.router.url || '/');
    delete tree.queryParams['q'];
    delete tree.queryParams['show'];
    delete tree.queryParams['sort'];
    const returnTo = this.router.serializeUrl(tree) || '/';
    return `/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
  }

  private showSignInGate(): void {
    this.forgetLibrarySearch();
    this.session.set({ authenticated: false, authMode: 'google', development: false });
    this.loadingSession.set(false);
    this.apiOffline.set(false);
  }

  /** The next account must not inherit this one's search, filter or sort. */
  private forgetLibrarySearch(): void {
    clearLibraryParams();
    const tree = this.router.parseUrl(this.router.url || '/');
    if (
      tree.queryParams['q'] === undefined &&
      tree.queryParams['show'] === undefined &&
      tree.queryParams['sort'] === undefined
    ) {
      return;
    }
    delete tree.queryParams['q'];
    delete tree.queryParams['show'];
    delete tree.queryParams['sort'];
    // The sign-in link strips the query on its own if this navigation cannot run.
    void this.router.navigateByUrl(tree, { replaceUrl: true }).catch(() => undefined);
  }
}
