[English](README.md) | [中文](README.zh-CN.md)

# Stack Radar

一个面向前端仓库的依赖升级智能 CLI。它回答的是 Dependabot 和 `npm-check-updates` 回答不了的问题：**"这次升级，*现在*、对*这个项目*来说，到底值不值得做？"**

每条建议都由规则引擎驱动。AI（通过 `--use-ai` 显式开启）仅用于从 changelog 中提取证据。本地 grep 检查这些变更过的 API 是否真的被代码用到。源码永远不会被发送到网络。

## 为什么需要它

- **Dependabot / `ncu`** 回答 *"有没有新版本？"*
- **Stack Radar** 回答 *"考虑到这个项目实际用了什么、changelog 里写了什么、团队选择如何承担风险——现在该不该升？"*

输出是一份 Markdown 报告，把所有依赖分到六个推荐档：Upgrade Now / Safe to Upgrade / Review First / Watch / Blocked / Defer——每条都带一个 Confidence 分数，并在开启 `--use-ai` 时附带 changelog 的引语证据。

## 流水线

```
scan          → .stack-radar/stack.json     (deps + lockfile + workspaces)
check-updates → .stack-radar/updates.json   (versions + changelog text + advisories + signals)
recommend     → .stack-radar/reports/<date>.md
                  (三维评分 + profile 调整 → Recommendation + Confidence)
                  --use-ai 追加 AI evidence (→ confidence + report)
                          以及 code relevance (→ value)
```

辅助命令：`init-profile`（起草 `project-profile.yaml`）、`scan-api-usage`（临时 API 使用计数）、`feedback`（snooze/decline/accept）、`watch-trends`（独立的社区雷达）。

## 环境要求

- **Node.js ≥ 20**（在 [package.json](package.json) 中声明）
- **可选：ripgrep** —— `--use-ai` 使用它做 API-usage grep。如果 `PATH` 上没有 `rg`，Stack Radar 会回退到一个语义完全相同的纯 Node 实现。
- **可选：`GITHUB_TOKEN` 或 `GH_TOKEN`** —— 不设的话 `check-updates` 会受 GitHub 速率限制，部分包会降级为只读 CHANGELOG。
- **可选：`ANTHROPIC_API_KEY`** —— AI 功能**仅在默认 `api` 后端下**需要。想完全不用 key，就用 `--ai-backend claude-cli` / `codex-cli` 把 AI 走本地已登录的 CLI（见[使用 AI](#使用-ai默认关闭)）。

## 安装与构建

暂未发布到 npm，从源码构建：

```bash
git clone <repo-url> stack-radar
cd stack-radar
npm install
npm run build
```

会把 TypeScript 编译到 `dist/`。运行 CLI：`node dist/cli.js <command>`。

## 快速开始

```bash
node dist/cli.js scan          --repo <path-to-your-repo>
node dist/cli.js check-updates --repo <path-to-your-repo>
node dist/cli.js recommend     --repo <path-to-your-repo>
cat <path-to-your-repo>/.stack-radar/reports/*.md
```

想要带证据的报告，在 `recommend` 上加 `--use-ai`。默认 `api` 后端需要 `ANTHROPIC_API_KEY`；或者加 `--ai-backend claude-cli`（或 `codex-cli`）复用本地已登录的 CLI，免去 key。重跑命中本地磁盘缓存，会打印 `AI calls: 0`。详见[使用 AI](#使用-ai默认关闭)。

## 命令

所有命令都接受 `--repo <path>`（默认 `.`），并把产物写到 `<repo>/.stack-radar/` 下。命令定义见 [src/cli.ts](src/cli.ts)。

### `scan`

遍历仓库，解析 `package.json`（根目录 + 各 workspace）、解析 lockfile（npm / Yarn v1 / Yarn Berry / pnpm）、对依赖分类。

```bash
node dist/cli.js scan --repo <path>
```

输出 `.stack-radar/stack.json`。

### `check-updates`

对 `stack.json` 中的每个依赖，查询**公共** npm registry、GitHub releases（若设了 `GITHUB_TOKEN`）、OSV 安全公告，并提取 changelog 文本与关键字信号。

```bash
node dist/cli.js check-updates --repo <path>
node dist/cli.js check-updates --repo <path> --refresh   # 绕过缓存
```

输出 `.stack-radar/updates.json`。**升级 Stack Radar 本身之后请重跑这个命令** —— 老的 `updates.json` 缺少新版 `recommend` 需要的字段。

### `init-profile`

通过推断 `product_type`、`tech_taste`、`upgrade_policy`、`hard_constraints` 来起草 `.stack-radar/project-profile.yaml`。**每个字段都需要你审阅** —— 生成的文件顶部带 `# NEEDS REVIEW` 标记。

```bash
node dist/cli.js init-profile --repo <path>
node dist/cli.js init-profile --repo <path> --force   # 覆盖已有 profile
```

编辑这个文件后，**删除 `# NEEDS REVIEW` 这一行**，`recommend` 才会信任它。在这行还在的时候，`recommend` 仍会运行，但会向 stderr 打印一条警告（这是刻意设计，不是 bug）。

### `recommend`

对 `updates.json` 做三维评分（urgency / risk / value），叠加 profile 调整，可选地折入 AI 证据与代码相关性，然后写一份 Markdown 报告。

```bash
node dist/cli.js recommend --repo <path>
node dist/cli.js recommend --repo <path> --use-ai                       # AI 证据 + 代码相关性（api 后端）
node dist/cli.js recommend --repo <path> --use-ai --ai-backend claude-cli # 走你的 Claude Code CLI（无需 API key）
node dist/cli.js recommend --repo <path> --use-ai --dry-run             # 打印 prompt，不调用 API/CLI
node dist/cli.js recommend --repo <path> --use-ai --refresh           # 重新分析，绕过 AI 缓存
node dist/cli.js recommend --repo <path> --no-profile                 # 忽略 profile
node dist/cli.js recommend --repo <path> --profile <path>            # 显式指定 profile 路径
node dist/cli.js recommend --repo <path> --out report.md             # 写到指定路径
node dist/cli.js recommend --repo <path> --use-ai --ai-model <id>    # 覆盖模型
```

默认报告路径：`.stack-radar/reports/<YYYY-MM-DD>.md`。默认 AI 模型：`api` → `claude-sonnet-4-6`，`claude-cli` → Opus。后端详见 [使用 AI](#使用-ai默认关闭)。

### `scan-api-usage`

对指定的 API 标识符做本地使用计数 —— 适合在主流水线之外做临时检查。

```bash
node dist/cli.js scan-api-usage --repo <path> --apis useState,useEffect
node dist/cli.js scan-api-usage --repo <path> --apis useState --package react
```

输出只有 `match_count` 和 `file_count` —— 没有文件路径、没有代码片段。

### `feedback`

针对一个包（可选附带 semver 范围）记录一个决定。`recommend` 下次运行时会读取这些决定；它们影响*展现方式*，不影响底层的评分。

```bash
# snooze（在指定日期之前隐藏）
node dist/cli.js feedback --repo <path> --package react --action snooze --until 2026-12-31

# decline（弱化为 Watch，除非出现新的安全公告）
node dist/cli.js feedback --repo <path> --package eslint --action decline --reason "team prefers biome"

# accept（标记为已知悉）
node dist/cli.js feedback --repo <path> --package vite --action accept --version-range "5.x"
```

必填：`--package`、`--action`。`snooze` 还需要 `--until <YYYY-MM-DD>`。输出 `.stack-radar/decisions.json`。

### `watch-trends`

独立的社区雷达 —— 轮询硬编码的 RSS 源（newsletter 和 release feed），用 AI 从公开的 title/summary 中抽取工具名，跟你的 stack 做匹配，然后输出一份观察列表。**不参与升级评分。**

```bash
node dist/cli.js watch-trends --repo <path>
node dist/cli.js watch-trends --repo <path> --ai-backend codex-cli  # 走你的 Codex CLI（无需 API key）
node dist/cli.js watch-trends --repo <path> --dry-run    # 无需 API key；只打印 prompt
node dist/cli.js watch-trends --repo <path> --refresh    # 即便有缓存也重新抽取
```

输出 `.stack-radar/community-watchlist.md` 和 `.stack-radar/trends.json`。**建议每周跑一次** —— 这个节奏既匹配 newsletter 的发刊节奏，也匹配 ≥2 周的 Signal 门槛。先跑 `scan`，否则 Signals 会被禁用（同时给出明显警告）。

## 使用 AI（默认关闭）

AI 默认是**关闭**的。在 `recommend` 上加 `--use-ai`（或直接运行 `watch-trends`）来启用。有三种后端，用 `--ai-backend` 选择：

| 后端 | 认证方式 | 何时使用 |
|---|---|---|
| `api`（默认） | `ANTHROPIC_API_KEY`（按 token 计费） | CI，或本地没装 CLI |
| `claude-cli` | 你已登录的 **Claude Code** CLI（订阅） | 复用你的 Claude 订阅 —— 无需 API key，不按 token 计费 |
| `codex-cli` | 你已登录的 **Codex** CLI（订阅） | 复用你的 ChatGPT/Codex 订阅 |

```bash
# 把 AI 调用走你本地已登录的 CLI，而不是计费的 API：
node dist/cli.js recommend --repo <path> --use-ai --ai-backend claude-cli   # 默认用 Opus
node dist/cli.js recommend --repo <path> --use-ai --ai-backend codex-cli
node dist/cli.js watch-trends --repo <path> --ai-backend codex-cli
node dist/cli.js recommend --repo <path> --use-ai --ai-backend claude-cli --ai-command /path/to/claude
```

- **默认模型**：`api` → `claude-sonnet-4-6`（计费场景下的成本取舍）；**`claude-cli` → Opus**（`claude-opus-4-8`）—— 订阅不按 token 计费，所以默认用最强的模型；`codex-cli` → 你的 Codex CLI 配置的模型。都可以用 `--ai-model <id>` 覆盖（例如 `--ai-model opus` 用最新 Opus）。
- **`ANTHROPIC_API_KEY`** 只有 `api` 后端需要。CLI 后端走 CLI 自己的登录，无需 key。
- **成本**：`api` 后端按 token 计费（约 50 个依赖首次运行几分钱）；CLI 后端走你已有的订阅。任何后端重跑都会命中本地磁盘缓存（`.stack-radar/cache/ai-analyses/`、`.stack-radar/cache/trends-extractions/`），通常打印 `AI calls: 0`。缓存按后端分键，所以切换后端会重新分析一次。
- **`--dry-run`** 打印 prompt 但不调用 API/CLI。无需 key。不会写缓存。
- **`--refresh`** 绕过 AI 缓存重新分析。
- **AI 能看到什么**：包的元信息（名称、当前版本、最新版本）+ 截断的 changelog 文本 + 粗粒度 profile 字段（`product_type`、`tech_taste`）。仅此而已。
- **AI 永远看不到什么**：你的源码。永远不会。（CLI 后端**不是**纯本地离线模型 —— prompt 仍会经 CLI 的登录发往厂商的远端模型。"不发送源码" 的保证通过另一种方式实现：每次调用都让 CLI 禁用文件工具 / 只读沙箱，运行在一个空的临时目录里，并清理环境变量，因此它读不到你的仓库。）
- **反编造校验**：模型返回的每条引语都会被校验为它所引用的 changelog 的原文子串；引用的 URL 必须是我们提供给它的。校验失败的引语会被丢弃，该条记录被标记为低质量。AI 只影响 Confidence 和报告的 Why / Evidence 段落 —— 它**永远不会**改变 Recommendation。影响评分的字段（`mentioned_apis`、性能信号）同样必须在提供的文本中有依据。

## Project profile

profile 用来区分 "这是一个直接面向用户的应用" 和 "这是一个内部 SDK"。没有 profile 时，`recommend` 会回退到全局评分。

工作流：

```bash
node dist/cli.js init-profile --repo <path>
# 编辑 .stack-radar/project-profile.yaml
# 删除开头的 "# NEEDS REVIEW" 行
node dist/cli.js recommend --repo <path>
```

profile 通过五条规则（`R1–R5`）影响评分 —— 例如，`hard_constraints.node` 会让需要更新 Node 的包变成 Blocked；`tech_taste: conservative` 会把 breaking 变更推向 Watch；`tech_taste: aggressive` 则会放宽干净的 major 升级。完整规则见 [PLAN.md](PLAN.md) §8。

## Trend watcher

`watch-trends` 是与升级评分**完全独立**的一路。它的作用是把社区信号摆出来 —— "圈内是不是在从 X 迁到 Y？" —— 但绝不把这种噪音耦合进你的依赖报告。

- 轮询 11 个 RSS 源，分布在 7 个发布方 group（JS Weekly、Frontend Focus、This Week in React、VoidZero releases、TanStack、Biome、GitHub Trending JS/TS）。
- 一个 *Signal* 需要满足：≥3 个发布方 group、≥2 周、≥2 个故事、跟你的 stack 有匹配、且不是 release 集中冲量。
- 输出：`community-watchlist.md`（给人看）+ `trends.json`（增量存储）。
- 每周跑一次。一天之内重跑通常零成本，因为 feed 还没发新内容。

## Feedback loop

`feedback` 按 `(package, version_range)` 维度写一条决定。下一次 `recommend` 会读取这些决定并调整展现：

- **snooze**：在 `today < until` 期间从报告和 stdout 隐藏。在 `until` 当天自动复出。被 snooze 的记录也会跳过 AI 和相关性扫描。
- **decline**：弱化为 **Watch**，除非出现安全公告（此时保留原推荐并打标记）。
- **accept**：仅打标记 —— 不改评分。适合 "我们知道这个，下个迭代做"。

决定永远不会改底层评分 —— 只改报告里展现出来的内容。

## 隐私

Stack Radar 围绕三条规则设计：

1. **只查公共 npm。** 查询硬编码到 `registry.npmjs.org`。如果你的 `.npmrc` 指向私有镜像，那个镜像**不会**被当作隐私信号 —— Stack Radar 把它当作镜像，而不是 "哪些包属于私有" 的判断依据。
2. **workspace 包名一律不外发。** 本地 workspace 包会从 registry 查询中剔除（zero-leak）。内部 scope（例如 `@yourcompany/...`）在公共 registry 上可能 404 —— 这是预期行为。
3. **AI 永远看不到源码。** 启用 `--use-ai` 时，发送的只有：包的元信息 + changelog 文本 + 粗粒度 profile 字段。`scan-api-usage` 和相关性 grep 只输出 `match_count` 和 `file_count` —— 没有路径、没有代码。本地 CLI 后端（`--ai-backend claude-cli`/`codex-cli`）仍会经 CLI 的登录把 prompt 发往远端模型（并非离线），但每次调用都禁用 CLI 的文件工具 / 用只读沙箱，运行在空的临时目录里，并清理环境变量 —— 所以它读不到你的仓库。

## 输出目录结构

Stack Radar 写出的所有东西都在 `.stack-radar/` 下，建议加入 gitignore：

```
<repo>/.stack-radar/
├── stack.json                  scan 输出
├── updates.json                check-updates 输出
├── project-profile.yaml        init-profile 输出（由你编辑）
├── decisions.json              feedback 日志
├── trends.json                 watch-trends 增量存储
├── reports/<YYYY-MM-DD>.md     recommend 输出
├── community-watchlist.md      watch-trends 渲染输出
└── cache/
    ├── npm/                    registry 响应缓存
    ├── github/                 release/changelog 响应缓存
    ├── osv/                    安全公告响应缓存
    ├── changelogs/             提取后的 changelog 文本
    ├── ai-analyses/            AI 抽取缓存（recommend --use-ai）
    └── trends-extractions/     AI 抽取缓存（watch-trends）
```

## License

[MIT](package.json)
