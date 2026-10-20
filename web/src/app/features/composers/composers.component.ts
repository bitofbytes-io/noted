import { Component, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { ComposerEntry, ComposerPreview } from '../../core/models';
import { ComposerFieldComponent } from './composer-field.component';

@Component({
  selector: 'app-composers',
  imports: [RouterLink, ComposerFieldComponent],
  templateUrl: './composers.component.html',
  styleUrl: './composers.component.scss',
})
export class ComposersComponent {
  private readonly api = inject(ApiService);
  @ViewChild('mergeDialog') dialog?: ElementRef<HTMLDialogElement>;
  @ViewChild('previewHeading') previewHeading?: ElementRef<HTMLElement>;
  readonly entries = signal<ComposerEntry[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = signal(false);
  readonly mergeError = signal('');
  readonly selected = signal<string[]>([]);
  readonly target = signal('');
  readonly preview = signal<ComposerPreview | null>(null);
  readonly selectionEntries = computed(() => [
    ...this.entries(),
    ...this.selected()
      .filter((name) => !this.entries().some((entry) => entry.name === name))
      .map((name) => ({ name, count: 0 })),
  ]);
  readonly groups = computed(() => {
    const groups = new Map<string, ComposerEntry[]>();
    for (const entry of this.entries()) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    return Array.from(groups, ([key, entries]) => ({
      key,
      label: key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Composer unknown',
      entries,
    }));
  });
  constructor() {
    void this.load();
  }
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.entries.set(await firstValueFrom(this.api.composers()));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
  beginMerge(): void {
    this.selected.set([]);
    this.target.set('');
    this.preview.set(null);
    this.mergeError.set('');
    this.dialog?.nativeElement.showModal();
  }
  cancel(): void {
    if (!this.busy()) this.dialog?.nativeElement.close();
  }
  select(name: string, checked: boolean): void {
    this.selected.update((names) =>
      checked ? [...names, name] : names.filter((value) => value !== name),
    );
    this.preview.set(null);
  }
  editSelection(): void {
    this.preview.set(null);
  }
  async showPreview(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.mergeError.set('');
    try {
      this.preview.set(
        await firstValueFrom(
          this.api.previewComposerMerge({ spellings: this.selected(), target: this.target() }),
        ),
      );
      setTimeout(() => this.previewHeading?.nativeElement.focus());
    } catch (error) {
      this.mergeError.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  async merge(): Promise<void> {
    const preview = this.preview();
    if (!preview || this.busy()) return;
    this.busy.set(true);
    this.mergeError.set('');
    try {
      await firstValueFrom(
        this.api.mergeComposers({
          spellings: this.selected(),
          target: this.target(),
          fingerprint: preview.fingerprint,
        }),
      );
      this.dialog?.nativeElement.close();
      this.message.set(
        `Updated the composer on ${preview.count} ${preview.count === 1 ? 'piece' : 'pieces'}.`,
      );
      await this.load();
    } catch (error) {
      this.mergeError.set(errorMessage(error));
      if (error instanceof HttpErrorResponse && error.status === 409) {
        this.preview.set(null);
        await this.load();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
