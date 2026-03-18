/**
 * @fileoverview UI Test Case Model for Enterprise Testing
 * @description MongoDB schema for visual test builder with comprehensive Playwright support
 * @version 1.0.0
 * @author ACEVIN Team
 */

import mongoose, { Schema, Document, Model } from 'mongoose';
import {
    UITestCase,
    UITestStep,
    BrowserConfig,
    SelectorConfig,
    AssertionConfig,
    WaitConfig,
    TestPriority,
    TestStatus,
    PlaywrightActionType,
    SelectorStrategy,
    AssertionType,
    ComparisonOperator,
    WaitCondition,
    BrowserType,
} from '../types/ui-test.types';

/**
 * Selector Configuration Schema
 */
const SelectorConfigSchema = new Schema<SelectorConfig>(
    {
        strategy: {
            type: String,
            enum: ['css', 'xpath', 'text', 'role', 'testId', 'label', 'placeholder', 'altText', 'title'],
            required: true,
        },
        value: {
            type: String,
            // required: true,
        },
        fallbacks: [
            {
                strategy: {
                    type: String,
                    enum: ['css', 'xpath', 'text', 'role', 'testId', 'label', 'placeholder', 'altText', 'title'],
                },
                value: String,
            },
        ],
        strict: {
            type: Boolean,
            default: true,
        },
    },
    { _id: false }
);

/**
 * Assertion Configuration Schema
 */
const AssertionConfigSchema = new Schema<AssertionConfig>(
    {
        type: {
            type: String,
            enum: [
                'exists',
                'notExists',
                'visible',
                'hidden',
                'text',
                'value',
                'attribute',
                'count',
                'url',
                'title',
                'checked',
                'disabled',
                'enabled',
                'custom',
            ],
            required: true,
        },
        expected: {
            type: Schema.Types.Mixed,
            required: true,
        },
        operator: {
            type: String,
            enum: [
                'equals',
                'notEquals',
                'contains',
                'notContains',
                'startsWith',
                'endsWith',
                'matches',
                'greaterThan',
                'lessThan',
                'greaterOrEqual',
                'lessOrEqual',
            ],
            required: true,
        },
        message: String,
        attribute: String,
        soft: {
            type: Boolean,
            default: false,
        },
    },
    { _id: false }
);

/**
 * Wait Configuration Schema
 */
const WaitConfigSchema = new Schema<WaitConfig>(
    {
        condition: {
            type: String,
            enum: [
                'visible',
                'hidden',
                'attached',
                'detached',
                'stable',
                'enabled',
                'editable',
                'timeout',
                'networkIdle',
                'load',
                'domContentLoaded',
            ],
            required: true,
        },
        timeout: {
            type: Number,
            default: 30000,
        },
        selector: SelectorConfigSchema,
    },
    { _id: false }
);

/**
 * UI Test Step Schema
 */
const UITestStepSchema = new Schema<UITestStep>(
    {
        id: {
            type: String,
            required: true,
        },
        order: {
            type: Number,
            required: true,
        },
        action: {
            type: String,
            enum: [
                'navigate',
                'click',
                'dblclick',
                'fill',
                'type',
                'select',
                'check',
                'uncheck',
                'hover',
                'focus',
                'blur',
                'press',
                'clear',
                'scroll',
                'scrollTo',
                'scrollBy',
                'dragAndDrop',
                'upload',
                'wait',
                'assert',
                'screenshot',
                'evaluate',
                'reload',
                'goBack',
                'goForward',
                'custom',
            ],
            required: true,
        },
        description: {
            type: String,
            // required: true,
        },
        selector: SelectorConfigSchema,
        value: Schema.Types.Mixed,
        key: String,
        url: String,
        assertions: [AssertionConfigSchema],
        wait: WaitConfigSchema,
        screenshot: {
            enabled: { type: Boolean, default: false },
            fullPage: { type: Boolean, default: false },
            name: String,
        },
        timeout: {
            type: Number,
            default: 30000,
        },
        retries: {
            type: Number,
            default: 0,
        },
        condition: {
            enabled: { type: Boolean, default: false },
            expression: String,
        },
        files: [String],
        dropTarget: SelectorConfigSchema,
        script: String,
        scrollOffset: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
        },
        lastRun: {
            status: {
                type: String,
                enum: ["passed", "failed", "running", "not_executed"]
            },
            date: String,
            executionId: String,
        },
        metadata: {
            type: Schema.Types.Mixed,
            default: {},
        },
    },
    { _id: false }
);

/**
 * Browser Configuration Schema
 */
// const BrowserConfigSchema = new Schema<BrowserConfig>(
//     {
//         type: {
//             type: String,
//             enum: ['chromium', 'firefox', 'webkit'],
//             default: 'chromium',
//         },
//         channel: String,
//         headless: {
//             type: Boolean,
//             default: true,
//         },
//         viewport: {
//             width: { type: Number, default: 1920 },
//             height: { type: Number, default: 1080 },
//         },
//         device: {
//             name: String,
//             userAgent: String,
//             deviceScaleFactor: Number,
//         },
//         args: [String],
//         slowMo: {
//             type: Number,
//             default: 0,
//         },
//         video: {
//             enabled: { type: Boolean, default: false },
//             dir: String,
//             size: {
//                 width: Number,
//                 height: Number,
//             },
//         },
//         screenshot: {
//             mode: {
//                 type: String,
//                 enum: ['on', 'off', 'only-on-failure'],
//                 default: 'only-on-failure',
//             },
//             dir: String,
//         },
//         trace: {
//             enabled: { type: Boolean, default: false },
//             screenshots: { type: Boolean, default: true },
//             snapshots: { type: Boolean, default: true },
//         },
//     },
//     { _id: false }
// );

/**
 * UI Test Case Schema
 */
const UITestCaseSchema = new Schema<UITestCase>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
        },
        description: {
            type: String,
            required: true,
            trim: true,
            maxlength: 2000,
        },
        projectId: {
            type: Schema.Types.ObjectId,
            ref: 'Project',
            // required: true,
            index: true,
        },
        steps: {
            type: [UITestStepSchema],
            default: [],
            validate: {
                validator: function (steps: UITestStep[]) {
                    // Ensure step orders are sequential
                    if (steps.length === 0) return true;
                    const orders = steps.map((s) => s.order);
                    const sortedOrders = [...orders].sort((a, b) => a - b);
                    return JSON.stringify(orders) === JSON.stringify(sortedOrders);
                },
                message: 'Step orders must be sequential',
            },
        },
        tags: {
            type: [String],
            default: [],
            index: true,
        },
        priority: {
            type: String,
            enum: ['low', 'medium', 'high', 'critical'],
            default: 'medium',
            index: true,
        },
        status: {
            type: String,
            enum: ['draft', 'active', 'disabled', 'archived'],
            default: 'draft',
            index: true,
        },
        // browserConfig: {
        //     type: BrowserConfigSchema,
        //     required: true,
        //     default: () => ({
        //         type: 'chromium',
        //         headless: true,
        //         viewport: { width: 1920, height: 1080 },
        //         screenshot: { mode: 'only-on-failure' },
        //     }),
        // },
        timeout: {
            type: Number,
            default: 30000,
            min: 1000,
            max: 300000,
        },
        retries: {
            type: Number,
            default: 0,
            min: 0,
            max: 3,
        },
        dataSets: {
            type: [String],
            default: [],
        },
        preconditions: {
            type: [String],
            default: [],
        },
        expectedResults: {
            type: [String],
            default: [],
        },
        url: {
            type: String
        },
        version: {
            type: Number,
            default: 1,
        },
        lastRun: {
            status: {
                type: String,
                enum: ['passed', 'failed', 'not_executed'],
                default: 'not_executed'
            },
            executedAt: Date
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
        toJSON: {
            transform: function (doc: any, ret: any) {
                ret.id = ret._id;
                delete ret._id;
                return ret;
            },
        },
    }
);

// Indexes for performance
UITestCaseSchema.index({ projectId: 1, status: 1 });
UITestCaseSchema.index({ createdBy: 1, status: 1 });
UITestCaseSchema.index({ tags: 1, status: 1 });
UITestCaseSchema.index({ priority: 1, status: 1 });
UITestCaseSchema.index({ createdAt: -1 });
UITestCaseSchema.index({ updatedAt: -1 });

// Text search index
UITestCaseSchema.index({ name: 'text', description: 'text' });

// Pre-save middleware
UITestCaseSchema.pre('save', function (next) {
    // Auto-increment version on update
    if (!this.isNew && this.isModified('steps')) {
        this.version += 1;
    }
    next();
});

// Instance methods
UITestCaseSchema.methods = {
    /**
     * Add a new step to the test
     */
    addStep: function (step: Omit<UITestStep, 'id' | 'order'>) {
        const newStep: UITestStep = {
            ...step,
            id: `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            order: this.steps.length,
        };
        this.steps.push(newStep);
        return newStep;
    },

    /**
     * Remove a step from the test
     */
    removeStep: function (stepId: string) {
        const index = this.steps.findIndex((s: UITestStep) => s.id === stepId);
        if (index === -1) return false;
        this.steps.splice(index, 1);
        // Reorder remaining steps
        this.steps.forEach((s: UITestStep, i: number) => {
            s.order = i;
        });
        return true;
    },

    /**
     * Update a specific step
     */
    updateStep: function (stepId: string, updates: Partial<UITestStep>) {
        const step = this.steps.find((s: UITestStep) => s.id === stepId);
        if (!step) return null;
        Object.assign(step, updates);
        return step;
    },

    /**
     * Reorder steps
     */
    reorderSteps: function (stepIds: string[]) {
        if (stepIds.length !== this.steps.length) return false;
        const newSteps: UITestStep[] = [];
        stepIds.forEach((id, index) => {
            const step = this.steps.find((s: UITestStep) => s.id === id);
            if (step) {
                step.order = index;
                newSteps.push(step);
            }
        });
        if (newSteps.length !== this.steps.length) return false;
        this.steps = newSteps;
        return true;
    },
};

// Static methods
UITestCaseSchema.statics = {
    /**
     * Find tests by project with filtering
     */
    findByProject: async function (
        projectId: string,
        filters: any = {},
        options: any = {}
    ) {
        const query = { projectId, ...filters };
        const { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = options;

        const skip = (page - 1) * limit;
        const sort: any = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        const [tests, total] = await Promise.all([
            this.find(query).sort(sort).skip(skip).limit(limit).lean(),
            this.countDocuments(query),
        ]);

        return {
            tests,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page * limit < total,
                hasPrev: page > 1,
            },
        };
    },
};

export const UITestCaseModel: Model<UITestCase> =
    mongoose.model<UITestCase>('UITestCase', UITestCaseSchema);
