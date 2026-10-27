'use strict';
const {parseBody, apiError, postAppsScript, send, serverConfig, statusFor, UUID_RE} = require('./_lib/student-hub');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, {success:false, message:'仅支持 POST。'});
  const body = parseBody(req.body);
  if (!body || typeof body.auth_pwd !== 'string' || !body.auth_pwd || typeof body.year !== 'string'
    || !/^20\d{2}$/.test(body.year) || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(body.id)
    || typeof body.studentHubId !== 'string' || !UUID_RE.test(body.studentHubId)
    || typeof body.competitionId !== 'string' || !body.competitionId || body.competitionId.length > 100) {
    return send(res, 400, {success:false, code:'VALIDATION', message:'报名信息无效。'});
  }
  try {
    const {appScriptUrl} = serverConfig();
    const result = await postAppsScript(appScriptUrl, {
      action:'registerStudentHub',
      id:body.id,
      year:body.year,
      auth_pwd:body.auth_pwd,
      competitionId:body.competitionId,
      studentHubId:body.studentHubId,
      teamId:typeof body.teamId === 'string' ? body.teamId : '',
      teamName:typeof body.teamName === 'string' ? body.teamName : '',
      note:typeof body.note === 'string' ? body.note : ''
    });
    return send(res, 200, {success:true, data:result.data});
  } catch (error) {
    return send(res, statusFor(error), {success:false, code:error.code || 'UPSTREAM', message:error.message || '报名提交失败。'});
  }
};
