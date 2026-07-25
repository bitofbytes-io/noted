import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, Subject, catchError, throwError } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SessionExpiryEvents {
  private readonly expired = new Subject<void>();
  readonly expired$ = this.expired.asObservable();

  notify(): void {
    this.expired.next();
  }
}

export function sessionExpiryInterceptor(
  request: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  const events = inject(SessionExpiryEvents);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        request.url !== '/api/session'
      ) {
        events.notify();
      }
      return throwError(() => error);
    }),
  );
}
