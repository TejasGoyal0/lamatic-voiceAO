import { NextRequest, NextResponse } from 'next/server';

const responseStore = new Map<string, { response: string; timestamp: number }>();
const waitingClients = new Map<string, (response: string) => void>();

const RESPONSE_TTL = 5 * 60 * 1000;

function cleanupOldResponses() {
  const now = Date.now();
  for (const [key, value] of responseStore.entries()) {
    if (now - value.timestamp > RESPONSE_TTL) {
      responseStore.delete(key);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const sessionId = body.sessionId || 'default';
    const modelResponse = body.modelResponse || body.text || body.response || '';

    const waitingResolve = waitingClients.get(sessionId);
    if (waitingResolve) {
      waitingClients.delete(sessionId);
      waitingResolve(modelResponse);
    } else {
      responseStore.set(sessionId, {
        response: modelResponse,
        timestamp: Date.now(),
      });
    }

    cleanupOldResponses();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[LamaticCallback] POST error:', error);
    return NextResponse.json({ error: 'Failed to process callback' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId') || 'default';
  const timeout = parseInt(searchParams.get('timeout') || '30000', 10);

  const existing = responseStore.get(sessionId);
  if (existing) {
    responseStore.delete(sessionId);
    return NextResponse.json({
      success: true,
      response: existing.response,
      timestamp: existing.timestamp,
    });
  }

  try {
    const response = await Promise.race([
      new Promise<string>((resolve) => {
        waitingClients.set(sessionId, resolve);
      }),
      new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeout);
      }),
    ]);

    return NextResponse.json({
      success: true,
      response: response,
      timestamp: Date.now(),
    });
  } catch (error) {
    waitingClients.delete(sessionId);
    return NextResponse.json({
      success: false,
      response: null,
      timeout: true,
    });
  }
}
