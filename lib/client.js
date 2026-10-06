/**
 * dsh-svn-tools client half: registers the 'svn' sidebar tab into
 * dsh-better-sidebar (ctx.betterSidebar.registerTab; 'betterSidebar' stays
 * declared in inject so the loader waits for the provider, and an undefined
 * guard turns a missing dsh-better-sidebar into a clear console error
 * instead of a crash) and renders a small
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
      ".dsh-svn-commitbar{display:flex;align-items:center;gap:8px;padding:2px 12px 6px;font-size:11px;color:#8b949e;flex-shrink:0;flex-wrap:wrap}",
      ".dsh-svn-commitbar .dsh-svn-summary-txt{min-width:0}",
      ".dsh-svn-commitbar .sp{flex:1}",
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
      ".dsh-svn-hist{display:flex;flex-direction:column;height:100%;min-height:0}",
      ".dsh-svn-histlist{flex:0 0 auto;min-height:0;overflow:auto}",
      ".dsh-svn-histmore{display:flex;justify-content:center;padding:10px 12px 14px}",
      ".dsh-svn-histmore .dsh-svn-actbtn{padding:5px 18px}",
      ".dsh-svn-histmore.done{color:#8b949e;font-size:11px}",
      ".dsh-svn-logrow.on{background:rgba(88,166,255,.12)}",
      ".dsh-svn-logrow.cur{border-left:2px solid #7ee787}",
      ".dsh-svn-logrow.cur .dsh-svn-curtag{display:inline-block}",
      ".dsh-svn-logrow.new{border-left:2px dotted rgba(240,180,41,.7)}",
      ".dsh-svn-logrow.new .dsh-svn-newtag{display:inline-block}",
      ".dsh-svn-curtag{display:none;flex-shrink:0;font-size:10px;color:#7ee787;background:rgba(46,160,67,.18);border-radius:4px;padding:0 5px}",
      ".dsh-svn-newtag{display:none;flex-shrink:0;font-size:10px;color:#f0b429;background:rgba(240,180,41,.15);border-radius:4px;padding:0 5px}",
      ".dsh-svn-hisver{padding:6px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(148,163,184,.15);background:rgba(148,163,184,.05);font-size:11px;flex-wrap:wrap}",
      ".dsh-svn-hisver .lbl{color:#8b949e}",
      ".dsh-svn-hisver .cur{color:#7ee787;font-weight:700}",
      ".dsh-svn-hisver .head{color:#58a6ff;font-weight:700}",
      ".dsh-svn-hisver .new{color:#ffa198;font-weight:700}",
      ".dsh-svn-hisver .sp{flex:1}",
      ".dsh-svn-logrow .dsh-svn-switchrev{display:none;flex-shrink:0;font-size:10px;border:1px solid rgba(148,163,184,.3);background:transparent;color:#8b949e;padding:1px 7px;border-radius:4px;cursor:pointer}",
      ".dsh-svn-logrow:hover .dsh-svn-switchrev{display:inline-block}",
      ".dsh-svn-logrow .dsh-svn-switchrev:hover{color:#58a6ff;border-color:rgba(88,166,255,.5)}",
      ".dsh-svn-histdivider{flex:0 0 auto;height:8px;cursor:row-resize;touch-action:none;display:flex;align-items:center;justify-content:center;background:rgba(148,163,184,.05);border-top:1px solid rgba(148,163,184,.22);border-bottom:1px solid rgba(148,163,184,.22)}",
      ".dsh-svn-histdivider::after{content:\"\";width:36px;height:3px;border-radius:2px;background:rgba(148,163,184,.5)}",
      ".dsh-svn-histdivider:hover,.dsh-svn-histdivider:active{background:rgba(88,166,255,.16)}",
      ".dsh-svn-histdivider:hover::after,.dsh-svn-histdivider:active::after{background:#58a6ff}",
      ".dsh-svn-histdetail{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:rgba(148,163,184,.07)}",
      ".dsh-svn-histdhead{display:flex;gap:8px;align-items:baseline;padding:6px 12px 2px;font-size:11px;background:rgba(148,163,184,.18);border-bottom:1px solid rgba(148,163,184,.25);flex-shrink:0}",
      ".dsh-svn-histdmsg{padding:2px 12px 6px;font-size:12px;color:#c9d1d9;white-space:pre;flex:0 0 auto;min-height:0;overflow:auto;scrollbar-width:thin}",
      ".dsh-svn-histdfiles{flex:1;min-height:0;overflow:auto;padding:2px 0 6px;scrollbar-width:thin}",
      ".dsh-svn-histfile{display:flex;align-items:center;gap:8px;padding:3px 12px;cursor:pointer;width:max-content;min-width:100%}",
      ".dsh-svn-histfile:hover{background:rgba(148,163,184,.08)}",
      ".dsh-svn-histfile.disabled{cursor:default;opacity:.55}",
      ".dsh-svn-histfile:hover.disabled{background:transparent}",
      ".dsh-svn-histfile .dsh-svn-histfile-ops{display:none;flex-shrink:0;gap:4px;margin-left:8px}",
      ".dsh-svn-histfile:hover .dsh-svn-histfile-ops{display:flex}",
      ".dsh-svn-hisbar{display:flex;align-items:center;gap:6px;padding:4px 12px;border-top:1px solid rgba(148,163,184,.14);border-bottom:1px solid rgba(148,163,184,.08);background:rgba(148,163,184,.05);flex-shrink:0;flex-wrap:wrap}",
      ".dsh-svn-hisbar .sp{flex:1}",
      ".dsh-svn-hisbar-group{display:flex;gap:4px}",
      ".dsh-svn-hisbar-actions{display:flex;gap:4px}",
      ".dsh-svn-hisbar .dsh-svn-mini.on{color:#e6edf3;background:rgba(88,166,255,.15);border-color:rgba(88,166,255,.3)}",
      ".dsh-svn-histfile .dsh-svn-check{flex-shrink:0;accent-color:#58a6ff}",
      ".dsh-svn-histfile.checked{background:rgba(88,166,255,.10)}",
      ".dsh-svn-histfile.running{background:rgba(88,166,255,.18);outline:1px solid rgba(88,166,255,.55)}",
      ".dsh-svn-runspin{margin:0 6px 0 0;flex-shrink:0}",
      ".dsh-svn-histfpath{flex:none;white-space:nowrap;font-size:11px;color:#c9d1d9}",
      ".dsh-svn-commitpage{display:flex;flex-direction:column;height:100%;min-height:0}",
      ".dsh-svn-commitpage-list{flex:0 0 auto;min-height:0;overflow:auto}",
      ".dsh-svn-commitpage-form{flex:1;min-height:0;overflow:auto}",
      ".dsh-svn-commit{padding:8px 12px;display:flex;flex-direction:column;gap:8px}",
      ".dsh-svn-lbl{font-size:11px;color:#8b949e}",
      ".dsh-svn-ta{width:100%;min-height:88px;resize:vertical;background:#0d1117;color:#e6edf3;border:1px solid rgba(148,163,184,.25);border-radius:6px;padding:6px 8px;font:12px/1.5 system-ui,sans-serif}",
      ".dsh-svn-ta:focus{outline:none;border-color:#58a6ff}",
      ".dsh-svn-statusbar{padding:4px 10px;border-top:1px solid rgba(148,163,184,.12);font-size:11px;color:#8b949e;min-height:24px;display:flex;align-items:center;gap:6px}",
      ".dsh-svn-statusbar.err{color:#ffa198}",
      ".dsh-svn-updprog{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;font-size:11px;color:#8b949e}",
      ".dsh-svn-updbar{width:130px;height:6px;border-radius:3px;background:rgba(148,163,184,.22);overflow:hidden;flex-shrink:0}",
      ".dsh-svn-updbar i{display:block;height:100%;width:38%;background:#58a6ff;border-radius:3px;animation:dsh-svn-upd 1.1s linear infinite}",
      "@keyframes dsh-svn-upd{0%{margin-left:-38%}100%{margin-left:100%}}",
      ".dsh-svn-updtext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-svn-statusbar.ok{color:#7ee787}",
      // 在线/离线/只读 mode chip + the offline/read-only banner. Offline is a
      // transient state with an explicit 「离线 / 重试」 choice and no
      // 「设为默认值 / 永远离线」 affordance — retrying always attempts the
      // server again.
      ".dsh-svn-mode{flex-shrink:0;font-size:10px;line-height:1.6;padding:0 6px;border-radius:4px;border:1px solid transparent}",
      ".dsh-svn-mode.online{color:#7ee787;background:rgba(46,160,67,.16);border-color:rgba(46,160,67,.4)}",
      ".dsh-svn-mode.offline{color:#f0b429;background:rgba(240,180,41,.16);border-color:rgba(240,180,41,.45)}",
      ".dsh-svn-mode.readonly{color:#79c0ff;background:rgba(88,166,255,.16);border-color:rgba(88,166,255,.45)}",
      ".dsh-svn-banner{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;font-size:11px;line-height:1.55;border-bottom:1px solid rgba(148,163,184,.14);flex-shrink:0}",
      ".dsh-svn-banner.offline{color:#f0b429;background:rgba(240,180,41,.10)}",
      ".dsh-svn-banner.readonly{color:#79c0ff;background:rgba(88,166,255,.10)}",
      ".dsh-svn-banner-txt{flex:1;min-width:0;word-break:break-all}",
      ".dsh-svn-banner .dsh-svn-actbtn{flex-shrink:0}",
      "@media (max-width:520px){.dsh-svn-banner{flex-wrap:wrap}}",
      ".dsh-svn-spin{width:10px;height:10px;border:2px solid rgba(148,163,184,.25);border-top-color:#58a6ff;border-radius:50%;animation:dsh-svn-spin .8s linear infinite;flex-shrink:0}",
      "@keyframes dsh-svn-spin{to{transform:rotate(360deg)}}",
      ".dsh-svn-badge.M{background:#e5c07b}.dsh-svn-badge.A{background:#7ee787}.dsh-svn-badge.D{background:#ffa198}.dsh-svn-badge.R{background:#d2a8ff}",
      ".dsh-svn-badge.C{background:#ff7b72}.dsh-svn-badge.\\!{background:#f0883e}.dsh-svn-badge.\\?{background:#8b949e}.dsh-svn-badge.\\~{background:#f0883e}",
      ".dsh-svn-lockrow{display:flex;align-items:center;gap:8px;padding:3px 10px;min-width:0}",
      ".dsh-svn-lockrow:hover{background:rgba(148,163,184,.08)}",
      ".dsh-svn-lockicon{flex-shrink:0;font-size:11px}",
      ".dsh-svn-lockowner{flex-shrink:0;font-size:11px;color:#d2a8ff;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-svn-lockowner.mine{color:#7ee787}",
      ".dsh-svn-locktime{flex-shrink:0;font-size:10px;color:#6e7681}",
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
      ".dsh-svn-sidessticky{position:sticky;top:0;z-index:9;background:#0d1117;flex-shrink:0}",
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
      ".dsh-svn-block.cur{outline:1.5px solid rgba(88,166,255,.85);outline-offset:0;border-radius:3px;background:rgba(88,166,255,.12)}",
      ".dsh-svn-blockbar{position:absolute;top:-10px;right:6px;z-index:6;display:none;gap:4px;background:#1c2128;border:1px solid rgba(148,163,184,.35);border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(1,4,9,.5)}",
      ".dsh-svn-block.change:hover .dsh-svn-blockbar{display:flex}",
      ".dsh-svn-navrow{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid rgba(148,163,184,.12);font-size:11px;color:#8b949e;flex-shrink:0}",
      ".dsh-svn-navbtn{border:1px solid rgba(148,163,184,.3);background:rgba(148,163,184,.08);color:#c9d1d9;font-size:10px;padding:2px 8px;border-radius:5px;cursor:pointer;white-space:nowrap}",
      ".dsh-svn-navbtn:hover{background:rgba(148,163,184,.18)}",
      ".dsh-svn-navbtn:disabled{opacity:.45;cursor:default}",
      ".dsh-svn-navcount{flex:1;min-width:0;text-align:right;color:#8b949e;font-variant-numeric:tabular-nums}",
      ".dsh-svn-lineno{flex-shrink:0;width:44px;text-align:right;padding:0 8px;color:#6e7681;user-select:none}",
      ".dsh-svn-cell.del .dsh-svn-lineno{color:#ffa198}",
      ".dsh-svn-cell.add .dsh-svn-lineno{color:#7ee787}",
      ".dsh-svn-linetext{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding:0 12px 0 6px;color:#c9d1d9}",
      ".dsh-svn-row.sel,.dsh-svn-histfile.sel{background:rgba(88,166,255,.16)}",
      ".dsh-svn-row.sel:hover,.dsh-svn-histfile.sel:hover{background:rgba(88,166,255,.22)}",
      ".dsh-svn-rows,.dsh-svn-histdfiles{user-select:none;-webkit-user-select:none}",
      ".dsh-svn-cmdraw{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}",
      ".dsh-svn-changes{display:flex;flex-direction:column;min-height:100%}",
      ".dsh-svn-changes .dsh-svn-rows{flex:1;min-height:0}",
      ".dsh-svn-histfile .dsh-svn-histfile-ops{margin-left:auto}",
      // ---- settings card (Settings → Plugins → Plugin configuration) ----
      ".dsh-svn-set{display:flex;flex-direction:column;gap:8px;font:13px/1.5 system-ui,sans-serif;color:inherit;min-width:0}",
      ".dsh-svn-set-head{display:flex;flex-direction:column;gap:2px}",
      ".dsh-svn-set-title{font-size:13px;font-weight:600}",
      ".dsh-svn-set-sub{font-size:12px;opacity:.65}",
      ".dsh-svn-set-note{font-size:12px;opacity:.75}",
      ".dsh-svn-set-note.err{color:#ffa198}",
      ".dsh-svn-set-note.ok{color:#7ee787}",
      ".dsh-svn-set-grid{display:flex;flex-direction:column}",
      ".dsh-svn-set-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid rgba(148,163,184,.15);min-width:0;flex-wrap:wrap}",
      ".dsh-svn-set-row:first-child{border-top:0}",
      ".dsh-svn-set-label{flex:0 0 168px;min-width:0;font-size:12px;display:flex;align-items:center;gap:6px}",
      ".dsh-svn-set-ctl{flex:1 1 260px;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dsh-svn-set-hint{flex-basis:100%;font-size:11px;opacity:.6}",
      ".dsh-svn-set input[type=text],.dsh-svn-set input[type=number],.dsh-svn-set select{background:rgba(148,163,184,.10);border:1px solid rgba(148,163,184,.3);border-radius:6px;color:inherit;font:inherit;padding:3px 6px;min-width:0}",
      ".dsh-svn-set input[type=text]{flex:1 1 140px}",
      ".dsh-svn-set input[type=number]{width:104px}",
      ".dsh-svn-set select{cursor:pointer}",
      ".dsh-svn-set input[type=checkbox]{accent-color:#58a6ff;flex-shrink:0}",
      ".dsh-svn-set input:disabled,.dsh-svn-set select:disabled{opacity:.5}",
      ".dsh-svn-set-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;min-width:0}",
      ".dsh-svn-set-badge{flex-shrink:0;font-size:10px;border-radius:4px;padding:0 5px;background:rgba(88,166,255,.18);color:#58a6ff}",
      ".dsh-svn-set-btn{flex-shrink:0;font-size:11px;border:1px solid rgba(148,163,184,.3);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer}",
      ".dsh-svn-set-btn:hover{background:rgba(148,163,184,.15)}",
      ".dsh-svn-set-btn:disabled{opacity:.5;cursor:default}",
      ".dsh-svn-set-btn.on{color:#58a6ff;border-color:rgba(88,166,255,.5)}",
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
    /** Raw /svn/api/* round-trip. Mode policy (online/offline/read-only) is
     * applied by the panel's `call` wrapper on top of this. */
    async function callRaw(method, payload) {
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

    /** The working-copy's repo-relative subtree prefix, e.g. "/XCC-Deluxe"
     * for url svn://host/smtc/HoloX/XCC-Deluxe with root svn://host/smtc/HoloX. */
    function wcSuffixOf(repo) {
      if (!repo || !repo.url || !repo.repositoryRoot) return "";
      var strip = function (u) {
        var s = String(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
        var slash = s.indexOf("/");
        return slash === -1 ? "" : s.slice(slash);
      };
      var root = strip(repo.repositoryRoot);
      var wc = strip(repo.url);
      return root !== "" && wc.indexOf(root) === 0 ? wc.slice(root.length) : "";
    }

    // ---------------------------------------------- offline / read-only mode
    // The SVN server can go away while the working copy keeps working. The
    // panel then offers an explicit, always-escapable choice — 「离线」(read
    // the history cache + local revision snapshot) and 「重试」(go back
    // online) — and deliberately has NO 「设为默认值 / 永远离线」 option: an
    // offline session lives only in this page's memory and every 重试 tries
    // the server again. Read-only mode is a separate, user-chosen switch that
    // disables writes while staying online.
    var MODE_KEY = "dsh-svn-tools.mode";
    function readStoredMode() {
      try {
        var v = window.localStorage.getItem(MODE_KEY);
        return v === "offline" || v === "read-only" ? v : "online";
      } catch (e) { return "online"; }
    }
    function writeStoredMode(mode) {
      try {
        if (mode === "online") window.localStorage.removeItem(MODE_KEY);
        else window.localStorage.setItem(MODE_KEY, mode);
      } catch (e) { /* private mode / storage disabled */ }
    }

    /** Transport-level failure (server unreachable) as opposed to a
     * legitimate svn error the user must see (conflict, not a working copy…). */
    var TRANSPORT_RE = /E170013|E210005|E175002|E0000\d\d|Unable to connect to a repository|No repository found|Connection (?:refused|timed out|reset)|could not connect to server|无法连接|不能连接到服务器|连接被拒绝|连接超时/i;
    function isTransportError(message) {
      return TRANSPORT_RE.test(String(message || ""));
    }

    // /svn/api/* methods answerable from the working copy alone (no server
    // round-trip), the ones that write to it, and the ones the offline branch
    // can still serve from the local history cache / wc.db snapshot. The mode
    // policy built on these lives in blockMethod() so it can be asserted
    // without a browser (scripts/verify-offline-modes.mjs).
    var LOCAL_OK = {
      root: 1, status: 1, diff: 1, "diff-sides": 1, blame: 1, cat: 1,
      propget: 1, proplist: 1, changelist: 1,
    };
    var WRITE_METHODS = {
      add: 1, revert: 1, delete: 1, mkdir: 1, cleanup: 1, resolve: 1,
      commit: 1, "generate-message": 1, "diff-choose": 1, import: 1,
      patch: 1, upgrade: 1, "history-revert": 1, "update-start": 1,
      update: 1, switch: 1, checkout: 1, relocate: 1, copy: 1, move: 1,
      merge: 1, lock: 1, unlock: 1,
    };
    var WRITE_LABEL = { commit: "提交", "generate-message": "生成提交日志", "update-start": "更新", update: "更新" };
    var OFFLINE_SERVED = { log: 1, locks: 1, "head-info": 1, "history-prev-revs": 1, connection: 1, "history-revert": 1 };
    var WRITE_HINT = "离线模式：写操作已禁用（提交/更新需要连接服务器），请先点上方「重试」恢复在线";
    var READONLY_HINT = "只读模式：写操作已禁用，切回「在线」后可编辑";

    /** Why `method` may not run in the given mode — undefined when it may.
     * Order: a disabled write wins (read-only), then the offline rules. */
    function blockMethod(mode, method) {
      var offline = mode === "offline";
      var readOnly = mode === "read-only";
      if (readOnly && WRITE_METHODS[method]) {
        return "只读模式已开启：" + (WRITE_LABEL[method] || "写操作") + "已禁用。切回「在线」模式后可用。";
      }
      if (offline && !LOCAL_OK[method] && !OFFLINE_SERVED[method]) {
        return "离线模式：该操作需要连接服务器，请先点「重试」恢复在线。";
      }
      return undefined;
    }

    // Test seam: the bundle has no build step and no test runner, so the pure
    // mode-policy helpers are exposed here for scripts/verify-offline-modes.mjs
    // (a no-op for the app itself).
    if (typeof window === "object" && window !== null) {
      window.__dshSvnToolsTest = {
        blockMethod: blockMethod,
        isTransportError: isTransportError,
        WRITE_HINT: WRITE_HINT,
        READONLY_HINT: READONLY_HINT,
        // Settings/carrier seams (values that live further down the factory are
        // attached at its end): the pure carrier resolver and the store factory,
        // so a test can drive them with a fake settings scope.
        resolveCarrier: resolveCarrier,
        createSettingsStore: createSettingsStore,
      };
    }

    // --------------------------------------------------------- components
    function SidesView(props) {
      var s = props.sides;
      var [curIdx, setCurIdx] = useState(-1);
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
      var changeBlocks = blocks.filter(function (b) { return b.change; });
      // clamp the current-difference index against the actual change list
      var curNo = curIdx >= 0 && curIdx < changeBlocks.length ? curIdx : -1;
      var changeRefs = {};
      var sidesEl = null;
      var choose = function (block, mode) {
        if (props.onChoose) props.onChoose(block, mode);
      };
      /**
       * Pin the text viewport's height to the REAL visible area, measured
       * from the ancestors that actually clip (overflow ≠ visible) — the
       * host's flex/height chain cannot be trusted: when it fails to bound
       * us, content overflows into an upper container and NO element in the
       * chain scrolls. Capping .dsh-svn-sides with an explicit maxHeight
       * makes it the scroll container in every layout, so navigation always
       * scrolls the text itself.
       */
      var fitSides = function () {
        var sides = sidesEl;
        if (!sides || !document.body) return;
        var top = sides.getBoundingClientRect().top;
        var limit = window.innerHeight;
        var n = sides.parentElement;
        while (n && n !== document.body) {
          var oy = "visible";
          try { oy = getComputedStyle(n).overflowY; } catch (e) { /* keep visible */ }
          if (oy !== "visible") {
            var r = n.getBoundingClientRect();
            if (r.bottom < limit) limit = r.bottom;
          }
          n = n.parentElement;
        }
        var h = Math.floor(limit - top);
        if (h < 40) h = 40;
        if (sides.scrollHeight > h) sides.style.maxHeight = h + "px";
        else if (sides.style.maxHeight) sides.style.maxHeight = "";
      };
      useEffect(function () {
        fitSides();
        window.addEventListener("resize", fitSides);
        return function () { window.removeEventListener("resize", fitSides); };
      });
      /**
       * Bring a diff block into view by scrolling ONLY the containers that
       * really overflow — walking inner→outer and scrolling each one the
       * minimum needed. Never scrollIntoView (it drags every ancestor along).
       * The nav row is position:sticky, so whichever container scrolls, it
       * stays pinned at the top of the visible area.
       */
      var reveal = function (el) {
        if (!el) return;
        fitSides();
        var nodes = [];
        var n = el.parentElement;
        while (n && n !== document.body) {
          if (typeof n.scrollTop === "number" && n.scrollHeight > n.clientHeight + 1) nodes.push(n);
          n = n.parentElement;
        }
        var smooth = nodes.length === 1;
        for (var i = 0; i < nodes.length; i++) {
          var sc = nodes[i];
          var cRect = sc.getBoundingClientRect();
          var eRect = el.getBoundingClientRect();
          if (eRect.top >= cRect.top && eRect.bottom <= cRect.bottom) break; // visible at this level
          var delta;
          if (i === 0 && eRect.height <= cRect.height) {
            // innermost text viewport + block fits: center it
            delta = (eRect.top - cRect.top) - (cRect.height - eRect.height) / 2;
          } else if (eRect.top < cRect.top) {
            delta = eRect.top - cRect.top; // reveal the top edge
          } else {
            delta = eRect.bottom - cRect.bottom; // reveal the bottom edge
          }
          var target = Math.max(0, Math.min(sc.scrollTop + delta, sc.scrollHeight - sc.clientHeight));
          if (smooth) { try { sc.scrollTo({ top: target, behavior: "smooth" }); } catch (e2) { sc.scrollTop = target; } }
          else sc.scrollTop = target;
        }
        // self-check: if the block still isn't fully visible, report geometry
        // for debugging instead of failing silently.
        var eAfter = el.getBoundingClientRect();
        var sc0 = nodes[0];
        var cAfter = sc0 ? sc0.getBoundingClientRect() : null;
        if (cAfter && (eAfter.top < cAfter.top - 1 || eAfter.bottom > cAfter.bottom + 1)) {
          try {
            console.warn("[dsh-svn-tools] reveal incomplete", {
              scrollables: nodes.map(function (x) {
                return { cls: (x.className || "").toString().slice(0, 60), scrollTop: x.scrollTop, sh: x.scrollHeight, ch: x.clientHeight, rect: x.getBoundingClientRect().toJSON() };
              }),
              block: eAfter.toJSON(),
            });
          } catch (e3) { /* diagnostic must never break navigation */ }
        }
      };
      var nav = function (delta) {
        if (changeBlocks.length === 0) return;
        var next = curNo < 0
          ? (delta > 0 ? 0 : changeBlocks.length - 1)
          : (curNo + delta + changeBlocks.length) % changeBlocks.length;
        setCurIdx(next);
        reveal(changeRefs[next]);
      };
      var changeNo = -1;
      var blockEls = blocks.map(function (b) {
        var isChange = b.change;
        var ref = null;
        var cls = "dsh-svn-block" + (isChange ? " change" : "");
        if (isChange) {
          changeNo++;
          // capture the per-block index: ref callbacks run AFTER this render,
          // so they must not close over the shared `changeNo` (all refs would
          // then point at the LAST change block and changeRefs[i] stays
          // undefined for i < last — navigation scrolled nowhere).
          var idx = changeNo;
          if (idx === curNo) cls += " cur";
          ref = function (el) { changeRefs[idx] = el; };
        }
        var bar = isChange && props.onChoose
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
        return h("div", { className: cls, key: b.start, ref: ref }, bar, lines);
      });
      var navRow = changeBlocks.length > 0
        ? h("div", { className: "dsh-svn-navrow" },
            h("button", { className: "dsh-svn-navbtn", title: "上一处差异", onClick: function () { nav(-1); } }, "◀ 上一处"),
            h("button", { className: "dsh-svn-navbtn", title: "下一处差异", onClick: function () { nav(1); } }, "下一处 ▶"),
            h("span", { className: "dsh-svn-navcount" },
              curNo < 0 ? "-" : String(curNo + 1) + " / " + changeBlocks.length))
        : null;
      return h("div", { className: "dsh-svn-sideswrap" },
        h("div", { className: "dsh-svn-sidessticky" },
          h("div", { className: "dsh-svn-sideshead" },
            h("div", { className: "dsh-svn-sidehead", title: s.leftLabel ? "版本库（选中版本）" : "版本库中的内容（左侧）" },
              "◀ " + (s.leftLabel || "版本库" + (s.revision ? " r" + s.revision : "")),
              s.leftMissing && !s.unavailable ? "（新增文件）" : ""),
            h("div", { className: "dsh-svn-sidehead r", title: s.rightLabel ? "上一个版本" : "工作副本中的内容（右侧）" },
              (s.rightLabel || "工作副本") + " ▶", s.rightMissing && !s.unavailable ? "（已删除）" : "")
          ),
          navRow
        ),
        h("div", { className: "dsh-svn-sides", ref: function (el) { sidesEl = el; } }, blockEls)
      );
    }

    function DiffView(props) {
      var sides = props.sides;
      var [mode, setMode] = useState(sides && !sides.binary ? "sides" : "text");
      // A side that could not be read because the repository is unreachable
      // (`unavailable`) makes "无差异 / 0 处差异" a lie, so say so instead. A
      // side that is legitimately absent (new/deleted file) still renders.
      var incomplete = !!(sides && sides.unavailable === true);
      var body;
      if (mode === "sides" && sides && !sides.binary && !incomplete) {
        body = h(SidesView, { key: props.path, sides: sides, onChoose: props.onChoose });
      } else if (incomplete) {
        body = h("pre", { className: "dsh-svn-diff" },
          "对比不完整：该版本在本地不可用（服务器不可达），无法生成差异。" + (props.offlineNote ? "\n\n" + props.offlineNote : ""));
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
          props.onBlame ? h("button", { className: "dsh-svn-mini", onClick: props.onBlame }, "追溯") : null,
          h("span", { className: "dsh-svn-rev" }, props.revision ? "r" + props.revision : "")
        ),
        props.offlineNote
          ? h("div", { className: "dsh-svn-banner offline" },
              h("span", { className: "dsh-svn-banner-txt" }, "⚠ " + props.offlineNote))
          : null,
        body
      );
    }

    function BlameView(props) {
      var entries = props.entries || [];
      if (entries.length === 0) return h("div", { className: "dsh-svn-empty" }, "无追溯信息");
      var rows = entries.map(function (e) {
        return h("div", { className: "dsh-svn-blameline", key: e.line },
          h("span", { className: "dsh-svn-blameinfo", title: (e.date || "") + " · " + (e.author || "?") },
            "r" + e.revision + " " + (e.author || "?")),
          h("span", { className: "dsh-svn-blamecode" }, e.text)
        );
      });
      return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        h("div", { className: "dsh-svn-difftitle" },
          h("button", { className: "dsh-svn-mini", onClick: props.onBack }, "← 返回"),
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.path),
          h("span", { className: "dsh-svn-rev" }, "追溯")
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
      // unified file-list interaction (same as the history file list):
      // single click = highlight only (checkbox untouched), double click =
      // open diff, blank-space left-drag = marquee multi-select (checkbox
      // untouched), then clicking one of the highlighted rows flips its
      // checkbox and syncs the whole group to that state.
      var rowsWrapRef = React.useRef(null);
      var dragStart = React.useRef(null);
      var dragEndAt = React.useRef(0);
      var pendingRef = React.useRef(false);
      var movedRef = React.useRef(false);
      var dblTimer = React.useRef(null);
      var [hl, setHl] = useState(null);
      // a fresh change list (after commit/refresh/…) invalidates highlights.
      useEffect(function () {
        if (dblTimer.current) { clearTimeout(dblTimer.current); dblTimer.current = null; }
        setHl(null);
      }, [props.rawEntries]);
      if (entries.length === 0) {
        var rawCount = props.rawCount || 0;
        if (rawCount > 0) {
          return h("div", { className: "dsh-svn-empty" },
            rawCount + " 个未版本化文件已隐藏（取消勾选下方「显示无版本控制的文件」即可查看）");
        }
        return h("div", { className: "dsh-svn-empty" }, "工作副本干净，没有变更 ✓");
      }
      // Left press anywhere on the row area may become a marquee once the
      // pointer moves >4px; a still press releases as a plain row click.
      var sweep = function (ev) {
        var wrap = rowsWrapRef.current;
        var s = dragStart.current;
        if (!wrap || !s) return;
        var rect = wrap.getBoundingClientRect();
        var L = Math.min(s.x, ev.clientX) - rect.left;
        var R = Math.max(s.x, ev.clientX) - rect.left;
        var T = Math.min(s.y, ev.clientY) - rect.top;
        var B = Math.max(s.y, ev.clientY) - rect.top;
        var hit = [];
        Array.prototype.forEach.call(wrap.children, function (child) {
          if (!child.classList || !child.classList.contains("dsh-svn-row")) return;
          var r = child.getBoundingClientRect();
          var cl = r.left - rect.left, cr = r.right - rect.left;
          var ct = r.top - rect.top, cb = r.bottom - rect.top;
          if (cl < R && cr > L && ct < B && cb > T) {
            var p = child.getAttribute ? child.getAttribute("data-path") : null;
            if (p) hit.push(p);
          }
        });
        setHl(hit.length > 0 ? hit : null);
      };
      var marqueeDown = function (ev) {
        if (ev.button !== 0) return;
        var t = ev.target;
        if (!t || !t.closest || t.closest("button") || t.closest("input")) return;
        pendingRef.current = true;
        movedRef.current = false;
        dragStart.current = { x: ev.clientX, y: ev.clientY };
        // NOTE: no setPointerCapture here — capturing on every press would
        // retarget the click/dblclick of a plain press to this container and
        // break row click (highlight) and double click (open diff). Capture
        // only starts once the press actually turns into a drag (see move).
      };
      var marqueeMove = function (ev) {
        if (!pendingRef.current) return;
        var s = dragStart.current;
        if (!s) return;
        if (!movedRef.current &&
          Math.abs(ev.clientX - s.x) <= 4 && Math.abs(ev.clientY - s.y) <= 4) return;
        if (!movedRef.current) {
          movedRef.current = true;
          setHl(null);
          try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        }
        sweep(ev);
      };
      var marqueeEnd = function () {
        var wasMove = movedRef.current;
        pendingRef.current = false;
        movedRef.current = false;
        dragStart.current = null;
        if (wasMove) dragEndAt.current = Date.now();
      };
      var wrapClick = function (ev) {
        if (Date.now() - dragEndAt.current < 350) return; // release of a marquee
        var t = ev.target;
        if (t && t.closest && t.closest(".dsh-svn-row")) return;
        setHl(null);
      };
      function rowClick(path) {
        if (Date.now() - dragEndAt.current < 350) return; // click after a marquee
        var list = hl;
        if (list && list.length >= 2 && list.indexOf(path) !== -1) {
          // operate the whole marquee group from the clicked row's state.
          // Deferred briefly so a double click (which opens the diff on the
          // second click) can cancel the group op and never toggle twice.
          if (dblTimer.current) { clearTimeout(dblTimer.current); dblTimer.current = null; return; }
          var listCopy = list.slice();
          var pathCopy = path;
          dblTimer.current = setTimeout(function () {
            dblTimer.current = null;
            var cur = !!(sel && sel[pathCopy]);
            if (props.onGroupCheck) props.onGroupCheck(listCopy, !cur);
          }, 240);
          return; // keep the highlight selection
        }
        setHl([path]); // plain click: select-highlight only
      }
      // write actions (add/ignore/delete/revert/resolve/commit) are disabled
      // while the panel is offline (they either need the server or produce a
      // local change the user cannot commit) or in read-only mode. Read-only
      // viewing — diff, blame, history — stays available.
      var writesOff = props.writesOff === true;
      var writeHint = props.writeHint || "";
      var rows = entries.map(function (e) {
        var meta = statusMeta(e.status);
        var isNew = e.status === "?";
        var isConflict = e.status === "C";
        var isHl = hl !== null && hl.indexOf(e.path) !== -1;
        return h("div", { className: "dsh-svn-row" + (isHl ? " sel" : ""), key: e.path, "data-path": e.path,
          title: "单击选中 / 悬停「比对」或双击查看 diff",
          onClick: function () { rowClick(e.path); },
          onDoubleClick: function () {
            if (dblTimer.current) { clearTimeout(dblTimer.current); dblTimer.current = null; }
            props.onDiff(e.path);
          } },
          h("input", { type: "checkbox", className: "dsh-svn-check", checked: !!sel[e.path],
            onClick: function (ev) { ev.stopPropagation(); },
            onChange: function (ev) {
              var list = hl;
              if (list && list.length >= 2 && list.indexOf(e.path) !== -1 && props.onGroupCheck) {
                // checkbox of a row inside the marquee group: sync the whole
                // group to this row's new state (check or uncheck).
                props.onGroupCheck(list, ev.target.checked);
              } else {
                props.onToggle(e.path, ev.target.checked);
              }
            } }),
          h("span", { className: "dsh-svn-badge " + e.status, title: meta.label, style: { background: meta.color } }, e.status),
          h("span", { className: "dsh-svn-path", title: e.path }, e.path),
          e.changelist ? h("span", { className: "dsh-svn-cltag" }, e.changelist) : null,
          h("span", { className: "dsh-svn-rowops", onClick: function (ev) { ev.stopPropagation(); } },
            h("button", { className: "dsh-svn-mini", style: { color: "#58a6ff", borderColor: "rgba(88,166,255,.45)" },
              title: "查看该文件差异（也可双击行进入）",
              onClick: function () { props.onDiff(e.path); } }, "比对"),
            isConflict
              ? h("button", { className: "dsh-svn-mini", disabled: writesOff,
                  title: writeHint || "解决冲突", style: { color: "#ff7b72", borderColor: "rgba(255,123,114,.5)" }, onClick: function () { props.onResolve(e.path); } }, "解决")
              : null,
            !isNew && !isConflict && e.status !== "!"
              ? h("button", { className: "dsh-svn-mini", onClick: function () { props.onBlame(e.path); } }, "追溯")
              : null,
            isNew
              ? h("button", { className: "dsh-svn-mini ok", disabled: writesOff,
                  title: writeHint || "把未版本化文件加入版本控制", onClick: function () { props.onAdd([e.path]); } }, "添加")
              : null,
            isNew
              ? h("button", { className: "dsh-svn-mini", disabled: writesOff,
                  title: writeHint || "把该文件名写入 svn:ignore", onClick: function () { props.onIgnore(e.path); } }, "忽略")
              : null,
            !isNew && !isConflict
              ? h("button", { className: "dsh-svn-mini danger", disabled: writesOff,
                  title: writeHint || "从版本控制中删除（提交后生效）", onClick: function () { props.onDelete([e.path]); } }, "删除")
              : null,
            !isNew && !isConflict
              ? h("button", { className: "dsh-svn-mini", disabled: writesOff,
                  title: writeHint || "还原本地修改（丢弃未提交改动）", onClick: function () { props.onRevert([e.path]); } }, "还原")
              : null
          )
        );
      });
      var summary = Object.keys(props.summary || {}).map(function (k) {
        return statusMeta(k).label + " " + props.summary[k];
      }).join(" · ");
      // batch bar: checked files eligible for delete/revert (same rule as
      // the row buttons: skip unversioned '?' and conflicted 'C').
      var batchable = [];
      (entries || []).forEach(function (e) {
        if (sel && sel[e.path] && e.status !== "?" && e.status !== "C") batchable.push(e.path);
      });
      return h("div", { className: "dsh-svn-changes" },
        h("div", { className: "dsh-svn-commitbar" },
          h("span", { className: "dsh-svn-summary-txt" }, summary),
          h("span", { className: "sp" }),
          sel && batchable.length > 0
            ? h("button", { className: "dsh-svn-mini danger", disabled: props.busy || writesOff,
                title: writeHint || ("对勾选的 " + batchable.length + " 个文件执行删除（未版本化/冲突文件不计入）"),
                onClick: function () { props.onBatchDelete(batchable); } }, "删除")
            : null,
          sel && batchable.length > 0
            ? h("button", { className: "dsh-svn-mini", disabled: props.busy || writesOff,
                title: writeHint || ("把勾选的 " + batchable.length + " 个文件还原（未版本化/冲突文件不计入）"),
                onClick: function () { props.onBatchRevert(batchable); } }, "回退")
            : null
        ),
        h("div", { className: "dsh-svn-rows", ref: rowsWrapRef,
          onPointerDown: marqueeDown, onPointerMove: marqueeMove,
          onPointerUp: marqueeEnd, onPointerCancel: marqueeEnd, onClick: wrapClick }, rows)
      );
    }

    function HistoryView(props) {
      var entries = props.entries || [];
      // top/bottom split: top pane height in percent of the container,
      // adjustable by dragging the divider between the panes.
      var [topPct, setTopPct] = useState(55);
      // inside the detail pane: log/message area height vs the path list,
      // adjustable by the inner divider between them.
      var [msgPct, setMsgPct] = useState(40);
      var wrapRef = React.useRef(null);
      var detailRef = React.useRef(null);
      var draggingRef = React.useRef(false);
      var msgDragRef = React.useRef(false);
      // unified file-row interaction: marquee highlight, click a highlighted
      // row to flip its checked state and sync the whole group, double click
      // opens the rN vs rN-1 diff. Checkboxes are always shown (multi-select
      // is the only mode of the history detail page).
      var filesWrapRef = React.useRef(null);
      var filesDragStart = React.useRef(null);
      var filesDragEndAt = React.useRef(0);
      var filesPendingRef = React.useRef(false);
      var filesMovedRef = React.useRef(false);
      var filesDblTimer = React.useRef(null);
      var [hlFiles, setHlFiles] = useState(null);
      useEffect(function () {
        if (filesDblTimer.current) { clearTimeout(filesDblTimer.current); filesDblTimer.current = null; }
        setHlFiles(null);
      }, [props.openRev]);
      if (entries.length === 0) return h("div", { className: "dsh-svn-empty" }, "暂无提交历史");
      var dividerDown = function (e) {
        e.preventDefault();
        draggingRef.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      var dividerMove = function (e) {
        if (!draggingRef.current) return;
        var wrap = wrapRef.current;
        if (!wrap) return;
        var rect = wrap.getBoundingClientRect();
        if (rect.height < 40) return;
        var pct = ((e.clientY - rect.top) / rect.height) * 100;
        setTopPct(Math.max(15, Math.min(85, pct)));
      };
      var dividerUp = function () { draggingRef.current = false; };
      // inner divider between the log message and the path list.
      var msgDividerDown = function (e) {
        e.preventDefault();
        msgDragRef.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      var msgDividerMove = function (e) {
        if (!msgDragRef.current) return;
        var d = detailRef.current;
        if (!d) return;
        var rect = d.getBoundingClientRect();
        if (rect.height < 40) return;
        var pct = ((e.clientY - rect.top) / rect.height) * 100;
        setMsgPct(Math.max(12, Math.min(70, pct)));
      };
      var msgDividerUp = function () { msgDragRef.current = false; };

      // marquee multi-select over the changed-path rows. A left press
      // anywhere on the row area may become a marquee once the pointer moves
      // >4px; a still press releases as a plain row click.
      var filesSweep = function (ev) {
        var wrap = filesWrapRef.current;
        var s = filesDragStart.current;
        if (!wrap || !s) return;
        var rect = wrap.getBoundingClientRect();
        var L = Math.min(s.x, ev.clientX) - rect.left;
        var R = Math.max(s.x, ev.clientX) - rect.left;
        var T = Math.min(s.y, ev.clientY) - rect.top;
        var B = Math.max(s.y, ev.clientY) - rect.top;
        var hit = [];
        Array.prototype.forEach.call(wrap.children, function (child) {
          if (!child.classList || !child.classList.contains("dsh-svn-histfile")) return;
          var r = child.getBoundingClientRect();
          var cl = r.left - rect.left, cr = r.right - rect.left;
          var ct = r.top - rect.top, cb = r.bottom - rect.top;
          if (cl < R && cr > L && ct < B && cb > T) {
            var p = child.getAttribute ? child.getAttribute("data-path") : null;
            if (p) hit.push(p);
          }
        });
        setHlFiles(hit.length > 0 ? hit : null);
      };
      var fileMarqueeDown = function (ev) {
        if (ev.button !== 0) return;
        var t = ev.target;
        if (!t || !t.closest || t.closest("button") || t.closest("input")) return;
        filesPendingRef.current = true;
        filesMovedRef.current = false;
        filesDragStart.current = { x: ev.clientX, y: ev.clientY };
        // NOTE: no setPointerCapture here — capturing on every press would
        // retarget the click/dblclick of a plain press to this container and
        // break row click / double click. Capture only starts once the press
        // actually turns into a drag (see move).
      };
      var fileMarqueeMove = function (ev) {
        if (!filesPendingRef.current) return;
        var s = filesDragStart.current;
        if (!s) return;
        if (!filesMovedRef.current &&
          Math.abs(ev.clientX - s.x) <= 4 && Math.abs(ev.clientY - s.y) <= 4) return;
        if (!filesMovedRef.current) {
          filesMovedRef.current = true;
          setHlFiles(null);
          try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
        }
        filesSweep(ev);
      };
      var fileMarqueeEnd = function () {
        var wasMove = filesMovedRef.current;
        filesPendingRef.current = false;
        filesMovedRef.current = false;
        filesDragStart.current = null;
        if (wasMove) filesDragEndAt.current = Date.now();
      };
      var filesWrapClick = function (ev) {
        if (Date.now() - filesDragEndAt.current < 350) return; // release of a marquee
        var t = ev.target;
        if (t && t.closest && t.closest(".dsh-svn-histfile")) return;
        setHlFiles(null);
      };
      function fileRowClick(path) {
        if (Date.now() - filesDragEndAt.current < 350) return; // click after a marquee
        var list = hlFiles;
        if (list && list.length >= 2 && list.indexOf(path) !== -1) {
          // operate the whole marquee group from the clicked row's state.
          // Deferred briefly so a double click (which opens the diff on the
          // second click) can cancel the group op and never toggle twice.
          if (filesDblTimer.current) { clearTimeout(filesDblTimer.current); filesDblTimer.current = null; return; }
          var listCopy = list.slice();
          var pathCopy = path;
          filesDblTimer.current = setTimeout(function () {
            filesDblTimer.current = null;
            var cur = !!(props.checked && props.checked[pathCopy]);
            if (props.onBulkCheck) props.onBulkCheck(listCopy, !cur);
          }, 240);
          return; // keep the highlight selection
        }
        setHlFiles([path]); // plain click: select-highlight only
      }
      // top pane: the history list; clicking a revision selects it (and the
      // bottom detail pane appears); clicking again clears the selection.
      var localRev = props.localRev;
      var rows = entries.map(function (e) {
        var on = props.openRev === e.revision;
        var isCur = localRev !== undefined && localRev !== null && Number(localRev) === Number(e.revision);
        var isNew = !isCur && localRev !== undefined && localRev !== null && Number(e.revision) > Number(localRev);
        return h("div", { className: "dsh-svn-logrow" + (on ? " on" : "") + (isCur ? " cur" : "") + (isNew ? " new" : ""), key: e.revision, onClick: function () { props.onSelectRev(e.revision); } },
          h("div", { className: "dsh-svn-loghead" },
            h("span", { className: "dsh-svn-logrev" }, "r" + e.revision),
            isCur ? h("span", { className: "dsh-svn-curtag" }, "当前") : null,
            isNew ? h("span", { className: "dsh-svn-newtag" }, "新版本") : null,
            e.source === "local"
              ? h("span", { className: "dsh-svn-newtag", style: { color: "#f0b429" }, title: "离线：由工作副本元数据重建（没有提交日志文本）" }, "本地元数据")
              : (e.source === "cache" ? h("span", { className: "dsh-svn-newtag", style: { color: "#79c0ff" }, title: "离线：来自本地日志缓存" }, "缓存") : null),
            h("span", { className: "dsh-svn-logmeta" }, (e.author || "?") + " · " + shortDate(e.date)),
            h("span", { style: { flex: 1 } }),
            props.onSwitchRev && !isCur
              ? h("button", { className: "dsh-svn-switchrev",
                  disabled: props.busy || props.offline === true,
                  title: props.offline === true
                    ? "离线模式：切换工作副本版本需要连接服务器，请先点上方「重试」"
                    : "切换工作副本到 r" + e.revision + "（svn update -r " + e.revision + "）",
                  onClick: function (ev) { ev.stopPropagation(); props.onSwitchRev(e.revision); } },
                  "切换到此版本")
              : null
          ),
          h("div", { className: "dsh-svn-logmsg" }, e.message || "")
        );
      });
      // bottom pane: the selected revision's log + changed paths; clicking a
      // file opens the rN vs rN-1 side-by-side diff (reusing the 变更 view).
      var detail = null;
      if (props.openRev !== null && props.openRev !== undefined) {
        var entry = null;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].revision === props.openRev) { entry = entries[i]; break; }
        }
        if (entry) {
          var wcSuffix = props.wcSuffix || "";
          // history detail is ALWAYS in multi-select: every clickable file
          // row shows a checkbox (batch revert scope), and on hover the same
          // right-aligned action group as the 提交 page appears.
          var files = (entry.paths || []).map(function (p, idx) {
            var clickable = !!props.onOpenPath && p.kind !== "dir" &&
              (wcSuffix === "" || (p.path.indexOf(wcSuffix + "/") === 0));
            var meta = statusMeta(p.action);
            // undo/restore need a previous version (rN >= 2); "退回到此版本"
            // only needs this revision (rN >= 1).
            var hasOps = clickable && !!props.onRevertFile;
            var canUndo = hasOps && entry.revision >= 2;
            // the file's PREVIOUS VERSION: last-changed revision before this
            // revision (not rN-1, which may not have touched the file)
            var prevRev = props.prevRevs ? props.prevRevs[p.path] : undefined;
            var prevKnown = prevRev !== undefined && prevRev !== null;
            var prevLabel = prevKnown ? ("回退到 r" + prevRev) : "回退到修改前";
            var isChecked = !!(props.checked && props.checked[p.path]);
            var isRunning = !!props.activePath && props.activePath === p.path;
            var isHl = hlFiles !== null && hlFiles.indexOf(p.path) !== -1;
            var cls = "dsh-svn-histfile" + (clickable ? "" : " disabled") +
              (isChecked ? " checked" : "") + (isRunning ? " running" : "") + (isHl ? " sel" : "");
            return h("div", { className: cls,
              key: p.path + "-" + idx,
              "data-path": p.path,
              title: clickable ? "单击选中 / 双击查看 r" + entry.revision + " 与上一版本的对比" : "不可对比（目录或不在当前工作副本内）",
              onClick: clickable ? function () { fileRowClick(p.path); } : null,
              onDoubleClick: clickable ? function () {
                if (filesDblTimer.current) { clearTimeout(filesDblTimer.current); filesDblTimer.current = null; }
                props.onOpenPath(entry.revision, p.path);
              } : null },
              clickable
                ? h("input", { type: "checkbox", className: "dsh-svn-check",
                    checked: isChecked, disabled: props.busy,
                    title: isChecked ? "取消勾选" : "勾选此文件（参与批量撤销/回退/退回）",
                    onChange: function (ev) {
                      var list = hlFiles;
                      if (list && list.length >= 2 && list.indexOf(p.path) !== -1 && props.onBulkCheck) {
                        // checkbox of a row inside the marquee group: sync the
                        // whole group to this row's new state.
                        props.onBulkCheck(list, ev.target.checked);
                      } else {
                        props.onToggleCheck(p.path);
                      }
                    },
                    onClick: function (ev) { ev.stopPropagation(); } })
                : null,
              isRunning ? h("span", { className: "dsh-svn-spin dsh-svn-runspin", title: "正在执行…" }) : null,
              h("span", { className: "dsh-svn-badge " + p.action, style: { background: meta.color } }, p.action),
              h("span", { className: "dsh-svn-histfpath" }, p.path),
              clickable
                ? h("span", { className: "dsh-svn-histfile-ops",
                    onClick: function (ev) { ev.stopPropagation(); } },
                    h("button", { className: "dsh-svn-mini", disabled: props.busy,
                      style: { color: "#58a6ff", borderColor: "rgba(88,166,255,.45)" },
                      title: "查看 r" + entry.revision + " 与上一版本的对比（也可双击行进入）",
                      onClick: function (ev) { ev.stopPropagation(); props.onOpenPath(entry.revision, p.path); } },
                      "比对"),
                    canUndo
                      ? h("button", { className: "dsh-svn-mini", disabled: props.busy,
                          title: p.action === "A"
                            ? "撤销 r" + entry.revision + " 对该文件的改动（该文件 r" + entry.revision + " 新增：撤销 = 从工作副本删除，计划删除）"
                            : p.action === "D"
                              ? "撤销 r" + entry.revision + " 对该文件的改动（该文件 r" + entry.revision + " 删除：撤销 = 恢复修改前内容并计划添加）"
                              : "撤销 r" + entry.revision + " 对该文件的改动（svn merge -r " +
                                entry.revision + ":" + (entry.revision - 1) + " 反向合并到工作副本）：" +
                                "工作副本文件将变回该文件被修改前" + (prevKnown ? "（r" + prevRev + "）" : "") + "的内容；" +
                                "r" + entry.revision + " 之后的改动保留；文本可能冲突，二进制在工作副本有修改时可能报冲突",
                          onClick: function (ev) { ev.stopPropagation(); props.onRevertFile(entry.revision, p.path, p.action, "undo", prevRev); } },
                          "撤销 r" + entry.revision + " 改动")
                      : null,
                    canUndo
                      ? h("button", { className: "dsh-svn-mini danger", disabled: props.busy,
                          title: p.action === "A"
                            ? "回退到修改前（该文件 r" + entry.revision + " 新增、修改前不存在：回退 = 从工作副本删除，计划删除）"
                            : p.action === "D"
                              ? "回退到修改前（该文件 r" + entry.revision + " 删除：回退 = 写入修改前" + (prevKnown ? " r" + prevRev : "") + "内容并计划添加）"
                              : "把工作副本中的该文件回退到它被 r" + entry.revision + " 修改之前的版本" +
                                (prevKnown ? "（该文件上一次修改是 r" + prevRev + "，svn cat 精确覆盖）" : "（svn cat 精确覆盖）") +
                                "：r" + entry.revision + " 之后的改动与本地未提交修改会被丢弃",
                          onClick: function (ev) { ev.stopPropagation(); props.onRevertFile(entry.revision, p.path, p.action, "restore", prevRev); } },
                          prevLabel)
                      : null,
                    hasOps
                      ? h("button", { className: "dsh-svn-mini", disabled: props.busy,
                          title: p.action === "A"
                            ? "退回到此版本（r" + entry.revision + "，该文件在此版本新增）：用 r" + entry.revision + " 的内容覆盖当前文件（工作副本缺失时计划添加）"
                            : p.action === "D"
                              ? "退回到此版本（r" + entry.revision + "，该文件在此版本删除）：把该文件从工作副本删除（计划删除）"
                              : "退回到此版本（r" + entry.revision + "）：用该文件在 r" + entry.revision + " 的内容覆盖当前文件，" +
                                "r" + entry.revision + " 之后的改动与本地未提交修改会被丢弃",
                          onClick: function (ev) { ev.stopPropagation(); props.onRevertFile(entry.revision, p.path, p.action, "to-this", prevRev); } },
                          "退回到此版本")
                      : null)
                : null);
          });
          var hasFiles = files.length > 0;
          // always-on multi-select toolbar between the msg/files divider and
          // the file list: 全选/清空 on the left, batch action buttons on the
          // right (shown once files are checked and the set supports them).
          var checkedCount = 0;
          Object.keys(props.checked || {}).forEach(function (k) { if (props.checked[k]) checkedCount++; });
          var multiBar = null;
          if (hasFiles) {
            multiBar = h("div", { className: "dsh-svn-hisbar" },
              h("span", { className: "dsh-svn-hisbar-group" },
                h("button", { className: "dsh-svn-mini", disabled: props.busy,
                  title: "勾选全部可操作文件", onClick: function () { props.onSelectAll(entry.revision); } }, "全选"),
                h("button", { className: "dsh-svn-mini", disabled: props.busy,
                  title: "清空勾选", onClick: props.onClearChecks }, "清空")),
              h("span", { className: "sp" }),
              checkedCount > 0
                ? h("span", { className: "dsh-svn-hisbar-actions" },
                    entry.revision >= 2
                      ? h("button", { className: "dsh-svn-mini", disabled: props.busy,
                          title: "对勾选的 " + checkedCount + " 个文件撤销 r" + entry.revision + " 的改动（逐个执行）",
                          onClick: function () { props.onMultiAction("undo"); } },
                          "撤销 r" + entry.revision + " 改动")
                      : null,
                    entry.revision >= 2
                      ? h("button", { className: "dsh-svn-mini danger", disabled: props.busy,
                          title: "把勾选的 " + checkedCount + " 个文件回退到各自被修改前的版本（逐个执行）",
                          onClick: function () { props.onMultiAction("restore"); } },
                          "回退到修改前")
                      : null,
                    h("button", { className: "dsh-svn-mini", disabled: props.busy,
                      title: "用勾选的 " + checkedCount + " 个文件在 r" + entry.revision + " 的内容覆盖当前文件（逐个执行）",
                      onClick: function () { props.onMultiAction("to-this"); } },
                      "退回到此版本"))
                : null);
          }
          detail = h("div", { className: "dsh-svn-histdetail", ref: detailRef },
            h("div", { className: "dsh-svn-histdhead" },
              h("span", { className: "dsh-svn-logrev" }, "r" + entry.revision),
              h("span", { className: "dsh-svn-logmeta" }, (entry.author || "?") + " · " + shortDate(entry.date)),
              h("span", { style: { fontSize: 10, color: "#8b949e" } }, "共 " + (entry.paths || []).length + " 个路径"),
              props.onHideDetail
                ? h("button", { className: "dsh-svn-mini", title: "收起详情分页（回到列表）", onClick: props.onHideDetail }, "收起")
                : null
            ),
            h("div", { className: "dsh-svn-histdmsg", style: hasFiles ? { height: msgPct + "%" } : undefined },
              entry.messageKnown === false
                ? "（离线本地数据：该修订的作者/时间/变更文件来自工作副本元数据；SVN 不在工作副本保存提交日志文本，因此此处没有日志内容，且删除的文件无法还原）"
                : (entry.message || "")),
            hasFiles
              ? h("div", { className: "dsh-svn-histdivider", title: "拖动调整日志/路径分栏",
                  onPointerDown: msgDividerDown, onPointerMove: msgDividerMove,
                  onPointerUp: msgDividerUp, onPointerCancel: msgDividerUp })
              : null,
            hasFiles ? multiBar : null,
            hasFiles
              ? h("div", { className: "dsh-svn-histdfiles", ref: filesWrapRef,
                  onPointerDown: fileMarqueeDown, onPointerMove: fileMarqueeMove,
                  onPointerUp: fileMarqueeEnd, onPointerCancel: fileMarqueeEnd,
                  onClick: filesWrapClick }, files)
              : null
          );
        }
      }
      // top version bar: local working-copy revision vs remote HEAD, with a
      // "newer commits available" hint when the repository has moved ahead.
      var verBar = null;
      var meta = props.meta || null;
      var offlineNotice = meta && (meta.offline === true || meta.source === "cache+local" || meta.source === "local" || meta.source === "cache")
        ? h("div", { className: "dsh-svn-hisver", style: { color: "#f0b429", display: "block" } },
            "⚠ 离线数据 · 来源：" + (meta.source === "cache" ? "本地日志缓存" : (meta.source === "cache+local" ? "本地日志缓存 + 工作副本修订元数据" : "工作副本修订元数据"))
            + (meta.newestCached ? " · 缓存最新 r" + meta.newestCached : "")
            + (meta.cachedAt ? "（缓存于 " + shortDate(new Date(meta.cachedAt).toISOString()) + "）" : "")
            + "　" + (meta.note || "不完整的本地历史数据：不含提交日志文本的条目由工作副本元数据重建，可能过时或不完整。"))
        : null;
      if (props.localRev !== undefined && props.localRev !== null) {
        var localN = Number(props.localRev) || 0;
        var localMinN = props.localMin !== undefined && props.localMin !== null ? (Number(props.localMin) || 0) : 0;
        var isMixed = localMinN > 0 && localMinN !== localN;
        var headN = props.headRev !== undefined && props.headRev !== null ? (Number(props.headRev) || 0) : 0;
        var behind = headN > localN ? headN - localN : 0;
        var localLabel = isMixed ? ("r" + localMinN + "–r" + localN) : ("r" + localN);
        verBar = h("div", { className: "dsh-svn-hisver" },
          h("span", { className: "lbl" }, "本地版本"),
          h("span", { className: "cur", title: isMixed ? "混合版本：工作副本内不同文件处于不同版本" : undefined }, localLabel),
          isMixed ? h("span", { className: "lbl", style: { color: "#f0b429" } }, "混合") : null,
          h("span", { className: "lbl" }, "· 最新版本"),
          headN > 0
            ? h("span", { className: "head" }, "r" + headN)
            : h("span", { className: "lbl" }, props.headLoading ? "查询中…" : "未知"),
          behind > 0
            ? h("span", { className: "new" }, "有 " + behind + " 个新版本")
            : (headN > 0 ? h("span", { className: "lbl", style: { color: "#7ee787" } }, "已是最新") : null),
          h("span", { className: "sp" }),
          props.onRefreshHead
            ? h("button", { className: "dsh-svn-mini", disabled: props.busy || props.headLoading, onClick: props.onRefreshHead, title: "重新查询最新版本" }, "刷新")
            : null
        );
      }
      // "load more" footer at the bottom of the history list: fetches one
      // older page (设置 → 历史每页条数) per click, down to the first revision;
      // once no older entry remains, the button becomes a "whole history
      // shown" note (only when more than one page was loaded).
      var listItems = rows;
      var pageSize = Number(props.pageSize) > 0 ? Number(props.pageSize) : 30;
      if (props.onLoadMore) {
        var footer = props.more
          ? h("div", { className: "dsh-svn-histmore" },
              h("button", { className: "dsh-svn-actbtn", disabled: props.busy,
                onClick: props.onLoadMore,
                title: "再取 " + pageSize + " 条更早的提交历史，可重复点击直到 r1" },
                props.busy ? "加载中…" : "加载更早的版本"))
          : (rows.length >= pageSize
              ? h("div", { className: "dsh-svn-histmore done" }, "已显示全部 " + entries.length + " 条历史")
              : null);
        listItems = rows.concat([footer]);
      }
      var topBar = verBar || offlineNotice
        ? h("div", {}, verBar, offlineNotice)
        : null;
      return h("div", { className: "dsh-svn-hist", ref: wrapRef },
        topBar,
        h("div", { className: "dsh-svn-histlist", style: detail ? { height: topPct + "%" } : { height: "100%" } }, listItems),
        detail
          ? h("div", { className: "dsh-svn-histdivider", title: "拖动调整上下分栏",
              onPointerDown: dividerDown, onPointerMove: dividerMove,
              onPointerUp: dividerUp, onPointerCancel: dividerUp })
          : null,
        detail
      );
    }

    function LocksView(props) {
      var entries = props.entries || [];
      if (entries.length === 0) return h("div", { className: "dsh-svn-empty" }, "没有文件被占用 ✓");
      var rows = entries.map(function (e) {
        return h("div", { className: "dsh-svn-lockrow", key: e.path, title: (e.comment || "") || e.path },
          h("span", { className: "dsh-svn-lockicon" }, "🔒"),
          h("span", { className: "dsh-svn-histfpath" }, e.path),
          h("span", { className: "dsh-svn-lockowner" + (e.mine ? " mine" : ""), title: e.owner || "?" },
            (e.owner || "?") + (e.mine ? " · 我的锁" : "")),
          h("span", { className: "dsh-svn-locktime" }, e.created ? shortDate(e.created) : ""),
          e.mine && props.onUnlock
            ? h("button", { className: "dsh-svn-mini danger", title: "解锁该文件（SVN 锁定）", onClick: function () { props.onUnlock(e.path); } }, "解锁")
            : null
        );
      });
      return h("div", {},
        h("div", { className: "dsh-svn-summary" }, "共 " + entries.length + " 个文件被占用（SVN 锁定）"),
        props.note ? h("div", { className: "dsh-svn-summary", style: { color: "#f0b429" } }, "⚠ " + props.note) : null,
        rows
      );
    }

    function CommitView(props) {
      var selPaths = Object.keys(props.sel || {}).filter(function (p) { return props.sel[p]; });
      // `entries` is the VISIBLE list (unversioned files excluded when the
      // showUnv option is off); hiddenUnvCount reports what was left out.
      var allCount = (props.entries || []).length;
      var hasSel = selPaths.length > 0;
      var commitAll = !!props.commitAll;
      var hiddenUnv = props.hiddenUnvCount || 0;
      // offline / read-only: commit + AI log generation are disabled (the log
      // generator reads the working copy locally but the commit that follows
      // cannot succeed), with the reason surfaced in the hint and the title.
      var writesOff = props.writesOff === true;
      var writeHint = props.writeHint || "";
      var canSubmit = props.busy !== true && !writesOff && props.msg.trim() !== "" && allCount > 0 && (commitAll || hasSel);
      var canAi = props.aiBusy !== true && !writesOff && allCount > 0 && (commitAll || hasSel);
      var hint;
      if (allCount === 0) {
        hint = hiddenUnv > 0
          ? "没有已版本化的变更（另有 " + hiddenUnv + " 个未版本化文件已隐藏，不会提交）"
          : "工作副本干净，没有可提交的变更";
      } else if (commitAll) {
        hint = hiddenUnv > 0
          ? "将提交全部 " + allCount + " 个变更（另有 " + hiddenUnv + " 个未版本化文件已隐藏，不会提交）"
          : "将提交全部 " + allCount + " 个变更";
      } else {
        hint = hasSel
          ? "将提交已勾选的 " + selPaths.length + " 个文件；其余 " + Math.max(0, allCount - selPaths.length) + " 个未勾选变更将跳过"
          : "未勾选任何文件：请在列表勾选要提交的文件，或勾回「提交全部变更」";
      }
      var aiTitle = allCount === 0
        ? (hiddenUnv > 0
          ? "没有已版本化的变更（未版本化文件已隐藏，不会分析）"
          : "工作副本没有可见变更")
        : commitAll
          ? hiddenUnv > 0
            ? "根据全部 " + allCount + " 个已版本化变更生成（" + hiddenUnv + " 个未版本化文件已隐藏，不会分析）"
            : "根据全部 " + allCount + " 个变更生成"
          : hasSel
            ? "根据已勾选的 " + selPaths.length + " 个文件生成（未勾选文件不分析）"
            : "未勾选文件：先在列表勾选要提交的文件，或勾回「提交全部变更」";
      return h("div", { className: "dsh-svn-commit" },
        writesOff
          ? h("div", { className: "dsh-svn-lbl", style: { color: "#f0b429" } }, "⚠ " + (writeHint || "离线/只读模式：写操作已禁用"))
          : null,
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { className: "dsh-svn-lbl", style: { flex: 1 } }, "提交日志（项目规范：中文）"),
          h("button", { className: "dsh-svn-actbtn", disabled: !canAi, onClick: props.onAiGenerate, title: writesOff ? writeHint : aiTitle },
            props.aiBusy ? "生成中…" : "✨ AI 生成日志")
        ),
        h("textarea", { className: "dsh-svn-ta", placeholder: "在此输入提交日志，或点击「AI 生成日志」根据当前变更自动生成", value: props.msg, onChange: function (e) { props.onMsg(e.target.value); } }),
        h("div", { className: "dsh-svn-lbl", style: { color: allCount > 0 && !commitAll && !hasSel ? "#f0b429" : undefined } }, hint),
        h("div", { className: "dsh-svn-cmdraw" },
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8b949e", cursor: "pointer" } },
            h("input", { type: "checkbox", className: "dsh-svn-check", checked: commitAll, onChange: function (e) { props.onCommitAll(e.target.checked); } }),
            "提交全部变更"
          ),
          h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#8b949e", cursor: "pointer" }, title: "未版本化（?）文件是否在列表显示并纳入提交范围" },
            h("input", { type: "checkbox", className: "dsh-svn-check", checked: !!props.showUnv, onChange: function (e) { props.onToggleShowUnv(e.target.checked); } }),
            "显示无版本控制的文件"
          ),
          h("span", { style: { flex: 1 } }),
          h("button", { className: "dsh-svn-actbtn primary", disabled: !canSubmit, onClick: props.onCommit,
            title: writesOff ? writeHint : undefined },
            props.busy ? "提交中…" : "提交")
        )
      );
    }

    // ------------------------------------------------------------ settings
    // One namespace (`dsh-svn-tools`), registered by the host half and read or
    // written here through `ctx.settingsScope`. Everything a user may want to
    // change lives there; the panel and the settings card share this store, so
    // a change lands in both without a reload.
    var SETTINGS_NS = "dsh-svn-tools";
    /** Mirrors SETTINGS_DEFAULTS in lib/index.js — keep the two in sync. */
    var SETTINGS_DEFAULTS = {
      sidebarCarrier: "auto",
      svnPath: "",
      commandTimeoutScale: 1,
      historyPageSize: 30,
      historyCacheEnabled: true,
      historyCacheMaxEntries: 20000,
      autoAddUnversioned: true,
      autoDeleteMissing: true,
      showUnversionedDefault: true,
      defaultView: "commit",
    };
    var CARRIER_OPTIONS = [
      { value: "auto", label: "自动（有自带侧边栏就用它）" },
      { value: "native", label: "DSH 自带侧边栏" },
      { value: "better-sidebar", label: "dsh-better-sidebar 插件" },
      { value: "off", label: "关闭（只用 agent 工具）" },
    ];
    var CARRIER_NAMES = {
      auto: "自动",
      native: "DSH 自带侧边栏",
      "better-sidebar": "dsh-better-sidebar",
      off: "已关闭",
    };
    var VIEW_OPTIONS = [
      { value: "commit", label: "提交" },
      { value: "history", label: "历史" },
      { value: "locks", label: "占用" },
    ];
    var CARRIER_DEFAULT = "auto";

    /** The store shared by the SVN panel and its settings card. */
    function createSettingsStore() {
      var scope = null;
      var hostValue = null;
      var hostUser = null;
      var writeError = null;
      var listeners = [];
      var cached = null;

      function compute() {
        var scopeSnap = null;
        if (scope) { try { scopeSnap = scope.getSnapshot(); } catch (e) { scopeSnap = null; } }
        var scopeValue = scopeSnap && scopeSnap.status === "ready" && scopeSnap.value ? scopeSnap.value : null;
        var user = scopeValue
          ? (scopeSnap.user && typeof scopeSnap.user === "object" ? scopeSnap.user : {})
          : (hostUser && typeof hostUser === "object" ? hostUser : {});
        return {
          // ready = the settings document answered; host = only the host API
          // answered (no settingsScope in this build); unavailable = the
          // document exists but refuses this page (non-loopback http).
          status: scopeValue
            ? "ready"
            : (scopeSnap && scopeSnap.status === "unavailable"
              ? "unavailable"
              : (scopeSnap && scopeSnap.status === "loading" ? "loading" : (hostValue ? "host" : "defaults"))),
          value: Object.assign({}, SETTINGS_DEFAULTS, hostValue || null, scopeValue),
          user: user,
          writable: !!(scopeValue && scopeSnap.writable && scopeSnap.mode === "host"),
          mode: scopeSnap ? scopeSnap.mode : undefined,
          error: writeError,
        };
      }

      function notify() {
        cached = null;
        var list = listeners.slice();
        for (var i = 0; i < list.length; i++) {
          try { list[i](); } catch (e) { console.error("[dsh-svn-tools] settings listener failed", e); }
        }
      }

      function failed(error) {
        writeError = (error && error.message) ? error.message : String(error);
        notify();
        return Promise.reject(error);
      }

      // A named object so every method reads the store closure rather than
      // `this` — the panel and the card both destructure these.
      var store = {
        namespace: SETTINGS_NS,
        snapshot: function () { if (!cached) cached = compute(); return cached; },
        get: function (key) { return store.snapshot().value[key]; },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var i = listeners.indexOf(listener);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
        /** Bind the DSH settings scope once the service appears. */
        bindScope: function (binder) {
          scope = binder.bind({ namespace: SETTINGS_NS });
          scope.subscribe(notify);
          notify();
        },
        /** Fold the host's `/svn/api/root` answer in (fallback + first paint). */
        hydrate: function (value, user) {
          if (!value || typeof value !== "object") return;
          hostValue = value;
          if (user && typeof user === "object") hostUser = user;
          notify();
        },
        set: function (key, value) {
          if (!scope) return failed(new Error("设置存储不可用：当前页面没有挂载 DSH 设置服务，改动无法保存。"));
          writeError = null;
          return scope.set(key, value).then(function () { notify(); }, failed);
        },
        unset: function (key) {
          if (!scope) return failed(new Error("设置存储不可用：当前页面没有挂载 DSH 设置服务，改动无法保存。"));
          writeError = null;
          return scope.unset(key).then(function () { notify(); }, failed);
        },
        overridden: function (key) {
          return Object.prototype.hasOwnProperty.call(store.snapshot().user, key);
        },
      };
      return store;
    }

    /** The carrier's live state, so the card can say what is actually in force. */
    function createCarrierStore() {
      var state = { mode: CARRIER_DEFAULT, effective: "off", fallback: false, availability: { native: false, better: false }, error: null };
      var listeners = [];
      return {
        snapshot: function () { return state; },
        set: function (patch) {
          state = Object.assign({}, state, patch);
          var list = listeners.slice();
          for (var i = 0; i < list.length; i++) {
            try { list[i](); } catch (e) { console.error("[dsh-svn-tools] carrier listener failed", e); }
          }
        },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var i = listeners.indexOf(listener);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
      };
    }

    /**
     * Which carrier a configured mode actually uses. An explicit choice that
     * this build cannot honour degrades to the other carrier (never to a
     * missing panel) and reports `fallback: true` so the card can say so.
     */
    function resolveCarrier(mode, availability) {
      var wanted = typeof mode === "string" && CARRIER_NAMES[mode] ? mode : CARRIER_DEFAULT;
      if (wanted === "off") return { kind: "off", fallback: false };
      if (wanted === "native") {
        if (availability.native) return { kind: "native", fallback: false };
        return availability.better ? { kind: "better-sidebar", fallback: true } : { kind: "off", fallback: true };
      }
      if (wanted === "better-sidebar") {
        if (availability.better) return { kind: "better-sidebar", fallback: false };
        return availability.native ? { kind: "native", fallback: true } : { kind: "off", fallback: true };
      }
      if (availability.native) return { kind: "native", fallback: false };
      return availability.better ? { kind: "better-sidebar", fallback: false } : { kind: "off", fallback: false };
    }

    /** Subscribe one component to a small store (settings / carrier). */
    function useStoreSnapshot(store, fallback) {
      var pair = useState(function () { return store ? store.snapshot() : fallback; });
      var value = pair[0];
      var setValue = pair[1];
      useEffect(function () {
        if (!store) return function () {};
        setValue(store.snapshot());
        return store.subscribe(function () { setValue(store.snapshot()); });
      }, [store]);
      return value;
    }

    // Panel-side reads of three settings, kept pure so they are testable and so
    // an unparsable value (a hand-edited settings.yaml) can never reach the UI.
    /** History page size, clamped to the schema's range. */
    function pageSizeOf(value) {
      var n = Number(value && value.historyPageSize);
      return isFinite(n) && n >= 5 && n <= 200 ? Math.round(n) : SETTINGS_DEFAULTS.historyPageSize;
    }
    /** The page the panel opens on. */
    function defaultViewOf(value) {
      var wanted = value && value.defaultView;
      return wanted === "history" || wanted === "locks" ? wanted : "commit";
    }
    /** Whether unversioned files are listed on the 提交 page by default. */
    function showUnversionedOf(value) {
      return !value || value.showUnversionedDefault !== false;
    }

    // ---------------------------------------------------- sidebar carriers
    /** The built-in (DSH ≥ 0.1.5) sidebar body: the panel plus the framework's
     * tab visibility, which drives the first-visible probe and reload. */
    function NativeSvnTab(props) {
      var info = null;
      if (typeof props.useTabInfo === "function") {
        try { info = props.useTabInfo(); } catch (e) { info = null; }
      }
      var visible = info && info.tab ? info.tab.visible !== false : true;
      return h(SvnPanel, { scope: { sessionId: props.sessionId }, visible: visible, settings: props.settings });
    }

    /** Guide glyph: the guide draws whatever component is registered. */
    function SvnGuideIcon(props) {
      var size = props && typeof props.size === "number" ? props.size : 20;
      return svnIcon(size);
    }

    /** Register the panel as a tab type in DSH's own right Sidebar. */
    function registerNativeCarrier(host, settings) {
      var disposers = [];
      disposers.push(host.sidebarRightTabs.register({
        id: "dsh-svn-tools",
        kind: "svn",
        title: function () { return "SVN"; },
        guide: [{
          id: "svn",
          order: 40,
          title: function () { return "SVN"; },
          description: function () { return "工作副本状态、提交、历史、比对与占用"; },
          icon: SvnGuideIcon,
        }],
      }));
      disposers.push(host.slots.inject("sidebar.right.pane.tab", function () {
        return host.slots.register({
          name: "sidebar.right.pane.tab",
          key: "dsh-svn-tools",
          inject: function () { return { settings: settings }; },
        }, NativeSvnTab);
      }));
      return function () {
        for (var i = disposers.length - 1; i >= 0; i--) {
          try { if (typeof disposers[i] === "function") disposers[i](); } catch (e) { /* already gone */ }
        }
      };
    }

    /** Register the panel as a tab in the dsh-better-sidebar plugin. */
    function registerBetterSidebarCarrier(host, settings) {
      var dispose = host.betterSidebar.registerTab({
        id: "svn",
        title: function () { return "SVN"; },
        icon: function (size) { return svnIcon(size); },
        order: 150,
        single: true,
        component: function (p) { return h(SvnPanel, { scope: p && p.scope, visible: p && p.visible, settings: settings }); },
      });
      return function () { try { dispose(); } catch (e) { /* already disposed */ } };
    }

    // ------------------------------------------------- settings card (UI)
    /** One row of the settings card: label, control, override badge, reset. */
    function SettingsRow(props) {
      return h("div", { className: "dsh-svn-set-row" },
        h("div", { className: "dsh-svn-set-label" },
          props.label,
          props.overridden ? h("span", { className: "dsh-svn-set-badge", title: "已覆盖默认值，可点「恢复默认」清除" }, "已改") : null),
        h("div", { className: "dsh-svn-set-ctl" },
          props.children,
          props.overridden
            ? h("button", { className: "dsh-svn-set-btn", disabled: props.disabled, onClick: props.onReset, title: "清除用户覆盖，回到默认值" }, "恢复默认")
            : null,
          props.hint ? h("div", { className: "dsh-svn-set-hint" }, props.hint) : null)
      );
    }

    /** A text/number field: staged locally, committed on blur or Enter. */
    function SettingsField(props) {
      var pair = useState(props.value === undefined || props.value === null ? "" : String(props.value));
      var text = pair[0];
      var setText = pair[1];
      var dirtyPair = useState(false);
      var dirty = dirtyPair[0];
      var setDirty = dirtyPair[1];
      var invalidPair = useState(false);
      var invalid = invalidPair[0];
      var setInvalid = invalidPair[1];
      useEffect(function () {
        if (!dirty) { setText(props.value === undefined || props.value === null ? "" : String(props.value)); setInvalid(false); }
      }, [props.value, dirty]);
      function commit() {
        if (!dirty) return;
        if (props.numeric) {
          var n = Number(text);
          if (text.trim() === "" || !isFinite(n) || n < props.min || n > props.max) { setInvalid(true); return; }
          props.onCommit(n);
        } else {
          props.onCommit(text.trim());
        }
        setDirty(false);
        setInvalid(false);
      }
      return h("input", {
        type: props.numeric ? "number" : "text",
        value: text,
        disabled: props.disabled,
        min: props.numeric ? props.min : undefined,
        max: props.numeric ? props.max : undefined,
        step: props.numeric ? props.step : undefined,
        placeholder: props.placeholder,
        style: invalid ? { borderColor: "rgba(248,81,73,.7)" } : undefined,
        title: invalid ? props.invalidHint : undefined,
        onChange: function (e) { setText(e.target.value); setDirty(true); },
        onBlur: commit,
        onKeyDown: function (e) { if (e.key === "Enter") commit(); },
      });
    }

    /**
     * The settings card rendered in Settings → Plugins → Plugin configuration,
     * keyed by the namespace the host half registers. Every control writes
     * straight through to that namespace; nothing is persisted locally.
     */
    function SvnSettingsCard(props) {
      var store = (props && props.svnSettings) || settingsStore();
      var carrierStore = (props && props.svnCarrier) || null;
      var snap = useStoreSnapshot(store, null);
      var carrier = useStoreSnapshot(carrierStore, null);
      var checkPair = useState(null);
      var check = checkPair[0];
      var setCheck = checkPair[1];
      var busyPair = useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var pathPair = useState(null);
      var pathDraft = pathPair[0];
      var setPathDraft = pathPair[1];
      if (!snap) return null;

      var value = snap.value;
      var disabled = !snap.writable;
      var carrierSnap = carrier || { mode: value.sidebarCarrier, effective: "off", fallback: false, availability: { native: false, better: false } };
      function setField(key, v) { store.set(key, v).catch(function () { /* the store keeps the message */ }); }
      function toggle(key) {
        return function (e) { setField(key, e.target.checked); };
      }
      function carriedPath() {
        return pathDraft === null ? (value.svnPath || "") : pathDraft;
      }
      function checkBinary() {
        var candidate = carriedPath().trim();
        setBusy(true);
        callRaw("check-svn", candidate === "" ? {} : { path: candidate }).then(function (v) {
          setCheck(v);
        }).catch(function (e) {
          setCheck({ ok: false, binary: candidate || "svn", error: e.message || String(e) });
        }).finally(function () { setBusy(false); });
      }

      var statusNote = null;
      if (snap.status === "unavailable") {
        statusNote = h("div", { className: "dsh-svn-set-note err" },
          "设置存储在本页不可用（非本机地址打开，或部署没有挂载设置文档）：下面的改动无法保存，面板按默认值运行。");
      } else if (snap.status === "loading") {
        statusNote = h("div", { className: "dsh-svn-set-note" }, "正在读取设置…");
      } else if (snap.status === "host") {
        statusNote = h("div", { className: "dsh-svn-set-note" },
          "已从宿主读到当前设置（只读）：本页没有挂载设置服务，请在本机地址打开 DSH 后再改。");
      } else if (snap.error) {
        statusNote = h("div", { className: "dsh-svn-set-note err" }, "上一次保存失败：" + snap.error);
      } else if (snap.writable) {
        statusNote = h("div", { className: "dsh-svn-set-note ok" }, "改动立即写入 DSH 设置文档（settings.yaml），无需重启。");
      }

      var fallbackNote = carrierSnap.fallback
        ? h("div", { className: "dsh-svn-set-note" },
          "所选的载体在本部署不可用，已自动回退到「" + CARRIER_NAMES[carrierSnap.effective] + "」。")
        : null;
      var availabilityNote = "可用载体："
        + (carrierSnap.availability.native ? "DSH 自带侧边栏" : "")
        + (carrierSnap.availability.native && carrierSnap.availability.better ? " + " : "")
        + (carrierSnap.availability.better ? "dsh-better-sidebar" : "")
        + (carrierSnap.availability.native || carrierSnap.availability.better ? "" : "无（不会出现侧边栏面板）");

      return h("div", { className: "dsh-svn-set" },
        h("div", { className: "dsh-svn-set-head" },
          h("div", { className: "dsh-svn-set-title" }, "SVN 工具"),
          h("div", { className: "dsh-svn-set-sub" }, "侧边栏载体、svn 可执行文件、超时、历史分页与缓存、提交前的自动处理。")),
        statusNote,
        fallbackNote,
        h("div", { className: "dsh-svn-set-grid" },
          h(SettingsRow, {
            label: "侧边栏载体",
            overridden: store.overridden("sidebarCarrier"),
            disabled: disabled,
            onReset: function () { store.unset("sidebarCarrier").catch(function () {}); },
            hint: "当前生效：" + CARRIER_NAMES[carrierSnap.effective] + "。" + availabilityNote + "。切换后立即生效（当前打开的 SVN 分页会关闭）。",
          },
            h("select", {
              value: value.sidebarCarrier,
              disabled: disabled,
              onChange: function (e) { setField("sidebarCarrier", e.target.value); },
            }, CARRIER_OPTIONS.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); }))),

          h(SettingsRow, {
            label: "svn 可执行文件",
            overridden: store.overridden("svnPath"),
            disabled: disabled,
            onReset: function () { setPathDraft(null); store.unset("svnPath").catch(function () {}); },
            hint: check
              ? (check.ok
                ? "检测通过：" + (check.version || "") + "（" + check.binary + "）"
                : "检测失败：" + (check.error || "") + "（" + check.binary + "）")
              : "留空 = 使用 PATH 中的 svn。改动在失焦或回车后保存；svnversion 会在同一目录里自动查找。",
          },
            h(SettingsField, {
              value: value.svnPath || "",
              disabled: disabled,
              placeholder: "例如 D:\\Tools\\svn\\bin\\svn.exe",
              onCommit: function (text) { setField("svnPath", text); },
            }),
            h("button", { className: "dsh-svn-set-btn", disabled: busy, onClick: checkBinary }, busy ? "检测中…" : "检测")),

          h(SettingsRow, {
            label: "命令超时倍数",
            overridden: store.overridden("commandTimeoutScale"),
            disabled: disabled,
            onReset: function () { store.unset("commandTimeoutScale").catch(function () {}); },
            hint: "乘以每条 svn 命令的默认超时（默认 60 秒，更新/提交 300 秒）：仓库慢、工作副本大时调到 2–3。",
          },
            h(SettingsField, {
              value: value.commandTimeoutScale,
              numeric: true, min: 0.2, max: 20, step: 0.1,
              disabled: disabled,
              invalidHint: "请输入 0.2 – 20 之间的数字",
              onCommit: function (n) { setField("commandTimeoutScale", n); },
            })),

          h(SettingsRow, {
            label: "历史每页条数",
            overridden: store.overridden("historyPageSize"),
            disabled: disabled,
            onReset: function () { store.unset("historyPageSize").catch(function () {}); },
            hint: "「历史」分页首屏条数，也是「加载更早的版本」每次追加的条数（5 – 200）。",
          },
            h(SettingsField, {
              value: value.historyPageSize,
              numeric: true, min: 5, max: 200, step: 1,
              disabled: disabled,
              invalidHint: "请输入 5 – 200 之间的整数",
              onCommit: function (n) { setField("historyPageSize", Math.round(n)); },
            })),

          h(SettingsRow, {
            label: "本地历史缓存",
            overridden: store.overridden("historyCacheEnabled"),
            disabled: disabled,
            onReset: function () { store.unset("historyCacheEnabled").catch(function () {}); },
            hint: "把取到的 svn log 缓存在工作副本的 .svn 下，服务器不可达时「历史」分页仍可用（数据可能过时）。",
          },
            h("label", { className: "dsh-svn-set-check" },
              h("input", { type: "checkbox", checked: value.historyCacheEnabled !== false, disabled: disabled, onChange: toggle("historyCacheEnabled") }),
              value.historyCacheEnabled !== false ? "已开启" : "已关闭")),

          h(SettingsRow, {
            label: "缓存上限（条）",
            overridden: store.overridden("historyCacheMaxEntries"),
            disabled: disabled || value.historyCacheEnabled === false,
            onReset: function () { store.unset("historyCacheMaxEntries").catch(function () {}); },
            hint: "单个工作副本最多缓存多少个版本（100 – 200000），超出后按版本号从新到旧保留。",
          },
            h(SettingsField, {
              value: value.historyCacheMaxEntries,
              numeric: true, min: 100, max: 200000, step: 100,
              disabled: disabled || value.historyCacheEnabled === false,
              invalidHint: "请输入 100 – 200000 之间的整数",
              onCommit: function (n) { setField("historyCacheMaxEntries", Math.round(n)); },
            })),

          h(SettingsRow, {
            label: "提交：自动添加",
            overridden: store.overridden("autoAddUnversioned"),
            disabled: disabled,
            onReset: function () { store.unset("autoAddUnversioned").catch(function () {}); },
            hint: "提交时把选中的未版本化（?）文件先 svn add，避免 `svn commit` 静默跳过它们。关闭后这些文件不提交并在结果里列出。",
          },
            h("label", { className: "dsh-svn-set-check" },
              h("input", { type: "checkbox", checked: value.autoAddUnversioned !== false, disabled: disabled, onChange: toggle("autoAddUnversioned") }),
              value.autoAddUnversioned !== false ? "已开启" : "已关闭")),

          h(SettingsRow, {
            label: "提交：自动删除",
            overridden: store.overridden("autoDeleteMissing"),
            disabled: disabled,
            onReset: function () { store.unset("autoDeleteMissing").catch(function () {}); },
            hint: "提交时把已版本化但磁盘上缺失（!）的文件先 svn delete，避免提交失败。关闭后这些文件不提交并在结果里列出。",
          },
            h("label", { className: "dsh-svn-set-check" },
              h("input", { type: "checkbox", checked: value.autoDeleteMissing !== false, disabled: disabled, onChange: toggle("autoDeleteMissing") }),
              value.autoDeleteMissing !== false ? "已开启" : "已关闭")),

          h(SettingsRow, {
            label: "默认显示未版本化",
            overridden: store.overridden("showUnversionedDefault"),
            disabled: disabled,
            onReset: function () { store.unset("showUnversionedDefault").catch(function () {}); },
            hint: "「提交」分页打开时「显示无版本控制的文件」的初始勾选状态（面板里仍可随时切换）。",
          },
            h("label", { className: "dsh-svn-set-check" },
              h("input", { type: "checkbox", checked: value.showUnversionedDefault !== false, disabled: disabled, onChange: toggle("showUnversionedDefault") }),
              value.showUnversionedDefault !== false ? "显示" : "隐藏")),

          h(SettingsRow, {
            label: "面板默认分页",
            overridden: store.overridden("defaultView"),
            disabled: disabled,
            onReset: function () { store.unset("defaultView").catch(function () {}); },
            hint: "侧边栏面板打开时先显示哪一页。",
          },
            h("select", {
              value: value.defaultView,
              disabled: disabled,
              onChange: function (e) { setField("defaultView", e.target.value); },
            }, VIEW_OPTIONS.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); })))
        )
      );
    }

    // ----------------------------------------------------------- main tab
    function SvnPanel(props) {
      var scope = props.scope || {};
      var sessionId = scope.sessionId;
      // User settings (namespace `dsh-svn-tools`), read through the shared
      // store: the panel's defaults and its history paging come from here, and
      // the store is hydrated from `/svn/api/root` when no settings scope is
      // available, so the panel always runs with the host's resolved values.
      var store = props.settings || settingsStore();
      var settingsSnap = useStoreSnapshot(store, null);
      var settingsValue = settingsSnap ? settingsSnap.value : SETTINGS_DEFAULTS;
      var pageSize = pageSizeOf(settingsValue);
      var [repo, setRepo] = useState(null);
      var [entries, setEntries] = useState(null);
      var [summary, setSummary] = useState(null);
      var [logs, setLogs] = useState(null);
      // history page data provenance: 'remote' | 'cache+local' | 'local'
      // (+ the offline note the server attached), so the list itself flags
      // entries that came from the local cache or from wc.db metadata.
      var [logMeta, setLogMeta] = useState(null);
      // history paging: true while older revisions may exist below the
      // oldest loaded entry (shows the list's "加载更早的版本" button).
      var [logMore, setLogMore] = useState(false);
      var [view, setView] = useState(function () {
        return defaultViewOf(store.snapshot().value);
      });
      var [diff, setDiff] = useState(null);
      var [busy, setBusy] = useState(false);
      var [err, setErr] = useState(null);
      var [notice, setNotice] = useState(null);
      // 在线 / 离线 / 只读 (see MODE_KEY above). `offlineErr` carries the
      // transport error that forced offline mode; `probeBusy` disables the
      // 重试 button while the connectivity probe runs.
      var [offline, setOffline] = useState(function () { return readStoredMode() === "offline"; });
      var [readOnly, setReadOnly] = useState(function () { return readStoredMode() === "read-only"; });
      var [offlineErr, setOfflineErr] = useState(null);
      var [probeBusy, setProbeBusy] = useState(false);
      // Mirror the mode into refs so the call wrapper always sees the current
      // value without being re-created on every mode change.
      var offlineRef = React.useRef(offline);
      var readOnlyRef = React.useRef(readOnly);
      offlineRef.current = offline;
      readOnlyRef.current = readOnly;
      var [msg, setMsg] = useState("");
      var [sel, setSel] = useState({});
      var [commitAll, setCommitAll] = useState(true);
      // commit page: whether unversioned (?) files are listed. Hidden files
      // are excluded from the commit scope and the AI analysis too. The initial
      // state is the user's preference (设置 → 默认显示未版本化).
      var [showUnv, setShowUnv] = useState(function () { return showUnversionedOf(store.snapshot().value); });
      var [openRev, setOpenRev] = useState(null);
      var [aiBusy, setAiBusy] = useState(false);
      var [blame, setBlame] = useState(null);
      var [resolvePath, setResolvePath] = useState(null);
      var [branchModal, setBranchModal] = useState(false);
      var [branchList, setBranchList] = useState(null);
      var [checkoutMode, setCheckoutMode] = useState(false);
      var [locks, setLocks] = useState(null);
      var [locksNote, setLocksNote] = useState(null);
      // 'svn update' live progress (polled from the server job).
      var [updateJob, setUpdateJob] = useState(null);
      var pollFails = 0;
      // remote HEAD revision + query state for the history page.
      var [headInfo, setHeadInfo] = useState(null);
      var [headLoading, setHeadLoading] = useState(false);
      // repo-relative path → the file's "previous version" (last-changed
      // revision before the selected revision) for revert-button labels.
      var [prevRevs, setPrevRevs] = useState({});
      // history detail: always multi-select — checked files for batch
      // revert + the file being reverted right now (row highlight).
      var [checked, setChecked] = useState({});
      var [activePath, setActivePath] = useState(null);
      // commit page: changes list (top) vs commit form (bottom) split ratio.
      var [cmpPct, setCmpPct] = useState(55);
      var cmpWrapRef = React.useRef(null);
      var cmpDragRef = React.useRef(false);

      var payload = useCallback(function (extra) {
        var base = { sessionId: sessionId };
        if (scope.cwd) base.cwd = scope.cwd;
        if (extra) Object.assign(base, extra);
        return base;
      }, [sessionId, scope.cwd]);

      // ----------------------------------------------------------- modes
      /** One /svn/api/* round-trip with the mode policy applied:
       * - read-only: write methods are refused before they reach svn;
       * - offline:   server-dependent methods are refused with a hint to
       *              retry (local reads still go through);
       * - online:    a transport failure flips the panel into offline mode
       *              and re-runs the request once so the server can answer
       *              from its cache (`log` is upgraded to `mode: 'local'`,
       *              which also adds the locally reconstructed revisions). */
      function call(method, pl) {
        var mode = offlineRef.current ? "offline" : (readOnlyRef.current ? "read-only" : "online");
        var blocked = blockMethod(mode, method);
        if (blocked !== undefined) return Promise.reject(new Error(blocked));
        var body = pl || {};
        if (offlineRef.current) body = Object.assign({}, body, { mode: "local" });
        if (readOnlyRef.current) body = Object.assign({}, body, { readOnly: true });
        return callRaw(method, body).then(function (v) {
          if (v && v.offline === true && !offlineRef.current) enterOffline(v.message || v.error || v.note);
          return v;
        }, function (e) {
          var msg = (e && e.message) || String(e);
          if (!isTransportError(msg)) throw e;
          enterOffline(msg);
          // Re-run against the local data path so the page still fills in.
          return callRaw(method, Object.assign({}, body, { mode: "local" })).then(function (v) {
            if (v && v.offline === true) enterOffline(v.message || v.error);
            return v;
          });
        });
      }

      /** Enter offline mode (no 「永远离线」: it is a page-memory state that
       *  every 重试 leaves again) and remember why. */
      function enterOffline(reason) {
        offlineRef.current = true;
        setOffline(true);
        if (reason) setOfflineErr(reason);
      }

      function goOffline() {
        writeStoredMode("offline");
        enterOffline(null);
        setNotice("已切换到离线：历史列表来自本地日志缓存与工作副本元数据");
        // Re-read the current page from local data (cache + wc.db snapshot).
        if (view === "history") loadLog();
        else loadAll(true);
      }

      /** 「重试」 — the explicit way back online. Probes the repository and
       *  reloads the current page when it answers; otherwise it stays offline
       *  and reports the error (and the 离线 choice remains available). */
      function retryOnline() {
        setProbeBusy(true);
        setErr(null);
        return callRaw("connection", payload({ probe: true })).then(function (v) {
          if (v && v.reachable === false) {
            enterOffline(v.error);
            setErr("仍然无法连接服务器：" + (v.error || "未知错误") + "（可继续使用离线数据，稍后再重试）");
            return;
          }
          offlineRef.current = false;
          setOffline(false);
          setOfflineErr(null);
          writeStoredMode(readOnlyRef.current ? "read-only" : "online");
          setNotice("已恢复在线连接");
          if (view === "history") loadLog();
          else loadAll(true);
        }).catch(function (e) {
          setErr(e.message || String(e));
        }).finally(function () { setProbeBusy(false); });
      }

      function setReadOnlyMode(on) {
        readOnlyRef.current = on;
        setReadOnly(on);
        writeStoredMode(on ? "read-only" : (offlineRef.current ? "offline" : "online"));
        setNotice(on ? "已开启只读模式：写操作已禁用" : "已退出只读模式");
      }

      var modeInfo = offline
        ? { id: "offline", label: "离线", text: "离线模式：服务器不可达，显示本地日志缓存与工作副本修订元数据（可能不完整、可能过时）。" }
        : readOnly
          ? { id: "readonly", label: "只读", text: "只读模式：写操作（添加/删除/还原/提交/回退/更新）已禁用，查看不受影响。" }
          : { id: "online", label: "在线", text: "" };
      // Write operations in the panel: disabled while offline (they either
      // need the server or create a local change that cannot be committed) and
      // in read-only mode. Pure local reads stay available in both.
      var writesOff = offline || readOnly;
      var writeHint = offline ? WRITE_HINT : (readOnly ? READONLY_HINT : "");

      // Settings arrive asynchronously (the document may still be loading, and
      // the host fallback lands with the first `root` call). Apply the two
      // preference defaults exactly once, and never after the user has picked
      // something in this panel.
      var settingsPicked = React.useRef(false);
      var settingsApplied = React.useRef(false);
      useEffect(function () {
        if (settingsApplied.current || settingsPicked.current || !settingsSnap) return;
        if (settingsSnap.status !== "ready" && settingsSnap.status !== "host") return;
        settingsApplied.current = true;
        setView(defaultViewOf(settingsSnap.value));
        setShowUnv(showUnversionedOf(settingsSnap.value));
      }, [settingsSnap]);

      var loadAll = useCallback(async function (silent) {
        if (!silent) setBusy(true);
        setErr(null);
        try {
          var p = payload();
          var r = await call("root", p);
          var s = await call("status", p);
          // The host is the authority on the resolved settings; folding them in
          // keeps the panel correct even where no settings scope is mounted.
          if (r && r.settings) store.hydrate(r.settings, r.settingsUser);
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
      }, [payload, store]);

      // The stored mode can be stale (the server may have gone away since the
      // page was last used), so the first time the panel becomes visible we
      // settle the mode with one cheap probe and only THEN load data — that
      // way the first load is already offline-aware instead of timing out.
      var bootProbed = React.useRef(false);
      var [booted, setBooted] = useState(false);
      useEffect(function () {
        if (!props.visible || bootProbed.current) return;
        bootProbed.current = true;
        callRaw("connection", payload({ probe: true })).then(function (v) {
          if (v && v.reachable === false) {
            enterOffline(v.error || v.note);
            if (v.reason === "repository-missing") setOfflineErr(v.error || null);
          } else if (v && v.reachable === true) {
            // The server answered: online data is available, so leave the
            // stored offline state (offline is never permanent).
            offlineRef.current = false;
            setOffline(false);
            setOfflineErr(null);
            writeStoredMode(readOnlyRef.current ? "read-only" : "online");
          }
        }).catch(function () { /* probe failure: the load will report it */ })
          .finally(function () { setBooted(true); });
      }, [props.visible, payload]);

      useEffect(function () {
        if (props.visible && booted) {
          loadAll(true);
        }
      }, [props.visible, booted, loadAll]);

      // Keep the top-list checkboxes consistent with the (re)loaded entries:
      // commit-all mode = every visible file checked; selected mode = prune
      // checked paths that disappeared or got hidden by the unversioned
      // toggle (never silently re-add, never auto-return to commit-all).
      useEffect(function () {
        if (entries === null) return;
        if (commitAll) {
          var full = {};
          (entries || []).forEach(function (e) {
            if (showUnv || e.status !== "?") full[e.path] = true;
          });
          setSel(full);
        } else {
          setSel(function (old) {
            var next = {};
            var changed = false;
            (entries || []).forEach(function (e) {
              if ((showUnv || e.status !== "?") && old && old[e.path]) next[e.path] = true;
            });
            Object.keys(old || {}).forEach(function (k) {
              if (old[k] && !next[k]) changed = true;
            });
            return changed ? next : old;
          });
        }
      }, [entries, showUnv]);

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

      // History: diff of one repo path between a revision and its parent
      // (rN vs rN-1), reusing the same left-right comparison view. Read-only.
      function showHistoryDiff(repoRel, revision) {
        setBusy(true);
        setErr(null);
        call("diff-sides-rev", payload({ repoRel: repoRel, revision: revision })).then(function (res) {
          setDiff({
            path: repoRel,
            text: res.binary ? (res.message || "(二进制文件)") : res.text,
            sides: res,
            revision: revision,
            fromHistory: true,
            offlineNote: res.note,
          });
          setView("diff");
        }).catch(function (e) {
          setErr(e.message || String(e));
        }).finally(function () { setBusy(false); });
      }

      // Build the per-file success note for one history-revert result.
      function historyRevertNote(mode, revision, name, v) {
        var gotPrev = v && v.prevRev !== undefined && v.prevRev !== null;
        var gotLabel = gotPrev ? ("r" + v.prevRev + "（修改前）") : "修改前";
        if (mode === "to-this") {
          return {
            content: "已把 " + name + " 退回为 r" + revision + "（此版本）的内容，请检查后提交",
            revert: "已把 " + name + " 退回为 r" + revision + "（此版本）的内容（本地基准还原，未从服务器拉取）",
            delete: name + " 在 r" + revision + " 已删除：已从工作副本删除，提交后生效",
            "restore-add": "已把 " + name + " 退回为 r" + revision + "（此版本）的内容并计划添加，请检查后提交",
            unchanged: name + " 与 r" + revision + " 的状态相同，无需回退",
          }[v.effect] || ("已把 " + name + " 退回为 r" + revision + "（此版本）");
        }
        return {
          merge: "已撤销 r" + revision + " 的改动（" + name + " → " + gotLabel + "内容），请检查后提交",
          content: "已把 " + name + " 回退到" + gotLabel + "的版本，请检查后提交",
          revert: "已把 " + name + " 回退到" + gotLabel + "的版本（本地基准还原，未从服务器拉取），请检查后提交",
          delete: name + "（r" + revision + " 新增）已从工作副本删除，提交后生效",
          "restore-add": "已恢复 " + name + " 的" + gotLabel + "版本并计划添加，请检查后提交",
          unchanged: name + " 的内容与" + gotLabel + "相同，无需回退",
        }[v.effect] || ("已回退 " + name + " 到修改前的版本");
      }

      // History: revert one repo file in the working copy. Working copy only
      // — no commit. Modes:
      //  - "undo": reverse merge of rN (keeps later changes, may conflict)
      //  - "restore": exact PREVIOUS-VERSION content overwrite (the file's
      //    last-changed revision before rN, not rN-1) — discards later
      //    changes and local edits
      //  - "to-this": exact THIS-VERSION (rN) content overwrite — discards
      //    later changes and local edits
      function revertHistoryFile(revision, repoRel, action, mode, prevRev) {
        var name = repoRel.split(/[\\/]/).pop();
        var prevKnown = prevRev !== undefined && prevRev !== null;
        var prevLabel = prevKnown ? ("r" + prevRev + "（该文件被修改前的版本）") : "该文件被修改前的版本";
        var text = mode === "to-this"
          ? action === "A"
            ? "退回到此版本（r" + revision + "）覆盖当前文件？\n\n" +
              "该文件在 r" + revision + " 新增：将用 r" + revision + " 的内容覆盖当前文件（工作副本缺失时计划添加），提交后生效。\n\n" + repoRel
            : action === "D"
              ? "退回到此版本（r" + revision + "）覆盖当前文件？\n\n" +
                "该文件在 r" + revision + " 已删除：此版本状态 = 文件不存在，将从工作副本删除该文件（计划删除），提交后生效。\n\n" + repoRel
              : "退回到此版本（r" + revision + "）覆盖当前文件？\n\n" +
                "将用该文件在 r" + revision + " 的内容直接覆盖工作副本文件：\n" +
                "r" + revision + " 之后的改动与本地未提交修改会被丢弃。\n\n" + repoRel
          : mode === "undo"
            ? action === "A"
              ? "撤销 r" + revision + " 对该文件的改动？\n\n" +
                "该文件在 r" + revision + " 新增：撤销将把它从工作副本删除（计划删除），提交后生效。\n\n" + repoRel
              : action === "D"
                ? "撤销 r" + revision + " 对该文件的改动？\n\n" +
                  "该文件在 r" + revision + " 删除：撤销将把它恢复为 " + prevLabel + " 的内容并计划添加，提交后生效。\n\n" + repoRel
                : "撤销 r" + revision + " 对该文件的改动？\n\n" +
                  "（svn merge -r " + revision + ":" + (revision - 1) + " 反向合并到工作副本）\n" +
                  "工作副本中的该文件将变回 " + prevLabel + " 的内容；r" + revision + " 之后若又改过则只撤销 r" + revision + " 的增量。\n" +
                  "本地未提交修改可能受影响；文本文件可能产生冲突、二进制文件可能报冲突。\n\n" + repoRel
            : action === "A"
              ? "把工作副本中的该文件回退到它被修改之前的版本？\n\n" +
                "该文件在 r" + revision + " 新增、修改前不存在：回退 = 把该文件从工作副本删除（计划删除），提交后生效。\n\n" + repoRel
              : action === "D"
                ? "把工作副本中的该文件回退到它被修改之前的版本？\n\n" +
                  "该文件在 r" + revision + " 删除：回退 = 写入 " + prevLabel + " 内容并计划添加，提交后生效。\n\n" + repoRel
                : "把工作副本中的该文件回退到它被 r" + revision + " 修改之前的版本？\n\n" +
                  "（该文件上一次修改是 " + prevLabel + "，用其内容直接覆盖工作副本文件）\n" +
                  "该文件 r" + revision + " 之后的所有改动与本地未提交修改会被丢弃。\n\n" + repoRel;
        if (!window.confirm(text)) return;
        setBusy(true);
        setErr(null);
        setActivePath(repoRel);
        call("history-revert", payload({ repoRel: repoRel, revision: revision, mode: mode })).then(function (v) {
          setNotice(historyRevertNote(mode, revision, name, v));
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setActivePath(null); setBusy(false); });
      }

      // History multi-select: run `mode` against every checked file of the
      // selected revision, SERIALLY (parallel svn processes would fight over
      // the working-copy lock). One confirm for the whole batch; a failing
      // file is recorded and the batch continues; the row being worked on
      // stays highlighted via activePath.
      function runMultiRevert(revision, mode, checkedPaths) {
        var modeLabel = { undo: "撤销 r" + revision + " 改动", restore: "回退到修改前", "to-this": "退回到此版本" }[mode] || mode;
        var names = checkedPaths.map(function (p) { return p.split(/[\\/]/).pop(); });
        var listText = names.slice(0, 6).join("\n") + (names.length > 6 ? ("\n…等 " + names.length + " 个文件") : "");
        var riskText = mode === "undo"
          ? "\n\n注：撤销为反向合并，文本文件可能产生冲突、二进制文件可能报冲突。"
          : "\n\n注：覆盖/删除会丢弃这些文件在 r" + revision + " 之后的所有改动与本地未提交修改。";
        if (!window.confirm("对以下 " + names.length + " 个文件执行「" + modeLabel + "」？\n\n" + listText + riskText)) return;
        setBusy(true);
        setErr(null);
        setNotice(null);
        var ok = 0;
        var fails = [];
        var run = async function () {
          for (var i = 0; i < checkedPaths.length; i++) {
            var repoRel = checkedPaths[i];
            var name = names[i];
            setActivePath(repoRel);
            setNotice("正在执行 " + (i + 1) + "/" + checkedPaths.length + "：" + name + "…");
            try {
              await call("history-revert", payload({ repoRel: repoRel, revision: revision, mode: mode }));
              ok++;
            } catch (e) {
              fails.push({ name: name, message: (e && e.message) || String(e) });
            }
          }
        };
        run().then(function () {
          if (fails.length > 0) {
            var sample = fails.slice(0, 3).map(function (f) { return f.name + "：" + f.message; }).join("；");
            setErr("批量「" + modeLabel + "」完成：成功 " + ok + " 个，失败 " + fails.length + " 个。" + sample + (fails.length > 3 ? "…" : ""));
          } else {
            setNotice("批量「" + modeLabel + "」完成：成功 " + ok + " 个文件，请检查后提交");
          }
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setActivePath(null); setChecked({}); setBusy(false); });
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
        setUpdateJob(null);
        pollFails = 0;
        call("update-start", payload()).then(function (v) {
          if (!v.jobId) throw new Error("未获得更新任务");
          pollUpdate(v.jobId);
        }).catch(function (e) {
          setErr(e.message || String(e));
          setBusy(false);
        });
      }

      // Poll the streaming update job; show a live progress bar in the
      // status bar while it runs, then refresh the working-copy state.
      function pollUpdate(jobId) {
        var timer = setInterval(function () {
          call("update-poll", payload({ jobId: jobId })).then(function (j) {
            pollFails = 0;
            setUpdateJob({ running: j.running, processed: j.processed, lines: j.lines || [], elapsedMs: j.elapsedMs || 0 });
            if (!j.running) {
              clearInterval(timer);
              setBusy(false);
              if (j.error) {
                setErr(j.error);
              } else {
                setNotice(j.revision ? "更新完成，当前版本 r" + j.revision : "更新完成");
                loadAll(true);
                if (view === "history") loadHeadInfo();
              }
              setTimeout(function () { setUpdateJob(null); }, 4000);
            }
          }).catch(function () {
            pollFails++;
            if (pollFails > 8) {
              clearInterval(timer);
              setBusy(false);
              setErr("更新进度查询失败（服务器可能已重启），请手动刷新确认状态");
            }
          });
        }, 600);
      }

      function loadLog() {
        setBusy(true);
        setErr(null);
        setPrevRevs({});
        setChecked({});
        call("log", payload({ limit: pageSize, verbose: true, mode: offlineRef.current ? "local" : "remote" })).then(function (v) {
          var entries = v.entries || [];
          setLogs(entries);
          setLogMeta({
            source: v.source || v.mode || "remote",
            offline: v.offline === true,
            localRevision: v.localRevision,
            newestCached: v.newestCached,
            cachedAt: v.cachedAt,
            note: v.note || null,
          });
          // A full first page may have older entries below it: offer the
          // "load more" button. Fewer than one page — or a page that
          // already reaches r1 — means the history is complete.
          var lastE = entries[entries.length - 1];
          setLogMore(entries.length >= pageSize && !!lastE && lastE.revision > 1);
          setView("history");
          loadHeadInfo();
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      // Append the next older page (up to 设置 → 历史每页条数 entries strictly
      // below the oldest revision shown) to the history list; the button
      // disappears once the server reports no more older entries remain.
      function loadMoreLog() {
        if (!logs || logs.length === 0) return;
        var lastLog = logs[logs.length - 1];
        if (!lastLog || !(lastLog.revision > 1)) return;
        setBusy(true);
        setErr(null);
        call("log", payload({ limit: pageSize, verbose: true, mode: offlineRef.current ? "local" : "remote", olderThan: lastLog.revision })).then(function (v) {
          if (v && v.offline === true) {
            setLogMeta(function (old) { return Object.assign({}, old || {}, { source: v.source, offline: true, note: v.note || null }); });
          }
          var next = v.entries || [];
          // Defensive dedupe by revision; the range query below the last
          // shown entry should never overlap the already-loaded list.
          var seen = {};
          logs.forEach(function (e) { seen[e.revision] = true; });
          var fresh = [];
          for (var i = 0; i < next.length; i++) {
            if (!seen[next[i].revision]) { seen[next[i].revision] = true; fresh.push(next[i]); }
          }
          if (fresh.length === 0) { setLogMore(false); return; }
          var last = fresh[fresh.length - 1];
          setLogs(logs.concat(fresh));
          // A short page or reaching r1 both mean the whole history is shown.
          setLogMore(fresh.length >= pageSize && last.revision > 1);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      // Resolve each file's "previous version" (the revision it was last
      // changed before `revision`) so the revert buttons can label the
      // correct target revision; failure just keeps generic labels.
      function loadPrevRevs(revision, paths) {
        call("history-prev-revs", payload({ revision: revision, paths: paths })).then(function (v) {
          var map = {};
          (v.entries || []).forEach(function (e) { map[e.path] = e.prevRev; });
          setPrevRevs(function (old) { return Object.assign({}, old, map); });
        }).catch(function () { /* generic labels */ });
      }

      function selectRev(r) {
        if (openRev === r) {
          setOpenRev(null);
          setChecked({});
          return;
        }
        setOpenRev(r);
        setChecked({});
        var entry = null;
        for (var i = 0; i < (logs || []).length; i++) {
          if (logs[i].revision === r) { entry = logs[i]; break; }
        }
        if (entry && entry.paths && entry.paths.length > 0) {
          loadPrevRevs(r, entry.paths.map(function (p) { return p.path; }));
        }
      }

      // ------------------------------------------------- history multi-check
      function toggleCheck(path) {
        setChecked(function (old) {
          var next = Object.assign({}, old);
          if (next[path]) delete next[path];
          else next[path] = true;
          return next;
        });
      }

      function checkAll(revision) {
        var entry = null;
        for (var i = 0; i < (logs || []).length; i++) {
          if (logs[i].revision === revision) { entry = logs[i]; break; }
        }
        if (!entry || !entry.paths) return;
        var wcSuffix = wcSuffixOf(repo) || "";
        var map = {};
        entry.paths.forEach(function (p) {
          if (p.kind !== "dir" && (wcSuffix === "" || p.path.indexOf(wcSuffix + "/") === 0)) {
            map[p.path] = true;
          }
        });
        setChecked(map);
      }

      function clearChecks() {
        setChecked({});
      }

      // History multi-select: set every path in the marquee group to the same
      // checked value (the operated row's new state) in one shot.
      function bulkCheck(paths, value) {
        setChecked(function (old) {
          var next = Object.assign({}, old || {});
          paths.forEach(function (p) {
            if (value) next[p] = true;
            else delete next[p];
          });
          return next;
        });
      }

      function loadHeadInfo() {
        setHeadLoading(true);
        call("head-info", payload()).then(function (v) {
          setHeadInfo(v);
          // The host answers head-info from local data when the server is
          // unreachable — that is the panel's signal to switch to offline.
          if (v && v.remote === false && !offlineRef.current) enterOffline(v.error);
        }).catch(function (e) {
          // A failed HEAD query must not block the history list; keep the
          // previous value and surface the error in the status bar only when
          // the user explicitly refreshes.
          if (isTransportError(e.message || e)) enterOffline(e.message || String(e));
          setHeadInfo({ headRevision: null, remote: false, error: e.message || String(e) });
        }).finally(function () { setHeadLoading(false); });
      }

      // Switch the working copy to a specific historical revision
      // (`svn update -r <rev>`). Reuses the streaming update job + progress.
      function switchRev(rev) {
        if (!window.confirm("确定将工作副本切换到 r" + rev + "？\n\n" +
          "这会把本地文件更新到该历史版本（svn update -r " + rev + "）。\n" +
          "本地未提交的修改可能受影响，建议先提交或备份。")) return;
        setBusy(true);
        setErr(null);
        setUpdateJob(null);
        pollFails = 0;
        call("update-start", payload({ revision: String(rev) })).then(function (v) {
          if (!v.jobId) throw new Error("未获得更新任务");
          pollUpdate(v.jobId);
        }).catch(function (e) {
          setErr(e.message || String(e));
          setBusy(false);
        });
      }

      function loadLocks() {
        setBusy(true);
        setErr(null);
        call("locks", payload()).then(function (v) {
          setLocks(v.entries);
          setLocksNote(v.offline === true ? (v.note || "离线数据") : null);
          setView("locks");
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runUnlock(path) {
        var name = String(path).split(/[\\/]/).pop();
        if (!window.confirm("确定要解锁该文件？\n\n" + path)) return;
        setBusy(true);
        setErr(null);
        call("unlock", payload({ paths: [path] })).then(function () {
          setNotice("已解锁：" + name + "，等待 svn 提交后生效");
          return loadLocks();
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runCommit() {
        var scope = commitScope();
        if (!commitAll && !scope.paths) {
          setErr("未勾选任何文件：请在列表勾选要提交的文件，或勾回「提交全部变更」");
          return;
        }
        var pl = { message: msg };
        if (scope.paths) pl.paths = scope.paths;
        else if (scope.includeUnversioned === false) pl.includeUnversioned = false;
        setBusy(true);
        setErr(null);
        call("commit", payload(pl)).then(function (v) {
          var extra = "";
          if (v.added && v.added.length > 0) extra += "，自动添加 " + v.added.length + " 个新文件";
          if (v.deleted && v.deleted.length > 0) extra += "，自动删除 " + v.deleted.length + " 个缺失文件";
          // Paths the 提交 settings told the host to leave alone: svn skips them
          // silently, so name them instead of implying the commit covered them.
          if (v.skipped && v.skipped.length > 0) {
            var unv = v.skipped.filter(function (s) { return s.reason === "unversioned"; }).length;
            var miss = v.skipped.length - unv;
            var parts = [];
            if (unv > 0) parts.push(unv + " 个未版本化文件未添加（设置已关闭「提交：自动添加」）");
            if (miss > 0) parts.push(miss + " 个缺失文件未删除（设置已关闭「提交：自动删除」）");
            extra += "；" + parts.join("、");
          }
          setNotice((v.revision ? "提交成功，新版本 r" + v.revision : "提交成功") + extra);
          setMsg("");
          setSel({});
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function generateMsg() {
        var scope = commitScope();
        var pl = {};
        if (scope.paths) pl.paths = scope.paths;
        else if (scope.includeUnversioned === false) pl.includeUnversioned = false;
        setAiBusy(true);
        setErr(null);
        call("generate-message", payload(pl)).then(function (v) {
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

      // Batch delete/revert for the checked files on the 提交 page toolbar.
      // Reuses the same API as the row buttons; the checked set is cleared
      // afterwards so stale selections never leak into the commit scope.
      function runBatchDelete(paths) {
        var names = paths.slice(0, 6).map(shortPath);
        if (!window.confirm("确定要从版本控制中删除以下 " + paths.length + " 个文件？\n\n" +
          names.join("\n") + (paths.length > 6 ? "\n…等 " + paths.length + " 个文件" : ""))) return;
        setBusy(true);
        setErr(null);
        call("delete", payload({ paths: paths })).then(function () {
          setNotice("已删除 " + paths.length + " 个文件（提交后生效）");
          updateCommitAll(true);
          return loadAll(true);
        }).catch(function (e) { setErr(e.message || String(e)); })
          .finally(function () { setBusy(false); });
      }

      function runBatchRevert(paths) {
        var names = paths.slice(0, 6).map(shortPath);
        if (!window.confirm("确定要还原以下 " + paths.length + " 个文件的所有本地修改？\n\n" +
          names.join("\n") + (paths.length > 6 ? "\n…等 " + paths.length + " 个文件" : ""))) return;
        setBusy(true);
        setErr(null);
        call("revert", payload({ paths: paths })).then(function () {
          setNotice("已还原 " + paths.length + " 个文件");
          updateCommitAll(true);
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
        // Entering the history tab starts with the list only: the bottom
        // detail pane appears once a revision is clicked (back from a
        // history diff keeps the selection because it sets view directly).
        if (v === "history") setOpenRev(null);
        if (v === "history" && logs === null) { loadLog(); return; }
        if (v === "history") { loadHeadInfo(); }
        if (v === "locks" && locks === null) { loadLocks(); return; }
        setView(v);
      }

      var cmpDividerDown = function (e) {
        e.preventDefault();
        cmpDragRef.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      var cmpDividerMove = function (e) {
        if (!cmpDragRef.current) return;
        var w = cmpWrapRef.current;
        if (!w) return;
        var rect = w.getBoundingClientRect();
        if (rect.height < 40) return;
        var pct = ((e.clientY - rect.top) / rect.height) * 100;
        setCmpPct(Math.max(30, Math.min(85, pct)));
      };
      var cmpDividerUp = function () { cmpDragRef.current = false; };

      // Paths of every file currently shown in the commit list (unversioned
      // files are hidden when the showUnv option is off).
      function visiblePathsOf() {
        var out = [];
        (entries || []).forEach(function (e) {
          if (showUnv || e.status !== "?") out.push(e.path);
        });
        return out;
      }

      // The effective commit scope shared by 提交 and ✨ AI 生成日志:
      // commit-all (unversioned files excluded when hidden) or the checked
      // paths. Everything outside the scope is neither committed nor analyzed.
      function commitScope() {
        if (commitAll) {
          return { paths: undefined, includeUnversioned: showUnv === false ? false : undefined };
        }
        var selected = Object.keys(sel).filter(function (p) { return sel[p]; });
        return { paths: selected.length > 0 ? selected : undefined, includeUnversioned: undefined };
      }

      // Set `paths` to `value` in the selection. Starting from commit-all
      // (all visible checked) unchecking some paths materializes "all except
      // them". The bottom toggle mirrors the result: the list covering every
      // visible file restores commit-all, any leftover selection keeps the
      // "selected only" mode, and an empty selection disables the submit —
      // it does NOT auto-return to commit-all, otherwise the list checkboxes
      // and the bottom toggle would fight each other.
      function applyRowsChecked(paths, value) {
        if (!paths || paths.length === 0) return;
        var base = {};
        if (commitAll) {
          visiblePathsOf().forEach(function (p) { base[p] = true; });
        } else {
          Object.keys(sel).forEach(function (k) { if (sel[k]) base[k] = true; });
        }
        paths.forEach(function (p) {
          if (value) base[p] = true;
          else delete base[p];
        });
        setSel(base);
        var vis = visiblePathsOf();
        var fullMatch = vis.length > 0;
        vis.forEach(function (p) { if (!base[p]) fullMatch = false; });
        setCommitAll(fullMatch);
      }

      function updateSel(p, v) {
        applyRowsChecked([p], v);
      }

      // bottom "提交全部变更" toggle -> mirror it onto the top list:
      // checked = every visible file checked; unchecked = none checked.
      function updateCommitAll(v) {
        setCommitAll(v);
        if (v) {
          var full = {};
          visiblePathsOf().forEach(function (p) { full[p] = true; });
          setSel(full);
        } else {
          setSel({});
        }
      }

      // Commit-page derived lists: visible entries (unversioned '?' rows are
      // hidden when the showUnv option is off), their per-status summary and
      // the number of hidden unversioned files.
      var listEntries = (entries || []).filter(function (e) { return showUnv || e.status !== "?"; });
      var rawCount = (entries || []).length;
      var hiddenUnvCount = rawCount - listEntries.length;
      var visSummary = {};
      listEntries.forEach(function (e) { visSummary[e.status] = (visSummary[e.status] || 0) + 1; });

      var body;
      if (checkoutMode) {
        body = h(CheckoutView, { busy: busy, onCheckout: runCheckout });
      } else if (view === "blame" && blame) {
        body = h(BlameView, { path: blame.path, entries: blame.entries,
          onBack: function () { setBlame(null); setView("commit"); } });
      } else if (view === "diff" && diff) {
        body = h(DiffView, { path: diff.path, diff: diff.text, sides: diff.sides,
          revision: diff.fromHistory ? diff.revision : (repo ? repo.revision : undefined),
          offlineNote: diff.offlineNote,
          onBack: diff.fromHistory
            ? function () { setView("history"); }
            : function () { setDiff(null); setView("commit"); },
          onBlame: diff.fromHistory ? undefined : function () { showBlame(diff.path); },
          onChoose: diff.fromHistory ? undefined : chooseDiff });
      } else if (view === "history") {
        body = h(HistoryView, { entries: logs || [], openRev: openRev,
          prevRevs: prevRevs,
          checked: checked,
          activePath: activePath,
          wcSuffix: wcSuffixOf(repo),
          localRev: headInfo && headInfo.localRevision !== null && headInfo.localRevision !== undefined
            ? headInfo.localRevision
            : (repo ? repo.revision : undefined),
          localMin: headInfo ? headInfo.localMin : undefined,
          headRev: headInfo ? headInfo.headRevision : undefined,
          headLoading: headLoading,
          busy: busy,
          onSelectRev: selectRev,
          onHideDetail: function () { setOpenRev(null); setChecked({}); },
          onOpenPath: function (revision, repoRel) { showHistoryDiff(repoRel, revision); },
          onRevertFile: revertHistoryFile,
          onToggleCheck: toggleCheck,
          onBulkCheck: bulkCheck,
          onSelectAll: checkAll,
          onClearChecks: clearChecks,
          onMultiAction: function (mode) {
            var paths = Object.keys(checked).filter(function (k) { return checked[k]; });
            if (paths.length > 0) runMultiRevert(openRev, mode, paths);
          },
          onSwitchRev: switchRev,
          onRefreshHead: loadHeadInfo,
          onLoadMore: loadMoreLog,
          pageSize: pageSize,
          meta: logMeta,
          offline: offline,
          more: logMore });
      } else if (view === "locks") {
        body = h(LocksView, { entries: locks || [], onUnlock: runUnlock, note: locksNote });
      } else {
        // merged 变更 + 提交 page: changes list on top, commit form below,
        // with a draggable divider between them.
        body = h("div", { className: "dsh-svn-commitpage", ref: cmpWrapRef },
          h("div", { className: "dsh-svn-commitpage-list", style: { height: cmpPct + "%" } },
            h(ChangesView, { entries: listEntries, rawEntries: entries, rawCount: rawCount,
              summary: visSummary, sel: sel, busy: busy,
              onDiff: showDiff, onToggle: updateSel, onGroupCheck: applyRowsChecked,
              onAdd: runAdd, onRevert: runRevert, onDelete: runDelete, onBlame: showBlame,
              onResolve: setResolvePath, onIgnore: runIgnore,
              onBatchDelete: runBatchDelete, onBatchRevert: runBatchRevert,
              writesOff: writesOff, writeHint: writeHint })),
          h("div", { className: "dsh-svn-histdivider", title: "拖动调整变更列表/提交区域",
            onPointerDown: cmpDividerDown, onPointerMove: cmpDividerMove,
            onPointerUp: cmpDividerUp, onPointerCancel: cmpDividerUp }),
          h("div", { className: "dsh-svn-commitpage-form" },
            h(CommitView, { entries: listEntries, hiddenUnvCount: hiddenUnvCount, showUnv: showUnv,
              sel: sel, msg: msg, busy: busy, commitAll: commitAll,
              aiBusy: aiBusy, onAiGenerate: generateMsg,
              writesOff: writesOff, writeHint: writeHint,
              onMsg: setMsg,
              onCommitAll: updateCommitAll,
              onToggleShowUnv: function (v) { settingsPicked.current = true; setShowUnv(v); },
              onCommit: runCommit }))
        );
      }

      var statusEl;
      if (busy) statusEl = h("span", {}, h("span", { className: "dsh-svn-spin" }), " 正在执行 SVN 操作…");
      else if (err) statusEl = h("span", {}, "⚠ " + err);
      else if (notice) statusEl = h("span", {}, "✓ " + notice);

      // bottom-right live progress while 'svn update' downloads.
      var updEl = updateJob && updateJob.running
        ? h("div", { className: "dsh-svn-updprog", title: (updateJob.lines[updateJob.lines.length - 1] || "") },
            h("div", { className: "dsh-svn-updbar" }, h("i", {})),
            h("span", { className: "dsh-svn-updtext" },
              "更新中 · 已处理 " + updateJob.processed + " 项 · " + Math.round((updateJob.elapsedMs || 0) / 1000) + "s"))
        : null;

      // 在线/离线/只读 banner: an explicit, always-reversible choice. There is
      // deliberately no 「设为默认值 / 永远离线」 option — the offline state
      // lives in this page only, and 「重试」 always probes the server again.
      var banner = null;
      if (offline) {
        banner = h("div", { className: "dsh-svn-banner offline" },
          h("span", { className: "dsh-svn-banner-txt" },
            h("b", {}, "离线模式　"),
            "服务器不可达，历史列表来自本地日志缓存与工作副本修订元数据；这些是不完整的本地数据，可能过时、不完整甚至误导。写操作已禁用。",
            offlineErr ? h("div", { style: { marginTop: 2, opacity: 0.85 } }, "错误：" + offlineErr) : null),
          h("button", { className: "dsh-svn-actbtn primary", disabled: probeBusy, onClick: retryOnline,
            title: "重新连接服务器，成功后自动恢复在线数据" }, probeBusy ? "重试中…" : "重试")
        );
      } else if (readOnly) {
        banner = h("div", { className: "dsh-svn-banner readonly" },
          h("span", { className: "dsh-svn-banner-txt" }, "只读模式：写操作（添加/删除/还原/提交/回退/更新）已禁用；查看、比对、追溯不受影响。"),
          h("button", { className: "dsh-svn-actbtn", onClick: function () { setReadOnlyMode(false); } }, "退出只读")
        );
      }

      return h("div", { className: "dsh-svn" },
        h("div", { className: "dsh-svn-header" },
          svnIcon(16),
          h("span", { className: "dsh-svn-repo", title: repo ? (repo.url || "") : "" },
            repo ? (repo.url || repo.cwd || "SVN 工作副本") : "加载中…"),
          repo && repo.revision ? h("span", { className: "dsh-svn-rev" }, "r" + repo.revision) : null,
          h("span", { className: "dsh-svn-mode " + modeInfo.id, title: modeInfo.text || "在线：正常读写" }, modeInfo.label),
          h("button", { className: "dsh-svn-actbtn", disabled: probeBusy || readOnly,
            onClick: function () { if (offline) retryOnline(); else goOffline(); },
            title: readOnly
              ? "只读模式：请先在顶部横幅点「退出只读」，再决定是否切到离线"
              : (offline
                ? "重试：重新连接服务器，成功后自动恢复在线数据"
                : "离线：仅使用本地数据（历史取自日志缓存 + 工作副本元数据）。可随时重试恢复在线；不提供永久离线。") },
            offline ? (probeBusy ? "重试中…" : "重试") : "离线"),
          readOnly
            ? h("button", { className: "dsh-svn-actbtn", onClick: function () { setReadOnlyMode(false); }, title: "退出只读模式" }, "只读中")
            : h("button", { className: "dsh-svn-actbtn", disabled: offline, onClick: function () { setReadOnlyMode(true); },
                title: offline ? "离线模式下写操作已禁用（等价只读）" : "开启只读：查看不受影响，写操作禁用" }, "只读"),
          h("button", { className: "dsh-svn-actbtn", disabled: busy, onClick: function () { if (view === "locks") loadLocks(); else if (view === "history") loadLog(); else loadAll(false); } }, "刷新")
        ),
        banner,
        h("div", { className: "dsh-svn-toolbar" },
          h("div", { className: "dsh-svn-seg" },
            h("button", { className: "dsh-svn-tabbtn" + ((view === "blame" || view === "commit" || (view === "diff" && diff && !diff.fromHistory)) ? " on" : ""), onClick: function () { settingsPicked.current = true; setView("commit"); } }, "提交"),
            h("button", { className: "dsh-svn-tabbtn" + ((view === "history" || (view === "diff" && diff && diff.fromHistory)) ? " on" : ""), onClick: function () { settingsPicked.current = true; switchView("history"); } }, "历史"),
            h("button", { className: "dsh-svn-tabbtn" + (view === "locks" ? " on" : ""), onClick: function () { settingsPicked.current = true; switchView("locks"); } }, "占用")
          ),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode || writesOff, title: writesOff ? writeHint : "列出 branches 并切换分支",
            onClick: loadBranches }, "分支"),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode || writesOff, title: writesOff ? writeHint : "svn cleanup",
            onClick: runCleanup }, "清理"),
          h("button", { className: "dsh-svn-actbtn", disabled: busy || checkoutMode || writesOff, title: writesOff ? writeHint : "svn update",
            onClick: runUpdate }, "更新")
        ),
        h("div", { className: "dsh-svn-body" }, body),
        h("div", { className: "dsh-svn-statusbar" + (err ? " err" : notice ? " ok" : ""), style: {} }, statusEl || "", updEl),
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
    // Hard dependencies stay minimal. The sidebar carriers (DSH's own right
    // Sidebar and the dsh-better-sidebar plugin), the settings scope and the
    // settings shell are all OPTIONAL: each is reached through `ctx.inject`,
    // which activates its callback only once the service appears — a missing
    // carrier degrades to the other one (or to tools-only) instead of leaving
    // this bundle waiting forever, and a build without the settings surface
    // still renders the panel with the documented defaults.
    var inject = ["slots"];

    /** The store the panel and the card share; null until `apply` runs. */
    var activeSettings = null;
    var activeCarrier = null;
    var fallbackSettings = null;
    function settingsStore() {
      if (activeSettings) return activeSettings;
      if (!fallbackSettings) fallbackSettings = createSettingsStore();
      return fallbackSettings;
    }

    function apply(ctx) {
      var settings = createSettingsStore();
      var carrier = createCarrierStore();
      activeSettings = settings;
      activeCarrier = carrier;

      var availability = { native: false, better: false };
      var nativeHost = null;
      var betterHost = null;
      var current = { kind: null, dispose: null };
      var disposed = false;

      function syncCarrier() {
        if (disposed) return;
        var mode = settings.get("sidebarCarrier");
        var resolved = resolveCarrier(mode, availability);
        carrier.set({
          mode: mode,
          effective: resolved.kind,
          fallback: resolved.fallback,
          availability: { native: availability.native, better: availability.better },
          error: null,
        });
        if (current.kind === resolved.kind) return;
        if (typeof current.dispose === "function") {
          try { current.dispose(); } catch (e) { /* already gone */ }
        }
        current = { kind: resolved.kind, dispose: null };
        try {
          if (resolved.kind === "native") current.dispose = registerNativeCarrier(nativeHost, settings);
          else if (resolved.kind === "better-sidebar") current.dispose = registerBetterSidebarCarrier(betterHost, settings);
        } catch (error) {
          console.error("[dsh-svn-tools] failed to register the '" + resolved.kind + "' sidebar carrier", error);
          carrier.set({ error: (error && error.message) ? error.message : String(error), effective: "off", fallback: true });
          current = { kind: "off", dispose: null };
        }
      }

      ctx.effect(function () {
        ensureStyle();
        return function () {
          disposed = true;
          if (typeof current.dispose === "function") {
            try { current.dispose(); } catch (e) { /* already gone */ }
          }
          current = { kind: null, dispose: null };
          activeSettings = null;
          activeCarrier = null;
          removeStyle();
        };
      }, "dsh-svn-tools: styles and carrier lifetime");

      // DSH's own right Sidebar (0.1.5+): tab type, body, guide entry.
      ctx.inject(["sidebarRight", "sidebarRightTabs"], function (host) {
        nativeHost = host;
        availability.native = true;
        syncCarrier();
        return function () {
          nativeHost = null;
          availability.native = false;
          syncCarrier();
        };
      });

      // dsh-better-sidebar: the pre-0.1.5 carrier, kept for profiles that have it.
      ctx.inject(["betterSidebar"], function (host) {
        betterHost = host;
        availability.better = !!host.betterSidebar;
        syncCarrier();
        return function () {
          betterHost = null;
          availability.better = false;
          syncCarrier();
        };
      });

      // The settings scope both the panel and the card read their values from.
      ctx.inject(["settingsScope"], function (scopeHost) {
        try {
          settings.bindScope(scopeHost.settingsScope);
        } catch (error) {
          console.error("[dsh-svn-tools] settingsScope.bind failed", error);
        }
        // Its presence is also the signal that the settings shell is mounted,
        // so the card is registered on the same edge.
        return ctx.slots.inject("settings.plugin.item", function () {
          return ctx.slots.register({
            name: "settings.plugin.item",
            key: SETTINGS_NS,
            inject: function () { return { svnSettings: settings, svnCarrier: carrier }; },
          }, SvnSettingsCard);
        });
      });

      // Any settings change re-evaluates the carrier (the mode lives there).
      ctx.effect(function () {
        var off = settings.subscribe(syncCarrier);
        syncCarrier();
        return off;
      }, "dsh-svn-tools: sidebar carrier");
    }

    exports.apply = apply;
    exports.inject = inject;
    // Complete the test seam with the values declared below the seam itself.
    if (typeof window === "object" && window !== null && window.__dshSvnToolsTest) {
      window.__dshSvnToolsTest.SETTINGS_NS = SETTINGS_NS;
      window.__dshSvnToolsTest.SETTINGS_DEFAULTS = SETTINGS_DEFAULTS;
      window.__dshSvnToolsTest.pageSizeOf = pageSizeOf;
      window.__dshSvnToolsTest.defaultViewOf = defaultViewOf;
      window.__dshSvnToolsTest.showUnversionedOf = showUnversionedOf;
      window.__dshSvnToolsTest.SvnPanel = SvnPanel;
      window.__dshSvnToolsTest.SvnSettingsCard = SvnSettingsCard;
      window.__dshSvnToolsTest.NativeSvnTab = NativeSvnTab;
      window.__dshSvnToolsTest.settingsStore = settingsStore;
      window.__dshSvnToolsTest.setActiveStores = function (settings, carrier) {
        activeSettings = settings;
        activeCarrier = carrier;
      };
    }
    return module.exports;
  }
});
