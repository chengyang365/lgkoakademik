'use strict';
const {parseBody, apiError, authorize, getRosterYear, readActiveStudents, signStudentHubRegistration, send, serverConfig, statusFor, UUID_RE, postAppsScript} = require('./_lib/student-hub');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, {success:false, message:'仅支持 POST。'});
  const body = parseBody(req.body);
  if (!body || typeof body.auth_pwd !== 'string' || !body.auth_pwd || typeof body.year !== 'string'
    || !/^20\d{2}$/.test(body.year) || typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(body.id)
    || typeof body.studentHubId !== 'string' || !UUID_RE.test(body.studentHubId)
    || typeof body.competitionId !== 'string' || !body.competitionId) {
    return send(res, 400, {success:false, code:'VALIDATION', message:'报名信息无效。'});
  }
  try {
    const {appScriptUrl, apiKey, studentApiUrl} = serverConfig();
    await authorize(appScriptUrl, body.auth_pwd);
    const rosterYear = await getRosterYear(appScriptUrl, body.year, body.auth_pwd);
    if (rosterYear !== body.year) throw apiError('所选年度不是 StudentHub 当前名册年度。', 'VALIDATION');
    const roster = await readActiveStudents(studentApiUrl, apiKey);
    const student = roster.items.find(item => item.id === body.studentHubId);
    if (!student) throw apiError('该学生已不在 StudentHub 当前在册名单中，请刷新后重试。', 'NOT_FOUND');
    const expires = String(Math.floor(Date.now() / 1000) + 300);
    const trusted = {
      id:body.id, year:body.year, studentHubId:student.id, studentName:student.studentName,
      studentClass:student.studentClass, studentProofExpiresAt:expires
    };
    const payload = {
      action:'registerStudentHub', id:body.id, year:body.year, auth_pwd:body.auth_pwd,
      competitionId:body.competitionId, studentHubId:student.id, studentName:student.studentName,
      studentClass:student.studentClass, teamId:body.teamId || '', teamName:body.teamName || '',
      note:body.note || '', studentProofExpiresAt:expires,
      studentHubProof:signStudentHubRegistration(trusted, apiKey)
    };
    const result = await postAppsScript(appScriptUrl, payload);
    return send(res, 200, {success:true, data:result.data});
  } catch (error) {
    return send(res, statusFor(error), {success:false, code:error.code || 'UPSTREAM', message:error.message || '报名提交失败。'});
  }
};
