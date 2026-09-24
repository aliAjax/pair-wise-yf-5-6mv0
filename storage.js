/* storage.js — 数据存取层
 * 负责：初始预置数据、localStorage 读写、重置。
 * 数据全部留在浏览器，不与任何服务器通信。
 */
(function (global) {
  'use strict';

  var KEY = 'dive-dispatch-v1';

  // 本航次：周六（2026-09-26）08:00 出发
  var TRIP = {
    name: '周末出海 黄岩尖潜点',
    departAt: '2026-09-26T08:00'
  };

  // 四名持证潜水员（gases = 证内可呼吸气体）
  function seedDivers() {
    return [
      { id: 'd1', name: '陈海', cert: 'OW 开放水域', gases: ['AIR'] },
      { id: 'd2', name: '林溪', cert: 'AOW + 高氧空气证', gases: ['AIR', 'EAN32'] },
      { id: 'd3', name: '周潜', cert: '高氧进阶（至 36%）', gases: ['AIR', 'EAN32', 'EAN36'] },
      { id: 'd4', name: '高岩', cert: '三混 / 纯氧减压证', gases: ['AIR', 'EAN32', 'EAN36', 'TRIMIX', 'OXYGEN'] }
    ];
  }

  // 八只气瓶：气体类型 / 工作压力(bar) / 上次水压检测日期 / 状态
  // T02、T04 水压已满五年，调度判定会自动退回检修
  function seedTanks() {
    return [
      { id: 't1', serial: 'T01', gas: 'AIR',    wp: 232, lastTest: '2022-03-10', status: 'available', assignedTo: null },
      { id: 't2', serial: 'T02', gas: 'AIR',    wp: 232, lastTest: '2020-06-01', status: 'available', assignedTo: null },
      { id: 't3', serial: 'T03', gas: 'EAN32',  wp: 232, lastTest: '2023-11-20', status: 'available', assignedTo: null },
      { id: 't4', serial: 'T04', gas: 'EAN32',  wp: 300, lastTest: '2021-08-15', status: 'available', assignedTo: null },
      { id: 't5', serial: 'T05', gas: 'EAN36',  wp: 300, lastTest: '2024-01-05', status: 'available', assignedTo: null },
      { id: 't6', serial: 'T06', gas: 'TRIMIX', wp: 300, lastTest: '2022-09-30', status: 'available', assignedTo: null },
      { id: 't7', serial: 'T07', gas: 'OXYGEN', wp: 200, lastTest: '2025-02-18', status: 'available', assignedTo: null },
      { id: 't8', serial: 'T08', gas: 'AIR',    wp: 300, lastTest: '2024-07-22', status: 'available', assignedTo: null }
    ];
  }

  function seedState() {
    // 默认模拟时钟放在出发前一天（周五）上午，保留窗口已开启
    var state = {
      version: 1,
      trip: { name: TRIP.name, departAt: TRIP.departAt },
      now: '2026-09-25T09:00',
      divers: seedDivers(),
      tanks: seedTanks(),
      requests: [
        {
          // 普通借用更早提出
          id: 'r-seed-borrow',
          diverId: 'd1',
          gas: 'AIR',
          minWp: 200,
          type: 'borrow',
          status: 'queued',
          tankId: null,
          createdAt: '2026-09-25T08:30'
        },
        {
          // 保留申请更晚提出，但排在普通借用之前分配
          id: 'r-seed-hold',
          diverId: 'd2',
          gas: 'AIR',
          minWp: 200,
          type: 'hold',
          status: 'queued',
          tankId: null,
          createdAt: '2026-09-25T08:50'
        }
      ],
      log: []
    };
    // 跑一次判定，让预置队列完成分配、超期瓶退回检修
    global.Rules.runDispatch(state);
    state.log.unshift({
      at: state.now,
      message: '调度台已初始化：4 名潜水员、8 只气瓶（其中 2 只水压超期）'
    });
    return state;
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1) return parsed;
      }
    } catch (e) {
      // 隐私模式 / 存储被禁用：退回内存态
      console.warn('localStorage 不可用，本次数据仅保留在内存中', e);
    }
    var fresh = seedState();
    save(fresh);
    return fresh;
  }

  function save(state) {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('保存失败，数据仅保留在内存中', e);
    }
  }

  function reset() {
    try {
      global.localStorage.removeItem(KEY);
    } catch (e) { /* 忽略 */ }
    var fresh = seedState();
    save(fresh);
    return fresh;
  }

  global.StorageLayer = {
    KEY: KEY,
    load: load,
    save: save,
    reset: reset
  };
})(window);
