'use client';

/**
 * APPROACH 2: TTS Client (ElevenLabs Streaming)
 * 
 * Text-to-Speech using ElevenLabs API with streaming playback.
 * Receives text, sends to /api/tts, streams audio chunks to speaker.
 */

export interface TTSClientConfig {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
  voiceId?: string;
}

export class TTSClient {
  // Callbacks
  private onPlaybackStart: () => void;
  private onPlaybackEnd: () => void;
  private onError: (error: Error) => void;

  // Config
  private voiceId: string;

  // Audio playback
  private audioContext: AudioContext | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private nextStartTime = 0;

  // Abort controller for cancellation
  private abortController: AbortController | null = null;

  constructor(config: TTSClientConfig = {}) {
    this.onPlaybackStart = config.onPlaybackStart ?? (() => {});
    this.onPlaybackEnd = config.onPlaybackEnd ?? (() => {});
    this.onError = config.onError ?? (() => {});
    this.voiceId = config.voiceId ?? 'EXAVITQu4vr4xnSDxMaL'; // Default: Bella
  }

  /**
   * Speak text using ElevenLabs TTS with streaming playback
   */
  async speak(text: string): Promise<void> {
    if (!text.trim()) {
      console.warn('[TTSClient] Empty text, skipping');
      return;
    }

    console.log(`🔊 [TTSClient] Speaking: "${text.substring(0, 50)}..."`);

    // Cancel any ongoing playback
    this.stop();

    // Initialize audio context
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext();
    }

    // Resume if suspended (browser autoplay policy)
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

      console.log('✓ [TTSClient] Receiving audio stream...');
      this.onPlaybackStart();

      // Stream and play audio chunks
      await this.streamAudio(response.body);

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('⏹ [TTSClient] Playback aborted');
        return;
      }
      console.error('❌ [TTSClient] TTS error:', error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Stream audio from response body and play in real-time
   */
  private async streamAudio(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    try {
      // Read all chunks first (ElevenLabs sends complete audio)
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        if (value) {
          chunks.push(value);
          totalLength += value.length;
        }
      }

      // Combine all chunks
      const audioData = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audioData.set(chunk, offset);
        offset += chunk.length;
      }

      console.log(`✓ [TTSClient] Received ${totalLength} bytes of audio`);

      // Decode and play
      if (this.audioContext) {
        const audioBuffer = await this.audioContext.decodeAudioData(audioData.buffer);
        await this.playAudioBuffer(audioBuffer);
      }

    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        throw error;
      }
    }
  }

  /**
   * Play an AudioBuffer through the speakers
   */
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
          console.log('✓ [TTSClient] Playback complete');
          this.onPlaybackEnd();
          resolve();
        };

        this.currentSource = source;
        source.start(0);
        
        console.log(`▶️ [TTSClient] Playing audio (${buffer.duration.toFixed(2)}s)`);

      } catch (error) {
        this.isPlaying = false;
        reject(error);
      }
    });
  }

  /**
   * Stop any ongoing playback
   */
  stop(): void {
    console.log('⏹ [TTSClient] Stopping...');

    // Abort ongoing fetch
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Stop current audio source
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (e) {
        // Ignore - may already be stopped
      }
      this.currentSource = null;
    }

    this.isPlaying = false;
    this.audioQueue = [];
  }

  /**
   * Check if currently playing
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    this.stop();
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
