import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminModule } from './admin/admin.module';
import { HrModule } from './hr/hr.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { ChatModule } from './chat/chat.module';
import { ClientsModule } from './clients/clients.module';
import { CpanelModule } from './cpanel/cpanel.module';
import { CommentsModule } from './comments/comments.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { AuthGuard } from './common/guards/auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { getProcessRole, scheduleOptionsForRole } from './common/process-role';
import { ProcessRoleModule } from './common/process-role.module';
import { RequestContextMiddleware } from './common/request-context';
import { DocumentsModule } from './documents/documents.module';
import { SignaturesModule } from './signatures/signatures.module';
import { EmailModule } from './email/email.module';
import { FilesModule } from './files/files.module';
import { GoalsModule } from './goals/goals.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
import { InvoicesModule } from './invoices/invoices.module';
import { FinanceModule } from './finance/finance.module';
import { PayrollModule } from './payroll/payroll.module';
import { LeadsModule } from './leads/leads.module';
import { LivekitModule } from './livekit/livekit.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PortalModule } from './portal/portal.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { SecurityAlertsModule } from './security-alerts/security-alerts.module';
import { SalesAccessModule } from './sales-access/sales-access.module';
import { RolesModule } from './roles/roles.module';
import { SavedViewsModule } from './saved-views/saved-views.module';
import { SearchModule } from './search/search.module';
import { SprintsModule } from './sprints/sprints.module';
import { SupportModule } from './support/support.module';
import { TaskFormsModule } from './task-forms/task-forms.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectMembersModule } from './project-members/project-members.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { TasksModule } from './tasks/tasks.module';
import { TimesheetsModule } from './timesheets/timesheets.module';
import { TodosModule } from './todos/todos.module';
import { SessionsModule } from './sessions/sessions.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

/** Scheduler options for this process's ROLE (checked by check-process-role). */
export const APP_SCHEDULE_OPTIONS = scheduleOptionsForRole(getProcessRole());

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Walk up from apps/api so we share the root .env across the monorepo.
      envFilePath: ['../../.env', '.env'],
    }),
    ProcessRoleModule,
    // Required once per app so `@Cron(...)` decorators (HR attendance
    // cron, etc.) are actually registered with the scheduler. ROLE=api turns
    // every @Cron/@Interval/@Timeout off; the worker process runs them.
    ScheduleModule.forRoot(APP_SCHEDULE_OPTIONS),
    PrismaModule,
    RedisModule,
    HealthModule,
    QueueModule,
    CpanelModule,
    // MailModule must register before EmailModule so EmailProcessor can inject
    // MailAccountsService (used for transactional MailAccount lookups).
    MailModule,
    AuthModule,
    EmailModule,
    // Before UsersModule so `users/me/sessions` is never read as `users/:id/...`.
    SessionsModule,
    UsersModule,
    WorkspacesModule,
    InvitationsModule,
    InvoicesModule,
    FinanceModule,
    PayrollModule,
    SprintsModule,
    TaskFormsModule,
    GoalsModule,
    SavedViewsModule,
    SearchModule,
    ProjectsModule,
    ProjectMembersModule,
    NotificationsModule,
    TasksModule,
    CommentsModule,
    CustomFieldsModule,
    LeadsModule,
    ClientsModule,
    SalesAccessModule,
    RolesModule,
    DocumentsModule,
    SignaturesModule,
    PortalModule,
    FilesModule,
    AdminModule,
    OrganizationsModule,
    AuditLogModule,
    SecurityAlertsModule,
    SupportModule,
    ChatModule,
    LivekitModule,
    TodosModule,
    TimesheetsModule,
    CalendarModule,
    HrModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Per-request store AuthGuard fills, so id-only permission helpers can
    // reuse the resolved context instead of re-querying it.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
