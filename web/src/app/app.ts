import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './core/api.service';
import { Session } from './core/models';
import { SessionExpiryEvents } from './core/session-expiry.interceptor';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly session = signal<Session | null>(null);
  protected readonly loadingSession = signal(true);
  protected readonly apiOffline = signal(false);
  protected readonly signingOut = signal(false);
  protected readonly immersive = signal(false);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sessionExpiry = inject(SessionExpiryEvents);

  constructor(private readonly api: ApiService) {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.updateRouteMode());

    this.sessionExpiry.expired$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.showSignInGate());
  }

  async ngOnInit(): Promise<void> {
    this.updateRouteMode();
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

  async logout(): Promise<void> {
    this.signingOut.set(true);
    try {
      await firstValueFrom(this.api.logout());
      this.session.set({
        authenticated: false,
        authMode: 'google',
        development: false,
        capabilities: { recognition: false },
      });
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.showSignInGate();
      } else {
        this.apiOffline.set(true);
      }
    } finally {
      this.signingOut.set(false);
    }
  }

  reload(): void {
    window.location.reload();
  }

  private updateRouteMode(): void {
    let route = this.route;
    while (route.firstChild) route = route.firstChild;
    this.immersive.set(route.snapshot.data['immersive'] === true);
  }

  private showSignInGate(): void {
    const capabilities = this.session()?.capabilities ?? { recognition: false };
    this.session.set({
      authenticated: false,
      authMode: 'google',
      development: false,
      capabilities,
    });
    this.loadingSession.set(false);
    this.apiOffline.set(false);
    this.signingOut.set(false);
  }
}
