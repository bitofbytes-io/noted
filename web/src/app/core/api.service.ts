import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  ApiList,
  Asset,
  Dashboard,
  Edition,
  LearnerState,
  PracticeInput,
  PracticeSession,
  Preferences,
  RecognitionJob,
  Session,
  Tag,
  WeekSummary,
  WorkDetail,
  WorkSummary,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private readonly http: HttpClient) {}

  session(): Observable<Session> {
    return this.http.get<Session>('/api/session');
  }

  dashboard(week?: string): Observable<Dashboard> {
    return this.http.get<Dashboard>('/api/dashboard', {
      params: week ? { week } : {},
    });
  }

  works(
    filters: {
      q?: string;
      status?: string;
      favorite?: boolean | null;
      tag?: string;
    } = {},
  ): Observable<ApiList<WorkSummary>> {
    let params = new HttpParams();
    if (filters.q) params = params.set('q', filters.q);
    if (filters.status) params = params.set('status', filters.status);
    if (filters.favorite !== undefined && filters.favorite !== null) {
      params = params.set('favorite', filters.favorite);
    }
    if (filters.tag) params = params.set('tag', filters.tag);
    return this.http.get<ApiList<WorkSummary>>('/api/works', { params });
  }

  createWork(input: {
    title: string;
    composer: string;
    catalogNumber?: string;
    keySignature?: string;
    period?: string;
    editionName: string;
    sourceUrl?: string;
    rightsNote?: string;
  }): Observable<WorkDetail> {
    return this.http.post<WorkDetail>('/api/works', input);
  }

  work(id: string): Observable<WorkDetail> {
    return this.http.get<WorkDetail>(`/api/works/${id}`);
  }

  updateWork(id: string, input: Partial<WorkDetail>): Observable<WorkDetail> {
    return this.http.patch<WorkDetail>(`/api/works/${id}`, input);
  }

  deleteWork(id: string): Observable<void> {
    return this.http.delete<void>(`/api/works/${id}`);
  }

  updateLearnerState(
    id: string,
    state: Omit<LearnerState, 'tags' | 'lastBpm'> & { lastBpm?: number | null },
  ): Observable<WorkDetail> {
    return this.http.put<WorkDetail>(`/api/works/${id}/learner-state`, state);
  }

  addEdition(workId: string, input: Partial<Edition> & { name: string }): Observable<Edition> {
    return this.http.post<Edition>(`/api/works/${workId}/editions`, input);
  }

  updateEdition(
    id: string,
    input: Partial<Edition> & { name: string; archived?: boolean },
  ): Observable<Edition> {
    return this.http.patch<Edition>(`/api/editions/${id}`, input);
  }

  deleteEdition(id: string): Observable<void> {
    return this.http.delete<void>(`/api/editions/${id}`);
  }

  uploadAsset(
    editionId: string,
    file: File,
    sourceUrl: string,
    rightsNote: string,
  ): Observable<Asset> {
    const form = new FormData();
    form.append('file', file);
    form.append('sourceUrl', sourceUrl);
    form.append('rightsNote', rightsNote);
    return this.http.post<Asset>(`/api/editions/${editionId}/assets`, form);
  }

  asset(id: string): Observable<Asset> {
    return this.http.get<Asset>(`/api/assets/${id}`);
  }

  updateAsset(
    id: string,
    input: { displayName?: string; sourceUrl?: string; rightsNote?: string; archived?: boolean },
  ): Observable<Asset> {
    return this.http.patch<Asset>(`/api/assets/${id}`, input);
  }

  replaceAsset(id: string, file: File, sourceUrl: string, rightsNote: string): Observable<Asset> {
    const form = new FormData();
    form.append('file', file);
    form.append('sourceUrl', sourceUrl);
    form.append('rightsNote', rightsNote);
    return this.http.post<Asset>(`/api/assets/${id}/replacement`, form);
  }

  deleteAsset(id: string): Observable<void> {
    return this.http.delete<void>(`/api/assets/${id}`);
  }

  createRecognitionJob(assetId: string): Observable<RecognitionJob> {
    return this.http.post<RecognitionJob>(`/api/assets/${assetId}/recognition-jobs`, {});
  }

  recognitionJobs(assetId: string): Observable<ApiList<RecognitionJob>> {
    return this.http.get<ApiList<RecognitionJob>>(`/api/assets/${assetId}/recognition-jobs`);
  }

  recognitionJob(id: string): Observable<RecognitionJob> {
    return this.http.get<RecognitionJob>(`/api/recognition-jobs/${id}`);
  }

  retryRecognitionJob(id: string): Observable<RecognitionJob> {
    return this.http.post<RecognitionJob>(`/api/recognition-jobs/${id}/retry`, {});
  }

  cancelRecognitionJob(id: string): Observable<void> {
    return this.http.delete<void>(`/api/recognition-jobs/${id}`);
  }

  tags(): Observable<ApiList<Tag>> {
    return this.http.get<ApiList<Tag>>('/api/tags');
  }

  createTag(name: string): Observable<Tag> {
    return this.http.post<Tag>('/api/tags', { name });
  }

  replaceTags(workId: string, tagIds: string[]): Observable<ApiList<Tag>> {
    return this.http.put<ApiList<Tag>>(`/api/works/${workId}/tags`, { tagIds });
  }

  practiceSessions(workId = ''): Observable<ApiList<PracticeSession>> {
    return this.http.get<ApiList<PracticeSession>>('/api/practice-sessions', {
      params: workId ? { workId } : {},
    });
  }

  startPractice(input: PracticeInput): Observable<PracticeSession> {
    return this.http.post<PracticeSession>('/api/practice-sessions/start', input);
  }

  stopPractice(id: string, input: PracticeInput): Observable<PracticeSession> {
    return this.http.post<PracticeSession>(`/api/practice-sessions/${id}/stop`, input);
  }

  createPractice(input: PracticeInput): Observable<PracticeSession> {
    return this.http.post<PracticeSession>('/api/practice-sessions', input);
  }

  updatePractice(id: string, input: PracticeInput): Observable<PracticeSession> {
    return this.http.patch<PracticeSession>(`/api/practice-sessions/${id}`, input);
  }

  deletePractice(id: string): Observable<void> {
    return this.http.delete<void>(`/api/practice-sessions/${id}`);
  }

  practiceSummary(week?: string): Observable<WeekSummary> {
    return this.http.get<WeekSummary>('/api/practice-summary', {
      params: week ? { week } : {},
    });
  }

  preferences(): Observable<Preferences> {
    return this.http.get<Preferences>('/api/preferences');
  }

  updatePreferences(value: Preferences): Observable<Preferences> {
    return this.http.patch<Preferences>('/api/preferences', value);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const envelope = error.error?.error;
    if (envelope?.fields) {
      const details = Object.values(envelope.fields).join(' · ');
      return details ? `${envelope.message}: ${details}` : envelope.message;
    }
    return envelope?.message ?? `Request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}
