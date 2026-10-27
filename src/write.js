// Resource and schedule writes: a preview unless args.confirm is exactly true, one write call that
// is never retried, a read-back, and a result it cannot confirm says to check the groupware instead
// of inviting another try.
import { GroupwareError, SessionError, request } from "./client.js";
import { calendarRows, calendars, companyInfo, fetchResources, fmtStamp, num, parseLocal, resolveAttendees,
  scheduleRows, toApiDt } from "./read.js";

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
async function writeOnce(session, path, body, what, { fetch } = {}) {
  try {
    return await request(session, path, body, { fetch });
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

export async function cancelReservation(session, { res_seq, start, end, confirm = false } = {}, { fetch } = {}) {
  const apiStart = toApiDt(start), apiEnd = toApiDt(end);   // bad times fail before any request
  const day = String(start).slice(0, 10), me = str(session.user.empSeq);
  const matches = async () => (await scheduleRows(session, day, day, [str(res_seq)], fetch)).filter((r) =>
    str(r.resStartDate) === apiStart && str(r.resEndDate) === apiEnd && str(r.empSeq) === me);

  const found = await matches();
  if (!found.length) throw new GroupwareError("그 시간에 취소할 본인 예약을 찾지 못했습니다.");
  if (found.length > 1) throw new GroupwareError("같은 시간에 본인 예약이 여러 건이라 하나로 정하지 못했습니다.");
  const r = found[0];
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
