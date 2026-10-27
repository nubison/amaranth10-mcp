// leave, people, attendees, dates, resources, schedules and approvals
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupwareError } from "../src/client.js";
import {
  fetchApproval, fetchApprovals, fetchDeptMembers, fetchLeaveBalance, fetchLeaveRequests,
  fetchMyReservations, fetchResourceSchedule, fetchResources, fetchSchedule, resolveAttendees,
  searchPeople, toApiDay, toApiDt,
} from "../src/read.js";

const SESSION = { base: "https://gw.example.com", token: "G1|E1|R1", signKey: "test-sign-key", user: {} };
const HR = { ...SESSION, user: { erpEmpCd: "123", erpCoCd: "1000" } };
const RES = { ...SESSION, user: { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", empSeq: "E1" } };
const sessionWith = (user) => ({ ...SESSION, user });

function fake(handler, calls = []) {
  const fetch = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ path, body });
    const data = handler(path, body);
    return new Response(JSON.stringify(data === undefined ? { resultCode: 0 } : { resultCode: 0, resultData: data }));
  };
  return { fetch, calls, paths: () => calls.map((c) => c.path) };
}
const year = new Date().getFullYear();

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

// ---- leave balance
test("leave balance buckets", async () => {
  const { fetch, calls } = fake(() => ({ year: "2026", totalCnt: "15", usedCnt: "5", unusedCnt: "10", progressCnt: "0",
    annualLeaveDetail: { basicTotalCnt: "15", basicUsedCnt: "5", basicProgressCnt: "0" } }));
  const out = await fetchLeaveBalance(HR, {}, { fetch, now: () => new Date(2026, 9, 5) });
  assert.equal(out.remaining, 10);
  assert.equal(out.basic.remaining, 10);
  assert.equal(out.year, "2026");
  assert.deepEqual(calls[0], { path: "/human/common/annualleave/getAnnualLeaveInfoOfEmployee",
    body: { coCd: "1000", empCd: "123", startDate: "20261005", endDate: "20261005", startTm: "0000", endTm: "0000" } });
});

test("leave balance: pending counts against each bucket", async () => {
  const { fetch } = fake(() => ({ annualLeaveDetail: { compensationTotalCnt: "3", compensationUsedCnt: "1",
    compensationProgressCnt: "0.5", substituteTotalCnt: "2" } }));
  const out = await fetchLeaveBalance(HR, {}, { fetch });
  assert.deepEqual(out.compensation, { total: 3, used: 1, pending: 0.5, remaining: 1.5 });
  assert.deepEqual(out.substitute, { total: 2, used: 0, pending: 0, remaining: 2 });
  assert.equal(out.basic.remaining, 0);   // missing counts read as 0
  assert.equal(out.year, null);
});

test("leave balance reads dashes as zero", async () => {
  const { fetch } = fake(() => ({ year: "2026", totalCnt: "15", usedCnt: "5", unusedCnt: "----", progressCnt: "-",
    annualLeaveDetail: { basicTotalCnt: "15", basicUsedCnt: "5", compensationTotalCnt: "-",
      compensationUsedCnt: "-", compensationProgressCnt: "----" } }));
  const out = await fetchLeaveBalance(HR, {}, { fetch });
  assert.deepEqual([out.total, out.used, out.remaining, out.pending], [15, 5, 0, 0]);
  assert.deepEqual(out.compensation, { total: 0, used: 0, pending: 0, remaining: 0 });
  assert.equal(out.basic.remaining, 10);
});

for (const [id, data] of [["empty-object", {}], ["missing", undefined]]) {
  test(`leave balance without data is a GroupwareError: ${id}`, async () => {
    const { fetch } = fake(() => data);
    await assert.rejects(fetchLeaveBalance(HR, {}, { fetch }),
      (e) => e instanceof GroupwareError && /연차 정보를 받지 못했습니다/.test(e.message));
  });
}

const NO_ERP = [["no-company", { erpEmpCd: "123" }], ["no-employee", { erpCoCd: "1000" }],
  ["company-none", { erpEmpCd: "123", erpCoCd: null }]];
for (const [id, user] of NO_ERP) {
  test(`HR calls refuse a session without ERP codes, sending nothing: ${id}`, async () => {
    const { fetch, calls } = fake(() => ({}));
    await assert.rejects(fetchLeaveBalance(sessionWith(user), {}, { fetch }),
      (e) => e instanceof GroupwareError && /ERP 사번\/회사 코드/.test(e.message));
    await assert.rejects(fetchLeaveRequests(sessionWith(user), {}, { fetch }), /ERP 사번\/회사 코드/);
    assert.deepEqual(calls, []);   // nothing goes out with a guessed company code
  });
}

// ---- leave requests
// live shape: appTm is the time applied for in minutes, startTm/endTm "HHMM"
const LEAVE_ROW = { appSq: 31, atItemNm: "연차", atCdNm: "연차(종일)", startDt: "20260923", endDt: "20260923",
  appTm: 240, startTm: "0900", endTm: "1300", ycUseCnt: 0.5, appRmkDc: "추석 전날 오전근무", approStateNm: null,
  approState: "1", idDoc: "1002770", reportCancYn: "N", linkKey: "LINK-SECRET", approKey: "APPRO-SECRET" };
const leaveOut = { type: "연차", start: "2026-09-23", end: "2026-09-23", days: 0.5, hours: 4, time: "09:00~13:00",
  reason: "추석 전날 오전근무", status: "결재완료", doc_id: "1002770", canceled: false };

test("fetchLeaveRequests request and fields", async () => {
  const noState = { ...LEAVE_ROW }; delete noState.approState;
  const rows = [LEAVE_ROW,
    { ...LEAVE_ROW, atItemNm: null, approState: "9", idDoc: null, reportCancYn: "Y", ycUseCnt: "-" },
    { ...LEAVE_ROW, approStateNm: "반려" },   // the name wins over the code "1"
    { ...LEAVE_ROW, approState: "2" }, { ...LEAVE_ROW, approState: "5" }, noState];
  const { fetch, calls } = fake(() => rows);
  const out = await fetchLeaveRequests(HR, { start: "2026-09-01", end: "2026-09-30" }, { fetch });
  assert.deepEqual(calls, [{ path: "/human/attendapplication/at00001", body: {
    employeeList: [{ coCd: "1000", empCd: "123" }], startDate: "20260901", endDate: "20260930",
    approState: "", linkKey: "" } }]);
  assert.deepEqual(out, [
    leaveOut,
    { ...leaveOut, type: "연차(종일)", days: 0, status: "9", doc_id: null, canceled: true },
    { ...leaveOut, status: "반려" },
    { ...leaveOut, status: "결재 문서 없음" },
    { ...leaveOut, status: "임시보관" },
    { ...leaveOut, status: "" }]);
  assert.ok(!JSON.stringify(out).includes("SECRET"));   // linkKey and approKey stay inside
});

test("fetchLeaveRequests keeps a part day that uses no annual leave", async () => {
  // live 2026-09-23: 기타휴가 13:00~18:00, appTm 300 minutes, ycUseCnt 0
  const row = { ...LEAVE_ROW, atItemNm: null, atCdNm: "기타휴가", appTm: 300, startTm: "1300", endTm: "1800", ycUseCnt: 0 };
  const [out] = await fetchLeaveRequests(HR, {}, { fetch: fake(() => [row]).fetch });
  assert.deepEqual([out.type, out.days, out.hours, out.time], ["기타휴가", 0, 5, "13:00~18:00"]);
  const [bare] = await fetchLeaveRequests(HR, {}, { fetch: fake(() => [{ ...row, appTm: null, startTm: null }]).fetch });
  assert.deepEqual([bare.hours, bare.time], [0, ""]);
});

test("fetchLeaveRequests defaults to this year", async () => {
  const { fetch, calls } = fake(() => []);
  assert.deepEqual(await fetchLeaveRequests(HR, {}, { fetch }), []);
  assert.deepEqual([calls[0].body.startDate, calls[0].body.endDate], [`${year}0101`, `${year}1231`]);
});

test("fetchLeaveRequests rejects a bad date before sending", async () => {
  const { fetch, calls } = fake(() => []);
  await assert.rejects(fetchLeaveRequests(HR, { start: "9/1" }, { fetch }), /9\/1/);
  assert.deepEqual(calls, []);
});

// ---- people
const PERSON = { empSeq: "E7", empName: "김민수", deptSeq: "D2", deptName: "개발팀", compSeq: "1000",
  compName: "예시회사", positionName: "주임", dutyName: "팀원", loginId: "minsu",
  displayPathName: "예시회사 > 개발본부 > 개발팀", mobileTelNum: "010-0000-0000", bday: "0101" };
const peopleFake = (people, calls) => fake(() => people, calls);

test("searchPeople returns only the allowlisted fields", async () => {
  const { fetch, calls } = peopleFake([PERSON]);
  const out = await searchPeople(SESSION, { name: " 김민수 " }, { fetch });
  assert.deepEqual(calls, [{ path: "/gw/APIHandler/gw102A04", body: { searchText: "김민수", orgGubunList: ["U"] } }]);
  assert.deepEqual(out, [{ name: "김민수", department: "개발팀", position: "주임", duty: "팀원" }]);
  assert.equal((await searchPeople(SESSION, { name: "김민" }, { fetch: peopleFake(Array(25).fill(PERSON)).fetch })).length, 20);
});

test("searchPeople refuses one letter before sending", async () => {
  const { fetch, calls } = peopleFake([PERSON]);
  await assert.rejects(searchPeople(SESSION, { name: "김" }, { fetch }), (e) => e instanceof GroupwareError && /2자/.test(e.message));
  assert.deepEqual(calls, []);
});

const MEMBERS = [{ orgGubun: "d", deptSeq: "D1", deptName: "개발팀" },
  { orgGubun: "u", empSeq: "E7", empName: "김민수", deptSeq: "D1", deptName: "개발팀", positionName: "주임",
    dutyName: "팀원", bday: "0101", homeTelNum: "02-000-0000", mobileTelNum: "010-1111-2222", addrM: "서울시 어딘가",
    emailAddr: "minsu", outMailAddr: "private@example.com", employeeNumber: "2026000001", loginId: "login-minsu" }];

test("fetchDeptMembers defaults to my department and keeps four fields", async () => {
  const { fetch, calls } = peopleFake(MEMBERS);
  const out = await fetchDeptMembers(RES, {}, { fetch });
  assert.deepEqual(calls, [{ path: "/gw/APIHandler/gw102A02", body: {
    orderText: "", selectedId: "D1", orgGubun: "d", popupType: "main", selectedType: "tree", searchDiv: "all",
    searchText: "", isBdayOption: "0", isJoinDayOption: "0", isOrganizationDisplayOption: "5|0|1|3|",
    isGridListDisplayOption: "0", isLoginIdOption: "0" } }]);
  assert.deepEqual(out, [{ name: "김민수", department: "개발팀", position: "주임", duty: "팀원" }]);
  const text = JSON.stringify(out);
  for (const v of ["0101", "02-000-0000", "010-1111-2222", "서울시", "minsu", "private@", "2026000001"]) {
    assert.ok(!text.includes(v), v);
  }
});

test("fetchDeptMembers takes a department id", async () => {
  const { fetch, calls } = peopleFake([]);
  assert.deepEqual(await fetchDeptMembers(RES, { dept: 1286 }, { fetch }), []);
  assert.equal(calls[0].body.selectedId, "1286");
});

for (const [id, dept, user, match] of [["name-not-id", "인사팀", { deptSeq: "D1" }, /부서 ID/],
  ["no-session-dept", null, {}, /부서 정보/], ["zero", 0, { deptSeq: "D1" }, /부서 ID/],
  ["full-width", "２", { deptSeq: "D1" }, /부서 ID/]]) {
  test(`fetchDeptMembers refuses what it cannot scope to one department: ${id}`, async () => {
    const { fetch, calls } = peopleFake(MEMBERS);
    await assert.rejects(fetchDeptMembers(sessionWith(user), { dept }, { fetch }),
      (e) => e instanceof GroupwareError && match.test(e.message));
    assert.deepEqual(calls, []);
  });
}

// ---- attendees (Task 4's writes use these)
const ME = { empSeq: "E1", empName: "홍길동", deptSeq: "D1", deptName: "개발팀", compSeq: "1000", positionName: "주임" };
const KIM_DEV = { empSeq: "E7", empName: "김민수", deptSeq: "D2", deptName: "개발팀", compSeq: "1000", positionName: "주임" };
const KIM_HR = { empSeq: "E8", empName: "김민수", deptSeq: "D3", deptName: "인사팀", compSeq: "1000", positionName: "대리" };
const search = (all) => fake((_p, body) => all.filter((x) => x.empName.includes(body.searchText)));

test("resolveAttendees pins one person, each once", async () => {
  const { fetch, calls } = search([ME, KIM_DEV, KIM_HR]);
  const out = await resolveAttendees(RES, ["홍길동", "김민수 개발", "김민수 개발"], { fetch });
  assert.deepEqual(out.map((p) => p.empSeq), ["E1", "E7"]);
  assert.deepEqual(calls[1].body, { searchText: "김민수", orgGubunList: ["U"] });
});

for (const [entry, match] of [["김민수", /후보: 김민수 \(개발팀\/주임\), 김민수 \(인사팀\/대리\)/],
  ["김민수 재무", /후보/], ["박없음", /찾지 못했습니다/]]) {
  test(`resolveAttendees refuses ${entry}`, async () => {
    const { fetch } = search([KIM_DEV, KIM_HR]);
    await assert.rejects(resolveAttendees(RES, [entry], { fetch }), (e) => e instanceof GroupwareError && match.test(e.message));
  });
}

// ---- date helpers
test("toApiDay and toApiDt", () => {
  assert.equal(toApiDay("2026-10-9"), "20261009");
  assert.equal(toApiDt("2026-10-09 4:05"), "202610090405");
  assert.throws(() => toApiDay("10/19"), /10\/19/);
  assert.throws(() => toApiDay("2026-02-30"), /YYYY-MM-DD/);
  assert.throws(() => toApiDt("2026-10-09 24:00"), /YYYY-MM-DD HH:MM/);
  assert.throws(() => toApiDt("2026-10-09"), /YYYY-MM-DD HH:MM/);
});

// ---- resources
const resFake = (calls) => fake((path) => path === "/schres/rs121A01"
  ? { resultList: [{ resSeq: "7", resName: "회의실 A", attrName: "회의실", apprYn: "N" },
    { resSeq: "8", resName: "투싼", attrName: "차량", apprYn: "Y" }] }
  : { resultList: [
    { resName: "회의실 A", reqText: "주간 회의", empName: "김", resStartDate: "209910011400", resEndDate: "209910011500", statusCode: "20" },
    { resName: "회의실 B", reqText: "면접", empName: "이", resStartDate: "209910021000", resEndDate: "209910021130", statusCode: "10" }] }, calls);

test("fetchResources request and fields", async () => {
  const { fetch, calls } = resFake();
  const out = await fetchResources(RES, {}, { fetch });
  assert.deepEqual(calls[0], { path: "/schres/rs121A01", body: {
    companyInfo: { compSeq: "1000", groupSeq: "G1", deptSeq: "D1", emailAddr: "", emailDomain: "" },
    searchText: "", langCode: "kr" } });
  assert.deepEqual(out, [{ res_seq: "7", name: "회의실 A", category: "회의실", approval_required: false },
    { res_seq: "8", name: "투싼", category: "차량", approval_required: true }]);
});

test("fetchResources search filters by name or category, since the API ignores it", async () => {
  const names = async (search) => (await fetchResources(RES, { search }, { fetch: resFake().fetch })).map((r) => r.name);
  assert.deepEqual(await names("투싼"), ["투싼"]);
  assert.deepEqual(await names(" 차량 "), ["투싼"]);
  assert.deepEqual(await names("회의"), ["회의실 A"]);
  assert.deepEqual(await names("없는것"), []);
});

test("fetchResourceSchedule request and fields", async () => {
  const { fetch, calls, paths } = resFake();
  const out = await fetchResourceSchedule(RES, { start: "2099-01-01", end: "2099-01-02", res_seqs: [7] }, { fetch });
  assert.deepEqual(paths(), ["/schres/rs121A01", "/schres/rs121A05"]);   // the ids are checked against the list
  const b = calls[1].body;
  assert.deepEqual([b.startDate, b.endDate], ["20990101", "20990102"]);
  assert.deepEqual(b.resList, [{ resSeq: 7 }]);
  assert.deepEqual(b.statusType, ["10", "20"]);
  assert.equal(b.menuAuth, "USER");
  assert.deepEqual(out, [
    { res_name: "회의실 A", title: "주간 회의", start: "2099-10-01 14:00", end: "2099-10-01 15:00", booker: "김", status: "20" },
    { res_name: "회의실 B", title: "면접", start: "2099-10-02 10:00", end: "2099-10-02 11:30", booker: "이", status: "10" }]);
});

test("fetchResourceSchedule refuses an unknown resource id instead of answering no bookings", async () => {
  const { fetch, paths } = resFake();
  await assert.rejects(fetchResourceSchedule(RES, { start: "2099-01-01", end: "2099-01-01", res_seqs: ["7", "999"] },
    { fetch }), (e) => e instanceof GroupwareError && /999/.test(e.message) && !/7,/.test(e.message));
  assert.deepEqual(paths(), ["/schres/rs121A01"]);
});

test("reservation status codes read as the resource screen names them", async () => {
  const codes = ["RC", "RE", "CO", "RJ", "CR", "AC", "ZZ"];
  const { fetch } = fake((path) => path === "/schres/rs121A01" ? { resultList: [{ resSeq: "7" }] }
    : { resultList: codes.map((statusCode) => ({ resStartDate: "209901011000", resEndDate: "209901011100", statusCode })) });
  const out = await fetchResourceSchedule(RES, { start: "2099-01-01", end: "2099-01-01" }, { fetch });
  assert.deepEqual(out.map((r) => r.status), ["예약완료", "승인요청", "승인완료", "반려", "승인취소", "자동취소", "ZZ"]);
});

test("a range whose start is after its end is refused before any request", async () => {
  const calls = [];
  const { fetch } = fake(() => ({}), calls);
  const late = { start: "2026-10-31", end: "2026-10-01" };
  for (const call of [fetchSchedule(RES, late, { fetch }), fetchResourceSchedule(RES, late, { fetch }),
    fetchMyReservations(RES, late, { fetch }), fetchLeaveRequests(HR, late, { fetch }), fetchApprovals(RES, late, { fetch })]) {
    await assert.rejects(call, (e) => e instanceof GroupwareError && e.message === "시작일(2026-10-31)이 종료일(2026-10-01)보다 늦습니다.");
  }
  assert.deepEqual(calls, []);
  assert.equal((await fetchSchedule(RES, { start: "2099-01-01", end: "2099-01-01" },
    { fetch: fake((p) => (p.endsWith("sc111A02") ? { resultList: [] } : {})).fetch })).length, 0);   // one day is fine
});

test("fetchResourceSchedule defaults to all resources", async () => {
  const { fetch, calls, paths } = resFake();
  await fetchResourceSchedule(RES, { start: "2099-01-01", end: "2099-01-01" }, { fetch });
  assert.deepEqual(paths(), ["/schres/rs121A01", "/schres/rs121A05"]);
  assert.deepEqual(calls[1].body.resList, [{ resSeq: "7" }, { resSeq: "8" }]);
});

test("fetchMyReservations request and fields", async () => {
  const rows = [{ resSeq: "12", resName: "대회의실 회의실", reqText: "주간", startDate: "202610191400", endDate: "202610191500", statusCode: "RC" },
    { resSeq: "12", resName: "대회의실 회의실", reqText: "취소됨", startDate: "202610190700", endDate: "202610190730", statusCode: "CA" },
    { resSeq: "16", resName: "투싼", reqText: "외근", startDate: "202610201000", endDate: "202610201800", statusCode: "AR" }];
  const { fetch, calls } = fake(() => ({ resourceSearchList: rows }));
  const out = await fetchMyReservations(RES, { start: "2026-10-01", end: "2026-10-31" }, { fetch });
  const { path, body } = calls[0];
  assert.equal(path, "/schres/rs121A08");
  assert.deepEqual([body.myResYn, body.startDate, body.endDate, body.menuAuth, body.attrSeq, body.pageNum, body.pageSize],
    ["Y", "20261001", "20261031", "USER", "A", 1, 100]);
  // a cancelled booking is history, not a booking; unknown status codes pass through
  assert.deepEqual(out, [
    { res_seq: "12", resource: "대회의실 회의실", title: "주간", start: "2026-10-19 14:00", end: "2026-10-19 15:00", status: "예약완료" },
    { res_seq: "16", resource: "투싼", title: "외근", start: "2026-10-20 10:00", end: "2026-10-20 18:00", status: "AR" }]);
});

// ---- schedule
const CALS = [{ mcalSeq: 134, calType: "E", displayYn: "Y", calTitle: "개인", calColor: "#111" },
  { mcalSeq: 35, calType: "M", displayYn: "Y", adminYn: "Y", calTitle: "공용 일정" },
  { mcalSeq: 99, calType: "M", displayYn: "N", calTitle: "숨김" }];
const SCH = { schSeq: 8439, schTitle: "주간회의", startDate: "202610191400", endDate: "202610191500", alldayYn: "N",
  schPlace: "대회의실", calTitle: "공용 일정", createName: "김", partName: "홍길동", contents: "안건<br>1. 예산" };
const schFake = (rows, calls) => fake((path) => ({ resultList: path.endsWith("sc111A02") ? CALS : rows }), calls);

test("fetchSchedule reads every shown calendar", async () => {
  const { fetch, calls, paths } = schFake([SCH]);
  const out = await fetchSchedule(RES, { start: "2026-10-19", end: "2026-10-23" }, { fetch });
  assert.deepEqual(paths(), ["/schres/sc111A02", "/schres/sc111A03"]);
  const body = calls[1].body;
  assert.deepEqual([body.startDate, body.endDate, body.mySchYn, body.sortDate], ["20261019", "20261023", "N", "Y"]);
  assert.deepEqual(body.calList, [   // the hidden calendar is left out
    { mcalSeq: "134", calType: "E", adminYn: "N", color: "#111" },
    { mcalSeq: "35", calType: "M", adminYn: "Y", color: "#748FFC" }]);
  assert.deepEqual([body.tcalList, body.acalList, body.excelYn, body.abUID, body.searchEmpSeq],
    [[], [], null, "", ""]);
  assert.deepEqual(out, [{ sch_seq: 8439, title: "주간회의", start: "2026-10-19 14:00", end: "2026-10-19 15:00",
    all_day: false, place: "대회의실", calendar: "공용 일정", creator: "김", participants: "홍길동", memo: "안건\n1. 예산" }]);
});

test("fetchSchedule mine_only and the memo cut", async () => {
  const { fetch, calls } = schFake([{ ...SCH, contents: "가".repeat(400) }]);
  const out = await fetchSchedule(RES, { start: "2026-10-19", end: "2026-10-19", mine_only: true }, { fetch });
  assert.equal(calls[1].body.mySchYn, "Y");
  assert.equal(out[0].memo, "가".repeat(300) + " …(생략)");
});

test("fetchSchedule asks for a shorter range instead of dumping hundreds", async () => {
  const { fetch } = schFake(Array(201).fill(SCH));
  await assert.rejects(fetchSchedule(RES, { start: "2026-01-01", end: "2026-12-31" }, { fetch }),
    (e) => e instanceof GroupwareError && /201건/.test(e.message) && /mine_only=true/.test(e.message));
  const ok = schFake(Array(200).fill(SCH));
  assert.equal((await fetchSchedule(RES, { start: "2026-01-01", end: "2026-12-31" }, { fetch: ok.fetch })).length, 200);
});

test("fetchSchedule rejects a bad date before sending", async () => {
  const { fetch, calls } = schFake([SCH]);
  await assert.rejects(fetchSchedule(RES, { start: "10/19", end: "2026-10-23" }, { fetch }), /10\/19/);
  assert.deepEqual(calls, []);
});

// ---- approvals
const DOC = { DOC_ID: 1000187, FORM_ID: 2036, DOC_TITLE: "휴가신청", FORM_NM: "휴가신청서", DOC_STS: "90", DOC_STSNM: "종결",
  DOC_NO: "개발팀-휴가-20260923-0001", CREATED_NM: "홍길동", DEPT_NM: "개발팀", CREATED_DT: "2026-09-23 09:19:04",
  END_DT: "2026-09-23 11:02:52", FILE_CNT: 0 };
const eapFake = (shape = "list", rows = [DOC], calls) => fake(() => ({ [shape]: { list: rows, totalCount: rows.length } }), calls);

for (const [box, path, pageCode, picker, boxId, menuNo, shape] of [
  ["submitted", "/eap/eap107A04", "UBA1010", "REP_DT", "1000300", "1000400", "list"],
  ["draft", "/eap/eap107A06", "UBA1020", "REP_DT", "1000300", "1000500", "list"],
  ["pending", "/eap/eap105A04", "UBA2020", "ARRIVED_DT", "1000900", "1001000", "map"]]) {
  test(`fetchApprovals box contract: ${box}`, async () => {
    const { fetch, calls } = eapFake(shape);
    const out = await fetchApprovals(RES, { box, start: "2026-09-01", end: "2026-09-30", page: 2, count: 10 }, { fetch });
    const { path: sent, body } = calls[0];
    assert.equal(sent, path);
    assert.deepEqual([body.pageCode, body.periodPicker, body.sortField, body.eaBoxId, body.upperMenuNo, body.menuNo, body.nMenuID],
      [pageCode, picker, picker, boxId, boxId, menuNo, menuNo]);
    assert.deepEqual([body.sfrDt, body.stoDt, body.page, body.pageSize], ["20260901", "20260930", "2", "10"]);
    assert.deepEqual([body.fDocSts, body.sFormId, body.sortType, body.useElasticSearch, body.useElasticSearch_new],
      [[], ["0"], "DESC", true, true]);
    assert.deepEqual(out, [{ doc_id: 1000187, form_id: 2036, title: "휴가신청", form: "휴가신청서", status: "종결",
      doc_no: "개발팀-휴가-20260923-0001", drafter: "홍길동", dept: "개발팀", created: "2026-09-23 09:19",
      finished: "2026-09-23 11:02", attachments: 0 }]);
  });
}

test("fetchApprovals defaults to this year and rejects unknown boxes", async () => {
  const { fetch, calls } = eapFake();
  await fetchApprovals(RES, {}, { fetch });
  await assert.rejects(fetchApprovals(RES, { box: "done" }, { fetch }),
    (e) => e instanceof GroupwareError && /submitted, draft, pending/.test(e.message));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].body.sfrDt, calls[0].body.stoDt], [`${year}0101`, `${year}1231`]);
});

const APPROVAL_LINE = [
  { work_order: 1, seq: 1, act_nm: "결재", user_nm: "홍길동", duty_nm: "팀원", dept_nm: "개발팀", app_yn: "0", work_status: "999" },
  { work_order: 1, seq: 2, act_nm: "합의", user_nm: "김팀장", duty_nm: "팀장", dept_nm: "회계팀", app_yn: "0", work_status: "999" }];

for (const asList of [true, false]) {
  test(`fetchApproval maps the document (${asList ? "info-list" : "info-dict"})`, async () => {
    const info = { doc_title: "휴가신청", user_nm: "홍길동", dept_nm: "개발팀", form_nm: "휴가신청서" };
    const detail = { doc_sts: "90", html: "<p>제목</p><p>_DF10_</p><p>_DF11_</p>",
      mainhtml: "<p>사유: 개인 사정</p><script>x()</script>", jsonKyuljaeArr: APPROVAL_LINE,
      resultMap: { appdocinfo: asList ? [info] : info, fileAttachInfo: [{}, {}] } };
    const { fetch, calls } = fake(() => detail);
    const out = await fetchApproval(RES, { doc_id: 1000187, form_id: 2036 }, { fetch });
    assert.deepEqual(calls, [{ path: "/eap/eap110A03", body: { docID: "1000187", formID: "2036", approkey: "", pageCode: "UBAP001" } }]);
    assert.deepEqual(out, { title: "휴가신청", status: "종결", drafter: "홍길동", dept: "개발팀", form: "휴가신청서",
      approval_line: [{ order: 1, step: "결재", name: "홍길동", duty: "팀원", dept: "개발팀" },
        { order: 2, step: "합의", name: "김팀장", duty: "팀장", dept: "회계팀" }],
      attachments: 2, body: "사유: 개인 사정" });
  });
}

test("fetchApproval body falls back to the stored contents", async () => {
  const { fetch } = fake(() => ({ doc_sts: "20", html: "<p>_DF11_</p>", resultMap: { appdocinfo: { doc_title: "출장" }, appdoccontent: [
    { doc_id: "7", contents_tp: "10", doc_contents: "<body><p>출장 목적: 고객 미팅</p></body>" }] } }));
  const out = await fetchApproval(RES, { doc_id: 7, form_id: 2040 }, { fetch });
  assert.deepEqual([out.status, out.body], ["상신", "출장 목적: 고객 미팅"]);
  const bare = { doc_title: "출장", jsonKyuljaeArr: [], resultMap: { appdoccontent: [] } };
  assert.equal((await fetchApproval(RES, { doc_id: 7, form_id: 2040 }, { fetch: fake(() => bare).fetch })).body, "");
});

test("fetchApproval reports an unknown document instead of an empty one", async () => {
  // live: doc_id 1 / form_id 1 answers success with every field empty
  for (const reply of [{}, { resultMap: { appdocinfo: [], appdoccontent: [] }, jsonKyuljaeArr: [] }]) {
    await assert.rejects(fetchApproval(RES, { doc_id: 1, form_id: 1 }, { fetch: fake(() => reply).fetch }),
      (e) => e instanceof GroupwareError && /결재 문서\(doc_id 1, form_id 1\)를 찾을 수 없습니다/.test(e.message));
  }
});

// ---- listings fail closed: Python's `(data or {}).get(key) or []` raises on anything but a dict
// holding a list of dicts, so a reply like that is an error here too, never an empty listing
const unexpected = (e) => e instanceof GroupwareError && /unexpected response/.test(e.message);
const RANGE = { start: "2099-01-01", end: "2099-01-01" };
const listings = (answer) => [
  fetchResources(RES, {}, { fetch: fake(answer).fetch }),
  fetchResourceSchedule(RES, { ...RANGE, res_seqs: ["7"] },
    { fetch: fake((p) => (p === "/schres/rs121A01" ? { resultList: [{ resSeq: "7" }] } : answer())).fetch }),
  fetchMyReservations(RES, RANGE, { fetch: fake(answer).fetch }),
  fetchSchedule(RES, RANGE, { fetch: fake(answer).fetch }),   // the calendar list
  fetchSchedule(RES, RANGE, { fetch: fake((p) => (p.endsWith("sc111A02") ? { resultList: CALS } : answer())).fetch }),   // the rows
];

for (const [id, data] of [["bare-list", [{ resSeq: "7", schSeq: 1 }]], ["true", true], ["string", "x"], ["number", 1],
  ["list-field-a-dict", { resultList: { a: 1 }, resourceSearchList: { a: 1 } }],
  ["null-row", { resultList: [null], resourceSearchList: [null] }],
  ["string-row", { resultList: ["x"], resourceSearchList: ["x"] }]]) {
  test(`resource and schedule listings refuse a reply that is not a list of rows: ${id}`, async () => {
    for (const call of listings(() => data)) await assert.rejects(call, unexpected);
  });
}

for (const [id, data] of [["null", null], ["empty-dict", {}], ["empty-list", []],
  ["field-null", { resultList: null, resourceSearchList: null }], ["field-empty-dict", { resultList: {}, resourceSearchList: {} }]]) {
  test(`resource and schedule listings read an empty reply as no rows: ${id}`, async () => {
    for (const call of listings(() => data)) assert.deepEqual(await call, []);
  });
}
