// alerts, mail, boards, mail correspondence and the HTML-to-text cleaner
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupwareError } from "../src/client.js";
import {
  clean, collectMailCorrespondence, fetchAlerts, fetchBoardList, fetchBoardPost, fetchBoardPosts,
  fetchMail, fetchMailFolders, fetchMailList, searchBoardPosts,
} from "../src/read.js";

const SESSION = { base: "https://gw.example.com", token: "G1|E1|R1", signKey: "test-sign-key", user: {} };

// a fake fetch: records {path, body} per call and answers with handler(path, body) -> resultData
function fake(handler, calls = []) {
  const fetch = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ path, body, init });
    return new Response(JSON.stringify({ resultCode: 0, resultData: handler(path, body) }));
  };
  return { fetch, calls, paths: () => calls.map((c) => c.path) };
}
const isGw = (re) => (e) => e instanceof GroupwareError && re.test(e.message);

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

test("fetchAlerts request, merge and unread", async () => {
  const { fetch, calls } = fake(() => ({
    specialAlertList: [{ alertId: "1", readDate: "", createDate: "20261015093000",
      message: { alertTitle: "긴급", alertContent: "<b>점검</b>" } }],
    alertList: [{ alertId: "2", readDate: "20261015100000", createDate: "20261015090000",
      message: { alertTitle: "결재", alertContent: "승인됨" } }],
  }));
  const out = await fetchAlerts({ ...SESSION, user: { groupSeq: "G1", empSeq: "E1" } }, { count: 5 }, { fetch });
  const { path, body, init } = calls[0];
  assert.equal(path, "/event/event02A01");
  assert.ok(init.headers.cookie.includes("oAuthToken="));
  assert.deepEqual(body.header, { groupSeq: "G1", empSeq: "E1" });
  assert.deepEqual([body.body.pageSize, body.body.searchType], ["5", "received"]);
  assert.deepEqual(out, [{ id: "1", title: "긴급", content: "점검", time: "2026-10-15 09:30", unread: true },
    { id: "2", title: "결재", content: "승인됨", time: "2026-10-15 09:00", unread: false }]);
});

// counts arrive as strings, as they do live
const FOLDERS = [{ mboxSeq: 2089, name: "INBOX", unseen: "1", exists: "34" },
  { mboxSeq: 2092, name: "SENT", unseen: "0", exists: "9" }];
const MAIL_ROW = { muid: 9, boxName: "INBOX", subject: "회의", fromAddrName: "김", seen: 0,
  tooltipDate: "2026-10-15 12:30:09", attach: true };
const mailFake = (rows = [MAIL_ROW]) => fake((path) =>
  path === "/mail/mail000A01" ? { mailboxList: FOLDERS } : { Records: rows });

test("fetchMailList ALL uses the allbox list", async () => {
  const { fetch, calls, paths } = mailFake([MAIL_ROW, { muid: 2, seen: true }]);
  const out = await fetchMailList(SESSION, { box: "ALL" }, { fetch });
  assert.deepEqual(paths(), ["/mail/mail003A02"]);
  assert.deepEqual(calls[0].body, { boxName: "ALLBOX", mboxSeq: "0", mainApiCode: "mail003A02", page: 1,
    pageSize: 20, sort: "rfc822date", sortType: "desc", listType: "", showType: "", seen: false });
  assert.deepEqual(out, [{ muid: 9, box: "INBOX", from: "김", subject: "회의", date: "2026-10-15 12:30",
    unread: true, has_attachment: true },
  { muid: 2, box: "", from: "", subject: "", date: "", unread: false, has_attachment: false }]);
});

test("fetchMailList resolves a folder in any case, searches in it and sends filters as strings", async () => {
  const { fetch, calls, paths } = mailFake();
  await fetchMailList(SESSION, { box: "sent", page: 2, query: "NVIDIA", unread_only: true, flagged_only: true,
    with_attachments: true, to_me_only: true }, { fetch });
  assert.deepEqual(paths(), ["/mail/mail000A01", "/mail/mail003A03"]);
  const b = calls[1].body;
  assert.deepEqual([b.boxName, b.mboxSeq, b.mainApiCode, b.page, b.search, b.type], ["SENT", "2092", "mail003A03", 2, "NVIDIA", "all"]);
  for (const k of ["seen", "flag", "attach", "toMe"]) assert.equal(b[k], "true");
});

test("fetchMailList with an unknown folder lists the real ones", async () => {
  const { fetch, paths } = mailFake();
  await assert.rejects(fetchMailList(SESSION, { box: "업무" }, { fetch }), isGw(/ALL, INBOX, SENT/));
  assert.deepEqual(paths(), ["/mail/mail000A01"]);   // no list request
});

test("fetchMailFolders fields", async () => {
  assert.deepEqual(await fetchMailFolders(SESSION, {}, { fetch: mailFake().fetch }), [
    { name: "INBOX", unread: 1, total: 34 }, { name: "SENT", unread: 0, total: 9 }]);
});

test("fetchMail cleans the body and formats the fields", async () => {
  // 4,106 chars once tags are gone, &amp; is unescaped and </p> is a line break
  const contents = "<p>A &amp; B</p>" + "<b>x</b>".repeat(4100);
  const { fetch, calls } = fake(() => ({
    decodeMime: { subject: "분기 &amp; 보고", from: "김 &lt;kim@x.com&gt;", to: "이 &lt;lee@x.com&gt;",
      cc: null, date: "2026-10-15 12:30" },
    mime: { body: { plain: "", html: contents }, fileList: [
      { originalFileName: "보고서", fileExtsn: "pdf" }, { originalFileName: "표.XLSX", fileExtsn: "xlsx" }] },
  }));
  const out = await fetchMail(SESSION, { muid: 9 }, { fetch });
  assert.equal(calls[0].path, "/mail/mail002A01");
  assert.deepEqual(calls[0].body, { uid: "9" });   // the list gives an int muid; the API takes a string
  assert.deepEqual(out, {
    subject: "분기 & 보고", from: "김 <kim@x.com>", to: "이 <lee@x.com>", cc: "",
    date: "2026-10-15 12:30",
    body: "A & B\n" + "x".repeat(3994) + " …(생략)",
    attachments: ["보고서.pdf", "표.XLSX"],
  });
});

test("clean turns mail HTML into text", () => {
  for (const [html, text] of [
    ["\u200c ".repeat(500) + "&zwnj;&nbsp;".repeat(500) + "<p>본문</p>", "본문"],   // preview padding
    ["<html><head><title>제목</title>\n<style>\np{color:red}\n</style></head><body><STYLE>a{b:c}</STYLE>"
      + "<p>real body text</p><script>alert('<p>x</p>')</script></body></html>", "real body text"],
    ["<head><meta charset='x'><title>t</title><p>본문</p>", "본문"],
    ["<td>14:00</td><td>15:00</td>", "14:00\n15:00"],
    ["첫째 줄<br/>둘째 줄", "첫째 줄\n둘째 줄"],
    ["<ul><li>a</li><li>b</li></ul>", "a\nb"],
    ["<b>점</b><i>검</i>", "점검"],   // inline tags leave no gap
    ["a&nbsp;b &#65;&#x42; &lt;c&gt; &copy; &foo; &#x110000;", "a\u00a0b AB <c> © &foo; \ufffd"],
    ["<!DOCTYPE html><?xml x?>a<!-- c -->b<![if !x]>c", "abc"],
    ["a<한 <; < b", "a<한 <; < b"],   // "<" that opens no tag stays text
    ["a<script>x", "a"],   // an unclosed script hides the rest
    [null, ""],
  ]) assert.equal(clean(html), text, JSON.stringify(html));
});

test("clean is linear on hostile input", () => {
  for (const unit of ["<style", "<", "<a ", "&", "<!--", "&#", '<a b="', "<!", "</ ", "<a"]) {
    const t0 = performance.now();
    clean(unit.repeat(Math.floor(200_000 / unit.length)));
    assert.ok(performance.now() - t0 < 1000, unit);
  }
});

test("fetchBoardPosts request and fields", async () => {
  const { fetch, calls } = fake(() => ({ articleList: [
    { art_seq_no: "100", art_title: "공지", mbr_nick: "관리자", write_date: "2026-10-15",
      write_date_origin: "2026-10-15 09:00:21", art_read_yn: "N", comment_cnt: "3", notice_yn: "Y" }] }));   // a string, as live
  const out = await fetchBoardPosts(SESSION, { board_id: 42, query: "q", field: "body" }, { fetch });
  assert.equal(calls[0].path, "/board/APIHandler/ViewBoardArtList");
  assert.deepEqual(calls[0].body, { boardNo: "42", page: 1, pageSize: "20", sort: "write_date",
    sortType: "desc", searchDesc: "q" });   // the board id, sent as the string boardNo
  assert.deepEqual(out, [{ art_seq_no: "100", title: "공지", author: "관리자",
    date: "2026-10-15 09:00", unread: true, comments: 3, notice: true }]);
});

test("fetchBoardPost body, and comments from the shared comment store", async () => {
  const { fetch, calls } = fake((path) => (path === "/gw/api/gw026A03" ? { commentList: [
    { empName: "댓쓴이", createDate: "2026-10-26 12:44:16", contents: "Zoom 링크 https://zoom.example/j/1", useYn: "Y" },
    { empName: "지운이", createDate: "2026-10-26 13:00:00", contents: "지운 댓글", useYn: "N" },
    { empName: "숨긴이", createDate: "2026-10-26 14:00:00", contents: "비밀 내용", useYn: "Y", commentPassword: "x" }] }
    : { art: { art_title: "제목", mbr_nick: "글쓴이", write_date: "202610151000", art_content: "<p>본문&amp;</p>" } }));
  const out = await fetchBoardPost(SESSION, { art_seq_no: 100 }, { fetch });
  assert.deepEqual(calls.map((c) => c.path), ["/board/APIHandler/ViewPost", "/gw/api/gw026A03"]);
  assert.deepEqual(calls[0].body, { art_seq_no: "100", adminPage: "N", externalYn: "N",
    menuCode: "UFA", pageCode: "UFA1000", moduleCode: "UF", presentPassword: "", isPrint: "N",
    searchParams: null });
  assert.deepEqual(calls[1].body, { moduleGbnCode: "board", moduleSeq: "100", commentType: "",
    commentSeq: "", sort: "A", searchWay: "D", pageSize: 1000 });
  // a deleted comment is left out, a password one keeps its place but not its text
  assert.deepEqual(out, { title: "제목", author: "글쓴이", date: "2026-10-15 10:00", body: "본문&", comments: [
    { author: "댓쓴이", date: "2026-10-26 12:44", text: "Zoom 링크 https://zoom.example/j/1" },
    { author: "숨긴이", date: "2026-10-26 14:00", text: "(비밀 댓글)" }] });
});

test("fetchBoardPost refuses what the UI would gate, asking for no comments", async () => {
  for (const [perm, extra] of [["N", {}], ["Y", { art_password: "1234" }], ["Y", { del_yn: "Y" }]]) {
    const { fetch, paths } = fake(() => ({ view_perm_yn: perm, art: { art_title: "제목", art_content: "비밀", ...extra } }));
    await assert.rejects(fetchBoardPost(SESSION, { art_seq_no: "100" }, { fetch }), isGw(/열람 권한/));
    assert.deepEqual(paths(), ["/board/APIHandler/ViewPost"]);
  }
});

test("fetchBoardList uses the dir fields and drops pseudo-boards", async () => {
  const { fetch, calls } = fake(() => ({ boardDirList: [
    { cat_seq_no: "42", dir_nm_lang: "공지사항", dir_lvl: 1 },
    { cat_seq_no: "7", dir_nm: "자유게시판", dir_lvl: 2 },
    { dir_nm: "최근공지글", dir_lvl: 1 }] }));
  const out = await fetchBoardList(SESSION, {}, { fetch });
  assert.equal(calls[0].path, "/board/APIHandler/getBoardListForPortlet");
  assert.deepEqual(out, [{ board_id: "42", name: "공지사항", level: 1 },
    { board_id: "7", name: "자유게시판", level: 2 }]);
});

const post = (no, date) => ({ art_seq_no: no, write_date_origin: date });
const boardFake = (byBoard) => fake((path, body) => path.endsWith("getBoardListForPortlet")
  ? { boardDirList: [{ cat_seq_no: 1, dir_nm: "일반공지" }, { cat_seq_no: 14, dir_nm: "일정공지" }] }
  : { articleList: byBoard[body.boardNo] ?? [] });

test("searchBoardPosts in one board by author", async () => {
  const { fetch, calls } = boardFake({ 14: [post(5, "2026-10-01 09:00:00")] });
  // the list holds the int 14; the caller's "14" must find it
  const out = await searchBoardPosts(SESSION, { query: "김", field: "author", board_id: "14" }, { fetch });
  const b = calls.at(-1).body;
  assert.deepEqual([b.boardNo, b.searchNick, b.searchTitle], ["14", "김", undefined]);
  assert.deepEqual(out.map((p) => [p.art_seq_no, p.board]), [[5, "일정공지"]]);
});

test("searchBoardPosts over all boards merges newest first", async () => {
  const { fetch, calls } = boardFake({ 1: [post(1, "2026-09-01 09:00:00"), post(2, "2026-10-05 09:00:00")],
    14: [post(3, "2026-10-02 09:00:00")] });
  const out = await searchBoardPosts(SESSION, { query: " 규정 ", count: 2 }, { fetch });
  const searched = calls.filter((c) => c.path.endsWith("ViewBoardArtList")).map((c) => c.body);
  assert.deepEqual(searched.map((b) => [b.boardNo, b.searchTitle]), [["1", "규정"], ["14", "규정"]]);
  assert.deepEqual(out.map((p) => [p.art_seq_no, p.board]), [[2, "일반공지"], [3, "일정공지"]]);
});

test("searchBoardPosts rejects bad input before searching", async () => {
  for (const [args, match] of [[{ query: "  " }, /검색어/], [{ query: "x", field: "date" }, /field/],
    [{ query: "x", field: "toString" }, /field/], [{ query: "x", board_id: 99 }, /게시판 99/]]) {
    const { fetch, paths } = boardFake({});
    await assert.rejects(searchBoardPosts(SESSION, args, { fetch }), isGw(match));
    assert.ok(!paths().some((p) => p.endsWith("ViewBoardArtList")));
  }
});

// ---- mail correspondence
const corrRow = (muid, date, sender, seen = 1) => ({ muid, subject: `메일 ${muid}`,
  fromAddrName: sender, seen, tooltipDate: `${date}:00`, attach: false });
const SKY = "최하늘 &lt;sky@example.com&gt;";   // headers arrive HTML-escaped
const ME = "홍길동 &lt;me@example.com&gt;";
const CORR_ROWS = [corrRow(1, "2026-10-15 09:30", "최하늘"), corrRow(2, "2026-10-14 10:00", "최하늘", 0),
  corrRow(3, "2026-10-10 11:00", "공지"), corrRow(4, "2026-10-01 08:00", "홍길동")];
// what mail002A01 says: the person sent 1 and 2, is on cc of 4, and is absent from 3
const HEADS = { 1: [SKY, ME, null], 2: [SKY, ME, null], 3: ["공지 &lt;notice@example.com&gt;", ME, null],
  4: [ME, "김민수 &lt;ms@example.com&gt;", SKY] };
function corrFake() {
  const searches = [], opened = [];
  const f = fake((path, body) => {
    if (path === "/mail/mail003A03") { searches.push(body); return { Records: CORR_ROWS }; }
    const muid = Number(body.uid);
    opened.push(muid);
    const [from, to, cc] = HEADS[muid];
    return { decodeMime: { from, to, cc }, mime: { body: { plain: "본문" } } };
  });
  return { ...f, searches, opened };
}
const ids = (rows) => rows.map((m) => m.muid);
const corr = async (args) => {
  const f = corrFake();
  return { ...f, out: ids(await collectMailCorrespondence(SESSION, args, { fetch: f.fetch })) };
};

test("mailCorrespondence opens only read mail and keeps mail naming the person", async () => {
  const { fetch, searches, opened } = corrFake();
  const out = await collectMailCorrespondence(SESSION, { person: " 최하늘 " }, { fetch });
  assert.equal(searches.length, 1);
  const b = searches[0];
  assert.deepEqual([b.boxName, b.mboxSeq, b.mainApiCode, b.search, b.type, b.page, b.pageSize],
    ["ALLBOX", "0", "mail003A03", "최하늘", "all", 1, 50]);
  assert.deepEqual(opened, [1, 3, 4]);   // 2 is unread: never opened, so never marked read
  assert.deepEqual(ids(out), [4, 1]);   // 3 does not name the person; oldest first
  assert.deepEqual(out[0], { muid: 4, box: "", from: "홍길동", subject: "메일 4", date: "2026-10-01 08:00",
    unread: false, has_attachment: false });
});

test("mailCorrespondence include_unread, range and limit", async () => {
  // part of an address matches, in any case; unread mail is opened too
  assert.deepEqual(await corr({ person: "SKY@example", include_unread: true }).then((r) => [r.opened, r.out]),
    [[1, 2, 3, 4], [4, 2, 1]]);
  // the range compares as dates, both ends inclusive: "2026-10-1" takes in 10-01
  assert.deepEqual((await corr({ person: "최하늘", start: "2026-10-1", end: "2026-10-14" })).opened, [3, 4]);
  assert.deepEqual((await corr({ person: "최하늘", end: "2026-10-1" })).opened, [4]);
  // unread 2 is skipped before the cap, so it takes no slot from limit=2
  assert.deepEqual(await corr({ person: "최하늘", limit: 2 }).then((r) => [r.opened, r.out]), [[1, 3], [1]]);
});

test("mailCorrespondence rejects bad input before sending", async () => {
  for (const [args, type] of [[{ person: "  " }, GroupwareError], [{ person: "김" }, GroupwareError],
    [{ person: "최하늘", limit: 0 }, GroupwareError], [{ person: "최하늘", limit: -1 }, GroupwareError],
    [{ person: "최하늘", limit: 51 }, GroupwareError], [{ person: "최하늘", start: "10/01" }, Error],
    [{ person: "최하늘", start: "2026-10-14", end: "2026-10-01" }, GroupwareError]]) {
    const { fetch, calls } = corrFake();
    await assert.rejects(collectMailCorrespondence(SESSION, args, { fetch }), type, JSON.stringify(args));
    assert.deepEqual(calls, []);
  }
});
