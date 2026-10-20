import { Component, Input, OnChanges, OnDestroy, inject, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, catchError, map, of, switchMap, timer } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { LibraryFilter, PieceSummary } from '../../core/models';
import { searchTerms } from '../../core/search';

@Component({
  selector: 'app-search-suggestions',
  template: `
    @if (results().length) {
      <section aria-label="Similar matches" class="suggestions">
        <h2>Similar matches</h2>
        <p>Did you mean one of these pieces? Your search stays unchanged.</p>
        @for (piece of results(); track piece.id) {
          <button
            type="button"
            class="suggestion"
            (click)="openPiece.emit(piece)"
            [attr.aria-label]="
              'Open ' + piece.title + ' by ' + (piece.composer || 'unknown composer')
            "
          >
            <strong>{{ piece.title }}</strong>
            <span
              >{{ piece.composer || 'Composer unknown'
              }}{{ piece.pdf ? '' : ' — No PDF yet' }}</span
            >
          </button>
        }
      </section>
    }
    @if (message()) {
      <p class="suggestion-message" role="status">{{ message() }}</p>
    }
  `,
  styles: `
    .suggestions {
      margin-top: 32px;
      border-top: 1px solid var(--line-strong);
      padding-top: 24px;
    }
    h2 {
      font-size: 24px;
      margin: 0 0 8px;
      font-weight: 600;
    }
    p {
      color: var(--ink-muted);
      margin: 0 0 16px;
    }
    .suggestion {
      display: block;
      width: 100%;
      min-height: 72px;
      padding: 16px 0;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .suggestion:hover,
    .suggestion:focus-visible {
      background: var(--green-soft);
    }
    strong {
      display: block;
      font-size: 19px;
      font-weight: 600;
    }
    span {
      display: block;
      color: var(--ink-muted);
      margin-top: 4px;
    }
    .suggestion-message {
      margin-top: 24px;
    }
  `,
})
export class SuggestionsComponent implements OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  @Input() query = '';
  @Input() filter: LibraryFilter = 'current';
  @Input() owner = '';
  @Input() enabled = false;
  @Input() exact: PieceSummary[] = [];
  readonly openPiece = output<PieceSummary>();
  readonly results = signal<PieceSummary[]>([]);
  readonly message = signal('');
  private readonly requests = new Subject<{
    query: string;
    filter: LibraryFilter;
    eligible: boolean;
    exact: Set<string>;
  }>();
  private readonly subscription = this.requests
    .pipe(
      switchMap((request) =>
        request.eligible
          ? timer(250).pipe(
              switchMap(() => this.api.suggestPieces(request.query, request.filter)),
              map((pieces) => ({
                pieces: pieces.filter((piece) => !request.exact.has(piece.id)),
                error: '',
              })),
              catchError((error: unknown) =>
                of({
                  pieces: [] as PieceSummary[],
                  error:
                    error instanceof HttpErrorResponse && error.status === 429
                      ? 'Similar matches are busy. Try again shortly.'
                      : 'Similar matches unavailable. Your library results are still available.',
                }),
              ),
            )
          : of({ pieces: [] as PieceSummary[], error: '' }),
      ),
    )
    .subscribe((result) => {
      this.results.set(result.pieces);
      this.message.set(result.error);
    });
  ngOnChanges(): void {
    // Reset synchronously on query, filter, session or exact-result changes;
    // switchMap also cancels the debounce and any previous HTTP subscription.
    this.results.set([]);
    this.message.set('');
    const terms = searchTerms(this.query);
    const eligible =
      this.enabled &&
      !!this.owner &&
      new TextEncoder().encode(this.query).length <= 200 &&
      terms.length <= 8 &&
      terms.some((term) => /^\p{L}{4,}$/u.test(term));
    this.requests.next({
      query: this.query,
      filter: this.filter,
      eligible,
      exact: new Set(this.exact.map((piece) => piece.id)),
    });
  }
  ngOnDestroy(): void {
    this.subscription.unsubscribe();
    this.requests.complete();
  }
}
