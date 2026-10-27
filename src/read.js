// The reads: each fetchX(session, args, {fetch}) takes the tool's parameters by their names and
// returns the objects the tool answers with.
import { GroupwareError, request } from "./client.js";
import html5 from "./entities.js";

// ---- HTML to text (mirrors _Text + _clean; every step is linear: no backtracking regexes
// over other people's mail, no per-line regex on a long run of spaces)
const SKIP = new Set(["style", "script", "title"]);
const BREAK = new Set(["br", "p", "div", "li", "tr", "td", "th", "table", "ul", "ol",
  "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
// CPython's html.unescape: html5 is its entity table (names with and without ";")
const INVALID_CHARREFS = { 0: "\ufffd", 13: "\r", 128: "\u20ac", 129: "\x81", 130: "\u201a", 131: "\u0192",
  132: "\u201e", 133: "\u2026", 134: "\u2020", 135: "\u2021", 136: "\u02c6", 137: "\u2030", 138: "\u0160",
  139: "\u2039", 140: "\u0152", 141: "\x8d", 142: "\u017d", 143: "\x8f", 144: "\x90", 145: "\u2018",
  146: "\u2019", 147: "\u201c", 148: "\u201d", 149: "\u2022", 150: "\u2013", 151: "\u2014", 152: "\u02dc",
  153: "\u2122", 154: "\u0161", 155: "\u203a", 156: "\u0153", 157: "\x9d", 158: "\u017e", 159: "\u0178" };
const invalidCodepoint = (n) => (n >= 1 && n <= 8) || n === 11 || (n >= 14 && n <= 31) || (n >= 127 && n <= 159)
  || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function replaceCharref(s) {
  if (s[0] === "#") {
    const num = /^#[xX]/.test(s) ? parseInt(s.slice(2).replace(/;$/, ""), 16) : parseInt(s.slice(1).replace(/;$/, ""), 10);
    if (has(INVALID_CHARREFS, num)) return INVALID_CHARREFS[num];
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
    return invalidCodepoint(num) ? "" : String.fromCodePoint(num);
  }
  if (has(html5, s)) return html5[s];
  for (let x = s.length - 1; x > 1; x--) if (has(html5, s.slice(0, x))) return html5[s.slice(0, x)] + s.slice(x);
  return "&" + s;
}

export function unescape(s) {
  return s.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (_, g) => replaceCharref(g));
}
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

// index of the ">" that ends the tag starting at i, skipping quoted attribute values; -1 if none.
// A quote opens a value only after "="; one with no closer is plain text (and is not searched again).
function tagEnd(s, i, noQuote) {
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === ">") return i;
    if (ch !== "=") continue;
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j++;
    const q = s[j];
    if ((q !== '"' && q !== "'") || noQuote.has(q)) continue;
    const close = s.indexOf(q, j + 1);
    if (close < 0) noQuote.add(q);
    else i = close;
  }
  return -1;
}

export function clean(text, limit = 4000) {
  const s = String(text ?? "");
  const out = [];
  let skip = 0, i = 0, noGt = false;
  const noQuote = new Set();
  const data = (end) => { if (!skip && end > i) out.push(unescape(s.slice(i, end))); };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { data(s.length); break; }
    const next = s[lt + 1] ?? "";
    let gt = -1;
    if (s.startsWith("<!--", lt)) {
      const e = s.indexOf("-->", lt + 4);
      data(lt); i = e < 0 ? s.length : e + 3;
      continue;
    }
    const opens = /[a-zA-Z/!?]/.test(next);
    if (opens && !noGt) {
      gt = tagEnd(s, lt + 1, noQuote);
      if (gt < 0) noGt = true;   // no ">" anywhere after: don't search again
    }
    // Python's parser keeps an unterminated "<x", "</", "<!" or "<?" in its buffer and close() drops it
    if (gt < 0 && opens) {
      data(lt);
      break;
    }
    if (gt < 0) {   // a "<" that opens no tag is text; resume right after it
      data(lt + 1); i = lt + 1;
      continue;
    }
    data(lt);
    const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(s.slice(lt, Math.min(gt + 1, lt + 40)));
    i = gt + 1;
    if (!m) continue;   // <!doctype>, <?xml?>, "</ >"
    const tag = m[2].toLowerCase();
    if (SKIP.has(tag)) {
      skip = m[1] ? Math.max(0, skip - 1) : skip + 1;
      if (!m[1] && tag !== "title") {   // style/script content is raw text up to the closing tag
        const close = new RegExp(`</${tag}`, "gi");
        close.lastIndex = i;
        const c = close.exec(s);
        const e = c ? s.indexOf(">", c.index) : -1;
        if (!c || e < 0) break;   // unclosed: the rest is inside the block
        i = e + 1; skip--;
      }
    } else if (BREAK.has(tag)) out.push("\n");
  }
  const lines = out.join("").replace(ZERO_WIDTH, "").split("\n").map((l) => l.trim());
  let res = lines.filter(Boolean).join("\n");
  if (res.length > limit) res = res.slice(0, limit) + " …(생략)";
  return res;
}

// ---- small helpers
export function fmtStamp(s) {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length < 12 ? "" : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
}
const fmtDate = (ymd) => {
  const d = String(ymd ?? "").replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
};
// strptime("%Y-%m-%d") takes an unpadded month or day; a plain Error, like Python's ValueError
export function toApiDay(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s));
  const [y, mo, d] = m ? m.slice(1).map(Number) : [];
  const ok = m && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!ok) throw new Error(`날짜 '${s}'은(는) 'YYYY-MM-DD' 형식이어야 합니다.`);
  return `${m[1]}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}
// YYYYMMDD strings compare as dates; a reversed range would quietly answer for some other period
function inOrder(first, last) {
  if (first && last && first > last) {
    throw new GroupwareError(`시작일(${fmtDate(first)})이 종료일(${fmtDate(last)})보다 늦습니다.`);
  }
  return [first, last];
}
const pad = (n) => String(n).padStart(2, "0");
const ymdOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;   // local time, like datetime.now()
// Python's float(): "-", "----", "" and null are the API's empties and read as 0
export const num = (v) => {
  if (typeof v === "number" || typeof v === "boolean") return Number(v);
  return typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v) ? Number(v) : 0;
};
const truthy = (v) => v === true || String(v).toLowerCase() === "true";
const fileName = (f) => {
  const name = f.originalFileName || "", ext = f.fileExtsn || "";
  return ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${name}.${ext}` : name;
};

// ---- alerts
export async function fetchAlerts(session, { count = 20 } = {}, { fetch } = {}) {
  const { groupSeq, empSeq } = session.user;
  const data = (await request(session, "/event/event02A01", {
    header: { groupSeq, empSeq },
    body: { reqType: "2", reqSubType: "N", pageSize: String(count), newYn: "N", mentionYn: "N",
      langCode: "kr", eventType: "", searchType: "received", timeStamp: Date.now() },
  }, { fetch })) || {};
  return [...(data.specialAlertList || []), ...(data.alertList || [])].map((a) => {
    const msg = a.message || {};
    return { id: a.alertId ?? null, title: msg.alertTitle || "", content: clean(msg.alertContent),
      time: fmtStamp(a.createDate), unread: !/^\d{14}/.test(String(a.readDate || "")) };
  });
}

// ---- mail
async function mailBoxes(session, fetch) {
  return ((await request(session, "/mail/mail000A01", {}, { fetch })) || {}).mailboxList || [];
}

export async function fetchMailFolders(session, _args = {}, { fetch } = {}) {
  // the counts arrive as strings ("34")
  return (await mailBoxes(session, fetch)).map((b) => ({ name: b.name || "",
    unread: Number(b.unseen || 0), total: Number(b.exists || 0) }));
}

export async function fetchMailList(session, { box = "INBOX", count = 20, unread_only = false, page = 1,
  query = "", flagged_only = false, with_attachments = false, to_me_only = false } = {}, { fetch } = {}) {
  const everything = box.toUpperCase() === "ALL";
  let boxName, seq;
  if (everything) [boxName, seq] = ["ALLBOX", "0"];
  else {
    // folder ids differ per user, so look them up by name
    const boxes = await mailBoxes(session, fetch);
    const match = boxes.find((b) => String(b.name).toLowerCase() === box.toLowerCase());
    if (!match) {
      throw new GroupwareError(`메일함 '${box}'이(가) 없습니다. 쓸 수 있는 값: ALL, ${boxes.map((b) => b.name).join(", ")}`);
    }
    [boxName, seq] = [match.name, String(match.mboxSeq)];
  }
  // mail003A01 lists one folder, mail003A02 lists all mail (it ignores the folder),
  // mail003A03 searches inside the folder; mail019A01 is only the new-mail poll
  const code = query ? "mail003A03" : everything ? "mail003A02" : "mail003A01";
  const body = { boxName, mboxSeq: seq, mainApiCode: code, page, pageSize: count, sort: "rfc822date",
    sortType: "desc", listType: "", showType: "", seen: false };
  const flags = { seen: unread_only, flag: flagged_only, attach: with_attachments, toMe: to_me_only };
  for (const [k, on] of Object.entries(flags)) if (on) body[k] = "true";   // list filters, not state changes
  if (query) Object.assign(body, { search: query, type: "all" });
  const data = await request(session, `/mail/${code}`, body, { fetch });
  return ((data || {}).Records || []).map((m) => ({
    muid: m.muid ?? null,
    box: m.boxName || "",   // the mail's own folder, even in the all-mail list: mail_mark and mail_delete need it
    from: m.fromAddrName || m.fromAddrEmail || "",
    subject: m.subject || "",
    date: fmtStamp(m.tooltipDate),   // rfc822date is display-only: "10-15 04:19"
    unread: ["0", "n", "false"].includes(String(m.seen).toLowerCase()),
    has_attachment: truthy(m.attach),
  }));
}

export async function fetchMail(session, { muid } = {}, { fetch } = {}) {
  // opening an unread mail marks it read on the server (live-checked 2026-10-16)
  const data = (await request(session, "/mail/mail002A01", { uid: String(muid) }, { fetch })) || {};
  const head = data.decodeMime || {}, mime = data.mime || {}, body = mime.body || {};
  // the header fields arrive HTML-escaped: "이름 &lt;a@b.com&gt;"
  const text = Object.fromEntries(["subject", "from", "to", "cc"].map((k) => [k, unescape(head[k] || "")]));
  return {
    ...text,
    date: head.date || "",   // "YYYY-MM-DD HH:MM"
    body: clean(body.plain || body.html),   // HTML-only mails have no plain part
    attachments: (mime.fileList || []).map(fileName),
  };
}

export async function collectMailCorrespondence(session, { person, start = null, end = null,
  include_unread = false, limit = 20 } = {}, { fetch } = {}) {
  person = person.trim();
  if ([...person].length < 2) {   // one letter matches nearly every mail, and include_unread would open them
    throw new GroupwareError("person은 이름이나 이메일 일부로 2자 이상 넣어 주세요.");
  }
  if (!(limit >= 1 && limit <= 50)) throw new GroupwareError("limit은 1~50 사이여야 합니다.");   // a negative limit would open everything
  // normalized, so an unpadded "2026-10-1" still compares as a date
  const [first, last] = inOrder(start ? toApiDay(start) : "", end ? toApiDay(end) : "");
  const lo = first ? fmtDate(first) : "", hi = last ? fmtDate(last) : "9999-12-31";
  // ponytail: the first search page only (50 rows); older mail with this person can be missed
  const rows = await fetchMailList(session, { box: "ALL", count: 50, query: person }, { fetch });
  const picked = rows.filter((m) => lo <= m.date.slice(0, 10) && m.date.slice(0, 10) <= hi
    && (include_unread || !m.unread));
  const needle = person.toLowerCase(), found = [];
  for (const m of picked.slice(0, limit)) {
    // the headers prove the person is on the mail; opening an unread one marks it read
    const head = await fetchMail(session, { muid: m.muid }, { fetch });
    if ([head.from, head.to, head.cc].join("\n").toLowerCase().includes(needle)) found.push(m);
  }
  return found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---- boards
export async function fetchBoardList(session, _args = {}, { fetch } = {}) {
  const data = await request(session, "/board/APIHandler/getBoardListForPortlet", {}, { fetch });
  // portlet pseudo-boards (최근공지글 등) have no cat_seq_no and can't be listed: drop them
  return ((data || {}).boardDirList || []).filter((b) => b.cat_seq_no).map((b) => ({
    board_id: b.cat_seq_no,   // the board identifier ViewBoardArtList's boardNo takes
    name: b.dir_nm_lang || b.dir_nm || "",
    level: b.dir_lvl ?? null,
  }));
}

const BOARD_FIELDS = { title: "searchTitle", author: "searchNick", body: "searchDesc", all: "searchTotal" };

export async function fetchBoardPosts(session, { board_id, page = 1, count = 20, query = "",
  field = "title" } = {}, { fetch } = {}) {
  const body = { boardNo: String(board_id), page, pageSize: String(count), sort: "write_date", sortType: "desc" };
  if (query) body[BOARD_FIELDS[field]] = query;
  const data = await request(session, "/board/APIHandler/ViewBoardArtList", body, { fetch });
  return ((data || {}).articleList || []).map((a) => ({
    art_seq_no: a.art_seq_no ?? null,
    title: a.art_title || "",
    author: a.mbr_nick || "",
    date: fmtStamp(a.write_date_origin || a.write_date),   // list write_date is date-only
    unread: String(a.art_read_yn) !== "Y",
    comments: num(a.comment_cnt),   // the count arrives as a string ("1"), or null for none
    notice: String(a.notice_yn) === "Y",
  }));
}

export async function searchBoardPosts(session, { query, field = "title", board_id = null, count = 20 } = {},
  { fetch } = {}) {
  query = query.trim();
  if (!query) throw new GroupwareError("검색어가 비어 있습니다.");
  if (!(field in BOARD_FIELDS)) throw new GroupwareError(`field는 ${Object.keys(BOARD_FIELDS).join(", ")} 중 하나여야 합니다.`);
  let boards = await fetchBoardList(session, {}, { fetch });
  if (board_id !== null && board_id !== undefined) {
    boards = boards.filter((b) => String(b.board_id) === String(board_id));
    if (!boards.length) throw new GroupwareError(`게시판 ${board_id}을(를) 찾을 수 없습니다.`);
  }
  const hits = [];
  // ponytail: one request per board (7 today); the upstream all-board search sees only 3 notices
  for (const b of boards) {
    const posts = await fetchBoardPosts(session, { board_id: b.board_id, page: 1, count, query, field }, { fetch });
    hits.push(...posts.map((p) => ({ ...p, board: b.name })));
  }
  hits.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  return hits.slice(0, count);
}

export async function fetchBoardPost(session, { art_seq_no } = {}, { fetch } = {}) {
  const data = (await request(session, "/board/APIHandler/ViewPost", {
    art_seq_no: String(art_seq_no), adminPage: "N", externalYn: "N", menuCode: "UFA", pageCode: "UFA1000",
    moduleCode: "UF", presentPassword: "", isPrint: "N", searchParams: null,
  }, { fetch })) || {};
  const art = data.art || {};
  // ViewPost goes out with an empty password: never pass on a post the UI would gate
  if ((data.view_perm_yn != null && data.view_perm_yn !== "Y") || art.art_password || art.del_yn === "Y") {
    throw new GroupwareError("열람 권한이 없거나 비밀번호가 걸린(또는 삭제된) 글입니다.");
  }
  // comments live in the groupware's shared comment store (the post view's comment box), not in ViewPost
  const talk = (await request(session, "/gw/api/gw026A03", { moduleGbnCode: "board", moduleSeq: String(art_seq_no),
    commentType: "", commentSeq: "", sort: "A", searchWay: "D", pageSize: 1000 }, { fetch })) || {};
  return {
    title: art.art_title || "",
    author: art.mbr_nick || "",
    date: fmtStamp(art.write_date),
    body: clean(art.art_content || art.contents_text || art.contents),
    comments: (talk.commentList || []).filter((c) => c.useYn !== "N").map((c) => ({ author: c.empName || "",
      date: fmtStamp(c.createDate), text: c.commentPassword ? "(비밀 댓글)" : clean(c.contents) })),
  };
}

// ---- leave
export function erp(session) {
  // the HR APIs key on the ERP company and employee codes; a guessed company code would
  // quietly read the wrong records, so a session without them is an error
  const { erpCoCd, erpEmpCd } = session.user || {};
  if (!erpCoCd || !erpEmpCd) throw new GroupwareError("세션에 ERP 사번/회사 코드가 없습니다. 다시 로그인해 주세요.");
  return [erpCoCd, erpEmpCd];
}

export async function fetchLeaveBalance(session, _args = {}, { fetch, now = () => new Date() } = {}) {
  const [coCd, empCd] = erp(session);
  const today = ymdOf(now());
  const data = await request(session, "/human/common/annualleave/getAnnualLeaveInfoOfEmployee",
    { coCd, empCd, startDate: today, endDate: today, startTm: "0000", endTm: "0000" }, { fetch });
  if (!data || (typeof data === "object" && !Object.keys(data).length)) throw new GroupwareError("연차 정보를 받지 못했습니다.");
  const detail = data.annualLeaveDetail || {};
  const bucket = (prefix) => {
    const total = num(detail[`${prefix}TotalCnt`]), used = num(detail[`${prefix}UsedCnt`]);
    const pending = num(detail[`${prefix}ProgressCnt`]);
    return { total, used, pending, remaining: total - used - pending };
  };
  return { year: data.year ?? null, total: num(data.totalCnt), used: num(data.usedCnt),
    remaining: num(data.unusedCnt), pending: num(data.progressCnt), basic: bucket("basic"),
    compensation: bucket("compensation"), substitute: bucket("substitute") };
}

// 1 seen live (all 종결 in EAP); 2 and 5 from the web client; others pass through
const LEAVE_STATUS = { 1: "결재완료", 2: "결재 문서 없음", 5: "임시보관" };

export async function fetchLeaveRequests(session, { start = null, end = null } = {}, { fetch, now = () => new Date() } = {}) {
  const [coCd, empCd] = erp(session);
  const year = now().getFullYear();
  const [first, last] = inOrder(start ? toApiDay(start) : `${year}0101`, end ? toApiDay(end) : `${year}1231`);
  const rows = await request(session, "/human/attendapplication/at00001",
    { employeeList: [{ coCd, empCd }], startDate: first, endDate: last, approState: "", linkKey: "" }, { fetch });
  // allowlist: linkKey and approKey are the HR system's internal keys and stay here
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    type: r.atItemNm || r.atCdNm || "",
    start: fmtDate(r.startDt),
    end: fmtDate(r.endDt),
    days: num(r.ycUseCnt),   // annual leave used: 0 for other leave and trips, however long
    hours: num(r.appTm) / 60,   // the time applied for, in minutes: what a part day keeps
    time: /^\d{4}$/.test(r.startTm) && /^\d{4}$/.test(r.endTm)
      ? `${r.startTm.slice(0, 2)}:${r.startTm.slice(2)}~${r.endTm.slice(0, 2)}:${r.endTm.slice(2)}` : "",
    reason: r.appRmkDc || "",
    status: r.approStateNm || (has(LEAVE_STATUS, String(r.approState)) ? LEAVE_STATUS[String(r.approState)] : r.approState || ""),
    doc_id: r.idDoc ?? null,   // an e-approval document id, for approval_read
    canceled: String(r.reportCancYn) === "Y",
  }));
}

// ---- people
export const companyInfo = (session) => {
  const u = session.user || {};
  return { compSeq: u.compSeq ?? null, groupSeq: u.groupSeq ?? null, deptSeq: u.deptSeq || "",
    emailAddr: u.emailAddr || "", emailDomain: u.emailDomain || "" };
};

export async function people(session, name, { fetch } = {}) {
  const rows = await request(session, "/gw/APIHandler/gw102A04", { searchText: name, orgGubunList: ["U"] }, { fetch });
  return Array.isArray(rows) ? rows : [];
}

// allowlist: the org APIs also return login ids, org keys and paths, and gw102A02 adds
// birthdays, phones, home addresses and private mail; none of it leaves here
const publicPerson = (p) => ({ name: p.empName || "", department: p.deptName || "",
  position: p.positionName || "", duty: p.dutyName || "" });

export async function searchPeople(session, { name } = {}, { fetch } = {}) {
  name = name.trim();
  if ([...name].length < 2) throw new GroupwareError("이름은 2자 이상으로 검색해 주세요.");   // one letter lists nearly everyone
  return (await people(session, name, { fetch })).slice(0, 20).map(publicPerson);
}

export async function fetchDeptMembers(session, { dept = null } = {}, { fetch } = {}) {
  dept = dept !== null && dept !== undefined ? String(dept).trim() : "";
  if (dept && !(/^[0-9]+$/.test(dept) && /[1-9]/.test(dept))) {
    throw new GroupwareError("dept는 부서 ID(숫자)입니다. 내 부서는 dept를 비워 두세요.");
  }
  const deptSeq = dept || String((session.user || {}).deptSeq || "");
  if (!deptSeq) throw new GroupwareError("세션에 부서 정보가 없습니다. 다시 로그인해 주세요.");   // an empty selectedId must never stand for "every department"
  const rows = await request(session, "/gw/APIHandler/gw102A02",
    { orderText: "", selectedId: deptSeq, orgGubun: "d", popupType: "main", selectedType: "tree", searchDiv: "all",
      searchText: "", isBdayOption: "0", isJoinDayOption: "0", isOrganizationDisplayOption: "5|0|1|3|",
      isGridListDisplayOption: "0", isLoginIdOption: "0" }, { fetch });
  // the display flags do not hold back birthdays or login ids (seen live), so the allowlist is the only filter
  return (Array.isArray(rows) ? rows : []).filter((p) => p.orgGubun === "u").map(publicPerson);
}

async function resolveAttendee(session, entry, fetch) {
  // "이름" or "이름 부서": the hint picks one of several people with the same name
  const trimmed = entry.trim(), sp = trimmed.indexOf(" ");
  const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
  const hint = (sp < 0 ? "" : trimmed.slice(sp + 1)).trim().toLowerCase();
  const found = (await people(session, name, { fetch })).filter((p) => p.empName === name);
  const picked = found.filter((p) => String(p.deptName ?? "").toLowerCase().includes(hint));
  if (picked.length === 1) return picked[0];
  if (!found.length) throw new GroupwareError(`참석자 '${entry}'을(를) 찾지 못했습니다.`);
  const list = found.map((p) => `${p.empName} (${p.deptName}/${p.positionName})`).join(", ");
  throw new GroupwareError(`참석자 '${entry}'을(를) 한 명으로 정하지 못했습니다. 후보: ${list}. '이름 부서'로 지정해 주세요.`);
}

export async function resolveAttendees(session, entries, { fetch } = {}) {
  // each entry pinned to one person before anything is written; a person named twice, once
  const out = [];
  for (const entry of entries || []) {
    const p = await resolveAttendee(session, entry, fetch);
    if (out.every((q) => String(p.empSeq) !== String(q.empSeq))) out.push(p);
  }
  return out;
}

// ---- dates (local time, naive, like Python's datetime.strptime)
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/.exec(String(s));
  const [y, mo, d, h, mi] = m ? m.slice(1).map(Number) : [];
  const ok = m && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h < 24 && mi < 60;
  if (!ok) throw new Error(`시각 '${s}'은(는) 'YYYY-MM-DD HH:MM' 형식이어야 합니다.`);
  const date = new Date(2000, mo - 1, d, h, mi);
  date.setFullYear(y);
  return date;
}
export function toApiDt(s) {
  const d = parseLocal(s);
  return `${ymdOf(d)}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ---- resources
// Python's `(data or {}).get(key) or []`, with the AttributeError it raises on anything else made
// explicit: an empty or missing reply is no rows, but a reply that is not a dict holding a list of
// dicts is an error, never an empty listing (a write's read-back must not read it as "gone")
const pyEmpty = (v) => !v || (typeof v === "object" && !Object.keys(v).length);
const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function rowsOf(data, key, path) {
  if (pyEmpty(data)) return [];
  const rows = isDict(data) ? data[key] : undefined;
  if (!isDict(data) || (!pyEmpty(rows) && !(Array.isArray(rows) && rows.every(isDict)))) {
    throw new GroupwareError(`${path}: unexpected response`);
  }
  return pyEmpty(rows) ? [] : rows;
}

export async function fetchResources(session, { search = "" } = {}, { fetch } = {}) {
  const data = await request(session, "/schres/rs121A01",
    { companyInfo: companyInfo(session), searchText: search, langCode: "kr" }, { fetch });
  const rows = rowsOf(data, "resultList", "/schres/rs121A01").map((r) => ({
    res_seq: r.resSeq ?? null,
    name: r.resName || "",
    category: r.attrName || "",
    approval_required: String(r.apprYn) === "Y",
  }));
  // the API takes searchText and ignores it (live 2026-10-27): filter here
  const needle = String(search).trim().toLowerCase();
  return needle ? rows.filter((r) => `${r.name} ${r.category}`.toLowerCase().includes(needle)) : rows;
}

export async function scheduleRows(session, start, end, resSeqs, fetch) {
  const data = await request(session, "/schres/rs121A05",
    { companyInfo: companyInfo(session), langCode: "kr", ...dayRange(start, end),
      resList: resSeqs.map((resSeq) => ({ resSeq })), statusType: ["10", "20"], statusCode: "", sechText: "",
      resUserName: "", menuAuth: "USER" }, { fetch });
  return rowsOf(data, "resultList", "/schres/rs121A05");
}

export async function fetchResourceSchedule(session, { start, end, res_seqs = null } = {}, { fetch } = {}) {
  dayRange(start, end);   // bad or reversed dates fail before any request
  const known = (await fetchResources(session, {}, { fetch })).map((r) => r.res_seq);
  if (res_seqs === null || res_seqs === undefined) res_seqs = known;
  const unknown = res_seqs.filter((s) => !known.some((k) => String(k) === String(s)));
  // an unknown id would be left out silently and read as "no bookings"
  if (unknown.length) throw new GroupwareError(`자원 ${unknown.join(", ")}을(를) 찾을 수 없습니다. resource_list의 res_seq를 넣어 주세요.`);
  return (await scheduleRows(session, start, end, res_seqs, fetch)).map((r) => ({
    res_name: r.resName || "",
    title: r.reqText || "",
    start: fmtStamp(r.resStartDate),
    end: fmtStamp(r.resEndDate),
    booker: r.empName || "",
    status: resStatus(r.statusCode),
  }));
}

// the resource module's own labels (/modules/schres); an unknown code passes through as it comes
const RES_STATUS = { RC: "예약완료", RE: "승인요청", CO: "승인완료", RJ: "반려", CA: "취소", CR: "승인취소", AC: "자동취소" };
const resStatus = (code) => (has(RES_STATUS, String(code)) ? RES_STATUS[String(code)] : code ?? null);
// {startDate, endDate} for the resource APIs, in order
const dayRange = (start, end) => {
  const [startDate, endDate] = inOrder(toApiDay(start), toApiDay(end));
  return { startDate, endDate };
};

export async function fetchMyReservations(session, { start, end } = {}, { fetch } = {}) {
  const data = await request(session, "/schres/rs121A08",
    { companyInfo: companyInfo(session), menuAuth: "USER", attrSeq: "A", ...dayRange(start, end),
      statusCode: "", sechText: "", pageNum: 1, pageSize: 100, myResYn: "Y", langCode: "kr" },
    { fetch });
  // ponytail: first 100 only; add paging if one range ever holds more of your own bookings
  return rowsOf(data, "resourceSearchList", "/schres/rs121A08").filter((r) => String(r.statusCode) !== "CA").map((r) => ({
    res_seq: r.resSeq ?? null,
    resource: r.resName || "",
    title: r.reqText || "",
    start: fmtStamp(r.startDate),
    end: fmtStamp(r.endDate),
    status: resStatus(r.statusCode),
  }));
}

// ---- schedules
export async function calendars(session, { fetch } = {}) {
  const data = await request(session, "/schres/sc111A02",
    { companyInfo: companyInfo(session), langCode: "kr", calType: "" }, { fetch });
  return rowsOf(data, "resultList", "/schres/sc111A02");
}

export async function calendarRows(session, first, last, cals, mineOnly = false, { fetch } = {}) {
  const data = await request(session, "/schres/sc111A03",
    { companyInfo: companyInfo(session), startDate: first, endDate: last, mySchYn: mineOnly ? "Y" : "N",
      calList: cals.map((c) => ({ mcalSeq: String(c.mcalSeq), calType: c.calType ?? null,
        adminYn: c.adminYn || "N", color: c.calColor || "#748FFC" })),
      tcalList: [], acalList: [], searchEmpSeq: "", excelYn: null, abUID: "", sortDate: "Y", langCode: "kr" },
    { fetch });
  return rowsOf(data, "resultList", "/schres/sc111A03");
}

export async function fetchSchedule(session, { start, end, mine_only = false } = {}, { fetch } = {}) {
  const [first, last] = inOrder(toApiDay(start), toApiDay(end));   // bad or reversed dates fail before any request
  const shown = (await calendars(session, { fetch })).filter((c) => c.displayYn !== "N");
  const rows = await calendarRows(session, first, last, shown, mine_only, { fetch });
  if (rows.length > 200) {   // every calendar over a long range would flood the model's context
    throw new GroupwareError(`일정이 ${rows.length}건이라 너무 많습니다. 기간을 줄이거나 mine_only=true로 다시 요청해 주세요.`);
  }
  return rows.map((r) => ({
    sch_seq: r.schSeq ?? null,   // what schedule_update and schedule_delete take
    title: r.schTitle || "",
    start: fmtStamp(r.startDate),
    end: fmtStamp(r.endDate),
    all_day: String(r.alldayYn) === "Y",
    place: r.schPlace || "",
    calendar: r.calTitle || "",
    creator: r.createName || "",
    participants: r.partName || "",
    memo: clean(r.contents, 300),
  }));
}

// ---- approvals
// per box: path, pageCode, periodPicker, eaBoxId, menuNo, response container
// (menuNo from the approval side-menu tree; all three listed live 2026-10-16)
const APPROVAL_BOXES = {
  submitted: ["/eap/eap107A04", "UBA1010", "REP_DT", "1000300", "1000400", "list"],
  draft: ["/eap/eap107A06", "UBA1020", "REP_DT", "1000300", "1000500", "list"],
  pending: ["/eap/eap105A04", "UBA2020", "ARRIVED_DT", "1000900", "1001000", "map"],
};
const DOC_STATUS = { 10: "임시보관", 20: "상신", 90: "종결" };
const docStatus = (v) => (has(DOC_STATUS, String(v)) ? DOC_STATUS[String(v)] : v);

export async function fetchApprovals(session, { box = "submitted", start = null, end = null, page = 1, count = 20 } = {},
  { fetch, now = () => new Date() } = {}) {
  if (!has(APPROVAL_BOXES, box)) throw new GroupwareError(`box는 ${Object.keys(APPROVAL_BOXES).join(", ")} 중 하나여야 합니다.`);
  const [path, pageCode, picker, boxId, menuNo, shape] = APPROVAL_BOXES[box];
  const year = now().getFullYear();
  const [first, last] = inOrder(start ? toApiDay(start) : `${year}0101`, end ? toApiDay(end) : `${year}1231`);
  const data = await request(session, path, {
    fDocSts: [], page: String(page), pageSize: String(count), eaBoxId: boxId, nMenuID: menuNo, sfrDt: first,
    stoDt: last, sFormId: ["0"], periodPicker: picker, sortField: picker, sortType: "DESC", docContentsData: {},
    item: {}, useElasticSearch: true, useElasticSearch_new: true, pageCode, upperMenuNo: boxId, menuNo }, { fetch });
  return ((((data || {})[shape]) || {}).list || []).map((d) => ({
    doc_id: d.DOC_ID ?? null,
    form_id: d.FORM_ID ?? null,
    title: d.DOC_TITLE || "",
    form: d.FORM_NM || "",
    status: d.DOC_STSNM || docStatus(d.DOC_STS ?? null),
    doc_no: d.DOC_NO || "",
    drafter: d.CREATED_NM || "",
    dept: d.DEPT_NM || "",
    created: fmtStamp(d.CREATED_DT),
    finished: fmtStamp(d.END_DT),
    attachments: d.FILE_CNT ?? null,
  }));
}

export async function fetchApproval(session, { doc_id, form_id } = {}, { fetch } = {}) {
  const data = (await request(session, "/eap/eap110A03",
    { docID: String(doc_id), formID: String(form_id), approkey: "", pageCode: "UBAP001" }, { fetch })) || {};
  const m = data.resultMap || {};
  let info = m.appdocinfo || {};
  if (Array.isArray(info)) info = info[0] || {};
  const status = String(data.doc_sts || info.doc_sts || "");
  const content = (m.appdoccontent && m.appdoccontent.length ? m.appdoccontent : [{}])[0];
  const title = info.doc_title || data.doc_title || "", line = data.jsonKyuljaeArr || [];
  // an unknown id answers success with every field empty; a real document has a title and a line
  if (!title && !line.length) {
    throw new GroupwareError(`결재 문서(doc_id ${doc_id}, form_id ${form_id})를 찾을 수 없습니다. approval_list의 doc_id·form_id를 넣어 주세요.`);
  }
  return {
    title,
    status: docStatus(status),
    drafter: info.user_nm || data.user_nm || "",
    dept: info.dept_nm || data.dept_nm || "",
    form: info.form_nm || "",
    // live 2026-10-16: work_order was 1 on every step and app_yn "0" even on a finished
    // document, so seq gives the order and no per-step approval flag is claimed
    approval_line: line.map((s) => ({
      order: s.seq ?? null,
      step: s.act_nm || "",
      name: s.user_nm || "",
      duty: s.duty_nm || "",
      dept: s.dept_nm || "",
    })),
    attachments: (m.fileAttachInfo || []).length,
    // html is the form template (_DFxx_ placeholders); the filled body is mainhtml, else the
    // stored contents. Someone else's HTML: cleaned like mail and posts, never followed
    body: clean(data.mainhtml || content.doc_contents),
  };
}
