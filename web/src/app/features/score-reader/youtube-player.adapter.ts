interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  destroy(): void;
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number | string>;
      events: { onReady: () => void; onStateChange: (event: { data: number }) => void };
    },
  ) => YouTubePlayer;
  PlayerState: { PLAYING: number };
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeNamespace> | undefined;

function loadAPI(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
      else reject(new Error('YouTube player API did not initialize'));
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('YouTube player API could not be loaded'));
    document.head.append(script);
  });
  return apiPromise;
}

export class YouTubePlayerAdapter {
  private player?: YouTubePlayer;
  private playing = false;

  async load(element: HTMLElement, videoId: string): Promise<void> {
    this.dispose();
    const YT = await loadAPI();
    await new Promise<void>((resolve) => {
      this.player = new YT.Player(element, {
        videoId,
        playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
        events: {
          onReady: resolve,
          onStateChange: (event) => (this.playing = event.data === YT.PlayerState.PLAYING),
        },
      });
    });
  }

  play(): void {
    this.player?.playVideo();
  }
  pause(): void {
    this.player?.pauseVideo();
  }
  seek(positionMs: number): void {
    this.player?.seekTo(Math.max(0, positionMs) / 1000, true);
  }
  setRate(rate: number): void {
    this.player?.setPlaybackRate(rate);
  }
  positionMs(): number {
    return (this.player?.getCurrentTime() ?? 0) * 1000;
  }
  durationMs(): number {
    return (this.player?.getDuration() ?? 0) * 1000;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  dispose(): void {
    this.player?.destroy();
    this.player = undefined;
    this.playing = false;
  }
}
