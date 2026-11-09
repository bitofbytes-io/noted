import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetronomeComponent } from './metronome.component';

class FakeAudioContext {
  static created = 0;
  static closed = 0;
  currentTime = 0;
  destination = {};
  constructor() {
    FakeAudioContext.created++;
  }
  resume = () => Promise.resolve();
  close = () => {
    FakeAudioContext.closed++;
    return Promise.resolve();
  };
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

describe('MetronomeComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeAudioContext.created = 0;
    FakeAudioContext.closed = 0;
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
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.activeElement).not.toBe(start);
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

  it('says so when sound is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const fixture = await render();
    button(fixture, 'Start').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Sound');
  });
});
