/* LOGBOOK data layer — everything the PHP/MySQL API used to do, running in the browser.
 *
 * app.js talks to this through LogbookStore.request(action, payload), which mirrors the
 * old /api/<action>.php endpoints one-to-one: same action names, same payloads, same
 * response shapes, same permission rules and error messages. Data lives in localStorage
 * on this device and starts from assets/js/seed-data.js on first run.
 *
 * To put a real backend behind the app later, replace request() with a fetch() to your
 * server — nothing in app.js needs to change.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'logbook.data.v3';

  /* ------------------------------------------------------------------ helpers */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDateTime(d) { return fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function now() { return fmtDateTime(new Date()); }
  function today() { return fmtDate(new Date()); }
  function parse(ts) { return new Date(String(ts).replace(' ', 'T')); }
  function uid(prefix) {
    var bytes = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return prefix + '_' + Array.prototype.map.call(bytes, function (b) { return pad(b.toString(16)); }).join('');
  }
  function fail(message, extra) {
    var err = new Error(message);
    if (extra) Object.assign(err, extra);
    return err;
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function trim(v) { return String(v == null ? '' : v).trim(); }

  /* PINs are never stored in the clear: SHA-256 of a per-user salted value. */
  function hashPin(userId, pin) {
    var text = 'logbook|' + userId + '|' + pin;
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return pad(b.toString(16)); }).join('');
      });
    }
    // Non-secure contexts (plain http on a LAN address) have no SubtleCrypto: fall back to a simple digest.
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
      h2 = Math.imul(h2 + text.charCodeAt(i), 2246822519);
    }
    return Promise.resolve('f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16));
  }

  /* ---------------------------------------------------------- starting data */
  /* A new device starts with everything in assets/js/seed-data.js. */
  function buildSeed() {
    var seed = window.LOGBOOK_SEED || {};
    return {
      version: 3, seededOn: today(),
      users: (seed.users || []).map(function (u) {
        return {
          id: u.id, name: u.name, created_at: u.createdAt || now(), isAdmin: !!u.isAdmin, orgRole: u.orgRole || 'employee',
          departmentId: u.departmentId || null, subDepartmentId: u.subDepartmentId || null, department: u.department || null,
          phone: u.phone || null, lastSeen: null, lastLat: null, lastLng: null, locationAt: null, pinHash: null
        };
      }),
      departments: clone(seed.departments || []),
      subDepartments: clone(seed.subDepartments || []),
      statuses: clone(seed.statuses || []),
      tasks: (seed.tasks || []).map(function (t) {
        var copy = clone(t);
        copy.updates = copy.updates || [];
        if (copy.releaseNotified === undefined) copy.releaseNotified = true;
        return copy;
      }),
      attendance: (seed.attendance || []).map(function (a) {
        return { id: a.id, userId: a.userId, clockIn: a.clockIn, clockOut: a.clockOut || null, latIn: null, lngIn: null, latOut: null, lngOut: null };
      }),
      notifications: clone(seed.notifications || []),
      reports: clone(seed.reports || [])
    };
  }

  /* ---------------------------------------------------------- load / save */
  var db = null;
  var ready = null;

  function save() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
    catch (e) { /* private mode / quota: keep working from memory for this session */ }
  }
  function load() {
    if (ready) return ready;
    var raw = null;
    try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (raw) {
      try { db = JSON.parse(raw); } catch (e) { db = null; }
    }
    if (!db || db.version !== 3) { db = buildSeed(); save(); }
    ready = Promise.resolve();
    return ready;
  }
  function reset() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    db = null; ready = null;
    return load();
  }

  /* ------------------------------------------------------------- lookups */
  function findUser(id) { return db.users.find(function (u) { return u.id === id; }); }
  function findTask(id) { return db.tasks.find(function (t) { return t.id === id; }); }
  function requireAdmin(id, message) {
    var u = findUser(id);
    if (!u || !u.isAdmin) throw fail(message);
    return u;
  }
  function publicUser(u) {
    return {
      id: u.id, name: u.name, created_at: u.created_at, createdAt: u.created_at, isAdmin: !!u.isAdmin, orgRole: u.orgRole,
      departmentId: u.departmentId, subDepartmentId: u.subDepartmentId, department: u.department, phone: u.phone,
      lastSeen: u.lastSeen, lastLat: u.lastLat, lastLng: u.lastLng, locationAt: u.locationAt,
      has_pin: !!u.pinHash, hasPin: !!u.pinHash
    };
  }
  function publicTask(t) {
    return {
      id: t.id, title: t.title, description: t.description, assignedTo: t.assignedTo, assignedBy: t.assignedBy,
      createdAt: t.createdAt, dueDate: t.dueDate, estimatedHours: t.estimatedHours, status: t.status,
      completedAt: t.completedAt, actualHours: t.actualHours, repeatType: t.repeatType || 'none',
      repeatParentId: t.repeatParentId || null, availableFrom: t.availableFrom || null, updates: clone(t.updates || [])
    };
  }
  function notify(userId, message, taskId) {
    db.notifications.push({ id: uid('n'), userId: userId, message: message, taskId: taskId || null, isRead: false, createdAt: now() });
  }
  function firstStatus(done) {
    return db.statuses.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; })
      .find(function (s) { return !!s.isDone === done; });
  }
  function canAssign(assignerId, assigneeId) {
    if (assignerId === assigneeId) return true;
    var a = findUser(assignerId), b = findUser(assigneeId);
    if (!a) return false;
    if (a.isAdmin) return true;
    if (!b) return false;
    if (a.orgRole === 'dept_head') return !!a.departmentId && b.departmentId === a.departmentId;
    if (a.orgRole === 'sub_head') return !!a.subDepartmentId && b.subDepartmentId === a.subDepartmentId;
    return false;
  }
  function addRepeatInterval(dateStr, type) {
    var d = new Date(dateStr + 'T00:00:00');
    if (type === 'daily') d.setDate(d.getDate() + 1);
    else if (type === 'weekly') d.setDate(d.getDate() + 7);
    else if (type === 'monthly') {
      var dayOfMonth = d.getDate();
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      var daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dayOfMonth, daysInTarget));
    }
    return fmtDate(d);
  }
  function spawnNextOccurrence(taskId) {
    var t = findTask(taskId);
    if (!t || !t.repeatType || t.repeatType === 'none') return null;
    var open = firstStatus(false);
    if (!open) return null;
    var nextDue = addRepeatInterval(t.dueDate || today(), t.repeatType);
    var next = {
      id: uid('t'), title: t.title, description: t.description, assignedTo: t.assignedTo, assignedBy: t.assignedBy,
      createdAt: now(), dueDate: nextDue, estimatedHours: t.estimatedHours, status: open.id, completedAt: null, actualHours: null,
      repeatType: t.repeatType, repeatParentId: t.repeatParentId || t.id, availableFrom: null, releaseNotified: true, importKey: null, updates: []
    };
    db.tasks.unshift(next);
    if (t.assignedTo !== t.assignedBy) notify(t.assignedTo, 'Repeated task renewed: ' + t.title + ' (due ' + nextDue + ')', next.id);
    return next.id;
  }
  /* Imported tasks carry a target date; on that date the assignee is told once. */
  function releaseScheduledTasks() {
    var t0 = today(), byUser = {}, changed = false;
    db.tasks.forEach(function (t) {
      if (t.releaseNotified !== false || !t.availableFrom || t.availableFrom > t0) return;
      t.releaseNotified = true; changed = true;
      if (t.assignedTo === t.assignedBy) return;
      (byUser[t.assignedTo] = byUser[t.assignedTo] || []).push(t);
    });
    Object.keys(byUser).forEach(function (userId) {
      var list = byUser[userId];
      if (list.length === 1) notify(userId, 'New task assigned: ' + list[0].title.slice(0, 200), list[0].id);
      else notify(userId, 'New tasks assigned: ' + list.length + ' tasks — see Assigned to Me', null);
    });
    if (changed) save();
  }
  function loggedHours(t) {
    return (t.updates || []).reduce(function (s, u) { return s + (Number(u.hoursLogged) || 0); }, 0);
  }
  function inRange(ts, start, end) {
    if (start && ts < start + ' 00:00:00') return false;
    if (end && ts > end + ' 23:59:59') return false;
    return true;
  }
  function efficiencyOf(t) {
    if (!t.completedAt || !t.estimatedHours || !t.actualHours || t.actualHours <= 0) return null;
    return Math.min(150, (t.estimatedHours / t.actualHours) * 100);
  }
  function average(values) {
    return values.length ? Math.round(values.reduce(function (a, b) { return a + b; }, 0) / values.length) : null;
  }
  function attendanceMinutes(userId, start, end) {
    var rows = db.attendance.filter(function (a) { return a.userId === userId && inRange(a.clockIn, start, end); });
    var mins = rows.reduce(function (s, a) {
      return s + Math.max(0, Math.floor(((a.clockOut ? parse(a.clockOut) : new Date()) - parse(a.clockIn)) / 60000));
    }, 0);
    return { shifts: rows.length, mins: mins };
  }
  function buildReport(type, rangeStart, rangeEnd) {
    var data = { type: type, rangeStart: rangeStart || null, rangeEnd: rangeEnd || null, rows: [] };
    if (type === 'attendance_summary') {
      db.users.forEach(function (u) {
        var a = attendanceMinutes(u.id, rangeStart, rangeEnd);
        data.rows.push({ userId: u.id, name: u.name, shifts: a.shifts, hours: Math.round((a.mins / 60) * 100) / 100 });
      });
    } else if (type === 'department_kpi') {
      var t0 = today();
      var doneIds = db.statuses.filter(function (s) { return s.isDone; }).map(function (s) { return s.id; });
      db.departments.concat([{ id: null, name: 'No department' }]).forEach(function (d) {
        var members = db.users.filter(function (u) { return (u.departmentId || null) === d.id; });
        if (d.id === null && !members.length) return;
        var ids = members.map(function (u) { return u.id; });
        var tasks = db.tasks.filter(function (t) { return ids.indexOf(t.assignedTo) !== -1 && inRange(t.createdAt, rangeStart, rangeEnd); });
        var done = tasks.filter(function (t) { return doneIds.indexOf(t.status) !== -1; });
        var mins = ids.reduce(function (s, id) { return s + attendanceMinutes(id, rangeStart, rangeEnd).mins; }, 0);
        data.rows.push({
          department: d.name, headcount: members.length, total: tasks.length, open: tasks.length - done.length,
          overdue: tasks.filter(function (t) { return doneIds.indexOf(t.status) === -1 && t.dueDate && t.dueDate < t0; }).length,
          completed: done.length,
          avgEfficiency: average(tasks.map(efficiencyOf).filter(function (v) { return v !== null; })),
          attendanceHours: Math.round((mins / 60) * 10) / 10
        });
      });
    } else {
      data.type = 'task_summary';
      db.users.forEach(function (u) {
        var tasks = db.tasks.filter(function (t) { return t.assignedTo === u.id && inRange(t.createdAt, rangeStart, rangeEnd); });
        data.rows.push({
          userId: u.id, name: u.name, assigned: tasks.length,
          completed: tasks.filter(function (t) { return !!t.completedAt; }).length,
          avgEfficiency: average(tasks.map(efficiencyOf).filter(function (v) { return v !== null; }))
        });
      });
    }
    return data;
  }
  function simpleKey(text) { // stable fingerprint for an imported row
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
    return 'xl1_' + h.toString(16) + '_' + text.length;
  }

  /* -------------------------------------------------------------- actions */
  var actions = {
    bootstrap: function () {
      releaseScheduledTasks();
      return {
        serverDate: today(),
        users: db.users.map(publicUser),
        tasks: db.tasks.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(publicTask),
        statuses: clone(db.statuses.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; })),
        attendance: clone(db.attendance.slice().sort(function (a, b) { return a.clockIn < b.clockIn ? 1 : -1; }).slice(0, 300)),
        departments: clone(db.departments.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })),
        subDepartments: clone(db.subDepartments.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }))
      };
    },

    login: function (b) {
      var name = trim(b.name), pin = trim(b.pin);
      if (!name) throw fail('Enter your name');
      var u = db.users.find(function (x) { return x.name.toLowerCase() === name.toLowerCase(); });
      if (!u) throw fail('No employee found with that name — ask your admin to add you');
      if (!u.pinHash) return { ok: true, user: publicUser(u) };
      return hashPin(u.id, pin).then(function (h) {
        if (!pin || h !== u.pinHash) throw fail('Incorrect PIN');
        return { ok: true, user: publicUser(u) };
      });
    },
    sso_login: function () { throw fail('Single sign-on is not available in this build'); },
    get_sales_report_link: function () { throw fail('Sales Report is not connected in this build'); },

    heartbeat: function (b) {
      var u = findUser(b.userId);
      if (!u) throw fail('Missing userId');
      u.lastSeen = now();
      if (b.lat != null && b.lng != null) { u.lastLat = Number(b.lat); u.lastLng = Number(b.lng); u.locationAt = u.lastSeen; }
      return { ok: true };
    },

    list_notifications: function (b) {
      if (!b.userId) throw fail('Missing userId');
      releaseScheduledTasks();
      var rows = db.notifications.filter(function (n) { return n.userId === b.userId; })
        .sort(function (a, c) { return a.createdAt < c.createdAt ? 1 : -1; }).slice(0, 50)
        .map(function (n) { return { id: n.id, message: n.message, taskId: n.taskId, isRead: !!n.isRead, createdAt: n.createdAt }; });
      return { notifications: rows };
    },
    mark_notification_read: function (b) {
      var n = db.notifications.find(function (x) { return x.id === b.notificationId && x.userId === b.userId; });
      if (n) n.isRead = true;
      return { ok: true };
    },
    mark_all_notifications_read: function (b) {
      db.notifications.forEach(function (n) { if (n.userId === b.userId) n.isRead = true; });
      return { ok: true };
    },

    add_task: function (b) {
      var title = trim(b.title);
      if (!title || !b.assignedTo || !b.assignedBy) throw fail('Missing required fields');
      if (!canAssign(b.assignedBy, b.assignedTo)) throw fail("You don't have permission to assign tasks to this person");
      var statusId = b.statusId || (firstStatus(false) || {}).id;
      if (!statusId) throw fail('No statuses configured');
      var repeatType = b.repeatType || 'none';
      if (['none', 'daily', 'weekly', 'monthly'].indexOf(repeatType) === -1) throw fail('Work Type must be Daily, Weekly or Monthly');
      var dueDate = b.dueDate || null;
      if (repeatType !== 'none') {
        var start = trim(b.startDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw fail('Pick a start date for the repeated work');
        dueDate = addRepeatInterval(start, repeatType);
      }
      var t = {
        id: uid('t'), title: title, description: b.description || null, assignedTo: b.assignedTo, assignedBy: b.assignedBy,
        createdAt: now(), dueDate: dueDate, estimatedHours: b.estimatedHours || null, status: statusId, completedAt: null, actualHours: null,
        repeatType: repeatType, repeatParentId: null, availableFrom: null, releaseNotified: true, importKey: null, updates: []
      };
      db.tasks.unshift(t);
      if (t.assignedTo !== t.assignedBy) notify(t.assignedTo, 'New task assigned: ' + title, t.id);
      return { id: t.id, statusId: statusId, dueDate: dueDate, repeatType: repeatType };
    },
    update_task: function (b) {
      if (!b.taskId || !b.requestingUserId) throw fail('Missing required fields');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      if (t.assignedBy !== b.requestingUserId) throw fail('Only the assigner can edit this task');
      var title = trim(b.title);
      if (!title) throw fail('Title required');
      if (b.assignedTo && !canAssign(b.requestingUserId, b.assignedTo)) throw fail("You don't have permission to assign tasks to this person");
      var dueDate = b.dueDate || null;
      if (Object.prototype.hasOwnProperty.call(b, 'repeatType')) {
        if (['none', 'daily', 'weekly', 'monthly'].indexOf(b.repeatType) === -1) throw fail('Work Type must be Daily, Weekly or Monthly');
        if (b.repeatType !== 'none' && b.startDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(trim(b.startDate))) throw fail('Start date must be a valid date');
          dueDate = addRepeatInterval(trim(b.startDate), b.repeatType);
        }
        t.repeatType = b.repeatType;
      }
      t.title = title; t.description = b.description || null; t.assignedTo = b.assignedTo || t.assignedTo;
      t.dueDate = dueDate; t.estimatedHours = b.estimatedHours || null;
      return { ok: true, dueDate: dueDate };
    },
    delete_task: function (b) {
      if (!b.taskId || !b.requestingUserId) throw fail('Missing required fields');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      if (t.assignedBy !== b.requestingUserId) throw fail('Only the assigner can delete this task');
      db.tasks = db.tasks.filter(function (x) { return x.id !== b.taskId; });
      return { ok: true };
    },
    update_task_status: function (b) {
      if (!b.taskId || !b.statusId || !b.requestingUserId) throw fail('Missing required fields');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      if (b.requestingUserId !== t.assignedTo && b.requestingUserId !== t.assignedBy) throw fail('Only the assignee or assigner can change status');
      var st = db.statuses.find(function (s) { return s.id === b.statusId; });
      if (!st) throw fail('Status not found');
      if (st.isDone) {
        if (b.estimatedHours && !t.estimatedHours) t.estimatedHours = Number(b.estimatedHours);
        var actual = Number(b.actualHours) || loggedHours(t) || t.estimatedHours || null;
        t.status = st.id; t.completedAt = now(); t.actualHours = actual;
        if (b.requestingUserId === t.assignedTo && t.assignedBy !== t.assignedTo) notify(t.assignedBy, 'Task completed: ' + t.title, t.id);
        var nextId = spawnNextOccurrence(t.id);
        return { ok: true, completedAt: t.completedAt, actualHours: actual, estimatedHours: t.estimatedHours, nextOccurrenceId: nextId };
      }
      t.status = st.id; t.completedAt = null; t.actualHours = null;
      return { ok: true, completedAt: null, actualHours: null };
    },
    mark_complete: function (b) {
      if (!b.taskId) throw fail('Missing taskId');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      var done = firstStatus(true);
      if (!done) throw fail('No status is marked as done — set one up first');
      if (b.estimatedHours && !t.estimatedHours) t.estimatedHours = Number(b.estimatedHours);
      var actual = Number(b.actualHours) || loggedHours(t) || t.estimatedHours || null;
      t.status = done.id; t.completedAt = now(); t.actualHours = actual;
      if (t.assignedBy !== t.assignedTo) notify(t.assignedBy, 'Task completed: ' + t.title, t.id);
      var nextId = spawnNextOccurrence(t.id);
      return { completedAt: t.completedAt, actualHours: actual, statusId: done.id, estimatedHours: t.estimatedHours, nextOccurrenceId: nextId };
    },
    renew_task: function (b) {
      if (!b.taskId || !b.requestingUserId) throw fail('Missing required fields');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      if (b.requestingUserId !== t.assignedTo && b.requestingUserId !== t.assignedBy) throw fail('Only the assignee or assigner can renew this task');
      if (!t.repeatType || t.repeatType === 'none') throw fail("This task isn't set up as repeated work");
      var newId = spawnNextOccurrence(t.id);
      if (!newId) throw fail('Could not renew — no open status is configured to put the new occurrence into');
      return { ok: true, newTaskId: newId, dueDate: findTask(newId).dueDate };
    },

    add_update: function (b) {
      if (!b.taskId || !b.byUserId) throw fail('Missing required fields');
      var t = findTask(b.taskId);
      if (!t) throw fail('Task not found');
      var pct = Math.max(0, Math.min(100, parseInt(b.progressPct, 10) || 0));
      var u = { id: uid('up'), date: now(), progressPct: pct, hoursLogged: b.hoursLogged || null, note: b.note || null, byUserId: b.byUserId };
      t.updates = t.updates || []; t.updates.push(u);
      if (b.byUserId === t.assignedTo && t.assignedBy !== t.assignedTo) notify(t.assignedBy, 'Update logged (' + pct + '%) on: ' + t.title, t.id);
      return { id: u.id, date: u.date };
    },
    edit_update: function (b) {
      if (!b.updateId || !b.requestingUserId) throw fail('Missing required fields');
      var found = null;
      db.tasks.forEach(function (t) { (t.updates || []).forEach(function (u) { if (u.id === b.updateId) found = u; }); });
      if (!found) throw fail('Update not found');
      if (found.byUserId !== b.requestingUserId) throw fail('You can only edit your own updates');
      found.progressPct = Math.max(0, Math.min(100, parseInt(b.progressPct, 10) || 0));
      found.hoursLogged = b.hoursLogged || null; found.note = b.note || null;
      return { ok: true };
    },
    delete_update: function (b) {
      if (!b.updateId || !b.requestingUserId) throw fail('Missing required fields');
      var owner = null, found = null;
      db.tasks.forEach(function (t) { (t.updates || []).forEach(function (u) { if (u.id === b.updateId) { owner = t; found = u; } }); });
      if (!found) throw fail('Update not found');
      if (found.byUserId !== b.requestingUserId) throw fail('You can only delete your own updates');
      owner.updates = owner.updates.filter(function (u) { return u.id !== b.updateId; });
      return { ok: true };
    },

    send_comment: function (b) {
      var message = trim(b.message);
      if (!b.targetUserId || !b.requestingUserId || !message) throw fail('Missing required fields');
      var r = findUser(b.requestingUserId), t = findUser(b.targetUserId);
      if (!r) throw fail('Requester not found');
      if (!t) throw fail('Employee not found');
      var allowed = r.isAdmin
        || (r.orgRole === 'dept_head' && r.departmentId && t.departmentId === r.departmentId)
        || (r.orgRole === 'sub_head' && r.subDepartmentId && t.subDepartmentId === r.subDepartmentId)
        || r.id === t.id;
      if (!allowed) throw fail("You don't have permission to comment on this employee");
      notify(t.id, r.name + ' commented: ' + message, null);
      return { ok: true };
    },
    send_summary: function () {
      throw fail('Automatic email needs a mail server, which this build does not have — use Share via WhatsApp instead');
    },

    clock_in: function (b) {
      if (!b.userId) throw fail('Missing userId');
      if (db.attendance.some(function (a) { return a.userId === b.userId && !a.clockOut; })) throw fail('Already clocked in');
      var a = { id: uid('att'), userId: b.userId, clockIn: now(), clockOut: null, latIn: b.lat == null ? null : b.lat, lngIn: b.lng == null ? null : b.lng, latOut: null, lngOut: null };
      db.attendance.unshift(a);
      return { id: a.id, clockIn: a.clockIn };
    },
    clock_out: function (b) {
      if (!b.userId) throw fail('Missing userId');
      var open = db.attendance.filter(function (a) { return a.userId === b.userId && !a.clockOut; })
        .sort(function (a, c) { return a.clockIn < c.clockIn ? 1 : -1; })[0];
      if (!open) throw fail('Not currently clocked in');
      open.clockOut = now(); open.latOut = b.lat == null ? null : b.lat; open.lngOut = b.lng == null ? null : b.lng;
      return { id: open.id, clockOut: open.clockOut };
    },

    add_user: function (b) {
      var name = trim(b.name), pin = trim(b.pin);
      if (!name) throw fail('Name required');
      if (pin && !/^\d{4}$/.test(pin)) throw fail('PIN must be 4 digits');
      var existing = db.users.find(function (u) { return u.name.toLowerCase() === name.toLowerCase(); });
      if (existing) return { user: publicUser(existing) };
      var u = {
        id: uid('u'), name: name, created_at: now(), isAdmin: db.users.length === 0, orgRole: 'employee',
        departmentId: null, subDepartmentId: null, department: trim(b.department) || null, phone: trim(b.phone) || null,
        lastSeen: null, lastLat: null, lastLng: null, locationAt: null, pinHash: null
      };
      db.users.push(u);
      if (!pin) return { user: publicUser(u) };
      return hashPin(u.id, pin).then(function (h) { u.pinHash = h; return { user: publicUser(u) }; });
    },
    rename_user: function (b) {
      var newName = trim(b.newName);
      if (!b.targetUserId || !b.requestingUserId) throw fail('Missing required fields');
      if (!newName) throw fail('Name cannot be empty');
      requireAdmin(b.requestingUserId, 'Only an admin can rename an employee');
      var t = findUser(b.targetUserId);
      if (!t) throw fail('Employee not found');
      if (db.users.some(function (u) { return u.id !== t.id && u.name.toLowerCase() === newName.toLowerCase(); })) {
        throw fail('Another employee is already named "' + newName + '"');
      }
      t.name = newName;
      return { ok: true, id: t.id, name: newName };
    },
    reset_pin: function (b) {
      var pin = trim(b.newPin);
      if (!b.targetUserId || !b.requestingUserId) throw fail('Missing required fields');
      if (pin && !/^\d{4}$/.test(pin)) throw fail('PIN must be 4 digits');
      requireAdmin(b.requestingUserId, 'Only an admin can reset a PIN');
      var t = findUser(b.targetUserId);
      if (!t) throw fail('Employee not found');
      if (!pin) { t.pinHash = null; return { ok: true }; }
      return hashPin(t.id, pin).then(function (h) { t.pinHash = h; return { ok: true }; });
    },
    toggle_admin: function (b) {
      if (!b.targetUserId || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can change admin status');
      var t = findUser(b.targetUserId);
      if (!t) throw fail('Employee not found');
      if (!b.isAdmin && t.isAdmin && db.users.filter(function (u) { return u.isAdmin; }).length <= 1) {
        throw fail('Cannot remove the last remaining admin');
      }
      t.isAdmin = !!b.isAdmin;
      return { ok: true };
    },
    update_user_org: function (b) {
      if (!b.targetUserId || !b.requestingUserId) throw fail('Missing required fields');
      var role = b.orgRole || 'employee';
      if (['employee', 'sub_head', 'dept_head'].indexOf(role) === -1) throw fail('Invalid role');
      requireAdmin(b.requestingUserId, "Only an admin can change an employee's role");
      var t = findUser(b.targetUserId);
      if (!t) throw fail('Employee not found');
      var dept = b.departmentId || null, sub = b.subDepartmentId || null;
      if (role === 'dept_head') {
        if (!dept) throw fail('Pick a department for a department head');
        sub = null;
      } else {
        if (role === 'sub_head' && !sub) throw fail('Pick a sub-department for a sub-department head');
        if (sub) {
          var sd = db.subDepartments.find(function (s) { return s.id === sub; });
          if (!sd) throw fail('Sub-department not found');
          dept = sd.departmentId; // always derive the parent department
        }
      }
      t.orgRole = role; t.departmentId = dept; t.subDepartmentId = sub;
      return { ok: true, orgRole: role, departmentId: dept, subDepartmentId: sub };
    },
    delete_user: function (b) {
      if (!b.targetUserId || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can remove an employee');
      if (b.targetUserId === b.requestingUserId) throw fail("You can't remove your own account while signed in as it");
      var t = findUser(b.targetUserId);
      if (!t) throw fail('Employee not found');
      if (t.isAdmin && db.users.filter(function (u) { return u.isAdmin; }).length <= 1) throw fail('Cannot remove the last remaining admin');
      var id = t.id;
      var hasHistory = db.tasks.some(function (x) { return x.assignedTo === id || x.assignedBy === id || (x.updates || []).some(function (u) { return u.byUserId === id; }); })
        || db.attendance.some(function (a) { return a.userId === id; })
        || db.reports.some(function (r) { return r.generatedBy === id; });
      if (hasHistory && !b.force) {
        throw fail('Can\'t remove "' + t.name + '" — they have task, attendance, or report history tied to their account. Reassign or clear that first if you really need to delete them.', { blockedByHistory: true });
      }
      db.notifications = db.notifications.filter(function (n) { return n.userId !== id; });
      if (b.force) {
        db.tasks = db.tasks.filter(function (x) { return x.assignedTo !== id && x.assignedBy !== id; });
        db.tasks.forEach(function (x) { x.updates = (x.updates || []).filter(function (u) { return u.byUserId !== id; }); });
        db.attendance = db.attendance.filter(function (a) { return a.userId !== id; });
        db.reports = db.reports.filter(function (r) { return r.generatedBy !== id; });
      }
      db.users = db.users.filter(function (u) { return u.id !== id; });
      return { ok: true };
    },

    add_department: function (b) {
      var name = trim(b.name);
      if (!name || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can add a department');
      if (db.departments.some(function (d) { return d.name.toLowerCase() === name.toLowerCase(); })) throw fail('A department with that name already exists');
      var d = { id: uid('dept'), name: name };
      db.departments.push(d);
      return { department: clone(d) };
    },
    delete_department: function (b) {
      if (!b.departmentId || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can delete a department');
      if (db.subDepartments.some(function (s) { return s.departmentId === b.departmentId; })) throw fail('Remove its sub-departments first');
      if (db.users.some(function (u) { return u.departmentId === b.departmentId; })) throw fail('Reassign employees off this department first');
      db.departments = db.departments.filter(function (d) { return d.id !== b.departmentId; });
      return { ok: true };
    },
    add_sub_department: function (b) {
      var name = trim(b.name);
      if (!name || !b.departmentId || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can add a sub-department');
      if (!db.departments.some(function (d) { return d.id === b.departmentId; })) throw fail('Department not found');
      if (db.subDepartments.some(function (s) { return s.departmentId === b.departmentId && s.name.toLowerCase() === name.toLowerCase(); })) {
        throw fail('A sub-department with that name already exists in this department');
      }
      var s = { id: uid('sd'), departmentId: b.departmentId, name: name };
      db.subDepartments.push(s);
      return { subDepartment: clone(s) };
    },
    delete_sub_department: function (b) {
      if (!b.subDepartmentId || !b.requestingUserId) throw fail('Missing required fields');
      requireAdmin(b.requestingUserId, 'Only an admin can delete a sub-department');
      if (db.users.some(function (u) { return u.subDepartmentId === b.subDepartmentId; })) throw fail('Reassign employees off this sub-department first');
      db.subDepartments = db.subDepartments.filter(function (s) { return s.id !== b.subDepartmentId; });
      return { ok: true };
    },

    generate_report: function (b) {
      if (!b.requestingUserId) throw fail('Missing requestingUserId');
      requireAdmin(b.requestingUserId, 'Only an admin can generate reports');
      var data = buildReport(b.type || 'task_summary', b.rangeStart || null, b.rangeEnd || null);
      var r = { id: uid('rep'), generatedBy: b.requestingUserId, type: data.type, rangeStart: data.rangeStart, rangeEnd: data.rangeEnd, data: data, createdAt: now() };
      db.reports.push(r);
      // No mail server here: the app opens the user's own email compose window instead.
      return { id: r.id, createdAt: r.createdAt, data: clone(data), emailError: 'Automatic email is not available in this build' };
    },
    list_reports: function (b) {
      var rows = db.reports.filter(function (r) { return inRange(r.createdAt, b.rangeStart || null, b.rangeEnd || null); })
        .sort(function (a, c) { return a.createdAt < c.createdAt ? 1 : -1; }).slice(0, 200)
        .map(function (r) {
          var u = findUser(r.generatedBy);
          return { id: r.id, type: r.type, rangeStart: r.rangeStart, rangeEnd: r.rangeEnd, createdAt: r.createdAt, generatedByName: u ? u.name : 'Former employee' };
        });
      return { reports: rows };
    },
    get_report: function (b) {
      if (!b.reportId) throw fail('Missing reportId');
      var r = db.reports.find(function (x) { return x.id === b.reportId; });
      if (!r) throw fail('Report not found');
      return { id: r.id, type: r.type, rangeStart: r.rangeStart, rangeEnd: r.rangeEnd, createdAt: r.createdAt, data: clone(r.data) };
    },

    import_tasks: function (b) {
      var requester = findUser(b.requestingUserId);
      if (!requester || !requester.isAdmin) throw fail('Excel import is not available for your account');
      var rows = b.rows;
      if (!Array.isArray(rows) || !rows.length) throw fail('No rows to import');
      if (rows.length > 300) throw fail('Too many rows in one request (max 300)');
      var open = firstStatus(false);
      if (!open) throw fail('No statuses configured');
      var created = 0, duplicates = 0, invalid = [], stamp = now();
      rows.forEach(function (row, i) {
        var label = 'Row ' + (i + 1);
        if (!row || typeof row !== 'object') { invalid.push(label + ': bad format'); return; }
        var employeeId = trim(row.employeeId), targetDate = trim(row.targetDate), title = trim(row.title);
        var description = trim(row.description), basis = trim(row.basis);
        if (!employeeId || !title || !basis) { invalid.push(label + ': missing employee, title or key'); return; }
        var m = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        var valid = m && (function () { var d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]; })();
        if (!valid) { invalid.push(label + ' (' + title + '): invalid target date'); return; }
        if (!findUser(employeeId) || !canAssign(requester.id, employeeId)) { invalid.push(label + ' (' + title + '): employee not found or not assignable'); return; }
        var key = simpleKey(employeeId + '|' + targetDate + '|' + basis);
        if (db.tasks.some(function (t) { return t.importKey === key; })) { duplicates++; return; }
        db.tasks.unshift({
          id: uid('t'), title: title.slice(0, 250), description: description || null, assignedTo: employeeId, assignedBy: requester.id,
          createdAt: stamp, dueDate: targetDate, estimatedHours: null, status: open.id, completedAt: null, actualHours: null,
          repeatType: 'none', repeatParentId: null, availableFrom: targetDate, releaseNotified: false, importKey: key, updates: []
        });
        created++;
      });
      releaseScheduledTasks();
      return { ok: true, created: created, duplicates: duplicates, invalid: invalid };
    }
  };

  var READ_ONLY = { bootstrap: 1, list_notifications: 1, list_reports: 1, get_report: 1 };

  function request(action, payload) {
    return load().then(function () {
      var handler = actions[action];
      if (!handler) throw fail('Unknown action: ' + action);
      return handler(payload || {});
    }).then(function (result) {
      if (!READ_ONLY[action]) save();
      return clone(result);
    });
  }

  window.LogbookStore = {
    request: request,
    reset: reset
  };
})();
