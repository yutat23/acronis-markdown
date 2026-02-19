/**
 * ファイル一覧APIのレスポンスをキャッシュ（filename→uuidの逆引き用）
 * ページ読み込み時に /contents 等のレスポンスをdatasetに保存し、
 * content scriptがクリック時に即座にnode IDを取得できるようにする
 */
(function() {
  'use strict';

  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    const urlStr = (typeof url === 'string' ? url : url?.url) || '';
    return origFetch.apply(this, arguments).then(async (res) => {
      if (!urlStr.includes('download')) {
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('json')) {
            const clone = res.clone();
            const json = await clone.json();
            const arr = Array.isArray(json) ? json : (json.items || json.data || json.children || json.results || []);
            if (Array.isArray(arr) && arr.some(x => x && x.uuid && x.name)) {
              const list = {};
              arr.forEach(x => { if (x.uuid && x.name && !x.is_directory) list[x.name] = x.uuid; });
              document.documentElement.dataset.acronisMdList = JSON.stringify(list);
            }
          }
        } catch (_) {}
      }
      return res;
    });
  };
})();
