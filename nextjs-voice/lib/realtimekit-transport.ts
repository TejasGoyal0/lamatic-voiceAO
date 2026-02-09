'use client';

/**
 * RealtimeKitTransport - Audio transport via Cloudflare RealtimeKit
 * 
 * =============================================================================
 * CLIENT-ONLY MODULE
 * =============================================================================
 * 
 * This module uses the Cloudflare RealtimeKit SDK and must only run in browser.
 * The 'use client' directive ensures Next.js doesn't try to import SDK on server.
 * 
 * MEDIASTREAM OWNERSHIP:
 * - This module OWNS the MediaStream (acquired via SDK's enableAudio())
 * - Exposes stream via getMediaStream() for VoiceCapture analysis
 * - SDK manages WebRTC track lifecycle internally
 * 
 * =============================================================================
 */

export interface RealtimeKitTransportConfig {
  authToken: string;
  onConnected?: (info: ConnectionInfo) => void;
  onDisconnected?: (info: DisconnectionInfo) => void;
  onControlMessage?: (message: ControlMessage, meta: MessageMeta) => void;
  onError?: (error: Error) => void;
}

export interface ConnectionInfo {
  meetingId: string;
  participantId: string;
}

export interface DisconnectionInfo {
  reason: string;
}

export interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

export interface MessageMeta {
  from: string;
  timestamp: Date;
}

export interface TransportState {
  isConnected: boolean;
  audioEnabled: boolean;
  roomState: string;
  meetingId: string | null;
  hasMediaStream: boolean;
}

// RealtimeKit SDK types (minimal, for internal use)
interface RTKMeeting {
  join(): Promise<void>;
  leave(): Promise<void>;
  self: {
    id: string;
    userId: string;
    audioEnabled: boolean;
    audioTrack: MediaStreamTrack | null;
    roomState: string;
    enableAudio(): Promise<void>;
    disableAudio(): Promise<void>;
    on(event: string, handler: (data: any) => void): void;
    off(event: string, handler: (data: any) => void): void;
  };
  meta: {
    meetingId: string;
  };
  chat: {
    sendTextMessage(message: string): Promise<void>;
    on(event: string, handler: (data: any) => void): void;
    off(event: string, handler: (data: any) => void): void;
  };
}

interface RTKClient {
  init(config: any): Promise<RTKMeeting>;
}

export class RealtimeKitTransport {
  private authToken: string;
  private onConnected: (info: ConnectionInfo) => void;
  private onDisconnected: (info: DisconnectionInfo) => void;
  private onControlMessage: (message: ControlMessage, meta: MessageMeta) => void;
  private onError: (error: Error) => void;

  private meeting: RTKMeeting | null = null;
  public isConnected = false;
  private _mediaStream: MediaStream | null = null;

  constructor(config: RealtimeKitTransportConfig) {
    this.authToken = config.authToken;
    this.onConnected = config.onConnected ?? (() => {});
    this.onDisconnected = config.onDisconnected ?? (() => {});
    this.onControlMessage = config.onControlMessage ?? (() => {});
    this.onError = config.onError ?? console.error;
  }

  /**
   * Connect to RealtimeKit and start audio streaming
   * 
   * Execution order:
   * 1. Dynamic import SDK (client-only)
   * 2. Initialize with auth token
   * 3. Join meeting room
   * 4. Enable audio (SDK acquires microphone)
   * 5. Expose MediaStream for external analysis
   */
  async connect(): Promise<void> {
    // Dynamic import - SDK only loads in browser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RealtimeKitClient = (await import('@cloudflare/realtimekit')).default;

    try {
      // Initialize SDK - RealtimeKitClient is the default export
      this.meeting = await RealtimeKitClient.init({
        authToken: this.authToken,
        defaults: {
          audio: false, // Enable manually below
          video: false, // Audio-only
        },
        modules: {
          devTools: {
            logs: false,
          },
        },
      });

      this.setupEventListeners();

      // Join the meeting
      await this.meeting!.join();

      // Enable audio - SDK calls getUserMedia internally
      await this.meeting!.self.enableAudio();

      // Get MediaStream from SDK for external analysis
      await this.acquireMediaStreamFromSDK();

      this.isConnected = true;

      this.onConnected({
        meetingId: this.meeting!.meta.meetingId,
        participantId: this.meeting!.self.userId,
      });

      console.log('RealtimeKitTransport connected', {
        meetingId: this.meeting!.meta.meetingId,
        audioEnabled: this.meeting!.self.audioEnabled,
      });
    } catch (error) {
      this.onError(error as Error);
      throw error;
    }
  }

  /**
   * Acquire MediaStream from SDK after audio is enabled
   */
  private async acquireMediaStreamFromSDK(): Promise<void> {
    if (!this.meeting) throw new Error('Meeting not initialized');

    const audioTrack = this.meeting.self.audioTrack;

    if (!audioTrack) {
      throw new Error('Audio track not available from SDK');
    }

    // Wrap SDK's track in MediaStream for VoiceCapture
    this._mediaStream = new MediaStream([audioTrack]);

    console.log('MediaStream acquired from SDK', {
      trackId: audioTrack.id,
      trackLabel: audioTrack.label,
    });
  }

  /**
   * Get MediaStream owned by SDK
   * Call AFTER connect() completes
   */
  getMediaStream(): MediaStream | null {
    return this._mediaStream;
  }

  private setupEventListeners(): void {
    if (!this.meeting) return;

    // Room left
    this.meeting.self.on('roomLeft', ({ state }: { state: string }) => {
      this.isConnected = false;
      this._mediaStream = null;
      this.onDisconnected({ reason: state });
    });

    // Audio track updates
    this.meeting.self.on('audioUpdate', () => {
      if (this.meeting?.self.audioEnabled && this.meeting.self.audioTrack) {
        this._mediaStream = new MediaStream([this.meeting.self.audioTrack]);
        console.log('MediaStream updated after audio change');
      }
    });

    // Chat messages (control channel)
    this.meeting.chat.on('chatUpdate', ({ message }: { message: any }) => {
      if (message.type === 'text' && message.message.startsWith('{')) {
        try {
          const control = JSON.parse(message.message) as ControlMessage;
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
    this.meeting.self.on('mediaScoreUpdate', ({ kind, score }: { kind: string; score: number }) => {
      if (kind === 'audio' && score < 5) {
        console.warn('Audio quality degraded:', score);
      }
    });
  }

  /**
   * Send control message to all participants
   */
  async sendControlMessage(message: ControlMessage): Promise<void> {
    if (!this.isConnected || !this.meeting) {
      console.warn('Cannot send control message: not connected');
      return;
    }

    const payload = JSON.stringify(message);
    console.log('📨 RealtimeKit sendControlMessage:');
    console.log('  Type:', message.type);
    console.log('  Payload:', payload);
    
    try {
      await this.meeting.chat.sendTextMessage(payload);
      console.log('✓ Message sent via chat channel');
    } catch (error) {
      console.error('✗ Failed to send message:', error);
      throw error;
    }
  }

  async mute(): Promise<void> {
    if (this.meeting?.self.audioEnabled) {
      await this.meeting.self.disableAudio();
    }
  }

  async unmute(): Promise<void> {
    if (this.meeting && !this.meeting.self.audioEnabled) {
      await this.meeting.self.enableAudio();
      await this.acquireMediaStreamFromSDK();
    }
  }

  async disconnect(): Promise<void> {
    if (this.meeting) {
      try {
        await this.meeting.leave();
      } catch {
        // Ignore cleanup errors
      }
      this.meeting = null;
    }
    this.isConnected = false;
    this._mediaStream = null;
  }

  getState(): TransportState {
    return {
      isConnected: this.isConnected,
      audioEnabled: this.meeting?.self.audioEnabled ?? false,
      roomState: this.meeting?.self.roomState ?? 'disconnected',
      meetingId: this.meeting?.meta.meetingId ?? null,
      hasMediaStream: !!this._mediaStream,
    };
  }
}
