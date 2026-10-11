/* ============================================================
   app.js · 状态 / 交互 / 事件
   ============================================================ */
(function () {
  'use strict';
  const N = window.NEXUS;
  const ui = N.ui;
  const $ = ui.$;
  const icon = ui.icon;
  const esc = ui.esc;

  const state = { view: 'dash', project: '', tags: [], q: '', sort: 'updated_desc', selected: null };
  let DATA = { assets: [], characters: [], scenes: [], sequences: [], stats: {}, projects: [] };
  let pendingFiles = [];
  let dragDepth = 0;
  let pollTimer = null;
  let LINK_RUNNING = { updream: false, libtv: false };   // 任一链路在线才轮询状态
  let PUBLIC_MODE = false;      // 公用素材库模式：无登录页，所有人共用一套库

  /* ============================================================
     数据
     ============================================================ */
  /* 兼容 fetch 被扩展/脚本劫持的情况：失败时自动回退到 XHR */
  function api(path, opt) {
    opt = opt || {};
    return fetch_(path, opt).catch(function (e) {
      console.warn('[api fetch fallback]', e && e.message);
      return xhr_(path, opt);
    });
  }

  function fetch_(path, opt) {
    var url = path;
    if (url.indexOf('http') !== 0) url = window.location.origin + url;
    return fetch(url, opt).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error('HTTP ' + r.status); });
      return r.json();
    });
  }

  function xhr_(path, opt) {
    return new Promise(function (resolve, reject) {
      var url = path;
      if (url.indexOf('http') !== 0) url = window.location.origin + url;
      var x = new XMLHttpRequest();
      x.open(opt.method || 'GET', url, true);
      x.withCredentials = true;
      var headers = opt.headers || {};
      for (var k in headers) x.setRequestHeader(k, headers[k]);
      x.onload = function () {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { reject(new Error('XHR parse error: ' + e.message)); }
      };
      x.onerror = function () { reject(new Error('XHR failed')); };
      x.ontimeout = function () { reject(new Error('XHR timeout')); };
      x.send(opt.body || null);
    });
  }

  async function load(quiet) {
    try {
      DATA = await api('/api/library');
      if (DATA && DATA.code === 401) {
        if (DATA.gate) { gateOpen(); return; }   // 口令失效 → 重新输入
        ME = null; paintAccount(); authOpen();   // 会话失效 → 回到登录
        return;
      }
      if (DATA && DATA.user) { ME = DATA.user; paintAccount(); }
      render();
      if (!quiet) ui.log('归档库已同步 · ' + DATA.assets.length + ' 项');
      updateUpUI(DATA.collector);
      updateLbUI(DATA.libtv);
    } catch (e) {
      ui.toast('无法连接本地服务', 'err');
      ui.log('本地服务未响应');
    }
  }

  /* ---------- 筛选 ---------- */
  function pred(a) {
    if (state.project && a.project !== state.project) return false;
    if (state.tags.length) {
      const t = a.tags || [];
      if (!state.tags.some(x => t.indexOf(x) > -1)) return false;
    }
    if (state.q) {
      const q = state.q.toLowerCase();
      const hay = [a.title, a.role, a.scene, a.series, a.project, a.prompt, (a.tags || []).join(' ')]
        .join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function filteredAssets() {
    let list = DATA.assets.filter(pred);
    const s = state.sort;
    list.sort((a, b) => {
      if (s === 'title_asc') return String(a.title).localeCompare(String(b.title), 'zh');
      if (s === 'size_desc') return (b.size || 0) - (a.size || 0);
      if (s === 'created_desc') return (b.createdAt || 0) - (a.createdAt || 0);
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
  }

  function filteredGroups() {
    const ch = DATA.characters.map(g => {
      const items = g.items.filter(pred);
      const views = {};
      items.forEach(a => { views[a.view || 'other'] = a; });
      return Object.assign({}, g, { items, views });
    }).filter(g => g.items.length);

    const sc = DATA.scenes.map(g => {
      const items = g.items.filter(pred);
      const stages = {};
      items.forEach(a => { (stages[a.stage || 'other'] = stages[a.stage || 'other'] || []).push(a); });
      return Object.assign({}, g, { items, stages });
    }).filter(g => g.items.length);

    const sq = DATA.sequences.map(g => {
      const shots = g.shots.filter(pred);
      return Object.assign({}, g, { shots });
    }).filter(g => g.shots.length);

    return [ch, sc, sq];
  }

  /* ============================================================
     渲染
     ============================================================ */
  const VIEW_EL = { dash: 'viewDash', cast: 'viewCast', stage: 'viewStage', seq: 'viewSeq', all: 'viewAll' };
  const VIEW_NAME = { dash: '总览看板', cast: '人物三视图', stage: '场景对照', seq: '连续内容', all: '全部产出' };

  function render() {
    ui.renderSidebar(DATA, state);

    const [ch, sc, sq] = filteredGroups();
    const list = filteredAssets();

    Object.keys(VIEW_EL).forEach(k => { $(VIEW_EL[k]).hidden = k !== state.view; });

    if (state.view === 'dash') ui.renderDash(DATA);
    else if (state.view === 'cast') ui.renderCast(ch);
    else if (state.view === 'stage') ui.renderStage(sc);
    else if (state.view === 'seq') ui.renderSeq(sq);
    else ui.renderAll(list);

    const n = state.view === 'cast' ? ch.length : state.view === 'stage' ? sc.length :
      state.view === 'seq' ? sq.reduce((s, g) => s + g.shots.length, 0) :
        state.view === 'dash' ? DATA.assets.length : list.length;
    /* 整个素材库为空（新账户）时，总览页也直接给出引导 */
    $('emptyState').hidden = !(n === 0 && (state.view !== 'dash' || !DATA.assets.length));

    $('crumbMain').textContent = VIEW_NAME[state.view];
    $('crumbSub').textContent = n + ' 项 / 共 ' + DATA.assets.length + ' 项 · ' + ui.bytes(DATA.stats.size || 0);

    /* chips */
    const chips = [];
    if (state.q) chips.push(['q', '检索: ' + state.q]);
    if (state.project) chips.push(['project', state.project]);
    state.tags.forEach(t => chips.push(['tag:' + t, '#' + t]));
    $('activeChips').innerHTML = chips.map(c =>
      '<span class="chip">' + esc(c[1]) + '<button data-chip="' + esc(c[0]) + '">' + icon('i-close') + '</button></span>').join('');

  }

  /* ============================================================
     updream 采集器 UI
     ============================================================ */
  function updateUpUI(c) {
    c = c || {};
    const running = !!c.running;
    $('upDot').className = 'dot' + (running ? ' on' : '');
    $('upState').textContent = running ? 'UPdream 已连接' : 'UPdream 未连接';
    $('upStateText').textContent = running ? '浏览器会话进行中' : '未启动采集器';
    $('upMsg').textContent = c.msg || (running ? '导航到项目后点击采集' : '登录后可一键归档平台产出');
    $('btnUpCapture').disabled = !running;
    $('btnUpStop').disabled = !running;
    const st = $('upStatusText');
    st.textContent = c.msg || (running ? '已连接，可开始采集' : '采集器未启动');
    st.className = 'up-status' + (c.msg && /失败|不可用/.test(c.msg) ? ' err' : running ? ' ok' : '');
    LINK_RUNNING.updream = running;
    syncPoll();
  }
  function syncPoll() {
    const need = LINK_RUNNING.updream || LINK_RUNNING.libtv;
    if (need && !pollTimer) pollTimer = setInterval(pollStatus, 2500);
    if (!need && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollStatus() {
    try {
      const r = await api('/api/collect/status');
      updateUpUI(r.collector);
      updateLbUI(r.libtv);
    } catch (e) { /* ignore */ }
  }

  async function upStart() {
    ui.toast('正在启动浏览器，请在窗口中登录 updream', 'info');
    const r = await api('/api/collect/start', { method: 'POST' });
    updateUpUI({ running: r.ok, msg: r.msg });
    if (!r.ok) ui.toast(r.msg || '采集器启动失败', 'err');
    else ui.log('浏览器已打开 · 等待登录');
  }

  async function upCapture() {
    ui.toast('正在采集当前页面…', 'info');
    const r = await api('/api/collect/capture', { method: 'POST' });
    if (r.ok) {
      ui.toast('已归档 ' + r.added + ' 项产出', 'ok');
      ui.log('采集完成 · +' + r.added);
      await load(true);
    } else {
      ui.toast(r.msg || '采集失败', 'err');
    }
    updateUpUI({ running: true, msg: r.msg });
  }

  async function upStop() {
    await api('/api/collect/stop', { method: 'POST' });
    updateUpUI({ running: false, msg: '已断开' });
    ui.toast('已断开 updream 会话', 'ok');
  }

  /* ============================================================
     LibTV（哩布哩布 AI · liblib.tv）采集器 UI
     ============================================================ */
  function updateLbUI(c) {
    c = c || {};
    const running = !!c.running;
    const el = id => document.getElementById(id);
    if (el('lbStateText')) el('lbStateText').textContent = running ? '浏览器会话进行中' : '未启动采集器';
    if (el('lbMsg')) el('lbMsg').textContent = c.msg || (running ? '打开画布后点击采集' : '哩布哩布 AI 视频平台 · 画布采集');
    ['btnLbCapture', 'btnLbCapture2'].forEach(id => { if (el(id)) el(id).disabled = !running; });
    ['btnLbStop', 'btnLbStop2'].forEach(id => { if (el(id)) el(id).disabled = !running; });
    const st = el('lbStatusText');
    if (st) {
      st.textContent = c.msg || (running ? '已连接，可开始采集' : '采集器未启动');
      st.className = 'up-status' + (c.msg && /失败|不可用/.test(c.msg) ? ' err' : running ? ' ok' : '');
    }
    ['lbStep1', 'lbStep2', 'lbStep3'].forEach(id => {
      if (el(id)) el(id).classList.toggle('on', running);
    });
    LINK_RUNNING.libtv = running;
    syncPoll();
  }

  async function lbStart() {
    ui.toast('正在启动浏览器，请在窗口中登录 LibTV', 'info');
    const r = await api('/api/libtv/start', { method: 'POST' });
    updateLbUI({ running: r.ok, msg: r.msg });
    if (!r.ok) ui.toast(r.msg || '采集器启动失败', 'err');
    else ui.log('LibTV 浏览器已打开 · 等待登录');
  }

  async function lbCapture() {
    ui.toast('正在采集 LibTV 当前页面…', 'info');
    const r = await api('/api/libtv/capture', { method: 'POST' });
    if (r.ok) {
      ui.toast('已归档 ' + r.added + ' 项产出', 'ok');
      ui.log('LibTV 采集完成 · +' + r.added);
      await load(true);
    } else {
      ui.toast(r.msg || '采集失败', 'err');
    }
    updateLbUI({ running: true, msg: r.msg });
  }

  async function lbStop() {
    await api('/api/libtv/stop', { method: 'POST' });
    updateLbUI({ running: false, msg: '已断开' });
    ui.toast('已断开 LibTV 会话', 'ok');
  }

  /* ============================================================
     上传 / 登记 / 扫描
     ============================================================ */
  async function uploadFiles(files) {
    if (!files.length) return;
    const q = $('queue');
    q.innerHTML = '';
    let done = 0;
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'qi';
      row.innerHTML = '<span class="qn">' + esc(f.name) + '</span><span class="qbar"><i style="width:0%"></i></span>' +
        '<span class="qs">' + ui.bytes(f.size) + '</span>';
      q.appendChild(row);
      const bar = row.querySelector('i');
      bar.style.width = '40%';
      const p = new URLSearchParams({
        name: f.name,
        kind: $('upKind').value || '',
        project: $('upProject').value || '',
        role: $('upRole').value || '',
        tags: $('upTags').value || ''
      });
      try {
        await fetch('/api/upload?' + p.toString(), { method: 'POST', body: f });
        bar.style.width = '100%';
        row.classList.add('done');
        row.querySelector('.qs').textContent = '已归档';
        done++;
      } catch (e) {
        row.querySelector('.qs').textContent = '失败';
      }
    }
    ui.toast('已归档 ' + done + ' / ' + files.length + ' 个文件', done ? 'ok' : 'err');
    ui.log('上传完成 · ' + done + ' 项');
    await load(true);
    setTimeout(closeModal, 400);
  }

  async function submitManual() {
    const title = ($('mfTitle').value || '').trim();
    if (!title) { $('mfHint').textContent = '× 请填写标题'; ui.toast('请填写标题', 'err'); return; }
    const kind = $('mfKind').value;
    const sub = $('mfSub').value;
    const body = {
      kind, title,
      view: kind === 'character' ? sub : '',
      stage: kind === 'scene' ? sub : '',
      project: ($('mfProject').value || '').trim(),
      role: kind === 'character' ? ($('mfRole').value || '').trim() : '',
      scene: kind === 'scene' ? ($('mfRole').value || '').trim() : '',
      series: kind === 'sequence' || kind === 'final' ? ($('mfRole').value || '').trim() : '',
      prompt: ($('mfPrompt').value || '').trim(),
      tags: ($('mfTags').value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      source: 'manual'
    };
    await api('/api/assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    ui.toast('已登记 · ' + title, 'ok');
    await load(true);
    closeModal();
  }

  async function submitScan() {
    const dir = ($('scanDir').value || '').trim();
    if (!dir) { $('mfHint').textContent = '× 请填写目录'; ui.toast('请填写目录路径', 'err'); return; }
    const r = await api('/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir })
    });
    if (r.ok) {
      ui.toast('扫描完成 · 新增 ' + r.added + ' 项', 'ok');
      ui.log('目录扫描 · +' + r.added);
      await load(true);
      closeModal();
    } else {
      ui.toast(r.error || '扫描失败', 'err');
    }
  }

  /* ============================================================
     弹窗
     ============================================================ */
  function openModal(tab) {
    $('modal').hidden = false;
    switchTab(tab || 'file');
    $('queue').innerHTML = '';
    $('mfHint').textContent = '就绪';
  }
  function closeModal() { $('modal').hidden = true; }
  function switchTab(tab) {
    Array.from($('modalTabs').children).forEach(b => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
    const PANES = { file: 'paneFile', manual: 'paneManual', scan: 'paneScan', updream: 'paneUpdream', libtv: 'paneLibtv' };
    Object.keys(PANES).forEach(t => { $(PANES[t]).hidden = t !== tab; });
    const label = { file: '确认接入', manual: '登记资产', scan: '开始扫描', updream: '关闭', libtv: '关闭' }[tab];
    $('modalConfirm').querySelector('span').textContent = label;
    $('modalConfirm').style.display = (tab === 'updream' || tab === 'libtv') ? 'none' : '';
  }

  function fillSubOptions() {
    const k = $('mfKind').value;
    const map = k === 'character' ? ui.VIEW_LABEL : k === 'scene' ? ui.STAGE_LABEL : { '': '—' };
    $('mfSub').innerHTML = Object.keys(map).map(v =>
      '<option value="' + v + '">' + map[v] + '</option>').join('');
  }

  /* ============================================================
     抽屉
     ============================================================ */
  function openAsset(id) {
    const a = DATA.assets.find(x => x.id === id);
    if (!a) return;
    state.selected = id;
    ui.renderDrawer(a);
    $('drawer').classList.add('on');
    $('scrim').classList.add('on');
    ui.log('载入档案 · ' + a.title);
  }
  function closeDrawer() {
    $('drawer').classList.remove('on');
    $('scrim').classList.remove('on');
    state.selected = null;
  }

  async function saveDrawer() {
    if (!state.selected) return;
    const kind = $('dwKind').value;
    const subEl = $('dwSub');
    const body = {
      title: ($('dwTitle').value || '').trim(),
      kind,
      view: kind === 'character' ? subEl.value : '',
      stage: kind === 'scene' ? subEl.value : ($('dwSub').value || ''),
      project: ($('dwProject').value || '').trim(),
      tags: ($('dwTags').value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      episode: $('dwEp').value ? Number($('dwEp').value) : null,
      shot: $('dwShot').value ? Number($('dwShot').value) : null
    };
    const roleVal = ($('dwRole').value || '').trim();
    if (kind === 'character') body.role = roleVal;
    else if (kind === 'scene') body.scene = roleVal;
    else body.series = roleVal;

    const r = await api('/api/assets/' + state.selected + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r.ok) {
      ui.toast('档案已更新', 'ok');
      await load(true);
      const a = DATA.assets.find(x => x.id === state.selected);
      if (a) ui.renderDrawer(a);
    }
  }

  async function deleteAsset() {
    const a = DATA.assets.find(x => x.id === state.selected);
    if (!a) return;
    const kk = ui.kindOf(a.kind);
    const ok = await ui.confirmBox({
      title: '删除该产出？',
      text: '条目及其已入库的副本、缩略图将一并移除，无法恢复。' +
        (a.path && !a.file ? '（扫描索引的原始文件不会被删除）' : ''),
      name: a.title,
      meta: kk.name + ' · ' + (a.project || '未归项目') + ' · ' + (ui.hasFile(a) ? ui.bytes(a.size) : '仅记录')
    });
    if (!ok) return;
    await api('/api/assets/' + a.id + '/delete', { method: 'POST' });
    closeDrawer();
    await load(true);
    ui.toast('已删除 · ' + a.title, 'ok');
  }

  async function openFile() {
    const a = DATA.assets.find(x => x.id === state.selected);
    if (!a) return;
    await api('/api/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: a.path || '' })
    });
    if (!a.path) ui.toast('该条目无本地文件路径', 'err');
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bind() {
    const si = $('searchInput');
    si.addEventListener('input', () => {
      state.q = si.value.trim();
      si.parentElement.classList.toggle('active', !!si.value);
      render();
    });
    $('searchClear').addEventListener('click', () => {
      si.value = ''; state.q = ''; si.parentElement.classList.remove('active'); render();
    });

    $('kindNav').addEventListener('click', e => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      state.view = b.getAttribute('data-view'); render();
    });
    $('projNav').addEventListener('click', e => {
      const b = e.target.closest('[data-proj]'); if (!b) return;
      const p = b.getAttribute('data-proj');
      state.project = state.project === p ? '' : p;
      render();
    });
    $('tagCloud').addEventListener('click', e => {
      const b = e.target.closest('[data-tag]'); if (!b) return;
      const t = b.getAttribute('data-tag');
      const i = state.tags.indexOf(t);
      if (i > -1) state.tags.splice(i, 1); else state.tags.push(t);
      render();
    });
    $('activeChips').addEventListener('click', e => {
      const b = e.target.closest('[data-chip]'); if (!b) return;
      const k = b.getAttribute('data-chip');
      if (k === 'q') { state.q = ''; si.value = ''; si.parentElement.classList.remove('active'); }
      else if (k === 'project') state.project = '';
      else if (k.indexOf('tag:') === 0) state.tags = state.tags.filter(t => t !== k.slice(4));
      render();
    });
    $('sortSelect').addEventListener('change', e => { state.sort = e.target.value; render(); });
    $('btnReset').addEventListener('click', () => {
      state.project = ''; state.tags = []; state.q = '';
      si.value = ''; si.parentElement.classList.remove('active');
      render(); ui.toast('筛选条件已重置', 'ok');
    });
    $('btnRefresh').addEventListener('click', () => load());

    /* 内容点击 */
    document.querySelector('.wscontent').addEventListener('click', e => {
      const el = e.target.closest('[data-id]'); if (!el) return;
      openAsset(el.getAttribute('data-id'));
    });

    /* 抽屉 */
    $('dwClose').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('dwSave').addEventListener('click', saveDrawer);
    $('dwDelete').addEventListener('click', deleteAsset);
    $('dwOpenFile').addEventListener('click', openFile);

    /* 弹窗 */
    $('btnIngest').addEventListener('click', () => openModal('file'));
    $('btnEmptyIngest').addEventListener('click', () => openModal('file'));
    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    $('modalTabs').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      switchTab(b.getAttribute('data-tab'));
    });
    $('modalConfirm').addEventListener('click', () => {
      const tab = $('modalTabs').querySelector('.on').getAttribute('data-tab');
      if (tab === 'file') {
        if (!pendingFiles.length) { $('mfHint').textContent = '× 请先选择文件'; ui.toast('请先选择文件', 'err'); return; }
        uploadFiles(pendingFiles);
      } else if (tab === 'manual') submitManual();
      else if (tab === 'scan') submitScan();
    });
    $('dropzone').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', e => {
      pendingFiles = Array.from(e.target.files);
      showQueuePreview();
    });
    $('mfKind').addEventListener('change', fillSubOptions);

    /* updream 采集 */
    $('btnUpStart').addEventListener('click', upStart);
    $('btnUpStart2').addEventListener('click', upStart);
    $('btnUpCapture').addEventListener('click', upCapture);
    $('btnUpCapture2').addEventListener('click', upCapture);
    $('btnUpStop').addEventListener('click', upStop);
    $('btnUpStop2').addEventListener('click', upStop);
    $('btnUpGoto').addEventListener('click', async () => {
      const t = ($('upGotoText').value || '').trim();
      if (!t) { ui.toast('请输入项目名', 'err'); return; }
      ui.toast('正在进入项目「' + t + '」…', 'info');
      const r = await api('/api/collect/goto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t })
      });
      if (r.ok) { ui.toast('已进入 · ' + (r.info.title || r.info.url), 'ok'); ui.log('导航 · ' + r.info.url); }
      else ui.toast(r.msg || '导航失败', 'err');
    });

    /* LibTV 采集 */
    ['btnLbStart', 'btnLbStart2'].forEach(id => { if ($(id)) $(id).addEventListener('click', lbStart); });
    ['btnLbCapture', 'btnLbCapture2'].forEach(id => { if ($(id)) $(id).addEventListener('click', lbCapture); });
    ['btnLbStop', 'btnLbStop2'].forEach(id => { if ($(id)) $(id).addEventListener('click', lbStop); });

    /* 全窗口拖放 */
    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++; $('dropOverlay').classList.add('on');
    });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('dropOverlay').classList.remove('on');
    });
    document.addEventListener('drop', e => {
      dragDepth = 0; $('dropOverlay').classList.remove('on');
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      pendingFiles = Array.from(e.dataTransfer.files);
      openModal('file');
      showQueuePreview();
    });
    const dz = $('dropzone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('over');
      pendingFiles = Array.from(e.dataTransfer.files);
      showQueuePreview();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (!$('modal').hidden) closeModal();
        else if ($('drawer').classList.contains('on')) closeDrawer();
      }
    });
  }

  function showQueuePreview() {
    $('queue').innerHTML = pendingFiles.map(f =>
      '<div class="qi"><span class="qn">' + esc(f.name) + '</span><span class="qs">' + ui.bytes(f.size) + '</span></div>').join('');
    $('mfHint').textContent = '待接入 ' + pendingFiles.length + ' 个文件 · ' +
      ui.bytes(pendingFiles.reduce((s, f) => s + f.size, 0));
  }

  function clock() {
    const el = $('sbClock');
    if (!el) return;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ============================================================
     账户 · 手机号登录（每个号码一套独立素材库）
     ============================================================ */
  let ME = null;
  let ACCOUNTS = [];
  let checkTimer = null;

  function maskPhone(p) {
    p = String(p || '');
    return p.length === 11 ? p.slice(0, 3) + ' **** ' + p.slice(7) : p;
  }

  function avatarOf(u) {
    const t = (u && u.name) || (u && u.phone) || '?';
    return String(t).trim().slice(0, 1).toUpperCase();
  }

  function setHint(txt, cls) {
    const el = $('authHint');
    el.textContent = txt || '';
    el.className = 'auth-hint' + (cls ? ' ' + cls : '');
  }

  function showErr(txt) {
    const el = $('authErr');
    if (!txt) { el.hidden = true; return; }
    el.textContent = txt;
    el.hidden = false;
  }

  function renderRecent() {
    const box = $('authRecent');
    if (!ACCOUNTS.length) { box.hidden = true; return; }
    box.hidden = false;
    $('authRecentN').textContent = ACCOUNTS.length;
    $('authRecentList').innerHTML = ACCOUNTS.map(u =>
      '<button class="ar-item" data-phone="' + esc(u.phone) + '">' +
      '<span class="ar-av">' + esc(avatarOf(u)) + '</span>' +
      '<span class="ar-txt"><span class="ar-name">' + esc(u.name) + '</span>' +
      '<span class="ar-meta">' + esc(maskPhone(u.phone)) + '</span></span>' +
      '<span class="ar-n">' + (u.count || 0) + ' 项</span>' +
      '</button>').join('');
  }

  function authOpen() {
    $('authScreen').hidden = false;
    showErr('');
    setHint('首次输入将自动为你创建一套独立素材库');
    renderRecent();
    setTimeout(function () { try { $('authPhone').focus(); } catch (e) { } }, 80);
  }

  function authClose() { $('authScreen').hidden = true; }

  function paintAccount() {
    const av = $('accAvatar'), nm = $('accName');
    if (!av) return;
    av.textContent = ME ? avatarOf(ME) : '—';
    nm.textContent = ME ? (ME.name || maskPhone(ME.phone)) : '未登录';
    if (ME) {
      $('amPhone').textContent = maskPhone(ME.phone);
      $('amMeta').textContent = (ME.count || 0) + ' 项素材 · ' + ui.bytes(ME.size || 0) + ' · 独立存储空间';
    }
  }

  function closeAccMenu() { const m = $('accMenu'); if (m) m.hidden = true; }

  /* ---------- 访问口令（config.json 里 accessCode 为空则永不出现） ---------- */
  function gateOpen(msg) {
    const s = $('gateScreen');
    if (!s) return false;
    if (msg) { $('gateErr').textContent = msg; $('gateErr').hidden = false; }
    else $('gateErr').hidden = true;
    s.hidden = false;
    setTimeout(function () { try { $('gateInput').focus(); } catch (e) { } }, 80);
    return true;
  }
  function gateClose() { const s = $('gateScreen'); if (s) s.hidden = true; }

  async function gateSubmit(code) {
    try {
      const r = await api('/api/gate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      if (r && r.ok) { gateClose(); return true; }
      const e = $('gateErr');
      e.textContent = (r && r.msg) || '口令不正确';
      e.hidden = false;
      return false;
    } catch (err) {
      const e = $('gateErr');
      e.textContent = '无法连接本地服务：' + (err && err.message ? err.message : '');
      e.hidden = false;
      return false;
    }
  }

  function bindGate() {
    const f = $('gateForm');
    if (!f) return;
    f.addEventListener('submit', async function (e) {
      e.preventDefault();
      const v = ($('gateInput').value || '').trim();
      if (!v) { $('gateErr').textContent = '请输入访问口令'; $('gateErr').hidden = false; return; }
      $('gateGoText').textContent = '验证中…';
      const ok = await gateSubmit(v);
      $('gateGoText').textContent = '进入';
      if (!ok) return;
      $('gateInput').value = '';
      if (await ensureSession()) await load();
    });
  }

  async function ensureSession() {
    try {
      const r = await api('/api/auth/me');
      if (r && r.gate) { gateOpen(); return false; }   // 需要口令
      ACCOUNTS = r.accounts || [];
      PUBLIC_MODE = !!r.publicMode;
      if (r.ok && r.user) {
        ME = r.user;
        authClose();
        paintAccount();
        applyPublicMode();
        return true;
      }
    } catch (e) { /* 服务未响应 */ }
    ME = null;
    paintAccount();
    applyPublicMode();
    authOpen();
    return false;
  }

  /* 公用模式：顶栏账户入口不再可切换，只作为「公用素材库」标识 */
  function applyPublicMode() {
    const chip = $('btnAccount'), menu = $('accMenu');
    if (!PUBLIC_MODE) return;
    if (menu) menu.hidden = true;
    const av = $('accAvatar'), nm = $('accName');
    if (av) av.textContent = '公';
    if (nm) nm.textContent = (ME && ME.name) ? ME.name : '公用素材库';
    const sw = $('accSwitch'), del = $('accDelete'), ph = $('amPhone');
    [sw, del, ph].forEach(el => { if (el) el.hidden = true; });
    if (chip) { chip.title = '公用素材库 · 所有人共用'; chip.style.cursor = 'default'; }
  }

  async function doLogin(phone, name) {
    phone = String(phone || '').replace(/\D/g, '');
    if (phone.length < 4) { showErr('请输入有效的手机号'); return false; }
    $('authGoText').textContent = '正在进入…';
    try {
      const r = await api('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, name: name || '' }),
      });
      if (!r.ok) { showErr(r.msg || '登录失败，请重试'); return false; }
      ME = r.user;
      showErr('');
      authClose();
      paintAccount();
      return true;
    } catch (e) {
      let msg = '无法连接本地服务';
      if (e && e.message) msg += '：' + e.message;
      showErr(msg);
      console.error('[login error]', e);
      return false;
    } finally {
      $('authGoText').textContent = '进入工作台';
    }
  }

  function bindAuth() {
    const form = $('authForm');
    if (!form) return;

    $('authDiagBtn').addEventListener('click', async function () {
      const box = $('authDiag');
      box.hidden = false;
      box.textContent = '正在测试 fetch / XHR / 地址栏直连…';
      const results = [];
      try {
        const r = await fetch_(window.location.origin + '/api/auth/me');
        results.push('fetch: OK, ok=' + r.ok);
      } catch (e) {
        results.push('fetch: FAIL — ' + e.message);
      }
      try {
        const r = await xhr_('/api/auth/me');
        results.push('XHR: OK, ok=' + r.ok);
      } catch (e) {
        results.push('XHR: FAIL — ' + e.message);
      }
      results.push('origin=' + window.location.origin);
      results.push('ua=' + navigator.userAgent.slice(0, 60));
      box.textContent = results.join('\n');
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const ok = await doLogin($('authPhone').value, $('authName').value);
      if (!ok) return;
      await load();
      try {
        const r = await api('/api/auth/me');
        ACCOUNTS = r.accounts || [];
      } catch (e) { }
      ui.toast('已进入 ' + (ME.name || maskPhone(ME.phone)) + ' 的素材库', 'ok');
    });

    $('authPhone').addEventListener('input', function () {
      const v = this.value.replace(/\D/g, '').slice(0, 11);
      if (v !== this.value) this.value = v;
      showErr('');
      clearTimeout(checkTimer);
      if (v.length < 4) { setHint('首次输入将自动为你创建一套独立素材库'); return; }
      checkTimer = setTimeout(async function () {
        try {
          const r = await api('/api/auth/check?phone=' + encodeURIComponent(v));
          if (!r.valid) { setHint('手机号需为 4–20 位数字', ''); return; }
          if (r.exists) setHint('该号码已有素材库（' + (r.info.count || 0) + ' 项），将直接进入', 'ok');
          else setHint('首次使用，将为你创建一套独立素材库', 'new');
        } catch (e) { }
      }, 260);
    });

    $('authRecentList').addEventListener('click', function (e) {
      const b = e.target.closest('[data-phone]');
      if (!b) return;
      $('authPhone').value = b.getAttribute('data-phone');
      $('authName').value = '';
      doLogin(b.getAttribute('data-phone'), '').then(async function (ok) {
        if (!ok) return;
        await load();
        ui.toast('已进入 ' + (ME.name || maskPhone(ME.phone)) + ' 的素材库', 'ok');
      });
    });

    /* 顶栏账户菜单 */
    $('btnAccount').addEventListener('click', function (e) {
      if (PUBLIC_MODE) return;          // 公用模式没有账户可切换
      e.stopPropagation();
      const m = $('accMenu');
      m.hidden = !m.hidden;
      if (!m.hidden) paintAccount();
    });
    document.addEventListener('click', function (e) {
      const m = $('accMenu');
      if (!m || m.hidden) return;
      if (!m.contains(e.target)) m.hidden = true;
    });

    $('accSwitch').addEventListener('click', async function () {
      closeAccMenu();
      try { await api('/api/auth/logout'); } catch (e) { }
      ME = null;
      DATA = { assets: [], characters: [], scenes: [], sequences: [], stats: {}, projects: [] };
      paintAccount();
      try {
        const r = await api('/api/auth/me');
        ACCOUNTS = r.accounts || [];
      } catch (e) { }
      authOpen();
    });

    $('accRename').addEventListener('click', function () {
      const head = document.querySelector('.acc-menu-head');
      if (!head || !ME) return;
      head.innerHTML =
        '<div class="am-row"><input class="am-input" id="amInput" maxlength="24" value="' + esc(ME.name || '') + '" placeholder="昵称">' +
        '<button class="btn btn-primary am-save" id="amSave">保存</button></div>';
      const inp = $('amInput');
      inp.focus(); inp.select();
      const commit = async function () {
        const v = inp.value.trim();
        try {
          const r = await api('/api/auth/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: v }),
          });
          if (r.ok) ME = r.user;
        } catch (e) { }
        head.innerHTML = '<div class="am-phone" id="amPhone"></div><div class="am-meta" id="amMeta"></div>';
        paintAccount();
        closeAccMenu();
        ui.toast('昵称已更新', 'ok');
      };
      $('amSave').addEventListener('click', commit);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { head.innerHTML = '<div class="am-phone" id="amPhone"></div><div class="am-meta" id="amMeta"></div>'; paintAccount(); }
      });
    });

    $('accDelete').addEventListener('click', async function () {
      if (!ME) return;
      closeAccMenu();
      const ok = await ui.confirmBox({
        title: '销毁该账户的素材库？',
        text: '手机号 ' + maskPhone(ME.phone) + ' 下的全部素材、缩略图与文件将被永久删除，无法恢复。其他号码的素材库不受影响。',
        name: ME.name || maskPhone(ME.phone),
        meta: (ME.count || 0) + ' 项 · ' + ui.bytes(ME.size || 0),
      });
      if (!ok) return;
      try {
        const r = await api('/api/auth/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: ME.phone }),
        });
        if (r.ok) { ui.toast('账户已销毁', 'ok'); setTimeout(function () { location.reload(); }, 600); }
        else ui.toast(r.msg || '销毁失败', 'err');
      } catch (e) { ui.toast('销毁失败', 'err'); }
    });
  }

  async function init() {
    bind();
    bindAuth();
    bindGate();
    fillSubOptions();
    if (!(await ensureSession())) {
      clock();
      setInterval(clock, 1000);
      return;
    }
    await load();
    /* 项目名联想 */
    $('projList').innerHTML = DATA.projects.map(p => '<option value="' + esc(p) + '"></option>').join('');
    /* 扫描快捷路径 */
    try {
      const env = await api('/api/env');
      const paths = [env.downloads, env.desktop, env.home].filter(Boolean);
      $('quickPaths').innerHTML = paths.map(p =>
        '<button data-path="' + esc(p) + '">' + esc(p) + '</button>').join('');
      $('quickPaths').addEventListener('click', e => {
        const b = e.target.closest('[data-path]'); if (!b) return;
        $('scanDir').value = b.getAttribute('data-path');
      });
    } catch (e) { /* ignore */ }
    clock();
    setInterval(clock, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
