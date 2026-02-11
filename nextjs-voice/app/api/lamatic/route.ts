import { NextRequest, NextResponse } from 'next/server';

const LAMATIC_API_KEY = process.env.LAMATIC_API_KEY || "lt-313e9599b3c6216e51b099fda47b2f58";
const PROJECT_ID = process.env.LAMATIC_PROJECT_ID || "53dae977-1740-4ddc-999f-b8286d3f71dc";
const GRAPHQL_ENDPOINT = "https://tejassorganization674-tejassproject642.lamatic.dev/graphql";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;
const WORKFLOW_ID = "e6318509-e57e-452f-b117-eee35611ac6f";

async function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LAMATIC_API_KEY}`,
      "Content-Type": "application/json",
      "x-project-id": PROJECT_ID,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseData = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} - ${JSON.stringify(responseData)}`);
  }

  if (responseData.errors && responseData.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(responseData.errors)}`);
  }

  return responseData.data;
}

async function executeWorkflow(workflowId: string, inputString: string) {
  const query = `query ExecuteWorkflow($workflowId: String!, $sampleInput: String) { executeWorkflow(workflowId: $workflowId, payload: { sampleInput: $sampleInput }) { status result } }`;
  const variables = { workflowId, sampleInput: inputString };
  const data = await graphqlRequest(query, variables);
  return data.executeWorkflow;
}

async function checkStatus(requestId: string) {
  const query = `
    query CheckStatus($requestId: String!) {
      checkStatus(requestId: $requestId)
    }
  `;
  const data = await graphqlRequest(query, { requestId });
  return data.checkStatus;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntilComplete(requestId: string) {
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    const statusResult = await checkStatus(requestId);

    if (statusResult.status === 'success' || statusResult.status === 'completed') {
      return statusResult;
    }
    if (statusResult.status === 'failed' || statusResult.status === 'error') {
      throw new Error(`Workflow failed with status: ${statusResult.status}`);
    }

    await sleep(POLL_INTERVAL_MS);
    attempts++;
  }
  throw new Error(`Polling timeout after ${MAX_POLL_ATTEMPTS} attempts`);
}

function extractResponseText(output: unknown): string {
  if (!output) return '';
  if (typeof output === 'string') return output;

  if (typeof output === 'object' && output !== null) {
    const obj = output as Record<string, any>;

    const successKeys = ['transcribe_text', 'transcript', 'aiResponse', 'response', 'text'];
    for (const key of successKeys) {
      if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 0) {
        return obj[key];
      }
    }

    if (obj.error && typeof obj.error === 'string') return `ERROR: ${obj.error}`;

    if (obj.data && obj.data !== output) return extractResponseText(obj.data);
    if (obj.output && obj.output !== output) return extractResponseText(obj.output);
    if (obj.result && obj.result !== output) return extractResponseText(obj.result);

    if (Array.isArray(obj.nodes)) {
      for (let i = obj.nodes.length - 1; i >= 0; i--) {
        const node = obj.nodes[i];
        if (node.output) {
          const res = extractResponseText(node.output);
          if (res && !res.startsWith('{') && !res.startsWith('[')) return res;
        }
      }
    }

    for (const key in obj) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0 && val.length < 5000 && !val.startsWith('UklGR')) {
        return val;
      }
    }
  }

  const stringified = JSON.stringify(output);
  return stringified.length > 500 ? stringified.substring(0, 500) + "..." : stringified;
}

function extractAudioBase64(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as Record<string, any>;

  const audioKeys = ['audio_base64', 'audio', 'base64Audio'];
  for (const key of audioKeys) {
    if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 1000) {
      return obj[key];
    }
  }

  if (obj.data && obj.data !== output) return extractAudioBase64(obj.data);
  if (obj.output && obj.output !== output) return extractAudioBase64(obj.output);
  if (obj.result && obj.result !== output) return extractAudioBase64(obj.result);

  if (Array.isArray(obj.nodes)) {
    for (let i = obj.nodes.length - 1; i >= 0; i--) {
      const audio = extractAudioBase64(obj.nodes[i].output);
      if (audio) return audio;
    }
  }

  for (const key in obj) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > 5000) {
      if (val.startsWith('SUQz') || val.startsWith('//uQ') || val.startsWith('/+NI') || val.startsWith('UklGR')) {
        return val;
      }
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.requestId) {
      const pollResult = await pollUntilComplete(body.requestId);
      return NextResponse.json({
        success: true,
        text: extractResponseText(pollResult.output),
        audio: extractAudioBase64(pollResult.output),
        status: 'success',
      });
    }

    let inputString = "";
    if (body.audioData) {
      inputString = body.audioData;
    } else {
      const inputText = body.transcript || body.topic || body.prompt || "";
      inputString = `(Strict English Mode) ${inputText}`;
    }

    const executeResult = await executeWorkflow(WORKFLOW_ID, inputString);

    if (executeResult.status === 'failed') {
      throw new Error(`Workflow execution failed: ${JSON.stringify(executeResult.result)}`);
    }

    const requestId = executeResult.result?.requestId || executeResult.requestId;
    let finalResult;

    if (requestId) {
      const pollResult = await pollUntilComplete(requestId);
      finalResult = pollResult;
    } else {
      finalResult = executeResult.result;
    }

    const responseText = extractResponseText(finalResult);
    const audioBase64 = extractAudioBase64(finalResult);

    return NextResponse.json({
      success: true,
      text: responseText,
      audio: audioBase64,
      status: 'success',
    });

  } catch (error) {
    console.error('[LamaticAPI] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        status: 'error',
      },
      { status: 500 }
    );
  }
}
