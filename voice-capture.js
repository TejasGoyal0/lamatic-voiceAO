/**
 * VoiceCapture v3 - On-device voice analysis (VAD + pause detection)
 * 
 * =============================================================================
 * MEDIASTREAM OWNERSHIP
 * =============================================================================
 * 
 * This module does NOT own the microphone. It receives an external MediaStream
 * and performs audio analysis only. This design allows:
 * 
 * 1. RealtimeKitTransport to own getUserMedia (via SDK)
 * 2. WebRTC track lifecycle managed by the SDK
 * 3. VoiceCapture to analyze audio without interfering with WebRTC
 * 
 * Data Flow:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  RealtimeKitTransport                                                   │
 * │  └── SDK.enableAudio() → getUserMedia → MediaStream (owned by SDK)      │
 * │                                              │                          │
 * │                                              │ getMediaStream()         │
 * │                                              ▼                          │
 * │  VoiceCapture.startWithMediaStream(stream)                              │
 * │  └── AudioContext.createMediaStreamSource(stream) → Analysis only       │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * IMPORTANT: VoiceCapture does NOT call navigator.mediaDevices.getUserMedia.
 * IMPORTANT: VoiceCapture does NOT stop MediaStream tracks on cleanup.
 * 
 * =============================================================================
 * 
 * Features:
 * - Adaptive noise floor calibration
 * - Hysteresis to prevent state flickering
 * - Exponential moving average for stable energy readings
 * - Single-fire pause detection (no repeated triggers)
 * - Throttled analysis loop for lower CPU usage
 */

class VoiceCapture {
  /**
   * @param {Object} config - Configuration options
   * @param {Function} config.onPauseDetected - Called once when pause is confirmed
   * @param {Function} config.onSpeechStart - Called when speech begins after silence
   * @param {Function} config.onEnergyUpdate - Called with energy data for visualization
   * @param {number} config.silenceThreshold - Base RMS threshold (default: 0.015)
   * @param {number} config.noiseMargin - Multiplier above noise floor (default: 2.5)
   * @param {number} config.pauseDuration - Silence ms to trigger pause (default: 3000)
   * @param {number} config.speechMinDuration - Min speech ms before pause can trigger (default: 300)
   * @param {number} config.calibrationDuration - Noise floor calibration ms (default: 500)
   * @param {number} config.analysisInterval - Ms between analyses (default: 50)
   * @param {number} config.smoothingFactor - EMA smoothing 0-1, higher = more smoothing (default: 0.7)
   */
  constructor(config = {}) {
    // Core callbacks
    this.onPauseDetected = config.onPauseDetected ?? (() => {});
    this.onSpeechStart = config.onSpeechStart ?? (() => {});
    this.onEnergyUpdate = config.onEnergyUpdate ?? (() => {});

    // Detection thresholds
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

    // Audio pipeline (analysis only - no ownership of stream)
    this.audioContext = null;
    this.sourceNode = null;
    this.analyserNode = null;
    
    // External MediaStream reference (NOT owned by this class)
    this._externalMediaStream = null;
    
    // Analysis buffer (pre-allocated)
    this.timeDomainData = null;
    
    // Noise floor calibration
    this.noiseFloor = this.config.silenceThreshold;
    this.isCalibrating = false;
    this.calibrationSamples = [];
    
    // Adaptive thresholds
    this.effectiveThreshold = this.config.silenceThreshold;
    this.speechThreshold = this.effectiveThreshold * this.config.hysteresisRatio;
    
    // VAD state machine: 'idle' | 'calibrating' | 'silence' | 'speaking'
    this.state = 'idle';
    this.stateStartTime = 0;
    
    // Energy tracking
    this.smoothedEnergy = 0;
    this.peakEnergy = 0;
    
    // Pause detection
    this.silenceStartTime = null;
    this.lastSpeechTime = null;
    this.pauseTriggered = false;
    this.segmentCount = 0;
    
    // Timing
    this.lastAnalysisTime = 0;
    this.animationFrameId = null;
    this.isRunning = false;
  }

  /**
   * Start voice analysis with an EXTERNAL MediaStream
   * 
   * This is the primary entry point when MediaStream is owned by another module
   * (e.g., RealtimeKitTransport). Does NOT call getUserMedia.
   * 
   * @param {MediaStream} mediaStream - External MediaStream with audio track
   * @throws {Error} If mediaStream has no audio tracks
   */
  async startWithMediaStream(mediaStream) {
    if (this.isRunning) {
      console.warn('VoiceCapture already running');
      return;
    }

    // Validate external stream
    if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
      throw new Error('MediaStream with at least one audio track is required');
    }

    // Store reference (NOT owned - do not stop tracks on cleanup)
    this._externalMediaStream = mediaStream;

    // Create AudioContext for analysis
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      // Try to match stream sample rate if available
      sampleRate: mediaStream.getAudioTracks()[0].getSettings?.().sampleRate || 48000
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Build analysis graph from external stream
    this._buildAudioGraph(mediaStream);
    
    // Initialize state
    this.isRunning = true;
    this.smoothedEnergy = 0;
    this.peakEnergy = 0;
    this.silenceStartTime = null;
    this.lastSpeechTime = null;
    this.pauseTriggered = false;
    this.segmentCount = 0;
    
    // Start calibration phase
    this._startCalibration();
    
    // Begin analysis loop
    this._startAnalysisLoop();

    console.log('VoiceCapture started (external stream)', {
      sampleRate: this.audioContext.sampleRate,
      trackLabel: mediaStream.getAudioTracks()[0].label
    });
  }

  /**
   * Legacy method: Start with internal getUserMedia
   * 
   * DEPRECATED: Use startWithMediaStream() instead when integrating with
   * RealtimeKitTransport. This method exists for standalone testing only.
   * 
   * @deprecated
   */
  async start() {
    if (this.isRunning) {
      console.warn('VoiceCapture already running');
      return;
    }

    console.warn(
      'VoiceCapture.start() is deprecated. ' +
      'Use startWithMediaStream(stream) for RealtimeKit integration.'
    );

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices API unavailable. Use HTTPS or localhost.');
    }

    try {
      // Acquire microphone (only for standalone mode)
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1
        },
        video: false
      });

      // Use the common path
      await this.startWithMediaStream(mediaStream);
      
      // Mark that we own this stream (for cleanup)
      this._ownsMediaStream = true;

    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /**
   * Build Web Audio analysis graph from MediaStream
   * 
   * @param {MediaStream} mediaStream - Stream to analyze
   */
  _buildAudioGraph(mediaStream) {
    // Create source from external stream
    // This taps into the stream for analysis without modifying it
    this.sourceNode = this.audioContext.createMediaStreamSource(mediaStream);

    // Analyser node for RMS energy computation
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0; // We apply our own EMA
    
    // Pre-allocate buffer
    this.timeDomainData = new Float32Array(this.analyserNode.fftSize);

    // Connect: source → analyser (no destination = analysis only, no playback)
    this.sourceNode.connect(this.analyserNode);
    
    // Note: NOT connecting to audioContext.destination
    // Audio goes to WebRTC via the original MediaStream, not through this graph
  }

  /**
   * Start noise floor calibration
   */
  _startCalibration() {
    this.state = 'calibrating';
    this.stateStartTime = performance.now();
    this.calibrationSamples = [];
    this.isCalibrating = true;
    console.log('Calibrating noise floor...');
  }

  /**
   * Finish calibration and compute adaptive threshold
   */
  _finishCalibration() {
    this.isCalibrating = false;
    
    if (this.calibrationSamples.length > 0) {
      // Use median (robust to outliers)
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
        silenceThreshold: this.effectiveThreshold.toFixed(4),
        speechThreshold: this.speechThreshold.toFixed(4)
      });
    }
    
    this.state = 'silence';
    this.stateStartTime = performance.now();
    this.calibrationSamples = [];
  }

  /**
   * Compute RMS energy
   */
  _computeRMS(samples) {
    let sum = 0;
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / len);
  }

  /**
   * Apply exponential moving average smoothing
   */
  _smoothEnergy(rawEnergy) {
    this.smoothedEnergy = 
      this.config.smoothingFactor * this.smoothedEnergy +
      (1 - this.config.smoothingFactor) * rawEnergy;
    
    this.peakEnergy = Math.max(this.peakEnergy * 0.995, rawEnergy);
    
    return this.smoothedEnergy;
  }

  /**
   * Throttled analysis loop
   */
  _startAnalysisLoop() {
    const analyze = (timestamp) => {
      if (!this.isRunning) return;

      const elapsed = timestamp - this.lastAnalysisTime;
      if (elapsed < this.config.analysisInterval) {
        this.animationFrameId = requestAnimationFrame(analyze);
        return;
      }
      this.lastAnalysisTime = timestamp;

      this.analyserNode.getFloatTimeDomainData(this.timeDomainData);
      const rawEnergy = this._computeRMS(this.timeDomainData);
      const energy = this._smoothEnergy(rawEnergy);

      const now = performance.now();
      
      if (this.state === 'calibrating') {
        this.calibrationSamples.push(rawEnergy);
        if (now - this.stateStartTime >= this.config.calibrationDuration) {
          this._finishCalibration();
        }
      } else {
        this._processVAD(energy, now);
      }

      this.onEnergyUpdate(energy, this.state === 'speaking', {
        rawEnergy,
        smoothedEnergy: this.smoothedEnergy,
        threshold: this.effectiveThreshold,
        speechThreshold: this.speechThreshold,
        noiseFloor: this.noiseFloor,
        state: this.state
      });

      this.animationFrameId = requestAnimationFrame(analyze);
    };

    this.animationFrameId = requestAnimationFrame(analyze);
  }

  /**
   * Voice Activity Detection with hysteresis
   */
  _processVAD(energy, now) {
    const wasSpeaking = this.state === 'speaking';
    
    let isSpeaking;
    if (wasSpeaking) {
      isSpeaking = energy > this.effectiveThreshold;
    } else {
      isSpeaking = energy > this.speechThreshold;
    }

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
            : 0
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
      
      this._checkPause(now);
    }
  }

  /**
   * Check if silence constitutes a pause
   */
  _checkPause(now) {
    if (this.pauseTriggered) return;
    if (this.lastSpeechTime === null) return;
    
    const silenceDuration = now - this.silenceStartTime;
    
    if (silenceDuration >= this.config.pauseDuration) {
      this.pauseTriggered = true;
      this.segmentCount++;
      
      this.onPauseDetected({
        segmentCount: this.segmentCount,
        silenceDuration: silenceDuration / 1000,
        timestamp: Date.now(),
        noiseFloor: this.noiseFloor,
        threshold: this.effectiveThreshold
      });
    }
  }

  /**
   * Stop analysis and release resources
   * 
   * IMPORTANT: Does NOT stop MediaStream tracks if using external stream.
   * Track lifecycle is managed by the stream owner (RealtimeKitTransport).
   */
  stop() {
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

    // Only stop tracks if we own the stream (legacy start() mode)
    if (this._ownsMediaStream && this._externalMediaStream) {
      this._externalMediaStream.getTracks().forEach(track => track.stop());
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

  /**
   * Manually recalibrate noise floor
   */
  recalibrate() {
    if (!this.isRunning) return;
    this._startCalibration();
  }

  /**
   * Update config at runtime
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
    
    if (newConfig.noiseMargin || newConfig.silenceThreshold) {
      this.effectiveThreshold = Math.max(
        this.noiseFloor * this.config.noiseMargin,
        this.config.silenceThreshold
      );
      this.speechThreshold = this.effectiveThreshold * this.config.hysteresisRatio;
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isRunning: this.isRunning,
      state: this.state,
      noiseFloor: this.noiseFloor,
      effectiveThreshold: this.effectiveThreshold,
      speechThreshold: this.speechThreshold,
      smoothedEnergy: this.smoothedEnergy,
      segmentCount: this.segmentCount,
      pauseTriggered: this.pauseTriggered
    };
  }
}

window.VoiceCapture = VoiceCapture;
