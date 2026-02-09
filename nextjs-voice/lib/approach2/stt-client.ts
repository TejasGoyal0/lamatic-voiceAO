'use client';

/**
 * APPROACH 2: STT Client (ElevenLabs via Server)
 * 
 * Speech-to-Text using ElevenLabs API through server-side proxy.
 * Records audio from MediaStream and sends to /api/transcribe endpoint.
 * 
 * Uses ElevenLabs Scribe model for reliable transcription.
 * NO Web Speech API - all transcription via ElevenLabs.
 * 
 * IMPORTANT: WebM files need proper headers, so we accumulate ALL chunks
 * and send the complete blob each time. We track the last transcribed position
 * to avoid re-transcribing already processed audio.
 */

export interface STTClientConfig {
  onPartialTranscript?: (result: TranscriptResult) => void;
  onFinalTranscript?: (result: TranscriptResult) => void;
  onError?: (error: Error) => void;
  transcribeInterval?: number; // How often to send audio for transcription (ms)
}

export interface TranscriptResult {
  text: string;
  confidence?: number;
  isFinal: boolean;
  timestamp: number;
}

export class STTClient {
  // Callbacks
  private onPartialTranscript: (result: TranscriptResult) => void;
  private onFinalTranscript: (result: TranscriptResult) => void;
  private onError: (error: Error) => void;

  // Config
  private transcribeInterval: number;

  // Audio capture
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private isRunning = false;

  // Transcript state
  private lastTranscribedText = '';  // What we already transcribed
  private accumulatedTranscript = ''; // Full transcript so far

  // Interval for periodic transcription
  private transcriptionTimer: ReturnType<typeof setInterval> | null = null;

  // Track last successful size to detect if there's new audio
  private lastTranscribedSize = 0;

  constructor(config: STTClientConfig = {}) {
    this.onPartialTranscript = config.onPartialTranscript ?? (() => {});
    this.onFinalTranscript = config.onFinalTranscript ?? (() => {});
    this.onError = config.onError ?? (() => {});
    this.transcribeInterval = config.transcribeInterval ?? 5000; // Default 5 seconds
  }

  /**
   * Start STT processing with the given MediaStream
   */
  start(mediaStream: MediaStream): void {
    if (this.isRunning) {
      console.warn('[STTClient] Already running');
      return;
    }

    console.log('🎙️ [STTClient] Starting ElevenLabs STT...');
    this.isRunning = true;
    this.accumulatedTranscript = '';
    this.lastTranscribedText = '';
    this.lastTranscribedSize = 0;
    this.audioChunks = [];

    this.initMediaRecorder(mediaStream);
  }

  private initMediaRecorder(mediaStream: MediaStream): void {
    // Determine supported MIME type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    console.log(`📼 [STTClient] Using MIME type: ${mimeType}`);

    this.mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        // ACCUMULATE all chunks - don't clear them!
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('[STTClient] MediaRecorder error:', event);
      this.onError(new Error('MediaRecorder error'));
    };

    // Start recording with timeslice for collecting chunks
    this.mediaRecorder.start(500); // Collect data every 500ms
    console.log('✓ [STTClient] MediaRecorder started');

    // Set up periodic transcription
    this.transcriptionTimer = setInterval(() => {
      this.transcribeCurrentAudio(false);
    }, this.transcribeInterval);
  }

  /**
   * Transcribe accumulated audio - sends ENTIRE blob each time
   * (WebM requires complete file with headers)
   */
  private async transcribeCurrentAudio(isFinal: boolean): Promise<void> {
    if (this.audioChunks.length === 0) {
      console.log('[STTClient] No audio chunks to transcribe');
      return;
    }

    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    
    // Create blob from ALL accumulated chunks (includes header from first chunk)
    const audioBlob = new Blob(this.audioChunks, { type: mimeType });

    // Skip if no new audio since last transcription
    if (audioBlob.size <= this.lastTranscribedSize && !isFinal) {
      console.log('[STTClient] No new audio since last transcription');
      return;
    }

    // Skip small files - they're likely corrupted (missing headers after restart)
    // Need at least ~50KB for valid WebM with enough audio
    if (audioBlob.size < 50000) {
      console.log(`[STTClient] Audio too small (${audioBlob.size} bytes), waiting for more data`);
      return;
    }

    console.log(`📤 [STTClient] Sending ${audioBlob.size} bytes for transcription (final: ${isFinal}, previous: ${this.lastTranscribedSize})`);

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Transcription failed: ${response.status}`);
      }

      const data = await response.json();
      console.log('✓ [STTClient] Transcription result:', data);

      if (data.text) {
        let transcriptText = data.text;

        // NOISE FILTERING:
        // 1. Remove parenthesized noise tags (e.g. "(techno music)", "(clicking)")
        // These are common from ElevenLabs for non-speech sounds.
        const cleanText = transcriptText.replace(/\([^)]+\)/g, '').trim();

        if (!cleanText) {
          console.log('🔇 [STTClient] Filtered out noise-only transcript:', transcriptText);
          return;
        }

        // 2. Minimum length check - if it's just a single letter or non-word symbol, skip
        if (cleanText.length < 3 && !/^[ai0-9]$/i.test(cleanText)) {
          console.log('🔇 [STTClient] Filtered out too short transcript:', cleanText);
          return;
        }

        // The API returns the full transcript of the entire audio
        // So we just use it directly, not append
        this.accumulatedTranscript = cleanText;
        this.lastTranscribedSize = audioBlob.size;
        
        const result: TranscriptResult = {
          text: this.accumulatedTranscript,
          isFinal,
          timestamp: Date.now(),
        };

        if (isFinal) {
          this.onFinalTranscript(result);
        } else {
          this.onPartialTranscript(result);
        }
      }
    } catch (error) {
      console.error('❌ [STTClient] Transcription error:', error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Get the current accumulated transcript
   */
  getTranscript(): string {
    return this.accumulatedTranscript.trim();
  }

  /**
   * Clear the accumulated transcript and audio
   */
  clearTranscript(): void {
    this.accumulatedTranscript = '';
    this.lastTranscribedText = '';
    this.lastTranscribedSize = 0;
    this.audioChunks = [];
  }

  /**
   * Force transcription of current audio (called on pause)
   * After flushing, restarts recording for the next segment
   */
  async flush(): Promise<string> {
    console.log('🔄 [STTClient] Flushing audio for final transcription...');
    
    // Stop the periodic timer
    if (this.transcriptionTimer) {
      clearInterval(this.transcriptionTimer);
      this.transcriptionTimer = null;
    }

    // Stop the recorder to finalize the current segment
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      // Request any remaining data
      this.mediaRecorder.requestData();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Stop recording - this finalizes the WebM file
      this.mediaRecorder.stop();
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Transcribe everything
    await this.transcribeCurrentAudio(true);
    
    const transcript = this.accumulatedTranscript;
    
    // Clear for next segment
    this.clearTranscript();
    
    // Restart recording for the next segment (with fresh WebM headers)
    if (this.mediaRecorder && this.isRunning) {
      const stream = this.mediaRecorder.stream;
      this.restartRecording(stream);
    }
    
    return transcript;
  }

  /**
   * Restart MediaRecorder with a fresh stream (new WebM headers)
   */
  private restartRecording(stream: MediaStream): void {
    console.log('🔄 [STTClient] Restarting recorder for next segment...');
    
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    this.mediaRecorder = new MediaRecorder(stream, { mimeType });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('[STTClient] MediaRecorder error:', event);
      this.onError(new Error('MediaRecorder error'));
    };

    this.mediaRecorder.start(500);
    console.log('✓ [STTClient] Recorder restarted');

    // Restart periodic transcription
    this.transcriptionTimer = setInterval(() => {
      this.transcribeCurrentAudio(false);
    }, this.transcribeInterval);
  }

  /**
   * Stop STT processing
   */
  stop(): void {
    console.log('⏹ [STTClient] Stopping...');
    this.isRunning = false;

    if (this.transcriptionTimer) {
      clearInterval(this.transcriptionTimer);
      this.transcriptionTimer = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
    this.audioChunks = [];

    console.log('✓ [STTClient] Stopped');
  }
}
