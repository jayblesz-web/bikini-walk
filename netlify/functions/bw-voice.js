// netlify/functions/bw-voice.js
//
// Converts a text reply into spoken voice for Bikini Walk's paid chat,
// using ElevenLabs, keeping the API key server-side. Set these in
// Netlify → Site settings → Environment variables:
//   ELEVENLABS_API_KEY  — your ElevenLabs API key
//   ELEVENLABS_VOICE_ID — the voice ID of the voice you create in the
//                         ElevenLabs dashboard (Voice Library / My Voices)
//
// IMPORTANT: all voice settings (speed, stability, similarity, style) are
// set explicitly below, not read from the ElevenLabs dashboard. Any time
// this request sends a voice_settings object, ElevenLabs treats it as a
// full override for that request — dashboard-level adjustments to a voice
// get silently ignored unless the same setting is also included here.
// These currently match the values dialed in on the dashboard as of the
// last update: Speed 0.80, Stability 34%, Similarity 0%, Style 3%.
//
// Frontend calls this as: POST /.netlify/functions/bw-voice
// Body: { text: "hey! good to hear from you" }
// Returns: raw audio bytes (audio/mpeg) — play directly via an <audio> tag,
// e.g. audio.src = URL.createObjectURL(blob)

// 1.0 = normal pace. ElevenLabs supports 0.7 (slowest) to 1.2 (fastest).
const VOICE_SPEED = 0.83;

// These three are all 0–1 (i.e. the dashboard's 0–100% sliders divided by 100).
const VOICE_STABILITY = 0.34;         // Stability: 34%
const VOICE_SIMILARITY_BOOST = 0.0;   // Similarity: 0%
const VOICE_STYLE = 0.03;             // Style Exaggeration: 3%

// Phonetic overrides — swaps a word for a version spelled the way it should
// SOUND, applied only to what gets sent to the voice engine. What the fan
// actually reads in the chat bubble is untouched; this only affects audio.
// Add more entries here anytime a word comes out mispronounced.
const PRONUNCIATION_OVERRIDES = {
  VYRA: 'VYE-rah', // stronger "eye" sound on the Y, rhymes with "spy-rah"
};
function applyPronunciationOverrides(text) {
  let result = text;
  for (const word in PRONUNCIATION_OVERRIDES) {
    const regex = new RegExp('\\b' + word + '\\b', 'gi');
    result = result.replace(regex, PRONUNCIATION_OVERRIDES[word]);
  }
  return result;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const text = (body.text || '').toString().trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing text' }) };
  }
  // ElevenLabs bills per character — keep replies from ballooning cost.
  const clippedText = applyPronunciationOverrides(text.slice(0, 600));

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured (missing ElevenLabs env vars)' }) };
  }

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: clippedText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: VOICE_STABILITY,
          similarity_boost: VOICE_SIMILARITY_BOOST,
          style: VOICE_STYLE,
          use_speaker_boost: true,
          speed: VOICE_SPEED,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('ElevenLabs error:', response.status, errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'Upstream voice error' }) };
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
      body: audioBase64,
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('bw-voice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
  }
};
