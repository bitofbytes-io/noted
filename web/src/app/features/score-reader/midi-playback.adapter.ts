import * as alphaTab from '@coderline/alphatab';
import { Midi } from '@tonejs/midi';

export class MidiPlaybackAdapter {
  private api?: alphaTab.AlphaTabApi;
  private playing = false;

  async load(element: HTMLElement, url: string): Promise<void> {
    this.dispose();
    this.api = new alphaTab.AlphaTabApi(element, {
      core: {
        useWorkers: false,
        fontDirectory: '/alphatab/font/',
      },
      player: {
        enablePlayer: true,
        soundFont: '/alphatab/soundfont/sonivox.sf2',
        outputMode: alphaTab.PlayerOutputMode.WebAudioScriptProcessor,
      },
      display: { staveProfile: 'Default' },
    });
    const contents = await fetch(url, { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error(`MIDI request failed (${response.status})`);
      return response.arrayBuffer();
    });
    const parsed = new Midi(contents);
    const midi = new alphaTab.midi.MidiFile();
    midi.division = parsed.header.ppq;
    midi.format = alphaTab.midi.MidiFileFormat.MultiTrack;
    for (const tempo of parsed.header.tempos) {
      midi.addEvent(
        new alphaTab.midi.TempoChangeEvent(
          tempo.ticks,
          Math.round(60_000_000 / Math.max(1, tempo.bpm)),
        ),
      );
    }
    parsed.tracks.forEach((track, trackIndex) => {
      const channel = Math.min(15, Math.max(0, track.channel));
      midi.addEvent(
        new alphaTab.midi.ProgramChangeEvent(trackIndex, 0, channel, track.instrument.number),
      );
      for (const note of track.notes) {
        const velocity = Math.min(127, Math.max(1, Math.round(note.velocity * 127)));
        midi.addEvent(
          new alphaTab.midi.NoteOnEvent(trackIndex, note.ticks, channel, note.midi, velocity),
        );
        midi.addEvent(
          new alphaTab.midi.NoteOffEvent(
            trackIndex,
            note.ticks + note.durationTicks,
            channel,
            note.midi,
            velocity,
          ),
        );
      }
    });
    const player = this.api.player;
    if (!player) throw new Error('alphaSynth did not initialize');
    this.api.playerStateChanged.on(
      (event) => (this.playing = event.state === alphaTab.synth.PlayerState.Playing),
    );
    player.loadMidiFile(midi);
    if (!player.isReadyForPlayback) {
      await new Promise<void>((resolve) => this.api?.playerReady.on(resolve));
    }
  }

  play(): void {
    this.playing = Boolean(this.api?.player?.play());
  }
  pause(): void {
    this.api?.player?.pause();
    this.playing = false;
  }
  seek(positionMs: number): void {
    if (this.api?.player) this.api.player.timePosition = Math.max(0, positionMs);
  }
  setRate(rate: number): void {
    if (this.api?.player) this.api.player.playbackSpeed = rate;
  }
  positionMs(): number {
    return this.api?.player?.timePosition ?? 0;
  }
  durationMs(): number {
    return this.api?.player?.currentPosition.endTime ?? 0;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  dispose(): void {
    this.api?.destroy();
    this.api = undefined;
    this.playing = false;
  }
}
