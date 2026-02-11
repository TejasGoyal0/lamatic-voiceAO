'use client';

export interface STTClientConfig {
  onPartialTranscript?: (result: TranscriptResult) => void;
  onFinalTranscript?: (result: TranscriptResult) => void;
  onError?: (error: Error) => void;
  transcribeInterval?: number;
}

export interface TranscriptResult {
  text: string;
  confidence?: number;
  isFinal: boolean;
  timestamp: number;
}

export class STTClient {
  private onPartialTranscript: (result: TranscriptResult) => void;
  private onFinalTranscript: (result: TranscriptResult) => void;
  private onError: (error: Error) => void;
  private transcribeInterval: number;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private isRunning = false;
  private lastTranscribedText = '';
  private accumulatedTranscript = '';
  private transcriptionTimer: ReturnType<typeof setInterval> | null = null;
  private lastTranscribedSize = 0;

  constructor(config: STTClientConfig = {}) {
    this.onPartialTranscript = config.onPartialTranscript ?? (() => {});
    this.onFinalTranscript = config.onFinalTranscript ?? (() => {});
    this.onError = config.onError ?? (() => {});
    this.transcribeInterval = config.transcribeInterval ?? 5000;
  }

  start(mediaStream: MediaStream): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.accumulatedTranscript = '';
    this.lastTranscribedText = '';
    this.lastTranscribedSize = 0;
    this.audioChunks = [];
    this.initMediaRecorder(mediaStream);
  }

  private initMediaRecorder(mediaStream: MediaStream): void {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    this.mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

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

    this.transcriptionTimer = setInterval(() => {
      this.transcribeCurrentAudio(false);
    }, this.transcribeInterval);
  }

  private async transcribeCurrentAudio(isFinal: boolean): Promise<void> {
    if (this.audioChunks.length === 0) return;

    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const audioBlob = new Blob(this.audioChunks, { type: mimeType });

    if (audioBlob.size <= this.lastTranscribedSize && !isFinal) return;
    if (audioBlob.size < 50000) return;

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

      if (data.text) {
        const cleanText = data.text.replace(/\([^)]+\)/g, '').trim();
        if (!cleanText) return;
        if (cleanText.length < 3 && !/^[ai0-9]$/i.test(cleanText)) return;

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
      console.error('[STTClient] Transcription error:', error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  getTranscript(): string {
    return this.accumulatedTranscript.trim();
  }

  clearTranscript(): void {
    this.accumulatedTranscript = '';
    this.lastTranscribedText = '';
    this.lastTranscribedSize = 0;
    this.audioChunks = [];
  }

  async flush(): Promise<string> {
    if (this.transcriptionTimer) {
      clearInterval(this.transcriptionTimer);
      this.transcriptionTimer = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.requestData();
      await new Promise(resolve => setTimeout(resolve, 100));
      this.mediaRecorder.stop();
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await this.transcribeCurrentAudio(true);
    const transcript = this.accumulatedTranscript;
    this.clearTranscript();

    if (this.mediaRecorder && this.isRunning) {
      const stream = this.mediaRecorder.stream;
      this.restartRecording(stream);
    }

    return transcript;
  }

  private restartRecording(stream: MediaStream): void {
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

    this.transcriptionTimer = setInterval(() => {
      this.transcribeCurrentAudio(false);
    }, this.transcribeInterval);
  }

  stop(): void {
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
  }
}
