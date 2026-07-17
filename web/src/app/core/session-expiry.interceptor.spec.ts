import { HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, throwError } from 'rxjs';
import { SessionExpiryEvents, sessionExpiryInterceptor } from './session-expiry.interceptor';

describe('sessionExpiryInterceptor', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('notifies the application when an API request loses authentication', async () => {
    const events = TestBed.inject(SessionExpiryEvents);
    let notifications = 0;
    events.expired$.subscribe(() => notifications++);

    const response = TestBed.runInInjectionContext(() =>
      sessionExpiryInterceptor(new HttpRequest('GET', '/api/dashboard'), () =>
        throwError(() => new HttpErrorResponse({ status: 401 })),
      ),
    );

    await expect(firstValueFrom(response)).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(notifications).toBe(1);
  });

  it('does not treat unrelated failures as an expired session', async () => {
    const events = TestBed.inject(SessionExpiryEvents);
    let notifications = 0;
    events.expired$.subscribe(() => notifications++);

    const response = TestBed.runInInjectionContext(() =>
      sessionExpiryInterceptor(new HttpRequest('GET', '/api/dashboard'), () =>
        throwError(() => new HttpErrorResponse({ status: 503 })),
      ),
    );

    await expect(firstValueFrom(response)).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(notifications).toBe(0);
  });
});
