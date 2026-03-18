/**
 * @fileoverview Step Transformation Utility
 * @description Transforms raw recorded browser actions to UITestStep format
 * @version 1.1.0
 * @author ACEVIN Team
 *
 * Cleanup pipeline (9 passes):
 *   1. Transform raw actions → UITestSteps (skips hover, focus, blur)
 *   2. Remove phantom (0,0) coordinate events
 *   3. Remove empty / whitespace-only fill actions
 *   4. Squash redundant sequential fill/type on same selector (keep last)
 *   5. Remove redundant focus steps when followed by click/fill on same element
 *   6. Remove redundant click-on-input when sandwiched by focus + fill
 *   7. Clean soft navigations (hash/query-only URL changes)
 *   8. Remove redundant URL assertions that duplicate a preceding navigate
 *   9. Reorder to sequential 0-indexed order numbers
 */

import {
    UITestStep,
    SelectorConfig,
    PlaywrightActionType,
    SelectorStrategy,
    StepMetadata,
    AssertionType,
    ComparisonOperator,
} from '../types/ui-test.types';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Raw recorded action from browser events
 */
export interface RecordedAction {
    id: string;
    type: string;
    timestamp: number;
    /** Either a raw CSS string (legacy) or a signals object from collectSelectorSignals */
    selector: string | {
        tag: string;
        id: string | null;
        text: string | null;
        attributes: {
            name: string | null;
            type: string | null;
            role: string | null;
            placeholder: string | null;
            ariaLabel: string | null;
        };
        testId: string | null;
        position: number;
        xpath: string;
    };
    selectors?: {
        css?: string;
        xpath?: string;
        dataTestId?: string;
        text?: string;
        role?: string;
        label?: string;
        placeholder?: string;
        testId?: string;
    };
    value?: unknown;
    url?: string;
    url_current?: string;
    coordinates?: { x: number; y: number };
    element?: {
        tagName: string;
        text?: string;
        attributes?: Record<string, unknown>;
    };
    key?: string;
    keyCode?: number;
    modifiers?: {
        ctrl?: boolean;
        shift?: boolean;
        alt?: boolean;
        meta?: boolean;
    };
    viewport?: { width: number; height: number };
    scrollPosition?: {
        type: string;
        x: number;
        y: number;
        selector?: string;
    };
    assertionType?: string;
    expected?: unknown;
    description?: string;
    waitCondition?: string;
    /** Structured selected options from native <select> */
    selectedOptions?: { value: string; text: string }[];
    /** Sub-type for form controls: 'checkbox' | 'radio' */
    inputType?: string;
    /** Associated label text for form controls */
    label?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Action type mapping from recording types to Playwright action types
 */
const ACTION_TYPE_MAP: Record<string, PlaywrightActionType> = {
    navigate: 'navigate',
    click: 'click',
    dblclick: 'dblclick',
    type: 'fill',       // Use fill for stable playback
    input: 'fill',       // Alias for type
    keypress: 'press',      // Special keys only
    select: 'select',
    check: 'check',
    uncheck: 'uncheck',
    hover: 'hover',
    focus: 'focus',
    blur: 'blur',
    scroll: 'scroll',
    scrollTo: 'scrollTo',
    scrollBy: 'scrollBy',
    upload: 'upload',
    clear: 'clear',
    reload: 'reload',
    goBack: 'goBack',
    goForward: 'goForward',
    assert: 'assert',
    wait: 'wait',
};

/**
 * Actions skipped during transform.
 * Modern automation frameworks handle hover/focus/blur natively.
 */
const SKIPPABLE_ACTIONS = new Set([
    'blur', 'hover', 'focus', 'mouseover', 'mouseenter', 'mouseleave',
]);

/**
 * Special keys that trigger a 'press' step.
 * Regular character keypresses are handled by fill/type events.
 */
const SPECIAL_KEYS = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
    'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// ─── ID Generation ────────────────────────────────────────────────────────────

/**
 * Monotonic counter ensures unique IDs even within the same millisecond.
 * FIX: Replaced Date.now() + Math.random() which had collision risk under load.
 */
let _stepCounter = 0;

function generateStepId(): string {
    return `step_${++_stepCounter}_${Date.now().toString(36)}`;
}

/** Reset counter (useful in tests to get deterministic IDs) */
export function resetStepIdCounter(): void {
    _stepCounter = 0;
}

// ─── Selector Building ────────────────────────────────────────────────────────

/**
 * Build selector config from raw selector and element metadata.
 *
 * Priority: testId > placeholder > label > text (< 50 chars) > css > xpath
 * Semantic selectors survive DOM restructures far better than positional ones.
 */
export function buildSelectorConfig1(
    rawSelector: string,
    selectors?: RecordedAction['selectors'],
    element?: RecordedAction['element'],
    strict = true,
): SelectorConfig {
    const fallbacks: { strategy: SelectorStrategy; value: string }[] = [];

    let primaryStrategy: SelectorStrategy = 'css';
    let primaryValue = rawSelector || '';

    const attrs = element?.attributes ?? {};

    // 1. data-testid — most reliable, survives any DOM restructure
    const testIdVal = selectors?.dataTestId ?? (attrs['data-testid'] as string | undefined);
    if (testIdVal) {
        primaryStrategy = 'testId';
        primaryValue = testIdVal;
    }
    // primary strategy should be role
    else if (
        element?.tagName === 'button' &&
        selectors?.text
    ) {
        primaryStrategy = 'role';
        primaryValue = 'button';
        return {
            strategy: 'role',
            value: 'button',
            // name: selectors.text,
            fallbacks: [],
            strict,
        };
    }
    // 2. placeholder — reliable for input fields
    else if (selectors?.placeholder ?? attrs['placeholder']) {
        primaryStrategy = 'placeholder';
        primaryValue = (selectors?.placeholder ?? attrs['placeholder'] ?? '') as string;
    }
    // 3. aria-label / label — reliable for form elements
    else if (selectors?.label ?? attrs['aria-label']) {
        primaryStrategy = 'label';
        primaryValue = (selectors?.label ?? attrs['aria-label'] ?? '') as string;
    }
    // 4. Short unique text — suitable for buttons and links
    else if (selectors?.text && selectors.text.length < 50) {
        primaryStrategy = 'text';
        primaryValue = selectors.text;
    }
    // 5. CSS selector from recording
    else if (rawSelector && !rawSelector.startsWith('/')) {
        primaryStrategy = 'css';
        primaryValue = rawSelector;
    }
    // 6. XPath as last resort
    else {
        const xpathValue = selectors?.xpath ?? (rawSelector?.startsWith('/') ? rawSelector : null);
        if (xpathValue) {
            primaryStrategy = 'xpath';
            primaryValue = xpathValue;
        }
    }

    // Track used values to prevent duplicate fallbacks
    const usedValues = new Set<string>([primaryValue]);

    const addFallback = (strategy: SelectorStrategy, value: string) => {
        if (value && !usedValues.has(value)) {
            fallbacks.push({ strategy, value });
            usedValues.add(value);
        }
    };

    // Push CSS as fallback if it wasn't chosen as primary
    if (rawSelector && primaryStrategy !== 'css' && !rawSelector.startsWith('/')) {
        addFallback('css', rawSelector);
    }

    if (selectors) {
        if (selectors.xpath) addFallback('xpath', selectors.xpath);
        if (selectors.dataTestId) addFallback('testId', selectors.dataTestId);
        if (selectors.placeholder) addFallback('placeholder', selectors.placeholder);
        if (selectors.label) addFallback('label', selectors.label);
        if (selectors.text && selectors.text.length < 50) addFallback('text', selectors.text);
        if (selectors.role) addFallback('role', selectors.role);
    }

    // Extract additional fallbacks from element attributes
    const attrTestId = attrs['data-testid'] as string | undefined;
    const attrPh = attrs['placeholder'] as string | undefined;
    const attrLabel = attrs['aria-label'] as string | undefined;
    if (attrTestId) addFallback('testId', attrTestId);
    if (attrPh) addFallback('placeholder', attrPh);
    if (attrLabel) addFallback('label', attrLabel);

    return {
        strategy: primaryStrategy,
        value: primaryValue,
        fallbacks: fallbacks.slice(0, 3),
        strict,
    };
}
function getElementIndex(el: Element): number {
    if (!el.parentElement) return 0;
    return Array.from(el.parentElement.children).indexOf(el);
}

function inferRole(el: HTMLElement): string | null {
    const tag = el.tagName.toLowerCase();

    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
        const type = el.getAttribute('type');
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
    }

    return null;
}
export function collectSelectorSignals(element: Element) {
    const el = element as HTMLElement;

    return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        text: el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 50) || null,

        attributes: {
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            role: el.getAttribute('role') || inferRole(el), // 🔥 NEW
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
        },

        testId:
            el.getAttribute('data-testid') ||
            el.getAttribute('data-test-id') ||
            el.getAttribute('data-cy') ||
            el.getAttribute('data-e2e'),

        // 🔥 NEW (important for uniqueness later)
        position: getElementIndex(el),

        xpath: generateXPathSelector(element),
    };
}


function generateXPathSelector(element: Element): string {
    if ((element as HTMLElement).id) return `//*[@id="${(element as HTMLElement).id}"]`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let index = 1;
        let sibling = current.previousSibling;
        while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE && (sibling as Element).tagName === current.tagName) index++;
            sibling = sibling.previousSibling;
        }
        parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
        current = current.parentElement;
    }
    return '/' + parts.join('/');
}

function buildCleanCssFromSignals(signals: any): string {
    const { tag, attributes } = signals;

    if (attributes?.type) return `${tag}[type="${attributes.type}"]`;
    if (attributes?.name) return `${tag}[name="${attributes.name}"]`;

    return tag;
}
export function buildSelectorConfig(

    signals: ReturnType<typeof collectSelectorSignals>,
    strict = true
): SelectorConfig {

    const fallbacks: { strategy: SelectorStrategy; value: string }[] = [];
    const used = new Set<string>();

    const add = (strategy: SelectorStrategy, value?: string | null) => {
        if (!value || used.has(value)) return;
        fallbacks.push({ strategy, value });
        used.add(value);
    };

    let primary: SelectorConfig = {
        strategy: 'css',
        value: '',
        fallbacks: [],
        strict,
    };

    // 🔥 1. testId (BEST)
    if (signals.testId) {
        primary = { strategy: 'testId', value: signals.testId, fallbacks: [], strict };
    }

    // 🔥 2. Role + Text (BEST FOR BUTTONS)
    else if (
        signals.tag === 'button' &&
        signals.text
    ) {
        primary = {
            strategy: 'role',
            value: 'button',
            // name: signals.text,
            fallbacks: [],
            strict,
        };
    }

    // 🔥 3. Input name
    else if (signals.tag === 'input' && signals.attributes.name) {
        primary = {
            strategy: 'css',
            value: `input[name="${signals.attributes.name}"]`,
            fallbacks: [],
            strict,
        };
    }

    // 🔥 4. Button type
    else if (signals.tag === 'button' && signals.attributes.type) {
        primary = {
            strategy: 'css',
            value: `button[type="${signals.attributes.type}"]`,
            fallbacks: [],
            strict,
        };
    }

    // 🔥 5. Placeholder
    else if (signals.attributes.placeholder) {
        primary = {
            strategy: 'placeholder',
            value: signals.attributes.placeholder,
            fallbacks: [],
            strict,
        };
    }

    // 🔥 6. aria-label
    else if (signals.attributes.ariaLabel) {
        primary = {
            strategy: 'label',
            value: signals.attributes.ariaLabel,
            fallbacks: [],
            strict,
        };
    }

    // 🔥 7. Clean CSS
    else {
        const css = buildCleanCssFromSignals(signals);
        primary = { strategy: 'css', value: css, fallbacks: [], strict };
    }

    // ---------- FALLBACKS ----------

    add('css', buildCleanCssFromSignals(signals));
    add('text', signals.text);
    add('xpath', signals.xpath);
    add('testId', signals.testId);
    add('label', signals.attributes.ariaLabel);

    primary.fallbacks = fallbacks.slice(0, 3);

    return primary;
}

export function buildSelectorConfigFromSignals(
    signals?: any,
    selectors?: RecordedAction['selectors'],
    element?: RecordedAction['element'],
    strict = true,
): SelectorConfig {
    const fallbacks: { strategy: SelectorStrategy; value: string }[] = [];
    let strategy: SelectorStrategy = 'css';
    let value = '';

    const used = new Set<string>();

    const addFallback = (s: SelectorStrategy, v?: string) => {
        if (v && !used.has(v)) {
            fallbacks.push({ strategy: s, value: v });
            used.add(v);
        }
    };

    // 🔥 PRIORITY ORDER (VERY IMPORTANT)

    // 1. testId (most stable)
    if (signals?.testId) {
        strategy = 'testId';
        value = signals.testId;
    }

    // 2. role + text (Playwright best practice)
    else if (signals?.attributes?.role && signals?.text) {
        strategy = 'role';
        value = signals.attributes.role;

        addFallback('text', signals.text);
    }

    // 3. label / aria-label
    else if (signals?.attributes?.ariaLabel) {
        strategy = 'label';
        value = signals.attributes.ariaLabel;
    }

    // 4. placeholder (inputs)
    else if (signals?.attributes?.placeholder) {
        strategy = 'placeholder';
        value = signals.attributes.placeholder;
    }

    // 5. name attribute
    else if (signals?.attributes?.name) {
        strategy = 'css';
        value = `${signals.tag}[name="${signals.attributes.name}"]`;
    }

    // 6. visible text (buttons/links)
    else if (signals?.text) {
        strategy = 'text';
        value = signals.text;
    }

    // 7. fallback to xpath
    else if (signals?.xpath) {
        strategy = 'xpath';
        value = signals.xpath;
    }

    // 8. LAST RESORT (never prefer this)
    else if (selectors?.css) {
        strategy = 'css';
        value = selectors.css;
    }

    used.add(value);

    // ── Add fallbacks ─────────────────────
    addFallback('xpath', signals?.xpath);
    addFallback('text', signals?.text);
    addFallback('placeholder', signals?.attributes?.placeholder);
    addFallback('label', signals?.attributes?.ariaLabel);
    addFallback('testId', signals?.testId);

    return {
        strategy,
        value,
        fallbacks: fallbacks.slice(0, 3),
        strict,
    };
}
// ─── Description Generation ───────────────────────────────────────────────────

/**
 * Generate human-readable description from a recorded action.
 * FIX: Moved 'assert' case before 'default' so it is reachable.
 */
export function generateDescription(action: RecordedAction): string {
    const tagName = action.element?.tagName?.toLowerCase() ?? 'element';
    const text = action.element?.text?.trim().slice(0, 30) ?? '';
    const placeholder = (action.element?.attributes?.['placeholder'] as string | undefined) ?? '';

    switch (action.type) {
        case 'navigate':
            return `Navigate to ${action.url ?? action.url_current ?? 'page'}`;

        case 'click':
            if (text) return `Click on "${text}"`;
            if (tagName === 'button') return 'Click button';
            if (tagName === 'a') return 'Click link';
            if (tagName === 'input') return `Click ${placeholder || 'input field'}`;
            return `Click ${tagName}`;

        case 'type':
        case 'input':
            if (placeholder) return `Type in "${placeholder}" field`;
            return `Type "${String(action.value ?? '').slice(0, 20)}..."`;

        case 'fill':
            if (placeholder) return `Fill "${placeholder}" field`;
            return `Fill input with "${String(action.value ?? '').slice(0, 20)}..."`;

        case 'keypress':
            return `Press ${action.key ?? 'key'}`;

        case 'select': {
            const optionText = (action as any).selectedOptions?.[0]?.text;
            if (optionText) return `Select "${optionText}" from dropdown`;
            return `Select option "${String(action.value ?? '')}"`;
        }

        case 'check': {
            const checkLabel = (action as any).label || text || '';
            if ((action as any).inputType === 'radio') {
                return checkLabel
                    ? `Select radio "${checkLabel}"`
                    : `Select radio option "${String(action.value ?? '')}"`;
            }
            return checkLabel ? `Check "${checkLabel}"` : 'Check checkbox';
        }

        case 'uncheck': {
            const uncheckLabel = (action as any).label || text || '';
            return uncheckLabel ? `Uncheck "${uncheckLabel}"` : 'Uncheck checkbox';
        }

        case 'focus':
            if (placeholder) return `Focus on "${placeholder}" field`;
            return `Focus on ${tagName}`;

        case 'hover':
            if (text) return `Hover over "${text}"`;
            return `Hover over ${tagName}`;

        case 'scroll':
        case 'scrollTo':
            return 'Scroll to element';

        case 'check':
            return `Check ${text || 'checkbox'}`;

        case 'uncheck':
            return `Uncheck ${text || 'checkbox'}`;

        // FIX: 'assert' was placed after 'default' making it unreachable — moved above default.
        case 'assert':
            return action.description ?? `Assert ${action.assertionType ?? 'condition'}`;

        default:
            return `${action.type} on ${tagName}`;
    }
}

// ─── Single Action Transform ──────────────────────────────────────────────────

/**
 * Transform a single recorded action to UITestStep format.
 * Returns null for actions that should be omitted from the step list.
 */
export function transformRecordedActionToUITestStep(
    action: RecordedAction,
    order: number,
): UITestStep | null {

    // Skip hover, focus, blur etc. — handled natively by Playwright
    if (SKIPPABLE_ACTIONS.has(action.type)) {
        return null;
    }

    // Map to Playwright action type
    let stepAction: PlaywrightActionType = (ACTION_TYPE_MAP[action.type] ?? action.type) as PlaywrightActionType;

    // Keep only special key presses; regular char keypresses are covered by fill events
    if (action.type === 'keypress') {
        if (!action.key || !SPECIAL_KEYS.has(action.key)) {
            return null;
        }
        stepAction = 'press';
    }

    const step: UITestStep = {
        id: generateStepId(),
        order,
        action: stepAction,
        description: generateDescription(action),
        timeout: 30_000,
    };

    // Attach selector for element-based actions
    if (action.selector && stepAction !== 'navigate' && stepAction !== 'reload') {
        step.selector = buildSelectorConfigFromSignals(
            action.selector,
            action.selectors,
            action.element,
        );
    }

    // ── Action-specific properties ──────────────────────────────────────────
    switch (stepAction) {
        case 'navigate':
            step.url = action.url as string ?? action.url_current as string;
            break;

        case 'fill':
        case 'type':
            step.value = action.value;
            break;

        case 'select': {
            // Prefer structured selectedOptions value for reliable selectOption()
            const opts = (action as any).selectedOptions;
            if (Array.isArray(opts) && opts.length > 0) {
                step.value = opts[0].value;
            } else {
                step.value = action.value;
            }
            break;
        }

        case 'check':
        case 'uncheck':
            step.value = action.value;
            break;

        case 'press':
            if (action.key) {
                const mods: string[] = [];
                if (action.modifiers?.ctrl) mods.push('Control');
                if (action.modifiers?.shift) mods.push('Shift');
                if (action.modifiers?.alt) mods.push('Alt');
                if (action.modifiers?.meta) mods.push('Meta');
                step.key = mods.length > 0 ? [...mods, action.key].join('+') : action.key;
            }
            break;

        case 'scrollBy':
            // scrollBy is usually a relative movement (e.g., move 100px more)
            if (action.coordinates) {
                step.scrollOffset = {
                    x: Math.round(action.coordinates.x),
                    y: Math.round(action.coordinates.y)
                };
            }
            break;
        case 'scrollTo':
        case 'scroll':
            // scrollTo is an absolute destination
            if (action.scrollPosition) {
                step.scrollOffset = {
                    x: Math.round(action.scrollPosition.x),
                    y: Math.round(action.scrollPosition.y)
                };
            } else if (action.coordinates) {
                step.scrollOffset = {
                    x: Math.round(action.coordinates.x),
                    y: Math.round(action.coordinates.y)
                };
                if (step.metadata) {
                    step.metadata.isFromCoordinates = true;
                }
            }
            break;

        case 'assert':
            if (action.assertionType) {
                step.assertions = [{
                    type: action.assertionType as AssertionType,
                    expected: action.expected,
                    operator: 'equals' as ComparisonOperator,
                    message: action.description ?? `Assert ${action.assertionType}`,
                }];
            }
            break;

        case 'wait':
            if (action.waitCondition) {
                step.wait = {
                    condition: action.waitCondition as UITestStep['wait'] extends { condition: infer C } ? C : never,
                    timeout: 30_000,
                };
            }
            break;
    }

    // ── Metadata ────────────────────────────────────────────────────────────
    // FIX: Build metadata AFTER the switch so scrollType set in the scrollTo
    // case is not overwritten. Merge with any metadata already set in the switch.
    const builtMetadata: StepMetadata = {
        ...step.metadata,             // preserve scrollType / anything set above
        originalType: action.type,
        timestamp: action.timestamp,
        coordinates: action.coordinates as { x: number; y: number },
        elementTag: action.element?.tagName as string,
        url: action.url_current as string
    };

    // Set scrollType for scrollTo so the executor can choose
    // window.scrollTo vs element.scrollIntoView correctly.
    if (stepAction === 'scrollTo' && action.scrollPosition?.type) {
        builtMetadata.scrollType = action.scrollPosition.type as 'window' | 'element';
    }

    step.metadata = builtMetadata;

    return step;
}

// ─── Cleanup Passes ───────────────────────────────────────────────────────────

/**
 * Pass 2 — Remove phantom background events.
 * Clicks/fills at (0, 0) are synthetic events that never correspond to
 * real user interactions.
 */
export function removePhantomActions(steps: UITestStep[]): UITestStep[] {
    return steps.filter(step => {
        if (['click', 'fill', 'type'].includes(step.action)) {
            const coords = step.metadata?.coordinates;
            if (coords && coords.x === 0 && coords.y === 0) return false;
        }
        return true;
    });
}

/**
 * Pass 3 — Remove empty fill/type actions.
 * Ghost actions caused by browser synthetic input events that fire with an
 * empty value even when the user never typed anything.
 */
export function removeEmptyFillActions(steps: UITestStep[]): UITestStep[] {
    return steps.filter(step => {
        if (step.action === 'fill' || step.action === 'type') {
            const val = step.value;
            if (
                val === undefined ||
                val === null ||
                val === '' ||
                (typeof val === 'string' && val.trim() === '')
            ) {
                return false;
            }
        }
        return true;
    });
}

/**
 * Pass 4 — Squash redundant consecutive fill/type actions on the same selector.
 * Keeps only the last one (which holds the full typed string).
 *
 * FIX: Uses a deep copy of the selector to avoid aliasing bugs when
 * downstream code mutates step.selector.
 */
export function mergeConsecutiveTypeActions(steps: UITestStep[]): UITestStep[] {
    const merged: UITestStep[] = [];
    let lastTypeStep: UITestStep | null = null;

    for (const step of steps) {
        const isTypeAction =
            (step.action === 'fill' || step.action === 'type') &&
            step.selector?.value != null;

        if (isTypeAction) {
            if (
                lastTypeStep &&
                (lastTypeStep.action === 'fill' || lastTypeStep.action === 'type') &&
                lastTypeStep.selector?.value === step.selector!.value
            ) {
                // Same element — update to latest value
                lastTypeStep.value = step.value;
                lastTypeStep.description = step.description;
            } else {
                if (lastTypeStep) merged.push(lastTypeStep);
                // FIX: deep-copy selector to prevent shared-reference mutation
                lastTypeStep = {
                    ...step,
                    selector: step.selector
                        ? { ...step.selector, fallbacks: step.selector.fallbacks ? [...step.selector.fallbacks] : [] }
                        : undefined as any,
                };
            }
        } else {
            if (lastTypeStep) {
                merged.push(lastTypeStep);
                lastTypeStep = null;
            }
            merged.push(step);
        }
    }

    if (lastTypeStep) merged.push(lastTypeStep);
    return merged;
}

/**
 * Pass 4 — Squash redundant consecutive actions (Fill/Type/Scroll) on the same selector.
 * Keeps only the last one (the final state).
 */
export function mergeConsecutiveRedundantActions(steps: UITestStep[]): UITestStep[] {
    const merged: UITestStep[] = [];
    let lastStep: UITestStep | null = null;

    for (const step of steps) {
        // Define which actions are "accumulative"
        const isType = step.action === 'fill' || step.action === 'type';
        const isScroll = step.action === 'scrollTo' || step.action === 'scrollBy';

        if ((isType || isScroll) && step.selector?.value != null) {
            if (
                lastStep &&
                lastStep.action === step.action &&
                lastStep.selector?.value === step.selector!.value &&
                // Ensure we don't merge a window scroll into an element scroll
                lastStep.metadata?.scrollType === step.metadata?.scrollType
            ) {
                // UPDATE: Squash by taking the latest values
                lastStep.value = step.value;
                lastStep.scrollOffset = step.scrollOffset as { x: number, y: number };
                lastStep.description = step.description;
                // Update timestamp so the "final" action reflects the end of the gesture
                if (lastStep.metadata && step.metadata) {
                    lastStep.metadata.timestamp = step.metadata.timestamp;
                }
            } else {
                if (lastStep) merged.push(lastStep);

                // Deep-copy to prevent shared-reference mutation
                lastStep = {
                    ...step,
                    selector: step.selector
                        ? { ...step.selector, fallbacks: step.selector.fallbacks ? [...step.selector.fallbacks] : [] }
                        : undefined as any,
                };
            }
        } else {
            if (lastStep) {
                merged.push(lastStep);
                lastStep = null;
            }
            merged.push(step);
        }
    }

    if (lastStep) merged.push(lastStep);
    return merged;
}
/**
 * Pass 5 — Remove focus steps immediately followed by click/fill on the same element.
 * Playwright focuses the element automatically before fill/click.
 */
export function removeDuplicateFocusSteps(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const current = steps[i];
        const next = steps[i + 1];
        if (!current) continue;

        if (current.action === 'focus' && next) {
            const sameElement = current.selector?.value === next.selector?.value;
            if (sameElement && (next.action === 'click' || next.action === 'fill')) {
                continue;
            }
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 6 — Remove click on input when sandwiched by focus + fill on same element.
 * Recording often emits focus → click → fill for a single user tap on an input.
 */
export function removeDuplicateClickOnInput(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const prev = steps[i - 1];
        const current = steps[i];
        const next = steps[i + 1];
        if (!current) continue;

        if (
            current.action === 'click' &&
            prev?.action === 'focus' &&
            next?.action === 'fill'
        ) {
            const sameFocusElement = prev.selector?.value === current.selector?.value;
            const sameTypeElement = current.selector?.value === next.selector?.value;
            if (sameFocusElement && sameTypeElement) {
                continue;
            }
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 7 — Remove soft navigations (hash/query-only URL changes).
 * Keeps the last navigate in any chain of same-path navigations.
 *
 * FIX: Errors are logged in development instead of being silently swallowed.
 */
export function cleanSoftNavigations(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const current = steps[i];
        if (!current) continue;

        if (current.action === 'navigate' && current.url) {
            const next = steps[i + 1];
            if (next?.action === 'navigate' && next.url) {
                try {
                    const currentUrl = new URL(current.url, 'http://base');
                    const nextUrl = new URL(next.url, 'http://base');
                    if (currentUrl.pathname === nextUrl.pathname) {
                        continue; // Skip this intermediate same-path navigate
                    }
                } catch (e) {
                    // Malformed URL — keep both steps (safe fallback)
                    if (typeof process !== 'undefined' && process.env?.['NODE_ENV'] !== 'production') {
                        console.warn('[step-transform] URL parse failed in cleanSoftNavigations:', e);
                    }
                }
            }
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 8 — Remove URL assertions that duplicate a preceding navigate or assertion.
 */
export function removeRedundantUrlAssertions(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (const current of steps) {
        if (current.action === 'assert' && current.assertions?.[0]?.type === 'url') {
            const expectedUrl = current.assertions[0].expected;
            const prev = filtered[filtered.length - 1];

            if (prev) {
                // Previous step navigated to the same URL
                if (prev.action === 'navigate' && prev.url === expectedUrl) continue;
                // Previous step was an identical URL assertion
                if (
                    prev.action === 'assert' &&
                    prev.assertions?.[0]?.type === 'url' &&
                    prev.assertions[0].expected === expectedUrl
                ) continue;
            }
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 9 — Remove a click step immediately before a check/uncheck on the same element.
 * Playwright's locator.check()/uncheck() handles clicking for us, so a preceding
 * click is redundant and can cause double-toggle → flaky execution.
 */
export function removeClickBeforeCheckbox(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const current = steps[i];
        const next = steps[i + 1];
        if (!current) continue;

        if (
            current.action === 'click' &&
            next &&
            (next.action === 'check' || next.action === 'uncheck') &&
            current.selector?.value &&
            current.selector.value === next.selector?.value
        ) {
            // Skip this click — check/uncheck will handle the interaction
            continue;
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 10 — Remove a click step immediately before a select on the same element.
 * Playwright's locator.selectOption() opens the dropdown and selects for us,
 * so a preceding click is redundant and can cause the dropdown to close → flaky.
 */
export function removeClickBeforeSelect(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const current = steps[i];
        const next = steps[i + 1];
        if (!current) continue;

        if (
            current.action === 'click' &&
            next?.action === 'select' &&
            current.selector?.value &&
            current.selector.value === next.selector?.value
        ) {
            // Skip this click — selectOption will handle the interaction
            continue;
        }

        filtered.push(current);
    }

    return filtered;
}

/**
 * Pass 11 — Reorder steps to sequential 0-indexed order numbers.
 */
export function reorderSteps(steps: UITestStep[]): UITestStep[] {
    return steps.map((step, index) => ({ ...step, order: index }));
}

/**
 * Pass 10: Merge Click and Navigation
 * If a 'click' is immediately followed by a 'navigate', it means the click 
 * triggered a page load. Playwright's locator.click() automatically waits for 
 * this load, so a subsequent 'navigate' (page.goto) step is redundant and harmful.
 * * We convert the redundant 'navigate' step into a URL 'assert' step instead.
 */
export function mergeClickAndNavigation(steps: UITestStep[]): UITestStep[] {
    const filtered: UITestStep[] = [];

    for (let i = 0; i < steps.length; i++) {
        const current = steps[i];
        const next = steps[i + 1];

        if (!current) continue;

        // Detect the pattern: Click -> Navigate
        if (current.action === 'click' && next?.action === 'navigate' && next.url) {

            // 1. Keep the click step
            filtered.push(current);

            // 2. Transform the 'navigate' step into a 'wait' for network idle
            // This ensures the page is fully loaded before the next action
            filtered.push({
                id: `wait_after_${current.id}`,
                order: 0, // Will be fixed by reorderSteps later
                action: 'wait',
                description: 'Wait for page to load after click',
                wait: { condition: 'visible', timeout: 30000 },
                metadata: { originalType: 'auto-wait', timestamp: Date.now() }
            });

            // 3. Transform the 'navigate' step into a URL Assertion
            // This verifies the click successfully took us to the new page
            filtered.push({
                id: `assert_url_${next.id}`,
                order: 0,
                action: 'assert',
                description: `Verify URL changed to ${next.url}`,
                assertions: [{
                    type: 'url',
                    expected: next.url,
                    operator: 'equals',
                    message: `Assert URL navigated correctly after click`
                }],
                metadata: { ...next.metadata, originalType: 'click-navigation-assert' }
            });

            // 4. Skip the original 'navigate' step so it isn't added to the array
            i++;
        } else {
            // Normal step, just push it
            filtered.push(current);
        }
    }

    return filtered;
}

// ─── Pipeline Entry Point ─────────────────────────────────────────────────────

/**
 * Transform and deduplicate all recorded actions into UITestSteps.
 *
 * FIX: Added input validation (guards against null/undefined/non-array).
 * FIX: Wrapped entire pipeline in try/catch so a single bad action cannot
 *      silently discard all successfully-transformed steps.
 */
export function transformRecordedActions(actions: RecordedAction[]): UITestStep[] {
    // Input validation
    if (!Array.isArray(actions)) {
        console.warn('[step-transform] transformRecordedActions: expected an array, got', typeof actions);
        return [];
    }
    console.log("recorded actions", JSON.stringify(actions))
    let steps: UITestStep[] = [];

    try {
        // Pass 1 — Transform raw actions
        let order = 0;
        for (const action of actions) {
            try {
                const step = transformRecordedActionToUITestStep(action, order);
                if (step) {
                    steps.push(step);
                    order++;
                }
            } catch (err) {
                // Log bad action but continue processing the rest
                console.error('[step-transform] Failed to transform action:', action?.id, err);
            }
        }

        // Pass 2 — Remove phantom (0,0) events
        steps = removePhantomActions(steps);

        // Pass 3 — Remove empty/whitespace fill actions
        steps = removeEmptyFillActions(steps);

        // Pass 4 — Squash redundant sequential fill/type on same selector
        // steps = mergeConsecutiveTypeActions(steps);
        steps = mergeConsecutiveRedundantActions(steps);

        // Pass 5 — Remove redundant focus steps
        steps = removeDuplicateFocusSteps(steps);

        // Pass 6 — Remove redundant click-on-input steps
        steps = removeDuplicateClickOnInput(steps);

        // Pass 7 — Clean soft navigations (hash/query-only changes)
        steps = cleanSoftNavigations(steps);

        // Pass 8 — Remove redundant URL assertions
        steps = removeRedundantUrlAssertions(steps);

        // Pass 9 — Remove click before checkbox/radio check
        steps = removeClickBeforeCheckbox(steps);

        // Pass 10 — Remove click before native select
        steps = removeClickBeforeSelect(steps);

        // Pass 11 — Reorder to sequential 0-indexed order numbers
        steps = reorderSteps(steps);

    } catch (err) {
        console.error('[step-transform] Pipeline error — returning partial results:', err);
    }

    return steps;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
    transformRecordedActionToUITestStep,
    transformRecordedActions,
    collectSelectorSignals,
    buildSelectorConfig,
    generateDescription,
    removePhantomActions,
    removeEmptyFillActions,
    mergeConsecutiveTypeActions,
    mergeConsecutiveRedundantActions,
    cleanSoftNavigations,
    removeRedundantUrlAssertions,
    removeDuplicateFocusSteps,
    removeDuplicateClickOnInput,
    removeClickBeforeCheckbox,
    removeClickBeforeSelect,
    reorderSteps,
    resetStepIdCounter,
};
