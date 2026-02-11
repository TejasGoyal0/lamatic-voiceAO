import { NextRequest, NextResponse } from 'next/server';

interface JoinRequest {
  userId?: string;
  meetingTitle?: string;
}

export async function POST(request: NextRequest) {
  try {
    const accountId = process.env.CF_ACCOUNT_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const appId = process.env.REALTIMEKIT_APP_ID;
    const presetName = process.env.REALTIMEKIT_PRESET_NAME || 'group_call_host';

    if (!accountId || !apiToken || !appId) {
      console.error('Missing required environment variables');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    let body: JoinRequest = {};
    try {
      body = await request.json();
    } catch {
      // Empty body is OK
    }

    const userId = body.userId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const meetingTitle = body.meetingTitle || `Voice Session ${new Date().toISOString()}`;

    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };

    // Create a meeting
    const createMeetingUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings`;

    const meetingResponse = await fetch(createMeetingUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: meetingTitle }),
    });

    if (!meetingResponse.ok) {
      const errorText = await meetingResponse.text();
      console.error('[Join] Create meeting error:', meetingResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to create meeting', details: errorText },
        { status: meetingResponse.status }
      );
    }

    const meetingData = await meetingResponse.json();
    const meetingId = meetingData.data?.id || meetingData.result?.id;
    if (!meetingId) {
      return NextResponse.json(
        { error: 'No meeting ID in response', details: JSON.stringify(meetingData) },
        { status: 500 }
      );
    }

    // Add participant to meeting
    const addParticipantUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/participants`;

    const participantResponse = await fetch(addParticipantUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: userId,
        preset_name: presetName,
        custom_participant_id: userId,
      }),
    });

    if (!participantResponse.ok) {
      const errorText = await participantResponse.text();
      console.error('[Join] Add participant error:', participantResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to add participant', details: errorText },
        { status: participantResponse.status }
      );
    }

    const participantData = await participantResponse.json();
    const authToken = participantData.data?.token || participantData.result?.token;
    if (!authToken) {
      return NextResponse.json(
        { error: 'No auth token in response', details: JSON.stringify(participantData) },
        { status: 500 }
      );
    }

    // Create bot participant
    const botPresetName = process.env.REALTIMEKIT_BOT_PRESET_NAME || presetName;
    const botId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const botParticipantResponse = await fetch(addParticipantUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: botId,
        preset_name: botPresetName,
        custom_participant_id: botId,
      }),
    });

    if (!botParticipantResponse.ok) {
      const errorText = await botParticipantResponse.text();
      console.error('[Join] Add bot participant error:', botParticipantResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to add bot participant', details: errorText },
        { status: botParticipantResponse.status }
      );
    }

    const botParticipantData = await botParticipantResponse.json();
    const botAuthToken = botParticipantData.data?.token || botParticipantData.result?.token;
    if (!botAuthToken) {
      return NextResponse.json(
        { error: 'No bot auth token in response', details: JSON.stringify(botParticipantData) },
        { status: 500 }
      );
    }

    return NextResponse.json({
      token: authToken,
      meetingId,
      participantId: participantData.data?.id || participantData.result?.id,
      userId,
    });

  } catch (error) {
    console.error('[Join] Route error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed. Use POST.' }, { status: 405 });
}
