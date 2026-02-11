'use client';

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

  async connect(): Promise<void> {
    const RealtimeKitClient = (await import('@cloudflare/realtimekit')).default;

    try {
      this.meeting = await RealtimeKitClient.init({
        authToken: this.authToken,
        defaults: { audio: false, video: false },
        modules: { devTools: { logs: false } },
      });

      this.setupEventListeners();
      await this.meeting!.join();
      await this.meeting!.self.enableAudio();
      await this.acquireMediaStreamFromSDK();

      this.isConnected = true;
      this.onConnected({
        meetingId: this.meeting!.meta.meetingId,
        participantId: this.meeting!.self.userId,
      });
    } catch (error) {
      this.onError(error as Error);
      throw error;
    }
  }

  private async acquireMediaStreamFromSDK(): Promise<void> {
    if (!this.meeting) throw new Error('Meeting not initialized');
    const audioTrack = this.meeting.self.audioTrack;
    if (!audioTrack) throw new Error('Audio track not available from SDK');
    this._mediaStream = new MediaStream([audioTrack]);
  }

  getMediaStream(): MediaStream | null {
    return this._mediaStream;
  }

  private setupEventListeners(): void {
    if (!this.meeting) return;

    this.meeting.self.on('roomLeft', ({ state }: { state: string }) => {
      this.isConnected = false;
      this._mediaStream = null;
      this.onDisconnected({ reason: state });
    });

    this.meeting.self.on('audioUpdate', () => {
      if (this.meeting?.self.audioEnabled && this.meeting.self.audioTrack) {
        this._mediaStream = new MediaStream([this.meeting.self.audioTrack]);
      }
    });

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

    this.meeting.self.on('mediaScoreUpdate', ({ kind, score }: { kind: string; score: number }) => {
      if (kind === 'audio' && score < 5) {
        console.warn('[RealtimeKit] Audio quality degraded:', score);
      }
    });
  }

  async sendControlMessage(message: ControlMessage): Promise<void> {
    if (!this.isConnected || !this.meeting) return;
    const payload = JSON.stringify(message);
    await this.meeting.chat.sendTextMessage(payload);
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
      try { await this.meeting.leave(); } catch { /* ignore cleanup errors */ }
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
