import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ensureSetup, getTasks, createTask as apiCreateTask, updateTask, moveTask as apiMoveTask, closeTask, deleteTask as apiDeleteTask } from './todoist';

const MAX_TODAY = 3;
const MAX_ACTIVE = 30;
const STALE_DAYS = 14;
const ROLLOVER_LIMIT = 2;
const TOKEN_KEY = 'dps_token';
const SETUP_KEY = 'dps_setup';
const ORDER_KEY = 'dps_order';
const LOG_KEY = 'dps_log';
const LAST_DATE_KEY = 'dps_last_date';
const DONE_KEY = 'dps_done';

const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const todayStr = () => new Date().toISOString().slice(0, 10);
const parseDeadline = (t) => { const m = t.match(/#deadline:(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const parseProject = (t) => { const m = t.match(/@(\w+)/); return m ? m[1] : null; };
const cleanTitle = (t) => t.replace(/#deadline:\d{4}-\d{2}-\d{2}/g, '').replace(/@\w+/g, '').trim();
function loadJson(key, fb) { try { return JSON.parse(localStorage.getItem(key)) || fb; } catch { return fb; } }
function saveJson(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

const darkC = {
  bg:'#1a1a1e',surface:'#232328',surfaceHover:'#2a2a30',border:'#333338',
  text:'#e4e4e7',textMuted:'#8b8b95',textFaint:'#55555f',
  accent:'#c9a55a',accentDim:'#c9a55a33',danger:'#d4564e',dangerDim:'#d4564e22',
  success:'#5ab87a',todayBg:'#1e1e24',dragOver:'#2e2e38',
};
const lightC = {
  bg:'#f5f5f0',surface:'#ffffff',surfaceHover:'#eeeee8',border:'#d8d8d0',
  text:'#1a1a1e',textMuted:'#6b6b75',textFaint:'#9b9ba0',
  accent:'#9a7b2d',accentDim:'#9a7b2d1a',danger:'#c0392b',dangerDim:'#c0392b12',
  success:'#3a8a55',todayBg:'#fffff8',dragOver:'#e8e8e0',
};
const ThemeCtx = React.createContext(darkC);
const useColors = () => React.useContext(ThemeCtx);
function useTheme() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = e => setDark(e.matches);
    mq.addEventListener('change', h); return () => mq.removeEventListener('change', h);
  }, []);
  return dark ? darkC : lightC;
}
const fontLink = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap';

function TokenSetup({ onSave }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const c = useColors();
  const go = async () => {
    setLoading(true); setError('');
    try {
      const s = await ensureSetup(token.trim());
      localStorage.setItem(TOKEN_KEY, token.trim());
      saveJson(SETUP_KEY, s);
      onSave(token.trim(), s);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };
  return (
    <div style={{minHeight:'100vh',background:c.bg,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'IBM Plex Sans',sans-serif"}}>
      <div style={{maxWidth:400,padding:32}}>
        <div style={{fontSize:18,fontWeight:300,color:c.text,marginBottom:8}}>Daily Priorities</div>
        <div style={{fontSize:12,color:c.textMuted,marginBottom:24,lineHeight:1.6}}>
          Paste your Todoist API token.<br/>Settings → Integrations → Developer
        </div>
        <input value={token} onChange={e=>setToken(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')go();}}
          placeholder="Todoist API token"
          style={{width:'100%',padding:'10px 12px',background:c.surface,border:`1px solid ${c.border}`,borderRadius:6,color:c.text,fontSize:13,fontFamily:"'IBM Plex Mono',monospace",outline:'none',boxSizing:'border-box'}}/>
        {error && <div style={{color:c.danger,fontSize:12,marginTop:8}}>{error}</div>}
        <button onClick={go} disabled={loading||!token.trim()}
          style={{width:'100%',padding:'10px 12px',marginTop:12,background:c.accent,color:'#1a1a1e',border:'none',borderRadius:6,fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:"'IBM Plex Sans',sans-serif",opacity:loading?0.6:1}}>
          {loading?'Setting up…':'Connect'}
        </button>
      </div>
    </div>
  );
}

function Badge({children,color,bg}) {
  const c = useColors();
  return <span style={{fontSize:10,fontFamily:"'IBM Plex Mono',monospace",fontWeight:500,color:color||c.textMuted,background:bg||'transparent',padding:'2px 6px',borderRadius:3,letterSpacing:'0.03em',textTransform:'uppercase'}}>{children}</span>;
}

function TaskItem({task,section,onComplete,onMove,onDelete,onEdit,isDragging,onDragStart,onDragEnd,onDragOver,onDrop}) {
  const c = useColors();
  const [editing,setEditing] = useState(false);
  const [editVal,setEditVal] = useState(task.content);
  const ref = useRef(null);
  const now = new Date();
  const lastMoved = new Date(task._lastMoved || task.created_at);
  const staleDays = daysBetween(lastMoved, now);
  const isStale = staleDays >= STALE_DAYS && section !== 'done';
  const dd = task.due?.date || task.deadline?.date;
  const dDays = dd ? daysBetween(now, new Date(dd+'T23:59:59')) : null;
  const isPast = dDays !== null && dDays < 0;
  const isNear = dDays !== null && dDays >= 0 && dDays <= 3;
  const rc = task._rolloverCount || 0;
  const needsBreak = rc >= ROLLOVER_LIMIT && section === 'today';
  useEffect(()=>{if(editing&&ref.current)ref.current.focus();},[editing]);
  const save = () => { const t=editVal.trim(); if(t&&t!==task.content)onEdit(task.id,t); setEditing(false); };
  const opacity = isStale ? Math.max(0.4, 1-(staleDays-STALE_DAYS)*0.015) : 1;
  const ib = {width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'none',color:c.textMuted,cursor:'pointer',borderRadius:4,fontSize:14,fontFamily:"'IBM Plex Mono',monospace"};
  return (
    <div draggable onDragStart={e=>{e.dataTransfer.setData('text/plain',task.id);onDragStart(task.id);}}
      onDragEnd={onDragEnd} onDragOver={e=>{e.preventDefault();onDragOver(task.id);}} onDrop={e=>{e.preventDefault();onDrop(task.id);}}
      style={{display:'flex',alignItems:'flex-start',gap:10,padding:'8px 12px',borderRadius:6,cursor:'grab',opacity,
        background:isDragging?c.dragOver:'transparent',
        borderLeft:needsBreak?`3px solid ${c.danger}`:isPast?`3px solid ${c.danger}`:isNear?`3px solid ${c.accent}`:'3px solid transparent',
        transition:'background 0.15s'}}
      onMouseEnter={e=>e.currentTarget.style.background=c.surfaceHover}
      onMouseLeave={e=>e.currentTarget.style.background=isDragging?c.dragOver:'transparent'}>
      {section!=='done'?(
        <button onClick={()=>onComplete(task.id)} style={{width:18,height:18,minWidth:18,borderRadius:'50%',border:`1.5px solid ${c.textFaint}`,background:'transparent',cursor:'pointer',marginTop:3}} title="Complete"/>
      ):(
        <span style={{width:18,height:18,minWidth:18,display:'flex',alignItems:'center',justifyContent:'center',marginTop:3,color:c.success,fontSize:14}}>✓</span>
      )}
      <div style={{flex:1,minWidth:0}}>
        {editing?(
          <input ref={ref} value={editVal} onChange={e=>setEditVal(e.target.value)}
            onBlur={save} onKeyDown={e=>{if(e.key==='Enter')save();if(e.key==='Escape'){setEditVal(task.content);setEditing(false);}}}
            style={{width:'100%',background:c.bg,border:`1px solid ${c.border}`,borderRadius:4,color:c.text,padding:'3px 6px',fontSize:13,fontFamily:"'IBM Plex Sans',sans-serif",outline:'none'}}/>
        ):(
          <span onDoubleClick={()=>{setEditVal(task.content);setEditing(true);}}
            style={{fontSize:13,fontFamily:"'IBM Plex Sans',sans-serif",color:section==='done'?c.textMuted:c.text,textDecoration:section==='done'?'line-through':'none',lineHeight:1.5,cursor:'text'}}>
            {task.content}
          </span>
        )}
        <div style={{display:'flex',gap:6,marginTop:3,flexWrap:'wrap',alignItems:'center'}}>
          {task.labels?.map(l=><Badge key={l}>@{l}</Badge>)}
          {dd&&<Badge color={isPast?c.danger:isNear?c.accent:c.textMuted} bg={isPast?c.dangerDim:isNear?c.accentDim:'transparent'}>
            {isPast?`${Math.abs(dDays)}d overdue`:dDays===0?'today':`${dDays}d`}
          </Badge>}
          {isStale&&<Badge color={c.textFaint}>{staleDays}d untouched</Badge>}
          {needsBreak&&<Badge color={c.danger} bg={c.dangerDim}>break down or archive</Badge>}
        </div>
      </div>
      <div style={{display:'flex',gap:2,opacity:0.4,transition:'opacity 0.15s'}}
        onMouseEnter={e=>e.currentTarget.style.opacity=1} onMouseLeave={e=>e.currentTarget.style.opacity=0.4}>
        {section==='today'&&<button onClick={()=>onMove(task.id,'active')} title="Defer" style={ib}>↓</button>}
        {section==='active'&&<button onClick={()=>onMove(task.id,'waiting')} title="Waiting" style={ib}>⏸</button>}
        {section==='waiting'&&<button onClick={()=>onMove(task.id,'active')} title="Unblock" style={ib}>▶</button>}
        {section==='inbox'&&<button onClick={()=>onMove(task.id,'active')} title="Promote" style={ib}>↑</button>}
        <button onClick={()=>onDelete(task.id)} title="Archive" style={ib}>×</button>
      </div>
    </div>
  );
}

function Section({id,label,tasks,cap,collapsed:ic,onComplete,onMove,onDelete,onEdit,dragState,setDragState,accentColor,urgentCount,children}) {
  const c = useColors();
  const [collapsed,setCollapsed] = useState(ic||false);
  const hDO = e=>{e.preventDefault();e.stopPropagation();setDragState(s=>({...s,overSection:id}));};
  const hDr = e=>{
    e.preventDefault();e.stopPropagation();
    const tid=dragState.dragging;
    if(tid){const t=tasks.find(x=>x.id===tid);if(t&&t._section!==id)onMove(tid,id);}
    setDragState({dragging:null,overTask:null,overSection:null});
  };
  const isOver=dragState.overSection===id&&dragState.dragging;
  const dt=dragState.dragging?tasks.find(x=>x.id===dragState.dragging):null;
  const isFO=isOver&&dt&&dt._section!==id;
  const display=tasks.filter(t=>t._section===id);
  return (
    <div style={{marginBottom:id==='today'?24:12}}>
      <div onClick={()=>id!=='today'&&setCollapsed(!collapsed)} onDragOver={hDO} onDrop={hDr}
        style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',cursor:id!=='today'?'pointer':'default',userSelect:'none'}}>
        {id!=='today'&&<span style={{fontSize:10,color:c.textFaint,transform:collapsed?'rotate(-90deg)':'rotate(0deg)',transition:'transform 0.15s',display:'inline-block'}}>▼</span>}
        <span style={{fontSize:id==='today'?14:11,fontFamily:"'IBM Plex Mono',monospace",fontWeight:600,color:accentColor||c.textMuted,letterSpacing:'0.08em',textTransform:'uppercase'}}>{label}</span>
        {cap?<span style={{fontSize:10,fontFamily:"'IBM Plex Mono',monospace",color:display.length>=cap?c.danger:c.textFaint}}>{display.length}/{cap}</span>
          :<span style={{fontSize:10,fontFamily:"'IBM Plex Mono',monospace",color:c.textFaint}}>{display.length}</span>}
        {urgentCount>0&&<span style={{fontSize:9,fontFamily:"'IBM Plex Mono',monospace",fontWeight:600,color:c.danger,background:c.dangerDim,padding:'1px 5px',borderRadius:3}}>⚠ {urgentCount} due soon</span>}
      </div>
      {!collapsed&&(
        <div onDragOver={hDO} onDrop={hDr} style={{
          background:isFO?c.dragOver:id==='today'?c.todayBg:'transparent',borderRadius:8,minHeight:id==='today'?80:30,
          border:id==='today'?`1px solid ${isFO?c.accent:c.border}`:'none',padding:id==='today'?'4px 0':0,transition:'background 0.15s,border-color 0.15s'}}>
          {display.map(task=>(
            <TaskItem key={task.id} task={task} section={id}
              onComplete={onComplete} onMove={onMove} onDelete={onDelete} onEdit={onEdit}
              isDragging={dragState.dragging===task.id}
              onDragStart={id=>setDragState({dragging:id,overTask:null,overSection:null})}
              onDragEnd={()=>setDragState({dragging:null,overTask:null,overSection:null})}
              onDragOver={id=>setDragState(s=>({...s,overTask:id}))}
              onDrop={()=>setDragState({dragging:null,overTask:null,overSection:null})}/>
          ))}
          {display.length===0&&id==='today'&&(
            <div style={{padding:'20px 12px',fontSize:12,color:c.textFaint,fontFamily:"'IBM Plex Sans',sans-serif",fontStyle:'italic',textAlign:'center',pointerEvents:'none'}}>
              Drag up to 3 tasks here to commit to today
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function AddTask({onAdd,section,placeholder}) {
  const c = useColors();
  const [v,setV] = useState('');
  const go = ()=>{if(v.trim()){onAdd(v.trim(),section);setV('');}};
  return (
    <div style={{padding:'4px 12px'}}>
      <input value={v} onChange={e=>setV(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')go();}}
        placeholder={placeholder||'+ Add task (@label #deadline:YYYY-MM-DD)'}
        style={{width:'100%',background:'transparent',border:'none',borderBottom:`1px solid ${c.border}`,color:c.textMuted,padding:'6px 0',fontSize:12,fontFamily:"'IBM Plex Sans',sans-serif",outline:'none',boxSizing:'border-box'}}
        onFocus={e=>e.target.style.borderBottomColor=c.accent}
        onBlur={e=>e.target.style.borderBottomColor=c.border}/>
    </div>
  );
}

export default function App() {
  const colors = useTheme();
  const [token,setToken] = useState(()=>localStorage.getItem(TOKEN_KEY)||'');
  const [setup,setSetup] = useState(()=>loadJson(SETUP_KEY,null));
  const [tasks,setTasks] = useState([]);
  const [doneList,setDoneList] = useState(()=>loadJson(DONE_KEY,[]));
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [dragState,setDragState] = useState({dragging:null,overTask:null,overSection:null});

  const secIdToName = setup ? Object.fromEntries(Object.entries(setup.sectionMap).map(([k,v])=>[v,k])) : {};
  const orderMap = loadJson(ORDER_KEY,{});

  const enriched = tasks.map(t=>({
    ...t,
    _section: secIdToName[t.section_id]||'inbox',
    _lastMoved: orderMap[t.id]?.lastMoved||t.created_at,
    _rolloverCount: orderMap[t.id]?.rolloverCount||0,
    _order: orderMap[t.id]?.order??t.order??9999,
  })).sort((a,b)=>a._order-b._order);

  const weekAgo = new Date(Date.now()-7*86400000);
  const recentDone = doneList.filter(d=>new Date(d.completed_at)>=weekAgo).map(d=>({...d,_section:'done'}));
  const allTasks = [...enriched,...recentDone];

  const fetchTasks = useCallback(async()=>{
    if(!token||!setup)return;
    setLoading(true);
    try { setTasks(await getTasks(token,setup.projectId)); setError(''); }
    catch(e){ setError(e.message); }
    setLoading(false);
  },[token,setup]);

  useEffect(()=>{fetchTasks();},[fetchTasks]);

  useEffect(()=>{
    const last=localStorage.getItem(LAST_DATE_KEY);
    const today=todayStr();
    if(last&&last!==today&&tasks.length>0){
      const om=loadJson(ORDER_KEY,{});
      tasks.filter(t=>secIdToName[t.section_id]==='today').forEach(t=>{
        om[t.id]={...om[t.id],rolloverCount:((om[t.id]?.rolloverCount)||0)+1};
      });
      saveJson(ORDER_KEY,om);
      const log=loadJson(LOG_KEY,[]);
      const td=doneList.filter(d=>d.completed_at?.startsWith(last));
      const todayT=tasks.filter(t=>secIdToName[t.section_id]==='today');
      log.push({date:last,committed:todayT.length+td.length,done:td.length,deferred:todayT.length,dropped:0});
      saveJson(LOG_KEY,log.slice(-30));
    }
    localStorage.setItem(LAST_DATE_KEY,today);
  },[tasks]);

  const addTask = useCallback(async(raw,section)=>{
    if(!token||!setup)return;
    const deadline=parseDeadline(raw); const project=parseProject(raw); const title=cleanTitle(raw);
    if(!title)return;
    if(section==='today'&&enriched.filter(t=>t._section==='today').length>=MAX_TODAY){alert(`Today full (max ${MAX_TODAY}).`);return;}
    if(section==='active'&&enriched.filter(t=>t._section==='active').length>=MAX_ACTIVE){alert(`Active full (${MAX_ACTIVE}).`);return;}
    const opts={project_id:setup.projectId};
    if(setup.sectionMap[section])opts.section_id=setup.sectionMap[section];
    if(deadline)opts.due_date=deadline;
    if(project)opts.labels=[project];
    try{await apiCreateTask(token,title,opts);await fetchTasks();}catch(e){setError(e.message);}
  },[token,setup,enriched,fetchTasks]);

  const completeTask = useCallback(async(id)=>{
    const task=tasks.find(t=>t.id===id); if(!task)return;
    try{
      await closeTask(token,id);
      const dl=loadJson(DONE_KEY,[]);
      dl.push({id,content:task.content,labels:task.labels,completed_at:new Date().toISOString()});
      const filtered=dl.filter(d=>new Date(d.completed_at)>=new Date(Date.now()-7*86400000));
      saveJson(DONE_KEY,filtered); setDoneList(filtered);
      await fetchTasks();
    }catch(e){setError(e.message);}
  },[token,tasks,fetchTasks]);

  const moveTask = useCallback(async(id,toSec)=>{
    if(!setup)return;
    const task=enriched.find(t=>t.id===id); if(!task)return;
    if(toSec==='today'&&enriched.filter(t=>t._section==='today').length>=MAX_TODAY&&task._section!=='today'){alert(`Today full (max ${MAX_TODAY}).`);return;}
    if(toSec==='active'&&enriched.filter(t=>t._section==='active').length>=MAX_ACTIVE&&task._section!=='active'){alert(`Active full (${MAX_ACTIVE}).`);return;}
    const sid=setup.sectionMap[toSec]; if(!sid)return;
    const om=loadJson(ORDER_KEY,{});
    om[id]={...om[id],lastMoved:new Date().toISOString(),rolloverCount:toSec==='today'?0:(om[id]?.rolloverCount||0)};
    saveJson(ORDER_KEY,om);
    try{await apiMoveTask(token,id,sid);await fetchTasks();}catch(e){setError(e.message);}
  },[token,setup,enriched,fetchTasks]);

  const handleDelete = useCallback(async(id)=>{
    try{await apiDeleteTask(token,id);await fetchTasks();}catch(e){setError(e.message);}
  },[token,fetchTasks]);

  const handleEdit = useCallback(async(id,content)=>{
    try{await updateTask(token,id,{content});await fetchTasks();}catch(e){setError(e.message);}
  },[token,fetchTasks]);

  const log=loadJson(LOG_KEY,[]);
  const rLog=log.filter(e=>new Date(e.date)>=new Date(Date.now()-7*86400000));
  const sum={committed:0,done:0,deferred:0};
  rLog.forEach(e=>{sum.committed+=e.committed||0;sum.done+=e.done||0;sum.deferred+=e.deferred||0;});

  const todayDate=new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const urgent=sec=>allTasks.filter(t=>t._section===sec&&(t.due?.date||t.deadline?.date)&&daysBetween(new Date(),new Date((t.due?.date||t.deadline?.date)+'T23:59:59'))<=3).length;

  if(!token||!setup) return (
    <ThemeCtx.Provider value={colors}><link href={fontLink} rel="stylesheet"/>
      <TokenSetup onSave={(t,s)=>{setToken(t);setSetup(s);}}/>
    </ThemeCtx.Provider>
  );

  return (
    <ThemeCtx.Provider value={colors}>
      <link href={fontLink} rel="stylesheet"/>
      <div style={{minHeight:'100vh',background:colors.bg,color:colors.text,fontFamily:"'IBM Plex Sans',sans-serif",padding:'40px 0',display:'flex',justifyContent:'center'}}>
        <div style={{width:'100%',maxWidth:560,padding:'0 20px'}}>
          <div style={{marginBottom:32,display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:12,fontFamily:"'IBM Plex Mono',monospace",color:colors.textFaint,letterSpacing:'0.1em',textTransform:'uppercase',marginBottom:4}}>{todayDate}</div>
              <div style={{fontSize:22,fontWeight:300,color:colors.text}}>What matters today?</div>
            </div>
            <button onClick={fetchTasks} title="Refresh"
              style={{background:'transparent',border:'none',color:colors.textFaint,cursor:'pointer',fontSize:16,padding:8,opacity:loading?0.3:0.6}}>↻</button>
          </div>
          {error&&<div style={{padding:'8px 12px',marginBottom:16,background:colors.dangerDim,borderRadius:6,fontSize:12,color:colors.danger}}>{error}</div>}

          <Section id="today" label="Today" tasks={allTasks} cap={MAX_TODAY}
            onComplete={completeTask} onMove={moveTask} onDelete={handleDelete} onEdit={handleEdit}
            dragState={dragState} setDragState={setDragState} accentColor={colors.accent}/>
          <Section id="active" label="Active" tasks={allTasks} cap={MAX_ACTIVE}
            onComplete={completeTask} onMove={moveTask} onDelete={handleDelete} onEdit={handleEdit}
            dragState={dragState} setDragState={setDragState}>
            <AddTask onAdd={addTask} section="active" placeholder="+ Add to active (@label #deadline:YYYY-MM-DD)"/>
          </Section>
          <Section id="inbox" label="Inbox" tasks={allTasks} collapsed={true} urgentCount={urgent('inbox')}
            onComplete={completeTask} onMove={moveTask} onDelete={handleDelete} onEdit={handleEdit}
            dragState={dragState} setDragState={setDragState}>
            <AddTask onAdd={addTask} section="inbox" placeholder="+ Quick capture"/>
          </Section>
          <Section id="waiting" label="Waiting" tasks={allTasks} collapsed={true} urgentCount={urgent('waiting')}
            onComplete={completeTask} onMove={moveTask} onDelete={handleDelete} onEdit={handleEdit}
            dragState={dragState} setDragState={setDragState}/>
          <Section id="done" label="Done this week" tasks={allTasks} collapsed={true}
            onComplete={()=>{}} onMove={()=>{}} onDelete={()=>{}} onEdit={()=>{}}
            dragState={dragState} setDragState={setDragState}/>

          {sum.committed>0&&(
            <div style={{marginTop:24,padding:'10px 12px',borderTop:`1px solid ${colors.border}`,fontSize:11,fontFamily:"'IBM Plex Mono',monospace",color:colors.textFaint,display:'flex',gap:16}}>
              <span>7d: {sum.committed} committed</span>
              <span style={{color:colors.success}}>→ {sum.done} done</span>
              {sum.deferred>0&&<span>↻ {sum.deferred} deferred</span>}
            </div>
          )}
          <div style={{marginTop:16,fontSize:10,fontFamily:"'IBM Plex Mono',monospace",color:colors.textFaint,textAlign:'center',opacity:0.5,display:'flex',justifyContent:'space-between'}}>
            <span>double-click to edit · drag to move</span>
            <button onClick={()=>{localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(SETUP_KEY);setToken('');setSetup(null);}}
              style={{background:'transparent',border:'none',color:colors.textFaint,cursor:'pointer',fontSize:10,fontFamily:"'IBM Plex Mono',monospace",opacity:0.5}}>disconnect</button>
          </div>
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
