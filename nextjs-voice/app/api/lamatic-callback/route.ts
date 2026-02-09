import { NextRequest, NextResponse } from 'next/server';

/**
 * API Route: /api/lamatic-callback
 * 
 * Receives the AI response from Lamatic's Custom Code node
 * after the RAG pipeline completes.
 * 
 * Uses LONG POLLING - GET waits for response instead of returning immediately.
 */

// Simple in-memory store for responses (in production, use Redis or similar)
// Key: sessionId, Value: { response, timestamp, resolve }
const responseStore = new Map<string, { response: string; timestamp: number }>();
const waitingClients = new Map<string, (response: string) => void>();

// Cleanup old responses (older than 5 minutes)
const RESPONSE_TTL = 5 * 60 * 1000;

function cleanupOldResponses() {
  const now = Date.now();
  for (const [key, value] of responseStore.entries()) {
    if (now - value.timestamp > RESPONSE_TTL) {
      responseStore.delete(key);
    }
  }
}

// POST: Lamatic sends the AI response here
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    console.log('📥 [Lamatic Callback] POST received:', body);

    const sessionId = body.sessionId || 'default';
    const modelResponse = body.modelResponse || body.text || body.response || '';

    // If there's a waiting client, resolve immediately
    const waitingResolve = waitingClients.get(sessionId);
    if (waitingResolve) {
      console.log(`✓ [Lamatic Callback] Resolving waiting client for session: ${sessionId}`);
      waitingClients.delete(sessionId);
      waitingResolve(modelResponse);
    } else {
      // Store for later retrieval
      responseStore.set(sessionId, {
        response: modelResponse,
        timestamp: Date.now(),
      });
      console.log(`✓ [Lamatic Callback] Stored response for session: ${sessionId}`);
    }

    cleanupOldResponses();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('❌ [Lamatic Callback] POST Error:', error);
    return NextResponse.json(
      { error: 'Failed to process callback' },
      { status: 500 }
    );
  }
}

// GET: Long polling - waits for response up to 30 seconds
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId') || 'default';
  const timeout = parseInt(searchParams.get('timeout') || '30000', 10);

  console.log(`⏳ [Lamatic Callback] GET waiting for session: ${sessionId}`);

  // Check if response already exists
  const existing = responseStore.get(sessionId);
  if (existing) {
    responseStore.delete(sessionId);
    console.log(`✓ [Lamatic Callback] Returning existing response for session: ${sessionId}`);
    return NextResponse.json({
      success: true,
      response: existing.response,
      timestamp: existing.timestamp,
    });
  }

  // Wait for response with timeout
  try {
    const response = await Promise.race([
      new Promise<string>((resolve) => {
        waitingClients.set(sessionId, resolve);
      }),
      new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeout);
      }),
    ]);

    console.log(`✓ [Lamatic Callback] Got response for session: ${sessionId}`);
    return NextResponse.json({
      success: true,
      response: response,
      timestamp: Date.now(),
    });
  } catch (error) {
    // Timeout - clean up and return empty
    waitingClients.delete(sessionId);
    console.log(`⏱️ [Lamatic Callback] Timeout for session: ${sessionId}`);
    return NextResponse.json({
      success: false,
      response: null,
      timeout: true,
    });
  }
}
