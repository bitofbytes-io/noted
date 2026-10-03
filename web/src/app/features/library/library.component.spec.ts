import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../core/api.service';
import {
  MAX_PREPARED_PAGES,
  Piece,
  Session,
  ShortcutToken,
  ShortcutTokenCreated,
} from '../../core/models';
import { LibraryComponent } from './library.component';
import { formatDay, lastUsedText, listeningUrlError } from './library.utils';

describe('LibraryComponent', () => {
  it('cancels a stale search so it cannot replace newer results', async () => {
    const stale = new Subject<Piece[]>();
    const latest = new Subject<Piece[]>();
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      pieces: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(latest),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture: ComponentFixture<LibraryComponent> = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    Reflect.set(component, 'query', 'new search');

    const latestLoad = component.load();
    expect(stale.observed).toBe(false);
    const latestPiece = { id: 'latest', title: 'Latest result' } as Piece;
    latest.next([latestPiece]);
    latest.complete();
    await latestLoad;

    stale.next([{ id: 'stale', title: 'Stale result' } as Piece]);
    stale.complete();
    expect(Reflect.get(component, 'pieces')()).toEqual([latestPiece]);
    fixture.destroy();
  });

  it('adds or replaces a PDF only through Prepare, and explains the page limit', async () => {
    const api = {
      session: vi.fn(() => of({ authenticated: true, authMode: 'development', development: true })),
      imports: vi.fn(() => of([])),
      pieces: vi.fn(() => of([])),
      createImport: vi.fn(() => of({ id: 'draft-1' })),
      updatePiece: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    const piece = (pageCount: number | null) =>
      ({
        id: `piece-${pageCount ?? 'none'}`,
        title: 'Score',
        composer: '',
        favorite: false,
        sourceUrl: '',
        listeningUrl: '',
        notes: '',
        pdf: pageCount === null ? null : { pageCount, contentUrl: '/api/pieces/x/pdf' },
      }) as Piece;
    const render = () => {
      fixture.componentRef.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    const actions = () =>
      [...fixture.nativeElement.querySelectorAll('.pdf-actions button, .pdf-actions a')].map(
        (action) => action.textContent.trim(),
      );
    const prepareButton = () =>
      fixture.nativeElement.querySelector('.pdf-actions button') as HTMLButtonElement;

    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeNull();

    component.openEdit(piece(null));
    render();
    expect(actions()).toEqual(['Add PDF']);
    prepareButton().click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.createImport).toHaveBeenLastCalledWith('piece-none');
    expect(navigate).toHaveBeenLastCalledWith(['/prepare', 'draft-1'], {
      queryParams: { source: 'all' },
    });

    component.openEdit(piece(MAX_PREPARED_PAGES));
    render();
    expect(actions()).toEqual(['Edit or replace PDF', 'Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit')).toBeNull();
    prepareButton().click();
    await vi.waitFor(() =>
      expect(api.createImport).toHaveBeenLastCalledWith(`piece-${MAX_PREPARED_PAGES}`),
    );

    api.createImport.mockClear();
    component.openEdit(piece(MAX_PREPARED_PAGES + 1));
    render();
    expect(actions()).toEqual(['Download current PDF']);
    expect(fixture.nativeElement.querySelector('#edit-pages-limit').textContent).toContain(
      `up to ${MAX_PREPARED_PAGES} pages, so this score’s PDF`,
    );
    await component.editPages();
    expect(api.createImport).not.toHaveBeenCalled();
    expect(api.updatePiece).not.toHaveBeenCalled();
    fixture.destroy();
  });
});

const TOKEN = 'pR8xQ2nVf7Lw0mKaZc4HtYe9BjUs1GdNoI3vXb6Fq5E';
const REPLACEMENT = 'Zz9yXw8vUt7sRq6pOn5mLk4jIh3gFe2dCb1aZz9yXw8';

describe('LibraryComponent account dialog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(
    options: {
      development?: boolean;
      token?: ShortcutToken;
      created?: ShortcutTokenCreated[];
    } = {},
  ) {
    const session: Session = {
      authenticated: true,
      authMode: options.development ? 'development' : 'google',
      development: !!options.development,
      user: { id: 'u1', email: 'daniel@example.test', displayName: 'Daniel' },
    };
    const created = [...(options.created ?? [])];
    // Like the server: the status follows create and delete, and never holds the token.
    let status: ShortcutToken = options.token ?? {
      active: false,
      createdAt: null,
      lastUsedAt: null,
    };
    const api = {
      session: vi.fn(() => of(session)),
      imports: vi.fn(() => of([])),
      pieces: vi.fn(() => of([])),
      logout: vi.fn(() => of(undefined)),
      shortcutToken: vi.fn(() => of(status)),
      createShortcutToken: vi.fn(() => {
        const next = created.shift()!;
        status = { active: true, createdAt: next.createdAt, lastUsedAt: null };
        return of(next);
      }),
      deleteShortcutToken: vi.fn(() => {
        status = { active: false, createdAt: null, lastUsedAt: null };
        return of(undefined);
      }),
    };
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: ApiService, useValue: api },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const dialog = root.querySelector('dialog.account') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn(() => dialog.dispatchEvent(new Event('close')));
    const render = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const buttons = (scope: ParentNode = dialog) =>
      [...scope.querySelectorAll('button')] as HTMLButtonElement[];
    const button = (label: string, scope: ParentNode = dialog) =>
      buttons(scope).find(
        (candidate) =>
          candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
      );
    const click = async (label: string, scope: ParentNode = dialog) => {
      const target = button(label, scope);
      expect(target, `button "${label}"`).toBeDefined();
      target!.click();
      await render();
    };
    const open = async () => {
      await click('Daniel', root.querySelector('.masthead')!);
    };
    const text = () => dialog.textContent?.replace(/\s+/g, ' ') ?? '';
    return { fixture, api, root, dialog, render, button, click, open, text };
  }

  it('opens from the display name, which is the masthead’s only account control', async () => {
    const { root, dialog, button, open, text, api } = await setup();
    const masthead = root.querySelector('.masthead')!;
    const name = button('Daniel', masthead)!;
    expect(name.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button('Sign out', masthead)).toBeUndefined();
    expect(masthead.querySelector('.dev-chip')).toBeNull();

    await open();
    expect(dialog.showModal).toHaveBeenCalled();
    expect(api.shortcutToken).toHaveBeenCalledTimes(1);
    expect(text()).toContain('daniel@example.test');
    expect(text()).toContain(
      'Share a PDF from Safari or Files straight into a new draft on this iPad.',
    );
    expect(button('Set up on this iPad')).toBeDefined();
    expect(button('Replace')).toBeUndefined();
    expect(button('Sign out')).toBeDefined();
  });

  it('keeps the Dev chip and offers no Sign out in development', async () => {
    const { root, button, open } = await setup({ development: true });
    expect(root.querySelector('.masthead .dev-chip')?.textContent).toContain('Dev');
    await open();
    expect(button('Sign out')).toBeUndefined();
    expect(button('Set up on this iPad')).toBeDefined();
  });

  it('shows a new token once, then only its dates after closing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const { dialog, api, click, open, text, button, render } = await setup({
      created: [
        {
          token: TOKEN,
          createdAt: new Date(2026, 9, 1, 9).toISOString(),
        },
      ],
    });
    await open();
    await click('Set up on this iPad');
    expect(api.createShortcutToken).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector('.shortcut-token code')?.textContent).toBe(TOKEN);
    // The signed template Noted serves; Shortcuts asks for the token on import.
    const template = dialog.querySelector('.shortcut-steps a') as HTMLAnchorElement;
    expect(template.textContent).toBe('Get the Shortcut');
    expect(template.getAttribute('href')).toBe('/send-to-noted.shortcut');
    expect(template.hasAttribute('download')).toBe(true);
    expect(template.target).toBe('');
    expect(text()).toContain(
      'Tap Add Shortcut, then open it in Shortcuts and paste this into the first text box:',
    );
    expect(text()).toContain('Tap Done. Share any PDF with Send to Noted.');
    expect(text()).toContain(
      'You won’t see this token again. If you lose it, come back and tap Replace.',
    );
    expect(button('Copy')).toBeDefined();

    await click('Close');
    expect(dialog.close).toHaveBeenCalled();
    await open();
    await render();
    expect(text()).not.toContain(TOKEN);
    expect(dialog.querySelector('.shortcut-token')).toBeNull();
    expect(text()).toContain('Set up on 1 Oct 2026 · last used never');
    expect(button('Replace')).toBeDefined();
    expect(button('Turn off')).toBeDefined();
  });

  it('offers the Shortcut again for a second device once set up', async () => {
    const { dialog, open, text } = await setup({
      token: { active: true, createdAt: '2026-10-01T09:00:00Z', lastUsedAt: null },
    });
    await open();
    const again = dialog.querySelector('.shortcut-again a') as HTMLAnchorElement;
    expect(again.textContent).toBe('Get the Shortcut again');
    expect(again.getAttribute('href')).toBe('/send-to-noted.shortcut');
    expect(again.hasAttribute('download')).toBe(true);
    expect(text()).toContain('You’ll need your token; if you don’t have it, tap Replace.');
    expect(dialog.querySelector('.shortcut-token')).toBeNull();
  });

  it('discards the token when the dialog closes with Escape', async () => {
    const { dialog, click, open, render, text } = await setup({
      created: [{ token: TOKEN, createdAt: '2026-10-01T09:00:00Z' }],
    });
    await open();
    await click('Set up on this iPad');
    dialog.dispatchEvent(new Event('close'));
    await render();
    expect(text()).not.toContain(TOKEN);
  });

  it('replaces the token only after the inline confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 12));
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { dialog, api, click, open, text, button } = await setup({
      token: {
        active: true,
        createdAt: new Date(2026, 9, 1, 9).toISOString(),
        lastUsedAt: new Date(2026, 9, 2, 20).toISOString(),
      },
      created: [{ token: REPLACEMENT, createdAt: new Date().toISOString() }],
    });
    await open();
    expect(text()).toContain('Set up on 1 Oct 2026 · last used yesterday');

    await click('Replace');
    expect(api.createShortcutToken).not.toHaveBeenCalled();
    expect(text()).toContain(
      'Replace the token? The Shortcut on your iPad stops working until you paste the new one.',
    );
    await click('Cancel');
    expect(dialog.querySelector('.shortcut-confirm')).toBeNull();

    await click('Replace');
    await click('Replace token');
    expect(api.createShortcutToken).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(dialog.querySelector('.shortcut-token code')?.textContent).toBe(REPLACEMENT);
    expect(button('Replace')).toBeUndefined();
  });

  it('turns the token off only after the inline confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { api, click, open, text, button } = await setup({
      token: { active: true, createdAt: '2026-10-01T09:00:00Z', lastUsedAt: null },
    });
    await open();
    await click('Turn off');
    expect(api.deleteShortcutToken).not.toHaveBeenCalled();
    expect(text()).toContain('Turn off Send to Noted? The Shortcut on your iPad stops working.');
    const confirmBlock = document.querySelector('.shortcut-confirm')!;
    await click('Turn off', confirmBlock);
    expect(api.deleteShortcutToken).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(button('Set up on this iPad')).toBeDefined();
    expect(button('Replace')).toBeUndefined();
  });

  it('keeps the dialog usable and says why when a token change fails', async () => {
    const { api, click, open, text, button } = await setup();
    api.createShortcutToken.mockReturnValueOnce(
      throwError(() => new Error('internal server error')),
    );
    await open();
    await click('Set up on this iPad');
    expect(text()).toContain('Internal server error.');
    expect(button('Set up on this iPad')?.disabled).toBe(false);
  });

  it('copies the token, and selects it when the clipboard refuses', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { fixture, dialog, open, text, button } = await setup({
      created: [{ token: TOKEN, createdAt: '2026-10-01T09:00:00Z' }],
    });
    const component = fixture.componentInstance;
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    };
    void open();
    await settle();
    void component.createShortcut();
    await settle();

    button('Copy')!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(button('Copied')).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    fixture.detectChanges();
    expect(button('Copy')).toBeDefined();

    writeText.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    const selection = { removeAllRanges: vi.fn(), selectAllChildren: vi.fn() };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);
    button('Copy')!.click();
    await settle();
    expect(selection.selectAllChildren).toHaveBeenCalledWith(
      dialog.querySelector('.shortcut-token code'),
    );
    expect(text()).toContain('The token is selected. Copy it from the menu.');
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('lastUsedText', () => {
  afterEach(() => vi.useRealTimers());

  it('names the day of last use', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 0, 30));
    expect(lastUsedText(null)).toBe('never');
    expect(lastUsedText(new Date(2026, 9, 3, 0, 5).toISOString())).toBe('today');
    expect(lastUsedText(new Date(2026, 9, 2, 23, 59).toISOString())).toBe('yesterday');
    const older = new Date(2026, 8, 28, 12).toISOString();
    expect(lastUsedText(older)).toBe('28 Sep 2026');
    expect(formatDay(older)).toBe('28 Sep 2026');
  });
});

describe('listeningUrlError', () => {
  it('accepts empty and absolute HTTP(S) listening URLs', () => {
    expect(listeningUrlError('')).toBe('');
    expect(listeningUrlError('  https://www.youtube.com/watch?v=example  ')).toBe('');
  });

  it('rejects malformed and non-HTTP(S) listening URLs with a clear message', () => {
    expect(listeningUrlError('youtube.com/watch?v=example')).toBe(
      'listening URL must be an http or https URL',
    );
    expect(listeningUrlError('file:///tmp/recording.mp3')).toBe(
      'listening URL must be an http or https URL',
    );
  });
});
