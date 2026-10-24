const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
function fixture(){
 const data={};const calls=[];let failStorage=false,failNetwork=false,responseCode=null;
 const state={adminPwd:'test-session',role:'admin',isAdmin:true,selectedYear:'2026',unsyncedQueue:[],auditLog:[],studentRows:[],dbResults:[],competitionItems:[],availableYears:[],studentDB:{},classList:[],
 modals:{score:{},editCategory:{},poster:{},dialog:{}},form:{},currentTab:'results'};
 let writer=Promise.resolve(),batchConflict=false;const ctx=vm.createContext({state,console,crypto,AbortController,setTimeout,clearTimeout,URL,Blob,
 PRODUCTION_SCRIPT_URL:'https://mock.invalid/api',GOOGLE_SCRIPT_URL:'https://mock.invalid/api',isTestEnv:false,
 localStorage:{getItem:k=>data[k]||null,setItem:(k,v)=>{if(failStorage)throw Error('quota exceeded');data[k]=v;},removeItem:k=>delete data[k]},
 navigator:{locks:{request:(_name,task)=>{const p=writer.then(task);writer=p.catch(()=>{});return p;}}},
 updateDOM(){},showToast(){},showDialog:async()=>true,
 fetch:async(_url,opts)=>{const p=JSON.parse(opts.body);calls.push(p);if(failNetwork)throw Error('offline');
  return {ok:true,json:async()=>responseCode?{status:'error',code:responseCode,message:'rejected'}:p.action==='getSnapshot'?{status:'success',version:'7.0',data:{competitions:[],students:[],results:[],years:['2026'],authenticated:true}}:p.action==='batchUpdateScores'?{status:'success',outcomes:batchConflict?[{id:p.operations[0].id,status:'success'},{id:p.operations[1].id,status:'error',code:'CONFLICT',message:'changed'}]:p.operations.map(o=>({id:o.id,status:'success'}))}:{status:'success',data:{}}};}
 });
 vm.runInContext(fs.readFileSync(path.join(root,'app-sync.js'),'utf8'),ctx);
 const run=source=>vm.runInContext(source,ctx);
 return {state,data,calls,run,failStorage:()=>failStorage=true,offline:b=>failNetwork=b,reject:c=>responseCode=c,partialBatch:()=>batchConflict=true};
}
test('all shipped browser scripts and Apps Script parse',()=>{
 for(const f of ['app-sync.js','app-actions.js','Code.gs'])new vm.Script(fs.readFileSync(path.join(root,f),'utf8'),{filename:f});
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const script=html.match(/<script>\s*\/\/ --- 1\.[\s\S]*?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');new vm.Script(script);
});
test('outbox is persisted before any network request; sent in FIFO order',async()=>{
 const f=fixture();await f.run("queueMutations([makeOperation('updateScore',{recordId:'a',score:'80'}),makeOperation('updateScore',{recordId:'b',score:'90'})])");
 assert.equal(f.calls.length,0);assert.equal(JSON.parse(Object.values(f.data)[0]).length,2);
 await f.run('syncQueueData()');assert.deepEqual(f.calls.find(p=>p.action==='batchUpdateScores').operations.map(p=>p.score),['80','90']);assert.equal(f.state.unsyncedQueue.length,0);
});
test('failed storage prevents network sends and does not pretend the edit is saved',async()=>{
 const f=fixture();f.failStorage();assert.equal(await f.run("queueMutations([makeOperation('updateScore',{recordId:'a'})])"),false);assert.equal(f.calls.length,0);assert.equal(f.state.unsyncedQueue.length,0);
});
test('offline request remains durable and reconnect sends the same ID',async()=>{
 const f=fixture();await f.run("queueMutations([makeOperation('updateScore',{recordId:'a'})])");const id=f.state.unsyncedQueue[0].id;
 f.offline(true);await f.run('syncQueueData()');assert.equal(f.state.unsyncedQueue.length,1);
 f.offline(false);await f.run('syncQueueData()');assert.equal(f.state.unsyncedQueue.length,0);
 assert.deepEqual(f.calls.filter(p=>p.action==='updateScore').map(p=>p.id),[id,id]);assert.equal(f.state.isOfflineMode,false);
});
test('conflicts remain blocked without repeated writes or silent overwrites',async()=>{
 const f=fixture();await f.run("queueMutations([makeOperation('updateScore',{recordId:'a'})])");f.reject('CONFLICT');await f.run('syncQueueData()');
 assert.equal(f.state.unsyncedQueue[0].syncStatus,'blocked');await f.run('syncQueueData()');assert.equal(f.calls.filter(p=>p.action==='updateScore').length,1);
});
test('pending operation prevents another edit of the same record',async()=>{
 const f=fixture();assert.equal(await f.run("queueMutations([makeOperation('updateScore',{recordId:'a',score:'80'})])"),true);
 assert.equal(await f.run("queueMutations([makeOperation('updateScore',{recordId:'a',score:'90'})])"),false);assert.equal(f.state.unsyncedQueue.length,1);
});
test('parallel enqueue callers share one persisted queue',async()=>{
 const f=fixture();await Promise.all([f.run("queueMutations([makeOperation('updateScore',{recordId:'a'})])"),f.run("queueMutations([makeOperation('updateScore',{recordId:'b'})])")]);assert.equal(f.state.unsyncedQueue.length,2);
});
test('HTML escaping preserves names and quotes as text',()=>{
 const f=fixture();assert.equal(f.run('escapeHTML(`<img src=x onerror=alert(1)>"&\'`)'),'&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;');
});
test('cached results from another year are not merged into the current year',()=>{
 const f=fixture();f.state.unsyncedQueue=[{id:'old',year:'2025',action:'register',name:'Old'}];assert.equal(f.run('mergePending([])').length,0);
});
test('search input renders locally instead of triggering network refresh',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');assert.match(html,/id="student-search" oninput="state.studentSearchQuery = this.value; app.render\(\);"/);assert.match(html,/state.searchQuery = this.value; app.render\(\);/);
});
test('partial batch removes only acknowledged operations and blocks the correct failed item',async()=>{
 const f=fixture();await f.run("queueMutations(['a','b','c'].map(recordId=>makeOperation('updateScore',{recordId})))");
 f.partialBatch();await f.run('syncQueueData()');assert.equal(f.state.unsyncedQueue.length,2);assert.equal(f.state.unsyncedQueue[0].recordId,'b');assert.equal(f.state.unsyncedQueue[0].syncStatus,'blocked');assert.equal(f.state.unsyncedQueue[1].recordId,'c');
});
