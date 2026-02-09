/**
 * RealtimeKitTransport - Audio transport via Cloudflare RealtimeKit
 * 
 * =============================================================================
 * MEDIASTREAM OWNERSHIP
 * =============================================================================
 * 
 * This module OWNS the MediaStream. It:
 * 1. Initializes RealtimeKit SDK
 * 2. Calls enableAudio() which triggers getUserMedia internally
 * 3. Exposes the MediaStream via getMediaStream() for external analysis
 * 
 * Data Flow:
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  RealtimeKitTransport (OWNS MEDIASTREAM)                                │
 * │                                                                         │
 * │  connect() → SDK.init() → SDK.join() → SDK.self.enableAudio()          │
 * │                                              │                          │
 * │                                              ▼                          │
 * │                              getUserMedia (handled by SDK internally)   │
 * │                                              │                          │
 * │                                              ▼                          │
 * │                              MediaStream (owned by SDK)                 │
 * │                                    │                │                   │
 * │                                    │                │                   │
 * │                                    ▼                ▼                   │
 * │                            WebRTC/SFU        getMediaStream()           │
 * │                            (streaming)       (for VoiceCapture)         │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * Why SDK owns getUserMedia:
 * - SDK manages track lifecycle (add/remove from peer connection)
 * - SDK handles track replacement on device change
 * - SDK manages Opus encoding parameters
 * - Avoids race conditions between external stream and WebRTC
 * 
 * =============================================================================
 */

class RealtimeKitTransport {
  /**
   * @param {Object} config
   * @param {string} config.authToken - Participant auth token from Cloudflare API
   * @param {Function} config.onConnected - Called when joined and audio is streaming
   * @param {Function} config.onDisconnected - Called on disconnect (with reason)
   * @param {Function} config.onControlMessage - Called when receiving control messages
   * @param {Function} config.onError - Called on errors
   */
  constructor(config) {
    this.authToken = config.authToken;
    this.onConnected = config.onConnected ?? (() => {});
    this.onDisconnected = config.onDisconnected ?? (() => {});
    this.onControlMessage = config.onControlMessage ?? (() => {});
    this.onError = config.onError ?? console.error;

    // RealtimeKit meeting object
    this.meeting = null;
    
    // Connection state
    this.isConnected = false;
    
    // MediaStream acquired by SDK (exposed via getter)
    this._mediaStream = null;
  }

  /**
   * Connect to RealtimeKit and start audio streaming
   * 
   * This method:
   * 1. Initializes the SDK
   * 2. Joins the meeting
   * 3. Enables audio (SDK acquires microphone via getUserMedia)
   * 4. Makes MediaStream available via getMediaStream()
   * 
   * @returns {Promise<void>}
   */
  async connect() {
    // Dynamic import - only load SDK when needed
    const { RTKClient } = await import('@cloudflare/realtimekit');
    
    try {
      // Initialize SDK with auth token
      this.meeting = await RTKClient.init({
        authToken: this.authToken,
        
        // Start with audio/video disabled - we enable audio explicitly below
        defaults: {
          audio: false,
          video: false,
        },
        
        onError: (error) => {
          this.onError(error);
        },
        
        modules: {
          devTools: {
            logs: false, // Set true for debugging
          },
        },
      });

      // Set up event listeners
      this._setupEventListeners();

      // Join the meeting room
      await this.meeting.join();

      // Enable audio - SDK will call getUserMedia internally
      // This is the key step where SDK acquires and owns the MediaStream
      await this.meeting.self.enableAudio();

      // Get the MediaStream from SDK for external analysis
      // The audioTrack is a MediaStreamTrack owned by the SDK
      await this._acquireMediaStreamFromSDK();

      this.isConnected = true;
      
      this.onConnected({
        meetingId: this.meeting.meta.meetingId,
        participantId: this.meeting.self.userId,
      });

      console.log('RealtimeKitTransport connected', {
        meetingId: this.meeting.meta.meetingId,
        audioEnabled: this.meeting.self.audioEnabled,
        hasMediaStream: !!this._mediaStream
      });

    } catch (error) {
      this.onError(error);
      throw error;
    }
  }

  /**
   * Acquire MediaStream from SDK after audio is enabled
   * 
   * The SDK exposes audioTrack as a MediaStreamTrack. We wrap it in a
   * MediaStream so VoiceCapture can use it with Web Audio API.
   */
  async _acquireMediaStreamFromSDK() {
    // Wait for audioTrack to be available
    const audioTrack = this.meeting.self.audioTrack;
    
    if (!audioTrack) {
      // Audio might not be enabled yet - this shouldn't happen if called after enableAudio()
      throw new Error('Audio track not available from SDK');
    }

    // Create MediaStream from the SDK's audio track
    // This allows VoiceCapture to tap into the same audio without interference
    this._mediaStream = new MediaStream([audioTrack]);
    
    console.log('MediaStream acquired from SDK', {
      trackId: audioTrack.id,
      trackLabel: audioTrack.label,
      trackEnabled: audioTrack.enabled
    });
  }

  /**
   * Get the MediaStream owned by the SDK
   * 
   * Call this AFTER connect() completes. Returns the MediaStream containing
   * the audio track that is being sent to the SFU.
   * 
   * @returns {MediaStream|null} MediaStream with audio track, or null if not connected
   */
  getMediaStream() {
    return this._mediaStream;
  }

  /**
   * Set up RealtimeKit event listeners
   */
  _setupEventListeners() {
    // Room left
    this.meeting.self.on('roomLeft', ({ state }) => {
      this.isConnected = false;
      this._mediaStream = null;
      this.onDisconnected({ reason: state });
    });

    // Audio track updates (device change, etc.)
    this.meeting.self.on('audioUpdate', () => {
      // Re-acquire MediaStream when track changes
      if (this.meeting.self.audioEnabled && this.meeting.self.audioTrack) {
        this._mediaStream = new MediaStream([this.meeting.self.audioTrack]);
        console.log('MediaStream updated after audio change');
      }
    });

    // Chat messages (used for control channel)
    this.meeting.chat.on('chatUpdate', ({ message }) => {
      if (message.type === 'text' && message.message.startsWith('{')) {
        try {
          const control = JSON.parse(message.message);
          this.onControlMessage(control, {
            from: message.userId,
            timestamp: message.time,
          });
        } catch {
          // Not a JSON control message
        }
      }
    });

    // Connection quality
    this.meeting.self.on('mediaScoreUpdate', ({ kind, score }) => {
      if (kind === 'audio' && score < 5) {
        console.warn('Audio quality degraded:', score);
      }
    });
  }

  /**
   * Send a control message to all participants
   * 
   * @param {Object} message - Control message payload
   */
  async sendControlMessage(message) {
    if (!this.isConnected || !this.meeting) {
      console.warn('Cannot send control message: not connected');
      return;
    }

    const payload = JSON.stringify(message);
    await this.meeting.chat.sendTextMessage(payload);
  }

  /**
   * Mute audio
   */
  async mute() {
    if (this.meeting?.self.audioEnabled) {
      await this.meeting.self.disableAudio();
    }
  }

  /**
   * Unmute audio
   */
  async unmute() {
    if (this.meeting && !this.meeting.self.audioEnabled) {
      await this.meeting.self.enableAudio();
      // Re-acquire stream after unmute
      await this._acquireMediaStreamFromSDK();
    }
  }

  /**
   * Disconnect and clean up
   */
  async disconnect() {
    if (this.meeting) {
      try {
        await this.meeting.leave();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.meeting = null;
    }
    this.isConnected = false;
    this._mediaStream = null;
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isConnected: this.isConnected,
      audioEnabled: this.meeting?.self.audioEnabled ?? false,
      roomState: this.meeting?.self.roomState ?? 'disconnected',
      meetingId: this.meeting?.meta.meetingId ?? null,
      hasMediaStream: !!this._mediaStream,
    };
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RealtimeKitTransport;
}
window.RealtimeKitTransport = RealtimeKitTransport;
