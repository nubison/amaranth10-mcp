# Amaranth10 MCP

<p align="left">
  <a href="https://github.com/nubison/amaranth10-mcp/actions/workflows/ci.yml"><img src="https://github.com/nubison/amaranth10-mcp/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/nubison/amaranth10-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/nubison/amaranth10-mcp" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3fb950" alt="License: MIT"></a>
</p>

Claude 등 MCP 클라이언트에서 더존 아마란스10(Amaranth 10)의 메일·일정·전자결재를 확인하고, 회의실을 예약하는 MCP 서버입니다. 게시판 검색, 직원 찾기, 연차 조회도 지원합니다.

## 사용 예시

연결한 뒤 Claude에게 다음과 같이 요청해 보세요.

- “오늘 안 읽은 메일을 요약해 줘.”
- “내일 오후 2시부터 3시까지 예약 가능한 회의실을 찾아 줘.”
- “남은 연차가 며칠인지 알려 줘.”

예약·취소나 일정 변경은 미리보기를 확인하고 승인한 뒤 실행합니다. 메일이나 게시글을 열면 읽음 상태나 조회수가 바뀔 수 있습니다. 자세한 내용은 [사용 시 알아둘 점](#사용-시-알아둘-점)을 참고하세요.

## 설치

| 사용 환경 | 설치 방법 |
|---|---|
| Claude Code | [터미널에서 setup 실행](#claude-code) |
| Claude Desktop (macOS) | [확장 파일 설치](#claude-desktop) |
| 서버·컨테이너 등 | [환경변수로 설정](#환경변수로-설정) |

아이디와 비밀번호로 로그인하는 계정을 지원합니다. OTP 등 추가 인증이 필요한 계정은 지원하지 않습니다.

### Claude Code

Node.js 20 이상과 Git이 필요합니다.

```bash
npx -y github:nubison/amaranth10-mcp#v0.7.0 setup
```

1. 그룹웨어 주소(`https://gw.example.com`), 아이디, 비밀번호를 입력합니다.
2. `Claude Code에 등록할까요? [Y/n]`에서 Enter를 누릅니다.
3. Claude Code를 새로 열면 도구를 사용할 수 있습니다.

setup은 로그인을 확인한 뒤 접속 정보를 저장하고, 서버를 `amaranth10`이라는 이름으로 등록합니다. 비밀번호 저장 방식은 [접속 정보 관리](#접속-정보-관리)를 참고하세요.

<details>
<summary>설정 및 업데이트 안내</summary>

- 그룹웨어 주소는 브라우저 주소창의 URL을 그대로 붙여 넣어도 됩니다. HTTPS 주소만 지원합니다.
- 입력한 비밀번호는 화면에 표시되지 않으며, 로그인에 실패하면 접속 정보를 저장하지 않습니다.
- 사용자 범위(`user`)에 등록하므로 다른 프로젝트에서도 사용할 수 있습니다.
- 서버는 setup을 실행한 버전(`v0.7.0`)으로 고정됩니다. 업데이트하려면 명령의 버전 태그를 새 버전으로 바꿔 setup을 다시 실행하세요.
- setup을 마치면 Claude Desktop과 환경변수 방식에 사용할 설정도 출력됩니다.

</details>

### Claude Desktop

macOS용 [Claude Desktop](https://claude.ai/download)에서 확장 파일로 설치할 수 있습니다. Node.js는 별도로 설치하지 않아도 됩니다.

1. [최신 릴리스](https://github.com/nubison/amaranth10-mcp/releases/latest)에서 `amaranth10-mcp-v<버전>.mcpb` 파일을 내려받습니다.
2. 파일을 두 번 클릭해 설치합니다.
3. 설치 창에서 그룹웨어 주소, 아이디, 비밀번호를 입력합니다. 접속 정보는 Claude Desktop에서 관리합니다.

### 환경변수로 설정

setup을 사용하기 어려운 서버나 컨테이너에서는 환경변수로 접속 정보를 전달할 수 있습니다.

<details>
<summary>MCP 설정 예시 및 실행 조건</summary>

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

`${AMARANTH_ID}`와 `${AMARANTH_PASSWORD}`는 실행 환경의 비밀값 저장소에서 주입할 값을 나타냅니다. 변수 치환 방식은 MCP 클라이언트에 따라 다르므로, 해당 클라이언트의 설정 방식에 맞춰 전달하세요. 실제 아이디와 비밀번호를 설정 파일에 직접 적지 않는 것을 권장합니다.

실행 환경에는 Node.js 20 이상이 필요하며, 그룹웨어 주소와 패키지 다운로드 주소에 HTTPS로 접속할 수 있어야 합니다.

- 버전 태그를 사용하는 위 예시는 Git과 `github.com`, `codeload.github.com`, `registry.npmjs.org` 접속이 필요합니다.
- Git이 없는 환경에서는 태그 대신 해당 릴리스의 40자리 커밋 해시를 사용할 수 있습니다: `github:nubison/amaranth10-mcp#<커밋 해시>`. 이 경우 GitHub 패키지 다운로드에는 `codeload.github.com`을 사용합니다.
- 그룹웨어 주소에 접속할 수 없으면 도구 호출 시 연결 오류를 반환합니다.

</details>

## 제공 도구

| 기능 | 도구 | 설명 |
|---|---|---|
| 알림 | `alerts` | 최근 알림 조회 |
| 메일 | `mail_folders` · `mail_list` · `mail_read` | 메일함 조회, 메일 검색 및 본문 확인 |
| 메일 | `mail_correspondence` | 특정 상대와 주고받은 메일 모아보기 |
| 게시판 | `board_list` · `board_posts` · `board_search` · `board_read` | 게시판과 게시글 조회·검색, 본문 및 댓글 확인 |
| 자원 | `resource_list` · `resource_schedule` · `resource_my_reservations` | 회의실 등 자원 검색, 예약 현황 및 내 예약 조회 |
| 자원 | `resource_reserve` · `resource_cancel` | 자원 예약·취소 |
| 조직도 | `people_search` · `dept_members` | 직원 검색 및 부서원 조회 |
| 일정 | `schedule_list` | 일정 조회 |
| 일정 | `schedule_create` · `schedule_update` · `schedule_delete` | 개인 일정 등록·수정·삭제 |
| 전자결재 | `approval_list` · `approval_read` | 결재 문서 목록, 결재선 및 본문 조회 |
| 연차·휴가 | `leave_balance` · `leave_requests` | 남은 연차 및 휴가 신청 내역 조회 |

출퇴근·근무 기록 조회, 휴가 신청, 전자결재 작성·승인은 지원하지 않습니다.

## 사용 시 알아둘 점

### 예약과 일정 변경

쓰기 도구는 기본적으로 미리보기만 반환합니다(`confirm=false`). 사용자가 내용을 확인하고 승인하면 `confirm=true`로 실행합니다. 참석자가 있는 일정은 초대 알림이 발송되며, 자원 예약도 참석자에게 알림이 갈 수 있습니다.

쓰기 요청은 자동으로 재시도하지 않습니다. 결과를 확인하지 못했다는 안내가 나오면, 같은 요청을 다시 보내기 전에 그룹웨어에서 처리 여부를 확인하세요.

날짜와 시각은 서버의 시간대 설정과 관계없이 한국 시간을 기준으로 합니다. `YYYY-MM-DD HH:MM` 형식의 값도 한국 시간으로 해석합니다.

### 조회에 따른 상태 변경

일부 조회 도구는 그룹웨어에 열람 기록을 남기므로 읽기 전용으로 표시하지 않습니다.

| 도구 | 조회 시 발생하는 변경 |
|---|---|
| `mail_read` | 안 읽은 메일을 열면 읽음으로 바뀝니다. |
| `board_read` | 게시글을 열 때마다 조회수가 1 증가합니다. |
| `approval_read` | 미결 문서를 열면 기안자에게 열람 여부가 표시될 수 있습니다. |
| `mail_correspondence` | 기본적으로 이미 읽은 메일만 엽니다. `include_unread=true`로 호출하면 안 읽은 메일도 열어 읽음으로 바꿉니다. |

## 접속 정보 관리

setup은 macOS에서 비밀번호를 키체인에 저장합니다. **그 외 OS나 키체인 저장 실패 시에는 비밀번호를 파일에 평문으로 저장합니다.** Claude Desktop 확장은 Desktop에서 접속 정보를 관리합니다.

<details>
<summary>저장 위치와 설정 우선순위</summary>

| 설치 방식·환경 | 저장 위치 |
|---|---|
| setup — macOS | 비밀번호는 키체인, 주소와 아이디는 `~/.config/amaranth10-mcp/credentials.json` |
| setup — 그 외 OS 또는 키체인 저장 실패 시 | 주소·아이디·비밀번호 모두 `~/.config/amaranth10-mcp/credentials.json` |
| Claude Desktop 확장 | Claude Desktop에서 관리 |
| 환경변수 | 실행 환경에서 관리 |

macOS 키체인의 서비스 이름은 `amaranth10-mcp`, 계정은 `아이디@그룹웨어호스트`입니다. 파일에 저장할 때는 디렉터리 권한을 `0700`, 파일 권한을 `0600`으로 설정합니다.

환경변수와 저장된 정보가 모두 있으면 다음 기준을 따릅니다.

- `AMARANTH_URL`이 있으면 저장된 주소보다 우선합니다.
- `AMARANTH_ID`와 `AMARANTH_PASSWORD`가 모두 있으면 저장된 계정 정보보다 우선합니다. 둘 중 하나만 있으면 저장된 계정 정보를 사용합니다.

회사 코드는 별도로 설정할 필요가 없습니다. 로그인할 때 그룹웨어 주소를 통해 자동으로 조회합니다.

</details>

<details>
<summary>접속 정보 삭제</summary>

setup으로 저장한 접속 정보와 Claude Code 등록은 다음 명령으로 삭제할 수 있습니다.

```bash
rm ~/.config/amaranth10-mcp/credentials.json
claude mcp remove amaranth10 -s user
```

macOS에서 키체인에 저장했다면, 아래의 계정 값을 실제 아이디와 그룹웨어 호스트로 바꿔 함께 실행하세요.

```bash
security delete-generic-password -s amaranth10-mcp -a '아이디@그룹웨어호스트'
```

Claude Desktop 확장이나 환경변수를 사용했다면 해당 환경에서도 접속 정보를 삭제해야 합니다.

</details>

<details>
<summary>로그와 데이터 전송</summary>

비밀번호·토큰·서명 키는 로그와 도구 출력에 포함하지 않습니다. API 요청 로그는 표준 오류(stderr)에 경로와 결과 코드만 기록합니다. 서버는 설정한 그룹웨어 주소로만 요청하며, 사용 기록을 외부로 전송하지 않습니다.

</details>

## 문제 해결

<details>
<summary>도구가 보이지 않아요</summary>

Claude Code를 새로 열어 보세요. setup에서 등록을 건너뛰었거나 등록에 실패했다면, setup을 다시 실행하거나 당시 출력된 수동 등록 명령을 실행하세요.

</details>

<details>
<summary>비밀번호를 바꿨어요 / 로그인에 실패해요</summary>

비밀번호를 변경했다면 setup을 다시 실행하세요. Claude Desktop 확장은 확장 설정에서, 환경변수 방식은 실행 환경에서 비밀번호를 바꿔야 합니다. 잘못된 비밀번호로 setup을 반복 실행하면 계정이 잠길 수 있으므로 먼저 비밀번호를 확인하세요.

서버는 첫 도구 호출 시 로그인하고 세션을 메모리에 보관합니다. 세션이 만료되면 해당 호출에서 한 번 다시 로그인합니다.

그룹웨어가 로그인을 거부하면 같은 주소·아이디·비밀번호로 다시 시도하지 않습니다. 이후 호출에는 즉시 로그인 실패를 알리고, 접속 정보가 바뀌면 다시 시도합니다. 네트워크 오류는 로그인 거부로 처리하지 않습니다.

로그인 거부 기록은 서버 프로세스가 종료되면 사라집니다. 예전 비밀번호로 다시 로그인하지 않도록 클라이언트를 새로 열기 전에 접속 정보를 갱신하세요.

</details>

<details>
<summary>그룹웨어에 연결하지 못해요</summary>

서버가 실행되는 환경에서 그룹웨어 주소에 접속할 수 있는지 확인하세요. 회사 네트워크나 VPN이 필요한 그룹웨어라면 해당 환경도 같은 네트워크에 연결되어 있어야 합니다. 패키지 다운로드가 실패한다면 [환경변수로 설정](#환경변수로-설정)의 실행 조건도 확인하세요.

</details>

## 개발

```bash
git clone https://github.com/nubison/amaranth10-mcp
cd amaranth10-mcp
npm ci
npm test
```

테스트는 Node.js 기본 테스트 러너(`node:test`)를 사용하며, 실제 그룹웨어에는 요청하지 않습니다.

릴리스하려면 `package.json`과 `manifest.json`의 버전, README의 버전 표기를 함께 갱신한 뒤 `v<버전>` 태그를 push합니다. GitHub Actions가 테스트를 실행하고 해당 커밋에서 `.mcpb` 파일을 만들어 릴리스에 첨부합니다.

## 라이선스 및 고지

[MIT](LICENSE) 라이선스로 배포합니다.

이 프로젝트는 더존비즈온과 관계없는 독립 오픈소스 프로젝트입니다. Amaranth 10은 더존비즈온의 상표이며, 여기서는 연동 대상을 설명하기 위해 사용합니다. 그룹웨어 웹 화면에서 사용하는 API를 호출하므로, 사용 전에 소속 회사의 IT·보안 정책을 확인하세요.
