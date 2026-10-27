# 상세 가이드

[README로 돌아가기](../README.md)

## 설정 및 업데이트

- 그룹웨어 주소는 브라우저 주소창의 URL을 그대로 붙여 넣어도 됩니다. HTTPS 주소만 지원합니다.
- 입력한 비밀번호는 화면에 표시되지 않으며, 로그인에 실패하면 접속 정보를 저장하지 않습니다.
- 사용자 범위(`user`)에 등록하므로 다른 프로젝트에서도 사용할 수 있습니다.
- 설치한 버전(`v0.8.0`)은 자동으로 업데이트되지 않습니다. 새 버전을 사용하려면 명령의 버전 태그를 바꿔 setup을 다시 실행하세요.
- setup을 마치면 Claude Desktop과 환경변수 방식에 사용할 설정도 출력됩니다.

## 환경변수로 설정

서버나 컨테이너에서는 setup 대신 환경변수로 그룹웨어 주소와 계정 정보를 설정할 수 있습니다.

```json
{
  "mcpServers": {
    "amaranth10": {
      "command": "npx",
      "args": ["-y", "github:nubison/amaranth10-mcp#v0.8.0"],
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

## 도구 목록

| 기능 | 도구 | 설명 |
|---|---|---|
| 메일 | `mail_folders` · `mail_list` · `mail_read` | 메일함 조회, 메일 검색 및 본문 확인 |
| 메일 | `mail_send` · `mail_delete` · `mail_mark` | 메일 보내기, 휴지통으로 이동, 안 읽음·읽음 표시 |
| 메일 | `mail_correspondence` | 특정 상대와 주고받은 메일 조회. 기본은 읽은 메일만 열며, `include_unread=true`이면 안 읽은 메일도 읽음으로 변경 |
| 게시판 | `board_list` · `board_posts` · `board_search` · `board_read` | 게시판과 게시글 조회·검색, 본문 및 댓글 확인 |
| 자원·회의실 | `resource_list` · `resource_schedule` · `resource_my_reservations` | 자원 검색, 예약 현황 및 내 예약 조회 |
| 자원·회의실 | `resource_reserve` · `resource_cancel` | 자원 예약 및 본인 예약 취소 |
| 일정 | `schedule_list` | 일정 조회 |
| 일정 | `schedule_create` · `schedule_update` · `schedule_delete` | 개인 일정 등록·수정·삭제 |
| 전자결재 | `approval_list` · `approval_read` | 결재 문서 목록 조회, 결재선과 본문 확인 |
| 조직도 | `people_search` · `dept_members` | 직원 검색 및 부서원 조회 |
| 연차·휴가 | `leave_balance` · `leave_requests` | 남은 연차 및 휴가 신청 내역 조회 |
| 알림 | `alerts` | 최근 알림 조회 |

도구를 직접 호출하는 경우 변경 도구는 `confirm=false`로 미리보기를 확인하고, 사용자 승인 후 `confirm=true`로 실행하세요. `YYYY-MM-DD HH:MM` 형식의 시각은 한국 시간으로 해석합니다.

메일은 주소로 받는 사람을 지정합니다. 직원 검색 결과에는 메일 주소가 없으므로 주소를 알려 주어야 합니다. 본문은 일반 텍스트로 보내며 첨부·답장·전달은 지원하지 않습니다. 보낸 메일은 되돌릴 수 없고, 외부 도메인 발송 제한으로 빠진 주소는 결과의 `left_out`에 표시됩니다. 삭제는 휴지통으로 옮기는 것이라 그룹웨어 휴지통에서 복구할 수 있으며, 휴지통·스팸함의 메일은 완전 삭제가 되므로 지우지 않습니다. 휴지통으로 옮긴 메일은 `muid`가 바뀝니다.

일정 수정은 제목과 시각을 대상으로 합니다. 반복 일정이나 자원·다른 참석자·첨부가 연결된 일정은 수정·삭제하지 않으며, 종일 일정도 수정하지 않습니다.

## 접속 정보 관리

setup으로 설정하면 macOS에서는 비밀번호를 키체인에 보관합니다. **다른 OS를 사용하거나 키체인에 저장하지 못한 경우에는 비밀번호가 파일에 평문으로 저장됩니다.** Claude Desktop 확장으로 설치한 경우에는 Desktop이 접속 정보를 관리합니다.

### 저장 위치와 설정 우선순위

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

### 접속 정보 삭제

setup으로 저장한 접속 정보와 Claude Code 등록은 다음 명령으로 삭제할 수 있습니다.

```bash
rm -r ~/.config/amaranth10-mcp
claude mcp remove amaranth10 -s user
```

macOS에서 키체인에 저장했다면, 아래의 계정 값을 실제 아이디와 그룹웨어 호스트로 바꿔 함께 실행하세요.

```bash
security delete-generic-password -s amaranth10-mcp -a '아이디@그룹웨어호스트'
```

Claude Desktop 확장이나 환경변수를 사용했다면 해당 환경에서도 접속 정보를 삭제해야 합니다.

### 로그와 데이터 전송

비밀번호·토큰·서명 키는 로그와 도구 출력에 포함하지 않습니다. API 요청 로그는 표준 오류(stderr)에 경로와 결과 코드만 기록합니다. 서버는 설정한 그룹웨어 주소로만 요청하며, 사용 기록을 외부로 전송하지 않습니다.

## 문제 해결

### 도구가 보이지 않아요

Claude Code를 새로 열어 보세요. setup에서 등록을 건너뛰었거나 등록에 실패했다면, setup을 다시 실행하거나 당시 출력된 수동 등록 명령을 실행하세요.

### 비밀번호를 변경했거나 로그인에 실패해요

비밀번호를 변경했다면 setup을 다시 실행하세요. Claude Desktop 확장은 확장 설정에서, 환경변수 방식은 실행 환경에서 비밀번호를 바꿔야 합니다. 잘못된 비밀번호로 setup을 반복 실행하면 계정이 잠길 수 있으므로 먼저 비밀번호를 확인하세요.

서버는 시작할 때 한 번 로그인해 접속 정보를 확인하고, 세션을 메모리에 보관합니다. 세션이 만료되면 해당 호출에서 한 번 다시 로그인합니다.

접속 정보가 없거나 그룹웨어가 로그인을 거부하면 서버가 시작되지 않으므로, MCP 클라이언트에는 연결 실패로 표시됩니다. 네트워크 오류는 로그인 거부로 처리하지 않습니다. 이 경우 서버는 그대로 시작하고, 첫 도구 호출에서 다시 로그인합니다.

계정 잠김을 막기 위해 거부된 주소·아이디·비밀번호 조합은 `~/.config/amaranth10-mcp/rejected.json`에 기록하고 다시 시도하지 않습니다. 비밀번호 대신 scrypt 해시만 저장합니다. 클라이언트를 다시 열어도 같은 조합이면 로그인 요청을 보내지 않고, 접속 정보가 바뀌면 한 번 다시 시도합니다. setup으로 접속 정보를 다시 저장하면 기록이 지워집니다. 비밀번호는 그대로인데 계정 잠금만 풀렸다면 setup을 다시 실행하거나 이 파일을 삭제하세요.

### 그룹웨어에 연결하지 못해요

서버가 실행되는 환경에서 그룹웨어 주소에 접속할 수 있는지 확인하세요. 회사 네트워크나 VPN이 필요한 그룹웨어라면 해당 환경도 같은 네트워크에 연결되어 있어야 합니다. 패키지 다운로드가 실패한다면 [환경변수로 설정](#환경변수로-설정)의 실행 조건도 확인하세요.

## 개발

```bash
git clone https://github.com/nubison/amaranth10-mcp
cd amaranth10-mcp
npm ci
npm test
```

테스트는 Node.js 기본 테스트 러너(`node:test`)를 사용하며, 실제 그룹웨어에는 요청하지 않습니다.

릴리스하려면 `package.json`과 `manifest.json`의 버전, README와 이 가이드의 버전 표기를 함께 갱신한 뒤 `v<버전>` 태그를 push합니다. GitHub Actions가 테스트를 실행하고 해당 커밋에서 `.mcpb` 파일을 만들어 릴리스에 첨부합니다.
