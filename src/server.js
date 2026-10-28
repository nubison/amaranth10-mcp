// The MCP server: 28 tools with their names, descriptions, annotations and parameters, each one
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

// Python's MCPServer json-parses a string sent for a non-str parameter (Claude Desktop sends lists
// as JSON text) and pydantic's lax mode takes "10" for an int: so for the int, bool and list
// fields here. Not for str | int, where Python keeps "123" a string. The JSON Schema is unchanged.
const lax = (t) => z.preprocess((v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, t);

// Python's annotations: str | int, X | None = None, and defaults filled in before the call
const strOrInt = z.union([z.string(), z.number().int()]);
const int = (d) => lax(z.number().int().min(1).default(d));   // every count, page and limit starts at 1
const str = (d) => z.string().default(d);
const flag = lax(z.boolean().default(false));
const orNone = (t) => t.nullable().default(null);
const listOrNone = (t) => lax(orNone(z.array(t)));

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
    "메일 보내기. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 보내지 않고 미리보기(보내는 사람·받는 사람·제목·본문)만 돌려준다.\n"
    + "to·cc·bcc는 메일 주소 목록('a@b.com' 또는 '이름 <a@b.com>'). 주소를 모르면 사용자에게 물어볼 것. "
    + "body는 일반 텍스트(줄바꿈 유지). 첨부·답장·전달은 지원하지 않는다. 보낸 메일은 되돌릴 수 없다.\n"
    + "left_out이 있으면 외부 발송 제한으로 빠진 주소다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 보낸메일함에서 확인해 달라고 할 것."],
  ["mail_delete", WRITES, write.deleteMail, { muids: lax(z.array(strOrInt)), box: str("INBOX"), confirm: flag },
    "메일을 휴지통으로 옮긴다(그룹웨어 휴지통에서 복구할 수 있다). "
    + "사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
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
    "자원 예약. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 예약하지 않고 미리보기만 돌려준다.\n"
    + "start/end는 한국 시간 'YYYY-MM-DD HH:MM'.\n"
    + "attendees는 참석자 이름 목록(동명이인은 '이름 부서'). 참석자에게 알림이 갈 수 있다."],
  ["resource_cancel", WRITES, write.cancelReservation,
    { res_seq: strOrInt, start: z.string(), end: z.string(), confirm: flag },
    "본인 자원 예약 취소. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 취소하지 않고 미리보기만 돌려준다.\n"
    + "start/end는 예약의 한국 시간 'YYYY-MM-DD HH:MM'(resource_my_reservations 참고)."],
  ["resource_update", WRITES, write.updateReservation,
    { res_seq: strOrInt, start: z.string(), end: z.string(), title: orNone(z.string()), new_start: orNone(z.string()),
      new_end: orNone(z.string()), description: orNone(z.string()), confirm: flag },
    "본인 자원 예약의 제목·시각·설명 수정. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 바꾸지 않고 before/after 미리보기와 새 시간의 가능 여부(available)만 돌려준다.\n"
    + "res_seq·start·end는 지금 예약의 값(resource_my_reservations 참고), 바꿀 값만 넘긴다. "
    + "시각은 한국 시간 'YYYY-MM-DD HH:MM'.\n"
    + "자원을 바꾸려면 resource_cancel 후 resource_reserve. 반복·종일 예약, 첨부나 일정이 연결된 예약, 끝난 예약은 수정하지 않는다. "
    + "참석자에게 변경 알림이 갈 수 있고, 승인이 필요한 자원은 다시 승인 요청이 될 수 있다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 그룹웨어에서 확인해 달라고 할 것."],
  ["people_search", READ_ONLY, read.searchPeople, { name: z.string() },
    "이름으로 직원 찾기(2자 이상, 최대 20명): 이름·부서·직급(position)·직위(duty)."],
  ["dept_members", READ_ONLY, read.fetchDeptMembers, { dept: orNone(strOrInt) },
    "부서원 목록: 이름·부서·직급(position)·직위(duty). dept를 생략하면 내 부서.\n"
    + "dept는 부서 ID(숫자)이며 부서 이름은 받지 않는다."],
  ["schedule_list", READ_ONLY, read.fetchSchedule, { start: z.string(), end: z.string(), mine_only: flag },
    "일정 목록. start/end는 'YYYY-MM-DD'(양 끝 포함). 기본은 볼 수 있는 모든 캘린더\n"
    + "(개인·본부 일정·휴가현황 등), mine_only=true면 내가 만들었거나 참여한 일정만.\n"
    + "200건이 넘으면 기간을 줄여 달라고 답한다. sch_seq는 schedule_update·schedule_delete에 쓴다."],
  ["schedule_create", WRITES, write.createSchedule,
    { title: z.string(), start: z.string(), end: z.string(), place: str(""), memo: str(""),
      attendees: listOrNone(z.string()), confirm: flag },
    "내 개인 캘린더에 일정 등록. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 등록하지 않고 미리보기만 돌려준다. start/end는 한국 시간 'YYYY-MM-DD HH:MM'.\n"
    + "attendees는 참석자 이름 목록(동명이인은 '이름 부서'). 참석자를 넣으면 그 사람들에게 실제로 그룹웨어 초대 알림이 간다.\n"
    + "등록하면 sch_seq를 돌려준다(schedule_update·schedule_delete에 쓴다). 회의실은 resource_reserve로 따로 잡는다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 그룹웨어에서 확인해 달라고 할 것."],
  ["schedule_update", WRITES, write.updateSchedule,
    { sch_seq: strOrInt, title: orNone(z.string()), start: orNone(z.string()), end: orNone(z.string()), confirm: flag },
    "내 개인 캘린더 일정의 제목·시각 수정. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 바꾸지 않고 before/after 미리보기만 돌려준다. 바꿀 값만 넘긴다. 시각을 옮길 때는 start와 end를 함께 넘긴다.\n"
    + "start/end는 한국 시간 'YYYY-MM-DD HH:MM'. 반복·종일 일정과 자원·다른 참석자·첨부가 걸린 일정은 수정하지 않는다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 그룹웨어에서 확인해 달라고 할 것."],
  ["schedule_delete", WRITES, write.deleteSchedule, { sch_seq: strOrInt, confirm: flag },
    "내 개인 캘린더 일정 삭제. 사용자가 미리보기를 보고 명시적으로 승인한 뒤에만 confirm=true로 호출할 것.\n"
    + "confirm=false(기본)는 지우지 않고 미리보기만 돌려준다.\n"
    + "반복 일정과 자원·다른 참석자·첨부가 걸린 일정은 지우지 않는다. "
    + "결과를 확인하지 못했다는 오류가 나면 다시 호출하지 말고, 사용자에게 그룹웨어에서 확인해 달라고 할 것."],
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
    + "같은 doc_id의 form_id를 찾아 approval_read로 연다. 남은 연차는 leave_balance."],
];

// Python MCPServer's _convert_to_content: a list becomes one text block per item (none when
// empty), anything else one block; non-strings as 2-space JSON
const toContent = (x) => (x == null ? [] : Array.isArray(x) ? x.flatMap(toContent)
  : [{ type: "text", text: typeof x === "string" ? x : JSON.stringify(x, null, 2) }]);

export function createServer({ gw = new Groupware() } = {}) {
  const server = new McpServer({ name: "amaranth10", version: VERSION });
  for (const [name, annotations, fn, inputSchema, description] of TOOLS) {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        const out = await gw.call((session, fetch) => fn(session, args, { fetch }));
        // an empty list says so: no content at all reads as a failure or a missing answer
        return { content: Array.isArray(out) && !out.length ? [{ type: "text", text: "[]" }] : toContent(out) };
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
  await createServer({ gw }).connect(new StdioServerTransport());
}
