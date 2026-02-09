'use client';

/**
 * VoiceSessionLocal - Standalone voice capture without Cloudflare transport
 * 
 * Use this for testing VAD and pause detection locally without needing
 * Cloudflare RealtimeKit credentials.
 */

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

/**
 * Create a local-only voice session (no Cloudflare transport)
 */
export function createLocalVoiceSession(config: LocalSessionConfig = {}): LocalSession {
  let voiceCapture: VoiceCapture;
  let mediaStream: MediaStream | null = null;

  voiceCapture = new VoiceCapture({
    ...config,

    onPauseDetected: (data) => {
      console.log(`⏸ Pause detected: segment ${data.segmentCount}`);
      config.onPauseDetected?.(data);
    },

    onSpeechStart: (data) => {
      console.log('🎤 Speech started');
      config.onSpeechStart?.(data);
    },
  });

  return {
    voiceCapture,

    async start(): Promise<void> {
      try {
        // Acquire microphone directly
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        // Start voice capture with the stream
        await voiceCapture.startWithMediaStream(mediaStream);
        
        console.log('✓ Local voice capture started');
        config.onConnected?.();
      } catch (error) {
        config.onError?.(error as Error);
        throw error;
      }
    },

    async stop(): Promise<void> {
      // Stop voice capture
      if (voiceCapture?.isRunning) {
        voiceCapture.stop();
      }

      // Release microphone
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }

      console.log('✓ Local session ended');
      config.onDisconnected?.();
    },

    getState() {
      return {
        voiceCapture: voiceCapture?.getState() ?? null,
      };
    },
  };
}
