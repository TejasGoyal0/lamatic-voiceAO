'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioCapture, AudioCaptureState } from '../../lib/approach1/audio-capture';
import { LamaticClient, LamaticResponse } from '../../lib/approach1/lamatic-client';

interface VoiceClientState {
  status: 'idle' | 'connecting' | 'listening' | 'processing' | 'playing' | 'error';
  error: string | null;
  energy: number;
  isSpeaking: boolean;
  transcript: string | null;
  aiResponse: string | null;
  latency?: {
    total: number;
    apiParams?: {
      clientStart: number;
      apiResponse: number;
      totalRoundTrip: number;
    };
  };
}

export default function VoiceClient() {
  const [state, setState] = useState<VoiceClientState>({
    status: 'idle',
    error: null,
    energy: 0,
    isSpeaking: false,
    transcript: null,
    aiResponse: null,
  });

  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const lamaticClientRef = useRef<LamaticClient | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const interactionStartTimeRef = useRef<number>(0);

  useEffect(() => {
    return () => { cleanup(); };
  }, []);

  const cleanup = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioCaptureRef.current) {
      audioCaptureRef.current.stop();
      audioCaptureRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
    }
  };

  const startStatePolling = useCallback(() => {
    const poll = () => {
      if (audioCaptureRef.current) {
        const captureState = audioCaptureRef.current.getState();
        setState(prev => ({
          ...prev,
          energy: captureState.currentEnergy,
          isSpeaking: captureState.isSpeaking,
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

      lamaticClientRef.current = new LamaticClient({
        onResponse: handleLamaticResponse,
        onError: handleLamaticError,
      });

      audioCaptureRef.current = new AudioCapture({
        pauseDuration: 1200,
        calibrationDuration: 1000,

        onPauseDetected: async (audioBlob) => {
          interactionStartTimeRef.current = performance.now();
          setState(prev => ({ ...prev, status: 'processing' }));
          stopStatePolling();

          if (lamaticClientRef.current && audioBlob) {
            await lamaticClientRef.current.sendAudio(audioBlob);
          }
        },

        onSpeechStart: () => {
          interactionStartTimeRef.current = 0;

          if (audioElementRef.current) {
            audioElementRef.current.pause();
            audioElementRef.current.currentTime = 0;
          }
          if (lamaticClientRef.current) {
            lamaticClientRef.current.cancelCurrentRequest();
          }
          setState(prev => ({ ...prev, status: 'listening', isSpeaking: true }));
        },

        onError: (error: Error) => {
          console.error('[AudioCapture] Error:', error);
          setState(prev => ({
            ...prev,
            status: 'error',
            error: error.message,
          }));
          stopStatePolling();
        },
      });

      await audioCaptureRef.current.start();
      setState(prev => ({ ...prev, status: 'listening' }));
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
    let latencyInfo = undefined;
    if (response.timings) {
      const playbackStart = performance.now();
      latencyInfo = {
        total: playbackStart - response.timings.clientStart,
        apiParams: response.timings,
      };
    }

    const responseText = response.text || '';

    setState(prev => ({
      ...prev,
      transcript: response.transcript || prev.transcript,
      aiResponse: responseText || prev.aiResponse,
      latency: latencyInfo,
    }));

    if (response.audio) {
      setState(prev => ({ ...prev, status: 'playing' }));
      await playAudio(response.audio).catch((err: Error) => {
        console.error('[VoiceClient] Audio playback failed:', err);
      });
    } else if (responseText) {
      setState(prev => ({ ...prev, status: 'playing' }));
      try {
        const ttsResponse = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: responseText,
            voiceId: '21m00Tcm4TlvDq8ikWAM',
          }),
        });

        if (ttsResponse.ok) {
          const audioBlob = await ttsResponse.blob();
          const audioUrl = URL.createObjectURL(audioBlob);
          await playAudio(audioUrl);
        }
      } catch (err) {
        console.error('[VoiceClient] TTS error:', err);
      }
    }

    setState(prev => ({ ...prev, status: 'listening' }));
    startStatePolling();
  };

  const handleLamaticError = (error: Error) => {
    console.error('[VoiceClient] Lamatic error:', error);
    setState(prev => ({
      ...prev,
      status: 'error',
      error: error.message,
    }));
  };

  const playAudio = async (audioSource: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!audioElementRef.current) {
        audioElementRef.current = new Audio();
      }

      const audio = audioElementRef.current;
      let url = audioSource;

      if (!audioSource.startsWith('data:') && !audioSource.startsWith('http') && !audioSource.startsWith('blob:')) {
        try {
          const binaryString = window.atob(audioSource);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          url = URL.createObjectURL(blob);
        } catch (e) {
          console.error('[VoiceClient] Base64 decode failed:', e);
          reject(new Error('Invalid audio data'));
          return;
        }
      }

      audio.src = url;

      audio.onended = () => {
        if (url !== audioSource) URL.revokeObjectURL(url);
        resolve();
      };

      audio.onerror = () => {
        if (url !== audioSource) URL.revokeObjectURL(url);
        reject(new Error('Audio playback failed'));
      };

      audio.play().catch((err: Error) => {
        if (url !== audioSource) URL.revokeObjectURL(url);
        reject(err);
      });
    });
  };

  const handleStop = async () => {
    stopStatePolling();
    cleanup();

    setState({
      status: 'idle',
      error: null,
      energy: 0,
      isSpeaking: false,
      transcript: null,
      aiResponse: null,
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
          {state.status === 'connecting' && 'Connecting...'}
          {state.status === 'listening' && (state.isSpeaking ? 'Listening...' : 'Waiting for speech...')}
          {state.status === 'processing' && 'Processing...'}
          {state.status === 'playing' && 'Playing response...'}
          {state.status === 'error' && 'Error'}
        </span>
      </div>

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

      {state.transcript && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-500 mb-1">You said:</div>
          <div className="text-gray-800">{state.transcript}</div>
        </div>
      )}

      {state.aiResponse && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg">
          <div className="text-xs text-blue-500 mb-1">AI Response:</div>
          <div className="text-blue-800">{state.aiResponse}</div>
        </div>
      )}

      {state.latency && (
        <div className="mb-4 p-3 bg-green-50 rounded-lg text-xs font-mono">
          <div className="text-green-800 font-bold mb-1">Latency Breakdown</div>
          <div className="grid grid-cols-2 gap-2 text-green-700">
            <div>E2E Total:</div>
            <div className="text-right">{state.latency.total.toFixed(0)} ms</div>

            {state.latency.apiParams && (
              <>
                <div className="opacity-75 pl-2">API Roundtrip:</div>
                <div className="text-right opacity-75">{state.latency.apiParams.totalRoundTrip.toFixed(0)} ms</div>
                <div className="opacity-75 pl-2">Client/Network:</div>
                <div className="text-right opacity-75">
                  {(state.latency.total - state.latency.apiParams.totalRoundTrip).toFixed(0)} ms
                </div>
              </>
            )}
          </div>
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
            className="px-8 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
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
        <p>Approach 1: getUserMedia → Lamatic (STT + LLM + TTS) → Audio Playback</p>
      </div>
    </div>
  );
}
