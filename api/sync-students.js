'use strict';

const DEFAULT_STUDENT_API_URL = 'https://lgstudenthub.vercel.app/api/students';
const MAX_STUDENTS = 5000;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}

function parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch (_) { return null; }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function errorMessage(body, fallback) {
  return body && typeof body.message === 'string' && body.message.length < 300 ? body.message : fallback;
}

async function readJson(response, fallback) {
  let body;
  try { body = await response.json(); } catch (_) { throw new Error(fallback); }
  if (!response.ok) throw new Error(errorMessage(body, fallback));
  return body;
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
  return readJson(response, 'Apps Script 请求失败。');
}

function allowedAppsScriptUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com'
      && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)
      && !url.search && !url.hash;
  } catch (_) { return false; }
}

async function readActiveStudents(apiUrl, apiKey) {
  const byId = new Map();
  let offset = 0, expectedTotal = null, expectedCursor = null, pages = 0;
  do {
    if (++pages > Math.ceil(MAX_STUDENTS / 500)) throw new Error('StudentHub 名单超过同步上限。');
    const url = new URL(apiUrl);
    url.searchParams.set('limit', '500');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('status', 'active');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8500)
    });
    const body = await readJson(response, '读取 StudentHub 名单失败。');
    if (body.success !== true || !body.data || !Array.isArray(body.data.items)
      || !Number.isInteger(body.data.total) || !Number.isInteger(body.data.syncCursor)) {
      throw new Error('StudentHub 返回了无法识别的名单格式。');
    }
    if (expectedTotal === null) {
      expectedTotal = body.data.total;
      expectedCursor = body.data.syncCursor;
    } else if (body.data.total !== expectedTotal || body.data.syncCursor !== expectedCursor) {
      throw new Error('StudentHub 名单同步期间发生变化，请稍后重试。');
    }
    for (const item of body.data.items) {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const className = typeof item.className === 'string' ? item.className.trim() : '';
      if (!id || !name || !className) {
        throw new Error('StudentHub API 密钥须授权 id、name、className 字段。');
      }
      byId.set(id, { id, name, className });
      if (byId.size > MAX_STUDENTS) throw new Error('StudentHub 名单超过同步上限。');
    }
    const next = body.data.nextOffset;
    if (next === null) {
      if (byId.size !== expectedTotal) throw new Error('StudentHub 分页不完整，请稍后重试。');
      break;
    }
    if (!Number.isInteger(next) || next <= offset || next >= expectedTotal) {
      throw new Error('StudentHub 分页游标无效。');
    }
    offset = next;
  } while (true);
  if (!byId.size) throw new Error('StudentHub 返回空名单；为避免误停用学生，已取消同步。');
  return [...byId.values()];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { success: false, message: '仅支持 POST。' });
  const body = parseBody(req.body);
  if (!body || typeof body.auth_pwd !== 'string' || !body.auth_pwd || typeof body.year !== 'string'
    || !/^20\\d{2}$/.test(body.year)) {
    return send(res, 400, { success: false, message: '登录状态或年度无效。' });
  }

  const appScriptUrl = process.env.APPS_SCRIPT_URL || '';
  const apiKey = process.env.STUDENT_API_KEY || '';
  const studentApiUrl = process.env.STUDENT_API_URL || DEFAULT_STUDENT_API_URL;
  if (!allowedAppsScriptUrl(appScriptUrl) || !apiKey) {
    return send(res, 503, { success: false, message: '服务端尚未配置 APPS_SCRIPT_URL 和 STUDENT_API_KEY。' });
  }
  try {
    const auth = await postAppsScript(appScriptUrl, { action: 'verifyPassword', auth_pwd: body.auth_pwd });
    if (auth.status !== 'success' || auth.role !== 'admin') {
      return send(res, auth.status === 'success' ? 403 : 401, { success: false, message: '只有管理员可以同步学生名单。' });
    }
    const students = await readActiveStudents(studentApiUrl, apiKey);
    const synced = await postAppsScript(appScriptUrl, {
      action: 'syncStudentRoster', year: body.year, auth_pwd: body.auth_pwd, students
    });
    if (synced.status !== 'success' || !synced.data) {
      const status = synced.code === 'UNAUTHORIZED' ? 401 : synced.code === 'FORBIDDEN' ? 403 : 400;
      return send(res, status, { success: false, message: errorMessage(synced, 'Apps Script 未接受名单同步。') });
    }
    return send(res, 200, { success: true, data: synced.data });
  } catch (error) {
    return send(res, 502, { success: false, message: error.message || 'StudentHub 同步失败。' });
  }
};
