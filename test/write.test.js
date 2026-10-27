// reserve, cancel, the schedule and mail writes: previews write nothing, one write with the stored ids,
// fail-closed guards, and read-backs that never repeat a write
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupwareError, SessionError } from "../src/client.js";
import { cancelReservation, createSchedule, deleteMail, deleteSchedule, markMail, reserveResource, sendMail,
  updateSchedule } from "../src/write.js";

const RES = { base: "https://gw.example.com", token: "G1|E1|R1", signKey: "test-sign-key",
  user: { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", empSeq: "E1" } };
const COMPANY = { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", emailAddr: "", emailDomain: "" };

// one fake groupware: handler(path, body, calls) gives the resultData, or a whole Response, or throws
function fake(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
    calls.push({ path, body });
    const out = handler(path, body, calls);
    return out instanceof Response ? out : new Response(JSON.stringify({ resultCode: 0, resultData: out ?? null }));
  };
  return { fetch, calls, paths: () => calls.map((c) => c.path) };
}
const count = (api, code) => api.paths().filter((p) => p.endsWith(code)).length;
const bodyOf = (api, code) => api.calls.find((c) => c.path.endsWith(code))?.body;
const timesOut = () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); };
const unauthorized = () => new Response("", { status: 401 });
const rejectsWith = (re) => (e) => e instanceof GroupwareError && re.test(e.message);
const NOT_TRUE = ["true", 1, "yes"];   // truthy, but only the boolean true writes

const ME = { empSeq: "E1", empName: "홍길동", deptSeq: "D1", deptName: "개발팀", compSeq: "1000", positionName: "주임" };
const KIM_DEV = { empSeq: "E7", empName: "김민수", deptSeq: "D2", deptName: "개발팀", compSeq: "1000", positionName: "주임" };
const KIM_HR = { empSeq: "E8", empName: "김민수", deptSeq: "D3", deptName: "인사팀", compSeq: "1000", positionName: "대리" };
const searchIn = (people, body) => people.filter((x) => x.empName.includes(body.searchText));   // a substring, like the real search

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

// ---- resource_reserve
const START = "2099-01-01 14:00", END = "2099-01-01 15:00";

function resApi({ reservationYn = "N", success = 1, resSeq = "7", apprYn = "N", people = [], write } = {}) {
  return fake((path, body) => {
    if (path.endsWith("gw102A04")) return searchIn(people, body);
    if (path.endsWith("rs121A01")) {
      return { resultList: [{ resSeq, resName: "회의실 A", attrName: "회의실", apprYn }] };
    }
    if (path.endsWith("rs121A04")) return { reservationYn };
    if (path.endsWith("rs121A06")) return write ? write() : { successTf: success };
    return {};
  });
}
const reserve = (api, args = {}, opts = {}) =>
  reserveResource(RES, { res_seq: "7", start: START, end: END, title: "회의", ...args }, { fetch: api.fetch, ...opts });

test("reserve: a preview does not write", async () => {
  const api = resApi();
  const out = await reserve(api, { description: "분기 계획 논의" });   // a description is no approval
  assert.deepEqual(out, { resource: "회의실 A", start: START, end: END, available: true,
    approval_required: false, attendees: [] });
  assert.deepEqual(api.paths(), ["/schres/rs121A01", "/schres/rs121A04"]);
});

test("reserve: confirm writes when available, with the check and booking bodies", async () => {
  const api = resApi();
  const out = await reserve(api, { description: "안건", confirm: true });
  assert.equal(out.reserved, true);
  assert.deepEqual(bodyOf(api, "rs121A04"), { companyInfo: COMPANY, resSeq: "7", startDate: "209901011400",
    endDate: "209901011500", alldayYn: "N", resStartDate: "20990101" });
  assert.deepEqual(bodyOf(api, "rs121A06"), { companyInfo: COMPANY, langCode: "kr", resSeq: "7", reqText: "회의",
    apprYn: "N", alldayYn: "N", startDate: "209901011400", endDate: "209901011500", descText: "안건",
    resSubscriberList: [{ groupSeq: "G1", compSeq: "1000", deptSeq: "D1", empSeq: "E1" }],
    uidList: "", repeatType: "10", repeatEndDay: "" });
});

test("reserve: a resource that needs approval is booked with apprYn Y", async () => {
  const api = resApi({ apprYn: "Y" });
  const out = await reserve(api, { confirm: true });
  assert.equal(out.approval_required, true);
  assert.equal(bodyOf(api, "rs121A06").apprYn, "Y");
});

test("reserve: confirm refuses when unavailable", async () => {
  const api = resApi({ reservationYn: "Y" });
  await assert.rejects(reserve(api, { confirm: true }), rejectsWith(/이미 예약이 있습니다/));
  assert.equal(count(api, "rs121A06"), 0);
});

for (const [id, start, end] of [["end-first", END, START], ["zero-length", START, START]]) {
  test(`reserve: a bad time range is rejected before the network: ${id}`, async () => {
    const api = resApi();
    await assert.rejects(reserve(api, { start, end }), rejectsWith(/종료 시각이 시작 시각보다 빠릅니다/));
    assert.deepEqual(api.calls, []);
  });
}

test("reserve: a past start is rejected before the network", async () => {
  const api = resApi();
  await assert.rejects(reserve(api, { start: "2000-01-01 14:00", end: "2000-01-01 15:00" }), rejectsWith(/이미 지났습니다/));
  const now = () => new Date(2026, 9, 26, 12, 0);   // frozen: a minute ago has passed, a minute ahead has not
  await assert.rejects(reserve(api, { start: "2026-10-26 11:59", end: "2026-10-26 13:00" }, { now }), rejectsWith(/이미 지났습니다/));
  assert.deepEqual(api.calls, []);
  await reserve(api, { start: "2026-10-26 12:01", end: "2026-10-26 13:00" }, { now });
  assert.equal(count(api, "rs121A04"), 1);
});

for (const success of [0, "0", false, null]) {
  test(`reserve: confirm fails when the write does not report success: ${JSON.stringify(success)}`, async () => {
    const api = resApi({ success });
    await assert.rejects(reserve(api, { confirm: true }), rejectsWith(/^예약 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "rs121A06"), 1);   // the write was attempted, once
  });
}

for (const success of [1, "1", true]) {
  test(`reserve: confirm reads the success flag in any JSON form of one: ${JSON.stringify(success)}`, async () => {
    assert.equal((await reserve(resApi({ success }), { confirm: true })).reserved, true);
  });
}

for (const confirm of NOT_TRUE) {
  test(`reserve: confirm ${JSON.stringify(confirm)} only previews`, async () => {
    const api = resApi();
    const out = await reserve(api, { description: "안건 논의", confirm });
    assert.equal(out.reserved, undefined);
    assert.equal(count(api, "rs121A06"), 0);
  });
}

for (const [apiValue, given] of [[7, "7"], ["7", 7]]) {
  test(`reserve sends the resource id exactly as the API returned it: api ${typeof apiValue}`, async () => {
    const api = resApi({ resSeq: apiValue });
    await reserve(api, { res_seq: given, confirm: true });
    assert.equal(bodyOf(api, "rs121A04").resSeq, apiValue);
    assert.equal(bodyOf(api, "rs121A06").resSeq, apiValue);
  });
}

test("reserve: an unknown resource is reported", async () => {
  const api = resApi();
  await assert.rejects(reserve(api, { res_seq: "99", confirm: true }), rejectsWith(/자원 99을\(를\) 찾을 수 없습니다/));
  assert.deepEqual(api.paths(), ["/schres/rs121A01"]);
});

test("reserve treats an unanswered conflict check as unavailable", async () => {
  const api = fake((path) => {
    if (path.endsWith("rs121A01")) return { resultList: [{ resSeq: "7", resName: "회의실 A", apprYn: "N" }] };
    return path.endsWith("rs121A04") ? {} : { successTf: 1 };   // a 200 that says nothing about reservationYn
  });
  assert.equal((await reserve(api)).available, false);
  await assert.rejects(reserve(api, { confirm: true }), GroupwareError);
  assert.equal(count(api, "rs121A04"), 2);   // the check was reached
  assert.equal(count(api, "rs121A06"), 0);   // and nothing was written
});

test("reserve books the resolved attendees after the booker", async () => {
  const api = resApi({ people: [KIM_DEV, KIM_HR] });
  const out = await reserve(api, { attendees: ["김민수 개발"], confirm: true });
  assert.deepEqual(bodyOf(api, "gw102A04"), { searchText: "김민수", orgGubunList: ["U"] });
  // the search result has no groupSeq: the booker's own fills it
  assert.deepEqual(bodyOf(api, "rs121A06").resSubscriberList, [
    { groupSeq: "G1", compSeq: "1000", deptSeq: "D1", empSeq: "E1" },
    { groupSeq: "G1", compSeq: "1000", deptSeq: "D2", empSeq: "E7" }]);
  assert.deepEqual(out.attendees, ["김민수 (개발팀)"]);
  assert.equal(out.reserved, true);
});

for (const [id, entry, match] of [
  ["same-name", "김민수", /후보: 김민수 \(개발팀\/주임\), 김민수 \(인사팀\/대리\)/],
  ["hint-matches-none", "김민수 재무", /후보/],
  ["not-found", "박없음", /찾지 못했습니다/]]) {
  test(`reserve refuses attendees it cannot pin to one person: ${id}`, async () => {
    const api = resApi({ people: [KIM_DEV, KIM_HR] });
    await assert.rejects(reserve(api, { attendees: [entry], confirm: true }), rejectsWith(match));
    // stopped before the availability check and the write
    assert.equal(count(api, "rs121A04") + count(api, "rs121A06"), 0);
  });
}

test("reserve lists each attendee once and the booker once", async () => {
  const api = resApi({ people: [ME, KIM_DEV] });
  const out = await reserve(api, { attendees: ["홍길동", "김민수", "김민수"], confirm: true });
  assert.deepEqual(bodyOf(api, "rs121A06").resSubscriberList.map((s) => s.empSeq), ["E1", "E7"]);
  assert.deepEqual(out.attendees, ["홍길동 (개발팀)", "김민수 (개발팀)"]);
});

for (const [id, write, check] of [
  ["timeout", timesOut, rejectsWith(/^예약 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/)],
  ["refused-by-api", () => new Response(JSON.stringify({ resultCode: 114, resultMsg: "중복" })),
    rejectsWith(/^\/schres\/rs121A06: 중복 그룹웨어에서 확인해 주세요\.$/)],
  ["session-refused", unauthorized, (e) => e instanceof SessionError]]) {
  test(`reserve: the one booking call ending unclear is sent once and says so: ${id}`, async () => {
    const api = resApi({ write });
    await assert.rejects(reserve(api, { confirm: true }), check);
    assert.equal(count(api, "rs121A06"), 1);
  });
}

// ---- resource_cancel
const CANCEL_ROW = { resSeq: "12", seqNum: 11735, resIdx: "1", reqText: "테스트",
  resStartDate: "209901011400", resEndDate: "209901011500", createDate: "20261016103000",
  schmSeq: "", schSeq: "", resName: "대회의실 회의실", alldayYn: "N", empSeq: "E1" };

// answers `before` until the cancel has gone out, then `after`; check(path) may fail the read-back
function cancelApi(before, { after = [], success = true, write, check } = {}) {
  return fake((path, _body, calls) => {
    const cancelled = calls.some((c) => c.path.endsWith("rs121A11"));
    if (path.endsWith("rs121A05")) {
      if (cancelled && check) return check();
      return { resultList: cancelled ? after : before };
    }
    if (path.endsWith("rs121A11")) return write ? write() : { successTf: success };
    return {};
  });
}
const cancel = (api, args = {}) => cancelReservation(RES, { res_seq: "12", start: START, end: END, ...args }, { fetch: api.fetch });

test("cancel: a preview finds the booking and writes nothing", async () => {
  const api = cancelApi([CANCEL_ROW]);
  const out = await cancel(api);
  assert.deepEqual(out, { resource: "대회의실 회의실", title: "테스트", start: START, end: END });
  assert.deepEqual(api.paths(), ["/schres/rs121A05"]);
  const body = api.calls[0].body;
  assert.deepEqual([body.resList, body.startDate, body.endDate], [[{ resSeq: "12" }], "20990101", "20990101"]);
});

test("cancel: confirm sends the row and checks it is gone", async () => {
  const api = cancelApi([CANCEL_ROW], { after: [] });
  const out = await cancel(api, { res_seq: 12, confirm: true });
  assert.equal(out.cancelled, true);
  assert.deepEqual(api.paths(), ["/schres/rs121A05", "/schres/rs121A11", "/schres/rs121A05"]);
  assert.deepEqual(api.calls[1].body, { companyInfo: COMPANY, statusCode: "CA", deleteRangeCode: "UO",
    resSeqList: [{ resSeq: "12", seqNum: 11735, resIdx: "1", reqText: "테스트", startDate: "209901011400",
      endDate: "209901011500", createDate: "20261016103000", schmSeq: "", schSeq: "", resName: "대회의실 회의실",
      alldayYn: "N" }], langCode: "kr" });
});

for (const [id, rows, match] of [
  ["none", [], /찾지 못했습니다/],
  ["someone-elses", [{ ...CANCEL_ROW, empSeq: "E9" }], /찾지 못했습니다/],
  ["two", [CANCEL_ROW, { ...CANCEL_ROW, seqNum: 2 }], /여러 건/],
  ["other-time", [{ ...CANCEL_ROW, resEndDate: "209901011530" }], /찾지 못했습니다/]]) {
  test(`cancel refuses unless exactly one own booking matches: ${id}`, async () => {
    const api = cancelApi(rows);
    await assert.rejects(cancel(api, { confirm: true }), rejectsWith(match));
    assert.equal(count(api, "rs121A11"), 0);
  });
}

for (const [id, opts] of [["still-there", { after: [CANCEL_ROW], success: true }],
  ["no-success-flag", { after: [], success: false }]]) {
  test(`cancel reports when it cannot confirm the result: ${id}`, async () => {
    await assert.rejects(cancel(cancelApi([CANCEL_ROW], opts), { confirm: true }),
      rejectsWith(/^취소 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
  });
}

for (const start of ["2099-01-01", "2099-01-01 14:00:00"]) {
  test(`cancel rejects a malformed time before sending: ${start}`, async () => {
    const api = cancelApi([CANCEL_ROW]);
    await assert.rejects(cancel(api, { start }), (e) => !(e instanceof GroupwareError) && e.message.includes(start));
    assert.deepEqual(api.calls, []);
  });
}

for (const confirm of NOT_TRUE) {
  test(`cancel: confirm ${JSON.stringify(confirm)} only previews`, async () => {
    const api = cancelApi([CANCEL_ROW]);
    assert.equal((await cancel(api, { confirm })).cancelled, undefined);
    assert.equal(count(api, "rs121A11"), 0);
  });
}

// beyond Python, which lets these escape: the cancel went out, so a failed check must neither
// make the caller's re-login run the cancel again nor read as a raw error
for (const [id, opts] of [["check-session-dropped", { check: unauthorized }], ["check-timeout", { check: timesOut }],
  ["cancel-timeout", { write: timesOut }]]) {
  test(`cancel: an unclear cancel or check is unconfirmed, never retried: ${id}`, async () => {
    const api = cancelApi([CANCEL_ROW], opts);
    await assert.rejects(cancel(api, { confirm: true }), rejectsWith(/^취소 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "rs121A11"), 1);
  });
}

test("cancel: a cancel refused for the session stays a SessionError (it never ran)", async () => {
  const api = cancelApi([CANCEL_ROW], { write: unauthorized });
  await assert.rejects(cancel(api, { confirm: true }), SessionError);
  assert.equal(count(api, "rs121A11"), 1);
});

// ---- schedule_create / schedule_update / schedule_delete
const WRITE_CALS = [
  { mcalSeq: 134, calType: "E", calRwGbn: "w", empSeq: "E1", calTitle: "내 일정", displayYn: "Y" },
  { mcalSeq: 35, calType: "M", calRwGbn: "r", empSeq: "E9", calTitle: "공용 일정", displayYn: "Y" }];
const SCH_START = "2099-01-01 15:00", SCH_END = "2099-01-01 16:00";
// an sc111A04 detail of a plain schedule of mine, with the fields the guard reads
const CREATED = { schSeq: 8439, schmSeq: 8439, mcalSeq: 134, schTitle: "주간회의",
  startDate: "209901011500", endDate: "209901011600", alldayYn: "N",
  repeatType: "10", calType: "E", gbnCode: "E", schGbnCode: "10",
  lunarYn: "N", contents: "", resList: [], reservedList: [],
  addressUserList: [], schPartEmpList: [], schUserList: [], schAlarmList: [],
  fileList: [], fileCnt: 0 };

// answers `before` until a request to `code` has gone out, then `after`
const until = (code, before, after) => (calls) => (calls.some((c) => c.path.endsWith(code)) ? after : before);

// write is sc111A05's resultData; detail (sc111A04) and rows (sc111A03) may be until(...) callables;
// fail(path, calls) may answer or throw first
function schApi({ cals = WRITE_CALS, people = [], write = null, detail = null, rows = [], fail } = {}) {
  return fake((path, body, calls) => {
    const failed = fail?.(path, calls);
    if (failed !== undefined) return failed;
    if (path.endsWith("gw102A04")) return searchIn(people, body);
    if (path.endsWith("sc111A02")) return { resultList: cals };
    if (path.endsWith("sc111A03")) return { resultList: typeof rows === "function" ? rows(calls) : rows };
    if (path.endsWith("sc111A04")) return typeof detail === "function" ? detail(calls) : detail;
    if (path.endsWith("sc111A05")) return write;
    return true;   // sc111A06
  });
}
const create = (api, args = {}) =>
  createSchedule(RES, { title: "주간회의", start: SCH_START, end: SCH_END, ...args }, { fetch: api.fetch });

test("create: a preview finds my calendar and writes nothing", async () => {
  const api = schApi();
  const out = await create(api, { title: " 주간회의 ", place: "대회의실" });
  assert.deepEqual(out, { calendar: "내 일정", title: "주간회의", start: SCH_START, end: SCH_END,
    place: "대회의실", memo: "", attendees: [] });
  assert.deepEqual(api.paths(), ["/schres/sc111A02"]);   // no sc111A05 on a preview
});

test("create: confirm sends the contract and reads it back", async () => {
  const api = schApi({ people: [ME, KIM_DEV, KIM_HR], write: { schSeq: 8439, schmSeq: 8439 }, detail: CREATED });
  const out = await create(api, { place: "대회의실", memo: "안건", attendees: ["홍길동", "김민수 개발", "김민수 개발"], confirm: true });
  assert.deepEqual(api.paths(), ["/schres/sc111A02", "/gw/APIHandler/gw102A04", "/gw/APIHandler/gw102A04",
    "/gw/APIHandler/gw102A04", "/schres/sc111A05", "/schres/sc111A04"]);
  assert.deepEqual(api.calls[4].body, {
    companyInfo: COMPANY, langCode: "kr", schmSeq: "0", schSeq: "0",
    mcalSeq: "134", schTitle: "주간회의", startDate: "209901011500",
    endDate: "209901011600", alldayYn: "N", lunarYn: "N", alarm_yn: "N",
    gbnCode: "E", calType: "E", gbnSeq: "", schGbnCode: "10", repeatType: "10",
    repeatEndDay: "", repeatByDay: "", contents: "안건", rangeCode: "N",
    schPlace: "대회의실", placeMapData: "{}", placeFileId: "", fileId: "",
    delFileList: [], uidList: "", resList: [], reservedList: [],
    schAlarmList: [], schUserList: [],
    // I made it, so I am not invited; the other person once, with my groupSeq
    schPartEmpList: [{ compSeq: "1000", groupSeq: "G1", deptSeq: "D2", empSeq: "E7", dutyPositionOption: "0" }],
    addressUserList: [], inviterPartType: "M", companyEmpSeq: "E1", empSeq: "E1",
    groupSeq: "G1", otherLinkList: [], schModuleGbn: null, schModuleSeq: null,
    myMemo: "", videoYn: "N", mailSend: "N" });
  assert.deepEqual(api.calls[5].body, { companyInfo: COMPANY, schSeq: "8439", tcalSeq: "", langCode: "kr" });
  assert.deepEqual(out, { calendar: "내 일정", title: "주간회의", start: SCH_START, end: SCH_END,
    place: "대회의실", memo: "안건", attendees: ["홍길동 (개발팀)", "김민수 (개발팀)"], created: true, sch_seq: 8439 });
});

test("create finds its id in the list when the answer has none", async () => {
  const row = { schSeq: 8440, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500", endDate: "209901011600" };
  // decoys around it: another title; the same title in another slot; the same title with
  // only the start or only the end of the slot differing
  const rows = [{ ...row, schSeq: 1, schTitle: "다른 일정" },
    { ...row, schSeq: 2, startDate: "209901011600", endDate: "209901011700" },
    row,
    { ...row, schSeq: 3, startDate: "209901011530" },
    { ...row, schSeq: 4, endDate: "209901011630" }];
  const api = schApi({ write: {}, detail: { ...CREATED, schSeq: 8440 }, rows });
  const out = await create(api, { confirm: true });
  assert.equal(out.sch_seq, 8440);
  assert.deepEqual(api.paths(), ["/schres/sc111A02", "/schres/sc111A05", "/schres/sc111A03", "/schres/sc111A04"]);
  const listed = api.calls[2].body;
  assert.deepEqual([listed.startDate, listed.endDate, listed.mySchYn], ["20990101", "20990101", "N"]);
  assert.deepEqual(listed.calList, [{ mcalSeq: "134", calType: "E", adminYn: "N", color: "#748FFC" }]);
  assert.equal(api.calls[3].body.schSeq, "8440");
});

test("create does not guess among several matching schedules", async () => {
  const row = { schSeq: 8440, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500", endDate: "209901011600" };
  const api = schApi({ write: {}, detail: CREATED, rows: [row, { ...row, schSeq: 8441 }] });
  await assert.rejects(create(api, { confirm: true }), rejectsWith(/^일정 등록 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
  assert.equal(count(api, "sc111A04"), 0);   // no single id, nothing to read back
});

for (const [id, write, detail] of [
  ["start-differs", { schSeq: 8439 }, { ...CREATED, startDate: "209901011530" }],
  ["end-differs", { schSeq: 8439 }, { ...CREATED, endDate: "209901011630" }],
  ["title-differs", { schSeq: 8439 }, { ...CREATED, schTitle: "다른 일정" }],
  ["calendar-differs", { schSeq: 8439 }, { ...CREATED, mcalSeq: 35 }],
  ["id-not-found", {}, CREATED],
  ["read-back-empty", { schSeq: 8439 }, null]]) {
  test(`create reports a result it cannot confirm: ${id}`, async () => {
    const api = schApi({ write, detail });
    await assert.rejects(create(api, { confirm: true }), rejectsWith(/일정 등록 결과를 확인하지 못했습니다.*\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "sc111A05"), 1);
  });
}

for (const [id, fail] of [["session-dropped", unauthorized], ["timeout", timesOut]]) {
  test(`create reports a failed check after the write as unconfirmed: ${id}`, async () => {
    // the read-back fails right after the write
    const api = schApi({ write: { schSeq: 8439 }, detail: CREATED, fail: (path) => (path.endsWith("sc111A04") ? fail() : undefined) });
    // a GroupwareError, not the raw failure: a SessionError would make the caller log in again and
    // write again, and a timeout would not say that the write went out
    await assert.rejects(create(api, { confirm: true }),
      rejectsWith(/^일정 등록 결과를 확인하지 못했습니다\(sch_seq 8439\)\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "sc111A05"), 1);
  });
}

for (const [id, cals, match] of [
  ["none", [], /찾지 못했습니다/],
  ["read-only", [{ ...WRITE_CALS[0], calRwGbn: "r" }, WRITE_CALS[1]], /찾지 못했습니다/],
  ["two-of-mine", [WRITE_CALS[0], { ...WRITE_CALS[0], mcalSeq: 135 }], /여러 개/]]) {
  test(`create needs one writable personal calendar: ${id}`, async () => {
    const api = schApi({ cals });
    await assert.rejects(create(api, { confirm: true }), rejectsWith(match));
    assert.equal(count(api, "sc111A05"), 0);
  });
}

test("create picks my own among several writable personal calendars", async () => {
  const cals = [{ ...WRITE_CALS[0], mcalSeq: 200, empSeq: "E9", calTitle: "남의 일정" }, WRITE_CALS[0]];
  assert.equal((await create(schApi({ cals }))).calendar, "내 일정");
});

for (const [id, args, check] of [
  ["blank-title", { title: "  " }, rejectsWith(/제목이 비어 있습니다/)],
  ["end-first", { start: SCH_END, end: SCH_START }, rejectsWith(/종료 시각/)],
  ["zero-length", { end: SCH_START }, rejectsWith(/종료 시각/)],
  ["no-time", { start: "2099-01-01" }, (e) => !(e instanceof GroupwareError) && /YYYY-MM-DD HH:MM/.test(e.message)]]) {
  test(`create rejects bad input before sending: ${id}`, async () => {
    const api = schApi();
    await assert.rejects(create(api, args), check);
    assert.deepEqual(api.calls, []);
  });
}

for (const entry of ["김민수", "박없음"]) {
  test(`create writes nothing when an attendee is not one person: ${entry}`, async () => {
    const api = schApi({ people: [KIM_DEV, KIM_HR] });
    await assert.rejects(create(api, { attendees: [entry], confirm: true }), GroupwareError);
    assert.equal(count(api, "sc111A05"), 0);
  });
}

for (const confirm of [undefined, ...NOT_TRUE]) {
  test(`create: a memo with confirm ${JSON.stringify(confirm)} only previews`, async () => {
    const api = schApi();
    const out = await create(api, { memo: "안건", confirm });
    assert.equal(out.created, undefined);
    assert.deepEqual(api.paths(), ["/schres/sc111A02"]);
  });
}

for (const [id, fail, check] of [
  ["timeout", timesOut, rejectsWith(/^일정 등록 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/)],
  // fetch's own text can echo the Authorization header, token included
  ["protocol-error", () => { throw new TypeError("Illegal header value b'Bearer G1|E1|TOKEN-SECRET'"); },
    rejectsWith(/^일정 등록 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/)],
  ["refused-by-api", () => new Response(JSON.stringify({ resultCode: 114, resultMsg: "필수 값 누락" })),
    rejectsWith(/필수 값 누락 그룹웨어에서 확인해 주세요\.$/)],
  ["empty-body", () => new Response(""), rejectsWith(/empty response.* 그룹웨어에서 확인해 주세요\.$/)],
  // the call never ran, so the caller's one re-login may send it: it must stay a SessionError
  ["session-refused", unauthorized, (e) => e instanceof SessionError && /HTTP 401/.test(e.message)]]) {
  test(`create: the one write call ending unclear says to check the groupware: ${id}`, async () => {
    const api = schApi({ write: { schSeq: 8439 }, detail: CREATED, fail: (path) => (path.endsWith("sc111A05") ? fail() : undefined) });
    let raised;
    await assert.rejects(create(api, { confirm: true }), (e) => { raised = e; return check(e); });
    assert.equal(count(api, "sc111A05"), 1);   // sent once, never retried
    assert.equal(count(api, "sc111A04"), 0);   // an unanswered write is not read back
    // whatever logs the error prints its whole chain: the header text must not ride along
    assert.equal(raised.cause, undefined);
    assert.ok(!String(raised.stack).includes("SECRET"));
  });
}

const CHANGED = { ...CREATED, schTitle: "주간회의(변경)", startDate: "209901011600", endDate: "209901011700" };
const update = (api, args = {}) => updateSchedule(RES, { sch_seq: 8439, ...args }, { fetch: api.fetch });

test("update: a preview shows before and after and writes nothing", async () => {
  const api = schApi({ detail: CREATED });
  const out = await update(api, { sch_seq: "8439", start: "2099-01-01 16:00", end: "2099-01-01 17:00" });
  assert.deepEqual(out, { sch_seq: 8439,
    before: { title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00" },
    after: { title: "주간회의", start: "2099-01-01 16:00", end: "2099-01-01 17:00" } });
  assert.deepEqual(api.paths(), ["/schres/sc111A04", "/schres/sc111A02"]);
  assert.deepEqual(api.calls[0].body, { companyInfo: COMPANY, schSeq: "8439", tcalSeq: "", langCode: "kr" });
});

test("update: confirm sends the stored schedule with the change", async () => {
  const api = schApi({ detail: until("sc111A05", CREATED, CHANGED), write: {} });
  const out = await update(api, { title: "주간회의(변경)", start: "2099-01-01 16:00", end: "2099-01-01 17:00", confirm: true });
  assert.deepEqual(api.paths(), ["/schres/sc111A04", "/schres/sc111A02", "/schres/sc111A05", "/schres/sc111A04"]);
  assert.deepEqual(api.calls.filter((c) => c.path.endsWith("sc111A04")).map((c) => c.body.schSeq), ["8439", "8439"]);
  // updateSchedule: the stored detail goes back whole, with these fields set
  assert.deepEqual(api.calls[2].body, { ...CREATED, companyInfo: COMPANY, langCode: "kr",
    schSeq: "8439", schmSeq: "8439", mcalSeq: "134", schTitle: "주간회의(변경)",
    startDate: "209901011600", endDate: "209901011700", contents: "", alldayYn: "N", lunarYn: "N",
    alarm_yn: "N", gbnCode: "E", calType: "E", schGbnCode: "10", repeatType: "10", rangeCode: "UO",
    resList: [], reservedList: [], schAlarmList: [], schUserList: [], schPartEmpList: [],
    addressUserList: [], delFileList: [], uidList: "", empSeq: "E1", groupSeq: "G1",
    alarmOnModify: false, mailSend: "N" });
  assert.equal(api.calls[2].body.fileCnt, 0);   // fields it does not set ride along from the detail
  assert.deepEqual(out, { sch_seq: 8439, updated: true,
    after: { title: "주간회의(변경)", start: "2099-01-01 16:00", end: "2099-01-01 17:00" } });
});

test("update keeps what it is not given", async () => {
  const detail = { ...CREATED, schPartEmpList: [{ empSeq: "E1" }] };   // only me: still plain
  const out = await update(schApi({ detail }), { title: "이름만" });
  assert.deepEqual(out.after, { title: "이름만", start: "2099-01-01 15:00", end: "2099-01-01 16:00" });
});

for (const [id, args] of [["start-past-the-kept-end", { start: "2099-01-01 17:00" }],
  ["zero-length", { end: SCH_START }]]) {   // the kept start
  test(`update refuses an end not after the start: ${id}`, async () => {
    const api = schApi({ detail: CREATED });
    await assert.rejects(update(api, { ...args, confirm: true }), rejectsWith(/종료 시각/));
    assert.equal(count(api, "sc111A05"), 0);
  });
}

const NOT_PLAIN = [
  ["other-calendar", { mcalSeq: 35 }, /내 개인 캘린더/],
  ["repeating", { repeatType: "40" }, /반복/],
  ["repeat-missing", { repeatType: null }, /반복/],
  ["repeat-absent", { repeatType: undefined }, /반복/],
  ["no-schm-seq", { schmSeq: null }, /찾지 못했습니다/],
  ["no-end", { endDate: "" }, /찾지 못했습니다/],
  ["resource", { resList: [{ resSeq: "12" }] }, /자원/],
  ["reserved", { reservedList: [{ resSeq: "12" }] }, /자원/],
  ["resources-key", { resources: [{ resSeq: "12" }] }, /자원/],
  ["external", { addressUserList: [{ email: "x@example.com" }] }, /외부 참석자/],
  ["others-invited", { schPartEmpList: [{ empSeq: "E1" }, { empSeq: "E7" }] }, /다른 참석자/],
  ["others-by-org-seq", { schPartEmpList: [{ orgSeq: "E7" }] }, /다른 참석자/],
  ["module", { schModuleGbn: "EA", schModuleSeq: "77" }, /외부 모듈/],
  ["module-gbn-only", { schModuleGbn: "EA" }, /외부 모듈/],
  ["module-seq-only", { schModuleSeq: "77" }, /외부 모듈/],
  ["file-list", { fileList: [{ fileId: "f" }] }, /첨부/],
  ["file-count", { fileCnt: "1" }, /첨부/],
  ["all-day", { alldayYn: "Y" }, /종일/]];

for (const [id, change, match] of NOT_PLAIN) {
  test(`update leaves all but a plain schedule of mine alone: ${id}`, async () => {
    const detail = JSON.parse(JSON.stringify({ ...CREATED, ...change }));   // as it comes off the wire
    const api = schApi({ detail });
    await assert.rejects(update(api, { title: "x", confirm: true }), rejectsWith(match));
    assert.equal(count(api, "sc111A05"), 0);
  });
}

test("update: I alone as a participant by org seq is still plain", async () => {
  const out = await update(schApi({ detail: { ...CREATED, schPartEmpList: [{ orgSeq: "E1" }] } }), { title: "x" });
  assert.equal(out.after.title, "x");
});

test("update reports a change it cannot read back", async () => {
  await assert.rejects(update(schApi({ detail: CREATED, write: {} }), { title: "바뀌지 않음", confirm: true }),
    rejectsWith(/^일정 수정 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
});

for (const [id, args, check] of [
  ["nothing-to-change", {}, rejectsWith(/바꿀 값/)],
  ["blank-title", { title: "  " }, rejectsWith(/비울 수 없습니다/)],
  ["no-time", { start: "2099-01-01" }, (e) => !(e instanceof GroupwareError) && /YYYY-MM-DD HH:MM/.test(e.message)]]) {
  test(`update rejects bad input before sending: ${id}`, async () => {
    const api = schApi({ detail: CREATED });
    await assert.rejects(update(api, args), check);
    assert.deepEqual(api.calls, []);
  });
}

test("update: an unknown id is reported", async () => {
  await assert.rejects(update(schApi({ detail: null }), { sch_seq: 1, title: "x" }), rejectsWith(/일정 1을\(를\) 찾지 못했습니다/));
});

for (const confirm of [undefined, ...NOT_TRUE]) {
  test(`update: confirm ${JSON.stringify(confirm)} only previews`, async () => {
    const api = schApi({ detail: CREATED });
    const out = await update(api, { title: "t", confirm });
    assert.equal(out.updated, undefined);
    assert.equal(count(api, "sc111A05"), 0);
  });
}

for (const id of ["write-timeout", "check-session-dropped", "check-timeout"]) {
  test(`update reports an unclear write as unconfirmed: ${id}`, async () => {
    const fail = (path, calls) => {
      if (path.endsWith("sc111A05") && id === "write-timeout") timesOut();
      const wrote = calls.some((c) => c.path.endsWith("sc111A05"));
      if (path.endsWith("sc111A04") && id !== "write-timeout" && wrote) {   // only the check after the write
        return id === "check-timeout" ? timesOut() : unauthorized();
      }
      return undefined;
    };
    const api = schApi({ detail: CREATED, write: {}, fail });
    // never a SessionError: the caller would log in again and write again
    await assert.rejects(update(api, { title: "x", confirm: true }),
      rejectsWith(/^일정 수정 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "sc111A05"), 1);
  });
}

for (const [id, wrong] of [["start-differs", { startDate: "209901011630" }],
  ["end-differs", { endDate: "209901011730" }], ["title-differs", { schTitle: "다른 제목" }]]) {
  test(`update reports a read-back that differs in any one field: ${id}`, async () => {
    const api = schApi({ detail: until("sc111A05", CREATED, { ...CHANGED, ...wrong }), write: {} });
    await assert.rejects(update(api, { title: "주간회의(변경)", start: "2099-01-01 16:00", end: "2099-01-01 17:00", confirm: true }),
      rejectsWith(/그룹웨어에서 확인해 주세요/));
  });
}

test("update trims the new title", async () => {
  assert.equal((await update(schApi({ detail: CREATED }), { title: " 이름만 " })).after.title, "이름만");
});

test("update sends back what it does not change", async () => {
  const detail = { ...CREATED, schmSeq: 8000, contents: "안건", lunarYn: "Y", schGbnCode: "20",
    schAlarmList: [{ alarmTime: "10" }],
    schPartEmpList: [{ empSeq: "E1", compSeq: "1000" }],
    schUserList: [{ userType: "10", empSeq: "E1" }, { userType: "30", empSeq: "E9" }] };
  const api = schApi({ write: {}, detail: until("sc111A05", detail, { ...detail, schTitle: "x" }) });
  await update(api, { title: "x", confirm: true });
  const body = api.calls[2].body;
  assert.deepEqual([body.schmSeq, body.contents, body.lunarYn, body.schGbnCode], ["8000", "안건", "Y", "20"]);   // schmSeq is the detail's own
  assert.deepEqual(body.schAlarmList, [{ alarmTime: "10" }]);
  assert.deepEqual(body.schPartEmpList, [{ empSeq: "E1", compSeq: "1000" }]);
  assert.deepEqual(body.schUserList, [{ userType: "10", empSeq: "E1" }]);   // userType 30 left out
});

test("update takes gbnCode and calType from the calendar when missing", async () => {
  const { gbnCode, calType, ...detail } = CREATED;
  const api = schApi({ write: {}, detail: until("sc111A05", detail, { ...detail, schTitle: "x" }) });
  await update(api, { title: "x", confirm: true });
  assert.deepEqual([api.calls[2].body.gbnCode, api.calls[2].body.calType], ["E", "E"]);
});

test("update keeps a reminder set in the groupware", async () => {
  // the flag follows the reminders: "N" beside a filled list may make the server drop it
  const alarm = { alarmType: "20", alarmTimeDiv: "30", alarmTimeUnit: "", alarmUnitValue: "" };
  const detail = { ...CREATED, schAlarmList: [alarm] };
  const api = schApi({ write: {}, detail: until("sc111A05", detail, { ...detail, schTitle: "x" }) });
  await update(api, { title: "x", confirm: true });
  assert.deepEqual([api.calls[2].body.alarm_yn, api.calls[2].body.schAlarmList], ["Y", [alarm]]);
});

const LISTED = { schSeq: 8439, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500", endDate: "209901011600" };
const remove = (api, args = {}) => deleteSchedule(RES, { sch_seq: 8439, ...args }, { fetch: api.fetch });

test("delete: a preview names the schedule and deletes nothing", async () => {
  const api = schApi({ detail: CREATED });
  const out = await remove(api, { sch_seq: "8439" });
  assert.deepEqual(out, { sch_seq: 8439, title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00" });
  assert.deepEqual(api.paths(), ["/schres/sc111A04", "/schres/sc111A02"]);
});

test("delete: confirm sends the three ids and checks it is gone", async () => {
  const api = schApi({ detail: CREATED, rows: until("sc111A06", [LISTED], []) });
  const out = await remove(api, { confirm: true });
  assert.deepEqual(out, { sch_seq: 8439, title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00", deleted: true });
  assert.deepEqual(api.paths(), ["/schres/sc111A04", "/schres/sc111A02", "/schres/sc111A06", "/schres/sc111A03"]);
  // like the web client, the delete carries no companyInfo
  assert.deepEqual(api.calls[2].body, { mcalSeq: "134", schmSeq: "8439", schSeq: "8439", rangeCode: "", langCode: "kr" });
  const listed = api.calls[3].body;
  assert.deepEqual([listed.startDate, listed.endDate], ["20990101", "20990101"]);
  assert.deepEqual(listed.calList.map((x) => x.mcalSeq), ["134"]);
});

test("delete reports a schedule still listed after the delete", async () => {
  await assert.rejects(remove(schApi({ detail: CREATED, rows: [LISTED] }), { confirm: true }),
    rejectsWith(/^삭제 뒤에도 일정이 남아 있습니다\. 그룹웨어에서 확인해 주세요\.$/));
});

for (const [id, change, match] of [
  ["repeating", { repeatType: "20" }, /반복/],
  ["resource", { resList: [{ resSeq: "12" }] }, /자원/],
  ["external", { addressUserList: [{ email: "x@example.com" }] }, /외부 참석자/],
  ["others-invited", { schPartEmpList: [{ empSeq: "E7" }] }, /다른 참석자/],
  ["files", { fileCnt: 2 }, /첨부/],
  ["other-calendar", { mcalSeq: 35 }, /내 개인 캘린더/]]) {
  test(`delete leaves all but a plain schedule of mine alone: ${id}`, async () => {
    const api = schApi({ detail: { ...CREATED, ...change } });
    await assert.rejects(remove(api, { confirm: true }), rejectsWith(match));
    assert.equal(count(api, "sc111A06"), 0);
  });
}

for (const confirm of [undefined, ...NOT_TRUE]) {
  test(`delete: confirm ${JSON.stringify(confirm)} only previews`, async () => {
    const api = schApi({ detail: CREATED });
    assert.equal((await remove(api, { confirm })).deleted, undefined);
    assert.equal(count(api, "sc111A06"), 0);
  });
}

for (const id of ["delete-timeout", "check-session-dropped", "check-timeout"]) {
  test(`delete reports an unclear delete as unconfirmed: ${id}`, async () => {
    const fail = (path) => {
      if (path.endsWith("sc111A06") && id === "delete-timeout") timesOut();
      if (path.endsWith("sc111A03") && id !== "delete-timeout") {   // sc111A03 runs only after the delete
        return id === "check-timeout" ? timesOut() : unauthorized();
      }
      return undefined;
    };
    const api = schApi({ detail: CREATED, rows: [], fail });
    // never a SessionError: the caller would log in again and delete again
    await assert.rejects(remove(api, { confirm: true }),
      rejectsWith(/^일정 삭제 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "sc111A06"), 1);
  });
}

// a listing that answers anything but a dict holding a list of dicts must not read as "gone":
// Python raises on it inside the check, and the check answers "unconfirmed"
const NOT_A_LISTING = [["bare-list", [LISTED]], ["true", true], ["string", "still-there"], ["number", 1],
  ["list-field-a-dict", { resultList: { schSeq: 8439 } }], ["null-row", { resultList: [null] }],
  ["string-row", { resultList: ["8439"] }]];

for (const [id, garbage] of NOT_A_LISTING) {
  test(`delete: a read-back listing that is not a list of rows is unconfirmed: ${id}`, async () => {
    const api = schApi({ detail: CREATED, fail: (path) => (path.endsWith("sc111A03") ? garbage : undefined) });
    await assert.rejects(remove(api, { confirm: true }),
      rejectsWith(/^일정 삭제 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "sc111A06"), 1);
  });
}

for (const [id, empty] of [["null", null], ["empty-dict", {}], ["empty-list", []], ["field-null", { resultList: null }],
  ["field-empty-dict", { resultList: {} }]]) {
  test(`delete: an empty read-back listing means gone, as in Python: ${id}`, async () => {
    const api = schApi({ detail: CREATED, fail: (path) => (path.endsWith("sc111A03") ? empty : undefined) });
    assert.equal((await remove(api, { confirm: true })).deleted, true);
  });
}

for (const [id, garbage] of [["bare-list", [CANCEL_ROW]], ["true", true], ["string-row", { resultList: ["x"] }],
  ["null-row", { resultList: [null] }]]) {
  test(`cancel: a read-back listing that is not a list of rows is unconfirmed: ${id}`, async () => {
    const api = cancelApi([CANCEL_ROW], { check: () => garbage });
    await assert.rejects(cancel(api, { confirm: true }), rejectsWith(/^취소 결과를 확인하지 못했습니다\. 그룹웨어에서 확인해 주세요\.$/));
    assert.equal(count(api, "rs121A11"), 1);
  });
}

// ---- mail
const MAILER = { ...RES, user: { ...RES.user, email: "hong@example.com" } };
const SETUP = { email: "hong@example.com", mail_from: ["hong@example.com"], userInfo: {},
  userFromNameList: [{ userName: "다른이름", isDefault: false }, { userName: "홍길동", isDefault: true }],
  filedir: "/data/f1", sessionKey: "SK-1", bigFileDay: "30", externalSendLimit: "N", "insideDomainArray[]": ["example.com"],
  groupMailOption: { groupMailAddr: "", groupMailIntedAddr: "", groupMailOrg: "" }, representInfo: [], sharedList: [],
  useLimit: 0, recvSendRestiction: 0, mailboxPercent: "3", capacityLimit: "0" };
const reply = (resultCode, resultMsg = "") => new Response(JSON.stringify({ resultCode, resultMsg, resultData: {} }));
const FOLDER_LIST = { mailboxList: [{ mboxSeq: 2089, name: "INBOX" }, { mboxSeq: 2095, name: "TRASH" }] };

function mailApi({ setup = SETUP, send = () => reply(0), write = () => ({}) } = {}) {
  return fake((path) => {
    if (path.endsWith("mail014A01")) return setup;
    if (path.endsWith("mail014A04")) return send();
    if (path.endsWith("mail000A01")) return FOLDER_LIST;
    return write();
  });
}
const sendTo = (api, args = {}, opts = {}) => sendMail(MAILER, { to: ["a@example.com", "김민수 <kim@example.com>"],
  subject: " 보고 ", body: "안녕\n<b>하세요</b>", ...args }, { fetch: api.fetch, now: () => new Date(2026, 9, 27, 15), ...opts });

test("send: a preview shows the mail and sends nothing", async () => {
  const api = mailApi();
  for (const confirm of [false, ...NOT_TRUE]) {
    assert.deepEqual(await sendTo(api, { confirm }), { from: "홍길동 <hong@example.com>",
      to: ["a@example.com", "김민수 <kim@example.com>"], cc: [], bcc: [], subject: "보고", body: "안녕\n<b>하세요</b>" });
  }
  assert.equal(count(api, "mail014A04"), 0);
});

test("send: confirm posts the compose form once, as the web client fills it", async () => {
  const api = mailApi();
  assert.equal((await sendTo(api, { cc: ["lee@example.com"], confirm: true })).sent, true);
  assert.equal(count(api, "mail014A04"), 1);
  assert.deepEqual(bodyOf(api, "mail014A01"), { mailKind: "plain", mailTo: "", uid: "", mbox: "", viewFlag: "noRead",
    fromFlag: false, readType: "", domainSeq: "" });
  const form = bodyOf(api, "mail014A04");
  assert.deepEqual(Object.keys(form), ["from", "fromName", "to", "cc", "bcc", "htmlContents", "email", "fileDir", "bigFile",
    "bigFileDay", "bigFileCnt", "bigFilePeriod", "mail_kind", "uidAuthList", "fwFile", "urlList", "fileNameList",
    "receipt_notific", "securitymailuse", "securitymailpass_enc_web", "immediately", "toBeDeleted", "expirationDate",
    "importantmailuse", "eachTrans", "neobizaddr", "neobizIntedAddr", "neobizOrg", "muid", "domainSeq", "mimeHeader",
    "sessionKey", "externalSendLimit", "insideDomainArray", "aiResultJSON", "subject", "authToken"]);
  assert.deepEqual([form.from, form.fromName, form.to, form.cc, form.bcc],
    ["hong@example.com", "홍길동", "a@example.com,김민수<kim@example.com>", "lee@example.com", ""]);
  assert.equal(form.htmlContents, "안녕<br>&lt;b&gt;하세요&lt;/b&gt;");
  assert.deepEqual([form.subject, form.mail_kind, form.fileDir, form.sessionKey, form.insideDomainArray],
    ["보고", "plain", "/data/f1", "SK-1", '["example.com"]']);
  assert.deepEqual([form.bigFilePeriod, form.expirationDate], ["2026-10-27 ~ 2026-11-26", "2026-10-27 00:00"]);
  assert.equal(form.authToken, "hong@example.com|G1|E1|R1");
});

test("send: cc and bcc skip an address already in to or cc", async () => {
  const api = mailApi();
  const out = await sendTo(api, { to: ["a@example.com"], cc: ["A@example.com", "b@example.com"],
    bcc: ["b@example.com", "c@example.com"] });
  assert.deepEqual([out.cc, out.bcc], [["b@example.com"], ["c@example.com"]]);
});

test("send: the user's sender, receipt and each-recipient settings are kept", async () => {
  const setup = { ...SETUP, mail_from: ["hong@example.com", "team@example.com"], representInfo: ["team@example.com"],
    userInfo: { defaultuser: "team@example.com", receiveconfirm: "0", eachtrans: "0" } };
  const api = mailApi({ setup });
  assert.equal((await sendTo(api)).from, "team@example.com");   // a representative address has no own name
  await sendTo(api, { confirm: true });
  const form = bodyOf(api, "mail014A04");
  assert.deepEqual([form.from, form.fromName, form.receipt_notific, form.eachTrans], ["team@example.com", "", "1", "1"]);
});

test("send: bad addresses, no recipient or no subject stop before the network", async () => {
  for (const args of [{ to: ["kim"] }, { to: ["a@example.com, b@example.com"] }, { to: [] }, { cc: ["x@y"] },
    { subject: "  " }]) {
    const api = mailApi();
    await assert.rejects(sendTo(api, { ...args, confirm: true }), GroupwareError);
    assert.equal(api.calls.length, 0);
  }
});

test("send: an account without a sender or with sending limited is refused before the send", async () => {
  for (const setup of [{ ...SETUP, email: "" }, { ...SETUP, mail_from: [] }, { ...SETUP, useLimit: 1 },
    { ...SETUP, recvSendRestiction: "3" }, { ...SETUP, mailboxPercent: "120", capacityLimit: "1" }]) {
    const api = mailApi({ setup });
    await assert.rejects(sendTo(api, { confirm: true }), GroupwareError);
    assert.equal(count(api, "mail014A04"), 0);
  }
});

test("send: resultCode 1 is sent, with the addresses the external limit left out", async () => {
  const out = await sendTo(mailApi({ send: () => reply(1, "x@other.com") }), { confirm: true });
  assert.deepEqual([out.sent, out.left_out], [true, "x@other.com"]);
});

test("send: an unclear send is reported, never retried", async () => {
  for (const send of [() => reply(-2, "발송 실패"), timesOut, () => reply(999)]) {
    const api = mailApi({ send });
    await assert.rejects(sendTo(api, { confirm: true }), rejectsWith(/확인하지 못했습니다|확인해 주세요/));
    assert.equal(count(api, "mail014A04"), 1);
  }
});

test("send: a send refused for the session stays a SessionError (it never ran)", async () => {
  await assert.rejects(sendTo(mailApi({ send: unauthorized }), { confirm: true }), SessionError);
});

test("delete mail: a preview names the folder and moves nothing; confirm moves them to the trash once", async () => {
  const api = mailApi();
  assert.deepEqual(await deleteMail(MAILER, { muids: [9, "10", 9], box: "inbox" }, { fetch: api.fetch }),
    { box: "INBOX", muids: ["9", "10"] });
  assert.equal(count(api, "mail002A05"), 0);
  const out = await deleteMail(MAILER, { muids: [9, "10"], box: "INBOX", confirm: true }, { fetch: api.fetch });
  assert.equal(out.trashed, true);
  assert.equal(count(api, "mail002A05"), 1);
  assert.deepEqual(bodyOf(api, "mail002A05"), { uids: "9,10", mailKey: "", boxName: "INBOX" });
});

test("delete mail: the trash, spam, a scheduled send or an unknown folder is refused", async () => {
  for (const box of ["TRASH", "spam", "RESERVATION", "ALL", "없는함"]) {
    const api = mailApi();
    await assert.rejects(deleteMail(MAILER, { muids: [9], box, confirm: true }, { fetch: api.fetch }), GroupwareError);
    assert.equal(count(api, "mail002A05"), 0);
  }
});

test("muids must be 1 to 50 mail numbers", async () => {
  for (const muids of [[], ["9,10"], ["x"], null, Array.from({ length: 51 }, (_, i) => i + 1)]) {
    const api = mailApi();
    await assert.rejects(markMail(MAILER, { muids }, { fetch: api.fetch }), GroupwareError);
    await assert.rejects(deleteMail(MAILER, { muids, confirm: true }, { fetch: api.fetch }), GroupwareError);
    assert.equal(api.calls.length, 0);
  }
});

test("mark: unread by default, read when asked, in the mail's folder", async () => {
  const api = mailApi();
  assert.deepEqual(await markMail(MAILER, { muids: [9, 10], box: "INBOX" }, { fetch: api.fetch }),
    { box: "INBOX", muids: ["9", "10"], unread: true });
  assert.deepEqual(bodyOf(api, "mail002A15"), { mbox: "INBOX", uids: "9,10", type: "unseen" });
  await markMail(MAILER, { muids: [9], box: "INBOX", read: true }, { fetch: api.fetch });
  assert.deepEqual(api.calls.filter((c) => c.path.endsWith("mail002A15")).map((c) => c.body.type), ["unseen", "seen"]);
});
