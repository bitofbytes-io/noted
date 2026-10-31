import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideDownload, LucideFileText, LucidePlus, LucideTrash2, LucideX } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { clearLibraryParams } from '../../core/library-address';
import {
  LIBRARY_SORTS,
  LibraryFilter,
  LibrarySort,
  ImportDraft,
  MAX_PREPARED_PAGES,
  PIECE_STATUSES,
  Piece,
  PieceInput,
  PieceStatus,
  PieceSummary,
  Session,
} from '../../core/models';
import { fold } from '../../core/search';
import { ComposerFieldComponent } from '../composers/composer-field.component';
import { SuggestionsComponent } from '../suggestions/suggestions.component';
import { ChoiceMenuComponent } from './choice-menu.component';
import { LibraryAccountComponent } from './library-account.component';
import { LibraryListItemComponent } from './library-list-item.component';
import { LibraryToolbarComponent } from './library-toolbar.component';
import { LibraryStore } from './library.store';
import { listeningUrlError } from './library.utils';

/** The details form always carries a status and aliases, unlike an import draft's metadata. */
type PieceForm = PieceInput & { status: PieceStatus; aliases: string };

@Component({
  selector: 'app-library',
  imports: [
    RouterLink,
    SuggestionsComponent,
    ComposerFieldComponent,
    ChoiceMenuComponent,
    LibraryToolbarComponent,
    LibraryListItemComponent,
    LibraryAccountComponent,
    FormsModule,
    LucideDownload,
    LucideFileText,
    LucidePlus,
    LucideTrash2,
    LucideX,
  ],
  providers: [LibraryStore],
  templateUrl: './library.component.html',
  styleUrl: './library.component.scss',
  // The toolbar and rows look up this host for the search, the rows and open
  // dialogs. The class is the handle: the test renderer does not use the selector.
  host: { class: 'library-page' },
})
export class LibraryComponent {
  private readonly store = inject(LibraryStore);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly changes = inject(ChangeDetectorRef);
  private readonly accountPanel = viewChild(LibraryAccountComponent);
  private readonly editor = viewChild<ElementRef<HTMLDialogElement>>('editor');
  protected readonly drafts = signal<ImportDraft[]>([]);
  protected readonly saving = signal(false);
  protected readonly maxPreparedPages = MAX_PREPARED_PAGES;
  protected readonly librarySorts = LIBRARY_SORTS;
  protected readonly pieceStatuses = PIECE_STATUSES;
  protected readonly query = this.store.query;
  protected readonly filter = this.store.filter;
  protected readonly sort = this.store.sort;
  protected readonly searching = this.store.searching;
  protected readonly visible = this.store.visible;
  protected readonly continued = this.store.continued;
  protected readonly listed = this.store.listed;
  protected readonly onlyShelved = this.store.onlyShelved;
  protected readonly loading = this.store.loading;
  protected readonly error = this.store.error;
  protected readonly session = signal<Session | null>(null);
  protected readonly signingOut = signal(false);
  /** The whole piece in the details form, with its notes and source. */
  protected editing: Piece | null = null;
  protected form: PieceForm = emptyPiece();
  /** Ignores a details read that finishes after another row's details were asked for. */
  private editRequest = 0;

  constructor() {
    afterNextRender(() => {
      // The address is written again by the store, without details=new.
      if (this.route.snapshot.queryParamMap.get('details') === 'new') this.openCreate();
    });
    void this.loadSession();
    void this.loadDrafts();
  }

  /** Loads the whole library from the server: on opening, and after a save or delete. */
  load(): Promise<void> {
    return this.store.load();
  }

  chooseFilter(filter: LibraryFilter): Promise<void> {
    return this.store.chooseFilter(filter);
  }

  chooseSort(sort: LibrarySort): Promise<void> {
    return this.store.chooseSort(sort);
  }

  /** The page asks the account dialog to create or replace the shortcut token. */
  createShortcut(): Promise<void> {
    return this.accountPanel()?.createShortcut() ?? Promise.resolve();
  }

  protected openAccount(): void {
    this.accountPanel()?.open();
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
      clearLibraryParams();
      // Drop the search from the address too, so the next account is not returned to it.
      window.location.replace('/');
    } catch (error) {
      this.error.set(errorMessage(error));
      this.signingOut.set(false);
    }
  }

  async loadDrafts(): Promise<void> {
    try {
      this.drafts.set(await firstValueFrom(this.api.imports()));
    } catch {
      /* Library remains usable if drafts are temporarily unavailable. */
    }
  }

  /** A saved score longer than the preparation limit cannot be opened in Prepare. */
  protected tooLongToPrepare(piece: Piece | null): boolean {
    return (piece?.pdf?.pageCount ?? 0) > MAX_PREPARED_PAGES;
  }

  /** Opens Prepare for the piece, which is how a PDF is added, edited or replaced. */
  async editPages(): Promise<void> {
    if (!this.editing || this.saving() || this.tooLongToPrepare(this.editing)) return;
    if (this.editorDirty()) {
      const saved = await this.persistEditor();
      if (!saved || !this.editing) return;
    }
    this.editor()?.nativeElement.close();
    await this.beginImport(this.editing);
  }

  async beginImport(piece?: Piece, event?: Event, mode = 'all'): Promise<void> {
    event?.stopPropagation();
    try {
      const draft = await firstValueFrom(this.api.createImport(piece?.id));
      await this.router.navigate(['/prepare', draft.id], { queryParams: { source: mode } });
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  resumeImport(id: string): void {
    void this.router.navigate(['/prepare', id]);
  }

  openCreate(): void {
    this.editRequest++;
    this.error.set('');
    this.editing = null;
    this.form = emptyPiece();
    this.editor()?.nativeElement.showModal();
  }

  /** Reads the whole piece, which a library row leaves out, then opens its details. */
  async openEdit(row: PieceSummary, event?: Event): Promise<void> {
    event?.stopPropagation();
    const request = ++this.editRequest;
    this.error.set('');
    let piece: Piece;
    try {
      piece = await firstValueFrom(this.api.piece(row.id));
    } catch (error) {
      if (request === this.editRequest) this.error.set(errorMessage(error));
      return;
    }
    if (request !== this.editRequest) return;
    this.editing = piece;
    this.form = {
      title: piece.title,
      composer: piece.composer,
      favorite: piece.favorite,
      status: piece.status,
      sourceUrl: piece.sourceUrl,
      listeningUrl: piece.listeningUrl,
      notes: piece.notes,
      aliases: piece.aliases,
      opus: piece.opus ?? '',
      musicKey: piece.musicKey ?? '',
    };
    // The form fields are not signals, and nothing else marks the view after the read.
    this.changes.markForCheck();
    this.editor()?.nativeElement.showModal();
  }

  closeEditor(): void {
    if (this.saving()) return;
    this.editor()?.nativeElement.close();
  }

  async save(): Promise<void> {
    const piece = await this.persistEditor();
    if (!piece) return;
    this.editor()?.nativeElement.close();
    await this.load();
  }

  openPiece(piece: PieceSummary): void {
    if (piece.pdf) {
      void this.router.navigate(['/reader', piece.id]);
    } else {
      void this.openEdit(piece);
    }
  }

  // Form fields are plain properties: evaluate after each input event, rather
  // than caching a computed signal that would not track title edits.
  protected duplicateTitle(): PieceSummary | undefined {
    const title = fold(this.form.title.trim());
    if (!title) return undefined;
    return this.store
      .allPieces()
      .find((piece) => piece.id !== this.editing?.id && fold(piece.title.trim()) === title);
  }

  protected listeningUrlValidationError(): string {
    return listeningUrlError(this.form.listeningUrl);
  }

  async deletePiece(piece: Piece): Promise<void> {
    if (!window.confirm(`Delete “${piece.title}” and its PDF? This cannot be undone.`)) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.deletePiece(piece.id));
      this.editor()?.nativeElement.close();
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  private editorDirty(): boolean {
    const piece = this.editing;
    if (!piece) return false;
    return (
      this.form.title !== piece.title ||
      this.form.composer !== piece.composer ||
      this.form.favorite !== piece.favorite ||
      this.form.status !== piece.status ||
      this.form.sourceUrl !== piece.sourceUrl ||
      this.form.listeningUrl.trim() !== piece.listeningUrl ||
      this.form.notes !== piece.notes ||
      this.form.aliases !== piece.aliases ||
      this.form.opus !== (piece.opus ?? '') ||
      this.form.musicKey !== (piece.musicKey ?? '')
    );
  }

  private async persistEditor(): Promise<Piece | null> {
    this.form.listeningUrl = this.form.listeningUrl.trim();
    if (this.saving()) return null;
    if (!this.form.title.trim() || this.listeningUrlValidationError()) {
      this.error.set(this.listeningUrlValidationError() || 'Add a title first.');
      return null;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const piece = this.editing
        ? await firstValueFrom(this.api.updatePiece(this.editing.id, this.form))
        : await firstValueFrom(this.api.createPiece(this.form));
      this.editing = piece;
      return piece;
    } catch (error) {
      this.error.set(errorMessage(error));
      return null;
    } finally {
      this.saving.set(false);
    }
  }
}

function emptyPiece(): PieceForm {
  return {
    title: '',
    composer: '',
    favorite: false,
    status: 'playing',
    sourceUrl: '',
    listeningUrl: '',
    notes: '',
    aliases: '',
    opus: '',
    musicKey: '',
  };
}
