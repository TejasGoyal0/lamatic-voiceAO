'use client';

export interface VoiceCaptureConfig {
  onPauseDetected?: (data: PauseDetectedData) => void;
  onSpeechStart?: (data: SpeechStartData) => void;
  onEnergyUpdate?: (energy: number, isSpeaking: boolean, details: EnergyDetails) => void;
  silenceThreshold?: number;
  noiseMargin?: number;
  hysteresisRatio?: number;
  pauseDuration?: number;
  speechMinDuration?: number;
  calibrationDuration?: number;
  analysisInterval?: number;
  smoothingFactor?: number;
}

export interface PauseDetectedData {
  segmentCount: number;
  silenceDuration: number;
  timestamp: number;
  noiseFloor: number;
  threshold: number;
}

export interface SpeechStartData {
  timestamp: number;
  energy: number;
  silenceDuration: number;
}

export interface EnergyDetails {
  rawEnergy: number;
  smoothedEnergy: number;
  threshold: number;
  speechThreshold: number;
  noiseFloor: number;
  state: VoiceCaptureState;
}

export type VoiceCaptureState = 'idle' | 'calibrating' | 'silence' | 'speaking';

export interface VoiceCaptureStateInfo {
  isRunning: boolean;
  state: VoiceCaptureState;
  noiseFloor: number;
  effectiveThreshold: number;
  speechThreshold: number;
  smoothedEnergy: number;
  segmentCount: number;
  pauseTriggered: boolean;
  currentEnergy: number;
  isCalibrating: boolean;
  isSpeaking: boolean;
}

export class VoiceCapture {
  // Callbacks
  private onPauseDetected: (data: PauseDetectedData) => void;
  private onSpeechStart: (data: SpeechStartData) => void;
  private onEnergyUpdate: (energy: number, isSpeaking: boolean, details: EnergyDetails) => void;

  // Config
  private config: {
    silenceThreshold: number;
    noiseMargin: number;
    hysteresisRatio: number;
    pauseDuration: number;
    speechMinDuration: number;
    calibrationDuration: number;
    analysisInterval: number;
    smoothingFactor: number;
  };

  // Audio pipeline (analysis only)
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainData: Float32Array<ArrayBuffer> | null = null;

  // External stream reference (NOT owned)
  private _externalMediaStream: MediaStream | null = null;
  private _ownsMediaStream = false;

  // Calibration
  private noiseFloor: number;
  private isCalibrating = false;
  private calibrationSamples: number[] = [];

  // Adaptive thresholds
  private effectiveThreshold: number;
  private speechThreshold: number;

  // VAD state machine
  private state: VoiceCaptureState = 'idle';
  private stateStartTime = 0;

  // Energy tracking
  private smoothedEnergy = 0;
  private peakEnergy = 0;

  // Pause detection
  private silenceStartTime: number | null = null;
  private lastSpeechTime: number | null = null;
  private pauseTriggered = false;
  private segmentCount = 0;

  // Timing
  private lastAnalysisTime = 0;
  private animationFrameId: number | null = null;
  public isRunning = false;

  constructor(config: VoiceCaptureConfig = {}) {
    this.onPauseDetected = config.onPauseDetected ?? (() => {});
    this.onSpeechStart = config.onSpeechStart ?? (() => {});
    this.onEnergyUpdate = config.onEnergyUpdate ?? (() => {});

    this.config = {
      silenceThreshold: config.silenceThreshold ?? 0.015,
      noiseMargin: config.noiseMargin ?? 2.5,
      hysteresisRatio: config.hysteresisRatio ?? 1.3,
      pauseDuration: config.pauseDuration ?? 3000,
      speechMinDuration: config.speechMinDuration ?? 300,
      calibrationDuration: config.calibrationDuration ?? 500,
      analysisInterval: config.analysisInterval ?? 50,
      smoothingFactor: config.smoothingFactor ?? 0.7,
    };

    this.noiseFloor = this.config.silenceThreshold;
    this.effectiveThreshold = this.config.silenceThreshold;
    this.speechThreshold = this.effectiveThreshold * this.config.hysteresisRatio;
  }


  async startWithMediaStream(mediaStream: MediaStream): Promise<void> {
    if (this.isRunning) {
      console.warn('VoiceCapture already running');
      return;
    }

    if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
      throw new Error('MediaStream with audio track required');
    }

    this._externalMediaStream = mediaStream;
    this._ownsMediaStream = false;

    // Create AudioContext
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass({
      latencyHint: 'interactive',
      sampleRate: 48000,
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.buildAudioGraph(mediaStream);
    this.initializeState();
    this.startCalibration();
    this.startAnalysisLoop();

    console.log('VoiceCapture started (external stream)', {
      sampleRate: this.audioContext.sampleRate,
    });
  }


  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('VoiceCapture already running');
      return;
    }

    console.warn('VoiceCapture.start() is deprecated. Use startWithMediaStream() instead.');

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices API unavailable');
    }

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 1,
      },
      video: false,
    });

    this._ownsMediaStream = true;
    await this.startWithMediaStream(mediaStream);
  }

  private buildAudioGraph(mediaStream: MediaStream): void {
    if (!this.audioContext) return;

    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0;

    this.timeDomainData = new Float32Array(this.analyserNode.fftSize);
    this.sourceNode.connect(this.analyserNode);
  }

  private initializeState(): void {
    this.isRunning = true;
    this.smoothedEnergy = 0;
    this.peakEnergy = 0;
    this.silenceStartTime = null;
    this.lastSpeechTime = null;
    this.pauseTriggered = false;
    this.segmentCount = 0;
  }

  private startCalibration(): void {
    this.state = 'calibrating';
    this.stateStartTime = performance.now();
    this.calibrationSamples = [];
    this.isCalibrating = true;
    console.log('Calibrating noise floor...');
  }

  private finishCalibration(): void {
    this.isCalibrating = false;

    if (this.calibrationSamples.length > 0) {
      const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      this.noiseFloor = Math.max(median, 0.001);
      this.effectiveThreshold = Math.max(
        this.noiseFloor * this.config.noiseMargin,
        this.config.silenceThreshold
      );
      this.speechThreshold = this.effectiveThreshold * this.config.hysteresisRatio;

      console.log('Calibration complete', {
        noiseFloor: this.noiseFloor.toFixed(4),
        threshold: this.effectiveThreshold.toFixed(4),
      });
    }

    this.state = 'silence';
    this.stateStartTime = performance.now();
    this.calibrationSamples = [];
  }

  private computeRMS(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  private smoothEnergy(rawEnergy: number): number {
    this.smoothedEnergy =
      this.config.smoothingFactor * this.smoothedEnergy +
      (1 - this.config.smoothingFactor) * rawEnergy;
    this.peakEnergy = Math.max(this.peakEnergy * 0.995, rawEnergy);
    return this.smoothedEnergy;
  }

  private startAnalysisLoop(): void {
    const analyze = (timestamp: number): void => {
      if (!this.isRunning) return;

      const elapsed = timestamp - this.lastAnalysisTime;
      if (elapsed < this.config.analysisInterval) {
        this.animationFrameId = requestAnimationFrame(analyze);
        return;
      }
      this.lastAnalysisTime = timestamp;

      if (!this.analyserNode || !this.timeDomainData) return;

      this.analyserNode.getFloatTimeDomainData(this.timeDomainData);
      const rawEnergy = this.computeRMS(this.timeDomainData);
      const energy = this.smoothEnergy(rawEnergy);

      const now = performance.now();

      if (this.state === 'calibrating') {
        this.calibrationSamples.push(rawEnergy);
        if (now - this.stateStartTime >= this.config.calibrationDuration) {
          this.finishCalibration();
        }
      } else {
        this.processVAD(energy, now);
      }

      this.onEnergyUpdate(energy, this.state === 'speaking', {
        rawEnergy,
        smoothedEnergy: this.smoothedEnergy,
        threshold: this.effectiveThreshold,
        speechThreshold: this.speechThreshold,
        noiseFloor: this.noiseFloor,
        state: this.state,
      });

      this.animationFrameId = requestAnimationFrame(analyze);
    };

    this.animationFrameId = requestAnimationFrame(analyze);
  }

  private processVAD(energy: number, now: number): void {
    const wasSpeaking = this.state === 'speaking';

    const isSpeaking = wasSpeaking
      ? energy > this.effectiveThreshold
      : energy > this.speechThreshold;

    if (isSpeaking) {
      if (!wasSpeaking) {
        this.state = 'speaking';
        this.stateStartTime = now;
        this.pauseTriggered = false;

        this.onSpeechStart({
          timestamp: Date.now(),
          energy,
          silenceDuration: this.silenceStartTime
            ? (now - this.silenceStartTime) / 1000
            : 0,
        });
      }

      this.lastSpeechTime = now;
      this.silenceStartTime = null;
    } else {
      if (wasSpeaking) {
        this.state = 'silence';
        this.stateStartTime = now;
        this.silenceStartTime = now;
      } else if (this.silenceStartTime === null) {
        this.silenceStartTime = now;
      }

      this.checkPause(now);
    }
  }

  private checkPause(now: number): void {
    if (this.pauseTriggered) return;
    if (this.lastSpeechTime === null) return;
    if (this.silenceStartTime === null) return;

    const silenceDuration = now - this.silenceStartTime;

    if (silenceDuration >= this.config.pauseDuration) {
      this.pauseTriggered = true;
      this.segmentCount++;

      this.onPauseDetected({
        segmentCount: this.segmentCount,
        silenceDuration: silenceDuration / 1000,
        timestamp: Date.now(),
        noiseFloor: this.noiseFloor,
        threshold: this.effectiveThreshold,
      });
    }
  }

  stop(): void {
    this.isRunning = false;
    this.state = 'idle';

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    // Only stop tracks if we own the stream
    if (this._ownsMediaStream && this._externalMediaStream) {
      this._externalMediaStream.getTracks().forEach((track) => track.stop());
    }
    this._externalMediaStream = null;
    this._ownsMediaStream = false;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.analyserNode = null;
    this.timeDomainData = null;

    console.log('VoiceCapture stopped');
  }

  recalibrate(): void {
    if (!this.isRunning) return;
    this.startCalibration();
  }

  getState(): VoiceCaptureStateInfo {
    return {
      isRunning: this.isRunning,
      state: this.state,
      noiseFloor: this.noiseFloor,
      effectiveThreshold: this.effectiveThreshold,
      speechThreshold: this.speechThreshold,
      smoothedEnergy: this.smoothedEnergy,
      segmentCount: this.segmentCount,
      pauseTriggered: this.pauseTriggered,
      currentEnergy: this.smoothedEnergy,
      isCalibrating: this.state === 'calibrating',
      isSpeaking: this.state === 'speaking',
    };
  }
}
