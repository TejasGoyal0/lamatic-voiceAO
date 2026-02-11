const LAMATIC_API_KEY = "lt-313e9599b3c6216e51b099fda47b2f58";
const PROJECT_ID = "53dae977-1740-4ddc-999f-b8286d3f71dc";
const WORKFLOW_ID = "5106c37b-266b-4020-a33f-4ec2e3c4cce5";
const ENDPOINT = "https://api.lamatic.ai/api/graphql";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60;

export interface LamaticGraphQLResult {
  status: string;
  result?: any;
  requestId?: string;
  output?: {
    response?: string;
    _meta?: any;
  };
}

export interface LamaticStatusResult {
  status: string;
  input?: any;
  output?: {
    response?: string;
    _meta?: any;
  };
  nodes?: Array<{
    nodeName: string;
    status: string;
    output: any;
  }>;
  statusCode?: number;
  timeTakenInSeconds?: number;
}

async function graphqlRequest(query: string, variables?: Record<string, any>): Promise<any> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LAMATIC_API_KEY}`,
      "Content-Type": "application/json",
      "x-project-id": PROJECT_ID,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GraphQL request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (data.errors && data.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

export async function executeWorkflow(transcript: string): Promise<LamaticGraphQLResult> {
  const query = `
    query ExecuteWorkflow($workflowId: String!, $topic: String) {
      executeWorkflow(
        workflowId: $workflowId
        payload: { topic: $topic }
      ) {
        status
        result
        requestId
        output
      }
    }
  `;

  const variables = { workflowId: WORKFLOW_ID, topic: transcript };
  const data = await graphqlRequest(query, variables);
  return data.executeWorkflow;
}

export async function pollLamaticStatus(requestId: string): Promise<LamaticStatusResult> {
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

async function pollUntilComplete(requestId: string): Promise<LamaticStatusResult> {
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    const statusResult = await pollLamaticStatus(requestId);

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

function extractResponseText(output: any): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (output.response) return output.response;
  if (output.text) return output.text;
  if (output.message) return output.message;
  if (output.content) return output.content;
  return JSON.stringify(output);
}

export async function triggerLamaticFlow(transcript: string): Promise<string> {
  const executeResult = await executeWorkflow(transcript);

  let finalOutput: any;

  if (executeResult.status === 'in-progress' || executeResult.status === 'pending') {
    if (!executeResult.requestId) {
      throw new Error('No requestId returned for async workflow');
    }
    const statusResult = await pollUntilComplete(executeResult.requestId);
    finalOutput = statusResult.output;
  } else if (executeResult.status === 'success' || executeResult.status === 'completed') {
    finalOutput = executeResult.output;
  } else {
    throw new Error(`Unexpected workflow status: ${executeResult.status}`);
  }

  return extractResponseText(finalOutput);
}
