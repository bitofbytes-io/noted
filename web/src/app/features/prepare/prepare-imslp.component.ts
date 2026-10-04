import {
  Component,
  ElementRef,
  Injector,
  ViewChild,
  afterNextRender,
  inject,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideExternalLink } from '@lucide/angular';
import { errorMessage } from '../../core/api.service';
import { IMSLPWork } from '../../core/models';
import {
  ImslpPanelHost,
  chosenIMSLPWork,
  imslpProvenance,
  prefillIMSLPField,
} from './prepare-imslp';

/**
 * The IMSLP source panel: live work search, the chosen work, and the drop target
 * for the PDF downloaded from IMSLP. Its search state lives in the host's
 * `ImslpSearch`, so it survives the panel closing.
 */
@Component({
  selector: 'article[appPrepareImslp]',
  imports: [FormsModule, LucideExternalLink],
  templateUrl: './prepare-imslp.component.html',
  styleUrl: './prepare-imslp.component.scss',
  host: {
    '[class.drop-hot]': 'imslp.dropHot()',
    '(dragover)': 'dragOver($event)',
    '(dragleave)': 'dragLeave($event)',
    '(drop)': 'drop($event)',
  },
})
export class PrepareImslpComponent {
  protected readonly host = inject(ImslpPanelHost);
  private readonly injector = inject(Injector);
  readonly imslp = this.host.imslp;
  /** Add downloaded PDF opens the page's shared PDF file input. */
  readonly addPdf = output<void>();
  @ViewChild('imslpSearchInput') imslpSearchInput?: ElementRef<HTMLInputElement>;

  /** The work whose link the draft holds, parsed the same way as a pasted link. */
  get chosenWork(): IMSLPWork | null {
    return chosenIMSLPWork(this.host.draft());
  }

  /** The provenance line appears only for fields IMSLP filled and nobody edited since. */
  get provenance(): string {
    return imslpProvenance(this.host.draft());
  }

  /** One tap stores the link, prefills details and opens the work on IMSLP. */
  async selectWork(work: IMSLPWork) {
    const host = this.host;
    if (
      !host.draft() ||
      host.busy() ||
      host.finalizing() ||
      this.imslp.resultsStale() ||
      !this.imslp.results().includes(work)
    )
      return;
    this.imslp.link = work.url;
    const d = host.draft()!;
    d.metadata.sourceUrl = work.url;
    prefillIMSLPField(d, 'title', work.title);
    prefillIMSLPField(d, 'composer', work.composer);
    host.draft.update((current) =>
      current
        ? {
            ...current,
            metadata: { ...current.metadata },
            imslpAutoFill: { ...current.imslpAutoFill },
          }
        : null,
    );
    host.mark();
    this.imslp.changing.set(false);
    this.imslp.opened.set(true);
    // Still inside the click handler, so iPad Safari treats it as a user gesture.
    window.open(work.url, '_blank', 'noopener,noreferrer');
    try {
      await host.persist();
    } catch (e) {
      host.error.set(errorMessage(e));
    }
  }

  changeWork() {
    this.imslp.changing.set(true);
    afterNextRender(() => this.imslpSearchInput?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  async openLink() {
    try {
      const url = this.host.applyIMSLP();
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        this.imslp.changing.set(false);
        this.imslp.opened.set(true);
      }
      await this.host.persist();
    } catch (e) {
      this.host.error.set(errorMessage(e));
    }
  }

  dragOver(event: DragEvent) {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.host.busy() ? 'none' : 'copy';
    this.imslp.dropHot.set(!this.host.busy());
  }

  dragLeave(event: DragEvent) {
    const panel = event.currentTarget as HTMLElement | null;
    if (event.relatedTarget instanceof Node && panel?.contains(event.relatedTarget)) return;
    this.imslp.dropHot.set(false);
  }

  async drop(event: DragEvent) {
    event.preventDefault();
    this.imslp.dropHot.set(false);
    if (this.host.busy()) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const pdfs = files.filter(
      (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name),
    );
    await this.host.uploadFiles(pdfs);
    // uploadFiles clears earlier errors, so the skipped-file note is added afterwards.
    if (pdfs.length < files.length) {
      const warning = 'Only PDF files can be dropped here.';
      const error = this.host.error;
      error.set(error() ? `${error()} ${warning}` : warning);
    }
  }
}
