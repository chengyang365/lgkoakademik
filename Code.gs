/** School competitions API v7. Configure Script Properties; never commit passwords. */
const SCRIPT_VERSION = '7.0';
const TABLES = {
  Competitions: ['id', 'year', 'name', 'organizer', 'status', 'startDate', 'endDate', 'version', 'deleted', 'lastOperationId'],
  Students: ['id', 'year', 'studentClass', 'studentName', 'version', 'deleted', 'lastOperationId'],
  Results: ['id', 'year', 'studentId', 'competitionId', 'teamId', 'teamName', 'score', 'rank', 'note', 'version', 'deleted', 'lastOperationId', 'studentNameSnapshot', 'studentClassSnapshot', 'studentStatus'],
  Operations: ['id', 'request', 'table', 'recordId', 'before', 'after', 'status', 'actor', 'createdAt', 'completedAt']
};
const WRITES = ['register', 'registerStudentHub', 'updateScore', 'batchUpdateScores', 'deleteRegistration', 'addCompetition', 'editCompetition', 'deleteCompetition', 'toggleStatus'];
const RANKS = ['', '冠军', '亚军', '季军', '第四名', '第五名', '第六名', '第七名', '第八名', '第九名', '第十名', '优秀奖'];

function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
function value(v) { return v === null || v === undefined ? '' : String(v); }
function props() { return PropertiesService.getScriptProperties(); }
function database() {
  var id = props().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) fail('CONFIG', 'Set SPREADSHEET_ID in Script Properties.');
  return ss;
}
function table(ss, name) {
  var sheet = ss.getSheetByName(name + '_v7');
  if (!sheet) fail('MIGRATION_REQUIRED', 'Run migrateLegacyDatabase from the script editor first.');
  var rows = sheet.getDataRange().getValues();
  if (JSON.stringify(rows[0]) !== JSON.stringify(TABLES[name])) fail('SCHEMA', 'Unexpected headers: ' + name);
  return rows.slice(1).filter(function(r) { return value(r[0]) !== ''; }).map(function(r) {
    var obj = {}; TABLES[name].forEach(function(k, i) { obj[k] = r[i]; }); return obj;
  });
}
// Store user-provided strings as literal text, never spreadsheet formulas.
function cell(v) { return typeof v === 'string' && /^[=+\-@']/.test(v) ? "'" + v : (v === undefined ? '' : v); }
function put(ss, name, obj) {
  var sheet = ss.getSheetByName(name + '_v7');
  var rows = sheet.getDataRange().getValues();
  var row = rows.findIndex(function(r, i) { return i > 0 && value(r[0]) === value(obj.id); });
  var values = TABLES[name].map(function(k) { return cell(obj[k]); });
  sheet.getRange(row < 0 ? sheet.getLastRow() + 1 : row + 1, 1, 1, values.length).setValues([values]);
}
function active(r, year) { return value(r.year) === year && value(r.deleted) !== 'true'; }
function yearOf(p) {
  var y = value(p.year);
  if (!/^20\d{2}$/.test(y)) fail('VALIDATION', 'A four-digit year is required (2000–2099).');
  return y;
}
function textField(v, label, max, required) {
  var s = value(v).trim();
  if ((required && !s) || s.length > max) fail('VALIDATION', 'Invalid ' + label);
  return s;
}
function roleOf(p) {
  var secret = props().getProperty('ADMIN_PWD');
  if (!secret || secret.length < 12) fail('CONFIG', 'Set a new ADMIN_PWD of at least 12 characters in Script Properties.');
  if (p.auth_pwd === secret) return 'admin';
  var teacher = props().getProperty('TEACHER_PWD');
  if (teacher && Array.from(teacher).length === 4 && p.auth_pwd === teacher) return 'teacher';
  return '';
}
function readStudentHubRoster() {
  var apiKey = props().getProperty('STUDENT_API_KEY');
  if (!apiKey) fail('CONFIG', 'Set STUDENT_API_KEY in Apps Script Properties.');
  var byId = {}, displayKeys = new Set(), offset = 0;
  var expectedTotal = null, expectedCursor = null, expectedSchool = null, pages = 0;
  do {
    if (++pages > 20) fail('ROSTER_LIMIT', 'StudentHub roster exceeds the read limit.');
    var url = 'https://lgstudenthub.vercel.app/api/students?limit=500&offset=' + offset;
    var response;
    try {
      response = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + apiKey },
        muteHttpExceptions: true
      });
    } catch (e) {
      fail('STUDENTHUB_UNAVAILABLE', 'Could not reach StudentHub. Please try again.');
    }
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      fail(status === 401 || status === 403 ? 'STUDENTHUB_AUTH' : 'STUDENTHUB_UNAVAILABLE',
        status === 401 || status === 403 ? 'StudentHub rejected its server API key.' : 'StudentHub is temporarily unavailable.');
    }
    var body;
    try { body = JSON.parse(response.getContentText()); }
    catch (e) { fail('ROSTER_SCHEMA', 'StudentHub returned invalid JSON.'); }
    var data = body && body.data;
    if (!body || body.success !== true || !data || data.apiVersion !== 'v1' || !Array.isArray(data.items)
      || !Number.isInteger(data.total) || data.total < 0 || !Number.isInteger(data.syncCursor)
      || typeof data.schoolId !== 'string' || !data.schoolId.trim()
      || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 500
      || data.offset !== offset || data.items.length > data.limit) {
      fail('ROSTER_SCHEMA', 'StudentHub returned an unsupported roster format.');
    }
    if (expectedTotal === null) {
      expectedTotal = data.total; expectedCursor = data.syncCursor; expectedSchool = data.schoolId;
    } else if (data.total !== expectedTotal || data.syncCursor !== expectedCursor
      || data.schoolId !== expectedSchool) {
      fail('ROSTER_CHANGED', 'StudentHub roster changed while it was being read. Please retry.');
    }
    data.items.forEach(function(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('ROSTER_SCHEMA', 'Invalid StudentHub student record.');
      var id = value(item.id).trim(), englishName = value(item.name).trim();
      var chineseName = value(item.chineseName).trim(), studentClass = value(item.className).trim();
      var studentName = [chineseName, englishName].filter(Boolean).join(' ');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        || !englishName || englishName.length > 160 || !studentClass || studentClass.length > 100
        || !studentName || studentName.length > 160
        || /[\u0000-\u001f\u007f\ufffd]/.test(studentName + studentClass)) {
        fail('ROSTER_SCHEMA', 'StudentHub student is missing a valid ID, name, or class.');
      }
      if (byId[id]) fail('ROSTER_SCHEMA', 'StudentHub returned a duplicate student ID.');
      var displayKey = JSON.stringify([studentClass.toUpperCase(), studentName.toUpperCase()]);
      if (displayKeys.has(displayKey)) fail('ROSTER_AMBIGUOUS', 'Students in the same class have duplicate display names.');
      displayKeys.add(displayKey);
      byId[id] = {
        id: id,
        studentId: item.studentId === null || item.studentId === undefined ? '' : value(item.studentId).trim(),
        name: englishName,
        chineseName: chineseName,
        studentName: studentName,
        studentClass: studentClass,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ''
      };
      if (Object.keys(byId).length > 2000) fail('ROSTER_LIMIT', 'StudentHub roster exceeds the read limit.');
    });
    var next = data.nextOffset;
    if (next === null) {
      if (Object.keys(byId).length !== expectedTotal) fail('ROSTER_INCOMPLETE', 'StudentHub roster is incomplete. Please retry.');
      break;
    }
    if (!Number.isInteger(next) || next !== offset + data.items.length
      || next >= expectedTotal || data.items.length === 0) {
      fail('ROSTER_CURSOR', 'StudentHub returned an invalid page cursor.');
    }
    offset = next;
  } while (true);
  return { items: Object.keys(byId).map(function(id) { return byId[id]; }),
    total: expectedTotal || 0, syncCursor: expectedCursor, schoolId: expectedSchool || '' };
}
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) { return handleRequest(e && e.parameter || {}, 'GET'); }
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) fail('VALIDATION', 'No data.');
    var p = JSON.parse(e.postData.contents);
    if (!p || Array.isArray(p) || typeof p !== 'object') fail('VALIDATION', 'Expected an object.');
    return handleRequest(p, 'POST');
  } catch (e) { return jsonResponse({ status: 'error', code: e.code || 'VALIDATION', message: e.message }); }
}
function handleRequest(p, method) {
  var lock;
  try {
    var action = value(p.action);
    var isWrite = WRITES.indexOf(action) >= 0;
    var isRosterSync = action === 'syncStudentRoster';
    var isStudentHubRoster = action === 'getStudentHubRoster';
    if ((isWrite || action === 'verifyPassword' || isRosterSync || isStudentHubRoster) && method !== 'POST') fail('METHOD', 'Use POST for writes and authentication.');
    var role = roleOf(p);
    if (isWrite || action === 'verifyPassword' || isRosterSync || isStudentHubRoster) {
      if (!role) fail('UNAUTHORIZED', 'Please sign in.');
      if (isRosterSync && role !== 'admin') fail('FORBIDDEN', 'Administrator permission required.');
      if (isWrite && ['register', 'registerStudentHub', 'updateScore', 'batchUpdateScores'].indexOf(action) < 0 && role !== 'admin') fail('FORBIDDEN', 'Administrator permission required.');
    }
    if (action === 'verifyPassword') return jsonResponse({ status: 'success', role: role, version: SCRIPT_VERSION });
    var year = yearOf(p);
    var isHubRosterAction = isRosterSync || isStudentHubRoster || action === 'registerStudentHub';
    if (isHubRosterAction && value(props().getProperty('ROSTER_YEAR')) !== year) {
      fail('ROSTER_YEAR', 'This year is not configured for the StudentHub roster.');
    }
    var ss = database();
    if (props().getProperty('SCHEMA_VERSION') !== SCRIPT_VERSION) fail('MIGRATION_REQUIRED', 'Run migration in the script editor.');
    // Only the explicit admin sync action reads from StudentHub. Ordinary reads and registrations use Students_v7.
    var incomingRoster = null;
    if (isRosterSync) {
      incomingRoster = readStudentHubRoster();
      if (!incomingRoster.items.length) fail('ROSTER_EMPTY', 'StudentHub returned an empty roster; no changes were made.');
    }
    // Use the same lock for cached reads and writes to avoid seeing half-completed sheet updates.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) { lock = null; fail('BUSY', 'System busy. Retry later.'); }
    recoverPrepared(ss);
    if (isRosterSync) {
      return jsonResponse({ status: 'success', data: syncStudentRosterToSheet(ss, year, incomingRoster), version: SCRIPT_VERSION });
    }
    if (isStudentHubRoster) {
      var cachedRoster = readCachedStudentHubRoster(ss, year);
      return jsonResponse({ status: 'success', data: {
        items: cachedRoster, total: cachedRoster.length,
        schoolId: props().getProperty('STUDENT_HUB_SCHOOL_ID') || '',
        syncCursor: Number(props().getProperty('STUDENT_HUB_SYNC_CURSOR') || 0)
      }, version: SCRIPT_VERSION });
    }
    var hubStudent = null;
    if (action === 'registerStudentHub') {
      var hubId = textField(p.studentHubId, 'StudentHub student ID', 100, true);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hubId)) fail('VALIDATION', 'Invalid StudentHub student ID.');
      hubStudent = findCachedStudentHubStudent(ss, year, hubId);
      if (!hubStudent) fail('NOT_FOUND', 'This student is not in the last manually synchronized roster.');
    }
    if (action === 'batchUpdateScores') {
      if (!Array.isArray(p.operations) || p.operations.length < 1 || p.operations.length > 20) fail('VALIDATION', 'Batch must contain 1–20 score operations.');
      var outcomes = [];
      for (var b = 0; b < p.operations.length; b++) {
        var item = p.operations[b];
        try {
          if (!item || item.action !== 'updateScore' || yearOf(item) !== year) fail('VALIDATION', 'Mixed actions/years are not allowed in a score batch.');
          outcomes.push(Object.assign({ id:item.id }, writeAction(ss,item,year,role)));
        } catch (error) {
          outcomes.push({ id:item && item.id, status:'error', code:error.code || 'SERVER', message:error.code ? error.message : 'Retry this operation with the same ID.' });
          break;
        }
      }
      return jsonResponse({ status:'success', outcomes:outcomes });
    }
    if (isWrite) return jsonResponse(writeAction(ss, p, year, role, hubStudent));
    var comps = table(ss, 'Competitions').filter(function(r) { return active(r, year); });
    var students = role ? table(ss, 'Students').filter(function(r) { return active(r, year); }) : [];
    var results = role ? table(ss, 'Results').filter(function(r) { return active(r, year); }) : [];
    var hubMappings = role ? readStudentHubMappings(ss) : [];
    var hubByLocalId = {};
    hubMappings.forEach(function(m) { if (m.year === year) hubByLocalId[m.studentId] = m.hubStudentId; });
    var visible = results.filter(function(r) { return comps.some(function(c) { return c.id === r.competitionId; }); }).map(function(r) {
      var student = students.find(function(s) { return s.id === r.studentId; });
      var comp = comps.find(function(c) { return c.id === r.competitionId; });
      var fallbackName = value(r.studentNameSnapshot) || (student ? student.studentName : '');
      var fallbackClass = value(r.studentClassSnapshot) || (student ? student.studentClass : '');
      var studentHubId = hubByLocalId[value(r.studentId)] || (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value(r.studentId)) ? value(r.studentId) : '');
      return Object.assign({}, r, { score: value(r.score), rank: value(r.rank), note: value(r.note),
        studentName: fallbackName + (r.teamName ? ' [' + r.teamName + ']' : ''),
        studentClass: fallbackClass, studentHubId: studentHubId, category: comp.name });
    });
    var years = Array.from(new Set(table(ss, 'Competitions').filter(function(r) { return value(r.deleted) !== 'true'; }).map(function(r) { return value(r.year); }).concat([year]))).sort();
    if (action === 'getSnapshot') return jsonResponse({ status: 'success', data: {
      competitions: comps, students: students, results: visible, years: years,
      authenticated: !!role, rosterYear: value(props().getProperty('ROSTER_YEAR')),
      rosterLastSync: props().getProperty('STUDENT_HUB_LAST_SYNC_AT') || ''
    }, version: SCRIPT_VERSION });
    if (action === 'getCompetitions') return jsonResponse({ status: 'success', data: comps });
    if (action === 'getStudents' || action === 'getResults') {
      if (!role) fail('UNAUTHORIZED', 'Sign in to view student records.');
      return jsonResponse({ status: 'success', data: action === 'getStudents' ? students : visible });
    }
    fail('VALIDATION', 'Unknown action.');
  } catch (e) {
    return jsonResponse({ status: 'error', code: e.code || 'SERVER', message: e.code ? e.message : 'Server operation failed; retry with the same operation ID.' });
  } finally { if (lock) { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } } }
}
function recoverPrepared(ss) {
  table(ss, 'Operations').forEach(function(op) {
    if (op.status !== 'prepared') return;
    var after = JSON.parse(op.after);
    put(ss, op.table, after);
    SpreadsheetApp.flush();
    op.status = 'done'; op.completedAt = new Date().toISOString(); put(ss, 'Operations', op);
    SpreadsheetApp.flush();
  });
}
function requestKey(p) {
  // Ignore transport-only/UI fields; never put passwords or StudentHub proofs in the operation journal.
  var keys = ['action','year','recordId','competitionId','studentId','studentHubId','studentName','studentClass','teamId','teamName','expectedVersion','name','organizer','startDate','endDate','newName','status','score','rank','note'];
  var obj = {}; keys.forEach(function(k) { if (p[k] !== undefined) obj[k] = p[k]; }); return JSON.stringify(obj);
}
function checkVersion(row, p) {
  if (!Number.isInteger(p.expectedVersion) || Number(row.version) !== p.expectedVersion) fail('CONFLICT', 'This record changed on another device. Refresh and review before saving.');
}
function dateField(v) {
  var s = value(v);
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) fail('VALIDATION', 'Invalid date.');
  return s;
}
function readStudentHubMappings(ss) {
  var sheet = ss.getSheetByName('_StudentHubMap_v1');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var headers = ['hubStudentId','year','studentId'];
  if (JSON.stringify(data[0]) !== JSON.stringify(headers)) fail('SCHEMA', 'Unexpected headers: StudentHub map.');
  var seen = new Set();
  return data.slice(1).filter(function(r) { return value(r[0]) !== ''; }).map(function(r) {
    var mapping = {hubStudentId:value(r[0]),year:value(r[1]),studentId:value(r[2])};
    var key = JSON.stringify([mapping.year,mapping.hubStudentId]);
    if (!mapping.hubStudentId || !mapping.year || !mapping.studentId || seen.has(key)) fail('SCHEMA', 'Duplicate or invalid StudentHub mapping.');
    seen.add(key); return mapping;
  });
}
function localStudentIdsForHub(ss, year, hubId) {
  var rows = readStudentHubMappings(ss).filter(function(m) { return m.year === year && m.hubStudentId === hubId; });
  if (rows.length > 1) fail('SCHEMA', 'Duplicate StudentHub mapping.');
  return rows.map(function(m) { return m.studentId; });
}
function ensureStudentHubMapSheet(ss) {
  var sheet = ss.getSheetByName('_StudentHubMap_v1');
  if (!sheet) sheet = ss.insertSheet('_StudentHubMap_v1');
  var data = sheet.getDataRange().getValues();
  var headers = ['hubStudentId','year','studentId'];
  if (!data.length || !data[0] || data[0].every(function(v) { return value(v) === ''; })) {
    sheet.clearContents();
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sheet;
}
function writeSheetRows(sheet, rows, width) {
  sheet.clearContents();
  if (rows.length) sheet.getRange(1,1,rows.length,width).setValues(rows);
}
function readCachedStudentHubRoster(ss, year) {
  var students = table(ss, 'Students').filter(function(r) { return active(r, year); });
  var byId = {};
  students.forEach(function(student) { byId[value(student.id)] = student; });
  var items = [];
  var seen = new Set();
  readStudentHubMappings(ss).filter(function(m) { return m.year === year; }).forEach(function(mapping) {
    var student = byId[mapping.studentId];
    if (!student || seen.has(mapping.hubStudentId)) return;
    seen.add(mapping.hubStudentId);
    items.push({id:mapping.hubStudentId,studentName:value(student.studentName),studentClass:value(student.studentClass)});
  });
  // Older imported sheets may use the StudentHub UUID as the local ID and predate the mapping tab.
  students.forEach(function(student) {
    var id = value(student.id);
    if (!seen.has(id) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      seen.add(id);
      items.push({id:id,studentName:value(student.studentName),studentClass:value(student.studentClass)});
    }
  });
  return items;
}
function findCachedStudentHubStudent(ss, year, hubId) {
  var localIds = localStudentIdsForHub(ss, year, hubId);
  var localId = localIds.length ? localIds[0] : hubId;
  var student = table(ss, 'Students').find(function(r) {
    return value(r.id) === localId && active(r, year);
  });
  return student ? {id:hubId,localStudentId:value(student.id),studentName:value(student.studentName),studentClass:value(student.studentClass)} : null;
}
function syncStudentRosterToSheet(ss, year, roster) {
  if (!roster || !Array.isArray(roster.items) || !roster.items.length) fail('ROSTER_EMPTY', 'StudentHub returned an empty roster; no changes were made.');
  var priorCursor = Number(props().getProperty('STUDENT_HUB_SYNC_CURSOR') || -1);
  if (Number.isFinite(priorCursor) && priorCursor > roster.syncCursor) fail('ROSTER_STALE', 'StudentHub returned an older roster snapshot; no changes were made.');
  var studentSheet = ss.getSheetByName('Students_v7');
  if (!studentSheet) fail('MIGRATION_REQUIRED', 'Run migrateLegacyDatabase from the script editor first.');
  var mapSheet = ensureStudentHubMapSheet(ss);
  var currentStudents = table(ss, 'Students').map(function(r) { return Object.assign({}, r); });
  var allMappings = readStudentHubMappings(ss);
  var mappingByKey = {};
  allMappings.forEach(function(m) { mappingByKey[JSON.stringify([m.year,m.hubStudentId])] = m; });
  var studentById = new Map();
  currentStudents.forEach(function(r) {
    var id = value(r.id);
    if (studentById.has(id)) fail('SCHEMA', 'Duplicate student ID in Students_v7.');
    studentById.set(id, r);
  });
  var syncId = 'sync_' + Utilities.getUuid();
  var incomingLocalIds = new Set(), seenHubIds = new Set();
  var added = 0, updated = 0, deactivated = 0;
  var studentRows = currentStudents;
  var nextMappings = Object.assign({}, mappingByKey);
  roster.items.forEach(function(item) {
    var hubId = value(item.id);
    if (!hubId || seenHubIds.has(hubId)) fail('ROSTER_SCHEMA', 'StudentHub returned a duplicate or blank student ID.');
    seenHubIds.add(hubId);
    var key = JSON.stringify([year,hubId]);
    var mapping = mappingByKey[key];
    var existing = mapping ? studentById.get(mapping.studentId) : studentById.get(hubId);
    if (existing && value(existing.year) !== year) {
      if (mapping) fail('SCHEMA', 'Student mapping points to a different year.');
      existing = null;
    }
    var localId = existing ? value(existing.id) : (mapping ? mapping.studentId : Utilities.getUuid());
    if (studentById.has(localId) && value(studentById.get(localId).year) !== year) fail('SCHEMA', 'Student ID is already used by another year.');
    incomingLocalIds.add(localId);
    if (existing) {
      var changed = value(existing.studentName) !== value(item.studentName)
        || value(existing.studentClass) !== value(item.studentClass)
        || value(existing.deleted) === 'true';
      if (changed) {
        existing.studentName = item.studentName;
        existing.studentClass = item.studentClass;
        existing.deleted = false;
        existing.version = Number(existing.version) + 1;
        existing.lastOperationId = syncId;
        updated++;
      }
    } else {
      existing = {id:localId,year:year,studentClass:item.studentClass,studentName:item.studentName,
        version:1,deleted:false,lastOperationId:syncId};
      studentById.set(localId, existing);
      studentRows.push(existing);
      added++;
    }
    nextMappings[key] = {hubStudentId:hubId,year:year,studentId:localId};
  });
  studentRows.forEach(function(student) {
    if (value(student.year) === year && value(student.deleted) !== 'true' && !incomingLocalIds.has(value(student.id))) {
      student.deleted = true;
      student.version = Number(student.version) + 1;
      student.lastOperationId = syncId;
      deactivated++;
    }
  });
  var mappingRows = [ ['hubStudentId','year','studentId'] ];
  Object.keys(nextMappings).forEach(function(key) {
    var mapping = nextMappings[key];
    mappingRows.push([cell(mapping.hubStudentId),cell(mapping.year),cell(mapping.studentId)]);
  });
  var studentValues = [TABLES.Students].concat(studentRows.map(function(student) {
    return TABLES.Students.map(function(key) { return cell(student[key]); });
  }));
  var oldStudents = studentSheet.getDataRange().getValues();
  var oldMappings = mapSheet.getDataRange().getValues();
  try {
    writeSheetRows(mapSheet, mappingRows, 3);
    writeSheetRows(studentSheet, studentValues, TABLES.Students.length);
  } catch (e) {
    try {
      writeSheetRows(studentSheet, oldStudents, TABLES.Students.length);
      writeSheetRows(mapSheet, oldMappings, 3);
    } catch (restoreError) {}
    throw e;
  }
  props().setProperty('STUDENT_HUB_SYNC_CURSOR', String(roster.syncCursor));
  props().setProperty('STUDENT_HUB_SCHOOL_ID', roster.schoolId || '');
  props().setProperty('STUDENT_HUB_LAST_SYNC_AT', new Date().toISOString());
  return {added:added,updated:updated,deactivated:deactivated,total:roster.items.length,
    schoolId:roster.schoolId || '',syncCursor:roster.syncCursor};
}
function writeAction(ss, p, year, role, hubStudent) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(value(p.id))) fail('VALIDATION', 'A unique operation ID is required.');
  var request = requestKey(p);
  var prior = table(ss, 'Operations').find(function(o) { return o.id === p.id; });
  if (prior) {
    if (prior.request !== request) fail('CONFLICT', 'Operation ID reused with different data.');
    return { status: 'success', data: JSON.parse(prior.after), replay: true };
  }
  var action = p.action, name = 'Results', before = null, after;
  var comps = table(ss, 'Competitions');
  if (['addCompetition','editCompetition','deleteCompetition','toggleStatus'].indexOf(action) >= 0) {
    name = 'Competitions';
    if (action === 'addCompetition') {
      after = { id: Utilities.getUuid(), year: year, status: 'open', version: 0, deleted: false };
    } else {
      before = comps.find(function(r) { return r.id === p.competitionId && active(r, year); });
      if (!before) fail('NOT_FOUND', 'Competition not found.');
      checkVersion(before, p); after = Object.assign({}, before);
    }
    if (action === 'addCompetition' || action === 'editCompetition') {
      after.name = textField(action === 'addCompetition' ? p.name : p.newName, 'competition name', 160, true);
      after.organizer = textField(p.organizer, 'organizer', 160, false);
      after.startDate = dateField(p.startDate); after.endDate = dateField(p.endDate);
      if (after.startDate && after.endDate && after.startDate > after.endDate) fail('VALIDATION', 'End date precedes start date.');
      if (comps.some(function(c) { return active(c, year) && c.id !== after.id && c.name === after.name; })) fail('VALIDATION', 'Competition name already exists in this year.');
    }
    if (action === 'deleteCompetition') after.deleted = true;
    if (action === 'toggleStatus') {
      if (['open','closed'].indexOf(p.status) < 0) fail('VALIDATION', 'Explicit status required.');
      after.status = p.status;
    }
  } else {
    var comp = comps.find(function(c) { return c.id === p.competitionId && active(c, year); });
    if (!comp) fail('NOT_FOUND', 'Competition not found.');
    var rows = table(ss, 'Results');
    if (action === 'register' || action === 'registerStudentHub') {
      var today = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd');
      if (comp.status !== 'open' || (comp.startDate && today < comp.startDate) || (comp.endDate && today > comp.endDate)) fail('VALIDATION', 'Registration is closed.');
      var isHubRegistration = action === 'registerStudentHub';
      var student, studentHubId = '', resultStudentId = '';
      if (isHubRegistration) {
        studentHubId = textField(p.studentHubId, 'StudentHub student ID', 100, true);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentHubId)) fail('VALIDATION', 'Invalid StudentHub student ID.');
        if (!hubStudent || hubStudent.id !== studentHubId) fail('NOT_FOUND', 'StudentHub identity could not be verified.');
        var studentName = hubStudent.studentName;
        var studentClass = hubStudent.studentClass;
        var localIds = localStudentIdsForHub(ss, year, studentHubId);
        var possibleIds = [studentHubId].concat(localIds);
        if (rows.some(function(r) { return active(r, year) && r.competitionId === comp.id && possibleIds.indexOf(value(r.studentId)) >= 0; })) fail('CONFLICT', 'Student already registered. Refresh to review.');
        resultStudentId = value(hubStudent.localStudentId) || studentHubId;
        student = {id:resultStudentId,studentName:studentName,studentClass:studentClass};
      } else {
        student = table(ss, 'Students').find(function(s) { return s.id === p.studentId && active(s, year); });
        if (!student) fail('VALIDATION', 'Student not found in this year.');
        if (rows.some(function(r) { return active(r, year) && r.studentId === student.id && r.competitionId === comp.id; })) fail('CONFLICT', 'Student already registered. Refresh to review.');
        resultStudentId = student.id;
      }
      var teamName = textField(p.teamName, 'team name', 100, false);
      var teamId = textField(p.teamId, 'team ID', 100, false);
      if (!!teamName !== !!teamId) fail('VALIDATION', 'Team name and ID must be supplied together.');
      if (teamId && !/^[A-Za-z0-9_-]{10,100}$/.test(teamId)) fail('VALIDATION', 'Invalid team ID.');
      if (teamId && rows.some(function(r) { return active(r, year) && r.teamId === teamId && (r.competitionId !== comp.id || r.teamName !== teamName); })) fail('VALIDATION', 'Team ID belongs to another team.');
      after = { id: Utilities.getUuid(), year: year, studentId: resultStudentId, competitionId: comp.id, teamId: teamId, teamName: teamName,
        score: '', rank: '', note: textField(p.note, 'note', 1000, false), version: 0, deleted: false,
        studentNameSnapshot:student.studentName, studentClassSnapshot:student.studentClass, studentStatus:'active' };
    } else {
      before = rows.find(function(r) { return r.id === p.recordId && r.competitionId === comp.id && active(r, year); });
      if (!before) fail('NOT_FOUND', 'Registration not found.');
      checkVersion(before, p); after = Object.assign({}, before);
      if (action === 'deleteRegistration') after.deleted = true;
      if (action === 'updateScore') {
        var score = value(p.score).trim();
        if (score !== '' && (!/^\d+(\.\d+)?$/.test(score) || !Number.isFinite(Number(score)))) fail('VALIDATION', 'Score must be a non-negative number or blank.');
        var max = Number(props().getProperty('MAX_SCORE') || 100);
        if (!Number.isFinite(max) || max <= 0) fail('CONFIG', 'MAX_SCORE must be a positive number.');
        if (score !== '' && Number(score) > max) fail('VALIDATION', 'Score exceeds the configured maximum.');
        if (RANKS.indexOf(value(p.rank)) < 0) fail('VALIDATION', 'Invalid rank.');
        after.score = score; after.rank = value(p.rank);
        if (p.note !== undefined) after.note = textField(p.note, 'note', 1000, false);
      }
    }
  }
  after.version = Number(after.version) + 1; after.lastOperationId = p.id;
  var op = { id: p.id, request: request, table: name, recordId: after.id, before: JSON.stringify(before), after: JSON.stringify(after),
    status: 'prepared', actor: role, createdAt: new Date().toISOString(), completedAt: '' };
  // Durable write-ahead journal. Recovery runs under the same lock before subsequent reads/writes.
  put(ss, 'Operations', op); SpreadsheetApp.flush();
  recoverPrepared(ss);
  return { status: 'success', data: after };
}

function migrateLegacyDatabase() {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (props().getProperty('SCHEMA_VERSION') === SCRIPT_VERSION) return;
    var year = yearOf({ year: props().getProperty('LEGACY_YEAR') });
    roleOf({}); // Validate configuration before changing any sheets.
    var ss = database();
    var legacy = function(name, aliases, required) {
      var sheet = ss.getSheetByName(name); if (!sheet) return [];
      var data = sheet.getDataRange().getValues(); if (data.length <= 1) return [];
      var header = data[0].map(function(h) { return value(h).toLowerCase().replace(/\s/g, ''); });
      var positions = {};
      Object.keys(aliases).forEach(function(k) {
        var matches = []; header.forEach(function(h, i) { if (aliases[k].indexOf(h) >= 0) matches.push(i); });
        if (matches.length > 1 || (!matches.length && required.indexOf(k) >= 0)) fail('SCHEMA', 'Missing/ambiguous ' + name + '.' + k);
        positions[k] = matches.length ? matches[0] : -1;
      });
      return data.slice(1).filter(function(r) { return r.some(function(v) { return v !== ''; }); }).map(function(r) {
        var obj = {}; Object.keys(positions).forEach(function(k) {
          var v = positions[k] < 0 ? '' : r[positions[k]];
          obj[k] = v instanceof Date ? Utilities.formatDate(v, 'Asia/Kuala_Lumpur', 'yyyy-MM-dd') : value(v).trim();
        }); return obj;
      });
    };
    var comps = legacy('Competitions', { name:['name','名称','比赛','项目','比赛名称'], organizer:['organizer','主办方','主办单位'],status:['status','状态'],startDate:['startdate','开始日期'],endDate:['enddate','结束日期','截止日期'] }, ['name']);
    var students = legacy('Students', { studentName:['studentname','name','姓名'],studentClass:['studentclass','class','班级'] }, ['studentName','studentClass']);
    var results = legacy('Results', { studentName:['studentname','name','姓名'],studentClass:['studentclass','class','班级'],category:['category','competition','item','项目','比赛'],score:['score','分数','得分'],rank:['rank','排名','名次'],note:['note','备注','题目'] }, ['studentName','studentClass','category','score','rank']);
    function stamp(r) { return Object.assign(r, { id:Utilities.getUuid(),year:year,version:1,deleted:false,lastOperationId:'migration' }); }
    function unique(rows, key, label) { var seen = new Set(); rows.forEach(function(r) { var k = key(r); if(seen.has(k)) fail('MIGRATION', 'Duplicate ' + label + ': ' + k); seen.add(k); }); }
    comps = comps.map(function(c) { if(!c.name) fail('MIGRATION','Blank competition name.'); c.status = c.status === 'closed' ? 'closed' : 'open'; c.startDate = dateField(c.startDate); c.endDate = dateField(c.endDate); return stamp(c); });
    students = students.map(function(s) { if(!s.studentName || !s.studentClass) fail('MIGRATION','Blank student name/class.'); return stamp(s); });
    unique(comps,function(c){return c.name;},'competition');
    unique(students,function(s){return JSON.stringify([s.studentClass,s.studentName]);},'student');
    // Explicit, school-approved resolutions only. Never infer identities by fuzzy matching.
    var resolutions = JSON.parse(props().getProperty('MIGRATION_STUDENT_RESOLUTIONS') || '[]');
    if (!Array.isArray(resolutions)) fail('MIGRATION', 'Invalid student resolutions.');
    var teams = {}, formerStudents = {};
    results = results.map(function(r) {
      var match = r.studentName.match(/\s*\[([^\]]+)\]$/), team = match ? match[1] : '';
      var pure = match ? r.studentName.slice(0, match.index).trim() : r.studentName;
      var matches = resolutions.filter(function(x){return x.year===year && x.studentClass===r.studentClass && x.legacyName===pure;});
      if(matches.length>1) fail('MIGRATION','Duplicate student resolution.');
      var resolution = matches[0];
      var resolvedName = resolution && resolution.status==='active' ? resolution.studentName : pure;
      var student = students.find(function(s){return s.studentClass===r.studentClass && s.studentName===resolvedName;});
      var former = resolution && resolution.status==='left';
      if(former && student) fail('MIGRATION','Former student still appears in roster: '+pure);
      if(former) {
        var formerKey=JSON.stringify([r.studentClass,pure]);
        if(!formerStudents[formerKey]) formerStudents[formerKey]={id:Utilities.getUuid(),studentName:pure,studentClass:r.studentClass};
        student=formerStudents[formerKey];
      }
      var comp = comps.find(function(c){return c.name===r.category;});
      if(!student || !comp) fail('MIGRATION','Unmatched legacy result: ' + r.studentClass + '/' + r.studentName + '/' + r.category);
      // Legacy teams had no IDs; preserve the legacy category+team-name grouping explicitly.
      var key = JSON.stringify([comp.id,team]); if(team && !teams[key]) teams[key]=Utilities.getUuid();
      return stamp({studentId:student.id,competitionId:comp.id,teamId:team?teams[key]:'',teamName:team,score:r.score,rank:r.rank,note:r.note,
        studentNameSnapshot:student.studentName,studentClassSnapshot:student.studentClass,studentStatus:former?'left':'active'});
    });
    // Collapse duplicate legacy registrations only when their populated score fields agree.
    // Complementary blanks keep the populated value; conflicting values stop before any writes.
    var consolidated = {}, resultOrder = [];
    results.forEach(function(r) {
      var key = JSON.stringify([r.studentId,r.competitionId]);
      var prior = consolidated[key];
      if (!prior) { consolidated[key] = r; resultOrder.push(key); return; }
      if (prior.teamId !== r.teamId || prior.teamName !== r.teamName) fail('MIGRATION','Conflicting duplicate registration team data.');
      ['score','rank','note'].forEach(function(field) {
        var a = value(prior[field]).trim(), b = value(r[field]).trim();
        if (a && b && a !== b) fail('MIGRATION','Conflicting duplicate registration ' + field + '.');
        if (!a && b) prior[field] = r[field];
      });
    });
    results = resultOrder.map(function(key) { return consolidated[key]; });
    var backup = ss.copy(ss.getName() + ' backup before v7 ' + new Date().toISOString());
    props().setProperty('MIGRATION_BACKUP_URL', backup.getUrl());
    // Original sheets remain untouched. Only incomplete v7 migration sheets may be rebuilt.
    Object.keys(TABLES).forEach(function(name) {
      var sheet = ss.getSheetByName(name+'_v7') || ss.insertSheet(name+'_v7');
      sheet.clearContents(); sheet.getRange(1,1,1,TABLES[name].length).setValues([TABLES[name]]);
    });
    [['Competitions',comps],['Students',students],['Results',results]].forEach(function(entry) {
      if(entry[1].length) ss.getSheetByName(entry[0]+'_v7').getRange(2,1,entry[1].length,TABLES[entry[0]].length)
        .setValues(entry[1].map(function(r){return TABLES[entry[0]].map(function(k){return cell(r[k]);});}));
    });
    SpreadsheetApp.flush(); props().setProperty('SCHEMA_VERSION',SCRIPT_VERSION);
    console.log('Migration complete. Original sheets preserved. Backup: ' + backup.getUrl());
  } finally { lock.releaseLock(); }
}

/** Editor-only annual roster import. RosterImport has studentClass, studentName columns. */
function importStudentRosterForYear() {
  var year = yearOf({year:props().getProperty('ROSTER_YEAR')});
  var lock = LockService.getScriptLock();lock.waitLock(30000);
  try {
    var ss=database();
    if(props().getProperty('SCHEMA_VERSION')!==SCRIPT_VERSION)fail('MIGRATION_REQUIRED','Migrate first.');
    recoverPrepared(ss);
    var sheet=ss.getSheetByName('RosterImport');if(!sheet)fail('VALIDATION','Create RosterImport with studentClass and studentName headers.');
    var data=sheet.getDataRange().getValues();
    if(data[0][0]!=='studentClass'||data[0][1]!=='studentName')fail('SCHEMA','Expected studentClass, studentName in the first two columns.');
    var rows=table(ss,'Students'),seen=new Set();
    var imported=data.slice(1).filter(function(r){return value(r[0])||value(r[1]);}).map(function(r){
      var cls=textField(r[0],'class',100,true),name=textField(r[1],'student name',160,true),key=JSON.stringify([cls,name]);
      if(seen.has(key))fail('VALIDATION','Duplicate roster entry: '+key);seen.add(key);
      var existing=rows.find(function(s){return active(s,year)&&s.studentClass===cls&&s.studentName===name;});
      return existing||{id:Utilities.getUuid(),year:year,studentClass:cls,studentName:name,version:1,deleted:false,lastOperationId:'roster-import'};
    });
    var additions=imported.filter(function(r){return !rows.some(function(s){return s.id===r.id;});});
    if(additions.length){var target=ss.getSheetByName('Students_v7');target.getRange(target.getLastRow()+1,1,additions.length,TABLES.Students.length)
      .setValues(additions.map(function(r){return TABLES.Students.map(function(k){return cell(r[k]);});}));}
    SpreadsheetApp.flush();console.log('Imported '+additions.length+' new students for '+year+'. Existing students preserved.');
  }finally{lock.releaseLock();}
}
