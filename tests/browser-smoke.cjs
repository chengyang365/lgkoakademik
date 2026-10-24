const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const root=path.join(__dirname,'..');
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const attack='<img src=x onerror="window.injected=1">';
  const comp={id:'c',year:'2026',name:'Speech '+attack,organizer:attack,status:'open',version:1};
  const students=[{id:'s1',year:'2026',studentClass:'1A',studentName:'Alice '+attack},{id:'s2',year:'2026',studentClass:'1A',studentName:'Bob'}];
  let results=students.map((s,i)=>({id:'r'+i,year:'2026',studentId:s.id,competitionId:'c',studentName:s.studentName,studentClass:s.studentClass,category:comp.name,score:'0',rank:'冠军',note:attack,version:1}));
  const writes=[];
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname==='school.test'){
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','app-sync.js','app-actions.js'].includes(name))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(path.join(root,name),'utf8')});
   }
   if(url.hostname==='script.google.com'){
    const p=req.postDataJSON();let data;
    if(p.action==='verifyPassword')data={status:'success',version:'7.0',role:'admin'};
    else if(p.action==='getSnapshot')data={status:'success',version:'7.0',data:{competitions:[comp],students:p.auth_pwd?students:[],results:p.auth_pwd?results:[],years:['2026'],authenticated:!!p.auth_pwd}};
    else {writes.push(p);if(p.action==='updateScore')results=results.map(r=>r.id===p.recordId?{...r,score:p.score,rank:p.rank,note:p.note,version:r.version+1}:r);data={status:'success',data:{}};}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   }
   // Tests never contact a real backend or a third-party asset server.
   return route.fulfill({status:200,body:'',contentType:req.resourceType()==='script'?'application/javascript':'text/plain'});
  });
  await page.goto('https://school.test/');await page.waitForFunction(()=>!state.isInitializing);
  assert.equal(await page.evaluate(()=>state.dbResults.length),0);
  await page.evaluate(()=>{void app.enterAdmin();});await page.locator('#modal-input').fill('test-credential');await page.locator('#modal-input').press('Enter');
  await page.waitForFunction(()=>state.isAdmin && state.currentTab==='admin');
  assert.equal(await page.evaluate(()=>state.dbResults.length),2);
  await page.evaluate(()=>{app.goHome();app.selectCategory(state.competitionItems[0].name);});
  assert.equal(await page.locator('#app img[src="x"]').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.evaluate(()=>{void app.openScoreModal(state.dbResults[0].studentName,'1A');});
  await page.locator('#indiv-note').fill('edited note');await page.locator('#indiv-score').fill('0');
  await page.evaluate(()=>app.submitScore());assert.equal(writes[0].note,'edited note');assert.equal(writes[0].score,'0');
  await page.evaluate(()=>app.goToStudentRecords());await page.locator('#student-search').fill('Bob');
  assert.equal(await page.locator('#student-search').inputValue(),'Bob');
  assert.equal(await page.locator('h3').filter({hasText:'Bob'}).count(),1);
  assert.equal(await page.locator('h3').filter({hasText:'Alice'}).count(),0);
  await page.evaluate(()=>app.goToRegister(state.competitionItems[0].name));
  await page.locator('#reg-class-0').selectOption('1A');assert.equal(await page.locator('#app img[src="x"]').count(),0);
  await page.evaluate(()=>app.logout());assert.equal(await page.evaluate(()=>state.dbResults.length),0);
  assert.equal(await page.locator('#modal-input').count(),0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.getByRole('button',{name:'登录',exact:true}).count());
  assert.deepEqual(errors,[]);console.log('PASS: login, privacy, hostile text rendering, zero/note save, local search, registration selectors, logout and mobile login entry. No external network used.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
