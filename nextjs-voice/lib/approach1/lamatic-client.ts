'use client';

export interface LamaticClientConfig {
  webhookUrl?: string;
  onResponse?: (response: LamaticResponse) => void;
  onError?: (error: Error) => void;
}

export interface LamaticResponse {
  success: boolean;
  transcript?: string;
  text?: string;
  audio?: string;
  error?: string;
  status?: string;
  timings?: {
    clientStart: number;
    apiResponse: number;
    totalRoundTrip: number;
  };
}

export class LamaticClient {
  static async playAudio(base64: string): Promise<void> {
    try {
      const binaryString = window.atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      await audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[LamaticClient] Playback error:', error);
    }
  }

  private webhookUrl: string;
  private onResponse: (response: LamaticResponse) => void;
  private onError: (error: Error) => void;
  private currentAbortController: AbortController | null = null;

  constructor(config: LamaticClientConfig = {}) {
    this.webhookUrl = config.webhookUrl ?? 'https://hooks.lamatic.ai/hook/e6318509-e57e-452f-b117-eee35611ac6f';
    this.onResponse = config.onResponse ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  cancelCurrentRequest(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  async sendAudio(audioBlob: Blob): Promise<LamaticResponse> {
    this.cancelCurrentRequest();
    this.currentAbortController = new AbortController();
    const startTime = performance.now();

    try {
      const base64Audio = await this.blobToBase64(audioBlob);

      const response = await fetch('/api/lamatic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioData: base64Audio }),
        signal: this.currentAbortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Lamatic request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const endTime = performance.now();

      const timings = {
        clientStart: startTime,
        apiResponse: endTime,
        totalRoundTrip: endTime - startTime,
      };

      const responseWithTimings = { ...data, timings };
      this.onResponse(responseWithTimings);
      this.currentAbortController = null;
      return responseWithTimings;

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, status: 'cancelled' };
      }
      console.error('[LamaticClient] sendAudio error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  async sendText(text: string): Promise<LamaticResponse> {
    this.cancelCurrentRequest();
    this.currentAbortController = new AbortController();

    try {
      const response = await fetch('/api/lamatic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'e6318509-e57e-452f-b117-eee35611ac6f',
          transcript: text,
        }),
        signal: this.currentAbortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Lamatic request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      this.onResponse(data);
      this.currentAbortController = null;
      return data;

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, status: 'cancelled' };
      }
      console.error('[LamaticClient] sendText error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      throw err;
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64WithPrefix = reader.result as string;
        const base64Data = base64WithPrefix.split(',')[1];
        if (!base64Data) {
          reject(new Error('Failed to extract base64 from Data URL'));
          return;
        }
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  setWebhookUrl(url: string): void {
    this.webhookUrl = url;
  }
}
