// ==UserScript==
// @name         IMOS Auto Payment Filler (Reimbursement Helper)
// @namespace    https://imos.churchofjesuschrist.org/
// @version      3.0.0
// @description  Auto-fill one-time payment forms in IMOS based on standard URL params. Looks up IDs via IMOS Roster API using missionary emails.
// @match        *://imos.churchofjesuschrist.org/payment-creation/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Utility Functions ---
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // React-safe value setters
    function setInputValue(input, value) {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function setSelectValue(select, value) {
        if (!select) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Finds an input/select element by looking for its associated <label> text
    function findInputByLabel(context, labelText) {
        const labels = Array.from(context.querySelectorAll('label'));
        const targetLabel = labels.find(l => l.textContent.includes(labelText));
        if (targetLabel) {
            return document.getElementById(targetLabel.getAttribute('for'));
        }
        return null;
    }

    // Smart Wait: Polls until a specific labeled input exists on the page
    async function waitForElementByLabel(labelText, timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = findInputByLabel(document, labelText);
            if (el) return el;
            await sleep(300);
        }
        return null;
    }

    // Smart Wait: Polls until the Payee Name dropdown populates with our target ID
    async function waitForPayeeOption(selectEl, targetId, timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const options = Array.from(selectEl.options);
            const targetOption = options.find(opt => opt.textContent.includes(`(${targetId})`));
            if (targetOption) return targetOption;
            await sleep(300);
        }
        return null;
    }

    function getLineRows() {
        return Array.from(document.querySelectorAll('table.eden-table-table tbody tr'));
    }

    // Adds rows until the table has the required amount
    async function addRowsUntil(targetCount) {
        let current = getLineRows().length;
        if (current >= targetCount) return;

        let remaining = targetCount - current;

        while (remaining > 0) {
            const chunk = Math.min(20, remaining);
            const tfoot = document.querySelector('table.eden-table-table tfoot');
            if (!tfoot) break;

            const numSelect = tfoot.querySelector('select');
            const buttons = Array.from(tfoot.querySelectorAll('button'));
            const addBtn = buttons.find(b => b.textContent.trim() === 'Add');

            if (!addBtn) break;

            if (numSelect) {
                setSelectValue(numSelect, String(chunk));
                await sleep(100);
            }

            addBtn.click();

            const targetAfter = current + chunk;
            const t0 = Date.now();
            while (getLineRows().length < targetAfter && (Date.now() - t0) < 10000) {
                await sleep(200);
            }

            current = getLineRows().length;
            remaining = targetCount - current;
            await sleep(150);
        }
    }

    // --- API Fetch Logic ---
    async function fetchMissionaryIdByEmail(email) {
        try {
            const response = await fetch('https://imos.churchofjesuschrist.org/ws/auth-controller/api-v1/dynamic-reports/roster/data/default');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const roster = await response.json();

            // Search case-insensitive
            const missionary = roster.find(m => m.email && m.email.toLowerCase() === email.toLowerCase());

            if (missionary && missionary.legacyMissId) {
                console.log(`[IMOS Auto-Fill] Found missionary ID ${missionary.legacyMissId} for email ${email}`);
                return missionary.legacyMissId;
            } else {
                console.warn(`[IMOS Auto-Fill] Email ${email} not found in the roster, or lacks legacyMissId.`);
                return null;
            }
        } catch (error) {
            console.error('[IMOS Auto-Fill] Failed to fetch or parse roster data:', error);
            return null;
        }
    }

    // --- Main Logic ---
    async function runAutoFill() {
        // Parse URL params (Prioritize standard ?query=string, fallback to hash if needed)
        let queryString = window.location.search;
        if (!queryString && window.location.hash.includes('?')) {
            queryString = window.location.hash.substring(window.location.hash.indexOf('?'));
        }
        let urlParams = new URLSearchParams(queryString);

        let type = urlParams.get("abctype");
        let id = urlParams.get("abcid");
        let email = urlParams.get("abcemail"); // NEW PARAM
        let inv = urlParams.get("abcinv");
        let tax = urlParams.get("abctax");

        // If no type or li is found, assume this isn't an auto-fill URL and exit
        if (!type && !urlParams.has("abcli")) return;

        console.log("[IMOS Auto-Fill] Starting URL param processing. Waiting for page to load...");

        // Collect multiple li / val pairs
        const lineItems = [];
        urlParams.forEach((val, key) => {
            if (key.startsWith("abcli")) {
                const index = key.includes("_") ? key.split("_")[1] : "1";
                const amount = urlParams.get("abcval_" + index) || urlParams.get("abcval") || "";
                lineItems.push({ li: val, val: amount });
            }
        });

        // 1. Resolve Missionary ID from Email (if provided and id is not already explicitly set)
        if (email && !id) {
            console.log(`[IMOS Auto-Fill] Fetching roster to look up ID for email: ${email}`);
            id = await fetchMissionaryIdByEmail(email);
        }

        // WAIT FOR REACT TO RENDER THE FORM
        const payeeTypeSelect = await waitForElementByLabel('Payee Type', 15000);
        if (!payeeTypeSelect) {
            console.error("[IMOS Auto-Fill] Timed out waiting for the Payee Type field to appear. Is the page fully loaded?");
            return;
        }

        // 2. Select payee type
        if (type) {
            setSelectValue(payeeTypeSelect, type.toUpperCase());
            console.log("[IMOS Auto-Fill] Selected payee type:", type.toUpperCase());
        }

        // 3. Select payee name using the visible ID in parentheses
        if (id) {
            const payeeNameSelect = await waitForElementByLabel('Payee Name', 15000);
            if (payeeNameSelect) {
                console.log(`[IMOS Auto-Fill] Waiting for payee list to populate with ID (${id})...`);
                // Wait for the specific option to be injected by React
                const targetOption = await waitForPayeeOption(payeeNameSelect, id, 15000);

                if (targetOption) {
                    setSelectValue(payeeNameSelect, targetOption.value);
                    console.log("[IMOS Auto-Fill] Selected payee:", targetOption.textContent);
                    await sleep(500);
                } else {
                    console.warn(`[IMOS Auto-Fill] Could not find payee with ID (${id}) after waiting.`);
                }
            }
        }

        // 4. Fill invoice number
        if (inv) {
            const invInput = await waitForElementByLabel('Invoice Number', 5000);
            if (invInput) {
                setInputValue(invInput, inv);
                console.log("[IMOS Auto-Fill] Set invoice:", inv);
            }
        }

        // 5. Add needed rows
        const requiredRows = lineItems.length + (tax ? 1 : 0);
        if (requiredRows > 0) {
            await addRowsUntil(requiredRows);
            await sleep(1000); // Let React attach event listeners to new rows
        }

        const rows = getLineRows();

        // 6. Fill line items
        for (let i = 0; i < lineItems.length; i++) {
            const row = rows[i];
            if (!row) continue;

            const descInput = findInputByLabel(row, 'Line Description');
            const amtInput = findInputByLabel(row, 'Amount');

            if (descInput && amtInput) {
                setInputValue(descInput, lineItems[i].li);
                await sleep(50);
                setInputValue(amtInput, lineItems[i].val);
                await sleep(50);
                console.log("[IMOS Auto-Fill] Added line:", lineItems[i].li, lineItems[i].val);
            }
        }

        // 7. Add Tax line as "ATM FEE" if present
        if (tax) {
            const taxRow = rows[lineItems.length]; // The row immediately after standard line items
            if (taxRow) {
                const descInput = findInputByLabel(taxRow, 'Line Description');
                const amtInput = findInputByLabel(taxRow, 'Amount');
                const acctSelect = findInputByLabel(taxRow, 'Account');

                if (descInput && amtInput) {
                    setInputValue(descInput, "ATM FEE");
                    await sleep(50);
                    setInputValue(amtInput, tax);
                    await sleep(50);
                }

                if (acctSelect) {
                    const options = Array.from(acctSelect.options);
                    const foodExpenseOpt = options.find(o => o.textContent.includes("Food and Other Expenses"));
                    if (foodExpenseOpt) {
                        setSelectValue(acctSelect, foodExpenseOpt.value);
                        console.log("[IMOS Auto-Fill] Added ATM FEE line with Account:", foodExpenseOpt.textContent);
                    }
                }
            }
        }

        console.log("[IMOS Auto-Fill] Finished!");
    }

    // --- Initialization ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            runAutoFill();
        });
    } else {
        runAutoFill();
    }

})();