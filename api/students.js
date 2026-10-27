'use strict';
const {parseBody, postAppsScript, send, serverConfig, statusFor} = require('./_lib/student-hub');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, {success:false, message:'仅支持 POST。'});
  const body = parseBody(req.body);
  if (!body || typeof body.auth_pwd !== 'string' || !body.auth_pwd || typeof body.year !== 'string' || !/^20\d{2}$/.test(body.year)) {
    return send(res, 400, {success:false, code:'VALIDATION', message:'登录状态或年度无效。'});
  }
  try {
    const {appScriptUrl} = serverConfig();
    const result = await postAppsScript(appScriptUrl, {
      action:'getStudentHubRoster',
      year:body.year,
      auth_pwd:body.auth_pwd
    });
    if (!result.data || !Array.isArray(result.data.items)) throw new Error('Apps Script 返回了无效名册。');
    return send(res, 200, {success:true, data:result.data});
  } catch (error) {
    return send(res, statusFor(error), {success:false, code:error.code || 'UPSTREAM', message:error.message || '读取 StudentHub 名单失败。'});
  }
};
