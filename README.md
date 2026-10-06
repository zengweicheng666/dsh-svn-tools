<div align="right">

**简体中文** · [English](README.en.md)

</div>

# dsh-svn-tools

> **Subversion 工具与侧边栏面板，为 DeepSeek Harness 而生。**
> 给 agent 一套完整的 `svn_*` 工具，给人一个能落在 **DSH 自带右侧栏**（或 dsh-better-sidebar）的 SVN 面板 —— 两者共用同一套执行核心。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-4c8bf5.svg)](#与-dsh-的版本兼容)
[![tools](https://img.shields.io/badge/agent%20tools-33-2ea44f.svg)](#agent-工具33-个)
[![verified](https://img.shields.io/badge/verified-0.1.6%20%7C%200.2.0--rc.2-8957e5.svg)](#自检与开发)

**无前置依赖**：面板载体可切换，也可完全不注册（只用 agent 工具）；插件不在安装期执行任何脚本。

---

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速上手](#快速上手)
- [侧边栏面板](#侧边栏面板)
  - [载体](#载体) · [变更](#变更页) · [提交](#提交页) · [历史](#历史页) · [在线-离线-只读](#在线--离线--只读)
- [Agent 工具（33 个）](#agent-工具33-个)
- [设置（10 项）](#设置10-项)
- [与 DSH 的版本兼容](#与-dsh-的版本兼容)
- [更新与安装形态](#更新与安装形态)
- [安全模型](#安全模型)
- [自检与开发](#自检与开发)
- [常见问题](#常见问题)
- [许可](#许可)

---

## 特性

| | |
|---|---|
| **33 个 `svn_*` agent 工具** | 覆盖状态、差异、历史、属性、分支/合并、锁定、changelist、导入导出等完整子命令面；中文提交日志走 UTF-8 临时文件 + `--encoding utf-8`，避开 Windows GBK 控制台的乱码 |
| **一个面板，两种载体** | 渲染在 **DSH 自带右侧栏**（`kind: svn` 分页 + 向导入口）或 **dsh-better-sidebar**；载体在设置里切换，不可用时自动回退，两个都没有就退化为 `off` |
| **左右版本对比** | 左列版本库 BASE、右列工作副本；差异块导航 + 「采用左侧 / 采用右侧 / 都保留」直接改工作副本 |
| **服务不可达时仍可用** | 离线模式下「历史」取自本地日志缓存 + `.svn/wc.db` 修订元数据，只读模式一键禁写（服务端双重拦截） |
| **提交前自动整理** | 未版本化 `?` 自动 `svn add`、缺失 `!` 自动 `svn delete`，结果如实回报（含失败项）；两个动作各有开关 |
| **两代 DSH 通用** | 兼容 `>=0.1.0-rc.6`；设置入口按版本自动适配（0.1.x 命名空间卡片 / 0.2.x 条目配置表单） |

## 安装

从 [DSH 插件市场](https://awesome-dsh-plugin.com/p/zengweicheng666/dsh-svn-tools/) 安装，或任选一种命令行方式：

```sh
# 推荐：裸仓库 spec —— 更新检查器与插件市场都能跟踪后续版本
dsh plugin --profile web add github:zengweicheng666/dsh-svn-tools

# 锁定某个版本（可复现安装；代价见「更新与安装形态」）
dsh plugin --profile web add github:zengweicheng666/dsh-svn-tools#v0.13.4

# 本地源码开发
dsh plugin --profile web add file:./plugins/dsh-svn-tools
```

安装后**重启 dsh**（宿主半侧负责注册设置与侧边栏分页）。用 `file:` 方式时，还需把 `dsh-svn-tools` 加入 profile `package.json` 的 `dsh.profile.bundles`。

**前置条件**

- `svn` 命令行客户端在 `PATH` 中（Windows 为 `svn.exe`），或在设置里指定 `svnPath`。
- 面板需要一个载体：DSH `0.1.0-rc.6+` 自带右侧栏即可；老版本请装 [dsh-better-sidebar](https://github.com/omdsh-dev/dsh-better-sidebar)。两者都没有时面板不注册，**agent 工具不受影响**。
- 输出解码优先 UTF-8，失败回退 GBK（中文 Windows 控制台）。

## 快速上手

1. 重启后打开右侧栏的 **SVN** 分页（或从「向导」里的 SVN 胶囊进入）。
2. 面板以当前**会话工作目录**为工作副本；若不是工作副本，会显示检出表单。
3. 在「变更」里查看改动 → 在「提交」里写日志（可点 `✨ AI 生成日志`）→ 提交。
4. 也可以直接让 agent 用工具，例如「用 `svn_status` 看看有哪些改动，然后 `svn_commit` 提交」。

---

## 侧边栏面板

### 载体

同一套面板渲染在两个载体里，**行为完全一致**；切换立即生效（当前已打开的分页会关闭，重新打开即可）。载体在**面板挂载之前**就已按宿主解析出的设置确定，因此配 `off` / `better-sidebar` 不会先闪出一个自带侧边栏分页。

| `sidebarCarrier` | 含义 |
|---|---|
| `auto`（默认） | 有 DSH 自带侧边栏（`0.1.0-rc.6+`）就用它，否则回退 dsh-better-sidebar |
| `native` | 只用 DSH 自带侧边栏（右侧栏的 SVN 分页，出现在向导里） |
| `better-sidebar` | 只用 dsh-better-sidebar 的 SVN 分页（老版本 DSH 的选择） |
| `off` | 不注册任何面板，只用 33 个 agent 工具 |

### 变更页

- **列表**：状态徽标 + changelist 标签；单击行 = 选中高亮；悬停出现「比对」，双击行进入差异。
- **框选**：左键拖动框选多行（只加高亮，不动勾选）；随后点击组内任一行身、或切换组内任一复选框，会把该行勾选状态同步给整组（约 0.25 s 后执行；双击进比对时自动取消，不会误翻转整组）。
- **左右对比视图**：等宽双栏 + 自动换行永不截断，红/绿高亮增删行，可切回文本 diff。
- **差异导航**：对比视图顶部 `◀ 上一处 / 下一处 ▶` 在差异块间跳转，自动滚动使目标块进入可视区并高亮，附 `当前位置/总数` 计数；导航条吸顶。
- **差异块操作**：悬停任意差异块可选择「采用左侧 / 采用右侧 / 都保留·左先 / 都保留·右先」，直接修改工作副本文件。
- **行内操作**：`比对`、`添加`（未版本化）、`删除`、`还原`（确认弹窗）、`追溯`（逐行）、`解决`（冲突 `C`：我的/仓库/基准/保留当前）、`忽略`（写 `svn:ignore`）。
- **批量工具栏**：按勾选情况显示「删除 / 回退」（与行内同语义；未版本化 `?` 与冲突 `C` 不计入；无勾选时不显示；单次确认后清空勾选）。
- **工具栏**：`分支`（列出 branches 并切换）、`清理`（`svn cleanup`）、`更新`。

### 提交页

- 勾选文件或提交全部；中文日志走 UTF-8 临时文件，`✨ AI 生成日志` 用当前模型生成；提交后显示新 revision。
- **范围联动**：勾上「提交全部变更」→ 上方全部可见文件勾选，取消 → 全部取消；在列表里勾选任一文件自动转为「按所选提交」，取消最后一个勾选后停在「未勾选任何文件」（提交禁用，不会自动跳回提交全部）。
- **AI 只分析提交范围**：提交全部 = 全部可见变更；只勾部分 = 仅这些文件；未勾选文件不进分析；范围内为空时按钮禁用。
- **「显示无版本控制的文件」**：初始状态取自设置 `showUnversionedDefault`；取消勾选后 `?` 文件从列表隐藏，并**排除出「提交全部变更」与 AI 分析**（不会自动 add/提交）；`!` 缺失文件不受影响、仍自动删除。
- **提交前自动整理**：未版本化 `?` 自动 `svn add`、缺失 `!` 自动 `svn delete`（提交全部时对所选目录一并生效），结果在提示栏显示；关掉对应开关后这些文件不提交，并单独列出。

### 历史页

- **列表**：首屏最近 N 条（N = 设置 `historyPageSize`，默认 30）；底部「加载更早的版本」按同样条数逐页追加直到 r1，追尽后显示「已显示全部 N 条历史」。
- **详情**：点击版本 → 上下分栏（上栏列表、下栏该版本日志与变更路径），分隔条可拖动；悬停「比对」或双击文件路径 → 该版本与上一版本的**只读**左右对比（复用变更页对比视图；中文/特殊字符路径走仓库 URL 编码读取）。
- **文件列表**：勾选框常显（始终多选），交互与提交页一致（点行/框选/组同步）。
- **行内与批量操作**（只改工作副本，**不会自动提交**；文件会以 `M/A/D` 重新出现在「提交」页由你决定）：

| 操作 | 语义 |
|---|---|
| **撤销 rN 改动** | `svn merge -r rN:rN-1` 反向合入该文件；rN 之后的改动保留。文本可能产生冲突标记、二进制可能报冲突（可在提交页「解决」）；新增类文件正确调度为计划删除，删除类文件计划恢复 |
| **回退到修改前** | 用该文件**上一次修改修订**（prevRev）的仓库内容精确覆盖工作副本（`svn cat` 流式写入临时文件，任意大小二进制均支持）；rN 之后改动与本地未提交修改丢弃；rN 新增的文件改为删除、rN 删除的文件恢复并计划添加。BASE 恰好就是「修改前版本」时直接用本地 pristine 还原（`svn revert`），无需联网 |
| **退回到此版本** | 用该文件在 rN 的内容覆盖工作副本；rN 删除的从工作副本删除、rN 新增的写入内容并计划添加；BASE 恰为 rN 时本地还原，无需联网。r1 行只显示此按钮 |

- **批量**：工具栏左侧常显「全选/清空」，右侧按勾选显示上述三个批量按钮（含 r1 行时不显示撤销/回退）；单次确认 + 逐文件串行执行（避免工作副本锁冲突），失败记录并继续，结束时汇总成功/失败；切换版本详情自动清空勾选。
- **执行反馈**：正在执行的文件行高亮 + 行内 spinner，完成后恢复。

### 在线 · 离线 · 只读

标题栏右侧常显模式徽标（在线 / 离线 / 只读），并提供 `离线`、`只读`、`刷新` 三个开关；进入离线或只读时顶部出现横幅说明原因与影响。**离线是临时状态，不提供「永远离线」**：每次点「重试」都会重新探测服务器，成功后自动恢复在线数据。

**离线**时 `svn log` 无法使用，历史列表来自两处，并在条目上标注来源：

1. **本地日志缓存** —— 每次在线成功取到的 `svn log`（日志文本、作者、时间、变更路径）落盘到工作副本 `.svn/dsh-history-cache.json`（写入失败时退回 `%LOCALAPPDATA%\dsh-svn-tools\history\`），离线直接复用，标 `缓存`；
2. **工作副本修订元数据** —— 从 `.svn/wc.db` 的 `NODES.changed_revision/changed_author/changed_date` 按修订号重建**本次工作副本子树**的变更文件列表，标 `本地元数据`。

SVN 不在工作副本保存提交日志文本，因此这些条目明确显示「没有日志文本」，删除的文件也无法还原；横幅会提示这是**不完整、可能过时甚至误导**的本地数据（与 TortoiseSVN 的离线提示一致）。

- 离线期间**写操作全部置灰**（提交/添加/删除/还原/回退/更新/锁定…）—— 它们要么需要服务器，要么会产生无法提交的本地改动；查看、比对、追溯不受影响。
- 历史详情的 `比对` 仍可用：`.svn/pristine` 保存着工作副本当前持有的那个版本的**真实版本库内容**，因此 rN↔rN-1 在本地能取到的那一侧照常显示（横幅会说明「只反映本地已有的那一侧」）；取不到的修订标「本地不可用」，而不是谎称「不存在」。回退类操作只在能**证明**目标版本就是本地持有的版本时执行，证明不了就报可读的「离线无法完成」——绝不会因为离线就把「撤销 rN」误判成「rN 新增」而删掉文件。
- **只读**：在线但禁用全部写操作（`只读` 按钮或横幅「退出只读」），适合只想查看/比对时防误操作；服务端 `/svn/api/*` 也会拒绝带 `readOnly` 的写请求（双保险，`export` 同样计入写操作）。
- **自动降级**：需要服务器的操作遇到传输错误（`E170013` 服务器不可达、`E210005` 无此版本库）时面板自动进入离线并保留错误信息；`E210005` 会额外说明「服务器可达但该 URL 已没有版本库（可能被改名/删除/停用）」。其它 svn 错误（冲突、非工作副本、权限）照常报错，不会被当成离线。

---

## Agent 工具（33 个）

| 分类 | 工具 |
|---|---|
| 状态 / 信息 | `svn_status`（含 changelist 分组） · `svn_info` |
| 差异 / 历史 | `svn_diff` · `svn_log` · `svn_blame`（逐行追溯） |
| 仓库浏览 | `svn_list` · `svn_cat`（无需工作副本直接读仓库，路径或 `svn://` URL 均可） |
| 变更 | `svn_add` · `svn_delete` · `svn_mkdir` · `svn_copy`（分支/标签） · `svn_move` · `svn_revert`（可选 `-R`） |
| 提交 | `svn_commit`（中文 UTF-8 日志） |
| 更新 / 检出 | `svn_update` · `svn_checkout` · `svn_switch` · `svn_relocate` · `svn_upgrade` |
| 冲突 / 清理 | `svn_resolve`（mine/theirs/base/working） · `svn_cleanup` |
| 属性 | `svn_propget` · `svn_propset` · `svn_proplist` · `svn_propdel`（`svn:ignore` 等） |
| 分支 / 合并 | `svn_merge` · `svn_mergeinfo` |
| 锁定 | `svn_lock` · `svn_unlock`（对 UE 二进制资产友好） |
| 分组 | `svn_changelist`（set / remove / list） |
| 其他 | `svn_import` · `svn_export` · `svn_patch` |

约定：

- 所有写操作带 `--non-interactive`，不会交互式挂住 agent 会话。
- 位置参数（属性名、URL、分支路径、`relocate` 的 from/to 等）拒绝以 `-` 开头，避免被 svn 当成选项；路径操作数前统一加 `--`。
- 只读类工具（`readOnly: true`）可安全地并行调用。

---

## 设置（10 项）

配置由插件自己的 `Config`（schemastery）声明，**入口随 DSH 版本不同**，取值都从这份 schema 派生：

| DSH | 入口 | 落在哪里 | 生效方式 |
|---|---|---|---|
| **0.2.x** | 插件管理器里本插件条目自己的配置页（schema 派生表单，按 profile 条目 id 键控） | **profile patch**（条目自身的 `config`） | 写入后由 Loader 重载该条目 |
| **0.1.x** | 设置 → 插件 → 插件配置 → 「SVN 工具」卡片 | `$DSH_HOME/settings.yaml` 的 `dsh-svn-tools:` 段 | 立即生效、无需重启；已覆盖字段标「已改」，可单项「恢复默认」 |

| 设置 | 默认 | 作用 |
|---|---|---|
| `sidebarCarrier` | `auto` | 侧边栏载体：`auto` / `native` / `better-sidebar` / `off` |
| `svnPath` | 空 | `svn` 可执行文件路径；空 = 用 PATH 上的 `svn`。`svnversion` 在同目录自动查找，找不到回退 PATH。0.1.x 卡片带「检测」（`svn --version --quiet`） |
| `commandTimeoutScale` | `1` | 命令超时倍数（0.2–20）：乘以每条 svn 命令的默认超时（普通 60 s、更新/提交 300 s）；仓库慢或工作副本大时调 2–3 |
| `historyPageSize` | `30` | 「历史」首屏条数，也是「加载更早的版本」每次追加的条数（5–200） |
| `historyCacheEnabled` | `true` | 是否把取到的 `svn log` 缓存到工作副本 `.svn/dsh-history-cache.json`（服务器不可达时「历史」仍可用） |
| `historyCacheMaxEntries` | `20000` | 单工作副本缓存上限（100–200000），按版本号从新到旧保留 |
| `autoAddUnversioned` | `true` | 提交前对选中的未版本化 `?` 文件自动 `svn add`；关闭后不添加，并在结果里列出被跳过的文件 |
| `autoDeleteMissing` | `true` | 提交前对已版本化但磁盘缺失 `!` 的文件自动 `svn delete`；关闭后同样列出被跳过的文件 |
| `showUnversionedDefault` | `true` | 「提交」页「显示无版本控制的文件」的初始勾选状态（面板内仍可随时切换） |
| `defaultView` | `commit` | 面板默认分页：`commit` / `history` / `locks` |

非法取值（拼错的载体名、越界数字）会被 schema 拒绝：0.2.x 表单不接受该输入；0.1.x 手改 `settings.yaml` 时 DSH 保留该命名空间上一个可用值并告警，最坏情况下命名空间注册失败，此时插件按内置默认值运行。

---

## 与 DSH 的版本兼容

- `peerDependencies`：`@deepseek-ai/dsh-tools: >=0.1.0-rc.6`，同时声明 `engines.dsh: >=0.1.0-rc.6`。
  自带侧边栏自 `0.1.0-rc.6` 起可用，因此判断标准是「rc.6 及以上全部支持」，不按大版本切段。
- DSH 的插件兼容门禁（`dsh-app-boot` 的 `evaluatePluginCompatibility`）只用
  `semver.satisfies(runtime, range, { includePrerelease: true })` 判 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 两类 peer，
  预发布参与比较。
- 插件市场（`dshmarket`）用 `deriveHostCompatibility` 判定，并把 `engines.dsh` 与 peer 一起作为**合取**条件。
- 已在真实运行时上验证：**0.1.6** 与 **0.2.0-rc.2**（含全部 peer 依赖）自检通过；
  并用门禁与市场各自的实际判定函数实测本清单：`0.1.0-rc.6` / `0.1.5-rc.1` / `0.1.6-alpha.1` / `0.2.0-rc.2` / `0.2.1-alpha.1` / `0.3.0-rc.1` 全部兼容，`0.1.0-rc.5` 被拦。

## 更新与安装形态

[dsh-update-checker](https://github.com/Airmetro/dsh-update-checker) 与插件市场是两条独立通道，**能收到哪种提示取决于安装形态**：

- 检查器需要两件事：已安装副本的 `package.json` 有 **`repository` 字段**（本包自 0.13.0 起声明），以及仓库有 **GitHub Release**（本仓库按 `v<版本>` 发布）。
  它按**版本号**比较，所以 tag/commit pin 的安装同样能收到提示。
- 插件市场按 **ref / commit 身份**比较：裸仓库 spec 会跟随默认分支；一旦装成带 ref 的 spec（`#v0.13.4` 或 `#<commit>`），**市场对那个 ref 永远报「已是最新」**——这是 pin 的语义（可复现安装优先），不是故障。

因此：

| 你的目标 | 做法 |
|---|---|
| 跟随版本 | 装裸仓库 spec，或直接从市场条目安装 |
| 可复现安装 | 装 `#v<版本>`；后续用检查器的更新提示升级（它会写回新的 tag pin） |
| 解除 pin | 重装一次裸仓库 spec |

版本变更见 [Releases](https://github.com/zengweicheng666/dsh-svn-tools/releases)。

## 安全模型

- **同源栅栏**：所有面板请求走服务端 `/svn/api/*`；该路由校验 `Host` 必须回环或在本部署的 `trustedHosts` 中、拒绝 `Sec-Fetch-Site: cross-site`、并把 `Origin` 的**完整 authority（含端口）**与 `Host` 比对 —— 与 DSH 上游 `api-request-trust` 一致。非 POST、非 `/svn/api/` 前缀或未知方法一律 404/405。
- **只读双保险**：客户端置灰写按钮，服务端对携带 `readOnly` 的写方法（含 `export`）返回 403。
- **参数与路径**：不经过 shell（始终 argv 数组）；仓库 URL 原样透传而不是当成文件路径；属性名/URL/分支等位置参数拒绝 `-` 开头（挡住 `--config-dir=` 这类可导致 svn 执行外部程序的注入）；历史回退的仓库相对路径会做**文件系统包含性校验**并拒绝 `..`/绝对路径。
- **安装期零脚本**（0.13.3 起）：没有 `preinstall`/`postinstall`，不触发依赖脚本授权，也不会在 profile 的 `allowBuilds` 里累积条目。
- 插件会读写工作副本、调用 `svn`、并按你的设置访问网络（版本库）与本地模型（生成提交日志）；除此之外不写入其它位置。

## 离线与只读

见 [在线 · 离线 · 只读](#在线--离线--只读)。要点：离线是临时状态（每次「重试」重新探测）、写操作全部置灰、历史来自缓存 + wc.db 元数据且明确标注不完整、回退类操作只在能证明目标版本时执行。

## 自检与开发

```sh
npm run verify:hardening      # 纯 Node：URL 直通、位置参数防注入、提交修复结果形状
npm run verify:settings       # 纯 Node：载体解析/回退、设置 store、载体注册账目、设置卡片
npm run verify:offline        # 纯 Node：离线/只读策略、三态界面渲染、无「永久离线」入口
npm run verify:readme         # 纯 Node：中英 README 的锚点/切换入口/License、工具与设置表与代码一致
npm run verify:settings:host  # 需要真实工作副本：命名空间与默认值、非法值拒绝、svnPath/超时生效
npm run verify:offline:host   # 需要真实工作副本：本地历史与分页、连接分类、只读拒绝、离线回退不误删
```

前三个脚本只需要 Node（+ React，用于静态渲染）；后两个接收一个工作副本路径。
`verify:offline:host` 在参数缺省时用当前目录。

仓库结构：

```
lib/index.js        宿主半侧：33 个 agent 工具、/svn/api/*、设置解析、离线/只读策略
lib/client.js       浏览器半侧：面板、载体注册、设置卡片（无构建步骤，仅依赖 shell 提供的 react）
cordis.patch.yml    profile 层组合（条目 id svn-tools）
scripts/verify-*.mjs 上述自检脚本
```

## 常见问题

<details>
<summary><b>面板没有出现？</b></summary>

确认载体：设置里 `sidebarCarrier` 为 `off` 时不会注册面板；为 `native` 需要 DSH `0.1.0-rc.6+` 的自带右侧栏；为 `better-sidebar` 需要已安装 dsh-better-sidebar。`auto` 会自动挑一个可用的。改完设置需要重载该插件条目（0.2.x）或重启 dsh。

</details>

<details>
<summary><b>看不到更新提示？</b></summary>

检查器要求已安装副本有 `repository` 字段与仓库有 Release（见[更新与安装形态](#更新与安装形态)）；`< 0.13.0` 的旧安装副本没有该字段，需要手工升级一次才能进入自动提示循环。若你用带 ref 的 spec 安装，插件市场不会提示——那是 pin 的语义，请用检查器提示或改回裸仓库 spec。

</details>

<details>
<summary><b>提交时中文日志乱码？</b></summary>

本插件始终用 UTF-8 临时文件 + `--encoding utf-8 -F` 提交，并在读取输出时优先 UTF-8、失败回退 GBK。若仍异常，通常是 `svn` 客户端版本过旧或系统区域设置强制了非 UTF-8 转换。

</details>

<details>
<summary><b>只读模式下为什么 `export` 也被禁？</b></summary>

`svn export` 会把一棵树写到指定目录（`--force` 时覆盖），属于写盘操作，因此 0.13.3 起计入写方法。

</details>

<details>
<summary><b>安装时被兼容门禁拦下？</b></summary>

本包 peer 为 `>=0.1.0-rc.6`，0.1.0-rc.6 及以上的正式版与预发布都放行。若你看到拒绝，请确认安装的是 `>=0.13.2` 的版本（更早版本声明的是 `^0.1.0-rc.6`，会被 0.2.x 门禁拒绝）。

</details>

## 许可

[MIT](LICENSE)
