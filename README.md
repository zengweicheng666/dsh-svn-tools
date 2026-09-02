# dsh-svn-tools

SVN (Subversion) 工具 + 侧边栏 UI 插件，为 DeepSeek Harness 提供：

## Agent 工具（33 个）

| 分类 | 工具 |
|---|---|
| 状态/信息 | `svn_status`（含 changelist 分组）`svn_info` |
| 差异/历史 | `svn_diff` `svn_log` `svn_blame`（逐行追溯） |
| 仓库浏览 | `svn_list` `svn_cat`（不带工作副本直接看仓库） |
| 变更操作 | `svn_add` `svn_delete` `svn_mkdir` `svn_copy`（分支/标签）`svn_move` `svn_revert` |
| 提交 | `svn_commit`（中文 UTF-8 日志） |
| 更新/检出 | `svn_update` `svn_checkout` `svn_switch` `svn_relocate` `svn_upgrade` |
| 冲突/清理 | `svn_resolve`（mine/theirs/base/working）`svn_cleanup` |
| 属性 | `svn_propget` `svn_propset` `svn_proplist` `svn_propdel`（svn:ignore 等） |
| 分支/合并 | `svn_merge` `svn_mergeinfo` |
| 锁定 | `svn_lock` `svn_unlock`（UE 二进制资产友好） |
| 分组 | `svn_changelist`（set/remove/list） |
| 其他 | `svn_import` `svn_export` `svn_patch` |

所有写操作使用 `--non-interactive`；中文消息/属性值统一走 UTF-8 临时文件 + `--encoding utf-8`。

## 侧边栏 UI（dsh-better-sidebar 的 `svn` 分页）

- **仓库信息**：URL、当前 revision、刷新
- **变更**：状态列表（徽标 + changelist 标签），点击行看 diff；**左右版本对比视图**（左列版本库 BASE、右列工作副本，等宽双栏 + 自动换行永不截断，红/绿高亮增删行，可切回文本 diff）；**差异导航**：对比视图顶部提供「◀ 上一处 / 下一处 ▶」（Previous difference / Next difference）在差异块间跳转，自动滚动文本使选中差异块进入可视区（块可放下时居中）并高亮，附 `当前位置/总数` 计数；导航条吸顶固定，滚动时不会被顶出视野；**差异块操作**：悬停任意差异块可选择「采用左侧 / 采用右侧 / 都保留·左先 / 都保留·右先」直接修改工作副本文件；行内操作：
  - `Add`（未版本化）、`Delete`、`Revert`（确认弹窗）
  - `Blame`：逐行追溯视图
  - `解决`（冲突 C 状态）：弹窗选择 我的版本 / 仓库版本 / 基准版本 / 保留当前
  - `忽略`（未版本化）：快捷写入 svn:ignore
- **提交**：勾选文件或提交全部、中文日志（`✨ AI 生成日志` 用当前模型自动生成）、提交后显示新 revision；**自动处理构建产物替换**（未版本化 `?` 文件自动 `svn add`、缺失 `!` 文件自动 `svn delete`，提交全部时对所选目录一并生效，结果在提示栏显示）
- **历史**：log 列表；点击版本 → 上下分栏（上栏列表、下栏该版本日志与变更路径，分隔条可拖动调整比例）；点击文件路径 → 该版本与上一版本（rN vs rN-1）的只读左右对比（复用「变更」对比视图，中文/特殊字符路径走仓库 URL 编码读取）；文件行悬停显示回退按钮（均修改工作副本、不会自动提交，文件以 M/A/D 呈现在「提交」页，由用户自行提交；「修改前」= 该文件上一次变更的修订，即该文件被 rN 修改之前的版本，可能远早于 rN-1）：
  - **撤销 rN 改动**：`svn merge -r rN:rN-1` 反向合入工作副本该文件——典型场景（工作副本即 rN 或该文件 rN 后未再改动）下文件即恢复为它被修改前的内容；rN 之后的改动保留；文本可能产生冲突标记、二进制可能报冲突（可走「提交」页「解决」）；新增类文件正确调度为计划删除、删除类文件计划恢复
  - **回退到修改前**：用该文件上一次修改修订的仓库内容（`svn cat` 流式写入临时文件，任意大小的二进制均支持）精确覆盖工作副本文件——rN 之后对该文件的改动与本地未提交修改会被丢弃；rN 新增的文件改为删除该文件、rN 删除的文件恢复并计划添加；当工作副本该文件的 BASE 恰好就是「修改前版本」时直接用本地 pristine 还原（`svn revert`），无需联网下载
  - **退回到此版本**：用该文件在 rN（此版本）的内容覆盖当前工作副本文件——rN 之后改动与本地未提交修改被丢弃；rN 删除的文件从工作副本删除、rN 新增的文件写入 rN 内容并计划添加；工作副本 BASE 恰为 rN 时本地 `svn revert` 还原，无需联网；r1 版本行仅显示此按钮
  - **执行行高亮**：单文件执行（或多选逐个执行）时，正在执行的文件行高亮 + 行内 spinner，执行完成自动恢复
  - **多选批量工具栏**：详情分隔条下方的工具栏，左侧「多选」切换（多选模式下每行出现勾选框、悬停单文件按钮隐藏，另有「全选/清空」）；右侧按勾选情况显示「撤销 rN 改动 / 回退到修改前 / 退回到此版本」批量按钮——无勾选时不显示；含 r1 行时撤销/回退不显示。批量操作为单次确认 + 逐文件串行执行（避免工作副本锁冲突），失败文件记录并继续，结束时汇总成功/失败；切换版本详情自动清空勾选
- **工具栏**：`分支`（列出 branches 并切换）、`清理`（svn cleanup）、`更新`
- **检出引导**：目录不是工作副本时自动显示 checkout 表单

所有操作经服务端 `/svn/api/*` 路由执行（同源 fence 鉴权，session 工作副本解析），与 agent 工具共用同一套执行核心。

## 安装

```sh
dsh plugin --profile web add file:./plugins/dsh-svn-tools
```

并确保 `package.json` 的 `dsh.profile.bundles` 中包含 `dsh-svn-tools`。重启 dsh web 后生效。

## 前提

- `svn` 命令行客户端在 PATH 中（Windows 上为 `svn.exe`）。
- dsh-better-sidebar 已安装（侧边栏 UI 依赖）。
- 输出解码：优先 UTF-8，失败回退 GBK（中文 Windows 控制台）。
