/**
 * dsh-svn-tools client half: registers the 'svn' sidebar tab into
 * dsh-better-sidebar (ctx.betterSidebar.registerTab) and renders a small
 * SVN panel — working-copy status, per-file diff, commit with Chinese UTF-8
 * log, update, and history — talking to the fenced /svn/api/* routes served
 * by this package's host half.
 *
 * Bundle format: window.__ModuleLoader__.load({id, factory}), CJS factory.
 * Only shell-seeded modules are required (react). No build step needed.
 */
window.__ModuleLoader__.load({
  id: "dsh-svn-tools",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // ------------------------------------------------------------ styles
    var STYLE_ID = "dsh-svn-tools-style";
    var CSS = [
      ".dsh-svn{display:flex;flex-direction:column;height:100%;min-width:0;font:12px/1.5 system-ui,sans-serif;color:#c9d1d9;background:transparent}",
      ".dsh-svn *{box-sizing:border-box}",
      ".dsh-svn-header{padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.15);display:flex;align-items:center;gap:8px;min-width:0}",
      ".dsh-svn-repo{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#8b949e}",
      ".dsh-svn-rev{flex-shrink:0;font-size:11px;color:#58a6ff;background:rgba(88,166,255,.12);border-radius:4px;padding:1px 6px}",
      ".dsh-svn-toolbar{padding:6px 10px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(148,163,184,.12)}",
      ".dsh-svn-seg{display:flex;gap:2px;flex:1;min-width:0}",
      ".dsh-svn-tabbtn{border:1px solid transparent;background:transparent;color:#8b949e;font-size:11px;padding:3px 10px;border-radius:6px;cursor:pointer}",
      ".dsh-svn-tabbtn:hover{color:#c9d1d9;background:rgba(148,163,184,.1)}",
      ".dsh-svn-tabbtn.on{color:#e6edf3;background:rgba(88,166,255,.15);border-color:rgba(88,166,255,.3)}",
      ".dsh-svn-actbtn{border:1px solid rgba(148,163,184,.3);background:rgba(148,163,184,.08);color:#c9d1d9;font-size:11px;padding:3px 10px;border-radius:6px;cursor:pointer;flex-shrink:0}",
      ".dsh-svn-actbtn:hover{background:rgba(148,163,184,.18)}",
      ".dsh-svn-actbtn:disabled{opacity:.5;cursor:default}",
      ".dsh-svn-actbtn.primary{background:rgba(46,160,67,.25);border-color:rgba(46,160,67,.5);color:#7ee787}",
      ".dsh-svn-actbtn.danger{background:rgba(248,81,73,.15);border-color:rgba(248,81,73,.45);color:#ffa198}",
      ".dsh-svn-body{flex:1;min-height:0;overflow:auto;padding:6px 0}",
      ".dsh-svn-summary{padding:2px 12px 6px;font-size:11px;color:#8b949e}",
      ".dsh-svn-row{display:flex;align-items:center;gap:8px;padding:3px 10px;cursor:pointer;min-width:0}",
      ".dsh-svn-row:hover{background:rgba(148,163,184,.08)}",
      ".dsh-svn-badge{flex-shrink:0;width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0d1117}",
      ".dsh-svn-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#c9d1d9}",
      ".dsh-svn-rowops{flex-shrink:0;display:none;gap:4px}",
      ".dsh-svn-row:hover .dsh-svn-rowops{display:flex}",
      ".dsh-svn-mini{border:1px solid rgba(148,163,184,.3);background:transparent;color:#8b949e;font-size:10px;padding:1px 6px;border-radius:4px;cursor:pointer}",
      ".dsh-svn-mini:hover{color:#c9d1d9}",
      ".dsh-svn-mini.danger:hover{color:#ffa198;border-color:rgba(248,81,73,.5)}",
      ".dsh-svn-mini.ok:hover{color:#7ee787;border-color:rgba(46,160,67,.5)}",
      ".dsh-svn-check{flex-shrink:0;accent-color:#58a6ff}",
      ".dsh-svn-empty{padding:24px 12px;text-align:center;color:#6e7681;font-size:12px}",
      ".dsh-svn-diff{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre;overflow:auto;padding:8px 12px;color:#c9d1d9;max-height:100%}",
      ".dsh-svn-difftitle{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid rgba(148,163,184,.12);font-size:12px;color:#e6edf3}",
      ".dsh-svn-logrow{padding:6px 12px;border-bottom:1px solid rgba(148,163,184,.08);cursor:pointer}",
      ".dsh-svn-logrow:hover{background:rgba(148,163,184,.06)}",
      ".dsh-svn-loghead{display:flex;gap:8px;align-items:baseline;font-size:11px}",
      ".dsh-svn-logrev{color:#58a6ff;font-weight:700}",
      ".dsh-svn-logmeta{color:#8b949e;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-svn-logmsg{margin-top:2px;font-size:12px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all}",
      ".dsh-svn-logpaths{margin-top:4px;font-size:11px;color:#8b949e;white-space:pre-wrap}",
      ".dsh-svn-commit{padding:8px 12px;display:flex;flex-direction:column;gap:8px}",
      ".dsh-svn-lbl{font-size:11px;color:#8b949e}",
      ".dsh-svn-ta{width:100%;min-height:88px;resize:vertical;background:#0d1117;color:#e6edf3;border:1px solid rgba(148,163,184,.25);border-radius:6px;padding:6px 8px;font:12px/1.5 system-ui,sans-serif}",
      ".dsh-svn-ta:focus{outline:none;border-color:#58a6ff}",
      ".dsh-svn-statusbar{padding:4px 10px;border-top:1px solid rgba(148,163,184,.12);font-size:11px;color:#8b949e;min-height:24px;display:flex;align-items:center;gap:6px}",
      ".dsh-svn-statusbar.err{color:#ffa198}",
      ".dsh-svn-statusbar.ok{color:#7ee787}",
      ".dsh-svn-spin{width:10px;height:10px;border:2px solid rgba(148,163,184,.25);border-top-color:#58a6ff;border-radius:50%;animation:dsh-svn-spin .8s linear infinite;flex-shrink:0}",
      "@keyframes dsh-svn-spin{to{transform:rotate(360deg)}}",
      ".dsh-svn-badge.M{background:#e5c07b}.dsh-svn-badge.A{background:#7ee787}.dsh-svn-badge.D{background:#ffa198}.dsh-svn-badge.R{background:#d2a8ff}",
      ".dsh-svn-badge.C{background:#ff7b72}.dsh-svn-badge.\\!{background:#f0883e}.dsh-svn-badge.\\?{background:#8b949e}.dsh-svn-badge.\\~{background:#f0883e}",
      ".dsh-svn-input{width:100%;background:#0d1117;color:#e6edf3;border:1px solid rgba(148,163,184,.25);border-radius:6px;padding:5px 8px;font:12px/1.5 system-ui,sans-serif}",
      ".dsh-svn-input:focus{outline:none;border-color:#58a6ff}",
      ".dsh-svn-overlay{position:fixed;inset:0;background:rgba(1,4,9,.6);display:flex;align-items:center;justify-content:center;z-index:2147483000}",
      ".dsh-svn-modal{width:min(420px,86vw);max-height:80vh;overflow:auto;background:#161b22;border:1px solid rgba(148,163,184,.3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}",
      ".dsh-svn-modal h4{margin:0;font-size:13px;color:#e6edf3}",
      ".dsh-svn-modal-row{display:flex;gap:6px;align-items:center}",
      ".dsh-svn-opt{border:1px solid rgba(148,163,184,.3);background:rgba(148,163,184,.08);color:#c9d1d9;font-size:12px;padding:5px 10px;border-radius:6px;cursor:pointer;text-align:left}",
      ".dsh-svn-opt:hover{background:rgba(148,163,184,.18)}",
      ".dsh-svn-blameline{display:flex;gap:8px;padding:1px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre;min-width:0}",
      ".dsh-svn-blameline:hover{background:rgba(148,163,184,.08)}",
      ".dsh-svn-blameinfo{flex-shrink:0;color:#8b949e;width:110px;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-svn-blamecode{flex:1;min-width:0;color:#c9d1d9;white-space:pre;overflow-x:auto}",
      ".dsh-svn-cltag{flex-shrink:0;font-size:10px;color:#d2a8ff;background:rgba(210,168,255,.12);border-radius:4px;padding:0 5px}",
      ".dsh-svn-toolbar-wrap{display:flex;flex-direction:column;gap:4px;padding:6px 10px;border-bottom:1px solid rgba(148,163,184,.12)}",
      ".dsh-svn-toolbar{display:flex;align-items:center;gap:6px}",
      ".dsh-svn-clbar{display:flex;gap:4px;flex-wrap:wrap}",
      ".dsh-svn-clchip{border:1px solid rgba(210,168,255,.4);background:rgba(210,168,255,.1);color:#d2a8ff;font-size:10px;padding:1px 8px;border-radius:10px;cursor:pointer}",
      ".dsh-svn-clchip:hover{background:rgba(210,168,255,.2)}",
      ".dsh-svn-clchip.on{background:rgba(210,168,255,.3);color:#e6edf3}",
      ".dsh-svn-checkout{flex:1;display:flex;flex-direction:column;gap:10px;justify-content:center;padding:20px}",
      ".dsh-svn-hint{font-size:11px;color:#8b949e;line-height:1.6}",
      ".dsh-svn-sideswrap{flex:1;min-height:0;display:flex;flex-direction:column}",
      ".dsh-svn-sideshead{display:flex;border-bottom:1px solid rgba(148,163,184,.15);font-size:11px;color:#8b949e;flex-shrink:0}",
      ".dsh-svn-sidehead{width:50%;min-width:0;padding:4px 10px}",
      ".dsh-svn-sidehead.r{border-left:1px solid rgba(148,163,184,.15)}",
      ".dsh-svn-sidehead b{color:#e6edf3}",
      ".dsh-svn-sides{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55}",
      ".dsh-svn-line{display:flex;min-width:100%}",
      ".dsh-svn-cell{width:50%;flex:none;min-width:0;display:flex}",
      ".dsh-svn-cell.r{border-left:1px solid rgba(148,163,184,.18)}",
      ".dsh-svn-cell.del{background:rgba(248,81,73,.15)}",
      ".dsh-svn-cell.add{background:rgba(46,160,67,.14)}",
      ".dsh-svn-block{position:relative}",
      ".dsh-svn-blockbar{position:absolute;top:-10px;right:6px;z-index:6;display:none;gap:4px;background:#1c2128;border:1px solid rgba(148,163,184,.35);border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(1,4,9,.5)}",
      ".dsh-svn-block.change:hover .dsh-svn-blockbar{display:flex}",
      ".dsh-svn-lineno{flex-shrink:0;width:44px;text-align:right;padding:0 8px;color:#6e7681;user-select:none}",
      ".dsh-svn-cell.del .dsh-svn-lineno{color:#ffa198}",
      ".dsh-svn-cell.add .dsh-svn-lineno{color:#7ee787}",
      ".dsh-svn-linetext{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding:0 12px 0 6px;color:#c9d1d9}",
    ].join("");

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function removeStyle() {
      var el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    }

    // ------------------------------------------------------------- api
    async function call(method, payload) {
      var res = await fetch("/svn/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      var parsed = null;
      try { parsed = await res.json(); } catch (e) { /* not json */ }
      if (!res.ok || !parsed || parsed.ok !== true || parsed.value === undefined) {
        var msg = (parsed && parsed.error && parsed.error.message) || ("HTTP " + res.status);
        throw new Error(msg);
      }
      return parsed.value;
    }

    // ------------------------------------------------------------ icons
    function svnIcon(size) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", style: { flexShrink: 0 } },
        h("circle", { cx: 12, cy: 12, r: 10.5, fill: "#6b8fc4" }),
        h("path", { d: "M12 3.5 V20.5", stroke: "#fff", strokeWidth: 1.8, strokeLinecap: "round" }),
        h("path", { d: "M12 8 C 8.5 10.2, 8.5 13.8, 12 16 C 15.5 13.8, 15.5 10.2, 12 8 Z", fill: "none", stroke: "#fff", strokeWidth: 1.6, strokeLinecap: "round" }),
        h("path", { d: "M6.5 18.5 H17.5", stroke: "#fff", strokeWidth: 1.8, strokeLinecap: "round" })
      );
    }

    // ---------------------------------------------------------- helpers
    var STATUS_META = {
      M: { label: "已修改", color: "#e5c07b" },
      A: { label: "已添加", color: "#7ee787" },
      D: { label: "已删除", color: "#ffa198" },
      R: { label: "已替换", color: "#d2a8ff" },
      C: { label: "冲突", color: "#ff7b72" },
      "!": { label: "缺失", color: "#f0883e" },
      "?": { label: "未版本化", color: "#8b949e" },
      "~": { label: "类型变更", color: "#f0883e" },
    };

    function statusMeta(code) {
      return STATUS_META[code] || { label: code || "?", color: "#8b949e" };
    }

    function shortDate(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      var p = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function shortPath(p) {
      var parts = String(p).split(/[\\/]/);
      return parts[parts.length - 1];
    }

    // --------------------------------------------------------- components
    function SidesView(props) {
      var s = props.sides;
      if (s.leftMissing && s.rightMissing) {
        return h("div", { className: "dsh-svn-empty" }, "两侧内容均不可用");
      }
      // group consecutive changed pairs into blocks (hover target for text choice)
      var blocks = [];
      var cur = null;
      s.pairs.forEach(function (pair, idx) {
        var eq = !!(pair.left && pair.right && !pair.modified);
        if (eq) {
          if (cur) { blocks.push(cur); cur = null; }
          blocks.push({ change: false, start: idx, end: idx, items: [{ idx: idx, pair: pair }] });
        } else {
          if (!cur) cur = { change: true, start: idx, end: idx, items: [] };
          cur.end = idx;
          cur.items.push({ idx: idx, pair: pair });
        }
      });
      if (cur) blocks.push(cur);
      var choose = function (block, mode) {
        if (props.onChoose) props.onChoose(block, mode);
      };
      var blockEls = blocks.map(function (b) {
        var bar = b.change
          ? h("div", { className: "dsh-svn-blockbar" },
              h("button", { className: "dsh-svn-mini", onClick: function () { choose(b, "left"); } }, "采用左侧"),
              h("button", { className: "dsh-svn-mini", onClick: function () { choose(b, "right"); } }, "采用右侧"),
              h("button", { className: "dsh-svn-mini", onClick: function () { choose(b, "both-left-first"); } }, "都保留·左先"),
              h("button", { className: "dsh-svn-mini", onClick: function () { choose(b, "both-right-first"); } }, "都保留·右先")
            )
          : null;
        var lines = b.items.map(function (it) {
          var p = it.pair;
          // modified rows (merged del+add) render left red AND right green on
          // ONE horizontal line; plain del/add color only their own side.
          var clsL = p.left && !p.right ? " del" : "";
          var clsR = p.right && !p.left ? " add" : "";
          if (p.modified) { clsL = " del"; clsR = " add"; }
          return h("div", { className: "dsh-svn-line", key: it.idx },
            h("div", { className: "dsh-svn-cell" + clsL },
              h("span", { className: "dsh-svn-lineno" }, p.left ? p.left.no : ""),
              h("span", { className: "dsh-svn-linetext" }, p.left ? p.left.text : "")),
            h("div", { className: "dsh-svn-cell r" + clsR },
              h("span", { className: "dsh-svn-lineno" }, p.right ? p.right.no : ""),
              h("span", { className: "dsh-svn-linetext" }, p.right ? p.right.text : ""))
          );
        });
        return h("div", { className: "dsh-svn-block" + (b.change ? " change" : ""), key: b.start }, bar, lines);
      });
      return h("div", { className: "dsh-svn-sideswrap" },
        h("div", { className: "dsh-svn-sideshead" },
          h("div", { className: "dsh-svn-sidehead", title: "版本库中的内容（左侧）" },
            "◀ 版本库 " + (s.revision ? h("b", {}, " r" + s.revision) : ""), s.leftMissing ? "（新增文件）" : ""),
          h("div", { className: "dsh-svn-sidehead r", title: "工作副本中的内容（右侧）" },
            "工作副本 ▶", s.rightMissing ? "（已删除）" : "")
        ),
        h("div", { className: "dsh-svn-sides" }, blockEls)
      );
    }

    function DiffView(props) {
      var sides = props.sides;
      var [mode, setMode] = useState(sides && !sides.binary ? "sides" : "text");
      var body;
      if (mode === "sides" && sides && !sides.binary) {
        body = h(SidesView, { sides: sides, onChoose: props.onChoose });
      } else {
        body = h("pre", { className: "dsh-svn-diff" }, props.diff || "(无差异)");
      }
      return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        h("div", { className: "dsh-svn-difftitle" },
          h("button", { className: "dsh-svn-mini", onClick: props.onBack }, "← 返回"),
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.path),
          sides && !sides.binary
            ? h("button", { className: "dsh-svn-mini", onClick: function () { setMode(mode === "sides" ? "text" : "sides"); } },
              mode === "sides" ? "文本 diff" : "左右对比")
            : null,
          props.onBlame ? h("button", { className: "dsh-svn-mini", onClick: props.onBlame }, "Blame") : null,
          h("span", { className: "dsh-svn-rev" }, props.revision ? "r" + props.revision : "")
        ),
        body
      );
    }

    function BlameView(props) {
      var entries = props.entries || [];
      if (entries.length === 0) return h("div", { className: "dsh-svn-empty" }, "无追溯信息");
      var rows = entries.map(function (e) {
        return h("div", { className: "dsh-svn-blameline", key: e.line },
          h("span", { className: "dsh-svn-blameinfo", title: (e.date || "") + "  by " + (e.author || "?") },
            "r" + e.revision + " " + (e.author || "?")),
          h("span", { className: "dsh-svn-blamecode" }, e.text)
        );
      });
      return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        h("div", { className: "dsh-svn-difftitle" },
          h("button", { className: "dsh-svn-mini", onClick: props.onBack }, "← 返回"),
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.path),
          h("span", { className: "dsh-svn-rev" }, "Blame")
        ),
        h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 0" } }, rows)
      );
    }

    function ResolveModal(props) {
      var opts = [
        { accept: "mine-full", label: "采用我的版本", desc: "保留本地修改，丢弃仓库版本" },
        { accept: "theirs-full", label: "采用仓库版本", desc: "以仓库内容为准，丢弃本地修改" },
        { accept: "base", label: "采用基准版本", desc: "回到冲突前的原始内容" },
        { accept: "working", label: "保留当前内容", desc: "我已手动编辑，标记为已解决" },
      ];
      return h("div", { className: "dsh-svn-overlay", onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); } },
        h("div", { className: "dsh-svn-modal" },
          h("h4", {}, "解决冲突：" + (props.path || "")),
          opts.map(function (o) {
            return h("div", { className: "dsh-svn-modal-row", key: o.accept },
              h("button", { className: "dsh-svn-opt", style: { flex: 1 }, onClick: function () { props.onPick(o.accept); } },
                h("div", { style: { fontWeight: 600 } }, o.label),
                h("div", { style: { fontSize: 11, color: "#8b949e" } }, o.desc))
            );
          }),
          h("div", { className: "dsh-svn-modal-row", style: { justifyContent: "flex-end" } },
            h("button", { className: "dsh-svn-actbtn", onClick: props.onCancel }, "取消"))
        )
      );
    }

    function BranchModal(props) {
      var branches = props.branches || [];
      var [url, setUrl] = useState(props.currentUrl || "");
      return h("div", { className: "dsh-svn-overlay", onClick: function (e) { if (e.target === e.currentTarget) props.onCancel(); } },
        h("div", { className: "dsh-svn-modal" },
          h("h4", {}, "切换分支 / URL"),
          branches.length > 0 ? h("div", { className: "dsh-svn-clbar" },
            branches.map(function (b) {
              return h("button", { className: "dsh-svn-clchip", key: b, onClick: function () { setUrl(b); } }, b);
            })
          ) : null,
          h("div", { className: "dsh-svn-lbl" }, "目标 URL"),
          h("input", { className: "dsh-svn-input", value: url, placeholder: "svn://host/repo/branches/feature-x", onChange: function (e) { setUrl(e.target.value); } }),
          h("div", { className: "dsh-svn-modal-row", style: { justifyContent: "flex-end" } },
            h("button", { className: "dsh-svn-actbtn", onClick: props.onCancel }, "取消"),
            h("button", { className: "dsh-svn-actbtn primary", disabled: props.busy || url.trim() === "", onClick: function () { props.onSwitch(url.trim()); } },
              props.busy ? "切换中…" : "切换"))
        )
      );
    }

    function CheckoutView(props) {
      var [url, setUrl] = useState("");
      return h("div", { className: "dsh-svn-checkout" },
        h("div", { style: { fontSize: 14, fontWeight: 700, color: "#e6edf3" } }, "检出 SVN 工作副本"),
        h("div", { className: "dsh-svn-hint" },
          "当前目录不是 SVN 工作副本（或尚未检出）。输入仓库 URL 检出到当前目录。"),
        h("input", { className: "dsh-svn-input", value: url, placeholder: "svn://host/repo/trunk", onChange: function (e) { setUrl(e.target.value); } }),
        h("div", { className: "dsh-svn-modal-row", style: { justifyContent: "flex-end" } },
          h("button", { className: "dsh-svn-actbtn primary", disabled: props.busy || url.trim() === "", onClick: function () { props.onCheckout(url.trim()); } },
            props.busy ? "检出中…" : "检出到当前目录"))
      );
    }

    function ChangesView(props) {
      var entries = props.entries || [];
      var sel = props.sel;
      if (entries.length === 0) {
        return h("div", { className: "dsh-svn-empty" }, "工作副本干净，没有变更 ✓");
      }
      var rows = entries.map(function (e) {
        var meta = statusMeta(e.status);
        var isNew = e.status === "?";
        var isConflict = e.status === "C";
        return h("div", { className: "dsh-svn-row", key: e.path, onClick: function () { props.onDiff(e.path); } },
          h("input", { type: "checkbox", className: "dsh-svn-check", checked: !!sel[e.path],
            onClick: function (ev) { ev.stopPropagation(); }, onChange: function (ev) { props.onToggle(e.path, ev.target.checked); } }),
          h("span", { className: "dsh-svn-badge " + e.status, title: meta.label, style: { background: meta.color } }, e.status),
          h("span", { className: "dsh-svn-path", title: e.path }, e.path),
          e.changelist ? h("span", { className: "dsh-svn-cltag" }, e.changelist) : null,
          h("span", { className: "dsh-svn-rowops", onClick: function (ev) { ev.stopPropagation(); } },
            isConflict
              ? h("button", { className: "dsh-svn-mini", style: { color: "#ff7b72", borderColor: "rgba(255,123,114,.5)" }, onClick: function () { props.onResolve(e.path); } }, "解决")
              : null,
            !isNew && !isConflict
              ? h("button", { className: "dsh-svn-mini", onClick: function () { props.onBlame(e.path); } }, "Blame")
              : null,
            isNew
              ? h("button", { className: "dsh-svn-mini ok", onClick: function () { props.onAdd([e.path]); } }, "Add")
              : null,
            isNew
              ? h("button", { className: "dsh-svn-mini", onClick: function () { props.onIgnore(e.path); } }, "忽略")
              : null,
            !isNew && !isConflict
              ? h("button", { className: "dsh-svn-mini danger", onClick: function () { props.onDelete([e.path]); } }, "Delete")
              : null,
            !isNew && !isConflict
              ? h("button", { className: "dsh-svn-mini danger", onClick: function () { props.onRevert([e.path]); } }, "Revert")
              : null
          )
        );
      });
      var summary = Object.keys(props.summary || {}).map(function (k) {
        return statusMeta(k).label + " " + props.summary[k];
      }).join(" · ");
      return h("div", {},
        h("div", { className: "dsh-svn-summary" }, summary),
        rows
      );
    }

    function HistoryView(props) {
      var entries = props.entries || [];
      if (entries.length === 0) return h("div", { className: "dsh-svn-empty" }, "暂无提交历史");
      var rows = entries.map(function (e) {
        var open = props.openRev === e.revision;
        return h("div", { className: "dsh-svn-logrow", key: e.revision, onClick: function () { props.onToggleRev(e.revision); } },
          h("div", { className: "dsh-svn-loghead" },
            h("span", { className: "dsh-svn-logrev" }, "r" + e.revision),
            h("span", { className: "dsh-svn-logmeta" }, (e.author || "?") + " · " + shortDate(e.date))
          ),
          h("div", { className: "dsh-svn-logmsg" }, e.message || ""),
          open && e.paths && e.paths.length > 0
            ? h("div", { className: "dsh-svn-logpaths" }, e.paths.map(function (p) { return p.action + "  " + p.path; }).join("\n"))
            : null
        );
      });
      return h("div", {}, rows);
    }

    function CommitView(props) {
      var selPaths = Object.keys(props.sel || {}).filter(function (p) { return props.sel[p]; });
      var allCount = (props.entries || []).length;
      var commitAll = selPaths.length === 0 || props.commitAll;
      return h("div", { className: "dsh-svn-commit" },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { className: "dsh-svn-lbl", style: { flex: 1 } }, "提交日志（项目规范：中文）"),
          h("button", { className: "dsh-svn-actbtn", disabled: props.aiBusy || allCount === 0, onClick: props.onAiGenerate },
            props.aiBusy ? "生成中…" : "✨ AI 生成日志")
        ),
        h("textarea", { className: "dsh-svn-ta", placeholder: "在此输入提交日志，或点击「AI 生成日志」根据当前变更自动生成", value: props.msg, onChange: function (e) { props.onMsg(e.target.value); } }),
        h("div", { className: "dsh-svn-lbl" },
          commitAll
            ? "将提交全部 " + allCount + " 个变更"
            : "将提交 " + selPaths.length + " 个已选文件" + (allCount > selPaths.length ? "（未选文件不会提交）" : "")
        ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8b949e" } },
            h("input", { type: "checkbox", className: "dsh-svn-check", checked: commitAll, onChange: function (e) { props.onCommitAll(e.target.checked); } }),
            "提交全部变更"
          ),
          h("button", { className: "dsh-svn-actbtn primary", disabled: props.busy || props.msg.trim() === "", onClick: props.onCommit },
            props.busy ? "提交中…" : "提交")
        )
      );
    }

    // ----------------------------------------------------------- main tab
    function SvnPanel(props) {
      var scope = props.scope || {};
      var sessionId = scope.sessionId;
      var [repo, setRepo] = useState(null);
      var [entries, setEntries] = useState(null);
      var [summary, setSummary] = useState(null);
      var [logs, setLogs] = useState(null);
      var [view, setView] = useState("changes");
      var [diff, setDiff] = useState(null);
      var [busy, setBusy] = useState(false);
      var [err, setErr] = useState(null);
      var [notice, setNotice] = useState(null);
      var [msg, setMsg] = useState("");
      var [sel, setSel] = useState({});
      var [commitAll, setCommitAll] = useState(true);
      var [openRev, setOpenRev] = useState(null);
      var [aiBusy, setAiBusy] = useState(false);
      var [blame, setBlame] = useState(null);
      var [resolvePath, setResolvePath] = useState(null);
      var [branchModal, setBranchModal] = useState(false);
      var [branchList, setBranchList] = useState(null);
      var [checkoutMode, setCheckoutMode] = useState(false);

      var payload = useCallback(function (extra) {
        var base = { sessionId: sessionId };
        if (scope.cwd) base.cwd = scope.cwd;
        if (extra) Object.assign(base, extra);
        return base;
      }, [sessionId, scope.cwd]);

      var loadAll = useCallback(async function (silent) {
        if (!silent) setBusy(true);
        setErr(null);
        try {
          var p = payload();
          var r = await call("root", p);
          var s = await call("status", p);
          setRepo(r);
          setEntries(s.entries);
          setSummary(s.summary);
          setCheckoutMode(false);
        } catch (e) {
          var msg = e.message || String(e);
          if (/not a working copy|E155007|working copy/i.test(msg)) {
            setCheckoutMode(true);
            setRepo(null);
            setEntries(null);
            setSummary(null);
          } else {
            setErr(msg);
          }
        } finally {
          if (!silent) setBusy(false);
        }
      }, [payload]);

      useEffect(function () {
        if (props.visible) {
          loadAll(true);
        }
      }, [props.visible, loadAll]);

      function showDiff(path) {
        setBusy(true);
        setErr(null);
        Promise.all([
          call("diff", payload({ path: path })),
          call("diff-sides", payload({ path: path })),
        ]).then(function (res) {
          setDiff({ path: path, text: res[0].diff, sides: res[1] });
          setView("diff");
        }).catch(function (e) {
          setErr(e.message || String(e));
        }).finally(function () { setBusy(false); });
      }

      function runAdd(paths) {
        setBusy(true);
        setErr(null);
        call("add", payload({ paths: paths })).then(function () {
          setNotice("已添加 " + paths.length + " 个文件");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runRevert(paths) {
        if (!window.confirm("确定要还原以下文件的所有本地修改？\n\n" + paths.join("\n"))) return;
        setBusy(true);
        setErr(null);
        call("revert", payload({ paths: paths })).then(function () {
          setNotice("已还原 " + paths.length + " 个文件");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runUpdate() {
        setBusy(true);
        setErr(null);
        call("update", payload()).then(function (v) {
          setNotice(v.revision ? "更新完成，当前版本 r" + v.revision : "更新完成");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function loadLog() {
        setBusy(true);
        setErr(null);
        call("log", payload({ limit: 30, verbose: true })).then(function (v) {
          setLogs(v.entries);
          setView("history");
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runCommit() {
        var selected = Object.keys(sel).filter(function (p) { return sel[p]; });
        var paths = commitAll || selected.length === 0 ? undefined : selected;
        setBusy(true);
        setErr(null);
        call("commit", payload({ paths: paths, message: msg })).then(function (v) {
          setNotice(v.revision ? "提交成功，新版本 r" + v.revision : "提交成功");
          setMsg("");
          setSel({});
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function generateMsg() {
        setAiBusy(true);
        setErr(null);
        call("generate-message", payload()).then(function (v) {
          if (v.message) {
            setMsg(v.message);
            setNotice("已用 " + (v.model || "当前模型") + " 生成提交日志，可修改后提交");
          } else {
            setNotice(v.note || "未生成提交日志");
          }
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setAiBusy(false); });
      }

      function runCleanup() {
        setBusy(true);
        setErr(null);
        call("cleanup", payload()).then(function () {
          setNotice("清理完成");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runDelete(paths) {
        if (!window.confirm("确定要从版本控制中删除以下文件？\n\n" + paths.join("\n"))) return;
        setBusy(true);
        setErr(null);
        call("delete", payload({ paths: paths })).then(function () {
          setNotice("已删除 " + paths.length + " 个文件（提交后生效）");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runResolve(path, accept) {
        setBusy(true);
        setErr(null);
        call("resolve", payload({ paths: [path], accept: accept })).then(function () {
          setNotice("冲突已解决：" + path.split(/[\\/]/).pop());
          setResolvePath(null);
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runIgnore(path) {
        var name = path.split(/[\\/]/).pop();
        if (!name) return;
        setBusy(true);
        setErr(null);
        call("propget", payload({ name: "svn:ignore", path: "." })).then(function (v) {
          var cur = v.value || "";
          var lines = cur.split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
          if (lines.indexOf(name) === -1) lines.push(name);
          return call("propset", payload({ name: "svn:ignore", value: lines.join("\n"), path: "." }));
        }).then(function () {
          setNotice("已加入忽略列表：" + name);
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function chooseDiff(block, mode) {
        var modeLabel = {
          left: "采用左侧（版本库）行内容",
          right: "采用右侧（工作副本）行内容",
          "both-left-first": "两者都保留（左侧在前）",
          "both-right-first": "两者都保留（右侧在前）",
        }[mode] || mode;
        var hint = mode === "left"
          ? "右侧对应行的工作副本修改会被丢弃。"
          : mode === "right"
            ? "右侧保持当前内容（无变化）。"
            : "差异块位置将保留两侧文本。";
        if (!window.confirm("对差异块执行「" + modeLabel + "」？\n" + hint)) return;
        var start = block.start;
        var end = block.end;
        setBusy(true);
        setErr(null);
        call("diff-choose", payload({ path: diff.path, block: { start: start, end: end }, mode: mode })).then(function () {
          setNotice("已应用：" + modeLabel);
          return showDiff(diff.path);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function showBlame(path) {
        setBusy(true);
        setErr(null);
        call("blame", payload({ path: path })).then(function (v) {
          setBlame({ path: path, entries: v.entries });
          setView("blame");
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runCheckout(url) {
        setBusy(true);
        setErr(null);
        call("checkout", payload({ url: url, path: "." })).then(function (v) {
          setNotice(v.revision ? "检出完成，版本 r" + v.revision : "检出完成");
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function loadBranches() {
        if (branchList !== null) { setBranchModal(true); return; }
        setBranchList([]);
        var root = repo && repo.repositoryRoot;
        if (!root) { setBranchModal(true); return; }
        call("list", payload({ target: root + "/branches" })).then(function (v) {
          var names = (v.entries || []).filter(function (e) { return e.kind === "dir"; }).map(function (e) { return e.name; });
          setBranchList(names.map(function (n) { return root + "/branches/" + n; }));
        }).catch(function () {
          setBranchList([]);
        }).finally(function () { setBranchModal(true); });
      }

      function runSwitch(url) {
        setBusy(true);
        setErr(null);
        call("switch", payload({ url: url })).then(function (v) {
          setNotice(v.revision ? "已切换到 " + url + "（r" + v.revision + "）" : "已切换");
          setBranchModal(false);
          setBranchList(null);
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function switchView(v) {
        if (v === "history" && logs === null) { loadLog(); return; }
        setView(v);
      }

      var body;
      if (checkoutMode) {
        body = h(CheckoutView, { busy: busy, onCheckout: runCheckout });
      } else if (view === "blame" && blame) {
        body = h(BlameView, { path: blame.path, entries: blame.entries,
          onBack: function () { setBlame(null); setView("changes"); } });
      } else if (view === "diff" && diff) {
        body = h(DiffView, { path: diff.path, diff: diff.text, sides: diff.sides,
          revision: repo ? repo.revision : undefined,
          onBack: function () { setDiff(null); setView("changes"); },
          onBlame: function () { showBlame(diff.path); },
          onChoose: chooseDiff });
      } else if (view === "history") {
        body = h(HistoryView, { entries: logs || [], openRev: openRev, onToggleRev: function (r) { setOpenRev(openRev === r ? null : r); } });
      } else if (view === "commit") {
        body = h(CommitView, { entries: entries || [], sel: sel, msg: msg, busy: busy, commitAll: commitAll,
          aiBusy: aiBusy, onAiGenerate: generateMsg,
          onMsg: setMsg, onToggle: function (p, v) { setSel(Object.assign({}, sel, { [p]: v })); },
          onCommitAll: setCommitAll, onCommit: runCommit });
      } else {
        body = h(ChangesView, { entries: entries || [], summary: summary, sel: sel,
          onDiff: showDiff, onToggle: function (p, v) { setSel(Object.assign({}, sel, { [p]: v })); },
          onAdd: runAdd, onRevert: runRevert, onDelete: runDelete, onBlame: showBlame,
          onResolve: setResolvePath, onIgnore: runIgnore });
      }

      var statusEl;
      if (busy) statusEl = h("span", {}, h("span", { className: "dsh-svn-spin" }), " 正在执行 SVN 操作…");
      else if (err) statusEl = h("span", {}, "⚠ " + err);
      else if (notice) statusEl = h("span", {}, "✓ " + notice);

      return h("div", { className: "dsh-svn" },
        h("div", { className: "dsh-svn-header" },
          svnIcon(16),
          h("span", { className: "dsh-svn-repo", title: repo ? (repo.url || "") : "" },
            repo ? (repo.url || repo.cwd || "SVN 工作副本") : "加载中…"),
          repo && repo.revision ? h("span", { className: "dsh-svn-rev" }, "r" + repo.revision) : null,
          h("button", { className: "dsh-svn-actbtn", disabled: busy, onClick: function () { loadAll(false); } }, "刷新")
        ),
        h("div", { className: "dsh-svn-toolbar" },
          h("div", { className: "dsh-svn-seg" },
            h("button", { className: "dsh-svn-tabbtn" + (view === "changes" || view === "diff" || view === "blame" ? " on" : ""), onClick: function () { setView("changes"); } }, "变更"),
            h("button", { className: "dsh-svn-tabbtn" + (view === "history" ? " on" : ""), onClick: function () { switchView("history"); } }, "历史"),
            h("button", { className: "dsh-svn-tabbtn" + (view === "commit" ? " on" : ""), onClick: function () { setView("commit"); } }, "提交")
          ),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode, onClick: loadBranches }, "分支"),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode, onClick: runCleanup }, "清理"),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode, onClick: runUpdate }, "更新")
        ),
        h("div", { className: "dsh-svn-body" }, body),
        h("div", { className: "dsh-svn-statusbar" + (err ? " err" : notice ? " ok" : ""), style: {} }, statusEl || ""),
        resolvePath
          ? h(ResolveModal, { path: resolvePath, onPick: function (a) { runResolve(resolvePath, a); }, onCancel: function () { setResolvePath(null); } })
          : null,
        branchModal
          ? h(BranchModal, { branches: branchList || [], currentUrl: repo ? (repo.url || "") : "", busy: busy,
              onSwitch: runSwitch, onCancel: function () { setBranchModal(false); } })
          : null
      );
    }

    // ------------------------------------------------------------- entry
    var inject = ["slots", "sessions", "modules", "betterSidebar"];

    function apply(ctx) {
      ctx.effect(function () {
        ensureStyle();
        var dispose = ctx.betterSidebar.registerTab({
          id: "svn",
          title: function () { return "SVN"; },
          icon: function (size) { return svnIcon(size); },
          order: 150,
          single: true,
          component: function (p) { return h(SvnPanel, p); },
        });
        return function () {
          try { dispose(); } catch (e) { /* already disposed */ }
          removeStyle();
        };
      }, "dsh-svn-tools: svn sidebar tab");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
