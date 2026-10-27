// alerts, mail, boards, mail correspondence and the HTML-to-text cleaner
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupwareError } from "../src/client.js";
import {
  clean, collectMailCorrespondence, fetchAlerts, fetchBoardList, fetchBoardPost, fetchBoardPosts,
  fetchMail, fetchMailFolders, fetchMailList, searchBoardPosts, unescape,
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

test.beforeEach((t) => t.mock.method(console, "error", () => {}));

test("fetchAlerts merges and marks unread", async () => {
  const { fetch } = fake(() => ({
    specialAlertList: [{ alertId: "1", readDate: "", createDate: "20261015093000",
      message: { alertTitle: "긴급", alertContent: "<b>점검</b>" } }],
    alertList: [{ alertId: "2", readDate: "20261015100000", createDate: "20261015090000",
      message: { alertTitle: "결재", alertContent: "승인됨" } }],
  }));
  const out = await fetchAlerts(SESSION, {}, { fetch });
  assert.deepEqual(out.map((a) => a.id), ["1", "2"]);
  assert.equal(out[0].unread, true);
  assert.equal(out[1].unread, false);
  assert.equal(out[0].content, "점검");
  assert.equal(out[0].time, "2026-10-15 09:30");
});

test("fetchAlerts sends the cookies and the user's seqs", async () => {
  const { fetch, calls } = fake(() => ({}));
  assert.deepEqual(await fetchAlerts({ ...SESSION, user: { groupSeq: "G1", empSeq: "E1" } }, { count: 5 }, { fetch }), []);
  const { path, body, init } = calls[0];
  assert.equal(path, "/event/event02A01");
  assert.ok(init.headers.cookie.includes("oAuthToken="));
  assert.deepEqual(body.header, { groupSeq: "G1", empSeq: "E1" });
  assert.equal(body.body.pageSize, "5");
  assert.equal(body.body.searchType, "received");
  assert.equal(typeof body.body.timeStamp, "number");
});

// counts arrive as strings, as they do live
const FOLDERS = [{ mboxSeq: 2089, name: "INBOX", unseen: "1", exists: "34" },
  { mboxSeq: 2092, name: "SENT", unseen: "0", exists: "9" }];
const MAIL_ROW = { muid: 9, boxName: "INBOX", subject: "회의", fromAddrName: "김", seen: 0,
  tooltipDate: "2026-10-15 12:30:09", rfc822date: "10-15 12:30", attach: true };
const mailFake = (rows = [MAIL_ROW]) => fake((path) =>
  path === "/mail/mail000A01" ? { mailboxList: FOLDERS } : { Records: rows });

test("fetchMailList ALL uses the allbox list", async () => {
  const { fetch, calls, paths } = mailFake();
  const out = await fetchMailList(SESSION, { box: "ALL" }, { fetch });
  assert.deepEqual(paths(), ["/mail/mail003A02"]);
  const b = calls[0].body;
  assert.deepEqual([b.boxName, b.mboxSeq, b.mainApiCode], ["ALLBOX", "0", "mail003A02"]);
  assert.deepEqual([b.page, b.pageSize, b.seen], [1, 20, false]);
  assert.deepEqual(out, [{ muid: 9, box: "INBOX", from: "김", subject: "회의", date: "2026-10-15 12:30",
    unread: true, has_attachment: true }]);
});

test("fetchMailList resolves a folder id in any case", async () => {
  const { fetch, calls, paths } = mailFake();
  await fetchMailList(SESSION, { box: "sent", page: 2 }, { fetch });
  assert.deepEqual(paths(), ["/mail/mail000A01", "/mail/mail003A01"]);
  const b = calls[1].body;
  assert.deepEqual([b.boxName, b.mboxSeq, b.mainApiCode, b.page], ["SENT", "2092", "mail003A01", 2]);
  assert.deepEqual(b, { boxName: "SENT", mboxSeq: "2092", mainApiCode: "mail003A01", page: 2,
    pageSize: 20, sort: "rfc822date", sortType: "desc", listType: "", showType: "", seen: false });
});

test("fetchMailList filters are string flags", async () => {
  const { fetch, calls } = mailFake();
  await fetchMailList(SESSION, { box: "ALL", unread_only: true, flagged_only: true,
    with_attachments: true, to_me_only: true }, { fetch });
  await fetchMailList(SESSION, { box: "ALL" }, { fetch });
  const [on, off] = [calls[0].body, calls[1].body];
  for (const k of ["seen", "flag", "attach", "toMe"]) assert.equal(on[k], "true");
  assert.equal(off.seen, false);
  for (const k of ["flag", "attach", "toMe"]) assert.ok(!(k in off));
});

test("fetchMailList query searches inside the box", async () => {
  const { fetch, calls, paths } = mailFake();
  await fetchMailList(SESSION, { box: "INBOX", query: "NVIDIA", with_attachments: true }, { fetch });
  await fetchMailList(SESSION, { box: "ALL", query: "NVIDIA" }, { fetch });
  assert.deepEqual(paths(), ["/mail/mail000A01", "/mail/mail003A03", "/mail/mail003A03"]);
  const [folder, everywhere] = [calls[1].body, calls[2].body];
  assert.deepEqual(
    [folder.boxName, folder.mboxSeq, folder.mainApiCode, folder.search, folder.type, folder.attach],
    ["INBOX", "2089", "mail003A03", "NVIDIA", "all", "true"]);
  assert.deepEqual([everywhere.boxName, everywhere.mboxSeq], ["ALLBOX", "0"]);
});

test("fetchMailList with an unknown folder lists the real ones", async () => {
  const { fetch, paths } = mailFake();
  await assert.rejects(fetchMailList(SESSION, { box: "업무" }, { fetch }),
    (e) => e instanceof GroupwareError && /ALL, INBOX, SENT/.test(e.message));
  assert.deepEqual(paths(), ["/mail/mail000A01"]);   // no list request
});

test("fetchMailList reads a JSON boolean seen", async () => {
  const { fetch } = mailFake([{ muid: "1", seen: false }, { muid: "2", seen: true }]);
  const out = await fetchMailList(SESSION, { box: "ALL" }, { fetch });
  assert.deepEqual(out.map((m) => m.unread), [true, false]);
});

test("fetchMailFolders fields", async () => {
  const { fetch } = mailFake();
  assert.deepEqual(await fetchMailFolders(SESSION, {}, { fetch }), [
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

test("clean drops zero-width preview padding, raw or as entities", () => {
  assert.equal(clean("‌ ".repeat(500) + "<p>본문</p>"), "본문");
  assert.equal(clean("&zwnj;&nbsp;".repeat(3000) + "<p>본문</p>"), "본문");
});

test("clean drops head, style and script blocks", () => {
  const css = "a{b:c}".repeat(1000);
  const mail = "<html><head><title>제목</title>\n<style>\np{color:red}\n</style></head><body>"
    + `<STYLE>${css}</STYLE><p>real body text</p><script>alert(1)</script></body></html>`;
  assert.equal(clean(mail), "real body text");
});

for (const [name, html, text] of [
  ["table cells", "<td>14:00</td><td>15:00</td>", "14:00\n15:00"],
  ["br", "첫째 줄<br>둘째 줄", "첫째 줄\n둘째 줄"],
  ["paragraphs", "<p>one</p><p>two</p>", "one\ntwo"],
  ["list items", "<ul><li>a</li><li>b</li></ul>", "a\nb"],
  ["inline", "<b>점</b><i>검</i>", "점검"],   // inline tags leave no gap
  ["entities", "a&nbsp;b &#65;&#x42; &lt;c&gt; &copy;", "a b AB <c> ©"],
]) {
  test(`clean keeps block and line breaks: ${name}`, () => assert.equal(clean(html), text));
}

test("clean keeps the text after an unclosed head", () => {
  assert.equal(clean("<head><meta charset='x'><title>t</title><p>본문</p>"), "본문");
});

for (const unit of ["<style", "<", "<a ", " ", "&", "<!--", "&#"]) {
  test(`clean is linear on hostile input: ${JSON.stringify(unit)}`, () => {
    const hostile = unit.repeat(Math.floor(200_000 / unit.length));
    const t0 = performance.now();
    clean(hostile);
    assert.ok(performance.now() - t0 < 1000);
  });
}

test("fetchBoardPosts fields and unread", async () => {
  const { fetch, calls } = fake(() => ({ articleList: [
    { art_seq_no: "100", art_title: "공지", mbr_nick: "관리자", write_date: "2026-10-15",
      write_date_origin: "2026-10-15 09:00:21", art_read_yn: "N", comment_cnt: "3", notice_yn: "Y" }] }));   // a string, as live
  const out = await fetchBoardPosts(SESSION, { board_id: 42 }, { fetch });
  assert.equal(calls[0].path, "/board/APIHandler/ViewBoardArtList");
  assert.deepEqual(calls[0].body, { boardNo: "42", page: 1, pageSize: "20", sort: "write_date",
    sortType: "desc" });   // the board id, sent as the string boardNo
  assert.deepEqual(out[0], { art_seq_no: "100", title: "공지", author: "관리자",
    date: "2026-10-15 09:00", unread: true, comments: 3, notice: true });
});

test("fetchBoardPosts puts the query in the field's own key", async () => {
  const { fetch, calls } = fake(() => ({}));
  await fetchBoardPosts(SESSION, { board_id: 1, query: "q", field: "body" }, { fetch });
  assert.equal(calls[0].body.searchDesc, "q");
});

test("fetchBoardPost body, and comments from the shared comment store", async () => {
  const { fetch, calls } = fake((path) => (path === "/gw/api/gw026A03" ? { commentList: [
    { empName: "댓쓴이", createDate: "2026-10-26 12:44:16", contents: "Zoom 링크 https://zoom.example/j/1", useYn: "Y" },
    { empName: "지운이", createDate: "2026-10-26 13:00:00", contents: "지운 댓글", useYn: "N" },
    { empName: "숨긴이", createDate: "2026-10-26 14:00:00", contents: "비밀 내용", useYn: "Y", commentPassword: "x" }] }
    : { art: { art_title: "제목", mbr_nick: "글쓴이", write_date: "202610151000", art_content: "<p>본문&amp;</p>" },
      remarkList: [] }));   // ViewPost's remarkList stays empty even on a post with comments (live)
  const out = await fetchBoardPost(SESSION, { art_seq_no: 100 }, { fetch });
  assert.equal(calls[0].path, "/board/APIHandler/ViewPost");
  assert.deepEqual(calls[0].body, { art_seq_no: "100", adminPage: "N", externalYn: "N",
    menuCode: "UFA", pageCode: "UFA1000", moduleCode: "UF", presentPassword: "", isPrint: "N",
    searchParams: null });
  assert.deepEqual(calls[1], { path: "/gw/api/gw026A03", body: { moduleGbnCode: "board", moduleSeq: "100", commentType: "",
    commentSeq: "", sort: "A", searchWay: "D", pageSize: 1000 }, init: calls[1].init });
  assert.equal(out.body, "본문&");
  // a deleted comment is left out, a password one keeps its place but not its text
  assert.deepEqual(out.comments, [
    { author: "댓쓴이", date: "2026-10-26 12:44", text: "Zoom 링크 https://zoom.example/j/1" },
    { author: "숨긴이", date: "2026-10-26 14:00", text: "(비밀 댓글)" }]);
});

test("fetchBoardPost asks for no comments on a post it refuses", async () => {
  const { fetch, calls } = fake(() => ({ view_perm_yn: "N", art: { art_title: "제목" } }));
  await assert.rejects(fetchBoardPost(SESSION, { art_seq_no: "100" }, { fetch }), GroupwareError);
  assert.deepEqual(calls.map((c) => c.path), ["/board/APIHandler/ViewPost"]);
});

for (const [name, perm, extra] of [["no permission", "N", {}], ["password", "Y", { art_password: "1234" }],
  ["deleted", "Y", { del_yn: "Y" }]]) {
  test(`fetchBoardPost refuses what the UI would gate: ${name}`, async () => {
    const { fetch } = fake(() => ({ view_perm_yn: perm, art: { art_title: "제목", art_content: "비밀", ...extra } }));
    await assert.rejects(fetchBoardPost(SESSION, { art_seq_no: "100" }, { fetch }),
      (e) => e instanceof GroupwareError && /열람 권한/.test(e.message));
  });
}

test("fetchBoardList uses the dir fields and fallbacks", async () => {
  const { fetch, calls } = fake(() => ({ boardDirList: [
    { cat_seq_no: "42", dir_nm_lang: "공지사항", dir_lvl: 1 },
    { cat_seq_no: "7", dir_nm: "자유게시판", dir_lvl: 2 },
    { dir_nm: "최근공지글", dir_lvl: 1 }] }));
  const out = await fetchBoardList(SESSION, {}, { fetch });
  assert.equal(calls[0].path, "/board/APIHandler/getBoardListForPortlet");
  assert.deepEqual(out, [{ board_id: "42", name: "공지사항", level: 1 },
    { board_id: "7", name: "자유게시판", level: 2 }]);
});

const post = (no, date) => ({ art_seq_no: no, art_title: `글${no}`, mbr_nick: "김",
  write_date_origin: date, art_read_yn: "Y", notice_yn: "N" });
const boardFake = (byBoard) => fake((path, body) => path.endsWith("getBoardListForPortlet")
  ? { boardDirList: [{ cat_seq_no: 1, dir_nm: "일반공지", dir_lvl: 1 },
    { cat_seq_no: 14, dir_nm: "일정공지", dir_lvl: 1 }] }
  : { articleList: byBoard[body.boardNo] ?? [] });

test("searchBoardPosts in one board by author", async () => {
  const { fetch, calls } = boardFake({ 14: [post(5, "2026-10-01 09:00:00")] });
  // the list holds the int 14; the caller's "14" must find it
  const out = await searchBoardPosts(SESSION, { query: "김", field: "author", board_id: "14" }, { fetch });
  const b = calls.at(-1).body;
  assert.deepEqual([b.boardNo, b.searchNick], ["14", "김"]);
  assert.ok(!("searchTitle" in b));
  assert.deepEqual(out.map((p) => [p.art_seq_no, p.board]), [[5, "일정공지"]]);
});

test("searchBoardPosts over all boards merges newest first", async () => {
  const { fetch, calls } = boardFake({ 1: [post(1, "2026-09-01 09:00:00"), post(2, "2026-10-05 09:00:00")],
    14: [post(3, "2026-10-02 09:00:00")] });
  const out = await searchBoardPosts(SESSION, { query: " 규정 ", count: 2 }, { fetch });
  const searched = calls.filter((c) => c.path.endsWith("ViewBoardArtList")).map((c) => c.body);
  assert.deepEqual(searched.map((b) => b.boardNo), ["1", "14"]);
  assert.ok(searched.every((b) => b.searchTitle === "규정"));
  assert.deepEqual(out.map((p) => [p.art_seq_no, p.board]), [[2, "일반공지"], [3, "일정공지"]]);
});

for (const [name, args, match] of [["empty", { query: "  " }, /검색어/],
  ["bad field", { query: "x", field: "date" }, /field/],
  ["no board", { query: "x", board_id: 99 }, /게시판 99/]]) {
  test(`searchBoardPosts rejects bad input: ${name}`, async () => {
    const { fetch, calls } = boardFake({});
    await assert.rejects(searchBoardPosts(SESSION, args, { fetch }),
      (e) => e instanceof GroupwareError && match.test(e.message));
    assert.ok(!calls.some((c) => c.path.endsWith("ViewBoardArtList")));
  });
}

// ---- mail correspondence
const corrRow = (muid, date, sender, seen = 1) => ({ muid, subject: `메일 ${muid}`,
  fromAddrName: sender, seen, tooltipDate: `${date}:00`, attach: false });
const SKY = "최하늘 &lt;sky@example.com&gt;";   // headers arrive HTML-escaped
const ME = "홍길동 &lt;me@example.com&gt;";
const CORR_ROWS = [corrRow(1, "2026-10-15 09:30", "최하늘"), corrRow(2, "2026-10-14 10:00", "최하늘", 0),
  corrRow(3, "2026-10-10 11:00", "공지"), corrRow(4, "2026-10-01 08:00", "홍길동")];
// what mail002A01 says: the person sent 1 and 2, is on cc of 4, and is absent from 3
const corrHeads = () => ({ 1: [SKY, ME, null], 2: [SKY, ME, null],
  3: ["공지 &lt;notice@example.com&gt;", ME, null], 4: [ME, "김민수 &lt;ms@example.com&gt;", SKY] });
function corrFake(heads = corrHeads()) {
  const searches = [], opened = [];
  const f = fake((path, body) => {
    if (path === "/mail/mail003A03") { searches.push(body); return { Records: CORR_ROWS }; }
    const muid = Number(body.uid);
    opened.push(muid);
    const [from, to, cc] = heads[muid];
    return { decodeMime: { subject: `메일 ${muid}`, from, to, cc, date: "2026-10-01 09:00" },
      mime: { body: { plain: "본문" } } };
  });
  return { ...f, searches, opened };
}
const ids = (rows) => rows.map((m) => m.muid);

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

test("mailCorrespondence include_unread opens unread mail too", async () => {
  const { fetch, opened } = corrFake();
  const out = await collectMailCorrespondence(SESSION, { person: "SKY@example", include_unread: true }, { fetch });
  assert.deepEqual(opened, [1, 2, 3, 4]);
  assert.deepEqual(ids(out), [4, 2, 1]);   // part of an address matches, in any case
});

test("mailCorrespondence compares the range as dates", async () => {
  const { fetch, opened } = corrFake();
  const out = await collectMailCorrespondence(SESSION,
    { person: "최하늘", start: "2026-10-1", end: "2026-10-14" }, { fetch });
  assert.deepEqual(opened, [3, 4]);   // 1 is after the range, 2 is unread; "2026-10-1" takes in 10-01
  assert.deepEqual(ids(out), [4]);
});

for (const [name, args, type] of [
  ["blank person", { person: "  " }, GroupwareError], ["one letter", { person: "김" }, GroupwareError],
  ["zero limit", { person: "최하늘", limit: 0 }, GroupwareError],
  ["negative limit", { person: "최하늘", limit: -1 }, GroupwareError],
  ["over a page", { person: "최하늘", limit: 51 }, GroupwareError],
  ["bad date", { person: "최하늘", start: "10/01" }, Error],
]) {
  test(`mailCorrespondence rejects bad input before sending: ${name}`, async () => {
    const { fetch, searches, opened } = corrFake();
    await assert.rejects(collectMailCorrespondence(SESSION, args, { fetch }), type);
    assert.deepEqual([searches, opened], [[], []]);
  });
}

for (const end of ["2026-10-1", "2026-10-9"]) {
  test(`mailCorrespondence end day is inclusive and an unpadded end is a date: ${end}`, async () => {
    const { fetch, opened } = corrFake();
    const out = await collectMailCorrespondence(SESSION, { person: "최하늘", end }, { fetch });
    assert.deepEqual(opened, [4]);
    assert.deepEqual(ids(out), [4]);
  });
}

test("mailCorrespondence keeps mail sent to the person", async () => {
  const heads = corrHeads();
  heads[4] = [ME, SKY, null];   // the person is in To only
  const { fetch } = corrFake(heads);
  assert.deepEqual(ids(await collectMailCorrespondence(SESSION, { person: "최하늘" }, { fetch })), [4, 1]);
});

test("mailCorrespondence limit caps the mail it opens, 50 is allowed, and unread mail takes no slot", async () => {
  const { fetch, opened } = corrFake();
  assert.deepEqual(ids(await collectMailCorrespondence(SESSION, { person: "최하늘", limit: 1 }, { fetch })), [1]);
  assert.deepEqual(opened, [1]);
  opened.length = 0;
  await collectMailCorrespondence(SESSION, { person: "최하늘", limit: 50 }, { fetch });
  assert.deepEqual(opened, [1, 3, 4]);
  opened.length = 0;
  // unread 2 is skipped before the cap, so it takes no slot from limit=2
  const out = await collectMailCorrespondence(SESSION, { person: "최하늘", limit: 2 }, { fetch });
  assert.deepEqual(opened, [1, 3]);
  assert.deepEqual(ids(out), [1]);
});

// expected strings computed with Python's html.unescape
for (const [html, text] of [
  ["&zwnj;&nbsp;x", "‌ x"], ["&copy 2026", "© 2026"], ["&#150;", "–"], ["&#146;", "’"],
  ["&#x110000;", "�"], ["&#xD800;", "�"], ["&#0;", "�"], ["&#1;", ""], ["&#128;", "€"],
  ["&foo;", "&foo;"], ["&notit;", "¬it;"], ["&ampx", "&x"], ["&hearts; &rarr;&euro;", "♥ →€"],
]) {
  test(`unescape matches python: ${JSON.stringify(html)}`, () => assert.equal(unescape(html), text));
}

test("clean keeps a quoted > inside an attribute out of the text", () => {
  assert.equal(clean('<img alt="a>b">z'), "z");
  assert.equal(clean("<a title='x>y' href=\"u\">t</a>"), "t");
  const t0 = performance.now();
  clean('<a b="'.repeat(30000));
  assert.ok(performance.now() - t0 < 1000);
});

test("sparse rows keep their keys as null, like python's None", async () => {
  const { fetch } = fake((path) => path === "/event/event02A01" ? { alertList: [{}] }
    : path.endsWith("ViewBoardArtList") ? { articleList: [{}] }
    : path.endsWith("getBoardListForPortlet") ? { boardDirList: [{ cat_seq_no: "1" }] } : { Records: [{}] });
  assert.equal((await fetchAlerts(SESSION, {}, { fetch }))[0].id, null);
  assert.equal((await fetchMailList(SESSION, { box: "ALL" }, { fetch }))[0].muid, null);
  const p = (await fetchBoardPosts(SESSION, { board_id: 1 }, { fetch }))[0];
  assert.deepEqual([p.art_seq_no, p.comments], [null, 0]);   // no count is no comments
  assert.equal((await fetchBoardList(SESSION, {}, { fetch }))[0].level, null);
});

test("clean drops the rest after an unterminated tag, <! <? or </", () => {
  const cases = [["Z<x&amp;y", "Z"], ["a <b c", "a"], ['a<br>b<img src="x', "a\nb"], ["a</b", "a"],
    ["a<한 <; < b", "a<한 <; < b"],   // "<" not followed by a letter stays text
    ["a<!x", "a"], ["a<?x", "a"], ["a<!doctype", "a"], ["a<![CDATA[x", "a"], ["a</ b", "a"],
    ["a<!-- c -->b", "ab"], ["a<!>b", "ab"], ["a<?php x ?>b", "ab"], ["a</>b", "ab"], ["a<\u0000b", "a<\u0000b"]];
  for (const [html, text] of cases) assert.equal(clean(html), text, JSON.stringify(html));
  const t = Date.now();
  clean("<!".repeat(50000));
  clean("</ ".repeat(50000));
  assert.ok(Date.now() - t < 2000);
});
