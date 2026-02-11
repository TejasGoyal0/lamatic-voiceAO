'use client';

import { VoiceCapture, VoiceCaptureConfig, VoiceCaptureStateInfo } from './voice-capture';

export interface LocalSessionConfig extends Omit<VoiceCaptureConfig, 'onPauseDetected' | 'onSpeechStart'> {
  onPauseDetected?: (data: any) => void;
  onSpeechStart?: (data: any) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: Error) => void;
}

export interface LocalSession {
  voiceCapture: VoiceCapture;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getState: () => { voiceCapture: VoiceCaptureStateInfo | null };
}

export function createLocalVoiceSession(config: LocalSessionConfig = {}): LocalSession {
  let voiceCapture: VoiceCapture;
  let mediaStream: MediaStream | null = null;

  voiceCapture = new VoiceCapture({
    ...config,
    onPauseDetected: (data) => { config.onPauseDetected?.(data); },
    onSpeechStart: (data) => { config.onSpeechStart?.(data); },
  });

  return {
    voiceCapture,

    async start(): Promise<void> {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        await voiceCapture.startWithMediaStream(mediaStream);
        config.onConnected?.();
      } catch (error) {
        config.onError?.(error as Error);
        throw error;
      }
    },

    async stop(): Promise<void> {
      if (voiceCapture?.isRunning) voiceCapture.stop();
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }
      config.onDisconnected?.();
    },

    getState() {
      return { voiceCapture: voiceCapture?.getState() ?? null };
    },
  };
}
