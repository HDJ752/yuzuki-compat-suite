import { saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

(() => {
    'use strict';

    console.info('[yuzuki-00-compat-suite] booting', import.meta.url);

    const VERSION = '0.3.0';
    const NAMESPACE = 'YuzukiCompatSuite';
    const REQUEST_ARRAY_KEYS = ['messages', 'chat', 'prompt', 'contents'];
    const REPLACEMENT_MARKER = '<run_tool_replacement>';
    const SPRESET_FRAME_PREFIX = 'TH-script--';
    const SOLIUMBRA_SP_RESET = 'TH-script--【SoliUmbra】SPreset--';
    const GENERIC_SP_RESET = 'TH-script--SPreset--';
    const SPRESET_REMOTE = '/regex_bind/inject.js';
    const PROCESS_BODY_FLAG = Symbol.for('yuzuki.compat-suite.processBody.wrapped');
    const FRAME_GUARD_FLAG = Symbol.for('yuzuki.compat-suite.frameGuard.installed');
    const SIGNATURE_KEYS = new Set(['signature', 'thoughtsignature', 'reasoningsignature']);
    const suiteState = {
        installed: false,
        processWrapCount: 0,
        frameGuardInstalled: false,
        framesRemoved: 0,
        duplicateScriptsRemoved: 0,
        normalizedCount: 0,
        restoreCount: 0,
        lastNormalization: null,
        lastScan: null,
        lastError: null,
    };

    const DEFAULT_SETTINGS = Object.freeze({
        catGod: 'auto',
        dieGuard: 'auto',
        panelCollapsed: false,
    });
    let observedReadyPromise = null;
    let frameObserver = null;
    let scanScheduled = false;
    let menuRetryTimer = null;
    let presetPollTimer = null;

    function getSettings() {
        const current = extension_settings.yuzukiCompatSuite;
        if (!current || typeof current !== 'object') extension_settings.yuzukiCompatSuite = {};
        const settings = extension_settings.yuzukiCompatSuite;
        Object.keys(DEFAULT_SETTINGS).forEach((key) => {
            if (settings[key] === undefined) settings[key] = DEFAULT_SETTINGS[key];
        });
        return settings;
    }

    function persistSettings() {
        try { saveSettingsDebounced(); } catch (_error) { /* host may still be booting */ }
    }

    function notify(message, type = 'info') {
        const toast = typeof toastr !== 'undefined' ? toastr : null;
        const fn = typeof toast?.[type] === 'function' ? toast[type] : toast?.info;
        if (fn) fn.call(toast, message, '柚月兼容合集', { timeOut: 2800 });
        else console.info(`[${NAMESPACE}] ${message}`);
    }

    function getCurrentPresetName() {
        try {
            const context = (window.SillyTavern || globalThis.SillyTavern)?.getContext?.();
            const settings = context?.chatCompletionSettings || {};
            const candidates = [
                settings.preset_settings_openai,
                settings.preset_name,
                settings.name,
                document.querySelector('#settings_preset_openai option:checked')?.textContent,
                document.querySelector('#settings_preset_openai option:checked')?.value,
            ];
            const value = candidates.find((entry) => typeof entry === 'string' && entry.trim());
            return String(value || '').trim();
        } catch (_error) {
            return '';
        }
    }

    function detectPreset() {
        const name = getCurrentPresetName();
        return {
            name,
            // Observed in the current SillyTavern preset list. Keep matching
            // family names only; generic SPreset/SoliUmbra names stay manual.
            catGod: /小猫之神|喵赛亚/i.test(name),
            dieGuard: /(?:^|[【\s_-])DIE(?=[】\s_.-]|$)/i.test(name),
        };
    }

    function featureEnabled(key, detected = detectPreset()) {
        const value = getSettings()[key];
        if (value === 'on') return true;
        if (value === 'off') return false;
        return Boolean(detected[key]);
    }

    function shouldWrapAnyFeature(detected = detectPreset()) {
        return featureEnabled('catGod', detected) || featureEnabled('dieGuard', detected);
    }

    function cloneValue(value) {
        if (value === undefined) return value;
        try { return structuredClone(value); } catch (_error) {
            try { return JSON.parse(JSON.stringify(value)); } catch (_jsonError) { return value; }
        }
    }

    function getMessageRole(message) { return String(message?.role || '').trim().toLowerCase(); }
    function getMessageContent(message) { return message && typeof message === 'object' ? message.content : ''; }
    function messageText(message) {
        const content = getMessageContent(message);
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n');
        return typeof message?.text === 'string' ? message.text : (typeof message?.mes === 'string' ? message.mes : '');
    }

    function hasReplacementMarker(items) {
        return items.some((message) => getMessageRole(message) === 'system' && messageText(message).includes(REPLACEMENT_MARKER));
    }

    function isMemoryMessage(message) {
        return Boolean(message?.isGaigaiData || message?.isGaigaiPrompt || message?.isGaigaiVector || message?.isYuzukiVector || message?.yzmMemoryInjectionType || message?.yzmMemoryTableId || message?.yzmMemorySummaryId);
    }

    function mergeContent(messages) {
        const contents = messages.map(getMessageContent).filter((content) => content !== undefined && content !== null);
        if (contents.every((content) => typeof content === 'string')) return contents.join('\n\n');
        const parts = [];
        contents.forEach((content) => {
            if (Array.isArray(content)) parts.push(...cloneValue(content));
            else if (typeof content === 'string') parts.push({ type: 'text', text: content });
            else if (content && typeof content === 'object') parts.push(cloneValue(content));
        });
        return parts;
    }

    function mergeUniqueArrays(messages, key) {
        const values = [];
        const seen = new Set();
        messages.forEach((message) => {
            if (!Array.isArray(message?.[key])) return;
            message[key].forEach((entry) => {
                const identity = entry?.id || entry?.call_id || JSON.stringify(entry);
                if (seen.has(identity)) return;
                seen.add(identity);
                values.push(cloneValue(entry));
            });
        });
        return values;
    }

    function normalizeReplacement(items, options = {}) {
        // The Cat-God SPreset sometimes removes the replacement marker before
        // the memory injector returns the body. Its contract is still
        // unambiguous: system -> assistant* -> user. In that preset mode the
        // shape itself is sufficient to trigger the merge. Memory injection
        // can also add a system message between assistant messages, so those
        // system parts are folded into the leading system message first.
        const requireMarker = options.requireMarker !== false;
        if (!Array.isArray(items) || items.length <= 3 || (requireMarker && !hasReplacementMarker(items))) return false;
        if (getMessageRole(items[0]) !== 'system' || getMessageRole(items.at(-1)) !== 'user') return false;
        const middle = items.slice(1, -1);
        const assistants = middle.filter((message) => getMessageRole(message) === 'assistant');
        const extraSystems = middle.filter((message) => getMessageRole(message) === 'system');
        if (assistants.length === 0 || assistants.length + extraSystems.length !== middle.length) return false;
        const header = cloneValue(items[0]);
        if (extraSystems.length) header.content = mergeContent([items[0], ...extraSystems]);
        const base = cloneValue([...assistants].sort((left, right) => {
            const score = (message) => (Array.isArray(message?.tool_calls) ? 8 : 0) + (message?.tool_call ? 4 : 0) + (isMemoryMessage(message) ? -4 : 0) + (messageText(message).trim() ? 1 : 0);
            return score(right) - score(left);
        })[0] || {});
        base.role = 'assistant';
        base.content = mergeContent(assistants);
        const toolCalls = mergeUniqueArrays(assistants, 'tool_calls');
        if (toolCalls.length) base.tool_calls = toolCalls;
        if (!base.tool_call) {
            const source = assistants.find((message) => message?.tool_call);
            if (source) base.tool_call = cloneValue(source.tool_call);
        }
        for (const key of ['signature', 'thought_signature', 'thoughtSignature', 'reasoning_signature']) {
            if (base[key] !== undefined) continue;
            const source = assistants.find((message) => message?.[key] !== undefined);
            if (source) base[key] = cloneValue(source[key]);
        }
        const beforeRoles = items.map(getMessageRole);
        items.splice(0, items.length, header, base, items.at(-1));
        suiteState.normalizedCount += 1;
        suiteState.lastNormalization = { at: new Date().toISOString(), beforeRoles, afterRoles: items.map(getMessageRole), assistantCount: assistants.length };
        return true;
    }

    function normalizeRequestBody(body, options = {}) {
        if (!body || typeof body !== 'object') return 0;
        let normalized = 0;
        const seen = new Set();
        REQUEST_ARRAY_KEYS.forEach((key) => {
            const items = body[key];
            if (!Array.isArray(items) || seen.has(items)) return;
            seen.add(items);
            if (normalizeReplacement(items, options)) normalized += 1;
        });
        return normalized;
    }

    function isSignatureValue(value) {
        if (typeof value === 'string') return value.trim().length > 0;
        if (typeof value === 'number' || typeof value === 'bigint') return true;
        if (Array.isArray(value)) return value.length > 0;
        return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
    }

    function normalizeSignatureKey(key) { return String(key || '').replace(/[_-]/g, '').toLowerCase(); }

    function collectSignatureTokens(node, tokens = new Set(), seen = new WeakSet(), depth = 0) {
        if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return tokens;
        seen.add(node);
        Object.entries(node).forEach(([key, value]) => {
            if (SIGNATURE_KEYS.has(normalizeSignatureKey(key)) && isSignatureValue(value)) {
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') tokens.add(`${typeof value}:${String(value)}`);
                else { try { tokens.add(`json:${JSON.stringify(value)}`); } catch (_error) { tokens.add(`object:${key}`); } }
            }
            if (value && typeof value === 'object') collectSignatureTokens(value, tokens, seen, depth + 1);
        });
        return tokens;
    }

    function collectSignaturePaths(node, paths = new Set(), seen = new WeakSet(), prefix = '$', depth = 0) {
        if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return paths;
        seen.add(node);
        Object.entries(node).forEach(([key, value]) => {
            const path = `${prefix}.${key}`;
            if (SIGNATURE_KEYS.has(normalizeSignatureKey(key)) && isSignatureValue(value)) paths.add(path);
            if (value && typeof value === 'object') collectSignaturePaths(value, paths, seen, path, depth + 1);
        });
        return paths;
    }

    function isSignedAssistant(message) {
        const role = getMessageRole(message);
        return Boolean(message && (role === 'assistant' || role === 'model') && messageText(message).trim() === '' && collectSignatureTokens(message).size);
    }

    function collectSignedMessages(body) {
        return getRequestArrays(body).map(({ key, items }) => {
            const entries = items.map((message, index) => ({ message, index }));
            let lastUserIndex = -1;
            entries.forEach(({ message, index }) => { if (getMessageRole(message) === 'user' || message?.is_user === true) lastUserIndex = index; });
            const signedEntries = entries.filter(({ message }) => isSignedAssistant(message));
            const candidates = signedEntries.filter(({ message, index }) => index > lastUserIndex || message?.injected === true || message?.isInjected === true).map(({ message, index }) => ({ message, index, tokens: collectSignatureTokens(message), paths: [...collectSignaturePaths(message)].map((path) => path.replace(/^\$\./, '')) }));
            return { key, items, entries, candidates, ignoredSigned: signedEntries.length - candidates.length };
        });
    }

    function containsAnySignature(items, expectedTokens) {
        return items.some((message) => [...collectSignatureTokens(message)].some((token) => expectedTokens.has(token)));
    }

    function findRestoreIndex(items, entries, originalIndex) {
        const following = entries.filter((entry) => entry.index > originalIndex && items.includes(entry.message)).sort((a, b) => a.index - b.index)[0];
        if (following) return items.indexOf(following.message);
        const preceding = entries.filter((entry) => entry.index < originalIndex && items.includes(entry.message)).sort((a, b) => b.index - a.index)[0];
        if (preceding) return items.indexOf(preceding.message) + 1;
        return Math.min(Math.max(originalIndex, 0), items.length);
    }

    function normalizeToolCallForTransport(toolCall) {
        if (!toolCall || typeof toolCall !== 'object') return null;
        const signature = toolCall.signature ?? toolCall.thought_signature ?? toolCall.thoughtSignature;
        const normalized = { id: toolCall.id, type: 'function', function: { name: toolCall.function?.name ?? toolCall.name, arguments: toolCall.function?.arguments ?? (typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments ?? {})) } };
        if (signature !== undefined && signature !== null && signature !== '') normalized.signature = signature;
        return normalized;
    }

    function toTransportSafeShell(message) {
        const shell = { ...message };
        if (!Array.isArray(shell.content)) return shell;
        const texts = [];
        const toolCalls = [];
        shell.content.forEach((part) => {
            if (part && part.type === 'tool_calls' && Array.isArray(part.tool_calls)) part.tool_calls.forEach((call) => { const normalized = normalizeToolCallForTransport(call); if (normalized) toolCalls.push(normalized); });
            else if (typeof part === 'string') texts.push(part);
            else if (part && typeof part.text === 'string') texts.push(part.text);
        });
        if (!toolCalls.length) return shell;
        const existing = Array.isArray(shell.tool_calls) ? shell.tool_calls.slice() : [];
        const seenIds = new Set(existing.map((call) => String(call?.id || '')));
        toolCalls.forEach((call) => { const id = String(call.id || ''); if (id && seenIds.has(id)) return; seenIds.add(id); existing.push(call); });
        shell.content = texts.join('\n');
        shell.tool_calls = existing;
        return shell;
    }

    function restoreMissingMessages(body, snapshots) {
        let restored = 0;
        const restoredByKey = {};
        snapshots.forEach(({ key, entries, candidates }) => {
            const items = body?.[key];
            if (!Array.isArray(items)) return;
            [...candidates].sort((a, b) => b.index - a.index).forEach(({ message, index, tokens }) => {
                if (items.includes(message) || containsAnySignature(items, tokens)) return;
                const shell = toTransportSafeShell(message);
                items.splice(findRestoreIndex(items, entries, index), 0, shell);
                entries[index].message = shell;
                restored += 1;
                restoredByKey[key] = (restoredByKey[key] || 0) + 1;
            });
        });
        const scanned = snapshots.reduce((sum, target) => sum + target.candidates.length, 0);
        suiteState.lastScan = { arrays: snapshots.map((target) => target.key), signedCandidates: scanned, ignoredSigned: snapshots.reduce((sum, target) => sum + (target.ignoredSigned || 0), 0), restored, restoredByKey, signaturePaths: [...new Set(snapshots.flatMap((target) => target.candidates.flatMap((candidate) => candidate.paths)))], at: new Date().toISOString() };
        if (restored) suiteState.restoreCount += restored;
        return restored;
    }

    function removeNode(node, kind) {
        if (!node || !node.isConnected) return false;
        const id = node.id || node.getAttribute?.('id') || '';
        node.remove();
        if (kind === 'frame') { suiteState.framesRemoved += 1; suiteState.removedFrameIds = [...(suiteState.removedFrameIds || []), id].slice(-20); }
        else suiteState.duplicateScriptsRemoved += 1;
        return true;
    }

    function scanSPresetFrames() {
        scanScheduled = false;
        // Only target presets get lifecycle cleanup. A normal preset keeps its
        // own iframe lifecycle untouched.
        const detected = detectPreset();
        const catGodEnabled = featureEnabled('catGod', detected);
        const dieGuardEnabled = featureEnabled('dieGuard', detected);
        if (!catGodEnabled && !dieGuardEnabled) return;
        try {
            const frames = [...document.querySelectorAll(`iframe[id^="${SPRESET_FRAME_PREFIX}"]`)].filter((frame) => /SPreset/i.test(frame.id));
            if (!frames.length) return;
            const soliumbra = frames.filter((frame) => frame.id.startsWith(SOLIUMBRA_SP_RESET));
            const generic = frames.filter((frame) => frame.id.startsWith(GENERIC_SP_RESET));
            const preferred = catGodEnabled ? soliumbra : generic;
            const keep = preferred.at(-1) || frames.at(-1);
            frames.filter((frame) => frame !== keep).forEach((frame) => removeNode(frame, 'frame'));
            [...document.querySelectorAll('script[src]')].filter((script) => String(script.src || '').includes(SPRESET_REMOTE)).slice(1).forEach((script) => removeNode(script, 'script'));
        } catch (error) { suiteState.lastError = String(error?.message || error); }
    }

    function scheduleFrameScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        const schedule = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : (callback) => window.setTimeout(callback, 0);
        schedule(scanSPresetFrames);
    }

    function installFrameGuard() {
        if (!featureEnabled('catGod') && !featureEnabled('dieGuard')) {
            frameObserver?.disconnect?.();
            frameObserver = null;
            if (window[FRAME_GUARD_FLAG]) {
                try { delete window[FRAME_GUARD_FLAG]; } catch (_error) { /* configurable marker */ }
            }
            suiteState.frameGuardInstalled = false;
            return false;
        }
        if (window[FRAME_GUARD_FLAG]) { suiteState.frameGuardInstalled = true; scanSPresetFrames(); return true; }
        const root = document.documentElement || document.body;
        if (!root || typeof MutationObserver !== 'function') { scanSPresetFrames(); return false; }
        frameObserver = new MutationObserver(scheduleFrameScan);
        frameObserver.observe(root, { childList: true, subtree: true });
        Object.defineProperty(window, FRAME_GUARD_FLAG, { value: true, configurable: true });
        suiteState.frameGuardInstalled = true;
        scanSPresetFrames();
        return true;
    }

    function installMemoryCompat() {
        const memory = window.YuzukiMemory;
        if (memory?.readyPromise && memory.readyPromise !== observedReadyPromise) {
            observedReadyPromise = memory.readyPromise;
            observedReadyPromise.then(installMemoryCompat).catch((error) => { suiteState.lastError = String(error?.message || error); });
        }
        const injector = memory?.VariableInjector;
        const current = injector?.processBody;
        if (memory?.settingsBridge?.isPluginEnabled?.() === false || typeof current !== 'function') { suiteState.installed = false; return false; }
        const detected = detectPreset();
        const settings = getSettings();
        // The preset name is not always exposed by SillyTavern while the request
        // pipeline is being rebuilt (especially after a mobile/desktop reload).
        // Keep the wrapper installed for auto mode and let the stable
        // <run_tool_replacement> marker decide whether a request needs the
        // Cat-God normalization. This prevents SPreset from seeing the split
        // assistant messages even when preset detection is temporarily blank.
        if (settings.catGod === 'off' && settings.dieGuard === 'off') {
            suiteState.installed = false;
            return false;
        }
        let cursor = current;
        for (let depth = 0; typeof cursor === 'function' && depth < 24; depth += 1) {
            if (cursor[PROCESS_BODY_FLAG] === true) { suiteState.installed = true; return true; }
            cursor = cursor.originalProcessBody;
        }
        const suiteProcessBody = async function (body, options = {}) {
            const requestPreset = detectPreset();
            const snapshots = featureEnabled('dieGuard', requestPreset) ? collectSignedMessages(body) : [];
            const result = await current.call(this, body, options);
            const resultBody = result && typeof result === 'object' ? result : body;
            if (featureEnabled('dieGuard', requestPreset)) restoreMissingMessages(resultBody, snapshots);
            // normalizeRequestBody is itself marker- and shape-gated, so calling
            // it in auto mode is safe for ordinary presets and ordinary chats.
            if (getSettings().catGod !== 'off') {
                const allowPresetShape = featureEnabled('catGod', requestPreset);
                const normalized = normalizeRequestBody(resultBody, { requireMarker: !allowPresetShape });
                if (normalized) console.info('[yuzuki-00-compat-suite] normalized SPreset message shape', { normalized, allowPresetShape });
            }
            return result;
        };
        Object.defineProperty(suiteProcessBody, PROCESS_BODY_FLAG, { value: true });
        Object.defineProperty(suiteProcessBody, 'originalProcessBody', { value: current });
        injector.processBody = suiteProcessBody;
        suiteState.processWrapCount += 1;
        suiteState.installed = true;
        suiteState.lastError = null;
        return true;
    }

    function getStatus() {
        const memory = window.YuzukiMemory;
        const detected = detectPreset();
        return { version: VERSION, ...suiteState, installed: suiteState.installed, memoryVersion: memory?.version || null, memoryEnabled: memory?.settingsBridge?.isPluginEnabled?.() !== false, preset: detected, features: { catGod: featureEnabled('catGod', detected), dieGuard: featureEnabled('dieGuard', detected) }, settings: { ...getSettings() }, frameCount: document.querySelectorAll?.(`iframe[id^="${SPRESET_FRAME_PREFIX}"][id*="SPreset"]`).length ?? null };
    }

    function updatePanel(panel) {
        if (!panel) return;
        const detected = detectPreset();
        const settings = getSettings();
        panel.querySelector('[data-ycs-preset]')?.replaceChildren(document.createTextNode(detected.name || '未识别'));
        panel.querySelector('[data-ycs-detected]')?.replaceChildren(document.createTextNode(`自动识别：${detected.catGod ? '小猫之神' : ''}${detected.catGod && detected.dieGuard ? '、' : ''}${detected.dieGuard ? 'DIE' : (!detected.catGod ? '通用' : '')}`));
        panel.querySelectorAll('select[data-ycs-feature]').forEach((select) => { select.value = settings[select.dataset.ycsFeature] || 'auto'; });
        const status = getStatus();
        const statusText = `合集 v${status.version} ${status.installed ? '已连接' : '等待柚月记忆'} · SPreset ${status.frameCount ?? '?'} 个 · 记忆 ${status.memoryVersion || '未加载'}`;
        panel.querySelector('[data-ycs-status]')?.replaceChildren(document.createTextNode(statusText));
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'yuzuki-compat-suite-panel';
        panel.className = 'ycs-panel';
        panel.innerHTML = `<div class="ycs-title"><strong>柚月兼容合集</strong><button type="button" data-ycs-close aria-label="关闭">×</button></div><div class="ycs-current">当前预设：<b data-ycs-preset>未识别</b><small data-ycs-detected>自动识别：通用</small></div><label class="ycs-row"><span>小猫之神预设兼容</span><select data-ycs-feature="catGod"><option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option></select></label><label class="ycs-row"><span>DIE 签名守卫</span><select data-ycs-feature="dieGuard"><option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option></select></label><div class="ycs-status" data-ycs-status></div><div class="ycs-actions"><button type="button" data-ycs-refresh>重新扫描</button><button type="button" data-ycs-diagnose>复制诊断</button></div>`;
        panel.querySelector('[data-ycs-close]').addEventListener('click', () => panel.classList.remove('ycs-open'));
        panel.querySelectorAll('select[data-ycs-feature]').forEach((select) => select.addEventListener('change', () => { getSettings()[select.dataset.ycsFeature] = select.value; persistSettings(); install(); updatePanel(panel); }));
        panel.querySelector('[data-ycs-refresh]').addEventListener('click', () => { scanSPresetFrames(); installMemoryCompat(); updatePanel(panel); notify('已重新扫描兼容状态。'); });
        panel.querySelector('[data-ycs-diagnose]').addEventListener('click', async () => {
            const text = JSON.stringify(getStatus(), null, 2);
            try { await navigator.clipboard?.writeText(text); notify('诊断信息已复制。'); } catch (_error) { console.info(`[${NAMESPACE}]`, text); notify('剪贴板不可用，诊断信息已写入控制台。', 'warning'); }
        });
        return panel;
    }

    function mountMenu() {
        const host = document.getElementById('extensionsMenu');
        if (!host) return false;
        let entry = document.getElementById('yuzuki-compat-suite-entry');
        if (!entry) {
            entry = document.createElement('div');
            entry.id = 'yuzuki-compat-suite-entry';
            entry.className = 'extension_container';
            entry.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" role="button" tabindex="0"><div class="fa-fw fa-solid fa-shield-cat extensionsMenuExtensionButton"></div><span>柚月兼容合集</span></div>';
            const panel = createPanel();
            entry.querySelector('[role="button"]').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); panel.classList.toggle('ycs-open'); updatePanel(panel); });
            entry.querySelector('[role="button"]').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') entry.querySelector('[role="button"]').click(); });
            document.body.appendChild(panel);
        }
        if (entry.parentElement !== host) host.prepend(entry);
        updatePanel(document.getElementById('yuzuki-compat-suite-panel'));
        return true;
    }

    function startMenuMount() {
        if (mountMenu()) return;
        window.clearInterval(menuRetryTimer);
        let attempts = 0;
        menuRetryTimer = window.setInterval(() => { attempts += 1; if (mountMenu() || attempts >= 60) window.clearInterval(menuRetryTimer); }, 500);
    }

    function install() {
        installFrameGuard();
        installMemoryCompat();
        startMenuMount();
        return suiteState.installed;
    }

    window[NAMESPACE] = Object.assign(window[NAMESPACE] || {}, {
        version: VERSION,
        install,
        getStatus,
        detectPreset,
        featureEnabled,
        normalizeRequestBody,
        restoreMissingMessages,
        claimLegacy: () => true,
    });
    console.info('[yuzuki-00-compat-suite] global ready', Object.keys(window[NAMESPACE]));

    if (!install()) {
        let attempts = 0;
        const timer = window.setInterval(() => { attempts += 1; try { if (install() || attempts >= 240) window.clearInterval(timer); } catch (error) { suiteState.lastError = String(error?.message || error); if (attempts >= 240) window.clearInterval(timer); } }, 250);
    }
    window.addEventListener('pageshow', install);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) install(); });
    document.addEventListener('change', (event) => { if (event.target?.matches?.('#settings_preset_openai, #context_presets, #instruct_presets')) { install(); updatePanel(document.getElementById('yuzuki-compat-suite-panel')); } });
    presetPollTimer = window.setInterval(() => { install(); updatePanel(document.getElementById('yuzuki-compat-suite-panel')); }, 1200);
})();

