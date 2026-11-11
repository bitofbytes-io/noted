import { describe, expect, it, vi } from 'vitest';
import { PrepareFileInputsComponent } from './prepare-file-inputs.component';
import { createPrepareChild } from './prepare-testing';

describe('PrepareFileInputsComponent', () => {
  const inputs = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>('input')];

  it('registers itself with the store and opens an input by kind', async () => {
    const { fixture, store } = await createPrepareChild(PrepareFileInputsComponent);
    const component = fixture.componentInstance;
    expect(store.views.fileInputs).toBe(component);
    for (const kind of ['pdf', 'photos', 'camera', 'add', 'replace'] as const) {
      const click = vi.spyOn(component[kind]!.nativeElement, 'click');
      store.views.fileInputs!.open(kind);
      expect(click).toHaveBeenCalledOnce();
    }
  });

  it('accepts the right files on each input and only one file when replacing a page', async () => {
    const { fixture } = await createPrepareChild(PrepareFileInputsComponent);
    const [pdf, photos, camera, add, replace] = inputs(fixture.nativeElement);
    expect(pdf.accept).toBe('application/pdf');
    expect(photos.accept).toBe('image/jpeg,image/png');
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(add.multiple).toBe(true);
    expect(replace.multiple).toBe(false);
  });

  it('sends chosen files to the upload path and locks every input while busy', async () => {
    const { fixture, store } = await createPrepareChild(PrepareFileInputsComponent);
    const upload = vi.spyOn(store.transfer, 'upload').mockResolvedValue();
    const [pdf, , , , replace] = inputs(fixture.nativeElement);
    pdf.dispatchEvent(new Event('change'));
    expect(upload).toHaveBeenLastCalledWith(expect.any(Event));
    replace.dispatchEvent(new Event('change'));
    expect(upload).toHaveBeenLastCalledWith(expect.any(Event), true);

    store.busy.set(true);
    fixture.detectChanges();
    expect(inputs(fixture.nativeElement).every((input) => input.disabled)).toBe(true);
  });
});
