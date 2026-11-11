import { describe, expect, it, vi } from 'vitest';
import { PreparePageListComponent } from './prepare-page-list.component';
import { PrepareStore } from './prepare.store';
import { createPrepareChild, draft, photo } from './prepare-testing';

const threePages = (store: PrepareStore) =>
  store.draft.set({
    ...structuredClone(draft),
    sources: [photo],
    manifest: {
      version: 1,
      pages: [
        { id: 'a', sourceId: photo.id, page: 0 },
        { id: 'b', sourceId: photo.id, page: 0, rotation: 90 },
        { id: 'c', sourceId: photo.id, page: 0 },
      ],
    },
  });

describe('PreparePageListComponent', () => {
  const button = (root: HTMLElement, label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const labelled = (root: HTMLElement, text: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

  it('lists each page, marks adjusted ones and registers the rail for thumbnails', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.thumbnail')).toHaveLength(3);
    expect(root.querySelectorAll('.adjusted-marker')).toHaveLength(1);
    expect(button(root, 'Preview page 2, adjusted')).toBeTruthy();
    expect(store.views.thumbRail?.nativeElement).toBe(root.querySelector('.thumbs'));
    expect(root.classList.contains('page-rail')).toBe(true);
  });

  it('previews the chosen page and tracks checked pages', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Preview page 3').click();
    fixture.detectChanges();
    expect(store.selected()).toBe(2);
    expect(root.querySelector('.thumbnail.active')?.getAttribute('data-thumbnail-id')).toBe('c');

    root.querySelector<HTMLInputElement>('input[aria-label="Select page 2"]')!.click();
    expect([...store.selectedIDs()]).toEqual(['b']);
    fixture.detectChanges();
    expect(labelled(root, 'Keep selected only').disabled).toBe(false);
  });

  it('moves the selected page and disables the move buttons at the ends', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const root = fixture.nativeElement as HTMLElement;
    expect(button(root, 'Move page earlier').disabled).toBe(true);
    button(root, 'Move page later').click();
    fixture.detectChanges();
    expect(store.draft()!.manifest.pages.map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(store.selected()).toBe(1);
    store.selected.set(2);
    fixture.detectChanges();
    expect(button(root, 'Move page later').disabled).toBe(true);
  });

  it('keeps only the checked pages', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const root = fixture.nativeElement as HTMLElement;
    expect(labelled(root, 'Keep selected only').disabled).toBe(true);
    store.selectedIDs.set(new Set(['a', 'c']));
    fixture.detectChanges();
    labelled(root, 'Keep selected only').click();
    expect(store.draft()!.manifest.pages.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('applies a source range and asks for more pages', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const open = vi.fn();
    store.views.fileInputs = { open };
    const root = fixture.nativeElement as HTMLElement;
    store.rangeSourceId = photo.id;
    store.rangeText = '1';
    labelled(root, 'Use this range only').click();
    expect(store.draft()!.manifest.pages).toHaveLength(1);
    labelled(root, 'Add pages').click();
    expect(open).toHaveBeenCalledWith('add');
  });

  it('locks every control while the edge editor is open', async () => {
    const { fixture, store } = await createPrepareChild(PreparePageListComponent, threePages);
    store.edges.handles.set('crop');
    fixture.detectChanges();
    // ngModel applies [disabled] after a microtask.
    await fixture.whenStable();
    fixture.detectChanges();
    const controls = [...fixture.nativeElement.querySelectorAll('button, input, select')];
    expect(controls.length).toBeGreaterThan(5);
    expect(controls.every((control) => (control as HTMLButtonElement).disabled)).toBe(true);
  });
});
