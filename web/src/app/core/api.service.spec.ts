import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiService } from './api.service';

describe('ApiService IMSLP search', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  it('reads the per-user limit as the throttled status', async () => {
    const result = firstValueFrom(api.searchIMSLP(' Prelude '));
    const request = http.expectOne((r) => r.url === '/api/imslp/works');
    expect(request.request.params.get('q')).toBe('Prelude');
    request.flush(
      { status: 'throttled', results: [] },
      { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '1' } },
    );
    await expect(result).resolves.toEqual({ status: 'throttled', results: [] });
    http.verify();
  });

  it('still reports other failures as errors', async () => {
    const result = firstValueFrom(api.searchIMSLP('Prelude'));
    http
      .expectOne((r) => r.url === '/api/imslp/works')
      .flush({ error: 'internal server error' }, { status: 500, statusText: 'Server Error' });
    await expect(result).rejects.toMatchObject({ status: 500 });
    http.verify();
  });
});

describe('ApiService shortcut token', () => {
  it('reads, creates and turns off the account token', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const api = TestBed.inject(ApiService);
    const http = TestBed.inject(HttpTestingController);

    const status = firstValueFrom(api.shortcutToken());
    const get = http.expectOne('/api/account/shortcut-token');
    expect(get.request.method).toBe('GET');
    get.flush({ active: false, createdAt: null, lastUsedAt: null });
    await expect(status).resolves.toEqual({ active: false, createdAt: null, lastUsedAt: null });

    const created = firstValueFrom(api.createShortcutToken());
    const post = http.expectOne('/api/account/shortcut-token');
    expect(post.request.method).toBe('POST');
    post.flush({ token: 't', createdAt: '2026-10-01T09:00:00Z' });
    await expect(created).resolves.toMatchObject({ token: 't' });

    const removed = firstValueFrom(api.deleteShortcutToken(), { defaultValue: undefined });
    const remove = http.expectOne('/api/account/shortcut-token');
    expect(remove.request.method).toBe('DELETE');
    remove.flush(null, { status: 204, statusText: 'No Content' });
    await removed;
    http.verify();
  });
});
