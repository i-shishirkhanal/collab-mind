/**
 * Holds the Socket.io server so REST controllers/services can push events
 * without importing the socket module (avoids circular requires).
 * Rooms: `user:<userId>` (all of a user's sockets), `conv:<conversationId>`.
 */
let io = null;

const setIo = (instance) => { io = instance; };
const getIo = () => io;

const userRoom = (userId) => `user:${userId}`;
const convRoom = (conversationId) => `conv:${conversationId}`;

const emitToConversation = (conversationId, event, payload) => {
  if (io) io.to(convRoom(conversationId)).emit(event, payload);
};

const emitToUsers = (userIds, event, payload) => {
  if (!io) return;
  for (const id of userIds) io.to(userRoom(id)).emit(event, payload);
};

/** Subscribe every live socket of these users to a conversation room. */
const joinUsersToConversation = (userIds, conversationId) => {
  if (!io) return;
  for (const id of userIds) io.in(userRoom(id)).socketsJoin(convRoom(conversationId));
};

const removeUsersFromConversation = (userIds, conversationId) => {
  if (!io) return;
  for (const id of userIds) io.in(userRoom(id)).socketsLeave(convRoom(conversationId));
};

const isUserOnline = async (userId) => {
  if (!io) return false;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  return sockets.some((s) => s.data?.messaging);
};

const workspaceRoom = (workspaceId) => `workspace:${workspaceId}`;

/** Drop every socket belonging to a revoked session (logout, password reset). */
const disconnectSession = (sessionId) => {
  if (!io || !sessionId) return;
  io.in(`session:${sessionId}`).disconnectSockets(true);
};

/** Remove a user's live sockets from a workspace room (membership revoked). */
const removeUserFromWorkspaceRoom = (workspaceId, userId) => {
  if (!io) return;
  io.in(`wsuser:${userId}`).socketsLeave(workspaceRoom(workspaceId));
};

module.exports = {
  disconnectSession, removeUserFromWorkspaceRoom, workspaceRoom,
  setIo, getIo, userRoom, convRoom,
  emitToConversation, emitToUsers,
  joinUsersToConversation, removeUsersFromConversation, isUserOnline,
};
