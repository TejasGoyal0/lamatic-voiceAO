'use client';

const WORKFLOW_ID = "6303aff4-a4f6-49b6-979f-b2f06d5ec69d";

export interface LamaticClientConfig {
  workflowId?: string;
  onResponse?: (response: LamaticResponse) => void;
  onError?: (error: Error) => void;
}

export interface LamaticResponse {
  success: boolean;
  text?: string;
  audioUrl?: string;
  audioBase64?: string;
  error?: string;
  requestId?: string;
  status?: string;
}

export interface PauseData {
  segmentCount: number;
  silenceDuration: number;
  timestamp: number;
}

export class LamaticClient {
  private workflowId: string;
  private onResponse: (response: LamaticResponse) => void;
  private onError: (error: Error) => void;

  constructor(config: LamaticClientConfig = {}) {
    this.workflowId = config.workflowId ?? WORKFLOW_ID;
    this.onResponse = config.onResponse ?? (() => {});
    this.onError = config.onError ?? (() => {});
  }

  async sendTranscript(
    transcript: string,
    pauseData?: PauseData,
  ): Promise<LamaticResponse> {
    try {
      const response = await fetch('/api/lamatic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: this.workflowId,
          transcript: transcript,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Request failed: ${response.status}`);
      }

      const data = await response.json();

      const lamaticResponse: LamaticResponse = {
        success: data.success,
        text: data.text,
        requestId: data.requestId,
        status: data.status,
        error: data.error,
      };

      if (lamaticResponse.success) {
        this.onResponse(lamaticResponse);
      } else {
        throw new Error(lamaticResponse.error || 'Failed to get response');
      }

      return lamaticResponse;

    } catch (error) {
      console.error('[LamaticClient] Error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError(err);
      return { success: false, error: err.message, status: 'error' };
    }
  }

  async sendControlMessage(message: object): Promise<LamaticResponse> {
    return { success: false, error: 'Control messages not supported via GraphQL API' };
  }

  setWorkflowId(workflowId: string): void {
    this.workflowId = workflowId;
  }
}

export async function triggerLamaticWorkflow(transcript: string): Promise<string> {
  const client = new LamaticClient();
  const response = await client.sendTranscript(transcript);
  if (!response.success) {
    throw new Error(response.error || 'Failed to get response from Lamatic');
  }
  return response.text || '';
}
