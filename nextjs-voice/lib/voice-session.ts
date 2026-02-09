'use client';

/**
 * VoiceSession - Orchestration layer for VoiceCapture + RealtimeKitTransport
 * 
 * =============================================================================
 * CLIENT-ONLY MODULE
 * =============================================================================
 * 
 * This module coordinates the voice capture system. Must run in browser only.
 * 
 * INITIALIZATION ORDER (CRITICAL):
 * 1. RealtimeKitTransport.connect() - SDK acquires microphone, owns MediaStream
 * 2. transport.getMediaStream()     - Get MediaStream from SDK
 * 3. VoiceCapture.startWithMediaStream(stream) - Analyze without owning
 * 
 * DATA FLOW:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  RealtimeKitTransport (OWNS MEDIASTREAM)                                │
 * │    SDK.enableAudio() → getUserMedia → MediaStream                       │
 * │                              │                │                         │
 * │                              ▼                ▼                         │
 * │                         WebRTC/SFU     getMediaStream()                 │
 * │                         (streaming)          │                          │
 * └──────────────────────────────────────────────│──────────────────────────┘
 *                                                │
 *                                                ▼
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  VoiceCapture (ANALYSIS ONLY)                                           │
 * │    startWithMediaStream(stream) → AudioContext → VAD + Pause Detection  │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * =============================================================================
 */

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

/**
 * Create an integrated voice session
 * 
 * @param authToken - From /api/join route
 * @param config - Optional configuration overrides
 * @returns Session controller with start/stop methods
 */
export function createVoiceSession(
  authToken: string,
  config: VoiceSessionConfig = {}
): VoiceSession {
  let voiceCapture: VoiceCapture;
  let transport: RealtimeKitTransport;

  // Create transport (owns MediaStream)
  transport = new RealtimeKitTransport({
    authToken,

    onConnected: (info) => {
      console.log('✓ RealtimeKit connected', info);
      config.onConnected?.(info);
    },

    onDisconnected: ({ reason }) => {
      console.log('✗ Disconnected:', reason);
      // Stop voice capture when transport disconnects
      if (voiceCapture?.isRunning) {
        voiceCapture.stop();
      }
      config.onDisconnected?.({ reason });
    },

    onControlMessage: (message, meta) => {
      console.log('← Control message:', message);
      config.onControlMessage?.(message, meta);
    },

    onError: (error) => {
      console.error('Transport error:', error);
      config.onError?.(error);
    },
  });

  // Create voice capture (receives MediaStream from transport)
  voiceCapture = new VoiceCapture({
    ...config,

    onPauseDetected: async (data) => {
      console.log('═══════════════════════════════════════════');
      console.log('⏸ PAUSE DETECTED');
      console.log('  Segment:', data.segmentCount);
      console.log('  Silence duration:', data.silenceDuration, 'ms');
      console.log('  Noise floor:', data.noiseFloor?.toFixed(4));
      console.log('  Threshold:', data.threshold?.toFixed(4));
      console.log('  Timestamp:', new Date(data.timestamp).toISOString());
      console.log('  Transport connected:', transport.isConnected);
      console.log('═══════════════════════════════════════════');

      // Send control message through RealtimeKit
      if (transport.isConnected) {
        console.log('📤 Sending PAUSE control message...');
        await transport.sendControlMessage({
          type: 'PAUSE',
          segment: data.segmentCount,
          silenceDuration: data.silenceDuration,
          timestamp: data.timestamp,
        });
        console.log('✓ PAUSE message sent');
      } else {
        console.warn('⚠ Cannot send PAUSE: transport not connected');
      }

      config.onPauseDetected?.(data);
    },

    onSpeechStart: async (data) => {
      console.log('───────────────────────────────────────────');
      console.log('🎤 SPEECH STARTED');
      console.log('  Energy:', data.energy?.toFixed(4));
      console.log('  After silence:', data.silenceDuration, 'ms');
      console.log('───────────────────────────────────────────');

      if (transport.isConnected) {
        console.log('📤 Sending SPEECH_START control message...');
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

    /**
     * Start the voice session
     * 
     * Execution order:
     * 1. Transport connects (SDK acquires microphone)
     * 2. Get MediaStream from transport
     * 3. Voice capture starts analyzing the stream
     */
    async start(): Promise<void> {
      // Step 1: Connect transport - SDK acquires microphone
      await transport.connect();
      console.log('✓ Transport connected, audio streaming');

      // Step 2: Get MediaStream from transport
      const mediaStream = transport.getMediaStream();

      if (!mediaStream) {
        throw new Error('Failed to get MediaStream from transport');
      }

      // Step 3: Start voice capture with external stream (analysis only)
      await voiceCapture.startWithMediaStream(mediaStream);
      console.log('✓ Voice capture started (analysis mode)');
    },

    /**
     * Stop the voice session
     */
    async stop(): Promise<void> {
      // Stop analysis first
      if (voiceCapture?.isRunning) {
        voiceCapture.stop();
      }

      // Then disconnect transport (releases microphone)
      await transport.disconnect();

      console.log('✓ Session ended');
    },

    /**
     * Get combined state
     */
    getState(): VoiceSessionState {
      return {
        voiceCapture: voiceCapture?.getState() ?? null,
        transport: transport?.getState() ?? null,
      };
    },
  };
}
