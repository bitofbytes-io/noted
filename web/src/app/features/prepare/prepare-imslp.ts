import { Signal, WritableSignal, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ImportDraft, IMSLPWork } from '../../core/models';

/** Requests fire this long after the last keystroke, never per keystroke. */
const IMSLP_DEBOUNCE_MS = 350;
/** The per-user limit refills within a second (the API's Retry-After). */
const IMSLP_THROTTLE_RETRY_MS = 1000;
/** One quiet retry after "unavailable"; the API's breaker pauses for up to 60 s. */
const IMSLP_UNAVAILABLE_RETRY_MS = 30_000;
const IMSLP_CACHE_ENTRIES = 20;

export interface IMSLPAddedFile {
  filename: string;
  match: string;
}

/**
 * What the IMSLP panel needs from the Prepare page around it: the draft it links a
 * work into, the page's busy state and error line, and the shared upload path.
 */
export abstract class ImslpPanelHost {
  abstract readonly draft: WritableSignal<ImportDraft | null>;
  abstract readonly busy: Signal<boolean>;
  abstract readonly finalizing: Signal<boolean>;
  abstract readonly error: WritableSignal<string>;
  abstract readonly imslp: ImslpSearch;
  abstract readonly editingEdges: boolean;
  abstract mark(): void;
  abstract persist(): Promise<void>;
  abstract uploadFiles(files: File[]): Promise<void>;
  abstract applyIMSLP(): string | undefined;
}

/**
 * IMSLP panel state for one Prepare visit. It outlives the panel itself, so leaving
 * the panel or the Source step and coming back keeps the query, results and link.
 */
export class ImslpSearch {
  /** The pasted (or chosen) work link. */
  link = '';
  query = '';
  readonly results = signal<IMSLPWork[]>([]);
  readonly status = signal<'idle' | 'searching' | 'ready' | 'unavailable' | 'throttled'>('idle');
  /** True after Change: the search shows again while the chosen work link is kept. */
  readonly changing = signal(false);
  /** True once a work was opened on IMSLP in this visit, so the hand-off note shows. */
  readonly opened = signal(false);
  readonly dropHot = signal(false);
  readonly linkOpen = signal(false);
  /** True while the visible results belong to a query the user has since changed. */
  readonly stale = signal(false);
  /** PDFs added from the IMSLP panel in this visit; the draft stays on Source. */
  readonly added = signal<IMSLPAddedFile[]>([]);
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private search?: Subscription;
  private lastSent = '';
  private destroyed = false;
  private readonly cache = new Map<string, IMSLPWork[]>();

  /** `panelOpen` tells a delayed retry whether the panel is still showing. */
  constructor(
    private readonly api: ApiService,
    private readonly panelOpen: () => boolean,
  ) {}

  /** Each keystroke restarts the debounce; below two characters nothing is sent. */
  input() {
    clearTimeout(this.timer);
    if (this.query.trim().length < 2) {
      this.reset();
      return;
    }
    if (imslpQueryKey(this.query) !== this.lastSent) {
      // The visible results no longer answer the query in the field: no older
      // response may land, and nothing on screen may be opened until the next one.
      this.request++;
      this.search?.unsubscribe();
      this.search = undefined;
      this.lastSent = '';
      this.stale.set(true);
    }
    this.timer = setTimeout(() => this.find(), IMSLP_DEBOUNCE_MS);
  }

  /** Results on screen during a pending, running or throttled search are not selectable. */
  resultsStale(): boolean {
    return this.stale() || this.status() === 'searching' || this.status() === 'throttled';
  }

  enter(event: Event) {
    event.preventDefault();
    this.find(true);
  }

  /**
   * Enter (immediate) may repeat the last query; the debounce never does. A
   * retry runs without the searching state and never schedules another retry.
   */
  find(immediate = false, retry = false) {
    clearTimeout(this.timer);
    const query = this.query.trim();
    if (query.length < 2 || query.length > 100) {
      this.reset();
      return;
    }
    const key = imslpQueryKey(query);
    if (key === this.lastSent && !immediate) return;
    this.lastSent = key;
    const request = ++this.request;
    this.search?.unsubscribe();
    this.search = undefined;
    const cached = this.cache.get(key);
    if (cached) {
      this.remember(key, cached);
      this.status.set('ready');
      this.results.set(cached);
      this.stale.set(false);
      return;
    }
    if (!retry) this.status.set('searching');
    const unavailable = () => {
      this.lastSent = '';
      this.status.set('unavailable');
      this.results.set([]);
      this.stale.set(false);
      this.linkOpen.set(true);
      if (retry) return;
      this.timer = setTimeout(() => {
        if (this.query.trim() === query && this.panelOpen()) this.find(true, true);
      }, IMSLP_UNAVAILABLE_RETRY_MS);
    };
    this.search = this.api.searchIMSLP(query).subscribe({
      next: (result) => {
        if (request !== this.request || this.destroyed) return;
        if (result.status === 'ready') {
          this.remember(key, result.results);
          this.status.set('ready');
          this.results.set(result.results);
          this.stale.set(false);
        } else if (result.status === 'throttled') {
          // Earlier results stay (faded) and the same query is retried once the limit refills.
          this.lastSent = '';
          this.status.set('throttled');
          this.timer = setTimeout(() => this.find(true), IMSLP_THROTTLE_RETRY_MS);
        } else unavailable();
      },
      error: () => {
        if (request !== this.request || this.destroyed) return;
        unavailable();
      },
    });
  }

  statusText(): string {
    switch (this.status()) {
      case 'idle':
        return 'Type at least two characters.';
      case 'searching':
        return 'Searching IMSLP…';
      case 'throttled':
        return "You're searching quickly. Results will catch up in a moment.";
      case 'unavailable':
        return 'IMSLP is slow right now. Paste a work link or add a downloaded PDF, or press Enter to try again.';
      default:
        return this.results().length
          ? ''
          : 'No works match. Check the spelling, try the composer alone, or paste a work link.';
    }
  }

  /** Stops the pending debounce or retry and the in-flight request, e.g. on leaving the panel. */
  cancel() {
    clearTimeout(this.timer);
    this.request++;
    this.search?.unsubscribe();
    this.search = undefined;
    this.lastSent = '';
    this.stale.set(false);
    if (this.status() === 'searching' || this.status() === 'throttled')
      this.status.set(this.results().length ? 'ready' : 'idle');
  }

  destroy() {
    this.destroyed = true;
    this.cancel();
  }

  private reset() {
    this.cancel();
    this.status.set('idle');
    this.results.set([]);
  }

  private remember(key: string, works: IMSLPWork[]) {
    this.cache.delete(key);
    this.cache.set(key, works);
    if (this.cache.size > IMSLP_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}

export function isIMSLPWorkLink(url: string): boolean {
  return /^https:\/\/(www\.)?imslp\.org\/wiki\//.test(url);
}

/**
 * Validates a pasted work link, stores it on the draft and prefills the title and
 * composer it names. Throws when the link is not an IMSLP work page.
 */
export function linkIMSLPWork(d: ImportDraft, link: string): string {
  const url = new URL(link);
  if (
    url.protocol !== 'https:' ||
    !['imslp.org', 'www.imslp.org'].includes(url.host) ||
    !url.pathname.startsWith('/wiki/') ||
    url.username ||
    url.password
  )
    throw Error('Use an HTTPS work link from imslp.org/wiki/.');
  const metadata = d.metadata;
  const changedWork = metadata.sourceUrl !== url.href;
  metadata.sourceUrl = url.href;
  const { title, composer } = imslpWorkName(
    decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' '),
  );
  if (changedWork || (!metadata.title && d.imslpAutoFill?.title === undefined)) {
    prefillIMSLPField(d, 'title', title);
  }
  if (changedWork || (!metadata.composer && d.imslpAutoFill?.composer === undefined)) {
    prefillIMSLPField(d, 'composer', composer);
  }
  return url.href;
}

/** Fills a field from IMSLP unless the user owns it; an IMSLP-owned value is replaced. */
export function prefillIMSLPField(d: ImportDraft, field: 'title' | 'composer', value: string) {
  const provenance = (d.imslpAutoFill ??= {});
  const manuallyEdited = field === 'title' ? provenance.titleEdited : provenance.composerEdited;
  if (manuallyEdited) return;
  if (
    !d.metadata[field] ||
    (provenance[field] !== undefined && d.metadata[field] === provenance[field])
  ) {
    d.metadata[field] = value;
    provenance[field] = value;
  } else {
    delete provenance[field];
  }
}

/** The work whose link the draft holds, parsed the same way as a pasted link. */
export function chosenIMSLPWork(d: ImportDraft | null): IMSLPWork | null {
  const url = d?.metadata.sourceUrl ?? '';
  if (!isIMSLPWorkLink(url)) return null;
  let name = url.slice(url.indexOf('/wiki/') + 6);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw path segment when it is not valid percent-encoding.
  }
  return { ...imslpWorkName(name.replaceAll('_', ' ')), url };
}

/** The provenance line appears only for fields IMSLP filled and nobody edited since. */
export function imslpProvenance(d: ImportDraft | null): string {
  const title = !!d?.imslpAutoFill?.title && d.imslpAutoFill.title === d.metadata.title;
  const composer = !!d?.imslpAutoFill?.composer && d.imslpAutoFill.composer === d.metadata.composer;
  if (title && composer) return 'Title and composer filled from IMSLP';
  if (title) return 'Title filled from IMSLP';
  return composer ? 'Composer filled from IMSLP' : '';
}

/** IMSLP work pages are titled "Work title (Last, First)". */
function imslpWorkName(name: string): { title: string; composer: string } {
  return {
    title: name.replace(/\s*\([^)]*\)$/, ''),
    composer: name.match(/\(([^()]+, [^()]+)\)$/)?.[1] ?? '',
  };
}

/**
 * IMSLP names downloads "IMSLP<file number>-<composer>_-_<title>.pdf". The note is
 * informational only: a file number cannot be checked against a work without IMSLP.
 */
export function imslpFileMatch(filename: string, work: IMSLPWork | null): string {
  const number = filename.match(/^IMSLP(\d+)-/)?.[1];
  if (!number) return '';
  const fold = (text: string) =>
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const lastName = fold(work?.composer.split(',')[0] ?? '');
  return lastName && fold(filename).includes(lastName)
    ? `IMSLP file ${number}, by the chosen work's composer.`
    : `IMSLP file ${number}. Check it is an edition of the chosen work.`;
}

function imslpQueryKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}
