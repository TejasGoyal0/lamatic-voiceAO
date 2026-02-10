'use client';

/**
 * APPROACH 1: VoiceClient Component
 * 
 * Transport: Direct getUserMedia (NO Cloudflare RealtimeKit)
 * STT: Lamatic (ElevenLabs)
 * LLM: Lamatic
 * TTS: Lamatic (ElevenLabs) → Audio response played in browser
 */

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
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

  // Poll audio capture state for visualization
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
      console.log('🎤 [Approach 1] Starting voice capture...');

      // Initialize Lamatic client
      lamaticClientRef.current = new LamaticClient({
        onResponse: handleLamaticResponse,
        onError: handleLamaticError,
      });

      // Initialize audio capture with VAD
      audioCaptureRef.current = new AudioCapture({
        pauseDuration: 1200, // Reduced from 3000ms for responsiveness
        calibrationDuration: 1000,
        
        onPauseDetected: async (audioBlob) => {
          console.log('⏸ [Approach 1] Pause detected, sending audio to Lamatic...');
          setState(prev => ({ ...prev, status: 'processing' }));
          
          // Stop polling while processing
          stopStatePolling();
          
          // Send audio to Lamatic
          if (lamaticClientRef.current && audioBlob) {
            await lamaticClientRef.current.sendAudio(audioBlob);
          }
        },

        onSpeechStart: () => {
          console.log('🎤 [Approach 1] Speech started - interrupting AI if playing');
          // BARGE-IN: Stop AI from speaking immediately when user interrupts
          if (audioElementRef.current) {
            audioElementRef.current.pause();
            audioElementRef.current.currentTime = 0;
          }
          setState(prev => ({ ...prev, status: 'listening', isSpeaking: true }));
        },

        onError: (error) => {
          console.error('❌ [Approach 1] Audio capture error:', error);
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
      console.log('✓ [Approach 1] Voice capture started');

    } catch (error) {
      console.error('❌ [Approach 1] Start error:', error);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };

  const handleLamaticResponse = async (response: LamaticResponse) => {
    console.log('📥 [Approach 1] Lamatic response:', response);
    
    const responseText = response.text || '';

    setState(prev => ({
      ...prev,
      transcript: response.transcript || prev.transcript,
      aiResponse: responseText || prev.aiResponse,
    }));

    // If we got audio directly from Lamatic (Workflow TTS)
    if (response.audio) {
      console.log('🔊 [Approach 1] Playing audio from Lamatic workflow...');
      setState(prev => ({ ...prev, status: 'playing' }));
      await playAudio(response.audio).catch(err => {
        console.error('❌ [Approach 1] Workflow audio playback failed:', err);
      });
    } 
    // Fallback: If we got text but no audio, use the local TTS proxy
    else if (responseText) {
      setState(prev => ({ ...prev, status: 'playing' }));
      try {
        console.log(`🔊 [Approach 1] Requesting local TTS for: "${responseText.substring(0, 50)}..."`);
        const ttsResponse = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            text: responseText,
            voiceId: '21m00Tcm4TlvDq8ikWAM' 
          }),
        });

        if (ttsResponse.ok) {
          const audioBlob = await ttsResponse.blob();
          const audioUrl = URL.createObjectURL(audioBlob);
          await playAudio(audioUrl);
        }
      } catch (err) {
        console.error('❌ [Approach 1] Local TTS error:', err);
      }
    }

    // Resume listening after playback
    setState(prev => ({ ...prev, status: 'listening' }));
    startStatePolling();
  };

  const handleLamaticError = (error: Error) => {
    console.error('❌ [Approach 1] Lamatic error:', error);
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

      // If it's raw base64 (no prefix, no http), convert to object URL for stability
      if (!audioSource.startsWith('data:') && !audioSource.startsWith('http')) {
        try {
          const binaryString = window.atob(audioSource);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: 'audio/mpeg' });
          url = URL.createObjectURL(blob);
        } catch (e) {
          console.error('❌ [Approach 1] Base64 decoding failed:', e);
          reject(new Error('Invalid audio data'));
          return;
        }
      }
      
      audio.src = url;

      audio.onended = () => {
        console.log('🔊 [Approach 1] Audio playback finished');
        if (url !== audioSource) URL.revokeObjectURL(url);
        resolve();
      };
      
      audio.onerror = (e) => {
        console.error('❌ [Approach 1] Audio playback error:', e);
        if (url !== audioSource) URL.revokeObjectURL(url);
        reject(new Error('Audio playback failed'));
      };

      audio.play().catch((err) => {
        if (url !== audioSource) URL.revokeObjectURL(url);
        reject(err);
      });
    });
  };

  const handleStop = async () => {
    console.log('⏹ [Approach 1] Stopping...');
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

  // Energy bar color
  const getEnergyBarColor = () => {
    if (state.status === 'processing') return 'bg-yellow-500';
    if (state.status === 'playing') return 'bg-purple-500';
    if (state.isSpeaking) return 'bg-green-500';
    return 'bg-blue-500';
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-8">
      {/* Status Badge */}
      <div className="flex justify-center mb-6">
        <span className={`px-4 py-2 rounded-full text-sm font-medium ${
          state.status === 'idle' ? 'bg-gray-100 text-gray-600' :
          state.status === 'connecting' ? 'bg-yellow-100 text-yellow-700' :
          state.status === 'listening' ? 'bg-green-100 text-green-700' :
          state.status === 'processing' ? 'bg-blue-100 text-blue-700' :
          state.status === 'playing' ? 'bg-purple-100 text-purple-700' :
          'bg-red-100 text-red-700'
        }`}>
          {state.status === 'idle' && '⚪ Ready'}
          {state.status === 'connecting' && '🔄 Connecting...'}
          {state.status === 'listening' && (state.isSpeaking ? '🎤 Listening...' : '👂 Waiting for speech...')}
          {state.status === 'processing' && '🧠 Processing with Lamatic...'}
          {state.status === 'playing' && '🔊 Playing response...'}
          {state.status === 'error' && '❌ Error'}
        </span>
      </div>

      {/* Energy Meter */}
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

      {/* Transcript Display */}
      {state.transcript && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="text-xs text-gray-500 mb-1">You said:</div>
          <div className="text-gray-800">{state.transcript}</div>
        </div>
      )}

      {/* AI Response Display */}
      {state.aiResponse && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg">
          <div className="text-xs text-blue-500 mb-1">AI Response:</div>
          <div className="text-blue-800">{state.aiResponse}</div>
        </div>
      )}

      {/* Error Display */}
      {state.error && (
        <div className="mb-4 p-4 bg-red-50 rounded-lg text-red-700">
          {state.error}
        </div>
      )}

      {/* Controls */}
      <div className="flex justify-center gap-4">
        {!isActive ? (
          <button
            onClick={handleStart}
            className="px-8 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            🎤 Start Recording
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="px-8 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors"
          >
            ⏹ Stop
          </button>
        )}
      </div>

      {/* Architecture Info */}
      <div className="mt-8 pt-6 border-t text-xs text-gray-400 text-center">
        <p>Approach 1: getUserMedia → Lamatic (STT + LLM + TTS) → Audio Playback</p>
      </div>
    </div>
  );
}
