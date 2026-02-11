'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeKitClient, RealtimeKitState } from '../../lib/approach2/realtimekit-client';
import { STTClient, TranscriptResult } from '../../lib/approach2/stt-client';
import { LamaticClient, LamaticResponse } from '../../lib/approach2/lamatic-client';
import { TTSClient } from '../../lib/approach2/tts-client';

interface VoiceClientState {
  status: 'idle' | 'connecting' | 'listening' | 'processing' | 'playing' | 'error';
  error: string | null;
  energy: number;
  isSpeaking: boolean;
  partialTranscript: string | null;
  finalTranscript: string | null;
  aiResponse: string | null;
  segmentCount: number;
}

export default function VoiceClient() {
  const [state, setState] = useState<VoiceClientState>({
    status: 'idle',
    error: null,
    energy: 0,
    isSpeaking: false,
    partialTranscript: null,
    finalTranscript: null,
    aiResponse: null,
    segmentCount: 0,
  });

  const realtimeKitRef = useRef<RealtimeKitClient | null>(null);
  const sttClientRef = useRef<STTClient | null>(null);
  const lamaticClientRef = useRef<LamaticClient | null>(null);
  const ttsClientRef = useRef<TTSClient | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => { cleanup(); };
  }, []);

  const cleanup = async () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (sttClientRef.current) {
      sttClientRef.current.stop();
      sttClientRef.current = null;
    }
    if (ttsClientRef.current) {
      await ttsClientRef.current.dispose();
      ttsClientRef.current = null;
    }
    if (realtimeKitRef.current) {
      await realtimeKitRef.current.disconnect();
      realtimeKitRef.current = null;
    }
  };

  const startStatePolling = useCallback(() => {
    const poll = () => {
      if (realtimeKitRef.current) {
        const rtkState = realtimeKitRef.current.getState();
        setState(prev => ({
          ...prev,
          energy: rtkState.currentEnergy,
          isSpeaking: rtkState.isSpeaking,
          segmentCount: rtkState.segmentCount,
        }));
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

      const response = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: `user-${Date.now()}` }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to get auth token');
      }

      const { token } = await response.json();

      ttsClientRef.current = new TTSClient({
        onPlaybackStart: () => {
          setState(prev => ({ ...prev, status: 'playing' }));
        },
        onPlaybackEnd: () => {
          setState(prev => ({ ...prev, status: 'listening' }));
          startStatePolling();
        },
        onError: () => {
          setState(prev => ({ ...prev, status: 'listening' }));
          startStatePolling();
        },
      });

      lamaticClientRef.current = new LamaticClient({
        onResponse: handleLamaticResponse,
        onError: handleLamaticError,
      });

      sttClientRef.current = new STTClient({
        onPartialTranscript: (result) => {
          setState(prev => ({ ...prev, partialTranscript: result.text }));
        },
        onFinalTranscript: async (result) => {
          setState(prev => ({
            ...prev,
            finalTranscript: result.text,
            partialTranscript: null,
          }));
        },
        onError: (error) => {
          console.error('[STTClient] Error:', error);
        },
      });

      realtimeKitRef.current = new RealtimeKitClient({
        authToken: token,
        pauseDuration: 3000,
        calibrationDuration: 500,

        onConnected: () => {
          setState(prev => ({ ...prev, status: 'listening' }));
          const stream = realtimeKitRef.current?.getMediaStream();
          if (stream && sttClientRef.current) {
            sttClientRef.current.start(stream);
          }
        },

        onDisconnected: () => {
          setState(prev => ({ ...prev, status: 'idle' }));
          stopStatePolling();
        },

        onPauseDetected: async (data) => {
          setState(prev => ({ ...prev, status: 'processing' }));
          stopStatePolling();

          let transcript = '';
          if (sttClientRef.current) {
            transcript = await sttClientRef.current.flush();
            setState(prev => ({
              ...prev,
              finalTranscript: transcript,
              partialTranscript: null,
            }));
          }

          if (transcript && lamaticClientRef.current) {
            await lamaticClientRef.current.sendTranscript(transcript, data);
          } else {
            setState(prev => ({ ...prev, status: 'listening' }));
            startStatePolling();
          }
        },

        onSpeechStart: () => {
          setState(prev => ({ ...prev, status: 'listening', isSpeaking: true }));
        },

        onError: (error) => {
          console.error('[RealtimeKit] Error:', error);
          setState(prev => ({
            ...prev,
            status: 'error',
            error: error.message,
          }));
          stopStatePolling();
        },
      });

      await realtimeKitRef.current.connect();
      startStatePolling();

    } catch (error) {
      console.error('[VoiceClient] Start error:', error);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };

  const handleLamaticResponse = async (response: LamaticResponse) => {
    if (response.success && response.text) {
      const aiText = response.text;
      setState(prev => ({ ...prev, aiResponse: aiText }));

      if (ttsClientRef.current) {
        setState(prev => ({ ...prev, status: 'playing' }));
        stopStatePolling();
        await ttsClientRef.current.speak(aiText);
      } else {
        setState(prev => ({ ...prev, status: 'listening' }));
        startStatePolling();
      }
    } else {
      setState(prev => ({ ...prev, status: 'listening' }));
      startStatePolling();
    }
  };

  const handleLamaticError = (error: Error) => {
    console.error('[VoiceClient] Lamatic error:', error);
    setState(prev => ({ ...prev, status: 'listening' }));
    startStatePolling();
  };

  const handleStop = async () => {
    stopStatePolling();
    if (ttsClientRef.current) {
      ttsClientRef.current.stop();
    }
    await cleanup();

    setState({
      status: 'idle',
      error: null,
      energy: 0,
      isSpeaking: false,
      partialTranscript: null,
      finalTranscript: null,
      aiResponse: null,
      segmentCount: 0,
    });
  };

  const isActive = ['connecting', 'listening', 'processing', 'playing'].includes(state.status);

  const getEnergyBarColor = () => {
    if (state.status === 'processing') return 'bg-yellow-500';
    if (state.status === 'playing') return 'bg-purple-500';
    if (state.isSpeaking) return 'bg-green-500';
    return 'bg-blue-500';
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-8">
      <div className="flex justify-center mb-6">
        <span className={`px-4 py-2 rounded-full text-sm font-medium ${
          state.status === 'idle' ? 'bg-gray-100 text-gray-600' :
          state.status === 'connecting' ? 'bg-yellow-100 text-yellow-700' :
          state.status === 'listening' ? 'bg-green-100 text-green-700' :
          state.status === 'processing' ? 'bg-blue-100 text-blue-700' :
          state.status === 'playing' ? 'bg-purple-100 text-purple-700' :
          'bg-red-100 text-red-700'
        }`}>
          {state.status === 'idle' && 'Ready'}
          {state.status === 'connecting' && 'Connecting to Cloudflare...'}
          {state.status === 'listening' && (state.isSpeaking ? 'Listening...' : 'Waiting for speech...')}
          {state.status === 'processing' && 'Processing...'}
          {state.status === 'playing' && 'Playing response...'}
          {state.status === 'error' && 'Error'}
        </span>
      </div>

      {state.segmentCount > 0 && (
        <div className="text-center mb-4 text-sm text-gray-500">
          Segments: {state.segmentCount}
        </div>
      )}

      <div className="mb-6">
        <div className="flex justify-between text-sm text-gray-500 mb-2">
          <span>Audio Level</span>
          <span>{(state.energy * 100).toFixed(1)}%</span>
        </div>
        <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-75 ${getEnergyBarColor()}`}
            style={{ width: `${Math.min(state.energy * 100, 100)}%` }}
          />
        </div>
      </div>

      {(state.partialTranscript || state.finalTranscript) && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-500 mb-1">
            {state.partialTranscript ? 'Transcribing...' : 'You said:'}
          </div>
          <div className={`text-gray-800 ${state.partialTranscript ? 'italic' : ''}`}>
            {state.partialTranscript || state.finalTranscript}
          </div>
        </div>
      )}

      {state.aiResponse && (
        <div className="mb-4 p-4 bg-purple-50 rounded-lg">
          <div className="text-xs text-purple-500 mb-1">AI Response:</div>
          <div className="text-purple-800">{state.aiResponse}</div>
        </div>
      )}

      {state.error && (
        <div className="mb-4 p-4 bg-red-50 rounded-lg text-red-700">
          {state.error}
        </div>
      )}

      <div className="flex justify-center gap-4">
        {!isActive ? (
          <button
            onClick={handleStart}
            className="px-8 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 transition-colors"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-8 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
          >
            Stop
          </button>
        )}
      </div>

      <div className="mt-8 pt-6 border-t text-xs text-gray-400 text-center">
        <p>Approach 2: RealtimeKit + ElevenLabs STT + Lamatic LLM + TTS</p>
      </div>
    </div>
  );
}
