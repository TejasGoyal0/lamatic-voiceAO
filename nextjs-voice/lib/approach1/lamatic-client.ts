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
  audioUrl?: string;
  audioBase64?: string;
  error?: string;
}

export class LamaticClient {
  private webhookUrl: string;
  private onResponse: (response: LamaticResponse) => void;
  private onError: (error: Error) => void;

  constructor(config: LamaticClientConfig = {}) {
    // Default webhook URL - can be overridden
    this.webhookUrl = config.webhookUrl ?? 'https://hooks.lamatic.ai/hook/a943550e-6770-40b2-81de-2aa8f3df1755';
    this.onResponse = config.onResponse ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  /**
   * Send audio blob to Lamatic for processing
   */
  async sendAudio(audioBlob: Blob): Promise<LamaticResponse> {
    console.log(`📤 [LamaticClient] Sending audio to Lamatic... (${audioBlob.size} bytes)`);

    try {
      // Convert blob to base64
      const base64Audio = await this.blobToBase64(audioBlob);
      
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'AUDIO_INPUT',
          audio: base64Audio,
          mimeType: audioBlob.type,
          timestamp: Date.now(),
        }),
      });

      console.log(`📥 [LamaticClient] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Lamatic request failed: ${response.status} - ${errorText}`);
      }

      // Try to parse as JSON, fallback to text
      let data: LamaticResponse;
      const contentType = response.headers.get('content-type');
      
      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        // Handle non-JSON response (e.g., audio stream)
        const blob = await response.blob();
        if (blob.type.startsWith('audio/')) {
          const audioUrl = URL.createObjectURL(blob);
          data = {
            success: true,
            audioUrl,
          };
        } else {
          const text = await blob.text();
          data = {
            success: true,
            text,
          };
        }
      }

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
    console.log(`📤 [LamaticClient] Sending text to Lamatic: "${text}"`);

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'TEXT_INPUT',
          text,
          timestamp: Date.now(),
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
        const base64 = reader.result as string;
        // Remove data URL prefix (e.g., "data:audio/webm;base64,")
        const base64Data = base64.split(',')[1] || base64;
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
