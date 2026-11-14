/**
 * 이 스크립트가 붙어 있는 스프레드시트 하나만 다루도록 권한을 제한합니다.
 * @OnlyCurrentDoc
 */

/**
 * 내 운동 기록 — 구글 시트 저장 서버 (Google Apps Script)
 *
 * 사용법
 *  1. 구글 시트 → 확장 프로그램 → Apps Script 에 이 파일 내용을 통째로 붙여넣고 저장합니다.
 *  2. 위쪽 함수 선택 칸에서 setup 을 고르고 ▶ 실행을 누릅니다.
 *     - 필요한 시트 탭이 만들어지고, 비밀 토큰이 실행 로그에 나옵니다.
 *  3. 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자)
 *
 * 이 파일을 고친 뒤에는 "배포 관리 → 편집 → 새 버전"으로 다시 배포해야 반영됩니다.
 * 토큰은 이 파일에 적지 않습니다. 스크립트 속성(TOKEN)에만 저장됩니다.
 *
 * 시트 탭
 *  sessions   앱이 읽고 쓰는 운동 기록 원본 (하루에 한 줄)
 *  sets       사람이 보는 용도 (세트 하나에 한 줄, 앱이 매번 다시 씀)
 *  body       체중 기록
 *  notes      운동별 머신 세팅 메모
 *  routines   루틴 목록 (직접 고쳐도 됨)
 *  exercises  루틴별 운동 목록 (직접 고쳐도 됨)
 *  config     주간 목표 등 설정 (직접 고쳐도 됨)
 */

// text: 글자 그대로 보관해야 하는 열 번호 (날짜·숫자로 자동 변환되는 것을 막음)
var DEFS = {
  sessions: { name: 'sessions', head: ['id', 'date', 'routine', 'data_json', 'memo', 'updatedAt'], text: [1, 2, 3, 4, 5, 6] },
  sets: { name: 'sets', head: ['sessionId', 'date', 'routine', 'exerciseId', 'exercise', 'set', 'weight', 'reps', 'updatedAt'], text: [1, 2, 3, 4, 5, 9] },
  body: { name: 'body', head: ['date', 'weight', 'updatedAt'], text: [1, 3] },
  notes: { name: 'notes', head: ['exerciseId', 'exercise', 'note', 'updatedAt'], text: [1, 2, 3, 4] },
  routines: {
    name: 'routines',
    head: ['루틴 키', '제목', '버튼 글자', '색', '지난 루틴이면 TRUE', '워밍업 (한 줄에 하나)', '마무리 (한 줄에 하나)'],
    text: [1, 2, 3, 4, 5, 6, 7]
  },
  exercises: {
    name: 'exercises',
    head: ['루틴 키', 'id (바꾸지 마세요)', '운동 이름', '부위', '세트 수', '횟수 표시', '최소 횟수', '목표 횟수',
      '시작 무게 안내', '휴식(초)', '증량 단위(kg)', '대체 운동 (쉼표로 구분)', '꿀팁 (한 줄에 "라벨: 내용")'],
    text: [1, 2, 3, 4, 6, 9, 12, 13]
  },
  config: {
    name: 'config', head: ['key', 'value', '설명'], text: [1, 2, 3],
    rows: [
      ['weeklyGoal', '3', '일주일에 운동할 횟수'],
      ['programStart', '', '프로그램 시작일 (예: 2026-11-16). 비워 두면 첫 기록 날짜'],
      ['changeWeek', '5', '이 주차가 되면 "루틴을 바꿀 때" 알림을 띄움. 0이면 끔']
    ]
  }
};

/* ---------- 처음 한 번 실행 ---------- */

function setup() {
  ensureSheets_();
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('TOKEN', token);
  }
  Logger.log('준비 완료! 아래 토큰을 복사해서 앱의 설정 화면에 붙여넣으세요.');
  Logger.log('TOKEN: ' + token);
}

/* ---------- 웹 앱 입구 ---------- */

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    out = checkToken_(req.token) ? handle_(req) : { ok: false, error: 'unauthorized' };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function doGet() {
  return json_({ ok: false, error: 'POST only' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var saved = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return typeof token === 'string' && !!saved && token === saved;
}

function handle_(req) {
  switch (req.action) {
    case 'ping':
      return { ok: true };
    case 'list':
      return list_();
    case 'save':
      return withLock_(function () { return saveSession_(req.session, req.names || {}); });
    case 'delete':
      return withLock_(function () { deleteSession_(String(req.id || '')); return { ok: true }; });
    case 'note':
      return withLock_(function () { saveNote_(req.exId, req.name, req.text); return { ok: true }; });
    case 'body':
      return withLock_(function () { saveBody_(req.date, req.kg); return { ok: true }; });
    case 'initRoutines':
      return withLock_(function () { return initRoutines_(req.routines); });
    default:
      return { ok: false, error: 'unknown action' };
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 시트 준비 ---------- */

function ensureSheets_() {
  Object.keys(DEFS).forEach(function (k) { sheet_(DEFS[k]); });
}

function sheet_(def) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    def.text.forEach(function (c) {
      sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    sh.getRange(1, 1, 1, def.head.length).setValues([def.head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (def.rows) sh.getRange(2, 1, def.rows.length, def.head.length).setValues(def.rows);
  }
  return sh;
}

function ensureRows_(sh, need) {
  var max = sh.getMaxRows();
  if (need > max) sh.insertRowsAfter(max, need - max + 100);
}

// 머리글 아래의 모든 행
function rows_(def) {
  var sh = sheet_(def);
  var last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, def.head.length).getValues();
}

function findRow_(sh, key) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (str_(ids[i][0]) === key) return i + 2;
  }
  return 0;
}

// 첫 열이 key인 행을 덮어쓰거나 추가. row가 null이면 그 행을 삭제.
function upsert_(def, key, row) {
  var sh = sheet_(def);
  var r = findRow_(sh, key);
  if (!row) {
    if (r) {
      ensureRows_(sh, sh.getLastRow() + 1); // 마지막 남은 행을 지울 때 오류가 나지 않게
      sh.deleteRow(r);
    }
    return;
  }
  if (!r) {
    r = sh.getLastRow() + 1;
    ensureRows_(sh, r);
  }
  def.text.forEach(function (c) {
    if (c <= row.length) sh.getRange(r, c, 1, 1).setNumberFormat('@');
  });
  sh.getRange(r, 1, 1, row.length).setValues([row]);
}

/* ---------- 값 다듬기 ---------- */

// =, +, -, @ 로 시작하는 글자가 수식으로 바뀌지 않게 앞에 ' 를 붙임
function guard_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@']/.test(s) ? "'" + s : s;
}

function unguard_(v) {
  var s = String(v == null ? '' : v);
  return /^'[=+\-@']/.test(s) ? s.slice(1) : s;
}

function str_(v) {
  return unguard_(v).trim();
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function dateStr_(v) {
  if (isDate_(v)) {
    return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(v == null ? '' : v).trim();
}

function iso_(v) {
  return isDate_(v) ? v.toISOString() : String(v == null ? '' : v);
}

function num_(v) {
  if (v === '' || v == null) return '';
  var n = parseFloat(v);
  return isNaN(n) ? '' : n;
}

function int_(v) {
  var n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function lines_(v) {
  return str_(v).split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function truthy_(v) {
  return v === true || /^(true|y|yes|1|o|예|네)$/i.test(str_(v));
}

/* ---------- 읽기 ---------- */

function list_() {
  ensureSheets_();
  var r = readRoutines_();
  return {
    ok: true,
    sessions: listSessions_(),
    body: readBody_(),
    notes: readNotes_(),
    config: readConfig_(),
    routines: r.routines,
    warnings: r.warnings
  };
}

function listSessions_() {
  var out = [];
  rows_(DEFS.sessions).forEach(function (r) {
    var id = str_(r[0]);
    if (!id) return;
    var ex = {};
    try {
      ex = JSON.parse(String(r[3] || '{}')) || {};
    } catch (e) {
      ex = {};
    }
    out.push({ id: id, date: dateStr_(r[1]), routine: str_(r[2]), ex: ex, memo: unguard_(r[4]), updatedAt: iso_(r[5]) });
  });
  return out;
}

function readBody_() {
  var out = {};
  rows_(DEFS.body).forEach(function (r) {
    var d = dateStr_(r[0]);
    var kg = num_(r[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && kg !== '') out[d] = String(kg);
  });
  return out;
}

function readNotes_() {
  var out = {};
  rows_(DEFS.notes).forEach(function (r) {
    var id = str_(r[0]);
    var text = str_(r[2]);
    if (id && text) out[id] = text;
  });
  return out;
}

function readConfig_() {
  var out = {};
  rows_(DEFS.config).forEach(function (r) {
    var k = str_(r[0]);
    if (k) out[k] = isDate_(r[1]) ? dateStr_(r[1]) : str_(r[1]);
  });
  return out;
}

// routines + exercises 탭을 앱이 쓰는 모양으로 바꿈. 운동이 하나도 없으면 routines: null.
function readRoutines_() {
  var warnings = [];
  var exRows = rows_(DEFS.exercises);
  var meta = {};
  var order = [];
  function routine(k) {
    if (!meta[k]) {
      meta[k] = { title: '루틴 ' + k, color: '#6b7280', warm: [], cool: [], ex: [] };
      order.push(k);
    }
    return meta[k];
  }
  rows_(DEFS.routines).forEach(function (r) {
    var k = str_(r[0]);
    if (!k) return;
    var m = routine(k);
    if (str_(r[1])) m.title = str_(r[1]);
    if (str_(r[2])) m.label = str_(r[2]);
    if (/^#[0-9a-fA-F]{3,8}$/.test(str_(r[3]))) m.color = str_(r[3]);
    if (truthy_(r[4])) m.archived = true;
    m.warm = lines_(r[5]);
    m.cool = lines_(r[6]);
  });

  var seen = {};
  var newIds = [];
  exRows.forEach(function (r, i) {
    var rowNo = i + 2;
    var k = str_(r[0]);
    var name = str_(r[2]);
    if (!k && !name) return; // 빈 줄
    if (!k || !name) {
      warnings.push('exercises ' + rowNo + '행: 루틴 키와 운동 이름이 모두 필요해요');
      return;
    }
    var id = str_(r[1]);
    if (!id) {
      id = 'e' + new Date().getTime().toString(36) + i;
      newIds.push([rowNo, id]);
    }
    if (seen[k + '|' + id]) {
      warnings.push('exercises ' + rowNo + '행: 같은 루틴 안에 id가 겹쳐요 (' + id + ')');
      return;
    }
    seen[k + '|' + id] = true;
    var repsTxt = str_(r[5]);
    var found = repsTxt.match(/\d+/g) || [];
    var hi = int_(r[7]) || int_(found[found.length > 1 ? 1 : 0]) || 10;
    var lo = int_(r[6]) || int_(found[0]) || hi;
    if (lo > hi) lo = hi;
    var step = num_(r[10]);
    routine(k).ex.push({
      id: id,
      name: name,
      part: str_(r[3]),
      sets: int_(r[4]) || 3,
      reps: repsTxt || String(hi),
      lo: lo,
      hi: hi,
      start: str_(r[8]),
      rest: int_(r[9]) || 90,
      step: step !== '' && step > 0 ? step : 2.5,
      alt: str_(r[11]).split(/[,，、]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; }),
      items: lines_(r[12]).map(function (line) {
        var m = line.match(/^([^:：]{1,8})[:：]\s*(.+)$/);
        return m ? [m[1].trim(), m[2].trim()] : ['꿀팁', line];
      })
    });
  });

  // 비어 있던 id 칸에는 새 id를 적어 둠 (이후 기록이 이 id로 이어짐)
  if (newIds.length) {
    withLock_(function () {
      var sh = sheet_(DEFS.exercises);
      newIds.forEach(function (p) {
        sh.getRange(p[0], 2, 1, 1).setNumberFormat('@').setValues([[p[1]]]);
      });
    });
  }

  var out = {};
  var count = 0;
  order.forEach(function (k) {
    if (!meta[k].ex.length) {
      warnings.push('routines: "' + k + '" 루틴에 운동이 없어요 (exercises 탭 확인)');
      return;
    }
    out[k] = meta[k];
    count++;
  });
  return { routines: count ? out : null, warnings: warnings };
}

/* ---------- 쓰기 ---------- */

function saveSession_(s, names) {
  if (!s || typeof s !== 'object') throw new Error('session required');
  var date = String(s.date || '');
  var routine = String(s.routine || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  if (!routine) throw new Error('bad routine');
  var id = date + '_' + routine;
  var ex = s.ex && typeof s.ex === 'object' ? s.ex : {};
  var now = new Date().toISOString();

  upsert_(DEFS.sessions, id, [id, date, guard_(routine), JSON.stringify(ex), guard_(s.memo), now]);

  var rows = [];
  Object.keys(ex).forEach(function (exId) {
    var e = ex[exId] || {};
    var reps = e.reps || [];
    var ws = e.ws || [];
    var name = names[exId] || e.name || exId;
    for (var i = 0; i < reps.length; i++) {
      var n = num_(reps[i]);
      if (n === '') continue;
      var w = num_(ws[i] !== '' && ws[i] != null ? ws[i] : e.w); // 세트별 무게가 있으면 그 값
      rows.push([id, date, guard_(routine), guard_(exId), guard_(name), i + 1, w, n, now]);
    }
  });
  replaceSets_(id, rows);

  return { ok: true, updatedAt: now };
}

function deleteSession_(id) {
  if (!id) throw new Error('id required');
  upsert_(DEFS.sessions, id, null);
  replaceSets_(id, []);
}

// sets 시트에서 해당 세션의 행을 빼고 새 행을 맨 아래에 붙임.
// 세션의 첫 행부터 아래쪽만 다시 쓰므로 기록이 쌓여도 느려지지 않음.
function replaceSets_(id, rows) {
  var def = DEFS.sets;
  var sh = sheet_(def);
  var width = def.head.length;
  var last = sh.getLastRow();
  var start = last + 1;
  var tail = [];
  if (last >= 2) {
    var all = sh.getRange(2, 1, last - 1, width).getValues();
    var first = -1;
    for (var i = 0; i < all.length; i++) {
      if (str_(all[i][0]) === id) {
        first = i;
        break;
      }
    }
    if (first >= 0) {
      start = first + 2;
      for (var j = first; j < all.length; j++) {
        if (str_(all[j][0]) === id) continue;
        var keep = all[j].slice();
        // 다시 쓸 때 글자 열이 수식으로 바뀌지 않게 한 번 더 보호
        [2, 3, 4].forEach(function (c) {
          keep[c] = guard_(unguard_(keep[c]));
        });
        keep[1] = dateStr_(keep[1]);
        keep[8] = iso_(keep[8]);
        tail.push(keep);
      }
      sh.getRange(start, 1, last - start + 1, width).clearContent();
    }
  }
  var out = tail.concat(rows);
  if (!out.length) return;
  ensureRows_(sh, start + out.length - 1);
  def.text.forEach(function (c) {
    sh.getRange(start, c, out.length, 1).setNumberFormat('@');
  });
  sh.getRange(start, 1, out.length, width).setValues(out);
}

function saveNote_(exId, name, text) {
  exId = String(exId || '').trim();
  if (!exId) throw new Error('exId required');
  text = String(text == null ? '' : text).trim();
  upsert_(DEFS.notes, exId, text ? [guard_(exId), guard_(name || exId), guard_(text), new Date().toISOString()] : null);
}

function saveBody_(date, kg) {
  date = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  var n = num_(kg);
  upsert_(DEFS.body, date, n === '' ? null : [date, n, new Date().toISOString()]);
}

// exercises 탭이 비어 있을 때만, 앱이 갖고 있던 기본 루틴으로 두 탭을 채움
function initRoutines_(routines) {
  if (!routines || typeof routines !== 'object') throw new Error('routines required');
  if (rows_(DEFS.exercises).length) return { ok: true, skipped: true };
  var rRows = [];
  var eRows = [];
  Object.keys(routines).forEach(function (k) {
    var r = routines[k] || {};
    if (!r.ex || !r.ex.length) return;
    rRows.push([guard_(k), guard_(r.title), guard_(r.label), guard_(r.color), r.archived ? 'TRUE' : '',
      guard_((r.warm || []).join('\n')), guard_((r.cool || []).join('\n'))]);
    r.ex.forEach(function (x) {
      eRows.push([guard_(k), guard_(x.id), guard_(x.name), guard_(x.part), int_(x.sets) || 3, guard_(x.reps),
        int_(x.lo), int_(x.hi), guard_(x.start), int_(x.rest) || 90, num_(x.step), guard_((x.alt || []).join(', ')),
        guard_((x.items || []).map(function (it) { return it[0] + ': ' + it[1]; }).join('\n'))]);
    });
  });
  if (!eRows.length) throw new Error('no exercises');
  writeAll_(DEFS.routines, rRows);
  writeAll_(DEFS.exercises, eRows);
  return { ok: true };
}

function writeAll_(def, rows) {
  var sh = sheet_(def);
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, def.head.length).clearContent();
  ensureRows_(sh, rows.length + 1);
  def.text.forEach(function (c) {
    sh.getRange(2, c, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(2, 1, rows.length, def.head.length).setValues(rows);
}
