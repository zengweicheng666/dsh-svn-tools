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
- **历史**：log 列表；点击版本 → 上下分栏（上栏列表、下栏该版本日志与变更路径，分隔条可拖动调整比例）；点击文件路径 → 该版本与上一版本（rN vs rN-1）的只读左右对比（复用「变更」对比视图，中文/特殊字符路径走仓库 URL 编码读取）
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
