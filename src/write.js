// Resource, schedule, mail and leave writes: a preview unless args.confirm is exactly true, write calls that
// are never retried, a read-back, and a result it cannot confirm says to check the groupware instead
// of inviting another try.
import { randomUUID } from "node:crypto";

import { GroupwareError, SessionError, request } from "./client.js";
import { calendarRows, calendars, companyInfo, erp, fetchLeaveBalance, fetchMailFolders, fetchResources, fmtDate,
  fmtStamp, leaveRows, leaveStatus, num, parseLocal, resolveAttendees, scheduleRows, toApiDay, toApiDt,
  ymdOf } from "./read.js";

const CHECK = "그룹웨어에서 확인해 주세요.";
const LIMITED = "자원 이용 제한 설정에 따라 그 시간에는 예약할 수 없습니다.";
const unsure = (what, where = "") => new GroupwareError(`${what} 결과를 확인하지 못했습니다${where}. ${CHECK}`);
const filled = (v) => (v && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v));   // [] and {} are empty
const label = (p) => `${p.empName} (${p.deptName})`;
const org = (p, groupSeq = p.groupSeq) => ({ groupSeq: groupSeq ?? null, compSeq: p.compSeq ?? null,
  deptSeq: p.deptSeq ?? null, empSeq: p.empSeq ?? null });
// the flag may arrive as 1, "1" or true; 0, "0", false and a missing flag are not a success
const succeeded = (result) => ["1", "true"].includes(String(result?.successTf).toLowerCase());
const whyOf = (e) => (e instanceof SessionError ? "세션 끊김" : e?.message || String(e?.name));   // transport text is header-free
// the groupware's own popup pages, as its web client opens them (windowOpen; both opened live 2026-10-29)
const popup = (session, params) => `${session.base}/#/popup?${new URLSearchParams(params)}`;
const bookingLink = (session, r) => popup(session, { MicroModuleCode: "schres", callComp: "UKAP002", seqNum: r.seqNum,
  resSeq: r.resSeq });

// One write call. A SessionError means the gateway refused it before it ran, so the caller's one
// re-login sends the first write, not a second; anything else unclear may have landed and must
// say so. No cause is kept: transport text can carry header values.
async function writeOnce(session, path, body, what, opts) {
  try {
    return await request(session, path, body, opts);
  } catch (e) {
    if (e instanceof SessionError) throw e;
    throw e instanceof GroupwareError ? new GroupwareError(`${e.message} ${CHECK}`) : unsure(what);
  }
}

// ---- resources
export async function reserveResource(session, { res_seq, start, end, title, description = "", attendees = null,
  confirm = false } = {}, { fetch, now = () => new Date() } = {}) {
  const startDt = parseLocal(start), endDt = parseLocal(end);
  if (endDt <= startDt) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  if (startDt < now()) throw new GroupwareError("시작 시각이 이미 지났습니다.");
  const res = (await fetchResources(session, {}, { fetch })).find((r) => String(r.res_seq) === String(res_seq));
  if (!res) throw new GroupwareError(`자원 ${res_seq}을(를) 찾을 수 없습니다.`);
  const people = await resolveAttendees(session, attendees, { fetch });   // every name settles before the check and the write
  const apiStart = toApiDt(start), apiEnd = toApiDt(end), resSeq = res.res_seq;   // the API's own id, not the caller's spelling
  const check = await request(session, "/schres/rs121A04", { companyInfo: companyInfo(session), resSeq, startDate: apiStart,
    endDate: apiEnd, alldayYn: "N", resStartDate: apiStart.slice(0, 8) }, { fetch });
  // fail closed: a missing or renamed field must not unlock the write. limitYn is the resource's usage limit (the
  // web form stops on it too), which the write would only refuse
  if (check?.limitYn !== "N") throw new GroupwareError(LIMITED);
  const available = check?.reservationYn === "N";
  const preview = { resource: res.name, start, end, available, approval_required: res.approval_required,
    attendees: people.map(label) };
  if (!available) preview.conflicts = await holders(session, resSeq, start, end, fetch);
  if (confirm !== true) return preview;
  if (!available) throw new GroupwareError(`그 시간대에는 이미 예약이 있습니다${held(preview.conflicts)}.`);
  const me = org(session.user);
  const result = await writeOnce(session, "/schres/rs121A06", { companyInfo: companyInfo(session), langCode: "kr", resSeq,
    reqText: title, apprYn: res.approval_required ? "Y" : "N", alldayYn: "N", startDate: apiStart, endDate: apiEnd,
    descText: description,
    // the booker first, then each attendee; these four org keys are all the API needs
    resSubscriberList: [me,...people.filter((p) => String(p.empSeq) !== String(me.empSeq)).map((p) => org(p, me.groupSeq))],
    uidList: "", repeatType: "10", repeatEndDay: "" }, "예약", { fetch });
  if (!succeeded(result)) throw unsure("예약");
  // booked already: a failed read-back only drops the link
  const [row] = await myBookings(session, resSeq, start, end, fetch).then((rows) => rows.filter((r) => r.reqText === title),
    () => []);
  return { ...preview, reserved: true, link: row ? bookingLink(session, row) : null };
}

// who holds res_seq within start–end, from the days' lists (the duplicate checks name no one); a cancelled or
// rejected booking holds nothing, and an unreadable list only leaves the names out
async function holders(session, res_seq, start, end, fetch, skip = null) {
  const from = toApiDt(start), to = toApiDt(end);
  const rows = await scheduleRows(session, start.slice(0, 10), end.slice(0, 10), [String(res_seq)], fetch).catch(() => []);
  return rows.filter((r) => String(r.resStartDate) < to && String(r.resEndDate) > from && String(r.seqNum) !== String(skip)
    && !["CA", "CR", "AC", "RJ"].includes(r.statusCode))
    .map((r) => ({ booker: r.empName || "", start: fmtStamp(r.resStartDate), end: fmtStamp(r.resEndDate) }))
    .sort((a, b) => a.start.localeCompare(b.start));
}
const held = (list) => (list.length ? `(${list.map((h) => `${h.booker} ${h.start}~${h.end}`).join(", ")})` : "");

// my bookings of res_seq at exactly start–end, from that day's list
async function myBookings(session, res_seq, start, end, fetch) {
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);   // bad times fail before any request
  const day = String(start).slice(0, 10), me = String(session.user.empSeq);
  return (await scheduleRows(session, day, day, [String(res_seq)], fetch)).filter((r) =>
    String(r.resStartDate) === apiStart && String(r.resEndDate) === apiEnd && String(r.empSeq) === me);
}

function onlyOne(found, what) {
  if (!found.length) throw new GroupwareError(`그 시간에 ${what} 본인 예약을 찾지 못했습니다.`);
  if (found.length > 1) throw new GroupwareError("같은 시간에 본인 예약이 여러 건이라 하나로 정하지 못했습니다.");
  return found[0];
}

export async function cancelReservation(session, { res_seq, start, end, confirm = false } = {}, { fetch } = {}) {
  const mine = () => myBookings(session, res_seq, start, end, fetch);
  const r = onlyOne(await mine(), "취소할");
  const preview = { resource: r.resName || "", title: r.reqText || "", start, end };
  if (confirm !== true) return preview;
  const item = { resSeq: String(r.resSeq), seqNum: r.seqNum ?? null, resIdx: String(r.resIdx), reqText: r.reqText ?? null,
    startDate: toApiDt(start), endDate: toApiDt(end), createDate: String(r.createDate), schmSeq: r.schmSeq || "",
    schSeq: r.schSeq || "", resName: r.resName ?? null, alldayYn: r.alldayYn || "N" };
  const result = await writeOnce(session, "/schres/rs121A11",
    { companyInfo: companyInfo(session), statusCode: "CA", deleteRangeCode: "UO", resSeqList: [item], langCode: "kr" },
    "취소", { fetch });
  // the check runs after the cancel went out, so its own failure must not reach the caller's re-login and rerun
  if (!(succeeded(result) && await mine().then((rows) => !rows.length, () => false))) throw unsure("취소");
  return { ...preview, cancelled: true };
}

// the web client's edit form (rs121A12) for a plain one-off booking of mine; the stored fields go back as
// they are, with these set
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
  const d = await request(session, "/schres/rs121A10",
    { companyInfo: companyInfo(session), resSeq: String(r.resSeq), seqNum: r.seqNum ?? null, langCode: "kr" }, { fetch });
  if (!["resSeq", "seqNum", "resIdx", "startDate", "endDate", "createDate"].every((k) => filled(d?.[k]))) {
    throw new GroupwareError("예약 상세를 찾지 못했습니다.");   // the update would send its keys and times blank
  }
  // fail closed: only the booking just matched, mine, one-off, timed, live, with no file or linked schedule
  for (const [broken, msg] of [
    [String(d.seqNum) !== String(r.seqNum) || String(d.startDate) !== toApiDt(start) || String(d.endDate) !== toApiDt(end),
      "예약 상세가 목록과 다릅니다"],
    [String(d.empSeq) !== String(session.user.empSeq), "본인 예약이 아닙니다"],
    [String(d.repeatType) !== "10", "반복 예약입니다"],
    [d.alldayYn !== "N", "종일 예약입니다"],
    [!["RC", "RE", "CO"].includes(d.statusCode), "취소·반려된 예약입니다"],   // 예약완료, 승인요청, 승인완료
    [!["Y", "N"].includes(d.apprYn), "승인 여부를 알 수 없는 자원입니다"],
    [filled(d.schSeq) || filled(d.schmSeq), "일정과 연결된 예약입니다"],
    [filled(d.fileList) || filled(d.file), "첨부파일이 있는 예약입니다"],
    [!Array.isArray(d.subscriberList) || !d.subscriberList.length, "예약자 정보가 없습니다"]]) {
    if (broken) throw new GroupwareError(`${msg}. 이 도구로는 수정하지 않습니다.`);
  }
  const max = num(String(d.limitReservationRange ?? "").replace(/,/g, ""));   // minutes, as the web form reads it
  if (max > 0 && (parseLocal(to) - parseLocal(from)) / 60000 > max) {
    throw new GroupwareError(`이 자원은 최대 ${max / 60}시간까지만 예약할 수 있습니다.`);
  }
  const newTitle = title != null ? title.trim() : d.reqText || "";
  let available = true;
  if (apiFrom !== String(d.startDate) || apiTo !== String(d.endDate)) {
    // rs121A04 counts this booking as taken, so the overlap list (rs121A14) without it decides,
    // and rs121A04 only says whether the resource's usage limit allows the new time
    const span = { companyInfo: companyInfo(session), resSeq: d.resSeq, startDate: apiFrom, endDate: apiTo, alldayYn: "N" };
    const limit = await request(session, "/schres/rs121A04", { ...span, resStartDate: apiFrom.slice(0, 8) }, { fetch });
    if (limit?.limitYn !== "N") throw new GroupwareError(LIMITED);
    const rows = (await request(session, "/schres/rs121A14",
      { ...span, repeatType: "10", repeatEndDay: apiFrom.slice(0, 8), repeatByDay: "" }, { fetch }))?.usedResList;
    // fail closed: an unreadable answer or any other booking not cancelled or rejected is a conflict
    available = Array.isArray(rows) && !rows.some((u) => !(String(u.seqNum) === String(d.seqNum)
      && String(u.resIdx) === String(d.resIdx)) && u.limitYn !== "Y" && !["CA", "CR", "AC", "RJ"].includes(u.statusCode));
  }
  const after = { title: newTitle, start: from, end: to };
  if (description != null) after.description = description;
  const preview = { resource: d.resName || "", before: { title: d.reqText || "", start, end }, after, available,
    approval_required: d.apprYn === "Y" };
  if (!available) preview.conflicts = await holders(session, d.resSeq, from, to, fetch, d.seqNum);
  if (confirm !== true) return preview;
  if (!available) throw new GroupwareError(`그 시간대에는 이미 다른 예약이 있습니다${held(preview.conflicts)}.`);
  const result = await writeOnce(session, "/schres/rs121A12",
    { companyInfo: companyInfo(session), langCode: "kr", resSeq: d.resSeq, seqNum: d.seqNum, resIdx: d.resIdx,
      reqText: newTitle, apprYn: d.apprYn, alldayYn: "N", startDatePk: d.startDate, createDatePk: d.createDate,
      startDate: apiFrom, endDate: apiTo, descText: description ?? (d.descText || ""),
      resSubscriberList: d.subscriberList.map((p) => org(p)),
      uidList: "", repeatType: "10", repeatEndDay: "", repeatByDay: "", resName: d.resName ?? null },
    "예약 수정", { fetch });
  // the edit books anew and cancels the old one (live 2026-10-28: a new seqNum, the old one CA), so
  // the check reads the day's list. Written already: a failed check must not read as "not changed" or repeat the write
  const [row, ...more] = succeeded(result) ? await myBookings(session, d.resSeq, from, to, fetch)
    .then((rows) => rows.filter((x) => x.reqText === newTitle), () => []) : [];
  if (!row || more.length) throw unsure("예약 수정");
  return { ...preview, updated: true, link: bookingLink(session, row) };
}

// ---- schedules
async function writeCalendar(session, fetch) {
  // looked up on every write, never a constant: a personal (E) calendar this account may write
  let mine = (await calendars(session, { fetch }))
    .filter((c) => c.calType === "E" && String(c.calRwGbn).toLowerCase() === "w");
  if (mine.length > 1) {
    mine = mine.filter((c) => String(c.empSeq) === String(session.user.empSeq));
    if (mine.length !== 1) throw new GroupwareError("쓰기 가능한 개인 캘린더가 여러 개라 하나로 정하지 못했습니다.");
  }
  if (!mine.length) throw new GroupwareError("쓰기 가능한 개인 캘린더를 찾지 못했습니다.");
  return mine[0];
}

async function scheduleDetail(session, schSeq, fetch) {
  const d = await request(session, "/schres/sc111A04",
    { companyInfo: companyInfo(session), schSeq: String(schSeq), tcalSeq: "", langCode: "kr" }, { fetch });
  // without its ids and times an update would send them blank
  if (!["schSeq", "schmSeq", "startDate", "endDate"].every((k) => filled(d?.[k]))) {
    throw new GroupwareError(`일정 ${schSeq}을(를) 찾지 못했습니다.`);
  }
  return d;
}

// createSchedule: one plain, timed schedule in my own calendar
export async function createSchedule(session, { title, start, end, place = "", memo = "", attendees = null,
  confirm = false } = {}, { fetch } = {}) {
  title = title.trim();
  if (!title) throw new GroupwareError("일정 제목이 비어 있습니다.");
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);   // bad times fail before any request
  if (apiEnd <= apiStart) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  const cal = await writeCalendar(session, fetch);
  const people = await resolveAttendees(session, attendees, { fetch });   // all settle before the write
  const preview = { calendar: cal.calTitle || "", title, start, end, place, memo, attendees: people.map(label) };
  if (confirm !== true) return preview;
  const u = session.user, mcalSeq = String(cal.mcalSeq);
  const result = await writeOnce(session, "/schres/sc111A05", {
    companyInfo: companyInfo(session), langCode: "kr", schmSeq: "0", schSeq: "0", mcalSeq, schTitle: title,
    startDate: apiStart, endDate: apiEnd, alldayYn: "N", lunarYn: "N", alarm_yn: "N",
    gbnCode: cal.calType ?? null, calType: cal.calType ?? null, gbnSeq: "",
    schGbnCode: "10", repeatType: "10", repeatEndDay: "", repeatByDay: "",
    contents: memo, rangeCode: "N", schPlace: place, placeMapData: "{}",
    placeFileId: "", fileId: "", delFileList: [], uidList: "",
    resList: [], reservedList: [], schAlarmList: [], schUserList: [],
    // the creator is not invited; the search result has no groupSeq, so mine fills it
    schPartEmpList: people.filter((p) => String(p.empSeq) !== String(u.empSeq))
      .map((p) => ({ ...org(p, u.groupSeq ?? null), dutyPositionOption: "0" })),
    addressUserList: [], inviterPartType: "M", companyEmpSeq: u.empSeq ?? null,
    empSeq: u.empSeq ?? null, groupSeq: u.groupSeq ?? null, otherLinkList: [],
    schModuleGbn: null, schModuleSeq: null, myMemo: "", videoYn: "N", mailSend: "N" }, "일정 등록", { fetch });
  let sch = result?.schSeq ?? null, got = {};
  // written already: any failed check, a timeout too, must neither read as "not created" nor, as a
  // SessionError, make the caller's re-login run the write again
  try {
    if (!filled(sch)) {   // no id in the answer: the list must hold exactly the one just written
      const same = (await calendarRows(session, apiStart.slice(0, 8), apiEnd.slice(0, 8), [cal], false, { fetch }))
        .filter((r) => r.schTitle === title && String(r.startDate) === apiStart && String(r.endDate) === apiEnd);
      sch = same.length === 1 ? same[0].schSeq ?? null : null;
    }
    if (filled(sch)) got = await scheduleDetail(session, sch, fetch);
  } catch {
    // unconfirmed, below
  }
  if (got.schTitle !== title || String(got.startDate) !== apiStart || String(got.endDate) !== apiEnd
      || String(got.mcalSeq) !== mcalSeq) {
    throw unsure("일정 등록", filled(sch) ? `(sch_seq ${sch})` : "");
  }
  return { ...preview, created: true, sch_seq: sch };
}

const schView = (title, start, end) => ({ title, start: fmtStamp(start), end: fmtStamp(end) });

// fail closed: only a plain one-off schedule in my own calendar, tied to no resource, module, file or
// other person, is rewritten or deleted
function checkSimple(d, cal, session) {
  const me = String(session.user.empSeq);
  for (const [broken, msg] of [
    [String(d.mcalSeq) !== String(cal.mcalSeq), "내 개인 캘린더의 일정이 아닙니다"],
    [String(d.repeatType) !== "10", "반복 일정입니다"],
    [["resList", "resources", "reservedList"].some((k) => filled(d[k])), "자원이 연결된 일정입니다"],
    [filled(d.addressUserList), "외부 참석자가 있는 일정입니다"],
    [(d.schPartEmpList || []).some((p) => String(p.empSeq || p.orgSeq || "") !== me), "다른 참석자가 있는 일정입니다"],
    [filled(d.schModuleGbn) || filled(d.schModuleSeq), "외부 모듈과 연결된 일정입니다"],
    [filled(d.fileList) || num(d.fileCnt) > 0, "첨부파일이 있는 일정입니다"]]) {
    if (broken) throw new GroupwareError(`${msg}. 이 도구로는 수정·삭제하지 않습니다.`);
  }
}

export async function updateSchedule(session, { sch_seq, title = null, start = null, end = null, confirm = false } = {},
  { fetch } = {}) {
  if (title == null && start == null && end == null) throw new GroupwareError("바꿀 값(title, start, end)이 없습니다.");
  if (title != null && !title.trim()) throw new GroupwareError("일정 제목은 비울 수 없습니다.");
  const newStart = start != null ? toApiDt(start) : null, newEnd = end != null ? toApiDt(end) : null;   // bad times fail first
  const d = await scheduleDetail(session, sch_seq, fetch);
  const cal = await writeCalendar(session, fetch);
  checkSimple(d, cal, session);
  // the update sends alldayYn "N" and would drop it
  if (String(d.alldayYn) === "Y") throw new GroupwareError("종일 일정입니다. 이 도구로는 수정하지 않습니다.");
  const old = [d.schTitle || "", String(d.startDate), String(d.endDate)];
  const next = [title != null ? title.trim() : old[0], newStart || old[1], newEnd || old[2]];
  if (next[2] <= next[1]) throw new GroupwareError("종료 시각이 시작 시각보다 빠릅니다.");
  const sch = d.schSeq || sch_seq;
  if (confirm !== true) return { sch_seq: sch, before: schView(...old), after: schView(...next) };
  // the stored detail goes back whole, with these set
  await writeOnce(session, "/schres/sc111A05", { ...d, companyInfo: companyInfo(session), langCode: "kr",
    schSeq: String(sch), schmSeq: String(d.schmSeq), mcalSeq: String(cal.mcalSeq), schTitle: next[0],
    startDate: next[1], endDate: next[2], contents: d.contents || "", alldayYn: "N", lunarYn: d.lunarYn || "N",
    // like create: the flag follows the reminders, so a reminder set in the UI is kept
    alarm_yn: filled(d.schAlarmList) ? "Y" : "N",
    gbnCode: d.gbnCode || d.calType || cal.calType, calType: d.calType || d.gbnCode || cal.calType,
    schGbnCode: d.schGbnCode || "10", repeatType: "10", rangeCode: "UO",
    resList: [], reservedList: [], schAlarmList: d.schAlarmList || [],
    schUserList: (d.schUserList || []).filter((x) => x.userType !== "30"),
    schPartEmpList: d.schPartEmpList || [], addressUserList: d.addressUserList || [], delFileList: [],
    uidList: "", empSeq: session.user.empSeq ?? null, groupSeq: session.user.groupSeq ?? null,
    alarmOnModify: false, mailSend: "N" }, "일정 수정", { fetch });
  // written already: a failed check must not read as "not changed" or repeat the write
  const back = await scheduleDetail(session, sch, fetch).catch(() => ({}));
  if (back.schTitle !== next[0] || String(back.startDate) !== next[1] || String(back.endDate) !== next[2]) {
    throw unsure("일정 수정");
  }
  return { sch_seq: sch, after: schView(...next), updated: true };
}

export async function deleteSchedule(session, { sch_seq, confirm = false } = {}, { fetch } = {}) {
  const d = await scheduleDetail(session, sch_seq, fetch);
  const cal = await writeCalendar(session, fetch);
  checkSimple(d, cal, session);
  const sch = d.schSeq || sch_seq, start = String(d.startDate), end = String(d.endDate);
  const preview = { sch_seq: sch, ...schView(d.schTitle || "", start, end) };
  if (confirm !== true) return preview;
  await writeOnce(session, "/schres/sc111A06",   // no companyInfo, like the web client
    { mcalSeq: String(cal.mcalSeq), schmSeq: String(d.schmSeq), schSeq: String(sch), rangeCode: "", langCode: "kr" },
    "일정 삭제", { fetch });
  // deleted already: a failed check must not repeat the delete
  const rows = await calendarRows(session, start.slice(0, 8), end.slice(0, 8), [cal], false, { fetch })
    .catch(() => { throw unsure("일정 삭제"); });
  if (rows.some((r) => String(r.schSeq) === String(sch))) throw new GroupwareError(`삭제 뒤에도 일정이 남아 있습니다. ${CHECK}`);
  return { ...preview, deleted: true };
}

// ---- mail
const ADDRESS = /^\s*(?:(.*?)\s*<\s*)?([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)\s*>?\s*$/;
const shown = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);
const joined = (list) => list.map((a) => (a.name ? `${a.name}<${a.email}>` : a.email)).join(",");   // the web client's form
const html = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  .replace(/\r?\n/g, "<br>");
const ymd = (d) => fmtDate(ymdOf(d));

// "a@b.com" or "이름 <a@b.com>"; anything else stops the send before the network
function addresses(list, field) {
  return (list || []).map((entry) => {
    const m = ADDRESS.exec(String(entry));
    if (!m) throw new GroupwareError(`${field}의 '${entry}'은(는) 메일 주소가 아닙니다.`);
    return { name: m[1] || "", email: m[2] };
  });
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
  // the compose page's setup call: the sender, and the per-compose keys the send carries back
  const init = (await request(session, "/mail/mail014A01", { mailKind: "plain", mailTo: "", uid: "", mbox: "",
    viewFlag: "noRead", fromFlag: false, readType: "", domainSeq: "" }, { fetch })) || {};
  const senders = Array.isArray(init.mail_from) ? init.mail_from : [];
  if (!init.email || !senders.length) throw new GroupwareError("이 계정에는 메일을 보낼 주소가 없습니다.");
  if (num(init.useLimit) === 1 || [1, 3].includes(num(init.recvSendRestiction))
    || (num(init.mailboxPercent) > 100 && ["1", "3"].includes(String(init.capacityLimit)))) {
    throw new GroupwareError("이 계정은 메일 발송이 제한되어 있습니다. 그룹웨어 관리자에게 문의해 주세요.");
  }
  // the web client's choice of sender: the default one if it is still a sender, else the first
  const user = init.userInfo || {};
  const pick = user.defaultuser === "defaultLoginEmail" ? init.email : user.defaultuser;
  const from = senders.includes(pick) ? pick : senders[0];
  const names = Array.isArray(init.userFromNameList) ? init.userFromNameList : [];
  // a representative or shared address goes out under its own name
  const fromName = [init.representInfo, init.sharedList].some((l) => Array.isArray(l) && l.includes(from)) ? ""
    : (names.find((n) => n.isDefault === true) ?? names[0])?.userName ?? "";
  const preview = { from: fromName ? `${fromName} <${from}>` : from, to: toList.map(shown), cc: ccList.map(shown),
    bcc: bccList.map(shown), subject, body };
  if (confirm !== true) return preview;

  const today = now(), days = num(init.bigFileDay) || 30, until = new Date(today);
  until.setDate(until.getDate() + days);
  const group = init.groupMailOption || {};
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
    ["eachTrans", String(user.eachtrans) === "0" ? "1" : ""],   // and "send to each recipient separately"
    ["neobizaddr", group.groupMailAddr ?? ""], ["neobizIntedAddr", group.groupMailIntedAddr ?? ""],
    ["neobizOrg", group.groupMailOrg ?? ""], ["muid", "0"], ["domainSeq", ""], ["mimeHeader", ""],
    ["sessionKey", init.sessionKey ?? ""], ["externalSendLimit", init.externalSendLimit ?? "N"],
    ["insideDomainArray", JSON.stringify(init["insideDomainArray[]"] ?? [])], ["aiResultJSON", ""],
    ["subject", subject], ["authToken", `${session.user.email}|${session.token}`],
  ]) form.append(k, String(v));
  const reply = await writeOnce(session, "/mail/mail014A04", form, "메일 발송", { fetch, full: true });
  const code = String(reply.resultCode);
  if (code === "1") return { ...preview, sent: true, left_out: String(reply.resultMsg ?? "") };   // external-domain limit
  if (code !== "0") throw new GroupwareError(`메일 발송 결과를 확인하지 못했습니다(${reply.resultMsg || code}). 보낸메일함을 ${CHECK}`);
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

export async function deleteMail(session, { muids, box = "INBOX", confirm = false } = {}, { fetch } = {}) {
  const uids = muidList(muids);
  // the web client deletes these for good, or cancels a scheduled send, instead of moving them to the trash
  if (["TRASH", "SPAM", "RESERVATION"].includes(String(box).trim().toUpperCase())) {
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
const hm = (minutes) => String(Math.floor(minutes / 60) * 100 + (minutes % 60)).padStart(4, "0");
const sameApp = (r, appDt, appSq) => String(r.appDt) === String(appDt) && String(r.appSq) === String(appSq);   // appSq alone may repeat
// validateNew's refusals come as result codes (live 2026-10-28), 22028 without a message
const REFUSED = { 22028: "그 기간에 이미 신청한 근태가 있습니다.",
  22023: "남은 연차가 부족하거나 마이너스 연차를 쓸 수 없습니다." };

async function leaveCodes(session, fetch) {
  const base = await request(session, "/human/common/attendapplication/getApplicationBaseInfo", {}, { fetch });
  const codes = (base?.attendCodeList || []).filter((c) => c.linkAtCd === LEAVE && c.useYn !== "N" && c.outProcessId);
  if (!codes.length) throw new GroupwareError(`연차 신청 항목을 받지 못했습니다. ${CHECK}`);
  return { base, codes };
}

async function leaveForm(session, code, fetch) {
  const u = session.user, formDTp = code.outProcessId;
  const forms = await request(session, "/eap/eap096A45", { header: { groupSeq: u.groupSeq, empSeq: u.empSeq },
    body: { companyInfo: { compSeq: u.compSeq, bizSeq: u.compSeq, deptSeq: u.deptSeq }, formDTp, langCode: "kr" } }, { fetch });
  const form = Array.isArray(forms) ? forms.filter((f) => f.formDTp === formDTp) : [];
  if (form.length !== 1) throw new GroupwareError(`결재 양식(${formDTp})을 찾지 못했습니다. ${CHECK}`);
  return form[0];
}

const draft = (session, formId, approkey, appLineId, fetch) => request(session, "/eap/eap110A03", { docID: 0, formID: formId,
  approkey, draftTp: "", reDraft: "", docType: "", doc_auth: 0, pageCode: "UBAP001", appLineId }, { fetch });
const who = (l) => `${l.user_nm || ""}(${l.act_nm || ""})`;
// who approves, in order, and who gets a copy: what the person agrees to and what the submit must still have
function lineOf(rm) {
  const line = Array.isArray(rm?.hidAppDocLine) ? rm.hidAppDocLine : [], refer = Array.isArray(rm?.hidRefer) ? rm.hidRefer : [];
  return { line, refer, sig: JSON.stringify([line.map((l) => String(l.user_id)), refer.map((r) => String(r.org_id))]),
    text: line.map(who).join(" → ") + (refer.length ? `, 참조 ${refer.map((r) => r.user_nm || r.dept_nm || "").join("·")}` : "") };
}
const NO_LINES = "본인 외 결재자가 있는 저장된 결재라인이 없습니다. 그룹웨어 전자결재에서 결재라인을 먼저 저장해 주세요.";

// The person's saved approval lines for the form, each as the draft loader fills it in without a document key
// (a read). With no saved line the draft holds the writer alone (live 2026-10-29), which would approve the
// leave by itself: such a line is never offered.
async function approvalLines(session, form, fetch) {
  const saved = await request(session, "/eap/eap096A48", { formId: form.formId }, { fetch });
  const me = String(session.user.empSeq), out = [];
  for (const s of Array.isArray(saved) ? saved : []) {
    const l = lineOf((await draft(session, form.formId, "", String(s.appLineId), fetch))?.resultMap);
    if (l.line.some((x) => String(x.user_id) !== me)) out.push({ id: String(s.appLineId), name: String(s.appLineNm || s.appLineId), ...l });
  }
  return out;
}

// Everything the request needs, read only: the code, the work-day window, the days it takes, the server's
// own checks, the title, the form and the approval line
async function planLeave(session, { kind, start, end = null, reason = "", start_time = null, approval_line = null },
  { fetch, now }) {
  const [coCd, empCd] = erp(session);
  const first = toApiDay(start), last = end ? toApiDay(end) : first;
  if (first > last) throw new GroupwareError(`시작일(${fmtDate(first)})이 종료일(${fmtDate(last)})보다 늦습니다.`);
  const { base, codes } = await leaveCodes(session, fetch);
  const code = codes.find((c) => c.atNm === String(kind ?? "").trim());
  if (!code) throw new GroupwareError(`kind는 ${codes.map((c) => c.atNm).join("·")} 중 하나로 넣어 주세요.`);
  const window = await request(session, "/human/common/attendapplication/getStartTmEndTmByWorkType",
    { empCd, startDate: first, endDate: first, atCd: code.atCd, linkAtCd: LEAVE }, { fetch });
  let startTm = String(window?.startTm), endTm = String(window?.endTm);
  if (code.timeSetFg === "NA") {   // 반반차: the web form leaves its two hours to the person
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(start_time ?? "").trim());
    const at = m && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    if (!(at + 120 <= 24 * 60)) throw new GroupwareError(`${code.atNm}은 시작 시각(start_time, 'HH:MM')을 넣어 주세요. 2시간으로 신청합니다.`);
    startTm = hm(at); endTm = hm(at + 120);
  }
  const time = `${startTm}~${endTm}`;
  if (!/^\d{4}~\d{4}$/.test(time)) throw new GroupwareError(`근무 시각을 받지 못했습니다. ${CHECK}`);
  const calc = await request(session, "/human/common/attendapplication/calculateApplicationDays", { startDate: first,
    endDate: last, startTime: startTm, endTime: endTm, atCd: code.atCd, linkAtCd: LEAVE, empCd, appRmkDc: reason,
    calculateOption: "HOLIDAY_EXCLUSION" }, { fetch });
  const spans = calc?.holidayExclusionApplicationList || [];
  if (!spans.length) throw new GroupwareError("그 기간에는 근무일이 없습니다.");
  // ponytail: one stretch of work days per request; the approval body repeats its table row per stretch, never tried
  if (spans.length > 1) {
    const each = spans.map((x) => [...new Set([x.startDt, x.endDt])].map(fmtDate).join("~"));
    throw new GroupwareError(`주말·휴일로 나뉘는 기간입니다. ${each.join(", ")}로 나눠 따로 신청해 주세요.`);
  }
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
  if (String(check.resultCode) !== "0") {
    throw new GroupwareError(REFUSED[check.resultCode] ?? `신청할 수 없습니다(${check.resultMsg || check.resultCode}).`);
  }
  const blocked = Object.entries(check.resultData || {}).filter(([, v]) => filled(v)).map(([k]) => k);
  if (blocked.length) throw new GroupwareError(`신청할 수 없습니다(${blocked.join(", ")}).`);
  const items = spans.map((x) => ({ ...x, coCd, empCd, deptCd: employee.deptCd, deptNm: employee.deptNm,
    empNm: calc.empNm || employee.korNm, appRmkDc: reason }));
  const title = await request(session, "/human/attendapplication/0hr00011", { applicationList: items, employeeList: [employee] },
    { fetch });
  if (typeof title !== "string" || !title) throw new GroupwareError(`신청서 제목을 받지 못했습니다. ${CHECK}`);
  const form = await leaveForm(session, code, fetch);
  const lines = await approvalLines(session, form, fetch), pick = String(approval_line ?? "").trim();
  const line = lines.find((l) => l.id === pick || l.name === pick);
  if (!line) {
    throw new GroupwareError(lines.length ? `approval_line은 저장된 결재라인 ${lines.map((l) => `'${l.name}'`).join("·")} 중 하나로 `
      + "넣어 주세요. 사용자에게 고르게 할 것." : NO_LINES);
  }
  const days = num(calc.ycUseCnt), { remaining } = await fetchLeaveBalance(session, {}, { fetch, now });
  return { code, employee, items, title, form, line, first, last, preview: { kind: code.atNm, start: fmtDate(first),
    end: fmtDate(last), time: time.replace(/(\d\d)(\d\d)/g, "$1:$2"), days, remaining_after: remaining - days, title, reason,
    approval_line: `${line.name}: ${line.text}` } };
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
async function linkDraft(session, { code, form, title, line: chosen }, { coCd, appDt, appSq }, fetch) {
  const approKey = `ERP_${randomUUID()}`, api = "/human/attendapplication/interlock";
  const linkKey = (await request(session, "/system/apiUtilEap/GetLinkKey", { menuCode: "HPD0110", approKey, vPCoCd: coCd, coCd },
    { fetch }))?.linkKey;
  if (!linkKey) throw new GroupwareError("결재 연결 키를 받지 못했습니다.");
  await request(session, "/system/apiUtilEap/SetEnageGroup", { approKey, formDTp: code.outProcessId, formId: form.formId,
    linkKey, formNm: form.formNm, docTitle: title, contents: "", contentsApi: `${api}/getInterlockFormContents`,
    statusApi: `${api}/setInterlockSync`, dummy1: "", link: "", vPCoCd: coCd, coCd }, { fetch });
  if (num(await request(session, "/human/openapi/attendapplication/saveLinkKey", { linkKey, appSq, coCd, appDt }, { fetch })) !== 1) {
    throw new GroupwareError("근태신청과 결재 문서를 잇지 못했습니다.");
  }
  const d = await draft(session, form.formId, approKey, chosen.id, fetch);
  const rm = d?.resultMap || {}, { line, refer, sig } = lineOf(rm), bind = rm.outProcessForm?.outBindData;
  if (!line.length || typeof bind !== "string" || !rm.docnumtype?.[0]?.cd_val || !d.mainhtml) {
    throw new GroupwareError("결재 문서 초안을 받지 못했습니다.");
  }
  if (String(rm.getFormData?.[0]?.form_id) !== String(form.formId)) throw new GroupwareError("결재 초안의 양식이 다릅니다.");
  if (sig !== chosen.sig) throw new GroupwareError("결재 문서의 결재선·참조가 미리보기와 다릅니다.");
  return { approKey, info: d.ucUserInfo || {}, line, refer, bind, numbering: rm.docnumtype[0].cd_val,
    body: fillBody(d.mainhtml, bind) };
}

// A saved application that has no document yet (상신대기): the employee screens have no delete for it, this
// is the overtime form's discard
const discardLeave = (session, { coCd, appDt, appSq }, fetch) => writeOnce(session,
  "/human/attendapplication/deleteSubmittedApplicationList", [{ coCd, appDt, appSq }], "근태신청 삭제", { fetch });

// ask: a client that can show a form; then the form, not confirm, decides
export async function requestLeave(session, args = {}, { fetch, now = () => new Date(), ask = null } = {}) {
  if (ask) return askLeave(session, args, { fetch, now, ask });
  const plan = await planLeave(session, args, { fetch, now });
  return args.confirm === true ? submitLeave(session, plan, { fetch, now }) : plan.preview;
}

const FIELDS = ["kind", "start", "end", "start_time", "reason", "approval_line"];
const valuesOf = (o) => Object.fromEntries(FIELDS.map((k) => [k, String(o?.[k] ?? "").trim()]));
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const span = (start, end) => (end !== start ? `${start}~${end}` : start);

function leaveSchema(codes, lines, v) {
  const kinds = codes.map((c) => c.atNm), dflt = (ok, x) => (ok && x ? { default: x } : {});
  return { type: "object", required: ["kind", "start", "approval_line"], properties: {
    kind: { type: "string", title: "종류", enum: kinds, ...dflt(kinds.includes(v.kind), v.kind) },
    start: { type: "string", title: "시작일", format: "date", ...dflt(isDay(v.start), v.start) },
    end: { type: "string", title: "종료일", description: "하루면 비워 두세요", format: "date", ...dflt(isDay(v.end), v.end) },
    start_time: { type: "string", title: "반반차 시작 시각", description: "반반차만, HH:MM부터 2시간", ...dflt(true, v.start_time) },
    reason: { type: "string", title: "사유", ...dflt(true, v.reason) },
    approval_line: { type: "string", title: "결재라인", oneOf: lines.map((l) => ({ const: l.id, title: `${l.name}: ${l.text}` })),
      ...dflt(lines.some((l) => l.id === v.approval_line), v.approval_line) } } };
}

const leaveText = (p) => [`${p.kind} ${span(p.start, p.end)} ${p.time}`,
  `연차 ${p.days}일 사용, 신청 후 남는 연차 ${p.remaining_after}일`, `제목: ${p.title}`, `사유: ${p.reason || "(없음)"}`,
  `결재라인: ${p.approval_line}`].join("\n");

// The person fills in or corrects every field and sees the plan for exactly those values: an accept with
// nothing changed submits, a change plans again and asks again.
async function askLeave(session, args, { fetch, now, ask }) {
  const { codes } = await leaveCodes(session, fetch);
  const lines = await approvalLines(session, await leaveForm(session, codes[0], fetch), fetch);
  if (!lines.length) throw new GroupwareError(NO_LINES);
  let v = valuesOf(args);
  v.approval_line = lines.find((l) => l.id === v.approval_line || l.name === v.approval_line)?.id
    ?? (lines.length === 1 && !v.approval_line ? lines[0].id : v.approval_line);
  for (;;) {
    let plan = null, message;
    try {
      plan = await planLeave(session, v, { fetch, now });
      message = `${leaveText(plan.preview)}\n\n값을 바꾸지 않고 승인하면 바로 상신되고 결재자에게 알림이 갑니다. `
        + "값을 바꾸면 다시 계산해 보여 드립니다.";
    } catch (e) {
      if (e instanceof SessionError) throw e;
      message = v.kind && v.start ? `휴가 신청 내용을 확인해 주세요.\n${e.message}` : "휴가 신청 내용을 입력해 주세요.";
    }
    const r = await ask({ message, requestedSchema: leaveSchema(codes, lines, v) });
    if (r?.action !== "accept") return { submitted: false, note: "폼에서 승인받지 못해 신청하지 않았습니다." };
    const next = valuesOf(r.content);
    if (plan && JSON.stringify(next) === JSON.stringify(v)) return submitLeave(session, plan, { fetch, now });
    v = next;
  }
}

async function submitLeave(session, plan, { fetch, now }) {
  const [coCd, empCd] = erp(session);
  const saved = await writeOnce(session, "/human/attendapplication/create", { coCd: "", appDt: "", appEmpCd: empCd,
    deptCd: "", titleDc: plan.title, approLineId: "", calLinkKey: "", linkKey: "", approState: "", fileGroup: 0,
    employeeList: [plan.employee], version: "v2", overtimeVersion: "v2", applicationList: plan.items }, "근태신청 저장", { fetch });
  if (!saved?.appSq || !/^\d{8}$/.test(saved.appDt)) throw unsure("근태신청 저장");
  const app = { coCd: saved.coCd || coCd, appDt: String(saved.appDt), appSq: saved.appSq };
  const id = `${app.appDt}-${app.appSq}`, ref = `근태신청(id ${id})`;
  // from here a re-login must not run the tool again: that would save a second application
  let d;
  try {
    d = await linkDraft(session, plan, app, fetch);
  } catch (e) {
    const gone = !(e instanceof SessionError) && await discardLeave(session, app, fetch).then(() => true, () => false);
    throw new GroupwareError(gone ? `결재 문서를 만들지 못해(${whyOf(e)}) 저장한 근태신청을 지웠습니다.`
      : `${ref}은 저장됐지만 결재 문서를 만들지 못했습니다(${whyOf(e)}). 상신대기로 남았으니 leave_cancel로 지워 주세요.`);
  }
  // never retried: refused, or unclear, the application may sit at 상신대기 or the document may be out
  const unsent = (why) => new GroupwareError(`${ref}은 저장됐지만 상신 결과를 확인하지 못했습니다(${why}). leave_requests에서 `
    + "상태를 확인해, 결재진행이 아니면 leave_cancel로 지워 주세요.");
  let sent;
  try {
    // eap110A06 as the web editor sends a new leave document (its defaults: normal level, not secret)
    const u = session.user, n = now(), { form, title } = plan, { info, line, refer } = d;
    const doc = { inservice_time: "0", doc_level: "001", doc_security: "0", emergency_level: "1" };
    sent = await request(session, "/eap/eap110A06", { pageCode: "UBAP001", paramItem: { bindData: JSON.stringify(d.bind),
      interDivId: "divInterJson", interDocTp: "json", doc_id: 0, form_id: form.formId, numbering_id: d.numbering,
      rep_dt: `${ymd(n)} ${n.toTimeString().slice(0, 8)}`, repdt_mod_yn: "0",
      co_id: u.compSeq, dept_id: u.deptSeq, biz_id: info.bizSeq || u.compSeq, user_id: u.empSeq,
      co_nm: info.compName || "", dept_nm: info.deptName || "", user_nm: info.empName || "",
      doc_title: title, doc_sts: "20", ...doc, use_yn: "1", approkey: d.approKey, contents_tp: "10",
      doc_contents: encodeURIComponent(d.body), pTEAG_APPDOC_LINE: line, pVKD_TKDDITEM: [], pVCM_ATTACHFILEINFO: [],
      pRefer: refer, pReceive: [], pOper: [], pTEAG_APPDOC_REF: [], pDraftTp: "", seal_use_yn: "", receipient: "", receipt: "",
      iframeHtml: "", re_draft: "", modifyAppLineYn: "Y", ...Object.fromEntries(["modifyReceive10", "modifyReceive20",
        "modifyReceive30", "modifyReceive40", "modifyTitle", "modifyContent", "modifyRef", "modifyAttach", "modifyAddItem",
        "modifyInservice", "modifyDoclevel", "modifyEmergency", "modifySeal", "modifyEabox"].map((k) => [k, "Y"])),
      modifyFileList: "", delFileSnList: [], auditorYn: "0",
      modifyDocInfo: { docId: 0, appdoc: { ...doc, doc_title: title },
        appdocReceiveList: refer.map((r) => ({ receive_div: "10", org_div: r.org_div || r.div, org_id: r.org_id })),
        appdocLineList: line.map((l) => ({ doc_line_m_seq: l.doc_line_m_seq, doc_line_s_seq: l.doc_line_s_seq, act_id: l.act_id,
          co_id: l.co_id, dept_id: l.dept_id, user_id: l.user_id, doc_line_gb: l.doc_line_gb })),
        appdocFileList: [], appdocRefList: [] },
      modifyItemList: null, isLatestVerContentsFile: true, versionCheck: null, formLang: "kr", aiVerifyHistories: [],
      aiVerifyAutoOnSubmit: false, aiVerifyUseYn: "0", oneAiAgreeYn: info.oneAiAgreeYn || "Y" } }, { fetch });
  } catch (e) {
    throw unsent(whyOf(e));
  }
  if (!/^\d+$/.test(sent?.result)) throw unsent("문서 번호 없음");
  // submitted already: a failed read-back must not repeat anything
  const row = (await leaveRows(session, plan.first, plan.last, { fetch }).catch(() => [])).find((r) => sameApp(r, app.appDt, app.appSq));
  return { ...plan.preview, submitted: true, id, doc_id: String(sent.result), status: row ? leaveStatus(row) : "",
    link: popup(session, { MicroModuleCode: "eap", callComp: "UBAP002", docID: sent.result, formId: plan.form.formId,
      docAuth: "0" }) };
}

// a document still with its writer: the writer's, 결재진행, and no one else on the line has acted. approval_read
// saw app_yn "0" on finished documents; an action date is what a step that acted has (live 2026-10-28)
async function checkWithdraw(session, docId, fetch) {
  const me = String(session.user.empSeq);
  const st = await request(session, "/eap/eap110A98", { docId, pageCode: "UBAP002" }, { fetch });
  if (String(st?.user_id) !== me) throw new GroupwareError("본인이 상신한 문서만 회수할 수 있습니다.");
  if (String(st?.doc_sts) !== "30") throw new GroupwareError(`결재 진행 중인 문서가 아닙니다(상태 ${st?.doc_sts}). ${CHECK}`);
  const data = await request(session, "/eap/eap096A62", { docId }, { fetch });
  const line = data?.lineList || data?.lineInfo;
  if (!Array.isArray(line) || !line.length) throw new GroupwareError(`결재선을 받지 못했습니다. ${CHECK}`);
  // the writer's own step carries the submit time; without it the dates cannot be read, so no withdraw
  if (!line.some((l) => String(l.empSeq) === me && l.appDt)) throw new GroupwareError(`결재선의 처리 기록을 읽지 못해 회수하지 않습니다. ${CHECK}`);
  const acted = line.filter((l) => String(l.empSeq) !== me && l.appDt);
  if (acted.length) throw new GroupwareError(`${acted.map((l) => l.userNm).join(", ")} 님이 이미 처리해 회수할 수 없습니다. ${CHECK}`);
}

// the delete takes any document id, linked HR data with it, for good: only the writer's own 임시보관 document
// of an attendance form (HP_HPD0110_)
async function checkDelete(session, docId, fetch) {
  const list = (await request(session, "/eap/eap107A28",
    { docIdList: docId, pageCode: "UBA1020", upperMenuNo: "1000300", menuNo: "1000500" }, { fetch }))?.list;
  const d = Array.isArray(list) && list.length === 1 ? list[0] : {};
  if (String(d?.DOC_ID) !== docId) throw new GroupwareError(`결재 문서(${docId})를 찾지 못했습니다. ${CHECK}`);
  if (!String(d.FORM_D_TP).startsWith("HP_HPD0110_") || String(d.USER_ID) !== String(session.user.empSeq)
    || String(d.DOC_STS) !== "10") {
    throw new GroupwareError(`본인의 임시보관 근태 문서만 삭제할 수 있습니다. ${CHECK}`);
  }
}

// a GET answered as server-sent events; the reply also carries session token parts, so only failCnt is read
async function deleteDoc(session, docId, fetch) {
  const out = await writeOnce(session, `/eap/sse/eap107A25?docIdList=${docId}`, null, "결재 문서 삭제", { fetch, get: true });
  if (num(out?.failCnt) > 0) throw new GroupwareError(`결재 문서를 삭제하지 못했습니다. ${CHECK}`);
}

const CANCEL = { 0: "결재 전 문서를 회수한 뒤 삭제합니다.", 5: "임시보관 문서를 삭제합니다.", 2: "결재 문서 없이 저장만 된 신청을 지웁니다." };

const cancelable = (r) => r.linkAtCd === LEAVE && Object.hasOwn(CANCEL, String(r.approState)) && r.reportCancYn !== "Y"
  && String(r.cancellationApplication) !== "true";
// ask: a client that can show a form; the person picks one of the requests still cancelable and the pick
// cancels it, confirm aside
export async function cancelLeave(session, { id = null, confirm = false } = {}, { fetch, now = () => new Date(), ask = null } = {}) {
  if (!ask) return cancelOne(session, id, confirm === true, fetch);
  const year = now().getFullYear(), options = new Map(), given = String(id ?? "").trim();
  for (const r of (await leaveRows(session, `${year}0101`, `${year + 1}1231`, { fetch })).filter(cancelable)) {
    const key = `${r.appDt}-${r.appSq}`;   // one application, however many stretches
    if (!options.has(key)) {
      options.set(key, `${span(fmtDate(r.startDt), fmtDate(r.endDt))} ${r.atItemNm || r.atCdNm || r.atNm || ""} (${leaveStatus(r)})`
        + (r.appRmkDc ? ` ${r.appRmkDc}` : ""));
    }
  }
  if (given && !options.has(given)) {   // outside these years, or not cancelable: the checks say which
    const p = await cancelOne(session, given, false, fetch);
    options.set(given, `${span(p.start, p.end)} ${p.kind} (${p.status})`);
  }
  if (!options.size) return { canceled: false, note: "결재 전이라 취소할 수 있는 연차 신청이 없습니다. 결재가 끝난 신청은 그룹웨어 근태신청에서 결재취소해 주세요." };
  const r = await ask({ message: "취소할 연차 신청을 고르세요. 승인하면 바로 취소되며 되돌릴 수 없습니다. "
    + "결재 진행 중인 문서는 회수한 뒤 삭제합니다.", requestedSchema: { type: "object", required: ["id"], properties: {
    id: { type: "string", title: "신청", oneOf: [...options].map(([k, title]) => ({ const: k, title })),
      ...(options.has(given) ? { default: given } : {}) } } } });
  if (r?.action !== "accept") return { canceled: false, note: "폼에서 승인받지 못해 취소하지 않았습니다." };
  return cancelOne(session, r.content?.id, true, fetch);
}

async function cancelOne(session, id, confirm, fetch) {
  const [coCd, empCd] = erp(session);
  const m = /^(\d{8})-(\d+)$/.exec(String(id ?? "").trim());
  if (!m) throw new GroupwareError("id에는 leave_requests의 id('YYYYMMDD-번호')를 넣어 주세요.");
  const [, appDt, appSq] = m;
  const info = await request(session, "/human/hrd0220/selectAttendApplicationInfo", { appDt, appSq: Number(appSq) }, { fetch });
  const master = info?.attendApplicationMaster || {};
  const days = (info?.attendApplicationDetailList || []).map((d) => String(d.atDt)).filter((d) => /^\d{8}$/.test(d)).sort();
  if (String(master.appSq) !== appSq || !days.length) throw new GroupwareError(`근태신청(id ${id})을 찾을 수 없습니다.`);
  if (String(master.appEmpCd) !== String(empCd)) throw new GroupwareError("본인이 신청한 근태만 취소할 수 있습니다.");
  const first = days[0], last = days.at(-1);
  const row = (await leaveRows(session, first, last, { fetch })).find((r) => sameApp(r, appDt, appSq));
  if (!row) throw new GroupwareError(`근태신청(id ${id})을 찾을 수 없습니다.`);
  if (row.linkAtCd !== LEAVE) throw new GroupwareError("연차·반차·반반차 신청만 취소할 수 있습니다.");
  // a cancel form in flight, or the leave it cancels: never tried here
  if (row.reportCancYn === "Y" || String(row.cancellationApplication) === "true") {
    throw new GroupwareError(`결재취소가 걸린 신청은 그룹웨어에서 처리해 주세요. ${CHECK}`);
  }
  const state = String(row.approState), docId = String(row.idDoc), status = leaveStatus(row);
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
    if (num(back?.returnValue) !== 1) throw unsure("회수");
    // withdrawn: from here a re-login must not run the tool again, and the person must hear where the document is
    try {
      await checkDelete(session, docId, fetch);   // now 임시보관, or stop before the delete
      await deleteDoc(session, docId, fetch);
    } catch (e) {
      throw new GroupwareError(`결재 문서를 회수해 임시보관으로 옮겼지만 삭제하지 못했습니다(${whyOf(e)}). leave_cancel을 다시 부르면 삭제합니다.`);
    }
  }
  // done already: a failed check must not repeat it
  const rows = await leaveRows(session, first, last, { fetch }).catch(() => { throw unsure("취소"); });
  if (rows.some((r) => sameApp(r, appDt, appSq) && String(r.approState) !== "-3")) {
    throw new GroupwareError(`취소한 뒤에도 신청이 남아 있습니다. ${CHECK}`);
  }
  return { ...preview, canceled: true };
}
