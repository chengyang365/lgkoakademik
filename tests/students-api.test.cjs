'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const studentsHandler=require('../api/students');
const registerHandler=require('../api/register-student');
const retiredSyncHandler=require('../api/sync-students');

const STUDENT_ID='1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a';
const APPS_SCRIPT_URL='https://script.google.com/macros/s/test-deployment/exec';
const chen={id:STUDENT_ID,studentId:'21156',name:'TAN XIAO MING',chineseName:'陈小明',
  studentName:'陈小明 TAN XIAO MING',studentClass:'3A',updatedAt:'2026-10-25T08:00:00.000Z'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
function mockRes(){return {headers:{},statusCode:200,body:null,setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(body){this.body=body;return this;}};}
function withEnv(t,fetcher){
 const old={APPS_SCRIPT_URL:process.env.APPS_SCRIPT_URL,STUDENT_API_KEY:process.env.STUDENT_API_KEY,STUDENT_API_URL:process.env.STUDENT_API_URL};
 const oldFetch=global.fetch;
 process.env.APPS_SCRIPT_URL=APPS_SCRIPT_URL;
 delete process.env.STUDENT_API_KEY;
 delete process.env.STUDENT_API_URL;
 global.fetch=fetcher;
 t.after(()=>{for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}global.fetch=oldFetch;});
}
test('students endpoint proxies the live roster through Apps Script without a Vercel StudentHub key',async t=>{
 let payload=null,endpoint=null;
 withEnv(t,async(url,options)=>{
  endpoint=url;payload=JSON.parse(options.body);
  return response({status:'success',data:{items:[chen],total:1,schoolId:'grisek',syncCursor:12}});
 });
 const res=mockRes();
 await studentsHandler({method:'POST',body:{year:'2026',auth_pwd:'T4ch'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(res.body.data.items[0].studentName,'陈小明 TAN XIAO MING');
 assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
 assert.equal(endpoint,APPS_SCRIPT_URL);
 assert.deepEqual(payload,{action:'getStudentHubRoster',year:'2026',auth_pwd:'T4ch'});
 assert.equal(process.env.STUDENT_API_KEY,undefined);
});
test('students endpoint returns Apps Script authentication errors without reading StudentHub in Vercel',async t=>{
 let calls=0;
 withEnv(t,async()=>{
  calls++;
  return response({status:'error',code:'UNAUTHORIZED',message:'Sign in.'});
 });
 const res=mockRes();
 await studentsHandler({method:'POST',body:{year:'2026',auth_pwd:'wrong'}},res);
 assert.equal(res.statusCode,401);assert.equal(res.body.code,'UNAUTHORIZED');
 assert.equal(calls,1);
});
test('registration proxies only the UUID and approved registration fields',async t=>{
 let payload=null,endpoint=null;
 withEnv(t,async(url,options)=>{
  endpoint=url;payload=JSON.parse(options.body);
  return response({status:'success',data:{id:'result-1',studentNameSnapshot:chen.studentName,studentClassSnapshot:chen.studentClass}});
 });
 const id='operation_0000001',res=mockRes();
 await registerHandler({method:'POST',body:{id,year:'2026',auth_pwd:'T4ch',studentHubId:STUDENT_ID,
  competitionId:'comp-2026',teamId:'',teamName:'',note:'',studentName:'spoofed',studentClass:'99Z',
  studentHubProof:'old invalid proof',studentProofExpiresAt:'1'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(endpoint,APPS_SCRIPT_URL);
 assert.deepEqual(payload,{action:'registerStudentHub',id,year:'2026',auth_pwd:'T4ch',
  competitionId:'comp-2026',studentHubId:STUDENT_ID,teamId:'',teamName:'',note:''});
 assert.equal(process.env.STUDENT_API_KEY,undefined);
});
test('registration returns Apps Script rejection when a student is no longer active',async t=>{
 let payload=null;
 withEnv(t,async(_url,options)=>{
  payload=JSON.parse(options.body);
  return response({status:'error',code:'NOT_FOUND',message:'This student is no longer active.'});
 });
 const res=mockRes();
 await registerHandler({method:'POST',body:{id:'operation_0000002',year:'2026',auth_pwd:'admin',
  studentHubId:STUDENT_ID,competitionId:'comp-2026'}},res);
 assert.equal(res.statusCode,404);assert.equal(res.body.code,'NOT_FOUND');
 assert.equal(payload.action,'registerStudentHub');
});
test('old bulk-write route is disabled',async()=>{
 const res=mockRes();await retiredSyncHandler({method:'POST',body:{}},res);
 assert.equal(res.statusCode,410);assert.equal(res.body.code,'RETIRED');
});
