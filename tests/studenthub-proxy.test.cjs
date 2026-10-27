const {test}=require('node:test');
const assert=require('node:assert/strict');

const registerStudent=require('../api/register-student');
const students=require('../api/students');
const priorFetch=global.fetch;
const priorAppsScriptUrl=process.env.APPS_SCRIPT_URL;
const priorStudentApiKey=process.env.STUDENT_API_KEY;
process.env.APPS_SCRIPT_URL='https://script.google.com/macros/s/deployment-id/exec';
delete process.env.STUDENT_API_KEY;

function response(status=200,body={status:'success',data:{items:[]}}) {
  const headers={};
  const res={headers,setHeader(key,value){headers[key]=value;return this;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
  return res;
}
test('register proxy forwards only the selected StudentHub UUID and registration fields',async t=>{
  let sent=null,endpoint=null;
  global.fetch=async(url,options)=>{
    endpoint=url;sent=JSON.parse(options.body);
    return {ok:true,json:async()=>({status:'success',data:{studentId:sent.studentHubId,studentNameSnapshot:'陈小明 TAN XIAO MING',studentClassSnapshot:'3A'}})};
  };
  t.after(()=>{global.fetch=priorFetch;});
  const res=response();
  await registerStudent({method:'POST',body:{
    auth_pwd:'T4ch',year:'2026',id:'op-abcdefghijk',studentHubId:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a',
    competitionId:'comp-2026',name:'browser supplied name',stuClass:'99Z',studentName:'spoofed',studentClass:'99Z',
    studentHubProof:'old invalid proof',studentProofExpiresAt:'1',teamId:'',teamName:'',note:''
  }},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.success,true);
  assert.equal(endpoint,process.env.APPS_SCRIPT_URL);
  assert.equal(sent.action,'registerStudentHub');
  assert.equal(sent.studentHubId,'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a');
  assert.equal(sent.studentName,undefined);
  assert.equal(sent.studentClass,undefined);
  assert.equal(sent.studentHubProof,undefined);
  assert.equal(process.env.STUDENT_API_KEY,undefined);
});
test('roster proxy delegates live roster reads to the authenticated Apps Script action',async t=>{
  let sent=null;
  global.fetch=async(_url,options)=>{
    sent=JSON.parse(options.body);
    return {ok:true,json:async()=>({status:'success',data:{items:[{id:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a',studentName:'陈小明 TAN XIAO MING',studentClass:'3A'}],total:1}})};
  };
  t.after(()=>{global.fetch=priorFetch;});
  const res=response();
  await students({method:'POST',body:{auth_pwd:'T4ch',year:'2026'}},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.data.items[0].studentName,'陈小明 TAN XIAO MING');
  assert.equal(sent.action,'getStudentHubRoster');
  assert.equal(sent.auth_pwd,'T4ch');
  assert.equal(sent.year,'2026');
});
test('invalid registration proof is no longer part of the server contract',async t=>{
  global.fetch=async(_url,options)=>{
    const sent=JSON.parse(options.body);
    assert.equal(sent.studentHubProof,undefined);
    return {ok:true,json:async()=>({status:'success',data:{id:'result-1'}})};
  };
  t.after(()=>{global.fetch=priorFetch;});
  const res=response();
  await registerStudent({method:'POST',body:{auth_pwd:'T4ch',year:'2026',id:'op-abcdefghijk',
    studentHubId:'1f1b8d54-5c66-4c1f-9f8b-0a6f7c3d8f5a',competitionId:'comp-2026'}},res);
  assert.equal(res.statusCode,200);
});
test.after(()=>{
  if(priorAppsScriptUrl===undefined)delete process.env.APPS_SCRIPT_URL;else process.env.APPS_SCRIPT_URL=priorAppsScriptUrl;
  if(priorStudentApiKey===undefined)delete process.env.STUDENT_API_KEY;else process.env.STUDENT_API_KEY=priorStudentApiKey;
});
