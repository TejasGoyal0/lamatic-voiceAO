/**
 * /api/transcribe - ElevenLabs Speech-to-Text API Route
 * 
 * Server-side proxy for ElevenLabs STT to keep API key secure.
 * Receives audio blob from client, sends to ElevenLabs, returns transcript.
 */

import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    
    if (!apiKey) {
      console.error('Missing ELEVENLABS_API_KEY environment variable');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Get the audio data from the request
    const formData = await request.formData();
    const audioFile = formData.get('audio') as Blob | null;
    
    if (!audioFile) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    console.log(`📥 [Transcribe] Received audio: ${audioFile.size} bytes, type: ${audioFile.type}`);

    // Convert blob to buffer for ElevenLabs
    const audioBuffer = await audioFile.arrayBuffer();
    
    // Determine file extension based on MIME type
    const mimeType = audioFile.type || 'audio/webm';
    const extension = mimeType.includes('webm') ? 'webm' : 
                      mimeType.includes('mp3') ? 'mp3' : 
                      mimeType.includes('wav') ? 'wav' : 'webm';

    // ElevenLabs STT API
    // Documentation: https://elevenlabs.io/docs/api-reference/speech-to-text
    // The API expects: file (audio file), model_id, and optional language_code
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${extension}`);
    form.append('model_id', 'scribe_v1'); // ElevenLabs Scribe model
    form.append('language_code', 'en');   // Lock to English
    
    console.log(`🔄 [Transcribe] Sending to ElevenLabs: ${audioBuffer.byteLength} bytes, type: ${mimeType}, language: en`);

    const elevenLabsResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: form,
    });

    if (!elevenLabsResponse.ok) {
      const errorText = await elevenLabsResponse.text();
      console.error('ElevenLabs STT error:', elevenLabsResponse.status, errorText);
      return NextResponse.json(
        { error: 'Transcription failed', details: errorText },
        { status: elevenLabsResponse.status }
      );
    }

    const result = await elevenLabsResponse.json();
    console.log('✓ [Transcribe] ElevenLabs response:', result);

    // ElevenLabs returns { text: "transcribed text" }
    return NextResponse.json({
      success: true,
      text: result.text || '',
      language: result.language_code || 'en',
    });

  } catch (error) {
    console.error('Transcribe route error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
