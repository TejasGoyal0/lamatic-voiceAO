'use client';

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
  private authToken: string;
  private pauseDuration: number;
  private calibrationDuration: number;
  private onConnected: () => void;
  private onDisconnected: () => void;
  private onPauseDetected: (data: PauseData) => void;
  private onSpeechStart: () => void;
  private onError: (error: Error) => void;

  private meeting: RTKMeeting | null = null;
  private isConnected = false;
  private _mediaStream: MediaStream | null = null;

  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private timeDomainData: Float32Array<ArrayBuffer> | null = null;

  private isSpeaking = false;
  private isCalibrating = true;
  private currentEnergy = 0;
  private smoothedEnergy = 0;
  private noiseFloor = 0.01;
  private segmentCount = 0;

  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private calibrationStartTime = 0;
  private silenceStartTime = 0;
  private speechStartTime = 0;
  private calibrationSamples: number[] = [];

  private readonly smoothingFactor = 0.3;
  private readonly hysteresisRatio = 2.5;
  private readonly minSpeechDuration = 500;

  constructor(config: RealtimeKitClientConfig) {
    this.authToken = config.authToken;
    this.pauseDuration = config.pauseDuration ?? 2000;
    this.calibrationDuration = config.calibrationDuration ?? 1000;
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
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });

      this.setupAudioAnalysis();

      const RealtimeKitClientSDK = (await import('@cloudflare/realtimekit')).default;

      this.meeting = await RealtimeKitClientSDK.init({
        authToken: this.authToken,
        defaults: { audio: false, video: false },
        modules: { devTools: { logs: false } },
      });

      await this.meeting!.join();
      await this.meeting!.self.enableAudio();

      this.isConnected = true;
      this.onConnected();

    } catch (error) {
      console.error('[RealtimeKit] Connection failed:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  private setupAudioAnalysis(): void {
    if (!this._mediaStream) return;

    this.audioContext = new AudioContext();

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch((err: Error) => {
        console.error('[RealtimeKit] AudioContext resume failed:', err);
      });
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this._mediaStream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.3;
    this.sourceNode.connect(this.analyserNode);
    this.timeDomainData = new Float32Array(this.analyserNode.fftSize);

    this.calibrationStartTime = Date.now();
    this.silenceStartTime = Date.now();
    this.speechStartTime = 0;
    this.calibrationSamples = [];
    this.isCalibrating = true;

    this.analysisInterval = setInterval(() => this.analyzeAudio(), 50);
  }

  private analyzeAudio(): void {
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
          const percentileIndex = Math.floor(sorted.length * 0.9);
          this.noiseFloor = Math.max(sorted[percentileIndex], 0.008);
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
        this.onSpeechStart();
      }
    } else if (this.isSpeaking && this.smoothedEnergy < silenceThreshold) {
      if (this.silenceStartTime === 0) this.silenceStartTime = now;
      const silenceDuration = now - this.silenceStartTime;
      if (silenceDuration >= this.pauseDuration) {
        this.isSpeaking = false;
        this.segmentCount++;
        this.speechStartTime = 0;
        this.onPauseDetected({
          segmentCount: this.segmentCount,
          silenceDuration,
          timestamp: now,
        });
        this.silenceStartTime = 0;
      }
    } else if (this.smoothedEnergy > silenceThreshold) {
      if (this.isSpeaking) this.silenceStartTime = 0;
    } else {
      this.speechStartTime = 0;
      if (this.smoothedEnergy < this.noiseFloor * 1.5) {
        this.noiseFloor = 0.998 * this.noiseFloor + 0.002 * this.smoothedEnergy;
      }
    }
  }

  async disconnect(): Promise<void> {
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
      } catch (_) { /* ignore leave errors */ }
      this.meeting = null;
    }

    this._mediaStream = null;
    this.analyserNode = null;
    this.timeDomainData = null;
    this.isConnected = false;
    this.onDisconnected();
  }

  getMediaStream(): MediaStream | null {
    return this._mediaStream;
  }

  async sendControlMessage(message: object): Promise<void> {
    if (!this.meeting) throw new Error('Not connected');
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
