/**
 * main.js — Frontend Logic untuk Google Drive Aggregator (9Drive Theme)
 * Mengelola: fetch data, render UI, drag-and-drop upload, file actions, tab navigation, search, filter, and layout toggles.
 */

// ============================================================
// State
// ============================================================
const state = {
    accounts: [],
    quota: null,
    files: [],
    currentFolder: 'root',
    currentAccountId: null, // null = semua akun (merged view)
    breadcrumbs: [{ name: 'Drive Saya', folderId: 'root', accountId: null }],
    isLoading: false,
    viewMode: 'list', // 'list' atau 'grid'
    searchQuery: '',
    currentTab: 'explorer', // Default to All Files tab
    activeUploadXhr: null,
    uploadPaused: false,
    uploadCancelled: false,
    notifications: [],
    unreadNotificationsCount: 0,
};

// Colors mapping for accounts
const ACCOUNT_COLORS = ['#6366f1', '#a855f7', '#06b6d4', '#f59e0b', '#10b981', '#ec4899', '#ef4444'];

// ============================================================
// Utility
// ============================================================
function formatBytes(bytes, decimals = 1) {
    if (bytes === undefined || bytes === null) return '0 B';
    const numBytes = parseInt(bytes);
    if (isNaN(numBytes) || numBytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(numBytes) / Math.log(k));
    return parseFloat((numBytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getFileIcon(mimeType) {
    if (!mimeType) return '📎';
    if (mimeType === 'application/vnd.google-apps.folder') return '📁';
    if (mimeType.includes('image')) return '🖼️';
    if (mimeType.includes('video')) return '🎬';
    if (mimeType.includes('audio')) return '🎵';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📑';
    if (mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('text')) return '📄';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('archive')) return '📦';
    if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('html') || mimeType.includes('css') || mimeType.includes('python')) return '💻';
    return '📎';
}

function getAccountEmail(accountId) {
    const account = state.accounts.find(a => a.id === accountId);
    return account ? account.email : 'Akun';
}

function renderAccountBadgeHTML(file) {
    if (file.is_gpart && file.parts && file.parts.length > 0) {
        const emails = file.parts.map(p => getAccountEmail(p.account_id));
        const uniqueEmails = [...new Set(emails)].filter(e => e && e !== 'Akun');
        const emailList = uniqueEmails.join(', ');
        const displayLabel = uniqueEmails.map(e => e.split('@')[0]).join(', ');
        return `<span class="file-account-badge combined-badge" title="Tersimpan di: ${emailList}">👥 Gabungan (${displayLabel})</span>`;
    } else {
        const email = getAccountEmail(file.account_id);
        return `<span class="file-account-badge" title="${email}">👤 ${email.split('@')[0]}</span>`;
    }
}

function getAccountColor(accountId) {
    const idx = state.accounts.findIndex(a => a.id === accountId);
    return ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length] || ACCOUNT_COLORS[0];
}

function getAccountLabel(accountId) {
    const account = state.accounts.find(a => a.id === accountId);
    if (!account) return 'Akun';
    const email = account.email;
    return email.split('@')[0];
}

// ============================================================
// API Functions
// ============================================================
async function fetchAccounts() {
    try {
        const res = await fetch('/api/accounts');
        state.accounts = await res.json();
    } catch (err) {
        showToast('Gagal memuat data akun', 'error');
    }
}

async function fetchQuota() {
    try {
        const res = await fetch('/api/quota');
        state.quota = await res.json();
    } catch (err) {
        showToast('Gagal memuat kuota', 'error');
    }
}

async function fetchFiles(folderId = 'root', accountId = null, fileType = null) {
    state.isLoading = true;
    renderFiles();
    try {
        let url = `/api/files?folder_id=${folderId}`;
        if (accountId) url += `&account_id=${accountId}`;
        if (fileType) url += `&type=${fileType}`;
        const res = await fetch(url);
        state.files = await res.json();
        state.currentFolder = folderId;
        state.currentAccountId = accountId;
    } catch (err) {
        showToast('Gagal memuat file', 'error');
        state.files = [];
    }
    state.isLoading = false;
    
    // Check if loading files for Starred/Shared tabs, render them in their containers
    if (state.currentTab === 'shared' || state.currentTab === 'starred') {
        renderFilesForTab(state.currentTab, state.files);
    } else {
        renderFiles();
    }
}

async function deleteFileApi(fileId, accountId) {
    try {
        const res = await fetch(`/api/delete/${fileId}?account_id=${accountId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Item berhasil dihapus', 'success');
            refreshAll();
        } else {
            showToast(data.error || 'Gagal menghapus file', 'error');
        }
    } catch (err) {
        showToast('Gagal menghapus file', 'error');
    }
}

async function renameFileApi(fileId, accountId, newName) {
    try {
        const res = await fetch(`/api/rename/${fileId}?account_id=${accountId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
        const data = await res.json();
        if (data.id) {
            showToast('Berhasil diubah namanya', 'success');
            refreshAll();
        } else {
            showToast(data.error || 'Gagal mengubah nama', 'error');
        }
    } catch (err) {
        showToast('Gagal mengubah nama', 'error');
    }
}

async function uploadFileApi(file) {
    while (true) {
        if (state.uploadCancelled) {
            break;
        }

        try {
            showUploadProgress(true, 0, file.name);
            addNotification('uploading', `Memulai upload "${file.name}"...`);

            await new Promise((resolve, reject) => {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('folder_id', state.currentFolder);

                const xhr = new XMLHttpRequest();
                state.activeUploadXhr = xhr;

                let progressInterval = null;
                const cleanInterval = () => {
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                };

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        if (!state.uploadPaused && !state.uploadCancelled) {
                            if (pct < 100) {
                                showUploadProgress(true, pct, file.name);
                            } else {
                                showUploadProgress(true, 100, file.name);
                                // Mulai polling progress upload dari server lokal ke Google Drive
                                if (!progressInterval) {
                                    const textEl = document.getElementById('upload-progress-text');
                                    const fillEl = document.getElementById('upload-progress-fill');
                                    if (textEl) textEl.textContent = `Memproses & Mengupload ke Google Drive "${file.name}"...`;
                                    progressInterval = setInterval(async () => {
                                        if (state.uploadCancelled || state.uploadPaused) {
                                            cleanInterval();
                                            return;
                                        }
                                        try {
                                            const res = await fetch(`/api/upload/progress?filename=${encodeURIComponent(file.name)}`);
                                            const data = await res.json();
                                            if (data.percentage > 0) {
                                                const displayPct = Math.round(data.percentage);
                                                if (fillEl) fillEl.style.width = displayPct + '%';
                                                if (textEl) textEl.textContent = `Mengupload ke Google Drive "${file.name}"... ${displayPct}%`;
                                            }
                                        } catch (e) {}
                                    }, 1000);
                                }
                            }
                        }
                    }
                });

                xhr.onload = () => {
                    cleanInterval();
                    if (xhr.status === 200) {
                        try {
                            const data = JSON.parse(xhr.responseText);
                            if (data.success) {
                                showToast(`"${file.name}" berhasil di-upload ke ${data.uploaded_to}`, 'success');
                                addNotification('success', `Berhasil mengupload "${file.name}" ke ${data.uploaded_to}`);
                            } else {
                                showToast(data.error || 'Upload gagal', 'error');
                                addNotification('error', `Gagal mengupload "${file.name}": ${data.error || 'Terjadi kesalahan'}`);
                            }
                        } catch (e) {
                            showToast('Upload gagal parsing respon server', 'error');
                            addNotification('error', `Gagal mengupload "${file.name}": Respon server tidak valid`);
                        }
                        resolve(true);
                    } else {
                        addNotification('error', `Gagal mengupload "${file.name}": Status HTTP ${xhr.status}`);
                        reject(new Error('Upload gagal dengan status ' + xhr.status));
                    }
                };

                xhr.onabort = () => {
                    cleanInterval();
                    reject(new Error('Aborted'));
                };

                xhr.onerror = () => {
                    cleanInterval();
                    reject(new Error('Kesalahan jaringan'));
                };

                xhr.open('POST', '/api/upload');
                xhr.send(formData);
            });

            break;
        } catch (err) {
            if (state.uploadCancelled) {
                showToast('Upload dibatalkan', 'info');
                addNotification('cancelled', `Upload "${file.name}" dibatalkan.`);
                break;
            }

            if (state.uploadPaused) {
                showToast('Upload di-jeda', 'info');
                addNotification('info', `Upload "${file.name}" di-jeda.`);
                updatePauseButtonUI(true);

                await new Promise((resolveWait) => {
                    const checkInterval = setInterval(() => {
                        if (!state.uploadPaused || state.uploadCancelled) {
                            clearInterval(checkInterval);
                            resolveWait();
                        }
                    }, 200);
                });

                if (state.uploadCancelled) {
                    showToast('Upload dibatalkan', 'info');
                    addNotification('cancelled', `Upload "${file.name}" dibatalkan.`);
                    break;
                }

                showToast('Melanjutkan upload...', 'info');
                updatePauseButtonUI(false);
                continue;
            }

            showToast('Upload gagal: ' + err.message, 'error');
            addNotification('error', `Gagal mengupload "${file.name}": ${err.message || 'Kesalahan koneksi'}`);
            break;
        }
    }

    state.activeUploadXhr = null;
    showUploadProgress(false);
    refreshAll();
}

async function removeAccount(accountId) {
    try {
        const res = await fetch(`/api/accounts/${accountId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Koneksi akun Google Drive berhasil dihapus', 'success');
            refreshAll();
        } else {
            showToast(data.error || 'Gagal menghapus akun', 'error');
        }
    } catch (err) {
        showToast('Gagal menghapus akun', 'error');
    }
}

async function fetchDebugInfo() {
    try {
        const res = await fetch('/api/debug');
        const debugData = await res.json();
        renderDebugInfo(debugData);
    } catch (err) {
        console.error('Failed to fetch debug info:', err);
    }
}

// ============================================================
// Render Functions
// ============================================================
function renderUserProfile() {
    const emailEl = document.getElementById('sidebar-email');
    const avatarEl = document.getElementById('sidebar-avatar');
    if (!emailEl || !avatarEl) return;

    if (state.accounts && state.accounts.length > 0) {
        const primaryAccount = state.accounts[0];
        emailEl.textContent = primaryAccount.email;
        const initial = (primaryAccount.display_name || primaryAccount.email).substring(0, 1).toUpperCase();
        avatarEl.textContent = initial;
    } else {
        emailEl.textContent = 'Belum Terhubung';
        avatarEl.textContent = '☁️';
    }
}

function renderStorageBar() {
    const sidebarFill = document.getElementById('sidebar-storage-fill');
    const sidebarText = document.getElementById('sidebar-storage-text');

    const statUsed = document.getElementById('stat-used');
    const statFree = document.getElementById('stat-free');
    const statTotal = document.getElementById('stat-total');
    const statAccounts = document.getElementById('stat-accounts-count');

    // Default empty state values
    if (!state.quota || !state.quota.accounts || state.quota.accounts.length === 0) {
        if (sidebarFill) sidebarFill.style.width = '0%';
        if (sidebarText) sidebarText.textContent = '0 B terpakai';

        if (statUsed) statUsed.textContent = '0.00 GB';
        if (statFree) statFree.textContent = '0.00 GB';
        if (statTotal) statTotal.textContent = '0.00 GB';
        if (statAccounts) statAccounts.textContent = '0';
        
        updateCategoryBreakdown();
        return;
    }

    const q = state.quota;
    const usedFormatted = formatBytes(q.used);
    const totalFormatted = formatBytes(q.total);
    const freeFormatted = formatBytes(q.total - q.used);
    const pctTotal = q.total > 0 ? ((q.used / q.total) * 100).toFixed(1) : 0;

    // Sidebar indicators
    if (sidebarFill) sidebarFill.style.width = `${pctTotal}%`;
    if (sidebarText) sidebarText.textContent = `${usedFormatted} of ${totalFormatted}`;

    // Quota Tracker Metrics stat cards indicators
    if (statUsed) statUsed.textContent = usedFormatted;
    if (statFree) statFree.textContent = freeFormatted;
    if (statTotal) statTotal.textContent = totalFormatted;
    if (statAccounts) statAccounts.textContent = state.accounts.length;

    updateCategoryBreakdown();
}

function updateCategoryBreakdown() {
    let photoSize = 0;
    let videoSize = 0;
    let docSize = 0;

    // Scan loaded files array to calculate local breakdown categories
    state.files.forEach(file => {
        const size = parseInt(file.size || 0);
        const mime = (file.mimeType || '').toLowerCase();
        const name = (file.name || '').toLowerCase();

        if (mime.includes('image') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.gif') || name.endsWith('.webp')) {
            photoSize += size;
        } else if (mime.includes('video') || mime.includes('audio') || name.endsWith('.mp4') || name.endsWith('.mkv') || name.endsWith('.avi') || name.endsWith('.mp3') || name.endsWith('.wav')) {
            videoSize += size;
        } else if (mime.includes('document') || mime.includes('spreadsheet') || mime.includes('presentation') || mime.includes('pdf') || name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.xlsx') || name.endsWith('.pptx') || name.endsWith('.txt')) {
            docSize += size;
        }
    });

    const photoEl = document.getElementById('sidebar-quota-photo');
    const videoEl = document.getElementById('sidebar-quota-video');
    const docEl = document.getElementById('sidebar-quota-document');
    const freeEl = document.getElementById('sidebar-quota-free');

    if (photoEl) photoEl.textContent = formatBytes(photoSize);
    if (videoEl) videoEl.textContent = formatBytes(videoSize);
    if (docEl) docEl.textContent = formatBytes(docSize);

    if (state.quota) {
        const freeSize = state.quota.total - state.quota.used;
        if (freeEl) freeEl.textContent = formatBytes(freeSize > 0 ? freeSize : 0);
    } else {
        if (freeEl) freeEl.textContent = '0 B';
    }
}

function renderAccounts() {
    const grid = document.getElementById('accounts-grid');
    if (!grid) return;

    let html = '';
    state.accounts.forEach((acc, i) => {
        const pct = acc.quota_total > 0 ? (acc.quota_used / acc.quota_total) * 100 : 0;
        
        let colorClass = 'low';
        let fillColor = 'var(--accent-green)';
        if (pct > 80) {
            colorClass = 'high';
            fillColor = 'var(--accent-orange)';
        } else if (pct > 50) {
            colorClass = 'medium';
            fillColor = 'var(--accent-yellow)';
        }

        const usedStr = formatBytes(acc.quota_used);
        const totalStr = formatBytes(acc.quota_total);
        const freeStr = formatBytes(acc.quota_total - acc.quota_used);

        html += `
        <div class="account-card">
            <div class="account-card-header">
                <div class="account-profile-wrapper">
                    <div class="provider-icon-circle">☁️</div>
                    <div class="account-info">
                        <h3>Google Drive</h3>
                        <p>${acc.email}</p>
                    </div>
                </div>
                <button class="account-remove" title="Hapus sambungan akun" onclick="confirmRemoveAccount(${acc.id}, '${acc.email}')">✕</button>
            </div>
            <div class="account-storage-row">
                <span>storage</span>
                <span>${pct.toFixed(0)}%</span>
            </div>
            <div class="account-quota-bar">
                <div class="account-quota-fill ${colorClass}" style="width:${pct}%;background-color:${fillColor}"></div>
            </div>
            <div class="account-footer-row">
                <span>${usedStr} / ${totalStr}</span>
                <span class="account-available-text">Available ${freeStr}</span>
            </div>
        </div>`;
    });

    // Add account card
    html += `
    <a href="/add_account" class="account-card account-card-add">
        <span class="add-icon">＋</span>
        <span>Hubungkan Akun Google Drive Baru</span>
    </a>`;

    grid.innerHTML = html;
    updateFilterAccountSelect();
}

function updateFilterAccountSelect() {
    const select = document.getElementById('filter-account');
    if (!select) return;
    
    const currentValue = select.value;
    
    let html = '<option value="all">Semua Akun</option>';
    state.accounts.forEach(acc => {
        html += `<option value="${acc.id}">${acc.display_name || acc.email} (${acc.email})</option>`;
    });
    select.innerHTML = html;
    
    if (currentValue && [...select.options].some(opt => opt.value === currentValue)) {
        select.value = currentValue;
    } else {
        select.value = 'all';
    }
}

function renderBreadcrumbs() {
    const container = document.getElementById('breadcrumbs');
    if (!container) return;

    let html = '';
    state.breadcrumbs.forEach((crumb, i) => {
        if (i > 0) html += '<span class="breadcrumb-sep">›</span>';
        const isActive = i === state.breadcrumbs.length - 1;
        html += `<button class="breadcrumb-item ${isActive ? 'active' : ''}" 
                    onclick="navigateBreadcrumb(${i})">${crumb.name}</button>`;
    });
    container.innerHTML = html;
}

function renderFoldersShortcut(folders) {
    const container = document.getElementById('folders-shortcut-row');
    if (!container) return;
    
    if (folders.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1; padding: 20px;">
                <p class="empty-state-hint">Tidak ada folder di direktori ini.</p>
            </div>`;
        return;
    }

    const folderColors = ['orange', 'yellow', 'green', 'blue'];
    let html = '';
    folders.forEach((folder, i) => {
        const color = folderColors[i % folderColors.length];
        const escapedName = folder.name.replace(/'/g, "\\'");
        
        let dateStr = 'Jun 4, 2026';
        if (folder.modifiedTime) {
            try {
                dateStr = new Date(folder.modifiedTime).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            } catch(e){}
        }

        html += `
        <div class="folder-card" onclick="openFolder('${folder.id}', ${folder.account_id}, '${escapedName}')">
            <div class="folder-card-top">
                <div class="folder-card-icon ${color}">📁</div>
                <button class="folder-card-menu-btn" onclick="event.stopPropagation();showFolderOptions('${folder.id}', ${folder.account_id}, '${escapedName}')">⋮</button>
            </div>
            <div class="folder-card-name" title="${folder.name}">${folder.name}</div>
            <div class="folder-card-date">Updated ${dateStr}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderFiles() {
    const container = document.getElementById('file-list');
    if (!container) return;

    if (state.isLoading) {
        container.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <span>Memuat file...</span>
            </div>`;
        return;
    }

    // Filter files by search queries
    let filteredFiles = [...state.files];
    if (state.searchQuery.trim() !== '') {
        const query = state.searchQuery.toLowerCase();
        filteredFiles = filteredFiles.filter(file => file.name.toLowerCase().includes(query));
    }

    // Sort files based on sort select
    const sortVal = document.getElementById('sort-files')?.value || 'name-asc';
    filteredFiles.sort((a, b) => {
        const aFolder = a.mimeType === 'application/vnd.google-apps.folder';
        const bFolder = b.mimeType === 'application/vnd.google-apps.folder';
        if (aFolder && !bFolder) return -1;
        if (!aFolder && bFolder) return 1;

        if (sortVal === 'name-asc') {
            return a.name.localeCompare(b.name);
        } else if (sortVal === 'name-desc') {
            return b.name.localeCompare(a.name);
        } else if (sortVal === 'size-desc') {
            const aSize = parseInt(a.size || 0);
            const bSize = parseInt(b.size || 0);
            return bSize - aSize;
        } else if (sortVal === 'size-asc') {
            const aSize = parseInt(a.size || 0);
            const bSize = parseInt(b.size || 0);
            return aSize - bSize;
        }
        return 0;
    });

    let folders = [];
    let filesOnly = [];
    if (state.searchQuery.trim() !== '') {
        // Jika pencarian aktif, render semua (folder & file) di list utama
        filesOnly = filteredFiles;
    } else {
        folders = filteredFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        filesOnly = filteredFiles.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
    }

    renderFoldersShortcut(folders);

    if (filesOnly.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📄</div>
                <p class="empty-state-text">Tidak ada item ditemukan</p>
                <p class="empty-state-hint">Coba ubah kata kunci pencarian Anda</p>
            </div>`;
        return;
    }

    if (state.viewMode === 'grid') {
        container.className = 'file-grid';
        
        let html = '';
        filesOnly.forEach((file, i) => {
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
            const icon = getFileIcon(file.mimeType);
            const size = isFolder ? '—' : (file.size ? formatBytes(parseInt(file.size)) : '—');
            const accountEmail = getAccountEmail(file.account_id);
            const escapedName = file.name.replace(/'/g, "\\'");
            const onclickAttr = isFolder ? `onclick="openFolder('${file.id}', ${file.account_id}, '${escapedName}')" style="cursor: pointer;"` : '';

            html += `
            <div class="file-item" style="animation-delay:${i * 0.02}s" ${onclickAttr}
                 data-id="${file.id}"
                 data-account-id="${file.account_id}"
                 data-name="${escapedName}"
                 data-mime-type="${file.mimeType}"
                 data-is-starred="${file.is_starred ? 'true' : 'false'}"
                 data-is-shared="${file.is_shared ? 'true' : 'false'}">
                <div class="col-check"><input type="checkbox" aria-label="Select file"></div>
                <div class="file-icon">${icon}</div>
                <div class="col-name">
                    <div class="file-name" title="${file.name}">${file.name}</div>
                </div>
                <div class="col-size">${size}</div>
                <div class="col-access">
                    ${renderAccountBadgeHTML(file)}
                </div>
                <div class="col-actions">
                    ${isFolder ? '' : `<button class="file-action-btn" title="Download" onclick="event.stopPropagation();downloadFile('${file.id}', ${file.account_id})">⬇️</button>`}
                    <button class="file-action-btn" title="Rename" onclick="event.stopPropagation();showRenameModal('${file.id}', ${file.account_id}, '${escapedName}')">✏️</button>
                    ${isFolder ? '' : `<button class="file-action-btn" title="Pindahkan Akun" onclick="event.stopPropagation();showMoveAccountModal('${file.id}', ${file.account_id}, '${escapedName}')">🚚</button>`}
                    <button class="file-action-btn delete" title="Hapus" onclick="event.stopPropagation();showDeleteModal('${file.id}', ${file.account_id}, '${escapedName}')">🗑️</button>
                    
                    <div class="file-actions-dropdown">
                        <button class="file-action-trigger-btn" onclick="toggleFileDropdown(event)" title="More Actions">⋮</button>
                    </div>
                </div>
            </div>`;
        });
        container.innerHTML = html;

    } else {
        container.className = 'file-list';

        let html = '';
        filesOnly.forEach((file, i) => {
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
            const icon = getFileIcon(file.mimeType);
            const size = isFolder ? '—' : (file.size ? formatBytes(parseInt(file.size)) : '—');
            const accountEmail = getAccountEmail(file.account_id);
            const escapedName = file.name.replace(/'/g, "\\'");
            const onclickAttr = isFolder ? `onclick="openFolder('${file.id}', ${file.account_id}, '${escapedName}')" style="cursor: pointer;"` : '';
            
            let dateFormatted = 'Jun 4, 2026, 6:11 PM';
            if (file.modifiedTime) {
                try {
                    dateFormatted = new Date(file.modifiedTime).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                } catch(e){}
            }

            html += `
            <div class="file-item" style="animation-delay:${i * 0.02}s" ${onclickAttr}
                 data-id="${file.id}"
                 data-account-id="${file.account_id}"
                 data-name="${escapedName}"
                 data-mime-type="${file.mimeType}"
                 data-is-starred="${file.is_starred ? 'true' : 'false'}"
                 data-is-shared="${file.is_shared ? 'true' : 'false'}">
                <div class="col-check"><input type="checkbox" aria-label="Select file"></div>
                <div class="col-name">
                    <div class="file-icon">${icon}</div>
                    <div class="file-name" title="${file.name}">${file.name}</div>
                </div>
                <div class="col-modified">${dateFormatted}</div>
                <div class="col-size">${size}</div>
                <div class="col-access">
                    ${renderAccountBadgeHTML(file)}
                </div>
                <div class="col-actions">
                    ${isFolder ? '' : `<button class="file-action-btn" title="Download" onclick="event.stopPropagation();downloadFile('${file.id}', ${file.account_id})">⬇️</button>`}
                    <button class="file-action-btn" title="Rename" onclick="event.stopPropagation();showRenameModal('${file.id}', ${file.account_id}, '${escapedName}')">✏️</button>
                    ${isFolder ? '' : `<button class="file-action-btn" title="Pindahkan Akun" onclick="event.stopPropagation();showMoveAccountModal('${file.id}', ${file.account_id}, '${escapedName}')">🚚</button>`}
                    <button class="file-action-btn delete" title="Hapus" onclick="event.stopPropagation();showDeleteModal('${file.id}', ${file.account_id}, '${escapedName}')">🗑️</button>
                    
                    <div class="file-actions-dropdown">
                        <button class="file-action-trigger-btn" onclick="toggleFileDropdown(event)" title="More Actions">⋮</button>
                    </div>
                </div>
            </div>`;
        });
        container.innerHTML = html;
    }
}

function renderFilesForTab(tabId, filesList) {
    const container = document.getElementById(`view-${tabId}`);
    if (!container) return;

    if (filesList.length === 0) {
        const emptyIcon = tabId === 'shared' ? '👥' : '⭐';
        const emptyTitle = tabId === 'shared' ? 'Shared With Me' : 'Starred Files';
        const emptyHint = tabId === 'shared' ? 'Tidak ada file dibagikan dengan Anda saat ini.' : 'Tandai file penting Anda sebagai Bintang.';
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">${emptyIcon}</div>
                <p class="empty-state-text">${emptyTitle}</p>
                <p class="empty-state-hint">${emptyHint}</p>
            </div>`;
        return;
    }

    let tableHtml = `
        <div class="explorer-view-header">
            <h2>${tabId === 'shared' ? 'Shared With Me' : 'Starred'}</h2>
        </div>
        <div class="files-table-container">
            <div class="files-table-header">
                <div class="col-check"><input type="checkbox" id="header-select-all-${tabId}" aria-label="Select all"></div>
                <div class="col-name">Name</div>
                <div class="col-modified">Last Modified</div>
                <div class="col-size">Size</div>
                <div class="col-access">Access</div>
                <div class="col-actions-header">Action</div>
            </div>
            <div class="file-list">`;
            
    filesList.forEach((file, i) => {
        const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
        const icon = getFileIcon(file.mimeType);
        const size = file.size ? formatBytes(parseInt(file.size)) : '—';
        const accountEmail = getAccountEmail(file.account_id);
        const escapedName = file.name.replace(/'/g, "\\'");
        
        let dateFormatted = 'Jun 4, 2026';
        if (file.modifiedTime) {
            try {
                dateFormatted = new Date(file.modifiedTime).toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' });
            } catch(e){}
        }

        tableHtml += `
            <div class="file-item"
                 data-id="${file.id}"
                 data-account-id="${file.account_id}"
                 data-name="${escapedName}"
                 data-mime-type="${file.mimeType}"
                 data-is-starred="${file.is_starred ? 'true' : 'false'}"
                 data-is-shared="${file.is_shared ? 'true' : 'false'}">
                <div class="col-check"><input type="checkbox" aria-label="Select file"></div>
                <div class="col-name">
                    <div class="file-icon">${icon}</div>
                    <div class="file-name" title="${file.name}">${file.name}</div>
                </div>
                <div class="col-modified">${dateFormatted}</div>
                <div class="col-size">${size}</div>
                <div class="col-access">
                    ${renderAccountBadgeHTML(file)}
                </div>
                <div class="col-actions">
                    ${isFolder ? '' : `<button class="file-action-btn" title="Download" onclick="event.stopPropagation();downloadFile('${file.id}', ${file.account_id})">⬇️</button>`}
                    <button class="file-action-btn" title="Rename" onclick="event.stopPropagation();showRenameModal('${file.id}', ${file.account_id}, '${escapedName}')">✏️</button>
                    ${isFolder ? '' : `<button class="file-action-btn" title="Pindahkan Akun" onclick="event.stopPropagation();showMoveAccountModal('${file.id}', ${file.account_id}, '${escapedName}')">🚚</button>`}
                    <button class="file-action-btn delete" title="Hapus" onclick="event.stopPropagation();showDeleteModal('${file.id}', ${file.account_id}, '${escapedName}')">🗑️</button>
                    
                    <div class="file-actions-dropdown">
                        <button class="file-action-trigger-btn" onclick="toggleFileDropdown(event)" title="More Actions">⋮</button>
                    </div>
                </div>
            </div>`;
    });

    tableHtml += `</div></div>`;
    container.innerHTML = tableHtml;
}

function renderDebugInfo(data) {
    const apiStatusEl = document.getElementById('google-api-status');
    const systemConsoleEl = document.getElementById('system-credentials-info');

    if (!data || data.length === 0) {
        if (apiStatusEl) {
            apiStatusEl.textContent = 'Belum Ada Akun';
            apiStatusEl.className = 'status-badge info';
        }
        if (systemConsoleEl) {
            systemConsoleEl.innerHTML = 'Belum ada akun Google terhubung. Hubungkan akun Google Drive baru untuk melihat status integrasi.';
        }
        return;
    }

    const hasError = data.some(acc => acc.status === 'ERROR');
    if (apiStatusEl) {
        if (hasError) {
            apiStatusEl.textContent = 'Error API';
            apiStatusEl.className = 'status-badge error';
        } else {
            apiStatusEl.textContent = 'Aktif & Normal';
            apiStatusEl.className = 'status-badge success';
        }
    }

    if (systemConsoleEl) {
        let text = '';
        data.forEach(acc => {
            text += `Akun: ${acc.email}\n`;
            text += `- Status API: ${acc.status}\n`;
            text += `- OAuth Refresh Token: ${acc.has_refresh_token ? 'TERSEDIA (OK)' : 'TIDAK ADA'}\n`;
            text += `- OAuth Access Token: ${acc.has_access_token ? 'AKTIF (OK)' : 'KOSONG'}\n`;
            if (acc.status === 'ERROR') {
                text += `- Detail Error:\n  ${acc.error}\n`;
            } else if (acc.about_response) {
                const quota = acc.about_response.storageQuota;
                text += `- Kapasitas Google Drive:\n`;
                text += `  * Terpakai: ${formatBytes(parseInt(quota.usage))}\n`;
                text += `  * Total: ${formatBytes(parseInt(quota.limit))}\n`;
            }
            text += `\n`;
        });
        systemConsoleEl.textContent = text.trim();
    }
}

function saveExplorerState() {
    localStorage.setItem('explorerBreadcrumbs', JSON.stringify(state.breadcrumbs));
    localStorage.setItem('currentAccountId', state.currentAccountId !== null ? state.currentAccountId : '');
}

function loadExplorerState() {
    try {
        const savedBreadcrumbs = localStorage.getItem('explorerBreadcrumbs');
        if (savedBreadcrumbs) {
            state.breadcrumbs = JSON.parse(savedBreadcrumbs);
        }
        const savedAccId = localStorage.getItem('currentAccountId');
        if (savedAccId !== null && savedAccId !== '') {
            state.currentAccountId = parseInt(savedAccId);
        }
    } catch (e) {
        console.error('Gagal memuat state penjelajah:', e);
    }
}

// ============================================================
// Navigation
// ============================================================
function openFolder(folderId, accountId, folderName) {
    // Clear search
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
        state.searchQuery = '';
    }
    const foldersSection = document.querySelector('.folders-section');
    if (foldersSection) foldersSection.style.display = 'block';

    state.breadcrumbs.push({ name: folderName, folderId, accountId });
    saveExplorerState();
    renderBreadcrumbs();
    fetchFiles(folderId, accountId);
}

function navigateBreadcrumb(index) {
    if (index === state.breadcrumbs.length - 1) return;
    state.breadcrumbs = state.breadcrumbs.slice(0, index + 1);
    const crumb = state.breadcrumbs[index];
    saveExplorerState();
    renderBreadcrumbs();
    fetchFiles(crumb.folderId, crumb.accountId);
}

// ============================================================
// Folder / Actions Options Dialogs
// ============================================================
function showFolderOptions(folderId, accountId, folderName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Opsi Folder';
    document.getElementById('modal-body').innerHTML = `
        <p>Kelola opsi folder "<strong>${folderName}</strong>":</p>
        <div style="margin-top:14px; display:flex; flex-direction:column; gap:8px;">
             <button class="btn btn-ghost btn-sm" onclick="closeModal();showRenameModal('${folderId}', ${accountId}, '${folderName}')">✏️ Rename Folder</button>
             <button class="btn btn-danger btn-sm" onclick="closeModal();showDeleteModal('${folderId}', ${accountId}, '${folderName}')">🗑️ Hapus Folder</button>
        </div>`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Tutup</button>`;
    overlay.classList.add('active');
}

// ============================================================
// File Actions
// ============================================================
function downloadFile(fileId, accountId) {
    window.open(`/api/download/${fileId}?account_id=${accountId}`, '_blank');
}

function showRenameModal(fileId, accountId, currentName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Ubah Nama';
    document.getElementById('modal-body').innerHTML = `
        <input type="text" class="modal-input" id="rename-input" value="${currentName}" />`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn btn-primary btn-sm" onclick="executeRename('${fileId}', ${accountId})">Simpan</button>`;
    overlay.classList.add('active');
    setTimeout(() => document.getElementById('rename-input')?.focus(), 200);
}

function executeRename(fileId, accountId) {
    const newName = document.getElementById('rename-input')?.value?.trim();
    if (newName) {
        renameFileApi(fileId, accountId, newName);
        closeModal();
    }
}

function showDeleteModal(fileId, accountId, fileName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Hapus Item';
    document.getElementById('modal-body').innerHTML = `
        <p>Apakah Anda yakin ingin menghapus "<strong>${fileName}</strong>"?</p>
        <p style="margin-top:8px;color:var(--accent-orange);font-size:0.8rem">Item ini akan dipindahkan ke Trash akun terkait.</p>`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn btn-danger btn-sm" onclick="executeDelete('${fileId}', ${accountId})">Hapus</button>`;
    overlay.classList.add('active');
}

function executeDelete(fileId, accountId) {
    deleteFileApi(fileId, accountId);
    closeModal();
}

function confirmRemoveAccount(accountId, email) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Putuskan Akun';
    document.getElementById('modal-body').innerHTML = `
        <p>Hapus sambungan integrasi akun "<strong>${email}</strong>" dari aplikasi?</p>
        <p style="margin-top:8px;color:var(--text-muted);font-size:0.8rem">File Anda di Google Drive akan tetap aman dan tidak akan dihapus.</p>`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn btn-danger btn-sm" onclick="executeRemoveAccount(${accountId})">Hapus Akun</button>`;
    overlay.classList.add('active');
}

function executeRemoveAccount(accountId) {
    removeAccount(accountId);
    closeModal();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
}

// ============================================================
// Folder Creation API call
// ============================================================
function showCreateFolderModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Buat Folder Baru';
    document.getElementById('modal-body').innerHTML = `
        <input type="text" class="modal-input" id="folder-name-input" placeholder="Nama Folder Baru" value="" />`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn btn-primary btn-sm" id="btn-execute-create-folder">Buat</button>`;
    overlay.classList.add('active');
    
    document.getElementById('btn-execute-create-folder')?.addEventListener('click', async () => {
        const name = document.getElementById('folder-name-input')?.value?.trim();
        if (name) {
            closeModal();
            await createFolderApi(name);
        }
    });
    setTimeout(() => document.getElementById('folder-name-input')?.focus(), 200);
}

async function createFolderApi(folderName) {
    try {
        showToast('Sedang membuat folder...', 'info');
        const res = await fetch('/api/folders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: folderName,
                parent_id: state.currentFolder,
                account_id: state.currentAccountId
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Folder "${folderName}" berhasil dibuat!`, 'success');
            refreshAll();
        } else {
            showToast(data.error || 'Gagal membuat folder', 'error');
        }
    } catch(e) {
        showToast('Gagal membuat folder', 'error');
    }
}

// ============================================================
// Cross-Account File Mover
// ============================================================
function showMoveAccountModal(fileId, currentAccountId, fileName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Pindahkan File Lintas Akun';
    
    let selectHtml = `<select id="move-target-account" class="theme-select" style="width:100%; margin-top:8px;">`;
    state.accounts.forEach(acc => {
        if (acc.id !== currentAccountId) {
            selectHtml += `<option value="${acc.id}">${acc.display_name || acc.email} (${acc.email})</option>`;
        }
    });
    selectHtml += `</select>`;
    
    const otherAccountsAvailable = state.accounts.some(acc => acc.id !== currentAccountId);
    
    if (!otherAccountsAvailable) {
        document.getElementById('modal-body').innerHTML = `
            <p>Tidak ada akun Google Drive lain terhubung untuk memindahkan file ini.</p>
            <p style="margin-top:8px;color:var(--text-muted);font-size:0.8rem">Hubungkan akun Google Drive tambahan terlebih dahulu di tab "Akun Drive".</p>`;
        document.getElementById('modal-actions').innerHTML = `
            <button class="btn btn-ghost btn-sm" onclick="closeModal()">Tutup</button>`;
    } else {
        document.getElementById('modal-body').innerHTML = `
            <p>Pindahkan "<strong>${fileName}</strong>" ke akun Google Drive yang mana?</p>
            ${selectHtml}
            <p style="margin-top:12px;color:var(--text-muted);font-size:0.8rem">
                Sistem akan mendownload file dari Drive asal, menguploadnya ke target, dan menghapus file asal secara aman.
            </p>`;
        document.getElementById('modal-actions').innerHTML = `
            <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
            <button class="btn btn-primary btn-sm" id="btn-execute-move-file">Pindahkan</button>`;
            
        document.getElementById('btn-execute-move-file')?.addEventListener('click', async () => {
            const targetAccountId = document.getElementById('move-target-account').value;
            if (targetAccountId) {
                closeModal();
                await executeMoveFileApi(fileId, targetAccountId);
            }
        });
    }
    overlay.classList.add('active');
}

async function executeMoveFileApi(fileId, targetAccountId) {
    showToast('Memulai pemindahan file lintas akun (bisa memakan waktu)...', 'info');
    try {
        const res = await fetch('/api/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: fileId,
                target_account_id: parseInt(targetAccountId)
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('File berhasil dipindahkan!', 'success');
            refreshAll();
        } else {
            showToast(data.error || 'Gagal memindahkan file', 'error');
        }
    } catch(e) {
        showToast('Gagal memindahkan file lintas akun', 'error');
    }
}

// ============================================================
// Duplicate Files Scanner
// ============================================================
async function scanDuplicateFiles() {
    const container = document.getElementById('duplicates-container');
    if (!container) return;
    
    container.innerHTML = `
        <div class="loading-container">
            <div class="loading-spinner"></div>
            <span>Sedang memindai file duplikat...</span>
        </div>`;
        
    try {
        const res = await fetch('/api/duplicates');
        const duplicates = await res.json();
        
        if (!duplicates || duplicates.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 32px 20px; border-style: dashed; background: none;">
                    <div class="empty-state-icon" style="font-size: 2.5rem; margin-bottom: 8px;">🎉</div>
                    <p class="empty-state-text" style="font-size: 0.88rem; margin-bottom: 2px;">Penyimpanan Bersih!</p>
                    <p class="empty-state-hint">Tidak ada file duplikat terdeteksi pada seluruh akun yang terhubung.</p>
                </div>`;
            return;
        }
        
        let html = `<div class="duplicate-groups-list">`;
        duplicates.forEach(dup => {
            const fileIcon = getFileIcon(dup.mimeType || '');
            html += `
            <div class="duplicate-group-card">
                <div class="duplicate-group-header">
                    <div class="duplicate-file-name">
                        <span class="file-icon">${fileIcon}</span>
                        <span title="${dup.name}">${dup.name}</span>
                    </div>
                    <span class="duplicate-file-size">${formatBytes(dup.size)}</span>
                </div>
                <div class="duplicate-items-list">`;
                
            dup.items.forEach(item => {
                let dateStr = 'Jun 4, 2026';
                if (item.modifiedTime) {
                    try {
                        dateStr = new Date(item.modifiedTime).toLocaleDateString('id-ID', { month: 'short', day: 'numeric', year: 'numeric' });
                    } catch(e){}
                }
                
                const accountColor = getAccountColor(item.account_id);
                const accountLabel = getAccountLabel(item.account_id);
                
                html += `
                <div class="duplicate-item-row">
                    <div class="duplicate-item-info">
                        <span class="duplicate-account-badge" style="background-color: ${accountColor}; color: #ffffff;" title="${item.account_email}">
                            ☁️ ${accountLabel}
                        </span>
                        <span class="duplicate-item-date">Dimodifikasi: ${dateStr}</span>
                    </div>
                    <button class="btn btn-danger btn-sm" style="padding: 4px 10px; font-size: 0.72rem; border-radius: var(--radius-sm);" 
                            onclick="confirmDeleteDuplicate('${item.id}', ${item.account_id}, '${dup.name.replace(/'/g, "\\'")}')">
                         🗑️ Hapus Salinan
                    </button>
                </div>`;
            });
            
            html += `</div></div>`;
        });
        html += `</div>`;
        container.innerHTML = html;
    } catch(e) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 32px 20px; border-style: dashed; background: none;">
                <div class="empty-state-icon" style="font-size: 2.5rem; margin-bottom: 8px; color: var(--accent-orange);">⚠️</div>
                <p class="empty-state-text" style="font-size: 0.88rem; color: var(--accent-orange); margin-bottom: 2px;">Gagal Memindai</p>
                <p class="empty-state-hint">Terjadi kesalahan saat mencari file duplikat. Silakan coba lagi.</p>
            </div>`;
    }
}

function confirmDeleteDuplicate(fileId, accountId, name) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = 'Hapus Salinan Duplikat';
    document.getElementById('modal-body').innerHTML = `
        <p>Apakah Anda yakin ingin menghapus salinan file "<strong>${name}</strong>"?</p>
        <p style="margin-top:8px;color:var(--accent-orange);font-size:0.8rem">Salinan pada akun ini saja yang akan dihapus dari Google Drive.</p>`;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Batal</button>
        <button class="btn btn-danger btn-sm" id="btn-execute-delete-duplicate">Hapus</button>`;
        
    document.getElementById('btn-execute-delete-duplicate')?.addEventListener('click', async () => {
        closeModal();
        await deleteFileApi(fileId, accountId);
        // Refresh duplicates list
        setTimeout(() => scanDuplicateFiles(), 800);
    });
    overlay.classList.add('active');
}

// ============================================================
// Upload / Drag & Drop
// ============================================================
function initDragAndDrop() {
    const fileInput = document.getElementById('file-input');
    const dropZoneTrigger = document.getElementById('btn-upload-file-action');
    const dragArea = document.querySelector('.main-content');

    if (!fileInput || !dragArea) return;

    // Trigger file input selector when Upload action button is clicked
    dropZoneTrigger?.addEventListener('click', () => {
        fileInput.click();
    });

    document.getElementById('btn-new-folder-action')?.addEventListener('click', () => {
        showCreateFolderModal();
    });

    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files.length > 0) handleFileUpload(files);
        fileInput.value = '';
    });

    // Drag and drop event listeners on the main content container directly
    dragArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
    });

    dragArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
    });

    dragArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    dragArea.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            showToast('Mulai mengunggah file...', 'info');
            handleFileUpload(files);
        }
    });
}

async function handleFileUpload(files) {
    state.uploadCancelled = false;
    state.uploadPaused = false;
    updatePauseButtonUI(false);
    
    for (const file of files) {
        if (state.uploadCancelled) break;
        await uploadFileApi(file);
    }
}

function showUploadProgress(show, pct = 0, filename = '') {
    const container = document.getElementById('upload-progress');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');

    if (!container || !fill || !text) return;

    if (show) {
        container.classList.add('active');
        fill.style.width = pct + '%';
        text.textContent = `Mengupload "${filename}"... ${pct}%`;
    } else {
        container.classList.remove('active');
    }
}

function updatePauseButtonUI(paused) {
    const btnPause = document.getElementById('btn-upload-pause');
    if (!btnPause) return;
    if (paused) {
        btnPause.innerHTML = '<span class="icon">▶️</span> Resume';
        const text = document.getElementById('upload-progress-text');
        if (text) {
            const currentText = text.textContent;
            if (!currentText.includes(' (Di-jeda)')) {
                text.textContent = currentText + ' (Di-jeda)';
            }
        }
    } else {
        btnPause.innerHTML = '<span class="icon">⏸️</span> Pause';
    }
}

function initUploadControls() {
    const btnPause = document.getElementById('btn-upload-pause');
    const btnCancel = document.getElementById('btn-upload-cancel');

    btnPause?.addEventListener('click', () => {
        if (!state.activeUploadXhr) return;
        
        if (state.uploadPaused) {
            state.uploadPaused = false;
        } else {
            state.uploadPaused = true;
            state.activeUploadXhr.abort();
        }
    });

    btnCancel?.addEventListener('click', () => {
        state.uploadCancelled = true;
        if (state.activeUploadXhr) {
            state.activeUploadXhr.abort();
        }
        showUploadProgress(false);
    });

    // Intercept refresh or tab close if an upload is active
    window.addEventListener('beforeunload', (e) => {
        if (state.activeUploadXhr) {
            e.preventDefault();
            e.returnValue = 'Proses upload sedang berlangsung. Jika Anda me-refresh halaman, upload akan dibatalkan.';
            return e.returnValue;
        }
    });
}

function addNotification(type, message) {
    const notification = {
        id: Date.now(),
        type,
        message,
        timestamp: new Date()
    };
    state.notifications.unshift(notification);

    // Trigger OS-level native desktop notification for important events
    if (['success', 'error', 'cancelled'].includes(type)) {
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                new Notification('AiziD — Drive Aggregator', {
                    body: message,
                    icon: '/static/img/logo.svg'
                });
            } catch (e) {
                console.error('Failed to show native desktop notification:', e);
            }
        }
    }

    // Limit log size to 50 items
    if (state.notifications.length > 50) {
        state.notifications = state.notifications.slice(0, 50);
    }

    // Save to localStorage
    try {
        localStorage.setItem('uploadNotifications', JSON.stringify(state.notifications));
    } catch (e) {
        console.error('Failed to save notifications to localStorage:', e);
    }

    const dropdown = document.getElementById('notification-dropdown');
    if (!dropdown || !dropdown.classList.contains('active')) {
        state.unreadNotificationsCount++;
    }

    renderNotifications();
}

function renderNotifications() {
    const listEl = document.getElementById('notification-list');
    const badgeEl = document.getElementById('notification-badge');
    if (!listEl || !badgeEl) return;

    if (state.notifications.length === 0) {
        listEl.innerHTML = `
            <div class="notification-empty">
                <div class="notification-empty-icon">📭</div>
                <div class="notification-empty-text">Belum ada riwayat upload.</div>
            </div>`;
    } else {
        let html = '';
        state.notifications.forEach(notif => {
            const icons = {
                uploading: '📤',
                success: '✅',
                error: '❌',
                cancelled: '✕',
                info: 'ℹ️'
            };
            
            let timeStr = 'Baru saja';
            if (notif.timestamp) {
                try {
                    timeStr = new Date(notif.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
                } catch(e){}
            }

            html += `
                <div class="notification-item">
                    <span class="notification-icon">${icons[notif.type] || '🔔'}</span>
                    <div class="notification-content">
                        <div class="notification-text">${notif.message}</div>
                        <div class="notification-time">${timeStr}</div>
                    </div>
                </div>`;
        });
        listEl.innerHTML = html;
    }

    // Update badge count
    if (state.unreadNotificationsCount > 0) {
        badgeEl.textContent = state.unreadNotificationsCount;
        badgeEl.style.display = 'flex';
    } else {
        badgeEl.style.display = 'none';
    }
}

function initNotificationControls() {
    const btnNotif = document.getElementById('btn-notification');
    const dropdown = document.getElementById('notification-dropdown');
    const btnClear = document.getElementById('btn-clear-notifications');

    // Load persisted upload logs on start
    try {
        const savedNotifs = localStorage.getItem('uploadNotifications');
        if (savedNotifs) {
            state.notifications = JSON.parse(savedNotifs);
            renderNotifications();
        }
    } catch (e) {
        console.error('Failed to load notifications from localStorage:', e);
    }

    btnNotif?.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('active');
        if (dropdown.classList.contains('active')) {
            state.unreadNotificationsCount = 0;
            renderNotifications();
        }
    });

    btnClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        state.notifications = [];
        state.unreadNotificationsCount = 0;
        try {
            localStorage.removeItem('uploadNotifications');
        } catch (e) {}
        renderNotifications();
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
        if (dropdown && !dropdown.contains(e.target) && e.target !== btnNotif) {
            dropdown.classList.remove('active');
        }
    });
}

// ============================================================
// Toast Notifications
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { success: '✅', error: '❌', info: 'ℹ️' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(30px) translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================
// Navigation Tabs Control
// ============================================================
function initTabs() {
    const menuButtons = document.querySelectorAll('.sidebar-item');
    menuButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    const sidebar = document.getElementById('sidebar');
    const sidebarItems = document.querySelectorAll('.sidebar-item');
    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('active');
            }
        });
    });

    // Close mobile sidebar on body click
    document.querySelector('.main-content').addEventListener('click', () => {
        if (window.innerWidth <= 768 && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
        }
    });
}

function switchTab(tabId) {
    if (!tabId) return;
    
    state.currentTab = tabId;
    localStorage.setItem('activeTab', tabId);
    document.documentElement.setAttribute('data-active-tab', tabId);

    // Update active class on sidebar items
    const menuButtons = document.querySelectorAll('.sidebar-item');
    menuButtons.forEach(btn => {
        if (btn.getAttribute('data-tab') === tabId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Update active class on panels
    const panels = document.querySelectorAll('.view-panel');
    panels.forEach(panel => {
        if (panel.id === `view-${tabId}`) {
            panel.classList.add('active');
        } else {
            panel.classList.remove('active');
        }
    });

    // Tab contextual data fetching logic
    if (tabId === 'explorer') {
        fetchFiles(state.breadcrumbs[state.breadcrumbs.length - 1].folderId, state.currentAccountId);
    } else if (tabId === 'shared') {
        fetchFiles('root', state.currentAccountId, 'shared');
    } else if (tabId === 'starred') {
        fetchFiles('root', state.currentAccountId, 'starred');
    } else if (tabId === 'quota') {
        renderAccounts();
        renderStorageBar();
    }
}

// ============================================================
// Theme Toggle Controls
// ============================================================
function initThemeToggle() {
    const btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;

    const updateIcon = (theme) => {
        btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    };

    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    updateIcon(currentTheme);

    btn.addEventListener('click', () => {
        const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = activeTheme === 'light' ? 'dark' : 'light';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateIcon(newTheme);
        showToast(`Tema diubah ke ${newTheme === 'dark' ? 'Dark' : 'Light'} Mode`, 'info');
    });
}

// ============================================================
// Explorer Toolbar Events Control
// ============================================================
async function performGlobalSearch(query) {
    state.isLoading = true;
    renderFiles();
    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const searchResults = await res.json();
        state.files = searchResults;
    } catch (err) {
        console.error('Failed to perform global search:', err);
        state.files = [];
    }
    state.isLoading = false;
    
    // Sembunyikan shortcut folder
    const foldersSection = document.querySelector('.folders-section');
    if (foldersSection) foldersSection.style.display = 'none';
    
    renderFiles();
}

function initExplorerControls() {
    // Search input
    const searchInput = document.getElementById('search-input');
    searchInput?.addEventListener('input', async (e) => {
        const query = e.target.value;
        state.searchQuery = query;
        
        if (query.trim() !== '') {
            await performGlobalSearch(query);
        } else {
            const foldersSection = document.querySelector('.folders-section');
            if (foldersSection) foldersSection.style.display = 'block';
            fetchFiles(state.currentFolder, state.currentAccountId);
        }
    });

    // Account filter dropdown
    const filterAccount = document.getElementById('filter-account');
    filterAccount?.addEventListener('change', (e) => {
        const val = e.target.value;
        state.currentAccountId = val === 'all' ? null : parseInt(val);
        
        state.breadcrumbs = [{ name: 'Drive Saya', folderId: 'root', accountId: state.currentAccountId }];
        saveExplorerState();
        renderBreadcrumbs();
        
        // Context-aware file fetching
        if (state.currentTab === 'shared') {
            fetchFiles('root', state.currentAccountId, 'shared');
        } else if (state.currentTab === 'starred') {
            fetchFiles('root', state.currentAccountId, 'starred');
        } else {
            fetchFiles('root', state.currentAccountId);
        }
    });

    // Sort files select
    const sortFiles = document.getElementById('sort-files');
    sortFiles?.addEventListener('change', () => {
        if (state.currentTab === 'shared' || state.currentTab === 'starred') {
            renderFilesForTab(state.currentTab, state.files);
        } else {
            renderFiles();
        }
    });

    // View toggles: grid or list
    const btnList = document.getElementById('btn-view-list');
    const btnGrid = document.getElementById('btn-view-grid');

    btnList?.addEventListener('click', () => {
        state.viewMode = 'list';
        btnList.classList.add('active');
        btnGrid.classList.remove('active');
        renderFiles();
    });

    btnGrid?.addEventListener('click', () => {
        state.viewMode = 'grid';
        btnGrid.classList.add('active');
        btnList.classList.remove('active');
        renderFiles();
    });

    // Recents / Starred toolbar pill buttons (Explorer filter shortcut context)
    const btnRecents = document.getElementById('btn-filter-recents');
    const btnStarred = document.getElementById('btn-filter-starred');

    btnRecents?.addEventListener('click', () => {
        btnRecents.classList.add('active');
        btnStarred.classList.remove('active');
        fetchFiles('root', state.currentAccountId); // normal files list
    });

    btnStarred?.addEventListener('click', () => {
        btnStarred.classList.add('active');
        btnRecents.classList.remove('active');
        fetchFiles('root', state.currentAccountId, 'starred'); // starred files list
    });
}

// ============================================================
// Quota Tracker Controls
// ============================================================
function initQuotaControls() {
    // Refresh Quota button
    document.getElementById('btn-refresh-quota')?.addEventListener('click', async () => {
        showToast('Memperbarui kuota...', 'info');
        // Manual cache sync trigger to DB
        try {
            const res = await fetch('/api/sync', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                await Promise.all([fetchAccounts(), fetchQuota()]);
                renderStorageBar();
                renderAccounts();
                showToast('Kapasitas kuota berhasil diperbarui!', 'success');
            } else {
                showToast('Gagal melakukan sinkronisasi kuota', 'error');
            }
        } catch(e) {
            showToast('Gagal melakukan sinkronisasi kuota', 'error');
        }
    });

    // Scan Duplicates button
    document.getElementById('btn-scan-duplicates')?.addEventListener('click', () => {
        scanDuplicateFiles();
    });

    // Quota pill filters simulation
    const pills = document.querySelectorAll('.quota-toolbar .btn-quota-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', (e) => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            showToast(`Memfilter penyedia: ${pill.textContent} (simulasi)`, 'info');
        });
    });
}

// ============================================================
// Refresh All Data
// ============================================================
async function refreshAll() {
    await Promise.all([fetchAccounts(), fetchQuota(), fetchDebugInfo()]);
    renderUserProfile();
    renderStorageBar();
    renderAccounts();
    
    // Refresh files list contextually
    if (state.currentTab === 'shared') {
        await fetchFiles('root', state.currentAccountId, 'shared');
    } else if (state.currentTab === 'starred') {
        await fetchFiles('root', state.currentAccountId, 'starred');
    } else {
        await fetchFiles(state.currentFolder, state.currentAccountId);
    }
}

// ============================================================
// Initialize
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    // Request desktop notification permission on startup
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // Initial data load
    await Promise.all([fetchAccounts(), fetchQuota(), fetchDebugInfo()]);

    // Load persisted explorer state
    loadExplorerState();

    renderUserProfile();
    renderStorageBar();
    renderAccounts();

    // Restore the dropdown value based on state.currentAccountId
    const filterAccount = document.getElementById('filter-account');
    if (filterAccount) {
        filterAccount.value = state.currentAccountId !== null ? state.currentAccountId.toString() : 'all';
    }

    renderBreadcrumbs();

    // Setup drag and drop
    initDragAndDrop();

    // Setup tabs
    initTabs();

    // Setup explorer filters
    initExplorerControls();

    // Setup quota tracker controls
    initQuotaControls();

    // Setup upload controls
    initUploadControls();

    // Setup notification controls
    initNotificationControls();

    // Setup theme toggler
    initThemeToggle();

    // Invite members mockup click trigger
    document.getElementById('btn-invite-members')?.addEventListener('click', () => {
        showToast('Fitur Invite Members disimulasikan untuk pengerjaan frontend.', 'info');
    });



    // Mobile sidebar toggle click handler
    const mobileToggle = document.getElementById('mobile-toggle');
    const sidebar = document.getElementById('sidebar');
    mobileToggle?.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('active');
    });

    // Close modal on overlay click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    // Initialize context menu
    initContextMenu();

    // Load initial tab from localStorage and activate it
    const initialTab = localStorage.getItem('activeTab') || 'explorer';
    switchTab(initialTab);
});


// ============================================================
// Context Menu & Starred/Shared Actions
// ============================================================
let activeFile = null;

function initContextMenu() {
    const ctxMenu = document.createElement('div');
    ctxMenu.id = 'context-menu';
    ctxMenu.className = 'context-menu';
    ctxMenu.style.display = 'none';
    ctxMenu.style.position = 'fixed';
    ctxMenu.style.zIndex = '10000';
    ctxMenu.innerHTML = `
        <ul>
            <li id="ctx-open"><span>📂</span> Buka</li>
            <li id="ctx-download"><span>⬇️</span> Download</li>
            <li id="ctx-rename"><span>✏️</span> Rename</li>
            <li id="ctx-star"><span>⭐</span> <span id="ctx-star-text">Beri Bintang</span></li>
            <li id="ctx-share"><span>👥</span> <span id="ctx-share-text">Bagikan Link</span></li>
            <li id="ctx-copy-link" style="display: none;"><span>🔗</span> Salin Link</li>
            <li id="ctx-move"><span>🚚</span> Pindahkan Akun</li>
            <div class="context-menu-divider"></div>
            <li id="ctx-delete" class="delete"><span>🗑️</span> Hapus</li>
        </ul>
    `;
    document.body.appendChild(ctxMenu);

    document.addEventListener('contextmenu', (e) => {
        const fileItem = e.target.closest('.file-item');
        if (fileItem) {
            e.preventDefault();
            
            activeFile = {
                id: fileItem.getAttribute('data-id'),
                accountId: fileItem.getAttribute('data-account-id'),
                name: fileItem.getAttribute('data-name'),
                mimeType: fileItem.getAttribute('data-mime-type'),
                isStarred: fileItem.getAttribute('data-is-starred') === 'true',
                isShared: fileItem.getAttribute('data-is-shared') === 'true'
            };

            const starText = document.getElementById('ctx-star-text');
            if (starText) {
                starText.textContent = activeFile.isStarred ? 'Hapus Bintang' : 'Beri Bintang';
            }
            const shareText = document.getElementById('ctx-share-text');
            const copyLinkOpt = document.getElementById('ctx-copy-link');
            if (activeFile.isShared) {
                if (shareText) shareText.textContent = 'Hentikan Berbagi';
                if (copyLinkOpt) copyLinkOpt.style.display = 'flex';
            } else {
                if (shareText) shareText.textContent = 'Bagikan Link';
                if (copyLinkOpt) copyLinkOpt.style.display = 'none';
            }

            const isFolder = activeFile.mimeType === 'application/vnd.google-apps.folder';
            const downloadOpt = document.getElementById('ctx-download');
            if (downloadOpt) downloadOpt.style.display = isFolder ? 'none' : 'flex';
            const moveOpt = document.getElementById('ctx-move');
            if (moveOpt) moveOpt.style.display = isFolder ? 'none' : 'flex';
            const openOpt = document.getElementById('ctx-open');
            if (openOpt) openOpt.style.display = isFolder ? 'flex' : 'none';

            // Position context menu
            ctxMenu.style.left = `${e.clientX}px`;
            ctxMenu.style.top = `${e.clientY}px`;
            ctxMenu.style.display = 'block';
        } else {
            ctxMenu.style.display = 'none';
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) {
            ctxMenu.style.display = 'none';
        }
    });

    // Options click handlers
    document.getElementById('ctx-open')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile && activeFile.mimeType === 'application/vnd.google-apps.folder') {
            openFolder(activeFile.id, activeFile.accountId, activeFile.name);
        }
    });

    document.getElementById('ctx-download')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            downloadFile(activeFile.id, activeFile.accountId);
        }
    });

    document.getElementById('ctx-rename')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            showRenameModal(activeFile.id, activeFile.accountId, activeFile.name);
        }
    });

    document.getElementById('ctx-move')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            showMoveAccountModal(activeFile.id, activeFile.accountId, activeFile.name);
        }
    });

    document.getElementById('ctx-star')?.addEventListener('click', async () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            await toggleStar(activeFile.id, activeFile.accountId, !activeFile.isStarred);
        }
    });

    document.getElementById('ctx-share')?.addEventListener('click', async () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            await toggleShare(activeFile.id, activeFile.accountId, !activeFile.isShared);
        }
    });

    document.getElementById('ctx-copy-link')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            showShareModal(activeFile.id, activeFile.accountId, activeFile.name, activeFile.id.startsWith('gpart:'));
        }
    });

    document.getElementById('ctx-delete')?.addEventListener('click', () => {
        ctxMenu.style.display = 'none';
        if (activeFile) {
            showDeleteModal(activeFile.id, activeFile.accountId, activeFile.name);
        }
    });
}

function showShareModal(fileId, accountId, fileName, isGpart) {
    const overlay = document.getElementById('modal-overlay');
    const shareUrl = window.location.origin + '/api/download/' + fileId + (isGpart ? '' : '?account_id=' + accountId);

    // Copy to clipboard automatically
    navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Link download berhasil disalin ke clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy text: ', err);
    });

    document.getElementById('modal-title').textContent = 'Bagikan File';
    document.getElementById('modal-body').innerHTML = `
        <p>File "<strong>${fileName}</strong>" telah dibagikan ke publik.</p>
        <p style="margin-top:8px; font-size:0.85rem; color:var(--text-secondary);">Gunakan link di bawah ini untuk mengunduh secara langsung:</p>
        <div class="share-link-container" style="display: flex; gap: 8px; margin-top: 12px; background: var(--bg-primary); padding: 8px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-medium);">
            <input type="text" value="${shareUrl}" id="share-link-input" readonly style="flex: 1; border: none; background: transparent; font-size: 0.85rem; color: var(--text-primary); outline: none;">
            <button id="btn-copy-share-link" class="btn btn-primary btn-sm" style="padding: 4px 12px; font-size: 0.8rem; height: auto;">Salin</button>
        </div>
    `;
    document.getElementById('modal-actions').innerHTML = `
        <button class="btn btn-primary btn-sm" onclick="closeModal()">Selesai</button>
    `;
    overlay.classList.add('active');

    // Add copy button listener inside modal
    setTimeout(() => {
        document.getElementById('btn-copy-share-link')?.addEventListener('click', () => {
            const input = document.getElementById('share-link-input');
            if (input) {
                input.select();
                navigator.clipboard.writeText(input.value).then(() => {
                    showToast('Link download disalin!', 'success');
                });
            }
        });
    }, 100);
}

async function toggleStar(fileId, accountId, starred) {
    try {
        const res = await fetch(`/api/files/star/${fileId}?account_id=${accountId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ starred })
        });
        const data = await res.json();
        if (data.success) {
            showToast(starred ? 'Berhasil menambahkan bintang.' : 'Berhasil menghapus bintang.', 'success');
            await refreshAll();
        } else {
            showToast(data.error || 'Gagal mengubah bintang.', 'error');
        }
    } catch (err) {
        showToast('Terjadi kesalahan jaringan.', 'error');
        console.error(err);
    }
}

async function toggleShare(fileId, accountId, shared) {
    try {
        const res = await fetch(`/api/files/share/${fileId}?account_id=${accountId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ shared })
        });
        const data = await res.json();
        if (data.success) {
            if (shared) {
                showShareModal(fileId, accountId, activeFile.name, fileId.startsWith('gpart:'));
            } else {
                showToast('File berhenti dibagikan.', 'success');
            }
            await refreshAll();
        } else {
            showToast(data.error || 'Gagal mengubah status berbagi.', 'error');
        }
    } catch (err) {
        showToast('Terjadi kesalahan jaringan.', 'error');
        console.error(err);
    }
}

// Global dropdown helpers: open context menu at the three-dots button position
function toggleFileDropdown(event) {
    event.stopPropagation();
    const trigger = event.currentTarget;
    const fileItem = trigger.closest('.file-item');
    if (!fileItem) return;

    const ctxMenu = document.getElementById('context-menu');
    if (!ctxMenu) return;

    // Set the active file details (crucial for context menu options to work)
    activeFile = {
        id: fileItem.getAttribute('data-id'),
        accountId: fileItem.getAttribute('data-account-id'),
        name: fileItem.getAttribute('data-name'),
        mimeType: fileItem.getAttribute('data-mime-type'),
        isStarred: fileItem.getAttribute('data-is-starred') === 'true',
        isShared: fileItem.getAttribute('data-is-shared') === 'true'
    };

    // Update context menu items based on file status
    const starText = document.getElementById('ctx-star-text');
    if (starText) {
        starText.textContent = activeFile.isStarred ? 'Hapus Bintang' : 'Beri Bintang';
    }
    const shareText = document.getElementById('ctx-share-text');
    const copyLinkOpt = document.getElementById('ctx-copy-link');
    if (activeFile.isShared) {
        if (shareText) shareText.textContent = 'Hentikan Berbagi';
        if (copyLinkOpt) copyLinkOpt.style.display = 'flex';
    } else {
        if (shareText) shareText.textContent = 'Bagikan Link';
        if (copyLinkOpt) copyLinkOpt.style.display = 'none';
    }

    const isFolder = activeFile.mimeType === 'application/vnd.google-apps.folder';
    const downloadOpt = document.getElementById('ctx-download');
    if (downloadOpt) downloadOpt.style.display = isFolder ? 'none' : 'flex';
    const moveOpt = document.getElementById('ctx-move');
    if (moveOpt) moveOpt.style.display = isFolder ? 'none' : 'flex';
    const openOpt = document.getElementById('ctx-open');
    if (openOpt) openOpt.style.display = isFolder ? 'flex' : 'none';

    // Position context menu relative to the three-dots trigger button
    const rect = trigger.getBoundingClientRect();
    
    // Display block first to calculate offsetHeight
    ctxMenu.style.display = 'block';

    const menuWidth = ctxMenu.offsetWidth || 200;
    const menuHeight = ctxMenu.offsetHeight || 250;

    let leftPos = rect.right - menuWidth;
    if (leftPos < 10) leftPos = 10;

    let topPos = rect.bottom + 6;
    if (topPos + menuHeight > window.innerHeight) {
        // Show above the button if it overflows bottom viewport
        topPos = rect.top - menuHeight - 6;
    }

    ctxMenu.style.left = `${leftPos}px`;
    ctxMenu.style.top = `${topPos}px`;
}
