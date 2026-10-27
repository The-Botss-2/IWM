import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { MailEventsService } from './mail-events.service';

/**
 * Server-Sent Events stream for the mail UI. Browser opens an `EventSource`,
 * new-mail events emitted by the IDLE watcher land on the socket within
 * ~server-tick time. SSE was chosen over WebSocket because mail events are
 * one-way (server → client) and SSE goes through standard HTTP + cookies
 * with no extra handshake.
 */
@Controller('mail/events')
export class MailEventsController {
  constructor(private readonly events: MailEventsService) {}

  @Sse('stream')
  @SkipPermissions()
  stream(@CurrentUser() user: AuthedUser): Observable<MessageEvent> {
    return this.events.forUser(user.id).pipe(
      map(
        (evt): MessageEvent => ({
          // NestJS @Sse formats this as `event: ... \n data: ... \n\n`.
          // `type` → SSE event name; lets the frontend subscribe per kind.
          type: evt.kind,
          data: JSON.stringify(evt),
        }),
      ),
    );
  }
}
