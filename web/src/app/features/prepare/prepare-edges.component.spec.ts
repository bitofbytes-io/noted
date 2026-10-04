import { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveEdgeCorner } from './prepare-edges.component';
import { PrepareComponent } from './prepare.component';
import { createPrepareFixture, draft } from './prepare-testing';

describe('PrepareEdgesComponent', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let openWindow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ fixture, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  async function openEdgeEditor() {
    const component = fixture.componentInstance;
    component.draft.set({
      ...structuredClone(draft),
      manifest: { version: 1, pages: [{ id: 'page', sourceId: 'pdf', page: 0 }] },
    });
    component.step.set('pages');
    component.preview.set('data:image/png;base64,');
    vi.spyOn(component, 'renderPreview').mockResolvedValue();
    fixture.detectChanges();
    const surface = component.surface!.nativeElement;
    surface.scrollIntoView = vi.fn();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
    selection.addRange(range);
    expect(selection.isCollapsed).toBe(false);
    await component.beginEdges();
    fixture.detectChanges();
    return { component, surface, selection };
  }

  it('suppresses native preview interactions only while editing edges and clears selection', async () => {
    const { component, surface, selection } = await openEdgeEditor();
    expect(selection.isCollapsed).toBe(true);
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      true,
    );
    for (const type of ['contextmenu', 'dragstart']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      surface.querySelector('img')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }

    component.cancelEdges();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('main').classList.contains('editing-edges')).toBe(
      false,
    );
    const event = new Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'cancel', 'apply', 'destroy'])(
    'confines a corner drag to its pointer and removes handlers after %s',
    async (ending) => {
      const { component, surface, selection } = await openEdgeEditor();
      vi.spyOn(surface.querySelector('img')!, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      } as DOMRect);
      const corner = surface.querySelector<HTMLButtonElement>('.corner')!;
      corner.setPointerCapture = vi.fn();
      corner.hasPointerCapture = vi.fn(() => true);
      corner.releasePointerCapture = vi.fn();
      const pointer = (type: string, pointerId = 1, x = 20) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: x,
          button: 0,
        });
        Object.defineProperties(event, {
          pointerId: { value: pointerId },
          isPrimary: { value: pointerId === 1 },
        });
        corner.dispatchEvent(event);
        return event;
      };
      const range = document.createRange();
      range.selectNodeContents(fixture.nativeElement.querySelector('h1'));
      selection.addRange(range);
      expect(pointer('pointerdown').defaultPrevented).toBe(true);
      expect(selection.isCollapsed).toBe(true);
      pointer('pointermove', 2);
      pointer('pointerup', 2);
      expect(component.edgePoints[0]).toEqual([0, 0]);
      expect(pointer('pointermove').defaultPrevented).toBe(true);
      expect(component.edgePoints[0]).toEqual([0.2, 0.2]);

      if (ending === 'cancel') component.cancelEdges();
      else if (ending === 'apply') {
        vi.spyOn(component, 'changed').mockImplementation(() => {});
        component.applyEdges();
      } else if (ending === 'destroy') fixture.destroy();
      else pointer(ending);
      const edges = structuredClone(component.edgePoints);
      expect(pointer('pointermove', 1, 30).defaultPrevented).toBe(false);
      expect(component.edgePoints).toEqual(edges);
      expect(corner.releasePointerCapture).toHaveBeenCalledWith(1);
    },
  );

  describe('moveEdgeCorner', () => {
    const full = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];

    it('keeps a crop rectangular and at least 5% from the opposite corner', () => {
      expect(moveEdgeCorner(full, 'crop', 0, 0.2, 0.1)).toEqual([
        [0.2, 0.1],
        [1, 0.1],
        [1, 1],
        [0.2, 1],
      ]);
      const squeezed = moveEdgeCorner(full, 'crop', 2, 0.01, 0.01)!;
      expect(squeezed[2][0]).toBeCloseTo(0.05, 4);
      expect(squeezed[2][1]).toBeCloseTo(0.05, 4);
      expect(squeezed[1]).toEqual([squeezed[2][0], 0]);
      // The opposite corner leaves no room on that side of the page.
      const narrow = [
        [0.98, 0],
        [1, 0],
        [1, 1],
        [0.98, 1],
      ];
      expect(moveEdgeCorner(narrow, 'crop', 1, 0.99, 0)).toBeNull();
    });

    it('moves one perspective corner and rejects crossed or collapsed quads', () => {
      expect(moveEdgeCorner(full, 'corners', 2, 0.9, 0.8)).toEqual([
        [0, 0],
        [1, 0],
        [0.9, 0.8],
        [0, 1],
      ]);
      expect(moveEdgeCorner(full, 'corners', 0, 1.2, -0.5)).toBeNull();
      expect(moveEdgeCorner(full, 'corners', 0, 0.98, 0.02)).toBeNull();
      expect(moveEdgeCorner(full, 'corners', 2, -1, -1)).toBeNull();
      expect(full[2]).toEqual([1, 1]);
    });

    it('keeps a rectangle for a perspective corner when asked', () => {
      expect(moveEdgeCorner(full, 'corners', 3, 0.1, 0.9, true)).toEqual([
        [0.1, 0],
        [1, 0],
        [1, 0.9],
        [0.1, 0.9],
      ]);
    });
  });
});
