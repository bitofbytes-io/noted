import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LucideCheck, LucideChevronDown } from '@lucide/angular';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

let menus = 0;

/**
 * A quiet menu button for one choice among a few, used by the library's sort
 * and filter: the button names the current choice, and the open menu marks it
 * with a green check. It answers the keyboard like a native select.
 */
@Component({
  selector: 'app-choice-menu',
  imports: [LucideCheck, LucideChevronDown],
  templateUrl: './choice-menu.component.html',
  styleUrl: './choice-menu.component.scss',
  host: {
    '(document:click)': 'closeOutside($event)',
  },
})
export class ChoiceMenuComponent<T extends string> {
  readonly options = input.required<readonly Choice<T>[]>();
  readonly value = input.required<T>();
  /** What the menu chooses, such as "Sort"; the button reads "Sort: Title". */
  readonly name = input.required<string>();
  /** Without it, only assistive technology hears the name before the choice. */
  readonly showName = input(true);
  /** The open menu's accessible name, such as "Sort by"; the name by default. */
  readonly menuLabel = input('');
  readonly chosen = output<T>();

  protected readonly open = signal(false);
  protected readonly menuId = `choice-menu-${++menus}`;
  protected readonly current = computed(
    () => this.options().find((option) => option.value === this.value())?.label ?? '',
  );
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('button');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  protected toggle(): void {
    if (this.open()) this.close(false);
    else this.show();
  }

  /** Closes the menu, then reports the choice, even if it is the current one. */
  protected choose(value: T): void {
    this.close(true);
    this.chosen.emit(value);
  }

  /** Opens the menu with the current choice focused, as a menu button does. */
  private show(): void {
    this.open.set(true);
    afterNextRender(
      () =>
        this.items()
          .find((item) => item.getAttribute('aria-checked') === 'true')
          ?.focus(),
      { injector: this.injector },
    );
  }

  private close(refocus: boolean): void {
    if (!this.open()) return;
    this.open.set(false);
    if (refocus) this.button().nativeElement.focus();
  }

  protected closeOutside(event: Event): void {
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.close(false);
  }

  /** ArrowDown opens the menu from its button, like a native select. */
  protected buttonKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    this.show();
  }

  /** Arrows, Home and End move between choices; Escape and Tab close the menu. */
  protected menuKey(event: KeyboardEvent): void {
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(index + 1);
      case 'ArrowUp':
        return move(index - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(items.length - 1);
      case 'Escape':
        event.preventDefault();
        return this.close(true);
      case 'Tab':
        return this.close(false);
    }
  }

  private items(): HTMLButtonElement[] {
    return [...(this.menu()?.nativeElement.querySelectorAll('button') ?? [])];
  }
}
