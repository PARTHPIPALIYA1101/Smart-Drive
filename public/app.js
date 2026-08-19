// Smart Drive Desktop Filesystem UI Engine
let currentParentId = null;
let currentPathNodes = [{ id: null, name: 'Smart Drive' }];
let navHistory = [null];
let navHistoryIndex = 0;
let currentViewMode = 'ALL_FILES'; // 'ALL_FILES' | 'RECENT' | 'TRASH'
let layoutMode = 'list'; // 'list' | 'grid'
let selectedNode = null;
let currentItems = [];
let rightClickedNode = null;

// ==========================================
// SVG Icon System (Clean Vector Icons)
// ==========================================
const ICONS = {
  folder: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path></svg>`,
  pdf: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M10 12v6"></path><path d="M10 15h3a1.5 1.5 0 0 0 0-3h-3"></path></svg>`,
  image: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
  video: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  audio: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  code: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
  archive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
  doc: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
  file: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  cloud: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  restore: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`,
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUI();
  initSSE();
  checkActiveOperations();
  refreshAll();
  // Auto-sync storage with Google on initial launch
  autoSyncStorage();
});

// ==========================================
// Live Server-Sent Events (SSE) Engine
// ==========================================
let eventSource = null;
let sseReconnectTimer = null;
let fallbackPollInterval = null;

function initSSE() {
  if (eventSource) {
    eventSource.close();
  }

  try {
    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      console.log('⚡ Smart Drive Live Sync connected');
      if (fallbackPollInterval) {
        clearInterval(fallbackPollInterval);
        fallbackPollInterval = null;
      }
    };

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleServerEvent(event);
      } catch (err) {
        // Heartbeat or comment
      }
    };

    eventSource.onerror = () => {
      console.warn('⚡ Live Sync connection lost, reconnecting...');
      eventSource.close();
      eventSource = null;

      // Start fallback low-frequency poll if not active
      if (!fallbackPollInterval) {
        fallbackPollInterval = setInterval(() => {
          refreshAll();
        }, 20000);
      }

      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = setTimeout(() => {
        initSSE();
      }, 3000);
    };
  } catch (err) {
    console.error('SSE initialization error:', err);
  }
}

function handleServerEvent(event) {
  const { type, payload } = event;

  switch (type) {
    case 'FILE_CREATED':
    case 'FOLDER_CREATED':
    case 'FILE_UPDATED':
    case 'FILE_MOVED':
      loadCurrentFolder();
      loadTree();
      loadCapacityReport();
      break;

    case 'FILE_TRASHED':
    case 'FILE_RESTORED':
    case 'FILE_DELETED':
      if (currentViewMode === 'TRASH') {
        loadTrashView();
      } else {
        loadCurrentFolder();
      }
      loadTree();
      loadCapacityReport();
      break;

    case 'DRIVE_STATUS_CHANGED':
    case 'DRIVE_QUOTA_UPDATED':
      loadCapacityReport();
      loadAccountsSummary();
      break;

    case 'UPLOAD_QUEUED':
    case 'UPLOAD_PROGRESS':
    case 'UPLOAD_COMPLETED':
    case 'UPLOAD_FAILED':
    case 'UPLOAD_CANCELLED':
      handleUploadQueueEvent(type, payload);
      break;
  }
}

let activeClientUpload = null;
let toastDismissTimeout = null;

function handleUploadQueueEvent(type, payload) {
  const toast = document.getElementById('uploadToast');
  const toastTitle = document.getElementById('uploadToastTitle');
  const toastPct = document.getElementById('uploadToastPct');
  const toastBar = document.getElementById('uploadToastBar');
  const toastMeta = document.getElementById('uploadToastMeta');
  const toastSpeed = document.getElementById('uploadToastSpeed');
  const cancelBtn = document.getElementById('cancelUploadBtn');

  if (!toast) return;

  // If a client upload is actively controlling the toast, ignore backend single-file completion events
  if (activeClientUpload) {
    return;
  }

  // Only handle real batch queue events from backend UploadQueue
  if (!payload || (!payload.batchId && payload.totalFiles === undefined)) {
    return;
  }

  if (toastDismissTimeout) {
    clearTimeout(toastDismissTimeout);
    toastDismissTimeout = null;
  }

  if (type === 'UPLOAD_QUEUED' || type === 'UPLOAD_PROGRESS') {
    toast.style.display = 'flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    const pct = payload.percentage || (payload.totalBytes > 0 ? Math.round((payload.completedBytes / payload.totalBytes) * 100) : 0);
    toastTitle.textContent = payload.rootFolderName || 'Uploading Files';
    toastPct.textContent = `${pct}%`;
    toastBar.style.width = `${pct}%`;
    toastMeta.textContent = `${payload.completedFiles || 0} / ${payload.totalFiles || 0} files (${formatBytes(payload.completedBytes || 0)} / ${formatBytes(payload.totalBytes || 0)})`;
    toastSpeed.textContent = payload.currentFile ? `Uploading: ${payload.currentFile}` : 'Streaming...';
  } else if (type === 'UPLOAD_COMPLETED') {
    toastPct.textContent = '100%';
    toastBar.style.width = '100%';
    toastSpeed.textContent = `✓ Uploaded ${payload.completedFiles || payload.totalFiles || 0} file(s) across storage`;
    loadCurrentFolder();
    loadTree();
    loadCapacityReport();
    toastDismissTimeout = setTimeout(() => {
      toast.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
    }, 2500);
  } else if (type === 'UPLOAD_FAILED' || type === 'UPLOAD_CANCELLED') {
    toastTitle.textContent = type === 'UPLOAD_CANCELLED' ? 'Upload Cancelled' : 'Upload Failed';
    toastSpeed.textContent = payload.error || 'Stopped';
    toastDismissTimeout = setTimeout(() => {
      toast.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
    }, 3000);
  }
}

async function checkActiveOperations() {
  try {
    // 1. Send reconnect heartbeat to clear backend grace timers
    fetch('/api/operations/reconnect', { method: 'POST' }).catch(() => {});

    // 2. Fetch active backend operations
    const res = await fetch('/api/operations/active');
    const json = await res.json();
    if (!json.success) return;

    // Check active resumable sessions
    const activeSessions = json.data.activeSessions || [];
    const activeResumable = activeSessions.find(
      (s) => s.status === 'EXECUTING' || s.status === 'WAITING_FOR_SOURCE' || s.status === 'RESERVED'
    );

    const savedUploadStr = sessionStorage.getItem('smartdrive_active_upload');
    const savedUpload = savedUploadStr ? JSON.parse(savedUploadStr) : null;

    if (activeResumable || savedUpload) {
      const opId = activeResumable?.operationId || savedUpload?.operationId;
      const fileName = activeResumable?.fileName || savedUpload?.fileName || 'Upload';
      const fileSize = activeResumable?.fileSize || savedUpload?.fileSize || 0;

      // Query latest offset from backend/Google Drive
      let offset = activeResumable?.bytesCompleted || 0;
      try {
        const offsetRes = await fetch(`/api/transfer/resumable/${encodeURIComponent(opId)}/offset`);
        const offsetJson = await offsetRes.json();
        if (offsetJson.success) {
          offset = offsetJson.data.offset || 0;
        }
      } catch {}

      const toast = document.getElementById('uploadToast');
      const toastTitle = document.getElementById('uploadToastTitle');
      const toastPct = document.getElementById('uploadToastPct');
      const toastBar = document.getElementById('uploadToastBar');
      const toastMeta = document.getElementById('uploadToastMeta');
      const toastSpeed = document.getElementById('uploadToastSpeed');
      const cancelBtn = document.getElementById('cancelUploadBtn');
      const resumeInput = document.getElementById('resumeFileInput');

      if (toast) {
        toast.style.display = 'flex';
        toastTitle.textContent = `${fileName} (Paused)`;
        const pct = fileSize > 0 ? Math.round((offset / fileSize) * 100) : 0;
        toastPct.textContent = `${pct}%`;
        toastBar.style.width = `${pct}%`;
        toastMeta.textContent = `${formatBytes(offset)} / ${formatBytes(fileSize)}`;
        toastSpeed.innerHTML = `⚠️ Click to re-select <strong>${fileName}</strong> and resume from ${formatBytes(offset)}`;
        toast.style.cursor = 'pointer';

        pendingResumeOperation = {
          operationId: opId,
          fileName,
          fileSize,
          offset,
        };

        toast.onclick = (e) => {
          if (e.target === cancelBtn || cancelBtn?.contains(e.target)) return;
          if (resumeInput) {
            resumeInput.value = '';
            resumeInput.click();
          }
        };

        if (resumeInput) {
          resumeInput.onchange = async (e) => {
            const pickedFile = e.target.files?.[0];
            if (!pickedFile) return;

            if (
              pendingResumeOperation &&
              pickedFile.name === pendingResumeOperation.fileName &&
              Math.abs(pickedFile.size - pendingResumeOperation.fileSize) < 1024
            ) {
              toast.style.cursor = 'default';
              toast.onclick = null;
              toastTitle.textContent = pickedFile.name;
              await uploadSingleFile(pickedFile, pendingResumeOperation.operationId, pendingResumeOperation.offset);
              pendingResumeOperation = null;
            } else {
              alert(
                `Selected file "${pickedFile.name}" (${formatBytes(pickedFile.size)}) does not match expected file "${pendingResumeOperation?.fileName}" (${formatBytes(pendingResumeOperation?.fileSize || 0)}).`
              );
            }
          };
        }

        if (cancelBtn) {
          cancelBtn.style.display = 'inline-flex';
          cancelBtn.onclick = async (e) => {
            e.stopPropagation();
            fetch(`/api/transfer/resumable/${encodeURIComponent(opId)}/cancel`, { method: 'POST' }).catch(() => {});
            sessionStorage.removeItem('smartdrive_active_op_id');
            sessionStorage.removeItem('smartdrive_active_upload');
            toast.style.display = 'none';
            pendingResumeOperation = null;
          };
        }
      }
      return;
    }

    // Check active batches
    if (json.data.activeBatches && json.data.activeBatches.length > 0) {
      const active = json.data.activeBatches.find((b) => b.status === 'UPLOADING' || b.status === 'PENDING');
      if (active) {
        handleUploadQueueEvent('UPLOAD_PROGRESS', {
          batchId: active.id,
          rootFolderName: active.rootFolderName,
          totalFiles: active.totalFiles,
          completedFiles: active.completedFiles,
          totalBytes: active.totalBytes,
          completedBytes: active.completedBytes,
          percentage: active.totalBytes > 0 ? Math.round((active.completedBytes / active.totalBytes) * 100) : 0,
        });
      }
    }
  } catch (err) {
    // Non-blocking
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('smartdrive_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('smartdrive_theme', next);
    updateThemeIcon(next);
  });
}

function updateThemeIcon(theme) {
  const sun = document.querySelector('.sun-icon');
  const moon = document.querySelector('.moon-icon');
  if (theme === 'dark') {
    sun.style.display = 'none';
    moon.style.display = 'inline-block';
  } else {
    sun.style.display = 'inline-block';
    moon.style.display = 'none';
  }
}

function initUI() {
  // Navigation tabs
  document.getElementById('navAllFiles').addEventListener('click', () => setNavMode('ALL_FILES'));
  document.getElementById('navRecent').addEventListener('click', () => setNavMode('RECENT'));
  document.getElementById('navTrash').addEventListener('click', () => setNavMode('TRASH'));

  // History buttons
  document.getElementById('navBackBtn').addEventListener('click', handleHistoryBack);
  document.getElementById('navUpBtn').addEventListener('click', handleNavigateUp);

  // Header Actions
  document.getElementById('newFolderBtn').addEventListener('click', handleCreateFolderPrompt);
  document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', handleFileInput);

  const uploadFolderBtn = document.getElementById('uploadFolderBtn');
  const folderInput = document.getElementById('folderInput');
  if (uploadFolderBtn && folderInput) {
    uploadFolderBtn.addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', handleFolderInput);
  }

  const cancelUploadBtn = document.getElementById('cancelUploadBtn');
  if (cancelUploadBtn) {
    cancelUploadBtn.addEventListener('click', () => {
      isUploadCancelled = true;
    });
  }

  // Modals & Storage
  document.getElementById('storagePillBtn').addEventListener('click', openStatsModal);
  document.getElementById('closeStatsModalBtn').addEventListener('click', closeStatsModal);
  document.getElementById('accountsBtn').addEventListener('click', openAccountsModal);
  document.getElementById('closeAccountsModalBtn').addEventListener('click', closeAccountsModal);
  document.getElementById('syncAllBtn').addEventListener('click', handleSyncQuotas);
  document.getElementById('importFilesBtn').addEventListener('click', handleImportAllFiles);
  document.getElementById('connectNewAccountBtn').addEventListener('click', handleConnectAccount);
  document.getElementById('emptyTrashBtn').addEventListener('click', handleEmptyTrash);

  // Inspector
  document.getElementById('closeInspectorBtn').addEventListener('click', closeInspector);

  // Rename Dialog
  document.getElementById('closeRenameModalBtn').addEventListener('click', closeRenameModal);
  document.getElementById('cancelRenameBtn').addEventListener('click', closeRenameModal);
  document.getElementById('confirmRenameBtn').addEventListener('click', submitRename);
  document.getElementById('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitRename();
    if (e.key === 'Escape') closeRenameModal();
  });

  // Toolbar Actions
  document.getElementById('toolbarDownloadBtn').addEventListener('click', () => {
    const filesToDownload = Array.from(selectedNodes.values()).filter((n) => !n.isFolder);
    if (filesToDownload.length === 0) return;
    filesToDownload.forEach((file, index) => {
      setTimeout(() => downloadFile(file.id), index * 350);
    });
  });
  document.getElementById('toolbarRenameBtn').addEventListener('click', () => {
    if (selectedNode) openRenameModal(selectedNode);
  });
  document.getElementById('toolbarInfoBtn').addEventListener('click', () => {
    if (selectedNode) openFileProperties(selectedNode.id);
  });
  document.getElementById('toolbarTrashBtn').addEventListener('click', () => {
    if (selectedNodes.size > 0) handleTrashSelectedNodes();
  });
  const restoreToolbarBtn = document.getElementById('toolbarRestoreBtn');
  if (restoreToolbarBtn) {
    restoreToolbarBtn.addEventListener('click', () => {
      if (selectedNodes.size > 0) handleRestoreSelectedNodes();
    });
  }
  const permToolbarBtn = document.getElementById('toolbarPermanentDeleteBtn');
  if (permToolbarBtn) {
    permToolbarBtn.addEventListener('click', () => {
      if (selectedNodes.size > 0) handlePermanentDeleteSelectedNodes();
    });
  }
  const clearBtn = document.getElementById('toolbarClearSelectionBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearSelection);

  // Layout View Switchers
  document.getElementById('viewListBtn').addEventListener('click', () => setViewLayout('list'));
  document.getElementById('viewGridBtn').addEventListener('click', () => setViewLayout('grid'));

  // Search & Keyboard Shortcuts
  setupSearchAndShortcuts();

  // Context Menu Global
  setupContextMenu();

  // Drag and drop zone for file upload
  setupDragAndDrop();

  // Drag to select (Marquee / Rubberband selection)
  setupDragToSelect();
}

function setNavMode(mode) {
  currentViewMode = mode;
  document.querySelectorAll('.nav-button').forEach((b) => b.classList.remove('active'));
  clearSelection();

  if (mode === 'ALL_FILES') {
    document.getElementById('navAllFiles').classList.add('active');
    document.getElementById('emptyTrashBtn').style.display = 'none';
    navigateTo(null, 'Smart Drive', false);
  } else if (mode === 'RECENT') {
    document.getElementById('navRecent').classList.add('active');
    document.getElementById('emptyTrashBtn').style.display = 'none';
    loadRecentOperationsView();
  } else if (mode === 'TRASH') {
    document.getElementById('navTrash').classList.add('active');
    document.getElementById('emptyTrashBtn').style.display = 'inline-flex';
    loadTrashView();
  }
}

async function refreshAll() {
  await Promise.all([
    loadCapacityReport(),
    loadTree(),
    loadCurrentView(),
    loadAccountsSummary(),
  ]);
}

async function autoSyncStorage() {
  try {
    await fetch('/api/capacity/sync', { method: 'POST' });
    loadCapacityReport();
    loadAccountsSummary();
  } catch {
    // Non-blocking sync
  }
}

// ==========================================
// Capacity & Metrics (Synced Logical vs Physical)
// ==========================================
async function loadCapacityReport() {
  try {
    const [capRes, statsRes] = await Promise.all([
      fetch('/api/capacity').then((r) => r.json()),
      fetch('/api/stats').then((r) => r.json()),
    ]);

    if (capRes.success) {
      const d = capRes.data;
      const total = d.totalUnifiedBytes || 0;
      const used = d.totalUsedBytes || 0;
      const pct = total > 0 ? ((used / total) * 100).toFixed(0) : 0;

      document.getElementById('capacityVal').textContent = `${formatBytes(used)} / ${formatBytes(total)} Google Cloud`;
      document.getElementById('capacityBar').style.width = `${Math.min(100, pct)}%`;
      document.getElementById('drivesCount').textContent = d.connectedDrivesCount || 0;
    }

    if (statsRes.success) {
      const s = statsRes.data;
      document.getElementById('logicalSizeVal').textContent = formatBytes(s.totalLogicalBytes);
    }
  } catch {
    document.getElementById('capacityVal').textContent = 'Offline';
  }
}

// ==========================================
// Virtual Hierarchy & Tree
// ==========================================
async function loadTree() {
  try {
    const res = await fetch('/api/vfs/tree');
    const json = await res.json();
    if (json.success) {
      renderTree(json.data);
    }
  } catch (err) {
    console.error('Tree fetch failed:', err);
  }
}

function renderTree(rootNode) {
  const container = document.getElementById('treeContainer');
  container.innerHTML = '';

  const renderNode = (node, depth = 0) => {
    if (!node.isFolder) return;
    const isRoot = node.id === 0 || node.parentId === null;
    const isActive = (isRoot && currentParentId === null) || (!isRoot && currentParentId === node.id);
    const row = document.createElement('div');
    row.className = `tree-node-row ${isActive && currentViewMode === 'ALL_FILES' ? 'active' : ''}`;
    row.style.paddingLeft = `${depth * 14 + 6}px`;

    row.innerHTML = `
      <span class="tree-node-icon">${ICONS.folder}</span>
      <span class="tree-node-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
    `;

    row.addEventListener('click', () => {
      setNavMode('ALL_FILES');
      navigateTo(isRoot ? null : node.id, node.name);
    });

    // Drag and drop destination for moving files into tree folders
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/json')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target-hover');
      }
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-target-hover');
    });

    row.addEventListener('drop', async (e) => {
      row.classList.remove('drop-target-hover');
      const raw = e.dataTransfer.getData('application/json');
      if (raw) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.fileIds)) {
            await moveItemsToFolder(parsed.fileIds, node.id);
          }
        } catch (err) {
          console.error('Tree drop error:', err);
        }
      }
    });

    container.appendChild(row);

    if (node.children) {
      node.children.forEach((child) => renderNode(child, depth + 1));
    }
  };

  renderNode(rootNode);
}

// ==========================================
// Explorer Content & Navigation
// ==========================================
function loadCurrentView() {
  if (currentViewMode === 'RECENT') {
    return loadRecentOperationsView();
  } else if (currentViewMode === 'TRASH') {
    return loadTrashView();
  } else {
    return loadCurrentFolder();
  }
}

async function loadCurrentFolder() {
  try {
    const url = currentParentId !== null
      ? `/api/vfs/children?parentId=${currentParentId}`
      : `/api/vfs/children`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.success) {
      currentItems = json.data || [];
      renderItems(currentItems);
    }
  } catch (err) {
    console.error('Folder load error:', err);
  }
}

function renderItems(items) {
  const container = document.getElementById('itemsContainer');
  const emptyState = document.getElementById('emptyState');
  container.innerHTML = '';
  clearSelection();

  if (!items || items.length === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('.empty-state-title').textContent =
      currentViewMode === 'TRASH' ? 'Trash is empty' : 'This folder is empty';
    emptyState.querySelector('.empty-state-desc').textContent =
      currentViewMode === 'TRASH' ? 'Deleted files will appear here.' : 'Drag and drop files here or click Upload.';
    return;
  }
  emptyState.style.display = 'none';

  if (layoutMode === 'list') {
    renderDetailedListView(items, container);
  } else {
    renderGridView(items, container);
  }
}

function renderDetailedListView(items, container) {
  // Table Header
  const header = document.createElement('div');
  header.className = 'file-row-header';
  header.innerHTML = `
    <div>Name</div>
    <div>Storage Placement</div>
    <div>Size</div>
    <div>Modified</div>
    <div style="text-align:right;">Actions</div>
  `;
  container.appendChild(header);

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = `file-row ${selectedNodes.has(item.id) ? 'selected' : ''}`;
    row.dataset.id = item.id;
    row.draggable = currentViewMode !== 'TRASH';

    // Drag start for moving files
    row.addEventListener('dragstart', (e) => {
      if (!selectedNodes.has(item.id)) {
        selectNode(item);
      }
      const ids = Array.from(selectedNodes.keys());
      e.dataTransfer.setData('application/json', JSON.stringify({ fileIds: ids }));
      e.dataTransfer.effectAllowed = 'move';
    });

    // If this row is a folder, make it a drop target
    if (item.isFolder && currentViewMode !== 'TRASH') {
      row.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/json')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drop-target-hover');
        }
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drop-target-hover');
      });
      row.addEventListener('drop', async (e) => {
        row.classList.remove('drop-target-hover');
        const raw = e.dataTransfer.getData('application/json');
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          try {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.fileIds)) {
              await moveItemsToFolder(parsed.fileIds, item.id);
            }
          } catch (err) {
            console.error('Drop move error:', err);
          }
        }
      });
    }

    const iconType = getItemIconType(item);
    const sizeText = item.isFolder ? '—' : formatBytes(item.size);
    const driveName = item.googleAccountName ? escapeHtml(item.googleAccountName) : 'Virtual VFS';
    const updatedDate = new Date(item.updatedAt || item.createdAt || Date.now()).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });

    row.innerHTML = `
      <div class="col-name">
        <span class="file-type-icon ${iconType}">${ICONS[iconType] || ICONS.file}</span>
        <span class="file-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      </div>
      <div class="col-drive" title="Physical storage placement">
        <span style="color:var(--text-tertiary);">${ICONS.cloud}</span>
        <span>${driveName}</span>
      </div>
      <div class="col-size">${sizeText}</div>
      <div class="col-date">${updatedDate}</div>
      <div class="col-actions">
        ${!item.isFolder && currentViewMode !== 'TRASH' ? `
          <button class="icon-btn" title="Download" onclick="event.stopPropagation(); downloadFile(${item.id})">
            ${ICONS.download}
          </button>
        ` : ''}
        ${currentViewMode === 'TRASH' ? `
          <button class="icon-btn" title="Restore" onclick="event.stopPropagation(); handleRestoreNode(${item.id})">
            ${ICONS.restore}
          </button>
        ` : `
          <button class="icon-btn" title="Details" onclick="event.stopPropagation(); openFileProperties(${item.id})">
            ${ICONS.info}
          </button>
        `}
      </div>
    `;

    // Click: Select (Supports Multi-Select Ctrl/Shift)
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNode(item, e);
    });

    // Double-click: Open / Download
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (item.isFolder && currentViewMode !== 'TRASH') {
        navigateTo(item.id, item.name);
      } else {
        openFileProperties(item.id);
      }
    });

    // Context Menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedNodes.has(item.id)) {
        selectNode(item);
      }
      openContextMenu(e.clientX, e.clientY, item);
    });

    container.appendChild(row);
  });
}

function renderGridView(items, container) {
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = `grid-card ${selectedNodes.has(item.id) ? 'selected' : ''}`;
    card.dataset.id = item.id;
    card.draggable = currentViewMode !== 'TRASH';

    card.addEventListener('dragstart', (e) => {
      if (!selectedNodes.has(item.id)) {
        selectNode(item);
      }
      const ids = Array.from(selectedNodes.keys());
      e.dataTransfer.setData('application/json', JSON.stringify({ fileIds: ids }));
      e.dataTransfer.effectAllowed = 'move';
    });

    if (item.isFolder && currentViewMode !== 'TRASH') {
      card.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/json')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          card.classList.add('drop-target-hover');
        }
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drop-target-hover');
      });
      card.addEventListener('drop', async (e) => {
        card.classList.remove('drop-target-hover');
        const raw = e.dataTransfer.getData('application/json');
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          try {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.fileIds)) {
              await moveItemsToFolder(parsed.fileIds, item.id);
            }
          } catch (err) {
            console.error('Card drop error:', err);
          }
        }
      });
    }

    const iconType = getItemIconType(item);
    const sizeText = item.isFolder ? 'Folder' : formatBytes(item.size);

    card.innerHTML = `
      <div class="grid-card-icon file-type-icon ${iconType}">${ICONS[iconType] || ICONS.file}</div>
      <div class="grid-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
      <div class="grid-card-meta">${sizeText}</div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNode(item, e);
    });

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (item.isFolder && currentViewMode !== 'TRASH') {
        navigateTo(item.id, item.name);
      } else {
        openFileProperties(item.id);
      }
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedNodes.has(item.id)) {
        selectNode(item);
      }
      openContextMenu(e.clientX, e.clientY, item);
    });

    container.appendChild(card);
  });
}

async function moveItemsToFolder(fileIds, targetParentId) {
  const validIds = fileIds.filter((id) => id !== targetParentId);
  if (validIds.length === 0) return;
  try {
    for (const id of validIds) {
      await fetch(`/api/vfs/nodes/${id}/move`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newParentId: targetParentId }),
      });
    }
    clearSelection();
    refreshAll();
  } catch (err) {
    console.error('Failed to move items:', err);
    alert('Failed to move item(s) to folder');
  }
}

function getItemIconType(item) {
  if (item.isFolder) return 'folder';
  const name = item.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp') || name.endsWith('.gif') || name.endsWith('.svg')) return 'image';
  if (name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.mov') || name.endsWith('.webm') || name.endsWith('.avi')) return 'video';
  if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.flac') || name.endsWith('.m4a')) return 'audio';
  if (name.endsWith('.zip') || name.endsWith('.tar') || name.endsWith('.gz') || name.endsWith('.7z') || name.endsWith('.rar')) return 'archive';
  if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.json') || name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.py') || name.endsWith('.sql') || name.endsWith('.go')) return 'code';
  if (name.endsWith('.doc') || name.endsWith('.docx') || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.xlsx')) return 'doc';
  return 'file';
}

let selectedNodes = new Map(); // id -> item
let lastSelectedIndex = -1;

function selectNode(item, event = null) {
  const isCtrl = event && (event.ctrlKey || event.metaKey);
  const isShift = event && event.shiftKey;
  const itemIndex = currentItems.findIndex((i) => i.id === item.id);

  if (isShift && itemIndex !== -1) {
    // Range Selection
    const anchor = lastSelectedIndex !== -1 ? lastSelectedIndex : 0;
    const start = Math.min(anchor, itemIndex);
    const end = Math.max(anchor, itemIndex);
    if (!isCtrl) selectedNodes.clear();
    for (let i = start; i <= end; i++) {
      selectedNodes.set(currentItems[i].id, currentItems[i]);
    }
  } else if (isCtrl) {
    // Toggle Single Item
    if (selectedNodes.has(item.id)) {
      selectedNodes.delete(item.id);
    } else {
      selectedNodes.set(item.id, item);
      lastSelectedIndex = itemIndex;
    }
  } else {
    // Single Item Select
    selectedNodes.clear();
    selectedNodes.set(item.id, item);
    lastSelectedIndex = itemIndex;
  }

  // Update selectedNode for single-item backwards compatibility
  selectedNode = selectedNodes.size === 1 ? Array.from(selectedNodes.values())[0] : null;

  updateSelectionUI();
}

function selectAllItems() {
  selectedNodes.clear();
  currentItems.forEach((item, idx) => {
    selectedNodes.set(item.id, item);
  });
  lastSelectedIndex = currentItems.length > 0 ? 0 : -1;
  selectedNode = selectedNodes.size === 1 ? Array.from(selectedNodes.values())[0] : null;
  updateSelectionUI();
}

function updateSelectionUI() {
  document.querySelectorAll('.file-row, .grid-card').forEach((el) => {
    const id = parseInt(el.dataset.id, 10);
    el.classList.toggle('selected', selectedNodes.has(id));
  });

  const toolbar = document.getElementById('selectionToolbar');
  const countSpan = document.getElementById('selectionCount');
  const renameBtn = document.getElementById('toolbarRenameBtn');
  const infoBtn = document.getElementById('toolbarInfoBtn');
  const downloadBtn = document.getElementById('toolbarDownloadBtn');
  const trashBtn = document.getElementById('toolbarTrashBtn');
  const restoreBtn = document.getElementById('toolbarRestoreBtn');
  const permBtn = document.getElementById('toolbarPermanentDeleteBtn');

  if (selectedNodes.size > 0) {
    toolbar.style.display = 'flex';
    countSpan.textContent = `${selectedNodes.size} selected`;
    const isTrash = currentViewMode === 'TRASH';

    if (isTrash) {
      if (downloadBtn) downloadBtn.style.display = 'none';
      if (renameBtn) renameBtn.style.display = 'none';
      if (trashBtn) trashBtn.style.display = 'none';
      if (restoreBtn) restoreBtn.style.display = 'inline-flex';
      if (permBtn) permBtn.style.display = 'inline-flex';
      if (infoBtn) infoBtn.style.display = selectedNodes.size === 1 ? 'inline-flex' : 'none';
    } else {
      const hasFiles = Array.from(selectedNodes.values()).some((n) => !n.isFolder);
      if (downloadBtn) downloadBtn.style.display = hasFiles ? 'inline-flex' : 'none';
      if (renameBtn) renameBtn.style.display = selectedNodes.size === 1 ? 'inline-flex' : 'none';
      if (trashBtn) trashBtn.style.display = 'inline-flex';
      if (restoreBtn) restoreBtn.style.display = 'none';
      if (permBtn) permBtn.style.display = 'none';
      if (infoBtn) infoBtn.style.display = selectedNodes.size === 1 ? 'inline-flex' : 'none';
    }
  } else {
    toolbar.style.display = 'none';
  }
}

let wasMarqueeDragging = false;

function clearSelection() {
  selectedNodes.clear();
  selectedNode = null;
  lastSelectedIndex = -1;
  document.querySelectorAll('.file-row, .grid-card').forEach((el) => el.classList.remove('selected'));
  const toolbar = document.getElementById('selectionToolbar');
  if (toolbar) toolbar.style.display = 'none';
}

document.addEventListener('click', (e) => {
  if (wasMarqueeDragging) return;
  if (
    !e.target.closest('.file-row') &&
    !e.target.closest('.grid-card') &&
    !e.target.closest('#selectionToolbar') &&
    !e.target.closest('.context-menu') &&
    !e.target.closest('.modal-dialog') &&
    !e.target.closest('.app-sidebar') &&
    !e.target.closest('.app-inspector') &&
    !e.target.closest('.explorer-toolbar')
  ) {
    clearSelection();
    closeContextMenu();
  }
});

// ==========================================
// Navigation & Breadcrumbs
// ==========================================
function navigateTo(folderId, folderName, pushHistory = true) {
  currentParentId = folderId;

  if (folderId === null) {
    currentPathNodes = [{ id: null, name: 'Smart Drive' }];
  } else {
    const existingIndex = currentPathNodes.findIndex((n) => n.id === folderId);
    if (existingIndex !== -1) {
      currentPathNodes = currentPathNodes.slice(0, existingIndex + 1);
    } else {
      currentPathNodes.push({ id: folderId, name: folderName });
    }
  }

  if (pushHistory) {
    navHistory = navHistory.slice(0, navHistoryIndex + 1);
    navHistory.push(folderId);
    navHistoryIndex = navHistory.length - 1;
  }

  updateHistoryBtns();
  renderBreadcrumbs();
  loadCurrentFolder();
  loadTree();
}

function handleHistoryBack() {
  if (navHistoryIndex > 0) {
    navHistoryIndex--;
    const targetId = navHistory[navHistoryIndex];
    navigateTo(targetId, targetId === null ? 'Smart Drive' : 'Folder', false);
  }
}

function handleNavigateUp() {
  if (currentPathNodes.length > 1) {
    const parentNode = currentPathNodes[currentPathNodes.length - 2];
    navigateTo(parentNode.id, parentNode.name);
  }
}

function updateHistoryBtns() {
  document.getElementById('navBackBtn').disabled = navHistoryIndex <= 0;
  document.getElementById('navUpBtn').disabled = currentParentId === null;
}

function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbs');
  container.innerHTML = '';

  currentPathNodes.forEach((node, idx) => {
    const isLast = idx === currentPathNodes.length - 1;
    const span = document.createElement('span');
    span.className = `crumb ${isLast ? 'active' : ''}`;
    span.textContent = node.name;
    if (!isLast) {
      span.addEventListener('click', () => navigateTo(node.id, node.name));
    }
    container.appendChild(span);

    if (!isLast) {
      const sep = document.createElement('span');
      sep.className = 'crumb-separator';
      sep.textContent = '>';
      container.appendChild(sep);
    }
  });
}

function setViewLayout(mode) {
  layoutMode = mode;
  const container = document.getElementById('itemsContainer');
  const listBtn = document.getElementById('viewListBtn');
  const gridBtn = document.getElementById('viewGridBtn');

  if (mode === 'grid') {
    container.className = 'files-container grid-view';
    listBtn.classList.remove('active');
    gridBtn.classList.add('active');
  } else {
    container.className = 'files-container list-view';
    gridBtn.classList.remove('active');
    listBtn.classList.add('active');
  }
  renderItems(currentItems);
}

// ==========================================
// Context Menu
// ==========================================
function setupContextMenu() {
  const menu = document.getElementById('contextMenu');

  document.getElementById('ctxOpen').addEventListener('click', () => {
    closeContextMenu();
    if (rightClickedNode?.isFolder) navigateTo(rightClickedNode.id, rightClickedNode.name);
    else if (rightClickedNode) openFileProperties(rightClickedNode.id);
  });

  document.getElementById('ctxDownload').addEventListener('click', () => {
    closeContextMenu();
    if (rightClickedNode && !rightClickedNode.isFolder) downloadFile(rightClickedNode.id);
  });

  const ctxRestore = document.getElementById('ctxRestore');
  if (ctxRestore) {
    ctxRestore.addEventListener('click', () => {
      closeContextMenu();
      if (rightClickedNode) handleRestoreNode(rightClickedNode.id);
    });
  }

  document.getElementById('ctxRename').addEventListener('click', () => {
    closeContextMenu();
    if (rightClickedNode) openRenameModal(rightClickedNode);
  });

  document.getElementById('ctxInfo').addEventListener('click', () => {
    closeContextMenu();
    if (rightClickedNode) openFileProperties(rightClickedNode.id);
  });

  document.getElementById('ctxTrash').addEventListener('click', () => {
    closeContextMenu();
    if (rightClickedNode) handleTrashNode(rightClickedNode.id);
  });

  const ctxPerm = document.getElementById('ctxPermanentDelete');
  if (ctxPerm) {
    ctxPerm.addEventListener('click', () => {
      closeContextMenu();
      if (rightClickedNode) handlePermanentDeleteNode(rightClickedNode.id);
    });
  }

  document.addEventListener('click', closeContextMenu);
}

function openContextMenu(x, y, node) {
  rightClickedNode = node;
  const menu = document.getElementById('contextMenu');
  const isTrash = currentViewMode === 'TRASH';

  const ctxOpen = document.getElementById('ctxOpen');
  const ctxDownload = document.getElementById('ctxDownload');
  const ctxRestore = document.getElementById('ctxRestore');
  const ctxRename = document.getElementById('ctxRename');
  const ctxTrash = document.getElementById('ctxTrash');
  const ctxPerm = document.getElementById('ctxPermanentDelete');
  const ctxDiv1 = document.getElementById('ctxDivider1');

  if (isTrash) {
    if (ctxOpen) ctxOpen.style.display = 'none';
    if (ctxDownload) ctxDownload.style.display = 'none';
    if (ctxRename) ctxRename.style.display = 'none';
    if (ctxTrash) ctxTrash.style.display = 'none';
    if (ctxRestore) ctxRestore.style.display = 'flex';
    if (ctxPerm) ctxPerm.style.display = 'flex';
    if (ctxDiv1) ctxDiv1.style.display = 'none';
  } else {
    if (ctxOpen) ctxOpen.style.display = 'flex';
    if (ctxDownload) ctxDownload.style.display = node?.isFolder ? 'none' : 'flex';
    if (ctxRename) ctxRename.style.display = 'flex';
    if (ctxTrash) ctxTrash.style.display = 'flex';
    if (ctxRestore) ctxRestore.style.display = 'none';
    if (ctxPerm) ctxPerm.style.display = 'none';
    if (ctxDiv1) ctxDiv1.style.display = 'block';
  }

  menu.style.display = 'flex';
  menu.style.left = `${Math.min(window.innerWidth - 180, x)}px`;
  menu.style.top = `${Math.min(window.innerHeight - 200, y)}px`;
}

function closeContextMenu() {
  document.getElementById('contextMenu').style.display = 'none';
}

// ==========================================
// Upload & Progress Toast
// ==========================================
let isUploadCancelled = false;

let currentResumableXHR = null;
let pendingResumeOperation = null;

async function handleFileInput(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    await uploadSingleFile(file);
  }
  e.target.value = '';
  refreshAll();
}

async function handleFolderInput(e) {
  const fileList = e.target.files;
  if (!fileList || fileList.length === 0) return;

  const items = Array.from(fileList).map((f) => ({
    file: f,
    relativePath: f.webkitRelativePath || f.name,
  }));

  // Determine root folder name
  const rootFolderName = items[0].relativePath.split('/')[0] || 'Uploaded Folder';

  e.target.value = '';
  await uploadFolderBatch(items, rootFolderName, currentParentId);
}

async function uploadSingleFile(file, resumeOpId = null, startByte = 0) {
  const toast = document.getElementById('uploadToast');
  const toastTitle = document.getElementById('uploadToastTitle');
  const toastPct = document.getElementById('uploadToastPct');
  const toastBar = document.getElementById('uploadToastBar');
  const toastMeta = document.getElementById('uploadToastMeta');
  const toastSpeed = document.getElementById('uploadToastSpeed');
  const cancelBtn = document.getElementById('cancelUploadBtn');

  if (toastDismissTimeout) {
    clearTimeout(toastDismissTimeout);
    toastDismissTimeout = null;
  }
  activeClientUpload = { isBatch: false, name: file.name };

  toast.style.display = 'flex';
  if (cancelBtn) {
    cancelBtn.style.display = 'inline-flex';
    cancelBtn.onclick = async (e) => {
      e.stopPropagation();
      if (currentResumableXHR) {
        currentResumableXHR.abort();
      }
      if (sessionStorage.getItem('smartdrive_active_op_id')) {
        const opId = sessionStorage.getItem('smartdrive_active_op_id');
        fetch(`/api/transfer/resumable/${encodeURIComponent(opId)}/cancel`, { method: 'POST' }).catch(() => {});
        sessionStorage.removeItem('smartdrive_active_op_id');
        sessionStorage.removeItem('smartdrive_active_upload');
      }
      toast.style.display = 'none';
      activeClientUpload = null;
    };
  }

  toastTitle.textContent = file.name;
  const initialPct = file.size > 0 ? Math.round((startByte / file.size) * 100) : 0;
  toastPct.textContent = `${initialPct}%`;
  toastBar.style.width = `${initialPct}%`;
  toastMeta.textContent = `${formatBytes(startByte)} / ${formatBytes(file.size)}`;
  toastSpeed.textContent = startByte > 0 ? `Resuming from ${formatBytes(startByte)}...` : 'Connecting to Google Drive...';

  try {
    let operationId = resumeOpId;
    let initialOffset = startByte;

    // 1. Initialize resumable session if not already initialized
    if (!operationId) {
      const initRes = await fetch('/api/transfer/resumable/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          parentId: currentParentId,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          conflictAction: 'RENAME',
        }),
      });

      const initJson = await initRes.json();
      if (!initJson.success) {
        alert(`Upload failed: ${initJson.error?.message || 'Initialization failed'}`);
        toast.style.display = 'none';
        activeClientUpload = null;
        return;
      }

      if (initJson.data.skipped) {
        toastPct.textContent = '100%';
        toastBar.style.width = '100%';
        toastSpeed.textContent = '✓ Already exists';
        toastDismissTimeout = setTimeout(() => { toast.style.display = 'none'; }, 2000);
        loadCurrentFolder();
        activeClientUpload = null;
        return;
      }

      operationId = initJson.data.operationId;
      initialOffset = initJson.data.startByte || 0;
    }

    // Persist active upload metadata to sessionStorage so refresh reconnects cleanly
    sessionStorage.setItem('smartdrive_active_op_id', operationId);
    sessionStorage.setItem(
      'smartdrive_active_upload',
      JSON.stringify({
        operationId,
        fileName: file.name,
        fileSize: file.size,
        parentId: currentParentId,
        mimeType: file.type || 'application/octet-stream',
      })
    );

    // 2. Query provider offset to ensure we stream from the exact byte position
    if (initialOffset === 0 && resumeOpId) {
      try {
        const offsetRes = await fetch(`/api/transfer/resumable/${encodeURIComponent(operationId)}/offset`);
        const offsetJson = await offsetRes.json();
        if (offsetJson.success) {
          initialOffset = offsetJson.data.offset || 0;
        }
      } catch {}
    }

    // 3. Stream slice from initialOffset to end
    const slice = initialOffset > 0 ? file.slice(initialOffset) : file;

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      currentResumableXHR = xhr;
      const streamUrl = `/api/transfer/resumable/${encodeURIComponent(operationId)}/stream?startByte=${initialOffset}`;

      xhr.open('PUT', streamUrl, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      let lastTime = Date.now();
      let lastBytes = initialOffset;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const currentTotal = initialOffset + e.loaded;
          const pct = file.size > 0 ? Math.min(99, Math.round((currentTotal / file.size) * 100)) : 0;
          toastPct.textContent = `${pct}%`;
          toastBar.style.width = `${pct}%`;
          toastMeta.textContent = `${formatBytes(currentTotal)} / ${formatBytes(file.size)}`;

          const now = Date.now();
          const timeDiff = (now - lastTime) / 1000;
          if (timeDiff >= 0.5) {
            const bytesDiff = currentTotal - lastBytes;
            const speed = bytesDiff / timeDiff;
            toastSpeed.textContent = `${formatBytes(speed)}/s`;
            lastTime = now;
            lastBytes = currentTotal;
          }
        }
      };

      xhr.onload = () => {
        currentResumableXHR = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response);
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}: ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => {
        currentResumableXHR = null;
        reject(new Error('Network error during upload stream'));
      };

      xhr.onabort = () => {
        currentResumableXHR = null;
        reject(new Error('Upload aborted'));
      };

      xhr.send(slice);
    });

    // Upload succeeded
    sessionStorage.removeItem('smartdrive_active_op_id');
    sessionStorage.removeItem('smartdrive_active_upload');
    toastPct.textContent = '100%';
    toastBar.style.width = '100%';
    toastSpeed.textContent = '✓ Stored';
    toastDismissTimeout = setTimeout(() => {
      toast.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
    }, 2000);
    loadCurrentFolder();
    loadTree();
    loadCapacityReport();
  } catch (err) {
    if (err.message === 'Upload aborted') {
      return;
    }
    console.error('Upload stream error:', err);
    toastSpeed.textContent = 'Interrupted';
  } finally {
    activeClientUpload = null;
  }
}

async function uploadFolderBatch(items, rootFolderName, targetParentId) {
  if (!items || items.length === 0) return;

  const toast = document.getElementById('uploadToast');
  const toastTitle = document.getElementById('uploadToastTitle');
  const toastPct = document.getElementById('uploadToastPct');
  const toastBar = document.getElementById('uploadToastBar');
  const toastMeta = document.getElementById('uploadToastMeta');
  const toastSpeed = document.getElementById('uploadToastSpeed');
  const cancelBtn = document.getElementById('cancelUploadBtn');

  if (toastDismissTimeout) {
    clearTimeout(toastDismissTimeout);
    toastDismissTimeout = null;
  }

  activeClientUpload = {
    isBatch: true,
    rootFolderName,
    totalFiles: items.length,
    completedFiles: 0,
    totalBytes: 0,
    completedBytes: 0,
  };

  toast.style.display = 'flex';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  toastTitle.textContent = `Planning ${rootFolderName}...`;
  toastPct.textContent = '0%';
  toastBar.style.width = '0%';
  toastMeta.textContent = `0 / ${items.length} files`;
  toastSpeed.textContent = 'Calculating capacity & distribution...';

  // 1. Pre-upload capacity & multi-drive placement planning
  const planPayload = {
    rootFolderName,
    parentId: targetParentId,
    files: items.map((i) => ({
      relativePath: i.relativePath,
      size: i.file.size,
      mimeType: i.file.type || 'application/octet-stream',
    })),
  };

  try {
    const planRes = await fetch('/api/transfer/folder/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planPayload),
    });
    const planJson = await planRes.json();

    if (!planJson.success) {
      alert(`Folder Upload Blocked:\n\n${planJson.error?.message || 'Insufficient storage capacity.'}`);
      toast.style.display = 'none';
      activeClientUpload = null;
      return;
    }

    const plan = planJson.data;
    const totalBytes = plan.totalBytes;
    activeClientUpload.totalBytes = totalBytes;
    let bytesUploaded = 0;
    let filesUploaded = 0;
    isUploadCancelled = false;

    // Cache for created/resolved folder path IDs: "MyProject/src" -> folderId
    const dirIdCache = new Map();

    // 2. Pre-create the ENTIRE virtual directory hierarchy upfront deterministically before physical file uploads begin!
    toastSpeed.textContent = 'Creating folder structure...';
    for (const item of items) {
      let relPath = item.relativePath ? item.relativePath.replace(/\\/g, '/') : item.file.name;
      if (
        rootFolderName &&
        rootFolderName !== 'Smart Drive' &&
        rootFolderName !== '/' &&
        !relPath.startsWith(rootFolderName + '/') &&
        relPath !== rootFolderName
      ) {
        relPath = `${rootFolderName}/${relPath}`;
      }

      const pathParts = relPath.split('/').filter(Boolean);
      pathParts.pop(); // remove file name

      if (pathParts.length > 0) {
        const dirKey = `${targetParentId ?? 'root'}:${pathParts.join('/')}`;
        if (!dirIdCache.has(dirKey)) {
          const ensureRes = await fetch('/api/vfs/folders/ensure-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId: targetParentId, pathParts }),
          });
          const ensureJson = await ensureRes.json();
          if (ensureJson.success && ensureJson.data) {
            dirIdCache.set(dirKey, ensureJson.data.id);
          } else {
            console.error('Failed to pre-create virtual directory hierarchy for', relPath, ensureJson.error);
            alert(`Failed to create directory structure for ${relPath}: ${ensureJson.error?.message || 'Error'}`);
            toast.style.display = 'none';
            activeClientUpload = null;
            return;
          }
        }
      }
    }

    // Refresh tree so user can immediately see the new folder structure
    loadTree();
    loadCurrentFolder();

    // 3. Now upload each physical file into its pre-resolved virtual folder
    for (let i = 0; i < items.length; i++) {
      if (isUploadCancelled) {
        toastTitle.textContent = 'Upload Cancelled';
        toastSpeed.textContent = `Stopped (${filesUploaded} / ${items.length} files saved)`;
        break;
      }

      const item = items[i];
      let relPath = item.relativePath ? item.relativePath.replace(/\\/g, '/') : item.file.name;
      if (
        rootFolderName &&
        rootFolderName !== 'Smart Drive' &&
        rootFolderName !== '/' &&
        !relPath.startsWith(rootFolderName + '/') &&
        relPath !== rootFolderName
      ) {
        relPath = `${rootFolderName}/${relPath}`;
      }

      const pathParts = relPath.split('/').filter(Boolean);
      const fileName = pathParts.pop(); // last part is filename
      const dirParts = pathParts; // directory parts

      // Keep toast active and visible
      toast.style.display = 'flex';
      toastTitle.textContent = `${rootFolderName} (${i + 1}/${items.length})`;
      toastSpeed.textContent = `Uploading: ${fileName}`;

      // Get target folder ID from pre-resolved directory cache
      let targetFolderId = targetParentId;
      if (dirParts.length > 0) {
        const dirKey = `${targetParentId ?? 'root'}:${dirParts.join('/')}`;
        targetFolderId = dirIdCache.get(dirKey) ?? targetParentId;
      }

      // Upload file to the target virtual folder with SKIP conflict policy (safe retry)
      const uploadUrl = targetFolderId !== null && targetFolderId !== undefined
        ? `/api/transfer/upload?parentId=${encodeURIComponent(targetFolderId)}`
        : '/api/transfer/upload';

      const formData = new FormData();
      if (targetFolderId !== null && targetFolderId !== undefined) {
        formData.append('parentId', targetFolderId.toString());
      }
      formData.append('conflictAction', 'SKIP');
      formData.append('file', item.file, fileName);

      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();

      if (json.success) {
        filesUploaded++;
        bytesUploaded += item.file.size;
        activeClientUpload.completedFiles = filesUploaded;
        activeClientUpload.completedBytes = bytesUploaded;

        const pct = totalBytes > 0 ? Math.round((bytesUploaded / totalBytes) * 100) : Math.round((filesUploaded / items.length) * 100);
        toast.style.display = 'flex';
        toastPct.textContent = `${pct}%`;
        toastBar.style.width = `${pct}%`;
        toastMeta.textContent = `${filesUploaded} / ${items.length} files (${formatBytes(bytesUploaded)} / ${formatBytes(totalBytes)})`;
        toastSpeed.textContent = `Uploaded: ${fileName}`;

        // If the user is currently viewing this exact folder or root, update live!
        if (currentParentId === targetFolderId || (currentParentId === null && targetFolderId === null)) {
          loadCurrentFolder();
        }
      } else {
        console.error(`Failed to upload ${item.relativePath}:`, json.error);
      }
    }

    activeClientUpload = null;

    if (!isUploadCancelled) {
      toastPct.textContent = '100%';
      toastBar.style.width = '100%';
      toastSpeed.textContent = `✓ Uploaded ${filesUploaded} files across storage`;
      toastDismissTimeout = setTimeout(() => {
        toast.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
      }, 3000);
    } else {
      toastDismissTimeout = setTimeout(() => {
        toast.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
      }, 3000);
    }
  } catch (err) {
    console.error('Folder upload error:', err);
    alert(`Folder upload error: ${err.message || 'Network error'}`);
    toast.style.display = 'none';
  } finally {
    activeClientUpload = null;
    refreshAll();
    autoSyncStorage();
  }
}

// Recursively traverse directory entries from HTML5 drag-and-drop
async function scanEntry(entry, currentPath = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    const relPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    return [{ file, relativePath: relPath }];
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await new Promise((resolve) => {
      const all = [];
      function readNext() {
        reader.readEntries((results) => {
          if (!results.length) {
            resolve(all);
          } else {
            all.push(...results);
            readNext();
          }
        });
      }
      readNext();
    });
    const subPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const subResults = await Promise.all(entries.map((e) => scanEntry(e, subPath)));
    return subResults.flat();
  }
  return [];
}

function setupDragAndDrop() {
  const dropZone = document.getElementById('dropZone');
  const overlay = document.getElementById('dropOverlay');

  ['dragenter', 'dragover'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      overlay.classList.add('active');
    });
  });

  ['dragleave', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      overlay.classList.remove('active');
    });
  });

  dropZone.addEventListener('drop', async (e) => {
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const scannedItems = [];
      let hasDirectory = false;
      let rootDirName = '';

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.webkitGetAsEntry) {
          const entry = item.webkitGetAsEntry();
          if (entry) {
            if (entry.isDirectory) {
              hasDirectory = true;
              if (!rootDirName) rootDirName = entry.name;
            }
            const found = await scanEntry(entry, '');
            scannedItems.push(...found);
          }
        }
      }

      if (scannedItems.length > 0) {
        if (hasDirectory) {
          await uploadFolderBatch(scannedItems, rootDirName || 'Dropped Folder', currentParentId);
        } else {
          for (const item of scannedItems) {
            await uploadSingleFile(item.file);
          }
          refreshAll();
          autoSyncStorage();
        }
        return;
      }
    }

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      for (const file of files) {
        await uploadSingleFile(file);
      }
      refreshAll();
      autoSyncStorage();
    }
  });
}

function setupDragToSelect() {
  const viewport = document.getElementById('filesViewport');
  if (!viewport) return;

  let marqueeBox = document.getElementById('marqueeSelectionBox');
  if (!marqueeBox) {
    marqueeBox = document.createElement('div');
    marqueeBox.id = 'marqueeSelectionBox';
    marqueeBox.className = 'marquee-selection-box';
    marqueeBox.style.display = 'none';
    document.body.appendChild(marqueeBox);
  }

  viewport.addEventListener('mousedown', (e) => {
    // Only trigger on primary left-click
    if (e.button !== 0) return;

    // Do NOT start marquee if clicking interactive controls OR clicking an existing file/folder item
    if (
      e.target.closest(
        'button, input, select, textarea, .col-actions, .context-menu, .modal-dialog, .icon-btn, .file-row, .grid-card, .file-row-header'
      )
    ) {
      return;
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (!isCtrl && !isShift) {
      clearSelection();
      closeContextMenu();
    }

    let isSelecting = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const initialSelected = isCtrl || isShift ? new Map(selectedNodes) : new Map();

    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      // Threshold to distinguish click from marquee dragging
      if (!isSelecting && Math.hypot(dx, dy) > 4) {
        isSelecting = true;
        marqueeBox.style.display = 'block';
      }

      if (isSelecting) {
        // Prevent accidental text selection during rectangle drag
        moveEvent.preventDefault();
        if (window.getSelection) {
          window.getSelection().removeAllRanges();
        }

        // Auto-scroll viewport if dragging near top or bottom edges
        const vpRect = viewport.getBoundingClientRect();
        const edgeZone = 40;
        if (moveEvent.clientY > vpRect.bottom - edgeZone) {
          viewport.scrollTop += 14;
        } else if (moveEvent.clientY < vpRect.top + edgeZone) {
          viewport.scrollTop -= 14;
        }

        const minX = Math.min(startX, moveEvent.clientX);
        const maxX = Math.max(startX, moveEvent.clientX);
        const minY = Math.min(startY, moveEvent.clientY);
        const maxY = Math.max(startY, moveEvent.clientY);

        marqueeBox.style.left = `${minX}px`;
        marqueeBox.style.top = `${minY}px`;
        marqueeBox.style.width = `${maxX - minX}px`;
        marqueeBox.style.height = `${maxY - minY}px`;

        // Check intersection with all file items currently displayed
        const itemElements = document.querySelectorAll('.file-row, .grid-card');
        itemElements.forEach((el) => {
          const id = parseInt(el.dataset.id, 10);
          const item = currentItems.find((i) => i.id === id);
          if (!item) return;

          const r = el.getBoundingClientRect();
          const intersects = !(r.right < minX || r.left > maxX || r.bottom < minY || r.top > maxY);

          if (intersects) {
            selectedNodes.set(id, item);
          } else {
            if (initialSelected.has(id)) {
              selectedNodes.set(id, initialSelected.get(id));
            } else {
              selectedNodes.delete(id);
            }
          }
        });

        selectedNode = selectedNodes.size === 1 ? Array.from(selectedNodes.values())[0] : null;
        updateSelectionUI();
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      if (isSelecting) {
        isSelecting = false;
        wasMarqueeDragging = true;
        marqueeBox.style.display = 'none';
        setTimeout(() => {
          wasMarqueeDragging = false;
        }, 150);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

function downloadFile(fileId) {
  window.location.href = `/api/transfer/download/${fileId}`;
}

// ==========================================
// Dialogs & Modals
// ==========================================
function handleCreateFolderPrompt() {
  const name = prompt('Enter folder name:');
  if (!name || !name.trim()) return;

  fetch('/api/vfs/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), parentId: currentParentId }),
  })
    .then((r) => r.json())
    .then((json) => {
      if (json.success) refreshAll();
      else alert('Error: ' + json.error.message);
    })
    .catch(() => alert('Failed to create folder'));
}

let renamingNodeId = null;
function openRenameModal(node) {
  renamingNodeId = node.id;
  const modal = document.getElementById('renameModal');
  const input = document.getElementById('renameInput');
  input.value = node.name;
  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

function closeRenameModal() {
  document.getElementById('renameModal').style.display = 'none';
  renamingNodeId = null;
}

async function submitRename() {
  const newName = document.getElementById('renameInput').value.trim();
  if (!newName || !renamingNodeId) return;

  try {
    const res = await fetch(`/api/vfs/nodes/${renamingNodeId}/rename`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName }),
    });
    const json = await res.json();
    if (json.success) {
      closeRenameModal();
      refreshAll();
    } else {
      alert('Rename failed: ' + json.error.message);
    }
  } catch {
    alert('Failed to rename item');
  }
}

let isOperationInProgress = false;

async function handleTrashSelectedNodes() {
  if (isOperationInProgress) return;
  const items = Array.from(selectedNodes.values());
  const count = items.length;
  if (count === 0) return;

  if (currentViewMode === 'TRASH') {
    return handlePermanentDeleteSelectedNodes();
  }

  const msg = count === 1 ? `Move "${items[0].name}" to Trash Bin?` : `Move ${count} items to Trash Bin?`;
  if (!confirm(msg)) return;

  isOperationInProgress = true;
  const trashBtn = document.getElementById('toolbarTrashBtn');
  if (trashBtn) trashBtn.disabled = true;

  try {
    const res = await fetch('/api/vfs/trash/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: items.map((i) => i.id) }),
    });
    const json = await res.json();
    if (!json.success) {
      alert(`Failed to trash items: ${json.error?.message || 'Error'}`);
    }
  } catch (err) {
    console.error('Trash error:', err);
    alert('Failed to trash selected items');
  } finally {
    isOperationInProgress = false;
    if (trashBtn) trashBtn.disabled = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handleTrashNode(fileId) {
  if (isOperationInProgress) return;
  if (currentViewMode === 'TRASH') {
    return handlePermanentDeleteNode(fileId);
  }

  if (!confirm('Move item to Trash Bin?')) return;
  isOperationInProgress = true;

  try {
    await fetch(`/api/vfs/nodes/${fileId}/trash`, { method: 'DELETE' });
  } catch (err) {
    console.error('Trash node error:', err);
    alert('Failed to trash item');
  } finally {
    isOperationInProgress = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handleRestoreNode(fileId) {
  if (isOperationInProgress) return;
  isOperationInProgress = true;

  try {
    const res = await fetch(`/api/vfs/nodes/${fileId}/restore`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) {
      alert('Restore failed: ' + (json.error?.message || 'Conflict occurred'));
    }
  } catch (err) {
    console.error('Restore node error:', err);
    alert('Failed to restore item');
  } finally {
    isOperationInProgress = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handleRestoreSelectedNodes() {
  if (isOperationInProgress) return;
  const items = Array.from(selectedNodes.values());
  const count = items.length;
  if (count === 0) return;

  isOperationInProgress = true;
  const restoreBtn = document.getElementById('toolbarRestoreBtn');
  if (restoreBtn) restoreBtn.disabled = true;

  try {
    const res = await fetch('/api/vfs/restore/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: items.map((i) => i.id) }),
    });
    const json = await res.json();
    if (!json.success) {
      alert(`Failed to restore items: ${json.error?.message || 'Error'}`);
    }
  } catch (err) {
    console.error('Restore batch error:', err);
    alert('Failed to restore selected items');
  } finally {
    isOperationInProgress = false;
    if (restoreBtn) restoreBtn.disabled = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handlePermanentDeleteNode(fileId) {
  if (isOperationInProgress) return;
  if (!confirm('Permanently delete this item? This will physically remove the file from Google Drive and cannot be undone.')) return;

  isOperationInProgress = true;
  try {
    const res = await fetch(`/api/vfs/nodes/${fileId}/permanent`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) {
      alert('Delete failed: ' + (json.error?.message || 'Error'));
    }
  } catch (err) {
    console.error('Permanent delete error:', err);
    alert('Failed to permanently delete item');
  } finally {
    isOperationInProgress = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handlePermanentDeleteSelectedNodes() {
  if (isOperationInProgress) return;
  const items = Array.from(selectedNodes.values());
  const count = items.length;
  if (count === 0) return;

  const msg = count === 1
    ? `Permanently delete "${items[0].name}"? This will physically delete the file from Google Drive and cannot be undone.`
    : `Permanently delete ${count} items? This will physically delete the files from Google Drive and cannot be undone.`;
  if (!confirm(msg)) return;

  isOperationInProgress = true;
  const permBtn = document.getElementById('toolbarPermanentDeleteBtn');
  if (permBtn) permBtn.disabled = true;

  try {
    const res = await fetch('/api/vfs/permanent/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: items.map((i) => i.id) }),
    });
    const json = await res.json();
    if (!json.success) {
      alert(`Failed to permanently delete items: ${json.error?.message || 'Error'}`);
    }
  } catch (err) {
    console.error('Permanent delete batch error:', err);
    alert('Failed to permanently delete selected items');
  } finally {
    isOperationInProgress = false;
    if (permBtn) permBtn.disabled = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

async function handleEmptyTrash() {
  if (isOperationInProgress) return;
  if (!confirm('Permanently delete all items in the Trash Bin? This will physically purge all files from Google Drive.')) return;

  isOperationInProgress = true;
  const emptyBtn = document.getElementById('emptyTrashBtn');
  if (emptyBtn) emptyBtn.disabled = true;

  try {
    const res = await fetch('/api/vfs/trash/empty', { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      alert(`Purged ${json.data.deletedCount} items from Trash.`);
    } else {
      alert('Failed to empty trash: ' + (json.error?.message || 'Error'));
    }
  } catch (err) {
    console.error('Empty trash error:', err);
    alert('Failed to empty trash');
  } finally {
    isOperationInProgress = false;
    if (emptyBtn) emptyBtn.disabled = false;
    clearSelection();
    closeInspector();
    refreshAll();
  }
}

// ==========================================
// Inspector Drawer
// ==========================================
async function openFileProperties(fileId) {
  try {
    const res = await fetch(`/api/search/properties/${fileId}`);
    const json = await res.json();
    if (json.success) {
      const data = json.data;
      const drawer = document.getElementById('inspectorDrawer');
      const content = document.getElementById('inspectorContent');
      const isTrash = currentViewMode === 'TRASH';

      content.innerHTML = `
        <div class="inspector-prop-row">
          <div class="inspector-prop-label">Name</div>
          <div class="inspector-prop-value" style="font-weight:600;">${escapeHtml(data.name)}</div>
        </div>
        <div class="inspector-prop-row">
          <div class="inspector-prop-label">Virtual Path</div>
          <div class="inspector-prop-value mono">${escapeHtml(data.virtualPath)}</div>
        </div>
        <div class="inspector-prop-row">
          <div class="inspector-prop-label">File Size</div>
          <div class="inspector-prop-value mono">${formatBytes(data.size)} (${data.size.toLocaleString()} bytes)</div>
        </div>
        <div class="inspector-prop-row">
          <div class="inspector-prop-label">MIME Type</div>
          <div class="inspector-prop-value mono">${escapeHtml(data.mimeType)}</div>
        </div>
        ${
          data.physicalLocation
            ? `
          <div class="inspector-prop-row">
            <div class="inspector-prop-label">Physical Google Drive</div>
            <div class="inspector-prop-value" style="color:var(--accent-primary);">
              ${escapeHtml(data.physicalLocation.googleAccountName)}<br>
              <small style="color:var(--text-tertiary);">${escapeHtml(data.physicalLocation.googleAccountEmail)}</small>
            </div>
          </div>
          <div class="inspector-prop-row">
            <div class="inspector-prop-label">Provider File ID</div>
            <div class="inspector-prop-value mono" style="font-size:0.72rem;">${escapeHtml(data.physicalLocation.providerFileId)}</div>
          </div>
          <div class="inspector-prop-row">
            <div class="inspector-prop-label">Checksum (${data.physicalLocation.checksumType || 'MD5'})</div>
            <div class="inspector-prop-value mono" style="font-size:0.72rem;">${escapeHtml(data.physicalLocation.checksum || 'N/A')}</div>
          </div>
        `
            : ''
        }
        <div style="margin-top: 20px; display: flex; flex-direction: column; gap: 8px;">
          ${!data.isFolder && !isTrash ? `<button class="btn btn-primary" onclick="downloadFile(${data.fileId})">Download File</button>` : ''}
          ${isTrash ? `<button class="btn btn-primary" onclick="handleRestoreNode(${data.fileId})">Restore Item</button>` : ''}
          ${!isTrash ? `<button class="btn btn-secondary" onclick="openRenameModal({ id: ${data.fileId}, name: '${escapeHtml(data.name)}' })">Rename</button>` : ''}
          ${!isTrash ? `<button class="btn btn-secondary btn-destructive" onclick="handleTrashNode(${data.fileId})">Move to Trash</button>` : ''}
          ${isTrash ? `<button class="btn btn-secondary btn-destructive" onclick="handlePermanentDeleteNode(${data.fileId})">Delete Forever</button>` : ''}
        </div>
      `;

      drawer.style.display = 'flex';
    }
  } catch (err) {
    console.error('Properties load failed:', err);
  }
}

function closeInspector() {
  document.getElementById('inspectorDrawer').style.display = 'none';
}

// ==========================================
// Accounts & Stats Modals
// ==========================================
function openAccountsModal() {
  document.getElementById('accountsModal').style.display = 'flex';
  renderAccountsTable();
}

function closeAccountsModal() {
  document.getElementById('accountsModal').style.display = 'none';
}

async function renderAccountsTable() {
  try {
    const res = await fetch('/api/accounts');
    const json = await res.json();
    if (json.success) {
      const tbody = document.getElementById('accountsTableBody');
      tbody.innerHTML = '';
      if (!json.data || json.data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-tertiary); padding:20px;">No Google Drive accounts connected. Click "+ Connect Google Account" above.</td></tr>`;
        return;
      }
      json.data.forEach((acc) => {
        const tr = document.createElement('tr');
        const usedGB = (acc.usedSpace / (1024 ** 3)).toFixed(2);
        const totalGB = (acc.totalSpace / (1024 ** 3)).toFixed(2);
        tr.innerHTML = `
          <td><strong>${escapeHtml(acc.displayName)}</strong><br><small style="color:var(--text-tertiary); font-family:var(--font-mono);">${escapeHtml(acc.email)}</small></td>
          <td><span class="brand-badge"><span class="status-dot ${acc.status === 'AVAILABLE' ? 'online' : ''}"></span>${acc.status}</span></td>
          <td style="font-family:var(--font-mono); font-weight:600;">${usedGB} / ${totalGB} GB</td>
          <td>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.75rem;">
              <input type="checkbox" ${acc.migrationLocked ? 'checked' : ''} onchange="toggleLock(${acc.id}, this.checked)">
              <span>${acc.migrationLocked ? 'Locked' : 'Unlocked'}</span>
            </label>
          </td>
          <td>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-secondary btn-xs" title="Scan & Import files from this drive" onclick="handleImportSingleAccount(${acc.id})">Import</button>
              <button class="btn btn-secondary btn-xs btn-destructive" onclick="handleRetireDrive(${acc.id})">Retire</button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Failed to render accounts:', err);
  }
}

window.handleImportSingleAccount = async function (id) {
  try {
    const res = await fetch(`/api/accounts/${id}/import`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(`Import complete: Added ${json.data.importedCount} new file(s) into Smart Drive (${json.data.skippedCount} already synced).`);
      refreshAll();
    } else {
      alert('Import failed: ' + (json.error?.message || 'Unknown error'));
    }
  } catch {
    alert('Import request failed');
  }
};

window.handleImportAllFiles = async function () {
  try {
    const res = await fetch('/api/accounts/import-all', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      const total = json.data.reduce((sum, r) => sum + r.importedCount, 0);
      alert(`Scan complete: Imported ${total} new file(s) across all Google Drive accounts.`);
      refreshAll();
    } else {
      alert('Import failed: ' + (json.error?.message || 'Unknown error'));
    }
  } catch {
    alert('Import request failed');
  }
};

window.toggleLock = async function (id, locked) {
  await fetch(`/api/accounts/${id}/lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked }),
  });
  refreshAll();
  renderAccountsTable();
};

window.handleRetireDrive = async function (id) {
  if (!confirm('Are you sure you want to retire this drive? All stored files will be evacuated to other connected drives.')) return;
  try {
    const res = await fetch(`/api/accounts/${id}/retire`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(json.data.message);
      refreshAll();
      renderAccountsTable();
    } else {
      alert('Retirement failed: ' + json.error.message);
    }
  } catch {
    alert('Retirement request failed');
  }
};

window.addEventListener('message', (event) => {
  if (event.data?.type === 'GOOGLE_DRIVE_CONNECTED') {
    refreshAll();
    renderAccountsTable();
    autoSyncStorage();
  }
});

async function handleConnectAccount() {
  try {
    const res = await fetch('/api/accounts/auth-url');
    const json = await res.json();
    if (json.success && json.data.authUrl) {
      const popup = window.open(
        json.data.authUrl,
        'Google OAuth',
        'width=600,height=700,status=no,resizable=yes,scrollbars=yes'
      );
      const timer = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(timer);
          refreshAll();
          renderAccountsTable();
          autoSyncStorage();
        }
      }, 1000);
    }
  } catch {
    alert('Failed to initiate OAuth flow.');
  }
}

async function handleSyncQuotas() {
  try {
    await fetch('/api/capacity/sync', { method: 'POST' });
    refreshAll();
    renderAccountsTable();
  } catch {
    alert('Quota sync failed');
  }
}

async function openStatsModal() {
  document.getElementById('statsModal').style.display = 'flex';
  const body = document.getElementById('statsModalBody');
  body.innerHTML = '<div style="color:var(--text-tertiary); padding:24px; text-align:center;">Calculating storage metrics...</div>';

  try {
    const res = await fetch('/api/stats');
    const json = await res.json();
    if (json.success) {
      const s = json.data;
      body.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom: 16px;">
          <div class="drive-pill-compact" style="padding:12px;">
            <div class="pill-label">Smart Files (Logical)</div>
            <div style="font-size:1.25rem; font-weight:700; color:var(--accent-primary); font-family:var(--font-mono);">${formatBytes(s.totalLogicalBytes)}</div>
            <div style="font-size:0.72rem; color:var(--text-tertiary);">${s.totalFiles} Files, ${s.totalFolders} Folders</div>
          </div>
          <div class="drive-pill-compact" style="padding:12px;">
            <div class="pill-label">Google Cloud (Physical)</div>
            <div style="font-size:1.25rem; font-weight:700; color:var(--text-primary); font-family:var(--font-mono);">${formatBytes(s.totalPhysicalBytes)}</div>
            <div style="font-size:0.72rem; color:var(--text-tertiary);">${formatBytes(s.totalUsableBytes)} Free on Google</div>
          </div>
          <div class="drive-pill-compact" style="padding:12px;">
            <div class="pill-label">Total Uploaded</div>
            <div style="font-size:1.25rem; font-weight:700; color:var(--accent-emerald); font-family:var(--font-mono);">${formatBytes(s.totalUploadedBytes)}</div>
            <div style="font-size:0.72rem; color:var(--text-tertiary);">${formatBytes(s.totalDownloadedBytes)} Downloaded</div>
          </div>
          <div class="drive-pill-compact" style="padding:12px;">
            <div class="pill-label">Migrations</div>
            <div style="font-size:1.25rem; font-weight:700; color:var(--accent-amber); font-family:var(--font-mono);">${formatBytes(s.totalMigratedBytes)}</div>
            <div style="font-size:0.72rem; color:var(--text-tertiary);">${s.totalTrashItems} Trashed Items</div>
          </div>
        </div>

        <h4 style="font-size:0.85rem; font-weight:600; margin-bottom:8px;">Connected Google Drives Breakdown</h4>
        <div class="table-container">
          <table class="native-table">
            <thead>
              <tr>
                <th>Drive Account</th>
                <th>Status</th>
                <th>Google Quota (Used / Total)</th>
                <th>Smart Files Placed</th>
                <th>Sync Status</th>
              </tr>
            </thead>
            <tbody>
              ${s.drives.map((d) => `
                <tr>
                  <td><strong>${escapeHtml(d.displayName)}</strong><br><small style="color:var(--text-tertiary); font-family:var(--font-mono);">${escapeHtml(d.email)}</small></td>
                  <td><span class="brand-badge"><span class="status-dot ${d.status === 'AVAILABLE' ? 'online' : ''}"></span>${d.status}</span></td>
                  <td style="font-family:var(--font-mono); font-weight:600;">${formatBytes(d.usedCapacity)} / ${formatBytes(d.totalCapacity)}</td>
                  <td>${d.fileCount} files</td>
                  <td><span style="color:var(--accent-emerald); font-size:0.75rem;">✓ Synced</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  } catch {
    body.innerHTML = '<div style="color:var(--accent-rose); padding:20px;">Failed to load statistics</div>';
  }
}

function closeStatsModal() {
  document.getElementById('statsModal').style.display = 'none';
}

async function loadAccountsSummary() {
  try {
    const res = await fetch('/api/accounts');
    const json = await res.json();
    if (json.success) {
      const container = document.getElementById('drivesSummaryList');
      container.innerHTML = '';
      if (!json.data || json.data.length === 0) {
        container.innerHTML = `<div style="font-size:0.72rem; color:var(--text-tertiary); padding:4px 8px;">No drives connected</div>`;
        return;
      }
      json.data.forEach((acc) => {
        const div = document.createElement('div');
        div.className = 'drive-pill-compact';
        const usedText = formatBytes(acc.usedSpace);
        const totalText = formatBytes(acc.totalSpace);
        const pct = acc.totalSpace > 0 ? ((acc.usedSpace / acc.totalSpace) * 100).toFixed(1) : 0;
        div.innerHTML = `
          <div class="drive-pill-top">
            <span class="drive-pill-name">${escapeHtml(acc.displayName)}</span>
            <span class="status-dot ${acc.status === 'AVAILABLE' ? 'online' : ''}"></span>
          </div>
          <div class="drive-pill-bar">
            <div class="drive-pill-fill" style="width: ${Math.max(1, pct)}%;"></div>
          </div>
          <div class="drive-pill-meta">${usedText} / ${totalText} (${pct}%)</div>
        `;
        div.addEventListener('click', openAccountsModal);
        container.appendChild(div);
      });
    }
  } catch (err) {
    console.error('Accounts summary failed:', err);
  }
}

async function loadRecentOperationsView() {
  try {
    const res = await fetch('/api/operations/recent');
    const json = await res.json();
    const container = document.getElementById('itemsContainer');
    const emptyState = document.getElementById('emptyState');
    container.innerHTML = '';

    if (!json.success || !json.data || json.data.length === 0) {
      emptyState.style.display = 'flex';
      emptyState.querySelector('.empty-state-title').textContent = 'No recent operations';
      emptyState.querySelector('.empty-state-desc').textContent = 'Completed storage operations will appear here.';
      return;
    }
    emptyState.style.display = 'none';

    const table = document.createElement('table');
    table.className = 'native-table';
    table.style.margin = '16px 20px';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Operation ID</th>
          <th>Type</th>
          <th>Status</th>
          <th>Size</th>
          <th>Timestamp</th>
        </tr>
      </thead>
      <tbody>
        ${json.data.map((op) => `
          <tr>
            <td style="font-family:var(--font-mono); font-size:0.75rem;"><code>${escapeHtml(op.id)}</code></td>
            <td><strong>${escapeHtml(op.operationType)}</strong></td>
            <td><span class="brand-badge"><span class="status-dot ${op.status === 'COMPLETED' ? 'online' : ''}"></span>${op.status}</span></td>
            <td style="font-family:var(--font-mono);">${formatBytes(op.requestedBytes || 0)}</td>
            <td style="font-size:0.72rem; color:var(--text-tertiary);">${new Date(op.createdAt).toLocaleString()}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    container.appendChild(table);
  } catch (err) {
    console.error('Recent operations error:', err);
  }
}

async function loadTrashView() {
  try {
    const res = await fetch('/api/vfs/trash');
    const json = await res.json();
    if (json.success) {
      currentItems = json.data || [];
      renderItems(currentItems);
    }
  } catch (err) {
    console.error('Trash view error:', err);
  }
}

function setupSearchAndShortcuts() {
  const searchInput = document.getElementById('searchInput');
  let searchDebounceTimer = null;
  let searchAbortController = null;

  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (searchAbortController) searchAbortController.abort();

    if (!q) {
      loadCurrentFolder();
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      searchAbortController = new AbortController();
      fetch(`/api/search?query=${encodeURIComponent(q)}`, { signal: searchAbortController.signal })
        .then((r) => r.json())
        .then((json) => {
          if (json.success) renderItems(json.data);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') console.error('Search error:', err);
        });
    }, 300);
  });

  window.addEventListener('keydown', (e) => {
    const isInputActive = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    // Ctrl + A -> Select All Items (when not typing in an input)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !isInputActive) {
      e.preventDefault();
      selectAllItems();
    }

    // Ctrl + K -> Search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }

    // F2 -> Rename selected (single item)
    if (e.key === 'F2' && selectedNodes.size === 1) {
      e.preventDefault();
      const node = Array.from(selectedNodes.values())[0];
      openRenameModal(node);
    }

    // Delete -> Trash selected items (or Delete Forever in Trash view / Shift+Delete)
    if (e.key === 'Delete' && selectedNodes.size > 0 && !isInputActive) {
      e.preventDefault();
      if (currentViewMode === 'TRASH' || e.shiftKey) {
        handlePermanentDeleteSelectedNodes();
      } else {
        handleTrashSelectedNodes();
      }
    }

    // Escape -> Close all overlays
    if (e.key === 'Escape') {
      closeContextMenu();
      closeRenameModal();
      closeStatsModal();
      closeAccountsModal();
      closeInspector();
      clearSelection();
    }
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
