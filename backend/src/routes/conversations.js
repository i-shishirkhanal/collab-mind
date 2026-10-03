const express = require('express');
const c = require('../controllers/conversationController');
const authenticate = require('../middleware/authenticate');
const chatUpload = require('../middleware/chatUpload');
const { requireUuidParams } = require('../utils/http');
const { perUser } = require('../middleware/rateLimit');

// Messaging abuse controls (per user, per minute; tunable by env).
const sendLimit   = perUser('msg-send',   'MESSAGE_RATE_LIMIT_PER_MIN', 60);
const uploadLimit = perUser('msg-upload', 'MESSAGE_UPLOAD_RATE_LIMIT_PER_MIN', 10);
const createLimit = perUser('conv-create', 'CONVERSATION_CREATE_RATE_LIMIT_PER_MIN', 10);
const callLimit   = perUser('call-start', 'CALL_START_RATE_LIMIT_PER_MIN', 6);
const readLimit   = perUser('conv-read',  'CONVERSATION_READ_RATE_LIMIT_PER_MIN', 240);

const router = express.Router();
router.use(authenticate);
router.use(readLimit);

// Conversations (membership is verified inside each service call)
router.get('/', c.list);
router.post('/', createLimit, c.create);
router.get('/:conversationId', requireUuidParams('conversationId'), c.get);
router.patch('/:conversationId', requireUuidParams('conversationId'), c.update);

// Group members
router.post('/:conversationId/members', requireUuidParams('conversationId'), c.addMembers);
router.patch('/:conversationId/members/:userId', requireUuidParams('conversationId', 'userId'), c.setMemberRole);
router.delete('/:conversationId/members/:userId', requireUuidParams('conversationId', 'userId'), c.removeMember);

// Messages
router.get('/:conversationId/messages', requireUuidParams('conversationId'), c.listMessages);
router.post('/:conversationId/messages', sendLimit, requireUuidParams('conversationId'), c.sendMessage);
router.post('/:conversationId/attachments', uploadLimit, requireUuidParams('conversationId'), chatUpload, c.sendAttachment);
router.get(
  '/:conversationId/messages/:messageId/attachment',
  requireUuidParams('conversationId', 'messageId'),
  c.attachmentUrl,
);
router.delete('/:conversationId/messages/:messageId', requireUuidParams('conversationId', 'messageId'), c.deleteMessage);
router.post('/:conversationId/read', requireUuidParams('conversationId'), c.markRead);

// Calls scoped to a conversation
router.get('/:conversationId/calls', requireUuidParams('conversationId'), c.conversationCalls);
router.post('/:conversationId/calls', callLimit, requireUuidParams('conversationId'), c.startCall);

module.exports = router;
