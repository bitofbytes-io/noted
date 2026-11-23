import { ElementRef, QueryList } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderState } from '../../core/models';
import {
  createReaderComponent,
  destroyConstructedReaders,
  readerStateBlocked,
  saveReaderStateNow,
} from './reader-testing';

afterEach(destroyConstructedReaders);

describe('ReaderComponent reader state', () => {
  it('checkpoints reader state during uninterrupted auto-scroll activity', async () => {
    vi.useFakeTimers();
    try {
      const saveReaderState = vi.fn((_id: string, _state: ReaderState) => of({}));
      const component = createReaderComponent({ saveReaderState });
      const scrollPages = new QueryList<ElementRef<HTMLElement>>();
      scrollPages.reset([]);
      Reflect.set(component, 'scrollPages', scrollPages);
      Reflect.set(component, 'stage', {
        nativeElement: {
          scrollTop: 240,
          getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
        },
      });
      Reflect.set(component, 'pieceId', 'piece');
      Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'mode').set('scroll');

      for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
        component.onStageScroll();
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(saveReaderState).toHaveBeenCalledOnce();
      expect(saveReaderState.mock.calls[0][1]).toMatchObject({
        pieceId: 'piece',
        pdfChecksumSha256: 'a'.repeat(64),
        mode: 'scroll',
        scrollPosition: 240,
        scrollSpeed: 5,
      });
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops stale saves and asks for a reload after a PDF checksum conflict', () => {
    const saveReaderState = vi.fn((_id: string, _state: ReaderState) =>
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { error: 'score PDF changed; reload before saving reader state' },
          }),
      ),
    );
    const component = createReaderComponent({ saveReaderState });
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 0 } });
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    const saveNow = () => saveReaderStateNow(component);

    saveNow();
    saveNow();

    expect(saveReaderState).toHaveBeenCalledOnce();
    expect(saveReaderState.mock.calls[0][1]).toMatchObject({
      pieceId: 'piece',
      pdfChecksumSha256: 'a'.repeat(64),
    });
    expect(Reflect.get(component, 'error')()).toContain('Reload');
    expect(readerStateBlocked(component)).toBe(true);
    component.ngOnDestroy();
  });

  it('serializes reader-state saves and coalesces queued changes to the latest snapshot', () => {
    const firstSave = new Subject<void>();
    const secondSave = new Subject<void>();
    const saveReaderState = vi
      .fn((_id: string, _state: ReaderState) => firstSave)
      .mockReturnValueOnce(firstSave)
      .mockReturnValueOnce(secondSave);
    const component = createReaderComponent({ saveReaderState });
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 100 } });
    Reflect.set(component, 'pieceId', 'piece');
    Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
    Reflect.get(component, 'loading').set(false);
    Reflect.get(component, 'mode').set('scroll');
    Reflect.get(component, 'paused').set(false);
    Reflect.get(component, 'currentPage').set(1);
    const saveNow = () => saveReaderStateNow(component);

    saveNow();
    Reflect.set(component, 'stage', { nativeElement: { scrollTop: 240 } });
    Reflect.get(component, 'paused').set(true);
    saveNow();
    Reflect.get(component, 'mode').set('page');
    Reflect.get(component, 'currentPage').set(3);
    saveNow();

    expect(saveReaderState).toHaveBeenCalledOnce();
    expect(saveReaderState.mock.calls[0][1]).toMatchObject({
      mode: 'scroll',
      lastPage: 1,
      scrollPosition: 100,
      scrollPaused: false,
    });

    firstSave.complete();

    expect(saveReaderState).toHaveBeenCalledTimes(2);
    expect(saveReaderState.mock.calls[1][1]).toMatchObject({
      mode: 'page',
      lastPage: 3,
      scrollPosition: 0,
      scrollPaused: true,
    });

    secondSave.complete();
    Reflect.get(component, 'loading').set(true);
    component.ngOnDestroy();
  });

  it('saves immediately when auto-scroll pauses or the reader mode changes', async () => {
    vi.useFakeTimers();
    try {
      const saveReaderState = vi.fn((_id: string, _state: ReaderState) => of({}));
      const component = createReaderComponent({ saveReaderState });
      const scrollPages = new QueryList<ElementRef<HTMLElement>>();
      scrollPages.reset([]);
      Reflect.set(component, 'scrollPages', scrollPages);
      Reflect.set(component, 'stage', {
        nativeElement: {
          scrollTop: 240,
          getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
        },
      });
      Reflect.set(component, 'pieceId', 'piece');
      Reflect.set(component, 'loadedPDFChecksum', 'a'.repeat(64));
      Reflect.get(component, 'loading').set(false);
      Reflect.get(component, 'mode').set('scroll');
      Reflect.get(component, 'paused').set(false);

      component.togglePause();
      expect(saveReaderState).toHaveBeenCalledOnce();

      component.setMode('page');
      await vi.advanceTimersByTimeAsync(0);
      expect(saveReaderState).toHaveBeenCalledTimes(2);
      expect(saveReaderState.mock.calls[1][1].mode).toBe('page');
      component.ngOnDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
