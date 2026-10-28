// Resource, schedule, mail and leave writes: a preview unless args.confirm is exactly true, write calls that
// are never retried, a read-back, and a result it cannot confirm says to check the groupware instead
// of inviting another try.
import { randomUUID } from "node:crypto";

import { GroupwareError, SessionError, request } from "./client.js";
import { calendarRows, calendars, companyInfo, erp, fetchLeaveBalance, fetchMailFolders, fetchResources, fmtDate,
  fmtStamp, leaveRows, leaveStatus, num, parseLocal, resolveAttendees, scheduleRows, toApiDay, toApiDt,
  ymdOf } from "./read.js";

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
async function writeOnce(session, path, body, what, opts = {}) {
  try {
    return await request(session, path, body, opts);
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

// ---- leave
// 연차 and its half and quarter days (linkAtCd 1010: one form, one balance). A request is saved, linked to an
// e-approval document and submitted in one approved call, as the web client does it (captured 2026-10-28); a
// cancel withdraws and deletes a document no one has acted on yet. No edit: the groupware has none either.
const LEAVE = "1010";
const LEAVE_FORM = "HP_HPD0110_";   // the attendance forms' kind; a delete touches no other document
const INTERLOCK = "/human/attendapplication/interlock";
const fmtTm = (t) => `${t.slice(0, 2)}:${t.slice(2, 4)}`;
const hm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
const pad2 = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const sameApp = (r, appDt, appSq) => str(r.appDt) === str(appDt) && str(r.appSq) === str(appSq);   // appSq alone may repeat
const stretch = (x) => (x.startDt === x.endDt ? fmtDate(x.startDt) : `${fmtDate(x.startDt)}~${fmtDate(x.endDt)}`);
// validateNew's refusals come as result codes (live 2026-10-28), 22028 without a message
const REFUSED = { 22028: "그 기간에 이미 신청한 근태가 있습니다.",
  22023: "남은 연차가 부족하거나 마이너스 연차를 쓸 수 없습니다." };

async function leaveForm(session, formDTp, fetch) {
  const u = session.user;
  const rows = await request(session, "/eap/eap096A45", { header: { groupSeq: u.groupSeq, empSeq: u.empSeq },
    body: { companyInfo: { compSeq: u.compSeq, bizSeq: u.compSeq, deptSeq: u.deptSeq }, formDTp, langCode: "kr" } },
  { fetch });
  const forms = (Array.isArray(rows) ? rows : []).filter((f) => f.formDTp === formDTp);
  if (forms.length !== 1) throw new GroupwareError(`결재 양식(${formDTp})을 찾지 못했습니다. ${CHECK}`);
  return forms[0];
}

// Everything the request needs, read only: the code, the work-day window, the days it takes, the server's
// own checks, the title and the form
async function planLeave(session, { kind, start, end, reason, start_time }, { fetch, now }) {
  const [coCd, empCd] = erp(session);
  const first = toApiDay(start), last = end ? toApiDay(end) : first;
  if (first > last) throw new GroupwareError(`시작일(${fmtDate(first)})이 종료일(${fmtDate(last)})보다 늦습니다.`);
  const base = await request(session, "/human/common/attendapplication/getApplicationBaseInfo", {}, { fetch });
  const codes = (base?.attendCodeList || []).filter((c) => c.linkAtCd === LEAVE && c.useYn !== "N" && c.outProcessId);
  const code = codes.find((c) => c.atNm === String(kind ?? "").trim());
  if (!code) throw new GroupwareError(`kind는 ${codes.map((c) => c.atNm).join("·")} 중 하나로 넣어 주세요.`);
  const window = await request(session, "/human/common/attendapplication/getStartTmEndTmByWorkType",
    { empCd, startDate: first, endDate: first, atCd: code.atCd, linkAtCd: LEAVE }, { fetch });
  let startTm = str(window?.startTm), endTm = str(window?.endTm);
  if (code.timeSetFg === "NA") {   // 반반차: the web form leaves its two hours to the person
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(start_time ?? "").trim());
    const at = m && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    if (!(at + 120 <= 24 * 60)) throw new GroupwareError(`${code.atNm}은 시작 시각(start_time, 'HH:MM')을 넣어 주세요. 2시간으로 신청합니다.`);
    startTm = hm(at); endTm = hm(at + 120);
  }
  if (!/^\d{4}$/.test(startTm) || !/^\d{4}$/.test(endTm)) throw new GroupwareError(`근무 시각을 받지 못했습니다. ${CHECK}`);
  const calc = await request(session, "/human/common/attendapplication/calculateApplicationDays", { startDate: first,
    endDate: last, startTime: startTm, endTime: endTm, atCd: code.atCd, linkAtCd: LEAVE, empCd, appRmkDc: reason,
    calculateOption: "HOLIDAY_EXCLUSION" }, { fetch });
  const spans = calc?.holidayExclusionApplicationList || [];
  if (!spans.length) throw new GroupwareError("그 기간에는 근무일이 없습니다.");
  // ponytail: one stretch of work days per request; the approval body repeats its table row per stretch, never tried
  if (spans.length > 1) throw new GroupwareError(`주말·휴일로 나뉘는 기간입니다. ${spans.map(stretch).join(", ")}로 나눠 따로 신청해 주세요.`);
  const employee = { empCd, korNm: base.employee?.korNm || "", deptCd: base.employee?.deptCd || "", deptNm: calc.deptNm || "",
    divNm: "" };   // the employee record also holds a birth date and a resident number: only these leave it
  // the fields of the web form's item the check reads (live 2026-10-28: duplicate and short balance still caught)
  const check = await request(session, "/human/attendapplication/validateNew", { checkRange: "ALL", checkPoint: "ADD",
    empCdList: [empCd], alreadyAddedItems: [], newItem: { coCd, empCd, atCd: code.atCd, linkAtCd: LEAVE,
      timeSetFg: code.timeSetFg, atDt: ymdOf(now()), startDt: first, endDt: last, startTm, endTm,
      appDy: num(calc.applicationDaysCnt), appDyFg: "D", appTm: num(calc.applicationMinutes), dailyAppTm: num(calc.dailyAppTm),
      ycUseCnt: num(calc.ycUseCnt), dailyCalculatedTimeYcUseCnt: num(calc.dailyCalculatedTimeYcUseCnt), appRmkDc: reason,
      datePeriod: { from: first, to: last }, repeatTp: "NONE", repeatFgList: [], employeeList: [employee],
      workTp: window?.workTp ?? null, holidayYn: "N" } }, { fetch, full: true });
  if (str(check.resultCode) !== "0") {
    throw new GroupwareError(REFUSED[check.resultCode] ?? `신청할 수 없습니다(${or(check.resultMsg, check.resultCode)}).`);
  }
  const blocked = Object.entries(isDict(check.resultData) ? check.resultData : {}).filter(([, v]) => py(v)).map(([k]) => k);
  if (blocked.length) throw new GroupwareError(`신청할 수 없습니다(${blocked.join(", ")}).`);
  const items = spans.map((x) => ({ ...x, coCd, empCd, deptCd: employee.deptCd, deptNm: employee.deptNm,
    empNm: calc.empNm || employee.korNm, appRmkDc: reason }));
  const title = await request(session, "/human/attendapplication/0hr00011", { applicationList: items, employeeList: [employee] },
    { fetch });
  if (typeof title !== "string" || !title) throw new GroupwareError(`신청서 제목을 받지 못했습니다. ${CHECK}`);
  const form = await leaveForm(session, code.outProcessId, fetch);
  const days = num(calc.ycUseCnt), { remaining } = await fetchLeaveBalance(session, {}, { fetch, now });
  return { code, employee, items, title, form, first, last, preview: { kind: code.atNm, start: fmtDate(first),
    end: fmtDate(last), time: `${fmtTm(startTm)}~${fmtTm(endTm)}`, days, remaining_after: remaining - days, title, reason,
    approval: "그룹웨어 기본 결재선으로 상신하며, 결재자에게 알림이 갑니다." } };
}

// The web editor swaps each <input mapping_key> of the form for its bound value and wraps head and body
export function fillBody(mainhtml, bindText) {
  const bind = JSON.parse(bindText), values = { ...bind.ITEMS };
  const walk = (groups) => (groups || []).forEach((g) => { Object.assign(values, g.items); walk(g.group); });
  walk(bind.TABLE?.dbTable1?.group);   // the employee row, then the application rows nested in it
  const body = String(mainhtml).replace(/<input\b[^>]*\bmapping_key="([^"]+)"[^>]*>/g, (_, k) => {
    if (!Object.hasOwn(values, k)) throw new GroupwareError(`결재 본문 항목(${k})의 값을 받지 못했습니다.`);
    return html(values[k] ?? "");
  });
  return body.replace(/^(<meta charset="utf-8">\s*<style>[^<]*<\/style>)/, "<head>$1\n</head><body>") + "</body>";
}

// Link the saved application to a new e-approval document and load its draft. Nothing here makes a
// document yet, so a failure leaves only the application.
async function linkDraft(session, { code, form, title }, { coCd, appDt, appSq }, fetch) {
  const approKey = `ERP_${randomUUID()}`;
  const linkKey = (await request(session, "/system/apiUtilEap/GetLinkKey", { menuCode: "HPD0110", approKey, vPCoCd: coCd, coCd },
    { fetch }))?.linkKey;
  if (!linkKey) throw new GroupwareError("결재 연결 키를 받지 못했습니다.");
  await request(session, "/system/apiUtilEap/SetEnageGroup", { approKey, formDTp: code.outProcessId, formId: form.formId,
    linkKey, formNm: form.formNm, docTitle: title, contents: "", contentsApi: `${INTERLOCK}/getInterlockFormContents`,
    statusApi: `${INTERLOCK}/setInterlockSync`, dummy1: "", link: "", vPCoCd: coCd, coCd }, { fetch });
  if (num(await request(session, "/human/openapi/attendapplication/saveLinkKey", { linkKey, appSq, coCd, appDt }, { fetch })) !== 1) {
    throw new GroupwareError("근태신청과 결재 문서를 잇지 못했습니다.");
  }
  const draft = await request(session, "/eap/eap110A03", { docID: 0, formID: form.formId, approkey: approKey, draftTp: "",
    reDraft: "", docType: "", doc_auth: 0, pageCode: "UBAP001", appLineId: "" }, { fetch });
  const rm = draft?.resultMap || {}, line = rm.hidAppDocLine, bind = rm.outProcessForm?.outBindData;
  if (!Array.isArray(line) || !line.length || typeof bind !== "string" || !rm.docnumtype?.[0]?.cd_val || !draft.mainhtml) {
    throw new GroupwareError("결재 문서 초안을 받지 못했습니다.");
  }
  if (str(rm.getFormData?.[0]?.form_id) !== str(form.formId)) throw new GroupwareError("결재 초안의 양식이 다릅니다.");
  return { approKey, draft, line, refer: Array.isArray(rm.hidRefer) ? rm.hidRefer : [], bind,
    numbering: rm.docnumtype[0].cd_val, body: fillBody(draft.mainhtml, bind) };
}

// eap110A06 as the web editor sends a new leave document (its defaults: normal level, not secret)
function submitPayload(session, { form, title }, { approKey, draft, line, refer, bind, numbering, body }, now) {
  const u = session.user, info = draft.ucUserInfo || {};
  const doc = { inservice_time: "0", doc_level: "001", doc_security: "0", emergency_level: "1" };
  const all = (keys) => Object.fromEntries(keys.map((k) => [k, "Y"]));
  return { pageCode: "UBAP001", paramItem: { bindData: JSON.stringify(bind), interDivId: "divInterJson", interDocTp: "json",
    doc_id: 0, form_id: form.formId, numbering_id: numbering, rep_dt: stamp(now()), repdt_mod_yn: "0",
    co_id: u.compSeq, dept_id: u.deptSeq, biz_id: info.bizSeq || u.compSeq, user_id: u.empSeq,
    co_nm: info.compName || "", dept_nm: info.deptName || "", user_nm: info.empName || "",
    doc_title: title, doc_sts: "20", ...doc, use_yn: "1", approkey: approKey, contents_tp: "10",
    doc_contents: encodeURIComponent(body), pTEAG_APPDOC_LINE: line, pVKD_TKDDITEM: [], pVCM_ATTACHFILEINFO: [],
    pRefer: refer, pReceive: [], pOper: [], pTEAG_APPDOC_REF: [], pDraftTp: "", seal_use_yn: "", receipient: "", receipt: "",
    iframeHtml: "", re_draft: "", modifyAppLineYn: "Y", ...all(["modifyReceive10", "modifyReceive20", "modifyReceive30",
      "modifyReceive40", "modifyTitle", "modifyContent", "modifyRef", "modifyAttach", "modifyAddItem", "modifyInservice",
      "modifyDoclevel", "modifyEmergency", "modifySeal", "modifyEabox"]),
    modifyFileList: "", delFileSnList: [], auditorYn: "0",
    modifyDocInfo: { docId: 0, appdoc: { ...doc, doc_title: title },
      appdocReceiveList: refer.map((r) => ({ receive_div: "10", org_div: r.org_div || r.div, org_id: r.org_id })),
      appdocLineList: line.map((l) => ({ doc_line_m_seq: l.doc_line_m_seq, doc_line_s_seq: l.doc_line_s_seq, act_id: l.act_id,
        co_id: l.co_id, dept_id: l.dept_id, user_id: l.user_id, doc_line_gb: l.doc_line_gb })),
      appdocFileList: [], appdocRefList: [] },
    modifyItemList: null, isLatestVerContentsFile: true, versionCheck: null, formLang: "kr", aiVerifyHistories: [],
    aiVerifyAutoOnSubmit: false, aiVerifyUseYn: "0", oneAiAgreeYn: info.oneAiAgreeYn || "Y" } };
}

// A saved application that has no document yet (상신대기): the employee screens have no delete for it, this
// is the overtime form's discard
async function discardLeave(session, { coCd, appDt, appSq }, fetch) {
  await writeOnce(session, "/human/attendapplication/deleteSubmittedApplicationList", [{ coCd, appDt, appSq }], "근태신청 삭제",
    { fetch });
}

export async function requestLeave(session, { kind, start, end = null, reason = "", start_time = null, confirm = false } = {},
  { fetch, now = () => new Date() } = {}) {
  const plan = await planLeave(session, { kind, start, end, reason, start_time }, { fetch, now });
  if (confirm !== true) return plan.preview;
  const [coCd, empCd] = erp(session);
  const saved = await writeOnce(session, "/human/attendapplication/create", { coCd: "", appDt: "", appEmpCd: empCd,
    deptCd: "", titleDc: plan.title, approLineId: "", calLinkKey: "", linkKey: "", approState: "", fileGroup: 0,
    employeeList: [plan.employee], version: "v2", overtimeVersion: "v2", applicationList: plan.items }, "근태신청 저장", { fetch });
  if (!saved?.appSq || !/^\d{8}$/.test(str(saved.appDt))) throw new GroupwareError(`근태신청 저장 결과를 확인하지 못했습니다. ${CHECK}`);
  const app = { coCd: saved.coCd || coCd, appDt: str(saved.appDt), appSq: saved.appSq };
  const id = `${app.appDt}-${app.appSq}`, ref = `근태신청(id ${id})`;
  // from here a re-login must not run the tool again: that would save a second application
  let draft;
  try {
    draft = await linkDraft(session, plan, app, fetch);
  } catch (e) {
    const why = e instanceof SessionError ? "세션 끊김" : e?.message || String(e?.name);   // transport text is header-free
    const gone = !(e instanceof SessionError) && await discardLeave(session, app, fetch).then(() => true, () => false);
    throw new GroupwareError(gone ? `결재 문서를 만들지 못해(${why}) 저장한 근태신청을 지웠습니다.`
      : `${ref}은 저장됐지만 결재 문서를 만들지 못했습니다(${why}). 상신대기로 남았으니 leave_cancel로 지워 주세요.`);
  }
  // never retried: refused, or unclear, the application may sit at 상신대기 or the document may be out
  const unsent = (why) => new GroupwareError(`${ref}은 저장됐지만 상신 결과를 확인하지 못했습니다(${why}). leave_requests에서 `
    + "상태를 확인해, 결재진행이 아니면 leave_cancel로 지워 주세요.");
  let sent;
  try {
    sent = await request(session, "/eap/eap110A06", submitPayload(session, plan, draft, now), { fetch });
  } catch (e) {
    throw unsent(e instanceof SessionError ? "세션 끊김" : e?.message || String(e?.name));
  }
  if (!/^\d+$/.test(str(sent?.result))) throw unsent("문서 번호 없음");
  // submitted already: a failed read-back must not repeat anything
  const row = (await leaveRows(session, plan.first, plan.last, { fetch }).catch(() => [])).find((r) => sameApp(r, app.appDt, app.appSq));
  return { ...plan.preview, submitted: true, id, doc_id: str(sent.result), status: row ? leaveStatus(row) : "",
    approval_line: draft.line.map((l) => `${l.user_nm || ""}(${l.act_nm || ""})`) };
}

// a document still with its writer: the writer's, 결재진행, and no one else on the line has acted. approval_read
// saw app_yn "0" on finished documents; an action date is what a step that acted has (live 2026-10-28)
async function checkWithdraw(session, docId, fetch) {
  const me = str(session.user.empSeq);
  const st = await request(session, "/eap/eap110A98", { docId, pageCode: "UBAP002" }, { fetch });
  if (str(st?.user_id) !== me) throw new GroupwareError("본인이 상신한 문서만 회수할 수 있습니다.");
  if (str(st?.doc_sts) !== "30") throw new GroupwareError(`결재 진행 중인 문서가 아닙니다(상태 ${str(st?.doc_sts)}). ${CHECK}`);
  const data = await request(session, "/eap/eap096A62", { docId }, { fetch });
  const line = data?.lineList || data?.lineInfo;
  if (!Array.isArray(line) || !line.length) throw new GroupwareError(`결재선을 받지 못했습니다. ${CHECK}`);
  // the writer's own step carries the submit time; without it the dates cannot be read, so no withdraw
  if (!line.some((l) => str(l.empSeq) === me && l.appDt)) throw new GroupwareError(`결재선의 처리 기록을 읽지 못해 회수하지 않습니다. ${CHECK}`);
  const acted = line.filter((l) => str(l.empSeq) !== me && l.appDt);
  if (acted.length) throw new GroupwareError(`${acted.map((l) => l.userNm).join(", ")} 님이 이미 처리해 회수할 수 없습니다. ${CHECK}`);
}

// the delete takes any document id, linked HR data with it, for good: only the writer's own 임시보관 leave document
async function checkDelete(session, docId, fetch) {
  const data = await request(session, "/eap/eap107A28",
    { docIdList: docId, pageCode: "UBA1020", upperMenuNo: "1000300", menuNo: "1000500" }, { fetch });
  const list = Array.isArray(data?.list) ? data.list : [], d = list[0] || {};
  if (list.length !== 1 || str(d.DOC_ID) !== docId) throw new GroupwareError(`결재 문서(${docId})를 찾지 못했습니다. ${CHECK}`);
  if (!str(d.FORM_D_TP).startsWith(LEAVE_FORM) || str(d.USER_ID) !== str(session.user.empSeq) || str(d.DOC_STS) !== "10") {
    throw new GroupwareError(`본인의 임시보관 근태 문서만 삭제할 수 있습니다. ${CHECK}`);
  }
}

// a GET answered as server-sent events; the reply also carries session token parts, so only failCnt is read
async function deleteDoc(session, docId, fetch) {
  const out = await writeOnce(session, `/eap/sse/eap107A25?docIdList=${docId}`, null, "결재 문서 삭제", { fetch, get: true });
  if (num(out?.failCnt) > 0) throw new GroupwareError(`결재 문서를 삭제하지 못했습니다. ${CHECK}`);
}

const CANCEL = { 0: "결재 전 문서를 회수한 뒤 삭제합니다.", 5: "임시보관 문서를 삭제합니다.", 2: "결재 문서 없이 저장만 된 신청을 지웁니다." };

export async function cancelLeave(session, { id, confirm = false } = {}, { fetch } = {}) {
  const [coCd, empCd] = erp(session);
  const m = /^(\d{8})-(\d+)$/.exec(String(id ?? "").trim());
  if (!m) throw new GroupwareError("id에는 leave_requests의 id('YYYYMMDD-번호')를 넣어 주세요.");
  const [, appDt, appSq] = m;
  const info = await request(session, "/human/hrd0220/selectAttendApplicationInfo", { appDt, appSq: Number(appSq) }, { fetch });
  const master = info?.attendApplicationMaster || {};
  const days = (info?.attendApplicationDetailList || []).map((d) => str(d.atDt)).filter((d) => /^\d{8}$/.test(d)).sort();
  if (str(master.appSq) !== appSq || !days.length) throw new GroupwareError(`근태신청(id ${id})을 찾을 수 없습니다.`);
  if (str(master.appEmpCd) !== str(empCd)) throw new GroupwareError("본인이 신청한 근태만 취소할 수 있습니다.");
  const first = days[0], last = days[days.length - 1];
  const row = (await leaveRows(session, first, last, { fetch })).find((r) => sameApp(r, appDt, appSq));
  if (!row) throw new GroupwareError(`근태신청(id ${id})을 찾을 수 없습니다.`);
  if (row.linkAtCd !== LEAVE) throw new GroupwareError("연차·반차·반반차 신청만 취소할 수 있습니다.");
  // a cancel form in flight, or the leave it cancels: never tried here
  if (str(row.reportCancYn) === "Y" || String(row.cancellationApplication) === "true") {
    throw new GroupwareError(`결재취소가 걸린 신청은 그룹웨어에서 처리해 주세요. ${CHECK}`);
  }
  const state = str(row.approState), docId = str(row.idDoc), status = leaveStatus(row);
  if (state === "1") throw new GroupwareError("결재가 끝난 신청은 그룹웨어 근태신청에서 결재취소(취소 신청서 상신)로 취소해 주세요.");
  if (!Object.hasOwn(CANCEL, state)) throw new GroupwareError(`${status} 상태의 신청은 취소할 수 없습니다. ${CHECK}`);
  if (state !== "2" && !/^\d+$/.test(docId)) throw new GroupwareError(`결재 문서 번호를 받지 못했습니다. ${CHECK}`);
  if (state === "0") await checkWithdraw(session, docId, fetch);
  if (state === "5") await checkDelete(session, docId, fetch);
  const preview = { id, kind: row.atItemNm || row.atCdNm || row.atNm || "", start: fmtDate(first), end: fmtDate(last),
    title: master.titleDc || "", status, action: `${CANCEL[state]} 되돌릴 수 없습니다.` };
  if (confirm !== true) return preview;
  if (state === "2") {
    await discardLeave(session, { coCd, appDt, appSq: Number(appSq) }, fetch);   // as the save's discard sends it (live)
  } else if (state === "5") {
    await deleteDoc(session, docId, fetch);
  } else {
    const back = await writeOnce(session, "/eap/eap110A20", { docID: docId, pageCode: "UBAP002" }, "결재 문서 회수", { fetch });
    if (num(back?.returnValue) !== 1) throw new GroupwareError(`회수 결과를 확인하지 못했습니다. ${CHECK}`);
    // withdrawn: from here a re-login must not run the tool again, and the person must hear where the document is
    try {
      await checkDelete(session, docId, fetch);   // now 임시보관, or stop before the delete
      await deleteDoc(session, docId, fetch);
    } catch (e) {
      const why = e instanceof SessionError ? "세션 끊김" : e?.message || String(e?.name);
      throw new GroupwareError(`결재 문서를 회수해 임시보관으로 옮겼지만 삭제하지 못했습니다(${why}). leave_cancel을 다시 부르면 삭제합니다.`);
    }
  }
  // done already: a failed check must not repeat it
  const rows = await leaveRows(session, first, last, { fetch }).catch(() => null);
  if (rows === null) throw new GroupwareError(`취소 결과를 확인하지 못했습니다. ${CHECK}`);
  if (rows.some((r) => sameApp(r, appDt, appSq) && str(r.approState) !== "-3")) {
    throw new GroupwareError(`취소한 뒤에도 신청이 남아 있습니다. ${CHECK}`);
  }
  return { ...preview, canceled: true };
}
