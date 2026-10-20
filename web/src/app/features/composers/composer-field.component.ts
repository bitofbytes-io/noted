import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ComposerEntry } from '../../core/models';
import { fold } from '../../core/search';

@Component({
  selector: 'app-composer-field',
  template: `
    <label class="field">
      <span>{{ label() }}</span>
      <input
        name="composer"
        maxlength="300"
        autocomplete="off"
        role="combobox"
        [id]="inputId()"
        [value]="value()"
        [disabled]="disabled()"
        aria-autocomplete="list"
        [attr.aria-expanded]="open() && matches().length > 0"
        [attr.aria-controls]="inputId() + '-options'"
        [attr.aria-activedescendant]="
          open() && active() >= 0 ? inputId() + '-option-' + active() : null
        "
        (focus)="focus()"
        (input)="type($any($event.target).value)"
        (keydown)="key($event)"
        (blur)="open.set(false)"
      />
    </label>
    @if (open() && matches().length) {
      <ul
        #options
        role="listbox"
        [id]="inputId() + '-options'"
        [attr.aria-label]="label() + ' suggestions'"
      >
        @for (entry of matches(); track entry.name; let i = $index) {
          <li role="presentation">
            <button
              type="button"
              role="option"
              tabindex="-1"
              [id]="inputId() + '-option-' + i"
              [attr.aria-selected]="active() === i"
              (mousedown)="$event.preventDefault()"
              (click)="choose(entry.name)"
            >
              {{ entry.name }}
              <small>{{ entry.count }} {{ entry.count === 1 ? 'piece' : 'pieces' }}</small>
            </button>
          </li>
        }
      </ul>
    }
    @if (unavailable()) {
      <small class="field-help">Suggestions unavailable. You can still type any composer.</small>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      margin-bottom: 18px;
    }
    .field {
      margin-bottom: 0;
    }
    ul {
      list-style: none;
      margin: 4px 0 0;
      padding: 4px;
      border: 1px solid var(--line-strong);
      background: var(--paper-raised);
      max-height: 240px;
      overflow: auto;
    }
    button {
      display: block;
      width: 100%;
      min-height: 44px;
      padding: 8px 12px;
      text-align: left;
      border: 0;
      background: transparent;
      overflow-wrap: anywhere;
    }
    button[aria-selected='true'],
    button:hover {
      background: var(--green-soft);
    }
    small {
      color: var(--ink-muted);
    }
  `,
})
export class ComposerFieldComponent {
  private readonly api = inject(ApiService);
  private readonly options = viewChild<ElementRef<HTMLUListElement>>('options');
  readonly value = input('');
  readonly label = input('Composer');
  readonly inputId = input('composer');
  readonly disabled = input(false);
  readonly valueChange = output<string>();
  readonly entries = signal<ComposerEntry[]>([]);
  readonly open = signal(false);
  readonly active = signal(-1);
  readonly unavailable = signal(false);
  readonly matches = computed(() => {
    const query = fold(this.value().trim());
    return this.entries()
      .filter((entry) => entry.name && (!query || fold(entry.name).includes(query)))
      .slice(0, 8);
  });
  constructor() {
    afterRenderEffect(() => {
      const list = this.options()?.nativeElement;
      const option = list?.querySelectorAll<HTMLElement>('[role="option"]')[this.active()];
      if (!list || !option) return;
      // Move only the suggestions viewport, never the page or surrounding dialog.
      const top = list.getBoundingClientRect().top + list.clientTop;
      const bottom = top + list.clientHeight;
      const bounds = option.getBoundingClientRect();
      if (bounds.top < top) list.scrollTop += bounds.top - top;
      else if (bounds.bottom > bottom) list.scrollTop += bounds.bottom - bottom;
    });
  }
  async focus(): Promise<void> {
    this.open.set(true);
    this.active.set(-1);
    try {
      this.entries.set(await firstValueFrom(this.api.composers()));
      this.active.set(-1);
      this.unavailable.set(false);
    } catch {
      this.unavailable.set(true);
    }
  }
  type(value: string): void {
    this.valueChange.emit(value);
    this.open.set(true);
    this.active.set(-1);
  }
  choose(name: string): void {
    this.valueChange.emit(name);
    this.open.set(false);
    this.active.set(-1);
  }
  key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open()) {
      event.preventDefault();
      event.stopPropagation();
      this.open.set(false);
      return;
    }
    const matches = this.matches();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
      event.preventDefault();
      this.open.set(true);
      this.active.set(
        this.active() < 0
          ? event.key === 'ArrowDown'
            ? 0
            : matches.length - 1
          : (this.active() + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length,
      );
    } else if (event.key === 'Enter' && this.open() && this.active() >= 0) {
      event.preventDefault();
      const selected = matches[this.active()];
      if (selected) this.choose(selected.name);
    }
  }
}
