'use client';

import { VoiceCapture, VoiceCaptureConfig, VoiceCaptureStateInfo } from './voice-capture';
import { RealtimeKitTransport, TransportState, ControlMessage } from './realtimekit-transport';

export interface VoiceSessionConfig extends Omit<VoiceCaptureConfig, 'onPauseDetected' | 'onSpeechStart'> {
  onPauseDetected?: (data: any) => void;
  onSpeechStart?: (data: any) => void;
  onConnected?: (info: any) => void;
  onDisconnected?: (info: any) => void;
  onControlMessage?: (message: ControlMessage, meta: any) => void;
  onError?: (error: Error) => void;
}

export interface VoiceSessionState {
  voiceCapture: VoiceCaptureStateInfo | null;
  transport: TransportState | null;
}

export interface VoiceSession {
  voiceCapture: VoiceCapture;
  transport: RealtimeKitTransport;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getState: () => VoiceSessionState;
}

export function createVoiceSession(
  authToken: string,
  config: VoiceSessionConfig = {}
): VoiceSession {
  let voiceCapture: VoiceCapture;
  let transport: RealtimeKitTransport;

  transport = new RealtimeKitTransport({
    authToken,
    onConnected: (info) => { config.onConnected?.(info); },
    onDisconnected: ({ reason }) => {
      if (voiceCapture?.isRunning) voiceCapture.stop();
      config.onDisconnected?.({ reason });
    },
    onControlMessage: (message, meta) => { config.onControlMessage?.(message, meta); },
    onError: (error) => { config.onError?.(error); },
  });

  voiceCapture = new VoiceCapture({
    ...config,

    onPauseDetected: async (data) => {
      if (transport.isConnected) {
        await transport.sendControlMessage({
          type: 'PAUSE',
          segment: data.segmentCount,
          silenceDuration: data.silenceDuration,
          timestamp: data.timestamp,
        });
      }
      config.onPauseDetected?.(data);
    },

    onSpeechStart: async (data) => {
      if (transport.isConnected) {
        await transport.sendControlMessage({
          type: 'SPEECH_START',
          timestamp: data.timestamp,
        });
      }
      config.onSpeechStart?.(data);
    },
  });

  return {
    voiceCapture,
    transport,

    async start(): Promise<void> {
      await transport.connect();
      const mediaStream = transport.getMediaStream();
      if (!mediaStream) throw new Error('Failed to get MediaStream from transport');
      await voiceCapture.startWithMediaStream(mediaStream);
    },

    async stop(): Promise<void> {
      if (voiceCapture?.isRunning) voiceCapture.stop();
      await transport.disconnect();
    },

    getState(): VoiceSessionState {
      return {
        voiceCapture: voiceCapture?.getState() ?? null,
        transport: transport?.getState() ?? null,
      };
    },
  };
}
