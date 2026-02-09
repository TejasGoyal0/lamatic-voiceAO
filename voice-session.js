/**
 * Voice Session - Integration of VoiceCapture + RealtimeKitTransport
 * 
 * =============================================================================
 * INITIALIZATION ORDER (CRITICAL)
 * =============================================================================
 * 
 * 1. RealtimeKitTransport.connect()  ← SDK acquires microphone, owns MediaStream
 * 2. transport.getMediaStream()      ← Get MediaStream from SDK
 * 3. VoiceCapture.startWithMediaStream(stream) ← Analyze without owning
 * 
 * This order ensures:
 * - WebRTC has full control of the MediaStreamTrack
 * - VoiceCapture only taps into the stream for analysis
 * - No conflicts over getUserMedia or track lifecycle
 * 
 * =============================================================================
 * DATA FLOW
 * =============================================================================
 * 
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                              BROWSER                                    │
 * │                                                                         │
 * │  ┌───────────────────────────────────────────────────────────────────┐  │
 * │  │ RealtimeKitTransport (OWNS MEDIASTREAM)                           │  │
 * │  │                                                                   │  │
 * │  │   Microphone ──▶ SDK ──▶ MediaStream ──┬──▶ WebRTC ──▶ SFU       │  │
 * │  │                                        │                          │  │
 * │  │                                        │ getMediaStream()         │  │
 * │  └────────────────────────────────────────│──────────────────────────┘  │
 * │                                           │                             │
 * │                                           ▼                             │
 * │  ┌───────────────────────────────────────────────────────────────────┐  │
 * │  │ VoiceCapture (ANALYSIS ONLY)                                      │  │
 * │  │                                                                   │  │
 * │  │   MediaStream ──▶ AudioContext ──▶ AnalyserNode ──▶ VAD/Pause    │  │
 * │  │                                                                   │  │
 * │  │   onPauseDetected() ──┬──▶ UI Update                             │  │
 * │  │                       │                                           │  │
 * │  │                       └──▶ transport.sendControlMessage()        │  │
 * │  └───────────────────────────────────────────────────────────────────┘  │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * Key Points:
 * - Audio flows CONTINUOUSLY to SFU (never stopped on pause)
 * - Pause detection is a SEMANTIC signal, not a transport event
 * - Control messages notify other participants of pause/speech events
 * - VAD runs entirely on-device, no cloud dependency
 * 
 * =============================================================================
 */

/**
 * Create an integrated voice session
 * 
 * @param {string} authToken - From Cloudflare RealtimeKit API
 * @returns {Object} Session controller { start, stop, getState }
 */
async function createVoiceSession(authToken) {
  let voiceCapture = null;
  let transport = null;

  // Create transport (will own MediaStream)
  transport = new RealtimeKitTransport({
    authToken,
    
    onConnected: (info) => {
      console.log('✓ RealtimeKit connected', info);
    },
    
    onDisconnected: ({ reason }) => {
      console.log('✗ Disconnected:', reason);
      // Stop voice capture when transport disconnects
      if (voiceCapture?.isRunning) {
        voiceCapture.stop();
      }
    },
    
    onControlMessage: (message, meta) => {
      console.log('← Control message:', message, 'from:', meta.from);
    },
    
    onError: (error) => {
      console.error('Transport error:', error);
    },
  });

  // Create voice capture (will receive MediaStream from transport)
  voiceCapture = new VoiceCapture({
    onPauseDetected: async (data) => {
      console.log(`⏸ Pause detected: segment ${data.segmentCount}`);
      
      // Send control message through RealtimeKit
      if (transport.isConnected) {
        await transport.sendControlMessage({
          type: 'PAUSE',
          segment: data.segmentCount,
          silenceDuration: data.silenceDuration,
          timestamp: data.timestamp,
        });
      }
    },
    
    onSpeechStart: async (data) => {
      console.log('🎤 Speech started');
      
      if (transport.isConnected) {
        await transport.sendControlMessage({
          type: 'SPEECH_START',
          timestamp: data.timestamp,
        });
      }
    },
    
    // VAD settings
    silenceThreshold: 0.015,
    noiseMargin: 2.5,
    pauseDuration: 3000,
    calibrationDuration: 500,
  });

  return {
    voiceCapture,
    transport,
    
    /**
     * Start the voice session
     * 
     * Order:
     * 1. Transport connects and acquires MediaStream
     * 2. VoiceCapture receives MediaStream for analysis
     */
    async start() {
      // Step 1: Connect transport - SDK acquires microphone
      await transport.connect();
      console.log('✓ Transport connected, audio streaming');
      
      // Step 2: Get MediaStream from transport
      const mediaStream = transport.getMediaStream();
      
      if (!mediaStream) {
        throw new Error('Failed to get MediaStream from transport');
      }
      
      // Step 3: Start voice capture with external stream (analysis only)
      await voiceCapture.startWithMediaStream(mediaStream);
      console.log('✓ Voice capture started (analysis mode)');
    },
    
    /**
     * Stop the voice session
     */
    async stop() {
      // Stop analysis first
      if (voiceCapture?.isRunning) {
        voiceCapture.stop();
      }
      
      // Then disconnect transport (releases microphone)
      await transport.disconnect();
      
      console.log('✓ Session ended');
    },
    
    /**
     * Get combined state
     */
    getState() {
      return {
        voiceCapture: voiceCapture?.getState() ?? null,
        transport: transport?.getState() ?? null,
      };
    },
  };
}

// Export
window.createVoiceSession = createVoiceSession;

/**
 * =============================================================================
 * USAGE EXAMPLE
 * =============================================================================
 * 
 * // In your HTML:
 * <script src="voice-capture.js"></script>
 * <script src="realtimekit-transport.js"></script>
 * <script src="voice-session.js"></script>
 * 
 * <script>
 * async function startSession() {
 *   // 1. Get auth token from your backend
 *   const { token } = await fetch('/api/join').then(r => r.json());
 *   
 *   // 2. Create session
 *   const session = await createVoiceSession(token);
 *   
 *   // 3. Start (transport connects first, then voice capture starts)
 *   await session.start();
 *   
 *   // Now:
 *   // - Audio is streaming to Cloudflare SFU
 *   // - VAD + pause detection runs locally
 *   // - Control messages sent on pause/speech events
 *   
 *   // To stop:
 *   // await session.stop();
 * }
 * </script>
 * 
 * =============================================================================
 * STANDALONE MODE (no RealtimeKit)
 * =============================================================================
 * 
 * For testing without RealtimeKit, use VoiceCapture directly:
 * 
 * const voiceCapture = new VoiceCapture({
 *   onPauseDetected: (data) => console.log('Pause:', data),
 *   onEnergyUpdate: (energy, speaking) => { ... }
 * });
 * 
 * // This will call getUserMedia internally (deprecated but works)
 * await voiceCapture.start();
 */
