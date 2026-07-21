const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('networkStore', {
    getAppVersion: () => ipcRenderer.invoke('app-version'),
    load: () => ipcRenderer.invoke('network-load'),
    save: (data) => ipcRenderer.invoke('network-save', data),
    getStatus: () => ipcRenderer.invoke('network-status'),
    releaseLock: () => ipcRenderer.invoke('network-release-lock'),
    listBackups: () => ipcRenderer.invoke('network-list-backups'),
    loadBackup: (filename) => ipcRenderer.invoke('network-load-backup', filename),
    uploadCloudPlan: (plan) => ipcRenderer.invoke('cloud-plan-upload', plan),
    uploadCloudHistory: (records) => ipcRenderer.invoke('cloud-history-upload', records),
    logAudit: (action, detail) => ipcRenderer.invoke('cloud-audit-log', action, detail),
    listAuditLog: (limit) => ipcRenderer.invoke('cloud-audit-list', limit),
    openReportWindow: (html) => ipcRenderer.invoke('open-report-window', html),
    printCurrentWindow: () => ipcRenderer.invoke('print-current-window'),
});

contextBridge.exposeInMainWorld('authStore', {
    getSession: () => ipcRenderer.invoke('auth-get-session'),
    login: (username, password, remember) => ipcRenderer.invoke('auth-login', username, password, remember),
    logout: () => ipcRenderer.invoke('auth-logout'),
    listUsers: () => ipcRenderer.invoke('auth-list-users'),
    createUser: (username, password, role) => ipcRenderer.invoke('auth-create-user', { username, password, role }),
    deleteUser: (username) => ipcRenderer.invoke('auth-delete-user', username),
});
