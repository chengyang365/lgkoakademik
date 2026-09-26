'use strict';
const saveBatchEdit = async () => {
    if(!await ensureSignedIn())return;
    const operations=[];
    for(const group of state.batchEditData) for(const cls of group.classes) for(const stu of cls.students) {
        const original=state.dbResults.find(r=>r.id===stu.id);
        if(!original)continue;
        const score=String(stu.score ?? '').trim(), rank=String(stu.rank ?? '').trim();
        if(score===String(original.score ?? '') && rank===String(original.rank ?? ''))continue;
        if(original.pending){showToast('请先补传待处理记录。','warning');return;}
        operations.push(makeOperation('updateScore',{recordId:stu.id,competitionId:stu.competitionId,expectedVersion:Number(stu.version),score,rank,
            name:stu.studentName,stuClass:cls.className,category:state.selectedCategory}));
    }
    if(operations.length && !await queueMutations(operations))return;
    state.isBatchEditing=false;state.historySnapshot=null;updateDOM();await syncQueueData();
};
const submitForm = async () => {
    if(!await ensureSignedIn())return;
    const comp=state.competitionItems.find(c=>c.name===state.form.category);
    if(!comp){showToast('请选择比赛。','warning');return;}
    const operations=[],seen=new Set();
    for(const group of state.form.groups) {
        const teamName=state.form.isTeamBundle ? String(group.teamName || '').trim() : '';
        if(state.form.isTeamBundle && !teamName){showToast('请填写队伍名称。','warning');return;}
        const teamId=teamName ? operationId() : '';
        for(let i=0;i<group.students.length;i++) {
            const name=group.students[i];if(!name)continue;
            const student=state.studentRows.find(s=>s.studentName===name && s.studentClass===group.class);
            if(!student){showToast('学生不在当前年度名册，请刷新。','error');return;}
            if(seen.has(student.id) || state.dbResults.some(r=>r.studentId===student.id && r.competitionId===comp.id))continue;
            seen.add(student.id);
            operations.push(makeOperation('register',{studentId:student.id,competitionId:comp.id,teamId,teamName,
                name:name+(teamName?' ['+teamName+']':''),stuClass:group.class,category:comp.name,note:String(group.notes?.[i] || '').trim()}));
        }
    }
    if(!operations.length){showToast('没有新的参赛学生，请检查是否已经报名。','warning');return;}
    if(!await queueMutations(operations))return;
    if(state.keepClassInfo)state.form.groups.forEach(g=>{g.students=[''];g.teamName='';g.notes=[''];});
    else state.form={category:'',isTeamBundle:false,groups:[{id:Date.now(),class:'',teamName:'',students:[''],notes:['']}]};
    updateDOM();await syncQueueData();
};
const deleteRegistration = async (stuName, className) => {
    if(!await ensureSignedIn())return;
    if(!state.isAdmin){showToast('删除报名需要管理员权限。','warning');return;}
    const row=state.dbResults.find(r=>r.studentName===stuName && r.studentClass===className && r.category===state.selectedCategory);
    if(!row || row.pending){showToast('请先同步或刷新该记录。','warning');return;}
    if(!await showDialog({type:'confirm',title:'确认删除报名',message:'确定删除 '+stuName+' 的报名吗？服务器将保留操作记录。'}))return;
    if(await queueMutations([makeOperation('deleteRegistration',{recordId:row.id,competitionId:row.competitionId,expectedVersion:Number(row.version),name:stuName,category:row.category})])) await syncQueueData();
};
const openScoreModal = async (stuName,className) => {
    if(!await ensureSignedIn())return;
    const row=state.dbResults.find(r=>r.studentName===stuName && r.studentClass===className && r.category===state.selectedCategory);
    if(!row || row.pending){showToast('请先同步或刷新该记录。','warning');return;}
    state.modals.score={visible:true,studentName:stuName,className,score:row.score ?? '',rank:row.rank ?? '',note:row.note ?? '',category:row.category,
        recordId:row.id,competitionId:row.competitionId,teamId:row.teamId,
        records:state.dbResults.filter(r=>r.id===row.id || (row.teamId && r.competitionId===row.competitionId && r.teamId===row.teamId)).map(r=>({...r}))};
    updateDOM();
};
const submitScore = async () => {
    if(!await ensureSignedIn())return;
    const m=state.modals.score;
    if(m.records.some(r=>r.pending)){showToast('团队仍有待上传记录，请先补传。','warning');return;}
    const operations=m.records.map(r=>makeOperation('updateScore',{recordId:r.id,competitionId:r.competitionId,expectedVersion:Number(r.version),
        score:m.score,rank:m.rank,note:r.id===m.recordId?m.note:r.note,name:r.studentName,stuClass:r.studentClass,category:r.category}));
    if(!await queueMutations(operations))return;
    state.modals.score.visible=false;updateDOM();await syncQueueData();
};
const competitionWrite = async (action,name,fields={}) => {
    if(!await ensureSignedIn())return false;
    if(!state.isAdmin){showToast('需要管理员权限。','warning');return false;}
    const comp=state.competitionItems.find(c=>c.name===name);
    if(action!=='addCompetition' && !comp){showToast('比赛不存在，请刷新。','error');return false;}
    const op=makeOperation(action,{...(comp?{competitionId:comp.id,expectedVersion:Number(comp.version)}:{}),...fields,name,category:name});
    if(!await queueMutations([op]))return false;
    await syncQueueData();return !state.unsyncedQueue.some(q=>q.id===op.id);
};
const submitEditCategory = async () => {
    const m=state.modals.editCategory;
    if(await competitionWrite('editCompetition',m.oldName,{competitionId:m.competitionId,expectedVersion:m.expectedVersion,newName:m.newName.trim(),organizer:m.organizer.trim(),startDate:m.startDate,endDate:m.endDate})) {
        state.modals.editCategory.visible=false;if(state.selectedCategory===m.oldName)state.selectedCategory=m.newName.trim();
        await fetchAllData();
    }
    updateDOM();
};
const toggleStatus = async name => {
    const c=state.competitionItems.find(c=>c.name===name);if(c)await competitionWrite('toggleStatus',name,{status:c.status==='open'?'closed':'open'});
};
const adminAddItem = async e => {
    e.preventDefault();const f=state.adminForm;
    if(await competitionWrite('addCompetition',f.name.trim(),{organizer:f.organizer.trim(),startDate:f.startDate,endDate:f.endDate})) state.adminForm={name:'',organizer:'',startDate:'',endDate:''};
    updateDOM();
};
const adminDeleteItem = async name => {
    if(await showDialog({type:'confirm',title:'确认删除比赛',message:'删除 '+name+' 后，该比赛及报名不再显示。后台保留记录。'}))await competitionWrite('deleteCompetition',name);
};
