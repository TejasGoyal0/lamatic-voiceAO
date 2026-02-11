
import { encodeWAV } from './wav-encoder';

export interface AudioCaptureConfig {
  onPauseDetected?: (audioBlob: Blob | null) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
  pauseDuration?: number;
  calibrationDuration?: number;
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
  private pauseDuration: number;
  private calibrationDuration: number;
  private onPauseDetected: (audioBlob: Blob | null) => void;
  private onSpeechStart: () => void;
  private onError: (error: Error) => void;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private timeDomainData: Float32Array<ArrayBuffer> | null = null;
  private pcmBuffer: Float32Array[] = [];
  private isRunning = false;
  private isSpeaking = false;
  private isCalibrating = true;
  private currentEnergy = 0;
  private noiseFloor = 0.01;
  private segmentCount = 0;
  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private calibrationStartTime = 0;
  private silenceStartTime = 0;
  private speechStartTime = 0;
  private calibrationSamples: number[] = [];
  private smoothedEnergy = 0;
  private readonly smoothingFactor = 0.3;
  private readonly hysteresisRatio = 2.5;
  private readonly minSpeechDuration = 300;

  constructor(config: AudioCaptureConfig = {}) {
    this.pauseDuration = config.pauseDuration ?? 1200;
    this.calibrationDuration = config.calibrationDuration ?? 1000;
    this.onPauseDetected = config.onPauseDetected ?? (() => {});
    this.onSpeechStart = config.onSpeechStart ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.audioContext = new AudioContext();
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 2048;
      this.timeDomainData = new Float32Array(this.analyserNode.fftSize);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processorNode.onaudioprocess = (e) => {
        if (!this.isRunning) return;
        const input = e.inputBuffer.getChannelData(0);
        if (this.isSpeaking) {
          this.pcmBuffer.push(new Float32Array(input));
        }
      };
      this.sourceNode.connect(this.analyserNode);
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);
      this.isRunning = true;
      this.isCalibrating = true;
      this.calibrationStartTime = Date.now();
      this.silenceStartTime = Date.now();
      this.analysisInterval = setInterval(() => this.analyze(), 50);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private analyze(): void {
    if (!this.analyserNode || !this.timeDomainData) return;
    this.analyserNode.getFloatTimeDomainData(this.timeDomainData);
    let sum = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      sum += this.timeDomainData[i] * this.timeDomainData[i];
    }
    const rawEnergy = Math.sqrt(sum / this.timeDomainData.length);
    this.smoothedEnergy = this.smoothingFactor * rawEnergy + (1 - this.smoothingFactor) * this.smoothedEnergy;
    this.currentEnergy = this.smoothedEnergy;
    const now = Date.now();

    if (this.isCalibrating) {
      this.calibrationSamples.push(rawEnergy);
      if (now - this.calibrationStartTime >= this.calibrationDuration) {
        if (this.calibrationSamples.length > 0) {
          const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
          this.noiseFloor = Math.max(sorted[Math.floor(sorted.length * 0.75)], 0.005);
        }
        this.isCalibrating = false;
      }
      return;
    }

    const speechThreshold = this.noiseFloor * this.hysteresisRatio;
    const silenceThreshold = this.noiseFloor * 1.1;

    if (!this.isSpeaking && this.smoothedEnergy > speechThreshold) {
      if (this.speechStartTime === 0) this.speechStartTime = now;
      if (now - this.speechStartTime >= this.minSpeechDuration) {
        this.isSpeaking = true;
        this.silenceStartTime = 0;
        this.pcmBuffer = [];
        this.onSpeechStart();
      }
    } else if (this.isSpeaking && this.smoothedEnergy < silenceThreshold) {
      if (this.silenceStartTime === 0) this.silenceStartTime = now;
      if (now - this.silenceStartTime >= this.pauseDuration) {
        this.finalizeSegment();
      }
    } else if (this.smoothedEnergy > silenceThreshold) {
      if (this.isSpeaking) this.silenceStartTime = 0;
    }
  }

  private finalizeSegment(): void {
    this.isSpeaking = false;
    this.segmentCount++;
    this.speechStartTime = 0;
    this.silenceStartTime = 0;
    if (this.pcmBuffer.length > 0) {
      const length = this.pcmBuffer.reduce((acc, curr) => acc + curr.length, 0);
      const flat = new Float32Array(length);
      let offset = 0;
      for (const chunk of this.pcmBuffer) {
        flat.set(chunk, offset);
        offset += chunk.length;
      }
      const audioBlob = encodeWAV(flat, this.audioContext?.sampleRate || 44100);
      this.onPauseDetected(audioBlob);
    }
    this.pcmBuffer = [];
  }

  stop(): void {
    this.isRunning = false;
    if (this.analysisInterval) clearInterval(this.analysisInterval);
    if (this.isSpeaking) this.finalizeSegment();
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
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
    this.pcmBuffer = [];
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
