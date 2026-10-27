#!/usr/bin/env node
// Korean time first: the groupware speaks KST and a server or container is likely on UTC. Nothing
// is imported statically, so no module runs before this line.
process.env.TZ = "Asia/Seoul";

const USAGE = `amaranth10-mcp: 더존 Amaranth 10 그룹웨어 MCP 서버

  amaranth10-mcp setup [--spec <패키지>]   주소·아이디·비밀번호 저장, Claude Code 등록
  amaranth10-mcp                           MCP 서버 (stdio, MCP 클라이언트가 실행)
  amaranth10-mcp --version

  설치 방법: https://github.com/nubison/amaranth10-mcp`;

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) {
  await (await import("../src/server.js")).serve();
} else if (command === "setup") {
  process.exitCode = await (await import("../src/setup.js")).setup({ argv: rest });
} else if (command === "--version") {
  console.log((await import("../src/server.js")).VERSION);
} else if (command === "--help" || command === "-h") {
  console.log(USAGE);
} else {   // a typo must not start a server that silently waits on the terminal
  console.error(USAGE);
  process.exitCode = 2;
}
