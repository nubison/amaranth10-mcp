# amaranth10-mcp

<p align="left">
  <a href="https://github.com/nubison/amaranth10-mcp/actions/workflows/ci.yml"><img src="https://github.com/nubison/amaranth10-mcp/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/nubison/amaranth10-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/nubison/amaranth10-mcp" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3fb950" alt="License: MIT"></a>
</p>

더존 아마란스10(Amaranth 10) 그룹웨어를 Claude 같은 MCP 클라이언트에서 쓰게 해 주는 MCP 서버다. 메일·게시판·알림·자원·일정·전자결재·조직도·연차·휴가를 조회하고, 자원 예약·취소와 개인 일정 등록·수정·삭제를 한다.

> 더존비즈온과 관계없는 독립 오픈소스 프로젝트다. Amaranth 10은 더존비즈온의 상표이며, 이 소프트웨어가 연결하는 서비스를 가리키는 데만 쓴다. 그룹웨어 웹 화면이 쓰는 API를 같은 방식으로 호출하므로, 회사의 IT·보안 정책이 이런 사용을 허용하는지 먼저 확인한다.

## 설치 방법

| 쓰는 곳 | 방법 |
|---|---|
| Claude Code | [npx로 setup](#claude-code) |
| Claude Desktop | [릴리스의 `.mcpb` 확장](#claude-desktop) |
| 서버·컨테이너 | [환경변수](#환경변수로-쓰기-서버컨테이너) |

### Claude Code

필요한 것: Node.js 20 이상, git.

```bash
npx -y github:nubison/amaranth10-mcp#v0.7.0 setup
```

1. `그룹웨어 주소`, `그룹웨어 아이디:`, `비밀번호:`를 차례로 묻는다.
   - 주소는 `https://gw.example.com`처럼 넣는다. 브라우저 주소창의 주소를 그대로 붙여 넣어도 된다. https만 받는다.
   - 비밀번호는 화면에 나오지 않는다.
2. 로그인 화면이 하듯 그 주소로 회사 코드를 조회한 뒤, 아이디와 비밀번호로 한 번 로그인해 본다. 로그인이 거부되면 아무것도 저장하지 않고 끝난다.
3. 저장한다. macOS에서는 비밀번호를 키체인에 넣는다([저장 위치](#주소아이디비밀번호)).
4. `Claude Code에 등록할까요? [Y/n]`에 답하면 `amaranth10`이라는 이름으로 등록한다(user 범위). 등록은 setup을 실행한 그 버전(`#v0.7.0`)으로 고정되어, 새 버전이 나와도 저절로 바뀌지 않는다. 올리려면 새 버전으로 setup을 다시 실행한다.
5. Claude Desktop과 환경변수 방식에 넣을 설정을 출력한다.

Claude Code를 새로 열면 도구가 보인다.

### Claude Desktop

필요한 것: macOS의 [Claude Desktop](https://claude.ai/download). Node는 Desktop에 들어 있다.

1. [최신 릴리스](https://github.com/nubison/amaranth10-mcp/releases/latest)에서 `amaranth10-mcp-v<버전>.mcpb`를 받는다.
2. 받은 파일을 두 번 클릭해 설치한다.
3. 설치 창에서 그룹웨어 주소·아이디·비밀번호를 넣는다. 비밀번호는 Claude Desktop이 보관한다.

### 환경변수로 쓰기 (서버·컨테이너)

setup을 쓸 수 없는 곳에서는 환경변수로 넣는다. `AMARANTH_ID`와 `AMARANTH_PASSWORD`는 그 환경의 비밀값 저장소에 넣고, 설정 파일에 값을 직접 적지 않는다.

```json
{
  "mcpServers": {
    "amaranth10": {
      "command": "npx",
      "args": ["-y", "github:nubison/amaranth10-mcp#v0.7.0"],
      "env": {
        "AMARANTH_URL": "https://gw.example.com",
        "AMARANTH_ID": "${AMARANTH_ID}",
        "AMARANTH_PASSWORD": "${AMARANTH_PASSWORD}"
      }
    }
  }
}
```

- 실행 환경이 그룹웨어 주소, `github.com`, `codeload.github.com`, `registry.npmjs.org`에 https로 접속할 수 있어야 한다. 그룹웨어에 닿지 못하면 모든 도구가 "그룹웨어에 연결하지 못했습니다(…)"라고 답한다.
- 태그(`#v0.7.0`)를 받으려면 git이 필요하다. git이 없는 곳에서는 태그 대신 그 릴리스의 40자리 커밋 해시를 쓴다(`github:nubison/amaranth10-mcp#<커밋 해시>`). 이때는 `github.com` 없이 `codeload.github.com`만 있으면 된다.
- npx는 서버를 띄울 때마다 패키지를 GitHub에서 받는다(약 40KB).

## 도구

| 도구 | 하는 일 |
|---|---|
| `alerts` | 최근 알림 |
| `mail_folders` · `mail_list` · `mail_read` | 메일함, 메일 목록·검색, 메일 본문 |
| `mail_correspondence` | 특정 상대와 주고받은 메일 모아보기 |
| `board_list` · `board_posts` · `board_search` · `board_read` | 게시판, 글 목록·검색, 글 본문과 댓글 |
| `resource_list` · `resource_schedule` · `resource_my_reservations` | 자원(회의실 등), 예약 현황, 내 예약 |
| `resource_reserve` · `resource_cancel` | 자원 예약·취소 (미리보기 후 승인) |
| `people_search` · `dept_members` | 직원 찾기, 부서원 |
| `schedule_list` | 일정 목록 |
| `schedule_create` · `schedule_update` · `schedule_delete` | 개인 일정 등록·수정·삭제 (미리보기 후 승인) |
| `approval_list` · `approval_read` | 전자결재 목록, 결재선과 본문 |
| `leave_balance` · `leave_requests` | 연차 잔여, 휴가 신청 목록 |

## 주소·아이디·비밀번호

- 어디에 두는가
  - macOS: 비밀번호는 키체인(이름 `amaranth10-mcp`, 계정 `아이디@그룹웨어호스트`)에 둔다. 주소와 아이디는 `~/.config/amaranth10-mcp/credentials.json`에 둔다.
  - 그 밖의 OS, 또는 키체인에 넣지 못했을 때: 셋 다 `~/.config/amaranth10-mcp/credentials.json`에 둔다. 디렉터리는 0700, 파일은 0600이라 본인만 읽는다. 비밀번호는 이 파일에 그대로 들어 있다.
  - Claude Desktop 확장: Desktop이 보관한다.
- 무엇이 우선하는가
  - 환경변수 `AMARANTH_URL`이 있으면 그 주소를 쓴다.
  - `AMARANTH_ID`와 `AMARANTH_PASSWORD`가 둘 다 있으면 그 값을 쓴다. 하나만 있으면 무시하고 저장된 값을 쓴다.
- 회사 코드는 따로 넣지 않는다. 로그인할 때마다 로그인 화면이 하는 것처럼 주소로 조회한다.
- 그룹웨어 비밀번호를 바꿨으면 setup을 다시 실행한다(Desktop 확장은 확장 설정에서 바꾼다).
- 전부 지우려면 아래를 실행한다.

  ```bash
  rm ~/.config/amaranth10-mcp/credentials.json
  security delete-generic-password -s amaranth10-mcp -a <아이디>@<그룹웨어호스트>   # macOS
  claude mcp remove amaranth10 -s user
  ```

- 비밀번호·토큰·서명 키는 로그와 도구 출력에 나오지 않는다. 로그는 stderr에 API 경로와 결과 코드만 남긴다.
- 서버는 설정한 그룹웨어 주소에만 요청한다. 사용 기록을 다른 곳으로 보내지 않는다.

## 동작 방식

- 그룹웨어 세션은 메모리에만 둔다. 첫 도구 호출 때 로그인하고, 세션이 끊기면 그 호출 안에서 한 번 다시 로그인해 이어 간다.
- **계정 잠김 방지:** 그룹웨어가 로그인을 거부하면 서버는 그 주소·아이디·비밀번호 조합을 기억하고 다시 보내지 않는다.
  - 그 뒤의 도구 호출은 그룹웨어에 아무 요청도 하지 않고 바로 로그인 실패를 알린다.
  - setup으로 새 비밀번호를 저장하거나 환경변수를 바꾸면 다음 호출에서 한 번 다시 시도한다.
  - 네트워크 오류는 거부로 치지 않는다.
  - 이 기억은 서버 프로세스마다 따로다. 클라이언트를 다시 띄울 때마다 옛 비밀번호로 로그인을 한 번 더 시도하니, 비밀번호를 바꾼 뒤에는 setup을 다시 실행한다.
- 시각은 실행 환경과 상관없이 한국 시간으로 다룬다. 서버가 UTC로 돌아도 `YYYY-MM-DD HH:MM`은 한국 시간이다.
- 쓰기 도구는 `confirm=false`로 미리보기를 보여 주고, 승인 후 `confirm=true`로 실행한다. 쓰기 요청은 한 번만 보내고 다시 보내지 않는다. 결과를 확인하지 못하면 "그룹웨어에서 확인해 주세요."라고 답한다.
- 읽기 도구 중 일부는 그룹웨어에 흔적을 남긴다. 그래서 이 도구들은 읽기 전용으로 표시하지 않는다.
  - `mail_read`: 안 읽은 메일을 열면 읽음으로 바뀐다.
  - `board_read`: 게시글을 열면 조회수가 1 오른다.
  - `approval_read`: 미결 결재 문서를 열면 기안자에게 열람으로 보일 수 있다.
  - `mail_correspondence`: 기본으로 이미 읽은 메일만 연다. `include_unread=true`일 때만 안 읽은 메일도 열어 읽음으로 바꾼다.

## 주의

- 아이디와 비밀번호로 로그인하는 계정만 지원한다. OTP 같은 추가 인증을 거쳐야 로그인되는 계정은 지원하지 않는다.
- 로그인이 거부된 뒤 같은 비밀번호로 setup을 여러 번 다시 실행하면 그때마다 로그인을 한 번씩 보낸다. 그룹웨어가 계정을 잠글 수 있으니 비밀번호를 확인하고 실행한다.
- 포함하지 않는 것: 출퇴근·근무 기록 조회, 휴가 신청, 전자결재 쓰기.

## 개발

```bash
git clone https://github.com/nubison/amaranth10-mcp && cd amaranth10-mcp
npm ci
npm test        # node:test, 그룹웨어에 요청하지 않는다
```

릴리스: `package.json`과 `manifest.json`의 버전을 올리고 README의 버전 표기를 맞춘 뒤 `v<버전>` 태그를 push한다. Actions가 테스트를 돌리고, 그 커밋에서 `.mcpb`를 만들어 릴리스에 붙인다.

## 라이선스

[MIT](LICENSE)
