/**
 * Enterprise Playwright Recording Service
 * Professional-grade browser automation with comprehensive recording capabilities
 *
 * Features:
 * - Complete user interaction recording (clicks, typing, navigation, etc.)
 * - Screenshots for every action
 * - Element identification with multiple selector strategies
 * - Network request/response monitoring
 * - Console log capture
 * - Performance metrics
 * - Error handling and recovery
 * - Video recording
 * - Accessibility information
 * - Cross-browser compatibility
 */

import {
  chromium,
  firefox,
  webkit,
  Browser,
  Page,
  BrowserContext,
  LaunchOptions,
  BrowserContextOptions,
} from 'playwright';
import { Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

import { UITestCaseModel } from '../models/ui-test-case.model';
import { transformRecordedActions } from '../utils/step-transformer.util';
import { LoggingService } from '../../../core/services/logging.service';

// ─── Types ────────────────────────────────────────────────────────────────────

// FIX #11: Channel type is now a named union, consistent across all interfaces
export type BrowserChannel = 'chrome' | 'msedge';

export interface EnterpriseRecordingAction {
  id: string;
  type: 'click' | 'type' | 'navigate' | 'scroll' | 'hover' | 'select' | 'check' | 'uncheck' | 'wait' | 'keypress' | 'focus' | 'blur';
  timestamp: number;
  selector?: string;
  selectors: {
    css?: string;
    xpath?: string;
    dataTestId?: string;
    text?: string;
    role?: string;
    label?: string;
    placeholder?: string;
  };
  element: {
    tagName: string;
    attributes: Record<string, string>;
    text?: string;
    innerHTML?: string;
    outerHTML?: string;
    computedStyles?: Record<string, string>;
    boundingBox?: { x: number; y: number; width: number; height: number };
  };
  value?: string | number | boolean;
  coordinates?: { x: number; y: number };
  url?: string;
  scrollPosition?: { x: number; y: number };
  keyCode?: number;
  modifiers?: string[];
  screenshot?: string;
  beforeScreenshot?: string;
  afterScreenshot?: string;
  duration?: number;
  loadTime?: number;
  expectedResult?: unknown;
  actualResult?: unknown;
  assertions?: { type: string; expected: unknown; actual: unknown; passed: boolean }[];
  viewport: { width: number; height: number };
  userAgent: string;
  url_current: string;
  error?: { message: string; stack: string; code?: string };
  accessibility?: { role?: string; label?: string; description?: string; level?: number };
  networkRequests?: { url: string; method: string; status: number; timing: number }[];
}

export interface EnterpriseRecordingSession {
  name: string;
  sessionId: string;
  projectId?: string;
  userId?: string;
  browserType?: 'chromium' | 'firefox' | 'webkit';
  browser: Browser;
  // FIX #11: channel uses the named union type
  channel: BrowserChannel;
  context: BrowserContext;
  page: Page;
  actions: EnterpriseRecordingAction[];
  args?: string[];
  baseUrl: string;
  startTime: Date;
  lastActionTime: Date;
  // Cached UA — captured once at session start to avoid re-evaluation
  cachedUserAgent: string;
  settings: {
    captureScreenshots: boolean;
    captureNetworkRequests: boolean;
    captureConsole: boolean;
    capturePerformance: boolean;
    captureAccessibility: boolean;
    recordVideo: boolean;
    highlightElements: boolean;
    slowMotion: number;
    autoGenerateAssertions: boolean;
    smartSelectors: boolean;
    viewport: { width: number; height: number };
  };
  paths: {
    screenshots: string;
    videos: string;
    traces: string;
    logs: string;
  };
  stats: {
    totalActions: number;
    errors: number;
    warnings: number;
    avgActionTime: number;
  };
  // FIX #5: Write streams opened once per session, closed on stop
  logStreams: {
    console?: fs.WriteStream;
    errors?: fs.WriteStream;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum recorded actions per session before incoming actions are dropped */
const MAX_ACTIONS = 5_000;

// ─── Service ──────────────────────────────────────────────────────────────────

export class EnterprisePlaywrightRecordingService {
  private activeSessions = new Map<string, EnterpriseRecordingSession>();
  private logger = new LoggingService().forModule('EnterprisePlaywrightRecordingService');

  constructor() {
    // FIX #11: Register process shutdown cleanup so browser processes are not
    // left as zombies when Node exits or receives SIGTERM.
    const cleanup = () => this.cleanupAllSessions();
    process.once('exit', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start enterprise recording session
   */
  async startRecording(options: {
    name: string;
    url: string;
    browser: 'chromium' | 'firefox' | 'webkit';
    // FIX #11: typed union consistent with session interface
    channel: BrowserChannel;
    device?: string;
    projectId?: string;
    userId: string;
    settings?: Partial<EnterpriseRecordingSession['settings']>;
  }): Promise<{ success: boolean; sessionId: string; message?: string }> {
    try {
      const sessionId = crypto.randomUUID();
      const basePath = path.join(process.cwd(), 'acevin-automation', 'Recording Studio', sessionId);

      const paths = {
        screenshots: path.join(basePath, 'screenshots'),
        videos: path.join(basePath, 'videos'),
        traces: path.join(basePath, 'traces'),
        logs: path.join(basePath, 'logs'),
      };

      Object.values(paths).forEach(d => this.ensureDirectoryExists(d));

      const defaultSettings: EnterpriseRecordingSession['settings'] = {
        captureScreenshots: true,
        captureNetworkRequests: false,
        captureConsole: false,
        capturePerformance: false,
        captureAccessibility: false,
        recordVideo: false,
        highlightElements: true,
        slowMotion: 100,
        autoGenerateAssertions: false,
        smartSelectors: false,
        viewport: { width: 1280, height: 720 },
      };

      const settings = { ...defaultSettings, ...options.settings };
      const { width, height } = settings.viewport;

      // FIX: Use typed LaunchOptions instead of `any`
      const launchOptions: LaunchOptions = {
        headless: false,
        slowMo: settings.slowMotion,
      };

      if (options.browser === 'chromium') {
        launchOptions.args = [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-position=50,50',
          `--start-maximized`,
          // `--window-size=${width},${height}`,
        ];
        if (options.channel) {
          (launchOptions as any).channel = options.channel;
        }
      }

      let browser: Browser;
      switch (options.browser) {
        case 'firefox': browser = await firefox.launch(launchOptions); break;
        case 'webkit': browser = await webkit.launch(launchOptions); break;
        default: browser = await chromium.launch(launchOptions);
      }

      // FIX: Use typed BrowserContextOptions instead of `any`
      const contextOptions: BrowserContextOptions = {
        viewport: null,
      };

      if (settings.recordVideo) {
        contextOptions.recordVideo = {
          dir: paths.videos,
          size: { width, height },
        };
      }

      if (settings.captureNetworkRequests) {
        (contextOptions as any).recordHar = {
          path: path.join(paths.logs, 'network.har'),
          mode: 'full',
        };
      }

      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();

      // FIX #2: Cache the user agent ONCE at session start so framenavigated
      // handler does not call page.evaluate on every navigation.
      const cachedUserAgent = await page.evaluate(() => navigator.userAgent);

      const session: EnterpriseRecordingSession = {
        name: options.name,
        sessionId,
        projectId: options.projectId ?? '',
        userId: options.userId,
        browserType: options.browser,
        browser,
        channel: options.channel,
        context,
        page,
        actions: [],
        startTime: new Date(),
        lastActionTime: new Date(),
        cachedUserAgent,
        settings,
        args: launchOptions.args ?? [],
        paths,
        baseUrl: options.url,
        stats: { totalActions: 0, errors: 0, warnings: 0, avgActionTime: 0 },
        logStreams: {},
      };

      // FIX #5: Open write streams once — avoids blocking the event loop on every log entry
      if (settings.captureConsole) {
        session.logStreams.console = fs.createWriteStream(
          path.join(paths.logs, 'console.log'), { flags: 'a' }
        );
      }
      session.logStreams.errors = fs.createWriteStream(
        path.join(paths.logs, 'errors.log'), { flags: 'a' }
      );

      await this.setupEnterpriseEventListeners(session);

      this.activeSessions.set(sessionId, session);
      await page.goto(options.url);

      return { success: true, sessionId, message: 'Recording session started' };

    } catch (error: unknown) {
      this.logger.error('[ENTERPRISE] Failed to start recording:', { error });
      return { success: false, sessionId: '', message: (error as Error)?.message };
    }
  }

  /**
   * Stop enterprise recording session and persist the resulting test case.
   */
  async stopRecording(sessionId: string): Promise<{
    success: boolean;
    actions?: EnterpriseRecordingAction[];
    projectId?: string;
    browserType?: string;
    testCase?: unknown;
    tracePath?: string;
    videoPath?: string;
    harPath?: string;
    stats?: unknown;
    message?: string;
  }> {
    try {
      this.logger.info('[ENTERPRISE] Stopping recording session:', { sessionId });

      const session = this.activeSessions.get(sessionId);
      if (!session) {
        throw new Error('Recording session not found or already stopped');
      }

      // FIX #7: Validate required fields BEFORE hitting the DB so we fail fast
      // instead of creating orphaned documents with random ObjectIds.
      // if (!session.projectId) {
      //   throw new Error('Cannot save test case: projectId is missing from session');
      // }
      if (!session.userId) {
        throw new Error('Cannot save test case: userId is missing from session');
      }

      const serverSideActionCount = session.actions.length;
      this.logger.info(`[ENTERPRISE] Server-side actions: ${serverSideActionCount}`);

      // Fallback: pull window.recordedActions from the page for cross-origin cases
      // where exposeFunction may not have been available.
      let clientSideActions: EnterpriseRecordingAction[] = [];
      try {
        if (session.page && !session.page.isClosed()) {
          // FIX #1: Capture logger reference BEFORE the Promise so the arrow
          // function inside setTimeout does not lose `this` context.
          const logger = this.logger;

          clientSideActions = await Promise.race([
            session.page.evaluate(() => (window as any).recordedActions ?? []),
            new Promise<EnterpriseRecordingAction[]>((resolve) => {
              setTimeout(() => {
                logger.warn('[ENTERPRISE] page.evaluate timed out, using server actions only');
                resolve([]);
              }, 1_500);
            }),
          ]);

          this.logger.info(`[ENTERPRISE] Client-side actions: ${clientSideActions.length}`);
        }
      } catch (error: unknown) {
        this.logger.error('[ENTERPRISE] Could not extract client-side actions', { error });
      }

      // Merge: add only client actions whose IDs are not already in session.actions
      let allActions = [...session.actions];
      if (clientSideActions.length > 0) {
        const existingIds = new Set(session.actions.map(a => a.id));
        const newClientActions = clientSideActions.filter(a => !existingIds.has(a.id));
        if (newClientActions.length > 0) {
          this.logger.info(`[ENTERPRISE] Adding ${newClientActions.length} unique client-side actions`);
          allActions = [...allActions, ...newClientActions];
        }
      }

      // Sort by timestamp to guarantee correct order after merge
      allActions.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

      this.logger.info(`[ENTERPRISE] Total actions for transformation: ${allActions.length}`);

      const uiTestSteps = transformRecordedActions(allActions as any);
      this.logger.info(`[ENTERPRISE] Transformed into ${uiTestSteps.length} optimised steps`);

      const newTestCase = new UITestCaseModel({
        name: session.name || `Recorded Test — ${new Date().toLocaleString()}`,
        description: `Auto-generated from recording on ${session.page.isClosed() ? session.baseUrl : session.page.url()}`,
        // FIX #7: projectId is guaranteed non-empty by the guard above
        projectId: session.projectId ? new Types.ObjectId(session.projectId) : new Types.ObjectId(),
        steps: uiTestSteps,
        browserConfig: {
          type: session.browserType ?? 'chromium',
          headless: false,
          viewport: session.settings.viewport,
          screenshot: { mode: 'only-on-failure' },
          channel: session.channel,
          args: session.args ?? [],
        },
        status: 'draft',
        url: session.baseUrl,
        // FIX #7: createdBy is guaranteed non-empty by the guard above
        createdBy: new Types.ObjectId(session.userId),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await newTestCase.save();

      // Close log streams before closing browser
      this.closeLogStreams(session);

      try {
        if (session.context) await session.context.close();
        if (session.browser) await session.browser.close();
      } catch (error: unknown) {
        this.logger.error('[ENTERPRISE] Error closing browser resources', { error });
      }

      this.activeSessions.delete(sessionId);

      return {
        success: true,
        testCase: newTestCase.toJSON(),
        actions: allActions,
        message: 'Recording saved as new Test Case',
      };

    } catch (error: unknown) {
      this.logger.error('[ENTERPRISE] Failed to stop recording:', { error });
      return {
        success: false,
        message: `Failed to stop recording: ${(error as Error)?.message ?? 'Unknown error'}`,
      };
    }
  }

  // ─── Event Listener Setup ────────────────────────────────────────────────────

  /**
   * Setup comprehensive event listeners for enterprise recording
   */
  private async setupEnterpriseEventListeners(session: EnterpriseRecordingSession): Promise<void> {
    const { context, page, settings } = session;

    // ── 1. CONTEXT-LEVEL INJECTION (Applies to all tabs automatically) ──
    if (!(context as any)._enterpriseScriptsBound) {
      (context as any)._enterpriseScriptsBound = true;
      await (context as any).exposeFunction('__acevin_pushAction', (actionJson: string) => {
        if (session.actions.length >= MAX_ACTIONS) return;
        try {
          const action = JSON.parse(actionJson);

          // Handle click suppression signal from the client
          if (action.type === '__suppress_last_click') {
            const last = session.actions[session.actions.length - 1];
            if (last && last.type === 'click') {
              session.actions.pop();
              session.stats.totalActions = Math.max(0, session.stats.totalActions - 1);
            }
            return;
          }

          session.actions.push(action);
          session.stats.totalActions++;
          session.lastActionTime = new Date();
        } catch { }
      });

      // Add the massive event listener script to the ENTIRE context
      await context.addInitScript(
        (cfg: any) => {
          // FIX: Removed actionCounter. We use Date.now() for cross-tab unique IDs.

          function throttle(func: (...a: any[]) => void, limit: number) {
            let inThrottle = false;
            return function (this: unknown, ...args: any[]) {
              if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => { inThrottle = false; }, limit);
              }
            };
          }

          function debounce(func: (...a: any[]) => void, wait: number) {
            let timeout: ReturnType<typeof setTimeout>;
            return function (...args: any[]) {
              clearTimeout(timeout);
              timeout = setTimeout(() => func(...args), wait);
            };
          }

          // ── Selector signal collection (browser-side) ─────────
          // These functions MUST be defined inline here because this code
          // runs inside addInitScript (browser context), NOT Node.js.

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
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            return null;
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

          function collectSelectorSignals(element: Element) {
            const el = element as HTMLElement;
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              text: el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 50) || null,
              attributes: {
                name: el.getAttribute('name'),
                type: el.getAttribute('type'),
                role: el.getAttribute('role') || inferRole(el),
                placeholder: el.getAttribute('placeholder'),
                ariaLabel: el.getAttribute('aria-label'),
              },
              testId:
                el.getAttribute('data-testid') ||
                el.getAttribute('data-test-id') ||
                el.getAttribute('data-cy') ||
                el.getAttribute('data-e2e'),
              position: getElementIndex(el),
              xpath: generateXPathSelector(element),
            };
          }

          const getSelector = collectSelectorSignals;

          // ── Deduplication state ─────────
          let lastFocusedElement: Element | null = null;
          let lastFocusTime = 0;

          // ── Core action recorder ────────
          function recordAction(type: string, element: Element, additionalData: Record<string, unknown> = {}) {
            try {
              const timestamp = Date.now();
              // FIX: Cross-tab safe unique ID generation
              const actionId = `action_${timestamp}_${Math.floor(Math.random() * 1000)}`;

              const rect = element.getBoundingClientRect();
              const scrollX = window.scrollX;
              const scrollY = window.scrollY;
              const signals = getSelector(element)
              const action = {
                id: actionId,
                type,
                timestamp,
                selector: signals,
                // selectors: {
                //   css: getSelector(element),
                //   xpath: generateXPathSelector(element),
                //   dataTestId: element.getAttribute('data-testid') ?? element.getAttribute('data-test-id') ?? undefined,
                //   text: element.textContent ? element.textContent.trim().slice(0, 100) : undefined,
                //   role: element.getAttribute('role') ?? element.getAttribute('aria-role') ?? undefined,
                //   label: element.getAttribute('aria-label') ?? element.getAttribute('label') ?? undefined,
                //   placeholder: element.getAttribute('placeholder') ?? undefined,
                // },
                selectors: {
                  xpath: signals.xpath,
                  text: signals.text,
                  role: signals.attributes.role ?? undefined,
                  label: signals.attributes.ariaLabel ?? undefined,
                  placeholder: signals.attributes.placeholder ?? undefined,
                  testId: signals.testId ?? undefined,
                },
                coordinates: {
                  x: Math.round(rect.left + rect.width / 2 + scrollX),
                  y: Math.round(rect.top + rect.height / 2 + scrollY),
                },
                element: {
                  tagName: element.tagName.toLowerCase(),
                  text: element.textContent ? element.textContent.trim().slice(0, 200) : '',
                  attributes: Array.from(element.attributes).reduce<Record<string, string>>((acc, a) => {
                    acc[a.name] = a.value; return acc;
                  }, {}),
                },
                viewport: { width: window.innerWidth, height: window.innerHeight },
                url_current: window.location.href,
                userAgent: navigator.userAgent,
                ...additionalData,
              };

              if (cfg.highlightElements) {
                (element as HTMLElement).style.outline = '3px solid #ff0000';
                (element as HTMLElement).style.outlineOffset = '2px';
                setTimeout(() => {
                  (element as HTMLElement).style.outline = '';
                  (element as HTMLElement).style.outlineOffset = '';
                }, 1_000);
              }

              (window as any).recordedActions = (window as any).recordedActions ?? [];
              (window as any).recordedActions.push(action);

              if (typeof (window as any).__acevin_pushAction === 'function') {
                (window as any).__acevin_pushAction(JSON.stringify(action));
              }
            } catch (err) {
              console.error('[RECORDING] recordAction error:', type, err);
            }
          }

          // ── Event listeners ─────────────
          // Track the last click so checkbox/radio/select change handlers can
          // retroactively remove the redundant click that the browser fires first.
          let lastClickElement: Element | null = null;
          let lastClickTime = 0;
          function getActionableElement(el: Element | null): Element | null {
            while (el) {
              const tag = el.tagName?.toLowerCase();

              if (
                tag === 'button' ||
                tag === 'a' ||
                tag === 'input' ||
                tag === 'select' ||
                tag === 'textarea' ||
                el.getAttribute('role') === 'button' ||
                el.hasAttribute('onclick') ||
                window.getComputedStyle(el).cursor === 'pointer'
              ) {
                return el;
              }

              el = el.parentElement;
            }
            return null;
          }
          document.addEventListener('click', function (e) {
            const rawTarget = e.target as Element;
            const target = getActionableElement(rawTarget);
            if (!target || target.nodeType !== Node.ELEMENT_NODE) return;

            const tag = target.tagName.toLowerCase();
            if (['html', 'body'].includes(tag)) return;

            const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
            const timeSinceFocus = Date.now() - lastFocusTime;
            if (isInput && lastFocusedElement === target && timeSinceFocus < 100) return;

            // Track this click for potential suppression by change handler
            lastClickElement = target;
            lastClickTime = Date.now();

            recordAction('click', target, {
              modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
            });

            if (cfg.autoGenerateAssertions) {
              const clickedText = target.textContent ? target.textContent.trim().slice(0, 50) : '';
              const initialUrl = window.location.href;

              setTimeout(function () {
                const currentUrl = window.location.href;
                if (currentUrl !== initialUrl) {
                  recordAction('assert', document.documentElement, {
                    assertionType: 'url',
                    expected: currentUrl,
                    description: `Assert URL after clicking "${clickedText || 'element'}"`,
                  });
                }
              }, 2_000);
            }
          }, true);

          /**
           * Remove the last recorded action if it was a click on the same element
           * within a short time window. This prevents duplicate click+check/select
           * patterns that cause flaky execution.
           */
          function suppressPrecedingClick(target: Element) {
            if (lastClickElement === target && (Date.now() - lastClickTime) < 150) {
              const actions = (window as any).recordedActions;
              if (Array.isArray(actions) && actions.length > 0) {
                const last = actions[actions.length - 1];
                if (last && last.type === 'click') {
                  actions.pop();
                }
              }
              // Also signal the server to drop the last action
              if (typeof (window as any).__acevin_pushAction === 'function') {
                (window as any).__acevin_pushAction(JSON.stringify({
                  id: `suppress_${Date.now()}`,
                  type: '__suppress_last_click',
                  timestamp: Date.now(),
                }));
              }
            }
            lastClickElement = null;
            lastClickTime = 0;
          }

          const debouncedInput = debounce(function (target: HTMLInputElement, value: string, inputType: string) {
            if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
            if (value === undefined || value === null || value === '' || value.trim() === '') return;
            recordAction('type', target, { value, inputType: inputType ?? 'insertText' });
          }, 500);

          document.addEventListener('input', function (e) {
            const target = e.target as HTMLInputElement;
            if (target && target.nodeType === Node.ELEMENT_NODE) {
              debouncedInput(target, target.value, (e as InputEvent).inputType);
            }
          }, true);

          document.addEventListener('change', function (e) {
            const target = e.target as Element;
            if (!target || target.nodeType !== Node.ELEMENT_NODE) return;

            // ── Checkbox ──────────────────────────────────────────────
            if (
              target.tagName === 'INPUT' &&
              (target as HTMLInputElement).type === 'checkbox'
            ) {
              const checked = (target as HTMLInputElement).checked;
              const labelText =
                (target as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '';
              suppressPrecedingClick(target);
              recordAction(checked ? 'check' : 'uncheck', target, {
                value: checked,
                inputType: 'checkbox',
                label: labelText,
              });
              return;
            }

            // ── Radio button ──────────────────────────────────────────
            if (
              target.tagName === 'INPUT' &&
              (target as HTMLInputElement).type === 'radio'
            ) {
              const radioValue = (target as HTMLInputElement).value;
              const labelText =
                (target as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? '';
              suppressPrecedingClick(target);
              recordAction('check', target, {
                value: radioValue,
                inputType: 'radio',
                label: labelText,
              });
              return;
            }

            // ── Native <select> ───────────────────────────────────────
            if (target.tagName === 'SELECT') {
              const selectEl = target as HTMLSelectElement;
              const selectedOptions = Array.from(selectEl.selectedOptions).map(o => ({
                value: o.value,
                text: o.text.trim(),
              }));
              const primaryValue = selectedOptions[0]?.value ?? selectEl.value;
              suppressPrecedingClick(target);
              recordAction('select', target, {
                value: primaryValue,
                selectedOptions,
              });
              return;
            }
          }, true);

          document.addEventListener('keydown', function (e) {
            const target = e.target as Element;
            if (!target || target.nodeType !== Node.ELEMENT_NODE) return;

            const specialKeys = new Set([
              'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
              'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
              'Home', 'End', 'PageUp', 'PageDown',
            ]);

            if (specialKeys.has(e.key) || e.ctrlKey || e.altKey || e.metaKey) {
              recordAction('keypress', target, {
                keyCode: e.keyCode,
                key: e.key,
                code: e.code,
                modifiers: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
              });
            }
          }, true);

          const scrollStartPositions = new Map();

          const debouncedScroll = debounce(function (event: Event) {
            const target = event.target;
            if (!target) return;

            const isWindow = (target === document || target === document.documentElement || target === document.body);
            const actualElement = isWindow ? document.documentElement : (target as Element);

            const x = isWindow ? window.scrollX : (target as Element).scrollLeft;
            const y = isWindow ? window.scrollY : (target as Element).scrollTop;

            const targetId = isWindow ? 'window' : getSelector(actualElement);
            const lastPos = scrollStartPositions.get(targetId);

            if (lastPos && lastPos.x === x && lastPos.y === y) return;

            const scrollData = {
              type: isWindow ? 'window' : 'element',
              x: Math.round(x),
              y: Math.round(y),
              selector: isWindow ? undefined : targetId
            };

            recordAction('scroll', actualElement, { scrollPosition: scrollData });
            scrollStartPositions.set(targetId, { x, y });
          }, 500);

          document.addEventListener('scroll', (e) => {
            const target = e.target;
            if (!target) return;

            const isDocument = target === document || target === document.documentElement || target === document.body;
            let targetId: string;
            let x: number;
            let y: number;

            if (isDocument) {
              targetId = 'window';
              x = window.scrollX;
              y = window.scrollY;
            } else if (target instanceof Element) {
              targetId = getSelector(target).xpath as string;
              x = target.scrollLeft;
              y = target.scrollTop;
            } else {
              return;
            }

            if (!scrollStartPositions.has(targetId)) {
              scrollStartPositions.set(targetId, { x, y });
            }

            // FIX: Simplified scroll invocation. The inner function recalculates anyway.
            debouncedScroll(e);
          }, true);

          document.addEventListener('focus', function (e) {
            const target = e.target as Element;
            if (target && target.nodeType === Node.ELEMENT_NODE &&
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
              lastFocusedElement = target;
              lastFocusTime = Date.now();
              recordAction('focus', target);
            }
          }, true);

          document.addEventListener('blur', function (e) {
            const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
            if (target && target.nodeType === Node.ELEMENT_NODE &&
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
              recordAction('blur', target);

              if (cfg.autoGenerateAssertions) {
                const finalValue = target.value;
                if (finalValue !== undefined && finalValue !== null && finalValue.trim() !== '') {
                  recordAction('assert', target, {
                    assertionType: 'value',
                    expected: finalValue,
                    description: `Assert input value is "${String(finalValue).slice(0, 20)}"`,
                  });
                }
              }
            }
          }, true);

          const throttledHover = throttle(function (e: MouseEvent) {
            const target = e.target as Element;
            if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
            const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
            if (interactiveTags.has(target.tagName) || window.getComputedStyle(target).cursor === 'pointer') {
              recordAction('hover', target);
            }
          }, 500);

          document.addEventListener('mouseover', throttledHover as EventListener, true);

          console.log('[RECORDING] Event listeners initialised');
        },
        {
          smartSelectors: settings.smartSelectors,
          highlightElements: settings.highlightElements,
          autoGenerateAssertions: settings.autoGenerateAssertions,
        }
      );

      // Listen for new tabs to attach our server-side network/navigation trackers
      context.on('page', async (newPage) => {
        this.logger.info(`[ENTERPRISE] New tab detected: ${newPage.url()}`);
        this.attachServerSideListeners(session, newPage);
      });
    }

    // ── 2. Attach server-side listeners to the initial starting page ──
    this.attachServerSideListeners(session, page);

    this.logger.info(`[ENTERPRISE] Event listeners set up for context and initial page.`);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Take a screenshot and save it to the given directory.
   *
   * FIX #3: Signature now takes an explicit `screenshotDir` instead of a
   * session ID, removing the fragile ID-prefix heuristic entirely.
   */
  private async takeScreenshot(page: Page, screenshotDir: string, actionId: string): Promise<string> {
    try {
      this.ensureDirectoryExists(screenshotDir);
      const screenshotPath = path.join(screenshotDir, `${actionId}_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, type: 'png' });
      return screenshotPath;
    } catch (error: unknown) {
      this.logger.error('[ENTERPRISE] Failed to take screenshot', { error });
      return '';
    }
  }

  private ensureDirectoryExists(dirPath: string): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      this.logger.error('[ENTERPRISE] Failed to create directory', {
        dirPath,
        error,
      });
    }
  }

  private closeLogStreams(session: EnterpriseRecordingSession): void {
    try { session.logStreams.console?.end(); } catch { /* ignore */ }
    try { session.logStreams.errors?.end(); } catch { /* ignore */ }
  }

  /**
   * FIX #11: Close all active browser instances on process exit to prevent
   * zombie Chromium/Firefox processes.
   */
  private cleanupAllSessions(): void {
    for (const [, session] of this.activeSessions) {
      try { session.browser.close(); } catch { /* ignore during exit */ }
    }
    this.activeSessions.clear();
  }

  // ─── Status Helpers ───────────────────────────────────────────────────────────

  getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }

  getSessionStatus(sessionId: string): 'active' | null {
    return this.activeSessions.has(sessionId) ? 'active' : null;
  }

  private attachServerSideListeners(session: EnterpriseRecordingSession, targetPage: Page): void {
    const { settings } = session;

    // ── Server-side navigation tracking ──────────────────────────────────────
    let lastNavigatedUrl = '';
    let lastNavigationTime = 0;

    targetPage.on('framenavigated', async (frame) => {
      if (frame !== targetPage.mainFrame()) return;

      const newUrl = frame.url();
      const now = Date.now();

      if (!newUrl.startsWith('http')) return;
      if (newUrl === lastNavigatedUrl && now - lastNavigationTime < 500) return;

      const lastAction = session.actions[session.actions.length - 1];
      if (lastAction?.type === 'navigate' && lastAction.url === newUrl) return;

      lastNavigatedUrl = newUrl;
      lastNavigationTime = now;

      let urlToStore = newUrl;
      try {
        const urlObj = new URL(newUrl);
        if (!session.baseUrl) {
          session.baseUrl = urlObj.origin;
        }
        if (session.baseUrl && urlObj.origin === new URL(session.baseUrl).origin) {
          urlToStore = urlObj.pathname + urlObj.search + urlObj.hash;
        }
      } catch {
        // ignore
      }

      const action: any = {
        id: `nav_${now}`,
        type: 'navigate',
        timestamp: now,
        selector: 'page',
        selectors: {},
        url: urlToStore,
        url_current: newUrl,
        element: { tagName: 'page', attributes: {} },
        viewport: targetPage.viewportSize() ?? session.settings?.viewport,
        userAgent: session.cachedUserAgent,
      };

      if (settings.captureScreenshots) {
        action.screenshot = await this.takeScreenshot(
          targetPage,
          session.paths.screenshots,
          `nav_${now}`
        );
      }

      session.actions.push(action);
      session.stats.totalActions++;
    });

    // ── Console capture ──────────────────────────────────────────────────────
    if (settings.captureConsole && session.logStreams.console) {
      const consoleStream = session.logStreams.console;
      targetPage.on('console', msg => {
        consoleStream.write(
          JSON.stringify({ timestamp: Date.now(), type: msg.type(), text: msg.text(), location: msg.location() }) + '\n'
        );
      });
    }

    // ── Page error capture ───────────────────────────────────────────────────
    if (session.logStreams.errors) {
      const errorStream = session.logStreams.errors;
      targetPage.on('pageerror', error => {
        session.stats.errors++;
        errorStream.write(
          JSON.stringify({ timestamp: Date.now(), message: error.message, stack: error.stack }) + '\n'
        );
      });
    }

    // ── Network capture ──────────────────────────────────────────────────────
    if (settings.captureNetworkRequests) {
      targetPage.on('response', async (response) => {
        try {
          const url = response.request().url();
          if (url.startsWith('data:') || /\.(css|js|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico)$/i.test(url)) {
            return;
          }
          const networkEntry = {
            url,
            method: response.request().method(),
            status: response.status(),
            timing: response.request().timing()?.responseEnd ?? 0,
          };
          const lastAction = session.actions[session.actions.length - 1];
          if (lastAction) {
            lastAction.networkRequests ??= [];
            lastAction.networkRequests.push(networkEntry);
          }
        } catch { }
      });
    }
  }

}

export default EnterprisePlaywrightRecordingService;
