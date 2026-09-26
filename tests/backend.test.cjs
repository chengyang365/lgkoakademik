const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const crypto=require('node:crypto');
const code=fs.readFileSync(require('node:path').join(__dirname,'../Code.gs'),'utf8');
function fixture(){
 const properties={ADMIN_PWD:'test-admin-long-secret',TEACHER_PWD:'test-teacher-long-secret',SCHEMA_VERSION:'7.0',LEGACY_YEAR:'2026'};
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
test('teacher may score but may not delete registrations or administer competitions',()=>{
 const f=fixture();const auth_pwd=f.properties.TEACHER_PWD;
 assert.equal(f.call(f.score({auth_pwd})).status,'success');
 assert.equal(f.call(f.request('deleteRegistration',{auth_pwd})).code,'FORBIDDEN');
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
