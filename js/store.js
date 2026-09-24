/*
 * store.js — 充装调度台·存取层
 *
 * 职责：仅负责状态在浏览器 localStorage 的读取 / 写入 / 清除。
 * 不包含任何业务判定；localStorage 不可用时静默降级为内存态。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'dive-dispatch-state-v1';

  function storage() {
    try {
      if (typeof global.localStorage === 'undefined' || !global.localStorage) return null;
      var probe = '__probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return global.localStorage;
    } catch (e) {
      return null; // 隐私模式 / file:// 被策略拦截时降级
    }
  }

  global.DiveStore = {
    // 读取已保存的状态；没有或损坏时返回 null（由页面层负责预置）
    load: function () {
      var s = storage();
      if (!s) return null;
      try {
        var raw = s.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    save: function (state) {
      var s = storage();
      if (!s) return;
      try {
        s.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) { /* 配额满等情况忽略，不影响当次操作 */ }
    },

    // 清除存档，下次加载重新预置四名潜水员与八只气瓶
    reset: function () {
      var s = storage();
      if (s) s.removeItem(STORAGE_KEY);
    }
  };
})(typeof window !== 'undefined' ? window : this);
