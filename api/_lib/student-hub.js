'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseBody(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { return null; } }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}
function apiError(message, code = 'UPSTREAM') { const error = new Error(message); error.code = code; return error; }
function errorMessage(body, fallback) {
  return body && typeof body.message === 'string' && body.message.length < 300 ? body.message : fallback;
}
async function readJson(response, fallback) {
  let body;
  try { body = await response.json(); } catch (_) { throw apiError(fallback); }
  if (!response.ok) throw apiError(errorMessage(body, fallback), body && body.code || 'UPSTREAM');
  return body;
}
function allowedAppsScriptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)
      && !url.search && !url.hash;
  } catch (_) { return false; }
}
async function postAppsScript(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(8500)
  });
  const body = await readJson(response, 'Apps Script 请求失败。');
  if (body.status !== 'success') throw apiError(errorMessage(body, 'Apps Script 未接受请求。'), body.code || 'UPSTREAM');
  return body;
}
function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}
function serverConfig() {
  const appScriptUrl = process.env.APPS_SCRIPT_URL || '';
  if (!allowedAppsScriptUrl(appScriptUrl)) throw apiError('服务端尚未配置有效的 APPS_SCRIPT_URL。', 'CONFIG');
  return { appScriptUrl };
}
function statusFor(error) {
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'FORBIDDEN' || error.code === 'STUDENTHUB_AUTH') return 403;
  if (error.code === 'CONFIG' || error.code === 'BUSY') return 503;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'CONFLICT' || error.code === 'ROSTER_YEAR' || error.code === 'ROSTER_CHANGED' || error.code === 'ROSTER_AMBIGUOUS') return 409;
  if (error.code === 'VALIDATION') return 400;
  return 502;
}
module.exports = {UUID_RE, parseBody, apiError, readJson, allowedAppsScriptUrl, postAppsScript, send, serverConfig, statusFor};
