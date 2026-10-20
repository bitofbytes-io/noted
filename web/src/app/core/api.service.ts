import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, throwError } from 'rxjs';
import {
  Piece,
  PieceInput,
  PieceSummary,
  Preferences,
  ReaderState,
  Session,
  ImportDraft,
  FinalizeResult,
  IMSLPSearch,
  ShortcutToken,
  ShortcutTokenCreated,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  /** The per-user limit answers 429; callers see it as the `throttled` status. */
  searchIMSLP(query: string): Observable<IMSLPSearch> {
    return this.http
      .get<IMSLPSearch>('/api/imslp/works', {
        params: new HttpParams().set('q', query.trim()),
      })
      .pipe(
        catchError((error: unknown) =>
          error instanceof HttpErrorResponse && error.status === 429
            ? of<IMSLPSearch>({ status: 'throttled', results: [] })
            : throwError(() => error),
        ),
      );
  }

  imports(): Observable<ImportDraft[]> {
    return this.http.get<ImportDraft[]>('/api/imports/');
  }
  createImport(pieceId = '', sourceUrl = ''): Observable<ImportDraft> {
    return this.http.post<ImportDraft>('/api/imports/', { pieceId, sourceUrl });
  }
  importDraft(id: string): Observable<ImportDraft> {
    return this.http.get<ImportDraft>(`/api/imports/${id}/`);
  }
  updateImport(d: ImportDraft): Observable<ImportDraft> {
    return this.http.patch<ImportDraft>(`/api/imports/${d.id}/`, {
      revision: d.revision,
      metadata: d.metadata,
      imslpAutoFill: d.imslpAutoFill ?? {},
      manifest: d.manifest,
    });
  }
  deleteImport(id: string): Observable<void> {
    return this.http.delete<void>(`/api/imports/${id}/`);
  }
  uploadImport(d: ImportDraft, file: File): Observable<ImportDraft> {
    const body = new FormData();
    body.set('file', file);
    body.set('revision', String(d.revision));
    return this.http.post<ImportDraft>(`/api/imports/${d.id}/sources`, body);
  }
  finalizeImport(d: ImportDraft, file: Blob): Observable<FinalizeResult> {
    const body = new FormData();
    body.set('file', file, 'score.pdf');
    body.set('revision', String(d.revision));
    return this.http.post<FinalizeResult>(`/api/imports/${d.id}/finalize`, body);
  }

  session(): Observable<Session> {
    return this.http.get<Session>('/api/session');
  }

  logout(): Observable<void> {
    return this.http.delete<void>('/api/session');
  }

  shortcutToken(): Observable<ShortcutToken> {
    return this.http.get<ShortcutToken>('/api/account/shortcut-token');
  }
  /** Creates the token, or replaces the current one. */
  createShortcutToken(): Observable<ShortcutTokenCreated> {
    return this.http.post<ShortcutTokenCreated>('/api/account/shortcut-token', null);
  }
  deleteShortcutToken(): Observable<void> {
    return this.http.delete<void>('/api/account/shortcut-token');
  }

  /** Every piece of the user's library, as summaries the library filters and sorts itself. */
  pieceSummaries(): Observable<PieceSummary[]> {
    return this.http.get<PieceSummary[]>('/api/pieces/', {
      params: new HttpParams().set('fields', 'summary').set('status', 'all'),
    });
  }

  /** The piece to continue: the latest played in two weeks, from the whole library. */
  continuePiece(): Observable<Piece | null> {
    return this.http
      .get<{ piece: Piece | null }>('/api/pieces/continue')
      .pipe(map((response) => response.piece));
  }

  preferences(): Observable<Preferences> {
    return this.http.get<Preferences>('/api/account/preferences');
  }

  /** Saves only the preferences given; the server keeps the rest. */
  savePreferences(preferences: Partial<Preferences>): Observable<Preferences> {
    return this.http.put<Preferences>('/api/account/preferences', preferences);
  }

  piece(id: string): Observable<Piece> {
    return this.http.get<Piece>(`/api/pieces/${id}/`);
  }

  createPiece(input: PieceInput): Observable<Piece> {
    return this.http.post<Piece>('/api/pieces/', input);
  }

  updatePiece(id: string, input: Partial<PieceInput>): Observable<Piece> {
    return this.http.patch<Piece>(`/api/pieces/${id}/`, input);
  }

  deletePiece(id: string): Observable<void> {
    return this.http.delete<void>(`/api/pieces/${id}/`);
  }

  readerState(id: string): Observable<ReaderState> {
    return this.http.get<ReaderState>(`/api/pieces/${id}/reader-state`);
  }

  saveReaderState(id: string, state: ReaderState): Observable<ReaderState> {
    return this.http.put<ReaderState>(`/api/pieces/${id}/reader-state`, state);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: unknown } | null;
    if (typeof body?.error === 'string') return sentence(body.error);
    if (error.status === 0) return 'Noted could not reach the API.';
  }
  return error instanceof Error ? sentence(error.message) : 'Something went wrong.';
}

/** API errors arrive as lowercase fragments; present them as a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Something went wrong.';
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
