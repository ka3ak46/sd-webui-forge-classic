(function () {
    "use strict";

    const API = "/forge-quick-presets";
    const PANEL_ID_PREFIX = "forge_quick_presets_panel";
    const PANEL_CLASS = "forge-quick-presets-panel";
    const SPECIAL_TAB_FIELD_IDS = ["img2img_tabs_resize"];
    const PAIRED_FIELD_IDS = {
        txt2img_sampling: "txt2img_scheduler",
        txt2img_scheduler: "txt2img_sampling",
        img2img_sampling: "img2img_scheduler",
        img2img_scheduler: "img2img_sampling",
    };
    const DIMENSION_FIELD_IDS = new Set(["txt2img_width", "txt2img_height", "img2img_width", "img2img_height"]);
    const EXCLUDED_ID_PATTERNS = [
        /^forge_ui_preset$/,
        /^forge_ui_dtype$/,
        /^forge_refresh_checkpoint$/,
        /^setting_sd_model_checkpoint$/,
        /^setting_sd_modules$/,
        /_accordions$/,
        /_tabs$/,
        /_pane$/,
        /_cards_html$/,
        /_extra_tabs$/,
        /-checkbox$/,
        /textual_inversion/i,
        /checkpoints/i,
        /lora_cards/i,
        /lora_pane/i,
        /extra_networks/i,
        /prompt/i,
        /gallery/i,
        /image/i,
        /mask/i,
        /upload/i,
        /button/i,
        /generate/i,
        /interrupt/i,
        /skip/i,
        /token_counter/i,
    ];

    const state = {
        baselines: {},
        appliedFields: {},
        presets: [],
        scriptChoices: { txt2img: ["None"], img2img: ["None"] },
        busy: false,
        mountRetry: null,
        silentDropdownDepth: 0,
        preserveScrollDepth: 0,
        scrollSnapshot: null,
        scrollRestoreToken: null,
        scrollPreserveCanceled: false,
        scrollCancelCleanup: null,
        mountFrame: null,
        themeSyncWired: false,
        themeSyncPending: false,
    };

    function app() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function activeTabName() {
        const tab = app().querySelector("#tabs > .tab-nav > button.selected");
        const text = tab?.textContent?.trim()?.toLowerCase();
        return text && text.includes("img2img") ? "img2img" : "txt2img";
    }

    function activeTabRoot() {
        const name = activeTabName();
        return app().querySelector(`#tab_${name}`) || app().querySelector(`#${name}_interface`) || app();
    }

    function panelId(tab = activeTabName()) {
        return `${PANEL_ID_PREFIX}_${tab}`;
    }

    function currentPanel() {
        return app().querySelector(`#${panelId()}`) || app().querySelector(`.${PANEL_CLASS}`);
    }

    function currentForgePreset() {
        const root = app().querySelector("#forge_ui_preset");
        const input = root?.querySelector("input:not([type='hidden'])");
        const value = input?.value?.trim();
        if (value && value !== "UI Preset") return value;
        return readValue(root) || "";
    }

    function isExcludedRoot(root) {
        const id = root?.id || "";
        if (!id) return true;
        return EXCLUDED_ID_PATTERNS.some((pattern) => pattern.test(id));
    }

    function componentRoots() {
        const root = activeTabRoot();
        const nodes = Array.from(root.querySelectorAll("[id]"));
        const result = [];
        const seen = new Set();

        for (const node of nodes) {
            const id = node.id;
            if (isExcludedRoot(node)) continue;
            if (!node.querySelector("input, textarea, select, button[role='switch']")) continue;
            if (node.closest(`.${PANEL_CLASS}`)) continue;
            if (node.querySelector("input[type='file']")) continue;
            if (node.querySelector("[id] input[type='file']")) continue;
            if (/^component-\d+$/.test(id) && node.closest("[id*='_controlnet_']")) continue;
            if (/^component-\d+$/.test(id) && node.closest("[id*='script']")) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(node);
        }

        return result;
    }

    function labelFor(root) {
        const label = root.querySelector("label, .label-wrap span, .block-label, span[data-testid='block-info']");
        return label?.textContent?.trim()?.replace(/\s+/g, " ") || root.id;
    }

    function gradioComponentConfig(id) {
        const components = window.gradio_config?.components || [];
        return components.find((component) => component?.props?.elem_id === id) || null;
    }

    function choiceLabel(choice) {
        if (Array.isArray(choice)) return `${choice[0]}`;
        if (choice && typeof choice === "object") return `${choice.label ?? choice.value ?? ""}`;
        return `${choice}`;
    }

    function dropdownChoices(root) {
        if (root.id === "script_list") return state.scriptChoices[activeTabName()] || ["None"];
        const config = gradioComponentConfig(root.id);
        return (config?.props?.choices || []).map(choiceLabel).filter(Boolean);
    }

    function normalized(value) {
        if (Array.isArray(value)) return value.map((item) => `${item}`).sort();
        if (value && typeof value === "object") return JSON.stringify(value);
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "string") return value.trim();
        return value;
    }

    function equalValues(a, b) {
        return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
    }

    function readCheckbox(input) {
        return Boolean(input.checked);
    }

    function readNumber(input) {
        const value = input.value;
        if (value === "") return "";
        const parsed = Number(value);
        return Number.isNaN(parsed) ? value : parsed;
    }

    function readRangeSlider(root) {
        const inputs = Array.from(root.querySelectorAll("input[type='range'], input[type='number']"));
        const values = inputs
            .map(readNumber)
            .filter((value) => value !== "" && value !== null && value !== undefined);
        if (values.length >= 2) return values.slice(0, 2);

        const ariaValues = Array.from(root.querySelectorAll("[role='slider'][aria-valuenow]"))
            .map((node) => Number(node.getAttribute("aria-valuenow")))
            .filter((value) => Number.isFinite(value));
        if (ariaValues.length >= 2) return ariaValues.slice(0, 2);

        return null;
    }

    function readDropdown(root) {
        const selected = Array.from(root.querySelectorAll("[data-testid='token'], .token"))
            .map((node) => node.textContent.trim())
            .filter(Boolean)
            .filter((text) => text !== "×");
        if (selected.length > 0) return selected.length === 1 ? selected[0] : selected;

        const input = root.querySelector("input:not([type='hidden'])");
        return input ? input.value : null;
    }

    function radioInputLabel(input) {
        const label = input.closest("label");
        if (label) {
            return label.textContent?.trim()?.replace(/\s+/g, " ") || "";
        }

        const id = input.id;
        if (id) {
            const explicitLabel = rootLabelForInput(id);
            if (explicitLabel) return explicitLabel;
        }

        return input.value || "";
    }

    function rootLabelForInput(id) {
        const escaped = window.CSS?.escape ? CSS.escape(id) : id.replace(/(["\\])/g, "\\$1");
        const label = app().querySelector(`label[for="${escaped}"]`);
        return label?.textContent?.trim()?.replace(/\s+/g, " ") || "";
    }

    function readRadio(root) {
        const checked = root.querySelector("input[type='radio']:checked");
        if (checked) return radioInputLabel(checked);

        const selected = root.querySelector("[role='radio'][aria-checked='true']");
        return selected?.textContent?.trim()?.replace(/\s+/g, " ") || null;
    }

    function isRadioRoot(root) {
        return gradioComponentConfig(root.id)?.type === "radio" || root.classList.contains("gradio-radio");
    }

    function readScriptList(root) {
        const label = readDropdown(root);
        const choices = dropdownChoices(root);
        const index = choices.findIndex((choice) => choice === label);
        return {
            value: label,
            displayValue: label,
            scriptIndex: index >= 0 ? index : null,
        };
    }

    function readValue(root) {
        if (!root) return null;

        if (root.id === "script_list") {
            return readScriptList(root).value;
        }

        if (root.id?.endsWith("_controlnet_control_step_slider")) {
            const rangeValue = readRangeSlider(root);
            if (rangeValue !== null) return rangeValue;
        }

        if (isRadioRoot(root)) {
            const radio = readRadio(root);
            if (radio !== null) return radio;
        }

        const checkbox = root.querySelector("input[type='checkbox']");
        if (checkbox) return readCheckbox(checkbox);

        const number = root.querySelector("input[type='number'], input[data-testid='number-input']");
        if (number) return readNumber(number);

        const range = root.querySelector("input[type='range']");
        if (range) return readNumber(range);

        const textarea = root.querySelector("textarea");
        if (textarea) return textarea.value;

        const select = root.querySelector("select");
        if (select) {
            if (select.multiple) return Array.from(select.selectedOptions).map((option) => option.value);
            return select.value;
        }

        const dropdown = readDropdown(root);
        if (dropdown !== null) return dropdown;

        const input = root.querySelector("input:not([type='hidden'])");
        if (input) return input.value;

        return null;
    }

    function snapshot() {
        const fields = {};
        for (const root of componentRoots()) {
            const value = readValue(root);
            if (value === null || value === undefined) continue;
            const script = root.id === "script_list" ? readScriptList(root) : null;
            const extra = script ? { display_value: script.displayValue, script_index: script.scriptIndex } : {};
            fields[root.id] = {
                id: root.id,
                label: labelFor(root),
                value,
                ...extra,
            };
        }
        addControlNetRangeSliders(fields);
        addSpecialTabFields(fields);
        return fields;
    }

    function addSpecialTabFields(fields) {
        for (const id of SPECIAL_TAB_FIELD_IDS) {
            const root = findComponentById(id);
            if (!root || root.closest(`.${PANEL_CLASS}`)) continue;
            const value = readSelectedTab(root);
            if (!value) continue;
            fields[id] = {
                id,
                label: labelFor(root),
                value,
            };
        }
    }

    function addControlNetRangeSliders(fields) {
        const root = activeTabRoot();
        const sliders = Array.from(root.querySelectorAll("[id$='_controlnet_control_step_slider']"));
        for (const slider of sliders) {
            if (slider.closest(`.${PANEL_CLASS}`)) continue;
            const value = readRangeSlider(slider);
            if (value === null) continue;
            fields[slider.id] = {
                id: slider.id,
                label: labelFor(slider) || "Timestep Range",
                value,
            };
        }
    }

    function changedFields() {
        const tab = activeTabName();
        const current = snapshot();
        const baseline = state.baselines[tab] || {};
        const changed = {};

        for (const [id, field] of Object.entries(current)) {
            if (isControlNetTypeFilterId(id)) continue;
            if (isUnsafeUnstableEnableField(field)) continue;
            if (!isControlNetFieldEnabled(id, current)) continue;
            if (!baseline[id] || !equalValues(field.value, baseline[id].value)) {
                changed[id] = field;
            }
        }

        addPairedChangedFields(changed, current);
        return changed;
    }

    function addPairedChangedFields(changed, current) {
        for (const id of Object.keys(changed)) {
            const pairedId = PAIRED_FIELD_IDS[id];
            if (!pairedId || changed[pairedId] || !current[pairedId]) continue;
            changed[pairedId] = current[pairedId];
        }
    }

    function isControlNetFieldEnabled(id, current) {
        const enableId = controlNetEnableFieldId(id);
        if (!enableId) return true;
        if (id === enableId) return true;
        const enableField = current?.[enableId];
        return !enableField || enableField.value === true;
    }

    function controlNetEnableFieldId(id) {
        if (!id?.includes("_controlnet_")) return null;
        const index = id.lastIndexOf("_controlnet_");
        if (index < 0) return null;
        return `${id.slice(0, index)}_controlnet_enable_checkbox`;
    }

    function setNativeValue(element, value) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
        if (typeof updateInput === "function") updateInput(element);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function setCheckbox(root, value) {
        const input = root.querySelector("input[type='checkbox']");
        if (!input) return false;
        const checked = Boolean(value);
        if (input.checked !== checked) input.click();
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    async function setDropdown(root, value) {
        const input = root.querySelector("input:not([type='hidden'])");
        if (!input) return false;
        const values = Array.isArray(value) ? value : [value];
        if (values.length !== 1) {
            setNativeValue(input, values.join(", "));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            return true;
        }

        const label = `${values[0]}`;
        if (readDropdown(root) === label) {
            wakeDropdown(root, input, label);
            return true;
        }

        beginSilentDropdown();
        try {
            const trigger = root.querySelector("[role='listbox']") || input || root;
            dispatchFullClick(trigger);
            focusWithoutScroll(input);
            await sleep(120);
            setNativeValue(input, label);
            await sleep(120);

            if (isMainSamplerEuler(root, label)) {
                dispatchKeyboard(input, "ArrowDown");
                await sleep(80);
                dispatchKeyboard(input, "Enter");
                return await waitForDropdownValue(root, label);
            }

            const option = findDropdownOption(label);
            if (option) {
                hideDropdownOptionContainer(option);
                dispatchFullClick(option);
                await sleep(250);
                wakeDropdown(root, input, label);
                await sleep(150);
                return readDropdown(root) === label;
            }

            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
            input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
            await sleep(250);
            return readDropdown(root) === label;
        } finally {
            endSilentDropdown();
        }
    }

    function isMainSamplerEuler(root, label) {
        return label === "Euler" && /^(txt2img|img2img)_sampling$/.test(root?.id || "");
    }

    async function waitForDropdownValue(root, label, attempts = 8) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (readDropdown(root) === label) return true;
            await sleep(100);
        }
        return false;
    }

    function beginSilentDropdown() {
        state.silentDropdownDepth += 1;
        document.documentElement.classList.add("fqp-silent-dropdown");
        document.body?.classList.add("fqp-silent-dropdown");
    }

    function endSilentDropdown() {
        state.silentDropdownDepth = Math.max(0, state.silentDropdownDepth - 1);
        if (state.silentDropdownDepth > 0) return;
        document.documentElement.classList.remove("fqp-silent-dropdown");
        document.body?.classList.remove("fqp-silent-dropdown");
    }

    function hideDropdownOptionContainer(option) {
        const container = option.closest("[role='listbox'], .options, .dropdown-options, .select-options, ul");
        if (!container) return;
        container.classList.add("fqp-hidden-dropdown-options");
        window.setTimeout(() => container.classList.remove("fqp-hidden-dropdown-options"), 800);
    }

    function focusWithoutScroll(node) {
        if (!node?.focus) return;
        try {
            node.focus({ preventScroll: true });
        } catch {
            node.focus();
            restoreScrollSoon();
        }
    }

    function captureScrollSnapshot() {
        const roots = [window, document.scrollingElement, document.documentElement, document.body, app()]
            .filter(Boolean);
        const elements = Array.from(app().querySelectorAll("*"))
            .filter((node) => node.scrollTop || node.scrollLeft);

        return {
            windowX: window.scrollX,
            windowY: window.scrollY,
            entries: [...roots, ...elements].map((node) => ({
                node,
                top: node === window ? window.scrollY : node.scrollTop,
                left: node === window ? window.scrollX : node.scrollLeft,
            })),
        };
    }

    function beginPreserveScroll() {
        state.preserveScrollDepth += 1;
        if (!state.scrollSnapshot) {
            state.scrollSnapshot = captureScrollSnapshot();
            state.scrollPreserveCanceled = false;
            state.scrollCancelCleanup = watchUserScrollIntent();
        }
    }

    function endPreserveScroll() {
        state.preserveScrollDepth = Math.max(0, state.preserveScrollDepth - 1);
        restoreScrollSnapshot();
        if (state.preserveScrollDepth === 0) {
            const snapshot = state.scrollSnapshot;
            state.scrollCancelCleanup?.();
            state.scrollCancelCleanup = null;
            if (!state.scrollPreserveCanceled) scheduleFinalScrollRestores(snapshot);
            state.scrollSnapshot = null;
            state.scrollPreserveCanceled = false;
        }
    }

    function watchUserScrollIntent() {
        const cancel = (event) => {
            if (event && event.isTrusted === false) return;
            state.scrollPreserveCanceled = true;
        };

        window.addEventListener("wheel", cancel, { capture: true, passive: true });
        window.addEventListener("touchstart", cancel, { capture: true, passive: true });
        window.addEventListener("pointerdown", cancel, true);
        window.addEventListener("keydown", cancel, true);

        return () => {
            window.removeEventListener("wheel", cancel, true);
            window.removeEventListener("touchstart", cancel, true);
            window.removeEventListener("pointerdown", cancel, true);
            window.removeEventListener("keydown", cancel, true);
        };
    }

    function scheduleFinalScrollRestores(snapshot) {
        if (!snapshot) return;

        const token = { canceled: false };
        state.scrollRestoreToken = token;

        const cancel = (event) => {
            if (event && event.isTrusted === false) return;
            token.canceled = true;
        };
        const cleanup = () => {
            window.removeEventListener("wheel", cancel, true);
            window.removeEventListener("touchstart", cancel, true);
            window.removeEventListener("pointerdown", cancel, true);
            window.removeEventListener("keydown", cancel, true);
            if (state.scrollRestoreToken === token) state.scrollRestoreToken = null;
        };
        const guardedRestore = () => {
            if (!token.canceled) restoreScrollSnapshot(snapshot);
        };

        window.addEventListener("wheel", cancel, { capture: true, passive: true });
        window.addEventListener("touchstart", cancel, { capture: true, passive: true });
        window.addEventListener("pointerdown", cancel, true);
        window.addEventListener("keydown", cancel, true);

        window.setTimeout(guardedRestore, 0);
        window.setTimeout(guardedRestore, 80);
        window.setTimeout(guardedRestore, 180);
        window.setTimeout(cleanup, 260);
    }

    function restoreScrollSoon() {
        if (!state.scrollSnapshot || state.scrollPreserveCanceled) return;
        restoreScrollSnapshot();
        window.setTimeout(() => restoreScrollSnapshot(), 0);
    }

    function restoreScrollSnapshot(snapshot = state.scrollSnapshot) {
        if (!snapshot) return;
        if (snapshot === state.scrollSnapshot && state.scrollPreserveCanceled) return;
        for (const entry of snapshot.entries) {
            if (!entry.node) continue;
            if (entry.node === window) {
                window.scrollTo(entry.left, entry.top);
            } else {
                entry.node.scrollTop = entry.top;
                entry.node.scrollLeft = entry.left;
            }
        }
        window.scrollTo(snapshot.windowX, snapshot.windowY);
    }

    async function setRadio(root, value) {
        const label = `${value}`;
        if (readRadio(root) === label) return true;

        const inputs = Array.from(root.querySelectorAll("input[type='radio']"));
        for (const input of inputs) {
            if (radioInputLabel(input) !== label && input.value !== label) continue;
            dispatchFullClick(input.closest("label") || input);
            await sleep(500);
            return readRadio(root) === label;
        }

        const roleRadios = Array.from(root.querySelectorAll("[role='radio']"));
        const roleRadio = roleRadios.find((node) => node.textContent?.trim()?.replace(/\s+/g, " ") === label);
        if (roleRadio) {
            dispatchFullClick(roleRadio);
            await sleep(500);
            return readRadio(root) === label;
        }

        return false;
    }

    async function setScriptList(root, field) {
        await activateScriptsSection();
        root = findComponentById(field.id) || root;

        let label = scriptFieldLabel(field, root);
        if (!label) return false;

        if (readDropdown(root) === label) return true;

        const input = root.querySelector("input:not([type='hidden'])");
        const listbox = root.querySelector("[role='listbox']");
        const trigger = listbox || root;
        if (!input || !trigger) return await setDropdown(root, label);

        const currentIndex = dropdownChoices(root).findIndex((choice) => choice === label);
        if (currentIndex >= 0 && await keyboardSelectDropdown(root, currentIndex, label)) {
            return true;
        }

        trigger.click();
        await sleep(250);

        const option = findDropdownOption(label);
        if (option) {
            dispatchFullClick(option);
            wakeDropdown(root, input, label);
            return await waitForDropdownValue(root, label, 8);
        }

        trigger.click();
        await sleep(100);
        setNativeValue(input, label);
        focusWithoutScroll(input);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
        return await waitForDropdownValue(root, label, 8);
    }

    async function keyboardSelectDropdown(root, index, label) {
        const choices = dropdownChoices(root);
        const currentLabel = readDropdown(root);
        const startIndex = Math.max(0, choices.findIndex((choice) => choice === currentLabel));
        const downSteps = (index - startIndex + choices.length) % choices.length;
        const upSteps = (startIndex - index + choices.length) % choices.length;
        const key = upSteps < downSteps ? "ArrowUp" : "ArrowDown";
        const steps = Math.min(upSteps, downSteps);

        const listbox = root.querySelector("[role='listbox']");
        const target = listbox || root.querySelector("input:not([type='hidden'])") || root;
        if (!target) return false;

        dispatchFullClick(target);
        focusWithoutScroll(target);
        await sleep(120);

        for (let i = 0; i < steps; i += 1) {
            dispatchKeyboard(target, key);
            await sleep(30);
        }
        dispatchKeyboard(target, "Enter");

        return await waitForDropdownValue(root, label, 12);
    }

    function scriptFieldLabel(field, root = null) {
        if (!field) return "";
        if (field.display_value) return `${field.display_value}`;
        if (typeof field.value === "number") {
            const choices = dropdownChoices(root || findComponentById(field.id));
            return choices[field.value] || "";
        }
        return field.value === null || field.value === undefined ? "" : `${field.value}`;
    }

    function normalizeScriptListField(field) {
        if (field?.id !== "script_list") return field;
        const label = scriptFieldLabel(field);
        if (!label) return field;
        return {
            ...field,
            value: label,
            display_value: field.display_value || label,
        };
    }

    function dispatchKeyboard(target, key) {
        const code = key === " " ? "Space" : key;
        target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true, composed: true }));
    }

    async function activateScriptsSection() {
        const buttons = Array.from(activeTabRoot().querySelectorAll("button"));
        const scriptsButton = buttons.find((button) => button.textContent?.trim() === "Scripts");
        if (!scriptsButton) return;

        if (isScriptsSectionOpen(scriptsButton)) return;

        dispatchFullClick(scriptsButton);
        for (let attempt = 0; attempt < 6; attempt += 1) {
            await sleep(100);
            if (isScriptsSectionOpen(scriptsButton)) return;
        }
    }

    function isScriptsSectionOpen(scriptsButton) {
        const scriptRoot = findComponentById("script_list");
        return isVisible(scriptRoot)
            || scriptsButton.classList.contains("selected")
            || scriptsButton.classList.contains("active")
            || scriptsButton.getAttribute("aria-selected") === "true";
    }

    function wakeDropdown(root, input, label) {
        if (input) {
            setNativeValue(input, label);
        }

        const listbox = root.querySelector("[role='listbox']");
        for (const target of [listbox, root].filter(Boolean)) {
            target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }
    }

    function findDropdownOption(label) {
        const candidates = Array.from(app().querySelectorAll("[role='option'], .options li, .options [data-value], ul li"));
        return candidates.find((node) => node.textContent?.trim() === label);
    }

    function dispatchFullClick(node) {
        for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            node.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, composed: true, view: window }));
        }
        restoreScrollSoon();
    }

    function findComponentById(id) {
        const escaped = window.CSS?.escape ? CSS.escape(id) : id.replace(/(["\\])/g, "\\$1");
        return activeTabRoot().querySelector(`#${escaped}`) || app().getElementById(id);
    }

    function findComponentForField(field) {
        if (isUnsafeUnstableEnableField(field)) return null;
        const exact = findComponentById(field.id);
        if (exact) return exact;
        if (!isUnstableFieldId(field.id)) return null;

        const candidates = componentRoots()
            .filter((root) => labelFor(root) === field.label)
            .filter((root) => sameFieldKind(root, field));

        if (candidates.length === 0) return null;
        return candidates.find(isVisible) || candidates[0];
    }

    function isUnstableFieldId(id) {
        return /^\.?input-accordion-\d+$/.test(id || "") || /^component-\d+$/.test(id || "");
    }

    function isUnsafeUnstableEnableField(field) {
        return isUnstableFieldId(field?.id) && field?.label === "Enable";
    }

    function isUnstableBooleanField(field) {
        return isUnstableFieldId(field?.id) && typeof field?.value === "boolean";
    }

    function sameFieldKind(root, field) {
        if (typeof field.value === "boolean") {
            return Boolean(root.querySelector("input[type='checkbox']"));
        }
        if (typeof field.value === "number") {
            return Boolean(root.querySelector("input[type='number'], input[type='range'], input[data-testid='number-input']"));
        }
        if (typeof field.value === "string") {
            return Boolean(root.querySelector("textarea, select, input:not([type='hidden'])"));
        }
        return true;
    }

    async function activatePanelByLabel(label) {
        if (!label) return false;
        const buttons = Array.from(activeTabRoot().querySelectorAll("button, [role='tab']"));
        const target = buttons.find((button) => button.textContent?.trim()?.replace(/\s+/g, " ") === label);
        if (!target) return false;
        dispatchFullClick(target);
        await sleep(350);
        return true;
    }

    function setRangeSlider(root, value) {
        if (!Array.isArray(value) || value.length < 2) return false;
        const inputs = Array.from(root.querySelectorAll("input[type='range'], input[type='number']"));
        if (inputs.length < 2) return false;

        setNativeValue(inputs[0], value[0]);
        setNativeValue(inputs[1], value[1]);
        return true;
    }

    function readSelectedTab(root) {
        const selected = root.querySelector("button.selected, button[aria-selected='true'], [role='tab'][aria-selected='true'], .tab-nav button.selected");
        return selected?.textContent?.trim()?.replace(/\s+/g, " ") || null;
    }

    async function setSelectedTab(root, value) {
        const label = `${value}`;
        if (readSelectedTab(root) === label) return true;

        const candidates = Array.from(root.querySelectorAll("button, [role='tab']"));
        const target = candidates.find((node) => node.textContent?.trim()?.replace(/\s+/g, " ") === label);
        if (!target) return false;

        dispatchFullClick(target);
        await sleep(250);
        return readSelectedTab(root) === label;
    }

    async function applyField(field) {
        const root = findComponentForField(field);
        if (!root) return await applyMissingUnstableField(field);

        if (SPECIAL_TAB_FIELD_IDS.includes(field.id)) {
            return await setSelectedTab(root, field.value);
        }

        if (isExcludedRoot(root)) return false;

        if (field.id === "script_list") {
            return await setScriptList(root, field);
        }

        if (field.id?.endsWith("_controlnet_control_step_slider")) {
            return setRangeSlider(root, field.value);
        }

        if (isRadioRoot(root)) {
            return await setRadio(root, field.value);
        }

        const checkbox = root.querySelector("input[type='checkbox']");
        if (checkbox) return setCheckbox(root, field.value);

        const textarea = root.querySelector("textarea");
        if (textarea) {
            setNativeValue(textarea, field.value);
            return true;
        }

        const select = root.querySelector("select");
        if (select) {
            if (select.multiple && Array.isArray(field.value)) {
                for (const option of select.options) option.selected = field.value.includes(option.value);
            } else {
                select.value = field.value;
            }
            select.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        const number = root.querySelector("input[type='number'], input[type='range'], input[data-testid='number-input']");
        if (number) {
            setNativeValue(number, field.value);
            return true;
        }

        return await setDropdown(root, field.value);
    }

    async function applyMissingUnstableField(field) {
        if (!isUnstableFieldId(field.id) || isUnsafeUnstableEnableField(field) || field.value !== true) return false;
        return await activatePanelByLabel(field.label);
    }

    async function request(path, options) {
        const response = await fetch(`${API}${path}`, {
            headers: { "Content-Type": "application/json" },
            ...options,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || response.statusText);
        }
        return await response.json();
    }

    function setStatus(text, isError, panel = currentPanel(), options = {}) {
        const status = panel?.querySelector(".fqp-status");
        if (!status) return;
        status.textContent = text || "";
        status.classList.toggle("fqp-error", Boolean(isError));
        status.classList.toggle("fqp-loading", Boolean(options.loading));
    }

    function setPanelBusy(panel = currentPanel(), busy = false) {
        state.busy = Boolean(busy);
        panel?.classList.toggle("fqp-busy", state.busy);
        for (const control of Array.from(panel?.querySelectorAll("select, button") || [])) {
            control.disabled = state.busy;
        }
        if (!state.busy) updateApplyButtonState(panel);
    }

    function selectedPresetKey(panel = currentPanel()) {
        return panel?.querySelector(".fqp-select")?.value || "";
    }

    function setAppliedState(panel = currentPanel(), key = selectedPresetKey(panel)) {
        if (!panel) return;
        panel.dataset.appliedKey = key || "";
        updateApplyButtonState(panel);
    }

    function clearAppliedState(panel = currentPanel()) {
        if (!panel) return;
        delete panel.dataset.appliedKey;
        updateApplyButtonState(panel);
    }

    function updateApplyButtonState(panel = currentPanel()) {
        const button = panel?.querySelector(".fqp-apply");
        if (!button) return;
        const applied = Boolean(panel.dataset.appliedKey && panel.dataset.appliedKey === selectedPresetKey(panel));
        button.disabled = state.busy || applied;
        button.classList.toggle("fqp-applied", applied);
        button.textContent = applied ? "Applied" : "Apply";
        button.title = applied
            ? "This quick preset is already applied. Choose another preset or press Reset to apply again."
            : "Apply the selected quick preset to the current Forge UI.";
    }

    function updatePresetSelect(panel = currentPanel()) {
        const select = panel?.querySelector(".fqp-select");
        if (!select) return;
        const previous = select.value;
        const tab = activeTabName();
        const presets = state.presets.filter((preset) => !preset.tab || preset.tab === tab);
        select.innerHTML = "";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "None";
        select.appendChild(empty);
        for (const preset of presets) {
            const option = document.createElement("option");
            option.value = preset.key || `${preset.tab || tab}::${preset.name}`;
            option.dataset.name = preset.name;
            option.textContent = preset.name;
            select.appendChild(option);
        }
        select.value = previous;
        updateApplyButtonState(panel);
    }

    async function refreshPresets(panel = currentPanel()) {
        try {
            const data = await request("/list");
            state.presets = data.presets || [];
            state.scriptChoices = data.script_choices || state.scriptChoices;
            updatePresetSelect(panel);
        } catch (error) {
            setStatus(`Load failed: ${error.message}`, true, panel);
        }
    }

    async function captureBaseline() {
        const tab = activeTabName();
        const domBaseline = snapshot();
        const forgeBaseline = await forgeConfigBaseline(currentForgePreset(), tab);
        state.baselines[tab] = {
            ...baselineWithoutAppliedPresetFields(domBaseline, tab),
            ...resolveForgeBaselineFields(forgeBaseline, domBaseline),
        };
    }

    function baselineWithoutAppliedPresetFields(baseline, tab) {
        const cleaned = { ...baseline };
        for (const field of state.appliedFields[tab] || []) {
            if (!field?.id || !cleaned[field.id]) continue;
            if (!equalValues(cleaned[field.id].value, field.value)) continue;
            const fallback = fallbackBaselineField(field);
            if (fallback) cleaned[field.id] = fallback;
        }
        return cleaned;
    }

    async function forgeConfigBaseline(preset, tab) {
        if (!preset) return {};
        try {
            const data = await request(`/baseline/${encodeURIComponent(preset)}/${tab}`);
            return data.fields || {};
        } catch {
            return {};
        }
    }

    function resolveForgeBaselineFields(fields, domBaseline) {
        const resolved = {};
        for (const field of Object.values(fields || {})) {
            if (!field?.id) continue;
            const root = findComponentForField(field);
            const id = root?.id || field.id;
            if (!domBaseline[id]) continue;
            resolved[id] = {
                ...domBaseline[id],
                ...field,
                id,
            };
        }
        return resolved;
    }

    async function saveChanged() {
        const panel = currentPanel();
        const fields = changedFields();
        const count = Object.keys(fields).length;
        if (count === 0) {
            setStatus("Nothing changed since baseline.", false);
            return;
        }

        const name = window.prompt("Quick preset name");
        if (!name || !name.trim()) return;

        const tab = activeTabName();
        const cleanName = name.trim();
        const key = `${tab}::${cleanName}`;
        const payload = {
            name: cleanName,
            tab,
            base_preset: currentForgePreset(),
            fields,
        };
        const data = await request("/save", { method: "POST", body: JSON.stringify(payload) });
        state.presets = data.presets || [];
        updatePresetSelect(panel);
        const select = panel?.querySelector(".fqp-select");
        if (select) select.value = key;
        state.appliedFields[tab] = Object.values(fields);
        setAppliedState(panel, key);
        setStatus(`Saved ${count} changed fields.`, false, panel);
    }

    async function updateSelected() {
        const panel = currentPanel();
        const select = panel?.querySelector(".fqp-select");
        const option = select?.selectedOptions?.[0];
        const key = select?.value;
        const name = option?.dataset?.name;
        if (!key || !name) {
            setStatus("Select a preset to update.", true, panel);
            return;
        }

        const fields = changedFields();
        const count = Object.keys(fields).length;
        if (count === 0) {
            setStatus("Nothing changed since baseline.", false, panel);
            return;
        }

        if (!window.confirm(`Update preset "${name}"?`)) return;

        const payload = {
            name,
            tab: activeTabName(),
            base_preset: currentForgePreset(),
            fields,
        };
        const data = await request("/save", { method: "POST", body: JSON.stringify(payload) });
        state.presets = data.presets || [];
        updatePresetSelect(panel);
        select.value = key;
        state.appliedFields[activeTabName()] = Object.values(fields);
        setAppliedState(panel, key);
        setStatus(`Updated ${name} with ${count} fields.`, false, panel);
    }

    async function applySelected() {
        const panel = currentPanel();
        const select = panel?.querySelector(".fqp-select");
        const key = select?.value;
        if (!key || state.busy) return;
        const tab = activeTabName();

        beginPreserveScroll();
        setPanelBusy(panel, true);
        setStatus("Applying preset", false, panel, { loading: true });
        try {
            const preset = await request(`/get/${encodeURIComponent(key)}`);
            let applied = 0;
            const fields = preset.fields || {};
            const rawEntries = await addSourceBaselinePairedEntries(Object.values(fields).map(normalizeScriptListField), preset);
            const entries = enrichPresetFields(rawEntries).filter((field) => !isUnsafeUnstableEnableField(field));
            const nextFieldIds = new Set(entries.map((field) => field.id).filter(Boolean));

            await resetChangedFieldsToBaseline(panel, false, {
                tab,
                preserveIds: nextFieldIds,
                preserveUnstableBooleans: entries.some((field) => field.id === "script_list"),
            });

            const scriptFields = entries.filter((field) => field.id === "script_list");
            const regularFields = orderFieldsForApply(entries.filter((field) => field.id !== "script_list"));

            for (const field of scriptFields) {
                if (await applyField(field)) applied += 1;
            }

            if (scriptFields.length > 0) {
                await waitForScriptFields(regularFields);
            }

            for (const field of regularFields) {
                if (await applyField(field)) applied += 1;
            }
            restoreAspectRatioHelperIfNeeded(regularFields, tab);

            if (scriptFields.length > 0) {
                const scriptRegularFields = regularFields.filter((item) => item.id?.startsWith("script_"));
                await stabilizeScriptFields(scriptRegularFields);
            }

            state.appliedFields[tab] = entries;
            setAppliedState(panel, key);
            setStatus(`Applied ${applied}/${entries.length} fields.`, false, panel);
        } finally {
            setPanelBusy(panel, false);
            endPreserveScroll();
        }
    }

    async function addSourceBaselinePairedEntries(entries, preset) {
        const result = [...entries];
        const ids = new Set(result.map((field) => field?.id).filter(Boolean));
        const missingIds = Object.entries(PAIRED_FIELD_IDS)
            .filter(([id, pairedId]) => ids.has(id) && !ids.has(pairedId))
            .map(([, pairedId]) => pairedId);
        if (missingIds.length === 0 || !preset?.base_preset) return result;

        const sourceBaseline = await forgeConfigBaseline(preset.base_preset, preset.tab || activeTabName());
        for (const id of missingIds) {
            const field = sourceBaseline[id];
            if (!field || ids.has(id)) continue;
            result.push(field);
            ids.add(id);
        }

        return result;
    }

    function enrichPresetFields(entries) {
        const result = entries.filter((field) => !isControlNetTypeFilterId(field?.id));
        const ids = new Set(result.map((field) => field.id).filter(Boolean));

        for (const field of entries) {
            const typeField = controlNetAllTypeField(field);
            if (!typeField || ids.has(typeField.id)) continue;
            result.push(typeField);
            ids.add(typeField.id);
        }

        return result;
    }

    function controlNetAllTypeField(field) {
        const id = field?.id || "";
        const typeId = controlNetTypeFieldId(id);
        if (!typeId) return null;

        return {
            id: typeId,
            label: "Control Type",
            value: "All",
        };
    }

    function isControlNetTypeFilterId(id) {
        return Boolean(id?.endsWith("_controlnet_type_filter_radio"));
    }

    function controlNetTypeFieldId(id) {
        if (id.endsWith("_controlnet_preprocessor_dropdown")) {
            return id.replace("_controlnet_preprocessor_dropdown", "_controlnet_type_filter_radio");
        }
        if (id.endsWith("_controlnet_model_dropdown")) {
            return id.replace("_controlnet_model_dropdown", "_controlnet_type_filter_radio");
        }
        return null;
    }

    function orderFieldsForApply(fields) {
        return [...fields].sort((a, b) => fieldApplyPriority(a) - fieldApplyPriority(b));
    }

    function fieldApplyPriority(field) {
        const id = field?.id || "";
        if (SPECIAL_TAB_FIELD_IDS.includes(id)) return 0;
        if (isUnstableFieldId(id) && field?.label !== "Enable") return 0;
        if (isUnstableFieldId(id) && field?.label === "Enable") return 1;
        if (id.endsWith("_controlnet_type_filter_radio")) return 0;
        if (id.endsWith("_controlnet_preprocessor_dropdown") || id.endsWith("_controlnet_model_dropdown")) return 2;
        return 1;
    }

    async function waitForScriptFields(fields) {
        const scriptFieldIds = fields
            .map((field) => field.id)
            .filter((id) => id?.startsWith("script_"));
        if (scriptFieldIds.length === 0) return;

        for (let attempt = 0; attempt < 20; attempt += 1) {
            const visibleCount = scriptFieldIds
                .map(findComponentById)
                .filter(uiElementReady)
                .length;
            if (visibleCount === scriptFieldIds.length) return;
            await sleep(150);
        }
    }

    async function stabilizeScriptFields(fields) {
        if (fields.length === 0 || fieldsApplied(fields)) return;

        for (const delay of [150, 250, 400, 700, 1000]) {
            await waitForScriptFields(fields);
            if (fieldsApplied(fields)) return;

            for (const field of fields) {
                await applyField(field);
            }
            if (fieldsApplied(fields)) return;

            await sleep(delay);
        }
    }

    function fieldsApplied(fields) {
        return fields.every((field) => {
            const root = findComponentForField(field);
            return root && equalValues(readValue(root), field.value);
        });
    }

    function uiElementReady(node) {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    async function deleteSelected() {
        const panel = currentPanel();
        const select = panel?.querySelector(".fqp-select");
        const key = select?.value;
        const name = select?.selectedOptions?.[0]?.dataset?.name || key;
        if (!key) return;
        if (!window.confirm(`Delete preset "${name}"?`)) return;

        const data = await request(`/delete/${encodeURIComponent(key)}`, { method: "POST" });
        state.presets = data.presets || [];
        clearAppliedState(panel);
        updatePresetSelect(panel);
        setStatus("Preset deleted.", false, panel);
    }

    async function resetToBaseline() {
        const panel = currentPanel();
        if (state.busy) return;
        const tab = activeTabName();
        beginPreserveScroll();
        setPanelBusy(panel, true);
        setStatus("Resetting", false, panel, { loading: true });
        try {
            const result = await resetChangedFieldsToBaseline(panel, true, { tab });
            await deactivateScriptsSectionIfNone();
            const select = panel?.querySelector(".fqp-select");
            if (select) select.value = "";
            clearAppliedState(panel);
            if (result) setStatus(`Reset ${result.applied}/${result.total} changed fields.`, false, panel);
        } finally {
            setPanelBusy(panel, false);
            endPreserveScroll();
        }
    }

    async function resetChangedFieldsToBaseline(panel, showEmptyStatus, options = {}) {
        const tab = options.tab || activeTabName();
        const baseline = state.baselines[tab];
        if (!baseline) {
            if (showEmptyStatus) setStatus("No baseline for this tab yet.", true, panel);
            return null;
        }

        const current = snapshot();
        const priorApplied = state.appliedFields[tab] || [];
        const resetOptions = {
            ...options,
            preserveUnstableBooleans: options.preserveUnstableBooleans || hasScriptResetContext(current, priorApplied),
        };
        const appliedIds = priorApplied.map((field) => field.id).filter(Boolean);
        const candidateIds = new Set(resetOptions.onlyApplied ? appliedIds : [
            ...Object.keys(current),
            ...appliedIds,
        ]);
        const resetFields = [];
        for (const id of candidateIds) {
            if (resetOptions.preserveIds?.has(id)) continue;
            const field = current[id] || priorApplied.find((item) => item.id === id);
            if (!field) continue;
            const priorAppliedField = priorApplied.find((item) => item.id === id);
            const baselineField = fallbackForResetField(field, priorAppliedField, resetOptions)
                || baseline[id]
                || fallbackBaselineFieldForReset(field, priorAppliedField, resetOptions);
            if (!baselineField) continue;
            if (!equalValues(field.value, baselineField.value)) {
                resetFields.push(baselineField);
            }
        }

        const scriptFields = resetFields.filter((field) => field.id === "script_list");
        const regularFields = orderFieldsForApply(resetFields.filter((field) => field.id !== "script_list"));
        let appliedCount = 0;

        for (const field of scriptFields) {
            if (await applyField(field)) appliedCount += 1;
        }

        if (scriptFields.length > 0) {
            await sleep(150);
            await deactivateScriptsSectionIfNone();
        }

        for (const field of regularFields) {
            if (await applyField(field)) appliedCount += 1;
        }
        restoreAspectRatioHelperIfNeeded(regularFields, tab);

        if (showEmptyStatus || resetFields.length > 0) {
            state.appliedFields[tab] = [];
            return { applied: appliedCount, total: resetFields.length };
        }

        return null;
    }

    function hasScriptResetContext(current, priorApplied) {
        return isActiveScriptField(current?.script_list)
            || priorApplied.some((field) => field?.id === "script_list");
    }

    function isActiveScriptField(field) {
        const label = scriptFieldLabel(field);
        return Boolean(label && label !== "None");
    }

    function fallbackForResetField(field, priorAppliedField, options = {}) {
        if (shouldPreserveUnstableBooleanFallback(field, priorAppliedField, options)) {
            return null;
        }
        if (priorAppliedField) return fallbackBaselineField(priorAppliedField);
        if (isUnstableBooleanField(field)) return fallbackBaselineField(field);
        return null;
    }

    function fallbackBaselineFieldForReset(field, priorAppliedField, options = {}) {
        if (shouldPreserveUnstableBooleanFallback(field, priorAppliedField, options)) {
            return null;
        }
        return fallbackBaselineField(field);
    }

    function shouldPreserveUnstableBooleanFallback(field, priorAppliedField, options = {}) {
        return Boolean(options.preserveUnstableBooleans && (isGenericBooleanField(field) || isGenericBooleanField(priorAppliedField)));
    }

    function isGenericBooleanField(field) {
        if (typeof field?.value !== "boolean") return false;
        if (field.id?.includes("_controlnet_enable_checkbox")) return false;
        if ((field.id === "txt2img_enable" || field.id === "img2img_enable") && field.label === "Refiner") return false;
        if (field.id === "txt2img_hr" || field.id === "img2img_hr") return false;
        return true;
    }

    function restoreAspectRatioHelperIfNeeded(fields, tab = activeTabName()) {
        if (!fields.some((field) => DIMENSION_FIELD_IDS.has(field?.id))) return;
        window.setTimeout(() => restoreAspectRatioHelperSelect(tab), 0);
        window.setTimeout(() => restoreAspectRatioHelperSelect(tab), 250);
    }

    function restoreAspectRatioHelperSelect(tab) {
        const select = findComponentById(`${tab}_select_aspect_ratio`);
        if (!select || select.tagName !== "SELECT") return;
        const hasSelection = select.selectedIndex >= 0 && select.value;
        if (hasSelection) return;

        const offOption = Array.from(select.options).find((option) => option.value === "Off" || option.textContent?.trim() === "Off");
        if (!offOption) return;
        select.value = offOption.value || offOption.textContent;
        select.selectedIndex = Array.from(select.options).indexOf(offOption);
        select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fallbackBaselineField(field) {
        if (field.id === "script_list") {
            return { ...field, value: 0, display_value: "None" };
        }

        if (field.id?.includes("_controlnet_enable_checkbox")) {
            return { ...field, value: false };
        }

        if ((field.id === "txt2img_enable" || field.id === "img2img_enable") && field.label === "Refiner") {
            return { ...field, value: false };
        }

        if (field.id === "txt2img_hr" || field.id === "img2img_hr") {
            return { ...field, value: false };
        }

        if (typeof field.value === "boolean") {
            return { ...field, value: false };
        }

        return null;
    }

    async function deactivateScriptsSectionIfNone() {
        const scriptRoot = findComponentById("script_list");
        if (readDropdown(scriptRoot) !== "None") return;

        const buttons = Array.from(activeTabRoot().querySelectorAll("button"));
        const scriptsButton = buttons.find((button) => button.textContent?.trim() === "Scripts");
        if (!scriptsButton) return;

        const isOpen = scriptsButton.classList.contains("selected")
            || scriptsButton.classList.contains("active")
            || scriptsButton.getAttribute("aria-selected") === "true";

        if (isOpen) {
            dispatchFullClick(scriptsButton);
            await sleep(300);
            if (scriptsButton.classList.contains("active") && !scriptsButton.classList.contains("selected")) {
                dispatchFullClick(scriptsButton);
                await sleep(150);
            }
            clearScriptsButtonState(scriptsButton);
            setTimeout(() => finishScriptsButtonDeactivate(scriptsButton), 500);
            setTimeout(() => finishScriptsButtonDeactivate(scriptsButton), 1000);
            setTimeout(() => finishScriptsButtonDeactivate(scriptsButton), 1500);
            scriptsButton.blur();
        }
    }

    function finishScriptsButtonDeactivate(scriptsButton) {
        const isActive = scriptsButton.classList.contains("active");
        const isSelected = scriptsButton.classList.contains("selected");
        const scriptRoot = findComponentById("script_list");
        const scriptIsVisible = isVisible(scriptRoot);
        const scriptIsNone = readDropdown(scriptRoot) === "None";

        if ((isActive && !isSelected) || (scriptIsNone && scriptIsVisible && !isActive && !isSelected)) {
            dispatchFullClick(scriptsButton);
        }
        clearScriptsButtonState(scriptsButton);
    }

    function clearScriptsButtonState(scriptsButton) {
        scriptsButton.classList.remove("selected", "active");
        scriptsButton.removeAttribute("aria-selected");
    }

    function isVisible(node) {
        return Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    }

    function wirePanel(panel) {
        panel.querySelector(".fqp-select").addEventListener("change", () => {
            clearAppliedState(panel);
            setStatus("", false, panel);
            updateApplyButtonState(panel);
            if (selectedPresetKey(panel)) {
                applySelected().catch((error) => setStatus(error.message, true, panel));
            } else {
                resetToBaseline().catch((error) => setStatus(error.message, true, panel));
            }
        });
        panel.querySelector(".fqp-save").addEventListener("click", () => saveChanged().catch((error) => setStatus(error.message, true, panel)));
        panel.querySelector(".fqp-update").addEventListener("click", () => updateSelected().catch((error) => setStatus(error.message, true, panel)));
        panel.querySelector(".fqp-apply").addEventListener("click", () => applySelected().catch((error) => setStatus(error.message, true, panel)));
        panel.querySelector(".fqp-reset").addEventListener("click", () => resetToBaseline().catch((error) => setStatus(error.message, true, panel)));
        panel.querySelector(".fqp-delete").addEventListener("click", () => deleteSelected().catch((error) => setStatus(error.message, true, panel)));
    }

    function buildPanel(tab) {
        const panel = document.createElement("section");
        panel.id = panelId(tab);
        panel.className = PANEL_CLASS;
        panel.dataset.tab = tab;
        panel.innerHTML = `
            <div class="fqp-head">
                <button class="fqp-toggle" type="button" aria-expanded="true" title="Show or hide Forge Quick Presets.">Quick Presets</button>
            </div>
            <div class="fqp-body">
                <div class="fqp-row fqp-preset-row">
                    <select class="fqp-select" aria-label="Quick preset" title="Saved user preset with only changed UI fields."></select>
                    <button class="fqp-apply lg primary gradio-button custom-button" type="button" title="Apply the selected quick preset to the current Forge UI.">Apply</button>
                </div>
                <div class="fqp-row fqp-actions">
                    <button class="fqp-save lg secondary gradio-button custom-button" type="button" title="Save only fields changed since Baseline. Model, VAE, prompts, images and uploads are skipped.">Save Changed</button>
                    <button class="fqp-update lg secondary gradio-button custom-button" type="button" title="Update the selected quick preset with the current changed fields.">Update</button>
                    <button class="fqp-reset lg secondary gradio-button custom-button" type="button" title="Reset changed fields in the current tab back to Baseline without changing the native Forge UI Preset.">Reset</button>
                    <button class="fqp-delete lg secondary gradio-button custom-button" type="button" title="Delete the selected quick preset from the JSON file.">Delete</button>
                </div>
                <div class="fqp-status"></div>
            </div>
        `;
        panel.querySelector(".fqp-toggle").addEventListener("click", () => {
            const body = panel.querySelector(".fqp-body");
            const visible = body.style.display !== "none";
            body.style.display = visible ? "none" : "";
            panel.querySelector(".fqp-toggle").setAttribute("aria-expanded", visible ? "false" : "true");
        });
        wirePanel(panel);
        return panel;
    }

    function findInsertionPoint() {
        const tab = activeTabName();
        const resultsPanel = app().querySelector(`#${tab}_results_panel`);
        if (resultsPanel) {
            const imageButtons = resultsPanel.querySelector(`#image_buttons_${tab}`);
            return {
                parent: resultsPanel,
                after: imageButtons || resultsPanel.querySelector(`#${tab}_gallery_container`),
            };
        }

        const results = app().querySelector(`#${tab}_results`);
        if (results) return { parent: results, after: results.lastElementChild };

        return null;
    }

    function mountPanel() {
        const tab = activeTabName();
        const target = findInsertionPoint();
        if (!target?.parent) return false;

        const existing = app().querySelector(`#${panelId(tab)}`);
        if (existing) {
            let moved = false;
            if (target.after?.parentElement === target.parent && existing.previousElementSibling !== target.after) {
                target.after.insertAdjacentElement("afterend", existing);
                moved = true;
            } else if (!target.after && existing.parentElement !== target.parent) {
                target.parent.appendChild(existing);
                moved = true;
            }

            if (moved || !existing.querySelector(".fqp-select")?.options?.length) {
                updatePresetSelect(existing);
            }
            return true;
        }

        if (!target?.parent) return;
        const panel = buildPanel(tab);
        if (target.after?.parentElement === target.parent) {
            target.after.insertAdjacentElement("afterend", panel);
        } else {
            target.parent.appendChild(panel);
        }
        refreshPresets(panel);
        setTimeout(() => captureBaseline("initial"), 800);
        return true;
    }

    function scheduleMountRetries() {
        if (state.mountRetry !== null) return;

        let attempts = 0;
        state.mountRetry = window.setInterval(() => {
            attempts += 1;
            if (mountPanel() || attempts >= 40) {
                window.clearInterval(state.mountRetry);
                state.mountRetry = null;
            }
        }, 250);
    }

    function scheduleMountPanel() {
        if (state.mountFrame !== null) return;
        state.mountFrame = window.requestAnimationFrame(() => {
            state.mountFrame = null;
            if (!mountPanel()) scheduleMountRetries();
        });
    }

    function watchForgePreset() {
        let last = currentForgePreset();
        window.setInterval(() => {
            const next = currentForgePreset();
            if (next !== last) {
                last = next;
                setTimeout(() => captureBaseline(`Forge ${next || "preset"}`), 900);
            }
        }, 1000);
    }

    function init() {
        if (!mountPanel()) scheduleMountRetries();
        watchForgePreset();
    }

    if (typeof onUiLoaded === "function") {
        onUiLoaded(init);
        onAfterUiUpdate(scheduleMountPanel);
    } else {
        document.addEventListener("DOMContentLoaded", init);
    }
})();
