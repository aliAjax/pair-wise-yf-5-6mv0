/* app.js — 页面层
 * 只负责渲染与交互；所有业务判定走 Rules，所有持久化走 StorageLayer。
 */
(function () {
  'use strict';

  var state = StorageLayer.load();
  var ui = { gasFilter: 'ALL', wpFilter: 0 };

  var GAS_LABEL = {
    AIR: '空气 AIR',
    EAN32: '高氧 EAN32',
    EAN36: '高氧 EAN36',
    TRIMIX: '三混 Trimix',
    OXYGEN: '纯氧 O₂'
  };

  var TANK_STATUS = {
    available: '在库可分配',
    assigned: '已预占',
    out: '已领出',
    inspection: '退回检修'
  };

  var REQ_STATUS = {
    queued: '排队中',
    assigned: '已分瓶',
    picked: '已领取',
    returned: '已归还',
    cancelled: '已取消',
    released: '保留已释放',
    rejected: '已驳回'
  };

  var TERMINAL = { returned: 1, cancelled: 1, released: 1, rejected: 1 };

  /* ---------- 小工具 ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(iso) {
    if (!iso) return '';
    return iso.replace('T', ' ').slice(0, 16);
  }

  function diverById(id) {
    return state.divers.filter(function (d) { return d.id === id; })[0] || null;
  }
  function tankById(id) {
    return state.tanks.filter(function (t) { return t.id === id; })[0] || null;
  }
  function reqById(id) {
    return state.requests.filter(function (r) { return r.id === id; })[0] || null;
  }

  // 改完状态统一落盘 + 重绘
  function commit() {
    StorageLayer.save(state);
    render();
  }

  /* ---------- 顶部：航次与模拟时钟 ---------- */

  function renderClock() {
    var now = Rules.nowOf(state);
    $('#tripName').textContent = state.trip.name;
    $('#departAt').textContent = fmt(state.trip.departAt);
    $('#nowClock').textContent = fmt(now.toISOString());
    $('#clockInput').value = state.now ? state.now.slice(0, 16) : '';

    var dep = new Date(state.trip.departAt);
    var w = Rules.holdWindow(state.trip.departAt);
    var phase, cls;
    if (Rules.shouldReleaseHold(dep, now)) {
      phase = '距出发不足 2 小时 —— 保留瓶已释放，普通借用可占用';
      cls = 'phase-release';
    } else if (Rules.isInHoldWindow(dep, now)) {
      phase = '保留时段（出海前一天 ' + fmt(w.start.toISOString()) +
        ' 至 ' + fmt(w.end.toISOString()) + '）—— 保留申请优先分配';
      cls = 'phase-hold';
    } else if (now.getTime() < w.start.getTime()) {
      phase = '未到保留时段（出海前一天 00:00 起）—— 仅接受普通借用';
      cls = 'phase-idle';
    } else {
      phase = '保留窗口已关闭';
      cls = 'phase-idle';
    }
    var el = $('#phase');
    el.textContent = phase;
    el.className = 'phase ' + cls;
  }

  /* ---------- 潜水员 ---------- */

  function renderDivers() {
    $('#diverList').innerHTML = state.divers.map(function (d) {
      return '<div class="diver-card">' +
        '<div class="diver-name">' + esc(d.name) + '</div>' +
        '<div class="diver-cert">' + esc(d.cert) + '</div>' +
        '<div class="gas-badges">' + d.gases.map(function (g) {
          return '<span class="badge gas-' + g + '">' + esc(GAS_LABEL[g] || g) + '</span>';
        }).join('') + '</div></div>';
    }).join('');
  }

  /* ---------- 气瓶列表（按气体、压力筛选） ---------- */

  function passFilter(t) {
    if (ui.gasFilter !== 'ALL' && t.gas !== ui.gasFilter) return false;
    if (t.wp < ui.wpFilter) return false;
    return true;
  }

  function renderTanks() {
    var now = Rules.nowOf(state);
    var rows = state.tanks.filter(passFilter).map(function (t) {
      var expired = Rules.isHydroExpired(t.lastTest, now);
      var due = Rules.hydroDueDate(t.lastTest).toISOString().slice(0, 10);
      var holder = t.assignedTo ? reqById(t.assignedTo) : null;
      var holderName = holder ? esc(diverById(holder.diverId).name) : '';
      return '<tr class="tank-row status-' + t.status + '">' +
        '<td class="mono">' + esc(t.serial) + '</td>' +
        '<td><span class="badge gas-' + t.gas + '">' + esc(GAS_LABEL[t.gas] || t.gas) + '</span></td>' +
        '<td class="num">' + t.wp + ' bar</td>' +
        '<td>' + esc(t.lastTest) +
          (expired
            ? ' <span class="badge badge-danger">已满五年</span>'
            : ' <span class="muted">到期 ' + due + '</span>') +
        '</td>' +
        '<td><span class="status-pill st-' + t.status + '">' + TANK_STATUS[t.status] + '</span>' +
          (holderName ? '<div class="muted small">占用：' + holderName + '</div>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    $('#tankBody').innerHTML = rows ||
      '<tr><td colspan="5" class="empty">没有符合筛选条件的气瓶</td></tr>';

    var expiredCount = state.tanks.filter(function (t) {
      return Rules.isHydroExpired(t.lastTest, now);
    }).length;
    $('#tankSummary').textContent =
      '共 ' + state.tanks.length + ' 只气瓶，' +
      state.tanks.filter(function (t) { return passFilter(t); }).length + ' 只符合筛选；' +
      expiredCount + ' 只水压超期已退回检修';
  }

  function renderFilters() {
    var gases = state.tanks.map(function (t) { return t.gas; })
      .filter(function (g, i, arr) { return arr.indexOf(g) === i; });
    $('#gasFilter').innerHTML =
      '<option value="ALL">全部气体</option>' +
      gases.map(function (g) {
        return '<option value="' + g + '"' + (ui.gasFilter === g ? ' selected' : '') + '>' +
          esc(GAS_LABEL[g] || g) + '</option>';
      }).join('');

    var wps = [0, 200, 232, 300];
    $('#wpFilter').innerHTML = wps.map(function (w) {
      return '<option value="' + w + '"' + (ui.wpFilter === w ? ' selected' : '') + '>' +
        (w === 0 ? '全部压力' : '≥ ' + w + ' bar') + '</option>';
    }).join('');
  }

  /* ---------- 申请表单 ---------- */

  function selectedDiver() {
    return diverById($('#fDiver').value);
  }

  // 气体下拉只列出该潜水员证内气体
  function syncGasOptions() {
    var d = selectedDiver();
    var sel = $('#fGas');
    sel.innerHTML = (d ? d.gases : []).map(function (g) {
      return '<option value="' + g + '">' + esc(GAS_LABEL[g] || g) + '</option>';
    }).join('');
    updateHoldHint();
  }

  function updateHoldHint() {
    var type = $('#fType').value;
    var inWindow = Rules.isInHoldWindow(state.trip.departAt, Rules.nowOf(state));
    $('#holdHint').style.display = type === 'hold' ? 'block' : 'none';
    $('#holdHint').textContent = inWindow
      ? '当前在出海前一天的保留时段内，可提交保留申请，分配时排在普通借用之前。'
      : '当前不在保留时段（仅出海前一天整日可提保留申请），提交将被拒绝。';
    $('#holdHint').className = 'hint ' + (inWindow ? 'hint-ok' : 'hint-warn');
  }

  /* ---------- 申请队列 ---------- */

  function renderRequests() {
    var actives = Rules.sortQueue(state.requests.filter(function (r) {
      return !TERMINAL[r.status];
    }));
    var ended = state.requests.filter(function (r) { return TERMINAL[r.status]; })
      .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    $('#requestList').innerHTML = actives.map(requestRow).join('') ||
      '<div class="empty">暂无进行中的申请</div>';
    $('#requestHistory').innerHTML = ended.map(requestRow).join('');
  }

  function requestRow(r) {
    var d = diverById(r.diverId);
    var t = tankById(r.tankId);
    var dead = TERMINAL[r.status];
    var actions = '';
    if (r.status === 'assigned') {
      actions = '<button class="btn btn-primary btn-sm" data-action="pickup" data-id="' + r.id + '">领取</button>' +
                '<button class="btn btn-ghost btn-sm" data-action="cancel" data-id="' + r.id + '">取消</button>';
    } else if (r.status === 'queued') {
      actions = '<button class="btn btn-ghost btn-sm" data-action="cancel" data-id="' + r.id + '">取消</button>';
    } else if (r.status === 'picked') {
      actions = '<button class="btn btn-sm" data-action="return" data-id="' + r.id + '">归还气瓶</button>';
    }

    return '<div class="req-row req-' + r.status + (dead ? ' is-dead' : '') + '">' +
      '<div class="req-main">' +
        '<span class="req-type req-type-' + r.type + '">' +
          (r.type === 'hold' ? '保留瓶' : '普通借用') + '</span>' +
        '<strong>' + esc(d ? d.name : '？') + '</strong>' +
        '<span class="badge gas-' + r.gas + '">' + esc(GAS_LABEL[r.gas] || r.gas) + '</span>' +
        '<span class="muted small">工作压力 ≥ ' + r.minWp + 'bar</span>' +
        (t ? '<span class="matched">分到 ' + esc(t.serial) + '（' + t.wp + 'bar）</span>' : '') +
      '</div>' +
      '<div class="req-side">' +
        '<span class="status-pill rst-' + r.status + '">' + REQ_STATUS[r.status] + '</span>' +
        '<span class="muted small">' + fmt(r.createdAt) + '</span>' +
        actions +
      '</div>' +
    '</div>';
  }

  /* ---------- 调度日志 ---------- */

  function renderLog() {
    $('#logList').innerHTML = state.log.map(function (e) {
      return '<li><span class="log-time mono">' + fmt(e.at) + '</span> ' + esc(e.message) + '</li>';
    }).join('') || '<li class="empty muted">暂无日志</li>';
  }

  /* ---------- 总渲染 ---------- */

  function render() {
    renderClock();
    renderDivers();
    renderTanks();
    renderRequests();
    renderLog();
    updateHoldHint();
  }

  /* ---------- 事件绑定 ---------- */

  function flashError(msg) {
    var el = $('#formError');
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  function bind() {
    renderFilters();

    $('#gasFilter').addEventListener('change', function (e) {
      ui.gasFilter = e.target.value;
      renderTanks();
    });
    $('#wpFilter').addEventListener('change', function (e) {
      ui.wpFilter = parseInt(e.target.value, 10) || 0;
      renderTanks();
    });

    $('#fDiver').addEventListener('change', function () {
      syncGasOptions();
      flashError('');
    });
    $('#fType').addEventListener('change', updateHoldHint);

    $('#requestForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = Rules.addRequest(state, {
        diverId: $('#fDiver').value,
        gas: $('#fGas').value,
        minWp: $('#fMinWp').value,
        type: $('#fType').value
      });
      if (!res.ok) {
        flashError(res.error);
        return;
      }
      flashError('');
      $('#fMinWp').value = '';
      commit();
    });

    // 队列按钮（领取 / 取消 / 归还）
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var res;
      if (btn.dataset.action === 'pickup') res = Rules.pickup(state, id);
      else if (btn.dataset.action === 'return') res = Rules.returnTank(state, id);
      else if (btn.dataset.action === 'cancel') res = Rules.cancelRequest(state, id);
      if (res && !res.ok) alert(res.error);
      if (res && res.ok) commit();
    });

    // 模拟时钟：快捷时刻
    $all('[data-time]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.now = btn.getAttribute('data-time');
        Rules.runDispatch(state);
        commit();
      });
    });

    // 自定义时刻
    $('#clockInput').addEventListener('change', function (e) {
      if (!e.target.value) return;
      state.now = e.target.value;
      Rules.runDispatch(state);
      commit();
    });

    $('#rerunBtn').addEventListener('click', function () {
      Rules.runDispatch(state);
      commit();
    });

    $('#resetBtn').addEventListener('click', function () {
      if (!confirm('恢复预置数据？当前的申请与改动都会清除。')) return;
      state = StorageLayer.reset();
      renderFilters();
      syncGasOptions();
      render();
    });
  }

  /* ---------- 启动 ---------- */

  function init() {
    bind();
    syncGasOptions();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
