/*
 * app.js — 充装调度台·页面层
 *
 * 职责：渲染 DOM、绑定事件、弹窗与提示。
 * 所有判定走 DiveRules，所有持久化走 DiveStore，本文件不重写业务规则。
 */
(function () {
  'use strict';

  var R = window.DiveRules;
  var S = window.DiveStore;

  /* ---------- 状态 ---------- */

  var state = S.load() || R.createInitialState(new Date());
  var filters = { gas: 'ALL', min: '', max: '' };
  var formSel = { diver: state.divers[0] && state.divers[0].id, gas: '', type: 'RESERVE', cyl: '' };
  var modalCtx = null; // { mode, payload }

  // 时间可被「时间与出发设置」中的模拟时间覆盖，方便演示保留到期自动释放
  function now() {
    return state.simNow ? R.parseDateTime(state.simNow) || new Date() : new Date();
  }

  /* ---------- 小工具 ---------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDate(d) {
    if (!d) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fmtDateTime(t) {
    var d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return '—';
    return fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toLocalInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function todayStr() { return fmtDate(now()); }

  function diverById(id) {
    for (var i = 0; i < state.divers.length; i++) {
      if (state.divers[i].id === id) return state.divers[i];
    }
    return null;
  }

  function cylById(id) {
    for (var i = 0; i < state.cylinders.length; i++) {
      if (state.cylinders[i].id === id) return state.cylinders[i];
    }
    return null;
  }

  function gasTag(gas) {
    return '<span class="gas-tag gas-' + gas + '">' + R.GAS_LABELS[gas] + '</span>';
  }

  function holderCell(c) {
    if (!c.holder) return '<span class="holder-name">—</span>';
    var d = diverById(c.holder.diverId);
    var kind = c.holder.type === R.REQUEST.RESERVE ? '保留' : '借用';
    return '<span class="holder-name">' + esc(d ? d.name : '?') + '（' + kind + '）</span>';
  }

  /* ---------- 保存与统一变更入口 ---------- */

  function commit() {
    S.save(state);
    render();
  }

  // 所有写操作包一层：判定层抛错时仅提示，不改动界面
  function mutate(fn) {
    try {
      fn();
      commit();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (kind === 'ok' ? 'ok' : kind === 'info' ? 'info' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3000);
  }

  /* ---------- 渲染：时钟 / 告警 / 统计 ---------- */

  function renderClock() {
    var t = now();
    $('clockNow').textContent = fmtDateTime(t);
    $('simTag').classList.toggle('hidden', !state.simNow);
    var dep = R.parseDateTime(state.departure);
    $('clockDeparture').textContent = dep ? fmtDateTime(dep) : '未设置';

    var note = $('cutoffNote');
    var cd = $('countdown');
    if (!dep) { note.textContent = ''; cd.textContent = ''; return; }

    var diff = dep.getTime() - t.getTime();
    if (diff > 0) {
      var h = Math.floor(diff / 3600000);
      var m = Math.floor((diff % 3600000) / 60000);
      cd.textContent = '距出发 ' + h + ' 小时 ' + m + ' 分';
      if (diff <= R.RESERVE_CUTOFF_MS) {
        note.textContent = '· 已进入释放窗口';
        note.style.color = 'var(--danger)';
      } else {
        var rel = new Date(dep.getTime() - R.RESERVE_CUTOFF_MS);
        note.textContent = '· ' + fmtDateTime(rel) + ' 起未领保留自动释放';
        note.style.color = '';
      }
    } else {
      note.textContent = '';
      cd.textContent = '已过出发时间';
    }
  }

  function renderAlerts() {
    var t = now();
    var lines = [];
    var inspection = state.cylinders.filter(function (c) {
      return c.status === R.CYL_STATUS.INSPECTION;
    });
    if (inspection.length) {
      lines.push('<div class="alert danger">水压检测满 ' + R.HYDRO_CYCLE_YEARS +
        ' 年，已退回检修：' + inspection.map(function (c) {
          return esc(c.code);
        }).join('、') + '。检修登记新检测日后方可回库。</div>');
    }

    var reserved = state.cylinders.filter(function (c) {
      return c.status === R.CYL_STATUS.RESERVED && c.holder
        && c.holder.type === R.REQUEST.RESERVE;
    });
    if (reserved.length) {
      var dep = R.parseDateTime(state.departure);
      var inWindow = dep && t.getTime() >= dep.getTime() - R.RESERVE_CUTOFF_MS;
      var txt = reserved.map(function (c) {
        return esc(c.code) + '（' + esc(diverById(c.holder.diverId).name) + '）';
      }).join('、');
      lines.push(inWindow
        ? '<div class="alert warn">释放窗口已开启：' + txt + ' 出发前 2 小时仍未领取，即刻自动释放给普通借用。</div>'
        : '<div class="alert info">出海保留中：' + txt + '。普通借用排在保留瓶之后。</div>');
    }

    $('alerts').innerHTML = lines.join('');
  }

  function renderStats() {
    var n = function (st) {
      return state.cylinders.filter(function (c) { return c.status === st; }).length;
    };
    var cards = [
      { lbl: '在库可分配', num: n(R.CYL_STATUS.IN_STOCK), cls: 'ok' },
      { lbl: '出海保留', num: n(R.CYL_STATUS.RESERVED), cls: 'accent' },
      { lbl: '已借出', num: n(R.CYL_STATUS.BORROWED), cls: 'warn' },
      { lbl: '退回检修', num: n(R.CYL_STATUS.INSPECTION), cls: 'danger' },
      { lbl: '排队请求', num: state.requests.length, cls: '' }
    ];
    $('stats').innerHTML = cards.map(function (c) {
      return '<div class="stat ' + c.cls + '"><div class="num">' + c.num +
        '</div><div class="lbl">' + c.lbl + '</div></div>';
    }).join('');
  }

  /* ---------- 渲染：气瓶表 ---------- */

  function renderCylinders() {
    var t = now();
    var list = R.sortCylinders(R.filterCylinders(state.cylinders, filters));

    $('queueCount').textContent = state.requests.length;
    $('cylTbody').innerHTML = list.map(function (c) {
      var expired = R.isHydroExpired(c.lastHydroDate, t);
      var due = R.hydroDueDate(c.lastHydroDate);
      var actions = rowActions(c);
      return '<tr class="' + (expired && c.status !== R.CYL_STATUS.INSPECTION ? 'overdue' : '') + '">' +
        '<td><strong>' + esc(c.code) + '</strong></td>' +
        '<td>' + gasTag(c.gas) + '</td>' +
        '<td>' + c.workingPressure + ' bar</td>' +
        '<td class="hydro">' + esc(c.lastHydroDate) + '</td>' +
        '<td class="due">' + fmtDate(due) + (expired ? ' ⚠' : '') + '</td>' +
        '<td><span class="status st-' + c.status + '">' + R.STATUS_LABELS[c.status] + '</span></td>' +
        '<td>' + holderCell(c) + '</td>' +
        '<td class="actions">' + actions + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="8" class="empty">没有符合筛选条件的气瓶</td></tr>';
  }

  function rowActions(c) {
    var b = function (action, label, danger) {
      return '<button type="button" class="btn small' + (danger ? ' danger' : '') +
        '" data-action="' + action + '" data-cyl="' + c.id + '">' + label + '</button>';
    };
    switch (c.status) {
      case R.CYL_STATUS.IN_STOCK:
        return b('prefill', '去申领', false);
      case R.CYL_STATUS.RESERVED:
        return b('pickup', '领走出海', false) + b('release', '释放', true);
      case R.CYL_STATUS.BORROWED:
        return b('return', '归还', false);
      case R.CYL_STATUS.INSPECTION:
        return b('inspect', '检修完成', false);
      default:
        return '';
    }
  }

  /* ---------- 渲染：潜水员 ---------- */

  function renderDivers() {
    $('diverList').innerHTML = state.divers.map(function (d) {
      return '<li>' +
        '<span><span class="diver-name">' + esc(d.name) + '</span>' +
        '<span class="diver-id">' + esc(d.id) + '</span></span>' +
        '<span class="certs">' + d.certGases.map(gasTag).join('') + '</span>' +
      '</li>';
    }).join('');
  }

  /* ---------- 渲染：申领表单（保留用户已选） ---------- */

  function renderForm() {
    var diver = diverById(formSel.diver) || state.divers[0];
    if (diver) formSel.diver = diver.id;
    if (diver.certGases.indexOf(formSel.gas) === -1) formSel.gas = diver.certGases[0];
    if (formSel.type !== R.REQUEST.RESERVE && formSel.type !== R.REQUEST.BORROW) {
      formSel.type = R.REQUEST.RESERVE;
    }

    var diverOpts = state.divers.map(function (d) {
      return '<option value="' + d.id + '"' + (d.id === formSel.diver ? ' selected' : '') +
        '>' + esc(d.name) + '</option>';
    }).join('');
    $('formDiver').innerHTML = diverOpts;

    var gasOpts = diver.certGases.map(function (g) {
      return '<option value="' + g + '"' + (g === formSel.gas ? ' selected' : '') +
        '>' + R.GAS_LABELS[g] + '</option>';
    }).join('');
    $('formGas').innerHTML = gasOpts;

    $('formType').value = formSel.type;

    var t = now();
    var candidates = R.assignableCandidates(state.cylinders, formSel.gas, t);
    var validCyl = formSel.cyl && candidates.some(function (c) { return c.id === formSel.cyl; });
    if (!validCyl) formSel.cyl = '';
    $('formCylinder').innerHTML = '<option value="">自动分配最合适的瓶</option>' +
      candidates.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === formSel.cyl ? ' selected' : '') +
          '>' + esc(c.code) + ' · ' + c.workingPressure + ' bar · 检测 ' +
          esc(c.lastHydroDate) + '</option>';
      }).join('');

    $('formHint').textContent = diver.name + ' 证内气体：' +
      diver.certGases.map(function (g) { return R.GAS_LABELS[g]; }).join('、') +
      '；证外气体无法提交。';
  }

  /* ---------- 渲染：队列 / 日志 ---------- */

  function renderQueue() {
    var el = $('queueList');
    if (!state.requests.length) {
      el.innerHTML = '<li class="empty">暂无排队，气瓶充足。</li>';
      return;
    }
    el.innerHTML = state.requests.map(function (r, i) {
      var d = diverById(r.diverId);
      return '<li>' +
        '<span><span class="pos">' + (i + 1) + '</span>' +
        '<strong>' + esc(d.name) + '</strong> ' + gasTag(r.gas) +
        '<div class="q-meta">' + R.REQUEST_LABELS[r.type] + ' · ' +
        fmtDateTime(r.createdAt) + '</div></span>' +
        '<button type="button" class="btn small danger" data-action="cancel-req" ' +
        'data-req="' + r.id + '">撤单</button>' +
      '</li>';
    }).join('');
  }

  function renderLog() {
    $('logList').innerHTML = state.log.map(function (l) {
      return '<li><span class="t">' + fmtDateTime(l.at) + '</span>' + esc(l.msg) + '</li>';
    }).join('');
  }

  /* ---------- 总渲染 ---------- */

  function render() {
    renderClock();
    renderAlerts();
    renderStats();
    renderCylinders();
    renderDivers();
    renderForm();
    renderQueue();
    renderLog();
    $('filterGas').value = filters.gas;
    $('filterMin').value = filters.min;
    $('filterMax').value = filters.max;
  }

  /* ---------- 弹窗 ---------- */

  function openModal(title, bodyHtml, onOk) {
    modalCtx = { onOk: onOk };
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalMask').classList.remove('hidden');
    var first = $('modalBody').querySelector('input,select,button');
    if (first) first.focus();
  }

  function closeModal() {
    modalCtx = null;
    $('modalMask').classList.add('hidden');
  }

  function confirmBox(title, msg, onOk) {
    openModal(title, '<p style="margin:0;color:var(--text)">' + esc(msg) + '</p>', onOk);
  }

  function openSettings() {
    var body =
      '<label>出海出发时间' +
        '<input type="datetime-local" id="setDeparture" value="' + esc(state.departure) + '" />' +
      '</label>' +
      '<label>模拟当前时间（留空 = 使用真实系统时间）' +
        '<input type="datetime-local" id="setSimNow" value="' + esc(state.simNow || '') + '" />' +
      '</label>' +
      '<p class="hint" style="margin:0;color:var(--muted);font-size:12px">' +
      '演示用：把模拟时间拨到出发前 2 小时内，可看到未领取的保留瓶被自动释放、普通借用补位。</p>';
    openModal('时间与出发设置', body, function () {
      var depVal = $('setDeparture').value;
      var simVal = $('setSimNow').value;
      mutate(function () {
        state.simNow = simVal || null;
        R.setDeparture(state, depVal, now());
        toast('设置已保存', 'ok');
      });
    });
  }

  function openInspection(c) {
    var body =
      '<p style="margin:0">气瓶 <strong>' + esc(c.code) + '</strong>' + gasTag(c.gas) +
      ' ' + c.workingPressure + ' bar，登记本次水压检测日期后回到在库。</p>' +
      '<label>新水压检测日期<input type="date" id="setHydro" value="' + todayStr() + '" /></label>';
    openModal('检修完成登记', body, function () {
      var v = $('setHydro').value;
      mutate(function () {
        R.completeInspection(state, c.id, v, now());
        toast(c.code + ' 已完成检修并回库', 'ok');
      });
    });
  }

  /* ---------- 事件 ---------- */

  function bindEvents() {
    // 气瓶表 / 队列 / 顶栏按钮统一委托
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;

      if (action === 'open-settings') return openSettings();
      if (action === 'reset-all') {
        return confirmBox('恢复预置数据', '将清除本浏览器中的全部台账、排队与日志，恢复为初始的四名潜水员和八只气瓶。确定？',
          function () {
            state = R.createInitialState(new Date());
            state.simNow = null;
            R.sweepAll(state, now());
            S.save(state);
            filters = { gas: 'ALL', min: '', max: '' };
            formSel = { diver: state.divers[0].id, gas: '', type: 'RESERVE', cyl: '' };
            closeModal();
            commit();
            toast('已恢复预置数据', 'ok');
          });
      }

      var c = btn.dataset.cyl ? cylById(btn.dataset.cyl) : null;
      if (action === 'prefill' && c) {
        formSel.diver = formSel.diver || state.divers[0].id;
        formSel.gas = c.gas;
        formSel.cyl = c.id;
        renderForm();
        document.getElementById('requestForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return toast('已把 ' + c.code + '（' + R.GAS_LABELS[c.gas] + '）填入申领单', 'info');
      }
      if (action === 'pickup' && c) {
        return mutate(function () {
          R.pickupReserve(state, c.id, now());
          toast(c.code + ' 已领走出海', 'ok');
        });
      }
      if (action === 'release' && c) {
        return confirmBox('释放保留瓶', '确定提前释放 ' + c.code + '？释放后普通借用可立即使用该瓶。', function () {
          mutate(function () {
            R.releaseReserve(state, c.id, now());
            closeModal();
            toast(c.code + ' 已释放', 'ok');
          });
        });
      }
      if (action === 'return' && c) {
        return mutate(function () {
          R.returnCylinder(state, c.id, now());
          toast(c.code + ' 已归还', 'ok');
        });
      }
      if (action === 'inspect' && c) return openInspection(c);

      if (action === 'cancel-req') {
        var rid = btn.dataset.req;
        return mutate(function () {
          R.cancelRequest(state, rid, now());
          toast('排队请求已撤销', 'ok');
        });
      }
    });

    // 申领表单
    $('formDiver').addEventListener('change', function () {
      formSel.diver = this.value;
      formSel.gas = '';
      formSel.cyl = '';
      renderForm();
    });
    $('formGas').addEventListener('change', function () {
      formSel.gas = this.value;
      formSel.cyl = '';
      renderForm();
    });
    $('formType').addEventListener('change', function () { formSel.type = this.value; });
    $('formCylinder').addEventListener('change', function () { formSel.cyl = this.value; });

    $('requestForm').addEventListener('submit', function (e) {
      e.preventDefault();
      mutate(function () {
        R.submitRequest(state, {
          diverId: formSel.diver,
          type: formSel.type,
          gas: formSel.gas,
          cylinderId: formSel.cyl || null
        }, now());
        formSel.cyl = '';
        toast('申领已提交', 'ok');
      });
    });

    // 列表筛选：气体 + 工作压力区间
    $('filterGas').addEventListener('change', function () { filters.gas = this.value; renderCylinders(); });
    $('filterMin').addEventListener('input', function () { filters.min = this.value; renderCylinders(); });
    $('filterMax').addEventListener('input', function () { filters.max = this.value; renderCylinders(); });
    $('filterClear').addEventListener('click', function () {
      filters = { gas: 'ALL', min: '', max: '' };
      render();
    });

    // 弹窗
    $('modalCancel').addEventListener('click', closeModal);
    $('modalMask').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    $('modalOk').addEventListener('click', function () {
      if (modalCtx && modalCtx.onOk) modalCtx.onOk();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modalMask').classList.contains('hidden')) closeModal();
    });
  }

  // 筛选区气体下拉（一次性）
  function initFilterGas() {
    $('filterGas').innerHTML = '<option value="ALL">全部气体</option>' +
      R.GASES.map(function (g) {
        return '<option value="' + g + '">' + R.GAS_LABELS[g] + '（' + g + '）</option>';
      }).join('');
  }

  /* ---------- 启动 ---------- */

  // 打开页面先跑一次定时判定（首装时 C-02 即被退回检修）
  R.sweepAll(state, now());
  S.save(state);
  initFilterGas();
  bindEvents();
  render();

  // 每 30 秒检查水压超期与保留到期；弹窗打开时不重绘以免打断输入
  setInterval(function () {
    R.sweepAll(state, now());
    S.save(state);
    if ($('modalMask').classList.contains('hidden')) render();
  }, 30000);
})();
