const jwt = require('jsonwebtoken');
const { httpError } = require('../utils/http');

/**
 * LiveKit access tokens are plain HS256 JWTs signed with the project API
 * secret, so we mint them with `jsonwebtoken` (already a dependency) instead
 * of pulling in the server SDK. The secret only ever lives in backend env.
 */
const TOKEN_TTL = '1h'; // a removed member's token stops working within the hour; /token issues fresh ones

const config = () => ({
  url: process.env.LIVEKIT_URL,
  apiKey: process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET,
});

const isConfigured = () => {
  const { url, apiKey, apiSecret } = config();
  return Boolean(url && apiKey && apiSecret);
};

const roomNameForCall = (callId) => `call-${callId}`;

/**
 * @param {{ identity: string, name?: string, room: string, canPublish?: boolean }} opts
 * @returns {string} signed JWT
 */
const createAccessToken = ({ identity, name, room, canPublish = true }) => {
  const { apiKey, apiSecret } = config();
  if (!apiKey || !apiSecret) throw httpError(503, 'Calling is not configured on this server');

  return jwt.sign(
    {
      name: name || identity,
      video: {
        room,
        roomJoin: true,
        canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    },
    apiSecret,
    { algorithm: 'HS256', issuer: apiKey, subject: identity, expiresIn: TOKEN_TTL },
  );
};

/** Returns { token, url } for a user joining a call's room. */
const issueJoinCredentials = ({ callId, userId, userName }) => {
  if (!isConfigured()) throw httpError(503, 'Calling is not configured on this server');
  const token = createAccessToken({
    identity: userId,
    name: userName,
    room: roomNameForCall(callId),
  });
  return { token, url: config().url };
};

/** Best-effort: disconnects everyone from the room when a call is ended for all. */
const closeRoom = async (callId) => {
  if (!isConfigured()) return;
  const { url, apiKey, apiSecret } = config();
  const room = roomNameForCall(callId);
  try {
    const adminToken = jwt.sign({ video: { roomCreate: true, roomAdmin: true, room } }, apiSecret, {
      algorithm: 'HS256', issuer: apiKey, subject: 'server', expiresIn: '1m',
    });
    const host = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
    await fetch(`${host}/twirp/livekit.RoomService/DeleteRoom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ room }),
    });
  } catch (err) {
    console.warn(`[LiveKit] closeRoom failed for ${room}: ${err.message}`);
  }
};

module.exports = {
  isConfigured, roomNameForCall, createAccessToken, issueJoinCredentials, closeRoom,
};
