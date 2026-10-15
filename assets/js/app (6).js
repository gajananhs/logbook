/* LOGBOOK — application logic and views.
   Data comes from LogbookStore (assets/js/store.js); settings from LOGBOOK_CONFIG
   (assets/js/config.js). This file never touches storage or the network directly. */
const CONFIG = window.LOGBOOK_CONFIG || {};

let USERS = [];
let TASKS = [];
let RAW_TASKS = [];   // everything the store returned; TASKS = this minus not-yet-started tasks assigned to the signed-in user
let SERVER_TODAY = null;
let STATUSES = [];
let ATTENDANCE = [];
let NOTIFICATIONS = [];
let DEPARTMENTS = [];
let SUB_DEPARTMENTS = [];
let CURRENT_USER = null;
let ACTIVE_TAB = 'mine';
let OPEN_UPDATE_FORM = null;
let EDIT_TASK_ID = null;
let EDIT_UPDATE_ID = null;
let HEARTBEAT_TIMER = null;
let NOTIF_POLL_TIMER = null;
let SEEN_NOTIF_IDS = null; // null = baseline not established yet (no beeping on first load)
let LIVESTATUS_TIMER = null;
let LOCATION_PERMISSION_ASKED = false;

/* ===================== DEEP LINKS =====================
   ?empAction=view|assign|comment&emp=<userId> opens the Team board on that
   employee after sign-in, replaying the same click as the matching button. */
let PENDING_EMAIL_ACTION = (function(){
  const p = new URLSearchParams(window.location.search);
  const action = p.get('empAction');
  const emp = p.get('emp');
  if(!action || !emp || ['view','assign','comment'].indexOf(action) === -1) return null;
  return { action, emp };
})();
function applyPendingEmailAction(){
  if(!PENDING_EMAIL_ACTION) return;
  const { action, emp } = PENDING_EMAIL_ACTION;
  PENDING_EMAIL_ACTION = null;
  // Strip the params so a refresh or logout/login doesn't replay the action.
  history.replaceState({}, '', window.location.pathname);
  if(!canSeeTeamBoard(CURRENT_USER)) return;
  if(!USERS.some(u => u.id === emp)) return;
  if(action === 'assign'){
    assignToEmployee(emp); // switches to the Assign tab itself
  } else {
    setTab('team');
    if(action === 'view') viewEmployeeTasks(emp);
    else if(action === 'comment') toggleCommentRow(emp);
  }
}

/* ===================== DATA ACCESS ===================== */
function apiGet(action, params){ return LogbookStore.request(action, params); }
function apiPost(action, payload){ return LogbookStore.request(action, payload); }

async function loadAll(){
  const data = await apiGet('bootstrap');
  USERS = data.users || [];
  RAW_TASKS = data.tasks || [];
  SERVER_TODAY = data.serverDate || null;
  applyScheduleVisibility();
  STATUSES = data.statuses || [];
  ATTENDANCE = data.attendance || [];
  DEPARTMENTS = data.departments || [];
  SUB_DEPARTMENTS = data.subDepartments || [];
}
async function refreshAndRender(){
  try{ await loadAll(); }catch(e){ /* keep showing stale data over nothing */ }
  render();
}

/* ===================== SCHEDULED TASKS · NEWEST-FIRST · LIVE REFRESH ===================== */
/* Tasks created by the Excel import carry an availableFrom (target) date. Until that date they are
   hidden from the employee they're assigned to; everyone else (the assigner, admins, heads) still
   sees them, badged "Starts <date>". On the date the assignee is notified and they simply appear.
   Ordinary tasks have no availableFrom and are always visible. */
function localTodayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function isScheduledForLater(t){
  return !!t.availableFrom && t.availableFrom > (SERVER_TODAY || localTodayISO());
}
function applyScheduleVisibility(){
  TASKS = RAW_TASKS.filter(t => !(CURRENT_USER && t.assignedTo === CURRENT_USER.id && isScheduledForLater(t)));
}

/* Newest-assigned first. "Assigned at" = when the task was created, or for a scheduled task the day it
   went live, whichever is later. Ties (e.g. a bulk import) fall back to earliest due date. */
function assignedAtMs(t){
  const c = new Date(String(t.createdAt).replace(' ','T')).getTime() || 0;
  const a = t.availableFrom ? new Date(t.availableFrom + 'T00:00:00').getTime() : 0;
  return Math.max(c, a);
}
function sortNewestFirst(list){
  return list.slice().sort((a,b)=>
    assignedAtMs(b) - assignedAtMs(a)
    || new Date(a.dueDate||'2999-12-31') - new Date(b.dueDate||'2999-12-31')
    || String(b.id).localeCompare(String(a.id)));
}

/* When a new task arrives for the signed-in user, reload and redraw — but never while they're typing
   into a form (that would wipe what they've written); redraw as soon as they leave it. */
let PENDING_TASK_RERENDER = false;
function userIsTyping(){
  const el = document.activeElement;
  const main = document.getElementById('mainContent');
  return !!(el && main && main.contains(el) && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT'));
}
async function refreshTasksQuietly(){
  if(!CURRENT_USER) return;
  try{ await loadAll(); }catch(e){ return; }
  if(userIsTyping()){ PENDING_TASK_RERENDER = true; return; }
  render();
}
document.addEventListener('focusout', function(){
  if(!PENDING_TASK_RERENDER) return;
  setTimeout(function(){
    if(PENDING_TASK_RERENDER && CURRENT_USER && !userIsTyping()){ PENDING_TASK_RERENDER = false; render(); }
  }, 300);
});
// Browsers slow timers in background tabs, so check for new tasks the moment the tab comes back.
document.addEventListener('visibilitychange', function(){
  if(!document.hidden && CURRENT_USER) refreshNotifications();
});

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
/* Who a given user is allowed to assign tasks to. This controls what the picker
   shows; LogbookStore applies the same rule again when the task is saved. */
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
  if(pct >= 90) return 'var(--ok-ink)';
  if(pct >= 70) return 'var(--warn-ink)';
  return 'var(--red)';
}
function gaugeSVG(pct, size=44){
  const shown = pct === null ? 0 : Math.min(pct,100);
  const r = (size/2) - 4;
  const c = 2*Math.PI*r;
  const offset = c - (shown/100)*c;
  const color = effColor(pct);
  return `<div class="gauge" style="width:${size}px;height:${size}px;">
    <svg width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--sage-soft)" stroke-width="4"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="4"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"/>
    </svg>
    <div class="gauge-val" style="color:${color};">${pct===null?'–':pct+'%'}</div>
  </div>`;
}

/* ===================== ICONS =====================
   One stroke style throughout (24px grid, 1.8 stroke, round caps) — every
   glyph stands for a Logbook concept: entries, people, time, reports. */
const ICON_PATHS = {
  tasks:    '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
  given:    '<path d="M20 4 10.5 13.5M20 4l-6 16-3.5-6.5L4 10z"/>',
  team:     '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.4-3.4 2.8-5.5 6-5.5s5.6 2.1 6 5.5"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.8c2 .6 3.2 2.4 3.5 5.2"/>',
  add:      '<path d="M12 5v14M5 12h14"/>',
  clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  employee: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.5-1.5 1.7-2.3 3.2-2.3s2.7.8 3.2 2.3M15 10h3M15 13.5h3"/>',
  dept:     '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  live:     '<path d="M12 21s6.5-5.6 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  report:   '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 17v-3M12 17v-6M15 17v-2"/>',
  history:  '<path d="M4 12a8 8 0 1 0 2.6-5.900L4 8.5"/><path d="M4 4v4.500h4.500M12 8v4.500l3 1.8"/>',
  logbook:  '<path d="M5 4.500A1.5 1.5 0 0 1 6.5 3H19v15H6.500A1.5 1.5 0 0 0 5 19.500z"/><path d="M5 19.500A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 8h6M9 12h4"/>',
  search:   '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  logout:   '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  back:     '<path d="M15 5l-7 7 7 7"/>',
  chev:     '<path d="M9 5l7 7-7 7"/>',
  edit:     '<path d="M4 20l1-4.500L16.5 4a2.1 2.1 0 0 1 3 3L8 18.500z"/><path d="M14.5 6l3 3"/>',
  trash:    '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  view:     '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  comment:  '<path d="M4 5h16v11H10l-4.5 4v-4H4z"/><path d="M8 9.500h8M8 12.500h5"/>',
  log:      '<path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h6M9 8h3"/>',
  check:    '<path d="M4.5 12.500l5 5 10-11"/>',
  repeat:   '<path d="M4 11V9a3 3 0 0 1 3-3h11l-3-3M20 13v2a3 3 0 0 1-3 3H6l3 3"/>',
  export:   '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.500M5 20h14"/>',
  mail:     '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6.500L20.5 7"/>',
  share:    '<circle cx="6" cy="12" r="2.5"/><circle cx="17.5" cy="6" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.2 10.900l7.1-3.800M8.2 13.100l7.1 3.8"/>',
  save:     '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  reset:    '<path d="M4 12a8 8 0 1 0 2.6-5.900L4 8.5"/><path d="M4 4v4.500h4.5"/>',
  filter:   '<path d="M4 5h16l-6 7.500V19l-4 1.500v-8z"/>',
  link:     '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.700l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.700l1-1"/>',
};
function ic(name){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]||''}</svg>`;
}
function initialsOf(name){
  const parts = String(name||'').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return 'LB';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length-1][0] : (parts[0][1]||''))).toUpperCase();
}

/* ===================== HEADER + CLOCK (presentation only) ===================== */
const MORE_TABS = ['employees','departments','livestatus','reports','reporthistory'];
function pageHeader(tab){
  const now = new Date();
  const back = `<button class="kicker-back" onclick="setTab('more')">${ic('back')}More</button>`;
  switch(tab){
    case 'mine':          return { kicker: now.toLocaleDateString('en-IN', {weekday:'long', month:'long', day:'numeric'}), title: 'Hi, ' + escapeHtml(CURRENT_USER.name.trim().split(/\s+/)[0]) };
    case 'byme':          return { kicker: 'Delegated work', title: 'Assigned by me' };
    case 'team':          return { kicker: CURRENT_USER.isAdmin ? 'Everyone' : 'Your team', title: 'Team board' };
    case 'new':           return { kicker: 'New entry', title: 'Assign task' };
    case 'attendance':    return { kicker: now.toLocaleDateString('en-IN', {month:'long', year:'numeric'}), title: 'Attendance' };
    case 'more':          return { kicker: 'Logbook', title: 'More' };
    case 'employees':     return { kicker: back, title: 'Employees' };
    case 'departments':   return { kicker: back, title: 'Departments' };
    case 'livestatus':    return { kicker: back, title: 'Live status' };
    case 'reports':       return { kicker: back, title: 'Reports' };
    case 'reporthistory': return { kicker: back, title: 'Reports history' };
  }
  return { kicker: 'Logbook', title: 'Logbook' };
}
function renderPageHeader(){
  if(!CURRENT_USER) return;
  const h = pageHeader(ACTIVE_TAB);
  document.getElementById('pageKicker').innerHTML = h.kicker;
  document.getElementById('pageTitle').innerHTML = h.title;
}
function pad2(n){ return n.toString().padStart(2,'0'); }
function tickClock(){
  const now = new Date();
  const sc = document.getElementById('statusclock');
  if(sc) sc.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const hc = document.getElementById('heroClock');
  if(hc) hc.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}
tickClock();
setInterval(tickClock, 1000);

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
  applyScheduleVisibility(); // tasks were loaded before sign-in — re-apply now we know who this is
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainScreen').style.display = 'block';
  document.getElementById('whoName').textContent = CURRENT_USER.name;
  document.getElementById('avatarInitials').textContent = initialsOf(CURRENT_USER.name);
  renderAdminTabs();
  applyRoleTabVisibility();
  const srBtn = document.getElementById('salesReportBtn');
  if(srBtn) srBtn.style.display = canGoBackToSalesReport(CURRENT_USER) ? '' : 'none';
  startHeartbeat();
  refreshNotifications();
  startNotifPolling();
  setTab(startTabFromUrl());
  applyPendingEmailAction();
  refreshAndRender(); // the page may have sat on the sign-in screen a while — pull fresh tasks
}
// App shortcuts (manifest.json) open ./?tab=new or ./?tab=attendance.
function startTabFromUrl(){
  const wanted = new URLSearchParams(window.location.search).get('tab');
  const allowed = ['mine', 'byme', 'new', 'attendance'].concat(canSeeTeamBoard(CURRENT_USER) ? ['team'] : []);
  return allowed.indexOf(wanted) !== -1 ? wanted : 'mine';
}
function applyRoleTabVisibility(){
  // Team Board shows other people's tasks — plain employees only get their
  // own Assigned to Me / Assigned by Me, never a team roster.
  const teamTabBtn = document.querySelector('.tab[data-tab="team"]');
  if(teamTabBtn) teamTabBtn.style.display = canSeeTeamBoard(CURRENT_USER) ? '' : 'none';
}
// "Back to Sales Report": admins, plus the departments listed in LOGBOOK_CONFIG.salesReportDepartments
// (marketing and the CEO's office by default). Hidden for everyone when no address is configured.
function canGoBackToSalesReport(user){
  if(!user || !CONFIG.salesReportUrl) return false;
  if(user.isAdmin) return true;
  const words = (CONFIG.salesReportDepartments || []).map(w => String(w).trim().toLowerCase()).filter(Boolean);
  const places = [deptName(user.departmentId), subDeptName(user.subDepartmentId), user.department]
    .filter(Boolean).map(x => String(x).toLowerCase());
  return words.some(w => places.some(p => p.indexOf(w) !== -1));
}
function backToSalesReport(){
  if(CONFIG.salesReportUrl) window.location.href = CONFIG.salesReportUrl;
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
  // Admin pages (Employees, Departments, Live status, Reports, Reports history)
  // are listed on the More page — see renderMore(). Nothing to inject here.
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
    let taskListChanged = false;
    if(SEEN_NOTIF_IDS !== null){
      const isFresh = n => !SEEN_NOTIF_IDS.has(n.id);
      const isAssignment = n => /^New tasks? assigned:/.test(n.message);
      const freshAssignment = newList.find(n => isFresh(n) && isAssignment(n));
      if(freshAssignment){ playAssignmentBeep(); showToast(freshAssignment.message); }
      taskListChanged = newList.some(n => isFresh(n) && (isAssignment(n) || /^Repeated task renewed:/.test(n.message)));
    }
    NOTIFICATIONS = newList;
    SEEN_NOTIF_IDS = new Set(newList.map(n=>n.id));
    renderBellBadge();
    if(document.getElementById('notifPanel').style.display === 'block') renderNotifPanel();
    if(taskListChanged) refreshTasksQuietly(); // new task -> list updates itself, no manual reload
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
/* One shared AudioContext, unlocked by the user's first tap/click/key. Browsers start a context
   created from a background timer "suspended", so a fresh context per beep would stay silent. */
let BEEP_CTX = null;
let BEEP_PRIMED = false;
function getBeepCtx(){
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx) return null;
  if(!BEEP_CTX || BEEP_CTX.state === 'closed') BEEP_CTX = new Ctx();
  return BEEP_CTX;
}
function unlockBeepAudio(){
  try{
    const ctx = getBeepCtx();
    if(!ctx) return;
    if(ctx.state === 'suspended') ctx.resume();
    if(!BEEP_PRIMED){ // a silent blip inside the gesture — the only way iOS/Safari unlock audio
      const o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = 0.0001; o.connect(g); g.connect(ctx.destination);
      o.start(0); o.stop(ctx.currentTime + 0.02);
      BEEP_PRIMED = true;
    }
  }catch(e){ /* never let audio break the app */ }
}
['pointerdown','touchstart','click','keydown'].forEach(function(ev){
  document.addEventListener(ev, unlockBeepAudio, { passive: true });
});
function playAssignmentBeep(){
  let ctx = null;
  try{ ctx = getBeepCtx(); }catch(e){}
  const fallback = function(){
    try{ if(navigator.vibrate) navigator.vibrate([200,100,200]); }catch(e){}
  };
  if(!ctx){ fallback(); return; }
  const ring = function(){
    try{
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
      tone(1175, 0.16, 0.28); // D6 — short two-note "ding-ding", no audio file needed
    }catch(e){ /* audio blocked/unavailable */ }
  };
  if(ctx.state === 'running'){ ring(); return; }
  const blocked = function(){
    fallback();
    showToast('Tap anywhere once to switch on the new-task alert sound');
  };
  try{
    ctx.resume().then(function(){ if(ctx.state === 'running') ring(); else blocked(); }).catch(blocked);
  }catch(e){ blocked(); }
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
  EDIT_EMP_ID = null;
  SHOW_ADD_EMP = false;
  SHOW_ADD_DEPT = false;
  ADD_SUBDEPT_FOR = null;
  COMMENT_FOR_ID = null;
  TEAM_SEARCH = '';
  if(tab !== 'team') TEAM_SELECTED_ID = null;
  VIEW_TASKS_FOR_ID = null;
  MARK_COMPLETE_FOR_ID = null;
  PENDING_COMPLETE_STATUS_ID = null;
  document.getElementById('notifPanel').style.display = 'none';
  document.querySelectorAll('.tab').forEach(t=>{
    const on = t.dataset.tab===tab || (t.dataset.tab==='more' && MORE_TABS.indexOf(tab) !== -1);
    t.classList.toggle('active', on);
    if(on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  render();
  const screenEl = document.getElementById('screen');
  if(screenEl) screenEl.scrollTop = 0;

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
  renderPageHeader();
  if(ACTIVE_TAB === 'mine') main.innerHTML = renderMyBoard();
  else if(ACTIVE_TAB === 'byme') main.innerHTML = renderAssignedByMe();
  else if(ACTIVE_TAB === 'team') main.innerHTML = renderTeamBoard();
  else if(ACTIVE_TAB === 'new') main.innerHTML = renderNewEntry();
  else if(ACTIVE_TAB === 'attendance') main.innerHTML = renderAttendance();
  else if(ACTIVE_TAB === 'employees') main.innerHTML = renderEmployees();
  else if(ACTIVE_TAB === 'departments') main.innerHTML = renderDepartments();
  else if(ACTIVE_TAB === 'livestatus') main.innerHTML = renderLiveStatus();
  else if(ACTIVE_TAB === 'reports') main.innerHTML = renderReports();
  else if(ACTIVE_TAB === 'reporthistory') renderReportHistoryAsync();
  else if(ACTIVE_TAB === 'more') main.innerHTML = renderMore();
}

/* ===================== MORE ===================== */
function moreRow(tab, icon, name, sub){
  return `<button class="row-item" onclick="setTab('${tab}')">
    <span class="row-lead"><span class="row-icon">${ic(icon)}</span><span><span class="pname" style="display:block;">${name}</span><span class="psub" style="display:block;">${sub}</span></span></span>
    <span class="row-chev">${ic('chev')}</span>
  </button>`;
}
function renderMore(){
  const u = CURRENT_USER;
  let html = '';
  if(u.isAdmin){
    html += `<div class="card"><h3>Admin</h3>
      ${moreRow('employees', 'employee', 'Employees', USERS.length + ' people · roles, PINs, access')}
      ${moreRow('departments', 'dept', 'Departments', DEPARTMENTS.length + ' departments · ' + SUB_DEPARTMENTS.length + ' sub-departments')}
      ${moreRow('livestatus', 'live', 'Live status', USERS.filter(isOnline).length + ' online now · last seen and location')}
      ${moreRow('reports', 'report', 'Reports', 'Task, attendance and department summaries')}
      ${moreRow('reporthistory', 'history', 'Reports history', 'Every report saved so far')}
    </div>`;
  }
  html += `<div class="card"><h3>Account</h3>
    <div class="mini-row"><span>Signed in as</span><span>${escapeHtml(u.name)}</span></div>
    <div class="mini-row"><span>Role</span><span>${orgRoleLabel(u.orgRole)}${u.isAdmin ? ' <span class="admin-badge">Admin</span>' : ''}</span></div>
    <div class="mini-row"><span>Department</span><span>${escapeHtml(orgContextLabel(u))}</span></div>
  </div>`;
  html += `<div class="card" style="padding-top:8px;padding-bottom:8px;">
    ${canGoBackToSalesReport(u) ? `<button class="row-item" id="backToSalesReportBtn" onclick="backToSalesReport()">
      <span class="row-lead"><span class="row-icon">${ic('link')}</span><span class="pname">Back to Sales Report</span></span>
      <span class="row-chev">${ic('chev')}</span>
    </button>` : ''}
    <button class="row-item" onclick="resetDeviceData()">
      <span class="row-lead"><span class="row-icon">${ic('reset')}</span><span><span class="pname" style="display:block;">Reset this device</span><span class="psub" style="display:block;">Erases changes saved here and restores the starting data</span></span></span>
    </button>
    <button class="row-item danger" onclick="switchUser()">
      <span class="row-lead"><span class="row-icon">${ic('logout')}</span><span class="pname">Logout</span></span>
    </button>
  </div>`;
  return html;
}

async function resetDeviceData(){
  if(!confirm('Reset Logbook on this device? Every task, update, shift, PIN and employee change saved here is erased and the starting data is restored.')) return;
  await LogbookStore.reset();
  switchUser();
  await loadAll();
  showToast('Logbook reset on this device');
}

/* ===================== MY BOARD ===================== */
function renderMyBoard(){
  const mine = sortNewestFirst(TASKS.filter(t=>t.assignedTo === CURRENT_USER.id)); // newest assigned on top
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
    <div class="section-head"><h2>My board</h2><span class="count">${mine.length} total</span></div>
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
  const givenOut = sortNewestFirst(TASKS.filter(t=>t.assignedBy === CURRENT_USER.id && t.assignedTo !== CURRENT_USER.id)); // newest first
  const open = givenOut.filter(t=>!isTaskDone(t));
  const overdue = givenOut.filter(isOverdue);

  let html = `
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${givenOut.length}</div><div class="lbl">Handed out</div></div>
      <div class="stat-box"><div class="num">${open.length}</div><div class="lbl">Still open</div></div>
      <div class="stat-box"><div class="num" style="color:${overdue.length?'var(--rust)':'var(--text)'}">${overdue.length}</div><div class="lbl">Overdue</div></div>
    </div>
    <div class="section-head"><h2>Handed out</h2><span class="count">${givenOut.length} total</span></div>
  `;

  if(!givenOut.length){
    html += `<div class="empty"><div class="em-mark">— NOTHING HANDED OUT —</div>Tasks you assign to someone else will show up here so you can track them.</div>`;
    return html;
  }
  givenOut.forEach(t=>{ html += taskCard(t, false); });
  return html;
}

/* ===================== TASK CARD ===================== */
/* opts.comments: 'full' = every update in full (Team board -> View), 'none' = hide updates
   (compact Team board lists), omitted = latest 4 (My board, Assigned by me). */
function taskCard(t, showActions, opts){
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
  if(isScheduledForLater(t)) badges += `<span class="badge open">${ic('clock')} Starts ${fmtDate(t.availableFrom)}</span>`;
  if(t.repeatType && t.repeatType !== 'none'){
    const label = t.repeatType.charAt(0).toUpperCase() + t.repeatType.slice(1);
    badges += `<span class="badge repeat">${ic('repeat')} ${label}</span>`;
  }

  const gauge = isTaskDone(t) ? gaugeSVG(eff) : '';

  let actions = '';
  if(showActions && !isTaskDone(t)){
    const loggedHrs = totalHoursLogged(t);
    const renewBtn = (t.repeatType && t.repeatType !== 'none')
      ? `<button class="btn-sm" onclick="submitRenewTask('${t.id}')" title="Generate the next occurrence now without marking this one complete">${ic('repeat')}Renew</button>` : '';
    actions += `
      <div class="task-actions">
        <button class="btn-sm primary" onclick="toggleUpdateForm('${t.id}')">${ic('log')}Log update</button>
        <button class="btn-sm done" onclick="toggleMarkCompleteForm('${t.id}')">${ic('check')}Mark complete</button>
        ${renewBtn}
        ${isAssigner ? `<button class="btn-sm" onclick="toggleEditTask('${t.id}')">${ic('edit')}Edit</button>
        <button class="btn-sm danger" onclick="deleteTaskConfirm('${t.id}')">${ic('trash')}Delete</button>` : ''}
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
        <p class="lede" style="margin:0 0 10px;">To calculate efficiency, this needs an estimate and the actual hours it took.</p>
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
        <button class="btn-sm" onclick="toggleEditTask('${t.id}')">${ic('edit')}Edit</button>
        <button class="btn-sm danger" onclick="deleteTaskConfirm('${t.id}')">${ic('trash')}Delete</button>
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
            <label class="check-label">
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
  const commentMode = (opts && opts.comments) || 'default';
  if(commentMode === 'full'){
    logList = `<div class="log-list"><div class="field-label" style="margin-bottom:6px;">Comments</div>`
      + (ups.length ? ups.map(u=>renderLogEntry(t,u,true)).join('') : `<div class="footnote" style="padding:0;">No comments logged yet.</div>`)
      + `<div class="comment-form">
          <textarea placeholder="Write a comment…" aria-label="Comment on ${escapeHtml(t.title)}"></textarea>
          <button class="btn-sm primary" type="button" onclick="submitTaskComment('${t.id}', this)">${ic('comment')}Save comment</button>
        </div>`
      + `</div>`;
  } else if(commentMode !== 'none' && ups.length){
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
      ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%;background:${isTaskDone(t)?'var(--sage)':'var(--amber)'}"></div></div>
      ${actions}
      ${logList}
    </div>
  `;
}

function renderLogEntry(t, u, full){
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
    <span style="flex:1;${full?'white-space:pre-wrap;':''}">${u.progressPct}% · ${escapeHtml(userName(u.byUserId))}${u.hoursLogged?` · ${u.hoursLogged}h`:''}${u.note?' — '+escapeHtml(u.note):''}</span>
    ${mine ? `<span style="flex-shrink:0;display:flex;gap:8px;">
      <button class="log-link" onclick="toggleEditUpdate('${u.id}')">edit</button>
      <button class="log-link danger" onclick="deleteUpdateConfirm('${u.id}')">del</button>
    </span>` : ''}
  </div>`;
}

/* Comment on a task from the Team board. A comment is an update that carries only a note:
   the task's progress is left exactly where it was and no hours are added. You can edit or
   delete your own comments afterwards with the links beside them. */
async function submitTaskComment(taskId, btn){
  const t = TASKS.find(x=>x.id===taskId);
  const form = btn.closest('.comment-form');
  const box = form && form.querySelector('textarea');
  if(!t || !box) return;
  const note = box.value.trim();
  if(!note){ showToast('Write a comment first'); box.focus(); return; }
  const progress = latestProgress(t);
  btn.disabled = true;
  try{
    const res = await apiPost('add_update', { taskId, progressPct: progress, hoursLogged: null, note, byUserId: CURRENT_USER.id });
    t.updates = t.updates || [];
    t.updates.push({ id: res.id, date: res.date, progressPct: progress, hoursLogged: null, note, byUserId: CURRENT_USER.id });
    showToast('Comment saved');
    render();
  }catch(e){
    btn.disabled = false;
    showToast(e.message || 'Could not save the comment', true);
  }
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
    if(newStart) payload.startDate = newStart; // omitted otherwise: the existing due date is kept
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
   here (their own data lives on Assigned to Me instead). */
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
    <div class="section-head"><h2>Roster</h2>
      <div class="toolbar">
        ${typeof importExcelButtonHtml === 'function' ? importExcelButtonHtml() : ''}
        ${CURRENT_USER.isAdmin ? `<button class="btn-sm" onclick="sendTeamSummary()">${ic('mail')}Email summary</button>
        <button class="btn-sm" onclick="shareTeamSummaryWhatsApp()">${ic('share')}Share via WhatsApp</button>` : ''}
        <span class="count">${scopedUsers.length} people</span>
      </div>
    </div>
    ${typeof importExcelPanelHtml === 'function' ? importExcelPanelHtml() : ''}
  `;

  if(!scopedUsers.length){
    html += `<div class="empty"><div class="em-mark">— NO ROSTER —</div>No one's clocked in yet.</div>`;
    return html;
  }

  html += teamSearchHtml(scopedUsers, scopedTasks);

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

  html += `<div class="table-card"><table class="roster-table"><thead><tr>
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
      <td><div class="row-actions">
        <button class="btn-sm" onclick="viewEmployeeTasks('${u.id}')">${ic('view')}${VIEW_TASKS_FOR_ID===u.id?'Hide':'View'}</button>
        <button class="btn-sm" onclick="assignToEmployee('${u.id}')">${ic('add')}Assign</button>
        <button class="btn-sm" onclick="toggleCommentRow('${u.id}')">${ic('comment')}Comment</button>
      </div></td>
    </tr>`;
    if(VIEW_TASKS_FOR_ID === u.id){
      const sorted = sortNewestFirst(userTasks);
      html += `<tr><td colspan="6" class="expand">`;
      if(!sorted.length){
        html += `<div class="empty" style="padding:16px;"><div class="em-mark">— NO TASKS —</div>Nothing assigned to ${escapeHtml(u.name)} yet.</div>`;
      } else {
        sorted.forEach(t=>{ html += taskCard(t, false, { comments: 'full' }); }); // View = task details + the complete comments
      }
      html += `</td></tr>`;
    }
    if(COMMENT_FOR_ID === u.id){
      html += `<tr><td colspan="6" class="expand">
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
    html += `<div class="section-head" style="margin-top:26px;"><h2>Needs attention</h2><span class="count">${attention.length}</span></div>`;
    attention.forEach(t=>{ html += taskCard(t, false, { comments: 'none' }); });
  }

  if(canSeeTeamBoard(CURRENT_USER)){
    const empOptions = `<option value="all">All employees</option>` + scopedUsers.map(u=>`<option value="${u.id}" ${TEAMBOARD_FILTER_EMP===u.id?'selected':''}>${escapeHtml(u.name)}</option>`).join('');
    const statusOptions = `<option value="all">All statuses</option>` + STATUSES.map(s=>`<option value="${s.id}" ${TEAMBOARD_FILTER_STATUS===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
    let allTasks = sortNewestFirst(scopedTasks);
    if(TEAMBOARD_FILTER_EMP !== 'all') allTasks = allTasks.filter(t=>t.assignedTo===TEAMBOARD_FILTER_EMP);
    if(TEAMBOARD_FILTER_STATUS !== 'all') allTasks = allTasks.filter(t=>t.status===TEAMBOARD_FILTER_STATUS);

    html += `<div class="section-head" id="allTasksSection" style="margin-top:26px;"><h2>All tasks</h2><span class="count">${allTasks.length} of ${scopedTasks.length}</span></div>`;
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
      allTasks.forEach(t=>{ html += taskCard(t, false, { comments: 'none' }); });
    }
  }

  return html;
}
let TEAMBOARD_FILTER_EMP = 'all';
let TEAMBOARD_FILTER_STATUS = 'all';
let TEAMBOARD_ROSTER_FILTER = 'all';

/* ---------- Team board: find an employee by name, see their tasks, assign ---------- */
let TEAM_SEARCH = '';            // what is typed in the search box
let TEAM_SELECTED_ID = null;     // employee picked from the results

/* Partial, forgiving match: capital letters, spaces and punctuation don't matter, the words can be
   in any order, and each typed word only has to appear somewhere in the name ("ram pan" finds
   "Ramji pandey", "nith" finds "sunitha"). Names that START with the text are listed first. */
function teamSearchNorm(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function teamSearchMatches(query, users){
  const q = teamSearchNorm(query);
  if(!q) return [];
  const words = q.split(' ');
  const squashed = q.replace(/ /g, '');
  return users
    .map(u => {
      const name = teamSearchNorm(u.name);
      const hit = words.every(w => name.indexOf(w) !== -1) || name.replace(/ /g, '').indexOf(squashed) !== -1;
      if(!hit) return null;
      const rank = name.indexOf(q) === 0 ? 0 : (name.split(' ').some(part => part.indexOf(words[0]) === 0) ? 1 : 2);
      return { u, rank };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.u.name.localeCompare(b.u.name))
    .map(x => x.u);
}
function teamScopedUsers(){
  const ids = visibleTeamUserIds(CURRENT_USER);
  return USERS.filter(u => ids.includes(u.id));
}
function teamSearchResultsHtml(scopedUsers){
  if(!teamSearchNorm(TEAM_SEARCH)) return '';
  const hits = teamSearchMatches(TEAM_SEARCH, scopedUsers);
  if(!hits.length) return `<div class="empty" style="padding:12px 6px 4px;">No employee matches “${escapeHtml(TEAM_SEARCH.trim())}”.</div>`;
  const shown = hits.slice(0, 8);
  return `<div class="search-results" role="listbox" aria-label="Matching employees">` + shown.map(u => {
    const open = TASKS.filter(t => t.assignedTo === u.id && !isTaskDone(t)).length;
    return `<button class="row-item" type="button" role="option" onclick="selectTeamEmployee('${u.id}')">
      <span class="row-lead"><span class="avatar" aria-hidden="true">${escapeHtml(initialsOf(u.name))}</span>
        <span><span class="pname" style="display:block;">${escapeHtml(u.name)}</span><span class="psub" style="display:block;">${escapeHtml(orgContextLabel(u))}</span></span></span>
      <span class="badge open">${open} open</span>
    </button>`;
  }).join('') + (hits.length > shown.length ? `<p class="footnote" style="padding:8px 2px 0;">${hits.length - shown.length} more — keep typing to narrow it down.</p>` : '') + `</div>`;
}
function teamSelectedHtml(scopedUsers, scopedTasks){
  const u = scopedUsers.find(x => x.id === TEAM_SELECTED_ID);
  if(!u) return '';
  const rank = t => isTaskDone(t) ? 1 : 0; // open work first, each group newest first
  const tasks = sortNewestFirst(scopedTasks.filter(t => t.assignedTo === u.id)).sort((a, b) => rank(a) - rank(b));
  const openCount = tasks.filter(t => !isTaskDone(t)).length;
  const overdueCount = tasks.filter(isOverdue).length;
  let html = `<div class="card" id="teamSelected">
    <h3><span>${escapeHtml(u.name)}</span><button class="btn-sm" onclick="clearTeamEmployee()">Close</button></h3>
    <p class="psub" style="margin:-6px 0 12px;">${escapeHtml(orgContextLabel(u))}</p>
    <div class="stat-strip" style="margin-bottom:12px;">
      <div class="stat-box"><div class="num">${openCount}</div><div class="lbl">Open</div></div>
      <div class="stat-box"><div class="num" style="color:${overdueCount ? 'var(--red)' : 'var(--ink)'}">${overdueCount}</div><div class="lbl">Overdue</div></div>
      <div class="stat-box"><div class="num">${tasks.length - openCount}</div><div class="lbl">Completed</div></div>
    </div>
    <button class="btn-primary" onclick="assignToEmployee('${u.id}')">${ic('add')}Assign task</button>
  </div>
  <div class="section-head"><h2>Tasks assigned to ${escapeHtml(u.name)}</h2><span class="count">${tasks.length} total</span></div>`;
  if(!tasks.length){
    html += `<div class="empty" style="padding:16px 6px 24px;"><div class="em-mark">— NO TASKS —</div>Nothing assigned to ${escapeHtml(u.name)} yet.</div>`;
  } else {
    tasks.forEach(t => { html += taskCard(t, false, { comments: 'full' }); });
  }
  return html;
}
function teamSearchHtml(scopedUsers, scopedTasks){
  return `
    <div class="field team-search">
      <label for="teamSearch">Find an employee</label>
      <div class="search-box">
        ${ic('search')}
        <input type="search" id="teamSearch" placeholder="Type part of a name" autocomplete="off" autocapitalize="off" spellcheck="false"
          value="${escapeHtml(TEAM_SEARCH)}" oninput="onTeamSearchInput(this.value)" onkeydown="onTeamSearchKey(event)">
      </div>
      <div id="teamSearchResults">${teamSearchResultsHtml(scopedUsers)}</div>
    </div>
    ${teamSelectedHtml(scopedUsers, scopedTasks)}
  `;
}
// Typing only redraws the result list, so the keyboard and cursor stay where they are.
function onTeamSearchInput(value){
  TEAM_SEARCH = value;
  const box = document.getElementById('teamSearchResults');
  if(box) box.innerHTML = teamSearchResultsHtml(teamScopedUsers());
}
function onTeamSearchKey(e){
  if(e.key === 'Enter'){
    const first = teamSearchMatches(TEAM_SEARCH, teamScopedUsers())[0];
    if(first) selectTeamEmployee(first.id);
  } else if(e.key === 'Escape'){
    onTeamSearchInput(''); e.target.value = '';
  }
}
function selectTeamEmployee(id){
  TEAM_SELECTED_ID = id;
  TEAM_SEARCH = '';
  if(VIEW_TASKS_FOR_ID === id) VIEW_TASKS_FOR_ID = null; // never show the same person's tasks twice on one page
  render();
  const panel = document.getElementById('teamSelected');
  if(panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'start' });
}
function clearTeamEmployee(){
  TEAM_SELECTED_ID = null;
  render();
}
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
  if(VIEW_TASKS_FOR_ID && TEAM_SELECTED_ID === userId) TEAM_SELECTED_ID = null;
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
function buildTeamSummaryText(){
  const scopeIds = visibleTeamUserIds(CURRENT_USER);
  const scopedUsers = USERS.filter(u=>scopeIds.includes(u.id));
  const scopedTasks = TASKS.filter(t=>scopeIds.includes(t.assignedTo));
  const totalOpen = scopedTasks.filter(t=>!isTaskDone(t)).length;
  const totalOverdue = scopedTasks.filter(isOverdue).length;
  const effs = scopedTasks.filter(isTaskDone).map(efficiencyPct).filter(v=>v!==null);
  const avgEff = effs.length ? Math.round(effs.reduce((a,b)=>a+b,0)/effs.length) : null;
  const dateLabel = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});

  let body = `Total tasks: ${scopedTasks.length}\nOpen: ${totalOpen}\nOverdue: ${totalOverdue}\nAvg efficiency: ${avgEff===null?'—':avgEff+'%'}\n\n`;
  scopedUsers.slice(0, 15).forEach(u=>{
    const userTasks = scopedTasks.filter(t=>t.assignedTo===u.id);
    const open = userTasks.filter(t=>!isTaskDone(t)).length;
    const overdue = userTasks.filter(isOverdue).length;
    body += `${u.name}: ${open} open${overdue?`, ${overdue} overdue`:''}\n`;
  });
  return { dateLabel, body };
}
function openEmailCompose(subject, body){
  const to = CONFIG.summaryEmailTo || '';
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank');
}
function openWhatsApp(text){
  const phone = String(CONFIG.whatsappNumber || '').replace(/\D/g, '');
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank');
}
function sendTeamSummary(){
  const { dateLabel, body } = buildTeamSummaryText();
  openEmailCompose(`LOGBOOK Team Summary — ${dateLabel}`, `LOGBOOK Team Summary — ${dateLabel}\n\n${body}`);
}
function shareTeamSummaryWhatsApp(){
  const { dateLabel, body } = buildTeamSummaryText();
  openWhatsApp(`*LOGBOOK Team Summary* — ${dateLabel}\n\n${body}`);
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
    ? 'Add employees from the Employees page to assign tasks to them.'
    : 'Only department and sub-department heads can assign tasks to others — you can still assign tasks to yourself.';
  return `
    <div class="form-card">
      <div class="assign-toggle">
        <button type="button" class="${SELF_ASSIGN_MODE?'active':''}" onclick="setAssignMode(true)">For myself</button>
        <button type="button" class="${SELF_ASSIGN_MODE?'':'active'}" ${others.length?'':'disabled title="No one you can assign to yet"'} onclick="setAssignMode(false)">For someone else</button>
      </div>
      ${others.length ? '' : `<p class="footnote" style="margin:-6px 0 12px;">${noOthersMsg}</p>`}
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
          <label class="check-label">
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
      <button class="btn-amber" id="addTaskBtn" onclick="submitNewTask()">${ic('add')}Add to board</button>
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
  disp.textContent = d.toISOString().slice(0,10);
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
    due = null; // the data layer calculates the due date from Work Type + Start Date
  }

  const btn = document.getElementById('addTaskBtn');
  btn.disabled = true;

  try{
    const res = await apiPost('add_task', {
      title, description: desc || null, assignedTo: assignee, assignedBy: CURRENT_USER.id,
      dueDate: due || null, estimatedHours: est, statusId,
      repeatType, startDate: repeatStart
    });
    const added = {
      id: res.id, title, description: desc, assignedTo: assignee, assignedBy: CURRENT_USER.id,
      createdAt: new Date().toISOString(), dueDate: res.dueDate || due || null, estimatedHours: est,
      status: res.statusId || statusId, updates: [], completedAt: null, actualHours: null,
      repeatType: res.repeatType || repeatType, repeatParentId: null, availableFrom: null
    };
    RAW_TASKS.unshift(added);
    TASKS.unshift(added);
    showToast(repeatOn ? 'Repeating task added \u2014 due ' + (res.dueDate || '') : 'Task added');
    setTab('mine');
  }catch(e){
    showToast(e.message || 'Could not add task', true);
  }finally{
    btn.disabled = false;
  }
}

/* ===================== CHART HELPERS ===================== */
function svgBarChart(items, opts){
  opts = opts || {};
  const max = Math.max(1, ...items.map(i=>i.value));
  const barH = 22, gap = 10, labelW = 130, chartW = 220;
  const h = items.length * (barH+gap);
  let bars = items.map((it,i)=>{
    const y = i*(barH+gap);
    const w = Math.max(2, (it.value/max)*chartW);
    return `
      <text x="0" y="${y+barH*0.7}" font-size="11" fill="var(--muted)" font-family="'IBM Plex Sans',sans-serif">${escapeHtml(it.label)}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="5" fill="${it.color||'var(--amber)'}"/>
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
  { key:'employeeName', label:'Employee' },
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
  let html = `<div class="table-card"><table class="roster-table"><thead><tr>`;
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
  const nowT = new Date();
  let html = `
    <div class="hero">
      <div class="label">TODAY</div>
      <div class="time" id="heroClock">${pad2(nowT.getHours())}:${pad2(nowT.getMinutes())}:${pad2(nowT.getSeconds())}</div>
      <div class="sub">${openRow ? 'Clocked in at ' + fmtDateTime(openRow.clockIn) : 'Not clocked in yet'}</div>
      <button class="checkin-btn ${openRow?'checked':''}" onclick="${openRow?'doClockOut()':'doClockIn()'}">${openRow?'Clock out':'Clock in'}</button>
    </div>
    <div class="gps-note" style="margin:-8px 0 14px;">Your location is captured with each clock in/out.</div>
  `;
  html += `<div class="section-head"><h2>My timeline</h2><button class="btn-sm" onclick="exportAttendanceCSV()">${ic('export')}Export CSV</button></div>`;
  if(!mine.length){
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NO SHIFTS YET —</div>Clock in to start your timeline.</div>`;
  } else {
    html += renderAttendanceTable(mine, false);
  }

  if(canSeeTeamBoard(CURRENT_USER)){
    const scopeIds = visibleTeamUserIds(CURRENT_USER);
    const teamLabel = CURRENT_USER.isAdmin ? "Everyone's timeline" : "My team's timeline";
    html += `<div class="section-head" style="margin-top:20px;"><h2>${teamLabel}</h2></div>`;
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
  let html = `<div class="section-head"><h2>Everyone</h2><span class="count">${USERS.length} total</span></div>`;

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
            <button class="btn-sm danger" style="margin-left:auto;" onclick="submitDeleteEmployee('${u.id}')">${ic('trash')}Delete</button>
          </div>
        </div>
      `;
    } else {
      const roleBadge = u.orgRole==='dept_head' ? `<span class="admin-badge role">Dept Head</span>`
        : u.orgRole==='sub_head' ? `<span class="admin-badge role">Sub Head</span>` : '';
      html += `
        <div class="emp-row">
          <span class="online-dot ${isOnline(u)?'on':'off'}"></span>
          <div class="emp-main">
            <div class="emp-name">${escapeHtml(u.name)} ${u.isAdmin?'<span class="admin-badge">Admin</span>':''} ${roleBadge}</div>
            <div class="emp-meta">${orgContextLabel(u)}${u.phone?' · '+escapeHtml(u.phone):''}${u.hasPin?' · PIN set':' · no PIN'}</div>
          </div>
          <button class="btn-sm" onclick="toggleEditEmp('${u.id}')">${ic('edit')}Manage</button>
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
      <p class="footnote" style="margin:-4px 0 10px;">Set their role, department, and sub-department afterward via Manage — this just gets them into the system.</p>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm primary" onclick="submitAddEmployee()">Add employee</button>
        <button class="btn-sm" onclick="toggleAddEmp()">Cancel</button>
      </div>
    ` : `<button class="btn-amber" onclick="toggleAddEmp()">${ic('add')}Add employee</button>`}
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
  let html = `<div class="section-head"><h2>Structure</h2><span class="count">${DEPARTMENTS.length} total</span></div>
    <p class="lede">
      Department Heads can assign tasks to anyone in their department (sub-department heads or employees directly).
      Sub-department Heads can assign tasks to employees in their own sub-department. Set each person's role and
      department from the Employees page.
    </p>`;

  if(!DEPARTMENTS.length){
    html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NONE YET —</div>Add a department below to get started.</div>`;
  }

  DEPARTMENTS.forEach(d=>{
    const subs = SUB_DEPARTMENTS.filter(s=>s.departmentId===d.id);
    html += `<div class="status-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="st-name">${escapeHtml(d.name)}</span>
        <button class="btn-sm" onclick="toggleAddSubDept('${d.id}')">${ic('add')}Sub-department</button>
        <button class="btn-sm danger" onclick="deleteDepartmentConfirm('${d.id}')">${ic('trash')}Delete</button>
      </div>
      ${subs.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
        ${subs.map(s=>`
          <div class="sub-row">
            <span style="flex:1;font-size:13px;">${escapeHtml(s.name)}</span>
            <button class="btn-sm danger" onclick="deleteSubDepartmentConfirm('${s.id}')">${ic('trash')}Delete</button>
          </div>
        `).join('')}
      </div>` : `<p class="footnote" style="margin:8px 0 0;padding:0;">No sub-departments yet.</p>`}
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
    ` : `<button class="btn-amber" onclick="toggleAddDept()">${ic('add')}Add department</button>`}
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
      <div class="stat-box"><div class="num">${onlineCount}</div><div class="lbl">Online now</div></div>
      <div class="stat-box"><div class="num">${USERS.length}</div><div class="lbl">Total employees</div></div>
    </div>
    <div class="section-head"><h2>Live employee status</h2></div>
  `;
  html += `<div class="table-card"><table class="roster-table"><thead><tr><th>Employee</th><th>Status</th><th>Last Seen</th><th>Last Location</th></tr></thead><tbody>`;
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
  html += `<p class="footnote">Location updates automatically every 30 seconds while an employee has the app open, if they've allowed location access in their browser.</p>`;
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
    <div class="form-card">
      <h3>New report</h3>
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
      <div class="period-chips">
        <button class="btn-sm" type="button" onclick="setReportPeriod('day')">Today</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('week')">This week</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('month')">This month</button>
        <button class="btn-sm" type="button" onclick="setReportPeriod('custom')">Custom</button>
      </div>
      <div class="form-row">
        <div><span class="field-label">From (optional)</span><input type="date" id="reportStart"></div>
        <div><span class="field-label">To (optional)</span><input type="date" id="reportEnd"></div>
      </div>
      <div class="report-toolbar">
        <button class="btn-blue" id="genReportBtn" onclick="doSaveReport()">${ic('save')}Save report</button>
        <button class="btn-blue btn-blue-outline" id="resetReportBtn" onclick="resetReportForm()">${ic('reset')}Reset</button>
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

  let html = `<div class="form-card">`;
  if(opts.showBack){
    html += `<div class="report-toolbar" style="margin-bottom:16px;">
      <button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">${ic('back')}Back to reports history</button>
      <button class="btn-blue" onclick="shareReportWhatsApp()">${ic('share')}Share via WhatsApp</button>
      <button class="btn-blue" onclick="sendReportViaEmailClient()">${ic('mail')}Send via email</button>
    </div>`;
  }
  html += `
    <div class="report-detail-head">
      <h3>${typeLabel}</h3>
      <span class="count mono">${escapeHtml(range)}</span>
    </div>
    <h4 class="chart-title">${isAttendance?'Hours logged':'Avg efficiency %'} by ${isDeptKpi?'department':'employee'}</h4>
    ${svgBarChart(chartItems, {suffix: isAttendance ? 'h' : '%'})}
  </div>`;
  html += `<div class="form-card" style="margin-top:14px;overflow-x:auto;">
    ${isDeptKpi ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn-sm" onclick="exportReportCSV()">${ic('export')}Export CSV</button></div>` : ''}
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
      <button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">${ic('back')}Back to reports history</button>
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
      <button class="btn-blue" onclick="shareReportWhatsApp()">${ic('share')}Share via WhatsApp</button>
      <button class="btn-blue" onclick="sendReportViaEmailClient()">${ic('mail')}Send via email</button>
    </div>`;
    document.getElementById('reportResult').innerHTML = resultHtml;
    showToast('Report saved — find it any time under Reports history');
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
  openWhatsApp(msg);
}
function sendReportViaEmailClient(){
  const data = ACTIVE_REPORT_FOR_SHARE;
  if(!data){ showToast('No report to share yet', true); return; }
  const { typeLabel, range, lines } = buildReportShareText(data);
  const body = `LOGBOOK ${typeLabel}\nRange: ${range}\n\n${lines}`;
  const subject = `LOGBOOK ${typeLabel} — ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}`;
  openEmailCompose(subject, body);
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
      let html = renderReportResult(res.data, { showBack: true });
      main.innerHTML = html;
    }catch(e){
      main.innerHTML = `<div class="empty" style="padding:24px;color:var(--rust);">Could not load this report.</div>
        <div class="report-toolbar"><button class="btn-blue btn-blue-outline" onclick="backToReportHistory()">${ic('back')}Back to reports history</button></div>`;
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
    let html = `<div class="section-head"><h2>Saved reports</h2><span class="count">${reports.length} saved</span></div>`;
    html += `
      <div class="form-card" style="margin-bottom:16px;">
        <div class="form-row">
          <div><span class="field-label">From</span><input type="date" id="reportHistStart" value="${REPORT_HISTORY_FILTER_START}"></div>
          <div><span class="field-label">To</span><input type="date" id="reportHistEnd" value="${REPORT_HISTORY_FILTER_END}"></div>
        </div>
        <div class="report-toolbar">
          <button class="btn-blue" onclick="applyReportHistoryFilter()">${ic('filter')}Filter</button>
          <button class="btn-blue btn-blue-outline" onclick="clearReportHistoryFilter()">Clear</button>
        </div>
      </div>
    `;
    if(!reports.length){
      html += `<div class="empty" style="padding:24px;"><div class="em-mark">— NONE YET —</div>Save a report from the Reports page to see it here.</div>`;
    } else {
      html += `<div class="table-card"><table class="roster-table"><thead><tr><th>Type</th><th>Range</th><th>By</th><th>When</th><th></th></tr></thead><tbody>`;
      reports.forEach(r=>{
        const range = (r.rangeStart||r.rangeEnd) ? `${r.rangeStart||'…'} to ${r.rangeEnd||'…'}` : 'All time';
        html += `<tr>
          <td>${r.type==='department_kpi'?'All Departments':(r.type==='attendance_summary'?'Attendance':'Task Summary')}</td>
          <td class="mono" style="font-size:11px;">${range}</td>
          <td>${escapeHtml(r.generatedByName)}</td>
          <td class="mono" style="font-size:11px;">${fmtDateTime(r.createdAt)}</td>
          <td><button class="btn-sm" onclick="viewStoredReport('${r.id}')">${ic('view')}View</button></td>
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
  }catch(e){
    const el = document.getElementById('loginError');
    if(el) el.textContent = "Logbook couldn't load its data on this device. Reload the page; if it keeps happening, allow site storage for this address.";
    console.error('[Logbook] startup failed:', e);
  }
})();