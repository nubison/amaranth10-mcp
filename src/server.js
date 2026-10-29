// The MCP server: 30 tools with their names, descriptions, annotations and parameters, each one
// call through a shared Groupware. stdout carries MCP only.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Groupware } from "./client.js";
import * as read from "./read.js";
import * as write from "./write.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
// opening marks the mail read / bumps the post's view count: a change, but nothing is lost
const OPENS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, openWorldHint: false };
const SENDS = { readOnlyHint: false, openWorldHint: true };   // it leaves the groupware, to anyone, for good

// Some clients (Claude Desktop) send a list, number or flag as JSON text: parse it for the int, bool
// and list fields, not for str | int, where "123" stays a string. The JSON Schema is unchanged.
const lax = (t) => z.preprocess((v) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch {
    return v;
  }
}, t);

const strOrInt = z.union([z.string(), z.number().int()]);
const int = (d) => lax(z.number().int().min(1).default(d));   // every count, page and limit starts at 1
const str = (d) => z.string().default(d);
const flag = lax(z.boolean().default(false));
const orNone = (t) => t.nullable().default(null);
const listOrNone = (t) => lax(orNone(z.array(t)));

const APPROVE = "사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.";
const LINK = "성공하면 link(그룹웨어에서 바로 여는 주소)를 돌려주니 사용자에게 그대로 보여 줄 것.";
const UNCLEAR = "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 그룹웨어에서 확인해 달라고 할 것.";

const TOOLS = [
  ["alerts", READ_ONLY, read.fetchAlerts, { count: int(20) },
    "최근 그룹웨어 알림 목록. 안 읽은 알림은 unread=true."],
  ["mail_list", READ_ONLY, read.fetchMailList,
    { box: str("INBOX"), count: int(20), unread_only: flag, page: int(1), query: str(""),
      flagged_only: flag, with_attachments: flag, to_me_only: flag },
    "메일 목록. box는 'ALL'(전체) 또는 메일함 이름(INBOX·SENT 등, mail_folders 참고).\n"
    + "query를 주면 그 메일함 안에서 검색한다. 필터: unread_only(안 읽음), flagged_only(중요),\n"
    + "with_attachments(첨부), to_me_only(나에게 온 메일). page는 1부터. 각 메일의 box는 mail_mark·mail_delete에 쓴다."],
  ["mail_folders", READ_ONLY, read.fetchMailFolders, {},
    "메일함 목록: 이름, 안 읽은 수(unread), 전체 수(total). 이름은 mail_list의 box에 쓴다."],
  ["mail_read", OPENS, read.fetchMail, { muid: strOrInt },
    "메일 본문. 안 읽은 메일은 열면 서버에서 읽음으로 바뀐다. attachments는 첨부파일 이름."],
  ["mail_correspondence", OPENS, read.collectMailCorrespondence,
    { person: z.string(), start: orNone(z.string()), end: orNone(z.string()), include_unread: flag, limit: int(20) },
    "특정 상대와 주고받은 내 메일 모아보기(오래된 것부터). person은 이름이나 이메일 일부.\n"
    + "전체 메일 검색 첫 페이지(50건)에서 후보를 고르고, 메일을 열어 보낸이·받는이·참조에 person이 있는 것만 돌려준다.\n"
    + "기본은 이미 읽은 메일만 연다. include_unread=true면 안 읽은 메일도 열고, 연 메일은 읽음으로 바뀐다.\n"
    + "start/end는 'YYYY-MM-DD'. limit은 여는 최대 건수(1~50). 본문은 mail_read로 본다."],
  ["mail_send", SENDS, write.sendMail,
    { to: lax(z.array(z.string())), cc: listOrNone(z.string()), bcc: listOrNone(z.string()), subject: z.string(),
      body: str(""), confirm: flag },
    `메일 보내기. ${APPROVE}\n`
    + "confirm=false(기본)는 보내지 않고 미리보기(보내는 사람·받는 사람·제목·본문)만 돌려준다.\n"
    + "to·cc·bcc는 메일 주소 목록('a@b.com' 또는 '이름 <a@b.com>'). 주소를 모르면 사용자에게 물어볼 것. "
    + "body는 일반 텍스트(줄바꿈 유지). 첨부·답장·전달은 지원하지 않는다. 보낸 메일은 되돌릴 수 없다.\n"
    + "left_out이 있으면 외부 발송 제한으로 빠진 주소다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 보낸메일함에서 확인해 달라고 할 것."],
  ["mail_delete", WRITES, write.deleteMail, { muids: lax(z.array(strOrInt)), box: str("INBOX"), confirm: flag },
    `메일을 휴지통으로 옮긴다(그룹웨어 휴지통에서 복구할 수 있다). ${APPROVE}\n`
    + "confirm=false(기본)는 옮기지 않고 미리보기만 돌려준다. 승인받기 전에 지울 메일의 제목을 사용자에게 보여 줄 것.\n"
    + "muids는 mail_list의 muid 목록(1~50개), box는 그 메일들의 box(한 번에 한 메일함). 휴지통·스팸함 메일은 지우지 않는다."],
  ["mail_mark", OPENS, write.markMail, { muids: lax(z.array(strOrInt)), box: str("INBOX"), read: flag },
    "메일을 안 읽음으로 표시한다. read=true면 읽음으로 표시한다.\n"
    + "muids는 mail_list의 muid 목록(1~50개), box는 그 메일들의 box(한 번에 한 메일함)."],
  ["board_list", READ_ONLY, read.fetchBoardList, {}, "게시판 목록과 board_id."],
  ["board_posts", READ_ONLY, read.fetchBoardPosts, { board_id: strOrInt, page: int(1), count: int(20) },
    "게시판의 글 목록. 새 글은 날짜와 unread로 판단한다. comments는 댓글 수(숫자)."],
  ["board_search", READ_ONLY, read.searchBoardPosts,
    { query: z.string(), field: str("title"), board_id: orNone(strOrInt), count: int(20) },
    "게시글 검색. field는 'title'(제목)·'author'(작성자)·'body'(본문)·'all'(전체).\n"
    + "board_id를 생략하면 모든 게시판에서 찾아 최신순으로 합친다. board는 게시판 이름."],
  ["board_read", OPENS, read.fetchBoardPost, { art_seq_no: strOrInt },
    "게시글 본문과 댓글. 열 때마다 조회수가 1 오른다. comments는 댓글 목록(작성자·날짜·내용)."],
  ["resource_list", READ_ONLY, read.fetchResources, { search: str("") },
    "예약 가능한 자원(회의실 등) 목록. search를 주면 이름이나 종류(category)에 그 글자가 든 것만."],
  ["resource_schedule", READ_ONLY, read.fetchResourceSchedule,
    { start: z.string(), end: z.string(), res_seqs: listOrNone(z.any()) },
    "기간의 자원 예약 현황. start/end는 'YYYY-MM-DD'(하루 단위, 양 끝 포함).\n"
    + "res_seqs를 생략하면 전체 자원. status는 예약완료·승인요청·승인완료·반려 등."],
  ["resource_my_reservations", READ_ONLY, read.fetchMyReservations, { start: z.string(), end: z.string() },
    "내 자원 예약 목록(취소된 건 제외). start/end는 'YYYY-MM-DD'.\nres_seq·start·end는 resource_update·resource_cancel에 그대로 쓴다."],
  ["resource_reserve", WRITES, write.reserveResource,
    { res_seq: strOrInt, start: z.string(), end: z.string(), title: z.string(), description: str(""),
      attendees: listOrNone(z.string()), confirm: flag },
    `자원 예약. ${APPROVE}\n`
    + "confirm=false(기본)는 예약하지 않고 미리보기만 돌려준다.\n"
    + "start/end는 한국 시간 'YYYY-MM-DD HH:MM'.\nattendees는 참석자 이름 목록(동명이인은 '이름 부서'). 참석자에게 알림이 갈 수 있다. "
    + LINK],
  ["resource_cancel", WRITES, write.cancelReservation,
    { res_seq: strOrInt, start: z.string(), end: z.string(), confirm: flag },
    `본인 자원 예약 취소. ${APPROVE}\n`
    + "confirm=false(기본)는 취소하지 않고 미리보기만 돌려준다.\n"
    + "start/end는 예약의 한국 시간 'YYYY-MM-DD HH:MM'(resource_my_reservations 참고)."],
  ["resource_update", WRITES, write.updateReservation,
    { res_seq: strOrInt, start: z.string(), end: z.string(), title: orNone(z.string()), new_start: orNone(z.string()),
      new_end: orNone(z.string()), description: orNone(z.string()), confirm: flag },
    `본인 자원 예약의 제목·시각·설명 수정. ${APPROVE}\n`
    + "confirm=false(기본)는 바꾸지 않고 before/after 미리보기와 새 시간의 가능 여부(available)만 돌려준다.\n"
    + "res_seq·start·end는 지금 예약의 값(resource_my_reservations 참고), 바꿀 값만 넘긴다. 시각은 한국 시간 'YYYY-MM-DD HH:MM'.\n"
    + "자원을 바꾸려면 resource_cancel 후 resource_reserve. 반복·종일 예약, 첨부나 일정이 연결된 예약, 끝난 예약은 수정하지 않는다. "
    + "참석자에게 변경 알림이 갈 수 있고, 승인이 필요한 자원은 다시 승인 요청이 될 수 있다. " + LINK + " " + UNCLEAR],
  ["people_search", READ_ONLY, read.searchPeople, { name: z.string() },
    "이름으로 직원 찾기(2자 이상, 최대 20명): 이름·부서·직급(position)·직위(duty)."],
  ["dept_members", READ_ONLY, read.fetchDeptMembers, { dept: orNone(strOrInt) },
    "부서원 목록: 이름·부서·직급(position)·직위(duty). dept를 생략하면 내 부서.\n"
    + "dept는 부서 ID(숫자)이며 부서 이름은 받지 않는다."],
  ["schedule_list", READ_ONLY, read.fetchSchedule, { start: z.string(), end: z.string(), mine_only: flag },
    "일정 목록. start/end는 'YYYY-MM-DD'(양 끝 포함). 기본은 볼 수 있는 모든 캘린더\n"
    + "(개인·본부 일정, 구독 캘린더, 근태 신청이 자동으로 올라오는 휴가·출장 캘린더 등), mine_only=true면 내가 만들었거나 참여한 일정만.\n"
    + "휴가·출장 캘린더의 일정은 제목이 '[연차]'처럼 종류만 있고 creator가 당사자다.\n"
    + "200건이 넘으면 기간을 줄여 달라고 답한다. sch_seq는 schedule_update·schedule_delete에 쓴다."],
  ["schedule_create", WRITES, write.createSchedule,
    { title: z.string(), start: z.string(), end: z.string(), place: str(""), memo: str(""),
      attendees: listOrNone(z.string()), confirm: flag },
    `내 개인 캘린더에 일정 등록. ${APPROVE}\n`
    + "confirm=false(기본)는 등록하지 않고 미리보기만 돌려준다. start/end는 한국 시간 'YYYY-MM-DD HH:MM'.\n"
    + "attendees는 참석자 이름 목록(동명이인은 '이름 부서'). 참석자를 넣으면 그 사람들에게 실제로 그룹웨어 초대 알림이 간다.\n"
    + "등록하면 sch_seq를 돌려준다(schedule_update·schedule_delete에 쓴다). 회의실은 resource_reserve로 따로 잡는다. "
    + UNCLEAR],
  ["schedule_update", WRITES, write.updateSchedule,
    { sch_seq: strOrInt, title: orNone(z.string()), start: orNone(z.string()), end: orNone(z.string()), confirm: flag },
    `내 개인 캘린더 일정의 제목·시각 수정. ${APPROVE}\n`
    + "confirm=false(기본)는 바꾸지 않고 before/after 미리보기만 돌려준다. 바꿀 값만 넘긴다. 시각을 옮길 때는 start와 end를 함께 넘긴다.\n"
    + "start/end는 한국 시간 'YYYY-MM-DD HH:MM'. 반복·종일 일정과 자원·다른 참석자·첨부가 걸린 일정은 수정하지 않는다. "
    + UNCLEAR],
  ["schedule_delete", WRITES, write.deleteSchedule, { sch_seq: strOrInt, confirm: flag },
    `내 개인 캘린더 일정 삭제. ${APPROVE}\n`
    + "confirm=false(기본)는 지우지 않고 미리보기만 돌려준다.\n"
    + "반복 일정과 자원·다른 참석자·첨부가 걸린 일정은 지우지 않는다. " + UNCLEAR],
  ["approval_list", READ_ONLY, read.fetchApprovals,
    { box: str("submitted"), start: orNone(z.string()), end: orNone(z.string()), page: int(1), count: int(20) },
    "전자결재 문서 목록. box는 'submitted'(상신)·'draft'(임시보관)·'pending'(미결, 내가 결재할 문서).\n"
    + "start/end는 'YYYY-MM-DD', 생략하면 올해. doc_id·form_id는 approval_read에 쓴다."],
  ["approval_read", OPENS, read.fetchApproval, { doc_id: strOrInt, form_id: strOrInt },
    "전자결재 문서 상세: 결재선과 본문 텍스트. 미결 문서를 열면 기안자에게 열람으로 보일 수 있다."],
  ["leave_balance", READ_ONLY, read.fetchLeaveBalance, {}, "연차 잔여(일반·보상·대체)."],
  ["leave_requests", READ_ONLY, read.fetchLeaveRequests, { start: orNone(z.string()), end: orNone(z.string()) },
    "내 휴가 신청 목록: 종류(type)·기간·연차 사용 일수(days)·신청 시간(hours)·시각(time)·사유·결재 상태(status)·"
    + "취소 여부(canceled). days는 연차에서 빠지는 일수라 기타휴가·출장은 0이고, 반차·시간 단위 신청은 hours와 time으로 본다. "
    + "출장 등 다른 근태 신청도 함께 오며 type으로 구분한다.\n"
    + "start/end는 'YYYY-MM-DD', 생략하면 올해. doc_id는 전자결재 문서 ID라서, approval_list에서\n"
    + "같은 doc_id의 form_id를 찾아 approval_read로 연다. id는 신청 건이며 leave_cancel에 쓴다. 남은 연차는 leave_balance."],
  ["leave_request", WRITES, write.requestLeave,
    { kind: orNone(z.string()), start: orNone(z.string()), end: orNone(z.string()), reason: str(""),
      start_time: orNone(z.string()), approval_line: orNone(z.string()), confirm: flag },
    "연차·반차 신청서를 전자결재로 상신. kind는 연차·오전반차·오후반차·반반차(회사 설정의 이름). start/end는 'YYYY-MM-DD'"
    + "(end 생략 시 하루). 반반차는 start_time('HH:MM')부터 2시간. 주말·휴일로 나뉘는 기간은 구간마다 따로 신청한다.\n"
    + "approval_line은 그룹웨어에 저장된 결재라인의 이름이며 사용자가 고른다. 본인 외 결재자가 없는 결재라인으로는 상신하지 않는다.\n"
    + "입력 폼을 띄울 수 있는 클라이언트에서는 사용자가 폼에서 모든 값을 확인·수정하고 미리보기를 본 뒤 승인해야 상신된다"
    + "(아는 값만 넘기면 폼에 채워지고, confirm은 쓰지 않는다). 폼이 없으면 confirm=false(기본)로 미리보기(시각·차감 일수·"
    + "남는 연차·제목·결재라인)를 받아 사용자에게 보여 주고, 확인받은 뒤에만 confirm=true로 다시 부른다.\n"
    + "상신하면 결재자에게 알림이 간다. 실패해도 다시 시도하지 않는다. 그룹웨어에 신청 수정이 없어서, 바꾸려면 "
    + "leave_cancel로 취소한 뒤 다시 신청한다. " + LINK],
  ["leave_cancel", WRITES, write.cancelLeave, { id: orNone(z.string()), confirm: flag },
    "결재가 끝나지 않은 연차·반차 신청을 취소. 결재진행 중이고 아무도 처리하지 않았으면 회수한 뒤 삭제하고, 임시보관이면 "
    + "삭제하고, 상신대기(결재 문서 없음)면 신청을 지운다. 되돌릴 수 없다. 결재가 끝난 신청은 그룹웨어에서 결재취소해야 한다.\n"
    + "입력 폼을 띄울 수 있는 클라이언트에서는 id 없이 불러도 되며, 사용자가 폼에서 취소할 신청을 고르고 승인하면 바로 취소된다"
    + "(confirm은 쓰지 않는다). 폼이 없으면 id(leave_requests의 id)를 넣어 confirm=false로 미리보기를 받고, 사용자 확인 뒤 "
    + "confirm=true로 실행한다."],
];

// a list is one text block per item ("[]" when empty: no content reads as a failure), anything else
// one block; non-strings as 2-space JSON
const block = (x) => ({ type: "text", text: typeof x === "string" ? x : JSON.stringify(x, null, 2) });

// a preview must not read as done to a model that dropped or misspelled confirm (live 2026-10-28: a model
// called resource_reserve without confirm, got previews back and took them for a failed booking)
const NOT_YET = "미리보기만 했고 아직 실행하지 않았습니다. 사용자가 승인하면 같은 인자에 confirm=true를 더해 다시 호출하세요.";

// the tools that ask the person through a form (MCP elicitation) when the client can show one
const ASKS = new Set([write.requestLeave, write.cancelLeave]);

export function createServer(gw) {
  const server = new McpServer({ name: "amaranth10", version: VERSION });
  // a person filling in a form outlasts the SDK's 60 s request default; no answer is a no
  const elicit = (params) => server.server.elicitInput(params, { timeout: 15 * 60_000 }).catch(() => ({ action: "cancel" }));
  for (const [name, annotations, fn, inputSchema, description] of TOOLS) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      const ask = ASKS.has(fn) && server.server.getClientCapabilities()?.elicitation?.form ? elicit : null;
      try {
        const out = await gw.call((session, fetch) => fn(session, args, { fetch, ask }));
        if ("confirm" in inputSchema && args.confirm !== true && !ask) return { content: [block(out), block(NOT_YET)] };
        return { content: !Array.isArray(out) ? [block(out)] : out.length ? out.map(block) : [block("[]")] };
      } catch (e) {   // Groupware.call hands back a GroupwareError with Korean text
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });
  }
  return server;
}

export async function serve() {
  if (process.stdin.isTTY) console.error("amaranth10-mcp: MCP 클라이언트가 실행하는 서버입니다. 설정은 setup 명령으로 합니다(README).");
  const gw = new Groupware();
  try {
    await gw.verify();   // wrong or missing credentials: the client shows a failed server, not a connected one
  } catch (e) {
    console.error(`amaranth10-mcp: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  await createServer(gw).connect(new StdioServerTransport());
}
