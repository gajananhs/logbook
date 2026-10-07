/* ===================== EXCEL IMPORT (admins, Team board) =====================
   Loaded AFTER app.js. Uses app.js globals (USERS, CURRENT_USER, apiPost, render,
   refreshAndRender, showToast, escapeHtml, ic). If this file fails to load, the Team
   board simply shows no Import button — nothing else depends on it.

   Flow: Import Excel -> pick file -> pick sheet -> PREVIEW (employee matching,
   target dates, what will be skipped) -> confirm -> tasks are created.
   Nothing is written until the admin confirms the preview.

   Excel columns used:
     RESPONSIBILITY -> employee name(s)          date (2nd "date" column) -> target date
     DATE, TO NO, CUSTOMER NAME, PART NUMBER, ORD. QTY, B/L, remarks -> task details
*/
// The Excel reader (SheetJS) ships with the app, so import also works offline.
const XLSX_LIB_URL = 'assets/vendor/xlsx.full.min.js';
const IMPORT_CHUNK = 100;
let IMPORT = null; // null = panel closed

function canImportExcel(user){
  return !!(user && user.isAdmin);
}

/* ---------- pure parsing helpers (no DOM; unit-testable in Node) ---------- */
function importNorm(s){
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function importHeaderNorm(s){
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}
function importCellText(cell){
  if(!cell || cell.v === undefined || cell.v === null) return '';
  const t = (cell.w !== undefined && cell.w !== null) ? cell.w : String(cell.v);
  return String(t).trim();
}
function importPad(n){ return String(n).padStart(2, '0'); }
function importValidDate(y, m, d){
  if(!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/* Resolve the "target date" cell to {iso, display, fixed}. Sheet dates are written day-month-year.
   Text like "28-09-2026" is read as day-month-year. A cell Excel turned into a REAL date was
   parsed month-first (typing 02-10-2026 for 2 Oct made Excel store 10 Feb) — when the "month"
   Excel picked is <= 12 we swap them back and flag it in the preview. */
function importResolveTarget(XLSX, cell){
  if(!cell || cell.v === undefined || cell.v === null || String(cell.v).trim() === '') return null;
  if(cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)){
    const dc = XLSX.SSF.parse_date_code(cell.v);
    if(!dc) return { error: 'Unreadable date', raw: importCellText(cell) };
    let y = dc.y, m = dc.m, d = dc.d, fixed = false;
    if(d <= 12 && m !== d){ const nm = d; d = m; m = nm; fixed = true; }
    if(!importValidDate(y, m, d)) return { error: 'Unreadable date', raw: importCellText(cell) };
    return { iso: y + '-' + importPad(m) + '-' + importPad(d), display: importPad(d) + '-' + importPad(m) + '-' + y, fixed, raw: importCellText(cell) };
  }
  const txt = importCellText(cell);
  const mt = txt.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/);
  if(mt){
    const d = +mt[1], m = +mt[2]; let y = +mt[3]; if(y < 100) y += 2000;
    if(importValidDate(y, m, d)) return { iso: y + '-' + importPad(m) + '-' + importPad(d), display: importPad(d) + '-' + importPad(m) + '-' + y, fixed: false, raw: txt };
  }
  return { error: 'Unreadable date', raw: txt };
}
/* Reads one worksheet into plain row objects. */
function importParseWorksheet(XLSX, ws){
  if(!ws || !ws['!ref']) return { error: 'This sheet is empty.' };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const cellAt = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
  // header row = first row (within the top 15) that has a RESPONSIBILITY cell
  let hdr = -1;
  for(let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15) && hdr < 0; r++){
    for(let c = range.s.c; c <= range.e.c; c++){
      if(importHeaderNorm(importCellText(cellAt(r, c))) === 'responsibility'){ hdr = r; break; }
    }
  }
  if(hdr < 0) return { error: 'This sheet has no RESPONSIBILITY column, so it can\'t be imported.' };
  const cols = { date: [] };
  for(let c = range.s.c; c <= range.e.c; c++){
    const h = importHeaderNorm(importCellText(cellAt(hdr, c)));
    if(h === 'date') cols.date.push(c);
    else if(h === 'to no' && cols.toNo === undefined) cols.toNo = c;
    else if(h === 'customer name' && cols.customer === undefined) cols.customer = c;
    else if(h === 'part number' && cols.part === undefined) cols.part = c;
    else if(h === 'ord. qty' && cols.qty === undefined) cols.qty = c;
    else if(h === 'b/l' && cols.bl === undefined) cols.bl = c;
    else if(h === 'remarks' && cols.remarks === undefined) cols.remarks = c;
    else if(h === 'responsibility' && cols.resp === undefined) cols.resp = c;
  }
  if(cols.date.length < 2) return { error: 'Couldn\'t find both the DATE column and the target "date" column on this sheet.' };
  cols.orderDate = cols.date[0];
  cols.target = cols.date[cols.date.length - 1];

  const text = (r, c) => (c === undefined ? '' : importCellText(cellAt(r, c)));
  const rows = []; const fixedDates = {};
  for(let r = hdr + 1; r <= range.e.r; r++){
    const rec = {
      rowNum: r + 1,
      toNo: text(r, cols.toNo), customer: text(r, cols.customer), part: text(r, cols.part),
      qty: text(r, cols.qty), bl: text(r, cols.bl), orderDate: text(r, cols.orderDate),
      remarks: text(r, cols.remarks), respRaw: text(r, cols.resp), target: null, targetError: ''
    };
    const tcell = cellAt(r, cols.target);
    const tr = importResolveTarget(XLSX, tcell);
    if(tr && tr.error){ rec.targetError = tr.raw; }
    else if(tr){ rec.target = tr; if(tr.fixed) fixedDates[tr.display] = true; }
    if(!rec.toNo && !rec.customer && !rec.part && !rec.respRaw && !tr) continue; // blank row
    rows.push(rec);
  }
  return { rows, fixedDates: Object.keys(fixedDates) };
}
function importSplitNames(raw){
  return String(raw || '').split(/\s*(?:\/|,|&|\+|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
}
/* Suggests an existing employee for an Excel name. Only an unambiguous match is pre-selected;
   otherwise the admin picks (or skips) — we never guess between two people. */
function importAutoMatch(token, users){
  const t = importNorm(token); if(!t) return '';
  let hit = users.filter(u => importNorm(u.name) === t);
  if(hit.length === 1) return hit[0].id;
  if(hit.length > 1) return '';
  const tw = t.split(' ');
  hit = users.filter(u => { const w = importNorm(u.name).split(' '); return tw.every(x => w.indexOf(x) !== -1); });
  return hit.length === 1 ? hit[0].id : '';
}
function importBuildTokens(parsed, users){
  const map = {}; const order = [];
  parsed.rows.forEach(r => {
    if(!r.target) return;
    importSplitNames(r.respRaw).forEach(tok => {
      const key = importNorm(tok); if(!key) return;
      if(!map[key]){ map[key] = { key, label: tok, count: 0, userId: importAutoMatch(tok, users) }; order.push(key); }
      map[key].count++;
    });
  });
  return order.map(k => map[k]);
}
function importBuildTask(r, employeeId){
  const title = [r.toNo, r.part, r.customer].filter(Boolean).join(' \u00B7 ').slice(0, 200) || ('Row ' + r.rowNum);
  const lines = [];
  const add = (label, v) => { if(v) lines.push(label + ': ' + v); };
  add('DATE', r.orderDate); add('TO NO', r.toNo); add('CUSTOMER NAME', r.customer); add('PART NUMBER', r.part);
  add('ORD. QTY', r.qty); add('B/L', r.bl); add('TARGET DATE', r.target.display);
  add('REMARKS', r.remarks); add('RESPONSIBILITY', r.respRaw);
  return { employeeId, targetDate: r.target.iso, title, description: lines.join('\n') };
}
function importBuildPlan(parsed, tokens){
  const mapping = {}; tokens.forEach(t => { mapping[t.key] = t.userId; });
  const stat = { rows: parsed.rows.length, noDate: 0, noEmployee: 0, notMatchedRows: 0 };
  const tasks = []; const occ = {}; const byDate = {};
  parsed.rows.forEach(r => {
    if(!r.target){ stat.noDate++; return; }
    const names = importSplitNames(r.respRaw);
    if(!names.length){ stat.noEmployee++; return; }
    const ids = [];
    names.forEach(n => { const id = mapping[importNorm(n)]; if(id && ids.indexOf(id) === -1) ids.push(id); });
    if(!ids.length){ stat.notMatchedRows++; return; }
    ids.forEach(id => {
      const t = importBuildTask(r, id);
      const base = [r.toNo, r.part, r.customer].join('|').toLowerCase();
      const k = id + '|' + t.targetDate + '|' + base;
      occ[k] = (occ[k] || 0) + 1;          // identical rows in one sheet each import once
      t.basis = base + '#' + occ[k];
      tasks.push(t);
      byDate[t.targetDate] = (byDate[t.targetDate] || 0) + 1;
    });
  });
  return { tasks, stat, byDate };
}

/* ---------- sample workbook (built on the spot so its dates are always current) ---------- */
async function importDownloadSample(){
  try{
    const XLSX = await loadXlsxLib();
    const iso = off => { const d = new Date(); d.setDate(d.getDate() + off); return importPad(d.getDate()) + '-' + importPad(d.getMonth()+1) + '-' + d.getFullYear(); };
    const first = n => (USERS[n % Math.max(USERS.length, 1)] || { name: 'Employee' }).name.split(' ')[0];
    const rows = [
      ['Daily Production Meeting'],
      [],
      ['DATE', 'TO NO', 'CUSTOMER NAME', 'PART NUMBER', 'ORD. QTY', 'B/L', 'remarks', 'RESPONSIBILITY', 'date'],
      [iso(0), 'TO-6101', 'Northline Pneumatics', 'PF-20-TE', 400, 120, 'Priority order', first(3), iso(0)],
      [iso(0), 'TO-6102', 'Harbour Process Systems', 'AL-40-PR-6M', 60, 60, '', first(4) + ' / ' + first(6), iso(1)],
      [iso(0), 'TO-6103', 'Kestrel Compressors', 'BV-25-SS', 150, 30, 'Awaiting valve bodies', first(6), iso(2)],
      [iso(0), 'TO-6104', 'Summit Bottling', 'PF-32-EL', 220, 0, '', first(8), iso(4)],
      [iso(0), 'TO-6105', 'Delta Fabrication', 'CL-50-AL', 90, 90, 'No target date yet', first(9), '']
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [12, 10, 26, 16, 10, 8, 26, 22, 12].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, iso(0));
    XLSX.writeFile(wb, 'logbook-sample-import.xlsx');
  }catch(e){
    showToast(e.message || 'Could not build the sample workbook', true);
  }
}

/* ---------- UI ---------- */
function importFresh(){
  return { busy: false, msg: '', fileName: '', buf: null, sheets: [], sheet: '', parsed: null, tokens: [], result: null, error: '' };
}
function importExcelButtonHtml(){
  if(!canImportExcel(CURRENT_USER)) return '';
  return `<button class="btn-sm primary" onclick="toggleImportPanel()">${ic('log')}${IMPORT ? 'Close import' : 'Import Excel'}</button>`;
}
function toggleImportPanel(){ IMPORT = IMPORT ? null : importFresh(); render(); }

function loadXlsxLib(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_LIB_URL;
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel reader failed to load'));
    s.onerror = () => reject(new Error('Could not load the Excel reader — reload the app and try again'));
    document.head.appendChild(s);
  });
}
function importTodayDdMmYyyy(){
  const iso = (typeof SERVER_TODAY !== 'undefined' && SERVER_TODAY) ? SERVER_TODAY : localTodayISO();
  return iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);
}
async function importOnFile(input){
  const file = input.files && input.files[0];
  if(!file || !IMPORT) return;
  IMPORT = importFresh(); IMPORT.busy = true; IMPORT.msg = 'Reading Excel…'; IMPORT.fileName = file.name; render();
  try{
    const XLSX = await loadXlsxLib();
    const buf = await file.arrayBuffer();
    const idx = XLSX.read(buf, { type: 'array', sheets: [0] }); // parses just one sheet but still returns every sheet's name + hidden flag
    const meta = (idx.Workbook && idx.Workbook.Sheets) || [];
    IMPORT.sheets = idx.SheetNames.map((n, i) => ({ name: n, hidden: !!(meta[i] && meta[i].Hidden) }));
    IMPORT.buf = buf;
    // default sheet: today's date (e.g. "28-09-2026") if present, else the last visible sheet
    const today = importTodayDdMmYyyy();
    const visible = IMPORT.sheets.filter(s => !s.hidden);
    const pick = IMPORT.sheets.find(s => s.name.trim() === today) || visible[visible.length - 1] || IMPORT.sheets[0];
    await importLoadSheet(pick.name, true);
  }catch(e){
    IMPORT.error = e.message || 'Could not read that file';
  }
  if(IMPORT){ IMPORT.busy = false; IMPORT.msg = ''; }
  render();
}
async function importLoadSheet(name, skipRender){
  const XLSX = await loadXlsxLib();
  IMPORT.sheet = name; IMPORT.parsed = null; IMPORT.tokens = []; IMPORT.error = ''; IMPORT.result = null;
  const wb = XLSX.read(IMPORT.buf, { type: 'array', cellNF: true, sheets: [name] });
  const out = importParseWorksheet(XLSX, wb.Sheets[name]);
  if(out.error){ IMPORT.error = out.error; }
  else { IMPORT.parsed = out; IMPORT.tokens = importBuildTokens(out, USERS); }
  if(!skipRender) render();
}
async function importChooseSheet(name){
  if(!IMPORT) return;
  IMPORT.busy = true; IMPORT.msg = 'Reading sheet…'; render();
  try{ await importLoadSheet(name, true); }catch(e){ IMPORT.error = e.message || 'Could not read that sheet'; }
  IMPORT.busy = false; IMPORT.msg = ''; render();
}
function importSetMapping(i, userId){
  if(!IMPORT || !IMPORT.tokens[i]) return;
  IMPORT.tokens[i].userId = userId;
  render();
}
function importCancel(){ IMPORT = null; render(); }

async function importRun(){
  if(!IMPORT || !IMPORT.parsed || IMPORT.busy) return;
  const plan = importBuildPlan(IMPORT.parsed, IMPORT.tokens);
  if(!plan.tasks.length){ showToast('Nothing to import yet — match at least one employee', true); return; }
  if(!confirm('Create ' + plan.tasks.length + ' task(s) from sheet "' + IMPORT.sheet + '"?\n\nEach task is scheduled for its own target date. Existing tasks, employees and logins are not touched.')) return;
  IMPORT.busy = true; IMPORT.error = '';
  const total = { created: 0, duplicates: 0, invalid: [] };
  try{
    for(let i = 0; i < plan.tasks.length; i += IMPORT_CHUNK){
      IMPORT.msg = 'Importing… ' + Math.min(i + IMPORT_CHUNK, plan.tasks.length) + ' / ' + plan.tasks.length; render();
      const res = await apiPost('import_tasks', {
        requestingUserId: CURRENT_USER.id, sheet: IMPORT.sheet, rows: plan.tasks.slice(i, i + IMPORT_CHUNK)
      });
      total.created += res.created || 0; total.duplicates += res.duplicates || 0;
      (res.invalid || []).forEach(x => total.invalid.push(x));
    }
    IMPORT.parsed = null; IMPORT.tokens = [];
  }catch(e){
    IMPORT.error = (e.message || 'Import failed') + ' — anything imported before this error is kept. Run the import again to add the rest (duplicates are skipped automatically).';
  }
  IMPORT.result = total; IMPORT.busy = false; IMPORT.msg = '';
  await refreshAndRender();
}

function importFmtDay(iso){
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
function importExcelPanelHtml(){
  if(!canImportExcel(CURRENT_USER)){ IMPORT = null; return ''; }
  if(!IMPORT) return '';
  let h = `<div class="card"><h3>Import Excel <button class="btn-sm" onclick="importCancel()">Close</button></h3>`;
  h += `<p class="lede" style="margin:0 0 12px;">Upload the Daily Production Meeting workbook. Tasks are created from the <b>RESPONSIBILITY</b> column (employee) and the <b>date</b> column (target date), with the other columns saved as the task details. You'll see a preview before anything is created.</p>`;
  h += `<div class="toolbar"><input type="file" class="file-input" accept=".xlsx,.xlsm,.xls" onchange="importOnFile(this)" ${IMPORT.busy ? 'disabled' : ''}>
    <button class="btn-sm" type="button" onclick="importDownloadSample()" ${IMPORT.busy ? 'disabled' : ''}>${ic('export')}Download a sample workbook</button></div>`;
  if(IMPORT.busy) h += `<div class="form-msg">${escapeHtml(IMPORT.msg || 'Working…')}</div>`;
  if(IMPORT.error) h += `<div class="form-msg error">${escapeHtml(IMPORT.error)}</div>`;

  if(IMPORT.result){
    const r = IMPORT.result;
    h += `<div class="form-msg" style="color:var(--ink);">
      <b style="color:var(--ok-ink);">${r.created} task(s) created</b>${r.duplicates ? ` · ${r.duplicates} already imported earlier (skipped)` : ''}${r.invalid.length ? ` · <span style="color:var(--rust);">${r.invalid.length} row(s) rejected</span>` : ''}
      ${r.invalid.length ? `<div style="margin-top:6px;color:var(--muted);font-size:12px;">${r.invalid.slice(0, 8).map(x => escapeHtml(String(x))).join('<br>')}</div>` : ''}
      <div style="margin-top:6px;color:var(--muted);font-size:12px;">Tasks dated today appear for each employee now (with the alert sound); later dates appear automatically on their target date.</div>
    </div>`;
  }

  if(IMPORT.sheets.length && !IMPORT.busy){
    const opts = IMPORT.sheets.map(s => `<option value="${escapeHtml(s.name)}" ${s.name === IMPORT.sheet ? 'selected' : ''}>${escapeHtml(s.name)}${s.hidden ? ' (hidden)' : ''}</option>`).join('');
    h += `<div class="form-row" style="margin-top:14px;"><div><span class="field-label">Sheet to import</span><select onchange="importChooseSheet(this.value)">${opts}</select></div></div>`;
  }

  if(IMPORT.parsed && !IMPORT.busy){
    const plan = importBuildPlan(IMPORT.parsed, IMPORT.tokens);
    const today = (typeof SERVER_TODAY !== 'undefined' && SERVER_TODAY) ? SERVER_TODAY : localTodayISO();
    const empOpts = USERS.slice().sort((a, b) => a.name.localeCompare(b.name));
    h += `<div style="margin-top:6px;font-size:13px;">
      <b>${plan.tasks.length}</b> task(s) will be created from ${plan.stat.rows} row(s).
      <span style="color:var(--muted);">Skipped: ${plan.stat.noDate} without a target date${plan.stat.noEmployee ? ', ' + plan.stat.noEmployee + ' without an employee' : ''}${plan.stat.notMatchedRows ? ', ' + plan.stat.notMatchedRows + ' with no matched employee' : ''}.</span></div>`;

    if(IMPORT.tokens.length){
      h += `<div class="field-label" style="margin-top:16px;">Match Excel names to employees</div>
      <div class="table-card"><table class="roster-table"><thead><tr><th>Name in Excel</th><th>Rows</th><th>Employee</th></tr></thead><tbody>`;
      IMPORT.tokens.forEach((t, i) => {
        const o = `<option value="" ${!t.userId ? 'selected' : ''}>\u2014 Skip these rows \u2014</option>` + empOpts.map(u => `<option value="${u.id}" ${t.userId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
        h += `<tr><td class="name-cell">${escapeHtml(t.label)}</td><td class="mono">${t.count}</td><td><select onchange="importSetMapping(${i}, this.value)">${o}</select></td></tr>`;
      });
      h += `</tbody></table></div><p style="font-size:11px;color:var(--muted);margin:6px 0 0;">Names are matched to existing employees only \u2014 no employee is ever created. Anything left on "Skip" is not imported.</p>`;
    }

    const dates = Object.keys(plan.byDate).sort();
    if(dates.length){
      h += `<div class="field-label" style="margin-top:16px;">Tasks by target date</div><div style="font-size:13px;">`;
      dates.forEach(d => {
        const when = d > today ? 'appears on that date' : (d === today ? 'appears today' : 'date already passed \u2014 appears now, marked overdue');
        h += `<div style="display:flex;gap:12px;padding:3px 0;"><span class="mono" style="min-width:150px;">${escapeHtml(importFmtDay(d))}</span><span class="mono" style="min-width:36px;">${plan.byDate[d]}</span><span style="color:var(--muted);">${when}</span></div>`;
      });
      h += `</div>`;
    }
    if(IMPORT.parsed.fixedDates.length){
      h += `<p style="font-size:11px;color:var(--muted);margin:12px 0 0;">Some date cells (${escapeHtml(IMPORT.parsed.fixedDates.slice(0, 4).join(', '))}${IMPORT.parsed.fixedDates.length > 4 ? ', \u2026' : ''}) were stored by Excel as month-day. They've been read day-month, the way they're written in the sheet \u2014 please confirm the dates above look right.</p>`;
    }
    h += `<div style="display:flex;gap:8px;margin-top:16px;"><button class="btn-sm primary" onclick="importRun()" ${plan.tasks.length ? '' : 'disabled'}>Import ${plan.tasks.length} task(s)</button><button class="btn-sm" onclick="importCancel()">Cancel</button></div>`;
  }
  h += `</div>`;
  return h;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { importParseWorksheet, importResolveTarget, importBuildTokens, importBuildPlan, importSplitNames, importAutoMatch, importNorm };
}
