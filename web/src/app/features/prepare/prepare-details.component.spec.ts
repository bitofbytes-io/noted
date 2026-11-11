import { describe, expect, it, vi } from 'vitest';
import { PrepareDetailsComponent } from './prepare-details.component';
import { createPrepareChild } from './prepare-testing';

describe('PrepareDetailsComponent', () => {
  const input = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('label')]
      .find((l) => l.querySelector('span')?.textContent === label)!
      .querySelector('input, textarea') as HTMLInputElement;

  it('fills the form from the draft metadata', async () => {
    const { fixture } = await createPrepareChild(PrepareDetailsComponent);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(input(root, 'Title').value).toBe('Draft score');
    expect(input(root, 'Title').required).toBe(true);
    expect(input(root, 'Composer').value).toBe('');
    expect(input(root, 'Add to favorites').checked).toBe(false);
  });

  it('writes each field to the draft metadata and marks it for saving', async () => {
    const { fixture, store } = await createPrepareChild(PrepareDetailsComponent);
    const root = fixture.nativeElement as HTMLElement;
    const type = (label: string, value: string) => {
      const field = input(root, label);
      field.value = value;
      field.dispatchEvent(new Event('input'));
    };
    type('Title', 'Nocturne');
    type('Composer', 'Chopin');
    type('Source link', 'https://example.test/score');
    type('Listening URL', 'https://example.test/listen');
    type('Edition / notes', 'Henle');
    input(root, 'Add to favorites').click();
    expect(store.draft()?.metadata).toEqual({
      title: 'Nocturne',
      composer: 'Chopin',
      sourceUrl: 'https://example.test/score',
      listeningUrl: 'https://example.test/listen',
      notes: 'Henle',
      favorite: true,
    });
    expect(store.saved()).toBe('Unsaved changes');
  });

  it('shows the first three page thumbnails and returns to Pages for review', async () => {
    const { fixture, store } = await createPrepareChild(PrepareDetailsComponent, (s) => {
      s.draft.update((d) => ({
        ...d!,
        manifest: {
          version: 1,
          pages: ['a', 'b', 'c', 'd'].map((id) => ({ id, sourceId: 'pdf', page: 0 })),
        },
      }));
      s.step.set('details');
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.review-stack img')).toHaveLength(3);
    vi.spyOn(store, 'renderThumbnails').mockResolvedValue();
    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Review pages')!
      .click();
    expect(store.step()).toBe('pages');
  });

  it('locks the form while the draft is busy', async () => {
    const { fixture, store } = await createPrepareChild(PrepareDetailsComponent);
    store.busy.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const controls = [...fixture.nativeElement.querySelectorAll('input, textarea, button')];
    expect(controls.every((control) => (control as HTMLInputElement).disabled)).toBe(true);
  });
});
