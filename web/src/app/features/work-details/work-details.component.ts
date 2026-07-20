import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  Asset,
  Edition,
  learnerStatuses,
  RecognitionJob,
  Tag,
  WorkDetail,
} from '../../core/models';
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
  protected readonly recognitionJobs = signal<Record<string, RecognitionJob>>({});
  protected readonly recognitionJobsByOutputAssetId = signal<Record<string, RecognitionJob>>({});
  protected showWorkEdit = false;
  protected workEditDraft = {
    title: '',
    subtitle: '',
    composer: '',
    catalogNumber: '',
    keySignature: '',
    period: '',
    publishedDifficultyLabel: '',
    notes: '',
  };
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
  protected editingEditionId = '';
  protected editionEditDraft = {
    name: '',
    editor: '',
    publisher: '',
    sourceUrl: '',
    rightsNote: '',
  };
  protected editingAssetId = '';
  protected assetEditDraft = { displayName: '', sourceUrl: '', rightsNote: '' };
  protected selectedEditionId = '';
  protected uploadFile: File | null = null;
  protected uploadSource = '';
  protected uploadRights = '';
  protected readonly implicitTuplets = signal<Record<string, boolean>>({});
  protected mediaLinkEditionId = '';
  protected youtubeDraft = { url: '', title: '' };
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
    private readonly router: Router,
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
      this.workEditDraft = {
        title: work.title,
        subtitle: work.subtitle ?? '',
        composer: work.composer,
        catalogNumber: work.catalogNumber ?? '',
        keySignature: work.keySignature ?? '',
        period: work.period ?? '',
        publishedDifficultyLabel: work.publishedDifficultyLabel ?? '',
        notes: work.notes ?? '',
      };
      this.learnerDraft = {
        status: work.learnerState.status,
        isFavorite: work.learnerState.isFavorite,
        personalDifficulty: work.learnerState.personalDifficulty ?? '',
        personalNotes: work.learnerState.personalNotes ?? '',
        lastBpm: work.learnerState.lastBpm ?? null,
      };
      this.selectedEditionId ||= work.editions[0]?.id ?? '';
      this.syncSelectedTags();
      void this.loadRecognitionJobs(work);
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRecognitionJobs(work: WorkDetail): Promise<void> {
    const pdfs = work.editions
      .flatMap((edition) => edition.assets)
      .filter((asset) => asset.assetType === 'pdf' || asset.assetType === 'image');
    const histories = await Promise.all(
      pdfs.map(async (asset) => {
        try {
          const jobs = (await firstValueFrom(this.api.recognitionJobs(asset.id))).items;
          return { sourceAssetId: asset.id, jobs };
        } catch {
          return { sourceAssetId: asset.id, jobs: [] };
        }
      }),
    );
    this.recognitionJobs.set(
      Object.fromEntries(
        histories
          .filter(
            (
              history,
            ): history is { sourceAssetId: string; jobs: [RecognitionJob, ...RecognitionJob[]] } =>
              history.jobs.length > 0,
          )
          .map((history) => [history.sourceAssetId, history.jobs[0]]),
      ),
    );
    this.recognitionJobsByOutputAssetId.set(
      Object.fromEntries(
        histories
          .flatMap((history) => history.jobs)
          .filter(
            (job): job is RecognitionJob & { outputAssetId: string } =>
              job.status === 'succeeded' && Boolean(job.outputAssetId),
          )
          .map((job) => [job.outputAssetId, job]),
      ),
    );
  }

  async saveWork(): Promise<void> {
    this.saving.set(true);
    try {
      this.work.set(await firstValueFrom(this.api.updateWork(this.workId, this.workEditDraft)));
      this.showWorkEdit = false;
      this.success.set('Work details updated.');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  async archiveWork(): Promise<void> {
    if (
      !window.confirm(
        'Archive this work? It will leave the main Library but keep practice history.',
      )
    )
      return;
    try {
      await firstValueFrom(
        this.api.updateLearnerState(this.workId, {
          ...this.learnerDraft,
          status: 'Archived',
        }),
      );
      await this.router.navigate(['/library']);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async deleteWork(): Promise<void> {
    const work = this.work();
    if (!work) return;
    if (work.practiceSummary.sessionCount > 0) {
      await this.archiveWork();
      return;
    }
    if (!window.confirm('Permanently delete this work, its editions, and all score files?')) return;
    try {
      await firstValueFrom(this.api.deleteWork(this.workId));
      await this.router.navigate(['/library']);
    } catch (error) {
      this.error.set(errorMessage(error));
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

  editEdition(edition: Edition): void {
    this.editingEditionId = edition.id;
    this.editionEditDraft = {
      name: edition.name,
      editor: edition.editor ?? '',
      publisher: edition.publisher ?? '',
      sourceUrl: edition.sourceUrl ?? '',
      rightsNote: edition.rightsNote ?? '',
    };
  }

  async saveEdition(edition: Edition, archived = Boolean(edition.archivedAt)): Promise<void> {
    try {
      await firstValueFrom(
        this.api.updateEdition(edition.id, { ...this.editionEditDraft, archived }),
      );
      this.editingEditionId = '';
      await this.load();
      this.success.set('Edition updated.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async setEditionArchived(edition: Edition, archived: boolean): Promise<void> {
    this.editEdition(edition);
    await this.saveEdition(edition, archived);
  }

  async deleteEdition(edition: Edition): Promise<void> {
    if (!window.confirm(`Delete the edition “${edition.name}” and its unreferenced files?`)) return;
    try {
      await firstValueFrom(this.api.deleteEdition(edition.id));
      await this.load();
      this.success.set('Edition deleted.');
    } catch (error) {
      if (!hasApiErrorCode(error, 'edition_in_use')) {
        this.error.set(errorMessage(error));
        return;
      }
      try {
        await firstValueFrom(
          this.api.updateEdition(edition.id, { name: edition.name, archived: true }),
        );
        await this.load();
        this.success.set('The edition is used by practice history, so it was archived instead.');
      } catch (archiveError) {
        this.error.set(errorMessage(archiveError));
      }
    }
  }

  editAsset(asset: Asset): void {
    this.editingAssetId = asset.id;
    this.assetEditDraft = {
      displayName: asset.displayName || asset.originalFilename,
      sourceUrl: asset.sourceUrl ?? '',
      rightsNote: asset.rightsNote,
    };
  }

  async saveAsset(asset: Asset): Promise<void> {
    try {
      await firstValueFrom(this.api.updateAsset(asset.id, this.assetEditDraft));
      this.editingAssetId = '';
      await this.load();
      this.success.set('Score details updated.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async setAssetArchived(asset: Asset, archived: boolean): Promise<void> {
    try {
      await firstValueFrom(this.api.updateAsset(asset.id, { archived }));
      await this.load();
      this.success.set(archived ? 'Score archived.' : 'Score restored.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async deleteAsset(asset: Asset): Promise<void> {
    if (!window.confirm(`Permanently delete “${asset.displayName || asset.originalFilename}”?`))
      return;
    try {
      await firstValueFrom(this.api.deleteAsset(asset.id));
      await this.load();
      this.success.set('Score deleted.');
    } catch (error) {
      if (!hasApiErrorCode(error, 'asset_in_use')) {
        this.error.set(errorMessage(error));
        return;
      }
      try {
        await firstValueFrom(this.api.updateAsset(asset.id, { archived: true }));
        await this.load();
        this.success.set('The score is used by practice history, so it was archived instead.');
      } catch (archiveError) {
        this.error.set(errorMessage(archiveError));
      }
    }
  }

  async replaceAsset(asset: Asset, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await firstValueFrom(
        this.api.replaceAsset(asset.id, file, asset.sourceUrl ?? '', asset.rightsNote),
      );
      input.value = '';
      await this.load();
      this.success.set('Replacement uploaded; the previous version is archived.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async convertAsset(asset: Asset): Promise<void> {
    try {
      const job = await firstValueFrom(
        this.api.createRecognitionJob(asset.id, Boolean(this.implicitTuplets()[asset.id])),
      );
      this.recognitionJobs.update((jobs) => ({ ...jobs, [asset.id]: job }));
      this.pollRecognition(asset.id, job.id);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  setImplicitTuplets(assetId: string, enabled: boolean): void {
    this.implicitTuplets.update((values) => ({ ...values, [assetId]: enabled }));
  }

  scoreAssets(edition: Edition): Asset[] {
    return edition.assets.filter((asset) => ['pdf', 'image', 'musicxml'].includes(asset.assetType));
  }

  playbackAssets(edition: Edition): Asset[] {
    return edition.assets.filter(
      (asset) => asset.assetType === 'midi' || asset.assetType === 'audio',
    );
  }

  orderedAssets(edition: Edition): Asset[] {
    return [...this.scoreAssets(edition), ...this.playbackAssets(edition)];
  }

  playbackStartIndex(edition: Edition): number {
    return this.scoreAssets(edition).length;
  }

  assetTypeLabel(asset: Asset): string {
    return { pdf: 'PDF', image: 'IMG', musicxml: 'XML', midi: 'MIDI', audio: 'AUDIO' }[
      asset.assetType
    ];
  }

  assetAccept(asset: Asset): string {
    return {
      pdf: '.pdf,application/pdf',
      image: '.jpg,.jpeg,.png,image/jpeg,image/png',
      musicxml: '.musicxml,.xml,.mxl',
      midi: '.mid,.midi,audio/midi',
      audio: '.mp3,.m4a,.mp4,.ogg,.oga,audio/mpeg,audio/mp4,audio/ogg',
    }[asset.assetType];
  }

  async addYouTube(edition: Edition): Promise<void> {
    if (!this.youtubeDraft.url.trim()) return;
    try {
      await firstValueFrom(
        this.api.createMediaLink(edition.id, this.youtubeDraft.url, this.youtubeDraft.title),
      );
      this.youtubeDraft = { url: '', title: '' };
      this.mediaLinkEditionId = '';
      await this.load();
      this.success.set('YouTube playback source added.');
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async deleteYouTube(id: string): Promise<void> {
    if (!window.confirm('Remove this YouTube playback source and its measure anchors?')) return;
    try {
      await firstValueFrom(this.api.deleteMediaLink(id));
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async retryRecognition(asset: Asset, job: RecognitionJob): Promise<void> {
    try {
      const next = await firstValueFrom(this.api.retryRecognitionJob(job.id));
      this.recognitionJobs.update((jobs) => ({ ...jobs, [asset.id]: next }));
      this.pollRecognition(asset.id, next.id);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async cancelRecognition(asset: Asset, job: RecognitionJob): Promise<void> {
    await firstValueFrom(this.api.cancelRecognitionJob(job.id));
    this.recognitionJobs.update((jobs) => ({
      ...jobs,
      [asset.id]: { ...job, status: 'cancelled' },
    }));
  }

  private pollRecognition(assetId: string, jobId: string): void {
    setTimeout(async () => {
      try {
        const job = await firstValueFrom(this.api.recognitionJob(jobId));
        this.recognitionJobs.update((jobs) => ({ ...jobs, [assetId]: job }));
        if (job.status === 'queued' || job.status === 'processing')
          this.pollRecognition(assetId, jobId);
        else if (job.status === 'succeeded') {
          await this.load();
          const output = this.recognitionOutput(job);
          this.success.set(
            output?.playbackValidation.status === 'blocked'
              ? 'Conversion finished — score needs correction. Download it to fix in MuseScore.'
              : 'PDF converted. Review the new score against the PDF before relying on it.',
          );
        }
      } catch (error) {
        this.error.set(errorMessage(error));
      }
    }, 1500);
  }

  protected recognitionOutput(job: RecognitionJob): Asset | undefined {
    if (!job.outputAssetId) return undefined;
    return this.work()
      ?.editions.flatMap((edition) => edition.assets)
      .find((asset) => asset.id === job.outputAssetId);
  }

  protected recognitionProjectUrl(outputAssetId: string): string {
    return this.recognitionJobsByOutputAssetId()[outputAssetId]?.projectDownloadUrl ?? '';
  }

  protected recognitionQualitySummary(asset: Asset): string {
    if (asset.verificationState !== 'unverified_ocr') return '';
    const report = this.recognitionJobsByOutputAssetId()[asset.id]?.report;
    if (!report) return 'Unverified OCR · compare against the PDF';
    return `Unverified OCR — ${report.correctedMeasures} of ${report.totalMeasures} measures auto-corrected, ${report.suspectMeasures} still suspect`;
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
      await this.timer.start({ workId: this.workId });
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

export function hasApiErrorCode(error: unknown, code: string): boolean {
  return error instanceof HttpErrorResponse && error.error?.error?.code === code;
}
