/**
 * @fileoverview UI Test Execution Model
 * @description MongoDB schema for tracking test execution results
 * @version 1.0.0
 */

import mongoose, { Schema, Model, Types } from 'mongoose';
import {
    StepExecutionResult,
    ExecutionStatus,
    PlaywrightActionType
} from '../types/ui-test.types';

/* -------------------------------------------------------------------------- */
/*                               TYPE DEFINITIONS                              */
/* -------------------------------------------------------------------------- */

export interface TestExecutionResult {
    executionId: string;
    testId: Types.ObjectId;
    testName: String;
    status: ExecutionStatus;
    startTime: Date;
    endTime?: Date;
    duration?: number;

    environment: string;

    browser: {
        type: 'chromium' | 'firefox' | 'webkit';
        channel: string,
        device: string,
        version?: string;
    };

    stepResults: StepExecutionResult[];

    summary: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
    };

    artifacts?: {
        screenshots?: string[];
        videos?: string[];
        traces?: string[];
        logs?: string[];
    };

    error?: {
        message?: string;
        stack?: string;
    };
    metrics?: {
        loadTime?: number;
        memoryUsage?: number;
        networkRequests?: number;
        consoleErrors?: number;
    };
    triggeredBy?: Types.ObjectId;
    trigger: 'manual' | 'scheduled' | 'api' | 'ci-cd';

    dataSetId?: string | Types.ObjectId;
    dataRowIndex?: number;
    metadata?: Record<string, any>;

    suiteExecutionId?: string;
    suiteId?: Types.ObjectId;
    executionType?: string

    createdAt: Date;
    updatedAt: Date;
}

/* ---------------------------- Instance Methods ----------------------------- */
export interface UITestExecutionMethods {
    updateStatus(status: ExecutionStatus, error?: any): Promise<TestExecutionDoc>;
    addStepResult(stepResult: StepExecutionResult): TestExecutionDoc;
    getPassPercentage(): number;
    isComplete(): boolean;
    isInProgress(): boolean;
}

/* ----------------------------- Static Methods ------------------------------ */
export interface UITestExecutionStatics {
    findByTestId(
        testId: string,
        options?: { page?: number; limit?: number; status?: ExecutionStatus }
    ): Promise<any>;

    getTestStatistics(testId: string, days?: number): Promise<any>;

    generateExecutionId(): string;
}

/* ----------------------------- Document Type -------------------------------- */
export type TestExecutionDoc = TestExecutionResult & UITestExecutionMethods;

/* -------------------------------------------------------------------------- */
/*                                   SCHEMAS                                  */
/* -------------------------------------------------------------------------- */

const AssertionResultSchema = new Schema(
    {
        assertion: {
            type: {
                type: String,
                required: true,
            },
            expected: Schema.Types.Mixed,
            operator: String,
            message: String,
            attribute: String,
        },
        passed: { type: Boolean, required: true },
        actual: Schema.Types.Mixed,
        message: String,
    },
    { _id: false }
);

const StepExecutionResultSchema = new Schema<StepExecutionResult>(
    {
        stepId: { type: String, required: true },
        status: {
            type: String,
            enum: ['pending', 'queued', 'running', 'passed', 'failed', 'skipped', 'timeout', 'cancelled', 'error'],
            required: true,
        },
        action: { type: String },
        startTime: { type: Date, required: true },
        endTime: Date,
        duration: Number,
        error: {
            message: String,
            stack: String,
            screenshot: String,
        },
        screenshots: { type: [String], default: [] },
        logs: { type: [String], default: [] },
        assertionResults: [AssertionResultSchema],
        retryCount: { type: Number, default: 0 },
    },
    { _id: false }
);

/* -------------------------------------------------------------------------- */
/*                              MAIN EXECUTION SCHEMA                          */
/* -------------------------------------------------------------------------- */

const UITestExecutionSchema = new Schema<
    TestExecutionResult,
    Model<TestExecutionResult, {}, UITestExecutionMethods> & UITestExecutionStatics,
    UITestExecutionMethods
>(
    {
        executionId: { type: String, required: true, unique: true, index: true },

        testId: {
            type: Schema.Types.ObjectId,
            ref: 'UITestCase',
            required: true,
            index: true,
        },
        testName: {
            type: String, required: true, index: true
        },
        status: {
            type: String,
            enum: ['pending', 'queued', 'running', 'passed', 'failed', 'skipped', 'timeout', 'cancelled', 'error'],
            default: 'pending',
            index: true,
        },

        startTime: { type: Date, default: Date.now },
        endTime: Date,
        duration: Number,

        environment: { type: String, default: 'dev', index: true },

        browser: {
            type: {
                type: String,
                enum: ['chromium', 'firefox', 'webkit'],
                required: true,
            },
            channel: String,
            version: String,
            device: String,
        },

        stepResults: { type: [StepExecutionResultSchema], default: [] },

        summary: {
            total: { type: Number, default: 0 },
            passed: { type: Number, default: 0 },
            failed: { type: Number, default: 0 },
            skipped: { type: Number, default: 0 },
        },

        artifacts: {
            screenshots: { type: [String], default: [] },
            videos: { type: [String], default: [] },
            traces: { type: [String], default: [] },
            logs: { type: [String], default: [] },
        },

        error: {
            message: String,
            stack: String,
        },

        triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },

        trigger: {
            type: String,
            enum: ['manual', 'scheduled', 'api', 'ci-cd'],
            default: 'manual',
        },

        dataSetId: { type: Schema.Types.Mixed },

        dataRowIndex: Number,

        executionType: String,

        suiteExecutionId: { type: String, index: true },

        suiteId: { type: Schema.Types.ObjectId, ref: 'UITestSuiteModel', index: true },

        metadata: { type: Schema.Types.Mixed, default: {} },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

/* -------------------------------------------------------------------------- */
/*                                MIDDLEWARE                                  */
/* -------------------------------------------------------------------------- */

UITestExecutionSchema.pre('save', function () {
    if (this.endTime && this.startTime) {
        this.duration = this.endTime.getTime() - this.startTime.getTime();
    }

    if (this.stepResults && this.stepResults.length > 0) {
        this.set('summary', {
            total: this.summary?.total || this.stepResults.length,
            passed: this.stepResults.filter(s => s.status === 'passed').length,
            failed: this.stepResults.filter(s => s.status === 'failed' || s.status === 'error').length,
            skipped: this.stepResults.filter(s => s.status === 'skipped').length,
        });
    }
});

/* -------------------------------------------------------------------------- */
/*                              INSTANCE METHODS                               */
/* -------------------------------------------------------------------------- */

UITestExecutionSchema.methods.updateStatus = async function (
    status: ExecutionStatus,
    error?: any
) {
    const update: any = { status };

    if (!this.endTime && !['pending', 'queued', 'running'].includes(status)) {
        update.endTime = new Date();
    }

    if (error) {
        update.error = {
            message: error.message || String(error),
            stack: error.stack,
        };
    }

    // Use atomic findOneAndUpdate to avoid ParallelSaveError
    const updated = await mongoose.model('UITestExecution').findByIdAndUpdate(
        this._id,
        { $set: update },
        { new: true }
    );
    return updated || this;
};

/**
 * addStepResult — in-memory only, does NOT save to DB.
 * Calling save() per step causes Mongoose ParallelSaveError.
 * The caller MUST call save() once after all steps are added.
 */
UITestExecutionSchema.methods.addStepResult = function (
    stepResult: StepExecutionResult
): TestExecutionDoc {
    this.stepResults.push(stepResult);
    return this; // no save — caller batches and saves once
};

UITestExecutionSchema.methods.getPassPercentage = function () {
    if (!this.summary.total) return 0;
    return (this.summary.passed / this.summary.total) * 100;
};

UITestExecutionSchema.methods.isComplete = function () {
    return ['passed', 'failed', 'timeout', 'cancelled', 'error'].includes(this.status);
};

UITestExecutionSchema.methods.isInProgress = function () {
    return ['pending', 'queued', 'running'].includes(this.status);
};

/* -------------------------------------------------------------------------- */
/*                                STATIC METHODS                               */
/* -------------------------------------------------------------------------- */

UITestExecutionSchema.statics.findByTestId = async function (
    testId: string,
    options: any = {}
) {
    const { page = 1, limit = 20, status } = options;

    const query: any = { testId };
    if (status) query.status = status;

    const skip = (page - 1) * limit;

    const [executions, total] = await Promise.all([
        this.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        this.countDocuments(query),
    ]);

    return {
        executions,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
};

UITestExecutionSchema.statics.getTestStatistics = async function (
    testId: string,
    days: number = 30
) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const executions = await this.find({
        testId,
        createdAt: { $gte: startDate },
    }).lean();

    const total = executions.length;
    const passed = executions.filter((e: any) => e.status === 'passed').length;
    const failed = executions.filter((e: any) => e.status === 'failed').length;

    const avgDuration =
        executions.reduce((sum: number, e: any) => sum + (e.duration || 0), 0) / total || 0;

    return {
        total,
        passed,
        failed,
        passRate: total ? (passed / total) * 100 : 0,
        avgDuration: Math.round(avgDuration),
        lastExecution: executions[0] || null,
    };
};

UITestExecutionSchema.statics.generateExecutionId = function () {
    return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
};

/* -------------------------------------------------------------------------- */
/*                                   MODEL                                    */
/* -------------------------------------------------------------------------- */

export const UITestExecutionModel = mongoose.model<
    TestExecutionResult,
    Model<TestExecutionResult, {}, UITestExecutionMethods> & UITestExecutionStatics
>('UITestExecution', UITestExecutionSchema);
