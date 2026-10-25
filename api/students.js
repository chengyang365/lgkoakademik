'use strict';
const {parseBody, apiError, authorize, getRosterYear, readActiveStudents, send, serverConfig, statusFor} = require('./_lib/student-hub');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, {success:false, message:'仅支持 POST。'});
  const body = parseBody(req.body);
  if (!body || typeof body.auth_pwd !== 'string' || !body.auth_pwd || typeof body.year !== 'string' || !/^20\d{2}$/.test(body.year)) {
    return send(res, 400, {success:false, message:'登录状态或年度无效。'});
  }
  try {
    const {appScriptUrl, apiKey, studentApiUrl} = serverConfig();
    await authorize(appScriptUrl, body.auth_pwd);
    const rosterYear = await getRosterYear(appScriptUrl, body.year, body.auth_pwd);
    if (rosterYear !== body.year) throw apiError('该年度使用本地历史名册。', 'ROSTER_YEAR');
    const roster = await readActiveStudents(studentApiUrl, apiKey);
    return send(res, 200, {success:true, data:{items:roster.items.map(s=>({...s,source:'studenthub'})), total:roster.total, schoolId:roster.schoolId, syncCursor:roster.syncCursor}});
  } catch (error) {
    return send(res, statusFor(error), {success:false, code:error.code || 'UPSTREAM', message:error.message || '读取 StudentHub 名单失败。'});
  }
};
