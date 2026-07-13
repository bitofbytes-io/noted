import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { Dashboard } from '../../core/models';
import { HomeComponent } from './home.component';

const dashboard: Dashboard = {
  currentWorks: [
    {
      id: 'work-1',
      title: 'Noted Exercise',
      composer: 'Noted Project',
      status: 'Learning',
      isFavorite: true,
      tags: ['Warm-up'],
      lastBpm: 96,
      hasPdf: true,
      hasPlayback: true,
      updatedAt: '2026-07-13T00:00:00Z',
    },
  ],
  recentImports: [
    {
      id: 'asset-1',
      editionId: 'edition-1',
      assetType: 'musicxml',
      originalFilename: 'exercise.musicxml',
      mediaType: 'application/xml',
      byteSize: 1000,
      sha256: 'a'.repeat(64),
      rightsNote: 'CC0',
      playbackCapable: true,
      createdAt: '2026-07-13T00:00:00Z',
      contentUrl: '/api/assets/asset-1/content',
    },
  ],
  week: {
    startsOn: '2026-07-13',
    totalSeconds: 1200,
    sessionCount: 1,
    days: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-07-${13 + index}`,
      durationSeconds: index === 0 ? 1200 : 0,
      sessionCount: index === 0 ? 1 : 0,
    })),
  },
};

describe('HomeComponent dashboard states', () => {
  it('shows continue-practicing capability and Monday-first metrics', async () => {
    await TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: { dashboard: () => of(dashboard) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Continue practicing');
    expect(text).toContain('Noted Exercise');
    expect(text).toContain('20m');
    expect(text).toContain('Mon');
    expect(text).toContain('exercise.musicxml');
  });
});
