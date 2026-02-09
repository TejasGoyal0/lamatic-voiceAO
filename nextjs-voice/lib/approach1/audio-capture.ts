'use client';

/**
 * APPROACH 1: Audio Capture Module
 * 
 * Direct microphone capture using getUserMedia.
 * NO Cloudflare RealtimeKit dependencies.
 * 
 * Features:
 * - VAD (Voice Activity Detection)
 * - Pause detection
 * - Audio blob recording for sending to Lamatic
 */

export interface AudioCaptureConfig {
  onPauseDetected?: (audioBlob: Blob | null) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
  pauseDuration?: number; // ms of silence before pause
  calibrationDuration?: number; // ms for noise floor calibration
}

export interface AudioCaptureState {
  isRunning: boolean;
  isSpeaking: boolean;
  isCalibrating: boolean;
  currentEnergy: number;
  noiseFloor: number;
  segmentCount: number;
}

export class AudioCapture {
  // Config
  private pauseDuration: number;
  private calibrationDuration: number;

  // Callbacks
  private onPauseDetected: (audioBlob: Blob | null) => void;
  private onSpeechStart: () => void;
  private onError: (error: Error) => void;

  // Audio pipeline
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainData: Float32Array | null = null;

  // Recording
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  // State
  private isRunning = false;
  private isSpeaking = false;
  private isCalibrating = true;
  private currentEnergy = 0;
  private noiseFloor = 0.01;
  private segmentCount = 0;

  // Timing
  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private calibrationStartTime = 0;
  private silenceStartTime = 0;
  private speechStartTime = 0;
  private calibrationSamples: number[] = [];

  // Smoothing
  private smoothedEnergy = 0;
  private readonly smoothingFactor = 0.3;
  private readonly hysteresisRatio = 1.3;

  constructor(config: AudioCaptureConfig = {}) {
    this.pauseDuration = config.pauseDuration ?? 3000;
    this.calibrationDuration = config.calibrationDuration ?? 500;
    this.onPauseDetected = config.onPauseDetected ?? (() => {});
    this.onSpeechStart = config.onSpeechStart ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('AudioCapture already running');
    }

    try {
      console.log('🎤 [AudioCapture] Requesting microphone...');
      
      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      console.log('✓ [AudioCapture] Microphone access granted');

      // Set up Web Audio API for VAD
      this.audioContext = new AudioContext();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.analyserNode.smoothingTimeConstant = 0.3;
      this.sourceNode.connect(this.analyserNode);
      this.timeDomainData = new Float32Array(this.analyserNode.fftSize);

      // Set up MediaRecorder for capturing audio
      this.setupMediaRecorder();

      // Initialize state
      this.isRunning = true;
      this.isCalibrating = true;
      this.calibrationStartTime = Date.now();
      this.calibrationSamples = [];
      this.silenceStartTime = Date.now();

      // Start analysis loop
      this.analysisInterval = setInterval(() => this.analyze(), 50);

      console.log('✓ [AudioCapture] Started successfully');
    } catch (error) {
      console.error('❌ [AudioCapture] Start failed:', error);
      this.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private setupMediaRecorder(): void {
    if (!this.mediaStream) return;

    // Determine supported MIME type
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
    this.audioChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const audioBlob = new Blob(this.audioChunks, { type: mimeType });
      console.log(`📦 [AudioCapture] Audio blob created: ${audioBlob.size} bytes`);
      this.audioChunks = [];
      this.onPauseDetected(audioBlob);
    };

    // Start recording
    this.mediaRecorder.start(100); // Collect data every 100ms
  }

  private analyze(): void {
    if (!this.analyserNode || !this.timeDomainData) return;

    // Get audio data
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
        // Calculate noise floor from calibration samples
        if (this.calibrationSamples.length > 0) {
          const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
          // Use 75th percentile as noise floor
          const percentileIndex = Math.floor(sorted.length * 0.75);
          this.noiseFloor = Math.max(sorted[percentileIndex], 0.005);
        }
        this.isCalibrating = false;
        console.log(`✓ [AudioCapture] Calibration complete. Noise floor: ${this.noiseFloor.toFixed(4)}`);
      }
      return;
    }

    // Compute thresholds
    const speechThreshold = this.noiseFloor * this.hysteresisRatio;
    const silenceThreshold = this.noiseFloor;

    // State transitions
    if (!this.isSpeaking && this.smoothedEnergy > speechThreshold) {
      // Speech started
      this.isSpeaking = true;
      this.speechStartTime = now;
      this.onSpeechStart();
      
      // Start new recording segment
      if (this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
        this.audioChunks = [];
        this.mediaRecorder.start(100);
      }
    } else if (this.isSpeaking && this.smoothedEnergy < silenceThreshold) {
      // Potential silence
      if (this.silenceStartTime === 0 || this.silenceStartTime > this.speechStartTime) {
        this.silenceStartTime = now;
      }

      const silenceDuration = now - this.silenceStartTime;
      
      if (silenceDuration >= this.pauseDuration) {
        // Pause detected
        this.isSpeaking = false;
        this.segmentCount++;
        
        console.log(`⏸ [AudioCapture] Pause detected. Segment: ${this.segmentCount}, Silence: ${silenceDuration}ms`);
        
        // Stop recording and trigger callback
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
        
        // Reset silence timer
        this.silenceStartTime = now;
      }
    } else if (this.isSpeaking) {
      // Still speaking, reset silence timer
      this.silenceStartTime = now;
    }

    // Slowly update noise floor during silence
    if (!this.isSpeaking && this.smoothedEnergy < this.noiseFloor * 2) {
      this.noiseFloor = 0.995 * this.noiseFloor + 0.005 * this.smoothedEnergy;
    }
  }

  stop(): void {
    console.log('⏹ [AudioCapture] Stopping...');
    
    this.isRunning = false;

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    this.analyserNode = null;
    this.timeDomainData = null;
    this.audioChunks = [];

    console.log('✓ [AudioCapture] Stopped');
  }

  getState(): AudioCaptureState {
    return {
      isRunning: this.isRunning,
      isSpeaking: this.isSpeaking,
      isCalibrating: this.isCalibrating,
      currentEnergy: this.currentEnergy,
      noiseFloor: this.noiseFloor,
      segmentCount: this.segmentCount,
    };
  }
}
