'use client';

/**
 * APPROACH 2: RealtimeKit Client
 * 
 * Cloudflare RealtimeKit for audio transport (WebRTC).
 * Includes VAD (Voice Activity Detection) and pause detection.
 * 
 * This module:
 * - Connects to Cloudflare RealtimeKit
 * - Streams microphone audio via WebRTC
 * - Performs local VAD for pause detection
 * - Exposes MediaStream for external STT processing
 */

export interface RealtimeKitClientConfig {
  authToken: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onPauseDetected?: (data: PauseData) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
  pauseDuration?: number;
  calibrationDuration?: number;
}

export interface PauseData {
  segmentCount: number;
  silenceDuration: number;
  timestamp: number;
}

export interface RealtimeKitState {
  isConnected: boolean;
  isSpeaking: boolean;
  isCalibrating: boolean;
  currentEnergy: number;
  noiseFloor: number;
  segmentCount: number;
}

// RealtimeKit SDK types
interface RTKMeeting {
  join(): Promise<void>;
  leave(): Promise<void>;
  self: {
    id: string;
    audioEnabled: boolean;
    audioTrack: MediaStreamTrack | null;
    enableAudio(): Promise<void>;
    disableAudio(): Promise<void>;
  };
  meta: {
    meetingId: string;
  };
  chat: {
    sendTextMessage(message: string): Promise<void>;
  };
}

interface RTKClient {
  init(config: { authToken: string }): Promise<RTKMeeting>;
}

export class RealtimeKitClient {
  // Config
  private authToken: string;
  private pauseDuration: number;
  private calibrationDuration: number;

  // Callbacks
  private onConnected: () => void;
  private onDisconnected: () => void;
  private onPauseDetected: (data: PauseData) => void;
  private onSpeechStart: () => void;
  private onError: (error: Error) => void;

  // RealtimeKit
  private meeting: RTKMeeting | null = null;
  private isConnected = false;
  private _mediaStream: MediaStream | null = null;

  // Audio analysis (VAD)
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainData: Float32Array | null = null;

  // VAD state
  private isSpeaking = false;
  private isCalibrating = true;
  private currentEnergy = 0;
  private smoothedEnergy = 0;
  private noiseFloor = 0.01;
  private segmentCount = 0;

  // Timing
  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private calibrationStartTime = 0;
  private silenceStartTime = 0;
  private speechStartTime = 0;
  private calibrationSamples: number[] = [];

  // Constants
  private readonly smoothingFactor = 0.3;
  private readonly hysteresisRatio = 2.5; // Increased from 2.0 to be even more selective
  private readonly minSpeechDuration = 500; // Increased from 300ms to filter out notifications/thuds

  constructor(config: RealtimeKitClientConfig) {
    this.authToken = config.authToken;
    this.pauseDuration = config.pauseDuration ?? 2000; // Slightly shorter pause for responsiveness if filtered
    this.calibrationDuration = config.calibrationDuration ?? 1000; // Longer calibration for better floor
    this.onConnected = config.onConnected ?? (() => {});
    this.onDisconnected = config.onDisconnected ?? (() => {});
    this.onPauseDetected = config.onPauseDetected ?? (() => {});
    this.onSpeechStart = config.onSpeechStart ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      throw new Error('Already connected');
    }

    try {
      // STEP 1: Get microphone access using BROWSER API (for VAD)
      // This is separate from RealtimeKit and works reliably
      console.log('🎤 [RealtimeKitClient] Requesting microphone via browser getUserMedia...');
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      console.log('✓ [RealtimeKitClient] Microphone access granted via browser API');
      console.log('🎤 [RealtimeKitClient] Audio tracks:', this._mediaStream.getAudioTracks().map(t => ({
        label: t.label,
        enabled: t.enabled,
        readyState: t.readyState,
      })));

      // STEP 2: Set up VAD using browser Web Audio API
      this.setupAudioAnalysis();

      // STEP 3: Connect to Cloudflare RealtimeKit (for WebRTC transport)
      console.log('🔗 [RealtimeKitClient] Connecting to Cloudflare RealtimeKit...');
      const RealtimeKitClientSDK = (await import('@cloudflare/realtimekit')).default;

      this.meeting = await RealtimeKitClientSDK.init({
        authToken: this.authToken,
        defaults: {
          audio: false, // We manage audio separately
          video: false,
        },
        modules: {
          devTools: {
            logs: false,
          },
        },
      });

      await this.meeting!.join();
      console.log('✓ [RealtimeKitClient] Joined RealtimeKit meeting:', this.meeting!.meta.meetingId);

      // Enable audio in RealtimeKit (for streaming to other participants if needed)
      await this.meeting!.self.enableAudio();
      console.log('✓ [RealtimeKitClient] RealtimeKit audio enabled');

      this.isConnected = true;
      this.onConnected();

    } catch (error) {
      console.error('❌ [RealtimeKitClient] Connection failed:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  private setupAudioAnalysis(): void {
    if (!this._mediaStream) {
      console.error('❌ [RealtimeKitClient] setupAudioAnalysis called but no media stream!');
      return;
    }

    console.log('🎧 [RealtimeKitClient] Setting up audio analysis...');
    
    this.audioContext = new AudioContext();
    console.log('🎧 [RealtimeKitClient] AudioContext state:', this.audioContext.state);
    
    // Resume if suspended (browsers require user interaction)
    if (this.audioContext.state === 'suspended') {
      console.log('⚠️ [RealtimeKitClient] AudioContext is suspended, attempting resume...');
      this.audioContext.resume().then(() => {
        console.log('✓ [RealtimeKitClient] AudioContext resumed, state:', this.audioContext?.state);
      }).catch(err => {
        console.error('❌ [RealtimeKitClient] AudioContext resume failed:', err);
      });
    }
    
    this.sourceNode = this.audioContext.createMediaStreamSource(this._mediaStream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.3;
    this.sourceNode.connect(this.analyserNode);
    this.timeDomainData = new Float32Array(this.analyserNode.fftSize);

    // Initialize timing
    this.calibrationStartTime = Date.now();
    this.silenceStartTime = Date.now();
    this.speechStartTime = 0;
    this.calibrationSamples = [];
    this.isCalibrating = true;

    // Start analysis loop
    this.analysisInterval = setInterval(() => this.analyzeAudio(), 50);
    console.log('✓ [RealtimeKitClient] Audio analysis started - VAD active');
    console.log(`🎚️ [RealtimeKitClient] Pause threshold: ${this.pauseDuration}ms, Calibration: ${this.calibrationDuration}ms`);
  }

  private analyzeAudio(): void {
    if (!this.analyserNode || !this.timeDomainData) {
      return;
    }

    this.analyserNode.getFloatTimeDomainData(this.timeDomainData);

    // Compute RMS energy
    let sum = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      sum += this.timeDomainData[i] * this.timeDomainData[i];
    }
    const rawEnergy = Math.sqrt(sum / this.timeDomainData.length);

    // Apply EMA smoothing
    this.smoothedEnergy = this.smoothingFactor * rawEnergy + (1 - this.smoothingFactor) * this.smoothedEnergy;
    this.currentEnergy = this.smoothedEnergy;

    const now = Date.now();

    // Calibration phase
    if (this.isCalibrating) {
      this.calibrationSamples.push(rawEnergy);

      if (now - this.calibrationStartTime >= this.calibrationDuration) {
        if (this.calibrationSamples.length > 0) {
          const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
          // Use a higher percentile for the floor to be more noise-tolerant
          const percentileIndex = Math.floor(sorted.length * 0.9);
          this.noiseFloor = Math.max(sorted[percentileIndex], 0.008);
        }
        this.isCalibrating = false;
        console.log(`✓ [RealtimeKitClient] Calibration complete. Noise floor: ${this.noiseFloor.toFixed(4)}`);
      }
      return;
    }

    // Compute thresholds
    const speechThreshold = this.noiseFloor * this.hysteresisRatio;
    const silenceThreshold = this.noiseFloor * 1.1;

    // State transitions
    if (!this.isSpeaking && this.smoothedEnergy > speechThreshold) {
      // Start tracking potential speech
      if (this.speechStartTime === 0) {
        this.speechStartTime = now;
      }

      // Only transition to 'speaking' if the sound persists longer than minSpeechDuration
      // This filters out clicks, pops, and sudden sharp noises
      if (now - this.speechStartTime >= this.minSpeechDuration) {
        this.isSpeaking = true;
        this.silenceStartTime = 0;
        console.log(`🗣️ [VAD] Speech confirmed! Energy: ${this.smoothedEnergy.toFixed(4)} > threshold: ${speechThreshold.toFixed(4)}`);
        this.onSpeechStart();
      }
    } else if (this.isSpeaking && this.smoothedEnergy < silenceThreshold) {
      // Already speaking, but energy dropped below silence threshold
      if (this.silenceStartTime === 0) {
        this.silenceStartTime = now;
        console.log(`🤫 [VAD] Silence started, waiting for ${this.pauseDuration}ms...`);
      }

      const silenceDuration = now - this.silenceStartTime;

      if (silenceDuration >= this.pauseDuration) {
        this.isSpeaking = false;
        this.segmentCount++;
        this.speechStartTime = 0;

        console.log(`⏸ [RealtimeKitClient] Pause detected. Segment: ${this.segmentCount}`);

        this.onPauseDetected({
          segmentCount: this.segmentCount,
          silenceDuration,
          timestamp: now,
        });

        this.silenceStartTime = 0;
      }
    } else if (this.smoothedEnergy > silenceThreshold) {
      // Energy is above silence threshold, so we are (or might be) speaking
      if (this.isSpeaking) {
        this.silenceStartTime = 0; // Reset silence timer
      }
    } else {
      // Energy is below silence threshold and we are not speaking
      this.speechStartTime = 0; // Reset potential speech start
      
      // Slowly update noise floor during prolonged silence to adapt to room changes
      // Use a very small factor to avoid adapting to actual speech
      if (this.smoothedEnergy < this.noiseFloor * 1.5) {
        this.noiseFloor = 0.998 * this.noiseFloor + 0.002 * this.smoothedEnergy;
      }
    }
  }

  async disconnect(): Promise<void> {
    console.log('⏹ [RealtimeKitClient] Disconnecting...');

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    if (this.meeting) {
      try {
        await this.meeting.self.disableAudio();
        await this.meeting.leave();
      } catch (e) {
        console.warn('Leave error:', e);
      }
      this.meeting = null;
    }

    this._mediaStream = null;
    this.analyserNode = null;
    this.timeDomainData = null;
    this.isConnected = false;

    this.onDisconnected();
    console.log('✓ [RealtimeKitClient] Disconnected');
  }

  /**
   * Get the MediaStream for external STT processing
   */
  getMediaStream(): MediaStream | null {
    return this._mediaStream;
  }

  /**
   * Send control message via RealtimeKit chat channel
   */
  async sendControlMessage(message: object): Promise<void> {
    if (!this.meeting) {
      throw new Error('Not connected');
    }
    await this.meeting.chat.sendTextMessage(JSON.stringify(message));
  }

  getState(): RealtimeKitState {
    return {
      isConnected: this.isConnected,
      isSpeaking: this.isSpeaking,
      isCalibrating: this.isCalibrating,
      currentEnergy: this.currentEnergy,
      noiseFloor: this.noiseFloor,
      segmentCount: this.segmentCount,
    };
  }
}
