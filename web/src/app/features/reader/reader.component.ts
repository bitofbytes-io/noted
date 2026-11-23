import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe, Location } from '@angular/common';
import { ActivatedRoute, PRIMARY_OUTLET, Router } from '@angular/router';
import {
  LucideArrowLeft,
  LucideBookOpen,
  LucideChevronLeft,
  LucideChevronRight,
  LucideMaximize2,
  LucideMetronome,
  LucideMinus,
  LucidePause,
  LucidePlay,
  LucidePlus,
  LucideRows3,
  LucideSlidersHorizontal,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { rememberedLibraryParams } from '../../core/library-address';
import { Piece, ReaderMode, ReaderState } from '../../core/models';
import { measureAsync } from '../../core/performance';
import { AutoScroll } from './auto-scroll';
import { MetronomeComponent } from './metronome/metronome.component';
import { PageMetric, PdfDocument } from './pdf-document.service';
import { ReaderChrome } from './reader-chrome';
import { ReaderLayout } from './reader-layout';
import { closestScrollPage } from './reader-navigation';
import { ReaderRenderer } from './reader-renderer';
import { ReaderStateSaver } from './reader-state-saver';
import { SwipeTracker } from './reader-swipe';
import { clamp, pageDeltaForKey, spreadLabels } from './reader.utils';
import { ScreenWakeLock } from './screen-wake-lock';

@Component({
  selector: 'app-reader',
  imports: [
    DecimalPipe,
    MetronomeComponent,
    LucideArrowLeft,
    LucideBookOpen,
    LucideChevronLeft,
    LucideChevronRight,
    LucideMaximize2,
    LucideMetronome,
    LucideMinus,
    LucidePause,
    LucidePlay,
    LucidePlus,
    LucideRows3,
    LucideSlidersHorizontal,
  ],
  templateUrl: './reader.component.html',
  styleUrl: './reader.component.scss',
})
export class ReaderComponent implements AfterViewInit, OnDestroy {
  @ViewChild('stage', { static: true }) private stage!: ElementRef<HTMLElement>;
  @ViewChild('topbar') private topbar?: ElementRef<HTMLElement>;
  @ViewChild('controls') private controls?: ElementRef<HTMLElement>;
  @ViewChild('metronome', { read: ElementRef }) private metronome?: ElementRef<HTMLElement>;
  @ViewChildren('scoreCanvas') private canvases!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChildren('scrollPage') private scrollPages!: QueryList<ElementRef<HTMLElement>>;
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly pdf = new PdfDocument();
  private readonly wakeLock = new ScreenWakeLock();
  protected readonly piece = signal<Piece | null>(null);
  protected readonly metrics = signal<PageMetric[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mode = signal<ReaderMode>('page');
  protected readonly currentPage = signal(1);
  protected readonly spreadLabels = spreadLabels;
  protected readonly layout = new ReaderLayout({
    mode: this.mode,
    currentPage: this.currentPage,
    pageCount: computed(() => this.metrics().length),
  });
  protected readonly zoom = signal(1);
  protected readonly speed = signal(5);
  protected readonly paused = signal(true);
  protected readonly metronomeOpen = signal(false);
  protected readonly metronomeRunning = signal(false);
  protected readonly chrome = new ReaderChrome({
    held: computed(() => this.loading() || Boolean(this.error())),
    focusInside: () => {
      const active = document.activeElement;
      return [this.topbar, this.controls, this.metronome].some((region) =>
        active ? region?.nativeElement.contains(active) : false,
      );
    },
    focusFirstControl: () => this.topbar?.nativeElement.querySelector('button')?.focus(),
  });
  private readonly renderer = new ReaderRenderer(this.pdf, {
    stage: () => this.stage.nativeElement,
    canvases: () => this.canvases,
    scrollPages: () => this.scrollPages,
    mode: () => this.mode(),
    zoom: () => this.zoom(),
    visiblePages: () => this.layout.visiblePages(),
    halfShown: () => this.layout.halfShown(),
    setHalfShift: (shift) => this.layout.halfShift.set(shift),
    requestRender: () => this.scheduleRender(),
  });
  private readonly autoScroll = new AutoScroll({
    running: () => this.mode() === 'scroll' && !this.paused() && !this.destroyed,
    stage: () => this.stage.nativeElement,
    speed: () => this.speed(),
    reachedEnd: () => {
      this.paused.set(true);
      this.readerState.saveNow();
    },
  });
  private readonly readerState = new ReaderStateSaver(this.api, {
    capture: () => this.captureReaderState(),
    onConflict: (state) => {
      if (this.loadedPDFChecksum !== state.pdfChecksumSha256) return false;
      this.paused.set(true);
      this.autoScroll.sync();
      this.error.set('This score changed while it was open. Reload it before continuing.');
      return true;
    },
  });
  private resizeObserver?: ResizeObserver;
  private renderFrame?: number;
  private scrollFrame?: number;
  protected readonly swipe = new SwipeTracker();
  private destroyed = false;
  private loadedPDFChecksum = '';
  private pieceId = '';

  async ngAfterViewInit(): Promise<void> {
    this.pieceId = this.route.snapshot.paramMap.get('pieceId') ?? '';
    this.wakeLock.start();
    this.canvases.changes.subscribe(() => this.scheduleRender());
    this.scrollPages.changes.subscribe(() => this.scheduleRender());
    this.resizeObserver = new ResizeObserver(() => {
      const stage = this.stage.nativeElement;
      this.layout.viewport.set({ width: stage.clientWidth, height: stage.clientHeight });
      this.renderer.reset();
      this.scheduleRender();
    });
    this.resizeObserver.observe(this.stage.nativeElement);
    await this.load();
    this.chrome.scheduleHide();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.wakeLock.stop();
    this.readerState.saveNow();
    this.resizeObserver?.disconnect();
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.autoScroll.stop();
    this.chrome.dispose();
    this.readerState.dispose();
    void this.pdf.dispose();
  }

  private async load(): Promise<void> {
    await measureAsync('noted.reader.load', async () => {
      this.loading.set(true);
      this.error.set('');
      this.readerState.reset();
      this.loadedPDFChecksum = '';
      this.renderer.reset();
      try {
        const [piece, state] = await Promise.all([
          firstValueFrom(this.api.piece(this.pieceId)),
          firstValueFrom(this.api.readerState(this.pieceId)),
        ]);
        if (!piece.pdf) throw new Error('This piece does not have a PDF yet.');
        if (state.pdfChecksumSha256 !== piece.pdf.checksumSha256) {
          throw new Error('The score changed while it was opening. Reload the reader.');
        }
        this.piece.set(piece);
        this.loadedPDFChecksum = piece.pdf.checksumSha256;
        this.mode.set(state.mode);
        this.zoom.set(clamp(state.zoom, 0.5, 2.5));
        this.speed.set(clamp(state.scrollSpeed, 1, 10));
        this.paused.set(state.scrollPaused);
        const metrics = await this.pdf.load(piece.pdf.contentUrl);
        this.metrics.set(metrics);
        this.currentPage.set(clamp(Math.round(state.lastPage), 1, metrics.length));
        this.layout.halfTurned.set(false);
        this.loading.set(false);
        setTimeout(() => {
          if (this.mode() === 'scroll') {
            this.stage.nativeElement.scrollTop = Math.max(0, state.scrollPosition);
          }
          this.scheduleRender();
          this.autoScroll.sync();
        });
      } catch (error) {
        this.wakeLock.stop();
        this.error.set(errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  /**
   * Returns to the library as it was left: Back, when the reader was opened
   * from it, or else the library's last search, filter and sort in this tab.
   */
  back(): void {
    const previous = this.router.lastSuccessfulNavigation()?.previousNavigation?.finalUrl;
    if (previous && !previous.root.children[PRIMARY_OUTLET]) {
      this.location.back();
    } else {
      void this.router.navigate(['/'], { queryParams: rememberedLibraryParams() });
    }
  }

  reload(): void {
    this.wakeLock.start();
    void this.load().then(() => this.chrome.scheduleHide());
  }

  setMode(mode: ReaderMode): void {
    if (mode === this.mode()) return;
    if (this.mode() === 'scroll') this.updateCurrentPage();
    this.mode.set(mode);
    this.layout.halfTurned.set(false);
    this.renderer.reset();
    setTimeout(() => {
      if (mode === 'scroll') this.scrollToPage(this.currentPage(), false);
      this.scheduleRender();
      this.autoScroll.sync();
      this.readerState.saveNow();
    });
  }

  turnPage(delta: number): void {
    if (this.mode() !== 'page' || !this.layout.turn(delta)) return;
    this.renderer.clearVisiblePage();
    this.scheduleRender();
    this.readerState.queue();
  }

  cycleSpread(event?: MouseEvent): void {
    this.layout.cycleSpread();
    this.renderer.forgetPage();
    this.scheduleRender();
    this.releaseFocusAfterPointerPress(event);
  }

  changeZoom(delta: number): void {
    const next = clamp(Math.round((this.zoom() + delta) * 10) / 10, 0.5, 2.5);
    if (next === this.zoom()) return;
    this.zoom.set(next);
    this.renderer.reset();
    this.scheduleRender();
    this.readerState.queue();
  }

  toggleMetronome(event?: MouseEvent): void {
    this.metronomeOpen.update((open) => !open);
    this.releaseFocusAfterPointerPress(event);
  }

  /** A pointer press leaves the button focused, and pedal keys sent to a button don't turn pages. */
  private releaseFocusAfterPointerPress(event?: MouseEvent): void {
    if (event && event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur();
  }

  changeSpeed(event: Event): void {
    this.speed.set(Number((event.target as HTMLInputElement).value));
    this.readerState.queue();
  }

  togglePause(): void {
    if (this.mode() !== 'scroll') return;
    this.paused.update((paused) => !paused);
    this.autoScroll.sync();
    this.readerState.saveNow();
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
    this.readerState.queue();
  }

  onPointerUp(event: PointerEvent): void {
    const delta = this.swipe.up(event);
    if (delta !== 0 && this.mode() === 'page') this.turnPage(delta);
  }

  onScoreTap(event: MouseEvent): void {
    if (this.swipe.consumeDrag()) return;
    if (
      (event.target as HTMLElement).closest(
        '.reader-controls, .reader-topbar, .reader-controls-bubble, .reader-metronome',
      )
    )
      return;
    this.chrome.offer();
    if (this.mode() === 'scroll') {
      this.togglePause();
      return;
    }
    const rect = this.stage.nativeElement.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width;
    if (position < 0.34) this.turnPage(-1);
    else if (position > 0.66) this.turnPage(1);
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button')) return;
    this.chrome.offer();
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

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') this.readerState.saveNow();
  }

  scrollPageWidth(): number {
    const available = Math.max(280, this.stage.nativeElement.clientWidth - 32);
    return Math.round(available * this.zoom());
  }

  private scheduleRender(): void {
    if (this.renderFrame || this.loading()) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = undefined;
      void this.renderer.renderVisible();
    });
  }

  private updateCurrentPage(): void {
    const stageTop = this.stage.nativeElement.getBoundingClientRect().top;
    const pageTops = this.scrollPages.map((page) => page.nativeElement.getBoundingClientRect().top);
    this.currentPage.set(closestScrollPage(stageTop, pageTops, this.currentPage()));
  }

  private scrollToPage(page: number, smooth: boolean): void {
    const element = this.scrollPages.get(page - 1)?.nativeElement;
    if (!element) return;
    this.stage.nativeElement.scrollTo({
      top: Math.max(0, element.offsetTop - 80),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /** The state to save, or nothing until a score is loaded and while the reader is failing. */
  private captureReaderState(): ReaderState | undefined {
    if (!this.pieceId || !this.loadedPDFChecksum || this.loading() || this.error())
      return undefined;
    return {
      pieceId: this.pieceId,
      pdfChecksumSha256: this.loadedPDFChecksum,
      mode: this.mode(),
      lastPage: this.mode() === 'page' ? this.layout.visiblePages()[0] : this.currentPage(),
      scrollPosition: this.mode() === 'scroll' ? this.stage.nativeElement.scrollTop : 0,
      zoom: this.zoom(),
      scrollSpeed: this.speed(),
      scrollPaused: this.paused(),
    };
  }
}
