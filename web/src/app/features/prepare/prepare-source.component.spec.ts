import { describe, expect, it, vi } from 'vitest';
import { PrepareSourceComponent } from './prepare-source.component';
import { createPrepareChild } from './prepare-testing';
import { MAX_PREPARED_PAGES } from '../../core/models';

describe('PrepareSourceComponent', () => {
  const button = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

  it('shows every source option and the upload limits', async () => {
    const { fixture } = await createPrepareChild(PrepareSourceComponent);
    const root = fixture.nativeElement as HTMLElement;
    expect([...root.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Upload a PDF',
      'From your books',
      'Find a score on IMSLP',
    ]);
    expect(root.querySelector('.limits')?.textContent).toContain('Files up to 50 MiB');
    expect(root.querySelector('.limits')?.textContent).toContain(`${MAX_PREPARED_PAGES} prepared`);
    expect(button(root, 'Choose a different source')).toBeUndefined();
  });

  it('asks the file inputs to open the chosen kind', async () => {
    const { fixture, store } = await createPrepareChild(PrepareSourceComponent);
    const open = vi.fn();
    store.views.fileInputs = { open };
    const root = fixture.nativeElement as HTMLElement;
    for (const [label, kind] of [
      ['Choose PDF', 'pdf'],
      ['Take a photo', 'camera'],
      ['Choose photos', 'photos'],
    ] as const) {
      button(root, label)!.click();
      expect(open).toHaveBeenLastCalledWith(kind);
    }
  });

  it('focuses one source and returns to the full list', async () => {
    const { fixture, store } = await createPrepareChild(PrepareSourceComponent);
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Find a score on IMSLP')!.click();
    fixture.detectChanges();
    expect(store.sourceMode()).toBe('imslp');
    expect(root.querySelector('.source-options.focused')).not.toBeNull();
    expect(root.querySelector('article.imslp')).not.toBeNull();
    expect(root.querySelector('.imslp-entry')).toBeNull();

    button(root, 'Choose a different source')!.click();
    fixture.detectChanges();
    expect(store.sourceMode()).toBe('all');
    expect(root.querySelector('article.imslp')).toBeNull();
  });

  it('hides the other options while one source is in focus', async () => {
    const { fixture } = await createPrepareChild(PrepareSourceComponent, (store) =>
      store.sourceMode.set('photos'),
    );
    const articles = [...fixture.nativeElement.querySelectorAll('article')] as HTMLElement[];
    expect(articles.map((article) => article.hidden)).toEqual([true, false]);
  });

  it('locks its buttons while busy', async () => {
    const { fixture, store } = await createPrepareChild(PrepareSourceComponent);
    store.busy.set(true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(button(root, 'Choose PDF')!.disabled).toBe(true);
    expect(button(root, 'Add details without a PDF')!.disabled).toBe(true);
  });
});
