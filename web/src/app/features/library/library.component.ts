import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { learnerStatuses, Tag, WorkSummary } from '../../core/models';

@Component({
  selector: 'app-library',
  imports: [FormsModule, RouterLink],
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
})
export class LibraryComponent implements OnInit, OnDestroy {
  protected readonly works = signal<WorkSummary[]>([]);
  protected readonly tags = signal<Tag[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly statuses = learnerStatuses;
  protected showCreate = false;
  protected query = '';
  protected status = '';
  protected favorite = '';
  protected tag = '';
  protected draft = {
    title: '',
    composer: '',
    catalogNumber: '',
    keySignature: '',
    period: '',
    editionName: 'Personal edition',
    sourceUrl: '',
    rightsNote: '',
  };
  private routeSubscription?: Subscription;

  constructor(
    private readonly api: ApiService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
  ) {}

  ngOnInit(): void {
    this.routeSubscription = this.route.queryParamMap.subscribe((params) => {
      this.query = params.get('q') ?? '';
      this.status = params.get('status') ?? '';
      this.favorite = params.get('favorite') ?? '';
      this.tag = params.get('tag') ?? '';
      void this.load();
    });
    void this.loadTags();
  }

  ngOnDestroy(): void {
    this.routeSubscription?.unsubscribe();
  }

  applyFilters(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.query.trim() || null,
        status: this.status || null,
        favorite: this.favorite || null,
        tag: this.tag || null,
      },
    });
  }

  clearFilters(): void {
    this.query = '';
    this.status = '';
    this.favorite = '';
    this.tag = '';
    this.applyFilters();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const favorite = this.favorite === '' ? null : this.favorite === 'true';
      const response = await firstValueFrom(
        this.api.works({ q: this.query, status: this.status, favorite, tag: this.tag }),
      );
      this.works.set(response.items);
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async loadTags(): Promise<void> {
    try {
      this.tags.set((await firstValueFrom(this.api.tags())).items);
    } catch {
      this.tags.set([]);
    }
  }

  async createWork(): Promise<void> {
    this.saving.set(true);
    try {
      const work = await firstValueFrom(this.api.createWork(this.draft));
      await this.router.navigate(['/works', work.id]);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}
