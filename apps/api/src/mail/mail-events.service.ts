import { Injectable, Optional } from '@nestjs/common';
import { filter, Subject } from 'rxjs';

import { type BusTopic, CrossProcessBus, isRecord } from '../redis/cross-process-bus.service';

/**
 * Server-side event bus for mail. The IDLE watcher pushes a `MailEvent` here
 * whenever an IMAP server signals new/changed mail; the SSE controller
 * subscribes and forwards events to the connected browser for the matching
 * user. Decouples the watcher from the transport so future transports
 * (Socket.IO, web push) plug in without touching the IDLE code.
 */
export type MailEvent =
  | {
      kind: 'folder-updated';
      userId: string;
      accountId: string;
      folderId: string;
      inserted: number;
    }
  | { kind: 'account-status'; userId: string; accountId: string; status: string };

/** IDLE runs in the worker; the SSE stream is served by the api process. */
export const MAIL_EVENT_TOPIC: BusTopic<MailEvent> = {
  name: 'mail-events',
  decode(raw) {
    if (!isRecord(raw) || typeof raw.userId !== 'string' || typeof raw.accountId !== 'string') {
      return null;
    }
    if (
      raw.kind === 'folder-updated' &&
      typeof raw.folderId === 'string' &&
      typeof raw.inserted === 'number'
    ) {
      return {
        kind: 'folder-updated',
        userId: raw.userId,
        accountId: raw.accountId,
        folderId: raw.folderId,
        inserted: raw.inserted,
      };
    }
    if (raw.kind === 'account-status' && typeof raw.status === 'string') {
      return {
        kind: 'account-status',
        userId: raw.userId,
        accountId: raw.accountId,
        status: raw.status,
      };
    }
    return null;
  },
};

/**
 * With ROLE=api + ROLE=worker the IDLE watcher (worker) and the SSE stream
 * (api) live in different processes, so every event also crosses over the
 * CrossProcessBus (a no-op in ROLE=all).
 */
@Injectable()
export class MailEventsService {
  private readonly subject = new Subject<MailEvent>();

  constructor(@Optional() private readonly bus?: CrossProcessBus) {
    this.bus?.subscribe(MAIL_EVENT_TOPIC, (e) => this.subject.next(e));
  }

  emit(event: MailEvent): void {
    this.subject.next(event);
    this.bus?.publish(MAIL_EVENT_TOPIC, event);
  }

  /** Stream events for a single user. The SSE controller pipes this to the
   *  HTTP response and aborts when the client disconnects. */
  forUser(userId: string) {
    return this.subject.asObservable().pipe(filter((e) => e.userId === userId));
  }
}
