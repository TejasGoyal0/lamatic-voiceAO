'use client';

/**
 * VoiceUILocal - Local-only Voice Capture (no Cloudflare)
 * 
 * Use this component to test VAD and pause detection without
 * needing Cloudflare RealtimeKit credentials.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createLocalVoiceSession, LocalSession } from '../lib/voice-session-local';

interface VoiceUIState {
  status: 'idle' | 'connecting' | 'listening' | 'speaking' | 'paused' | 'error';
  error: string | null;
  energy: number;
  noiseFloor: number;
  segmentCount: number;
  isCalibrating: boolean;
}

export default function VoiceUILocal() {
  const [state, setState] = useState<VoiceUIState>({
    status: 'idle',
    energy: 0,
    noiseFloor: 0,
    segmentCount: 0,
    isCalibrating: false,
    error: null,
  });

  const sessionRef = useRef<LocalSession | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (sessionRef.current) {
        sessionRef.current.stop().catch(console.error);
      }
    };
  }, []);

  // Poll session state for visualization
  const startStatePolling = useCallback(() => {
    const poll = () => {
      if (sessionRef.current) {
        const sessionState = sessionRef.current.getState();
        const vcState = sessionState.voiceCapture;

        if (vcState) {
          setState(prev => ({
            ...prev,
            energy: vcState.currentEnergy,
            noiseFloor: vcState.noiseFloor,
            isCalibrating: vcState.isCalibrating,
            segmentCount: vcState.segmentCount,
            status: vcState.isSpeaking ? 'speaking' : 'listening',
          }));
        }
      }
      animationFrameRef.current = requestAnimationFrame(poll);
    };
    poll();
  }, []);

  const stopStatePolling = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const handleStart = async () => {
    try {
      setState(prev => ({ ...prev, status: 'connecting', error: null }));

      const session = createLocalVoiceSession({
        pauseDuration: 3000, // 3 seconds
        calibrationDuration: 500,

        onPauseDetected: (data) => {
          console.log('⏸ Pause detected:', data);
          setState(prev => ({
            ...prev,
            status: 'paused',
            segmentCount: data.segmentCount,
          }));
        },

        onSpeechStart: () => {
          setState(prev => ({ ...prev, status: 'speaking' }));
        },

        onConnected: () => {
          setState(prev => ({ ...prev, status: 'listening' }));
        },

        onDisconnected: () => {
          setState(prev => ({ ...prev, status: 'idle' }));
          stopStatePolling();
        },

        onError: (error) => {
          setState(prev => ({
            ...prev,
            status: 'error',
            error: error.message,
          }));
          stopStatePolling();
        },
      });

      sessionRef.current = session;
      await session.start();
      startStatePolling();

    } catch (error) {
      console.error('Start error:', error);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };

  const handleStop = async () => {
    stopStatePolling();

    if (sessionRef.current) {
      await sessionRef.current.stop();
      sessionRef.current = null;
    }

    setState({
      status: 'idle',
      energy: 0,
      noiseFloor: 0,
      segmentCount: 0,
      isCalibrating: false,
      error: null,
    });
  };

  const isActive = ['connecting', 'listening', 'speaking', 'paused'].includes(state.status);

  // Energy bar percentage (clamped 0-100)
  const energyPercent = Math.min(100, Math.max(0, state.energy * 500));
  const noiseFloorPercent = Math.min(100, Math.max(0, state.noiseFloor * 500));

  return (
    <div className="flex flex-col items-center gap-6 p-8 max-w-md mx-auto">
      <h1 className="text-2xl font-bold">Voice Capture</h1>
      <p className="text-sm text-yellow-600 bg-yellow-50 px-3 py-1 rounded">
        Local Mode (no Cloudflare)
      </p>

      {/* Status Indicator */}
      <div className="flex items-center gap-3">
        <div
          className={`w-4 h-4 rounded-full ${
            state.status === 'idle' ? 'bg-gray-400' :
            state.status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
            state.status === 'listening' ? 'bg-green-400' :
            state.status === 'speaking' ? 'bg-blue-500 animate-pulse' :
            state.status === 'paused' ? 'bg-orange-400' :
            'bg-red-500'
          }`}
        />
        <span className="text-lg capitalize">
          {state.isCalibrating ? 'Calibrating...' : state.status}
        </span>
      </div>

      {/* Energy Meter */}
      <div className="w-full space-y-2">
        <div className="flex justify-between text-sm text-gray-600">
          <span>Energy Level</span>
          <span>{(state.energy * 100).toFixed(1)}%</span>
        </div>
        <div className="relative h-6 bg-gray-200 rounded-full overflow-hidden">
          {/* Noise floor indicator */}
          <div
            className="absolute h-full bg-gray-400 opacity-50 transition-all duration-100"
            style={{ width: `${noiseFloorPercent}%` }}
          />
          {/* Energy bar */}
          <div
            className={`absolute h-full transition-all duration-75 ${
              state.status === 'speaking' ? 'bg-blue-500' : 'bg-green-500'
            }`}
            style={{ width: `${energyPercent}%` }}
          />
          {/* Threshold marker */}
          <div
            className="absolute h-full w-0.5 bg-red-500"
            style={{ left: `${noiseFloorPercent * 1.3}%` }}
            title="Speech threshold"
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500">
          <span>Noise floor: {(state.noiseFloor * 100).toFixed(2)}%</span>
          <span>Segments: {state.segmentCount}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-4">
        {!isActive ? (
          <button
            onClick={handleStart}
            className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-6 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
          >
            Stop Recording
          </button>
        )}
      </div>

      {/* Error Display */}
      {state.error && (
        <div className="w-full p-4 bg-red-100 border border-red-300 rounded-lg text-red-700">
          <strong>Error:</strong> {state.error}
        </div>
      )}

      {/* Instructions */}
      <div className="text-sm text-gray-500 text-center space-y-1">
        <p>Click Start to begin voice capture.</p>
        <p>VAD detects speech vs silence locally.</p>
        <p>3-second pauses trigger segment boundaries.</p>
      </div>
    </div>
  );
}
