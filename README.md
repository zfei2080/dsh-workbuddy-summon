<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-workbuddy-summon icon">
</div>

# dsh-workbuddy-summon 0.4.0

把 **WorkBuddy 的「专家 / 专家团」做成在线目录 + 对话框召唤**：内置**「全域智囊团」固化专家团（16 个 agent / 15 个技能，离线、换机即用）**，叠加官方专家中心**逐条一致（448 条）**与**登录态在线市场（28k+ 条）**；**未召唤的会话一个字都不注入**。

> **0.2.0 起已彻底移除连接器（Connector）**：不再有连接器工具、路由、面板 tab 与 `connectors.*` 配置；只保留专家 / 专家团目录与召唤。

---

## 0.4.0 新增：内置固化专家团「全域智囊团」

> 换机器 / 上服务器时，**不需要再装 WorkBuddy、不需要登录、不需要联网** —— 专家定义与技能都在插件目录里。

| 项 | 内容 |
|---|---|
| 包目录 | `packs/all-domain-brain-trust/`（随插件分发，`package.json#files` 已包含 `packs/`） |
| 主理人 | `brain-trust-lead`（首席幕僚长：接单 → 拆解 → 分派 → 交叉校验 → 收敛交付） |
| 成员（15） | 诉讼法务专家、AI 刘小排（产品顾问）、钱守通（财务管家）、ChaoGeek 0x孔明（苏格拉底式思维）、像素君（UI）、教务宝机构经营诊断专家、K12 全科教育专家、心理视角私董会、行为心理学专家、教务宝课程顾问话术专家，以及软件开发团队 5 人（交付总监 齐活林 / 产品经理 许清楚 / 架构师 高见远 / 工程师 寇豆码 / QA 严过关） |
| 技能 | 15 个（含诉讼工具箱、财务 5 件套、UI 设计、心理流派库等），全部随包本地化 |
| 头像 | 16 张（128px，本地生成/缩放），不依赖外网 |
| 目录表现 | 官方 448 条之外**固定多 1 条**：`all-domain-brain-trust`（专家团，分类「行业顾问」，成员数 15）；`parity` 自检只算官方条目，仍为 448 |
| 召唤 | 面板「专家团」tab 直接点它，或 `wb_summon(plugin="all-domain-brain-trust")`；注入段含 15 人编制表与调度规则（成员正文按需 `wb_expert_read`） |

验证：`node tests/local-packs-check.mjs`（离线发现 / 读包 / 16 agent / 15 技能 / 注入段含 15 名成员）。

## 0.3.0 新增了什么

| 新增 | 说明 |
|---|---|
| **「市场」tab**（面板第三个 tab） | 在线专家市场：搜索 / 分类过滤 / 加载更多 / 一键召唤；未连接时显示「连接市场」与操作指引 |
| **2 个模型侧工具** | `wb_market_search`（搜市场）、`wb_market_capture`（自动抓 token 或直接传 token） |
| **5 条子路由** | `GET /market/status`、`GET /market/categories`、`GET /market/search`、`POST /market/capture`、`POST /market/token` |
| **召唤市场专家** | `POST /summon {sessionId, plugin, marketExpertId}` / `wb_summon(plugin, marketExpertId)`：取详情 → 下载签名 zip → 解包缓存 → 复用原有注入链路 |
| **头像绝对 URL 代理** | `GET /avatar?src=<绝对URL>`，只放行 openplatform-cdn 的 https 图片（域名白名单） |

0.3.0 **不改**官方目录口径（仍是 448 条），原有工具名 / 路由前缀 / 注入段名都不变：市场是叠加能力，关掉（`market.enabled: false`）就退回 0.2.0 的行为。

## 硬指标（0.2.0 起保持 + 0.3.0 新增）

| 指标 | 做法 | 验证 |
|---|---|---|
| 官方目录和 WorkBuddy 专家中心完全一致 | 448 条（394 单专家 + 54 专家团）、15 个分类；id 集合与本机专家中心快照相等 | `node tests/catalog-parity.mjs` |
| 在线市场可搜可召唤（需登录态） | token 只存本机、过期自动失效；市场条目进独立的「市场」tab，不混进 448 条离线目录 | `node tests/market-check.mjs`、`node tests/market-unit.mjs` |
| 彻底删除连接器 | 无连接器模块 / 工具 / 路由 / 面板 tab / 配置项 | `node tests/no-connector-check.mjs` |
| 保留原有能力 | 4 个目录 / 召唤工具、11 条子路由、注入段、头像代理、CLI 垫片不变 | `node tests/host-probe.mjs` 等 |
| 召唤才注入 | 会话级状态；未召唤时求值器返回空串 | `node tests/session-isolation-check.mjs` |

## 目录口径①：官方专家中心 448 条（离线）

**权威副本**是 WorkBuddy 桌面端的专家中心缓存：

```
~/.workbuddy/app/cache/experts/manifest.json   ← 448 条目录（+ 同目录 metadata.json 的 cachedAt）
```

| 口径 | 数值 | 说明 |
|---|---:|---|
| 条目总数 | **448** | 与 `manifest.json` 的 `experts` 长度相等 |
| 单专家（agent） | **394** | 卡片直接召唤 |
| 专家团（team） | **54** | 召唤后按团队编制派发成员 |
| 分类 | **15** | 腾讯专区 / 产品设计 / 技术工程 / 游戏空间 / 数据智能 / 营销增长 / 内容创作 / 销售商务 / 金融投资 / 运营人力 / 项目质量 / 法务安全 / 行业顾问 / 全球发展 / 开学季 |
| 唯一插件包 | 447 | `ppt-creation-expert` 一个包对应 2 个专家条目（按 `id` 区分） |
| 带头像 | 448 | 432 条市场根 `/avatars/…` + 16 条包内 `/plugins/…`；54 个专家团共 305 名成员全部有头像 |

**0.1.1 的 457 条从哪来**：旧版把 `~/.workbuddy/plugins/marketplaces` 里已下载的本机包也当成目录条目，多出 9 条（`superpowers-zh`、`ui-design-team-lead`、`engineering-director`、`gaokao-advisor`、`bazi-master`、`fortune-consultant`、`senior-developer`、`douyin-strategist`、`ui-designer`）。0.2.0 起这些本机包**只做包体内容兜底**（`loadPackage()` 需要时读本地目录），**不再进目录**。

### 怎么验证 448

```bash
node tests/catalog-parity.mjs
```

用例会离线（`loadCatalog({ fresh: false })`，不联网）做这些断言：

- `entries.length === 448`；
- 条目 `id` 集合与 `manifest.json` 的 id 集合**完全相等**（且无重复）；
- `expertType` 统计 `394 agent / 54 team`；
- 分类 id 集合与 `manifest.categories` 一致（15 个）；
- 9 条本机噪音 id 一条都不出现；
- 每条都有 `id / plugin / displayName / profession`；
- `loadCatalog()` 返回的 `parity` 自检差异为空（`missingFromCatalog` / `extraInCatalog` 都是 0）。

任一不一致会以非 0 退出；数据层重写期间可加 `--allow-fail` 只报告不判红。运行 `GET /dsh-workbuddy-summon/status` 也能看到 `catalog.parity` 与 `catalog.sources`。

## 目录口径②：在线市场 28k+ 条（登录态，按需在线查询）

| 口径 | 数值 | 说明 |
|---|---:|---|
| 市场专家 | **28k+** | 官方「在线专家市场」口径；单页最多 100 条，分页取 |
| 市场分类 | **17** | 与专家中心的 15 个**不是同一套**（多出腾讯专家 / 双十一 / 健康等）；分类 `expertCount` 会重叠计数 |
| 数据接口 | 4 个 | `market/expert/list`（搜索）、`get-by-ids`（详情）、`download-url`（签名 zip）、`expert-categories`（分类） |
| 缓存 | 2 处 | 分类 → `~/.dsh/workbuddy-summon/cache/market-categories.json`；包体 → `cache/market-packages/` |

市场的 28k+ 条**不进** 448 条离线目录：目录要「和 WorkBuddy 专家中心逐条一致」，而市场条目量级大、且必须登录态才能搜/下载，所以放在独立的「市场」tab 里按需查询。两边数据源互不串（市场 tab 里不显示官方分类下拉，搜索也不会走官方目录路由）。

## 数据源与降级顺序

```
① WorkBuddy 本机专家中心快照  ~/.workbuddy/app/cache/experts/manifest.json
      └ 权威副本：含 WorkBuddy 自己的可见性过滤；快照不比在线清单旧时以它为准
② COS 在线三份公开清单（无需登录）
      <COS_BASE>/expert_center.json + internalExpert.json + externalExpert.json
      └ 合并去重后同为 448 条；在线内容比快照新时优先在线
③ 本插件缓存  ~/.dsh/workbuddy-summon/cache/manifests/*    ← 断网继续可用
④ 本机镜像    ~/Documents/deepseek/wb-resources/expert-market/   ← 离线兜底（存在时）
⑤ 在线市场（登录态，独立数据源）  → 不进目录，只在「市场」tab 里按需查
```

- **任一源失败只降级不报错**；三份在线清单逐份回退到缓存 / 镜像，`degraded` 标记当前是否降级。
- 选源规则：先比较「内容 `lastUpdated` / 文件 mtime」；本机快照不旧于在线清单时用快照，否则用在线。`loadCatalog({ fresh:false })` 完全不联网（测试与离线场景用）。
- 去重主键是 `id`；先到的条目优先（WorkBuddy 的叠加顺序 = base → internal → external）。
- 排序保持清单顺序；条目带 `displayPosition` 时按它升序（与 WorkBuddy 一致）。
- 本机 `~/.workbuddy/plugins/marketplaces` 里的包**不在目录里**，只用于 `loadPackage()` 的正文兜底。

## 在线专家市场（0.3.0）

### 为什么需要登录态

官方专家中心的 448 条来自**公开 COS 清单**，不需要登录。而「在线市场」是 WorkBuddy 应用内的**登录态接口**：搜索、详情、下载地址都要带 `Authorization: Bearer <JWT>`，token 由 WorkBuddy 登录后自己签发。插件不内置账号、不代理登录、也不读 WorkBuddy 的本地存储或浏览器 cookie —— 只复用你本机 WorkBuddy **已经登录**的那份 token，所以：

- 没登录过 WorkBuddy / token 过期 → 市场不可用，但**官方 448 条与召唤完全不受影响**；
- token 只用于访问市场这 4 个接口，不做他用。

### 如何连接（二选一）

**方式 A：自动抓取（推荐）**

1. **完全关闭 WorkBuddy**（托盘也要退）；
2. 用远程调试端口启动它：

   ```bat
   "E:\workbuddy\WorkBuddy.exe" --remote-debugging-port=9222
   ```

3. 保持登录状态；
4. 打开 DSH 面板 → 「市场」tab → 点「**连接市场**」。

   等价命令：`POST /dsh-workbuddy-summon/market/capture`，或让模型调 `wb_market_capture`。

   原理：插件走 CDP（`http://127.0.0.1:9222/json/list` + WebSocket）在 WorkBuddy 渲染进程里执行 `window.wb.account.token()` 取一次 token，取完即断开，不常驻。

**方式 B：手动粘贴 token**

面板「市场」tab →「手动粘贴 token」→ 粘贴（可带 `Bearer ` 前缀）→ 提交；或 `POST /dsh-workbuddy-summon/market/token {token}` / `wb_market_capture({token})`。写入前会校验 JWT 格式与 `exp`，并跑一次分类接口验证可用性 —— **校验失败不会落盘**。

端口不是 9222 时：改 `market.cdpPort` 配置，或 `POST /market/capture {port}`。

### token 存在哪、多久过期

| 项 | 位置 / 数值 |
|---|---|
| token 文件 | `~/.dsh/workbuddy-summon/market-token.json`（`{token, uid, exp, capturedAt}`，写入时请求权限 **0600**，Windows 上实际由 NTFS ACL 决定） |
| 有效期 | JWT 的 `exp - iat` **实测 28 天**；每次 `readToken()` 都查 `exp`，过期即按「未连接」处理 |
| 分类缓存 | `~/.dsh/workbuddy-summon/cache/market-categories.json`（断网时下拉仍可用） |
| 市场包体 | `~/.dsh/workbuddy-summon/cache/market-packages/<plugin>@<expertId>@<version>/`（含 `.extracted` 标记，二次召唤直接复用） |

断开市场 = 删除 `market-token.json`（或重连覆盖）。token 失效（401/403）时，市场相关接口会返回 401 + 一条「怎么重新抓」的操作提示。

### 市场专家怎么下载与召唤

1. **搜**：面板市场 tab 输入关键词（300ms 防抖），或 `GET /market/search?q=&category=&page=&pageSize=`（默认 30/页，上限 100），或工具 `wb_market_search`；
2. **选中**：返回项里带 `marketExpertId`（市场侧唯一 ID）与 `plugin`（插件包名）；
3. **下载**：召唤时宿主用 `marketExpertId` 调 `get-by-ids` 取详情 → `download-url` 取签名 zip → `tar -xf` 解包到 `cache/market-packages/…`（**只解包，不执行包内任何脚本**）；
4. **召唤**：`POST /summon {sessionId, plugin, marketExpertId}` 或 `wb_summon(plugin, marketExpertId)` → 与官方专家走同一条 `loadPackage` → 注入段链路；
5. **重启恢复**：召唤记录里保存了 `marketExpertId`，重启后按它重新取详情 / 包体（缓存命中则不重新下载）。

面板上市场条目带「市场」小徽标；点「召唤」= 先下载再召唤，首次通常几百 KB～数 MB。

### 离线 / 未连接时的降级行为

| 状态 | 表现 | 官方 448 条目录 |
|---|---|---|
| 从没连过市场（无 token） | 市场 tab 显示「未连接在线市场」+ 启动命令指引；`/market/search` 返回 **401 + hint** | 不受影响 |
| token 过期 / 被吊销 | 同上（401/403 后提示重新抓取） | 不受影响 |
| 断网 | 搜索返回 502 并在 UI 里显示错误；已缓存的分类仍显示；已下载过包的市场专家仍能召唤 | 不受影响（走本机快照 / 缓存） |
| WorkBuddy 没开调试端口 | 抓取失败并明确提示「连不上 127.0.0.1:9222」+ 启动命令 | 不受影响 |
| 宿主是 0.2.x（无 `/market/*`） | 市场 tab 显示「当前宿主不支持在线市场（需 0.3.0+）」 | 不受影响 |
| `market.enabled: false` | 不注册 2 个市场工具；市场 tab 仍能打开，但没 token 时就是「未连接」 | 不受影响 |

一句话：**市场是可选增强，坏了就退回 0.2.0 的能力，绝不拖垮目录与召唤。**

### 安全说明

- **token 是本机明文文件（0600）**：登录态凭证，与 WorkBuddy 自己的本机存储同级；不写日志、不在 UI 回显、`/market/status` 只回 `{uid, exp, capturedAt}`，**不回 token 本体**。
- **头像域名白名单**：`/avatar?src=` 只放行 `openplatform-cdn.codebuddy.cn` / `openplatform-cdn.codebuddy.ai` 的 **https** 图片（`.png/.jpg/.webp`）；其余域名、http、非图片扩展名一律 404。渲染进程不直连外部 CDN。
- **下载即解包，不执行**：市场包体只落插件缓存并当文本读取（`skills/`、`bin/` 里的脚本不会自动执行）。
- **调试端口只连本机**：CDP 只访问 `127.0.0.1:<port>`，抓完 token 立即断开；插件不会去读 WorkBuddy 的 cookie / LocalStorage / 数据库。
- **不想用**：删 `~/.dsh/workbuddy-summon/market-token.json` 即断开；`market.enabled: false` 可整体关闭市场能力。

## 召唤机制：会话级，未召唤零注入

三个入口等价，都只作用于**当前会话**：

| 入口 | 说明 |
|---|---|
| 面板 | 对话框提交区右侧「召唤」按钮 → 面板选人（专家团 / 专家 / 市场三个 tab） |
| 模型工具 | `wb_summon` / `wb_unsummon`（市场专家额外传 `marketExpertId`） |
| HTTP | `POST /summon {sessionId, plugin[, marketExpertId]}` / `POST /unsummon {sessionId}` |

- 状态按 `sessionId` 分桶，落盘在 `~/.dsh/workbuddy-summon/summons.json`；注入段落盘在 `~/.dsh/workbuddy-summon/sections/*.md`，重启后读回、缺失的异步补算。
- `systemPrompt.section` 的求值器每个模型步只同步查内存表：**没有召唤记录 → 返回空串**（宿主会过滤空段，零残留）；有记录但段未就绪 → 本轮先不注入，后台补算。求值器里没有网络 / 磁盘扫描。
- 取消召唤 = 删掉落盘段落（不是写空串）+ 清状态；启动时回收 0 字节与孤儿段落文件。

### 召唤后注入什么

1. 身份声明 + **主理人 / 单专家的完整定义原文**（超过 `maxLeadChars`（默认 24000）截断，并给出 `wb_expert_read` 续读指引）；
2. 团队编制表（Agent ID / 花名 / 职业）+ **调度映射表**；
3. 协作铁律（建团只能主理人、成员结论为准、禁止代写、禁止 spawn 自己…）；
4. 配套技能清单（名字 + 一行摘要 + 分层细节数量，正文按需取）。

**成员定义不整团预注入**：派发谁才用 `wb_expert_read` 取谁，再放进 `spawn_teammate` 的 prompt。实测一个 6 人团注入约 6.4k 字符（≈4k token），整团预注入要 15k+。

### 为什么要有「调度映射表」

WorkBuddy 原文写的是它自己运行时的原语，DSH 里不是这些名字；不改写模型会去调不存在的工具：

| 定义里的写法 | DSH 实际怎么做 |
|---|---|
| `TeamCreate` | Lead 直接 `spawn_teammate` 即建团 |
| `Agent(name, subagent_type)` | `spawn_teammate(name="<Agent ID>", prompt=…)` |
| `SendMessage` 回传主理人 | `send_message(target="lead")` |
| `maxTurns` | 无等价参数，用「每阶段简报进度」控制节奏 |

官方「禁止成员互相直连」红线原样保留（DSH 本身允许 peer 互发，所以在 prompt 里显式约束）。

## 模型侧工具

| 工具 | 用途 |
|---|---|
| `wb_experts_list` | 列目录（`kind` / `category` / `q` / `limit` / `refresh`） |
| `wb_expert_read` | 取原文：不传参 = 包清单；`agent=` 成员定义；`skill=` 技能正文；`skill+ref=` 分层细节 |
| `wb_summon` | 把某专家召唤进**当前会话**；市场专家传 `plugin` + `marketExpertId` |
| `wb_unsummon` | 取消当前会话的召唤 |
| `wb_market_search` | 搜在线市场（`q` / `category` / `page` / `pageSize`），返回 `marketExpertId` |
| `wb_market_capture` | 连接市场：默认从 9222 调试端口抓 token，也可直接传 `token` |

后两个受 `market.enabled` 控制（`false` 时不注册）。长文本一律分段返回（`maxReadChars` 默认 24k 字符/段，`nextFrom` + `from=` 续读）；成员 / 技能 / ref 都按需取，不整包灌。

## HTTP 路由（渲染进程同源 fetch，免 token）

```
GET  /dsh-workbuddy-summon/status[?sessionId=]          健康 + 目录状态 + 当前召唤 + 市场连接态
GET  /dsh-workbuddy-summon/catalog?kind&q&category&refresh=1
GET  /dsh-workbuddy-summon/entry?plugin=                单包详情（成员/技能/引导语/快捷提示）
GET  /dsh-workbuddy-summon/avatar?plugin&size&agent=     头像 image/png（缩略 + 缓存）
GET  /dsh-workbuddy-summon/avatar?src=<绝对URL>          市场头像代理（域名白名单）
POST /dsh-workbuddy-summon/summon    {sessionId, plugin[, marketExpertId]}
POST /dsh-workbuddy-summon/unsummon  {sessionId}
GET  /dsh-workbuddy-summon/market/status                 {connected, token{uid,exp,capturedAt}, categories, cdpPort}
GET  /dsh-workbuddy-summon/market/categories              市场分类（失败时降级返回缓存 + degraded）
GET  /dsh-workbuddy-summon/market/search?q&category&page&pageSize=   401 + hint（未连接）/ 200 列表
POST /dsh-workbuddy-summon/market/capture   {port}        从 WorkBuddy 调试端口抓 token
POST /dsh-workbuddy-summon/market/token     {token}       手动提交 token（先校验再落盘）
```

`kind` 只接受 `team` / `expert`（不带 = 全部）；`catalog` 返回 `total`、15 个分类（含 count）、`sources`、`degraded`、`parity` 与列表项（`plugin/id/title/name/expertType/category/profession/memberCount/summary/avatarUrl`，专家团额外带 `members`）。市场列表项额外带 `marketExpertId` / `marketVersion` / `useCount`。

## 面板与展示口径（对齐 WorkBuddy 专家中心）

- 入口：`conversation.input.right` 的「召唤」按钮；面板 portal 到 body，底边锚定按钮上沿，高度由按钮上方可用空间决定（面板位置 / 高度有记忆）。
- 三个 tab：**专家团 / 专家 / 市场**。切 tab 立即清换成目标 tab 的缓存（没有就进骨架态），同 tab 内改搜索词不闪。
- 官方卡片：**主标题 = `profession`**（如「中文网络小说创作顾问」），**副标题 = 花名 `name`**（相同时隐藏）；专家团显示 `团·(memberCount+1)` 徽标 + 成员头像堆叠，成员头像走 `?agent=<memberId>`。
- 市场卡片：独立数据源与分类下拉（带数量），条目带「市场」徽标；「加载更多」分页；未连接时整块换成「连接市场 / 粘贴 token / 操作指引」，旧宿主（无 `/market/status`）显示「不支持在线市场」而不是崩掉。
- 搜索、分类过滤、分页、骨架态；H5（≤1023px）面板整屏显示、带关闭键，并处理 Android 返回键（`popstate` 关面板）。

## 头像：实时代理，本地不存图

官方头像 `GET /avatar?plugin=&size=&agent=` 由宿主按目录条目的 `avatar` 字段拼出 COS 地址，带服务端缩略参数（`?imageMogr2/thumbnail/Nx`）实时取图；市场头像走 `GET /avatar?src=<绝对URL>`（同一个代理 handler，多一道域名白名单）。进程内 LRU + 同 key 并发合并。本地**不存任何图片资产**——预生成缩略图会把数据冻在本地，WorkBuddy 换头像就看不到。

- 缓存语义：`ETag: W/"<内容 sha1 前 16 位>"` + `Cache-Control: public, max-age=300`；命中 `If-None-Match` 返回 304 空体（换头像不会被长缓存挡住）。
- 安全边界：`ref` 一律由服务端从目录条目里查出，不接受调用方传路径；额外挡 `..` 与非图片扩展名；`src=` 只认 https + 白名单域名 + 图片扩展名；`Content-Type` 按字节魔数嗅探；远程图 > 2MB 直接放弃（回退首字）。
- 取不到图时组件回退首字圆形；旧召唤状态（无 avatarUrl）也能正常显示。

## CLI 兼容垫片：让金融类专家包不改一个字就能跑

WorkBuddy 金融类专家团的成员 prompt 里写着 `westock-data quote sh600519`、`westock-tool filter "..."`，但这两个名字在 WorkBuddy 里只是**技能目录名**；真实命令是官方 Go 二进制 `westock`（技能包自带安装脚本 + SHA256 校验）。插件 `bin/` 自带两个垫片，启动时由 `lib/shims.js` 装进 PATH：

| 垫片 | 做什么 |
|---|---|
| `westock-data` | 名字映射（`asfund/usfund/hkfund→fund flow`、`blocktrade→fund block`、`lgt→connect`…）+ **参数翻译**（`kline sh600519 day 20` → `--limit 20`）；官方没有的能力明确报错并给替代命令 |
| `westock-tool` | 按 `teamInfo` / 市场目录动态定位技能包里的 `scripts/index.js` 入口并转发，不硬编码路径 |

为什么不能只做名字转发：真实 CLI 会**静默忽略**多余位置参数（`westock kline sh600519 day 20` 返回 100 行默认值且不报错），模型会拿错数据继续分析——比报错危险。所以垫片把专家惯用形态翻译成真实 flag。

调试：`WB_SHIM_DRYRUN=1 westock-data kline sh600519 day 20` 只打印翻译结果。

**自装安全边界**（`tests/shim-check.mjs` 逐条断言）：只覆盖带 `shim-of: dsh-workbuddy-summon` 标记的文件；目标位置被他人占用一律跳过并告警；内容一致不动盘（幂等）；无可写落点安全返回而非抛异常。**不代装** `westock` 本体，只检测缺失并提示官方安装命令。

## 连接器已移除（0.2.0）

0.2.0 起已彻底移除连接器（Connector）：`wb_connectors_*` / `wb_local_connectors_*` 四个工具、`/connectors` 与 `/connector-*` / `/local-connector*` 路由、面板的连接器 / 本地 tab、以及 `cordis.patch.yml` 里的 `connectors.*` 配置项全部删除；本版只保留专家 / 专家团目录与召唤。

0.1.1 留下的 `session-connectors.json` 与 `connector-probe-cache.json` 不再读取，可手动删除。

0.3.0 没有恢复上述任何能力：零残留扫描会把新增的 `lib/market.js` 与市场 UI 一起覆盖，0 命中才算过。

## 安装与升级

本包是 **bundle 型**（`package.json` 带 `dsh.bundle.patch`）→ 由 profile 的 `dsh.profile.bundles` 管理，**不要**再往 `cordis.patch.yml` 里 insert 同 id（会 `duplicate loader entry id` 起不来树）。

```bash
# 安装 / 替换：plugin_manager → install_bundle，target 填本目录绝对路径
E:\dshplugin\dsh-workbuddy-summon
```

- 本机开发态：profile 用 `link:` 指向 `C:\Users\Administrator\.dsh\local-plugins\dsh-workbuddy-summon`（`node_modules/dsh-workbuddy-summon` 是符号链接）。把 0.3.0 的文件覆盖进该目录即可，包名 / 版本号是 0.3.0。
- **从 0.2.0 升级到 0.3.0 = 直接替换**：新增 `lib/market.js` 与面板的「市场」tab；工具名、路由前缀、注入段名、`summons.json` / `sections/` 全兼容，不用重装、不用迁移。旧召唤记录（无 `marketExpertId`）照常工作。
- **从 0.1.1 升级 = 直接替换**：包名、4 个原有工具名、路由、注入段名、状态文件都兼容。
- 改 Host 半边 JS（`index.js` / `lib/*.js`）或新增 client 模块 → **完全退出并重开 DSH**；只改已挂载插件的 `lib/client.js` 内容 → 刷新页面即可。
- 回滚：`plugin_manager` → `remove_bundle`，target `dsh-workbuddy-summon`；再删 `~/.dsh/workbuddy-summon/`（含 `market-token.json`）。

## 离线 / 服务器部署（无 WorkBuddy 环境）

内置包让插件在**完全没有 WorkBuddy 的服务器**上也能用：

1. 把整个 `dsh-workbuddy-summon/` 目录拷到服务器（`packs/` 必须一起拷，约 6.3MB；插件总体 ~7MB）。
2. 在服务器的 DSH 里安装：`plugin_manager → install_bundle`，`target` 填该目录绝对路径；或把它放进 `~/.dsh/local-plugins/` 并在 profile 的 `dependencies` 加 `link:` 后重启。
3. 重载后面板「专家团」tab 里就有「**全域智囊团**」，点它即召唤；`wb_summon(plugin="all-domain-brain-trust")` 同样可用。

### 从 Git 安装（推荐）

```bash
git clone https://github.com/zfei2080/dsh-workbuddy-summon.git
cd dsh-workbuddy-summon
# 然后在 DSH 里：plugin_manager → install_bundle，target 填当前目录的绝对路径
# 或：把它放进 ~/.dsh/local-plugins/，在 profile 的 dependencies 加 "dsh-workbuddy-summon": "link:<该路径>"，重启 DSH
```

克隆下来即可用，`packs/` 已随仓库分发，**无需 npm install、无需 WorkBuddy、无需登录**。

服务器上不需要、也不会自动访问的东西：

| 能力 | 无 WorkBuddy 时的行为 |
|---|---|
| 官方 448 条目录 | 有网则从 COS 拉公开清单（或读插件缓存）；无网时该部分为空，**内置包不受影响** |
| 在线市场（市场 tab） | 显示「未连接」+ 连接指引，不影响内置包与召唤 |
| 头像代理 | 内置包头像读插件目录里的 PNG；官方/市场头像才走网络 |
| CLI 垫片 | 仍会尝试装进 PATH（`westock-*`），失败只告警 |

> 如果想彻底关掉联网部分，可在插件配置里设 `market.enabled: false`（市场工具与 `/market/*` 路由都不注册）；官方目录的在线拉取失败会自然降级到缓存，不影响内置包。

### 配置项（`cordis.patch.yml` / 插件行 config）

| 键 | 默认 | 作用 |
|---|---|---|
| `maxLeadChars` | `24000` | 注入段里主理人定义正文的字符上限（超出截断 + 续读提示） |
| `maxReadChars` | `24000` | `wb_expert_read` 单段返回上限 |
| `warmCatalog` | `true` | 启动后预热目录；`false` = 首次使用时再拉 |
| `installShims` | `true` | 启动时把 `bin/` 垫片装进 PATH |
| `market.enabled` | `true` | 在线市场总开关；`false` = 不注册 `wb_market_*` 工具（市场 tab 没 token 时即「未连接」） |
| `market.cdpPort` | `9222` | 从 WorkBuddy 调试端口抓 token 时用的端口 |

## 测试命令（不依赖 Electron）

Node 绝对路径（本机）：

```
C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

先做语法检查，再按表格跑；「离线」= 只读本机快照 / 缓存 / 本机市场，不联网；「需包缓存」= 首次跑要能联网取包体（之后走 `~/.dsh/workbuddy-summon/cache/`）。

```bash
node --check index.js && for f in lib/*.js; do node --check "$f"; done
```

| 用例 | 覆盖 | 依赖 |
|---|---|---|
| `tests/catalog-parity.mjs` | 448 条 / id 集合 / 394·54 / 15 分类 / 9 条噪音 / 字段完整 | 离线 |
| `tests/no-connector-check.mjs` | 连接器实现 / 工具 / 路由 / 配置 / 文案零残留（含白名单） | 离线 |
| `tests/market-unit.mjs` | 市场字段映射（真实响应样本）/ token 读写与过期 / 分类缓存 / 参数校验；隔离 STATE_ROOT，不联网、不碰真实 token | 离线 |
| `tests/market-check.mjs` | 假 ctx：市场工具注册与 `market.enabled` 开关 / `/market/status` 形状 / 无 token 时 401+hint / 头像域名白名单 / 真实 token 未被触碰 | 离线 |
| `tests/coverage-check.mjs` | 448 条字段覆盖率、分类解析、团队形状 | 离线 |
| `tests/title-map.mjs` | 主标题 = profession、副标题 = name 口径 | 离线 |
| `tests/search-check.mjs` | 搜索字段覆盖与关键词命中 | 离线 |
| `tests/tab-switch-check.mjs` | `listSeed` 切 tab / 同 tab 搜索不闪 + TAB_ORDER（专家团 / 专家 / 市场三 tab） | 离线 |
| `tests/motion-audit-check.mjs` | 面板 CSS 动效审计（时长 / 退场 / reduced-motion） | 离线 |
| `tests/panel-pos-check.mjs` | 面板 bottom 锚定 + maxHeight 由空间决定 | 离线 |
| `tests/local-package-check.mjs` | 本机市场包只做兜底、不进目录（457 条回归） | 离线 |
| `tests/mirror-gap.mjs` | 本机镜像 / 市场包与目录差异观察（观察型） | 离线 |
| `tests/shim-check.mjs` | 垫片自装边界：幂等 / 只覆盖自己 / 他人文件跳过 / 安全失败 | 离线 |
| `tests/bundle-fallback-check.mjs` | 新包 tar.gz 回退源契约（`--online` 才联网实测） | 离线 |
| `tests/render-check.mjs` | 目录 → 取包 → 注入文本全链路 | 需包缓存 |
| `tests/host-probe.mjs` | 假 ctx 跑 apply()：section / 6 工具 / 路由 / 求值器 / 取消 | 需包缓存 |
| `tests/matrix-check.mjs` | 多形态（6 人团 / 21 人团 / 单专家 / 骨架包）+ 去重 | 需包缓存 |
| `tests/paging-check.mjs` | 技能正文分段续读 / ref 取用 / 成员按需读 | 需包缓存 |
| `tests/ui-shape-check.mjs` | `/catalog` 与 `/entry` 的 UI 字段 / 分类 / 团队 members | 需包缓存 |
| `tests/dump-section.mjs` | 注入段结构抽查（可传 plugin 参数） | 需包缓存 |
| `tests/section-gc-check.mjs` | 注入段落盘 GC：删而不留空、sweep 不误删活文件 | 需包缓存（会自清理） |
| `tests/session-isolation-check.mjs` | 会话级隔离：A/B/C 三会话互不影响、未召唤零注入 | 需包缓存（会自清理） |
| `tests/avatar-check.mjs` | 头像三类路径 / LRU / 并发 / 尺寸归一 / 安全边界 | 需网络（COS） |
| `tests/avatar-route-check.mjs` | 头像 HTTP 路由：PNG / ETag / 304 / 404 | 需网络（COS） |

没有用例需要 Electron 或真 DSH：host 类用例都用假 `ctx` 直接跑 `apply()`，HTTP 用例直接调路由 handler。

### market 类用例的隔离约定（重要）

`tests/market-unit.mjs` / `tests/market-check.mjs` 都**不碰**你真实的 `~/.dsh/workbuddy-summon/market-token.json`：

- 测试进程先把 `USERPROFILE` / `HOME` 指向临时目录，`STATE_ROOT` 因此落在 temp 下 —— 于是「无 token」的场景天然可复现；
- 若隔离失败（换了平台 / Node 行为变化），用例**立刻判红退出**，不会写真实目录；
- 用例开头与结尾各取一次真实 token 文件的 `sha256` 并断言一致，证明没改名、没覆盖。

## 回归结果（0.4.0，本机 2026-10-28）

Node 绝对路径、串行跑 `tests/*.mjs` 全量 **25 个用例**：

| 类别 | 结果 |
|---|---|
| `node --check`（`index.js` + `lib/*.js` + `tests/*.mjs`） | 全通过 |
| `tests/*.mjs` 全量 | **25 PASS / 0 FAIL / 0 TIMEOUT** |
| 其中 SKIP | `tests/shim-check.mjs` 1 条（Windows 无 POSIX 执行位，预期跳过）；用例本身 PASS |
| 不依赖 Electron 的用例 | 全绿 |
| 0.4.0 新增 | `tests/local-packs-check.mjs`（内置包离线可发现 / 16 agent / 15 技能 / 注入段 15 人） |

`tests/local-package-check.mjs` 在干净环境（本机没有市场包）会整例 SKIP —— 本机有市场包，所以正常跑完。

## 已知边界

- **部分官方包只有骨架**：少数包在公开 COS 上 `plugin.json` / `promptFile` 404（走登录态分发）。召唤这类包会明确报「定义取不到」而不是假装成功；补法是在 WorkBuddy 里召唤一次，让包落到 `~/.workbuddy/plugins/` 后本机兜底就能读到正文。
- **市场必须登录态**：没 token / token 过期时市场不可用；这是官方接口的限制，不是插件的开关。
- **市场首次召唤要下载**：签名 zip 几百 KB～数 MB，首次召唤比官方专家慢；之后走本地缓存。签名地址有时效，过期重新取一次即可（`ensureMarketPackage` 自己会重新申请）。
- 专家包 `skills/`、`bin/` 里的可执行脚本**不会**自动执行，只作为文本按需读取（市场包同样）。
- 头像依赖 COS 数据万象的实时缩略；离线时面板回退首字圆形。
- 目录跟随快照：WorkBuddy 升级后如果专家数变化，先跑 `node tests/catalog-parity.mjs` 看差异，再决定是否更新本 CASE 的 448 口径。

---

## 许可证与第三方内容

- **插件代码**（`index.js` / `lib/` / `tests/` / `bin/` / 团队编排定义）: [MIT](LICENSE)。
- **内置专家团的成员定义与技能**：来自 WorkBuddy 专家包的公开内容，版权归各自作者，**本仓库不再许可**；
  原许可证副本在 `packs/all-domain-brain-trust/THIRD-PARTY-LICENSES/`，完整声明见 [NOTICE.md](NOTICE.md)。
- 如你是权利人且不希望内容被收录，提 issue 即可移除对应文件。

---

## ☕ 赞赏支持

如果 dsh-workbuddy-summon 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
