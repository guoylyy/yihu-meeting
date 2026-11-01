# CLAUDE.md

会议与纪要：以虎 One 官方应用，也是官方应用的**参考实现**（到期台账、收件箱照这个结构复制）。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。平台约定以 `../yihu-one/CLAUDE.md` 和开发中心 `console/docs/devcenter/` 为准。

## 结构

```
src/
  server.js        入口：先监听再连库，/health 如实反映启动状态
  app.js           只做接线：中间件 → 接口 → MCP → 页面
  db.js            建表 + ADDED_COLUMNS（新增列登记在这里，要可空或有默认值）
  meetings.js      会议的全部读写。权限只在这一层，每条 SQL 带当前用户 id
  extract.js       AI 提炼：提示词 + 逐字段收敛，永不抛错
  import.js        上传文件 → 纯文字，失败分级（见下）
  import-worker.js 独立子进程里跑 mammoth / pdfjs
  settings.js      每人一份的设置，每次现读，改完即生效
  about.js         关于页信息、平台模型名
  present.js       库里的行 → 页面要的样子；dates.js 时间只在这里算
  routes/          api.js、import.js、pages.js、list.js，保持薄
  views/           layout/head、foot 每页都有；顶栏在 head 里
  public/yh-vi.css 令牌段（同步）+ 组件段（手写），三个应用共用
  public/app.css   本应用的排布和业务块
scripts/sync-vi.mjs  从平台同步令牌
e2e/run.mjs          回归走查；e2e/gates.mjs 发版门槛和截图
```

## 测试怎么跑

```bash
npm test                               # 真实 MySQL。没给 TEST_DATABASE_URL 就用 Docker 起临时库
TEST_DATABASE_URL=mysql://… npm test   # 用现成的库，表会被清空，不要指向有数据的库
npm run e2e                            # Playwright 走查，E2E_DATABASE_URL 同理
node e2e/gates.mjs                     # 15 张截图、全流程、降级，产物在 artifacts/v0.2.1/（不进 git）
../yihu-one/yh check . --strict
node scripts/sync-vi.mjs --check       # 令牌和平台是否一致
```

假平台在 `test/support/fake-platform.mjs`，走真实 SDK 的登录流程，应用代码里没有测试后门。e2e 里的模型是固定回复，**验不了模型质量**；改提示词后要用 `scripts/real-model.mjs` 对真实模型跑一次。

## 约定

**界面**
- 颜色、圆角、字体只用 `var(--yh-*)`。`yh-vi.css` 令牌段以外不准出现十六进制色、渐变、投影，`test/vi.test.js` 会拦
- CSS 不用 id 选择器：`#add…` 这种会被十六进制检查误伤
- 强调色 `--yh-highlight` 全应用只用一处（进行中）。圆角只有 `--yh-radius`、`--yh-radius-sm` 和胶囊 999px
- 可点元素一律 ≥44px，桌面也一样；375 宽不横向滚动
- 空态一句话加最多一个动作。错误态一句原因加重试。不用插画，不写两段说明
- 平台改 VI：`npm run sync-vi`，令牌段重写，组件段一个字节不动

**数据**
- 权限只在 `meetings.js`：看得到的是自己创建的和参与的，其余 404；参与人只读，写操作 403
- 模型识别的人名（`attendee_names`、`host`）只是文本，**不授权**。能不能看会议只由 `meeting_attendee` 决定，上传的文件不能给人开权限
- `held_at` 是 `starts_at` 的虚拟列，只写 `starts_at`
- 状态不存库，由时间推导；没写结束时间按 60 分钟算，SQL 和 JS 共用 `DEFAULT_MINUTES`
- 时间存 UTC，录入和显示按 `MEETING_TZ`（默认 Asia/Shanghai）
- 回滚只回代码不回库，新列要可空或有默认值

**导入**
- 一个文件一个请求，先存原文再调模型：AI 怎么失败都不丢内容
- 失败分三级：读不出字 → 422，文件名 + 一句原因，不落库（`ImportError`）；模型失败 → 201，原文入库，提示「自动整理失败，可手动填写」；有缺憾 → 201，`notices` 列出来（只读前 60 页、超长截断、没看出开会时间）
- 解析放子进程不放线程：线程撞上堆上限时 V8 可能直接 FATAL，带走整个服务。子进程环境里没有数据库地址和平台凭证
- `pdfjs-dist` 锁在 5.4.624：6.x 要 Node 22，线上镜像是 Node 20。pdf 必须传 `cMapUrl`，否则中文抽出来是乱码
- 内存：解析时主进程加子进程峰值约 550MB，清单 `memory` 是 640m。调大并发（`WORKER_MAX`）要同时调它

**其他**
- 提炼：详情页重新提炼只补空白、不覆盖人填的；导入时会议是新建的，直接采用模型的值
- 设置存在本应用的库里，每人一份，每次现读
- 版本号：运行时只读 `yh-app.json`；`VERSION`、`package.json`、lock 靠测试校验一致，发版时四处一起改
- 上报（`ws.track`）不带原文，也不带文件名
- 不跨应用调用：待办靠「复制」粘到收件箱
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改

## 复制到其他官方应用

拷 `src/public/yh-vi.css`、`scripts/sync-vi.mjs`、`src/views/layout/`、`src/about.js`、`src/settings.js` 的结构，改应用名和菜单项。令牌段不要手改。
