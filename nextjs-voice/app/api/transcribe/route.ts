import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      console.error('Missing ELEVENLABS_API_KEY environment variable');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio') as Blob | null;

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    const audioBuffer = await audioFile.arrayBuffer();

    const mimeType = audioFile.type || 'audio/webm';
    const extension = mimeType.includes('webm') ? 'webm' :
                      mimeType.includes('mp3') ? 'mp3' :
                      mimeType.includes('wav') ? 'wav' : 'webm';

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${extension}`);
    form.append('model_id', 'scribe_v1');
    form.append('language_code', 'en');

    const elevenLabsResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!elevenLabsResponse.ok) {
      const errorText = await elevenLabsResponse.text();
      console.error('[Transcribe] ElevenLabs error:', elevenLabsResponse.status, errorText);
      return NextResponse.json(
        { error: 'Transcription failed', details: errorText },
        { status: elevenLabsResponse.status }
      );
    }

    const result = await elevenLabsResponse.json();

    return NextResponse.json({
      success: true,
      text: result.text || '',
      language: result.language_code || 'en',
    });

  } catch (error) {
    console.error('[Transcribe] Route error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
