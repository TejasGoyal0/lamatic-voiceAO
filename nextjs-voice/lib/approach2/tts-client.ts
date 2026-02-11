'use client';

export interface TTSClientConfig {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
  voiceId?: string;
}

export class TTSClient {
  private onPlaybackStart: () => void;
  private onPlaybackEnd: () => void;
  private onError: (error: Error) => void;
  private voiceId: string;
  private audioContext: AudioContext | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private nextStartTime = 0;
  private abortController: AbortController | null = null;

  constructor(config: TTSClientConfig = {}) {
    this.onPlaybackStart = config.onPlaybackStart ?? (() => {});
    this.onPlaybackEnd = config.onPlaybackEnd ?? (() => {});
    this.onError = config.onError ?? (() => {});
    this.voiceId = config.voiceId ?? 'EXAVITQu4vr4xnSDxMaL';
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;

    this.stop();

    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext();
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.abortController = new AbortController();

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: this.voiceId }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'TTS failed' }));
        throw new Error(error.error || `TTS failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      this.onPlaybackStart();
      await this.streamAudio(response.body);

    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      console.error('[TTSClient] Error:', error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async streamAudio(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let accumulatedSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          accumulatedSize += value.length;
        }
      }

      const audioData = new Uint8Array(accumulatedSize);
      let offset = 0;
      for (const chunk of chunks) {
        audioData.set(chunk, offset);
        offset += chunk.length;
      }

      if (this.audioContext && !this.abortController?.signal.aborted) {
        const audioBuffer = await this.audioContext.decodeAudioData(audioData.buffer);
        await this.playAudioBuffer(audioBuffer);
      }

    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        throw error;
      }
    }
  }

  private async playAudioBuffer(buffer: AudioBuffer): Promise<void> {
    if (!this.audioContext) return;

    return new Promise((resolve, reject) => {
      try {
        this.isPlaying = true;

        const source = this.audioContext!.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext!.destination);

        source.onended = () => {
          this.isPlaying = false;
          this.currentSource = null;
          this.onPlaybackEnd();
          resolve();
        };

        this.currentSource = source;
        source.start(0);

      } catch (error) {
        this.isPlaying = false;
        reject(error);
      }
    });
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) { /* already stopped */ }
      this.currentSource = null;
    }

    this.isPlaying = false;
    this.audioQueue = [];
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
