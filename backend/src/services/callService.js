const pool = require('../db/postgres');
const realtime = require('./realtime');
const livekit = require('./livekitService');
const { assertMember, withTransaction } = require('./conversationService');
const { httpError } = require('../utils/http');

const RING_TIMEOUT_SECONDS = 45;
const SWEEP_INTERVAL_MS = 15_000;
const LIVE = ['ringing', 'active'];

const getUser = async (userId) => {
  const { rows } = await pool.query('SELECT id, name FROM users WHERE id = $1', [userId]);
  return rows[0] || { id: userId, name: 'Someone' };
};

const loadCall = async (callId, client) => {
  const { rows } = await (client || pool).query(
    `SELECT c.id, c.conversation_id, c.started_by, c.kind, c.status,
            c.created_at, c.answered_at, c.ended_at,
            u.name AS started_by_name, conv.type AS conversation_type, conv.name AS conversation_name
       FROM calls c
  LEFT JOIN users u ON u.id = c.started_by
       JOIN conversations conv ON conv.id = c.conversation_id
      WHERE c.id = $1`,
    [callId],
  );
  if (rows.length === 0) throw httpError(404, 'Call not found');
  return rows[0];
};

const loadParticipants = async (callId, client) => {
  const { rows } = await (client || pool).query(
    `SELECT cp.user_id, cp.status, cp.joined_at, cp.left_at, u.name, u.avatar_url
       FROM call_participants cp JOIN users u ON u.id = cp.user_id
      WHERE cp.call_id = $1 ORDER BY u.name ASC`,
    [callId],
  );
  return rows;
};

const toDto = (call, participants) => ({
  id: call.id,
  conversation_id: call.conversation_id,
  conversation_type: call.conversation_type,
  conversation_name: call.conversation_name,
  started_by: call.started_by,
  started_by_name: call.started_by_name,
  kind: call.kind,
  status: call.status,
  created_at: call.created_at,
  answered_at: call.answered_at,
  ended_at: call.ended_at,
  participants: participants.map((p) => ({
    user_id: p.user_id, name: p.name, avatar_url: p.avatar_url, status: p.status,
  })),
});

const snapshot = async (callId) => toDto(await loadCall(callId), await loadParticipants(callId));

const assertParticipant = async (callId, userId, client) => {
  const { rows } = await (client || pool).query(
    'SELECT status FROM call_participants WHERE call_id = $1 AND user_id = $2',
    [callId, userId],
  );
  if (rows.length === 0) throw httpError(404, 'Call not found');
  return rows[0];
};

const broadcastUpdate = async (callId) => {
  const dto = await snapshot(callId);
  realtime.emitToConversation(dto.conversation_id, 'call:updated', dto);
  return dto;
};

/**
 * Closes a call that has nobody left. `invited` participants who never answered
 * become `missed`. A ringing call ends as `declined` if everyone said no, else `missed`.
 */
const finishCall = async (client, callId, finalStatus) => {
  await client.query(
    `UPDATE call_participants SET status = 'missed' WHERE call_id = $1 AND status = 'invited'`,
    [callId],
  );
  await client.query(
    `UPDATE call_participants SET status = 'left', left_at = NOW() WHERE call_id = $1 AND status = 'joined'`,
    [callId],
  );
  await client.query(
    `UPDATE calls SET status = $2, ended_at = NOW() WHERE id = $1 AND status = ANY($3::text[])`,
    [callId, finalStatus, LIVE],
  );
};

/** Re-evaluates a live call after a participant change and ends it if appropriate. */
const settleCall = async (client, callId) => {
  const call = await loadCall(callId, client);
  if (!LIVE.includes(call.status)) return false;
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM call_participants WHERE call_id = $1 GROUP BY status`,
    [callId],
  );
  const count = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const joined = count.joined || 0;
  const invited = count.invited || 0;

  if (call.status === 'ringing' && invited === 0) {
    // Everyone invited has answered, declined or timed out; the caller is alone.
    if (joined <= 1) {
      await finishCall(client, callId, (count.declined || 0) > 0 && !(count.missed) ? 'declined' : 'missed');
      return true;
    }
  }
  if (joined === 0) {
    await finishCall(client, callId, call.answered_at ? 'ended' : 'missed');
    return true;
  }
  if (call.status === 'active' && joined === 1 && invited === 0 && call.conversation_type === 'direct') {
    // Direct call: the other side left, so the call is over.
    await finishCall(client, callId, 'ended');
    return true;
  }
  return false;
};

const afterChange = async (callId, ended) => {
  const dto = await broadcastUpdate(callId);
  if (ended) {
    realtime.emitToConversation(dto.conversation_id, 'call:ended', { callId, status: dto.status });
    livekit.closeRoom(callId);
  }
  return dto;
};

const startCall = async (conversationId, userId, kind) => {
  if (!['audio', 'video'].includes(kind)) throw httpError(400, 'kind must be audio or video');
  if (!livekit.isConfigured()) throw httpError(503, 'Calling is not configured on this server');
  await assertMember(conversationId, userId);

  let callId;
  try {
    callId = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO calls (conversation_id, started_by, kind) VALUES ($1, $2, $3) RETURNING id`,
        [conversationId, userId, kind],
      );
      const id = ins.rows[0].id;
      await client.query(
        `INSERT INTO call_participants (call_id, user_id, status, joined_at)
         SELECT $1, user_id,
                CASE WHEN user_id = $3 THEN 'joined' ELSE 'invited' END,
                CASE WHEN user_id = $3 THEN NOW() END
           FROM conversation_members WHERE conversation_id = $2`,
        [id, conversationId, userId],
      );
      return id;
    });
  } catch (err) {
    if (err.code === '23505') {
      const { rows } = await pool.query(
        `SELECT id FROM calls WHERE conversation_id = $1 AND status = ANY($2::text[])`,
        [conversationId, LIVE],
      );
      throw Object.assign(httpError(409, 'A call is already in progress in this conversation'), {
        callId: rows[0]?.id,
      });
    }
    throw err;
  }

  const dto = await snapshot(callId);
  realtime.emitToConversation(conversationId, 'call:incoming', dto);
  const user = await getUser(userId);
  return { call: dto, ...livekit.issueJoinCredentials({ callId, userId, userName: user.name }) };
};

/** Accept an invitation, or (re)join a call already in progress. Returns LiveKit credentials. */
const joinCall = async (callId, userId) => {
  const ended = await withTransaction(async (client) => {
    await assertParticipant(callId, userId, client);
    const call = await loadCall(callId, client);
    if (!LIVE.includes(call.status)) throw httpError(410, 'This call has ended');
    await client.query(
      `UPDATE call_participants SET status = 'joined', joined_at = NOW(), left_at = NULL
        WHERE call_id = $1 AND user_id = $2`,
      [callId, userId],
    );
    await client.query(
      `UPDATE calls SET status = 'active', answered_at = COALESCE(answered_at, NOW())
        WHERE id = $1 AND status = 'ringing'`,
      [callId],
    );
    return false;
  });
  const dto = await afterChange(callId, ended);
  const user = await getUser(userId);
  return { call: dto, ...livekit.issueJoinCredentials({ callId, userId, userName: user.name }) };
};

const declineCall = async (callId, userId) => {
  const ended = await withTransaction(async (client) => {
    const p = await assertParticipant(callId, userId, client);
    if (p.status !== 'invited') throw httpError(409, 'No pending invitation for this call');
    await client.query(
      `UPDATE call_participants SET status = 'declined' WHERE call_id = $1 AND user_id = $2`,
      [callId, userId],
    );
    return settleCall(client, callId);
  });
  return afterChange(callId, ended);
};

const leaveCall = async (callId, userId) => {
  const ended = await withTransaction(async (client) => {
    const p = await assertParticipant(callId, userId, client);
    if (p.status !== 'joined') return false;
    await client.query(
      `UPDATE call_participants SET status = 'left', left_at = NOW() WHERE call_id = $1 AND user_id = $2`,
      [callId, userId],
    );
    return settleCall(client, callId);
  });
  return afterChange(callId, ended);
};

/** End for everyone: the person who started it, or any admin of the group. */
const endCall = async (callId, userId) => {
  const ended = await withTransaction(async (client) => {
    await assertParticipant(callId, userId, client);
    const call = await loadCall(callId, client);
    if (!LIVE.includes(call.status)) return false;
    if (call.started_by !== userId && call.conversation_type === 'group') {
      const { rows } = await client.query(
        `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [call.conversation_id, userId],
      );
      if (rows[0]?.role !== 'admin') throw httpError(403, 'Only the host or a group admin can end the call for everyone');
    }
    await finishCall(client, callId, call.answered_at ? 'ended' : 'missed');
    return true;
  });
  return afterChange(callId, ended);
};

/** Fresh LiveKit credentials for someone already in the call (e.g. after a refresh). */
const issueToken = async (callId, userId) => {
  const p = await assertParticipant(callId, userId);
  if (p.status !== 'joined') throw httpError(403, 'Join the call before requesting a token');
  const call = await loadCall(callId);
  if (!LIVE.includes(call.status)) throw httpError(410, 'This call has ended');
  const user = await getUser(userId);
  return livekit.issueJoinCredentials({ callId, userId, userName: user.name });
};

const getActiveCall = async (conversationId, userId) => {
  await assertMember(conversationId, userId);
  const { rows } = await pool.query(
    `SELECT id FROM calls WHERE conversation_id = $1 AND status = ANY($2::text[])`,
    [conversationId, LIVE],
  );
  return rows[0] ? snapshot(rows[0].id) : null;
};

/** Calls still ringing/active for this user, so a freshly loaded page can show the invitation. */
const listPendingForUser = async (userId) => {
  const { rows } = await pool.query(
    `SELECT cp.call_id FROM call_participants cp JOIN calls c ON c.id = cp.call_id
      WHERE cp.user_id = $1 AND cp.status = 'invited' AND c.status = 'ringing'
        AND c.created_at > NOW() - make_interval(secs => $2)`,
    [userId, RING_TIMEOUT_SECONDS],
  );
  return Promise.all(rows.map((r) => snapshot(r.call_id)));
};

/**
 * Call history for the user, newest first. `conversationId` optionally narrows
 * it to one thread. Cursor pagination on created_at.
 */
const listHistory = async (userId, { conversationId, limit, before } = {}) => {
  const take = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const params = [userId];
  let where = '';
  if (conversationId) {
    params.push(conversationId);
    where += ` AND c.conversation_id = $${params.length}`;
  }
  if (before) {
    if (Number.isNaN(Date.parse(before))) throw httpError(400, 'before must be an ISO timestamp');
    params.push(before);
    where += ` AND c.created_at < $${params.length}`;
  }
  params.push(take);
  const { rows } = await pool.query(
    `SELECT c.id, c.conversation_id, c.started_by, c.kind, c.status, c.created_at,
            c.answered_at, c.ended_at, u.name AS started_by_name,
            conv.type AS conversation_type, conv.name AS conversation_name,
            me.status AS my_status,
            (SELECT COALESCE(json_agg(json_build_object('user_id', pu.id, 'name', pu.name)), '[]'::json)
               FROM call_participants cp2 JOIN users pu ON pu.id = cp2.user_id
              WHERE cp2.call_id = c.id) AS participants
       FROM call_participants me
       JOIN calls c ON c.id = me.call_id
       JOIN conversations conv ON conv.id = c.conversation_id
  LEFT JOIN users u ON u.id = c.started_by
      WHERE me.user_id = $1 ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    conversation_type: r.conversation_type,
    conversation_name: r.conversation_name,
    started_by: r.started_by,
    started_by_name: r.started_by_name,
    kind: r.kind,
    status: r.status,
    my_status: r.my_status,
    direction: r.started_by === userId ? 'outgoing' : 'incoming',
    created_at: r.created_at,
    answered_at: r.answered_at,
    ended_at: r.ended_at,
    duration_seconds: r.answered_at && r.ended_at
      ? Math.max(0, Math.round((new Date(r.ended_at) - new Date(r.answered_at)) / 1000))
      : null,
    participants: r.participants,
  }));
};

/** Marks a user as having left every live call (used when all their sockets drop). */
const leaveAllCallsFor = async (userId) => {
  const { rows } = await pool.query(
    `SELECT cp.call_id FROM call_participants cp JOIN calls c ON c.id = cp.call_id
      WHERE cp.user_id = $1 AND cp.status = 'joined' AND c.status = ANY($2::text[])`,
    [userId, LIVE],
  );
  for (const r of rows) {
    await leaveCall(r.call_id, userId).catch((e) => console.warn(`[Calls] leave on disconnect failed: ${e.message}`));
  }
};

/**
 * Housekeeping, idempotent and safe to run on several instances:
 *  - ringing calls past the timeout: unanswered invitations become `missed`
 *  - live calls where nobody is joined any more are closed
 */
const sweepStaleCalls = async () => {
  const { rows } = await pool.query(
    `UPDATE call_participants cp SET status = 'missed'
       FROM calls c
      WHERE cp.call_id = c.id AND cp.status = 'invited'
        AND c.status = ANY($2::text[])
        AND c.created_at < NOW() - make_interval(secs => $1)
  RETURNING cp.call_id`,
    [RING_TIMEOUT_SECONDS, LIVE],
  );
  const touched = new Set(rows.map((r) => r.call_id));

  const orphans = await pool.query(
    `SELECT c.id FROM calls c
      WHERE c.status = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM call_participants cp WHERE cp.call_id = c.id AND cp.status = 'joined')`,
    [LIVE],
  );
  orphans.rows.forEach((r) => touched.add(r.id));

  for (const callId of touched) {
    try {
      const ended = await withTransaction((client) => settleCall(client, callId));
      await afterChange(callId, ended);
    } catch (err) {
      console.warn(`[Calls] sweep failed for ${callId}: ${err.message}`);
    }
  }
};

let sweepTimer = null;
const startSweeper = () => {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepStaleCalls().catch((e) => console.warn(`[Calls] sweep error: ${e.message}`));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
};

module.exports = {
  RING_TIMEOUT_SECONDS, startCall, joinCall, declineCall, leaveCall, endCall, issueToken,
  getActiveCall, listPendingForUser, listHistory, leaveAllCallsFor, sweepStaleCalls, startSweeper,
};
