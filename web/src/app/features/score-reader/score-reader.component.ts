import {
  AfterViewInit,
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
import { Asset } from '../../core/models';
import { PracticeTimerService } from '../../core/practice-timer.service';
import { PdfFitMode, PdfScoreAdapter } from './pdf-score.adapter';

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
  protected readonly asset = signal<Asset | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected page = 1;
  protected pageCount = 0;
  protected fit: PdfFitMode = 'width';
  protected zoom = 100;
  protected controlsHidden = false;
  protected readonly workId = this.route.snapshot.queryParamMap.get('workId') ?? '';
  private readonly adapter = new PdfScoreAdapter();
  private resizeObserver?: ResizeObserver;

  constructor(
    private readonly api: ApiService,
    protected readonly timer: PracticeTimerService,
  ) {}

  ngAfterViewInit(): void {
    void this.load();
    this.resizeObserver = new ResizeObserver(() => void this.render());
    this.resizeObserver.observe(this.stage.nativeElement);
    void this.timer.initialize();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    void this.adapter.dispose();
  }

  async load(): Promise<void> {
    const assetId = this.route.snapshot.paramMap.get('assetId') ?? '';
    try {
      const asset = await firstValueFrom(this.api.asset(assetId));
      if (asset.assetType !== 'pdf') throw new Error('This asset is not a PDF');
      this.asset.set(asset);
      this.pageCount = await this.adapter.load(asset.contentUrl);
      await this.render();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async render(): Promise<void> {
    if (!this.asset() || !this.canvas || !this.stage) return;
    const rect = this.stage.nativeElement.getBoundingClientRect();
    try {
      await this.adapter.render(
        this.canvas.nativeElement,
        this.page,
        this.fit,
        rect.width,
        rect.height,
        this.zoom / 100,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'RenderingCancelledException')
        this.error.set(errorMessage(error));
    }
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

  async startPractice(): Promise<void> {
    if (!this.workId) return;
    try {
      await this.timer.start({ workId: this.workId, scoreAssetId: this.asset()?.id });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
