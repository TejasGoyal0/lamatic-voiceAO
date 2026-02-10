'use client';

/**
 * APPROACH 1: Lamatic Client
 * 
 * Sends audio to Lamatic webhook for processing.
 * Lamatic handles: STT (ElevenLabs) → LLM → TTS (ElevenLabs)
 * 
 * NO Cloudflare RealtimeKit dependencies.
 */

export interface LamaticClientConfig {
  webhookUrl?: string;
  onResponse?: (response: LamaticResponse) => void;
  onError?: (error: Error) => void;
}

export interface LamaticResponse {
  success: boolean;
  transcript?: string;
  text?: string;
  audio?: string; // Base64 audio returned by proxy
  error?: string;
  status?: string;
}

export class LamaticClient {
  /**
   * Play base64 audio in the browser
   */
  static async playAudio(base64: string): Promise<void> {
    console.log(`🔊 [LamaticClient] Playing audio (${base64.length} chars)...`);
    try {
      // Create a blob from base64
      const binaryString = window.atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/mpeg' }); // ElevenLabs usually returns MP3
      const url = URL.createObjectURL(blob);
      
      const audio = new Audio(url);
      await audio.play();
      
      // Cleanup URL after playing
      audio.onended = () => URL.revokeObjectURL(url);
    } catch (error) {
      console.error('❌ [LamaticClient] Error playing audio:', error);
    }
  }
  private webhookUrl: string;
  private onResponse: (response: LamaticResponse) => void;
  private onError: (error: Error) => void;

  constructor(config: LamaticClientConfig = {}) {
    // Default webhook URL
    this.webhookUrl = config.webhookUrl ?? 'https://hooks.lamatic.ai/hook/e6318509-e57e-452f-b117-eee35611ac6f';
    this.onResponse = config.onResponse ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  /**
   * Send audio blob to Lamatic for processing
   */
  async sendAudio(audioBlob: Blob): Promise<LamaticResponse> {
    console.log(`📤 [LamaticClient] Sending base64 audio to Lamatic proxy... (${audioBlob.size} bytes)`);

    try {
      // Convert blob to base64
      const base64Audio = await this.blobToBase64(audioBlob);
      
      const response = await fetch('/api/lamatic', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioData: base64Audio,
        }),
      });

      console.log(`📥 [LamaticClient] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Lamatic request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log('✓ [LamaticClient] Response received:', data);
      this.onResponse(data);
      return data;

    } catch (error) {
      console.error('❌ [LamaticClient] Error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  /**
   * Send text message to Lamatic
   */
  async sendText(text: string): Promise<LamaticResponse> {
    console.log(`📤 [LamaticClient] Sending text to Lamatic via GraphQL: "${text}"`);

    try {
      const response = await fetch('/api/lamatic', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflowId: 'e6318509-e57e-452f-b117-eee35611ac6f',
          transcript: text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Lamatic request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log('✓ [LamaticClient] Response received:', data);
      this.onResponse(data);
      return data;

    } catch (error) {
      console.error('❌ [LamaticClient] Error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  /**
   * Convert Blob to base64 string
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64WithPrefix = reader.result as string;
        // The result will be "data:audio/webm;base64,AAAA..."
        const base64Data = base64WithPrefix.split(',')[1];
        
        if (!base64Data) {
          reject(new Error("Failed to extract base64 from Data URL"));
          return;
        }

        console.log(`📎 [LamaticClient] Generated base64 (${base64Data.length} chars). Header: ${base64Data.substring(0, 15)}`);
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Update webhook URL
   */
  setWebhookUrl(url: string): void {
    this.webhookUrl = url;
  }
}
