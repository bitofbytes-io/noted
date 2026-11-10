import { describe, expect, it, vi } from 'vitest';
import { PrepareAdjustmentsComponent } from './prepare-adjustments.component';
import { PrepareStore } from './prepare.store';
import { createPrepareChild, draft, pdfSource, photo } from './prepare-testing';

const withPage =
  (source = photo) =>
  (store: PrepareStore) =>
    store.draft.set({
      ...structuredClone(draft),
      sources: [source],
      manifest: { version: 1, pages: [{ id: 'page', sourceId: source.id, page: 0 }] },
    });

describe('PrepareAdjustmentsComponent', () => {
  const button = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  const field = (root: HTMLElement, label: string) =>
    root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  it('renders nothing but the frame when the draft has no page', async () => {
    const { fixture } = await createPrepareChild(PrepareAdjustmentsComponent);
    expect(fixture.nativeElement.querySelector('h2')).toBeNull();
    expect(fixture.nativeElement.classList.contains('adjustments')).toBe(true);
  });

  it('offers Lighten paper for a photo page', async () => {
    const { fixture } = await createPrepareChild(PrepareAdjustmentsComponent, withPage(photo));
    expect(fixture.nativeElement.textContent).toContain('Lighten paper');
  });

  it('leaves Lighten paper out for a PDF page', async () => {
    const { fixture } = await createPrepareChild(PrepareAdjustmentsComponent, withPage(pdfSource));
    expect(fixture.nativeElement.textContent).not.toContain('Lighten paper');
    expect(fixture.nativeElement.querySelector('h2')?.textContent).toBe('Page 1');
  });

  it('straightens by angle and keeps a clamped value in the number field', async () => {
    const { fixture, store } = await createPrepareChild(PrepareAdjustmentsComponent, withPage());
    vi.spyOn(store.preview, 'schedule').mockImplementation(() => {});
    const root = fixture.nativeElement as HTMLElement;
    const angle = field(root, 'Angle in degrees');
    angle.value = '25';
    angle.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(store.page?.angle).toBe(10);
    expect(angle.value).toBe('10');
    expect(store.page?.fitEdges).toBe(true);
  });

  it('adds margins in millimetres and shows them back', async () => {
    const { fixture, store } = await createPrepareChild(PrepareAdjustmentsComponent, withPage());
    vi.spyOn(store.preview, 'schedule').mockImplementation(() => {});
    const root = fixture.nativeElement as HTMLElement;
    const top = field(root, 'Top margin in millimetres');
    top.value = '5';
    top.dispatchEvent(new Event('input'));
    expect(store.page?.margins?.[0]).toBeCloseTo((5 * 72) / 25.4);
    expect(store.edits.marginMM(0)).toBe(5);
  });

  it('rotates, replaces, removes, resets and undoes', async () => {
    const { fixture, store } = await createPrepareChild(PrepareAdjustmentsComponent, withPage());
    vi.spyOn(store.preview, 'schedule').mockImplementation(() => {});
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const open = vi.fn();
    store.views.fileInputs = { open };
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Rotate 90°').click();
    expect(store.page?.rotation).toBe(90);
    button(root, 'Undo').click();
    expect(store.page?.rotation).toBeUndefined();
    button(root, 'Replace page').click();
    expect(open).toHaveBeenCalledWith('replace');
    button(root, 'Reset page').click();
    button(root, 'Remove from this copy').click();
    expect(store.draft()!.manifest.pages).toHaveLength(0);
  });

  it('starts the edge editor and locks the page controls meanwhile', async () => {
    const { fixture, store } = await createPrepareChild(PrepareAdjustmentsComponent, withPage());
    vi.spyOn(store.preview, 'render').mockResolvedValue();
    const root = fixture.nativeElement as HTMLElement;
    button(root, 'Adjust page edges').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.edges.handles()).toBe('corners');
    expect(button(root, 'Rotate 90°').disabled).toBe(true);
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
  });
});
