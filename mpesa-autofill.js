// ==UserScript==
// @name         Auto MPESA – IMOS One-Time Payment Helper (React Update)
// @namespace    benf.auto.mpesa
// @version      2.1.0
// @description  Upload a CSV and auto-fill IMOS account distribution lines. Auto-selects Cost, Line Item, and Fee.
// @match        *://imos.churchofjesuschrist.org/payment-creation/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*****************
   * Small helpers *
   *****************/
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  function notify(msg, type = 'info', t = 3500) {
    let box = document.getElementById('auto-mpesa-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'auto-mpesa-toast';
      Object.assign(box.style, {
        position: 'fixed', right: '16px', bottom: '16px', padding: '10px 14px',
        background: '#111', color: '#fff', borderRadius: '10px', zIndex: 999999,
        fontSize: '13px', boxShadow: '0 6px 20px rgba(0,0,0,0.25)', maxWidth: '60vw'
      });
      document.body.appendChild(box);
    }
    box.style.background = (type === 'error') ? '#b00020' : (type === 'success' ? '#196e3d' : '#111');
    box.textContent = msg;
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.remove(); }, t);
  }

  // Set input.value the "React-safe" way and emit events
  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // Set select.value the "React-safe" way
  function setSelectValue(select, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Normalize header keys (removes spaces, punctuation, makes lowercase)
  // e.g. "LINE ITEM" -> "lineitem"
  function normKey(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  // Safe MZN parser
  function toTwoDecimalAmount(raw) {
    if (raw == null) return '';
    let s = String(raw).trim();
    s = s.replace(/[^\d,.\-]/g, '');

    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    } else if (s.includes(',') && !s.includes('.')) {
      s = s.replace(',', '.');
    }

    const num = parseFloat(s);
    if (Number.isNaN(num)) return '';
    return num.toFixed(2);
  }

  // Lightweight CSV parser
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let i = 0, cur = '', cell = '', inQuotes = false;

    function pushCell() { cur += cell; cell = ''; }
    function pushField(r) { r.push(cur); cur = ''; }
    function pushRow(r) { rows.push(r); }

    let r = [];
    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          else { inQuotes = false; i++; continue; }
        } else { cell += ch; i++; continue; }
      } else {
        if (ch === '"') { inQuotes = true; i++; continue; }
        if (ch === ',') { pushCell(); pushField(r); i++; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') { pushCell(); pushField(r); pushRow(r); r = []; i++; continue; }
        cell += ch; i++;
      }
    }
    pushCell(); pushField(r);
    if (r.length > 1 || (r.length === 1 && r[0] !== '')) pushRow(r);

    if (!rows.length) return { headers: [], data: [] };
    const headers = rows[0];
    const data = rows.slice(1).filter(row => row.some(v => String(v).trim() !== ''));
    return { headers, data };
  }

  /********************
   * DOM Interactions *
   ********************/
  function getLineRows() {
    return Array.from(document.querySelectorAll('table.eden-table-table tbody tr'));
  }

  async function addRowsUntil(targetCount) {
    let current = getLineRows().length;
    if (current >= targetCount) {
      console.log('[Auto MPESA] Already have', current, 'rows; target', targetCount);
      return;
    }

    let remaining = targetCount - current;
    console.log('[Auto MPESA] Need to add', remaining, 'rows');

    while (remaining > 0) {
      const chunk = Math.min(20, remaining);

      const tfoot = document.querySelector('table.eden-table-table tfoot');
      if (!tfoot) throw new Error("Could not find table footer to add rows. Is the page fully loaded?");

      const numSelect = tfoot.querySelector('select');
      const buttons = Array.from(tfoot.querySelectorAll('button'));
      const addBtn = buttons.find(b => b.textContent.trim() === 'Add');

      if (!addBtn) throw new Error("Could not find 'Add' button in the table footer.");

      if (numSelect) {
        setSelectValue(numSelect, String(chunk));
        await sleep(100);
      }

      addBtn.click();
      console.log('[Auto MPESA] Clicked Add for', chunk);

      const targetAfter = current + chunk;
      const t0 = Date.now();

      while (getLineRows().length < targetAfter && (Date.now() - t0) < 10000) {
        await sleep(200);
      }

      current = getLineRows().length;
      remaining = targetCount - current;
      console.log('[Auto MPESA] Row count now', current, '; remaining', remaining);
      await sleep(150);
    }
  }

  function ensureButton() {
    if (document.getElementById('auto-mpesa-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'auto-mpesa-btn';
    btn.textContent = 'Auto MPESA';
    Object.assign(btn.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: 999999,
      background: '#0a84ff', color: '#fff', border: 'none', borderRadius: '12px',
      padding: '10px 14px', fontSize: '14px', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
      cursor: 'pointer'
    });
    btn.addEventListener('mouseenter', () => btn.style.filter = 'brightness(1.05)');
    btn.addEventListener('mouseleave', () => btn.style.filter = '');
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  function openModal() {
    if (document.getElementById('auto-mpesa-modal')) {
      document.getElementById('auto-mpesa-modal').remove();
    }
    const overlay = document.createElement('div');
    overlay.id = 'auto-mpesa-modal';
    Object.assign(overlay.style, {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999999
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
      background: '#fff', padding: '20px', borderRadius: '14px', width: 'min(520px, 92vw)',
      boxShadow: '0 10px 40px rgba(0,0,0,.25)', fontFamily: 'system-ui, Roboto, Segoe UI, Arial'
    });

    const h = document.createElement('div');
    h.textContent = 'Auto MPESA — Upload CSV';
    Object.assign(h.style, { fontSize: '18px', fontWeight: 700, marginBottom: '10px' });

    const p = document.createElement('div');
    p.innerHTML = 'Select a CSV with headers including <code>COST</code> and <code>LINE ITEM</code>.';
    Object.assign(p.style, { fontSize: '13px', marginBottom: '14px' });

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.style.marginBottom = '12px';

    const hint = document.createElement('div');
    hint.textContent = 'We will add N + 1 rows and fill the first N rows.';
    Object.assign(hint.style, { fontSize: '12px', color: '#444', marginBottom: '12px' });

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { background: '#e5e7eb', color: '#111', border: 'none', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontSize: '14px' });
    cancel.addEventListener('click', () => overlay.remove());

    const go = document.createElement('button');
    go.textContent = 'Process CSV';
    Object.assign(go.style, { background: '#0a84ff', color: '#fff', border: 'none', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontSize: '14px' });
    go.addEventListener('click', async () => {
      if (!input.files || !input.files[0]) { notify('Please choose a CSV file.', 'error'); return; }
      overlay.remove();
      const file = input.files[0];
      const text = await file.text();
      await processCSVText(text);
    });

    row.append(cancel, go);
    panel.append(h, p, input, hint, row);
    overlay.append(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /********************
   * Core CSV -> Form *
   ********************/
  async function processCSVText(text) {
    try {
      const { headers, data } = parseCSV(text);
      if (!headers.length) {
        notify('CSV appears empty or unparseable.', 'error');
        return;
      }

      function showColumnSelector(headers) {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          Object.assign(overlay.style, { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999999 });

          const panel = document.createElement('div');
          Object.assign(panel.style, {
            position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
            background: '#fff', padding: '20px', borderRadius: '14px', width: 'min(420px, 92vw)',
            boxShadow: '0 10px 40px rgba(0,0,0,.25)', fontFamily: 'system-ui, Roboto, Segoe UI, Arial'
          });

          const title = document.createElement('div');
          title.textContent = 'Confirm CSV Columns';
          Object.assign(title.style, { fontSize: '18px', fontWeight: 700, marginBottom: '14px' });

          // Modified makeSelect to accept an array of preferred matches
          function makeSelect(labelText, preferredMatches) {
            const label = document.createElement('label');
            label.textContent = labelText;
            Object.assign(label.style, { display: 'block', marginBottom: '6px', fontSize: '13px' });

            const select = document.createElement('select');
            let bestMatch = null;

            headers.forEach(h => {
              const opt = document.createElement('option');
              opt.value = h;
              opt.textContent = h;
              select.appendChild(opt);

              // Auto-select if the header normalizes to one of our target strings
              if (!bestMatch && preferredMatches.includes(normKey(h))) {
                bestMatch = h;
              }
            });

            // If a match was found, set the dropdown to that value
            if (bestMatch) {
              select.value = bestMatch;
            }

            Object.assign(select.style, { width: '100%', marginBottom: '12px', padding: '4px' });

            label.appendChild(select);
            panel.appendChild(label);
            return select;
          }

          // Define what we are looking for (all lowercase, no spaces)
          const lineItemSel = makeSelect('Line Item column:', ['lineitem', 'memo', 'descricao', 'item', 'details']);
          const costSel     = makeSelect('Cost column:', ['cost', 'mznvalor', 'amount', 'mzn', 'valor']);
          const feeSel      = makeSelect('Fee column (for TAX total):', ['fee', 'taxa']);

          const btn = document.createElement('button');
          btn.textContent = 'Continue';
          Object.assign(btn.style, {
            background: '#0a84ff', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', marginTop: '10px', width: '100%'
          });
          btn.addEventListener('click', () => {
            const cols = { lineItem: lineItemSel.value, cost: costSel.value, fee: feeSel.value };
            overlay.remove();
            resolve(cols);
          });

          panel.appendChild(title);
          panel.appendChild(btn);
          overlay.appendChild(panel);
          document.body.appendChild(overlay);
        });
      }

      const selectedCols = await showColumnSelector(headers);
      const lineIdx = headers.indexOf(selectedCols.lineItem);
      const costIdx = headers.indexOf(selectedCols.cost);
      const feeIdx  = headers.indexOf(selectedCols.fee);

      const records = data.map(row => ({
        description: (row[lineIdx] || '').toString().trim(),
        amount: toTwoDecimalAmount(row[costIdx])
      }));

      let taxaTotal = 0;
      for (const row of data) {
        const raw = (row[feeIdx] || '').toString().trim();
        const num = parseFloat(raw.replace(',', '.'));
        if (!isNaN(num)) taxaTotal += num;
      }

      if (!records.length) {
        notify('No non-empty rows found after parsing.', 'error');
        return;
      }

      const targetLines = records.length + 1;
      notify(`Preparing ${targetLines} total lines…`);

      await addRowsUntil(targetLines);
      await sleep(2000);

      const rows = getLineRows();
      if (rows.length < targetLines) {
        notify(`Only ${rows.length} lines available; expected ${targetLines}.`, 'error');
        return;
      }

      let filled = 0;
      for (let i = 0; i < records.length; i++) {
        const row = rows[i];

        const labels = Array.from(row.querySelectorAll('label'));
        const descLabel = labels.find(l => l.textContent.includes('Line Description'));
        const amtLabel = labels.find(l => l.textContent.includes('Amount'));

        const descInput = descLabel ? document.getElementById(descLabel.getAttribute('for')) : null;
        const amtInput = amtLabel ? document.getElementById(amtLabel.getAttribute('for')) : null;

        if (!descInput || !amtInput) {
          console.warn('[Auto MPESA] Could not find inputs in row', i + 1, row);
          continue;
        }

        let desc = records[i].description || '';
        const maxLen = parseInt(descInput.getAttribute('maxlength') || '30', 10);
        if (desc.length > maxLen) {
          desc = desc.slice(0, maxLen);
        }

        const amt = records[i].amount || '';

        setInputValue(descInput, desc);
        await sleep(30);
        setInputValue(amtInput, amt);
        await sleep(30);

        filled++;
      }

      notify(`Filled ${filled}/${records.length} rows. Last row left blank.`, 'success', 5000);

      if (taxaTotal > 0) {
        const lastRow = rows[records.length];
        const labels = Array.from(lastRow.querySelectorAll('label'));
        const descLabel = labels.find(l => l.textContent.includes('Line Description'));
        const amtLabel = labels.find(l => l.textContent.includes('Amount'));

        const descInput = descLabel ? document.getElementById(descLabel.getAttribute('for')) : null;
        const amtInput = amtLabel ? document.getElementById(amtLabel.getAttribute('for')) : null;

        if (descInput && amtInput) {
          setInputValue(descInput, 'MPESA FEE');
          await sleep(30);
          setInputValue(amtInput, taxaTotal.toFixed(2));
          await sleep(30);
          notify(`Added TAX row with total ${taxaTotal.toFixed(2)}.`, 'success');
        }
      }

    } catch (err) {
      console.error('[Auto MPESA] Error:', err);
      notify('Auto MPESA encountered an error. See console for details.', 'error', 6000);
    }
  }

  /********************
   * Bootstrapping    *
   ********************/
  function init() {
    if (document.documentElement.hasAttribute('data-auto-mpesa-init')) return;
    document.documentElement.setAttribute('data-auto-mpesa-init', '1');

    ensureButton();

    const mo = new MutationObserver(() => {
      ensureButton();
    });
    mo.observe(document.body, { childList: true, subtree: true });

    console.log('[Auto MPESA] Initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.__AutoMPESA = { processCSVText, addRowsUntil };
})();