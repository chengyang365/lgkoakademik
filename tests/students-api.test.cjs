'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/sync-students.js');

const appScriptUrl='https://script.google.com/macros/s/test-app-id/exec';
const apiKey='test-hub-server-secret';
function response(status,body){return {ok:status>=200&&status<300,status,json:async()=>body};}
function mockRes(){
  return {headers:{},statusCode:0,body:null,setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
}
function setEnv(values={}){
  const keys=['APPS_SCRIPT_URL','STUDENT_API_KEY','STUDENT_API_URL'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)delete process.env[k];
  Object.assign(process.env,values);
  return ()=>{for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}};
}
function appResponse(body){return response(200,body);}
function hubPage(items,{total=items.length,nextOffset=null,syncCursor=7}={}){
  return response(200,{success:true,data:{items,total,nextOffset,syncCursor}});
}

test('sync proxy requires POST and all secrets remain server-side',async()=>{
  const restore=setEnv();const oldFetch=global.fetch;let calls=0;global.fetch=async()=>{calls++;return appResponse({status:'success',role:'admin'});};
  try{
    const res=mockRes();await handler({method:'GET'},res);
    assert.equal(res.statusCode,405);assert.equal(calls,0);assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
    const noConfig=mockRes();await handler({method:'POST',body:{year:'2026',auth_pwd:'secret'}},noConfig);
    assert.equal(noConfig.statusCode,503);assert.equal(calls,0);
  }finally{restore();global.fetch=oldFetch;}
});

test('only a verified admin may read the roster API',async()=>{
  const restore=setEnv({APPS_SCRIPT_URL:appScriptUrl,STUDENT_API_KEY:apiKey});
  const oldFetch=global.fetch;let calls=0;
  global.fetch=async(url,options)=>{calls++;assert.match(String(url),/script\\.google\\.com/);return appResponse({status:'success',role:'teacher'});};
  try{
    const res=mockRes();await handler({method:'POST',body:{year:'2026',auth_pwd:'teacher-secret'}},res);
    assert.equal(res.statusCode,403);assert.equal(calls,1);assert.equal(JSON.stringify(res.body).includes(apiKey),false);
  }finally{restore();global.fetch=oldFetch;}
});

test('fetches all active pages then sends the roster to Apps Script without returning names',async()=>{
  const restore=setEnv({APPS_SCRIPT_URL:appScriptUrl,STUDENT_API_KEY:apiKey});
  const oldFetch=global.fetch;const calls=[];
  const page1=Array.from({length:500},(_,i)=>({id:'hub-'+i,name:'Student '+i,className:'1A'}));
  const page2=[{id:'hub-500',name:'Student 500',className:'2A'}];
  global.fetch=async(url,options)=>{
    calls.push({url:String(url),options});
    if(calls.length===1)return appResponse({status:'success',role:'admin'});
    if(String(url).includes('lgstudenthub.vercel.app')) {
      const parsed=new URL(String(url));assert.equal(parsed.searchParams.get('limit'),'500');assert.equal(parsed.searchParams.get('status'),'active');
      assert.equal(options.headers.Authorization,'Bearer '+apiKey);
      return parsed.searchParams.get('offset')==='0'?hubPage(page1,{total:501,nextOffset:500}):hubPage(page2,{total:501});
    }
    const payload=JSON.parse(options.body);assert.equal(payload.action,'syncStudentRoster');assert.equal(payload.auth_pwd,'admin-secret');
    assert.equal(payload.students.length,501);assert.equal(payload.students[500].id,'hub-500');
    return appResponse({status:'success',data:{year:'2026',activeCount:501,createdCount:501,updatedCount:0,deactivatedCount:0,mappedCount:501}});
  };
  try{
    const res=mockRes();await handler({method:'POST',body:{year:'2026',auth_pwd:'admin-secret'}},res);
    assert.equal(res.statusCode,200);assert.equal(res.body.success,true);assert.equal(res.body.data.activeCount,501);
    assert.equal(calls.length,4);assert.equal(JSON.stringify(res.body).includes('Student 500'),false);assert.equal(JSON.stringify(res.body).includes(apiKey),false);
  }finally{restore();global.fetch=oldFetch;}
});

test('aborts instead of writing when the source changes during pagination',async()=>{
  const restore=setEnv({APPS_SCRIPT_URL:appScriptUrl,STUDENT_API_KEY:apiKey});const oldFetch=global.fetch;let calls=0;
  global.fetch=async(url)=>{
    calls++;
    if(calls===1)return appResponse({status:'success',role:'admin'});
    if(calls===2)return hubPage(Array.from({length:500},(_,i)=>({id:'hub-'+i,name:'Student '+i,className:'1A'})),{total:501,nextOffset:500,syncCursor:7});
    if(calls===3)return hubPage([{id:'hub-500',name:'Student 500',className:'2A'}],{total:501,syncCursor:8});
    throw new Error('sync should not be called');
  };
  try{
    const res=mockRes();await handler({method:'POST',body:{year:'2026',auth_pwd:'admin-secret'}},res);
    assert.equal(res.statusCode,502);assert.match(res.body.message,/发生变化/);assert.equal(calls,3);
  }finally{restore();global.fetch=oldFetch;}
});
