const axios = require('axios');
const { aiServiceToken } = require('../config/env');

/**
 * The only way the backend talks to the FastAPI AI service. It attaches the
 * shared service credential (AI_SERVICE_TOKEN) to every request, so the AI
 * service can reject anything that does not come from this backend.
 */
const baseURL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';

const request = (method, path, { data, timeout = 30_000 } = {}) =>
  axios.request({
    method,
    url: `${baseURL()}${path}`,
    data,
    timeout,
    headers: { Authorization: `Bearer ${aiServiceToken()}` },
  });

const post = (path, data, opts = {}) => request('post', path, { ...opts, data });
const get = (path, opts = {}) => request('get', path, opts);

module.exports = { post, get, baseURL };
