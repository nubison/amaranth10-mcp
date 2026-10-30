// the writes: previews write nothing, one write with the stored ids, fail-closed guards, and read-backs
// that never repeat a write
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupwareError, SessionError } from "../src/client.js";
import { cancelLeave, cancelReservation, createSchedule, deleteMail, deleteSchedule, fillBody, markMail, requestLeave,
  reserveResource, sendMail, updateReservation, updateSchedule } from "../src/write.js";

const S = { base: "https://gw.example.com", token: "G1|E1|R1", signKey: "test-sign-key",
  user: { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", empSeq: "E1", email: "hong@example.com", erpCoCd: "1000",
    erpEmpCd: "123" } };
const COMPANY = { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", emailAddr: "", emailDomain: "" };

// one fake groupware: handler(path, body, calls) gives the resultData, or a whole Response, or throws
function fake(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname: path, search } = new URL(url);
    const body = init.body === undefined ? null   // a GET
      : init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
    calls.push({ path, body, query: search });
    const out = handler(path, body, calls);
    return out instanceof Response ? out : new Response(JSON.stringify({ resultCode: 0, resultData: out ?? null }));
  };
  return { fetch, calls, paths: () => calls.map((c) => c.path) };
}
const bodyOf = (api, code) => api.calls.find((c) => c.path.endsWith(code))?.body;
// the calls that change something, by the last part of their path
const WRITE = new RegExp("/(rs121A06|rs121A11|rs121A12|sc111A05|sc111A06|mail014A04|mail002A05|mail002A15|create|GetLinkKey"
  + "|SetEnageGroup|saveLinkKey|eap110A06|deleteSubmittedApplicationList|eap110A20|eap107A25)$");
const writes = (api) => api.paths().filter((p) => WRITE.test(p)).map((p) => p.split("/").pop());
const timesOut = () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); };
const unauthorized = () => new Response("", { status: 401 });
const on = (code, fail) => (path) => (path.endsWith(code) ? fail() : undefined);
const rejectsWith = (re) => (e) => e instanceof GroupwareError && re.test(e.message);
const check = (c) => (c instanceof RegExp ? rejectsWith(c) : c);
const UNSURE = (what) => new RegExp(`^${what} 결과를 확인하지 못했습니다\\. 그룹웨어에서 확인해 주세요\\.$`);
const BAD_TIME = (e) => !(e instanceof GroupwareError) && /YYYY-MM-DD HH:MM/.test(e.message);

// [args, fake options, expected error]: each refused with confirm true, nothing written
async function refuses(makeApi, call, cases) {
  for (const [args, opts, expected] of cases) {
    const api = makeApi(opts);
    await assert.rejects(call(api, { ...args, confirm: true }), check(expected), JSON.stringify([args, opts]));
    assert.deepEqual(writes(api), []);
  }
}
// [fake options, expected error]: the write went out once and was never repeated
async function unclear(makeApi, call, write, cases) {
  for (const [opts, expected] of cases) {
    const api = makeApi(opts);
    await assert.rejects(call(api), check(expected), JSON.stringify(opts));
    assert.deepEqual(writes(api), [write]);
  }
}

const ME = { empSeq: "E1", empName: "홍길동", deptSeq: "D1", deptName: "개발팀", compSeq: "1000" };
const KIM_DEV = { empSeq: "E7", empName: "김민수", deptSeq: "D2", deptName: "개발팀", compSeq: "1000" };
const KIM_HR = { ...KIM_DEV, empSeq: "E8", deptSeq: "D3", deptName: "인사팀" };
const searchIn = (body) => [ME, KIM_DEV, KIM_HR].filter((x) => x.empName.includes(body.searchText));

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

// ---- resource_reserve
const START = "2099-01-01 14:00", END = "2099-01-01 15:00";

function resApi({ reservationYn = "N", limitYn = "N", resSeq = "7", day = null, apprYn = "N", write = () => ({ successTf: 1 }) } = {}) {
  return fake((path, body) => {
    if (path.endsWith("gw102A04")) return searchIn(body);
    if (path.endsWith("rs121A01")) return { resultList: [{ resSeq, resName: "회의실 A", apprYn }] };
    if (path.endsWith("rs121A04")) return { reservationYn, limitYn };
    if (path.endsWith("rs121A05")) return { resultList: day ?? [{ ...ROW, resSeq, reqText: "회의" }] };
    return path.endsWith("rs121A06") ? write() : {};
  });
}
const reserve = (api, args = {}) =>
  reserveResource(S, { res_seq: "7", start: START, end: END, title: "회의", ...args }, { fetch: api.fetch });

test("reserve: a preview checks the slot; confirm books me, then each attendee once, under the API's own id", async () => {
  const api = resApi({ resSeq: 7 });
  const args = { attendees: ["홍길동", "김민수 개발", "김민수 개발"], description: "안건" };
  const preview = { resource: "회의실 A", start: START, end: END, available: true, approval_required: false,
    attendees: ["홍길동 (개발팀)", "김민수 (개발팀)"] };
  assert.deepEqual(await reserve(api, args), preview);
  assert.deepEqual(writes(api), []);
  assert.deepEqual(await reserve(api, { ...args, confirm: true }), { ...preview, reserved: true,
    link: "https://gw.example.com/#/popup?MicroModuleCode=schres&callComp=UKAP002&seqNum=11735&resSeq=7" });
  assert.deepEqual(bodyOf(api, "rs121A04"), { companyInfo: COMPANY, resSeq: 7, startDate: "209901011400",
    endDate: "209901011500", alldayYn: "N", resStartDate: "20990101" });
  // the search result has no groupSeq: the booker's own fills it
  assert.deepEqual(bodyOf(api, "rs121A06"), { companyInfo: COMPANY, langCode: "kr", resSeq: 7, reqText: "회의",
    apprYn: "N", alldayYn: "N", startDate: "209901011400", endDate: "209901011500", descText: "안건",
    resSubscriberList: [{ groupSeq: "G1", compSeq: "1000", deptSeq: "D1", empSeq: "E1" },
      { groupSeq: "G1", compSeq: "1000", deptSeq: "D2", empSeq: "E7" }],
    uidList: "", repeatType: "10", repeatEndDay: "" });
  assert.deepEqual(writes(api), ["rs121A06"]);
});

test("reserve: refusals write nothing", () => refuses(resApi, reserve, [
  [{ start: END, end: START }, {}, /종료 시각이 시작 시각보다 빠릅니다/],
  [{ start: "2000-01-01 14:00", end: "2000-01-01 15:00" }, {}, /이미 지났습니다/],
  [{ res_seq: "99" }, {}, /자원 99을\(를\) 찾을 수 없습니다/],
  [{ attendees: ["김민수"] }, {}, /후보/],
  [{ attendees: ["박없음"] }, {}, /찾지 못했습니다/],
  [{}, { reservationYn: "Y" }, /이미 예약이 있습니다/],
  [{}, { reservationYn: null }, /이미 예약이 있습니다/],   // only an explicit "N" is free
  [{}, { limitYn: "Y" }, /이용 제한/],
  [{}, { limitYn: null }, /이용 제한/],
]));

test("reserve: a taken slot names who holds it, in the preview and the refusal", async () => {
  const day = [{ ...ROW, empName: "김민수", resStartDate: "209901011330", resEndDate: "209901011430" },
    { ...ROW, empName: "박영희", resStartDate: "209901011500", resEndDate: "209901011600" },   // right after it
    { ...ROW, empName: "최영수", resStartDate: "209901011300", resEndDate: "209901011400" },   // right before it
    { ...ROW, empName: "이철수", statusCode: "CA" }];
  const api = resApi({ reservationYn: "Y", day });
  assert.deepEqual((await reserve(api)).conflicts, [{ booker: "김민수", start: "2099-01-01 13:30", end: "2099-01-01 14:30" }]);
  await assert.rejects(reserve(api, { confirm: true }),
    rejectsWith(/^그 시간대에는 이미 예약이 있습니다\(김민수 2099-01-01 13:30~2099-01-01 14:30\)\.$/));
  assert.deepEqual(writes(api), []);
});

test("reserve: a time over the resource's usage limit is refused at the preview", () =>
  assert.rejects(reserve(resApi({ limitYn: "Y" })), /이용 제한/));

test("reserve: success is 1, \"1\" or true; anything else is unconfirmed, sent once", async () => {
  for (const successTf of [1, "1", true]) {
    const api = resApi({ apprYn: "Y", write: () => ({ successTf }) });
    assert.equal((await reserve(api, { confirm: true })).reserved, true);
    assert.equal(bodyOf(api, "rs121A06").apprYn, "Y");
  }
  await unclear(resApi, (api) => reserve(api, { confirm: true }), "rs121A06", [
    ...[0, "0", null].map((successTf) => [{ write: () => ({ successTf }) }, UNSURE("예약")]),
    [{ write: timesOut }, UNSURE("예약")],
    [{ write: () => new Response(JSON.stringify({ resultCode: 114, resultMsg: "중복" })) },
      /^\/schres\/rs121A06: 중복 그룹웨어에서 확인해 주세요\.$/],
    // refused before it ran: the caller's one re-login may send it
    [{ write: unauthorized }, (e) => e instanceof SessionError]]);
});

// ---- resource_cancel
const ROW = { resSeq: "12", seqNum: 11735, resIdx: "1", reqText: "테스트", resStartDate: "209901011400",
  resEndDate: "209901011500", createDate: "20261016103000", schmSeq: "", schSeq: "", resName: "대회의실 회의실",
  alldayYn: "N", empSeq: "E1" };

// answers `before` until the cancel has gone out, then `after`; check() may answer the read-back instead
function cancelApi({ before = [ROW], after = [], write = () => ({ successTf: true }), check: readBack } = {}) {
  return fake((path, _body, calls) => {
    const done = calls.some((c) => c.path.endsWith("rs121A11"));
    if (path.endsWith("rs121A05")) return done && readBack ? readBack() : { resultList: done ? after : before };
    return path.endsWith("rs121A11") ? write() : {};
  });
}
const cancel = (api, args = {}) => cancelReservation(S, { res_seq: "12", start: START, end: END, ...args }, { fetch: api.fetch });

test("resource cancel: a preview finds my one booking; confirm sends it and checks it is gone", async () => {
  const api = cancelApi();
  assert.deepEqual(await cancel(api), { resource: "대회의실 회의실", title: "테스트", start: START, end: END });
  assert.deepEqual(writes(api), []);
  const listed = api.calls[0].body;
  assert.deepEqual([listed.resList, listed.startDate, listed.endDate], [[{ resSeq: "12" }], "20990101", "20990101"]);
  assert.equal((await cancel(api, { res_seq: 12, confirm: true })).cancelled, true);
  assert.deepEqual(bodyOf(api, "rs121A11"), { companyInfo: COMPANY, statusCode: "CA", deleteRangeCode: "UO",
    resSeqList: [{ resSeq: "12", seqNum: 11735, resIdx: "1", reqText: "테스트", startDate: "209901011400",
      endDate: "209901011500", createDate: "20261016103000", schmSeq: "", schSeq: "", resName: "대회의실 회의실",
      alldayYn: "N" }], langCode: "kr" });
  assert.deepEqual(writes(api), ["rs121A11"]);
});

test("resource cancel: refused unless exactly one own booking matches", () => refuses(cancelApi, cancel, [
  [{}, { before: [{ ...ROW, empSeq: "E9" }] }, /취소할 본인 예약을 찾지 못했습니다/],
  [{}, { before: [{ ...ROW, resEndDate: "209901011530" }] }, /찾지 못했습니다/],
  [{}, { before: [ROW, { ...ROW, seqNum: 2 }] }, /여러 건/],
  [{ start: "2099-01-01" }, {}, BAD_TIME],
]));

test("resource cancel: an unclear cancel or check is unconfirmed, never retried", () =>
  unclear(cancelApi, (api) => cancel(api, { confirm: true }), "rs121A11", [
    [{ after: [ROW] }, UNSURE("취소")],
    [{ write: () => ({ successTf: false }) }, UNSURE("취소")],
    [{ write: timesOut }, UNSURE("취소")],
    [{ check: unauthorized }, UNSURE("취소")],   // a SessionError after the cancel would run it again
    [{ check: () => [ROW] }, UNSURE("취소")],   // a listing that is not a list of rows is not "gone"
    [{ write: unauthorized }, (e) => e instanceof SessionError]]));

// ---- resource_update
// an rs121A10 detail of ROW, with the fields the guard reads
const DETAIL = { resSeq: "12", seqNum: 11735, resIdx: "1", reqText: "테스트", resName: "대회의실 회의실",
  startDate: "209901011400", endDate: "209901011500", createDate: "20261016103000", empSeq: "E1", apprYn: "N",
  alldayYn: "N", repeatType: "10", statusCode: "RC", schSeq: "", schmSeq: "", fileList: [], file: [], descText: "안건",
  subscriberList: [{ groupSeq: "G1", compSeq: "1000", deptSeq: "D1", empSeq: "E1", loginId: "hong" },
    { groupSeq: "G1", compSeq: "1000", deptSeq: "D2", empSeq: "E7" }] };
const SELF = { seqNum: 11735, resIdx: "1", statusCode: "RC", limitYn: "N" };

// like the live groupware, rs121A12 books anew under a new seqNum: the day's list then holds the new
// booking, unless back() answers
function updateApi({ detail = {}, used = [SELF], day = [ROW], limitYn = "N", write = () => ({ successTf: 1 }), back } = {}) {
  return fake((path, _body, calls) => {
    const wrote = calls.find((c) => c.path.endsWith("rs121A12"))?.body;
    if (path.endsWith("rs121A05")) {
      if (!wrote) return { resultList: day };
      return back ? back() : { resultList: [{ ...ROW, seqNum: 11736, reqText: wrote.reqText,
        resStartDate: wrote.startDate, resEndDate: wrote.endDate }] };
    }
    if (path.endsWith("rs121A10")) return { ...DETAIL, ...detail };
    if (path.endsWith("rs121A04")) return { reservationYn: "Y", limitYn };   // this booking itself counts as taken
    if (path.endsWith("rs121A14")) return { usedResList: used };
    return path.endsWith("rs121A12") ? write() : {};
  });
}
const resUpdate = (api, args = {}) => updateReservation(S, { res_seq: "12", start: START, end: END, ...args },
  { fetch: api.fetch, now: () => new Date(2026, 9, 28, 12, 0) });

test("resource update: a title-only preview needs no availability check", async () => {
  const api = updateApi();
  assert.deepEqual(await resUpdate(api, { title: "주간회의" }), { resource: "대회의실 회의실",
    before: { title: "테스트", start: START, end: END }, after: { title: "주간회의", start: START, end: END },
    available: true, approval_required: false });
  assert.deepEqual(api.paths(), ["/schres/rs121A05", "/schres/rs121A10"]);
  assert.deepEqual(bodyOf(api, "rs121A10"), { companyInfo: COMPANY, resSeq: "12", seqNum: 11735, langCode: "kr" });
});

test("resource update: confirm sends the web form's body and reads it back", async () => {
  const api = updateApi();
  const out = await resUpdate(api, { new_start: "2099-01-01 14:30", new_end: "2099-01-01 16:00", confirm: true });
  assert.equal(out.updated, true);
  assert.equal(out.link, "https://gw.example.com/#/popup?MicroModuleCode=schres&callComp=UKAP002&seqNum=11736&resSeq=12");
  assert.deepEqual(bodyOf(api, "rs121A14"), { companyInfo: COMPANY, resSeq: "12", startDate: "209901011430",
    endDate: "209901011600", alldayYn: "N", repeatType: "10", repeatEndDay: "20990101", repeatByDay: "" });
  assert.deepEqual(bodyOf(api, "rs121A12"), { companyInfo: COMPANY, langCode: "kr", resSeq: "12", seqNum: 11735,
    resIdx: "1", reqText: "테스트", apprYn: "N", alldayYn: "N", startDatePk: "209901011400",
    createDatePk: "20261016103000", startDate: "209901011430", endDate: "209901011600", descText: "안건",
    resSubscriberList: [{ groupSeq: "G1", compSeq: "1000", deptSeq: "D1", empSeq: "E1" },
      { groupSeq: "G1", compSeq: "1000", deptSeq: "D2", empSeq: "E7" }],
    uidList: "", repeatType: "10", repeatEndDay: "", repeatByDay: "", resName: "대회의실 회의실" });
  assert.deepEqual(writes(api), ["rs121A12"]);
});

test("resource update: another booking in the new time blocks the write", async () => {
  const args = { new_start: "2099-01-01 15:00", new_end: "2099-01-01 16:00" };
  for (const [used, available] of [
    [[SELF], true],
    [[SELF, { ...SELF, seqNum: 2, statusCode: "CA" }], true],
    [[{ ...SELF, seqNum: 2, limitYn: "Y" }], true],   // a usage-limit row, not a booking
    [[SELF, { ...SELF, seqNum: 2 }], false],
    [[{ ...SELF, resIdx: "2" }], false],
    [null, false]]) {   // unreadable
    const api = updateApi({ used });
    assert.equal((await resUpdate(api, args)).available, available);
    if (!available) await assert.rejects(resUpdate(api, { ...args, confirm: true }), rejectsWith(/이미 다른 예약이 있습니다/));
    assert.deepEqual(writes(api), []);
  }
});

test("resource update: a taken new time names who holds it, never this booking", async () => {
  const other = { ...ROW, seqNum: 2, empSeq: "E7", empName: "김민수", resStartDate: "209901011500", resEndDate: "209901011600" };
  const api = updateApi({ used: [SELF, { ...SELF, seqNum: 2 }], day: [ROW, other] });
  const args = { new_start: "2099-01-01 14:30", new_end: "2099-01-01 16:00" };
  assert.deepEqual((await resUpdate(api, args)).conflicts, [{ booker: "김민수", start: "2099-01-01 15:00", end: "2099-01-01 16:00" }]);
  await assert.rejects(resUpdate(api, { ...args, confirm: true }),
    rejectsWith(/이미 다른 예약이 있습니다\(김민수 2099-01-01 15:00~2099-01-01 16:00\)\.$/));
  assert.deepEqual(writes(api), []);
});

test("resource update: refusals write nothing", () => refuses(updateApi, resUpdate, [
  [{}, {}, /바꿀 값/],
  [{ title: "  " }, {}, /비울 수 없습니다/],
  [{ new_end: "2099-01-01 13:00" }, {}, /종료 시각이 시작 시각보다 빠릅니다/],
  [{ title: "x", start: "2026-10-27 14:00", end: "2026-10-27 15:00" }, {}, /이미 끝난 예약입니다/],
  [{ new_start: "2026-10-28 11:00" }, {}, /이미 지났습니다/],
  [{ new_end: "2099-01-01 16:00" }, { limitYn: "Y" }, /이용 제한/],
  [{ new_end: "2099-01-01 16:00" }, { detail: { limitReservationRange: "60" } }, /최대 1시간/],
  ...[[{ empSeq: "E9" }, /본인 예약이 아닙니다/],
    [{ repeatType: "20" }, /반복 예약입니다/],
    [{ alldayYn: "Y" }, /종일 예약입니다/],
    [{ statusCode: "RJ" }, /취소·반려된 예약입니다/],
    [{ apprYn: undefined }, /승인 여부/],
    [{ schSeq: "88" }, /일정과 연결된 예약입니다/],
    [{ fileList: [{ fileSn: 1 }] }, /첨부파일이 있는 예약입니다/],
    [{ subscriberList: [] }, /예약자 정보가 없습니다/],
    [{ seqNum: 9 }, /목록과 다릅니다/],
    [{ createDate: "" }, /예약 상세를 찾지 못했습니다/]].map(([detail, re]) => [{ title: "새 제목" }, { detail }, re]),
]));

test("resource update: an unclear write or check is unconfirmed, never retried", () =>
  unclear(updateApi, (api) => resUpdate(api, { title: "새 제목", confirm: true }), "rs121A12", [
    [{ write: () => ({ successTf: 0 }) }, UNSURE("예약 수정")],
    [{ write: timesOut }, UNSURE("예약 수정")],
    [{ back: unauthorized }, UNSURE("예약 수정")],
    [{ back: () => ({ resultList: [ROW] }) }, UNSURE("예약 수정")]]));   // unchanged

// ---- schedule_create / schedule_update / schedule_delete
const CALS = [{ mcalSeq: 134, calType: "E", calRwGbn: "w", empSeq: "E1", calTitle: "내 일정" },
  { mcalSeq: 35, calType: "M", calRwGbn: "r", empSeq: "E9", calTitle: "공용 일정" }];
const SCH_START = "2099-01-01 15:00", SCH_END = "2099-01-01 16:00";
// an sc111A04 detail of a plain schedule of mine; its empty lists must not read as filled
const CREATED = { schSeq: 8439, schmSeq: 8439, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500",
  endDate: "209901011600", alldayYn: "N", repeatType: "10", calType: "E", gbnCode: "E", schGbnCode: "10", lunarYn: "N",
  contents: "", resList: [], reservedList: [], addressUserList: [], schPartEmpList: [], schUserList: [], schAlarmList: [],
  fileList: [], fileCnt: 0 };
const ROW_8440 = { schSeq: 8440, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500", endDate: "209901011600" };

// answers `before` until a request to `code` has gone out, then `after`
const until = (code, before, after) => (calls) => (calls.some((c) => c.path.endsWith(code)) ? after : before);

// write is sc111A05's resultData; detail (sc111A04) and rows (sc111A03) may be until(...); fail(path, calls) may answer first
function schApi({ cals = CALS, write = {}, detail = CREATED, rows = [], fail } = {}) {
  return fake((path, body, calls) => {
    const failed = fail?.(path, calls);
    if (failed !== undefined) return failed;
    if (path.endsWith("gw102A04")) return searchIn(body);
    if (path.endsWith("sc111A02")) return { resultList: cals };
    if (path.endsWith("sc111A03")) return { resultList: typeof rows === "function" ? rows(calls) : rows };
    if (path.endsWith("sc111A04")) return typeof detail === "function" ? detail(calls) : detail;
    return path.endsWith("sc111A05") ? write : true;   // sc111A06
  });
}
const create = (api, args = {}) => createSchedule(S, { title: "주간회의", start: SCH_START, end: SCH_END, ...args }, { fetch: api.fetch });
const update = (api, args = {}) => updateSchedule(S, { sch_seq: 8439, ...args }, { fetch: api.fetch });
const remove = (api, args = {}) => deleteSchedule(S, { sch_seq: 8439, ...args }, { fetch: api.fetch });

test("schedule create: a preview finds my calendar; confirm sends the contract and reads it back", async () => {
  const api = schApi({ write: { schSeq: 8439, schmSeq: 8439 } });
  const args = { title: " 주간회의 ", place: "대회의실", memo: "안건", attendees: ["홍길동", "김민수 개발", "김민수 개발"] };
  const preview = { calendar: "내 일정", title: "주간회의", start: SCH_START, end: SCH_END, place: "대회의실", memo: "안건",
    attendees: ["홍길동 (개발팀)", "김민수 (개발팀)"] };
  assert.deepEqual(await create(api, args), preview);
  assert.deepEqual(writes(api), []);
  assert.deepEqual(await create(api, { ...args, confirm: true }), { ...preview, created: true, sch_seq: 8439 });
  assert.deepEqual(bodyOf(api, "sc111A05"), {
    companyInfo: COMPANY, langCode: "kr", schmSeq: "0", schSeq: "0", mcalSeq: "134", schTitle: "주간회의",
    startDate: "209901011500", endDate: "209901011600", alldayYn: "N", lunarYn: "N", alarm_yn: "N",
    gbnCode: "E", calType: "E", gbnSeq: "", schGbnCode: "10", repeatType: "10", repeatEndDay: "", repeatByDay: "",
    contents: "안건", rangeCode: "N", schPlace: "대회의실", placeMapData: "{}", placeFileId: "", fileId: "",
    delFileList: [], uidList: "", resList: [], reservedList: [], schAlarmList: [], schUserList: [],
    // I made it, so I am not invited; the other person once, with my groupSeq
    schPartEmpList: [{ compSeq: "1000", groupSeq: "G1", deptSeq: "D2", empSeq: "E7", dutyPositionOption: "0" }],
    addressUserList: [], inviterPartType: "M", companyEmpSeq: "E1", empSeq: "E1", groupSeq: "G1", otherLinkList: [],
    schModuleGbn: null, schModuleSeq: null, myMemo: "", videoYn: "N", mailSend: "N" });
  assert.deepEqual(api.calls.at(-1), { path: "/schres/sc111A04", query: "",
    body: { companyInfo: COMPANY, schSeq: "8439", tcalSeq: "", langCode: "kr" } });
  assert.deepEqual(writes(api), ["sc111A05"]);
});

test("schedule create: without an id in the answer, the one listed match is read back", async () => {
  const rows = [{ ...ROW_8440, schSeq: 1, schTitle: "다른 일정" }, { ...ROW_8440, schSeq: 3, startDate: "209901011530" },
    ROW_8440, { ...ROW_8440, schSeq: 4, endDate: "209901011630" }];
  const api = schApi({ detail: { ...CREATED, schSeq: 8440 }, rows });
  assert.equal((await create(api, { confirm: true })).sch_seq, 8440);
  const listed = bodyOf(api, "sc111A03");
  assert.deepEqual([listed.startDate, listed.endDate, listed.mySchYn, listed.calList.map((c) => c.mcalSeq)],
    ["20990101", "20990101", "N", ["134"]]);
  assert.equal(api.calls.at(-1).body.schSeq, "8440");
});

test("schedule create: refusals write nothing; my own calendar is picked among several", async () => {
  const other = { ...CALS[0], mcalSeq: 200, empSeq: "E9", calTitle: "남의 일정" };
  assert.equal((await create(schApi({ cals: [other, CALS[0]] }))).calendar, "내 일정");
  await refuses(schApi, create, [
    [{ title: "  " }, {}, /제목이 비어 있습니다/],
    [{ start: SCH_END, end: SCH_START }, {}, /종료 시각/],
    [{ start: "2099-01-01" }, {}, BAD_TIME],
    [{}, { cals: [] }, /찾지 못했습니다/],
    [{}, { cals: [{ ...CALS[0], calRwGbn: "r" }] }, /찾지 못했습니다/],
    [{}, { cals: [CALS[0], { ...CALS[0], mcalSeq: 135 }] }, /여러 개/],
    [{ attendees: ["김민수"] }, {}, /한 명으로 정하지 못했습니다/]]);
});

test("schedule create: an unclear write or read-back is unconfirmed, never retried", () => {
  const sch = /^일정 등록 결과를 확인하지 못했습니다\(sch_seq 8439\)\. 그룹웨어에서 확인해 주세요\.$/;
  return unclear(schApi, (api) => create(api, { confirm: true }), "sc111A05", [
    [{ write: { schSeq: 8439 }, detail: { ...CREATED, startDate: "209901011530" } }, sch],
    [{ write: { schSeq: 8439 }, detail: { ...CREATED, mcalSeq: 35 } }, sch],
    [{ write: { schSeq: 8439 }, detail: null }, sch],
    [{ write: { schSeq: 8439 }, fail: on("sc111A04", unauthorized) }, sch],   // a SessionError would write again
    [{ rows: [ROW_8440, { ...ROW_8440, schSeq: 8441 }] }, UNSURE("일정 등록")],   // no guessing among several
    [{ fail: on("sc111A05", () => new Response(JSON.stringify({ resultCode: 114, resultMsg: "필수 값 누락" }))) },
      /필수 값 누락 그룹웨어에서 확인해 주세요\.$/],
    [{ fail: on("sc111A05", unauthorized) }, (e) => e instanceof SessionError]]);
});

test("schedule create: an unclear write keeps no transport text, which can carry the token", async () => {
  const api = schApi({ fail: on("sc111A05", () => { throw new TypeError("Illegal header value b'Bearer G1|E1|TOKEN-SECRET'"); }) });
  const e = await create(api, { confirm: true }).catch((x) => x);
  assert.match(e.message, UNSURE("일정 등록"));
  assert.equal(e.cause, undefined);
  assert.ok(!String(e.stack).includes("SECRET"));
  assert.deepEqual(api.paths().slice(-1), ["/schres/sc111A05"]);   // an unanswered write is not read back
});

const CHANGED = { ...CREATED, schTitle: "주간회의(변경)", startDate: "209901011600", endDate: "209901011700" };

test("schedule update: a preview shows before and after; confirm sends the stored schedule with the change", async () => {
  const api = schApi({ detail: until("sc111A05", CREATED, CHANGED) });
  const args = { sch_seq: "8439", title: " 주간회의(변경) ", start: "2099-01-01 16:00", end: "2099-01-01 17:00" };
  const after = { title: "주간회의(변경)", start: "2099-01-01 16:00", end: "2099-01-01 17:00" };
  assert.deepEqual(await update(api, args), { sch_seq: 8439,
    before: { title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00" }, after });
  assert.deepEqual(writes(api), []);
  assert.deepEqual(bodyOf(api, "sc111A04"), { companyInfo: COMPANY, schSeq: "8439", tcalSeq: "", langCode: "kr" });
  assert.deepEqual(await update(api, { ...args, confirm: true }), { sch_seq: 8439, after, updated: true });
  assert.deepEqual(bodyOf(api, "sc111A05"), { ...CREATED, companyInfo: COMPANY, langCode: "kr",
    schSeq: "8439", schmSeq: "8439", mcalSeq: "134", schTitle: "주간회의(변경)",
    startDate: "209901011600", endDate: "209901011700", contents: "", alldayYn: "N", lunarYn: "N",
    alarm_yn: "N", gbnCode: "E", calType: "E", schGbnCode: "10", repeatType: "10", rangeCode: "UO",
    resList: [], reservedList: [], schAlarmList: [], schUserList: [], schPartEmpList: [],
    addressUserList: [], delFileList: [], uidList: "", empSeq: "E1", groupSeq: "G1",
    alarmOnModify: false, mailSend: "N" });
  assert.deepEqual(writes(api), ["sc111A05"]);
});

test("schedule update: what it does not change goes back as stored", async () => {
  const { gbnCode, calType, ...rest } = CREATED;   // missing: the calendar's type
  const alarm = { alarmType: "20", alarmTimeDiv: "30" };
  const detail = { ...rest, schmSeq: 8000, contents: "안건", lunarYn: "Y", schGbnCode: "20", schAlarmList: [alarm],
    schPartEmpList: [{ orgSeq: "E1" }],   // only me: still plain
    schUserList: [{ userType: "10", empSeq: "E1" }, { userType: "30", empSeq: "E9" }] };
  const api = schApi({ detail: until("sc111A05", detail, { ...detail, schTitle: "x" }) });
  const out = await update(api, { title: "x", confirm: true });
  assert.deepEqual(out.after, { title: "x", start: "2099-01-01 15:00", end: "2099-01-01 16:00" });
  const body = bodyOf(api, "sc111A05");
  assert.deepEqual([body.schmSeq, body.contents, body.lunarYn, body.schGbnCode, body.gbnCode, body.calType],
    ["8000", "안건", "Y", "20", "E", "E"]);
  // the flag follows the reminders: "N" beside a filled list may make the server drop it
  assert.deepEqual([body.alarm_yn, body.schAlarmList], ["Y", [alarm]]);
  assert.deepEqual(body.schPartEmpList, [{ orgSeq: "E1" }]);
  assert.deepEqual(body.schUserList, [{ userType: "10", empSeq: "E1" }]);   // userType 30 left out
});

test("schedule update and delete: all but a plain schedule of mine is refused", async () => {
  const notPlain = [
    [{ mcalSeq: 35 }, /내 개인 캘린더/],
    [{ repeatType: "40" }, /반복/],
    [{ repeatType: null }, /반복/],   // a missing value must not pass for "10"
    [{ schmSeq: null }, /찾지 못했습니다/],
    [{ endDate: "" }, /찾지 못했습니다/],
    [{ resList: [{ resSeq: "12" }] }, /자원/],
    [{ reservedList: [{ resSeq: "12" }] }, /자원/],
    [{ addressUserList: [{ email: "x@example.com" }] }, /외부 참석자/],
    [{ schPartEmpList: [{ empSeq: "E1" }, { empSeq: "E7" }] }, /다른 참석자/],
    [{ schPartEmpList: [{ orgSeq: "E7" }] }, /다른 참석자/],
    [{ schModuleSeq: "77" }, /외부 모듈/],
    [{ fileList: [{ fileId: "f" }] }, /첨부/],
    [{ fileCnt: "1" }, /첨부/],
  ].map(([change, re]) => [{ title: "x" }, { detail: JSON.parse(JSON.stringify({ ...CREATED, ...change })) }, re]);
  await refuses(schApi, remove, notPlain);
  await refuses(schApi, update, [...notPlain,
    [{ title: "x" }, { detail: { ...CREATED, alldayYn: "Y" } }, /종일/],   // the update would drop it
    [{}, {}, /바꿀 값/],
    [{ title: "  " }, {}, /비울 수 없습니다/],
    [{ start: "2099-01-01" }, {}, BAD_TIME],
    [{ start: "2099-01-01 17:00" }, {}, /종료 시각/],   // past the kept end
    [{ sch_seq: 1, title: "x" }, { detail: null }, /일정 1을\(를\) 찾지 못했습니다/]]);
});

test("schedule update: an unclear write or read-back is unconfirmed, never retried", () => {
  const afterWrite = (fail) => (path, calls) =>
    (path.endsWith("sc111A04") && calls.some((c) => c.path.endsWith("sc111A05")) ? fail() : undefined);
  return unclear(schApi, (api) => update(api, { title: "x", confirm: true }), "sc111A05", [
    [{}, UNSURE("일정 수정")],   // the read-back still holds the old title
    [{ detail: until("sc111A05", CREATED, { ...CREATED, schTitle: "x", endDate: "209901011630" }) }, UNSURE("일정 수정")],
    [{ fail: on("sc111A05", timesOut) }, UNSURE("일정 수정")],
    [{ fail: afterWrite(unauthorized) }, UNSURE("일정 수정")]]);   // a SessionError would write again
});

const LISTED = { schSeq: 8439, mcalSeq: 134, schTitle: "주간회의", startDate: "209901011500", endDate: "209901011600" };

test("schedule delete: a preview names it; confirm sends the three ids and checks it is gone", async () => {
  const api = schApi({ rows: until("sc111A06", [LISTED], []) });
  const preview = { sch_seq: 8439, title: "주간회의", start: "2099-01-01 15:00", end: "2099-01-01 16:00" };
  assert.deepEqual(await remove(api, { sch_seq: "8439" }), preview);
  assert.deepEqual(writes(api), []);
  assert.deepEqual(await remove(api, { confirm: true }), { ...preview, deleted: true });
  // like the web client, the delete carries no companyInfo
  assert.deepEqual(bodyOf(api, "sc111A06"), { mcalSeq: "134", schmSeq: "8439", schSeq: "8439", rangeCode: "", langCode: "kr" });
  const listed = api.calls.at(-1).body;
  assert.deepEqual([listed.startDate, listed.endDate, listed.calList.map((c) => c.mcalSeq)], ["20990101", "20990101", ["134"]]);
});

test("schedule delete: still listed, or an unclear delete or check, is reported, never retried", () =>
  unclear(schApi, (api) => remove(api, { confirm: true }), "sc111A06", [
    [{ rows: [LISTED] }, /^삭제 뒤에도 일정이 남아 있습니다\. 그룹웨어에서 확인해 주세요\.$/],
    [{ fail: on("sc111A06", timesOut) }, UNSURE("일정 삭제")],
    [{ fail: on("sc111A03", unauthorized) }, UNSURE("일정 삭제")],   // sc111A03 runs only after the delete
    [{ fail: on("sc111A03", () => [LISTED]) }, UNSURE("일정 삭제")]]));   // not a list of rows: not "gone"

// ---- mail
const SETUP = { email: "hong@example.com", mail_from: ["hong@example.com"], userInfo: {},
  userFromNameList: [{ userName: "다른이름", isDefault: false }, { userName: "홍길동", isDefault: true }],
  filedir: "/data/f1", sessionKey: "SK-1", bigFileDay: "30", "insideDomainArray[]": ["example.com"] };
const reply = (resultCode, resultMsg = "") => new Response(JSON.stringify({ resultCode, resultMsg, resultData: {} }));

function mailApi({ setup = SETUP, send = () => reply(0) } = {}) {
  return fake((path) => {
    if (path.endsWith("mail014A01")) return setup;
    if (path.endsWith("mail014A04")) return send();
    return path.endsWith("mail000A01") ? { mailboxList: [{ name: "INBOX" }, { name: "TRASH" }] } : {};
  });
}
const sendTo = (api, args = {}) => sendMail(S, { to: ["a@example.com", "김민수 <kim@example.com>"],
  subject: " 보고 ", body: "안녕\n<b>하세요</b>", ...args }, { fetch: api.fetch, now: () => new Date(2026, 9, 27, 15) });
const delMail = (api, args = {}) => deleteMail(S, { muids: [9], ...args }, { fetch: api.fetch });

test("mail send: a preview shows the mail; confirm posts the compose form once, as the web client fills it", async () => {
  const api = mailApi();
  const preview = { from: "홍길동 <hong@example.com>", to: ["a@example.com", "김민수 <kim@example.com>"],
    cc: ["lee@example.com"], bcc: [], subject: "보고", body: "안녕\n<b>하세요</b>", signature: null };
  assert.deepEqual(await sendTo(api, { cc: ["lee@example.com"] }), preview);
  assert.deepEqual(writes(api), []);
  assert.deepEqual(await sendTo(api, { cc: ["lee@example.com"], confirm: true }), { ...preview, sent: true });
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
  assert.deepEqual([form.subject, form.fileDir, form.sessionKey, form.insideDomainArray, form.externalSendLimit],
    ["보고", "/data/f1", "SK-1", '["example.com"]', "N"]);
  assert.deepEqual([form.bigFilePeriod, form.expirationDate], ["2026-10-27 ~ 2026-11-26", "2026-10-27 00:00"]);
  assert.equal(form.authToken, "hong@example.com|G1|E1|R1");
  assert.deepEqual(writes(api), ["mail014A04"]);
});

test("mail send: html=true sends the body as it is", async () => {
  const api = mailApi();
  await sendTo(api, { html: true, confirm: true });
  assert.equal(bodyOf(api, "mail014A04").htmlContents, "안녕\n<b>하세요</b>");
});

test("mail send: the signature the settings pick goes under the body; signature=true or false overrides them", async () => {
  const sig = { signature_index: 1, signature_name: "기본값", signature: "<html><head></head><body><b>홍길동</b></body></html>" };
  const plain = "안녕<br>&lt;b&gt;하세요&lt;/b&gt;";
  const signed = `${plain}<p><br></p><div class="dze_signature" dze_signature_index="1"><b>홍길동</b></div>`;
  for (const [signatureIdx, signature, name, contents] of [
    [1, null, "기본값", signed], [-1, null, null, plain], [-1, true, "기본값", signed], [1, false, null, plain]]) {
    const api = mailApi({ setup: { ...SETUP, configSignature: { signatureIdx, signatureList: [sig] } } });
    assert.equal((await sendTo(api, { signature })).signature, name);
    await sendTo(api, { signature, confirm: true });
    assert.equal(bodyOf(api, "mail014A04").htmlContents, contents, JSON.stringify([signatureIdx, signature]));
  }
});

test("mail send: cc and bcc skip an address already in to or cc", async () => {
  const out = await sendTo(mailApi(), { to: ["a@example.com"], cc: ["A@example.com", "b@example.com"],
    bcc: ["b@example.com", "c@example.com"] });
  assert.deepEqual([out.cc, out.bcc], [["b@example.com"], ["c@example.com"]]);
});

test("mail send: the user's sender, receipt and each-recipient settings are kept", async () => {
  const api = mailApi({ setup: { ...SETUP, mail_from: ["hong@example.com", "team@example.com"], representInfo: ["team@example.com"],
    userInfo: { defaultuser: "team@example.com", receiveconfirm: "0", eachtrans: "0" } } });
  assert.equal((await sendTo(api)).from, "team@example.com");   // a representative address has no own name
  await sendTo(api, { confirm: true });
  const form = bodyOf(api, "mail014A04");
  assert.deepEqual([form.from, form.fromName, form.receipt_notific, form.eachTrans], ["team@example.com", "", "1", "1"]);
});

test("mail send: refusals send nothing", () => refuses(mailApi, sendTo, [
  [{ to: ["kim"] }, {}, /메일 주소가 아닙니다/],
  [{ to: ["a@example.com, b@example.com"] }, {}, /메일 주소가 아닙니다/],
  [{ cc: ["x@y"] }, {}, /메일 주소가 아닙니다/],
  [{ to: [] }, {}, /받는 사람/],
  [{ subject: "  " }, {}, /제목/],
  [{ signature: true }, {}, /저장된 서명이 없습니다/],
  [{}, { setup: { ...SETUP, mail_from: [] } }, /보낼 주소가 없습니다/],
  [{}, { setup: { ...SETUP, useLimit: 1 } }, /제한/],
  [{}, { setup: { ...SETUP, recvSendRestiction: "3" } }, /제한/],
  [{}, { setup: { ...SETUP, mailboxPercent: "120", capacityLimit: "1" } }, /제한/],
]));

test("mail send: resultCode 1 is sent, with what the external limit left out; anything unclear is never retried", async () => {
  const out = await sendTo(mailApi({ send: () => reply(1, "x@other.com") }), { confirm: true });
  assert.deepEqual([out.sent, out.left_out], [true, "x@other.com"]);
  await unclear(mailApi, (api) => sendTo(api, { confirm: true }), "mail014A04", [
    [{ send: () => reply(-2, "발송 실패") }, /^메일 발송 결과를 확인하지 못했습니다\(발송 실패\)\. 보낸메일함을 그룹웨어에서 확인해 주세요\.$/],
    [{ send: timesOut }, UNSURE("메일 발송")],
    [{ send: unauthorized }, (e) => e instanceof SessionError]]);
});

test("mail delete: a preview names the folder; confirm moves them to the trash once", async () => {
  const api = mailApi();
  assert.deepEqual(await delMail(api, { muids: [9, "10", 9], box: "inbox" }), { box: "INBOX", muids: ["9", "10"] });
  assert.deepEqual(writes(api), []);
  assert.equal((await delMail(api, { muids: [9, "10"], confirm: true })).trashed, true);
  assert.deepEqual(bodyOf(api, "mail002A05"), { uids: "9,10", mailKey: "", boxName: "INBOX" });
  assert.deepEqual(writes(api), ["mail002A05"]);
});

test("mail delete and mark: the trash, spam, a scheduled send, an unknown folder or bad muids are refused", async () => {
  await refuses(mailApi, delMail, [
    ...["TRASH", "spam", "RESERVATION"].map((box) => [{ box }, {}, /복구할 수 없어/]),
    [{ box: "없는함" }, {}, /메일함 '없는함'이\(가\) 없습니다/]]);
  for (const muids of [[], ["9,10"], ["x"], null, Array.from({ length: 51 }, (_, i) => i + 1)]) {
    const api = mailApi();
    await assert.rejects(markMail(S, { muids }, { fetch: api.fetch }), rejectsWith(/muids/));
    await assert.rejects(delMail(api, { muids, confirm: true }), rejectsWith(/muids/));
    assert.deepEqual(api.calls, []);
  }
});

test("mail mark: unread by default, read when asked, in the mail's folder", async () => {
  const api = mailApi();
  assert.deepEqual(await markMail(S, { muids: [9, 10] }, { fetch: api.fetch }), { box: "INBOX", muids: ["9", "10"], unread: true });
  assert.deepEqual(bodyOf(api, "mail002A15"), { mbox: "INBOX", uids: "9,10", type: "unseen" });
  await markMail(S, { muids: [9], read: true }, { fetch: api.fetch });
  assert.deepEqual(api.calls.filter((c) => c.path.endsWith("mail002A15")).map((c) => c.body.type), ["unseen", "seen"]);
});

// ---- leave_request
const CODES = [
  { atCd: "1101", atNm: "연차", linkAtCd: "1010", timeSetFg: "ALL", outProcessId: "HP_HPD0110_00011" },
  { atCd: "1111", atNm: "반반차", linkAtCd: "1010", timeSetFg: "NA", outProcessId: "HP_HPD0110_00011" },
  { atCd: "1302", atNm: "기타휴가", linkAtCd: "1030", timeSetFg: "NA", outProcessId: "HP_HPD0110_00013" }];
const span = (a, b = a) => ({ atDt: a, startDt: a, endDt: b, startTm: "0900", endTm: "1800", appDy: "1", appTm: 480, ycUseCnt: 1 });
const BIND = JSON.stringify({ ITEMS: { appYear: "2026" },
  TABLE: { dbTable1: { group: [{ items: { empNm: "홍길동" }, group: [{ items: { atCdNm: "연차", appRmkDc: "<가족 여행>" } }] }] } } });
const MAIN = '<meta charset="utf-8"><style>* {margin:0;}</style><p><input class="dze_external_data_area" mapping_key="appYear">년 '
  + '<input mapping_key="empNm" type="text"> <input mapping_key="atCdNm"> <input mapping_key="appRmkDc"></p>';
const LINE = [
  { user_nm: "홍길동", act_nm: "결재", doc_line_m_seq: 1, doc_line_s_seq: 1, act_id: "A1", co_id: "1000", dept_id: "D1", user_id: "E1", doc_line_gb: "1" },
  { user_nm: "김팀장", act_nm: "결재", doc_line_m_seq: 2, doc_line_s_seq: 1, act_id: "A1", co_id: "1000", dept_id: "D1", user_id: "E9", doc_line_gb: "1" }];
const SUBMIT = ["create", "GetLinkKey", "SetEnageGroup", "saveLinkKey", "eap110A06"];
// saved approval lines: "나만" holds the writer alone and is never offered
const SAVED = [{ appLineId: 233, appLineNm: "[개인]휴가" }, { appLineId: 300, appLineNm: "나만" }];

// drafted: the line the document's own draft comes back with
function leaveApi({ spans = [span("20261216")], lines = SAVED, drafted = LINE, fail = {} } = {}) {
  return fake((path, body) => {
    const name = path.split("/").pop();
    if (fail[name]) return fail[name](body);
    switch (name) {
      case "getApplicationBaseInfo": return { attendCodeList: CODES,
        employee: { coCd: "1000", empCd: "123", deptCd: "D10", korNm: "홍길동", rsrgNo: "RRN-SECRET", brthDt: "BIRTH-SECRET" } };
      case "getStartTmEndTmByWorkType": return { startTm: "0900", endTm: "1800", workTp: "1" };
      case "calculateApplicationDays": return { deptNm: "개발팀", empNm: "홍길동", ycUseCnt: spans.length ? 1 : 0, applicationDaysCnt: 1,
        applicationMinutes: 480, dailyAppTm: 480, dailyCalculatedTimeYcUseCnt: 1, holidayExclusionApplicationList: spans };
      case "validateNew": return { duplicateSubmittedApplicationDetails: [], insufficientAnnualLeaveList: [] };
      case "0hr00011": return "[개발팀 홍길동] 12-16 연차신청서";
      case "eap096A45": return [{ formDTp: "HP_HPD0110_00012", formId: 2037 },
        { formDTp: "HP_HPD0110_00011", formId: 2036, formNm: "연차휴가신청서" }];
      case "getAnnualLeaveInfoOfEmployee": return { unusedCnt: 10 };
      case "eap096A48": return lines;
      case "create": return { appSq: 501, coCd: "1000", appDt: "20261028" };
      case "GetLinkKey": return { linkKey: "LINK-1" };
      case "saveLinkKey": return 1;
      case "eap110A03": return { mainhtml: MAIN, ucUserInfo: { compName: "회사", deptName: "개발팀", empName: "홍길동",
        oauth_token: "TOKEN-SECRET" }, resultMap: {
        hidAppDocLine: body.approkey ? drafted : body.appLineId === "300" ? [LINE[0]] : LINE,
        hidRefer: [{ div: "d", org_id: "D20", dept_nm: "인사팀" }],
        outProcessForm: { outBindData: BIND }, docnumtype: [{ cd_val: "1001" }], getFormData: [{ form_id: 2036 }] } };
      case "eap110A06": return { result: 1004400 };
      // the same appSq under another application date is a different application
      case "at00001": return [{ appSq: 501, appDt: "20260101", approState: "5" }, { appSq: 501, appDt: "20261028", approState: "0" }];
      default: return {};
    }
  });
}
const NOW = () => new Date(2026, 9, 28, 9, 30, 5);
const leave = (api, args = {}, ask = null) => requestLeave(S, { kind: "연차", start: "2026-12-16", reason: "가족 여행",
  approval_line: "[개인]휴가", ...args }, { fetch: api.fetch, now: NOW, ask });
const PREVIEW = { kind: "연차", start: "2026-12-16", end: "2026-12-16", time: "09:00~18:00", days: 1, remaining_after: 9,
  title: "[개발팀 홍길동] 12-16 연차신청서", reason: "가족 여행", approval_line: "[개인]휴가: 홍길동(결재) → 김팀장(결재), 참조 인사팀" };

test("leave request: a preview reads only and keeps the employee's private fields in", async () => {
  const api = leaveApi();
  assert.deepEqual(await leave(api), PREVIEW);
  assert.deepEqual(writes(api), []);
  const item = bodyOf(api, "validateNew").newItem;
  assert.deepEqual([item.atCd, item.startDt, item.endDt, item.startTm, item.endTm, item.atDt, item.ycUseCnt],
    ["1101", "20261216", "20261216", "0900", "1800", "20261028", 1]);
  assert.ok(!/SECRET/.test(JSON.stringify(api.calls)));
});

test("leave request: 반반차 is two hours from start_time", async () => {
  const api = leaveApi();
  assert.equal((await leave(api, { kind: "반반차", start_time: "16:00" })).time, "16:00~18:00");
  const calc = bodyOf(api, "calculateApplicationDays");
  assert.deepEqual([calc.startTime, calc.endTime], ["1600", "1800"]);
  for (const start_time of [null, "4pm", "16:75", "23:00"]) {
    await assert.rejects(leave(leaveApi(), { kind: "반반차", start_time }), rejectsWith(/start_time/));
  }
});

test("leave request: what it cannot ask for stops before any write", () => {
  const validate = (resultCode, resultMsg) => ({ fail: { validateNew: () => new Response(JSON.stringify({ resultCode, resultMsg })) } });
  return refuses(leaveApi, leave, [
    [{ kind: "기타휴가" }, {}, /kind는 연차·반반차 중 하나/],
    [{ start: "2026-12-22", end: "2026-12-18" }, {}, /시작일\(2026-12-22\)이 종료일/],
    [{}, { spans: [] }, /근무일이 없습니다/],
    [{ end: "2026-12-22" }, { spans: [span("20261218"), span("20261221", "20261222")] }, /2026-12-18, 2026-12-21~2026-12-22로 나눠/],
    [{}, validate(22028, null), /이미 신청한 근태/],
    [{}, validate(22023, "Insufficient"), /연차가 부족/],
    [{}, validate(22099, "마감"), /신청할 수 없습니다\(마감\)/],
    [{}, { fail: { validateNew: () => ({ annualLeaveClosedList: [{}] }) } }, /annualLeaveClosedList/],
    [{}, { fail: { eap096A45: () => [] } }, /결재 양식\(HP_HPD0110_00011\)을 찾지 못했습니다/]]);
});

test("leave request: confirm saves, links and submits once each, in order", async () => {
  const api = leaveApi();
  assert.deepEqual(await leave(api, { confirm: true }), { ...PREVIEW, submitted: true, id: "20261028-501", doc_id: "1004400",
    status: "결재진행", link: "https://gw.example.com/#/popup?MicroModuleCode=eap&callComp=UBAP002&docID=1004400&formId=2036&docAuth=0" });
  assert.deepEqual(writes(api), SUBMIT);
  const created = bodyOf(api, "create");
  assert.deepEqual([created.appEmpCd, created.titleDc, created.applicationList], ["123", PREVIEW.title,
    [{ ...span("20261216"), coCd: "1000", empCd: "123", deptCd: "D10", deptNm: "개발팀", empNm: "홍길동", appRmkDc: "가족 여행" }]]);
  const { approKey } = bodyOf(api, "SetEnageGroup");
  assert.match(approKey, /^ERP_[0-9a-f-]{36}$/);
  assert.deepEqual(bodyOf(api, "saveLinkKey"), { linkKey: "LINK-1", appSq: 501, coCd: "1000", appDt: "20261028" });
  const p = bodyOf(api, "eap110A06").paramItem;
  assert.equal(p.approkey, approKey);
  assert.equal(JSON.parse(p.bindData), BIND);   // the bound data as a string inside the string
  assert.deepEqual([p.form_id, p.numbering_id, p.rep_dt, p.doc_sts, p.co_nm, p.user_id], [2036, "1001", "2026-10-28 09:30:05", "20", "회사", "E1"]);
  assert.equal(decodeURIComponent(p.doc_contents), '<head><meta charset="utf-8"><style>* {margin:0;}</style>\n</head><body>'
    + "<p>2026년 홍길동 연차 &lt;가족 여행&gt;</p></body>");
  assert.deepEqual(p.modifyDocInfo.appdocLineList.map((l) => [l.doc_line_m_seq, l.user_id]), [[1, "E1"], [2, "E9"]]);
  assert.deepEqual(p.modifyDocInfo.appdocReceiveList, [{ receive_div: "10", org_div: "d", org_id: "D20" }]);
  assert.deepEqual(api.calls.filter((c) => c.path.endsWith("eap110A03")).map((c) => [c.body.approkey.slice(0, 4), c.body.appLineId]),
    [["", "233"], ["", "300"], ["ERP_", "233"]]);   // each saved line read, then the chosen one drafted
  assert.ok(!/SECRET/.test(JSON.stringify(api.calls)));
});

test("leave request: a failure before the submit discards the saved application", async () => {
  const api = leaveApi({ fail: { GetLinkKey: timesOut } });
  await assert.rejects(leave(api, { confirm: true }), rejectsWith(/^결재 문서를 만들지 못해.*저장한 근태신청을 지웠습니다/));
  assert.deepEqual(writes(api), ["create", "GetLinkKey", "deleteSubmittedApplicationList"]);
  assert.deepEqual(bodyOf(api, "deleteSubmittedApplicationList"), [{ coCd: "1000", appDt: "20261028", appSq: 501 }]);
  const stuck = leaveApi({ fail: { saveLinkKey: () => 0, deleteSubmittedApplicationList: timesOut } });
  await assert.rejects(leave(stuck, { confirm: true }), rejectsWith(/id 20261028-501.*잇지 못했습니다.*상신대기로 남았으니 leave_cancel/));
  assert.ok(!writes(stuck).includes("eap110A06"));
});

test("leave request: a session lost after the save is not run again and leaves the application", async () => {
  const api = leaveApi({ fail: { SetEnageGroup: unauthorized } });
  const e = await leave(api, { confirm: true }).catch((x) => x);
  assert.ok(e instanceof GroupwareError && !(e instanceof SessionError));   // a SessionError would re-run the tool
  assert.match(e.message, /id 20261028-501.*세션 끊김/);
  assert.deepEqual(writes(api), ["create", "GetLinkKey", "SetEnageGroup"]);
  // the save itself may be refused by an expired session: that one is safe to run again
  await assert.rejects(leave(leaveApi({ fail: { create: unauthorized } }), { confirm: true }), SessionError);
});

test("leave request: an unclear submit says to check and never discards", async () => {
  for (const fail of [timesOut, unauthorized, () => ({ result: null })]) {
    const api = leaveApi({ fail: { eap110A06: fail } });
    await assert.rejects(leave(api, { confirm: true }), rejectsWith(/id 20261028-501.*상신 결과를 확인하지 못했습니다.*leave_cancel로/));
    assert.deepEqual(writes(api), SUBMIT);
  }
});

test("leave request: only a saved line with someone besides the writer, and the submit must draft that same line", async () => {
  const pickOne = /approval_line은 저장된 결재라인 '\[개인\]휴가' 중 하나로/;
  await refuses(leaveApi, leave, [[{ approval_line: null }, {}, pickOne], [{ approval_line: "나만" }, {}, pickOne],
    [{}, { lines: [SAVED[1]] }, /본인 외 결재자가 있는 저장된 결재라인이 없습니다/]]);
  assert.equal((await leave(leaveApi(), { approval_line: "233" })).approval_line, PREVIEW.approval_line);
  // the document's draft came back with someone else on it: nothing is submitted and the application goes
  const api = leaveApi({ drafted: [LINE[0], { ...LINE[1], user_id: "E8" }] });
  await assert.rejects(leave(api, { confirm: true }), rejectsWith(/^결재 문서를 만들지 못해\(결재 문서의 결재선·참조가 미리보기와 다릅니다\.\)/));
  assert.deepEqual(writes(api), ["create", "GetLinkKey", "SetEnageGroup", "saveLinkKey", "deleteSubmittedApplicationList"]);
});

// a client's form: answers in turn, each an accept with that content or "decline"
function formOf(...answers) {
  const asked = [];
  const ask = async (params) => {
    asked.push(params);
    const a = answers.shift();
    return a === "decline" ? { action: "decline" } : { action: "accept", content: a };
  };
  return { ask, asked };
}
const FILLED = { kind: "연차", start: "2026-12-16", reason: "가족 여행", approval_line: "233" };

test("leave request with a form: an unchanged accept submits what the form showed, a change plans and asks again", async () => {
  const api = leaveApi(), form = formOf(FILLED);
  assert.equal((await leave(api, {}, form.ask)).submitted, true);
  const [{ message, requestedSchema: schema }] = form.asked;
  assert.match(message, /^연차 2026-12-16 09:00~18:00\n연차 1일 사용, 신청 후 남는 연차 9일\n제목: .*\n사유: 가족 여행\n결재라인: \[개인\]휴가: 홍길동\(결재\) → 김팀장\(결재\), 참조 인사팀\n\n값을 바꾸지 않고 승인하면 바로 상신/);
  assert.deepEqual(schema.required, ["kind", "start", "approval_line"]);
  assert.deepEqual([schema.properties.kind.enum, schema.properties.kind.default, schema.properties.start.default],
    [["연차", "반반차"], "연차", "2026-12-16"]);
  assert.deepEqual(schema.properties.approval_line, { type: "string", title: "결재라인", default: "233",
    oneOf: [{ const: "233", title: "[개인]휴가: 홍길동(결재) → 김팀장(결재), 참조 인사팀" }] });
  assert.deepEqual(writes(api), SUBMIT);

  // nothing given: the only line is filled in, the rest asked for; the answer is planned and shown before it goes
  const empty = leaveApi(), twice = formOf(FILLED, FILLED);
  assert.equal((await requestLeave(S, {}, { fetch: empty.fetch, now: NOW, ask: twice.ask })).submitted, true);
  assert.deepEqual(twice.asked.map((a) => a.message.split("\n")[0]), ["휴가 신청 내용을 입력해 주세요.", "연차 2026-12-16 09:00~18:00"]);
  assert.equal(twice.asked[0].requestedSchema.properties.approval_line.default, "233");
  assert.equal(twice.asked[0].requestedSchema.properties.kind.default, undefined);
  assert.deepEqual(writes(empty), SUBMIT);

  // shown, then changed: the change is planned and shown again, and only that goes
  const changed = leaveApi(), edit = { ...FILLED, reason: "병원" }, again = formOf(edit, edit);
  await leave(changed, {}, again.ask);
  assert.deepEqual(again.asked.map((a) => /사유: (.*)/.exec(a.message)[1]), ["가족 여행", "병원"]);
  assert.equal(bodyOf(changed, "create").applicationList[0].appRmkDc, "병원");
});

test("leave request with a form: a declined form submits nothing, and confirm=true does not skip the form", async () => {
  for (const args of [{}, { confirm: true }]) {
    const api = leaveApi(), form = formOf("decline");
    assert.deepEqual(await leave(api, args, form.ask), { submitted: false, note: "폼에서 승인받지 못해 신청하지 않았습니다." });
    assert.equal(form.asked.length, 1);
    assert.deepEqual(writes(api), []);
  }
  await assert.rejects(leave(leaveApi({ lines: [SAVED[1]] }), {}, formOf().ask), rejectsWith(/본인 외 결재자가 있는/));
});

test("fillBody fills every field and stops at one without a value", () => {
  assert.match(fillBody(MAIN, BIND), /<p>2026년 홍길동 연차 &lt;가족 여행&gt;<\/p><\/body>$/);
  assert.throws(() => fillBody(`${MAIN}<input mapping_key="usedCnt">`, BIND), rejectsWith(/usedCnt/));
});

// ---- leave_cancel
const INFO = { attendApplicationMaster: { appSq: "501", appEmpCd: "123", titleDc: "연차신청서" },
  attendApplicationDetailList: [{ atDt: "20261216" }] };
const LEAVE_ROW = { appSq: "501", appDt: "20261028", linkAtCd: "1010", atNm: "연차", approState: "0", idDoc: "1004400" };
const ME_STEP = { empSeq: "E1", userNm: "홍길동", appDt: "2026-10-28 09:30" }, BOSS_STEP = { empSeq: "E9", userNm: "김팀장", appDt: "" };
const DOC = { DOC_ID: 1004400, FORM_D_TP: "HP_HPD0110_00011", USER_ID: "E1", DOC_STS: "10" };

function withdrawApi({ row = LEAVE_ROW, rows = null, info = INFO, a98 = { doc_sts: "30", user_id: "E1" },
  line = [ME_STEP, BOSS_STEP], doc = DOC, back = () => [], del = () => ({ failCnt: 0 }) } = {}) {
  let done = false;
  return fake((path) => {
    const name = path.split("/").pop();
    if (name === "selectAttendApplicationInfo") return info;
    if (name === "at00001") return done ? back() : rows || [row];
    if (name === "eap110A98") return a98;
    if (name === "eap096A62") return { lineList: line };
    if (name === "eap107A28") return { list: doc ? [doc] : [] };
    if (name === "eap110A20") return { returnValue: 1 };
    if (name === "eap107A25") { done = true; return del(); }
    if (name === "deleteSubmittedApplicationList") { done = true; return { failCnt: 0 }; }
    return {};
  });
}
const cancelOf = (api, args = {}) => cancelLeave(S, { id: "20261028-501", ...args }, { fetch: api.fetch });
const tempDoc = (doc) => ({ row: { ...LEAVE_ROW, approState: "5" }, doc });

test("leave cancel: 결재진행 is checked in the preview, then withdrawn and deleted", async () => {
  const api = withdrawApi();
  const preview = { id: "20261028-501", kind: "연차", start: "2026-12-16", end: "2026-12-16", title: "연차신청서", status: "결재진행",
    action: "결재 전 문서를 회수한 뒤 삭제합니다. 되돌릴 수 없습니다." };
  assert.deepEqual(await cancelOf(api), preview);
  assert.deepEqual(writes(api), []);
  assert.deepEqual(await cancelOf(api, { confirm: true }), { ...preview, canceled: true });
  assert.deepEqual(writes(api), ["eap110A20", "eap107A25"]);
  assert.deepEqual(bodyOf(api, "eap110A20"), { docID: "1004400", pageCode: "UBAP002" });
  const del = api.calls.find((c) => c.path.endsWith("eap107A25"));
  assert.deepEqual([del.query, del.body], ["?docIdList=1004400", null]);
  assert.ok(api.paths().lastIndexOf("/eap/eap107A28") > api.paths().indexOf("/eap/eap110A20"));   // re-checked once withdrawn
});

test("leave cancel: refused before any write", () => refuses(withdrawApi, cancelOf, [
  [{ id: "501" }, {}, /leave_requests의 id/],
  [{}, { info: { attendApplicationMaster: {}, attendApplicationDetailList: [] } }, /찾을 수 없습니다/],
  [{}, { info: { ...INFO, attendApplicationMaster: { ...INFO.attendApplicationMaster, appEmpCd: "999" } } }, /본인이 신청한/],
  [{}, { row: { ...LEAVE_ROW, linkAtCd: "1030" } }, /연차·반차·반반차 신청만/],
  [{}, { row: { ...LEAVE_ROW, approState: "1" } }, /결재가 끝난 신청은 그룹웨어/],
  [{}, { row: { ...LEAVE_ROW, approState: "4" } }, /결재반려 상태의 신청은 취소할 수 없습니다/],
  [{}, { row: { ...LEAVE_ROW, idDoc: null } }, /결재 문서 번호/],
  [{}, { row: { ...LEAVE_ROW, reportCancYn: "Y" } }, /결재취소가 걸린/],
  [{}, { row: { ...LEAVE_ROW, cancellationApplication: true } }, /결재취소가 걸린/],
  [{}, { a98: { doc_sts: "90", user_id: "E1" } }, /결재 진행 중인 문서가 아닙니다/],
  [{}, { a98: { doc_sts: "30", user_id: "E9" } }, /본인이 상신한/],
  [{}, { line: [] }, /결재선을 받지 못했습니다/],
  [{}, { line: [ME_STEP, { ...BOSS_STEP, appDt: "2026-10-28 10:00" }] }, /김팀장 님이 이미 처리/],
  [{}, { line: [{ ...ME_STEP, appDt: "" }, BOSS_STEP] }, /처리 기록을 읽지 못해/],
  [{}, tempDoc(null), /찾지 못했습니다/],
  [{}, tempDoc({ ...DOC, FORM_D_TP: "EA_GENERAL" }), /본인의 임시보관 근태 문서만/],
  [{}, tempDoc({ ...DOC, USER_ID: "E9" }), /본인의 임시보관/],
  [{}, tempDoc({ ...DOC, DOC_STS: "30" }), /본인의 임시보관/],
]));

test("leave cancel: 임시보관 is deleted and 상신대기 discarded", async () => {
  const kept = withdrawApi(tempDoc(DOC));
  assert.equal((await cancelOf(kept, { confirm: true })).canceled, true);
  assert.deepEqual(writes(kept), ["eap107A25"]);
  const saved = withdrawApi({ row: { ...LEAVE_ROW, approState: "2", idDoc: null } });
  assert.equal((await cancelOf(saved, { confirm: true })).canceled, true);
  assert.deepEqual(bodyOf(saved, "deleteSubmittedApplicationList"), [{ coCd: "1000", appDt: "20261028", appSq: 501 }]);
});

test("leave cancel: still listed, an unread check or a failed delete is an error and not repeated", async () => {
  for (const [back, re] of [[() => [LEAVE_ROW], /남아 있습니다/], [unauthorized, UNSURE("취소")]]) {
    const api = withdrawApi({ back });
    await assert.rejects(cancelOf(api, { confirm: true }), rejectsWith(re));
    assert.deepEqual(writes(api), ["eap110A20", "eap107A25"]);
  }
  const failing = withdrawApi({ ...tempDoc(DOC), del: () => ({ failCnt: 1 }) });
  await assert.rejects(cancelOf(failing, { confirm: true }), rejectsWith(/삭제하지 못했습니다/));
  assert.deepEqual(writes(failing), ["eap107A25"]);
});

test("leave cancel: the same appSq under another application date is not this one", async () => {
  const api = withdrawApi({ rows: [{ ...LEAVE_ROW, appDt: "20261001", idDoc: "999", approState: "5" }, LEAVE_ROW] });
  assert.equal((await cancelOf(api, { confirm: true })).status, "결재진행");
  assert.equal(bodyOf(api, "eap110A20").docID, "1004400");
  assert.deepEqual(api.calls.filter((c) => c.query).map((c) => c.query), ["?docIdList=1004400"]);
});

test("leave cancel: once withdrawn, a failed delete says where the document is and is not run again", async () => {
  const stuck = withdrawApi({ doc: { ...DOC, DOC_STS: "30" } });
  await assert.rejects(cancelOf(stuck, { confirm: true }), rejectsWith(/회수해 임시보관으로 옮겼지만 삭제하지 못했습니다.*leave_cancel을 다시/));
  assert.deepEqual(writes(stuck), ["eap110A20"]);
  const e = await cancelOf(withdrawApi({ del: unauthorized }), { confirm: true }).catch((x) => x);
  assert.ok(e instanceof GroupwareError && !(e instanceof SessionError));   // a SessionError would re-run the tool
  assert.match(e.message, /회수해 임시보관으로 옮겼지만.*세션 끊김/);
});

test("leave cancel with a form: the person picks among what can still be canceled, and the pick cancels it", async () => {
  const row = { ...LEAVE_ROW, startDt: "20261216", endDt: "20261216", appRmkDc: "가족 여행" };
  const rows = [row, { ...row, atDt: "20261217" }, { ...row, appSq: "502", approState: "1" }, { ...row, appSq: "503", linkAtCd: "1030" },
    { ...row, appSq: "504", reportCancYn: "Y" }, { ...row, appSq: "505", approState: "2", startDt: "20261218", endDt: "20261219", appRmkDc: "" }];
  const viaForm = (api, args, form) => cancelLeave(S, args, { fetch: api.fetch, now: () => new Date(2026, 9, 29), ask: form.ask });
  const api = withdrawApi({ rows }), form = formOf({ id: "20261028-501" });
  assert.equal((await viaForm(api, {}, form)).canceled, true);
  assert.deepEqual([bodyOf(api, "at00001").startDate, bodyOf(api, "at00001").endDate], ["20260101", "20271231"]);
  const [{ message, requestedSchema }] = form.asked;
  assert.match(message, /^취소할 연차 신청을 고르세요\. 승인하면 바로 취소되며 되돌릴 수 없습니다/);
  assert.deepEqual(requestedSchema.properties.id, { type: "string", title: "신청", oneOf: [
    { const: "20261028-501", title: "2026-12-16 연차 (결재진행) 가족 여행" },
    { const: "20261028-505", title: "2026-12-18~2026-12-19 연차 (상신대기)" }] });
  assert.deepEqual(writes(api), ["eap110A20", "eap107A25"]);

  const declined = withdrawApi({ rows }), no = formOf("decline");
  assert.deepEqual(await viaForm(declined, { id: "20261028-501", confirm: true }, no), { canceled: false, note: "폼에서 승인받지 못해 취소하지 않았습니다." });
  assert.equal(no.asked[0].requestedSchema.properties.id.default, "20261028-501");
  assert.deepEqual(writes(declined), []);

  // nothing cancelable: no form; an id that cannot be canceled says why, before any form
  const none = formOf();
  assert.match((await viaForm(withdrawApi({ rows: [rows[2]] }), {}, none)).note, /취소할 수 있는 연차 신청이 없습니다/);
  await assert.rejects(viaForm(withdrawApi({ row: { ...row, approState: "1" } }), { id: "20261028-501" }, none),
    rejectsWith(/결재가 끝난 신청은/));
  assert.equal(none.asked.length, 0);
});

// ---- every tool
test("every write tool only previews unless confirm is exactly true", async () => {
  const tools = [[resApi, reserve], [cancelApi, cancel], [updateApi, (api, a) => resUpdate(api, { title: "새 제목", ...a })],
    [schApi, create], [schApi, (api, a) => update(api, { title: "t", ...a })], [schApi, remove], [mailApi, sendTo],
    [mailApi, delMail], [leaveApi, leave], [withdrawApi, cancelOf]];
  for (const confirm of [undefined, false, "true", 1, "yes"]) {
    for (const [makeApi, call] of tools) {
      const api = makeApi();
      await call(api, { confirm });
      assert.deepEqual(writes(api), [], `${makeApi.name} ${confirm}`);
    }
  }
});
