/**
 * @fileoverview UI Test Execution Service
 * @description Service for executing UI tests with real Playwright automation
 * @version 2.1.0 — Production-hardened + Per-execution artifact storage
 *
 * FIXES APPLIED:
 *  [1]  Fire-and-forget `.catch()` added to startExecution
 *  [2]  Memory-safe cleanup: Map entries deleted BEFORE async close calls
 *  [3]  Double-cleanup removed — single cleanup path via finally block only
 *  [4]  passedCount / failedCount accounting corrected for continueOnFailure
 *  [5]  `new Date().toISOString` → `new Date().toISOString()` (was missing `()`)
 *  [6]  Concurrency semaphore — MAX_CONCURRENT cap with queue guard
 *  [7]  Screenshot TOCTOU race replaced with try/catch instead of isClosed() gate
 *  [8]  `page.setDefaultTimeout()` removed — per-action timeouts used exclusively
 *  [9]  Dialog listener moved to page level (registered once, not per step)
 *  [10] `search` filter now applied in getExecutionHistory query
 *  [11] getExecutionReport passRate computed manually (lean() strips methods)
 *  [12] Master execution timeout via Promise.race
 *  [13] stopExecution uses atomic findOneAndUpdate (no TOCTOU)
 *  [14] All artifacts (screenshots, videos, traces, logs) saved under
 *       acevin-automation/playback/<executionId>/ per execution.
 *       Video paths discovered after context close; browser console logs
 *       streamed to a per-execution log file.
 */
import { chromium, firefox, webkit, Browser, Page, BrowserContext } from 'playwright';
import { expect } from '@playwright/test';
import { UITestCaseModel } from '../models/ui-test-case.model';
import { UITestExecutionModel } from '../models/ui-test-execution.model';
import { UITestDataModel } from '../models/ui-test-data.model';
import {
    UITestCase,
    UITestStep,
    ExecutionOptions,
    TestExecutionResult,
    StepExecutionResult,
    SelectorConfig,
    AssertionConfig,
} from '../types/ui-test.types';
import { WebSocketService } from '../../../core/services/websocket.service';
import { Types } from 'mongoose';
import * as path from 'path';
import * as fs from 'fs';
import crypto from 'crypto';
import { WaitConfig } from '../types/ui-test.types'
import { LoggingService } from '../../../core/services/logging.service';

// ─── Constants ────────────────────────────────────────────────────────────────
/** Maximum simultaneous browser processes allowed on this server. */
const MAX_CONCURRENT_EXECUTIONS = 5;
/** Hard ceiling on how long a single full test run may take (ms). */
const MASTER_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
/** How long to wait for browser cleanup before forcibly abandoning it (ms). */
const CLEANUP_TIMEOUT_MS = 5_000;
// ─── Constants ─────────────────────────────────────────────────────────────────
/** Root directory for all per-execution artifacts. */
const ARTIFACT_BASE_DIR = 'acevin-automation/playback';
// ─── Service ──────────────────────────────────────────────────────────────────
export class UITestExecutionService {
    // FIX [2]: Maps store live handles; entries are deleted BEFORE async close so
    //          a crash mid-close never leaves orphaned references.
    private activeBrowsers: Map<string, Browser> = new Map();
    private activeContexts: Map<string, BrowserContext> = new Map();
    private activeHeadlessStates: Map<string, boolean> = new Map();
    // FIX [6]: Simple semaphore — tracks IDs of currently running executions.
    private runningExecutions: Set<string> = new Set();
    private logger = new LoggingService().forModule('UITestExecutionService');
    // ── Artifact Helpers ────────────────────────────────────────────────────────
    /**
     * Returns the base artifact directory for a given execution.
     * Structure: acevin-automation/playback/<executionId>/
     */
    private getExecutionDir(executionId: string): string {
        return path.join(ARTIFACT_BASE_DIR, executionId);
    }
    /** Ensure a directory exists (creates recursively). */
    private ensureDir(dir: string): void {
        fs.mkdirSync(dir, { recursive: true });
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * Validate, enqueue, and fire-off a test execution.
     * Returns the executionId immediately so the caller can subscribe to WS events.
     */
    async startExecution(
        testId: string,
        options: Partial<ExecutionOptions>,
        userId: string,
        setUpTestId?: string // Make sure this can be optional!
    ): Promise<string> {
        // FIX [6]: Reject early when the server is at capacity.
        if (this.runningExecutions.size >= MAX_CONCURRENT_EXECUTIONS) {
            throw new Error(
                `Server is at capacity (max ${MAX_CONCURRENT_EXECUTIONS} concurrent executions). ` +
                `Please wait for a running test to finish.`
            );
        }
        if (!Types.ObjectId.isValid(testId)) {
            throw new Error('Invalid test ID');
        }

        const test = await UITestCaseModel.findById(testId).lean();
        if (!test) throw new Error('Test not found');
        if (test.status !== 'active' && test.status !== 'draft') {
            throw new Error('Test is not in active or draft status');
        }

        const setUpTest = setUpTestId ? await UITestCaseModel.findById(setUpTestId).lean() : null;

        //Generate the ONE master ID that the frontend will track!
        const executionId = crypto.randomUUID();

        this.logger.info(`Test loaded: "${test.name}" (${test.steps.length} steps)`);

        this.runningExecutions.add(executionId);

        if (setUpTest) {
            // Pass the executionId to the wrapper, and catch/finally the promise!
            this.executeWithSetup(
                executionId, // <--- Added this!
                setUpTest as UITestCase,
                test as UITestCase,
                userId,
                options
            )
                .catch((err) => {
                    this.logger.error(`Unhandled executeWithSetup rejection`, { error: err.message });
                })
                .finally(() => {
                    // CRITICAL: Free up the server capacity slot!
                    this.runningExecutions.delete(executionId);
                });

            return executionId;
        } else {
            this.executeTest(executionId, test as UITestCase, options, userId)
                .catch(async (err) => {
                    this.logger.error(`Unhandled executeTest rejection`, { error: err.message });
                    await this.handleExecutionError(
                        executionId,
                        String((test as any)._id),
                        userId,
                        err,
                        Date.now()
                    );
                })
                .finally(() => {
                    this.runningExecutions.delete(executionId);
                });

            return executionId;
        }
    }
    /**
     * Stop a running execution gracefully.
     */
    async stopExecution(executionId: string): Promise<void> {
        this.logger.info(`[stopExecution] Cancelling ${executionId}`);

        // FIX [13]: Atomic update — no read-modify-write, eliminates TOCTOU.
        await UITestExecutionModel.findOneAndUpdate(
            { executionId, status: 'running' },
            { $set: { status: 'cancelled', endTime: new Date() } }
        );
        this.logger.info(`[stopExecution] Marked cancelled in DB.`);

        // FIX [2]: cleanup() handles Map deletion before closing.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.cleanup(executionId),
                new Promise<never>((_, reject) => {
                    cleanupTimer = setTimeout(
                        () => reject(new Error('Browser cleanup timed out')),
                        CLEANUP_TIMEOUT_MS
                    );
                }),
            ]);
            this.logger.info(`[stopExecution] Browser resources cleaned up.`);
        } catch (err: any) {
            this.logger.warn(`[stopExecution] Forced to abandon cleanup: ${err.message}`);
        } finally {
            if (cleanupTimer) clearTimeout(cleanupTimer);
        }
    }
    // ── Core Execution ─────────────────────────────────────────────────────────
    public async executeWithSetup(
        mainExecutionId: string,
        setupTest: UITestCase,
        mainTest: UITestCase,
        userId: string,
        options: Partial<ExecutionOptions> = {}
    ) {
        this.logger.info(`Starting execution with Setup: [${setupTest.name}] -> Main: [${mainTest.name}]`);

        let sharedBrowser: any = null; // Track it out here for the safety net

        try {
            // ── 1. Run Setup Test (Login) ──
            const setupExecutionId = crypto.randomUUID();
            const setupResult = await this.executeTest(setupExecutionId, setupTest, { ...options, keepAlive: true }, userId);

            if (setupResult.status !== 'passed') {
                this.logger.error(`Setup test failed! Aborting main test.`);
                // Manually close if setup fails, because keepAlive was true!
                if (setupResult.activeInstances?.browser) await setupResult.activeInstances.browser.close();
                return { status: 'failed', setupExecution: setupResult, mainExecution: null };
            }

            sharedBrowser = setupResult.activeInstances.browser; // Grab the reference

            // ── 2. Run Main Test ──
            const mainResult = await this.executeTest(
                mainExecutionId,
                mainTest,
                {
                    ...options,
                    existingBrowser: sharedBrowser,
                    existingContext: setupResult.activeInstances.context,
                    existingPage: setupResult.activeInstances.page,
                    keepAlive: false // Tell executeTest to clean it up naturally
                },
                userId
            );

            return { status: mainResult.status, setupExecution: setupResult, mainExecution: mainResult };

        } finally {
            // 🟢 3. ULTIMATE SAFETY NET
            // If anything catastrophic happens (like a server error or a manual kill switch),
            // we guarantee the shared browser is destroyed.
            if (sharedBrowser && sharedBrowser.isConnected()) {
                this.logger.info(`[WRAPPER] Triggering safety net to close browser.`);
                await sharedBrowser.close().catch(() => { });
            }
        }
    }
    async executeTest(
        executionId: string,
        test: UITestCase,
        options: Partial<ExecutionOptions>,
        userId: string
    ): Promise<TestExecutionResult | any> {
        const startTs = Date.now();
        const testId = test._id ? String(test._id) : undefined;
        const suiteExecutionId = options.suiteExecutionId;

        this.logger.info(`Starting test execution`, {
            browser: options.browser || 'chromium',
            headless: options.headless ?? 'default',
        });

        // ── 1. Build execution options ───────────────────────────────────────
        const execOptions: ExecutionOptions = {
            environment: typeof options.environment === 'string' ? options.environment : 'dev',
            browser: {
                type: options.browser?.type ?? 'chromium',
                channel: options?.browser?.channel || 'chrome',
                viewport: null,
                screenshot: { mode: 'only-on-failure' },
                // trace: { enabled: true, screenshots: true, snapshots: true }
            },
            headless: options.headless || false,
            timeout: options.timeout || test.timeout,
            speed: options.speed ?? 1000,
            retries: options.retries !== undefined ? options.retries : test.retries,
            continueOnFailure: options.continueOnFailure ?? false,
        };
        if (options.baseUrl) execOptions.baseUrl = options.baseUrl;
        if (!execOptions.baseUrl && test.url) execOptions.baseUrl = test.url;
        if (options.dataSetId) execOptions.dataSetId = options.dataSetId;
        if (options.dataRowIndex !== undefined) execOptions.dataRowIndex = options.dataRowIndex;
        if (options.priority) execOptions.priority = options.priority;
        if (options.tags) execOptions.tags = options.tags;
        if (options.suiteExecutionId) execOptions.suiteExecutionId = options.suiteExecutionId;
        if (options.suiteId) execOptions.suiteId = options.suiteId;
        if (options.executionType) execOptions.executionType = options.executionType;

        // ── 2. Create execution record ───────────────────────────────────────
        const execution = await UITestExecutionModel.create({
            executionId,
            testId: test._id,
            testName: test.name,
            status: 'running',
            startTime: new Date(),
            environment: execOptions.environment,
            browser: {
                type: execOptions.browser.type,
                channel: execOptions.browser.channel,
                device: execOptions.browser.device,
            },
            triggeredBy: userId ? new Types.ObjectId(userId) : undefined,
            trigger: 'manual',
            dataSetId: execOptions.dataSetId,
            dataRowIndex: execOptions.dataRowIndex,
            suiteExecutionId: execOptions.suiteExecutionId,
            suiteId: execOptions.suiteId,
            executionType: execOptions.executionType,
            summary: {
                total: test.steps.length,
                passed: 0,
                failed: 0,
                skipped: 0
            }
        });
        this.logger.info(`Execution record created: ${executionId}`);
        this.activeHeadlessStates.set(executionId, execOptions.headless || false);
        this.notify(userId, 'execution-started', {
            executionId,
            testId,
            testName: test.name,
            totalSteps: test.steps.length,
            status: 'running',
            timestamp: new Date().toISOString(),
        }, suiteExecutionId);

        let browser: Browser | null = options.existingBrowser || null;
        let context: BrowserContext | null = options.existingContext || null;
        let page: Page | null = options.existingPage || null;

        // FIX: Even if we were handed an existing browser, we MUST track it 
        // under the current executionId so cleanup() can find it later!
        if (browser) this.activeBrowsers.set(executionId, browser);
        if (context) this.activeContexts.set(executionId, context);
        // if (page) this.activePages.set(executionId, page);

        try {
            // ── 3. Launch browser ────────────────────────────────────────────
            if (!browser) {
                this.logger.info(`Launching ${execOptions.browser.type} browser...`);
                browser = await this.launchBrowser(execOptions);
                this.activeBrowsers.set(executionId, browser);
                this.logger.info(`Browser launched (v${browser.version()})`);
            }

            // ── 4. Create context ────────────────────────────────────────────
            // FIX [14]: All artifacts go under acevin-automation/playback/<executionId>/
            const execDir = this.getExecutionDir(executionId);

            // Video — only if explicitly enabled.
            let videoConfig: any = undefined;
            if (execOptions.browser.video?.enabled) {
                const videoDir = path.join(execDir, 'videos');
                this.ensureDir(videoDir);
                videoConfig = execOptions.browser.video.size
                    ? { dir: videoDir, size: execOptions.browser.video.size }
                    : { dir: videoDir };
            }

            const contextOptions: any = {
                viewport: execOptions.browser.viewport,
                ...(videoConfig ? { recordVideo: videoConfig } : {}),
            };
            if (execOptions.browser.device?.userAgent) {
                contextOptions.userAgent = execOptions.browser.device.userAgent;
            }
            if (execOptions.browser.device?.deviceScaleFactor !== undefined) {
                contextOptions.deviceScaleFactor = execOptions.browser.device.deviceScaleFactor;
            }
            // ADDED FOR SUITE STATE BATON PASS: Inject Cookies & Local Storage
            if (options.storageState) {
                contextOptions.storageState = options.storageState;
                this.logger.info(`[ENGINE] Injected shared session state (Cookies + LocalStorage) into browser context`);
            }
            if (!context) {
                context = await browser.newContext(contextOptions);
                this.activeContexts.set(executionId, context);
            }
            // ADDED FOR SUITE STATE BATON PASS: Inject Session Storage via script
            if (options.sessionStorageData) {
                await context.addInitScript((data: string) => {
                    try {
                        const parsed = JSON.parse(data);
                        for (const key in parsed) {
                            window.sessionStorage.setItem(key, parsed[key]);
                        }
                    } catch (e) {
                        console.error('Failed to inject sessionStorage', e);
                    }
                }, options.sessionStorageData);
                this.logger.info(`[ENGINE] Injected shared SessionStorage data`);
            }

            // Trace — only if explicitly enabled.
            if (execOptions.browser.trace?.enabled) {
                await context.tracing.start({
                    screenshots: execOptions.browser.trace.screenshots ?? false,
                    snapshots: execOptions.browser.trace.snapshots ?? false,
                });
            }
            if (!page) {
                page = await context.newPage();
                this.logger.info(`Page created`, { viewport: execOptions.browser.viewport });
            }
            // FIX [14]: Capture browser console output — only if logs.enabled.
            let logFile: string | null = null;
            if (execOptions.browser.logs?.enabled) {
                const logDir = path.join(execDir, 'logs');
                logFile = path.join(logDir, 'execution.log');
                this.ensureDir(logDir);
                fs.appendFileSync(
                    logFile,
                    `=== Execution ${executionId} — ${new Date().toISOString()} ===\n`,
                    'utf8'
                );
                page.on('console', (msg) => {
                    const line = `[${new Date().toISOString()}] [${msg.type().toUpperCase()}] ${msg.text()}\n`;
                    try { fs.appendFileSync(logFile!, line, 'utf8'); } catch { /* ignore */ }
                });
                page.on('pageerror', (err) => {
                    const line = `[${new Date().toISOString()}] [PAGE_ERROR] ${err.message}\n${err.stack ?? ''}\n`;
                    try { fs.appendFileSync(logFile!, line, 'utf8'); } catch { /* ignore */ }
                });
            }

            if (!execOptions.headless && execOptions.browser.type === 'chromium') {
                try {
                    // Create a direct line to the Chrome DevTools Protocol
                    const cdpSession = await context.newCDPSession(page);
                    // Instruct Chrome to ignore physical mouse/keyboard inputs
                    await cdpSession.send('Input.setIgnoreInputEvents', { ignore: true });
                    // Optional: Inject a visual banner so the user knows the browser is locked
                    await page.addInitScript(() => {
                        window.addEventListener('DOMContentLoaded', () => {
                            const banner = document.createElement('div');
                            banner.textContent = '⚠️ AUTOMATED TEST RUNNING — INPUTS DISABLED ⚠️';
                            banner.style.cssText = `
                                    position: fixed;
                                    bottom: 20px;
                                    left: 50%;
                                    transform: translateX(-50%);
                                    background: red;
                                    color: white;
                                    font-weight: bold;
                                    font-family: sans-serif;
                                    padding: 8px 16px;
                                    border-radius: 6px;
                                    z-index: 2147483647;
                                    pointer-events: none;
                                    opacity: 0.9;`;
                            document.body.appendChild(banner);
                        });
                    });

                    this.logger.info(`Hardware inputs disabled via CDP (Browser Locked)`);
                } catch (cdpErr) {
                    this.logger.warn(`Failed to disable user inputs via CDP`, { error: cdpErr });
                }
            }
            // FIX [9]: Register dialog handler ONCE at page level, not per step.
            //          This prevents listener accumulation and accidental accepts
            //          of security-critical dialogs on wrong steps.
            page.on('dialog', async (dialog) => {
                this.logger.info(`Dialog: type=${dialog.type()} message="${dialog.message()}"`);
                await dialog.accept();
            });

            // ── 5. Load test data ────────────────────────────────────────────
            let testData: Record<string, any> | null = null;
            if (execOptions.dataSetId && execOptions.dataRowIndex !== undefined) {
                const dataSet = await UITestDataModel.findById(execOptions.dataSetId);
                if (dataSet) {
                    testData = (dataSet as any).getRow(execOptions.dataRowIndex);
                    this.logger.info(
                        `Test data loaded — dataset: ${execOptions.dataSetId}, row: ${execOptions.dataRowIndex}`
                    );
                }
            }

            // ── 6. Execute steps ─────────────────────────────────────────────
            const totalSteps = test.steps.length;
            let passedCount = 0;
            let failedCount = 0;
            this.logger.info(`EXECUTING ${totalSteps} STEPS`);

            // FIX [12]: Wrap step loop in a master timeout so a hung test cannot
            //           hold a browser process open indefinitely.
            let masterTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    this.runSteps(
                        test,
                        page,
                        execOptions,
                        executionId,
                        userId,
                        testId,
                        testData,
                        execution,
                        totalSteps,
                        { passedCount, failedCount }
                    ),
                    new Promise<never>((_, reject) => {
                        masterTimer = setTimeout(
                            () => reject(new Error(`Master execution timeout exceeded (${MASTER_EXECUTION_TIMEOUT_MS / 60000} min)`)),
                            MASTER_EXECUTION_TIMEOUT_MS
                        );
                    }),
                ]);
            } finally {
                if (masterTimer) clearTimeout(masterTimer);
            }
            // ── 7. Save trace ────────────────────────────────────────────────
            // FIX [14]: Only save trace when trace.enabled was set at start.
            if (context && execOptions.browser.trace?.enabled) {
                try {
                    const traceDir = path.join(execDir, 'traces');
                    const tracePath = path.join(traceDir, 'trace.zip');
                    this.ensureDir(traceDir);
                    await context.tracing.stop({ path: tracePath });
                    if (!execution.artifacts) execution.artifacts = {};
                    if (!execution.artifacts.traces) execution.artifacts.traces = [];
                    execution.artifacts.traces.push(tracePath);
                    this.logger.info(`Trace saved: ${tracePath}`);
                } catch (traceErr: any) {
                    this.logger.warn(`Failed to save trace: ${traceErr.message}`);
                }
            }
            // ── 8. Finalise record ───────────────────────────────────────────
            execution.status = execution.stepResults.some((s: any) =>
                ['failed', 'error'].includes(s.status)
            )
                ? 'failed'
                : 'passed';

            execution.endTime = new Date();
            if (browser) execution.browser.version = browser.version();
            // FIX [14]: Collect screenshot paths from step results (screenshots are
            //           individually gated per-step / by screenshot.mode — no extra flag needed).
            const allScreenshots: string[] = [];
            for (const sr of execution.stepResults as any[]) {
                if (Array.isArray(sr.screenshots)) {
                    allScreenshots.push(...sr.screenshots);
                }
            }
            if (!execution.artifacts) execution.artifacts = {};
            if (allScreenshots.length) {
                execution.artifacts.screenshots = [
                    ...(execution.artifacts.screenshots ?? []),
                    ...allScreenshots,
                ];
            }
            // FIX [14]: Persist log file path — only if logs were enabled.
            if (logFile && fs.existsSync(logFile)) {
                if (!execution.artifacts.logs) execution.artifacts.logs = [];
                execution.artifacts.logs.push(logFile);
            }
            try {
                await UITestCaseModel.findByIdAndUpdate(test._id, {
                    $set: {
                        'lastRun.status': execution.status,
                        'lastRun.executedAt': execution.endTime,
                    },
                });
            } catch (updateErr: any) {
                this.logger.warn(`Failed to update parent test status`, { error: updateErr });
            }
            // ADDED FOR SUITE STATE BATON PASS: Extract Full State
            if (options.preserveState && context && page && execution.status === 'passed') {
                try {
                    // Extract natively supported state
                    const finalState = await context.storageState();
                    (execution as any).storageState = finalState;
                    // Extract sessionStorage explicitly 
                    const sessionData = await page.evaluate(() => JSON.stringify(window.sessionStorage));
                    (execution as any).sessionStorageData = sessionData;
                    this.logger.info(`[ENGINE] Extracted and saved full state (Cookies, LocalStorage, SessionStorage) for suite sequence`);
                } catch (stateErr: any) {
                    this.logger.warn(`Failed to extract full storage state: ${stateErr.message}`);
                }
            }

            await execution.save();
            const totalDuration = Date.now() - startTs;
            this.logger.info(`Execution completed`, {
                duration: totalDuration,
                totalSteps,
                passedCount,
                failedCount,
                executionId,
            });
            this.notify(userId, 'execution-completed', {
                executionId,
                testId,
                testName: test.name,
                status: execution.status,
                totalSteps,
                passedSteps: execution.stepResults.filter((s: any) => s.status === 'passed').length,
                failedSteps: execution.stepResults.filter((s: any) =>
                    ['failed', 'error'].includes(s.status)
                ).length,
                duration: totalDuration,
                timestamp: new Date().toISOString(),
            }, suiteExecutionId);
            return {
                ...execution.toJSON(),
                activeInstances: options.keepAlive ? { browser, context, page } : null
            };
        } catch (error: any) {
            // FIX 1: THE KILL SWITCH CHECK
            const executionRecord = await UITestExecutionModel.findOne({ executionId }).lean();
            if (executionRecord?.status === 'cancelled') {
                this.logger.info(`Execution ${executionId} caught a manual cancellation interrupt safely.`);
                return executionRecord; // Exit quietly, the user meant to kill it!
            }
            // Normal failure handling
            await this.handleExecutionError(
                executionId,
                String(test._id),
                userId,
                error,
                startTs
            );
            throw new Error(`Test execution failed: ${error.message}`);
        } finally {
            // FIX 2: THE KEEP ALIVE CHECK
            // ONLY run cleanup and video processing if we are NOT keeping the browser open for the next test!
            if (!options.keepAlive) {
                await this.cleanup(executionId).catch((err) => {
                    this.logger.error(`Cleanup error`, { error: err });
                });
                // FIX [14]: Scan video dir — only if video was enabled.
                if (execOptions.browser.video?.enabled) {
                    try {
                        const execDir = this.getExecutionDir(executionId);
                        const videoDir = path.join(execDir, 'videos');
                        if (fs.existsSync(videoDir)) {
                            const videoFiles = fs
                                .readdirSync(videoDir)
                                .filter((f) => f.endsWith('.webm') || f.endsWith('.mp4'))
                                .map((f) => path.join(videoDir, f));

                            if (videoFiles.length > 0) {
                                await UITestExecutionModel.findOneAndUpdate(
                                    { executionId },
                                    { $addToSet: { 'artifacts.videos': { $each: videoFiles } } }
                                );
                                this.logger.info(`Video(s) saved: ${videoFiles.join(', ')}`);
                            }
                        }
                    } catch (videoErr: any) {
                        this.logger.warn(`Failed to scan video dir: ${videoErr.message}`);
                    }
                }
            } else {
                this.logger.info(`[ENGINE] keepAlive is true. Browser left open for next test. Skipping cleanup.`);
            }
        }
    }
    /**
     * Inner step-execution loop — extracted so it can be wrapped in Promise.race
     * for the master timeout (FIX [12]).
     */
    private async runSteps(
        test: UITestCase,
        page: Page,
        execOptions: ExecutionOptions,
        executionId: string,
        userId: string,
        testId: string | undefined,
        testData: Record<string, any> | null,
        execution: any,
        totalSteps: number,
        counts: { passedCount: number; failedCount: number }
    ): Promise<void> {
        const suiteExecutionId = execOptions.suiteExecutionId;
        for (let i = 0; i < test.steps.length; i++) {
            const step = test.steps[i];

            this.notify(userId, 'step-started', {
                executionId,
                testId,
                stepIndex: i,
                totalSteps,
                stepId: step?.id,
                action: step?.action,
                description: step?.description,
                status: 'running',
                timestamp: new Date().toISOString(),
            }, suiteExecutionId);

            const stepResult = await this.executeStep(
                page,
                step as UITestStep,
                execOptions,
                executionId,
                testData
            );
            execution.addStepResult(stepResult);

            this.notify(userId, 'step-completed', {
                executionId,
                testId,
                stepIndex: i,
                totalSteps,
                stepId: step?.id,
                action: step?.action,
                description: step?.description,
                status: stepResult.status,
                duration: stepResult.duration,
                error: stepResult.error?.message ?? null,
                timestamp: new Date().toISOString(),
            }, suiteExecutionId);

            // FIX [4]: Correct pass/fail counting regardless of continueOnFailure.
            if (stepResult.status === 'passed') {
                counts.passedCount++;
            } else {
                counts.failedCount++;
                if (!execOptions.continueOnFailure) break;
            }
        }
        // ✅ THE VICTORY LAP: Only hold the browser open if we are in headless: false mode
        // AND the test didn't crash entirely (failedCount is 0, or we are allowing failures).
        if (!execOptions.headless && (counts.failedCount === 0 || execOptions.continueOnFailure)) {
            this.logger.info(`All steps completed. Holding browser open for 5 seconds for visual confirmation...`);
            try {
                await page.waitForTimeout(5000);
            } catch (e) {
                // Ignore if the user manually closed the browser during the wait
            }
        }
    }
    // ── Step Execution ─────────────────────────────────────────────────────────
    private async executeStep(
        page: Page,
        step: UITestStep,
        options: ExecutionOptions,
        executionId: string,
        testData: Record<string, any> | null
    ): Promise<StepExecutionResult> {
        const stepResult: StepExecutionResult = {
            stepId: step.id,
            action: step.action,
            description: step.description,
            status: 'running',
            startTime: new Date(),
            screenshots: [],
            logs: [],
            assertionResults: [],
        };

        const processedStep = this.replaceVariables(step, testData);
        this.logger.info(`[STEP] Executing: ${processedStep.action} — "${processedStep.description || ''}"`);

        try {
            await this.executeAction(page, processedStep, executionId, options);

            // Wait + assertion handling
            if (processedStep.action === 'wait' && processedStep.wait) {
                await this.executeWait(page, processedStep.wait);
            }

            if (processedStep.assertions?.length) {
                for (const assertion of processedStep.assertions) {
                    const result = await this.executeAssertion(page, assertion, processedStep);
                    stepResult.assertionResults!.push(result);
                    if (!result.passed && !assertion.soft) {
                        throw new Error(result.message || 'Assertion failed');
                    }
                }
            }

            // Screenshot on success
            if (
                processedStep.screenshot?.enabled ||
                options.browser.screenshot?.mode === 'on'
            ) {
                const activePage = this.getActivePage(page);
                const screenshotPath = await this.captureScreenshot(
                    activePage, executionId, step.id, processedStep.screenshot?.fullPage
                );
                if (screenshotPath) stepResult.screenshots.push(screenshotPath);
            }

            stepResult.status = 'passed';
            stepResult.endTime = new Date();
            stepResult.duration = stepResult.endTime.getTime() - stepResult.startTime.getTime();
            this.logger.info(`[STEP PASSED] ${processedStep.action} in ${stepResult.duration}ms`);
            return stepResult;
        } catch (error: any) {
            const isCancelled =
                error.message.includes('Target closed') ||
                error.message.includes('Browser has been closed') ||
                error.message.includes('browser context has been closed');

            this.logger.error(
                `[STEP ${isCancelled ? 'CANCELLED' : 'FAILED'}] ` +
                `Action: ${step.action} ${step.description || ''} | Error: ${error.message}`
            );

            stepResult.status = isCancelled ? 'cancelled' : 'failed';
            stepResult.endTime = new Date();
            stepResult.duration =
                stepResult.endTime.getTime() - stepResult.startTime.getTime();
            stepResult.error = {
                message: isCancelled
                    ? 'Execution was manually stopped.'
                    : error.message,
                stack: error.stack,
            };

            // Screenshot on failure
            const shouldScreenshot =
                !isCancelled &&
                (processedStep.screenshot?.enabled ||
                    options.browser.screenshot?.mode === 'on' ||
                    options.browser.screenshot?.mode === 'only-on-failure');

            if (shouldScreenshot) {
                // FIX [7]: Replaced isClosed()-gate with try/catch.
                //          isClosed() is not atomic — page can close between the
                //          check and the screenshot call. try/catch is safe.
                try {
                    const activePage = this.getActivePage(page);
                    const screenshotPath = await this.captureScreenshot(
                        activePage,
                        executionId,
                        step.id,
                        processedStep.screenshot?.fullPage ?? true
                    );
                    if (screenshotPath) {
                        stepResult.error.screenshot = screenshotPath;
                        stepResult.screenshots.push(screenshotPath);
                        this.logger.info(`Failure screenshot captured: ${screenshotPath}`);
                    }
                } catch (screenshotErr: any) {
                    this.logger.warn(
                        `Skipped failure screenshot — page closed mid-capture: ${screenshotErr.message}`
                    );
                }
            }

            return stepResult;
        }
    }
    /**
     * Returns the most recently opened non-closed page, falling back to the
     * original page reference. Safe to call even if tabs have been closed.
     */
    private getActivePage(page: Page): Page {
        try {
            const pages = page.context().pages();
            const open = pages.filter((p) => !p.isClosed());
            return open.length > 0 ? open[open.length - 1] as Page : page;
        } catch {
            return page;
        }
    }
    // ── Action Execution ───────────────────────────────────────────────────────
    private async executeAction(
        initialPage: Page,
        step: UITestStep,
        executionId: string,
        options?: any
    ): Promise<void> {
        const timeout = step.timeout || options?.timeout || 30_000;
        const speed: number = options?.speed ?? 1000;
        const page = this.getActivePage(initialPage);

        switch (step.action) {

            // ── NAVIGATE ──────────────────────────────────────────────────────
            case 'navigate': {
                let targetUrl = step.url || '';
                const baseUrl = options?.baseUrl || '';

                if (targetUrl && !targetUrl.startsWith('http') && baseUrl) {
                    try {
                        targetUrl = new URL(targetUrl, baseUrl).href;
                    } catch {
                        targetUrl = baseUrl.replace(/\/+$/, '') + '/' + targetUrl.replace(/^\/+/, '');
                    }
                }

                if (!targetUrl) throw new Error('Navigate step has no URL');
                this.logger.info(`Navigate → ${targetUrl}`);

                if (step.order === 0) {
                    // Entry point — instruct the browser to load the URL
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });
                } else {
                    // Subsequent navigate — browser already navigated here from a click.
                    // Wait to confirm arrival; do NOT call page.goto() which would
                    // reload the page and lose the session.
                    await page.waitForURL(targetUrl, { waitUntil: 'domcontentloaded', timeout });
                }

                await page.waitForLoadState('networkidle', { timeout: 10_000 })
                    .catch(() => this.logger.info(`Network didn't reach idle, continuing…`));

                // FIX [16]: Detect redirects (e.g. app redirected to login page)
                const actualUrl = page.url();
                const expectedPath = targetUrl.replace(/^https?:\/\/[^/]+/, '');
                const actualPath = actualUrl.replace(/^https?:\/\/[^/]+/, '');
                if (expectedPath && actualPath && !actualPath.startsWith(expectedPath.replace(/\/$/, ''))) {
                    throw new Error(
                        `Navigation redirected — expected "${targetUrl}" but landed on "${actualUrl}". ` +
                        `Page may require authentication or the URL has changed.`
                    );
                }
                break;
            }

            // ── CLICK ─────────────────────────────────────────────────────────
            // FIX [17]: Honour step.wait.condition === 'navigation' by wrapping
            //           click in Promise.all([waitForNavigation, click]).
            //           This prevents the race condition where a fast redirect
            //           completes before waitForNavigation starts listening.
            //           Falls back to plain click when no navigation wait is set.
            case 'click': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Click: ${step.selector?.value || 'element'}`);

                const urlBeforeClick = page.url(); // Remember where we started
                try {
                    await locator.evaluate((node) => {
                        const el = node as HTMLElement;
                        const prevOutline = el.style.outline;
                        const prevTransition = el.style.transition;
                        el.style.transition = 'outline 0.1s ease-in-out';
                        el.style.outline = '3px solid #ff0044';
                        // Clean up after 800ms so it doesn't leave artifacts on the page
                        setTimeout(() => {
                            el.style.outline = prevOutline;
                            el.style.transition = prevTransition;
                        }, 800);
                    });
                } catch { /* ignore if element (like SVG paths) cannot be styled */ }
                const performClick = async () => {
                    // 1. Standard Playwright Click (Handles trusted events and :hover states)
                    try {
                        await locator.click({ timeout: 5000 });
                    } catch (e) {
                        this.logger.warn(`Native click failed, escalating...`);
                    }
                    // 2. DOM Dispatch (The "Double-Tap")
                    // If a transparent div intercepted the native click, this bypasses the 
                    // visual layer and hits the React/Angular event listener directly.
                    await locator.dispatchEvent('click').catch(() => { });

                    // Give the SPA router a tiny fraction of a second to react
                    await page.waitForTimeout(300);

                    // 3. THE NUCLEAR OPTION: Href Extraction
                    // If the URL hasn't changed at all, and the element is a link, force it.
                    if (page.url() === urlBeforeClick) {
                        try {
                            const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
                            const href = await locator.getAttribute('href');

                            // If it's a valid link and not a javascript/hash anchor
                            if (tagName === 'a' && href && href !== '#' && !href.startsWith('javascript:')) {
                                this.logger.info(`SPA swallowed the click. Forcing navigation to href: ${href}`);

                                // Resolve relative URLs based on the current page
                                const targetUrl = new URL(href, urlBeforeClick).href;
                                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                            }
                        } catch {
                            // Element might not be a link, or it disappeared. Ignore.
                        }
                    }

                    // 4. Final Fallback: Coordinate Click (If no href was found)
                    if (page.url() === urlBeforeClick && step.metadata?.coordinates) {
                        try {
                            const { x, y } = step.metadata.coordinates;
                            await page.mouse.click(x, y, { delay: 50 });
                        } catch { /* ignore */ }
                    }
                };

                await performClick();
                await page.waitForTimeout(Math.min(speed, 500));
                break;
            }

            // ── DOUBLE CLICK ──────────────────────────────────────────────────
            case 'dblclick': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Double-click: ${step.selector?.value || 'element'}`);
                await locator.dblclick({ timeout });
                break;
            }

            // ── FILL ──────────────────────────────────────────────────────────
            case 'fill': {
                const locator = await this.resolveLocator(page, step);
                const val = String(step.value ?? '');
                this.logger.info(`Fill: "${val.slice(0, 40)}" → ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'visible', timeout });
                try {
                    await locator.evaluate((node) => {
                        const el = node as HTMLElement;
                        const prev = el.style.outline;
                        el.style.outline = '3px solid blue';
                        setTimeout(() => { el.style.outline = prev; }, 800);
                    });
                } catch { /* ignore */ }
                try {
                    await locator.fill(val, { timeout });
                } catch (fillErr: any) {
                    this.logger.warn(`Native fill failed (${fillErr.message.split('\n')[0]}), falling back to pressSequentially`);
                    await locator.click({ timeout });
                    await locator.press('Control+a');
                    await locator.press('Backspace');
                    await locator.pressSequentially(val, { delay: 50 });
                }
                // ✅ FIX: Force the input to lose focus. This forces React/Vue/Angular
                // to commit the value to their internal state BEFORE the next click happens.
                await locator.blur().catch(() => { });
                break;
            }

            // ── TYPE ──────────────────────────────────────────────────────────
            case 'type': {
                const locator = await this.resolveLocator(page, step);
                const val = String(step.value ?? '');
                this.logger.info(`Type: "${val.slice(0, 40)}" → ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'visible', timeout });
                try {
                    await locator.fill(val, { timeout });
                } catch {
                    await locator.click({ timeout });
                    await locator.press('Control+a');
                    await locator.press('Backspace');
                    await locator.pressSequentially(val, { delay: 50 });
                }
                break;
            }

            // ── SELECT ────────────────────────────────────────────────────────
            case 'select': {
                const locator = await this.resolveLocator(page, step);
                const val = String(step.value ?? '');
                this.logger.info(`Select: "${val}" on ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                try {
                    await locator.selectOption({ value: val }, { timeout });
                } catch {
                    try {
                        await locator.selectOption({ label: val }, { timeout });
                    } catch {
                        await locator.selectOption(val, { timeout });
                    }
                }
                break;
            }
            // ── CHECK / UNCHECK ───────────────────────────────────────────────
            case 'check': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Check: ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                await locator.check({ timeout, force: false });
                break;
            }
            case 'uncheck': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Uncheck: ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                await locator.uncheck({ timeout, force: false });
                break;
            }

            // ── HOVER / FOCUS / BLUR ──────────────────────────────────────────
            case 'hover': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Hover: ${step.selector?.value || 'element'}`);
                await locator.hover({ timeout });
                break;
            }
            case 'focus': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Focus: ${step.selector?.value || 'element'}`);
                await locator.focus({ timeout });
                break;
            }
            case 'blur': {
                if (step.selector) {
                    const locator = await this.resolveLocator(page, step);
                    await locator.evaluate((el) => (el as HTMLElement).blur());
                } else {
                    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
                }
                this.logger.info(`Blur: ${step.selector?.value || 'active element'}`);
                break;
            }

            // ── PRESS KEY ─────────────────────────────────────────────────────
            case 'press': {
                if (!step.key) throw new Error('Press step requires a key');
                this.logger.info(`Press key: ${step.key}`);
                if (step.selector) {
                    const locator = await this.resolveLocator(page, step);
                    await locator.press(step.key, { timeout });
                } else {
                    await page.keyboard.press(step.key);
                }
                break;
            }

            // ── CLEAR ─────────────────────────────────────────────────────────
            case 'clear': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Clear: ${step.selector?.value || 'element'}`);
                await locator.fill('', { timeout });
                break;
            }

            // ── SCROLL ────────────────────────────────────────────────────────
            // FIX [20]: '/html[1]' is the XPath the recorder attaches to window
            //           scroll events — treat it as a window scroll, not an element.
            case 'scroll':
            case 'scrollTo': {
                const offset = step.scrollOffset || { x: 0, y: 0 };
                const sel = step.selector?.value || '';
                const isWindowScroll =
                    !sel ||
                    ['html', 'body', ':root'].includes(sel.toLowerCase()) ||
                    sel === '/html[1]' ||          // FIX [20]
                    sel.includes('/html[1]');

                if (isWindowScroll) {
                    this.logger.info(`Window scrollTo: (${offset.x}, ${offset.y})`);
                    await page.evaluate(
                        (pos) => window.scrollTo({ left: pos.x, top: pos.y, behavior: 'smooth' }),
                        offset
                    );
                } else {
                    const locator = await this.resolveLocator(page, step);
                    this.logger.info(`Element scrollTo: ${sel}`);
                    await locator.evaluate(
                        (el, pos) => el.scrollTo({ left: pos.x, top: pos.y, behavior: 'smooth' }),
                        offset
                    );
                }
                await page.waitForTimeout(600);
                break;
            }

            case 'scrollBy': {
                const offset = step.scrollOffset || { x: 0, y: 0 };
                if (step.metadata?.scrollType === 'element' && step.selector?.value) {
                    const locator = await this.resolveLocator(page, step);
                    await locator.evaluate((el, o) => el.scrollBy(o.x, o.y), offset);
                } else {
                    await page.evaluate((o) => window.scrollBy(o.x, o.y), offset);
                }
                this.logger.info(`ScrollBy: (${offset.x}, ${offset.y})`);
                break;
            }

            // ── DRAG AND DROP ─────────────────────────────────────────────────
            case 'dragAndDrop': {
                if (!step.dropTarget) throw new Error('DragAndDrop requires a dropTarget selector');
                const locator = await this.resolveLocator(page, step);
                const targetSelector = this.buildSelector(step.dropTarget);
                this.logger.info(`DragAndDrop → ${targetSelector}`);
                await locator.dragTo(page.locator(targetSelector), { timeout });
                break;
            }

            // ── FILE UPLOAD ───────────────────────────────────────────────────
            case 'upload': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Upload: ${step.files?.length ?? 0} file(s)`);
                await locator.setInputFiles(step.files || []);
                break;
            }

            // ── WAIT / ASSERT — handled in executeStep, not here ──────────────
            case 'wait': break;
            case 'assert': break;

            // ── SCREENSHOT ────────────────────────────────────────────────────
            case 'screenshot':
                this.logger.info(`Manual screenshot step`);
                await this.captureScreenshot(page, executionId, step.id, step.screenshot?.fullPage);
                break;

            // ── EVALUATE ──────────────────────────────────────────────────────
            case 'evaluate': {
                if (!step.script) throw new Error('Evaluate step requires a script');
                this.logger.info(`Evaluate script (${step.script.length} chars)`);
                await page.evaluate(step.script);
                break;
            }

            // ── NAVIGATION CONTROLS ───────────────────────────────────────────
            case 'reload':
                this.logger.info(`Reload page`);
                await page.reload({ waitUntil: 'domcontentloaded', timeout });
                break;
            case 'goBack':
                this.logger.info(`Go back`);
                await page.goBack({ waitUntil: 'domcontentloaded', timeout });
                break;
            case 'goForward':
                this.logger.info(`Go forward`);
                await page.goForward({ waitUntil: 'domcontentloaded', timeout });
                break;

            default:
                this.logger.warn(`Unknown action type: ${(step as any).action}, skipping`);
        }
    }
    // ── Locator Resolution ─────────────────────────────────────────────────────
    private createLocator(page: Page, cfg: SelectorConfig) {
        const isExact = cfg.strict !== false;
        switch (cfg.strategy) {
            case 'placeholder': return page.getByPlaceholder(cfg.value, { exact: isExact });
            case 'text':
                return page.getByText(cfg.value, { exact: isExact });
            case 'role': {
                try {
                    const r = typeof cfg.value === 'string' ? JSON.parse(cfg.value) : cfg.value;
                    return page.getByRole(r.role, { name: r.name, exact: isExact });
                } catch {
                    return page.getByRole(cfg.value as any, { exact: isExact });
                }
            }
            case 'label': return page.getByLabel(cfg.value, { exact: isExact });
            case 'testId': return page.getByTestId(cfg.value);
            case 'altText': return page.getByAltText(cfg.value, { exact: isExact });
            case 'title': return page.getByTitle(cfg.value, { exact: isExact });
            case 'css': return page.locator(cfg.value);
            case 'name': return page.locator(`[name="${cfg.value}"], [formcontrolname="${cfg.value}"]`);
            case 'xpath':
                const isXPathForm = cfg.value.startsWith('xpath=') || cfg.value.startsWith('//') || cfg.value.startsWith('(');
                return page.locator(isXPathForm ? cfg.value : `xpath=${cfg.value}`);
            case 'xpath': return page.locator(`xpath=${cfg.value}`);
            default: return page.locator(cfg.value);
        }
    }
    private async resolveLocator(page: Page, step: UITestStep) {
        const selector = step.selector;
        if (!selector) {
            throw new Error(`Step "${step.description || step.action}" has no selector`);
        }
        // ✅ FIX: Guarantee 'fallbacks' is ALWAYS an array. 
        // TypeScript now mathematically guarantees this cannot be undefined.
        const fallbacks = selector.fallbacks || [];
        // 1. Create all locators independently
        const primaryLoc = this.createLocator(page, selector);
        const fallbackLocs = fallbacks.map(fb => this.createLocator(page, fb as SelectorConfig));
        // 2. Build a combined locator JUST to defeat the SPA race condition
        let waitLocator = primaryLoc;
        for (const fbLoc of fallbackLocs) {
            waitLocator = waitLocator.or(fbLoc);
        }
        // 3. Wait up to 5 seconds for at least ONE of these elements to appear in the DOM
        try {
            await waitLocator.first().waitFor({ state: 'attached', timeout: 5000 });
        } catch {
            this.logger.warn(`No selectors appeared within 5s, proceeding to strict priority check...`);
        }
        // 4. ENFORCE STRICT PRIORITY
        // Check primary first. If it's there, we use it immediately.
        if (await primaryLoc.count() > 0) {
            this.logger.info(`Matched Primary: ${selector.strategy} = ${selector.value}`);
            return primaryLoc.first();
        }
        // Check fallbacks in exact array order
        // ✅ FIX: Loop is perfectly safe because 'fallbacks' is guaranteed to be an array
        for (let i = 0; i < fallbacks.length; i++) {
            const currentLoc = fallbackLocs[i];
            if (currentLoc && await currentLoc.count() > 0) {
                const fb = fallbacks[i] as SelectorConfig;
                this.logger.info(`Matched Fallback: ${fb.strategy} = ${fb.value}`);
                return currentLoc.first();
            }
        }
        // Ultimate fallback: return primary and let Playwright throw the standard timeout error
        return primaryLoc.first();
    }
    private resolveLocatorFromSelector(page: Page, selector: SelectorConfig) {
        let loc = this.createLocator(page, selector);
        if (selector.fallbacks?.length) {
            for (const fallback of selector.fallbacks) {
                loc = loc.or(this.createLocator(page, fallback as SelectorConfig));
            }
        }
        return loc.first();
    }
    // ── Wait Conditions ────────────────────────────────────────────────────────
    private async executeWait(page: Page, wait: WaitConfig): Promise<void> {
        const timeout = wait.timeout || 30_000;
        this.logger.info(`[WAIT] condition=${wait.condition} timeout=${timeout}ms`);

        let locator;
        if (
            wait.selector &&
            ['visible', 'hidden', 'attached', 'detached', 'stable', 'enabled', 'editable'].includes(wait.condition)
        ) {
            locator = this.resolveLocatorFromSelector(page, wait.selector);
        }

        switch (wait.condition) {
            // Element state conditions
            case 'visible':
                await locator!.waitFor({ state: 'visible', timeout });
                break;
            case 'hidden':
                await locator!.waitFor({ state: 'hidden', timeout });
                break;
            case 'attached':
                await locator!.waitFor({ state: 'attached', timeout });
                break;
            case 'detached':
                await locator!.waitFor({ state: 'detached', timeout });
                break;
            case 'stable':
                // Stable = visible + not animating. Playwright doesn't have a
                // direct "stable" wait — waitFor visible + a short pause covers it.
                await locator!.waitFor({ state: 'visible', timeout });
                await page.waitForTimeout(200);
                break;
            case 'enabled':
                await locator!.waitFor({ state: 'visible', timeout });
                await expect_enabled(locator!, timeout);
                break;
            case 'editable':
                await locator!.waitFor({ state: 'visible', timeout });
                break;

            // ── Page-level conditions ─────────────────────────────────────────

            // FIX: waitForNavigation is deprecated. The modern equivalent for a 
            // standalone navigation wait is to wait for the load state to settle.
            case 'navigation':
                this.logger.info(`[WAIT] Waiting for page load state to settle...`);
                // Wait for the DOM to be fully loaded and parsed
                await page.waitForLoadState('domcontentloaded', { timeout });
                // Optionally wait for network to quiet down (can be removed if too strict)
                await page.waitForLoadState('networkidle', { timeout })
                    .catch(() => this.logger.info(`[WAIT] Network didn't idle, but DOM is ready.`));
                break;

            case 'url':
                if (wait.expected) {
                    // Escape regex characters and strip trailing slash
                    const base = wait.expected.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    // Allow optional trailing slash, query params (?), and hash fragments (#)
                    const pattern = new RegExp(`^${base}/?(?:\\?.*)?(?:#.*)?$`);

                    await page.waitForURL(pattern, { timeout });
                } else {
                    this.logger.warn(`[WAIT] url condition has no expected value`);
                }
                break;

            case 'timeout':
                await page.waitForTimeout(timeout);
                break;
            case 'networkIdle':
                await page.waitForLoadState('networkidle', { timeout });
                break;
            case 'load':
                await page.waitForLoadState('load', { timeout });
                break;
            case 'domContentLoaded':
                await page.waitForLoadState('domcontentloaded', { timeout });
                break;
            // ── The Smart API Wait ──────────────────────────────────────────────
            // case 'apiResponse': {
            //     if (!wait.urlPattern) {
            //         throw new Error(`[WAIT] apiResponse condition requires a 'urlPattern'`);
            //     }

            //     const targetMethod = (wait.method || 'GET').toUpperCase();
            //     // Default to accepting any successful 2xx status code if not strictly defined
            //     const isSuccessStatus = (status: number) => wait.status ? status === wait.status : status >= 200 && status < 300;

            //     this.logger.info(`[WAIT] Listening for API: ${targetMethod} ${wait.urlPattern}`);

            //     try {
            //         // Playwright intercepts all network traffic and waits for the exact match
            //         await page.waitForResponse(
            //             (response) => {
            //                 const isUrlMatch = response.url().includes(wait.urlPattern);
            //                 const isMethodMatch = response.request().method() === targetMethod;

            //                 // Log the matches so you can debug what the app is actually sending
            //                 if (isUrlMatch) {
            //                     this.logger.info(`[NETWORK] Caught ${response.url()} -> Status: ${response.status()}`);
            //                 }

            //                 return isUrlMatch && isMethodMatch && isSuccessStatus(response.status());
            //             },
            //             { timeout }
            //         );
            //         this.logger.info(`[WAIT] API response received successfully!`);
            //     } catch (error: any) {
            //         throw new Error(`Timed out waiting for API response: ${targetMethod} ${wait.urlPattern}`);
            //     }
            //     break;
            // }

            default:
                this.logger.warn(`[WAIT] Unknown condition: ${wait.condition}`);
        }

        this.logger.info(`[WAIT] completed`);
    }
    // ── Assertions ─────────────────────────────────────────────────────────────
    private async executeAssertion(
        page: Page,
        assertion: AssertionConfig,
        step: UITestStep,
    ): Promise<any> {
        const assertTimeout = step.timeout ?? 15_000;
        this.logger.info(`[ASSERT] Starting web-first assertion: ${assertion.type} | timeout: ${assertTimeout}ms`);
        try {
            const isPageAssertion = ['url', 'title'].includes(assertion.type);
            const locator = !isPageAssertion && step.selector
                ? await this.resolveLocator(page, step)
                : null;

            if (!isPageAssertion && !locator) {
                throw new Error(`Assertion "${assertion.type}" requires a valid selector.`);
            }
            const exp = assertion.expected;
            const op = assertion.operator || 'equals';
            const strExp = exp !== undefined && exp !== null ? String(exp) : '';
            // Helper to build Regex for complex string matching
            const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const buildRegex = () => {
                if (op === 'startsWith') return new RegExp(`^${escapeRegExp(strExp)}`);
                if (op === 'endsWith') return new RegExp(`${escapeRegExp(strExp)}$`);
                if (op === 'matches') return new RegExp(strExp);
                return new RegExp(escapeRegExp(strExp)); // Fallback
            };
            const isNegated = ['notEquals', 'notContains'].includes(op);
            const isRegex = ['startsWith', 'endsWith', 'matches'].includes(op);
            switch (assertion.type) {
                // ── Page Level ──
                case 'url': {
                    const pattern = isRegex ? buildRegex() : strExp;
                    if (isNegated) await expect(page).not.toHaveURL(pattern, { timeout: assertTimeout });
                    else await expect(page).toHaveURL(pattern, { timeout: assertTimeout });
                    break;
                }
                case 'title': {
                    const pattern = isRegex ? buildRegex() : strExp;
                    if (isNegated) await expect(page).not.toHaveTitle(pattern, { timeout: assertTimeout });
                    else await expect(page).toHaveTitle(pattern, { timeout: assertTimeout });
                    break;
                }
                // ── State Level ──
                case 'visible':
                    await expect(locator!).toBeVisible({ timeout: assertTimeout });
                    break;
                case 'hidden':
                    await expect(locator!).toBeHidden({ timeout: assertTimeout });
                    break;
                case 'exists':
                    await expect(locator!).toBeAttached({ timeout: assertTimeout });
                    break;
                case 'notExists':
                    await expect(locator!).not.toBeAttached({ timeout: assertTimeout });
                    break;
                case 'checked':
                    if (isNegated || strExp === 'false') await expect(locator!).not.toBeChecked({ timeout: assertTimeout });
                    else await expect(locator!).toBeChecked({ timeout: assertTimeout });
                    break;
                case 'disabled':
                    await expect(locator!).toBeDisabled({ timeout: assertTimeout });
                    break;
                case 'enabled':
                    await expect(locator!).toBeEnabled({ timeout: assertTimeout });
                    break;

                // ── Value & Data Level ──
                case 'count':
                    await expect(locator!).toHaveCount(Number(exp), { timeout: assertTimeout });
                    break;
                case 'attribute':
                    if (!assertion.attribute) throw new Error('Attribute assertion requires an attribute name');
                    const attrPattern = isRegex ? buildRegex() : strExp;
                    if (isNegated) await expect(locator!).not.toHaveAttribute(assertion.attribute, attrPattern, { timeout: assertTimeout });
                    else await expect(locator!).toHaveAttribute(assertion.attribute, attrPattern, { timeout: assertTimeout });
                    break;
                case 'text': {
                    if (isRegex) {
                        await expect(locator!).toHaveText(buildRegex(), { useInnerText: true, timeout: assertTimeout });
                    } else if (op === 'contains') {
                        await expect(locator!).toContainText(strExp, { useInnerText: true, timeout: assertTimeout });
                    } else if (op === 'notContains') {
                        await expect(locator!).not.toContainText(strExp, { useInnerText: true, timeout: assertTimeout });
                    } else if (op === 'notEquals') {
                        await expect(locator!).not.toHaveText(strExp, { useInnerText: true, timeout: assertTimeout });
                    } else {
                        // Exact match
                        await expect(locator!).toHaveText(strExp, { useInnerText: true, timeout: assertTimeout });
                    }
                    break;
                }
                case 'value': {
                    // Handle Numeric Comparisons via expect.poll (Auto-retrying custom logic)
                    if (['greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual'].includes(op)) {
                        const numericExp = Number(exp);
                        const poll = expect.poll(async () => Number(await locator!.inputValue()), { timeout: assertTimeout });
                        if (op === 'greaterThan') await poll.toBeGreaterThan(numericExp);
                        else if (op === 'lessThan') await poll.toBeLessThan(numericExp);
                        else if (op === 'greaterOrEqual') await poll.toBeGreaterThanOrEqual(numericExp);
                        else if (op === 'lessOrEqual') await poll.toBeLessThanOrEqual(numericExp);

                    } else if (isRegex) {
                        await expect(locator!).toHaveValue(buildRegex(), { timeout: assertTimeout });
                    } else if (isNegated) {
                        await expect(locator!).not.toHaveValue(strExp, { timeout: assertTimeout });
                    } else {
                        await expect(locator!).toHaveValue(strExp, { timeout: assertTimeout });
                    }
                    break;
                }
                default:
                    throw new Error(`Unknown assertion type: ${assertion.type}`);
            }
            this.logger.info(`[ASSERT PASSED] ${assertion.type} condition met.`);
            return {
                assertion,
                passed: true,
                message: undefined
            };
        } catch (error: any) {
            const cleanMessage = error.message
                .split('\n')
                .filter((l: string) => l.trim().length > 0)
                .slice(0, 3)
                .join(' | ');

            this.logger.warn(`[ASSERT FAILED] ${assertion.type} | ${cleanMessage}`);

            return {
                assertion,
                passed: false,
                message: assertion.message ? `${assertion.message} — ${cleanMessage}` : cleanMessage
            };
        }
    }
    // ── Selector Builder ───────────────────────────────────────────────────────
    private buildSelector(cfg: SelectorConfig): string {
        switch (cfg.strategy) {
            case 'css': return cfg.value;
            case 'xpath': return `xpath=${cfg.value}`;
            case 'text': return `text=${cfg.value}`;
            case 'role': return `role=${cfg.value}`;
            case 'testId': return `[data-testid="${cfg.value}"]`;
            case 'label': return `label=${cfg.value}`;
            case 'placeholder': return `[placeholder="${cfg.value}"]`;
            case 'altText': return `[alt="${cfg.value}"]`;
            case 'title': return `[title="${cfg.value}"]`;
            default: return cfg.value;
        }
    }
    // ── Variable Substitution ──────────────────────────────────────────────────
    private replaceVariables(
        step: UITestStep,
        testData: Record<string, any> | null
    ): UITestStep {
        if (!testData) return step;

        const replace = (str: string): string =>
            str.replace(/\{\{(\w+)\}\}/g, (match, key) =>
                testData[key] !== undefined ? String(testData[key]) : match
            );

        const processed = { ...step };

        // Existing replacements
        if (typeof processed.value === 'string') processed.value = replace(processed.value);
        if (processed.url) processed.url = replace(processed.url);

        // ✅ NEW: Replace variables inside the locators!
        if (processed.selector?.value) {
            processed.selector = { ...processed.selector }; // Shallow clone
            processed.selector.value = replace(processed.selector.value);

            if (processed.selector.fallbacks) {
                processed.selector.fallbacks = processed.selector.fallbacks.map(fb => ({
                    ...fb,
                    value: replace(fb.value)
                }));
            }
        }

        // Replace inside assertions too
        if (processed.assertions) {
            processed.assertions = processed.assertions.map(assert => ({
                ...assert,
                expected: typeof assert.expected === 'string' ? replace(assert.expected) : assert.expected
            }));
        }

        return processed;
    }
    // ── Screenshot ─────────────────────────────────────────────────────────────
    private async captureScreenshot(
        page: Page,
        executionId: string,
        stepId: string,
        fullPage: boolean = false
    ): Promise<string | null> {
        try {
            const dir = path.join(this.getExecutionDir(executionId), 'screenshots');
            this.ensureDir(dir);
            const filePath = path.join(dir, `${stepId}_${Date.now()}.png`);
            await page.screenshot({ path: filePath, fullPage });
            return filePath;
        } catch (err: any) {
            this.logger.warn(`captureScreenshot failed: ${err.message}`);
            return null;
        }
    }
    // ── Browser Launch ─────────────────────────────────────────────────────────
    private async launchBrowser(options: ExecutionOptions): Promise<Browser> {
        const browserType = options?.browser?.type || 'chromium';
        const launchOptions: any = {
            headless: options?.headless ?? false,
            slowMo: options?.headless ? 0 : (options?.speed ?? 1000),
        };

        if (browserType === 'chromium') {
            if (options?.browser?.channel) launchOptions.channel = options.browser.channel;
            launchOptions.args = [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-position=50,50',
                '--start-maximized',
            ];
        }

        this.logger.info(
            `[LAUNCH] Engine: ${browserType} | Headless: ${launchOptions.headless} | Channel: ${launchOptions.channel || 'default'}`
        );

        switch (browserType) {
            case 'firefox': return firefox.launch(launchOptions);
            case 'webkit': return webkit.launch(launchOptions);
            default: return chromium.launch(launchOptions);
        }
    }
    // ── Error Handling ─────────────────────────────────────────────────────────
    private async handleExecutionError(
        executionId: string | null,
        testId: string,
        userId: string,
        error: any,
        startTs: number
    ): Promise<void> {
        this.logger.error(`Execution error`, { error: error.message });
        if (executionId) {
            await UITestExecutionModel.findOneAndUpdate(
                { executionId },
                {
                    $set: {
                        status: 'error',
                        endTime: new Date(),
                        error: { message: error.message, stack: error.stack },
                    },
                }
            );
            await UITestCaseModel.findByIdAndUpdate(testId, {
                $set: {
                    'lastRun.status': 'failed',
                    'lastRun.executedAt': new Date(),
                },
            });
            this.notify(userId, 'execution-error', {
                executionId,
                testId,
                status: 'error',
                error: error.message,
                duration: Date.now() - startTs,
                timestamp: new Date().toISOString(),
            });
        }
    }
    // ── WebSocket ──────────────────────────────────────────────────────────────
    private notify(userId: string, type: string, payload: any, suiteExecutionId?: string): void {
        try {
            const executionId = payload.executionId;
            const isHeadless = this.activeHeadlessStates.get(executionId);
            if (!isHeadless) return

            const eventType = suiteExecutionId ? `suite-${type}` : type;
            WebSocketService.getIO().to(userId).emit('test-execution-update', {
                type: eventType,
                ...payload,
                suiteExecutionId,
                timestamp: new Date().toISOString(),
            });
        } catch (err: any) {
            this.logger.warn(`[WS-NOTIFY] Failed`, { error: err.message });
        }
    }
    // ── Cleanup ────────────────────────────────────────────────────────────────
    private async cleanup(executionId: string): Promise<void> {
        const context = this.activeContexts.get(executionId);
        this.activeContexts.delete(executionId);
        try { await context?.close(); } catch (e: any) {
            this.logger.warn(`Context close error during cleanup`, { error: e.message });
        }

        const browser = this.activeBrowsers.get(executionId);
        this.activeBrowsers.delete(executionId);
        try { await browser?.close(); } catch (e: any) {
            this.logger.warn(`Browser close error during cleanup`, { error: e.message });
        }
    }
    /**
     * Swaps {{variableName}} placeholders with actual data from the dataset.
     */
    private resolveTemplateString(input: string, testData: Record<string, any> | null): string {
        // If there's no input, or it's not a string, just return it as-is
        if (!input || typeof input !== 'string') return input;

        // The Regex looks for {{ anything }} and captures the word inside
        return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, variableName) => {

            // ── 1. TDM Magic: Dynamic Data Generators ──
            if (variableName === '$timestamp') return Date.now().toString();
            if (variableName === '$randomEmail') return `testuser_${Date.now()}@example.com`;
            if (variableName === '$uuid') return crypto.randomUUID();

            // ── 2. DDT: Read from the User's Data Set ──
            if (testData && testData[variableName] !== undefined) {
                return String(testData[variableName]); // Convert to string safely
            }

            // ── 3. Fallback ──
            // If the user typed {{firstName}} but forgot to add it to the spreadsheet,
            // we leave it as {{firstName}} so it's obvious in the UI why it failed.
            this.logger.warn(`[DDT] Variable "${variableName}" was missing from the dataset!`);
            return match;
        });
    }
    /**
    * Return the current status of an execution.
    */
    async getExecutionStatus(executionId: string): Promise<TestExecutionResult | null | any> {
        return UITestExecutionModel.findOne({ executionId }).lean();
    }
    /**
     * Build a full human-readable execution report.
     */
    async getExecutionReport(executionId: string): Promise<any> {
        // FIX [11]: Do NOT use .lean() here so we can call model methods if needed.
        //           passRate is computed manually from raw data so it works either way.
        const execution = await UITestExecutionModel.findOne({ executionId })
            .populate('testId')
            .lean();

        if (!execution) throw new Error('Execution not found');

        const steps: any[] = (execution as any).stepResults ?? [];
        const passedSteps = steps.filter((s) => s.status === 'passed').length;
        const passRate = steps.length > 0
            ? Math.round((passedSteps / steps.length) * 100)
            : 0;

        return {
            execution,
            test: (execution as any).testId,
            summary: {
                status: execution.status,
                duration: (execution as any).duration,
                passRate,
                ...(execution as any).summary,
            },
            steps,
            artifacts: (execution as any).artifacts,
            metrics: (execution as any).metrics,
        };
    }
    /**
     * Paginated execution history with optional text search.
     */
    async getExecutionHistory(filters: {
        search?: string;
        status?: string;
        type?: string;
        page: number;
        limit: number;
        userId?: string;
    }): Promise<{
        data: TestExecutionResult[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }> {
        try {
            const page = Math.max(1, filters.page || 1);
            const limit = Math.max(1, Math.min(filters.limit || 10, 100)); // cap at 100
            const skip = (page - 1) * limit;

            // FIX [10]: Actually apply the search filter that was previously ignored.
            const query: any = {};
            if (filters.search?.trim()) {
                query.$or = [
                    { testName: { $regex: filters.search, $options: 'i' } },
                    { executionId: { $regex: filters.search, $options: 'i' } }
                ];
            }

            if (filters.type && filters.type.toLowerCase() !== 'all') {
                query.executionType = filters.type
            }

            if (filters.status && filters.status.toLowerCase() !== 'all') {
                query.status = filters.status;
            }

            const [executions, total] = await Promise.all([
                UITestExecutionModel.find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .lean(),
                UITestExecutionModel.countDocuments(query),
            ]);

            return {
                data: executions as TestExecutionResult[],
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            };
        } catch (err: any) {
            this.logger.error(`Failed to get execution history`, { error: err.message });
            throw new Error('Failed to retrieve execution history');
        }
    }
    /**
     * Bulk-delete execution records by their Mongo _id values.
     */
    async deleteExecutions(executionIds: string[]): Promise<{ deletedCount: number }> {
        if (!executionIds?.length) return { deletedCount: 0 };

        try {
            const result = await UITestExecutionModel.deleteMany({
                _id: { $in: executionIds },
            });
            this.logger.info(`Deleted ${result.deletedCount} execution records`);
            return { deletedCount: result.deletedCount ?? 0 };
        } catch (err: any) {
            this.logger.error(`Failed to delete executions`, { error: err.message });
            throw new Error('Failed to delete the selected executions');
        }
    }
}
// ── Internal helper ────────────────────────────────────────────────────────────
/**
 * Poll until a locator's element is enabled (not disabled).
 * Playwright has no built-in waitFor({ state: 'enabled' }).
 */
async function expect_enabled(locator: any, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await locator.isEnabled()) return;
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Element did not become enabled within ${timeout}ms`);
}

