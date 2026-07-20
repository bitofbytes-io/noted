import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  Asset,
  MeasureAnchor,
  MeasureBox,
  MeasureMap,
  MeasureMapPage,
  MediaLink,
  WorkDetail,
} from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { MidiPlaybackAdapter } from './midi-playback.adapter';
import { positionForMeasure } from './playback-sync';
import { PdfFitMode, PdfScoreAdapter } from './pdf-score.adapter';
import { YouTubePlayerAdapter } from './youtube-player.adapter';

type SourceKind = 'score' | 'midi' | 'audio' | 'youtube';
interface PlaybackSource {
  id: string;
  kind: SourceKind;
  label: string;
  asset?: Asset;
  mediaLink?: MediaLink;
}

@Component({
  selector: 'app-score-reader',
  imports: [RouterLink],
  templateUrl: './score-reader.component.html',
  styleUrl: './score-reader.component.scss',
})
export class ScoreReaderComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  @ViewChild('canvas', { static: true }) private canvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('stage', { static: true }) private stage!: ElementRef<HTMLElement>;
  @ViewChild('audio') private audio?: ElementRef<HTMLAudioElement>;
  @ViewChild('youtubeHost') private youtubeHost?: ElementRef<HTMLElement>;
  @ViewChild('midiHost') private midiHost?: ElementRef<HTMLElement>;
  protected readonly asset = signal<Asset | null>(null);
  protected readonly work = signal<WorkDetail | null>(null);
  protected readonly measureMap = signal<MeasureMap | null>(null);
  protected readonly anchors = signal<MeasureAnchor[]>([]);
  protected readonly sources = signal<PlaybackSource[]>([]);
  protected readonly activeSource = signal<PlaybackSource | null>(null);
  protected readonly playing = signal(false);
  protected readonly positionMs = signal(0);
  protected readonly durationMs = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected page = 1;
  protected pageCount = 0;
  protected fit: PdfFitMode = 'width';
  protected zoom = 100;
  protected controlsHidden = false;
  protected overlayVisible = true;
  protected selectionStart: number | null = null;
  protected selectionEnd: number | null = null;
  protected selectionArmed = false;
  protected looping = false;
  protected anchorMode = false;
  protected playbackRate = 1;
  protected anchorsDirty = false;
  protected readonly workId = this.route.snapshot.queryParamMap.get('workId') ?? '';
  private readonly adapter = new PdfScoreAdapter();
  private readonly midi = new MidiPlaybackAdapter();
  private readonly youtube = new YouTubePlayerAdapter();
  private image?: HTMLImageElement;
  private resizeObserver?: ResizeObserver;
  private positionTimer?: number;
  private measureMapPollTimer?: number;
  private destroyed = false;

  constructor(
    private readonly api: ApiService,
    private readonly changeDetector: ChangeDetectorRef,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngAfterViewInit(): void {
    void this.load();
    this.resizeObserver = new ResizeObserver(() => void this.render());
    this.resizeObserver.observe(this.stage.nativeElement);
    this.positionTimer = window.setInterval(() => this.updatePlaybackPosition(), 200);
    void this.timer.initialize();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    if (this.positionTimer) window.clearInterval(this.positionTimer);
    if (this.measureMapPollTimer) window.clearTimeout(this.measureMapPollTimer);
    this.pause();
    this.youtube.dispose();
    this.midi.dispose();
    void this.adapter.dispose();
  }

  async load(): Promise<void> {
    const assetId = this.route.snapshot.paramMap.get('assetId') ?? '';
    this.loading.set(true);
    this.error.set('');
    try {
      await this.adapter.dispose();
      const asset = await firstValueFrom(this.api.asset(assetId));
      const work = this.workId
        ? await Promise.resolve()
            .then(() => firstValueFrom(this.api.work(this.workId)))
            .catch(() => null)
        : null;
      if (asset.assetType !== 'pdf' && asset.assetType !== 'image') {
        throw new Error('This asset is not a visual score');
      }
      this.asset.set(asset);
      this.work.set(work);
      if (asset.assetType === 'pdf') {
        this.pageCount = await this.adapter.load(asset.contentUrl);
      } else {
        this.image = await this.loadImage(asset.contentUrl);
        this.pageCount = 1;
      }
      await this.loadMeasureMap(asset.id);
      const sources = this.buildSources(work);
      this.sources.set(sources);
      await this.render();
      const playableSources = sources.filter((source) => source.kind !== 'score');
      if (playableSources.length === 1) await this.chooseSource(playableSources[0]);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadMeasureMap(assetId: string): Promise<void> {
    if (this.measureMapPollTimer) window.clearTimeout(this.measureMapPollTimer);
    try {
      const map = await firstValueFrom(this.api.measureMap(assetId));
      if (this.destroyed) return;
      this.measureMap.set(map);
      if (map.status === 'pending' || map.status === 'processing') {
        this.measureMapPollTimer = window.setTimeout(() => void this.loadMeasureMap(assetId), 2000);
      }
    } catch {
      this.measureMap.set(null);
    }
  }

  retry(): void {
    void this.load();
  }

  async render(): Promise<void> {
    const asset = this.asset();
    if (!asset || !this.canvas || !this.stage) return;
    const rect = this.stage.nativeElement.getBoundingClientRect();
    try {
      if (asset.assetType === 'pdf') {
        await this.adapter.render(
          this.canvas.nativeElement,
          this.page,
          this.fit,
          rect.width,
          rect.height,
          this.zoom / 100,
        );
      } else if (this.image) {
        this.renderImage(this.image, rect.width, rect.height);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') {
        this.error.set(`The score could not be rendered. ${errorMessage(error)}`);
      }
    }
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The score image could not be loaded'));
      image.src = url;
    });
  }

  private renderImage(
    image: HTMLImageElement,
    availableWidth: number,
    availableHeight: number,
  ): void {
    const widthScale = Math.max(0.25, (availableWidth - 28) / image.naturalWidth);
    const heightScale = Math.max(0.25, (availableHeight - 28) / image.naturalHeight);
    const scale =
      (this.fit === 'width' ? widthScale : Math.min(widthScale, heightScale)) * (this.zoom / 100);
    const width = Math.floor(image.naturalWidth * scale);
    const height = Math.floor(image.naturalHeight * scale);
    const outputScale = window.devicePixelRatio || 1;
    const canvas = this.canvas.nativeElement;
    canvas.width = Math.floor(width * outputScale);
    canvas.height = Math.floor(height * outputScale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  changePage(delta: number): void {
    this.page = Math.min(this.pageCount, Math.max(1, this.page + delta));
    this.stage.nativeElement.scrollTo({ top: 0 });
    void this.render();
  }
  setFit(mode: PdfFitMode): void {
    this.fit = mode;
    void this.render();
  }
  changeZoom(delta: number): void {
    this.zoom = Math.min(200, Math.max(75, this.zoom + delta));
    void this.render();
  }

  currentPageMap(): MeasureMapPage | undefined {
    return this.measureMap()?.pages.find((page) => page.pageNumber === this.page);
  }
  measureStyle(box: MeasureBox, page: MeasureMapPage): Record<string, string> {
    return {
      left: `${(box.x / page.width) * 100}%`,
      top: `${(box.y / page.height) * 100}%`,
      width: `${(box.width / page.width) * 100}%`,
      height: `${(box.height / page.height) * 100}%`,
    };
  }
  measureSelected(number: number): boolean {
    return (
      this.selectionStart !== null &&
      this.selectionEnd !== null &&
      number >= this.selectionStart &&
      number <= this.selectionEnd
    );
  }
  measureAnchored(number: number): boolean {
    return this.anchors().some((anchor) => anchor.measureNumber === number);
  }
  selectMeasure(number: number): void {
    if (this.anchorMode && this.activeSource()) {
      const replacement = { measureNumber: number, positionMs: Math.round(this.readPosition()) };
      this.anchors.update((anchors) =>
        [...anchors.filter((anchor) => anchor.measureNumber !== number), replacement].sort(
          (a, b) => a.measureNumber - b.measureNumber,
        ),
      );
      this.anchorsDirty = true;
    } else if (this.activeSource() && this.anchors().length) {
      const position = this.positionForMeasure(number);
      if (position !== null) this.seek(position);
    }
    if (this.selectionStart === null || !this.selectionArmed) {
      this.selectionStart = number;
      this.selectionEnd = number;
      this.selectionArmed = true;
    } else {
      const first = this.selectionStart;
      this.selectionStart = Math.min(first, number);
      this.selectionEnd = Math.max(first, number);
      this.selectionArmed = false;
    }
  }
  clearSelection(): void {
    this.selectionStart = null;
    this.selectionEnd = null;
    this.selectionArmed = false;
  }

  private buildSources(work: WorkDetail | null): PlaybackSource[] {
    if (!work) return [];
    const sources: PlaybackSource[] = [];
    const visualEditionId = this.asset()?.editionId;
    for (const edition of work.editions.filter((edition) => edition.id === visualEditionId)) {
      for (const asset of edition.assets.filter((asset) => !asset.archivedAt)) {
        if (asset.assetType === 'musicxml' && asset.playbackCapable)
          sources.push({ id: asset.id, kind: 'score', label: 'Score', asset });
        if (asset.assetType === 'midi')
          sources.push({ id: asset.id, kind: 'midi', label: 'MIDI', asset });
        if (asset.assetType === 'audio')
          sources.push({ id: asset.id, kind: 'audio', label: asset.displayName || 'Audio', asset });
      }
      for (const link of edition.mediaLinks ?? [])
        sources.push({
          id: link.id,
          kind: 'youtube',
          label: link.title || 'YouTube',
          mediaLink: link,
        });
    }
    return sources;
  }

  async chooseSource(source: PlaybackSource): Promise<void> {
    if (source.kind === 'score') return;
    this.pause();
    this.youtube.dispose();
    this.midi.dispose();
    this.activeSource.set(source);
    this.positionMs.set(0);
    this.durationMs.set(0);
    this.anchorMode = false;
    this.anchorsDirty = false;
    // The media host is conditional on activeSource. Render it before asking an
    // adapter to mount its player; otherwise the first source click appears to
    // do nothing because the ViewChild is still undefined.
    this.changeDetector.detectChanges();
    try {
      const anchors = source.mediaLink
        ? (await firstValueFrom(this.api.mediaLinkAnchors(source.id))).items
        : (await firstValueFrom(this.api.assetAnchors(source.id))).items;
      this.anchors.set(anchors);
      await new Promise((resolve) => setTimeout(resolve));
      if (source.kind === 'audio') {
        this.audio?.nativeElement.load();
      } else if (source.kind === 'youtube' && source.mediaLink && this.youtubeHost) {
        await this.youtube.load(this.youtubeHost.nativeElement, source.mediaLink.videoId);
      } else if (source.kind === 'midi' && source.asset && this.midiHost) {
        await this.midi.load(this.midiHost.nativeElement, source.asset.contentUrl);
      }
      this.setRate(this.playbackRate);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  playPause(): void {
    const source = this.activeSource();
    if (!source) return;
    if (this.playing()) {
      this.pause();
      return;
    }
    if (source.kind === 'audio') void this.audio?.nativeElement.play();
    if (source.kind === 'youtube') this.youtube.play();
    if (source.kind === 'midi') this.midi.play();
    this.playing.set(true);
  }
  pause(): void {
    this.audio?.nativeElement.pause();
    this.youtube.pause();
    this.midi.pause();
    this.playing.set(false);
  }
  setRate(rate: number): void {
    this.playbackRate = Math.min(2, Math.max(0.25, rate));
    if (this.audio) this.audio.nativeElement.playbackRate = this.playbackRate;
    this.youtube.setRate(this.playbackRate);
    this.midi.setRate(this.playbackRate);
  }
  seek(positionMs: number): void {
    const value = Math.max(0, positionMs);
    const source = this.activeSource();
    if (source?.kind === 'audio' && this.audio) this.audio.nativeElement.currentTime = value / 1000;
    if (source?.kind === 'youtube') this.youtube.seek(value);
    if (source?.kind === 'midi') this.midi.seek(value);
    this.positionMs.set(value);
  }
  seekPercent(percent: number): void {
    this.seek((this.durationMs() * percent) / 100);
  }
  scrubPercent(): number {
    return this.durationMs() > 0 ? (this.positionMs() / this.durationMs()) * 100 : 0;
  }
  private readPosition(): number {
    const source = this.activeSource();
    if (source?.kind === 'audio') return (this.audio?.nativeElement.currentTime ?? 0) * 1000;
    if (source?.kind === 'youtube') return this.youtube.positionMs();
    if (source?.kind === 'midi') return this.midi.positionMs();
    return 0;
  }
  private readDuration(): number {
    const source = this.activeSource();
    if (source?.kind === 'audio') return (this.audio?.nativeElement.duration || 0) * 1000;
    if (source?.kind === 'youtube') return this.youtube.durationMs();
    if (source?.kind === 'midi') return this.midi.durationMs();
    return 0;
  }
  private updatePlaybackPosition(): void {
    const source = this.activeSource();
    if (!source) return;
    const position = this.readPosition();
    this.positionMs.set(position);
    this.durationMs.set(this.readDuration());
    if (source.kind === 'audio') this.playing.set(!(this.audio?.nativeElement.paused ?? true));
    if (source.kind === 'youtube') this.playing.set(this.youtube.isPlaying());
    if (source.kind === 'midi') this.playing.set(this.midi.isPlaying());
    if (this.looping && this.selectionStart !== null && this.selectionEnd !== null) {
      const start = this.positionForMeasure(this.selectionStart);
      const end = this.positionForMeasure(this.selectionEnd + 1);
      if (start !== null && end !== null && position >= end) this.seek(start);
    }
  }
  private positionForMeasure(measure: number): number | null {
    return positionForMeasure(this.anchors(), measure);
  }

  adjustAnchor(anchor: MeasureAnchor, deltaMs: number): void {
    this.anchors.update((anchors) =>
      anchors.map((item) =>
        item.measureNumber === anchor.measureNumber
          ? { ...item, positionMs: Math.max(0, item.positionMs + deltaMs) }
          : item,
      ),
    );
    this.anchorsDirty = true;
  }
  removeAnchor(anchor: MeasureAnchor): void {
    this.anchors.update((anchors) =>
      anchors.filter((item) => item.measureNumber !== anchor.measureNumber),
    );
    this.anchorsDirty = true;
  }
  async saveAnchors(): Promise<void> {
    const source = this.activeSource();
    if (!source) return;
    try {
      const response = source.mediaLink
        ? await firstValueFrom(this.api.replaceMediaLinkAnchors(source.id, this.anchors()))
        : await firstValueFrom(this.api.replaceAssetAnchors(source.id, this.anchors()));
      this.anchors.set(response.items);
      this.anchorsDirty = false;
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  formatTime(valueMs: number): string {
    const seconds = Math.max(0, Math.floor(valueMs / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  async startPractice(): Promise<void> {
    if (!this.workId) return;
    try {
      await this.timer.start({
        workId: this.workId,
        scoreAssetId: this.asset()?.id,
        startMeasure: this.selectionStart,
        endMeasure: this.selectionEnd,
      });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
