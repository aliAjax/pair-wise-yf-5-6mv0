/* rules.js — 业务判定层
 * 纯逻辑：只读取/修改传入的 state，不碰 DOM、不碰 localStorage。
 * 所有判定以模拟当前时间 state.now 为准（演示用，便于演示出发前 2 小时释放）。
 */
(function (global) {
  'use strict';

  var HYDRO_INTERVAL_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 水压检测周期：五年
  var RELEASE_BEFORE_MS = 2 * 60 * 60 * 1000;             // 出发前 2 小时释放保留瓶

  /* ---------- 时间工具（日期粒度） ---------- */

  // 取某日 00:00
  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  // 取某日次日 00:00（不含端点，即"出发前一整天"结束）
  function nextDayStart(d) {
    var x = startOfDay(d);
    x.setDate(x.getDate() + 1);
    return x;
  }

  // 模拟当前时刻（state.now 为 ISO 字符串；缺省退回真实时钟）
  function nowOf(state) {
    return state.now ? new Date(state.now) : new Date();
  }

  // 水压检测到期日 = 检测日 + 5 年
  function hydroDueDate(lastTest) {
    return new Date(new Date(lastTest).getTime() + HYDRO_INTERVAL_MS);
  }

  // 水压检测是否已满五年（含到期当天即算超期 → 退回检修）
  function isHydroExpired(lastTest, now) {
    return hydroDueDate(lastTest).getTime() <= new Date(now).getTime();
  }

  /* ---------- 资质判定 ---------- */

  // 潜水员只能领证内气体
  function canBreathe(diver, gas) {
    return !!diver && diver.gases.indexOf(gas) !== -1;
  }

  /* ---------- 保留时段判定 ---------- */

  // 出海前一天整日 [出发日-1 的 00:00, 出发日的 00:00)
  function holdWindow(departAt) {
    var dep = new Date(departAt);
    var end = startOfDay(dep);
    var start = startOfDay(dep);
    start.setDate(start.getDate() - 1);
    return { start: start, end: end };
  }

  function isInHoldWindow(departAt, now) {
    var w = holdWindow(departAt);
    var t = new Date(now).getTime();
    return t >= w.start.getTime() && t < w.end.getTime();
  }

  // 保留瓶在出发前两小时仍未被领走 → 应释放
  function shouldReleaseHold(departAt, now) {
    return new Date(now).getTime() >= new Date(departAt).getTime() - RELEASE_BEFORE_MS;
  }

  /* ---------- 瓶的可用性 ---------- */

  // 可分配瓶：在库 + 水压未超期
  function isAssignable(tank, now) {
    return tank.status === 'available' && !isHydroExpired(tank.lastTest, now);
  }

  // 瓶是否满足申请：气体一致、工作压力不低于最低要求
  function tankMatches(tank, req) {
    return tank.gas === req.gas && tank.wp >= (req.minWp || 0);
  }

  // 队列排序：保留瓶先于普通借用；同类按申请时间先到先得
  function requestRank(req) {
    return req.type === 'hold' ? 0 : 1;
  }

  function sortQueue(reqs) {
    return reqs.slice().sort(function (a, b) {
      var r = requestRank(a) - requestRank(b);
      if (r !== 0) return r;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }

  function logEvent(state, message) {
    state.log.unshift({
        at: nowOf(state).toISOString(),
        message: message
    });
    if (state.log.length > 60) state.log.length = 60;
  }

  function diverName(state, id) {
    var d = state.divers.filter(function (x) { return x.id === id; })[0];
    return d ? d.name : '（已删除潜水员）';
  }
  function tankLabel(t) {
    return t.serial + '（' + t.gas + ' ' + t.wp + 'bar）';
  }
  function reqLabel(state, req) {
    return diverName(state, req.diverId) + ' 的「' +
      (req.type === 'hold' ? '出海前一天保留' : '普通借用') +
      '·' + req.gas + '」申请';
  }

  /* ---------- 核心：执行调度判定 ---------- */
  // 1) 水压超期瓶退回检修（任何状态下都优先处理）
  // 2) 释放到期未领的保留瓶/保留申请
  // 3) 队列按优先级自动分配在库瓶
  function runDispatch(state) {
    var now = nowOf(state);
    var dep = new Date(state.trip.departAt);

    // 1. 水压检测超过五年的瓶退回检修
    state.tanks.forEach(function (t) {
      if (!isHydroExpired(t.lastTest, now)) return;
      if (t.status === 'inspection') return;
      var old = t.status;
      if (t.assignedTo) {
        var r = state.requests.filter(function (x) { return x.id === t.assignedTo; })[0];
        if (r) {
          r.status = 'queued';
          r.tankId = null;
        }
        t.assignedTo = null;
      }
      t.status = 'inspection';
      logEvent(state, '退回检修：' + tankLabel(t) +
        ' 水压检测已满五年（上次 ' + t.lastTest.slice(0, 10) +
        '，到期 ' + hydroDueDate(t.lastTest).toISOString().slice(0, 10) +
        (old === 'available' ? '' : '，原占用解除并重新排队') + '）');
    });

    // 2. 出发前两小时还没被领走的保留瓶释放
    if (shouldReleaseHold(dep, now)) {
      state.requests.forEach(function (r) {
        if (r.type !== 'hold' || r.status !== 'assigned' || !r.tankId) return;
        var t = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
        r.status = 'released';
        r.tankId = null;
        if (t) {
          t.status = 'available';
          t.assignedTo = null;
        }
        logEvent(state, '释放保留：' + reqLabel(state, r) +
          ' 距出发不足 2 小时仍未领取，气瓶归还可分配池');
      });
    }

    // 3. 队列分配：保留瓶先，普通借用在后；同气体、压力达标、水压有效
    var q = sortQueue(state.requests.filter(function (r) {
      return r.status === 'queued' || r.status === 'assigned';
    }));

    q.forEach(function (r) {
      if (!canBreathe(state.divers.filter(function (d) { return d.id === r.diverId; })[0], r.gas)) {
        if (r.status !== 'rejected') {
          r.status = 'rejected';
          if (r.tankId) {
            var oldT = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
            if (oldT) { oldT.status = 'available'; oldT.assignedTo = null; }
            r.tankId = null;
          }
          logEvent(state, '驳回：' + reqLabel(state, r) + '，该潜水员证内不含此气体');
        }
        return;
      }

      // 已分配的瓶仍挂在本申请名下且水压有效 → 保留占用
      if (r.status === 'assigned' && r.tankId) {
        var cur = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
        if (cur && cur.status === 'assigned' && cur.assignedTo === r.id &&
            !isHydroExpired(cur.lastTest, now)) {
          return;
        }
        // 绑定关系已失效（孤瓶/超期）：解除占用后重新参与分配
        if (cur && cur.assignedTo === r.id) {
          cur.status = 'available';
          cur.assignedTo = null;
        }
        r.tankId = null;
      }

      var t = state.tanks
        .filter(function (x) { return isAssignable(x, now) && tankMatches(x, r); })
        .sort(function (a, b) {
          var p = a.wp - b.wp;
          return p !== 0 ? p : a.serial.localeCompare(b.serial);
        })[0];

      if (t) {
        t.status = 'assigned';
        t.assignedTo = r.id;
        r.tankId = t.id;
        r.status = 'assigned';
        logEvent(state, '分配：' + tankLabel(t) + ' → ' + reqLabel(state, r));
      } else {
        r.status = 'queued';
        r.tankId = null;
      }
    });
  }

  /* ---------- 申请操作 ---------- */

  // 新建申请（类型 hold 只能在出海前一天整日提出）
  function addRequest(state, input) {
    var diver = state.divers.filter(function (d) { return d.id === input.diverId; })[0];
    if (!diver) return { ok: false, error: '请选择潜水员' };
    if (!canBreathe(diver, input.gas)) {
      return { ok: false, error: diver.name + ' 的证内没有 ' + input.gas + '，不能申请' };
    }
    var minWp = parseInt(input.minWp, 10) || 0;
    if (minWp <= 0) return { ok: false, error: '请填写最低工作压力' };

    var now = nowOf(state);
    if (input.type === 'hold' && !isInHoldWindow(state.trip.departAt, now)) {
      return { ok: false, error: '出海前一天整日才能提交保留申请' };
    }

    var req = {
      id: 'r' + Date.now() + Math.floor(Math.random() * 1000),
      diverId: diver.id,
      gas: input.gas,
      minWp: minWp,
      type: input.type === 'hold' ? 'hold' : 'borrow',
      status: 'queued',
      tankId: null,
      createdAt: now.toISOString()
    };
    state.requests.push(req);
    runDispatch(state);
    logEvent(state, '新申请：' + reqLabel(state, req) +
      '（工作压力 ≥ ' + minWp + 'bar）');
    return { ok: true, request: req };
  }

  // 领取：仅已分到瓶且申请未失效
  function pickup(state, reqId) {
    var r = state.requests.filter(function (x) { return x.id === reqId; })[0];
    if (!r || r.status !== 'assigned' || !r.tankId) {
      return { ok: false, error: '该申请当前没有可领取的气瓶' };
    }
    var t = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
    if (!t) return { ok: false, error: '气瓶不存在' };
    if (isHydroExpired(t.lastTest, nowOf(state))) {
      return { ok: false, error: '该瓶水压检测已满五年，正在退回检修' };
    }
    r.status = 'picked';
    t.status = 'out';
    logEvent(state, '领取：' + diverName(state, r.diverId) +
      ' 领走 ' + tankLabel(t));
    return { ok: true };
  }

  // 归还
  function returnTank(state, reqId) {
    var r = state.requests.filter(function (x) { return x.id === reqId; })[0];
    if (!r || !r.tankId) return { ok: false, error: '没有关联气瓶' };
    var t = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
    if (t) {
      t.status = isHydroExpired(t.lastTest, nowOf(state)) ? 'inspection' : 'available';
      t.assignedTo = null;
    }
    r.status = 'returned';
    r.tankId = null;
    logEvent(state, '归还：' + (t ? tankLabel(t) : '气瓶') +
      ' 由 ' + diverName(state, r.diverId) + ' 还回');
    runDispatch(state);
    return { ok: true };
  }

  // 取消申请（未领取前可取消，释放占用瓶）
  function cancelRequest(state, reqId) {
    var r = state.requests.filter(function (x) { return x.id === reqId; })[0];
    if (!r) return { ok: false, error: '申请不存在' };
    if (r.status === 'picked') return { ok: false, error: '已领取的申请请走归还' };
    if (r.tankId) {
      var t = state.tanks.filter(function (x) { return x.id === r.tankId; })[0];
      if (t) { t.status = 'available'; t.assignedTo = null; }
    }
    r.status = 'cancelled';
    r.tankId = null;
    logEvent(state, '取消：' + reqLabel(state, r));
    runDispatch(state);
    return { ok: true };
  }

  global.Rules = {
    HYDRO_INTERVAL_MS: HYDRO_INTERVAL_MS,
    RELEASE_BEFORE_MS: RELEASE_BEFORE_MS,
    nowOf: nowOf,
    startOfDay: startOfDay,
    nextDayStart: nextDayStart,
    hydroDueDate: hydroDueDate,
    isHydroExpired: isHydroExpired,
    canBreathe: canBreathe,
    holdWindow: holdWindow,
    isInHoldWindow: isInHoldWindow,
    shouldReleaseHold: shouldReleaseHold,
    isAssignable: isAssignable,
    tankMatches: tankMatches,
    sortQueue: sortQueue,
    runDispatch: runDispatch,
    addRequest: addRequest,
    pickup: pickup,
    returnTank: returnTank,
    cancelRequest: cancelRequest
  };
})(window);
