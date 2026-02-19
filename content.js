/**
 * acronis-markdown - Content Script
 *
 * マークダウンファイルのクリックをインターセプトし、
 * ダウンロードの代わりにプレビュー/raw表示を行う
 */

(function() {
  'use strict';

  const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|mdwn)$/i;
  const DOWNLOAD_URL_PATTERN = /sync_and_share_nodes\/[a-f0-9-]+\/download/i;

  function isMarkdownByFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    return MARKDOWN_EXTENSIONS.test(filename.trim());
  }

  function isMarkdownByHeaders(response) {
    const contentType = response.headers.get('content-type') || '';
    const contentDisposition = response.headers.get('content-disposition') || '';
    if (contentType.includes('text/markdown')) return true;
    const match = contentDisposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    return match ? isMarkdownByFilename(match[1]) : false;
  }

  function looksLikeMarkdown(text) {
    if (!text || text.length < 10) return false;
    const t = text.trim();
    return /^#{1,6}\s/m.test(t) || /^\s*[-*+]\s/m.test(t) || /^\s*\d+\.\s/m.test(t) ||
      /\[.+\]\(.+\)/m.test(t) || /\*\*?.+\*\*?/m.test(t) || /^```/m.test(t);
  }

  /**
   * クリックしたリンクのファイル名を取得（リンク自身のテキストのみ使用）
   * 親要素を探索しない - 同名の別拡張子ファイル（hello.txtとhello.md）の誤検出を防ぐ
   */
  function getFilenameFromClickedLink(link) {
    return (link.textContent || '').trim() ||
      link.getAttribute('title') ||
      link.getAttribute('aria-label') ||
      link.getAttribute('data-filename') ||
      link.getAttribute('data-name') ||
      '';
  }

  function getNodeIdFromContentsApi(folderId, filename) {
    const url = `${window.location.origin}/fc/api/v1/sync_and_share_nodes/${folderId}/contents?fields=uuid,name,is_directory&filter_deleted=active&per_page=100`;
    return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const items = Array.isArray(data) ? data : (data?.items || data?.data || data?.children || []);
        const item = items.find(x => x.name === filename && !x.is_directory);
        return item ? { fileId: item.uuid, parentId: folderId } : null;
      })
      .catch(() => null);
  }

  function getNodeParentId(nodeId) {
    const url = `${window.location.origin}/fc/api/v1/sync_and_share_nodes/${nodeId}`;
    return fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } })
      .then(r => r.ok ? r.json() : null)
      .then(data => (data?.parent_uuid || data?.parent?.uuid || data?.parent_id || data?.parent?.id || null))
      .catch(() => null);
  }

  function getFileListFromPage() {
    try {
      const s = document.documentElement.dataset?.acronisMdList;
      return s ? JSON.parse(s) : {};
    } catch (_) { return {}; }
  }

  function markdownToHtml(md) {
    if (typeof marked !== 'undefined') return marked.parse(md, { gfm: true });
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>').replace(/^## (.*$)/gim, '<h2>$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^```(\w*)\n([\s\S]*?)```/gim, '<pre><code class="language-$1">$2</code></pre>')
      .replace(/^- (.*$)/gim, '<li>$1</li>').replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/^\n/gm, '<br>');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getCsrfToken() {
    const m = document.cookie.match(/rest_access_token=([^;]+)/);
    return m ? m[1].trim() : '';
  }

  function uploadFile(parentFolderId, filename, content) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = `${window.location.origin}/fc/api/v1/sync_and_share_nodes/${parentFolderId}/upload?filename=${encodeURIComponent(filename)}&size=${blob.size}`;
    const csrf = getCsrfToken();
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/octet-stream'
    };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const doFetch = () => fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: blob
    });
    return doFetch().then(res => {
      if (res.status === 500) {
        return new Promise((resolve) => setTimeout(() => resolve(doFetch()), 1500));
      }
      return res;
    });
  }

  function showPreview(content, filename, isMarkdown, uploadParentId) {
    const overlay = document.createElement('div');
    overlay.id = 'acronis-md-preview-overlay';
    overlay.className = 'acronis-md-overlay';

    const modal = document.createElement('div');
    modal.className = 'acronis-md-modal';

    const header = document.createElement('div');
    header.className = 'acronis-md-header';
    header.innerHTML = `
      <span class="acronis-md-title">${escapeHtml(filename || 'Preview')}</span>
      <div class="acronis-md-actions">
        <button type="button" class="acronis-md-btn" data-mode="preview">プレビュー</button>
        <button type="button" class="acronis-md-btn" data-mode="raw">Raw</button>
        ${uploadParentId ? '<button type="button" class="acronis-md-btn" data-mode="edit">編集</button>' : ''}
        <button type="button" class="acronis-md-btn acronis-md-close">閉じる</button>
      </div>
    `;

    const contentArea = document.createElement('div');
    contentArea.className = 'acronis-md-content';
    const rawPre = document.createElement('pre');
    rawPre.className = 'acronis-md-raw';
    rawPre.textContent = content;
    const previewDiv = document.createElement('div');
    previewDiv.className = 'acronis-md-rendered';
    previewDiv.innerHTML = markdownToHtml(content);
    const editArea = document.createElement('div');
    editArea.className = 'acronis-md-edit-area';
    editArea.style.display = 'none';
    const textarea = document.createElement('textarea');
    textarea.className = 'acronis-md-textarea';
    textarea.value = content;
    textarea.placeholder = 'Markdownを編集...';
    const saveBar = document.createElement('div');
    saveBar.className = 'acronis-md-save-bar';
    saveBar.innerHTML = `
      <button type="button" class="acronis-md-btn acronis-md-save">保存</button>
      <button type="button" class="acronis-md-btn acronis-md-cancel">キャンセル</button>
      <span class="acronis-md-save-status"></span>
    `;
    editArea.appendChild(textarea);
    editArea.appendChild(saveBar);

    contentArea.appendChild(rawPre);
    contentArea.appendChild(previewDiv);
    contentArea.appendChild(editArea);

    if (isMarkdown) {
      rawPre.style.display = 'none';
      previewDiv.style.display = 'block';
      header.querySelector('[data-mode="preview"]').classList.add('active');
    } else {
      rawPre.style.display = 'block';
      previewDiv.style.display = 'none';
      header.querySelector('[data-mode="raw"]').classList.add('active');
    }

    modal.appendChild(header);
    modal.appendChild(contentArea);
    overlay.appendChild(modal);

    header.querySelector('.acronis-md-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    header.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        header.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        rawPre.style.display = mode === 'raw' ? 'block' : 'none';
        previewDiv.style.display = mode === 'preview' ? 'block' : 'none';
        editArea.style.display = mode === 'edit' ? 'block' : 'none';
        if (mode === 'edit') textarea.focus();
      });
    });

    saveBar.querySelector('.acronis-md-save').addEventListener('click', async () => {
      const statusEl = saveBar.querySelector('.acronis-md-save-status');
      statusEl.textContent = '保存中...';
      statusEl.className = 'acronis-md-save-status';
      try {
        const res = await uploadFile(uploadParentId, filename, textarea.value);
        if (res.ok) {
          statusEl.textContent = '保存しました';
          statusEl.classList.add('success');
          content = textarea.value;
          rawPre.textContent = content;
          previewDiv.innerHTML = markdownToHtml(content);
        } else {
          let errMsg = '保存に失敗しました';
          try {
            const errJson = await res.json();
            if (errJson?.message || errJson?.error) errMsg += ': ' + (errJson.message || errJson.error);
          } catch (_) {}
          statusEl.textContent = errMsg;
          statusEl.classList.add('error');
        }
      } catch (err) {
        statusEl.textContent = 'エラー: ' + (err.message || '保存できませんでした');
        statusEl.classList.add('error');
      }
    });

    saveBar.querySelector('.acronis-md-cancel').addEventListener('click', () => {
      textarea.value = content;
      header.querySelector('[data-mode="preview"]').click();
    });

    document.body.appendChild(overlay);
  }

  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a');
    if (!link) return;

    const href = (link.getAttribute('href') || '').trim();
    const filenameFromDom = getFilenameFromClickedLink(link);
    const isMdFile = isMarkdownByFilename(filenameFromDom);
    const hasDownloadHref = DOWNLOAD_URL_PATTERN.test(href);

    if (!isMdFile && !hasDownloadHref) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let downloadUrl = hasDownloadHref ? href : null;
    let nodeId = null;
    let uploadParentId = null;

    if (hasDownloadHref) {
      const m = href.match(/sync_and_share_nodes\/([a-f0-9-]+)\/download/i);
      if (m) nodeId = m[1];
    }

    if (!downloadUrl && isMdFile) {
      nodeId = getFileListFromPage()[filenameFromDom];
      if (!nodeId) {
        const folderId = (window.location.hash || '').match(/\/nodes\/([a-f0-9-]+)/i)?.[1];
        if (folderId) {
          const result = await getNodeIdFromContentsApi(folderId, filenameFromDom);
          if (result) {
            nodeId = result.fileId;
            uploadParentId = result.parentId;
          }
        }
      } else {
        uploadParentId = (window.location.hash || '').match(/\/nodes\/([a-f0-9-]+)/i)?.[1];
      }
      if (nodeId) {
        downloadUrl = `${window.location.origin}/fc/api/v1/sync_and_share_nodes/${nodeId}/download`;
      }
    }

    if (nodeId && !uploadParentId) {
      uploadParentId = (window.location.hash || '').match(/\/nodes\/([a-f0-9-]+)/i)?.[1] || await getNodeParentId(nodeId);
    }

    if (!downloadUrl) return;

    try {
      const response = await fetch(downloadUrl, {
        credentials: 'include',
        headers: { 'Accept': 'text/plain,text/markdown,text/html,*/*' }
      });

      if (!response.ok) {
        window.location.href = downloadUrl;
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      const contentDisposition = response.headers.get('content-disposition') || '';
      let filenameFromHeader = (contentDisposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';]+)["']?/i) || [])[1];
      try { filenameFromHeader = filenameFromHeader ? decodeURIComponent(filenameFromHeader.replace(/^UTF-8''/i, '')) : filenameFromHeader; } catch (_) {}
      const isMdByFilename = isMarkdownByFilename(filenameFromDom || filenameFromHeader);

      if (!isMdByFilename && /application\/(octet-stream|pdf|zip)|image\//.test(contentType)) {
        window.location.href = downloadUrl;
        return;
      }

      const text = await response.text();
      const isMdByHeader = isMarkdownByHeaders(response);
      const isMdByContent = looksLikeMarkdown(text) && text.length < 500000;
      const isMarkdown = isMdFile || isMdByHeader || isMarkdownByFilename(filenameFromHeader) ||
        (contentType.includes('text/') && isMdByContent);
      const displayName = filenameFromDom || filenameFromHeader || 'document.md';

      showPreview(text, displayName, isMarkdown, uploadParentId);
    } catch (err) {
      window.location.href = downloadUrl;
    }
  }, true);

})();
