const { getMembership } = require('../services/workspaceAccess');
const { isUuid } = require('../utils/http');

/**
 * requireWorkspaceMember middleware
 * ──────────────────────────────────
 * Runs AFTER `authenticate`. Confirms req.user belongs to the workspace in
 * req.params.workspaceId and attaches the membership (including role) as
 * req.membership. Non-members get 403 (the same answer whether or not the
 * workspace exists, so ids cannot be probed).
 */
const requireWorkspaceMember = async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    if (!isUuid(workspaceId)) return res.status(400).json({ error: 'Invalid workspaceId' });

    const membership = await getMembership(req.user.id, workspaceId);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this workspace' });
    }

    req.membership = membership;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireWorkspaceMember;
