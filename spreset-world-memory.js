const ANCHOR = /\{\{\s*(?:VECTOR_MEMORY|MEMORY(?:_PROMPT|\s*_(?:TABLE|SUMMARY)(?:\s*_[^{}]+)?)?)\s*\}\}/gi;
const WORLD_FIELDS = ['activated_info', 'd0_injections', 'activated_rules', 'live_world_state', 'live_d0_directives'];
const READY_WRAPPED = Symbol.for('yuzuki.compat-suite.spreset.prompt-ready');

export function isPackedWorld(messages) {
    return Array.isArray(messages) && messages.some(message =>
        message?.role === 'tool' && message.tool_call_id === 'call_init_context_00' &&
        message.name === 'context' && typeof message.content === 'string' &&
        message.content.startsWith('SoliUmbra World Context Registry.'));
}

// In the registry SPreset embeds the contents of a JSON string, including escaped
// line breaks. In turn deltas it emits a complete JSON object with named fields.
function mapWorldText(message, transform) {
    if (typeof message.content !== 'string') return message.content;
    if (message.tool_call_id === 'call_init_context_00' && message.name === 'context') {
        // The archived story and player input share the registry with the world book.
        const sections = message.content.split(/(\\n【(?:初始常驻世界书基线|常驻深层世界书设定 \(@D1\+\)|深层指令与设定 \(@D0\)|前情场记状态归档)】：\\n)/);
        for (let i = 0; i < sections.length; i += 2) {
            if (i && sections[i - 1].includes('前情场记状态归档')) continue;
            sections[i] = transform(sections[i], true);
        }
        return sections.join('');
    }
    if (message.name !== 'context' && message.name !== 'soliumbra_reply') return message.content;
    let payload;
    try { payload = JSON.parse(message.content); } catch { return message.content; }
    let changed = false;
    for (const key of WORLD_FIELDS) {
        if (!Array.isArray(payload?.[key])) continue;
        payload[key] = payload[key].map(value => {
            if (typeof value !== 'string') return value;
            const resolved = transform(value, false);
            if (resolved !== value) changed = true;
            return resolved;
        });
    }
    return changed ? JSON.stringify(payload) : message.content;
}

export function installPackedPromptReady(memory, enabled) {
    const ready = memory?.PromptReadyInjector;
    const original = ready?.processPromptReadyChatSync;
    if (typeof original !== 'function' || original[READY_WRAPPED]) return;
    const wrapped = function (chat, options) {
        // RequestProbe calls VariableInjector next. Running the legacy splitter
        // on a packed tool result here irreversibly destroys its single envelope.
        if (enabled() && isPackedWorld(chat)) return chat;
        return original.call(this, chat, options);
    };
    wrapped[READY_WRAPPED] = true;
    ready.processPromptReadyChatSync = wrapped;
}

export async function processPackedWorld(inject, body, options) {
    const slots = [];
    const toolMessages = new Map();
    const responseSlots = new Map();
    const projection = [];
    const messages = body.messages.map(message => {
        if (message?.role !== 'tool' && !(message?.role === 'assistant' && message.tool_calls?.length)) return message;
        // Yuzuki 1.1.10 drops textless calls and splits results on anchors. Keep
        // the actual tool envelopes out of its text traversal, including arguments.
        const shell = { role: message.role, content: '[SPreset]' };
        toolMessages.set(shell, message);
        if (message.role !== 'tool') return shell;
        const localSlots = [];
        mapWorldText(message, text => {
            // Preserve the injector's existing-memory checks on a second pass.
            if (text.includes('【系统检索到的历史记忆片段】')) shell.isYuzukiVector = true;
            if (/【(?:当前世界状态参考|记忆只读数据库)\s*-/.test(text)) shell.isGaigaiData = true;
            for (const [token] of text.matchAll(ANCHOR)) {
                const slot = { token, blocks: [] };
                localSlots.push(slot);
                projection.push({ role: 'system', content: '[SPreset]', slotIndex: slots.length },
                    { role: 'system', content: token });
                slots.push(slot);
            }
            return text;
        });
        if (localSlots.length) responseSlots.set(shell, localSlots);
        return shell;
    });

    // All anchors in one native pass so a named table is reserved before a
    // generic table, even when the two slots belong to different tool results.
    const work = { ...body, messages, chat: projection };
    const nativeOptions = { ...options, preserveUnresolvedVectorAnchors: false };
    if (typeof options.getVectorText === 'function') nativeOptions.getVectorText = () => options.getVectorText(body);
    const processed = await inject(work, nativeOptions);
    const result = processed || work;
    let slot;
    const movedIds = new Set();
    function injectionKey(message) {
        if (message.yzmMemoryTableId) return 'table:' + message.yzmMemoryTableId;
        if (message.yzmMemorySummaryId) return 'summary:' + message.yzmMemorySummaryId;
        return message.yzmMemoryInjectionType;
    }
    for (const item of result.chat) {
        if (Number.isInteger(item.slotIndex)) {
            slot = slots[item.slotIndex];
        } else if (slot && item.yzmMemoryInjectionType && typeof item.content === 'string') {
            slot.blocks.push(item.content);
            movedIds.add(injectionKey(item));
        }
    }
    // A prompt-ready pass may have already recalled the vector. The native
    // injector skips lookup when it sees that marked message.
    const vectorSlot = slots.find(s => /^\{\{\s*VECTOR_MEMORY\s*\}\}$/i.test(s.token));
    const existingVector = result.messages.find(m => m.role === 'system' && m.yzmMemoryInjectionType === 'vector');
    if (vectorSlot && !vectorSlot.blocks.length && existingVector && options.disableVectorInjection !== true) {
        vectorSlot.blocks.push(existingVector.content);
        movedIds.add('vector');
    }
    const placed = result.messages.filter(m => !(m.role === 'system' && m.yzmMemoryInjectionType && movedIds.has(injectionKey(m)))).map(m => {
        const original = toolMessages.get(m);
        if (!original) return m;
        const localSlots = responseSlots.get(m);
        if (!localSlots) return original;
        let next = 0;
        const content = mapWorldText(original, (text, escaped) => text.replace(ANCHOR, () => {
            const data = localSlots[next++].blocks.join('\n\n');
            return escaped ? JSON.stringify(data).slice(1, -1) : data;
        }));
        return content === original.content ? original : { ...original, content };
    });
    body.messages.splice(0, body.messages.length, ...placed);
    return body;
}
