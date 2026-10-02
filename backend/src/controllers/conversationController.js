const conversations = require('../services/conversationService');
const messages = require('../services/messageService');
const calls = require('../services/callService');
const { httpError } = require('../utils/http');

/** Wraps an async handler so rejections reach the global error handler. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const list = h(async (req, res) => {
  res.json({ conversations: await conversations.listConversations(req.user.id) });
});

const create = h(async (req, res) => {
  const { type, userId, name, memberIds } = req.body || {};
  if (type === 'direct') return res.status(201).json(await conversations.createDirect(req.user.id, userId));
  if (type === 'group') return res.status(201).json(await conversations.createGroup(req.user.id, { name, memberIds }));
  throw httpError(400, "type must be 'direct' or 'group'");
});

const get = h(async (req, res) => {
  res.json(await conversations.getConversation(req.params.conversationId, req.user.id));
});

const update = h(async (req, res) => {
  res.json(await conversations.updateGroup(req.params.conversationId, req.user.id, req.body || {}));
});

const addMembers = h(async (req, res) => {
  res.json(await conversations.addMembers(req.params.conversationId, req.user.id, req.body?.userIds));
});

const removeMember = h(async (req, res) => {
  res.json(await conversations.removeMember(req.params.conversationId, req.user.id, req.params.userId));
});

const setMemberRole = h(async (req, res) => {
  res.json(await conversations.setMemberRole(
    req.params.conversationId, req.user.id, req.params.userId, req.body?.role,
  ));
});

const searchUsers = h(async (req, res) => {
  res.json({ users: await conversations.searchUsers(req.user.id, req.query.q) });
});

const listMessages = h(async (req, res) => {
  res.json(await messages.listMessages(req.params.conversationId, req.user.id, {
    limit: req.query.limit, before: req.query.before,
  }));
});

const sendMessage = h(async (req, res) => {
  const { body, replyToId } = req.body || {};
  res.status(201).json(await messages.sendMessage(req.params.conversationId, req.user.id, { body, replyToId }));
});

const sendAttachment = h(async (req, res) => {
  const { body, replyToId } = req.body || {};
  res.status(201).json(await messages.sendAttachment(
    req.params.conversationId, req.user.id, req.file, { body, replyToId },
  ));
});

const attachmentUrl = h(async (req, res) => {
  res.json(await messages.getAttachmentUrl(req.params.conversationId, req.params.messageId, req.user.id));
});

const deleteMessage = h(async (req, res) => {
  res.json(await messages.deleteMessage(req.params.conversationId, req.params.messageId, req.user.id));
});

const markRead = h(async (req, res) => {
  res.json(await messages.markRead(req.params.conversationId, req.user.id));
});

const conversationCalls = h(async (req, res) => {
  const { before, limit } = req.query;
  res.json({
    active: await calls.getActiveCall(req.params.conversationId, req.user.id),
    history: await calls.listHistory(req.user.id, {
      conversationId: req.params.conversationId, before, limit,
    }),
  });
});

const startCall = h(async (req, res) => {
  try {
    res.status(201).json(await calls.startCall(req.params.conversationId, req.user.id, req.body?.kind));
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message, callId: err.callId });
    throw err;
  }
});

module.exports = {
  list, create, get, update, addMembers, removeMember, setMemberRole, searchUsers,
  listMessages, sendMessage, sendAttachment, attachmentUrl, deleteMessage, markRead,
  conversationCalls, startCall,
};
