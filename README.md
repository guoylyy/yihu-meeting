# 会议与纪要 Meeting

以虎 One 官方应用：记会议、导入纪要（Word、PDF、文本、粘贴），AI 识别会议信息，提炼决议、待办、风险和下次议题，按项目归类。使用说明见 [docs/使用说明.md](docs/使用说明.md)，开发约定见 [CLAUDE.md](CLAUDE.md)。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。

## 本地运行

```bash
cp .env.example .env   # 填 DATABASE_URL
npm install
node --env-file=.env src/server.js
```

不配 `YH_*` 时以「本地用户」单人运行，只在 `NODE_ENV` 不是 `production` 时生效；生产环境没配平台凭证会拒绝服务，不退回匿名。

## 测试

```bash
npm test     # 真实 MySQL：没给 TEST_DATABASE_URL 就用 Docker 起临时库，跑完删掉
npm run e2e  # Playwright：独立实例（3060）+ 临时库，经 /apps/meeting 前缀访问，截图在 artifacts/e2e/；E2E_DATABASE_URL 可指定现成的库
node e2e/gates.mjs  # 发版门槛：15 张截图、全流程、降级，产物在 artifacts/v0.2.1/
../yihu-one/yh check . --strict
npm run sync-vi     # 平台改 VI 后同步设计令牌，加 -- --check 只比较

# 真实模型实测（需要平台给的应用凭证）
YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> node scripts/real-model.mjs
```

## 约定

- 权限只在 `src/meetings.js`：看得到的是自己创建的和参与的，其余 404；参与人只读，写操作 403
- 状态不存库，由时间推导（`dates.js` 的 `meetingStatus`）；没写结束时间的会议按 60 分钟算，SQL 和 JS 共用 `DEFAULT_MINUTES`
- 时间存 UTC，录入和显示按 `MEETING_TZ`（默认 Asia/Shanghai），和手机时区无关
- 提炼先存原文再调模型。失败是 200 + 一句说明，已有的四块不动；成功才整批替换
- 导入失败分三级：读不出字 422 不落库；模型失败 201 存原文并提示；有缺憾 201 列 notices。解析在独立子进程
- 模型识别的姓名只是文本，不授权；能看会议的只有创建者和参与人
- 纪要后写覆盖先写，只有创建者能改，没有做多端合并
- 不跨应用调用：待办靠「复制」粘到收件箱，平台有跨应用协议后再说
- 运行时版本号只读 `yh-app.json`，页面、`/health`、MCP、关于页都取它；`VERSION`、`package.json` 由测试校验一致
- 颜色只用 `var(--yh-*)`，令牌来自平台，见 `scripts/sync-vi.mjs`
- 改表：`src/db.js` 的 `ADDED_COLUMNS` 登记新列，要可空或有默认值（回滚不回库）
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改
