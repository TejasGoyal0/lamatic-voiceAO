/**
 * /api/tts - ElevenLabs Text-to-Speech Streaming API Route
 * 
 * Server-side proxy for ElevenLabs TTS to keep API key secure.
 * Receives text, streams audio chunks back to client.
 */

import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    
    if (!apiKey) {
      console.error('Missing ELEVENLABS_API_KEY environment variable');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await request.json();
    const { text, voiceId } = body;
    
    if (!text) {
      return new Response(
        JSON.stringify({ error: 'No text provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Default voice ID - you can change this or make it configurable
    // Popular voices: "21m00Tcm4TlvDq8ikWAM" (Rachel), "EXAVITQu4vr4xnSDxMaL" (Bella)
    const voice = voiceId || 'EXAVITQu4vr4xnSDxMaL';

    console.log(`🔊 [TTS] Generating speech for: "${text.substring(0, 50)}..."`);

    // ElevenLabs TTS Streaming API
    // Documentation: https://elevenlabs.io/docs/api-reference/text-to-speech/stream
    const elevenLabsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5', // Fast model for real-time
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
          // Optimize for streaming
          output_format: 'mp3_44100_128',
        }),
      }
    );

    if (!elevenLabsResponse.ok) {
      const errorText = await elevenLabsResponse.text();
      console.error('ElevenLabs TTS error:', elevenLabsResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: 'TTS generation failed', details: errorText }),
        { status: elevenLabsResponse.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('✓ [TTS] Streaming audio response...');

    // Stream the audio directly to client
    return new Response(elevenLabsResponse.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });

  } catch (error) {
    console.error('TTS route error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
