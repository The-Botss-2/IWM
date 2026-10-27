// Common building blocks
export * from './common/id.js';
export * from './common/pagination.js';
export * from './common/problem.js';
export * from './common/access-code.js';

// Enums (mirrors of Prisma enums; no @prisma/client import here)
export * from './enums.js';

// Entities
export * from './auth.js';
export * from './user.js';
export * from './workspace.js';
export * from './project.js';
export * from './task.js';
export * from './lead.js';
export * from './client.js';
export * from './sales-access.js';
export * from './document.js';
export * from './document-text.js';
export * from './signature.js';
export * from './file.js';
export * from './comment.js';
export * from './notification.js';
export * from './mail.js';

// Phase 3 entities (project management)
export * from './sprint.js';
export * from './task-form.js';
export * from './goal.js';
export * from './saved-view.js';
export * from './project-summary.js';
export * from './custom-field.js';
export * from './search.js';
export * from './document-template.js';
export * from './enums-invoice.js';
export * from './invoice.js';
export * from './invoice-template.js';
export * from './invoice-math.js';

// Financials. Contract is the root money object; Payment is the single
// money-in record (invoice or contract); Expense is money out.
export * from './common/money.js';
export * from './enums-finance.js';
export * from './payment-source.js';
export * from './contract.js';
export * from './payment.js';
export * from './expense.js';
export * from './finance-summary.js';
export * from './payroll.js';

export * from './chat/chat.schema.js';
export * from './chat/chat-request.schema.js';
export * from './livekit.js';

export * from './organization.js';
export * from './audit-log.js';
export * from './support-access.js';

export * from './notification-subscription.js';

export * from './todo.js';
export * from './timesheet.js';
export * from './calendar.js';

// HR / Attendance - Phase 4+. Adds System Role HR, daily Attendance
// records (with admin overrides), and Leave requests with approval
// state. Existing UserSchema / SystemRole consumers keep working -
// the enum gained an `HR` value but didn't drop any existing one.
export * from './attendance.js';
export * from './leave.js';
export * from './holiday.js';

// Client portal: client people sign in and see only their own client's
// projects, shared documents, signature requests and (main contact) billing.
export * from './portal.js';

// Client hub: a client's documents, signatures, billing, custom fields and
// activity on the staff client page.
export * from './client-hub.js';

// Configurable roles & permissions.
export * from './roles.js';

// Per-user appearance + navigation preferences, synced across devices.
export * from './user-preferences.js';
export * from './sessions.js';
