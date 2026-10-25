'use strict';

const DEFAULT_STUDENT_API_URL = 'https://lgstudenthub.vercel.app/api/students';
const MAX_STUDENTS = 2000;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
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
function allowedStudentApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'lgstudenthub.vercel.app'
      && url.pathname === '/api/students' && !url.search && !url.hash;
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
async function authorize(url, password) {
  const result = await postAppsScript(url, { action: 'verifyPassword', auth_pwd: password });
  if (!['admin','teacher'].includes(result.role)) throw apiError('请先登录。', 'UNAUTHORIZED');
  return result.role;
}
async function getRosterYear(url, year, password) {
  const result = await postAppsScript(url, { action: 'getSnapshot', year, auth_pwd: password });
  if (!result.data || !Array.isArray(result.data.competitions)) throw apiError('Apps Script 返回了无效快照。');
  return String(result.data.rosterYear || '');
}
function formatStudentName(student) {
  const chineseName = typeof student.chineseName === 'string' ? student.chineseName.trim() : '';
  const name = typeof student.name === 'string' ? student.name.trim() : '';
  return [chineseName, name].filter(Boolean).join(' ');
}
async function readActiveStudents(apiUrl, apiKey) {
  const byId = new Map();
  const displayKeys = new Set();
  let offset = 0, expectedTotal = null, expectedCursor = null, expectedSchool = null, expectedApiVersion = null, pages = 0;
  do {
    if (++pages > MAX_PAGES) throw apiError('StudentHub 名单超过读取上限。', 'ROSTER_LIMIT');
    const url = new URL(apiUrl);
    url.searchParams.set('limit', String(PAGE_SIZE));
    // StudentHub may clamp the requested limit; follow its nextOffset rather than assuming 500 rows.
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + apiKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(8500)
    });
    const body = await readJson(response, '读取 StudentHub 名单失败。');
    const data = body && body.data;
    if (body.success !== true || !data || data.apiVersion !== 'v1' || !Array.isArray(data.items)
      || !Number.isInteger(data.total) || data.total < 0 || !Number.isInteger(data.syncCursor)
      || typeof data.schoolId !== 'string' || !data.schoolId.trim()
      || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > PAGE_SIZE
      || data.offset !== offset || data.items.length > data.limit) {
      throw apiError('StudentHub 返回了无法识别的名单格式。', 'ROSTER_SCHEMA');
    }
    if (expectedTotal === null) {
      expectedTotal = data.total; expectedCursor = data.syncCursor;
      expectedSchool = data.schoolId; expectedApiVersion = data.apiVersion;
    } else if (data.total !== expectedTotal || data.syncCursor !== expectedCursor
      || data.schoolId !== expectedSchool || data.apiVersion !== expectedApiVersion) {
      throw apiError('StudentHub 名单读取期间发生变化，请稍后重试。', 'ROSTER_CHANGED');
    }
    for (const item of data.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw apiError('StudentHub 学生记录格式无效。', 'ROSTER_SCHEMA');
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const className = typeof item.className === 'string' ? item.className.trim() : '';
      const displayName = formatStudentName(item);
      if (!UUID_RE.test(id) || !name || name.length > 160 || !className || className.length > 100
        || !displayName || displayName.length > 160
        || /[\u0000-\u001f\u007f\ufffd]/.test(displayName + className)) {
        throw apiError('StudentHub 学生记录缺少有效的 id、姓名或班级。', 'ROSTER_SCHEMA');
      }
      if (byId.has(id)) throw apiError('StudentHub 返回重复的学生 UUID。', 'ROSTER_SCHEMA');
      const displayKey = JSON.stringify([className.toUpperCase(), displayName.toUpperCase()]);
      if (displayKeys.has(displayKey)) throw apiError('同班存在相同显示姓名，无法安全区分报名对象；请在 StudentHub 中核对姓名。', 'ROSTER_AMBIGUOUS');
      displayKeys.add(displayKey);
      const studentId = item.studentId === undefined || item.studentId === null ? '' : String(item.studentId).trim();
      byId.set(id, {
        id,
        studentId,
        name,
        chineseName: typeof item.chineseName === 'string' ? item.chineseName.trim() : '',
        studentName: displayName,
        studentClass: className,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ''
      });
      if (byId.size > MAX_STUDENTS) throw apiError('StudentHub 名单超过读取上限。', 'ROSTER_LIMIT');
    }
    const next = data.nextOffset;
    if (next === null) {
      if (byId.size !== expectedTotal) throw apiError('StudentHub 分页不完整，请稍后重试。', 'ROSTER_INCOMPLETE');
      break;
    }
    if (!Number.isInteger(next) || next !== offset + data.items.length || next >= expectedTotal || data.items.length === 0) {
      throw apiError('StudentHub 分页游标无效。', 'ROSTER_CURSOR');
    }
    offset = next;
  } while (true);
  return { items: [...byId.values()], total: expectedTotal || 0, syncCursor: expectedCursor, schoolId: expectedSchool || '' };
}
function hmacMessage(payload) {
  return [String(payload.id), String(payload.year), String(payload.studentHubId), String(payload.studentName),
    String(payload.studentClass), String(payload.studentProofExpiresAt)].join('\n');
}
function signStudentHubRegistration(payload, key) {
  return require('node:crypto').createHmac('sha256', key).update(hmacMessage(payload)).digest('base64url');
}
function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}
function serverConfig() {
  const appScriptUrl = process.env.APPS_SCRIPT_URL || '';
  const apiKey = process.env.STUDENT_API_KEY || '';
  const studentApiUrl = process.env.STUDENT_API_URL || DEFAULT_STUDENT_API_URL;
  if (!allowedAppsScriptUrl(appScriptUrl) || !allowedStudentApiUrl(studentApiUrl) || !apiKey) {
    throw apiError('服务端尚未配置 APPS_SCRIPT_URL 和 STUDENT_API_KEY。', 'CONFIG');
  }
  return { appScriptUrl, apiKey, studentApiUrl };
}
function statusFor(error) {
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'FORBIDDEN') return 403;
  if (error.code === 'CONFIG') return 503;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'CONFLICT' || error.code === 'ROSTER_CHANGED' || error.code === 'ROSTER_AMBIGUOUS' || error.code === 'ROSTER_YEAR') return 409;
  if (error.code === 'VALIDATION') return 400;
  return 502;
}
module.exports = {DEFAULT_STUDENT_API_URL, UUID_RE, parseBody, apiError, readJson, allowedAppsScriptUrl,
  allowedStudentApiUrl, postAppsScript, authorize, getRosterYear, formatStudentName, readActiveStudents,
  hmacMessage, signStudentHubRegistration, send, serverConfig, statusFor};
