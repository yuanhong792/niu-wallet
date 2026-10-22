(function () {
  'use strict';

  var TOKEN = (document.querySelector('meta[name="niu-token"]') || {}).content || '';
  var DEMO = new URLSearchParams(location.search).has('demo') || TOKEN === '__NIU_TOKEN__';
  var RESTORE_TEST = new URLSearchParams(location.search).has('restore-test');
  var POLL_MS = 2600;
  var LANGUAGE_CODES = ['zh-CN', 'en', 'ja', 'ko', 'es', 'ru'];
  var LANGUAGE_STORE = 'niu-wallet-language-v1';
  var currentLanguage = 'zh-CN';
  var languageCatalog = Object.create(null);
  var staticTextBindings = [];
  var staticAttributeBindings = [];

  var state = null;
  var inflight = false;
  var demoMining = false;
  var demoHeight = 79;
  var demoBlocks = [];
  var demoTxs = [];
  var demoState = null;
  var openTxHash = null;
  var txDetailCache = Object.create(null);
  var tokenDraftId = null;
  var compiledBuild = null;
  var loadedContract = null;
  var portfolioCache = null;
  var DEFAULT_SOLIDITY = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.20;',
    '',
    'contract NiuCounter {',
    '    uint256 public value;',
    '    event ValueChanged(address indexed author, uint256 value);',
    '',
    '    constructor(uint256 firstValue) {',
    '        value = firstValue;',
    '    }',
    '',
    '    function setValue(uint256 nextValue) external {',
    '        value = nextValue;',
    '        emit ValueChanged(msg.sender, nextValue);',
    '    }',
    '}'
  ].join('\n');

  /* ---------------- helpers ---------------- */

  function el(id) { return document.getElementById(id); }

  function tr(value) {
    if (typeof value !== 'string') return value;
    return languageCatalog[value] || value;
  }

  function rememberStaticTranslations() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE)$/.test(parent.tagName) || parent.closest('#languageSelect')) continue;
      var raw = node.nodeValue;
      var key = raw.trim();
      if (!key) continue;
      staticTextBindings.push({ node: node, key: key, before: raw.slice(0, raw.indexOf(key)), after: raw.slice(raw.indexOf(key) + key.length) });
    }
    var nodes = document.querySelectorAll('[placeholder],[aria-label],[title]');
    for (var i = 0; i < nodes.length; i++) {
      ['placeholder', 'aria-label', 'title'].forEach(function (name) {
        var value = nodes[i].getAttribute(name);
        if (value) staticAttributeBindings.push({ node: nodes[i], name: name, key: value });
      });
    }
  }

  function applyLanguage() {
    document.documentElement.lang = currentLanguage;
    document.title = tr('牛币钱包');
    for (var i = 0; i < staticTextBindings.length; i++) {
      var item = staticTextBindings[i];
      item.node.nodeValue = item.before + tr(item.key) + item.after;
    }
    for (var j = 0; j < staticAttributeBindings.length; j++) {
      var attr = staticAttributeBindings[j];
      attr.node.setAttribute(attr.name, tr(attr.key));
    }
    el('languageSelect').value = currentLanguage;
    if (state) render(state);
  }

  function preferredLanguage() {
    var stored = '';
    try { stored = localStorage.getItem(LANGUAGE_STORE) || ''; } catch (_) {}
    if (LANGUAGE_CODES.indexOf(stored) >= 0) return stored;
    var locale = navigator.language || 'zh-CN';
    if (locale.toLowerCase().indexOf('zh') === 0) return 'zh-CN';
    var shortCode = locale.toLowerCase().split('-')[0];
    return LANGUAGE_CODES.indexOf(shortCode) >= 0 ? shortCode : 'en';
  }

  function setLanguage(code, persist) {
    if (LANGUAGE_CODES.indexOf(code) < 0) code = 'en';
    return fetch('/locales/' + encodeURIComponent(code) + '.json', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('无法加载界面语言'); return res.json(); })
      .then(function (catalog) {
        currentLanguage = code;
        languageCatalog = catalog || Object.create(null);
        if (persist) {
          try { localStorage.setItem(LANGUAGE_STORE, code); } catch (_) {}
        }
        applyLanguage();
      });
  }

  function short(addr) {
    if (!addr) return '—';
    return addr.slice(0, 8) + '…' + addr.slice(-6);
  }

  function fmtNiu(value, dp) {
    if (value === undefined || value === null) return '0';
    var s = String(value);
    if (s.indexOf('.') === -1) return s;
    var parts = s.split('.');
    var frac = parts[1].slice(0, dp === undefined ? 6 : dp).replace(/0+$/, '');
    return frac ? parts[0] + '.' + frac : parts[0];
  }

  function fmtTokenAmount(value) {
    if (value === undefined || value === null || value === '') return '0';
    var parts = String(value).split('.');
    var integer = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var fraction = parts.length > 1 ? parts[1].replace(/0+$/, '') : '';
    return fraction ? integer + '.' + fraction : integer;
  }

  function primaryTokenTransfer(item) {
    var transfers = (item && item.tokenTransfers) || [];
    if (!transfers.length) return null;
    var wallets = ((state && state.wallets) || []).map(function (wallet) { return wallet.address.toLowerCase(); });
    var field = item.dir === 'in' ? 'to' : 'from';
    return transfers.filter(function (transfer) {
      return transfer[field] && wallets.indexOf(transfer[field].toLowerCase()) >= 0;
    })[0] || transfers[0];
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function exactWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function shortHash(hash) {
    if (!hash) return '哈希未知';
    return hash.slice(0, 12) + '…' + hash.slice(-8);
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function text(node, value) {
    var result = value == null ? '' : String(value);
    node.textContent = tr(result);
  }

  function toast(msg) {
    var t = el('toast');
    text(t, msg);
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function banner(msg, isError) {
    var b = el('banner');
    if (!msg) { b.hidden = true; return; }
    text(b, msg);
    b.hidden = false;
    b.className = 'banner' + (isError ? ' is-error' : '');
  }

  function copy(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { toast('已复制'); },
        function () { toast('复制失败，请手动选择'); });
    } else {
      toast('当前环境不支持自动复制');
    }
  }

  function parseArray(value, label) {
    var parsed;
    try { parsed = JSON.parse(value || '[]'); } catch (_) { throw new Error((label || '参数') + '必须是有效的 JSON 数组'); }
    if (!Array.isArray(parsed)) throw new Error((label || '参数') + '必须是 JSON 数组');
    return parsed;
  }

  function resultBox(id, message, error) {
    var node = el(id);
    node.hidden = false;
    node.className = 'result' + (error ? ' is-error' : '');
    text(node, message);
  }

  function ensureUnlocked(subtitle) {
    if (!state || !state.locked) return Promise.resolve();
    return ask({ title: '解锁钱包', sub: subtitle || '签名交易需要解锁钱包。', password: true, placeholder: '输入口令' })
      .then(function (password) {
        if (password === null) throw new Error('已取消');
        return api('/api/unlock', { password: password }).then(function () { if (state) state.locked = false; });
      });
  }

  function showReceiveAddress(address) {
    var value = address || '';
    text(el('receiveAddr'), value || '——');
    var qr = el('receiveQr');
    var empty = el('receiveQrEmpty');
    if (value) {
      qr.src = '/api/qr?address=' + encodeURIComponent(value);
      qr.hidden = false;
      empty.hidden = true;
    } else {
      qr.removeAttribute('src');
      qr.hidden = true;
      empty.hidden = false;
    }
  }

  /* ---------------- modal ---------------- */

  var modalResolve = null;

  function ask(opts) {
    return new Promise(function (resolve) {
      el('modalTitle').textContent = tr(opts.title || '请输入');
      el('modalSub').textContent = tr(opts.sub || '');
      var input = el('modalInput');
      input.value = opts.value || '';
      input.type = opts.password ? 'password' : 'text';
      input.placeholder = tr(opts.placeholder || '');
      el('modal').hidden = false;
      modalResolve = resolve;
      setTimeout(function () { input.focus(); }, 30);
    });
  }

  function closeModal(value) {
    el('modal').hidden = true;
    var r = modalResolve;
    modalResolve = null;
    if (r) r(value);
  }

  el('modalOk').addEventListener('click', function () { closeModal(el('modalInput').value); });
  el('modalCancel').addEventListener('click', function () { closeModal(null); });
  el('modalInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); closeModal(el('modalInput').value); }
    if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
  });

  /* ---------------- api ---------------- */

  function api(path, payload) {
    if (DEMO) return demoApi(path, payload);
    var init = { method: payload ? 'POST' : 'GET', headers: {} };
    if (payload) {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-Niu-Token'] = TOKEN;
      init.body = JSON.stringify(payload);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
        return data;
      });
    });
  }

  /* ---------------- demo backend ---------------- */

  function demoAddr(n) {
    var base = '0x7a3f91c2d84b5e6f0a1b2c3d4e5f60718293a4b';
    return base + (n || 0).toString(16).padStart(2, '0');
  }

  function demoNow() { return new Date().toISOString(); }

  function seedDemo() {
    demoBlocks = [];
    for (var i = 0; i < 6; i++) {
      demoBlocks.push({
        number: demoHeight - i,
        hash: '0x' + (Math.random().toString(16) + '000000000000').slice(2, 18) + 'a4f9c1d2e7b3',
        transactions: i === 0 ? 1 : 0,
        timestamp: Math.floor(Date.now() / 1000) - i * 62
      });
    }
    demoTxs = [
      { hash: '0xe71c4a90b2d5f8136c7d2e0a9b4f5c1d8e3a6b0c9d2f4e7a1b3c5d8e0f2a4b6c', dir: 'out', kind: '发送代币 AGSP', from: demoAddr(0), to: demoAddr(5), counterparty: demoAddr(9), amount: '0.0', block: demoHeight - 2, status: 'confirmed', confirmations: 3, at: new Date(Date.now() - 130000).toISOString(), call: true,
        input: '0xa9059cbb000000000000000000000000' + demoAddr(9).slice(2) + '000000000000000000000000000000000000000000000000000000003b9aca00',
        tokenTransfers: [{ contract: demoAddr(5), from: demoAddr(0), to: demoAddr(9), rawAmount: '1000000000', amount: '1000.0', method: 'transfer', source: 'event', name: 'AGSP Token', symbol: 'AGSP', decimals: 6, recognized: true }] },
      { hash: '0x3f8d2c7a1b9e5f046c8d3a2b7e1f9c4d0a6b8e2f5c7d1a3b9e0f4c6d2a8b1e5f', dir: 'out', kind: '转出', from: demoAddr(0), to: demoAddr(1), amount: '250.0', block: demoHeight - 7, status: 'confirmed', confirmations: 8, at: new Date(Date.now() - 480000).toISOString(), call: false },
      { hash: '0x9a2e6f1c8d4b7a0e3f5c2d9b6a8e1f4c7d0b3a5e8f2c6d1b4a9e7f0c3d5b8a2e', dir: 'out', kind: '转出', from: demoAddr(0), to: demoAddr(9), amount: '40.5', block: demoHeight - 14, status: 'confirmed', confirmations: 15, at: new Date(Date.now() - 900000).toISOString(), call: true },
      { hash: '0x5c1d8b3f7a2e9c4d6b0f8a1e5c3d7b9a2f4e6c8d0b1a3e5f7c9d2b4a6e8f0c1d', dir: 'in', kind: '收款', from: demoAddr(1), to: demoAddr(0), amount: '120.0', block: demoHeight - 21, status: 'confirmed', confirmations: 22, at: new Date(Date.now() - 1400000).toISOString(), call: false }
    ];
    demoTxs.forEach(function (t, i) {
      t.blockHash = '0x' + String(i + 1).repeat(64);
    });
  }

  function demoStateFn() {
    var total = (13999.999281 + (demoMining ? 1000 : 0) + 1000 + 250 + 40.5 + 120).toFixed(6);
    return {
      name: '牛链网络',
      chainId: 26261017,
      genesisHash: '0x' + '4b8e2c1d9f7a3e6b0c5d8a2f4e7b1c9d3a6f8e0b2c4d7a9f1e3b5c8d0a2f6e4b',
      heights: [demoHeight, demoHeight],
      peers: 1,
      syncing: false,
      connectionStatus: 'connected',
      mining: demoMining,
      miningUntil: null,
      busy: false,
      locked: false,
      wallets: [
        { address: demoAddr(0), balance: total, name: '默认挖矿地址' },
        { address: demoAddr(1), balance: '500.0', name: '收款地址2' }
      ],
      walletTotal: total,
      contacts: [{ address: demoAddr(9), label: '测试收款' }],
      backupRequired: false,
      activeReceivingAddress: demoAddr(0),
      blocks: demoBlocks,
      transactions: demoTxs,
      contract: { address: demoAddr(4), message: '牛币钱包 · 跨平台界面原型', updates: '3', owner: demoAddr(0) },
      tokens: [{ id: 'demo-token', address: demoAddr(5), name: 'Niu Community Token', symbol: 'NCT', decimals: 18, mode: 'fixed' }],
      developerContracts: [{ id: 'demo-contract', name: 'NiuCounter', contractName: 'NiuCounter', address: demoAddr(6) }],
      walletProtection: '演示数据 · 未连接节点',
      dataPath: '（演示模式）'
    };
  }

  function demoApi(path, payload) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (path === '/api/state') return resolve(demoStateFn());
        if (path.indexOf('/api/transaction?') === 0) {
          var requested = new URL(path, location.origin).searchParams.get('hash');
          var found = demoTxs.find(function (t) { return t.hash === requested; });
          if (!found) return reject(new Error('钱包交易记录中没有这笔交易'));
          return resolve({
            hash: found.hash, status: found.status, confirmations: found.confirmations,
            blockNumber: found.block, blockHash: found.blockHash, transactionIndex: 0,
            timestamp: found.at, from: found.from, to: found.to, amount: found.amount,
            nonce: 12, type: 0, chainId: 26261017, gasLimit: '21000', gasUsed: '21000',
            gasPriceWei: '2000000000', gasPriceGwei: '2.0', fee: '0.000042',
            input: found.input || (found.call ? '0x6d657373616765' : '0x'), inputBytes: found.input ? (found.input.length - 2) / 2 : (found.call ? 7 : 0),
            contractAddress: null, logsCount: found.tokenTransfers ? found.tokenTransfers.length : 0,
            assetType: found.tokenTransfers ? 'erc20' : 'native', tokenTransfers: found.tokenTransfers || []
          });
        }
        if (path === '/api/mine') { demoMining = !!payload.enabled; return resolve({ mining: demoMining, until: null }); }
        if (path === '/api/transfer') {
          demoTxs.unshift({ hash: '0x' + Math.random().toString(16).slice(2) + 'a1b2c3d4e5f6', dir: 'out', kind: '转出', from: payload.from, to: payload.to, amount: payload.amount, block: demoHeight + 1, status: 'confirmed', confirmations: 1, at: demoNow(), call: false });
          return resolve({ hash: demoTxs[0].hash, block: demoHeight + 1 });
        }
        if (path === '/api/deploy' || path === '/api/message') {
          demoState = demoState || demoStateFn();
          demoState.contract.message = payload.message;
          return resolve({ hash: '0x' + Math.random().toString(16).slice(2) });
        }
        if (path === '/api/token/portfolio') return resolve({ tokens: [{
          id: 'demo-token', address: demoAddr(5), name: 'Niu Community Token', symbol: 'NCT', decimals: 18,
          mode: 'fixed', totalSupplyFormatted: '100000000', balances: [{ address: demoAddr(0), formatted: '100000000' }, { address: demoAddr(1), formatted: '0' }]
        }] });
        if (path === '/api/token/prepare') return resolve({ draftId: 'demo-draft', gas: '780000', gasPriceGwei: '2', estimatedFeeNIU: '0.00156', sourceHash: '0x' + 'ab'.repeat(32), mode: payload.options.mode, name: payload.options.name, symbol: payload.options.symbol });
        if (path === '/api/token/issue') return resolve({ address: demoAddr(7), hash: '0x' + 'cd'.repeat(32), block: demoHeight + 1 });
        if (path === '/api/token/import') return resolve({ id: 'demo-token', address: payload.address, name: 'Demo Token', symbol: 'DMT', decimals: 18 });
        if (path === '/api/token/transfer') return resolve({ hash: '0x' + 'ef'.repeat(32), block: demoHeight + 1 });
        if (path === '/api/solidity/compile') return resolve({ buildId: 'demo-build', compilerVersion: '0.8.37', evmVersion: 'london', warnings: [], artifacts: [{ name: 'NiuCounter', abi: [{ type: 'constructor', inputs: [{ name: 'firstValue', type: 'uint256' }] }, { type: 'function', name: 'value', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }, { type: 'function', name: 'setValue', inputs: [{ name: 'nextValue', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }], bytecode: '0x6000', bytecodeBytes: 420, runtimeBytes: 300 }] });
        if (path === '/api/solidity/estimate') return resolve({ gas: '245000', gasPriceGwei: '2', estimatedFeeNIU: '0.00049', bytecodeBytes: 420 });
        if (path === '/api/solidity/deploy') return resolve({ id: 'demo-contract', address: demoAddr(6), hash: '0x' + '12'.repeat(32), block: demoHeight + 1 });
        if (path === '/api/contract/info') return resolve({ id: 'demo-contract', name: 'NiuCounter', address: demoAddr(6), abi: [{ type: 'function', name: 'value', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }, { type: 'function', name: 'setValue', inputs: [{ name: 'nextValue', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] });
        if (path === '/api/contract/import') return resolve({ id: 'demo-contract', address: payload.address, name: payload.name });
        if (path === '/api/contract/read') return resolve({ result: '42' });
        if (path === '/api/contract/write') return resolve({ hash: '0x' + '34'.repeat(32), block: demoHeight + 1 });
        if (path === '/api/lock') { demoState = null; return resolve({ locked: true }); }
        if (path === '/api/unlock') return resolve({ unlocked: true });
        if (path === '/api/backup-portable') return resolve({ path: '（演示模式不生成文件）', scope: '可跨电脑恢复' });
        if (path === '/api/import-wallet') return resolve({ added: 0, total: 2, addresses: [demoAddr(0), demoAddr(1)] });
        if (path === '/api/import-wallet-data') return resolve({ added: 2, total: 4, addresses: [demoAddr(0), demoAddr(1), demoAddr(2), demoAddr(3)] });
        if (path === '/api/new-address') return resolve({ address: demoAddr(2), backupRequired: true });
        reject(new Error('演示模式不支持该操作'));
      }, 220);
    });
  }

  /* ---------------- render ---------------- */

  function renderStatus(s) {
    var conn = s.connectionStatus || 'disconnected';
    var bars = el('bars');
    var label = el('peerLabel');
    var meta = el('peerMeta');
    bars.className = 'bars';
    if (conn === 'connected') {
      bars.classList.add('on-4');
      text(label, '已连接');
    } else if (conn === 'syncing') {
      bars.classList.add('on-2');
      text(label, '同步中');
    } else {
      bars.classList.add('off');
      text(label, '未连接');
    }
    var h = (s.heights && s.heights[0]) || 0;
    text(meta, '高度 ' + h + ' · 节点 ' + (s.peers == null ? 0 : s.peers));
    text(el('netName'), s.name || '牛链');
    text(el('statHeight'), h);
    text(el('statChain'), s.chainId == null ? '—' : s.chainId);
  }

  function renderOverview(s) {
    text(el('totalBalance'), fmtNiu(s.walletTotal));
    var active = s.activeReceivingAddress || (s.wallets[0] && s.wallets[0].address) || '';
    text(el('heroAddr'), active || '尚未创建地址');

    var list = el('addrList');
    clear(list);
    (s.wallets || []).forEach(function (w) {
      var row = document.createElement('div');
      row.className = 'addr-row';

      var main = document.createElement('div');
      main.className = 'addr-main';
      var name = document.createElement('div');
      name.className = 'addr-name';
      text(name, w.name || '地址');
      var hex = document.createElement('div');
      hex.className = 'addr-hex';
      text(hex, w.address);
      main.appendChild(name);
      main.appendChild(hex);

      var bal = document.createElement('div');
      bal.className = 'addr-bal';
      text(bal, fmtNiu(w.balance, 4) + ' NIU');

      row.appendChild(main);
      row.appendChild(bal);
      list.appendChild(row);
    });
    if (!s.wallets || !s.wallets.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      text(e, '还没有地址');
      list.appendChild(e);
    }

    var blocks = el('blockList');
    clear(blocks);
    (s.blocks || []).forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'block-row';
      var num = document.createElement('span');
      num.className = 'block-num';
      text(num, '#' + b.number);
      var hash = document.createElement('span');
      hash.className = 'block-hash';
      text(hash, b.hash || '');
      var tx = document.createElement('span');
      tx.className = 'block-tx';
      text(tx, b.transactions + ' 笔');
      row.appendChild(num);
      row.appendChild(hash);
      row.appendChild(tx);
      blocks.appendChild(row);
    });
    if (!s.blocks || !s.blocks.length) {
      var eb = document.createElement('div');
      eb.className = 'empty';
      text(eb, '暂无区块');
      blocks.appendChild(eb);
    }

    renderTxList(el('txListMini'), (s.transactions || []).slice(0, 3), false);
    renderTxList(el('txListFull'), s.transactions || [], true);
  }

  function transactionStatus(status, confirmations) {
    if (status === 'confirmed') return confirmations > 1 ? '已确认 ' + confirmations : '已确认';
    if (status === 'failed') return '失败';
    if (status === 'reorged') return '已回退';
    return '待确认';
  }

  function addTxDetail(grid, label, value, copyable, wide) {
    var cell = document.createElement('div');
    cell.className = 'tx-detail-cell' + (wide ? ' is-wide' : '');
    var key = document.createElement('div');
    key.className = 'tx-detail-key';
    text(key, label);
    var line = document.createElement('div');
    line.className = 'tx-detail-value-line';
    var val = document.createElement('div');
    val.className = 'tx-detail-value';
    text(val, value == null || value === '' ? '—' : value);
    line.appendChild(val);
    if (copyable && value) {
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'tx-copy';
      text(copyBtn, '复制');
      copyBtn.addEventListener('click', function () { copy(String(value)); });
      line.appendChild(copyBtn);
    }
    cell.appendChild(key);
    cell.appendChild(line);
    grid.appendChild(cell);
  }

  function renderTxDetails(node, item, entry) {
    if (!entry || entry.loading) {
      node.className = 'tx-detail is-loading';
      text(node, '正在从节点读取交易明细…');
      return;
    }
    if (entry.error) {
      node.className = 'tx-detail is-error';
      text(node, entry.error);
      return;
    }
    var d = entry.data;
    node.className = 'tx-detail';
    var grid = document.createElement('div');
    grid.className = 'tx-detail-grid';
    addTxDetail(grid, '交易哈希', d.hash || item.hash, true, true);
    addTxDetail(grid, '状态', transactionStatus(d.status, d.confirmations), false, false);
    addTxDetail(grid, '交易时间', exactWhen(d.timestamp), false, false);
    addTxDetail(grid, '转出方', d.from, true, true);
    addTxDetail(grid, d.tokenTransfers && d.tokenTransfers.length ? '调用合约' : '收款方', d.to || (d.contractAddress ? '创建合约' : '—'), !!d.to, true);
    addTxDetail(grid, d.tokenTransfers && d.tokenTransfers.length ? '原生币金额' : '金额', fmtNiu(d.amount, 8) + ' NIU', false, false);
    addTxDetail(grid, '手续费', d.fee == null ? '等待确认' : fmtNiu(d.fee, 8) + ' NIU', false, false);
    (d.tokenTransfers || []).forEach(function (transfer, index) {
      var suffix = d.tokenTransfers.length > 1 ? ' ' + (index + 1) : '';
      addTxDetail(grid, tr('代币数量') + suffix, fmtTokenAmount(transfer.amount) + ' ' + (transfer.symbol || 'ERC-20'), false, false);
      addTxDetail(grid, tr('调用方法') + suffix, transfer.method || 'Transfer', false, false);
      addTxDetail(grid, tr('代币名称') + suffix, (transfer.name ? transfer.name + ' (' + transfer.symbol + ')' : transfer.symbol) + (transfer.recognized ? '' : ' · ' + tr('未验证元数据')), false, false);
      addTxDetail(grid, tr('解析依据') + suffix, transfer.source === 'event' ? '链上 Transfer 事件' : '交易输入（等待链上事件确认）', false, false);
      addTxDetail(grid, tr('代币合约') + suffix, transfer.contract, true, true);
      addTxDetail(grid, tr('代币转出方') + suffix, transfer.from, true, true);
      addTxDetail(grid, tr('代币收款方') + suffix, transfer.to, true, true);
      addTxDetail(grid, tr('最小单位数量') + suffix, transfer.rawAmount, true, true);
    });
    addTxDetail(grid, '区块高度', d.blockNumber == null ? '待打包' : '#' + d.blockNumber, false, false);
    addTxDetail(grid, '区块内序号', d.transactionIndex == null ? '—' : d.transactionIndex, false, false);
    addTxDetail(grid, '区块哈希', d.blockHash, true, true);
    addTxDetail(grid, '确认数', d.confirmations, false, false);
    addTxDetail(grid, 'Nonce', d.nonce, false, false);
    addTxDetail(grid, 'Gas 使用 / 上限', (d.gasUsed || '—') + ' / ' + (d.gasLimit || '—'), false, false);
    addTxDetail(grid, 'Gas 单价', d.gasPriceGwei == null ? '—' : fmtNiu(d.gasPriceGwei, 9) + ' Gwei', false, false);
    addTxDetail(grid, '交易类型', d.type === 0 ? '0（传统交易）' : (d.type == null ? '—' : String(d.type)), false, false);
    addTxDetail(grid, '链 ID', d.chainId, false, false);
    if (d.contractAddress) addTxDetail(grid, '创建的合约', d.contractAddress, true, true);
    addTxDetail(grid, '输入数据 (' + (d.inputBytes || 0) + ' 字节)', d.input === '0x' ? '0x（无附加数据）' : d.input, d.input !== '0x', true);
    node.appendChild(grid);
  }

  function loadTxDetails(hash) {
    txDetailCache[hash] = { loading: true };
    if (state) renderOverview(state);
    api('/api/transaction?hash=' + encodeURIComponent(hash)).then(function (details) {
      txDetailCache[hash] = { data: details };
    }).catch(function (err) {
      txDetailCache[hash] = { error: err.message || '读取交易明细失败' };
    }).then(function () {
      if (state && openTxHash === hash) renderOverview(state);
    });
  }

  function renderTxList(node, items, allowDetails) {
    clear(node);
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      text(e, '还没有交易记录');
      node.appendChild(e);
      return;
    }
    items.forEach(function (t) {
      var item = document.createElement('div');
      item.className = 'tx-item';
      var row = document.createElement(allowDetails ? 'button' : 'div');
      row.className = 'tx-row' + (allowDetails ? ' tx-button' : '');
      if (allowDetails) {
        row.type = 'button';
        row.setAttribute('aria-expanded', openTxHash === t.hash ? 'true' : 'false');
        row.title = '点击查看完整交易明细';
      }

      var dir = document.createElement('div');
      dir.className = 'tx-dir ' + (t.dir === 'in' ? 'in' : 'out');
      text(dir, t.dir === 'in' ? '收' : '转');

      var body = document.createElement('div');
      body.className = 'tx-body';
      var title = document.createElement('div');
      title.className = 'tx-title';
      var tokenTransfer = primaryTokenTransfer(t);
      var counterparty = t.counterparty || (t.dir === 'in' ? t.from : t.to);
      text(title, tokenTransfer
        ? tr(t.dir === 'in' ? '收到代币' : '发送代币') + ' ' + (tokenTransfer.symbol || 'ERC-20') + ' · ' + short(counterparty)
        : tr(t.dir === 'in' ? '来自' : '转给') + ' ' + short(counterparty));
      var sub = document.createElement('div');
      sub.className = 'tx-sub';
      text(sub, when(t.at) + ' · 区块 ' + (t.block == null ? '待打包' : '#' + t.block) + ' · ' + shortHash(t.hash));
      body.appendChild(title);
      body.appendChild(sub);

      var right = document.createElement('div');
      right.className = 'tx-right';
      var amount = document.createElement('div');
      amount.className = 'tx-amount' + (t.dir === 'in' ? ' in' : '');
      text(amount, (t.dir === 'in' ? '+' : '−') + (tokenTransfer
        ? fmtTokenAmount(tokenTransfer.amount) + ' ' + (tokenTransfer.symbol || 'ERC-20')
        : fmtNiu(t.amount, 4) + ' NIU'));
      var st = document.createElement('div');
      var klass = 'tx-state';
      var label = transactionStatus(t.status, t.confirmations);
      if (t.status === 'confirmed') { klass += ' ok'; }
      else if (t.status === 'failed') { klass += ' bad'; label = '失败'; }
      else if (t.status === 'reorged') { klass += ' bad'; label = '已回退'; }
      else { klass += ' pending'; label = '待确认'; }
      st.className = klass;
      text(st, label);
      right.appendChild(amount);
      right.appendChild(st);

      if (allowDetails) {
        var arrow = document.createElement('span');
        arrow.className = 'tx-arrow';
        text(arrow, openTxHash === t.hash ? '收起' : '详情');
        right.appendChild(arrow);
        row.addEventListener('click', function () {
          if (openTxHash === t.hash) openTxHash = null;
          else {
            openTxHash = t.hash;
            if (!txDetailCache[t.hash]) loadTxDetails(t.hash);
          }
          if (state) renderOverview(state);
        });
      }

      row.appendChild(dir);
      row.appendChild(body);
      row.appendChild(right);
      item.appendChild(row);
      if (allowDetails && openTxHash === t.hash) {
        var detail = document.createElement('div');
        renderTxDetails(detail, t, txDetailCache[t.hash]);
        item.appendChild(detail);
      }
      node.appendChild(item);
    });
  }

  function fillWalletSelect(id, wallets) {
    var node = el(id);
    var previous = node.value;
    clear(node);
    (wallets || []).forEach(function (wallet) {
      var option = document.createElement('option');
      option.value = wallet.address;
      text(option, (wallet.name || short(wallet.address)) + ' · ' + fmtNiu(wallet.balance, 3) + ' NIU');
      node.appendChild(option);
    });
    if (previous && (wallets || []).some(function (wallet) { return wallet.address === previous; })) node.value = previous;
  }

  function renderContractAssets(s) {
    var tokenSelect = el('tokenSendAsset');
    var previousToken = tokenSelect.value;
    clear(tokenSelect);
    (s.tokens || []).filter(function (token) { return !token.failed; }).forEach(function (token) {
      var option = document.createElement('option');
      option.value = token.address;
      text(option, token.symbol + ' · ' + short(token.address));
      tokenSelect.appendChild(option);
    });
    if (previousToken) tokenSelect.value = previousToken;

    var contracts = el('savedContract');
    var previousContract = contracts.value;
    clear(contracts);
    var emptyOption = document.createElement('option');
    emptyOption.value = '';
    text(emptyOption, '选择已保存合约');
    contracts.appendChild(emptyOption);
    (s.developerContracts || []).filter(function (item) { return !item.failed; }).forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.id;
      text(option, item.name + ' · ' + short(item.address));
      contracts.appendChild(option);
    });
    if (previousContract && (s.developerContracts || []).some(function (item) { return item.id === previousContract; })) contracts.value = previousContract;
  }

  function renderPortfolio(data) {
    portfolioCache = data;
    var node = el('tokenList');
    clear(node);
    var tokens = (data && data.tokens) || [];
    if (!tokens.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      text(empty, '尚未添加代币');
      node.appendChild(empty);
      return;
    }
    tokens.forEach(function (token) {
      var card = document.createElement('div');
      card.className = 'token-card';
      var identity = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'token-name';
      text(name, (token.name || '未知代币') + ' (' + (token.symbol || '?') + ')');
      var address = document.createElement('div');
      address.className = 'token-address';
      text(address, token.address);
      address.title = token.address;
      address.addEventListener('click', function () { copy(token.address); });
      identity.appendChild(name); identity.appendChild(address);
      var balance = document.createElement('div');
      balance.className = 'token-balance';
      var strong = document.createElement('strong');
      text(strong, token.error ? '读取失败' : fmtNiu(token.walletTotalFormatted, 8) + ' ' + token.symbol);
      var supply = document.createElement('span');
      text(supply, token.error ? token.error : '总量 ' + fmtNiu(token.totalSupplyFormatted, 6));
      balance.appendChild(strong); balance.appendChild(supply);
      var mode = document.createElement('div');
      mode.className = 'token-mode';
      text(mode, token.mode === 'managed' ? '管理型' : (token.mode === 'fixed' ? '固定总量' : '已导入'));
      card.appendChild(identity); card.appendChild(balance); card.appendChild(mode);
      node.appendChild(card);
    });
  }

  function loadPortfolio() {
    return api('/api/token/portfolio', {}).then(function (data) { renderPortfolio(data); return data; })
      .catch(function (error) { resultBox('tokenSendResult', error.message, true); });
  }

  function signatureOf(item) {
    return item.name + '(' + (item.inputs || []).map(function (input) { return input.type; }).join(',') + ')';
  }

  function showLoadedContract(record) {
    loadedContract = record;
    text(el('savedContractAddress'), record ? record.address : '尚未选择合约');
    var select = el('contractFunction');
    clear(select);
    (record && record.abi || []).filter(function (item) { return item.type === 'function'; }).forEach(function (item) {
      var option = document.createElement('option');
      option.value = signatureOf(item);
      option.dataset.mode = (item.stateMutability === 'view' || item.stateMutability === 'pure') ? 'read' : 'write';
      text(option, option.value + ' · ' + (option.dataset.mode === 'read' ? '只读' : '写入'));
      select.appendChild(option);
    });
    updateContractButtons();
    text(el('contractCallOutput'), record ? '请选择函数并填写 JSON 参数数组' : '等待选择合约');
  }

  function updateContractButtons() {
    var option = el('contractFunction').selectedOptions[0];
    var mode = option && option.dataset.mode;
    el('contractRead').disabled = mode !== 'read';
    el('contractWrite').disabled = mode !== 'write';
  }

  function renderForms(s) {
    var from = el('sendFrom');
    var prevFrom = from.value;
    clear(from);
    (s.wallets || []).forEach(function (w) {
      var o = document.createElement('option');
      o.value = w.address;
      text(o, (w.name || '地址') + ' · ' + fmtNiu(w.balance, 3) + ' NIU');
      from.appendChild(o);
    });
    if (prevFrom) from.value = prevFrom;

    ['tokenOwner', 'tokenSendFrom', 'contractDeployFrom', 'contractCallFrom'].forEach(function (id) { fillWalletSelect(id, s.wallets || []); });
    renderContractAssets(s);

    var recvSel = el('receiveSelect');
    var prevRecv = recvSel.value;
    clear(recvSel);
    (s.wallets || []).forEach(function (w) {
      var o = document.createElement('option');
      o.value = w.address;
      text(o, w.name || short(w.address));
      recvSel.appendChild(o);
    });
    var active = s.activeReceivingAddress || (s.wallets[0] && s.wallets[0].address) || '';
    if (prevRecv && (s.wallets || []).some(function (w) { return w.address === prevRecv; })) recvSel.value = prevRecv;
    else if (active) recvSel.value = active;
    showReceiveAddress(recvSel.value || active);

    text(el('mineAddr'), short(s.wallets[0] && s.wallets[0].address));

    var on = !!s.mining;
    el('mineCard').className = 'mine-card' + (on ? ' is-on' : '');
    text(el('mineText'), on ? '挖矿中' : '已停止');
    text(el('mineMeta'), on ? '本机正在参与出块' : '当前未参与出块');
    text(el('mineBtn'), on ? '停止挖矿' : '开始挖矿');
    el('mineBtn').disabled = !!s.busy;

    var contract = s.contract;
    text(el('contractAddr'), contract ? (contract.address + (contract.pending ? '（部署中）' : '')) : '尚未部署');
    if (contract && contract.message && document.activeElement !== el('contractMsg')) {
      el('contractMsg').value = contract.message;
    }
    text(el('contractNote'), contract
      ? '已更新 ' + (contract.updates || '0') + ' 次'
      : '部署后会把当前留言写入链上合约');

    text(el('protectMode'), s.walletProtection || '—');
    text(el('lockState'), s.locked ? '已锁定' : '已解锁');
    text(el('dataPath'), s.dataPath || '—');
    el('dataPath').title = s.dataPath || '';

    renderContacts(s.contacts || []);

    if (RESTORE_TEST) banner('恢复测试版使用独立数据目录，不会修改普通钱包。测试完成后请退出本程序，再打开普通钱包。', false);
    else if (s.backupRequired) banner('检测到新地址尚未备份。建议在「设置」中导出备份，避免本机故障后无法恢复。', false);
  }

  function renderContacts(list) {
    var node = el('contactList');
    clear(node);
    if (!list.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      text(e, '还没有联络人');
      node.appendChild(e);
      return;
    }
    list.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'addr-row';
      var main = document.createElement('div');
      main.className = 'addr-main';
      var name = document.createElement('div');
      name.className = 'addr-name';
      text(name, c.label || '联络人');
      var hex = document.createElement('div');
      hex.className = 'addr-hex';
      text(hex, c.address);
      main.appendChild(name);
      main.appendChild(hex);
      var btn = document.createElement('button');
      btn.className = 'ghost-btn';
      text(btn, '填入发送');
      btn.addEventListener('click', function () {
        el('sendTo').value = c.address;
        go('send');
      });
      row.appendChild(main);
      row.appendChild(btn);
      node.appendChild(row);
    });
  }

  function render(s) {
    renderStatus(s);
    renderOverview(s);
    renderForms(s);
  }

  /* ---------------- state loop ---------------- */

  function loadState() {
    if (inflight) return Promise.resolve();
    inflight = true;
    return api('/api/state').then(function (data) {
      if (data.initializing) {
        banner('节点正在启动，请稍候…', false);
        return;
      }
      if (data.error) { banner(data.error, true); return; }
      banner('');
      state = data;
      render(data);
    }).catch(function (err) {
      banner(DEMO ? '' : ('无法连接本机节点：' + err.message), !DEMO);
    }).then(function () {
      inflight = false;
    });
  }

  function tickDemo() {
    if (!DEMO) return;
    demoHeight += 1;
    demoBlocks.unshift({
      number: demoHeight,
      hash: '0x' + Math.random().toString(16).slice(2) + 'c4d8e1f7a3b2',
      transactions: demoMining ? 1 : 0,
      timestamp: Math.floor(Date.now() / 1000)
    });
    demoBlocks = demoBlocks.slice(0, 6);
    if (demoMining) {
      demoTxs.unshift({
        hash: '0x' + Math.random().toString(16).slice(2) + 'f1a2b3c4d5e6',
        dir: 'in', kind: '收款', from: '矿工奖励', to: demoAddr(0), amount: '1000.0',
        block: demoHeight, status: 'confirmed', confirmations: 1, at: demoNow(), call: false
      });
      demoTxs = demoTxs.slice(0, 12);
    }
  }

  /* ---------------- navigation ---------------- */

  function go(page) {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-active', items[i].getAttribute('data-page') === page);
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('is-active', pages[j].id === 'page-' + page);
    }
    document.querySelector('.main').scrollTop = 0;
  }

  el('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('.nav-item');
    if (btn) go(btn.getAttribute('data-page'));
  });

  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-goto]');
    if (g) go(g.getAttribute('data-goto'));
  });

  el('contractTabs').addEventListener('click', function (event) {
    var button = event.target.closest('[data-contract-tab]');
    if (!button) return;
    var tab = button.getAttribute('data-contract-tab');
    document.querySelectorAll('[data-contract-tab]').forEach(function (item) { item.classList.toggle('is-active', item === button); });
    document.querySelectorAll('[data-contract-panel]').forEach(function (item) { item.classList.toggle('is-active', item.getAttribute('data-contract-panel') === tab); });
    if (tab === 'tokens') loadPortfolio();
  });

  /* ---------------- actions ---------------- */

  el('copyActive').addEventListener('click', function () {
    if (state && state.activeReceivingAddress) copy(state.activeReceivingAddress);
    else toast('还没有可用地址');
  });

  el('copyReceive').addEventListener('click', function () {
    var v = el('receiveAddr').textContent;
    if (v && v !== '——') copy(v);
  });

  el('receiveSelect').addEventListener('change', function () {
    showReceiveAddress(this.value);
  });

  el('newReceive').addEventListener('click', function () {
    var btn = this;
    var label = null;
    btn.disabled = true;
    ask({ title: '新增收款地址', sub: '可以填写用途备注，方便以后选择。留空会自动命名。', placeholder: '例如：日常收款' })
      .then(function (value) {
        if (value === null) throw new Error('已取消');
        label = value;
        if (state && state.locked) return ask({ title: '解锁钱包', sub: '生成新地址需要解锁钱包。', password: true, placeholder: '输入口令' });
        return true;
      }).then(function (password) {
        if (password === null) throw new Error('已取消');
        if (state && state.locked) return api('/api/unlock', { password: password });
      }).then(function () {
        return api('/api/new-address', { label: label });
      }).then(function (result) {
        toast('新收款地址已生成');
        banner('新地址 ' + short(result.address) + ' 尚未备份，请到「设置」导出新备份。', false);
        return loadState();
      }).catch(function (err) {
        if (err.message !== '已取消') toast(err.message);
      }).then(function () {
        btn.disabled = false;
      });
  });

  el('sendTo').addEventListener('input', function () {
    var v = this.value.trim();
    var ok = /^0x[0-9a-fA-F]{40}$/.test(v);
    text(el('sendNote'), !v ? '' : (ok ? '地址格式正确' : '地址需要是 0x 开头的 40 位十六进制'));
  });

  el('sendBtn').addEventListener('click', function () {
    var to = el('sendTo').value.trim();
    var amount = el('sendAmount').value.trim();
    var from = el('sendFrom').value;
    var out = el('sendResult');
    out.hidden = true;

    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      out.hidden = false; out.className = 'result is-error'; text(out, '收款地址格式不正确');
      return;
    }
    if (!/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
      out.hidden = false; out.className = 'result is-error'; text(out, '金额需要是大于 0 的数字');
      return;
    }

    var btn = this;
    btn.disabled = true;
    text(btn, '发送中…');

    var needUnlock = state && state.locked;
    var pwPromise = needUnlock
      ? ask({ title: '解锁钱包', sub: '发送交易需要本地钱包口令。', password: true, placeholder: '输入口令' })
      : Promise.resolve(true);

    pwPromise.then(function (pw) {
      if (pw === null) throw new Error('已取消');
      var chain = needUnlock ? api('/api/unlock', { password: pw }) : Promise.resolve();
      return chain.then(function () { return api('/api/transfer', { to: to, amount: amount, from: from }); });
    }).then(function (r) {
      out.hidden = false;
      out.className = 'result';
      text(out, '交易已提交，哈希：' + r.hash + (r.block ? '（区块 #' + r.block + '）' : ''));
      el('sendAmount').value = '';
      loadState();
    }).catch(function (err) {
      out.hidden = false;
      out.className = 'result is-error';
      text(out, err.message);
    }).then(function () {
      btn.disabled = false;
      text(btn, '确认发送');
    });
  });

  el('mineBtn').addEventListener('click', function () {
    var on = !(state && state.mining);
    var btn = this;
    btn.disabled = true;
    api('/api/mine', { enabled: on }).then(function () {
      toast(on ? '已开始挖矿' : '已停止挖矿');
      loadState();
    }).catch(function (err) {
      toast(err.message);
    }).then(function () {
      btn.disabled = false;
    });
  });

  el('tokenMode').addEventListener('change', function () {
    el('tokenCapField').hidden = this.value !== 'managed';
    tokenDraftId = null;
    el('tokenIssue').disabled = true;
  });

  ['tokenName', 'tokenSymbol', 'tokenSupply', 'tokenDecimals', 'tokenCap', 'tokenOwner'].forEach(function (id) {
    el(id).addEventListener('input', function () { tokenDraftId = null; el('tokenIssue').disabled = true; });
    el(id).addEventListener('change', function () { tokenDraftId = null; el('tokenIssue').disabled = true; });
  });

  el('tokenPrepare').addEventListener('click', function () {
    var button = this;
    var options = {
      name: el('tokenName').value.trim(), symbol: el('tokenSymbol').value.trim(), supply: el('tokenSupply').value.trim(),
      decimals: el('tokenDecimals').value.trim(), mode: el('tokenMode').value, cap: el('tokenCap').value.trim()
    };
    button.disabled = true;
    ensureUnlocked('发行代币前需要解锁钱包并估算部署 Gas。').then(function () {
      return api('/api/token/prepare', { options: options, from: el('tokenOwner').value });
    }).then(function (draft) {
      tokenDraftId = draft.draftId;
      el('tokenIssue').disabled = false;
      resultBox('tokenIssueResult', '预览完成：预计 Gas ' + draft.gas + '，预计手续费 ' + fmtNiu(draft.estimatedFeeNIU, 8) + ' NIU。请再次核对总量和权限后确认发行。', false);
    }).catch(function (error) {
      if (error.message !== '已取消') resultBox('tokenIssueResult', error.message, true);
    }).then(function () { button.disabled = false; });
  });

  el('tokenIssue').addEventListener('click', function () {
    if (!tokenDraftId) { resultBox('tokenIssueResult', '请先生成发行预览', true); return; }
    var button = this;
    button.disabled = true;
    api('/api/token/issue', { draftId: tokenDraftId }).then(function (result) {
      tokenDraftId = null;
      resultBox('tokenIssueResult', '代币发行成功。合约地址：' + result.address + '，交易哈希：' + result.hash, false);
      return loadState().then(loadPortfolio);
    }).catch(function (error) { resultBox('tokenIssueResult', error.message, true); })
      .then(function () { button.disabled = !tokenDraftId; });
  });

  el('tokenRefresh').addEventListener('click', function () {
    var button = this; button.disabled = true;
    loadPortfolio().then(function () { button.disabled = false; });
  });

  el('tokenImport').addEventListener('click', function () {
    var address = el('tokenImportAddress').value.trim(), button = this;
    button.disabled = true;
    api('/api/token/import', { address: address }).then(function (token) {
      toast('代币已导入');
      el('tokenImportAddress').value = '';
      return loadState().then(loadPortfolio).then(function () { resultBox('tokenSendResult', '已导入 ' + token.name + ' (' + token.symbol + ')', false); });
    }).catch(function (error) { resultBox('tokenSendResult', error.message, true); })
      .then(function () { button.disabled = false; });
  });

  el('tokenSend').addEventListener('click', function () {
    var button = this;
    button.disabled = true;
    ensureUnlocked('发送代币需要解锁钱包并签名。').then(function () {
      return api('/api/token/transfer', {
        address: el('tokenSendAsset').value, from: el('tokenSendFrom').value,
        to: el('tokenSendTo').value.trim(), amount: el('tokenSendAmount').value.trim()
      });
    }).then(function (result) {
      resultBox('tokenSendResult', '代币转账已确认，交易哈希：' + result.hash, false);
      el('tokenSendAmount').value = '';
      return loadState().then(loadPortfolio);
    }).catch(function (error) { if (error.message !== '已取消') resultBox('tokenSendResult', error.message, true); })
      .then(function () { button.disabled = false; });
  });

  el('solidityCompile').addEventListener('click', function () {
    var button = this; button.disabled = true;
    text(el('compilerOutput'), '正在编译 Solidity…');
    api('/api/solidity/compile', { source: el('soliditySource').value, fileName: el('solidityFile').value.trim() })
      .then(function (build) {
        compiledBuild = build;
        var select = el('compiledContract'); clear(select);
        build.artifacts.forEach(function (artifact) {
          var option = document.createElement('option'); option.value = artifact.name;
          text(option, artifact.name + ' · ' + artifact.bytecodeBytes + ' 字节'); select.appendChild(option);
        });
        select.dispatchEvent(new Event('change'));
        el('contractEstimate').disabled = false; el('contractDeployCompiled').disabled = false;
        var warnings = (build.warnings || []).map(function (item) { return item.message; }).join('\n');
        text(el('compilerOutput'), '编译成功 · solc ' + build.compilerVersion + ' · EVM ' + build.evmVersion + '\n源码哈希：' + build.sourceHash + (warnings ? '\n\n警告：\n' + warnings : ''));
      }).catch(function (error) {
        compiledBuild = null; el('contractEstimate').disabled = true; el('contractDeployCompiled').disabled = true;
        text(el('compilerOutput'), '编译失败：\n' + error.message);
      }).then(function () { button.disabled = false; });
  });

  el('compiledContract').addEventListener('change', function () {
    if (!compiledBuild) return;
    var artifact = compiledBuild.artifacts.find(function (item) { return item.name === el('compiledContract').value; });
    el('compiledAbi').value = artifact ? JSON.stringify(artifact.abi, null, 2) : '';
    var inputs = artifact && artifact.constructorInputs || [];
    el('constructorArgs').value = JSON.stringify(inputs.map(function (item) { return '<' + (item.name || 'arg') + ':' + item.type + '>'; }), null, 2);
  });

  function compiledPayload() {
    if (!compiledBuild) throw new Error('请先编译 Solidity 源码');
    return {
      buildId: compiledBuild.buildId, contractName: el('compiledContract').value,
      args: parseArray(el('constructorArgs').value, '构造参数'), from: el('contractDeployFrom').value,
      value: el('contractDeployValue').value.trim() || '0', label: el('contractLabel').value.trim()
    };
  }

  el('contractEstimate').addEventListener('click', function () {
    var button = this; button.disabled = true;
    try {
      var payload = compiledPayload();
      ensureUnlocked('估算部署 Gas 需要使用钱包账户。').then(function () { return api('/api/solidity/estimate', payload); })
        .then(function (result) { resultBox('contractDeployResult', '预计 Gas ' + result.gas + '，预计手续费 ' + fmtNiu(result.estimatedFeeNIU, 8) + ' NIU，部署字节码 ' + result.bytecodeBytes + ' 字节。', false); })
        .catch(function (error) { if (error.message !== '已取消') resultBox('contractDeployResult', error.message, true); })
        .then(function () { button.disabled = false; });
    } catch (error) { resultBox('contractDeployResult', error.message, true); button.disabled = false; }
  });

  el('contractDeployCompiled').addEventListener('click', function () {
    var button = this; button.disabled = true;
    try {
      var payload = compiledPayload();
      ensureUnlocked('部署合约需要解锁钱包并签名。').then(function () { return api('/api/solidity/deploy', payload); })
        .then(function (result) {
          resultBox('contractDeployResult', '合约部署成功：' + result.address + '，交易哈希：' + result.hash, false);
          return loadState();
        }).catch(function (error) { if (error.message !== '已取消') resultBox('contractDeployResult', error.message, true); })
        .then(function () { button.disabled = false; });
    } catch (error) { resultBox('contractDeployResult', error.message, true); button.disabled = false; }
  });

  el('contractImport').addEventListener('click', function () {
    var button = this; button.disabled = true;
    try {
      var abi = JSON.parse(el('contractImportAbi').value || '[]');
      api('/api/contract/import', { address: el('contractImportAddress').value.trim(), name: el('contractImportName').value.trim(), abi: abi })
        .then(function (result) { toast('合约已保存'); return loadState().then(function () { el('savedContract').value = result.id; el('savedContract').dispatchEvent(new Event('change')); }); })
        .catch(function (error) { text(el('contractCallOutput'), error.message); })
        .then(function () { button.disabled = false; });
    } catch (_) { text(el('contractCallOutput'), 'ABI必须是有效的JSON数组'); button.disabled = false; }
  });

  el('savedContract').addEventListener('change', function () {
    var id = this.value;
    if (!id) { showLoadedContract(null); return; }
    text(el('contractCallOutput'), '正在读取合约 ABI…');
    api('/api/contract/info', { id: id }).then(showLoadedContract)
      .catch(function (error) { showLoadedContract(null); text(el('contractCallOutput'), error.message); });
  });

  el('contractFunction').addEventListener('change', updateContractButtons);

  el('contractRead').addEventListener('click', function () {
    var button = this; button.disabled = true;
    try {
      var args = parseArray(el('contractCallArgs').value, '函数参数');
      api('/api/contract/read', { id: loadedContract.id, signature: el('contractFunction').value, args: args })
        .then(function (result) { text(el('contractCallOutput'), JSON.stringify(result.result, null, 2)); })
        .catch(function (error) { text(el('contractCallOutput'), error.message); })
        .then(function () { button.disabled = false; updateContractButtons(); });
    } catch (error) { text(el('contractCallOutput'), error.message); button.disabled = false; updateContractButtons(); }
  });

  el('contractWrite').addEventListener('click', function () {
    var button = this; button.disabled = true;
    try {
      var args = parseArray(el('contractCallArgs').value, '函数参数');
      ensureUnlocked('写入合约需要解锁钱包并签名。').then(function () {
        return api('/api/contract/write', { id: loadedContract.id, signature: el('contractFunction').value, args: args, from: el('contractCallFrom').value, value: el('contractCallValue').value.trim() || '0' });
      }).then(function (result) { text(el('contractCallOutput'), '合约调用已确认，交易哈希：' + result.hash); return loadState(); })
        .catch(function (error) { if (error.message !== '已取消') text(el('contractCallOutput'), error.message); })
        .then(function () { button.disabled = false; updateContractButtons(); });
    } catch (error) { text(el('contractCallOutput'), error.message); button.disabled = false; updateContractButtons(); }
  });

  el('contractDeploy').addEventListener('click', function () {
    var msg = el('contractMsg').value.trim();
    if (!msg) { toast('请先填写留言内容'); return; }
    var btn = this;
    btn.disabled = true;
    api('/api/deploy', { message: msg }).then(function (r) {
      text(el('contractNote'), '部署已提交：' + r.hash);
      loadState();
    }).catch(function (err) {
      text(el('contractNote'), err.message);
    }).then(function () { btn.disabled = false; });
  });

  el('contractUpdate').addEventListener('click', function () {
    var msg = el('contractMsg').value.trim();
    if (!msg) { toast('请先填写留言内容'); return; }
    var btn = this;
    btn.disabled = true;
    api('/api/message', { message: msg }).then(function (r) {
      text(el('contractNote'), '留言更新已提交：' + r.hash);
      loadState();
    }).catch(function (err) {
      text(el('contractNote'), err.message);
    }).then(function () { btn.disabled = false; });
  });

  el('lockBtn').addEventListener('click', function () {
    api('/api/lock', {}).then(function () { toast('钱包已锁定'); loadState(); })
      .catch(function (err) { toast(err.message); });
  });

  el('unlockBtn').addEventListener('click', function () {
    ask({ title: '解锁钱包', sub: '输入本地钱包口令。', password: true, placeholder: '输入口令' })
      .then(function (pw) {
        if (pw === null) return;
        return api('/api/unlock', { password: pw }).then(function () { toast('已解锁'); loadState(); });
      }).catch(function (err) { toast(err.message); });
  });

  el('backupBtn').addEventListener('click', function () {
    ask({ title: '导出加密备份', sub: '备份文件用口令加密，可跨电脑恢复。请牢记口令，丢失无法找回。', password: true, placeholder: '设置备份口令（至少 12 位）' })
      .then(function (pw) {
        if (pw === null) return;
        if (!pw || pw.length < 12) { toast('口令至少 12 位'); return; }
        return api('/api/backup-portable', { password: pw }).then(function (r) {
          toast('备份已生成');
          banner('备份文件位置：' + r.path + ' ｜ ' + r.scope, false);
        });
      }).catch(function (err) { toast(err.message); });
  });

  el('importBtn').addEventListener('click', function () {
    el('importFile').click();
  });

  el('importFile').addEventListener('change', function () {
    var input = this;
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 131072) { toast('备份文件过大，无法导入'); return; }
    file.text().then(function (content) {
      if (!content.trim()) throw new Error('备份文件为空');
      var unlock = state && state.locked
        ? ask({ title: '先解锁当前钱包', sub: '这不是备份密码。恢复测试版首次使用时，请自行填写一个至少 12 位的本地解锁口令；下一步才会要求旧备份密码。', password: true, placeholder: '本地解锁口令（至少 12 位）' })
          .then(function (pw) {
            if (pw === null) throw new Error('已取消');
            return api('/api/unlock', { password: pw });
          })
        : Promise.resolve();
      return unlock.then(function () {
        if (content.trim().charAt(0) !== '{') return null;
        return ask({ title: '输入备份文件密码', sub: '这是导出这份跨电脑备份时设置的密码，不是当前钱包口令。', password: true, placeholder: '备份文件密码（至少 12 位）' });
      }).then(function (backupPassword) {
        if (content.trim().charAt(0) === '{' && backupPassword === null) throw new Error('已取消');
        if (content.trim().charAt(0) === '{' && (!backupPassword || backupPassword.length < 12)) throw new Error('备份文件密码至少 12 位');
        return api('/api/import-wallet-data', { content: content, password: backupPassword });
      }).then(function (r) {
        if (r.added) {
          toast('已导入 ' + r.added + ' 个地址');
          banner('导入成功：新增 ' + r.added + ' 个地址，钱包当前共 ' + r.total + ' 个地址。请重新导出一份包含全部地址的新备份。', false);
        } else {
          toast('备份中的地址已存在');
          banner('备份校验成功，但其中的地址已经全部存在于当前钱包，无需重复导入。', false);
        }
        loadState();
      });
    }).catch(function (err) {
      if (err.message !== '已取消') toast(err.message);
    });
  });

  el('languageSelect').addEventListener('change', function () {
    var select = this;
    select.disabled = true;
    setLanguage(select.value, true).then(function () {
      toast('界面语言已更新');
    }).catch(function (err) {
      toast(err.message || '语言设置保存失败，请检查当前用户的应用数据目录权限。');
      select.value = currentLanguage;
    }).then(function () {
      select.disabled = false;
    });
  });

  /* ---------------- boot ---------------- */

  if (DEMO) {
    seedDemo();
    demoState = null;
    banner('演示模式：界面使用本地模拟数据，未连接真实节点。加上 ?demo=0 可尝试连接本机钱包服务。', false);
    if (new URLSearchParams(location.search).get('demo') === '0') {
      DEMO = false;
      banner('');
    }
  }

  el('soliditySource').value = DEFAULT_SOLIDITY;
  rememberStaticTranslations();
  setLanguage(preferredLanguage(), false).catch(function () {
    currentLanguage = 'zh-CN';
    languageCatalog = Object.create(null);
    applyLanguage();
  }).then(function () {
    loadState();
  });
  var startPage = new URLSearchParams(location.search).get('page');
  if (startPage) go(startPage);
  setInterval(function () {
    tickDemo();
    loadState();
  }, POLL_MS);

  window.__niu = { go: go, reload: loadState };
  window.__niuBanner = function (msg, isError) { banner(msg, isError); };
})();
