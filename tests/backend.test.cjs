const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const crypto=require('node:crypto');
const code=fs.readFileSync(require('node:path').join(__dirname,'../Code.gs'),'utf8');
function fixture(){
 const properties={ADMIN_PWD:'test-admin-long-secret',TEACHER_PWD:'T4ch',SCHEMA_VERSION:'7.0',LEGACY_YEAR:'2026'};
 let held=false,failTarget=null;
 class Sheet{
  constructor(name,rows=[]){this.name=name;this.rows=structuredClone(rows);}
  getDataRange(){return {getValues:()=>structuredClone(this.rows.length?this.rows:[['']])};}
  getLastRow(){return this.rows.length;}
  clearContents(){this.rows=[];}
  getRange(row,col,height,width){return {setValues:values=>{
   if(this.name===failTarget){failTarget=null;throw Error('simulated interruption');}
   for(let y=0;y<height;y++){this.rows[row-1+y] ||= [];for(let x=0;x<width;x++){const v=values[y][x];this.rows[row-1+y][col-1+x]=typeof v==='string'&&v.startsWith("'")?v.slice(1):v;}}
  }};}
 }
 const sheets={};const ss={getSheetByName:n=>sheets[n]||null,insertSheet:n=>sheets[n]=new Sheet(n),getName:()=> 'Test',copy:()=>({getUrl:()=> 'https://example.invalid/backup'})};
 const ctx=vm.createContext({console,Date,PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]||null,setProperty:(k,v)=>properties[k]=v})},
 SpreadsheetApp:{getActiveSpreadsheet:()=>ss,openById:()=>ss,flush(){}},
 ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
 Utilities:{getUuid:()=>crypto.randomUUID(),formatDate:()=> '2026-09-26'},
 LockService:{getScriptLock:()=>({tryLock(){assert.equal(held,false);held=true;return true;},waitLock(){held=true;},releaseLock(){held=false;}})}});
 vm.runInContext(code,ctx);
 const schema=vm.runInContext('TABLES',ctx);
 for(const [name,headers]of Object.entries(schema))sheets[name+'_v7']=new Sheet(name+'_v7',[Array.from(headers)]);
 const put=(name,row)=>ctx.put(ss,name,row);
 const base={year:'2026',version:1,deleted:false,lastOperationId:'seed'};
 put('Competitions',{...base,id:'comp-2026',name:'Speech',organizer:'School',status:'open',startDate:'',endDate:''});
 put('Students',{...base,id:'student-2026',studentClass:'1A',studentName:'Alice'});
 put('Results',{...base,id:'result-2026',studentId:'student-2026',competitionId:'comp-2026',teamId:'',teamName:'',score:0,rank:'',note:'original'});
 const call=(p,method='POST')=>JSON.parse(ctx.handleRequest(p,method).text);
 const request=(action,fields={})=>({action,year:'2026',id:crypto.randomUUID(),auth_pwd:properties.ADMIN_PWD,...fields});
 const score=(fields={})=>request('updateScore',{recordId:'result-2026',competitionId:'comp-2026',expectedVersion:1,score:'90',rank:'冠军',...fields});
 return {ctx,ss,sheets,properties,call,request,score,put,rows:n=>ctx.table(ss,n),interrupt:n=>failTarget=n,held:()=>held};
}
test('all mutation endpoints require authentication; GET mutations rejected',()=>{
 const f=fixture();for(const action of ['register','updateScore','batchUpdateScores','deleteRegistration','addCompetition','editCompetition','deleteCompetition','toggleStatus']){
  assert.equal(f.call(f.request(action,{auth_pwd:''})).code,'UNAUTHORIZED');
  assert.equal(f.call(f.request(action),'GET').code,'METHOD');
 }assert.equal(f.rows('Operations').length,0);
});
test('student names/results remain private while public competitions are readable',()=>{
 const f=fixture();const r=f.call({action:'getSnapshot',year:'2026'});assert.equal(r.data.competitions.length,1);assert.equal(r.data.students.length,0);assert.equal(r.data.results.length,0);
 assert.equal(f.call({action:'getStudents',year:'2026'}).code,'UNAUTHORIZED');
});
test('four-character teacher may view, register and score, but cannot administer competitions',()=>{
 const f=fixture();const auth_pwd=f.properties.TEACHER_PWD;
 assert.equal(f.call({action:'verifyPassword',auth_pwd}).role,'teacher');
 const snapshot=f.call(f.request('getSnapshot',{auth_pwd}));
 assert.equal(snapshot.data.authenticated,true);assert.equal(snapshot.data.results.length,1);
 f.put('Students',{id:'student-2026-2',year:'2026',studentClass:'2A',studentName:'Bob',version:1,deleted:false,lastOperationId:'seed'});
 assert.equal(f.call(f.request('register',{auth_pwd,studentId:'student-2026-2',competitionId:'comp-2026',teamId:'',teamName:'',note:''})).status,'success');
 assert.equal(f.call(f.score({auth_pwd})).status,'success');
 for(const action of ['deleteRegistration','addCompetition','editCompetition','deleteCompetition','toggleStatus']){
  assert.equal(f.call(f.request(action,{auth_pwd,competitionId:'comp-2026',recordId:'result-2026',expectedVersion:1,newName:'Renamed',name:'Another'})).code,'FORBIDDEN',action);
 }
});
test('teacher password must be exactly four characters; admin authentication is unchanged',()=>{
 const f=fixture();
 assert.equal(f.call({action:'verifyPassword',auth_pwd:f.properties.ADMIN_PWD}).role,'admin');
 assert.equal(f.call({action:'verifyPassword',auth_pwd:f.properties.TEACHER_PWD}).role,'teacher');
 for(const pass of ['T4c','T4chx','teacher-long-pass']){
  f.properties.TEACHER_PWD=pass;assert.equal(f.call({action:'verifyPassword',auth_pwd:pass}).code,'UNAUTHORIZED');
 }
});
test('zero score survives snapshot and note saves together with score',()=>{
 const f=fixture();let r=f.call(f.request('getSnapshot'));assert.equal(r.data.results[0].score,'0');
 assert.equal(f.call(f.score({score:0,note:'new note'})).status,'success');
 r=f.call(f.request('getSnapshot'));assert.equal(r.data.results[0].score,'0');assert.equal(r.data.results[0].note,'new note');
});
test('year filters reads and rejects cross-year writes',()=>{
 const f=fixture();assert.equal(f.call(f.request('getSnapshot',{year:'2027'})).data.results.length,0);
 assert.equal(f.call(f.score({year:'2027'})).code,'NOT_FOUND');
 assert.equal(f.call(f.score({year:undefined})).code,'VALIDATION');
});
test('durable receipt replays once and rejects same ID with changed payload',()=>{
 const f=fixture(),p=f.score();assert.equal(f.call(p).status,'success');assert.equal(f.call(p).replay,true);
 assert.equal(f.rows('Results')[0].version,2);assert.equal(f.rows('Operations').length,1);
 assert.equal(f.call({...p,score:'80'}).code,'CONFLICT');
 assert.ok(!JSON.stringify(f.rows('Operations')).includes(f.properties.ADMIN_PWD));
});
test('stale devices cannot overwrite a more recent score',()=>{
 const f=fixture();assert.equal(f.call(f.score({score:'90'})).status,'success');
 assert.equal(f.call(f.score({score:'80'})).code,'CONFLICT');assert.equal(f.rows('Results')[0].score,'90');
});
test('journal recovers interrupted write before processing subsequent work',()=>{
 const f=fixture(),p=f.score();f.interrupt('Results_v7');assert.equal(f.call(p).code,'SERVER');
 assert.equal(f.rows('Operations')[0].status,'prepared');assert.equal(f.held(),false);
 assert.equal(f.call(p).replay,true);assert.equal(f.rows('Results')[0].score,'90');assert.equal(f.rows('Operations')[0].status,'done');
});
test('registration validates competition status and student; deduplicates registrations',()=>{
 const f=fixture();const register=extra=>f.request('register',{studentId:'student-2026',competitionId:'comp-2026',note:'',...extra});
 assert.equal(f.call(register()).code,'CONFLICT');
 assert.equal(f.call(register({studentId:'fake'})).code,'VALIDATION');
 const c=f.rows('Competitions')[0];c.status='closed';f.put('Competitions',c);assert.equal(f.call(register()).code,'VALIDATION');
});
test('invalid scores, ranks and dates are rejected without mutation',()=>{
 const f=fixture();for(const score of ['-1','101','Infinity','12oops','=1+1']) assert.equal(f.call(f.score({score})).code,'VALIDATION');
 assert.equal(f.call(f.score({rank:'<script>'})).code,'VALIDATION');
 assert.equal(f.call(f.request('addCompetition',{name:'Invalid',startDate:'2026-02-30'})).code,'VALIDATION');
 assert.equal(f.rows('Results')[0].version,1);
});
test('competition rename preserves linked results; delete is soft and uses versions',()=>{
 const f=fixture();assert.equal(f.call(f.request('editCompetition',{competitionId:'comp-2026',expectedVersion:1,newName:'New Speech'})).status,'success');
 assert.equal(f.call(f.request('getSnapshot')).data.results[0].category,'New Speech');
 assert.equal(f.call(f.request('deleteCompetition',{competitionId:'comp-2026',expectedVersion:1})).code,'CONFLICT');
 assert.equal(f.call(f.request('deleteCompetition',{competitionId:'comp-2026',expectedVersion:2})).status,'success');
 assert.equal(f.call(f.request('getSnapshot')).data.results.length,0);assert.equal(f.rows('Results').length,1);
});
test('malformed JSON receives a structured error',()=>{const f=fixture();assert.equal(JSON.parse(f.ctx.doPost({postData:{contents:'{'}}).text).code,'VALIDATION');});
test('weak or missing administrator configuration fails closed',()=>{const f=fixture();f.properties.ADMIN_PWD='';assert.equal(f.call(f.score()).code,'CONFIG');});
test('migration requires an explicit year and preserves original sheets',()=>{
 const f=fixture();delete f.properties.SCHEMA_VERSION;delete f.properties.LEGACY_YEAR;
 assert.throws(()=>f.ctx.migrateLegacyDatabase(),/year/i);
 f.properties.LEGACY_YEAR='2025';
 const old=f.ss.insertSheet('Competitions');old.rows=[['name','organizer','status','startDate','endDate'],['Old','School','open','','']];
 f.ctx.migrateLegacyDatabase();assert.equal(f.rows('Competitions')[0].year,'2025');assert.equal(old.rows.length,2);assert.ok(f.properties.MIGRATION_BACKUP_URL);
 const id=f.rows('Competitions')[0].id;f.ctx.migrateLegacyDatabase();assert.equal(f.rows('Competitions')[0].id,id);
});
module.exports={fixture};
test('approved former students retain results without entering the active roster',()=>{
 const f=fixture();delete f.properties.SCHEMA_VERSION;f.properties.LEGACY_YEAR='2026';
 f.ss.insertSheet('Competitions').rows=[['name'],['Speech'],['Song']];
 f.ss.insertSheet('Students').rows=[['class','name'],['1A','Alice Correct']];
 const legacy=f.ss.insertSheet('Results');legacy.rows=[['studentName','studentClass','category','score','rank','note'],
 ['Alice Old','1A','Speech',0,'','note'],['Former [Team]','2B','Speech',80,'','history'],['Former','2B','Song',90,'','']];
 const original=JSON.stringify(legacy.rows);
 assert.throws(()=>f.ctx.migrateLegacyDatabase(),/Unmatched/);
 f.properties.MIGRATION_STUDENT_RESOLUTIONS=JSON.stringify([
 {year:'2026',studentClass:'1A',legacyName:'Alice Old',status:'active',studentName:'Alice Correct'},
 {year:'2026',studentClass:'2B',legacyName:'Former',status:'left'}]);
 f.ctx.migrateLegacyDatabase();
 assert.equal(JSON.stringify(legacy.rows),original);
 const snapshot=f.call(f.request('getSnapshot')).data;
 assert.equal(snapshot.students.length,1);assert.equal(snapshot.results.length,3);
 assert.equal(snapshot.results[0].studentName,'Alice Correct');assert.equal(snapshot.results[0].score,'0');
 assert.equal(snapshot.results[1].studentName,'Former [Team]');assert.equal(snapshot.results[1].studentClass,'2B');
 assert.equal(snapshot.results[1].studentStatus,'left');assert.equal(snapshot.results[1].studentId,snapshot.results[2].studentId);
 assert.equal(f.call(f.request('register',{studentId:snapshot.results[1].studentId,competitionId:snapshot.competitions[0].id})).code,'VALIDATION');
 assert.equal(f.call({action:'getSnapshot',year:'2026'}).data.results.length,0);
});
test('score batch returns durable partial receipts and stops at first conflict',()=>{
 const f=fixture(),first=f.score(),second=f.score({score:'80'});
 const p=f.request('batchUpdateScores',{operations:[first,second]});
 const r=f.call(p);assert.equal(r.outcomes[0].status,'success');assert.equal(r.outcomes[1].code,'CONFLICT');assert.equal(f.rows('Results')[0].score,'90');
 const retry=f.call(p);assert.equal(retry.outcomes[0].replay,true);assert.equal(retry.outcomes[1].code,'CONFLICT');assert.equal(f.rows('Results')[0].version,2);
});
test('annual roster import is append-only and idempotent for matching students',()=>{
 const f=fixture();f.properties.ROSTER_YEAR='2027';const source=f.ss.insertSheet('RosterImport');source.rows=[['studentClass','studentName'],['2A','Alice']];
 f.ctx.importStudentRosterForYear();assert.equal(f.rows('Students').length,2);assert.equal(f.rows('Students')[1].year,'2027');
 f.ctx.importStudentRosterForYear();assert.equal(f.rows('Students').length,2);
 source.rows.push(['2A','Alice']);assert.throws(()=>f.ctx.importStudentRosterForYear(),/Duplicate/);assert.equal(f.rows('Students').length,2);
});

test('StudentHub sync preserves local IDs, soft-departs missing students, and keeps score history',()=>{
 const f=fixture();f.properties.ROSTER_YEAR='2026';
 const sync=students=>f.request('syncStudentRoster',{students});
 const first=f.call(sync([{id:'hub-alice',name:'Alice',className:'1A'},{id:'hub-bob',name:'Bob',className:'2A'}]));
 assert.equal(first.status,'success');assert.equal(first.data.createdCount,1);assert.equal(first.data.activeCount,2);
 const map=f.sheets._StudentHubMap_v1.rows.slice(1);
 const alice=map.find(r=>r[0]==='hub-alice');assert.equal(alice[2],'student-2026');
 assert.equal(f.rows('Results')[0].studentNameSnapshot,'Alice');
 const second=f.call(sync([{id:'hub-bob',name:'Bob',className:'2A'}]));
 assert.equal(second.status,'success');assert.equal(second.data.deactivatedCount,1);
 const students=f.rows('Students');assert.equal(students.find(s=>s.id==='student-2026').deleted,true);
 const snapshot=f.call(f.request('getSnapshot'));
 assert.equal(snapshot.data.students.some(s=>s.id==='student-2026'),false);
 assert.equal(snapshot.data.results[0].studentName,'Alice');
 assert.equal(snapshot.data.results[0].studentClass,'1A');
 assert.equal(snapshot.data.results[0].studentStatus,'left');
 assert.equal(f.call(f.request('register',{studentId:'student-2026',competitionId:'comp-2026'})).code,'VALIDATION');
 const third=f.call(sync([{id:'hub-bob',name:'Bob',className:'2A'}]));
 assert.equal(third.data.createdCount,0);assert.equal(third.data.activeCount,1);
 assert.equal(f.sheets._StudentHubMap_v1.rows.length,3);
});
test('StudentHub sync is admin-only and refuses unsafe or ambiguous full rosters before writing',()=>{
 const f=fixture();f.properties.ROSTER_YEAR='2026';
 const students=[{id:'hub-alice',name:'Alice',className:'1A'}];
 assert.equal(f.call(f.request('syncStudentRoster',{auth_pwd:f.properties.TEACHER_PWD,students})).code,'FORBIDDEN');
 assert.equal(f.call(f.request('syncStudentRoster',{students:[]})).code,'VALIDATION');
 const ambiguous=f.call(f.request('syncStudentRoster',{students:[
  {id:'hub-alice-1',name:'Alice',className:'1A'},{id:'hub-alice-2',name:'Alice',className:'1A'}
 ]}));
 assert.equal(ambiguous.code,'VALIDATION');
 assert.equal(f.rows('Students').length,1);assert.equal(f.rows('Results').length,1);
 assert.equal(f.ss.getSheetByName('_StudentHubMap_v1'),null);
});
test('StudentHub sync requires the configured roster year',()=>{
 const f=fixture();
 assert.equal(f.call(f.request('syncStudentRoster',{students:[{id:'hub-alice',name:'Alice',className:'1A'}]})).code,'CONFIG');
 f.properties.ROSTER_YEAR='2027';
 assert.equal(f.call(f.request('syncStudentRoster',{students:[{id:'hub-alice',name:'Alice',className:'1A'}]})).code,'VALIDATION');
 assert.equal(f.rows('Students').length,1);
});
