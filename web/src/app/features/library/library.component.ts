import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LucideFileText,
  LucideHeadphones,
  LucideHeart,
  LucideHeartOff,
  LucidePencil,
  LucidePlus,
  LucideSearch,
  LucideTrash2,
  LucideUpload,
  LucideX,
} from '@lucide/angular';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { Piece, PieceInput, Session } from '../../core/models';
import { listeningUrlError, titleFromFilename } from './library.utils';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

@Component({
  selector: 'app-library',
  imports: [
    FormsModule,
    LucideFileText,
    LucideHeadphones,
    LucideHeart,
    LucideHeartOff,
    LucidePencil,
    LucidePlus,
    LucideSearch,
    LucideTrash2,
    LucideUpload,
    LucideX,
  ],
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
})
export class LibraryComponent implements OnDestroy {
  @ViewChild('editor') private editor?: ElementRef<HTMLDialogElement>;
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly pieces = signal<Piece[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly readingPdf = signal(false);
  protected readonly error = signal('');
  protected readonly session = signal<Session | null>(null);
  protected readonly signingOut = signal(false);
  protected query = '';
  protected favoritesOnly = false;
  protected editing: Piece | null = null;
  protected form: PieceInput = emptyPiece();
  protected selectedFile: File | null = null;
  protected selectedPageCount = 0;
  protected readonly maxUploadLabel = '50 MB';
  private searchTimer?: number;

  constructor() {
    void this.loadSession();
    void this.load();
  }

  async loadSession(): Promise<void> {
    try {
      this.session.set(await firstValueFrom(this.api.session()));
    } catch {
      this.session.set(null);
    }
  }

  async logout(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await firstValueFrom(this.api.logout());
      window.location.reload();
    } catch (error) {
      this.error.set(errorMessage(error));
      this.signingOut.set(false);
    }
  }

  ngOnDestroy(): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
  }

  onSearch(): void {
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => void this.load(), 250);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.pieces.set(await firstValueFrom(this.api.pieces(this.query, this.favoritesOnly)));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate(): void {
    this.editing = null;
    this.form = emptyPiece();
    this.selectedFile = null;
    this.selectedPageCount = 0;
    this.error.set('');
    this.editor?.nativeElement.showModal();
  }

  openEdit(piece: Piece, event?: Event): void {
    event?.stopPropagation();
    this.editing = piece;
    this.form = {
      title: piece.title,
      composer: piece.composer,
      favorite: piece.favorite,
      sourceUrl: piece.sourceUrl,
      listeningUrl: piece.listeningUrl,
      notes: piece.notes,
    };
    this.selectedFile = null;
    this.selectedPageCount = 0;
    this.error.set('');
    this.editor?.nativeElement.showModal();
  }

  closeEditor(): void {
    if (!this.saving()) this.editor?.nativeElement.close();
  }

  async choosePdf(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    this.readingPdf.set(true);
    this.error.set('');
    try {
      const loadingTask = getDocument({ data: await file.arrayBuffer(), wasmUrl: '/pdfjs/wasm/' });
      const document = await loadingTask.promise;
      this.selectedFile = file;
      this.selectedPageCount = document.numPages;
      if (!this.form.title.trim()) this.form.title = titleFromFilename(file.name);
      await loadingTask.destroy();
    } catch {
      this.selectedFile = null;
      this.selectedPageCount = 0;
      input.value = '';
      this.error.set('The selected file could not be read as a PDF.');
    } finally {
      this.readingPdf.set(false);
    }
  }

  async save(): Promise<void> {
    this.form.listeningUrl = this.form.listeningUrl.trim();
    if (
      !this.form.title.trim() ||
      this.listeningUrlValidationError() ||
      this.saving() ||
      this.readingPdf()
    )
      return;
    this.saving.set(true);
    this.error.set('');
    const wasNew = !this.editing;
    try {
      let piece = this.editing
        ? await firstValueFrom(this.api.updatePiece(this.editing.id, this.form))
        : await firstValueFrom(this.api.createPiece(this.form));
      // Keep the created record as the retry target if the separate upload fails.
      if (wasNew) this.editing = piece;
      if (this.selectedFile) {
        piece = await firstValueFrom(
          this.api.uploadPdf(piece.id, this.selectedFile, this.selectedPageCount),
        );
      }
      this.editor?.nativeElement.close();
      await this.load();
      if (wasNew && piece.pdf) await this.router.navigate(['/reader', piece.id]);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  openPiece(piece: Piece): void {
    if (piece.pdf) {
      void this.router.navigate(['/reader', piece.id]);
    } else {
      this.openEdit(piece);
    }
  }

  openPieceFromKeyboard(piece: Piece, event: Event): void {
    if (event.target === event.currentTarget) this.openPiece(piece);
  }

  protected listeningUrlValidationError(): string {
    return listeningUrlError(this.form.listeningUrl);
  }

  async toggleFavorite(piece: Piece, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      const updated = await firstValueFrom(
        this.api.updatePiece(piece.id, { favorite: !piece.favorite }),
      );
      this.pieces.update((pieces) =>
        this.favoritesOnly && !updated.favorite
          ? pieces.filter((candidate) => candidate.id !== updated.id)
          : pieces.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  async deletePiece(piece: Piece): Promise<void> {
    if (!window.confirm(`Delete “${piece.title}” and its PDF? This cannot be undone.`)) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.deletePiece(piece.id));
      this.editor?.nativeElement.close();
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}

function emptyPiece(): PieceInput {
  return {
    title: '',
    composer: '',
    favorite: false,
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
  };
}
