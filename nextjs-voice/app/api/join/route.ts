/**
 * /api/join - Server Route Handler for RealtimeKit Authentication
 * 
 * =============================================================================
 * SERVER-ONLY MODULE
 * =============================================================================
 * 
 * This route creates a meeting and adds a participant to get an auth token.
 * 
 * RealtimeKit Flow:
 * 1. Create a meeting → GET meeting_id
 * 2. Add participant to meeting → GET authToken
 * 3. Return authToken to client
 * 
 * Required Environment Variables:
 * - CF_ACCOUNT_ID: Cloudflare account identifier
 * - CF_API_TOKEN: Cloudflare API token with Realtime Admin permissions
 * - REALTIMEKIT_APP_ID: Your RealtimeKit application ID
 * - REALTIMEKIT_PRESET_NAME: Preset name for participants (e.g., "group_call_host")
 * 
 * =============================================================================
 */

import { NextRequest, NextResponse } from 'next/server';

interface JoinRequest {
  userId?: string;
  meetingTitle?: string;
}

export async function POST(request: NextRequest) {
  try {
    // Validate environment variables
    const accountId = process.env.CF_ACCOUNT_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const appId = process.env.REALTIMEKIT_APP_ID;
    const presetName = process.env.REALTIMEKIT_PRESET_NAME || 'group_call_host';

    if (!accountId || !apiToken || !appId) {
      console.error('Missing required environment variables');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Parse request body
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

    // Step 1: Create a meeting
    const createMeetingUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings`;
    
    console.log('Creating meeting at:', createMeetingUrl);
    
    const meetingResponse = await fetch(createMeetingUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: meetingTitle,
      }),
    });

    if (!meetingResponse.ok) {
      const errorText = await meetingResponse.text();
      console.error('Create meeting error:', meetingResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to create meeting', details: errorText },
        { status: meetingResponse.status }
      );
    }

    const meetingData = await meetingResponse.json();
    console.log('Meeting created:', meetingData);
    
    // Cloudflare returns 'data' not 'result'
    const meetingId = meetingData.data?.id || meetingData.result?.id;
    if (!meetingId) {
      return NextResponse.json(
        { error: 'No meeting ID in response', details: JSON.stringify(meetingData) },
        { status: 500 }
      );
    }

    // Step 2: Add participant to meeting
    const addParticipantUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/participants`;
    
    console.log('Adding participant at:', addParticipantUrl);
    
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
      console.error('Add participant error:', participantResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to add participant', details: errorText },
        { status: participantResponse.status }
      );
    }

    const participantData = await participantResponse.json();
    console.log('Participant added:', participantData);

    // Cloudflare returns 'data' not 'result'
    const authToken = participantData.data?.token || participantData.result?.token;
    if (!authToken) {
      return NextResponse.json(
        { error: 'No auth token in response', details: JSON.stringify(participantData) },
        { status: 500 }
      );
    }

    // Step 3: Create bot participant
    const botPresetName = process.env.REALTIMEKIT_BOT_PRESET_NAME || presetName;
    const botId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log('Adding bot participant at:', addParticipantUrl);
    console.log('Using bot preset:', botPresetName);
    
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
      console.error('Add bot participant error:', botParticipantResponse.status, errorText);
      return NextResponse.json(
        { error: 'Failed to add bot participant', details: errorText },
        { status: botParticipantResponse.status }
      );
    }

    const botParticipantData = await botParticipantResponse.json();
    console.log('Bot participant added:', botParticipantData);

    const botAuthToken = botParticipantData.data?.token || botParticipantData.result?.token;
    if (!botAuthToken) {
      return NextResponse.json(
        { error: 'No bot auth token in response', details: JSON.stringify(botParticipantData) },
        { status: 500 }
      );
    }

    // Return the user auth token (not the bot token)
    return NextResponse.json({
      token: authToken,
      meetingId,
      participantId: participantData.data?.id || participantData.result?.id,
      userId,
    });

  } catch (error) {
    console.error('Join route error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Reject other methods
export async function GET() {
  return NextResponse.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405 }
  );
}
