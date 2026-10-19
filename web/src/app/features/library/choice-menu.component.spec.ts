import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { Choice, ChoiceMenuComponent } from './choice-menu.component';

type Size = 'small' | 'medium' | 'large';

@Component({
  imports: [ChoiceMenuComponent],
  template: `
    <h1>Outside</h1>
    <app-choice-menu
      name="Size"
      [options]="options"
      [value]="value()"
      (chosen)="chosen.push($event); value.set($event)"
    />
  `,
})
class HostComponent {
  readonly options: readonly Choice<Size>[] = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium', hint: 'the usual' },
    { value: 'large', label: 'Large' },
  ];
  readonly value = signal<Size>('medium');
  readonly chosen: Size[] = [];
}

describe('ChoiceMenuComponent', () => {
  async function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const button = () => root.querySelector('.menu-button') as HTMLButtonElement;
    const items = () => [...root.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    const key = (target: HTMLElement, name: string) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    return { fixture, root, button, items, key };
  }

  it('names the current choice and links the button to its menu', async () => {
    const { fixture, button, items } = await setup();
    expect(button().textContent?.trim()).toBe('Size: Medium');
    expect(button().getAttribute('aria-haspopup')).toBe('menu');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    button().click();
    await fixture.whenStable();
    const menu = document.getElementById(button().getAttribute('aria-controls')!);
    expect(menu?.getAttribute('aria-label')).toBe('Size');
    const words = (item: HTMLElement) =>
      [...item.querySelectorAll('.menu-option > *')].map((part) => part.textContent?.trim());
    expect(items().map(words)).toEqual([['Small'], ['Medium', 'the usual'], ['Large']]);
    fixture.destroy();
  });

  it('opens from the keyboard and moves between choices like a select', async () => {
    const { fixture, button, items, key } = await setup();
    key(button(), 'ArrowDown');
    await fixture.whenStable();
    await vi.waitFor(() => expect(document.activeElement).toBe(items()[1]));
    key(items()[1], 'ArrowDown');
    expect(document.activeElement).toBe(items()[2]);
    key(items()[2], 'ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0], 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
    key(items()[2], 'Home');
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0], 'End');
    expect(document.activeElement).toBe(items()[2]);

    items()[2].click();
    await fixture.whenStable();
    expect(items()).toEqual([]);
    expect(document.activeElement).toBe(button());
    expect(button().textContent?.trim()).toBe('Size: Large');
    expect(fixture.componentInstance.chosen).toEqual(['large']);
    fixture.destroy();
  });

  it('closes with Escape, Tab or an outside click, without choosing', async () => {
    const { fixture, root, button, items, key } = await setup();
    button().click();
    await fixture.whenStable();
    key(items()[0], 'Escape');
    await fixture.whenStable();
    expect(items()).toEqual([]);
    expect(document.activeElement).toBe(button());

    button().click();
    await fixture.whenStable();
    key(items()[0], 'Tab');
    await fixture.whenStable();
    expect(items()).toEqual([]);

    button().click();
    await fixture.whenStable();
    (root.querySelector('h1') as HTMLElement).click();
    await fixture.whenStable();
    expect(items()).toEqual([]);
    expect(fixture.componentInstance.chosen).toEqual([]);
    fixture.destroy();
  });
});
