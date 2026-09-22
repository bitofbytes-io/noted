import { Component, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

type Variant = 'current' | 'inline' | 'focused';

interface WorkResult {
  title: string;
  composer: string;
  catalogue: string;
  url: string;
}

@Component({
  selector: 'app-imslp-search-prototype',
  imports: [FormsModule],
  templateUrl: './imslp-search.prototype.html',
  styleUrl: './imslp-search.prototype.scss',
})
export class ImslpSearchPrototype {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly variants: { id: Variant; name: string }[] = [
    { id: 'current', name: 'Current app' },
    { id: 'inline', name: 'Search in the source card' },
    { id: 'focused', name: 'Focused IMSLP step' },
  ];
  readonly variant = signal<Variant>('current');
  readonly selected = signal<WorkResult | null>(null);
  readonly searched = signal(true);
  readonly pdfChosen = signal(false);
  title = 'Moonlight Sonata';
  composer = 'Beethoven';
  workLink = '';
  readonly results: WorkResult[] = [
    {
      title: 'Piano Sonata No.14, Op.27 No.2',
      composer: 'Beethoven, Ludwig van',
      catalogue: 'Op. 27 No. 2',
      url: 'https://imslp.org/wiki/Piano_Sonata_No.14%2C_Op.27_No.2_(Beethoven%2C_Ludwig_van)',
    },
    {
      title: 'Piano Sonata No.8, Op.13',
      composer: 'Beethoven, Ludwig van',
      catalogue: 'Op. 13',
      url: 'https://imslp.org/wiki/Piano_Sonata_No.8%2C_Op.13_(Beethoven%2C_Ludwig_van)',
    },
    {
      title: 'Piano Sonata No.21, Op.53',
      composer: 'Beethoven, Ludwig van',
      catalogue: 'Op. 53',
      url: 'https://imslp.org/wiki/Piano_Sonata_No.21%2C_Op.53_(Beethoven%2C_Ludwig_van)',
    },
  ];

  constructor() {
    const requested = this.route.snapshot.queryParamMap.get('variant') as Variant | null;
    if (this.variants.some(({ id }) => id === requested)) this.variant.set(requested!);
  }

  search(): void {
    this.selected.set(null);
    this.searched.set(true);
  }

  choose(result: WorkResult): void {
    this.selected.set(result);
    this.workLink = result.url;
  }

  choosePdf(): void {
    this.pdfChosen.set(true);
  }

  get variantCode(): string {
    return ['A', 'B', 'C'][this.variants.findIndex(({ id }) => id === this.variant())];
  }

  get variantName(): string {
    return this.variants.find(({ id }) => id === this.variant())!.name;
  }

  cycle(direction: -1 | 1): void {
    const index = this.variants.findIndex(({ id }) => id === this.variant());
    const next = this.variants[(index + direction + this.variants.length) % this.variants.length];
    this.variant.set(next.id);
    this.selected.set(null);
    this.pdfChosen.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { variant: next.id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    this.cycle(event.key === 'ArrowLeft' ? -1 : 1);
  }
}
