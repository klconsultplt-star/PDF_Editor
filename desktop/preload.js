/* The bridge between the desktop shell and the editor page: only these
   few functions are available to the page (no general file access). */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  onMergeFiles: (cb) => ipcRenderer.on('merge-files', (_e, files) => cb(files)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onSaved: (cb) => ipcRenderer.on('saved', (_e, path) => cb(path)),
  ready: () => ipcRenderer.send('renderer-ready'),
});
