import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportAsset, ImportDraft } from '../../core/models';
import { PrepareImslpComponent } from './prepare-imslp.component';
import { PrepareComponent } from './prepare.component';
import { PrepareStore } from './prepare.store';
import { PrepareApiMock, createPrepareFixture, draft } from './prepare-testing';

describe('PrepareImslpComponent', () => {
  let fixture: ComponentFixture<PrepareComponent>;
  let store: PrepareStore;
  let api: PrepareApiMock;
  let openWindow: ReturnType<typeof vi.spyOn>;

  const prelude = {
    title: 'Prelude',
    composer: 'Example, Ada',
    url: 'https://imslp.org/wiki/Prelude_(Example,_Ada)',
  };
  const nocturne = {
    title: 'Nocturne',
    composer: 'Sample, Bea',
    url: 'https://imslp.org/wiki/Nocturne_(Sample,_Bea)',
  };
  /** A draft with no title or composer, so only IMSLP can fill them. */
  const showBlankDraft = () =>
    store.draft.set({
      ...structuredClone(draft),
      metadata: { ...structuredClone(draft.metadata), title: '', composer: '' },
    });

  beforeEach(async () => {
    ({ fixture, store, api, openWindow } = await createPrepareFixture());
  });

  afterEach(() => {
    openWindow.mockRestore();
  });

  /** The IMSLP panel, opened on the Source step if it is not showing. */
  const panel = () => {
    store.sourceMode.set('imslp');
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(PrepareImslpComponent))
      .componentInstance as PrepareImslpComponent;
  };

  it('keeps work search fallback and prefills selected IMSLP metadata in the same draft', async () => {
    const component = store;
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [prelude] }));
    component.sourceMode.set('imslp');
    component.imslp.query = 'Prelude';
    await component.imslp.find();
    fixture.detectChanges();
    expect(api.searchIMSLP).toHaveBeenCalledWith('Prelude');
    expect(fixture.nativeElement.textContent).toContain('Add downloaded PDF');
    panel().selectWork(prelude);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Draft score',
      composer: 'Example, Ada',
      sourceUrl: prelude.url,
    });
    expect(component.imslp.link).toBe(prelude.url);
  });

  it('does not select a work while uploading or finalizing', async () => {
    const component = store;
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [prelude] }));
    component.sourceMode.set('imslp');
    component.imslp.query = 'Prelude';
    await component.imslp.find();

    for (const state of ['busy', 'finalizing'] as const) {
      component[state].set(true);
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      );
      expect(select.disabled).toBe(true);
      panel().selectWork(prelude);
      expect(component.draft()?.metadata).toEqual(draft.metadata);
      expect(component.imslp.link).toBe('');
      expect(openWindow).not.toHaveBeenCalled();
      component[state].set(false);
    }
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        'button[aria-label="Open Prelude by Example, Ada on IMSLP"]',
      ).disabled,
    ).toBe(false);
  });

  it('updates only auto-owned fields when switching IMSLP works', async () => {
    const component = store;
    const [first, second] = [prelude, nocturne];
    showBlankDraft();
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslp.query = 'music';
    await component.imslp.find();
    component.sourceMode.set('imslp');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Showing IMSLP's top matches");

    panel().selectWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: first.title,
      composer: first.composer,
      sourceUrl: first.url,
    });
    panel().selectWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: second.title,
      composer: second.composer,
      sourceUrl: second.url,
    });

    component.updateMetadata('title', 'My printed edition');
    panel().selectWork(first);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: first.composer,
      sourceUrl: first.url,
    });
    component.updateMetadata('composer', 'Teacher attribution');
    panel().selectWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: 'Teacher attribution',
      sourceUrl: second.url,
    });
  });

  it('keeps autofill ownership across saving and resuming a draft', async () => {
    const component = store;
    const [first, second] = [prelude, nocturne];
    showBlankDraft();
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslp.query = 'music';
    await component.imslp.find();
    panel().selectWork(first);
    await component.persist();
    const saved = structuredClone(component.draft()!);
    api.importDraft.mockReturnValue(of(saved));
    await component.load();
    panel().selectWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: second.title,
      composer: second.composer,
      sourceUrl: second.url,
    });
    expect(component.draft()?.imslpAutoFill).toMatchObject({
      title: second.title,
      composer: second.composer,
    });
  });

  it('preserves manually edited fields across IMSLP draft resume', async () => {
    const component = store;
    const [first, second] = [prelude, nocturne];
    showBlankDraft();
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [first, second] }));
    component.imslp.query = 'music';
    await component.imslp.find();
    panel().selectWork(first);
    component.updateMetadata('title', 'My printed edition');
    component.updateMetadata('composer', '');
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    panel().selectWork(second);
    expect(component.draft()?.metadata).toMatchObject({
      title: 'My printed edition',
      composer: '',
      sourceUrl: second.url,
    });
    expect(component.draft()?.imslpAutoFill).toMatchObject({
      titleEdited: true,
      composerEdited: true,
    });
  });

  it('opens a draft that arrived with its PDF, as from Send to Noted, on the Pages step', async () => {
    const component = store;
    vi.spyOn(component.preview, 'render').mockResolvedValue();
    const source = {
      id: 'shared-pdf',
      filename: 'IMSLP01240-Debussy_-_Clair_de_lune.pdf',
      mime: 'application/pdf',
      pageCount: 2,
    } as ImportAsset;
    const shared: ImportDraft = {
      ...structuredClone(draft),
      metadata: {
        ...structuredClone(draft.metadata),
        title: 'Clair de lune',
        composer: 'Debussy, Claude',
        sourceUrl: 'https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)',
      },
      imslpAutoFill: { title: 'Clair de lune', composer: 'Debussy, Claude' },
      sources: [source],
      manifest: {
        version: 1,
        pages: [
          { id: 'p1', sourceId: source.id, page: 0 },
          { id: 'p2', sourceId: source.id, page: 1 },
        ],
      },
    };
    api.importDraft.mockReturnValue(of(structuredClone(shared)));
    await component.load();
    fixture.detectChanges();
    expect(component.step()).toBe('pages');
    expect(component.imslp.link).toBe(shared.metadata.sourceUrl);
    expect(component.imslp.added()).toEqual([]);
    const next = [...fixture.nativeElement.querySelectorAll('footer .btn-primary')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Continue'),
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  it('updates pasted IMSLP work metadata when the work link changes after resume', async () => {
    const component = store;
    showBlankDraft();
    component.imslp.link = prelude.url;
    component.applyIMSLP();
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Prelude',
      composer: 'Example, Ada',
    });
    await component.persist();
    api.importDraft.mockReturnValue(of(structuredClone(component.draft()!)));
    await component.load();
    component.imslp.link = nocturne.url;
    component.applyIMSLP();
    expect(component.draft()?.metadata).toMatchObject({
      title: 'Nocturne',
      composer: 'Sample, Bea',
      sourceUrl: component.imslp.link,
    });
  });

  it('replaces an auto-owned filename fallback with a selected work title', async () => {
    const component = store;
    showBlankDraft();
    component.imslp.link = 'https://imslp.org/wiki/(Composer,_Name)';
    component.applyIMSLP();
    expect(component.draft()?.imslpAutoFill?.title).toBe('');
    // This is the draft returned by UploadImportSource after its filename fallback.
    component.draft.update((d) =>
      d
        ? {
            ...d,
            metadata: { ...d.metadata, title: 'from-book' },
            imslpAutoFill: { ...d.imslpAutoFill, title: 'from-book' },
          }
        : null,
    );
    api.searchIMSLP.mockReturnValue(of({ status: 'ready', results: [nocturne] }));
    component.imslp.query = 'Nocturne';
    await component.imslp.find();
    panel().selectWork(nocturne);
    expect(component.draft()?.metadata).toMatchObject({
      title: nocturne.title,
      sourceUrl: nocturne.url,
    });
  });
});
