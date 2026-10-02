const pool = require('../db/postgres');
const realtime = require('./realtime');
const { httpError, isUuid, escapeLike } = require('../utils/http');

const MAX_GROUP_MEMBERS = 50;

/** Stable key so a pair of users can only ever have one direct thread. */
const directKey = (a, b) => [a, b].sort().join(':');

const run = (client, text, params) => (client || pool).query(text, params);

/** Throws 404/403 unless `userId` belongs to the conversation. Returns the member row. */
const assertMember = async (conversationId, userId, client) => {
  const { rows } = await run(
    client,
    `SELECT cm.role, cm.last_read_at, c.type
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
      WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
    [conversationId, userId],
  );
  if (rows.length === 0) throw httpError(404, 'Conversation not found');
  return rows[0];
};

const assertGroupAdmin = async (conversationId, userId, client) => {
  const member = await assertMember(conversationId, userId, client);
  if (member.type !== 'group') throw httpError(400, 'Only group conversations can be modified');
  if (member.role !== 'admin') throw httpError(403, 'Only group admins can do that');
  return member;
};

const getMemberIds = async (conversationId, client) => {
  const { rows } = await run(
    client,
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  );
  return rows.map((r) => r.user_id);
};

/**
 * Users may only start chats with people they already share a workspace with,
 * so the user table can't be used to harass or enumerate strangers.
 */
const filterReachableUserIds = async (actorId, candidateIds, client) => {
  const ids = [...new Set(candidateIds)].filter((id) => isUuid(id) && id !== actorId);
  if (ids.length === 0) return [];
  const { rows } = await run(
    client,
    `SELECT DISTINCT wm2.user_id
       FROM workspace_members wm1
       JOIN workspace_members wm2 ON wm2.workspace_id = wm1.workspace_id
      WHERE wm1.user_id = $1 AND wm2.user_id = ANY($2::uuid[])`,
    [actorId, ids],
  );
  return rows.map((r) => r.user_id);
};

const addSystemMessage = async (client, conversationId, body) => {
  await client.query(
    `INSERT INTO messages (conversation_id, sender_id, kind, body) VALUES ($1, NULL, 'system', $2)`,
    [conversationId, body],
  );
  await client.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversationId]);
};

const userName = async (client, userId) => {
  const { rows } = await client.query('SELECT name FROM users WHERE id = $1', [userId]);
  return rows[0]?.name || 'Someone';
};

const loadMembers = async (conversationIds) => {
  if (conversationIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT cm.conversation_id, cm.role, cm.joined_at, cm.last_read_at,
            u.id AS user_id, u.name, u.email, u.avatar_url
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ANY($1::uuid[])
      ORDER BY cm.joined_at ASC`,
    [conversationIds],
  );
  const byConv = new Map();
  for (const r of rows) {
    if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []);
    byConv.get(r.conversation_id).push({
      user_id: r.user_id, name: r.name, email: r.email, avatar_url: r.avatar_url,
      role: r.role, joined_at: r.joined_at, last_read_at: r.last_read_at,
    });
  }
  return byConv;
};

const listConversations = async (userId) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.type, c.name, c.avatar_url, c.created_by, c.created_at, c.last_message_at,
            me.last_read_at,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                AND m.sender_id IS DISTINCT FROM $1 AND m.created_at > me.last_read_at) AS unread_count,
            lm.id AS lm_id, lm.kind AS lm_kind, lm.body AS lm_body, lm.sender_id AS lm_sender_id,
            lm.attachment_name AS lm_attachment_name, lm.created_at AS lm_created_at,
            lm.deleted_at AS lm_deleted_at
       FROM conversation_members me
       JOIN conversations c ON c.id = me.conversation_id
  LEFT JOIN LATERAL (
              SELECT * FROM messages m WHERE m.conversation_id = c.id
               ORDER BY m.created_at DESC LIMIT 1
            ) lm ON TRUE
      WHERE me.user_id = $1
      ORDER BY c.last_message_at DESC`,
    [userId],
  );
  const members = await loadMembers(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id, type: r.type, name: r.name, avatar_url: r.avatar_url,
    created_by: r.created_by, created_at: r.created_at, last_message_at: r.last_message_at,
    unread_count: r.unread_count,
    members: members.get(r.id) || [],
    last_message: r.lm_id ? {
      id: r.lm_id, kind: r.lm_kind, sender_id: r.lm_sender_id, created_at: r.lm_created_at,
      body: r.lm_deleted_at ? '' : r.lm_body,
      attachment_name: r.lm_deleted_at ? null : r.lm_attachment_name,
      deleted: Boolean(r.lm_deleted_at),
    } : null,
  }));
};

const getConversation = async (conversationId, userId) => {
  await assertMember(conversationId, userId);
  const { rows } = await pool.query(
    `SELECT id, type, name, avatar_url, created_by, created_at, last_message_at
       FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const members = await loadMembers([conversationId]);
  return { ...rows[0], members: members.get(conversationId) || [] };
};

const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const createDirect = async (actorId, otherUserId) => {
  if (!isUuid(otherUserId) || otherUserId === actorId) throw httpError(400, 'A valid userId is required');
  const reachable = await filterReachableUserIds(actorId, [otherUserId]);
  if (reachable.length === 0) throw httpError(404, 'User not found');

  const key = directKey(actorId, otherUserId);
  const { id, created } = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO conversations (type, direct_key, created_by)
            VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) DO NOTHING
         RETURNING id`,
      [key, actorId],
    );
    if (ins.rows.length === 0) {
      const existing = await client.query('SELECT id FROM conversations WHERE direct_key = $1', [key]);
      return { id: existing.rows[0].id, created: false };
    }
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
            VALUES ($1, $2, 'member'), ($1, $3, 'member')
       ON CONFLICT DO NOTHING`,
      [ins.rows[0].id, actorId, otherUserId],
    );
    return { id: ins.rows[0].id, created: true };
  });

  if (created) {
    realtime.joinUsersToConversation([actorId, otherUserId], id);
    realtime.emitToUsers([otherUserId], 'conversation:added', { conversationId: id });
  }
  return getConversation(id, actorId);
};

const createGroup = async (actorId, { name, memberIds }) => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 120) throw httpError(400, 'Group name is required (max 120 characters)');
  if (!Array.isArray(memberIds)) throw httpError(400, 'memberIds must be an array');

  const reachable = await filterReachableUserIds(actorId, memberIds);
  if (reachable.length + 1 > MAX_GROUP_MEMBERS) {
    throw httpError(400, `Groups are limited to ${MAX_GROUP_MEMBERS} members`);
  }

  const id = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [trimmed, actorId],
    );
    const convId = ins.rows[0].id;
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [convId, actorId],
    );
    for (const uid of reachable) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
        [convId, uid],
      );
    }
    await addSystemMessage(client, convId, `${await userName(client, actorId)} created the group "${trimmed}"`);
    return convId;
  });

  realtime.joinUsersToConversation([actorId, ...reachable], id);
  realtime.emitToUsers(reachable, 'conversation:added', { conversationId: id });
  return getConversation(id, actorId);
};

const updateGroup = async (conversationId, actorId, { name, avatar_url: avatarUrl }) => {
  await assertGroupAdmin(conversationId, actorId);
  const sets = [];
  const params = [conversationId];
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed || trimmed.length > 120) throw httpError(400, 'Group name must be 1-120 characters');
    params.push(trimmed);
    sets.push(`name = $${params.length}`);
  }
  if (avatarUrl !== undefined) {
    if (avatarUrl !== null && !/^https:\/\//i.test(String(avatarUrl))) {
      throw httpError(400, 'avatar_url must be an https URL');
    }
    params.push(avatarUrl);
    sets.push(`avatar_url = $${params.length}`);
  }
  if (sets.length === 0) throw httpError(400, 'Nothing to update');
  await pool.query(`UPDATE conversations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
  realtime.emitToConversation(conversationId, 'conversation:updated', { conversationId });
  return getConversation(conversationId, actorId);
};

const addMembers = async (conversationId, actorId, userIds) => {
  if (!Array.isArray(userIds) || userIds.length === 0) throw httpError(400, 'userIds must be a non-empty array');
  await assertGroupAdmin(conversationId, actorId);

  const reachable = await filterReachableUserIds(actorId, userIds);
  const added = await withTransaction(async (client) => {
    const existing = new Set(await getMemberIds(conversationId, client));
    const toAdd = reachable.filter((id) => !existing.has(id));
    if (existing.size + toAdd.length > MAX_GROUP_MEMBERS) {
      throw httpError(400, `Groups are limited to ${MAX_GROUP_MEMBERS} members`);
    }
    for (const uid of toAdd) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`,
        [conversationId, uid],
      );
    }
    if (toAdd.length > 0) {
      const actor = await userName(client, actorId);
      const { rows } = await client.query('SELECT name FROM users WHERE id = ANY($1::uuid[])', [toAdd]);
      await addSystemMessage(client, conversationId, `${actor} added ${rows.map((r) => r.name).join(', ')}`);
    }
    return toAdd;
  });

  if (added.length > 0) {
    realtime.joinUsersToConversation(added, conversationId);
    realtime.emitToUsers(added, 'conversation:added', { conversationId });
    realtime.emitToConversation(conversationId, 'conversation:updated', { conversationId });
  }
  return getConversation(conversationId, actorId);
};

/** Admin removes someone, or a member removes themself (leave). */
const removeMember = async (conversationId, actorId, targetId) => {
  const actor = await assertMember(conversationId, actorId);
  if (actor.type !== 'group') throw httpError(400, 'Only group conversations can be modified');
  const isSelf = actorId === targetId;
  if (!isSelf && actor.role !== 'admin') throw httpError(403, 'Only group admins can remove members');

  const conversationDeleted = await withTransaction(async (client) => {
    // Lock the membership rows so concurrent admin changes can't strand a group with no admin.
    const { rows: members } = await client.query(
      `SELECT user_id, role FROM conversation_members
        WHERE conversation_id = $1 ORDER BY joined_at ASC FOR UPDATE`,
      [conversationId],
    );
    const target = members.find((m) => m.user_id === targetId);
    if (!target) throw httpError(404, 'Member not found');

    await client.query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, targetId],
    );
    const remaining = members.filter((m) => m.user_id !== targetId);
    if (remaining.length === 0) {
      await client.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
      return true;
    }
    if (target.role === 'admin' && !remaining.some((m) => m.role === 'admin')) {
      await client.query(
        `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, remaining[0].user_id],
      );
    }
    const targetName = await userName(client, targetId);
    await addSystemMessage(
      client, conversationId,
      isSelf ? `${targetName} left the group` : `${await userName(client, actorId)} removed ${targetName}`,
    );
    return false;
  });

  realtime.emitToUsers([targetId], 'conversation:removed', { conversationId });
  realtime.removeUsersFromConversation([targetId], conversationId);
  if (!conversationDeleted) {
    realtime.emitToConversation(conversationId, 'conversation:updated', { conversationId });
  }
  return { ok: true };
};

const setMemberRole = async (conversationId, actorId, targetId, role) => {
  if (!['admin', 'member'].includes(role)) throw httpError(400, 'role must be admin or member');
  await assertGroupAdmin(conversationId, actorId);

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT user_id, role FROM conversation_members WHERE conversation_id = $1 FOR UPDATE`,
      [conversationId],
    );
    const target = rows.find((m) => m.user_id === targetId);
    if (!target) throw httpError(404, 'Member not found');
    if (role === 'member' && target.role === 'admin' && rows.filter((m) => m.role === 'admin').length === 1) {
      throw httpError(400, 'A group needs at least one admin');
    }
    await client.query(
      'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, targetId, role],
    );
  });
  realtime.emitToConversation(conversationId, 'conversation:updated', { conversationId });
  return getConversation(conversationId, actorId);
};

/** People the user shares at least one workspace with, matching name/email. */
const searchUsers = async (userId, q) => {
  const term = `%${escapeLike((q || '').trim().slice(0, 60))}%`;
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.name, u.email, u.avatar_url
       FROM workspace_members wm1
       JOIN workspace_members wm2 ON wm2.workspace_id = wm1.workspace_id
       JOIN users u ON u.id = wm2.user_id
      WHERE wm1.user_id = $1 AND u.id <> $1
        AND (u.name ILIKE $2 OR u.email ILIKE $2)
      ORDER BY u.name ASC
      LIMIT 20`,
    [userId, term],
  );
  return rows;
};

module.exports = {
  directKey, assertMember, assertGroupAdmin, getMemberIds, filterReachableUserIds,
  withTransaction, listConversations, getConversation, createDirect, createGroup,
  updateGroup, addMembers, removeMember, setMemberRole, searchUsers,
};
