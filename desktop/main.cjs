'use strict';

/*
 * 牛币钱包 · macOS / 桌面外壳
 *
 * 设计原则：本文件不实现任何钱包逻辑。
 * 余额、转账、挖矿、合约、备份全部由现有 scripts/server.mjs + lab.mjs 负责，
 * 界面是 public/ 下的静态页面，通过本机 HTTP 接口与后端通信。
 * 因此 macOS 版与 Windows 版跑的是同一套业务代码、同一套数据格式。
 *
 * 与 Windows 启动器（tools/launcher.cs）的唯一差别：
 *   - Windows 用打包的 engine/node.exe 启动后端
 *   - 这里用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE），省掉一个运行时依赖
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const PORT = 18790;
const HOST = '127.0.0.1';
const URL_BASE = `http://${HOST}:${PORT}`;
const RESTORE_TEST = app.isPackaged && path.basename(process.execPath).includes('Restore Test');
const APP_URL = RESTORE_TEST ? `${URL_BASE}/?restore-test=1` : URL_BASE;

// The restore-test build is intentionally isolated from the real wallet. It
// exists so a user can prove that a portable backup restores their addresses
// without renaming, deleting or overwriting the valuable primary data folder.
if (RESTORE_TEST) {
  app.setName('NIU Wallet Restore Test');
  app.setPath('userData', path.join(app.getPath('appData'), 'NIU Wallet Restore Test'));
}

// 打包后资源位于 Resources/app-resources；开发时直接指向仓库根目录。
// scripts/lab.mjs 里的 ROOT = scripts 的父目录，所以后端 cwd 必须是这个目录。
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app-resources')
  : path.join(__dirname, '..');

let backend = null;
let win = null;
let quitting = false;
let backendOwned = false;

/* ---------- 端口探测 ---------- */

function probePort(timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: PORT, host: HOST });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(v);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), timeout);
  });
}

async function waitForServer(limitMs) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (await probePort()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/* ---------- 运行时目录 ---------- */

// 开发模式沿用 ROOT/runtime。打包后直接通过 NIU_DATA_DIR 把钱包和
// 链数据写入 Application Support，避免修改应用包或在升级时丢数据。
function prepareUserData() {
  const chainRoot = app.isPackaged
    ? path.join(app.getPath('userData'), 'chain')
    : path.join(APP_ROOT, 'runtime');
  // 26261017 is the shared NIU network. Keep it separate from the legacy
  // 26261015 local chain so an upgrade never mistakes local blocks for shared
  // network history. Preserve the wallet identity by copying only its encrypted
  // vault; chain data and activity are deliberately rebuilt from the network.
  const target = app.isPackaged
    ? path.join(chainRoot, 'network-26261017')
    : path.join(APP_ROOT, 'runtime', 'persistent');
  try {
    fs.mkdirSync(target, { recursive: true });
    if (app.isPackaged) {
      const vault = path.join(target, 'wallet.dpapi');
      const legacyVault = path.join(chainRoot, 'persistent', 'wallet.dpapi');
      if (!fs.existsSync(vault) && fs.existsSync(legacyVault)) {
        fs.copyFileSync(legacyVault, vault, fs.constants.COPYFILE_EXCL);
      }
    }
  } catch (err) {
    console.warn('[niu] 无法创建数据目录:', err.message);
    throw err;
  }
  return target;
}

/* ---------- 后端进程 ---------- */

function startBackend() {
  const entry = path.join(APP_ROOT, 'scripts', 'server.mjs');
  if (!fs.existsSync(entry)) {
    dialog.showErrorBox('缺少后端文件', `未找到 ${entry}\n请重新安装完整应用包。`);
    app.quit();
    return;
  }

  const customNetwork = fs.existsSync(path.join(APP_ROOT, 'network-config.json'));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const nodeName = (customNetwork ? 'niu-geth-candidate' : 'geth') + suffix;
  let nodeBin = path.join(APP_ROOT, 'bin', nodeName);
  // v0.3.8 macOS development builds used an .exe suffix on a Mach-O binary.
  // Keep that one-way fallback so existing local build folders still launch,
  // while new release packages use native platform names.
  if (process.platform === 'darwin' && !fs.existsSync(nodeBin)) {
    const legacy = nodeBin + '.exe';
    if (fs.existsSync(legacy)) nodeBin = legacy;
  }
  if (!fs.existsSync(nodeBin)) {
    dialog.showErrorBox(
      '缺少节点程序',
      `未找到 ${nodeBin}\n\n请重新安装完整应用包，或确认安装包内已包含 macOS 版节点。`
    );
    app.quit();
    return;
  }

  backend = spawn(process.execPath, [entry], {
    cwd: APP_ROOT,
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      NIU_DATA_DIR: prepareUserData(),
      NIU_NODE_BIN: nodeBin
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  backendOwned = true;

  backend.stdout.on('data', (d) => process.stdout.write('[niu] ' + d.toString()));
  backend.stderr.on('data', (d) => process.stderr.write('[niu] ' + d.toString()));

  backend.on('exit', (code, signal) => {
    console.log('[niu] 后端退出', code, signal);
    if (!quitting && win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        'window.__niuBanner && window.__niuBanner("节点已退出，请重新启动应用。", true)'
      ).catch(() => {});
    }
  });
}

async function stopBackend() {
  if (!backend || !backendOwned) return;
  if (backend.exitCode !== null) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    backend.once('exit', done);

    // server.mjs 监听 SIGTERM 并走优雅关闭：先停矿工，再等 geth 落盘。
    // 强杀会丢链头状态，所以这里给足时间（lab.mjs 的宽限期是 120 秒）。
    try { backend.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (settled) return;
      console.warn('[niu] 优雅关闭超时，强制结束');
      try { backend.kill('SIGKILL'); } catch (_) {}
      setTimeout(done, 1500);
    }, 125000);
  });
}

/* ---------- 窗口 ---------- */

function createWindow(loadNow = true) {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#F5F5F2',
    title: RESTORE_TEST ? '牛币钱包 · 恢复测试版' : '牛币钱包',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once('ready-to-show', () => win.show());

  // 页面里的外链一律交给系统浏览器，不在钱包窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (loadNow) win.loadURL(APP_URL);
  return win;
}

function loadStartupError(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>牛币钱包</title>
    <style>body{font:15px system-ui;margin:48px;color:#2b2925;background:#f5f5f2}h2{margin-bottom:12px}p{line-height:1.7}</style>
    <h2>钱包节点未能启动</h2><p>${message}</p><p>请退出应用，检查磁盘空间后重试。</p>`;
  return win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function buildMenu() {
  const template = [
    {
      label: '牛币钱包',
      submenu: [
        { role: 'about', label: '关于牛币钱包' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出牛币钱包' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    },
    { role: 'windowMenu', label: '窗口' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    prepareUserData();

    const alreadyRunning = await probePort();
    if (alreadyRunning && RESTORE_TEST) {
      win = createWindow(false);
      await loadStartupError('检测到普通牛币钱包仍在运行。请先正常退出普通钱包，再打开恢复测试版，确保使用独立测试数据。');
      return;
    } else if (alreadyRunning) {
      // 后端已在运行（例如上一次未完全退出），直接连现有实例，不再起第二个
      console.log('[niu] 检测到已运行的本机节点，直接连接');
      backendOwned = false;
    } else {
      startBackend();
    }

    // Do not navigate before the child process has bound its HTTP port. A fast
    // Electron renderer can otherwise win the race and keep an ERR_CONNECTION_REFUSED page.
    win = createWindow(false);

    const ready = await waitForServer(180000);
    if (ready) await win.loadURL(APP_URL);
    else await loadStartupError('节点启动超时。');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS 习惯：关窗口不退出进程。但后端仍在挖矿时不该偷偷留着，
    // 所以这里跟 Windows 一致 —— 关窗即退出并优雅停止节点。
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!backend || !backendOwned || backend.exitCode !== null) return;

    event.preventDefault();
    quitting = true;

    if (win && !win.isDestroyed()) {
      win.setTitle('牛币钱包 · 正在安全关闭节点…');
    }

    stopBackend().then(() => {
      app.quit();
    });
  });
}
