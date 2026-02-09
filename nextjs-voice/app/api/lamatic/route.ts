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

interface ExecuteWorkflowRequest {
  workflowId: string;
  topic: string;
}

async function graphqlRequest(query: string, variables?: Record<string, unknown>) {
  console.log(`📡 [LamaticAPI] Requesting GraphQL with variables: ${JSON.stringify(variables, null, 2)}`);
  
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

async function executeWorkflow(workflowId: string, transcript: string) {
  // Use 'sampleInput' as confirmed by the user's working cURL command
  const query = `
    query ExecuteWorkflow($workflowId: String!, $sampleInput: String!) {
      executeWorkflow(
        workflowId: $workflowId
        payload: { sampleInput: $sampleInput }
      ) {
        status
        result
      }
    }
  `;

  const variables = { 
    workflowId: workflowId, 
    sampleInput: transcript 
  };
  
  const data = await graphqlRequest(query, variables);
  return data.executeWorkflow;
}

async function checkStatus(requestId: string) {
  const query = `
    query CheckStatus($requestId: String!) {
      checkStatus(requestId: $requestId) {
        status
        input
        output
        nodes {
          nodeName
          status
          output
        }
        statusCode
        timeTakenInSeconds
      }
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
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    const obj = output as Record<string, unknown>;
    // Check common response field names
    if (obj.aiResponse) return String(obj.aiResponse);
    if (obj.summary) return String(obj.summary);
    if (obj.response) return String(obj.response);
    if (obj.text) return String(obj.text);
    if (obj.message) return String(obj.message);
    if (obj.content) return String(obj.content);
    
    // If it's a result object from this workflow, it might be nested
    if (obj.result) return extractResponseText(obj.result);
  }
  return JSON.stringify(output);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { workflowId: string; transcript: string };
    const { workflowId, transcript } = body;

    // Support both 'topic' (old) and 'transcript' (new) for compatibility
    const inputText = transcript || (body as any).topic;

    // Force English mode hint to prevent the LLM from switching to Hindi
    // This is prepended to the user's input to guide the LLM's response language.
    const flavoredInput = `(Strict English Mode) ${inputText}`;

    console.log(`📤 [LamaticAPI] Executing workflow ${workflowId} with text: "${flavoredInput.substring(0, 50)}..."`);

    // Execute the workflow
    const executeResult = await executeWorkflow(workflowId, flavoredInput);
    console.log('📥 [LamaticAPI] Execute result:', JSON.stringify(executeResult, null, 2));

    // Extract response text from result field
    const responseText = extractResponseText(executeResult.result);
    console.log('✅ [LamaticAPI] Got response:', responseText.substring(0, 100));

    return NextResponse.json({
      success: true,
      text: responseText,
      status: executeResult.status || 'success',
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
