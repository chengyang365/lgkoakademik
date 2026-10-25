'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readActiveStudents, formatStudentName, signStudentHubRegistration}=require('../api/_lib/student-hub');
const studentsHandler=require('../api/students');
const registerHandler=require('../api/register-student');
const retiredSyncHandler=require('../api/sync-students');

const STUDENT_ID='1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a';
const STUDENT_API='https://lgstudenthub.vercel.app/api/students';
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const hubPage=(items,total,offset,nextOffset,cursor=12)=>({success:true,data:{
  apiVersion:'v1',schoolId:'grisek',items,total,limit:100,offset,nextOffset,syncCursor:cursor,fetchedAt:'2026-10-25T08:05:00.000Z'
}});
const chen={id:STUDENT_ID,studentId:'21156',name:'TAN XIAO MING',chineseName:'陈小明',className:'3A',gender:'L',updatedAt:'2026-10-25T08:00:00.000Z'};
function mockRes(){return {headers:{},statusCode:200,body:null,setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(body){this.body=body;return this;}};}
function withEnv(t,fetcher){
 const old={APPS_SCRIPT_URL:process.env.APPS_SCRIPT_URL,STUDENT_API_KEY:process.env.STUDENT_API_KEY,STUDENT_API_URL:process.env.STUDENT_API_URL};
 const oldFetch=global.fetch;
 process.env.APPS_SCRIPT_URL='https://script.google.com/macros/s/test-deployment/exec';
 process.env.STUDENT_API_KEY='test-studenthub-api-key';
 delete process.env.STUDENT_API_URL;
 global.fetch=fetcher;
 t.after(()=>{for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}global.fetch=oldFetch;});
}
test('StudentHub full display name uses Chinese name followed by official name',()=>{
 assert.equal(formatStudentName(chen),'陈小明 TAN XIAO MING');
 assert.equal(formatStudentName({...chen,chineseName:''}),'TAN XIAO MING');
});
test('live reader follows nextOffset and validates a stable v1 cursor',async t=>{
 const calls=[];
 withEnv(t,async(url,options)=>{
  calls.push({url:new URL(url),options});
  const offset=Number(new URL(url).searchParams.get('offset'));
  return response(hubPage(offset===0?[chen]:[{...chen,id:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5b',studentId:'21157',name:'TAN YU MING',chineseName:'陈玉明',className:'3A'}],2,offset,offset===0?1:null));
 });
 const roster=await readActiveStudents(STUDENT_API,'test-studenthub-api-key');
 assert.equal(roster.total,2);assert.equal(roster.items[0].studentName,'陈小明 TAN XIAO MING');
 assert.equal(roster.items[0].id,STUDENT_ID);assert.equal(roster.items[0].studentId,'21156');
 assert.equal(calls.length,2);assert.equal(calls[0].options.headers.Authorization,'Bearer test-studenthub-api-key');
 assert.equal(calls[0].url.searchParams.get('offset'),'0');assert.equal(calls[1].url.searchParams.get('offset'),'1');
 assert.equal(calls[0].url.searchParams.get('limit'),'500');assert.equal(calls[0].url.searchParams.has('status'),false);
 assert.equal(calls[0].url.search.includes('test-studenthub-api-key'),false);
});
test('live reader refuses a roster that changes during pagination',async t=>{
 withEnv(t,async url=>{const offset=Number(new URL(url).searchParams.get('offset'));const other={...chen,id:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5b',name:'TAN YU MING',chineseName:'陈玉明'};return response(hubPage(offset===0?[chen]:[other],2,offset,offset===0?1:null,offset===0?12:99));});
 await assert.rejects(readActiveStudents(STUDENT_API,'key'),/发生变化/);
});
test('live reader refuses duplicate or unidentifiable roster entries',async t=>{
 withEnv(t,async()=>response(hubPage([chen,{...chen,id:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5b'}],2,0,null)));
 await assert.rejects(readActiveStudents(STUDENT_API,'key'),/相同显示姓名/);
});
test('students endpoint returns live roster only after teacher authorization and never caches it',async t=>{
 let scriptCalls=0,hubCalls=0;
 withEnv(t,async(url,options)=>{
  const u=new URL(url);
  if(u.hostname==='script.google.com'){
   scriptCalls++;const payload=JSON.parse(options.body);
   if(payload.action==='verifyPassword')return response({status:'success',role:'teacher'});
   return response({status:'success',data:{competitions:[],rosterYear:'2026'}});
  }
  hubCalls++;assert.equal(options.headers.Authorization,'Bearer test-studenthub-api-key');
  return response(hubPage([chen],1,0,null));
 });
 const res=mockRes();
 await studentsHandler({method:'POST',body:{year:'2026',auth_pwd:'T4ch'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(res.body.data.items[0].studentName,'陈小明 TAN XIAO MING');
 assert.equal(res.body.data.items[0].source,'studenthub');
 assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
 assert.equal(scriptCalls,2);assert.equal(hubCalls,1);
});
test('students endpoint rejects invalid credentials before reading StudentHub',async t=>{
 let hubCalls=0;
 withEnv(t,async url=>{if(new URL(url).hostname==='script.google.com')return response({status:'error',code:'UNAUTHORIZED',message:'Sign in.'});hubCalls++;return response(hubPage([chen],1,0,null));});
 const res=mockRes();await studentsHandler({method:'POST',body:{year:'2026',auth_pwd:'wrong'}},res);
 assert.equal(res.statusCode,401);assert.equal(res.body.code,'UNAUTHORIZED');assert.equal(hubCalls,0);
 assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
});
test('registration revalidates StudentHub identity and signs trusted fields server-side',async t=>{
 let registrationPayload=null;
 withEnv(t,async(url,options)=>{
  const u=new URL(url);
  if(u.hostname==='script.google.com'){
   const payload=JSON.parse(options.body);
   if(payload.action==='verifyPassword')return response({status:'success',role:'teacher'});
   if(payload.action==='getSnapshot')return response({status:'success',data:{competitions:[],rosterYear:'2026'}});
   registrationPayload=payload;
   return response({status:'success',data:{id:payload.id}});
  }
  return response(hubPage([chen],1,0,null));
 });
 const id='operation_0000001';
 const res=mockRes();
 await registerHandler({method:'POST',body:{id,year:'2026',auth_pwd:'T4ch',studentHubId:STUDENT_ID,competitionId:'comp-2026',teamId:'',teamName:'',note:''}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.success,true);
 assert.equal(registrationPayload.action,'registerStudentHub');
 assert.equal(registrationPayload.studentName,'陈小明 TAN XIAO MING');
 assert.equal(registrationPayload.studentClass,'3A');
 assert.equal(registrationPayload.studentHubProof,signStudentHubRegistration({
  id,year:'2026',studentHubId:STUDENT_ID,studentName:'陈小明 TAN XIAO MING',
  studentClass:'3A',studentProofExpiresAt:registrationPayload.studentProofExpiresAt
 },'test-studenthub-api-key'));
 assert.notEqual(registrationPayload.studentHubProof,'test-studenthub-api-key');
});
test('registration refuses a student removed from StudentHub',async t=>{
 withEnv(t,async(url,options)=>{
  if(new URL(url).hostname==='script.google.com'){
   const payload=JSON.parse(options.body);
   return response(payload.action==='verifyPassword'?{status:'success',role:'admin'}:{status:'success',data:{competitions:[],rosterYear:'2026'}});
  }
  return response(hubPage([],0,0,null));
 });
 const res=mockRes();
 await registerHandler({method:'POST',body:{id:'operation_0000002',year:'2026',auth_pwd:'admin',studentHubId:STUDENT_ID,competitionId:'comp-2026'}},res);
 assert.equal(res.statusCode,404);assert.equal(res.body.code,'NOT_FOUND');
});
test('old bulk-write route is disabled',async()=>{
 const res=mockRes();await retiredSyncHandler({method:'POST',body:{}},res);
 assert.equal(res.statusCode,410);assert.equal(res.body.code,'RETIRED');
});
