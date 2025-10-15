// ==UserScript==
// @name         Card Reconciliation Automator (v1.9 - iFrame Guard)
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Final version with dynamic iframe finding, a slower pace, and a guard to prevent it from loading in sub-frames.
// @author       Gemini
// @match        https://card.churchofjesuschrist.org/psc/card/EMPLOYEE/ERP/c/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- SCRIPT INITIALIZATION GUARD ---
    // This is the new check. If the script is running inside an iframe, stop it immediately.
    if (window.self !== window.top) {
        console.log('[Recon Script] Running inside an iframe, aborting.');
        return;
    }

    // --- UTILITY AND HELPER FUNCTIONS ---

    const log = (message) => console.log(`[Recon Script] ${message}`);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const waitForElement = (selector, context = document, timeout = 30000) => {
        return new Promise((resolve, reject) => {
            log(`Waiting for element: "${selector}"`);
            const intervalTime = 100;
            let elapsedTime = 0;
            const interval = setInterval(() => {
                const element = context.querySelector(selector);
                if (element) {
                    log(`Found element: "${selector}"`);
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        const errorMsg = `Timeout waiting for element: "${selector}"`;
                        log(`TIMEOUT: ${errorMsg}`);
                        reject(new Error(errorMsg));
                    }
                }
            }, intervalTime);
        });
    };

    const findNewestIframe = async (currentIframeCount, timeout = 20000) => {
        log(`Waiting for a new iframe to appear. Current count: ${currentIframeCount}`);
        return new Promise((resolve, reject) => {
            let elapsedTime = 0;
            const interval = setInterval(() => {
                const allIframes = document.querySelectorAll('iframe[id^="ptModFrame_"]');
                if (allIframes.length > currentIframeCount) {
                    const newIframe = allIframes[allIframes.length - 1];
                    log(`Detected new iframe: ${newIframe.id}`);
                    clearInterval(interval);
                    resolve(newIframe);
                } else {
                    elapsedTime += 250;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        reject(new Error(`Timeout: Waited for a new iframe but count did not increase from ${currentIframeCount}.`));
                    }
                }
            }, 250);
        });
    };


    // --- UI COMPONENTS ---

    function addStyles() {
        GM_addStyle(`
            #recon-float-button {
                position: fixed; bottom: 20px; right: 20px; z-index: 9999;
                background-color: #007bff; color: white; border: none; border-radius: 5px;
                padding: 10px 15px; font-size: 16px; cursor: pointer;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            }
            #recon-float-button:hover { background-color: #0056b3; }
            #recon-float-button:disabled { background-color: #cccccc; cursor: not-allowed; }
            .recon-modal-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0, 0, 0, 0.7); z-index: 10000; display: flex;
                justify-content: center; align-items: center;
            }
            .recon-modal-content {
                background: white; padding: 20px; border-radius: 8px;
                width: 80%; max-width: 800px; max-height: 90vh; overflow-y: auto;
            }
            .recon-modal-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            .recon-modal-table th, .recon-modal-table td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            .recon-modal-table th { background-color: #f2f2f2; }
            .recon-modal-input { width: 95%; padding: 5px; }
            .recon-modal-footer { margin-top: 20px; text-align: right; }
        `);
    }

    function createFloatingButton() {
        const button = document.createElement('button');
        button.id = 'recon-float-button';
        button.textContent = 'Start Recon';
        document.body.appendChild(button);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = '.pdf';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        button.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', handleFileSelect);
    }


    // --- CORE LOGIC ---

    async function handleFileSelect(event) {
        const button = document.getElementById('recon-float-button');
        button.textContent = 'Processing...';
        button.disabled = true;

        const files = event.target.files;
        if (!files.length) {
            log('No files selected.');
            button.textContent = 'Start Recon';
            button.disabled = false;
            return;
        }

        log(`Selected ${files.length} files.`);
        const { validReceipts, invalidReceipts } = parseFileNames(Array.from(files));

        let allReceipts = validReceipts;
        if (invalidReceipts.length > 0) {
            try {
                const manuallyCorrected = await showValidationModal(invalidReceipts);
                allReceipts = [...validReceipts, ...manuallyCorrected];
            } catch (error) {
                log('Modal was cancelled by user.');
                button.textContent = 'Start Recon';
                button.disabled = false;
                return;
            }
        }

        if (allReceipts.length > 0) {
            await processTransactions(allReceipts);
        } else {
            log('No valid receipts to process.');
        }

        button.textContent = 'Done!';
        setTimeout(() => {
            button.textContent = 'Start Recon';
            button.disabled = false;
        }, 5000);
    }

    function parseFileNames(files) {
        const validReceipts = [];
        const invalidReceipts = [];
        files.forEach(file => {
            const name = file.name.replace(/\.pdf$/i, '');
            const parts = name.split('-').map(p => p.trim());
            if (parts.length >= 2) {
                const valueAndCurrency = parts[0].split(' ');
                const value = parseFloat(valueAndCurrency[0].replace(/,/g, ''));
                const currency = valueAndCurrency.length > 1 ? valueAndCurrency[1].toUpperCase() : 'UNKNOWN';
                const lineItem = parts[parts.length - 1];
                if (!isNaN(value) && currency !== 'UNKNOWN') {
                    validReceipts.push({ file, value, currency, lineItem });
                } else {
                    invalidReceipts.push({ file });
                }
            } else {
                invalidReceipts.push({ file });
            }
        });
        log(`Parsed files: ${validReceipts.length} valid, ${invalidReceipts.length} invalid.`);
        return { validReceipts, invalidReceipts };
    }

    function showValidationModal(invalidReceipts) {
        return new Promise((resolve, reject) => {
            const modalOverlay = document.createElement('div');
            modalOverlay.className = 'recon-modal-overlay';
            const tableRows = invalidReceipts.map((receipt) => `
                <tr>
                    <td>${receipt.file.name}</td>
                    <td><input type="text" class="recon-modal-input" data-type="value" placeholder="e.g., 123.45 MZN"></td>
                    <td><input type="text" class="recon-modal-input" data-type="lineItem" placeholder="e.g., DIESEL FUEL"></td>
                </tr>
            `).join('');

            modalOverlay.innerHTML = `
                <div class="recon-modal-content">
                    <h2>Invalid Filenames</h2>
                    <p>Please correct the value and line item for the following files:</p>
                    <table class="recon-modal-table">
                        <thead><tr><th>Filename</th><th>Value (e.g., 123.45 MZN)</th><th>Line Item</th></tr></thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                    <div class="recon-modal-footer">
                        <button id="recon-modal-cancel">Cancel</button>
                        <button id="recon-modal-submit" style="margin-left: 10px;">Submit</button>
                    </div>
                </div>`;
            document.body.appendChild(modalOverlay);

            document.getElementById('recon-modal-submit').addEventListener('click', () => {
                const correctedReceipts = [];
                let allValid = true;
                const rows = modalOverlay.querySelectorAll('tbody tr');
                rows.forEach((row, index) => {
                    const valueInput = row.querySelector('input[data-type="value"]');
                    const lineItemInput = row.querySelector('input[data-type="lineItem"]');
                    const valueStr = valueInput.value.trim();
                    const lineItem = lineItemInput.value.trim();
                    if (!valueStr || !lineItem) {
                        allValid = false;
                        valueInput.style.borderColor = valueStr ? '' : 'red';
                        lineItemInput.style.borderColor = lineItem ? '' : 'red';
                        return;
                    }
                    const valueParts = valueStr.split(' ');
                    const value = parseFloat(valueParts[0].replace(/,/g, ''));
                    const currency = valueParts.length > 1 ? valueParts[1].toUpperCase() : 'UNKNOWN';
                    if (isNaN(value) || currency === 'UNKNOWN') {
                        allValid = false;
                        valueInput.style.borderColor = 'red';
                        return;
                    }
                    correctedReceipts.push({ file: invalidReceipts[index].file, value, currency, lineItem });
                });

                if (allValid) {
                    document.body.removeChild(modalOverlay);
                    resolve(correctedReceipts);
                } else {
                    alert('Please fill all fields correctly.');
                }
            });

            document.getElementById('recon-modal-cancel').addEventListener('click', () => {
                document.body.removeChild(modalOverlay);
                reject(new Error("User cancelled the modal."));
            });
        });
    }

    async function processTransactions(receipts) {
        log('Starting transaction processing...');
        const processedIndices = new Set();
        for (const receipt of receipts) {
            log(`Searching for transaction for: ${receipt.file.name}`);
            const transactionRows = document.querySelectorAll('#win0sidedivEX_SHEET_DTL_GROUP\\$0 ul.ps_grid-body > li.ps_grid-row');
            let matchFound = false;
            for (let i = 0; i < transactionRows.length; i++) {
                if (processedIndices.has(i)) continue;
                const row = transactionRows[i];
                const amountEl = row.querySelector(`[id^='MONETARY_AMT_DTL\\$']`);
                const currencyEl = row.querySelector(`[id^='CURRENCY_CD_DTL\\$']`);
                if (amountEl && currencyEl) {
                    const pageAmount = parseFloat(amountEl.textContent.replace(/,/g, ''));
                    const pageCurrency = currencyEl.textContent.trim().toUpperCase();
                    if (pageAmount === receipt.value && pageCurrency === receipt.currency) {
                        log(`Match found for ${receipt.value} ${receipt.currency}`);
                        try {
                            await processSingleTransaction(row, receipt);
                            processedIndices.add(i);
                            matchFound = true;
                            break;
                        } catch (e) {
                            log(`ERROR processing transaction: ${e.message}`);
                            alert(`An error occurred processing ${receipt.file.name}. Check console. Continuing...`);
                            break;
                        }
                    }
                }
            }
            if (!matchFound) {
                log(`No matching transaction found for receipt: ${receipt.file.name}`);
            }
        }
        log('All processing complete.');
    }


    // --- TRANSACTION PROCESSING FUNCTION ---

    async function processSingleTransaction(rowElement, receipt) {
        log(`--- Starting processing for: ${receipt.lineItem} ---`);

        // Step 1: Set description, click away, and wait patiently.
        log("Step 1: Setting description on main page.");
        rowElement.click();
        await sleep(4000);
        const descriptionBox = await waitForElement('#DESCR\\$0');
        descriptionBox.value = receipt.lineItem;
        descriptionBox.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Set description to: "${receipt.lineItem}"`);
        descriptionBox.blur();
        log("Clicked away from description box. Waiting for system to process...");
        await sleep(4000);

        const attachButton = await waitForElement("a[id^='EX_LINE_WRK_ATTACH_PB']");
        let currentIframeCount = document.querySelectorAll('iframe[id^="ptModFrame_"]').length;
        attachButton.click();
        log('Clicked "Attach Receipt".');

        // Step 2: Dynamically find the first modal iframe.
        const iframe0 = await findNewestIframe(currentIframeCount);
        log(`Waiting for content in ${iframe0.id}...`);
        await sleep(3500);
        const iframeDoc0 = iframe0.contentDocument || iframe0.contentWindow.document;
        if (!iframeDoc0) throw new Error("Could not get content document from first iframe.");
        log(`Successfully accessed document of ${iframe0.id}.`);

        const addAttachmentButton = await waitForElement("a[id^='C_EX_ATT_WRK_ATTACHADD']", iframeDoc0);
        currentIframeCount = document.querySelectorAll('iframe[id^="ptModFrame_"]').length;
        addAttachmentButton.click();
        log("Clicked 'Add Attachment'.");

        // Step 3: Dynamically find the second (nested) modal iframe.
        const iframe1 = await findNewestIframe(currentIframeCount);
        log(`Waiting for content in ${iframe1.id}...`);
        await sleep(3500);
        const iframeDoc1 = iframe1.contentDocument || iframe1.contentWindow.document;
        if (!iframeDoc1) throw new Error("Could not get content document from second iframe.");
        log(`Successfully accessed document of ${iframe1.id}.`);

        // File upload process inside the second iframe.
        const fileInput = await waitForElement('input[type="file"]#\\#ICOrigFileName', iframeDoc1);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(receipt.file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Attached file: ${receipt.file.name}`);
        await sleep(1500);

        const uploadButton = await waitForElement('a#\\#ICUpload', iframeDoc1);
        if (uploadButton && uploadButton.style.display !== 'none') {
            uploadButton.click();
            log('Clicked "Upload"');
        } else { throw new Error('Upload button not found or not visible.'); }

        await waitForElement('.ps_attach-completetext', iframeDoc1, 60000);
        log('Upload complete.');
        await sleep(2000);

        await (await waitForElement('a#\\#ICOK', iframeDoc1)).click();
        log(`Clicked "Done" in ${iframe1.id}, closing it.`);

        // Step 4: Return to the first iframe's context and finish.
        log(`Step 4: Context is now back in ${iframe0.id}.`);
        await sleep(4000);

        const attachDescriptionInput = await waitForElement("input[id^='ATTACH_DESCR\\$']", iframeDoc0);
        attachDescriptionInput.value = receipt.lineItem;
        attachDescriptionInput.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Set attachment description to: "${receipt.lineItem}"`);
        await sleep(1500);

        await (await waitForElement("a#\\#ICSave", iframeDoc0)).click();
        log(`Finished processing. Closing main attachment modal.`);

        log(`--- Completed: ${receipt.lineItem}. Pausing before next transaction... ---`);
        await sleep(7000);
    }


    // --- SCRIPT INITIALIZATION ---

    log('Script loaded. Initializing on main page.');
    addStyles();
    createFloatingButton();

})();