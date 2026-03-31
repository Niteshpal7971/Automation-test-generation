/**
 * @fileoverview UI Suite Execution Service
 * @description Orchestrates running multiple test cases as a suite.
 *              Delegates single-test execution to UITestExecutionService.
 *
 * Architecture:
 *  - No separate suite-execution collection.
 *  - Each test execution is tagged with suiteExecutionId on UITestExecutionModel.
 *  - History and status are derived via MongoDB aggregation pipelines.
 *
 * BUGS FIXED vs previous version:
 *  [A] suiteExecutionId was never written to UITestExecutionModel — the
 *      aggregation pipeline and stopSuiteExecution query matched nothing.
 *      Fixed by threading suiteExecutionId through startExecution → executeTest.
 *  [B] suite.executionConfig could be undefined — accessing .workers on it threw.
 *      Fixed with optional chaining + nullish coalescing fallback to DEFAULT_CONFIG.
 *  [C] runParallel worker starvation — runNext() had an inner while+return that
 *      raced with workerLoop's outer while, leaving workers spinning on an empty
 *      queue. Replaced with a cleaner single-responsibility design.
 *  [D] stopSuiteExecution sent no WS notification after cancelling.
 *  [E] getSuiteExecutionHistory $match key collision — when search was provided,
 *      `suiteExecutionId: { $regex }` silently overwrote `{ $exists: true, $ne: null }`.
 *      Fixed by merging both conditions into a single $and clause.
 *  [F] Aggregation status field ignored 'cancelled' — cancelled suites resolved
 *      to 'passed'. Fixed by adding a cancelled check to the $cond chain.
 */

import { Types } from 'mongoose';
import crypto from 'crypto';
import { UITestCaseModel } from '../models/ui-test-case.model';
import { UITestSuiteModel } from '../models/ui-test-suit.model';
import { UITestExecutionModel } from '../models/ui-test-execution.model';
import { UITestExecutionService } from './ui-test-execution.service';
import { UITestCase } from "../types/ui-test.types"
import { ExecutionOptions } from '../types/ui-test.types';
import { WebSocketService } from '../../../core/services/websocket.service';
import { LoggingService } from '../../../core/services/logging.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SuiteExecutionConfig {
    /** Run test cases in parallel */
    parallel: boolean;
    /** Number of parallel workers (ignored when parallel=false) */
    workers: number;
    /** Stop the entire suite on first test failure */
    failFast: boolean;
    /** Re-run a failed test case automatically */
    retryOnFailure: boolean;
    /** Maximum retry attempts per test case (used when retryOnFailure=true) */
    maxRetries: number;
}
/** Per-test outcome collected in memory during a suite run */
export interface SuiteTestResult {
    testId: string;
    testName: string;
    executionId: string;
    status: 'passed' | 'failed' | 'skipped' | 'cancelled';
    attempts: number;
    // storageState?: any
    // sessionStorageData?: any
    duration: number;
    error?: string;
    existingBrowser?: any;
    existingContext?: any;
    existingPage?: any;
}
/** What startSuiteExecution returns to the caller */
export interface SuiteExecutionStartResponse {
    suiteExecutionId: string;
    suiteId: string;
    totalTests: number;
}
// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: SuiteExecutionConfig = {
    parallel: false,
    workers: 0,
    failFast: false,
    retryOnFailure: false,
    maxRetries: 1,
};
/** Hard cap — workers can never exceed the per-test service concurrency limit */
const MAX_WORKERS = 5;
/** Terminal statuses for an individual test execution */
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error', 'cancelled']);
/** How often to poll getExecutionStatus while waiting for a test to finish */
const POLL_INTERVAL_MS = 2_000;
/**
 * Maximum time to wait for a single test execution to finish.
 * 35 min = per-test master timeout (30 min) + 5 min grace.
 */
const EXECUTION_POLL_TIMEOUT_MS = 35 * 60 * 1_000;
// ─── Service ──────────────────────────────────────────────────────────────────
export class UISuiteExecutionService {
    private readonly testExecutionService: UITestExecutionService;
    private readonly logger = new LoggingService().forModule('UISuiteExecutionService');
    constructor(testExecutionService?: UITestExecutionService) {
        this.testExecutionService = testExecutionService ?? new UITestExecutionService();
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * Validate the suite, resolve config, then fire off execution in the
     * background. Returns immediately with suiteExecutionId.
     */
    async startSuiteExecution(
        suiteId: string,
        executionOptions: Partial<ExecutionOptions>,
        userId: string
    ): Promise<SuiteExecutionStartResponse> {
        if (!Types.ObjectId.isValid(suiteId)) {
            throw new Error('Invalid suite ID');
        }

        // ── 1. Load suite (Optimized & Ordered) ──────────────────────────────
        const suite = await UITestSuiteModel.findById(suiteId)
            .select('name testCases config') // Make sure this matches your schema!
            .populate({
                path: 'testCases',
                select: '_id name steps url timeout retries config status',
            })
            .lean();

        if (!suite) throw new Error('Suite not found');
        if (!suite.testCases?.length) {
            throw new Error('Suite has no test cases');
        }
        const originalCount = suite.testCases.length;
        const tests = (suite.testCases as any[]).filter(
            (test) => test && (test.status === 'active' || test.status === 'draft')
        );

        const skippedCount = originalCount - tests.length;

        if (skippedCount > 0) {
            this.logger.warn(`${skippedCount} test(s) skipped — not in active/draft status`);
        }

        if (tests.length === 0) {
            throw new Error('No active or draft test cases found in this suite');
        }

        // ── 3. Resolve Config ────────────────────────────────────────────────
        const suiteConfig: Partial<SuiteExecutionConfig> = executionOptions ?? {};
        const resolvedConfig: SuiteExecutionConfig = {
            ...DEFAULT_CONFIG,
            ...suiteConfig,
            workers: Math.min(
                Math.max(suiteConfig.workers ?? DEFAULT_CONFIG.workers ?? 1, 1),
                MAX_WORKERS
            ),
        };

        const suiteExecutionId = crypto.randomUUID();

        this.logger.info(
            `Suite execution started: ${suiteExecutionId} | ` +
            `Tests: ${tests.length} | Parallel: ${resolvedConfig.parallel} | ` +
            `Workers: ${resolvedConfig.workers}`
        );

        // ── 4. Notifications & Execution ─────────────────────────────────────
        this.notify(userId, 'suite-started', {
            suiteExecutionId,
            suiteId,
            suiteName: suite.name,
            totalTests: tests.length,
            skippedCount: skippedCount,
            config: resolvedConfig,
            timestamp: new Date().toISOString(),
        });

        // Fire-and-forget with error boundary
        this.runSuite(
            suiteExecutionId,
            suiteId,
            tests, // 🟢 Pass the filtered, perfectly ordered array!
            executionOptions,
            resolvedConfig,
            userId
        ).catch(async (err) => {
            this.logger.error(`Unhandled suite execution error`, { error: err.message });
            await this.handleSuiteError(suiteExecutionId, userId, err);
        });

        return { suiteExecutionId, suiteId, totalTests: tests.length };
    }
    /**
     * Cancel all in-flight test executions belonging to this suite.
     */
    async stopSuiteExecution(suiteExecutionId: string, userId?: string): Promise<void> {
        this.logger.info(`Stopping suite execution: ${suiteExecutionId}`);

        const runningExecutions = await UITestExecutionModel.find({
            suiteExecutionId,
            status: 'running',
        }).select('executionId').lean();

        if (!runningExecutions.length) {
            this.logger.warn(`Suite ${suiteExecutionId} has no running tests — nothing to stop`);
            return;
        }

        const executionIds: string[] = runningExecutions.map((r: any) => r.executionId);

        await Promise.allSettled(
            executionIds.map((id) => this.testExecutionService.stopExecution(id))
        );

        this.logger.info(
            `Suite ${suiteExecutionId} cancelled. Stopped ${executionIds.length} execution(s).`
        );

        // FIX [D]: notify the frontend that the suite was cancelled
        if (userId) {
            this.notify(userId, 'suite-cancelled', {
                suiteExecutionId,
                status: 'cancelled',
                stoppedExecutions: executionIds.length,
                timestamp: new Date().toISOString(),
            });
        }
    }
    // ── Core Orchestration ─────────────────────────────────────────────────────
    private async runSuite(
        suiteExecutionId: string,
        suiteId: string,
        tests: UITestCase[],
        executionOptions: Partial<ExecutionOptions>,
        config: SuiteExecutionConfig,
        userId: string
    ): Promise<void> {
        const startTs = Date.now();
        const results: SuiteTestResult[] = [];
        let aborted = false;

        if (config.parallel) {
            await this.runParallel(
                tests, executionOptions, config, userId, suiteExecutionId,
                results, () => aborted, (v) => { aborted = v; }
            );
        } else {
            await this.runSequential(
                tests, executionOptions, config, userId, suiteExecutionId,
                results, () => aborted, (v) => { aborted = v; }
            );
        }

        const passedTests = results.filter((r) => r.status === 'passed').length;
        const failedTests = results.filter((r) => r.status === 'failed').length;
        const skippedTests = results.filter((r) => r.status === 'skipped').length;
        const cancelledTests = results.filter((r) => r.status === 'cancelled').length;
        const totalDuration = Date.now() - startTs;

        // Status derivation matching the aggregation pipeline (FIX [F]):
        //   running  → (not applicable here, all tests are done)
        //   cancelled → all tests were cancelled
        //   failed    → at least one test failed
        //   skipped   → all tests were skipped
        //   passed    → everything else
        const suiteStatus =
            cancelledTests === results.length ? 'cancelled'
                : failedTests > 0 ? 'failed'
                    : skippedTests === results.length ? 'skipped'
                        : 'passed';

        this.logger.info(
            `Suite ${suiteExecutionId} finished | Status: ${suiteStatus} | ` +
            `Passed: ${passedTests} | Failed: ${failedTests} | ` +
            `Skipped: ${skippedTests} | Duration: ${totalDuration}ms`
        );

        this.notify(userId, 'suite-completed', {
            suiteExecutionId,
            suiteId,
            status: suiteStatus,
            totalTests: results.length,
            passedTests,
            failedTests,
            skippedTests,
            duration: totalDuration,
            timestamp: new Date().toISOString(),
        });
    }
    // ── Sequential Runner ──────────────────────────────────────────────────────
    private async runSequential(
        tests: UITestCase[],
        executionOptions: Partial<ExecutionOptions>,
        config: SuiteExecutionConfig,
        userId: string,
        suiteExecutionId: string,
        results: SuiteTestResult[],
        getAborted: () => boolean,
        setAborted: (v: boolean) => void
    ): Promise<void> {
        // let currentStorageState: any = undefined;
        // let currentSessionStorage: string | undefined = undefined;
        let existingBrowser: any = undefined;
        let existingContext: any = undefined;
        let existingPage: any = undefined;
        for (let i = 0; i < tests.length; i++) {
            const test = tests[i];

            if (getAborted()) {
                this.logger.info(`[SUITE] Skipping "${test && test.name}" (failFast)`);
                results.push(this.makeSkippedResult(test as UITestCase, 'Suite aborted by failFast'));
                this.notifyTestSkipped(userId, suiteExecutionId, test as UITestCase, i, tests.length);
                continue;
            }
            // ADD THIS: Inject the state into the options for this specific test
            const optionsForThisTest = {
                ...executionOptions,
                existingBrowser,
                existingContext,
                existingPage,
                // preserveState: true, // Tell the engine to give us the new state back
                keepAlive: i === tests.length - 1 ? false : true
            };

            const result = await this.runOneTestWithRetries(
                test as UITestCase, optionsForThisTest, config, userId, suiteExecutionId, i, tests.length
            );
            console.log("result", result)
            // const result = await this.runOneTestWithRetries(
            //     test as UITestCase, executionOptions, config, userId, suiteExecutionId, i, tests.length
            // );
            results.push(result);
            // Capture BOTH from the finished test
            if (result.status === 'passed') {
                if (result.existingBrowser) existingBrowser = result.existingBrowser;
                if (result.existingContext) existingContext = result.existingContext;
                if (result.existingPage) existingPage = result.existingPage;
            }
            if (result.status === 'failed' && config.failFast) {
                this.logger.warn(`[SUITE] failFast triggered by "${test && test.name}"`);
                setAborted(true);
            }
        }
    }
    // ── Parallel Runner ────────────────────────────────────────────────────────
    /**
     * Bounded parallel worker pool.
     *
     * FIX [C]: Previous design had runNext() contain a while+return inside
     * workerLoop's while, causing a race where one worker drained the queue
     * while another was mid-await, leaving it spinning forever.
     *
     * New design: each worker owns its own loop and claims the next test via
     * a shared atomic counter (nextIndex). No shared mutable array, no races.
     */
    private async runParallel(
        tests: UITestCase[],
        executionOptions: Partial<ExecutionOptions>,
        config: SuiteExecutionConfig,
        userId: string,
        suiteExecutionId: string,
        results: SuiteTestResult[],
        getAborted: () => boolean,
        setAborted: (v: boolean) => void
    ): Promise<void> {
        let nextIndex = 0;
        const workerCount = Math.min(config.workers, tests.length);

        const worker = async (): Promise<void> => {
            while (true) {
                const index = nextIndex++;
                if (index >= tests.length) break;

                const test = tests[index];

                if (getAborted()) {
                    results.push(this.makeSkippedResult(test as UITestCase, 'Suite aborted by failFast'));
                    this.notifyTestSkipped(userId, suiteExecutionId, test as UITestCase, index, tests.length);
                    continue;
                }

                const result = await this.runOneTestWithRetries(
                    test as UITestCase, executionOptions, config, userId, suiteExecutionId, index, tests.length
                );
                results.push(result);

                if (result.status === 'failed' && config.failFast) {
                    this.logger.warn(`[SUITE] failFast triggered by "${test && test.name}"`);
                    setAborted(true);
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }
    // ── Single Test with Retries ───────────────────────────────────────────────
    private async runOneTestWithRetries(
        test: UITestCase,
        executionOptions: Partial<ExecutionOptions>,
        config: SuiteExecutionConfig,
        userId: string,
        suiteExecutionId: string,
        testIndex: number,
        totalTests: number
    ): Promise<SuiteTestResult> {
        console.log("run with retries config check", executionOptions, config, userId, suiteExecutionId, testIndex, totalTests)
        const maxAttempts = config.retryOnFailure ? 1 + config.maxRetries : 1;
        let lastResult: SuiteTestResult | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const isRetry = attempt > 1;

            this.logger.info(
                `[SUITE] "${test.name}" (${testIndex + 1}/${totalTests})` +
                (isRetry ? ` — retry ${attempt - 1}/${config.maxRetries}` : '')
            );

            this.notify(userId, 'suite-test-started', {
                suiteExecutionId,
                testId: String(test._id),
                testName: test.name,
                testIndex,
                totalTests,
                attempt,
                maxAttempts,
                isRetry,
                timestamp: new Date().toISOString(),
            });

            const testStartTs = Date.now();
            // let executionId: string | null = null;
            const executionId: string = crypto.randomUUID()

            try {
                // FIX [A]: suiteExecutionId is forwarded so UITestExecutionService
                // writes it onto the UITestExecutionModel record, making the
                // aggregation pipeline and stopSuiteExecution query work correctly.
                const executionResult = await this.testExecutionService.executeTest(
                    executionId,
                    test,
                    { ...executionOptions, suiteExecutionId, suiteId: executionOptions.suiteId, executionType: 'suite' } as any,
                    userId
                );
                console.log("execution results debugs", executionResult)
                // const executionResult = await this.waitForExecution(executionId);
                const duration = Date.now() - testStartTs;
                const status: SuiteTestResult['status'] =
                    executionResult?.status === 'passed' ? 'passed' : 'failed';
                // let executionId: string = executionResult.executionId

                lastResult = {
                    testId: String(test._id),
                    testName: test.name,
                    executionId,
                    status,
                    attempts: attempt,
                    duration,
                    existingBrowser: executionResult.activeInstances.browser,
                    existingContext: executionResult.activeInstances.context,
                    existingPage: executionResult.activeInstances.page,
                    error: status === 'failed'
                        ? (executionResult?.error?.message ?? 'Test failed')
                        : undefined,
                };

                this.notify(userId, 'suite-test-completed', {
                    suiteExecutionId,
                    testId: String(test._id),
                    testName: test.name,
                    testIndex,
                    totalTests,
                    executionId,
                    status,
                    attempt,
                    isRetry,
                    willRetry: status === 'failed' && attempt < maxAttempts,
                    duration,
                    error: lastResult.error ?? null,
                    timestamp: new Date().toISOString(),
                });

                if (status === 'passed') break;

                if (attempt < maxAttempts) {
                    this.logger.info(
                        `[SUITE] "${test.name}" failed attempt ${attempt}/${maxAttempts}. Retrying...`
                    );
                }
            } catch (err: any) {
                const duration = Date.now() - testStartTs;
                this.logger.error(
                    `[SUITE] "${test.name}" threw on attempt ${attempt}: ${err.message}`
                );

                lastResult = {
                    testId: String(test._id),
                    testName: test.name,
                    // executionId: executionId ?? 'unknown',
                    executionId,
                    status: 'failed',
                    attempts: attempt,
                    duration,
                    error: err.message,
                };

                this.notify(userId, 'suite-test-completed', {
                    suiteExecutionId,
                    testId: String(test._id),
                    testName: test.name,
                    testIndex,
                    totalTests,
                    executionId: executionId ?? null,
                    status: 'failed',
                    attempt,
                    isRetry,
                    willRetry: attempt < maxAttempts,
                    duration,
                    error: err.message,
                    timestamp: new Date().toISOString(),
                });

                // Capacity errors won't be resolved by retrying immediately
                if (err.message.includes('Server is at capacity')) break;
            }
        }

        return lastResult ?? {
            testId: String(test._id),
            testName: test.name,
            executionId: '',
            status: 'failed',
            attempts: 0,
            duration: 0,
            error: 'No execution attempt was made',
        };
    }
    // ── Execution Polling ──────────────────────────────────────────────────────
    private async waitForExecution(
        executionId: string,
        timeoutMs = EXECUTION_POLL_TIMEOUT_MS,
        intervalMs = POLL_INTERVAL_MS
    ): Promise<any> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const record = await this.testExecutionService.getExecutionStatus(executionId);
            if (record && TERMINAL_STATUSES.has(record.status)) return record;
            await sleep(intervalMs);
        }

        this.logger.error(
            `waitForExecution timed out after ${timeoutMs / 1000}s for executionId: ${executionId}`
        );
        return { status: 'failed', error: { message: 'Execution polling timed out' } };
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    private makeSkippedResult(test: UITestCase, reason: string): SuiteTestResult {
        return {
            testId: String(test._id),
            testName: test.name,
            executionId: '',
            status: 'skipped',
            attempts: 0,
            duration: 0,
            error: reason,
        };
    }
    private notifyTestSkipped(
        userId: string,
        suiteExecutionId: string,
        test: UITestCase,
        testIndex: number,
        totalTests: number
    ): void {
        this.notify(userId, 'suite-test-skipped', {
            suiteExecutionId,
            testId: String(test._id),
            testName: test.name,
            testIndex,
            totalTests,
            reason: 'Suite aborted by failFast',
            timestamp: new Date().toISOString(),
        });
    }
    private async handleSuiteError(
        suiteExecutionId: string,
        userId: string,
        error: Error
    ): Promise<void> {
        await UITestExecutionModel.updateMany(
            { suiteExecutionId, status: { $in: ['running', 'pending', 'queued'] } },
            {
                $set: {
                    status: 'error',
                    endTime: new Date(),
                    'error.message': `Suite orchestrator crashed: ${error.message}`,
                },
            }
        );

        this.notify(userId, 'suite-error', {
            suiteExecutionId,
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString(),
        });
    }
    private notify(userId: string, type: string, payload: any): void {
        try {
            WebSocketService.getIO().to(userId).emit('test-execution-update', {
                type,
                ...payload,
            });
        } catch (err: any) {
            this.logger.warn(`[WS-NOTIFY] Failed for type "${type}": ${err.message}`);
        }
    }
    // DB Actions
    /**
     * Derive the current status of a suite execution by aggregating its
     * individual test execution records.
     */
    async getSuiteExecutionStatus(suiteExecutionId: string): Promise<any> {
        const results = await UITestExecutionModel.aggregate(
            this.buildStatusPipeline({ suiteExecutionId })
        );
        return results[0] ?? null;
    }
    /**
     * Paginated suite execution history, derived purely from UITestExecutionModel.
     */
    async getSuiteExecutionHistory(filters: {
        suiteId?: string;
        search?: string;
        page: number;
        limit: number;
    }): Promise<{
        data: any[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }> {
        const page = Math.max(1, filters.page || 1);
        const limit = Math.min(Math.max(1, filters.limit || 10), 100);
        const skip = (page - 1) * limit;

        // FIX [E]: collect $match conditions in an array then combine with $and
        // so multiple predicates on the same field never silently overwrite each other.
        const matchConditions: any[] = [
            { suiteExecutionId: { $exists: true, $ne: null } },
        ];

        if (filters.suiteId && Types.ObjectId.isValid(filters.suiteId)) {
            matchConditions.push({ suiteId: new Types.ObjectId(filters.suiteId) });
        }

        if (filters.search?.trim()) {
            matchConditions.push({
                suiteExecutionId: { $regex: filters.search.trim(), $options: 'i' },
            });
        }

        const matchStage = { $and: matchConditions };
        const pipeline = this.buildStatusPipeline(matchStage);

        const [data, counts] = await Promise.all([
            UITestExecutionModel.aggregate([
                ...pipeline,
                { $sort: { startTime: -1 } },
                { $skip: skip },
                { $limit: limit },
            ]),
            UITestExecutionModel.aggregate([
                ...pipeline,
                { $count: 'total' },
            ]),
        ]);

        const total = counts[0]?.total ?? 0;
        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
    // ── Aggregation Pipeline ───────────────────────────────────────────────────
    /**
     * Reusable aggregation pipeline: groups individual test execution records
     * into a single suite-level summary document.
     *
     * FIX [F]: status derivation now handles 'cancelled' correctly.
     *   Priority: running > cancelled (all tests) > failed > passed
     */
    private buildStatusPipeline(matchStage: Record<string, any>): any[] {
        return [
            { $match: matchStage },
            {
                $group: {
                    _id: '$suiteExecutionId',
                    suiteExecutionId: { $first: '$suiteExecutionId' },
                    suiteId: { $first: '$suiteId' },
                    startTime: { $min: '$startTime' },
                    endTime: { $max: '$endTime' },
                    totalTests: { $sum: 1 },
                    passedTests: {
                        $sum: { $cond: [{ $eq: ['$status', 'passed'] }, 1, 0] },
                    },
                    failedTests: {
                        $sum: { $cond: [{ $in: ['$status', ['failed', 'error']] }, 1, 0] },
                    },
                    skippedTests: {
                        $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] },
                    },
                    cancelledTests: {
                        $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] },
                    },
                    runningTests: {
                        $sum: {
                            $cond: [{ $in: ['$status', ['running', 'pending', 'queued']] }, 1, 0],
                        },
                    },
                    testResults: {
                        $push: {
                            executionId: '$executionId',
                            testId: '$testId',
                            testName: '$testName',
                            status: '$status',
                            duration: '$duration',
                            error: '$error',
                            attempts: '$attempts',
                        },
                    },
                },
            },
            {
                $addFields: {
                    duration: { $subtract: ['$endTime', '$startTime'] },
                    passRate: {
                        $cond: [
                            { $gt: ['$totalTests', 0] },
                            {
                                $round: [
                                    {
                                        $multiply: [
                                            { $divide: ['$passedTests', '$totalTests'] },
                                            100,
                                        ],
                                    },
                                    0,
                                ],
                            },
                            0,
                        ],
                    },
                    // FIX [F]: cascading status — most-specific first.
                    //   running   → at least one test still in progress
                    //   cancelled → every test was cancelled, none running
                    //   failed    → at least one test failed/errored
                    //   passed    → everything else
                    status: {
                        $cond: [
                            { $gt: ['$runningTests', 0] },
                            'running',
                            {
                                $cond: [
                                    { $eq: ['$cancelledTests', '$totalTests'] },
                                    'cancelled',
                                    {
                                        $cond: [
                                            { $gt: ['$failedTests', 0] },
                                            'failed',
                                            'passed',
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
        ];
    }
}
// ─── Utility ──────────────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
