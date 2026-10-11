/* ============================================================
   ui.js · 渲染层
   ============================================================ */
(function () {
  'use strict';
  const N = (window.NEXUS = window.NEXUS || {});

  const KIND = {
    character: { name: '人物三视图', icon: 'i-user',   color: '#00e5ff' },
    scene:     { name: '场景白模/效果图', icon: 'i-layers', color: '#3d7eff' },
    sequence:  { name: '连续内容',   icon: 'i-film',   color: '#7b6cff' },
    final:     { name: '成片',       icon: 'i-play',   color: '#2ee6c0' },
    script:    { name: '剧本/提示词', icon: 'i-doc',   color: '#8fb6d9' },
    other:     { name: '其他',       icon: 'i-grid',   color: '#5f7793' }
  };
  const VIEW_LABEL = { front: '正面', side: '侧面', back: '背面', three: '三视合图', other: '其他' };
  const STAGE_LABEL = { blockout: '白模', render: '效果图', other: '其他' };
  const SOURCE_LABEL = {
    updream: 'updream', libtv: 'LibTV',
    scan: '目录扫描', upload: '上传', manual: '手动登记'
  };
  const PALETTE = ['#00e5ff', '#3d7eff', '#7b6cff', '#2ee6c0', '#7ef9ff', '#4fb0ff', '#8fb6d9', '#5f7793'];

  const $ = id => document.getElementById(id);
  const icon = (id, cls) => '<svg class="' + (cls || '') + '"><use href="#' + id + '"/></svg>';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
  }
  function ago(ts) {
    const s = (Date.now() - (ts || 0)) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
    return Math.floor(s / 2592000) + ' 个月前';
  }
  function date(ts) {
    const d = new Date(ts || Date.now()), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function kindOf(k) { return KIND[k] || KIND.other; }
  function hasFile(a) { return !!(a.file || a.path); }
  function mediaUrl(a) { return '/media?id=' + a.id; }
  function thumbUrl(a) { return a.thumb ? '/file?p=' + encodeURIComponent(a.thumb) : mediaUrl(a); }

  function mediaTag(a, cls) {
    if (!hasFile(a)) return '';
    const ext = (a.mime || '').indexOf('video') > -1 || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(a.file || a.path || '');
    if (ext) return '<video src="' + mediaUrl(a) + '" muted preload="metadata" class="' + (cls || '') + '"></video>';
    return '<img src="' + thumbUrl(a) + '" alt="" loading="lazy" class="' + (cls || '') + '">';
  }

  function toast(msg, kind) {
    kind = kind || 'info';
    const el = document.createElement('div');
    el.className = 'toast t-' + kind;
    el.innerHTML = icon(kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-close' : 'i-bolt') + '<span>' + esc(msg) + '</span>';
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2800);
  }
  /* 确认弹窗：返回 Promise<boolean> */
  function confirmBox(opt) {
    opt = opt || {};
    const m = $('confirmModal');
    if (!m) return Promise.resolve(window.confirm(opt.text || '确认删除？'));
    $('cfTitle').textContent = opt.title || '确认删除';
    $('cfText').textContent = opt.text || '删除后无法恢复。';
    $('cfName').textContent = opt.name || '';
    $('cfMeta').textContent = opt.meta || '';
    const okBtn = $('cfOk');
    okBtn.querySelector('span').textContent = opt.okText || '删除';
    m.hidden = false;

    return new Promise(resolve => {
      function onScrim(e) { if (e.target === m) finish(false); }
      function onKey(e) {
        if (e.key === 'Escape') finish(false);
        if (e.key === 'Enter') finish(true);
      }
      function cleanup() {
        m.removeEventListener('click', onScrim);
        document.removeEventListener('keydown', onKey);
        $('cfOk').onclick = null; $('cfCancel').onclick = null; $('cfClose').onclick = null;
      }
      function finish(v) { cleanup(); m.hidden = true; resolve(v); }
      m.addEventListener('click', onScrim);
      document.addEventListener('keydown', onKey);
      $('cfOk').onclick = () => finish(true);
      $('cfCancel').onclick = () => finish(false);
      $('cfClose').onclick = () => finish(false);
      okBtn.focus();
    });
  }

  /* 状态提示：状态栏已精简，统一走 toast（保留接口兼容旧调用） */
  function log(m) {
    const el = $('sbLog');
    if (el) el.textContent = m;
  }

  /* ============================================================
     侧栏
     ============================================================ */
  function renderSidebar(d, state) {
    const counts = {};
    d.assets.forEach(a => { counts[a.kind] = (counts[a.kind] || 0) + 1; });
    const navs = [
      ['dash', 'i-chart', '总览看板', d.stats.total, '#00e5ff'],
      ['cast', 'i-user', '人物三视图', d.characters.length, '#00e5ff'],
      ['stage', 'i-layers', '场景白模/效果图', d.scenes.length, '#3d7eff'],
      ['seq', 'i-film', '连续内容', counts.sequence || 0, '#7b6cff'],
      ['all', 'i-grid', '全部产出', d.stats.total, '#8fb6d9']
    ];
    $('kindNav').innerHTML = navs.map(n =>
      '<button class="navi' + (state.view === n[0] ? ' on' : '') + '" data-view="' + n[0] + '">' +
      '<span class="ic" style="color:' + n[4] + '">' + icon(n[1]) + '</span>' +
      '<span class="nm">' + n[2] + '</span><span class="ct">' + n[3] + '</span></button>').join('');

    const pm = {};
    d.assets.forEach(a => { if (a.project) pm[a.project] = (pm[a.project] || 0) + 1; });
    const projs = Object.keys(pm).sort((a, b) => pm[b] - pm[a]);
    $('projNav').innerHTML = projs.length
      ? projs.map(p =>
        '<button class="navi' + (state.project === p ? ' on' : '') + '" data-proj="' + esc(p) + '">' +
        '<span class="ic" style="color:#4fb0ff">' + icon('i-folder') + '</span>' +
        '<span class="nm">' + esc(p) + '</span><span class="ct">' + pm[p] + '</span></button>').join('')
      : '<div style="font-size:11.5px;color:var(--txt-3);padding:0 4px">暂无项目</div>';

    const tm = {};
    d.assets.forEach(a => (a.tags || []).forEach(t => { tm[t] = (tm[t] || 0) + 1; }));
    const tags = Object.keys(tm).sort((a, b) => tm[b] - tm[a]).slice(0, 26);
    $('tagCloud').innerHTML = tags.length
      ? tags.map(t => '<button class="tagc' + (state.tags.indexOf(t) > -1 ? ' on' : '') +
        '" data-tag="' + esc(t) + '">' + esc(t) + '<span class="n">' + tm[t] + '</span></button>').join('')
      : '<div style="font-size:11.5px;color:var(--txt-3)">暂无标签</div>';
  }

  /* ============================================================
     总览看板
     ============================================================ */
  function renderDash(d) {
    const s = d.stats;
    const shotN = (s.byKind.sequence || 0);
    const kpis = [
      { k: '归档总量', v: s.total, u: '项' },
      { k: '人物角色', v: d.characters.length, u: '个' },
      { k: '场景', v: d.scenes.length, u: '个' },
      { k: '连续镜头', v: shotN, u: '个' }
    ];
    let html = '<div class="kpis">' + kpis.map(x =>
      '<div class="kpi"><div class="k">' + x.k + '</div><div class="v">' + x.v +
      (x.u ? '<small>' + x.u + '</small>' : '') + '</div></div>').join('') + '</div>';

    /* 类型分布 + 最近归档 */
    const rows = Object.keys(s.byKind).map(k => ({ k, n: s.byKind[k] })).sort((a, b) => b.n - a.n);
    const maxC = Math.max(1, ...rows.map(r => r.n));
    html += '<div class="panelgrid"><div class="panel"><h4>产出类型</h4>' + rows.map(r => {
      const kk = kindOf(r.k);
      return '<div class="barrow"><span class="bl" style="color:' + kk.color + '">' + icon(kk.icon) +
        '<b style="color:var(--txt-1);font-weight:500">' + kk.name + '</b></span>' +
        '<span class="bartrack"><i style="width:' + (r.n / maxC) * 100 + '%"></i></span>' +
        '<span class="bv">' + r.n + '</span></div>';
    }).join('') + '</div>';

    const recent = d.assets.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
    html += '<div class="panel"><h4>最近归档</h4><div class="recent">' + recent.map(a => {
      const kk = kindOf(a.kind);
      return '<div class="rc" data-id="' + a.id + '"><span class="ic" style="color:' + kk.color + '">' + icon(kk.icon) + '</span>' +
        '<span class="rt"><b>' + esc(a.title) + '</b><i>' + (a.project || '未归项目') + '</i></span>' +
        '<span class="rs">' + ago(a.updatedAt) + '</span></div>';
    }).join('') + '</div></div></div>';

    $('viewDash').innerHTML = html;
  }

  /* ============================================================
     人物三视图对照墙
     ============================================================ */
  function renderCast(groups) {
    const slots = ['front', 'side', 'back'];
    $('viewCast').innerHTML = '<div class="wallgrid">' + groups.map(g => {
      const spare = g.views['three'] || g.views['other'];
      const cells = slots.map(v => {
        const a = g.views[v] || null;
        const item = a || (spare && !g.views[v] && v === 'front' ? spare : null);
        if (!item) return '<div class="viewslot empty"><span>' + VIEW_LABEL[v] + ' · 缺</span></div>';
        return '<div class="viewslot" data-id="' + item.id + '">' + mediaTag(item) +
          '<span class="vl">' + VIEW_LABEL[v] + '</span></div>';
      }).join('');
      const tg = (g.items[0] && g.items[0].tags || []).slice(0, 3);
      return '<article class="rolecard"><div class="rc-head"><div class="nm">' + icon('i-user') + esc(g.role) + '</div>' +
        '<div class="meta">' + esc(g.project || '未归项目') + ' · ' + g.items.length + ' 视图</div></div>' +
        '<div class="views">' + cells + '</div>' +
        '<div class="rolefoot"><span>' + ago(g.updatedAt) + '</span><span class="tags">' +
        tg.map(t => '<span>' + esc(t) + '</span>').join('') + '</span></div></article>';
    }).join('') + '</div>';
  }

  /* ============================================================
     场景白模 / 效果图 对照
     ============================================================ */
  function renderStage(groups) {
    $('viewStage').innerHTML = '<div class="cmpgrid">' + groups.map(g => {
      const bo = (g.stages.blockout || [])[0] || null;
      const rd = (g.stages.render || [])[0] || (g.stages.other || [])[0] || null;
      let body;
      if (bo && rd) {
        body = '<div class="cmp" style="--pos:50%">' +
          '<div class="layer a">' + mediaTag(bo) + '</div>' +
          '<div class="layer b">' + mediaTag(rd) + '</div>' +
          '<div class="handle"></div><input type="range" class="cmp-range" min="0" max="100" value="50">' +
          '<span class="tag l">白模</span><span class="tag r">效果图</span></div>';
      } else {
        const one = bo || rd;
        body = one
          ? '<div class="cmp"><div class="layer a">' + mediaTag(one) + '</div>' +
            '<span class="tag l">' + STAGE_LABEL[one.stage || 'other'] + '</span>' +
            '<div class="none" style="left:auto;right:10px;top:10px;inset:auto;background:none">' +
            '<span style="font-size:9.5px;color:var(--txt-2)">待补充对照图</span></div></div>'
          : '<div class="cmp"><div class="none">暂无素材</div></div>';
      }
      return '<article class="scenecard"><div class="sc-head"><div class="nm">' + icon('i-layers') + esc(g.scene) + '</div>' +
        '<div class="meta">' + esc(g.project || '未归项目') + '</div></div>' + body +
        '<div class="sc-foot"><span>' + ago(g.updatedAt) + '</span><span class="pairs">' +
        '<span>白模 ' + (g.stages.blockout || []).length + '</span><span>效果图 ' + (g.stages.render || []).length + '</span>' +
        '</span></div></article>';
    }).join('') + '</div>';

    /* 对比滑块 */
    $('viewStage').querySelectorAll('.cmp-range').forEach(r => {
      r.addEventListener('input', () => {
        const box = r.closest('.cmp');
        box.style.setProperty('--pos', r.value + '%');
      });
    });
  }

  /* ============================================================
     连续内容
     ============================================================ */
  function renderSeq(groups) {
    if (!groups.length) { $('viewSeq').innerHTML = ''; return; }
    $('viewSeq').innerHTML = groups.map(g => {
      const eps = {};
      g.shots.forEach(a => { const e = a.episode || 0; (eps[e] = eps[e] || []).push(a); });
      const keys = Object.keys(eps).map(Number).sort((a, b) => a - b);
      const blocks = keys.map(e => {
        const shots = eps[e].slice().sort((a, b) => (a.shot || 0) - (b.shot || 0));
        return '<div class="epblock"><div class="ep-tag">' + (e ? ('EP ' + String(e).padStart(2, '0')) : '未分集') +
          ' · ' + shots.length + ' 镜</div><div class="shotstrip">' + shots.map(a =>
            '<article class="shotcard" data-id="' + a.id + '"><div class="th">' +
            (hasFile(a) ? mediaTag(a) : '<div class="big" style="color:var(--line-3)">' + icon(kindOf(a.kind).icon) + '</div>') +
            '<span class="sh">SHOT ' + String(a.shot || 0).padStart(2, '0') + '</span>' +
            (a.version ? '<span class="vb">v' + a.version + '</span>' : '') +
            '</div><div class="sb2"><b>' + esc(a.title) + '</b><i>' + (a.project || '') + '</i></div></article>'
          ).join('') + '</div></div>';
      }).join('');
      return '<section class="seqgroup"><div class="sq-head"><div class="sq-nm">' + icon('i-film') + esc(g.series) + '</div>' +
        '<div class="sq-meta">' + keys.length + ' 集 · ' + g.shots.length + ' 镜 · ' + ago(g.updatedAt) + '</div></div>' +
        blocks + '</section>';
    }).join('');
  }

  /* ============================================================
     全部产出
     ============================================================ */
  function renderAll(assets) {
    $('viewAll').innerHTML = '<div class="assetgrid">' + assets.map(a => {
      const kk = kindOf(a.kind);
      return '<article class="acard" data-id="' + a.id + '"><div class="th">' +
        (hasFile(a) ? mediaTag(a) : '<div class="big" style="color:' + kk.color + '">' + icon(kk.icon) + '</div>') +
        '<span class="kd">' + kk.name + '</span><span class="src">' + (SOURCE_LABEL[a.source] || a.source) + '</span>' +
        '</div><div class="bd"><h4 class="ttl">' + esc(a.title) + '</h4>' +
        '<div class="mt"><span>' + esc(a.project || '未归项目') + '</span><span>' + ago(a.updatedAt) + '</span></div>' +
        '</div></article>';
    }).join('') + '</div>';
  }

  /* ============================================================
     抽屉
     ============================================================ */
  function renderDrawer(a) {
    const kk = kindOf(a.kind);
    $('dwKicker').textContent = kk.name + ' · ' + (SOURCE_LABEL[a.source] || a.source);
    $('dwName').textContent = a.title;

    let prev;
    if (hasFile(a)) {
      const isVid = (a.mime || '').indexOf('video') > -1 || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(a.file || a.path || '');
      prev = '<div class="dw-preview">' + (isVid
        ? '<video src="' + mediaUrl(a) + '" controls preload="metadata"></video>'
        : '<img src="' + mediaUrl(a) + '" alt="">') + '</div>';
    } else {
      prev = '<div class="dw-preview"><div class="big" style="color:' + kk.color + '">' + icon(kk.icon) + '</div></div>';
    }

    const subField = a.kind === 'character'
      ? '<label class="field"><span>视角</span><select id="dwSub" class="sel wide">' +
        Object.keys(VIEW_LABEL).map(v => '<option value="' + v + '"' + (a.view === v ? ' selected' : '') + '>' + VIEW_LABEL[v] + '</option>').join('') +
        '</select></label>'
      : a.kind === 'scene'
        ? '<label class="field"><span>阶段</span><select id="dwSub" class="sel wide">' +
          Object.keys(STAGE_LABEL).map(v => '<option value="' + v + '"' + (a.stage === v ? ' selected' : '') + '>' + STAGE_LABEL[v] + '</option>').join('') +
          '</select></label>'
        : '';

    $('dwBody').innerHTML = prev +
      '<div class="dw-sec"><h5>基础信息</h5>' +
      '<label class="field"><span>标题</span><input id="dwTitle" value="' + esc(a.title) + '"></label>' +
      '<div class="field-row"><label class="field"><span>类型</span><select id="dwKind" class="sel wide">' +
      Object.keys(KIND).map(k => '<option value="' + k + '"' + (a.kind === k ? ' selected' : '') + '>' + KIND[k].name + '</option>').join('') +
      '</select></label>' + (subField || '<label class="field"><span>阶段/视角</span><input id="dwSub" value="' + esc(a.view || a.stage || '') + '"></label>') +
      '</div><div class="field-row">' +
      '<label class="field"><span>项目</span><input id="dwProject" value="' + esc(a.project || '') + '"></label>' +
      '<label class="field"><span>角色/场景/系列</span><input id="dwRole" value="' + esc(a.role || a.scene || a.series || '') + '"></label>' +
      '</div><div class="field-row">' +
      '<label class="field"><span>集</span><input id="dwEp" type="number" value="' + (a.episode || '') + '"></label>' +
      '<label class="field"><span>镜号 / 版本</span><input id="dwShot" type="number" value="' + (a.shot || '') + '"></label>' +
      '</div><label class="field"><span>标签（逗号分隔）</span><input id="dwTags" value="' + esc((a.tags || []).join(', ')) + '"></label></div>' +

      (a.prompt ? '<div class="dw-sec"><h5>提示词 / 文本</h5><div class="promptbox">' + esc(a.prompt) + '</div></div>' : '') +

      '<div class="dw-sec"><h5>元数据</h5><dl class="metagrid">' +
      '<dt>来源</dt><dd>' + (SOURCE_LABEL[a.source] || a.source) + '</dd>' +
      '<dt>体积</dt><dd>' + (hasFile(a) ? bytes(a.size) : '—') + '</dd>' +
      '<dt>归档</dt><dd>' + date(a.createdAt) + '</dd>' +
      (a.path ? '<dt>路径</dt><dd>' + esc(a.path) + '</dd>' : '') +
      '</dl></div>';
  }

  N.ui = {
    $, icon, esc, bytes, ago, date, toast, log, confirmBox, kindOf, hasFile, mediaUrl, thumbUrl,
    renderSidebar, renderDash, renderCast, renderStage, renderSeq, renderAll, renderDrawer,
    KIND, VIEW_LABEL, STAGE_LABEL, SOURCE_LABEL
  };
})();
