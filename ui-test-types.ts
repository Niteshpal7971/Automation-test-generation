/**
 * @fileoverview TypeScript types and interfaces for Enterprise UI Testing
 * @description Comprehensive type definitions for visual test builder, execution, and reporting
 * @version 1.0.0
 * @author ACEVIN Team
 */

import { Types } from 'mongoose';

/**
 * Supported Playwright action types for UI testing
 */
export type PlaywrightActionType =
  | 'navigate'      // Navigate to URL
  | 'click'         // Click element
  | 'dblclick'      // Double click
  | 'fill'          // Fill input field
  | 'type'          // Type with keyboard
  | 'select'        // Select dropdown option
  | 'check'         // Check checkbox/radio
  | 'uncheck'       // Uncheck checkbox
  | 'hover'         // Hover over element
  | 'focus'         // Focus element
  | 'blur'          // Blur element
  | 'press'         // Press keyboard key
  | 'clear'         // Clear input field
  | 'scroll'         // Clear input field
  | 'scrollTo'      // Scroll to element
  | 'scrollBy'      // Scroll by offset
  | 'dragAndDrop'   // Drag and drop
  | 'upload'        // File upload
  | 'wait'          // Wait for condition
  | 'assert'        // Assertion
  | 'screenshot'    // Take screenshot
  | 'evaluate'      // Execute JavaScript
  | 'reload'        // Reload page
  | 'goBack'        // Browser back
  | 'goForward'     // Browser forward
  | 'custom';       // Custom action

/**
 * Selector strategies supported by Playwright
 */
export type SelectorStrategy =
  | 'css'           // CSS selector
  | 'xpath'         // XPath selector
  | 'text'          // Text content
  | 'role'          // ARIA role
  | 'testId'        // data-testid attribute
  | 'label'         // Associated label
  | 'placeholder'   // Placeholder text
  | 'altText'       // Alt text for images
  | 'title';        // Title attribute

/**
 * Assertion types for test validation
 */
export type AssertionType =
  | 'exists'        // Element exists
  | 'notExists'     // Element doesn't exist
  | 'visible'       // Element is visible
  | 'hidden'        // Element is hidden
  | 'text'          // Text content matches
  | 'value'         // Input value matches
  | 'attribute'     // Attribute value matches
  | 'count'         // Element count matches
  | 'url'           // URL matches
  | 'title'         // Page title matches
  | 'checked'       // Checkbox is checked
  | 'disabled'      // Element is disabled
  | 'enabled'       // Element is enabled
  | 'custom';       // Custom assertion

/**
 * Comparison operators for assertions
 */
export type ComparisonOperator =
  | 'equals'        // Exact match
  | 'notEquals'     // Not equal
  | 'contains'      // Contains substring
  | 'notContains'   // Doesn't contain
  | 'startsWith'    // Starts with
  | 'endsWith'      // Ends with
  | 'matches'       // Regex match
  | 'greaterThan'   // Greater than
  | 'lessThan'      // Less than
  | 'greaterOrEqual'// Greater or equal
  | 'lessOrEqual';  // Less or equal

/**
 * Wait condition types
 */
export type WaitCondition =
  | 'visible'       // Wait for element to be visible
  | 'hidden'        // Wait for element to be hidden
  | 'attached'      // Wait for element to be attached to DOM
  | 'detached'      // Wait for element to be detached
  | 'stable'        // Wait for element to stop moving
  | 'enabled'       // Wait for element to be enabled
  | 'editable'      // Wait for element to be editable
  | 'timeout'       // Wait for fixed duration
  | 'networkIdle'   // Wait for network to be idle
  | 'load'          // Wait for page load
  | 'domContentLoaded'; // Wait for DOM content loaded

/**
 * Test execution status
 */
export type ExecutionStatus =
  | 'pending'       // Waiting to start
  | 'queued'        // In execution queue
  | 'running'       // Currently executing
  | 'passed'        // Test passed
  | 'failed'        // Test failed
  | 'skipped'       // Test skipped
  | 'timeout'       // Test timed out
  | 'cancelled'     // Test cancelled
  | 'error';        // Execution error

/**
 * Test priority levels
 */
export type TestPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Test status
 */
export type TestStatus = 'draft' | 'active' | 'disabled' | 'archived';

/**
 * Browser types
 */
export type BrowserType = 'chromium' | 'firefox' | 'webkit';

/**
 * Device types for responsive testing
 */
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'custom';

/**
 * Scroll type for scrollTo steps.
 */
export type ScrollType = 'window' | 'element';

/**
 * Selector configuration with multiple strategies
 */
export interface SelectorConfig {
  /** Primary selector strategy */
  strategy: SelectorStrategy;
  /** Selector value */
  value: string;
  /** Fallback selectors */
  fallbacks?: {
    strategy: SelectorStrategy;
    value: string;
  }[];
  /** Whether to use strict mode (fail if multiple elements match) */
  strict?: boolean;
}

/**
 * Assertion configuration
 */
export interface AssertionConfig {
  /** Assertion type */
  type: AssertionType;
  /** Expected value */
  expected: any;
  /** Comparison operator */
  operator: ComparisonOperator;
  /** Optional custom error message */
  message?: string;
  /** Attribute name for attribute assertions */
  attribute?: string;
  /** Whether assertion is soft (continue on failure) */
  soft?: boolean;
}

/**
 * Wait configuration
 */
export interface WaitConfig {
  /** Wait condition */
  condition: WaitCondition;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Selector to wait for (if applicable) */
  selector?: SelectorConfig;
}

/**
 * UI Test Step definition
 */
export interface UITestStep {
  /** Unique step ID */
  id: string;
  /** Step order/sequence */
  order: number;
  /** Action type */
  action: PlaywrightActionType;
  /** Step description */
  description: string;
  /** Element selector (for element-based actions) */
  selector?: SelectorConfig;
  /** Input value (for fill, type, select actions) */
  value?: any;
  /** Keyboard key (for press action) */
  key?: string;
  /** Target URL (for navigate action) */
  url?: string;
  /** Assertions to validate */
  assertions?: AssertionConfig[];
  /** Wait configuration */
  wait?: WaitConfig;
  /** Screenshot options */
  screenshot?: {
    enabled: boolean;
    fullPage?: boolean;
    name?: string;
  };
  /** Step timeout */
  timeout?: number;
  /** Retry count for this step */
  retries?: number;
  /** Conditional execution */
  condition?: {
    enabled: boolean;
    expression: string;
  };
  /** File upload paths */
  files?: string[];
  lastRun?: {
    status: "passed" | "failed" | "running";
    date: string;
    executionId?: string;
  };
  /** Drag and drop target */
  dropTarget?: SelectorConfig;
  /** JavaScript code to evaluate */
  script?: string;
  /** Scroll offset */
  scrollOffset?: { x: number; y: number };
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Metadata attached to each generated step (preserved through the cleanup pipeline).
 */
export interface StepMetadata {
  /** Original recorded action type before mapping */
  originalType?: string;
  /** Recording timestamp (epoch ms) */
  timestamp?: number;
  /** Screen coordinates of the interaction */
  coordinates?: { x: number; y: number };
  /** Tag name of the target element */
  elementTag?: string;
  /**
   * Scroll type for scrollTo steps.
   * 'window' → use window.scrollTo(x, y)
   * 'element' → use element.scrollIntoView()
   */
  scrollType?: ScrollType;
  /** Allow extra fields for forward-compatibility */
  [key: string]: unknown;
}

/**
 * Browser configuration
 */
export interface BrowserConfig {
  /** Browser type */
  type: BrowserType;
  /** Browser channel (stable, beta, dev) */
  channel?: string;
  /** Headless mode */
  headless?: boolean;
  /** Viewport size */
  viewport: {
    width: number;
    height: number;
  } | null;
  /** Device emulation */
  device?: {
    name: string;
    userAgent?: string;
    deviceScaleFactor?: number;
  };
  /** Browser launch arguments */
  args?: string[];
  /** Slow motion (delay between actions in ms) */
  slowMo?: number;
  /** Video recording */
  video?: {
    enabled: boolean;
    dir?: string;
    size?: { width: number; height: number };
  };
  /** Screenshot settings */
  screenshot?: {
    mode: 'on' | 'off' | 'only-on-failure';
    dir?: string;
  };
  /** Trace recording */
  trace?: {
    enabled: boolean;
    screenshots?: boolean;
    snapshots?: boolean;
  };
  /** Browser console log capture */
  logs?: {
    enabled: boolean;
  };
}

/**
 * Test execution options
 */
export interface ExecutionOptions {
  /** Environment (dev, staging, production) */
  environment: string;
  /** Base URL override */
  baseUrl?: string;
  /** Browser configuration */
  browser: BrowserConfig;
  /** Global timeout */
  timeout: number;
  /** Global retry count */
  retries: number;
  /** Test data set ID (for data-driven tests) */
  dataSetId?: string;
  /** Specific data row index (for data-driven tests) */
  dataRowIndex?: number;
  /** Execution priority */
  priority?: TestPriority;
  /** Tags to filter tests */
  tags?: string[];
  /** Continue on failure */
  continueOnFailure?: boolean;
  /** Parallel execution */
  parallel?: boolean;
  /** Number of workers for parallel execution */
  workers?: number;
  /** Open browser in headless mode */
  headless?: boolean;
  /** speed */
  speed?: 1000 | 2000 | 500;
  /**Record video*/
  recordVideo?: boolean
  /** Suite Execution ID reference */
  suiteExecutionId?: string;
  /** Suite ID reference */
  suiteId?: string | Types.ObjectId;
  /** Execution Type */
  executionType?: 'suite' | 'test';

}

/**
 * Step execution result
 */
export interface StepExecutionResult {
  /** Step ID */
  stepId: string;
  /** Step Action */
  action?: PlaywrightActionType;
  /** Execution status */
  status: ExecutionStatus;
  /** Start time */
  startTime: Date;
  /** End time */
  endTime?: Date;
  /** Duration in ms */
  duration?: number;
  /** Error information */
  error?: {
    message: string;
    stack?: string;
    screenshot?: string;
  };
  /** Screenshots captured */
  screenshots: string[];
  /** Logs */
  logs: string[];
  /** Assertion results */
  assertionResults?: {
    assertion: AssertionConfig;
    passed: boolean;
    actual?: any;
    message?: string;
  }[];
  /** Retry attempts */
  retryCount?: number;
}

/**
 * Test execution result
 */
export interface TestExecutionResult {
  /** Execution ID */
  executionId: string;
  /** Test ID */
  testId: Types.ObjectId | string;
  /** Execution status */
  status: ExecutionStatus;
  /** Start time */
  startTime: Date;
  /** End time */
  endTime?: Date;
  /** Total duration in ms */
  duration?: number;
  /** Environment */
  environment: string;
  /** Browser info */
  browser: {
    type: BrowserType;
    version?: string;
    userAgent?: string;
  };
  /** Step results */
  stepResults: StepExecutionResult[];
  /** Summary */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Artifacts */
  artifacts?: {
    screenshots?: string[];
    videos?: string[];
    traces?: string[];
    logs?: string[];
  };
  /** Performance metrics */
  metrics?: {
    loadTime: number;
    memoryUsage: number;
    networkRequests: number;
    consoleErrors: number;
  };
  /** Error information */
  error?: {
    message?: string;
    stack?: string;
  };
  /** Triggered by user */
  triggeredBy?: Types.ObjectId;
  /** Trigger type */
  trigger: 'manual' | 'scheduled' | 'api' | 'ci-cd';
  /** Data set ID for data-driven tests */
  dataSetId?: string;
  /** Data row index for data-driven tests */
  dataRowIndex?: number;
  /** Additional metadata */
  metadata?: Record<string, any>;
  /** Created date */
  createdAt: Date;
  /** Updated date */
  updatedAt: Date;
}

/**
 * Test data set for data-driven testing
 */
export interface TestDataSet {
  /** Data set ID */
  id: string;
  /** Data set name */
  name: string;
  /** Description */
  description?: string;
  /** Data rows */
  data: Record<string, any>[];
  /** Environment (optional) */
  environment?: string;
  /** Active status */
  active: boolean;
  /** Created date */
  createdAt: Date;
  /** Updated date */
  updatedAt: Date;
}

export interface lastRun {
  status: 'success' | 'false' | 'not_executed',
  executedAt: Date
}

/**
 * UI Test Case definition
 */
export interface UITestCase {
  /** Test ID */
  _id?: Types.ObjectId;
  /** Test name */
  name: string;
  /** Description */
  description: string;
  /** Project ID */
  projectId?: Types.ObjectId;
  /** Test steps */
  steps: UITestStep[];
  /** Tags */
  tags: string[];
  /** Priority */
  priority: TestPriority;
  /** Status */
  status: TestStatus;
  /** Browser configuration */
  browserConfig: BrowserConfig;
  /** Default timeout */
  timeout: number;
  /** Default retries */
  retries: number;
  /** Default URL */
  url: string;
  /** Test data sets */
  dataSets?: string[];
  /** Preconditions */
  preconditions?: string[];
  /** Expected results */
  expectedResults?: string[];
  /** last execution status */
  lastRun?: lastRun,
  /** Test version */
  version: number;
  /** Created by */
  createdBy: Types.ObjectId;
  /** Created date */
  createdAt: Date;
  /** Updated date */
  updatedAt: Date;
}

/**
 * Query filters for listing tests
 */
export interface TestListFilters {
  /** Project ID */
  projectId?: string;
  /** Status filter */
  status?: TestStatus | TestStatus[];
  /** Priority filter */
  priority?: TestPriority | TestPriority[];
  /** Tags filter (any match) */
  tags?: string[];
  /** Search query */
  search?: string;
  /** Created by user */
  createdBy?: string;
  /** Date range */
  dateRange?: {
    from?: Date;
    to?: Date;
  };
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Page number (1-indexed) */
  page: number;
  /** Items per page */
  limit: number;
  /** Sort field */
  sortBy?: string;
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  /** Data items */
  data: T[];
  /** Pagination info */
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// ==================== SUITE TYPES ====================

/**
 * Suite lifecycle status
 */
export type SuiteStatus = 'draft' | 'active' | 'disabled' | 'archived';

/**
 * Suite last-run outcome
 */
export type SuiteRunStatus = 'idle' | 'running' | 'passed' | 'failed' | 'partial';

/**
 * Execution configuration for a test suite
 */
export interface SuiteExecutionConfig {
  /** Run test cases in parallel */
  parallel: boolean;
  /** Number of parallel workers */
  workers: number;
  /** Stop execution on first failure */
  failFast: boolean;
  /** Retry failed test cases */
  retryOnFailure: boolean;
  /** Max retries per test case */
  maxRetries: number;
}

/**
 * Cron-based schedule configuration
 */
export interface ScheduleConfig {
  /** Whether scheduling is enabled */
  enabled: boolean;
  /** Cron expression (e.g. "0 0 * * *") */
  cron: string;
  /** Timezone for the cron schedule */
  timezone: string;
  /** Next scheduled run (computed) */
  nextRun?: Date;
  /** Last scheduled run (computed) */
  lastRun?: Date;
}

/**
 * Suite notification preferences
 */
export interface SuiteNotificationConfig {
  /** Notify on suite failure */
  onFailure: boolean;
  /** Notify on suite success */
  onSuccess: boolean;
  /** Notification channels (email, slack, webhook) */
  channels: string[];
}

/**
 * UI Test Suite definition — groups test cases for batch/parallel execution
 */
export interface UITestSuite {
  /** Suite ID */
  _id?: Types.ObjectId;
  /** Suite name */
  name: string;
  /** Description */
  description: string;
  /** Project ID */
  projectId: Types.ObjectId;
  /** Ordered list of test case IDs */
  testCases: Types.ObjectId[];
  /** Tags for filtering */
  tags?: string[];
  /** Priority */
  priority: TestPriority;
  /** Lifecycle status */
  status: SuiteStatus;
  /** Execution configuration */
  executionConfig: SuiteExecutionConfig;
  /** Schedule configuration */
  schedule?: ScheduleConfig;
  /** Notification preferences */
  notifications?: SuiteNotificationConfig;
  /** Target environment */
  environment: string;
  /** Suite-level browser config override */
  browserConfig?: BrowserConfig;
  /** Last run summary */
  lastRun?: {
    status: SuiteRunStatus;
    date: Date;
    executionId: string;
    summary: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      duration: number;
    };
  };
  /** Schema version (auto-increments) */
  version: number;
  /** Created by user */
  createdBy: Types.ObjectId;
  /** Created date */
  createdAt: Date;
  /** Updated date */
  updatedAt: Date;
}

/**
 * Per-test-case result within a suite execution
 */
export interface SuiteTestCaseResult {
  /** Test case ID */
  testCaseId: Types.ObjectId | string;
  /** Individual execution ID */
  executionId: string;
  /** Status */
  status: ExecutionStatus;
  /** Duration (ms) */
  duration: number;
  /** Error info */
  error?: {
    message: string;
    stack?: string;
  };
}

/**
 * Suite-level execution result
 */
export interface SuiteExecutionResult {
  /** Suite execution ID */
  executionId: string;
  /** Suite ID */
  suiteId: Types.ObjectId | string;
  /** Overall status */
  status: ExecutionStatus;
  /** Start time */
  startTime: Date;
  /** End time */
  endTime?: Date;
  /** Total duration (ms) */
  duration?: number;
  /** Environment */
  environment: string;
  /** Per-test-case results */
  testCaseResults: SuiteTestCaseResult[];
  /** Summary counts */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  /** Triggered by */
  triggeredBy?: Types.ObjectId;
  /** Trigger type */
  trigger: 'manual' | 'scheduled' | 'api' | 'ci-cd';
  /** Created date */
  createdAt: Date;
  /** Updated date */
  updatedAt: Date;
}
