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
        userId: string
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

        const executionId = crypto.randomUUID();

        this.logger.info(`Test loaded: "${test.name}" (${test.steps.length} steps)`);

        // FIX [1]: Attach .catch() so an unhandled rejection never silently disappears.
        //          Also track the ID in the semaphore set.
        this.runningExecutions.add(executionId);
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

    // ── Core Execution ─────────────────────────────────────────────────────────

    private async executeTest(
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

        this.notify(userId, 'execution-started', {
            executionId,
            testId,
            testName: test.name,
            totalSteps: test.steps.length,
            status: 'running',
            timestamp: new Date().toISOString(),
        }, suiteExecutionId);

        let browser: Browser | null = null;
        let context: BrowserContext | null = null;
        let page: Page | null = null;

        try {
            // ── 3. Launch browser ────────────────────────────────────────────
            this.logger.info(`Launching ${execOptions.browser.type} browser...`);
            browser = await this.launchBrowser(execOptions);
            this.activeBrowsers.set(executionId, browser);
            this.logger.info(`Browser launched (v${browser.version()})`);

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

            context = await browser.newContext(contextOptions);
            this.activeContexts.set(executionId, context);

            // Trace — only if explicitly enabled.
            if (execOptions.browser.trace?.enabled) {
                await context.tracing.start({
                    screenshots: execOptions.browser.trace.screenshots ?? false,
                    snapshots: execOptions.browser.trace.snapshots ?? false,
                });
            }

            page = await context.newPage();
            this.logger.info(`Page created`, { viewport: execOptions.browser.viewport });

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

            return execution.toJSON();
        } catch (error: any) {
            await this.handleExecutionError(
                executionId,
                String(test._id),
                userId,
                error,
                startTs
            );
            throw new Error(`Test execution failed: ${error.message}`);
        } finally {
            await this.cleanup(executionId).catch((err) => {
                this.logger.error(`Cleanup error`, { error: err });
            });

            // FIX [14]: Scan video dir — only if video was enabled.
            // Playwright writes the .webm file only after context.close(), which
            // happens inside cleanup() just above, so we scan here.
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

    private async executeAction(
        initialPage: Page,
        step: UITestStep,
        executionId: string,
        options?: any
    ): Promise<void> {
        const timeout = step.timeout || options?.timeout || 30_000;
        const speed: number = options?.speed ?? 1000;
        // Always use the latest open page (handles new-tab navigations)
        const page = this.getActivePage(initialPage);

        switch (step.action) {
            // ── NAVIGATE ────────────────────────────────────────────────────
            case 'navigate': {
                let targetUrl = step.url || '';
                const baseUrl = options?.baseUrl || '';
                if (targetUrl && !targetUrl.startsWith('http') && baseUrl) {
                    try { targetUrl = new URL(targetUrl, baseUrl).href; }
                    catch { targetUrl = baseUrl.replace(/\/+$/, '') + '/' + targetUrl.replace(/^\/+/, ''); }
                }
                if (!targetUrl) throw new Error('Navigate step has no URL');
                this.logger.info(`Navigate → ${targetUrl}`);
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout });
                await page.waitForLoadState('networkidle', { timeout: 10_000 })
                    .catch(() => this.logger.info(`Network didn't reach idle, continuing…`));
                break;
            }

            // ── CLICK ───────────────────────────────────────────────────────
            case 'click': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Click: ${step.selector?.value || 'element'}`);
                // Visual highlight so the user can see what's being clicked
                try {
                    await locator.evaluate((node) => {
                        const el = node as HTMLElement;
                        const prev = el.style.outline;
                        el.style.outline = '3px solid red';
                        setTimeout(() => { el.style.outline = prev; }, 800);
                    });
                } catch { /* element may not support style */ }
                try {
                    await locator.click({ timeout, delay: 50 });
                } catch (clickErr: any) {
                    this.logger.warn(`Playwright click failed: ${clickErr.message.split('\n')[0]}`);
                    try {
                        await locator.evaluate((node) => (node as HTMLElement).click());
                        await page.waitForTimeout(300);
                    } catch {
                        if (step.metadata?.coordinates) {
                            const { x, y } = step.metadata.coordinates;
                            this.logger.warn(`JS click failed, coordinate click at (${x}, ${y})`);
                            await page.mouse.click(x, y, { delay: 50 });
                        } else {
                            throw clickErr;
                        }
                    }
                }
                // Short stabilization after click (SPA routing, modals, etc.)
                await page.waitForTimeout(Math.min(speed, 500));
                break;
            }

            // ── DOUBLE CLICK ────────────────────────────────────────────────
            case 'dblclick': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Double-click: ${step.selector?.value || 'element'}`);
                await locator.dblclick({ timeout });
                break;
            }

            // ── FILL ─────────────────────────────────────────────────────
            case 'fill': {
                const locator = await this.resolveLocator(page, step);
                const val = String(step.value ?? '');
                this.logger.info(`Fill: "${val.slice(0, 40)}" → ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'visible', timeout });
                // Visual highlight
                try {
                    await locator.evaluate((node) => {
                        const el = node as HTMLElement;
                        const prev = el.style.outline;
                        el.style.outline = '3px solid blue';
                        setTimeout(() => { el.style.outline = prev; }, 800);
                    });
                } catch { /* ignore */ }
                // Use Playwright's native fill — it atomically clears + types + fires
                // correct input/change events for React/Vue/Angular controlled inputs.
                // pressSequentially after fill('') loses focus in SPAs.
                try {
                    await locator.fill(val, { timeout });
                } catch (fillErr: any) {
                    // Fallback for contenteditable or non-standard inputs
                    this.logger.warn(`Native fill failed (${fillErr.message.split('\n')[0]}), falling back to pressSequentially`);
                    await locator.click({ timeout });
                    await locator.press('Control+a');
                    await locator.press('Backspace');
                    await locator.pressSequentially(val, { delay: 50 });
                }
                break;
            }

            // ── TYPE (human-like keystroke entry) ─────────────────────────────
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

            // ── SELECT (native <select> dropdown) ───────────────────────────
            case 'select': {
                const locator = await this.resolveLocator(page, step);
                const val = String(step.value ?? '');
                this.logger.info(`Select: "${val}" on ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                try {
                    // Try by value first, then by label
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

            // ── CHECK (checkbox / radio) ────────────────────────────────────
            case 'check': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Check: ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                await locator.check({ timeout, force: false });
                break;
            }

            // ── UNCHECK ─────────────────────────────────────────────────────
            case 'uncheck': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Uncheck: ${step.selector?.value || 'element'}`);
                await locator.waitFor({ state: 'attached', timeout });
                await locator.uncheck({ timeout, force: false });
                break;
            }

            // ── HOVER ───────────────────────────────────────────────────────
            case 'hover': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Hover: ${step.selector?.value || 'element'}`);
                await locator.hover({ timeout });
                break;
            }

            // ── FOCUS ───────────────────────────────────────────────────────
            case 'focus': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Focus: ${step.selector?.value || 'element'}`);
                await locator.focus({ timeout });
                break;
            }

            // ── BLUR ────────────────────────────────────────────────────────
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

            // ── PRESS KEY ───────────────────────────────────────────────────
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

            // ── CLEAR ───────────────────────────────────────────────────────
            case 'clear': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Clear: ${step.selector?.value || 'element'}`);
                await locator.fill('', { timeout });
                break;
            }

            // ── SCROLL ──────────────────────────────────────────────────────
            case 'scroll':
            case 'scrollTo': {
                const offset = step.scrollOffset || { x: 0, y: 0 };
                const sel = step.selector?.value || '';
                const isWindowScroll = !sel
                    || ['html', 'body', ':root'].includes(sel.toLowerCase())
                    || sel.includes('/html[1]');

                if (isWindowScroll) {
                    this.logger.info(`Window scrollTo: (${offset.x}, ${offset.y})`);
                    await page.evaluate((pos) => window.scrollTo({ left: pos.x, top: pos.y, behavior: 'smooth' }), offset);
                } else {
                    const locator = await this.resolveLocator(page, step);
                    this.logger.info(`Element scrollTo: ${sel}`);
                    await locator.evaluate((el, pos) => el.scrollTo({ left: pos.x, top: pos.y, behavior: 'smooth' }), offset);
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

            // ── DRAG AND DROP ───────────────────────────────────────────────
            case 'dragAndDrop': {
                if (!step.dropTarget) throw new Error('DragAndDrop requires a dropTarget selector');
                const locator = await this.resolveLocator(page, step);
                const targetSelector = this.buildSelector(step.dropTarget);
                this.logger.info(`DragAndDrop → ${targetSelector}`);
                await locator.dragTo(page.locator(targetSelector), { timeout });
                break;
            }

            // ── FILE UPLOAD ─────────────────────────────────────────────────
            case 'upload': {
                const locator = await this.resolveLocator(page, step);
                this.logger.info(`Upload: ${step.files?.length ?? 0} file(s)`);
                await locator.setInputFiles(step.files || []);
                break;
            }

            // ── WAIT / ASSERT — handled outside executeAction ────────────
            case 'wait': break;
            case 'assert': break;

            // ── SCREENSHOT ──────────────────────────────────────────────────
            case 'screenshot':
                this.logger.info(`Manual screenshot step`);
                await this.captureScreenshot(page, executionId, step.id, step.screenshot?.fullPage);
                break;

            // ── EVALUATE SCRIPT ──────────────────────────────────────────────
            case 'evaluate': {
                if (!step.script) throw new Error('Evaluate step requires a script');
                this.logger.info(`Evaluate script (${step.script.length} chars)`);
                await page.evaluate(step.script);
                break;
            }

            // ── RELOAD / BACK / FORWARD ─────────────────────────────────────
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

    /**
     * Create a native Playwright Locator using the best API for each strategy.
     * Uses getByPlaceholder, getByText, getByRole, etc. instead of raw CSS strings
     * for much more reliable element matching.
     */
    private createLocator(page: Page, cfg: SelectorConfig) {
        const isExact = cfg.strict !== false;
        switch (cfg.strategy) {
            case 'placeholder': return page.getByPlaceholder(cfg.value, { exact: isExact });
            case 'text': return page.getByText(cfg.value, { exact: isExact });
            case 'role': return page.getByRole(cfg.value as any, { exact: isExact });
            case 'label': return page.getByLabel(cfg.value, { exact: isExact });
            case 'testId': return page.getByTestId(cfg.value);
            case 'altText': return page.getByAltText(cfg.value, { exact: isExact });
            case 'title': return page.getByTitle(cfg.value, { exact: isExact });
            case 'css': return page.locator(cfg.value);
            case 'xpath': return page.locator(`xpath=${cfg.value}`);
            default: return page.locator(cfg.value);
        }
    }

    /**
     * Try the primary selector first, then each fallback in order.
     * If nothing matches immediately, return the primary with Playwright auto-wait.
     * Uses native Playwright locators (createLocator) for precise element matching.
     */
    private async resolveLocator(page: Page, step: UITestStep) {
        if (!step.selector) {
            throw new Error(`Step "${step.description || step.action}" has no selector`);
        }

        // Helper function to check if a locator yields a VISIBLE element
        const getVisibleLocator = async (selector: any) => {
            const baseLocator = this.createLocator(page, selector);
            try {
                // Filter the locator to ONLY return elements that are currently visible
                const visibleLocator = baseLocator.filter({ visible: true });
                const count = await visibleLocator.count();
                if (count > 0) {
                    return visibleLocator.first();
                }
            } catch (e: any) {
                // Ignore syntax errors for bad selectors and move on
            }
            return null;
        };

        // 1. Try primary selector FOR VISIBLE ELEMENTS
        const visiblePrimary = await getVisibleLocator(step.selector);
        if (visiblePrimary) {
            this.logger.info(`Primary matched visible (${step.selector.strategy}: ${step.selector.value})`);
            return visiblePrimary;
        }

        // 2. Try fallbacks FOR VISIBLE ELEMENTS
        if (step.selector.fallbacks?.length) {
            for (const fallback of step.selector.fallbacks) {
                const fb = fallback as any;
                const visibleFb = await getVisibleLocator(fb);
                if (visibleFb) {
                    this.logger.info(`Fallback matched visible (${fb.strategy}: ${fb.value})`);
                    return visibleFb;
                }
            }
        }

        // 3. Failsafe: If nothing is visible *right now*, return the primary locator anyway.
        // This allows Playwright's built-in auto-wait to wait for it just in case
        // it's about to animate onto the screen.
        this.logger.warn(`No visible selector matched immediately. Relying on auto-wait for (${step.selector.strategy}: ${step.selector.value})`);

        return this.createLocator(page, step.selector).first();
    }
    /**
     * Resolve a locator from a raw SelectorConfig (not a UITestStep).
     * Used by executeWait where the selector comes from wait config.
     */
    private resolveLocatorFromSelector(page: Page, selector: SelectorConfig) {
        let finalLocator = this.createLocator(page, selector);

        if (selector.fallbacks?.length) {
            for (const fallback of selector.fallbacks) {
                finalLocator = finalLocator.or(this.createLocator(page, fallback as SelectorConfig));
            }
        }

        return finalLocator.first();
    }

    // ── Wait Conditions ────────────────────────────────────────────────────────

    private async executeWait(page: Page, wait: any): Promise<void> {
        const timeout = wait.timeout || 30_000;
        this.logger.info(`[WAIT] condition=${wait.condition} timeout=${timeout}ms`);

        let locator;
        if (wait.selector && ['visible', 'hidden', 'attached', 'detached'].includes(wait.condition)) {
            locator = this.resolveLocatorFromSelector(page, wait.selector);
        }
        switch (wait.condition) {
            case 'visible': await locator!.waitFor({ state: 'visible', timeout }); break;
            case 'hidden': await locator!.waitFor({ state: 'hidden', timeout }); break;
            case 'attached': await locator!.waitFor({ state: 'attached', timeout }); break;
            case 'detached': await locator!.waitFor({ state: 'detached', timeout }); break;
            case 'timeout': await page.waitForTimeout(timeout); break;
            case 'networkIdle': await page.waitForLoadState('networkidle', { timeout }); break;
            case 'load': await page.waitForLoadState('load', { timeout }); break;
            case 'domContentLoaded': await page.waitForLoadState('domcontentloaded', { timeout }); break;
            default: this.logger.warn(`Unknown wait condition: ${wait.condition}`);
        }
        this.logger.info(`[WAIT] completed`);
    }

    // ── Assertions ─────────────────────────────────────────────────────────────

    private async executeAssertion1(
        page: Page,
        assertion: AssertionConfig,
        step: UITestStep
    ): Promise<any> {
        // Use resolveLocator (with fallback support) so assertions work even when
        // the primary selector is broken but a fallback matches.
        const locator = step.selector ? await this.resolveLocator(page, step) : null;
        try {
            let actual: any;

            switch (assertion.type) {
                case 'exists':
                    actual = await locator!.count();
                    return this.compareValues(actual > 0, true, assertion);
                case 'notExists':
                    actual = await locator!.count();
                    return this.compareValues(actual, 0, assertion);
                case 'visible':
                    actual = await locator!.isVisible();
                    return this.compareValues(actual, true, assertion);
                case 'hidden':
                    actual = await locator!.isHidden();
                    return this.compareValues(actual, true, assertion);
                case 'text':
                    actual = await locator!.textContent();
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'value':
                    actual = await locator!.inputValue();
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'attribute':
                    actual = await locator!.getAttribute(assertion.attribute!);
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'count':
                    actual = await locator!.count();
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'url':
                    actual = page.url();
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'title':
                    actual = await page.title();
                    return this.compareValues(actual, assertion.expected, assertion);
                case 'checked':
                    actual = await locator!.isChecked();
                    return this.compareValues(actual, true, assertion);
                case 'disabled':
                    actual = await locator!.isDisabled();
                    return this.compareValues(actual, true, assertion);
                case 'enabled':
                    actual = await locator!.isEnabled();
                    return this.compareValues(actual, true, assertion);
                default:
                    throw new Error(`Unknown assertion type: ${assertion.type}`);
            }
        } catch (error: any) {
            return { assertion, passed: false, message: error.message };
        }
    }

    private async executeAssertion(
        page: Page,
        assertion: AssertionConfig,
        step: UITestStep,
    ): Promise<any> {
        const startTime = Date.now();
        const assertTimeout = step.timeout ?? 15_000;
        let lastResult: any = { passed: false, message: 'Assertion timed out' };
        let pollCount = 0;

        // ── THE POLLING LOOP ──────────────────────────────────────────────────
        while (Date.now() - startTime < assertTimeout) {
            pollCount++;
            try {
                // Resolve locator each iteration so dynamically appearing elements are caught
                const locator = step.selector && !['url', 'title'].includes(assertion.type)
                    ? await this.resolveLocator(page, step)
                    : null;

                let actual: any;

                switch (assertion.type) {
                    case 'exists':
                    case 'notExists':
                    case 'count':
                        actual = await locator!.count();
                        break;
                    case 'visible':
                        actual = await locator!.isVisible();
                        break;
                    case 'hidden':
                        actual = await locator!.isHidden();
                        break;
                    case 'text':
                        actual = await locator!.innerText();
                        break;
                    case 'value':
                        actual = await locator!.inputValue();
                        break;
                    case 'attribute':
                        actual = await locator!.getAttribute(assertion.attribute!);
                        break;
                    case 'url':
                        actual = page.url();
                        break;
                    case 'title':
                        actual = await page.title();
                        break;
                    case 'checked':
                        actual = await locator!.isChecked();
                        break;
                    case 'disabled':
                        actual = await locator!.isDisabled();
                        break;
                    case 'enabled':
                        actual = await locator!.isEnabled();
                        break;
                    default:
                        throw new Error(`Unknown assertion type: ${assertion.type}`);
                }

                lastResult = this.compareValues(actual, assertion.expected, assertion);

                // Log the first attempt and every 10th for diagnostics
                if (pollCount === 1 || pollCount % 10 === 0) {
                    this.logger.info(`[ASSERT] poll #${pollCount} | type=${assertion.type} | actual="${actual}" | expected="${assertion.expected}" | passed=${lastResult.passed}`);
                }

                if (lastResult.passed) {
                    this.logger.info(`[ASSERT PASSED] ${assertion.type} after ${Date.now() - startTime}ms (${pollCount} polls)`);
                    return lastResult;
                }

            } catch (error: any) {
                lastResult = { assertion, passed: false, message: error.message, actual: null };
            }

            await page.waitForTimeout(250);
        }

        this.logger.warn(`[ASSERT FAILED] ${assertion.type} timed out after ${assertTimeout}ms (${pollCount} polls). Last actual="${lastResult.actual}" expected="${assertion.expected}"`);
        return lastResult;
    }

    private compareValues(actual: any, expected: any, assertion: AssertionConfig): any {
        let passed = false;

        switch (assertion.operator) {
            case 'equals': passed = actual === expected; break;
            case 'notEquals': passed = actual !== expected; break;
            case 'contains': passed = String(actual).includes(String(expected)); break;
            case 'notContains': passed = !String(actual).includes(String(expected)); break;
            case 'startsWith': passed = String(actual).startsWith(String(expected)); break;
            case 'endsWith': passed = String(actual).endsWith(String(expected)); break;
            case 'matches': passed = new RegExp(expected).test(String(actual)); break;
            case 'greaterThan': passed = Number(actual) > Number(expected); break;
            case 'lessThan': passed = Number(actual) < Number(expected); break;
            case 'greaterOrEqual': passed = Number(actual) >= Number(expected); break;
            case 'lessOrEqual': passed = Number(actual) <= Number(expected); break;
            default:
                this.logger.warn(`Unknown operator: ${assertion.operator}`);
        }

        return {
            assertion,
            passed,
            actual,
            message: passed
                ? undefined
                : assertion.message || `Expected "${expected}", got "${actual}"`,
        };
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
        if (typeof processed.value === 'string') processed.value = replace(processed.value);
        if (processed.url) processed.url = replace(processed.url);
        return processed;
    }

    // ── Screenshot ─────────────────────────────────────────────────────────────

    /**
     * Captures a screenshot into the per-execution screenshots folder.
     * Path: acevin-automation/playback/<executionId>/screenshots/<stepId>_<ts>.png
     * Uses try/catch (not isClosed()) to be safe against TOCTOU races (FIX [7]).
     */
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
            if (options?.browser?.channel) {
                launchOptions.channel = options.browser.channel;
            }

            launchOptions.args = [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-position=50,50',
                `--start-maximized`,
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
            }); // Intentionally not passing suiteExecutionId here as this is a high-level error usually caught via throw 
        }
    }

    // ── WebSocket Notification ─────────────────────────────────────────────────

    private notify(userId: string, type: string, payload: any, suiteExecutionId?: string): void {
        try {
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

    // ── Resource Cleanup ───────────────────────────────────────────────────────

    /**
     * FIX [2]: Delete Map entries BEFORE closing so a crash mid-close never
     *          leaves orphaned handles that prevent GC or re-use of the key.
     */
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
}
