'use client';

/**
 * APPROACH 2: VoiceClient Component
 * 
 * Transport: Cloudflare RealtimeKit (WebRTC)
 * STT: ElevenLabs (external, browser-side)
 * LLM: Lamatic (receives transcript on PAUSE, returns AI text)
 * TTS: ElevenLabs (streaming audio playback)
 */

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
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

  // Poll RealtimeKit state for visualization
  const startStatePolling = useCallback(() => {
    console.log('🔄 [VoiceClient] Starting state polling...');
    let pollCount = 0;
    const poll = () => {
      if (realtimeKitRef.current) {
        const rtkState = realtimeKitRef.current.getState();
        pollCount++;
        // Log every 60 frames (~1 second)
        if (pollCount % 60 === 0) {
          console.log(`📊 [VoiceClient] Poll #${pollCount}: energy=${rtkState.currentEnergy.toFixed(4)}, speaking=${rtkState.isSpeaking}`);
        }
        setState(prev => ({
          ...prev,
          energy: rtkState.currentEnergy,
          isSpeaking: rtkState.isSpeaking,
          segmentCount: rtkState.segmentCount,
        }));
      } else {
        if (pollCount % 60 === 0) {
          console.log('⚠️ [VoiceClient] Poll: realtimeKitRef.current is null');
        }
        pollCount++;
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
      console.log('🎤 [Approach 2] Starting with Cloudflare RealtimeKit...');

      // 1. Get auth token from server
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
      console.log('✓ [Approach 2] Auth token received');

      // 2. Initialize TTS client (ElevenLabs)
      ttsClientRef.current = new TTSClient({
        onPlaybackStart: () => {
          console.log('🔊 [Approach 2] TTS playback started');
          setState(prev => ({ ...prev, status: 'playing' }));
        },
        onPlaybackEnd: () => {
          console.log('✓ [Approach 2] TTS playback ended');
          // Resume listening after TTS finishes
          setState(prev => ({ ...prev, status: 'listening' }));
          startStatePolling();
        },
        onError: (error) => {
          console.error('❌ [Approach 2] TTS error:', error);
          // Resume listening even on error
          setState(prev => ({ ...prev, status: 'listening' }));
          startStatePolling();
        },
      });

      // 3. Initialize Lamatic client
      lamaticClientRef.current = new LamaticClient({
        onResponse: handleLamaticResponse,
        onError: handleLamaticError,
      });

      // 4. Initialize STT client (ElevenLabs)
      sttClientRef.current = new STTClient({
        onPartialTranscript: (result) => {
          setState(prev => ({ ...prev, partialTranscript: result.text }));
        },
        onFinalTranscript: async (result) => {
          console.log('📝 [Approach 2] Final transcript:', result.text);
          setState(prev => ({ 
            ...prev, 
            finalTranscript: result.text,
            partialTranscript: null,
          }));
        },
        onError: (error) => {
          console.error('❌ [Approach 2] STT error:', error);
        },
      });

      // 5. Initialize RealtimeKit client
      realtimeKitRef.current = new RealtimeKitClient({
        authToken: token,
        pauseDuration: 1200,
        calibrationDuration: 1000,

        onConnected: () => {
          console.log('✓ [Approach 2] RealtimeKit connected');
          setState(prev => ({ ...prev, status: 'listening' }));
          
          // Start STT with RealtimeKit's media stream
          const stream = realtimeKitRef.current?.getMediaStream();
          if (stream && sttClientRef.current) {
            sttClientRef.current.start(stream);
          }
        },

        onDisconnected: () => {
          console.log('⏹ [Approach 2] RealtimeKit disconnected');
          setState(prev => ({ ...prev, status: 'idle' }));
          stopStatePolling();
        },

        onPauseDetected: async (data) => {
          console.log('⏸ [Approach 2] Pause detected:', data);
          setState(prev => ({ ...prev, status: 'processing' }));
          stopStatePolling();

          // Flush STT to get final transcript
          let transcript = '';
          if (sttClientRef.current) {
            transcript = await sttClientRef.current.flush();
            setState(prev => ({ 
              ...prev, 
              finalTranscript: transcript,
              partialTranscript: null,
            }));
          }

          // Send transcript to Lamatic
          if (transcript && lamaticClientRef.current) {
            console.log('📤 [Approach 2] Sending transcript to Lamatic:', transcript);
            await lamaticClientRef.current.sendTranscript(transcript, data);
          } else {
            console.log('⚠️ [Approach 2] No transcript to send');
            // Resume listening even if no transcript
            setState(prev => ({ ...prev, status: 'listening' }));
            startStatePolling();
          }
        },

        onSpeechStart: () => {
          console.log('🗣️ [Approach 2] Speech started - interrupting AI if playing');
          // BARGE-IN: Stop AI from speaking immediately when user interrupts
          if (ttsClientRef.current) {
            ttsClientRef.current.stop();
          }
          setState(prev => ({ ...prev, status: 'listening', isSpeaking: true }));
        },

        onError: (error) => {
          console.error('❌ [Approach 2] RealtimeKit error:', error);
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
      console.error('❌ [Approach 2] Start error:', error);
      setState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };

  const handleLamaticResponse = async (response: LamaticResponse) => {
    console.log('📥 [Approach 2] Lamatic GraphQL response:', response);
    
    // GraphQL API returns the AI response directly (no long-polling needed)
    if (response.success && response.text) {
      const aiText = response.text;
      console.log('✓ [Approach 2] Got AI response:', aiText.substring(0, 100) + '...');
      setState(prev => ({
        ...prev,
        aiResponse: aiText,
      }));

      // Send to TTS
      if (ttsClientRef.current) {
        console.log('🔊 [Approach 2] Sending to TTS');
        setState(prev => ({ ...prev, status: 'playing' }));
        stopStatePolling();
        await ttsClientRef.current.speak(aiText);
      } else {
        // No TTS, just resume listening
        setState(prev => ({ ...prev, status: 'listening' }));
        startStatePolling();
      }
    } else {
      console.log('⚠️ [Approach 2] GraphQL returned no AI response:', response.error || 'unknown error');
      setState(prev => ({ ...prev, status: 'listening' }));
      startStatePolling();
    }
  };

  const handleLamaticError = (error: Error) => {
    console.error('❌ [Approach 2] Lamatic error:', error);
    // Don't fail completely, just log and continue
    setState(prev => ({ ...prev, status: 'listening' }));
    startStatePolling();
  };

  const handleStop = async () => {
    console.log('⏹ [Approach 2] Stopping...');
    stopStatePolling();
    
    // Stop TTS if playing
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
          {state.status === 'connecting' && '🔄 Connecting to Cloudflare...'}
          {state.status === 'listening' && (state.isSpeaking ? '🎤 Listening...' : '👂 Waiting for speech...')}
          {state.status === 'processing' && '🧠 Processing with Lamatic...'}
          {state.status === 'playing' && '🔊 Playing response...'}
          {state.status === 'error' && '❌ Error'}
        </span>
      </div>

      {/* Segment Counter */}
      {state.segmentCount > 0 && (
        <div className="text-center mb-4 text-sm text-gray-500">
          Segments: {state.segmentCount}
        </div>
      )}

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

      {/* Live Transcript */}
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

      {/* AI Response Display */}
      {state.aiResponse && (
        <div className="mb-4 p-4 bg-purple-50 rounded-lg">
          <div className="text-xs text-purple-500 mb-1">AI Response:</div>
          <div className="text-purple-800">{state.aiResponse}</div>
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
            className="px-8 py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 transition-colors"
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
        <p>Approach 2: RealtimeKit → ElevenLabs STT → Lamatic LLM → TTS</p>
      </div>
    </div>
  );
}
