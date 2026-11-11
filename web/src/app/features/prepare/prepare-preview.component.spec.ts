import { describe, expect, it, vi } from 'vitest';
import { PreparePreviewComponent } from './prepare-preview.component';
import { PrepareStore } from './prepare.store';
import { createPrepareChild, draft } from './prepare-testing';

const withPage = (store: PrepareStore) => {
  store.draft.set({
    ...structuredClone(draft),
    manifest: { version: 1, pages: [{ id: 'page', sourceId: 'pdf', page: 0 }] },
  });
  store.preview.url.set('data:image/png;base64,');
};

describe('PreparePreviewComponent', () => {
  const button = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

  it('offers the first page when the draft has none', async () => {
    const { fixture, store } = await createPrepareChild(PreparePreviewComponent);
    const open = vi.fn();
    store.views.fileInputs = { open };
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.empty h2')?.textContent).toBe('Add your first page');
    button(root, 'Choose PDF or photos').click();
    expect(open).toHaveBeenCalledWith('add');
  });

  it('shows a loading note until the preview is ready, then the image', async () => {
    const { fixture, store } = await createPrepareChild(PreparePreviewComponent, (s) => {
      withPage(s);
      s.preview.url.set('');
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.empty')?.textContent).toContain('Loading page preview');
    expect(root.querySelector('img')).toBeNull();

    store.preview.url.set('data:image/png;base64,');
    fixture.detectChanges();
    expect(root.querySelector('img')?.getAttribute('alt')).toBe('Current score page preview');
    expect(store.views.surface?.nativeElement).toBe(root.querySelector('.page-surface'));
  });

  it('switches between the original and adjusted preview', async () => {
    const { fixture, store } = await createPrepareChild(PreparePreviewComponent, withPage);
    const render = vi.spyOn(store.preview, 'render').mockResolvedValue();
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Original').click();
    fixture.detectChanges();
    expect(store.preview.compare()).toBe(true);
    expect(button(root, 'Original').getAttribute('aria-pressed')).toBe('true');
    button(root, 'Adjusted').click();
    expect(store.preview.compare()).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('zooms within 50% to 200% in quarter steps', async () => {
    const { fixture, store } = await createPrepareChild(PreparePreviewComponent, withPage);
    const root = fixture.nativeElement as HTMLElement;
    const zoom = (label: string, times: number) => {
      for (let i = 0; i < times; i++) root.querySelector<HTMLButtonElement>(label)!.click();
      fixture.detectChanges();
    };
    zoom('button[aria-label="Zoom in"]', 6);
    expect(store.zoom()).toBe(2);
    expect(root.querySelector('.zoom span')?.textContent).toBe('200%');
    zoom('button[aria-label="Zoom out"]', 8);
    expect(store.zoom()).toBe(0.5);
    expect(root.querySelector<HTMLElement>('.page-surface')!.style.width).toBe('50%');
  });

  it('shows the edge editor and its hints only while editing edges', async () => {
    const { fixture, store } = await createPrepareChild(PreparePreviewComponent, withPage);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.edge-actions')).toBeNull();
    expect(root.classList.contains('editing-edges')).toBe(false);

    store.edges.handles.set('crop');
    store.edges.pending.set([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    store.edges.ready.set(true);
    fixture.detectChanges();
    expect(root.classList.contains('editing-edges')).toBe(true);
    expect(root.querySelector('app-prepare-edges')).not.toBeNull();
    expect(root.querySelector('.edge-actions')?.textContent).toContain('Drag the green corners');
    expect(button(root, 'Original').disabled).toBe(true);

    store.edges.resetRequired.set(true);
    fixture.detectChanges();
    const reset = button(root, 'Start edges from original');
    reset.click();
    expect(store.edges.resetRequired()).toBe(false);
  });
});
