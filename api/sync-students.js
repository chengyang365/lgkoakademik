'use strict';

const {send} = require('./_lib/student-hub');

// The live StudentHub roster is read through /api/students and is never written to Sheets.
// Keep this path as an explicit retirement response so stale clients cannot trigger bulk sheet changes.
module.exports = function handler(_req, res) {
  return send(res, 410, {success:false, code:'RETIRED', message:'名册已改为从 StudentHub 实时读取；请刷新页面。'});
};
