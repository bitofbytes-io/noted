import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetronomeComponent } from './metronome.component';

class FakeAudioContext {
  static created = 0;
  static closed = 0;
  static latest: FakeAudioContext | undefined;
  currentTime = 0;
  destination = {};
  state: 'suspended' | 'running' | 'closed' | 'interrupted' = 'suspended';
  private readonly stateListeners = new Set<() => void>();
  constructor() {
    FakeAudioContext.created++;
    FakeAudioContext.latest = this;
  }
  resume = () => {
    this.state = 'running';
    return Promise.resolve();
  };
  close = () => {
    FakeAudioContext.closed++;
    this.state = 'closed';
    return Promise.resolve();
  };
  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.stateListeners.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.stateListeners.delete(listener);
  }
  /** Reports a later device state the way a browser `statechange` event does. */
  emit(state: FakeAudioContext['state']): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener();
  }
  createOscillator = () => ({
    frequency: { value: 0 },
    connect: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  });
  createGain = () => ({
    gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
    connect: () => undefined,
  });
}

function button(fixture: ComponentFixture<MetronomeComponent>, label: string): HTMLButtonElement {
  const found = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
    (candidate) =>
      (candidate as HTMLButtonElement).getAttribute('aria-label') === label ||
      (candidate as HTMLButtonElement).textContent?.trim() === label,
  );
  if (!found) throw new Error(`No "${label}" button`);
  return found as HTMLButtonElement;
}

function readout(fixture: ComponentFixture<MetronomeComponent>): string {
  return fixture.nativeElement.querySelector('output').textContent.trim();
}

function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('MetronomeComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeAudioContext.created = 0;
    FakeAudioContext.closed = 0;
    FakeAudioContext.latest = undefined;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function render(pieceId = 'piece-1') {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(MetronomeComponent);
    fixture.componentRef.setInput('pieceId', pieceId);
    await fixture.whenStable();
    return fixture;
  }

  it('starts and stops ticking and reports it', async () => {
    const fixture = await render();
    const running: boolean[] = [];
    fixture.componentInstance.runningChange.subscribe((value) => running.push(value));

    button(fixture, 'Start').click();
    await fixture.whenStable();
    expect(FakeAudioContext.created).toBe(1);
    expect(button(fixture, 'Stop').getAttribute('aria-pressed')).toBe('true');

    button(fixture, 'Stop').click();
    await fixture.whenStable();
    expect(FakeAudioContext.closed).toBe(1);
    expect(running).toEqual([true, false]);
  });

  it('stops the audio when the reader closes', async () => {
    const fixture = await render();
    button(fixture, 'Start').click();
    fixture.destroy();
    expect(FakeAudioContext.closed).toBe(1);
  });

  it('keeps the tempo within 40-240 and remembers it for the piece', async () => {
    localStorage.setItem('noted.metronome.piece-1', JSON.stringify({ bpm: 41, beatsPerBar: 4 }));
    const fixture = await render();
    expect(readout(fixture)).toBe('41');

    button(fixture, 'Slower').click();
    await fixture.whenStable();
    expect(readout(fixture)).toBe('40');
    expect(button(fixture, 'Slower').disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem('noted.metronome.piece-1')!).bpm).toBe(40);

    const other = await render('piece-2');
    expect(readout(other)).toBe('100');
  });

  it('restores the tempo and beats per bar last used with the piece', async () => {
    localStorage.setItem('noted.metronome.piece-1', JSON.stringify({ bpm: 66, beatsPerBar: 3 }));
    const fixture = await render();
    expect(readout(fixture)).toBe('66');
    expect(fixture.nativeElement.querySelectorAll('.beat-dot').length).toBe(3);
  });

  it('sets the tempo from taps', async () => {
    const fixture = await render();
    const now = vi.spyOn(performance, 'now');
    for (const time of [1000, 1500, 2000]) {
      now.mockReturnValue(time);
      button(fixture, 'Tap').click();
    }
    await fixture.whenStable();
    expect(readout(fixture)).toBe('120');
    expect(JSON.parse(localStorage.getItem('noted.metronome.piece-1')!).bpm).toBe(120);
  });

  it('changes beats per bar between 1 and 12', async () => {
    const fixture = await render();
    for (let press = 0; press < 20; press++) button(fixture, 'More beats per bar').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.beat-dot').length).toBe(12);
    for (let press = 0; press < 20; press++) button(fixture, 'Fewer beats per bar').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.beat-dot').length).toBe(1);
  });

  it('hands keyboard focus back after a pointer press so pedal keys turn pages', async () => {
    const fixture = await render();
    document.body.appendChild(fixture.nativeElement);
    const start = button(fixture, 'Start');
    start.focus();
    expect(document.activeElement).toBe(start);

    fixture.nativeElement.querySelector('.metronome').dispatchEvent(new Event('pointerup'));
    await later();
    expect(document.activeElement).not.toBe(start);
    fixture.nativeElement.remove();
  });

  it('blurs a control that touch compatibility mouse events focus after pointerup', async () => {
    const fixture = await render();
    document.body.appendChild(fixture.nativeElement);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const start = button(fixture, 'Start');
    const panel = fixture.nativeElement.querySelector('.metronome') as HTMLElement;
    // The reader drops pedal keys while focus is inside a button or slider.
    panel.addEventListener('pointerup', () => start.focus(), { once: true });

    panel.dispatchEvent(new Event('pointerup'));
    await later();

    expect(document.activeElement).not.toBe(start);
    await later();
    start.focus();
    await later();
    await later();
    expect(document.activeElement).toBe(start);
    outside.remove();
    fixture.nativeElement.remove();
  });

  it('blurs a control focused by the click that follows pointerup', async () => {
    const fixture = await render();
    document.body.appendChild(fixture.nativeElement);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const start = button(fixture, 'Start');
    const panel = fixture.nativeElement.querySelector('.metronome') as HTMLElement;

    panel.dispatchEvent(new Event('pointerup'));
    await later();
    await later();
    panel.addEventListener('click', () => start.focus(), { once: true });
    panel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await later();

    expect(document.activeElement).not.toBe(start);
    outside.remove();
    fixture.nativeElement.remove();
  });

  it('keeps keyboard focus when a control is activated from the keyboard', async () => {
    const fixture = await render();
    document.body.appendChild(fixture.nativeElement);
    const start = button(fixture, 'Start');
    const panel = fixture.nativeElement.querySelector('.metronome') as HTMLElement;
    start.focus();

    panel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await later();
    await later();

    expect(document.activeElement).toBe(start);
    fixture.nativeElement.remove();
  });

  it('stops when the page is hidden', async () => {
    const fixture = await render();
    button(fixture, 'Start').click();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await fixture.whenStable();
    expect(FakeAudioContext.closed).toBe(1);
    vi.restoreAllMocks();
  });

  it('drops back to Start and says so when the audio device fails to start', async () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override resume = () => Promise.reject(new Error('no device'));
      },
    );
    const fixture = await render();
    const running: boolean[] = [];
    fixture.componentInstance.runningChange.subscribe((value) => running.push(value));

    button(fixture, 'Start').click();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    expect(running).toEqual([true, false]);
    expect(button(fixture, 'Start').getAttribute('aria-pressed')).toBe('false');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('drops back to Start when a playing metronome is interrupted', async () => {
    const fixture = await render();
    const running: boolean[] = [];
    fixture.componentInstance.runningChange.subscribe((value) => running.push(value));
    button(fixture, 'Start').click();
    await fixture.whenStable();
    expect(button(fixture, 'Stop').getAttribute('aria-pressed')).toBe('true');

    FakeAudioContext.latest?.emit('interrupted');
    await fixture.whenStable();

    expect(running).toEqual([true, false]);
    expect(button(fixture, 'Start').getAttribute('aria-pressed')).toBe('false');
    expect(fixture.nativeElement.querySelector('.beat-dot.active')).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    expect(FakeAudioContext.closed).toBe(1);
  });

  it('stops when a hidden page suspends the audio without saying sound is unavailable', async () => {
    const fixture = await render();
    button(fixture, 'Start').click();
    await fixture.whenStable();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    FakeAudioContext.latest?.emit('suspended');
    await fixture.whenStable();

    expect(button(fixture, 'Start').getAttribute('aria-pressed')).toBe('false');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(FakeAudioContext.closed).toBe(1);
    vi.restoreAllMocks();
  });

  it('gives the tempo slider a 44px touch target', async () => {
    const fixture = await render();
    const slider = fixture.nativeElement.querySelector('.tempo-slider') as HTMLElement;
    const style = getComputedStyle(slider);
    expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(style.height)).toBeGreaterThanOrEqual(44);
  });

  it('says so when sound is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const fixture = await render();
    button(fixture, 'Start').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Sound');
  });
});
