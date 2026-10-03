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
/**
 * Validates workspace fields. Returns { error } or { value } with trimmed strings. Omitted fields stay
 * undefined; an empty description/avatar_url string clears the field.
 */
const validateFields = (body, { requireName }) => {
  const { name, description, avatar_url } = body && typeof body === 'object' ? body : {};
  const value = {};
  if (name !== undefined || requireName) {
    if (typeof name !== 'string' || name.trim() === '') return { error: 'name is required' };
    if (name.trim().length > 120) return { error: 'name must be at most 120 characters' };
    value.name = name.trim();
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 2000) return { error: 'description must be text of at most 2000 characters' };
    value.description = description.trim();
  }
  if (avatar_url !== undefined && avatar_url !== null) {
    if (typeof avatar_url !== 'string' || avatar_url.length > 2048 || (avatar_url !== '' && !/^https:\/\//i.test(avatar_url))) {
      return { error: 'avatar_url must be an https URL' };
    }
    value.avatar_url = avatar_url;
  }
  return { value };
};

const createWorkspace = async (req, res, next) => {
  try {
    const { error, value } = validateFields(req.body, { requireName: true });
    if (error) return res.status(400).json({ error });

    const workspace = await workspaceService.createWorkspace(req.user.id, {
      name: value.name,
      description: value.description,
      avatar_url: value.avatar_url,
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
    const { error, value } = validateFields(req.body, { requireName: false });
    if (error) return res.status(400).json({ error });
    const updated = await workspaceService.updateWorkspace(req.params.workspaceId, {
      name: value.name,
      description: value.description,
      avatar_url: value.avatar_url,
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
