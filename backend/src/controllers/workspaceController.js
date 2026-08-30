const workspaceService = require('../services/workspaceService');

/**
 * listWorkspaces — GET /workspaces
 * Returns all workspaces the authenticated user belongs to.
 */
const listWorkspaces = async (req, res, next) => {
  try {
    const workspaces = await workspaceService.getUserWorkspaces(req.user.id);
    res.json(workspaces);
  } catch (err) {
    next(err);
  }
};

/**
 * createWorkspace — POST /workspaces
 * Body: { name, description?, avatar_url? }
 */
const createWorkspace = async (req, res, next) => {
  try {
    const { name, description, avatar_url } = req.body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name is required' });
    }

    const workspace = await workspaceService.createWorkspace(req.user.id, {
      name: name.trim(),
      description,
      avatar_url,
    });

    res.status(201).json(workspace);
  } catch (err) {
    next(err);
  }
};

/**
 * getWorkspace — GET /workspaces/:workspaceId
 * req.membership is already verified by requireWorkspaceMember.
 */
const getWorkspace = async (req, res, next) => {
  try {
    const workspace = await workspaceService.getWorkspaceById(req.params.workspaceId);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    res.json({ ...workspace, role: req.membership.role });
  } catch (err) {
    next(err);
  }
};

/**
 * updateWorkspace — PUT /workspaces/:workspaceId
 * Body: { name?, description?, avatar_url? }
 * Requires owner role (enforced by requireRole middleware on the route).
 */
const updateWorkspace = async (req, res, next) => {
  try {
    const { name, description, avatar_url } = req.body;
    const updated = await workspaceService.updateWorkspace(req.params.workspaceId, {
      name,
      description,
      avatar_url,
    });

    if (!updated) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
};

/**
 * deleteWorkspace — DELETE /workspaces/:workspaceId
 * Requires owner role (enforced by requireRole middleware on the route).
 */
const deleteWorkspace = async (req, res, next) => {
  try {
    await workspaceService.deleteWorkspace(req.params.workspaceId);
    res.status(204).end(); // 204 No Content — success with no body
  } catch (err) {
    next(err);
  }
};

module.exports = { listWorkspaces, createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace };
