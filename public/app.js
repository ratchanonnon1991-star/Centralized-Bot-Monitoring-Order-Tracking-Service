// Oxide Bot Monitor dashboard - plain JS, talks to the REST API and listens on /ws/dashboard.
(() => {
  'use strict';

  const TOKEN_KEY = 'oxide.adminToken';
  const $ = (id) => document.getElementById(id);
  const state = { bots: [], overview: null, deployments: [], openBotId: null, ws: null, wsRetry: 0 };

  const STATE_BADGE = {
    OFFLINE: ['b-gray', 'Offline'],
    DISABLED: ['b-red', 'ปิดบอท'],
    PAUSED: ['b-violet', 'Kill-switch'],
    STANDBY: ['b-amber', 'Standby'],
    IN_PROGRESS: ['b-blue', 'In Progress'],
  };
  const STATE_TEXT = {
    OFFLINE: 'เครื่องไม่ได้รัน process',
    DISABLED: 'ปิดรับงาน',
    PAUSED: 'หยุดรับงาน (kill-switch)',
    STANDBY: 'รับรออยู่ (standby)',
    IN_PROGRESS: 'กำลังทำงาน',
  };
  const ORDER_BADGE = {
    PENDING_PAYMENT: 'b-gray', QUEUED: 'b-amber', IN_PROGRESS: 'b-blue', DELAYED: 'b-violet',
    COMPLETED: 'b-green', FAILED: 'b-red', CANCELLED: 'b-gray',
  };

  // ------------------------------------------------------------------ helpers
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (d) => (d ? new Date(d).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
  const fmtShort = (d) => (d ? new Date(d).toLocaleTimeString('th-TH') : '—');
  function ago(d) {
    if (!d) return '—';
    const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return `${s} วิ.ที่แล้ว`;
    if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
    return fmtTime(d);
  }
  const fmtBytes = (n) =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
  const fmtUptime = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  const badge = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast${isError ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 3500);
  }

  // ------------------------------------------------------------------ API
  const token = () => localStorage.getItem(TOKEN_KEY) || '';

  async function api(path, { method = 'GET', body, idempotent = false, form } = {}) {
    const headers = { Authorization: `Bearer ${token()}`, 'X-Actor': 'dashboard' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotent) headers['Idempotency-Key'] = newKey();
    const res = await fetch(path, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    if (res.status === 401) {
      askToken();
      throw new Error('ต้องใส่ Admin Token');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message ? [].concat(data.message).join(', ') : data?.error || `HTTP ${res.status}`);
    return data;
  }

  /** Disables the button while the request runs, so a double click cannot fire twice. */
  async function act(button, fn, okMessage) {
    if (button) button.disabled = true;
    try {
      const r = await fn();
      if (okMessage) toast(typeof okMessage === 'function' ? okMessage(r) : okMessage);
      return r;
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function askToken() {
    const dlg = $('login');
    if (!dlg.open) dlg.showModal();
  }

  // ------------------------------------------------------------------ loaders
  async function loadOverview() {
    const o = await api('/api/overview');
    state.overview = o;
    const ks = o.killSwitch;
    $('ks-state').innerHTML = ks.engaged
      ? `<span style="color:var(--red)">ทั้งระบบ: ปิด</span>`
      : `<span style="color:var(--green)">ทั้งระบบ: เปิด</span>`;
    $('ks-note').textContent = ks.engaged
      ? `ปิดโดย ${ks.updatedBy} เมื่อ ${fmtTime(ks.updatedAt)}${ks.reason ? ` · ${ks.reason}` : ''} — ทุกเครื่องไม่รับออเดอร์ใหม่`
      : 'ทุกเครื่องรับออเดอร์ตามปกติ — กด "ปิดทั้งระบบ" เพื่อหยุดรับออเดอร์ใหม่ทุกเครื่อง (งานที่กำลังทำจะทำต่อจนจบ)';
    $('btn-ks-on').disabled = !ks.engaged;
    $('btn-ks-off').disabled = ks.engaged;

    $('s-online').textContent = o.bots.online;
    $('s-active').textContent = o.bots.active;
    $('s-standby').textContent = o.bots.standby;
    $('s-progress').textContent = o.bots.inProgress;

    $('order-counts').innerHTML = Object.entries(o.orders)
      .map(([s, n]) => badge(ORDER_BADGE[s], `${s} ${n}`))
      .join('');
  }

  async function loadBots() {
    state.bots = await api('/api/bots');
    renderBots();
    if (state.openBotId) openBot(state.openBotId, true);
  }

  async function loadDeployments() {
    state.deployments = await api('/api/deployments');
    const [latest, ...older] = state.deployments;
    $('btn-update-all').disabled = !latest;
    if (!latest) {
      $('dep-title').textContent = 'ยังไม่มีแพ็กเกจ';
      $('dep-meta').textContent = 'อัปโหลดไฟล์ .zip เพื่อสร้างแพ็กเกจใหม่';
      $('dep-list').innerHTML = '';
      return;
    }
    $('dep-title').textContent = `แพ็กล่าสุด: ${latest.version} · ${fmtBytes(latest.sizeBytes)}`;
    $('dep-meta').textContent = `ชื่อไฟล์: ${latest.fileName} · สร้างเมื่อ ${fmtTime(latest.createdAt)} · โดย ${latest.uploadedBy} · กดอัปเดตเครื่อง = ใช้แพ็กนี้`;
    $('dep-list').innerHTML = [latest, ...older.slice(0, 3)]
      .map(
        (d, i) => `<div class="dep-item ${i === 0 ? 'latest' : ''}">
          <div><div class="mono">${esc(d.version)}.zip</div>
          <div class="muted">${fmtTime(d.createdAt)} · ${fmtBytes(d.sizeBytes)} · sha256 ${esc(d.sha256.slice(0, 12))}…${i === 0 ? ' — ตัวที่ใช้อัปเดตตอนนี้' : ''}</div></div>
        </div>`,
      )
      .join('');
  }

  async function loadOrders() {
    const status = $('order-filter').value;
    const { items } = await api(`/api/orders?limit=50${status ? `&status=${status}` : ''}`);
    $('orders').innerHTML =
      items
        .map((o) => {
          const actions = [];
          if (o.status === 'PENDING_PAYMENT') actions.push(`<button class="btn small success" data-pay="${o.id}">ยืนยันชำระ</button>`);
          // the server refuses to cancel an order a bot has already worked on (it may have been delivered)
          if ((o.status === 'PENDING_PAYMENT' || o.status === 'QUEUED') && o.attemptCount === 0) actions.push(`<button class="btn small danger" data-cancel="${o.id}">ยกเลิก</button>`);
          if (o.status === 'FAILED') actions.push(`<button class="btn small" data-retry="${o.id}">ลองใหม่</button>`);
          actions.push(`<button class="btn small ghost" data-timeline="${o.id}">Timeline</button>`);
          return `<tr>
            <td class="mono">${o.id}</td>
            <td class="mono">${esc(o.externalOrderId)}</td>
            <td>${esc(o.product ?? '—')}</td>
            <td class="mono">${o.amount.toLocaleString('th-TH')} ${esc(o.currency)}</td>
            <td>${badge(ORDER_BADGE[o.status], o.status)}${o.lastError && o.status !== 'COMPLETED' ? `<span class="err" title="${esc(o.lastError)}">${esc(o.lastError)}</span>` : ''}</td>
            <td class="mono">${esc(o.assignedBotId ?? '—')}</td>
            <td class="mono">${o.attemptCount}/${o.maxAttempts}</td>
            <td>${fmtShort(o.updatedAt)}</td>
            <td><div class="actions">${actions.join('')}</div></td>
          </tr>`;
        })
        .join('') || `<tr><td colspan="9" class="muted">ไม่มีออเดอร์</td></tr>`;
  }

  async function loadAudit() {
    const rows = await api('/api/audit-logs?limit=30');
    $('audit').innerHTML = rows
      .map((a) => `<li><span class="t">${fmtTime(a.createdAt)}</span><span><b>${esc(a.actor)}</b> ${esc(a.action)} ${esc(a.targetType)}:${esc(a.targetId ?? '')}</span></li>`)
      .join('') || '<li class="muted">ยังไม่มีรายการ</li>';
  }

  const refreshAll = () =>
    Promise.all([loadOverview(), loadBots(), loadDeployments(), loadOrders(), loadAudit()]).catch((e) => toast(e.message, true));

  // ------------------------------------------------------------------ bots
  function renderBots() {
    $('bots').innerHTML = state.bots.map(botCard).join('');
  }

  function botCard(b) {
    const [cls, label] = STATE_BADGE[b.state];
    const online = b.status === 'online';
    let box;
    if (b.currentOrder) {
      box = `<div class="result working"><div class="row-between"><span class="muted">กำลังทำ</span>${badge(b.currentOrder.status === 'DELAYED' ? 'b-violet' : 'b-blue', b.currentOrder.status)}</div>
        <div class="text">${esc(b.currentOrder.externalOrderId)}${b.currentOrder.product ? ` · ${esc(b.currentOrder.product)}` : ''} · ครั้งที่ ${b.currentOrder.attempt}</div></div>`;
    } else if (b.lastResult) {
      box = `<div class="result ${b.lastResult.result}"><div class="row-between"><span class="muted">สถานะล่าสุด</span>${badge(b.lastResult.result === 'done' ? 'b-green' : 'b-red', b.lastResult.result)}</div>
        <div class="text">${esc(b.lastResult.summary)}</div></div>`;
    } else {
      box = `<div class="result"><span class="muted">ยังไม่มีงาน</span></div>`;
    }
    const latest = state.deployments[0];
    return `<article class="card bot state-${b.state}" data-bot="${esc(b.id)}">
      <div class="bot-head">
        <div class="avatar">${esc(b.name.trim()[0] || 'B')}</div>
        <div class="grow"><div class="bot-name">${esc(b.name)}</div><div class="bot-sub">${esc(b.deviceName)}</div></div>
        <div class="badges">${badge(online ? 'b-green' : 'b-gray', online ? 'Online' : 'Offline')}${badge(cls, label)}</div>
      </div>
      <div>${badge(cls, STATE_TEXT[b.state])}</div>
      <div class="kv">
        <div><div class="k">Host</div><div class="v" title="${esc(b.hostName ?? '')}">${esc(b.hostName ?? '—')}</div></div>
        <div><div class="k">Heartbeat</div><div class="v" data-ago="${esc(b.lastHeartbeat ?? '')}">${ago(b.lastHeartbeat)}</div></div>
      </div>
      ${box}
      <div class="two">
        <button class="btn success" data-cmd="start" data-id="${esc(b.id)}" ${b.enabled ? 'disabled' : ''}>เปิดบอท</button>
        <button class="btn danger" data-cmd="stop" data-id="${esc(b.id)}" ${!b.enabled ? 'disabled' : ''}>ปิดบอท</button>
      </div>
      <button class="btn block" data-detail="${esc(b.id)}">รายละเอียด</button>
      <button class="btn block" data-update="${esc(b.id)}" ${!latest || b.codeVersion === latest.version ? 'disabled' : ''}
        title="${b.codeVersion ? `เวอร์ชันปัจจุบัน ${esc(b.codeVersion)}` : 'ยังไม่เคยอัปเดต'}">${latest && b.codeVersion === latest.version ? 'โค้ดล่าสุดแล้ว' : 'อัปเดตโค้ด'}</button>
    </article>`;
  }

  async function openBot(id, refreshOnly = false) {
    const dlg = $('modal');
    if (refreshOnly && (!dlg.open || state.openBotId !== id)) return;
    state.openBotId = id;
    const [b, logs, cmds] = await Promise.all([
      api(`/api/bots/${encodeURIComponent(id)}`),
      api(`/api/bots/${encodeURIComponent(id)}/logs?limit=40`),
      api(`/api/bots/${encodeURIComponent(id)}/commands?limit=10`),
    ]);
    $('modal-title').textContent = `${b.name} · ${b.id}`;
    const m = b.metrics;
    const bar = (v) => `<div class="bar"><i style="width:${Math.min(100, v)}%"></i></div>`;
    $('modal-body').innerHTML = `
      <div class="actions">${badge(...STATE_BADGE[b.state])} ${badge(b.connected ? 'b-green' : 'b-gray', b.connected ? 'WebSocket connected' : 'not connected')}
        <span class="muted">version: <span class="mono">${esc(b.codeVersion ?? '—')}</span></span></div>
      <h4>Metrics</h4>
      <div class="metrics">
        <div class="card"><div class="label">CPU</div><div class="big mono">${m.cpuPercent}%</div>${bar(m.cpuPercent)}</div>
        <div class="card"><div class="label">Memory</div><div class="big mono">${m.memoryPercent}%</div>${bar(m.memoryPercent)}</div>
        <div class="card"><div class="label">Uptime</div><div class="big mono" style="font-size:14px">${fmtUptime(m.uptimeSeconds)}</div></div>
        <div class="card"><div class="label">24 ชม. done / failed</div><div class="big mono"><span style="color:var(--green)">${b.stats24h.done}</span> / <span style="color:var(--red)">${b.stats24h.failed}</span></div></div>
      </div>
      <h4>สั่งการ</h4>
      <div class="actions">
        <button class="btn" data-cmd="status" data-id="${esc(b.id)}">ขอสถานะ</button>
        <button class="btn" data-cmd="restart" data-id="${esc(b.id)}">Restart</button>
        <span class="muted">Heartbeat ล่าสุด ${fmtTime(b.lastHeartbeat)}</span>
      </div>
      <h4>คำสั่งล่าสุด</h4>
      <ul class="log-list">${cmds.map((c) => `<li><span class="t">${fmtShort(c.createdAt)}</span><span>#${c.id} <b>${esc(c.command)}</b> ${badge(c.status === 'success' ? 'b-green' : c.status === 'failed' ? 'b-red' : 'b-amber', c.status)} <span class="muted">${esc(c.transport ?? '')} ${c.result ? esc(JSON.stringify(c.result)).slice(0, 140) : ''}</span></span></li>`).join('') || '<li class="muted">—</li>'}</ul>
      <h4>Log</h4>
      <ul class="log-list">${logs.map((l) => `<li><span class="t">${fmtShort(l.createdAt)}</span><span class="lv-${esc(l.level)}">${esc(l.message)}</span></li>`).join('') || '<li class="muted">—</li>'}</ul>`;
    if (!dlg.open) dlg.showModal();
  }

  async function openTimeline(id) {
    state.openBotId = null;
    const [o, events] = await Promise.all([api(`/api/orders/${id}`), api(`/api/orders/${id}/timeline`)]);
    $('modal-title').textContent = `Order #${o.id} · ${o.externalOrderId}`;
    $('modal-body').innerHTML = `
      <div class="actions">${badge(ORDER_BADGE[o.status], o.status)} <span class="muted">ครั้งที่ ${o.attemptCount}/${o.maxAttempts} · ${o.amount} ${esc(o.currency)}</span></div>
      <h4>Timeline</h4>
      <ul class="timeline">${events
        .map((e) => {
          const p = e.payload || {};
          const head = e.type === 'CREATED' ? 'สร้างออเดอร์' : `${esc(p.from)} → <b>${esc(p.to)}</b>`;
          const bits = [p.reason, p.botId && `bot ${p.botId}`, p.attempt && `attempt ${p.attempt}`, p.retryInMs && `retry in ${p.retryInMs / 1000}s`, p.error, `by ${p.actor}`]
            .filter(Boolean)
            .map(esc)
            .join(' · ');
          return `<li><span class="mono muted">${fmtShort(e.createdAt)}</span><span>${head}<div class="muted">${bits}</div></span></li>`;
        })
        .join('')}</ul>
      ${o.result ? `<h4>ผลลัพธ์</h4><pre class="mono muted">${esc(JSON.stringify(o.result, null, 2))}</pre>` : ''}`;
    if (!$('modal').open) $('modal').showModal();
  }

  // ------------------------------------------------------------------ actions
  async function sendCommand(button, id, command) {
    const labels = { start: 'เปิดบอท', stop: 'ปิดบอท', restart: 'Restart', status: 'ขอสถานะ' };
    await act(button, () => api(`/api/bots/${encodeURIComponent(id)}/commands`, { method: 'POST', body: { command }, idempotent: true }),
      (c) => `${labels[command]} ${id}: ${c.status}${c.transport ? ` (${c.transport})` : ''}`);
  }

  async function rollout(button, botIds) {
    const latest = state.deployments[0];
    if (!latest) return;
    const who = botIds ? botIds.join(', ') : 'ทุกเครื่อง';
    if (!confirm(`อัปเดต ${who} เป็น ${latest.version}?`)) return;
    await act(button, () => api(`/api/deployments/${latest.id}/rollout`, { method: 'POST', body: botIds ? { botIds } : {}, idempotent: true }),
      (r) => r.targets.map((t) => `${t.botId}: ${t.outcome}`).join(' · '));
  }

  async function createTestOrders(button, count, pay) {
    const products = ['UC 60', 'Diamonds 86', 'Genesis Crystal 300', 'Robux 400', 'Valorant Points 475'];
    await act(button, async () => {
      for (let i = 0; i < count; i++) {
        const o = await api('/api/orders', {
          method: 'POST',
          idempotent: true,
          body: {
            externalOrderId: `WEB-${Date.now().toString(36).toUpperCase()}-${i}`,
            amount: [35, 99, 179, 349, 599][i % 5],
            product: products[Math.floor(Math.random() * products.length)],
          },
        });
        if (pay) await api(`/api/orders/${o.id}/payment-confirmed`, { method: 'POST', idempotent: true });
      }
    }, `สร้าง ${count} ออเดอร์แล้ว`);
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, article.bot');
    if (!t) return;
    const d = t.dataset;
    if (d.cmd) return sendCommand(t, d.id, d.cmd);
    if (d.update) return rollout(t, [d.update]);
    if (d.detail) return openBot(d.detail).catch((err) => toast(err.message, true));
    if (d.pay) return act(t, () => api(`/api/orders/${d.pay}/payment-confirmed`, { method: 'POST', idempotent: true }), 'ยืนยันการชำระแล้ว');
    if (d.cancel) return act(t, () => api(`/api/orders/${d.cancel}/cancel`, { method: 'POST', body: {}, idempotent: true }), 'ยกเลิกแล้ว');
    if (d.retry) return act(t, () => api(`/api/orders/${d.retry}/retry`, { method: 'POST', idempotent: true }), 'ส่งกลับเข้าคิวแล้ว');
    if (d.timeline) return openTimeline(d.timeline).catch((err) => toast(err.message, true));
    if (t.matches('article.bot')) return openBot(d.bot).catch((err) => toast(err.message, true));
  });

  $('btn-ks-off').onclick = (e) => {
    const reason = prompt('เหตุผลที่ปิดทั้งระบบ (ไม่บังคับ)', 'maintenance');
    if (reason === null) return;
    act(e.currentTarget, () => api('/api/system/kill-switch', { method: 'PUT', body: { engaged: true, reason: reason || undefined } }), 'ปิดทั้งระบบแล้ว');
  };
  $('btn-ks-on').onclick = (e) => act(e.currentTarget, () => api('/api/system/kill-switch', { method: 'PUT', body: { engaged: false } }), 'เปิดทั้งระบบแล้ว');
  $('btn-update-all').onclick = (e) => rollout(e.currentTarget, null);
  $('btn-refresh').onclick = refreshAll;
  $('btn-token').onclick = askToken;
  $('btn-new-order').onclick = (e) => createTestOrders(e.currentTarget, 1, false);
  $('btn-new-5').onclick = (e) => createTestOrders(e.currentTarget, 5, true);
  $('order-filter').onchange = () => loadOrders().catch((err) => toast(err.message, true));
  $('modal-close').onclick = () => $('modal').close();
  $('modal').addEventListener('close', () => (state.openBotId = null));
  $('dep-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    await act(null, () => api('/api/deployments', { method: 'POST', form }), (d) => (d.created ? `อัปโหลด ${d.version} แล้ว` : `แพ็กเกจนี้มีอยู่แล้ว (${d.version})`));
  };
  $('login-form').onsubmit = () => {
    localStorage.setItem(TOKEN_KEY, $('login-token').value.trim());
    connectWs();
    refreshAll();
  };

  // ------------------------------------------------------------------ realtime
  function setLive(ok, text) {
    $('live').className = `pill ${ok ? 'ok' : 'bad'}`;
    $('live-text').textContent = text;
  }

  function connectWs() {
    if (!token()) return askToken();
    state.ws?.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token())}`);
    state.ws = ws;
    ws.onopen = () => {
      state.wsRetry = 0;
      setLive(true, 'อัปเดตสด');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.event !== 'changed') return;
      const s = new Set(msg.data.scopes);
      const jobs = [loadOverview()];
      if (s.has('bots') || s.has('system') || s.has('orders') || s.has('commands')) jobs.push(loadBots());
      if (s.has('orders')) jobs.push(loadOrders());
      if (s.has('deployments')) jobs.push(loadDeployments());
      if (s.has('system') || s.has('deployments') || s.has('bots')) jobs.push(loadAudit());
      Promise.all(jobs).catch((e) => toast(e.message, true));
    };
    ws.onclose = (ev) => {
      if (state.ws !== ws) return;
      setLive(false, 'ขาดการเชื่อมต่อ');
      if (ev.code === 4401) return askToken();
      setTimeout(connectWs, Math.min(10000, 500 * 2 ** state.wsRetry++));
    };
  }

  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString('th-TH');
    document.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = ago(el.dataset.ago || null)));
  }, 1000);
  setInterval(refreshAll, 30000); // safety net if a push was missed

  // Allow http://host/#token=... for a one-click demo link; the token is stored and removed from the URL.
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (hashToken) {
    localStorage.setItem(TOKEN_KEY, hashToken);
    history.replaceState(null, '', location.pathname);
  }

  connectWs();
  if (token()) refreshAll();
})();
