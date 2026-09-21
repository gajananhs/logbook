/* Points at the /api/ folder — one file per action. Relative path, so it
   works whether this site lives at the domain root or in a subfolder. */
const API_URL = 'api';

let USERS = [];
let TASKS = [];
let STATUSES = [];
let ATTENDANCE = [];
let NOTIFICATIONS = [];
let DEPARTMENTS = [];
let SUB_DEPARTMENTS = [];
let CURRENT_USER = null;
let ACTIVE_TAB = 'dashboard';
let OPEN_UPDATE_FORM = null;
let EDIT_TASK_ID = null;
let EDIT_UPDATE_ID = null;
let HEARTBEAT_TIMER = null;
let NOTIF_POLL_TIMER = null;
let SEEN_NOTIF_IDS = null; // null = baseline not established yet (no beeping on first load)
let LIVESTATUS_TIMER = null;
let LOCATION_PERMISSION_ASKED = false;

/* ===================== EMAIL DEEP LINKS =====================
   The Team Summary email's View/Assign/Comment links point back here as
   plain URLs (email clients can't run the dashboard's onclick JS). Once
   the admin logs in, this replays the exact same click the dashboard
   button would have triggered — viewEmployeeTasks()/assignToEmployee()/
   toggleCommentRow(), unchanged — so behavior matches the dashboard exactly. */
let PENDING_EMAIL_ACTION = (function(){
  const p = new URLSearchParams(window.location.search);
  const action = p.get('empAction');
  const emp = p.get('emp');
  if(!action || !emp || ['view','assign','comment'].indexOf(action) === -1) return null;
  return { action, emp };
})();
/* ===================== SSO HANDOFF (from Sales Reporter) =====================
   Sales Reporter's "Logbook" tab opens this app with a short-lived signed
   link instead of the name+PIN form. We verify it server-side and log the
   matching user straight in via enterAsUser(), same as a normal login. */
let PENDING_SSO_LOGIN = (function(){
  const p = new URLSearchParams(window.location.search);
  const name = p.get('sso_name');
  const exp = p.get('sso_exp');
  const sig = p.get('sso_sig');
  if(!name || !exp || !sig) return null;
  return { name, exp, sig };
})();
async function applyPendingSsoLogin(){
  if(!PENDING_SSO_LOGIN) return;
  const { name, exp, sig } = PENDING_SSO_LOGIN;
  PENDING_SSO_LOGIN = null;
  // Strip the params immediately so a refresh doesn't replay a used/expired link.
  history.replaceState({}, '', window.location.pathname + window.location.search.replace(/[?&]sso_(name|exp|sig)=[^&]*/g, '').replace(/^&/, '?'));
  try{
    const res = await apiPost('sso_login', { name, exp, sig });
    enterAsUser(res.user);
  }catch(e){
    const errEl = document.getElementById('loginError');
    if(errEl) errEl.textContent = e.message || 'Could not sign in from Sales Reporter';
    showToast(e.message || 'Could not sign in from Sales Reporter', true);
  }
}
function applyPendingEmailAction(){
  if(!PENDING_EMAIL_ACTION) return;
  const { action, emp } = PENDING_EMAIL_ACTION;
  PENDING_EMAIL_ACTION = null;
  // Strip the params so a refresh or logout/login doesn't replay the action.
  history.replaceState({}, '', window.location.pathname);
  if(!canSeeTeamBoard(CURRENT_USER)) return;
  if(!USERS.some(u => u.id === emp)) return;
  if(action === 'assign'){
    assignToEmployee(emp); // same function as the dashboard button; it switches to the New Task tab itself
  } else {
    setTab('team');
    if(action === 'view') viewEmployeeTasks(emp);
    else if(action === 'comment') toggleCommentRow(emp);
  }
}

/* ===================== API ===================== */
async function apiGet(action, params){
  const qs = new URLSearchParams(params || {}).toString();
  const res = await fetch(`${API_URL}/${action}.php${qs ? '?' + qs : ''}`);
  let data;
  try{ data = await res.json(); }
  catch(e){ throw new Error('Request failed'); }
  if(data && data.error) throw new Error(data.error);
  if(!res.ok) throw new Error('Request failed');
  return data;
}
async function apiPost(action, payload){
  const res = await fetch(`${API_URL}/${action}.php`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload || {})
  });
  let data;
  try{ data = await res.json(); }
  catch(e){ throw new Error('Request failed'); }
  if(data && data.error) { const err = new Error(data.error); Object.assign(err, data); throw err; }
  if(!res.ok) throw new Error('Request failed');
  return data;
}

async function loadAll(){
  const data = await apiGet('bootstrap');
  USERS = data.users || [];
  TASKS = data.tasks || [];
  STATUSES = data.statuses || [];
  ATTENDANCE = data.attendance || [];
  DEPARTMENTS = data.departments || [];
  SUB_DEPARTMENTS = data.subDepartments || [];
}
async function refreshAndRender(){
  try{ await loadAll(); }catch(e){ /* keep showing stale data over nothing */ }
  render();
}

/* ===================== UTIL ===================== */
function uidLocal(prefix){ return prefix + '_' + Date.now().toString(36); }
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso.length===10 ? iso+'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
}
function fmtDateTime(iso){
  const d = new Date(iso.replace(' ','T'));
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) + ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}
function daysBetween(a,b){ return Math.round((b-a)/86400000); }
function userName(id){ const u = USERS.find(x=>x.id===id); return u ? u.name : 'Unassigned'; }
function deptName(id){ const d = DEPARTMENTS.find(x=>x.id===id); return d ? d.name : null; }
function subDeptName(id){ const s = SUB_DEPARTMENTS.find(x=>x.id===id); return s ? s.name : null; }
function orgRoleLabel(role){
  if(role==='dept_head') return 'Department Head';
  if(role==='sub_head') return 'Sub-department Head';
  return 'Employee';
}
function orgContextLabel(u){
  const dept = deptName(u.departmentId);
  const sub = subDeptName(u.subDepartmentId);
  if(u.orgRole==='dept_head') return dept ? `Head of ${dept}` : 'Department Head (no department set)';
  if(u.orgRole==='sub_head') return sub ? `Head of ${sub}${dept?' ('+dept+')':''}` : 'Sub-department Head (no sub-department set)';
  if(sub) return `${sub}${dept?' · '+dept:''}`;
  if(dept) return dept;
  return 'No department set';
}
/* Who a given user is allowed to assign tasks to, mirroring the server-side
   check in _bootstrap.php's can_assign() — this only controls what's shown
   in the picker; the server enforces it independently either way. */
function assignableUsersFor(user){
  if(user.isAdmin) return USERS;
  if(user.orgRole === 'dept_head'){
    return USERS.filter(u => u.id===user.id || (user.departmentId && u.departmentId===user.departmentId));
  }
  if(user.orgRole === 'sub_head'){
    return USERS.filter(u => u.id===user.id || (user.subDepartmentId && u.subDepartmentId===user.subDepartmentId));
  }
  return USERS.filter(u => u.id===user.id);
}
function statusById(id){ return STATUSES.find(s=>s.id===id) || {id, name:'Unknown', color:'#8B94A0', isDone:false}; }
function hexToRgba(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function showToast(msg, isError){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function totalHoursLogged(task){
  return (task.updates||[]).reduce((s,u)=> s + (Number(u.hoursLogged)||0), 0);
}
function isTaskDone(task){ return statusById(task.status).isDone; }
function latestProgress(task){
  if(isTaskDone(task)) return 100;
  const ups = task.updates||[];
  if(!ups.length) return 0;
  return ups[ups.length-1].progressPct;
}
function efficiencyPct(task){
  if(!isTaskDone(task)) return null;
  const actual = task.actualHours || totalHoursLogged(task) || 0;
  if(!task.estimatedHours || !actual) return null;
  const pct = (task.estimatedHours / actual) * 100;
  return Math.max(0, Math.min(150, Math.round(pct)));
}
function isOverdue(task){
  if(isTaskDone(task) || !task.dueDate) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(task.dueDate.length===10 ? task.dueDate+'T00:00:00' : task.dueDate);
  return due < today;
}
function isStale(task){
  if(isTaskDone(task)) return false;
  const ups = task.updates||[];
  const lastTs = ups.length ? new Date(ups[ups.length-1].date.replace(' ','T')) : new Date(task.createdAt.replace(' ','T'));
  return daysBetween(lastTs, new Date()) >= 3;
}
function effColor(pct){
  if(pct === null) return 'var(--muted)';
  if(pct >= 90) return 'var(--teal)';
  if(pct >= 70) return 'var(--amber)';
  return 'var(--rust)';
}
function gaugeSVG(pct, size=44){
  const shown = pct === null ? 0 : Math.min(pct,100);
  const r = (size/2) - 4;
  const c = 2*Math.PI*r;
  const offset = c - (shown/100)*c;
  const color = effColor(pct);
  return `<div class="gauge" style="width:${size}px;height:${size}px;">
    <svg width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="4"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
    </svg>
    <div class="gauge-val" style="color:${color};">${pct===null?'–':pct+'%'}</div>
  </div>`;
}

/* ===================== LOGIN ===================== */
async function attemptLogin(){
  const name = document.getElementById('newUserInput').value.trim();
  const errEl = document.getElementById('loginError');
  if(errEl) errEl.textContent = '';
  if(!name){ showToast('Enter your name'); return; }
  const pin = document.getElementById('newUserPin').value.trim();
  const btn = document.getElementById('enterBtn');
  btn.disabled = true;
  try{
    const res = await apiPost('login', { name, pin: pin || '' });
    enterAsUser(res.user);
  }catch(e){
    if(errEl) errEl.textContent = e.message || 'Could not sign in';
    showToast(e.message || 'Could not sign in', true);
  }finally{
    btn.disabled = false;
  }
}
document.getElementById('newUserInput').addEventListener('keydown', e=>{
  if(e.key === 'Enter') attemptLogin();
});
document.getElementById('newUserPin').addEventListener('keydown', e=>{
  if(e.key === 'Enter') attemptLogin();
});
function enterAsUser(user){
  CURRENT_USER = user;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'block';
  document.getElementById('whoName').textContent = CURRENT_USER.name;
  renderAdminTabs();
  applyRoleTabVisibility();
  applyBackToSalesReportVisibility();
  startHeartbeat();
  refreshNotifications();
  startNotifPolling();
  setTab('dashboard');
  applyPendingEmailAction();
}
function applyRoleTabVisibility(){
  // Team Board shows other people's tasks — plain employees only get their
  // own Dashboard / Assigned to Me / Assigned by Me, never a team roster.
  const teamTabBtn = document.querySelector('.tab[data-tab="team"]');
  if(teamTabBtn) teamTabBtn.style.display = canSeeTeamBoard(CURRENT_USER) ? '' : 'none';
}
// "Back to Sales Report" is only for people who actually use Sales Reporter
// (the marketing/sales side). Matched by Logbook account name, case-insensitive.
const SALES_REPORT_USERS = ['mahesh', 'prem', 'mohan raj', 'harishiv', 'gajanan', 'sunitha'];
function canGoBackToSalesReport(user){
  return !!(user && user.name && SALES_REPORT_USERS.indexOf(user.name.trim().toLowerCase()) !== -1);
}
function applyBackToSalesReportVisibility(){
  const btn = document.getElementById('backToSalesReportBtn');
  if(btn) btn.style.display = canGoBackToSalesReport(CURRENT_USER) ? '' : 'none';
}
async function backToSalesReport(){
  const btn = document.getElementById('backToSalesReportBtn');
  if(btn) btn.disabled = true;
  try{
    const res = await apiPost('get_sales_report_link', { name: CURRENT_USER.name });
    window.location.href = res.url; // navigates back in this same tab
  }catch(e){
    showToast(e.message || 'Could not open Sales Report', true);
  }finally{
    if(btn) btn.disabled = false;
  }
}
function switchUser(){
  stopHeartbeat();
  stopNotifPolling();
  CURRENT_USER = null;
  EDIT_TASK_ID = null;
  EDIT_UPDATE_ID = null;
  NOTIFICATIONS = [];
  document.getElementById('mainScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('newUserInput').value = '';
  document.getElementById('newUserPin').value = '';
  const errEl = document.getElementById('loginError');
  if(errEl) errEl.textContent = '';
  document.getElementById('notifPanel').style.display = 'none';
}

function renderAdminTabs(){
  const el = document.getElementById('adminTabs');
  if(!CURRENT_USER.isAdmin){ el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="tab" data-tab="employees" onclick="setTab('employees')">Employees</button>
    <button class="tab" data-tab="departments" onclick="setTab('departments')">Departments</button>
    <button class="tab" data-tab="livestatus" onclick="setTab('livestatus')">Live Status</button>
    <button class="tab" data-tab="reports" onclick="setTab('reports')">Reports</button>
    <button class="tab" data-tab="reporthistory" onclick="setTab('reporthistory')">Reports History</button>
  `;
}

/* ===================== GPS / HEARTBEAT ===================== */
function startHeartbeat(){
  stopHeartbeat();
  sendHeartbeat();
  HEARTBEAT_TIMER = setInterval(sendHeartbeat, 30000);
}
function stopHeartbeat(){
  if(HEARTBEAT_TIMER){ clearInterval(HEARTBEAT_TIMER); HEARTBEAT_TIMER = null; }
}
function sendHeartbeat(){
  if(!CURRENT_USER) return;
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        apiPost('heartbeat', { userId: CURRENT_USER.id, lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(()=>{});
      },
      () => {
        // permission denied or unavailable — still mark the user as active, just without a location
        apiPost('heartbeat', { userId: CURRENT_USER.id }).catch(()=>{});
      },
      { maximumAge: 20000, timeout: 8000 }
    );
  } else {
    apiPost('heartbeat', { userId: CURRENT_USER.id }).catch(()=>{});
  }
}

/* ===================== NOTIFICATIONS ===================== */
async function refreshNotifications(){
  if(!CURRENT_USER) return;
  try{
    const res = await apiGet('list_notifications', { userId: CURRENT_USER.id });
    const newList = res.notifications || [];
    // Beep only for genuinely NEW task-assignment notifications that arrived
    // since the last check — never for whatever was already sitting there
    // when the page loaded (that would fire a beep, or several, on every
    // single login for old unread items).
    if(SEEN_NOTIF_IDS !== null){
      const isNewAssignment = n => !SEEN_NOTIF_IDS.has(n.id) && n.message.startsWith('New task assigned:');
      if(newList.some(isNewAssignment)) playAssignmentBeep();
    }
    NOTIFICATIONS = newList;
    SEEN_NOTIF_IDS = new Set(newList.map(n=>n.id));
    renderBellBadge();
    if(document.getElementById('notifPanel').style.display === 'block') renderNotifPanel();
  }catch(e){ /* non-fatal */ }
}
function startNotifPolling(){
  stopNotifPolling();
  NOTIF_POLL_TIMER = setInterval(refreshNotifications, 15000);
}
function stopNotifPolling(){
  if(NOTIF_POLL_TIMER){ clearInterval(NOTIF_POLL_TIMER); NOTIF_POLL_TIMER = null; }
  SEEN_NOTIF_IDS = null; // re-establish a fresh baseline on next login, don't carry state between sessions
}
function playAssignmentBeep(){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq, startAt, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + dur + 0.02);
    };
    tone(880, 0, 0.28);     // A5
    tone(1175, 0.16, 0.28); // D6 -- short two-note "ding-ding", no audio file needed
    setTimeout(()=>{ try{ ctx.close(); }catch(e){} }, 700);
  }catch(e){ /* audio blocked/unavailable — never let this break anything else */ }
}
function renderBellBadge(){
  const unread = NOTIFICATIONS.filter(n=>!n.isRead).length;
  const badge = document.getElementById('bellBadge');
  if(unread > 0){ badge.style.display = 'inline-block'; badge.textContent = unread > 9 ? '9+' : unread; }
  else { badge.style.display = 'none'; }
}
function toggleNotifPanel(){
  const panel = document.getElementById('notifPanel');
  const show = panel.style.display === 'none';
  panel.style.display = show ? 'block' : 'none';
  if(show) renderNotifPanel();
}
function renderNotifPanel(){
  const panel = document.getElementById('notifPanel');
  let html = `<div class="notif-panel-head"><span>Notifications</span><button class="log-link" onclick="markAllNotifsRead()">mark all read</button></div>`;
  if(!NOTIFICATIONS.length){
    html += `<div class="notif-item" style="color:var(--muted);">Nothing yet.</div>`;
  } else {
    html += NOTIFICATIONS.map(n => `
      <div class="notif-item ${n.isRead?'':'unread'}" onclick="markNotifRead('${n.id}')" style="cursor:pointer;">
        <div>${escapeHtml(n.message)}</div>
        <div class="ts mono">${fmtDateTime(n.createdAt)}</div>
      </div>
    `).join('');
  }
  panel.innerHTML = html;
}
async function markNotifRead(id){
  const n = NOTIFICATIONS.find(x=>x.id===id);
  if(n && !n.isRead){
    n.isRead = true;
    renderBellBadge();
    renderNotifPanel();
    try{ await apiPost('mark_notification_read', { notificationId: id, userId: CURRENT_USER.id }); }catch(e){}
  }
}
async function markAllNotifsRead(){
  NOTIFICATIONS.forEach(n=>n.isRead=true);
  renderBellBadge();
  renderNotifPanel();
  try{ await apiPost('mark_all_notifications_read', { userId: CURRENT_USER.id }); }catch(e){}
}

/* ===================== TABS ===================== */
function setTab(tab){
  ACTIVE_TAB = tab;
  OPEN_UPDATE_FORM = null;
  EDIT_TASK_ID = null;
  EDIT_UPDATE_ID = null;
  EDIT_STATUS_ID = null;
  SHOW_ADD_STATUS = false;
  EDIT_EMP_ID = null;
  SHOW_ADD_EMP = false;
  SHOW_ADD_DEPT = false;
  ADD_SUBDEPT_FOR = null;
  COMMENT_FOR_ID = null;
  VIEW_TASKS_FOR_ID = null;
  MARK_COMPLETE_FOR_ID = null;
  PENDING_COMPLETE_STATUS_ID = null;
  document.getElementById('notifPanel').style.display = 'none';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab));
  render();

  // The Live Status table (Online/Offline dots, "Online now" count) is only ever
  // as fresh as the last bootstrap fetch — with no polling it just shows a frozen
  // snapshot from whenever the page/tab was loaded, so it drifts to "Offline" for
  // everyone even while employees are actively online. Poll while this tab is open.
  if(LIVESTATUS_TIMER){ clearInterval(LIVESTATUS_TIMER); LIVESTATUS_TIMER = null; }
  if(tab === 'livestatus'){
    LIVESTATUS_TIMER = setInterval(()=>{
      if(ACTIVE_TAB === 'livestatus') refreshAndRender();
      else { clearInterval(LIVESTATUS_TIMER); LIVESTATUS_TIMER = null; }
    }, 15000);
  }
}

function render(){
  const main = document.getElementById('mainContent');
  if(ACTIVE_TAB === 'dashboard') main.innerHTML = renderDashboard();
  else if(ACTIVE_TAB === 'mine') main.innerHTML = renderMyBoard();
  else if(ACTIVE_TAB === 'byme') main.innerHTML = renderAssignedByMe();
  else if(ACTIVE_TAB === 'team') main.innerHTML = renderTeamBoard();
  else if(ACTIVE_TAB === 'statuses') main.innerHTML = renderStatuses();
  else if(ACTIVE_TAB === 'new') main.innerHTML = renderNewEntry();
  else if(ACTIVE_TAB === 'attendance') main.innerHTML = renderAttendance();
  else if(ACTIVE_TAB === 'employees') main.innerHTML = renderEmployees();
  else if(ACTIVE_TAB === 'departments') main.innerHTML = renderDepartments();
  else if(ACTIVE_TAB === 'livestatus') main.innerHTML = renderLiveStatus();
  else if(ACTIVE_TAB === 'reports') main.innerHTML = renderReports();
  else if(ACTIVE_TAB === 'reporthistory') renderReportHistoryAsync();
}

/* ===================== DASHBOARD ===================== */
function buildActivityFeed(limit, taskPool){
  const feed = [];
  (taskPool || TASKS).forEach(t=>{
    (t.updates||[]).forEach(u=>{
      feed.push({ date: u.date, taskId: t.id, taskTitle: t.title, byUserId: u.byUserId, progressPct: u.progressPct, note: u.note });
    });
  });
  feed.sort((a,b)=> new Date(b.date.replace(' ','T')) - new Date(a.date.replace(' ','T')));
  return feed.slice(0, limit);
}

function renderDashboard(){
  const myTasks = TASKS.filter(t=>t.assignedTo === CURRENT_USER.id);
  const myOpen = myTasks.filter(t=>!isTaskDone(t));
  const myOverdue = myTasks.filter(isOverdue);
  const canSeeTeam = canSeeTeamBoard(CURRENT_USER);
  const scopeIds = visibleTeamUserIds(CURRENT_USER);
  // For a plain employee scopeIds is just [self], so "team" tasks would be
  // a redundant copy of "my" tasks — only compute/show that block for
  // roles that actually oversee other people.
  const teamTasks = canSeeTeam ? TASKS.filter(t=>scopeIds.includes(t.assignedTo)) : [];
  const teamOpen = teamTasks.filter(t=>!isTaskDone(t));
  const teamOverdue = teamTasks.filter(isOverdue);
  const teamEffs = teamTasks.filter(isTaskDone).map(efficiencyPct).filter(v=>v!==null);
  const teamAvgEff = teamEffs.length ? Math.round(teamEffs.reduce((a,b)=>a+b,0)/teamEffs.length) : null;

  let html = `
    <div class="section-head"><h2>Dashboard</h2><span class="count">Hi, ${escapeHtml(CURRENT_USER.name)}</span></div>
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${myOpen.length}</div><div class="lbl">My open tasks</div></div>
      <div class="stat-box"><div class="num" style="color:${myOverdue.length?'var(--rust)':'var(--amber)'}">${myOverdue.length}</div><div class="lbl">My overdue</div></div>
      ${canSeeTeam ? `
      <div class="stat-box"><div class="num">${teamOpen.length}</div><div class="lbl">Team open</div></div>
      <div class="stat-box"><div class="num" style="color:${teamOverdue.length?'var(--rust)':'var(--amber)'}">${teamOverdue.length}</div><div class="lbl">Team overdue</div></div>
      <div class="stat-box"><div class="num" style="color:${effColor(teamAvgEff)}">${teamAvgEff===null?'—':teamAvgEff+'%'}</div><div class="lbl">Team efficiency</div></div>
      ` : ''}
    </div>
  `;

  // Status distribution — scoped to what this person can see (their own
  // task only, unless they oversee a team).
  const statusPool = canSeeTeam ? teamTasks : myTasks;
  html += `<div class="section-head" style="margin-top:8px;"><h2 style="font-size:18px;">By Status</h2></div>`;
  const activeTasks = statusPool.filter(t=>!isTaskDone(t));
  const maxCount = Math.max(1, ...STATUSES.map(s=>activeTasks.filter(t=>t.status===s.id).length));
  const donutSegments = STATUSES.filter(s=>!s.isDone).map(s=>({ value: activeTasks.filter(t=>t.status===s.id).length, color: s.color }));
  const hasActive = donutSegments.some(s=>s.value>0);
  const statusRows = STATUSES.filter(s=>!s.isDone).map(s=>{
    const count = activeTasks.filter(t=>t.status===s.id).length;
    if(!count) return '';
    const pct = Math.round((count/maxCount)*100);
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <span class="swatch" style="background:${s.color};flex-shrink:0;"></span>
        <span style="font-size:13px;min-width:130px;">${escapeHtml(s.name)}</span>
        <div class="mini-bar-track" style="flex:1;max-width:none;"><div class="mini-bar-fill" style="width:${pct}%;background:${s.color};"></div></div>
        <span class="mono" style="font-size:12px;color:var(--muted);min-width:20px;text-align:right;">${count}</span>
      </div>
    `;
  }).join('');
  if(hasActive){
    html += `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
      <div style="flex-shrink:0;">${svgDonut(donutSegments)}</div>
      <div style="flex:1;min-width:200px;">${statusRows}</div>
    </div>`;
  } else {
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NOTHING ACTIVE —</div>No open tasks right now.</div>`;
  }

  // Recent activity — same scope as status distribution above.
  html += `<div class="section-head" style="margin-top:22px;"><h2 style="font-size:18px;">Recent Activity</h2></div>`;
  const feed = buildActivityFeed(8, statusPool);
  if(!feed.length){
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— QUIET —</div>No updates logged yet.</div>`;
  } else {
    html += `<div class="log-list" style="border-top:none;margin-top:0;padding-top:0;">` + feed.map(f=>`
      <div class="log-entry" style="padding:6px 0;">
        <span class="ts mono">${fmtDateTime(f.date)}</span>
        <span style="flex:1;"><b style="color:var(--text);">${escapeHtml(userName(f.byUserId))}</b> logged ${f.progressPct}% on <b style="color:var(--text);">${escapeHtml(f.taskTitle)}</b>${f.note?' — '+escapeHtml(f.note):''}</span>
      </div>
    `).join('') + `</div>`;
  }

  // Needs attention (overdue/stale), capped — same scope.
  const attention = statusPool.filter(t=>!isTaskDone(t) && (isOverdue(t) || isStale(t))).slice(0, 5);
  if(attention.length){
    html += `<div class="section-head" style="margin-top:22px;"><h2 style="font-size:18px;">Needs Attention</h2>${canSeeTeam?'<span class="count">see Team Board for all</span>':''}</div>`;
    attention.forEach(t=>{ html += taskCard(t, false); });
  }

  return html;
}

/* ===================== MY BOARD ===================== */
function renderMyBoard(){
  const mine = TASKS.filter(t=>t.assignedTo === CURRENT_USER.id)
    .sort((a,b)=>{
      const rank = t => isTaskDone(t) ? 2 : (isOverdue(t) ? 0 : 1);
      return rank(a)-rank(b) || new Date(a.dueDate||'2999-12-31') - new Date(b.dueDate||'2999-12-31');
    });
  const open = mine.filter(t=>!isTaskDone(t));
  const done = mine.filter(t=>isTaskDone(t));
  const avgEff = (()=>{
    const effs = done.map(efficiencyPct).filter(v=>v!==null);
    if(!effs.length) return null;
    return Math.round(effs.reduce((a,b)=>a+b,0)/effs.length);
  })();

  let html = `
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${open.length}</div><div class="lbl">Open tasks</div></div>
      <div class="stat-box"><div class="num">${done.length}</div><div class="lbl">Completed</div></div>
      <div class="stat-box"><div class="num" style="color:${effColor(avgEff)}">${avgEff===null?'—':avgEff+'%'}</div><div class="lbl">Avg efficiency</div></div>
    </div>
    <div class="section-head"><h2>My Board</h2><span class="count">${mine.length} total</span></div>
  `;

  if(!mine.length){
    html += `<div class="empty"><div class="em-mark">— NO ENTRIES —</div>Nothing assigned to you yet. Log a new entry to get started.</div>`;
    return html;
  }
  mine.forEach(t=>{ html += taskCard(t, true); });
  return html;
}

/* ===================== ASSIGNED BY ME ===================== */
function renderAssignedByMe(){
  const givenOut = TASKS.filter(t=>t.assignedBy === CURRENT_USER.id && t.assignedTo !== CURRENT_USER.id)
    .sort((a,b)=>{
      const rank = t => isTaskDone(t) ? 2 : (isOverdue(t) ? 0 : 1);
      return rank(a)-rank(b) || new Date(a.dueDate||'2999-12-31') - new Date(b.dueDate||'2999-12-31');
    });
  const open = givenOut.filter(t=>!isTaskDone(t));
  const overdue = givenOut.filter(isOverdue);

  let html = `
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${givenOut.length}</div><div class="lbl">Handed out</div></div>
      <div class="stat-box"><div class="num">${open.length}</div><div class="lbl">Still open</div></div>
      <div class="stat-box"><div class="num" style="color:${overdue.length?'var(--rust)':'var(--text)'}">${overdue.length}</div><div class="lbl">Overdue</div></div>
    </div>
    <div class="section-head"><h2>Assigned by Me</h2><span class="count">${givenOut.length} total</span></div>
  `;

  if(!givenOut.length){
    html += `<div class="empty"><div class="em-mark">— NOTHING HANDED OUT —</div>Tasks you assign to someone else will show up here so you can track them.</div>`;
    return html;
  }
  givenOut.forEach(t=>{ html += taskCard(t, false); });
  return html;
}

/* ===================== TASK CARD ===================== */
function taskCard(t, showActions){
  const overdue = isOverdue(t);
  const stale = isStale(t);
  const progress = latestProgress(t);
  const eff = efficiencyPct(t);
  const st = statusById(t.status);
  const ups = (t.updates||[]).slice().reverse();
  const isAssigner = CURRENT_USER.id === t.assignedBy;
  const canChangeStatus = CURRENT_USER.id === t.assignedTo || CURRENT_USER.id === t.assignedBy;

  const statusOptions = STATUSES.map(s=>`<option value="${s.id}" ${s.id===t.status?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  let badges = canChangeStatus
    ? `<select class="status-select" style="background:${hexToRgba(st.color,0.16)};color:${st.color};border-color:${hexToRgba(st.color,0.4)};" onchange="changeTaskStatus('${t.id}', this.value)">${statusOptions}</select>`
    : `<span class="badge" style="background:${hexToRgba(st.color,0.16)};color:${st.color};"><span class="swatch" style="background:${st.color};"></span> ${escapeHtml(st.name)}</span>`;
  if(overdue) badges += `<span class="badge overdue">Overdue</span>`;
  if(stale && !overdue) badges += `<span class="badge stale">Needs update</span>`;
  if(t.repeatType && t.repeatType !== 'none'){
    const label = t.repeatType.charAt(0).toUpperCase() + t.repeatType.slice(1);
    badges += `<span class="badge" style="background:rgba(124,58,237,0.16);color:#7C3AED;">\u{1F501} ${label}</span>`;
  }

  const gauge = isTaskDone(t) ? gaugeSVG(eff) : '';

  let actions = '';
  if(showActions && !isTaskDone(t)){
    const loggedHrs = totalHoursLogged(t);
    const renewBtn = (t.repeatType && t.repeatType !== 'none')
      ? `<button class="btn-sm" onclick="submitRenewTask('${t.id}')" title="Generate the next occurrence now without marking this one complete">Renew</button>` : '';
    actions += `
      <div class="task-actions">
        <button class="btn-sm primary" onclick="toggleUpdateForm('${t.id}')">Log update</button>
        <button class="btn-sm done" onclick="toggleMarkCompleteForm('${t.id}')">Mark complete</button>
        ${renewBtn}
        ${isAssigner ? `<button class="btn-sm" onclick="toggleEditTask('${t.id}')">Edit</button>
        <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);" onclick="deleteTaskConfirm('${t.id}')">Delete</button>` : ''}
      </div>
      <div class="update-form ${OPEN_UPDATE_FORM===t.id?'show':''}" id="form-${t.id}">
        <div class="form-row">
          <div>
            <span class="field-label">Progress %</span>
            <input type="number" min="0" max="100" id="progress-${t.id}" value="${progress}">
          </div>
          <div>
            <span class="field-label">Hours logged today</span>
            <input type="number" min="0" step="0.5" id="hours-${t.id}" value="">
          </div>
        </div>
        <div class="form-row">
          <div>
            <span class="field-label">Note</span>
            <textarea id="note-${t.id}" placeholder="What got done, what's blocking…"></textarea>
          </div>
        </div>
        <button class="btn-sm primary" onclick="submitUpdate('${t.id}')">Save update</button>
      </div>
      <div class="update-form ${MARK_COMPLETE_FOR_ID===t.id?'show':''}" id="complete-form-${t.id}">
        <p style="font-size:12px;color:var(--muted);margin:0 0 10px;">To calculate efficiency, this needs an estimate and the actual hours it took.</p>
        <div class="form-row">
          ${!t.estimatedHours ? `
          <div>
            <span class="field-label">Estimated hours (this task had none)</span>
            <input type="number" min="0" step="0.5" id="complete-est-${t.id}" placeholder="e.g. 4">
          </div>` : ''}
          <div>
            <span class="field-label">Actual hours spent</span>
            <input type="number" min="0" step="0.5" id="complete-actual-${t.id}" value="${loggedHrs > 0 ? loggedHrs : ''}" placeholder="e.g. 5">
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm done" onclick="submitMarkComplete('${t.id}')">Confirm complete</button>
          <button class="btn-sm" onclick="toggleMarkCompleteForm('${t.id}')">Cancel</button>
        </div>
      </div>
    `;
  } else if(isAssigner){
    actions += `
      <div class="task-actions">
        <button class="btn-sm" onclick="toggleEditTask('${t.id}')">Edit</button>
        <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);" onclick="deleteTaskConfirm('${t.id}')">Delete</button>
      </div>
    `;
  }

  if(isAssigner){
    const options = USERS.map(u=>`<option value="${u.id}" ${u.id===t.assignedTo?'selected':''}>${escapeHtml(u.name)}</option>`).join('');
    actions += `
      <div class="update-form ${EDIT_TASK_ID===t.id?'show':''}" id="edit-${t.id}">
        <div class="form-row">
          <div>
            <span class="field-label">Task title</span>
            <input type="text" id="et-title-${t.id}" value="${escapeHtml(t.title)}">
          </div>
        </div>
        <div class="form-row">
          <div>
            <span class="field-label">Description</span>
            <textarea id="et-desc-${t.id}">${escapeHtml(t.description||'')}</textarea>
          </div>
        </div>
        <div class="form-row">
          <div>
            <span class="field-label">Reassign to</span>
            <select id="et-assignee-${t.id}">${options}</select>
          </div>
          <div>
            <span class="field-label">Due date</span>
            <input type="date" id="et-due-${t.id}" value="${t.dueDate||''}">
          </div>
        </div>
        <div class="form-row">
          <div>
            <span class="field-label">Estimated hours</span>
            <input type="number" min="0" step="0.5" id="et-est-${t.id}" value="${t.estimatedHours||''}">
          </div>
        </div>
        <div class="form-row">
          <div>
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;">
              <input type="checkbox" id="et-repeat-on-${t.id}" ${t.repeatType && t.repeatType!=='none' ? 'checked' : ''} onchange="toggleEditRepeatFields('${t.id}')"> Repeated work
            </label>
          </div>
        </div>
        <div id="et-repeat-fields-${t.id}" style="display:${t.repeatType && t.repeatType!=='none' ? '' : 'none'};">
          <div class="form-row">
            <div>
              <span class="field-label">Work Type</span>
              <select id="et-repeat-type-${t.id}">
                <option value="daily" ${t.repeatType==='daily'?'selected':''}>Daily</option>
                <option value="weekly" ${!t.repeatType || t.repeatType==='weekly'?'selected':''}>Weekly</option>
                <option value="monthly" ${t.repeatType==='monthly'?'selected':''}>Monthly</option>
              </select>
            </div>
            <div>
              <span class="field-label">New Start Date</span>
              <input type="date" id="et-repeat-start-${t.id}" placeholder="leave blank to keep current due date">
            </div>
          </div>
          <p style="font-size:11px;color:var(--muted);margin:-4px 0 12px;">Leave Start Date blank to keep this task's current due date and only change Work Type for future renewals.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm primary" onclick="submitEditTask('${t.id}')">Save changes</button>
          <button class="btn-sm" onclick="toggleEditTask('${t.id}')">Cancel</button>
        </div>
      </div>
    `;
  }

  let logList = '';
  if(ups.length){
    logList = `<div class="log-list">` + ups.slice(0,4).map(u=>renderLogEntry(t,u)).join('') + `</div>`;
  }

  return `
    <div class="task">
      <div class="task-top">
        <div style="flex:1;min-width:0;">
          <div class="task-title">${escapeHtml(t.title)}</div>
          <div class="task-meta">
            ${badges}
            <span class="sep">·</span>
            <span>Assigned to <b style="color:var(--text)">${escapeHtml(userName(t.assignedTo))}</b></span>
            ${t.assignedBy !== t.assignedTo ? `<span class="sep">·</span><span>by ${escapeHtml(userName(t.assignedBy))}</span>` : ''}
            <span class="sep">·</span>
            <span class="mono">Due ${fmtDate(t.dueDate)}</span>
            ${t.estimatedHours? `<span class="sep">·</span><span class="mono">Est ${t.estimatedHours}h</span>`:''}
          </div>
        </div>
        ${gauge}
      </div>
      ${t.description ? `<div style="font-size:13px;color:var(--muted);margin-top:8px;">${escapeHtml(t.description)}</div>` : ''}
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%;background:${isTaskDone(t)?'var(--teal)':'var(--amber)'}"></div></div>
      ${actions}
      ${logList}
    </div>
  `;
}

function renderLogEntry(t, u){
  const mine = u.byUserId === CURRENT_USER.id;
  if(EDIT_UPDATE_ID === u.id){
    return `<div class="log-entry-edit">
      <div class="form-row">
        <div>
          <span class="field-label">Progress %</span>
          <input type="number" min="0" max="100" id="eu-progress-${u.id}" value="${u.progressPct}">
        </div>
        <div>
          <span class="field-label">Hours</span>
          <input type="number" min="0" step="0.5" id="eu-hours-${u.id}" value="${u.hoursLogged||''}">
        </div>
      </div>
      <div class="form-row">
        <div>
          <span class="field-label">Note</span>
          <textarea id="eu-note-${u.id}">${escapeHtml(u.note||'')}</textarea>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm primary" onclick="submitEditUpdate('${u.id}')">Save</button>
        <button class="btn-sm" onclick="cancelEditUpdate()">Cancel</button>
      </div>
    </div>`;
  }
  return `<div class="log-entry">
    <span class="ts mono">${fmtDateTime(u.date)}</span>
    <span style="flex:1;">${u.progressPct}% · ${userName(u.byUserId)}${u.hoursLogged?` · ${u.hoursLogged}h`:''}${u.note?' — '+escapeHtml(u.note):''}</span>
    ${mine ? `<span style="flex-shrink:0;display:flex;gap:8px;">
      <button class="log-link" onclick="toggleEditUpdate('${u.id}')">edit</button>
      <button class="log-link danger" onclick="deleteUpdateConfirm('${u.id}')">del</button>
    </span>` : ''}
  </div>`;
}

function toggleUpdateForm(id){
  OPEN_UPDATE_FORM = OPEN_UPDATE_FORM === id ? null : id;
  render();
}

async function submitUpdate(id){
  const t = TASKS.find(x=>x.id===id);
  if(!t) return;
  const progress = Math.max(0, Math.min(100, Number(document.getElementById('progress-'+id).value) || 0));
  const hours = Number(document.getElementById('hours-'+id).value) || 0;
  const note = document.getElementById('note-'+id).value.trim();
  try{
    const res = await apiPost('add_update', {
      taskId: id, progressPct: progress, hoursLogged: hours || null, note: note || null, byUserId: CURRENT_USER.id
    });
    t.updates = t.updates || [];
    t.updates.push({ id: res.id, date: res.date, progressPct: progress, hoursLogged: hours || null, note, byUserId: CURRENT_USER.id });
    OPEN_UPDATE_FORM = null;
    showToast('Update logged');
    render();
  }catch(e){
    showToast('Could not save update', true);
  }
}

let MARK_COMPLETE_FOR_ID = null;
let PENDING_COMPLETE_STATUS_ID = null;
function toggleMarkCompleteForm(id, statusId){
  if(MARK_COMPLETE_FOR_ID === id){ MARK_COMPLETE_FOR_ID = null; PENDING_COMPLETE_STATUS_ID = null; render(); return; }
  MARK_COMPLETE_FOR_ID = id;
  PENDING_COMPLETE_STATUS_ID = statusId || null; // null = let the backend pick the default done-status
  render();
}
async function submitMarkComplete(id){
  const t = TASKS.find(x=>x.id===id);
  if(!t) return;
  const estInput = document.getElementById('complete-est-'+id);
  const estimatedHours = estInput ? Number(estInput.value) || null : null;
  if(!t.estimatedHours && !estimatedHours){
    showToast('Enter an estimate so efficiency can be calculated', true);
    return;
  }
  const actualInput = document.getElementById('complete-actual-'+id);
  const actualHours = Number(actualInput.value) || null;
  if(!actualHours){
    showToast('Enter the actual hours spent', true);
    return;
  }
  try{
    let res;
    if(PENDING_COMPLETE_STATUS_ID){
      res = await apiPost('update_task_status', { taskId: id, statusId: PENDING_COMPLETE_STATUS_ID, requestingUserId: CURRENT_USER.id, estimatedHours, actualHours });
      t.status = PENDING_COMPLETE_STATUS_ID;
    } else {
      res = await apiPost('mark_complete', { taskId: id, estimatedHours, actualHours });
      t.status = res.statusId || t.status;
    }
    t.completedAt = res.completedAt;
    t.actualHours = res.actualHours;
    if(res.estimatedHours !== undefined && res.estimatedHours !== null) t.estimatedHours = res.estimatedHours;
    MARK_COMPLETE_FOR_ID = null;
    PENDING_COMPLETE_STATUS_ID = null;
    if(res.nextOccurrenceId){
      showToast('Task marked complete \u2014 next occurrence created');
      await refreshAndRender(); // pulls in the freshly-generated repeat occurrence
    } else {
      showToast('Task marked complete');
      render();
    }
  }catch(e){
    showToast(e.message || 'Could not update task', true);
  }
}

async function submitRenewTask(id){
  try{
    const res = await apiPost('renew_task', { taskId: id, requestingUserId: CURRENT_USER.id });
    showToast('Renewed \u2014 next occurrence due ' + (res.dueDate || ''));
    await refreshAndRender();
  }catch(e){
    showToast(e.message || 'Could not renew task', true);
  }
}

async function changeTaskStatus(taskId, statusId){
  const t = TASKS.find(x=>x.id===taskId);
  if(!t) return;
  const targetStatus = statusById(statusId);
  if(targetStatus.isDone){
    // Moving into ANY done-status (via the dropdown, not just the "Mark
    // complete" button) needs the same hours confirmation, or efficiency
    // silently stays blank -- this re-renders with the current status still
    // selected until the form is confirmed, so nothing changes yet.
    toggleMarkCompleteForm(taskId, statusId);
    return;
  }
  const prevStatus = t.status;
  try{
    const res = await apiPost('update_task_status', { taskId, statusId, requestingUserId: CURRENT_USER.id });
    t.status = statusId;
    t.completedAt = res.completedAt;
    t.actualHours = res.actualHours;
    showToast('Status updated');
    render();
  }catch(e){
    t.status = prevStatus;
    showToast(e.message || 'Could not change status', true);
    render();
  }
}

function toggleEditTask(id){
  EDIT_TASK_ID = EDIT_TASK_ID === id ? null : id;
  render();
}

function toggleEditRepeatFields(id){
  const on = document.getElementById('et-repeat-on-'+id).checked;
  document.getElementById('et-repeat-fields-'+id).style.display = on ? '' : 'none';
}

async function submitEditTask(id){
  const title = document.getElementById('et-title-'+id).value.trim();
  if(!title){ showToast('Title required'); return; }
  const desc = document.getElementById('et-desc-'+id).value.trim();
  const assignedTo = document.getElementById('et-assignee-'+id).value;
  const due = document.getElementById('et-due-'+id).value;
  const est = Number(document.getElementById('et-est-'+id).value) || null;

  const repeatOn = document.getElementById('et-repeat-on-'+id).checked;
  const payload = {
    taskId: id, requestingUserId: CURRENT_USER.id, title, description: desc || null,
    assignedTo, dueDate: due || null, estimatedHours: est
  };
  if(repeatOn){
    payload.repeatType = document.getElementById('et-repeat-type-'+id).value;
    const newStart = document.getElementById('et-repeat-start-'+id).value;
    if(newStart) payload.startDate = newStart; // omitted entirely otherwise: server keeps the existing due date unchanged
  } else {
    payload.repeatType = 'none';
  }

  try{
    await apiPost('update_task', payload);
    EDIT_TASK_ID = null;
    showToast('Task updated');
    await refreshAndRender();
  }catch(e){
    showToast(e.message || 'Could not update task', true);
  }
}

async function deleteTaskConfirm(id){
  if(!confirm('Delete this task and its whole update history? This cannot be undone.')) return;
  try{
    await apiPost('delete_task', { taskId: id, requestingUserId: CURRENT_USER.id });
    showToast('Task deleted');
    await refreshAndRender();
  }catch(e){
    showToast(e.message || 'Could not delete task', true);
  }
}

function toggleEditUpdate(id){
  EDIT_UPDATE_ID = EDIT_UPDATE_ID === id ? null : id;
  render();
}
function cancelEditUpdate(){
  EDIT_UPDATE_ID = null;
  render();
}

async function submitEditUpdate(updateId){
  const progress = Math.max(0, Math.min(100, Number(document.getElementById('eu-progress-'+updateId).value) || 0));
  const hours = Number(document.getElementById('eu-hours-'+updateId).value) || null;
  const note = document.getElementById('eu-note-'+updateId).value.trim();
  try{
    await apiPost('edit_update', {
      updateId, requestingUserId: CURRENT_USER.id, progressPct: progress, hoursLogged: hours, note: note || null
    });
    EDIT_UPDATE_ID = null;
    showToast('Update edited');
    await refreshAndRender();
  }catch(e){
    showToast(e.message || 'Could not edit update', true);
  }
}

async function deleteUpdateConfirm(updateId){
  if(!confirm('Delete this update entry?')) return;
  try{
    await apiPost('delete_update', { updateId, requestingUserId: CURRENT_USER.id });
    showToast('Update deleted');
    await refreshAndRender();
  }catch(e){
    showToast(e.message || 'Could not delete update', true);
  }
}

/* ===================== TEAM BOARD ===================== */
/* Who a given user is allowed to SEE on Team Board / Attendance's team view —
   separate from assignableUsersFor() (who they can assign TO). A dept head
   sees their whole department (sub-heads and employees); a sub head sees
   only their own sub-department; a plain employee sees no one but themselves
   here (their own data lives on Dashboard / Assigned to Me instead). */
function visibleTeamUserIds(user){
  if(user.isAdmin) return USERS.map(u=>u.id);
  if(user.orgRole === 'dept_head'){
    return USERS.filter(u => user.departmentId && u.departmentId===user.departmentId).map(u=>u.id);
  }
  if(user.orgRole === 'sub_head'){
    return USERS.filter(u => user.subDepartmentId && u.subDepartmentId===user.subDepartmentId).map(u=>u.id);
  }
  return [user.id];
}
function canSeeTeamBoard(user){
  return user.isAdmin || user.orgRole==='dept_head' || user.orgRole==='sub_head';
}

function renderTeamBoard(){
  const scopeIds = visibleTeamUserIds(CURRENT_USER);
  const scopedUsers = USERS.filter(u=>scopeIds.includes(u.id));
  const scopedTasks = TASKS.filter(t=>scopeIds.includes(t.assignedTo));

  const totalOpen = scopedTasks.filter(t=>!isTaskDone(t)).length;
  const totalOverdue = scopedTasks.filter(isOverdue).length;
  const allEffs = scopedTasks.filter(t=>isTaskDone(t)).map(efficiencyPct).filter(v=>v!==null);
  const teamAvgEff = allEffs.length ? Math.round(allEffs.reduce((a,b)=>a+b,0)/allEffs.length) : null;

  let html = `
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${scopedTasks.length}</div><div class="lbl">Total tasks</div></div>
      <div class="stat-box"><div class="num">${totalOpen}</div><div class="lbl">Open</div></div>
      <div class="stat-box"><div class="num" style="color:var(--rust)">${totalOverdue}</div><div class="lbl">Overdue</div></div>
      <div class="stat-box"><div class="num" style="color:${effColor(teamAvgEff)}">${teamAvgEff===null?'—':teamAvgEff+'%'}</div><div class="lbl">Team efficiency</div></div>
    </div>
    <div class="section-head"><h2>Team Board</h2>
      <div style="display:flex;align-items:center;gap:10px;">
        ${CURRENT_USER.isAdmin ? `<button class="btn-sm" onclick="sendTeamSummary()">Email Summary</button>
        <button class="btn-sm" onclick="shareTeamSummaryWhatsApp()">Share via WhatsApp</button>` : ''}
        <span class="count">${scopedUsers.length} people</span>
      </div>
    </div>
  `;

  if(!scopedUsers.length){
    html += `<div class="empty"><div class="em-mark">— NO ROSTER —</div>No one's clocked in yet.</div>`;
    return html;
  }

  const rosterEmpOptions = `<option value="all">All employees</option>` + scopedUsers
    .slice().sort((a,b)=>a.name.localeCompare(b.name))
    .map(u=>`<option value="${u.id}" ${TEAMBOARD_ROSTER_FILTER===u.id?'selected':''}>${escapeHtml(u.name)}</option>`).join('');
  html += `
    <div class="form-row" style="margin-bottom:10px;">
      <div>
        <span class="field-label">Filter employee</span>
        <select onchange="setTeamBoardRosterFilter(this.value)">${rosterEmpOptions}</select>
      </div>
    </div>
  `;
  const displayedUsers = TEAMBOARD_ROSTER_FILTER === 'all'
    ? scopedUsers
    : scopedUsers.filter(u=>u.id===TEAMBOARD_ROSTER_FILTER);

  html += `<div style="overflow-x:auto;"><table class="roster-table"><thead><tr>
    <th>Name</th><th>Open</th><th>Overdue</th><th>Completed</th><th>Efficiency</th><th>Actions</th>
  </tr></thead><tbody>`;

  if(!displayedUsers.length){
    html += `</tbody></table></div><div class="empty" style="padding:24px;"><div class="em-mark">— NO MATCH —</div>That employee isn't in your visible roster.</div>`;
    return html;
  }

  displayedUsers.forEach(u=>{
    const userTasks = scopedTasks.filter(t=>t.assignedTo===u.id);
    const openCount = userTasks.filter(t=>!isTaskDone(t)).length;
    const overdueCount = userTasks.filter(isOverdue).length;
    const doneTasks = userTasks.filter(t=>isTaskDone(t));
    const effs = doneTasks.map(efficiencyPct).filter(v=>v!==null);
    const avg = effs.length ? Math.round(effs.reduce((a,b)=>a+b,0)/effs.length) : null;
    const barPct = avg===null ? 0 : Math.min(avg,100);
    html += `<tr>
      <td class="name-cell">${escapeHtml(u.name)}</td>
      <td class="mono">${openCount}</td>
      <td class="mono" style="color:${overdueCount?'var(--rust)':'var(--muted)'}">${overdueCount}</td>
      <td class="mono">${doneTasks.length}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${barPct}%;background:${effColor(avg)};"></div></div>
          <span class="mono" style="font-size:12px;color:${effColor(avg)};">${avg===null?'—':avg+'%'}</span>
        </div>
      </td>
      <td style="white-space:nowrap;">
        <button class="btn-sm" onclick="viewEmployeeTasks('${u.id}')">${VIEW_TASKS_FOR_ID===u.id?'Hide':'View'}</button>
        <button class="btn-sm" onclick="assignToEmployee('${u.id}')">Assign</button>
        <button class="btn-sm" onclick="toggleCommentRow('${u.id}')">Comment</button>
      </td>
    </tr>`;
    if(VIEW_TASKS_FOR_ID === u.id){
      const sorted = userTasks.slice().sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
      html += `<tr><td colspan="6" style="background:var(--panel-2);padding:12px;">`;
      if(!sorted.length){
        html += `<div class="empty" style="padding:16px;"><div class="em-mark">— NO TASKS —</div>Nothing assigned to ${escapeHtml(u.name)} yet.</div>`;
      } else {
        sorted.forEach(t=>{ html += taskCard(t, false); });
      }
      html += `</td></tr>`;
    }
    if(COMMENT_FOR_ID === u.id){
      html += `<tr><td colspan="6" style="background:var(--panel-2);padding:12px;">
        <span class="field-label">Note for ${escapeHtml(u.name)}</span>
        <textarea id="comment-text-${u.id}" placeholder="Write a note — it'll show up in their notifications…" style="width:100%;margin-top:4px;"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn-sm primary" onclick="submitComment('${u.id}')">Send</button>
          <button class="btn-sm" onclick="toggleCommentRow('${u.id}')">Cancel</button>
        </div>
      </td></tr>`;
    }
  });
  html += `</tbody></table></div>`;

  const attention = scopedTasks.filter(t=>!isTaskDone(t) && (isOverdue(t) || isStale(t)));
  if(attention.length){
    html += `<div class="section-head" style="margin-top:26px;"><h2>Needs Attention</h2><span class="count">${attention.length}</span></div>`;
    attention.forEach(t=>{ html += taskCard(t, false); });
  }

  if(canSeeTeamBoard(CURRENT_USER)){
    const empOptions = `<option value="all">All employees</option>` + scopedUsers.map(u=>`<option value="${u.id}" ${TEAMBOARD_FILTER_EMP===u.id?'selected':''}>${escapeHtml(u.name)}</option>`).join('');
    const statusOptions = `<option value="all">All statuses</option>` + STATUSES.map(s=>`<option value="${s.id}" ${TEAMBOARD_FILTER_STATUS===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
    let allTasks = scopedTasks.slice().sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
    if(TEAMBOARD_FILTER_EMP !== 'all') allTasks = allTasks.filter(t=>t.assignedTo===TEAMBOARD_FILTER_EMP);
    if(TEAMBOARD_FILTER_STATUS !== 'all') allTasks = allTasks.filter(t=>t.status===TEAMBOARD_FILTER_STATUS);

    html += `<div class="section-head" id="allTasksSection" style="margin-top:26px;"><h2>All Tasks</h2><span class="count">${allTasks.length} of ${scopedTasks.length}</span></div>`;
    html += `
      <div class="form-row" style="margin-bottom:14px;">
        <div>
          <span class="field-label">Employee</span>
          <select onchange="setTeamBoardFilter('emp', this.value)">${empOptions}</select>
        </div>
        <div>
          <span class="field-label">Status</span>
          <select onchange="setTeamBoardFilter('status', this.value)">${statusOptions}</select>
        </div>
      </div>
    `;
    if(!allTasks.length){
      html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NO MATCHES —</div>Try a different filter.</div>`;
    } else {
      allTasks.forEach(t=>{ html += taskCard(t, false); });
    }
  }

  return html;
}
let TEAMBOARD_FILTER_EMP = 'all';
let TEAMBOARD_FILTER_STATUS = 'all';
let TEAMBOARD_ROSTER_FILTER = 'all';
let COMMENT_FOR_ID = null;
let PRESELECT_ASSIGNEE_ID = null;
function setTeamBoardFilter(kind, value){
  if(kind==='emp') TEAMBOARD_FILTER_EMP = value;
  else TEAMBOARD_FILTER_STATUS = value;
  render();
}
function setTeamBoardRosterFilter(value){
  TEAMBOARD_ROSTER_FILTER = value;
  render();
}
let VIEW_TASKS_FOR_ID = null;
function viewEmployeeTasks(userId){
  VIEW_TASKS_FOR_ID = VIEW_TASKS_FOR_ID === userId ? null : userId;
  render();
}
function assignToEmployee(userId){
  PRESELECT_ASSIGNEE_ID = userId;
  setTab('new');
}
function toggleCommentRow(userId){
  COMMENT_FOR_ID = COMMENT_FOR_ID === userId ? null : userId;
  render();
}
async function submitComment(userId){
  const text = document.getElementById('comment-text-'+userId).value.trim();
  if(!text){ showToast('Write something first'); return; }
  try{
    await apiPost('send_comment', { targetUserId: userId, requestingUserId: CURRENT_USER.id, message: text });
    COMMENT_FOR_ID = null;
    showToast('Comment sent');
    render();
  }catch(e){ showToast(e.message || 'Could not send comment', true); }
}
async function sendTeamSummary(){
  if(!confirm('Email the current team summary to ecommerce@canares.com and gajanan@canares.com?')) return;
  try{
    const res = await apiPost('send_summary', { requestingUserId: CURRENT_USER.id });
    showToast('Summary emailed to ' + res.sentTo);
  }catch(e){
    showToast(e.message || 'Could not send summary', true);
  }
}
function shareTeamSummaryWhatsApp(){
  const scopeIds = visibleTeamUserIds(CURRENT_USER);
  const scopedUsers = USERS.filter(u=>scopeIds.includes(u.id));
  const scopedTasks = TASKS.filter(t=>scopeIds.includes(t.assignedTo));
  const totalOpen = scopedTasks.filter(t=>!isTaskDone(t)).length;
  const totalOverdue = scopedTasks.filter(isOverdue).length;
  const effs = scopedTasks.filter(isTaskDone).map(efficiencyPct).filter(v=>v!==null);
  const avgEff = effs.length ? Math.round(effs.reduce((a,b)=>a+b,0)/effs.length) : null;

  let msg = `*LOGBOOK Team Summary* — ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}\n\n`;
  msg += `Total tasks: ${scopedTasks.length}\nOpen: ${totalOpen}\nOverdue: ${totalOverdue}\nAvg efficiency: ${avgEff===null?'—':avgEff+'%'}\n\n`;
  scopedUsers.slice(0, 15).forEach(u=>{
    const userTasks = scopedTasks.filter(t=>t.assignedTo===u.id);
    const open = userTasks.filter(t=>!isTaskDone(t)).length;
    const overdue = userTasks.filter(isOverdue).length;
    msg += `${u.name}: ${open} open${overdue?`, ${overdue} overdue`:''}\n`;
  });

  const phone = '919448066046';
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

/* ===================== NEW ENTRY ===================== */
let SELF_ASSIGN_MODE = true;

function renderNewEntry(){
  const allowed = assignableUsersFor(CURRENT_USER);
  const others = allowed.filter(u=>u.id!==CURRENT_USER.id);
  let defaultOtherId = others.length ? others[0].id : CURRENT_USER.id;
  if(PRESELECT_ASSIGNEE_ID){
    if(others.some(u=>u.id===PRESELECT_ASSIGNEE_ID)){
      SELF_ASSIGN_MODE = false;
      defaultOtherId = PRESELECT_ASSIGNEE_ID;
    }
    PRESELECT_ASSIGNEE_ID = null; // consume once so it doesn't stick on later visits
  }
  const assigneeForOptions = SELF_ASSIGN_MODE ? allowed : others;
  const options = assigneeForOptions.map(u=>{
    const selected = SELF_ASSIGN_MODE ? u.id===CURRENT_USER.id : u.id===defaultOtherId;
    return `<option value="${u.id}" ${selected?'selected':''}>${escapeHtml(u.name)}</option>`;
  }).join('');
  const defaultStatus = STATUSES.find(s=>!s.isDone) || STATUSES[0];
  const statusOptions = STATUSES.map(s=>`<option value="${s.id}" ${defaultStatus && s.id===defaultStatus.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  const noOthersMsg = CURRENT_USER.isAdmin || CURRENT_USER.orgRole==='dept_head' || CURRENT_USER.orgRole==='sub_head'
    ? 'Add employees from the Employees tab to assign tasks to them.'
    : 'Only department and sub-department heads can assign tasks to others — you can still assign tasks to yourself.';
  return `
    <div class="section-head"><h2>Assign Task</h2></div>
    <div class="form-card">
      <div class="assign-toggle">
        <button type="button" class="${SELF_ASSIGN_MODE?'active':''}" onclick="setAssignMode(true)">For myself</button>
        <button type="button" class="${SELF_ASSIGN_MODE?'':'active'}" ${others.length?'':'disabled title="No one you can assign to yet"'} onclick="setAssignMode(false)">For someone else</button>
      </div>
      ${others.length ? '' : `<p style="color:var(--muted);font-size:11px;margin:-8px 0 12px;">${noOthersMsg}</p>`}
      <div class="form-row">
        <div>
          <span class="field-label">Task title</span>
          <input type="text" id="newTitle" placeholder="e.g. Inspect flange batch #221">
        </div>
      </div>
      <div class="form-row">
        <div>
          <span class="field-label">Description (optional)</span>
          <textarea id="newDesc" placeholder="Any context worth logging"></textarea>
        </div>
      </div>
      <div class="form-row">
        ${SELF_ASSIGN_MODE
          ? `<div class="self-assign-note" style="flex:0 0 100%;">Assigned to <b>you</b> (${escapeHtml(CURRENT_USER.name)}).
             <select id="newAssignee" style="display:none;">${options}</select></div>`
          : `<div><span class="field-label">Assign to</span><select id="newAssignee">${options}</select></div>`
        }
        <div>
          <span class="field-label">Starting status</span>
          <select id="newStatus">${statusOptions}</select>
        </div>
      </div>
      <div class="form-row">
        <div id="newDueWrap">
          <span class="field-label">Due date</span>
          <input type="date" id="newDue">
        </div>
        <div>
          <span class="field-label">Estimated hours</span>
          <input type="number" min="0" step="0.5" id="newEst" placeholder="e.g. 6">
        </div>
      </div>
      <div class="form-row">
        <div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;">
            <input type="checkbox" id="newRepeatOn" onchange="toggleRepeatFields()"> Repeated work (Daily / Weekly / Monthly)
          </label>
        </div>
      </div>
      <div id="repeatFields" style="display:none;">
        <div class="form-row">
          <div>
            <span class="field-label">Work Type</span>
            <select id="newRepeatType" onchange="recalcRepeatDue()">
              <option value="daily">Daily</option>
              <option value="weekly" selected>Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <span class="field-label">Start Date</span>
            <input type="date" id="newRepeatStart" onchange="recalcRepeatDue()">
          </div>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:-4px 0 12px;">Due date (auto-calculated): <b id="newRepeatDueDisplay">—</b> — a new task is generated automatically each time this one is completed or renewed.</p>
      </div>
      <button class="btn-amber" id="addTaskBtn" onclick="submitNewTask()">Add to board</button>
    </div>
  `;
}
function setAssignMode(self){
  SELF_ASSIGN_MODE = self;
  render();
}

function toggleRepeatFields(){
  const on = document.getElementById('newRepeatOn').checked;
  document.getElementById('repeatFields').style.display = on ? '' : 'none';
  const dueWrap = document.getElementById('newDueWrap');
  if(dueWrap) dueWrap.style.display = on ? 'none' : '';
  if(on && !document.getElementById('newRepeatStart').value){
    document.getElementById('newRepeatStart').value = new Date().toISOString().slice(0,10);
  }
  recalcRepeatDue();
}
function recalcRepeatDue(){
  const type = document.getElementById('newRepeatType').value;
  const start = document.getElementById('newRepeatStart').value;
  const disp = document.getElementById('newRepeatDueDisplay');
  if(!disp) return;
  if(!start){ disp.textContent = '—'; return; }
  const d = new Date(start+'T00:00:00');
  if(type==='daily') d.setDate(d.getDate()+1);
  else if(type==='weekly') d.setDate(d.getDate()+7);
  else if(type==='monthly') d.setMonth(d.getMonth()+1);
  disp.textContent = d.toISOString().slice(0,10) + ' (server confirms the exact date on save)';
}

async function submitNewTask(){
  const title = document.getElementById('newTitle').value.trim();
  if(!title){ showToast('Give the task a title'); return; }
  const desc = document.getElementById('newDesc').value.trim();
  const assignee = document.getElementById('newAssignee').value;
  const statusId = document.getElementById('newStatus').value;
  const est = Number(document.getElementById('newEst').value) || null;

  const repeatOn = document.getElementById('newRepeatOn').checked;
  let due = document.getElementById('newDue').value;
  let repeatType = 'none', repeatStart = null;
  if(repeatOn){
    repeatType = document.getElementById('newRepeatType').value;
    repeatStart = document.getElementById('newRepeatStart').value;
    if(!repeatStart){ showToast('Pick a start date for the repeated work'); return; }
    due = null; // server calculates the actual due date from Work Type + Start Date
  }

  const btn = document.getElementById('addTaskBtn');
  btn.disabled = true;

  try{
    const res = await apiPost('add_task', {
      title, description: desc || null, assignedTo: assignee, assignedBy: CURRENT_USER.id,
      dueDate: due || null, estimatedHours: est, statusId,
      repeatType, startDate: repeatStart
    });
    TASKS.unshift({
      id: res.id, title, description: desc, assignedTo: assignee, assignedBy: CURRENT_USER.id,
      createdAt: new Date().toISOString(), dueDate: res.dueDate || due || null, estimatedHours: est,
      status: res.statusId || statusId, updates: [], completedAt: null, actualHours: null,
      repeatType: res.repeatType || repeatType, repeatParentId: null
    });
    showToast(repeatOn ? 'Repeating task added \u2014 due ' + (res.dueDate || '') : 'Task added');
    setTab('mine');
  }catch(e){
    showToast(e.message || 'Could not add task', true);
  }finally{
    btn.disabled = false;
  }
}

/* ===================== STATUSES ===================== */
let EDIT_STATUS_ID = null;
let SHOW_ADD_STATUS = false;

function renderStatuses(){
  let html = `
    <div class="section-head"><h2>Statuses</h2><span class="count">${STATUSES.length} total</span></div>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 16px;">Color-coded labels tasks can move through. Anyone can add or edit one — changes apply everywhere immediately.</p>
  `;

  STATUSES.forEach(s=>{
    if(EDIT_STATUS_ID === s.id){
      html += `
        <div class="status-row" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div class="form-row" style="margin-bottom:0;">
            <input type="color" id="es-color-${s.id}" value="${s.color}">
            <input type="text" id="es-name-${s.id}" value="${escapeHtml(s.name)}" style="flex:2;">
          </div>
          <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="es-done-${s.id}" ${s.isDone?'checked':''} style="width:auto;"> Counts as done (drives efficiency %, clears overdue)
          </label>
          <div style="display:flex;gap:8px;">
            <button class="btn-sm primary" onclick="submitEditStatus('${s.id}')">Save</button>
            <button class="btn-sm" onclick="toggleEditStatus('${s.id}')">Cancel</button>
            <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);margin-left:auto;" onclick="deleteStatusConfirm('${s.id}')">Delete</button>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="status-row">
          <span class="swatch" style="background:${s.color};"></span>
          <span class="st-name">${escapeHtml(s.name)}</span>
          ${s.isDone ? `<span class="st-flag">DONE STATUS</span>` : ''}
          <button class="btn-sm" onclick="toggleEditStatus('${s.id}')">Edit</button>
        </div>
      `;
    }
  });

  html += `
    <div class="form-card" style="margin-top:14px;">
      ${SHOW_ADD_STATUS ? `
        <div class="form-row">
          <input type="color" id="newStatusColor" value="#7C3AED">
          <input type="text" id="newStatusName" placeholder="Status name" style="flex:2;">
        </div>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-bottom:10px;">
          <input type="checkbox" id="newStatusDone" style="width:auto;"> Counts as done
        </label>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm primary" onclick="submitAddStatus()">Add status</button>
          <button class="btn-sm" onclick="toggleAddStatus()">Cancel</button>
        </div>
      ` : `<button class="btn-amber" onclick="toggleAddStatus()">+ Add a status</button>`}
    </div>
  `;
  return html;
}

function toggleAddStatus(){ SHOW_ADD_STATUS = !SHOW_ADD_STATUS; render(); }
function toggleEditStatus(id){ EDIT_STATUS_ID = EDIT_STATUS_ID === id ? null : id; render(); }

async function submitAddStatus(){
  const name = document.getElementById('newStatusName').value.trim();
  if(!name){ showToast('Name required'); return; }
  const color = document.getElementById('newStatusColor').value;
  const isDone = document.getElementById('newStatusDone').checked;
  try{
    const res = await apiPost('add_status', { name, color, isDone });
    STATUSES.push(res.status);
    SHOW_ADD_STATUS = false;
    showToast('Status added');
    render();
  }catch(e){
    showToast(e.message || 'Could not add status', true);
  }
}

async function submitEditStatus(id){
  const s = STATUSES.find(x=>x.id===id);
  if(!s) return;
  const name = document.getElementById('es-name-'+id).value.trim();
  if(!name){ showToast('Name required'); return; }
  const color = document.getElementById('es-color-'+id).value;
  const isDone = document.getElementById('es-done-'+id).checked;
  try{
    await apiPost('update_status', { statusId: id, name, color, isDone });
    s.name = name; s.color = color; s.isDone = isDone;
    EDIT_STATUS_ID = null;
    showToast('Status updated');
    render();
  }catch(e){
    showToast(e.message || 'Could not update status', true);
  }
}

async function deleteStatusConfirm(id){
  if(!confirm('Delete this status? Tasks currently on it must be moved first.')) return;
  try{
    await apiPost('delete_status', { statusId: id });
    STATUSES = STATUSES.filter(x=>x.id!==id);
    showToast('Status deleted');
    render();
  }catch(e){
    showToast(e.message || 'Could not delete status', true);
  }
}

/* ===================== CHART HELPERS ===================== */
function svgDonut(segments, size){
  size = size || 140;
  const total = segments.reduce((s,x)=>s+x.value, 0);
  const r = size/2 - 14;
  const c = 2*Math.PI*r;
  let offsetAcc = 0;
  const rings = segments.filter(s=>s.value>0).map(s=>{
    const frac = total > 0 ? s.value/total : 0;
    const dash = frac*c;
    const circle = `<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="16"
      stroke-dasharray="${dash} ${c-dash}" stroke-dashoffset="${-offsetAcc}" stroke-linecap="butt"/>`;
    offsetAcc += dash;
    return circle;
  }).join('');
  return `<svg width="${size}" height="${size}" style="transform:rotate(-90deg);">
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="16"/>
    ${rings}
  </svg>`;
}
function svgBarChart(items, opts){
  opts = opts || {};
  const max = Math.max(1, ...items.map(i=>i.value));
  const barH = 22, gap = 10, labelW = 130, chartW = 220;
  const h = items.length * (barH+gap);
  let bars = items.map((it,i)=>{
    const y = i*(barH+gap);
    const w = Math.max(2, (it.value/max)*chartW);
    return `
      <text x="0" y="${y+barH*0.7}" font-size="11" fill="var(--muted)" font-family="Inter,sans-serif">${escapeHtml(it.label)}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${it.color||'var(--amber)'}"/>
      <text x="${labelW+w+6}" y="${y+barH*0.7}" font-size="11" fill="var(--text)" font-family="'IBM Plex Mono',monospace">${it.value}${opts.suffix||''}</text>
    `;
  }).join('');
  return `<svg width="100%" height="${h}" viewBox="0 0 ${labelW+chartW+60} ${h}">${bars}</svg>`;
}

/* ===================== ATTENDANCE ===================== */
function getPositionPromise(){
  return new Promise((resolve) => {
    if(!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 15000 }
    );
  });
}
function fmtDuration(mins){
  const totalMin = Math.round(mins);
  const h = Math.floor(totalMin/60), m = totalMin%60;
  return `${h}h ${m}m`;
}
function dayOfWeek(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long' });
}
function managerNameFor(user){
  if(!user) return '—';
  if(user.orgRole === 'employee'){
    if(user.subDepartmentId){
      const head = USERS.find(u=>u.orgRole==='sub_head' && u.subDepartmentId===user.subDepartmentId);
      if(head) return head.name;
    }
    if(user.departmentId){
      const head = USERS.find(u=>u.orgRole==='dept_head' && u.departmentId===user.departmentId);
      if(head) return head.name;
    }
    return '—';
  }
  if(user.orgRole === 'sub_head' && user.departmentId){
    const head = USERS.find(u=>u.orgRole==='dept_head' && u.departmentId===user.departmentId);
    return head ? head.name : '—';
  }
  if(user.orgRole === 'dept_head'){
    const admin = USERS.find(u=>u.isAdmin);
    return admin ? admin.name : '—';
  }
  return '—';
}
/* Single source of truth for both the on-screen table and the CSV export,
   so the two can never drift out of sync with each other. */
const ATTENDANCE_COLUMNS = [
  { key:'sno', label:'SNO' },
  { key:'employeeName', label:'Employee', teamOnly:true },
  { key:'employeeNo', label:'Employee No' },
  { key:'doj', label:'Date of Joining' },
  { key:'managerNo', label:'Manager No', teamOnly:true },
  { key:'managerName', label:'Manager Name', teamOnly:true },
  { key:'date', label:'Date' },
  { key:'day', label:'Day' },
  { key:'session1', label:'Session1 Status' },
  { key:'session2', label:'Session2 Status' },
  { key:'inTime', label:'In Time' },
  { key:'outTime', label:'Out Time' },
  { key:'shiftName', label:'Shift Name' },
  { key:'shiftInTime', label:'Shift In Time' },
  { key:'shiftOutTime', label:'Shift Out Time' },
  { key:'lateInHrs', label:'Late In Hrs' },
  { key:'earlyOutHrs', label:'Early Out Hrs' },
  { key:'workHours', label:'Work Hours' },
  { key:'excessHours', label:'Excess Hours' },
  { key:'totalWorkHours', label:'Total Work Hours' },
];
function attendanceRowData(a, sno){
  const user = USERS.find(u=>u.id===a.userId);
  const durMin = a.clockOut ? (new Date(a.clockOut) - new Date(a.clockIn))/60000 : (new Date() - new Date(a.clockIn))/60000;
  const workHours = fmtDuration(durMin) + (a.clockOut ? '' : ' (ongoing)');
  const inDate = a.clockIn.slice(0,10);
  const outDate = a.clockOut ? a.clockOut.slice(0,10) : null;
  const outTimeStr = a.clockOut
    ? (outDate !== inDate ? `${fmtDate(outDate)}, ${fmtDateTime(a.clockOut).split(' · ')[1]}` : fmtDateTime(a.clockOut).split(' · ')[1])
    : '—';
  return {
    sno,
    employeeName: user ? user.name : userName(a.userId),
    employeeNo: '—',
    doj: user && user.createdAt ? fmtDate(user.createdAt.slice(0,10)) : '—',
    managerNo: '—',
    managerName: managerNameFor(user),
    date: fmtDate(inDate),
    day: dayOfWeek(inDate),
    session1: '—',
    session2: '—',
    inTime: fmtDateTime(a.clockIn).split(' · ')[1],
    outTime: outTimeStr,
    shiftName: '—',
    shiftInTime: '—',
    shiftOutTime: '—',
    lateInHrs: '—',
    earlyOutHrs: '—',
    workHours,
    excessHours: '—',
    totalWorkHours: workHours,
  };
}
function renderAttendanceTable(rows, teamOnly){
  const cols = ATTENDANCE_COLUMNS.filter(c => teamOnly || !c.teamOnly);
  let html = `<div style="overflow-x:auto;"><table class="roster-table"><thead><tr>`;
  cols.forEach(c=>{ html += `<th>${escapeHtml(c.label)}</th>`; });
  html += `</tr></thead><tbody>`;
  rows.forEach((r, i)=>{
    const data = attendanceRowData(r, i+1);
    html += '<tr>';
    cols.forEach(c=>{
      const isNameCell = c.key === 'employeeName';
      html += `<td class="${isNameCell?'name-cell':'mono'}">${escapeHtml(String(data[c.key]))}</td>`;
    });
    html += '</tr>';
  });
  html += `</tbody></table></div>`;
  return html;
}
function exportAttendanceCSV(){
  const mine = attendanceRowsFor(CURRENT_USER.id);
  const teamOnly = canSeeTeamBoard(CURRENT_USER);
  const scopeIds = teamOnly ? visibleTeamUserIds(CURRENT_USER) : [];
  const teamRows = teamOnly ? ATTENDANCE.filter(a=>scopeIds.includes(a.userId) && a.userId!==CURRENT_USER.id) : [];
  const allRows = mine.concat(teamRows).sort((a,b)=> new Date(b.clockIn) - new Date(a.clockIn));
  if(!allRows.length){ showToast('Nothing to export yet'); return; }

  const cols = ATTENDANCE_COLUMNS; // always include Employee column in the export, even for a single-person view
  const csvEscape = (v) => `"${String(v).replace(/"/g,'""')}"`;
  const lines = [cols.map(c=>csvEscape(c.label)).join(',')];
  allRows.forEach((r, i)=>{
    const data = attendanceRowData(r, i+1);
    lines.push(cols.map(c=>csvEscape(data[c.key])).join(','));
  });
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function attendanceRowsFor(userId){
  return ATTENDANCE.filter(a=>a.userId===userId).sort((a,b)=> new Date(b.clockIn) - new Date(a.clockIn));
}
function renderAttendance(){
  const mine = attendanceRowsFor(CURRENT_USER.id);
  const openRow = mine.find(a=>!a.clockOut);
  let html = `<div class="section-head"><h2>Attendance</h2><button class="btn-sm" onclick="exportAttendanceCSV()">Export CSV</button></div>`;
  html += `
    <button class="clock-btn ${openRow?'out':'in'}" onclick="${openRow?'doClockOut()':'doClockIn()'}">${openRow?'Clock Out':'Clock In'}</button>
    <div class="gps-note">${openRow ? 'Clocked in at ' + fmtDateTime(openRow.clockIn) : 'Your location is captured with each clock in/out.'}</div>
  `;
  html += `<div class="section-head" style="margin-top:22px;"><h2 style="font-size:18px;">My Timeline</h2></div>`;
  if(!mine.length){
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NO SHIFTS YET —</div>Clock in to start your timeline.</div>`;
  } else {
    html += renderAttendanceTable(mine, false);
  }

  if(canSeeTeamBoard(CURRENT_USER)){
    const scopeIds = visibleTeamUserIds(CURRENT_USER);
    const teamLabel = CURRENT_USER.isAdmin ? "Everyone's Timeline" : "My Team's Timeline";
    html += `<div class="section-head" style="margin-top:26px;"><h2 style="font-size:18px;">${teamLabel}</h2></div>`;
    const all = ATTENDANCE.filter(a=>scopeIds.includes(a.userId) && a.userId!==CURRENT_USER.id)
      .sort((a,b)=> new Date(b.clockIn) - new Date(a.clockIn)).slice(0, 40);
    if(!all.length){
      html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NO SHIFTS YET —</div></div>`;
    } else {
      html += renderAttendanceTable(all, true);
    }
  }
  return html;
}
async function doClockIn(){
  const pos = await getPositionPromise();
  try{
    const res = await apiPost('clock_in', { userId: CURRENT_USER.id, lat: pos?.lat, lng: pos?.lng });
    ATTENDANCE.unshift({ id: res.id, userId: CURRENT_USER.id, clockIn: res.clockIn, clockOut: null,
      latIn: pos?.lat ?? null, lngIn: pos?.lng ?? null, latOut: null, lngOut: null });
    showToast('Clocked in');
    render();
  }catch(e){ showToast(e.message || 'Could not clock in', true); }
}
async function doClockOut(){
  const pos = await getPositionPromise();
  try{
    const res = await apiPost('clock_out', { userId: CURRENT_USER.id, lat: pos?.lat, lng: pos?.lng });
    const row = ATTENDANCE.find(a=>a.id===res.id);
    if(row){ row.clockOut = res.clockOut; row.latOut = pos?.lat ?? null; row.lngOut = pos?.lng ?? null; }
    showToast('Clocked out');
    render();
  }catch(e){ showToast(e.message || 'Could not clock out', true); }
}

/* ===================== EMPLOYEES (admin) ===================== */
let EDIT_EMP_ID = null;
let SHOW_ADD_EMP = false;
let EMP_EDIT_DRAFT = null; // {orgRole, departmentId, subDepartmentId} while an edit panel is open
function isOnline(user){
  if(!user.lastSeen) return false;
  return (new Date() - new Date(user.lastSeen.replace(' ','T'))) < 3*60*1000;
}
function renderEmployees(){
  if(!CURRENT_USER.isAdmin) return `<div class="empty" style="padding:40px;"><div class="em-mark">— ADMIN ONLY —</div></div>`;
  let html = `<div class="section-head"><h2>Employees</h2><span class="count">${USERS.length} total</span></div>`;

  USERS.forEach(u=>{
    if(EDIT_EMP_ID === u.id){
      const draft = EMP_EDIT_DRAFT || {orgRole: u.orgRole||'employee', departmentId: u.departmentId||'', subDepartmentId: u.subDepartmentId||''};
      const deptOptions = `<option value="">— none —</option>` + DEPARTMENTS.map(d=>`<option value="${d.id}" ${draft.departmentId===d.id?'selected':''}>${escapeHtml(d.name)}</option>`).join('');
      const subDeptsForDept = SUB_DEPARTMENTS.filter(s=>s.departmentId===draft.departmentId);
      const subDeptOptions = `<option value="">— none —</option>` + subDeptsForDept.map(s=>`<option value="${s.id}" ${draft.subDepartmentId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
      html += `
        <div class="emp-row" style="flex-direction:column;align-items:stretch;">
          <div class="form-row" style="margin-bottom:0;">
            <input type="text" id="name-rename-${u.id}" value="${escapeHtml(u.name)}" placeholder="Employee name">
            <button class="btn-sm primary" onclick="submitRenameEmployee('${u.id}')">Save Name</button>
          </div>
          <div class="form-row" style="margin-bottom:0;margin-top:10px;">
            <input type="text" id="pin-reset-${u.id}" inputmode="numeric" maxlength="4" placeholder="New 4-digit PIN (blank = remove PIN)">
            <button class="btn-sm primary" onclick="submitResetPin('${u.id}')">Reset PIN</button>
          </div>
          <div class="form-row" style="margin-top:10px;">
            <div>
              <span class="field-label">Role</span>
              <select onchange="updateEmpDraft('orgRole', this.value)">
                <option value="employee" ${draft.orgRole==='employee'?'selected':''}>Employee</option>
                <option value="sub_head" ${draft.orgRole==='sub_head'?'selected':''}>Sub-department Head</option>
                <option value="dept_head" ${draft.orgRole==='dept_head'?'selected':''}>Department Head</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div>
              <span class="field-label">Department</span>
              <select onchange="updateEmpDraft('departmentId', this.value)">${deptOptions}</select>
            </div>
            ${draft.orgRole !== 'dept_head' ? `
            <div>
              <span class="field-label">Sub-department</span>
              <select onchange="updateEmpDraft('subDepartmentId', this.value)" ${!draft.departmentId?'disabled':''}>${subDeptOptions}</select>
            </div>` : ''}
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn-sm primary" onclick="submitUpdateEmpOrg('${u.id}')">Save role &amp; department</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn-sm" onclick="submitToggleAdmin('${u.id}', ${!u.isAdmin})">${u.isAdmin?'Remove admin':'Make admin'}</button>
            <button class="btn-sm" onclick="toggleEditEmp('${u.id}')">Close</button>
            <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);margin-left:auto;" onclick="submitDeleteEmployee('${u.id}')">Delete</button>
          </div>
        </div>
      `;
    } else {
      const roleBadge = u.orgRole==='dept_head' ? `<span class="admin-badge" style="background:rgba(91,122,148,0.18);color:var(--steel);">Dept Head</span>`
        : u.orgRole==='sub_head' ? `<span class="admin-badge" style="background:rgba(91,122,148,0.18);color:var(--steel);">Sub Head</span>` : '';
      html += `
        <div class="emp-row">
          <span class="online-dot ${isOnline(u)?'on':'off'}"></span>
          <div class="emp-main">
            <div class="emp-name">${escapeHtml(u.name)} ${u.isAdmin?'<span class="admin-badge">Admin</span>':''} ${roleBadge}</div>
            <div class="emp-meta">${orgContextLabel(u)}${u.phone?' · '+escapeHtml(u.phone):''}${u.hasPin?' · PIN set':' · no PIN'}</div>
          </div>
          <button class="btn-sm" onclick="toggleEditEmp('${u.id}')">Manage</button>
        </div>
      `;
    }
  });

  html += `<div class="form-card" style="margin-top:14px;">
    ${SHOW_ADD_EMP ? `
      <div class="form-row"><div><span class="field-label">Name</span><input type="text" id="newEmpName" placeholder="Full name"></div></div>
      <div class="form-row">
        <div><span class="field-label">Department</span><input type="text" id="newEmpDept" placeholder="e.g. Production"></div>
        <div><span class="field-label">Phone</span><input type="text" id="newEmpPhone" placeholder="Optional"></div>
      </div>
      <div class="form-row"><div><span class="field-label">Initial PIN (optional)</span><input type="text" id="newEmpPin" inputmode="numeric" maxlength="4" placeholder="4 digits"></div></div>
      <p style="color:var(--muted);font-size:11px;margin:-4px 0 10px;">Set their role, department, and sub-department afterward via Manage — this just gets them into the system.</p>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm primary" onclick="submitAddEmployee()">Add employee</button>
        <button class="btn-sm" onclick="toggleAddEmp()">Cancel</button>
      </div>
    ` : `<button class="btn-amber" onclick="toggleAddEmp()">+ Add Employee</button>`}
  </div>`;
  return html;
}
function toggleAddEmp(){ SHOW_ADD_EMP = !SHOW_ADD_EMP; render(); }
function toggleEditEmp(id){
  if(EDIT_EMP_ID === id){ EDIT_EMP_ID = null; EMP_EDIT_DRAFT = null; render(); return; }
  const u = USERS.find(x=>x.id===id);
  EDIT_EMP_ID = id;
  EMP_EDIT_DRAFT = { orgRole: (u && u.orgRole) || 'employee', departmentId: (u && u.departmentId) || '', subDepartmentId: (u && u.subDepartmentId) || '' };
  render();
}
function updateEmpDraft(field, value){
  if(!EMP_EDIT_DRAFT) return;
  EMP_EDIT_DRAFT[field] = value;
  if(field==='departmentId') EMP_EDIT_DRAFT.subDepartmentId = '';
  render();
}
async function submitUpdateEmpOrg(id){
  if(!EMP_EDIT_DRAFT) return;
  const { orgRole, departmentId, subDepartmentId } = EMP_EDIT_DRAFT;
  if(orgRole==='dept_head' && !departmentId){ showToast('Pick a department for a department head', true); return; }
  if(orgRole==='sub_head' && !subDepartmentId){ showToast('Pick a sub-department for a sub-department head', true); return; }
  try{
    const res = await apiPost('update_user_org', {
      targetUserId: id, requestingUserId: CURRENT_USER.id,
      orgRole, departmentId: departmentId || null, subDepartmentId: subDepartmentId || null
    });
    const u = USERS.find(x=>x.id===id);
    if(u){ u.orgRole = res.orgRole; u.departmentId = res.departmentId; u.subDepartmentId = res.subDepartmentId; }
    showToast('Role updated');
    EDIT_EMP_ID = null; EMP_EDIT_DRAFT = null;
    render();
  }catch(e){ showToast(e.message || 'Could not update role', true); }
}

/* ===================== DEPARTMENTS (admin) ===================== */
let SHOW_ADD_DEPT = false;
let ADD_SUBDEPT_FOR = null; // departmentId currently showing an "add sub-department" inline form

function renderDepartments(){
  if(!CURRENT_USER.isAdmin) return `<div class="empty" style="padding:40px;"><div class="em-mark">— ADMIN ONLY —</div></div>`;
  let html = `<div class="section-head"><h2>Departments</h2><span class="count">${DEPARTMENTS.length} total</span></div>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 16px;">
      Department Heads can assign tasks to anyone in their department (sub-department heads or employees directly).
      Sub-department Heads can assign tasks to employees in their own sub-department. Set each person's role and
      department from the Employees tab.
    </p>`;

  if(!DEPARTMENTS.length){
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NONE YET —</div>Add a department below to get started.</div>`;
  }

  DEPARTMENTS.forEach(d=>{
    const subs = SUB_DEPARTMENTS.filter(s=>s.departmentId===d.id);
    html += `<div class="status-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="st-name">${escapeHtml(d.name)}</span>
        <button class="btn-sm" onclick="toggleAddSubDept('${d.id}')">+ Sub-department</button>
        <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);margin-left:auto;" onclick="deleteDepartmentConfirm('${d.id}')">Delete</button>
      </div>
      ${subs.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
        ${subs.map(s=>`
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--panel-2);border-radius:3px;">
            <span style="flex:1;font-size:13px;">${escapeHtml(s.name)}</span>
            <button class="btn-sm" style="border-color:var(--rust);color:var(--rust);" onclick="deleteSubDepartmentConfirm('${s.id}')">Delete</button>
          </div>
        `).join('')}
      </div>` : `<p style="color:var(--muted);font-size:12px;margin:8px 0 0;">No sub-departments yet.</p>`}
      ${ADD_SUBDEPT_FOR === d.id ? `
        <div class="form-row" style="margin-top:10px;">
          <input type="text" id="newSubDeptName-${d.id}" placeholder="Sub-department name">
          <button class="btn-sm primary" onclick="submitAddSubDepartment('${d.id}')">Add</button>
          <button class="btn-sm" onclick="toggleAddSubDept('${d.id}')">Cancel</button>
        </div>
      ` : ''}
    </div>`;
  });

  html += `<div class="form-card" style="margin-top:14px;">
    ${SHOW_ADD_DEPT ? `
      <div class="form-row">
        <input type="text" id="newDeptName" placeholder="Department name, e.g. Production">
        <button class="btn-sm primary" onclick="submitAddDepartment()">Add department</button>
        <button class="btn-sm" onclick="toggleAddDept()">Cancel</button>
      </div>
    ` : `<button class="btn-amber" onclick="toggleAddDept()">+ Add Department</button>`}
  </div>`;
  return html;
}
function toggleAddDept(){ SHOW_ADD_DEPT = !SHOW_ADD_DEPT; render(); }
function toggleAddSubDept(deptId){ ADD_SUBDEPT_FOR = ADD_SUBDEPT_FOR===deptId ? null : deptId; render(); }

async function submitAddDepartment(){
  const name = document.getElementById('newDeptName').value.trim();
  if(!name){ showToast('Name required'); return; }
  try{
    const res = await apiPost('add_department', { name, requestingUserId: CURRENT_USER.id });
    DEPARTMENTS.push(res.department);
    SHOW_ADD_DEPT = false;
    showToast('Department added');
    render();
  }catch(e){ showToast(e.message || 'Could not add department', true); }
}
async function deleteDepartmentConfirm(id){
  if(!confirm('Delete this department? It must have no sub-departments and no employees assigned to it.')) return;
  try{
    await apiPost('delete_department', { departmentId: id, requestingUserId: CURRENT_USER.id });
    DEPARTMENTS = DEPARTMENTS.filter(x=>x.id!==id);
    showToast('Department deleted');
    render();
  }catch(e){ showToast(e.message || 'Could not delete department', true); }
}
async function submitAddSubDepartment(departmentId){
  const name = document.getElementById('newSubDeptName-'+departmentId).value.trim();
  if(!name){ showToast('Name required'); return; }
  try{
    const res = await apiPost('add_sub_department', { name, departmentId, requestingUserId: CURRENT_USER.id });
    SUB_DEPARTMENTS.push(res.subDepartment);
    ADD_SUBDEPT_FOR = null;
    showToast('Sub-department added');
    render();
  }catch(e){ showToast(e.message || 'Could not add sub-department', true); }
}
async function deleteSubDepartmentConfirm(id){
  if(!confirm('Delete this sub-department? It must have no employees assigned to it.')) return;
  try{
    await apiPost('delete_sub_department', { subDepartmentId: id, requestingUserId: CURRENT_USER.id });
    SUB_DEPARTMENTS = SUB_DEPARTMENTS.filter(x=>x.id!==id);
    showToast('Sub-department deleted');
    render();
  }catch(e){ showToast(e.message || 'Could not delete sub-department', true); }
}


async function submitAddEmployee(){
  const name = document.getElementById('newEmpName').value.trim();
  if(!name){ showToast('Name required'); return; }
  const department = document.getElementById('newEmpDept').value.trim();
  const phone = document.getElementById('newEmpPhone').value.trim();
  const pin = document.getElementById('newEmpPin').value.trim();
  if(pin && !/^\d{4}$/.test(pin)){ showToast('PIN must be 4 digits'); return; }
  try{
    const res = await apiPost('add_user', { name, department: department||null, phone: phone||null, pin: pin||null });
    if(!USERS.find(u=>u.id===res.user.id)) USERS.push(res.user);
    SHOW_ADD_EMP = false;
    showToast('Employee added');
    render();
  }catch(e){ showToast(e.message || 'Could not add employee', true); }
}
async function submitRenameEmployee(id){
  const input = document.getElementById('name-rename-'+id);
  const newName = input.value.trim();
  if(!newName){ showToast('Name cannot be empty', true); return; }
  const u = USERS.find(x=>x.id===id);
  if(u && u.name === newName){ return; } // no change
  try{
    await apiPost('rename_user', { targetUserId: id, requestingUserId: CURRENT_USER.id, newName });
    if(u) u.name = newName;
    showToast('Name updated');
    render();
  }catch(e){ showToast(e.message || 'Could not rename employee', true); }
}
async function submitResetPin(id){
  const pin = document.getElementById('pin-reset-'+id).value.trim();
  if(pin && !/^\d{4}$/.test(pin)){ showToast('PIN must be 4 digits'); return; }
  try{
    await apiPost('reset_pin', { targetUserId: id, requestingUserId: CURRENT_USER.id, newPin: pin });
    const u = USERS.find(x=>x.id===id);
    if(u) u.hasPin = !!pin;
    showToast('PIN reset');
    EDIT_EMP_ID = null;
    render();
  }catch(e){ showToast(e.message || 'Could not reset PIN', true); }
}
async function submitToggleAdmin(id, makeAdmin){
  try{
    await apiPost('toggle_admin', { targetUserId: id, requestingUserId: CURRENT_USER.id, isAdmin: makeAdmin });
    const u = USERS.find(x=>x.id===id);
    if(u) u.isAdmin = makeAdmin;
    showToast(makeAdmin ? 'Now an admin' : 'Admin removed');
    render();
  }catch(e){ showToast(e.message || 'Could not change admin status', true); }
}
async function submitDeleteEmployee(id){
  const u = USERS.find(x=>x.id===id);
  const name = u ? u.name : 'this employee';
  if(!confirm(`Remove ${name}? This can't be undone.`)) return;
  try{
    await apiPost('delete_user', { targetUserId: id, requestingUserId: CURRENT_USER.id });
    USERS = USERS.filter(x=>x.id!==id);
    EDIT_EMP_ID = null;
    showToast('Employee removed');
    render();
  }catch(e){
    if(e.blockedByHistory){
      if(confirm(`${e.message}\n\nPermanently delete "${name}" AND all of their tasks, attendance, and report history? This cannot be undone.`)){
        try{
          await apiPost('delete_user', { targetUserId: id, requestingUserId: CURRENT_USER.id, force: true });
          USERS = USERS.filter(x=>x.id!==id);
          EDIT_EMP_ID = null;
          showToast('Employee and their history removed');
          render();
        }catch(e2){ showToast(e2.message || 'Could not remove employee', true); }
      }
    } else {
      showToast(e.message || 'Could not remove employee', true);
    }
  }
}

/* ===================== LIVE STATUS (admin) ===================== */
function renderLiveStatus(){
  if(!CURRENT_USER.isAdmin) return `<div class="empty" style="padding:40px;"><div class="em-mark">— ADMIN ONLY —</div></div>`;
  const onlineCount = USERS.filter(isOnline).length;
  let html = `
    <div class="stat-strip">
      <div class="stat-box"><div class="num" style="color:var(--teal);">${onlineCount}</div><div class="lbl">Online now</div></div>
      <div class="stat-box"><div class="num">${USERS.length}</div><div class="lbl">Total employees</div></div>
    </div>
    <div class="section-head"><h2>Live Employee Status</h2></div>
  `;
  html += `<div style="overflow-x:auto;"><table class="roster-table"><thead><tr><th>Employee</th><th>Status</th><th>Last Seen</th><th>Last Location</th></tr></thead><tbody>`;
  USERS.forEach(u=>{
    const online = isOnline(u);
    const seenText = u.lastSeen ? fmtDateTime(u.lastSeen) : 'never';
    let locText = '—';
    if(u.lastLat && u.lastLng){
      const mapUrl = `https://www.google.com/maps?q=${u.lastLat},${u.lastLng}`;
      locText = `<a href="${mapUrl}" target="_blank" rel="noopener" style="color:var(--steel);">${u.lastLat.toFixed(4)}, ${u.lastLng.toFixed(4)}</a>`;
    }
    html += `<tr>
      <td class="name-cell">${escapeHtml(u.name)}</td>
      <td><span class="online-dot ${online?'on':'off'}"></span>${online?'Online':'Offline'}</td>
      <td class="mono" style="font-size:11px;">${seenText}</td>
      <td style="font-size:12px;">${locText}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  html += `<p style="color:var(--muted);font-size:11px;margin-top:10px;">Location updates automatically every 30 seconds while an employee has the app open, if they've allowed location access in their browser.</p>`;
  return html;
}

/* ===================== REPORTS (admin) ===================== */
let LAST_REPORT_DATA = null;
// Whichever report is currently on screen (just-saved, or opened from
// history) — the WhatsApp share button reads from here instead of having
// report data (which may contain names with quotes/apostrophes) embedded
// directly into an inline onclick attribute.
let ACTIVE_REPORT_FOR_SHARE = null;

function renderReports(){
  if(!CURRENT_USER.isAdmin) return `<div class="empty" style="padding:40px;"><div class="em-mark">— ADMIN ONLY —</div></div>`;
  return `
    <div class="section-head"><h2>Reports</h2></div>
    <div class="form-card report-dashboard-card">
      <div class="form-row">
        <div>
          <span class="field-label">Report type</span>
          <select id="reportType">
            <option value="task_summary">Task Summary</option>
            <option value="attendance_summary">Attendance Summary</option>
            <option value="department_kpi">All Departments Report</option>
          </select>
        </div>
      </div>
      <div class="form-row" style="gap:8px;">
        <button class="btn-sm" type="button" onclick="setReportPeriod('day')">Today</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('week')">This Week</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('month')">This Month</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('custom')">Custom</button>
      </div>
      <div class="form-row">
        <div><span class="field-label">From (optional)</span><input type="date" id="reportStart"></div>
        <div><span class="field-label">To (optional)</span><input type="date" id="reportEnd"></div>
      </div>
      <div class="report-toolbar">
        <button class="btn-blue" id="genReportBtn" onclick="doSaveReport()">💾 Save Report</button>
        <button class="btn-blue btn-blue-outline" id="resetReportBtn" onclick="resetReportForm()">↺ Reset</button>
      </div>
    </div>
    <div id="reportResult" style="margin-top:18px;"></div>
  `;
}
function setReportPeriod(period){
  const fmt = d => d.toISOString().slice(0,10);
  const today = new Date();
  const startEl = document.getElementById('reportStart');
  const endEl = document.getElementById('reportEnd');
  if(period === 'day'){
    startEl.value = fmt(today);
    endEl.value = fmt(today);
  } else if(period === 'week'){
    const day = today.getDay();
    const diffToMonday = (day === 0 ? -6 : 1 - day);
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMonday);
    startEl.value = fmt(monday);
    endEl.value = fmt(today);
  } else if(period === 'month'){
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    startEl.value = fmt(first);
    endEl.value = fmt(today);
  } else { // custom -- clear back to manual entry, matching the original default
    startEl.value = '';
    endEl.value = '';
  }
}

function renderReportResult(data, opts){
  opts = opts || {};
  ACTIVE_REPORT_FOR_SHARE = data;
  const isAttendance = data.type === 'attendance_summary';
  const isDeptKpi = data.type === 'department_kpi';
  const typeLabel = isDeptKpi ? 'All Departments Report' : (isAttendance ? 'Attendance Summary' : 'Task Summary');
  const chartLabelKey = isDeptKpi ? 'department' : 'name';
  const chartItems = data.rows.map(r => ({
    label: r[chartLabelKey],
    value: isAttendance ? r.hours : (r.avgEfficiency ?? 0),
    color: 'var(--blue)'
  }));
  const range = (data.rangeStart||data.rangeEnd) ? `${data.rangeStart||'…'} to ${data.rangeEnd||'…'}` : 'All time';

  let html = `<div class="form-card report-dashboard-card">`;
  if(opts.showBack){
    html += `<div class="report-toolbar" style="margin-bottom:16px;">
      <button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">← Back to Reports History</button>
      <button class="btn-blue" onclick="shareReportWhatsApp()">📤 Share via WhatsApp</button>
      <button class="btn-blue" onclick="sendReportViaEmailClient()">✉️ Send via Email</button>
    </div>`;
  }
  html += `
    <div class="report-detail-head">
      <h3 style="margin:0;font-size:18px;">${typeLabel}</h3>
      <span class="count mono">${escapeHtml(range)}</span>
    </div>
    <h4 style="margin:16px 0 10px;font-size:14px;color:var(--muted);font-weight:600;text-transform:none;letter-spacing:0;">${isAttendance?'Hours logged':'Avg efficiency %'} by ${isDeptKpi?'department':'employee'}</h4>
    ${svgBarChart(chartItems, {suffix: isAttendance ? 'h' : '%'})}
  </div>`;
  html += `<div class="form-card report-dashboard-card" style="margin-top:14px;overflow-x:auto;">
    ${isDeptKpi ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn-sm" onclick="exportReportCSV()">Export CSV</button></div>` : ''}
    <table class="roster-table"><thead><tr>
    ${isDeptKpi
      ? '<th>Department</th><th>Headcount</th><th>Total</th><th>Open</th><th>Overdue</th><th>Completed</th><th>Efficiency</th><th>Attendance Hrs</th>'
      : (isAttendance ? '<th>Employee</th><th>Shifts</th><th>Hours</th>' : '<th>Employee</th><th>Assigned</th><th>Completed</th><th>Avg Efficiency</th>')}
  </tr></thead><tbody>`;
  data.rows.forEach(r=>{
    if(isDeptKpi){
      html += `<tr>
        <td class="name-cell">${escapeHtml(r.department)}</td>
        <td class="mono">${r.headcount}</td>
        <td class="mono">${r.total}</td>
        <td class="mono">${r.open}</td>
        <td class="mono" style="color:${r.overdue?'var(--rust)':'var(--muted)'}">${r.overdue}</td>
        <td class="mono">${r.completed}</td>
        <td class="mono">${r.avgEfficiency===null?'—':r.avgEfficiency+'%'}</td>
        <td class="mono">${r.attendanceHours}h</td>
      </tr>`;
    } else {
      html += isAttendance
        ? `<tr><td class="name-cell">${escapeHtml(r.name)}</td><td class="mono">${r.shifts}</td><td class="mono">${r.hours}h</td></tr>`
        : `<tr><td class="name-cell">${escapeHtml(r.name)}</td><td class="mono">${r.assigned}</td><td class="mono">${r.completed}</td><td class="mono">${r.avgEfficiency===null?'—':r.avgEfficiency+'%'}</td></tr>`;
    }
  });
  html += `</tbody></table></div>`;
  if(opts.showBack){
    html += `<div class="report-toolbar" style="margin-top:16px;">
      <button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">← Back to Reports History</button>
    </div>`;
  }
  return html;
}
function exportReportCSV(){
  const data = ACTIVE_REPORT_FOR_SHARE;
  if(!data || data.type !== 'department_kpi' || !data.rows.length){ showToast('Nothing to export'); return; }
  const cols = [
    {key:'department', label:'Department'}, {key:'headcount', label:'Headcount'},
    {key:'total', label:'Total'}, {key:'open', label:'Open'}, {key:'overdue', label:'Overdue'},
    {key:'completed', label:'Completed'}, {key:'avgEfficiency', label:'Efficiency %'}, {key:'attendanceHours', label:'Attendance Hours'},
  ];
  const csvEscape = v => `"${String(v===null?'':v).replace(/"/g,'""')}"`;
  const lines = [cols.map(c=>csvEscape(c.label)).join(',')];
  data.rows.forEach(r=>{ lines.push(cols.map(c=>csvEscape(r[c.key])).join(',')); });
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `department_kpi_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function doSaveReport(){
  const type = document.getElementById('reportType').value;
  const rangeStart = document.getElementById('reportStart').value || null;
  const rangeEnd = document.getElementById('reportEnd').value || null;
  const btn = document.getElementById('genReportBtn');
  btn.disabled = true;
  try{
    const res = await apiPost('generate_report', { type, rangeStart, rangeEnd, requestingUserId: CURRENT_USER.id });
    LAST_REPORT_DATA = res.data;
    let resultHtml = renderReportResult(res.data);
    resultHtml += `<div class="report-toolbar" style="margin-top:14px;">
      <button class="btn-blue" onclick="shareReportWhatsApp()">📤 Share via WhatsApp</button>
      <button class="btn-blue" onclick="sendReportViaEmailClient()">✉️ Send via Email</button>
    </div>`;
    document.getElementById('reportResult').innerHTML = resultHtml;
    if(res.emailedTo){
      showToast('Report saved & emailed to ' + res.emailedTo);
    } else {
      // Automatic sending isn't configured/working — fall back to opening the
      // user's own email app with everything pre-filled, so "Save Report"
      // always results in the email actually going out one way or another,
      // without needing a second click on a separate button.
      showToast("Report saved — opening your email app to send it (automatic email isn't set up yet)", true);
      sendReportViaEmailClient();
    }
  }catch(e){
    showToast(e.message || 'Could not save report', true);
  }finally{
    btn.disabled = false;
  }
}
function resetReportForm(){
  const typeEl = document.getElementById('reportType');
  const startEl = document.getElementById('reportStart');
  const endEl = document.getElementById('reportEnd');
  if(typeEl) typeEl.value = 'task_summary';
  if(startEl) startEl.value = '';
  if(endEl) endEl.value = '';
  const resultEl = document.getElementById('reportResult');
  if(resultEl) resultEl.innerHTML = '';
  LAST_REPORT_DATA = null;
  ACTIVE_REPORT_FOR_SHARE = null;
  showToast('Cleared — ready for a new report');
}
function buildReportShareText(data){
  const isAttendance = data.type === 'attendance_summary';
  const isDeptKpi = data.type === 'department_kpi';
  const typeLabel = isDeptKpi ? 'All Departments Report' : (isAttendance ? 'Attendance Summary' : 'Task Summary');
  const range = (data.rangeStart||data.rangeEnd) ? `${data.rangeStart||'…'} to ${data.rangeEnd||'…'}` : 'All time';
  let lines = '';
  data.rows.forEach(r=>{
    if(isDeptKpi){
      lines += `${r.department} (${r.headcount}): ${r.completed}/${r.total} done, ${r.overdue} overdue, ${r.avgEfficiency===null?'—':r.avgEfficiency+'%'} eff, ${r.attendanceHours}h\n`;
    } else if(isAttendance){
      lines += `${r.name}: ${r.shifts} shifts, ${r.hours}h\n`;
    } else {
      lines += `${r.name}: ${r.completed}/${r.assigned} done, ${r.avgEfficiency===null?'—':r.avgEfficiency+'%'} eff\n`;
    }
  });
  return { typeLabel, range, lines };
}
function shareReportWhatsApp(){
  const data = ACTIVE_REPORT_FOR_SHARE;
  if(!data){ showToast('No report to share yet', true); return; }
  const { typeLabel, range, lines } = buildReportShareText(data);
  const msg = `*LOGBOOK ${typeLabel}*\nRange: ${range}\n\n${lines}`;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}
function sendReportViaEmailClient(){
  const data = ACTIVE_REPORT_FOR_SHARE;
  if(!data){ showToast('No report to share yet', true); return; }
  const { typeLabel, range, lines } = buildReportShareText(data);
  const body = `LOGBOOK ${typeLabel}\nRange: ${range}\n\n${lines}`;
  const to = 'ecommerce@canares.com,gajanan@canares.com';
  const subject = `LOGBOOK ${typeLabel} — ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}`;
  // Gmail's own compose screen, opened directly in a new tab — this is far
  // more reliable than a mailto: link, which depends on the OS knowing which
  // installed app should handle it (and picking a browser like Chrome there
  // does nothing, since a browser isn't a mail client). Opens straight into
  // Gmail compose as long as the admin is signed into a Google account in
  // this browser, which is the normal case on Workspace.
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank');
}

/* ===================== REPORTS HISTORY (admin) ===================== */
let REPORT_HISTORY_FILTER_START = '';
let REPORT_HISTORY_FILTER_END = '';
let REPORT_HISTORY_VIEW_ID = null;

async function renderReportHistoryAsync(){
  const main = document.getElementById('mainContent');
  if(!CURRENT_USER.isAdmin){ main.innerHTML = `<div class="empty" style="padding:40px;"><div class="em-mark">— ADMIN ONLY —</div></div>`; return; }

  if(REPORT_HISTORY_VIEW_ID){
    main.innerHTML = `<div class="loading-note">Loading report…</div>`;
    try{
      const res = await apiGet('get_report', { reportId: REPORT_HISTORY_VIEW_ID });
      let html = `<div class="section-head"><h2>Report</h2></div>`;
      html += renderReportResult(res.data, { showBack: true });
      main.innerHTML = html;
    }catch(e){
      main.innerHTML = `<div class="empty" style="padding:24px;color:var(--rust);">Could not load this report.</div>
        <div class="report-toolbar"><button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">← Back to Reports History</button></div>`;
    }
    return;
  }

  main.innerHTML = `<div class="loading-note">Loading report history…</div>`;
  try{
    const histParams = {};
    if(REPORT_HISTORY_FILTER_START) histParams.rangeStart = REPORT_HISTORY_FILTER_START;
    if(REPORT_HISTORY_FILTER_END) histParams.rangeEnd = REPORT_HISTORY_FILTER_END;
    const res = await apiGet('list_reports', histParams);
    const reports = res.reports || [];
    let html = `<div class="section-head"><h2>Reports History</h2><span class="count">${reports.length} saved</span></div>`;
    html += `
      <div class="form-card report-dashboard-card" style="margin-bottom:16px;">
        <div class="form-row">
          <div><span class="field-label">From</span><input type="date" id="reportHistStart" value="${REPORT_HISTORY_FILTER_START}"></div>
          <div><span class="field-label">To</span><input type="date" id="reportHistEnd" value="${REPORT_HISTORY_FILTER_END}"></div>
        </div>
        <div class="report-toolbar">
          <button class="btn-blue" onclick="applyReportHistoryFilter()">Filter</button>
          <button class="btn-blue btn-blue-outline" onclick="clearReportHistoryFilter()">Clear</button>
        </div>
      </div>
    `;
    if(!reports.length){
      html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NONE YET —</div>Save a report from the Reports tab to see it here.</div>`;
    } else {
      html += `<div class="report-dashboard-card form-card" style="overflow-x:auto;padding:0;"><table class="roster-table"><thead><tr><th>Type</th><th>Range</th><th>By</th><th>When</th><th></th></tr></thead><tbody>`;
      reports.forEach(r=>{
        const range = (r.rangeStart||r.rangeEnd) ? `${r.rangeStart||'…'} to ${r.rangeEnd||'…'}` : 'All time';
        html += `<tr>
          <td>${r.type==='attendance_summary'?'Attendance':'Task Summary'}</td>
          <td class="mono" style="font-size:11px;">${range}</td>
          <td>${escapeHtml(r.generatedByName)}</td>
          <td class="mono" style="font-size:11px;">${fmtDateTime(r.createdAt)}</td>
          <td><button class="btn-blue btn-blue-sm" onclick="viewStoredReport('${r.id}')">View</button></td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }
    main.innerHTML = html;
  }catch(e){
    main.innerHTML = `<div class="empty" style="padding:24px;color:var(--rust);">Could not load report history.</div>`;
  }
}
function applyReportHistoryFilter(){
  REPORT_HISTORY_FILTER_START = document.getElementById('reportHistStart').value || '';
  REPORT_HISTORY_FILTER_END = document.getElementById('reportHistEnd').value || '';
  renderReportHistoryAsync();
}
function clearReportHistoryFilter(){
  REPORT_HISTORY_FILTER_START = '';
  REPORT_HISTORY_FILTER_END = '';
  renderReportHistoryAsync();
}
function viewStoredReport(id){
  REPORT_HISTORY_VIEW_ID = id;
  renderReportHistoryAsync();
}
function backToReportHistory(){
  REPORT_HISTORY_VIEW_ID = null;
  renderReportHistoryAsync();
}

/* ===================== INIT ===================== */
(async function init(){
  try{
    await loadAll();
    await applyPendingSsoLogin();
  }catch(e){
    const el = document.getElementById('loginError');
    if(el) el.textContent = "Can't reach the server. Check that the /api/ files and the database are set up.";
  }
})();