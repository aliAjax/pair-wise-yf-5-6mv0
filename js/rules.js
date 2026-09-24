/*
 * rules.js — 充装调度台·业务判定层
 *
 * 职责：气体资质、水压检测、保留/借用排队、自动释放等全部业务规则。
 * 约束：纯函数，不访问 DOM、不访问 localStorage，可直接在 Node 中测试。
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.DiveRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 常量与字典 ---------- */

  var GASES = ['AIR', 'EAN32', 'EAN36', 'O2', 'TRIMIX'];
  var GAS_LABELS = {
    AIR: '压缩空气', EAN32: '高氧32', EAN36: '高氧36',
    O2: '纯氧', TRIMIX: '三混气'
  };

  var CYL_STATUS = {
    IN_STOCK: 'IN_STOCK',   // 在库
    RESERVED: 'RESERVED',   // 出海保留（待领取）
    BORROWED: 'BORROWED',   // 已借出
    INSPECTION: 'INSPECTION' // 检修中
  };
  var STATUS_LABELS = {
    IN_STOCK: '在库', RESERVED: '已保留', BORROWED: '已借出', INSPECTION: '检修中'
  };

  var REQUEST = { RESERVE: 'RESERVE', BORROW: 'BORROW' };
  var REQUEST_LABELS = { RESERVE: '出海保留', BORROW: '普通借用' };

  var HYDRO_CYCLE_YEARS = 5;              // 水压检测周期：5 年
  var RESERVE_CUTOFF_MS = 2 * 60 * 60 * 1000; // 出发前 2 小时未领取即释放

  /* ---------- 时间工具 ---------- */

  // 'YYYY-MM-DD' → 当日 00:00（本地时区）
  function parseDate(s) {
    if (!s) return null;
    var d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  // 'YYYY-MM-DDTHH:mm' → Date（本地时区）
  function parseDateTime(s) {
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // 水压到期日 = 上次检测日 + 5 年
  function hydroDueDate(lastHydroDate) {
    var d = parseDate(lastHydroDate);
    if (!d) return null;
    d.setFullYear(d.getFullYear() + HYDRO_CYCLE_YEARS);
    return d;
  }

  // 超过五年（含到期当天）即判超期
  function isHydroExpired(lastHydroDate, now) {
    var due = hydroDueDate(lastHydroDate);
    return !due || due.getTime() <= now.getTime();
  }

  /* ---------- 资质与气瓶筛选 ---------- */

  // 潜水员只能领取证内气体
  function canDiverUseGas(diver, gas) {
    return !!diver && Array.isArray(diver.certGases) && diver.certGases.indexOf(gas) !== -1;
  }

  // 可立即分配：在库 + 水压合格 + 气体相符
  function isAssignable(cyl, gas, now) {
    return cyl.status === CYL_STATUS.IN_STOCK
      && cyl.gas === gas
      && !isHydroExpired(cyl.lastHydroDate, now);
  }

  // 列表筛选：按气体、工作压力区间（区间端点可留空）
  function filterCylinders(cylinders, opts) {
    opts = opts || {};
    return cylinders.filter(function (c) {
      if (opts.gas && opts.gas !== 'ALL' && c.gas !== opts.gas) return false;
      if (opts.minPressure !== '' && opts.minPressure != null
        && c.workingPressure < Number(opts.minPressure)) return false;
      if (opts.maxPressure !== '' && opts.maxPressure != null
        && c.workingPressure > Number(opts.maxPressure)) return false;
      return true;
    });
  }

  // 列表排序：先按气体，再按瓶号
  function sortCylinders(list) {
    return list.slice().sort(function (a, b) {
      var g = GASES.indexOf(a.gas) - GASES.indexOf(b.gas);
      return g !== 0 ? g : a.code.localeCompare(b.code, 'zh');
    });
  }

  function assignableCandidates(cylinders, gas, now) {
    return sortCylinders(cylinders.filter(function (c) {
      return isAssignable(c, gas, now);
    }));
  }

  /* ---------- 队列与分配 ---------- */

  function genId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function addLog(state, msg, now) {
    state.log.unshift({ id: genId('L'), at: now.getTime(), msg: msg });
    if (state.log.length > 60) state.log.length = 60;
  }

  function diverName(state, diverId) {
    var d = state.divers.filter(function (x) { return x.id === diverId; })[0];
    return d ? d.name : '未知潜水员';
  }

  // 队列优先级：出海保留一律排在普通借用之前；同类按提交时间先到先得
  function sortQueue(queue) {
    queue.sort(function (a, b) {
      if (a.type !== b.type) return a.type === REQUEST.RESERVE ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
  }

  // 排队请求中，排在 r 之前、同气体的保留请求会预先占掉候选瓶。
  // 返回最终可分给 r 的瓶子（尊重 r.cylinderId 的指定）。
  // 队列已按优先级排序，因此排在前面的单天然享有优先权。
  function pickForRequest(cylinders, queue, r, now) {
    var candidates = assignableCandidates(cylinders, r.gas, now);
    var claimed = {};

    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      if (q === r) break; // 只看排在前面的单
      if (q.type !== REQUEST.RESERVE || q.gas !== r.gas) continue;

      var open = candidates.filter(function (c) {
        return !claimed[c.id] && (!q.cylinderId || q.cylinderId === c.id);
      });
      var pick = q.cylinderId
        ? open.filter(function (c) { return c.id === q.cylinderId; })[0]
        : open[0];
      if (pick) claimed[pick.id] = true;
    }

    var pool = candidates.filter(function (c) { return !claimed[c.id]; });
    // 普通借用还要避开「排在自己后面的保留请求」实际占不到——此处 pool 即扣除前面保留后的空闲瓶
    return r.cylinderId
      ? pool.filter(function (c) { return c.id === r.cylinderId; })[0]
      : pool[0];
  }

  function assignCylinder(state, cyl, req, now) {
    cyl.status = req.type === REQUEST.RESERVE ? CYL_STATUS.RESERVED : CYL_STATUS.BORROWED;
    cyl.holder = {
      diverId: req.diverId,
      requestId: req.id,
      since: now.getTime(),
      gas: req.gas,
      type: req.type
    };
    addLog(state,
      (req.type === REQUEST.RESERVE ? '保留' : '借出') +
      '：' + diverName(state, req.diverId) + ' → ' + cyl.code +
      '（' + GAS_LABELS[req.gas] + ' · ' + cyl.workingPressure + ' bar）', now);
  }

  // 反复扫描队列，谁能分到就立即出库；队列按优先级排序，
  // 普通借用即使更早排队也不会越过保留请求
  function serveQueue(state, now) {
    sortQueue(state.requests);
    var progressed = true;
    while (progressed) {
      progressed = false;
      for (var i = 0; i < state.requests.length; i++) {
        var r = state.requests[i];
        var cyl = pickForRequest(state.cylinders, state.requests, r, now);
        if (cyl) {
          state.requests.splice(i, 1);
          assignCylinder(state, cyl, r, now);
          progressed = true;
          break;
        }
      }
    }
  }

  /* ---------- 定时扫描：水压超期 + 保留到期 ---------- */

  // 水压检测超过五年的瓶一律退回检修（即使在保留/借出中也收回）
  function sweepHydro(state, now) {
    state.cylinders.forEach(function (c) {
      if (c.status === CYL_STATUS.INSPECTION) return;
      if (!isHydroExpired(c.lastHydroDate, now)) return;

      if (c.holder && c.holder.type === REQUEST.RESERVE) {
        // 保留中的瓶被收回：原保留请求回到队列排头（保留原下单时间）
        state.requests.push({
          id: c.holder.requestId,
          diverId: c.holder.diverId,
          gas: c.holder.gas,
          type: REQUEST.RESERVE,
          cylinderId: null,
          createdAt: c.holder.since
        });
        sortQueue(state.requests);
        addLog(state, '水压超期：' + c.code + ' 的保留被收回，退回检修', now);
      } else if (c.holder) {
        addLog(state, '水压超期：' + c.code + ' 借出中被收回，退回检修', now);
      } else {
        addLog(state, '水压超期：' + c.code + ' 已退回检修', now);
      }
      c.status = CYL_STATUS.INSPECTION;
      c.holder = null;
    });
  }

  // 出发前 2 小时仍未领取的保留瓶自动释放，随后让普通借用补位
  function sweepExpiredReserves(state, now) {
    var dep = parseDateTime(state.departure);
    if (!dep) return;
    if (now.getTime() < dep.getTime() - RESERVE_CUTOFF_MS) return;

    state.cylinders.forEach(function (c) {
      if (c.status === CYL_STATUS.RESERVED && c.holder
        && c.holder.type === REQUEST.RESERVE) {
        addLog(state, '保留到期：' + c.code + ' 出发前 2 小时未领取，已释放', now);
        c.status = CYL_STATUS.IN_STOCK;
        c.holder = null;
      }
    });
  }

  // 每次操作前先跑一遍全部扫描，再服务队列
  function sweepAll(state, now) {
    sweepHydro(state, now);
    sweepExpiredReserves(state, now);
    serveQueue(state, now);
  }

  /* ---------- 业务操作 ---------- */

  // 新建申领（出海保留 / 普通借用）
  function submitRequest(state, input, now) {
    var diver = state.divers.filter(function (d) { return d.id === input.diverId; })[0];
    if (!diver) throw new Error('请选择潜水员');
    if (GASES.indexOf(input.gas) === -1) throw new Error('气体类型无效');
    if (!canDiverUseGas(diver, input.gas)) {
      throw new Error(diver.name + ' 的证照不含「' + GAS_LABELS[input.gas] + '」，不能申领该气体');
    }
    if (input.type !== REQUEST.RESERVE && input.type !== REQUEST.BORROW) {
      throw new Error('申领类型无效');
    }

    sweepAll(state, now);

    var target = null;
    if (input.cylinderId) {
      target = state.cylinders.filter(function (c) { return c.id === input.cylinderId; })[0];
      if (!target) throw new Error('气瓶不存在');
      if (target.gas !== input.gas) throw new Error('该气瓶气体与申领气体不符');
      if (!isAssignable(target, input.gas, now)) {
        throw new Error(target.code + ' 当前不可用（非在库或水压超期）');
      }
    }

    var req = {
      id: genId('R'),
      diverId: diver.id,
      gas: input.gas,
      type: input.type,
      cylinderId: target ? target.id : null,
      createdAt: now.getTime()
    };

    var cyl = pickForRequest(state.cylinders, state.requests, req, now);
    if (cyl) {
      assignCylinder(state, cyl, req, now);
    } else {
      if (target) throw new Error(target.code + ' 已被更早的保留请求占用');
      state.requests.push(req);
      addLog(state,
        REQUEST_LABELS[req.type] + '排队：' + diver.name + ' 申请「' +
        GAS_LABELS[req.gas] + '」，前方 ' + (state.requests.length - 1) + ' 单', now);
    }
    serveQueue(state, now);
    return req;
  }

  // 保留瓶被领走 → 转为借出
  function pickupReserve(state, cylinderId, now) {
    sweepAll(state, now);
    var c = state.cylinders.filter(function (x) { return x.id === cylinderId; })[0];
    if (!c) throw new Error('气瓶不存在');
    if (c.status !== CYL_STATUS.RESERVED || !c.holder) throw new Error(c.code + ' 不是待领取的保留瓶');
    c.status = CYL_STATUS.BORROWED;
    c.holder.type = REQUEST.BORROW;
    addLog(state, '领取：' + c.code + ' 由 ' + diverName(state, c.holder.diverId) + ' 领走出海', now);
    serveQueue(state, now);
  }

  // 手动释放保留瓶
  function releaseReserve(state, cylinderId, now) {
    var c = state.cylinders.filter(function (x) { return x.id === cylinderId; })[0];
    if (!c) throw new Error('气瓶不存在');
    if (c.status !== CYL_STATUS.RESERVED) throw new Error(c.code + ' 不在保留状态');
    c.status = CYL_STATUS.IN_STOCK;
    c.holder = null;
    addLog(state, '手动释放：' + c.code + ' 已回到在库', now);
    serveQueue(state, now);
  }

  // 归还
  function returnCylinder(state, cylinderId, now) {
    var c = state.cylinders.filter(function (x) { return x.id === cylinderId; })[0];
    if (!c) throw new Error('气瓶不存在');
    if (c.status !== CYL_STATUS.BORROWED) throw new Error(c.code + ' 不在借出状态');
    c.status = CYL_STATUS.IN_STOCK;
    c.holder = null;
    addLog(state, '归还：' + c.code + ' 已回到在库', now);
    sweepAll(state, now); // 归还后可能立即补位队列
  }

  // 检修完成：登记新的水压检测日期，回到在库并尝试补位
  function completeInspection(state, cylinderId, newHydroDate, now) {
    var c = state.cylinders.filter(function (x) { return x.id === cylinderId; })[0];
    if (!c) throw new Error('气瓶不存在');
    if (c.status !== CYL_STATUS.INSPECTION) throw new Error(c.code + ' 不在检修中');
    if (!parseDate(newHydroDate)) throw new Error('请填写有效的水压检测日期');
    if (isHydroExpired(newHydroDate, now)) {
      throw new Error('新检测日期距今已超过 5 年，不能回库');
    }
    c.lastHydroDate = newHydroDate;
    c.status = CYL_STATUS.IN_STOCK;
    c.holder = null;
    addLog(state, '检修完成：' + c.code + ' 水压检测更新为 ' + newHydroDate + '，回到在库', now);
    serveQueue(state, now);
  }

  function cancelRequest(state, requestId, now) {
    var idx = -1;
    for (var i = 0; i < state.requests.length; i++) {
      if (state.requests[i].id === requestId) { idx = i; break; }
    }
    if (idx === -1) throw new Error('队列中没有这单请求');
    var r = state.requests[idx];
    state.requests.splice(idx, 1);
    addLog(state, '取消排队：' + diverName(state, r.diverId) + ' 的「' +
      GAS_LABELS[r.gas] + '」' + REQUEST_LABELS[r.type] + '请求', now);
    serveQueue(state, now); // 撤单可能让后面的普通借用拿到瓶
  }

  function setDeparture(state, iso, now) {
    var d = parseDateTime(iso);
    if (!d) throw new Error('出发时间格式无效');
    state.departure = iso;
    addLog(state, '设置：出海出发时间改为 ' + iso.replace('T', ' '), now);
    sweepAll(state, now);
  }

  /* ---------- 预置数据：四名潜水员、八只气瓶 ---------- */

  function createInitialState(now) {
    now = now || new Date();
    var reservedSince = now.getTime() - 14 * 60 * 60 * 1000;
    return {
      departure: '2026-09-26T08:00', // 周六早 8 点出海
      simNow: null,                  // null = 使用真实时间
      divers: [
        { id: 'D-01', name: '陈海峰', certGases: ['AIR', 'EAN32'] },
        { id: 'D-02', name: '林悦',   certGases: ['AIR', 'EAN32', 'EAN36'] },
        { id: 'D-03', name: '王大涛', certGases: ['AIR'] },
        { id: 'D-04', name: '赵雪',   certGases: ['AIR', 'EAN32', 'EAN36', 'O2', 'TRIMIX'] }
      ],
      cylinders: [
        { id: 'C-01', code: 'C-01', gas: 'AIR',    workingPressure: 200, lastHydroDate: '2023-03-15', status: CYL_STATUS.IN_STOCK, holder: null },
        { id: 'C-02', code: 'C-02', gas: 'AIR',    workingPressure: 200, lastHydroDate: '2020-06-10', status: CYL_STATUS.IN_STOCK, holder: null }, // 已超五年，首扫退回
        { id: 'C-03', code: 'C-03', gas: 'AIR',    workingPressure: 232, lastHydroDate: '2024-09-02', status: CYL_STATUS.IN_STOCK, holder: null },
        { id: 'C-04', code: 'C-04', gas: 'EAN32',  workingPressure: 232, lastHydroDate: '2022-11-20', status: CYL_STATUS.IN_STOCK, holder: null },
        { id: 'C-05', code: 'C-05', gas: 'EAN32',  workingPressure: 200, lastHydroDate: '2025-01-08', status: CYL_STATUS.IN_STOCK, holder: null },
        { id: 'C-06', code: 'C-06', gas: 'EAN36',  workingPressure: 232, lastHydroDate: '2023-07-30', status: CYL_STATUS.IN_STOCK, holder: null },
        { id: 'C-07', code: 'C-07', gas: 'O2',     workingPressure: 200, lastHydroDate: '2019-04-12', status: CYL_STATUS.INSPECTION, holder: null }, // 早已退回检修
        { id: 'C-08', code: 'C-08', gas: 'TRIMIX', workingPressure: 300, lastHydroDate: '2024-05-18',
          status: CYL_STATUS.RESERVED,
          holder: { diverId: 'D-04', requestId: 'R-SEED-08', since: reservedSince, gas: 'TRIMIX', type: 'RESERVE' } }
      ],
      requests: [],
      log: [
        { id: 'L-SEED-1', at: reservedSince, msg: '预置：赵雪 已为周末出海保留 C-08（三混气 · 300 bar）' }
      ]
    };
  }

  return {
    GASES: GASES,
    GAS_LABELS: GAS_LABELS,
    CYL_STATUS: CYL_STATUS,
    STATUS_LABELS: STATUS_LABELS,
    REQUEST: REQUEST,
    REQUEST_LABELS: REQUEST_LABELS,
    HYDRO_CYCLE_YEARS: HYDRO_CYCLE_YEARS,
    RESERVE_CUTOFF_MS: RESERVE_CUTOFF_MS,
    parseDate: parseDate,
    parseDateTime: parseDateTime,
    hydroDueDate: hydroDueDate,
    isHydroExpired: isHydroExpired,
    canDiverUseGas: canDiverUseGas,
    isAssignable: isAssignable,
    filterCylinders: filterCylinders,
    sortCylinders: sortCylinders,
    assignableCandidates: assignableCandidates,
    sweepAll: sweepAll,
    submitRequest: submitRequest,
    pickupReserve: pickupReserve,
    releaseReserve: releaseReserve,
    returnCylinder: returnCylinder,
    completeInspection: completeInspection,
    cancelRequest: cancelRequest,
    setDeparture: setDeparture,
    createInitialState: createInitialState
  };
});
