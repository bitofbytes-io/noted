import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { ApiService } from './core/api.service';
import { Session } from './core/models';
import { SessionExpiryEvents } from './core/session-expiry.interceptor';

describe('App authentication gate', () => {
  let fixture: ComponentFixture<App>;
  let sessionResponse: Observable<Session>;

  beforeEach(async () => {
    sessionResponse = of({
      authenticated: true,
      authMode: 'development',
      development: true,
      user: {
        id: 'db53bb2a-b720-407a-8941-cd4459f69e79',
        email: 'learner@noted.local',
        displayName: 'Local learner',
      },
    });
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        {
          provide: ApiService,
          useValue: {
            session: vi.fn(() => sessionResponse),
          },
        },
      ],
    }).compileComponents();
  });

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows Google sign-in when the session is unauthenticated', async () => {
    sessionResponse = of({ authenticated: false, authMode: 'google', development: false });
    await render();

    const link = fixture.nativeElement.querySelector('a[href="/api/auth/google?returnTo=%2F"]');
    expect(link).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Continue with Google');
  });

  it('preserves a bookmarked reader route through Google sign-in', async () => {
    sessionResponse = of({ authenticated: false, authMode: 'google', development: false });
    vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue(
      '/reader/piece-123?mode=scroll#page-4',
    );
    await render();

    const link: HTMLAnchorElement | null = fixture.nativeElement.querySelector('a.primary-action');
    expect(link?.getAttribute('href')).toBe(
      '/api/auth/google?returnTo=%2Freader%2Fpiece-123%3Fmode%3Dscroll%23page-4',
    );
  });

  it('renders the application for the development learner', async () => {
    await render();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('returns to sign-in when an authenticated request expires', async () => {
    await render();
    TestBed.inject(SessionExpiryEvents).notify();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('a[href="/api/auth/google?returnTo=%2F"]'),
    ).not.toBeNull();
  });

  it('distinguishes an offline API from an unauthenticated session', async () => {
    sessionResponse = throwError(() => new Error('offline'));
    await render();
    expect(fixture.nativeElement.textContent).toContain('cannot reach its API');
  });
});
