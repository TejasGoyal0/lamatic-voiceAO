import { NextRequest, NextResponse } from 'next/server';

/**
 * Lamatic GraphQL API Proxy
 * 
 * Proxies requests to Lamatic's GraphQL API to avoid CORS issues.
 * The browser can't call api.lamatic.ai directly due to CORS,
 * so we route through this server-side endpoint.
 */

const LAMATIC_API_KEY = process.env.LAMATIC_API_KEY || "lt-313e9599b3c6216e51b099fda47b2f58";
const PROJECT_ID = process.env.LAMATIC_PROJECT_ID || "53dae977-1740-4ddc-999f-b8286d3f71dc";
// Lamatic endpoint with org/project subdomain
const GRAPHQL_ENDPOINT = "https://tejassorganization674-tejassproject642.lamatic.dev/graphql";

// Polling configuration
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;

interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

async function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  console.log(`📡 [LamaticAPI] Requesting GraphQL...`);
  
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
    console.error(`❌ [LamaticAPI] HTTP Error: ${response.status}`, responseData);
    throw new Error(`GraphQL request failed: ${response.status} - ${JSON.stringify(responseData)}`);
  }
  
  if (responseData.errors && responseData.errors.length > 0) {
    console.error(`❌ [LamaticAPI] GraphQL Errors:`, JSON.stringify(responseData.errors, null, 2));
    throw new Error(`GraphQL errors: ${JSON.stringify(responseData.errors)}`);
  }

  return responseData.data;
}

/**
 * Execute Workflow via GraphQL
 * Matches the user's provided structure for sampleInput mapping
 */
async function executeWorkflow(workflowId: string, inputString: string) {
  const query = `query ExecuteWorkflow($workflowId: String!, $sampleInput: String) { executeWorkflow(workflowId: $workflowId, payload: { sampleInput: $sampleInput }) { status result } }`;

  const variables = { 
    workflowId: workflowId, 
    sampleInput: inputString 
  };
  
  const data = await graphqlRequest(query, variables);
  return data.executeWorkflow;
}

async function checkStatus(requestId: string) {
  const query = `
    query CheckStatus($requestId: String!) {
      checkStatus(requestId: $requestId)
    }
  `;

  const variables = { requestId };
  const data = await graphqlRequest(query, variables);
  return data.checkStatus;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntilComplete(requestId: string) {
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    const statusResult = await checkStatus(requestId);
    console.log(`🔄 [LamaticAPI] Poll #${attempts + 1}: status = ${statusResult.status}`);

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
  
  // If it's a string, return it directly
  if (typeof output === 'string') return output;
  
  if (typeof output === 'object' && output !== null) {
    const obj = output as Record<string, any>;

    // 1. Search for known "Success" keys anywhere in the current object
    const successKeys = ['transcribe_text', 'transcript', 'aiResponse', 'response', 'text'];
    for (const key of successKeys) {
      if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 0) {
        return obj[key];
      }
    }

    // 2. Search for "Error" keys to provide feedback
    if (obj.error && typeof obj.error === 'string') return `ERROR: ${obj.error}`;

    // 3. Dive into common wrappers (Recursion)
    if (obj.data && obj.data !== output) return extractResponseText(obj.data);
    if (obj.output && obj.output !== output) return extractResponseText(obj.output);
    if (obj.result && obj.result !== output) return extractResponseText(obj.result);
    if (obj.input && obj.input !== output && !obj.output) {
       // If we ONLY have input and no output/result, maybe it's still running or failed
       // We don't return the input as the result, but we might log it
    }
    
    // 4. Handle 'nodes' array (Look for the most recent result)
    if (Array.isArray(obj.nodes)) {
      for (let i = obj.nodes.length - 1; i >= 0; i--) {
        const node = obj.nodes[i];
        if (node.output) {
          const res = extractResponseText(node.output);
          // Only return if it's not just stringified JSON (i.e., we found a real field)
          if (res && !res.startsWith('{') && !res.startsWith('[')) return res;
        }
      }
    }
    
    // 5. Hard Discovery: Check every value for a string that doesn't look like base64
    for (const key in obj) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0 && val.length < 5000 && !val.startsWith('UklGR')) {
        // This is likely our response text!
        return val;
      }
    }
  }

  // Fallback: If we can't find anything, return a snippet for debugging instead of the whole huge blob
  const stringified = JSON.stringify(output);
  return stringified.length > 500 ? stringified.substring(0, 500) + "..." : stringified;
}

function extractAudioBase64(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as Record<string, any>;
  
  // 1. Search for known "Audio" keys
  const audioKeys = ['audio_base64', 'audio', 'base64Audio'];
  for (const key of audioKeys) {
    if (obj[key] && typeof obj[key] === 'string' && obj[key].length > 1000) {
      return obj[key];
    }
  }
  
  // 2. Dive into common wrappers (Recursion)
  if (obj.data && obj.data !== output) return extractAudioBase64(obj.data);
  if (obj.output && obj.output !== output) return extractAudioBase64(obj.output);
  if (obj.result && obj.result !== output) return extractAudioBase64(obj.result);
  
  // 3. Handle 'nodes' array
  if (Array.isArray(obj.nodes)) {
    for (let i = obj.nodes.length - 1; i >= 0; i--) {
      const audio = extractAudioBase64(obj.nodes[i].output);
      if (audio) return audio;
    }
  }

  // 4. Hard Discovery: Check every value for a long string starting with SUQz (MP3) or UklGR (WAV)
  for (const key in obj) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > 5000) {
      // Common audio base64 headers
      if (val.startsWith('SUQz') || val.startsWith('//uQ') || val.startsWith('/+NI') || val.startsWith('UklGR')) {
        return val;
      }
    }
  }

  return null;
}

// Fixed Workflow ID for GraphQL
const WORKFLOW_ID = "e6318509-e57e-452f-b117-eee35611ac6f";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // CASE 1: DIRECT POLLING
    if (body.requestId) {
      console.log(`⌛ [LamaticAPI] Direct polling request for requestId: ${body.requestId}`);
      const pollResult = await pollUntilComplete(body.requestId);
      return NextResponse.json({
        success: true,
        text: extractResponseText(pollResult.output),
        audio: extractAudioBase64(pollResult.output),
        status: 'success',
      });
    }

    // CASE 2: EXECUTE WORKFLOW (GraphQL)
    console.log(`📤 [LamaticAPI] Switching to GraphQL Approach...`);
    
    // Extract input string (WAV Base64 or Text Prompt)
    let inputString = "";
    if (body.audioData) {
      inputString = body.audioData;
      console.log(`  📎 Sending WAV Base64 (Header: ${inputString.substring(0, 10)})`);
    } else {
      const inputText = body.transcript || body.topic || body.prompt || "";
      inputString = `(Strict English Mode) ${inputText}`;
      console.log(`  📝 Sending Text Prompt: "${inputString.substring(0, 30)}..."`);
    }

    const executeResult = await executeWorkflow(WORKFLOW_ID, inputString);
    
    if (executeResult.status === 'failed') {
      throw new Error(`Workflow execution failed: ${JSON.stringify(executeResult.result)}`);
    }

    const requestId = executeResult.result?.requestId || executeResult.requestId;
    let finalResult;
    
    if (requestId) {
      console.log(`⌛ [LamaticAPI] Workflow is asynchronous. Polling for requestId: ${requestId}...`);
      const pollResult = await pollUntilComplete(requestId);
      finalResult = pollResult; 
    } else {
      console.log(`✅ [LamaticAPI] Workflow finished synchronously.`);
      finalResult = executeResult.result;
    }

    const responseText = extractResponseText(finalResult);
    const audioBase64 = extractAudioBase64(finalResult);

    console.log('✅ [LamaticAPI] Final text response:', responseText.substring(0, 50));
    if (audioBase64) console.log('✅ [LamaticAPI] Audio response found:', audioBase64.substring(0, 20), '...');

    return NextResponse.json({
      success: true,
      text: responseText,
      audio: audioBase64,
      status: 'success',
    });

  } catch (error) {
    console.error('❌ [LamaticAPI] Error:', error);
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
