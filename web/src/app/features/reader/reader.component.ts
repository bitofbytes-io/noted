import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  LucideArrowLeft,
  LucideChevronLeft,
  LucideChevronRight,
  LucideMaximize2,
  LucideMinus,
  LucidePause,
  LucidePlay,
  LucidePlus,
  LucideRows3,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { Piece, ReaderMode, ReaderState } from '../../core/models';
import { PageMetric, PdfDocument } from './pdf-document.service';
import { pageDeltaForKey } from './reader.utils';

@Component({
  selector: 'app-reader',
  imports: [
    DecimalPipe,
    LucideArrowLeft,
    LucideChevronLeft,
    LucideChevronRight,
    LucideMaximize2,
    LucideMinus,
    LucidePause,
    LucidePlay,
    LucidePlus,
    LucideRows3,
  ],
  templateUrl: './reader.component.html',
  styleUrl: './reader.component.scss',
})
export class ReaderComponent implements AfterViewInit, OnDestroy {
  @ViewChild('stage', { static: true }) private stage!: ElementRef<HTMLElement>;
  @ViewChild('controls') private controls?: ElementRef<HTMLElement>;
  @ViewChildren('scoreCanvas') private canvases!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('scrollPage') private scrollPages!: QueryList<ElementRef<HTMLElement>>;
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly pdf = new PdfDocument();
  protected readonly piece = signal<Piece | null>(null);
  protected readonly metrics = signal<PageMetric[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mode = signal<ReaderMode>('page');
  protected readonly currentPage = signal(1);
  protected readonly zoom = signal(1);
  protected readonly speed = signal(32);
  protected readonly paused = signal(true);
  protected readonly controlsVisible = signal(true);
  private resizeObserver?: ResizeObserver;
  private renderFrame?: number;
  private scrollFrame?: number;
  private autoScrollFrame?: number;
  private autoScrollTimestamp = 0;
  private autoScrollRemainder = 0;
  private hideTimer?: number;
  private saveTimer?: number;
  private pointerStart?: { x: number; y: number };
  private swiped = false;
  private renderedWidths = new Map<number, number>();
  private destroyed = false;
  private pieceId = '';

  async ngAfterViewInit(): Promise<void> {
    this.pieceId = this.route.snapshot.paramMap.get('pieceId') ?? '';
    this.canvases.changes.subscribe(() => this.scheduleRender());
    this.scrollPages.changes.subscribe(() => this.scheduleRender());
    this.resizeObserver = new ResizeObserver(() => {
      this.renderedWidths.clear();
      this.scheduleRender();
    });
    this.resizeObserver.observe(this.stage.nativeElement);
    await this.load();
    this.scheduleHide();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.saveNow();
    this.resizeObserver?.disconnect();
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    if (this.autoScrollFrame) cancelAnimationFrame(this.autoScrollFrame);
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    void this.pdf.dispose();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [piece, state] = await Promise.all([
        firstValueFrom(this.api.piece(this.pieceId)),
        firstValueFrom(this.api.readerState(this.pieceId)),
      ]);
      if (!piece.pdf) throw new Error('This piece does not have a PDF yet.');
      this.piece.set(piece);
      this.mode.set(state.mode);
      this.zoom.set(clamp(state.zoom, 0.5, 2.5));
      this.speed.set(clamp(state.scrollSpeed, 5, 120));
      this.paused.set(state.scrollPaused);
      const metrics = await this.pdf.load(piece.pdf.contentUrl);
      this.metrics.set(metrics);
      this.currentPage.set(clamp(Math.round(state.lastPage), 1, metrics.length));
      this.loading.set(false);
      setTimeout(() => {
        if (this.mode() === 'scroll') {
          this.stage.nativeElement.scrollTop = Math.max(0, state.scrollPosition);
        }
        this.scheduleRender();
        this.syncAutoScroll();
      });
    } catch (error) {
      this.error.set(errorMessage(error));
      this.loading.set(false);
    }
  }

  back(): void {
    void this.router.navigate(['/']);
  }

  setMode(mode: ReaderMode): void {
    if (mode === this.mode()) return;
    if (this.mode() === 'scroll') this.updateCurrentPage();
    this.mode.set(mode);
    this.renderedWidths.clear();
    this.revealControls();
    setTimeout(() => {
      if (mode === 'scroll') this.scrollToPage(this.currentPage(), false);
      this.scheduleRender();
      this.syncAutoScroll();
    });
    this.queueSave();
  }

  turnPage(delta: number): void {
    if (this.mode() !== 'page') return;
    const next = clamp(this.currentPage() + delta, 1, this.metrics().length);
    if (next === this.currentPage()) return;
    this.currentPage.set(next);
    this.renderedWidths.clear();
    this.scheduleRender();
    this.queueSave();
  }

  changeZoom(delta: number): void {
    const next = clamp(Math.round((this.zoom() + delta) * 10) / 10, 0.5, 2.5);
    if (next === this.zoom()) return;
    this.zoom.set(next);
    this.renderedWidths.clear();
    this.scheduleRender();
    this.queueSave();
  }

  changeSpeed(event: Event): void {
    this.speed.set(Number((event.target as HTMLInputElement).value));
    this.revealControls();
    this.queueSave();
  }

  togglePause(): void {
    if (this.mode() !== 'scroll') return;
    this.paused.update((paused) => !paused);
    this.revealControls();
    this.syncAutoScroll();
    this.queueSave();
  }

  onStageScroll(): void {
    if (this.mode() !== 'scroll') return;
    if (!this.scrollFrame) {
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = undefined;
        this.updateCurrentPage();
        this.scheduleRender();
      });
    }
    this.queueSave();
  }

  onPointerDown(event: PointerEvent): void {
    this.pointerStart = { x: event.clientX, y: event.clientY };
    this.swiped = false;
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.pointerStart) return;
    const deltaX = event.clientX - this.pointerStart.x;
    const deltaY = event.clientY - this.pointerStart.y;
    this.pointerStart = undefined;
    if (Math.hypot(deltaX, deltaY) > 12) this.swiped = true;
    if (this.mode() === 'page' && Math.abs(deltaX) > 60 && Math.abs(deltaY) < 80) {
      this.turnPage(deltaX < 0 ? 1 : -1);
    }
  }

  onScoreTap(event: MouseEvent): void {
    if (this.swiped) {
      this.swiped = false;
      return;
    }
    if ((event.target as HTMLElement).closest('.reader-controls, .reader-topbar')) return;
    if (this.mode() === 'scroll') {
      this.togglePause();
      return;
    }
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width;
    if (position < 0.34) this.turnPage(-1);
    else if (position > 0.66) this.turnPage(1);
    else this.revealControls();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button')) return;
    this.revealControls();
    if (this.mode() === 'scroll' && [' ', 'Enter'].includes(event.key)) {
      event.preventDefault();
      this.togglePause();
      return;
    }
    const delta = pageDeltaForKey(event.key);
    if (delta !== 0 && this.mode() === 'page') {
      event.preventDefault();
      this.turnPage(delta);
    }
  }

  revealControls(): void {
    this.controlsVisible.set(true);
    this.scheduleHide();
  }

  scrollPageWidth(): number {
    const available = Math.max(280, this.stage.nativeElement.clientWidth - 32);
    return Math.round(available * this.zoom());
  }

  private scheduleRender(): void {
    if (this.renderFrame || this.loading()) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = undefined;
      void this.renderVisible();
    });
  }

  private async renderVisible(): Promise<void> {
    if (!this.canvases?.length) return;
    if (this.mode() === 'page') {
      const canvas = this.canvases.first.nativeElement;
      const stage = this.stage.nativeElement;
      const width = Math.max(240, (stage.clientWidth - 24) * this.zoom());
      const height = Math.max(240, (stage.clientHeight - 24) * this.zoom());
      const key = Math.round(Math.min(width, height));
      if (this.renderedWidths.get(this.currentPage()) === key) return;
      await this.pdf.renderPage(canvas, this.currentPage(), width, height);
      this.renderedWidths.set(this.currentPage(), key);
      return;
    }
    const stageRect = this.stage.nativeElement.getBoundingClientRect();
    const pages = this.scrollPages.toArray();
    const canvases = this.canvases.toArray();
    const pending: Promise<void>[] = [];
    pages.forEach((page, index) => {
      const rect = page.nativeElement.getBoundingClientRect();
      const nearby =
        rect.bottom >= stageRect.top - stageRect.height &&
        rect.top <= stageRect.bottom + stageRect.height;
      if (!nearby) return;
      const pageNumber = index + 1;
      const width = Math.round(page.nativeElement.clientWidth);
      if (this.renderedWidths.get(pageNumber) === width) return;
      pending.push(
        this.pdf.renderPage(canvases[index].nativeElement, pageNumber, width).then(() => {
          this.renderedWidths.set(pageNumber, width);
        }),
      );
    });
    await Promise.all(pending);
  }

  private updateCurrentPage(): void {
    const stageTop = this.stage.nativeElement.getBoundingClientRect().top;
    let closestPage = this.currentPage();
    let closestDistance = Number.POSITIVE_INFINITY;
    this.scrollPages.forEach((page, index) => {
      const distance = Math.abs(page.nativeElement.getBoundingClientRect().top - stageTop - 24);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = index + 1;
      }
    });
    this.currentPage.set(closestPage);
  }

  private scrollToPage(page: number, smooth: boolean): void {
    const element = this.scrollPages.get(page - 1)?.nativeElement;
    if (!element) return;
    this.stage.nativeElement.scrollTo({
      top: Math.max(0, element.offsetTop - 80),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  private syncAutoScroll(): void {
    if (this.autoScrollFrame) cancelAnimationFrame(this.autoScrollFrame);
    this.autoScrollFrame = undefined;
    this.autoScrollTimestamp = 0;
    this.autoScrollRemainder = 0;
    if (this.mode() !== 'scroll' || this.paused() || this.destroyed) return;
    const tick = (timestamp: number): void => {
      if (this.mode() !== 'scroll' || this.paused() || this.destroyed) return;
      if (this.autoScrollTimestamp) {
        const elapsed = Math.min(0.1, (timestamp - this.autoScrollTimestamp) / 1000);
        const stage = this.stage.nativeElement;
        const distance = this.autoScrollRemainder + this.speed() * elapsed;
        const wholePixels = Math.floor(distance);
        this.autoScrollRemainder = distance - wholePixels;
        if (wholePixels > 0) stage.scrollTop += wholePixels;
        const reachedEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1;
        if (reachedEnd) {
          this.paused.set(true);
          this.queueSave();
          return;
        }
      }
      this.autoScrollTimestamp = timestamp;
      this.autoScrollFrame = requestAnimationFrame(tick);
    };
    this.autoScrollFrame = requestAnimationFrame(tick);
  }

  private scheduleHide(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.controls?.nativeElement.contains(document.activeElement)) {
        this.scheduleHide();
        return;
      }
      this.controlsVisible.set(false);
    }, 3000);
  }

  private queueSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 650);
  }

  private saveNow(): void {
    if (!this.pieceId || this.loading() || this.error()) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const state: ReaderState = {
      pieceId: this.pieceId,
      mode: this.mode(),
      lastPage: this.currentPage(),
      scrollPosition: this.mode() === 'scroll' ? this.stage.nativeElement.scrollTop : 0,
      zoom: this.zoom(),
      scrollSpeed: this.speed(),
      scrollPaused: this.paused(),
    };
    this.api.saveReaderState(this.pieceId, state).subscribe({
      error: (error: unknown) => console.warn('Reader state could not be saved', error),
    });
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
