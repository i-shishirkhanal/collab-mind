const calls = require('../services/callService');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const history = h(async (req, res) => {
  res.json({ calls: await calls.listHistory(req.user.id, { before: req.query.before, limit: req.query.limit }) });
});

const pending = h(async (req, res) => {
  res.json({ calls: await calls.listPendingForUser(req.user.id) });
});

const join    = h(async (req, res) => res.json(await calls.joinCall(req.params.callId, req.user.id)));
const decline = h(async (req, res) => res.json({ call: await calls.declineCall(req.params.callId, req.user.id) }));
const leave   = h(async (req, res) => res.json({ call: await calls.leaveCall(req.params.callId, req.user.id) }));
const end     = h(async (req, res) => res.json({ call: await calls.endCall(req.params.callId, req.user.id) }));
const token   = h(async (req, res) => res.json(await calls.issueToken(req.params.callId, req.user.id)));

module.exports = { history, pending, join, decline, leave, end, token };
