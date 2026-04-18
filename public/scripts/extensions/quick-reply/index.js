import { chat, chat_metadata, eventSource, event_types, getRequestHeaders, this_chid, characters } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { QuickReplyApi } from './api/QuickReplyApi.js';
import { AutoExecuteHandler } from './src/AutoExecuteHandler.js';
// QuickReply imported lazily inside loadSets to avoid circular TDZ
import { QuickReplyConfig } from './src/QuickReplyConfig.js';
import { QuickReplySet } from './src/QuickReplySet.js';
import { QuickReplySettings } from './src/QuickReplySettings.js';
import { SlashCommandHandler } from './src/SlashCommandHandler.js';
import { ButtonUi } from './src/ui/ButtonUi.js';
import { SettingsUi } from './src/ui/SettingsUi.js';
import { debounceAsync } from '../../utils.js';
import { selected_group } from '../../group-chats.js';
export { debounceAsync };


const _VERBOSE = true;
export const debug = (...msg) => _VERBOSE ? console.debug('[QR2]', ...msg) : null;
export const log = (...msg) => _VERBOSE ? console.log('[QR2]', ...msg) : null;
export const warn = (...msg) => _VERBOSE ? console.warn('[QR2]', ...msg) : null;


const defaultConfig = {
    setList: [{
        set: 'Default',
        isVisible: true,
    }],
};

const defaultSettings = {
    isEnabled: false,
    isCombined: false,
    config: defaultConfig,
};


/** @type {Boolean}*/
let isReady = false;
/** @type {Function[]}*/
let executeQueue = [];
/** @type {string}*/
let lastCharId;
/** @type {QuickReplySettings}*/
let settings;
/** @type {SettingsUi} */
let manager;
/** @type {ButtonUi} */
let buttons;
/** @type {AutoExecuteHandler} */
let autoExec;
/** @type {QuickReplyApi} */
export let quickReplyApi;


const loadSets = async () => {
    // [QR-DEBUG] Race the fetch against a 10s timeout and probe response headers.
    const toast = (m) => { if (typeof toastr !== 'undefined') toastr.info(m, 'QR fetch', { timeOut: 25000 }); console.log('[QR-DEBUG]', m); };
    toast('loadSets: about to fetch /api/settings/get, token=' + (window.token ? 'present' : 'MISSING') + ' len=' + (window.token?.length ?? 0));

    const fetchPromise = fetch('/api/settings/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 10s')), 10000));

    let response;
    try {
        response = await Promise.race([fetchPromise, timeoutPromise]);
        toast(`fetch settled: status=${response.status} ok=${response.ok}`);
    } catch (e) {
        toast(`fetch FAILED: ${e.message}`);
        // Fire a parallel probe with no headers to isolate CSRF issue
        try {
            const probe = await Promise.race([
                fetch('/api/settings/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('probe TIMEOUT 10s')), 10000)),
            ]);
            toast(`noCSRF probe: status=${probe.status}`);
        } catch (pe) {
            toast(`noCSRF probe FAILED: ${pe.message}`);
        }
        throw e;
    }

    if (response.ok) {
        const setList = (await response.json()).quickReplyPresets ?? [];
        for (const set of setList) {
            if (set.version !== 2) {
                // migrate old QR set
                set.version = 2;
                set.disableSend = set.quickActionEnabled ?? false;
                set.placeBeforeInput = set.placeBeforeInputEnabled ?? false;
                set.injectInput = set.AutoInputInject ?? false;
                set.qrList = set.quickReplySlots.map((slot, idx) => {
                    const qr = {};
                    qr.id = idx + 1;
                    qr.label = slot.label ?? '';
                    qr.title = slot.title ?? '';
                    qr.message = slot.mes ?? '';
                    qr.isHidden = slot.hidden ?? false;
                    qr.executeOnStartup = slot.autoExecute_appStartup ?? false;
                    qr.executeOnUser = slot.autoExecute_userMessage ?? false;
                    qr.executeOnAi = slot.autoExecute_botMessage ?? false;
                    qr.executeOnChatChange = slot.autoExecute_chatLoad ?? false;
                    qr.executeOnGroupMemberDraft = slot.autoExecute_groupMemberDraft ?? false;
                    qr.executeOnNewChat = slot.autoExecute_newChat ?? false;
                    qr.executeBeforeGeneration = slot.autoExecute_beforeGeneration ?? false;
                    qr.automationId = slot.automationId ?? '';
                    qr.contextList = (slot.contextMenu ?? []).map(it => ({
                        set: it.preset,
                        isChained: it.chain,
                    }));
                    return qr;
                });
            }
            if (set.version == 2) {
                QuickReplySet.list.push(QuickReplySet.from(JSON.parse(JSON.stringify(set))));
            }
        }
        // need to load QR lists after all sets are loaded to be able to resolve context menu entries
        const { QuickReply } = await import('./src/QuickReply.js');
        setList.forEach((set, idx) => {
            QuickReplySet.list[idx].qrList = set.qrList.map(it => QuickReply.from(it));
            QuickReplySet.list[idx].init();
        });
        log('sets: ', QuickReplySet.list);
    }
};

const loadSettings = async () => {
    if (!extension_settings.quickReplyV2) {
        if (!extension_settings.quickReply) {
            extension_settings.quickReplyV2 = defaultSettings;
        } else {
            extension_settings.quickReplyV2 = {
                isEnabled: extension_settings.quickReply.quickReplyEnabled ?? false,
                isCombined: false,
                isPopout: false,
                config: {
                    setList: [{
                        set: extension_settings.quickReply.selectedPreset ?? extension_settings.quickReply.name ?? 'Default',
                        isVisible: true,
                    }],
                },
            };
        }
    }
    try {
        settings = QuickReplySettings.from(extension_settings.quickReplyV2);
        settings.config.scope = 'global';
        settings.config.onUpdate = () => settings.save();
    } catch (ex) {
        settings = QuickReplySettings.from(defaultSettings);
    }
};

const executeIfReadyElseQueue = async (functionToCall, args) => {
    if (isReady) {
        log('calling', { functionToCall, args });
        await functionToCall(...args);
    } else {
        log('queueing', { functionToCall, args });
        executeQueue.push(async () => await functionToCall(...args));
    }
};

const handleCharChange = () => {
    if (lastCharId === this_chid) return;

    // Unload the old character's config and update the character ID cache.
    settings.charConfig = null;
    lastCharId = this_chid;

    // If no character is loaded, there's nothing more to do.
    /** @type {Character} */
    const character = characters[this_chid];
    if (!character || selected_group) {
        return;
    }

    // Get the character-specific config from the local settings storage.
    let charConfig = settings.characterConfigs[character.avatar];

    // If no config exists for this character, create a new one.
    if (!charConfig) {
        charConfig = QuickReplyConfig.from({ setList: [] });
        settings.characterConfigs[character.avatar] = charConfig;
    }

    charConfig.scope = 'character';
    // The main settings save function will handle persistence.
    charConfig.onUpdate = () => settings.save();
    settings.charConfig = charConfig;
};

const init = async () => {
    // [QR-DEBUG] Per-step toasts to isolate where init hangs.
    const dbg = (msg) => {
        console.log('[QR-DEBUG]', msg);
        if (typeof toastr !== 'undefined') toastr.info(msg, 'QR step', { timeOut: 20000 });
    };
    dbg('step1: await loadSets()');
    await loadSets();
    dbg('step2: await loadSettings()');
    await loadSettings();
    dbg('step3: new SettingsUi(settings)');
    log('settings: ', settings);

    manager = new SettingsUi(settings);
    dbg('step4: querySelector(#qr_container)');
    const qrContainer = document.querySelector('#qr_container');
    dbg(`step4b: qrContainer=${!!qrContainer}, isConnected=${qrContainer?.isConnected}`);
    dbg('step5: await manager.render()');
    const rendered = await manager.render();
    dbg(`step5b: rendered=${!!rendered}`);
    dbg('step6: container.append(rendered)');
    qrContainer.append(rendered);
    dbg('step7: new ButtonUi(settings)');

    buttons = new ButtonUi(settings);
    dbg('step8: buttons.show()');
    buttons.show();
    dbg('step9: onSave bound');
    settings.onSave = () => buttons.refresh();

    globalThis.executeQuickReplyByName = async (name, args = {}, options = {}) => {
        let qr = [
            ...settings.config.setList,
            ...(settings.chatConfig?.setList ?? []),
            ...(settings.charConfig?.setList ?? []),
        ]
            .map(it => it.set.qrList)
            .flat()
            .find(it => it.label == name)
            ;
        if (!qr) {
            let [setName, ...qrName] = name.split('.');
            qrName = qrName.join('.');
            let qrs = QuickReplySet.get(setName);
            if (qrs) {
                qr = qrs.qrList.find(it => it.label == qrName);
            }
        }
        if (qr && qr.onExecute) {
            return await qr.execute(args, false, true, options);
        } else {
            throw new Error(`No Quick Reply found for "${name}".`);
        }
    };

    quickReplyApi = new QuickReplyApi(settings, manager);
    const slash = new SlashCommandHandler(quickReplyApi);
    slash.init();
    autoExec = new AutoExecuteHandler(settings);

    eventSource.on(event_types.APP_READY, async () => await finalizeInit());

    globalThis.quickReplyApi = quickReplyApi;
};
const finalizeInit = async () => {
    debug('executing startup');
    await autoExec.handleStartup();
    debug('/executing startup');

    debug(`executing queue (${executeQueue.length} items)`);
    while (executeQueue.length > 0) {
        const func = executeQueue.shift();
        await func();
    }
    debug('/executing queue');
    isReady = true;
    debug('READY');
};
// [QR-DEBUG] Surface init failures + disabled state as user-visible toasts.
try {
    const isDisabled = (await import('../../extensions.js')).extension_settings?.disabledExtensions?.includes?.('quick-reply');
    if (typeof toastr !== 'undefined') {
        toastr.info(`QR debug: disabled=${isDisabled}, container=${!!document.querySelector('#qr_container')}`, 'Quick Reply diag', { timeOut: 15000 });
    }
    await init();
    if (typeof toastr !== 'undefined') {
        toastr.success('Quick Reply init completed successfully', 'Quick Reply diag', { timeOut: 10000 });
    }
} catch (e) {
    console.error('[QR-DEBUG] init threw:', e);
    if (typeof toastr !== 'undefined') {
        toastr.error(`QR init error: ${e?.message || e}`, 'Quick Reply FAIL', { timeOut: 30000, extendedTimeOut: 30000 });
    }
    throw e;
}

const purgeCharacterQuickReplySets = ({ character }) => {
    // Remove the character's Quick Reply Sets from the settings.
    const avatar = character?.avatar;
    if (avatar && avatar in settings.characterConfigs) {
        log(`Purging Quick Reply Sets for character: ${avatar}`);
        delete settings.characterConfigs[avatar];
        settings.save();
    }
};

const updateCharacterQuickReplySets = (oldAvatar, newAvatar) => {
    // Update the character's Quick Reply Sets in the settings.
    if (oldAvatar && newAvatar && oldAvatar !== newAvatar) {
        log(`Updating Quick Reply Sets for character: ${oldAvatar} -> ${newAvatar}`);
        if (settings.characterConfigs[oldAvatar]) {
            settings.characterConfigs[newAvatar] = settings.characterConfigs[oldAvatar];
            delete settings.characterConfigs[oldAvatar];
            settings.save();
        }
    }
};

const onChatChanged = async (chatIdx) => {
    log('CHAT_CHANGED', chatIdx);

    handleCharChange();

    if (chatIdx) {
        const chatConfig = QuickReplyConfig.from(chat_metadata.quickReply ?? {});
        chatConfig.scope = 'chat';
        chatConfig.onUpdate = () => settings.save();
        settings.chatConfig = chatConfig;
    } else {
        settings.chatConfig = null;
    }
    manager.rerender();
    buttons.refresh();

    await autoExec.handleChatChanged();
};
eventSource.on(event_types.CHAT_CHANGED, (...args) => executeIfReadyElseQueue(onChatChanged, args));
eventSource.on(event_types.CHARACTER_DELETED, purgeCharacterQuickReplySets);
eventSource.on(event_types.CHARACTER_RENAMED, updateCharacterQuickReplySets);

const onUserMessage = async () => {
    await autoExec.handleUser();
};
eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, (...args) => executeIfReadyElseQueue(onUserMessage, args));

const onAiMessage = async (messageId) => {
    if (['...'].includes(chat[messageId]?.mes)) {
        log('QR auto-execution suppressed for swiped message');
        return;
    }

    await autoExec.handleAi();
};
eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, (...args) => executeIfReadyElseQueue(onAiMessage, args));

const onGroupMemberDraft = async () => {
    await autoExec.handleGroupMemberDraft();
};
eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (...args) => executeIfReadyElseQueue(onGroupMemberDraft, args));

const onWIActivation = async (entries) => {
    await autoExec.handleWIActivation(entries);
};
eventSource.on(event_types.WORLD_INFO_ACTIVATED, (...args) => executeIfReadyElseQueue(onWIActivation, args));

const onNewChat = async () => {
    await autoExec.handleNewChat();
};
eventSource.on(event_types.CHAT_CREATED, (...args) => executeIfReadyElseQueue(onNewChat, args));
eventSource.on(event_types.GROUP_CHAT_CREATED, (...args) => executeIfReadyElseQueue(onNewChat, args));

const onBeforeGeneration = async (_generationType, _options = {}, isDryRun = false) => {
    if (isDryRun) {
        log('Before-generation hook skipped due to dryRun.');
        return;
    }
    if (selected_group && this_chid === undefined) {
        log('Before-generation hook skipped for event before group wrapper.');
        return;
    }
    await autoExec.handleBeforeGeneration();
};
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (...args) => executeIfReadyElseQueue(onBeforeGeneration, args));
