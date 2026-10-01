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
