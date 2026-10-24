/** School competitions API v7. Configure Script Properties; never commit passwords. */
const SCRIPT_VERSION = '7.0';
const TABLES = {
  Competitions: ['id', 'year', 'name', 'organizer', 'status', 'startDate', 'endDate', 'version', 'deleted', 'lastOperationId'],
  Students: ['id', 'year', 'studentClass', 'studentName', 'version', 'deleted', 'lastOperationId'],
  Results: ['id', 'year', 'studentId', 'competitionId', 'teamId', 'teamName', 'score', 'rank', 'note', 'version', 'deleted', 'lastOperationId', 'studentNameSnapshot', 'studentClassSnapshot', 'studentStatus'],
  Operations: ['id', 'request', 'table', 'recordId', 'before', 'after', 'status', 'actor', 'createdAt', 'completedAt']
};
const WRITES = ['register', 'updateScore', 'batchUpdateScores', 'deleteRegistration', 'addCompetition', 'editCompetition', 'deleteCompetition', 'toggleStatus'];
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
  if (teacher && teacher.length >= 12 && p.auth_pwd === teacher) return 'teacher';
  return '';
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
    if ((isWrite || action === 'verifyPassword' || isRosterSync) && method !== 'POST') fail('METHOD', 'Use POST for writes and authentication.');
    var role = roleOf(p);
    if (isWrite || action === 'verifyPassword' || isRosterSync) {
      if (!role) fail('UNAUTHORIZED', 'Please sign in.');
      if (isRosterSync && role !== 'admin') fail('FORBIDDEN', 'Administrator permission required.');
      if (isWrite && ['register', 'updateScore', 'batchUpdateScores'].indexOf(action) < 0 && role !== 'admin') fail('FORBIDDEN', 'Administrator permission required.');
    }
    if (action === 'verifyPassword') return jsonResponse({ status: 'success', role: role, version: SCRIPT_VERSION });
    var year = yearOf(p);
    var ss = database();
    if (props().getProperty('SCHEMA_VERSION') !== SCRIPT_VERSION) fail('MIGRATION_REQUIRED', 'Run migration in the script editor.');
    // Read snapshots use the same lock to avoid seeing half-completed journal writes.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) { lock = null; fail('BUSY', 'System busy. Retry later.'); }
    recoverPrepared(ss);
    if (isRosterSync) return jsonResponse({ status: 'success', data: syncStudentRoster(ss, p, year) });
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
          break; // Earlier receipts remain committed; untouched operations stay in the client outbox.
        }
      }
      return jsonResponse({ status:'success', outcomes:outcomes });
    }
    if (isWrite) return jsonResponse(writeAction(ss, p, year, role));
    var comps = table(ss, 'Competitions').filter(function(r) { return active(r, year); });
    var students = role ? table(ss, 'Students').filter(function(r) { return active(r, year); }) : [];
    var results = role ? table(ss, 'Results').filter(function(r) { return active(r, year); }) : [];
    var visible = results.filter(function(r) { return comps.some(function(c) { return c.id === r.competitionId; }); }).map(function(r) {
      var student = students.find(function(s) { return s.id === r.studentId; });
      var comp = comps.find(function(c) { return c.id === r.competitionId; });
      return Object.assign({}, r, { score: value(r.score), rank: value(r.rank), note: value(r.note),
        studentName: (student ? student.studentName : value(r.studentNameSnapshot)) + (r.teamName ? ' [' + r.teamName + ']' : ''),
        studentClass: student ? student.studentClass : value(r.studentClassSnapshot), category: comp.name });
    });
    var years = Array.from(new Set(table(ss, 'Competitions').filter(function(r) { return value(r.deleted) !== 'true'; }).map(function(r) { return value(r.year); }).concat([year]))).sort();
    if (action === 'getSnapshot') return jsonResponse({ status: 'success', data: { competitions: comps, students: students, results: visible, years: years, authenticated: !!role }, version: SCRIPT_VERSION });
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
  // Ignore transport-only/UI fields; never put passwords in the operation journal.
  var keys = ['action','year','recordId','competitionId','studentId','teamId','teamName','expectedVersion','name','organizer','startDate','endDate','newName','status','score','rank','note'];
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
function writeAction(ss, p, year, role) {
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
    if (action === 'register') {
      var today = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd');
      if (comp.status !== 'open' || (comp.startDate && today < comp.startDate) || (comp.endDate && today > comp.endDate)) fail('VALIDATION', 'Registration is closed.');
      var student = table(ss, 'Students').find(function(s) { return s.id === p.studentId && active(s, year); });
      if (!student) fail('VALIDATION', 'Student not found in this year.');
      if (rows.some(function(r) { return active(r, year) && r.studentId === student.id && r.competitionId === comp.id; })) fail('CONFLICT', 'Student already registered. Refresh to review.');
      var teamName = textField(p.teamName, 'team name', 100, false);
      var teamId = textField(p.teamId, 'team ID', 100, false);
      if (!!teamName !== !!teamId) fail('VALIDATION', 'Team name and ID must be supplied together.');
      if (teamId && !/^[A-Za-z0-9_-]{10,100}$/.test(teamId)) fail('VALIDATION', 'Invalid team ID.');
      if (teamId && rows.some(function(r) { return active(r, year) && r.teamId === teamId && (r.competitionId !== comp.id || r.teamName !== teamName); })) fail('VALIDATION', 'Team ID belongs to another team.');
      after = { id: Utilities.getUuid(), year: year, studentId: student.id, competitionId: comp.id, teamId: teamId, teamName: teamName,
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

/**
 * Admin-only full roster sync from the authenticated StudentHub server proxy.
 * A separate map sheet preserves local student IDs and therefore all result links.
 */
function syncStudentRoster(ss, p, year) {
  var configuredYear = props().getProperty('ROSTER_YEAR');
  if (!configuredYear) fail('CONFIG', 'Set ROSTER_YEAR in Script Properties before syncing.');
  if (yearOf({year:configuredYear}) !== year) fail('VALIDATION', 'Only the configured ROSTER_YEAR may be synchronized.');
  var input = p.students;
  if (!Array.isArray(input) || input.length < 1 || input.length > 5000) fail('VALIDATION', 'Roster must contain 1–5000 students.');
  var seenIds = new Set(), keyCounts = {};
  var incoming = input.map(function(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('VALIDATION', 'Invalid StudentHub student.');
    var hubStudentId = textField(raw.id, 'StudentHub student ID', 100, true);
    var studentName = textField(raw.name, 'student name', 160, true).toUpperCase();
    var studentClass = textField(raw.className, 'class', 100, true).toUpperCase();
    if (!/^[A-Za-z0-9_-]{5,100}$/.test(hubStudentId) || /[\u0000-\u001f\u007f\ufffd]/.test(studentName + studentClass)) fail('VALIDATION', 'Invalid StudentHub student fields.');
    if (seenIds.has(hubStudentId)) fail('VALIDATION', 'Duplicate StudentHub student ID.');
    seenIds.add(hubStudentId);
    var key = JSON.stringify([studentClass, studentName]);
    keyCounts[key] = (keyCounts[key] || 0) + 1;
    return {hubStudentId:hubStudentId,studentName:studentName,studentClass:studentClass,key:key};
  });
  var ssStudents = table(ss, 'Students');
  var originalStudents = ssStudents.map(function(r) { return Object.assign({}, r); });
  var results = table(ss, 'Results');
  var mapSheet = ss.getSheetByName('_StudentHubMap_v1');
  var mapData = mapSheet ? mapSheet.getDataRange().getValues() : [['hubStudentId','year','studentId']];
  var mapHeaders = ['hubStudentId','year','studentId'];
  if (JSON.stringify(mapData[0]) !== JSON.stringify(mapHeaders)) fail('SCHEMA', 'Unexpected headers: StudentHub map.');
  var mappings = mapData.slice(1).filter(function(r) { return value(r[0]) !== ''; }).map(function(r) {
    return {hubStudentId:value(r[0]),year:value(r[1]),studentId:value(r[2])};
  });
  var mapKeys = new Set();
  mappings.forEach(function(m) {
    var key = JSON.stringify([m.year,m.hubStudentId]);
    if (!m.hubStudentId || !m.studentId || mapKeys.has(key)) fail('SCHEMA', 'Duplicate or invalid StudentHub mapping.');
    mapKeys.add(key);
  });
  var yearMappings = mappings.filter(function(m) { return m.year === year; });
  var currentMapIds = new Set(yearMappings.map(function(m) { return m.studentId; }));
  var localById = new Map();
  ssStudents.forEach(function(s) {
    if (value(s.year) === year) {
      if (localById.has(value(s.id))) fail('SCHEMA', 'Duplicate local student ID.');
      localById.set(value(s.id), s);
    }
  });
  yearMappings.forEach(function(m) {
    var local = localById.get(m.studentId);
    if (!local) fail('SCHEMA', 'StudentHub mapping references a missing local student.');
  });
  var assigned = new Set(), included = new Set(), additions = 0, updates = 0, mappingAdded = 0;
  incoming.forEach(function(source) {
    var mapped = yearMappings.find(function(m) { return m.hubStudentId === source.hubStudentId; });
    var student = mapped ? localById.get(mapped.studentId) : null;
    if (mapped && assigned.has(student.id)) fail('SCHEMA', 'Multiple StudentHub IDs map to one local student.');
    if (!mapped) {
      var candidates = ssStudents.filter(function(s) {
        return active(s, year) && !currentMapIds.has(value(s.id)) && !assigned.has(value(s.id))
          && value(s.studentClass).trim().toUpperCase() === source.studentClass
          && value(s.studentName).trim().toUpperCase() === source.studentName;
      });
      if (candidates.length > 1 || (candidates.length === 1 && keyCounts[source.key] > 1)) {
        fail('VALIDATION', 'Ambiguous existing student match; no roster changes were made.');
      }
      student = candidates[0] || null;
      if (!student) {
        student = {id:Utilities.getUuid(),year:year,studentClass:source.studentClass,studentName:source.studentName,
          version:1,deleted:false,lastOperationId:'studenthub-sync'};
        ssStudents.push(student); localById.set(student.id, student); additions++;
      }
      mappings.push({hubStudentId:source.hubStudentId,year:year,studentId:student.id});
      currentMapIds.add(student.id); mappingAdded++;
    }
    assigned.add(value(student.id)); included.add(value(student.id));
    var changed = value(student.studentClass).trim().toUpperCase() !== source.studentClass
      || value(student.studentName).trim().toUpperCase() !== source.studentName
      || value(student.deleted) === 'true';
    if (changed) {
      student.studentClass = source.studentClass; student.studentName = source.studentName;
      student.deleted = false; student.version = Number(student.version || 0) + 1;
      student.lastOperationId = 'studenthub-sync'; updates++;
    }
  });
  // Snapshot each existing result before deactivating absent students or applying a renamed source record.
  var originalById = new Map(originalStudents.map(function(s) { return [value(s.id), s]; }));
  results.forEach(function(result) {
    if (value(result.year) !== year) return;
    var previous = originalById.get(value(result.studentId));
    if (!previous) return;
    if (!value(result.studentNameSnapshot)) result.studentNameSnapshot = value(previous.studentName);
    if (!value(result.studentClassSnapshot)) result.studentClassSnapshot = value(previous.studentClass);
    if (!value(result.studentStatus)) result.studentStatus = included.has(value(previous.id)) ? 'active' : 'left';
  });
  var deactivated = 0;
  ssStudents.forEach(function(student) {
    if (value(student.year) === year && active(student, year) && !included.has(value(student.id))) {
      student.deleted = true; student.version = Number(student.version || 0) + 1;
      student.lastOperationId = 'studenthub-sync'; deactivated++;
    }
  });
  var studentSheet = ss.getSheetByName('Students_v7');
  var studentValues = [TABLES.Students].concat(ssStudents.map(function(s) { return TABLES.Students.map(function(k) { return cell(s[k]); }); }));
  studentSheet.getRange(1, 1, studentValues.length, TABLES.Students.length).setValues(studentValues);
  if (results.length) {
    var resultSheet = ss.getSheetByName('Results_v7');
    var resultValues = [TABLES.Results].concat(results.map(function(r) { return TABLES.Results.map(function(k) { return cell(r[k]); }); }));
    resultSheet.getRange(1, 1, resultValues.length, TABLES.Results.length).setValues(resultValues);
  }
  if (!mapSheet) mapSheet = ss.insertSheet('_StudentHubMap_v1');
  var mapValues = [mapHeaders].concat(mappings.map(function(m) { return [m.hubStudentId,m.year,m.studentId]; }));
  mapSheet.clearContents();
  mapSheet.getRange(1, 1, mapValues.length, mapHeaders.length).setValues(mapValues);
  SpreadsheetApp.flush();
  return {year:year,activeCount:included.size,createdCount:additions,updatedCount:updates,deactivatedCount:deactivated,mappedCount:mappingAdded};
}

/** Run only in Apps Script editor. Set LEGACY_YEAR explicitly and review the backup URL. */
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
