import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Piece, PieceInput, ReaderState, Session, ImportDraft } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

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
  finalizeImport(d: ImportDraft, file: Blob): Observable<Piece> {
    const body = new FormData();
    body.set('file', file, 'score.pdf');
    body.set('revision', String(d.revision));
    return this.http.post<Piece>(`/api/imports/${d.id}/finalize`, body);
  }

  session(): Observable<Session> {
    return this.http.get<Session>('/api/session');
  }

  logout(): Observable<void> {
    return this.http.delete<void>('/api/session');
  }

  pieces(query = '', favorite = false): Observable<Piece[]> {
    let params = new HttpParams();
    if (query.trim()) params = params.set('q', query.trim());
    if (favorite) params = params.set('favorite', 'true');
    return this.http.get<Piece[]>('/api/pieces/', { params });
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

  uploadPdf(id: string, file: File, pageCount: number): Observable<Piece> {
    const body = new FormData();
    body.set('file', file, file.name);
    body.set('pageCount', String(pageCount));
    return this.http.post<Piece>(`/api/pieces/${id}/pdf`, body);
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
