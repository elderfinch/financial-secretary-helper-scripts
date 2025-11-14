// ==UserScript==
// @name         Auto Card Recon
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Uploads card recon receipts, descriptions, and auto-fills Accounting from PDF metadata. Fixed upload stalling issues.
// @author       Gemini & Elder Benjamin Finch
// @match        https://card.churchofjesuschrist.org/psc/card/*
// @grant        GM_addStyle
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    if (window.self !== window.top) return;

    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const log = (msg) => console.log(`[Recon v2.3] ${msg}`);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const waitForElement = (selector, context = document, timeout = 30000) => {
        return new Promise((resolve, reject) => {
            log(`Waiting for: "${selector}"`); // Added logging
            const intervalTime = 100;
            let elapsedTime = 0;
            const interval = setInterval(() => {
                const element = context.querySelector(selector);
                if (element) { // This is the simple check from v2.1
                    log(`Found: "${selector}"`);
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        const errorMsg = `Timeout waiting for: "${selector}"`;
                        log(`FATAL ERROR: ${errorMsg}`); // Match your log style
                        reject(new Error(errorMsg));
                    }
                }
            }, intervalTime);
        });
    };

    const findNewestIframe = async (currentCount, timeout = 30000) => {
        log(`Looking for iframe > ${currentCount}...`);
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const frames = document.querySelectorAll('iframe[id^="ptModFrame_"]');
            if (frames.length > currentCount) {
                const newFrame = frames[frames.length - 1];
                // Wait for it to have content
                try {
                    if (newFrame.contentDocument && newFrame.contentDocument.body.innerHTML.length > 50) {
                         log(`Found new iframe: ${newFrame.id}`);
                         return newFrame;
                    }
                } catch (e) { /* ignore cross-origin momentarily */ }
            }
            await sleep(500);
        }
        throw new Error("Timeout waiting for new iframe to load.");
    };

    // --- METADATA ---
    async function extractKeywordsFromPDF(file) {
        try {
            const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
            const meta = await pdf.getMetadata();
            if (meta?.info?.Keywords) {
                const kw = meta.info.Keywords.trim();
                console.log(kw);
                try { return JSON.parse(kw); } catch (e) { return kw.split(/[,; \t]+/).filter(k => k.trim()); }
            }
        } catch (e) { log(`Metadata error for ${file.name}: ${e.message}`); }
        return null;
    }

    // --- GUI ---
    function addStyles() {
        GM_addStyle(`
            #recon-float-btn { position: fixed; bottom: 20px; right: 20px; z-index: 9999; padding: 12px 20px; background: #007bff; color: white; border: none; border-radius: 50px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3); font-size: 16px; }
            #recon-float-btn:hover { background: #0056b3; }
            #recon-float-btn:disabled { background: #999; cursor: wait; }
        `);
    }

    function createUI() {
        const btn = document.createElement('button');
        btn.id = 'recon-float-btn';
        btn.textContent = 'Start Recon';
        document.body.appendChild(btn);
        const fileIn = document.createElement('input');
        fileIn.type = 'file'; fileIn.multiple = true; fileIn.accept = '.pdf'; fileIn.style.display = 'none';
        document.body.appendChild(fileIn);
        btn.onclick = () => fileIn.click();
        fileIn.onchange = handleFiles;
    }

    // --- MAIN LOOP ---
    async function handleFiles(e) {
        const btn = document.getElementById('recon-float-btn');
        btn.disabled = true; btn.textContent = 'Processing...';
        try {
            const files = Array.from(e.target.files);
            if (!files.length) return;

            log(`Reading ${files.length} files...`);
            const receipts = [];
            for (const file of files) {
                const name = file.name.replace(/\.pdf$/i, '');
                const parts = name.split('-');
                if (parts.length >= 2) {
                    const [valStr, cur] = parts[0].trim().split(' ');
                    const val = parseFloat(valStr.replace(/,/g, ''));
                    if (!isNaN(val)) {
                        receipts.push({
                            file, value: val,
                            currency: (cur || 'USD').toUpperCase(),
                            lineItem: parts[parts.length - 1].trim(),
                            keywords: await extractKeywordsFromPDF(file)
                        });
                    }
                }
            }

            if (!receipts.length) { alert("No valid filenames found (Format: 123.45 USD - Description.pdf)"); return; }

            for (const r of receipts) {
                await processReceipt(r);
            }
            alert("Processing Complete!");
        } catch (err) {
            log("FATAL ERROR: " + err.message);
            alert("Error: " + err.message);
        } finally {
            btn.disabled = false; btn.textContent = 'Start Recon';
            e.target.value = '';
        }
    }

    async function processReceipt(r) {
        log(`>>> Processing: ${r.lineItem} (${r.value})`);
        const rows = document.querySelectorAll('li.ps_grid-row');
        let row = null;

        for (const rCandidate of rows) {
            const amt = rCandidate.querySelector("[id^='MONETARY_AMT_DTL\\$']")?.textContent.replace(/,/g, '');
            if (amt && Math.abs(parseFloat(amt) - r.value) < 0.01) {
                row = rCandidate;
                break;
            }
        }

        if (!row) { log(`No match for ${r.value}`); return; }

        // 1. Set Description
        row.click();
        
        log("Waiting for row details to load...");
        await sleep(4500); // Using the patient 4.5s sleep
        
        const desc = await waitForElement('#DESCR\\$0');
        desc.focus(); desc.value = r.lineItem; desc.dispatchEvent(new Event('change', { bubbles: true })); desc.blur();
        
        log("Waiting for description change to process...");
        await sleep(4500); // Using the patient 4.5s sleep

        // 2. Attach File
        let iframes = document.querySelectorAll('iframe').length;
        (await waitForElement("a[id^='EX_LINE_WRK_ATTACH_PB']")).click();
        const f1 = await findNewestIframe(iframes);
        const d1 = f1.contentDocument;

        iframes = document.querySelectorAll('iframe').length;
        (await waitForElement("a[id^='C_EX_ATT_WRK_ATTACHADD']", d1)).click();
        const f2 = await findNewestIframe(iframes);

        log("Waiting for file upload modal to load...");
        await sleep(3500); 
        const d2 = f2.contentDocument;
        
        const fileIn = await waitForElement('input[type="file"]#\\#ICOrigFileName', d2);

        const dt = new DataTransfer(); dt.items.add(r.file);
        fileIn.files = dt.files;
        fileIn.dispatchEvent(new Event('input', { bubbles: true }));
        fileIn.dispatchEvent(new Event('change', { bubbles: true }));
        fileIn.blur();
        await sleep(1500);

        log("Clicking upload...");
        (await waitForElement('a#\\#ICUpload', d2)).click();

        // WAIT FOR UPLOAD - ROBUST METHOD
        try {
            await waitForElement('.ps_attach-completetext', d2, 45000);
            log("Upload success text detected.");
        } catch (e) {
            log("Upload text timeout. Checking if file exists in list anyway...");
            const fileList = d2.body.textContent;
            if (!fileList.includes(r.file.name)) throw new Error("Upload failed - file not found in list.");
        }

        (await waitForElement('a#\\#ICOK', d2)).click();
        await sleep(3000);

        // Save Attachment Modal
        const attDesc = await waitForElement("input[id^='ATTACH_DESCR\\$']", d1);
        attDesc.value = r.lineItem; attDesc.dispatchEvent(new Event('change', { bubbles: true }));
        (await waitForElement("a#\\#ICSave", d1)).click();
        await sleep(5000); // Wait for main page to settle

        // 3. Accounting
        if (r.keywords?.length >= 2) {
            log(`Doing Accounting: ${r.keywords.join(', ')}`);
            iframes = document.querySelectorAll('iframe').length;
            (await waitForElement("a[id*='ACCTING_DETAIL']")).click();
            const af = await findNewestIframe(iframes);
            const ad = af.contentDocument;

            // --- START FIX ---
            const setVal = async (sel, val) => {
                const el = await waitForElement(sel, ad);
                el.focus(); 
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                
                // NEW: Simulate pressing Enter to trigger validation
                log(`Simulating Enter on: ${sel}`);
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    keyCode: 13,
                    code: 'Enter',
                    which: 13,
                    bubbles: true,
                    cancelable: true
                }));
                
                el.blur();
                // Give it a moment to process the validation
                await sleep(1500); 
            };
            // --- END FIX ---

            await setVal('input[id^="DEPTID\\$"]', "1863" + r.keywords[0]);
            await setVal('input[id^="ACCOUNT\\$"]', r.keywords[1]);

            // Wait for any potential validation scripts to finish after the last 'Enter'
            await sleep(2000);

            (await waitForElement("a#DONE_PB", ad)).click();
            await sleep(4000);
        }
        log(`<<< Done: ${r.lineItem}`);
    }

    createUI();
    addStyles();
})();