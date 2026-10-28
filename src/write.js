// Resource, schedule and mail writes: a preview unless args.confirm is exactly true, one write call that
// is never retried, a read-back, and a result it cannot confirm says to check the groupware instead
// of inviting another try.
import { GroupwareError, SessionError, request } from "./client.js";
import { calendarRows, calendars, companyInfo, fetchMailFolders, fetchResources, fmtStamp, num, parseLocal,
  resolveAttendees, scheduleRows, toApiDt } from "./read.js";

const CHECK = "그룹웨어에서 확인해 주세요.";

// Python's str() and truthiness: a missing field compares as "None", an empty list or dict is
// false, so every guard fails closed exactly where the Python one does
const str = (v) => (v == null ? "None" : typeof v === "object" ? JSON.stringify(v) : String(v));
const py = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));
const or = (...xs) => xs.find(py) ?? xs[xs.length - 1] ?? null;   // Python's `a or b or c`
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const label = (p) => `${str(p.empName)} (${str(p.deptName)})`;

// the flag may arrive as 1, "1" or true; 0, "0", false and a missing flag are not a success
const succeeded = (result) => ["1", "true"].includes(str((isDict(result) ? result : {}).successTf).toLowerCase());

// One write call. A SessionError means the gateway refused it before it ran, so the caller's one
// re-login sends the first write, not a second; anything else unclear may have landed and must
// say so. No cause is kept: transport text can carry header values.
async function writeOnce(session, path, body, what, { fetch, full = false } = {}) {
  try {
    return await request(session, path, body, { fetch, full });
  } catch (e) {
    if (e instanceof SessionError) throw e;
    if (e instanceof GroupwareError) throw new GroupwareError(`${e.message} ${CHECK}`);
    throw new GroupwareError(`${what} 결과를 확인하지 못했습니다. ${CHECK}`);
  }
}

// ---- resources
export async function reserveResource(session, { res_seq, start, end, title, description = "", attendees = null,
  confirm = false } = {}, { fetch, now = () => new Date() } = {}) {
  const startDt = parseLocal(start), endDt = parseLocal(end);
  if (endDt <= startDt) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  if (startDt < now()) throw new GroupwareError("시작 시각이 이미 지났습니다.");
  const res = (await fetchResources(session, {}, { fetch })).find((r) => str(r.res_seq) === str(res_seq));
  if (!res) throw new GroupwareError(`자원 ${str(res_seq)}을(를) 찾을 수 없습니다.`);
  // every name settles before the availability check and the write
  const people = await resolveAttendees(session, attendees, { fetch });
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);
  const resSeq = res.res_seq;   // the API's own value, not the caller's spelling of it
  const check = await request(session, "/schres/rs121A04",
    { companyInfo: companyInfo(session), resSeq, startDate: apiStart, endDate: apiEnd, alldayYn: "N",
      resStartDate: apiStart.slice(0, 8) }, { fetch });
  // fail closed: only an explicit "N" is free; a missing or renamed field must not unlock the write
  const available = str((isDict(check) ? check : {}).reservationYn) === "N";
  const preview = { resource: res.name, start, end, available, approval_required: res.approval_required,
    attendees: people.map(label) };
  if (confirm !== true) return preview;
  if (!available) throw new GroupwareError("그 시간대에는 이미 예약이 있습니다.");
  const u = session.user;
  const me = { groupSeq: u.groupSeq ?? null, compSeq: u.compSeq ?? null, deptSeq: u.deptSeq ?? null, empSeq: u.empSeq ?? null };
  // the booker first, then each attendee; these four org keys are all the API needs
  const subscribers = [me, ...people.filter((p) => str(p.empSeq) !== str(me.empSeq)).map((p) => ({
    groupSeq: me.groupSeq, compSeq: p.compSeq ?? null, deptSeq: p.deptSeq ?? null, empSeq: p.empSeq ?? null }))];
  const result = await writeOnce(session, "/schres/rs121A06",
    { companyInfo: companyInfo(session), langCode: "kr", resSeq, reqText: title,
      apprYn: res.approval_required ? "Y" : "N", alldayYn: "N", startDate: apiStart, endDate: apiEnd,
      descText: description, resSubscriberList: subscribers, uidList: "", repeatType: "10", repeatEndDay: "" },
    "예약", { fetch });
  if (!succeeded(result)) throw new GroupwareError(`예약 결과를 확인하지 못했습니다. ${CHECK}`);
  return { ...preview, reserved: true };
}

// my bookings of res_seq at exactly start–end, from that day's list
async function myBookings(session, res_seq, start, end, fetch) {
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);   // bad times fail before any request
  const day = String(start).slice(0, 10), me = str(session.user.empSeq);
  return (await scheduleRows(session, day, day, [str(res_seq)], fetch)).filter((r) =>
    str(r.resStartDate) === apiStart && str(r.resEndDate) === apiEnd && str(r.empSeq) === me);
}

function onlyOne(found, what) {
  if (!found.length) throw new GroupwareError(`그 시간에 ${what} 본인 예약을 찾지 못했습니다.`);
  if (found.length > 1) throw new GroupwareError("같은 시간에 본인 예약이 여러 건이라 하나로 정하지 못했습니다.");
  return found[0];
}

export async function cancelReservation(session, { res_seq, start, end, confirm = false } = {}, { fetch } = {}) {
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);
  const matches = () => myBookings(session, res_seq, start, end, fetch);
  const r = onlyOne(await matches(), "취소할");
  const preview = { resource: or(r.resName, ""), title: or(r.reqText, ""), start, end };
  if (confirm !== true) return preview;
  const item = { resSeq: str(r.resSeq), seqNum: r.seqNum ?? null, resIdx: str(r.resIdx), reqText: r.reqText ?? null,
    startDate: apiStart, endDate: apiEnd, createDate: str(r.createDate), schmSeq: or(r.schmSeq, ""),
    schSeq: or(r.schSeq, ""), resName: r.resName ?? null, alldayYn: or(r.alldayYn, "N") };
  const result = await writeOnce(session, "/schres/rs121A11",
    { companyInfo: companyInfo(session), statusCode: "CA", deleteRangeCode: "UO", resSeqList: [item], langCode: "kr" },
    "취소", { fetch });
  // one call, no retry: an unclear answer is checked by reading, then left to a person. The check
  // runs after the cancel went out, so its own failure must not reach the caller's re-login and rerun
  const gone = succeeded(result) && await matches().then((rows) => !rows.length, () => false);
  if (!gone) throw new GroupwareError(`취소 결과를 확인하지 못했습니다. ${CHECK}`);
  return { ...preview, cancelled: true };
}

async function reservationDetail(session, resSeq, seqNum, fetch) {
  const d = await request(session, "/schres/rs121A10",
    { companyInfo: companyInfo(session), resSeq: str(resSeq), seqNum, langCode: "kr" }, { fetch });
  // without its keys and times the update would send "None" for them
  if (!isDict(d) || !["resSeq", "seqNum", "resIdx", "startDate", "endDate", "createDate"].every((k) => py(d[k]))) {
    throw new GroupwareError("예약 상세를 찾지 못했습니다.");
  }
  return d;
}

const LIVE = new Set(["RC", "RE", "CO"]);   // 예약완료, 승인요청, 승인완료
const resView = (title, start, end) => ({ title, start, end });

// updateReservation: the web client's edit form (rs121A12) for a plain one-off booking of mine;
// the stored fields go back as they are, with these set
export async function updateReservation(session, { res_seq, start, end, title = null, new_start = null, new_end = null,
  description = null, confirm = false } = {}, { fetch, now = () => new Date() } = {}) {
  if ([title, new_start, new_end, description].every((v) => v == null)) {
    throw new GroupwareError("바꿀 값(title, new_start, new_end, description)이 없습니다.");
  }
  if (title != null && !title.trim()) throw new GroupwareError("예약 제목은 비울 수 없습니다.");
  const from = new_start ?? start, to = new_end ?? end;
  const apiFrom = toApiDt(from), apiTo = toApiDt(to);   // bad times fail before any request
  if (apiTo <= apiFrom) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  if (parseLocal(end) <= now()) throw new GroupwareError("이미 끝난 예약입니다.");
  if (new_start != null && parseLocal(new_start) < now()) throw new GroupwareError("시작 시각이 이미 지났습니다.");
  const r = onlyOne(await myBookings(session, res_seq, start, end, fetch), "수정할");
  const d = await reservationDetail(session, r.resSeq, r.seqNum ?? null, fetch);
  // fail closed: only the booking just matched, mine, one-off, timed, live, with no file or linked schedule
  for (const [broken, why] of [
    [str(d.seqNum) !== str(r.seqNum) || str(d.startDate) !== toApiDt(start) || str(d.endDate) !== toApiDt(end),
      "예약 상세가 목록과 다릅니다"],
    [str(d.empSeq) !== str(session.user.empSeq), "본인 예약이 아닙니다"],
    [str(d.repeatType) !== "10", "반복 예약입니다"],
    [str(d.alldayYn) !== "N", "종일 예약입니다"],
    [!LIVE.has(str(d.statusCode)), "취소·반려된 예약입니다"],
    [!["Y", "N"].includes(str(d.apprYn)), "승인 여부를 알 수 없는 자원입니다"],
    [py(d.schSeq) || py(d.schmSeq), "일정과 연결된 예약입니다"],
    [py(d.fileList) || py(d.file), "첨부파일이 있는 예약입니다"],
    [!Array.isArray(d.subscriberList) || !d.subscriberList.length, "예약자 정보가 없습니다"]]) {
    if (broken) throw new GroupwareError(`${why}. 이 도구로는 수정하지 않습니다.`);
  }
  const max = num(String(d.limitReservationRange ?? "").replace(/,/g, ""));   // minutes, as the web form reads it
  if (max > 0 && (parseLocal(to) - parseLocal(from)) / 60000 > max) {
    throw new GroupwareError(`이 자원은 최대 ${max / 60}시간까지만 예약할 수 있습니다.`);
  }
  const next = [title != null ? title.trim() : or(d.reqText, ""), apiFrom, apiTo];
  let available = true;
  if (apiFrom !== str(d.startDate) || apiTo !== str(d.endDate)) {
    // rs121A04 counts this booking as taken, so the overlap list (rs121A14) without it decides,
    // and rs121A04 only says whether the resource's usage limit allows the new time
    const limit = await request(session, "/schres/rs121A04", { companyInfo: companyInfo(session), resSeq: d.resSeq,
      startDate: apiFrom, endDate: apiTo, alldayYn: "N", resStartDate: apiFrom.slice(0, 8) }, { fetch });
    if (str((isDict(limit) ? limit : {}).limitYn) !== "N") throw new GroupwareError("자원 이용 제한 설정에 따라 그 시간에는 예약할 수 없습니다.");
    const used = await request(session, "/schres/rs121A14", { companyInfo: companyInfo(session), resSeq: d.resSeq,
      startDate: apiFrom, endDate: apiTo, alldayYn: "N", repeatType: "10", repeatEndDay: apiFrom.slice(0, 8),
      repeatByDay: "" }, { fetch });
    const rows = isDict(used) ? used.usedResList : null;
    // fail closed: an unreadable answer or any other booking not cancelled or rejected is a conflict
    available = Array.isArray(rows) && !rows.some((u) => !(str(u.seqNum) === str(d.seqNum) && str(u.resIdx) === str(d.resIdx))
      && str(u.limitYn) !== "Y" && !["CA", "CR", "AC", "RJ"].includes(str(u.statusCode)));
  }
  const after = resView(next[0], from, to);
  if (description != null) after.description = description;
  const preview = { resource: or(d.resName, ""), before: resView(or(d.reqText, ""), start, end), after, available,
    approval_required: d.apprYn === "Y" };
  if (confirm !== true) return preview;
  if (!available) throw new GroupwareError("그 시간대에는 이미 다른 예약이 있습니다.");
  const result = await writeOnce(session, "/schres/rs121A12",
    { companyInfo: companyInfo(session), langCode: "kr", resSeq: d.resSeq, seqNum: d.seqNum, resIdx: d.resIdx,
      reqText: next[0], apprYn: d.apprYn, alldayYn: "N", startDatePk: d.startDate, createDatePk: d.createDate,
      startDate: next[1], endDate: next[2], descText: description ?? or(d.descText, ""),
      resSubscriberList: d.subscriberList.map((p) => ({ groupSeq: p.groupSeq ?? null, compSeq: p.compSeq ?? null,
        deptSeq: p.deptSeq ?? null, empSeq: p.empSeq ?? null })),
      uidList: "", repeatType: "10", repeatEndDay: "", repeatByDay: "", resName: d.resName ?? null },
    "예약 수정", { fetch });
  // the edit books anew and cancels the old one (live 2026-10-28: a new seqNum, the old one CA), so
  // the check reads the day's list. Written already: a failed check must not read as "not changed" or repeat the write
  const landed = succeeded(result) && await myBookings(session, d.resSeq, from, to, fetch)
    .then((rows) => rows.filter((x) => x.reqText === next[0]).length === 1, () => false);
  if (!landed) throw new GroupwareError(`예약 수정 결과를 확인하지 못했습니다. ${CHECK}`);
  return { ...preview, updated: true };
}

// ---- schedules
async function writeCalendar(session, fetch) {
  // looked up on every write, never a constant: a personal (E) calendar this account may write
  let mine = (await calendars(session, { fetch }))
    .filter((c) => c.calType === "E" && str(or(c.calRwGbn, "")).toLowerCase() === "w");
  if (mine.length > 1) {
    mine = mine.filter((c) => str(c.empSeq) === str(session.user.empSeq));
    if (mine.length !== 1) throw new GroupwareError("쓰기 가능한 개인 캘린더가 여러 개라 하나로 정하지 못했습니다.");
  }
  if (!mine.length) throw new GroupwareError("쓰기 가능한 개인 캘린더를 찾지 못했습니다.");
  return mine[0];
}

async function scheduleDetail(session, schSeq, fetch) {
  const data = await request(session, "/schres/sc111A04",
    { companyInfo: companyInfo(session), schSeq: str(schSeq), tcalSeq: "", langCode: "kr" }, { fetch });
  // without its ids and times an update would send "None" for them
  if (!isDict(data) || !py(data) || !["schSeq", "schmSeq", "startDate", "endDate"].every((k) => py(data[k]))) {
    throw new GroupwareError(`일정 ${str(schSeq)}을(를) 찾지 못했습니다.`);
  }
  return data;
}

// createSchedule: one plain, timed schedule in my own calendar
const schedulePayload = (session, cal, title, start, end, place, memo, invitees) => {
  const me = session.user;
  return {
    companyInfo: companyInfo(session), langCode: "kr",
    schmSeq: "0", schSeq: "0", mcalSeq: str(cal.mcalSeq),
    schTitle: title, startDate: start, endDate: end,
    alldayYn: "N", lunarYn: "N", alarm_yn: "N",
    gbnCode: cal.calType ?? null, calType: cal.calType ?? null, gbnSeq: "",
    schGbnCode: "10", repeatType: "10", repeatEndDay: "", repeatByDay: "",
    contents: memo, rangeCode: "N", schPlace: place, placeMapData: "{}",
    placeFileId: "", fileId: "", delFileList: [], uidList: "",
    resList: [], reservedList: [], schAlarmList: [], schUserList: [],
    // the creator is not invited; the search result has no groupSeq, so mine fills it
    schPartEmpList: invitees.map((p) => ({ compSeq: p.compSeq ?? null, groupSeq: me.groupSeq ?? null,
      deptSeq: p.deptSeq ?? null, empSeq: p.empSeq ?? null, dutyPositionOption: "0" })),
    addressUserList: [], inviterPartType: "M", companyEmpSeq: me.empSeq ?? null,
    empSeq: me.empSeq ?? null, groupSeq: me.groupSeq ?? null, otherLinkList: [],
    schModuleGbn: null, schModuleSeq: null, myMemo: "", videoYn: "N",
    mailSend: "N" };
};

export async function createSchedule(session, { title, start, end, place = "", memo = "", attendees = null,
  confirm = false } = {}, { fetch } = {}) {
  title = title.trim();
  if (!title) throw new GroupwareError("일정 제목이 비어 있습니다.");
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);   // bad times fail before any request
  if (apiEnd <= apiStart) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  const cal = await writeCalendar(session, fetch);
  const people = await resolveAttendees(session, attendees, { fetch });   // all settle before the write
  const preview = { calendar: or(cal.calTitle, ""), title, start, end, place, memo, attendees: people.map(label) };
  if (confirm !== true) return preview;
  const me = str(session.user.empSeq);
  const invitees = people.filter((p) => str(p.empSeq) !== me);
  const result = await writeOnce(session, "/schres/sc111A05",
    schedulePayload(session, cal, title, apiStart, apiEnd, place, memo, invitees), "일정 등록", { fetch });
  let sch = isDict(result) ? result.schSeq ?? null : null;
  // written already: a failed check must neither read as "not created" nor, as a SessionError,
  // make the caller's re-login run the write again
  let got;
  try {
    if (!py(sch)) {   // no id in the answer: the list must hold exactly the one just written
      const rows = await calendarRows(session, apiStart.slice(0, 8), apiEnd.slice(0, 8), [cal], false, { fetch });
      const same = rows.filter((r) => r.schTitle === title && str(r.startDate) === apiStart && str(r.endDate) === apiEnd);
      sch = same.length === 1 ? same[0].schSeq ?? null : null;
    }
    got = py(sch) ? await scheduleDetail(session, sch, fetch) : {};
  } catch {   // a timeout too: the write went out, so any failed check is "unconfirmed"
    got = {};
  }
  if (got.schTitle !== title || str(got.startDate) !== apiStart || str(got.endDate) !== apiEnd
      || str(got.mcalSeq) !== str(cal.mcalSeq)) {
    const where = py(sch) ? `(sch_seq ${str(sch)})` : "";
    throw new GroupwareError(`일정 등록 결과를 확인하지 못했습니다${where}. ${CHECK}`);
  }
  return { ...preview, created: true, sch_seq: sch };
}

const schView = (title, start, end) => ({ title, start: fmtStamp(start), end: fmtStamp(end) });

function checkSimple(detail, cal, session) {
  // fail closed: only a plain one-off schedule in my own
  // calendar, tied to no resource, module, file or other person, is rewritten or deleted
  const me = str(session.user.empSeq);
  const others = or(detail.schPartEmpList, []).filter((p) => str(or(p.empSeq, p.orgSeq, "")) !== me);
  for (const [broken, why] of [
    [str(detail.mcalSeq) !== str(cal.mcalSeq), "내 개인 캘린더의 일정이 아닙니다"],
    [str(detail.repeatType) !== "10", "반복 일정입니다"],
    [["resList", "resources", "reservedList"].some((k) => py(detail[k])), "자원이 연결된 일정입니다"],
    [py(detail.addressUserList), "외부 참석자가 있는 일정입니다"],
    [others.length > 0, "다른 참석자가 있는 일정입니다"],
    [py(or(detail.schModuleGbn, detail.schModuleSeq)), "외부 모듈과 연결된 일정입니다"],
    [py(detail.fileList) || num(detail.fileCnt) > 0, "첨부파일이 있는 일정입니다"]]) {
    if (broken) throw new GroupwareError(`${why}. 이 도구로는 수정·삭제하지 않습니다.`);
  }
}

// updateSchedule: the stored detail goes back whole, with these set
const updatePayload = (session, cal, d, sch, title, start, end) => ({
  ...d, companyInfo: companyInfo(session), langCode: "kr",
  schSeq: str(sch), schmSeq: str(d.schmSeq),
  mcalSeq: str(cal.mcalSeq), schTitle: title, startDate: start,
  endDate: end, contents: or(d.contents, ""), alldayYn: "N",
  lunarYn: or(d.lunarYn, "N"),
  // like create: the flag follows the reminders, so a reminder set in the UI is kept
  alarm_yn: py(d.schAlarmList) ? "Y" : "N",
  gbnCode: or(d.gbnCode, d.calType, cal.calType),
  calType: or(d.calType, d.gbnCode, cal.calType),
  schGbnCode: or(d.schGbnCode, "10"), repeatType: "10", rangeCode: "UO",
  resList: [], reservedList: [], schAlarmList: or(d.schAlarmList, []),
  schUserList: or(d.schUserList, []).filter((u) => u.userType !== "30"),
  schPartEmpList: or(d.schPartEmpList, []),
  addressUserList: or(d.addressUserList, []), delFileList: [],
  uidList: "", empSeq: session.user.empSeq ?? null,
  groupSeq: session.user.groupSeq ?? null, alarmOnModify: false, mailSend: "N" });

export async function updateSchedule(session, { sch_seq, title = null, start = null, end = null, confirm = false } = {},
  { fetch } = {}) {
  if (title == null && start == null && end == null) throw new GroupwareError("바꿀 값(title, start, end)이 없습니다.");
  if (title != null && !title.trim()) throw new GroupwareError("일정 제목은 비울 수 없습니다.");
  const newStart = start != null ? toApiDt(start) : null;   // bad times fail first
  const newEnd = end != null ? toApiDt(end) : null;
  const detail = await scheduleDetail(session, sch_seq, fetch);
  const cal = await writeCalendar(session, fetch);
  checkSimple(detail, cal, session);
  if (str(detail.alldayYn) === "Y") {   // the update sends alldayYn "N" and would drop it
    throw new GroupwareError("종일 일정입니다. 이 도구로는 수정하지 않습니다.");
  }
  const old = [or(detail.schTitle, ""), str(detail.startDate), str(detail.endDate)];
  const next = [title != null ? title.trim() : old[0], newStart || old[1], newEnd || old[2]];
  if (next[2] <= next[1]) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  const sch = or(detail.schSeq, sch_seq);
  if (confirm !== true) return { sch_seq: sch, before: schView(...old), after: schView(...next) };
  await writeOnce(session, "/schres/sc111A05", updatePayload(session, cal, detail, sch, ...next), "일정 수정", { fetch });
  // written already: a failed check must not read as "not changed" or repeat the write
  const back = await scheduleDetail(session, sch, fetch).catch(() => ({}));
  if (back.schTitle !== next[0] || str(back.startDate) !== next[1] || str(back.endDate) !== next[2]) {
    throw new GroupwareError(`일정 수정 결과를 확인하지 못했습니다. ${CHECK}`);
  }
  return { sch_seq: sch, after: schView(...next), updated: true };
}

export async function deleteSchedule(session, { sch_seq, confirm = false } = {}, { fetch } = {}) {
  const detail = await scheduleDetail(session, sch_seq, fetch);
  const cal = await writeCalendar(session, fetch);
  checkSimple(detail, cal, session);
  const sch = or(detail.schSeq, sch_seq);
  const start = str(detail.startDate), end = str(detail.endDate);
  const preview = { sch_seq: sch, ...schView(or(detail.schTitle, ""), start, end) };
  if (confirm !== true) return preview;
  await writeOnce(session, "/schres/sc111A06",   // no companyInfo, like the web client
    { mcalSeq: str(cal.mcalSeq), schmSeq: str(detail.schmSeq), schSeq: str(sch), rangeCode: "", langCode: "kr" },
    "일정 삭제", { fetch });
  // deleted already: a failed check must not repeat the delete
  const rows = await calendarRows(session, start.slice(0, 8), end.slice(0, 8), [cal], false, { fetch }).catch(() => null);
  if (rows === null) throw new GroupwareError(`일정 삭제 결과를 확인하지 못했습니다. ${CHECK}`);
  if (rows.some((r) => str(r.schSeq) === str(sch))) throw new GroupwareError(`삭제 뒤에도 일정이 남아 있습니다. ${CHECK}`);
  return { ...preview, deleted: true };
}

// ---- mail
const ADDRESS = /^\s*(?:(.*?)\s*<\s*)?([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)\s*>?\s*$/;
const shown = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);
const joined = (list) => list.map((a) => (a.name ? `${a.name}<${a.email}>` : a.email)).join(",");   // the web client's form
const html = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  .replace(/\r?\n/g, "<br>");
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "a@b.com" or "이름 <a@b.com>"; anything else stops the send before the network
function addresses(list, field) {
  return (list || []).map((entry) => {
    const m = ADDRESS.exec(String(entry));
    if (!m) throw new GroupwareError(`${field}의 '${entry}'은(는) 메일 주소가 아닙니다.`);
    return { name: m[1] || "", email: m[2] };
  });
}

// the compose page's setup call: the sender, and the per-compose keys the send carries back
async function composeSetup(session, fetch) {
  const init = (await request(session, "/mail/mail014A01", { mailKind: "plain", mailTo: "", uid: "", mbox: "",
    viewFlag: "noRead", fromFlag: false, readType: "", domainSeq: "" }, { fetch })) || {};
  const senders = Array.isArray(init.mail_from) ? init.mail_from : [];
  if (!init.email || !senders.length) throw new GroupwareError("이 계정에는 메일을 보낼 주소가 없습니다.");
  if (num(init.useLimit) === 1 || [1, 3].includes(num(init.recvSendRestiction))
    || (num(init.mailboxPercent) > 100 && ["1", "3"].includes(str(init.capacityLimit)))) {
    throw new GroupwareError("이 계정은 메일 발송이 제한되어 있습니다. 그룹웨어 관리자에게 문의해 주세요.");
  }
  // the web client's choice of sender: the default one if it is still a sender, else the first
  const user = isDict(init.userInfo) ? init.userInfo : {};
  const pick = user.defaultuser === "defaultLoginEmail" ? init.email : user.defaultuser;
  const from = senders.includes(pick) ? pick : senders[0];
  const names = Array.isArray(init.userFromNameList) ? init.userFromNameList : [];
  // a representative or shared address goes out under its own name
  const ownName = ![init.representInfo, init.sharedList].some((l) => Array.isArray(l) && l.includes(from));
  const fromName = ownName ? (names.find((n) => n.isDefault === true) ?? names[0])?.userName ?? "" : "";
  return { init, user, from, fromName };
}

export async function sendMail(session, { to, cc = null, bcc = null, subject, body = "", confirm = false } = {},
  { fetch, now = () => new Date() } = {}) {
  const toList = addresses(to, "to");
  if (!toList.length) throw new GroupwareError("받는 사람(to)을 한 명 이상 넣어 주세요.");
  // like the web client: an address already in to, or in cc, is not sent again in cc or bcc
  const seen = new Set(toList.map((a) => a.email.toLowerCase()));
  const fresh = (list, field) => addresses(list, field).filter((a) => !seen.has(a.email.toLowerCase())
    && seen.add(a.email.toLowerCase()));
  const ccList = fresh(cc, "cc"), bccList = fresh(bcc, "bcc");
  subject = String(subject ?? "").trim();
  if (!subject) throw new GroupwareError("제목(subject)을 넣어 주세요.");
  const { init, user, from, fromName } = await composeSetup(session, fetch);
  const preview = { from: fromName ? `${fromName} <${from}>` : from, to: toList.map(shown), cc: ccList.map(shown),
    bcc: bccList.map(shown), subject, body };
  if (confirm !== true) return preview;

  const today = now(), days = num(init.bigFileDay) || 30, until = new Date(today);
  until.setDate(until.getDate() + days);
  const group = isDict(init.groupMailOption) ? init.groupMailOption : {};
  const form = new FormData();
  // every field the web client's compose form sends for a plain mail without attachments, in its order
  for (const [k, v] of [
    ["from", from], ["fromName", fromName], ["to", joined(toList)], ["cc", joined(ccList)], ["bcc", joined(bccList)],
    ["htmlContents", html(body)], ["email", init.email], ["fileDir", init.filedir ?? ""], ["bigFile", ""],
    ["bigFileDay", String(days)], ["bigFileCnt", "0"], ["bigFilePeriod", `${ymd(today)} ~ ${ymd(until)}`],
    ["mail_kind", "plain"], ["uidAuthList", ""], ["fwFile", ""], ["urlList", ""], ["fileNameList", ""],
    ["receipt_notific", user.receiveconfirm === "0" ? "1" : ""],   // the user's "always ask for a receipt"
    ["securitymailuse", ""], ["securitymailpass_enc_web", ""], ["immediately", "false"], ["toBeDeleted", "false"],
    ["expirationDate", `${ymd(today)} 00:00`], ["importantmailuse", ""],
    ["eachTrans", str(user.eachtrans) === "0" ? "1" : ""],   // and "send to each recipient separately"
    ["neobizaddr", group.groupMailAddr ?? ""], ["neobizIntedAddr", group.groupMailIntedAddr ?? ""],
    ["neobizOrg", group.groupMailOrg ?? ""], ["muid", "0"], ["domainSeq", ""], ["mimeHeader", ""],
    ["sessionKey", init.sessionKey ?? ""], ["externalSendLimit", init.externalSendLimit ?? "N"],
    ["insideDomainArray", JSON.stringify(init["insideDomainArray[]"] ?? [])], ["aiResultJSON", ""],
    ["subject", subject], ["authToken", `${session.user.email}|${session.token}`],
  ]) form.append(k, String(v));
  const reply = await writeOnce(session, "/mail/mail014A04", form, "메일 발송", { fetch, full: true });
  const code = str(reply.resultCode);
  if (code === "1") return { ...preview, sent: true, left_out: String(reply.resultMsg ?? "") };   // external-domain limit
  if (code !== "0") throw new GroupwareError(`메일 발송 결과를 확인하지 못했습니다(${or(reply.resultMsg, code)}). 보낸메일함을 ${CHECK}`);
  return { ...preview, sent: true };
}

// muids as the API joins them: digits only, so a comma or anything else cannot widen the list
function muidList(muids) {
  const list = [...new Set((muids || []).map((m) => String(m).trim()))];
  if (!list.length || list.length > 50) throw new GroupwareError("muids는 1~50개여야 합니다.");
  if (!list.every((m) => /^\d+$/.test(m))) throw new GroupwareError("muids는 mail_list의 muid 숫자여야 합니다.");
  return list;
}

// the folder as the groupware names it; a wrong one would answer success and change nothing
async function folder(session, box, fetch) {
  const names = (await fetchMailFolders(session, {}, { fetch })).map((f) => f.name);
  const name = names.find((n) => n.toLowerCase() === String(box).trim().toLowerCase());
  if (!name) throw new GroupwareError(`메일함 '${box}'이(가) 없습니다. mail_list 결과의 box 값을 넣어 주세요(${names.join(", ")}).`);
  return name;
}

// the web client deletes these for good, or cancels a scheduled send, instead of moving them to the trash
const FOR_GOOD = new Set(["TRASH", "SPAM", "RESERVATION"]);

export async function deleteMail(session, { muids, box = "INBOX", confirm = false } = {}, { fetch } = {}) {
  const uids = muidList(muids);
  if (FOR_GOOD.has(String(box).trim().toUpperCase())) {
    throw new GroupwareError(`${box}의 메일은 지우면 복구할 수 없어 여기서는 지우지 않습니다. 그룹웨어에서 지워 주세요.`);
  }
  const name = await folder(session, box, fetch);
  const preview = { box: name, muids: uids };
  if (confirm !== true) return preview;
  await writeOnce(session, "/mail/mail002A05", { uids: uids.join(","), mailKey: "", boxName: name }, "메일 삭제", { fetch });
  return { ...preview, trashed: true };
}

export async function markMail(session, { muids, box = "INBOX", read = false } = {}, { fetch } = {}) {
  const uids = muidList(muids), name = await folder(session, box, fetch);
  await writeOnce(session, "/mail/mail002A15", { mbox: name, uids: uids.join(","), type: read === true ? "seen" : "unseen" },
    "읽음 표시", { fetch });
  return { box: name, muids: uids, unread: read !== true };
}
