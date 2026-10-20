import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import { ComposerEntry, ComposerPreview } from '../../core/models';
import { ComposersComponent } from './composers.component';
import { ComposerFieldComponent } from './composer-field.component';

const entries: ComposerEntry[] = [
  {
    name: 'Chopin',
    key: 'chopin',
    group: 'chopin',
    count: 1,
    pieces: [{ id: 'one', title: 'Prelude', composer: 'Chopin', hasPdf: true }],
  },
  {
    name: 'Chopin, Frédéric',
    key: 'chopin frederic',
    group: 'chopin',
    count: 1,
    pieces: [{ id: 'two', title: 'Nocturne', composer: 'Chopin, Frédéric', hasPdf: false }],
  },
  { name: 'C. P. E. Bach', key: 'bach c p e', group: 'bach', count: 1, pieces: [] },
  { name: 'J. S. Bach', key: 'bach j s', group: 'bach', count: 1, pieces: [] },
];
const preview: ComposerPreview = {
  fingerprint: 'current-selection',
  count: 2,
  pieces: entries.slice(0, 2).flatMap((entry) => entry.pieces),
};
async function setup() {
  const api = {
    composers: vi.fn(() => of(structuredClone(entries))),
    previewComposerMerge: vi.fn(() => of(preview)),
    mergeComposers: vi.fn(() => of(preview)),
  };
  await TestBed.configureTestingModule({
    imports: [ComposersComponent],
    providers: [provideRouter([]), { provide: ApiService, useValue: api }],
  }).compileComponents();
  const fixture = TestBed.createComponent(ComposersComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
  dialog.showModal = vi.fn();
  dialog.close = vi.fn();
  return { fixture, component: fixture.componentInstance, api, dialog };
}

describe('Composer browse and explicit merge', () => {
  it('keeps same-surname spellings distinct and starts with nothing selected', async () => {
    const { fixture, component, api, dialog } = await setup();
    const bach = fixture.nativeElement.querySelector('section[aria-label="Bach"]');
    expect(bach.querySelectorAll('details')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('a[href="/reader/one"]')).not.toBeNull();
    component.beginMerge();
    fixture.detectChanges();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.querySelectorAll('input:checked')).toHaveLength(0);
    component.select('Chopin', true);
    component.target.set('Frédéric Chopin');
    component.cancel();
    expect(api.mergeComposers).not.toHaveBeenCalled();
    expect(api.previewComposerMerge).not.toHaveBeenCalled();
    expect(dialog.close).toHaveBeenCalledOnce();
    fixture.destroy();
  });
  it('requires a preview and confirms the exact count and fingerprint before applying', async () => {
    const { fixture, component, api, dialog } = await setup();
    component.beginMerge();
    component.select('Chopin', true);
    component.select('Chopin, Frédéric', true);
    component.target.set('Frédéric Chopin');
    await component.merge();
    expect(api.mergeComposers).not.toHaveBeenCalled();
    await component.showPreview();
    fixture.detectChanges();
    expect(dialog.textContent).toContain('Merge 2 pieces');
    expect(dialog.textContent).toContain('Prelude');
    expect(dialog.textContent).toContain('Nocturne');
    await component.merge();
    fixture.detectChanges();
    expect(api.mergeComposers).toHaveBeenCalledWith({
      spellings: ['Chopin', 'Chopin, Frédéric'],
      target: 'Frédéric Chopin',
      fingerprint: preview.fingerprint,
    });
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(api.composers).toHaveBeenCalledTimes(2);
    expect(component.message()).toContain('2 pieces');
    fixture.destroy();
  });
  it('retains failed selections and forces a new preview after conflict, including removed spellings', async () => {
    const { fixture, component, api, dialog } = await setup();
    component.beginMerge();
    component.select('Chopin', true);
    component.target.set('Frédéric Chopin');
    await component.showPreview();
    api.mergeComposers.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 500, error: { error: 'Merge failed' } })),
    );
    await component.merge();
    expect(component.preview()).not.toBeNull();
    expect(dialog.close).not.toHaveBeenCalled();
    api.mergeComposers.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({ status: 409, error: { error: 'Composer selection changed' } }),
      ),
    );
    api.composers.mockReturnValueOnce(of(entries.filter((entry) => entry.name !== 'Chopin')));
    await component.merge();
    fixture.detectChanges();
    expect(component.preview()).toBeNull();
    expect(component.selected()).toEqual(['Chopin']);
    expect(component.target()).toBe('Frédéric Chopin');
    expect(dialog.close).not.toHaveBeenCalled();
    const stale = Array.from(dialog.querySelectorAll('label.spelling')).find((label) =>
      label.textContent?.includes('Chopin 0'),
    );
    expect(stale).toBeDefined();
    component.select('Chopin', false);
    component.select('Chopin, Frédéric', true);
    await component.showPreview();
    expect(api.previewComposerMerge).toHaveBeenLastCalledWith({
      spellings: ['Chopin, Frédéric'],
      target: 'Frédéric Chopin',
    });
    fixture.destroy();
  });
});

describe('Composer autocomplete', () => {
  it('keeps all eight keyboard options visible by scrolling only the suggestions viewport', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...entries[0], name: `Composer ${i}` }));
    await TestBed.configureTestingModule({
      imports: [ComposerFieldComponent],
      providers: [{ provide: ApiService, useValue: { composers: () => of(eight) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ComposerFieldComponent);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    await fixture.whenStable();
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('[role="listbox"]') as HTMLUListElement;
    const options = list.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(8);
    Object.defineProperty(list, 'clientHeight', { value: 240 });
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    options.forEach((option, i) => {
      vi.spyOn(option, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            top: 100 + i * 44 - list.scrollTop,
            bottom: 100 + (i + 1) * 44 - list.scrollTop,
          }) as DOMRect,
      );
    });
    const pageScroll = window.scrollY;
    const press = async (key: string) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      fixture.detectChanges();
      await fixture.whenStable();
    };
    await press('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-7');
    expect(list.scrollTop).toBe(112);
    await press('ArrowUp');
    expect(list.scrollTop).toBe(112); // Already visible: no unnecessary movement.
    await press('ArrowDown');
    await press('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-0');
    expect(list.scrollTop).toBe(0);
    expect(window.scrollY).toBe(pageScroll);
    fixture.destroy();
  });
  it.each(['empty', 'no match', 'error', 'populated'])(
    'only consumes Escape when the popup is visible: %s',
    async (state) => {
      const api = {
        composers: () =>
          state === 'error'
            ? throwError(() => new Error('offline'))
            : of(state === 'empty' ? [] : entries),
      };
      await TestBed.configureTestingModule({
        imports: [ComposerFieldComponent],
        providers: [{ provide: ApiService, useValue: api }],
      }).compileComponents();
      const fixture = TestBed.createComponent(ComposerFieldComponent);
      fixture.componentRef.setInput('value', state === 'no match' ? 'Unmatched composer' : '');
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
      input.dispatchEvent(new Event('focus'));
      await fixture.whenStable();
      fixture.detectChanges();
      const bubbled = vi.fn();
      fixture.nativeElement.addEventListener('keydown', bubbled);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(escape);
      fixture.detectChanges();
      expect(escape.defaultPrevented).toBe(state === 'populated');
      expect(bubbled).toHaveBeenCalledTimes(state === 'populated' ? 0 : 1);
      expect(fixture.nativeElement.querySelector('[role="listbox"]')).toBeNull();
      fixture.destroy();
    },
  );
  it('supports keyboard selection and keeps free text on lookup failure', async () => {
    const api = { composers: vi.fn(() => of(entries)) };
    await TestBed.configureTestingModule({
      imports: [ComposerFieldComponent],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ComposerFieldComponent);
    fixture.componentRef.setInput('value', 'chopin');
    fixture.detectChanges();
    const changed = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed);
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new Event('focus'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-0');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith('Chopin');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    api.composers.mockReturnValueOnce(throwError(() => new Error('offline')));
    input.dispatchEvent(new Event('focus'));
    await fixture.whenStable();
    fixture.detectChanges();
    input.value = 'A new composer';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith('A new composer');
    expect(fixture.nativeElement.textContent).toContain('You can still type any composer');
    fixture.destroy();
  });
});
