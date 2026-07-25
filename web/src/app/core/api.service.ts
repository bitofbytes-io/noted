import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Piece, PieceInput, ReaderState, Session } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

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
    if (typeof body?.error === 'string') return body.error;
    if (error.status === 0) return 'Noted could not reach the API.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
