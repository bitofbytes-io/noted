import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Subject, tap } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SessionExpiryEvents {
  private readonly expired = new Subject<void>();
  readonly expired$ = this.expired.asObservable();

  notify(): void {
    this.expired.next();
  }
}

export const sessionExpiryInterceptor: HttpInterceptorFn = (request, next) => {
  const events = inject(SessionExpiryEvents);

  return next(request).pipe(
    tap({
      error: (error: unknown) => {
        if (
          error instanceof HttpErrorResponse &&
          error.status === 401 &&
          request.url.startsWith('/api/')
        ) {
          events.notify();
        }
      },
    }),
  );
};
