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
    openReportWindow: (html) => ipcRenderer.invoke('open-report-window', html),
    printCurrentWindow: () => ipcRenderer.invoke('print-current-window'),
});
