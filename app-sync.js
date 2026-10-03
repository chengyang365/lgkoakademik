/* Network, durable outbox and safe rendering helpers. No passwords are persisted. */
'use strict';
let storageFault = false;
let refreshSequence = 0;
let syncing = false;
const safeJSON = (key, fallback) => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (_) { storageFault = true; return fallback; }
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const operationId = () => crypto.randomUUID();
const storagePrefix = () => 'school:v7:' + encodeURIComponent(GOOGLE_SCRIPT_URL) + ':';
const outboxKey = () => storagePrefix() + 'outbox';
const cacheKey = year => storagePrefix() + 'cache:' + year;
const loadOutbox = () => {
    const rows = safeJSON(outboxKey(), []);
    if (!Array.isArray(rows) || rows.some(r => !r.id || !r.year || !r.action)) { storageFault = true; return []; }
    return rows;
};
const persistQueue = rows => {
    if (storageFault) throw new Error('本机存储损坏，请先导出待处理资料；已停止写入，避免覆盖原记录。');
    // Fail before changing the in-memory queue if the browser cannot persist the write.
    localStorage.setItem(outboxKey(), JSON.stringify(rows));
    state.unsyncedQueue = rows;
};
const withOutboxLock = task => {
    if (!navigator.locks) return Promise.reject(new Error('此浏览器不支持安全补传，请使用新版 Chrome、Edge 或 Safari，并通过 HTTPS 打开。'));
    return navigator.locks.request(storagePrefix() + 'writer', task);
};
const apiRequest = async (payload, timeout = 30000) => {
    if (!GOOGLE_SCRIPT_URL || (isTestEnv && GOOGLE_SCRIPT_URL === PRODUCTION_SCRIPT_URL)) throw new Error('请先配置独立测试后端 TEST_SCRIPT_URL。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(GOOGLE_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
            body:JSON.stringify(payload), redirect:'follow', signal:controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (result.status !== 'success') {
            const error = new Error(result.message || '请求失败'); error.code = result.code || 'SERVER'; throw error;
        }
        return result;
    } finally { clearTimeout(timer); }
};
const fetchWithRealCheck = async (_url, payload, action, timeout = 30000, overridePwd = null) => {
    if (action === 'verifyPassword') return apiRequest({action,auth_pwd:overridePwd}, timeout);
    throw new Error('写入必须经过持久化补传队列。');
};
const ensureSignedIn = async () => {
    if (state.adminPwd) return true;
    const pwd = await showDialog({type:'password',title:'教师 / 管理员登录',message:'请输入教师或管理员密码。',placeholder:'密码',icon:'fas fa-lock'});
    if (!pwd) return false;
    try {
        const result = await apiRequest({action:'verifyPassword',auth_pwd:pwd});
        if (result.version !== '7.0') throw new Error('后端尚未升级至 v7，请先完成迁移和部署。');
        state.adminPwd = pwd; state.role = result.role; state.isAdmin = result.role === 'admin';
        await fetchAllData(false); return true;
    } catch(e) { showToast(e.message,'error'); return false; }
};
const enterAdmin = async () => {
    if (!await ensureSignedIn()) return;
    state.currentTab = state.isAdmin ? 'admin' : 'results'; state.selectedCategory = null; updateDOM();
};
const logout = () => {
    state.adminPwd = ''; state.isAdmin = false; state.role = '';
    state.studentDB = {}; state.studentRows = []; state.dbResults = []; state.classList = [];
    state.auditLog = []; state.currentTab = 'results'; state.isBatchEditing = false; state.batchEditData = [];
    state.modals.score.visible = false; state.modals.editCategory.visible = false; state.modals.poster.visible = false;
    state.form = {category:'',isTeamBundle:false,groups:[]};
    for (const key of Object.keys(localStorage)) if (key.startsWith(storagePrefix() + 'cache:')) localStorage.removeItem(key);
    // Pending work must survive logout; never silently delete the outbox.
    updateDOM();
};
const mergePending = results => {
    const rows = results.map(r => ({...r}));
    for (const item of state.unsyncedQueue.filter(q => q.year === state.selectedYear)) {
        const row = rows.find(r => r.id === item.recordId);
        if (item.action === 'updateScore' && row) { row.score=item.score; row.rank=item.rank; if(item.note!==undefined) row.note=item.note; row.pending=true; }
        if (item.action === 'deleteRegistration' && row) row.pending=true;
        if (item.action === 'register' && !rows.some(r => r.studentId===item.studentId && r.competitionId===item.competitionId)) {
            rows.push({id:'pending-'+item.id,studentId:item.studentId,competitionId:item.competitionId,year:item.year,
                studentName:item.name,studentClass:item.stuClass,category:item.category,teamId:item.teamId,teamName:item.teamName,
                score:'',rank:'',note:item.note,version:0,pending:true});
        }
    }
    return rows.map((r,i)=>({...r,rowIndex:i}));
};
const fetchAllData = async (background = false) => {
    if (background && (state.isBatchEditing || state.isSubmitting || state.modals.score.visible || state.modals.editCategory.visible || state.modals.dialog.visible)) return;
    const seq = ++refreshSequence, year = state.selectedYear, credential = state.adminPwd;
    if (!background) {state.isRefreshing=true; updateDOM();}
    try {
        const response = await apiRequest({action:'getSnapshot',year,auth_pwd:credential});
        if (seq !== refreshSequence || year !== state.selectedYear || credential !== state.adminPwd) return;
        if (response.version !== '7.0') throw new Error('请先部署 v7 后端。');
        const snapshot = response.data;
        if (!snapshot || !Array.isArray(snapshot.competitions) || !Array.isArray(snapshot.results) || !Array.isArray(snapshot.students)) throw new Error('服务器数据格式不正确。');
        if (credential && !snapshot.authenticated) { logout(); throw new Error('密码已失效，请重新登录。'); }
        state.competitionItems=snapshot.competitions; state.availableYears=snapshot.years;
        state.studentRows=snapshot.students; state.studentDB={};
        for(const s of snapshot.students) (state.studentDB[s.studentClass] ||= []).push(s.studentName);
        state.classList=Object.keys(state.studentDB).sort();
        state.unsyncedQueue=loadOutbox();
        state.dbResults=credential ? mergePending(snapshot.results) : [];
        state.isOfflineMode=false; state.lastSync=new Date().toISOString();
        try { localStorage.setItem(cacheKey(year), JSON.stringify({...snapshot,lastSync:state.lastSync})); }
        catch(_) { showToast('数据已读取，但本机缓存空间不足。','warning'); }
    } catch(e) {
        if (seq !== refreshSequence || year !== state.selectedYear || credential !== state.adminPwd) return;
        state.isOfflineMode=true;
        if(!background) showToast(e.message || '连接失败，保留本机资料。','warning');
    } finally {
        if(seq===refreshSequence) {state.isInitializing=false;state.isRefreshing=false;updateDOM();}
    }
};
const initLocalCache = () => {
    const snapshot=safeJSON(cacheKey(state.selectedYear),null);
    if(snapshot && Array.isArray(snapshot.competitions)) { state.competitionItems=snapshot.competitions;state.availableYears=snapshot.years || []; }
    state.unsyncedQueue=loadOutbox();
    state.legacyPending=safeJSON('unsyncedQueue',[]);
    // A fresh session never reveals cached student records before signing in.
};
const changeYear = async e => {
    if(state.isBatchEditing || state.modals.score.visible || state.isSubmitting) { showToast('请先保存或取消当前编辑。','warning');updateDOM();return; }
    const year=String(e.target.value); if(!/^20\d{2}$/.test(year)) return;
    state.selectedYear=year;localStorage.setItem('app_selected_year',year);
    state.selectedCategory=null;state.competitionItems=[];state.dbResults=[];state.studentDB={};state.studentRows=[];state.classList=[];
    initLocalCache(); await fetchAllData();
};
const makeOperation = (action, fields) => ({...fields, action, id:operationId(), year:state.selectedYear, syncStatus:'pending',createdAt:new Date().toISOString()});
const queueMutations = async operations => {
    if (!await ensureSignedIn()) return false;
    try {
        await withOutboxLock(async () => {
            const queue=loadOutbox();
            for(const op of operations) {
                if(queue.some(q=>q.year===op.year && (op.recordId ? q.recordId===op.recordId : op.action==='register' ? q.action==='register' && q.studentId===op.studentId && q.competitionId===op.competitionId : q.competitionId===op.competitionId))) {
                    throw new Error('这条记录仍有待同步修改，请先处理补传，避免覆盖。');
                }
            }
            persistQueue([...queue,...operations]);
        });
        state.auditLog=[...operations.map(o=>({...o,timestamp:o.createdAt})),...state.auditLog].slice(0,50);
        state.dbResults=mergePending(state.dbResults);
        showToast('已存本机，等待服务器确认。');
        return true;
    } catch(e) {showToast(e.message,'error');return false;}
};
const syncQueueData = async (silent = false) => {
    if(syncing || !state.adminPwd) {if(!silent && !state.adminPwd) showToast('请先登录，再补传。','warning');return;}
    syncing=true;
    try {
        await withOutboxLock(async()=>{
            let queue=loadOutbox(); state.unsyncedQueue=queue;
            while(queue.length && state.adminPwd) {
                const item=queue[0];
                if(item.syncStatus==='blocked') break;
                try {
                    const batch=[];
                    if(item.action==='updateScore') for(const op of queue) {
                        if(batch.length===20 || op.action!=='updateScore' || op.year!==item.year || op.syncStatus==='blocked') break;
                        batch.push(op);
                    }
                    const response=batch.length>1
                        ? await apiRequest({action:'batchUpdateScores',year:item.year,operations:batch,auth_pwd:state.adminPwd})
                        : await apiRequest({...item,auth_pwd:state.adminPwd});
                    const outcomes=batch.length>1 ? response.outcomes : [{id:item.id,status:'success'}];
                    if(!Array.isArray(outcomes) || !outcomes.length) throw new Error('服务器没有返回保存凭证，已保留待上传操作。');
                    for(const outcome of outcomes) {
                        if(outcome.id!==queue[0]?.id) throw new Error('服务器返回顺序异常，已保留待上传操作。');
                        if(outcome.status!=='success') {const error=new Error(outcome.message);error.code=outcome.code;throw error;}
                        const log=state.auditLog.find(l=>l.id===outcome.id);if(log)log.syncStatus='synced';
                        queue=queue.slice(1);persistQueue(queue);
                    }
                } catch(e) {
                    if(e.code==='UNAUTHORIZED') {logout();break;}
                    if(['CONFLICT','VALIDATION','FORBIDDEN','NOT_FOUND','SCHEMA','MIGRATION_REQUIRED','CONFIG'].includes(e.code)) {
                        queue=[{...queue[0],syncStatus:'blocked',error:e.message},...queue.slice(1)];persistQueue(queue);
                        showToast('补传需要处理：'+e.message,'warning');
                    } else {state.isOfflineMode=true;if(!silent)showToast('连接未确认，操作已保留。重试不会重复执行。','warning');}
                    break;
                }
            }
        });
    } catch(e) {showToast(e.message,'error');}
    finally {syncing=false;await fetchAllData(true);updateDOM();}
};
const exportPending = () => {
    const payload={exportedAt:new Date().toISOString(),outbox:localStorage.getItem(outboxKey()),legacy:localStorage.getItem('unsyncedQueue'),legacyAudit:localStorage.getItem('localAuditLog')};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='pending-operations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
const reviewBlocked = async () => {
    if(!await ensureSignedIn())return;
    const item=loadOutbox().find(q=>q.syncStatus==='blocked');if(!item)return;
    const discard=await showDialog({type:'confirm',title:'处理未同步操作',message:`${item.year} / ${item.category || item.name || item.action}\n${item.error}\n\n请先导出备份。确认后仅移除此失败操作，读取云端最新值；不会强制覆盖云端。`,confirmText:'移除失败操作'});
    if(!discard)return;
    await withOutboxLock(async()=>persistQueue(loadOutbox().filter(q=>q.id!==item.id)));
    await fetchAllData();
};
const renderSyncNotice = () => `<div class="mx-4 my-2 p-3 rounded-xl bg-indigo-50 text-sm flex flex-wrap gap-3 items-center">
    <span>${state.adminPwd ? (state.role==='admin'?'管理员已登录':'教师已登录') : '登录后可查看学生资料及录入成绩'}</span>
    <span>${state.unsyncedQueue.length ? '待同步 '+state.unsyncedQueue.length+' 条' : '无待同步操作'}</span>
    ${state.lastSync ? `<span>最后读取：${escapeHTML(new Date(state.lastSync).toLocaleTimeString())}</span>` : ''}
    ${state.adminPwd ? '<button onclick="app.logout()" class="underline">退出登录</button>' : '<button onclick="app.enterAdmin()" class="underline">登录</button>'}
    ${state.unsyncedQueue.length || state.legacyPending?.length || storageFault ? '<button onclick="app.exportPending()" class="underline">导出待处理备份</button>' : ''}
    ${state.unsyncedQueue.some(q=>q.syncStatus==='blocked') ? '<button onclick="app.reviewBlocked()" class="underline text-rose-700">处理同步冲突</button>' : ''}
    ${state.legacyPending?.length ? '<span class="text-rose-700">发现旧版待上传记录，请先导出并人工核对年度；不会自动补传。</span>' : ''}
    ${storageFault ? '<span class="text-rose-700">本机存储损坏，写入已暂停，请先导出备份。</span>' : ''}
</div>`;
