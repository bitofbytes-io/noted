import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { learnerStatuses, Tag, WorkDetail } from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';

@Component({
  selector: 'app-work-details',
  imports: [FormsModule, RouterLink],
  templateUrl: './work-details.component.html',
  styleUrl: './work-details.component.scss',
})
export class WorkDetailsComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  protected readonly work = signal<WorkDetail | null>(null);
  protected readonly tags = signal<Tag[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly statuses = learnerStatuses;
  protected learnerDraft = {
    status: 'Interested',
    isFavorite: false,
    personalDifficulty: '',
    personalNotes: '',
    lastBpm: null as number | null,
  };
  protected selectedTagIds: string[] = [];
  protected newTag = '';
  protected showEdition = false;
  protected editionDraft = { name: '', editor: '', publisher: '', sourceUrl: '', rightsNote: '' };
  protected selectedEditionId = '';
  protected uploadFile: File | null = null;
  protected uploadSource = '';
  protected uploadRights = '';
  protected stopDraft = {
    startMeasure: null as number | null,
    endMeasure: null as number | null,
    endingBpm: null as number | null,
    handPart: '',
    notes: '',
  };
  protected readonly workId = this.route.snapshot.paramMap.get('id') ?? '';

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngOnInit(): void {
    void Promise.all([this.load(), this.loadTags(), this.timer.initialize()]).catch((error) =>
      this.error.set(errorMessage(error)),
    );
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const work = await firstValueFrom(this.api.work(this.workId));
      this.work.set(work);
      this.learnerDraft = {
        status: work.learnerState.status,
        isFavorite: work.learnerState.isFavorite,
        personalDifficulty: work.learnerState.personalDifficulty ?? '',
        personalNotes: work.learnerState.personalNotes ?? '',
        lastBpm: work.learnerState.lastBpm ?? null,
      };
      this.selectedEditionId ||= work.editions[0]?.id ?? '';
      this.syncSelectedTags();
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async loadTags(): Promise<void> {
    this.tags.set((await firstValueFrom(this.api.tags())).items);
    this.syncSelectedTags();
  }

  syncSelectedTags(): void {
    const names = new Set(this.work()?.learnerState.tags ?? []);
    this.selectedTagIds = this.tags()
      .filter((tag) => names.has(tag.name))
      .map((tag) => tag.id);
  }

  async saveLearnerState(): Promise<void> {
    this.saving.set(true);
    try {
      const work = await firstValueFrom(
        this.api.updateLearnerState(this.workId, {
          ...this.learnerDraft,
          status: this.learnerDraft.status as WorkDetail['learnerState']['status'],
        }),
      );
      await firstValueFrom(this.api.replaceTags(this.workId, this.selectedTagIds));
      this.work.set({
        ...work,
        learnerState: {
          ...work.learnerState,
          tags: this.tags()
            .filter((tag) => this.selectedTagIds.includes(tag.id))
            .map((tag) => tag.name),
        },
      });
      this.success.set('Learner status, favorite, notes, and tags saved.');
      setTimeout(() => this.success.set(''), 2500);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  async createTag(): Promise<void> {
    if (!this.newTag.trim()) return;
    try {
      const tag = await firstValueFrom(this.api.createTag(this.newTag));
      await this.loadTags();
      if (!this.selectedTagIds.includes(tag.id))
        this.selectedTagIds = [...this.selectedTagIds, tag.id];
      this.newTag = '';
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  toggleTag(tagId: string, checked: boolean): void {
    this.selectedTagIds = checked
      ? Array.from(new Set([...this.selectedTagIds, tagId]))
      : this.selectedTagIds.filter((id) => id !== tagId);
  }

  async addEdition(): Promise<void> {
    this.saving.set(true);
    try {
      const edition = await firstValueFrom(this.api.addEdition(this.workId, this.editionDraft));
      this.selectedEditionId = edition.id;
      this.showEdition = false;
      this.editionDraft = { name: '', editor: '', publisher: '', sourceUrl: '', rightsNote: '' };
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  chooseFile(event: Event): void {
    this.uploadFile = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  async upload(): Promise<void> {
    if (!this.uploadFile || !this.selectedEditionId) return;
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.uploadAsset(
          this.selectedEditionId,
          this.uploadFile,
          this.uploadSource,
          this.uploadRights,
        ),
      );
      this.uploadFile = null;
      this.uploadSource = '';
      this.uploadRights = '';
      await this.load();
      this.success.set('Score asset uploaded and verified.');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  async startPractice(): Promise<void> {
    try {
      const movement = this.work()?.movements[0];
      await this.timer.start({ workId: this.workId, movementId: movement?.id ?? null });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async stopPractice(): Promise<void> {
    try {
      await this.timer.stop(this.stopDraft);
      this.stopDraft = {
        startMeasure: null,
        endMeasure: null,
        endingBpm: null,
        handPart: '',
        notes: '',
      };
      await this.load();
      this.success.set('Practice saved. Dashboard and work totals are updated.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  duration(seconds: number): string {
    return seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
      : `${Math.round(seconds / 60)}m`;
  }
}
