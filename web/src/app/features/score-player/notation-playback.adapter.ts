import * as alphaTab from '@coderline/alphatab';

export interface PlayerCallbacks {
  onScoreLoaded: (measureCount: number, originalBpm: number) => void;
  onPlaybackReady: () => void;
  onPlayingChanged: (playing: boolean) => void;
  onError: (error: Error) => void;
}

export function validateMeasureRange(start: number, end: number, measureCount: number): string {
  if (!Number.isInteger(start) || start < 1) return 'Start measure must be at least 1.';
  if (!Number.isInteger(end) || end < start)
    return 'End measure must be the same as or after the start.';
  if (end > measureCount) return `End measure must be at most ${measureCount}.`;
  return '';
}

export class NotationPlaybackAdapter {
  private api?: alphaTab.AlphaTabApi;
  private score?: alphaTab.model.Score;
  private originalBpm = 96;

  async load(
    url: string,
    container: HTMLElement,
    scrollElement: HTMLElement,
    callbacks: PlayerCallbacks,
  ): Promise<void> {
    this.dispose();
    this.api = new alphaTab.AlphaTabApi(container, {
      core: {
        useWorkers: false,
        fontDirectory: '/alphatab/font/',
      },
      display: {
        layoutMode: alphaTab.LayoutMode.Page,
        staveProfile: 'Default',
      },
      player: {
        enablePlayer: true,
        soundFont: '/alphatab/soundfont/sonivox.sf2',
        outputMode: alphaTab.PlayerOutputMode.WebAudioScriptProcessor,
        scrollElement,
      },
    });
    this.api.scoreLoaded.on((score) => {
      this.score = score;
      score.stylesheet.barNumberDisplay = alphaTab.model.BarNumberDisplay.AllBars;
      score.style ??= new alphaTab.model.ScoreStyle();
      score.style.headerAndFooter.set(
        alphaTab.model.ScoreSubElement.CopyrightSecondLine,
        new alphaTab.model.HeaderFooterStyle('', false),
      );
      this.originalBpm = score.tempo || 96;
      callbacks.onScoreLoaded(score.masterBars.length, this.originalBpm);
    });
    this.api.playerReady.on(() => callbacks.onPlaybackReady());
    this.api.playerStateChanged.on((event) => callbacks.onPlayingChanged(event.state === 1));
    this.api.error.on((error) => callbacks.onError(error));

    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Unable to load MusicXML (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!this.api.load(data))
      throw new Error('The notation engine could not load this MusicXML file');
  }

  setBpm(bpm: number): void {
    if (!this.api) return;
    this.api.playbackSpeed = bpm / this.originalBpm;
  }

  setRange(start: number, end: number): void {
    if (!this.api || !this.score) return;
    const startBar = this.score.masterBars[start - 1];
    const endBar = this.score.masterBars[end - 1];
    this.api.playbackRange = {
      startTick: startBar.start,
      endTick: endBar.start + endBar.calculateDuration(),
    };
  }

  setLooping(looping: boolean): void {
    if (this.api) this.api.isLooping = looping;
  }

  playPause(): void {
    this.api?.playPause();
  }

  restart(): void {
    this.api?.stop();
  }

  dispose(): void {
    this.api?.destroy();
    this.api = undefined;
    this.score = undefined;
  }
}
